import { CITY_ACTIONS, isCityAction, type CityActionKey, type CityWindow } from "../lib/city.ts";
import { isCityWindow } from "../lib/city.ts";

// Surveyor's topics (PROJECT.md 13.3; Phase 10 D1, D2): the limited choices a free-text question maps to. Keyword rules
// come first and need no model call; what they miss is classified by one model call in map.ts and validated here
// again. The topic list is exactly the list PROJECT.md, the prototype and the landing describe.

export type TopicKey = "hours" | "cost" | "spike" | "subsidy" | "fastest" | "concentration" | "dominant" | "fails" | "blocks" | "composition" | "token" | "wallet";

export type Scope = { window: CityWindow; action: CityActionKey | null; token: string | null; address: string | null };

export type TopicDef = {
  title: string;
  question: string;
  needs: ("token" | "address")[];
  keywords: RegExp[];
  lens: (s: Scope) => string;
};

export const TOPIC_KEYS: TopicKey[] = ["hours", "cost", "spike", "subsidy", "fastest", "concentration", "dominant", "fails", "blocks", "composition", "token", "wallet"];
export const isTopicKey = (v: string): v is TopicKey => (TOPIC_KEYS as string[]).includes(v);

export const TOPICS: Record<TopicKey, TopicDef> = {
  hours: {
    title: "Cheapest and dearest hour",
    question: "When is swapping cheapest?",
    needs: [],
    keywords: [/cheap(est|er)?/i, /dear(est)?|most expensive hour/i, /when.*(fee|cost|expensive|cheap)/i],
    lens: (s) => `/lens/heatmap?window=24h&metric=avg_fee_usd${s.action ? `&action=${s.action}` : "&action=swap"}`,
  },
  cost: {
    title: "Fee per action type",
    question: "Which action costs the most?",
    needs: [],
    keywords: [/which action.*(cost|expensive)/i, /costs? the most|the costliest/i, /fee per action|action.*(cost|fee)/i],
    lens: () => "/lens/city?window=24h&metric=avg_fee_usd",
  },
  spike: {
    title: "Gas spike",
    question: "Did the gas price spike recently?",
    needs: [],
    keywords: [/spike|surge/i, /gas.*(jump|high|rise)/i, /base fee.*(jump|high|rise)/i],
    lens: () => "/lens/terrain?window=7d&metric=gas_price",
  },
  subsidy: {
    title: "Subsidy shift",
    question: "What changed after the rebate ended?",
    needs: [],
    keywords: [/rebate|subsid/i, /after 29|cliff/i],
    lens: () => "/subsidy",
  },
  fastest: {
    title: "Fast Pons launch",
    question: "Which Pons token is growing fastest?",
    needs: [],
    keywords: [/fastest|growing|growth/i, /gained?.*holders?|new holders/i],
    lens: () => "/lens/launchpad?window=24h",
  },
  concentration: {
    title: "Holder concentration",
    question: "Which token has the most concentrated holders?",
    needs: [],
    keywords: [/concentrat/i, /top[- ]?10/i, /ownership/i],
    lens: () => "/lens/launchpad?window=24h",
  },
  dominant: {
    title: "Dominant wallet",
    question: "Which wallet dominates an action?",
    needs: [],
    keywords: [/dominant|dominat(e|es|ing)/i, /biggest wallet|most active (wallet|address)/i, /wallet.*(share|most)/i],
    lens: (s) => `/lens/city?window=24h${s.action ? `&action=${s.action}` : ""}`,
  },
  fails: {
    title: "Fail rate",
    question: "Are transactions failing more than usual?",
    needs: [],
    keywords: [/fail(ed|ure|ing)?/i, /error rate/i],
    lens: () => "/lens/city?window=1h&metric=fail_rate",
  },
  blocks: {
    title: "Block usage",
    question: "Are blocks getting full?",
    needs: [],
    keywords: [/block.*(full|usage|limit)/i, /gas limit|full block/i],
    lens: () => "/lens/terrain?window=24h&metric=gas_volume",
  },
  composition: {
    title: "Composition shift",
    question: "How did the mix of actions change?",
    needs: [],
    keywords: [/composition|the mix/i, /share of|shift.*(action|type)/i],
    lens: () => "/lens/city?window=24h",
  },
  token: {
    title: "One token",
    question: "How is this token doing?",
    needs: ["token"],
    keywords: [/this token|the token/i, /token.*(doing|activity|stats|moving)/i],
    lens: (s) => `/token/${s.token ?? ""}`,
  },
  wallet: {
    title: "One wallet",
    question: "How has this wallet behaved?",
    needs: ["address"],
    keywords: [/this (wallet|address)|the (wallet|address)/i, /wallet.*(paid|spent|fee)/i, /address.*(paid|spent|fee)/i],
    lens: (s) => `/wallet/${s.address ?? ""}`,
  },
};

