import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
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

// Mirrors project-context/schema.md. Phase 1 tables only; aggregates and analytics arrive in later phases.

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
  ],
);

export const tokens = pgTable("tokens", {
  address: varchar("address", { length: 42 }).primaryKey(),
  symbol: varchar("symbol", { length: 32 }),
  name: varchar("name", { length: 128 }),
  decimals: integer("decimals").notNull().default(18),
  isPons: boolean("is_pons").notNull().default(false),
  createdAt: tstz("created_at"),
  holders: integer("holders").notNull().default(0),
  supply: numeric("supply").notNull().default("0"),
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
});
