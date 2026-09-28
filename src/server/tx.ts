import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { EXPLORER_URL } from "../../config/known-contracts.ts";
import { classifyAction, classifySubsidy } from "../collector/classifier.ts";
import { feeEth, formatFixed } from "../collector/fees.ts";
import type { Db } from "../db/client.ts";
import type { TxDetail } from "../lib/api-types.ts";
import { actionLabel } from "../lib/city.ts";
import { toIsoMinute } from "../lib/view-state.ts";
import { iso, num, numOrNull, rows } from "./query.ts";
import { currentEthUsd } from "./live.ts";
import { readClient } from "./rpc-read.ts";

// Transaction page (PROJECT.md 7: detail and its position in the lenses). Ingested transactions come from `txs` and
// `token_transfers`; any other hash is read from RPC and labeled as not ingested (Phase 6 D5). Its classification
// is computed on the fly with the Collector's rules and is not stored; its USD fee uses the current ETH quote, as
// the live Flow does, since no price is stored for its minute.

function positions(action: string, ts: string) {
  const minute = toIsoMinute(Date.parse(ts));
  const hour = `${ts.slice(0, 13)}:00Z`;
  return [
    { lens: "City", href: `/lens/city?window=1h&at=${minute}${action !== "other" ? `&sel=action:${action}` : ""}` },
    { lens: "Heatmap", href: `/lens/heatmap?window=7d&sel=hour:${hour}&at=${minute}` },
    { lens: "Flow", href: `/lens/flow?at=${minute}` },
  ];
}

async function fromDb(db: Db, hash: string): Promise<TxDetail | null> {
  const [t] = await rows(db, sql`SELECT * FROM txs WHERE hash = ${hash} LIMIT 1`);
  if (!t) return null;
  const transfers = await rows(db, sql`
    SELECT tt.log_index, tt.token_address, tt.from_address, tt.to_address, tt.amount, k.symbol, k.decimals, k.is_pons
    FROM token_transfers tt LEFT JOIN tokens k ON k.address = tt.token_address
    WHERE tt.tx_hash = ${hash} ORDER BY tt.log_index`);
  const ts = iso(t.ts) ?? "";
  const action = String(t.action);
  return {
    hash,
    source: "ingested",
    block: num(t.block),
    ts,
    from: String(t.from_address),
    to: t.to_address === null ? null : String(t.to_address),
    value_eth: formatFixed(BigInt(String(t.value)), 18),
    gas_used: String(t.gas_used),
    gas_price_wei: String(t.gas_price),
    fee_eth: String(t.fee_eth),
    fee_usd: numOrNull(t.fee_usd),
    fee_usd_basis: t.fee_usd === null ? null : "minute",
    status: num(t.status) === 1 ? "success" : "failed",
    method: t.method === null ? null : String(t.method),
    action,
    action_label: action === "other" ? "Other" : actionLabel(action),
    subsidy_class: String(t.subsidy_class),
    transfers: transfers.map((x) => ({
      log_index: num(x.log_index),
      token: String(x.token_address),
      symbol: x.symbol === null ? null : String(x.symbol),
      is_pons: Boolean(x.is_pons),
      from: String(x.from_address),
      to: String(x.to_address),
      // Decimals are known only for tokens Metro stores (Pons); others show the raw amount.
      amount: x.decimals === null ? String(x.amount) : formatFixed(BigInt(String(x.amount)), num(x.decimals)),
      amount_is_raw: x.decimals === null,
    })),
    positions: positions(action, ts),
    explorer_url: `${EXPLORER_URL}/tx/${hash}`,
  };
}

async function fromRpc(hash: string): Promise<TxDetail | null> {
  const c = readClient();
  const tx = await c.getTransaction({ hash: hash as Hex }).catch(() => null);
  if (!tx || tx.blockNumber === null) return null;
  const [receipt, block] = await Promise.all([c.getTransactionReceipt({ hash: hash as Hex }), c.getBlock({ blockNumber: tx.blockNumber })]);
  const to = tx.to?.toLowerCase() ?? null;
  const code = to ? await c.getCode({ address: to as Hex }).catch(() => "0x") : "0x";
  const logs = receipt.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics.map((x) => x.toLowerCase()) }));
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const action = classifyAction({ type: (tx.typeHex ?? "").toLowerCase(), to, value: tx.value, input: tx.input, toIsContract: (code ?? "0x") !== "0x", logs });
  const ts = new Date(Number(block.timestamp) * 1000).toISOString();
  const fee = feeEth(feeWei);
  // The live Flow prices fees at the current ETH quote; the same quote here keeps a clicked particle's fee equal.
  const ethUsd = await currentEthUsd().catch(() => null);
  return {
    hash,
    source: "rpc",
    block: Number(tx.blockNumber),
    ts,
    from: tx.from.toLowerCase(),
    to,
    value_eth: formatFixed(tx.value, 18),
    gas_used: receipt.gasUsed.toString(),
    gas_price_wei: receipt.effectiveGasPrice.toString(),
    fee_eth: fee,
    fee_usd: ethUsd === null ? null : Number(fee) * Number(ethUsd),
    fee_usd_basis: ethUsd === null ? null : "current",
    status: receipt.status === "success" ? "success" : "failed",
    method: tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null,
    action,
    action_label: action === "other" ? "Other" : actionLabel(action),
    subsidy_class: classifySubsidy({ feeWei, gasUsed: receipt.gasUsed, logs }),
    transfers: receipt.logs
      .filter((l) => l.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && l.topics.length === 3 && l.data.length === 66)
      .map((l) => ({
        log_index: l.logIndex,
        token: l.address.toLowerCase(),
        symbol: null,
        is_pons: false,
        from: `0x${(l.topics[1] ?? "").slice(26)}`,
        to: `0x${(l.topics[2] ?? "").slice(26)}`,
        amount: BigInt(l.data).toString(),
        amount_is_raw: true,
      })),
    positions: positions(action, ts),
    explorer_url: `${EXPLORER_URL}/tx/${hash}`,
  };
}

// Returns null when the hash is neither ingested nor known to the chain.
export async function getTx(db: Db, hash: string): Promise<TxDetail | null> {
  return (await fromDb(db, hash)) ?? (await fromRpc(hash));
}
