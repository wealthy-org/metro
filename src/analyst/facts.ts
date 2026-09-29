import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { facts as factsTable } from "../db/schema.ts";
import { engineWindows, type FactDraft } from "../engine/facts.ts";
import { minSample } from "../engine/run.ts";
import { THRESHOLDS } from "../engine/insights.ts";
import { actionLabel, formatMetric } from "../lib/city.ts";
import { formatCountCompact, formatDay, formatGwei, NA, shortHex } from "../lib/format.ts";
import { anchorAt, subsidyEnd } from "../server/filters.ts";
import { holderStats, ponsNonHolders } from "../server/holders.ts";
import { iso, num, numOrNull, rows } from "../server/query.ts";
import { getWallet } from "../server/wallet.ts";
import { TOPICS, type Scope, type TopicKey } from "./topics.ts";

// What Surveyor may talk about (PROJECT.md 13.3 step 2): facts from the Ledger of Facts for the anchor, and facts the
// topic needs but the ledger lacks computed here and upserted, so every answer cites fact ids. Every topics' numbers
// also build a deterministic template, the final tier of the ladder (13.4.3). The Ledger's own windows are the ones
// the lenses show, so an evidence link opened at the same minute shows the same numbers (AT 16).

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type Cite = { id: number; key: string; value: number; n: number; start: Date; end: Date };

export type TopicData = {
  topic: TopicKey;
  title: string;
  scope: Scope;
  lens_url: string;
  cites: Cite[];
  extras: number[];
  times: string[];
  factsPrompt: string;
  template: string;
  enough: boolean;
  missing: string | null;
  labels: Record<string, string>;
};

export type Line = FactDraft & { line: string; id?: number };
type Built = { lines: Line[]; picks: number[]; template: string; enough: boolean; missing: string | null; extras?: number[]; labels?: Record<string, string> };

