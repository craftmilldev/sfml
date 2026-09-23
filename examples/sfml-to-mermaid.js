// Renders an SFML factory document (SPEC.md clause 6) as a Mermaid flowchart.
// Usage: node sfml-to-mermaid.js <path-to-factory.yaml>
//
// This is an illustrative example, not a conforming Parser or Linter (§4.1): it does not reject
// unknown fields (§5.4), duplicate keys (§5.6), or graph violations (clause 8). It assumes the
// input already conforms to the data model of clause 6 and renders it for human review.

import { readFileSync } from "node:fs";
import YAML from "yaml";

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
    const text = readFileSync(path, "utf8");
    factory = YAML.parse(text);
  } catch (e) {
    console.error(`Failed to read/parse ${path}: ${e.message}`);
    process.exit(1);
  }

  if (!factory || typeof factory !== "object" || !factory.start || !factory.steps) {
    console.error(`${path} does not look like a factory document: missing 'start' or 'steps'.`);
    process.exit(1);
  }

  process.stdout.write(render(factory));
}

main();
