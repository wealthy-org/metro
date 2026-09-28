import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { TerrainResponse } from "../lib/api-types.ts";
import { CITY_ACTIONS, type CityWindow } from "../lib/city.ts";
import { TERRAIN_BUCKETS } from "../lib/lenses.ts";
import { metricIssue, rawFilterCount, type Filters, type Metric, type TerrainRows } from "../lib/view-state.ts";
import { dayRange, firstDataTs, resolveRange, tokenLabel, tokenStats, txTime, windowInfo, type Range } from "./city.ts";
import { anchorAt, coverage, filterKey, subsidyEnd, txFilter } from "./filters.ts";
import { cachedRows, iso, num, rows, type Row } from "./query.ts";

// Terrain lens (PROJECT.md 10.2): X = time buckets of the window, Z = actions (or Pons tokens up to 24 h), height =
// metric. Buckets without ingested data are null rather than zero.

export type TerrainParams = { window: CityWindow; metric: Metric; rows: TerrainRows; filters: Filters };

export function terrainIssue(p: TerrainParams): string | null {
  const m = metricIssue("terrain", p.metric, p.window);
  if (m) return m;
  const short = p.window === "1h" || p.window === "24h";
  if (p.rows === "tokens" && !short) return "Token rows are available for windows of 24 h or less";
  return null;
}

type Cell = { n: number; gas: number; fee: number; w: number | null; failed: number | null };
const EMPTY: Cell = { n: 0, gas: 0, fee: 0, w: 0, failed: 0 };

function value(c: Cell, metric: Metric): number | null {
  if (metric === "tx_count") return c.n;
  if (metric === "gas_volume") return c.gas;
  if (metric === "avg_fee_usd") return c.n > 0 ? c.fee / c.n : null;
  if (metric === "wallets") return c.w;
  if (metric === "fail_rate") return c.failed === null || c.n === 0 ? null : c.failed / c.n;
  return null;
}

const bin = (ms: number, col: SQL) => sql`date_bin(${`${ms / 1000} seconds`}::interval, ${col}, timestamptz '2000-01-01')`;