const fmtUsd = (v: number) => formatMetric(v, "avg_fee_usd");
const fmtUsdN = (v: number | null) => (v === null ? NA : fmtUsd(v));
const fmtPct = (v: number | null, digits = 2) => (v === null ? NA : `${(v * 100).toFixed(digits)}%`);
const fmtInt = (v: number) => v.toLocaleString("en-US");
const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:00`;
const dayOf = (d: Date) => formatDay(d.toISOString().slice(0, 10));
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const actionName = (key: string) => (key === "other" ? "Other" : actionLabel(key));

// ---------------------------------------------------------------- ledger plumbing

export const draftKey = (key: string, start: Date, end: Date) => `${key}|${start.toISOString()}|${end.toISOString()}`;

export async function saveFacts(db: Db, lines: Line[], now: Date): Promise<Map<string, number>> {
  const fresh = [...new Map(lines.filter((l) => l.id === undefined).map((l) => [draftKey(l.key, l.start, l.end), l])).values()];
  if (!fresh.length) return new Map();
  const out = await db
    .insert(factsTable)
    .values(fresh.map((f) => ({ key: f.key, windowStart: f.start, windowEnd: f.end, value: String(f.value), n: f.n, computedAt: now })))
    .onConflictDoUpdate({
      target: [factsTable.key, factsTable.windowStart, factsTable.windowEnd],
      set: { value: sql`excluded.value`, n: sql`excluded.n`, computedAt: sql`excluded.computed_at` },
    })
    .returning({ id: factsTable.id, key: factsTable.key, start: factsTable.windowStart, end: factsTable.windowEnd });
  return new Map(out.map((r) => [draftKey(r.key, r.start, r.end), r.id]));
}

// A ledger row that is read again for a topic is cited as it stands (its id and window), never rewritten here.
const reline = (r: FactRowT, line: string): Line => ({ key: r.key, start: r.start, end: r.end, value: r.value, n: r.n, line, id: r.id });

export type FactRowT = { id: number; key: string; start: Date; end: Date; value: number; n: number };

const toRow = (x: Record<string, unknown>): FactRowT => ({ id: num(x.id), key: String(x.key), start: new Date(iso(x.window_start) ?? 0), end: new Date(iso(x.window_end) ?? 0), value: num(x.value), n: num(x.n) });

export async function readFacts(db: Db, keys: string[]): Promise<FactRowT[]> {
  if (!keys.length) return [];
  const out = await rows(db, sql`
    SELECT DISTINCT ON (key, window_start, window_end) id, key, window_start, window_end, value, n
    FROM facts
    WHERE key = ANY(${sql.param(keys)}::varchar[])
      AND computed_at = (SELECT max(computed_at) FROM facts f2 WHERE f2.key = facts.key)
    ORDER BY key, window_start, window_end`);
  return out.map(toRow);
}

export async function readFactsLike(db: Db, prefix: string): Promise<FactRowT[]> {
  const out = await rows(db, sql`
    SELECT DISTINCT ON (key, window_start, window_end) id, key, window_start, window_end, value, n
    FROM facts
    WHERE key LIKE ${`${prefix}%`}
      AND computed_at = (SELECT max(computed_at) FROM facts f2 WHERE f2.key = facts.key)
    ORDER BY key, window_start, window_end`);
  return out.map(toRow);
}

// The ledger covers the anchor when an engine run happened at or after it (a live Collector runs every 10 minutes;
// 15 minutes of slack absorbs clock differences). Otherwise the facts are computed and stored once here.
async function ensureLedger(db: Db, anchor: Date, now: Date): Promise<void> {
  const [r] = await rows(db, sql`SELECT max(computed_at) AS m, count(*) AS n FROM facts`);
  const m = iso(r?.m);
  const fresh = r !== undefined && num(r.n) > 0 && m !== null && Date.parse(m) >= anchor.getTime() - 15 * 60_000;
  if (fresh) return;
  const { facts } = await import("../engine/facts.ts").then((m2) => m2.computeFacts(db, engineWindows(anchor, new Date(subsidyEnd()))));
  await saveFacts(
    db,
    facts.map((f) => ({ ...f, line: "" })),
    now,
  );
}

// ---------------------------------------------------------------- topics

async function buildHours(db: Db, scope: Scope, w: ReturnType<typeof engineWindows>): Promise<Built> {
  const action = scope.action ?? "swap";
  const floor = minSample();
  const out = await rows(db, sql`
    SELECT date_trunc('hour', ts) AS h, percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS m, count(*) AS n
    FROM txs WHERE action = ${action} AND ts >= ${w.w24.start} AND ts < ${w.w24.end} GROUP BY 1 HAVING count(*) >= ${floor} ORDER BY 1`);
  const hours = out
    .map((x) => ({ h: new Date(iso(x.h) ?? 0), m: numOrNull(x.m), n: num(x.n) }))
    .filter((x): x is { h: Date; m: number; n: number } => x.m !== null);
  const lines: Line[] = hours.map((x) => ({
    key: `median_fee_usd.${action}.hour`,
    start: x.h,
    end: new Date(x.h.getTime() + HOUR_MS),
    value: x.m,
    n: x.n,
    line: `${actionLabel(action)} median fee at ${hhmm(x.h)} UTC on ${dayOf(x.h)}: ${fmtUsd(x.m)} (n = ${x.n})`,
  }));
  const total = hours.reduce((t, x) => t + x.n, 0);
  const label = actionLabel(action);
  if (hours.length < 2 || total < floor) {
    return { lines, picks: lines.map((_, i) => i), template: `Not enough data yet: fewer than two clock hours in the last 24 hours hold at least ${floor} ${actionLabel(action)} transactions (n = ${fmtInt(total)}).`, enough: false, missing: `fewer than two hours with ${floor} or more ${label} transactions`, extras: [floor] };
  }
  const sorted = [...hours].sort((a, b) => a.m - b.m);
  const lo = sorted[0] as { h: Date; m: number; n: number };
  const hi = sorted[sorted.length - 1] as { h: Date; m: number; n: number };
  const pickKeys = new Set([`${lo.h.toISOString()}|${lo.m}`, `${hi.h.toISOString()}|${hi.m}`]);
  const picks = lines.map((l, i) => ({ l, i })).filter(({ l }) => pickKeys.has(`${l.start.toISOString()}|${l.value}`)).map(({ i }) => i);
  return {
    lines,
    picks,
    template: `${label} median fee was lowest at ${hhmm(lo.h)} UTC on ${dayOf(lo.h)} (${fmtUsd(lo.m)}, ${plural(lo.n, "transaction")}) and highest at ${hhmm(hi.h)} UTC on ${dayOf(hi.h)} (${fmtUsd(hi.m)}, ${plural(hi.n, "transaction")}), over ${plural(total, "transaction")} in the last 24 hours.`,
    enough: true,
    missing: null,
    extras: [total],
  };
}

async function buildCost(db: Db, w: ReturnType<typeof engineWindows>): Promise<Built> {
  const floor = minSample();
  const out = await rows(db, sql`
    SELECT action AS a, percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd) AS m, count(*) AS n
    FROM txs WHERE ts >= ${w.w24.start} AND ts < ${w.w24.end} GROUP BY 1`);
  const lines: Line[] = out
    .map((x) => ({ a: String(x.a), m: numOrNull(x.m), n: num(x.n) }))
    .filter((x): x is { a: string; m: number; n: number } => x.m !== null)
    .map((x) => ({
      key: `median_fee_usd.${x.a}`,
      start: w.w24.start,
      end: w.w24.end,
      value: x.m,
      n: x.n,
      line: `${actionLabel(x.a)}: median fee ${fmtUsd(x.m)} (n = ${x.n})`,
    }));
  const total = out.reduce((t, x) => t + num(x.n), 0);
  const eligible = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.n >= floor);
  if (eligible.length < 2) {
    return { lines, picks: eligible.map(({ i }) => i), template: `Not enough data yet: fewer than two action types have ${floor} or more transactions in the last 24 hours (n = ${fmtInt(total)}).`, enough: false, missing: "fewer than two actions with enough transactions", extras: [floor] };
  }
  const byFee = [...eligible].sort((a, b) => b.l.value - a.l.value);
  const top = byFee[0] as { l: Line; i: number };
  const bot = byFee[byFee.length - 1] as { l: Line; i: number };
  const name = (l: Line) => actionLabel(l.key.replace("median_fee_usd.", ""));
  return {
    lines,
    picks: [top.i, bot.i],
    template: `${name(top.l)} is the costliest action at ${fmtUsd(top.l.value)} per transaction (median); ${name(bot.l)} is the cheapest at ${fmtUsd(bot.l.value)}, over ${plural(total, "transaction")} in the last 24 hours.`,
    enough: true,
    missing: null,
    extras: [total],
  };
}

async function buildSpike(db: Db, w: ReturnType<typeof engineWindows>): Promise<Built> {
  const [hourRows, medianRows] = await Promise.all([readFactsLike(db, "base_fee_gwei.hour"), readFacts(db, ["base_fee_gwei.median_hourly"])]);
  const median = medianRows[0];
  const lines: Line[] = [
    ...hourRows.map((r) => reline(r, `Base fee at ${hhmm(r.start)} UTC on ${dayOf(r.start)}: ${formatGwei(r.value)} Gwei (n = ${r.n} blocks)`)),
    ...medianRows.map((r) => reline(r, `Median hourly base fee over the 7 days: ${formatGwei(r.value)} Gwei (n = ${r.n} hours)`)),
  ];
  const medianIdx = lines.findIndex((l) => l.key === "base_fee_gwei.median_hourly");
  const hourIdx = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.key === "base_fee_gwei.hour");
  if (hourRows.length < 24 || !median || median.value <= 0) {
    return { lines, picks: medianIdx >= 0 ? [medianIdx] : [], template: `Not enough data yet: the last 7 days hold ${fmtInt(hourRows.length)} clock hours of base fee against the 24 needed (n = ${fmtInt(median?.n ?? 0)} hours).`, enough: false, missing: "fewer than 24 clock hours of base fee in the 7-day window", extras: [7, 24] };
  }
  const peak = hourIdx.reduce((best, x) => (x.l.value > best.l.value ? x : best), hourIdx[0] as { l: Line; i: number });
  const ratio = peak.l.value / median.value;
  const base = `the 7-day median hourly base fee of ${formatGwei(median.value)} Gwei over ${fmtInt(median.n)} hours`;
  const spike = ratio >= THRESHOLDS.gasSpike;
  return {
    lines,
    picks: [medianIdx, peak.i],
    template: spike
      ? `Base fee spiked: the hourly average reached ${formatGwei(peak.l.value)} Gwei at ${hhmm(peak.l.start)} UTC on ${dayOf(peak.l.start)}, ${ratio.toFixed(1)} times ${base} (n = ${peak.l.n} blocks).`
      : `No gas spike in the last 7 days: no hour reached ${THRESHOLDS.gasSpike} times ${base}. The highest hourly average was ${formatGwei(peak.l.value)} Gwei at ${hhmm(peak.l.start)} UTC on ${dayOf(peak.l.start)} (n = ${peak.l.n} blocks).`,
    enough: true,
    missing: null,
  };
}

async function buildSubsidy(db: Db): Promise<Built> {
  const keys = ["paid_share.before", "paid_share.after", "tx_per_block.before", "tx_per_block.after", "est_tx_per_day.before", "est_tx_per_day.after", "median_fee_usd.all.before", "median_fee_usd.all.after", "days_covered.before", "days_covered.after", "block_coverage.before", "block_coverage.after"];
  const found = await readFacts(db, keys);
  const pick = (key: string, side: "before" | "after") => found.find((r) => r.key === `${key}.${side}`);
  const label: Record<string, string> = {
    "paid_share.before": "paid share (estimate), before",
    "paid_share.after": "paid share (estimate), after",
    "tx_per_block.before": "transactions per covered block, before",
    "tx_per_block.after": "transactions per covered block, after",
    "est_tx_per_day.before": "estimated transactions per day, before",
    "est_tx_per_day.after": "estimated transactions per day, after",
    "median_fee_usd.all.before": "median fee, before",
    "median_fee_usd.all.after": "median fee, after",
    "days_covered.before": "days ended, before",
    "days_covered.after": "days ended, after",
    "block_coverage.before": "share of blocks sampled, before",
    "block_coverage.after": "share of blocks sampled, after",
  };
  const show = (r: FactRowT) => {
    if (r.key.startsWith("paid_share")) return fmtPct(r.value);
    if (r.key.startsWith("tx_per_block")) return r.value.toFixed(2);
    if (r.key.startsWith("est_tx_per_day")) return formatCountCompact(r.value);
    if (r.key.startsWith("block_coverage")) return fmtPct(r.value, 2);
    if (r.key.startsWith("days_covered")) return `${r.value} of ${r.n}`;
    return fmtUsd(r.value);
  };
  const lines: Line[] = found.map((r) => reline(r, `${label[r.key] ?? r.key}: ${show(r)} (n = ${r.n})`));
  const idx = (r: FactRowT | undefined) => (r ? lines.findIndex((l) => l.key === r.key && l.start.getTime() === r.start.getTime()) : -1);
  const pb = pick("paid_share", "before");
  const pa = pick("paid_share", "after");
  const tb = pick("tx_per_block", "before");
  const ta = pick("tx_per_block", "after");
  const daysA = pick("days_covered", "after");
  const picks = [idx(pb), idx(pa), idx(tb), idx(ta), idx(daysA)].filter((i) => i >= 0);
  if (!pb || !tb) {
    return { lines, picks, template: "Not enough data yet: the window before 29 September 2026 has no ingested blocks, so nothing can be compared.", enough: false, missing: "no ingested blocks before the subsidy end", extras: [7, 29] };
  }
  if (!pa || !ta) {
    return {
      lines,
      picks,
      template: `The rebate ended on 29 September 2026. Before it, paid share (an estimate) was ${fmtPct(pb.value)} and transactions per covered block ${tb.value.toFixed(2)} (n = ${fmtInt(pb.n)} user transactions, ${fmtInt(tb.n)} transactions from sampled blocks); no block after the end is ingested yet, so the after side is not measurable.`,
      enough: true,
      missing: null,
      extras: [29, 7],
    };
  }
  const pt = (pa.value - pb.value) * 100;
  const txChange = tb.value > 0 ? ((ta.value - tb.value) / tb.value) * 100 : null;
  return {
    lines,
    picks,
    template: `Seven days before the rebate ended against after it: paid share (an estimate) moved from ${fmtPct(pb.value)} to ${fmtPct(pa.value)} (${pt >= 0 ? "+" : ""}${pt.toFixed(2)} points) and transactions per covered block from ${tb.value.toFixed(2)} to ${ta.value.toFixed(2)}${txChange === null ? "" : ` (${txChange >= 0 ? "+" : ""}${txChange.toFixed(1)}%)`}. The after window covers ${daysA ? `${fmtInt(daysA.value)} of ${fmtInt(daysA.n)} days` : "no day yet"}, from sampled blocks.`,
    enough: true,
    missing: null,
    extras: [7, 29],
  };
}

async function tokenLabels(db: Db, tokens: string[]): Promise<Record<string, string>> {
  if (!tokens.length) return {};
  const out = await rows(db, sql`SELECT address, symbol FROM tokens WHERE address = ANY(${sql.param(tokens)}::varchar[])`);
  const byAddress = new Map(out.map((x) => [String(x.address), typeof x.symbol === "string" && x.symbol.length ? String(x.symbol) : null]));
  return Object.fromEntries(tokens.map((t) => [t, byAddress.get(t) ?? shortHex(t)]));
}

async function tokenLabel(db: Db, token: string): Promise<string> {
  return (await tokenLabels(db, [token]))[token] ?? shortHex(token);
}

async function buildFastest(db: Db): Promise<Built> {
  const floor = minSample();
  const found = await readFactsLike(db, "holder_growth_24h.");
  const labels = await tokenLabels(db, found.map((r) => r.key.replace("holder_growth_24h.", "")));
  const lines: Line[] = found.map((r) => {
    const addr = r.key.replace("holder_growth_24h.", "");
    return reline(r, `${labels[addr] ?? shortHex(addr)}: ${r.value >= 0 ? "+" : ""}${fmtInt(r.value)} holders in 24 h, ${fmtInt(r.n)} holders in total`);
  });
  const eligible = found.map((r, i) => ({ r, i })).filter(({ r }) => r.value > 0 && r.n >= floor);
  if (!eligible.length) {
    return { lines, picks: [], template: `No Pons token gained holders in the last 24 hours${found.length ? ` (the ${fmtInt(found.length)} tokens with ingested transfers were checked)` : ""}.`, enough: false, missing: "no token gained holders in the last 24 hours", labels };
  }
  const top = eligible.reduce((best, x) => (x.r.value > best.r.value ? x : best), eligible[0] as { r: FactRowT; i: number });
  const addr = top.r.key.replace("holder_growth_24h.", "");
  const name = labels[addr] ?? shortHex(addr);
  return {
    lines,
    picks: [top.i],
    template: `${name} gained ${plural(top.r.value, "holder")} in 24 hours, the most of any Pons token; it now has ${plural(top.r.n, "holder")} in total.`,
    enough: true,
    missing: null,
    labels,
  };
}

async function buildConcentration(db: Db): Promise<Built> {
  const floor = minSample();
  const found = await readFactsLike(db, "top10_share.");
  const labels = await tokenLabels(db, found.map((r) => r.key.replace("top10_share.", "")));
  const lines: Line[] = found.map((r) => {
    const addr = r.key.replace("top10_share.", "");
    return reline(r, `${labels[addr] ?? shortHex(addr)}: top 10 hold ${fmtPct(r.value)} of the supply (n = ${fmtInt(r.n)} holders)`);
  });
  const eligible = found.map((r, i) => ({ r, i })).filter(({ r }) => r.value !== null && r.n >= floor);
  if (!eligible.length) {
    return { lines, picks: [], template: `No Pons token with at least ${floor} holders has an ingested holder base yet.`, enough: false, missing: `no token with ${floor} or more holders`, labels, extras: [floor] };
  }
  const top = eligible.reduce((best, x) => (x.r.value > best.r.value ? x : best), eligible[0] as { r: FactRowT; i: number });
  const addr = top.r.key.replace("top10_share.", "");
  const name = labels[addr] ?? shortHex(addr);
  const pool = (await readFacts(db, [`pool_share.${addr}`]))[0];
  const picks = [top.i, ...(pool ? [lines.push(reline(pool, `${name}: the curve pool holds ${fmtPct(pool.value)} of the supply (n = ${fmtInt(pool.n)} holders)`)) - 1] : [])];
  return {
    lines,
    picks,
    template:
      top.r.value >= THRESHOLDS.concentration
        ? `${name} has the most concentrated ownership: the top 10 holders own ${fmtPct(top.r.value)} of the supply across ${plural(top.r.n, "holder")}.`
        : `No Pons token has more than ${fmtPct(THRESHOLDS.concentration, 0)} of its supply in the top 10 wallets; the highest is ${name} at ${fmtPct(top.r.value)} across ${plural(top.r.n, "holder")}.`,
    enough: true,
    missing: null,
    labels,
  };
}

async function buildDominant(db: Db): Promise<Built> {
  const floor = minSample();
  const found = await readFactsLike(db, "wallet_share.");
  const lines: Line[] = found.map((r) => {
    const [, action, address] = r.key.split(".");
    return reline(r, `${shortHex(address ?? "")} sent ${fmtPct(r.value)} of all ${actionName(action ?? "")} transactions (n = ${fmtInt(r.n)})`);
  });
  const eligible = found.map((r, i) => ({ r, i })).filter(({ r }) => r.n >= floor);
  if (!eligible.length) {
    return { lines, picks: [], template: `Not enough data yet: no action has ${floor} or more transactions in the last 24 hours.`, enough: false, missing: "no action with enough transactions", extras: [floor] };
  }
  const top = eligible.reduce((best, x) => (x.r.value > best.r.value ? x : best), eligible[0] as { r: FactRowT; i: number });
  const [, action, address] = top.r.key.split(".");
  const label = actionName(action ?? "");
  return {
    lines,
    picks: [top.i],
    template:
      top.r.value >= THRESHOLDS.dominantWallet
        ? `One wallet (${shortHex(address ?? "")}) sent ${fmtPct(top.r.value)} of all ${label} transactions in the last 24 hours (n = ${fmtInt(top.r.n)}). The share is measured, not a judgement about the wallet.`
        : `No wallet reached ${fmtPct(THRESHOLDS.dominantWallet, 0)} of any action's transactions in the last 24 hours; the highest share was ${fmtPct(top.r.value)} of ${label} (n = ${fmtInt(top.r.n)}).`,
    enough: true,
    missing: null,
    extras: [Math.round(THRESHOLDS.dominantWallet * 100)],
  };
}

