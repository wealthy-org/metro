import { createRpcClient, type RpcClient } from "../collector/rpc.ts";

// One viem client for reads in the web tier (token metadata and supply, address data, transactions that are not
// ingested; Phase 6 D4, D5). Same pool, rate limits and failover as the Collector (PROJECT.md 9.4).
let client: RpcClient | null = null;
export const readClient = (): RpcClient => (client ??= createRpcClient());

// Small time-boxed memo for RPC answers that change slowly (metadata, supply). Failures are not kept.
const memo = new Map<string, { value: unknown; at: number }>();
const MAX_MEMO = 1_000;

export async function memoized<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value as string);
  memo.set(key, { value, at: Date.now() });
  return value;
}
