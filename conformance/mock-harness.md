# The `mock` harness contract

**Contract version:** 0.1 **Applies to:** SFML v0.1, Annex B **Status:** Draft

Annex B of SPEC.md requires every Runner to ship a mock harness that replays canned agent scripts
and reproduces the routing trace and `FactoryState` a conformance case declares. This document is
that contract: what a Runner sends the mock, what the mock streams back, how scripts are laid out on
disk, how cost is priced, and what the mock does when a Runner breaks the contract.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as in SPEC.md §3.1.

Machine-readable versions of every data shape here live in `schema/`:

| Shape                                   | Schema                              |
| --------------------------------------- | ----------------------------------- |
| Agent script (`agents/<agent>.yaml`)    | `schema/agent-script.schema.json`   |
| Turn request (Runner → mock)            | `schema/mock-stream.schema.json#/$defs/TurnRequest` |
| Stream event (mock → Runner)            | `schema/mock-stream.schema.json#/$defs/Event`       |
| Pricing table (`models.json`)           | `schema/models.schema.json`         |

---

## 1. Design goals

1. **It behaves like a real harness.** Claude Agent SDK, Codex, Pi, and Hermes Agent all have the
   same basic shape. You open a session, or resume one by id. You send a prompt and get back an
   async stream of events: text, reasoning, tool calls, and usage. The stream ends with exactly one
   terminal event, either success with output or failure with a classification. The mock has the
   same shape, so a Runner's mock binding can have the same structure as its real bindings.
2. **It is async.** Every real harness makes network calls, so a Runner's harness boundary is async.
   The mock MUST yield control to the host's scheduler before delivering each event (for example
   `await Promise.resolve()` or `await asyncio.sleep(0)`), so that a Runner that accidentally
   serializes concurrent work does not pass by luck.
3. **It is deterministic.** For a given script and a given sequence of Runner calls, the mock
   produces the same events every time. It never reads wall-clock time (SPEC §1.2) or randomness.
   Where the order of events across concurrent streams would affect a case's outcome, the script
   fixes that order explicitly with a barrier (§6.4).
4. **It reports cost the way the spec requires.** Scripts state token usage per model. The mock
   prices that usage against a fixed table (`models.json`) and reports USD, exactly. It never uses
   floating point (§7).
5. **It catches Runner mistakes.** If a Runner opens a session where it should have resumed one,
   skips a retry, or renders a prompt wrongly, it uses up the script in the wrong order. The mock
   records that as a **conformance fault** (§9), and the fault fails the case whatever the Runner
   did afterwards.

## 2. Binding a step to the mock

A factory under test binds an agent step to the mock through the two extension points SPEC §13.4
allows:

```yaml
steps:
  implement:
    type: agent
    harness: mock
    harness_config:
      agent: coder
    prompt: "Implement ««prompt_vars.plan»»"
    result_schema: { type: object, required: [branch], properties: { branch: { type: string } } }
    next: [{ to: review }]
```

### 2.1 Harness reference

SPEC §6.12 leaves the resolution of `<name>[@<version>]` to the implementation. So the suite never
tests how a version string is interpreted. It uses exactly two harness reference literals:

| Literal                        | Every conforming implementation MUST…                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| `mock`                         | resolve it to its mock harness when running the conformance suite.    |
| `conformance-unknown-harness`  | fail to resolve it, rejecting the run at admission (SPEC §9.1).       |

No case writes an `@<version>` suffix on either.

### 2.2 `harness_config`

| Key     | Type      | Required | Meaning                                                                 |
| ------- | --------- | -------- | ----------------------------------------------------------------------- |
| `agent` | AgentName | yes      | The named agent whose script this step plays, i.e. `agents/<agent>.yaml`. |

An `AgentName` matches `^[a-z0-9][a-z0-9_-]{0,63}$`, so it is always a safe file stem.

Every agent a factory names MUST have a script in the case. The suite validator enforces this. If a
mock is nevertheless invoked for an agent with no script, it MUST fail the turn as a non-retryable
harness failure. The suite never relies on that path. A case that tests how failures are classified
scripts the failure explicitly (§6.1), so the behavior under test is visible in the case data rather
than implied by this contract.

