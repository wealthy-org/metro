import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { SubsidyWindow } from "../engine/subsidy.ts";
import { anchorAt } from "./filters.ts";
import { tokenMarkets } from "./gecko.ts";
import { holderStats, ponsNonHolders } from "./holders.ts";
import { num, numOrNull, rows } from "./query.ts";

// Two Pons tokens side by side over one window (PROJECT.md 11.4; Phase 8 D5). Activity comes from the transactions
// that moved each token in the window's ingested blocks; holders and top-10 share are measured at the window's end
// (or the newest block, if earlier), with the curve pool left out (KL-25); volume is GeckoTerminal "now" (D2).

export type TokenSide = {
  address: string;
  symbol: string | null;
  tx: number;
  swaps: number;
  senders: number;
  avg_fee_usd: number | null;
  median_fee_usd: number | null;
  holders: number | null;
  holders_complete: boolean | null;
  top10_share: number | null;
  pool_share: number | null;
  volume_24h_usd: number | null;
};

export type TokenCompare = { window: { start: string; end: string }; anchor: string | null; a: TokenSide | null; b: TokenSide | null; candidates: { address: string; symbol: string | null; tx: number }[]; generated_at: string };

const between = (w: SubsidyWindow) => sql`tt.ts >= ${w.start} AND tt.ts < ${w.end}`;

async function side(db: Db, address: string, w: SubsidyWindow, anchor: Date | null, volume: number | null): Promise<TokenSide | null> {
  const [meta] = await rows(db, sql`
    SELECT k.symbol, l.block, l.params->>'topic2' AS pool FROM tokens k LEFT JOIN pons_launches l ON l.token_address = k.address
    WHERE k.address = ${address} AND k.is_pons`);
  if (!meta) return null;
  const [act] = await rows(db, sql`
    WITH moved AS (SELECT DISTINCT tt.tx_hash, tt.ts FROM token_transfers tt WHERE tt.token_address = ${address} AND ${between(w)})
    SELECT count(*) AS n, count(*) FILTER (WHERE t.action = 'swap') AS swaps, count(DISTINCT t.from_address) AS senders,
           avg(t.fee_usd) AS fee, percentile_disc(0.5) WITHIN GROUP (ORDER BY t.fee_usd) AS med
    FROM moved m JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts`);
  const at = anchor ? new Date(Math.min(anchor.getTime(), w.end.getTime() - 1)) : null;
  const h = at ? await holderStats(db, address, numOrNull(meta.block), at, ponsNonHolders(meta.pool)) : null;
  const held = h && h.holders > 0 ? h : null;
  return {
    address,
    symbol: meta.symbol === null ? null : String(meta.symbol),
    tx: num(act?.n),
    swaps: num(act?.swaps),
    senders: num(act?.senders),
    avg_fee_usd: numOrNull(act?.fee),
    median_fee_usd: numOrNull(act?.med),
    holders: held ? held.holders : null,
    holders_complete: held ? held.complete : null,
    top10_share: held ? held.top10_share : null,
    pool_share: held ? held.pool_share : null,
    volume_24h_usd: volume,
  };
}

export async function compareTokens(db: Db, w: SubsidyWindow, a: string | null, b: string | null): Promise<TokenCompare> {
  const [anchor, cand] = await Promise.all([
    anchorAt(db, null),
    rows(db, sql`
      SELECT k.address, k.symbol, count(DISTINCT tt.tx_hash) AS n
      FROM token_transfers tt JOIN tokens k ON k.address = tt.token_address AND k.is_pons
      WHERE ${between(w)} GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 20`),
  ]);
  const candidates = cand.map((x) => ({ address: String(x.address), symbol: x.symbol === null ? null : String(x.symbol), tx: num(x.n) }));
  // Defaults: the two Pons tokens moved by the most transactions in the window.
  const pickA = a ?? candidates[0]?.address ?? null;
  const pickB = b ?? candidates.find((c) => c.address !== pickA)?.address ?? null;
  const markets = await tokenMarkets([pickA, pickB].filter((x): x is string => x !== null));
  const vol = (x: string | null) => (x ? (markets?.get(x)?.volume_24h_usd ?? null) : null);
  const [sa, sb] = await Promise.all([pickA ? side(db, pickA, w, anchor, vol(pickA)) : null, pickB ? side(db, pickB, w, anchor, vol(pickB)) : null]);
  return { window: { start: w.start.toISOString(), end: w.end.toISOString() }, anchor: anchor?.toISOString() ?? null, a: sa, b: sb, candidates, generated_at: new Date().toISOString() };
}
