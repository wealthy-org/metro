import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { dispatch as dispatchTable } from "../db/schema.ts";
import { blocksPerDay } from "../engine/subsidy.ts";
import { availableModels, setLatestAnswer } from "../analyst/budget.ts";
import { collectTopicData, saveFacts, windowNumbers, type Cite, type Line } from "../analyst/facts.ts";
import { writeExplanation } from "../analyst/ladder.ts";
import { numberContext } from "../analyst/validator.ts";
import type { InsightT } from "../lib/api-types.ts";
import { actionLabel, CITY_ACTIONS, type CityActionKey } from "../lib/city.ts";
import { formatDay } from "../lib/format.ts";
import { getInsights } from "../server/insights.ts";
import { num, rows } from "../server/query.ts";
import { actionBarsSvg, fmtInt, fmtPct, fmtUsd, hourGridSvg, pairBarsSvg } from "./parts.ts";

// Report building (PROJECT.md 14.3; Phase 11). Every number a report states is stored in the Ledger first (the
// dispatch_* keys), so facts_ref holds the whole trace and the Phase 10 validator can check the model's prose against
// exactly the same facts. The cron has no browser, so pictures are SVG strings drawn from those facts (D2). One report
// per day: the daily id is its UTC date, and a second call the same day returns the stored one (AT 24).

const DAY_MS = 86_400_000;
const TOP_ACTIONS = 8;

export type DispatchKind = "daily" | "custom" | "subsidy_impact";
export type BuiltReport = { id: string; kind: DispatchKind; rangeLabel: string; bodyMd: string; factsRef: number[]; modelUsed: string };

// The choices a custom report accepts (PROJECT.md 14.2): which lens pictures to draw and whether the findings and the
// largest-changes sections are included.
export type CustomOptions = { lenses: "city" | "heatmap" | "both" | "none"; findings: boolean; changes: boolean };
export const CUSTOM_DEFAULT: CustomOptions = { lenses: "both", findings: true, changes: true };

export type RangeFigures = {
  start: Date;
  end: Date;
  label: string;
  days: number;
  blocks: number;
  expected: number | null;
  coverage: number | null;
  tx: number;
  userTx: number;
  systemTx: number;
  paid: number;
  failed: number;
  fee: number | null;
  paidShare: number | null;
  failRate: number | null;
  actions: { key: CityActionKey; tx: number; share: number }[];
  hours: number[];
};

const dayStart = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
const isoDayOf = (d: Date) => d.toISOString().slice(0, 10);
const labelOf = (d: Date) => `${formatDay(isoDayOf(d))} ${d.getUTCFullYear()}`;

export async function rangeFigures(db: Db, start: Date, end: Date): Promise<RangeFigures> {
  const startDay = isoDayOf(start);
  const endDayExclusive = isoDayOf(end);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS));
  const [byAction, [blockRow], hourRows, perDay] = await Promise.all([
    rows(db, sql`
      SELECT action, sum(tx_count) AS n, sum(system_tx_count) AS sys, sum(failed_tx_count) AS failed,
             sum(fee_usd_avg * tx_count) AS fee_sum, sum(tx_count) FILTER (WHERE subsidy_class = 'likely_paid') AS paid
      FROM agg_day WHERE date >= ${startDay}::date AND date < ${endDayExclusive}::date GROUP BY action`),
    rows(db, sql`SELECT count(*) AS n FROM blocks WHERE ts >= ${start} AND ts < ${end}`),
    rows(db, sql`SELECT extract(hour FROM ts AT TIME ZONE 'UTC') AS h, count(*) AS n FROM txs WHERE ts >= ${start} AND ts < ${end} GROUP BY 1`),
    blocksPerDay(db),
  ]);
  const tx = byAction.reduce((t, x) => t + num(x.n), 0);
  const systemTx = byAction.reduce((t, x) => t + num(x.sys), 0);
  const paid = byAction.reduce((t, x) => t + num(x.paid), 0);
  const failed = byAction.reduce((t, x) => t + num(x.failed), 0);
  const feeSum = byAction.reduce((t, x) => t + num(x.fee_sum), 0);
  const blocks = num(blockRow?.n);
  const expected = perDay === null ? null : Math.round(perDay * days);
  const userTx = Math.max(0, tx - systemTx);
  const byHour = new Map(hourRows.map((x) => [num(x.h), num(x.n)]));
  return {
    start,
    end,
    label: days === 1 ? labelOf(start) : `${formatDay(startDay)} to ${formatDay(isoDayOf(new Date(end.getTime() - DAY_MS)))}`,
    days,
    blocks,
    expected,
    coverage: expected ? blocks / expected : null,
    tx,
    userTx,
    systemTx,
    paid,
    failed,
    fee: tx > 0 ? feeSum / tx : null,
    paidShare: userTx > 0 ? paid / userTx : null,
    failRate: tx > 0 ? failed / tx : null,
    actions: byAction
      .map((x) => ({ key: String(x.action) as CityActionKey, tx: num(x.n), share: tx > 0 ? num(x.n) / tx : 0 }))
      .filter((x) => CITY_ACTIONS.some((a) => a.key === x.key))
      .sort((a, b) => b.tx - a.tx)
      .slice(0, TOP_ACTIONS),
    hours: Array.from({ length: 24 }, (_, h) => byHour.get(h) ?? 0),
  };
}

