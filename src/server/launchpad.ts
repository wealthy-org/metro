import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { LaunchpadResponse, LaunchpadToken } from "../lib/api-types.ts";
import type { CityWindow } from "../lib/city.ts";
import type { Filters } from "../lib/view-state.ts";
import { firstDataTs, resolveRange, txTime, windowInfo } from "./city.ts";
import { coverage, filterKey, subsidyEnd, txFilter } from "./filters.ts";
import { tokenMarkets } from "./gecko.ts";
import { holderStats, ponsNonHolders } from "./holders.ts";
import { cachedRows, iso, num, numOrNull, rows } from "./query.ts";
import { recentLaunches } from "./recent-launches.ts";

// Launchpad lens (PROJECT.md 10.6): every Pons token launched up to the anchor, newest first, with age, activity in
// the window, a 7-day sparkline, holders and top-10 share (Phase 6 D1, KL-25) and USD market figures (D2). Highlights
// are measured facts: the largest 24 h holder growth, and top-10 share above 50 % (the landing and prototype
// threshold). A live view also lists the newest launches read from the factory logs over RPC that are not ingested
// yet (KL-24), marked `source: "rpc"`, with unknown holders and activity.

const MAX_TOKENS = 100;
const SPARK_DAYS = 7;
const DAY_MS = 86_400_000;
// One GeckoTerminal call covers 30 tokens; more would wait on its 0.4 calls/s limit (KL-15), so the rest go unpriced.
const MARKET_LOOKUPS = 30;
export const CONCENTRATION_THRESHOLD = 0.5;

type Params = { window: CityWindow; filters: Filters; live: boolean };

