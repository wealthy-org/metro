import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { HeatmapHours, HeatmapResponse } from "../lib/api-types.ts";
import type { CityWindow } from "../lib/city.ts";
import type { CellState } from "../lib/lenses.ts";
import { metricIssue, rawFilterCount, type Filters, type HeatmapMode, type Metric } from "../lib/view-state.ts";
import { firstDataTs, resolveRange, txTime, windowInfo } from "./city.ts";
import { anchorAt, coverage, filterKey, subsidyEnd, txFilter } from "./filters.ts";
import { cachedRows, iso, isoDay, num } from "./query.ts";

// Heatmap lens (PROJECT.md 10.5): one cell per UTC hour, one row per UTC calendar day of the window (Phase 5 D3).
// Transactions, gas and fees come from agg_minute (raw txs when a raw-only filter is set, KL-20); gas price is the
// chain-wide average block base fee. A cell without ingested data is "n", never a zero.

export type HeatmapParams = { window: CityWindow; metric: Metric; mode: HeatmapMode; filters: Filters };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_DAYS = 400;

export const heatmapIssue = (p: HeatmapParams) => metricIssue("heatmap", p.metric, p.window);

type Sums = { n: number; gas: number; fee: number };

function cellValue(s: Sums, metric: Metric): number | null {
  if (metric === "tx_count") return s.n;
  if (metric === "gas_volume") return s.gas;
  if (metric === "avg_fee_usd") return s.n > 0 ? s.fee / s.n : null;
  // gas_price: `fee` holds the summed base fee in wei and `n` the block count.
  if (metric === "gas_price") return s.n > 0 ? s.fee / s.n / 1e9 : null;
  return null;
}

const hourBin = sql`date_bin('1 hour'::interval, ts, timestamptz '2000-01-01')`;

