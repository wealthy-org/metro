import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { prices } from "../db/schema.ts";
import { log } from "./log.ts";
import { limitedFetch } from "./rate-limiter.ts";

export const DEFAULT_SOURCE = "https://coins.llama.fi/prices/current/coingecko:ethereum";
const CHART_SOURCE = "https://coins.llama.fi/chart/coingecko:ethereum";
const POLL_MS = 60_000;
// A past minute without its own quote (failed poll, or the timer fired later in that minute) reuses
// the newest earlier quote at most this old, stored under the missing minute.
const MAX_FILL_GAP_MS = 5 * 60_000;
const STEP_S = 300;
const WINDOW_POINTS = 288;
// A historical 5-minute point older than this is not used; the batch fails and retries instead.
const MAX_POINT_AGE_S = 15 * 60;

// DefiLlama's coins API is shared by the live poller and the backfill; keep both under 2 requests per second.
const defillamaFetch = limitedFetch("coins.llama.fi", 2);

const minuteOf = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000);

export type PriceSource = { priceAt(ts: Date): Promise<string> };

async function storedPrice(db: Db, minute: Date): Promise<string | null> {
  const [row] = await db.select({ ethUsd: prices.ethUsd }).from(prices).where(eq(prices.ts, minute)).limit(1);
  return row?.ethUsd ?? null;
}

// Inserts unless another writer stored the minute first; returns the stored row, which every block must use.
async function storePrice(db: Db, minute: Date, ethUsd: string): Promise<string> {
  await db.insert(prices).values({ ts: minute, ethUsd }).onConflictDoNothing();
  return (await storedPrice(db, minute)) ?? ethUsd;
}

export async function fetchCurrent(url: string): Promise<string> {
  const res = await defillamaFetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ETH price HTTP ${res.status}`);
  const body: unknown = await res.json();
  const coins = typeof body === "object" && body !== null ? (body as { coins?: Record<string, { price?: unknown }> }).coins : undefined;
  const price = coins?.["coingecko:ethereum"]?.price;
  if (typeof price !== "number" || !(price > 0)) throw new Error("ETH price missing in response");
  return price.toString();
}

// ETH/USD per minute for live ingest (PROJECT.md 8.1). Quotes are polled on their own timer so ingest lag never
// leaves a minute without a price, and stored quotes are reused so re-ingesting a block yields the same fee_usd.
export class PriceFeed implements PriceSource {
  private readonly cache = new Map<number, string>();
  private readonly db: Db;
  private readonly url: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Db, url = process.env.ETH_PRICE_SOURCE_URL || DEFAULT_SOURCE) {
    this.db = db;
    this.url = url;
  }

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    // The ingest loop keeps the process alive; the poller alone must not block exit after a crash.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      await storePrice(this.db, minuteOf(Date.now()), await fetchCurrent(this.url));
    } catch (err) {
      log("warn", "ETH price poll failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async priceAt(ts: Date): Promise<string> {
    const minute = minuteOf(ts.getTime());
    const key = minute.getTime();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const value = (await storedPrice(this.db, minute)) ?? (await this.fill(minute));
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, value);
    return value;
  }

  // The current minute may not be polled yet, so it takes a fresh quote; a past minute reuses the newest earlier quote.
  private async fill(minute: Date): Promise<string> {
    const key = minute.getTime();
    if (key === minuteOf(Date.now()).getTime()) return storePrice(this.db, minute, await fetchCurrent(this.url));
    const [nearest] = await this.db
      .select({ ethUsd: prices.ethUsd })
      .from(prices)
      .where(and(lte(prices.ts, minute), gte(prices.ts, new Date(key - MAX_FILL_GAP_MS))))
      .orderBy(desc(prices.ts))
      .limit(1);
    if (!nearest) {
      throw new Error(`No ETH price within 5 minutes before ${minute.toISOString()}; older blocks go through the backfill`);
    }
    return storePrice(this.db, minute, nearest.ethUsd);
  }
}

// Historical ETH/USD for the backfill. DefiLlama's chart API returns one point per 5 minutes (period=1m still
// returns 5-minute points, checked 2026-09-27), so a minute takes the newest point at or before it; the value is
// stored under that minute so fee_usd stays equal to fee_eth * eth_usd of the minute.
export class HistoricalPriceFeed implements PriceSource {
  private readonly points = new Map<number, string>();
  private readonly loaded = new Set<number>();
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async priceAt(ts: Date): Promise<string> {
    const minute = minuteOf(ts.getTime());
    const stored = await storedPrice(this.db, minute);
    if (stored) return stored;
    return storePrice(this.db, minute, await this.pointAtOrBefore(minute.getTime() / 1000));
  }

  private async pointAtOrBefore(sec: number): Promise<string> {
    const aligned = Math.floor(sec / STEP_S) * STEP_S;
    for (let t = aligned; t >= aligned - MAX_POINT_AGE_S; t -= STEP_S) {
      if (!this.loaded.has(t)) await this.loadWindowEndingAt(t);
      const price = this.points.get(t);
      if (price) return price;
    }
    throw new Error(`No historical ETH price within 15 minutes before ${new Date(sec * 1000).toISOString()}`);
  }

  // The backfill walks backward in time, so each request covers the 24 hours ending at the missing point.
  private async loadWindowEndingAt(end: number): Promise<void> {
    const start = end - (WINDOW_POINTS - 1) * STEP_S;
    const res = await defillamaFetch(`${CHART_SOURCE}?start=${start}&span=${WINDOW_POINTS}&period=5m`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Historical ETH price HTTP ${res.status}`);
    const body: unknown = await res.json();
    const series =
      typeof body === "object" && body !== null
        ? (body as { coins?: Record<string, { prices?: { timestamp?: unknown; price?: unknown }[] }> }).coins?.["coingecko:ethereum"]?.prices
        : undefined;
    if (this.loaded.size > 50_000) {
      this.points.clear();
      this.loaded.clear();
    }
    const valid = (series ?? []).filter(
      (p): p is { timestamp: number; price: number } => typeof p.timestamp === "number" && typeof p.price === "number" && p.price > 0,
    );
    // An empty answer is not cached, so the next retry asks again instead of failing for the rest of the run.
    if (valid.length === 0) throw new Error(`Historical ETH price window ending ${new Date(end * 1000).toISOString()} is empty`);
    for (const p of valid) this.points.set(Math.floor(p.timestamp / STEP_S) * STEP_S, p.price.toString());
    for (let t = start; t <= end; t += STEP_S) this.loaded.add(t);
  }
}
