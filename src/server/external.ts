import { BlockscoutError, BlockscoutUnavailable, sharedBlockscout } from "../collector/blockscout.ts";
import { log } from "../collector/log.ts";
import { limitedFetch } from "../collector/rate-limiter.ts";

// Ticker context from third-party sources (PROJECT.md 8.1). Held in memory with the frequency PROJECT.md gives
// for each dataset; PROJECT.md 17 has no table for them, so nothing is persisted.

const DEFILLAMA_TTL_MS = 60 * 60_000;
const BLOCKSCOUT_TTL_MS = 5 * 60_000;
const DEFILLAMA_CHAIN = "Robinhood Chain";
const DEFILLAMA_FEES_SLUG = "robinhood-chain";

const llamaFetch = limitedFetch("api.llama.fi", 2);

export type ChainEconomics = {
  tvl_usd: number | null;
  // DefiLlama's chain fee adapter: gas fees paid by users on the chain (L2 execution plus L1 data fee).
  fees_usd: number | null;
  revenue_usd: number | null;
  // UTC day the fee and revenue figures cover (the last complete day DefiLlama reports).
  fees_day: string | null;
  source: "DefiLlama";
  fetched_at: string;
};

export type ChainStats =
  | { available: true; total_transactions: number | null; total_addresses: number | null; transactions_today: number | null; source: "Blockscout"; fetched_at: string }
  | { available: false; reason: string; source: "Blockscout"; checked_at: string };

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const field = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined);

export function parseTvl(chains: unknown): number | null {
  if (!Array.isArray(chains)) return null;
  const chain = chains.find((c) => field(c, "name") === DEFILLAMA_CHAIN);
  return num(field(chain, "tvl"));
}

// Reads total24h plus the day of the newest chart point from /summary/fees/{slug}.
export function parseFeeSummary(body: unknown): { total: number | null; day: string | null } {
  const chart = field(body, "totalDataChart");
  const last = Array.isArray(chart) ? chart.at(-1) : undefined;
  const ts = Array.isArray(last) ? num(last[0]) : null;
  return { total: num(field(body, "total24h")), day: ts === null ? null : new Date(ts * 1000).toISOString().slice(0, 10) };
}

async function getJson(url: string): Promise<unknown> {
  const res = await llamaFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
  return res.json();
}

let economics: { value: ChainEconomics; at: number } | null = null;
let economicsInflight: Promise<ChainEconomics | null> | null = null;

async function loadEconomics(): Promise<ChainEconomics | null> {
  const base = (process.env.DEFILLAMA_API_URL || "https://api.llama.fi").replace(/\/$/, "");
  const [chains, fees, revenue] = await Promise.allSettled([
    getJson(`${base}/v2/chains`),
    getJson(`${base}/summary/fees/${DEFILLAMA_FEES_SLUG}?dataType=dailyFees`),
    getJson(`${base}/summary/fees/${DEFILLAMA_FEES_SLUG}?dataType=dailyRevenue`),
  ]);
  const tvl = chains.status === "fulfilled" ? parseTvl(chains.value) : null;
  const f = fees.status === "fulfilled" ? parseFeeSummary(fees.value) : { total: null, day: null };
  const r = revenue.status === "fulfilled" ? parseFeeSummary(revenue.value) : { total: null, day: null };
  if (tvl === null && f.total === null && r.total === null) return null;
  return { tvl_usd: tvl, fees_usd: f.total, revenue_usd: r.total, fees_day: f.day ?? r.day, source: "DefiLlama", fetched_at: new Date().toISOString() };
}

// A failed refresh keeps serving the previous figures, which carry their own fetched_at.
export async function chainEconomics(now = Date.now()): Promise<ChainEconomics | null> {
  if (economics && now - economics.at < DEFILLAMA_TTL_MS) return economics.value;
  economicsInflight ??= loadEconomics()
    .catch(() => null)
    .finally(() => {
      economicsInflight = null;
    });
  const value = await economicsInflight;
  if (value) economics = { value, at: Date.now() };
  return economics?.value ?? null;
}

let stats: { value: ChainStats; at: number } | null = null;
let statsInflight: Promise<ChainStats> | null = null;

const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

const GENERIC_REASON = "Blockscout explorer not reachable from the server";

// Public reason for an unavailable chain stats readout. Messages of the Blockscout client are fixed texts written in
// src/collector/blockscout.ts (status code or failure kind, no URL, no key), so they are safe to show and tell a
// Cloudflare block apart from a timeout. Anything else stays generic.
export function blockscoutReason(err: unknown): string {
  return err instanceof BlockscoutUnavailable || err instanceof BlockscoutError ? err.message : GENERIC_REASON;
}

async function loadStats(): Promise<ChainStats> {
  try {
    const body = await sharedBlockscout().get("/stats", { ttlMs: BLOCKSCOUT_TTL_MS, validate: isObject });
    return {
      available: true,
      total_transactions: num(field(body, "total_transactions")),
      total_addresses: num(field(body, "total_addresses")),
      transactions_today: num(field(body, "transactions_today")),
      source: "Blockscout",
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    // External API failures are logged (PROJECT.md 19 observability), at most once per 5 minutes by the cache below.
    const reason = blockscoutReason(err);
    log("warn", "blockscout request failed", {
      source: "blockscout",
      path: "/stats",
      reason,
      retry_after: err instanceof BlockscoutUnavailable ? new Date(err.until).toISOString() : null,
    });
    return { available: false, reason, source: "Blockscout", checked_at: new Date().toISOString() };
  }
}

// Unavailability is cached too, so a blocked explorer is asked at most once per 5 minutes.
export async function chainStats(now = Date.now()): Promise<ChainStats> {
  if (stats && now - stats.at < BLOCKSCOUT_TTL_MS) return stats.value;
  statsInflight ??= loadStats().finally(() => {
    statsInflight = null;
  });
  const value = await statsInflight;
  // Keep the last good numbers when a later check fails.
  if (value.available || !stats?.value.available) stats = { value, at: Date.now() };
  return stats?.value ?? value;
}
