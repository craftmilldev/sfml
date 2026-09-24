// Validates every test in the conformance suite against conformance/schema/ and the rules of
// conformance/README.md §4 that a schema cannot express. Exits non-zero on any error. Does not
// run factories.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "conformance");
const errors = [];
const fail = (where, msg) => errors.push(`${relative(root, where)}: ${msg}`);

// --- loading ---------------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readYaml = (p) => {
  const doc = YAML.parseDocument(readFileSync(p, "utf8"), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join("; "));
  return doc.toJS();
};
const load = (p) => {
  try {
    return p.endsWith(".json") ? readJson(p) : readYaml(p);
  } catch (e) {
    fail(p, `unparseable: ${e.message}`);
    return undefined;
  }
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const f of readdirSync(join(root, "schema"))) ajv.addSchema(readJson(join(root, "schema", f)), f);
const check = (schema, value, where) => {
  const validate = ajv.getSchema(schema);
  if (validate(value)) return true;
  for (const e of validate.errors) fail(where, `${e.instancePath || "/"} ${e.message}`);
  return false;
};

const models = readJson(join(root, "models.json"));
check("models.schema.json", models, join(root, "models.json"));

// --- per-folder rules --------------------------------------------------------------------------

// Prompt templates a factory names with prompt_path live under this directory (README §1).
const PROMPTS = "prompts";

/** `required` must all be present, and nothing outside `allowed` may be. */
function checkFiles(dir, required, allowed) {
  const present = readdirSync(dir);
  for (const f of required) if (!present.includes(f)) fail(dir, `missing ${f}`);
  for (const f of present) if (!allowed.includes(f)) fail(dir, `unexpected file ${f}`);
  return present;
}

function checkParser(dir) {
  const present = checkFiles(dir, ["case.yaml"], ["case.yaml", "factory.sfml", "factory.sfml.json"]);
  if (present.filter((f) => f.startsWith("factory.")).length !== 1) fail(dir, "needs exactly one of factory.sfml or factory.sfml.json");
  // The document is deliberately not parsed: a parser test may hold one that must be rejected.
}

function checkLint(dir, testCase) {
  checkFiles(dir, ["case.yaml", "factory.sfml"], ["case.yaml", "factory.sfml", PROMPTS]);
  if (existsSync(join(dir, "factory.sfml"))) load(join(dir, "factory.sfml"));
  const { diagnostics, may_also_report: optional = [] } = testCase.expect;
  for (const id of optional) if (diagnostics.includes(id)) fail(dir, `'${id}' is in both diagnostics and may_also_report`);
}

/** Yields [qualifiedName, step] for every step, parallel children included. */
function* walkSteps(factory) {
  for (const [name, step] of Object.entries(factory?.steps ?? {})) {
    yield [name, step];
    if (step?.type === "parallel") for (const [child, s] of Object.entries(step.steps ?? {})) yield [`${name}.${child}`, s];
  }
}

function checkRunner(dir, testCase) {
  const factoryPath = join(dir, "factory.sfml");
  const factory = existsSync(factoryPath) ? load(factoryPath) : undefined;

  // Agents: mock steps name exactly { agent }, and no agent serves two steps (mock-harness.md §2).
  const agents = new Map();
  for (const [name, step] of walkSteps(factory)) {
    if (step?.type !== "agent" || step.harness !== "mock") continue;
    const config = step.harness_config ?? {};
    if (typeof config.agent !== "string" || Object.keys(config).length !== 1) {
      fail(factoryPath, `${name}: harness_config must be exactly { agent: <name> } for harness 'mock'`);
      continue;
    }
    if (agents.has(config.agent)) fail(factoryPath, `agent '${config.agent}' serves both ${agents.get(config.agent)} and ${name}`);
    agents.set(config.agent, name);
  }

  const files = ["case.yaml", "factory.sfml", ...(agents.size > 0 && testCase.expect?.admitted !== false ? ["transcript.yaml"] : [])];
  checkFiles(dir, files, [...files, PROMPTS]);
  const transcriptPath = join(dir, "transcript.yaml");
  if (files.includes("transcript.yaml") && existsSync(transcriptPath)) checkTranscript(transcriptPath, agents);

  // Actions (README §3.1–§3.2).
  const { actions } = testCase;
  actions.forEach((action, i) => {
    if ("start" in action && i !== 0) fail(dir, `actions[${i}]: start must be the first action, and only once`);
  });
  if (!("start" in actions[0])) fail(dir, "actions[0] must be start");
  if (actions.at(-1).expect) fail(dir, "the last action must not carry expect; the top-level expect states the end");
  if (testCase.expect?.admitted === false && actions.length !== 1) fail(dir, "a run rejected at admission takes no further actions");
}

function checkTranscript(path, agents) {
  const rows = load(path);
  if (rows === undefined || !check("transcript.schema.json", rows, path)) return;

  // label -> { open, stoppable }. A reply that combines usage with a terminal outcome leaves the
  // stream stoppable: a following close means the Runner must stop after the usage, before the rest.
  const sessions = new Map();
  rows.forEach((row, i) => {
    const at = `row ${i}`;
    if (row.send) {
      const { session, agent, model } = row.send;
      const known = sessions.get(session);
      if (!known) {
        if (!agent || !model) return fail(path, `${at}: the first send of '${session}' needs agent and model`);
        if (!agents.has(agent)) fail(path, `${at}: agent '${agent}' is not named by any mock step in factory.sfml`);
        if (!(model in models.models)) fail(path, `${at}: model '${model}' is not in models.json`);
        sessions.set(session, { open: true, stoppable: false });
      } else {
        if (agent || model) fail(path, `${at}: only the first send of '${session}' names agent and model`);
        if (known.open) fail(path, `${at}: '${session}' already has an open stream`);
        known.open = true;
        known.stoppable = false;
      }
    } else if (row.reply) {
      const { session, usage } = row.reply;
      const known = sessions.get(session);
      if (!known?.open) return fail(path, `${at}: reply for '${session}', which has no open stream`);
      if (usage?.model && !(usage.model in models.models)) fail(path, `${at}: model '${usage.model}' is not in models.json`);
      if ("result" in row.reply || "no_value" in row.reply || "error" in row.reply) {
        known.open = false;
        known.stoppable = Boolean(usage);
      }
    } else if (row.close) {
      for (const session of row.close) {
        const known = sessions.get(session);
        if (!known?.open && !known?.stoppable) fail(path, `${at}: close of '${session}', which the Runner has nothing left to stop`);
        else known.open = known.stoppable = false;
      }
    }
  });
  for (const [session, { open }] of sessions)
    if (open) fail(path, `'${session}' is left open: end it with a terminal reply or a close`);
}

// --- main -------------------------------------------------------------------------------------

const folders = { parser: checkParser, lint: checkLint, runner: checkRunner };
let count = 0;
for (const [folder, checkFolder] of Object.entries(folders)) {
  const folderDir = join(root, folder);
  if (!existsSync(folderDir)) continue;
  for (const name of readdirSync(folderDir)) {
    const dir = join(folderDir, name);
    if (!statSync(dir).isDirectory()) continue;
    count++;
    const casePath = join(dir, "case.yaml");
    if (!existsSync(casePath)) {
      fail(dir, "missing case.yaml");
      continue;
    }
    const testCase = load(casePath);
    if (testCase === undefined || !check(`${folder}-case.schema.json`, testCase, casePath)) continue;
    checkFolder(dir, testCase);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} error(s) across ${count} test(s).`);
  process.exit(1);
}
console.log(`ok: ${count} test(s) and models.json are valid.`);