const pctText = (v: number | null, digits = 1) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`);
const ptText = (v: number | null, digits = 2) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)} pt`);

// The figure block: every number the summary may use, stored as facts for the range (and for the previous range when
// there is one, so the changes are facts too).
function figureLines(figs: RangeFigures, prev: RangeFigures | null): Line[] {
  const span = { start: figs.start, end: figs.end };
  const line = (key: string, value: number, n: number, text: string, at = span): Line => ({ key, start: at.start, end: at.end, value, n, line: text });
  const lines: Line[] = [
    line("dispatch_tx", figs.tx, figs.tx, `Transactions: ${fmtInt(figs.tx)} (n = ${fmtInt(figs.tx)})`),
    ...(figs.fee !== null ? [line("dispatch_fee_usd", figs.fee, figs.tx, `Blended fee: ${fmtUsd(figs.fee)} (n = ${fmtInt(figs.tx)})`)] : []),
    ...(figs.paidShare !== null ? [line("dispatch_paid_share", figs.paidShare, figs.userTx, `Paid share (estimate): ${fmtPct(figs.paidShare)} (n = ${fmtInt(figs.userTx)})`)] : []),
    ...(figs.failRate !== null ? [line("dispatch_fail_rate", figs.failRate, figs.tx, `Fail rate: ${fmtPct(figs.failRate)} (n = ${fmtInt(figs.tx)})`)] : []),
    ...(figs.coverage !== null ? [line("dispatch_coverage", figs.coverage, figs.blocks, `Blocks: ${fmtInt(figs.blocks)} of about ${fmtInt(figs.expected ?? 0)} (${fmtPct(figs.coverage)})`)] : []),
    ...figs.actions.map((a) => line(`dispatch_share.${a.key}`, a.share, figs.tx, `${actionLabel(a.key)}: ${fmtPct(a.share)} of transactions (${fmtInt(a.tx)} of ${fmtInt(figs.tx)})`)),
    ...figs.hours.map((tx, h) => line(`dispatch_hour.${String(h).padStart(2, "0")}`, tx, tx, `Hour ${String(h).padStart(2, "0")}:00 UTC: ${fmtInt(tx)} transactions`)),
  ];
  if (!prev) return lines;
  const prevSpan = { start: prev.start, end: prev.end };
  lines.push(
    line("dispatch_tx", prev.tx, prev.tx, `Transactions the window before: ${fmtInt(prev.tx)}`, prevSpan),
    ...(prev.fee !== null ? [line("dispatch_fee_usd", prev.fee, prev.tx, `Blended fee the window before: ${fmtUsd(prev.fee)}`, prevSpan)] : []),
    ...(prev.paidShare !== null ? [line("dispatch_paid_share", prev.paidShare, prev.userTx, `Paid share the window before: ${fmtPct(prev.paidShare)}`, prevSpan)] : []),
    ...(prev.failRate !== null ? [line("dispatch_fail_rate", prev.failRate, prev.tx, `Fail rate the window before: ${fmtPct(prev.failRate)}`, prevSpan)] : []),
    ...prev.actions.map((a) => line(`dispatch_share.${a.key}`, a.share, prev.tx, `${actionLabel(a.key)} the window before: ${fmtPct(a.share)} (${fmtInt(a.tx)})`, prevSpan)),
  );
  lines.push(
    ...(prev.tx > 0 ? [line("dispatch_tx_change", (figs.tx - prev.tx) / prev.tx, figs.tx, `Transactions against the window before: ${pctText((figs.tx - prev.tx) / prev.tx)}`)] : []),
    ...(prev.fee !== null && figs.fee !== null && prev.fee > 0 ? [line("dispatch_fee_change", (figs.fee - prev.fee) / prev.fee, figs.tx, `Blended fee against the window before: ${pctText((figs.fee - prev.fee) / prev.fee)}`)] : []),
    ...(prev.paidShare !== null && figs.paidShare !== null ? [line("dispatch_paid_points", figs.paidShare - prev.paidShare, figs.userTx, `Paid share against the window before: ${ptText(figs.paidShare - prev.paidShare)}`)] : []),
    ...(prev.failRate !== null && figs.failRate !== null ? [line("dispatch_fail_points", figs.failRate - prev.failRate, figs.tx, `Fail rate against the window before: ${ptText(figs.failRate - prev.failRate)}`)] : []),
  );
  const prevShare = new Map(prev.actions.map((a) => [a.key, a.share]));
  const movers = figs.actions.filter((a) => prevShare.has(a.key)).map((a) => ({ key: a.key, delta: a.share - (prevShare.get(a.key) ?? 0), share: a.share, was: prevShare.get(a.key) ?? 0 }));
  const top = movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (top) lines.push(line(`dispatch_share_change.${top.key}`, top.delta, figs.tx, `Largest composition change: ${actionLabel(top.key)}, ${fmtPct(top.was)} to ${fmtPct(top.share)} (${ptText(top.delta)})`));
  return lines;
}

