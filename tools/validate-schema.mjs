// Checks sfml.schema.json against its fixtures: every document under tests/schema/valid/ must
// validate, and every document under tests/schema/invalid/ must not. Exits non-zero on any miss.
// Usage: node tools/validate-schema.mjs [factory.yaml ...] validates the named files instead.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "sfml.schema.json"), "utf8"));

// strict catches unknown keywords (typos) in the schema itself; strictTypes and strictRequired
// are off because the schema's if/oneOf branches use required and properties without
// restating type: object or the properties they require. validateFormats: false is for the
// 2020-12 metaschema, which result_schema and parameters reference; in 2020-12, format is an
// annotation unless a vocabulary asserts it.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: false,
  validateFormats: false,
});
const validate = ajv.compile(schema);

// §5.1: a factory document is UTF-8. `fatal: true` rejects a document containing a byte sequence
// that isn't, rather than `readFileSync(p, "utf8")`'s silent substitution of U+FFFD for it.
// Duplicate keys (§5.6) are a parse error, so they never reach the schema.
const parse = (p) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(p));
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join("; "));
  return doc.toJS();
};

const check = (p) => {
  try {
    const value = parse(p);
    return validate(value) ? [] : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
  } catch (e) {
    return [`unparseable: ${e.message}`];
  }
};

const args = process.argv.slice(2);
let failed = 0;

if (args.length) {
  for (const p of args) {
    const errors = check(p);
    if (errors.length) failed++;
    console.log(`${errors.length ? "FAIL" : "ok  "} ${p}`);
    for (const e of errors) console.log(`       ${e}`);
  }
} else {
  const dir = join(root, "tests", "schema");
  for (const expect of ["valid", "invalid"]) {
    for (const f of readdirSync(join(dir, expect)).filter((f) => /\.(ya?ml|json)$/.test(f)).sort()) {
      const p = join(dir, expect, f);
      const errors = check(p);
      const ok = expect === "valid" ? errors.length === 0 : errors.length > 0;
      if (!ok) failed++;
      console.log(`${ok ? "ok  " : "FAIL"} ${relative(root, p)}`);
      if (!ok && expect === "valid") for (const e of errors) console.log(`       ${e}`);
      if (!ok && expect === "invalid") console.log("       expected the schema to reject this document");
    }
  }
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
