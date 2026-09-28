import { existsSync } from "node:fs";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockBundle } from "../collector/ingest.ts";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, ponsLaunches, tokens, tokenTransfers, txs } from "../db/schema.ts";
import { NO_FILTERS } from "../lib/view-state.ts";
import { getFlow } from "./flow.ts";
import { holderStats, ponsNonHolders } from "./holders.ts";
import { getLaunchpad } from "./launchpad.ts";
import { getTx } from "./tx.ts";

// Phase 6 reads against the Neon dev branch (gate F38). Opt in with RUN_DB_TESTS=1. While they run (a few seconds)
// the fixture day 2020-03-07 is visible to the production site, which reads the same branch (KL-22); it is removed
// afterwards. Block numbers sit in their own range, and every read passes an explicit anchor or scrubber time.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 916_000_000_000;
const DAY = "2020-03-07";
const at = (hhmmss: string) => new Date(`${DAY}T${hhmmss}Z`);
const ZERO = "0x0000000000000000000000000000000000000000";
const TOKEN = "0x00000000000000000000000000000000000d6001"; // launched at BASE + 1, every block since ingested
const LATE = "0x00000000000000000000000000000000000d6002"; // launched at BASE, which is not ingested
const POOL = "0x00000000000000000000000000000000000d60a1";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const hashOf = (n: number, i: number) => `0xd6${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`;

type Move = { token: string; from: string; to: string; amount: string };
type Spec = { action: "swap" | "erc20_transfer" | "launch"; fee: string; from: string; moves: Move[] };

