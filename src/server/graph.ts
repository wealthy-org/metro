import { sql, type SQL } from "drizzle-orm";
import { ARBOS_SENDER } from "../../config/known-contracts.ts";
import type { Db } from "../db/client.ts";
import { blocksPerDay } from "../engine/subsidy.ts";
import { feeTop, type CityWindow } from "../lib/city.ts";
import { CLUSTER_MIN, GRAPH_EDGE_LIMIT, GRAPH_NODE_CAP, WALLET_GRAPH_TRANSFERS, type GraphCluster, type GraphEdge, type GraphNode, type GraphResponse } from "../lib/graph.ts";
import { GRAPH_WINDOW_REASON, isShortWindow, NO_FILTERS, type Filters, type GraphMode } from "../lib/view-state.ts";
import { resolveRange, txTime, windowInfo, type Range } from "./city.ts";
import { CODE_CHECKED, readCode, type CodeReader } from "./code.ts";
import { anchorAt, coverage, filterKey, parseDataParams, subsidyEnd, txFilter } from "./filters.ts";
import { cachedRows, iso, num, numOrNull, rows, type Row } from "./query.ts";

// Graph lens (PROJECT.md 10.4) and the wallet ego graph (15); Phase 9. Nodes are addresses, edges are transfers:
// native value (txs with value > 0) and token transfers. The ArbOS sender (KL-7) and the zero address (mints and
// burns) are left out, and so are failed transactions (they move no value). Windows of 24 h or less only, read from raw rows (D2). Groups: wallets funded by the same
// address in the window (D1, KL-30); never an identity label.

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const WEI_PER_ETH = 1e18;

// cap: how many nodes the caller wants at most (1 to GRAPH_NODE_CAP); the landing asks for a small picture.
export type GraphParams = { window: CityWindow; filters: Filters; at: string | null; mode: GraphMode; addr: string | null; token: string | null; hops: 1 | 2; cap?: number };

export function parseGraphParams(params: URLSearchParams): GraphParams | string {
  const data = parseDataParams(params);
  if (typeof data === "string") return data;
  if (!isShortWindow(data.window)) return GRAPH_WINDOW_REASON;
  const mode = params.get("mode") ?? "top";
  if (mode !== "top" && mode !== "ego" && mode !== "token") return "mode must be top, ego or token";
  const addr = (params.get("addr") ?? "").toLowerCase() || null;
  const token = (params.get("gtoken") ?? "").toLowerCase() || null;
  const hops = params.get("hops") ?? "1";
  if (addr !== null && !ADDRESS.test(addr)) return "addr must be an address";
  if (token !== null && !ADDRESS.test(token)) return "gtoken must be a token address";
  if (hops !== "1" && hops !== "2") return "hops must be 1 or 2";
  if (mode === "ego" && !addr) return "the ego graph needs addr";
  if (mode === "token" && !token) return "token flow needs gtoken";
  const capRaw = params.get("cap");
  const cap = capRaw === null ? undefined : Number(capRaw);
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > GRAPH_NODE_CAP)) return `cap must be a whole number from 1 to ${GRAPH_NODE_CAP}`;
  return { ...data, mode, addr, token, hops: hops === "2" ? 2 : 1, cap };
}

type RawEdge = { s: string; t: string; n: number; wei: number; tokens: string[] };

const rawEdge = (x: Row): RawEdge => ({
  s: String(x.s),
  t: String(x.t),
  n: num(x.n),
  wei: num(x.wei),
  tokens: Array.isArray(x.tokens) ? (x.tokens as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 5) : [],
});

