// Exact USD arithmetic. Every amount is an integer count of 1e-8 USD ("nano-units"), so budgets
// (two decimal places, SPEC §9.7), mock prices (models.json), and harness reports (finer precision)
// all add and compare exactly. Binary floating point never touches a budget comparison.

export type Usd = bigint;

const SCALE = 8;
const UNIT = 10n ** BigInt(SCALE);

/** Parses a non-negative decimal string such as "0.30" or "1.00500000". */
export function parseUsd(text: string): Usd {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error(`not a USD amount with at most ${SCALE} decimal places: ${text}`);
  const [, whole, frac = ""] = match;
  return BigInt(whole!) * UNIT + BigInt(frac.padEnd(SCALE, "0"));
}

/** Converts a harness-reported float (e.g. the Claude Agent SDK's total_cost_usd). */
export function usdFromFloat(value: number): Usd {
  if (!Number.isFinite(value) || value < 0) throw new Error(`not a USD amount: ${value}`);
  return BigInt(Math.round(value * 1e8));
}

/** Formats with exactly 8 fractional digits, e.g. 10000000n → "0.10000000". */
export function formatUsd(amount: Usd): string {
  const s = amount.toString().padStart(SCALE + 1, "0");
  return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}

export function usdToNumber(amount: Usd): number {
  return Number(amount) / 1e8;
}