function templateOf(figs: RangeFigures, prev: RangeFigures | null, lines: Line[]): string {
  const get = (key: string) => lines.find((l) => l.key === key);
  if (figs.blocks === 0) return `No block of ${figs.label} is ingested, so nothing can be reported for this window. The Collector has not run over it (KL-1).`;
  const parts: string[] = [
    `${figs.label} UTC: ${fmtInt(figs.tx)} transactions over ${fmtInt(figs.blocks)} ingested blocks${figs.coverage !== null ? ` (${fmtPct(figs.coverage)} of the day)` : ""}${figs.fee !== null ? `, a blended ${fmtUsd(figs.fee)} each` : ""}.`,
  ];
  if (figs.paidShare !== null || figs.failRate !== null) {
    parts.push(`${figs.paidShare !== null ? `Paid share reads ${fmtPct(figs.paidShare)} (an estimate)` : "Paid share is not measurable"}${figs.failRate !== null ? `; ${fmtPct(figs.failRate)} of transactions failed` : ""}.`);
  }
  const txChange = get("dispatch_tx_change");
  const feeChange = get("dispatch_fee_change");
  const paidPoints = get("dispatch_paid_points");
  const failPoints = get("dispatch_fail_points");
  const mover = lines.find((l) => l.key.startsWith("dispatch_share_change."));
  if (prev && (txChange || feeChange)) {
    parts.push(`Against the window before: transactions ${txChange ? pctText(txChange.value) : "n/a"}${feeChange ? `, blended fee ${pctText(feeChange.value)}` : ""}${paidPoints ? `, paid share ${ptText(paidPoints.value)}` : ""}${failPoints ? `, fail rate ${ptText(failPoints.value)}` : ""}.`);
  }
  if (mover) parts.push(`${mover.line}.`);
  return parts.join(" ");
}

// The lens pictures a report can carry (D2): SVG drawn from the report's own figures, each linking to the lens.
function lensImages(figs: RangeFigures, lenses: CustomOptions["lenses"], at: string) {
  const out: { caption: string; svg: string; link: string }[] = [];
  if (lenses === "city" || lenses === "both") {
    out.push({
      caption: "City, one bar per action",
      svg: actionBarsSvg(figs.actions.map((a) => ({ label: actionLabel(a.key), value: a.tx, text: fmtInt(a.tx) }))),
      link: `/lens/city?window=24h&at=${at}`,
    });
  }
  if (lenses === "heatmap" || lenses === "both") {
    out.push({
      caption: "Heatmap, transactions per UTC hour",
      svg: hourGridSvg(figs.hours.map((tx, h) => ({ hour: h, tx })), Math.max(...figs.hours)),
      link: `/lens/heatmap?window=24h&at=${at}`,
    });
  }
  return out;
}