// Keeps at most `cap` nodes (PROJECT.md 10.4, AT 13): the center first, then its neighbours by the transfers they share
// with it, then everyone else by transfers; ties by address so the result is stable. Edges keep both ends.
export function trimGraph(edges: readonly RawEdge[], center: string | null, cap: number): { ids: string[]; degree: Map<string, number>; kept: RawEdge[] } {
  const degree = new Map<string, number>();
  const toCenter = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) ?? 0) + e.n);
    degree.set(e.t, (degree.get(e.t) ?? 0) + e.n);
    if (center && e.s === center) toCenter.set(e.t, (toCenter.get(e.t) ?? 0) + e.n);
    if (center && e.t === center) toCenter.set(e.s, (toCenter.get(e.s) ?? 0) + e.n);
  }
  const ids = [...degree.keys()]
    .filter((id) => id !== center)
    .sort((a, b) => (toCenter.get(b) ?? 0) - (toCenter.get(a) ?? 0) || (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const keptIds = center && degree.has(center) ? [center, ...ids].slice(0, cap) : ids.slice(0, cap);
  const set = new Set(keptIds);
  return { ids: keptIds, degree, kept: edges.filter((e) => set.has(e.s) && set.has(e.t)) };
}

// Transfers of the view, one row per transfer: native value, then token transfers. `f` applies to the transaction.
function transferRows(r: Range, f: Filters, mode: GraphMode, token: string | null): SQL {
  const native = sql`
    SELECT from_address AS s, to_address AS t, value AS wei, NULL::varchar AS token FROM txs
    WHERE ${txTime(r, sql`ts`)} AND status = 1 AND value > 0 AND to_address IS NOT NULL AND from_address <> ${ARBOS_SENDER} ${txFilter(f, "txs")}`;
  const tokenPart = sql`
    SELECT tt.from_address AS s, tt.to_address AS t, 0::numeric AS wei, tt.token_address AS token FROM token_transfers tt JOIN txs t ON t.hash = tt.tx_hash AND t.ts = tt.ts
    WHERE ${txTime(r, sql`tt.ts`)} AND tt.from_address <> ${ZERO} AND tt.to_address <> ${ZERO} ${token ? sql`AND tt.token_address = ${token}` : sql``} ${txFilter(f, "t")}`;
  return mode === "token" ? tokenPart : sql`${native} UNION ALL ${tokenPart}`;
}

function scoped(mode: GraphMode, addr: string | null, hops: 1 | 2): SQL {
  if (mode !== "ego" || !addr) return sql`true`;
  if (hops === 1) return sql`(s = ${addr} OR t = ${addr})`;
  return sql`(s = ${addr} OR t = ${addr} OR s IN (SELECT x FROM n1) OR t IN (SELECT x FROM n1))`;
}

const ids = (list: string[]) => sql`${sql.param(list)}::varchar[]`;

// Per-address figures over the span of the view (as sender), node kind and label, and funder groups (D1).
async function describe(db: Db, list: string[], span: Range, f: Filters, key: string): Promise<{ stats: Map<string, Row>; kinds: Map<string, string | null>; groups: Map<string, { funder: string; size: number }> }> {
  if (!list.length) return { stats: new Map(), kinds: new Map(), groups: new Map() };
  const clusterFilter = { ...f, action: null };
  const [stats, kinds, groups] = await Promise.all([
    cachedRows(db, `graph-stats|${key}`, sql`
      SELECT from_address AS a, count(*) AS n, sum(gas_used) AS gas, avg(fee_usd) AS fee, count(*) FILTER (WHERE status = 0) AS failed
      FROM txs WHERE ${txTime(span, sql`ts`)} AND from_address = ANY(${ids(list)}) ${txFilter(f, "txs")} GROUP BY 1`),
    cachedRows(db, `graph-kinds|${key}`, sql`
      SELECT a, max(label) AS label FROM (
        SELECT lower(address) AS a, label FROM known_contracts WHERE lower(address) = ANY(${ids(list)})
        UNION ALL SELECT address, symbol FROM tokens WHERE address = ANY(${ids(list)})
        UNION ALL SELECT params->>'topic2', NULL FROM pons_launches WHERE params->>'topic2' = ANY(${ids(list)})
        UNION ALL SELECT DISTINCT to_address, NULL FROM txs WHERE ${txTime(span, sql`ts`)} AND method IS NOT NULL AND to_address = ANY(${ids(list)})
      ) k GROUP BY a`),
    // A wallet belongs to the group of the funder that plain-funded the most wallets in the span; ties by address.
    cachedRows(db, `graph-groups|${key}`, sql`
      WITH fr AS (
        SELECT DISTINCT from_address AS f, to_address AS r FROM txs
        WHERE ${txTime(span, sql`ts`)} AND status = 1 AND action = 'native_transfer' AND from_address <> ${ARBOS_SENDER} ${txFilter(clusterFilter, "txs")}
      ), sz AS (SELECT f, count(*) AS size FROM fr GROUP BY f HAVING count(*) >= ${CLUSTER_MIN})
      SELECT DISTINCT ON (fr.r) fr.r, sz.f, sz.size FROM fr JOIN sz USING (f)
      WHERE fr.r = ANY(${ids(list)}) ORDER BY fr.r, sz.size DESC, sz.f`),
  ]);
  return {
    stats: new Map(stats.map((x) => [String(x.a), x])),
    kinds: new Map(kinds.map((x) => [String(x.a), x.label === null ? null : String(x.label)])),
    groups: new Map(groups.map((x) => [String(x.r), { funder: String(x.f), size: num(x.size) }])),
  };
}

function assemble(edges: RawEdge[], center: string | null, cap: number, d: Awaited<ReturnType<typeof describe>>, list: string[], degree: Map<string, number>, code: Map<string, boolean>) {
  const index = new Map(list.map((id, i) => [id, i]));
  const nodes: GraphNode[] = list.map((id) => {
    const s = d.stats.get(id);
    const sent = num(s?.n);
    // A contract is one Metro knows or one whose code on the chain is not empty; a contract has no group.
    const contract = d.kinds.has(id) || code.get(id) === true;
    const group = contract ? null : (d.groups.get(id) ?? null);
    return {
      id,
      label: d.kinds.get(id) ?? null,
      kind: contract ? "contract" : "address",
      transfers: degree.get(id) ?? 0,
      tx_sent: sent,
      gas_volume: num(s?.gas),
      avg_fee_usd: sent ? numOrNull(s?.fee) : null,
      fail_rate: sent ? num(s?.failed) / sent : null,
      cluster: group?.funder ?? null,
    };
  });
  const byFunder = new Map<string, GraphCluster>();
  for (const n of nodes) {
    if (!n.cluster) continue;
    const g = d.groups.get(n.id);
    const c = byFunder.get(n.cluster) ?? { funder: n.cluster, size: g?.size ?? 0, shown: 0 };
    c.shown += 1;
    byFunder.set(n.cluster, c);
  }
  const out: GraphEdge[] = edges.map((e) => ({ s: index.get(e.s) ?? 0, t: index.get(e.t) ?? 0, n: e.n, eth: e.wei / WEI_PER_ETH, tokens: e.tokens }));
  const fees = nodes.map((n) => n.avg_fee_usd).filter((v): v is number => v !== null);
  return {
    nodes,
    edges: out,
    clusters: [...byFunder.values()].sort((a, b) => b.size - a.size || (a.funder < b.funder ? -1 : 1)),
    cap,
    center,
    fee_top: fees.length ? feeTop(fees) : null,
    code_checked: code.size,
  };
}

// The center of an ego graph and the busiest addresses of the view (kept ids are ordered center first, then by weight).
const toCheck = (kept: string[], center: string | null) => (center ? [center, ...kept.filter((k) => k !== center)] : kept).slice(0, CODE_CHECKED);

export async function getGraph(db: Db, p: GraphParams, anchor?: Date | null, defaultCap = GRAPH_NODE_CAP, code: CodeReader = readCode): Promise<GraphResponse> {
  const cap = p.cap ?? defaultCap;
  const [at, cov] = await Promise.all([anchor === undefined ? anchorAt(db, p.at) : Promise.resolve(anchor), coverage(db)]);
  const base = { mode: p.mode, hops: p.hops, coverage: cov, filters: p.filters, subsidy_end: subsidyEnd(), generated_at: new Date().toISOString() };
  const empty = { nodes: [], edges: [], clusters: [], total_nodes: 0, cap, trimmed: false, fee_top: null, n: 0, code_checked: 0, blocks: null, tokens: [], center: p.mode === "ego" ? p.addr : null, token: null };
  if (!at) return { ...base, ...empty, window: windowInfo(p.window, null, null, null) };

  const r = resolveRange(p.window, at);
  const key = `${r.start?.toISOString()}|${r.end.toISOString()}|${filterKey(p.filters)}|${p.mode}|${p.addr ?? "-"}|${p.token ?? "-"}|${p.hops}`;
  const center = p.mode === "ego" ? p.addr : null;
  const withEdges = sql`
    WITH e AS (${transferRows(r, p.filters, p.mode, p.token)}),
         n1 AS (SELECT t AS x FROM e WHERE s = ${p.addr ?? ZERO} UNION SELECT s FROM e WHERE t = ${p.addr ?? ZERO}),
         g AS (
           SELECT s, t, count(*) AS n, sum(wei) AS wei, array_agg(DISTINCT token) FILTER (WHERE token IS NOT NULL) AS tokens
           FROM e WHERE s <> t AND ${scoped(p.mode, p.addr, p.hops)} GROUP BY s, t)`;
  const [edgeRows, [totals], tokenRows, tokenInfo, [blockCount], perDay] = await Promise.all([
    cachedRows(db, `graph-edges|${key}`, sql`${withEdges} SELECT * FROM g ORDER BY n DESC, s, t LIMIT ${GRAPH_EDGE_LIMIT}`),
    cachedRows(db, `graph-total|${key}`, sql`${withEdges} SELECT (SELECT count(*) FROM (SELECT s FROM g UNION SELECT t FROM g) x) AS nodes, (SELECT coalesce(sum(n), 0) FROM g) AS n`),
    cachedRows(db, `graph-tokens|${key}`, sql`
      SELECT tt.token_address AS a, k.symbol, count(*) AS n FROM token_transfers tt LEFT JOIN tokens k ON k.address = tt.token_address
      WHERE ${txTime(r, sql`tt.ts`)} AND tt.from_address <> ${ZERO} AND tt.to_address <> ${ZERO} GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 30`),
    p.token ? rows(db, sql`SELECT symbol FROM tokens WHERE address = ${p.token}`) : Promise.resolve([] as Row[]),
    cachedRows(db, `graph-blocks|${r.start?.toISOString()}|${r.end.toISOString()}`, sql`SELECT count(*) AS n FROM blocks WHERE ${txTime(r, sql`ts`)}`),
    blocksPerDay(db),
  ]);
  const edges = edgeRows.map(rawEdge);
  const trimmed = trimGraph(edges, center, cap);
  const [d, onChain] = await Promise.all([describe(db, trimmed.ids, r, p.filters, `${key}|${cap}`), code(toCheck(trimmed.ids, center))]);
  const total = num(totals?.nodes);
  return {
    ...base,
    ...assemble(trimmed.kept, center, cap, d, trimmed.ids, trimmed.degree, onChain),
    window: windowInfo(p.window, r, null, at),
    token: p.token ? { address: p.token, symbol: tokenInfo[0]?.symbol === undefined || tokenInfo[0]?.symbol === null ? null : String(tokenInfo[0].symbol) } : null,
    total_nodes: total,
    trimmed: total > trimmed.ids.length,
    n: num(totals?.n),
    blocks: { covered: num(blockCount?.n), expected: perDay && r.start ? Math.round((perDay * (r.end.getTime() - r.start.getTime())) / 86_400_000) : null },
    tokens: tokenRows.map((x) => ({ address: String(x.a), symbol: x.symbol === null ? null : String(x.symbol), n: num(x.n) })),
  };
}

// The Inspector's address section (Phase 9): kind, label, group and token transfers of one address in a window.
export async function addressFacts(db: Db, address: string, r: Range, f: Filters, code: CodeReader = readCode): Promise<{ kind: "contract" | "address"; label: string | null; group: { funder: string; size: number } | null; token_transfers: { in: number; out: number } }> {
  const key = `addr|${address}|${r.start?.toISOString()}|${r.end.toISOString()}|${filterKey(f)}`;
  const [d, onChain, [tt]] = await Promise.all([
    describe(db, [address], r, f, key),
    code([address]),
    rows(db, sql`
      SELECT count(*) FILTER (WHERE tt.to_address = ${address}) AS i, count(*) FILTER (WHERE tt.from_address = ${address}) AS o
      FROM token_transfers tt JOIN txs t ON t.hash = tt.tx_hash AND t.ts = tt.ts
      WHERE ${txTime(r, sql`tt.ts`)} AND (tt.from_address = ${address} OR tt.to_address = ${address}) ${txFilter(f, "t")}`),
  ]);
  const contract = d.kinds.has(address) || onChain.get(address) === true;
  return {
    kind: contract ? "contract" : "address",
    label: d.kinds.get(address) ?? null,
    group: contract ? null : (d.groups.get(address) ?? null),
    token_transfers: { in: num(tt?.i), out: num(tt?.o) },
  };
}

// The ego graph on /wallet/[address] (PROJECT.md 15): the wallet's newest transfers in the ingested data (at most
// WALLET_GRAPH_TRANSFERS), one hop. Node figures cover the span of those transfers.
export async function getWalletGraph(db: Db, address: string, cap = GRAPH_NODE_CAP, code: CodeReader = readCode): Promise<GraphResponse> {
  const cov = await coverage(db);
  const newest = await rows(db, sql`
    WITH mine AS (
      (SELECT from_address AS s, to_address AS t, value AS wei, NULL::varchar AS token, ts FROM txs
       WHERE from_address = ${address} AND status = 1 AND value > 0 AND to_address IS NOT NULL ORDER BY ts DESC LIMIT ${WALLET_GRAPH_TRANSFERS})
      UNION ALL
      (SELECT from_address, to_address, value, NULL, ts FROM txs
       WHERE to_address = ${address} AND status = 1 AND value > 0 AND from_address <> ${ARBOS_SENDER} ORDER BY ts DESC LIMIT ${WALLET_GRAPH_TRANSFERS})
      UNION ALL
      (SELECT from_address, to_address, 0::numeric, token_address, ts FROM token_transfers
       WHERE from_address = ${address} AND to_address <> ${ZERO} ORDER BY ts DESC LIMIT ${WALLET_GRAPH_TRANSFERS})
      UNION ALL
      (SELECT from_address, to_address, 0::numeric, token_address, ts FROM token_transfers
       WHERE to_address = ${address} AND from_address <> ${ZERO} ORDER BY ts DESC LIMIT ${WALLET_GRAPH_TRANSFERS})
    ), newest AS (SELECT * FROM mine WHERE s <> t ORDER BY ts DESC LIMIT ${WALLET_GRAPH_TRANSFERS})
    SELECT s, t, count(*) AS n, sum(wei) AS wei, array_agg(DISTINCT token) FILTER (WHERE token IS NOT NULL) AS tokens,
           min(ts) AS first, max(ts) AS last, sum(count(*)) OVER () AS total
    FROM newest GROUP BY s, t`);
  const base = { mode: "wallet" as const, hops: 1 as const, coverage: cov, filters: NO_FILTERS, subsidy_end: subsidyEnd(), generated_at: new Date().toISOString(), tokens: [], token: null, blocks: null };
  const firsts = newest.map((x) => iso(x.first)).filter((v): v is string => v !== null).sort();
  const lasts = newest.map((x) => iso(x.last)).filter((v): v is string => v !== null).sort();
  const start = firsts[0] ?? null;
  const end = lasts[lasts.length - 1] ?? null;
  if (!start || !end) {
    return { ...base, nodes: [], edges: [], clusters: [], total_nodes: 0, cap, trimmed: false, fee_top: null, n: 0, code_checked: 0, center: address, window: { key: "all", start: null, end: null, basis: "txs" } };
  }
  // The span ends just after the newest transfer, so its block is included.
  const span: Range = { basis: "txs", start: new Date(start), end: new Date(Date.parse(end) + 1), startDay: null, endDay: end.slice(0, 10) };
  const edges = newest.map(rawEdge);
  const trimmed = trimGraph(edges, address, cap);
  const [d, onChain] = await Promise.all([describe(db, trimmed.ids, span, NO_FILTERS, `wallet|${address}|${start}|${end}|${cap}`), code(toCheck(trimmed.ids, address))]);
  return {
    ...base,
    ...assemble(trimmed.kept, address, cap, d, trimmed.ids, trimmed.degree, onChain),
    window: { key: "all", start, end, basis: "txs" },
    total_nodes: trimmed.degree.size,
    trimmed: trimmed.degree.size > trimmed.ids.length,
    n: num(newest[0]?.total),
  };
}
