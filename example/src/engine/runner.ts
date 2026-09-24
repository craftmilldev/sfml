// The Runner conformance class (SPEC clauses 9-12, §4.1.3). Admits a run, drives the step lifecycle
// (§9.4), routing (§9.5), iteration and budget accounting (§9.6-§9.7), parallel join (§9.8), the
// error model (clause 10), and pause/resume (clause 11). §12.1 resumability is satisfied by keeping
// all state in `RunState` (state.ts) as plain, structured-cloneable data: `restart()` below discards
// this Engine and builds a fresh one from a clone of it, which is what a real implementation's
// reload-from-storage would also produce.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentStep, Connection, Factory, HumanStep, JsonSchema, ParallelStep, Step } from "./factory.js";
import { ExpressionError, evaluateExpression, renderTemplate, type Env, type ExprValue } from "./expr.js";
import { lintFactory } from "./linter.js";
import { Branch, ExceptionClass, RunState } from "./state.js";
import { parseUsd } from "../harness/money.js";
import type { Harness } from "../harness/types.js";

export type ObservedState = { parameters: Record<string, unknown>; results: Record<string, unknown[]> };
export type BlockedEntry = { step: string; state: "errored" | "awaiting_input"; exception?: ExceptionClass };
export type Observation =
  | { status: "terminal"; outcome: "complete" | "terminal_failure"; value: unknown; state: ObservedState }
  | { status: "errored" | "awaiting_input"; blocked: BlockedEntry[]; state: ObservedState };

export type AdmitResult = { admitted: true; observation: Observation } | { admitted: false; message: string };
export type ResumeResult = { accepted: boolean; observation: Observation };

class Region {
  aborted = false;
  readonly controller = new AbortController();
  constructor(readonly isParallel: boolean) {}
  trigger(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.controller.abort();
  }
}

type AgentOutcome = { kind: "success"; value: unknown } | { kind: "blocked"; branch: Branch };
type StepResolution = { kind: "advance"; to: string } | { kind: "blocked" };

/**
 * A trace of what the Runner did, step by step, for a caller that wants to narrate a run (a CLI's
 * `-v`, or the lib-mode stepper's timeline for a web page). Purely observational: nothing here
 * affects execution, and a caller that ignores it sees exactly the same runs.
 */
export type RunnerEvent =
  | { type: "step-entered"; step: string }
  | { type: "step-succeeded"; step: string; value: unknown }
  | { type: "step-blocked"; step: string; state: "errored" | "awaiting_input"; exception?: ExceptionClass; message?: string }
  | { type: "routed"; from: string; to: string }
  | { type: "terminal"; step: string; outcome: "complete" | "terminal_failure"; value: unknown };

export class Engine {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ReturnType<Ajv2020["compile"]>>();

  constructor(
    readonly factory: Factory,
    private readonly harnesses: Map<string, Harness>,
    private state: RunState = new RunState(),
    private readonly listener?: (event: RunnerEvent) => void,
    /** What an agent step's `prompt_path` resolves against (SPEC §7.9's "the factory's directory"). */
    private readonly baseDir?: string,
  ) {}

  /** Discards this Engine and builds a fresh one from a clone of its state (SPEC §12.1). */
  restart(harnesses: Map<string, Harness> = this.harnesses): Engine {
    return new Engine(this.factory, harnesses, this.state.clone(), this.listener, this.baseDir);
  }

  private emit(event: RunnerEvent): void {
    this.listener?.(event);
  }

  /** Sets a branch's blocked state and emits the matching event. */
  private block(branch: Branch): void {
    this.state.branches.set(branch.step, branch);
    this.emit({
      type: "step-blocked",
      step: branch.step,
      state: branch.status,
      ...(branch.exception && { exception: branch.exception }),
      ...(branch.message !== undefined && { message: branch.message }),
    });
  }

  /** The run's current state, for a caller that persists it itself (e.g. the CLI's --state file). */
  getState(): RunState {
    return this.state;
  }

  // --- admission (§9.1) ---------------------------------------------------------------------------

