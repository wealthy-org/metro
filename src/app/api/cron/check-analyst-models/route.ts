import { timingSafeEqual } from "node:crypto";
import { ANALYST_MODELS } from "../../../../../config/analyst-models.ts";
import { storeModelList } from "../../../../analyst/budget.ts";
import { listModels } from "../../../../analyst/openrouter.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// PROJECT.md 18 and 13.4.5: GET /api/cron/check-analyst-models reads the OpenRouter model list, keeps the configured
// ids that still exist and are free in Redis, and reports the rest, so the ladder skips them (AT 21). Scheduled once a
// day by Vercel Cron in vercel.json; on Hobby it runs somewhere in the scheduled hour (KL-29). Same auth as the
// insights cron: `Authorization: Bearer <CRON_SECRET>`, and no secret means the route refuses to run.
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
    const models = await listModels();
    const byId = new Map(models.map((m) => [m.id, m.free]));
    const available: string[] = [];
    const missing: string[] = [];
    const notFree: string[] = [];
    for (const layer of ANALYST_MODELS) {
      // Stray routes over the free models and is not an id on the list; it stays.
      if (layer.model === "openrouter/free") continue;
      const free = byId.get(layer.model);
      if (free === undefined) missing.push(layer.model);
      else if (!free) notFree.push(layer.model);
      else available.push(layer.model);
    }
    await storeModelList(available);
    return Response.json({ status: "done", list_size: models.length, available, missing, not_free: notFree }, { headers: noStore });
  } catch {
    return Response.json({ error: "model list unavailable" }, { status: 502, headers: noStore });
  }
}
