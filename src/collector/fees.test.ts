import { describe, expect, it } from "vitest";
import { feeEth, feeUsd, formatFixed, parseDecimal } from "./fees.ts";

describe("fees (PROJECT.md 22, acceptance test 5)", () => {
  it("formats wei as exact ETH", () => {
    expect(feeEth(123_456_789_000_000_000n)).toBe("0.123456789");
    expect(feeEth(0n)).toBe("0");
    expect(feeEth(10n ** 18n)).toBe("1");
  });

  it("fee_usd equals fee in ETH times the ETH price", () => {
    expect(feeUsd(10n ** 18n, "4012.34")).toBe("4012.34");
    expect(feeUsd(5n * 10n ** 14n, "3000.5")).toBe("1.50025");
  });

  it("matches a real receipt: 140,776 gas at 23,312,000 wei, ETH at 4012.34567891", () => {
    // 3.281770112e-6 ETH * 4012.34567891 = 0.0131675961280591... truncated to 12 decimals.
    expect(feeUsd(140_776n * 23_312_000n, "4012.34567891")).toBe("0.013167596128");
  });

  it("uses the full price precision (DefiLlama returns up to 13 decimals)", () => {
    // Stored row from the Phase 1 run: 0.000102042711174 ETH * 2696.2505966583512 = 0.27513272088753...
    expect(feeUsd(102_042_711_174_000n, "2696.2505966583512")).toBe("0.275132720887");
  });

  it("parses decimals without rounding and rejects malformed input", () => {
    expect(parseDecimal("1.123456789")).toEqual({ units: 1_123_456_789n, digits: 9 });
    expect(parseDecimal("42")).toEqual({ units: 42n, digits: 0 });
    expect(() => parseDecimal("1e3")).toThrow();
    expect(() => parseDecimal("-1")).toThrow();
  });

  it("formatFixed trims trailing zeros", () => {
    expect(formatFixed(1_500n, 3)).toBe("1.5");
    expect(formatFixed(7n, 3)).toBe("0.007");
  });
});
