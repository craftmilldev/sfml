// Wrapper for the conformance mock: `harness: mock`.
//
// DRAFT. The mock-side counterpart of claude-agent-sdk.ts, at the same level: one invocation at a
// time, with no state of its own. Everything shared across agents (the transcript, its cursor, the
// sessions) lives in MockBackend, the way Anthropic's servers sit behind the Claude wrapper. Any
// number of MockHarness instances can front one backend.
//
// A transcript reply carries the value a real wrapper would already have extracted, so there is no
// output parsing here. What is left mirrors the Claude wrapper:
// - validate harness_config (`{ agent: <name> }`);
// - price reported tokens against a price table (conformance/models.json); an unpriced model is a
//   non-retryable failure, never a silent zero;
// - carry the session id in the SessionHandle.

import type { Harness, HarnessEvent, Invocation } from "./types.js";
import type { MockBackend } from "./mock-backend.js";
import { priceTokens, type PriceTable } from "./pricing.js";

export class MockHarness implements Harness {
  constructor(
    private readonly backend: MockBackend,
    private readonly prices: PriceTable,
  ) {}

  async *invoke(inv: Invocation): AsyncGenerator<HarnessEvent> {
    const agent = inv.harnessConfig.agent;
    if (typeof agent !== "string" || Object.keys(inv.harnessConfig).length !== 1) {
      yield { type: "failure", retryable: false, message: "invalid harness_config: must be exactly { agent: <name> }" };
      return;
    }
    let session: string | undefined;
    if (inv.session) {
      const id = inv.session.session;
      if (typeof id !== "string") {
        yield { type: "failure", retryable: false, message: "session handle was not created by the mock wrapper" };
        return;
      }
      session = id;
    }

    const replies = this.backend.send({
      step: inv.step,
      agent,
      prompt: inv.prompt,
      signal: inv.signal,
      ...(session !== undefined && { session }),
    });
    for await (const reply of replies) {
      switch (reply.type) {
        case "session":
          yield { type: "session", handle: { session: reply.session } };
          break;
        case "usage": {
          const cost = priceTokens(this.prices, reply.model, reply.tokens);
          if (cost === undefined) {
            yield { type: "failure", retryable: false, message: `no price for model '${reply.model}' in the price table` };
            return;
          }
          yield { type: "usage", cost };
          break;
        }
        case "result":
          yield { type: "output", value: reply.value };
          return;
        case "no_value":
          yield { type: "no_value", reason: reply.reason };
          return;
        case "error":
          yield {
            type: "failure",
            retryable: reply.retryable,
            message: reply.message,
            ...(reply.backoffMs !== undefined && { backoffMs: reply.backoffMs }),
          };
          return;
        case "fault":
          yield { type: "failure", retryable: false, message: `mock fault: ${reply.message}` };
          return;
      }
    }
  }
}
