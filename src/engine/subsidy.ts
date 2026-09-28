import { sql } from "drizzle-orm";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { Db } from "../db/client.ts";
import { CITY_ACTIONS } from "../lib/city.ts";
import { iso, num, numOrNull, rows } from "../server/query.ts";

// Subsidy Cliff metrics (PROJECT.md 12.3; Phase 8). The windows hold sampled slices of blocks (D1, KL-28), so every
// figure is a rate over the covered blocks or states its coverage: transactions per block and an estimate per day,
// shares, fees, senders in covered blocks. Retention needs every block of both windows and is not measured from
// samples (D3). Paid share leaves ArbOS internal transactions out (D2, KL-7). The subsidy classes are estimates
// (PROJECT.md 12.2, KL-6).

export const BOT_MIN_TX = 20; // a sender with at least this many transactions in a day's covered blocks
export const BOT_PATTERN_SHARE = 0.8; // and at least this share of them to the same contract and method
const FULL_COVERAGE = 0.999;
const DAY_MS = 86_400_000;

export type SubsidyWindow = { start: Date; end: Date }; // [start, end), whole UTC days

export type ActionFigures = {
  key: string;
  tx: number;
  tx_per_block: number | null;
  share: number | null;
  avg_fee_usd: number | null;
  median_fee_usd: number | null;
  paid_share: number | null;
};

export type DayFigures = {
  date: string;
  blocks: number;
  tx: number;
  tx_per_block: number | null;
  paid_share: number | null;
  avg_fee_usd: number | null;
  median_fee_usd: number | null;
  senders: number;
};

export type WindowFigures = {
  start: string;
  end: string;
  days_total: number;
  days_with_data: number;
  days_ended: number;
  blocks_covered: number;
  blocks_expected: number;
  coverage: number | null;
  sampled: boolean;
  tx: number;
  user_tx: number;
  system_tx: number;
  tx_per_block: number | null;
  est_tx_per_day: number | null;
  paid_share: number | null;
  classes: { likely_subsidized: number; likely_paid: number; unknown: number };
  avg_fee_usd: number | null;
  median_fee_usd: number | null;
  senders_per_day: number | null;
  bot: { sender_days: number; bot_sender_days: number; share: number | null; tx_share: number | null };
  actions: ActionFigures[];
  days: DayFigures[];
};

export type SubsidyResult = {
  cliff_date: string;
  blocks_per_day: number | null;
  before: WindowFigures;
  after: WindowFigures;
  retention: { value: number | null; n: number; reason: string | null };
  generated_at: string;
};

const between = (s: SubsidyWindow, col = sql.raw("ts")) => sql`${col} >= ${s.start} AND ${col} < ${s.end}`;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// Blocks per UTC day, from the first and newest ingested blocks (the chain makes about 10 per second). The samples span
// days, so the block-number distance over the time distance is a close estimate.
export async function blocksPerDay(db: Db): Promise<number | null> {
  const [r] = await rows(db, sql`
    SELECT (SELECT number FROM blocks ORDER BY number LIMIT 1) AS lo, (SELECT number FROM blocks ORDER BY number DESC LIMIT 1) AS hi,
           (SELECT ts FROM blocks ORDER BY number LIMIT 1) AS lo_ts, (SELECT ts FROM blocks ORDER BY number DESC LIMIT 1) AS hi_ts`);
  const secs = r ? (Date.parse(iso(r.hi_ts) ?? "") - Date.parse(iso(r.lo_ts) ?? "")) / 1000 : 0;
  if (!r || !(secs > 3_600)) return null;
  return ((num(r.hi) - num(r.lo)) / secs) * 86_400;
}

