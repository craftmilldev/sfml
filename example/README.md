# SFML worked example (SPEC Annex C)

This is the worked example SPEC.md's Annex C points to, and — since it also implements a Parser,
Linter, and Runner and passes `conformance/` (Annex B) — a conformance case for this repository's own
spec. It runs two ways, per issue #13:

- **as a CLI**, against the real Claude Agent SDK harness (`src/cli/sfml.ts`), for running a factory
  against this project;
- **as a library**, stepping a factory through a mock-harness transcript one action at a time
  (`src/lib/stepper.ts`), for driving a web page that shows a run happening.

## Layout

```
src/
  engine/       Parser (parser.ts), Linter (linter.ts), Runner (runner.ts), the expression
                language (expr.ts), and the parsed data model (factory.ts).
  harness/      The harness boundary (types.ts) and its wrappers: claude-agent-sdk.ts (real),
                mock.ts + mock-backend.ts (conformance mock, Annex B).
  cli/          `sfml run` / `sfml resume` against claude-agent-sdk.
  lib/          `stepper.ts`: loads a factory + mock transcript and steps a run for a UI.
```

## CLI

```
sfml run <factory.sfml.yaml> [--param key=value ...] [--state <path>]
sfml resume <factory.sfml.yaml> --state <path> --step <name> [--payload <json>]
```

`run` admits and drives the factory to its first quiescent point (clause 9) and prints the
observation (`{status, blocked | outcome+value, state}`) as JSON. A run that ends `errored` or
`awaiting_input` is not a CLI failure — that's what `resume` is for. `--state <path>` persists the
run's `RunState` (results, branch status, budget/iteration ledgers, harness sessions) between
invocations, since each CLI invocation is its own process; without it, only single-action runs (no
blocking step) are useful. This state file is this CLI's own durability choice — SPEC §12.1 leaves
storage entirely to the implementation.

## Library (mock-harness stepper)

```ts
import { loadStepper } from "sfml-example/lib/stepper.js";

const loaded = loadStepper({ factory: bytes, transcript: rows, prices });
if (!loaded.ok) { /* loaded.stage: "parse" | "lint", loaded.message / loaded.diagnostics */ }

const { stepper } = loaded;
const { frame } = await stepper.start({ issue: "..." });
// frame.observation: what the run looks like now
// frame.events: the RunnerEvents (step-entered/succeeded/blocked, routed, terminal) since the last action
// stepper.timeline: every frame so far, for scrubbing back through the run

await stepper.resume("review", true, { approved: true });
stepper.restart(); // simulates a process restart; the mock's transcript cursor survives it
```

Any `runner/` conformance fixture's `factory.sfml.yaml` + `transcript.yaml` works here unmodified,
since it's the same mock (`mock-backend.ts`) every conformance case plays back.

## Running the tests

```
npm test              # from the repo root: schema + conformance-fixture validation, this package, examples/
npm --prefix example test   # this package alone: conformance suite + unit tests
```

`src/engine/conformance.test.ts` runs every case in `conformance/parser`, `conformance/lint`, and
`conformance/runner` against this Parser/Linter/Runner. All of it passes.

## Conformance suite coverage — gaps to flag

Issue #13 asked to flag any SPEC.md conformance case that doesn't seem present. Running the full
suite against a real implementation surfaced two real gaps, both about the suite's own coverage
rather than anything this example does differently from SPEC.md:

- **`conformance/lint/` has one fixture** (`non-total-routing`, §8.3). §8.7 registers twelve
  diagnostic identifiers; the other eleven — `unknown-step-reference`, `invalid-parallel-child-type`,
  `parallel-child-has-next`, `nested-parallel`, `field-not-applicable-to-type`, `unreachable-step`,
  `no-path-to-result`, `unbounded-cycle`, `unknown-parameter-reference`,
  `unknown-step-result-reference`, `unreachable-reference`, `binding-environment-violation` — have no
  `conformance/lint/<case>/` fixture that exercises a Linter in isolation. `conformance/parser/`
  covers several of the structural ones (e.g. `nested-parallel`, `parallel-child-has-next`) as parse
  rejections, since `sfml.schema.json` happens to reject them structurally too — but SPEC §8.2 assigns
  them to the Linter, not the Parser, and a Linter that (correctly, per SPEC) accepts a document its
  own Parser might reject, or is fed an already-parsed document from elsewhere, has no suite coverage
  for these rules. `example/src/engine/linter.test.ts` in this package exercises all twelve against
  this implementation directly, as unit tests rather than conformance fixtures, to confirm the rules
  are implemented; they should probably become real `conformance/lint/` cases.
- **`conformance/runner/` (9 cases) doesn't reach every row of the §11.4 payload table.** It covers
  `budget_exceeded` (grant, both scopes, exact-boundary, run-level-inside-parallel), `harness_error`
  (retry, resume with no payload), `schema_violation` (resume with an override payload, and a
  rejected override), and a `human` step's payload validation and any-order parallel join. It never
  exercises: `iteration_limit`'s own resume (a grant of additional iterations), `expression_error`
  (from a bad `prompt_vars`/`instructions`/`value` expression) and its override/re-attempt resume,
  `routing_error` and its override-with-a-StepName resume, a rejected resume address (naming a branch
  that isn't blocked, or blocked under a different exception class), or `harness_error`/
  `schema_violation` resumed with *no* payload where retry is exhausted rather than absent. This
  example's own Runner implements all of clause 11 (see `runner.ts`'s `resume*` methods) and the
  gaps above are, again, about suite coverage rather than a known defect.

Neither gap blocks conformance as SPEC.md defines it (§4.1.2, §4.1.3: a Linter/Runner conforms once
it passes every case the suite *has*), but both leave real corners of clause 8 and clause 11
unverified by the shared suite.
