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
  // How the Pons district is chosen (KL-19, Phase 6 D2): 24 h USD volume from GeckoTerminal in live views, transaction
  // count when scrubbed or when GeckoTerminal cannot be reached. volumes: USD per district token, null when unknown.
  district: { ranked_by: "volume_24h_usd" | "tx_count"; source: string | null; volumes: Record<string, number | null> | null };
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

// Holders from token_transfers (Phase 6 D1). complete: every block from launch to the anchor is ingested.
// top10_share leaves out the token's Pons curve pool and the factory (`excluded`), whose part is pool_share (KL-25).
export type HolderStatsT = {
  holders: number;
  holders_24h_ago: number;
  top10_share: number | null;
  pool_share: number | null;
  excluded: string[];
  complete: boolean;
  blocks_ingested: number | null;
  blocks_expected: number | null;
  basis: "token_transfers";
};
export type PoolMarketT = { address: string; name: string; dex: string | null; volume_24h_usd: number | null; reserve_usd: number | null };
// GeckoTerminal figures are "now", whatever the window or scrubber time (Phase 6 D2).
export type TokenMarketT = { price_usd: number | null; volume_24h_usd: number | null; pools: PoolMarketT[] };

// source "rpc": a launch read from the factory logs that is not ingested yet (KL-24); its activity and holders are
// unknown (null), not zero. market_checked: false when GeckoTerminal was not asked (one call of 30 per view).
export type LaunchpadToken = {
  address: string;
  source: "ingested" | "rpc";
  symbol: string | null;
  name: string | null;
  launch_block: number;
  launch_ts: string;
  creator: string;
  tx_count: number | null;
  swaps: number | null;
  avg_fee_usd: number | null;
  daily: { date: string; n: number }[];
  holders: HolderStatsT | null;
  market: TokenMarketT | null;
  market_checked: boolean;
  concentrated: boolean;
};

// GET /api/lens/launchpad/data (PROJECT.md 10.6, 18). recent: the RPC read of the newest launches (live views only).
export type LaunchpadResponse = {
  window: CityWindowInfo;
  tokens: LaunchpadToken[];
  recent: { source: "rpc"; available: boolean } | null;
  market: { source: "GeckoTerminal"; available: boolean };
  highlights: { fastest: string | null; concentrated: string[] };
  n: number;
  coverage: Coverage;
  filters: Filters;
  subsidy_end: string;
  generated_at: string;
};

// GET /api/lens/flow/data (PROJECT.md 10.3, 18). source "rpc": the newest blocks read live from RPC (KL-23);
// "ingested": the newest ingested blocks at or before the scrubber time.
export type FlowRowT = {
  hash: string;
  block: number;
  ts: string;
  from: string;
  to: string | null;
  action: string;
  tokens: string[];
  fee_usd: number;
  value_wei: string;
  value_eth: number;
  status: "success" | "failed";
  subsidy_class: string;
};
export type FlowResponse = {
  source: "rpc" | "ingested";
  window: { start: string | null; end: string | null };
  blocks: { first: number; last: number } | null;
  tps: number | null;
  n_total: number;
  rows: FlowRowT[];
  tokens: { key: string; label: string }[];
  coverage: Coverage;
  filters: Filters;
  subsidy_end: string;
  generated_at: string;
};

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
  kind: "action" | "token" | "hour" | "address";
  key: string;
  label: string;
  window: CityWindowInfo;
  filters: Filters;
  // paid_share: share of likely_paid transactions, an estimate (PROJECT.md 12.2, KL-6); prototype line 598.
  // median_fee_usd: raw windows of 24 h or less and hours only (KL-17), null otherwise; the figure insights cite (Phase 7 D2).
  values: Omit<CityBuilding, "kind" | "key" | "label"> & { paid_share: number | null; median_fee_usd: number | null };
  // Same-length window just before this one; null for "all".
  previous: { tx_count: number; change: number | null } | null;
  trend: { bucket: "5m" | "1h" | "1d"; points: { ts: string; n: number }[] };
  samples: InspectorSample[];
  token: { symbol: string | null; name: string | null; creator: string | null; creator_url: string | null; launch_block: number | null; launch_ts: string | null } | null;
  // Transactions per action, for an hour; null otherwise.
  breakdown: { key: string; label: string; tx_count: number }[] | null;
  // An address from the Graph (Phase 9): values are the transactions that involve it in the window (sent, received or a
  // token moved from or to it); fees, gas,
  // fail rate and paid share as sender. kind "contract" only when Metro knows it is one; group per Phase 9 D1.
  address?: {
    kind: "contract" | "address";
    label: string | null;
    sent: number;
    received: number;
    native_transfers: { in: number; out: number };
    token_transfers: { in: number; out: number };
    fee_paid_usd: number | null;
    group: { funder: string; size: number } | null;
  } | null;
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
  // The widest sample (24 h) at the top level; each metric above keeps its own n and window (Phase 12 audit).
  n: number | null;
  window: Window | null;
  generated_at: string;
};

