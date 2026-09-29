// Graph lens contracts and constants shared by the server and the browser (PROJECT.md 10.4; Phase 9). Type-only
// imports keep this file safe for the browser bundle.

import type { CityWindowInfo, Coverage } from "./api-types.ts";
import { costColor, cssColor, NO_FEE_RGB } from "./city.ts";
import { shortHex } from "./format.ts";
import type { Filters, GraphMode } from "./view-state.ts";

// PROJECT.md 10.4: at most 1,500 nodes by default; above it only the strongest neighbours are kept, and the lens says so.
export const GRAPH_NODE_CAP = 1_500;
// Transfers read for the wallet ego graph (PROJECT.md 15), newest first; the profile states the number.
export const WALLET_GRAPH_TRANSFERS = 5_000;
// Edges read for one lens view before trimming; beyond it the strongest edges are kept and the count is exact anyway.
export const GRAPH_EDGE_LIMIT = 50_000;
// A cluster (Phase 9 D1) needs at least this many wallets funded by the same address in the window.
export const CLUSTER_MIN = 2;

export type GraphNode = {
  id: string;
  label: string | null; // token symbol or known-contract label; never a guessed identity
  kind: "contract" | "address";
  transfers: number; // transfers sent and received in the view
  tx_sent: number; // transactions the address sent in the span
  gas_volume: number;
  avg_fee_usd: number | null; // as sender; the node color (D3)
  fail_rate: number | null;
  cluster: string | null; // funder address of its group (D1)
};

// s and t index `nodes`. eth: native value moved; tokens: token contracts moved along the edge (at most 5).
export type GraphEdge = { s: number; t: number; n: number; eth: number; tokens: string[] };
export type GraphCluster = { funder: string; size: number; shown: number };

export type GraphResponse = {
  mode: GraphMode | "wallet";
  window: CityWindowInfo;
  center: string | null;
  token: { address: string; symbol: string | null } | null;
  hops: 1 | 2;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  total_nodes: number;
  cap: number;
  trimmed: boolean;
  fee_top: number | null; // top of the fee color scale (95th percentile, as in Flow)
  n: number; // transfers the view rests on
  code_checked: number; // addresses whose contract status was read from the chain (F67)
  // Ingested blocks in the window against the chain's blocks in it (KL-28 sampling); null for the wallet graph.
  blocks: { covered: number; expected: number | null } | null;
  tokens: { address: string; symbol: string | null; n: number }[]; // tokens moved in the window, for token flow
  coverage: Coverage;
  filters: Filters;
  subsidy_end: string;
  generated_at: string;
};

// Node color: the cost scale of the average fee the address paid, against the top of the scale in view (Phase 9 D3).
export function nodeColors(d: Pick<GraphResponse, "nodes" | "fee_top">): string[] {
  const top = d.fee_top ?? 0;
  return d.nodes.map((n) => cssColor(n.avg_fee_usd === null || !top ? NO_FEE_RGB : costColor(Math.min(1, n.avg_fee_usd / top))));
}

const FORBIDDEN = /\b(sybil|bot|fraud|scam|farm(er)?|whale|insider|owner|team)\b/i;

// "Funded by 0xabc…1234 in this window (5 wallets)": the only group label the Graph writes (Phase 9 D1, PROJECT.md 24.8).
export function clusterLabel(c: { funder: string; size: number }, where = "in this window"): string {
  const text = `Funded by ${shortHex(c.funder)} ${where} (${c.size} wallet${c.size === 1 ? "" : "s"})`;
  if (FORBIDDEN.test(text)) throw new Error("cluster label must not carry an identity or intent claim");
  return text;
}
