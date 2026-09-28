// Wrapper for the Claude Agent SDK (@anthropic-ai/claude-agent-sdk): `harness: claude-agent-sdk`.
//
// DRAFT. Written against SDK 0.3.x type definitions and not yet run against the live SDK.
//
// How it meets what SPEC §4.1.3 asks of a Runner:
// - Result: passes result_schema as the SDK's native `outputFormat` and reads `structured_output`.
//   If that is missing, it falls back to parsing a fenced JSON block out of the final text. If
//   neither yields a value, it reports `no_value` (schema_violation, SPEC §10.4).
// - Cost: priced from token counts against a price table the implementor supplies
//   (claude-pricing.json), never from the SDK's own `total_cost_usd` estimate.
//     * Each assistant message carries its API call's usage. The wrapper prices the tokens it has
//       not priced yet and reports them right away, so every API call is a report point and the
//       Runner can stop a turn part-way (SPEC §9.7).
//     * The result message's `modelUsage` holds the session's cumulative tokens per model. It
//       includes subagents and internal calls the assistant messages don't show. Anything in it
//       beyond what has already been priced is reported as a final top-up.
//     * The session handle records the tokens already priced, per model. So an aborted turn, a
//       resume, or a Runner restart never counts the same tokens twice.
// - Retryability: API errors with a retryable HTTP status (429, 5xx) are retryable. Config errors,
//   max-turns, unpriceable models, and everything else are not.
// - Sessions: a new session's id comes from the `system`/`init` message; `resume` continues it.

import { query, AbortError, type Options, type PermissionMode, type SDKResultMessage, type ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { Harness, HarnessEvent, Invocation, SessionHandle } from "./types.js";
import { extractFencedJson } from "./extract.js";
import { addTokens, isZero, NO_TOKENS, priceTokens, tokensBeyond, type PriceTable, type Tokens } from "./pricing.js";

/** What this wrapper persists per session, through the Runner (SessionHandle). */
type ClaudeSession = { sessionId: string; priced: Record<string, Tokens> };

type ClaudeConfig = {
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  permissionMode?: PermissionMode;
};

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

class Unpriced extends Error {}

export class ClaudeAgentSdkHarness implements Harness {
  /** `run` is injectable so the wrapper can be unit-tested without the CLI. */
  constructor(
    private readonly prices: PriceTable,
    private readonly run: typeof query = query,
  ) {}

  async *invoke(inv: Invocation): AsyncGenerator<HarnessEvent> {
    const config = parseConfig(inv.harnessConfig, this.prices);
    if (typeof config === "string") {
      yield { type: "failure", retryable: false, message: `invalid harness_config: ${config}` };
      return;
    }
    const prior = inv.session ? toClaudeSession(inv.session) : undefined;
    let sessionId = prior?.sessionId;
    const priced: Record<string, Tokens> = { ...prior?.priced };
    /** Largest usage seen so far for each API message in this invocation; streamed frames repeat an id. */
    const seen = new Map<string, Tokens>();

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    inv.signal.addEventListener("abort", onAbort, { once: true });

    const options: Options = {
      abortController,
      outputFormat: { type: "json_schema", schema: inv.resultSchema },
      ...(prior && { resume: prior.sessionId }),
      ...(config.model && { model: config.model }),
      ...(config.cwd && { cwd: config.cwd }),
      ...(config.allowedTools && { allowedTools: config.allowedTools }),
      ...(config.maxTurns !== undefined && { maxTurns: config.maxTurns }),
      ...(config.permissionMode && { permissionMode: config.permissionMode }),
    };
    const q = this.run({ prompt: inv.prompt, options });

    // Prices `tokens` on `model` and records them as priced. The caller yields the new handle before
    // the usage event: if this report crosses a ceiling the Runner stops right there, and the
    // resume after a grant must already know these tokens were counted.
    const charge = (model: string, tokens: Tokens) => {
      const cost = priceTokens(this.prices, model, tokens);
      if (cost === undefined) throw new Unpriced(`no price for model '${model}' in the price table`);
      priced[model] = addTokens(priced[model] ?? NO_TOKENS, tokens);
      return cost;
    };

    try {
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init" && !prior) {
          sessionId = message.session_id;
          yield { type: "session", handle: handle(sessionId, priced) };
          continue;
        }

        if (message.type === "assistant") {
          const { id, model, usage } = message.message;
          const now = fromApiUsage(usage);
          const before = seen.get(id) ?? NO_TOKENS;
          const fresh = tokensBeyond(now, before);
          seen.set(id, addTokens(before, fresh));
          if (isZero(fresh)) continue;
          const cost = charge(normalizeModel(model), fresh);
          yield { type: "session", handle: handle(message.session_id, priced) };
          yield { type: "usage", cost };
          continue;
        }

        if (message.type !== "result") continue;
        // modelUsage is cumulative for the session. What it holds beyond the tokens already priced
        // is this turn's unreported spend: subagents, internal calls, and final counts. A resumed
        // session whose transcript saved no totals reports less than was priced; nothing more is
        // charged then, and the per-message reports above still covered the turn.
        let topUp = 0n;
        for (const [rawModel, usage] of Object.entries(message.modelUsage)) {
          const model = normalizeModel(rawModel);
          const extra = tokensBeyond(fromModelUsage(usage), priced[model] ?? NO_TOKENS);
          if (!isZero(extra)) topUp += charge(model, extra);
        }
        if (topUp > 0n) {
          yield { type: "session", handle: handle(message.session_id, priced) };
          yield { type: "usage", cost: topUp };
        }
        yield terminal(message);
        return;
      }
      yield { type: "failure", retryable: true, message: "the SDK stream ended without a result message" };
    } catch (error) {
      if (error instanceof Unpriced) {
        yield { type: "failure", retryable: false, message: error.message };
        return;
      }
      if (inv.signal.aborted || error instanceof AbortError) return;
      yield { type: "failure", retryable: false, message: `Claude Agent SDK error: ${String(error)}` };
    } finally {
      inv.signal.removeEventListener("abort", onAbort);
      q.close();
    }
  }
}