// Outside the topics, with the reason (PROJECT.md 13.3: refused with a reason; rules.md 2).
export const REFUSALS: { re: RegExp; reason: string }[] = [
  { re: /\b(buy|sell|invest|recommend|should i|worth (buying|it))\b/i, reason: "Metro does not give financial advice. It explains what the chain data shows; the topics it can answer are listed on /methodology." },
  { re: /\b(price|predict|prediction|forecast|price target)\b/i, reason: "Metro does not predict prices. It reports what happened on chain; try a topic about fees, activity, holders or the subsidy." },
  { re: /\b(sybil|bots?|scam|fraud|who is|real owner|identity)\b/i, reason: "Metro does not label identities or intent. The Graph groups wallets by patterns it can explain, such as being funded by the same address in a window." },
  { re: /\b(sql|database|raw (data|rows|transactions)|dump|export everything)\b/i, reason: "Surveyor reads computed facts only, never raw data. The public API and /data expose bounded datasets." },
];

export function matchTopic(question: string): TopicKey | null {
  for (const key of TOPIC_KEYS) {
    if (TOPICS[key].keywords.some((re) => re.test(question))) return key;
  }
  return null;
}

export function matchRefusal(question: string): string | null {
  for (const r of REFUSALS) {
    if (r.re.test(question)) return r.reason;
  }
  return null;
}

export function extractAddress(question: string): string | null {
  const m = /0x[0-9a-fA-F]{40}/.exec(question);
  return m ? m[0].toLowerCase() : null;
}

export const ADDRESS = /^0x[0-9a-f]{40}$/;

// The lens that shows a fact, from its key (the share page has no topic to ask). Prefix rules stay in the same order
// as the keys in api.md 1.5a.
export function lensFor(key: string): string {
  const subject = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (key.startsWith("token_") && ADDRESS.test(subject)) return `/token/${subject}`;
  if (key.startsWith("wallet_") && !key.startsWith("wallet_share.") && ADDRESS.test(subject)) return `/wallet/${subject}`;
  if (key.startsWith("median_fee_usd.") && key.endsWith(".hour")) return "/lens/heatmap?window=24h&metric=avg_fee_usd";
  if (/^median_fee_usd\.all\.(before|after)$/.test(key)) return "/subsidy";
  if (key.startsWith("base_fee_gwei")) return "/lens/terrain?window=7d&metric=gas_price";
  if (key.startsWith("full_blocks")) return "/lens/terrain?window=24h&metric=gas_volume";
  if (key.startsWith("holder_growth_24h") || key.startsWith("top10_share") || key.startsWith("pool_share")) return "/lens/launchpad?window=24h";
  if (key.startsWith("paid_share") || key.startsWith("tx_per_block") || key.startsWith("est_tx_per_day") || key.startsWith("days_covered") || key.startsWith("block_coverage")) return "/subsidy";
  return "/lens/city?window=24h";
}

// What a caller may send: every slot is a loose string; normalizeScope validates and drops what it cannot use.
export type ScopeInput = { window?: string; action?: string | null; token?: string | null; address?: string | null };

// Validates a scope sent by the UI or produced by the classification call; invalid values are dropped, not thrown, so
// a stale view state never fails an ask.
export function normalizeScope(input: ScopeInput): Scope {
  const window = typeof input.window === "string" && isCityWindow(input.window) ? input.window : "24h";
  const action = typeof input.action === "string" && isCityAction(input.action) ? input.action : null;
  const token = typeof input.token === "string" && ADDRESS.test(input.token.toLowerCase()) ? input.token.toLowerCase() : null;
  const address = typeof input.address === "string" && ADDRESS.test(input.address.toLowerCase()) ? input.address.toLowerCase() : null;
  return { window, action, token, address };
}

export const ACTION_KEYS = CITY_ACTIONS.map((a) => a.key);
