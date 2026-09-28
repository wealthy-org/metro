import { sql } from "drizzle-orm";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { Db } from "../db/client.ts";
import { CITY_ACTIONS } from "../lib/city.ts";
import { resolveRange } from "../server/city.ts";
import { holderStats, ponsNonHolders } from "../server/holders.ts";
import { iso, num, numOrNull, rows } from "../server/query.ts";

// Ledger of Facts (PROJECT.md 13.1): every number an insight cites, computed by SQL and code (never an LLM), with its
// sample size and window. Windows end at the anchor (the newest ingested block) and are built with the lenses' own
// range function, so an evidence link opened at the anchor minute shows the same number (AT 16).

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// A block using this share of its gas limit counts as full (Phase 7 D3).
export const FULL_BLOCK_SHARE = 0.9;

export type Span = { start: Date; end: Date };
export type FactDraft = { key: string; start: Date; end: Date; value: number; n: number };

export type Windows = {
  anchor: Date;
  w1: Span;
  w24: Span;
  prev24: Span;
  baseline24: Span; // the 24 h before w1, for the fail-rate comparison
  w7: Span;
  hours: Span[]; // the 24 clock hours ending with the anchor's hour (Heatmap cells)
  before: Span;
  after: Span | null;
};

const floorHour = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
const span = (start: number, end: number): Span => ({ start: new Date(start), end: new Date(end) });

export function engineWindows(anchor: Date, subsidyEnd: Date): Windows {
  const r1 = resolveRange("1h", anchor);
  const r24 = resolveRange("24h", anchor);
  const r7 = resolveRange("7d", anchor);
  const s1 = (r1.start ?? r1.end).getTime();
  const s24 = (r24.start ?? r24.end).getTime();
  const h0 = floorHour(anchor.getTime()) - 23 * HOUR_MS;
  const e = subsidyEnd.getTime();
  // "After" runs from the subsidy end to the end of the anchor's UTC day, at most 7 days (PROJECT.md 10.7 default).
  const dayEnd = Date.parse(`${anchor.toISOString().slice(0, 10)}T00:00:00Z`) + DAY_MS;
  return {
    anchor,
    w1: { start: new Date(s1), end: r1.end },
    w24: { start: new Date(s24), end: r24.end },
    prev24: span(s24 - DAY_MS, s24),
    baseline24: span(s1 - DAY_MS, s1),
    w7: { start: r7.start ?? r7.end, end: r7.end },
    hours: Array.from({ length: 24 }, (_, i) => span(h0 + i * HOUR_MS, h0 + (i + 1) * HOUR_MS)),
    before: span(e - 7 * DAY_MS, e),
    after: anchor.getTime() >= e ? span(e, Math.min(e + 7 * DAY_MS, dayEnd)) : null,
  };
}

// percentile_disc(0.5), as in the rollups: an actual value, the lower middle one for even counts.
export function medianDisc(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null;
}

const between = (col: ReturnType<typeof sql.raw>, s: Span) => sql`${col} >= ${s.start} AND ${col} < ${s.end}`;
const TS = sql.raw("ts");

export type FactContext = { labels: Record<string, string>; complete: Record<string, boolean> };

