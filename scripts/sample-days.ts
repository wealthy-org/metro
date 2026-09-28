// Sampled backfill for the Subsidy Cliff windows (Phase 8 D1, KL-28). A full day of this chain is about 23 GB, far
// over Neon free (KL-1), so each UTC day gets fixed slices instead: by default 12 slices of 30 blocks, starting at
// 00:00, 02:00, ... 22:00 UTC. Past blocks stay on RPC, so this runs any time after the days have passed. Blocks go
// through the Collector's own fetcher, classifier, historical ETH price and writer (idempotent), then the minute and
// day rollups of the touched slices are rebuilt and the insight engine runs once. The live and backfill cursors are
// not touched.
//
//   node --env-file=.env scripts/sample-days.ts --from=2026-09-22 --to=2026-09-28 [--slices=12] [--blocks=30]
//
// Slices already ingested are skipped, slices in the future are skipped, and the run stops before the database
// passes MAX_DB_MB.

import { sql } from "drizzle-orm";
import { fetchBlockBundle } from "../src/collector/ingest.ts";
import { log } from "../src/collector/log.ts";
import { HistoricalPriceFeed } from "../src/collector/price.ts";
import { rollupDays, rollupMinutes } from "../src/collector/rollup.ts";
import { RpcPool, type RpcClient } from "../src/collector/rpc.ts";
import { writeBatch } from "../src/collector/writer.ts";
import { createDb } from "../src/db/client.ts";
import { runEngine } from "../src/engine/run.ts";

const MAX_DB_MB = 400; // Neon free is 512 MB; leave room for rollups, facts and indexes
const BATCH = 10;
const BLOCKS_PER_SECOND_GUESS = 10;

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const day = (name: string) => {
  const v = arg(name);
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) throw new Error(`--${name}=YYYY-MM-DD is required`);
  return v;
};
const int = (name: string, fallback: number, max: number) => {
  const v = arg(name);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw new Error(`--${name} must be 1 to ${max}`);
  return Number(v);
};

// First block with timestamp >= t: a guess from the chain's block rate, a few corrections, then a binary search in a
// small bracket. About 10 calls instead of about 27 for a search over the whole chain.
async function firstBlockAt(c: RpcClient, t: number, head: { number: bigint; ts: number }): Promise<bigint> {
  const tsOf = async (n: bigint) => Number((await c.getBlock({ blockNumber: n })).timestamp);
  let guess = head.number - BigInt(Math.round((head.ts - t) * BLOCKS_PER_SECOND_GUESS));
  for (let i = 0; i < 4; i++) {
    const diff = t - (await tsOf(guess));
    if (Math.abs(diff) <= 5) break;
    guess += BigInt(Math.round(diff * BLOCKS_PER_SECOND_GUESS));
  }
  let lo = guess - 200n;
  let hi = guess + 200n;
  while ((await tsOf(lo)) >= t) lo -= 2_000n;
  while ((await tsOf(hi)) < t) hi += 2_000n;
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if ((await tsOf(mid)) < t) lo = mid;
    else hi = mid;
  }
  return hi;
}

async function main() {
  const from = day("from");
  const to = day("to");
  const slices = int("slices", 12, 24);
  const size = int("blocks", 30, 600);
  const { db, pool } = createDb(process.env.DATABASE_URL, 3);
  const rpc = new RpcPool();
  const prices = new HistoricalPriceFeed(db);
  const headBlock = await rpc.head.getBlock();
  const head = { number: headBlock.number, ts: Number(headBlock.timestamp) };
  const dbMb = async () => Number((await db.execute(sql`SELECT pg_database_size(current_database()) / 1048576.0 AS mb`)).rows[0]?.mb ?? 0);

  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const step = 24 / slices;
  let written = 0;
  let skipped = 0;
  const touched = new Set<string>();

  try {
    for (const d of days) {
      for (let s = 0; s < slices; s++) {
        const start = Date.parse(`${d}T00:00:00Z`) / 1000 + Math.round(s * step * 3600);
        if (start + size / BLOCKS_PER_SECOND_GUESS > head.ts) {
          skipped++;
          continue;
        }
        if ((await dbMb()) > MAX_DB_MB) throw new Error(`database is over ${MAX_DB_MB} MB; stopping before Neon free is full (KL-1)`);
        const first = await firstBlockAt(rpc.head, start, head);
        const last = first + BigInt(size) - 1n;
        const have = Number((await db.execute(sql`SELECT count(*) AS n FROM blocks WHERE number BETWEEN ${Number(first)} AND ${Number(last)}`)).rows[0]?.n ?? 0);
        if (have >= size) {
          skipped++;
          continue;
        }
        const times: Date[] = [];
        for (let n = first; n <= last; n += BigInt(BATCH)) {
          const numbers = Array.from({ length: Number(last - n + 1n < BigInt(BATCH) ? last - n + 1n : BigInt(BATCH)) }, (_, i) => n + BigInt(i));
          const bundles = await Promise.all(numbers.map((b) => fetchBlockBundle(rpc.forBlock(b), prices, b)));
          await writeBatch(db, null, bundles);
          times.push(...bundles.map((b) => b.block.ts));
        }
        const lo = new Date(Math.min(...times.map((x) => x.getTime())));
        const hi = new Date(Math.max(...times.map((x) => x.getTime())));
        await rollupMinutes(db, lo, hi);
        touched.add(d);
        written++;
        log("info", "sample slice written", { day: d, slice: s, first: Number(first), last: Number(last), from: lo.toISOString(), to: hi.toISOString() });
      }
    }
  } finally {
    if (touched.size) await rollupDays(db, touched);
    const mb = await dbMb();
    log("info", "sampled backfill done", { slices_written: written, slices_skipped: skipped, days: [...touched], db_mb: Number(mb.toFixed(1)) });
    if (written) await runEngine(db).catch((err: unknown) => log("error", "insight engine failed", { error: err instanceof Error ? err.message : String(err) }));
    await pool.end();
  }
}

main().catch((err) => {
  log("error", "sampled backfill failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
