import { timingSafeEqual } from "node:crypto";
import { runEngine } from "../../../../engine/run.ts";
import { getDb } from "../../../../server/http.ts";

export const dynamic = "force-dynamic";
// Hobby functions may run up to 60 s; one engine run takes a few seconds on the current data.
export const maxDuration = 60;

// PROJECT.md 18: GET /api/cron/insights recomputes facts and insights when the Collector does not (Phase 7 D1,
// KL-26). Vercel Cron calls it once a day (vercel.json) with `Authorization: Bearer <CRON_SECRET>` (PROJECT.md 23).
// Without a configured secret the route refuses to run.
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
  try {
    const result = await runEngine(getDb());
    return Response.json(result, { headers: noStore });
  } catch {
    return Response.json({ error: "engine failed" }, { status: 500, headers: noStore });
  }
}
