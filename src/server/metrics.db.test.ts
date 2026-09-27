import { existsSync } from "node:fs";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import type { BlockBundle } from "../collector/ingest.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, txs } from "../db/schema.ts";
import { getBreakdown, getSeries, getStats } from "./metrics.ts";

// API read queries against the Neon dev branch (plan phase 3, section 5). Opt in with RUN_DB_TESTS=1.
// Synthetic blocks sit above every other test's block numbers, so getStats (newest block) anchors on them,
// and on 2020-02-10, so no other test day falls inside the 24h or 7d windows.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 920_000_000_000;
const DAY = "2020-02-10";
const at = (hhmmss: string) => new Date(`${DAY}T${hhmmss}Z`);

type Spec = { fee: string; from: string; action: "swap" | "approve"; subsidy?: "likely_paid" | "likely_subsidized" };

function bundle(n: number, ts: Date, specs: Spec[]): BlockBundle {
  return {
    block: { number: n, hash: `0xee${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: "22000000", txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: `0xef${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`,
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: null,
      value: "0",
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: 1,
      method: null,
      action: s.action,
      subsidyClass: s.subsidy ?? "likely_paid",
    })),
    transfers: [],
    tokens: [],
    launches: [],
  };
}

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

describe.skipIf(!enabled)("metrics read queries (PROJECT.md 16)", () => {
  let db: Db;
  let end: () => Promise<void>;

  async function cleanup() {
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, at("00:00:00")), lte(aggMinute.ts, at("23:59:59"))));
    await db.delete(aggDay).where(eq(aggDay.date, DAY));
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200210"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    // Fees 0.01..0.05 over two minutes: 00:10 holds four transactions, 00:11 holds one.
    await writeBatch(db, null, [
      bundle(BASE + 1, at("00:10:00"), [
        { fee: "0.01", from: A, action: "swap" },
        { fee: "0.03", from: B, action: "swap" },
      ]),
      bundle(BASE + 2, at("00:10:30"), [
        { fee: "0.02", from: A, action: "approve" },
        { fee: "0.05", from: B, action: "swap", subsidy: "likely_subsidized" },
      ]),
      bundle(BASE + 3, at("00:11:10"), [{ fee: "0.04", from: A, action: "swap" }]),
    ]);
    await rollupMinutes(db, at("00:10:00"), at("00:11:10"));
    await rollupDays(db, [DAY]);
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  it("getStats anchors every window on the newest ingested block", async () => {
    const s = await getStats(db);
    expect(s.latest).toMatchObject({ block: BASE + 3, ts: at("00:11:10").toISOString(), base_fee_wei: "22000000" });
    if (!s.latest || !("tps" in s)) throw new Error("expected full stats");
    // Blocks after 00:10:10: 00:10:30 (2 txs) and 00:11:10 (1 tx), over 40 s plus one second of resolution.
    expect(s.tps.n).toBe(3);
    expect(s.tps.value).toBeCloseTo(3 / 41, 10);
    expect(s.fees.n).toBe(5);
    expect(s.fees.avg_usd).toBeCloseTo(0.03, 10);
    expect(s.fees.median_usd).toBe(0.03);
    expect(s.fees.window).toEqual({ start: at("00:10:00").toISOString(), end: at("00:11:10").toISOString() });
    expect(s.subsidized).toMatchObject({ n: 5 });
    expect(s.subsidized.ratio).toBeCloseTo(0.2, 10);
  });

  it("getSeries returns additive metrics from agg_minute and non-additive ones from txs", async () => {
    const now = at("00:12:00");
    const count = await getSeries(db, { metric: "tx_count", window: "1h", bucket: "1m" }, now);
    if ("error" in count) throw new Error(count.error);
    expect(count.n).toBe(5);
    expect(count.data).toEqual([
      { ts: at("00:10:00").toISOString(), value: 4, n: 4 },
      { ts: at("00:11:00").toISOString(), value: 1, n: 1 },
    ]);

    const avg = await getSeries(db, { metric: "avg_fee_usd", window: "1h", bucket: "1h" }, now);
    if ("error" in avg) throw new Error(avg.error);
    expect(avg.data).toHaveLength(1);
    expect(avg.data[0]?.value).toBeCloseTo(0.03, 10);

    const median = await getSeries(db, { metric: "median_fee_usd", window: "1h", bucket: "5m" }, now);
    const wallets = await getSeries(db, { metric: "wallets", window: "1h", bucket: "5m" }, now);
    if ("error" in median || "error" in wallets) throw new Error("unexpected error");
    expect(median.data).toEqual([{ ts: at("00:10:00").toISOString(), value: 0.03, n: 5 }]);
    expect(wallets.data).toEqual([{ ts: at("00:10:00").toISOString(), value: 2, n: 5 }]);

    // Bucket 1d reads agg_day and must stop at the day of `now`.
    const daily = await getSeries(db, { metric: "tx_count", window: "24h", bucket: "1d" }, now);
    if ("error" in daily) throw new Error(daily.error);
    expect(daily.data).toEqual([{ ts: `${DAY}T00:00:00.000Z`, value: 5, n: 5 }]);
  });

  it("getBreakdown splits by action and by subsidy class", async () => {
    const now = at("00:12:00");
    const byAction = await getBreakdown(db, { by: "action", window: "24h" }, now);
    expect(byAction.n).toBe(5);
    expect(byAction.items.map((i) => [i.key, i.tx_count, i.share])).toEqual([
      ["swap", 4, 0.8],
      ["approve", 1, 0.2],
    ]);
    expect(byAction.items[0]?.avg_fee_usd).toBeCloseTo(0.0325, 10);

    const bySubsidy = await getBreakdown(db, { by: "subsidy", window: "24h" }, now);
    expect(bySubsidy.items.map((i) => [i.key, i.tx_count])).toEqual([
      ["likely_paid", 4],
      ["likely_subsidized", 1],
    ]);

    // 7d comes from agg_day, which splits swap across two subsidy classes; by action they add back up.
    const week = await getBreakdown(db, { by: "action", window: "7d" }, now);
    expect(week.items.map((i) => [i.key, i.tx_count])).toEqual([
      ["swap", 4],
      ["approve", 1],
    ]);
  });
});
