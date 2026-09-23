# SFML conformance suite

This directory is the conformance test suite that SPEC.md Annex B refers to. Annex B defers the
exact file formats to this document. The mock harness that `runner/` cases run against has its own
contract, [`mock-harness.md`](mock-harness.md).

The key words MUST, MUST NOT, SHOULD, and MAY are used as in SPEC.md §3.1.

```
conformance/
  README.md              this file: suite layout and case formats
  mock-harness.md        the mock harness contract
  models.json            the pricing table every mock MUST use
  schema/                JSON Schemas (2020-12) for every file format below
  tools/validate.mjs     checks every case against the schemas and the cross-file rules
  parser/<case>/         clause 5 cases        (Parser, Linter, Runner)
  lint/<case>/           clause 8 cases        (Linter, Runner)
  runner/<case>/         clauses 9–12 cases    (Runner)
```

Each class must pass its own directory and the ones before it. A Linter passes `parser/` and
`lint/`. A Runner passes all three (SPEC §4.1.3).

Every case directory has a `case.yaml` manifest. Its `class` field MUST match the top-level
directory the case lives in. Its `clauses` field lists the SPEC.md clauses the case exercises, so a
failing case points to the text it tests.

---

## 1. `parser/` cases

```
parser/<case>/
  case.yaml
  document.yaml      the raw document under test (bytes matter: encoding, duplicate keys)
```

```yaml
class: parser
description: A duplicate key inside a step is a parse error.
clauses: ["§5.6"]
expect: reject          # accept | reject
```

The implementation parses `document.yaml` and either accepts it or rejects it, which must match
`expect`. SPEC.md defines no parse diagnostics, so there is no identifier to compare.

## 2. `lint/` cases

```
lint/<case>/
  case.yaml
  factory.yaml
```

```yaml
class: lint
description: The last connection of a non-result step carries a `when`.
clauses: ["§8.3"]
expect:
  diagnostics: [non-total-routing]     # empty list = the factory is valid
```

`diagnostics` is the set of §8.7 identifiers the Linter MUST report. The comparison ignores order
and duplicates. The Linter MUST report every listed identifier and no identifier that is not listed.
A case that expects `[]` is a positive case: the Linter must accept the factory cleanly.

## 3. `runner/` cases

```
runner/<case>/
  case.yaml            manifest and driver script
  factory.yaml         the SFML file under test
  agents/<agent>.yaml  one mock script per agent named by a step's harness_config.agent
  expect/
    result.yaml        how the run ends: admission rejected, terminal, or still blocked
    state.json         the FactoryState (SPEC §9.2) at the end
    trace.json         the routing trace (SPEC §9.11) at the end
```

`agents/` is present only if the factory has agent steps. `expect/state.json` and
`expect/trace.json` are absent when the run is rejected at admission, since such a run has no state
(SPEC §9.1).

### 3.1 Agents and files

