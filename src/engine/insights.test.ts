import { describe, expect, it } from "vitest";
import { engineWindows, medianDisc, type FactDraft } from "./facts.ts";
import { evaluate, type FactRow, type RuleContext } from "./insights.ts";

// Pure parts of the Phase 7 engine: windows, the median, and every rule's finding, "not enough data" and
// "no finding" paths (PROJECT.md 13.2, AT 15, thresholds Phase 7 D3).

const ANCHOR = new Date("2026-10-02T15:51:16Z");
const END = new Date("2026-09-29T00:00:00Z");
const w = engineWindows(ANCHOR, END);
const H = 3_600_000;
let nextId = 1;
const fact = (key: string, s: { start: Date; end: Date }, value: number, n: number): FactRow => ({ key, start: s.start, end: s.end, value, n, id: nextId++ });
const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({ minSample: 30, windows: w, subsidyEnd: END, labels: {}, complete: {}, ...over });
const only = (facts: FactRow[], rule: string, c = ctx()) => evaluate(facts, c).filter((i) => i.rule === rule);
const hour = (i: number) => w.hours[i] as { start: Date; end: Date };

describe("engine windows", () => {
  it("match the lenses' ranges and the subsidy windows", () => {
    expect(w.w24).toEqual({ start: new Date("2026-10-01T15:52:00Z"), end: new Date("2026-10-02T15:52:00Z") });
    expect(w.w1.start).toEqual(new Date("2026-10-02T14:52:00Z"));
    expect(w.baseline24).toEqual({ start: new Date("2026-10-01T14:52:00Z"), end: new Date("2026-10-02T14:52:00Z") });
    expect(w.w7).toEqual({ start: new Date("2026-09-26T00:00:00Z"), end: new Date("2026-10-03T00:00:00Z") });
    expect(w.hours).toHaveLength(24);
    expect(hour(23)).toEqual({ start: new Date("2026-10-02T15:00:00Z"), end: new Date("2026-10-02T16:00:00Z") });
    expect(w.before).toEqual({ start: new Date("2026-09-22T00:00:00Z"), end: END });
    expect(w.after).toEqual({ start: END, end: new Date("2026-10-03T00:00:00Z") });
    expect(engineWindows(new Date("2026-09-27T15:51:16Z"), END).after).toBeNull();
  });

  it("takes the lower middle value as the median, like percentile_disc(0.5)", () => {
    expect(medianDisc([3, 1, 2])).toBe(2);
    expect(medianDisc([4, 1, 3, 2])).toBe(2);
    expect(medianDisc([])).toBeNull();
  });
});

