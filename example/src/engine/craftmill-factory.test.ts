// This project's own factory (.craftmill/factory.sfml) is a real-world SFML document, not a
// conformance fixture. Keep it parsing and linting clean as the engine evolves -- via the CLI's own
// `sfml lint` (exit 0 on success, exit 1 with diagnostics on stderr otherwise), so this test exercises
// the same path a person running the CLI would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const factoryPath = join(repoRoot, ".craftmill", "factory.sfml");
const cliPath = join(here, "..", "cli", "sfml.js");

test(".craftmill/factory.sfml lints clean via `sfml lint`", () => {
  const result = spawnSync(process.execPath, [cliPath, "lint", factoryPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
