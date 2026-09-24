// Mutable run state (SPEC §9.2 FactoryState, plus the Runner's own bookkeeping clause 9-12 need but
// SPEC leaves to the implementation: branch status, budget/iteration ledgers, and harness sessions).
//
// Everything here is plain data (Maps, bigints, arrays) so that `structuredClone`-ing it is a faithful
// simulation of "discard every piece of in-memory Runner state, then reload from durable storage"
// (SPEC §12.1, conformance README `restart`). A real implementation would serialize this to its own
// store; SPEC.md imposes no requirement on how (§12.1), so this example keeps it in memory.

import type { Usd } from "../harness/money.js";
import type { SessionHandle } from "../harness/types.js";

// A "done" branch isn't represented here: once a step's entry finishes, its Branch entry is removed
// (RunState.branches only ever holds *blocked* branches; SPEC's `done` (§11.1) is the absence of one).
export type BranchStatus = "awaiting_input" | "errored";
export type ExceptionClass = "schema_violation" | "harness_error" | "iteration_limit" | "budget_exceeded" | "expression_error" | "routing_error";

export interface Branch {
  step: string; // qualified name (SPEC §5.3) this branch is addressed by
  status: BranchStatus;
  exception?: ExceptionClass;
  /** For a budget_exceeded branch: which ceiling was reached (SPEC §10.6), so a grant lands in the right bucket. */
  exceededScope?: "step" | "run";
  /** For a factory-level budget_exceeded collapsed onto a `parallel` step (SPEC §10.6, §11.1). */
  collapsedChildren?: string[];
  /**
   * Why, in whatever terms the harness or validator gave: a harness_error's failure message, a
   * schema_violation's validation errors or no_value reason. Purely diagnostic -- SPEC assigns no
   * meaning to it and a resume never reads it back; without it, a caller sees only the exception
   * class and has to go digging for the actual cause.
   */
  message?: string;
}

export class Ledger {
  stepConsumed = new Map<string, Usd>();
  stepGranted = new Map<string, Usd>();
  iterationCount = new Map<string, number>();
  iterationGranted = new Map<string, number>();
  sessions = new Map<string, SessionHandle>();
  runConsumed: Usd = 0n;
  runGranted: Usd = 0n;

  clone(): Ledger {
    const l = new Ledger();
    for (const [k, v] of this.stepConsumed) l.stepConsumed.set(k, v);
    for (const [k, v] of this.stepGranted) l.stepGranted.set(k, v);
    for (const [k, v] of this.iterationCount) l.iterationCount.set(k, v);
    for (const [k, v] of this.iterationGranted) l.iterationGranted.set(k, v);
    for (const [k, v] of this.sessions) l.sessions.set(k, v);
    l.runConsumed = this.runConsumed;
    l.runGranted = this.runGranted;
    return l;
  }
}

export class RunState {
  parameters: Record<string, unknown> = {};
  /** FactoryState.results (§9.2): top-level StepName only, oldest to newest. */
  results: Record<string, unknown[]> = {};
  /** Per-`parallel`-step, the child results collected so far in its current entry (§6.7, §9.8). */
  parallelProgress = new Map<string, Map<string, unknown>>();
  branches = new Map<string, Branch>();
  ledger = new Ledger();
  terminal?: { outcome: "complete" | "terminal_failure"; value: unknown };

  clone(): RunState {
    const s = new RunState();
    s.parameters = structuredClone(this.parameters);
    s.results = structuredClone(this.results);
    for (const [k, v] of this.parallelProgress) s.parallelProgress.set(k, new Map(v));
    for (const [k, v] of this.branches) s.branches.set(k, { ...v, collapsedChildren: v.collapsedChildren ? [...v.collapsedChildren] : undefined });
    s.ledger = this.ledger.clone();
    s.terminal = this.terminal ? structuredClone(this.terminal) : undefined;
    return s;
  }
}

/** JSON-safe serialization of a RunState, for a CLI or any store that can't hold Maps/bigints directly. */
export function serializeRunState(state: RunState): unknown {
  const usd = (v: Usd) => v.toString();
  return {
    parameters: state.parameters,
    results: state.results,
    parallelProgress: [...state.parallelProgress].map(([k, v]) => [k, [...v]]),
    branches: [...state.branches.entries()],
    terminal: state.terminal,
    ledger: {
      stepConsumed: [...state.ledger.stepConsumed].map(([k, v]) => [k, usd(v)]),
      stepGranted: [...state.ledger.stepGranted].map(([k, v]) => [k, usd(v)]),
      iterationCount: [...state.ledger.iterationCount],
      iterationGranted: [...state.ledger.iterationGranted],
      sessions: [...state.ledger.sessions],
      runConsumed: usd(state.ledger.runConsumed),
      runGranted: usd(state.ledger.runGranted),
    },
  };
}

export function deserializeRunState(data: ReturnType<typeof serializeRunState>): RunState {
  const d = data as {
    parameters: Record<string, unknown>;
    results: Record<string, unknown[]>;
    parallelProgress: [string, [string, unknown][]][];
    branches: [string, Branch][];
    terminal?: RunState["terminal"];
    ledger: {
      stepConsumed: [string, string][];
      stepGranted: [string, string][];
      iterationCount: [string, number][];
      iterationGranted: [string, number][];
      sessions: [string, SessionHandle][];
      runConsumed: string;
      runGranted: string;
    };
  };
  const s = new RunState();
  s.parameters = d.parameters;
  s.results = d.results;
  s.parallelProgress = new Map(d.parallelProgress.map(([k, v]) => [k, new Map(v)]));
  s.branches = new Map(d.branches);
  s.terminal = d.terminal;
  s.ledger.stepConsumed = new Map(d.ledger.stepConsumed.map(([k, v]) => [k, BigInt(v)]));
  s.ledger.stepGranted = new Map(d.ledger.stepGranted.map(([k, v]) => [k, BigInt(v)]));
  s.ledger.iterationCount = new Map(d.ledger.iterationCount);
  s.ledger.iterationGranted = new Map(d.ledger.iterationGranted);
  s.ledger.sessions = new Map(d.ledger.sessions);
  s.ledger.runConsumed = BigInt(d.ledger.runConsumed);
  s.ledger.runGranted = BigInt(d.ledger.runGranted);
  return s;
}