describe("rules (PROJECT.md 13.2)", () => {
  it("cheapest_hour: lowest and highest median with n, and the evidence opens that hour", () => {
    const facts = [fact("median_fee_usd.swap.hour", hour(3), 0.004, 40), fact("median_fee_usd.swap.hour", hour(15), 0.012, 50), fact("median_fee_usd.swap.hour", hour(20), 0.001, 5)];
    const [i] = only(facts, "cheapest_hour");
    expect(i).toMatchObject({ status: "finding", n: 90, severity: "info" });
    expect(i?.text).toContain("lowest at 19:00 UTC on 01 Oct ($0.00400)");
    expect(i?.text).toContain("highest at 07:00 UTC on 02 Oct ($0.0120)");
    expect(i?.evidenceUrl).toBe("/lens/heatmap?window=24h&metric=avg_fee_usd&action=swap&sel=hour%3A2026-10-01T19%3A00Z&at=2026-10-02T15%3A51Z");
    // The 5-swap hour is below MIN_SAMPLE and is left out, not cited.
    expect(i?.factIds).toHaveLength(2);
  });

  it("cheapest_hour: under MIN_SAMPLE it is 'not enough data', never a finding (AT 15)", () => {
    const [i] = only([fact("median_fee_usd.swap.hour", hour(3), 0.004, 12)], "cheapest_hour");
    expect(i).toMatchObject({ status: "not_enough_data", n: 12 });
    expect(i?.text).toBe('Not enough data yet for "Cheapest and dearest hour": two hours in the last 24 need 30 swaps each (0 of 2 hours have them; the busiest hour has 12 swaps).');
  });

  it("cheapest_hour: one hour above the sample is still not enough, and the text says why (gate F45)", () => {
    const [i] = only([fact("median_fee_usd.swap.hour", hour(3), 0.004, 164), fact("median_fee_usd.swap.hour", hour(4), 0.005, 8)], "cheapest_hour");
    expect(i?.status).toBe("not_enough_data");
    expect(i?.text).toContain("(1 of 2 hours have them; the busiest hour has 164 swaps)");
    expect(i?.text).not.toContain("of 30 needed");
  });

  it("action_cost_rank: ranks actions by median fee, highest first", () => {
    const facts = [fact("median_fee_usd.swap", w.w24, 0.02, 100), fact("median_fee_usd.approve", w.w24, 0.003, 40), fact("median_fee_usd.bridge", w.w24, 0.5, 2)];
    const [i] = only(facts, "action_cost_rank");
    expect(i?.text).toBe("Median fee per transaction over 24 h, highest first: Swap $0.0200, Approve $0.00300; from 140 transactions.");
    expect(i?.evidenceUrl).toContain("sel=action%3Aswap");
  });

  it("gas_spike: needs a 7-day median over MIN_SAMPLE hours, then reports the longest run of 3x hours", () => {
    const hours = Array.from({ length: 40 }, (_, i) => ({ start: new Date(w.w7.start.getTime() + i * H), end: new Date(w.w7.start.getTime() + (i + 1) * H) }));
    const facts = [
      fact("base_fee_gwei.median_hourly", w.w7, 0.02, 40),
      ...hours.map((s, i) => fact("base_fee_gwei.hour", s, i === 10 || i === 11 ? 0.07 : i === 30 ? 0.1 : 0.02, 3600)),
    ];
    const [i] = only(facts, "gas_spike");
    expect(i).toMatchObject({ status: "finding", severity: "attention", n: 40 });
    expect(i?.text).toContain("3.5 times its 7-day hourly median");
    expect(i?.text).toContain("for 2 hours");
    expect(only([fact("base_fee_gwei.median_hourly", w.w7, 0.02, 40), fact("base_fee_gwei.hour", hours[0] as { start: Date; end: Date }, 0.03, 3600)], "gas_spike")).toEqual([]);
    expect(only([fact("base_fee_gwei.median_hourly", w.w7, 0.02, 2)], "gas_spike")[0]?.status).toBe("not_enough_data");
  });

  it("subsidy_shift: before vs after with the covered days, or not enough data before any block after the end", () => {
    const after = w.after as { start: Date; end: Date };
    const facts = [
      fact("paid_share.before", w.before, 0.2, 7000),
      fact("tx_per_day.before", w.before, 1000, 7000),
      fact("paid_share.after", after, 0.8, 4000),
      fact("tx_per_day.after", after, 1000, 4000),
      fact("days_covered.after", after, 4, 4),
    ];
    const [i] = only(facts, "subsidy_shift");
    expect(i?.text).toBe("Before 29 Sep vs after (4 of 7 days): transactions per day 1,000 to 1,000 (+0.0%); paid share (estimate) 20.0% to 80.0%; from 7,000 and 4,000 transactions.");
    const early = engineWindows(new Date("2026-09-27T15:51:16Z"), END);
    expect(only([], "subsidy_shift", ctx({ windows: early }))[0]?.text).toContain("no block after 29 Sep is ingested yet");
  });

  it("fast_pons_growth and holder_concentration: token labels, KL-25 pool share, partial note", () => {
    const token = "0x00000000000000000000000000000000000d6001";
    const s = { start: new Date(ANCHOR.getTime() - 24 * H), end: ANCHOR };
    const facts = [fact(`holder_growth_24h.${token}`, s, 40, 120), fact(`top10_share.${token}`, s, 0.62, 120), fact(`pool_share.${token}`, s, 0.3, 120)];
    const c = ctx({ labels: { [token]: "SIX" }, complete: { [token]: false } });
    expect(only(facts, "fast_pons_growth", c)[0]?.text).toBe("SIX gained 40 holders in 24 h, to 120, the most of any Pons token (partial: some blocks since its launch are not ingested).");
    const [conc] = only(facts, "holder_concentration", c);
    expect(conc?.text).toContain("The top 10 holders of SIX hold 62.0% of its supply, its curve pool left out (the pool holds 30.0%), across 120 holders");
    expect(conc?.evidenceUrl).toBe(`/token/${token}`);
    expect(only([fact(`top10_share.${token}`, s, 0.4, 120)], "holder_concentration", c)).toEqual([]);
  });

  it("dominant_wallet: at least 25 % of an action's transactions, neutral wording, no label", () => {
    const addr = "0x49bbf2b70955fb3a106e084d4bfda92d334573d2";
    const [i] = only([fact(`wallet_share.swap.${addr}`, w.w24, 0.4, 500), fact("wallet_share.approve.0x1111111111111111111111111111111111111111", w.w24, 0.1, 300)], "dominant_wallet");
    expect(i?.text).toBe("One address, 0x49bb…73d2, sent 40.0% of Swap transactions in 24 h (200 of 500).");
    expect(i?.evidenceUrl).toBe(`/wallet/${addr}`);
  });

  it("failure_rate_rise: at least 2x and +2 points, with the action that failed most", () => {
    const facts = [fact("fail_rate.all", w.w1, 0.1, 1000), fact("fail_rate.all", w.baseline24, 0.03, 20000), fact("fail_rate.swap", w.w1, 0.3, 200)];
    const [i] = only(facts, "failure_rate_rise");
    expect(i).toMatchObject({ severity: "attention", n: 1000 });
    expect(i?.text).toContain("Fail rate rose to 10.0% in the last hour from 3.0% in the 24 h before");
    expect(i?.text).toContain("Swap had the most failures (30.0% of its 200)");
    // 2x but only +1 point: no finding.
    expect(only([fact("fail_rate.all", w.w1, 0.02, 1000), fact("fail_rate.all", w.baseline24, 0.01, 20000)], "failure_rate_rise")).toEqual([]);
  });

  it("block_usage: reports full blocks, or nothing when none is full (KL-11)", () => {
    expect(only([fact("full_blocks", w.w24, 0, 800000)], "block_usage")).toEqual([]);
    const [i] = only([fact("full_blocks", w.w24, 12, 800000), fact("full_blocks.hour", hour(5), 9, 36000)], "block_usage");
    expect(i?.text).toBe("12 of 800,000 blocks in 24 h used 90% or more of their gas limit; the most were at 21:00 UTC on 01 Oct (9 of 36,000).");
  });

  it("composition_shift: the largest change of at least 5 points between the two 24 h windows", () => {
    const facts = [
      fact("action_share.swap", w.prev24, 0.2, 1000),
      fact("action_share.swap", w.w24, 0.3, 2000),
      fact("action_share.approve", w.prev24, 0.1, 1000),
      fact("action_share.approve", w.w24, 0.11, 2000),
      fact("action_share.other", w.prev24, 0.0, 1000),
      fact("action_share.other", w.w24, 0.4, 2000),
    ];
    const [i] = only(facts, "composition_shift");
    // `other` has no City building, so it is not the one reported.
    expect(i?.text).toBe("Swap went from 20.0% (200 of 1,000) to 30.0% (600 of 2,000) of transactions, from the 24 h before to the last 24 h.");
    expect(only([fact("action_share.swap", w.w24, 0.3, 2000)], "composition_shift")[0]?.status).toBe("not_enough_data");
  });

  it("gives every insight an id, n, window and evidence link, and never duplicates ids", () => {
    const facts: FactDraft[] = [];
    const all = evaluate([...facts.map((f, i) => ({ ...f, id: i }))], ctx());
    for (const i of all) {
      expect(i.id.length).toBeLessThanOrEqual(64);
      expect(i.evidenceUrl.startsWith("/")).toBe(true);
      expect(Number.isFinite(i.n)).toBe(true);
      expect(i.start.getTime()).toBeLessThanOrEqual(i.end.getTime());
    }
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
  });
});
