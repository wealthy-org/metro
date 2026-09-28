import { describe, expect, it } from "vitest";
import { feeTop } from "./city.ts";
import { formatAge, formatCountCompact, formatDay, formatGwei, formatUsdCompact, NA, shortHex, utcMinute } from "./format.ts";

describe("formatUsdCompact", () => {
  it("compacts large amounts and keeps small ones whole", () => {
    expect(formatUsdCompact(1_031_123_532.6)).toBe("$1.03B");
    expect(formatUsdCompact(91_274)).toBe("$91.27K");
    expect(formatUsdCompact(812.4)).toBe("$812");
    expect(formatUsdCompact(Number.NaN)).toBe(NA);
  });
});

describe("shared helpers (gate F37)", () => {
  const launch = "2026-09-27T15:51:13.000Z";
  const at = Date.parse(launch);
  it("formats an age in minutes, hours or days", () => {
    expect(formatAge(launch, at)).toBe("1 min");
    expect(formatAge(launch, at + 42 * 60_000)).toBe("42 min");
    expect(formatAge(launch, at + 15 * 3_600_000)).toBe("15 h");
    expect(formatAge(launch, at + 3 * 86_400_000)).toBe("3 d");
    expect(formatAge("not a date", at)).toBe(NA);
  });
  it("shortens hashes and formats UTC minutes", () => {
    expect(shortHex("0xc40b3c8f4443cfca0696a63b96ffe43f579d5486")).toBe("0xc40b…5486");
    expect(shortHex("0x1234")).toBe("0x1234");
    expect(utcMinute(launch)).toBe("2026-09-27 15:51 UTC");
  });
  it("tops the fee scale at the 95th percentile", () => {
    const fees = [...Array.from({ length: 99 }, (_, i) => i / 100), 50];
    expect(feeTop(fees)).toBe(0.94);
    expect(feeTop([])).toBe(1e-9);
  });
});

describe("formatCountCompact", () => {
  it("compacts counts", () => {
    expect(formatCountCompact(1_234_567_890)).toBe("1.23B");
    expect(formatCountCompact(845_300)).toBe("845.3K");
  });
});

describe("formatGwei and formatDay", () => {
  it("formats gwei with four decimals and a UTC day label", () => {
    expect(formatGwei(0.021574)).toBe("0.0216");
    expect(formatDay("2026-09-26")).toBe("Sep 26");
  });
});