### 2.3 One agent per step

Each agent serves exactly one step, and each step names its own agent. So every session in an
agent's script belongs to that one step, and two concurrent `parallel` children can never race for
the same script. `tools/validate-conformance.mjs` rejects a factory that names one agent from two
steps.

## 3. The async API

TODO: Is this interface something all of the harnesses will have? My assumption has been that each harness supported will need an implementor defined wrapper to normalize. If that is true, I'm not sure if defining interfaces for the mock harness is worth it. We are looking to define the source data used in the mock-harness and then to handle comformance testing in the conformce test cases. In neither of those spots does the internal stucture of the API matter.

The mock is a library object inside the implementation, not a network service. This contract
describes its surface in language-neutral terms. Each implementation exposes it in its own
language's idiom.

```ts
interface MockHarness {
  // Start one turn. Opens a new session when `resume` is absent; otherwise continues that session.
  run(request: TurnRequest): TurnStream;

  // Called by the conformance driver once a case has finished. Returns every fault (§9),
  // including scripted turns that were never used.
  verify(): Fault[];
}

interface TurnStream extends AsyncIterable<Event> {
  // Stop consuming before the terminal event. Idempotent. See §5.4.
  close(): Promise<void>;
}

interface TurnRequest {
  step: string;                          // qualified step name (SPEC §5.3), e.g. "checks.lint"
  prompt: string;                        // the rendered prompt (SPEC §9.9)
  harness_config: Record<string, any>;   // the step's harness_config, unexamined by the Runner
  output_schema?: object;                // the step's result_schema; informative only
  resume?: string;                       // a session_id the mock issued earlier
}
```

Python equivalent, for orientation:

```python
async with mock.run(TurnRequest(step="implement", prompt=p, harness_config=cfg)) as stream:
    async for event in stream:
        ...
```

`step` exists so that scripts can check which step a session serves (§6.3) and so that faults can
be reported clearly. No real harness takes a step name. Treat `step` as diagnostic metadata that the
mock binding adds.

### 3.1 How the pieces map to real harnesses (informative)

TODO: Probs not something we need in this document.

| Mock                           | Claude Agent SDK                     | Codex SDK                          | Pi                                   | Hermes Agent                         |
| ------------------------------ | ------------------------------------ | ---------------------------------- | ------------------------------------ | ------------------------------------ |
| `run({resume: undefined})`     | `query({prompt})`                    | `codex.startThread().runStreamed()`| new agent session, `prompt()`        | new run / chat                       |
| `run({resume: id})`            | `query({prompt, options:{resume}})`  | `codex.resumeThread(id).runStreamed()` | continue a session by `sessionId` | `X-Hermes-Session-Id` / `/api/sessions/{id}/chat` |
| `session.started`              | `system` / `init` (has `session_id`) | `thread.started` (`thread_id`)     | `agent_start`                        | session id on the run                |
| `turn.started`                 | —                                    | `turn.started`                     | `turn_start`                         | —                                    |
| `message` / `reasoning`        | `assistant` text / thinking blocks   | `item.completed` `agent_message` / `reasoning` | `message_end` (assistant)  | `message.delta` / `message.interim`  |
| `tool.call` / `tool.result`    | `tool_use` / `tool_result` blocks    | `item.*` `command_execution`, `mcp_tool_call`, … | `tool_execution_start` / `_end` | `tool.started` / `tool.completed` |
| `usage`                        | per-message `usage`                  | `turn.completed.usage`             | `usage` on assistant messages        | usage in completion payload          |
| `turn.completed.output`        | `result` with `structured_output`    | final response under `outputSchema`| final assistant message              | `run.completed`                      |
| `turn.failed`                  | `result` with `is_error: true`       | `turn.failed` / `error`            | `stopReason: "error"`                | `run.failed`                         |
| `models.json`                  | `total_cost_usd` (SDK-priced)        | tokens only; priced by the caller  | per-model `cost` per million tokens  | tokens by model; priced by the caller |

The mock uses one flat, dotted event vocabulary rather than copying any single SDK. A Runner's real
bindings translate each SDK's events into whatever internal shape the Runner uses. The mock binding
does the same translation, just a trivial one.

