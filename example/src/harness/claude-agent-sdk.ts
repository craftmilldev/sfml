// Wrapper for the Claude Agent SDK (@anthropic-ai/claude-agent-sdk): `harness: claude-agent-sdk`.
//
// DRAFT. Written against SDK 0.3.x type definitions and not yet run against the live SDK.
//
// How it meets what SPEC §4.1.3 asks of a Runner:
// - Result: passes result_schema as the SDK's native `outputFormat` and reads `structured_output`.
//   If that is missing, it falls back to parsing a fenced JSON block out of the final text. If
//   neither yields a value, it reports `no_value` (schema_violation, SPEC §10.4).
// - Cost: the SDK reports `total_cost_usd` once per query, on the result message, and the total is
//   cumulative across a resumed session. So the session handle carries the cost already reported
//   (`reportedUsd`), and each invocation reports only the difference. The consequence is one report
//   point per turn. To keep a turn from running far past a ceiling, `spendLimit` is passed as the
//   SDK's own `maxBudgetUsd`.
// - Retryability: API errors with a retryable HTTP status (429, 5xx) are retryable. Config errors,
//   max-turns, and everything else are not.
// - Sessions: a new session's id comes from the `system`/`init` message; `resume` continues it.

import { query, AbortError, type Options, type PermissionMode, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Harness, HarnessEvent, Invocation, SessionHandle } from "./types.js";
import { extractFencedJson } from "./extract.js";
import { formatUsd, parseUsd, usdFromFloat, usdToNumber, type Usd } from "./money.js";

/** What this wrapper persists per session, through the Runner (SessionHandle). */
type ClaudeSession = { sessionId: string; reportedUsd: string };

type ClaudeConfig = {
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  permissionMode?: PermissionMode;
};

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

export class ClaudeAgentSdkHarness implements Harness {
  /** `run` is injectable so the wrapper can be unit-tested without the CLI. */
  constructor(private readonly run: typeof query = query) {}

  async *invoke(inv: Invocation): AsyncGenerator<HarnessEvent> {
    const config = parseConfig(inv.harnessConfig);
    if (typeof config === "string") {
      yield { type: "failure", retryable: false, message: `invalid harness_config: ${config}` };
      return;
    }
    const prior = inv.session ? toClaudeSession(inv.session) : undefined;
    let reported: Usd = prior ? parseUsd(prior.reportedUsd) : 0n;

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    inv.signal.addEventListener("abort", onAbort, { once: true });

    const options: Options = {
      abortController,
      outputFormat: { type: "json_schema", schema: inv.resultSchema },
      ...(prior && { resume: prior.sessionId }),
      ...(inv.spendLimit !== undefined && { maxBudgetUsd: usdToNumber(inv.spendLimit) }),
      ...(config.model && { model: config.model }),
      ...(config.cwd && { cwd: config.cwd }),
      ...(config.allowedTools && { allowedTools: config.allowedTools }),
      ...(config.maxTurns !== undefined && { maxTurns: config.maxTurns }),
      ...(config.permissionMode && { permissionMode: config.permissionMode }),
    };
    const q = this.run({ prompt: inv.prompt, options });

    try {
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init" && !prior) {
          yield { type: "session", handle: session(message.session_id, reported) };
          continue;
        }
        if (message.type !== "result") continue;

        // total_cost_usd is cumulative for the session. A resumed session whose transcript saved no
        // total starts again from zero, which shows up as a total below what was already reported.
        const total = usdFromFloat(message.total_cost_usd);
        const cost = total >= reported ? total - reported : total;
        reported = total;
        // Persist the new basis before reporting usage. If this report crosses a ceiling, the Runner
        // stops here, and the resume after a grant must not count this cost a second time.
        yield { type: "session", handle: session(message.session_id, reported) };
        yield { type: "usage", cost };
        yield terminal(message);
        return;
      }
      yield { type: "failure", retryable: true, message: "the SDK stream ended without a result message" };
    } catch (error) {
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
      // The Runner has already seen a usage event at or past its ceiling and raised budget_exceeded.
      return { type: "failure", retryable: false, message: "stopped at the spend limit" };
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

function session(sessionId: string, reported: Usd): SessionHandle {
  const handle: ClaudeSession = { sessionId, reportedUsd: formatUsd(reported) };
  return handle;
}

function toClaudeSession(handle: SessionHandle): ClaudeSession {
  const { sessionId, reportedUsd } = handle;
  if (typeof sessionId !== "string" || typeof reportedUsd !== "string")
    throw new Error("session handle was not created by the claude-agent-sdk wrapper");
  return { sessionId, reportedUsd };
}

/** Returns the parsed config, or a string describing what is wrong with it. */
function parseConfig(raw: Record<string, unknown>): ClaudeConfig | string {
  const config: ClaudeConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "model":
      case "cwd":
        if (typeof value !== "string") return `${key} must be a string`;
        config[key] = value;
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
