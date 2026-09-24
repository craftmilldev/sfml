import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockBackend, type Row } from "./mock-backend.js";
import { MockHarness } from "./mock.js";
import { loadPriceTable } from "./pricing.js";
import type { HarnessEvent, Invocation, SessionHandle } from "./types.js";

// Resolves the same from src/harness and dist/harness.
const prices = loadPriceTable(fileURLToPath(new URL("../../../../conformance/models.json", import.meta.url)));

const parallelBudget: Row[] = [
  { send: { session: "lint-1", agent: "linter", model: "mock-small", prompt: "Lint." } },
  { send: { session: "test-1", agent: "tester", model: "mock-small" } },
  { reply: { session: "lint-1", usage: { output_tokens: 120000 } } }, // 0.60
  { reply: { session: "test-1", usage: { output_tokens: 120000 } } }, // pool 1.20
  { close: ["lint-1", "test-1"] },
  { send: { session: "lint-1" } },
  { send: { session: "test-1" } },
  { reply: { session: "lint-1", usage: { output_tokens: 20000 }, result: { passed: true } } },
  { reply: { session: "test-1", usage: { output_tokens: 20000 }, result: { failures: 0 } } },
];

function invocation(step: string, agent: string, prompt: string, signal: AbortSignal, session?: SessionHandle): Invocation {
  return { step, prompt, resultSchema: {}, harnessConfig: { agent }, signal, ...(session && { session }) };
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * A minimal stand-in for a Runner running one `parallel` region against a shared run-level budget:
 * both children start concurrently, each through its own wrapper instance over the one backend, and
 * the first report that reaches the ceiling stops every child.
 */
async function runRegion(backend: MockBackend, ceiling: bigint, pool: { spent: bigint }, handles: Record<string, SessionHandle>) {
  const stop = new AbortController();
  const log: string[] = [];
  const child = async (name: string, agent: string, prompt: string) => {
    const harness = new MockHarness(backend, prices);
    for await (const e of harness.invoke(invocation(`checks.${name}`, agent, prompt, stop.signal, handles[name]))) {
      if (e.type === "session") {
        handles[name] = e.handle;
        continue;
      }
      if (e.type === "usage") {
        pool.spent += e.cost;
        log.push(`${name}:usage=${e.cost}`);
      }
      if (pool.spent >= ceiling) {
        stop.abort();
        log.push(`${name}:stopped`);
        return undefined;
      }
      if (e.type === "output") return e.value;
      if (e.type !== "usage") assert.fail(`unexpected ${e.type} for ${name}`);
    }
    return undefined;
  };
  const [lint, test] = await Promise.all([child("lint", "linter", "Lint."), child("test", "tester", "Test.")]);
  return { lint, test, log };
}

test("a run-level budget crossed inside a parallel region stops both children, then a grant resumes both sessions after a restart", async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), "sfml-mock-")), "state.json");
  const pool = { spent: 0n };
  const handles: Record<string, SessionHandle> = {};

  const first = await runRegion(new MockBackend(parallelBudget, statePath), 100_000_000n, pool, handles);
  assert.equal(first.lint, undefined);
  assert.equal(first.test, undefined);
  assert.equal(pool.spent, 120_000_000n);
  assert.deepEqual(first.log, ["lint:usage=60000000", "test:usage=60000000", "test:stopped"]);

  const saved = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(saved.cursor, 5, "the cursor has moved past the close row");
  assert.deepEqual(Object.keys(saved.sessions).sort(), ["lint-1", "test-1"]);

  // Runner restart: a new backend reloads the saved state; the handles came from the Runner's storage.
  const restarted = new MockBackend(parallelBudget, statePath);
  const second = await runRegion(restarted, 150_000_000n, pool, structuredClone(handles));
  assert.deepEqual(second.lint, { passed: true });
  assert.deepEqual(second.test, { failures: 0 });
  assert.equal(pool.spent, 140_000_000n);
  assert.deepEqual(restarted.verify(), []);
});

test("a prompt that does not match the transcript is a non-retryable failure and a recorded fault", async () => {
  const backend = new MockBackend(parallelBudget);
  const events = await collect(new MockHarness(backend, prices).invoke(invocation("checks.lint", "linter", "wrong", new AbortController().signal)));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "failure");
  assert.equal((events[0] as { retryable: boolean }).retryable, false);
  assert.equal(backend.faults.length, 1);
  assert.notDeepEqual(backend.verify(), []);
});

