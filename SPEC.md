# Software Factory Markup Language (SFML)

**Version:** v0.1 **Status:** Pre-draft **Copyright:** 2026 Plumbline LLC **License:** MIT

---

## Foreword

_(Template boilerplate: patent notices, trade name disclaimer, preparation details, edition and
changes, patent exclusion notices, how to submit feedback, disclaimer and liability.)_

## Introduction

_(Informative. What a software factory is; why the factory graph is worth separating from the agent
runtime.)_

---

## 1. Scope

### 1.1 What SFML defines

### 1.2 What SFML does not define

## 2. Normative references

_(RFC 2119, RFC 8174, RFC 8259, YAML 1.2, JSON Schema, CEL, ISO 4217.)_

## 3. Terms and definitions

### 3.1 Notational conventions

### 3.2 Terms

#### 3.2.1 Factory

#### 3.2.2 Run

#### 3.2.3 Branch

#### 3.2.4 Crossing

#### 3.2.5 Iteration

#### 3.2.6 Attempt

### 3.3 Roles

#### 3.3.1 Author

#### 3.3.2 Caller

#### 3.3.3 Operator

#### 3.3.4 Harness

_(The component that executes an agent step and returns a result. SFML names it, bounds it, and
does not describe how it works.)_

#### 3.3.5 Implementation

## 4. Conformance

### 4.1 Conformance classes

#### 4.1.1 Parser

#### 4.1.2 Linter

#### 4.1.3 Runner

_(Owns what an agent step must achieve regardless of which harness it binds: reporting cost,
continuing the same session across a resume, and classifying a failure as retryable or not. How it
gets any of them from a harness is its own business.)_

### 4.2 Requirements by class

### 4.3 Declared postures and the documentation obligation

### 4.4 Precedence of this document over Annex A

## 5. Document format

### 5.1 Encoding and surface syntax

### 5.2 Names and identifiers

### 5.3 Qualified names

### 5.4 Unknown fields

### 5.5 Reserved keys

### 5.6 Duplicate keys

## 6. Data model

### 6.1 Value types

_(String, integer, decimal USD, JSON Schema, Expression, StepName, SFMLVersionString)_

### 6.2 Factory

### 6.3 Parameters

### 6.4 Step: common fields

### 6.5 Agent step

_(Carries the agent step requirements: reported cost, retryable-or-not failure classification, and
session continuity across a resume.)_

### 6.6 Human step

### 6.7 Parallel step

### 6.8 Result step

### 6.9 Connection

### 6.10 Retry

### 6.11 Assignee

### 6.12 Harness reference and harness configuration

## 7. Expression language

### 7.1 Relationship to CEL

### 7.2 Grammar subset

### 7.3 Null semantics and propagation

### 7.4 Standard function library

### 7.5 Binding environments

#### 7.5.1 FactoryState expressions

#### 7.5.2 PromptVars expressions

### 7.6 Type checking

### 7.7 Evaluation errors

### 7.8 Prohibited constructs

## 8. Graph validity

### 8.1 Validation stages

_(Parse, lint, admission.)_

### 8.2 Structural rules

_(Includes the parallel step's constraints: a child is an agent or human step, a child has no
`next`, a child may not itself be parallel.)_

### 8.3 Totality of routing

### 8.4 Reachability

### 8.5 Termination

### 8.6 Reference and binding validity

_(Unknown parameter and step names are hard errors; a reference from Y to `results.X` is legal iff
some path X -> ... -> Y exists; each expression site resolves against exactly one binding
environment per 7.5, and reaching outside it is a static error.)_

### 8.7 Diagnostics and error identifiers

_(Every rule in this clause has a stable, unique identifier that a conforming linter MUST report on
failure. Message text is implementation-defined. Holds the registry of identifiers; identifiers are
never reused or renumbered.)_

### 8.8 What lint cannot check

## 9. Execution model

### 9.1 Admission

### 9.2 FactoryState

### 9.3 StepResult

### 9.4 Step lifecycle

### 9.5 Routing

### 9.6 Iteration bounds

### 9.7 Budgets and monetary arithmetic

### 9.8 Concurrency and join

### 9.9 Prompt rendering

### 9.10 Termination

### 9.11 Determinism boundary

## 10. Error model

### 10.1 Exceptions are not routes

### 10.2 Exception classes

### 10.3 Harness failure classification and retry

### 10.4 Schema violation

### 10.5 Iteration limit

### 10.6 Budget exceeded

## 11. Pause and resume

### 11.1 Branch states

### 11.2 Derived run status

### 11.3 Resume address

_(Qualified `<parallel>.<child>` addressing; a resume names the failed child, not its parent, so
only that child re-runs and siblings keep the results they already produced.)_

### 11.4 Payloads by branch state

### 11.5 Rejected resumes

### 11.6 Grants

### 11.7 Session continuity

## 12. Run records

### 12.1 Observability requirements

### 12.2 Resume equivalence

### 12.3 Operator-supplied results

### 12.4 What is not specified

## 13. Versioning and extensibility

### 13.1 Version identifier

### 13.2 Compatibility policy

### 13.3 Reserved names

### 13.4 Extension points

---

## Annex A (normative) — JSON Schema

_(Points to `sfml.schema.json` in this repository, with the precedence rule of 4.4.)_

## Annex B (normative) — Conformance test suite

_(Suite structure; positive and negative cases; routing-trace assertions.)_

## Annex C (informative) — Worked example

## Annex D (informative) — Deferred to v0.2
