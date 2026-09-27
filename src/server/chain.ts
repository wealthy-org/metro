import { rpcUrls } from "../collector/rpc.ts";
import { limitedFetch } from "../collector/rate-limiter.ts";

type RpcResult = { result: string; rpc: string };
type Entry = { value: RpcResult; at: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<RpcResult | null>>();

async function callPool(method: string): Promise<RpcResult | null> {
  for (const url of rpcUrls()) {
    try {
      const res = await limitedFetch(url, 5)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      const body: unknown = await res.json();
      const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
      if (res.ok && typeof result === "string") return { result, rpc: url };
    } catch {
      // Try the next endpoint in the pool.
    }
  }
  return null;
}

// Parameterless JSON-RPC call against the pool, cached for `ttlMs`. Concurrent callers share one request,
// and failures are not cached.
async function cachedRpc(method: string, ttlMs: number, now = Date.now()): Promise<RpcResult | null> {
  const hit = cache.get(method);
  if (hit && now - hit.at < ttlMs) return hit.value;
  let pending = inflight.get(method);
  if (!pending) {
    pending = callPool(method).finally(() => inflight.delete(method));
    inflight.set(method, pending);
  }
  const value = await pending;
  if (value) cache.set(method, { value, at: Date.now() });
  return value;
}

// The chain produces ~10 blocks per second; a 5 s old head only shifts the reported lag by ~50 blocks,
// and it saves one RPC round trip on every Ticker poll.
export async function chainHead(): Promise<{ head: number; rpc: string } | null> {
  const r = await cachedRpc("eth_blockNumber", 5_000);
  return r ? { head: Number(r.result), rpc: r.rpc } : null;
}

// PROJECT.md 8.1: gas price from eth_gasPrice, refreshed every minute.
export async function gasPriceWei(): Promise<{ wei: bigint; rpc: string } | null> {
  const r = await cachedRpc("eth_gasPrice", 60_000);
  return r ? { wei: BigInt(r.result), rpc: r.rpc } : null;
}
