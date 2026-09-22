# Software Factory Markup Language (SFML)

**Version:** v0.1 **Status:** Pre-draft **Copyright:** 2026 Plumbline LLC **License:** MIT

---

## Foreword

This document has no known essential patent claims against it. "Software Factory Markup Language"
and "SFML" are used here as descriptive names, not asserted as trade names. This is a pre-draft:
clause numbering, examples, and normative wording may still change before v0.1 is tagged. Feedback
on this draft should be submitted against the repository that hosts it. No warranty of any kind is
made about this document or the conformance of any implementation of it; see the accompanying
license for the applicable disclaimer of liability.

## Introduction

A software factory is a durable, resumable, mostly-autonomous pipeline that turns an intent, such as
an issue to implement, into a reviewed artifact. SFML is the file format that describes one: a graph
of steps connected by routing that an author writes down, a linter can check and teams can share.

The graph is defined separately from the agent runtime that executes it. A step that calls an agent
names a harness and hands it configuration, but SFML does not describe what the harness does, how it
calls a model, or what tools it gives that model.

---

## 1. Scope

### 1.1 What SFML defines

SFML defines:

- The document format of a factory file, including its encoding, name and identifier rules, and the
  handling of unknown and reserved keys (clause 5).
- The data model of a factory: its top-level fields, its step types, connections, the expression
  language used inside them, and the values a running factory exposes to expressions and prompt
  templates (clauses 6–7).
- The static validity of a factory graph and the diagnostics a linter must produce (clause 8).
- The execution model: how a run is admitted, how state accumulates, how routing is evaluated, and
  where the boundary between deterministic control flow and nondeterministic agent output falls
  (clause 9).
- A closed set of exception classes a run can raise, and which of them are retryable (clause 10).
- The pause-and-resume contract: branch states, resume addressing, and the payload each blocked
  state accepts (clause 11).
- The minimum a run's recorded history must make observable, without prescribing its format
  (clause 12).
- The version identifier, compatibility policy, and extension points a factory file may rely on
  (clause 13).

### 1.2 What SFML does not define

SFML does not define:

- An agent framework. While tool definitions, memory, and context management can be tracked via a SFML file, their configuration is harness specific and manged via the harness config which is a object in SFML.
- A scheduler. SFML describes a run once it exists; what starts a run — a webhook, a cron job, a
  person — is out of scope.
- A general-purpose computation model. The expression language (clause 7) has no user-defined
  functions and no arithmetic on step results; a factory that needs logic expresses it as a step.
- Sub-factory composition. `type: factory` is reserved (§13.3) so it can be defined in a future
  version without a breaking change.
- A workspace format. Repository, branch, worktree, and what an agent may read or write are bound
  entirely inside `harness_config` (§6.12); SFML does not model them.
- An identity system. `assignee` (§6.11) is carried as an opaque string; SFML never resolves,
  grants, or routes on identity.
- Cancellation of a running step or branch.
- Any behavior conditioned on wall-clock time.

## 2. Normative references

TODO: Provide links here.

- RFC 2119, *Key words for use in RFCs to Indicate Requirement Levels*.
- RFC 8174, *Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words*.
- RFC 8259, *The JavaScript Object Notation (JSON) Data Interchange Format*.
- YAML 1.2, *YAML Ain't Markup Language*.
- JSON Schema (2020-12 core and validation specifications).
- Common Expression Language (CEL) language specification.
- ISO 4217, *Currency codes*.

## 3. Terms and definitions

### 3.1 Notational conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals as shown
here.

### 3.2 Terms

#### 3.2.1 Factory

A document, conforming to this specification, that declares a graph of steps and the routing between
them. A factory is a static artifact; it describes work, not any particular execution of it.

#### 3.2.2 Run

One execution of a factory, identified by a run id minted by the implementation. A run accumulates
`FactoryState` (§9.2) as its steps produce results.

#### 3.2.3 Branch

A live line of control within a run. A run has exactly one branch except while control is inside a
`parallel` step, where it has one branch per child (§9.8). A branch is at all times `running`,
`awaiting_input`, `errored`, or `done` (§11.1).

#### 3.2.5 Iteration

A single traversal of a step from entry to success that is counted toward a step's `max_iterations`.

#### 3.2.6 Attempt

A single try at executing a step within one iteration. An attempt that fails does not append to
`results`; an iteration may consist of several attempts when `retry` (§6.10) applies.

### 3.3 Roles

#### 3.3.1 Author

The persons and or systems that write a factory file.

#### 3.3.2 Caller

The person or system that starts a run and supplies the values bound to `parameters` (§6.3).

#### 3.3.3 Operator

The person or system that resumes a blocked run: supplying a human step's result, granting
additional iterations or budget, or supplying an operator-authored result in place of a wedged
agent step (§11.4).

QUESTION: Should Caller and Operator be merged into one role?

#### 3.3.4 Harness

The component that executes an agent step and returns a result. This specification names the
harness, bounds what it must report to a conforming implementation (cost, retryability of a
failure, and continuity of a session across a resume), and does not describe how it works
internally.

#### 3.3.5 Implementation

Software that parses, lints, or runs factory files in conformance with this specification.

## 4. Conformance

### 4.1 Conformance classes

#### 4.1.1 Parser

A **Parser** accepts a document's surface syntax and encoding (clause 5) and produces a value
conforming to the data model of clause 6, or rejects the document. A Parser does not evaluate
expressions and does not perform the checks of clause 8.

#### 4.1.2 Linter

A **Linter** accepts a parsed factory and performs every check in clause 8, reporting the stable
identifier (§8.7) of each violated rule. A Linter does not execute a run.

#### 4.1.3 Runner

