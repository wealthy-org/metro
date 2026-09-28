import { existsSync } from "node:fs";
import { and, gte, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { BlockBundle } from "../collector/ingest.ts";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, txs } from "../db/schema.ts";
import { computeFacts, engineWindows, type FactDraft } from "./facts.ts";

// Fact engine against the Neon dev branch (Phase 7 verification: every fact equals a direct SQL query). Opt in with
// RUN_DB_TESTS=1. Fixture day 2020-03-09, own block range, removed afterwards; visible to the production site for
// the few seconds the test runs (KL-22). computeFacts is called with the fixture's own anchor, so the real insights
// are not touched.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 917_000_000_000;
const DAY = "2020-03-09";
const at = (hhmmss: string) => new Date(`${DAY}T${hhmmss}Z`);
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const hashOf = (n: number, i: number) => `0xe7${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`;

type Spec = { action: "swap" | "approve" | "contract_call"; fee: string; from: string; status?: number };

function bundle(n: number, ts: Date, specs: Spec[], gasUsed = "100", gasLimit = "1000"): BlockBundle {
  return {
    block: { number: n, hash: `0xe8${n.toString(16).padStart(62, "0")}`, ts, gasUsed, gasLimit, baseFee: "20000000", txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: hashOf(n, i),
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
      subsidyClass: "likely_paid",
    })),
    transfers: [],
    tokens: [],
    launches: [],
  };
}

const one = (facts: FactDraft[], key: string, start?: Date) => facts.find((f) => f.key === key && (!start || f.start.getTime() === start.getTime()));

describe.skipIf(!enabled)("fact engine equals direct SQL (PROJECT.md 13.1)", () => {
  let db: Db;
  let end: () => Promise<void>;
  let facts: FactDraft[] = [];
  const anchor = at("12:00:30");
  const w = engineWindows(anchor, new Date("2026-09-29T00:00:00Z"));

  async function cleanup() {
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, at("00:00:00")), lte(aggMinute.ts, at("23:59:59"))));
    await db.delete(aggDay).where(sql`date = ${DAY}::date`);
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200309"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    // 10:xx: three swaps (fees 0.01, 0.03, 0.02), one full block. 11:xx: two swaps, an approve, a failed contract call
    // and the ArbOS system transaction. 12:00: the anchor block, one more swap by A.
    await writeBatch(db, null, [
      bundle(BASE + 1, at("10:10:00"), [{ action: "swap", fee: "0.01", from: A }, { action: "swap", fee: "0.03", from: B }, { action: "swap", fee: "0.02", from: A }], "950", "1000"),
      bundle(BASE + 2, at("11:20:00"), [
        { action: "swap", fee: "0.05", from: A },
        { action: "swap", fee: "0.04", from: A },
        { action: "approve", fee: "0.002", from: B },
        { action: "contract_call", fee: "0.001", from: B, status: 0 },
        { action: "contract_call", fee: "0", from: ARBOS_SENDER },
      ]),
      bundle(BASE + 3, anchor, [{ action: "swap", fee: "0.06", from: A }]),
    ]);
    await rollupMinutes(db, at("10:00:00"), anchor);
    await rollupDays(db, [DAY]);
    facts = (await computeFacts(db, w)).facts;
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  const q = async (query: ReturnType<typeof sql>) => ((await db.execute(query)).rows[0] ?? {}) as Record<string, unknown>;

  it("median swap fee per clock hour equals percentile_disc over the same hour", async () => {
    const hour = at("10:00:00");
    const f = one(facts, "median_fee_usd.swap.hour", hour);
    const r = await q(sql`SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS m, count(*) AS n FROM txs WHERE action = 'swap' AND ts >= ${hour} AND ts < ${at("11:00:00")}`);
    expect(f).toMatchObject({ value: Number(r.m), n: Number(r.n) });
    expect(f?.value).toBe(0.02);
  });

  it("median fee per action and fail rate equal SQL over the lenses' windows", async () => {
    const swap = one(facts, "median_fee_usd.swap");
    const r = await q(sql`SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS m, count(*) AS n FROM txs WHERE action = 'swap' AND ts >= ${w.w24.start} AND ts < ${w.w24.end}`);
    expect(swap).toMatchObject({ value: Number(r.m), n: 6 });
    const fail = one(facts, "fail_rate.all", w.w1.start);
    const f = await q(sql`SELECT count(*) FILTER (WHERE status = 0)::float / count(*) AS v, count(*) AS n FROM txs WHERE ts >= ${w.w1.start} AND ts < ${w.w1.end}`);
    expect(fail).toMatchObject({ value: Number(f.v), n: Number(f.n) });
    expect(one(facts, "fail_rate.contract_call")?.value).toBe(0.5);
  });

  it("counts full blocks and action shares like SQL, and leaves the ArbOS sender out of wallet shares", async () => {
    expect(one(facts, "full_blocks")).toMatchObject({ value: 1, n: 3 });
    const share = one(facts, "action_share.swap", w.w24.start);
    const s = await q(sql`SELECT (SELECT sum(tx_count) FROM agg_minute WHERE action = 'swap' AND ts >= ${w.w24.start} AND ts < ${w.w24.end})::float / sum(tx_count) AS v, sum(tx_count) AS n FROM agg_minute WHERE ts >= ${w.w24.start} AND ts < ${w.w24.end}`);
    expect(share).toMatchObject({ value: Number(s.v), n: Number(s.n) });
    // Swaps: A sent 5 of 6. Contract calls: B sent the only non-system one, so its share is 1 of 1.
    expect(one(facts, `wallet_share.swap.${A}`)).toMatchObject({ value: 5 / 6, n: 6 });
    expect(one(facts, `wallet_share.contract_call.${B}`)).toMatchObject({ value: 1, n: 1 });
    expect(facts.some((f) => f.key.includes(ARBOS_SENDER))).toBe(false);
  });

  it("averages base fee per hour like the Heatmap gas cell", async () => {
    const f = one(facts, "base_fee_gwei.hour", at("11:00:00"));
    expect(f).toMatchObject({ value: 0.02, n: 1 });
    expect(one(facts, "base_fee_gwei.median_hourly")).toMatchObject({ value: 0.02, n: 3 });
  });
});
