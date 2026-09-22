/**
 * SFML — Software Factory Markup Language, draft.
 *
 * This file is the source of truth for the SFML schema. `schema/draft/schema.json`
 * and `docs/specification/draft/schema.mdx` are generated from it; do not edit
 * those by hand. See CONTRIBUTING.md.
 *
 * The types below are a starting point covering the v0.1 core described in
 * `PRD.md` §6. They are deliberately incomplete: the RFC-2119 prose and the
 * remaining fields land as the specification is drafted.
 *
 * @module
 */

/**
 * The SFML version a factory file declares, e.g. `"v0.1"`.
 *
 * The `v` prefix is part of the value, and the value is a string rather than a
 * number so that `v0.1` and `v1.1` are both expressible and distinct.
 */
export type SfmlVersion = string;

/**
 * The key a step is declared under in {@link Factory.steps}.
 *
 * `.` is reserved as the qualifier separator for the children of a
 * {@link ParallelStep}, so it cannot appear in a name itself.
 */
export type StepName = string;

/**
 * An expression in SFML's narrow expression language.
 *
 * Every SFML expression parses as valid CEL. The grammar is closed and small:
 * field selection, indexing, comparison and boolean operators, literals, and
 * calls into the closed standard function library (`last`, `empty`, `notEmpty`).
 *
 * What an expression is evaluated against depends on where it appears: routing
 * conditions, human `instructions`, and result `value`s see {@link FactoryState};
 * prompt templates see {@link PromptVars}.
 */
export type Expression = string;

/**
 * A JSON Schema, used to declare factory parameters and step results.
 *
 * SFML does not constrain the dialect beyond requiring a valid schema, so
 * ordinary keywords such as `description` and `default` carry their usual
 * meaning rather than being reinvented by SFML.
 */
export type JsonSchema = object;

/**
 * A ceiling in United States dollars, at most two decimal places.
 *
 * `0.00` means *this cost nothing*, not *this was not measured*. Absent means
 * unbounded. Implementations should hold budgets and accumulated consumption as
 * integer cents.
 *
 * @minimum 0
 */
export type Budget = number;

/**
 * An opaque identifier for a person, team, rotation, group, or queue.
 *
 * SFML defines no syntax for the value beyond it being a string, and never
 * resolves, grants, or routes one.
 */
export type Assignee = string;

/**
 * A software factory: a durable, resumable pipeline that turns an intent into a
 * reviewed artifact.
 *
 * Unknown fields are rejected at every level of an SFML document.
 */
export interface Factory {
    /** The SFML version this file is written against. */
    sfml: SfmlVersion;

    /** Human-readable description of what this factory does. */
    description?: string;

    /**
     * The factory's signature: what a caller must supply to start a run.
     *
     * Each entry is a JSON Schema. A parameter with no `default` is required,
     * and a run that omits one is rejected at admission.
     */
    parameters?: { [name: string]: JsonSchema };

    /**
     * The step a run enters first.
     *
     * Always explicit, never inferred from topology — inference breaks every
     * factory that loops back to its first step.
     */
    start: StepName;

    /** The factory's steps, keyed by {@link StepName}. */
    steps: { [name: string]: Step };

    /**
     * The DRI of the run: the fallback owner, and who resolves iteration and
     * budget grants.
     *
     * This does **not** default onto {@link HumanStep.assignee}.
     */
    assignee?: Assignee;

    /** Ceiling for the whole run, across every agent step in it. */
    budget?: Budget;
}

/**
 * Any step a factory can declare at the top level.
 */
export type Step = AgentStep | HumanStep | ParallelStep | ResultStep;

/**
 * A step that runs an agent on a harness.
 */
export interface AgentStep {
    type: "agent";

    /** Human-readable description of the work this step does. */
    description?: string;

    /**
     * The harness that runs this step, as `<name>[@<version>]`.
     *
     * Portability ends here: everything a runtime may vary lives behind the
     * harness name and {@link AgentStep.harness_config}.
     */
    harness: string;

    /** Harness-specific configuration. Opaque to SFML. */
    harness_config?: { [key: string]: unknown };

    /** An inline prompt template. Mutually exclusive with {@link AgentStep.prompt_path}. */
    prompt?: string;

    /** Path to a prompt template. Mutually exclusive with {@link AgentStep.prompt}. */
    prompt_path?: string;

    /**
     * The bindings this step's prompt template may read, as {@link PromptVars}.
     *
     * Declaring them per step makes the step's dependencies visible to the
     * linter and makes the step testable on its own. {@link FactoryState} is not
     * reachable from a prompt template.
     */
    prompt_vars?: { [name: string]: Expression };

    /** JSON Schema the agent's output is validated against before routing. */
    result_schema: JsonSchema;

    /** Where control goes on success. Ordered; first match wins. */
    next: Connection[];

    /**
     * How many times this step may be entered.
     *
     * Checked on arrival and counted from `results.<StepName>`, so it survives
     * resume for free. A retry is not an iteration.
     *
     * @TJS-type integer
     * @minimum 1
     */
    max_iterations?: number;

    /** Ceiling for this step, covering all of its iterations. */
    budget?: Budget;

    /** How failures the harness marked retryable are retried. */
    retry?: Retry;
}

/**
 * A step that waits for a person.
 *
 * Human steps have no timeout, no escalation, and no failure mode: a step either
 * resumes with valid input or waits.
 */
