import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkHarness } from "./claude-agent-sdk.js";
import { loadPriceTable } from "./pricing.js";
import type { HarnessEvent, SessionHandle } from "./types.js";

// Resolves the same from src/harness and dist/harness.
const prices = loadPriceTable(fileURLToPath(new URL("../../src/harness/claude-pricing.json", import.meta.url)));

// Minimal stand-ins for SDK messages; only the fields the wrapper reads.
const modelUsage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 999, // deliberately wrong: the wrapper must price tokens itself
  contextWindow: 0,
  maxOutputTokens: 0,
});
const assistant = (id: string, model: string, input_tokens: number, output_tokens: number) => ({
  type: "assistant",
  session_id: "s1",
  message: { id, model, usage: { input_tokens, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
const result = (fields: Record<string, unknown>) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  total_cost_usd: 999, // deliberately wrong
  session_id: "s1",
  ...fields,
});

/** A fake query() that plays `messages` and records the options it was called with. */
function fakeQuery(messages: unknown[], calls: Options[] = []): typeof query {
  return (({ options }: { options: Options }) => {
    calls.push(options);
    return {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      close() {},
    };
  }) as unknown as typeof query;
}

async function invoke(harness: ClaudeAgentSdkHarness, session?: SessionHandle): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  const events = harness.invoke({
    step: "s",
    prompt: "p",
    resultSchema: { type: "object" },
    harnessConfig: { model: "claude-opus-5" },
    signal: new AbortController().signal,
    ...(session && { session }),
  });
  for await (const e of events) out.push(e);
  return out;
}

const costs = (events: HarnessEvent[]) => events.flatMap((e) => (e.type === "usage" ? [e.cost] : []));
const lastHandle = (events: HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "session" ? [e.handle] : [])).at(-1)!;

test("prices each API call's new tokens as they arrive, then tops up from modelUsage, ignoring the SDK's cost estimate", async () => {
  const calls: Options[] = [];
  const events = await invoke(
    new ClaudeAgentSdkHarness(
      prices,
      fakeQuery(
        [
          { type: "system", subtype: "init", session_id: "s1" },
          assistant("m1", "claude-opus-5", 1000, 0), // streamed frame
          assistant("m1", "claude-opus-5", 1000, 200), // same API call, later frame
          result({
            modelUsage: { "claude-opus-5": modelUsage(1000, 200), "claude-haiku-4-5": modelUsage(5000, 100) },
            structured_output: { ok: true },
          }),
        ],
        calls,
      ),
    ),
  );
  // opus: 1000 in × 500¢ = 500000, then 200 out × 2500¢ = 500000; haiku subagent top-up: 5000×100 + 100×500.
  assert.deepEqual(costs(events), [500_000n, 500_000n, 550_000n]);
  assert.deepEqual(events.at(-1), { type: "output", value: { ok: true } });
  assert.deepEqual(calls[0]!.outputFormat, { type: "json_schema", schema: { type: "object" } });
  assert.equal(calls[0]!.resume, undefined);
  assert.deepEqual(lastHandle(events), {
    sessionId: "s1",
    priced: {
      "claude-opus-5": { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      "claude-haiku-4-5": { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0 },
    },
  });
});

test("a resumed session reports only new tokens, even though modelUsage is cumulative", async () => {
  const prior: SessionHandle = {
    sessionId: "s1",
    priced: {
      "claude-opus-5": { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      "claude-haiku-4-5": { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0 },
    },
  };
  const calls: Options[] = [];
  const events = await invoke(
    new ClaudeAgentSdkHarness(
      prices,
      fakeQuery(
        [
          assistant("m2", "claude-opus-5", 2000, 0),
          result({
            result: 'Done.\n```json\n{"ok": 2}\n```',
            modelUsage: { "claude-opus-5": modelUsage(3000, 200), "claude-haiku-4-5": modelUsage(5000, 100) },
          }),
        ],
        calls,
      ),
    ),
    prior,
  );
  assert.equal(calls[0]!.resume, "s1");
  assert.deepEqual(costs(events), [1_000_000n], "no top-up: modelUsage holds nothing beyond what was priced");
  assert.deepEqual(events.at(-1), { type: "output", value: { ok: 2 } }, "falls back to the fenced JSON block");
});

test("the session handle is updated before each usage report, so a stop at that report never double-counts", async () => {
  const events = await invoke(
    new ClaudeAgentSdkHarness(prices, fakeQuery([{ type: "system", subtype: "init", session_id: "s1" }, assistant("m1", "claude-opus-5", 1000, 0)])),
  );
  const usageAt = events.findIndex((e) => e.type === "usage");
  const before = events[usageAt - 1]!;
  assert.equal(before.type, "session");
  assert.deepEqual((before as { handle: SessionHandle }).handle.priced, { "claude-opus-5": { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } });
});

test("a model with no price is a non-retryable failure", async () => {
  const events = await invoke(new ClaudeAgentSdkHarness(prices, fakeQuery([assistant("m1", "claude-unknown-9", 10, 10)])));
  assert.deepEqual(events.at(-1), { type: "failure", retryable: false, message: "no price for model 'claude-unknown-9' in the price table" });
});

test("output that yields no value is no_value (schema_violation), not a failure", async () => {
  const events = await invoke(new ClaudeAgentSdkHarness(prices, fakeQuery([result({ result: "I could not finish.", modelUsage: {} })])));
  assert.equal(events.at(-1)!.type, "no_value");
});

test("API errors are retryable only for 429 and 5xx", async () => {
  const withStatus = async (status: number) =>
    (await invoke(new ClaudeAgentSdkHarness(prices, fakeQuery([result({ is_error: true, api_error_status: status, result: "err", modelUsage: {} })])))).at(-1);
  assert.deepEqual(await withStatus(429), { type: "failure", retryable: true, message: "API error 429: err" });
  assert.deepEqual(await withStatus(529), { type: "failure", retryable: true, message: "API error 529: err" });
  assert.deepEqual(await withStatus(401), { type: "failure", retryable: false, message: "API error 401: err" });
});

test("invalid harness_config is a non-retryable failure before the SDK is called", async () => {
  const calls: Options[] = [];
  const harness = new ClaudeAgentSdkHarness(prices, fakeQuery([], calls));
  const events: HarnessEvent[] = [];
  for await (const e of harness.invoke({ step: "s", prompt: "p", resultSchema: {}, harnessConfig: { model: "gpt-9" }, signal: new AbortController().signal }))
    events.push(e);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "failure");
  assert.equal(calls.length, 0);
});
