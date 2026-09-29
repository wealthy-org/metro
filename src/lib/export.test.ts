import { describe, expect, it } from "vitest";
import { csvEscape, csvString, exportFileName, lensCsv } from "./export.ts";

// Export mapping (PROJECT.md 11.5; Phase 11 D4, AT 25): the CSV rows behind each lens match the API body it shows.

describe("csv building", () => {
  it("escapes commas, quotes and newlines, and writes a trailing newline", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("two\nlines")).toBe('"two\nlines"');
    expect(csvEscape(null)).toBe("");
    expect(csvString(["a", "b"], [[1, "x,y"]])).toBe('a,b\n1,"x,y"\n');
  });

  it("names files after the lens, the window and the scrubber time", () => {
    expect(exportFileName("city", "7d", "2026-09-28T14:00:02.000Z")).toBe("metro-city-7d-2026-09-28-14-00.csv");
    expect(exportFileName("split", "tokens", null)).toMatch(/^metro-split-tokens-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  });
});

describe("lens rows", () => {
  it("city: one row per building with the shown figures", () => {
    const t = lensCsv("city", { buildings: [{ kind: "action", key: "swap", label: "Swaps", tx_count: 3, gas_volume: 300, avg_fee_usd: 0.01, wallets: 2, fail_rate: 0 }] });
    expect(t?.header.slice(0, 4)).toEqual(["kind", "key", "label", "tx_count"]);
    expect(t?.rows).toEqual([["action", "swap", "Swaps", 3, 300, 0.01, 2, 0]]);
  });

  it("heatmap: one row per day and hour cell", () => {
    const t = lensCsv("heatmap", { days: ["2026-09-27", "2026-09-28"], cells: [[{ v: 1, n: 1, s: "ok" }, { v: null, n: 0, s: "no_data" }], [{ v: 2, n: 2, s: "ok" }]] });
    expect(t?.rows).toHaveLength(3);
    expect(t?.rows[0]).toEqual(["2026-09-27", 0, 1, 1, "ok"]);
    expect(t?.rows[2]).toEqual(["2026-09-28", 0, 2, 2, "ok"]);
  });

  it("split windows: before and after actions align by action key", () => {
    const t = lensCsv("split", {
      cmp: "windows",
      before: { actions: [{ key: "swap", tx: 10, tx_per_block: 1, share: 0.5, avg_fee_usd: 0.02, median_fee_usd: 0.01, paid_share: 1 }] },
      after: { actions: [{ key: "swap", tx: 4, tx_per_block: 0.4, share: 0.25, avg_fee_usd: 0.04, median_fee_usd: 0.03, paid_share: 0.9 }] },
    });
    expect(t?.rows).toEqual([["swap", 10, 4, 1, 0.4, 0.5, 0.25, 0.02, 0.04, 0.01, 0.03, 1, 0.9]]);
  });

  it("split tokens: one row per side", () => {
    const side = { address: "0xaa", symbol: "AAA", tx: 2, swaps: 1, senders: 2, avg_fee_usd: 0.01, median_fee_usd: 0.01, holders: 3, top10_share: 0.5, pool_share: 0.1, volume_24h_usd: 100 };
    const t = lensCsv("split", { cmp: "tokens", a: side, b: null });
    expect(t?.rows[0]?.slice(0, 4)).toEqual(["a", "AAA", 2, 1]);
    expect(t?.rows[1]?.slice(0, 4)).toEqual(["b", undefined, undefined, undefined]);
  });

  it("flow and launchpad pass their table fields through", () => {
    const flow = lensCsv("flow", { rows: [{ hash: "0x1", block: 2, ts: "t", from: "a", to: "b", action: "swap", fee_usd: 0.01, value_eth: 1, status: "success" }] });
    expect(flow?.rows[0]).toEqual(["0x1", 2, "t", "a", "b", "swap", 0.01, 1, "success"]);
    const lp = lensCsv("launchpad", { tokens: [{ address: "0xt", source: "ingested", symbol: "P", name: "Pons", launch_ts: "t", creator: "c", tx_count: 1, swaps: 1, avg_fee_usd: 0.01, holders: { holders: 5, top10_share: 0.5, pool_share: 0.1 }, market: { volume_24h_usd: 10 }, concentrated: true }] });
    expect(lp?.rows[0]?.slice(0, 3)).toEqual(["0xt", "ingested", "P"]);
    expect(lp?.rows[0]?.[9]).toBe(5);
  });

  it("graph: one row per node", () => {
    const t = lensCsv("graph", { nodes: [{ id: "0xn", label: "PONS", kind: "contract", transfers: 4, tx_sent: 2, avg_fee_usd: 0.02, gas_volume: 400, fail_rate: 0.5, cluster: "0xf" }] });
    expect(t?.rows).toEqual([["0xn", "PONS", "contract", 4, 2, 0.02, 400, 0.5, "0xf"]]);
  });

  it("returns null for an unknown lens or an empty body", () => {
    expect(lensCsv("nope", {})).toBeNull();
    expect(lensCsv("city", null)).toBeNull();
  });
});
