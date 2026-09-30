# SFML worked example

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
sfml lint <factory.sfml>
sfml run <factory.sfml> [--param key=value ...] [--state <path>]
sfml resume <factory.sfml> --state <path> --step <name> [--payload <json>]
```

`lint` parses and lints the factory, exiting 0 on success or 1 with the diagnostics on stderr
otherwise; it prints nothing on success. `run` admits and drives the factory to its first quiescent point (clause 9) and prints the
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
npm test              # from the repo root: schema + conformance-fixture validation, this package, tools/ tests
npm --prefix example test   # this package alone: conformance suite + unit tests
```

`src/engine/conformance.test.ts` runs every case in `conformance/parser`, `conformance/lint`, and
`conformance/runner` against this Parser/Linter/Runner. All of it passes.
