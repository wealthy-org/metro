import { eq, sql } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { blocks, ingestCursor } from "../db/schema.ts";
import { fetchBlockBundle } from "./ingest.ts";
import { log } from "./log.ts";
import { HistoricalPriceFeed } from "./price.ts";
import { RpcPool, type RpcClient } from "./rpc.ts";
import { recordError, writeBatch, type CursorUpdate } from "./writer.ts";

const CURSOR = "backfill";
// PROJECT.md 9.2: fill back to the chain start of 2026-07-01, as far as rate limits allow.
const DEFAULT_BOTTOM_DATE = "2026-07-01";

type Options = { maxBlocks: number | null; batch: number; rate: number; fromBlock: number | null; toDate: string };

function parseArgs(argv: string[]): Options {
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const num = (name: string, pattern = /^\d+$/) => {
    const raw = value(name);
    if (raw === undefined) return null;
    if (!pattern.test(raw)) throw new Error(`--${name} has an invalid value`);
    return Number(raw);
  };
  const toDate = value("to-date") ?? DEFAULT_BOTTOM_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) throw new Error("--to-date must be YYYY-MM-DD");
  return {
    maxBlocks: num("max-blocks"),
    batch: Math.max(1, Math.min(50, num("batch") ?? 10)),
    rate: Math.max(0.1, num("rate", /^\d+(\.\d+)?$/) ?? 2),
    fromBlock: num("from-block"),
    toDate,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// First block whose timestamp is at or after `unixSeconds` (binary search, ~27 calls).
async function firstBlockAt(client: RpcClient, unixSeconds: number): Promise<number> {
  let lo = 1n;
  let hi = await client.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < unixSeconds) lo = mid + 1n;
    else hi = mid;
  }
  return Number(lo);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { db, pool } = createDb();
  const rpc = new RpcPool();
  const prices = new HistoricalPriceFeed(db);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("info", "shutdown requested, finishing current batch", { signal });
      stopping = true;
    });
  }

  const [saved] = await db.select().from(ingestCursor).where(eq(ingestCursor.name, CURSOR)).limit(1);
  let range: { start: number; end: number };
  let next: number;
  if (saved && saved.rangeStart !== null && saved.rangeEnd !== null) {
    range = { start: saved.rangeStart, end: saved.rangeEnd };
    next = saved.block - 1;
    if (opts.fromBlock !== null || opts.toDate !== DEFAULT_BOTTOM_DATE) {
      log("warn", "saved backfill range kept; --from-block and --to-date only apply to a new cursor", { range });
    }
  } else {
    // Start just below the oldest block already stored (the first live block), so the two cursors meet without a gap.
    const [oldest] = await db.select({ n: sql<string | null>`min(${blocks.number})` }).from(blocks);
    const end = opts.fromBlock ?? (oldest?.n ? Number(oldest.n) - 1 : Number(await rpc.head.getBlockNumber()));
    const start = await firstBlockAt(rpc.head, Date.parse(`${opts.toDate}T00:00:00Z`) / 1000);
    range = { start, end };
    next = end;
  }
  const cursor: CursorUpdate = { name: CURSOR, direction: "backward", range };
  const total = range.end - range.start + 1;
  log("info", "backfill started", { from: next, down_to: range.start, range_end: range.end, rate: opts.rate, batch: opts.batch });

  let processed = 0;
  let failures = 0;
  const startedAt = performance.now();

  while (!stopping && next >= range.start && (opts.maxBlocks === null || processed < opts.maxBlocks)) {
    const size = Math.min(opts.batch, next - range.start + 1, opts.maxBlocks === null ? Infinity : opts.maxBlocks - processed);
    const numbers = Array.from({ length: size }, (_, i) => next - i);
    const batchStarted = performance.now();
    try {
      const bundles = await Promise.all(numbers.map((n) => fetchBlockBundle(rpc.forBlock(BigInt(n)), prices, BigInt(n))));
      // Average since this run started, including pacing sleeps: the rate the ETA in /api/health should use.
      const blocksPerSecond = (processed + size) / ((performance.now() - startedAt) / 1000);
      await writeBatch(db, { ...cursor, blocksPerSecond }, bundles);
      processed += size;
      next -= size;
      failures = 0;

      const done = range.end - next;
      log("info", "backfill batch written", {
        from: numbers[0],
        to: numbers.at(-1),
        txs: bundles.reduce((sum, b) => sum + b.txs.length, 0),
        progress_percent: Number(((done / total) * 100).toFixed(4)),
        blocks_per_second: Number(blocksPerSecond.toFixed(2)),
        eta_hours: Number(((next - range.start + 1) / blocksPerSecond / 3600).toFixed(1)),
      });
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      log("error", "backfill batch failed", { from: numbers[0], attempt: failures, error: message });
      await recordError(db, CURSOR, message).catch(() => undefined);
      // Exponential backoff with jitter so several workers do not retry in lockstep.
      await sleep(Math.min(60_000, 1_000 * 2 ** failures) * (0.5 + Math.random()));
      continue;
    }
    // Pacing: hold the backfill to --rate blocks per second so the live loop keeps most of the RPC capacity.
    const minMs = (size / opts.rate) * 1000;
    const elapsed = performance.now() - batchStarted;
    if (elapsed < minMs) await sleep(minMs - elapsed);
  }

  log("info", next < range.start ? "backfill complete" : "backfill stopped", { processed, next });
  await pool.end();
}

main().catch((err) => {
  log("error", "backfill crashed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
