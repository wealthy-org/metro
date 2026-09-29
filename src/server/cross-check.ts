import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { blocksPerDay } from "../engine/subsidy.ts";
import { createRpcClient, type RpcClient } from "../collector/rpc.ts";
import { num, rows } from "./query.ts";

// Accuracy cross-check (PROJECT.md 19 and 22 AT 6; Phase 13 D1, option (c) decided 2026-09-29). Read-only: nothing is
// stored. Per stored sampled day it compares
//  - the estimate the stored fixed-offset slices give (KL-28; biased upward, KL-37), with its own 95% CI from the
//    per-block spread of the stored sample,
//  - a fresh uniform random sample of single blocks over RPC (eth_getBlockTransactionCountByNumber), the reference
//    rate, with its 95% CI so the tolerance is stated from measurement,
//  - growthepie's per-day txcount (GROWTHEPIE_API_URL, fundamentals.json, origin_key robinhood).
// Metro's totals include the ArbOS internal transaction per block (KL-7), so its share is shown beside the difference.

export type CrossCheckDay = {
  day: string;
  stored: { blocks: number; tx: number; txPerBlock: number; estimate: number; ci95: number };
  random: { n: number; avgTxPerBlock: number; estimate: number; ci95: number } | null;
  growthepie: number | null;
  arbosShare: number | null;
  storedVsRandomPct: number | null;
  storedVsGtpPct: number | null;
};

export type CrossCheckResult = {
  k: number;
  blocksPerDay: number | null;
  growthepieAvailable: boolean;
  days: CrossCheckDay[];
  generatedAt: string;
};

const round = (v: number, digits = 3) => Number(v.toFixed(digits));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length));
};

// Deterministic picks per day, so repeated runs and /data views agree.
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export async function growthepieTxcount(): Promise<Map<string, number>> {
  const base = (process.env.GROWTHEPIE_API_URL ?? "https://api.growthepie.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/fundamentals.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`growthepie HTTP ${res.status}`);
  const body: unknown = await res.json();
  const out = new Map<string, number>();
  if (!Array.isArray(body)) throw new Error("growthepie body is not an array");
  for (const row of body) {
    const r = row as { metric_key?: unknown; origin_key?: unknown; date?: unknown; value?: unknown };
    if (r.metric_key === "txcount" && r.origin_key === "robinhood" && typeof r.date === "string" && typeof r.value === "number") out.set(r.date, r.value);
  }
  return out;
}

async function randomSample(client: RpcClient, lo: number, hi: number, k: number, seed: string): Promise<number[] | null> {
  if (!(hi > lo) || k <= 0) return null;
  const rand = seeded(seed);
  const picks = Array.from({ length: k }, () => lo + Math.floor(rand() * (hi - lo + 1)));
  const counts: number[] = [];
  for (let i = 0; i < picks.length; i += 8) {
    const chunk = picks.slice(i, i + 8);
    const got = await Promise.all(chunk.map((n) => client.getBlockTransactionCount({ blockNumber: BigInt(n) }).catch(() => null)));
    for (const g of got) if (g !== null && g !== undefined) counts.push(Number(g));
  }
  return counts.length >= 10 ? counts : null;
}

// `k` random blocks per day for the RPC reference; 0 skips the RPC sample (the fast /data table).
export async function crossCheck(db: Db, opts: { days?: number; k?: number; client?: RpcClient } = {}): Promise<CrossCheckResult> {
  const dayCount = opts.days ?? 7;
  const k = Math.max(0, opts.k ?? 0);
  const [stored, per, sysRows] = await Promise.all([
    rows(db, sql`
      SELECT to_char(date_trunc('day', b.ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*) AS blocks,
             coalesce(sum(b.tx_count), 0) AS tx, min(b.number) AS lo, max(b.number) AS hi, array_agg(b.tx_count) AS counts
      FROM blocks b
      WHERE b.ts >= (date_trunc('day', now()) - ${sql.param(dayCount)} * interval '1 day') AND b.ts < date_trunc('day', now())
      GROUP BY 1 ORDER BY 1`),
    blocksPerDay(db),
    rows(db, sql`SELECT to_char(date, 'YYYY-MM-DD') AS day, sum(tx_count) AS tx, sum(system_tx_count) AS sys FROM agg_day GROUP BY 1`),
  ]);
  const gtp = await growthepieTxcount().catch(() => null);
  const client = k > 0 ? (opts.client ?? createRpcClient()) : null;

  const days: CrossCheckDay[] = [];
  for (const d of stored) {
    const day = String(d.day);
    const blocks = num(d.blocks);
    const tx = num(d.tx);
    const txPerBlock = blocks > 0 ? tx / blocks : 0;
    const counts = Array.isArray(d.counts) ? d.counts.map((v) => Number(v)) : [];
    const perBlockSd = counts.length > 0 ? sd(counts) : 0;
    const estimate = per ? txPerBlock * per : 0;
    const ci95 = per && blocks > 1 ? Math.round((1.96 * perBlockSd) / Math.sqrt(blocks) * per) : 0;
    let random: CrossCheckDay["random"] = null;
    if (client) {
      const counts = await randomSample(client, Number(d.lo), Number(d.hi), k, day);
      if (counts && per) {
        const m = mean(counts);
        random = { n: counts.length, avgTxPerBlock: round(m), estimate: Math.round(m * per), ci95: Math.round((1.96 * sd(counts)) / Math.sqrt(counts.length) * per) };
      }
    }
    const s = sysRows.find((x) => String(x.day) === day);
    const growthepie = gtp?.get(day) ?? null;
    days.push({
      day,
      stored: { blocks, tx, txPerBlock: round(txPerBlock, 2), estimate: Math.round(estimate), ci95 },
      random,
      growthepie,
      arbosShare: s && num(s.tx) > 0 ? round(num(s.sys) / num(s.tx), 4) : null,
      storedVsRandomPct: random && random.estimate > 0 ? round((estimate - random.estimate) / random.estimate, 3) : null,
      storedVsGtpPct: growthepie ? round((estimate - growthepie) / growthepie, 3) : null,
    });
  }
  return { k, blocksPerDay: per, growthepieAvailable: gtp !== null, days, generatedAt: new Date().toISOString() };
}
