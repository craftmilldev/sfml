# Harness wrappers (draft)

Each harness the example Runner supports gets a wrapper that turns it into the one interface in
[`types.ts`](types.ts). The Runner has a single code path for budgets, retries, and resumes; the
wrappers absorb the differences between harnesses.

| File                   | Harness                  | How it gets a value                          | How it reports cost                                  |
| ---------------------- | ------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `claude-agent-sdk.ts`  | Claude Agent SDK         | native `outputFormat`; fenced block fallback | tokens per API call, priced from `claude-pricing.json`, plus a top-up from `modelUsage` |
| `mock.ts`              | conformance mock         | the transcript already holds the value       | tokens per `usage` row, priced from `conformance/models.json` |

Every wrapper prices token counts against a price table in one shared format. None uses a
harness's own cost estimate.

Shared pieces: `pricing.ts` (token pricing), `money.ts` (exact USD in 1e-8 units), `extract.ts`
(fenced-JSON extraction for harnesses without native structured output).

One `MockHarness` instance serves a whole run: every step and every concurrent `parallel` child
invokes the same instance, so a single cursor orders the transcript across all agents.

The mock stands in for an SDK and its wrapper together. So a conformance case tests what the Runner
does with these events, not how any one wrapper parses its SDK's output.
