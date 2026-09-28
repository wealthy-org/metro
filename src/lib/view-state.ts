// View state shared by `/`, `/lens/[name]` and the lens APIs (PROJECT.md 11.2: filters live in the URL so a view can
// be shared). Pure functions only. Parsing never throws: an invalid or inapplicable value falls back to its default,
// and the same parser validates API input on the server.

import { CITY_METRICS, CITY_WINDOWS, isCityAction, isCityWindow, RAW_WINDOW_MAX_SECONDS, type CityActionKey, type CityWindow } from "./city.ts";

export const LENS_KEYS = ["city", "terrain", "heatmap"] as const;
export type LensKey = (typeof LENS_KEYS)[number];
export const isLensKey = (v: string): v is LensKey => (LENS_KEYS as readonly string[]).includes(v);

export const METRICS = [...CITY_METRICS, { key: "gas_price", label: "Gas price" }] as const;
export type Metric = (typeof METRICS)[number]["key"];
export const isMetric = (v: string): v is Metric => METRICS.some((m) => m.key === v);
export const metricLabel = (m: Metric) => METRICS.find((x) => x.key === m)?.label ?? m;

// Wallet classes of PROJECT.md 11.2, estimated from the transaction subsidy heuristic (PROJECT.md 8.1, 12.2; KL-20).
export const WALLET_CLASSES = [
  { key: "robinhood", label: "Robinhood Wallet (est.)", subsidy: "likely_subsidized" },
  { key: "other", label: "Other wallets (est.)", subsidy: "likely_paid" },
  { key: "unknown", label: "Unknown", subsidy: "unknown" },
] as const;
export type WalletClass = (typeof WALLET_CLASSES)[number]["key"];
export const STATUSES = ["success", "failed"] as const;
export type TxStatus = (typeof STATUSES)[number];

export type Filters = {
  action: CityActionKey | null;
  token: string | null;
  // Decimal ETH as typed; converted to wei exactly on the server.
  minValue: string | null;
  wallet: WalletClass | null;
  status: TxStatus | null;
};
export const NO_FILTERS: Filters = { action: null, token: null, minValue: null, wallet: null, status: null };

export type Selection = { kind: "action"; key: string } | { kind: "token"; key: string } | { kind: "hour"; key: string } | null;
export type CameraPreset = "angle" | "top" | "street";
export type TerrainRows = "actions" | "tokens";
export type HeatmapMode = "days" | "compare";

export type ViewState = {
  lens: LensKey;
  metric: Metric;
  window: CityWindow;
  filters: Filters;
  sel: Selection;
  // Scrubber time as an ISO minute; null means live.
  at: string | null;
  cam: CameraPreset;
  marks: string[];
  rows: TerrainRows;
  mode: HeatmapMode;
};

export const DEFAULT_VIEW: ViewState = {
  lens: "city",
  metric: "tx_count",
  window: "24h",
  filters: NO_FILTERS,
  sel: null,
  at: null,
  cam: "angle",
  marks: [],
  rows: "actions",
  mode: "days",
};

export const MAX_MARKS = 5;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ISO_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;
const ISO_HOUR = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00Z$/;
// Up to 1e9 ETH with at most 18 decimals, so the wei value is exact.
const ETH_AMOUNT = /^(\d{1,9})(\.\d{1,18})?$/;

const windowSeconds = (w: CityWindow) => CITY_WINDOWS.find((x) => x.key === w)?.seconds ?? null;
export const isShortWindow = (w: CityWindow) => {
  const s = windowSeconds(w);
  return s !== null && s <= RAW_WINDOW_MAX_SECONDS;
};

// Minutes are the finest time step anywhere in Metro; a string that is not a real UTC minute is rejected.
export function parseIsoMinute(v: string | null): string | null {
  if (!v) return null;
  const m = ISO_MINUTE.exec(v);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 16) === v.slice(0, 16) ? v : null;
}
export const toIsoMinute = (d: Date | number) => `${new Date(Math.floor(new Date(d).getTime() / 60_000) * 60_000).toISOString().slice(0, 16)}Z`;
export const isoMinuteDate = (v: string) => new Date(`${v.slice(0, 16)}:00Z`);

function parseHour(v: string): string | null {
  return ISO_HOUR.test(v) && parseIsoMinute(v) ? v : null;
}

export function parseEthAmount(v: string | null): string | null {
  if (!v) return null;
  const m = ETH_AMOUNT.exec(v.trim());
  return m ? v.trim() : null;
}

// Exact decimal ETH to wei, as a string for a numeric SQL parameter.
export function ethToWei(eth: string): string {
  const m = ETH_AMOUNT.exec(eth);
  if (!m) throw new Error(`invalid ETH amount ${eth}`);
  const frac = (m[2] ?? ".").slice(1).padEnd(18, "0");
  return (BigInt(m[1] ?? "0") * 10n ** 18n + BigInt(frac || "0")).toString();
}

// Why a metric cannot be shown by a lens at a window; null when it can.
export function metricIssue(lens: LensKey, metric: Metric, window: CityWindow): string | null {
  const short = isShortWindow(window);
  if (metric === "gas_price") return lens === "heatmap" ? null : "Gas price is chain-wide; it is shown in the Heatmap";
  if (lens === "heatmap" && (metric === "wallets" || metric === "fail_rate")) return "Not available per hour cell: the hourly rollups have no distinct wallets or failures";
  if (metric === "wallets" && !short) return "Wallets are counted for windows of 24 h or less";
  if (metric === "fail_rate" && lens === "terrain" && !short) return "Fail rate over time is available for windows of 24 h or less";
  return null;
}

