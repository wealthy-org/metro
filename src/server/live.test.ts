import { describe, expect, it } from "vitest";
import type { BlockBundle } from "../collector/ingest.ts";
import { NO_FILTERS } from "../lib/view-state.ts";
import { filterRows, rowsOf, tpsOf } from "./live.ts";

// Live Flow rows built from the Collector's block bundles (Phase 6 D3, KL-23). No network.

const ts = (s: number) => new Date(Date.UTC(2026, 8, 28, 5, 0, s));

function bundle(n: number, sec: number, txs: { hash: string; action: string; fee: string; value?: string; status?: number; subsidy?: string }[], transfers: { tx: string; token: string }[] = []): BlockBundle {
  return {
    block: { number: n, hash: `0x${n}`, ts: ts(sec), gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: txs.length },
    txs: txs.map((t) => ({
      hash: t.hash,
      block: n,
      ts: ts(sec),
      fromAddress: "0xa",
      toAddress: "0xb",
      value: t.value ?? "0",
      gasUsed: "1",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: t.fee,
      status: t.status ?? 1,
      method: null,
      action: t.action as never,
      subsidyClass: (t.subsidy ?? "likely_paid") as never,
    })),
    transfers: transfers.map((x, i) => ({ txHash: x.tx, logIndex: i, tokenAddress: x.token, fromAddress: "0xa", toAddress: "0xb", amount: "1", ts: ts(sec) })),
    tokens: [],
    launches: [],
  };
}

const bundles = [
  bundle(100, 0, [{ hash: "0x1", action: "swap", fee: "0.02", value: "2000000000000000000" }], [{ tx: "0x1", token: "0xt1" }, { tx: "0x1", token: "0xt2" }, { tx: "0x1", token: "0xt1" }]),
  bundle(101, 1, [
    { hash: "0x2", action: "approve", fee: "0.01", status: 0 },
    { hash: "0x3", action: "native_transfer", fee: "0.005", value: "500000000000000000", subsidy: "unknown" },
  ]),
];

describe("live Flow rows", () => {
  it("builds one row per transaction, newest block first, with the tokens it moved once each", () => {
    const r = rowsOf(bundles);
    expect(r.map((x) => x.hash)).toEqual(["0x2", "0x3", "0x1"]);
    expect(r.find((x) => x.hash === "0x1")).toMatchObject({ action: "swap", tokens: ["0xt1", "0xt2"], fee_usd: 0.02, value_eth: 2, status: "success" });
    expect(r.find((x) => x.hash === "0x2")?.status).toBe("failed");
  });

  it("measures TPS over the block timestamps, at least one second", () => {
    expect(tpsOf(bundles)).toBeCloseTo(3 / 2, 10);
    expect(tpsOf([bundles[0] as BlockBundle])).toBe(1);
    expect(tpsOf([])).toBeNull();
  });

  it("applies the view filters like the SQL of filters.ts", () => {
    const r = rowsOf(bundles);
    expect(filterRows(r, { ...NO_FILTERS, action: "swap" }).map((x) => x.hash)).toEqual(["0x1"]);
    expect(filterRows(r, { ...NO_FILTERS, token: "0xt2" }).map((x) => x.hash)).toEqual(["0x1"]);
    expect(filterRows(r, { ...NO_FILTERS, minValue: "0.5" }).map((x) => x.hash)).toEqual(["0x3", "0x1"]);
    expect(filterRows(r, { ...NO_FILTERS, status: "failed" }).map((x) => x.hash)).toEqual(["0x2"]);
    expect(filterRows(r, { ...NO_FILTERS, wallet: "unknown" }).map((x) => x.hash)).toEqual(["0x3"]);
  });
});