// /token/[address] and GET /api/v1/tokens/{address} (PROJECT.md 15, 16). Activity covers the ingested blocks only.
export type TokenProfile = {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  is_pons: boolean;
  // source "rpc": a launch newer than the ingested blocks, from the factory logs (KL-24).
  launch: { block: number; ts: string; creator: string; creator_url: string; source: "ingested" | "rpc" } | null;
  supply: { raw: string; formatted: string; source: "rpc" } | null;
  holders: HolderStatsT | null;
  market: TokenMarketT | null;
  market_available: boolean;
  daily: { date: string; n: number; avg_fee_usd: number | null }[];
  transfers: { tx_hash: string; from: string; to: string; amount: string; ts: string }[];
  // The profile's window is the 7 UTC days up to the anchor; n is the transactions that moved it in that window.
  n: number | null;
  window: Window | null;
  anchor: string | null;
  generated_at: string;
};

// /wallet/[address] (PROJECT.md 15). `ingested` covers the ingested blocks only; `chain` is read from RPC.
export type WalletProfile = {
  address: string;
  explorer_url: string;
  chain: { balance_eth: string; sent_total: number; is_contract: boolean; source: "rpc" } | null;
  ingested: {
    first_seen: string | null;
    last_seen: string | null;
    tx_count: number;
    sent: number;
    fee_paid_usd: number | null;
    paid_share: number | null;
    fail_rate: number | null;
    actions: { key: string; label: string; tx_count: number; fee_usd: number | null }[];
    hours: number[];
    counterparties: { sent_to: { address: string; tx_count: number }[]; received_from: { address: string; tx_count: number }[] };
    recent: { hash: string; block: number; ts: string; action: string; fee_usd: number; status: "success" | "failed"; direction: "in" | "out" }[];
  };
  generated_at: string;
};

// /tx/[hash] (PROJECT.md 7). source "rpc": not ingested; classification computed on the fly. fee_usd_basis: "minute"
// is the stored ETH price of its minute, "current" the live quote Flow uses for transactions not yet ingested.
export type TxDetail = {
  hash: string;
  source: "ingested" | "rpc";
  block: number;
  ts: string;
  from: string;
  to: string | null;
  value_eth: string;
  gas_used: string;
  gas_price_wei: string;
  fee_eth: string;
  fee_usd: number | null;
  fee_usd_basis: "minute" | "current" | null;
  status: "success" | "failed";
  method: string | null;
  action: string;
  action_label: string;
  subsidy_class: string;
  transfers: { log_index: number; token: string; symbol: string | null; is_pons: boolean; from: string; to: string; amount: string; amount_is_raw: boolean }[];
  positions: { lens: string; href: string }[];
  explorer_url: string;
};

// GET /api/v1/insights (PROJECT.md 13.2, 16). status "not_enough_data": n is below MIN_SAMPLE, shown as such (AT 15).
export type InsightT = {
  id: string;
  rule: string;
  title: string;
  status: "finding" | "not_enough_data";
  severity: "info" | "attention";
  text: string;
  n: number;
  window: { start: string; end: string };
  evidence_url: string;
  facts_ref: number[];
  // Subjects of the cited facts, as "action:swap", "token:0x…", "hour:2026-09-27T15:00Z", "wallet:0x…" (gate F48).
  subjects: string[];
  created_at: string;
  expires_at: string;
};
export type InsightsResponse = { total: number; findings: number; min_sample: number; computed_at: string | null; insights: InsightT[]; generated_at: string };

// GET /api/v1/facts?prefix= (PROJECT.md 13.1, 16).
export type FactT = { id: number; key: string; window: { start: string; end: string }; value: number; n: number; computed_at: string };
export type FactsResponse = { prefix: string; total: number; facts: FactT[]; generated_at: string };
// POST /api/ask (PROJECT.md 13.3, 18; api.md 2.1; Phase 10). Sources are facts from the Ledger; trail is the plain
// account of which layer answered and what was rejected; a refusal carries refused_reason and no model output.
export type AskSourceT = { fact_key: string; value: number; n: number; window: { start: string; end: string }; lens_url: string };
export type AskResponseT = {
  id: string | null;
  question: string;
  topic: string;
  title: string;
  scope: { window: string; action: string | null; token: string | null; address: string | null };
  answer: string;
  model_used: string;
  layer: number;
  layer_name: string;
  validated: boolean;
  sources: AskSourceT[];
  trail: string[];
  cached: boolean;
  refused_reason: string | null;
  quota: { limit: number; used: number; remaining: number; reset: string };
  generated_at: string;
};

// GET /api/v1/dispatch and /api/v1/dispatch/:id (PROJECT.md 16; Phase 11). facts_ref lists the facts every number in
// body_md came from; facts carries the same rows for the report page.
export type DispatchListItemT = { id: string; kind: string; range_label: string; model_used: string; created_at: string };
export type DispatchReportT = DispatchListItemT & {
  body_md: string;
  facts_ref: number[];
  facts: { id: number; key: string; window: { start: string; end: string }; value: number; n: number }[];
  generated_at: string;
};
