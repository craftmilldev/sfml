# Software Factory Markup Language (SFML)

**Version:** v0.1 **Status:** Draft **Copyright:** 2026 Plumbline LLC **License:** MIT

---

## Foreword

This document has no known essential patent claims against it. "Software Factory Markup Language"
and "SFML" are used here as descriptive names, not asserted as trade names. This is a draft: clause
numbering, examples, and normative wording are subject to change before v0.1 is tagged, and any such
change will be recorded in the repository's history rather than made silently. Feedback on this
draft should be submitted against the repository that hosts it. No warranty of any kind is made
about this document or the conformance of any implementation of it; see the accompanying license
for the applicable disclaimer of liability.

## Introduction

A software factory is a durable, resumable, mostly-autonomous pipeline that turns an intent, such as
an issue to implement, into a reviewed artifact. SFML is the file format that describes one: a graph
of steps connected by routing that an author writes down, a linter can check, and a team can share.

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
- That a run and its branches are resumable, after process death or a human-shaped pause, to a
  state provably equivalent to an uninterrupted run's (clause 12).
- The version identifier, compatibility policy, and extension points a factory file may rely on
  (clause 13).

### 1.2 What SFML does not define

SFML does not define:

- An agent framework. Tool definitions, memory, and context management belong to the harness a step
  names, not to this document. A factory file MAY track that a step used one of these, as free text
  or through `harness_config` (§6.12), but SFML assigns no meaning to what it tracks.
- A scheduler. SFML describes a run once it exists; what starts a run — a webhook, a cron job, a
  person — is out of scope.
- A general-purpose computation model. The expression language (clause 7) has no user-defined
  functions and no arithmetic on step results; a factory that needs logic expresses it as a step.
- Sub-factory composition. `type: factory` is not a value this version of the data model (§6.4)
  accepts; a future version may assign it a meaning.
- A workspace format. Repository, branch, worktree, and what an agent may read or write are bound
  entirely inside `harness_config` (§6.12); SFML does not model them.
- An identity system. `assignee` (§6.11) is carried as an opaque string; SFML never resolves,
  grants, or routes on identity.
- Cancellation of a running step or branch.
- Any behavior conditioned on wall-clock time.

## 2. Normative references

- RFC 2119, *Key words for use in RFCs to Indicate Requirement Levels*. <https://www.rfc-editor.org/rfc/rfc2119>
- RFC 8174, *Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words*. <https://www.rfc-editor.org/rfc/rfc8174>
- RFC 8259, *The JavaScript Object Notation (JSON) Data Interchange Format*. <https://www.rfc-editor.org/rfc/rfc8259>
- YAML 1.2, *YAML Ain't Markup Language*. <https://yaml.org/spec/1.2.2/>
- JSON Schema, 2020-12 core and validation specifications. <https://json-schema.org/specification-links#2020-12>
- Common Expression Language (CEL) language specification. <https://github.com/google/cel-spec/blob/master/doc/langdef.md>
- ISO 4217, *Currency codes*. <https://www.iso.org/iso-4217-currency-codes.html>

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

A single traversal of a step from entry to success, counted toward a step's `max_iterations`. Where
this document describes a step *entry* whose outcome is not yet known — the traversal is still in
progress, or it ended in an exception rather than success — it says "entry" or "entering," not
"iteration": only a successful entry is an iteration, per §9.6.

#### 3.2.6 Attempt

A single try at executing a step within one entry. An attempt that fails does not append to
`results`; an entry may consist of several attempts, ending in one iteration, when `retry` (§6.10)
applies.

#### 3.2.7 Prompt template

The content named by an agent step's `prompt_path` or `prompt` (§6.5): text interspersed with
placeholders (§7.9), rendered against that step's `PromptVars` (§7.5.2, §9.9) to produce the text
sent to the harness.

### 3.3 Roles

#### 3.3.1 Author

The person or persons, or the system, that writes a factory file.

#### 3.3.2 Caller

The person or system that starts a run, supplying the values bound to `parameters` (§6.3), or that
resumes a blocked run: supplying a human step's result, granting additional iterations or budget, or
supplying a caller-authored result in place of a wedged agent step (§11.4). This specification does
not distinguish whoever starts a run from whoever later resumes one; both act through the same
addressed calls (§9.1, §11.3), and a conforming implementation MAY apply its own access control to
either without SFML's involvement.

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
| Reject documents violating clause 5 (encoding, unknown keys)          |  MUST  |  MUST  |  MUST  |
| Produce the clause 6 data model from a valid document                |  MUST  |  MUST  |  MUST  |
| Report every clause 8 diagnostic with its §8.7 identifier             |   —    |  MUST  |  MUST  |
| Refuse to start a run of a factory with any clause 8 violation        |   —    |   —    |  MUST  |
| Implement admission (§9.1)                                            |   —    |   —    |  MUST  |
| Implement the execution model of clause 9                             |   —    |   —    |  MUST  |
| Raise the exception classes of clause 10 under their stated conditions|   —    |   —    |  MUST  |
| Implement resume addressing and payloads of clause 11                 |   —    |   —    |  MUST  |
| Satisfy the resumability requirement of clause 12                     |   —    |   —    |  MUST  |

