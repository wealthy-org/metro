// The bounded export datasets (PROJECT.md 16; Phase 11 D4). Shared by GET /api/v1/export/[dataset] and the catalog on
// /data (Phase 12), so the page and the route never drift.
export type ExportDataset = {
  columns: string[];
  table: string;
  order: string;
  timeColumn: string | null;
  maxSpanMs: number | null;
  rowCap: number | null;
  note: string;
};

const DAY_MS = 86_400_000;

export const EXPORT_DATASETS: Record<string, ExportDataset> = {
  txs: {
    columns: ["hash", "block", "ts", "from_address", "to_address", "value", "gas_used", "gas_price", "fee_eth", "fee_usd", "status", "method", "action", "subsidy_class"],
    table: "txs",
    order: "ts, hash",
    timeColumn: "ts",
    maxSpanMs: DAY_MS,
    rowCap: 50_000,
    note: "one row per transaction, from the daily partitions",
  },
  blocks: {
    columns: ["number", "hash", "ts", "gas_used", "gas_limit", "base_fee", "tx_count"],
    table: "blocks",
    order: "number",
    timeColumn: "ts",
    maxSpanMs: DAY_MS,
    rowCap: null,
    note: "one row per ingested block",
  },
  agg_minute: {
    columns: ["ts", "action", "tx_count", "gas_used", "fee_usd_sum", "fee_usd_median", "wallets"],
    table: "agg_minute",
    order: "ts, action",
    timeColumn: "ts",
    maxSpanMs: 7 * DAY_MS,
    rowCap: null,
    note: "the minute rollups the short windows read",
  },
  agg_day: {
    columns: ["date", "action", "subsidy_class", "tx_count", "gas_used", "fee_usd_avg", "fee_usd_median", "active_wallets", "failed_tx_count", "system_tx_count"],
    table: "agg_day",
    order: "date, action, subsidy_class",
    timeColumn: null,
    maxSpanMs: null,
    rowCap: null,
    note: "whole UTC days, per action and subsidy class",
  },
  facts: {
    columns: ["id", "key", "window_start", "window_end", "value", "n", "computed_at"],
    table: "facts",
    order: "id",
    timeColumn: null,
    maxSpanMs: null,
    rowCap: null,
    note: "the Ledger of Facts every number in Metro comes from",
  },
  insights: {
    columns: ["id", "rule", "status", "text", "n", "severity", "window_start", "window_end", "evidence_url", "created_at", "expires_at"],
    table: "insights",
    order: "created_at DESC",
    timeColumn: null,
    maxSpanMs: null,
    rowCap: null,
    note: "the active insight set of the last engine run",
  },
  tokens: {
    columns: ["address", "symbol", "name", "decimals", "is_pons", "created_at", "holders", "supply"],
    table: "tokens",
    order: "address",
    timeColumn: null,
    maxSpanMs: null,
    rowCap: null,
    note: "the stored token list",
  },
};
