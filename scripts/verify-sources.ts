// Phase 0 source verification. Runs on Node 24+ native type stripping: `node scripts/verify-sources.ts`.
// No dependencies. The optional BLOCKSCOUT_API_KEY env var enables the Blockscout PRO check and is never printed.
// Exits with code 1 when any check fails.

import { BLOCKSCOUT_API, CHAIN_ID, PONS_FACTORY, RPC_POOL } from "../config/known-contracts.ts";

type Result = {
  group: string;
  target: string;
  ok: boolean;
  ms: number;
  detail: string;
};

const EXPECTED_CHAIN_ID = CHAIN_ID;
const REQUEST_TIMEOUT_MS = 10_000;
const LOG_CHUNK_BLOCKS = 10_000;
const LOG_MAX_CHUNKS = 20;

const RPC_CANDIDATES: readonly string[] = RPC_POOL;

const BLOCKSCOUT_PUBLIC = "https://robinhoodchain.blockscout.com/api/v2";
const BLOCKSCOUT_PRO = BLOCKSCOUT_API;

type Json = unknown;

const isRecord = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const field = (v: Json, key: string): Json => (isRecord(v) ? v[key] : undefined);
const itemsOf = (v: Json): Json[] | null => {
  const items = field(v, "items");
  return Array.isArray(items) ? items : null;
};

const results: Result[] = [];
const record = (r: Result) => {
  results.push(r);
};

async function timed(url: string, init?: RequestInit): Promise<{ res: Response | null; ms: number; error?: string }> {
  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { res, ms: Math.round(performance.now() - start) };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { res: null, ms: Math.round(performance.now() - start), error: message };
  }
}

type RpcReply = { ok: boolean; ms: number; result?: Json; detail: string };

async function rpc(url: string, method: string, params: Json[] = []): Promise<RpcReply> {
  const { res, ms, error } = await timed(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res) return { ok: false, ms, detail: error ?? "no response" };
  if (!res.ok) return { ok: false, ms, detail: `HTTP ${res.status}` };
  const body: Json = await res.json().catch(() => null);
  if (!isRecord(body)) return { ok: false, ms, detail: "non-JSON body" };
  const rpcError = field(body, "error");
  if (rpcError !== undefined) return { ok: false, ms, detail: `RPC error: ${String(field(rpcError, "message") ?? "unknown")}` };
  return { ok: true, ms, result: body.result, detail: "" };
}

function rateLimitHeaders(res: Response): string {
  const keys = ["x-ratelimit-limit", "x-ratelimit-remaining", "ratelimit-limit", "ratelimit-remaining", "retry-after"];
  const found = keys.filter((k) => res.headers.has(k)).map((k) => `${k}=${res.headers.get(k)}`);
  return found.length ? ` [${found.join(", ")}]` : "";
}

function summarize(body: Json): string {
  const items = itemsOf(body);
  if (items) return `items=${items.length}`;
  if (Array.isArray(body)) return `array length=${body.length}`;
  return `keys=${Object.keys(isRecord(body) ? body : {}).slice(0, 6).join(",")}`;
}

// Returns the parsed body only when the request and the check both pass.
async function getJson(group: string, url: string, check: (body: Json) => string | null, label = url, headers: Record<string, string> = {}): Promise<Json | null> {
  const { res, ms, error } = await timed(url, { headers: { accept: "application/json", ...headers } });
  if (!res) {
    record({ group, target: label, ok: false, ms, detail: error ?? "no response" });
    return null;
  }
  if (!res.ok) {
    const hint = res.headers.get("cf-mitigated") ? " (Cloudflare challenge)" : "";
    const text = res.headers.get("content-type")?.includes("json") ? ` ${(await res.text()).slice(0, 120)}` : "";
    record({ group, target: label, ok: false, ms, detail: `HTTP ${res.status}${hint}${text}${rateLimitHeaders(res)}` });
    return null;
  }
  const body: Json = await res.json().catch(() => null);
  if (body === null) {
    record({ group, target: label, ok: false, ms, detail: "non-JSON body" });
    return null;
  }
  const problem = check(body);
  record({ group, target: label, ok: problem === null, ms, detail: (problem ?? summarize(body)) + rateLimitHeaders(res) });
  return problem === null ? body : null;
}

