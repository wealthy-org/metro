"use client";

import { useEffect, useState } from "react";
import { costColor, cssColor, formatMetric } from "../../lib/city.ts";
import { GRAPH_NODE_CAP, type GraphResponse } from "../../lib/graph.ts";
import { shortHex } from "../../lib/format.ts";
import { dataQuery, type GraphMode, type ViewState } from "../../lib/view-state.ts";
import { Segmented } from "../controls/Toolbar.tsx";
import { usePolling, useReducedMotion } from "../hooks.ts";
import { POLL_MS, scopeNote, StageChips, StageOverlay, type Chip, type StageInfo } from "../stage.tsx";
import { GraphCanvas, type GraphSizeMetric } from "./GraphCanvas.tsx";
import { GraphTable } from "./GraphTable.tsx";

// Graph lens (PROJECT.md 10.4; Phase 9): addresses as nodes, transfers as lines, over 1 h or 24 h (D2). Modes: top
// clusters, the ego graph of one address, the flow of one token. At most 1,500 nodes, and the lens says when it trims
// (AT 13). Groups: wallets funded by the same address in the window (D1). Colors: the cost scale (D3).

const int = new Intl.NumberFormat("en-US");
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MODES: { key: GraphMode; label: string }[] = [
  { key: "top", label: "Top clusters" },
  { key: "ego", label: "Ego graph" },
  { key: "token", label: "Token flow" },
];
const SIZE_LABEL: Record<GraphSizeMetric, string> = { tx_count: "transfers sent and received", gas_volume: "gas used as sender", fail_rate: "share of its transactions that failed" };

