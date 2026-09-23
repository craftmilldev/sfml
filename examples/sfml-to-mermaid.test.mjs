// Exercises sfml-to-mermaid.js against the repository's own schema conformance fixtures
// (tests/schema/), rather than inventing separate ones, so the two suites can't drift apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFactory, render } from "./sfml-to-mermaid.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "sfml-to-mermaid.js");
const schemaTestsDir = join(here, "..", "tests", "schema");
const valid = (name) => join(schemaTestsDir, "valid", name);
const invalid = (name) => join(schemaTestsDir, "invalid", name);
const fixturesIn = (dir) =>
  readdirSync(dir)
    .filter((f) => /\.(ya?ml|json)$/.test(f))
    .sort();

for (const name of fixturesIn(join(schemaTestsDir, "valid"))) {
  test(`parseFactory accepts tests/schema/valid/${name}`, () => {
    assert.doesNotThrow(() => parseFactory(valid(name)));
  });
}

for (const name of fixturesIn(join(schemaTestsDir, "invalid"))) {
  test(`parseFactory rejects tests/schema/invalid/${name}`, () => {
    assert.throws(() => parseFactory(invalid(name)));
  });
}

test("parseFactory rejects a duplicate step key with a §5.6 diagnostic", () => {
  assert.throws(() => parseFactory(invalid("duplicate-step-key.yaml")), /unique/i);
});

test("parseFactory rejects an unknown field with a §5.4 diagnostic", () => {
  assert.throws(() => parseFactory(invalid("unknown-step-field.yaml")), /unevaluated propert/i);
});

test("parseFactory rejects a step missing a required field with an Annex A diagnostic", () => {
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

// tests/schema/valid/full.yaml (its own header comment: "Every step type and every optional
// field, in one factory") declares an agent (`plan`), a parallel step (`checks`, with an agent
// child `lint` and a human child `signoff`), a human step (`review`) with two conditional edges
// and one fallback, and two result steps (`shipped`: complete, `give_up`: terminal_failure).
const full = valid("full.yaml");

test("render draws each step type of the full spec with its own shape", () => {
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

test("render labels a conditional edge of the full spec with its `when` expression and leaves the fallback edge bare", () => {
  const out = render(parseFactory(full));
  assert.match(out, /review -->\|"last\(results\.review\)\.approved"\| shipped/);
  assert.match(out, /review -->\|"last\(results\.review\)\.abandon"\| give_up/);
  assert.match(out, /review --> implement\n/); // the fallback connection, no `when` label
});

// A self-contained structural check that the mermaid produced for the full spec is well-formed:
// every subgraph opened is closed, every id an edge or `class` line references was actually
// declared as a node or subgraph, and the counts of declared nodes and edges match what full.yaml
// itself declares (one node per step, one more per parallel child, one edge per `next` entry,
// plus the synthetic start edge). This doesn't require a mermaid parser dependency; it holds
// render() to the shape grammar it itself defines in shapeFor()/render().
function analyzeMermaid(text) {
  const declared = new Set();
  const referenced = new Set();
  let openSubgraphs = 0;
  let edgeCount = 0;

  const bodyLines = text.trim().split("\n").slice(1); // drop the "flowchart TD" header
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line === "end") {
      openSubgraphs--;
      continue;
    }
    if (line === "direction TB" || line.startsWith("classDef ")) continue;

    let m;
    if ((m = line.match(/^class\s+(\S+)\s+\S+;$/))) {
      referenced.add(m[1]);
    } else if ((m = line.match(/^subgraph\s+(\S+)\s+\[".*"\]$/))) {
      declared.add(m[1]);
      openSubgraphs++;
    } else if ((m = line.match(/^(\S+)\s+-->(?:\|"[^"]*"\|)?\s+(\S+)$/))) {
      referenced.add(m[1]);
      referenced.add(m[2]);
      edgeCount++;
    } else if ((m = line.match(/^([A-Za-z0-9_]+)(?:\[\/".*"\/\]|\["[^"]*"\]|\(\["[^"]*"\]\)|\(\(".*"\)\))$/))) {
      declared.add(m[1]);
    } else {
      throw new Error(`line doesn't match any known-good mermaid pattern: ${JSON.stringify(line)}`);
    }
  }

  return { declared, referenced, openSubgraphs, edgeCount };
}

test("the full spec's mermaid is well-formed: subgraphs close and every reference resolves", () => {
  const out = render(parseFactory(full));
  const { declared, referenced, openSubgraphs } = analyzeMermaid(out);

  assert.equal(openSubgraphs, 0, "every subgraph must be closed");
  for (const id of referenced) {
    assert.ok(declared.has(id), `"${id}" is referenced by an edge or class but never declared as a node`);
  }
});

test("the full spec's mermaid declares exactly one node per step (plus parallel children) and one edge per connection", () => {
  const factory = parseFactory(full);
  const out = render(factory);
  const { declared, edgeCount } = analyzeMermaid(out);

  let expectedNodes = 1; // the synthetic __start__ node
  let expectedEdges = 1; // the synthetic __start__ --> <start step> edge
  for (const step of Object.values(factory.steps)) {
    expectedNodes += 1;
    if (step.type === "parallel") expectedNodes += Object.keys(step.steps).length;
    if (step.next) expectedEdges += step.next.length;
  }

  assert.equal(declared.size, expectedNodes);
  assert.equal(edgeCount, expectedEdges);
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
