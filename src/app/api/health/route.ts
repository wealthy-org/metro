import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../../db/client.ts";
import { ingestCursor } from "../../../db/schema.ts";
import { rpcUrls } from "../../../collector/rpc.ts";

export const dynamic = "force-dynamic";

let db: Db | null = null;
const getDb = () => (db ??= createDb(process.env.DATABASE_URL, 2).db);

async function chainHead(): Promise<{ head: number; rpc: string } | null> {
  for (const url of rpcUrls()) {
    try {
      const res = await fetch(url, {
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
    const [cursor, chain] = await Promise.all([
      getDb().select().from(ingestCursor).where(eq(ingestCursor.name, "live")).limit(1),
      chainHead(),
    ]);
    const live = cursor[0] ?? null;
    const lag = live && chain ? chain.head - live.block : null;
    const status = !chain ? "rpc_unavailable" : !live ? "not_started" : lag !== null && lag > lagAlert ? "delayed" : "healthy";

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
          // Backfill arrives in Phase 2.
          backfill_progress_percent: null,
          last_error: live?.lastError ?? null,
          last_error_at: live?.lastErrorAt ?? null,
        },
        rpc_active: chain?.rpc ?? null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ status: "down", error: "database unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