A **Runner** executes runs of a factory that has passed linting. It owns what an agent step must
achieve regardless of which harness it binds to: reporting cost (§9.7), continuing the same session
across a resume (§11.7), and classifying a failure as retryable or not (§10.3). How it obtains any
of these from a particular harness is the Runner's own business, not something this specification
constrains.

### 4.2 Requirements by class

| Requirement                                                         | Parser | Linter | Runner |
| -------------------------------------------------------------------- | :----: | :----: | :----: |
| Reject documents violating clause 5 (encoding, unknown/reserved keys) |  MUST  |  MUST  |  MUST  |
| Produce the clause 6 data model from a valid document                |  MUST  |  MUST  |  MUST  |
| Report every clause 8 diagnostic with its §8.7 identifier             |   —    |  MUST  |  MUST  |
| Refuse to start a run of a factory with any clause 8 violation        |   —    |   —    |  MUST  |
| Implement admission (§9.1), including assignee posture (§6.11)        |   —    |   —    |  MUST  |
| Implement the execution model of clause 9                             |   —    |   —    |  MUST  |
| Raise the exception classes of clause 10 under their stated conditions|   —    |   —    |  MUST  |
| Implement resume addressing and payloads of clause 11                 |   —    |   —    |  MUST  |
| Satisfy the run-record requirements of clause 12                      |   —    |   —    |  MUST  |

A single piece of software MAY implement more than one conformance class. An implementation that
claims the Runner class MUST also satisfy the Parser and Linter requirements, since a Runner MUST
refuse to start a run of a factory that fails linting.

### 4.3 Declared postures and the documentation obligation

Where this specification allows an implementation to choose among stated postures — for example, the
`assignee` postures of §6.11 — a conforming implementation MUST document which posture it has taken.
An implementation that accepts a field, or a value for it, without documenting the posture governing
that acceptance does not conform, regardless of what it does at runtime, because a factory file's
meaning under such an implementation cannot be determined by reading this specification alone.

### 4.4 Precedence of this document over Annex A

Annex A provides a JSON Schema for the surface syntax of a factory document. Where the schema and the
normative text of this document disagree, this document governs. The schema is provided to make
common structural mistakes cheap to catch; it is not a substitute for the checks of clause 8, which
require graph-level reasoning a schema validator cannot perform.

## 5. Document format

### 5.1 Encoding and surface syntax

A factory document is a YAML 1.2 document, encoded as UTF-8. Every value in the data model of
clause 6 that is legal YAML MUST be representable in a factory document; an implementation MAY also
accept the equivalent JSON document, since every JSON document is valid YAML.

### 5.2 Names and identifiers

A `StepName` is a non-empty string. It MUST NOT contain `.`, which is reserved as the qualifier
separator between a `parallel` step and its child (§5.3). `StepName` comparison is case-sensitive:
`Plan` and `plan` name distinct steps. A `Name` used as a `parameters` or `prompt_vars` key is
subject to the same case-sensitivity rule.

This specification does not further restrict the character set of a `StepName` or a `Name` beyond
excluding `.`; an implementation MAY impose additional restrictions of its own (for example, to fit
an identifier into a storage system) provided it documents them.

### 5.3 Qualified names

A step declared as a child of a `parallel` step (§6.7) is addressed, outside its own step
definition, by its **qualified name**: `<parallel>.<child>`, where `<parallel>` is the name of the
enclosing `parallel` step and `<child>` is the child's own name. Qualified names are what a resume
(§11.3) addresses and what an exception raised inside a region names. A child's name need only be
unique within its own `parallel` step; two different `parallel` steps may each declare a child named
`lint` without conflict, since their qualified names differ.

### 5.4 Unknown fields

An implementation MUST reject a document containing a field not defined by this specification, at
every level of the data model: the factory's top level, every step, every connection, and every
nested object this specification defines. This is a hard error, not a warning, and it applies
regardless of whether the unrecognized field's name resembles a future or vendor-specific extension.

### 5.5 Reserved keys

TODO: This section is weird after 5.4 which says unknown values must be rejected. I think we can drop this section and other comments in the SPEC.md that are like this.

The following keys are reserved and MUST be rejected by a v0.1 implementation wherever they appear,
even though this specification does not yet define their meaning:

- `workspace`, as a top-level factory field.
- `factory`, as a value of a step's `type` field.

Reserving these keys now allows a future version of this specification to define them without a
breaking change to v0.1 documents.

### 5.6 Duplicate keys

A YAML or JSON mapping with a duplicate key at any level of a factory document (for example, two
`steps` entries with the same `StepName`, or a step object with two `budget` fields) is a parse
error. A conforming Parser MUST reject such a document rather than silently applying "last value
wins" or any other resolution.

## 6. Data model

### 6.1 Value types

| Type                | Description                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| String               | A YAML/JSON string.                                                                                      |
| Integer              | A YAML/JSON integer with no fractional component.                                                        |
| Decimal USD          | A non-negative decimal number of United States dollars with at most two decimal places (§9.7).           |
| JSON Schema          | A value conforming to the JSON Schema specification referenced in clause 2.                              |
| Expression           | A string that parses as an SFML expression (clause 7). Two flavors exist: `FactoryState Expression` and `PromptVars Expression` (§7.5), distinguished by the binding environment they resolve against, not by syntax. |
| StepName             | A name identifying a step, per §5.2.                                                                      |
| SFMLVersionString    | A string of the form `v<major>.<minor>`, e.g. `"v0.1"`. |

### 6.2 Factory

The top-level object of a factory document.

