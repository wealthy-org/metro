import { sql } from "drizzle-orm";
import { coverage } from "../../../../../server/filters.ts";
import { badRequest, getDb, serverError } from "../../../../../server/http.ts";
import { num, rows } from "../../../../../server/query.ts";
import { csvString } from "../../../../../lib/export.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/export/{dataset}.csv (Phase 11 D4; api.md 1.10). Bounded: txs at most 24 h and 50,000
// rows, blocks at most 24 h, agg_minute at most 7 days; the small tables export whole. Out of bounds is HTTP 400 with
// the limit. The first line states the dataset, n and the window.
const DAY_MS = 86_400_000;
const MAX_TX_ROWS = 50_000;

type Dataset = {
  columns: string[];
  table: string;
  order: string;
  timeColumn: string | null;
  maxSpanMs: number | null;
  rowCap: number | null;
};

const DATASETS: Record<string, Dataset> = {
  txs: { columns: ["hash", "block", "ts", "from_address", "to_address", "value", "gas_used", "gas_price", "fee_eth", "fee_usd", "status", "method", "action", "subsidy_class"], table: "txs", order: "ts, hash", timeColumn: "ts", maxSpanMs: DAY_MS, rowCap: MAX_TX_ROWS },
  blocks: { columns: ["number", "hash", "ts", "gas_used", "gas_limit", "base_fee", "tx_count"], table: "blocks", order: "number", timeColumn: "ts", maxSpanMs: DAY_MS, rowCap: null },
  agg_minute: { columns: ["ts", "action", "tx_count", "gas_used", "fee_usd_sum", "fee_usd_median", "wallets"], table: "agg_minute", order: "ts, action", timeColumn: "ts", maxSpanMs: 7 * DAY_MS, rowCap: null },
  agg_day: { columns: ["date", "action", "subsidy_class", "tx_count", "gas_used", "fee_usd_avg", "fee_usd_median", "active_wallets", "failed_tx_count", "system_tx_count"], table: "agg_day", order: "date, action, subsidy_class", timeColumn: null, maxSpanMs: null, rowCap: null },
  facts: { columns: ["id", "key", "window_start", "window_end", "value", "n", "computed_at"], table: "facts", order: "id", timeColumn: null, maxSpanMs: null, rowCap: null },
  insights: { columns: ["id", "rule", "status", "text", "n", "severity", "window_start", "window_end", "evidence_url", "created_at", "expires_at"], table: "insights", order: "created_at DESC", timeColumn: null, maxSpanMs: null, rowCap: null },
  tokens: { columns: ["address", "symbol", "name", "decimals", "is_pons", "created_at", "holders", "supply"], table: "tokens", order: "address", timeColumn: null, maxSpanMs: null, rowCap: null },
};

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
