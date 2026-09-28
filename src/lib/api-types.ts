// Response contracts shared by route handlers and client components. Type-only; safe to import in the browser.

import type { ChainEconomics, ChainStats } from "../server/external.ts";
import type { CityBuilding, CityWindow } from "./city.ts";
import type { CellState, TerrainBucket } from "./lenses.ts";
import type { Filters, HeatmapMode, Metric, TerrainRows } from "./view-state.ts";

export type CityWindowInfo = {
  key: CityWindow;
  // First and last instant the figures cover. start is null when nothing has been ingested.
  start: string | null;
  end: string | null;
  // "txs": raw transactions (windows up to 24h). "agg_day": whole UTC days from the daily aggregates.
  basis: "txs" | "agg_day";
};

// First and newest ingested block: the time scrubber's track (PROJECT.md 11.3).
export type Coverage = { first: string | null; last: string | null };

// GET /api/lens/city/data (PROJECT.md 18).
export type CityResponse = {
  window: CityWindowInfo;
  buildings: CityBuilding[];
  // Transactions classified `other`, which have no building (PROJECT.md 10.1).
  other_tx_count: number;
  n: number;
  coverage: Coverage;
  // Filters applied to every figure (PROJECT.md 11.2).
  filters: Filters;
  // SUBSIDY_END_DATE (PROJECT.md 23) as an ISO instant, for the scrubber marker.
  subsidy_end: string;
  generated_at: string;
};

export type InspectorSample = { hash: string; block: number; ts: string; fee_usd: number; status: "success" | "failed"; explorer_url: string };

// GET /api/lens/terrain/data (PROJECT.md 10.2, 18). values[i] belongs to buckets[i]; null means no ingested data
// in that bucket, or no value (an average fee with no transactions).
export type TerrainResponse = {
  window: CityWindowInfo;
  metric: Metric;
  rows_kind: TerrainRows;
  bucket: TerrainBucket;
  buckets: string[];
  covered: boolean[];
  rows: { kind: "action" | "token"; key: string; label: string; values: (number | null)[] }[];
  max: number | null;
  n: number;
  coverage: Coverage;
  filters: Filters;
  subsidy_end: string;
  generated_at: string;
};

export type HeatmapHours = { values: (number | null)[]; n: number[]; days: number };

// GET /api/lens/heatmap/data (PROJECT.md 10.5, 18). cells[d][h] is UTC day days[d], hour h.
export type HeatmapResponse = {
  window: CityWindowInfo;
  metric: Metric;
  mode: HeatmapMode;
  days: string[];
  cells: { v: number | null; n: number; s: CellState }[][];
  // Hourly averages before and from the subsidy end, over the days of the window (mode "compare").
  compare: { before: HeatmapHours; after: HeatmapHours & { full_days: number } } | null;
  max: number | null;
  n: number;
  coverage: Coverage;
  filters: Filters;
  subsidy_end: string;
  generated_at: string;
};

// GET /api/inspector (PROJECT.md 11.1, 18).
export type InspectorResponse = {
  kind: "action" | "token" | "hour";
  key: string;
  label: string;
  window: CityWindowInfo;
  filters: Filters;
  // paid_share: share of likely_paid transactions, an estimate (PROJECT.md 12.2, KL-6); prototype line 598.
  values: Omit<CityBuilding, "kind" | "key" | "label"> & { paid_share: number | null };
  // Same-length window just before this one; null for "all".
  previous: { tx_count: number; change: number | null } | null;
  trend: { bucket: "5m" | "1h" | "1d"; points: { ts: string; n: number }[] };
  samples: InspectorSample[];
  token: { symbol: string | null; name: string | null; creator: string | null; creator_url: string | null; launch_block: number | null; launch_ts: string | null } | null;
  // Transactions per action, for an hour; null otherwise.
  breakdown: { key: string; label: string; tx_count: number }[] | null;
  generated_at: string;
};

export type Window = { start: string | null; end: string };

export type StatsResponse = {
  chain_id: number;
  head_block: number | null;
  live_block: number | null;
  lag_blocks: number | null;
  lag_alert_blocks: number;
  delayed: boolean;
  block_ts: string | null;
  // eth_gasPrice, refreshed every minute (PROJECT.md 8.1).
  gas_price_gwei: number | null;
  // Base fee of the newest ingested block.
  base_fee_gwei: number | null;
  tps_current: number | null;
  tps: { value: number | null; n: number; window: Window } | null;
  avg_fee_usd: number | null;
  median_fee_usd: number | null;
  fees: { avg_usd: number | null; median_usd: number | null; n: number; window: Window } | null;
  subsidized_ratio_24h: number | null;
  subsidized: { ratio: number | null; n: number; window: Window } | null;
  eth_usd: number | null;
  eth_usd_ts: string | null;
  // TVL, chain fees and revenue from DefiLlama, refreshed hourly (PROJECT.md 8.1).
  chain: ChainEconomics | null;
  // Blockscout /api/v2/stats, refreshed every 5 minutes (PROJECT.md 8.1); unavailable while KL-3 holds.
  chain_stats: ChainStats;
  generated_at: string;
};
