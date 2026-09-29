import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// Mirrors project-context/schema.md. dispatch and analyst_answers arrive in Phases 10 and 11.

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const ACTIONS = [
  "bridge",
  "launch",
  "swap",
  "erc20_transfer",
  "native_transfer",
  "approve",
  "contract_call",
  "other",
] as const;
export type Action = (typeof ACTIONS)[number];

export const SUBSIDY_CLASSES = ["likely_subsidized", "likely_paid", "unknown"] as const;
export type SubsidyClass = (typeof SUBSIDY_CLASSES)[number];

export const blocks = pgTable(
  "blocks",
  {
    number: bigint("number", { mode: "number" }).primaryKey(),
    hash: varchar("hash", { length: 66 }).notNull().unique(),
    ts: tstz("ts").notNull(),
    gasUsed: numeric("gas_used").notNull(),
    gasLimit: numeric("gas_limit").notNull(),
    baseFee: numeric("base_fee"),
    txCount: integer("tx_count").notNull().default(0),
  },
  (t) => [index("idx_blocks_ts").on(t.ts.desc())],
);

// Partitioned by RANGE (ts): hand-edited in drizzle/0000_init.sql because Drizzle has no partition syntax.
// Daily partitions are created by the Collector (src/db/partitions.ts).
export const txs = pgTable(
  "txs",
  {
    hash: varchar("hash", { length: 66 }).notNull(),
    block: bigint("block", { mode: "number" })
      .notNull()
      .references(() => blocks.number),
    ts: tstz("ts").notNull(),
    fromAddress: varchar("from_address", { length: 42 }).notNull(),
    toAddress: varchar("to_address", { length: 42 }),
    value: numeric("value").notNull().default("0"),
    gasUsed: numeric("gas_used").notNull(),
    gasPrice: numeric("gas_price").notNull(),
    feeEth: numeric("fee_eth").notNull(),
    feeUsd: numeric("fee_usd").notNull(),
    status: smallint("status").notNull(),
    method: varchar("method", { length: 64 }),
    action: varchar("action", { length: 32, enum: ACTIONS }).notNull(),
    subsidyClass: varchar("subsidy_class", { length: 24, enum: SUBSIDY_CLASSES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hash, t.ts] }),
    // Time-range reads (Ticker median, series, 24h breakdown, day rollups) filter on ts alone.
    index("idx_txs_ts").on(t.ts.desc()),
    index("idx_txs_from").on(t.fromAddress, t.ts.desc()),
    index("idx_txs_to").on(t.toAddress, t.ts.desc()),
    index("idx_txs_action").on(t.action, t.ts.desc()),
    index("idx_txs_subsidy").on(t.subsidyClass, t.ts.desc()),
  ],
);

export const tokenTransfers = pgTable(
  "token_transfers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    txHash: varchar("tx_hash", { length: 66 }).notNull(),
    logIndex: integer("log_index").notNull(),
    tokenAddress: varchar("token_address", { length: 42 }).notNull(),
    fromAddress: varchar("from_address", { length: 42 }).notNull(),
    toAddress: varchar("to_address", { length: 42 }).notNull(),
    amount: numeric("amount").notNull(),
    ts: tstz("ts").notNull(),
  },
  (t) => [
    index("idx_transfers_token_ts").on(t.tokenAddress, t.ts.desc()),
    index("idx_transfers_tx").on(t.txHash),
    uniqueIndex("uq_transfers_log").on(t.txHash, t.logIndex),
    // Graph lens and wallet ego graph (Phase 9): transfers in a window, and one address's transfers.
    index("idx_transfers_ts").on(t.ts.desc()),
    index("idx_transfers_from").on(t.fromAddress, t.ts.desc()),
    index("idx_transfers_to").on(t.toAddress, t.ts.desc()),
  ],
);

export const tokens = pgTable("tokens", {
  address: varchar("address", { length: 42 }).primaryKey(),
  symbol: varchar("symbol", { length: 32 }),
  name: varchar("name", { length: 128 }),
  decimals: integer("decimals").notNull().default(18),
  isPons: boolean("is_pons").notNull().default(false),
  createdAt: tstz("created_at"),
  // From Blockscout (PROJECT.md 8.1, Phase 6); null until measured, never a made-up 0 (PROJECT.md 3.2, audit A4).
  holders: integer("holders"),
  supply: numeric("supply"),
});

export const ponsLaunches = pgTable("pons_launches", {
  tokenAddress: varchar("token_address", { length: 42 })
    .primaryKey()
    .references(() => tokens.address),
  creatorAddress: varchar("creator_address", { length: 42 }).notNull(),
  block: bigint("block", { mode: "number" }).notNull(),
  ts: tstz("ts").notNull(),
  params: jsonb("params").notNull(),
});

