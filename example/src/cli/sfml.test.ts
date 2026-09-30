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

import { payloadExample, payloadHint, renderInstruction, reportBlocked } from "./sfml.js";
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

test("payloadHint: appends the actual result_schema JSON when one is passed", () => {
  const schema = { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } };
  assert.match(payloadHint({ step: "s", state: "awaiting_input" }, schema), /result_schema: \{"type":"object".*"approved"/);
  assert.match(payloadHint({ step: "s", state: "errored", exception: "schema_violation" }, schema), /result_schema to supply the result directly: \{"type":"object"/);
});

// --- payloadExample: the --payload example shown in the copy-pasteable resume command (issue #38) --

test("payloadExample: awaiting_input uses a result_schema placeholder, not '{}'", () => {
  assert.match(payloadExample({ step: "s", state: "awaiting_input" })!, /result_schema/);
});

test("payloadExample: iteration_limit uses an integer placeholder", () => {
  assert.match(payloadExample({ step: "s", state: "errored", exception: "iteration_limit" })!, /integer/);
});

test("payloadExample: budget_exceeded uses a USD placeholder", () => {
  assert.match(payloadExample({ step: "s", state: "errored", exception: "budget_exceeded" })!, /USD/);
});

test("payloadExample: harness_error, schema_violation, expression_error, routing_error are all undefined (--payload optional)", () => {
  for (const exception of ["harness_error", "schema_violation", "expression_error", "routing_error"] as const) {
    assert.equal(payloadExample({ step: "s", state: "errored", exception }), undefined, `for ${exception}`);
  }
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
    echo: { type: "human", result_schema: { type: "object" }, instructions: "last_result", next: [{ to: "done" }] },
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

// Fixture: conformance/runner/last-result-parallel/factory.sfml has a human step whose
// `instructions` is the bare `last_result` identifier -- a spec-supported pattern (§9.2). Without
// `BlockedEntry.lastResult`, this instruction can't be rendered: `last_result` isn't in ObservedState
// since it's per-step, not global run state.
test("renderInstruction: an instructions expression referencing bare last_result resolves via the passed-in lastResult", () => {
  assert.equal(renderInstruction("echo", factory, state, { tag: "widget" }), '{"tag":"widget"}');
  assert.equal(renderInstruction("echo", factory, state), "null", "defaults to null, matching env(forStep)'s has()-guarded lookup");
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
  assert.match(out, /resume payload: an object matching the step's result_schema: \{"type":"object"\}/);
  assert.match(out, /sfml resume f\.sfml --run abc-123 --step review --payload '<json matching result_schema>'/);
  assert.ok(!out.includes('"parameters"') && !out.includes('"results"'), "must not dump the observed state JSON");
});

test("reportBlocked: errored schema_violation/harness_error include the step's result_schema", () => {
  const observation: Observation = {
    status: "errored",
    blocked: [{ step: "review", state: "errored", exception: "schema_violation", message: "/ must have required property 'title'" }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--run", "abc-123"]));
  assert.match(out, /resume payload: .*result_schema to supply the result directly: \{"type":"object"\}/);
  assert.match(out, /sfml resume f\.sfml --run abc-123 --step review\n/);
  assert.match(out, /\(--payload is optional here; add --payload '<json>' to supply the result\/route directly instead of retrying\)/);
});

test("reportBlocked: expression_error on a result step has no result_schema to show", () => {
  const observation: Observation = {
    status: "errored",
    blocked: [{ step: "done", state: "errored", exception: "expression_error" }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--run", "abc-123"]));
  assert.match(out, /resume payload: omit to re-attempt the step, or an object matching result_schema \(any JSON value for a result step\) to supply the result directly\n/);
  assert.match(out, /sfml resume f\.sfml --run abc-123 --step done\n/);
});

test("reportBlocked: a parallel child step resolves its own result_schema", () => {
  const observation: Observation = {
    status: "awaiting_input",
    blocked: [{ step: "fan.design", state: "awaiting_input" }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--run", "abc-123"]));
  assert.match(out, /resume payload: an object matching the step's result_schema: \{"type":"object"\}/);
});

test("reportBlocked: a blocked human step whose instructions reference last_result renders it, not '(none declared)'", () => {
  const observation: Observation = {
    status: "awaiting_input",
    blocked: [{ step: "echo", state: "awaiting_input", lastResult: { tag: "widget" } }],
    state,
  };
  const out = captureStderr(() => reportBlocked(observation, factory, "f.sfml", ["--run", "abc-123"]));
  assert.match(out, /instruction: \{"tag":"widget"\}/);
  assert.ok(!out.includes("(none declared)"));
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
  assert.match(out, /sfml resume f\.sfml --state \/tmp\/run\.json --step draft\n/);
  assert.ok(!out.includes("--payload '{}'"));
  assert.ok(!out.includes("--run "));
});

// --- integration: spawn the built CLI over a minimal fixture factory -------------------------------

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "sfml.js");

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [cliPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function writeFactory(dir: string, lines: string[]): string {
  const factoryPath = join(dir, "factory.sfml");
  writeFileSync(factoryPath, lines.join("\n"));
  return factoryPath;
}

/** A chain of `human` steps (each requiring `{ approved: boolean }`, instructions `parameters.title`)
 * feeding into each other and finally into `done`. Shared by the tests below so the factory shape
 * lives in one place instead of being copy-pasted per test. */
function writeHumanFactory(dir: string, steps: string[]): string {
  const lines = ['sfml: "v0.1"', `start: ${steps[0]}`, "parameters:", "  title: { type: string }", "steps:"];
  steps.forEach((name, i) => {
    lines.push(
      `  ${name}:`,
      "    type: human",
      "    instructions: parameters.title",
      "    result_schema:",
      "      type: object",
      "      required: [approved]",
      "      properties: { approved: { type: boolean } }",
      "    next:",
      `      - to: ${steps[i + 1] ?? "done"}`,
    );
  });
  lines.push("  done:", "    type: result", "    outcome: complete", "");
  return writeFactory(dir, lines);
}

/** Runs to the first blocked step of a `writeHumanFactory` factory and asserts it's awaiting input. */
function runThenBlock(factoryPath: string, dir: string, statePath: string): ReturnType<typeof runCli> {
  const runResult = runCli(["run", factoryPath, "--param", "title=widget", "--state", statePath], dir);
  assert.equal(runResult.status, 0);
  assert.equal(runResult.stdout, "", "a non-terminal observation must not dump JSON to stdout");
  assert.match(runResult.stderr, /awaiting input/);
  assert.match(runResult.stderr, /instruction: widget/);
  assert.match(runResult.stderr, /resume payload: an object matching the step's result_schema/);
  return runResult;
}

test("integration: a run that blocks at a human step reports human-readable guidance, then resume reaches the terminal JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-cli-test-"));
  try {
    const factoryPath = writeHumanFactory(dir, ["review"]);
    const statePath = join(dir, "run.json");
    const runResult = runThenBlock(factoryPath, dir, statePath);
    // An explicit --state was given to `run`, so the copy-pasteable command must resume via --state
    // (the default --run <id> path is never written to in that case) -- not --run.
    const escapedFactoryPath = factoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedStatePath = statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(runResult.stderr, new RegExp(`sfml resume ${escapedFactoryPath} --state ${escapedStatePath} --step review --payload '<json matching result_schema>'`));
    assert.ok(!runResult.stderr.includes("--run "), "must not suggest --run when the state was written to a custom --state path");

    const resumeResult = runCli(["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":true}'], dir);
    assert.equal(resumeResult.status, 0);
    const printed = JSON.parse(resumeResult.stdout) as Observation;
    assert.equal(printed.status, "terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: resume with a payload that fails validation is rejected and still prints the human report", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-cli-test-"));
  try {
    const factoryPath = writeHumanFactory(dir, ["review"]);
    const statePath = join(dir, "run.json");
    runThenBlock(factoryPath, dir, statePath);

    const rejectedResult = runCli(
      ["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":"not-a-boolean"}'],
      dir,
    );
    assert.equal(rejectedResult.status, 0, "a rejected resume is not a CLI error/crash");
    assert.equal(rejectedResult.stdout, "", "a rejected (non-terminal) resume must not dump JSON to stdout");
    assert.match(rejectedResult.stderr, /resume rejected: the payload did not match/);
    assert.match(rejectedResult.stderr, /awaiting input/);
    assert.match(rejectedResult.stderr, /instruction: widget/);
    assert.match(rejectedResult.stderr, /resume payload: an object matching the step's result_schema/);
    assert.ok(!rejectedResult.stderr.includes('"parameters"'), "must not dump raw state JSON");
    assert.ok(!rejectedResult.stderr.includes('"results"'), "must not dump raw state JSON");

    // Sanity check: the rejected resume didn't corrupt state -- a valid payload still resolves.
    const resumeResult = runCli(["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":true}'], dir);
    assert.equal(resumeResult.status, 0);
    const printed = JSON.parse(resumeResult.stdout) as Observation;
    assert.equal(printed.status, "terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: resume that succeeds but blocks again still prints the human report, not raw JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-cli-test-"));
  try {
    const factoryPath = writeHumanFactory(dir, ["review", "approve"]);
    const statePath = join(dir, "run.json");
    runThenBlock(factoryPath, dir, statePath);

    const resumeResult = runCli(["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":true}'], dir);
    assert.equal(resumeResult.status, 0);
    assert.equal(resumeResult.stdout, "", "still-blocked resume must not dump JSON to stdout");
    assert.match(resumeResult.stderr, /awaiting input/);
    assert.match(resumeResult.stderr, /instruction: widget/);
    assert.match(resumeResult.stderr, /resume payload: an object matching the step's result_schema/);
    const escapedFactoryPath = factoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedStatePath = statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(resumeResult.stderr, new RegExp(`sfml resume ${escapedFactoryPath} --state ${escapedStatePath} --step approve --payload '<json matching result_schema>'`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #28 is about resume being "not accepted" in general, not just the awaiting_input case above --
// this exercises a rejected resume against one of the exception-class branches (SPEC §11.4/§11.5),
// reaching `reportBlocked`'s errored (not awaiting_input) rendering via `resume`, end to end.
test("integration: resume rejected for an exception-class (expression_error) block still prints the human report", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-cli-test-"));
  try {
    // `parameters.checklist[0]` on an empty list throws, so `review` blocks with expression_error on
    // arrival instead of awaiting_input -- no human/agent step needed to reach an exception class.
    const factoryPath = writeFactory(dir, [
      'sfml: "v0.1"',
      "start: review",
      "parameters:",
      "  checklist: { type: array, items: { type: string } }",
      "steps:",
      "  review:",
      "    type: human",
      "    instructions: parameters.checklist[0]",
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
    ]);
    const statePath = join(dir, "run.json");

    const runResult = runCli(["run", factoryPath, "--param", "checklist=[]", "--state", statePath], dir);
    assert.equal(runResult.status, 0);
    assert.match(runResult.stderr, /error: expression_error/);

    const rejectedResult = runCli(
      ["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":"not-a-boolean"}'],
      dir,
    );
    assert.equal(rejectedResult.status, 0, "a rejected resume is not a CLI error/crash");
    assert.equal(rejectedResult.stdout, "", "a rejected (non-terminal) resume must not dump JSON to stdout");
    assert.match(rejectedResult.stderr, /resume rejected: the payload did not match/);
    assert.match(rejectedResult.stderr, /error: expression_error/);
    assert.match(rejectedResult.stderr, /resume payload: omit to re-attempt the step/);
    assert.ok(!rejectedResult.stderr.includes('"parameters"'), "must not dump raw state JSON");
    assert.ok(!rejectedResult.stderr.includes('"results"'), "must not dump raw state JSON");

    // Sanity check: an override payload matching result_schema still resolves the run.
    const resumeResult = runCli(["resume", factoryPath, "--state", statePath, "--step", "review", "--payload", '{"approved":true}'], dir);
    assert.equal(resumeResult.status, 0);
    const printed = JSON.parse(resumeResult.stdout) as Observation;
    assert.equal(printed.status, "terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: a run with no --state prints --run (the default path `run` actually wrote)", () => {
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
        "    result_schema: { type: object }",
        "    next:",
        "      - to: done",
        "  done:",
        "    type: result",
        "    outcome: complete",
        "",
      ].join("\n"),
    );

    const runResult = runCli(["run", factoryPath, "--param", "title=widget"], dir);
    assert.equal(runResult.status, 0);
    const runIdMatch = runResult.stderr.match(/^run: (\S+)$/m);
    assert.ok(runIdMatch, "expected `run: <id>` on stderr");
    const escapedFactoryPath = factoryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(runResult.stderr, new RegExp(`sfml resume ${escapedFactoryPath} --run ${runIdMatch![1]} --step review --payload '<json matching result_schema>'`));
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
