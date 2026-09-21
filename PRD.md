# SFML v0.1 — Product Requirements

This is a PRD, not a specification. It states what SFML must do, what it must refuse to do, and what
has been decided. Where it shows syntax, the syntax is illustrative — the requirement is the
behaviour underneath it.

This document is the input to phase 2: writing the spec in RFC-2119 language with a JSON Schema. §11
lists what phase 2 must get right rather than transcribe.

---

## 1. Problem

Teams are wiring agents together with bespoke glue: a Python script here, a GitHub Actions matrix
there, a queue and a few cron jobs. Every one of these pipelines re-solves the same problems —
routing, joins, retries, human review, resume-after-failure — and none of them are portable,
reviewable, or testable.

A _software factory_ is a durable, resumable, mostly-autonomous pipeline that turns an intent
("implement this issue") into a reviewed artifact. SFML is the file format for describing one.

The bet: **the factory graph is worth separating from the agent runtime.** If the graph is a
declarative artifact, it can be diffed in a PR, validated before it runs, dry-run without spending
tokens, and moved between runtimes.

For teams to do this well an open standard is needed so that portability of factories is possible
and so an ecosystem can emerge as the industry explores how to work with factories.

## 2. Goals

1. **Readable in a PR.** A reviewer with no SFML training should follow a factory file the way they
   follow a GitHub Actions workflow.
2. **Statically validated.** Structural errors — unreachable steps, deadlocked joins, non-total
   routing — are caught by a linter before a run starts.
3. **Portable across runtimes.** The same file produces the same _graph behaviour_ on two conforming
   implementations. Identical agent output is not promised; identical control flow is.
4. **Durable and resumable.** A run survives process death and human-shaped pauses that last days,
   and resumes to a state that is provably the same.
5. **Testable without agents.** A factory can be exercised end-to-end against canned step results,
   in CI, for free.

## 3. Non-goals for v0.1

- **Not an agent framework.** No tool definitions, no memory, no context management. That belongs to
  the harness.
- **Not a scheduler.** No cron, no triggers, no webhooks. Something else starts a factory run.
- **Not general-purpose compute.** No expression-language escape hatch that becomes a programming
  language. If a step needs logic, it is a step.
- **Not composable yet.** Sub-factories are deferred; `type: factory` is reserved so they can land
  in v0.2 without a breaking change.
- **Not a workspace format.** Repo, branch, worktree, and what an agent may read or write are
  harness territory. **Portability ends at `harness_config`**.
- **Not an identity system.** SFML carries an assignee; it never resolves, grants, or routes one.
- **No cancellation.** v0.1 has no way to cancel a running step or branch, which is why `any` /
  `n_of_m` joins are deferred.
- **No clock.** Nothing in SFML routes on wall-clock time.

## 4. Prior art borrowed from

Adoption follows familiarity. Novel concepts are a tax, so it is paid only where agent pipelines
genuinely differ from job pipelines.

| Source                          | What is taken                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **BPMN / Step Functions**       | Structured fork/join; exclusive choice vs. parallel split; the hard-won lesson that unstructured joins deadlock |
| **Argo Workflows / GH Actions** | YAML shape, `needs`-style dependencies, per-step retries, matrix-free simplicity                                |
| **Temporal**                    | State as a fold over durable run data; determinism boundaries as the thing that makes resume real               |
| **CUE / JSON Schema**           | Typed step outputs; validation as a first-class artifact shipped with the spec                                  |

What is actually new: steps are _nondeterministic and expensive_, failure is common rather than
exceptional, and a human is a normal participant in the graph rather than an escalation path.

## 5. Design principles

1. **Small core, explicit extension points.** Everything a runtime may vary lives in a named,
   declared place (`harness`, `harness_config`).
2. **Make illegal graphs unrepresentable, or at least unlintable.** Prefer a syntactic rule the
   linter can enforce over a semantic rule it can only hope for.
3. **Narrow DSL** v0.1 should be small enough someone can understand it in minutes.
4. **Routing describes success.** Every edge in the graph is a success edge. Everything else is an
   exception the implementing system handles.
5. **A ceiling the author owns belongs in the file; the mechanism that enforces it, and the people
   it is enforced on, do not.**
6. **Where a value has a universal unit, SFML names it. Where it does not, SFML names the field and
   makes the implementor declare what they do with it.** Money has a universal unit; identity does
   not.

---

## 6. The v0.1 data model

### 6.1 Factory (top level)