const hex = (n: number) => `0x${n.toString(16)}`;

async function checkRpc(url: string) {
  const chain = await rpc(url, "eth_chainId");
  if (!chain.ok) return record({ group: "rpc", target: url, ok: false, ms: chain.ms, detail: chain.detail });
  const got = Number(chain.result);
  if (got !== EXPECTED_CHAIN_ID) {
    return record({ group: "rpc", target: url, ok: false, ms: chain.ms, detail: `chainId=${got}, expected ${EXPECTED_CHAIN_ID}` });
  }
  const head = await rpc(url, "eth_blockNumber");
  const block = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
  const txs = field(block.result, "transactions");
  const ok = head.ok && block.ok && Number(head.result) > 0;
  const detail = ok
    ? `head=${Number(head.result)} txs=${Array.isArray(txs) ? txs.length : "?"} gasUsed=${Number(field(block.result, "gasUsed"))} gasLimit=${Number(field(block.result, "gasLimit"))} baseFee=${Number(field(block.result, "baseFeePerGas") ?? 0)}`
    : `${head.detail} ${block.detail}`.trim();
  record({ group: "rpc", target: url, ok, ms: chain.ms + head.ms + block.ms, detail });
}

async function checkChainShape(url: string) {
  const head = await rpc(url, "eth_blockNumber");
  if (!head.ok) return;
  const n = Number(head.result);
  const span = Math.min(100_000, n - 1);
  const [latest, earlier, first] = await Promise.all([
    rpc(url, "eth_getBlockByNumber", [hex(n), false]),
    rpc(url, "eth_getBlockByNumber", [hex(n - span), false]),
    rpc(url, "eth_getBlockByNumber", ["0x1", false]),
  ]);
  const ts = (r: RpcReply) => Number(field(r.result, "timestamp"));
  if (latest.ok && earlier.ok) {
    const seconds = ts(latest) - ts(earlier);
    record({ group: "chain", target: "block time", ok: seconds > 0, ms: 0, detail: `${span} blocks in ${seconds}s = ${(seconds / span).toFixed(3)}s/block, ~${Math.round((86_400 * span) / seconds)} blocks/day` });
  }
  if (first.ok) {
    record({ group: "chain", target: "block 1 timestamp", ok: true, ms: 0, detail: new Date(ts(first) * 1000).toISOString() });
  }
  const sample = await Promise.all([0, 1_000, 10_000, 50_000].map((d) => rpc(url, "eth_getBlockByNumber", [hex(n - d), false])));
  const counts = sample.map((r) => field(r.result, "transactions")).map((t) => (Array.isArray(t) ? t.length : 0));
  record({ group: "chain", target: "txs per block (4 samples)", ok: true, ms: 0, detail: counts.join(", ") });
}

async function checkPons(url: string) {
  const code = await rpc(url, "eth_getCode", [PONS_FACTORY, "latest"]);
  const bytecode = typeof code.result === "string" ? code.result : "0x";
  const hasCode = code.ok && bytecode.length > 2;
  record({
    group: "pons",
    target: `eth_getCode ${PONS_FACTORY}`,
    ok: hasCode,
    ms: code.ms,
    detail: hasCode ? `bytecode ${(bytecode.length - 2) / 2} bytes` : code.detail || "no bytecode at this address",
  });
  if (!hasCode) return;

  const head = await rpc(url, "eth_blockNumber");
  let to = Number(head.result);
  const topics = new Map<string, number>();
  let scanned = 0;
  let lastError = "";
  for (let i = 0; i < LOG_MAX_CHUNKS && topics.size === 0; i++) {
    const from = to - LOG_CHUNK_BLOCKS + 1;
    const logs = await rpc(url, "eth_getLogs", [{ address: PONS_FACTORY, fromBlock: hex(from), toBlock: hex(to) }]);
    if (!logs.ok || !Array.isArray(logs.result)) {
      lastError = logs.detail || "unexpected eth_getLogs result";
      break;
    }
    for (const log of logs.result) {
      const t0 = field(log, "topics");
      const topic = Array.isArray(t0) && typeof t0[0] === "string" ? t0[0] : null;
      if (topic) topics.set(topic, (topics.get(topic) ?? 0) + 1);
    }
    scanned += LOG_CHUNK_BLOCKS;
    to = from - 1;
  }
  if (topics.size === 0) {
    record({ group: "pons", target: "factory logs", ok: false, ms: 0, detail: lastError || `no logs in last ${scanned} blocks` });
  }
  for (const [topic, count] of topics) {
    record({ group: "pons", target: `topic0 ${topic}`, ok: true, ms: 0, detail: `${count} logs in last ${scanned} blocks` });
  }
}

