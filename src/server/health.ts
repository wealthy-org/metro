import { inArray } from "drizzle-orm";
import { ingestCursor } from "../db/schema.ts";
import { chainHead } from "./chain.ts";
import { getDb } from "./http.ts";

// Collector health (PROJECT.md 9.4; Phase 3): read by GET /api/health and by /data (Phase 12).

export type HealthBody = {
  status: "healthy" | "delayed" | "not_started" | "rpc_unavailable";
  collector: {
    live_block: number | null;
    head_block: number | null;
    lag_blocks: number | null;
    lag_alert_blocks: number;
    delayed: boolean;
    updated_at: Date | null;
    backfill_progress_percent: number | null;
    backfill_current_block: number | null;
    backfill_range: { start: number; end: number } | null;
    backfill_blocks_remaining: number | null;
    backfill_blocks_per_second: number | null;
    estimated_time_remaining_seconds: number | null;
    backfill_updated_at: Date | null;
    last_error: string | null;
    last_error_at: Date | null;
    backfill_last_error: string | null;
  };
  rpc_active: string | null;
};

export async function getHealth(): Promise<HealthBody> {
  const lagAlert = Number(process.env.LAG_ALERT_BLOCKS ?? 100);
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
  const backfillProgress = backfill && range ? Number((((range.end - backfill.block + 1) / (range.end - range.start + 1)) * 100).toFixed(4)) : null;
  const remaining = backfill && range ? Math.max(0, backfill.block - range.start) : null;
  const eta = remaining !== null && backfill?.blocksPerSecond ? Math.round(remaining / backfill.blocksPerSecond) : null;

  return {
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
  };
}
