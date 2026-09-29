"use client";

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useMemo } from "react";
import { nodeColors, type GraphResponse } from "../../lib/graph.ts";

// The landing's Graph picture (landing file line 461): the live top addresses of the last 24 h, laid out once with
// d3-force (60 nodes, a few hundred ticks, so it costs nothing on the main thread). Color is the average fee paid
// (Phase 9 D3); size is the transfers.

type N = SimulationNodeDatum & { i: number; r: number };
const W = 400;
const H = 300;

export function GraphArt({ d }: { d: GraphResponse | null }) {
  const laid = useMemo(() => {
    if (!d) return null;
    // A small picture keeps only the addresses that have a line to another one in it; the rest would float alone.
    const linked = new Set(d.edges.flatMap((e) => [e.s, e.t]));
    const keep = d.nodes.map((_, i) => i).filter((i) => linked.has(i));
    if (keep.length < 2) return null;
    const at = new Map(keep.map((old, i) => [old, i]));
    const max = Math.max(1, ...keep.map((i) => d.nodes[i]?.transfers ?? 0));
    const nodes: N[] = keep.map((old, i) => ({ i, r: 3.5 + 9 * Math.sqrt((d.nodes[old]?.transfers ?? 0) / max) }));
    const edges = d.edges.filter((e) => at.has(e.s) && at.has(e.t)).map((e) => ({ s: at.get(e.s) ?? 0, t: at.get(e.t) ?? 0, n: e.n }));
    const links: SimulationLinkDatum<N>[] = edges.map((e) => ({ source: e.s, target: e.t }));
    const sim = forceSimulation(nodes)
      .force("link", forceLink<N, SimulationLinkDatum<N>>(links).distance(44).strength(0.5))
      .force("charge", forceManyBody<N>().strength(-110))
      .force("collide", forceCollide<N>((n) => n.r + 2.5))
      // Weak gravity keeps groups that share no link close to the rest, so the picture stays readable.
      .force("x", forceX<N>(0).strength(0.14))
      .force("y", forceY<N>(0).strength(0.14))
      .stop();
    sim.tick(300);
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const k = Math.min((W - 40) / Math.max(1, x1 - x0), (H - 40) / Math.max(1, y1 - y0));
    const place = (n: N) => ({ x: W / 2 + ((n.x ?? 0) - (x0 + x1) / 2) * k, y: H / 2 + ((n.y ?? 0) - (y0 + y1) / 2) * k });
    const all = nodeColors(d);
    return { nodes: nodes.map((n) => ({ ...place(n), r: n.r })), edges, colors: keep.map((old) => all[old] ?? "#3a4152"), ids: keep.map((old) => d.nodes[old]?.id ?? String(old)) };
  }, [d]);

  if (!d) return <p className="text-[15px] text-mute">Loading live data…</p>;
  if (!laid) return <p className="text-[15px] text-mute">No transfers in the ingested blocks of the last 24 hours.</p>;
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Live Graph: ${laid.nodes.length} of the most active addresses of the last 24 hours and ${laid.edges.length} links between them`} className="h-auto max-h-[340px] w-full">
        {laid.edges.map((e, k) => {
          const a = laid.nodes[e.s];
          const b = laid.nodes[e.t];
          return a && b ? <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a3140" strokeWidth={0.6 + Math.log1p(e.n) * 0.3} /> : null;
        })}
        {laid.nodes.map((n, i) => (
          <circle key={laid.ids[i]} cx={n.x} cy={n.y} r={n.r} fill={laid.colors[i]} />
        ))}
      </svg>
      <figcaption className="mt-1 font-mono text-[11px] text-mute">Color: average fee an address paid. Grey: it sent nothing in the window. Size: transfers.</figcaption>
    </figure>
  );
}
