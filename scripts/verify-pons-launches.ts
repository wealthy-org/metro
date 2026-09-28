// KL-13 check (Phase 6 plan 3.8): the Collector decodes the Pons factory's TokenLaunched event as topic1 = token,
// topic2 = the token's curve pool and topic3 = creator. This script scans the factory logs of the newest blocks and
// checks, for every launch, that topic1 is a contract that answers ERC-20 symbol(), that topic2 answers factory()
// with the Pons factory (the pool left out of the top-10 share, KL-25), and that topic3 is the launching account:
// either the sender of the transaction (an EOA launch), a smart account (it has code) that the transaction calls
// directly or names in its calldata, as a Safe execTransaction or an ERC-4337 handleOps does, with a relayer or
// bundler as the sender, or a contract created by the same transaction that launches from its constructor (both
// seen on 2026-09-28). Read-only; nothing is written.
//
//   node --env-file=.env scripts/verify-pons-launches.ts [--blocks 50000]
//
// Exits with code 1 when any launch fails a check, or when no launch was found (nothing was verified).

import { erc20Abi, type Hex } from "viem";
import { PONS_FACTORY, TOPIC_TOKEN_LAUNCHED } from "../config/known-contracts.ts";
import { createRpcClient } from "../src/collector/rpc.ts";

const CHUNK_BLOCKS = 10_000n;
const arg = process.argv.indexOf("--blocks");
const SPAN = BigInt(arg > 0 ? Number(process.argv[arg + 1] ?? 50_000) : 50_000);

const client = createRpcClient();
const topicAddress = (t: string | undefined) => (t && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);

type Launcher = "eoa" | "smart_account" | "new_contract" | null;
type Check = { tx: string; block: bigint; token: string | null; creator: string | null; symbol: string | null; launcher: Launcher; ok: boolean; reason: string };

async function main() {
  const head = await client.getBlockNumber();
  const from = head > SPAN ? head - SPAN + 1n : 0n;
  console.log(`Scanning factory ${PONS_FACTORY} for TokenLaunched in blocks ${from}..${head} (${SPAN} blocks)`);

  const logs: { tx: string; block: bigint; topics: readonly string[] }[] = [];
  for (let start = from; start <= head; start += CHUNK_BLOCKS) {
    const end = start + CHUNK_BLOCKS - 1n > head ? head : start + CHUNK_BLOCKS - 1n;
    const chunk = await client.request({
      method: "eth_getLogs",
      params: [{ address: PONS_FACTORY as Hex, topics: [TOPIC_TOKEN_LAUNCHED as Hex], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }],
    });
    for (const l of chunk) logs.push({ tx: l.transactionHash ?? "", block: BigInt(l.blockNumber ?? "0x0"), topics: l.topics.map((t) => t.toLowerCase()) });
  }
  console.log(`Found ${logs.length} TokenLaunched log(s).`);

  const checks: Check[] = [];
  // factory() on the curve pool (gate KL-25: the top-10 share leaves this pool out).
  const FACTORY_SELECTOR = "0xc45a0155";
  for (const l of logs) {
    const token = topicAddress(l.topics[1]);
    const pool = topicAddress(l.topics[2]);
    const creator = topicAddress(l.topics[3]);
    const [code, symbol, tx, poolFactory] = await Promise.all([
      token ? client.getCode({ address: token as Hex }).catch(() => undefined) : Promise.resolve(undefined),
      token ? client.readContract({ address: token as Hex, abi: erc20Abi, functionName: "symbol" }).catch(() => null) : Promise.resolve(null),
      client.getTransaction({ hash: l.tx as Hex }).catch(() => null),
      pool ? client.call({ to: pool as Hex, data: FACTORY_SELECTOR }).then((r) => topicAddress(r.data)).catch(() => null) : Promise.resolve(null),
    ]);
    const isContract = (code ?? "0x") !== "0x";
    const sender = tx?.from.toLowerCase() ?? null;
    let launcher: Launcher = null;
    if (creator && sender === creator) launcher = "eoa";
    else if (creator && tx && tx.to === null) {
      // A contract-creation transaction whose new contract launches the token from its constructor (seen 2026-09-28).
      const receipt = await client.getTransactionReceipt({ hash: l.tx as Hex }).catch(() => null);
      if (receipt?.contractAddress?.toLowerCase() === creator) launcher = "new_contract";
    } else if (creator && tx) {
      const creatorCode = await client.getCode({ address: creator as Hex }).catch(() => undefined);
      const named = tx.to?.toLowerCase() === creator || tx.input.toLowerCase().includes(creator.slice(2));
      if ((creatorCode ?? "0x") !== "0x" && named) launcher = "smart_account";
    }
    const reasons = [
      token ? null : "topic1 is not an address",
      creator ? null : "topic3 is not an address",
      isContract ? null : "topic1 has no code",
      symbol !== null ? null : "topic1 does not answer symbol()",
      launcher ? null : `topic3 ${creator} is not tx.from ${sender}, a smart account the transaction calls, or the contract it creates`,
      poolFactory === PONS_FACTORY ? null : `topic2 ${pool} is not a pool of the Pons factory (factory() = ${poolFactory})`,
    ].filter((r): r is string => r !== null);
    checks.push({ tx: l.tx, block: l.block, token, creator, symbol, launcher, ok: reasons.length === 0, reason: reasons.join("; ") });
  }

  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  block ${c.block}  token ${c.token} (${c.symbol ?? "?"})  creator ${c.creator}${c.launcher === "smart_account" ? " [smart account]" : ""}${c.ok ? "" : `  -> ${c.reason}`}`);
  const passed = checks.filter((c) => c.ok).length;
  const smart = checks.filter((c) => c.launcher === "smart_account").length;
  const created = checks.filter((c) => c.launcher === "new_contract").length;
  const rate = checks.length ? (passed / checks.length) * 100 : 0;
  console.log(`\n${passed} of ${checks.length} launches match (${rate.toFixed(1)}%); ${smart} from a smart account through a relayer or bundler, ${created} by a contract created in the same transaction.`);
  if (!checks.length) console.log("No launch in the scanned span: widen it with --blocks.");
  process.exit(checks.length > 0 && passed === checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