export async function windowFigures(db: Db, w: SubsidyWindow, perDay: number | null, now = new Date()): Promise<WindowFigures> {
  const [perAction, dayRows, classes, bots, overall] = await Promise.all([
    rows(db, sql`
      SELECT action AS a, count(*) AS n, avg(fee_usd) AS fee, percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS med,
             count(*) FILTER (WHERE subsidy_class = 'likely_paid' AND from_address <> ${ARBOS_SENDER}) AS paid,
             count(*) FILTER (WHERE from_address <> ${ARBOS_SENDER}) AS users
      FROM txs WHERE ${between(w)} GROUP BY 1`),
    rows(db, sql`
      WITH b AS (SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*) AS blocks FROM blocks WHERE ${between(w)} GROUP BY 1),
      t AS (
        SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*) AS n, avg(fee_usd) AS fee,
               percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS med,
               count(*) FILTER (WHERE subsidy_class = 'likely_paid' AND from_address <> ${ARBOS_SENDER}) AS paid,
               count(*) FILTER (WHERE from_address <> ${ARBOS_SENDER}) AS users,
               count(DISTINCT from_address) FILTER (WHERE from_address <> ${ARBOS_SENDER}) AS senders
        FROM txs WHERE ${between(w)} GROUP BY 1)
      SELECT b.d, b.blocks, coalesce(t.n, 0) AS n, t.fee, t.med, coalesce(t.paid, 0) AS paid, coalesce(t.users, 0) AS users, coalesce(t.senders, 0) AS senders
      FROM b LEFT JOIN t USING (d) ORDER BY b.d`),
    rows(db, sql`SELECT subsidy_class AS c, count(*) AS n FROM txs WHERE ${between(w)} AND from_address <> ${ARBOS_SENDER} GROUP BY 1`),
    // Bot heuristic (PROJECT.md 12.3, D3): per sender and day, very high frequency and one repeated contract call.
    rows(db, sql`
      WITH p AS (
        SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, from_address AS a, coalesce(to_address, '') AS t, coalesce(method, '') AS m, count(*) AS n
        FROM txs WHERE ${between(w)} AND from_address <> ${ARBOS_SENDER} GROUP BY 1, 2, 3, 4
      ), s AS (SELECT d, a, sum(n) AS n, max(n) AS top FROM p GROUP BY 1, 2)
      SELECT count(*) AS sender_days,
             count(*) FILTER (WHERE n >= ${BOT_MIN_TX} AND top >= ${BOT_PATTERN_SHARE} * n) AS bots,
             coalesce(sum(n) FILTER (WHERE n >= ${BOT_MIN_TX} AND top >= ${BOT_PATTERN_SHARE} * n), 0) AS bot_tx,
             coalesce(sum(n), 0) AS tx
      FROM s`),
    rows(db, sql`
      SELECT count(*) AS n, count(*) FILTER (WHERE from_address = ${ARBOS_SENDER}) AS sys, avg(fee_usd) AS fee,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS med,
             count(*) FILTER (WHERE subsidy_class = 'likely_paid' AND from_address <> ${ARBOS_SENDER}) AS paid
      FROM txs WHERE ${between(w)}`),
  ]);

  const days: DayFigures[] = dayRows.map((x) => ({
    date: String(x.d),
    blocks: num(x.blocks),
    tx: num(x.n),
    tx_per_block: ratio(num(x.n), num(x.blocks)),
    paid_share: ratio(num(x.paid), num(x.users)),
    avg_fee_usd: numOrNull(x.fee),
    median_fee_usd: numOrNull(x.med),
    senders: num(x.senders),
  }));
  const covered = days.reduce((t, d) => t + d.blocks, 0);
  const o = overall[0] ?? {};
  const tx = num(o.n);
  const sys = num(o.sys);
  const users = tx - sys;
  // Expected blocks: the window's elapsed part (up to now) at the chain's rate.
  const elapsedMs = Math.max(0, Math.min(w.end.getTime(), now.getTime()) - w.start.getTime());
  const expected = perDay ? Math.round((elapsedMs / DAY_MS) * perDay) : 0;
  const coverage = expected > 0 ? Math.min(1, covered / expected) : null;
  const totalDays = Math.round((w.end.getTime() - w.start.getTime()) / DAY_MS);
  const ended = days.filter((d) => Date.parse(`${d.date}T00:00:00Z`) + DAY_MS <= now.getTime()).length;
  const actionByKey = new Map(perAction.map((x) => [String(x.a), x]));
  const b = bots[0] ?? {};
  const cls = (c: string) => num(classes.find((x) => x.c === c)?.n);

  return {
    start: w.start.toISOString(),
    end: w.end.toISOString(),
    days_total: totalDays,
    days_with_data: days.length,
    days_ended: ended,
    blocks_covered: covered,
    blocks_expected: expected,
    coverage,
    sampled: coverage === null || coverage < FULL_COVERAGE,
    tx,
    user_tx: users,
    system_tx: sys,
    tx_per_block: ratio(tx, covered),
    est_tx_per_day: perDay && covered > 0 ? (tx / covered) * perDay : null,
    paid_share: ratio(num(o.paid), users),
    classes: { likely_subsidized: cls("likely_subsidized"), likely_paid: cls("likely_paid"), unknown: cls("unknown") },
    avg_fee_usd: numOrNull(o.fee),
    median_fee_usd: numOrNull(o.med),
    senders_per_day: days.length ? days.reduce((t, d) => t + d.senders, 0) / days.length : null,
    bot: { sender_days: num(b.sender_days), bot_sender_days: num(b.bots), share: ratio(num(b.bots), num(b.sender_days)), tx_share: ratio(num(b.bot_tx), num(b.tx)) },
    actions: CITY_ACTIONS.map(({ key }) => {
      const x = actionByKey.get(key);
      const n = num(x?.n);
      return {
        key,
        tx: n,
        tx_per_block: ratio(n, covered),
        share: ratio(n, tx),
        avg_fee_usd: numOrNull(x?.fee),
        median_fee_usd: numOrNull(x?.med),
        paid_share: ratio(num(x?.paid), num(x?.users)),
      };
    }),
    days,
  };
}