A single piece of software MAY implement more than one conformance class. An implementation that
claims the Runner class MUST also satisfy the Parser and Linter requirements, since a Runner MUST
refuse to start a run of a factory that fails linting.

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

`parameters` is the factory's signature: the contract between a factory and whatever starts a run of
it. Each entry is a JSON Schema.

- A parameter with no `default` is REQUIRED. A run started without a value for it MUST be rejected
  at admission (§9.1), before a run id is minted and before any step has run.
- The values a caller supplies are bound as `parameters` on `FactoryState` (§9.2) and are readable
  from the expressions of every step. Since `FactoryState` is not reachable from a prompt template
  (§7.5.2), an Author who wants a parameter's value inside a prompt MUST bind it into that step's own
  `prompt_vars` (§6.4) via a `FactoryState Expression` (§7.5.1); a prompt template MUST NOT reference
  `parameters` directly.

### 6.4 Step: common fields

Every step has a `type` of `agent`, `human`, `parallel`, or `result`. The following fields are
common to two or more of these types; a field used by exactly one step type is documented in that
type's own subclause (§6.5–§6.8) instead.

| Field            | Type                                              | Required | Applies to             |
| ---------------- | -------------------------------------------------- | -------- | ----------------------- |
| `type`           | enum `agent` \| `human` \| `parallel` \| `result`  | yes      | all                     |
| `description`    | String                                              | no       | all                     |
| `next`           | List\<Connection\>                                  | yes      | agent, human, parallel  |
| `max_iterations` | Integer                                             | no       | agent, human, parallel  |
| `result_schema`  | JSON Schema                                         | yes      | agent, human            |

A field present on a step of a type it does not apply to MUST be rejected (§5.4). This applies both
to the fields above and to the type-specific fields documented in §6.5–§6.8.

`result_schema`, where present, validates the object an `agent` or `human` step produces, before
routing (§9.5) is evaluated for that step. A `parallel` step MUST NOT declare `result_schema`: its
result is computed from its children, not authored (§6.7).

### 6.5 Agent step

An `agent` step invokes a harness loop once per attempt (§3.2.6) and produces a result validated
against `result_schema`.

| Field                     | Type                         | Required     |
| ------------------------- | ----------------------------- | ------------ |
| `harness`                 | `<name>[@<version>]`          | yes          |
| `harness_config`          | Record<Key, Any>              | no           |
| `prompt_path` \| `prompt` | path \| String                | yes (one of) |
| `prompt_vars`             | Record<Name, Expression>      | no           |
| `budget`                  | Decimal USD                   | no           |
| `retry`                   | Integer                       | no           |

- `harness` is REQUIRED and names, per §6.12, the harness that executes the step.
- Exactly one of `prompt_path` or `prompt` MUST be present.
- `prompt_vars` is evaluated as a set of `FactoryState Expression`s (§7.5.1) before the step runs,
  and the resulting bindings are what the prompt template renders against, as `PromptVars` (§7.5.2,
  §9.9). `FactoryState` itself is not reachable from the template. Declaring `prompt_vars` per step
  makes a step's data dependencies visible to a linter without evaluating expressions, and lets a
  step be exercised in isolation from the rest of the factory.
- A successful attempt's output is validated against `result_schema`; a failure to validate raises
  `schema_violation` (§10.4) once retry, if configured, is exhausted. Validation failure and harness
  failure are distinct: an attempt fails to validate only after the harness has already produced
  output, which is why this is `schema_violation` and not `harness_error`.
- `budget` (§9.7) and `max_iterations` (§9.6), where present, bound the step's cost and iterations
  respectively.
- `retry` (§6.10) governs re-attempting a harness failure the harness has classified as retryable.

### 6.6 Human step

A `human` step blocks its branch (§11.1) until a caller supplies a payload validated against
`result_schema`.

| Field          | Type                       | Required |
| -------------- | --------------------------- | -------- |
| `assignee`     | String                       | no       |
| `instructions` | Expression                  | no       |

- `assignee`, where present, names who is expected to act on this step (§6.11). A human step that
  omits `assignee` is unassigned; this specification does not define whether an implementation
  treats an unassigned human step as falling back to the factory-level `assignee` (§6.2, §6.11).
