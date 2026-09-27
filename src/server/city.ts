import { sql, type SQL } from "drizzle-orm";
import { EXPLORER_URL } from "../../config/known-contracts.ts";
import type { Db } from "../db/client.ts";
import type { CityResponse, CityWindowInfo, InspectorResponse, InspectorSample } from "../lib/api-types.ts";
import {
  actionLabel,
  CITY_ACTIONS,
  CITY_WINDOWS,
  isCityAction,
  isCityWindow,
  MAX_TOKEN_BUILDINGS,
  RAW_WINDOW_MAX_SECONDS,
  type CityBuilding,
  type CityWindow,
} from "../lib/city.ts";

// City lens reads (PROJECT.md 10.1, 11.1, 18). Windows are anchored on the newest ingested block, like the Ticker.

type Row = Record<string, unknown>;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
// Distinct wallets, failures and token movement can only come from raw rows. Raw windows are minute-aligned, so a
// result stays valid until the next minute; the TTL bounds how long a stale anchor can linger in memory.
const RAW_CACHE_MS = 60_000;
const rawCache = new Map<string, { at: number; value: Promise<Row[]> }>();

function cachedRows(db: Db, key: string, query: SQL): Promise<Row[]> {
  const now = Date.now();
  for (const [k, v] of rawCache) if (now - v.at >= RAW_CACHE_MS) rawCache.delete(k);
  const hit = rawCache.get(key);
  if (hit) return hit.value;
  // Concurrent callers share the in-flight query; a failure is not kept.
  const value = rows(db, query).catch((err: unknown) => {
    rawCache.delete(key);
    throw err;
  });
  rawCache.set(key, { at: now, value });
  return value;
}

async function rows(db: Db, query: SQL): Promise<Row[]> {
  return (await db.execute(query)).rows as Row[];
}
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? new Date(v).toISOString() : null);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// Half-open time range [start, end) over txs, or null start for "everything up to end".
type Range = { basis: "txs" | "agg_day"; start: Date | null; end: Date; startDay: string | null; endDay: string };

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

const txTime = (r: Range, column: SQL) => (r.start === null ? sql`${column} < ${r.end}` : sql`${column} >= ${r.start} AND ${column} < ${r.end}`);
const dayRange = (r: Range) => (r.startDay === null ? sql`date <= ${r.endDay}::date` : sql`date >= ${r.startDay}::date AND date <= ${r.endDay}::date`);

async function anchorOf(db: Db): Promise<Date | null> {
  const [latest] = await rows(db, sql`SELECT ts FROM blocks ORDER BY number DESC LIMIT 1`);
  const ts = iso(latest?.ts);
  return ts ? new Date(ts) : null;
}

type Stats = { key: string; tx_count: number; gas_volume: number; avg_fee_usd: number | null; wallets: number | null; failed: number | null };

const rangeKey = (r: Range) => `${r.basis}|${r.start?.toISOString() ?? "-"}|${r.end.toISOString()}`;

// `withRaw: false` skips the txs scan when only the additive figures are needed (the Inspector's previous window).
async function actionStats(db: Db, r: Range, only?: string, withRaw = true): Promise<Stats[]> {
  const filter = only ? sql`AND action = ${only}` : sql``;
  if (r.basis === "txs") {
    // Additive figures from the minute rollups (small); only the distinct and failure counts scan txs.
    const [additive, rawOnly] = await Promise.all([
      rows(db, sql`
        SELECT action AS key, sum(tx_count) AS n, sum(gas_used) AS gas, sum(fee_usd_sum) / nullif(sum(tx_count), 0) AS fee
        FROM agg_minute WHERE ${txTime(r, sql`ts`)} ${filter} GROUP BY action`),
      withRaw
        ? cachedRows(
            db,
            `actions|${rangeKey(r)}|${only ?? "*"}`,
            sql`SELECT action AS key, count(DISTINCT from_address) AS w, count(*) FILTER (WHERE status = 0) AS failed
                FROM txs WHERE ${txTime(r, sql`ts`)} ${filter} GROUP BY action`,
          )
        : Promise.resolve([] as Row[]),
    ]);
    const raw = new Map(rawOnly.map((x) => [String(x.key), x]));
    return additive.map((x) => {
      const extra = raw.get(String(x.key));
      return {
        key: String(x.key),
        tx_count: num(x.n),
        gas_volume: num(x.gas),
        avg_fee_usd: numOrNull(x.fee),
        wallets: withRaw ? num(extra?.w) : null,
        failed: withRaw ? num(extra?.failed) : null,
      };
    });
  }
  const out = await rows(db, sql`
    SELECT action AS key, sum(tx_count) AS n, sum(gas_used) AS gas,
           sum(fee_usd_avg * tx_count) / nullif(sum(tx_count), 0) AS fee, sum(failed_tx_count) AS failed
    FROM agg_day WHERE ${dayRange(r)} ${filter} GROUP BY action`);
  return out.map((x) => ({ key: String(x.key), tx_count: num(x.n), gas_volume: num(x.gas), avg_fee_usd: numOrNull(x.fee), wallets: null, failed: num(x.failed) }));
}

