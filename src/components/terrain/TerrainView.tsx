"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerrainResponse } from "../../lib/api-types.ts";
import { costColor, cssColor } from "../../lib/city.ts";
import { bucketMs, formatValue, TERRAIN_BUCKETS, timeLabel } from "../../lib/lenses.ts";
import { dataQuery, isoMinuteDate, isShortWindow, MAX_MARKS, metricLabel, toIsoMinute, type ViewState } from "../../lib/view-state.ts";
import { Segmented } from "../controls/Toolbar.tsx";
import { usePolling, useReducedMotion } from "../hooks.ts";
import { POLL_MS, scopeNote, StageChips, StageOverlay, useWebGl, type Chip, type StageInfo } from "../stage.tsx";
import type { TerrainHover } from "./TerrainScene.tsx";

const TerrainScene = dynamic(() => import("./TerrainScene.tsx"), { ssr: false });
const DAY = 86_400_000;
const EMPTY = "#151922";

// SVG version of the same cells for browsers without WebGL (PROJECT.md 19, AT 27): rows are the Z rows, columns the
// buckets, color the metric. Row names are buttons, so the Inspector stays reachable from the keyboard.
function TerrainFallback({ data, atMs, selectedRow, onPick }: { data: TerrainResponse; atMs: number | null; selectedRow: number; onPick: (row: number, bucket: number) => void }) {
  const max = data.max && data.max > 0 ? data.max : 1;
  const step = bucketMs(data.bucket);
  const cols = data.buckets.length;
  const w = 640;
  const cw = cols ? w / cols : w;
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-1">
      {data.rows.map((r, i) => (
        <div key={`${r.kind}:${r.key}`} className="contents">
          <button type="button" onClick={() => onPick(i, -1)} aria-pressed={i === selectedRow} className={`truncate text-left text-[12px] ${i === selectedRow ? "text-accent" : "text-text"} hover:underline`}>
            {r.label}
          </button>
          <svg viewBox={`0 0 ${w} 18`} preserveAspectRatio="none" className="h-[18px] w-full" role="img" aria-label={`${r.label}: ${r.values.filter((v) => v !== null).length} buckets with data`}>
            {r.values.map((v, b) => {
              const t = Date.parse(data.buckets[b] ?? "");
              const shown = v !== null && (atMs === null || t <= atMs);
              return (
                <rect key={b} x={b * cw} y={0} width={Math.max(cw - 0.5, 0.5)} height={18} fill={shown ? cssColor(costColor(v / max)) : EMPTY}>
                  <title>{`${timeLabel(t)} to ${timeLabel(t + step)} UTC: ${shown ? formatValue(v, data.metric) : "no data"}`}</title>
                </rect>
              );
            })}
          </svg>
        </div>
      ))}
    </div>
  );
}

