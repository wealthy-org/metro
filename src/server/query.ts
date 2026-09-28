import type { SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";

// Small helpers shared by the lens readers.

export type Row = Record<string, unknown>;

export async function rows(db: Db, query: SQL): Promise<Row[]> {
  return (await db.execute(query)).rows as Row[];
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? new Date(v).toISOString() : null);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// Distinct wallets, failures, token movement and filtered figures only come from raw rows. Lens windows are
// minute-aligned, so a result stays valid until the next minute; the TTL bounds how long a stale anchor lingers.
const RAW_CACHE_MS = 60_000;
const MAX_ENTRIES = 500;
const rawCache = new Map<string, { at: number; value: Promise<Row[]> }>();

export function cachedRows(db: Db, key: string, query: SQL): Promise<Row[]> {
  const now = Date.now();
  for (const [k, v] of rawCache) if (now - v.at >= RAW_CACHE_MS) rawCache.delete(k);
  const hit = rawCache.get(key);
  if (hit) return hit.value;
  // Scrubbing creates one key per minute; the oldest entries go first when the map is full.
  while (rawCache.size >= MAX_ENTRIES) {
    const oldest = rawCache.keys().next().value;
    if (oldest === undefined) break;
    rawCache.delete(oldest);
  }
  // Concurrent callers share the in-flight query; a failure is not kept.
  const value = rows(db, query).catch((err: unknown) => {
    rawCache.delete(key);
    throw err;
  });
  rawCache.set(key, { at: now, value });
  return value;
}