- `instructions`, where present, is a `FactoryState Expression` evaluated to produce the content
  shown to whoever performs the step.
- A human step has no timeout, no escalation, and no failure mode of its own (§11.1). It either
  resumes with input that validates against `result_schema`, or it continues to wait; an input that
  does not validate is rejected at the call (§11.5) and the branch remains `awaiting_input`.
- `max_iterations`, where present, bounds the number of iterations of the step (§9.6); a human
  step MUST NOT declare `budget`, since it does not invoke a harness.

### 6.7 Parallel step

A `parallel` step declares a map of named child steps in its own `steps` field, runs them
concurrently, and joins once every child has produced a result.

| Field   | Type                | Required |
| ------- | -------------------- | -------- |
| `steps` | Record<Name, Step>    | yes      |

- A child MUST be a single `agent` or `human` step. A child MUST NOT declare `next`: a child cannot
  route, so a region contains no internal edges. A child MUST NOT itself be `type: parallel`.
- The join is `all`, implicitly, and the join is the `parallel` step itself.
- Control enters at the `parallel` step and leaves only through its own `next` (§6.9); this is the
  region's single entry and single exit.
- The step's result is an object keyed by child name, holding each child's result.
- A child's name is unique only within its own `parallel` step; a child is addressed outside its
  step definition by its qualified name (§5.3).
- `max_iterations`, where present on the `parallel` step, bounds iterations of the `parallel` step as
  a whole (§9.6). `budget` is declared per child (§9.7), not on the `parallel` step itself, which
  MUST NOT declare `budget`.

### 6.8 Result step

A `result` step is terminal: reaching one ends the run, and a run that has reached one MUST NOT be
resumed or restarted.

| Field     | Type                                  | Required |
| --------- | -------------------------------------- | -------- |
| `outcome` | enum `complete` \| `terminal_failure`  | yes      |
| `value`   | Expression                              | no       |

A `result` step MUST NOT declare `next`, `result_schema`, `harness`, or any field specific to
another step type.

`value`, where present, is a `FactoryState Expression` (§7.5.1), evaluated against `FactoryState`
(§9.2) to produce the step's result. Where `value` is omitted, the step's result defaults by
`outcome`:

- `complete` → `{ "ok": true }`
- `terminal_failure` → `{ "ok": false }`

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

`retry`, on an `agent` step, is an Integer: the maximum number of attempts within one entry to the
step. It governs re-attempting a harness failure that the harness itself has classified as
retryable (§10.3); an implementation MUST NOT re-attempt a failure the harness has not classified as
retryable, regardless of `retry`. An absent `retry` means one attempt: a retryable failure on that
single attempt raises `harness_error` (§10.3) immediately.

Spacing between attempts is not an authored field: where a harness states a backoff (§10.3), an
implementation MAY honor it and MUST NOT invent one the harness did not state.

A failed attempt does not append to `results` (§9.3); exhausting `retry`'s attempts, or encountering
a non-retryable failure, raises `harness_error` (§10.3).

### 6.11 Assignee

`assignee` is declared at two levels: on the `Factory` (§6.2) and on a `human` step (§6.6). Both
exist so an Author can record, in the file, who this specification calls the DRI of the run or the
worker on a step — in whatever terms the implementation's own systems use for ownership.

The value of either field is a String, opaque to SFML. This specification does not define what it
denotes — a person, a team, a rotation, a queue — and does not define how, or whether, an
implementation acts on it. `assignee` is a place for an Author to record ownership; it is not a
mechanism SFML uses to resolve, notify, or route to anyone.

### 6.12 Harness reference and harness configuration

`harness`, REQUIRED on an `agent` step, is a String of the form `<name>[@<version>]` naming the
harness that executes the step. Resolution of `<name>` and `<version>` to an executable harness is
implementation-defined, except that resolution MUST be deterministic for a given implementation and
configuration. Where a step's `harness` does not resolve to an executable harness, a run using that
step MUST NOT be started; an implementation MUST reject it at admission (§9.1).

`harness_config` is an OPTIONAL record of harness-defined keys and values, passed through to the
named harness unexamined by the rest of this specification. Everything about a run's workspace —
repository, branch, worktree, and what an agent may read or write — is confined to `harness_config`;
portability of a factory file, as promised by this specification, ends at this boundary.

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

An implementation SHOULD statically type-check an expression against the schema of the values it
resolves against — `result_schema` of the steps it references, and the JSON Schema of any referenced
parameter — and SHOULD report a type error before a run starts rather than at evaluation time.

### 7.7 Evaluation errors

An expression that is well-typed per §7.6 but fails at evaluation time (for example, indexing past
the end of a list), or a prompt template (§3.2.7) that fails to render against its evaluated
`PromptVars`, is a runtime evaluation error. An implementation MUST raise `expression_error` (§10.7)
rather than silently producing a value or a partial rendering.

