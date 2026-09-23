// Exercises sfml-to-mermaid.js against the repository's own schema conformance fixtures
// (tests/schema/), rather than inventing separate ones, so the two suites can't drift apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFactory, render } from "./sfml-to-mermaid.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "sfml-to-mermaid.js");
const valid = (name) => join(here, "..", "tests", "schema", "valid", name);
const invalid = (name) => join(here, "..", "tests", "schema", "invalid", name);

// tests/schema/valid/full.yaml (§6.4 header comment: "Every step type and every optional field,
// in one factory") declares an agent (`plan`), a parallel step (`checks`, with an agent child
// `lint` and a human child `signoff`), a human step (`review`) with two conditional edges and one
// fallback, and two result steps (`shipped`: complete, `give_up`: terminal_failure).
const full = valid("full.yaml");

test("parseFactory accepts a valid factory and returns the parsed data model", () => {
  const factory = parseFactory(full);
  assert.equal(factory.sfml, "v0.1");
  assert.equal(factory.start, "plan");
  assert.equal(factory.steps.checks.type, "parallel");
});

test("parseFactory rejects a duplicate step key (§5.6)", () => {
  assert.throws(() => parseFactory(invalid("duplicate-step-key.yaml")), /unique/i);
});

test("parseFactory rejects an unknown field (§5.4)", () => {
  assert.throws(() => parseFactory(invalid("unknown-step-field.yaml")), /unevaluated propert/i);
});

test("parseFactory rejects a step missing a required field (Annex A)", () => {
  assert.throws(() => parseFactory(invalid("agent-missing-result-schema.yaml")), /data model/i);
});

test("parseFactory rejects a document that isn't valid UTF-8 (§5.1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-to-mermaid-test-"));
  const path = join(dir, "bad-utf8.yaml");
  try {
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from('sfml: "v0.1"\nstart: a\nsteps:\n  a:\n    type: result\n    outcome: comp'),
        Buffer.from([0xff]),
        Buffer.from("lete\n"),
      ]),
    );
    assert.throws(() => parseFactory(path), /utf-8/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render draws each step type with its own shape", () => {
  const out = render(parseFactory(full));
  assert.match(out, /^flowchart TD/);
  assert.match(out, /plan\["plan<br\/>agent: claude@1\.2"\]/); // agent: rectangle
  assert.match(out, /review\[\/"review<br\/>human: eng-reviewers"\/\]/); // human: parallelogram
  assert.match(out, /shipped\(\["shipped<br\/>result: complete"\]\)/); // result: stadium
  assert.match(out, /give_up\(\["give_up<br\/>result: terminal_failure"\]\)/);
  assert.match(out, /subgraph checks \["checks \(parallel\)"\]/); // parallel: subgraph
  assert.match(out, /checks__lint\["lint<br\/>agent: claude"\]/); // parallel agent child
  assert.match(out, /checks__signoff\[\/"signoff<br\/>human: security"\/\]/); // parallel human child
});

test("render labels a conditional edge with its `when` expression and leaves the fallback edge bare", () => {
  const out = render(parseFactory(full));
  assert.match(out, /review -->\|"last\(results\.review\)\.approved"\| shipped/);
  assert.match(out, /review -->\|"last\(results\.review\)\.abandon"\| give_up/);
  assert.match(out, /review --> implement\n/); // the fallback connection, no `when` label
});

test("CLI prints usage and exits non-zero with no argument", () => {
  assert.throws(() => execFileSync("node", [script], { encoding: "utf8" }), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /Usage: node sfml-to-mermaid\.js/);
    return true;
  });
});

test("CLI writes mermaid source to stdout for a valid file", () => {
  const stdout = execFileSync("node", [script, full], { encoding: "utf8" });
  assert.match(stdout, /^flowchart TD/);
});

test("CLI exits non-zero and writes nothing to stdout for an invalid file", () => {
  assert.throws(() => execFileSync("node", [script, invalid("unknown-step-field.yaml")], { encoding: "utf8" }), (err) => {
    assert.equal(err.status, 1);
    assert.equal(err.stdout, "");
    assert.match(err.stderr, /does not conform/);
    return true;
  });
});
