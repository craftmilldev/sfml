# The `mock` harness

**Applies to:** SFML v0.1, Annex B **Status:** Draft

SPEC.md Annex B requires every Runner to ship a mock harness. The mock plays back canned agent
behavior so that a runner test (`conformance/runner/`) can check what the Runner does with it. This
document defines the mock's input, the **transcript**, and what a mock must do when it plays one
back.

The key words MUST, MUST NOT, SHOULD, and MAY are used as in SPEC.md §3.1. The machine-readable
transcript format is `schema/transcript.schema.json`, and the price table format is
`schema/models.schema.json`.

## 1. What the mock stands in for

A real harness binding has two parts: an agent SDK (Claude Agent SDK, Codex, …), and the wrapper
the implementation writes around it to report cost, classify failures, continue sessions, and get
a value out of the agent's output (SPEC §4.1.3). **The mock stands in for both parts together.** A
transcript reply carries what a wrapper hands the Runner once it has finished its own work:

- the value to validate against `result_schema` (already extracted, however the wrapper would have
  done it), or the fact that no value could be obtained (SPEC §10.4), or a failure with its
  retryability (SPEC §10.3);
- token usage per model, which the mock prices into USD (§6).

So a runner test checks what the Runner does with a harness's results. It does not check how any
particular wrapper talks to its SDK. This contract does not define the mock's programming
interface. Each implementation binds the mock into its own harness boundary however it binds its
real harnesses.

## 2. Binding a step to the mock

```yaml
steps:
  implement:
    type: agent
    harness: mock
    harness_config: { agent: coder }
    prompt: "Implement ««prompt_vars.plan»»"
    result_schema: { type: object, required: [branch], properties: { branch: { type: string } } }
    next: [{ to: review }]
```

- **Harness reference.** SPEC §6.12 leaves the resolution of `<name>[@<version>]` to the
  implementation, so the suite never tests how a version string is interpreted. It uses exactly two
  literals, and never adds an `@<version>` suffix to either:

  | Literal                       | A conforming implementation MUST…                          |
  | ----------------------------- | ---------------------------------------------------------- |
  | `mock`                        | resolve it to its mock harness.                            |
  | `conformance-unknown-harness` | fail to resolve it, rejecting the run at admission (SPEC §9.1). |

- **`harness_config`** is exactly `{ agent: <AgentName> }`. An `AgentName` matches
  `^[a-z0-9][a-z0-9_-]{0,63}$`. A mock MUST fail any other `harness_config` as a non-retryable
  failure.
- **One agent per step.** Each agent serves exactly one step. So the transcript's sessions for an
  agent all belong to that step, and concurrent `parallel` children never share an agent.

## 3. The transcript

A runner test whose factory has agent steps supplies `transcript.yaml`. It is the whole
conversation between the Runner and the mock for that test, in order: a list of rows, each of which
is one of `send`, `reply`, or `close`.

```yaml
- send:  { session: poll-1, agent: poller, model: mock-small, prompt: "Is the deploy finished?" }
- reply: { session: poll-1, usage: { output_tokens: 20000 }, result: { done: false } }
- send:  { session: poll-2, agent: poller, model: mock-small }
- reply: { session: poll-2, usage: { output_tokens: 20000 } }
- close: [poll-2]
- send:  { session: poll-2 }
- reply: { session: poll-2, usage: { output_tokens: 10000 }, result: { done: true } }
```

A session label (`poll-1`) names one harness session within the test. Labels are local to the
transcript. The Runner never sees them, and they don't have to look like real session ids.

### 3.1 `send`: the Runner invokes the harness

| Field     | Required                    | Meaning                                                                     |
| --------- | --------------------------- | --------------------------------------------------------------------------- |
| `session` | yes                         | The session this invocation belongs to.                                     |
| `agent`   | on a label's first `send`   | The agent the Runner must name in `harness_config.agent`.                   |
| `model`   | on a label's first `send`   | The session's default model for pricing; a key of `models.json`.            |
| `prompt`  | no                          | When present, the SFML-rendered prompt (SPEC §9.9) must equal it exactly.   |

- **A label's first `send` means the Runner must open a new session.** A later `send` with the same
  label means the Runner must continue that session.
- **`prompt` is the SFML-rendered prompt,** meaning the template after placeholder substitution
  (SPEC §7.9, §9.9). It does not include anything a harness wrapper would add around it, such as
  instructions to answer in a fenced JSON block. Tests include `prompt` only when they are testing
  rendering.
- **Consecutive `send` rows form a group** that may arrive in any order. This is how the concurrent
  children of a `parallel` step start (SPEC §9.8).

### 3.2 `reply`: the harness answers