## 4. Sessions

A **session** is the unit of harness-side state that SPEC §11.7 requires a Runner to continue across
some resumes. A **turn** is one invocation of `run()`, which is one attempt (SPEC §3.2.6). A session
holds one or more turns.

### 4.1 Session ids

When the mock opens a session, it assigns the id `mock:<agent>:<n>`, where `<n>` counts that agent's
sessions from 1 in the order they were opened. The id is deterministic, so two conforming Runners
record the same ids for the same case. A Runner MUST treat the id as opaque. It MUST persist the id
with the entry it belongs to, because the id has to survive a process restart (§8).

### 4.2 Session order

An agent script lists `sessions` in order. **The *n*th time a Runner opens a new session for an
agent, the mock plays that agent's *n*th scripted session.** This is how a case says which session
belongs to which step entry. The order is fully determined, because:

- a factory's top-level control is sequential (SPEC §9.8), so entries into steps outside a
  `parallel` region happen in a single order fixed by the routing trace; and
- concurrent `parallel` children never share an agent (§2.3).

The *m*th turn played on a session (the first on open, then each continuation) plays that session's
*m*th scripted turn.

### 4.3 When a Runner opens a session and when it continues one

SPEC.md requires session continuity only on resume from `harness_error` and `budget_exceeded`
(§10.3, §10.6, §11.7). It leaves other invocations to the Runner. A script can only be replayed
deterministically if every Runner makes the same choice, so **a Runner's binding to the mock MUST
follow these rules**:

| Rule | Situation                                                                                                   | Session             |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| S1   | The first harness invocation of a step entry (SPEC §3.2.5), unless S3 applies                               | **open** a new one  |
| S2   | Any later invocation in the same entry: a retry attempt (SPEC §6.10), including an automatic reprompt after a failed schema validation (SPEC §10.4) | **continue** the entry's session |
| S3   | An entry opened by a resume that re-runs the step after `harness_error`, `schema_violation`, or `budget_exceeded`, including each still-incomplete child re-forked after a factory-level overrun (SPEC §10.6) | **continue** the session of the entry being resumed |
| S4   | S3, but the entry being resumed never invoked the harness (for example `budget: 0.00` raised on arrival)    | **open** (S1)       |
| S5   | A resume that supplies a result or a routing decision (SPEC §11.4)                                          | no invocation       |
| S6   | The entry after an `iteration_limit` grant, or a re-attempt after `expression_error`                        | **open** (S1)       |

S2 and S3 go further than SPEC.md for `schema_violation`. See the open questions in
`conformance/README.md`.

A Runner that breaks these rules plays the wrong scripted session or turn. Usually that shows up as
an `expectation_mismatch`, a `script_exhausted`, or an `unconsumed_turn` fault (§9).

### 4.4 One turn at a time

A session has at most one open turn. Calling `run({resume: id})` while a turn on `id` is still open
(it has not reached a terminal event and has not been closed) is a `session_busy` fault.

## 5. Stream events

Every event is a JSON object with this envelope:

| Field        | Type            | Meaning                                                             |
| ------------ | --------------- | ------------------------------------------------------------------- |
| `type`       | string          | One of the types below.                                             |
| `session_id` | string \| null  | The session this turn belongs to. `null` only for the config failure of §2.2. |
| `turn`       | integer ≥ 0     | 1-based turn index within the session. `0` only for the config failure of §2.2. |
| `seq`        | integer ≥ 0     | 0-based position of this event within the turn's stream.            |

### 5.1 Lifecycle events

- **`session.started`** `{ agent, model }`. The first event of a turn that opened a new session, and
  only that turn.
- **`turn.started`** `{ resumed: boolean }`. Comes right after `session.started` on an opening turn
  (`resumed: false`), or first on a continuing turn (`resumed: true`).

### 5.2 Content events

Content events are for realism only. A Runner MAY log them and MUST NOT base any SFML behavior on
them.

- **`message`** `{ text }`. Assistant-visible text.
- **`reasoning`** `{ text }`. Reasoning or thinking text.
- **`tool.call`** `{ call_id, name, input }`. The agent called a tool. The harness executes it, so
  the Runner does nothing.
