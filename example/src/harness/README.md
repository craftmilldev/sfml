# Harness wrappers (draft)

Each harness the example Runner supports gets a wrapper that turns it into the one interface in
[`types.ts`](types.ts). The Runner has a single code path for budgets, retries, and resumes; the
wrappers absorb the differences between harnesses.

| File                   | Harness                  | How it gets a value                          | How it reports cost                                  |
| ---------------------- | ------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `claude-agent-sdk.ts`  | Claude Agent SDK         | native `outputFormat`; fenced block fallback | tokens per API call, priced from `claude-pricing.json`, plus a top-up from `modelUsage` |
| `mock.ts`              | conformance mock (`mock-backend.ts`) | the transcript already holds the value | tokens per `usage` row, priced from `conformance/models.json` |

Every wrapper prices token counts against a price table in one shared format. None uses a
harness's own cost estimate.

Shared pieces: `pricing.ts` (token pricing), `money.ts` (exact USD in 1e-8 units), `extract.ts`
(fenced-JSON extraction for harnesses without native structured output).

The two wrappers sit at the same level, and neither holds state across invocations:

```
            Runner                  orchestrates many agents: parallel, join, budgets, resumes
              │
ClaudeAgentSdkHarness   MockHarness            wrappers: one invocation at a time, no shared state
   │                      │
query() → Anthropic API   MockBackend          backends: shared by every session in a run
```

`MockBackend` is the mock's stand-in for the API server. It is one per run, it plays the
transcript, and its single cursor orders replies across every agent. Any number of `MockHarness`
instances can front it.

The mock stands in for an SDK and its wrapper together. So a conformance case tests what the Runner
does with these events, not how any one wrapper parses its SDK's output.
