import { erc20Abi, getAddress, type Hex } from "viem";
import { PONS_FACTORY, TOPIC_TOKEN_LAUNCHED, TOPIC_TRANSFER } from "../../config/known-contracts.ts";
import type { blocks, ponsLaunches, tokens, tokenTransfers, txs } from "../db/schema.ts";
import { classifyAction, classifySubsidy } from "./classifier.ts";
import { feeEth, feeUsd } from "./fees.ts";
import type { PriceSource } from "./price.ts";
import type { RpcClient } from "./rpc.ts";

export type BlockBundle = {
  block: typeof blocks.$inferInsert;
  txs: (typeof txs.$inferInsert)[];
  transfers: (typeof tokenTransfers.$inferInsert)[];
  tokens: (typeof tokens.$inferInsert)[];
  launches: (typeof ponsLaunches.$inferInsert)[];
};

const CODE_CACHE_LIMIT = 100_000;
const codeCache = new Map<string, boolean>();

const topicAddress = (topic: string | undefined) => (topic ? getAddress(`0x${topic.slice(26)}`).toLowerCase() : null);

async function contractFlags(client: RpcClient, addresses: string[]): Promise<Map<string, boolean>> {
  const missing = [...new Set(addresses)].filter((a) => !codeCache.has(a));
  const codes = await Promise.all(missing.map((address) => client.getCode({ address: address as Hex })));
  if (codeCache.size + missing.length > CODE_CACHE_LIMIT) codeCache.clear();
  missing.forEach((a, i) => codeCache.set(a, (codes[i] ?? "0x") !== "0x"));
  return new Map(addresses.map((a) => [a, codeCache.get(a) ?? false]));
}

async function tokenMetadata(client: RpcClient, address: string) {
  const [name, symbol, decimals] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: address as Hex, abi: erc20Abi, functionName: "name" },
      { address: address as Hex, abi: erc20Abi, functionName: "symbol" },
      { address: address as Hex, abi: erc20Abi, functionName: "decimals" },
    ],
  });
  return {
    name: name.status === "success" ? name.result.slice(0, 128) : null,
    symbol: symbol.status === "success" ? symbol.result.slice(0, 32) : null,
    decimals: decimals.status === "success" ? decimals.result : 18,
  };
}

export async function fetchBlockBundle(client: RpcClient, prices: PriceSource, number: bigint): Promise<BlockBundle> {
  const [block, receipts] = await Promise.all([
    client.getBlock({ blockNumber: number, includeTransactions: true }),
    client.getBlockReceipts({ blockNumber: number }),
  ]);
  const ts = new Date(Number(block.timestamp) * 1000);
  const receiptByHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
  // Every transaction of the block is stored (PROJECT.md 9.1), including the ArbOS internal one (type 0x6a).
  const isContract = await contractFlags(
    client,
    block.transactions.flatMap((t) => (t.to ? [t.to.toLowerCase()] : [])),
  );
  const ethUsd = block.transactions.length > 0 ? await prices.priceAt(ts) : null;

  const bundle: BlockBundle = {
    block: {
      number: Number(block.number),
      hash: block.hash.toLowerCase(),
      ts,
      gasUsed: block.gasUsed.toString(),
      gasLimit: block.gasLimit.toString(),
      baseFee: block.baseFeePerGas?.toString() ?? null,
      txCount: block.transactions.length,
    },
    txs: [],
    transfers: [],
    tokens: [],
    launches: [],
  };

  for (const tx of block.transactions) {
    const receipt = receiptByHash.get(tx.hash.toLowerCase());
    if (!receipt) throw new Error(`Missing receipt for ${tx.hash} in block ${number}`);
    const to = tx.to?.toLowerCase() ?? null;
    const logs = receipt.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data, logIndex: l.logIndex }));
    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;

    bundle.txs.push({
      hash: tx.hash.toLowerCase(),
      block: Number(block.number),
      ts,
      fromAddress: tx.from.toLowerCase(),
      toAddress: to,
      value: tx.value.toString(),
      gasUsed: receipt.gasUsed.toString(),
      gasPrice: receipt.effectiveGasPrice.toString(),
      feeEth: feeEth(feeWei),
      feeUsd: feeUsd(feeWei, ethUsd ?? "0"),
      status: receipt.status === "success" ? 1 : 0,
      method: tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null,
      action: classifyAction({
        type: (tx.typeHex ?? "").toLowerCase(),
        to,
        value: tx.value,
        input: tx.input,
        toIsContract: to !== null && (isContract.get(to) ?? false),
        logs,
      }),
      subsidyClass: classifySubsidy({ feeWei, gasUsed: receipt.gasUsed, logs }),
    });

    for (const log of logs) {
      const topic0 = log.topics[0];
      if (topic0 === TOPIC_TRANSFER && log.topics.length === 3 && log.data.length === 66) {
        bundle.transfers.push({
          txHash: tx.hash.toLowerCase(),
          logIndex: log.logIndex,
          tokenAddress: log.address,
          fromAddress: topicAddress(log.topics[1]) ?? "",
          toAddress: topicAddress(log.topics[2]) ?? "",
          amount: BigInt(log.data).toString(),
          ts,
        });
      }
      if (log.address === PONS_FACTORY && topic0 === TOPIC_TOKEN_LAUNCHED) {
        // topic1 is the token and topic3 the creator (checked against tx.from on 2026-09-27).
        const token = topicAddress(log.topics[1]);
        const creator = topicAddress(log.topics[3]);
        if (!token || !creator) continue;
        bundle.tokens.push({ address: token, isPons: true, createdAt: ts, ...(await tokenMetadata(client, token)) });
        bundle.launches.push({
          tokenAddress: token,
          creatorAddress: creator,
          block: Number(block.number),
          ts,
          params: { topic2: topicAddress(log.topics[2]), data: log.data, txHash: tx.hash.toLowerCase() },
        });
      }
    }
  }
  return bundle;
}
