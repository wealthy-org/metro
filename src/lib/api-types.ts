// Response contracts shared by route handlers and client components. Type-only; safe to import in the browser.

import type { ChainEconomics, ChainStats } from "../server/external.ts";

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
