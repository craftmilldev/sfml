// Validates every case in the conformance suite against schema/ and the cross-file rules of
// conformance/README.md §4. Exits non-zero on any error. Does not run factories.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
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
const check = (schemaRef, value, where) => {
  const validate = ajv.getSchema(schemaRef);
  if (!validate(value)) {
    for (const e of validate.errors) fail(where, `${e.instancePath || "/"} ${e.message}`);
    return false;
  }
  return true;
};

const models = readJson(join(root, "models.json"));
check("models.schema.json", models, join(root, "models.json"));

// --- factory helpers --------------------------------------------------------------------------

// Yields [qualifiedName, step, parallelName|null] for every step, children included.
function* walkSteps(factory) {
  for (const [name, step] of Object.entries(factory?.steps ?? {})) {
    yield [name, step, null];
    if (step?.type === "parallel")
      for (const [child, cstep] of Object.entries(step.steps ?? {})) yield [`${name}.${child}`, cstep, name];
  }
}

// --- per-class checks -------------------------------------------------------------------------

function checkParser(dir) {
  if (!existsSync(join(dir, "document.yaml"))) fail(dir, "missing document.yaml");
}

function checkLint(dir) {
  const factoryPath = join(dir, "factory.yaml");
  if (!existsSync(factoryPath)) return fail(dir, "missing factory.yaml");
  load(factoryPath);
}

function checkRunner(dir, manifest) {
  const factoryPath = join(dir, "factory.yaml");
  if (!existsSync(factoryPath)) return fail(dir, "missing factory.yaml");
  const factory = load(factoryPath);

  const resultPath = join(dir, "expect", "result.yaml");
  const result = existsSync(resultPath) ? load(resultPath) : fail(dir, "missing expect/result.yaml");
  if (result !== undefined) check("result.schema.json", result, resultPath);
  const rejected = result?.admission === "rejected";
  for (const f of ["state.json", "trace.json"]) {
    const p = join(dir, "expect", f);
    if (rejected) {
      if (existsSync(p)) fail(p, "must be absent when admission is rejected");
    } else if (!existsSync(p)) fail(dir, `missing expect/${f}`);
    else {
      const v = load(p);
      if (v !== undefined) check(f === "state.json" ? "factory-state.schema.json" : "trace.schema.json", v, p);
    }
  }

  // drive ordering (README §3.2)
  const drive = manifest.drive ?? [];
  drive.forEach((action, i) => {
    if ("start" in action && i !== 0) fail(dir, `drive[${i}]: start must be the first action and appear once`);
  });
  if (drive.length && !("start" in drive[0])) fail(dir, "drive[0] must be start");
  const admitted = drive[0]?.expect?.admitted;
  if (admitted === false && drive.length > 1) fail(dir, "no action may follow admitted: false");
  if (admitted === false && !rejected) fail(dir, "admitted: false but expect/result.yaml is not admission: rejected");

  // agents ↔ scripts (README §3.1, mock-harness §2.2–§2.3): every mock step names an agent, each
  // agent serves exactly one step, and each agent has a script.
  const named = new Map(); // agent -> [qualified step names]
  for (const [qname, step] of walkSteps(factory)) {
    if (step?.type !== "agent" || step.harness !== "mock") continue;
    const agent = step.harness_config?.agent;
    if (typeof agent !== "string") {
      fail(factoryPath, `${qname}: harness_config.agent is required for harness 'mock'`);
      continue;
    }
    named.set(agent, [...(named.get(agent) ?? []), qname]);
  }
  for (const [agent, steps] of named)
    if (steps.length > 1) fail(factoryPath, `agent '${agent}' is used by more than one step: ${steps.join(", ")}`);
  const agentsDir = join(dir, "agents");
  const scripts = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".yaml")) : [];
  const scripted = new Set(scripts.map((f) => basename(f, ".yaml")));
  for (const agent of named.keys())
    if (!scripted.has(agent)) fail(dir, `agent '${agent}' has no agents/${agent}.yaml`);

  const barriers = new Map(); // name -> Set(agent)
  for (const f of scripts) {
    const p = join(agentsDir, f);
    const script = load(p);
    if (script === undefined || !check("agent-script.schema.json", script, p)) continue;
    const agent = basename(f, ".yaml");
    if (script.agent !== agent) fail(p, `agent '${script.agent}' does not match file stem '${agent}'`);
    if (!named.has(agent)) fail(p, `no step names agent '${agent}'`);
    checkScript(p, script, named.get(agent) ?? [], barriers);
  }
  for (const [name, agents] of barriers)
    if (agents.size < 2) fail(agentsDir, `barrier '${name}' needs parties in at least two agents' scripts`);
}

function checkScript(p, script, steps, barriers) {
  const sessionNames = new Set();
  script.sessions.forEach((session, si) => {
    if (session.name !== undefined) {
      if (sessionNames.has(session.name)) fail(p, `duplicate session name '${session.name}'`);
      sessionNames.add(session.name);
    }
    if (!(session.model in models.models)) fail(p, `sessions[${si}]: unknown model '${session.model}'`);
    session.turns.forEach((turn, ti) => {
      const at = `sessions[${si}].turns[${ti}]`;
      if (turn.expect?.step && !steps.includes(turn.expect.step))
        fail(p, `${at}: expect.step '${turn.expect.step}' is not a step that names this agent`);
      const terminals = turn.events.map((e, i) => ("complete" in e || "fail" in e ? i : -1)).filter((i) => i >= 0);
      if (terminals.length !== 1 || terminals[0] !== turn.events.length - 1)
        fail(p, `${at}: events must end with exactly one terminal event (complete | fail)`);
      const calls = new Set();
      const localBarriers = new Set();
      for (const e of turn.events) {
        if (e.tool_call) calls.add(e.tool_call.id);
        if (e.tool_result && !calls.has(e.tool_result.id))
          fail(p, `${at}: tool_result '${e.tool_result.id}' has no earlier tool_call`);
        if (e.usage?.model && !(e.usage.model in models.models)) fail(p, `${at}: unknown model '${e.usage.model}'`);
        if (e.barrier) {
          if (localBarriers.has(e.barrier)) fail(p, `${at}: barrier '${e.barrier}' repeated within a turn`);
          localBarriers.add(e.barrier);
          const parties = barriers.get(e.barrier) ?? new Set();
          if (parties.has(script.agent)) fail(p, `barrier '${e.barrier}' has two parties in one agent's script`);
          parties.add(script.agent);
          barriers.set(e.barrier, parties);
        }
      }
    });
  });
}

// --- main -------------------------------------------------------------------------------------

let count = 0;
for (const cls of ["parser", "lint", "runner"]) {
  const clsDir = join(root, cls);
  if (!existsSync(clsDir)) continue;
  for (const name of readdirSync(clsDir)) {
    const dir = join(clsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    count++;
    const manifestPath = join(dir, "case.yaml");
    if (!existsSync(manifestPath)) {
      fail(dir, "missing case.yaml");
      continue;
    }
    const manifest = load(manifestPath);
    if (manifest === undefined || !check("case.schema.json", manifest, manifestPath)) continue;
    if (manifest.class !== cls) fail(manifestPath, `class '${manifest.class}' does not match directory '${cls}'`);
    else if (cls === "parser") checkParser(dir);
    else if (cls === "lint") checkLint(dir);
    else checkRunner(dir, manifest);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} error(s) across ${count} case(s).`);
  process.exit(1);
}
console.log(`ok: ${count} case(s) and models.json are valid.`);
