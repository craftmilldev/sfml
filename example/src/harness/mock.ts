// Wrapper for the conformance mock: `harness: mock`.
//
// DRAFT, written against the transcript format proposed in step 2.1 (not yet in
// conformance/mock-harness.md). The mock stands in for a real SDK *and* its wrapper together: a
// transcript row carries the value a wrapper would already have extracted, so this file has no
// parsing to do. It only turns rows into HarnessEvents at the right moments.
//
// A transcript is the whole conversation between the Runner and its harnesses, in order:
//
//   - send:  { session: lint-1, agent: linter, model: mock-small, prompt: "Lint it." }  # Runner → harness
//   - reply: { session: lint-1, usage: { output_tokens: 120000 } }                       # harness → Runner
//   - close: [lint-1, test-1]                                                            # Runner must stop these
//   - reply: { session: lint-1, result: { passed: true } }
//
// - `send` opens a session when its id is new (then `agent` and `model` are required) and continues
//   it otherwise. `prompt`, when given, must equal the SFML-rendered prompt exactly. Consecutive
//   sends are one group and may arrive in any order, which is how concurrent `parallel` children work.
// - `reply` carries at most one `usage` and at most one terminal (`result`, `no_value`, or `error`).
// - `close` waits until every listed session's stream has been stopped by the Runner, or has ended.
//
// The mock releases a row only after the Runner has finished handling the previous one (it has come
// back for the next event, or has stopped that stream). So the Runner sees one fixed order of events
// across all its concurrent streams, with no timing involved.
//
// The mock's only state is the row cursor plus the sessions it has opened. It is written to
// `statePath` after every change, so a restarted Runner finds the mock where it left it (a real
// harness keeps sessions server-side for the same reason).
//
// Anything that does not match the transcript is a *fault*: the invocation fails as a non-retryable
// harness failure (so the run visibly goes wrong), and the fault is recorded for verify(), which fails
// the conformance case even if the Runner recovered.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import YAML from "yaml";
import type { Harness, HarnessEvent, Invocation } from "./types.js";
import type { Usd } from "./money.js";