### 7.8 Prohibited constructs

An expression MUST NOT contain a user-defined function, arithmetic on a step result, a collection
macro, or any construct outside the grammar of §7.2, even where the underlying CEL implementation
would otherwise accept it. A Linter MUST reject such an expression.

### 7.9 Prompt template placeholders

A prompt template — the content of `prompt`, or of the file `prompt_path` names — MUST be encoded as
UTF-8, independent of the factory document's own encoding (§5.1), so that the delimiter below is
unambiguous.

A placeholder in a prompt template (§3.2.7) is delimited by two consecutive `«` characters
(U+00AB LEFT-POINTING DOUBLE ANGLE QUOTATION MARK, doubled) and closed by two consecutive `»`
characters (U+00BB RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK, doubled) — `««` and `»»`, never a
single guillemet. A single `«` or `»`, anywhere it appears, is ordinary literal text and MUST NOT be
treated as part of a placeholder; only the doubled pair opens or closes one.

- The text between a `««` and the next `»»` is a `PromptVars Expression` (§7.5.2). Leading and
  trailing whitespace within the delimiters is insignificant.
- At render time (§9.9), each placeholder's enclosed text MUST parse as a `PromptVars Expression`
  per §7.2 and MUST evaluate against that step's `PromptVars`; a parse or evaluation failure raises
  `expression_error` (§10.7). This specification does not define a fallback for text that merely
  resembles a placeholder without being well-formed between a matched `««`/`»»` pair — a `««` with
  no following `»»` in the same template is a parse failure, not literal text.
- The evaluated value is substituted in place of the placeholder: a String value is inserted as-is;
  any other value (a number, boolean, `null`, list, or object) is inserted as its canonical JSON
  encoding. Everything outside a placeholder is copied to the output unchanged.

This specification defines no escape for a literal `««` or `»»` in template text. A single `«` or
`»` is unaffected by this rule and needs no special treatment; an author who needs the doubled
sequence itself to appear literally, rather than open a placeholder, has no way to express that.

## 8. Graph validity

### 8.1 Validation stages

Validity is checked in three stages, each with a different reach: parse (clause 5, structural shape
of the document), lint (this clause, static properties of the graph), and admission (§9.1, checks
that require information outside the file itself, such as an identity system). A document that
passes lint is not thereby known to be admittable, and the two stages MUST be kept distinct by a
conforming implementation.

### 8.2 Structural rules

Each of the following restates a constraint the data model of clause 6 already states normatively.
Restating it here is deliberate: it obligates a Linter to detect a violation and report it with the
diagnostic identifier registered in §8.7 (§4.1.2), a duty clause 6 does not itself impose.

A Linter MUST enforce:

- Every step referenced by `start` or by a `Connection`'s `to` is declared in `steps`.
- A `parallel` step's child is an `agent` or `human` step.
- A `parallel` step's child declares no `next`.
- A `parallel` step's child is not itself `type: parallel`.
- Every field present on a step is one this specification assigns to that step's `type` (§6.4).

### 8.3 Totality of routing

This is a Linter rule, not a schema rule: it constrains the *last item of an ordered list*
positionally, which JSON Schema (Annex A) can only express awkwardly and which is, in any case, the
class of graph-level reasoning §4.4 reserves for clause 8 rather than for the schema. Its name
describes the property it establishes — that routing is total — not the mechanism, which is why it
stays here rather than moving under §8.2.

The last `Connection` of every non-`result` step MUST omit `when` (§6.9). A Linter MUST reject a
step whose `next` list does not end this way. This is what makes the reachability check of §8.4
sound: since every step always has somewhere to go, "no path forward" can only be a lint-time
defect, never a runtime condition to detect.

### 8.4 Reachability

Every step MUST be reachable from `start`, and every path from `start` MUST reach a `result` step; a
Linter MUST reject a factory violating either condition.

A Linter MAY check this syntactically: ignore `when` semantics, treat every `Connection` as
traversable, and rely on totality of routing (§8.3) to make graph reachability the correct check.
This is sufficient and is the minimum a conforming Linter must do. A Linter MAY instead perform a
semantic analysis of `when` conditions to detect a step that is reachable syntactically but
unreachable given what its guards can evaluate to; doing so MUST NOT cause it to accept a factory the
syntactic check would reject.

### 8.5 Termination

Every cycle in the graph MUST be bounded: a Linter MUST reject a cycle containing no step with a
finite `max_iterations`, since such a cycle has no syntactic guarantee of ever reaching a `result`
step.

### 8.6 Reference and binding validity