test("usage on a model with no price is a non-retryable failure, never a zero cost", async () => {
  const backend = new MockBackend([
    { send: { session: "x-1", agent: "x", model: "mock-unpriced" } },
    { reply: { session: "x-1", usage: { output_tokens: 1 }, result: {} } },
  ]);
  const events = await collect(new MockHarness(backend, prices).invoke(invocation("x", "x", "p", new AbortController().signal)));
  assert.deepEqual(events.map((e) => e.type), ["session", "failure"]);
  assert.match((events[1] as { message: string }).message, /no price for model 'mock-unpriced'/);
});

test("a retryable error, a retry on the same session, then output", async () => {
  const backend = new MockBackend([
    { send: { session: "w-1", agent: "worker", model: "mock-medium", prompt: "Work." } },
    { reply: { session: "w-1", usage: { input_tokens: 1000 }, error: { message: "429", retryable: true, backoff_ms: 0 } } },
    { send: { session: "w-1" } },
    { reply: { session: "w-1", usage: { input_tokens: 1000 }, result: { ok: true } } },
  ]);
  const harness = new MockHarness(backend, prices);
  const signal = new AbortController().signal;

  const first = await collect(harness.invoke(invocation("work", "worker", "Work.", signal)));
  assert.deepEqual(first.map((e) => e.type), ["session", "usage", "failure"]);
  assert.deepEqual(first[2], { type: "failure", retryable: true, message: "429", backoffMs: 0 });
  const handle = (first[0] as { handle: SessionHandle }).handle;

  const second = await collect(harness.invoke(invocation("work", "worker", "Work.", signal, handle)));
  assert.deepEqual(second.map((e) => e.type), ["session", "usage", "output"]);
  assert.deepEqual(backend.verify(), []);
});

test("opening a new session where the transcript expects the old one to continue is a fault", async () => {
  const backend = new MockBackend([
    { send: { session: "w-1", agent: "worker", model: "mock-medium" } },
    { reply: { session: "w-1", error: { message: "boom", retryable: true } } },
    { send: { session: "w-1" } },
    { reply: { session: "w-1", result: { ok: true } } },
  ]);
  const harness = new MockHarness(backend, prices);
  const signal = new AbortController().signal;
  await collect(harness.invoke(invocation("work", "worker", "Work.", signal)));
  const retried = await collect(harness.invoke(invocation("work", "worker", "Work.", signal))); // no handle: new session
  assert.equal(retried.at(-1)!.type, "failure");
  assert.equal(backend.faults.length, 1);
});

test("close: stopping at the crossing usage passes; taking the result the Runner should refuse is a fault", async () => {
  const rows: Row[] = [
    { send: { session: "w-1", agent: "worker", model: "mock-small" } },
    { reply: { session: "w-1", usage: { input_tokens: 4000 }, result: { summary: "late" } } },
    { close: ["w-1"] },
  ];
  const play = async (stopAtUsage: boolean) => {
    const backend = new MockBackend(rows);
    const stop = new AbortController();
    for await (const e of new MockHarness(backend, prices).invoke(invocation("work", "worker", "p", stop.signal))) {
      if (e.type === "usage" && stopAtUsage) {
        stop.abort();
        break;
      }
    }
    return backend.verify();
  };
  assert.deepEqual(await play(true), []);
  const problems = await play(false);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /took 'w-1' to its terminal outcome instead of stopping it/);
});

test("every conformance transcript loads into the backend", () => {
  const runnerDir = fileURLToPath(new URL("../../../../conformance/runner/", import.meta.url));
  let loaded = 0;
  for (const test of readdirSync(runnerDir)) {
    const transcript = join(runnerDir, test, "transcript.yaml");
    if (!existsSync(transcript)) continue;
    const backend = MockBackend.fromFiles({ transcript });
    assert.notDeepEqual(backend.verify(), [], `${test}: an unplayed transcript must not verify as complete`);
    loaded++;
  }
  assert.ok(loaded > 0);
});

test("harness_config must be exactly { agent }", async () => {
  const harness = new MockHarness(new MockBackend([]), prices);
  const events = await collect(
    harness.invoke({ step: "s", prompt: "p", resultSchema: {}, harnessConfig: { agent: "a", extra: 1 }, signal: new AbortController().signal }),
  );
  assert.deepEqual(events.map((e) => e.type), ["failure"]);
});
