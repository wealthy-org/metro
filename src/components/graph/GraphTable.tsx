"use client";

import { useMemo, useState } from "react";
import { formatMetric } from "../../lib/city.ts";
import { clusterLabel, nodeColors, type GraphResponse } from "../../lib/graph.ts";
import { nodeName } from "./GraphCanvas.tsx";

// The Graph as a table (PROJECT.md 19: a table version of every lens): every node shown in the canvas, searchable and
// sortable, Enter or click selects it for the Inspector.

type SortKey = "transfers" | "tx_sent" | "avg_fee_usd" | "gas_volume";
const COLS: { key: SortKey; label: string }[] = [
  { key: "transfers", label: "Transfers" },
  { key: "tx_sent", label: "Sent tx" },
  { key: "avg_fee_usd", label: "Avg fee paid" },
  { key: "gas_volume", label: "Gas used" },
];
const PAGE = 300;

export function GraphTable({ data, selected, onSelect, inline = false }: { data: GraphResponse; selected: string | null; onSelect: (id: string) => void; inline?: boolean }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("transfers");
  const [limit, setLimit] = useState(PAGE);
  const colors = useMemo(() => nodeColors(data), [data]);
  const sizes = useMemo(() => new Map(data.clusters.map((c) => [c.funder, c.size])), [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => !needle || n.id.includes(needle) || (n.label ?? "").toLowerCase().includes(needle))
      .sort((a, b) => (b.n[sort] ?? -1) - (a.n[sort] ?? -1) || (a.n.id < b.n.id ? -1 : 1));
  }, [data, q, sort]);
  const th = "border-b border-line px-1.5 py-1.5 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-mute";
  const td = "border-b border-line px-1.5 py-[6px] text-right font-mono";
  return (
    <div className={`h-full overflow-auto px-3.5 pb-6 ${inline ? "pt-3" : "pt-16"}`}>
      <label className="mb-2 flex items-center gap-2 text-[12px] text-mute">
        Find
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="0x… or a token symbol" className="w-[280px] rounded-[3px] border border-line bg-panel2 px-2 py-[5px] font-mono text-[12px] text-text" />
        <span>
          {rows.length.toLocaleString("en-US")} of {data.nodes.length.toLocaleString("en-US")} nodes
        </span>
      </label>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th scope="col" className={`${th} text-left`}>
              Address
            </th>
            <th scope="col" className={`${th} text-left`}>
              Kind
            </th>
            {COLS.map((c) => (
              <th key={c.key} scope="col" className={th} aria-sort={sort === c.key ? "descending" : undefined}>
                <button type="button" onClick={() => setSort(c.key)} className={`uppercase ${sort === c.key ? "text-accent" : "hover:text-text"}`}>
                  {c.label}
                </button>
              </th>
            ))}
            <th scope="col" className={`${th} text-left`}>
              Group
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map(({ n, i }) => {
            const on = n.id === selected;
            return (
              <tr
                key={n.id}
                tabIndex={0}
                aria-current={on ? "true" : undefined}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(n.id);
                  }
                }}
                className={`cursor-pointer ${on ? "bg-panel2" : "hover:bg-panel2"}`}
              >
                <td className={`${td} text-left ${on ? "text-accent" : ""}`}>
                  <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ background: colors[i] }} aria-hidden="true" />
                  {nodeName(n)}
                </td>
                <td className="border-b border-line px-1.5 py-[6px] text-left text-mute">{n.kind === "contract" ? "Contract" : "Address"}</td>
                <td className={td}>{n.transfers.toLocaleString("en-US")}</td>
                <td className={td}>{n.tx_sent.toLocaleString("en-US")}</td>
                <td className={td}>{formatMetric(n.avg_fee_usd, "avg_fee_usd")}</td>
                <td className={td}>{formatMetric(n.gas_volume, "gas_volume")}</td>
                <td className="border-b border-line px-1.5 py-[6px] text-left text-mute">{n.cluster ? clusterLabel({ funder: n.cluster, size: sizes.get(n.cluster) ?? 0 }) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > limit ? (
        <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="mt-3 rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute">
          Show {Math.min(PAGE, rows.length - limit)} more
        </button>
      ) : null}
    </div>
  );
}