  static async start(
    factory: Factory,
    harnesses: Map<string, Harness>,
    parameters: Record<string, unknown>,
    listener?: (event: RunnerEvent) => void,
    baseDir?: string,
  ): Promise<{ result: AdmitResult; engine?: Engine }> {
    // §4.1.3: a Runner MUST refuse to start a run of a factory that fails linting (§8).
    const diagnostics = lintFactory(factory, baseDir);
    if (diagnostics.length) {
      return { result: { admitted: false, message: `factory fails lint (§4.1.3, §8): ${diagnostics.map((d) => `${d.id}: ${d.message}`).join("; ")}` } };
    }

    const engine = new Engine(factory, harnesses, new RunState(), listener, baseDir);

    for (const [name, step] of engine.walkAgentSteps()) {
      if (!engine.resolveHarness(step.harness)) return { result: { admitted: false, message: `${name}: harness '${step.harness}' does not resolve (§9.1, §6.12)` } };
    }

    const bound: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(factory.parameters ?? {})) {
      const hasValue = Object.prototype.hasOwnProperty.call(parameters, name);
      const hasDefault = Object.prototype.hasOwnProperty.call(schema, "default");
      if (!hasValue && !hasDefault) return { result: { admitted: false, message: `parameters.${name} is required and was not supplied (§9.1, §6.3)` } };
      const value = hasValue ? parameters[name] : (schema as { default: unknown }).default;
      if (!engine.compile(`param:${name}`, schema)(value)) return { result: { admitted: false, message: `parameters.${name} failed its schema (§9.1)` } };
      bound[name] = value;
    }
    engine.state.parameters = bound;