| Field         | Type                      | Required | Notes                                                                                                       |
| ------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `sfml`        | SFMLVersionString         | yes      | The version of this specification the document targets.                                                       |
| `description` | String                    | no       | Free text an implementation MAY display to its users.                                                          |
| `parameters`  | Record<Name, JSON Schema> | no       | The factory's signature (§6.3).                                                                                |
| `start`       | StepName                  | yes      | The entry point. It is never inferred from graph topology, since a factory may loop back to its first step.   |
| `steps`       | Record<StepName, Step>    | yes      | The factory's steps (§6.4–§6.8).                                                                                |
| `assignee`    | String                    | no       | The run's default DRI. Opaque to SFML (§6.11).                                                                          |
| `budget`      | Decimal USD               | no       | The ceiling across every agent step of every iteration in the run (§9.7).                                       |

Unknown fields MUST be rejected (§5.4).

### 6.3 Parameters

`parameters` is the factory's signature: the contract between a factory and whatever starts a run of it. Each entry is a JSON Schema.

- A parameter with no `default` is REQUIRED. A run started without a value for it MUST be rejected
  at admission (§9.1), before a run id is minted and before any step has run.
- The values a caller supplies are bound as `parameters` on `FactoryState` (§9.2) and are readable
  from the expressions of every step. An Arthor MUST transalate these to `prompt_vars` via a `FactoryState Expression` when values are used for prompt templating.

### 6.4 Step: common fields

TODO: If a field is only used by one step type, its not really common and could be documented in the specific step types section. Lets make those edits.

Every step has a `type` of `agent`, `human`, `parallel`, or `result`. The following fields are
common to some or all of these types.

| Field                     | Type                                              | Required     | Applies to             |
| ------------------------- | -------------------------------------------------- | ------------ | ----------------------- |
| `type`                    | enum `agent` \| `human` \| `parallel` \| `result`  | yes          | all                     |
| `description`             | String                                              | no           | all                     |
| `prompt_vars`             | Record<Name, Expression>                            | no           | agent                   |
| `next`                    | List\<Connection\>                                  | yes          | agent, human, parallel  |
| `max_iterations`          | Integer                                             | no           | agent, human, parallel  |
| `budget`                  | Decimal USD                                         | no           | agent (§9.7)            |
| `retry`                   | `{ max_attempts, backoff }`                         | no           | agent (§6.10)           |
| `assignee`                | String                                              | no           | human (§6.11)           |
| `instructions`            | Expression                                          | no           | human                   |
| `harness`                 | `<name>[@<version>]`                                | yes          | agent (§6.12)           |
| `harness_config`          | Record<Key, Any>                                    | no           | agent (§6.12)           |
| `prompt_path` \| `prompt` | path \| String                                      | yes (one of) | agent                   |
| `result_schema`           | JSON Schema                                         | yes          | agent, human            |
| `steps`                   | Record<Name, Step>                                  | yes          | parallel (§6.7)         |
| `outcome`                 | enum `complete` \| `terminal_failure`               | yes          | result (§6.8)           |
| `value`                   | Expression                                          | no           | result (§6.8)           |

A field applied to a step type it does not apply to MUST be rejected (§5.4).

`result_schema`, where present, validates the object an `agent` or `human` step produces, before
routing (§9.5) is evaluated for that step. A `parallel` step MUST NOT declare `result_schema`: its
result is computed from its children, not authored (§6.7).

`prompt_vars` is declared per agent step. This makes a step's data dependencies visible to a linter
without evaluating expressions, and lets a step be exercised in isolation from the rest of the
factory.

### 6.5 Agent step

An `agent` step invokes a harness loop once per attempt (§3.2.6) and produces a result validated against `result_schema`.

- `harness` is REQUIRED and names, per §6.12, the harness that executes the step.
- Exactly one of `prompt_path` or `prompt` MUST be present.
- `prompt_vars` is evaluated as a set of `FactoryState Expression`s (§7.5.1) before the step runs,
  and the resulting bindings are what the prompt template renders against, as `PromptVars` (§7.5.2,
  §9.9). `FactoryState` itself is not reachable from the template.
- On success, the step's output is validated against `result_schema`; a failure to validate raises
  `schema_violation` (§10.4) once retry, if configured, is exhausted. (TODO: starting with on success is a bit weird here as failure to parse means it not a success).
- `budget` (§9.7) and `max_iterations` (§9.6), where present, bound the step's cost and iterations
  respectively.
- `retry` (§6.10) governs re-attempting a harness failure the harness has classified as retryable.

### 6.6 Human step

A `human` step blocks its branch (§11.1) until an operator supplies a payload validated against
`result_schema`.

- `assignee`, where present, names who is expected to act on this step. It is not inherited from
  the factory-level `assignee`; a human step with no `assignee` of its own is unassigned (§6.11). If an implementaion wishes to raise unassigned human steps to the factory-level `assignee` that is acceptable though not required.
- `instructions`, where present, is a `FactoryState Expression` evaluated to produce the content
  shown to whoever performs the step.
- A human step has no timeout, no escalation, and no failure mode of its own (§11.1). It either
  resumes with input that validates against `result_schema`, or it continues to wait; an input that
  does not validate is rejected at the call (§11.5) and the branch remains `awaiting_input`.
- `max_iterations`, where present, bounds how many times the step may be crossed (§9.6); a human
  step MUST NOT declare `budget`, since it does not invoke a harness.

### 6.7 Parallel step

A `parallel` step declares a map of named child steps in its own `steps` field, runs them
concurrently, and joins once every child has produced a result.

- A child MUST be a single `agent` or `human` step. A child MUST NOT declare `next`: a child cannot
  route, so a region contains no internal edges. A child MUST NOT itself be `type: parallel`.
- The join is `all`, implicitly, and the join is the `parallel` step itself.
- Control enters at the `parallel` step and leaves only through its own `next` (§6.9); this is the
  region's single entry and single exit.
