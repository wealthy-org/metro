import { describe, expect, it } from "vitest";
import { parseFeeSummary, parseTvl } from "./external.ts";

describe("DefiLlama parsers (PROJECT.md 8.1)", () => {
  it("reads Robinhood Chain TVL from /v2/chains", () => {
    const chains = [
      { name: "Ethereum", tvl: 1 },
      { name: "Robinhood Chain", chainId: 4663, tvl: 1031123532.59 },
    ];
    expect(parseTvl(chains)).toBe(1031123532.59);
    expect(parseTvl([{ name: "Ethereum", tvl: 1 }])).toBeNull();
    expect(parseTvl({ not: "an array" })).toBeNull();
  });

  it("reads total24h and the day of the newest chart point from /summary/fees", () => {
    const body = { total24h: 91274, totalDataChart: [[1790294400, 140669], [1790380800, 91274]] };
    expect(parseFeeSummary(body)).toEqual({ total: 91274, day: "2026-09-26" });
    expect(parseFeeSummary({})).toEqual({ total: null, day: null });
  });
});