Every check in this subclause is a walk of an expression's parse tree looking for field-selection
chains (`results.X`, `parameters.<name>`, and so on) — the kind of structural traversal any CEL AST
exposes without evaluating the expression. None of them require evaluating the expression itself,
and none require more of a CEL implementation than parsing to an AST already does.

- An unknown parameter name — `parameters.<name>` where `<name>` is not declared in the factory's
  `parameters` — is a hard error, for the same reason as an unknown step name below.
- An unknown step name — `results.<name>` where `<name>` is not declared in `steps` — is a hard
  error.
- A reference is checked by reachability, not by ancestry. A reference from step `Y` to
  `results.X` is legal if and only if some path `X → … → Y` exists in the graph, following loop-back
  edges.
- Each expression site resolves against exactly one binding environment, per §7.5. A Linter MUST
  reject an expression that reaches outside the environment bound to its site — for example, a
  `PromptVars Expression` (§7.5.2), evaluated against the `PromptVars` of the prompt template
  (§3.2.7) it appears in, referencing `results`.

This subclause governs references and binding environments only. A field's own value type — for
example, that `budget` (§9.7) has at most two decimal places, or that `assignee` (§6.11) is a String
— is validated as part of the data model of clause 6 rather than checked here.

### 8.7 Diagnostics and error identifiers

Every rule in this clause has a stable, unique identifier that a conforming Linter MUST report on
failure. Message text accompanying an identifier is implementation-defined. This subclause holds the
registry of identifiers for this specification; an identifier, once assigned, MUST NOT be reused or
renumbered by a later version of this document.

| Identifier                        | Clause | Rule                                                                 |
| ---------------------------------- | ------ | --------------------------------------------------------------------- |
| `unknown-step-reference`           | §8.2   | `start` or a `Connection`'s `to` names a step not declared in `steps`. |
| `invalid-parallel-child-type`      | §8.2   | A `parallel` step's child is not an `agent` or `human` step.           |
| `parallel-child-has-next`          | §8.2   | A `parallel` step's child declares `next`.                             |
| `nested-parallel`                  | §8.2   | A `parallel` step's child is itself `type: parallel`.                  |
| `field-not-applicable-to-type`     | §8.2   | A step declares a field this specification does not assign to its `type` (§6.4). |
| `non-total-routing`                | §8.3   | The last `Connection` of a non-`result` step does not omit `when`.     |
| `unreachable-step`                 | §8.4   | A step is not reachable from `start`.                                  |
| `no-path-to-result`                | §8.4   | A path from `start` does not reach a `result` step.                    |
| `unbounded-cycle`                  | §8.5   | A cycle contains no step with a finite `max_iterations`.               |
| `unknown-parameter-reference`      | §8.6   | An expression references `parameters.<name>` for an undeclared `<name>`. |
| `unknown-step-result-reference`    | §8.6   | An expression references `results.<name>` for an undeclared `<name>`.  |
| `unreachable-reference`            | §8.6   | An expression references `results.X` from step `Y` with no path `X → … → Y`. |
| `binding-environment-violation`    | §8.6   | An expression references a value outside the binding environment bound to its site (§7.5). |

### 8.8 What lint cannot check

Lint operates on the graph's shape and cannot evaluate expression semantics, cannot know whatever an
implementation checks `assignee` (§6.11) against, and cannot know what a harness will report about
cost or retryability at runtime. A rule that would require any of these is not a lint rule; where
such a rule exists in this specification, it is checked at admission (clause 9) or raised as a runtime
exception (clause 10) instead.

## 9. Execution model

### 9.1 Admission

Before a run is given an id, an implementation MUST:

- Validate every supplied parameter value against its declared JSON Schema, and reject the run if a
  required parameter (one with no `default`) is missing or a supplied value fails validation.
- Resolve every agent step's `harness` reference (§6.12) to an executable harness, and reject the
  run if any step names one that does not resolve.

An implementation MAY perform additional checks of its own at admission — for example, against
`assignee` (§6.11) or against its own identity system — but this specification imposes none beyond
the two above.

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

A `StepResult` is appended to `results` only on the success of an entry to a step (§3.2.5); a
failed attempt appends nothing. Each step type defines how its own result is created: see §6.5 for
an `agent` step, §6.6 for a `human` step, §6.7 for a `parallel` step, and §6.8 for a `result` step.

### 9.4 Step lifecycle

On each entry to a step, an implementation:

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

On an iteration of a non-`result` step, an implementation evaluates the step's `next` list
in declared order (§6.9) and transitions control to the target of the first `Connection` whose
`when` is absent or evaluates to `true`. Routing always selects exactly one target.

### 9.6 Iteration bounds

`max_iterations` is a step field, checked on arrival:

> On entering step `X`, if `X` has already run `max_iterations` times, the step does not start.