export async function computeFacts(db: Db, w: Windows): Promise<{ facts: FactDraft[]; ctx: FactContext }> {
  const facts: FactDraft[] = [];
  const push = (key: string, s: Span, value: number | null, n: number) => {
    if (value !== null && Number.isFinite(value)) facts.push({ key, start: s.start, end: s.end, value, n });
  };
  const hoursSpan: Span = { start: w.hours[0]?.start ?? w.w24.start, end: w.hours.at(-1)?.end ?? w.w24.end };

  const [swapHours, actionMedians, baseFee, subsidy, wallets, failNow, failBase, failTop, blocks, blockPeak, mixNow, mixPrev, launches] = await Promise.all([
    // Rule 1: median swap fee per clock hour (the Heatmap cell and its Inspector hour).
    rows(db, sql`
      SELECT date_trunc('hour', ts) AS h, percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS m, count(*) AS n
      FROM txs WHERE action = 'swap' AND ${between(TS, hoursSpan)} GROUP BY 1`),
    // Rule 2: median fee per action over the 24 h window (City, Inspector per action).
    rows(db, sql`
      SELECT action AS a, percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS m, count(*) AS n
      FROM txs WHERE ${between(TS, w.w24)} GROUP BY 1`),
    // Rule 3: average base fee per clock hour over the 7 days (the Heatmap gas price cell).
    rows(db, sql`
      SELECT date_trunc('hour', ts) AS h, avg(base_fee) / 1e9 AS v, count(*) AS n
      FROM blocks WHERE base_fee IS NOT NULL AND ${between(TS, w.w7)} GROUP BY 1 ORDER BY 1`),
    // Rule 4: paid share and transactions per day, 7 days before and after the subsidy end (agg_day; KL-6 estimate).
    Promise.all([w.before, w.after].map((s) =>
      s
        ? rows(db, sql`
            SELECT sum(tx_count) AS n, coalesce(sum(tx_count) FILTER (WHERE subsidy_class = 'likely_paid'), 0) AS paid,
                   count(DISTINCT date) AS days
            FROM agg_day WHERE date >= ${s.start.toISOString().slice(0, 10)}::date AND date < ${s.end.toISOString().slice(0, 10)}::date`)
        : Promise.resolve([]),
    )),
    // Rule 7: the busiest sender per action over 24 h, the ArbOS system sender left out (KL-7).
    rows(db, sql`
      WITH c AS (
        SELECT action, from_address AS a, count(*) AS n FROM txs
        WHERE ${between(TS, w.w24)} AND from_address <> ${ARBOS_SENDER} GROUP BY 1, 2
      ), t AS (SELECT action, sum(n) AS total, max(n) AS top FROM c GROUP BY 1)
      SELECT DISTINCT ON (c.action) c.action, c.a, c.n, t.total FROM c JOIN t USING (action)
      WHERE c.n = t.top ORDER BY c.action, c.a`),
    // Rule 8: fail rate in the last hour, the 24 h before it, and the action with the most failures now.
    rows(db, sql`SELECT count(*) AS n, count(*) FILTER (WHERE status = 0) AS f FROM txs WHERE ${between(TS, w.w1)}`),
    rows(db, sql`SELECT count(*) AS n, count(*) FILTER (WHERE status = 0) AS f FROM txs WHERE ${between(TS, w.baseline24)}`),
    rows(db, sql`
      SELECT action AS a, count(*) AS n, count(*) FILTER (WHERE status = 0) AS f FROM txs
      WHERE ${between(TS, w.w1)} GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT 1`),
    // Rule 9: blocks at or above FULL_BLOCK_SHARE of their gas limit (KL-11), and the hour with the most.
    rows(db, sql`
      SELECT count(*) AS n, count(*) FILTER (WHERE gas_used >= ${FULL_BLOCK_SHARE} * gas_limit) AS f
      FROM blocks WHERE ${between(TS, w.w24)}`),
    rows(db, sql`
      SELECT date_trunc('hour', ts) AS h, count(*) AS n, count(*) FILTER (WHERE gas_used >= ${FULL_BLOCK_SHARE} * gas_limit) AS f
      FROM blocks WHERE ${between(TS, w.w24)} GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT 1`),
    // Rule 10: share of each action in two consecutive 24 h windows (agg_minute, as the City counts them).
    rows(db, sql`SELECT action AS a, sum(tx_count) AS n FROM agg_minute WHERE ${between(TS, w.w24)} GROUP BY 1`),
    rows(db, sql`SELECT action AS a, sum(tx_count) AS n FROM agg_minute WHERE ${between(TS, w.prev24)} GROUP BY 1`),
    // Rules 5 and 6: the Pons tokens launched up to the anchor that have ingested transfers.
    rows(db, sql`
      SELECT k.address, k.symbol, l.block, l.ts, l.params->>'topic2' AS pool
      FROM tokens k JOIN pons_launches l ON l.token_address = k.address
      WHERE k.is_pons AND l.ts <= ${w.anchor}
        AND EXISTS (SELECT 1 FROM token_transfers tt WHERE tt.token_address = k.address AND tt.ts <= ${w.anchor})
      ORDER BY l.ts DESC LIMIT 100`),
  ]);

  for (const x of swapHours) {
    const h = iso(x.h);
    if (h) push("median_fee_usd.swap.hour", span(Date.parse(h), Date.parse(h) + HOUR_MS), numOrNull(x.m), num(x.n));
  }
  for (const x of actionMedians) {
    const a = String(x.a);
    if (CITY_ACTIONS.some((c) => c.key === a)) push(`median_fee_usd.${a}`, w.w24, numOrNull(x.m), num(x.n));
  }

  const hourly = baseFee.map((x) => ({ h: iso(x.h), v: numOrNull(x.v), n: num(x.n) })).filter((x): x is { h: string; v: number; n: number } => x.h !== null && x.v !== null);
  for (const x of hourly) push("base_fee_gwei.hour", span(Date.parse(x.h), Date.parse(x.h) + HOUR_MS), x.v, x.n);
  push("base_fee_gwei.median_hourly", w.w7, medianDisc(hourly.map((x) => x.v)), hourly.length);

  (["before", "after"] as const).forEach((side, i) => {
    const s = side === "before" ? w.before : w.after;
    const r = subsidy[i]?.[0];
    if (!s || !r) return;
    const n = num(r.n);
    const days = num(r.days);
    push(`days_covered.${side}`, s, days, days);
    if (n > 0) {
      push(`paid_share.${side}`, s, num(r.paid) / n, n);
      push(`tx_per_day.${side}`, s, n / Math.max(1, days), n);
    }
  });

  for (const x of wallets) {
    const total = num(x.total);
    if (total > 0) push(`wallet_share.${String(x.action)}.${String(x.a)}`, w.w24, num(x.n) / total, total);
  }

  const rate = (r: Record<string, unknown> | undefined) => (r && num(r.n) > 0 ? num(r.f) / num(r.n) : null);
  push("fail_rate.all", w.w1, rate(failNow[0]), num(failNow[0]?.n));
  push("fail_rate.all", w.baseline24, rate(failBase[0]), num(failBase[0]?.n));
  if (failTop[0] && num(failTop[0].f) > 0) push(`fail_rate.${String(failTop[0].a)}`, w.w1, rate(failTop[0]), num(failTop[0].n));

  push("full_blocks", w.w24, num(blocks[0]?.f), num(blocks[0]?.n));
  const peak = blockPeak[0];
  const ph = iso(peak?.h);
  if (peak && ph && num(peak.f) > 0) push("full_blocks.hour", span(Date.parse(ph), Date.parse(ph) + HOUR_MS), num(peak.f), num(peak.n));

  for (const [mix, s] of [[mixNow, w.w24], [mixPrev, w.prev24]] as const) {
    const total = mix.reduce((t, x) => t + num(x.n), 0);
    if (total === 0) continue;
    for (const x of mix) push(`action_share.${String(x.a)}`, s, num(x.n) / total, total);
  }

  const labels: Record<string, string> = {};
  const complete: Record<string, boolean> = {};
  const stats = await Promise.all(launches.map((x) => holderStats(db, String(x.address), numOrNull(x.block), w.anchor, ponsNonHolders(x.pool))));
  launches.forEach((x, i) => {
    const address = String(x.address);
    const h = stats[i];
    if (!h || h.holders === 0) return;
    labels[address] = x.symbol ? String(x.symbol) : `${address.slice(0, 6)}…${address.slice(-4)}`;
    complete[address] = h.complete;
    const launched = iso(x.ts);
    push(`holder_growth_24h.${address}`, span(w.anchor.getTime() - DAY_MS, w.anchor.getTime()), h.holders - h.holders_24h_ago, h.holders);
    const since = launched ? span(Date.parse(launched), w.anchor.getTime()) : span(w.anchor.getTime(), w.anchor.getTime());
    push(`top10_share.${address}`, since, h.top10_share, h.holders);
    push(`pool_share.${address}`, since, h.pool_share, h.holders);
  });

  return { facts, ctx: { labels, complete } };
}
