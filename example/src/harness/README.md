# Harness wrappers (draft)

Each harness the example Runner supports gets a wrapper that turns it into the one interface in
[`types.ts`](types.ts). The Runner has a single code path for budgets, retries, and resumes; the
wrappers absorb the differences between harnesses.

| File                   | Harness                  | How it gets a value                          | How it reports cost                                  |
| ---------------------- | ------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `claude-agent-sdk.ts`  | Claude Agent SDK         | native `outputFormat`; fenced block fallback | once per turn, from the session's cumulative total   |
| `mock.ts`              | conformance mock         | the transcript already holds the value       | per `usage` row, priced from `conformance/models.json` |

Shared pieces: `money.ts` (exact USD in 1e-8 units), `extract.ts` (fenced-JSON extraction for
harnesses without native structured output).

The mock stands in for an SDK and its wrapper together. So a conformance case tests what the Runner
does with these events, not how any one wrapper parses its SDK's output.
