"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMetric } from "../../lib/city.ts";
import { clusterLabel, type GraphResponse } from "../../lib/graph.ts";
import { useReducedMotion } from "../hooks.ts";
import { shortHex } from "../../lib/format.ts";
import { GraphCanvas, nodeName } from "./GraphCanvas.tsx";
import { GraphTable } from "./GraphTable.tsx";

// Ego graph of a wallet (PROJECT.md 15): its newest transfers in the ingested data, one hop, drawn by the same canvas
// as the Graph lens (Phase 9). The counterparty tables on the page stay as the table version.

const int = new Intl.NumberFormat("en-US");

export function WalletGraph({ data }: { data: GraphResponse }) {
  const reduced = useReducedMotion();
  const [view, setView] = useState<"graph" | "table">("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const node = selected ? data.nodes.find((n) => n.id === selected) : undefined;
  const seg = (on: boolean) => `px-[11px] py-1 text-[12px] capitalize first:border-r first:border-line ${on ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`;

  if (!data.nodes.length) return <p className="text-[12px] text-mute">No transfers of this address in the ingested blocks, so there is no graph to draw.</p>;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[12px] text-mute">
        <div className="inline-flex overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="View">
          {(["graph", "table"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={seg(view === v)}>
              {v}
            </button>
          ))}
        </div>
        <span>
          {int.format(data.n)} transfers, {int.format(data.nodes.length)} addresses
          {data.trimmed ? `, of ${int.format(data.total_nodes)} (the rest are trimmed, cap ${int.format(data.cap)})` : ""}. Color is the average fee an address paid; the wallet is pinned in the middle.
        </span>
      </div>
      <div className="relative h-[420px] overflow-hidden rounded-[3px] border border-line bg-bg">
        {view === "graph" ? (
          <GraphCanvas data={data} metric="tx_count" selected={selected} onSelect={setSelected} onOpen={(id) => (window.location.href = `/wallet/${id}`)} reduced={reduced} label={`Ego graph of ${shortHex(data.center ?? "")}`} />
        ) : (
          <GraphTable data={data} selected={selected} onSelect={setSelected} inline />
        )}
      </div>
      <p className="mt-2 min-h-5 text-[12px] text-mute" role="status">
        {node ? (
          <>
            <span className="font-mono text-text">{nodeName(node)}</span>: {int.format(node.transfers)} transfers, avg fee paid {formatMetric(node.avg_fee_usd, "avg_fee_usd")}
            {node.cluster ? `; ${clusterLabel({ funder: node.cluster, size: data.clusters.find((c) => c.funder === node.cluster)?.size ?? 0 })}` : ""}.{" "}
            <Link className="text-text underline decoration-mute underline-offset-2 hover:decoration-text" href={`/wallet/${node.id}`} prefetch={false}>
              Open its profile
            </Link>
            {" · "}
            <Link className="text-text underline decoration-mute underline-offset-2 hover:decoration-text" href={`/lens/graph?gmode=ego&addr=${node.id}&sel=address%3A${node.id}`} prefetch={false}>
              Open it in the Graph lens
            </Link>
          </>
        ) : (
          "Click an address to see its figures. Double-click opens its profile."
        )}
      </p>
      <p className="text-[11px] text-mute">Covers the newest transfers Metro has ingested, from {data.window.start?.slice(0, 16).replace("T", " ")} to {data.window.end?.slice(0, 16).replace("T", " ")} UTC. Groups are wallets funded by the same address in that span, a pattern and not an identity.</p>
    </div>
  );
}
