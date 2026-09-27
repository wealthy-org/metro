import { createPublicClient, fallback, http } from "viem";
import { robinhood } from "viem/chains";
import { RPC_POOL } from "../../config/known-contracts.ts";

export function rpcUrls(): string[] {
  const fromEnv = process.env.RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
  return fromEnv && fromEnv.length > 0 ? fromEnv : [...RPC_POOL];
}

// viem retries each endpoint with exponential backoff, then falls through to the next one (PROJECT.md 9.4).
// Note: drpc's free plan rejects JSON-RPC batches above 3 calls, so it only helps as a late fallback.
export function createRpcClient(urls: string[] = rpcUrls()) {
  return createPublicClient({
    chain: robinhood,
    transport: fallback(urls.map((url) => http(url, { batch: true, retryCount: 3, retryDelay: 250, timeout: 10_000 }))),
  });
}

export type RpcClient = ReturnType<typeof createRpcClient>;