export function GraphView({ state, onChange, onInfo, notice }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; notice: Chip | null }) {
  const g = state.graph;
  const reduced = useReducedMotion();
  const [view, setView] = useState<"graph" | "table">("graph");
  const [draft, setDraft] = useState(g.addr ?? "");
  const [draftIssue, setDraftIssue] = useState<string | null>(null);
  useEffect(() => setDraft(g.addr ?? ""), [g.addr]);

  // Token flow without a token asks for the top view only to list the tokens moved in the window.
  const waiting = (g.mode === "ego" && !g.addr) || (g.mode === "token" && !g.token);
  const q = new URLSearchParams(dataQuery(state));
  if (g.mode === "ego" && g.addr) {
    q.set("mode", "ego");
    q.set("addr", g.addr);
    q.set("hops", String(g.hops));
  } else if (g.mode === "token" && g.token) {
    q.set("mode", "token");
    q.set("gtoken", g.token);
  }
  const url = g.mode === "ego" && !g.addr ? null : `/api/lens/graph/data?${q.toString()}`;
  const res = usePolling<GraphResponse>(url, state.at ? null : POLL_MS * 4);
  const d = res.data;
  const shown = d && !waiting ? d : null;

  useEffect(() => {
    if (d) onInfo({ coverage: d.coverage, subsidy_end: d.subsidy_end });
  }, [d, onInfo]);

  const selected = state.sel?.kind === "address" ? state.sel.key : null;
  const select = (id: string | null) => onChange({ sel: id ? { kind: "address", key: id } : null });
  const openEgo = (id: string) => onChange({ graph: { ...g, mode: "ego", addr: id }, sel: { kind: "address", key: id } });
  const metric = state.metric as GraphSizeMetric;

  let overlay: string | null = null;
  if (g.mode === "ego" && !g.addr) overlay = "Pick an address: type or paste one below, or double-click a node in Top clusters.";
  else if (g.mode === "token" && !g.token) overlay = d ? (d.tokens.length ? "Pick a token below to trace its transfers." : "No token moved in this window.") : null;
  if (!overlay) {
    if (res.status === "loading" && !d) overlay = "Loading the graph…";
    else if (res.status === "error" && !d) overlay = "Graph data is unavailable. Retrying every minute.";
    else if (shown && !shown.window.start) overlay = "No blocks ingested yet.";
    else if (shown && shown.nodes.length === 0)
      overlay = g.mode === "ego" ? "This address has no transfers in this window and filter. Pick 24 h or clear filters." : "No transfers in this window and filter. Pick 24 h, clear filters or move the scrubber.";
  }

  const scope = shown ? scopeNote({ window: shown.window, n: shown.n, filters: shown.filters }) : null;
  const cover = shown?.blocks && shown.blocks.expected ? shown.blocks.covered / shown.blocks.expected : null;
  const sampled =
    shown?.blocks && cover !== null && cover < 0.95
      ? `Sampled: ${int.format(shown.blocks.covered)} of about ${int.format(shown.blocks.expected ?? 0)} blocks in this window (${(cover * 100).toFixed(2)}%). Transfers outside them are not drawn.`
      : null;
  const trimmedText = shown?.trimmed ? `Showing ${int.format(shown.nodes.length)} of ${int.format(shown.total_nodes)} addresses; the rest are trimmed (cap ${int.format(shown.cap)}).` : null;
  const seg = (on: boolean) => `px-[11px] py-1.5 text-[12px] ${on ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`;

  return (
    <div className="relative min-h-0 overflow-hidden">
      {shown && shown.nodes.length ? (
        view === "graph" ? (
          <GraphCanvas data={shown} metric={metric} selected={selected} onSelect={select} onOpen={openEgo} reduced={reduced} label={`Graph of ${int.format(shown.nodes.length)} addresses and ${int.format(shown.edges.length)} links`} />
        ) : (
          <GraphTable data={shown} selected={selected} onSelect={(id) => select(id)} />
        )
      ) : null}

      <div className="absolute top-3.5 right-3.5 z-30 flex max-w-[62%] flex-col items-end gap-1.5">
        <div className="flex gap-1.5">
          <Segmented label="Graph mode" value={g.mode} options={MODES} onChange={(mode) => onChange({ graph: { ...g, mode, addr: mode === "ego" ? (g.addr ?? selected) : null, token: mode === "token" ? g.token : null } })} />
          <div className="inline-flex overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="View">
            {(["graph", "table"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={`capitalize first:border-r first:border-line ${seg(view === v)}`}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Second row at the bottom right: at 1280 px the top-left chips would otherwise cover it. */}
      <div className="absolute right-3.5 bottom-3.5 z-30 flex max-w-[62%] flex-col items-end gap-1.5">
        {g.mode === "ego" ? (
          <form
            className="flex items-center gap-1.5 rounded-[3px] border border-line bg-panel px-2 py-1.5 text-[12px] text-mute"
            onSubmit={(e) => {
              e.preventDefault();
              const a = draft.trim().toLowerCase();
              if (!ADDRESS.test(a)) return setDraftIssue("An address is 0x and 40 hex characters.");
              setDraftIssue(null);
              openEgo(a);
            }}
          >
            <label className="flex items-center gap-1.5">
              Address
              <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-describedby={draftIssue ? "ego-issue" : undefined} placeholder="0x…" className="w-[200px] rounded-[3px] border border-line bg-panel2 px-2 py-[3px] font-mono text-[12px] text-text" />
            </label>
            <button type="submit" className="rounded-[3px] border border-line bg-panel2 px-2 py-[3px] text-text hover:border-mute">
              Show
            </button>
            <Segmented label="Hops" value={String(g.hops) as "1" | "2"} options={[{ key: "1", label: "1 hop" }, { key: "2", label: "2 hops" }]} onChange={(h) => onChange({ graph: { ...g, hops: h === "2" ? 2 : 1 } })} />
            {draftIssue ? (
              <span id="ego-issue" role="alert" className="text-c1">
                {draftIssue}
              </span>
            ) : null}
          </form>
        ) : null}
        {g.mode === "token" && d ? (
          <label className="flex items-center gap-1.5 rounded-[3px] border border-line bg-panel px-2 py-1.5 text-[12px] text-mute">
            Token
            <select value={g.token ?? ""} onChange={(e) => onChange({ graph: { ...g, token: e.target.value || null } })} className="rounded-[3px] border border-line bg-panel2 px-2 py-[3px] font-mono text-[12px] text-text">
              <option value="">Pick a token</option>
              {g.token && !d.tokens.some((t) => t.address === g.token) ? <option value={g.token}>{d.token?.symbol ?? shortHex(g.token)}</option> : null}
              {d.tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol ?? shortHex(t.address)} ({int.format(t.n)} transfers)
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {selected && !(g.mode === "ego" && g.addr === selected) ? (
          <button type="button" onClick={() => openEgo(selected)} className="rounded-[3px] border border-line bg-panel2 px-[11px] py-1.5 text-[12px] text-text hover:border-mute">
            Ego graph of {shortHex(selected)}
          </button>
        ) : null}
      </div>

      <StageChips
        items={[
          scope ? { text: scope.short, title: scope.full } : null,
          trimmedText ? { text: trimmedText } : null,
          sampled ? { text: sampled } : null,
          notice,
          res.status === "error" && d ? { text: "Refresh failed; showing the last data. Retrying.", tone: "error" } : null,
          res.stale ? { text: "Updating…", tone: "mute" } : null,
        ]}
      />

      {shown && shown.nodes.length && view === "graph" ? (
        <div className="absolute bottom-3.5 left-3.5 z-30 max-w-[300px] rounded-[3px] border border-line bg-panel px-[11px] py-[9px] text-[11px] text-mute">
          <div className="mb-1 flex items-center gap-2">
            <span>Color: avg fee paid</span>
            <span className="h-2 w-[90px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
            <span className="font-mono">{shown.fee_top === null ? "no address paid a fee here" : `$0 to ${formatMetric(shown.fee_top, "avg_fee_usd")}`}</span>
          </div>
          <p>Grey: sent nothing in the window. Size: {SIZE_LABEL[metric]}. Line: transfers between two addresses.</p>
          <p className="mt-1">Ring: wallets funded by the same address in this window, a pattern, not an identity. Lime: the selected address.</p>
          <p className="mt-1">Contract: known to Metro or with code on the chain, checked for the {int.format(shown.code_checked)} busiest addresses and the selected one.</p>
          <p className="mt-1">
            At most {int.format(GRAPH_NODE_CAP)} nodes. Click to inspect, double-click for its ego graph, {reduced ? "drag the background to pan" : "drag to move"}, scroll to zoom.
          </p>
        </div>
      ) : null}

      <StageOverlay text={overlay} />
    </div>
  );
}
