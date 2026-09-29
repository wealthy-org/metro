import { getHealth } from "../../../server/health.ts";

export const dynamic = "force-dynamic";

// Collector health telemetry (PROJECT.md 9.4). The builder is shared with /data (Phase 12).
export async function GET() {
  try {
    return Response.json(await getHealth(), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "down", error: "database unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
