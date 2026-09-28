import { describe, expect, it } from "vitest";
import { dataQuery, DEFAULT_VIEW, ethToWei, metricIssue, NO_FILTERS, normalize, parseIsoMinute, parseViewState, serializeViewState, type ViewState } from "./view-state.ts";

const q = (s: string) => new URLSearchParams(s);

describe("view state in the URL (PROJECT.md 11.2, AT 9)", () => {
  it("round-trips a full view to the same URL", () => {
    const s: ViewState = {
      lens: "terrain",
      metric: "avg_fee_usd",
      window: "1h",
      filters: { action: "swap", token: "0x00000000000000000000000000000000000000a1", minValue: "0.5", wallet: "other", status: "failed" },
      sel: { kind: "action", key: "swap" },
      at: "2026-09-27T15:12Z",
      cam: "top",
      marks: ["2026-09-27T14:00Z", "2026-09-27T15:00Z"],
      rows: "tokens",
      mode: "compare",
      split: { cmp: "tokens", before: "2026-09-22..2026-09-28", after: "2026-09-29..2026-10-05", ta: "0x00000000000000000000000000000000000000a1", tb: "0x00000000000000000000000000000000000000b2" },
    };
    const url = serializeViewState(s).toString();
    expect(parseViewState(q(url))).toEqual(s);
    expect(serializeViewState(parseViewState(q(url))).toString()).toBe(url);
  });

  it("writes nothing for the default view and drops invalid values", () => {
    expect(serializeViewState(DEFAULT_VIEW).toString()).toBe("");
    const s = parseViewState(q("lens=graph&metric=x&window=2d&action=other&token=0x1&min_value=-1&wallet=x&status=x&sel=action:other&at=yesterday&cam=x&marks=bad"));
    expect(s).toEqual(DEFAULT_VIEW);
  });

  it("keeps only valid, unique, sorted marks up to five", () => {
    const marks = "2026-09-27T15:00Z,2026-09-27T14:00Z,2026-09-27T15:00Z,2026-02-30T10:00Z,2026-09-27T16:00Z,2026-09-27T17:00Z,2026-09-27T18:00Z,2026-09-27T19:00Z";
    expect(parseViewState(q(`marks=${marks}`)).marks).toEqual(["2026-09-27T14:00Z", "2026-09-27T15:00Z", "2026-09-27T16:00Z", "2026-09-27T17:00Z", "2026-09-27T18:00Z"]);
  });

  it("drops what the lens and window cannot show (KL-17, KL-20)", () => {
    const s = normalize({ ...DEFAULT_VIEW, window: "7d", metric: "wallets", rows: "tokens", filters: { ...NO_FILTERS, action: "swap", status: "failed" } });
    expect(s.metric).toBe("tx_count");
    expect(s.rows).toBe("actions");
    expect(s.filters).toEqual({ ...NO_FILTERS, action: "swap" });
    expect(normalize({ ...DEFAULT_VIEW, lens: "heatmap", metric: "fail_rate" }).metric).toBe("tx_count");
    expect(normalize({ ...DEFAULT_VIEW, lens: "heatmap", metric: "gas_price" }).metric).toBe("gas_price");
    expect(normalize({ ...DEFAULT_VIEW, lens: "city", metric: "gas_price" }).metric).toBe("tx_count");
  });

  it("states why a metric is unavailable", () => {
    expect(metricIssue("terrain", "fail_rate", "7d")).toMatch(/24 h or less/);
    expect(metricIssue("city", "fail_rate", "7d")).toBeNull();
    expect(metricIssue("heatmap", "wallets", "24h")).toMatch(/hour cell/);
  });

  it("knows the Phase 6 lenses; they have no metric choice to reject", () => {
    expect(parseViewState(q("lens=flow")).lens).toBe("flow");
    expect(parseViewState(q("lens=launchpad&window=7d&sel=token:0x00000000000000000000000000000000000000a1")).sel).toEqual({ kind: "token", key: "0x00000000000000000000000000000000000000a1" });
    expect(metricIssue("flow", "fail_rate", "30d")).toBeNull();
    expect(metricIssue("launchpad", "gas_price", "all")).toBeNull();
  });

  it("keeps raw filters in Flow at any window and asks its API for 1h (gate F31)", () => {
    const s = normalize({ ...DEFAULT_VIEW, lens: "flow", window: "7d", filters: { ...NO_FILTERS, status: "failed" } });
    expect(s.filters.status).toBe("failed");
    expect(dataQuery(s)).toBe("window=1h&status=failed");
    expect(normalize({ ...s, lens: "city" }).filters.status).toBeNull();
  });
});

describe("parsing helpers", () => {
  it("accepts only real UTC minutes", () => {
    expect(parseIsoMinute("2026-09-27T15:51Z")).toBe("2026-09-27T15:51Z");
    expect(parseIsoMinute("2026-09-31T10:00Z")).toBeNull();
    expect(parseIsoMinute("2026-09-27T24:00Z")).toBeNull();
    expect(parseIsoMinute("2026-09-27T15:51:00Z")).toBeNull();
  });

  it("converts decimal ETH to exact wei", () => {
    expect(ethToWei("1")).toBe("1000000000000000000");
    expect(ethToWei("0.000000000000000001")).toBe("1");
    expect(ethToWei("123456789.5")).toBe("123456789500000000000000000");
  });
});
