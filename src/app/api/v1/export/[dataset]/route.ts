import { sql } from "drizzle-orm";
import { coverage } from "../../../../../server/filters.ts";
import { badRequest, getDb, serverError } from "../../../../../server/http.ts";
import { num, rows } from "../../../../../server/query.ts";
import { EXPORT_DATASETS } from "../../../../../server/export-datasets.ts";
import { csvString } from "../../../../../lib/export.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/export/{dataset}.csv (Phase 11 D4; api.md 1.10). Bounded: txs at most 24 h and 50,000
// rows, blocks at most 24 h, agg_minute at most 7 days; the small tables export whole. Out of bounds is HTTP 400 with
// the limit. The first line states the dataset, n and the window.
const DAY_MS = 86_400_000;
const DATASETS = EXPORT_DATASETS;

export async function GET(request: Request, ctx: { params: Promise<{ dataset: string }> }) {
  const { dataset } = await ctx.params;
  const name = dataset.replace(/\.csv$/i, "");
  const spec = DATASETS[name];
  if (!spec) return badRequest(`dataset must be one of ${Object.keys(DATASETS).join(", ")}`);
  try {
    const db = getDb();
    const params = new URL(request.url).searchParams;
    const cov = await coverage(db);
    const anchor = cov.last ? new Date(cov.last) : null;
    const parse = (v: string | null) => {
      if (!v) return null;
      const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
      return Number.isFinite(d.getTime()) ? d : undefined;
    };
    const fromRaw = parse(params.get("from"));
    const toRaw = parse(params.get("to"));
    if (fromRaw === undefined || toRaw === undefined) return badRequest("from and to must be an ISO instant or YYYY-MM-DD");
    let start = fromRaw;
    let end = toRaw;
    if (spec.timeColumn) {
      if (!anchor) return badRequest("nothing is ingested yet");
      end = end ?? new Date(anchor.getTime() + 1000);
      start = start ?? new Date(end.getTime() - Math.min(spec.maxSpanMs ?? DAY_MS, spec.maxSpanMs ?? DAY_MS));
      if (spec.maxSpanMs !== null && end.getTime() - start.getTime() > spec.maxSpanMs) return badRequest(`${name} exports at most ${spec.maxSpanMs / DAY_MS} day(s)`);
    }
    const where = spec.timeColumn && start && end ? sql`WHERE ${sql.raw(spec.timeColumn)} >= ${start} AND ${sql.raw(spec.timeColumn)} < ${end}` : sql``;
    // sql.raw is used only for the table, column and ordering names of the DATASETS table above, never for input.
    if (spec.rowCap !== null) {
      const [count] = await rows(db, sql`SELECT count(*) AS n FROM ${sql.raw(spec.table)} ${where}`);
      if (num(count?.n) > spec.rowCap) return badRequest(`${name} exports at most ${spec.rowCap.toLocaleString("en-US")} rows; narrow the window`);
    }
    const limit = spec.rowCap === null ? 50_000 : spec.rowCap;
    const out = await rows(db, sql`SELECT ${sql.raw(spec.columns.join(", "))} FROM ${sql.raw(spec.table)} ${where} ORDER BY ${sql.raw(spec.order)} LIMIT ${limit}`);
    const windowLabel = spec.timeColumn && start && end ? `${start.toISOString()} to ${end.toISOString()} UTC` : "whole table";
    const header = `# Metro export: ${name}; n = ${out.length}; window ${windowLabel}; generated ${new Date().toISOString()}`;
    const body = `${header}\n${csvString(spec.columns, out.map((r) => spec.columns.map((c) => r[c])))}`;
    const file = `metro-${name}-${(start ?? anchor ?? new Date()).toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}"`, "cache-control": "public, s-maxage=10, stale-while-revalidate=30" },
    });
  } catch {
    return serverError();
  }
}
