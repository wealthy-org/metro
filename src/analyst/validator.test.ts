import { describe, expect, it } from "vitest";
import { adviceIssue } from "./advice.ts";
import { checkNumbers, numberContext } from "./validator.ts";

// The numeric validator (PROJECT.md 13.3 step 4; Phase 10 D4, AT 17) and the advice filter (AT 18).
const ctx = numberContext(
  [
    { key: "paid_share.before", value: 0.9995054634513941, n: 42464 },
    { key: "est_tx_per_day.before", value: 13_278_663.127712535, n: 45402 },
    { key: "median_fee_usd.swap", value: 0.009256131477023, n: 2147 },
  ],
  [29, 7, 24, 45402, 13278663],
  ["06:00", "14:00"],
);

describe("checkNumbers", () => {
  it("accepts a fact rounded to the digits written, with units", () => {
    for (const text of [
      "Paid share reads 99.95%.",
      "Paid share reads 100%.",
      "Paid share reads 0.9995.",
      "About 13.3M transactions a day.",
      "About 13.28M transactions a day.",
      "The median swap fee was $0.00926.",
      "From 42,464 user transactions.",
      "The window is 7 days and the cliff is 29 September.",
      "The cheapest hour was 06:00 UTC.",
    ]) {
      const r = checkNumbers(text, ctx);
      expect(r.ok, `${text} -> ${r.bad.join(", ")}`).toBe(true);
    }
  });

  it("rejects any other number", () => {
    expect(checkNumbers("Paid share reads 99.5%.", ctx).bad).toEqual(["99.5%"]);
    expect(checkNumbers("About 12M transactions a day.", ctx).bad).toEqual(["12M"]);
    expect(checkNumbers("The fee was $0.0105.", ctx).bad).toEqual(["$0.0105"]);
    expect(checkNumbers("At 07:00 UTC.", ctx).bad).toEqual(["07:00"]);
    expect(checkNumbers("6 swaps failed.", ctx).bad).toEqual(["6"]);
  });

  it("ignores addresses and hashes", () => {
    expect(checkNumbers("Wallet 0x8366a39cc670b4001a1121b8f6a443a643e40951 moved it.", ctx).ok).toBe(true);
  });
});

describe("adviceIssue", () => {
  it("catches advice, predictions and accusations", () => {
    expect(adviceIssue("You should buy this token.")).toMatch(/advice/);
    // "gas price" is a metric name, so a plain "price" is not banned; predictions are.
    expect(adviceIssue("We predict the fee will keep rising.")).toMatch(/advice/);
    expect(adviceIssue("The price target is $1.")).toMatch(/advice/);
    expect(adviceIssue("This wallet is a sybil farm.")).toMatch(/identity/);
    expect(adviceIssue("The operators are manipulating the pool.")).toMatch(/identity/);
  });

  it("leaves factual prose alone", () => {
    expect(adviceIssue("Swap fees were lowest at 06:00 UTC (n = 96 swaps).")).toBeNull();
    expect(adviceIssue("Sellers paid a median of $0.00926.")).toBeNull();
    expect(adviceIssue("The average gas price was 0.0204 Gwei.")).toBeNull();
  });
});