- **`tool.result`** `{ call_id, output, is_error }`. The result of that call.

### 5.3 Usage and terminal events

- **`usage`** `{ model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cost_usd, turn_cost_usd }`. A consumption report. `cost_usd` is what this event cost.
  `turn_cost_usd` is the running total for the turn so far.
- **`turn.completed`** `{ output, total_cost_usd, usage }`. The turn succeeded. `output` is any JSON
  value, which becomes the step's candidate `StepResult`. The Runner validates it against
  `result_schema`. The mock does not validate it.
- **`turn.failed`** `{ error: { message, retryable, backoff_ms? }, total_cost_usd, usage }`. The turn
  failed. This is the failure classification that SPEC §10.3 requires.

On both terminal events, `usage` is a per-model rollup, `{ "<model>": { input_tokens, output_tokens,
cache_read_tokens, cache_write_tokens, cost_usd } }`, in the spirit of the Claude Agent SDK's
`modelUsage`. `total_cost_usd` is the sum of the turn's `usage` events. **It is a summary, not a new
report.** A Runner MUST NOT add it to consumption a second time.

Every stream has exactly one terminal event, and it is last. The only exception is a stream closed
early (§5.4).

### 5.4 Stopping early

A Runner MAY call `close()` before the terminal event. It MUST do so when SPEC §9.7 requires it to
stop an agent step. Closing:

- ends the turn. The turn counts as played, and the rest of its scripted events are thrown away;
- leaves the session open, so it can be continued (S3). The next continuation plays the session's
  next scripted turn;
- counts as the turn having **ended** for barrier purposes (§6.4).

### 5.5 Report points

For budget enforcement (SPEC §9.7), a Runner's **report points** in a mock stream are:

1. every `usage` event: add `cost_usd` to the step's and the run's consumption, then compare each
   with its effective ceiling; and
2. the terminal event: add nothing, but compare again before accepting the result.

When consumption reaches or exceeds a ceiling at a report point, the Runner stops the turn right
there: it calls `close()` and raises `budget_exceeded`. That also covers a turn whose own reports
stayed under the ceiling but whose run-level pool was pushed over it by a concurrent sibling. Point 2
is what makes "the next point it would report consumption" (SPEC §9.7) well defined for a sibling
that has nothing more to report.

Failed turns cost money too. Every `usage` event counts toward consumption, whether the turn ends in
`turn.completed` or `turn.failed`.

## 6. Agent scripts

Each named agent has one script file, `agents/<agent>.yaml`, in the case directory. The file stem is
the agent's name.

TODO: should `mock: "0.1"` be `mock: "v0.1"`? Should the version be tied to the spec version at all or is the mock schema is own version?

TODO: How is `expect` supposed to be used? I see how the prompt could be used, but not the step. Are we saying that a harness should throw a `harness_expception` is the prompt text is not right? This makes some sense to me.

TODO: Events are often going to be pretty light. The example is a bit hard to parse. How does this connect to user and system messages. This feels like its both too verbose (do we care about testing different message types?) and too terse (each line means so much with so little).

```yaml
mock: "0.1"          # script format version
sessions:
  - name: first-pass          # optional label, unique within the file; used in fault messages
    model: mock-medium        # default model for this session's usage events
    turns:
      - expect:
          step: implement
          prompt: "Implement the plan: add a flag"
        events:
          - message: "Reading the plan."
          - tool_call: { id: t1, name: bash, input: { cmd: "ls" } }
          - tool_result: { id: t1, output: "src/" }
          - usage: { input_tokens: 12000, output_tokens: 3000 }
          - complete: { output: { branch: "feat/flag" } }
  - name: after-review
    model: mock-medium
    turns:
      - events:
          - fail: { message: "429 rate limited", retryable: true, backoff_ms: 0 }
      - events:                                  # S2: the retry continues this session
          - usage: { output_tokens: 2000 }
          - complete: { output: { branch: "feat/flag" } }
```

### 6.1 Script events

TODO: What is the min set we need here?

Each scripted event is a map with exactly one key, which names its kind.

