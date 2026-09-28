import { describe, expect, it } from "vitest";
import { parseMarkets } from "./gecko.ts";

// Shape of GET /networks/robinhood/tokens/multi/{addresses}?include=top_pools, trimmed from a live response
// (2026-09-28): token volume is null at the token level, so it is summed from the included top pools.
const body = {
  data: [
    {
      id: "robinhood_0xC40B",
      type: "token",
      attributes: { address: "0xC40B3C8F4443CFCA0696A63B96FFE43F579D5486", price_usd: "0.00000439", volume_usd: { h24: null } },
      relationships: { top_pools: { data: [{ id: "robinhood_0xpool1", type: "pool" }, { id: "robinhood_0xpool2", type: "pool" }] } },
    },
    { id: "robinhood_0xbbbb", type: "token", attributes: { address: "0xbbbb", price_usd: null }, relationships: { top_pools: { data: [] } } },
    { id: "bad", type: "token", attributes: {} },
  ],
  included: [
    { id: "robinhood_0xpool1", type: "pool", attributes: { address: "0xPOOL1", name: "FORGE / WETH", volume_usd: { h24: "60983.25" }, reserve_in_usd: "4330.1" }, relationships: { dex: { data: { id: "pons-v2", type: "dex" } } } },
    { id: "robinhood_0xpool2", type: "pool", attributes: { address: "0xpool2", name: "FORGE / USDC", volume_usd: { h24: "16.75" }, reserve_in_usd: null }, relationships: {} },
    { id: "robinhood_0xpool9", type: "pool", attributes: { address: "0xpool9", name: "unrelated" } },
  ],
};

describe("GeckoTerminal markets (Phase 6 D2)", () => {
  it("sums the top pools' 24 h volume and keeps pool DEX and liquidity", () => {
    const [forge, other] = parseMarkets(body);
    expect(forge).toEqual({
      address: "0xc40b3c8f4443cfca0696a63b96ffe43f579d5486",
      price_usd: 0.00000439,
      volume_24h_usd: 61000,
      pools: [
        { address: "0xpool1", name: "FORGE / WETH", dex: "pons-v2", volume_24h_usd: 60983.25, reserve_usd: 4330.1 },
        { address: "0xpool2", name: "FORGE / USDC", dex: null, volume_24h_usd: 16.75, reserve_usd: null },
      ],
    });
    // No pool reports volume: unknown, not zero.
    expect(other).toEqual({ address: "0xbbbb", price_usd: null, volume_24h_usd: null, pools: [] });
  });

  it("skips entries without an address and tolerates a malformed body", () => {
    expect(parseMarkets(body)).toHaveLength(2);
    expect(parseMarkets(null)).toEqual([]);
    expect(parseMarkets({ data: "x", included: 3 })).toEqual([]);
  });
});