export function TerrainView({ state, onChange, onInfo, notice }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; notice: Chip | null }) {
  // The surface covers the live window; the scrubber time blanks what comes after it instead of refetching.
  const query = dataQuery({ ...state, at: null }, { metric: state.metric, rows: state.rows });
  const t = usePolling<TerrainResponse>(`/api/lens/terrain/data?${query}`, state.at ? null : POLL_MS);
  const reducedMotion = useReducedMotion();
  const [gl, setGl] = useWebGl();
  const [sceneKey, setSceneKey] = useState(0);
  const [presetNonce, setPresetNonce] = useState(0);
  const [hover, setHover] = useState<{ row: number; bucket: number; x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const d = t.data;

  useEffect(() => {
    if (d) onInfo({ coverage: d.coverage, subsidy_end: d.subsidy_end });
  }, [d, onInfo]);

  const onHover = useCallback((h: TerrainHover) => {
    const rect = stage.current?.getBoundingClientRect();
    setHover(h && rect ? { row: h.row, bucket: h.bucket, x: h.clientX - rect.left, y: h.clientY - rect.top } : null);
  }, []);

  const atMs = state.at ? isoMinuteDate(state.at).getTime() + 59_999 : null;
  const marks = useMemo(() => state.marks.map((m) => isoMinuteDate(m).getTime()), [state.marks]);
  const sel = state.sel && state.sel.kind !== "hour" ? state.sel : null;
  const selectedRow = d && sel ? d.rows.findIndex((r) => r.kind === sel.kind && r.key === sel.key) : -1;

  const pick = (row: number, bucket: number) => {
    const r = d?.rows[row];
    if (!d || !r) return;
    const patch: Partial<ViewState> = { sel: { kind: r.kind, key: r.key } };
    if (bucket >= 0) {
      // The scrubber moves to the end of the picked bucket (prototype: a picked cell sets the view time).
      const end = Date.parse(d.buckets[bucket] ?? "") + bucketMs(d.bucket) - 60_000;
      const last = d.coverage.last ? Date.parse(d.coverage.last) : end;
      patch.at = end >= last ? null : toIsoMinute(end);
    }
    onChange(patch);
  };

  const step = d ? bucketMs(d.bucket) : 0;
  const start = d?.buckets.length ? Date.parse(d.buckets[0] ?? "") : null;
  const end = start !== null && d ? start + d.buckets.length * step : null;
  const cliff = d ? Date.parse(d.subsidy_end) : null;
  const cliffDay = cliff !== null ? timeLabel(cliff).slice(0, 6) : "";
  const cliffNote =
    cliff === null || start === null || end === null
      ? null
      : cliff > end
        ? `${cliffDay}, the end of the rebate: ${Math.ceil((cliff - end) / DAY)} day${Math.ceil((cliff - end) / DAY) === 1 ? "" : "s"} after this window`
        : cliff < start
          ? `${cliffDay}, the end of the rebate: ${Math.ceil((start - cliff) / DAY)} days before this window`
          : null;

  const hovered = d && hover ? d.rows[hover.row] : undefined;
  const hoverValue = hovered && hover ? (hovered.values[hover.bucket] ?? null) : null;
  const hoverTime = d && hover ? Date.parse(d.buckets[hover.bucket] ?? "") : 0;
  const hoverShown = hoverValue !== null && (atMs === null || hoverTime <= atMs);
  const label = metricLabel(state.metric);

  let overlay: string | null = null;
  if (t.status === "loading" && !d) overlay = "Loading the terrain…";
  else if (t.status === "error" && !d) overlay = "Terrain data is unavailable. Retrying every 15 seconds.";
  else if (d && !d.window.start) overlay = "No blocks ingested yet. Start the Collector to raise the terrain.";
  else if (d && d.n === 0) overlay = "No transactions in this window and filter.";
  else if (d && atMs !== null && start !== null && atMs < start) overlay = "The scrubber is before this window, so the whole surface is blank. Move it later or pick a longer window.";

  const scope = d ? scopeNote(d, `, ${TERRAIN_BUCKETS[state.window].label} buckets`) : null;
  const newest = d?.coverage.last ? toIsoMinute(Date.parse(d.coverage.last)) : null;
  const markAt = state.at ?? newest;

  return (
    <div ref={stage} className={`relative min-h-0 overflow-hidden ${hovered ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}>
      {gl === "ok" && d ? (
        <TerrainScene
          key={sceneKey}
          data={d}
          atMs={atMs}
          marks={marks}
          selectedRow={selectedRow}
          preset={state.cam}
          presetNonce={presetNonce}
          reducedMotion={reducedMotion}
          onPick={pick}
          onHover={onHover}
          onContextLost={() => setGl("lost")}
        />
      ) : null}

      {(gl === "none" || gl === "lost") && d ? (
        <div className="absolute inset-0 overflow-auto p-6 pt-16">
          <h3 className="mb-1 font-display text-[22px] font-bold">{gl === "none" ? "3D is unavailable in this browser" : "The 3D view stopped"}</h3>
          <p className="mb-4 max-w-[60ch] text-mute">The same terrain is shown below as a grid: one row per {state.rows === "tokens" ? "token" : "action type"}, one cell per time bucket, color from the metric.</p>
          {gl === "lost" ? (
            <button
              type="button"
              className="mb-4 rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute"
              onClick={() => {
                setSceneKey((k) => k + 1);
                setGl("ok");
              }}
            >
              Restart 3D
            </button>
          ) : null}
          <TerrainFallback data={d} atMs={atMs} selectedRow={selectedRow} onPick={pick} />
        </div>
      ) : null}

      {gl === "ok" ? (
        <div className="absolute top-3.5 right-3.5 z-30 flex overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="Camera">
          {(["angle", "top", "street"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={state.cam === p}
              onClick={() => {
                onChange({ cam: p });
                setPresetNonce((n) => n + 1);
              }}
              className={`border-r border-line px-[11px] py-1.5 text-[12px] capitalize last:border-r-0 ${state.cam === p ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`}
            >
              {p}
            </button>
          ))}
        </div>
      ) : null}

      <div className="absolute top-[52px] right-3.5 z-30 bg-panel">
        <Segmented
          label="Terrain rows"
          value={state.rows}
          options={[
            { key: "actions", label: "Action types" },
            { key: "tokens", label: "Pons tokens", disabled: isShortWindow(state.window) ? undefined : "Token rows are available for windows of 24 h or less" },
          ]}
          onChange={(rows) => onChange({ rows })}
        />
      </div>

      <StageChips
        items={[
          scope ? { text: scope.short, title: scope.full } : null,
          notice,
          cliffNote ? { text: cliffNote } : null,
          t.status === "error" && d ? { text: "Refresh failed; showing the last data. Retrying.", tone: "error" } : null,
          t.stale ? { text: "Updating…", tone: "mute" } : null,
        ]}
      />

      <div className="absolute bottom-3.5 left-3.5 z-30 max-w-[300px] rounded-[3px] border border-line bg-panel px-[11px] py-[9px] text-[11px] text-mute">
        <div>Terrain height and color: {label}. Dark and flat: no data{state.at ? " or after the scrubber time" : ""}.</div>
        <div className="my-[5px] h-2 w-[180px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
        <div className="flex w-[180px] justify-between font-mono">
          <span>{d?.max != null ? formatValue(0, state.metric) : "—"}</span>
          <span>{formatValue(d?.max ?? null, state.metric)}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!markAt || state.marks.length >= MAX_MARKS || state.marks.includes(markAt ?? "")}
            title={state.marks.length >= MAX_MARKS ? `At most ${MAX_MARKS} marks` : "Adds a marker line at the scrubber time"}
            onClick={() => markAt && onChange({ marks: [...state.marks, markAt] })}
            className="rounded-[3px] border border-line bg-panel2 px-2 py-[3px] text-[11px] text-text enabled:hover:border-mute disabled:text-mute/50"
          >
            Mark {markAt ? timeLabel(isoMinuteDate(markAt).getTime()) : "time"}
          </button>
          {state.marks.map((m) => (
            <button key={m} type="button" onClick={() => onChange({ marks: state.marks.filter((x) => x !== m) })} aria-label={`Remove mark ${timeLabel(isoMinuteDate(m).getTime())}`} className="rounded-[3px] border border-line px-1.5 py-[3px] font-mono text-[10px] text-text hover:border-mute">
              {timeLabel(isoMinuteDate(m).getTime())} ×
            </button>
          ))}
        </div>
      </div>

      {gl === "ok" ? <div className="pointer-events-none absolute bottom-2.5 left-1/2 z-30 -translate-x-1/2 text-[11px] text-mute">Drag to orbit. Click the surface or a row name to inspect it.</div> : null}

      {hovered && hover ? (
        <div className="pointer-events-none absolute z-40 max-w-[260px] rounded-[3px] border border-line bg-panel2 px-[9px] py-[7px] text-[12px]" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b className="font-mono font-medium">{hovered.label}</b>
          <br />
          {timeLabel(hoverTime)} to {timeLabel(hoverTime + step).slice(7)} UTC
          <br />
          {label}: <b className="font-mono font-medium">{hoverShown ? formatValue(hoverValue, state.metric) : "no data"}</b>
        </div>
      ) : null}

      <StageOverlay text={overlay} />
    </div>
  );
}