- The step's result is an object keyed by child name, holding each child's result.
- A child's name is unique only within its own `parallel` step; a child is addressed outside its
  step definition by its qualified name (§5.3).
- `max_iterations`, where present on the `parallel` step, bounds iterations of the `parallel` step as a whole
  (§9.6). `budget` is declared per child (§9.7), not on the `parallel` step itself, which MUST NOT
  declare `budget`.

### 6.8 Result step

A `result` step is terminal: reaching one ends the run, and a run that has reached one MUST NOT be
resumed or restarted.

| Field     | Type                                  | Required |
| --------- | -------------------------------------- | -------- |
| `outcome` | enum `complete` \| `terminal_failure`  | yes      |
| `value`   | Expression                              | no       |

A `result` step MUST NOT declare `next`, `result_schema`, `harness`, or any field specific to
another step type. 

Where `value` is omitted, the step's result defaults by `outcome`:

- `complete` → `{ "ok": true }`
- `terminal_failure` → `{ "ok": false }`

TODO: Make it clear that a value is bound to `FactoryState` when its `expression` is being evaluated.

### 6.9 Connection

A `Connection` is one entry of a step's `next` list.

| Field  | Type       | Required | Notes                                                                                     |
| ------ | ---------- | -------- | -------------------------------------------------------------------------------------------- |
| `when` | Expression | no       | Absent means unconditional. There is no `else` key; the fallback is a connection with no `when`. |
| `to`   | StepName   | yes      | Exactly one target. Fan-out is expressed only by a `parallel` step (§6.7), never by a connection. |

- Connections in a step's `next` list are evaluated in declared order; the first whose `when` is
  absent or evaluates true is taken.
- Routing MUST be total: the last connection of every non-`result` step MUST omit `when`, so that
  step always has somewhere to go. A conforming Linter MUST enforce this (§8.3).
- Every connection is a success edge. There is no `on_error` and no `on_timeout` field; a step
  failure is an exception (clause 10), never a route.

### 6.10 Retry

`retry`, on an `agent` step, governs re-attempting any and all harness failures the harness itself has classified as retryable (§10.3).

| Field          | Type    | Notes                                                                 |
| -------------- | ------- | ----------------------------------------------------------------------- |
| `max_attempts` | Integer | The maximum number of attempts within one interation of the step.         |
| `backoff`      | —       | How to space attempts; an implementation MAY honor a backoff the harness states and MUST NOT invent one the harness did not. |

A failed attempt does not append to `results` (§9.3); exhausting `max_attempts`, or encountering a non-retryable failure, raises `harness_error` (§10.3).

TODO: `backoff` must have a type...

### 6.11 Assignee

TODO: I did a major rewrite here. This field keeps getting to complicated. The intent of my prose below is the purpose of this field. Ensure the rest of the document follows this and improve my prose to have clearer spec like lanague.

`assignee` on the `Factory` and `human` step are SFML defined values to allow `implementations` to empower `authors` to document assignment in ocordience with how the `implementations` broader system works. The value is a String, opaque to SFML. This specification does not define wheather it denotes a person, a team, a rotation or even if its a person or how this field is used in anyway within the implementations broder system.

### 6.12 Harness reference and harness configuration

TODO: Clean up paragraph below after my edits.

`harness`, REQUIRED on an `agent` step, is a String of the form `<name>[@<version>]` naming the
harness that executes the step. Resolution of `<name>` and `<version>` to an executable harness are implementation-defined. If the addressed harness at the specficied version cannot be found within the implemenation-defined resolution logic, the run must not be started.

`harness_config` is an OPTIONAL record of harness-defined keys and values, passed through to the named harness unexamined by the rest of this specification. Everything about a run's workspace — repository, branch, worktree, and what an agent may read or write — is confined to `harness_config`; portability of a factory file, as promised by this specification, ends at this
boundary.

An implemenation SHOULD make the `harness_config` conform with the standard configuration options of the defined harness.

## 7. Expression language

### 7.1 Relationship to CEL

Every SFML expression MUST parse as valid CEL. An implementation MAY use a CEL evaluator with the
function library of §7.4 registered as extensions, or MAY implement the subset of CEL this clause
defines directly in a language with no usable CEL binding; either satisfies this clause provided it
accepts exactly the grammar of §7.2 and rejects everything else.

### 7.2 Grammar subset

An SFML expression is drawn from a closed, small subset of CEL: field selection, indexing,
comparison and boolean operators, literals, and calls into the standard function library of §7.4.
User-defined functions, arithmetic on step results, and collection macros are not part of this
grammar; an expression using any of them is not a valid SFML expression regardless of its validity
as general CEL.

### 7.3 Null semantics and propagation

There is no optional-chaining operator. Field access on `null` yields `null` rather than an error;
combined with `last()` (§7.4) yielding `null` over an empty list, an expression such as
`last(emptyList).some_field` is valid and evaluates to `null`.

### 7.4 Standard function library

The standard function library is closed. The following CEL extensions are REQUIRED of every
conforming implementation, and no others allowed:

| Function        | Behavior                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `last(list)`    | The last element of `list`, or `null` if `list` is empty.                  |
| `empty(x)`      | `true` if `x` is an empty list, empty string, or `null`; `false` otherwise.|
| `notEmpty(x)`   | The negation of `empty(x)`.                                                |

### 7.5 Binding environments

An SFML expression is evaluated against exactly one binding environment, determined by where it
appears in the data model. Reaching outside the environment bound to a given site is a static error
(§8.6).

#### 7.5.1 FactoryState expressions

