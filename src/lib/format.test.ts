import { describe, expect, it } from "vitest";
import { formatCountCompact, formatDay, formatGwei, formatUsdCompact } from "./format.ts";

describe("formatUsdCompact", () => {
  it("compacts large amounts and keeps small ones whole", () => {
    expect(formatUsdCompact(1_031_123_532.6)).toBe("$1.03B");
    expect(formatUsdCompact(91_274)).toBe("$91.27K");
    expect(formatUsdCompact(812.4)).toBe("$812");
    expect(formatUsdCompact(Number.NaN)).toBe("—");
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
