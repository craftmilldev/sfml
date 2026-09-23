// This project's own factory (.craftmill/factory.sfml) is a real-world SFML document, not a
// conformance fixture. Keep it parsing and linting clean as the engine evolves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFactory } from "./parser.js";
import { lintFactory } from "./linter.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const factoryPath = join(repoRoot, ".craftmill", "factory.sfml");

test(".craftmill/factory.sfml parses as a valid SFML v0.1 document", () => {
  const parsed = parseFactory(readFileSync(factoryPath), "yaml");
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
});

test(".craftmill/factory.sfml lints clean (no §8.7 diagnostics)", () => {
  const parsed = parseFactory(readFileSync(factoryPath), "yaml");
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const diagnostics = lintFactory(parsed.factory);
  assert.deepEqual(
    diagnostics.map((d) => d.id),
    [],
  );
});
