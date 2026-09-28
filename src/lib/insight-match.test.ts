import { describe, expect, it } from "vitest";
import type { InsightT } from "./api-types.ts";
import { mentions, relatedTo, subjectsOf } from "./insight-match.ts";

// Which insights mention an object (PROJECT.md 11.1, 15; gates F48, F52).
const base: InsightT = {
  id: "x",
  rule: "action_cost_rank",
  title: "Fee per action type",
  status: "finding",
  severity: "info",
  text: "",
  n: 100,
  window: { start: "2026-09-26T15:52:00.000Z", end: "2026-09-27T15:52:00.000Z" },
  evidence_url: "/lens/city?window=24h&metric=avg_fee_usd&sel=action%3Aswap&at=2026-09-27T15%3A51Z",
  facts_ref: [],
  subjects: [],
  created_at: "",
  expires_at: "",
};
const TOKEN = "0xc40b3c8f4443cfca0696a63b96ffe43f579d5486";

describe("subjectsOf", () => {
  it("names the actions, tokens, hours and wallets of the cited facts", () => {
    expect(
      subjectsOf([
        { key: "median_fee_usd.swap", start: "2026-09-26T15:52:00.000Z" },
        { key: "median_fee_usd.approve", start: "2026-09-26T15:52:00.000Z" },
        { key: "median_fee_usd.swap.hour", start: "2026-09-27T15:00:00.000Z" },
        { key: `top10_share.${TOKEN}`, start: "2026-09-27T15:51:13.000Z" },
        { key: "wallet_share.swap.0x49bbf2b70955fb3a106e084d4bfda92d334573d2", start: "2026-09-26T15:52:00.000Z" },
        { key: "fail_rate.all", start: "2026-09-27T14:52:00.000Z" },
        { key: "fail_rate.contract_call", start: "2026-09-27T14:52:00.000Z" },
      ]),
    ).toEqual([
      "action:approve",
      "action:contract_call",
      "action:swap",
      "hour:2026-09-27T15:00Z",
      `token:${TOKEN}`,
      "wallet:0x49bbf2b70955fb3a106e084d4bfda92d334573d2",
    ]);
  });
});

describe("mentions and relatedTo", () => {
  it("matches every cited action, not only the one the evidence selects (F48)", () => {
    const rank = { ...base, subjects: ["action:approve", "action:swap"] };
    expect(mentions(rank, { kind: "action", key: "approve" })).toBe(true);
    expect(mentions(rank, { kind: "action", key: "bridge" })).toBe(false);
  });

  it("falls back to what the evidence link selects or opens", () => {
    expect(mentions(base, { kind: "action", key: "swap" })).toBe(true);
    expect(mentions({ ...base, evidence_url: `/token/${TOKEN}` }, { kind: "token", key: TOKEN.toUpperCase() })).toBe(true);
    expect(mentions({ ...base, evidence_url: "/lens/heatmap?sel=hour%3A2026-09-27T15%3A00Z" }, { kind: "hour", key: "2026-09-27T15:00Z" })).toBe(true);
    expect(mentions({ ...base, evidence_url: "/lens/heatmap?sel=hour%3A2026-09-27T15%3A00Z" }, { kind: "hour", key: "2026-09-27T16:00Z" })).toBe(false);
  });

  it("filters a list", () => {
    const other = { ...base, id: "y", evidence_url: "/lens/launchpad", subjects: [] };
    expect(relatedTo([base, other], { kind: "action", key: "swap" }).map((i) => i.id)).toEqual(["x"]);
  });
});
