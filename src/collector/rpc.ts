import { createPublicClient, fallback, http } from "viem";
import { robinhood } from "viem/chains";
import { RPC_POOL, type RpcEndpoint } from "../../config/known-contracts.ts";
import { limitedFetch } from "./rate-limiter.ts";

// Requests per second per endpoint (one HTTP call, batched or not, takes one token). Not an env setting: PROJECT.md 23
// lists no such variable (audit A7).
const RATE_PER_ENDPOINT = 10;
// Batches above ~50 calls come back incomplete on rpc.mainnet.chain.robinhood.com (2026-09-27); 10 is safe everywhere.
const BATCH_SIZE = 10;

export function rpcEndpoints(): RpcEndpoint[] {
  const fromEnv = process.env.RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
  if (!fromEnv || fromEnv.length === 0) return [...RPC_POOL];
  // Unknown URLs get the conservative settings: no batching, but eligible as primary.
  return fromEnv.map((url) => RPC_POOL.find((e) => e.url === url) ?? { url, batch: false, primary: true });
}

export const rpcUrls = () => rpcEndpoints().map((e) => e.url);

function transportFor(endpoint: RpcEndpoint) {
  return http(endpoint.url, {
    batch: endpoint.batch ? { batchSize: BATCH_SIZE } : false,
    retryCount: 3,
    retryDelay: 250,
    timeout: 10_000,
    fetchFn: limitedFetch(endpoint.url, RATE_PER_ENDPOINT),
  });
}

// viem retries each endpoint with exponential backoff, then falls through to the next one (PROJECT.md 9.4).
export function createRpcClient(endpoints: RpcEndpoint[] = rpcEndpoints()) {
  return createPublicClient({ chain: robinhood, transport: fallback(endpoints.map(transportFor)) });
}

export type RpcClient = ReturnType<typeof createRpcClient>;

// Spreads block fetches round-robin over the primary endpoints. Each client starts at a different primary and
// falls back through the rest of the pool, so one slow or rate-limited provider only delays its share.
export class RpcPool {
  private readonly clients: RpcClient[];

  constructor(endpoints: RpcEndpoint[] = rpcEndpoints()) {
    const primaries = endpoints.filter((e) => e.primary);
    const starts = primaries.length > 0 ? primaries : endpoints;
    this.clients = starts.map((start) => createRpcClient([start, ...endpoints.filter((e) => e !== start)]));
  }

  get size(): number {
    return this.clients.length;
  }

  forBlock(n: bigint): RpcClient {
    const client = this.clients[Number(n % BigInt(this.clients.length))];
    if (!client) throw new Error("RPC pool is empty");
    return client;
  }

  get head(): RpcClient {
    return this.forBlock(0n);
  }
}
