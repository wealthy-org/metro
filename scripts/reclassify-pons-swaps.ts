// KL-5 (user decision 2026-09-28): re-classify ingested transactions that traded on a Pons curve pool. Before the
// CurveBuy and CurveSell events were known to the classifier, such trades were stored as erc20_transfer or
// contract_call. This script re-reads the receipts of the candidates over RPC, runs the Collector's classifier again,
// and keeps a new `swap` only when the event comes from a pool whose factory() is the Pons factory.
//
//   node --env-file=.env scripts/reclassify-pons-swaps.ts           dry run: lists what would change
//   node --env-file=.env scripts/reclassify-pons-swaps.ts --apply   writes txs.action and rebuilds the rollups
//
// With --apply, one database transaction updates `txs.action`, deletes the agg_minute and agg_day rows of every
// touched minute and day, and rebuilds them from txs (PROJECT.md 9.1 step 5), so no stale action row is left behind.

import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { PONS_FACTORY } from "../config/known-contracts.ts";
import { classifyAction } from "../src/collector/classifier.ts";
import { rollupDays, rollupMinutes } from "../src/collector/rollup.ts";
import { createRpcClient } from "../src/collector/rpc.ts";
import { createDb, type Db } from "../src/db/client.ts";

const CURVE_TOPICS = new Set(["0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455", "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df"]);
const FACTORY_SELECTOR = "0xc45a0155";
const apply = process.argv.includes("--apply");

const client = createRpcClient();
const { db, pool } = createDb(process.env.DATABASE_URL, 2);
const poolFactory = new Map<string, string | null>();

async function isPonsPool(address: string): Promise<boolean> {
  if (!poolFactory.has(address)) {
    const r = await client.call({ to: address as Hex, data: FACTORY_SELECTOR }).catch(() => null);
    poolFactory.set(address, r?.data && r.data.length === 66 ? `0x${r.data.slice(26)}`.toLowerCase() : null);
  }
  return poolFactory.get(address) === PONS_FACTORY;
}

type Change = { hash: string; ts: Date; from: string; to: string };

async function main() {
  // Candidates: not already swap, launch or bridge, and moved a Pons token (every curve trade moves its token).
  const res = await db.execute(sql`
    SELECT DISTINCT t.hash, t.ts, t.action
    FROM txs t JOIN token_transfers tt ON tt.tx_hash = t.hash AND tt.ts = t.ts JOIN tokens k ON k.address = tt.token_address AND k.is_pons
    WHERE t.action NOT IN ('swap', 'launch', 'bridge')
    ORDER BY t.ts`);
  const candidates = res.rows as { hash: string; ts: Date | string; action: string }[];
  console.log(`${candidates.length} candidate transaction(s) that moved a Pons token and are not swap, launch or bridge.`);

  const changes: Change[] = [];
  let unverified = 0;
  for (const c of candidates) {
    const hash = c.hash as Hex;
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    const logs = receipt.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()) }));
    const curve = logs.filter((l) => CURVE_TOPICS.has(l.topics[0] ?? ""));
    if (!curve.length) continue;
    const verified = (await Promise.all(curve.map((l) => isPonsPool(l.address)))).every(Boolean);
    if (!verified) {
      unverified += 1;
      console.log(`SKIP ${c.hash}: a curve event comes from a contract that is not a Pons pool`);
      continue;
    }
    const to = tx.to?.toLowerCase() ?? null;
    const code = to ? await client.getCode({ address: to as Hex }).catch(() => "0x") : "0x";
    const action = classifyAction({ type: (tx.typeHex ?? "").toLowerCase(), to, value: tx.value, input: tx.input, toIsContract: (code ?? "0x") !== "0x", logs });
    if (action !== c.action) changes.push({ hash: c.hash, ts: new Date(c.ts), from: c.action, to: action });
  }

  const byPair = new Map<string, number>();
  for (const ch of changes) byPair.set(`${ch.from} -> ${ch.to}`, (byPair.get(`${ch.from} -> ${ch.to}`) ?? 0) + 1);
  console.log(`${changes.length} transaction(s) change:`, Object.fromEntries(byPair), unverified ? `(${unverified} skipped, unverified pool)` : "");
  if (changes.some((c) => c.to !== "swap")) console.log("Warning: some changes are not to swap; check them before applying.");
  if (!apply || !changes.length) {
    console.log(apply ? "Nothing to write." : "Dry run: nothing written. Run with --apply to write.");
    return;
  }

  const minutes = [...new Set(changes.map((c) => Math.floor(c.ts.getTime() / 60_000) * 60_000))].sort((a, b) => a - b);
  const days = [...new Set(changes.map((c) => c.ts.toISOString().slice(0, 10)))];
  await db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    for (const ch of changes) await t.execute(sql`UPDATE txs SET action = ${ch.to} WHERE hash = ${ch.hash} AND ts = ${ch.ts}`);
    for (const m of minutes) {
      const at = new Date(m);
      await t.execute(sql`DELETE FROM agg_minute WHERE ts = ${at}`);
      await rollupMinutes(t, at, at);
    }
    for (const d of days) await t.execute(sql`DELETE FROM agg_day WHERE date = ${d}::date`);
    await rollupDays(t, days);
  });
  console.log(`Written: ${changes.length} txs, ${minutes.length} minute rollup(s) and ${days.length} day rollup(s) rebuilt.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
