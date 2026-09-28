import { createHash } from "node:crypto";
import { actionLabel, formatMetric } from "../lib/city.ts";
import { shortHex } from "../lib/format.ts";
import { toIsoMinute } from "../lib/view-state.ts";
import type { FactContext, FactDraft, Span, Windows } from "./facts.ts";

// Rule-based insights (PROJECT.md 13.2): deterministic functions from facts to findings with a template text, the
// numbers, the sample and an evidence link. Below MIN_SAMPLE a rule is stored as "not enough data", never as a
// finding (AT 15). Wording is neutral: no intent, no advice to buy or sell. Thresholds are Phase 7 D3.

export const THRESHOLDS = {
  gasSpike: 3, // hourly base fee at least 3x the 7-day median of hourly base fee
  dominantWallet: 0.25, // one address sends at least 25 % of an action's transactions in 24 h
  failRateRatio: 2, // fail rate at least 2x the 24 h before
  failRatePoints: 0.02, // and at least 2 percentage points higher
  compositionPoints: 0.05, // an action's share moves at least 5 percentage points
  concentration: 0.5, // top-10 share above 50 % (landing, Phase 6)
} as const;

export type Rule =
  | "cheapest_hour"
  | "action_cost_rank"
  | "gas_spike"
  | "subsidy_shift"
  | "fast_pons_growth"
  | "holder_concentration"
  | "dominant_wallet"
  | "failure_rate_rise"
  | "block_usage"
  | "composition_shift";

export const RULES: { rule: Rule; title: string }[] = [
  { rule: "cheapest_hour", title: "Cheapest and dearest hour" },
  { rule: "action_cost_rank", title: "Fee per action type" },
  { rule: "gas_spike", title: "Gas spike" },
  { rule: "subsidy_shift", title: "Subsidy shift" },
  { rule: "fast_pons_growth", title: "Fast Pons launch" },
  { rule: "holder_concentration", title: "Holder concentration" },
  { rule: "dominant_wallet", title: "Dominant wallet" },
  { rule: "failure_rate_rise", title: "Fail rate rise" },
  { rule: "block_usage", title: "Block usage" },
  { rule: "composition_shift", title: "Composition shift" },
];

export type FactRow = FactDraft & { id: number };
export type InsightDraft = {
  id: string;
  rule: Rule;
  status: "finding" | "not_enough_data";
  text: string;
  severity: "info" | "attention";
  n: number;
  start: Date;
  end: Date;
  evidenceUrl: string;
  factIds: number[];
};
export type RuleContext = FactContext & { minSample: number; windows: Windows; subsidyEnd: Date };

