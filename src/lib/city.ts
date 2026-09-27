// City lens definitions shared by the server and the browser. Pure data and functions only.

// Buildings per action type as listed in PROJECT.md 10.1. `other` has no building.
export const CITY_ACTIONS = [
  { key: "native_transfer", label: "Native transfer" },
  { key: "erc20_transfer", label: "ERC-20 transfer" },
  { key: "swap", label: "Swap" },
  { key: "bridge", label: "Bridge" },
  { key: "launch", label: "Token launch" },
  { key: "approve", label: "Approve" },
  { key: "contract_call", label: "Contract call" },
] as const;
export type CityActionKey = (typeof CITY_ACTIONS)[number]["key"];
export const isCityAction = (v: string): v is CityActionKey => CITY_ACTIONS.some((a) => a.key === v);
export const actionLabel = (key: string) => CITY_ACTIONS.find((a) => a.key === key)?.label ?? key;

export const MAX_TOKEN_BUILDINGS = 6;

// The subset of PROJECT.md 8.2 variables that applies to a single building.
export const CITY_METRICS = [
  { key: "tx_count", label: "Transactions" },
  { key: "gas_volume", label: "Gas volume" },
  { key: "avg_fee_usd", label: "Avg fee" },
  { key: "wallets", label: "Wallets" },
  { key: "fail_rate", label: "Fail rate" },
] as const;
export type CityMetric = (typeof CITY_METRICS)[number]["key"];
export const isCityMetric = (v: string): v is CityMetric => CITY_METRICS.some((m) => m.key === v);

// Ranges from PROJECT.md 10.2. Up to 24h the city reads raw txs; longer windows read agg_day.
export const CITY_WINDOWS = [
  { key: "1h", label: "Last 1 h", seconds: 3_600 },
  { key: "24h", label: "Last 24 h", seconds: 86_400 },
  { key: "7d", label: "Last 7 days", seconds: 7 * 86_400 },
  { key: "30d", label: "Last 30 days", seconds: 30 * 86_400 },
  { key: "all", label: "All to date", seconds: null },
] as const;
export type CityWindow = (typeof CITY_WINDOWS)[number]["key"];
export const isCityWindow = (v: string): v is CityWindow => CITY_WINDOWS.some((w) => w.key === v);
export const RAW_WINDOW_MAX_SECONDS = 86_400;

export type CityBuilding = {
  kind: "action" | "token";
  key: string;
  label: string;
  tx_count: number;
  gas_volume: number;
  avg_fee_usd: number | null;
  // null when the window is longer than 24h (distinct counts do not add up across days, KL-17).
  wallets: number | null;
  // null for tokens: failed transactions emit no Transfer log, so a token's fail rate is always 0 by construction.
  fail_rate: number | null;
};

export function metricValue(b: CityBuilding, metric: CityMetric): number | null {
  if (metric === "tx_count") return b.tx_count;
  if (metric === "gas_volume") return b.gas_volume;
  if (metric === "avg_fee_usd") return b.avg_fee_usd;
  if (metric === "wallets") return b.wallets;
  return b.fail_rate;
}

// Grid slots from the prototype: actions on the first two rows, the Pons district on the two rows behind them.
const SLOTS: readonly [number, number][] = [
  [0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1],
  [0, 2], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3],
];
export const BLOCK_SPACING = 5;
export const BUILDING_FOOTPRINT = 3;
export const MIN_HEIGHT = 0.35;
export const MAX_HEIGHT = 9;

export function slotPosition(index: number): { x: number; z: number } {
  const slot = SLOTS[index] ?? [index % 4, Math.floor(index / 4)];
  return { x: (slot[0] - 1.5) * BLOCK_SPACING, z: (slot[1] - 1.5) * BLOCK_SPACING };
}

// Heights on one shared scale so buildings compare; a building without a value sits at the minimum.
export function buildingHeights(buildings: readonly CityBuilding[], metric: CityMetric): number[] {
  const values = buildings.map((b) => metricValue(b, metric));
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  return values.map((v) => (v === null || max === 0 ? MIN_HEIGHT : Math.max(MIN_HEIGHT, (v / max) * MAX_HEIGHT)));
}

// Cost scale teal -> amber -> red (StyleGuide.md 2.3, prototype costColor). t in [0, 1].
const C0 = [47, 212, 180];
const C1 = [240, 180, 41];
const C2 = [239, 75, 75];
export function costColor(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const [a, b, f] = v < 0.5 ? [C0, C1, v / 0.5] : [C1, C2, (v - 0.5) / 0.5];
  return [0, 1, 2].map((i) => ((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * f) / 255) as [number, number, number];
}
export const cssColor = (rgb: readonly [number, number, number]) => `rgb(${rgb.map((c) => Math.round(c * 255)).join(",")})`;
// Buildings without a fee value are drawn in the neutral line color rather than a guessed cost.
export const NO_FEE_RGB: [number, number, number] = [0x3a / 255, 0x41 / 255, 0x52 / 255];

// Fee color relative to the most expensive building in view, as in the prototype legend.
export function feeScale(buildings: readonly CityBuilding[]): { min: number | null; max: number | null; colors: [number, number, number][] } {
  const fees = buildings.map((b) => b.avg_fee_usd).filter((f): f is number => f !== null);
  const max = fees.length ? Math.max(...fees) : null;
  const min = fees.length ? Math.min(...fees) : null;
  const colors = buildings.map((b) => (b.avg_fee_usd === null || !max ? NO_FEE_RGB : costColor(b.avg_fee_usd / max)));
  return { min, max, colors };
}

export function formatMetric(value: number | null, metric: CityMetric): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (metric === "avg_fee_usd") return value === 0 ? "$0" : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toPrecision(3)}`;
  if (metric === "fail_rate") return `${(value * 100).toFixed(1)}%`;
  if (metric === "gas_volume") return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return Math.round(value).toLocaleString("en-US");
}
