import { Blockscout } from "../collector/blockscout.ts";
import { log } from "../collector/log.ts";
import { limitedFetch } from "../collector/rate-limiter.ts";

// GeckoTerminal public API for Pons token markets (Phase 6 D2, KL-19): USD price and the 24 h volume, liquidity and
// DEX of each token's top pools. A supporting source outside PROJECT.md 8.1, approved 2026-09-28. It runs through the
// same guard layer as Blockscout (rate limit, cache, breaker, retry, validation). The public API allows about 30
// calls per minute; 0.4 per second stays under it, and one call covers up to 30 tokens.

const BASE = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const TTL_MS = 5 * 60_000;
const BATCH = 30;

let client: Blockscout | null = null;
const gecko = () => (client ??= new Blockscout({ name: "GeckoTerminal", base: BASE, fetch: limitedFetch("api.geckoterminal.com", 0.4) }));

export type PoolMarket = { address: string; name: string; dex: string | null; volume_24h_usd: number | null; reserve_usd: number | null };
// volume_24h_usd: sum over the token's top pools (GeckoTerminal lists up to three); null when none reports volume.
export type TokenMarket = { address: string; price_usd: number | null; volume_24h_usd: number | null; pools: PoolMarket[] };

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

export function parseMarkets(body: unknown): TokenMarket[] {
  const b = rec(body);
  const pools = new Map<string, Record<string, unknown>>();
  for (const inc of Array.isArray(b.included) ? b.included : []) {
    const i = rec(inc);
    if (i.type === "pool" && typeof i.id === "string") pools.set(i.id, i);
  }
  const out: TokenMarket[] = [];
  for (const item of Array.isArray(b.data) ? b.data : []) {
    const d = rec(item);
    const a = rec(d.attributes);
    if (typeof a.address !== "string") continue;
    const refs = rec(rec(d.relationships).top_pools).data;
    const tokenPools: PoolMarket[] = (Array.isArray(refs) ? refs : [])
      .map((r) => pools.get(String(rec(r).id)))
      .filter((p): p is Record<string, unknown> => p !== undefined)
      .map((p) => {
        const pa = rec(p.attributes);
        return {
          address: String(pa.address ?? "").toLowerCase(),
          name: String(pa.name ?? ""),
          dex: (rec(rec(rec(p.relationships).dex).data).id as string | undefined) ?? null,
          volume_24h_usd: num(rec(pa.volume_usd).h24),
          reserve_usd: num(pa.reserve_in_usd),
        };
      });
    const vols = tokenPools.map((p) => p.volume_24h_usd).filter((v): v is number => v !== null);
    out.push({ address: a.address.toLowerCase(), price_usd: num(a.price_usd), volume_24h_usd: vols.length ? vols.reduce((s, v) => s + v, 0) : null, pools: tokenPools });
  }
  return out;
}

const isMarketBody = (b: unknown) => Array.isArray(rec(b).data);

// Markets for the given token addresses. Tokens GeckoTerminal does not know are absent from the map. Returns null
// when GeckoTerminal cannot be reached, so callers can say "unavailable" instead of showing zero volume.
export async function tokenMarkets(addresses: string[]): Promise<Map<string, TokenMarket> | null> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].sort();
  const out = new Map<string, TokenMarket>();
  try {
    for (let i = 0; i < unique.length; i += BATCH) {
      const chunk = unique.slice(i, i + BATCH);
      const body = await gecko().get(`/tokens/multi/${chunk.join(",")}`, { query: { include: "top_pools" }, ttlMs: TTL_MS, validate: isMarketBody });
      for (const m of parseMarkets(body)) out.set(m.address, m);
    }
    return out;
  } catch (err) {
    log("warn", "geckoterminal request failed", { source: "geckoterminal", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return null;
  }
}