async function buildFails(db: Db): Promise<Built> {
  const floor = minSample();
  const found = await readFactsLike(db, "fail_rate.");
  const hourRow = found.find((r) => r.end.getTime() - r.start.getTime() === HOUR_MS && r.key === "fail_rate.all");
  const baseRow = found.find((r) => r.key === "fail_rate.all" && r.end.getTime() - r.start.getTime() > HOUR_MS);
  const actionRow = found.find((r) => r.key !== "fail_rate.all" && r.end.getTime() - r.start.getTime() === HOUR_MS);
  const lines: Line[] = found.map((r) => reline(r, `${r.key === "fail_rate.all" ? "All transactions" : actionName(r.key.replace("fail_rate.", ""))}: ${fmtPct(r.value)} failed (n = ${fmtInt(r.n)}, window ${r.start.toISOString().slice(0, 16)} to ${r.end.toISOString().slice(0, 16)} UTC)`));
  const idx = (r: FactRowT | undefined) => (r ? lines.findIndex((l) => l.key === r.key && l.start.getTime() === r.start.getTime()) : -1);
  if (!hourRow || hourRow.n < floor) {
    return { lines, picks: [], template: `Not enough data yet: the last hour holds ${fmtInt(hourRow?.n ?? 0)} transactions against the ${floor} needed.`, enough: false, missing: `fewer than ${floor} transactions in the last hour`, extras: [floor] };
  }
  if (!baseRow) {
    return { lines, picks: [idx(hourRow)], template: `In the last hour, ${fmtPct(hourRow.value)} of ${plural(hourRow.n, "transaction")} failed; the 24 hours before it hold no ingested transactions to compare against.`, enough: true, missing: null };
  }
  const ratio = baseRow.value > 0 ? hourRow.value / baseRow.value : null;
  const points = (hourRow.value - baseRow.value) * 100;
  const rise = ratio !== null && ratio >= THRESHOLDS.failRateRatio && points >= THRESHOLDS.failRatePoints * 100;
  return {
    lines,
    picks: [idx(hourRow), idx(baseRow), idx(actionRow)].filter((i) => i >= 0),
    template: rise
      ? `Failures rose: ${fmtPct(hourRow.value)} of transactions in the last hour failed against ${fmtPct(baseRow.value)} over the 24 hours before it (n = ${fmtInt(hourRow.n)} and ${fmtInt(baseRow.n)})${actionRow ? `; ${actionName(actionRow.key.replace("fail_rate.", ""))} carried the most failures` : ""}.`
      : `Failures are steady: ${fmtPct(hourRow.value)} of the last hour's transactions failed against ${fmtPct(baseRow.value)} over the 24 hours before it (n = ${fmtInt(hourRow.n)} and ${fmtInt(baseRow.n)}); no rise above ${THRESHOLDS.failRateRatio} times and ${THRESHOLDS.failRatePoints * 100} points.`,
    enough: true,
    missing: null,
    extras: [THRESHOLDS.failRateRatio, THRESHOLDS.failRatePoints * 100],
  };
}