A `FactoryState Expression` targets `FactoryState` (§9.2). It is the kind of expression used in a
`Connection`'s `when` (§6.9), a human step's `instructions` (§6.6), a `result` step's `value`
(§6.8), and an agent step's `prompt_vars` (§6.5).

#### 7.5.2 PromptVars expressions

A `PromptVars Expression` targets the `PromptVars` (§9.9) of the agent step whose prompt template it
appears in. `FactoryState` is not reachable from this environment; anything a template needs MUST
first be named in that step's own `prompt_vars`.

### 7.6 Type checking

TODO: Maybe this is a later change. I don't think my initial implemenation example is going to do this.

An implementation SHOULD statically type-check an expression against the schema of the values it
resolves against — `result_schema` of the steps it references, and the JSON Schema of any referenced
parameter — and SHOULD report a type error before a run starts rather than at evaluation time.

### 7.7 Evaluation errors

TODO: This can't be a `harness_error`. It has nothing to do with a harness... We might need a new error type here.

An expression that is well-typed per §7.6 but fails at evaluation time (for example, indexing past
the end of a list) is a runtime evaluation error. An implementation MUST treat this the same as a
harness failure that is not retryable: it raises `harness_error` (§10.3) rather than silently
producing a value.

### 7.8 Prohibited constructs

An expression MUST NOT contain a user-defined function, arithmetic on a step result, a collection
macro, or any construct outside the grammar of §7.2, even where the underlying CEL implementation
would otherwise accept it. A Linter MUST reject such an expression.

## 8. Graph validity

### 8.1 Validation stages

Validity is checked in three stages, each with a different reach: parse (clause 5, structural shape
of the document), lint (this clause, static properties of the graph), and admission (§9.1, checks
that require information outside the file itself, such as an identity system). A document that
passes lint is not thereby known to be admittable, and the two stages MUST be kept distinct by a
conforming implementation.

### 8.2 Structural rules

TODO: This section seems to say a lot of things that are said in the types...

A Linter MUST enforce:

- Every step referenced by `start` or by a `Connection`'s `to` is declared in `steps`.
- A `parallel` step's child is an `agent` or `human` step.
- A `parallel` step's child declares no `next`.
- A `parallel` step's child is not itself `type: parallel`.
- Every field present on a step is one this specification assigns to that step's `type` (§6.4).

### 8.3 Totality of routing

TODO: This section seems wrongly named. The content is about how to lint `when`. Is there a way to do this via JSON schema so type checks get it? If so, lets move this to that like my comment in 8.2. If not, lets make this section about how to lint when.

The last `Connection` of every non-`result` step MUST omit `when` (§6.9). A Linter MUST reject a
step whose `next` list does not end this way. This is what makes the reachability check of §8.4
sound: since every step always has somewhere to go, "no path forward" can only be a lint-time defect, never a runtime condition to detect.

### 8.4 Reachability

TODO: I've reworded this to be clearer and allow crazy implementors to attempt to validate expressions at linting time if they want.

All steps must be reacheable from `start` and all routes from `start` must conclude with a `result` step. Any exception to this is a lint error. When confirming this a linter a Linter MAY ignore condition semantics and treat every `Connection` as traversable.

### 8.5 Termination

Every cycle in the graph MUST be bounded: a Linter MUST reject a cycle containing no step with a
finite `max_iterations`, since such a cycle has no syntactic guarantee of ever reaching a `result`
step.

### 8.6 Reference and binding validity

TODO: This section is getting into forcing implementors to parse CEL. What is the CEL AST support? How straight forward is what we are asking here?

TODO: `Each expression site resolves` this starts to get into template rendering which may be an under specified back of thsi spec right now. I don't think we have a `template` term, for instance.

TODO: I removed things that should be covered by type checks as that does not seem to have anything to do with references or binding validatiy.

- An unknown parameter name — `parameters.<name>` where `<name>` is not declared in the factory's
  `parameters` — is a hard error, for the same reason as an unknown step name below.
- An unknown step name — `results.<name>` where `<name>` is not declared in `steps` — is a hard
  error. Once such a reference cannot parse.
- A reference is checked by reachability, not by ancestry. A reference from step `Y` to
  `results.X` is legal if and only if some path `X → … → Y` exists in the graph, following loop-back edges.
- Each expression site resolves against exactly one binding environment, per §7.5. A Linter MUST
  reject an expression that reaches outside the environment bound to its site — for example, a
  `PromptVars Expression` referencing `results`.

### 8.7 Diagnostics and error identifiers

TODO: Where are these `stable, unique identifier` values documented?

Every rule in this clause has a stable, unique identifier that a conforming Linter MUST report on
failure. Message text accompanying an identifier is implementation-defined. This subclause holds the
registry of identifiers for this specification; an identifier, once assigned, MUST NOT be reused or
renumbered by a later version of this document.

### 8.8 What lint cannot check

Lint operates on the graph's shape and cannot evaluate expression semantics, cannot know an identity
system's membership rules (§6.11), and cannot know what a harness will report about cost or
retryability at runtime. A rule that would require any of these is not a lint rule; where such a
rule exists in this specification, it is checked at admission (clause 9) or raised as a runtime
exception (clause 10) instead.

## 9. Execution model

### 9.1 Admission

Before a run is given an id, an implementation MUST:

- Validate every supplied parameter value against its declared JSON Schema, and reject the run if a
  required parameter (one with no `default`) is missing or a supplied value fails validation.
- Validate the factory's and any step's declared `assignee` work within the implementers broder eco system and match its requirements on these fields.

A run rejected at admission has no run id, no recorded results, and raises no exception class of
clause 10; rejection at admission is distinct from, and precedes, everything clause 10 describes.

### 9.2 FactoryState

`FactoryState` is the value a `FactoryState Expression` (§7.5.1) resolves against.