export async function getTerrain(db: Db, p: TerrainParams, anchor?: Date | null): Promise<TerrainResponse> {
  const bucket = TERRAIN_BUCKETS[p.window];
  const [at, cov] = await Promise.all([anchor === undefined ? anchorAt(db, null) : Promise.resolve(anchor), coverage(db)]);
  const base = { metric: p.metric, rows_kind: p.rows, bucket: bucket.key, coverage: cov, filters: p.filters, subsidy_end: subsidyEnd() };
  const empty = (r: Range | null, first: string | null): TerrainResponse => ({
    ...base,
    window: windowInfo(p.window, r, first, at ?? null),
    buckets: [],
    covered: [],
    rows: [],
    max: null,
    n: 0,
    generated_at: new Date().toISOString(),
  });
  if (!at) return empty(null, null);

  const r = resolveRange(p.window, at);
  const firstTs = await firstDataTs(db, r);
  const startMs = r.start?.getTime() ?? (firstTs ? Date.parse(firstTs) : null);
  if (startMs === null) return empty(r, firstTs);
  const first = Math.floor(startMs / bucket.ms) * bucket.ms;
  const count = Math.max(0, Math.ceil((r.end.getTime() - first) / bucket.ms));
  const starts = Array.from({ length: count }, (_, i) => first + i * bucket.ms);
  const index = new Map(starts.map((t, i) => [t, i]));
  const daily = bucket.key === "1d";
  const raw = rawFilterCount(p.filters) > 0 || p.metric === "wallets" || p.metric === "fail_rate" || p.rows === "tokens";
  const f = p.filters;
  const aFilter = f.action ? sql`AND action = ${f.action}` : sql``;
  const key = `terrain|${p.window}|${r.start?.toISOString() ?? "-"}|${r.end.toISOString()}|${p.rows}|${filterKey(f)}`;

  // Every Arbitrum block carries an ArbOS internal transaction (KL-7), so a bucket with ingested blocks always has a
  // rollup row: rollup presence, unfiltered, marks the buckets that hold data.
  const coveredQuery = daily
    ? sql`SELECT DISTINCT date AS b FROM agg_day WHERE ${dayRange(r)}`
    : sql`SELECT DISTINCT ${bin(bucket.ms, sql`ts`)} AS b FROM agg_minute WHERE ${txTime(r, sql`ts`)}`;

  let rowKeys: { kind: "action" | "token"; key: string; label: string }[];
  let dataQuery: Promise<Row[]>;
  if (p.rows === "tokens") {
    const tokens = await tokenStats(db, r, f);
    rowKeys = tokens.map((t) => ({ kind: "token" as const, key: t.key, label: tokenLabel(t) }));
    const keys = tokens.map((t) => t.key);
    dataQuery = keys.length
      ? cachedRows(db, `${key}|tokens`, sql`
          WITH moved AS (
            SELECT DISTINCT tt.token_address, tt.tx_hash, tt.ts FROM token_transfers tt
            WHERE ${txTime(r, sql`tt.ts`)} AND tt.token_address IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
          )
          SELECT ${bin(bucket.ms, sql`m.ts`)} AS b, m.token_address AS key, count(*) AS n, sum(t.gas_used) AS gas, sum(t.fee_usd) AS fee,
                 count(DISTINCT t.from_address) AS w, NULL AS failed
          FROM moved m JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts
          WHERE true ${txFilter({ ...f, token: null }, "t")}
          GROUP BY 1, 2`)
      : Promise.resolve([]);
  } else {
    rowKeys = CITY_ACTIONS.map((a) => ({ kind: "action" as const, key: a.key, label: a.label }));
    if (raw) {
      dataQuery = cachedRows(db, `${key}|actions`, sql`
        SELECT ${bin(bucket.ms, sql`ts`)} AS b, action AS key, count(*) AS n, sum(gas_used) AS gas, sum(fee_usd) AS fee,
               count(DISTINCT from_address) AS w, count(*) FILTER (WHERE status = 0) AS failed
        FROM txs WHERE ${txTime(r, sql`ts`)} ${txFilter(f, "txs")} GROUP BY 1, 2`);
    } else if (daily) {
      dataQuery = rows(db, sql`
        SELECT date AS b, action AS key, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_avg * tx_count) AS fee,
               NULL AS w, sum(failed_tx_count) AS failed
        FROM agg_day WHERE ${dayRange(r)} ${aFilter} GROUP BY 1, 2`);
    } else {
      dataQuery = rows(db, sql`
        SELECT ${bin(bucket.ms, sql`ts`)} AS b, action AS key, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_sum) AS fee,
               NULL AS w, NULL AS failed
        FROM agg_minute WHERE ${txTime(r, sql`ts`)} ${aFilter} GROUP BY 1, 2`);
    }
  }
  const [covRows, dataRows] = await Promise.all([rows(db, coveredQuery), dataQuery]);

  const bucketOf = (v: unknown) => {
    const t = daily ? Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`) : Date.parse(iso(v) ?? "");
    return index.get(t);
  };
  const covered = starts.map(() => false);
  for (const c of covRows) {
    const i = bucketOf(c.b);
    if (i !== undefined) covered[i] = true;
  }
  const cells = new Map<string, Cell>();
  for (const x of dataRows) {
    const i = bucketOf(x.b);
    if (i === undefined) continue;
    cells.set(`${String(x.key)}|${i}`, { n: num(x.n), gas: num(x.gas), fee: num(x.fee), w: x.w === null ? null : num(x.w), failed: x.failed === null ? null : num(x.failed) });
  }
  let n = 0;
  const out = rowKeys.map((row) => ({
    ...row,
    values: starts.map((_, i) => {
      if (!covered[i]) return null;
      const c = cells.get(`${row.key}|${i}`) ?? EMPTY;
      n += c.n;
      return value(c, p.metric);
    }),
  }));
  const all = out.flatMap((x) => x.values).filter((v): v is number => v !== null);
  return {
    ...base,
    window: windowInfo(p.window, r, firstTs, at),
    buckets: starts.map((t) => new Date(t).toISOString()),
    covered,
    rows: out,
    max: all.length ? Math.max(...all) : null,
    n,
    generated_at: new Date().toISOString(),
  };
}
