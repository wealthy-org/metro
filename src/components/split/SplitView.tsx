"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { WindowFigures } from "../../engine/subsidy.ts";
import type { CityBuilding } from "../../lib/city.ts";
import { actionLabel, costColor, cssColor, MAX_HEIGHT, MIN_HEIGHT, NO_FEE_RGB } from "../../lib/city.ts";
import { formatDay, formatUsdCompact, NA, shortHex } from "../../lib/format.ts";
import type { TokenCompare, TokenSide } from "../../server/compare.ts";
import type { SubsidyResponse } from "../../server/subsidy.ts";
import { lensDataUrl, type ViewState } from "../../lib/view-state.ts";
import { usePolling, useReducedMotion } from "../hooks.ts";
import { POLL_MS, StageOverlay, useWebGl, type Chip, type StageInfo } from "../stage.tsx";
import { CameraSync } from "../city/camera-sync.ts";
import { change, CompareTable, CoverageNote, BeforeAfterBars, perBlock, share, usd } from "../subsidy/SubsidyParts.tsx";

// Split lens (PROJECT.md 10.7, 11.4; Phase 8 D4, D5). Two windows: two City panes with one shared camera, one building
// per action type, height = transactions per covered block and color = average fee on one scale for both panes, the
// two largest changes outlined; the prototype's before vs after table and fee bars under them. Two tokens: the same
// columns for two Pons tokens over one window. Every figure is a rate over sampled blocks (KL-28) and says so.

const CityScene = dynamic(() => import("../city/CityScene.tsx"), { ssr: false });
const DAY_MS = 86_400_000;
const int = new Intl.NumberFormat("en-US");

type Base = { coverage: { first: string | null; last: string | null }; subsidy_end: string; min_sample: number };
type WindowsData = SubsidyResponse & Base & { cmp: "windows" };
type TokensData = TokenCompare & Base & { cmp: "tokens"; window_param: string };
type Side = "before" | "after";

// What the Inspector shows for a Split selection (gate F55, option a): the Inspector's 7d or 30d window anchored at the
// end of the pane window's last day, which is exactly that window when it is 7 or 30 whole UTC days and its last day
// has ingested blocks. Otherwise a note says why the Inspector cannot show it, and the table carries the figures.
export type SplitInspect = { window: "7d" | "30d"; at: string } | { note: string };

const lastDay = (w: { end: string }) => new Date(Date.parse(w.end) - DAY_MS).toISOString().slice(0, 10);
const range = (w: { start: string; end: string }) => `${formatDay(w.start.slice(0, 10))} to ${formatDay(lastDay(w))}`;

function inspectFor(w: WindowFigures, side: Side): SplitInspect {
  const last = lastDay(w);
  if (w.days_total !== 7 && w.days_total !== 30) return { note: `The Inspector reads windows of 7 or 30 whole days, and the ${side} window has ${w.days_total}. The table beside it has the figures for this window.` };
  if (!w.days.some((d) => d.date === last && d.blocks > 0)) return { note: `No block of ${formatDay(last)} is ingested yet, so the Inspector cannot show the ${side} window as a whole. The table beside it has what is ingested.` };
  return { window: w.days_total === 7 ? "7d" : "30d", at: `${last}T23:59Z` };
}

function WindowPicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [a = "", b = ""] = value.split("..");
  const [issue, setIssue] = useState<string | null>(null);
  const set = (s: string, e: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return;
    if (s > e) return setIssue("The last day must be on or after the first day.");
    if ((Date.parse(e) - Date.parse(s)) / DAY_MS + 1 > 31) return setIssue("A window covers at most 31 days.");
    setIssue(null);
    onChange(`${s}..${e}`);
  };
  const field = "rounded-[3px] border border-line bg-panel px-2 py-1 font-mono text-[12px] text-text [color-scheme:dark]";
  const id = `win-${label.toLowerCase()}-issue`;
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5 text-[12px] text-mute">
      <legend className="sr-only">{label} window</legend>
      <span className="w-[46px] text-[11px] tracking-[0.08em] uppercase">{label}</span>
      <input type="date" aria-label={`${label} window, first day`} aria-describedby={issue ? id : undefined} value={a} onChange={(e) => set(e.target.value, b)} className={field} />
      <span>to</span>
      <input type="date" aria-label={`${label} window, last day`} aria-describedby={issue ? id : undefined} value={b} onChange={(e) => set(a, e.target.value)} className={field} />
      {issue ? (
        <span id={id} role="alert" className="text-[11px] text-c1">
          {issue}
        </span>
      ) : null}
    </fieldset>
  );
}

