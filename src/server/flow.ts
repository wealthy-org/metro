import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { FlowResponse } from "../lib/api-types.ts";
import { MAX_TOKEN_BUILDINGS } from "../lib/city.ts";
import type { Filters } from "../lib/view-state.ts";
import { resolveRange, tokenLabel, tokenStats } from "./city.ts";
import { anchorAt, coverage, subsidyEnd, txFilter } from "./filters.ts";
import { filterRows, liveRead, type FlowRow } from "./live.ts";
import { iso, num, rows } from "./query.ts";

// Flow lens (PROJECT.md 10.3). Live: the newest blocks read from RPC (Phase 6 D3, KL-23). Scrubbed: the newest
// ingested blocks at or before the scrubber time, from Postgres. The token column is the City's Pons district.

export const MAX_PARTICLES = 2_000;
const REPLAY_BLOCKS = 10;

async function ponsColumns(db: Db, anchor: Date | null) {
  if (!anchor) return [];
  const tokens = await tokenStats(db, resolveRange("24h", anchor), { action: null, token: null, minValue: null, wallet: null, status: null }, undefined, MAX_TOKEN_BUILDINGS);
  return tokens.map((t) => ({ key: t.key, label: tokenLabel(t) }));
}

async function replay(db: Db, anchor: Date, f: Filters): Promise<{ rows: FlowRow[]; first: number; last: number; firstTs: string; lastTs: string; tps: number | null }> {
  const out = await rows(db, sql`
    WITH b AS (SELECT number, ts FROM blocks WHERE ts <= ${anchor} ORDER BY number DESC LIMIT ${REPLAY_BLOCKS})
    SELECT t.hash, t.block, t.ts, t.from_address, t.to_address, t.action, t.fee_usd, t.value, t.status, t.subsidy_class,
           coalesce((SELECT array_agg(DISTINCT tt.token_address) FROM token_transfers tt WHERE tt.tx_hash = t.hash AND tt.ts = t.ts), '{}') AS tokens,
           (SELECT min(number) FROM b) AS first_block, (SELECT max(number) FROM b) AS last_block,
           (SELECT min(ts) FROM b) AS first_ts, (SELECT max(ts) FROM b) AS last_ts
    FROM txs t
    WHERE t.block IN (SELECT number FROM b) AND t.ts >= (SELECT min(ts) FROM b) AND t.ts <= ${anchor} ${txFilter(f, "t")}
    ORDER BY t.block DESC, t.hash
    LIMIT ${MAX_PARTICLES}`);
  const flowRows: FlowRow[] = out.map((x) => ({
    hash: String(x.hash),
    block: num(x.block),
    ts: iso(x.ts) ?? "",
    from: String(x.from_address),
    to: x.to_address === null ? null : String(x.to_address),
    action: String(x.action),
    tokens: Array.isArray(x.tokens) ? x.tokens.map(String) : [],
    fee_usd: num(x.fee_usd),
    value_wei: String(x.value),
    value_eth: Number(x.value) / 1e18,
    status: num(x.status) === 1 ? "success" : "failed",
    subsidy_class: String(x.subsidy_class),
  }));
  const first = out[0];
  const firstTs = iso(first?.first_ts) ?? anchor.toISOString();
  const lastTs = iso(first?.last_ts) ?? anchor.toISOString();
  const span = Math.max(1_000, Date.parse(lastTs) - Date.parse(firstTs) + 1_000);
  return { rows: flowRows, first: num(first?.first_block), last: num(first?.last_block), firstTs, lastTs, tps: out.length ? (flowRows.length / span) * 1000 : null };
}

export async function getFlow(db: Db, p: { filters: Filters; at: string | null }): Promise<FlowResponse> {
  const cov = await coverage(db);
  const base = { filters: p.filters, coverage: cov, subsidy_end: subsidyEnd(), generated_at: new Date().toISOString() };
  if (p.at === null) {
    const [live, tokens] = await Promise.all([liveRead(), ponsColumns(db, cov.last ? new Date(cov.last) : null)]);
    const filtered = filterRows(live.rows, p.filters).slice(0, MAX_PARTICLES);
    return {
      ...base,
      source: "rpc",
      window: { start: live.first_ts, end: live.last_ts },
      blocks: { first: live.first_block, last: live.last_block },
      tps: live.tps,
      n_total: filtered.length,
      rows: filtered,
      tokens,
    };
  }
  const anchor = await anchorAt(db, p.at);
  if (!anchor) return { ...base, source: "ingested", window: { start: null, end: null }, blocks: null, tps: null, n_total: 0, rows: [], tokens: [] };
  const [r, tokens] = await Promise.all([replay(db, anchor, p.filters), ponsColumns(db, anchor)]);
  return {
    ...base,
    source: "ingested",
    window: { start: r.firstTs, end: r.lastTs },
    blocks: r.rows.length ? { first: r.first, last: r.last } : null,
    tps: r.tps,
    n_total: r.rows.length,
    rows: r.rows,
    tokens,
  };
}
