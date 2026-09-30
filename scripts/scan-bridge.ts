// KL-14 check (read-only): look for real bridge traffic on Robinhood Chain (4663), so the bridge classifier rule can
// be validated or the limitation recorded as "no example found". Nothing is written: the classifier check uses a stub
// price source, because the classified action does not depend on the USD fee.
//
//   1) ArbSys logs over the last N days, in chunks: L2 -> L1 withdrawals emit events from the ArbSys precompile,
//      which is the only address registered as kind "bridge" in KNOWN_CONTRACTS.
//   2) Random blocks with full transactions over the same window: Nitro deposit (0x64) and retryable-submission
//      (0x69) transaction types, plus any transaction sent to ArbSys.
//   3) If an example is found, the block goes through the Collector's own fetcher and classifier to confirm the
//      transaction really classifies as "bridge".
//
//   node scripts/scan-bridge.ts [--days=7] [--blocks=2000] [--log-chunk=10000]
import { keccak256, toHex } from "viem";
import { ARBSYS } from "../config/known-contracts.ts";
import { fetchBlockBundle } from "../src/collector/ingest.ts";
import type { PriceSource } from "../src/collector/price.ts";
import { RpcPool } from "../src/collector/rpc.ts";

const arg = (name: string, fallback: number, max: number) => {
  const v = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} must be 1 to ${max}`);
  return n;
};

const days = arg("days", 7, 90);
const blockSamples = arg("blocks", 2000, 50_000);
const logChunk = arg("log-chunk", 10_000, 100_000);
const hex = (n: bigint | number): `0x${string}` => `0x${BigInt(n).toString(16)}` as `0x${string}`;

const rpc = new RpcPool();
const headBlock = await rpc.head.getBlock();
const head = headBlock.number;
const span = BigInt(days) * 86_400n * 10n; // about 10 blocks a second
const from = head > span ? head - span : 0n;
console.log(JSON.stringify({ head: Number(head), from: Number(from), days, blockSamples, logChunk }));

// 1) ArbSys logs (L2 -> L1 withdrawals).
let logsFound = 0;
let firstLog: { block: number; txHash: string; topic0: string } | null = null;
for (let start = from; start <= head && logsFound === 0; start += BigInt(logChunk)) {
  const end = start + BigInt(logChunk) - 1n > head ? head : start + BigInt(logChunk) - 1n;
  try {
    const logs = (await rpc.head.request({ method: "eth_getLogs", params: [{ address: ARBSYS, fromBlock: hex(start), toBlock: hex(end) }] })) as unknown[];
    if (Array.isArray(logs) && logs.length > 0) {
      logsFound = logs.length;
      const l = logs[0] as { blockNumber?: string; transactionHash?: string; topics?: string[] };
      firstLog = { block: Number(BigInt(l.blockNumber ?? "0x0")), txHash: String(l.transactionHash ?? ""), topic0: String(l.topics?.[0] ?? "") };
      break;
    }
  } catch (err) {
    console.log(JSON.stringify({ log_chunk_failed: Number(start), error: String(err).slice(0, 80) }));
  }
}
console.log(JSON.stringify({ arbsys_logs_found: logsFound, first_log: firstLog }));

// 2) Random blocks with full transactions (deposits 0x64/0x69, or txs to ArbSys).
const rand = (() => {
  let h = 123456789;
  return () => {
    h = (Math.imul(h ^ (h >>> 15), 2246822507) + 1013904223) | 0;
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  };
})();
const picks: bigint[] = [];
const width = head - from;
for (let i = 0; i < blockSamples; i++) picks.push(from + BigInt(Math.floor(rand() * Number(width))));
let depositHits = 0;
let arbsysTxHits = 0;
let firstTx: { block: number; hash: string; type: string; to: string | null; reason: "type" | "to" } | null = null;
let scanned = 0;
for (let i = 0; i < picks.length; i += 8) {
  const chunk = picks.slice(i, i + 8);
  const blocks = await Promise.all(
    chunk.map((n) =>
      rpc.forBlock(n)
        .request({ method: "eth_getBlockByNumber", params: [hex(n), true] })
        .catch(() => null),
    ),
  );
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    scanned++;
    const block = b as { number?: string; transactions?: { hash?: string; type?: string; to?: string | null }[] };
    for (const tx of block.transactions ?? []) {
      const type = String(tx.type ?? "").toLowerCase();
      const to = tx.to ? tx.to.toLowerCase() : null;
      if (type === "0x64" || type === "0x69") {
        depositHits++;
        firstTx ??= { block: Number(BigInt(block.number ?? "0x0")), hash: String(tx.hash ?? ""), type, to, reason: "type" };
      } else if (to === ARBSYS.toLowerCase()) {
        arbsysTxHits++;
        firstTx ??= { block: Number(BigInt(block.number ?? "0x0")), hash: String(tx.hash ?? ""), type, to, reason: "to" };
      }
    }
  }
}
console.log(JSON.stringify({ blocks_scanned: scanned, deposit_hits: depositHits, arbsys_tx_hits: arbsysTxHits, first_tx: firstTx }));

// 3) Verify through the Collector's own classifier when an example exists.
const EVENT_CANDIDATES = [
  "L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)",
  "L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,bytes)",
  "L2ToL1Transaction(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)",
];
const eventName = firstLog ? (EVENT_CANDIDATES.find((c) => keccak256(toHex(c)) === firstLog?.topic0) ?? null) : null;
const example = firstTx ?? (firstLog ? { block: firstLog.block, hash: firstLog.txHash } : null);
if (example !== null) {
  const prices: PriceSource = { priceAt: async () => "0" };
  const bundle = await fetchBlockBundle(rpc.head, prices, BigInt(example.block));
  const tx = bundle.txs.find((t) => t.hash.toLowerCase() === example.hash.toLowerCase());
  console.log(JSON.stringify({ example_source: firstTx ? "block-scan" : "arbsys-log", event_name: eventName, verify_block: example.block, block_ts: bundle.block.ts.toISOString(), tx_found: Boolean(tx), classified_action: tx?.action ?? null }));
} else {
  console.log(JSON.stringify({ example_source: null, note: "no bridge example found in the scanned window; record option (a) with the stated coverage" }));
}
