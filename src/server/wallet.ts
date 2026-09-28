import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { EXPLORER_URL } from "../../config/known-contracts.ts";
import { formatFixed } from "../collector/fees.ts";
import type { Db } from "../db/client.ts";
import type { WalletProfile } from "../lib/api-types.ts";
import { actionLabel } from "../lib/city.ts";
import { iso, num, numOrNull, rows } from "./query.ts";
import { memoized, readClient } from "./rpc-read.ts";

// Wallet profile (PROJECT.md 15). Activity comes from the ingested blocks only and says so; balance, sent count and
// contract-or-EOA come from RPC. Counterparties are listed by count; the ego graph is Phase 9. No identity labels.

const RPC_TTL_MS = 60_000;

async function onChain(address: string) {
  return memoized(`wallet|${address}`, RPC_TTL_MS, async () => {
    const c = readClient();
    const [balance, nonce, code] = await Promise.all([
      c.getBalance({ address: address as Hex }),
      c.getTransactionCount({ address: address as Hex }),
      c.getCode({ address: address as Hex }),
    ]);
    return { balance_eth: formatFixed(balance, 18), sent_total: nonce, is_contract: (code ?? "0x") !== "0x" };
  });
}

export async function getWallet(db: Db, address: string): Promise<WalletProfile> {
  const [chain, span, actions, sent, hours, outbound, inbound, recent] = await Promise.all([
    onChain(address).catch(() => null),
    rows(db, sql`
      SELECT min(ts) AS first, max(ts) AS last, count(*) AS n FROM (
        SELECT ts FROM txs WHERE from_address = ${address} UNION ALL SELECT ts FROM txs WHERE to_address = ${address}) x`),
    rows(db, sql`SELECT action, count(*) AS n, sum(fee_usd) AS fee FROM txs WHERE from_address = ${address} GROUP BY 1 ORDER BY 2 DESC`),
    rows(db, sql`
      SELECT count(*) AS n, sum(fee_usd) AS fee, count(*) FILTER (WHERE subsidy_class = 'likely_paid') AS paid,
             count(*) FILTER (WHERE status = 0) AS failed
      FROM txs WHERE from_address = ${address}`),
    rows(db, sql`SELECT extract(hour FROM ts AT TIME ZONE 'UTC') AS h, count(*) AS n FROM txs WHERE from_address = ${address} GROUP BY 1`),
    rows(db, sql`
      SELECT to_address AS a, count(*) AS n FROM txs WHERE from_address = ${address} AND to_address IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`),
    rows(db, sql`SELECT from_address AS a, count(*) AS n FROM txs WHERE to_address = ${address} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`),
    rows(db, sql`
      SELECT hash, block, ts, action, fee_usd, status, from_address, to_address FROM txs
      WHERE from_address = ${address} OR to_address = ${address} ORDER BY ts DESC, hash LIMIT 10`),
  ]);
  const s = sent[0];
  const n = num(s?.n);
  const byHour = new Map(hours.map((x) => [num(x.h), num(x.n)]));
  return {
    address,
    explorer_url: `${EXPLORER_URL}/address/${address}`,
    chain: chain ? { ...chain, source: "rpc" } : null,
    ingested: {
      first_seen: iso(span[0]?.first),
      last_seen: iso(span[0]?.last),
      tx_count: num(span[0]?.n),
      sent: n,
      fee_paid_usd: numOrNull(s?.fee),
      paid_share: n > 0 ? num(s?.paid) / n : null,
      fail_rate: n > 0 ? num(s?.failed) / n : null,
      actions: actions.map((x) => ({ key: String(x.action), label: String(x.action) === "other" ? "Other" : actionLabel(String(x.action)), tx_count: num(x.n), fee_usd: numOrNull(x.fee) })),
      hours: Array.from({ length: 24 }, (_, h) => byHour.get(h) ?? 0),
      counterparties: {
        sent_to: outbound.map((x) => ({ address: String(x.a), tx_count: num(x.n) })),
        received_from: inbound.map((x) => ({ address: String(x.a), tx_count: num(x.n) })),
      },
      recent: recent.map((x) => ({
        hash: String(x.hash),
        block: num(x.block),
        ts: iso(x.ts) ?? "",
        action: String(x.action),
        fee_usd: num(x.fee_usd),
        status: num(x.status) === 1 ? "success" : "failed",
        direction: String(x.from_address) === address ? "out" : "in",
      })),
    },
    generated_at: new Date().toISOString(),
  };
}