- Iterations are counted from `results.<StepName>`.
- A retry (§6.10) is not an iteration: a failed attempt does not append to `results`, so
  `max_iterations: 3` means three iterations of the step, not three attempts at it.
- Exceeding the bound raises `iteration_limit` (§10.5).
- The bound is per step, not per edge into the step: it reflects the ceiling on the work a step may do, independent of who routed into it.
- There is no factory-level iteration ceiling.

### 9.7 Budgets and monetary arithmetic

`budget` is a Decimal USD value, at most two decimal places (§6.1). `5.00`, `0.25`, and `12` are
legal values; `1.005` is not a legal Decimal USD value and MUST be rejected wherever `budget`
appears.

- The harness MUST report consumption in USD, accurately; it MAY report at finer precision than
  cents. The two-decimal-place constraint applies only to a value an author writes in the file, not
  to what a harness reports.
- `0.00` means the step cost nothing, not that cost was unmeasured. A harness that genuinely spends nothing — a local model, a self-hosted runner, a cached result — reports `0.00`. A harness that spends money and reports `0.00` is non-conforming.
- A `budget` field that is absent means unbounded. `budget: 0.00` raises `budget_exceeded` (§10.6)
  on arrival, and is a legitimate way to disable a step pending a grant (§11.6).
- There are two scopes. A step's `budget` covers every iteration of that step: a step with
  `max_iterations: 3` and `budget: 5.00` has five dollars across its three iterations. A factory's
  `budget` (§6.2) covers every agent iteration across every step in the run, and is the ceiling for
  the run as a whole. A grant, when made, is applied at whichever scope raised the exception.
- A factory-level overrun is attributed to the run, not to any one step: the concurrent children of
  a `parallel` step (§6.7) draw on the same run-level pool while they run, so a factory-level
  `budget_exceeded` is a property of the pool, not of whichever child's report happened to cross it.
  Each child MAY independently exceed its own child-level `budget` (§10.6); that is a per-step
  overrun like any other, addressed to that child. But once the shared, run-level ceiling is
  reached, every agent step currently drawing on that pool MUST stop at the next point it would
  report consumption and raise `budget_exceeded`; where this happens inside a `parallel` step's
  region, the exception is addressed to the `parallel` step itself, not to whichever child's report
  crossed the ceiling (§10.6) — an implementation MUST NOT let some children continue past the
  ceiling while others have already stopped.

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

Rendering means substituting every placeholder (§7.9) in the template's text with the string
produced by evaluating it against `PromptVars`; the text sent to the harness is the result. A parse
or evaluation failure in any placeholder raises `expression_error` (§10.7) before the harness is
invoked for that entry.

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
| `expression_error`  | A well-typed expression, or a prompt template, fails at evaluation or render time (§7.7).                |

All five classes are resumable (clause 11). Nothing in v0.1 is inherently fatal except reaching a
`result` step (§9.10).

### 10.3 Harness failure classification and retry

`harness_error` deliberately has no enumerated causes. Rate limits, authentication failures, network
faults, capacity limits, and a harness's own execution timeouts are all one class, since this
specification cannot enumerate what any of them look like across harnesses, and a fixed cause list
would be wrong for the next harness bound to it.

- The harness classifies. A conforming harness MUST report, with each failure, whether it is
  retryable, and MAY additionally state a backoff. A rate limit is an example of a retryable
  failure; invalid credentials or a malformed `harness_config` is an example of one that is not.
- `retry` (§6.10) supplies the maximum number of attempts; the harness supplies the retryability
  judgment and, where it states one, the backoff. Retry applies only to a failure the harness has
  marked retryable.
- Exhausting `retry`'s attempts, or receiving a failure marked non-retryable, raises `harness_error`.
- A resume from `harness_error` re-runs the step as a new agent turn on the same harness session,
  which MUST be used so that session state is continued (§11.7).
- A resume from `harness_error` MAY instead carry a result, validated against the step's
  `result_schema`, in place of re-running the harness (§11.4) — the same escape hatch §10.4 gives
  `schema_violation`, for the same reason: a harness that cannot produce a result no matter how many
  times it is invoked would otherwise wedge the run permanently.

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

A resume from `budget_exceeded` uses the same harness session that was running when the ceiling was
reached, per §11.7.

The address a resume uses depends on the scope that was exceeded and where control was:

- A **step-level** overrun — a step's own `budget` (§6.7, §6.4) reaches or exceeds its effective
  ceiling — names that step, qualified (§5.3) if it is a `parallel` step's child, and only that step
  re-runs on resume; every other step, sibling or not, is unaffected. A resume of this kind is
  addressed to the step itself, for example `checks.audit`.
