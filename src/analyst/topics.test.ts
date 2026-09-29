import { describe, expect, it } from "vitest";
import { extractAddress, lensFor, matchRefusal, matchTopic, normalizeScope, TOPIC_KEYS, TOPICS } from "./topics.ts";
import { mapQuestion, parseMapping } from "./map.ts";

// The topic catalogue and the mapping rules (PROJECT.md 13.3; Phase 10 D1, D2). The model fallback is covered live and
// in ladder.test.ts; here are the pure paths.

const base = { window: "24h" as const, action: null, token: null, address: null };

describe("topics", () => {
  it("every example question maps to its own topic without a model call", () => {
    for (const key of TOPIC_KEYS) {
      const found = matchTopic(TOPICS[key].question);
      expect(found, `${key}: "${TOPICS[key].question}" -> ${found}`).toBe(key);
    }
  });

  it("refuses advice, price predictions, identity claims and raw-data asks", () => {
    expect(matchRefusal("Should I buy this token now?")).toMatch(/advice/);
    expect(matchRefusal("What is the price of ETH?")).toMatch(/predict/);
    expect(matchRefusal("Who is the real owner of this wallet?")).toMatch(/identit/);
    expect(matchRefusal("Give me the raw transactions of this address.")).toMatch(/raw data/);
    expect(matchRefusal("Which action costs the most?")).toBeNull();
  });

  it("a refusal wins over a topic keyword", async () => {
    const m = await mapQuestion("Should I buy while swaps are cheapest?", base, null);
    expect(m.kind).toBe("refused");
  });

  it("keyword mapping fills slots from the question and checks what a topic needs", async () => {
    const withAddress = await mapQuestion(`How is this token doing? ${"0x" + "a".repeat(40)}`, base, null);
    expect(withAddress).toMatchObject({ kind: "topic", topic: "token", scope: { token: `0x${"a".repeat(40)}` } });
    const without = await mapQuestion("How is this token doing?", base, null);
    expect(without).toMatchObject({ kind: "refused" });
    const wallet = await mapQuestion("How has this wallet behaved?", base, null);
    expect(wallet).toMatchObject({ kind: "refused", reason: expect.stringMatching(/address/) });
  });
});

describe("scope and mapping parsing", () => {
  it("drops invalid scope values and keeps valid ones", () => {
    expect(normalizeScope({ window: "2d", action: "nope", token: "0x1", address: "0x" })).toEqual(base);
    const good = normalizeScope({ window: "1h", action: "swap", token: `0x${"b".repeat(40)}`, address: `0x${"c".repeat(40)}` });
    expect(good).toEqual({ window: "1h", action: "swap", token: `0x${"b".repeat(40)}`, address: `0x${"c".repeat(40)}` });
  });

  it("reads the classifier's JSON, fenced or not", () => {
    expect(parseMapping('```json\n{"topic":"cost","window":"24h","action":null,"token":null,"address":null}\n```', base)).toEqual({ topic: "cost", scope: base });
    expect(parseMapping('{"topic":"none"}', base)).toEqual({ topic: "none", scope: base });
    expect(parseMapping('{"topic":"sybil"}', base)).toBeNull();
    expect(parseMapping('{"topic":"cost","action":"teleport"}', base)).toBeNull();
    expect(parseMapping("I think the answer is cost", base)).toBeNull();
    const merged = parseMapping('{"topic":"token","window":"1h","token":"0x' + "d".repeat(40) + '"}', { ...base, action: "swap" });
    expect(merged).toEqual({ topic: "token", scope: { window: "1h", action: "swap", token: `0x${"d".repeat(40)}`, address: null } });
  });

  it("finds a 0x address in the question", () => {
    expect(extractAddress("How is 0xAbCdEf0000000000000000000000000000000001 doing?")).toBe("0xabcdef0000000000000000000000000000000001");
    expect(extractAddress("How is this token doing?")).toBeNull();
  });
});

describe("lensFor (gate F73)", () => {
  it("maps a fact key to the lens that shows it", () => {
    expect(lensFor("median_fee_usd.swap.hour")).toContain("/lens/heatmap");
    expect(lensFor("base_fee_gwei.median_hourly")).toContain("metric=gas_price");
    expect(lensFor("full_blocks")).toContain("/lens/terrain");
    expect(lensFor(`token_tx.${"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`)).toBe(`/token/${"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`);
    expect(lensFor(`wallet_tx.${"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`)).toBe(`/wallet/${"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`);
    expect(lensFor(`wallet_share.swap.${"0xdddddddddddddddddddddddddddddddddddddddd"}`)).toContain("/lens/city");
    expect(lensFor(`holder_growth_24h.${"0xcccccccccccccccccccccccccccccccccccccccc"}`)).toContain("/lens/launchpad");
    expect(lensFor("paid_share.before")).toBe("/subsidy");
    expect(lensFor("median_fee_usd.all.after")).toBe("/subsidy");
    expect(lensFor("median_fee_usd.swap")).toContain("/lens/city");
    expect(lensFor("fail_rate.all")).toContain("/lens/city");
  });
});
