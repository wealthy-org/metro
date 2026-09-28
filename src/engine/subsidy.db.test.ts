import { existsSync } from "node:fs";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { BlockBundle } from "../collector/ingest.ts";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, ponsLaunches, tokens, tokenTransfers, txs } from "../db/schema.ts";
import { compareTokens } from "../server/compare.ts";
import { computeSubsidy, windowFigures } from "./subsidy.ts";

// Subsidy Cliff figures against direct SQL on a fixture (Phase 8 verification; PROJECT.md 12.3). Opt in with
// RUN_DB_TESTS=1. Fixture days 2020-03-10 (before) and 2020-03-11 (after) in their own block range, removed afterwards;
// visible to the production site for the few seconds the test runs (KL-22).
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 918_000_000_000;
const at = (d: string, t: string) => new Date(`2020-03-${d}T${t}Z`);
const TOKEN = "0x00000000000000000000000000000000000d8001";
const TOKEN2 = "0x00000000000000000000000000000000000d8002";
const POOL = "0x00000000000000000000000000000000000d80a1";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const BOT = "0x00000000000000000000000000000000000000c3";
const ROUTER = "0x00000000000000000000000000000000000000d4";
const hashOf = (n: number, i: number) => `0xf8${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`;

type Spec = { action: "swap" | "approve" | "contract_call"; fee: string; from: string; to?: string; method?: string; cls?: "likely_paid" | "likely_subsidized" | "unknown"; token?: string };

