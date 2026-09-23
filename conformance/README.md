# SFML conformance suite

This directory is the conformance suite of SPEC.md Annex B. Each test states clear inputs and the
outputs a conforming implementation must produce from them. A test checks only outputs SPEC.md
defines. It never checks how an implementation produces them.

The key words MUST, MUST NOT, SHOULD, and MAY are used as in SPEC.md §3.1.

```
conformance/
  README.md          this file
  mock-harness.md    the mock harness that runner tests play back (Annex B)
  models.json        the price table the mock uses
  schema/            JSON Schemas (2020-12) for every file below
  parser/<test>/     clause 5: Parser, Linter, and Runner run these
  lint/<test>/       clause 8: Linter and Runner run these
  runner/<test>/     clauses 9–12: Runner runs these
```

A Linter must pass `parser/` and `lint/`. A Runner must pass all three (SPEC §4.1.3).

## 1. Using the suite

The directory is self-contained, so an implementation can vendor it (for example as a git
submodule) and point its test runner at it. The folder a test sits in gives its type:

| Folder    | Files                                                                             | What the implementation does                                                                       |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `parser/` | `case.yaml`, `factory.sfml` or `factory.sfml.json`                                | Parse the document; accept or reject it.                                                           |
| `lint/`   | `case.yaml`, `factory.sfml`                                                       | Lint the factory; report diagnostics.                                                               |
| `runner/` | `case.yaml`, `factory.sfml`, and `transcript.yaml` if the factory has agent steps | Perform `actions` against the factory, with the mock playing `transcript.yaml` (mock-harness.md). |

Every `case.yaml` has the same frame:

```yaml
description: What this test shows, in a sentence or two.
clauses: ["§8.3"]      # the SPEC.md clauses it exercises
expect: …              # the outputs to check; shape depends on the folder
```

Paths inside a test are relative to its folder. `models.json` is the only file shared across tests.

## 2. `parser/` and `lint/` tests

```yaml
# parser/duplicate-step-key/case.yaml
description: A step object with two `next` keys is a parse error, not "last value wins".
clauses: ["§5.6"]
expect:
  parse: reject          # accept | reject
  message: "unique"      # optional; case-insensitive regex the rejection's diagnostic must match
```

```yaml
# lint/non-total-routing/case.yaml
description: The last connection of a non-result step has a `when`.
clauses: ["§8.3"]
expect:
  diagnostics: [non-total-routing]
```

- A parser test's document is `factory.sfml`, or `factory.sfml.json` when the test is about JSON input
  (SPEC §5.1). SPEC.md defines no parse diagnostics, so `expect.parse` (accept or reject) is the
  whole normative output.