- A **factory-level** overrun outside any `parallel` region names the single step that was being
  entered when the run-level ceiling was reached; the grant applies to the run as a whole (§9.7)
  even though the address is that one step.
- A **factory-level** overrun reached while control is inside a `parallel` step's region is
  different again: it is not any one child's failure, since the children only collectively draw the
  shared pool down (§9.7). This exception names the enclosing `parallel` step itself — unqualified,
  never a child's qualified name — and a resume is addressed there, not to any child. Every child
  that has not yet produced a result when the region stops is included in this single block; a
  child that already produced a result before the region stopped keeps it, untouched. A resume
  addressed to the `parallel` step, carrying a grant, raises the run's `effective_budget` and
  re-enters every one of its still-incomplete children together, each re-invoking its own harness
  session per §11.7 as though individually resumed. A caller never addresses a factory-level
  overrun to a child, even though it was a child's report that crossed the ceiling — the address
  names the region that was spending, not the report that happened to trip it.

In every case, the resume address says where execution continues, while the exception itself says
what was exceeded; these need not be the same scope, as the factory-level cases show.

### 10.7 Expression error

`expression_error` is raised when an expression (§7.7) — a `FactoryState Expression` or a
`PromptVars Expression`, wherever either is evaluated — fails at evaluation or render time despite
being well-typed. Where it is raised depends on whether the step's own `StepResult` (§9.3) has
already been appended (§9.4) at that point, and this governs both what remains blocked and what a
resume can supply.

- **Before the step's own result exists** — an agent step's `prompt_vars` (§6.5) or prompt template
  (§3.2.7), a human step's `instructions` (§6.6), or a `result` step's `value` (§6.8) — nothing has
  been appended to `results` for the entry, exactly as for any other exception raised before a
  step's own entry completes (§11.1). A resume re-attempts the entry from the start. A resume MAY
  instead carry a result in place of re-attempting: an object validated against `result_schema` for
  a step type that declares one (agent, human), or, for a `result` step, which declares no
  `result_schema` (§6.4), any JSON value. Either way the supplied value is appended as the step's
  `StepResult`, exactly as the escape hatches of §10.3 and §10.4 work.
- **After the step's own result exists** — a `Connection`'s `when` (§6.9), evaluated once routing
  begins (§9.4, §9.5) — the step's `StepResult` is already appended and is not reconsidered; only
  the routing decision is missing. A resume re-evaluates the `when` list from the start. A resume
  MAY instead carry a payload naming one `StepName` from that step's own declared `next` list, taken
  as the routing decision in place of re-evaluating `when`; an implementation MUST reject a payload
  naming a target the step's `next` does not declare (§11.5).

## 11. Pause and resume

### 11.1 Branch states

Stopping is a property of a branch, not of a run as a whole. A run has a set of live branches —
except while control is inside a `parallel` step, where it has one per child (§9.8). At any time a
branch is `running`, `awaiting_input`, `errored`, or `done`.

- A branch is `awaiting_input` at a `human` step that has not yet been resumed.
- A branch is `errored` where an exception of any class in clause 10 has been raised and not yet
  resolved by a resume.
- `awaiting_input` and `errored` are both **blocked**: the branch is stopped, and it advances only
  on a resume (§11.3). For every exception class but one, nothing has been appended to `results` for
  that entry. The one exception is `expression_error` raised evaluating a `Connection`'s `when`
  (§10.7): there, the step's own `StepResult` was already appended before routing — the routing
  decision is what failed, not the step's own entry.
- A branch is `done` once it has reached a `result` step, or, inside a `parallel` step, once its
  child has produced a result.

A `parallel` step with four children, one of them a `human` step still waiting, is a run with one
`awaiting_input` branch and three `done` or `running` branches; there is no separate notion of a
partially blocked run.

A factory-level `budget_exceeded` (§10.6) reached inside a `parallel` step's region is the one
exception to "one branch per child": every child that has not yet produced a result collapses into
a single `errored` branch, addressed by the `parallel` step's own name rather than by any child's
qualified name, until a resume there re-forks them back into their own running branches. A child
that already produced a result before the region stopped keeps its own `done` branch, unaffected.

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

The address is total: it always names exactly one blocked branch — except a factory-level
`budget_exceeded` inside a `parallel` step's region (§10.6, §11.1), whose single address, the
`parallel` step's own name, represents every one of that region's still-incomplete children at
once. Outside that case, concurrent blocks exist only as children of a `parallel` step, each child
has a distinct name within it (§5.3), and regions do not nest, so no two live branches are ever
blocked under the same qualified name regardless of what blocked them.

A conforming implementation MUST document how a run id is obtained and how a blocked run at a named
step is resumed; this specification requires no more of the mechanism than that.

### 11.4 Payloads by branch state

