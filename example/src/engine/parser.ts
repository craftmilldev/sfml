// Parser conformance class (SPEC clause 5, §4.1.1): surface syntax and encoding only. Does not
// evaluate expressions and does not perform clause 8 checks (that is linter.ts).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Factory } from "./factory.js";

export type ParseResult = { ok: true; factory: Factory } | { ok: false; message: string };

// sfml.schema.json (Annex A) lives at the repository root, the single source of truth SPEC.md
// points to (§4.4); loaded at runtime, at a path relative to dist/, rather than duplicated here.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schema = JSON.parse(readFileSync(join(repoRoot, "sfml.schema.json"), "utf8")) as Record<string, unknown>;

// validateFormats: false silences ajv's "unknown format ... ignored" warning for the 2020-12
// metaschema's own uri-reference format, which result_schema and parameters both $ref transitively
// (sfml.schema.json's JSONSchema type). In 2020-12, format is an annotation unless a vocabulary
// asserts it, so this is not a validation gap, just quieting a log line every compile would print.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateSchema = ajv.compile(schema);

/** Parses a factory document from raw bytes. `format` selects YAML or JSON surface syntax (§5.1). */
export function parseFactory(bytes: Buffer, format: "yaml" | "json" = "yaml"): ParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: "document is not valid utf-8 (§5.1)" };
  }

  // Every JSON document is valid YAML (§5.1), so both surface syntaxes go through the same parser:
  // that's what makes §5.6 (duplicate keys are a parse error, not "last value wins") apply uniformly
  // to a JSON document too, since JSON.parse on its own would silently keep the last value.
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) {
    const dup = doc.errors.find((e) => /duplicate key|key must be unique/i.test(e.message));
    const message = dup
      ? `mapping keys must be unique (§5.6): ${dup.message}`
      : `document is not valid ${format}: ${doc.errors.map((e) => e.message).join("; ")}`;
    return { ok: false, message };
  }
  const value: unknown = doc.toJS();

  if (!validateSchema(value)) {
    const message = (validateSchema.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return { ok: false, message: `document does not conform to the SFML v0.1 schema: ${message}` };
  }

  const extra = checkDecimalUsdPlaces(value as Factory);
  if (extra) return { ok: false, message: extra };

  return { ok: true, factory: value as Factory };
}

export function parseFactoryFile(path: string): ParseResult {
  const format = path.endsWith(".json") ? "json" : "yaml";
  return parseFactory(readFileSync(path), format);
}

/**
 * §6.1: a Decimal USD has at most two decimal places. `sfml.schema.json`'s own comment explains why
 * this can't be a schema rule with common validators (binary-float multipleOf false negatives), so
 * it is checked here instead, walking every `budget` field the data model defines.
 */
function checkDecimalUsdPlaces(factory: Factory): string | undefined {
  const bad: string[] = [];
  const check = (label: string, value: number | undefined) => {
    if (value === undefined) return;
    // Two decimal places means value * 100 is (very nearly) an integer.
    if (Math.abs(Math.round(value * 100) - value * 100) > 1e-9) bad.push(label);
  };
  check("budget", factory.budget);
  for (const [name, step] of Object.entries(factory.steps)) {
    if (step.type === "agent") check(`steps.${name}.budget`, step.budget);
    if (step.type === "parallel") {
      for (const [child, childStep] of Object.entries(step.steps)) {
        if (childStep.type === "agent") check(`steps.${name}.steps.${child}.budget`, childStep.budget);
      }
    }
  }
  return bad.length ? `budget has more than two decimal places (§6.1, §9.7): ${bad.join(", ")}` : undefined;
}