type TokenStats = Stats & { symbol: string | null; name: string | null };

// Pons tokens ranked by the number of transactions that moved them (PROJECT.md 10.1 district). Token movement lives
// only in raw rows, so the result is cached like the other raw-only figures.
async function tokenStats(db: Db, r: Range, only?: string, limit = MAX_TOKEN_BUILDINGS): Promise<TokenStats[]> {
  const filter = only ? sql`AND tt.token_address = ${only}` : sql``;
  const out = await cachedRows(db, `tokens|${rangeKey(r)}|${only ?? "*"}|${limit}`, sql`
    WITH moved AS (
      SELECT DISTINCT tt.token_address, tt.tx_hash, tt.ts
      FROM token_transfers tt JOIN tokens k ON k.address = tt.token_address
      WHERE k.is_pons AND ${txTime(r, sql`tt.ts`)} ${filter}
    )
    SELECT m.token_address AS key, k.symbol, k.name, count(*) AS n, sum(t.gas_used) AS gas, avg(t.fee_usd) AS fee,
           count(DISTINCT t.from_address) AS w
    FROM moved m
    JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts
    JOIN tokens k ON k.address = m.token_address
    GROUP BY m.token_address, k.symbol, k.name
    ORDER BY n DESC, m.token_address
    LIMIT ${limit}`);
  const raw = r.basis === "txs";
  return out.map((x) => ({
    key: String(x.key),
    symbol: x.symbol === null ? null : String(x.symbol),
    name: x.name === null ? null : String(x.name),
    tx_count: num(x.n),
    gas_volume: num(x.gas),
    avg_fee_usd: numOrNull(x.fee),
    wallets: raw ? num(x.w) : null,
    failed: null,
  }));
}

const tokenLabel = (t: { key: string; symbol: string | null }) => t.symbol || `${t.key.slice(0, 6)}…${t.key.slice(-4)}`;
const failRate = (s: Stats | undefined) => (!s || s.failed === null || s.tx_count === 0 ? null : s.failed / s.tx_count);

// The figures never extend past the newest ingested block, so the window ends there for both bases.
function windowInfo(key: CityWindow, r: Range | null, firstTs: string | null, anchor: Date | null): CityWindowInfo {
  if (!r || !anchor) return { key, start: null, end: null, basis: "txs" };
  return { key, start: r.start ? r.start.toISOString() : firstTs, end: anchor.toISOString(), basis: r.basis };
}

async function firstDataTs(db: Db, r: Range): Promise<string | null> {
  if (r.start !== null) return null;
  const [first] = await rows(db, sql`SELECT min(date) AS d FROM agg_day`);
  return first?.d ? `${String(first.d).slice(0, 10)}T00:00:00.000Z` : null;
}

export async function getCity(db: Db, window: CityWindow, anchor?: Date): Promise<CityResponse> {
  const at = anchor ?? (await anchorOf(db));
  const generated_at = new Date().toISOString();
  if (!at) return { window: windowInfo(window, null, null, null), buildings: [], other_tx_count: 0, n: 0, generated_at };

  const r = resolveRange(window, at);
  const [actions, tokens, firstTs] = await Promise.all([actionStats(db, r), tokenStats(db, r), firstDataTs(db, r)]);
  const byKey = new Map(actions.map((a) => [a.key, a]));
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
        wallets: r.basis === "txs" ? (s?.wallets ?? 0) : null,
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
    generated_at,
  };
}

export type InspectorParams = { kind: "action" | "token"; key: string; window: CityWindow };

export function parseInspectorParams(params: URLSearchParams): InspectorParams | string {
  const kind = params.get("kind");
  const key = (params.get("key") ?? "").toLowerCase();
  const window = params.get("window") ?? "24h";
  if (kind !== "action" && kind !== "token") return "kind must be action or token";
  if (kind === "action" && !isCityAction(key)) return `key must be one of ${CITY_ACTIONS.map((a) => a.key).join(", ")}`;
  if (kind === "token" && !/^0x[0-9a-f]{40}$/.test(key)) return "key must be a token address";
  if (!isCityWindow(window)) return `window must be one of ${CITY_WINDOWS.map((w) => w.key).join(", ")}`;
  return { kind, key, window };
}

const TREND_BUCKET = { "1h": "5m", "24h": "1h" } as const;
const BUCKET_INTERVAL = { "5m": "5 minutes", "1h": "1 hour", "1d": "1 day" } as const;