Every class that can be resumed past by re-attempting can also be resumed past by supplying the
value the automatic path would otherwise have produced: `schema_violation` (§10.4), `harness_error`
(§10.3), and `expression_error` raised before a step's own result exists (§10.7) all accept an
override of the step's `StepResult` in place of re-attempting; `expression_error` raised evaluating
`when`, where the step's own result already exists, instead accepts an override of the routing
decision (§10.7). `iteration_limit` and `budget_exceeded` are different in kind — they take a grant,
not a substitute value, since what is missing is not a result but permission to keep spending
(§10.5, §10.6).

The payload a resume carries depends on what blocked the branch:

| Branch state     | Raised by          | Payload                                                     | Effect                                                                          |
| ----------------- | ------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `awaiting_input`  | a `human` step       | object matching `result_schema`                               | appended as the step's `StepResult`                                                |
| `errored`         | `iteration_limit`   | integer, additional iterations                                | grant recorded (§11.6); the step is entered                                       |
| `errored`         | `budget_exceeded`   | Decimal USD, at most two decimal places                       | grant recorded (§11.6); the step is entered                                       |
| `errored`         | `harness_error`     | none, or an object matching `result_schema`                   | the step re-runs on the same harness session; if a payload is given, that result is appended instead (§11.7) |
| `errored`         | `schema_violation`  | none, or an object matching `result_schema`                   | the step re-runs as a new agent turn; if a payload is given, that result is appended instead |
| `errored`         | `expression_error`  | none, or (before the step's result exists) an object matching `result_schema`, or (routing) a `StepName` from the step's own `next` | the entry re-attempts, or the given result is appended, or the given target is routed to (§10.7) |

### 11.5 Rejected resumes

A payload that does not match the row it is addressed to — an object that fails `result_schema`
validation, a grant of the wrong type, a `StepName` not among the addressed step's own declared
`next` targets (§10.7), or a resume addressed to a class it does not apply to — MUST be rejected at
the call. The branch keeps the state it had, and nothing is appended: this is the same rule §10.4
states for a `human` step's invalid input, generalized to every row of the table in §11.4. A
rejected resume is not an attempt and not a failure; the run has not moved.

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
same harness session that was active for the entry being resumed, rather than starting a new one,
so that any state the harness holds for that session (for example, prior turns of a conversation) is
continued rather than discarded. If that is not possible, an implementation MUST reject the resume.
Where a resume from `harness_error` or `schema_violation` instead supplies a result (§11.4), no
harness invocation occurs and this subclause does not apply.

## 12. Resumability

### 12.1 Resume equivalence

A run MUST be resumable after process death to a state equivalent to the one it had, where
equivalence is defined over `FactoryState` (§9.2): the same `results`, the same routing decisions,
and the same attempt counts as an uninterrupted run would have produced from the same sequence of
`StepResult`s. A run MUST also be resumable after a human-shaped pause of arbitrary duration, with
the same equivalence guarantee.

This is the whole of what this specification requires of a run's recorded history. What else an
implementation records — observability of individual attempts, provenance of a caller-supplied
result (§10.4), who owns a run and whether that can change — is a property of the implementation's
own operational tooling, not of the SFML file format this specification defines, and this
specification imposes no requirement on it. How that data is stored, indexed, or queried is
likewise the implementation's own business.

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

The conformance test suite is the `conformance/` directory of this repository, organized into one
top-level category per conformance class (§4.1): `parser/` for the document-format checks of
clause 5, `lint/` for the static checks of clause 8, and `runner/` for the execution-model behavior
of clauses 9–11. Each holds one subdirectory per case, and an implementation conforms with respect
to a given class once its test suite passes every case in that class's directory — a Linter need
not pass `runner/`, but a Runner MUST pass `parser/` and `lint/` as well as `runner/`, per §4.1.3.

A case's directory supplies: the SFML file (or, for `parser/`, the raw document) under test, valid
or invalid as the case requires; for a `lint/` case, the diagnostic identifier (§8.7) it MUST raise,
if any; for a `runner/` case, the `FactoryState` (§9.2) the case MUST produce, and a result file
stating whether the case is expected to succeed or to raise a named exception (clause 10); and,
where the case invokes an agent step, a script of canned agent messages for the mock harness to
play back. A conforming implementation MUST supply a mock harness capable of consuming these
scripts and, against them, reproducing the routing trace and `FactoryState` a case declares. The
exact file formats are documented in `conformance/README.md`, not in this document.

## Annex C (informative) — Worked example

The worked example lives in `example/`, not in this document and not in `conformance/`: it is
maintained separately so it can prioritize being a clear, readable factory over being an exhaustive
conformance case. It runs on the mock harness of Annex B. This annex is informative; nothing in
`example/` is itself normative, though the clauses it illustrates are.
