import { describe, expect, it } from "vitest";
import {
  ARBSYS,
  PONS_FACTORY,
  TOPIC_TOKEN_LAUNCHED,
  TOPIC_TRANSFER,
  TOPIC_USER_OPERATION_EVENT,
} from "../../config/known-contracts.ts";
import { classifyAction, classifySubsidy, type TxFacts } from "./classifier.ts";

const EOA = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const pad = (addr: string) => `0x${addr.slice(2).padStart(64, "0")}`;
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

const erc20Transfer = { address: TOKEN, topics: [TOPIC_TRANSFER, pad(EOA), pad(CONTRACT)] };

function tx(overrides: Partial<TxFacts>): TxFacts {
  return { type: "0x2", to: CONTRACT, value: 0n, input: "0x", toIsContract: true, logs: [], ...overrides };
}

describe("classifyAction (PROJECT.md 9.3)", () => {
  it("bridge: call to the ArbSys precompile", () => {
    expect(classifyAction(tx({ to: ARBSYS, input: "0x25e16063", value: 10n ** 16n }))).toBe("bridge");
  });

  it("bridge: Nitro deposit transaction type", () => {
    expect(classifyAction(tx({ type: "0x64", to: EOA, toIsContract: false, value: 1n }))).toBe("bridge");
  });

  it("launch: TokenLaunched from the Pons factory wins over transfer and swap logs", () => {
    const logs = [erc20Transfer, { address: PONS_FACTORY, topics: [TOPIC_TOKEN_LAUNCHED, pad(TOKEN), pad(CONTRACT), pad(EOA)] }];
    expect(classifyAction(tx({ input: "0xdeadbeef", logs }))).toBe("launch");
  });

  it("launch: the same event from another address is not a launch", () => {
    const logs = [{ address: CONTRACT, topics: [TOPIC_TOKEN_LAUNCHED, pad(TOKEN), pad(CONTRACT), pad(EOA)] }];
    expect(classifyAction(tx({ input: "0xdeadbeef", logs }))).toBe("contract_call");
  });

  it("swap: Uniswap V3 Swap event, even with token transfers", () => {
    const logs = [erc20Transfer, { address: CONTRACT, topics: [V3_SWAP, pad(EOA), pad(EOA)] }];
    expect(classifyAction(tx({ input: "0xac9650d8", logs }))).toBe("swap");
  });

  it("swap: known swap selector without a swap event", () => {
    expect(classifyAction(tx({ input: "0x3593564c0000" }))).toBe("swap");
  });

  it("erc20_transfer: Transfer with three topics and no swap", () => {
    expect(classifyAction(tx({ to: TOKEN, input: "0xa9059cbb", logs: [erc20Transfer] }))).toBe("erc20_transfer");
  });

  it("an ERC-721 Transfer (four topics) is not an ERC-20 transfer", () => {
    const nft = { address: TOKEN, topics: [TOPIC_TRANSFER, pad(EOA), pad(CONTRACT), pad("0x05")] };
    expect(classifyAction(tx({ to: TOKEN, input: "0x23b872dd", logs: [nft] }))).toBe("contract_call");
  });

  it("native_transfer: value to an EOA with empty input", () => {
    expect(classifyAction(tx({ to: EOA, toIsContract: false, value: 5n }))).toBe("native_transfer");
  });

  it("value sent to a contract with empty input is a contract call", () => {
    expect(classifyAction(tx({ value: 5n }))).toBe("contract_call");
  });

  it("approve: approve selector", () => {
    const logs = [{ address: TOKEN, topics: [APPROVAL, pad(EOA), pad(CONTRACT)] }];
    expect(classifyAction(tx({ to: TOKEN, input: "0x095ea7b3", logs }))).toBe("approve");
  });

  it("approve: setApprovalForAll selector", () => {
    expect(classifyAction(tx({ to: TOKEN, input: "0xa22cb465" }))).toBe("approve");
  });

  it("contract_call: unknown selector on a contract", () => {
    expect(classifyAction(tx({ input: "0x12345678" }))).toBe("contract_call");
  });

  it("other: contract creation", () => {
    expect(classifyAction(tx({ to: null, toIsContract: false, input: "0x6080" }))).toBe("other");
  });

  it("other: zero-value call to an EOA", () => {
    expect(classifyAction(tx({ to: EOA, toIsContract: false }))).toBe("other");
  });
});

describe("classifySubsidy (PROJECT.md 12.2)", () => {
  const ENTRY_POINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
  const userOp = (address: string, paymaster: string) => ({
    address,
    topics: [TOPIC_USER_OPERATION_EVENT, pad("0x01"), pad(EOA), pad(paymaster)],
  });

  it("likely_subsidized: user operation with a paymaster", () => {
    expect(classifySubsidy({ feeWei: 10n, gasUsed: 90_000n, logs: [userOp(ENTRY_POINT_V07, CONTRACT)] })).toBe("likely_subsidized");
  });

  it("likely_paid: user operation without a paymaster", () => {
    expect(classifySubsidy({ feeWei: 10n, gasUsed: 90_000n, logs: [userOp(ENTRY_POINT_V07, "0x00")] })).toBe("likely_paid");
  });

  it("ignores UserOperationEvent emitted by a non-EntryPoint address", () => {
    expect(classifySubsidy({ feeWei: 10n, gasUsed: 90_000n, logs: [userOp(CONTRACT, CONTRACT)] })).toBe("likely_paid");
  });

  it("likely_subsidized: zero fee with significant gas", () => {
    expect(classifySubsidy({ feeWei: 0n, gasUsed: 50_000n, logs: [] })).toBe("likely_subsidized");
  });

  it("unknown: zero fee and negligible gas", () => {
    expect(classifySubsidy({ feeWei: 0n, gasUsed: 21_000n, logs: [] })).toBe("unknown");
  });

  it("likely_paid: any positive fee", () => {
    expect(classifySubsidy({ feeWei: 1n, gasUsed: 21_000n, logs: [] })).toBe("likely_paid");
  });
});
