import { existsSync } from "node:fs";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockBundle } from "../collector/ingest.ts";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, txs } from "../db/schema.ts";
import { NO_FILTERS } from "../lib/view-state.ts";
import { getCity, getInspector } from "./city.ts";
import { getHeatmap } from "./heatmap.ts";
import { getTerrain } from "./terrain.ts";

// Terrain, Heatmap and filtered City/Inspector reads against the Neon dev branch (PROJECT.md 10.2, 10.5, 11.2, AT 14).
// Opt in with RUN_DB_TESTS=1. Data lives on 2020-03-10 and 2020-03-11 and is removed afterwards; every call passes
// an explicit anchor, so the tests never depend on which block is newest.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 916_000_000_000;
const DAYS = ["2020-03-10", "2020-03-11"];
const t = (day: 0 | 1, hhmm: string) => new Date(`${DAYS[day]}T${hhmm}:00Z`);
const ANCHOR = t(1, "12:00");
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const ETH = 10n ** 18n;

type Spec = { action: "swap" | "approve"; fee: string; from: string; status?: number; value?: bigint };

function bundle(n: number, ts: Date, baseFeeGwei: number, specs: Spec[]): BlockBundle {
  return {
    block: { number: n, hash: `0xd2${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: String(baseFeeGwei * 1e9), txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: `0xd1${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`,
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: null,
      value: String(s.value ?? 0n),
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: s.status ?? 1,
      method: null,
      action: s.action,
      subsidyClass: "likely_paid",
    })),
    transfers: [],
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("terrain, heatmap and filters (PROJECT.md 10.2, 10.5, 11.2, AT 14)", () => {
  let db: Db;
  let end: () => Promise<void>;
  const savedCliff = process.env.SUBSIDY_END_DATE;

  async function cleanup() {
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, t(0, "00:00")), lte(aggMinute.ts, t(1, "23:59"))));
    await db.delete(aggDay).where(inArray(aggDay.date, DAYS));
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    for (const d of DAYS) await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_${d.replaceAll("-", "")}"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    await writeBatch(db, null, [
      bundle(BASE + 1, t(0, "10:05"), 2, [
        { action: "swap", fee: "0.01", from: A },
        { action: "swap", fee: "0.03", from: B, status: 0, value: 2n * ETH },
      ]),
      bundle(BASE + 2, t(0, "11:00"), 4, [{ action: "approve", fee: "0.02", from: A }]),
      bundle(BASE + 3, t(1, "10:30"), 2, [{ action: "swap", fee: "0.05", from: A, value: ETH }]),
      bundle(BASE + 4, t(1, "11:40"), 6, [
        { action: "approve", fee: "0.04", from: B, status: 0 },
        { action: "swap", fee: "0.06", from: B, value: 3n * ETH },
      ]),
    ]);
    await rollupMinutes(db, t(0, "10:00"), t(1, "12:00"));
    await rollupDays(db, DAYS);
  });

  afterAll(async () => {
    if (savedCliff === undefined) delete process.env.SUBSIDY_END_DATE;
    else process.env.SUBSIDY_END_DATE = savedCliff;
    await cleanup();
    await end();
  });

  it("AT 14: every heatmap cell equals a direct SQL aggregate over txs", async () => {
    const h = await getHeatmap(db, { window: "7d", metric: "tx_count", mode: "days", filters: NO_FILTERS }, ANCHOR);
    expect(h.days).toEqual(["2020-03-05", "2020-03-06", "2020-03-07", "2020-03-08", "2020-03-09", "2020-03-10", "2020-03-11"]);
    const direct = (await db.execute(sql`
      SELECT to_char(date_bin('1 hour'::interval, ts, timestamptz '2000-01-01') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24') AS k, count(*) AS n
      FROM txs WHERE block >= ${BASE} AND block <= ${BASE + 100} GROUP BY 1`)).rows as { k: string; n: string }[];
    const expected = new Map(direct.map((r) => [r.k, Number(r.n)]));
    let dataCells = 0;
    h.days.forEach((day, d) =>
      h.cells[d]?.forEach((c, hour) => {
        if (c.s !== "d") return;
        dataCells += 1;
        expect(c.v).toBe(expected.get(`${day}T${String(hour).padStart(2, "0")}`));
      }),
    );
    expect(dataCells).toBe(expected.size);
    expect(h.cells[5]?.[10]).toEqual({ v: 2, n: 2, s: "d" });
    expect(h.cells[5]?.[12]?.s).toBe("n");
    // 12:00 on the anchor day is still inside the window (the anchor minute); later hours are not.
    expect(h.cells[6]?.[12]?.s).toBe("n");
    expect(h.cells[6]?.[13]?.s).toBe("o");
    expect(h.n).toBe(6);
  });

  it("heatmap average fee and chain-wide gas price per hour", async () => {
    const fee = await getHeatmap(db, { window: "7d", metric: "avg_fee_usd", mode: "days", filters: NO_FILTERS }, ANCHOR);
    expect(fee.cells[5]?.[10]?.v).toBeCloseTo(0.02, 10);
    expect(fee.cells[6]?.[11]?.v).toBeCloseTo(0.05, 10);
    const gas = await getHeatmap(db, { window: "7d", metric: "gas_price", mode: "days", filters: NO_FILTERS }, ANCHOR);
    expect(gas.cells[5]?.[10]).toEqual({ v: 2, n: 1, s: "d" });
    expect(gas.cells[6]?.[11]).toEqual({ v: 6, n: 1, s: "d" });
  });

  it("heatmap compare mode splits hours at SUBSIDY_END_DATE", async () => {
    process.env.SUBSIDY_END_DATE = "2020-03-11";
    const h = await getHeatmap(db, { window: "7d", metric: "tx_count", mode: "compare", filters: NO_FILTERS }, ANCHOR);
    expect(h.subsidy_end).toBe("2020-03-11T00:00:00.000Z");
    expect(h.compare?.before.values[10]).toBe(2);
    expect(h.compare?.before.values[11]).toBe(1);
    expect(h.compare?.after.values[10]).toBe(1);
    expect(h.compare?.after.values[11]).toBe(2);
    expect(h.compare?.before.days).toBe(1);
    expect(h.compare?.after).toMatchObject({ days: 1, full_days: 0 });
    expect(h.compare?.before.values[3]).toBeNull();
  });

  it("raw filters apply to 24 h windows in the heatmap, city and inspector (KL-20)", async () => {
    const failed = { ...NO_FILTERS, status: "failed" as const };
    const h = await getHeatmap(db, { window: "24h", metric: "tx_count", mode: "days", filters: failed }, ANCHOR);
    expect(h.days).toEqual(DAYS);
    expect(h.cells[0]?.[10]?.s).toBe("o");
    expect(h.cells[1]?.[11]).toEqual({ v: 1, n: 1, s: "d" });
    const rich = await getHeatmap(db, { window: "24h", metric: "tx_count", mode: "days", filters: { ...NO_FILTERS, minValue: "2" } }, ANCHOR);
    expect(rich.cells[1]?.[11]?.v).toBe(1);
    expect(rich.cells[1]?.[10]?.v).toBe(0);

    const city = await getCity(db, "24h", ANCHOR, failed);
    expect(city.filters).toEqual(failed);
    expect(city.buildings.find((b) => b.key === "approve")).toMatchObject({ tx_count: 1, fail_rate: 1 });
    expect(city.buildings.find((b) => b.key === "swap")).toMatchObject({ tx_count: 0 });
    const valued = await getCity(db, "24h", ANCHOR, { ...NO_FILTERS, minValue: "1" });
    expect(valued.buildings.find((b) => b.key === "swap")?.tx_count).toBe(2);

    const hour = await getInspector(db, { kind: "hour", key: "2020-03-11T11:00Z", window: "24h", filters: NO_FILTERS, at: null }, ANCHOR);
    expect(hour).toMatchObject({ kind: "hour", label: "11 Mar, 11:00 to 12:00 UTC", values: { tx_count: 2, fail_rate: 0.5, wallets: 1, paid_share: 1 } });
    expect(hour?.breakdown).toHaveLength(2);
    expect(hour?.breakdown).toContainEqual({ key: "approve", label: "Approve", tx_count: 1 });
    expect(hour?.previous).toEqual({ tx_count: 1, change: 1 });
    expect(hour?.samples).toHaveLength(2);

    // Paid share over whole days comes from agg_day's subsidy class dimension (every fixture tx is likely_paid).
    const week = await getInspector(db, { kind: "action", key: "swap", window: "7d", filters: NO_FILTERS, at: null }, ANCHOR);
    expect(week?.values).toMatchObject({ tx_count: 4, paid_share: 1, wallets: null });
  });

  it("terrain: one bucket per hour over 7 days, null where nothing was ingested", async () => {
    const tr = await getTerrain(db, { window: "7d", metric: "tx_count", rows: "actions", filters: NO_FILTERS }, ANCHOR);
    expect(tr.bucket).toBe("1h");
    expect(tr.buckets).toHaveLength(168);
    expect(tr.buckets[0]).toBe("2020-03-05T00:00:00.000Z");
    const i = tr.buckets.indexOf("2020-03-10T10:00:00.000Z");
    const swap = tr.rows.find((r) => r.key === "swap");
    expect(swap?.values[i]).toBe(2);
    expect(tr.rows.find((r) => r.key === "approve")?.values[i]).toBe(0);
    expect(swap?.values[0]).toBeNull();
    expect(tr.covered.filter(Boolean)).toHaveLength(4);
    expect(tr.n).toBe(6);
    expect(tr.rows.map((r) => r.key)).toEqual(["native_transfer", "erc20_transfer", "swap", "bridge", "launch", "approve", "contract_call"]);
  });

  it("terrain: 10-minute buckets over 24 h with fail rate from raw rows; daily buckets for all", async () => {
    const tr = await getTerrain(db, { window: "24h", metric: "fail_rate", rows: "actions", filters: NO_FILTERS }, ANCHOR);
    expect(tr.bucket).toBe("10m");
    // The window is [12:01, 12:01) on minute bounds, so the first and last 10-minute buckets are partial: 145.
    expect(tr.buckets).toHaveLength(145);
    expect(tr.buckets[0]).toBe("2020-03-10T12:00:00.000Z");
    const i = tr.buckets.indexOf("2020-03-11T11:40:00.000Z");
    expect(tr.rows.find((r) => r.key === "approve")?.values[i]).toBe(1);
    expect(tr.rows.find((r) => r.key === "swap")?.values[i]).toBe(0);
    expect(tr.rows.find((r) => r.key === "bridge")?.values[i]).toBeNull();

    const all = await getTerrain(db, { window: "all", metric: "tx_count", rows: "actions", filters: NO_FILTERS }, ANCHOR);
    expect(all.bucket).toBe("1d");
    expect(all.buckets).toEqual(["2020-03-10T00:00:00.000Z", "2020-03-11T00:00:00.000Z"]);
    expect(all.rows.find((r) => r.key === "swap")?.values).toEqual([2, 2]);
  });
});
