import { existsSync } from "node:fs";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { BlockBundle } from "../collector/ingest.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { blocks, tokenTransfers, txs } from "../db/schema.ts";
import { NO_FILTERS } from "../lib/view-state.ts";
import { getInspector, parseInspectorParams } from "./city.ts";
import type { CodeReader } from "./code.ts";
import { getGraph, getWalletGraph, type GraphParams } from "./graph.ts";

// Graph lens and wallet ego graph against direct SQL on a fixture (Phase 9 verification; PROJECT.md 10.4, 15, AT 13).
// Opt in with RUN_DB_TESTS=1. Data lives on 2020-03-12 in its own block range and is removed afterwards.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 919_000_000_000;
const at = (t: string) => new Date(`2020-03-12T${t}Z`);
const F = "0x00000000000000000000000000000000000000f1"; // funds W1, W2, W3
const W1 = "0x00000000000000000000000000000000000000a1";
const W2 = "0x00000000000000000000000000000000000000a2";
const W3 = "0x00000000000000000000000000000000000000a3";
const R = "0x00000000000000000000000000000000000000c1"; // called with input data: a contract
const POOL = "0x00000000000000000000000000000000000b0001"; // only ever seen in token transfers, like a pool
const TK = "0x00000000000000000000000000000000000d9001";
const ETH = 10n ** 18n;
// No network in tests: the chain's answer about contract code is injected (Phase 9 gate F67).
const noCode: CodeReader = async () => new Map();

type Spec = { action: "native_transfer" | "contract_call" | "erc20_transfer"; from: string; to: string; value: bigint; fee: string; method?: string; token?: boolean; tokenFrom?: string; tokenTo?: string; failed?: boolean };