| Field        | Type                                 | Notes                                                                                       |
| ------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `parameters` | Record<Name, Any>                     | The run's parameter values, validated and defaulted at admission. Constant for the run's lifetime. |
| `results`    | Record<StepName, List\<StepResult\>>  | Oldest to newest per step. `last()` (§7.4) retrieves the most recent.                            |

### 9.3 StepResult

A `StepResult` is the validated result object a step produces. `last(results.review).approved` reads `approved` directly off the object the `review` step produced.

A `StepResult` is appended to `results` only on the success of an iteration; a failed attempt appends nothing. Each step type produces its result differently. Each step type defines how their result is created.

### 9.4 Step lifecycle

On each iteration of a step, an implementation:

1. Checks the step's iteration bound (§9.6); if exceeded, raises `iteration_limit` (§10.5) without
   starting the step.
2. For an `agent` step, evaluates `prompt_vars` against `FactoryState`, renders the prompt as
   `PromptVars` (§9.9), and invokes the harness for one or more attempts per `retry` (§6.10),
   tracking reported cost against the step's budget (§9.7).
3. For a `human` step, blocks the branch in state `awaiting_input` (§11.1) until a valid resume
   arrives.
4. For a `parallel` step, starts every child concurrently (§9.8) and blocks until all have produced
   a result.
5. Validates the produced payload against `result_schema`, where the step type declares one; a
   validation failure on an `agent` step raises `schema_violation` (§10.4).
6. Appends the resulting `StepResult` to `results` and evaluates routing (§9.5).

### 9.5 Routing

On a successful iteration of a non-`result` step, an implementation evaluates the step's `next` list
in declared order (§6.9) and transitions control to the target of the first `Connection` whose
`when` is absent or evaluates to `true`. Routing always selects exactly one target.

### 9.6 Iteration bounds

`max_iterations` is a step field, checked on arrival:

> On entering step `X`, if `X` has already run `max_iterations` times, the step does not start.

- Iterations are counted from `results.<StepName>`.
- A retry (§6.10) is not an iteration: a failed attempt does not append to `results`, so
  `max_iterations: 3` means three inteartions of the step, not three attempts at it.
- Exceeding the bound raises `iteration_limit` (§10.5).
- The bound is per step, not per edge into the step: it reflects the ceiling on the work a step may do, independent of who routed into it.
- There is no factory-level iteration ceiling.

### 9.7 Budgets and monetary arithmetic

`budget` is a Decimal USD value, at most two decimal places. `5.00`, `0.25`, and `12` are legal
values; `1.005` MUST be rejected by a Linter (§8.6).

- The harness MUST report consumption in USD, accurately; it MAY report at finer precision than
  cents. The two-decimal-place constraint applies only to a value an author writes in the file, not
  to what a harness reports.
- `0.00` means the step cost nothing, not that cost was unmeasured. A harness that genuinely spends nothing — a local model, a self-hosted runner, a cached result — reports `0.00`. A harness that spends money and reports `0.00` is non-conforming.
- A `budget` field that is absent means unbounded. `budget: 0.00` raises `budget_exceeded` (§10.6)
  on arrival, and is a legitimate way to disable a step pending a grant (§11.6).
- There are two scopes. A step's `budget` covers every iteration of that step: a step with
  `max_iterations: 3` and `budget: 5.00` has five dollars across its three inteartions. A factory's
  `budget` (§6.2) covers every agent iteration across every step in the run, and is the ceiling for
  the run as a whole. A grant, when made, is applied at whichever scope raised the exception.
- A factory-level overrun is attributed to the run, not to any one step. All agent steps MUST stop at the next possible momenent when this is reached and must be resumed together if and when a grant is applied.

### 9.8 Concurrency and join

Concurrency takes exactly one shape, the `parallel` step (§6.7). On entering a `parallel`
step, an implementation starts every declared child concurrently, opening one branch per child
(§11.1). The step joins — appends its result and resumes single-branch control — once every child
has produced a result.

### 9.9 Prompt rendering

An agent step's `prompt_vars` (§6.5) is evaluated as a map of `FactoryState Expression`s before the
step's harness is invoked. The resulting bindings form `PromptVars`:

| Field         | Type              | Notes                                             |
| ------------- | ------------------ | ---------------------------------------------------- |
| `prompt_vars` | Record<Name, Any>  | The evaluated `prompt_vars` of the agent step.        |

A prompt template therefore references `prompt_vars.issue`, not a bare `issue`: the namespace lets a
future version of this specification add a sibling field to `PromptVars` without making an existing
template's bare names ambiguous. `FactoryState` is not reachable from a prompt template; anything a
template needs MUST be named first in the step's own `prompt_vars` (§7.5.2).

### 9.10 Termination

A run that reaches a `result` step is terminal. Its outcome and value are recorded per §6.8, and the
run MUST NOT be resumed or restarted; every branch that was live is now `done` (§11.1).

### 9.11 Determinism boundary

An agent step's invocation of its harness is the sole point of nondeterminism in a run: the harness's
output for given inputs is not guaranteed to repeat. Every other part of execution — routing (§9.5),
iteration accounting (§9.6), budget accounting (§9.7), and join ordering (§9.8) — is a pure function
of the `StepResult`s already in `FactoryState` and the file's own declarations. Consequently, a
routing trace (the ordered sequence of step entries and route decisions) produced from a given
sequence of `StepResult`s is fully determined; it does not depend on wall-clock time, on the order in
which unrelated events occur, or on anything the harness did once its result was reported.

## 10. Error model

### 10.1 Exceptions are not routes

A step failure is a factory exception, never a route. `on_error` and `on_timeout` fields do not
exist in this specification's data model (§6.9); an exception suspends a branch (§11.1) rather than
selecting a `Connection`.