A step selects its script by name: `harness_config: { agent: coder }` plays
`agents/coder.yaml`. The mapping is by convention, with no lookup table. `tools/validate.mjs` checks
that every agent named in `factory.yaml` has a script, and that every script is named by some step.
The only exception is a case that is deliberately testing a missing script (§3.6). The order of
sessions inside a script, and when a Runner opens or continues one, are defined in
[`mock-harness.md` §4](mock-harness.md#4-sessions).

### 3.2 `case.yaml`

```yaml
class: runner
description: A retryable failure is retried on the same session and then succeeds.
clauses: ["§6.10", "§10.3"]
drive:
  - start:
      parameters: { issue: "add a flag" }
    expect:
      admitted: true
      status: terminal
  # …more actions…
```

`drive` is an ordered list of **actions**. The conformance driver (the implementation's own test
runner) performs each one. After each action it **runs to quiescence**: it waits until no branch of
the run is `running` (SPEC §11.1). Then it checks the action's `expect`, if there is one. Every
action is a single-key map, plus an optional `expect`.

| Action                                  | Meaning                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `start: { parameters }`                 | Ask for a run with these parameter values (SPEC §9.1). `parameters` defaults to `{}`. MUST be the first action, and MUST appear only once. |
| `resume: { step, payload? }`            | Resume `(run_id, step)` (SPEC §11.3). **Whether `payload` is present matters**: an absent `payload` means "no payload"; `payload: null` means the JSON value `null` (a legal override for a `result` step, SPEC §10.7). |
| `restart: {}`                           | Simulate process death: throw away every piece of in-memory Runner state, then reload the run from the Runner's durable storage (SPEC §12.1). The mock's play state survives (mock-harness §8). Allowed only when the run is quiescent, which is always true between actions. |

An action's `expect` MAY contain:

| Key        | For          | Meaning                                                                                                             |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `admitted` | `start`      | `true`: a run id was minted. `false`: the run was rejected at admission (SPEC §9.1). After `false`, no action may follow. |
| `accepted` | `resume`     | `true`: the resume was taken. `false`: it was rejected at the call (SPEC §11.3, §11.5), and the run MUST be unchanged. Defaults to `true`. |
| `status`   | any          | Derived run status (SPEC §11.2): `errored`, `awaiting_input`, or `terminal`.                                        |
| `blocked`  | any          | The exact set of blocked branches, as `{ step, state, exception? }`. `step` is qualified (SPEC §5.3). `state` is `errored` or `awaiting_input`. `exception` is required for `errored` and is a clause 10 class. The comparison ignores order. |
| `state`    | any          | The whole `FactoryState` at this point, in the same format as `expect/state.json`.                                 |
| `trace`    | any          | The whole routing trace so far, in the same format as `expect/trace.json`.                                         |

A grant payload for `budget_exceeded` is a Decimal USD (SPEC §6.1). Cases write it as a YAML number
with at most two decimal places, such as `payload: 0.10`. A driver MUST turn it into an exact
decimal, for example by reading the scalar's source text or by rounding the parsed float to cents,
and MUST NOT carry a binary float into budget arithmetic.

The driver MUST put a per-case timeout on running to quiescence. The suite uses **10 seconds**. A
timeout fails the case. This is how a barrier deadlock (mock-harness §6.4) or a hung Runner shows up.
The timeout is a test-harness guard, not SFML behavior. No case depends on elapsed time.

### 3.3 `expect/result.yaml`

This is the "result file" that Annex B requires. It has exactly one of three shapes:

```yaml
# The run was never admitted.
admission: rejected
```

```yaml
# The run reached a result step (SPEC §9.10).
outcome: complete            # complete | terminal_failure
value: { branch: "feat/x" }  # the result step's value (SPEC §6.8); required
```

```yaml
# The run is still blocked on at least one exception (it "raises a named exception").
status: errored              # errored | awaiting_input
blocked:
  - { step: checks, state: errored, exception: budget_exceeded }
```

The driver checks it after the last `drive` action.

### 3.4 `expect/state.json`

This is the `FactoryState` of SPEC §9.2: `{ "parameters": {…}, "results": { "<StepName>": [ … ] } }`.

- `parameters` holds the values after admission, including defaults.
- `results` has a key for every step that has appended at least one `StepResult`, and no key for a
  step that has not. A `parallel` child's results appear only inside its parent's result object
  (SPEC §6.7), never under a key of their own. A `result` step's value is appended under that step's
  name (SPEC §9.3).
- The comparison is JSON value equality: object key order is ignored and numbers compare by value.
  List order matters.

### 3.5 `expect/trace.json`

The routing trace (SPEC §9.11) is a JSON array of `StepName`s. It starts with `start` and then lists
each routing decision's target, in order:

```json
["plan", "implement", "checks", "review", "implement", "checks", "review", "shipped"]
```

- Each consecutive pair is one route decision (SPEC §9.5). Arriving at a step appears once, even
  if the arrival raised on entry (`iteration_limit`, `budget: 0.00`) and was later resumed. A
  resume re-runs the step in the same place rather than routing into it again.
- A resume from `routing_error` with a target payload (SPEC §10.8) records that target, just as if
  `when` had chosen it.
- `parallel` children do not appear. They run concurrently and their relative order is not
  deterministic. The `parallel` step itself does appear.

### 3.6 Special agents

A case that deliberately names an agent with no script (to test the non-retryable config failure of
mock-harness §2.2) declares it so the validator doesn't flag it:

```yaml
unscripted_agents: [ghost]
```

---

## 4. Validating the suite

```
cd conformance/tools && npm install && node validate.mjs
```

The validator checks every case against `schema/`, and then checks the rules a schema cannot
express:

- `class` matches the directory, and the required files for that class are present;
- a script's `agent` equals its file stem, and scripts correspond to the `harness_config.agent`
  values in `factory.yaml`;
- two children of the same `parallel` step don't share an agent (mock-harness §2.3);
- every `usage.model` and session `model` is in `models.json`;
- every `tool_result.id` matches an earlier `tool_call` in its turn;
- every barrier name has at least two parties, in different agents' scripts;
- `start` comes first and only once, and nothing follows `admitted: false`.

It also checks `mock-harness.golden.json`, the exact stream a conforming mock emits for one scripted
turn, by re-deriving it from the script and `models.json`. Mock implementations can use that file
as a unit-test fixture.

It does not run factories. The suite is data. Running it is each implementation's job.

The worked example in `example/` (SPEC Annex C) uses the same runner-case layout: `factory.yaml`,
`agents/`, and optionally `case.yaml` and `expect/`. So it runs on the same mock and can be checked
the same way.

## 5. Open questions for v0.1 feedback

The following questions came up while defining these contracts. Each one is settled here for the
mock only; SPEC.md is unchanged. They should be looked at again once the example implementation is
in hand.

1. **Session continuity on `schema_violation`.** SPEC §10.4 says a resume re-runs the step "as a new
   agent turn" but, unlike §10.3, does not say "on the same harness session". Mock rule S3 requires
   the same session. That matches S2, where automatic reprompts carry validator feedback, which only
   makes sense inside a conversation.
2. **Session continuity on retry attempts.** SPEC §6.10 is silent. Mock rule S2 requires the same
   session.
3. **Report points.** SPEC §9.7 says concurrent children stop "at the next point [they] would report
   consumption". The mock defines the terminal event as a report point (mock-harness §5.5), so a
   child with nothing more to report still stops.
4. **Parallel children in `FactoryState`.** SPEC.md implies, but does not say, that children have no
   `results` key of their own. §3.4 above assumes they don't.
5. **Result steps in `results`.** SPEC §9.3 implies a `result` step appends its value. §3.4 assumes
   it does.
6. **Process death mid-turn.** SPEC §12.1 requires resumability after process death but does not say
   what happens to a harness turn in flight. `restart` only happens at quiescence, so v0.1 cases
   never test it.
7. **Trace shape.** SPEC §9.11 defines the trace as "step entries and route decisions". §3.5 records
   it as the path of arrivals, which carries both and has no ambiguity about re-entries after a
   resume.
8. **Does `retry` count schema-violation attempts?** SPEC §6.10 describes `retry` as governing
   *harness* failures that are classified as retryable. SPEC §10.2 raises `schema_violation` once
   "retry, where configured, has not fixed it". `runner/schema-violation-override` reads `retry: 2`
   as two attempts in total, counting failed validations as well as harness failures.
