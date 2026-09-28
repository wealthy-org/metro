// Registry of contracts, event topics and selectors verified against live chain data.
// Only entries confirmed on chain 4663 belong here; unverified candidates stay out.
// Phase 0 report: project-context/plans/phase-0-data-verification.md; Phase 1 checks: phase-1-collector-db.md 7.6.

export type ContractKind = "router" | "pool" | "bridge" | "factory";

export type KnownContract = {
  address: `0x${string}`;
  kind: ContractKind;
  label: string;
  // topic0 hash -> event signature, resolved via the openchain.xyz signature database.
  events?: Record<`0x${string}`, string>;
};

export const CHAIN_ID = 4663;

export type RpcEndpoint = {
  url: string;
  // Accepts JSON-RPC batches of 10+ calls (drpc free and tatum reject batches; publicnode stalls on them).
  batch: boolean;
  // Primary endpoints receive a share of block fetches; the rest are only used as fallbacks.
  primary: boolean;
  // chainlist.org marks the provider as tracking requests.
  tracking?: boolean;
};

// All public RPCs listed for 4663 by ethereum-lists/chains and chainlist.org, probed 2026-09-27 (Phase 2 report 9).
// Order is the fallback order. Left out: lb.routeme.sh (HTTP 429, needs sign-up), rpc.nodeflare.app (HTTP 403).
export const RPC_POOL: readonly RpcEndpoint[] = [
  { url: "https://rpc.mainnet.chain.robinhood.com", batch: true, primary: true },
  { url: "https://rpc-robinhood.globalstake.io", batch: true, primary: true },
  { url: "https://rpc.ordofi.network", batch: true, primary: true },
  { url: "https://rpc-robinhood.blockmachine.io", batch: true, primary: true },
  { url: "https://robinhood.api.pocket.network", batch: true, primary: false }, // 20-call batch took 2.6 s
  { url: "https://robinhood.rpc.blxrbdn.com", batch: true, primary: false, tracking: true }, // 20-call batch took 2.9 s
  { url: "https://robinhood.drpc.org", batch: false, primary: false },
  { url: "https://robinhood-mainnet.gateway.tatum.io", batch: false, primary: false, tracking: true },
  { url: "https://robinhood-rpc.publicnode.com", batch: false, primary: false },
  // HTTP 530 on every probe so far; last resort only.
  { url: "https://rpc.arrowrpc.com", batch: false, primary: false },
];

// Blockscout API v2, the default for BLOCKSCOUT_API_URL (PROJECT.md 23). Blocked by a Cloudflare challenge for
// scripted requests on 2026-09-27, open again on 2026-09-28 (KL-3); src/collector/blockscout.ts guards every call.
export const BLOCKSCOUT_PUBLIC_API = "https://robinhoodchain.blockscout.com/api/v2";
// Explorer pages for people.
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

// PONS_FACTORY_ADDRESS (PROJECT.md 23), defaulting to the factory verified in Phase 0. A value that is not an
// address stops the process instead of silently watching the wrong contract. Stored lower-case, as RPC logs are.
const DEFAULT_PONS_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
function ponsFactory(): string {
  const raw = (typeof process === "undefined" ? undefined : process.env.PONS_FACTORY_ADDRESS)?.trim();
  if (!raw) return DEFAULT_PONS_FACTORY;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("PONS_FACTORY_ADDRESS must be a 0x-prefixed 20-byte address");
  return raw.toLowerCase();
}
export const PONS_FACTORY = ponsFactory();
export const TOPIC_TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";

// Nitro precompile for L2 -> L1 withdrawals (withdrawEth, sendTxToL1); eth_getCode returns 0xfe.
export const ARBSYS = "0x0000000000000000000000000000000000000064";
// Nitro deposit (0x64) and retryable-submission (0x69) transaction types, both L1 -> L2 bridge traffic.
// Defined by the Nitro protocol; none appeared in the 120-block sample, so this rule is not yet observed on 4663.
export const BRIDGE_TX_TYPES = new Set(["0x64", "0x69"]);

export const KNOWN_CONTRACTS: KnownContract[] = [
  {
    address: PONS_FACTORY as `0x${string}`,
    kind: "factory",
    label: "Pons token factory",
    events: {
      "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607": "TokenLaunched(address,address,address,address,uint256,uint256)",
      "0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980": "CreatorFeeRecipientUpdated(address,address,address)",
    },
  },
  { address: ARBSYS, kind: "bridge", label: "ArbSys precompile (L2 to L1)" },
  // Routers and pools are not listed by address: Pons curve pools are one per token, known by their CurveBuy and
  // CurveSell events below and by TokenLaunched topic2 (KL-5).
];

export const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Swap event signatures seen in sampled mainnet receipts on 2026-09-27.
export const SWAP_EVENT_TOPICS = new Set([
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", // Uniswap V2 Swap
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // Uniswap V3 Swap
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", // Uniswap V4 Swap
  // Pons curve pools (GeckoTerminal DEX "pons-v2"; each pool's factory() is PONS_FACTORY and it is the topic2 of its
  // token's TokenLaunched). Names from the openchain signature database; checked on buy 0x00da68bc… and sell
  // 0x8b81a175… on 2026-09-28 (KL-5, user decision 2026-09-28).
  "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455", // CurveBuy(address,address,uint256,uint256,uint256,uint256)
  "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df", // CurveSell(address,address,uint256,uint256,uint256,uint256)
]);

// Swap entry points seen in sampled mainnet transactions on 2026-09-27.
export const SWAP_SELECTORS = new Set([
  "0x04e45aaf", // exactInputSingle
  "0x3593564c", // Universal Router execute(bytes,bytes[],uint256)
  "0x24856bc3", // Universal Router execute(bytes,bytes[])
  "0x4d819a2a", // swap((...)[],address,uint256,uint256,uint256)
]);

export const APPROVE_SELECTORS = new Set([
  "0x095ea7b3", // approve(address,uint256)
  "0xa22cb465", // setApprovalForAll(address,bool)
]);

// ERC-4337 UserOperationEvent; topic3 is the paymaster (zero address when the sender pays).
export const TOPIC_USER_OPERATION_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
// Canonical EntryPoint deployments that emitted UserOperationEvent in the last 5,000 blocks on 2026-09-27.
export const ENTRY_POINTS = new Set([
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", // v0.6
  "0x0000000071727de22e5e9d8baf0edac6f37da032", // v0.7
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", // v0.8
]);
