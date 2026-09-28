import { sql } from "drizzle-orm";
import { PONS_FACTORY } from "../../config/known-contracts.ts";
import type { Db } from "../db/client.ts";
import { cachedRows, num, numOrNull } from "./query.ts";

// Holders, holder change and top-10 share from our own `token_transfers` (Phase 6 D1; KL-3: Blockscout /api/v2 is
// blocked for servers). A holder is an address with a positive net balance of the token, the zero address excluded.
// The figures are complete only when every block from the launch block to the anchor block is ingested; otherwise
// they cover the ingested blocks only and say so.
// PROJECT.md 8.1 defines concentration as the top-10 holders' part of supply. The token's own Pons curve pool
// (TokenLaunched topic2) and the factory are not holders in that sense, so they are left out of the top ten and their
// part is reported on its own as `pool_share` (KL-25, user decision 2026-09-28). Supply stays the denominator.

const DAY_MS = 86_400_000;
const ZERO = "0x0000000000000000000000000000000000000000";

// The addresses left out of a Pons token's top ten: its curve pool (TokenLaunched topic2, stored in
// pons_launches.params; scripts/verify-pons-launches.ts checks it is a Pons pool) and the factory.
export function ponsNonHolders(pool: unknown): string[] {
  const p = typeof pool === "string" && /^0x[0-9a-f]{40}$/.test(pool) ? [pool] : [];
  return [...p, PONS_FACTORY];
}

export type HolderStats = {
  holders: number;
  holders_24h_ago: number;
  top10_share: number | null;
  pool_share: number | null;
  excluded: string[];
  complete: boolean;
  blocks_ingested: number | null;
  blocks_expected: number | null;
  basis: "token_transfers";
};

function balancesAt(token: string, at: Date, exclude: readonly string[]) {
  const ex = exclude.length ? sql.join(exclude.map((a) => sql`${a}`), sql`, `) : sql`${ZERO}`;
  return sql`
    WITH moves AS (
      SELECT to_address AS a, amount AS d FROM token_transfers WHERE token_address = ${token} AND ts <= ${at}
      UNION ALL
      SELECT from_address, -amount FROM token_transfers WHERE token_address = ${token} AND ts <= ${at}
    ), bal AS (
      SELECT a, sum(d) AS b FROM moves WHERE a <> ${ZERO} GROUP BY a HAVING sum(d) > 0
    )
    SELECT count(*) AS holders,
           (SELECT sum(b) FROM (SELECT b FROM bal WHERE a NOT IN (${ex}) ORDER BY b DESC LIMIT 10) t) AS top10,
           (SELECT sum(b) FROM bal WHERE a IN (${ex})) AS pooled,
           (SELECT sum(b) FROM bal) AS total
    FROM bal`;
}

export async function holderStats(db: Db, token: string, launchBlock: number | null, anchor: Date, exclude: readonly string[] = []): Promise<HolderStats> {
  const ex = [...new Set(exclude.map((a) => a.toLowerCase()))].sort();
  const key = `holders|${token}|${anchor.toISOString()}|${ex.join(",")}`;
  const [now, before, cover] = await Promise.all([
    cachedRows(db, `${key}|now`, balancesAt(token, anchor, ex)),
    cachedRows(db, `${key}|24h`, balancesAt(token, new Date(anchor.getTime() - DAY_MS), ex)),
    launchBlock === null
      ? Promise.resolve([])
      : cachedRows(db, `${key}|cover`, sql`
          WITH a AS (SELECT number FROM blocks WHERE ts <= ${anchor} ORDER BY ts DESC LIMIT 1)
          SELECT (SELECT number FROM a) AS anchor_block,
                 (SELECT count(*) FROM blocks WHERE number BETWEEN ${launchBlock} AND (SELECT number FROM a)) AS ingested`),
  ]);
  const n = now[0];
  const top10 = numOrNull(n?.top10);
  const pooled = numOrNull(n?.pooled);
  const total = numOrNull(n?.total);
  const c = cover[0];
  const anchorBlock = numOrNull(c?.anchor_block);
  const expected = anchorBlock !== null && launchBlock !== null ? Math.max(0, anchorBlock - launchBlock + 1) : null;
  const ingested = c ? num(c.ingested) : null;
  const share = (v: number | null) => (total !== null && total > 0 ? (v ?? 0) / total : null);
  return {
    // Holders count every address with a balance, pools included: a pool does hold the token.
    holders: num(n?.holders),
    // 0 for a token launched in the last 24 h: its whole holder count is growth.
    holders_24h_ago: num(before[0]?.holders),
    top10_share: top10 === null && (pooled ?? 0) === 0 ? null : share(top10),
    pool_share: ex.length ? share(pooled) : null,
    excluded: ex,
    complete: expected !== null && ingested !== null && expected > 0 && ingested === expected,
    blocks_ingested: ingested,
    blocks_expected: expected,
    basis: "token_transfers",
  };
}
