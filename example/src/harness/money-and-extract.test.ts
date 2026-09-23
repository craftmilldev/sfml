import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsd, parseUsd, usdFromFloat } from "./money.js";
import { extractFencedJson } from "./extract.js";

test("USD amounts are exact integers of 1e-8", () => {
  assert.equal(parseUsd("0.30"), 30_000_000n);
  assert.equal(parseUsd("0.10") + parseUsd("0.10") + parseUsd("0.10"), parseUsd("0.30"));
  assert.equal(formatUsd(1_200_000n), "0.01200000");
  assert.equal(usdFromFloat(0.1), 10_000_000n);
  assert.throws(() => parseUsd("1.123456789"));
});

test("extracts the last fenced JSON block, or reports why it cannot", () => {
  assert.deepEqual(extractFencedJson('first\n```json\n{"a": 1}\n```\nthen\n```json\n{"a": 2}\n```'), { ok: true, value: { a: 2 } });
  assert.deepEqual(extractFencedJson('{"bare": true}'), { ok: true, value: { bare: true } });
  assert.equal(extractFencedJson("no json here").ok, false);
  assert.equal(extractFencedJson("```json\nnot json\n```").ok, false);
});
