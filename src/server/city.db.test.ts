import { existsSync } from "node:fs";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { BlockBundle } from "../collector/ingest.ts";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, ponsLaunches, tokens, tokenTransfers, txs } from "../db/schema.ts";
import { getCity, getInspector } from "./city.ts";
import { NO_FILTERS } from "../lib/view-state.ts";

const live = { filters: NO_FILTERS, at: null };

// City lens and Inspector reads against the Neon dev branch. Opt in with RUN_DB_TESTS=1.
// Block numbers sit below the other DB tests' ranges and every call passes an explicit anchor, so the tests
// never depend on (or change) which block is newest. Data lives on 2020-03-05 and is removed afterwards.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 915_000_000_000;
const DAY = "2020-03-05";
const at = (hhmmss: string) => new Date(`${DAY}T${hhmmss}Z`);
const TOKEN = "0x00000000000000000000000000000000000c1701";
const OTHER_TOKEN = "0x00000000000000000000000000000000000c1702";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

type Spec = { action: "swap" | "approve" | "other" | "contract_call"; fee: string; from: string; status?: number; token?: string; cls?: "likely_paid" | "unknown" };

function bundle(n: number, ts: Date, specs: Spec[]): BlockBundle {
  const hashes = specs.map((_, i) => `0xc1${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`);
  return {
    block: { number: n, hash: `0xc2${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: hashes[i] ?? "",
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
      subsidyClass: s.cls ?? "likely_paid",
    })),
    transfers: specs.flatMap((s, i) =>
      s.token ? [{ txHash: hashes[i] ?? "", logIndex: 0, tokenAddress: s.token, fromAddress: s.from, toAddress: B, amount: "1", ts }] : [],
    ),
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("city lens and inspector reads (PROJECT.md 10.1, 11.1, 18)", () => {
  let db: Db;
  let end: () => Promise<void>;

  async function cleanup() {
    await db.delete(tokenTransfers).where(inArray(tokenTransfers.tokenAddress, [TOKEN, OTHER_TOKEN]));
    await db.delete(ponsLaunches).where(inArray(ponsLaunches.tokenAddress, [TOKEN, OTHER_TOKEN]));
    await db.delete(tokens).where(inArray(tokens.address, [TOKEN, OTHER_TOKEN]));
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, at("00:00:00")), lte(aggMinute.ts, at("23:59:59"))));
    await db.delete(aggDay).where(eq(aggDay.date, DAY));
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200305"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    // TOKEN is a Pons token; OTHER_TOKEN is not, so it must never get a building.
    await db.insert(tokens).values([
      { address: TOKEN, symbol: "CITY", name: "City Test", isPons: true, createdAt: at("00:00:00") },
      { address: OTHER_TOKEN, symbol: "NOPE", name: "Not Pons", isPons: false },
    ]);
    await db.insert(ponsLaunches).values({ tokenAddress: TOKEN, creatorAddress: A, block: BASE, ts: at("00:00:00"), params: {} });
    // 10:00 is outside the 1h window anchored at 12:00:00; the rest is inside.
    await writeBatch(db, null, [
      bundle(BASE + 1, at("10:00:00"), [{ action: "swap", fee: "0.09", from: A }]),
      bundle(BASE + 2, at("11:30:00"), [
        { action: "swap", fee: "0.01", from: A, token: TOKEN },
        { action: "swap", fee: "0.03", from: B, token: TOKEN },
        { action: "approve", fee: "0.02", from: A, status: 0 },
        { action: "other", fee: "0.04", from: B, token: OTHER_TOKEN },
      ]),
      // The ArbOS internal transaction is unknown class; paid share must leave it out (Phase 8 D2, KL-7).
      bundle(BASE + 3, at("12:00:00"), [
        { action: "swap", fee: "0.05", from: B, token: TOKEN },
        { action: "contract_call", fee: "0", from: ARBOS_SENDER, cls: "unknown" },
        { action: "contract_call", fee: "0.02", from: A },
      ]),
    ]);
    await rollupMinutes(db, at("10:00:00"), at("12:00:00"));
    await rollupDays(db, [DAY]);
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  it("getCity builds one building per PROJECT.md 10.1 action plus the Pons district (1h, raw txs)", async () => {
    const city = await getCity(db, "1h", at("12:00:00"));
    expect(city.window).toMatchObject({ key: "1h", basis: "txs", end: at("12:00:00").toISOString() });
    expect(city.buildings.filter((b) => b.kind === "action").map((b) => b.key)).toEqual([
      "native_transfer", "erc20_transfer", "swap", "bridge", "launch", "approve", "contract_call",
    ]);
    const swap = city.buildings.find((b) => b.key === "swap");
    expect(swap).toMatchObject({ tx_count: 3, gas_volume: 300, wallets: 2, fail_rate: 0 });
    expect(swap?.avg_fee_usd).toBeCloseTo(0.03, 10);
    expect(city.buildings.find((b) => b.key === "approve")).toMatchObject({ tx_count: 1, fail_rate: 1 });
    expect(city.buildings.find((b) => b.key === "bridge")).toMatchObject({ tx_count: 0, avg_fee_usd: null, fail_rate: null });
    expect(city.other_tx_count).toBe(1);
    expect(city.n).toBe(7);
    const tokenBuildings = city.buildings.filter((b) => b.kind === "token");
    expect(tokenBuildings).toEqual([{ kind: "token", key: TOKEN, label: "CITY", tx_count: 3, gas_volume: 300, avg_fee_usd: expect.closeTo(0.03, 10), wallets: 2, fail_rate: null }]);
  });

  it("getCity reads agg_day for 7d, where wallets are not available", async () => {
    const city = await getCity(db, "7d", at("12:00:00"));
    expect(city.window).toMatchObject({ basis: "agg_day", start: "2020-02-28T00:00:00.000Z" });
    const swap = city.buildings.find((b) => b.key === "swap");
    expect(swap).toMatchObject({ tx_count: 4, wallets: null });
    expect(swap?.avg_fee_usd).toBeCloseTo((0.09 + 0.01 + 0.03 + 0.05) / 4, 10);
    expect(city.buildings.find((b) => b.kind === "token")).toMatchObject({ tx_count: 3, wallets: null });
  });

  it("getInspector returns values, change, trend and newest samples for an action", async () => {
    const insp = await getInspector(db, { kind: "action", key: "swap", window: "1h", ...live }, at("12:00:00"));
    expect(insp).not.toBeNull();
    expect(insp?.label).toBe("Swap");
    expect(insp?.values).toMatchObject({ tx_count: 3, wallets: 2, paid_share: 1 });
    // The window is [11:01, 12:01) and the previous hour [10:01, 11:01), so the 10:00:00 swap falls outside both.
    expect(insp?.previous).toEqual({ tx_count: 0, change: null });
    expect(insp?.trend.bucket).toBe("5m");
    expect(insp?.trend.points).toEqual([
      { ts: at("11:30:00").toISOString(), n: 2 },
      { ts: at("12:00:00").toISOString(), n: 1 },
    ]);
    expect(insp?.samples.map((s) => [s.ts, s.fee_usd])).toEqual([
      [at("12:00:00").toISOString(), 0.05],
      [at("11:30:00").toISOString(), 0.01],
      [at("11:30:00").toISOString(), 0.03],
    ]);
    expect(insp?.samples[0]?.explorer_url).toMatch(/^https:\/\/robinhoodchain\.blockscout\.com\/tx\/0xc1/);
  });

  it("paid share leaves ArbOS internal transactions out, on raw rows and on agg_day (Phase 8 D2)", async () => {
    // contract_call has 2 transactions: 1 ArbOS (unknown), 1 user paid. With ArbOS in the denominator it reads 0.5.
    for (const window of ["1h", "7d"] as const) {
      const insp = await getInspector(db, { kind: "action", key: "contract_call", window, ...live }, at("12:00:00"));
      expect(insp?.values, window).toMatchObject({ tx_count: 2, paid_share: 1 });
    }
    const day = await db.execute(sql`SELECT sum(system_tx_count) AS s FROM agg_day WHERE date = ${DAY}::date`);
    expect(Number((day.rows[0] as { s: unknown }).s)).toBe(1);
  });

  it("getInspector covers Pons tokens and rejects tokens that are not Pons", async () => {
    const insp = await getInspector(db, { kind: "token", key: TOKEN, window: "24h", ...live }, at("12:00:00"));
    expect(insp).toMatchObject({ label: "CITY", values: { tx_count: 3, fail_rate: null }, token: { symbol: "CITY", creator: A, launch_block: BASE } });
    expect(insp?.trend.points.map((p) => p.n)).toEqual([2, 1]);
    expect(await getInspector(db, { kind: "token", key: OTHER_TOKEN, window: "24h", ...live }, at("12:00:00"))).toBeNull();
  });
});
