#!/usr/bin/env node
// The CLI mode of the worked example (issue #13): runs a factory file against the real Claude Agent
// SDK harness. This is what "starts working on this very project" (issue #13's own words) — pointing
// a factory at this repository's own issues.
//
// Usage:
//   sfml lint <factory.sfml>
//   sfml run <factory.sfml> [--param key=value ...] [--state <path>]
//   sfml resume <factory.sfml> --state <path> --step <name> [--payload <json>]
//
// A run that ends blocked (awaiting_input or errored, clause 11) is not a CLI failure: it prints the
// observation and, with --state, persists it so `resume` can continue the same run later. `--state`
// is this CLI's own durability choice (SPEC §12.1 leaves storage to the implementation); a state file
// makes the Runner's `restart()` (engine's in-memory reload) meaningful across separate CLI processes.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFactory } from "../engine/parser.js";
import { lintFactory } from "../engine/linter.js";
import { Engine, type Observation, type RunnerEvent } from "../engine/runner.js";
import { deserializeRunState, serializeRunState } from "../engine/state.js";
import { ClaudeAgentSdkHarness } from "../harness/claude-agent-sdk.js";
import { loadPriceTable } from "../harness/pricing.js";
import type { Harness } from "../harness/types.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  sfml lint <factory.sfml>",
      "  sfml run <factory.sfml> [--param key=value ...] [--state <path>]",
      "  sfml resume <factory.sfml> --state <path> --step <name> [--payload <json>]",
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

/** Prints why a step blocked as it happens, since `Observation.blocked` (SPEC's own shape) carries
 * only the exception class, not the harness's or validator's actual message. */
function logEvent(event: RunnerEvent): void {
  if (event.type === "step-blocked" && event.state === "errored" && event.message) {
    process.stderr.write(`${event.step}: ${event.exception}: ${event.message}\n`);
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

  const statePath = flags.get("state")?.[0];
  const harnesses = buildHarnesses();

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
    const admission = await Engine.start(parsed.factory, harnesses, params, logEvent, baseDir);
    if (!admission.result.admitted) {
      process.stderr.write(`rejected at admission: ${admission.result.message}\n`);
      process.exit(1);
    }
    if (statePath) writeFileSync(statePath, JSON.stringify(serializeRunState(admission.engine!.getState())));
    printObservation(admission.result.observation);
    return;
  }

  // resume
  if (!statePath || !existsSync(statePath)) {
    process.stderr.write("resume requires --state <path> pointing at a file `run` wrote\n");
    process.exit(2);
  }
  const step = flags.get("step")?.[0];
  if (!step) usage();
  const hasPayload = flags.has("payload");
  const payload = hasPayload ? JSON.parse(flags.get("payload")![0]!) : undefined;

  const state = deserializeRunState(JSON.parse(readFileSync(statePath, "utf8")));
  const engine = new Engine(parsed.factory, harnesses, state, logEvent, baseDir);
  const result = await engine.resume(step, hasPayload, payload);
  writeFileSync(statePath, JSON.stringify(serializeRunState(engine.getState())));
  if (!result.accepted) {
    process.stderr.write("resume rejected: the payload did not match what this step's blocked state expects (SPEC §11.5)\n");
  }
  printObservation(result.observation);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
