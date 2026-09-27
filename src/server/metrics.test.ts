import { describe, expect, it } from "vitest";
import { parseBreakdownParams, parseSeriesParams } from "./metrics.ts";

const q = (s: string) => new URLSearchParams(s);

describe("parseSeriesParams (PROJECT.md 16)", () => {
  it("accepts a valid request and fills defaults", () => {
    expect(parseSeriesParams(q("metric=tx_count"))).toEqual({ metric: "tx_count", window: "24h", bucket: "1h" });
    expect(parseSeriesParams(q("metric=avg_fee_usd&window=30d&bucket=1d"))).toEqual({ metric: "avg_fee_usd", window: "30d", bucket: "1d" });
  });

  it("rejects unknown values", () => {
    expect(parseSeriesParams(q("metric=price"))).toMatch(/^metric must be/);
    expect(parseSeriesParams(q("metric=tx_count&window=2d"))).toMatch(/^window must be/);
    expect(parseSeriesParams(q("metric=tx_count&bucket=10m"))).toMatch(/^bucket must be/);
    expect(parseSeriesParams(q("metric=tx_count&window=toString"))).toMatch(/^window must be/);
  });

  it("caps the number of points", () => {
    expect(parseSeriesParams(q("metric=tx_count&window=30d&bucket=1m"))).toMatch(/exceeds 2000 points/);
    expect(parseSeriesParams(q("metric=tx_count&window=24h&bucket=1m"))).toEqual({ metric: "tx_count", window: "24h", bucket: "1m" });
  });

  it("limits non-additive metrics to 24 hours (KL-17)", () => {
    expect(parseSeriesParams(q("metric=median_fee_usd&window=7d&bucket=1h"))).toMatch(/up to 24h/);
    expect(parseSeriesParams(q("metric=wallets&window=all&bucket=1d"))).toMatch(/up to 24h/);
    expect(parseSeriesParams(q("metric=wallets&window=24h&bucket=1d"))).toMatch(/smaller than/);
    expect(parseSeriesParams(q("metric=wallets&window=1h&bucket=5m"))).toEqual({ metric: "wallets", window: "1h", bucket: "5m" });
  });
});

describe("parseBreakdownParams", () => {
  it("defaults and validates", () => {
    expect(parseBreakdownParams(q(""))).toEqual({ by: "action", window: "24h" });
    expect(parseBreakdownParams(q("by=subsidy&window=7d"))).toEqual({ by: "subsidy", window: "7d" });
    expect(parseBreakdownParams(q("by=token"))).toMatch(/^by must be/);
    expect(parseBreakdownParams(q("window=1h"))).toMatch(/^window must be/);
  });
});