| Script event                                  | Emits                  | Notes                                                              |
| --------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `message: <string>`                           | `message`              |                                                                    |
| `reasoning: <string>`                         | `reasoning`            |                                                                    |
| `tool_call: { id, name, input }`              | `tool.call`            | `id` becomes `call_id`.                                            |
| `tool_result: { id, output, is_error? }`      | `tool.result`          | `id` MUST match an earlier `tool_call` in the same turn. `is_error` defaults to `false`. |
| `usage: { model?, input_tokens?, output_tokens?, cache_read_tokens?, cache_write_tokens? }` | `usage` | Token counts default to `0`. `model` defaults to the session's `model` and MUST be a key of `models.json`. |
| `barrier: <name>`                             | nothing                | A synchronization point (§6.4).                                    |
| `complete: { output }`                        | `turn.completed`       | Terminal. `output` is any JSON value; a value that fails `result_schema` is how a case scripts a `schema_violation`. |
| `fail: { message, retryable, backoff_ms? }`   | `turn.failed`          | Terminal.                                                          |

A turn's `events` MUST end with exactly one terminal event (`complete` or `fail`) and MUST NOT have
one anywhere else.

The mock adds the lifecycle events itself (`session.started`, `turn.started`). A script never
contains them.

### 6.2 Backoff

`backoff_ms` is what the harness says about retry spacing. SPEC §6.10 says a Runner SHOULD honor it.
Scripts SHOULD use `0` or small values. No case asserts on timing, so a Runner that sleeps and one
that doesn't both conform.

### 6.3 Expectations

TODO: Not sure how step gets in. Not sure it should. Per exceptation_mismatch, I think we are saying this is a non-retryable harness_exception. Is that right?

A turn MAY have an `expect` block. The mock checks it against the `TurnRequest` before emitting any
event:

| Key      | Checks                                                                                       |
| -------- | -------------------------------------------------------------------------------------------- |
| `step`   | `request.step` equals this qualified step name.                                              |
| `prompt` | `request.prompt` equals this string exactly, byte for byte after UTF-8 encoding. This is how cases test SPEC §7.9 and §9.9. |

A mismatch is an `expectation_mismatch` fault (§9). SPEC.md does not define the prompt a Runner
sends on a retry or a re-run, and SPEC §10.4 encourages adding validator feedback. So `expect.prompt`
SHOULD appear only on the first turn of a session.

### 6.4 Barriers

TODO: One problem with this way of thinking is that tests to are checking that an implemenation stops when a check happens are being helped here. What this seems to be showing is that a parallel step has a series of agent messages that should be delivered in a set order. Maybe we need a file that can handle that. This could be a huge change to how agent files work or just a split on parallel. Once version of the world I could see is one where there is a single agent file of messages. Each row is a single message naming if its sent or returned and which agents/agent-session returns it. A connection would be open for a single agent as long as a sent message has not has a return message.

A `barrier: <name>` event fixes an order across concurrent streams when a case's outcome would
otherwise depend on timing. The one case in v0.1 that needs it is a factory-level budget crossed
inside a `parallel` region (SPEC §9.7, §10.6).

- A barrier name appears in two or more scripted events across the whole case, each in a different
  agent's script. Those events are the barrier's **parties**. Reusing a name is not allowed: each
  name is one rendezvous.
- A stream that reaches a barrier waits there. The stream releases once every other party has either
  reached the barrier or belongs to a turn that has **ended** (terminal event delivered, or
  `close()`d).
- A party whose turn has not started yet is still pending. So a Runner that runs `parallel` children
  one after another, rather than concurrently (SPEC §9.8), deadlocks at the barrier. The conformance
  driver's per-case timeout (see `README.md`) turns that into a failure.

Worked example: each of two children reports `0.60` against a run budget of `1.00`, then hits
barrier `reported`, then completes. The first report takes the pool to `0.60` and that child waits.
The second report takes the pool to `1.20`, so the Runner closes the second child. Its turn has
ended, so the barrier releases. The first child reaches its terminal event, which is a report point
(§5.5); the pool is over the ceiling, so the Runner closes it too. The outcome is the same whichever
child reported first: both children are incomplete, and `budget_exceeded` is raised on the
`parallel` step.

