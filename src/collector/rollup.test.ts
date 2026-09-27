import { existsSync } from "node:fs";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, txs } from "../db/schema.ts";
import type { BlockBundle } from "./ingest.ts";
import { rollupDays, rollupMinutes } from "./rollup.ts";
import { writeBatch } from "./writer.ts";

// Integration test against the Neon dev branch (PROJECT.md 22, AT 5 and 14). Opt in with RUN_DB_TESTS=1.
// Uses synthetic blocks far above the chain head on 2020-01-02 and removes them afterwards.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 910_000_000_000;
const DAY = "2020-01-02";
const at = (sec: number) => new Date(Date.parse(`${DAY}T00:00:00Z`) + sec * 1000);
const hash = (n: number, i: number) => `0x${"cc"}${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`;

type TxSpec = { fee: string; from: string; action: "swap" | "approve"; status?: number; subsidy?: "likely_paid" | "likely_subsidized" };

function bundle(n: number, sec: number, specs: TxSpec[]): BlockBundle {
  const ts = at(sec);
  return {
    block: { number: n, hash: `0xdd${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: hash(n, i),
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: null,
      value: "0",
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: s.status ?? 1,
      method: null,
      action: s.action,
      subsidyClass: s.subsidy ?? "likely_paid",
    })),
    transfers: [],
    tokens: [],
    launches: [],
  };
}

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";

describe.skipIf(!enabled)("rollups (PROJECT.md 9.1 step 5)", () => {
  let db: Db;
  let end: () => Promise<void>;

  async function cleanup() {
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, at(0)), lte(aggMinute.ts, at(86_399))));
    await db.delete(aggDay).where(eq(aggDay.date, DAY));
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200102"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    await writeBatch(db, null, [
      bundle(BASE + 1, 5, [
        { fee: "0.01", from: A, action: "swap" },
        { fee: "0.03", from: A, action: "swap" },
        { fee: "0.02", from: B, action: "approve", status: 0 },
      ]),
      bundle(BASE + 2, 30, [{ fee: "0.05", from: B, action: "swap", subsidy: "likely_subsidized" }]),
      bundle(BASE + 3, 75, [{ fee: "0.04", from: A, action: "swap" }]),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  it("builds one agg_minute row per minute and action, exact against the raw rows", async () => {
    await rollupMinutes(db, at(5), at(75));
    const rows = await db.select().from(aggMinute).where(and(gte(aggMinute.ts, at(0)), lte(aggMinute.ts, at(119)))).orderBy(aggMinute.ts, aggMinute.action);
    expect(rows.map((r) => [r.ts.toISOString().slice(11, 16), r.action, r.txCount, Number(r.feeUsdSum), Number(r.feeUsdMedian), r.wallets])).toEqual([
      ["00:00", "approve", 1, 0.02, 0.02, 1],
      // fees 0.01, 0.03, 0.05: median 0.03; wallets A and B.
      ["00:00", "swap", 3, 0.09, 0.03, 2],
      ["00:01", "swap", 1, 0.04, 0.04, 1],
    ]);
  });

  it("recomputes a minute when more blocks land in it later", async () => {
    await writeBatch(db, null, [bundle(BASE + 4, 80, [{ fee: "0.06", from: B, action: "swap" }])]);
    await rollupMinutes(db, at(80), at(80));
    const [row] = await db.select().from(aggMinute).where(and(eq(aggMinute.ts, at(60)), eq(aggMinute.action, "swap")));
    // fees 0.04, 0.06: percentile_disc picks the lower middle value.
    expect(row).toMatchObject({ txCount: 2, wallets: 2 });
    expect(Number(row?.feeUsdMedian)).toBe(0.04);
  });

  it("builds agg_day per action and subsidy class with failures and wallets", async () => {
    await rollupDays(db, [DAY]);
    const rows = await db.select().from(aggDay).where(eq(aggDay.date, DAY)).orderBy(aggDay.action, aggDay.subsidyClass);
    expect(rows.map((r) => [r.action, r.subsidyClass, r.txCount, Number(r.feeUsdAvg), r.activeWallets, r.failedTxCount, r.retainedWallets])).toEqual([
      ["approve", "likely_paid", 1, 0.02, 1, 1, null],
      ["swap", "likely_paid", 4, (0.01 + 0.03 + 0.04 + 0.06) / 4, 2, 0, null],
      ["swap", "likely_subsidized", 1, 0.05, 1, 0, null],
    ]);
  });

  it("rejects a malformed day", async () => {
    await expect(rollupDays(db, ["2020-1-2"])).rejects.toThrow("Invalid day");
  });
});
