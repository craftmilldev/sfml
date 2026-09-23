// Lib mode of the worked example (issue #13): wraps a factory and a mock-harness transcript (Annex
// B) so a caller — a web page showing a factory run — can start it, resume it, and read back a
// timeline of what happened, without touching the Engine or the mock harness directly.
//
// This is the same conformance mock every runner/ conformance case plays back (mock-harness.md), so
// a transcript authored for a conformance fixture, or one written by hand to narrate a demo, works
// here unmodified. Nothing here is normative; it is a convenience layer over `Engine` + `MockHarness`
// for one particular consumer (a browser UI), per Annex C's "informative" note.

import { parseFactory } from "../engine/parser.js";
import { lintFactory, type Diagnostic } from "../engine/linter.js";
import { Engine, type Observation, type RunnerEvent } from "../engine/runner.js";
import { MockBackend, type Row } from "../harness/mock-backend.js";
import { MockHarness } from "../harness/mock.js";
import type { PriceTable } from "../harness/pricing.js";
import type { Harness } from "../harness/types.js";

export type StepperInput = {
  /** A factory document, as bytes (from a file, a fetch, or a <textarea>). */
  factory: Uint8Array | Buffer;
  format?: "yaml" | "json";
  /** The mock transcript rows (conformance/mock-harness.md §3), already parsed. */
  transcript?: Row[];
  /** The mock's price table (conformance/models.json shape). */
  prices: PriceTable;
};

export type StepperError = { ok: false; stage: "parse" | "lint"; message?: string; diagnostics?: Diagnostic[] };
export type StepperReady = { ok: true; stepper: Stepper };

/** Loads a factory + transcript and prepares a `Stepper`, or reports why it can't be run. */
export function loadStepper(input: StepperInput): StepperError | StepperReady {
  const bytes = input.factory instanceof Uint8Array ? Buffer.from(input.factory) : input.factory;
  const parsed = parseFactory(bytes, input.format ?? "yaml");
  if (!parsed.ok) return { ok: false, stage: "parse", message: parsed.message };
  const diagnostics = lintFactory(parsed.factory);
  if (diagnostics.length) return { ok: false, stage: "lint", diagnostics };
  return { ok: true, stepper: new Stepper(parsed.factory, input.transcript ?? [], input.prices) };
}

/** One entry of a Stepper's timeline: an observation plus the RunnerEvents that produced it. */
export type StepperFrame = { events: RunnerEvent[]; observation: Observation };

/**
 * Steps a mock-backed run forward one caller action at a time (start/resume/restart, conformance
 * README §3.1), recording a timeline a UI can render or scrub through. Each action's frame holds
 * every `RunnerEvent` the Runner emitted while settling to its next quiescent point (README's "waits
 * until no branch of the run is running"), so a caller can animate a `parallel` step's children
 * without re-deriving them from `Observation` diffs.
 */
export class Stepper {
  private engine: Engine;
  private backend: MockBackend;
  readonly timeline: StepperFrame[] = [];

  constructor(
    readonly factory: import("../engine/factory.js").Factory,
    private readonly transcript: Row[],
    private readonly prices: PriceTable,
  ) {
    this.backend = new MockBackend(transcript);
    this.engine = new Engine(factory, this.harnesses(), undefined, (e) => this.pendingEvents.push(e));
  }

  private pendingEvents: RunnerEvent[] = [];

  private harnesses(): Map<string, Harness> {
    return new Map<string, Harness>([["mock", new MockHarness(this.backend, this.prices)]]);
  }

  private record(observation: Observation): StepperFrame {
    const frame: StepperFrame = { events: this.pendingEvents, observation };
    this.pendingEvents = [];
    this.timeline.push(frame);
    return frame;
  }

  async start(parameters: Record<string, unknown> = {}): Promise<{ admitted: boolean; message?: string; frame?: StepperFrame }> {
    const admission = await Engine.start(this.factory, this.harnesses(), parameters, (e) => this.pendingEvents.push(e));
    if (!admission.result.admitted) return { admitted: false, message: admission.result.message };
    this.engine = admission.engine!;
    return { admitted: true, frame: this.record(admission.result.observation) };
  }

  async resume(step: string, hasPayload: boolean, payload?: unknown): Promise<{ accepted: boolean; frame: StepperFrame }> {
    const result = await this.engine.resume(step, hasPayload, payload);
    return { accepted: result.accepted, frame: this.record(result.observation) };
  }

  /** Simulates a Runner restart (conformance README `restart`): the mock keeps its transcript cursor. */
  restart(): StepperFrame {
    this.backend = new MockBackend(this.transcript, undefined, this.backend.exportState());
    this.engine = this.engine.restart(this.harnesses());
    return this.record(this.engine.observe());
  }

  observe(): Observation {
    return this.engine.observe();
  }
}