export async function getHeatmap(db: Db, p: HeatmapParams, anchor?: Date | null): Promise<HeatmapResponse> {
  const [at, cov] = await Promise.all([anchor === undefined ? anchorAt(db, null) : Promise.resolve(anchor), coverage(db)]);
  const cliff = subsidyEnd();
  const base = { metric: p.metric, mode: p.mode, coverage: cov, filters: p.filters, subsidy_end: cliff };
  const now = () => new Date().toISOString();
  if (!at) return { ...base, window: windowInfo(p.window, null, null, null), days: [], cells: [], compare: null, max: null, n: 0, generated_at: now() };

  const r = resolveRange(p.window, at);
  const firstTs = await firstDataTs(db, r);
  const startMs = r.start?.getTime() ?? (firstTs ? Date.parse(firstTs) : at.getTime());
  // Nothing exists after the anchor block: the window's usable end is its minute.
  const endMs = Math.min(r.end.getTime(), Math.floor(at.getTime() / 60_000) * 60_000 + 60_000);
  const q = { ...r, start: new Date(startMs), end: new Date(endMs) };
  const firstDay = Date.parse(`${isoDay(new Date(startMs))}T00:00:00Z`);
  const dayCount = Math.min(MAX_DAYS, Math.floor((Date.parse(`${isoDay(at)}T00:00:00Z`) - firstDay) / DAY) + 1);
  const days = Array.from({ length: dayCount }, (_, i) => isoDay(new Date(firstDay + i * DAY)));

  const f = p.filters;
  const key = `heatmap|${p.metric === "gas_price" ? "gas" : "tx"}|${q.start.toISOString()}|${q.end.toISOString()}|${filterKey(f)}`;
  const aFilter = f.action ? sql`AND action = ${f.action}` : sql``;
  const dataQuery =
    p.metric === "gas_price"
      ? sql`SELECT ${hourBin} AS b, count(*) AS n, 0 AS gas, sum(base_fee) AS fee FROM blocks
            WHERE ${txTime(q, sql`ts`)} AND base_fee IS NOT NULL GROUP BY 1`
      : rawFilterCount(f) > 0
        ? sql`SELECT ${hourBin} AS b, count(*) AS n, sum(gas_used) AS gas, sum(fee_usd) AS fee FROM txs
              WHERE ${txTime(q, sql`ts`)} ${txFilter(f, "txs")} GROUP BY 1`
        : sql`SELECT ${hourBin} AS b, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_sum) AS fee FROM agg_minute
              WHERE ${txTime(q, sql`ts`)} ${aFilter} GROUP BY 1`;
  // Hours holding any ingested data, unfiltered: blocks for gas price, the minute rollups otherwise (every block
  // carries an ArbOS internal transaction, KL-7, so an ingested hour always has rollup rows).
  const coveredQuery =
    p.metric === "gas_price"
      ? sql`SELECT DISTINCT ${hourBin} AS b FROM blocks WHERE ${txTime(q, sql`ts`)}`
      : sql`SELECT DISTINCT ${hourBin} AS b FROM agg_minute WHERE ${txTime(q, sql`ts`)}`;
  const [dataRows, covRows] = await Promise.all([cachedRows(db, `${key}|data`, dataQuery), cachedRows(db, `${key}|cov`, coveredQuery)]);

  const sums = new Map<number, Sums>();
  for (const x of dataRows) sums.set(Date.parse(iso(x.b) ?? ""), { n: num(x.n), gas: num(x.gas), fee: num(x.fee) });
  const covered = new Set(covRows.map((x) => Date.parse(iso(x.b) ?? "")));

  let n = 0;
  const cells = days.map((_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const t = firstDay + d * DAY + h * HOUR;
      const inside = t < endMs && t + HOUR > startMs;
      const s: CellState = !inside ? "o" : covered.has(t) ? "d" : "n";
      if (s !== "d") return { v: null, n: 0, s };
      const c = sums.get(t) ?? { n: 0, gas: 0, fee: 0 };
      n += c.n;
      return { v: cellValue(c, p.metric), n: c.n, s };
    }),
  );

  let compare: HeatmapResponse["compare"] = null;
  if (p.mode === "compare") {
    const cliffMs = Date.parse(cliff);
    const side = (after: boolean) => {
      const acc = Array.from({ length: 24 }, () => ({ n: 0, gas: 0, fee: 0, cells: 0 }));
      const dayHours = new Map<number, number>();
      for (const t of covered) {
        if ((t >= cliffMs) !== after) continue;
        const h = new Date(t).getUTCHours();
        const c = sums.get(t) ?? { n: 0, gas: 0, fee: 0 };
        const a = acc[h];
        if (!a) continue;
        a.n += c.n;
        a.gas += c.gas;
        a.fee += c.fee;
        a.cells += 1;
        const day = t - (t % DAY);
        dayHours.set(day, (dayHours.get(day) ?? 0) + 1);
      }
      // Counts and gas are averaged per covered cell; fees and gas price are weighted by their sample.
      const values = acc.map((a) => {
        if (a.cells === 0) return null;
        if (p.metric === "tx_count") return a.n / a.cells;
        if (p.metric === "gas_volume") return a.gas / a.cells;
        return cellValue(a, p.metric);
      });
      const out: HeatmapHours = { values, n: acc.map((a) => a.n), days: dayHours.size };
      return { out, fullDays: [...dayHours.values()].filter((c) => c === 24).length };
    };
    const before = side(false);
    const after = side(true);
    compare = { before: before.out, after: { ...after.out, full_days: after.fullDays } };
  }

  const shown = p.mode === "compare" && compare ? [...compare.before.values, ...compare.after.values] : cells.flat().map((c) => c.v);
  const values = shown.filter((v): v is number => v !== null);
  return {
    ...base,
    window: windowInfo(p.window, r, firstTs, at),
    days,
    cells,
    compare,
    max: values.length ? Math.max(...values) : null,
    n,
    generated_at: now(),
  };
}
