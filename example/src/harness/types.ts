// The example Runner's harness boundary: the one interface every harness wrapper implements.
//
// SPEC.md does not define this interface. It says what a Runner must get out of a harness (cost,
// retryability, session continuity; SPEC §4.1.3) and leaves how to each implementation. This is how
// the example implementation does it. Each wrapper normalizes one real harness (Claude Agent SDK,
// the conformance mock, later Codex/Pi/Hermes) into these events, so the Runner has a single code
// path for budgets, retries, and resumes.

import type { Usd } from "./money.js";

export type JsonSchema = Record<string, unknown>;

/**
 * Whatever a wrapper needs to continue a session later (SPEC §11.7), including after a Runner
 * restart (SPEC §12.1). Opaque to the Runner: it persists the latest handle it has seen for an entry
 * and passes it back verbatim. It must be JSON-serializable.
 */
export type SessionHandle = { readonly [key: string]: string | number | boolean | null };

export interface Invocation {
  /** Qualified step name (SPEC §5.3). For logs and diagnostics only. */
  step: string;
  /** The SFML-rendered prompt (SPEC §9.9). A wrapper may add its own instructions around it. */
  prompt: string;
  /** The step's result_schema. A wrapper may pass it to a native structured-output feature. */
  resultSchema: JsonSchema;
  /** The step's harness_config, passed through unexamined by the Runner (SPEC §6.12). */
  harnessConfig: Record<string, unknown>;
  /** Continue this session. Absent: open a new one. */
  session?: SessionHandle;
  /**
   * The smallest remaining budget ceiling that applies to this invocation, if any. Advisory: the
   * Runner enforces budgets itself at every `usage` event. A wrapper whose harness can stop itself
   * at a spend limit may pass this through, so that a turn cannot run far past the ceiling between
   * reports.
   */
  spendLimit?: Usd;
  /** Aborted when the Runner must stop this invocation (SPEC §9.7). The wrapper then ends its stream. */
  signal: AbortSignal;
}

export type HarnessEvent =
  /** The current session handle. May be sent more than once; the Runner persists the latest. */
  | { type: "session"; handle: SessionHandle }
  /** A consumption report (SPEC §9.7): what was spent since the previous usage event. */
  | { type: "usage"; cost: Usd }
  /** Terminal. A value to validate against result_schema (SPEC §6.5). */
  | { type: "output"; value: unknown }
  /** Terminal. The harness produced output but no value could be obtained from it: schema_violation (SPEC §10.4). */
  | { type: "no_value"; reason: string }
  /** Terminal. The harness failed to produce output: harness_error unless retried (SPEC §10.3). */
  | { type: "failure"; retryable: boolean; message: string; backoffMs?: number };

export interface Harness {
  /**
   * Runs one attempt (SPEC §3.2.6). The stream ends after exactly one terminal event, or early
   * when `signal` is aborted.
   */
  invoke(invocation: Invocation): AsyncIterable<HarnessEvent>;
}
