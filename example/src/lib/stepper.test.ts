import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadStepper } from "./stepper.js";
import { loadPriceTable } from "../harness/pricing.js";
import type { Row } from "../harness/mock-backend.js";

const conformanceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance");
const prices = loadPriceTable(join(conformanceRoot, "models.json"));
const caseDir = join(conformanceRoot, "runner", "linear-prompt-rendering");

test("Stepper: start() records a timeline frame per Engine step and the run completes", async () => {
  const factory = readFileSync(join(caseDir, "factory.sfml.yaml"));
  const transcript = YAML.parse(readFileSync(join(caseDir, "transcript.yaml"), "utf8")) as Row[];

  const loaded = loadStepper({ factory, transcript, prices });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const { admitted, frame } = await loaded.stepper.start({ issue: "add a --verbose flag" });
  assert.equal(admitted, true);
  assert.equal(frame!.observation.status, "terminal");
  assert.deepEqual((frame!.observation as { value: unknown }).value, { branch: "feat/verbose" });

  // A step-entered event fired for every step on the path, in order.
  const entered = frame!.events.filter((e) => e.type === "step-entered").map((e) => e.step);
  assert.deepEqual(entered, ["plan", "implement", "done"]);
  assert.equal(loaded.stepper.timeline.length, 1);
});

test("Stepper: reports a lint failure instead of throwing", () => {
  const factory = readFileSync(join(conformanceRoot, "lint", "non-total-routing", "factory.sfml.yaml"));
  const loaded = loadStepper({ factory, prices });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.stage, "lint");
  assert.deepEqual(loaded.diagnostics!.map((d) => d.id), ["non-total-routing"]);
});

test("Stepper: reports a parse failure instead of throwing", () => {
  const factory = readFileSync(join(conformanceRoot, "parser", "duplicate-step-key", "factory.sfml.yaml"));
  const loaded = loadStepper({ factory, prices });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.stage, "parse");
});

test("Stepper: restart() keeps the mock's place, matching the conformance case's own restart action", async () => {
  const dir = join(conformanceRoot, "runner", "non-retryable-resumed-after-restart");
  const factory = readFileSync(join(dir, "factory.sfml.yaml"));
  const transcript = YAML.parse(readFileSync(join(dir, "transcript.yaml"), "utf8")) as Row[];
  const loaded = loadStepper({ factory, transcript, prices });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const { stepper } = loaded;

  const started = await stepper.start();
  assert.equal(started.frame!.observation.status, "errored");

  const restarted = stepper.restart();
  assert.equal(restarted.observation.status, "errored");

  const resumed = await stepper.resume("work", false);
  assert.equal(resumed.accepted, true);
  assert.equal(resumed.frame.observation.status, "terminal");
  assert.equal(stepper.timeline.length, 3);
});
