import { CUSTOM_DEFAULT, customReport, type CustomOptions } from "../../../dispatch/build.ts";
import { dispatch as dispatchTable } from "../../../db/schema.ts";
import { coverage } from "../../../server/filters.ts";
import { checkQuota, countAsk, identity } from "../../../server/ask-limit.ts";
import { badRequest, getDb, serverError } from "../../../server/http.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// PROJECT.md 18 and 14.2: POST /api/dispatch builds a custom report over a chosen range, lens pictures and sections
// (Phase 11 D4). One custom report counts as one Surveyor question against the per-user limit. Bounds: whole UTC days
// inside the ingested coverage, at most 31 days.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LENSES = new Set<CustomOptions["lenses"]>(["city", "heatmap", "both", "none"]);

export async function POST(request: Request) {
  const noStore = { "cache-control": "no-store" };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("a JSON body is required");
  }
  const b = (body ?? {}) as { from?: unknown; to?: unknown; lenses?: unknown; sections?: unknown };
  const from = typeof b.from === "string" ? b.from : "";
  const to = typeof b.to === "string" ? b.to : "";
  if (!DAY.test(from) || !DAY.test(to)) return badRequest("from and to must be YYYY-MM-DD");
  const lenses = typeof b.lenses === "string" ? b.lenses : CUSTOM_DEFAULT.lenses;
  if (!LENSES.has(lenses as CustomOptions["lenses"])) return badRequest("lenses must be city, heatmap, both or none");
  const sections = (b.sections ?? {}) as { findings?: unknown; changes?: unknown };
  const opts: CustomOptions = { lenses: lenses as CustomOptions["lenses"], findings: sections.findings !== false, changes: sections.changes !== false };
  const start = new Date(`${from}T00:00:00Z`);
  const endDay = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(endDay.getTime()) || start > endDay) return badRequest("the range must start on or before its last day");
  const days = Math.round((endDay.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > 31) return badRequest("a report covers at most 31 days");

  const id = identity(request);
  const db = getDb();
  try {
    const cov = await coverage(db);
    const firstDay = cov.first?.slice(0, 10) ?? "";
    const lastDay = cov.last?.slice(0, 10) ?? "";
    if (!lastDay) return badRequest("nothing is ingested yet");
    if (from < firstDay || to > lastDay) return badRequest(`the range must sit inside the ingested data (${firstDay} to ${lastDay})`);
    const quota = await checkQuota(db, id);
    const headers: Record<string, string> = { ...noStore };
    if (id.newCookie) headers["set-cookie"] = id.newCookie;
    if (!quota.allowed) {
      return Response.json(
        { error: `The daily limit of ${quota.limit} questions is used (${quota.reason === "ip" ? "this network" : "this browser"}). It resets at ${quota.reset.slice(0, 16).replace("T", " ")} UTC.`, quota },
        { status: 429, headers },
      );
    }
    const report = await customReport(db, start, endDay, new Date(), opts);
    await db.insert(dispatchTable).values(report).onConflictDoNothing();
    await countAsk(db, id);
    return Response.json({ id: report.id, url: `/dispatch/${report.id}`, range_label: report.rangeLabel, model_used: report.modelUsed, quota: { ...quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) } }, { headers });
  } catch {
    return serverError();
  }
}