## 7. Cost

### 7.1 The pricing table

`conformance/models.json` is the one pricing table every implementation's mock MUST use. It lists
each mock model's price in USD per 1,000,000 tokens for four token classes: `input`, `output`,
`cache_read`, and `cache_write`. Each price is a decimal string with at most two decimal places.

The table's model names are made up (`mock-large`, `mock-medium`, `mock-small`, `mock-local`) so
that no case depends on a real vendor's price list. Their prices resemble real tiers, so costs look
realistic. `mock-local` is free: every token costs `0.00`, which is the legitimate zero of SPEC
§9.7.

### 7.2 Exact arithmetic

Prices have at most two decimal places per million tokens, so the cost of any whole number of tokens
is an exact integer number of **1e-8 USD** ("nano-units" below):

```
cost_nano(event) = Σ over token classes k of  tokens_k × cents_per_Mtok_k
```

For example, 20,000 `mock-small` output tokens cost `20000 × 500 = 10,000,000` nano-units, which is
exactly `0.10` USD.

- The mock MUST compute cost this way, with integers (or an exact decimal type), never binary
  floating point.
- Every `*_cost_usd` field is a **decimal string with exactly 8 fractional digits**, for example
  `"0.10000000"`. It is a string so that no JSON parser turns it into a float.
- A Runner SHOULD keep consumption, budgets, and grants in nano-units, or in any exact type that can
  represent 8 fractional digits. A `budget` of `0.30` is `30,000,000` nano-units. The comparison is
  `consumption >= effective_budget` (SPEC §10.6, "reaches or exceeds").
- A Runner MUST NOT round a report before adding it. Three reports of `0.004` add up to `0.012` and
  exceed a `0.01` budget. Rounding each report to cents first would give `0.00` and never exceed it.

### 7.3 Unknown models

A script that names a model not in `models.json` is malformed. The case validator rejects it, and a
mock that loads it anyway MUST record a `script_invalid` fault rather than guess a price.

## 8. Durability across a Runner restart

A real harness keeps its sessions on the server, where they survive the Runner process dying. The
mock has to match that: **the mock's play state (which sessions exist, how many turns each has
played) MUST survive a Runner restart within a case.** How it survives is up to the implementation.
A JSON file in the case's scratch directory, written before each turn's first event and after each
turn ends, is enough.

The conformance driver restarts a Runner only when no branch is `running` (see `restart` in
`README.md`), so no turn is ever in flight across a restart and barrier state never needs to
persist.

## 9. Conformance faults

A **fault** is a Runner or script defect that the mock detects. A fault is *not* a harness failure:
it never shows up as `turn.failed` or turns into an SFML exception. The mock:

1. records it in the fault log that `verify()` returns;
2. if the fault happens during `run()`, ends that stream by throwing or raising a
   `MockConformanceError`, the host language's exception, before any further events.

**A case fails if `verify()` returns any fault**, even if the Runner caught the exception and the
final state happens to match.

| Fault                   | Raised when                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `script_exhausted`      | A Runner opens a session for an agent with no scripted sessions left, or continues a session with no scripted turns left. |
| `unknown_session`       | `resume` names a session id the mock never issued in this case.                               |
| `session_busy`          | A turn is requested on a session that already has an open turn (§4.4).                        |
| `expectation_mismatch`  | A turn's `expect` block does not match the request (§6.3).                                    |
| `unconsumed_turn`       | At `verify()`: a scripted turn was never played. This catches Runners that skip retries or re-runs. |
| `script_invalid`        | A script fails `schema/agent-script.schema.json` or the checks of §6 and §7.3.               |

A `tool_result` whose `id` has no matching `tool_call`, and a barrier with only one party, are
`script_invalid`.

## 10. Versioning

TODO: Note my confusion above on this. That is becuase 0.1 is being used.

The mock contract is versioned separately from SFML. Agent scripts declare `mock: "0.1"`. A mock
implementation MUST reject a script declaring a version it does not support, with a `script_invalid`
fault. Changes that would make an existing script play differently need a new version.