async function buildBlocks(db: Db): Promise<Built> {
  const found = await readFacts(db, ["full_blocks"]);
  const row = found[0];
  const lines: Line[] = row ? [reline(row, `${fmtInt(row.value)} of ${fmtInt(row.n)} blocks used 90 % or more of their gas limit in the last 24 hours`)] : [];
  if (!row || row.n === 0) {
    return { lines, picks: [], template: "Not enough data yet: no block fell inside the last 24 hours.", enough: false, missing: "no ingested blocks in the last 24 hours" };
  }
  return {
    lines,
    picks: [0],
    template:
      row.value === 0
        ? `No block in the last 24 hours used 90 % or more of its gas limit, out of ${plural(row.n, "block")}. Blocks on this chain stay far from full.`
        : `${fmtInt(row.value)} of ${plural(row.n, "block")} in the last 24 hours used 90 % or more of their gas limit.`,
    enough: true,
    missing: null,
  };
}

async function buildComposition(db: Db, w: ReturnType<typeof engineWindows>): Promise<Built> {
  const floor = minSample();
  const found = await readFactsLike(db, "action_share.");
  const nowRows = found.filter((r) => r.end.getTime() === w.w24.end.getTime() || Math.abs(r.end.getTime() - w.w24.end.getTime()) < 1000);
  const prevRows = found.filter((r) => Math.abs(r.end.getTime() - w.w24.start.getTime()) < 1000);
  const lines: Line[] = found.map((r) => reline(r, `${actionName(r.key.replace("action_share.", ""))}: ${fmtPct(r.value)} of transactions in its window (total n = ${fmtInt(r.n)})`));
  const total = nowRows[0]?.n ?? 0;
  const prevTotal = prevRows[0]?.n ?? 0;
  if (!nowRows.length || !prevRows.length || total < floor || prevTotal < floor) {
    return { lines, picks: [], template: `Not enough data yet: this comparison needs two 24-hour windows with at least ${floor} transactions each (n = ${fmtInt(total)} and ${fmtInt(prevTotal)}).`, enough: false, missing: "two 24-hour windows with enough transactions", extras: [floor, 24] };
  }
  const prev = new Map(prevRows.map((r) => [r.key, r]));
  let best: { key: string; points: number; from: number; to: number; now: FactRowT; was: FactRowT } | null = null;
  for (const r of nowRows) {
    const was = prev.get(r.key);
    if (!was) continue;
    const points = (r.value - was.value) * 100;
    if (!best || Math.abs(points) > Math.abs(best.points)) best = { key: r.key, points, from: was.value, to: r.value, now: r, was };
  }
  const idx = (r: FactRowT | undefined) => (r ? lines.findIndex((l) => l.key === r.key && l.start.getTime() === r.start.getTime()) : -1);
  if (!best) {
    return { lines, picks: [], template: "Not enough data yet: no action appears in both 24-hour windows.", enough: false, missing: "no action in both windows" };
  }
  const label = actionName(best.key.replace("action_share.", ""));
  const shift = Math.abs(best.points) >= THRESHOLDS.compositionPoints * 100;
  return {
    lines,
    picks: [idx(best.now), idx(best.was)].filter((i) => i >= 0),
    template: shift
      ? `${label}'s share moved from ${fmtPct(best.from)} to ${fmtPct(best.to)}, a change of ${best.points >= 0 ? "+" : ""}${best.points.toFixed(1)} points between the last two 24-hour windows (n = ${fmtInt(total)} and ${fmtInt(prevTotal)}).`
      : `The mix of actions barely moved between the last two 24-hour windows: the largest change was ${label} at ${best.points >= 0 ? "+" : ""}${best.points.toFixed(1)} points, from ${fmtPct(best.from)} to ${fmtPct(best.to)} (n = ${fmtInt(total)} and ${fmtInt(prevTotal)}).`,
    enough: true,
    missing: null,
    extras: [Math.round(THRESHOLDS.compositionPoints * 100)],
  };
}

