// Validates every case in the conformance suite against schema/ and the cross-file rules of
// conformance/README.md §4. Exits non-zero on any error. Does not run factories.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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

// --- pricing (mock-harness.md §7) -------------------------------------------------------------

const cents = (price) => BigInt(price.replace(".", ""));
const TOKEN_CLASSES = ["input", "output", "cache_read", "cache_write"];
const nanoCost = (model, usage) =>
  TOKEN_CLASSES.reduce((sum, k) => sum + BigInt(usage[`${k}_tokens`] ?? 0) * cents(models.models[model][k]), 0n);
const usd = (nano) => {
  const s = nano.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
};

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

  // agents ↔ scripts (README §3.1, mock-harness §2.3)
  const named = new Map(); // agent -> [qualified step names]
  const byParallel = new Map(); // parallel -> Map(agent -> child)
  for (const [qname, step, parent] of walkSteps(factory)) {
    if (step?.type !== "agent" || !String(step.harness ?? "").startsWith("mock")) continue;
    const agent = step.harness_config?.agent;
    if (typeof agent !== "string") continue; // a malformed config is a legitimate case subject
    named.set(agent, [...(named.get(agent) ?? []), qname]);
    if (parent) {
      const seen = byParallel.get(parent) ?? new Map();
      if (seen.has(agent)) fail(factoryPath, `children ${seen.get(agent)} and ${qname} share agent '${agent}'`);
      seen.set(agent, qname);
      byParallel.set(parent, seen);
    }
  }
  const unscripted = new Set(manifest.unscripted_agents ?? []);
  const agentsDir = join(dir, "agents");
  const scripts = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".yaml")) : [];
  const scripted = new Set(scripts.map((f) => basename(f, ".yaml")));
  for (const agent of named.keys())
    if (!scripted.has(agent) && !unscripted.has(agent)) fail(dir, `agent '${agent}' has no agents/${agent}.yaml`);
  for (const agent of unscripted) {
    if (scripted.has(agent)) fail(dir, `agent '${agent}' is listed in unscripted_agents but has a script`);
    if (!named.has(agent)) fail(dir, `unscripted agent '${agent}' is not named by any step`);
  }

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

// --- golden stream (mock-harness.md §5, §7) ---------------------------------------------------

// Expands the first turn of a freshly opened session exactly as a conforming mock must, with no
// early close and no barriers, so the golden file's costs and envelopes are checked from first
// principles.
function expandOpeningTurn(agent, session, n) {
  const sessionId = `mock:${agent}:${n}`;
  const events = [];
  const push = (e) => events.push({ ...e, session_id: sessionId, turn: 1, seq: events.length });
  push({ type: "session.started", agent, model: session.model });
  push({ type: "turn.started", resumed: false });
  let turnNano = 0n;
  const rollup = {};
  for (const e of session.turns[0].events) {
    if ("message" in e) push({ type: "message", text: e.message });
    else if ("reasoning" in e) push({ type: "reasoning", text: e.reasoning });
    else if (e.tool_call) push({ type: "tool.call", call_id: e.tool_call.id, name: e.tool_call.name, input: e.tool_call.input });
    else if (e.tool_result)
      push({ type: "tool.result", call_id: e.tool_result.id, output: e.tool_result.output, is_error: e.tool_result.is_error ?? false });
    else if (e.usage) {
      const model = e.usage.model ?? session.model;
      const tokens = Object.fromEntries(TOKEN_CLASSES.map((k) => [`${k}_tokens`, e.usage[`${k}_tokens`] ?? 0]));
      const nano = nanoCost(model, tokens);
      turnNano += nano;
      const r = (rollup[model] ??= { ...Object.fromEntries(TOKEN_CLASSES.map((k) => [`${k}_tokens`, 0])), nano: 0n });
      for (const k of Object.keys(tokens)) r[k] += tokens[k];
      r.nano += nano;
      push({ type: "usage", model, ...tokens, cost_usd: usd(nano), turn_cost_usd: usd(turnNano) });
    } else if (e.complete || e.fail) {
      const usage = Object.fromEntries(
        Object.entries(rollup).map(([m, { nano, ...t }]) => [m, { ...t, cost_usd: usd(nano) }]),
      );
      if (e.complete) push({ type: "turn.completed", output: e.complete.output, total_cost_usd: usd(turnNano), usage });
      else {
        const error = { message: e.fail.message, retryable: e.fail.retryable };
        if (e.fail.backoff_ms !== undefined) error.backoff_ms = e.fail.backoff_ms;
        push({ type: "turn.failed", error, total_cost_usd: usd(turnNano), usage });
      }
    }
  }
  return events;
}

function checkGolden() {
  const p = join(root, "mock-harness.golden.json");
  const golden = load(p);
  if (!golden) return;
  check("mock-stream.schema.json#/$defs/TurnRequest", golden.request, p);
  golden.events.forEach((e, i) => check("mock-stream.schema.json#/$defs/Event", e, `${p}#events[${i}]`));
  const script = load(join(root, golden.script));
  const expected = expandOpeningTurn(script.agent, script.sessions[0], 1);
  if (!isDeepStrictEqual(expected, golden.events))
    fail(p, `events differ from the expansion of ${golden.script}:\n${JSON.stringify(expected, null, 2)}`);
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
checkGolden();

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} error(s) across ${count} case(s).`);
  process.exit(1);
}
console.log(`ok: ${count} case(s), golden stream, and models.json are valid.`);