### 10.2 Exception classes

| Class              | Raised when                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `schema_violation`  | An agent step's output fails `result_schema` validation and retry, where configured, has not fixed it. |
| `harness_error`     | The harness fails to produce a result for a reason outside the agent's own output contract.              |
| `iteration_limit`   | Entering a step would exceed its effective iteration bound (§9.6).                                       |
| `budget_exceeded`   | A step's reported consumption reaches or exceeds its effective budget (§9.7).                            |

All four classes are resumable (clause 11). Nothing in v0.1 is inherently fatal except reaching a
`result` step (§9.10).

### 10.3 Harness failure classification and retry

`harness_error` deliberately has no enumerated causes. Rate limits, authentication failures, network
faults, capacity limits, and a harness's own execution timeouts are all one class, since this
specification cannot enumerate what any of them look like across harnesses, and a fixed cause list
would be wrong for the next harness bound to it.

- The harness classifies. A conforming harness MUST report, with each failure, whether it is
  retryable, and MAY additionally state a backoff. A rate limit is an example of a retryable
  failure; invalid credentials or a malformed `harness_config` is an example of one that is not.
- `retry` (§6.10) supplies `max_attempts` and `backoff`; the harness supplies the retryability
  judgment. Retry applies only to a failure the harness has marked retryable.
- Exhausting `max_attempts`, or receiving a failure marked non-retryable, raises `harness_error`.
- When a run resumes from `harness_error`, the same harness session MUST be used, so that session
  state is continued (§11.7).

### 10.4 Schema violation

`schema_violation` applies only to `agent` steps, even though `result_schema` is also declared on
`human` steps. A human step's payload is instead validated when a resume arrives, and an invalid
payload is rejected at the call (§11.5): the resume fails, the step remains `awaiting_input`, and
nothing is appended. There is no failed attempt to record and no exception to resume from in this
case, because the run never left the state it was already in.

- An implementation MUST permit retry of `schema_violation`, and SHOULD default to at least one
  automatic attempt with the validator's error fed back into the reprompt when no `retry` is defined.
- A resume from `schema_violation` re-runs the step as a new agent turn, which may succeed or fail
  the same way again; the failure mode is repeatable even though the attempt itself is not, which is why retrying is worth doing.
- A resume from `schema_violation` MAY instead carry a result, validated against the step's
  `result_schema`, in place of re-running the agent (§11.4). Such a result is appended as the step's
  `StepResult` exactly as an agent-produced one would be, and routing cannot distinguish the two.

### 10.5 Iteration limit

`iteration_limit` is checked on arrival (§9.6), so nothing has run when it is raised and the state
at that point is unchanged. A resume from `iteration_limit` carries a payload: an integer number of
additional iterations to grant the step. The step's effective bound becomes
`effective_limit(X) = X.max_iterations + granted(X)`.

### 10.6 Budget exceeded

`budget_exceeded` is raised when a step's reported consumption reaches or exceeds its effective
budget (§9.7). A resume from `budget_exceeded` carries a payload: a Decimal USD amount, at most two
decimal places, to grant. The effective ceiling becomes
`effective_budget(X) = X.budget + granted_budget(X)`.

A run-level overrun is resumed at the step that was being entered when the ceiling was reached, but
the grant applies to the run as a whole (§9.7): the resume address says where execution continues,
while the exception itself says what was exceeded.

When a run resumes from `budget_exceeded`, the same harness session MUST be used for Agent Steps, so that session state is continued (§11.7).

An exception raised by a child of a `parallel` step names that child's qualified name (§5.3), and
only that child re-runs on resume; siblings that already produced a result keep it. A resume of this kind is therefore addressed to the child, for example `checks.audit`, never to the enclosing `parallel` step.

## 11. Pause and resume

### 11.1 Branch states

Stopping is a property of a branch, not of a run as a whole. A run has a set of live branches —
except while control is inside a `parallel` step, where it has one per child (§9.8). At any time a
branch is `running`, `awaiting_input`, `errored`, or `done`.

- A branch is `awaiting_input` at a `human` step that has not yet been resumed.
- A branch is `errored` where an exception of any class in clause 10 has been raised and not yet
  resolved by a resume.
- `awaiting_input` and `errored` are both **blocked**: the branch is stopped, nothing has been
  appended to `results` for that inteartion, and the branch advances only on a resume (§11.3).
- A branch is `done` once it has reached a `result` step, or, inside a `parallel` step, once its
  child has produced a result.

A `parallel` step with four children, one of them a `human` step still waiting, is a run with one
`awaiting_input` branch and three `done` or `running` branches; there is no separate notion of a
partially blocked run.

### 11.2 Derived run status

A run's status is derived, never stored independently of its branches:

1. `running`, if any branch is `running`.
2. Otherwise `errored`, if any branch is `errored`.
3. Otherwise `awaiting_input`, if any branch is `awaiting_input`.
4. Otherwise terminal, once a `result` step has been reached (§9.10).

### 11.3 Resume address

A run has an id, minted by the implementation; its type and encoding are unconstrained by this
specification.

A resume is addressed to `(run_id, step_name)`, where `step_name` is the name declared in the file,
qualified as `<parallel>.<child>` (§5.3) for a step inside a region. One address form serves both a
`human` step's `awaiting_input` block and an exception's `errored` block; what the resume does
follows from the state of the branch it addresses, not from a mode the caller selects.

A resume addressed to a step whose branch is neither `awaiting_input` nor `errored` in that run MUST
be rejected.

The address is total: it always names exactly one blocked branch. Concurrent blocks exist only as
children of a `parallel` step, each child has a distinct name within it (§5.3), and regions do not
nest, so no two live branches are ever blocked under the same qualified name regardless of what
blocked them.