    await engine.runFrom(factory.start, false);
    return { result: { admitted: true, observation: engine.observe() }, engine };
  }

  private *walkAgentSteps(): Generator<[string, AgentStep]> {
    for (const [name, step] of Object.entries(this.factory.steps)) {
      if (step.type === "agent") yield [name, step];
      if (step.type === "parallel") {
        for (const [child, childStep] of Object.entries(step.steps)) {
          if ((childStep as Step).type === "agent") yield [`${name}.${child}`, childStep as AgentStep];
        }
      }
    }
  }

  private resolveHarness(ref: string): Harness | undefined {
    return this.harnesses.get(ref.split("@")[0]!);
  }

  private compile(key: string, schema: JsonSchema) {
    let v = this.validators.get(key);
    if (!v) {
      v = this.ajv.compile(schema);
      this.validators.set(key, v);
    }
    return v;
  }

  private validateResult(key: string, schema: JsonSchema, value: unknown): boolean {
    return Boolean(this.compile(key, schema)(value));
  }

  /** Formats ajv's errors for the last failed `validateResult(key, schema, ...)` call, for diagnostics. */
  private validationErrorText(key: string, schema: JsonSchema, value: unknown): string {
    const validate = this.compile(key, schema);
    return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") || `does not match result_schema: ${JSON.stringify(value)}`;
  }

  // --- observation (§11.2) -------------------------------------------------------------------------

  observe(): Observation {
    if (this.state.terminal) {
      return { status: "terminal", outcome: this.state.terminal.outcome, value: this.state.terminal.value, state: this.snapshotState() };
    }
    const blocked: BlockedEntry[] = [...this.state.branches.values()].map((b) => ({
      step: b.step,
      state: b.status as "errored" | "awaiting_input",
      ...(b.exception && { exception: b.exception }),
    }));
    const status = blocked.some((b) => b.state === "errored") ? "errored" : "awaiting_input";
    return { status, blocked, state: this.snapshotState() };
  }

  private snapshotState(): ObservedState {
    return { parameters: structuredClone(this.state.parameters), results: structuredClone(this.state.results) };
  }

  // --- step access ----------------------------------------------------------------------------------

  private getStep(name: string): Step {
    if (name.includes(".")) {
      const [parent, child] = splitQualified(name);
      const step = this.factory.steps[parent];
      if (!step || step.type !== "parallel") throw new Error(`no such step: ${name}`);
      const childStep = step.steps[child];
      if (!childStep) throw new Error(`no such step: ${name}`);
      return childStep as Step;
    }
    const step = this.factory.steps[name];
    if (!step) throw new Error(`no such step: ${name}`);
    return step;
  }

  private env(): Env {
    // §9.2's own example (§7.3: "last(emptyList).some_field is valid and evaluates to null") only
    // works if a step that has never run still resolves `results.<name>` to an actual empty list,
    // not a missing key (which is now an error, not null -- runner/missing-field-is-an-error). This
    // fills in `[]` for every declared step at evaluation time without writing it into `state.results`
    // itself, so `observe()`'s snapshot still shows only the steps that have actually produced one.
    const results: Record<string, ExprValue> = { ...(this.state.results as unknown as Record<string, ExprValue>) };
    for (const name of Object.keys(this.factory.steps)) if (!(name in results)) results[name] = [];
    return { parameters: this.state.parameters as unknown as ExprValue, results: results as unknown as ExprValue };
  }

  // --- run loop -------------------------------------------------------------------------------------

  private async runFrom(start: string, continueSession: boolean): Promise<void> {
    let current = start;
    let cs = continueSession;
    for (;;) {
      const result = await this.enterOneStep(current, cs);
      cs = false;
      if (result.kind === "advance") {
        current = result.to;
        continue;
      }
      return;
    }
  }

  private async enterOneStep(name: string, continueSession: boolean): Promise<StepResolution> {
    this.emit({ type: "step-entered", step: name });
    const step = this.getStep(name);
    if (step.type !== "result") {
      const limited = this.checkIterationBound(name, step);
      if (limited) {
        this.block({ step: name, status: "errored", exception: "iteration_limit" });
        return { kind: "blocked" };
      }
    }
    switch (step.type) {
      case "result":
        return this.enterResult(name, step);
      case "human": {
        if (step.instructions !== undefined) {
          try {
            evaluateExpression(step.instructions, this.env());
          } catch {
            this.block({ step: name, status: "errored", exception: "expression_error" });
            return { kind: "blocked" };
          }
        }
        this.block({ step: name, status: "awaiting_input" });
        return { kind: "blocked" };
      }
      case "agent": {
        const region = new Region(false);
        const outcome = await this.runAgentEntry(name, step, continueSession, region);
        if (outcome.kind === "success") return this.finishTopLevelEntry(name, outcome.value);
        this.block(outcome.branch);
        return { kind: "blocked" };
      }
      case "parallel": {
        this.state.parallelProgress.set(name, new Map());
        return this.runParallelRegion(name, step, Object.keys(step.steps), false);
      }
    }
  }

  private checkIterationBound(name: string, step: { max_iterations?: number }): boolean {
    const count = this.state.ledger.iterationCount.get(name) ?? 0;
    const max = step.max_iterations;
    const effective = max === undefined ? Infinity : max + (this.state.ledger.iterationGranted.get(name) ?? 0);
    return count >= effective;
  }

  private enterResult(name: string, step: Extract<Step, { type: "result" }>): StepResolution {
    let value: unknown;
    if (step.value !== undefined) {
      try {
        value = evaluateExpression(step.value, this.env());
      } catch {
        this.block({ step: name, status: "errored", exception: "expression_error" });
        return { kind: "blocked" };
      }
    } else {
      value = step.outcome === "complete" ? { ok: true } : { ok: false };
    }
    this.state.results[name] ??= [];
    this.state.results[name]!.push(value);
    this.state.terminal = { outcome: step.outcome, value };
    this.emit({ type: "terminal", step: name, outcome: step.outcome, value });
    return { kind: "blocked" };
  }

  // --- routing (§9.5) -------------------------------------------------------------------------------

  private finishTopLevelEntry(name: string, value: unknown): StepResolution {
    this.state.results[name] ??= [];
    this.state.results[name]!.push(value);
    this.state.ledger.iterationCount.set(name, (this.state.ledger.iterationCount.get(name) ?? 0) + 1);
    this.state.branches.delete(name);
    this.emit({ type: "step-succeeded", step: name, value });
    return this.evaluateRouting(name);
  }

  private evaluateRouting(name: string): StepResolution {
    const step = this.getStep(name) as { next: Connection[] };
    try {
      for (const conn of step.next) {
        if (conn.when === undefined) {
          this.emit({ type: "routed", from: name, to: conn.to });
          return { kind: "advance", to: conn.to };
        }
        const v = evaluateExpression(conn.when, this.env());
        if (typeof v !== "boolean") throw new ExpressionError(`'when' must evaluate to a boolean, got ${JSON.stringify(v)}`);
        if (v) {
          this.emit({ type: "routed", from: name, to: conn.to });
          return { kind: "advance", to: conn.to };
        }
      }
      throw new ExpressionError(`no connection matched (the last connection must be unconditional, §8.3)`);
    } catch {
      this.block({ step: name, status: "errored", exception: "routing_error" });
      return { kind: "blocked" };
    }
  }

  // --- agent step execution (§9.4, §9.7, §10.3-§10.4, §11.7) -----------------------------------------

  private async runAgentEntry(qualifiedName: string, step: AgentStep, continueSession: boolean, region: Region): Promise<AgentOutcome> {
    const ledger = this.state.ledger;
    const errored = (exception: ExceptionClass, exceededScope?: "step" | "run", message?: string): AgentOutcome => ({
      kind: "blocked",
      branch: { step: qualifiedName, status: "errored", exception, ...(exceededScope && { exceededScope }), ...(message !== undefined && { message }) },
    });

    let promptVars: Record<string, ExprValue> = {};
    try {
      for (const [k, expr] of Object.entries(step.prompt_vars ?? {})) promptVars[k] = evaluateExpression(expr, this.env());
    } catch {
      return errored("expression_error");
    }
    let promptText: string;
    try {
      let template: string;
      if (step.prompt !== undefined) {
        template = step.prompt;
      } else {
        const promptPath = this.baseDir ? join(this.baseDir, step.prompt_path!) : step.prompt_path!;
        template = readFileSync(promptPath, "utf8");
      }
      promptText = renderTemplate(template, { prompt_vars: promptVars });
    } catch {
      return errored("expression_error");
    }

    const stepBudget = step.budget !== undefined ? parseUsd(step.budget.toFixed(2)) : undefined;
    const runBudget = this.factory.budget !== undefined ? parseUsd(this.factory.budget.toFixed(2)) : undefined;
    const stepBudgetEff = () => (stepBudget === undefined ? undefined : stepBudget + (ledger.stepGranted.get(qualifiedName) ?? 0n));
    const runBudgetEff = () => (runBudget === undefined ? undefined : runBudget + ledger.runGranted);

    const arrivalStep = stepBudgetEff();
    if (arrivalStep !== undefined && (ledger.stepConsumed.get(qualifiedName) ?? 0n) >= arrivalStep) return errored("budget_exceeded", "step");
    const arrivalRun = runBudgetEff();
    if (arrivalRun !== undefined && ledger.runConsumed >= arrivalRun) {
      if (region.isParallel) region.trigger();
      return errored("budget_exceeded", "run");
    }

    const harness = this.resolveHarness(step.harness)!;
    let session = continueSession ? ledger.sessions.get(qualifiedName) : undefined;
    const retryMax = step.retry ?? 1;

    for (let attempt = 1; attempt <= retryMax; attempt++) {
      const own = new AbortController();
      const signal = AbortSignal.any([own.signal, region.controller.signal]);
      let outcome: "output" | "no_value" | "failure" | undefined;
      let outputValue: unknown;
      let retryable = false;
      let budgetStop: "step" | "run" | undefined;
      let failureMessage: string | undefined;

      for await (const ev of harness.invoke({ step: qualifiedName, prompt: promptText, resultSchema: step.result_schema, harnessConfig: step.harness_config ?? {}, session, signal })) {
        if (ev.type === "session") {
          session = ev.handle;
          ledger.sessions.set(qualifiedName, ev.handle);
        } else if (ev.type === "usage") {
          ledger.stepConsumed.set(qualifiedName, (ledger.stepConsumed.get(qualifiedName) ?? 0n) + ev.cost);
          ledger.runConsumed += ev.cost;
          const se = stepBudgetEff();
          if (se !== undefined && ledger.stepConsumed.get(qualifiedName)! >= se) {
            budgetStop = "step";
            own.abort();
          } else {
            const re = runBudgetEff();
            if (re !== undefined && ledger.runConsumed >= re) {
              if (region.isParallel) region.trigger();
              else {
                budgetStop = "run";
                own.abort();
              }
            }
          }
        } else if (ev.type === "output") {
          outcome = "output";
          outputValue = ev.value;
        } else if (ev.type === "no_value") {
          outcome = "no_value";
          failureMessage = ev.reason;
        } else if (ev.type === "failure") {
          outcome = "failure";
          retryable = ev.retryable;
          failureMessage = ev.message;
        }
      }

      if (budgetStop) return errored("budget_exceeded", budgetStop);
      if (region.isParallel && region.aborted) return errored("budget_exceeded", "run");

      if (outcome === "output") {
        if (this.validateResult(`result:${qualifiedName}`, step.result_schema, outputValue)) return { kind: "success", value: outputValue };
        const message = this.validationErrorText(`result:${qualifiedName}`, step.result_schema, outputValue);
        if (attempt < retryMax) continue;
        return errored("schema_violation", undefined, message);
      }
      if (outcome === "no_value") {
        if (attempt < retryMax) continue;
        return errored("schema_violation", undefined, failureMessage);
      }
      if (outcome === "failure") {
        if (retryable && attempt < retryMax) continue;
        return errored("harness_error", undefined, failureMessage);
      }
      return errored("harness_error", undefined, "the harness stream ended with no terminal event"); // nothing else to report
    }
    return errored("harness_error");
  }

  // --- parallel steps (§6.7, §9.8, §10.6, §11.1) -------------------------------------------------------

  private async runParallelRegion(parallelName: string, step: ParallelStep, childNames: string[], continueSession: boolean): Promise<StepResolution> {
    const ledger = this.state.ledger;
    const region = new Region(true);
    const progress = this.state.parallelProgress.get(parallelName)!;

    type Outcome = { qualified: string; child: string; done?: unknown; blocked?: Branch };
    const outcomes: Outcome[] = await Promise.all(
      childNames.map(async (child): Promise<Outcome> => {
        const qualified = `${parallelName}.${child}`;
        const childStep = step.steps[child]!;
        if (this.checkIterationBound(qualified, childStep)) {
          return { qualified, child, blocked: { step: qualified, status: "errored", exception: "iteration_limit" } };
        }
        if (childStep.type === "human") {
          if (childStep.instructions !== undefined) {
            try {
              evaluateExpression(childStep.instructions, this.env());
            } catch {
              return { qualified, child, blocked: { step: qualified, status: "errored", exception: "expression_error" } };
            }
          }
          return { qualified, child, blocked: { step: qualified, status: "awaiting_input" } };
        }
        const outcome = await this.runAgentEntry(qualified, childStep as AgentStep, continueSession, region);
        if (outcome.kind === "success") return { qualified, child, done: outcome.value };
        return { qualified, child, blocked: outcome.branch };
      }),
    );

    if (region.aborted) {
      const collapsed = outcomes.filter((o) => o.done === undefined).map((o) => o.qualified);
      for (const q of collapsed) this.state.branches.delete(q);
      this.block({
        step: parallelName,
        status: "errored",
        exception: "budget_exceeded",
        exceededScope: "run",
        collapsedChildren: collapsed,
      });
      return { kind: "blocked" };
    }

    for (const o of outcomes) {
      if (o.done !== undefined) {
        this.recordChildDone(parallelName, o.child, o.done);
      } else if (o.blocked) {
        this.block(o.blocked);
      }
    }
    return this.attemptJoin(parallelName, step);
  }

  private attemptJoin(parallelName: string, step: ParallelStep): StepResolution {
    const progress = this.state.parallelProgress.get(parallelName)!;
    const declared = Object.keys(step.steps);
    if (!declared.every((c) => progress.has(c))) return { kind: "blocked" };
    const value = Object.fromEntries(declared.map((c) => [c, progress.get(c)]));
    this.state.parallelProgress.delete(parallelName);
    return this.finishTopLevelEntry(parallelName, value);
  }

  private recordChildDone(parallelName: string, child: string, value: unknown): void {
    const progress = this.state.parallelProgress.get(parallelName)!;
    progress.set(child, value);
    const qualified = `${parallelName}.${child}`;
    this.state.ledger.iterationCount.set(qualified, (this.state.ledger.iterationCount.get(qualified) ?? 0) + 1);
    this.state.branches.delete(qualified);
    this.emit({ type: "step-succeeded", step: qualified, value });
  }

  // --- resume (clause 11) ------------------------------------------------------------------------------

  async resume(address: string, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    const reject = (): ResumeResult => ({ accepted: false, observation: this.observe() });
    if (this.state.terminal) return reject();
    const branch = this.state.branches.get(address);
    if (!branch) return reject();

    if (branch.status === "awaiting_input") return this.resumeHuman(address, branch, hasPayload, payload);

    switch (branch.exception!) {
      case "iteration_limit":
        return this.resumeIterationLimit(address, hasPayload, payload);
      case "budget_exceeded":
        return this.resumeBudgetExceeded(address, branch, hasPayload, payload);
      case "harness_error":
      case "schema_violation":
        return this.resumeHarnessOrSchema(address, hasPayload, payload);
      case "expression_error":
        return this.resumeExpressionError(address, hasPayload, payload);
      case "routing_error":
        return this.resumeRoutingError(address, hasPayload, payload);
    }
  }

  private resultSchemaOf(address: string): JsonSchema | undefined {
    const step = this.getStep(address);
    return step.type === "agent" || step.type === "human" ? step.result_schema : undefined;
  }

  private async settleFrom(resolution: StepResolution): Promise<ResumeResult> {
    if (resolution.kind === "advance") await this.runFrom(resolution.to, false);
    return { accepted: true, observation: this.observe() };
  }

  /** Completes an entry (top-level or a parallel child) with `value`, joining/routing onward. */
  private async finish(address: string, value: unknown): Promise<ResumeResult> {
    if (isChild(address)) {
      const [parallelName, child] = splitQualified(address);
      this.recordChildDone(parallelName, child, value);
      return this.settleFrom(this.attemptJoin(parallelName, this.getStep(parallelName) as ParallelStep));
    }
    return this.settleFrom(this.finishTopLevelEntry(address, value));
  }

  private async resumeHuman(address: string, _branch: Branch, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    const schema = this.resultSchemaOf(address);
    if (!hasPayload || !schema || !this.validateResult(`result:${address}`, schema, payload)) return { accepted: false, observation: this.observe() };
    return this.finish(address, payload);
  }

  private async resumeIterationLimit(address: string, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    if (!hasPayload || typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) return { accepted: false, observation: this.observe() };
    this.state.ledger.iterationGranted.set(address, (this.state.ledger.iterationGranted.get(address) ?? 0) + payload);
    this.state.branches.delete(address);
    return this.reenter(address, false);
  }

  private async resumeBudgetExceeded(address: string, branch: Branch, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    if (!hasPayload || typeof payload !== "number" || payload < 0 || Math.abs(Math.round(payload * 100) - payload * 100) > 1e-9) {
      return { accepted: false, observation: this.observe() };
    }
    const grant = parseUsd(payload.toFixed(2));
    this.state.branches.delete(address);

    if (branch.collapsedChildren) {
      this.state.ledger.runGranted += grant;
      const step = this.getStep(address) as ParallelStep;
      const children = branch.collapsedChildren.map((q) => splitQualified(q)[1]);
      return this.settleFrom(await this.runParallelRegion(address, step, children, true));
    }
    if (branch.exceededScope === "run") this.state.ledger.runGranted += grant;
    else this.state.ledger.stepGranted.set(address, (this.state.ledger.stepGranted.get(address) ?? 0n) + grant);
    return this.reenter(address, true);
  }

  private async resumeHarnessOrSchema(address: string, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    if (hasPayload) {
      const schema = this.resultSchemaOf(address);
      if (!schema || !this.validateResult(`result:${address}`, schema, payload)) return { accepted: false, observation: this.observe() };
      return this.finish(address, payload);
    }
    this.state.branches.delete(address);
    return this.reenter(address, true);
  }

  private async resumeExpressionError(address: string, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    if (hasPayload) {
      const step = this.getStep(address);
      if (step.type === "result") {
        // any JSON value stands in for the whole result (§10.7); a result step has no routing to
        // resume into, so this directly becomes the run's terminal value.
        this.state.branches.delete(address);
        this.state.results[address] ??= [];
        this.state.results[address]!.push(payload);
        this.state.terminal = { outcome: step.outcome, value: payload };
        return { accepted: true, observation: this.observe() };
      }
      const schema = this.resultSchemaOf(address);
      if (!schema || !this.validateResult(`result:${address}`, schema, payload)) return { accepted: false, observation: this.observe() };
      return this.finish(address, payload);
    }
    this.state.branches.delete(address);
    return this.reenter(address, false);
  }

  private async resumeRoutingError(address: string, hasPayload: boolean, payload: unknown): Promise<ResumeResult> {
    this.state.branches.delete(address);
    if (hasPayload) {
      const step = this.getStep(address) as { next: Connection[] };
      if (typeof payload !== "string" || !step.next.some((c) => c.to === payload)) {
        this.block({ step: address, status: "errored", exception: "routing_error" });
        return { accepted: false, observation: this.observe() };
      }
      return this.settleFrom({ kind: "advance", to: payload });
    }
    return this.settleFrom(this.evaluateRouting(address));
  }

  /** Re-enters `address` (top-level step or parallel child) as a new entry, joining if it's a child. */
  private async reenter(address: string, continueSession: boolean): Promise<ResumeResult> {
    if (isChild(address)) {
      const [parallelName, child] = splitQualified(address);
      const step = this.getStep(parallelName) as unknown as ParallelStep;
      return this.settleFrom(await this.runParallelRegion(parallelName, step, [child], continueSession));
    }
    await this.runFrom(address, continueSession);
    return { accepted: true, observation: this.observe() };
  }
}

function isChild(address: string): boolean {
  return address.includes(".");
}

function splitQualified(address: string): [string, string] {
  const idx = address.indexOf(".");
  return [address.slice(0, idx), address.slice(idx + 1)];
}