async function trend(db: Db, p: InspectorParams, r: Range): Promise<InspectorResponse["trend"]> {
  const bucket = p.window === "1h" || p.window === "24h" ? TREND_BUCKET[p.window] : "1d";
  const interval = BUCKET_INTERVAL[bucket];
  let out: Row[];
  if (p.kind === "action" && bucket !== "1d") {
    out = await rows(db, sql`
      SELECT date_bin(${interval}::interval, ts, timestamptz '2000-01-01') AS ts, sum(tx_count) AS n
      FROM agg_minute WHERE action = ${p.key} AND ${txTime(r, sql`ts`)} GROUP BY 1 ORDER BY 1`);
  } else if (p.kind === "action") {
    out = await rows(db, sql`SELECT date AS ts, sum(tx_count) AS n FROM agg_day WHERE action = ${p.key} AND ${dayRange(r)} GROUP BY 1 ORDER BY 1`);
  } else {
    out = await rows(db, sql`
      SELECT date_bin(${interval}::interval, ts, timestamptz '2000-01-01') AS ts, count(DISTINCT tx_hash) AS n
      FROM token_transfers WHERE token_address = ${p.key} AND ${txTime(r, sql`ts`)} GROUP BY 1 ORDER BY 1`);
  }
  return {
    bucket,
    points: out.map((x) => ({ ts: iso(x.ts) ?? `${String(x.ts).slice(0, 10)}T00:00:00.000Z`, n: num(x.n) })),
  };
}

async function samples(db: Db, p: InspectorParams, r: Range): Promise<InspectorSample[]> {
  const out =
    p.kind === "action"
      ? await rows(db, sql`
          SELECT hash, block, ts, fee_usd, status FROM txs
          WHERE action = ${p.key} AND ${txTime(r, sql`ts`)} ORDER BY ts DESC, hash LIMIT 5`)
      : await rows(db, sql`
          SELECT DISTINCT t.hash, t.block, t.ts, t.fee_usd, t.status
          FROM token_transfers tt JOIN txs t ON t.hash = tt.tx_hash AND t.ts = tt.ts
          WHERE tt.token_address = ${p.key} AND ${txTime(r, sql`tt.ts`)} ORDER BY t.ts DESC, t.hash LIMIT 5`);
  return out.map((x) => ({
    hash: String(x.hash),
    block: num(x.block),
    ts: iso(x.ts) ?? "",
    fee_usd: num(x.fee_usd),
    status: num(x.status) === 1 ? "success" : "failed",
    explorer_url: `${EXPLORER_URL}/tx/${String(x.hash)}`,
  }));
}

// Returns null when a token address is not a known Pons token.
export async function getInspector(db: Db, p: InspectorParams, anchor?: Date): Promise<InspectorResponse | null> {
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
  const label = p.kind === "action" ? actionLabel(p.key) : tokenLabel({ key: p.key, symbol: token?.symbol ?? null });
  const at = anchor ?? (await anchorOf(db));
  const empty = { tx_count: 0, gas_volume: 0, avg_fee_usd: null, wallets: null, fail_rate: null };
  if (!at) {
    return { kind: p.kind, key: p.key, label, window: windowInfo(p.window, null, null, null), values: empty, previous: null, trend: { bucket: "1h", points: [] }, samples: [], token, generated_at: new Date().toISOString() };
  }

  const r = resolveRange(p.window, at);
  const prev = previousRange(r);
  const stats = (range: Range, withRaw: boolean) => (p.kind === "action" ? actionStats(db, range, p.key, withRaw) : tokenStats(db, range, p.key, 1));
  const [[now], prevStats, tr, sm, firstTs] = await Promise.all([
    stats(r, true),
    prev ? stats(prev, false) : Promise.resolve(null),
    trend(db, p, r),
    samples(db, p, r),
    firstDataTs(db, r),
  ]);
  const prevN = prevStats ? (prevStats[0]?.tx_count ?? 0) : null;
  const n = now?.tx_count ?? 0;
  return {
    kind: p.kind,
    key: p.key,
    label,
    window: windowInfo(p.window, r, firstTs, at),
    values: {
      tx_count: n,
      gas_volume: now?.gas_volume ?? 0,
      avg_fee_usd: now?.avg_fee_usd ?? null,
      wallets: r.basis === "txs" ? (now?.wallets ?? 0) : null,
      fail_rate: p.kind === "action" ? failRate(now) : null,
    },
    previous: prevN === null ? null : { tx_count: prevN, change: prevN > 0 ? (n - prevN) / prevN : null },
    trend: tr,
    samples: sm,
    token,
    generated_at: new Date().toISOString(),
  };
}
