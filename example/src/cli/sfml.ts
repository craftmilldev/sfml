#!/usr/bin/env node
// The CLI mode of the worked example (issue #13): runs a factory file against the real Claude Agent
// SDK harness. This is what "starts working on this very project" (issue #13's own words) — pointing
// a factory at this repository's own issues.
//
// Usage:
//   sfml lint <factory.sfml>
//   sfml run <factory.sfml> [--param key=value ...] [--state <path>]
//   sfml resume <factory.sfml> (--run <id> | --state <path>) --step <name> [--payload <json>]
//
// A run that ends blocked (awaiting_input or errored, clause 11) is not a CLI failure: it prints the
// observation and always persists state so `resume` can continue the same run later -- `run` mints a
// run id (SPEC §11.3: "minted by the implementation") and, unless --state names a path itself, writes
// to .sfml/runs/<id>.json, printing both to stderr so a caller who forgets --state can still resume.
// This state file is this CLI's own durability choice (SPEC §12.1 leaves storage to the
// implementation); it makes the Runner's `restart()` (engine's in-memory reload) meaningful across
// separate CLI processes.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFactory } from "../engine/parser.js";
import { lintFactory } from "../engine/linter.js";
import { Engine, splitQualified, type BlockedEntry, type Observation, type RunnerEvent } from "../engine/runner.js";
import { deserializeRunState, serializeRunState } from "../engine/state.js";
import { evaluateExpression, type Env } from "../engine/expr.js";
import { isAgentOrHuman, type Factory, type ParallelChild, type JsonSchema, type Step } from "../engine/factory.js";
import { ClaudeAgentSdkHarness } from "../harness/claude-agent-sdk.js";
import { loadPriceTable } from "../harness/pricing.js";
import type { Harness } from "../harness/types.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  sfml lint <factory.sfml>",
      "  sfml run <factory.sfml> [--param key=value ...] [--state <path>]",
      "  sfml resume <factory.sfml> (--run <id> | --state <path>) --step <name> [--payload <json>]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function buildHarnesses(): Map<string, Harness> {
  // dist/cli/sfml.js -> src/harness/claude-pricing.json: read from source, like the harness's own
  // tests do, since the build (tsc) does not copy non-.ts assets into dist/.
  const pricingPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "harness", "claude-pricing.json");
  return new Map<string, Harness>([["claude-agent-sdk", new ClaudeAgentSdkHarness(loadPriceTable(pricingPath))]]);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) usage();
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printObservation(observation: Observation): void {
  process.stdout.write(JSON.stringify(observation, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

/**
 * Prints what the Runner is doing as it happens, to stderr (stdout stays reserved for the final
 * `Observation` JSON): entering a step can be the only sign of life for as long as a real harness
 * invocation takes, and a blocked branch's reason (the harness's or validator's actual message)
 * isn't in `Observation.blocked` at all -- that's SPEC's own shape, just the exception class.
 */
function logEvent(event: RunnerEvent): void {
  const at = new Date().toISOString().slice(11, 19); // HH:MM:SS, local detail doesn't matter here
  switch (event.type) {
    case "step-entered":
      process.stderr.write(`[${at}] → ${event.step}\n`);
      return;
    case "session": {
      // Opaque to the Runner (SPEC §11.7): print whatever the harness put in it. The
      // claude-agent-sdk wrapper's handle has a sessionId, e.g. for `claude --resume <id>`.
      const id = typeof event.handle.sessionId === "string" ? event.handle.sessionId : JSON.stringify(event.handle);
      process.stderr.write(`[${at}]   ${event.step}: session ${id}\n`);
      return;
    }
    case "step-succeeded":
      process.stderr.write(`[${at}] ✓ ${event.step}\n`);
      return;
    case "routed":
      process.stderr.write(`[${at}]   ${event.from} → ${event.to}\n`);
      return;
    case "step-blocked":
      process.stderr.write(`[${at}] ${event.state === "awaiting_input" ? "⏸" : "✗"} ${event.step}: ${event.state}${event.exception ? `: ${event.exception}` : ""}${event.message ? `: ${event.message}` : ""}\n`);
      return;
    case "terminal":
      process.stderr.write(`[${at}] ${event.outcome === "complete" ? "✓" : "✗"} ${event.step}: ${event.outcome}\n`);
      return;
  }
}

/** Resolves a (possibly parallel-child, dotted) step name to its Step/ParallelChild
 * definition, or undefined if the step or its parent doesn't exist / isn't a
 * parallel step for a dotted name. */
function resolveStep(step: string, factory: Factory): Step | ParallelChild | undefined {
  const [parentName, childName] = step.includes(".") ? splitQualified(step) : [step, undefined];
  const parent = factory.steps[parentName];
  if (!parent) return undefined;
  if (childName === undefined) return parent;
  return parent.type === "parallel" ? parent.steps[childName] : undefined;
}

/** Looks up a (possibly parallel-child) step's `HumanStep.instructions` and renders it against the
 * observed state, or returns undefined if there's no instruction or it fails to evaluate (defensive:
 * it already evaluated once for the branch to reach `awaiting_input`). `lastResult` is the blocked
 * step's own `BlockedEntry.lastResult` -- ObservedState doesn't carry it (it's per-step, not global),
 * but `instructions` may reference the bare `last_result` identifier (SPEC §9.2). */
export function renderInstruction(step: string, factory: Factory, state: Observation["state"], lastResult: unknown = null): string | undefined {
  const target = resolveStep(step, factory);
  if (!target || target.type !== "human" || target.instructions === undefined) return undefined;
  try {
    const value = evaluateExpression(target.instructions, { parameters: state.parameters, results: state.results, last_result: lastResult } as unknown as Env);
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** SPEC §11.4's table of what payload each blocked state accepts, as guidance text for a human. */
export function payloadHint(entry: BlockedEntry, resultSchema?: JsonSchema): string {
  const schemaSuffix = resultSchema !== undefined ? `: ${JSON.stringify(resultSchema)}` : "";
  if (entry.state === "awaiting_input") return `an object matching the step's result_schema${schemaSuffix}`;
  switch (entry.exception) {
    case "iteration_limit":
      return "a non-negative integer: additional iterations to grant";
    case "budget_exceeded":
      return `a non-negative USD amount (≤2 decimals): additional ${entry.exceededScope ?? "step"} budget to grant`;
    case "harness_error":
      return `omit to retry on the same session, or an object matching result_schema to supply the result directly${schemaSuffix}`;
    case "schema_violation":
      return `omit to retry as a new agent turn on the same session, or an object matching result_schema to supply the result directly${schemaSuffix}`;
    case "expression_error":
      return `omit to re-attempt the step, or an object matching result_schema (any JSON value for a result step) to supply the result directly${schemaSuffix}`;
    case "routing_error":
      return "omit to re-evaluate routing, or a StepName from this step's own `next` list to route there directly";
    default:
      return "(unknown)";
  }
}

/** The `--payload` example to show in a copy-pasteable `sfml resume` command, or `undefined` when
 * this blocked state accepts a resume with no --payload at all (SPEC §11.4/§11.5) -- in which case
 * the example command should omit the flag rather than imply an empty object is required. When a
 * payload IS required, the example uses an obvious placeholder rather than a valid, copy-pasteable
 * empty object, so it reads as "fill this in" rather than "run me as-is" (issue #38). */
export function payloadExample(entry: BlockedEntry): string | undefined {
  if (entry.state === "awaiting_input") return "<json matching result_schema>";
  if (entry.exception === undefined) throw new Error("errored BlockedEntry missing exception");
  switch (entry.exception) {
    case "iteration_limit":
      return "<integer: additional iterations>";
    case "budget_exceeded":
      return "<USD amount, e.g. 5.00>";
    case "harness_error":
    case "schema_violation":
    case "expression_error":
    case "routing_error":
      return undefined;
    default: {
      const exhaustive: never = entry.exception;
      throw new Error(`unhandled exception class: ${exhaustive}`);
    }
  }
}

/** Note shown under an example command when `payloadExample` returns `undefined` -- i.e. this
 * blocked state accepts a resume with no --payload. routing_error's accepted payload is a bare
 * StepName (not JSON), so it needs its own wording rather than the generic '<json>' placeholder
 * that fits the other optional-payload classes (issue #38 review). */
function payloadOptionalNote(entry: BlockedEntry): string {
  if (entry.exception === "routing_error") {
    return "(--payload is optional here; add --payload '\"stepName\"' to route directly instead of retrying)";
  }
  return "(--payload is optional here; add --payload '<json>' to supply the result/route directly instead of retrying)";
}

/** Human-first report of a non-terminal (blocked) observation, per issue #27: what's wrong, what a
 * human step wants, what payload shape a resume accepts, and the exact command to run next. Written
 * to stderr -- stdout stays reserved for the machine-readable JSON of a terminal observation. */
export function reportBlocked(
  observation: Extract<Observation, { status: "errored" | "awaiting_input" }>,
  factory: Factory,
  factoryPath: string,
  resumeIdArgs: string[],
): void {
  const w = (s: string) => process.stderr.write(s);
  w(`\n${observation.status === "errored" ? "✗ errored" : "⏸ awaiting input"} (${observation.blocked.length} step${observation.blocked.length === 1 ? "" : "s"} blocked)\n\n`);
  for (const entry of observation.blocked) {
    w(`  ${entry.step}\n`);
    const resolved = resolveStep(entry.step, factory);
    const resultSchema = resolved && isAgentOrHuman(resolved) ? resolved.result_schema : undefined;
    if (entry.state === "awaiting_input") {
      const instruction = renderInstruction(entry.step, factory, observation.state, entry.lastResult);
      w(`    instruction: ${instruction ?? "(none declared)"}\n`);
    } else {
      w(`    error: ${entry.exception}${entry.exceededScope ? ` (${entry.exceededScope} budget)` : ""}\n`);
      if (entry.message) w(`    context: ${entry.message}\n`);
    }
    w(`    resume payload: ${payloadHint(entry, resultSchema)}\n`);
    const example = payloadExample(entry);
    const cmd = `sfml resume ${factoryPath} ${resumeIdArgs.join(" ")} --step ${entry.step}`;
    if (example === undefined) {
      w(`    ${cmd}\n`);
      w(`    ${payloadOptionalNote(entry)}\n\n`);
    } else {
      w(`    ${cmd} --payload '${example}'\n\n`);
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || (command !== "lint" && command !== "run" && command !== "resume")) usage();

  const { positional, flags } = parseFlags(rest);
  const factoryPath = positional[0];
  if (!factoryPath) usage();

  const parsed = parseFactory(readFileSync(factoryPath), factoryPath.endsWith(".json") ? "json" : "yaml");
  if (!parsed.ok) {
    process.stderr.write(`parse error: ${parsed.message}\n`);
    process.exit(1);
  }
  // An agent step's prompt_path resolves against the factory's own directory (§7.9).
  const baseDir = dirname(factoryPath);
  const diagnostics = lintFactory(parsed.factory, baseDir);
  if (diagnostics.length) {
    process.stderr.write(`lint failed:\n${diagnostics.map((d) => `  ${d.id}: ${d.message}`).join("\n")}\n`);
    process.exit(1);
  }
  if (command === "lint") return;

  const harnesses = buildHarnesses();
  const defaultStatePath = (runId: string) => join(".sfml", "runs", `${runId}.json`);

  if (command === "run") {
    const params: Record<string, unknown> = {};
    for (const kv of flags.get("param") ?? []) {
      const eq = kv.indexOf("=");
      if (eq < 0) usage();
      const key = kv.slice(0, eq);
      const raw = kv.slice(eq + 1);
      try {
        params[key] = JSON.parse(raw);
      } catch {
        params[key] = raw;
      }
    }
    // SPEC §11.3: a run has an id, "minted by the implementation," its type and encoding
    // unconstrained. This CLI mints one and always persists to it (or to --state, if given), so a run
    // that blocks is never unrecoverable just because the caller forgot --state up front.
    const runId = randomUUID();
    const explicitStatePath = flags.get("state")?.[0];
    const statePath = explicitStatePath ?? defaultStatePath(runId);
    mkdirSync(dirname(statePath), { recursive: true });
    process.stderr.write(`run: ${runId}\nstate: ${statePath}\n`);

    const admission = await Engine.start(parsed.factory, harnesses, params, logEvent, baseDir);
    if (!admission.result.admitted) {
      process.stderr.write(`rejected at admission: ${admission.result.message}\n`);
      process.exit(1);
    }
    writeFileSync(statePath, JSON.stringify(serializeRunState(admission.engine!.getState())));
    const observation = admission.result.observation;
    if (observation.status === "terminal") printObservation(observation);
    // Mirror resume's choice below: if the caller gave --state explicitly, the copy-pasteable
    // command must use it too -- --run reconstructs the default path, which was never written to.
    else reportBlocked(observation, parsed.factory, factoryPath, explicitStatePath ? ["--state", statePath] : ["--run", runId]);
    return;
  }

  // resume
  const runId = flags.get("run")?.[0];
  const statePath = flags.get("state")?.[0] ?? (runId ? defaultStatePath(runId) : undefined);
  if (!statePath || !existsSync(statePath)) {
    process.stderr.write("resume requires --run <id> (as `run` printed it) or --state <path> pointing at a file `run` wrote\n");
    process.exit(2);
  }
  const step = flags.get("step")?.[0];
  if (!step) usage();
  const hasPayload = flags.has("payload");
  let payload: unknown;
  if (hasPayload) {
    try {
      payload = JSON.parse(flags.get("payload")![0]!);
    } catch {
      process.stderr.write("the --payload value must be valid JSON -- did you mean to fill in the placeholder shown in the resume hint?\n");
      process.exit(1);
    }
  }

  const state = deserializeRunState(JSON.parse(readFileSync(statePath, "utf8")));
  const engine = new Engine(parsed.factory, harnesses, state, logEvent, baseDir);
  const result = await engine.resume(step, hasPayload, payload);
  writeFileSync(statePath, JSON.stringify(serializeRunState(engine.getState())));
  if (!result.accepted) {
    process.stderr.write("resume rejected: the payload did not match what this step's blocked state expects (SPEC §11.5)\n");
  }
  if (result.observation.status === "terminal") printObservation(result.observation);
  else reportBlocked(result.observation, parsed.factory, factoryPath, runId ? ["--run", runId] : ["--state", statePath]);
}

// Guard so a test can `import` this module (e.g. to exercise reportBlocked/payloadHint directly)
// without also running the CLI against the test runner's own argv.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