async function checkBlockscout(base: string, label: string, headers: Record<string, string> = {}) {
  const nonEmpty = (b: Json) => (itemsOf(b)?.length ? null : "empty items");
  const stats = await getJson("blockscout", `${base}/stats`, (b) => (field(b, "total_blocks") ? null : "missing total_blocks"), `${label} /stats`, headers);
  if (!stats) return;
  await getJson("blockscout", `${base}/blocks`, nonEmpty, `${label} /blocks`, headers);
  await getJson("blockscout", `${base}/transactions`, nonEmpty, `${label} /transactions`, headers);
  await getJson("blockscout", `${base}/tokens`, (b) => (itemsOf(b) ? null : "no items array"), `${label} /tokens`, headers);
  await getJson("blockscout", `${base}/stats/charts/transactions`, (b) => (Array.isArray(field(b, "chart_data")) ? null : "no chart_data"), `${label} /stats/charts/transactions`, headers);
}

async function checkMarketFeeds() {
  await getJson("price", "https://coins.llama.fi/prices/current/coingecko:ethereum", (b) => {
    const price = field(field(field(b, "coins"), "coingecko:ethereum"), "price");
    return typeof price === "number" && price > 0 ? null : "no positive ETH price";
  });
  const chains = await getJson("defillama", "https://api.llama.fi/v2/chains", (b) => (Array.isArray(b) ? null : "not an array"));
  if (Array.isArray(chains)) {
    const match = chains.filter((c) => /robinhood/i.test(String(field(c, "name") ?? "")));
    record({ group: "defillama", target: "Robinhood Chain in /v2/chains", ok: match.length > 0, ms: 0, detail: match.length ? match.map((c) => `name="${String(field(c, "name"))}" chainId=${String(field(c, "chainId") ?? "n/a")}`).join("; ") : "chain not listed" });
  }
  const master = await getJson("growthepie", "https://api.growthepie.com/v1/master.json", (b) => (isRecord(field(b, "chains")) ? null : "no chains field"));
  const chainMap = field(master, "chains");
  if (isRecord(chainMap)) {
    const keys = Object.keys(chainMap).filter((k) => /robinhood/i.test(k));
    record({ group: "growthepie", target: "Robinhood key in master.json", ok: keys.length > 0, ms: 0, detail: keys.length ? `keys=${keys.join(",")}` : "chain not listed" });
  }
}

async function main() {
  await Promise.all(RPC_CANDIDATES.map(checkRpc));
  const workingRpc = RPC_CANDIDATES.find((url) => results.some((r) => r.target === url && r.ok));
  if (workingRpc) {
    await checkChainShape(workingRpc);
    await checkPons(workingRpc);
  }
  await checkBlockscout(BLOCKSCOUT_PUBLIC, "blockscout public");
  const key = process.env.BLOCKSCOUT_API_KEY;
  if (key) {
    await checkBlockscout(BLOCKSCOUT_PRO, "blockscout PRO", { authorization: `Bearer ${key}` });
  } else {
    await getJson("blockscout", `${BLOCKSCOUT_PRO}/stats`, (b) => (field(b, "total_blocks") ? null : "missing total_blocks"), "blockscout PRO /stats (no key)");
  }
  await checkMarketFeeds();

  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.group.padEnd(11)} ${String(r.ms).padStart(5)}ms  ${r.target}\n      ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
