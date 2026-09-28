import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { ingestCursor } from "../db/schema.ts";
import { runEngine } from "../engine/run.ts";
import { fetchBlockBundle } from "./ingest.ts";
import { log } from "./log.ts";
import { PriceFeed } from "./price.ts";
import { RpcPool } from "./rpc.ts";
import { Rollups } from "./rollup.ts";
import { recordError, syncKnownContracts, writeBatch } from "./writer.ts";

// PROJECT.md 13.2: insights are recomputed every 10 minutes by the Collector (Phase 7 D1). In the loop the engine
// runs in the background, so ingest never waits for it (gate F47); day rollups are already flushed every 5 minutes
// by afterBatch. At shutdown the day rollups are flushed first and the run is awaited.
const ENGINE_INTERVAL_MS = 10 * 60_000;

async function runEngineLogged(db: Db): Promise<void> {
  try {
    await runEngine(db);
  } catch (err) {
    log("error", "insight engine failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

type Options = { maxBlocks: number | null; startBlock: bigint | null; batch: number; cursor: string };

function parseArgs(argv: string[]): Options {
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const int = (name: string) => {
    const raw = value(name);
    if (raw === undefined) return null;
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer`);
    return raw;
  };
  const maxBlocks = int("max-blocks");
  const startBlock = int("start-block");
  const batch = int("batch");
  return {
    maxBlocks: maxBlocks === null ? null : Number(maxBlocks),
    startBlock: startBlock === null ? null : BigInt(startBlock),
    batch: batch === null ? 10 : Math.max(1, Math.min(50, Number(batch))),
    cursor: value("cursor") ?? "live",
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { db, pool } = createDb();
  await syncKnownContracts(db);
  const rpc = new RpcPool();
  const prices = new PriceFeed(db);
  await prices.start();
  const rollups = new Rollups(db);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("info", "shutdown requested, finishing current batch", { signal });
      stopping = true;
    });
  }

  const [saved] = await db.select().from(ingestCursor).where(eq(ingestCursor.name, opts.cursor)).limit(1);
  let next = opts.startBlock ?? (saved ? BigInt(saved.block) + 1n : await rpc.head.getBlockNumber());
  let processed = 0;
  let failures = 0;
  // The first run happens after the first ten minutes of batches; a bounded run gets one more at shutdown below.
  let lastEngine = Date.now();
  let engineRun: Promise<void> | null = null;
  log("info", "collector started", {
    cursor: opts.startBlock === null ? opts.cursor : "none (manual range, cursor untouched)",
    from: next,
    maxBlocks: opts.maxBlocks,
    batch: opts.batch,
  });

  while (!stopping && (opts.maxBlocks === null || processed < opts.maxBlocks)) {
    try {
      const head = await rpc.head.getBlockNumber();
      if (next > head) {
        await sleep(250);
        continue;
      }
      const remaining = opts.maxBlocks === null ? opts.batch : Math.min(opts.batch, opts.maxBlocks - processed);
      const last = next + BigInt(remaining) - 1n < head ? next + BigInt(remaining) - 1n : head;
      const numbers: bigint[] = [];
      for (let n = next; n <= last; n++) numbers.push(n);

      const started = performance.now();
      const bundles = await Promise.all(numbers.map((n) => fetchBlockBundle(rpc.forBlock(n), prices, n)));
      const fetched = performance.now();
      await writeBatch(db, opts.startBlock === null ? { name: opts.cursor, direction: "forward" } : null, bundles);
      await rollups.afterBatch(bundles.map((b) => b.block.ts));

      const txCount = bundles.reduce((sum, b) => sum + b.txs.length, 0);
      const other = bundles.reduce((sum, b) => sum + b.txs.filter((t) => t.action === "other").length, 0);
      log("info", "batch written", {
        from: numbers[0],
        to: last,
        txs: txCount,
        fetchMs: Math.round(fetched - started),
        writeMs: Math.round(performance.now() - fetched),
        lag: head - last,
      });
      // PROJECT.md 9.3: many `other` transactions mean config/known-contracts.ts needs more entries.
      if (txCount >= 20 && other / txCount > 0.2) {
        log("warn", "high share of unclassified transactions", { other, txs: txCount, from: numbers[0], to: last });
      }

      processed += numbers.length;
      next = last + 1n;
      failures = 0;
      if (engineRun === null && Date.now() - lastEngine >= ENGINE_INTERVAL_MS) {
        lastEngine = Date.now();
        engineRun = runEngineLogged(db).finally(() => {
          engineRun = null;
        });
      }
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      log("error", "batch failed", { from: next, attempt: failures, error: message });
      await recordError(db, opts.cursor, message).catch(() => undefined);
      await sleep(Math.min(30_000, 500 * 2 ** failures));
    }
  }

  // Leaves the insights fresh for the blocks this run wrote, also for short bounded runs (KL-1, KL-26).
  if (engineRun) await engineRun;
  await rollups.flushDays().catch((err: unknown) => log("error", "day rollup failed", { error: err instanceof Error ? err.message : String(err) }));
  if (processed > 0) await runEngineLogged(db);
  log("info", "collector stopped", { processed, next });
  prices.stop();
  await pool.end();
}

main().catch((err) => {
  log("error", "collector crashed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
