// Response contracts shared by route handlers and client components. Type-only; safe to import in the browser.

import type { ChainEconomics, ChainStats } from "../server/external.ts";
import type { CityBuilding, CityWindow } from "./city.ts";

export type CityWindowInfo = {
  key: CityWindow;
  // First and last instant the figures cover. start is null when nothing has been ingested.
  start: string | null;
  end: string | null;
  // "txs": raw transactions (windows up to 24h). "agg_day": whole UTC days from the daily aggregates.
  basis: "txs" | "agg_day";
};

// GET /api/lens/city/data (PROJECT.md 18).
export type CityResponse = {
  window: CityWindowInfo;
  buildings: CityBuilding[];
  // Transactions classified `other`, which have no building (PROJECT.md 10.1).
  other_tx_count: number;
  n: number;
  generated_at: string;
};

export type InspectorSample = { hash: string; block: number; ts: string; fee_usd: number; status: "success" | "failed"; explorer_url: string };

// GET /api/inspector (PROJECT.md 11.1, 18).
export type InspectorResponse = {
  kind: "action" | "token";
  key: string;
  label: string;
  window: CityWindowInfo;
  values: Omit<CityBuilding, "kind" | "key" | "label">;
  // Same-length window just before this one; null for "all".
  previous: { tx_count: number; change: number | null } | null;
  trend: { bucket: "5m" | "1h" | "1d"; points: { ts: string; n: number }[] };
  samples: InspectorSample[];
  token: { symbol: string | null; name: string | null; creator: string | null; creator_url: string | null; launch_block: number | null; launch_ts: string | null } | null;
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
