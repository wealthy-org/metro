import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

// Read-side queries for the public API (PROJECT.md 16). Every response states its window and sample size n.

type Row = Record<string, unknown>;

async function rows(db: Db, query: ReturnType<typeof sql>): Promise<Row[]> {
  const result = await db.execute(query);
  return result.rows as Row[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? new Date(v).toISOString() : null);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const WINDOWS = { "1h": HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, all: null } as const;
export const BUCKETS = { "1m": 60_000, "5m": 5 * 60_000, "1h": HOUR, "1d": DAY } as const;
export const SERIES_METRICS = ["tx_count", "gas_volume", "avg_fee_usd", "median_fee_usd", "wallets"] as const;
// Medians and distinct wallet counts cannot be summed across aggregate rows, so they are computed from txs,
// which is bounded to 24 hours (known-limitations KL-17).
const RAW_METRICS = new Set(["median_fee_usd", "wallets"]);
const RAW_MAX_WINDOW = DAY;
const MAX_POINTS = 2_000;

export type WindowKey = keyof typeof WINDOWS;
export type BucketKey = keyof typeof BUCKETS;
export type SeriesMetric = (typeof SERIES_METRICS)[number];
export type SeriesParams = { metric: SeriesMetric; window: WindowKey; bucket: BucketKey };
export type BreakdownParams = { by: "action" | "subsidy"; window: "24h" | "7d" | "30d" };

const isKey = <T extends object>(obj: T, key: string | null): key is Extract<keyof T, string> => key !== null && Object.hasOwn(obj, key);

export function parseSeriesParams(params: URLSearchParams): SeriesParams | string {
  const metric = params.get("metric");
  const window = params.get("window") ?? "24h";
  const bucket = params.get("bucket") ?? "1h";
  if (!metric || !(SERIES_METRICS as readonly string[]).includes(metric)) return `metric must be one of ${SERIES_METRICS.join(", ")}`;
  if (!isKey(WINDOWS, window)) return `window must be one of ${Object.keys(WINDOWS).join(", ")}`;
  if (!isKey(BUCKETS, bucket)) return `bucket must be one of ${Object.keys(BUCKETS).join(", ")}`;
  const span = WINDOWS[window];
  if (RAW_METRICS.has(metric) && (span === null || span > RAW_MAX_WINDOW)) return `${metric} is available for windows up to 24h`;
  if (span !== null && span / BUCKETS[bucket] > MAX_POINTS) return `window ${window} with bucket ${bucket} exceeds ${MAX_POINTS} points; use a larger bucket`;
  if (RAW_METRICS.has(metric) && bucket === "1d") return `${metric} needs a bucket smaller than the 24h window`;
  return { metric: metric as SeriesMetric, window, bucket };
}

export function parseBreakdownParams(params: URLSearchParams): BreakdownParams | string {
  const by = params.get("by") ?? "action";
  const window = params.get("window") ?? "24h";
  if (by !== "action" && by !== "subsidy") return "by must be action or subsidy";
  if (window !== "24h" && window !== "7d" && window !== "30d") return "window must be one of 24h, 7d, 30d";
  return { by, window };
}

const BUCKET_INTERVAL: Record<BucketKey, string> = { "1m": "1 minute", "5m": "5 minutes", "1h": "1 hour", "1d": "1 day" };

type Point = { ts: string | null; value: number | null; n: number };
export type SeriesResult = {
  metric: SeriesMetric;
  window: { key: WindowKey; start: string; end: string };
  bucket: BucketKey;
  n: number;
  data: Point[];
  generated_at: string;
};

export async function getSeries(db: Db, p: SeriesParams, now = new Date()): Promise<SeriesResult | { error: string }> {
  const span = WINDOWS[p.window];
  let start: Date;
  if (span === null) {
    const [first] = await rows(db, sql`SELECT min(ts) AS ts FROM agg_minute`);
    start = first?.ts ? new Date(String(iso(first.ts))) : now;
    if ((now.getTime() - start.getTime()) / BUCKETS[p.bucket] > MAX_POINTS) {
      return { error: `window all with bucket ${p.bucket} exceeds ${MAX_POINTS} points; use a larger bucket` };
    }
  } else {
    start = new Date(now.getTime() - span);
  }
  const interval = BUCKET_INTERVAL[p.bucket];
  let points: Point[];

  if (RAW_METRICS.has(p.metric)) {
    const r = await rows(db, sql`
      SELECT date_bin(${interval}::interval, ts, timestamptz '2000-01-01') AS ts, count(*) AS n,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS median, count(DISTINCT from_address) AS wallets
      FROM txs WHERE ts >= ${start} AND ts < ${now} GROUP BY 1 ORDER BY 1`);
    points = r.map((x) => ({ ts: iso(x.ts), value: num(p.metric === "wallets" ? x.wallets : x.median), n: Number(x.n) }));
  } else if (p.bucket === "1d") {
    const r = await rows(db, sql`
      SELECT date AS ts, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_avg * tx_count) AS fee
      FROM agg_day WHERE date >= ${start.toISOString().slice(0, 10)}::date AND date <= ${now.toISOString().slice(0, 10)}::date GROUP BY 1 ORDER BY 1`);
    points = r.map((x) => ({ ts: `${String(x.ts).slice(0, 10)}T00:00:00.000Z`, ...additive(p.metric, x) }));
  } else {
    const r = await rows(db, sql`
      SELECT date_bin(${interval}::interval, ts, timestamptz '2000-01-01') AS ts, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_sum) AS fee
      FROM agg_minute WHERE ts >= ${start} AND ts < ${now} GROUP BY 1 ORDER BY 1`);
    points = r.map((x) => ({ ts: iso(x.ts), ...additive(p.metric, x) }));
  }
  return {
    metric: p.metric,
    window: { key: p.window, start: start.toISOString(), end: now.toISOString() },
    bucket: p.bucket,
    n: points.reduce((s, x) => s + x.n, 0),
    data: points,
    generated_at: new Date().toISOString(),
  };
}

function additive(metric: SeriesMetric, x: Row): { value: number | null; n: number } {
  const n = Number(x.n);
  if (metric === "tx_count") return { value: n, n };
  if (metric === "gas_volume") return { value: num(x.gas), n };
  return { value: n > 0 ? Number(x.fee) / n : null, n };
}

export async function getBreakdown(db: Db, p: BreakdownParams, now = new Date()) {
  const days = p.window === "24h" ? 1 : p.window === "7d" ? 7 : 30;
  const start = p.window === "24h" ? new Date(now.getTime() - DAY) : new Date(Date.parse(now.toISOString().slice(0, 10)) - (days - 1) * DAY);
  let r: Row[];
  if (p.window === "24h" && p.by === "action") {
    r = await rows(db, sql`SELECT action AS key, sum(tx_count) AS n, sum(fee_usd_sum) AS fee FROM agg_minute WHERE ts >= ${start} AND ts < ${now} GROUP BY 1`);
  } else if (p.window === "24h") {
    r = await rows(db, sql`SELECT subsidy_class AS key, count(*) AS n, sum(fee_usd) AS fee FROM txs WHERE ts >= ${start} AND ts < ${now} GROUP BY 1`);
  } else {
    const column = p.by === "action" ? sql`action` : sql`subsidy_class`;
    r = await rows(db, sql`SELECT ${column} AS key, sum(tx_count) AS n, sum(fee_usd_avg * tx_count) AS fee FROM agg_day WHERE date >= ${start.toISOString().slice(0, 10)}::date AND date <= ${now.toISOString().slice(0, 10)}::date GROUP BY 1`);
  }
  const total = r.reduce((s, x) => s + Number(x.n), 0);
  const items = r
    .map((x) => ({ key: String(x.key), tx_count: Number(x.n), share: total > 0 ? Number(x.n) / total : 0, avg_fee_usd: Number(x.n) > 0 ? Number(x.fee) / Number(x.n) : null }))
    .sort((a, b) => b.tx_count - a.tx_count);
  return { by: p.by, window: { key: p.window, start: start.toISOString(), end: now.toISOString() }, n: total, items, generated_at: new Date().toISOString() };
}

// Ticker readout. Windows are anchored on the newest ingested block, not the wall clock, so a paused
// or lagging Collector shows its last real numbers together with the lag instead of empty values.
// One statement, one database round trip: the Ticker polls this every 5 seconds.
export async function getStats(db: Db) {
  const [r] = await rows(db, sql`
    WITH latest AS (SELECT number, ts, base_fee FROM blocks ORDER BY number DESC LIMIT 1),
    price AS (SELECT ts, eth_usd FROM prices ORDER BY ts DESC LIMIT 1),
    tps AS (SELECT sum(b.tx_count) AS n, min(b.ts) AS first FROM blocks b, latest l
            WHERE b.ts > l.ts - interval '1 minute' AND b.ts <= l.ts),
    hour AS (SELECT sum(a.tx_count) AS n, sum(a.fee_usd_sum) AS fee, min(a.ts) AS first FROM agg_minute a, latest l
             WHERE a.ts >= l.ts - interval '1 hour' AND a.ts <= l.ts),
    med AS (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY t.fee_usd) AS median FROM txs t, latest l
            WHERE t.ts >= l.ts - interval '1 hour' AND t.ts <= l.ts),
    day AS (SELECT sum(a.tx_count) AS n, min(a.ts) AS first FROM agg_minute a, latest l
            WHERE a.ts >= l.ts - interval '24 hours' AND a.ts <= l.ts),
    sub AS (SELECT count(*) AS n FROM txs t, latest l
            WHERE t.subsidy_class = 'likely_subsidized' AND t.ts >= l.ts - interval '24 hours' AND t.ts <= l.ts)
    SELECT l.number, l.ts, l.base_fee, p.ts AS price_ts, p.eth_usd,
           tps.n AS tps_n, tps.first AS tps_first, hour.n AS hour_n, hour.fee AS hour_fee, hour.first AS hour_first,
           med.median, day.n AS day_n, day.first AS day_first, sub.n AS sub_n
    FROM (SELECT 1) one
    LEFT JOIN latest l ON true
    LEFT JOIN price p ON true
    CROSS JOIN tps CROSS JOIN hour CROSS JOIN med CROSS JOIN day CROSS JOIN sub`);

  const price = r?.price_ts ? { ts: iso(r.price_ts), eth_usd: num(r.eth_usd) } : null;
  if (!r || r.number === null || r.number === undefined) return { latest: null, price } as const;

  const end = new Date(String(iso(r.ts)));
  // Block timestamps have 1-second resolution; the span is at least one second to avoid dividing by zero.
  const tpsSeconds = r.tps_first ? Math.max(1, (end.getTime() - new Date(String(iso(r.tps_first))).getTime()) / 1000 + 1) : null;
  const tpsN = Number(r.tps_n ?? 0);
  const hourN = Number(r.hour_n ?? 0);
  const dayN = Number(r.day_n ?? 0);
  return {
    latest: {
      block: Number(r.number),
      ts: end.toISOString(),
      base_fee_wei: r.base_fee === null ? null : String(r.base_fee),
    },
    price,
    tps: { value: tpsSeconds ? tpsN / tpsSeconds : null, n: tpsN, window: { start: iso(r.tps_first), end: end.toISOString() } },
    fees: {
      avg_usd: hourN > 0 ? Number(r.hour_fee) / hourN : null,
      median_usd: num(r.median),
      n: hourN,
      window: { start: iso(r.hour_first), end: end.toISOString() },
    },
    subsidized: { ratio: dayN > 0 ? Number(r.sub_n ?? 0) / dayN : null, n: dayN, window: { start: iso(r.day_first), end: end.toISOString() } },
  } as const;
}
