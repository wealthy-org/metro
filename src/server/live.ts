import { formatFixed } from "../collector/fees.ts";
import type { BlockBundle } from "../collector/ingest.ts";
import { fetchBlockBundle } from "../collector/ingest.ts";
import { log } from "../collector/log.ts";
import { DEFAULT_SOURCE, fetchCurrent, type PriceSource } from "../collector/price.ts";
import { RpcPool } from "../collector/rpc.ts";
import type { FlowRowT } from "../lib/api-types.ts";
import { ethToWei, WALLET_CLASSES, type Filters } from "../lib/view-state.ts";

// Live read of the newest blocks from RPC in the web tier (Phase 6 D3, KL-23): Flow particles and City vehicles.
// The Collector's own block fetcher and classifier are reused; nothing is written to the database. One read covers
// the newest LIVE_BLOCKS blocks and is shared by every viewer for LIVE_TTL_MS.

const LIVE_BLOCKS = 10;
const LIVE_TTL_MS = 2_000;
const PRICE_TTL_MS = 60_000;

export type FlowRow = FlowRowT;

export type LiveRead = { first_block: number; last_block: number; first_ts: string; last_ts: string; tps: number | null; rows: FlowRow[]; fetched_at: string };

let pool: RpcPool | null = null;
let price: { value: string; at: number } | null = null;
let read: { value: LiveRead; at: number } | null = null;
let inflight: Promise<LiveRead> | null = null;

// Current ETH price for live fees. A failed refresh keeps the previous quote; with no quote at all the read fails
// rather than showing a fee of $0.
const livePrice: PriceSource = {
  async priceAt() {
    if (price && Date.now() - price.at < PRICE_TTL_MS) return price.value;
    try {
      const value = await fetchCurrent(process.env.ETH_PRICE_SOURCE_URL || DEFAULT_SOURCE);
      price = { value, at: Date.now() };
      return value;
    } catch (err) {
      if (price) return price.value;
      throw err;
    }
  },
};

// The same cached quote for other live reads (/tx of a transaction that is not ingested), so their USD fees match Flow.
export const currentEthUsd = () => livePrice.priceAt(new Date());

export function rowsOf(bundles: BlockBundle[]): FlowRow[] {
  const moved = new Map<string, Set<string>>();
  for (const b of bundles) {
    for (const t of b.transfers) {
      const set = moved.get(t.txHash) ?? new Set<string>();
      set.add(t.tokenAddress);
      moved.set(t.txHash, set);
    }
  }
  return bundles
    .flatMap((b) =>
      b.txs.map((t) => ({
        hash: t.hash,
        block: t.block,
        ts: t.ts.toISOString(),
        from: t.fromAddress,
        to: t.toAddress ?? null,
        action: t.action,
        tokens: [...(moved.get(t.hash) ?? [])],
        fee_usd: Number(t.feeUsd),
        value_wei: String(t.value ?? "0"),
        value_eth: Number(formatFixed(BigInt(String(t.value ?? "0")), 18)),
        status: (t.status === 1 ? "success" : "failed") as FlowRow["status"],
        subsidy_class: String(t.subsidyClass),
      })),
    )
    .sort((a, b) => (a.block === b.block ? a.hash.localeCompare(b.hash) : b.block - a.block));
}

// Transactions per second over the read blocks, from their timestamps (whole seconds on this chain, so at least 1 s).
export function tpsOf(bundles: BlockBundle[]): number | null {
  if (!bundles.length) return null;
  const times = bundles.map((b) => b.block.ts.getTime());
  const span = Math.max(1_000, Math.max(...times) - Math.min(...times) + 1_000);
  return (bundles.reduce((s, b) => s + b.txs.length, 0) / span) * 1000;
}

async function load(): Promise<LiveRead> {
  pool ??= new RpcPool();
  const head = await pool.head.getBlockNumber();
  const numbers = Array.from({ length: LIVE_BLOCKS }, (_, i) => head - BigInt(i));
  const bundles = await Promise.all(numbers.map((n) => fetchBlockBundle(pool!.forBlock(n), livePrice, n)));
  const blocks = bundles.map((b) => b.block);
  const first = blocks.reduce((a, b) => (a.number < b.number ? a : b));
  const last = blocks.reduce((a, b) => (a.number > b.number ? a : b));
  return {
    first_block: first.number,
    last_block: last.number,
    first_ts: first.ts.toISOString(),
    last_ts: last.ts.toISOString(),
    tps: tpsOf(bundles),
    rows: rowsOf(bundles),
    fetched_at: new Date().toISOString(),
  };
}

// Fresh reads are shared for LIVE_TTL_MS. A read up to STALE_MS old is still answered at once while a new one loads
// in the background, so viewers do not wait for the ~3 s RPC round trip on every poll.
const STALE_MS = 10_000;

function refresh(): Promise<LiveRead> {
  inflight ??= load()
    .then((value) => {
      read = { value, at: Date.now() };
      return value;
    })
    .catch((err: unknown) => {
      log("warn", "live rpc read failed", { source: "rpc", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function liveRead(): Promise<LiveRead> {
  const age = read ? Date.now() - read.at : Infinity;
  if (read && age < LIVE_TTL_MS) return read.value;
  if (read && age < STALE_MS) {
    refresh().catch(() => {});
    return read.value;
  }
  return refresh();
}

// The view filters (PROJECT.md 11.2) applied to live rows, matching the SQL of src/server/filters.ts.
export function filterRows(rows: FlowRow[], f: Filters): FlowRow[] {
  const minWei = f.minValue ? BigInt(ethToWei(f.minValue)) : null;
  const subsidy = f.wallet ? WALLET_CLASSES.find((w) => w.key === f.wallet)?.subsidy : null;
  return rows.filter(
    (r) =>
      (!f.action || r.action === f.action) &&
      (!f.token || r.tokens.includes(f.token)) &&
      (minWei === null || BigInt(r.value_wei) >= minWei) &&
      (!subsidy || r.subsidy_class === subsidy) &&
      (!f.status || r.status === f.status),
  );
}