| Field         | Type                      | Required | Notes                                                                                                                             |
| ------------- | ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sfml`        | string                    | yes      | Version string, e.g. `"v0.1"`. The `v` prefix is part of the value. A string, not a number, so `v0.1` and `v1.1` are expressible. |
| `description` | string                    | no       | So implementors can display factory descriptions back to their users.                                                             |
| `parameters`  | Record<Name, JSON Schema> | no       | What a caller must supply to start a run. See below.                                                                              |
| `start`       | StepName                  | yes      | Explicit entry point. Never inferred from topology — inference breaks every factory that loops back to its first step.            |
| `steps`       | Record<StepName, Step>    | yes      |                                                                                                                                   |
| `assignee`    | string                    | no       | **DRI of the run.** Opaque to SFML. See §6.9.                                                                                     |
| `budget`      | decimal USD               | no       | Ceiling for the whole run, across every agent step. See §6.8.                                                                     |

**`parameters` is the factory's signature** — the contract between a factory and whatever starts a
run of it. Each entry is a JSON Schema, the same machinery `result_schema` already uses, so
`description` and `default` are ordinary schema keywords rather than SFML invention.

- **A parameter with no `default` is required.** A run that omits one is rejected at admission,
  alongside the `assignee` checks in §6.9 — before a run id exists, before anything has run.
- The supplied values are bound as `parameters` on `FactoryState` (§6.5) and are **readable from any
  step**, not only from `start`. This is the whole reason the signature is declared at the top level
  rather than on the entry step: a parameter that only a later step consumes has no business
  appearing in the entry step's prompt.
- `parameters` declares _what a caller supplies_; a step's `prompt_vars` declares _what that step
  sees_ when rendering a prompt template. They are different objects and a factory of any size has
  them diverge.

`workspace` is a **reserved** top-level key that a v0.1 implementation MUST reject, so v0.2 can
define it without a breaking change.

**Unknown fields are rejected** at every level. This is the only thing that stops implementations
quietly accreting private extensions, and it is what keeps the top level forward-compatible for the
v0.2 list in §10.

### 6.2 Step (common fields)

| Field                     | Type                                              | Required     | Applies to             |
| ------------------------- | ------------------------------------------------- | ------------ | ---------------------- |
| `type`                    | enum `agent` \| `human` \| `parallel` \| `result` | yes          | all                    |
| `description`             | string                                            | no           | all                    |
| `prompt_vars`             | Record<Name, Expression>                          | no           | agent                  |
| `next`                    | List\<Connection\>                                | yes          | agent, human, parallel |
| `max_iterations`          | integer                                           | no           | agent, human, parallel |
| `budget`                  | decimal USD                                       | no           | agent (see §6.8)       |
| `retry`                   | `{ max_attempts, backoff }`                       | no           | agent                  |
| `assignee`                | string                                            | no           | human                  |
| `instructions`            | Expression                                        | no           | human                  |
| `harness`                 | `<name>[@<version>]`                              | yes          | agent                  |
| `harness_config`          | Record<Key, Any>                                  | no           | agent                  |
| `prompt_path` \| `prompt` | path \| string                                    | yes (one of) | agent                  |
| `result_schema`           | JSON Schema                                       | yes          | agent, human           |
| `steps`                   | Record<Name, Step>                                | yes          | parallel (see §6.11)   |
| `outcome`                 | enum `complete` \| `terminal_failure`             | yes          | result                 |
| `value`                   | Expression                                        | no           | result                 |

`result_schema` validates what the `agent` or `human` step creates before moving onto evaluating
where to route `next`.

A `parallel` step has no `result_schema`: its result is computed from its children, not authored.
Its children have no `next` — a child cannot route. See §6.11.

`type: factory` is **reserved** for v0.2 sub-factories.

`prompt_vars` are declared per step. It makes dependencies visible to the linter, gives the prompt
template a small named object instead of all of state, and makes steps individually testable.

### 6.3 Connection (routing)

| Field  | Type       | Required | Notes                                                                                             |
| ------ | ---------- | -------- | ------------------------------------------------------------------------------------------------- |
| `when` | Expression | no       | Absent means unconditional. There is no `else` key — the fallback is a connection with no `when`. |
| `to`   | StepName   | yes      | Exactly one target. Fan-out is a `parallel` step (§6.11), never a connection.                     |

- **First-match-wins on an ordered list.**
- **Routing MUST be total.** The last connection of any non-result step omits `when` and is
  therefore unconditional. The linter must enforce it. This makes the reachability check in §6.10
  sound. A step with nowhere to go is a lint error rather than an undiagnosed halt.
- **Every edge is a success edge.** There is no `on_error` and no `on_timeout`.

### 6.4 Expression language

SFML needs a narrow expression language so that `FactoryState` can be used in Connections, human
`instructions`, and result `value`s.

- **Every SFML expression MUST parse as valid CEL.** An implementation may be a CEL evaluator with a
  function library registered, or a hand-rolled subset in a language with no usable CEL port. A
  subset of CEL is used to simplify implementation requirements and not reinvent the wheel.
- The grammar is **closed and small**: field selection, indexing, comparison and boolean operators,
  literals, and calls into the standard library. No arithmetic on results, no user-defined
  functions, no collection macros in v0.1.
- The **standard function library** is closed: `last(list)`, `empty(x)`, `notEmpty(x)` are required
  CEL extensions. Additions to this list will not be considered for v0.1.
- **No optional chaining.** `last()` over an empty list yields null, and field access on null yields
  null, so `last(emptyList).some_field` is valid and evaluates to `null`.
- **Bindings are decided per use case.** A `FactoryState Expression` targets the `FactoryState`
  (§6.5) and is what Connections, `instructions`, and result `value`s use. A `PromptVars Expression`
  targets the `PromptVars` of an `Agent Step` (§6.7) and is what prompt templates use.

### 6.5 FactoryState

| Field        | Type                                 | Notes                                                                                                                        |
| ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `parameters` | Record<Name, Any>                    | The run's parameters, validated against the factory's declared `parameters` and defaulted. Constant for the life of the run. |
| `results`    | Record<StepName, List\<StepResult\>> | Oldest to newest. Access the latest with `last()`.                                                                           |

### 6.6 StepResult

The observable contract, and the thing conformance tests compare.

A `StepResult` **is** the validated result object itself. `last(results.review).approved` reads
`approved` off the result the `review` step produced.

One is created by each step on success only; a failed attempt appends nothing. Every step defines
the result it returns: for `agent` and `human` steps via `result_schema`, for `result` steps via
`outcome` or an explicit `value` (§6.15), and for a `parallel` step by its children — an object
keyed by child name holding each child's result (§6.11).

Nothing about _how_ a step ran — attempt counts, timings, cost — is part of `StepResult`. Those are
recorded data (§6.14) and are deliberately unreachable from expressions.

### 6.7 PromptVars

The `PromptVars` is what a `PromptVars Expression` (§6.4) targets — the bindings available to an
agent step's prompt template. Types come from the `Agent Step` definition.

| Field         | Type              | Notes                                           |
| ------------- | ----------------- | ----------------------------------------------- |
| `prompt_vars` | Record<Name, Any> | The evaluated `prompt_vars` of the `Agent Step` |

A template therefore writes `${ prompt_vars.issue }`, not `${ issue }`. The extra word buys a
namespace: a later version can add a sibling field here without every existing template becoming
ambiguous about what a bare name refers to.

`FactoryState` is **not** reachable from a prompt template. Anything a prompt needs is named in
`prompt_vars` first, which is what makes a step's dependencies visible to the linter and the step
testable on its own.

### 6.8 Budgets and iteration bounds

**`max_iterations` is a step field, checked on arrival.**

> On entering step `X`, if `X` has already run `max_iterations` times, the step does not start.

- Crossings are counted from `results.<StepName>`, so this needs no separate counter and survives
  resume for free. For a `parallel` step the counted list is the region's own — `results.checks`,
  appended once per join — not any child's, which is what makes one crossing of a region one
  iteration (§6.11).
- **A retry is not an iteration.** Failed attempts do not append to `results`. `max_iterations: 3`
  means three passes through the step, not three tries at it.
- Exceeding the bound raises `iteration_limit` — an exception, not a route. Nothing has run, so the
  state is clean at the point it stops.
- **Per step, not per edge.** The budget an author holds in their head is "how many times will I let
  this agent rewrite the code," which is a property of the work rather than of who asked for it.
- **No factory-level iteration ceiling.** When limits to total runs are designed, `budget` should be
  used.

**`budget` is a decimal number of United States dollars, at most two decimal places.**

- `budget: 5.00`, `budget: 0.25`, `budget: 12` are legal. `budget: 1.005` is a **lint error**.
- **Implementations SHOULD hold budgets and accumulated consumption as integer cents.** Binary
  floating point cannot represent `0.10` exactly, and a ceiling compared against accumulated floats
  is the oldest bug in money handling. The behaviour it protects — `budget: 0.30` is not exceeded by
  three steps of `0.10` — is testable and belongs in the conformance suite.
- **The harness reports consumption in USD**, accurately. Consumption may be reported at finer
  precision than cents; the two-decimal constraint is on the value a human wrote in the file.
- `0.00` means _this cost nothing_, not _this was not measured_. There is deliberately no way to say
  the latter. A genuinely free harness — a local model, a self-hosted runner, a cached result —
  reports `0.00` and this is a passing case. A harness that spends money and reports zero is
  **non-conforming**.
- **Absent means unbounded.** `budget: 0.00` raises `budget_exceeded` on arrival, which falls out of
  the rule rather than being a special case, and is a legal way to disable a step pending a grant.
- **There are two scopes.** `budget` on a step covers all iterations of that step. This means a step
  with a `max_iterations` of `3` and a `budget` of `5.00` has a budget across 3 `iterations` of five
  dollars. `budget` at the factory level is for all agent iterations across all steps. It is the max
  budget for the run. When a grant is needed and granted, it is applied at the level that triggered
  the error.
- **A factory-level overrun is attributed to the run, not to a step.** Concurrent children of a
  `parallel` step (§6.11) draw on the same run-level pool, so which of them pushes it over depends
  on completion order — but the exception names the run, the grant applies at the run level, and the
  routing trace is unaffected either way. This is why a ceiling may be shared at the run level and
  must not be shared at the region level: one stops everything, the other would have to pick a
  victim.

### 6.9 Assignee

Two fields, naming two different relationships. **Neither defaults to the other.**

> **Factory-level `assignee` is the DRI of the run. Step-level `assignee` is a person working on the
> run.**

- The value is **opaque to SFML** — a string. SFML does not say whether it denotes a person, a team,
  a rotation, a group, or a queue, and defines no syntax for it beyond being a string.
- **A human step that omits `assignee` is unassigned.** It does _not_ inherit the factory-level
  value. Inheriting would mean that dropping the `assignee` line on a review step silently puts the
  run's DRI in the reviewer queue — a worse default than no default, and invisible in a diff.
- The factory-level field exists because **exceptions have no step to hang an owner on.**
  `iteration_limit` and `budget_exceeded` stop a run needing a human to grant something, and there
  is no human step there. It also gives implementors a way to know who to escalate to if a human
  step is taking longer than their implementation would expect.

**If an implementation supports the factory-level `assignee`:**

- It **MUST** use it as the owner of the run **when no owner is otherwise provided.** A run may be
  created with an owner supplied out of band — by the caller, the job system, the person who pressed
  the button. SFML does not define how, and does not care. The factory-level `assignee` is the
  declared fallback, not an override.
- It **MAY** use it to constrain who can be assigned within the run — requiring, say, that step
  assignees resolve within the DRI's team. A step assignee falling outside that constraint is an
  admission-time rejection.

**The implementor declares a posture**, per level, and they may differ:

| Posture             | `assignee` present                                              | `assignee` absent       |
| ------------------- | --------------------------------------------------------------- | ----------------------- |
| Supported, optional | Validate against the identity system; reject the run if invalid | Run proceeds unassigned |
| Supported, required | Validate; reject the run if invalid                             | **Reject the run**      |
| Unsupported         | **Reject the run**                                              | Run proceeds            |

- A conforming implementation **MUST document which posture it takes.**
- All three conform. Treating assignment as required is a legitimate product decision; so is
  refusing the field because assignment lives elsewhere.
- **What does not conform is silence** — accepting an `assignee` and ignoring it. A field read but
  not honoured is worse than one refused, because the file then documents a routing that does not
  happen.

**Rejection is at admission**, before the run starts: no run id, no results, no exception class.
**The linter cannot do this check** — it has no identity system, so it validates only that the value
is a string. These are two stages and the spec must name both, so a file that passes lint is not
mistaken for a file that will run.

**The point of the field:** to give implementors a place to track ownership, not to let a factory
file control assignment. A factory file can say who is accountable and who does a task. It cannot
_grant_ anyone anything or override a real identity system's rules.

### 6.10 Validation rules

Every validation rule ships with a decision procedure, and the reference linter implements it. **A
rule that cannot be checked is a comment and should be written as one.**

- **Reachability is syntactic.** "Every possible path ends in a result step" implies evaluating
  conditions, which is undecidable. Instead: ignore condition semantics, treat every connection as
  traversable, and require total routing (§6.3). The check becomes plain graph reachability.
- **Unknown parameter names are a hard error.** `parameters.<name>` where `<name>` is not a declared
  parameter fails validation, for the same reason unknown step names do.
- **Unknown step names are a hard error.** `results.<name>` where `<name>` is not a declared step
  fails validation. Once a typo cannot parse, null-propagation needs no further rule.
- **References are checked by reachability, not ancestry.** A reference from `Y` to `results.X` is
  legal iff some path `X → … → Y` exists, following loop-back edges. The ancestor-on-all-paths rule
  rejected a shape every real factory has: `implement` reading `review.notes`, where `review` runs
  _after_ `implement` on the first pass and _before_ it on every subsequent one. **A legal reference
  may still be null on the first pass, and that is a normal state.**
- **Region balance needs no check.** A `parallel` child has no `next`, so there are no edges inside
  a region to leave it. This is not a rule the linter enforces; it is a shape the file cannot
  express.
- Lint also checks: `budget` has at most two decimal places; `assignee`, where present, is a string;
  every cycle is bounded; every non-result step ends in an unconditional connection.

### 6.11 Concurrency

Concurrency in v0.1 is one shape: **a `parallel` step**. It declares a map of named child steps,
runs them concurrently, and joins when every one of them has produced a result.

- **A child is a single `agent` or `human` step with no `next`.** A child cannot route, so a region
  contains no edges at all. Deadlock is not merely detectable, it is unrepresentable.
- **The join is `all`, implicitly, and the join is the parallel step itself.** There is no join step
  and no join policy field. `any` and `n_of_m` are deferred precisely because they require
  cancellation semantics, and "what does it mean to cancel a running agent step" is a question v0.1
  does not answer.
- **Single entry, single exit.** Control enters at the parallel step and leaves through its `next`.
- **A child may not itself be `parallel`.** Regions do not nest in v0.1.
- **The result is an object keyed by child name**, holding each child's result. It is computed
  rather than authored, which is why a parallel step has no `result_schema`. Read it as
  `last(results.checks).lint.passed`.
- **Child names are qualified by their parent** — `checks.lint`. The qualified name is what a resume
  addresses (§6.13) and what an exception names. Child names need be unique only within their
  parallel step, so two regions may each have a `lint`.
- **`max_iterations` belongs to the region; `budget` belongs to each child.** A child cannot be
  entered on its own, so it runs exactly once per crossing and a child-level iteration count would
  always be 1 — iterations are a property of crossing the region. Cost is the opposite: children
  differ, and a lint pass and a full test run have no business sharing a number.
- **A parallel step has no `budget`, and this is deliberate.** A pool shared by concurrent children
  is drained by whichever reports first, so _which_ child raises `budget_exceeded` would depend on
  completion order — the thing this section refuses to make meaningful, and the thing success
  criterion 5 requires to be irrelevant. Per-child ceilings have no race. The factory-level `budget`
  (§6.1) remains the ceiling for the run as a whole.

**What this costs.** A branch is exactly one step. Branches that are _sequences_, and racing
patterns — start three approaches, take the first, abandon the rest — are not expressible in v0.1.
Both are deferred (§10). This is the trade that buys fan-out without buying region-membership rules.

**Ordering.** The joined result's keys are in **declared order, not completion order** — a statement
about the data model rather than about storage. No two children write the same key, so the result
cannot race.

### 6.12 Error model

**A step failure is a factory exception, not a route.** `on_error` and `on_timeout` do not exist.

| Class              | Raised when                                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| `schema_violation` | Agent output does not validate against `result_schema`, and a retry has not fixed it  |
| `harness_error`    | The harness fails to produce a result for reasons outside the agent's output contract |
| `iteration_limit`  | Entering a step would exceed its effective iteration budget                           |
| `budget_exceeded`  | A step's reported consumption reaches or exceeds its effective budget                 |

**All four are resumable. Nothing in v0.1 is inherently fatal except reaching a result step.**

**`harness_error`.** SFML deliberately does **not** enumerate causes. Rate limits, auth failures,
network faults, capacity, and the harness's own execution timeouts are all one class, because SFML
cannot know what any of them look like across harnesses and a hard-coded cause list is guaranteed
wrong for the next one.

- **The harness classifies.** A conforming harness MUST report, with each failure, whether it is
  retryable, and MAY state a backoff. A rate limit is retryable; invalid credentials or a malformed
  `harness_config` is not.
- `retry` supplies `max_attempts` and `backoff`; **the harness supplies the judgment.** Retry
  applies only to failures the harness marked retryable. This is why `retry.on` does not exist —
  there is nothing left for an author to list.
- Exhausting retries, or a non-retryable failure, raises the exception.

When resuming from a `harness_error` error the same harness session MUST be used so that session
state is continued.

**`schema_violation`.** This class is **agent-only**, though `result_schema` is declared on human
steps too. A human step's payload is validated when a resume arrives and an invalid one is
**rejected at the call** (§6.13): the resume fails, the step stays `awaiting_input`, and nothing is
appended. There is no failed attempt to record and no exception to resume from, because the run
never left the state it was already in.

- Implementations **SHOULD** permit retry of this class, and **SHOULD** default to one automatic
  attempt with the validator's error fed back into the reprompt.
- This is deliberately SHOULD, not MUST. The normative content is not the number — it is _do not
  make this class immediately fatal_. Zero or three is a defensible local choice; fatal-on-first is
  a defect, because an implementor who treats a mis-formatted answer as the end of the run has built
  something that cannot run unattended.
- A resume re-runs the step as a new agent turn. It may succeed or fail the same way again. The
  failure mode is repeatable; the attempt is not — which is precisely why retrying is worth doing.
- **A resume MAY instead carry a result**, validated against the step's `result_schema` (§6.13). It
  is appended as the step's result and the agent is not re-run. This is the escape hatch for an
  agent that cannot produce valid output no matter how many times it is asked: without it the only
  way past a wedged step is to abandon the run. A result supplied this way is a normal `StepResult`
  and routing cannot tell the difference — implementations **MUST** record that it was
  operator-supplied (§6.14), because the run history is the only place the distinction survives.

**`iteration_limit`.** Checked on arrival, so nothing has run and the state is clean. **Resume takes
a payload: a number of additional iterations to grant that step.**
`effective_limit(X) = X.max_iterations + granted(X)`.

**`budget_exceeded`.** **Resume takes a payload: a decimal dollar amount to grant.**
`effective_budget(X) = X.budget + granted_budget(X)`. A run-level overrun is resumed at the step
that was entered when the ceiling was reached, but the grant applies to the run (§6.8) — the address
says where to continue, the exception says what was exceeded.

When resuming from a `budget_exceeded` error the same harness session MUST be used so that session
state is continued.

**Failure inside a `parallel` step.** An exception raised by a child names the child's qualified
name, and **only the failed child re-runs on resume** — siblings that already produced a result keep
it, and the region joins once the re-run succeeds. Re-running four expensive agents because the
fifth returned bad JSON is exactly the waste `budget` exists to prevent. A resume is therefore
addressed to the child, `checks.audit`, not to the region.

**Grants are not part of `FactoryState`.** They are records in the run's history.

There is no `cancelled` outcome. v0.1 has no cancellation, so there is no state for it to name.

### 6.13 Pause, error, and resume

**Human steps have no timeout, no escalation, and no failure mode.** A step either resumes with
valid input or waits. An implementor who wants to expire a long-waiting run may, but nothing in SFML
asks them to.

**Stopping is a property of a branch, not a run.**

- A run has a set of live branches: one, except while inside a `parallel` step, where there is one
  per child. A branch is `running`, `awaiting_input`, `errored`, or `done`.
- A branch is `awaiting_input` at a human step that has not been resumed, and `errored` where an
  exception of any class in §6.12 was raised. Both are **blocked**: the branch is stopped, nothing
  has been appended to `results`, and it advances only on a resume.
- **Run status is derived, not stored:** `running` if any branch is running; otherwise `errored` if
  any branch is errored; otherwise `awaiting_input` if any branch is awaiting; terminal when a
  result step is reached. `errored` outranks `awaiting_input` because a run needing a grant needs
  someone who can give one, which is rarely the person the human step is queued on.
- A `parallel` step with four children, one of them a human step still waiting, is a **running** run
  with one blocked branch. The sequential case falls out as the one-branch special case, so there is
  one definition rather than two.

**The resume contract.**

- A **run** has an id, minted by the implementation. Type and encoding are unconstrained by SFML.
- **A resume is addressed to `(run_id, step_name)`.** The step name is the one declared in the file
  — qualified as `<parallel>.<child>` for a step inside a region (§6.11). One address form serves
  both kinds of block; what the resume _does_ follows from the state the branch is in, not from a
  mode the caller picks.
- **A resume addressed to a step whose branch is neither `awaiting_input` nor `errored` in this run
  is rejected.**
- **The address is total: it always names exactly one blocked step.** Concurrent blocks exist only
  as children of a `parallel` step, each child has a distinct name within it, and regions do not
  nest — so no two live branches are ever blocked at the same qualified name, whatever blocked them.
- **A conforming implementation MUST document how a run id is obtained and how a blocked run at a
  named step is resumed.** That is the end of the requirement.

**The payload depends on what blocked the branch.**

| Branch state     | Raised by          | Payload                                         | Effect                                                                       |
| ---------------- | ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `awaiting_input` | a human step       | object matching `result_schema`                 | appended as the step's result                                                |
| `errored`        | `iteration_limit`  | integer, additional iterations                  | grant recorded, step is entered                                              |
| `errored`        | `budget_exceeded`  | decimal USD, at most two places                 | grant recorded, step is entered                                              |
| `errored`        | `harness_error`    | none                                            | step re-runs on the same harness session                                     |
| `errored`        | `schema_violation` | none, **or** an object matching `result_schema` | re-runs as a new agent turn; with a payload, that result is appended instead |

- **A payload that does not match is rejected at the call.** The branch keeps the state it had and
  nothing is appended — the rule §6.12 states for a human step's invalid input, holding for every
  row of this table. A rejected resume is not an attempt and not a failure; the run never moved.
- **A grant payload of zero is legal and is a no-op grant**: the step is entered and immediately
  raises the same exception again. There is deliberately no way to clear a ceiling, only to raise
  it.

### 6.14 What a run must record

The journal is **not** in the spec: no event types, no required fields, no sequence numbering, no
encoding. The requirement is capability, not format.

> A run's recorded data MUST make every attempt observable, including failed ones, with its attempt
> number and failure class; MUST record iteration and budget grants; MUST record any result supplied
> by an operator rather than produced by its step (§6.13); and MUST record the run's owner.

- A run MUST be resumable after process death to a state **equivalent** to the state it had, where
  equivalence is defined over `FactoryState`: same `results`, same routing decisions, same attempt
  counts.
- A run MUST be resumable after a human-shaped pause of arbitrary duration.
- Whether a run's owner may change mid-run, and by whom, is the identity system's business; SFML
  records nothing about it.

A runtime's storage remains its own business. What SFML guarantees is what an operator can learn
about a run.

### 6.15 Result steps

| Field     | Type                                  | Required |
| --------- | ------------------------------------- | -------- |
| `outcome` | enum `complete` \| `terminal_failure` | yes      |
| `value`   | Expression                            | no       |

Default values when `value` is omitted:

- `complete` → `{ "ok": true }`
- `terminal_failure` → `{ "ok": false }`

A run that reaches a result step is terminal and cannot be restarted.

### 6.16 Still unspecified, and deliberately listed

`StepName` charset and reserved names — noting that `.` is the qualifier separator for parallel
children (§6.11) and so cannot appear in a name itself; case sensitivity of step keys; maximum graph
size; behaviour on duplicate keys; whether comments survive a round-trip; `harness: name@version`
resolution and what happens when the requested version is unavailable. These are spec-drafting
details, not open product questions.

---

## 7. Illustrative shape

Syntax is a strawman; the point is the shape of the information.

```yaml
sfml: "v0.1"
description: implement a github issue with review