function markdownBody(opts: { title: string; subtitle: string; summary: string; numbers: string[]; findings: InsightT[]; changes: string[]; images: { caption: string; svg: string; link: string }[]; sources: string[]; }): string {
  const out: string[] = [`# ${opts.title}`, "", opts.subtitle, "", "## Summary", "", opts.summary, ""];
  if (opts.numbers.length) out.push("## Numbers", "", ...opts.numbers.map((l) => `- ${l}`), "");
  if (opts.findings.length) {
    out.push("## Findings", "");
    opts.findings.forEach((f, i) => out.push(`${i + 1}. ${f.text} (n = ${fmtInt(f.n)}, [open](${f.evidence_url}))`));
    out.push("");
  }
  if (opts.changes.length) out.push("## Largest changes", "", ...opts.changes.map((l) => `- ${l}`), "");
  for (const img of opts.images) {
    out.push(`## ${img.caption}`, "", "[open the lens](" + img.link + ")", "", "```svg", img.svg, "```", "");
  }
  out.push(
    "## Method",
    "",
    "All numbers come from Metro's stored facts for this window; the prose is written by a model from those facts, and every number in it is checked against them before the report is stored. Facts older than 30 days are pruned unless a report cites them.",
    "",
    "## Sources",
    "",
    ...opts.sources.map((l) => `- ${l}`),
    "",
  );
  return out.join("\n");
}

async function writeProse(question: string, prompt: string, template: string, cites: Cite[], enough: boolean): Promise<{ text: string; modelUsed: string; trail: string[] }> {
  if (!enough) return { text: template, modelUsed: "template", trail: ["Not enough data for prose; the template states it."] };
  const { numbers, times } = windowNumbers(cites, []);
  const ctx = numberContext(cites.map((c) => ({ key: c.key, value: c.value, n: c.n })), numbers, times);
  const out = await writeExplanation({ question, prompt, template, ctx, available: await availableModels() });
  return { text: out.text, modelUsed: out.modelUsed, trail: out.trail };
}

function sourceLines(cites: Cite[]): string[] {
  return cites.map((c) => `${c.key}: ${c.value.toPrecision(5)} (n = ${fmtInt(c.n)}, ${isoDayOf(c.start)} to ${isoDayOf(new Date(c.end.getTime() - 60_000))} UTC)`);
}

const CITE_LABEL: Record<string, string> = {
  "paid_share.before": "Paid share (estimate), before",
  "paid_share.after": "Paid share (estimate), after",
  "tx_per_block.before": "Transactions per covered block, before",
  "tx_per_block.after": "Transactions per covered block, after",
  "est_tx_per_day.before": "Estimated transactions per day, before",
  "est_tx_per_day.after": "Estimated transactions per day, after",
  "days_covered.before": "Days ended, before",
  "days_covered.after": "Days ended, after",
  "block_coverage.before": "Blocks sampled, before",
  "block_coverage.after": "Blocks sampled, after",
  "median_fee_usd.all.before": "Median fee, before",
  "median_fee_usd.all.after": "Median fee, after",
};

function citeLine(c: Cite): string {
  const name = CITE_LABEL[c.key] ?? c.key;
  const value = c.key.startsWith("paid_share") ? fmtPct(c.value) : c.key.startsWith("block_coverage") ? fmtPct(c.value) : c.key.startsWith("est_tx_per_day") ? fmtInt(Math.round(c.value)) : c.key.startsWith("tx_per_block") ? c.value.toFixed(2) : c.key.startsWith("days_covered") ? `${fmtInt(c.value)} of ${fmtInt(c.n)}` : fmtUsd(c.value);
  return `${name}: ${value} (n = ${fmtInt(c.n)})`;
}

export type Figures = { figs: RangeFigures; prev: RangeFigures | null; lines: Line[]; cites: Cite[] };

// Store the range's figures as facts and read them back with their ids; every report number then has a facts_ref entry.
export async function figuresWithFacts(db: Db, figs: RangeFigures, prev: RangeFigures | null, now: Date): Promise<Figures> {
  const lines = figureLines(figs, prev);
  const ids = await saveFacts(db, lines, now);
  const cites: Cite[] = lines
    .map((l) => {
      const id = ids.get(`${l.key}|${l.start.toISOString()}|${l.end.toISOString()}`);
      return id === undefined ? null : { id, key: l.key, value: l.value, n: l.n, start: l.start, end: l.end };
    })
    .filter((c): c is Cite => c !== null);
  return { figs, prev, lines, cites };
}

