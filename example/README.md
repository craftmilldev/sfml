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
sfml run <factory.sfml> [--param key=value ...] [--state <path>]
sfml resume <factory.sfml> --state <path> --step <name> [--payload <json>]
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

Any `runner/` conformance fixture's `factory.sfml` + `transcript.yaml` works here unmodified,
since it's the same mock (`mock-backend.ts`) every conformance case plays back.

## Running the tests

```
npm test              # from the repo root: schema + conformance-fixture validation, this package, examples/
npm --prefix example test   # this package alone: conformance suite + unit tests
```

`src/engine/conformance.test.ts` runs every case in `conformance/parser`, `conformance/lint`, and
`conformance/runner` against this Parser/Linter/Runner. All of it passes.

## Conformance suite coverage

Issue #13 asked to flag any SPEC.md conformance case that doesn't seem present. The two gaps flagged
in earlier revisions of this file — `conformance/lint/` having only one fixture, and
`conformance/runner/` not reaching every row of the §11.4 resume-payload table — were filled by
[#17](https://github.com/craftmilldev/sfml/pull/17): `conformance/lint/` now has 28 fixtures (one or
more per §8.7 diagnostic, plus negative cases like `guarded-step-still-reachable` and `bounded-cycle`
that confirm the Linter does *not* over-reject), and `conformance/runner/` grew from 9 to 32, adding
`iteration-limit-grant`, `expression-error-*`, `routing-error`, `rejected-resume-addresses`,
`admission-*`, and more. `conformance/parser/` also grew, to 66 fixtures.

That PR also revised SPEC.md itself: §8.2's structural checks that used to carry their own Linter
diagnostics (`invalid-parallel-child-type`, `parallel-child-has-next`, `nested-parallel`,
`field-not-applicable-to-type`) are now Parser/schema-only concerns, so §8.7's registry dropped to
fourteen identifiers; this example's Linter was updated to match (`checkStructural` in `linter.ts`
no longer emits those four). §7.1, §7.8, and §7.9 also moved from being informally Parser-adjacent to
formal Linter rules with their own diagnostics (`invalid-expression`, `prohibited-expression-construct`,
`invalid-prompt-template`, `prompt-file-unreadable`, `prompt-file-not-utf8`), which needed real
implementation work here, not just new fixtures to pass:

- `expr.ts` parses a **wider** grammar than SPEC §7.2 on purpose — arithmetic, and a `.macro(args)`
  call — so it can tell "doesn't parse as CEL at all" (`invalid-expression`) apart from "parses, but
  uses a construct outside the grammar" (`prohibited-expression-construct`); the evaluator still
  refuses to run either.
- The Linter now resolves an agent step's `prompt_path` against the factory's own directory and reads
  it, checking well-formed placeholders, UTF-8, and binding environment the same way it does for an
  inline `prompt` — which meant the Runner's own `prompt_path` resolution (previously relative to the
  process's cwd, a known gap) had to be fixed to match, threaded through as `Engine`'s `baseDir`.
- `Engine.start()` now lints before admitting a run (§4.1.3), where it previously only checked
  parameters and harness resolution.
- A field simply absent from an object (as opposed to the object itself being `null`) is now a
  runtime error, not another null — SPEC §7.3 only makes *null* propagate.

All of this is covered by the suite itself (`conformance.test.ts` runs clean against all three
folders) plus this package's own unit tests; nothing outstanding to flag from issue #13's original
ask remains.