parameters:
  issue_url: { type: string, description: the issue to implement }
  priority:  { type: string, default: p2 }

start: plan
budget: 20.00
assignee: eng-platform          # DRI of the run; the fallback owner, and who
                                # resolves iteration and budget grants

steps:
  plan:
    type: agent
    description: read the issue and produce an implementation plan
    budget: 1.00
    prompt_vars:
      issue: ${ parameters.issue_url }
    prompt_path: prompts/plan.md
    result_schema:
      type: object
      properties: { plan: { type: string } }
    next:
      - to: implement

  implement:
    type: agent
    description: write the code
    max_iterations: 3
    budget: 5.00
    prompt_vars:
      plan: ${ last(results.plan).plan }
      priority: ${ parameters.priority }             # a parameter `plan` never sees
      prior_review: ${ last(results.review).notes }   # null on first pass
    prompt_path: prompts/implement.md
    result_schema:
      type: object
      properties: { branch: { type: string } }
    next:
      - to: checks

  checks:
    type: parallel
    description: lint and test the branch concurrently
    steps:
      lint:
        type: agent
        harness: claude
        budget: 0.25             # cheap
        prompt_vars:
          branch: ${ last(results.implement).branch }
        prompt_path: prompts/lint.md
        result_schema:
          type: object
          properties: { passed: { type: boolean } }
      test:
        type: agent
        harness: claude
        budget: 2.00             # not cheap; its own ceiling, not a shared one
        prompt_vars:
          branch: ${ last(results.implement).branch }
        prompt_path: prompts/test.md
        result_schema:
          type: object
          properties: { failures: { type: integer } }
    next:
      - to: review

  review:
    type: human
    description: approve, request changes, or abandon
    assignee: eng-reviewers      # who does this task — not inherited, not a default
    instructions: ${ last(results.implement).branch }
    # check outcomes are on the region: last(results.checks).lint.passed
    result_schema:
      type: object
      properties:
        approved: { type: boolean }
        abandon: { type: boolean }
        notes: { type: string }
    next:
      - when: ${ last(results.review).approved }
        to: shipped
      - when: ${ last(results.review).abandon }
        to: give_up
      - to: implement

  shipped:
    type: result
    outcome: complete
    value: { branch: ${ last(results.implement).branch } }

  give_up:
    type: result
    outcome: terminal_failure
