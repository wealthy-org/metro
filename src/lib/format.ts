// Display formatting shared by UI components. Pure functions, safe in the browser.

// Shown wherever a value is unknown or does not apply. The prototype and landing use no em dash (antislop R-02).
export const NA = "n/a";

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const fullUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactInt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

// Large dollar amounts for the Ticker: $1.03B, $91.27K. Below $1,000 the full figure is shown.
export function formatUsdCompact(usd: number): string {
  if (!Number.isFinite(usd)) return NA;
  return Math.abs(usd) < 1_000 ? fullUsd.format(usd) : compactUsd.format(usd);
}

// Counts such as total transactions: 1.2B, 845.3K.
export function formatCountCompact(n: number): string {
  return Number.isFinite(n) ? compactInt.format(n) : NA;
}

// Gwei with four decimals: gas on this chain is a few hundredths of a gwei.
export function formatGwei(gwei: number): string {
  return Number.isFinite(gwei) ? gwei.toFixed(4) : NA;
}

// Time from an ISO instant to `toMs`: "12 min", "5 h", "3 d". One format for the Inspector, Launchpad, profiles and
// landing (gate F37).
export function formatAge(fromIso: string, toMs: number): string {
  const s = Math.max(0, (toMs - Date.parse(fromIso)) / 1000);
  if (!Number.isFinite(s)) return NA;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

// "0xc40b…5486": an address or hash cut to its head and tail.
export const shortHex = (h: string, head = 6, tail = 4) => (h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);

// "2026-09-27 15:51 UTC" from an ISO instant.
export const utcMinute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

// "2026-09-26" -> "Sep 26", for labelling the day a daily figure covers.
export function formatDay(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDay : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