export async function dailyReport(db: Db, now = new Date()): Promise<BuiltReport> {
  const end = dayStart(now);
  const start = new Date(end.getTime() - DAY_MS);
  const prevStart = new Date(start.getTime() - DAY_MS);
  const [figs, prev] = await Promise.all([rangeFigures(db, start, end), rangeFigures(db, prevStart, start)]);
  const { lines, cites } = await figuresWithFacts(db, figs, prev, now);
  const insights = (await getInsights(db, { rule: null, status: "finding", severity: null }, now)).insights.slice(0, 5);
  const template = templateOf(figs, prev, lines);
  const enough = figs.blocks > 0 && figs.tx > 0;
  const day = isoDayOf(start);
  const at = `${day}T23:59Z`;
  const images = lensImages(figs, "both", at);
  const prose = await writeProse("Summarize this day on Robinhood Chain for Metro's daily report.", ["Topic: daily report", "", ...lines.map((l) => `- ${l.line}`)].join("\n"), template, cites, enough);
  const changes = lines.filter((l) => ["dispatch_tx_change", "dispatch_fee_change", "dispatch_paid_points", "dispatch_fail_points"].includes(l.key) || l.key.startsWith("dispatch_share_change.")).map((l) => l.line);
  const bodyMd = markdownBody({
    title: `Metro Dispatch, ${labelOf(start)}`,
    subtitle: `Window: ${day} 00:00 to ${isoDayOf(end)} 00:00 UTC${figs.coverage !== null ? `; ${fmtInt(figs.blocks)} of about ${fmtInt(figs.expected ?? 0)} blocks (${fmtPct(figs.coverage)}), sampled blocks` : ""}.`,
    summary: prose.text,
    numbers: lines.filter((l) => ["dispatch_tx", "dispatch_fee_usd", "dispatch_paid_share", "dispatch_fail_rate"].includes(l.key) && l.start.getTime() === start.getTime()).map((l) => l.line),
    findings: insights,
    changes,
    images,
    sources: sourceLines(cites),
  });
  const insightFacts = insights.flatMap((i) => i.facts_ref);
  return {
    id: `daily-${day}`,
    kind: "daily",
    rangeLabel: day,
    bodyMd,
    factsRef: [...new Set([...cites.map((c) => c.id), ...insightFacts])],
    modelUsed: prose.modelUsed,
  };
}

export async function subsidyReport(db: Db, now = new Date()): Promise<BuiltReport> {
  const data = await collectTopicData(db, "subsidy", { window: "24h", action: null, token: null, address: null }, now);
  const find = (key: string, side: "before" | "after") => data.cites.find((c) => c.key === `${key}.${side}`);
  const series = ["paid_share", "tx_per_block", "median_fee_usd.all"].map((key) => {
    const b = find(key, "before");
    const a = find(key, "after");
    const fmt = key === "paid_share" ? (v: number | null) => fmtPct(v) : key === "tx_per_block" ? (v: number | null) => (v === null ? "n/a" : v.toFixed(2)) : fmtUsd;
    return { label: key === "paid_share" ? "Paid share" : key === "tx_per_block" ? "Tx per block" : "Median fee", before: b?.value ?? null, after: a?.value ?? null, fmt };
  });
  const prose = await writeProse("Summarize what changed around the subsidy end for Metro's subsidy report.", data.factsPrompt, data.template, data.cites, data.enough);
  const bodyMd = markdownBody({
    title: "Metro Dispatch, subsidy impact",
    subtitle: `Window: ${data.scope.window === "24h" ? "the window before 29 September 2026 against the window after it" : data.title}${find("days_covered", "after") ? `; the after window covers ${fmtInt(find("days_covered", "after")?.value ?? 0)} of ${fmtInt(find("days_covered", "after")?.n ?? 7)} days so far` : "; no block after the end is ingested yet"}.`,
    summary: prose.text,
    numbers: data.cites.filter((c) => CITE_LABEL[c.key] !== undefined).map(citeLine),
    findings: [],
    changes: [],
    images: [{ caption: "Before and after, from the Subsidy Cliff facts", svg: pairBarsSvg(series), link: "/subsidy" }],
    sources: sourceLines(data.cites),
  });
  return { id: "subsidy-impact", kind: "subsidy_impact", rangeLabel: "29 Sep 2026 and after", bodyMd, factsRef: data.cites.map((c) => c.id), modelUsed: prose.modelUsed };
}