// Share of the senders active before the end date that are active after it (PROJECT.md 12.3). Only when every block of
// both windows is ingested (D3): a sampled window misses most once-a-day senders and would read far too low.
async function retention(db: Db, before: WindowFigures, after: WindowFigures, wb: SubsidyWindow, wa: SubsidyWindow): Promise<SubsidyResult["retention"]> {
  if (after.days_with_data === 0) return { value: null, n: 0, reason: "No block after the subsidy end is ingested yet." };
  if (before.sampled || after.sampled) return { value: null, n: 0, reason: "Not measurable from sampled blocks: a sample misses most senders that are active once a day, so it would read far too low. It is computed once both windows are fully ingested." };
  const [r] = await rows(db, sql`
    WITH b AS (SELECT DISTINCT from_address AS a FROM txs WHERE ${between(wb)} AND from_address <> ${ARBOS_SENDER}),
         a AS (SELECT DISTINCT from_address AS a FROM txs WHERE ${between(wa)} AND from_address <> ${ARBOS_SENDER})
    SELECT (SELECT count(*) FROM b) AS n, (SELECT count(*) FROM b JOIN a USING (a)) AS kept`);
  const n = num(r?.n);
  return { value: ratio(num(r?.kept), n), n, reason: null };
}

export function defaultWindows(subsidyEnd: Date, days = 7): { before: SubsidyWindow; after: SubsidyWindow } {
  const e = subsidyEnd.getTime();
  return { before: { start: new Date(e - days * DAY_MS), end: subsidyEnd }, after: { start: subsidyEnd, end: new Date(e + days * DAY_MS) } };
}

// "2026-09-22..2026-09-28": inclusive UTC days, at most 31.
export function parseWindow(v: string | null): SubsidyWindow | string | null {
  if (v === null || v === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (!m) return "a window is YYYY-MM-DD..YYYY-MM-DD";
  const start = new Date(`${m[1]}T00:00:00Z`);
  const last = new Date(`${m[2]}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(last.getTime()) || isoDay(start) !== m[1] || isoDay(last) !== m[2]) return "a window is YYYY-MM-DD..YYYY-MM-DD";
  const days = (last.getTime() - start.getTime()) / DAY_MS + 1;
  if (days < 1 || days > 31) return "a window covers 1 to 31 days";
  return { start, end: new Date(last.getTime() + DAY_MS) };
}

export const windowParam = (w: SubsidyWindow) => `${isoDay(w.start)}..${isoDay(new Date(w.end.getTime() - DAY_MS))}`;

export async function computeSubsidy(db: Db, before: SubsidyWindow, after: SubsidyWindow, subsidyEnd: Date, now = new Date()): Promise<SubsidyResult> {
  const perDay = await blocksPerDay(db);
  const [b, a] = await Promise.all([windowFigures(db, before, perDay, now), windowFigures(db, after, perDay, now)]);
  return { cliff_date: isoDay(subsidyEnd), blocks_per_day: perDay, before: b, after: a, retention: await retention(db, b, a, before, after), generated_at: new Date().toISOString() };
}
