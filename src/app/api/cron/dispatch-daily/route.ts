import { timingSafeEqual } from "node:crypto";
import { runDispatch } from "../../../../dispatch/build.ts";
import { runEngine } from "../../../../engine/run.ts";
import { getDb } from "../../../../server/http.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// PROJECT.md 18 and 14.1: GET /api/cron/dispatch-daily writes the daily report for the previous UTC day and rebuilds
// the subsidy report (Phase 11 D3). The engine runs first, behind the same advisory lock as the insights cron, so the
// report never depends on the order of the two crons; on Hobby it runs somewhere in the 00:xx hour (KL-29).
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  const noStore = { "cache-control": "no-store" };
  if (!process.env.CRON_SECRET) return Response.json({ error: "cron not configured" }, { status: 503, headers: noStore });
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const t0 = Date.now();
  try {
    const db = getDb();
    const engine = await runEngine(db);
    const result = await runDispatch(db);
    if ("status" in result) return Response.json({ ...result, engine: engine.status, ms: Date.now() - t0 }, { headers: noStore });
    return Response.json({ status: "done", ...result, engine: engine.status, ms: Date.now() - t0 }, { headers: noStore });
  } catch {
    return Response.json({ error: "dispatch failed" }, { status: 500, headers: noStore });
  }
}