function bundle(n: number, ts: Date, specs: Spec[]): BlockBundle {
  return {
    block: { number: n, hash: `0xd7${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: hashOf(n, i),
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: POOL,
      value: "0",
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: 1,
      method: null,
      action: s.action,
      subsidyClass: "likely_paid",
    })),
    transfers: specs.flatMap((s, i) => s.moves.map((m, j) => ({ txHash: hashOf(n, i), logIndex: j, tokenAddress: m.token, fromAddress: m.from, toAddress: m.to, amount: m.amount, ts }))),
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("Phase 6 reads: holders, Launchpad, Flow replay, /tx (PROJECT.md 10.3, 10.6, 15)", () => {
  let db: Db;
  let end: () => Promise<void>;

  async function cleanup() {
    await db.delete(tokenTransfers).where(inArray(tokenTransfers.tokenAddress, [TOKEN, LATE]));
    await db.delete(ponsLaunches).where(inArray(ponsLaunches.tokenAddress, [TOKEN, LATE]));
    await db.delete(tokens).where(inArray(tokens.address, [TOKEN, LATE]));
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, at("00:00:00")), lte(aggMinute.ts, at("23:59:59"))));
    await db.delete(aggDay).where(sql`date = ${DAY}::date`);
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200307"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    await db.insert(tokens).values([
      { address: TOKEN, symbol: "SIX", name: "Phase Six", isPons: true, createdAt: at("10:00:00") },
      { address: LATE, symbol: "LATE", name: "Partly ingested", isPons: true, createdAt: at("09:00:00") },
    ]);
    await db.insert(ponsLaunches).values([
      { tokenAddress: TOKEN, creatorAddress: A, block: BASE + 1, ts: at("10:00:00"), params: { topic2: POOL } },
      { tokenAddress: LATE, creatorAddress: B, block: BASE, ts: at("09:00:00"), params: { topic2: POOL } },
    ]);
    // Launch mints 100 to the pool; two buys take 20 to A and 10 to B. Balances: pool 70, A 20, B 10.
    await writeBatch(db, null, [
      bundle(BASE + 1, at("10:00:00"), [{ action: "launch", fee: "0.05", from: A, moves: [{ token: TOKEN, from: ZERO, to: POOL, amount: "100" }] }]),
      bundle(BASE + 2, at("11:00:00"), [{ action: "swap", fee: "0.01", from: A, moves: [{ token: TOKEN, from: POOL, to: A, amount: "20" }] }]),
      bundle(BASE + 3, at("11:30:00"), [
        { action: "swap", fee: "0.03", from: B, moves: [{ token: TOKEN, from: POOL, to: B, amount: "10" }] },
        { action: "erc20_transfer", fee: "0.02", from: B, moves: [{ token: LATE, from: ZERO, to: B, amount: "5" }] },
      ]),
    ]);
    await rollupMinutes(db, at("10:00:00"), at("11:30:00"));
    await rollupDays(db, [DAY]);
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  it("counts holders and leaves the curve pool out of the top ten (D1, KL-25)", async () => {
    const h = await holderStats(db, TOKEN, BASE + 1, at("12:00:00"), ponsNonHolders(POOL));
    expect(h).toMatchObject({ holders: 3, top10_share: 0.3, pool_share: 0.7, complete: true, blocks_ingested: 3, blocks_expected: 3 });
    // Without the exclusion the pool is the largest holder, as it was before KL-25.
    expect((await holderStats(db, TOKEN, BASE + 1, at("12:00:00"))).top10_share).toBe(1);
    // 24 h earlier nothing existed; at 10:30 only the pool held the token.
    expect(h.holders_24h_ago).toBe(0);
    expect(await holderStats(db, TOKEN, BASE + 1, at("10:30:00"), ponsNonHolders(POOL))).toMatchObject({ holders: 1, top10_share: 0, pool_share: 1 });
  });

  it("marks holders partial when blocks since the launch are missing", async () => {
    const h = await holderStats(db, LATE, BASE, at("12:00:00"), ponsNonHolders(POOL));
    expect(h).toMatchObject({ holders: 1, complete: false, blocks_ingested: 3, blocks_expected: 4 });
  });

  it("builds Launchpad rows equal to the fixture (10.6)", async () => {
    const lp = await getLaunchpad(db, { window: "24h", filters: NO_FILTERS, live: false }, at("12:00:00"));
    expect(lp.recent).toBeNull();
    const six = lp.tokens.find((t) => t.address === TOKEN);
    expect(six).toMatchObject({ source: "ingested", symbol: "SIX", launch_block: BASE + 1, tx_count: 3, swaps: 2, concentrated: false });
    expect(six?.avg_fee_usd).toBeCloseTo(0.03, 10);
    expect(six?.daily.at(-1)).toEqual({ date: DAY, n: 3 });
    expect(six?.holders?.top10_share).toBe(0.3);
    // Newest first.
    expect(lp.tokens.map((t) => t.address).slice(0, 2)).toEqual([TOKEN, LATE]);
  });

  it("replays the ingested blocks at the scrubber time (Phase 6 D3)", async () => {
    const f = await getFlow(db, { filters: NO_FILTERS, at: "2020-03-07T11:45Z" });
    expect(f.source).toBe("ingested");
    expect(f.blocks).toEqual({ first: BASE + 1, last: BASE + 3 });
    expect(f.rows.map((r) => r.hash)).toEqual([hashOf(BASE + 3, 0), hashOf(BASE + 3, 1), hashOf(BASE + 2, 0), hashOf(BASE + 1, 0)]);
    expect(f.rows[0]).toMatchObject({ action: "swap", tokens: [TOKEN], fee_usd: 0.03 });
    const failedOnly = await getFlow(db, { filters: { ...NO_FILTERS, status: "failed" }, at: "2020-03-07T11:45Z" });
    expect(failedOnly.rows).toEqual([]);
  });

  it("reads an ingested transaction for /tx with its transfers and lens links", async () => {
    const t = await getTx(db, hashOf(BASE + 2, 0));
    expect(t).toMatchObject({ source: "ingested", block: BASE + 2, action: "swap", fee_usd: 0.01, fee_usd_basis: "minute", status: "success" });
    expect(t?.transfers).toEqual([{ log_index: 0, token: TOKEN, symbol: "SIX", is_pons: true, from: POOL, to: A, amount: expect.any(String), amount_is_raw: false }]);
    expect(t?.positions.map((p) => p.lens)).toEqual(["City", "Heatmap", "Flow"]);
    expect(t?.positions[0]?.href).toContain("at=2020-03-07T11:00Z");
  });
});