- `expect.message`, present only when `expect.parse: reject`, is optional: a regex, tested
  case-insensitively against the implementation's rejection message, that pins the test to the
  *reason* it must be rejected (SPEC.md defines no diagnostic identifiers for parse errors, so this
  is looser than `lint`'s `diagnostics`). A consumer that only cares about accept/reject can ignore
  it; one that wants to assert a fixture trips the right check (rather than being rejected for an
  unrelated reason) can use it instead of hardcoding a fixture→pattern map of its own.
- `diagnostics` is the set of §8.7 identifiers the Linter reports. Order and duplicates don't
  matter. Every listed identifier must be reported, and no other. `[]` means the factory is valid.

## 3. `runner/` tests

```yaml
# runner/budget-reached-exactly/case.yaml
description: >
  A step with `budget: 0.30` is exceeded by its third report of 0.10, and a grant lets it finish.
clauses: ["§9.7", "§10.6", "§11.7"]
actions:
  - start: {}
    expect:
      status: errored
      blocked: [{ step: poll, state: errored, exception: budget_exceeded }]
  - resume: { step: poll, payload: 0.10 }
expect:
  status: terminal
  outcome: complete
  value: { done: true }
  state:
    parameters: {}
    results:
      poll: [{ done: false }, { done: false }, { done: true }]
      finish: [{ done: true }]
```

### 3.1 Actions

`actions` is performed in order. After each action, the implementation waits until no branch of the
run is `running` (SPEC §11.1) before going on.

| Action                        | Meaning                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `start: { parameters? }`      | Ask for a run with these parameter values (SPEC §9.1). `parameters` defaults to `{}`. Always the first action, and only once. |
| `resume: { step, payload? }`  | Resume the run at `step`, qualified for a `parallel` child (SPEC §5.3, §11.3). An absent `payload` means no payload. `payload: null` is the JSON value `null` (a valid override for a `result` step, SPEC §10.7). |
| `restart: {}`                 | Simulate process death: discard every piece of in-memory Runner state, then reload the run from durable storage (SPEC §12.1). The mock keeps its place (mock-harness.md §4). |

A grant payload for `budget_exceeded` is written as a YAML number with at most two decimal places,
for example `0.10`. It MUST be read as an exact decimal, never carried into budget arithmetic as a
binary float.

### 3.2 Expectations

The top-level `expect` states how the run stands after the last action. An action may carry its own
`expect` for an intermediate check. The last action never does, so every state is stated once.

| Key        | Where                  | Meaning                                                                            |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `admitted` | `start`, or top level  | `false`: the run was rejected at admission (SPEC §9.1). It has no run id and no state, so nothing else is expected. `true` is the default. |
| `accepted` | a `resume`             | `false`: the resume was rejected at the call (SPEC §11.5) and the run is unchanged. `true` is the default. |
| `status`   | anywhere               | Run status (SPEC §11.2): `terminal`, `errored`, or `awaiting_input`.               |
| `blocked`  | anywhere               | Exactly the set of blocked branches, each `{ step, state, exception? }`. `exception` is required when `state` is `errored`. Order doesn't matter. |
| `outcome`, `value` | top level, when `status: terminal` | The result step's outcome and value (SPEC §6.8).            |
| `state`    | anywhere; required at top level unless `admitted: false` | The `FactoryState` (SPEC §9.2). |

`FactoryState` is compared as JSON values: object key order is ignored and list order matters.
`results` has a key for each step that has appended a result, and no key for one that hasn't. A
`parallel` child's results appear only inside its parent's result object. A `result` step's value
is appended under that step's name.

### 3.3 Passing

A runner test passes when every `expect` matches, the mock recorded no mismatch, and every
transcript row was played (mock-harness.md §7). Waiting for the run to settle SHOULD time out after
10 seconds, which fails the test. That is how a Runner that never finishes a `send` group, or never
stops a stream a `close` row names, shows up. No test depends on elapsed time.

## 4. Validating the suite

`npm run validate:conformance`, from the repository root, checks every test against `schema/`, and
then checks what a schema can't:

- each test has exactly the files its folder calls for;
- transcript rows reference sessions correctly: a label's first `send` names its agent and model,
  and replies and closes only name labels that have been opened;
- transcript agents and models match `factory.sfml` and `models.json`, and no agent serves two steps;
- `start` is the first action and appears once, and the last action carries no `expect`.

It does not run factories. Running them is each implementation's job.

## 5. Open questions for v0.1 feedback

These are settled for the suite only; SPEC.md is unchanged.

1. **Report points.** SPEC §9.7 says concurrent children stop "at the next point [they] would report
   consumption". The suite counts a terminal outcome as such a point (mock-harness.md §5), so a
   child with nothing more to report still stops.
2. **Parallel children in `FactoryState`.** SPEC.md implies, but does not say, that children have no
   `results` key of their own. §3.2 assumes they don't.
3. **Result steps in `results`.** SPEC §9.3 implies a `result` step appends its value. §3.2 assumes
   it does.
4. **Does `retry` count schema-violation attempts?** SPEC §6.10 describes `retry` as governing
   harness failures; SPEC §10.2 raises `schema_violation` once "retry, where configured, has not
   fixed it". `runner/schema-violation-override` reads `retry: 2` as two attempts in total.
5. **Process death mid-turn.** `restart` happens only once the run has settled, so no test covers a
   harness turn in flight at process death.
