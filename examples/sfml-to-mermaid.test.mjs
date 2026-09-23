// Exercises sfml-to-mermaid.js against the repository's own schema conformance fixtures
// (tests/schema/), rather than inventing separate ones, so the two suites can't drift apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

// Every file under tests/schema/invalid/ must be rejected. A few are also named here with the
// pattern their rejection message must match, so a change that made parseFactory reject a fixture
// for the *wrong* reason (or stopped invoking the §5.1/§5.4/§5.6/Annex-A path each is meant to
// exercise) would still be caught, without a separate one-off test duplicating the same fixture.
const expectedDiagnostic = {
  "duplicate-step-key.yaml": /unique/i, // §5.6
  "unknown-step-field.yaml": /unevaluated propert/i, // §5.4
  "agent-missing-result-schema.yaml": /data model/i, // Annex A
  "invalid-utf8.yaml": /utf-8/i, // §5.1
};

for (const name of fixturesIn(join(schemaTestsDir, "invalid"))) {
  test(`parseFactory rejects tests/schema/invalid/${name}`, () => {
    assert.throws(() => parseFactory(invalid(name)), expectedDiagnostic[name]);
  });
}

// tests/schema/valid/full.yaml (its own header comment: "Every step type and every optional
// field, in one factory") declares an agent (`plan`), a parallel step (`checks`, with an agent
// child `lint` and a human child `signoff`), a human step (`review`) with two conditional edges
// and one fallback, and two result steps (`shipped`: complete, `give_up`: terminal_failure).
const full = valid("full.yaml");

// tests/sfml-to-mermaid/full.mmd is a golden fixture: the exact, byte-for-byte mermaid full.yaml
// must render to. A change to render()'s output — a new shape, a reordered field, different
// escaping — is expected to change this file too; regenerate it with:
//   node examples/sfml-to-mermaid.js tests/schema/valid/full.yaml > tests/sfml-to-mermaid/full.mmd
// and review the diff before committing it, the same way you'd review any other fixture update.
const fullMermaidFixture = join(here, "..", "tests", "sfml-to-mermaid", "full.mmd");

test("render output for the full spec matches its golden mermaid fixture", () => {
  const out = render(parseFactory(full));
  const expected = readFileSync(fullMermaidFixture, "utf8");
  assert.equal(out, expected);
});

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
