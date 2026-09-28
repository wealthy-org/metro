import { sql, type SQL } from "drizzle-orm";
import { ARBOS_SENDER, EXPLORER_URL } from "../../config/known-contracts.ts";
import type { Db } from "../db/client.ts";
import type { CityResponse, CityWindowInfo, InspectorResponse, InspectorSample } from "../lib/api-types.ts";
import { actionLabel, CITY_ACTIONS, CITY_WINDOWS, isCityAction, MAX_TOKEN_BUILDINGS, RAW_WINDOW_MAX_SECONDS, type CityBuilding, type CityWindow } from "../lib/city.ts";
import { isoMinuteDate, NO_FILTERS, rawFilterCount, type Filters } from "../lib/view-state.ts";
import { anchorAt, coverage, filterKey, parseDataParams, subsidyEnd, txFilter } from "./filters.ts";
import { tokenMarkets } from "./gecko.ts";
import { cachedRows, iso, isoDay, num, numOrNull, rows, type Row } from "./query.ts";

// City lens and Inspector reads (PROJECT.md 10.1, 11.1, 11.2, 18). Windows end at the anchor: the newest ingested
// block, or the newest block at or before the scrubber time (11.3).

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// Half-open time range [start, end) over txs, or null start for "everything up to end".
export type Range = { basis: "txs" | "agg_day"; start: Date | null; end: Date; startDay: string | null; endDay: string };