async function buildToken(db: Db, scope: Scope, w: ReturnType<typeof engineWindows>, anchor: Date): Promise<Built> {
  const token = scope.token as string;
  const floor = minSample();
  const label = await tokenLabel(db, token);
  const labels: Record<string, string> = { [token]: label };
  const [info] = await rows(db, sql`
    SELECT k.is_pons, l.block AS launch_block, l.ts AS launch_ts, l.params->>'topic2' AS pool
    FROM tokens k LEFT JOIN pons_launches l ON l.token_address = k.address WHERE k.address = ${token}`);
  const [moved] = await rows(db, sql`
    WITH m AS (SELECT DISTINCT tx_hash, ts FROM token_transfers WHERE token_address = ${token} AND ts >= ${w.w24.start} AND ts < ${w.w24.end})
    SELECT count(*) AS n, count(DISTINCT t.from_address) AS senders, count(*) FILTER (WHERE t.action = 'swap') AS swaps,
           avg(t.fee_usd) AS fee, percentile_disc(0.5) WITHIN GROUP (ORDER BY t.fee_usd) AS med
    FROM m JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts`);
  const n = num(moved?.n);
  const [first] = await rows(db, sql`SELECT min(ts) AS t FROM token_transfers WHERE token_address = ${token}`);
  const launchTs = info?.launch_ts ? new Date(iso(info.launch_ts) ?? 0) : first?.t ? new Date(iso(first.t) ?? 0) : anchor;
  const since: { start: Date; end: Date } = { start: launchTs, end: anchor };
  const holders = await holderStats(db, token, info?.launch_block === undefined || info.launch_block === null ? null : num(info.launch_block), anchor, ponsNonHolders(info?.pool));
  const growth = holders.holders - holders.holders_24h_ago;
  const lines: Line[] = [
    { key: `token_tx.${token}`, start: w.w24.start, end: w.w24.end, value: n, n, line: `Transactions moving it in the last 24 hours: ${fmtInt(n)} (n = ${fmtInt(n)})` },
    { key: `token_senders.${token}`, start: w.w24.start, end: w.w24.end, value: num(moved?.senders), n, line: `Senders in the last 24 hours: ${fmtInt(num(moved?.senders))}` },
    { key: `token_swaps.${token}`, start: w.w24.start, end: w.w24.end, value: num(moved?.swaps), n, line: `Swaps of it in the last 24 hours: ${fmtInt(num(moved?.swaps))}` },
    ...(numOrNull(moved?.med) !== null ? [{ key: `token_median_fee_usd.${token}`, start: w.w24.start, end: w.w24.end, value: num(moved?.med), n, line: `Median fee of those transactions: ${fmtUsd(num(moved?.med))}` }] : []),
    ...(numOrNull(moved?.fee) !== null ? [{ key: `token_avg_fee_usd.${token}`, start: w.w24.start, end: w.w24.end, value: num(moved?.fee), n, line: `Average fee of those transactions: ${fmtUsd(num(moved?.fee))}` }] : []),
    { key: `holder_growth_24h.${token}`, start: new Date(anchor.getTime() - DAY_MS), end: anchor, value: growth, n: holders.holders, line: `Holders now: ${fmtInt(holders.holders)}; change over 24 h: ${growth >= 0 ? "+" : ""}${fmtInt(growth)}` },
    ...(holders.top10_share !== null ? [{ key: `top10_share.${token}`, start: since.start, end: since.end, value: holders.top10_share, n: holders.holders, line: `Top 10 hold (curve pool left out): ${fmtPct(holders.top10_share)}` }] : []),
    ...(holders.pool_share !== null ? [{ key: `pool_share.${token}`, start: since.start, end: since.end, value: holders.pool_share, n: holders.holders, line: `The curve pool holds: ${fmtPct(holders.pool_share)}` }] : []),
  ];
  if (n < floor) {
    return { lines, picks: [], template: `Not enough data yet: ${plural(n, "transaction")} moved ${label} in the last 24 hours, under the ${floor} needed for a reading.`, enough: false, missing: `fewer than ${floor} transactions moving this token in the last 24 hours (n = ${fmtInt(n)})`, labels, extras: [floor, 24] };
  }
  const picks = lines.map((_, i) => i).filter((i) => lines[i]?.key !== `token_avg_fee_usd.${token}`);
  return {
    lines,
    picks,
    template: `${label} was moved by ${plural(n, "transaction")} in the last 24 hours (${fmtInt(num(moved?.swaps))} of them swaps), from ${plural(num(moved?.senders), "sender")}; the median fee of those transactions was ${fmtUsdN(numOrNull(moved?.med))} and it has ${plural(holders.holders, "holder")}${holders.top10_share !== null ? `, with the top 10 holding ${fmtPct(holders.top10_share)} of the supply` : ""}${holders.complete ? "" : " (some transfers since its launch are not ingested)"}.`,
    enough: true,
    missing: null,
    labels,
  };
}

