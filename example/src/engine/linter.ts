// Linter conformance class (SPEC clause 8, §4.1.2, §4.3): static properties of the graph, of every
// expression, and of every prompt template. Diagnostic identifiers are those registered in §8.7;
// this module implements every rule in that registry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStep, Factory, HumanStep, ParallelStep, Step } from "./factory.js";
import { checkTemplateWellFormed, findProhibitedConstruct, templatePlaceholders, walkReferences, ExpressionError } from "./expr.js";

export interface Diagnostic {
  id: string;
  message: string;
}

const RESULT_KIND = new Set(["agent", "human", "parallel"]); // step types that append to FactoryState.results

/** `baseDir`, where given, is what an agent step's `prompt_path` resolves against (SPEC §7.9's "the factory's directory"). */
export function lintFactory(factory: Factory, baseDir?: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const add = (id: string, message: string) => diags.push({ id, message });
  const stepNames = new Set(Object.keys(factory.steps));

  checkStructural(factory, add);
  checkTotality(factory, add);
  const { forwardReachable, edges } = checkReachability(factory, stepNames, add);
  checkTermination(factory, edges, forwardReachable, add);
  checkExpressionsAndTemplates(factory, stepNames, forwardReachable, baseDir, add);

  return diags;
}

// --- §8.2 step references -----------------------------------------------------------------------
//
// Everything else the old draft checked here (a parallel child's type, that it declares no `next`)
// is now enforced by sfml.schema.json alone (§8.2's current text: "The data model gives `start` and
// a `Connection`'s `to` the type `StepName`, which a Parser checks"); §8.7's registry no longer
// assigns those cases their own Linter diagnostic identifiers.

function checkStructural(factory: Factory, add: (id: string, message: string) => void): void {
  const stepNames = new Set(Object.keys(factory.steps));

  if (!stepNames.has(factory.start)) add("unknown-step-reference", `start: '${factory.start}' is not declared in steps`);

  for (const [name, step] of Object.entries(factory.steps)) {
    if (!hasNext(step)) continue;
    for (const conn of step.next) {
      if (!stepNames.has(conn.to)) add("unknown-step-reference", `${name}: connection to '${conn.to}' is not declared in steps`);
    }
  }
}

function hasNext(step: Step): step is AgentStep | HumanStep | ParallelStep {
  return step.type === "agent" || step.type === "human" || step.type === "parallel";
}

// --- §8.3 totality of routing --------------------------------------------------------------------

function checkTotality(factory: Factory, add: (id: string, message: string) => void): void {
  for (const [name, step] of Object.entries(factory.steps)) {
    if (!hasNext(step)) continue;
    const last = step.next.at(-1);
    if (!last || last.when !== undefined) add("non-total-routing", `${name}: the last connection in 'next' must omit 'when'`);
  }
}

// --- §8.4 reachability -----------------------------------------------------------------------------

function checkReachability(
  factory: Factory,
  stepNames: Set<string>,
  add: (id: string, message: string) => void,
): { reachableFromStart: Set<string>; forwardReachable: Map<string, Set<string>>; edges: Map<string, string[]> } {
  const edges = new Map<string, string[]>();
  for (const [name, step] of Object.entries(factory.steps)) {
    edges.set(name, hasNext(step) ? step.next.map((c) => c.to).filter((to) => stepNames.has(to)) : []);
  }

  const reachableFromStart = bfs(factory.start, edges, stepNames);
  if (stepNames.has(factory.start)) {
    for (const name of stepNames) if (!reachableFromStart.has(name)) add("unreachable-step", `${name} is not reachable from start`);
  }

  // Forward-reachable set per step, used both for no-path-to-result and for §8.6 reference legality.
  const forwardReachable = new Map<string, Set<string>>();
  for (const name of stepNames) forwardReachable.set(name, bfs(name, edges, stepNames));

  const resultSteps = new Set([...stepNames].filter((n) => factory.steps[n]!.type === "result"));
  for (const name of reachableFromStart) {
    const reaches = forwardReachable.get(name)!;
    if (![...reaches].some((n) => resultSteps.has(n))) add("no-path-to-result", `${name}: no path from it reaches a result step`);
  }

  return { reachableFromStart, forwardReachable, edges };
}