export async function getLaunchpad(db: Db, p: Params, anchor: Date | null): Promise<LaunchpadResponse> {
  const cov = await coverage(db);
  const base = { filters: p.filters, coverage: cov, subsidy_end: subsidyEnd(), generated_at: new Date().toISOString() };
  const recent = p.live ? await recentLaunches(MAX_TOKENS) : null;
  const recentInfo = p.live ? { source: "rpc" as const, available: recent !== null } : null;

  const r = anchor ? resolveRange(p.window, anchor) : null;
  const firstTs = r ? await firstDataTs(db, r) : null;
  const launches = anchor
    ? await rows(db, sql`
        SELECT k.address, k.symbol, k.name, l.block, l.ts, l.creator_address, l.params->>'topic2' AS pool
        FROM tokens k JOIN pons_launches l ON l.token_address = k.address
        WHERE k.is_pons AND l.ts <= ${anchor}
        ORDER BY l.ts DESC, k.address
        LIMIT ${MAX_TOKENS}`)
    : [];
  const stored = new Set(launches.map((x) => String(x.address)));
  // Ingested launches always stay (only they have figures); RPC launches fill the rest of the MAX_TOKENS rows.
  const extra = (recent ?? []).filter((x) => !stored.has(x.address)).slice(0, Math.max(0, MAX_TOKENS - launches.length));
  const addresses = launches.map((x) => String(x.address));

  const empty = { market: { source: "GeckoTerminal" as const, available: true }, highlights: { fastest: null, concentrated: [] }, n: 0 };
  if (!addresses.length && !extra.length) return { ...base, window: windowInfo(p.window, r, firstTs, anchor), tokens: [], recent: recentInfo, ...empty };

  const list = addresses.length ? sql.join(addresses.map((a) => sql`${a}`), sql`, `) : null;
  const sparkStart = anchor ? new Date(Date.parse(`${anchor.toISOString().slice(0, 10)}T00:00:00Z`) - (SPARK_DAYS - 1) * DAY_MS) : null;
  const key = r ? `launchpad|${r.start?.toISOString() ?? "-"}|${r.end.toISOString()}|${filterKey(p.filters)}|${addresses.length}` : "";
  const lookups = [...addresses, ...extra.map((x) => x.address)].slice(0, MARKET_LOOKUPS);

  const [activity, daily, markets, holders] = await Promise.all([
    list && r
      ? cachedRows(db, `${key}|activity`, sql`
          WITH moved AS (
            SELECT DISTINCT tt.token_address, tt.tx_hash, tt.ts FROM token_transfers tt
            WHERE tt.token_address IN (${list}) AND ${txTime(r, sql`tt.ts`)}
          )
          SELECT m.token_address AS key, count(*) AS n, count(*) FILTER (WHERE t.action = 'swap') AS swaps, avg(t.fee_usd) AS fee
          FROM moved m JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts
          WHERE true ${txFilter({ ...p.filters, token: null }, "t")}
          GROUP BY 1`)
      : Promise.resolve([]),
    list && sparkStart && anchor
      ? cachedRows(db, `${key}|daily|${sparkStart.toISOString()}`, sql`
          SELECT token_address AS key, date_bin('1 day'::interval, ts, timestamptz '2000-01-01') AS d, count(DISTINCT tx_hash) AS n
          FROM token_transfers WHERE token_address IN (${list}) AND ts >= ${sparkStart} AND ts <= ${anchor}
          GROUP BY 1, 2`)
      : Promise.resolve([]),
    tokenMarkets(lookups),
    anchor ? Promise.all(launches.map((x) => holderStats(db, String(x.address), numOrNull(x.block), anchor, ponsNonHolders(x.pool)))) : Promise.resolve([]),
  ]);

  const act = new Map(activity.map((x) => [String(x.key), x]));
  const days = sparkStart ? Array.from({ length: SPARK_DAYS }, (_, i) => new Date(sparkStart.getTime() + i * DAY_MS).toISOString().slice(0, 10)) : [];
  const perDay = new Map<string, Map<string, number>>();
  for (const x of daily) {
    const m = perDay.get(String(x.key)) ?? new Map<string, number>();
    m.set((iso(x.d) ?? "").slice(0, 10), num(x.n));
    perDay.set(String(x.key), m);
  }
  const market = (address: string) => {
    const m = markets?.get(address);
    return m ? { price_usd: m.price_usd, volume_24h_usd: m.volume_24h_usd, pools: m.pools } : null;
  };

  const ingested: LaunchpadToken[] = launches.map((x, i) => {
    const address = String(x.address);
    const a = act.get(address);
    const h = holders[i];
    return {
      address,
      source: "ingested",
      symbol: x.symbol === null ? null : String(x.symbol),
      name: x.name === null ? null : String(x.name),
      launch_block: num(x.block),
      launch_ts: iso(x.ts) ?? "",
      creator: String(x.creator_address),
      tx_count: num(a?.n),
      swaps: num(a?.swaps),
      avg_fee_usd: numOrNull(a?.fee),
      daily: days.map((d) => ({ date: d, n: perDay.get(address)?.get(d) ?? 0 })),
      holders: h ?? null,
      market: market(address),
      market_checked: lookups.includes(address),
      concentrated: h?.top10_share !== null && h?.top10_share !== undefined && h.top10_share > CONCENTRATION_THRESHOLD,
    };
  });
  const fromRpc: LaunchpadToken[] = extra.map((x) => ({
    address: x.address,
    source: "rpc",
    symbol: x.symbol,
    name: x.name,
    launch_block: x.block,
    launch_ts: x.ts,
    creator: x.creator,
    tx_count: null,
    swaps: null,
    avg_fee_usd: null,
    daily: [],
    holders: null,
    market: market(x.address),
    market_checked: lookups.includes(x.address),
    concentrated: false,
  }));
  const tokens = [...fromRpc, ...ingested].sort((a, b) => b.launch_block - a.launch_block);

  const growth = (t: LaunchpadToken) => (t.holders ? t.holders.holders - t.holders.holders_24h_ago : 0);
  const fastest = tokens.reduce<LaunchpadToken | null>((best, t) => (growth(t) > 0 && (!best || growth(t) > growth(best)) ? t : best), null);
  return {
    ...base,
    window: windowInfo(p.window, r, firstTs, anchor),
    tokens,
    recent: recentInfo,
    market: { source: "GeckoTerminal", available: markets !== null },
    highlights: { fastest: fastest?.address ?? null, concentrated: tokens.filter((t) => t.concentrated).map((t) => t.address) },
    n: tokens.reduce((s, t) => s + (t.tx_count ?? 0), 0),
  };
}