export interface HumanStep {
    type: "human";

    /** Human-readable description of the decision or work being asked for. */
    description?: string;

    /**
     * Who does this task.
     *
     * A human step that omits it is unassigned; it does not inherit
     * {@link Factory.assignee}.
     */
    assignee?: Assignee;

    /** What to show the person, evaluated against {@link FactoryState}. */
    instructions?: Expression;

    /** JSON Schema the resume payload is validated against. */
    result_schema: JsonSchema;

    /** Where control goes once the step has a result. Ordered; first match wins. */
    next: Connection[];

    /**
     * How many times this step may be entered.
     *
     * @TJS-type integer
     * @minimum 1
     */
    max_iterations?: number;
}

/**
 * A region that runs named child steps concurrently and joins when every one of
 * them has produced a result.
 *
 * The join is `all`, implicitly, and the join is the parallel step itself. A
 * child cannot route, so a region contains no edges and deadlock is
 * unrepresentable. Regions do not nest in v0.1.
 */
export interface ParallelStep {
    type: "parallel";

    /** Human-readable description of what runs concurrently here. */
    description?: string;

    /**
     * The region's children, keyed by a name unique within this step.
     *
     * A child is addressed elsewhere by its qualified name, `<parallel>.<child>`.
     */
    steps: { [name: string]: ParallelChild };

    /** Where control goes once every child has produced a result. */
    next: Connection[];

    /**
     * How many times this region may be entered.
     *
     * Iterations belong to the region, not to its children: a child runs exactly
     * once per crossing.
     *
     * @TJS-type integer
     * @minimum 1
     */
    max_iterations?: number;
}

/**
 * A child of a {@link ParallelStep}: a single agent or human step with no `next`.
 *
 * A child carries its own {@link AgentStep.budget}, because a lint pass and a
 * full test run have no business sharing a number, and a parallel step has no
 * budget of its own.
 */
export type ParallelChild = Omit<AgentStep, "next" | "max_iterations"> | Omit<HumanStep, "next" | "max_iterations">;

/**
 * A terminal step. A run that reaches one cannot be restarted.
 */
export interface ResultStep {
    type: "result";

    /** Human-readable description of what this outcome means. */
    description?: string;

    /** Whether the run ended having done the work, or having given up. */
    outcome: "complete" | "terminal_failure";

    /**
     * The run's result, evaluated against {@link FactoryState}.
     *
     * When omitted, `complete` yields `{ "ok": true }` and `terminal_failure`
     * yields `{ "ok": false }`.
     */
    value?: Expression;
}

/**
 * One edge out of a step. Every edge in an SFML graph is a success edge; there is
 * no `on_error` and no `on_timeout`.
 */
export interface Connection {
    /**
     * The condition under which this edge is taken, evaluated against
     * {@link FactoryState}.
     *
     * Absent means unconditional. There is no `else` key: the fallback is a
     * connection with no `when`, and routing must be total, so the last
     * connection of any non-result step omits it.
     */
    when?: Expression;

    /**
     * The single step control moves to.
     *
     * Fan-out is a {@link ParallelStep}, never a connection.
     */
    to: StepName;
}

/**
 * How a step retries failures the harness reported as retryable.
 *
 * There is no `retry.on`: the harness classifies each failure, so there is
 * nothing left for an author to list.
 */
export interface Retry {
    /**
     * Total attempts, including the first.
     *
     * @TJS-type integer
     * @minimum 1
     */
    max_attempts: number;

    /** How to wait between attempts. */
    backoff?: "none" | "linear" | "exponential";
}

/**
 * What routing conditions, human `instructions`, and result `value`s are
 * evaluated against.
 */
export interface FactoryState {
    /**
     * The run's parameters, validated against {@link Factory.parameters} and
     * defaulted. Constant for the life of the run.
     */
    parameters: { [name: string]: unknown };

    /**
     * Results by step name, oldest to newest. Read the latest with `last()`.
     */
    results: { [name: string]: StepResult[] };
}

/**
 * The observable contract of a step, and the thing conformance tests compare.
 *
 * A `StepResult` *is* the validated result object itself. One is created by a
 * step on success only; a failed attempt appends nothing. Nothing about *how* a
 * step ran — attempt counts, timings, cost — is part of it.
 */
export type StepResult = { [key: string]: unknown };

/**
 * What an agent step's prompt template is evaluated against.
 *
 * A template writes `${ prompt_vars.issue }`, not `${ issue }`. The extra word
 * buys a namespace, so a later version can add a sibling field here without
 * every existing template becoming ambiguous.
 */
export interface PromptVars {
    /** The evaluated {@link AgentStep.prompt_vars} of the step being run. */
    prompt_vars: { [name: string]: unknown };
}

/**
 * The classes of exception a step can raise.
 *
 * A step failure is a factory exception, not a route. All four are resumable;
 * nothing in v0.1 is inherently fatal except reaching a {@link ResultStep}.
 */
export type FactoryException = "schema_violation" | "harness_error" | "iteration_limit" | "budget_exceeded";

/**
 * The state of one live branch of a run.
 *
 * A run has one branch, except while inside a {@link ParallelStep}, where it has
 * one per child. Run status is derived from branch states rather than stored.
 */
export type BranchStatus = "running" | "awaiting_input" | "errored" | "done";
