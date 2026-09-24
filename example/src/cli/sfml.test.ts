// Unit + integration coverage for issue #27: a blocked (errored/awaiting_input) run must report
// something a human can act on -- the instruction or error, the resume payload shape, and a
// ready-to-copy `sfml resume` command -- instead of dumping the raw Observation JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { payloadHint, renderInstruction, reportBlocked } from "./sfml.js";
import type { BlockedEntry, Observation } from "../engine/runner.js";
import type { Factory } from "../engine/factory.js";
import type { ExceptionClass } from "../engine/state.js";

// --- payloadHint: SPEC §11.4's table, one row per class ------------------------------------------

const EXPECTED_HINTS: [BlockedEntry, RegExp][] = [
  [{ step: "s", state: "awaiting_input" }, /object matching the step's result_schema/],
  [{ step: "s", state: "errored", exception: "iteration_limit" }, /non-negative integer.*additional iterations/],
  [{ step: "s", state: "errored", exception: "budget_exceeded", exceededScope: "step" }, /USD amount.*additional step budget/],
  [{ step: "s", state: "errored", exception: "budget_exceeded", exceededScope: "run" }, /USD amount.*additional run budget/],
  [{ step: "s", state: "errored", exception: "harness_error" }, /retry on the same session.*result_schema/],
  [{ step: "s", state: "errored", exception: "schema_violation" }, /new agent turn.*result_schema/],
  [{ step: "s", state: "errored", exception: "expression_error" }, /re-attempt the step.*result_schema/],
  [{ step: "s", state: "errored", exception: "routing_error" }, /re-evaluate routing.*StepName/],
];

test("payloadHint: each exception class (and awaiting_input) gets its SPEC §11.4 payload shape", () => {
  for (const [entry, expected] of EXPECTED_HINTS) {
    assert.match(payloadHint(entry), expected, `for ${entry.state}/${entry.exception}`);
  }
});

test("payloadHint: budget_exceeded with no exceededScope falls back to 'step'", () => {
  const entry: BlockedEntry = { step: "s", state: "errored", exception: "budget_exceeded" };
  assert.match(payloadHint(entry), /additional step budget/);
});

const ALL_CLASSES: ExceptionClass[] = ["iteration_limit", "budget_exceeded", "harness_error", "schema_violation", "expression_error", "routing_error"];

test("payloadHint: covers all six exception classes plus awaiting_input, none falling through to '(unknown)'", () => {
  assert.notEqual(payloadHint({ step: "s", state: "awaiting_input" }), "(unknown)");
  for (const exception of ALL_CLASSES) assert.notEqual(payloadHint({ step: "s", state: "errored", exception }), "(unknown)");
});

// --- renderInstruction -----------------------------------------------------------------------------

const factory: Factory = {
  sfml: "v0.1",
  start: "review",
  parameters: { title: { type: "string" } },
  steps: {
    review: {
      type: "human",
      result_schema: { type: "object" },
      instructions: "parameters.title",
      next: [{ to: "done" }],
    },
    silent: { type: "human", result_schema: { type: "object" }, next: [{ to: "done" }] },
    fan: {
      type: "parallel",
      next: [{ to: "done" }],
      steps: { design: { type: "human", result_schema: { type: "object" }, instructions: "parameters.title" } },
    },
    done: { type: "result", outcome: "complete" },
  },
};

const state: Observation["state"] = { parameters: { title: "widget" }, results: {} };

test("renderInstruction: evaluates a human step's instructions expression against observed state", () => {
  assert.equal(renderInstruction("review", factory, state), "widget");
});

test("renderInstruction: a parallel child's instructions resolve via the qualified name", () => {
  assert.equal(renderInstruction("fan.design", factory, state), "widget");
});

test("renderInstruction: undefined when the step declares no instructions", () => {
  assert.equal(renderInstruction("silent", factory, state), undefined);
});

test("renderInstruction: undefined (not a throw) for an unknown step", () => {
  assert.equal(renderInstruction("nope", factory, state), undefined);
});

// --- reportBlocked: stderr formatting, and never a raw JSON dump -----------------------------------

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("reportBlocked: awaiting_input prints the rendered instruction, not the raw JSON state", () => {
  const observation: Observation = {
    status: "awaiting_input",
    blocked: [{ step: "review", state: "awaiting_input" }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--run", "abc-123"]));
  assert.match(out, /instruction: widget/);
  assert.match(out, /resume payload: an object matching the step's result_schema/);
  assert.match(out, /sfml resume f\.sfml --run abc-123 --step review --payload '\{\}'/);
  assert.ok(!out.includes('"parameters"') && !out.includes('"results"'), "must not dump the observed state JSON");
});

test("reportBlocked: errored shows the exception class and any message (context)", () => {
  const observation: Observation = {
    status: "errored",
    blocked: [{ step: "draft", state: "errored", exception: "schema_violation", message: "/ must have required property 'title'" }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--run", "abc-123"]));
  assert.match(out, /error: schema_violation/);
  assert.match(out, /context: \/ must have required property 'title'/);
});

test("reportBlocked: a --state-only run prints --state, not --run, in the resume command", () => {
  const observation: Observation = {
    status: "errored",
    blocked: [{ step: "draft", state: "errored", exception: "harness_error" }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--state", "/tmp/run.json"]));
  assert.match(out, /sfml resume f\.sfml --state \/tmp\/run\.json --step draft --payload '\{\}'/);
  assert.ok(!out.includes("--run "));
});

// --- integration: spawn the built CLI over a minimal fixture factory -------------------------------

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "sfml.js");

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [cliPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

test("integration: a run that blocks at a human step reports human-readable guidance, then resume reaches the terminal JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-cli-test-"));
  try {
    const factoryPath = join(dir, "factory.sfml");
    writeFileSync(
      factoryPath,
      [
        'sfml: "v0.1"',
        "start: review",
        "parameters:",
        "  title: { type: string }",
        "steps:",
        "  review:",
        "    type: human",
        "    instructions: parameters.title",
        "    result_schema:",
        "      type: object",
        "      required: [approved]",
        "      properties: { approved: { type: boolean } }",
        "    next:",
        "      - to: done",
        "  done:",
        "    type: result",
        "    outcome: complete",
        "",
      ].join("\n"),
    );
    const statePath = join(dir, "run.json");

    const runResult = runCli(["run", factoryPath, "--param", "title=widget", "--state", statePath], dir);
    assert.equal(runResult.status, 0);
    assert.equal(runResult.stdout, "", "a non-terminal observation must not dump JSON to stdout");
    assert.match(runResult.stderr, /awaiting input/);
    assert.match(runResult.stderr, /instruction: widget/);
    assert.match(runResult.stderr, /resume payload: an object matching the step's result_schema/);
    // `run` always mints and reports its own --run <id>, even when --state was also given.
    const runIdMatch = runResult.stderr.match(/^run: (\S+)$/m);
    assert.ok(runIdMatch, "expected `run: <id>` on stderr");
    assert.match(
      runResult.stderr,
      new RegExp(`sfml resume ${factoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --run ${runIdMatch![1]} --step review --payload '\\{\\}'`),
    );

    const resumeResult = runCli(["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":true}'], dir);
    assert.equal(resumeResult.status, 0);
    const printed = JSON.parse(resumeResult.stdout) as Observation;
    assert.equal(printed.status, "terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: a terminal observation from `run` still prints the full JSON on stdout unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-cli-test-"));
  try {
    const factoryPath = join(dir, "factory.sfml");
    writeFileSync(factoryPath, ["sfml: \"v0.1\"", "start: done", "steps:", "  done:", "    type: result", "    outcome: complete", ""].join("\n"));
    const result = runCli(["run", factoryPath], dir);
    assert.equal(result.status, 0);
    const printed = JSON.parse(result.stdout) as Observation;
    assert.equal(printed.status, "terminal");
    assert.equal(printed.outcome, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