function bfs(start: string, edges: Map<string, string[]>, stepNames: Set<string>): Set<string> {
  const seen = new Set<string>();
  if (!stepNames.has(start)) return seen;
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

// --- §8.5 termination: every cycle bounded ---------------------------------------------------------

function checkTermination(factory: Factory, edges: Map<string, string[]>, forwardReachable: Map<string, Set<string>>, add: (id: string, message: string) => void): void {
  // A step is "in a cycle" iff some successor of it can reach it back (a non-trivial path, not the
  // reflexive membership `forwardReachable` gives every step over itself via a zero-length path).
  // Group cyclic steps that share a cycle (mutually reachable) and require at least one bounded step
  // per group.
  const reachesSelf = (name: string) => (edges.get(name) ?? []).some((next) => forwardReachable.get(next)?.has(name));
  const cyclic = [...forwardReachable.keys()].filter(reachesSelf);
  const visited = new Set<string>();
  for (const name of cyclic) {
    if (visited.has(name)) continue;
    const group = cyclic.filter((other) => forwardReachable.get(name)!.has(other) && forwardReachable.get(other)!.has(name));
    for (const g of group) visited.add(g);
    const bounded = group.some((g) => hasMaxIterations(factory.steps[g]!));
    if (!bounded) add("unbounded-cycle", `cycle among [${group.join(", ")}] has no step with a finite max_iterations`);
  }
}

function hasMaxIterations(step: Step): boolean {
  return (step.type === "agent" || step.type === "human" || step.type === "parallel") && step.max_iterations !== undefined && step.max_iterations !== null;
}

// --- §7.1, §7.8, §7.9, §8.6: expressions, prompt templates, and prompt files ------------------------

type Site = { owner: string; expr: string; env: "FactoryState" | "PromptVars" };

function checkExpressionsAndTemplates(
  factory: Factory,
  stepNames: Set<string>,
  forwardReachable: Map<string, Set<string>>,
  baseDir: string | undefined,
  add: (id: string, message: string) => void,
): void {
  const sites: Site[] = [];

  const addTemplateSites = (owner: string, template: string): void => {
    try {
      checkTemplateWellFormed(template);
    } catch (e) {
      add("invalid-prompt-template", `${owner}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const expr of templatePlaceholders(template)) sites.push({ owner, expr, env: "PromptVars" });
  };

  for (const [name, step] of Object.entries(factory.steps)) {
    if (step.type === "agent") {
      for (const expr of Object.values(step.prompt_vars ?? {})) sites.push({ owner: name, expr, env: "FactoryState" });
      if (step.prompt !== undefined) {
        addTemplateSites(name, step.prompt);
      } else if (step.prompt_path !== undefined) {
        const path = baseDir ? join(baseDir, step.prompt_path) : step.prompt_path;
        let bytes: Buffer;
        try {
          bytes = readFileSync(path);
        } catch (e) {
          add("prompt-file-unreadable", `${name}: prompt_path '${step.prompt_path}' could not be read (resolved to ${path}): ${e instanceof Error ? e.message : String(e)}`);
          bytes = undefined as unknown as Buffer;
        }
        if (bytes !== undefined) {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            add("prompt-file-not-utf8", `${name}: the file prompt_path '${step.prompt_path}' names is not valid UTF-8`);
            text = undefined as unknown as string;
          }
          if (text !== undefined) addTemplateSites(name, text);
        }
      }
      if (hasNext(step)) for (const c of step.next) if (c.when !== undefined) sites.push({ owner: name, expr: c.when, env: "FactoryState" });
    } else if (step.type === "human") {
      if (step.instructions !== undefined) sites.push({ owner: name, expr: step.instructions, env: "FactoryState" });
      for (const c of step.next) if (c.when !== undefined) sites.push({ owner: name, expr: c.when, env: "FactoryState" });
    } else if (step.type === "parallel") {
      for (const c of step.next) if (c.when !== undefined) sites.push({ owner: name, expr: c.when, env: "FactoryState" });
    } else if (step.type === "result") {
      if (step.value !== undefined) sites.push({ owner: name, expr: step.value, env: "FactoryState" });
    }
  }

  for (const site of sites) {
    // §7.1: doesn't parse as CEL at all -> invalid-expression. §7.8: parses, but outside the §7.2
    // grammar (arithmetic, a macro, a function outside §7.4) -> prohibited-expression-construct.
    // Neither is reached until the expression clears both, so binding/reference checks below never
    // see a malformed or out-of-grammar expression.
    let prohibited: string | undefined;
    try {
      prohibited = findProhibitedConstruct(site.expr);
    } catch (e) {
      add("invalid-expression", `${site.owner}: does not parse as CEL: ${site.expr} (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    if (prohibited !== undefined) {
      add("prohibited-expression-construct", `${site.owner}: ${prohibited}: ${site.expr}`);
      continue;
    }

    const roots: string[][] = [];
    walkReferences(site.expr, (path) => roots.push(path));
    for (const path of roots) {
      const root = path[0]!;
      if (site.env === "PromptVars") {
        if (root !== "prompt_vars") add("binding-environment-violation", `${site.owner}: a PromptVars expression referenced '${root}': ${site.expr}`);
        continue;
      }
      // FactoryState env
      if (root === "prompt_vars") {
        add("binding-environment-violation", `${site.owner}: a FactoryState expression referenced 'prompt_vars': ${site.expr}`);
        continue;
      }
      if (root === "parameters") {
        const paramName = path[1];
        if (paramName !== undefined && !(paramName in (factory.parameters ?? {})))
          add("unknown-parameter-reference", `${site.owner}: parameters.${paramName} is not declared in parameters: ${site.expr}`);
      } else if (root === "results") {
        const stepName = path[1];
        if (stepName === undefined) continue;
        if (!stepNames.has(stepName) || !RESULT_KIND.has(factory.steps[stepName]!.type)) {
          add("unknown-step-result-reference", `${site.owner}: results.${stepName} is not declared in steps: ${site.expr}`);
        } else if (!forwardReachable.get(stepName)!.has(site.owner)) {
          add("unreachable-reference", `${site.owner}: no path ${stepName} → … → ${site.owner} exists: ${site.expr}`);
        }
      }
      // any other root identifier is neither a known FactoryState field nor a binding violation this
      // registry names; SPEC leaves function-local identifiers (none exist in this grammar) aside.
    }
  }
}
