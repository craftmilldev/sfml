// Renders an SFML factory document (SPEC.md clause 6) as a Mermaid flowchart.
// Usage: node sfml-to-mermaid.js <path-to-factory.yaml>
//
// This is a conforming Parser (§4.1.1): it rejects clause 5 violations — non-UTF-8 encoding
// (§5.1), duplicate keys (§5.6) — and validates the document against the Annex A schema
// (sfml.schema.json) before rendering, which covers the rest of clause 5 (unknown fields, §5.4)
// and the structural shape of clause 6 (required fields, per-type fields, `prompt`/`prompt_path`
// exclusivity, and so on). It is not a Linter: it does not perform the graph-level checks of
// clause 8 (reachability, totality of routing, cycle bounds) — those require walking the graph
// and expression ASTs, not just the document's shape.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "sfml.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

// Matches tools/validate-schema.mjs: strictTypes/strictRequired are off because the schema's
// if/oneOf branches use required and properties without restating type: object; validateFormats
// is off because format is an annotation, not an assertion, in the 2020-12 metaschema that
// result_schema and parameters reference.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: false,
  validateFormats: false,
});
const validateFactory = ajv.compile(schema);

function parseFactory(path) {
  const bytes = readFileSync(path);
  let text;
  try {
    // §5.1: a factory document is UTF-8. `fatal: true` rejects a document containing a byte
    // sequence that isn't, rather than silently substituting U+FFFD for it.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("not valid UTF-8 (§5.1)");
  }

  // §5.6: a duplicate key at any level is a parse error, not "last value wins".
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) {
    throw new Error(doc.errors.map((e) => e.message).join("; "));
  }
  const factory = doc.toJS();

  // Annex A: structural shape of clause 6, including unknown-field rejection (§5.4).
  if (!validateFactory(factory)) {
    const detail = validateFactory.errors
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("; ");
    throw new Error(`does not conform to the SFML v0.1 data model (Annex A): ${detail}`);
  }

  return factory;
}

const STEP_CLASS = {
  agent: "agentStep",
  human: "humanStep",
  parallel: "parallelStep",
  result: "resultStep",
};

// Mermaid node text is placed inside a quoted string so punctuation from step names,
// descriptions, and expressions doesn't collide with the shape delimiters; a literal `"`
// still has to be escaped since it would otherwise close the quote early.
const escapeLabel = (s) =>
  String(s)
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "<br/>");

// Mermaid node/subgraph ids may not contain most punctuation; StepName forbids `.` (§5.2) but
// allows nearly everything else, so ids are derived rather than used verbatim.
const sanitizeId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "_");

const shapeFor = (type, label) => {
  switch (type) {
    case "human":
      return `[/"${label}"/]`;
    case "result":
      return `(["${label}"])`;
    case "agent":
    default:
      return `["${label}"]`;
  }
};

const stepLabel = (name, step) => {
  const lines = [escapeLabel(name)];
  if (step.type === "agent") {
    lines.push(escapeLabel(`agent: ${step.harness}`));
  } else if (step.type === "human") {
    lines.push(step.assignee ? escapeLabel(`human: ${step.assignee}`) : "human");
  } else if (step.type === "result") {
    lines.push(escapeLabel(`result: ${step.outcome}`));
  }
  return lines.join("<br/>");
};

function render(factory) {
  const lines = ["flowchart TD"];
  const classAssignments = [];
  const steps = factory.steps ?? {};

  lines.push(`  __start__(("start"))`);
  lines.push(`  __start__ --> ${sanitizeId(factory.start)}`);

  for (const [name, step] of Object.entries(steps)) {
    const id = sanitizeId(name);

    if (step.type === "parallel") {
      lines.push(`  subgraph ${id} ["${escapeLabel(name)} (parallel)"]`);
      lines.push(`    direction TB`);
      for (const [childName, child] of Object.entries(step.steps ?? {})) {
        const childId = `${id}__${sanitizeId(childName)}`;
        lines.push(`    ${childId}${shapeFor(child.type, stepLabel(childName, child))}`);
        classAssignments.push([childId, STEP_CLASS[child.type]]);
      }
      lines.push(`  end`);
    } else {
      lines.push(`  ${id}${shapeFor(step.type, stepLabel(name, step))}`);
    }
    classAssignments.push([id, STEP_CLASS[step.type]]);
  }

  for (const [name, step] of Object.entries(steps)) {
    if (!step.next) continue;
    const id = sanitizeId(name);
    for (const conn of step.next) {
      const targetId = sanitizeId(conn.to);
      if (conn.when) {
        lines.push(`  ${id} -->|"${escapeLabel(conn.when)}"| ${targetId}`);
      } else {
        lines.push(`  ${id} --> ${targetId}`);
      }
    }
  }

  lines.push(`  classDef agentStep fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;`);
  lines.push(`  classDef humanStep fill:#fef3c7,stroke:#b45309,color:#78350f;`);
  lines.push(`  classDef parallelStep fill:#ede9fe,stroke:#6d28d9,color:#4c1d95;`);
  lines.push(`  classDef resultStep fill:#dcfce7,stroke:#15803d,color:#14532d;`);
  for (const [id, cls] of classAssignments) {
    if (cls) lines.push(`  class ${id} ${cls};`);
  }

  return lines.join("\n") + "\n";
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node sfml-to-mermaid.js <path-to-file>");
    process.exit(1);
  }

  let factory;
  try {
    factory = parseFactory(path);
  } catch (e) {
    console.error(`${path}: ${e.message}`);
    process.exit(1);
  }

  process.stdout.write(render(factory));
}

main();