export async function customReport(db: Db, from: Date, to: Date, now = new Date(), opts: CustomOptions = CUSTOM_DEFAULT): Promise<BuiltReport> {
  const start = dayStart(from);
  const end = new Date(dayStart(to).getTime() + DAY_MS);
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  const [figs, prev] = await Promise.all([rangeFigures(db, start, end), rangeFigures(db, prevStart, start)]);
  const { lines, cites } = await figuresWithFacts(db, figs, prev, now);
  const insights = opts.findings ? (await getInsights(db, { rule: null, status: "finding", severity: null }, now)).insights.slice(0, 5) : [];
  const template = templateOf(figs, prev, lines);
  const enough = figs.blocks > 0 && figs.tx > 0;
  const at = `${isoDayOf(new Date(end.getTime() - DAY_MS))}T23:59Z`;
  const prose = await writeProse("Summarize this window on Robinhood Chain for a Metro report.", ["Topic: custom report", "", ...lines.map((l) => `- ${l.line}`)].join("\n"), template, cites, enough);
  const changes = opts.changes ? lines.filter((l) => ["dispatch_tx_change", "dispatch_fee_change", "dispatch_paid_points", "dispatch_fail_points"].includes(l.key) || l.key.startsWith("dispatch_share_change.")).map((l) => l.line) : [];
  const bodyMd = markdownBody({
    title: `Metro Dispatch, ${figs.label}`,
    subtitle: `Window: ${isoDayOf(start)} 00:00 to ${isoDayOf(end)} 00:00 UTC (${days} day${days === 1 ? "" : "s"})${figs.coverage !== null ? `; ${fmtInt(figs.blocks)} of about ${fmtInt(figs.expected ?? 0)} blocks (${fmtPct(figs.coverage)}), sampled blocks` : ""}.`,
    summary: prose.text,
    numbers: lines.filter((l) => ["dispatch_tx", "dispatch_fee_usd", "dispatch_paid_share", "dispatch_fail_rate"].includes(l.key) && l.start.getTime() === start.getTime()).map((l) => l.line),
    findings: insights,
    changes,
    images: lensImages(figs, opts.lenses, at),
    sources: sourceLines(cites),
  });
  const id = randomUUID();
  return { id, kind: "custom", rangeLabel: `${isoDayOf(start)} to ${isoDayOf(new Date(end.getTime() - DAY_MS))}`, bodyMd, factsRef: [...new Set([...cites.map((c) => c.id), ...insights.flatMap((i) => i.facts_ref)])], modelUsed: prose.modelUsed };
}

// The cron's entry point: build (or reuse) the daily report, rebuild the subsidy report, and refresh the cached
// Surveyor summary that /subsidy shows (Phase 10's Redis pointer, moved to the fresh report).
export async function runDispatch(db: Db, now = new Date()): Promise<{ daily: string; subsidy: string; created: boolean } | { status: "skipped"; reason: "no_data" }> {
  const [anyBlock] = await rows(db, sql`SELECT count(*) AS n FROM blocks`);
  if (num(anyBlock?.n) === 0) return { status: "skipped", reason: "no_data" };
  const daily = await dailyReport(db, now);
  const [existing] = await db.select({ id: dispatchTable.id }).from(dispatchTable).where(eq(dispatchTable.id, daily.id)).limit(1);
  let created = false;
  if (!existing) {
    await db.insert(dispatchTable).values(daily).onConflictDoNothing();
    created = true;
  }
  const subsidy = await subsidyReport(db, now);
  await db
    .insert(dispatchTable)
    .values(subsidy)
    .onConflictDoUpdate({
      target: dispatchTable.id,
      set: { bodyMd: sql`excluded.body_md`, factsRef: sql`excluded.facts_ref`, modelUsed: sql`excluded.model_used`, rangeLabel: sql`excluded.range_label`, createdAt: sql`excluded.created_at` },
    });
  await setLatestAnswer("subsidy", subsidy.id);
  return { daily: daily.id, subsidy: subsidy.id, created };
}