function bundle(n: number, ts: Date, specs: Spec[]): BlockBundle {
  const all: Spec[] = [{ action: "contract_call", from: ARBOS_SENDER, to: R, value: 0n, fee: "0" }, ...specs];
  const hash = (i: number) => `0xd1${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`;
  return {
    block: { number: n, hash: `0xd2${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: all.length },
    txs: all.map((s, i) => ({
      hash: hash(i),
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: s.to,
      value: s.value.toString(),
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: s.failed ? 0 : 1,
      method: s.method ?? null,
      action: s.action,
      subsidyClass: "likely_paid",
    })),
    transfers: all.flatMap((s, i) => (s.token ? [{ txHash: hash(i), logIndex: 0, tokenAddress: TK, fromAddress: s.tokenFrom ?? s.from, toAddress: s.tokenTo ?? s.to, amount: "5", ts }] : [])),
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("graph reads equal direct SQL (Phase 9)", () => {
  let db: Db;
  let end: () => Promise<void>;
  const anchor = at("11:00:00");
  const params = (over: Partial<GraphParams> = {}): GraphParams => ({ window: "24h", filters: NO_FILTERS, at: null, mode: "top", addr: null, token: null, hops: 1, ...over });

  async function cleanup() {
    await db.delete(tokenTransfers).where(eq(tokenTransfers.tokenAddress, TK));
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200312"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
    await writeBatch(db, null, [
      bundle(BASE + 1, at("10:00:00"), [
        { action: "native_transfer", from: F, to: W1, value: ETH, fee: "0.01" },
        { action: "native_transfer", from: F, to: W2, value: 2n * ETH, fee: "0.01" },
        { action: "native_transfer", from: F, to: W3, value: ETH, fee: "0.01" },
        { action: "contract_call", from: W1, to: R, value: ETH / 2n, fee: "0.02", method: "0xabcd1234" },
      ]),
      bundle(BASE + 2, at("10:01:00"), [
        { action: "native_transfer", from: W2, to: W1, value: ETH / 10n, fee: "0.03" },
        { action: "native_transfer", from: W1, to: W2, value: ETH / 10n, fee: "0.04" },
        { action: "erc20_transfer", from: W1, to: W3, value: 0n, fee: "0.03", token: true },
        // A failed transaction moves no value: it must not draw an edge or fund a group.
        { action: "native_transfer", from: W3, to: W1, value: ETH, fee: "0.01", failed: true },
        // The pool sends tokens to W2 inside W2's own transaction; the pool itself never sends a transaction.
        { action: "erc20_transfer", from: W2, to: R, value: 0n, fee: "0.02", token: true, tokenFrom: POOL, tokenTo: W2 },
      ]),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  const one = async (query: ReturnType<typeof sql>) => ((await db.execute(query)).rows[0] ?? {}) as Record<string, unknown>;

  it("top view: nodes, edges, transfer count and average fee equal SQL; ArbOS is left out", async () => {
    const g = await getGraph(db, params(), anchor, undefined, noCode);
    const sqlEdges = await one(sql`
      SELECT count(*) AS edges, sum(n) AS n FROM (
        SELECT from_address, to_address, count(*) AS n FROM (
          SELECT from_address, to_address FROM txs WHERE block BETWEEN ${BASE} AND ${BASE + 100} AND status = 1 AND value > 0 AND from_address <> ${ARBOS_SENDER}
          UNION ALL SELECT from_address, to_address FROM token_transfers WHERE token_address = ${TK}) x GROUP BY 1, 2) y`);
    expect(g.edges).toHaveLength(Number(sqlEdges.edges));
    expect(g.n).toBe(Number(sqlEdges.n));
    expect(g.nodes.map((n) => n.id).sort()).toEqual([F, POOL, R, W1, W2, W3].sort());
    expect(g.nodes.some((n) => n.id === ARBOS_SENDER)).toBe(false);
    const fee = await one(sql`SELECT count(*) AS n, avg(fee_usd) AS fee FROM txs WHERE from_address = ${W1}`);
    const w1 = g.nodes.find((n) => n.id === W1);
    expect(w1?.tx_sent).toBe(Number(fee.n));
    expect(w1?.avg_fee_usd).toBeCloseTo(Number(fee.fee), 10);
    expect(g.nodes.find((n) => n.id === F)?.transfers).toBe(3);
    expect(g.trimmed).toBe(false);
    expect(g.blocks?.covered).toBe(2);
    // The failed W3 to W1 transfer draws nothing (with it there would be 9 edges).
    expect(g.edges.some((e) => g.nodes[e.s]?.id === W3 && g.nodes[e.t]?.id === W1)).toBe(false);
    const failedOnly = await getGraph(db, params({ filters: { ...NO_FILTERS, status: "failed" } }), anchor, undefined, noCode);
    expect(failedOnly.nodes).toHaveLength(0);
  });

  it("marks a contract only when Metro knows it, and groups wallets funded by the same address (D1)", async () => {
    const g = await getGraph(db, params(), anchor, undefined, noCode);
    expect(g.nodes.find((n) => n.id === R)?.kind).toBe("contract");
    expect(g.nodes.find((n) => n.id === W1)?.kind).toBe("address");
    for (const id of [W1, W2, W3]) expect(g.nodes.find((n) => n.id === id)?.cluster).toBe(F);
    expect(g.nodes.find((n) => n.id === F)?.cluster).toBeNull();
    expect(g.nodes.find((n) => n.id === R)?.cluster).toBeNull();
    expect(g.clusters).toEqual([{ funder: F, size: 3, shown: 3 }]);
  });

  it("AT 13: a lowered cap shows exactly the cap and states the exact total", async () => {
    const g = await getGraph(db, params(), anchor, 3, noCode);
    expect(g.nodes).toHaveLength(3);
    expect(g.total_nodes).toBe(6);
    expect(g.trimmed).toBe(true);
    expect(g.cap).toBe(3);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(g.nodes[e.s]?.id ?? "") && ids.has(g.nodes[e.t]?.id ?? ""))).toBe(true);
    const full = await getGraph(db, params(), anchor, undefined, noCode);
    expect(full.trimmed).toBe(false);
  });

  it("ego graph: one hop and two hops, center first", async () => {
    const one1 = await getGraph(db, params({ mode: "ego", addr: R }), anchor, undefined, noCode);
    expect(one1.center).toBe(R);
    expect(one1.nodes.map((n) => n.id).sort()).toEqual([R, W1].sort());
    expect(one1.edges).toHaveLength(1);
    const two = await getGraph(db, params({ mode: "ego", addr: R, hops: 2 }), anchor, undefined, noCode);
    expect(two.nodes).toHaveLength(5);
    expect(two.edges).toHaveLength(5);
    const w1 = await getGraph(db, params({ mode: "ego", addr: W1 }), anchor, undefined, noCode);
    expect(w1.nodes[0]?.id).toBe(W1);
    expect(w1.total_nodes).toBe(5);
  });

  it("token flow follows one token only", async () => {
    const g = await getGraph(db, params({ mode: "token", token: TK }), anchor, undefined, noCode);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([POOL, W1, W2, W3].sort());
    expect(g.edges).toHaveLength(2);
    expect(g.n).toBe(2);
    expect(g.tokens.some((t) => t.address === TK && t.n === 2)).toBe(true);
  });

  it("a window before the data is empty, not an error", async () => {
    const g = await getGraph(db, params({ window: "1h" }), at("06:00:00"), undefined, noCode);
    expect(g.nodes).toHaveLength(0);
    expect(g.total_nodes).toBe(0);
    expect(g.trimmed).toBe(false);
  });

  it("the Inspector reads an address: figures equal SQL, group and kind included", async () => {
    const p = parseInspectorParams(new URLSearchParams(`kind=address&key=${W1}&window=24h`));
    expect(typeof p).not.toBe("string");
    if (typeof p === "string") return;
    const insp = await getInspector(db, p, anchor, noCode);
    const sqlRow = await one(sql`
      SELECT count(*) AS n, count(*) FILTER (WHERE from_address = ${W1}) AS sent, count(*) FILTER (WHERE to_address = ${W1}) AS received,
             sum(fee_usd) FILTER (WHERE from_address = ${W1}) AS fee_sum
      FROM txs WHERE block BETWEEN ${BASE} AND ${BASE + 100} AND (from_address = ${W1} OR to_address = ${W1})`);
    expect(insp?.kind).toBe("address");
    expect(insp?.values.tx_count).toBe(Number(sqlRow.n));
    expect(insp?.address).toMatchObject({ kind: "address", sent: Number(sqlRow.sent), received: Number(sqlRow.received), group: { funder: F, size: 3 }, native_transfers: { in: 2, out: 2 }, token_transfers: { in: 0, out: 1 } });
    expect(insp?.address?.fee_paid_usd).toBeCloseTo(Number(sqlRow.fee_sum), 10);
    expect(insp?.samples.length).toBeGreaterThan(0);
    expect(parseInspectorParams(new URLSearchParams("kind=address&key=0x1"))).toMatch(/address/);
    expect(parseInspectorParams(new URLSearchParams(`kind=address&key=${W1}&window=7d`))).toMatch(/24 h or less/);
  });

  it("an address that only appears in token transfers still has transactions in the Inspector", async () => {
    const p = parseInspectorParams(new URLSearchParams(`kind=address&key=${POOL}&window=24h`));
    if (typeof p === "string") throw new Error(p);
    const insp = await getInspector(db, p, anchor, noCode);
    expect(insp?.values.tx_count).toBe(1);
    expect(insp?.address).toMatchObject({ sent: 0, received: 0, token_transfers: { in: 0, out: 1 } });
    expect(insp?.samples).toHaveLength(1);
    expect(insp?.trend.points.reduce((s, x) => s + x.n, 0)).toBe(1);
  });

  it("F67: a contract confirmed by the chain is a contract with no group; the center is asked first, at most 60 are asked", async () => {
    const asked: string[][] = [];
    const chain: CodeReader = async (list) => {
      asked.push(list);
      return new Map(list.map((a) => [a, a === W3 || a === POOL]));
    };
    const g = await getGraph(db, params(), anchor, undefined, chain);
    expect(g.nodes.find((n) => n.id === POOL)?.kind).toBe("contract");
    expect(g.nodes.find((n) => n.id === W3)).toMatchObject({ kind: "contract", cluster: null });
    expect(g.nodes.find((n) => n.id === W1)?.kind).toBe("address");
    expect(g.code_checked).toBe(6);
    // W3 left its group: two wallets remain funded by F.
    expect(g.clusters).toEqual([{ funder: F, size: 3, shown: 2 }]);
    asked.length = 0;
    await getGraph(db, params({ mode: "ego", addr: R }), anchor, undefined, chain);
    expect(asked[0]?.[0]).toBe(R);
    expect(asked[0]?.length).toBeLessThanOrEqual(60);
    const wallet = await getWalletGraph(db, W1, undefined, chain);
    expect(wallet.nodes.find((n) => n.id === POOL)).toBeUndefined();
    expect(wallet.nodes.find((n) => n.id === W3)?.kind).toBe("contract");
    // The Inspector asks the chain for its own address.
    const p = parseInspectorParams(new URLSearchParams(`kind=address&key=${POOL}&window=24h`));
    if (typeof p === "string") throw new Error(p);
    expect((await getInspector(db, p, anchor, chain))?.address?.kind).toBe("contract");
    expect((await getInspector(db, p, anchor, noCode))?.address?.kind).toBe("address");
  });

  it("the wallet graph covers that wallet's transfers in the ingested data", async () => {
    const g = await getWalletGraph(db, W1, undefined, noCode);
    expect(g.mode).toBe("wallet");
    expect(g.center).toBe(W1);
    expect(g.nodes[0]?.id).toBe(W1);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([F, R, W1, W2, W3].sort());
    expect(g.n).toBe(5);
    expect(g.window.start).toBe(at("10:00:00").toISOString());
    expect(g.window.end).toBe(at("10:01:00").toISOString());
    const none = await getWalletGraph(db, "0x00000000000000000000000000000000000000ee", undefined, noCode);
    expect(none.nodes).toHaveLength(0);
  });
});