function Pane({ title, sub, buildings, heights, colors, labels, marked, selected, onSelect, cam, nonce, reduced, sync, onLost }: {
  title: string;
  sub: string;
  buildings: CityBuilding[];
  heights: number[];
  colors: [number, number, number][];
  labels: string[];
  marked: number[];
  selected: number;
  onSelect: (i: number) => void;
  cam: ViewState["cam"];
  nonce: number;
  reduced: boolean;
  sync: CameraSync;
  onLost: () => void;
}) {
  return (
    <figure className="relative min-h-0 overflow-hidden rounded-[3px] border border-line">
      <figcaption className="absolute top-2 left-2.5 z-10 rounded-[3px] border border-line bg-panel px-2 py-1 text-[11px]">
        <b className="font-medium">{title}</b> <span className="font-mono text-mute">{sub}</span>
      </figcaption>
      <CityScene
        buildings={buildings}
        heights={heights}
        colors={colors}
        metric="tx_count"
        selectedIndex={selected}
        preset={cam}
        presetNonce={nonce}
        reducedMotion={reduced}
        onSelect={onSelect}
        onHover={() => {}}
        onContextLost={onLost}
        vehicles={null}
        vehiclesMoving={false}
        valueLabels={labels}
        marked={marked}
        cameraSync={sync}
      />
    </figure>
  );
}