async function buildWallet(db: Db, scope: Scope): Promise<Built> {
  const address = scope.address as string;
  const w = await getWallet(db, address);
  const g = w.ingested;
  const start = g.first_seen ? new Date(g.first_seen) : new Date(Date.now() - DAY_MS);
  const end = g.last_seen ? new Date(g.last_seen) : new Date();
  const lines: Line[] = [
    { key: `wallet_tx.${address}`, start, end, value: g.tx_count, n: g.tx_count, line: `Transactions involving it in the ingested blocks: ${fmtInt(g.tx_count)}` },
    { key: `wallet_sent.${address}`, start, end, value: g.sent, n: Math.max(1, g.sent), line: `Transactions it sent: ${fmtInt(g.sent)}` },
    ...(g.fee_paid_usd !== null ? [{ key: `wallet_fee_paid_usd.${address}`, start, end, value: g.fee_paid_usd, n: Math.max(1, g.sent), line: `Fees it paid: ${fmtUsd(g.fee_paid_usd)}` }] : []),
    ...(g.paid_share !== null ? [{ key: `wallet_paid_share.${address}`, start, end, value: g.paid_share, n: Math.max(1, g.sent), line: `Paid share of what it sent (estimate): ${fmtPct(g.paid_share)}` }] : []),
    ...(g.fail_rate !== null ? [{ key: `wallet_fail_rate.${address}`, start, end, value: g.fail_rate, n: Math.max(1, g.sent), line: `Fail rate of what it sent: ${fmtPct(g.fail_rate)}` }] : []),
  ];
  if (g.tx_count === 0) {
    return { lines, picks: [], template: "This address has no transactions in the blocks Metro has ingested, so there is nothing to describe.", enough: false, missing: "no ingested transactions for this address" };
  }
  return {
    lines,
    picks: lines.map((_, i) => i),
    template: `This address appears in ${plural(g.tx_count, "transaction")} in the ingested blocks, ${fmtInt(g.sent)} of them sent by it${g.fee_paid_usd !== null ? `; it paid ${fmtUsd(g.fee_paid_usd)} in fees` : ""}${g.paid_share !== null ? `, with a paid share of ${fmtPct(g.paid_share)} (an estimate)` : ""}. Metro draws no identity conclusion from this.`,
    enough: true,
    missing: null,
  };
}

