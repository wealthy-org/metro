import { erc20Abi, type Hex } from "viem";
import { PONS_FACTORY, TOPIC_TOKEN_LAUNCHED } from "../../config/known-contracts.ts";
import { log } from "../collector/log.ts";
import { readClient } from "./rpc-read.ts";

// Newest Pons launches read from the factory's TokenLaunched logs over RPC (KL-24, user decision 2026-09-28): while
// the Collector runs only in bounded batches (KL-1), pons_launches holds a few tokens while the chain has hundreds a
// day. Live Launchpad views add these launches for display only; nothing is written, and their holders and activity
// stay unknown until their blocks are ingested. Same source as PROJECT.md 8.1 (factory event), read like ADR-005.

const CHUNK = 10_000n;
const MAX_CHUNKS = 5;
const TTL_MS = 60_000;

export type RecentLaunch = { address: string; pool: string | null; creator: string; block: number; ts: string; symbol: string | null; name: string | null };

const topicAddress = (t: string | undefined) => (t && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);

async function load(limit: number): Promise<RecentLaunch[]> {
  const c = readClient();
  const head = await c.getBlockNumber();
  type Raw = { token: string; pool: string | null; creator: string; block: bigint; ts: number | null; index: number };
  const raw: Raw[] = [];
  for (let i = 0; i < MAX_CHUNKS && raw.length < limit; i++) {
    const to = head - BigInt(i) * CHUNK;
    if (to < 0n) break;
    const from = to - CHUNK + 1n > 0n ? to - CHUNK + 1n : 0n;
    const logs = await c.request({
      method: "eth_getLogs",
      params: [{ address: PONS_FACTORY as Hex, topics: [TOPIC_TOKEN_LAUNCHED as Hex], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    });
    const chunk: Raw[] = [];
    for (const l of logs) {
      const token = topicAddress(l.topics[1]);
      const creator = topicAddress(l.topics[3]);
      if (!token || !creator) continue;
      // Most endpoints add the block time to each log; one answers 0x0, so those blocks are read below.
      const bt = (l as { blockTimestamp?: string }).blockTimestamp;
      const ts = bt && BigInt(bt) > 0n ? Number(BigInt(bt)) * 1000 : null;
      chunk.push({ token, pool: topicAddress(l.topics[2]), creator, block: BigInt(l.blockNumber ?? "0x0"), ts, index: Number(l.logIndex ?? "0x0") });
    }
    raw.push(...chunk.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1)));
  }
  const picked = raw.slice(0, limit);
  const missing = [...new Set(picked.filter((r) => r.ts === null).map((r) => r.block))];
  const times = new Map<bigint, number>();
  await Promise.all(missing.map(async (b) => times.set(b, Number((await c.getBlock({ blockNumber: b })).timestamp) * 1000)));
  const meta = picked.length
    ? await c.multicall({
        allowFailure: true,
        contracts: picked.flatMap((r) => [
          { address: r.token as Hex, abi: erc20Abi, functionName: "symbol" } as const,
          { address: r.token as Hex, abi: erc20Abi, functionName: "name" } as const,
        ]),
      })
    : [];
  return picked.map((r, i) => {
    const s = meta[i * 2];
    const n = meta[i * 2 + 1];
    return {
      address: r.token,
      pool: r.pool,
      creator: r.creator,
      block: Number(r.block),
      ts: new Date(r.ts ?? times.get(r.block) ?? 0).toISOString(),
      symbol: s?.status === "success" ? String(s.result).slice(0, 32) : null,
      name: n?.status === "success" ? String(n.result).slice(0, 128) : null,
    };
  });
}

let cache: { value: RecentLaunch[]; at: number; limit: number } | null = null;
let inflight: Promise<RecentLaunch[]> | null = null;

// The newest `limit` launches (at most 50,000 blocks back), shared for 60 s. Returns null when RPC cannot be read,
// so the Launchpad falls back to the ingested launches and says so.
export async function recentLaunches(limit: number): Promise<RecentLaunch[] | null> {
  if (cache && cache.limit >= limit && Date.now() - cache.at < TTL_MS) return cache.value.slice(0, limit);
  inflight ??= load(limit)
    .then((value) => {
      cache = { value, at: Date.now(), limit };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return (await inflight).slice(0, limit);
  } catch (err) {
    log("warn", "recent pons launches read failed", { source: "rpc", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return cache ? cache.value.slice(0, limit) : null;
  }
}