function WindowsMode({ d, state, onChange, onInspect }: { d: WindowsData; state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInspect: (i: SplitInspect | null) => void }) {
  const [gl, setGl] = useWebGl();
  const reduced = useReducedMotion();
  const [nonce, setNonce] = useState(0);
  const [side, setSide] = useState<Side>("before");
  const sync = useMemo(() => new CameraSync(), []);
  const selected = state.sel?.kind === "action" ? state.sel.key : null;

  // The Inspector follows the pane last clicked (or the window picked beside the table).
  const inspect = inspectFor(side === "before" ? d.before : d.after, side);
  const inspectKey = JSON.stringify(inspect);
  useEffect(() => {
    onInspect(JSON.parse(inspectKey) as SplitInspect);
  }, [inspectKey, onInspect]);

  // One scale for both panes: heights by transactions per block, colors by average fee.
  const actions = [d.before.actions, d.after.actions];
  const maxRate = Math.max(1e-9, ...actions.flat().map((a) => a.tx_per_block ?? 0));
  const maxFee = Math.max(1e-9, ...actions.flat().map((a) => a.avg_fee_usd ?? 0));
  const buildings = (list: typeof d.before.actions): CityBuilding[] =>
    list.map((a) => ({ kind: "action", key: a.key, label: actionLabel(a.key), tx_count: a.tx, gas_volume: 0, avg_fee_usd: a.avg_fee_usd, wallets: null, fail_rate: null }));
  const heights = (list: typeof d.before.actions) => list.map((a) => (a.tx_per_block ? MIN_HEIGHT + (a.tx_per_block / maxRate) * (MAX_HEIGHT - MIN_HEIGHT) : MIN_HEIGHT));
  const colors = (list: typeof d.before.actions) => list.map((a) => (a.avg_fee_usd === null ? NO_FEE_RGB : costColor(a.avg_fee_usd / maxFee)));
  const labels = (list: typeof d.before.actions) => list.map((a) => (a.tx_per_block === null ? NA : `${perBlock(a.tx_per_block)} / block`));
  // The two largest relative changes of transactions per block (PROJECT.md 10.7), only where both windows hold at
  // least MIN_SAMPLE transactions of the action, so a rare action never wins on noise (gate F57).
  const marked = d.before.actions
    .map((b, i) => {
      const a = d.after.actions[i];
      const ok = b.tx >= d.min_sample && (a?.tx ?? 0) >= d.min_sample && b.tx_per_block && a?.tx_per_block;
      return { i, c: ok ? Math.abs((a!.tx_per_block! - b.tx_per_block!) / b.tx_per_block!) : -1 };
    })
    .filter((x) => x.c >= 0)
    .sort((a, b) => b.c - a.c)
    .slice(0, 2)
    .map((x) => x.i);
  const selIndex = selected ? d.before.actions.findIndex((a) => a.key === selected) : -1;
  const toggle = (key: string | undefined) => onChange({ sel: !key || key === selected ? null : { kind: "action", key } });
  const selectIn = (s: Side) => (i: number) => {
    setSide(s);
    toggle(d.before.actions[i]?.key);
  };
  const incomplete = (w: typeof d.after) => (w.days_ended < w.days_total ? `, incomplete: ${w.days_ended} of ${w.days_total} days` : "");
  const markedNames = marked.map((i) => actionLabel(d.before.actions[i]?.key ?? "")).join(" and ");
  const seg = (on: boolean) => `px-[9px] py-0.5 text-[11px] ${on ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`;

  return (
    <>
      {gl === "ok" ? (
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[12px] text-mute">
            Height: transactions per block. Color: average fee, one scale for both panes. White outline:{" "}
            {markedNames ? `the largest changes (${markedNames}), among actions with at least ${d.min_sample} transactions in each window` : `the largest changes, once both windows hold at least ${d.min_sample} transactions of an action`}. Drag either pane; both follow.
          </p>
          <div className="flex flex-none overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="Camera">
            {(["angle", "top", "street"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={state.cam === p}
                onClick={() => {
                  onChange({ cam: p });
                  setNonce((n) => n + 1);
                }}
                className={`border-r border-line px-[11px] py-1 text-[12px] capitalize last:border-r-0 ${state.cam === p ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {gl === "ok" ? (
        <>
          <div className="grid h-[360px] grid-cols-2 gap-2">
            {([
              ["before", "Before", d.before],
              ["after", "After", d.after],
            ] as const).map(([s, t, w], k) => (
              <Pane
                key={s}
                title={t}
                sub={`${range(w)}${incomplete(w)}`}
                buildings={buildings(actions[k] ?? [])}
                heights={heights(actions[k] ?? [])}
                colors={colors(actions[k] ?? [])}
                labels={labels(actions[k] ?? [])}
                marked={marked}
                selected={selIndex}
                onSelect={selectIn(s)}
                cam={state.cam}
                nonce={nonce}
                reduced={reduced}
                sync={sync}
                onLost={() => setGl("lost")}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-mute">
            <span>Fee scale</span>
            <span className="h-2 w-[160px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
            <span className="font-mono">$0 to {usd(maxFee)}</span>
          </div>
        </>
      ) : (
        <p role="status" className="mb-2 text-[12px] text-mute">
          {gl === "lost" ? "The 3D panes stopped; the table below shows the same figures." : "3D is unavailable in this browser; the table below shows the same figures."}
        </p>
      )}

      <div className="mt-4 mb-1.5 flex flex-wrap items-center gap-3">
        <h4 className="text-[11px] font-medium tracking-[0.08em] text-mute uppercase">Before vs after</h4>
        <div className="flex items-center gap-1.5 text-[11px] text-mute">
          <span id="split-inspect-label">Inspector shows</span>
          <div className="flex overflow-hidden rounded-[3px] border border-line" role="group" aria-labelledby="split-inspect-label">
            {(["before", "after"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} className={`capitalize first:border-r first:border-line ${seg(side === s)}`}>
                {s}
              </button>
            ))}
          </div>
          <span>{range(side === "before" ? d.before : d.after)}</span>
        </div>
      </div>
      <CompareTable data={d} selected={selected} onSelect={(k) => toggle(k)} />
      <div className="mt-4">
        <BeforeAfterBars data={d} metric="avg_fee_usd" />
      </div>
    </>
  );
}

const TOKEN_ROWS: { label: string; get: (t: TokenSide) => number | null; fmt: (v: number | null) => string; rate?: boolean }[] = [
  { label: "Transactions moving it", get: (t) => t.tx, fmt: (v) => (v === null ? NA : int.format(v)) },
  { label: "Swaps", get: (t) => t.swaps, fmt: (v) => (v === null ? NA : int.format(v)) },
  { label: "Senders", get: (t) => t.senders, fmt: (v) => (v === null ? NA : int.format(v)) },
  { label: "Avg fee", get: (t) => t.avg_fee_usd, fmt: usd },
  { label: "Median fee", get: (t) => t.median_fee_usd, fmt: usd },
  { label: "Holders", get: (t) => t.holders, fmt: (v) => (v === null ? NA : int.format(v)) },
  { label: "Top 10 hold (pool left out)", get: (t) => t.top10_share, fmt: (v) => share(v), rate: true },
  { label: "In pool", get: (t) => t.pool_share, fmt: (v) => share(v), rate: true },
  { label: "Volume 24h (GeckoTerminal, now)", get: (t) => t.volume_24h_usd, fmt: (v) => (v === null ? NA : formatUsdCompact(v)) },
];

function TokensMode({ d, onChange, state }: { d: TokensData; state: ViewState; onChange: (patch: Partial<ViewState>) => void }) {
  const pick = (k: "ta" | "tb", v: string) => onChange({ split: { ...state.split, [k]: v || null } });
  const sel = "rounded-[3px] border border-line bg-panel px-2 py-1 font-mono text-[12px] text-text";
  const label = (t: TokenSide | null) => (t ? t.symbol || shortHex(t.address) : NA);
  if (d.candidates.length < 2) return <p className="text-mute">Fewer than two Pons tokens moved in this window&apos;s ingested blocks, so there is nothing to compare.</p>;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mute">
        {(["ta", "tb"] as const).map((k, i) => (
          <label key={k} className="flex items-center gap-1.5">
            Token {i + 1}
            <select aria-label={`Token ${i + 1}`} value={(i === 0 ? d.a?.address : d.b?.address) ?? ""} onChange={(e) => pick(k, e.target.value)} className={sel}>
              {d.candidates.map((c) => (
                <option key={c.address} value={c.address}>
                  {c.symbol ?? shortHex(c.address)} ({int.format(c.tx)} tx)
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <table className="w-full max-w-[720px] border-collapse text-[12px]">
        <thead>
          <tr className="text-[10px] tracking-[0.08em] text-mute uppercase">
            <th scope="col" className="border-b border-line px-1.5 py-1.5 text-left font-medium">
              In {range(d.window)}
            </th>
            {[d.a, d.b].map((t, i) => (
              <th key={i} scope="col" className="border-b border-line px-1.5 py-1.5 text-right font-medium">
                {label(t)}
              </th>
            ))}
            <th scope="col" className="border-b border-line px-1.5 py-1.5 text-right font-medium" title="Second token against the first">
              Difference
            </th>
          </tr>
        </thead>
        <tbody>
          {TOKEN_ROWS.map((r) => {
            const a = d.a ? r.get(d.a) : null;
            const b = d.b ? r.get(d.b) : null;
            const diff = r.rate ? (a === null || b === null ? NA : `${((b - a) * 100 > 0 ? "+" : "")}${((b - a) * 100).toFixed(1)} pt`) : change(a, b).text;
            return (
              <tr key={r.label}>
                <td className="border-b border-line px-1.5 py-[7px]">{r.label}</td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{r.fmt(a)}</td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{r.fmt(b)}</td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono text-mute">{diff}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 max-w-[80ch] text-[11px] text-mute">
        Activity is counted in the ingested blocks of the window, which are sampled (12 slices of 30 blocks per day). Holders are measured at the end of the window from the transfers Metro has ingested{d.a?.holders_complete === false || d.b?.holders_complete === false ? "; some are partial because blocks since the launch are missing" : ""}.
      </p>
    </>
  );
}

export function SplitView({ state, onChange, onInfo, onInspect }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; onInspect: (i: SplitInspect | null) => void; notice: Chip | null }) {
  const s = state.split;
  const res = usePolling<WindowsData | TokensData>(lensDataUrl("split", state), POLL_MS * 4);
  const d = res.data && res.data.cmp === s.cmp ? res.data : null;

  // The scrubber shows the ingested coverage; Split has its own windows and does not move with it.
  useEffect(() => {
    if (res.data) onInfo({ coverage: res.data.coverage, subsidy_end: res.data.subsidy_end });
  }, [res.data, onInfo]);
  // Token mode selects no building; until the windows load, the Inspector waits rather than read another window.
  useEffect(() => {
    if (s.cmp === "tokens") onInspect({ note: "Token mode has no building to inspect; the table compares the two tokens." });
    else if (!d) onInspect(null);
  }, [s.cmp, d, onInspect]);

  const beforeValue = s.before ?? (d && d.cmp === "windows" ? d.windows.before : d && d.cmp === "tokens" ? d.window_param : "");
  const afterValue = s.after ?? (d && d.cmp === "windows" ? d.windows.after : "");
  const seg = (on: boolean) => `px-[11px] py-1 text-[12px] ${on ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`;

  return (
    <div className="min-h-0 overflow-auto px-[22px] py-[18px]">
      <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Split: {s.cmp === "windows" ? "before and after the rebate" : "two Pons tokens"}</h3>
      <div className="mt-2 mb-2 flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-[3px] border border-line" role="group" aria-label="Compare">
          <button type="button" aria-pressed={s.cmp === "windows"} onClick={() => onChange({ split: { ...s, cmp: "windows" } })} className={seg(s.cmp === "windows")}>
            Two windows
          </button>
          <button type="button" aria-pressed={s.cmp === "tokens"} onClick={() => onChange({ split: { ...s, cmp: "tokens", before: null } })} className={`border-l border-line ${seg(s.cmp === "tokens")}`}>
            Two tokens
          </button>
        </div>
        {beforeValue ? <WindowPicker label={s.cmp === "windows" ? "Before" : "Window"} value={beforeValue} onChange={(v) => onChange({ split: { ...s, before: v } })} /> : null}
        {s.cmp === "windows" && afterValue ? <WindowPicker label="After" value={afterValue} onChange={(v) => onChange({ split: { ...s, after: v } })} /> : null}
        {s.before || s.after ? (
          <button type="button" onClick={() => onChange({ split: { ...s, before: null, after: null } })} className="rounded-[3px] border border-line bg-panel2 px-[11px] py-1 text-[12px] text-text hover:border-mute">
            {s.cmp === "windows" ? "Back to 7 days either side of the end" : "Back to the last 7 days"}
          </button>
        ) : null}
      </div>

      {res.status === "error" && !d ? <p role="status" className="text-c2">Split data is unavailable. Retrying every minute.</p> : null}
      {res.status === "error" && d ? <p role="status" className="mb-2 text-[11px] text-c2">Refresh failed; showing the last data.</p> : null}
      {res.status === "loading" && !d ? <StageOverlay text={s.cmp === "windows" ? "Loading the two windows…" : "Loading the two tokens…"} /> : null}

      {d && d.cmp === "windows" ? (
        <>
          <CoverageNote data={d} />
          <WindowsMode d={d} state={state} onChange={onChange} onInspect={onInspect} />
          <p className="mt-3 text-[11px] text-mute">
            Paid share is an estimate (subsidy heuristic, ArbOS internal transactions left out).{" "}
            <a href="/subsidy" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
              The Subsidy Cliff page
            </a>{" "}
            has the timeline, the classes and the method.
          </p>
        </>
      ) : null}
      {d && d.cmp === "tokens" ? <TokensMode d={d} state={state} onChange={onChange} /> : null}
    </div>
  );
}