// Token, value, wallet and status need raw rows (KL-20); the action filter works at every window.
export const rawFilterCount = (f: Filters) => [f.token, f.minValue, f.wallet, f.status].filter((x) => x !== null).length;
export const RAW_FILTER_REASON = "Token, value, wallet and status filters apply to windows of 24 h or less";

// Drops anything the current lens and window cannot show, so parse(serialize(s)) is stable.
export function normalize(s: ViewState): ViewState {
  const short = isShortWindow(s.window);
  const metric = metricIssue(s.lens, s.metric, s.window) ? "tx_count" : s.metric;
  const filters: Filters = short ? s.filters : { ...NO_FILTERS, action: s.filters.action };
  const rows: TerrainRows = short ? s.rows : "actions";
  return { ...s, metric, filters, rows };
}

export function parseViewState(params: URLSearchParams, lens?: LensKey): ViewState {
  const get = (k: string) => params.get(k);
  const lensParam = get("lens") ?? "";
  const metric = get("metric") ?? "";
  const window = get("window") ?? "";
  const action = get("action") ?? "";
  const token = (get("token") ?? "").toLowerCase();
  const wallet = get("wallet") ?? "";
  const status = get("status") ?? "";
  const cam = get("cam") ?? "";
  const rows = get("rows");
  const mode = get("mode");

  let sel: Selection = null;
  const selRaw = get("sel") ?? "";
  const sep = selRaw.indexOf(":");
  const [kind, key] = sep > 0 ? [selRaw.slice(0, sep), selRaw.slice(sep + 1).toLowerCase()] : ["", ""];
  if (kind === "action" && isCityAction(key)) sel = { kind, key };
  else if (kind === "token" && ADDRESS.test(key)) sel = { kind, key };
  else if (kind === "hour") {
    const h = parseHour(selRaw.slice(sep + 1));
    if (h) sel = { kind, key: h };
  }

  const marks = [...new Set((get("marks") ?? "").split(",").map((m) => parseIsoMinute(m)).filter((m): m is string => m !== null))].sort().slice(0, MAX_MARKS);

  return normalize({
    lens: lens ?? (isLensKey(lensParam) ? lensParam : DEFAULT_VIEW.lens),
    metric: isMetric(metric) ? metric : DEFAULT_VIEW.metric,
    window: isCityWindow(window) ? window : DEFAULT_VIEW.window,
    filters: {
      action: isCityAction(action) ? action : null,
      token: ADDRESS.test(token) ? token : null,
      minValue: parseEthAmount(get("min_value")),
      wallet: WALLET_CLASSES.some((w) => w.key === wallet) ? (wallet as WalletClass) : null,
      status: (STATUSES as readonly string[]).includes(status) ? (status as TxStatus) : null,
    },
    sel,
    at: parseIsoMinute(get("at")),
    cam: cam === "top" || cam === "street" ? cam : "angle",
    marks,
    rows: rows === "tokens" ? "tokens" : "actions",
    mode: mode === "compare" ? "compare" : "days",
  });
}

// Only non-default values are written, in a fixed order, so equal views have equal URLs.
// `includeLens` is false on `/lens/[name]`, where the path names the lens.
export function serializeViewState(s: ViewState, includeLens = true): URLSearchParams {
  const p = new URLSearchParams();
  const n = normalize(s);
  if (includeLens && n.lens !== DEFAULT_VIEW.lens) p.set("lens", n.lens);
  if (n.metric !== DEFAULT_VIEW.metric) p.set("metric", n.metric);
  if (n.window !== DEFAULT_VIEW.window) p.set("window", n.window);
  if (n.filters.action) p.set("action", n.filters.action);
  if (n.filters.token) p.set("token", n.filters.token);
  if (n.filters.minValue) p.set("min_value", n.filters.minValue);
  if (n.filters.wallet) p.set("wallet", n.filters.wallet);
  if (n.filters.status) p.set("status", n.filters.status);
  if (n.sel) p.set("sel", `${n.sel.kind}:${n.sel.key}`);
  if (n.at) p.set("at", n.at);
  if (n.cam !== DEFAULT_VIEW.cam) p.set("cam", n.cam);
  if (n.marks.length) p.set("marks", n.marks.join(","));
  if (n.rows !== DEFAULT_VIEW.rows) p.set("rows", n.rows);
  if (n.mode !== DEFAULT_VIEW.mode) p.set("mode", n.mode);
  return p;
}

// Query string for the lens and Inspector APIs: only what changes the numbers.
export function dataQuery(s: ViewState, extra: Record<string, string> = {}): string {
  const n = normalize(s);
  const p = new URLSearchParams({ window: n.window, ...extra });
  if (n.filters.action) p.set("action", n.filters.action);
  if (n.filters.token) p.set("token", n.filters.token);
  if (n.filters.minValue) p.set("min_value", n.filters.minValue);
  if (n.filters.wallet) p.set("wallet", n.filters.wallet);
  if (n.filters.status) p.set("status", n.filters.status);
  if (n.at) p.set("at", n.at);
  return p.toString();
}

export function filterSummary(f: Filters): string[] {
  const out: string[] = [];
  if (f.token) out.push(`token ${f.token.slice(0, 6)}…${f.token.slice(-4)}`);
  if (f.minValue) out.push(`value ≥ ${f.minValue} ETH`);
  if (f.wallet) out.push(WALLET_CLASSES.find((w) => w.key === f.wallet)?.label ?? f.wallet);
  if (f.status) out.push(f.status === "failed" ? "failed only" : "successful only");
  return out;
}
