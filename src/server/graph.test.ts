import { describe, expect, it } from "vitest";
import { clusterLabel, GRAPH_NODE_CAP } from "../lib/graph.ts";
import { GRAPH_WINDOW_REASON } from "../lib/view-state.ts";
import { parseGraphParams, trimGraph } from "./graph.ts";

const q = (s: string) => new URLSearchParams(s);
const e = (s: string, t: string, n: number) => ({ s, t, n, wei: 0, tokens: [] });

describe("graph trimming (PROJECT.md 10.4, AT 13)", () => {
  // C shares transfers with A (3) and B (1); D and E move a lot between themselves and do not touch C.
  const edges = [e("C", "A", 3), e("B", "C", 1), e("D", "E", 10)];

  it("keeps the center first, then its neighbours by shared transfers, and drops edges with a trimmed end", () => {
    const t = trimGraph(edges, "C", 3);
    expect(t.ids).toEqual(["C", "A", "B"]);
    expect(t.kept.map((x) => `${x.s}${x.t}`)).toEqual(["CA", "BC"]);
    expect(t.degree.size).toBe(5);
  });

  it("without a center keeps the busiest nodes; ties break by address so the result is stable", () => {
    const t = trimGraph(edges, null, 2);
    expect(t.ids).toEqual(["D", "E"]);
    expect(t.kept).toEqual([edges[2]]);
    expect(trimGraph(edges, null, 2).ids).toEqual(t.ids);
  });

  it("trims nothing below the cap", () => {
    const t = trimGraph(edges, null, GRAPH_NODE_CAP);
    expect(t.ids).toHaveLength(5);
    expect(t.kept).toHaveLength(3);
  });
});

describe("cluster label (Phase 9 D1, PROJECT.md 24.8)", () => {
  it("states the pattern, never an identity", () => {
    const funder = "0xd8588cd2afa0605ddd1918b3908e3c378cff3351";
    expect(clusterLabel({ funder, size: 17 })).toBe("Funded by 0xd858…3351 in this window (17 wallets)");
    expect(clusterLabel({ funder, size: 1 })).toBe("Funded by 0xd858…3351 in this window (1 wallet)");
    expect(clusterLabel({ funder, size: 4 }, "in these transfers")).not.toMatch(/sybil|bot|fraud|scam|whale|insider/i);
  });
});

describe("graph query parameters", () => {
  const A = "0x00000000000000000000000000000000000000a1";

  it("defaults to top clusters over 24 h", () => {
    expect(parseGraphParams(q(""))).toMatchObject({ window: "24h", mode: "top", addr: null, token: null, hops: 1 });
  });

  it("covers windows of 24 h or less only (D2)", () => {
    expect(parseGraphParams(q("window=1h"))).toMatchObject({ window: "1h" });
    expect(parseGraphParams(q("window=7d"))).toBe(GRAPH_WINDOW_REASON);
    expect(parseGraphParams(q("window=all"))).toBe(GRAPH_WINDOW_REASON);
  });

  it("validates mode, addresses, hops and cap", () => {
    expect(parseGraphParams(q("mode=ego"))).toMatch(/needs addr/);
    expect(parseGraphParams(q(`mode=ego&addr=${A.toUpperCase().replace("0X", "0x")}&hops=2`))).toMatchObject({ mode: "ego", addr: A, hops: 2 });
    expect(parseGraphParams(q("mode=token"))).toMatch(/needs gtoken/);
    expect(parseGraphParams(q(`mode=token&gtoken=${A}`))).toMatchObject({ mode: "token", token: A });
    expect(parseGraphParams(q("mode=sybil"))).toMatch(/mode must be/);
    expect(parseGraphParams(q("addr=0x1"))).toMatch(/addr must be/);
    expect(parseGraphParams(q("hops=3"))).toMatch(/hops must be/);
    expect(parseGraphParams(q("cap=60"))).toMatchObject({ cap: 60 });
    expect(parseGraphParams(q("cap=0"))).toMatch(/cap must be/);
    expect(parseGraphParams(q("cap=1501"))).toMatch(/cap must be/);
    expect(parseGraphParams(q("cap=1.5"))).toMatch(/cap must be/);
  });
});