function terminal(message: SDKResultMessage): HarnessEvent {
  if (message.subtype === "success") {
    if (message.is_error) {
      const status = message.api_error_status ?? undefined;
      return {
        type: "failure",
        retryable: status === 429 || (status !== undefined && status >= 500),
        message: `API error${status ? ` ${status}` : ""}: ${message.result}`,
      };
    }
    if (message.structured_output !== undefined) return { type: "output", value: message.structured_output };
    const extracted = extractFencedJson(message.result);
    return extracted.ok ? { type: "output", value: extracted.value } : { type: "no_value", reason: extracted.reason };
  }
  switch (message.subtype) {
    case "error_max_structured_output_retries":
      return { type: "no_value", reason: "the agent did not produce output matching result_schema" };
    case "error_max_budget_usd":
      return { type: "failure", retryable: false, message: "the SDK stopped at its own budget limit" };
    case "error_max_turns":
      return { type: "failure", retryable: false, message: "reached harness_config.max_turns" };
    case "error_during_execution":
      return {
        type: "failure",
        retryable: message.terminal_reason === "api_error" || message.terminal_reason === "model_error",
        message: message.errors.join("; ") || "error during execution",
      };
  }
}

/** Usage from one Messages API call, as carried on an assistant message. */
function fromApiUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Tokens {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

function fromModelUsage(usage: ModelUsage): Tokens {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadInputTokens,
    cacheWrite: usage.cacheCreationInputTokens,
  };
}

/**
 * Model ids can carry a context-window suffix such as "[1m]", and the live API returns a dated
 * snapshot id (e.g. "claude-haiku-4-5-20251001") even when the request named the bare alias
 * ("claude-haiku-4-5"); prices are keyed by the bare id in both cases.
 */
function normalizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

function handle(sessionId: string, priced: Record<string, Tokens>): SessionHandle {
  return { sessionId, priced: Object.fromEntries(Object.entries(priced).map(([m, t]) => [m, { ...t }])) };
}

function toClaudeSession(h: SessionHandle): ClaudeSession {
  const { sessionId, priced } = h;
  if (typeof sessionId !== "string" || typeof priced !== "object" || priced === null || Array.isArray(priced))
    throw new Error("session handle was not created by the claude-agent-sdk wrapper");
  return { sessionId, priced: priced as unknown as Record<string, Tokens> };
}

/** Returns the parsed config, or a string describing what is wrong with it. */
function parseConfig(raw: Record<string, unknown>, prices: PriceTable): ClaudeConfig | string {
  const config: ClaudeConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "model":
        if (typeof value !== "string") return "model must be a string";
        if (!(normalizeModel(value) in prices)) return `model '${value}' has no price in the price table`;
        config.model = value;
        break;
      case "cwd":
        if (typeof value !== "string") return "cwd must be a string";
        config.cwd = value;
        break;
      case "allowed_tools":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return "allowed_tools must be a list of strings";
        config.allowedTools = value;
        break;
      case "max_turns":
        if (!Number.isInteger(value) || (value as number) < 1) return "max_turns must be a positive integer";
        config.maxTurns = value as number;
        break;
      case "permission_mode":
        if (!PERMISSION_MODES.includes(value as PermissionMode)) return `permission_mode must be one of ${PERMISSION_MODES.join(", ")}`;
        config.permissionMode = value as PermissionMode;
        break;
      default:
        return `unknown key '${key}'`;
    }
  }
  return config;
}
