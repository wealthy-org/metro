// CSV building shared by the dataset export route and the per-lens export buttons (PROJECT.md 11.5, 16; Phase 11 D4).
// Client-safe: only string work, no imports from the server.

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvString(header: readonly string[], rows: readonly unknown[][]): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\n") + "\n";
}

export type LensCsv = { header: string[]; rows: unknown[][] };

const col = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
const arr = (o: unknown, k: string): unknown[] => {
  const v = col(o, k);
  return Array.isArray(v) ? v : [];
};

export function exportFileName(lens: string, window: string, at: string | null): string {
  const stamp = (at ?? new Date().toISOString()).slice(0, 16).replace(/[:T]/g, "-");
  return `metro-${lens}-${window}-${stamp}.csv`;
}

// The rows behind what the lens shows, per lens, matching the API bodies of api.md 2.0a (AT 25).
export function lensCsv(lens: string, data: unknown): LensCsv | null {
  if (!data) return null;
  switch (lens) {
    case "city":
      return {
        header: ["kind", "key", "label", "tx_count", "gas_volume", "avg_fee_usd", "wallets", "fail_rate"],
        rows: arr(data, "buildings").map((b) => [col(b, "kind"), col(b, "key"), col(b, "label"), col(b, "tx_count"), col(b, "gas_volume"), col(b, "avg_fee_usd"), col(b, "wallets"), col(b, "fail_rate")]),
      };
    case "terrain": {
      const buckets = arr(data, "buckets");
      return {
        header: ["kind", "key", "label", ...buckets.map((x) => String(x))],
        rows: arr(data, "rows").map((r) => [col(r, "kind"), col(r, "key"), col(r, "label"), ...arr(r, "values")]),
      };
    }
    case "heatmap": {
      const days = arr(data, "days");
      const cells = arr(data, "cells");
      return {
        header: ["day", "hour", "value", "n", "state"],
        rows: days.flatMap((d, di) => {
          const day = cells[di];
          return Array.isArray(day) ? (day as unknown[]).map((c, h) => [d, h, col(c, "v"), col(c, "n"), col(c, "s")]) : [];
        }),
      };
    }
    case "flow":
      return {
        header: ["hash", "block", "ts", "from", "to", "action", "fee_usd", "value_eth", "status"],
        rows: arr(data, "rows").map((r) => [col(r, "hash"), col(r, "block"), col(r, "ts"), col(r, "from"), col(r, "to"), col(r, "action"), col(r, "fee_usd"), col(r, "value_eth"), col(r, "status")]),
      };
    case "launchpad":
      return {
        header: ["address", "source", "symbol", "name", "launch_ts", "creator", "tx_count", "swaps", "avg_fee_usd", "holders", "top10_share", "pool_share", "volume_24h_usd", "concentrated"],
        rows: arr(data, "tokens").map((t) => {
          const h = col(t, "holders");
          const m = col(t, "market");
          return [col(t, "address"), col(t, "source"), col(t, "symbol"), col(t, "name"), col(t, "launch_ts"), col(t, "creator"), col(t, "tx_count"), col(t, "swaps"), col(t, "avg_fee_usd"), col(h, "holders"), col(h, "top10_share"), col(h, "pool_share"), col(m, "volume_24h_usd"), col(t, "concentrated")];
        }),
      };
    case "graph":
      return {
        header: ["address", "label", "kind", "transfers", "tx_sent", "avg_fee_usd", "gas_volume", "fail_rate", "cluster"],
        rows: arr(data, "nodes").map((n) => [col(n, "id"), col(n, "label"), col(n, "kind"), col(n, "transfers"), col(n, "tx_sent"), col(n, "avg_fee_usd"), col(n, "gas_volume"), col(n, "fail_rate"), col(n, "cluster")]),
      };
    case "split": {
      if (col(data, "cmp") === "tokens") {
        const side = (t: unknown) => [col(t, "symbol") ?? col(t, "address"), col(t, "tx"), col(t, "swaps"), col(t, "senders"), col(t, "avg_fee_usd"), col(t, "median_fee_usd"), col(t, "holders"), col(t, "top10_share"), col(t, "pool_share"), col(t, "volume_24h_usd")];
        const a = col(data, "a");
        const b = col(data, "b");
        const labels = ["token", "transactions", "swaps", "senders", "avg_fee_usd", "median_fee_usd", "holders", "top10_share", "pool_share", "volume_24h_usd"];
        return { header: ["side", ...labels], rows: [["a", ...side(a)], ["b", ...side(b)]] };
      }
      const before = arr(col(data, "before"), "actions");
      const after = arr(col(data, "after"), "actions");
      const byKey = new Map(after.map((a) => [String(col(a, "key")), a]));
      return {
        header: ["action", "tx_before", "tx_after", "tx_per_block_before", "tx_per_block_after", "share_before", "share_after", "avg_fee_before", "avg_fee_after", "median_fee_before", "median_fee_after", "paid_share_before", "paid_share_after"],
        rows: before.map((b) => {
          const a = byKey.get(String(col(b, "key")));
          return [col(b, "key"), col(b, "tx"), col(a, "tx"), col(b, "tx_per_block"), col(a, "tx_per_block"), col(b, "share"), col(a, "share"), col(b, "avg_fee_usd"), col(a, "avg_fee_usd"), col(b, "median_fee_usd"), col(a, "median_fee_usd"), col(b, "paid_share"), col(a, "paid_share")];
        }),
      };
    }
    default:
      return null;
  }
}