```

**What a reviewer can check by eye:** the entry point is explicit; every non-result step ends in a
connection with no `when`; every referenced step is reachable to its referent; the loop is bounded;
every path reaches a result; `checks` fans out and joins in one place and its children have no
`next`, so no edge can escape it; no edge in the file is a failure edge, so the graph is the happy
path and nothing else.

**What the file says out loud:** `implement` gets three passes at five dollars each, `lint` and
`test` run concurrently, each under its own ceiling, review goes to `eng-reviewers`, and anything
that stops the run goes to `eng-platform`. Every expression parses as CEL; the only non-base-CEL
construct is `last()`, a registered function rather than new syntax.

**What is deliberately absent:** `implement` failing three times does not appear in this file. It
raises `iteration_limit`, the run stops resumably, and a human grants more iterations or lets it
die. **The file describes the work, not the weather.**

Note also that `review` would be _unassigned_ if its `assignee` line were dropped, rather than
quietly landing on `eng-platform`. The file says both things or it says neither.

## 8. Success criteria for v0.1

1. A newcomer reads §7 and predicts its behaviour correctly.
2. The reference linter rejects every negative case in the conformance suite and accepts every
   positive one.
3. A non-trivial factory (≥8 steps, one loop, one human step, one `parallel` step) runs end-to-end
   on the `mock` harness in under a second, in CI.
4. A second implementation, written from the spec alone, passes the conformance suite.
5. **Killing the runtime mid-run and resuming produces the same routing trace as an uninterrupted
   run** — the ordered sequence of step entries and route decisions — and an equivalent
   `FactoryState`. This is assertable in CI precisely because the trace is a pure function of step
   results: no clock, no failure edges, no wall-clock expiry.
6. A harness that reports a retryable failure is retried per `retry`; one that reports a
   non-retryable failure is not. The `mock` harness can produce both, and the suite asserts the
   difference.
7. A harness reports the consumption of each step. A step whose reported consumption reaches its
   declared `budget` raises `budget_exceeded` and appends nothing to `results`; a resume carrying a
   grant re-runs the step.
8. A step with `budget: 0.30` is exceeded by three reported consumptions of `0.10`, including the
   equal case. This is deliberately an arithmetic test: it is the cheapest possible check that an
   implementation does accumulate money across runs.
9. A harness reporting `0.00` for every step runs a factory with budgets to completion without
   raising `budget_exceeded`. A passing case, not a warning.
10. A `parallel` step with two human children accepts a resume addressed to either qualified name,
    in either order, joins once both arrive, and reaches the same terminal state regardless of
    order.
11. A human step with no `assignee`, in a factory that declares a factory-level `assignee`, is
    **not** assigned to it. This is a default value statement, not a routing of notifications
    statement.
12. An implementation states its `assignee` posture for steps and for the factory. A run carrying an
    `assignee` an unsupported implementation cannot honour is **rejected at admission** — no run id,
    no results, no exception.

## 9. Sequencing

| Phase | Output                                                    | Status                   |
| ----- | --------------------------------------------------------- | ------------------------ |
| 1     | Freeze the v0.1 core field set                            | **Done** — this document |
| 2     | Spec document with RFC-2119 language + JSON Schema        | **Next**                 |
| 3     | **Harness contract**: the interface a harness implements  | Blocks 4 and 5           |
| 4     | Reference linter + `mock` harness + conformance suite     |                          |
| 5     | One real harness binding; port two real pipelines to SFML |                          |
| 6     | v0.1 tag; collect what v0.2 must fix                      |                          |

## 10. Deferred to v0.2

1. **Prompt fragments / includes** — repo-wide conventions. A factory-level preamble was declined as
   a v0.1 win because it is a special case of includes, and shipping the special case first
   constrains the general design before there is evidence about what it should be.
2. **Workspaces** — repo, branch, worktree, read/write scope. One data point is not enough to
   generalize from, and a wrong abstraction is far more expensive to remove than a missing one is to
   add.
3. **`any` / `n_of_m` joins**, with the cancellation semantics they require.
4. **Sub-factories** — `type: factory` is reserved.
5. **Multi-step branches** — a parallel branch is exactly one step in v0.1. Branches that are
   sequences need region-membership rules, and the whole point of the v0.1 shape is that it needs
   none.
6. **Nested regions** — a `parallel` child may not itself be `parallel`.

## 11. What phase 2 must get right

One thing this PRD does **not** hand phase 2 a ready answer for. It is flagged here rather than left
to be discovered mid-draft.

### 11.1 The MUST/SHOULD/MAY pass will force precision

Several rules read fine as prose and will not survive RFC-2119 drafting unchanged. The two to watch:

- **§6.9's MUST/MAY split.** "MUST use it as the owner when no owner is otherwise provided" depends
  on "otherwise provided," which SFML deliberately does not define. The MUST is conditional on
  something outside the spec, and that needs careful wording to be testable rather than vacuous.
- **§6.12's deliberate SHOULD.** The `schema_violation` retry rule is the one requirement in this
  document that is intentionally advisory, and the reason — _the normative content is not the
  number, it is "do not make this class immediately fatal"_ — must survive into the spec text.
