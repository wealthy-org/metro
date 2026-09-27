import { inArray } from "drizzle-orm";
import { createDb, type Db } from "../../../db/client.ts";
import { ingestCursor } from "../../../db/schema.ts";
import { rpcUrls } from "../../../collector/rpc.ts";
import { limitedFetch } from "../../../collector/rate-limiter.ts";

export const dynamic = "force-dynamic";

let db: Db | null = null;
const getDb = () => (db ??= createDb(process.env.DATABASE_URL, 2).db);

async function chainHead(): Promise<{ head: number; rpc: string } | null> {
  for (const url of rpcUrls()) {
    try {
      const res = await limitedFetch(url, 5)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      const body: unknown = await res.json();
      const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
      if (res.ok && typeof result === "string") return { head: Number(result), rpc: url };
    } catch {
      // Try the next endpoint in the pool.
    }
  }
  return null;
}

export async function GET() {
  const lagAlert = Number(process.env.LAG_ALERT_BLOCKS ?? 100);
  try {
    const [cursors, chain] = await Promise.all([
      getDb().select().from(ingestCursor).where(inArray(ingestCursor.name, ["live", "backfill"])),
      chainHead(),
    ]);
    const live = cursors.find((c) => c.name === "live") ?? null;
    const backfill = cursors.find((c) => c.name === "backfill") ?? null;
    const lag = live && chain ? chain.head - live.block : null;
    const status = !chain ? "rpc_unavailable" : !live ? "not_started" : lag !== null && lag > lagAlert ? "delayed" : "healthy";

    // The backfill cursor holds the lowest block written; progress runs from range_end down to range_start.
    const range = backfill && backfill.rangeStart !== null && backfill.rangeEnd !== null ? { start: backfill.rangeStart, end: backfill.rangeEnd } : null;
    const backfillProgress =
      backfill && range ? Number((((range.end - backfill.block + 1) / (range.end - range.start + 1)) * 100).toFixed(4)) : null;
    const remaining = backfill && range ? Math.max(0, backfill.block - range.start) : null;
    const eta = remaining !== null && backfill?.blocksPerSecond ? Math.round(remaining / backfill.blocksPerSecond) : null;

    return Response.json(
      {
        status,
        collector: {
          live_block: live?.block ?? null,
          head_block: chain?.head ?? null,
          lag_blocks: lag,
          lag_alert_blocks: lagAlert,
          delayed: lag !== null && lag > lagAlert,
          updated_at: live?.updatedAt ?? null,
          backfill_progress_percent: backfillProgress,
          backfill_current_block: backfill?.block ?? null,
          backfill_range: range,
          backfill_blocks_remaining: remaining,
          backfill_blocks_per_second: backfill?.blocksPerSecond ?? null,
          estimated_time_remaining_seconds: eta,
          backfill_updated_at: backfill?.updatedAt ?? null,
          last_error: live?.lastError ?? null,
          last_error_at: live?.lastErrorAt ?? null,
          backfill_last_error: backfill?.lastError ?? null,
        },
        rpc_active: chain?.rpc ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ status: "down", error: "database unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
