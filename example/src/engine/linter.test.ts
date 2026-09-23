// Exercises every §8.7 diagnostic beyond the one case (`non-total-routing`) the conformance suite
// carries (conformance.test.ts flags the rest as missing coverage — see example/README.md). These
// fixtures are hand-authored to isolate one rule at a time; they are not conformance fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintFactory } from "./linter.js";
import type { Factory } from "./factory.js";

function ids(factory: Factory): string[] {
  return lintFactory(factory)
    .map((d) => d.id)
    .sort();
}

const resultSchema = { type: "object" };

test("unknown-step-reference: start and a connection.to both checked", () => {
  const factory: Factory = {
    sfml: "v0.1",
    start: "nope",
    steps: { done: { type: "result", outcome: "complete" } },
  };
  assert.deepEqual(ids(factory), ["unknown-step-reference"]);

  const factory2: Factory = {
    sfml: "v0.1",
    start: "a",
    steps: {
      a: { type: "result", outcome: "complete" } as never, // placeholder; replaced below
    },
  };
  factory2.steps.a = { type: "agent", harness: "mock", prompt: "x", result_schema: resultSchema, next: [{ to: "missing" }] };
  // Once the bad edge is discarded, "a" also has nowhere left that reaches a result step.
  assert.deepEqual(ids(factory2), ["no-path-to-result", "unknown-step-reference"]);
});

test("unreachable-step and no-path-to-result", () => {
  const factory: Factory = {
    sfml: "v0.1",
    start: "start",
    steps: {
      start: { type: "result", outcome: "complete" },
      orphan: { type: "result", outcome: "complete" },
    },
  };
  assert.deepEqual(ids(factory), ["unreachable-step"]);
});

test("no-path-to-result: a reachable step whose only routes lead into a dead end", () => {
  const factory: Factory = {
    sfml: "v0.1",
    start: "loop",
    steps: {
      loop: { type: "agent", harness: "mock", prompt: "x", result_schema: resultSchema, max_iterations: 3, next: [{ to: "loop" }] },
    },
  };
  assert.deepEqual(ids(factory), ["no-path-to-result"]);
});

test("unbounded-cycle: a self-loop with no max_iterations is rejected; one with it is accepted", () => {
  const unbounded: Factory = {
    sfml: "v0.1",
    start: "poll",
    steps: {
      poll: { type: "agent", harness: "mock", prompt: "x", result_schema: resultSchema, next: [{ to: "poll" }] },
    },
  };
  assert.deepEqual(ids(unbounded), ["no-path-to-result", "unbounded-cycle"]);

  const bounded: Factory = {
    sfml: "v0.1",
    start: "poll",
    steps: {
      poll: {
        type: "agent",
        harness: "mock",
        prompt: "x",
        result_schema: resultSchema,
        max_iterations: 5,
        next: [{ when: "last(results.poll).done", to: "done" }, { to: "poll" }],
      },
      done: { type: "result", outcome: "complete" },
    },
  };
  assert.deepEqual(ids(bounded), []);
});

test("unknown-parameter-reference and unknown-step-result-reference", () => {
  const factory: Factory = {
    sfml: "v0.1",
    start: "done",
    parameters: { issue: { type: "string" } },
    steps: {
      done: { type: "result", outcome: "complete", value: "parameters.nope" },
    },
  };
  assert.deepEqual(ids(factory), ["unknown-parameter-reference"]);

  const factory2: Factory = {
    sfml: "v0.1",
    start: "done",
    steps: {
      done: { type: "result", outcome: "complete", value: "last(results.nosuchstep)" },
    },
  };
  assert.deepEqual(ids(factory2), ["unknown-step-result-reference"]);
});

test("unreachable-reference: Y references results.X but no path X → … → Y exists", () => {
  // a routes to b (unconditionally, first) or c; b references results.c, but c's only route goes to
  // result2, never back to b — so no path c → … → b exists, even though both b and c are themselves
  // reachable from start.
  const factory: Factory = {
    sfml: "v0.1",
    start: "a",
    steps: {
      a: {
        type: "agent",
        harness: "mock",
        prompt: "x",
        result_schema: resultSchema,
        next: [{ when: "cond", to: "b" }, { to: "c" }],
      },
      b: { type: "result", outcome: "complete", value: "last(results.c)" },
      c: { type: "agent", harness: "mock", prompt: "x", result_schema: resultSchema, next: [{ to: "result2" }] },
      result2: { type: "result", outcome: "complete" },
    },
  };
  assert.deepEqual(ids(factory), ["unreachable-reference"]);
});

test("binding-environment-violation: a PromptVars expression cannot reach results/parameters, and vice versa", () => {
  const factory: Factory = {
    sfml: "v0.1",
    start: "a",
    steps: {
      a: {
        type: "agent",
        harness: "mock",
        prompt: "Hi ««results.a»»", // a PromptVars expression reaching into FactoryState
        prompt_vars: { x: "prompt_vars.whatever" }, // a FactoryState expression reaching into PromptVars
        result_schema: resultSchema,
        next: [{ to: "done" }],
      },
      done: { type: "result", outcome: "complete" },
    },
  };
  assert.deepEqual(ids(factory), ["binding-environment-violation", "binding-environment-violation"]);
});