const int = new Intl.NumberFormat("en-US");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const usd = (v: number) => formatMetric(v, "avg_fee_usd");
const hourText = (d: Date) => `${d.toISOString().slice(11, 13)}:00 UTC`;
const dayText = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
const hourKey = (d: Date) => `${d.toISOString().slice(0, 13)}:00Z`;
const idOf = (rule: Rule, subject: string) => `${rule}:${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
const title = (rule: Rule) => RULES.find((r) => r.rule === rule)?.title ?? rule;

function lens(name: string, ctx: RuleContext, params: Record<string, string>): string {
  // `at` pins the view to the anchor minute, so the lens computes the same window as the fact (AT 16).
  const p = new URLSearchParams({ ...params, at: toIsoMinute(ctx.windows.anchor) });
  return `/lens/${name}?${p.toString()}`;
}

// `need` states what is missing; by default "n = k of MIN_SAMPLE needed". Rules that need several subjects above the
// sample (rules 1 and 2) say how many they have instead, so the text never reads "n = 164 of 30 needed" (gate F45).
function notEnough(rule: Rule, ctx: RuleContext, what: string, n: number, s: Span, evidenceUrl: string, factIds: number[], need?: string): InsightDraft {
  return {
    id: idOf(rule, "not_enough_data"),
    rule,
    status: "not_enough_data",
    text: `Not enough data yet for "${title(rule)}": ${what} (${need ?? `n = ${int.format(n)} of ${int.format(ctx.minSample)} needed`}).`,
    severity: "info",
    n,
    start: s.start,
    end: s.end,
    evidenceUrl,
    factIds,
  };
}

const byKey = (facts: FactRow[], key: string) => facts.filter((f) => f.key === key);
const byPrefix = (facts: FactRow[], prefix: string) => facts.filter((f) => f.key.startsWith(prefix));
const sameSpan = (f: FactRow, s: Span) => f.start.getTime() === s.start.getTime() && f.end.getTime() === s.end.getTime();

function cheapestHour(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const hours = byKey(facts, "median_fee_usd.swap.hour");
  const s: Span = { start: ctx.windows.hours[0]?.start ?? ctx.windows.w24.start, end: ctx.windows.anchor };
  const ok = hours.filter((h) => h.n >= ctx.minSample);
  if (ok.length < 2) {
    const busiest = Math.max(0, ...hours.map((h) => h.n));
    return [notEnough("cheapest_hour", ctx, `two hours in the last 24 need ${ctx.minSample} swaps each`, busiest, s, lens("heatmap", ctx, { window: "24h", metric: "avg_fee_usd", action: "swap" }), hours.map((h) => h.id), `${ok.length} of 2 hours have them; the busiest hour has ${int.format(busiest)} swaps`)];
  }
  const low = ok.reduce((a, b) => (b.value < a.value ? b : a));
  const high = ok.reduce((a, b) => (b.value > a.value ? b : a));
  const n = ok.reduce((t, h) => t + h.n, 0);
  return [
    {
      id: idOf("cheapest_hour", "swap"),
      rule: "cheapest_hour",
      status: "finding",
      text: `Median swap fee was lowest at ${hourText(low.start)} on ${dayText(low.start)} (${usd(low.value)}) and highest at ${hourText(high.start)} on ${dayText(high.start)} (${usd(high.value)}), from ${int.format(n)} swaps in ${ok.length} hours with at least ${ctx.minSample} swaps.`,
      severity: "info",
      n,
      start: s.start,
      end: s.end,
      evidenceUrl: lens("heatmap", ctx, { window: "24h", metric: "avg_fee_usd", action: "swap", sel: `hour:${hourKey(low.start)}` }),
      factIds: ok.map((h) => h.id),
    },
  ];
}

function actionCostRank(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const all = byPrefix(facts, "median_fee_usd.").filter((f) => f.key.split(".").length === 2 && sameSpan(f, ctx.windows.w24));
  const ok = all.filter((f) => f.n >= ctx.minSample).sort((a, b) => b.value - a.value);
  const w = ctx.windows.w24;
  if (ok.length < 2) {
    const most = Math.max(0, ...all.map((f) => f.n));
    return [notEnough("action_cost_rank", ctx, `two action types need ${ctx.minSample} transactions each in 24 h`, most, w, lens("city", ctx, { window: "24h", metric: "avg_fee_usd" }), all.map((f) => f.id), `${ok.length} of 2 action types have them; the busiest has ${int.format(most)} transactions`)];
  }
  const action = (f: FactRow) => f.key.split(".")[1] ?? "";
  const list = ok.map((f) => `${actionLabel(action(f))} ${usd(f.value)}`).join(", ");
  const n = ok.reduce((t, f) => t + f.n, 0);
  return [
    {
      id: idOf("action_cost_rank", "24h"),
      rule: "action_cost_rank",
      status: "finding",
      text: `Median fee per transaction over 24 h, highest first: ${list}; from ${int.format(n)} transactions.`,
      severity: "info",
      n,
      start: w.start,
      end: w.end,
      evidenceUrl: lens("city", ctx, { window: "24h", metric: "avg_fee_usd", sel: `action:${action(ok[0] as FactRow)}` }),
      factIds: ok.map((f) => f.id),
    },
  ];
}

function gasSpike(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const med = byKey(facts, "base_fee_gwei.median_hourly")[0];
  const hours = byKey(facts, "base_fee_gwei.hour").sort((a, b) => a.start.getTime() - b.start.getTime());
  const w = ctx.windows.w7;
  const url = lens("heatmap", ctx, { window: "7d", metric: "gas_price" });
  if (!med || med.n < ctx.minSample) return [notEnough("gas_spike", ctx, `the 7-day median needs ${ctx.minSample} hours of blocks`, med?.n ?? 0, w, url, med ? [med.id] : [])];
  const high = hours.filter((h) => med.value > 0 && h.value >= THRESHOLDS.gasSpike * med.value);
  if (!high.length) return [];
  // The longest run of consecutive spike hours.
  let best: FactRow[] = [];
  let run: FactRow[] = [];
  for (const h of high) {
    const prev = run.at(-1);
    run = prev && h.start.getTime() === prev.end.getTime() ? [...run, h] : [h];
    if (run.length > best.length) best = run;
  }
  const peak = best.reduce((a, b) => (b.value > a.value ? b : a));
  return [
    {
      id: idOf("gas_spike", hourKey(peak.start)),
      rule: "gas_spike",
      status: "finding",
      text: `Base fee reached ${(peak.value / med.value).toFixed(1)} times its 7-day hourly median (${peak.value.toFixed(4)} vs ${med.value.toFixed(4)} Gwei) at ${hourText(peak.start)} on ${dayText(peak.start)}, and stayed at 3 times or more for ${best.length} hour${best.length === 1 ? "" : "s"}; from ${int.format(med.n)} hours of blocks.`,
      severity: "attention",
      n: med.n,
      start: w.start,
      end: w.end,
      evidenceUrl: lens("heatmap", ctx, { window: "7d", metric: "gas_price", sel: `hour:${hourKey(peak.start)}` }),
      factIds: [med.id, ...best.map((h) => h.id)],
    },
  ];
}

// Rule 4 over the Subsidy Cliff module's figures (Phase 8): rates per covered block, not per-day sums, because the
// windows are sampled (D1, KL-28); the evidence is /subsidy (KL-27).
function subsidyShift(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const { before, after } = ctx.windows;
  const one = (key: string) => byKey(facts, key)[0];
  const pb = one("paid_share.before");
  const tb = one("tx_per_block.before");
  const pa = one("paid_share.after");
  const ta = one("tx_per_block.after");
  const days = one("days_covered.after");
  const cb = one("block_coverage.before");
  const ca = one("block_coverage.after");
  const url = "/subsidy";
  const s: Span = { start: before.start, end: after?.end ?? before.end };
  if (!after || !pa || !ta) {
    return [notEnough("subsidy_shift", ctx, `no block after ${dayText(ctx.subsidyEnd)} is ingested yet`, pa?.n ?? 0, s, url, [pb?.id, tb?.id].filter((x): x is number => x !== undefined))];
  }
  if (!pb || !tb || pb.n < ctx.minSample || pa.n < ctx.minSample) {
    return [notEnough("subsidy_shift", ctx, "both 7-day windows need transactions", Math.min(pb?.n ?? 0, pa.n), s, url, [pb?.id, tb?.id, pa.id, ta.id].filter((x): x is number => x !== undefined))];
  }
  const change = tb.value > 0 ? (ta.value - tb.value) / tb.value : null;
  const complete = days ? `${int.format(days.value)} of 7 days` : "incomplete";
  const sampled = cb && ca && (cb.value < 0.999 || ca.value < 0.999) ? ` Sampled: ${pct(cb.value)} and ${pct(ca.value)} of blocks.` : "";
  return [
    {
      id: idOf("subsidy_shift", ctx.subsidyEnd.toISOString()),
      rule: "subsidy_shift",
      status: "finding",
      text: `Before ${dayText(ctx.subsidyEnd)} vs after (${complete}): transactions per block ${tb.value.toFixed(1)} to ${ta.value.toFixed(1)}${change === null ? "" : ` (${change >= 0 ? "+" : ""}${pct(change)})`}; paid share (estimate, ArbOS internal transactions left out) ${pct(pb.value)} to ${pct(pa.value)}; from ${int.format(tb.n)} and ${int.format(ta.n)} transactions.${sampled}`,
      severity: "info",
      n: tb.n + ta.n,
      start: s.start,
      end: s.end,
      evidenceUrl: url,
      factIds: [pb.id, tb.id, pa.id, ta.id, ...[days, cb, ca].flatMap((f) => (f ? [f.id] : []))],
    },
  ];
}

const partialNote = (ctx: RuleContext, address: string) => (ctx.complete[address] === false ? " (partial: some blocks since its launch are not ingested)" : "");
const labelOf = (ctx: RuleContext, address: string) => ctx.labels[address] ?? shortHex(address);

function fastPonsGrowth(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const growth = byPrefix(facts, "holder_growth_24h.");
  if (!growth.length) return [];
  const best = growth.reduce((a, b) => (b.value > a.value ? b : a));
  const address = best.key.split(".")[1] ?? "";
  const s: Span = { start: best.start, end: best.end };
  if (best.n < ctx.minSample) return [notEnough("fast_pons_growth", ctx, `the fastest-growing Pons token, ${labelOf(ctx, address)}, has ${int.format(best.n)} holders`, best.n, s, `/token/${address}`, [best.id])];
  if (best.value <= 0) return [];
  return [
    {
      id: idOf("fast_pons_growth", address),
      rule: "fast_pons_growth",
      status: "finding",
      text: `${labelOf(ctx, address)} gained ${int.format(best.value)} holders in 24 h, to ${int.format(best.n)}, the most of any Pons token${partialNote(ctx, address)}.`,
      severity: "info",
      n: best.n,
      start: s.start,
      end: s.end,
      evidenceUrl: `/token/${address}`,
      factIds: [best.id],
    },
  ];
}

function holderConcentration(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const shares = byPrefix(facts, "top10_share.");
  if (!shares.length) return [];
  const ok = shares.filter((f) => f.n >= ctx.minSample);
  if (!ok.length) {
    const most = shares.reduce((a, b) => (b.n > a.n ? b : a));
    const address = most.key.split(".")[1] ?? "";
    return [notEnough("holder_concentration", ctx, `no Pons token has ${ctx.minSample} holders; the most is ${labelOf(ctx, address)} with ${int.format(most.n)}`, most.n, { start: most.start, end: most.end }, "/lens/launchpad", shares.map((f) => f.id))];
  }
  return ok
    .filter((f) => f.value > THRESHOLDS.concentration)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map((f) => {
      const address = f.key.split(".")[1] ?? "";
      const pool = facts.find((x) => x.key === `pool_share.${address}`);
      return {
        id: idOf("holder_concentration", address),
        rule: "holder_concentration" as const,
        status: "finding" as const,
        text: `The top 10 holders of ${labelOf(ctx, address)} hold ${pct(f.value)} of its supply, its curve pool left out${pool ? ` (the pool holds ${pct(pool.value)})` : ""}, across ${int.format(f.n)} holders${partialNote(ctx, address)}.`,
        severity: "info" as const,
        n: f.n,
        start: f.start,
        end: f.end,
        evidenceUrl: `/token/${address}`,
        factIds: [f.id, ...(pool ? [pool.id] : [])],
      };
    });
}

function dominantWallet(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const shares = byPrefix(facts, "wallet_share.");
  const w = ctx.windows.w24;
  const ok = shares.filter((f) => f.n >= ctx.minSample);
  if (!ok.length) {
    const most = Math.max(0, ...shares.map((f) => f.n));
    return shares.length ? [notEnough("dominant_wallet", ctx, `no action type has ${ctx.minSample} transactions from wallets in 24 h`, most, w, lens("city", ctx, { window: "24h" }), shares.map((f) => f.id))] : [];
  }
  return ok
    .filter((f) => f.value >= THRESHOLDS.dominantWallet)
    .sort((a, b) => b.value - a.value)
    .map((f) => {
      const [, action = "", address = ""] = f.key.split(".");
      return {
        id: idOf("dominant_wallet", `${action}|${address}`),
        rule: "dominant_wallet" as const,
        status: "finding" as const,
        text: `One address, ${shortHex(address)}, sent ${pct(f.value)} of ${actionLabel(action)} transactions in 24 h (${int.format(Math.round(f.value * f.n))} of ${int.format(f.n)}).`,
        severity: "info" as const,
        n: f.n,
        start: w.start,
        end: w.end,
        evidenceUrl: `/wallet/${address}`,
        factIds: [f.id],
      };
    });
}

function failureRateRise(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const { w1, baseline24 } = ctx.windows;
  const now = byKey(facts, "fail_rate.all").find((f) => sameSpan(f, w1));
  const base = byKey(facts, "fail_rate.all").find((f) => sameSpan(f, baseline24));
  const s: Span = { start: baseline24.start, end: w1.end };
  const url = lens("city", ctx, { window: "1h", metric: "fail_rate" });
  if (!now || !base || now.n < ctx.minSample || base.n < ctx.minSample) {
    return [notEnough("failure_rate_rise", ctx, "the last hour and the 24 h before it both need transactions", Math.min(now?.n ?? 0, base?.n ?? 0), s, url, [now?.id, base?.id].filter((x): x is number => x !== undefined))];
  }
  if (!(now.value >= THRESHOLDS.failRateRatio * base.value && now.value - base.value >= THRESHOLDS.failRatePoints)) return [];
  const top = byPrefix(facts, "fail_rate.").find((f) => f.key !== "fail_rate.all" && sameSpan(f, w1));
  const action = top?.key.split(".")[1];
  return [
    {
      id: idOf("failure_rate_rise", "1h"),
      rule: "failure_rate_rise",
      status: "finding",
      text: `Fail rate rose to ${pct(now.value)} in the last hour from ${pct(base.value)} in the 24 h before, from ${int.format(now.n)} and ${int.format(base.n)} transactions${top && action ? `; ${actionLabel(action)} had the most failures (${pct(top.value)} of its ${int.format(top.n)})` : ""}.`,
      severity: "attention",
      n: now.n,
      start: s.start,
      end: s.end,
      evidenceUrl: action ? lens("city", ctx, { window: "1h", metric: "fail_rate", sel: `action:${action}` }) : url,
      factIds: [now.id, base.id, ...(top ? [top.id] : [])],
    },
  ];
}

function blockUsage(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const full = byKey(facts, "full_blocks")[0];
  const w = ctx.windows.w24;
  const url = lens("heatmap", ctx, { window: "24h", metric: "gas_volume" });
  if (!full || full.n < ctx.minSample) return [notEnough("block_usage", ctx, `${ctx.minSample} blocks are needed in 24 h`, full?.n ?? 0, w, url, full ? [full.id] : [])];
  if (full.value <= 0) return [];
  const peak = byKey(facts, "full_blocks.hour")[0];
  return [
    {
      id: idOf("block_usage", "24h"),
      rule: "block_usage",
      status: "finding",
      text: `${int.format(full.value)} of ${int.format(full.n)} blocks in 24 h used 90% or more of their gas limit${peak ? `; the most were at ${hourText(peak.start)} on ${dayText(peak.start)} (${int.format(peak.value)} of ${int.format(peak.n)})` : ""}.`,
      severity: "attention",
      n: full.n,
      start: w.start,
      end: w.end,
      evidenceUrl: peak ? lens("heatmap", ctx, { window: "24h", metric: "gas_volume", sel: `hour:${hourKey(peak.start)}` }) : url,
      factIds: [full.id, ...(peak ? [peak.id] : [])],
    },
  ];
}

function compositionShift(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  const { w24, prev24 } = ctx.windows;
  const shares = byPrefix(facts, "action_share.");
  const now = shares.filter((f) => sameSpan(f, w24));
  const prev = shares.filter((f) => sameSpan(f, prev24));
  const s: Span = { start: prev24.start, end: w24.end };
  const nNow = now[0]?.n ?? 0;
  const nPrev = prev[0]?.n ?? 0;
  if (nNow < ctx.minSample || nPrev < ctx.minSample) {
    return [notEnough("composition_shift", ctx, "the last 24 h and the 24 h before both need transactions", Math.min(nNow, nPrev), s, lens("city", ctx, { window: "24h" }), [...now, ...prev].map((f) => f.id))];
  }
  // `other` has no City building, so its evidence link could not select it; the seven PROJECT.md 10.1 actions compete.
  const actions = new Set([...now, ...prev].map((f) => f.key.split(".")[1] ?? "").filter((a) => a !== "" && a !== "other"));
  let best: { action: string; a: number; b: number; ids: number[] } | null = null;
  for (const action of actions) {
    const a = prev.find((f) => f.key === `action_share.${action}`);
    const b = now.find((f) => f.key === `action_share.${action}`);
    const va = a?.value ?? 0;
    const vb = b?.value ?? 0;
    if (!best || Math.abs(vb - va) > Math.abs(best.b - best.a)) best = { action, a: va, b: vb, ids: [a?.id, b?.id].filter((x): x is number => x !== undefined) };
  }
  if (!best || Math.abs(best.b - best.a) < THRESHOLDS.compositionPoints) return [];
  return [
    {
      id: idOf("composition_shift", best.action),
      rule: "composition_shift",
      status: "finding",
      text: `${actionLabel(best.action)} went from ${pct(best.a)} (${int.format(Math.round(best.a * nPrev))} of ${int.format(nPrev)}) to ${pct(best.b)} (${int.format(Math.round(best.b * nNow))} of ${int.format(nNow)}) of transactions, from the 24 h before to the last 24 h.`,
      severity: "info",
      n: nNow + nPrev,
      start: s.start,
      end: s.end,
      evidenceUrl: lens("city", ctx, { window: "24h", sel: `action:${best.action}` }),
      factIds: best.ids,
    },
  ];
}

export function evaluate(facts: FactRow[], ctx: RuleContext): InsightDraft[] {
  return [
    ...cheapestHour(facts, ctx),
    ...actionCostRank(facts, ctx),
    ...gasSpike(facts, ctx),
    ...subsidyShift(facts, ctx),
    ...fastPonsGrowth(facts, ctx),
    ...holderConcentration(facts, ctx),
    ...dominantWallet(facts, ctx),
    ...failureRateRise(facts, ctx),
    ...blockUsage(facts, ctx),
    ...compositionShift(facts, ctx),
  ];
}