| Field      | Meaning                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `session`  | The session answering. Its stream must be open.                                               |
| `usage`    | Optional. Tokens consumed: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` (each defaults to 0), and optionally `model` (defaults to the session's). |
| `result`   | Terminal. The value to validate against `result_schema`. Any JSON value, including one that fails validation. |
| `no_value` | Terminal. A string: the harness produced output but no value could be obtained from it (SPEC §10.4). |
| `error`    | Terminal. `{ message, retryable, backoff_ms? }`: the harness failed (SPEC §10.3).              |

A reply has at least one field besides `session`, and at most one terminal field. The mock delivers
a reply's usage first, then its terminal outcome. A session's stream ends at a terminal outcome.
Several usage-only replies can precede it.

### 3.3 `close`: the Runner must stop these sessions

`close: [labels…]` is satisfied once the Runner has stopped every listed session's stream (SPEC
§9.7). A listed stream can be one still waiting for its next reply. It can also be one whose last
reply combined `usage` with a terminal outcome: the mock delivers the usage first, and the Runner
must stop there, before taking the outcome. This is how a test puts in front of the Runner a result
it must not accept. A listed stream that instead runs on to its terminal outcome is a mismatch (§7).

```yaml
- reply: { session: poll-3, usage: { output_tokens: 20000 }, result: { done: false } }  # crosses the budget
- close: [poll-3]                                                                        # stop before the result
```

### 3.4 Order and determinism

The mock plays rows in order. It releases a row only after the Runner has finished with the one
before it: it has asked for its next event on that stream, or has stopped the stream. So the Runner
sees one fixed order of events across all its concurrent streams, and no row depends on timing or
wall-clock time (SPEC §1.2). A mock MUST NOT deliver an event synchronously within the call that
requested it. Real harnesses make network calls, and a Runner that accidentally serializes
concurrent work should not pass by luck.

A Runner that fails to start the children of a `parallel` step concurrently never completes the
`send` group, and the test times out (README §3.3).

## 4. Sessions

The transcript's session labels encode SPEC §11.7's rules for when a Runner continues a session and
when it opens a new one:

| Situation                                                                                         | Session  | SPEC §11.7 |
| -------------------------------------------------------------------------------------------------- | -------- | ---------- |
| A new entry into a step (SPEC §3.2.5), including a loop coming back to it                          | new      | rule 1     |
| A retry attempt within an entry (SPEC §6.10), including a re-attempt after failed validation       | continue | rule 2     |
| A re-run after `harness_error`, `schema_violation`, or `budget_exceeded`                           | continue | rule 3     |
| A re-run after `budget_exceeded` raised on arrival, before any invocation                          | new      | rule 3 → 1 |
| A resume that supplies a result or a routing decision (SPEC §11.4)                                 | none     | rule 4     |

The mock must also keep its place across a Runner restart (README §3.2, `restart`). Which sessions
exist, and how far the transcript has been played, survive the restart, just as a real harness
keeps its sessions server-side.

## 5. Report points

For budget enforcement (SPEC §9.7), every `usage` delivered is a consumption report. The Runner adds
it to the step's and the run's consumption and compares each against its effective ceiling. Every
terminal outcome is also a point where the Runner compares again, without adding anything. When a
ceiling is reached, the Runner stops there. That includes stopping a concurrent sibling whose own
reports stayed under the ceiling but whose run-level pool a sibling pushed over. Failed turns cost
money too: usage delivered before an `error` counts.

## 6. Cost

`models.json` is the one price table every mock MUST use. It gives USD per 1,000,000 tokens for
`input`, `output`, `cache_read`, and `cache_write`, as decimal strings with at most two decimal
places. Its model names (`mock-large`, `mock-medium`, `mock-small`, `mock-local`) are made up, so
that no test depends on a vendor's price list. `mock-local` costs `0.00`: the legitimate measured
zero of SPEC §9.7.

Because prices have at most two decimal places per million tokens, the cost of any whole number of
tokens is an exact integer of 1e-8 USD:

```
cost (1e-8 USD) = Σ over token classes k of  tokens_k × price_k in cents per million tokens
```

A mock MUST price usage exactly this way, never in binary floating point. A Runner MUST NOT round a
report before adding it. Three reports of `0.004` add up to `0.012`, which exceeds a `0.01` budget.

## 7. When the Runner does not match the transcript

A `send` that matches no row in the current group is a mismatch. So is a wrong agent, a new session
where the transcript continues one (or the reverse), a prompt that differs, or a model missing from
`models.json`. On a mismatch, the mock fails that invocation as a non-retryable failure, so the run
visibly goes wrong. The mock also records the mismatch.

A runner test passes only if the Runner's observable results match the test's `expect`, and the
mock recorded no mismatch, and every transcript row was played.
