import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { prices } from "../db/schema.ts";
import { log } from "./log.ts";

const DEFAULT_SOURCE = "https://coins.llama.fi/prices/current/coingecko:ethereum";
const POLL_MS = 60_000;
// A past minute without its own quote (failed poll, or the timer fired later in that minute) reuses
// the newest earlier quote at most this old, stored under the missing minute.
const MAX_FILL_GAP_MS = 5 * 60_000;

const minuteOf = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000);

async function fetchCurrent(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ETH price HTTP ${res.status}`);
  const body: unknown = await res.json();
  const coins = typeof body === "object" && body !== null ? (body as { coins?: Record<string, { price?: unknown }> }).coins : undefined;
  const price = coins?.["coingecko:ethereum"]?.price;
  if (typeof price !== "number" || !(price > 0)) throw new Error("ETH price missing in response");
  return price.toString();
}

// ETH/USD per minute (PROJECT.md 8.1). Quotes are polled on their own timer so ingest lag never leaves a
// minute without a price, and stored quotes are reused so re-ingesting a block yields the same fee_usd.
export class PriceFeed {
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
      const minute = minuteOf(Date.now());
      const ethUsd = await fetchCurrent(this.url);
      await this.db.insert(prices).values({ ts: minute, ethUsd }).onConflictDoNothing();
    } catch (err) {
      log("warn", "ETH price poll failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async priceAt(ts: Date): Promise<string> {
    const minute = minuteOf(ts.getTime());
    const key = minute.getTime();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const value = (await this.stored(minute)) ?? (await this.fill(minute));
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, value);
    return value;
  }

  private async stored(minute: Date): Promise<string | null> {
    const [row] = await this.db.select({ ethUsd: prices.ethUsd }).from(prices).where(eq(prices.ts, minute)).limit(1);
    return row?.ethUsd ?? null;
  }

  // The current minute may not be polled yet, so it takes a fresh quote; a past minute reuses the newest earlier quote.
  private async fill(minute: Date): Promise<string> {
    const key = minute.getTime();
    let ethUsd: string;
    if (key === minuteOf(Date.now()).getTime()) {
      ethUsd = await fetchCurrent(this.url);
    } else {
      const [nearest] = await this.db
        .select({ ethUsd: prices.ethUsd })
        .from(prices)
        .where(and(lte(prices.ts, minute), gte(prices.ts, new Date(key - MAX_FILL_GAP_MS))))
        .orderBy(desc(prices.ts))
        .limit(1);
      if (!nearest) {
        throw new Error(`No ETH price within 5 minutes before ${minute.toISOString()}; historical prices arrive with the Phase 2 backfill`);
      }
      ethUsd = nearest.ethUsd;
    }
    await this.db.insert(prices).values({ ts: minute, ethUsd }).onConflictDoNothing();
    // Another writer may have stored this minute first; the stored row is the one every block must use.
    return (await this.stored(minute)) ?? ethUsd;
  }
}
