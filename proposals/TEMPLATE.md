# NNNN: Title

| Field   | Value      |
| ------- | ---------- |
| Status  | draft      |
| Author  | Your name  |
| Created | YYYY-MM-DD |
| Targets | draft      |

## Problem

What is broken or impossible today, stated as something that happens to someone writing or running a
factory. No proposed solution here — only the symptom and who hits it.

## Motivation

Why this is worth changing the format for, and why it cannot be solved in a harness, in a linter, or
by writing the factory differently. Say who else has this problem and how you know.

## Prototype

What you built, where it lives, and what it taught you — including what you tried first and
abandoned. If the design changed between the prototype and this document, say what changed it.

## Specification

The proposed change, in RFC 2119 language, at the level of detail a second implementer could work
from.

Cover, where they apply:

- The document model: new or changed fields, their types, and whether they are required.
- Validation: every rule this adds, each with a decision procedure a linter can run.
- Runtime behaviour: routing, iteration, budget, concurrency, and what a run must record.
- Failure and resume: what exception this can raise, what a resume of it takes, and what the branch
  state is on either side.
- Compatibility: whether an existing valid factory keeps its meaning, and what a v0.1 implementation
  does when it meets this.

## Alternatives considered

Each alternative, what it would have cost, and why it lost. Include the alternative of doing
nothing, and the smallest possible version of this change.

## Open questions

What you could not settle, so reviewers know where to spend their attention.
