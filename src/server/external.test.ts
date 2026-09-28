import { describe, expect, it } from "vitest";
import { BlockscoutError, BlockscoutUnavailable } from "../collector/blockscout.ts";
import { blockscoutReason, parseFeeSummary, parseTvl } from "./external.ts";

describe("Blockscout reason in the chain stats readout (PROJECT.md 19)", () => {
  it("passes the client's own fixed messages through and keeps anything else generic", () => {
    expect(blockscoutReason(new BlockscoutUnavailable("Blockscout blocked the request (HTTP 403)", 0, null))).toBe("Blockscout blocked the request (HTTP 403)");
    expect(blockscoutReason(new BlockscoutUnavailable("Blockscout unreachable: TimeoutError", 0, null))).toBe("Blockscout unreachable: TimeoutError");
    expect(blockscoutReason(new BlockscoutError("Blockscout answer for /stats has an unexpected shape"))).toBe("Blockscout answer for /stats has an unexpected shape");
    expect(blockscoutReason(new Error("connect ECONNREFUSED 10.0.0.1:5432 password=x"))).toBe("Blockscout explorer not reachable from the server");
  });
});

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
