import { describe, expect, it } from "vitest";
import { isFactPrefix, parseInsightQuery } from "./insights.ts";

// Input validation of /api/v1/insights and /api/v1/facts (PROJECT.md 16; gate F52).
const q = (s: string) => new URLSearchParams(s);

describe("parseInsightQuery", () => {
  it("accepts the known rule, status and severity values and nothing else", () => {
    expect(parseInsightQuery(q(""))).toEqual({ rule: null, status: null, severity: null });
    expect(parseInsightQuery(q("rule=gas_spike&status=finding&severity=attention"))).toEqual({ rule: "gas_spike", status: "finding", severity: "attention" });
    expect(parseInsightQuery(q("rule=nope"))).toMatch(/^rule must be one of/);
    expect(parseInsightQuery(q("status=active"))).toBe("status must be finding or not_enough_data");
    expect(parseInsightQuery(q("severity=high"))).toBe("severity must be info or attention");
  });
});

describe("isFactPrefix", () => {
  it("allows key characters only, so LIKE wildcards and quotes never reach SQL", () => {
    expect(isFactPrefix("")).toBe(true);
    expect(isFactPrefix("median_fee_usd.swap")).toBe(true);
    expect(isFactPrefix("a%")).toBe(false);
    expect(isFactPrefix("a'; drop")).toBe(false);
    expect(isFactPrefix("A")).toBe(false);
    expect(isFactPrefix("x".repeat(129))).toBe(false);
  });
});
