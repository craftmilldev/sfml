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
const sample = join(here, "sample-factory.yaml");
const invalid = (name) => join(here, "..", "tests", "sfml-to-mermaid", "invalid", name);

test("parseFactory accepts a valid factory and returns the parsed data model", () => {
  const factory = parseFactory(sample);
  assert.equal(factory.sfml, "v0.1");
  assert.equal(factory.start, "plan");
  assert.equal(factory.steps.checks.type, "parallel");
});

test("parseFactory rejects a duplicate step key (§5.6)", () => {
  assert.throws(() => parseFactory(invalid("duplicate-key.yaml")), /unique/i);
});

test("parseFactory rejects an unknown field (§5.4)", () => {
  assert.throws(() => parseFactory(invalid("unknown-field.yaml")), /additional propert/i);
});

test("parseFactory rejects a step missing a required field (Annex A)", () => {
  assert.throws(() => parseFactory(invalid("missing-required-field.yaml")), /data model/i);
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
  const out = render(parseFactory(sample));
  assert.match(out, /^flowchart TD/);
  assert.match(out, /plan\["plan<br\/>agent: claude-code@1"\]/); // agent: rectangle
  assert.match(out, /review\[\/"review<br\/>human: eng-lead"\/\]/); // human: parallelogram
  assert.match(out, /done\(\["done<br\/>result: complete"\]\)/); // result: stadium
  assert.match(out, /subgraph checks \["checks \(parallel\)"\]/); // parallel: subgraph
  assert.match(out, /checks__lint\["lint<br\/>agent: claude-code@1"\]/); // parallel child
});

test("render labels a conditional edge with its `when` expression and leaves the fallback edge bare", () => {
  const out = render(parseFactory(sample));
  assert.match(out, /review -->\|"last\(results\.review\)\.approved"\| done/);
  assert.match(out, /review --> failed\n/);
});

test("CLI prints usage and exits non-zero with no argument", () => {
  assert.throws(() => execFileSync("node", [script], { encoding: "utf8" }), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /Usage: node sfml-to-mermaid\.js/);
    return true;
  });
});

test("CLI writes mermaid source to stdout for a valid file", () => {
  const stdout = execFileSync("node", [script, sample], { encoding: "utf8" });
  assert.match(stdout, /^flowchart TD/);
});

test("CLI exits non-zero and writes nothing to stdout for an invalid file", () => {
  assert.throws(() => execFileSync("node", [script, invalid("unknown-field.yaml")], { encoding: "utf8" }), (err) => {
    assert.equal(err.status, 1);
    assert.equal(err.stdout, "");
    assert.match(err.stderr, /does not conform/);
    return true;
  });
});