function bundle(n: number, ts: Date, specs: Spec[]): BlockBundle {
  // Every block starts with the ArbOS internal transaction (KL-7).
  const all: Spec[] = [{ action: "contract_call", fee: "0", from: ARBOS_SENDER, cls: "unknown" }, ...specs];
  return {
    block: { number: n, hash: `0xf9${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: all.length },
    txs: all.map((s, i) => ({
      hash: hashOf(n, i),
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: s.to ?? null,
      value: "0",
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: 1,
      method: s.method ?? null,
      action: s.action,
      subsidyClass: s.cls ?? "likely_paid",
    })),
    transfers: all.flatMap((s, i) => (s.token ? [{ txHash: hashOf(n, i), logIndex: 0, tokenAddress: s.token, fromAddress: POOL, toAddress: s.from, amount: "5", ts }] : [])),
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("Subsidy Cliff figures equal direct SQL (PROJECT.md 12.3)", () => {
  let db: Db;
  let end: () => Promise<void>;
  const before = { start: at("10", "00:00:00"), end: at("11", "00:00:00") };
  const after = { start: at("11", "00:00:00"), end: at("12", "00:00:00") };

  async function cleanup() {
    await db.delete(tokenTransfers).where(inArray(tokenTransfers.tokenAddress, [TOKEN, TOKEN2]));
    await db.delete(ponsLaunches).where(inArray(ponsLaunches.tokenAddress, [TOKEN, TOKEN2]));
    await db.delete(tokens).where(inArray(tokens.address, [TOKEN, TOKEN2]));
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, before.start), lte(aggMinute.ts, after.end)));
    await db.delete(aggDay).where(sql`date IN ('2020-03-10'::date, '2020-03-11'::date)`);
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200310"`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200311"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    await db.insert(tokens).values([
      { address: TOKEN, symbol: "SPLA", name: "Split A", isPons: true, createdAt: at("10", "00:00:00") },
      { address: TOKEN2, symbol: "SPLB", name: "Split B", isPons: true, createdAt: at("10", "00:00:00") },
    ]);
    await db.insert(ponsLaunches).values([
      { tokenAddress: TOKEN, creatorAddress: A, block: BASE + 1, ts: at("10", "01:00:00"), params: { topic2: POOL } },
      { tokenAddress: TOKEN2, creatorAddress: B, block: BASE + 1, ts: at("10", "01:00:00"), params: { topic2: POOL } },
    ]);
    // Before: 2 blocks. A bot-like sender makes 20 identical calls; A swaps; one subsidized approve by B.
    const botCalls: Spec[] = Array.from({ length: 20 }, () => ({ action: "contract_call", fee: "0.001", from: BOT, to: ROUTER, method: "0x12345678" }));
    await writeBatch(db, null, [
      bundle(BASE + 1, at("10", "02:00:00"), [...botCalls.slice(0, 10), { action: "swap", fee: "0.02", from: A, token: TOKEN }, { action: "approve", fee: "0.001", from: B, cls: "likely_subsidized" }]),
      bundle(BASE + 2, at("10", "14:00:00"), [...botCalls.slice(10), { action: "swap", fee: "0.04", from: A, token: TOKEN2 }]),
      // After: 1 block, A swaps twice, B swaps once.
      bundle(BASE + 3, at("11", "02:00:00"), [{ action: "swap", fee: "0.03", from: A, token: TOKEN }, { action: "swap", fee: "0.05", from: A }, { action: "swap", fee: "0.01", from: B, token: TOKEN }]),
    ]);
    await rollupMinutes(db, before.start, after.end);
    await rollupDays(db, ["2020-03-10", "2020-03-11"]);
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  const q = async (query: ReturnType<typeof sql>) => ((await db.execute(query)).rows[0] ?? {}) as Record<string, unknown>;

  it("rates, paid share without ArbOS, classes and medians equal SQL over the covered blocks", async () => {
    const now = at("12", "00:00:00");
    const f = await windowFigures(db, before, 864_000, now);
    const r = await q(sql`
      SELECT count(*) AS n, count(*) FILTER (WHERE from_address = ${ARBOS_SENDER}) AS sys,
             count(*) FILTER (WHERE subsidy_class = 'likely_paid' AND from_address <> ${ARBOS_SENDER}) AS paid,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS med
      FROM txs WHERE ts >= ${before.start} AND ts < ${before.end}`);
    expect(f).toMatchObject({ blocks_covered: 2, tx: Number(r.n), system_tx: 2, user_tx: 23, tx_per_block: 12.5, days_with_data: 1, days_ended: 1, sampled: true });
    expect(f.paid_share).toBeCloseTo(Number(r.paid) / (Number(r.n) - Number(r.sys)), 12);
    expect(f.paid_share).toBeCloseTo(22 / 23, 12);
    expect(f.classes).toEqual({ likely_subsidized: 1, likely_paid: 22, unknown: 0 });
    expect(f.median_fee_usd).toBe(Number(r.med));
    expect(f.est_tx_per_day).toBeCloseTo(12.5 * 864_000, 6);
    expect(f.actions.find((a) => a.key === "swap")).toMatchObject({ tx: 2, tx_per_block: 1, median_fee_usd: 0.02 });
  });

  it("flags the bot pattern as a heuristic rate and never measures retention from samples", async () => {
    const f = await windowFigures(db, before, 864_000, at("12", "00:00:00"));
    // Sender-days: BOT, A, B; only BOT has 20 calls, all to one contract and method.
    expect(f.bot).toMatchObject({ sender_days: 3, bot_sender_days: 1 });
    expect(f.bot.tx_share).toBeCloseTo(20 / 23, 12);
    const r = await computeSubsidy(db, before, after, before.end, at("12", "00:00:00"));
    expect(r.retention.value).toBeNull();
    expect(r.retention.reason).toMatch(/^Not measurable from sampled blocks/);
    expect(r.after).toMatchObject({ tx_per_block: 4, days_ended: 1 });
  });

  it("compares two Pons tokens over one window", async () => {
    const c = await compareTokens(db, { start: before.start, end: after.end }, TOKEN, TOKEN2);
    expect(c.a).toMatchObject({ symbol: "SPLA", tx: 3, swaps: 3, senders: 2 });
    expect(c.b).toMatchObject({ symbol: "SPLB", tx: 1, swaps: 1, senders: 1 });
    expect(c.a?.median_fee_usd).toBe(0.02);
  });
});