type Tokens = { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
type Send = { session: string; agent?: string; model?: string; prompt?: string };
type Reply = {
  session: string;
  usage?: Tokens & { model?: string };
  result?: unknown;
  no_value?: string;
  error?: { message: string; retryable: boolean; backoff_ms?: number };
};
export type Row = { send: Send } | { reply: Reply } | { close: string[] };

type Pricing = Record<string, { input: string; output: string; cache_read: string; cache_write: string }>;
type State = {
  cursor: number;
  /** Rows of the current send group already received. */
  received: number[];
  sessions: Record<string, { agent: string; model: string }>;
};

export class MockFault extends Error {}

export class MockHarness implements Harness {
  private state: State = { cursor: 0, received: [], sessions: {} };
  private readonly open = new Set<string>();
  /** True while a reply's events are in flight and the Runner has not yet come back for more. */
  private delivering = false;
  private waiters: Array<() => void> = [];
  readonly faults: string[] = [];

  constructor(
    private readonly rows: Row[],
    private readonly pricing: Pricing,
    private readonly statePath?: string,
  ) {
    if (statePath && existsSync(statePath)) this.state = JSON.parse(readFileSync(statePath, "utf8")) as State;
  }

  static fromFiles(paths: { transcript: string; models: string; state?: string }): MockHarness {
    const rows = YAML.parse(readFileSync(paths.transcript, "utf8")) as Row[];
    const pricing = (JSON.parse(readFileSync(paths.models, "utf8")) as { models: Pricing }).models;
    return new MockHarness(rows, pricing, paths.state);
  }

  async *invoke(inv: Invocation): AsyncGenerator<HarnessEvent> {
    const agent = inv.harnessConfig.agent;
    if (typeof agent !== "string" || Object.keys(inv.harnessConfig).length !== 1) {
      yield { type: "failure", retryable: false, message: "mock: harness_config must be exactly { agent: <name> }" };
      return;
    }
    await setImmediate(); // behave like a network call: never answer synchronously

    const accepted = await this.receiveSend(inv, agent);
    if (typeof accepted !== "string") {
      yield this.fault(accepted.fault);
      return;
    }
    const id = accepted;
    this.open.add(id);
    let owesDelivery = false;
    try {
      yield { type: "session", handle: { session: id } };
      for (;;) {
        if (inv.signal.aborted) return;
        const row = this.rows[this.state.cursor];
        if (row && "reply" in row && row.reply.session === id && !this.delivering) {
          this.delivering = owesDelivery = true;
          this.state.cursor++;
          this.save();
          const events = this.expand(row.reply, this.state.sessions[id]!.model);
          for (const event of events) {
            await setImmediate();
            if (inv.signal.aborted) return;
            yield event;
          }
          this.delivering = owesDelivery = false;
          this.notify();
          if (events.some((e) => e.type !== "usage")) return;
          continue;
        }
        if (row && "reply" in row && !this.open.has(row.reply.session)) {
          yield this.fault(`reply row ${this.state.cursor} is for session '${row.reply.session}', whose stream the Runner already stopped`);
          return;
        }
        await this.changed(inv.signal);
      }
    } finally {
      if (owesDelivery) this.delivering = false;
      this.open.delete(id);
      this.advance();
      this.notify();
    }
  }

  /** Faults, plus anything left unplayed. Call once a conformance case has finished. */
  verify(): string[] {
    const problems = [...this.faults];
    if (this.state.cursor < this.rows.length) problems.push(`transcript not finished: stopped at row ${this.state.cursor} of ${this.rows.length}`);
    if (this.open.size) problems.push(`streams still open: ${[...this.open].join(", ")}`);
    return problems;
  }

  // --- sends ------------------------------------------------------------------------------------

  /** Matches an invocation to a send row in the current group. Returns the session id, or a fault. */
  private async receiveSend(inv: Invocation, agent: string): Promise<string | { fault: string }> {
    // A send can only arrive while the cursor is on a send group. If streams are still closing, the
    // cursor may be about to reach one, so wait for them first.
    while (!this.atSend() && this.open.size > 0 && !inv.signal.aborted) await this.changed(inv.signal);
    if (!this.atSend()) return { fault: `${inv.step}: unexpected send at row ${this.state.cursor}` };

    const resume = inv.session?.session;
    if (inv.session && typeof resume !== "string") return { fault: `${inv.step}: session handle was not issued by the mock` };
    for (let i = this.state.cursor; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      if (!("send" in row)) break;
      if (this.state.received.includes(i)) continue;
      const send = row.send;
      const known = send.session in this.state.sessions;
      const matches = resume ? send.session === resume && known : !known && send.agent === agent;
      if (!matches) continue;

      if (send.prompt !== undefined && send.prompt !== inv.prompt)
        return { fault: `${inv.step}: prompt does not match row ${i}\n  expected: ${JSON.stringify(send.prompt)}\n  received: ${JSON.stringify(inv.prompt)}` };
      if (!known) {
        if (!send.model || !(send.model in this.pricing)) return { fault: `row ${i}: a new session needs a model from models.json` };
        this.state.sessions[send.session] = { agent, model: send.model };
      }
      this.state.received.push(i);
      this.advance();
      this.notify();
      return send.session;
    }
    return { fault: `${inv.step}: no send in the group at row ${this.state.cursor} matches ${resume ? `session '${resume}'` : `a new session for agent '${agent}'`}` };
  }

  private atSend(): boolean {
    const row = this.rows[this.state.cursor];
    return row !== undefined && "send" in row;
  }

  // --- cursor -----------------------------------------------------------------------------------

  /** Moves past completed send groups and satisfied close rows. */
  private advance(): void {
    for (;;) {
      const row = this.rows[this.state.cursor];
      if (!row) break;
      if ("close" in row) {
        if (row.close.some((s) => this.open.has(s))) break;
        this.state.cursor++;
      } else if ("send" in row) {
        let end = this.state.cursor;
        while (this.rows[end] && "send" in this.rows[end]!) end++;
        const group = end - this.state.cursor;
        if (this.state.received.length < group) break;
        this.state.cursor = end;
        this.state.received = [];
      } else break;
    }
    this.save();
  }

  private changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
      this.waiters.push(resolve);
    });
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private save(): void {
    if (this.statePath) writeFileSync(this.statePath, JSON.stringify(this.state));
  }

  private fault(message: string): HarnessEvent {
    this.faults.push(message);
    return { type: "failure", retryable: false, message: `mock fault: ${message}` };
  }

  // --- replies ----------------------------------------------------------------------------------

  private expand(reply: Reply, sessionModel: string): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    if (reply.usage) events.push({ type: "usage", cost: this.price(reply.usage.model ?? sessionModel, reply.usage) });
    if ("result" in reply) events.push({ type: "output", value: reply.result });
    else if (reply.no_value !== undefined) events.push({ type: "no_value", reason: reply.no_value });
    else if (reply.error)
      events.push({
        type: "failure",
        retryable: reply.error.retryable,
        message: reply.error.message,
        ...(reply.error.backoff_ms !== undefined && { backoffMs: reply.error.backoff_ms }),
      });
    return events;
  }

  /** Exact cost in 1e-8 USD: tokens × price in cents per million tokens (mock-harness.md §7). */
  private price(model: string, tokens: Tokens): Usd {
    const table = this.pricing[model];
    if (!table) throw new MockFault(`unknown model '${model}'`);
    const cents = (price: string) => BigInt(price.replace(".", ""));
    return (
      BigInt(tokens.input_tokens ?? 0) * cents(table.input) +
      BigInt(tokens.output_tokens ?? 0) * cents(table.output) +
      BigInt(tokens.cache_read_tokens ?? 0) * cents(table.cache_read) +
      BigInt(tokens.cache_write_tokens ?? 0) * cents(table.cache_write)
    );
  }
}