// ---------------------------------------------------------------- assembly

export function windowNumbers(cites: Cite[], extras: number[]): { numbers: number[]; times: string[] } {
  const numbers = new Set<number>(extras);
  const times = new Set<string>();
  for (const c of cites) {
    for (const d of [c.start, c.end]) {
      numbers.add(d.getUTCFullYear());
      numbers.add(d.getUTCMonth() + 1);
      numbers.add(d.getUTCDate());
      numbers.add(d.getUTCHours());
      numbers.add(d.getUTCMinutes());
      times.add(hhmm(d));
    }
    const days = Math.round((c.end.getTime() - c.start.getTime()) / DAY_MS);
    if (days > 0) numbers.add(days);
  }
  return { numbers: [...numbers], times: [...times] };
}

export async function collectTopicData(db: Db, topic: TopicKey, scope: Scope, now = new Date()): Promise<TopicData> {
  const anchor = await anchorAt(db, null);
  const lens = TOPICS[topic].lens(scope);
  const title = TOPICS[topic].title;
  const empty: TopicData = { topic, title, scope, lens_url: lens, cites: [], extras: [], times: [], factsPrompt: "", template: "", enough: false, missing: "no ingested blocks yet", labels: {} };
  if (!anchor) return empty;
  await ensureLedger(db, anchor, now);
  const w = engineWindows(anchor, new Date(subsidyEnd()));
  let built: Built;
  switch (topic) {
    case "hours":
      built = await buildHours(db, scope, w);
      break;
    case "cost":
      built = await buildCost(db, w);
      break;
    case "spike":
      built = await buildSpike(db, w);
      break;
    case "subsidy":
      built = await buildSubsidy(db);
      break;
    case "fastest":
      built = await buildFastest(db);
      break;
    case "concentration":
      built = await buildConcentration(db);
      break;
    case "dominant":
      built = await buildDominant(db);
      break;
    case "fails":
      built = await buildFails(db);
      break;
    case "blocks":
      built = await buildBlocks(db);
      break;
    case "composition":
      built = await buildComposition(db, w);
      break;
    case "token":
      built = scope.token ? await buildToken(db, scope, w, anchor) : { lines: [], picks: [], template: "No token is selected. Open a token page or name a token (0x address) in the question.", enough: false, missing: "no token selected" };
      break;
    case "wallet":
      built = scope.address ? await buildWallet(db, scope) : { lines: [], picks: [], template: "No address is selected. Open a wallet page or name an address (0x) in the question.", enough: false, missing: "no address selected" };
      break;
  }
  const ids = await saveFacts(db, built.lines, now);
  const cites: Cite[] = built.picks
    .map((i) => built.lines[i])
    .filter((l): l is Line => l !== undefined)
    .map((l) => {
      const id = l.id ?? ids.get(draftKey(l.key, l.start, l.end));
      return id === undefined ? null : { id, key: l.key, value: l.value, n: l.n, start: l.start, end: l.end };
    })
    .filter((c): c is Cite => c !== null);
  const { numbers, times } = windowNumbers(cites, built.extras ?? []);
  const windowLabel = `${w.w24.start.toISOString().slice(0, 16)} to ${w.w24.end.toISOString().slice(0, 16)} UTC`;
  const factsPrompt = [
    `Topic: ${title}`,
    `Scope: window ${scope.window}, action ${scope.action ?? "any"}, token ${scope.token ?? "none"}, address ${scope.address ?? "none"}`,
    `Facts (the only numbers you may use, copied as written):`,
    ...built.lines.map((l) => `- ${l.line}`),
    `Context: the 24-hour window ends at the newest ingested block (${windowLabel}); "n" is the sample size of its row.`,
  ].join("\n");
  return { topic, title, scope, lens_url: lens, cites, extras: numbers, times, factsPrompt, template: built.template, enough: built.enough, missing: built.missing, labels: built.labels ?? {} };
}
