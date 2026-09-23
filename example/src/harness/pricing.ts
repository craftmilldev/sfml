// Token-based pricing shared by every wrapper. A price table has the shape of
// conformance/models.json: USD per million tokens for four token classes, as decimal strings with
// at most two decimal places. So the cost of any whole number of tokens is an exact integer of
// 1e-8 USD (see money.ts).

import { readFileSync } from "node:fs";
import type { Usd } from "./money.js";

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ModelPrice = { input: string; output: string; cache_read: string; cache_write: string };
export type PriceTable = Record<string, ModelPrice>;

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function loadPriceTable(path: string): PriceTable {
  return (JSON.parse(readFileSync(path, "utf8")) as { models: PriceTable }).models;
}

/** Exact cost of `tokens` on `model`, or undefined when the table has no price for it. */
export function priceTokens(table: PriceTable, model: string, tokens: Tokens): Usd | undefined {
  const price = table[model];
  if (!price) return undefined;
  const cents = (p: string) => BigInt(p.replace(".", ""));
  return (
    BigInt(tokens.input) * cents(price.input) +
    BigInt(tokens.output) * cents(price.output) +
    BigInt(tokens.cacheRead) * cents(price.cache_read) +
    BigInt(tokens.cacheWrite) * cents(price.cache_write)
  );
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** Per class, how far `a` exceeds `b` (never negative). */
export function tokensBeyond(a: Tokens, b: Tokens): Tokens {
  const over = (x: number, y: number) => Math.max(0, x - y);
  return { input: over(a.input, b.input), output: over(a.output, b.output), cacheRead: over(a.cacheRead, b.cacheRead), cacheWrite: over(a.cacheWrite, b.cacheWrite) };
}

export function isZero(t: Tokens): boolean {
  return t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0;
}
