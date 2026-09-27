// Display formatting shared by UI components. Pure functions, safe in the browser.

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const fullUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactInt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

// Large dollar amounts for the Ticker: $1.03B, $91.27K. Below $1,000 the full figure is shown.
export function formatUsdCompact(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  return Math.abs(usd) < 1_000 ? fullUsd.format(usd) : compactUsd.format(usd);
}

// Counts such as total transactions: 1.2B, 845.3K.
export function formatCountCompact(n: number): string {
  return Number.isFinite(n) ? compactInt.format(n) : "—";
}

// Gwei with four decimals: gas on this chain is a few hundredths of a gwei.
export function formatGwei(gwei: number): string {
  return Number.isFinite(gwei) ? gwei.toFixed(4) : "—";
}

// "2026-09-26" -> "Sep 26", for labelling the day a daily figure covers.
export function formatDay(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDay : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
