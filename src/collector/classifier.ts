import {
  APPROVE_SELECTORS,
  ARBSYS,
  BRIDGE_TX_TYPES,
  ENTRY_POINTS,
  KNOWN_CONTRACTS,
  PONS_FACTORY,
  SWAP_EVENT_TOPICS,
  SWAP_SELECTORS,
  TOPIC_TOKEN_LAUNCHED,
  TOPIC_TRANSFER,
  TOPIC_USER_OPERATION_EVENT,
} from "../../config/known-contracts.ts";
import type { Action, SubsidyClass } from "../db/schema.ts";

export type LogLike = { address: string; topics: readonly string[] };

export type TxFacts = {
  type: string;
  to: string | null;
  value: bigint;
  input: string;
  toIsContract: boolean;
  logs: readonly LogLike[];
};

const BRIDGE_ADDRESSES = new Set(KNOWN_CONTRACTS.filter((c) => c.kind === "bridge").map((c) => c.address.toLowerCase()));
const ZERO_TOPIC_ADDRESS = `0x${"0".repeat(64)}`;

const lower = (s: string | null) => (s === null ? null : s.toLowerCase());
const selectorOf = (input: string) => (input.length >= 10 ? input.slice(0, 10).toLowerCase() : null);

// ERC-20 Transfer has three topics; ERC-721 Transfer carries the token id as a fourth.
const isErc20Transfer = (log: LogLike) => log.topics[0]?.toLowerCase() === TOPIC_TRANSFER && log.topics.length === 3;

// Ordered rules from PROJECT.md 9.3; the first match wins.
export function classifyAction(tx: TxFacts): Action {
  const to = lower(tx.to);
  const topics0 = tx.logs.map((l) => l.topics[0]?.toLowerCase());
  const selector = selectorOf(tx.input);

  if (BRIDGE_TX_TYPES.has(tx.type) || (to !== null && BRIDGE_ADDRESSES.has(to)) || tx.logs.some((l) => BRIDGE_ADDRESSES.has(l.address.toLowerCase()))) {
    return "bridge";
  }
  if (tx.logs.some((l) => l.address.toLowerCase() === PONS_FACTORY && l.topics[0]?.toLowerCase() === TOPIC_TOKEN_LAUNCHED)) {
    return "launch";
  }
  if (topics0.some((t) => t !== undefined && SWAP_EVENT_TOPICS.has(t)) || (selector !== null && SWAP_SELECTORS.has(selector))) {
    return "swap";
  }
  if (tx.logs.some(isErc20Transfer)) return "erc20_transfer";
  if (tx.value > 0n && to !== null && !tx.toIsContract && (tx.input === "0x" || tx.input === "")) return "native_transfer";
  if (selector !== null && APPROVE_SELECTORS.has(selector)) return "approve";
  if (to !== null && tx.toIsContract) return "contract_call";
  return "other";
}

export type SubsidyFacts = { feeWei: bigint; gasUsed: bigint; logs: readonly LogLike[] };

// Heuristic from PROJECT.md 12.2; the UI must present the result as an estimate.
export function classifySubsidy(tx: SubsidyFacts): SubsidyClass {
  const sponsored = tx.logs.some(
    (l) =>
      ENTRY_POINTS.has(l.address.toLowerCase()) &&
      l.topics[0]?.toLowerCase() === TOPIC_USER_OPERATION_EVENT &&
      l.topics[3] !== undefined &&
      l.topics[3].toLowerCase() !== ZERO_TOPIC_ADDRESS,
  );
  if (sponsored) return "likely_subsidized";
  if (tx.gasUsed > 21_000n && tx.feeWei === 0n) return "likely_subsidized";
  if (tx.feeWei > 0n) return "likely_paid";
  return "unknown";
}
