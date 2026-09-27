import { describe, expect, it } from "vitest";
import { buildingHeights, costColor, feeScale, formatMetric, MAX_HEIGHT, MIN_HEIGHT, slotPosition, type CityBuilding } from "../lib/city.ts";
import { parseInspectorParams, resolveRange } from "./city.ts";

const q = (s: string) => new URLSearchParams(s);
const anchor = new Date("2026-09-27T06:15:29Z");

describe("resolveRange", () => {
  it("reads whole minutes for windows up to 24h, ending with the anchor block's minute", () => {
    const r = resolveRange("1h", anchor);
    expect(r.basis).toBe("txs");
    expect(r.end.toISOString()).toBe("2026-09-27T06:16:00.000Z");
    expect(r.start?.toISOString()).toBe("2026-09-27T05:16:00.000Z");
  });

  it("reads whole UTC days for 7d and 30d, including the anchor's day", () => {
    const r = resolveRange("7d", anchor);
    expect(r).toMatchObject({ basis: "agg_day", startDay: "2026-09-21", endDay: "2026-09-27" });
    expect(r.end.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("has no lower bound for all", () => {
    expect(resolveRange("all", anchor)).toMatchObject({ basis: "agg_day", start: null, startDay: null, endDay: "2026-09-27" });
  });
});

describe("parseInspectorParams (PROJECT.md 18)", () => {
  it("accepts actions and token addresses, lower-casing the address", () => {
    expect(parseInspectorParams(q("kind=action&key=swap"))).toEqual({ kind: "action", key: "swap", window: "24h" });
    expect(parseInspectorParams(q("kind=token&key=0x8B6ADC71111029E4FC2A6E20806955FD3D92D593&window=7d"))).toEqual({
      kind: "token",
      key: "0x8b6adc71111029e4fc2a6e20806955fd3d92d593",
      window: "7d",
    });
  });

  it("rejects unknown kinds, actions without a building, bad addresses and windows", () => {
    expect(parseInspectorParams(q("kind=wallet&key=swap"))).toMatch(/^kind/);
    expect(parseInspectorParams(q("kind=action&key=other"))).toMatch(/^key must be one of/);
    expect(parseInspectorParams(q("kind=token&key=0x123"))).toMatch(/token address/);
    expect(parseInspectorParams(q("kind=action&key=swap&window=2d"))).toMatch(/^window/);
  });
});

const b = (key: string, tx: number, fee: number | null): CityBuilding => ({ kind: "action", key, label: key, tx_count: tx, gas_volume: tx * 100, avg_fee_usd: fee, wallets: null, fail_rate: null });

describe("city layout helpers", () => {
  it("scales heights on one shared scale with a visible minimum", () => {
    const heights = buildingHeights([b("a", 100, 0.01), b("b", 25, 0.02), b("c", 0, null)], "tx_count");
    expect(heights).toEqual([MAX_HEIGHT, MAX_HEIGHT / 4, MIN_HEIGHT]);
    // A metric that is null everywhere (wallets on a daily window) keeps every building at the minimum.
    expect(buildingHeights([b("a", 100, 0.01)], "wallets")).toEqual([MIN_HEIGHT]);
  });

  it("colors by fee relative to the most expensive building and greys out missing fees", () => {
    const s = feeScale([b("a", 1, 0.02), b("b", 1, 0.01), b("c", 1, null)]);
    expect(s.max).toBe(0.02);
    expect(s.colors[0]).toEqual(costColor(1));
    expect(s.colors[1]).toEqual(costColor(0.5));
    expect(s.colors[2]).toEqual([0x3a / 255, 0x41 / 255, 0x52 / 255]);
  });

  it("follows the prototype cost scale end points and slots", () => {
    expect(costColor(0).map((c) => Math.round(c * 255))).toEqual([47, 212, 180]);
    expect(costColor(1).map((c) => Math.round(c * 255))).toEqual([239, 75, 75]);
    expect(slotPosition(0)).toEqual({ x: -7.5, z: -7.5 });
    expect(slotPosition(7)).toEqual({ x: -7.5, z: 2.5 });
  });

  it("formats each metric", () => {
    expect(formatMetric(0.003749, "avg_fee_usd")).toBe("$0.00375");
    expect(formatMetric(0.0123, "fail_rate")).toBe("1.2%");
    expect(formatMetric(1_234_567, "gas_volume")).toBe("1.2M");
    expect(formatMetric(null, "wallets")).toBe("—");
  });
});
