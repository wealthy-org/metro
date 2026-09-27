// Registry of contracts and endpoints verified in Phase 0 (2026-09-27).
// Only entries confirmed against live chain data belong here; unverified candidates stay out.
// Phase 0 report: project-context/plans/phase-0-data-verification.md

export type ContractKind = "router" | "pool" | "bridge" | "factory";

export type KnownContract = {
  address: `0x${string}`;
  kind: ContractKind;
  label: string;
  // topic0 hash -> event signature, resolved via the openchain.xyz signature database.
  events?: Record<`0x${string}`, string>;
};

export const CHAIN_ID = 4663;

// Order is the fallback order. Four of the five answered eth_chainId = 4663 on 2026-09-27;
// arrowrpc returned HTTP 530 and is kept last so it is only tried when the others fail.
export const RPC_POOL = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood.drpc.org",
  "https://rpc.ordofi.network",
  "https://rpc.arrowrpc.com",
] as const;

// The public host robinhoodchain.blockscout.com sits behind a Cloudflare challenge; the PRO API needs a key.
export const BLOCKSCOUT_API = "https://api.blockscout.com/4663/api/v2";

export const KNOWN_CONTRACTS: KnownContract[] = [
  {
    address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    kind: "factory",
    label: "Pons token factory",
    events: {
      "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607": "TokenLaunched(address,address,address,address,uint256,uint256)",
      "0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980": "CreatorFeeRecipientUpdated(address,address,address)",
    },
  },
  // Routers, pools and bridges are not listed yet: none could be verified without explorer access.
];
