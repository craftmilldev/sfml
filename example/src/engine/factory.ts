// The clause-6 data model, as parsed from a factory document. Field names mirror the file exactly
// so a linter or runner can read a parsed factory without a translation layer.

export type JsonSchema = Record<string, unknown>;
export type Expression = string;

export interface Connection {
  when?: Expression;
  to: string;
}

export interface AgentStep {
  type: "agent";
  description?: string;
  next: Connection[];
  max_iterations?: number;
  result_schema: JsonSchema;
  harness: string;
  harness_config?: Record<string, unknown>;
  prompt_path?: string;
  prompt?: string;
  prompt_vars?: Record<string, Expression>;
  budget?: number;
  retry?: number;
}

export interface HumanStep {
  type: "human";
  description?: string;
  next: Connection[];
  max_iterations?: number;
  result_schema: JsonSchema;
  assignee?: string;
  instructions?: Expression;
}

/** A parallel step's child: an agent or human step with no `next` (§6.7). */
export type ParallelChild = Omit<AgentStep, "next"> | Omit<HumanStep, "next">;

export interface ParallelStep {
  type: "parallel";
  description?: string;
  next: Connection[];
  max_iterations?: number;
  steps: Record<string, ParallelChild>;
}

export interface ResultStep {
  type: "result";
  description?: string;
  outcome: "complete" | "terminal_failure";
  value?: Expression;
}

export type Step = AgentStep | HumanStep | ParallelStep | ResultStep;

export interface Factory {
  sfml: string;
  description?: string;
  parameters?: Record<string, JsonSchema>;
  start: string;
  steps: Record<string, Step>;
  assignee?: string;
  budget?: number;
}

export function isAgentOrHuman(step: Step): step is AgentStep | HumanStep {
  return step.type === "agent" || step.type === "human";
}

/** Yields [name, step] for every top-level step, and [qualified name, child] for every parallel child. */
export function* walkSteps(factory: Factory): Generator<[string, AgentStep | HumanStep | ParallelStep | ResultStep]> {
  for (const [name, step] of Object.entries(factory.steps)) {
    yield [name, step];
    if (step.type === "parallel") {
      for (const [child, childStep] of Object.entries(step.steps)) {
        yield [`${name}.${child}`, childStep as AgentStep | HumanStep];
      }
    }
  }
}