A conforming implementation MUST document how a run id is obtained and how a blocked run at a named
step is resumed; this specification requires no more of the mechanism than that.

### 11.4 Payloads by branch state

TODO: harness_error should have a payload as well. Two options in my head are 1) a message to the harness for retry and 2) a result_schema payload like `schema_violation`.

The payload a resume carries depends on what blocked the branch:

| Branch state     | Raised by          | Payload                                         | Effect                                                                          |
| ----------------- | ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `awaiting_input`  | a `human` step       | object matching `result_schema`                   | appended as the step's `StepResult`                                                |
| `errored`         | `iteration_limit`   | integer, additional iterations                    | grant recorded (§11.6); the step is entered                                       |
| `errored`         | `budget_exceeded`   | Decimal USD, at most two decimal places           | grant recorded (§11.6); the step is entered                                       |
| `errored`         | `harness_error`     | none                                               | the step re-runs on the same harness session (§11.7)                              |
| `errored`         | `schema_violation`  | none, or an object matching `result_schema`       | the step re-runs as a new agent turn; if a payload is given, that result is appended instead |

### 11.5 Rejected resumes

A payload that does not match the row it is addressed to — an object that fails `result_schema`
validation, a grant of the wrong type, or a resume addressed to a class it does not apply to — MUST
be rejected at the call. The branch keeps the state it had, and nothing is appended: this is the
same rule §10.4 states for a `human` step's invalid input, generalized to every row of the table in
§11.4. A rejected resume is not an attempt and not a failure; the run has not moved.

A grant payload of zero is legal and is a no-op grant: the step is entered and immediately raises
the same exception again, since its effective bound or budget is unchanged. There is deliberately no
way to lower a ceiling once raised, only to raise it further.

### 11.6 Grants

A grant — additional iterations (§10.5) or additional budget (§10.6) — is not part of `FactoryState`
(§9.2) and is not reachable from any expression. A grant is a record in the run's history (clause
12), consulted only by the effective-limit and effective-budget computations of §9.6 and §9.7.

### 11.7 Session continuity

Where clause 10 or this clause states that a resume MUST use the same harness session — from
`harness_error` (§10.3) and from `budget_exceeded` (§10.6) — a conforming Runner MUST re-invoke the
same harness session that was active for the inteartion being resumed, rather than starting a new one,
so that any state the harness holds for that session (for example, prior turns of a conversation) is
continued rather than discarded. If that is not possible, an implementation MUST reject the resume.

## 12. Run records

TODO: I wonder if this should just be a simple "you figure this out" but "make resume equibalance happen" comment. The title would be wrong then.

### 12.1 Observability requirements

TODO: This section need a big reword. Really its about stoarge not observiablity.

An implementation's storage mechanism for the data required to full the Runner requirements are its own domain.

### 12.2 Resume equivalence

A run MUST be resumable after process death to a state equivalent to the one it had, where
equivalence is defined over `FactoryState` (§9.2): the same `results`, the same routing decisions,
and the same attempt counts as an uninterrupted run would have produced from the same sequence of
`StepResult`s. A run MUST also be resumable after a human-shaped pause of arbitrary duration, with
the same equivalence guarantee.

### 12.3 Operator-supplied results

TODO: I don't know if I agree here. Seems beyond the scope of this spec.

Where a resume supplies a result in place of one a step would otherwise have produced — the
`schema_violation` escape hatch of §10.4 — an implementation MUST record that the result was
operator-supplied. Nothing in `StepResult` or `FactoryState` carries this distinction; the run's
recorded history is the only place it survives.

### 12.4 What is not specified

TODO: Seems dumb.

Whether a run's owner may change mid-run, and by whom, is a matter for whatever identity system an
implementation uses; this specification records nothing about it and imposes no requirement on it.
Storage format, retention, and query interface for a run's recorded data are likewise unspecified
beyond the capabilities of §12.1–§12.3.

## 13. Versioning and extensibility

### 13.1 Version identifier

A factory document declares the version of this specification it targets in its top-level `sfml`
field, an `SFMLVersionString` (§6.1) such as `"v0.1"`. An implementation MUST reject a document
declaring a version it does not support.

### 13.2 Compatibility policy

A version of this specification MAY add new top-level or step-level fields; it MUST NOT change the meaning of a field already defined by a prior version. Because unknown fields are rejected (§5.4), an implementation of a given version MUST NOT be expected to accept a document that uses a field only a later version defines.

### 13.4 Extension points

Everything a runtime may vary is confined to two named, declared places: a step's `harness`
reference (§6.12) and its `harness_config`. A conforming implementation MUST NOT introduce
implementation-specific variation anywhere else in the data model; any such variation belongs behind these two fields, where an author can see it named in the file rather than infer it from which implementation happens to be running the factory.

---

## Annex A (normative) — JSON Schema

The JSON Schema for the surface syntax of a factory document is `sfml.schema.json` in this
repository. Where it conflicts with the normative text of this document, this document governs, per
§4.4.

## Annex B (normative) — Conformance test suite

TODO: Rework please.

The conformance test suite is the `conformance/` directory of this repository with `lint`, `runner`, `other-one` tests each in their own directory and each test as its own subdirectory. Each test directory supplies a valid or invalid SFML file, an expected FactoryState object at the end of the test, result file with either success or the expected error of the test and agent message scripts to be used by a `mock` harness. Conformance is acknowledged by reviewing the test suite of an implementation passes all tests. To achive this, all conforming implemenations must have mock harness which can use the agent messages. Details on these file formats can be found in `conformance/README.md`.

## Annex C (informative) — Worked example

TODO: Rewrite. Point to `example/`.