export const knownContracts = pgTable("known_contracts", {
  address: varchar("address", { length: 42 }).primaryKey(),
  kind: varchar("kind", { length: 32, enum: ["router", "pool", "bridge", "factory"] }).notNull(),
  label: varchar("label", { length: 64 }).notNull(),
  verifiedAt: tstz("verified_at").default(sql`now()`),
});

export const prices = pgTable("prices", {
  ts: tstz("ts").primaryKey(),
  ethUsd: numeric("eth_usd").notNull(),
});

export const ingestCursor = pgTable("ingest_cursor", {
  name: varchar("name", { length: 32 }).primaryKey(),
  block: bigint("block", { mode: "number" }).notNull(),
  updatedAt: tstz("updated_at").notNull().default(sql`now()`),
  lastError: text("last_error"),
  lastErrorAt: tstz("last_error_at"),
  // Target range of a bounded cursor (the backfill); null for the open-ended live cursor.
  rangeStart: bigint("range_start", { mode: "number" }),
  rangeEnd: bigint("range_end", { mode: "number" }),
  // Observed throughput of the cursor's worker; /api/health derives the backfill ETA from it.
  blocksPerSecond: doublePrecision("blocks_per_second"),
});

// One row per minute and action (PROJECT.md 17). Recomputed from txs for every minute an ingest batch touches.
// fee_usd_median uses percentile_disc(0.5): an actual fee value, the lower middle one for even counts.
export const aggMinute = pgTable(
  "agg_minute",
  {
    ts: tstz("ts").notNull(),
    action: varchar("action", { length: 32, enum: ACTIONS }).notNull(),
    txCount: integer("tx_count").notNull(),
    gasUsed: numeric("gas_used").notNull(),
    feeUsdSum: numeric("fee_usd_sum").notNull(),
    feeUsdMedian: numeric("fee_usd_median").notNull(),
    wallets: integer("wallets").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ts, t.action] }), index("idx_agg_minute_ts").on(t.ts.desc())],
);

// One row per UTC day, action and subsidy class (PROJECT.md 17).
export const aggDay = pgTable(
  "agg_day",
  {
    date: date("date", { mode: "string" }).notNull(),
    action: varchar("action", { length: 32, enum: ACTIONS }).notNull(),
    subsidyClass: varchar("subsidy_class", { length: 24, enum: SUBSIDY_CLASSES }).notNull(),
    txCount: integer("tx_count").notNull(),
    gasUsed: numeric("gas_used").notNull(),
    feeUsdAvg: numeric("fee_usd_avg").notNull(),
    feeUsdMedian: numeric("fee_usd_median").notNull(),
    activeWallets: integer("active_wallets").notNull(),
    // Retention against the subsidy cliff is defined in Phase 8 (PROJECT.md 12.3); null until then rather than a fake 0.
    retainedWallets: integer("retained_wallets"),
    failedTxCount: integer("failed_tx_count").notNull(),
    // ArbOS internal transactions in the row (sender ARBOS_SENDER; KL-7). Paid share leaves them out of its
    // denominator everywhere (Phase 8 D2). Usually one per block, sometimes two.
    systemTxCount: integer("system_tx_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.date, t.action, t.subsidyClass] })],
);

// Ledger of Facts (PROJECT.md 13.1, 17): one row per computed fact. A rerun for the same window updates its row
// (unique key and window), so the table grows only when the anchor block moves (KL-1).
export const facts = pgTable(
  "facts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: varchar("key", { length: 128 }).notNull(),
    windowStart: tstz("window_start").notNull(),
    windowEnd: tstz("window_end").notNull(),
    value: numeric("value").notNull(),
    n: integer("n").notNull(),
    computedAt: tstz("computed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_facts_key_window").on(t.key, t.windowStart, t.windowEnd), index("idx_facts_computed").on(t.computedAt.desc())],
);

export const INSIGHT_SEVERITIES = ["info", "attention"] as const;
export const INSIGHT_STATUSES = ["finding", "not_enough_data"] as const;

// Rule-based insights (PROJECT.md 13.2, 17). `id` is deterministic (rule, subject, window), so a rerun replaces a
// finding. status, n, window and evidence_url are what api.md 1.5 returns and AT 15/16 check.
export const insights = pgTable(
  "insights",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    rule: varchar("rule", { length: 64 }).notNull(),
    status: varchar("status", { length: 24, enum: INSIGHT_STATUSES }).notNull(),
    text: text("text").notNull(),
    factsRef: jsonb("facts_ref").$type<number[]>().notNull(),
    severity: varchar("severity", { length: 16, enum: INSIGHT_SEVERITIES }).notNull(),
    n: integer("n").notNull(),
    windowStart: tstz("window_start").notNull(),
    windowEnd: tstz("window_end").notNull(),
    evidenceUrl: text("evidence_url").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("idx_insights_created").on(t.createdAt.desc()), index("idx_insights_expires").on(t.expiresAt)],
);
