// Exercises sfml-to-mermaid.mjs against the repository's own conformance suite parser/ fixtures
// (conformance/parser/), rather than inventing separate ones, so the two suites can't drift apart.
// Each fixture's case.yaml states whether it must be accepted or rejected, and a rejected one may
// also carry expect.message: a regex the rejection's message must match, so a change that made
// parseFactory reject a fixture for the *wrong* reason (or stopped invoking the path it's meant to
// exercise) would still be caught — without hardcoding that knowledge here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { parseFactory, render } from "./sfml-to-mermaid.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "sfml-to-mermaid.mjs");
const parserDir = join(here, "..", "conformance", "parser");

const parserTests = readdirSync(parserDir)
  .sort()
  .map((name) => {
    const dir = join(parserDir, name);
    const testCase = YAML.parse(readFileSync(join(dir, "case.yaml"), "utf8"));
    const factory = existsSync(join(dir, "factory.sfml")) ? join(dir, "factory.sfml") : join(dir, "factory.sfml.json");
    return { name, factory, ...testCase };
  });

for (const { name, factory, expect } of parserTests.filter((t) => t.expect.parse === "accept")) {
  test(`parseFactory accepts conformance/parser/${name}`, () => {
    assert.doesNotThrow(() => parseFactory(factory));
  });
}

for (const { name, factory, expect } of parserTests.filter((t) => t.expect.parse === "reject")) {
  test(`parseFactory rejects conformance/parser/${name}`, () => {
    assert.throws(() => parseFactory(factory), expect.message ? new RegExp(expect.message, "i") : undefined);
  });
}

// conformance/parser/full/case.yaml ("Every step type and every optional field, in one factory")
// declares an agent (`plan`), a parallel step (`checks`, with an agent child `lint` and a human
// child `signoff`), a human step (`review`) with two conditional edges and one fallback, and two
// result steps (`shipped`: complete, `give_up`: terminal_failure).
const full = join(parserDir, "full", "factory.sfml");

// Committed renderings, each checked byte-for-byte against a fresh render of its factory.
// tools/sfml-to-mermaid.test.full.mmd is render()'s golden fixture, kept out of conformance/
// since that suite holds only normative files; .craftmill/factory.mmd is the repo's own factory,
// kept fresh so it can be read on GitHub. After changing render() or either factory, regenerate both with
// `npm run render:mermaid` and review the diff.
const repoRoot = join(here, "..");
const renderings = [
  ["conformance/parser/full/factory.sfml", "tools/sfml-to-mermaid.test.full.mmd"],
  [".craftmill/factory.sfml", ".craftmill/factory.mmd"],
];

for (const [sfml, mmd] of renderings) {
  test(`${mmd} is up to date`, () => {
    const out = render(parseFactory(join(repoRoot, sfml)));
    const expected = readFileSync(join(repoRoot, mmd), "utf8");
    assert.equal(out, expected, `${mmd} is stale; run \`npm run render:mermaid\``);
  });
}

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
    assert.match(err.stderr, /Usage: node tools\/sfml-to-mermaid\.mjs/);
    return true;
  });
});

test("CLI writes mermaid source to stdout for a valid file", () => {
  const stdout = execFileSync("node", [script, full], { encoding: "utf8" });
  assert.match(stdout, /^flowchart TD/);
});

test("CLI --out writes the rendering to the given file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-to-mermaid-"));
  try {
    const out = join(dir, "full.mmd");
    const stdout = execFileSync("node", [script, full, "--out", out], { encoding: "utf8" });
    assert.equal(stdout, "");
    assert.equal(readFileSync(out, "utf8"), render(parseFactory(full)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --out leaves an existing file untouched when the factory is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "sfml-to-mermaid-"));
  try {
    const out = join(dir, "full.mmd");
    writeFileSync(out, "previous\n");
    const invalid = join(parserDir, "unknown-step-field", "factory.sfml");
    assert.throws(() => execFileSync("node", [script, invalid, "--out", out], { encoding: "utf8" }), (err) => err.status === 1);
    assert.equal(readFileSync(out, "utf8"), "previous\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exits non-zero and writes nothing to stdout for an invalid file", () => {
  const unknownStepField = join(parserDir, "unknown-step-field", "factory.sfml");
  assert.throws(() => execFileSync("node", [script, unknownStepField], { encoding: "utf8" }), (err) => {
    assert.equal(err.status, 1);
    assert.equal(err.stdout, "");
    assert.match(err.stderr, /does not conform/);
    return true;
  });
});
