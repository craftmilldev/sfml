// The conformance mock's backend: a fake "API server" that plays one transcript for one whole run.
//
// Plays the transcript format of conformance/mock-harness.md §3 (send / reply / close rows). This is
// the mock's counterpart to `query()` plus Anthropic's servers on the Claude side. Every session in
// a run talks to this one backend, which is why it, and not the wrapper, holds the state that orders
// replies across agents. The wrapper (mock.ts) is stateless, like the Claude wrapper. Like a real
// API, the backend reports tokens; pricing them is the wrapper's job.
//
// The backend releases a row only after the consumer has finished with the previous one (it has
// come back for the next reply, or has stopped that stream). So the Runner sees one fixed order of
// events across all its concurrent streams, with no timing involved.
//
// Its only state is the row cursor plus the sessions it has opened. That state is written to
// `statePath` after every change, so after a Runner restart a new backend picks up where the old one
// stopped, the way a real harness keeps sessions server-side. There is one backend per run: a second
// live backend over the same transcript would keep its own cursor and drift apart.
//
// Anything that does not match the transcript is a *fault*. The stream answers with a `fault`
// reply (the wrapper turns it into a non-retryable failure), and the fault is recorded for verify(),
// which fails the conformance case even if the Runner recovered.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import YAML from "yaml";
import type { Tokens } from "./pricing.js";

type RowTokens = { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
type Send = { session: string; agent?: string; model?: string; prompt?: string };
type Reply = {
  session: string;
  usage?: RowTokens & { model?: string };
  result?: unknown;
  no_value?: string;
  error?: { message: string; retryable: boolean; backoff_ms?: number };
};
export type Row = { send: Send } | { reply: Reply } | { close: string[] };

export type BackendRequest = {
  /** Qualified step name, for fault messages. */
  step: string;
  agent: string;
  prompt: string;
  /** Session to continue. Absent: open a new one. */
  session?: string;
  signal: AbortSignal;
};

export type BackendReply =
  | { type: "session"; session: string }
  | { type: "usage"; model: string; tokens: Tokens }
  | { type: "result"; value: unknown }
  | { type: "no_value"; reason: string }
  | { type: "error"; message: string; retryable: boolean; backoffMs?: number }
  | { type: "fault"; message: string };

type State = {
  cursor: number;
  /** Rows of the current send group already received. */
  received: number[];
  sessions: Record<string, { agent: string; model: string }>;
};

export class MockBackend {
  private state: State = { cursor: 0, received: [], sessions: {} };
  private readonly open = new Set<string>();
  /** Sessions whose stream ran to its terminal outcome since their last send. A close row may not name them. */
  private readonly ranToEnd = new Set<string>();
  /** True while a reply is in flight and its consumer has not yet come back for more. */
  private delivering = false;
  private waiters: Array<() => void> = [];
  readonly faults: string[] = [];

  constructor(
    private readonly rows: Row[],
    private readonly statePath?: string,
  ) {
    if (statePath && existsSync(statePath)) this.state = JSON.parse(readFileSync(statePath, "utf8")) as State;
  }

  static fromFiles(paths: { transcript: string; state?: string }): MockBackend {
    return new MockBackend(YAML.parse(readFileSync(paths.transcript, "utf8")) as Row[], paths.state);
  }

  /** Sends one prompt and streams the replies, like one `query()` call. */
  async *send(req: BackendRequest): AsyncGenerator<BackendReply> {
    await setImmediate(); // behave like a network call: never answer synchronously

    const accepted = await this.receiveSend(req);
    if (typeof accepted !== "string") {
      yield this.fault(accepted.fault);
      return;
    }
    const id = accepted;
    this.open.add(id);
    let owesDelivery = false;
    try {
      yield { type: "session", session: id };
      for (;;) {
        if (req.signal.aborted) return;
        const row = this.rows[this.state.cursor];
        if (row && "reply" in row && row.reply.session === id && !this.delivering) {
          this.delivering = owesDelivery = true;
          this.state.cursor++;
          this.save();
          const replies = expand(row.reply, this.state.sessions[id]!.model);
          for (const reply of replies) {
            await setImmediate();
            if (req.signal.aborted) return;
            // Mark before handing it over: a consumer that takes the terminal reply may close this
            // generator at the yield, so nothing after the yield is guaranteed to run.
            if (reply.type !== "usage") this.ranToEnd.add(id);
            yield reply;
          }
          this.delivering = owesDelivery = false;
          this.notify();
          if (replies.some((r) => r.type !== "usage")) return;
          continue;
        }
        if (row && "reply" in row && !this.open.has(row.reply.session)) {
          yield this.fault(`reply row ${this.state.cursor} is for session '${row.reply.session}', whose stream was already stopped`);
          return;
        }
        await this.changed(req.signal);
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

  /** Matches a request to a send row in the current group. Returns the session id, or a fault. */
  private async receiveSend(req: BackendRequest): Promise<string | { fault: string }> {
    // A send can only arrive while the cursor is on a send group. If streams are still closing, the
    // cursor may be about to reach one, so wait for them first.
    while (!this.atSend() && this.open.size > 0 && !req.signal.aborted) await this.changed(req.signal);
    if (!this.atSend()) return { fault: `${req.step}: unexpected send at row ${this.state.cursor}` };

    for (let i = this.state.cursor; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      if (!("send" in row)) break;
      if (this.state.received.includes(i)) continue;
      const send = row.send;
      const known = send.session in this.state.sessions;
      const matches = req.session ? send.session === req.session && known : !known && send.agent === req.agent;
      if (!matches) continue;

      if (send.prompt !== undefined && send.prompt !== req.prompt)
        return { fault: `${req.step}: prompt does not match row ${i}\n  expected: ${JSON.stringify(send.prompt)}\n  received: ${JSON.stringify(req.prompt)}` };
      if (!known) {
        if (!send.model) return { fault: `row ${i}: a new session needs a model` };
        this.state.sessions[send.session] = { agent: req.agent, model: send.model };
      }
      this.state.received.push(i);
      this.ranToEnd.delete(send.session);
      this.advance();
      this.notify();
      return send.session;
    }
    const wanted = req.session ? `session '${req.session}'` : `a new session for agent '${req.agent}'`;
    return { fault: `${req.step}: no send in the group at row ${this.state.cursor} matches ${wanted}` };
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
        for (const s of row.close.filter((s) => this.ranToEnd.has(s)))
          this.faults.push(`close row ${this.state.cursor}: the Runner took '${s}' to its terminal outcome instead of stopping it`);
        this.state.cursor++;
      } else if ("send" in row) {
        let end = this.state.cursor;
        while (this.rows[end] && "send" in this.rows[end]!) end++;
        if (this.state.received.length < end - this.state.cursor) break;
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

  private fault(message: string): BackendReply {
    this.faults.push(message);
    return { type: "fault", message };
  }
}

function expand(reply: Reply, sessionModel: string): BackendReply[] {
  const replies: BackendReply[] = [];
  if (reply.usage) {
    const u = reply.usage;
    replies.push({
      type: "usage",
      model: u.model ?? sessionModel,
      tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_tokens ?? 0, cacheWrite: u.cache_write_tokens ?? 0 },
    });
  }
  if ("result" in reply) replies.push({ type: "result", value: reply.result });
  else if (reply.no_value !== undefined) replies.push({ type: "no_value", reason: reply.no_value });
  else if (reply.error)
    replies.push({
      type: "error",
      message: reply.error.message,
      retryable: reply.error.retryable,
      ...(reply.error.backoff_ms !== undefined && { backoffMs: reply.error.backoff_ms }),
    });
  return replies;
}
