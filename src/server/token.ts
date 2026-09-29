import { sql } from "drizzle-orm";
import { erc20Abi, type Hex } from "viem";
import { EXPLORER_URL } from "../../config/known-contracts.ts";
import { formatFixed } from "../collector/fees.ts";
import type { Db } from "../db/client.ts";
import type { TokenProfile } from "../lib/api-types.ts";
import { anchorAt } from "./filters.ts";
import { tokenMarkets } from "./gecko.ts";
import { holderStats, ponsNonHolders } from "./holders.ts";
import { iso, num, numOrNull, rows } from "./query.ts";
import { recentLaunches } from "./recent-launches.ts";
import { memoized, readClient } from "./rpc-read.ts";

// Token profile (PROJECT.md 15). Pons tokens from `tokens` and `pons_launches`; any other ERC-20 token from RPC on
// demand, not stored (Phase 6 D4). Supply from RPC `totalSupply()`; holders from token_transfers (D1); USD market
// from GeckoTerminal (D2). Activity covers the ingested blocks only.

const META_TTL_MS = 10 * 60_000;
const DAYS = 7;
const DAY_MS = 86_400_000;

type Meta = { name: string | null; symbol: string | null; decimals: number | null; supply: string | null };

async function rpcMeta(address: string): Promise<Meta | null> {
  return memoized(`meta|${address}`, META_TTL_MS, async () => {
    const [name, symbol, decimals, supply] = await readClient().multicall({
      allowFailure: true,
      contracts: [
        { address: address as Hex, abi: erc20Abi, functionName: "name" },
        { address: address as Hex, abi: erc20Abi, functionName: "symbol" },
        { address: address as Hex, abi: erc20Abi, functionName: "decimals" },
        { address: address as Hex, abi: erc20Abi, functionName: "totalSupply" },
      ],
    });
    // Not an ERC-20 token when none of the calls answers.
    if ([name, symbol, decimals, supply].every((r) => r.status !== "success")) return null;
    return {
      name: name.status === "success" ? name.result.slice(0, 128) : null,
      symbol: symbol.status === "success" ? symbol.result.slice(0, 32) : null,
      decimals: decimals.status === "success" ? decimals.result : null,
      supply: supply.status === "success" ? supply.result.toString() : null,
    };
  });
}

export const formatUnits = (raw: string | null, decimals: number | null) => (raw === null ? null : formatFixed(BigInt(raw), decimals ?? 18));

// Returns null for an address that is neither a known token nor an ERC-20 contract.
export async function getToken(db: Db, address: string, at: string | null = null): Promise<TokenProfile | null> {
  const [stored] = await rows(db, sql`
    SELECT k.symbol, k.name, k.decimals, k.is_pons, l.block, l.ts, l.creator_address, l.params->>'topic2' AS pool
    FROM tokens k LEFT JOIN pons_launches l ON l.token_address = k.address WHERE k.address = ${address}`);
  const meta = await rpcMeta(address).catch(() => null);
  if (!stored && !meta) return null;
  // A Pons launch newer than the ingested blocks is known from the factory logs read for the Launchpad (KL-24).
  const recent = stored ? null : ((await recentLaunches(100)) ?? []).find((x) => x.address === address) ?? null;
  const isPons = Boolean(stored?.is_pons) || recent !== null;
  const anchor = await anchorAt(db, at);
  const decimals = stored ? num(stored.decimals) : (meta?.decimals ?? 18);
  const launchBlock = stored ? numOrNull(stored.block) : null;

  const sparkStart = anchor ? new Date(Date.parse(`${anchor.toISOString().slice(0, 10)}T00:00:00Z`) - (DAYS - 1) * DAY_MS) : null;
  const [holders, markets, daily, transfers] = await Promise.all([
    anchor ? holderStats(db, address, launchBlock, anchor, isPons ? ponsNonHolders(stored?.pool ?? recent?.pool) : []) : Promise.resolve(null),
    tokenMarkets([address]),
    anchor && sparkStart
      ? rows(db, sql`
          WITH moved AS (SELECT DISTINCT tx_hash, ts FROM token_transfers WHERE token_address = ${address} AND ts >= ${sparkStart} AND ts <= ${anchor})
          SELECT date_bin('1 day'::interval, m.ts, timestamptz '2000-01-01') AS d, count(*) AS n, avg(t.fee_usd) AS fee
          FROM moved m JOIN txs t ON t.hash = m.tx_hash AND t.ts = m.ts GROUP BY 1 ORDER BY 1`)
      : Promise.resolve([]),
    anchor
      ? rows(db, sql`
          SELECT tx_hash, from_address, to_address, amount, ts FROM token_transfers
          WHERE token_address = ${address} AND ts <= ${anchor} ORDER BY ts DESC, log_index DESC LIMIT 10`)
      : Promise.resolve([]),
  ]);
  const byDay = new Map(daily.map((x) => [(iso(x.d) ?? "").slice(0, 10), x]));
  const days = sparkStart ? Array.from({ length: DAYS }, (_, i) => new Date(sparkStart.getTime() + i * DAY_MS).toISOString().slice(0, 10)) : [];
  const m = markets?.get(address) ?? null;
  const supplyRaw = meta?.supply ?? null;
  const launch = stored && stored.block !== null
    ? { block: num(stored.block), ts: iso(stored.ts) ?? "", creator: String(stored.creator_address), source: "ingested" as const }
    : recent
      ? { block: recent.block, ts: recent.ts, creator: recent.creator, source: "rpc" as const }
      : null;

  return {
    address,
    name: stored?.name != null ? String(stored.name) : (meta?.name ?? null),
    symbol: stored?.symbol != null ? String(stored.symbol) : (meta?.symbol ?? null),
    decimals,
    is_pons: isPons,
    launch: launch ? { ...launch, creator_url: `${EXPLORER_URL}/address/${launch.creator}` } : null,
    supply: supplyRaw === null ? null : { raw: supplyRaw, formatted: formatUnits(supplyRaw, decimals) ?? "", source: "rpc" },
    // No transfer of the token in the ingested blocks: its holders are unknown, not zero.
    holders: holders && transfers.length ? holders : null,
    market: m ? { price_usd: m.price_usd, volume_24h_usd: m.volume_24h_usd, pools: m.pools } : null,
    market_available: markets !== null,
    daily: days.map((d) => ({ date: d, n: num(byDay.get(d)?.n), avg_fee_usd: numOrNull(byDay.get(d)?.fee) })),
    // The profile's window is the 7 UTC days up to the anchor; n is the transactions that moved the token in it.
    // No ingested transfer at all means unknown, not zero (the same rule as holders).
    n: transfers.length === 0 ? null : days.reduce((t, d) => t + num(byDay.get(d)?.n), 0),
    window: sparkStart && anchor ? { start: sparkStart.toISOString(), end: anchor.toISOString() } : null,
    transfers: transfers.map((x) => ({
      tx_hash: String(x.tx_hash),
      from: String(x.from_address),
      to: String(x.to_address),
      amount: formatUnits(String(x.amount), decimals) ?? "0",
      ts: iso(x.ts) ?? "",
    })),
    anchor: anchor?.toISOString() ?? null,
    generated_at: new Date().toISOString(),
  };
}