export function resolveRange(window: CityWindow, anchor: Date): Range {
  const spec = CITY_WINDOWS.find((w) => w.key === window);
  const seconds = spec?.seconds ?? null;
  if (seconds !== null && seconds <= RAW_WINDOW_MAX_SECONDS) {
    // Raw windows are whole minutes ending with the anchor's minute, so agg_minute rows and txs rows cover exactly
    // the same span. Nothing newer than the anchor block exists yet, so the anchor's minute holds no extra data.
    const end = new Date(Math.floor(anchor.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
    return { basis: "txs", start: new Date(end.getTime() - seconds * 1000), end, startDay: null, endDay: isoDay(anchor) };
  }
  // Daily windows cover whole UTC days ending with the anchor's day.
  const endDay = isoDay(anchor);
  const dayEnd = new Date(Date.parse(`${endDay}T00:00:00Z`) + DAY_MS);
  if (seconds === null) return { basis: "agg_day", start: null, end: dayEnd, startDay: null, endDay };
  const days = Math.round(seconds / 86_400);
  const startDay = isoDay(new Date(Date.parse(`${endDay}T00:00:00Z`) - (days - 1) * DAY_MS));
  return { basis: "agg_day", start: new Date(`${startDay}T00:00:00Z`), end: dayEnd, startDay, endDay };
}

// Same-length range immediately before `r`; null for the open-ended "all" window.
function previousRange(r: Range): Range | null {
  if (r.start === null) return null;
  const span = r.end.getTime() - r.start.getTime();
  const start = new Date(r.start.getTime() - span);
  return { ...r, start, end: r.start, startDay: r.startDay ? isoDay(start) : null, endDay: isoDay(new Date(r.start.getTime() - 1)) };
}

export const txTime = (r: Range, column: SQL) => (r.start === null ? sql`${column} < ${r.end}` : sql`${column} >= ${r.start} AND ${column} < ${r.end}`);
export const dayRange = (r: Range) => (r.startDay === null ? sql`date <= ${r.endDay}::date` : sql`date >= ${r.startDay}::date AND date <= ${r.endDay}::date`);
const rangeKey = (r: Range) => `${r.basis}|${r.start?.toISOString() ?? "-"}|${r.end.toISOString()}`;
const actionFilter = (f: Filters) => (f.action ? sql`AND action = ${f.action}` : sql``);

// `paid`: transactions classed likely_paid (PROJECT.md 12.2 estimate, KL-6); null when the query did not count it.
// `system`: ArbOS internal transactions, left out of the paid-share denominator (Phase 8 D2, KL-7).
type Stats = { key: string; tx_count: number; gas_volume: number; avg_fee_usd: number | null; wallets: number | null; failed: number | null; paid: number | null; system: number };

const statsRow = (x: Row, withRaw: boolean): Stats => ({
  key: String(x.key),
  tx_count: num(x.n),
  gas_volume: num(x.gas),
  avg_fee_usd: numOrNull(x.fee),
  wallets: withRaw ? num(x.w) : null,
  failed: withRaw ? num(x.failed) : null,
  paid: x.paid === undefined || x.paid === null ? null : num(x.paid),
  system: num(x.sys),
});
const PAID = sql`count(*) FILTER (WHERE subsidy_class = 'likely_paid') AS paid, count(*) FILTER (WHERE from_address = ${ARBOS_SENDER}) AS sys`;

// `withRaw: false` skips the txs scan when only the additive figures are needed (the Inspector's previous window).
async function actionStats(db: Db, r: Range, f: Filters, only?: string, withRaw = true): Promise<Stats[]> {
  const onlyFilter = only ? sql`AND action = ${only}` : sql``;
  if (r.basis === "txs" && rawFilterCount(f) > 0) {
    // Token, value, wallet and status filters need every figure from raw rows (KL-20).
    const out = await cachedRows(
      db,
      `actions-f|${rangeKey(r)}|${only ?? "*"}|${filterKey(f)}`,
      sql`SELECT action AS key, count(*) AS n, sum(gas_used) AS gas, avg(fee_usd) AS fee,
                 count(DISTINCT from_address) AS w, count(*) FILTER (WHERE status = 0) AS failed, ${PAID}
          FROM txs WHERE ${txTime(r, sql`ts`)} ${txFilter(f, "txs")} ${onlyFilter} GROUP BY action`,
    );
    return out.map((x) => statsRow(x, true));
  }
  if (r.basis === "txs") {
    // Additive figures from the minute rollups (small); only the distinct, failure and paid counts scan txs.
    const [additive, rawOnly] = await Promise.all([
      rows(db, sql`
        SELECT action AS key, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_sum) / nullif(sum(tx_count), 0) AS fee
        FROM agg_minute WHERE ${txTime(r, sql`ts`)} ${actionFilter(f)} ${onlyFilter} GROUP BY action`),
      withRaw
        ? cachedRows(
            db,
            `actions|${rangeKey(r)}|${only ?? "*"}|${f.action ?? "-"}`,
            sql`SELECT action AS key, count(DISTINCT from_address) AS w, count(*) FILTER (WHERE status = 0) AS failed, ${PAID}
                FROM txs WHERE ${txTime(r, sql`ts`)} ${actionFilter(f)} ${onlyFilter} GROUP BY action`,
          )
        : Promise.resolve([] as Row[]),
    ]);
    const raw = new Map(rawOnly.map((x) => [String(x.key), x]));
    return additive.map((x) => {
      const extra = raw.get(String(x.key));
      return statsRow({ ...x, w: extra?.w, failed: extra?.failed, paid: withRaw ? (extra?.paid ?? 0) : null, sys: extra?.sys }, withRaw);
    });
  }
  const out = await rows(db, sql`
    SELECT action AS key, sum(tx_count) AS n, sum(gas_used) AS gas,
           sum(fee_usd_avg * tx_count) / nullif(sum(tx_count), 0) AS fee, sum(failed_tx_count) AS failed,
           coalesce(sum(tx_count) FILTER (WHERE subsidy_class = 'likely_paid'), 0) AS paid, sum(system_tx_count) AS sys
    FROM agg_day WHERE ${dayRange(r)} ${actionFilter(f)} ${onlyFilter} GROUP BY action`);
  return out.map((x) => ({ ...statsRow(x, false), failed: num(x.failed) }));
}

type TokenStats = Stats & { symbol: string | null; name: string | null };

// Pons tokens ranked by the number of transactions that moved them (PROJECT.md 10.1 district, KL-19). Token movement
// lives only in raw rows, so the result is cached like the other raw-only figures.
export async function tokenStats(db: Db, r: Range, f: Filters, only?: string, limit = MAX_TOKEN_BUILDINGS): Promise<TokenStats[]> {
  const onlyFilter = only ? sql`AND tt.token_address = ${only}` : sql``;
  const tokenOnly = f.token ? sql`AND tt.token_address = ${f.token}` : sql``;
  const out = await cachedRows(db, `tokens|${rangeKey(r)}|${only ?? "*"}|${limit}|${filterKey(f)}`, sql`
    WITH moved AS (
      SELECT DISTINCT tt.token_address, tt.tx_hash, tt.ts
      FROM token_transfers tt JOIN tokens k ON k.address = tt.token_address
      WHERE k.is_pons AND ${txTime(r, sql`tt.ts`)} ${onlyFilter} ${tokenOnly}
    )
    SELECT m.token_address AS key, k.symbol, k.name, count(*) AS n, sum(t.gas_used) AS gas, avg(t.fee_usd) AS fee,
           count(DISTINCT t.from_address) AS w, count(*) FILTER (WHERE t.subsidy_class = 'likely_paid') AS paid
    FROM moved m
    JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts
    JOIN tokens k ON k.address = m.token_address
    WHERE true ${txFilter({ ...f, token: null }, "t")}
    GROUP BY m.token_address, k.symbol, k.name
    ORDER BY n DESC, m.token_address
    LIMIT ${limit}`);
  const raw = r.basis === "txs";
  return out.map((x) => ({
    ...statsRow(x, raw),
    symbol: x.symbol === null ? null : String(x.symbol),
    name: x.name === null ? null : String(x.name),
    failed: null,
  }));
}

export const tokenLabel = (t: { key: string; symbol: string | null }) => t.symbol || `${t.key.slice(0, 6)}…${t.key.slice(-4)}`;
const failRate = (s: Stats | undefined) => (!s || s.failed === null || s.tx_count === 0 ? null : s.failed / s.tx_count);
// Among user transactions: ArbOS internal ones never pay a fee and are left out (Phase 8 D2).
const paidShare = (s: Stats | undefined) => (!s || s.paid === null || s.tx_count - s.system <= 0 ? null : s.paid / (s.tx_count - s.system));

// The figures never extend past the anchor block, so the window ends there for both bases.
export function windowInfo(key: CityWindow, r: Range | null, firstTs: string | null, anchor: Date | null): CityWindowInfo {
  if (!r || !anchor) return { key, start: null, end: null, basis: "txs" };
  return { key, start: r.start ? r.start.toISOString() : firstTs, end: anchor.toISOString(), basis: r.basis };
}

export async function firstDataTs(db: Db, r: Range): Promise<string | null> {
  if (r.start !== null) return null;
  const [first] = await rows(db, sql`SELECT min(date) AS d FROM agg_day`);
  return first?.d ? `${String(first.d).slice(0, 10)}T00:00:00.000Z` : null;
}

export async function getCity(db: Db, window: CityWindow, anchor?: Date | null, filters: Filters = NO_FILTERS, rankByVolume = false): Promise<CityResponse> {
  const [at, cov] = await Promise.all([anchor === undefined ? anchorAt(db, null) : Promise.resolve(anchor), coverage(db)]);
  const generated_at = new Date().toISOString();
  if (!at) return { window: windowInfo(window, null, null, null), buildings: [], other_tx_count: 0, n: 0, coverage: cov, filters, subsidy_end: subsidyEnd(), district: { ranked_by: "tx_count", source: null, volumes: null }, generated_at };

  const r = resolveRange(window, at);
  // Pons district (PROJECT.md 10.1): live views rank by 24 h USD volume from GeckoTerminal (Phase 6 D2, KL-19). The
  // candidates are the 30 tokens moved by the most transactions; tokens without market data rank after those with it.
  // A scrubbed view keeps the transaction ranking, since the market figures are "now".
  const [actions, candidates, firstTs] = await Promise.all([
    actionStats(db, r, filters),
    tokenStats(db, r, filters, undefined, rankByVolume ? 30 : MAX_TOKEN_BUILDINGS),
    firstDataTs(db, r),
  ]);
  const markets = rankByVolume && candidates.length ? await tokenMarkets(candidates.map((t) => t.key)) : null;
  const volume = (key: string) => markets?.get(key)?.volume_24h_usd ?? null;
  const tokens = markets
    ? [...candidates].sort((a, b) => (volume(b.key) ?? -1) - (volume(a.key) ?? -1) || b.tx_count - a.tx_count).slice(0, MAX_TOKEN_BUILDINGS)
    : candidates.slice(0, MAX_TOKEN_BUILDINGS);
  const byKey = new Map(actions.map((a) => [a.key, a]));
  const raw = r.basis === "txs";
  const buildings: CityBuilding[] = [
    ...CITY_ACTIONS.map(({ key, label }) => {
      const s = byKey.get(key);
      return {
        kind: "action" as const,
        key,
        label,
        tx_count: s?.tx_count ?? 0,
        gas_volume: s?.gas_volume ?? 0,
        avg_fee_usd: s?.avg_fee_usd ?? null,
        wallets: raw ? (s?.wallets ?? 0) : null,
        fail_rate: failRate(s),
      };
    }),
    ...tokens.map((t) => ({ kind: "token" as const, key: t.key, label: tokenLabel(t), tx_count: t.tx_count, gas_volume: t.gas_volume, avg_fee_usd: t.avg_fee_usd, wallets: t.wallets, fail_rate: null })),
  ];
  return {
    window: windowInfo(window, r, firstTs, at),
    buildings,
    other_tx_count: byKey.get("other")?.tx_count ?? 0,
    n: actions.reduce((s, a) => s + a.tx_count, 0),
    coverage: cov,
    filters,
    subsidy_end: subsidyEnd(),
    district: markets
      ? { ranked_by: "volume_24h_usd", source: "GeckoTerminal", volumes: Object.fromEntries(tokens.map((t) => [t.key, volume(t.key)])) }
      : { ranked_by: "tx_count", source: rankByVolume ? "GeckoTerminal unavailable" : null, volumes: null },
    generated_at,
  };
}

export type InspectorParams = { kind: "action" | "token" | "hour"; key: string; window: CityWindow; filters: Filters; at: string | null };

export function parseInspectorParams(params: URLSearchParams): InspectorParams | string {
  const kind = params.get("kind");
  const rawKey = params.get("key") ?? "";
  const key = kind === "hour" ? rawKey : rawKey.toLowerCase();
  if (kind !== "action" && kind !== "token" && kind !== "hour") return "kind must be action, token or hour";
  if (kind === "action" && !isCityAction(key)) return `key must be one of ${CITY_ACTIONS.map((a) => a.key).join(", ")}`;
  if (kind === "token" && !/^0x[0-9a-f]{40}$/.test(key)) return "key must be a token address";
  if (kind === "hour" && !/^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/.test(key)) return "key must be a UTC hour such as 2026-09-27T15:00Z";
  if (kind === "hour" && !Number.isFinite(isoMinuteDate(key).getTime())) return "key must be a UTC hour such as 2026-09-27T15:00Z";
  const data = parseDataParams(params);
  if (typeof data === "string") return data;
  return { kind, key, ...data };
}

const TREND_BUCKET = { "1h": "5m", "24h": "1h" } as const;
const BUCKET_INTERVAL = { "5m": "5 minutes", "1h": "1 hour", "1d": "1 day" } as const;

async function trend(db: Db, p: InspectorParams, r: Range): Promise<InspectorResponse["trend"]> {
  const bucket = p.kind === "hour" ? "5m" : p.window === "1h" || p.window === "24h" ? TREND_BUCKET[p.window] : "1d";
  const interval = BUCKET_INTERVAL[bucket];
  const f = p.filters;
  const bin = (col: SQL) => sql`date_bin(${interval}::interval, ${col}, timestamptz '2000-01-01')`;
  let out: Row[];
  if (p.kind === "token") {
    out = await rows(db, sql`
      SELECT ${bin(sql`tt.ts`)} AS ts, count(DISTINCT tt.tx_hash) AS n
      FROM token_transfers tt JOIN txs t ON t.hash = tt.tx_hash AND t.ts = tt.ts
      WHERE tt.token_address = ${p.key} AND ${txTime(r, sql`tt.ts`)} ${txFilter({ ...f, token: null }, "t")} GROUP BY 1 ORDER BY 1`);
  } else if (p.kind === "hour" || rawFilterCount(f) > 0) {
    const only = p.kind === "action" ? sql`AND txs.action = ${p.key}` : sql``;
    out = await rows(db, sql`
      SELECT ${bin(sql`ts`)} AS ts, count(*) AS n FROM txs
      WHERE ${txTime(r, sql`ts`)} ${txFilter(f, "txs")} ${only} GROUP BY 1 ORDER BY 1`);
  } else if (bucket !== "1d") {
    out = await rows(db, sql`
      SELECT ${bin(sql`ts`)} AS ts, sum(tx_count) AS n
      FROM agg_minute WHERE action = ${p.key} AND ${txTime(r, sql`ts`)} ${actionFilter(f)} GROUP BY 1 ORDER BY 1`);
  } else {
    out = await rows(db, sql`SELECT date AS ts, sum(tx_count) AS n FROM agg_day WHERE action = ${p.key} AND ${dayRange(r)} ${actionFilter(f)} GROUP BY 1 ORDER BY 1`);
  }
  return {
    bucket,
    points: out.map((x) => ({ ts: iso(x.ts) ?? `${String(x.ts).slice(0, 10)}T00:00:00.000Z`, n: num(x.n) })),
  };
}

async function samples(db: Db, p: InspectorParams, r: Range): Promise<InspectorSample[]> {
  const f = p.filters;
  const out =
    p.kind === "token"
      ? await rows(db, sql`
          SELECT DISTINCT t.hash, t.block, t.ts, t.fee_usd, t.status
          FROM token_transfers tt JOIN txs t ON t.hash = tt.tx_hash AND t.ts = tt.ts
          WHERE tt.token_address = ${p.key} AND ${txTime(r, sql`tt.ts`)} ${txFilter({ ...f, token: null }, "t")}
          ORDER BY t.ts DESC, t.hash LIMIT 5`)
      : await rows(db, sql`
          SELECT hash, block, ts, fee_usd, status FROM txs
          WHERE ${txTime(r, sql`ts`)} ${p.kind === "action" ? sql`AND txs.action = ${p.key}` : sql``} ${txFilter(f, "txs")}
          ORDER BY ts DESC, hash LIMIT 5`);
  return out.map((x) => ({
    hash: String(x.hash),
    block: num(x.block),
    ts: iso(x.ts) ?? "",
    fee_usd: num(x.fee_usd),
    status: num(x.status) === 1 ? "success" : "failed",
    explorer_url: `${EXPLORER_URL}/tx/${String(x.hash)}`,
  }));
}

// "11 Mar, 11:00 to 12:00 UTC": the day format of the prototype's heatmap rows.
const hourLabel = (key: string) => {
  const d = isoMinuteDate(key);
  const day = `${String(d.getUTCDate()).padStart(2, "0")} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
  const h = (n: number) => `${String(n % 24).padStart(2, "0")}:00`;
  return `${day}, ${h(d.getUTCHours())} to ${h(d.getUTCHours() + 1)} UTC`;
};

// One UTC hour, e.g. a heatmap cell: every figure from raw rows (a single hour is small), with the action split.
async function hourStats(db: Db, r: Range, f: Filters): Promise<{ total: Stats | undefined; split: Stats[] }> {
  const out = await cachedRows(db, `hour|${rangeKey(r)}|${filterKey(f)}`, sql`
    SELECT action AS key, count(*) AS n, sum(gas_used) AS gas, avg(fee_usd) AS fee,
           count(DISTINCT from_address) AS w, count(*) FILTER (WHERE status = 0) AS failed, ${PAID}
    FROM txs WHERE ${txTime(r, sql`ts`)} ${txFilter(f, "txs")}
    GROUP BY GROUPING SETS ((action), ())`);
  const total = out.find((x) => x.key === null);
  return {
    total: total ? statsRow({ ...total, key: "all" }, true) : undefined,
    split: out.filter((x) => x.key !== null).map((x) => statsRow(x, true)),
  };
}

// Median fee of the Inspector's subject (Phase 7 D2): the figure the cheapest-hour and cost-ranking insights cite
// (PROJECT.md 13.2), from raw rows, so only for windows of 24 h or less and single hours (KL-17). percentile_disc(0.5)
// as in the rollups and the Ticker: an actual fee, the lower middle one for even counts.
export async function medianFee(db: Db, r: Range, f: Filters, subject: { kind: "action" | "token" | "hour"; key: string }): Promise<number | null> {
  if (r.basis !== "txs" || r.start === null) return null;
  const only = subject.kind === "action" ? sql`AND t.action = ${subject.key}` : sql``;
  const out =
    subject.kind === "token"
      ? await cachedRows(db, `median|${rangeKey(r)}|token|${subject.key}|${filterKey(f)}`, sql`
          WITH moved AS (SELECT DISTINCT tx_hash, ts FROM token_transfers tt WHERE tt.token_address = ${subject.key} AND ${txTime(r, sql`tt.ts`)})
          SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY t.fee_usd) AS m
          FROM moved m JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts WHERE true ${txFilter({ ...f, token: null }, "t")}`)
      : await cachedRows(db, `median|${rangeKey(r)}|${subject.kind}|${subject.key}|${filterKey(f)}`, sql`
          SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY t.fee_usd) AS m
          FROM txs t WHERE ${txTime(r, sql`t.ts`)} ${only} ${txFilter(f, "t")}`);
  return numOrNull(out[0]?.m);
}

// Returns null when a token address is not a known Pons token.
export async function getInspector(db: Db, p: InspectorParams, anchor?: Date | null): Promise<InspectorResponse | null> {
  let token: InspectorResponse["token"] = null;
  if (p.kind === "token") {
    const [t] = await rows(db, sql`
      SELECT k.symbol, k.name, l.creator_address, l.block, l.ts
      FROM tokens k LEFT JOIN pons_launches l ON l.token_address = k.address
      WHERE k.address = ${p.key} AND k.is_pons`);
    if (!t) return null;
    const creator = t.creator_address === null ? null : String(t.creator_address);
    token = {
      symbol: t.symbol === null ? null : String(t.symbol),
      name: t.name === null ? null : String(t.name),
      creator,
      creator_url: creator ? `${EXPLORER_URL}/address/${creator}` : null,
      launch_block: numOrNull(t.block),
      launch_ts: iso(t.ts),
    };
  }
  const label = p.kind === "action" ? actionLabel(p.key) : p.kind === "hour" ? hourLabel(p.key) : tokenLabel({ key: p.key, symbol: token?.symbol ?? null });
  const at = anchor === undefined ? await anchorAt(db, p.at) : anchor;
  const base = { kind: p.kind, key: p.key, label, filters: p.filters, token, breakdown: null };
  const empty = { tx_count: 0, gas_volume: 0, avg_fee_usd: null, median_fee_usd: null, wallets: null, fail_rate: null, paid_share: null };
  if (!at) {
    return { ...base, window: windowInfo(p.window, null, null, null), values: empty, previous: null, trend: { bucket: "1h", points: [] }, samples: [], generated_at: new Date().toISOString() };
  }

  if (p.kind === "hour") {
    const start = isoMinuteDate(p.key);
    const r: Range = { basis: "txs", start, end: new Date(start.getTime() + HOUR_MS), startDay: null, endDay: isoDay(start) };
    const prev: Range = { ...r, start: new Date(start.getTime() - HOUR_MS), end: start };
    const [now, before, tr, sm, median] = await Promise.all([hourStats(db, r, p.filters), hourStats(db, prev, p.filters), trend(db, p, r), samples(db, p, r), medianFee(db, r, p.filters, { kind: "hour", key: p.key })]);
    const n = now.total?.tx_count ?? 0;
    const prevN = before.total?.tx_count ?? 0;
    // A running hour ends at the anchor block; an hour after the anchor has no data yet and ends where it starts.
    const end = new Date(Math.max(start.getTime(), Math.min(at.getTime(), r.end.getTime() - 1)));
    return {
      ...base,
      window: { key: "1h", start: start.toISOString(), end: end.toISOString(), basis: "txs" },
      values: {
        tx_count: n,
        gas_volume: now.total?.gas_volume ?? 0,
        avg_fee_usd: now.total?.avg_fee_usd ?? null,
        median_fee_usd: median,
        wallets: now.total?.wallets ?? 0,
        fail_rate: failRate(now.total),
        paid_share: paidShare(now.total),
      },
      previous: { tx_count: prevN, change: prevN > 0 ? (n - prevN) / prevN : null },
      trend: tr,
      samples: sm,
      breakdown: now.split
        .sort((a, b) => b.tx_count - a.tx_count)
        .map((s) => ({ key: s.key, label: s.key === "other" ? "Other" : actionLabel(s.key), tx_count: s.tx_count })),
      generated_at: new Date().toISOString(),
    };
  }

  const r = resolveRange(p.window, at);
  const prev = previousRange(r);
  const stats = (range: Range, withRaw: boolean) =>
    p.kind === "action" ? actionStats(db, range, p.filters, p.key, withRaw) : tokenStats(db, range, p.filters, p.key, 1);
  const [[now], prevStats, tr, sm, firstTs, median] = await Promise.all([
    stats(r, true),
    prev ? stats(prev, false) : Promise.resolve(null),
    trend(db, p, r),
    samples(db, p, r),
    firstDataTs(db, r),
    medianFee(db, r, p.filters, { kind: p.kind, key: p.key }),
  ]);
  const prevN = prevStats ? (prevStats[0]?.tx_count ?? 0) : null;
  const n = now?.tx_count ?? 0;
  return {
    ...base,
    window: windowInfo(p.window, r, firstTs, at),
    values: {
      tx_count: n,
      gas_volume: now?.gas_volume ?? 0,
      avg_fee_usd: now?.avg_fee_usd ?? null,
      median_fee_usd: median,
      wallets: r.basis === "txs" ? (now?.wallets ?? 0) : null,
      fail_rate: p.kind === "action" ? failRate(now) : null,
      paid_share: paidShare(now),
    },
    previous: prevN === null ? null : { tx_count: prevN, change: prevN > 0 ? (n - prevN) / prevN : null },
    trend: tr,
    samples: sm,
    generated_at: new Date().toISOString(),
  };
}
