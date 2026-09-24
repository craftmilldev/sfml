// Runs the conformance suite (conformance/README.md) against this example's Parser, Linter, and
// Runner. This is what makes the example an Annex B conformance case, not just a worked example
// (SPEC Annex C note: "It runs on the mock harness of Annex B").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { parseFactory } from "./parser.js";
import { lintFactory } from "./linter.js";
import { Engine, type Observation } from "./runner.js";
import type { Factory } from "./factory.js";
import { MockBackend, type Row } from "../harness/mock-backend.js";
import { MockHarness } from "../harness/mock.js";
import { loadPriceTable } from "../harness/pricing.js";
import type { Harness } from "../harness/types.js";

const conformanceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance");
const readYaml = (p: string): unknown => YAML.parse(readFileSync(p, "utf8"));
const prices = loadPriceTable(join(conformanceRoot, "models.json"));

// --- parser/ -------------------------------------------------------------------------------------

for (const name of listDirs(join(conformanceRoot, "parser"))) {
  test(`parser/${name}`, () => {
    const dir = join(conformanceRoot, "parser", name);
    const testCase = readYaml(join(dir, "case.yaml")) as { expect: { parse: "accept" | "reject"; message?: string } };
    const factoryFile = ["factory.sfml", "factory.sfml.json"].find((f) => existsSync(join(dir, f)));
    assert.ok(factoryFile, `${name}: no factory.sfml.* fixture`);
    const bytes = readFileSync(join(dir, factoryFile!));
    const result = parseFactory(bytes, factoryFile!.endsWith(".json") ? "json" : "yaml");

    if (testCase.expect.parse === "accept") {
      assert.equal(result.ok, true, result.ok ? "" : result.message);
    } else {
      assert.equal(result.ok, false, "expected the document to be rejected");
      if (!result.ok && testCase.expect.message) {
        assert.match(result.message, new RegExp(testCase.expect.message, "i"));
      }
    }
  });
}

// --- lint/ -----------------------------------------------------------------------------------------

for (const name of listDirs(join(conformanceRoot, "lint"))) {
  test(`lint/${name}`, () => {
    const dir = join(conformanceRoot, "lint", name);
    const testCase = readYaml(join(dir, "case.yaml")) as { expect: { diagnostics: string[] } };
    const bytes = readFileSync(join(dir, "factory.sfml"));
    const parsed = parseFactory(bytes, "yaml");
    assert.ok(parsed.ok, "lint fixtures parse cleanly");
    if (!parsed.ok) return;
    const diagnostics = new Set(lintFactory(parsed.factory, dir).map((d) => d.id));
    assert.deepEqual([...diagnostics].sort(), [...new Set(testCase.expect.diagnostics)].sort());
  });
}

// --- runner/ ---------------------------------------------------------------------------------------

type Action =
  | { start: { parameters?: Record<string, unknown> }; expect?: unknown }
  | { resume: { step: string; payload?: unknown }; expect?: unknown }
  | { restart: Record<string, never>; expect?: unknown };
type RunnerCase = { actions: Action[]; expect: unknown };

for (const name of listDirs(join(conformanceRoot, "runner"))) {
  test(`runner/${name}`, async () => {
    const dir = join(conformanceRoot, "runner", name);
    const testCase = readYaml(join(dir, "case.yaml")) as RunnerCase;
    const factoryBytes = readFileSync(join(dir, "factory.sfml"));
    const parsed = parseFactory(factoryBytes, "yaml");
    assert.ok(parsed.ok, "runner fixtures parse cleanly");
    if (!parsed.ok) return;
    const factory: Factory = parsed.factory;

    const tmp = mkdtempSync(join(tmpdir(), "sfml-conformance-"));
    const statePath = join(tmp, "backend-state.json");
    const transcriptPath = join(dir, "transcript.yaml");
    const rows: Row[] = existsAsFile(transcriptPath) ? (readYaml(transcriptPath) as Row[]) : [];
    let backend = new MockBackend(rows, statePath);
    const harnesses = (): Map<string, Harness> => new Map<string, Harness>([["mock", new MockHarness(backend, prices)]]);

    let engine: Engine | undefined;
    try {
      for (let i = 0; i < testCase.actions.length; i++) {
        const action = testCase.actions[i]!;
        let observation: Observation;
        let admitted: boolean | undefined;
        let accepted: boolean | undefined;

        if ("start" in action) {
          const admission = await Engine.start(factory, harnesses(), action.start.parameters ?? {}, undefined, dir);
          admitted = admission.result.admitted;
          if (!admission.result.admitted) {
            if (action.expect) assertExpect(action.expect, { admitted: false });
            assertExpect(testCase.expect, { admitted: false });
            return;
          }
          engine = admission.engine!;
          observation = admission.result.observation;
        } else if ("resume" in action) {
          const hasPayload = Object.prototype.hasOwnProperty.call(action.resume, "payload");
          const result = await engine!.resume(action.resume.step, hasPayload, action.resume.payload);
          accepted = result.accepted;
          observation = result.observation;
        } else {
          backend = rows.length || existsAsFile(transcriptPath) ? MockBackend.fromFiles({ transcript: transcriptPath, state: statePath }) : new MockBackend(rows, statePath);
          engine = engine!.restart(new Map<string, Harness>([["mock", new MockHarness(backend, prices)]]));
          observation = engine.observe();
        }

        const expected = action.expect as Record<string, unknown> | undefined;
        if (expected) assertExpect(expected, { ...observation, ...(admitted !== undefined && { admitted }), ...(accepted !== undefined && { accepted }) });
        if (i === testCase.actions.length - 1) assertExpect(testCase.expect, observation);
      }

      const faults = backend.verify();
      assert.deepEqual(faults, [], `mock backend faults: ${faults.join("; ")}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// --- helpers -----------------------------------------------------------------------------------

function listDirs(root: string): string[] {
  if (!existsAsDir(root)) return [];
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

function existsAsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsAsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Asserts every field present in `expected` matches `actual` (a partial-match, per README §3.1-3.2). */
function assertExpect(expected: unknown, actual: unknown): void {
  if (expected === null || typeof expected !== "object") {
    assert.deepEqual(actual, expected);
    return;
  }
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    const actualValue = (actual as Record<string, unknown>)[key];
    if (key === "blocked") {
      assert.deepEqual(sortBlocked(actualValue), sortBlocked(value));
    } else if (value !== null && typeof value === "object") {
      assert.deepEqual(actualValue, value);
    } else {
      assert.equal(actualValue, value);
    }
  }
}

function sortBlocked(value: unknown): unknown {
  return Array.isArray(value) ? [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value;
}
