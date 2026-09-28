"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import type { HeatmapResponse } from "../../lib/api-types.ts";
import { actionLabel, costColor, cssColor } from "../../lib/city.ts";
import { formatValue, timeLabel } from "../../lib/lenses.ts";
import { dataQuery, isoMinuteDate, metricLabel, toIsoMinute, type ViewState } from "../../lib/view-state.ts";
import { Segmented } from "../controls/Toolbar.tsx";
import { usePolling } from "../hooks.ts";
import { POLL_MS, scopeNote, type Chip, type StageInfo } from "../stage.tsx";
import { NA } from "../../lib/format.ts";

// Heatmap lens (PROJECT.md 10.5; prototype renderHeatmap and .hm-grid): one cell per UTC hour, one row per UTC day of
// the window. Color is the metric on the cost scale. Cells without ingested data and cells after the scrubber time
// are blank; cells outside the window are empty space. Arrow keys move between cells, Enter opens the hour.

const HOUR = 3_600_000;
const BLANK = "#151922";
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

const dayLabel = (day: string) => timeLabel(Date.parse(`${day}T00:00:00Z`)).slice(0, 6);

function Legend({ max, metric }: { max: number | null; metric: HeatmapResponse["metric"] }) {
  return (
    <div className="mt-3 flex items-center gap-3 text-[11px] text-mute">
      <span>{metricLabel(metric)}</span>
      <span className="font-mono">{max !== null ? formatValue(0, metric) : NA}</span>
      <span className="h-2 w-[180px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
      <span className="font-mono">{formatValue(max, metric)}</span>
      <span className="ml-2 inline-block size-3 rounded-[2px]" style={{ background: BLANK }} />
      <span>no data</span>
    </div>
  );
}

export function HeatmapView({ state, onChange, onInfo, notice }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; notice: Chip | null }) {
  const query = dataQuery({ ...state, at: null }, { metric: state.metric, mode: state.mode });
  const h = usePolling<HeatmapResponse>(`/api/lens/heatmap/data?${query}`, state.at ? null : POLL_MS);
  const d = h.data;
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (d) onInfo({ coverage: d.coverage, subsidy_end: d.subsidy_end });
  }, [d, onInfo]);

  const atMs = state.at ? isoMinuteDate(state.at).getTime() + 59_999 : null;
  const cliffDay = d ? d.subsidy_end.slice(0, 10) : null;
  const selectedHour = state.sel?.kind === "hour" ? state.sel.key : null;
  const max = d?.max && d.max > 0 ? d.max : 1;

  const open = (day: string, hour: number) => {
    const key = `${day}T${HOURS[hour]}:00Z`;
    const endMinute = Date.parse(`${day}T00:00:00Z`) + hour * HOUR + HOUR - 60_000;
    const last = d?.coverage.last ? Date.parse(d.coverage.last) : endMinute;
    onChange({ sel: { kind: "hour", key }, at: endMinute >= last ? null : toIsoMinute(endMinute) });
  };

  // Roving focus over the cells that hold data.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell || !grid.current) return;
    const [r, c] = (cell.dataset.cell ?? "0,0").split(",").map(Number) as [number, number];
    const move: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const m = move[e.key];
    if (!m) return;
    e.preventDefault();
    for (let step = 1; step < 48; step++) {
      const nr = r + m[0] * step;
      const nc = c + m[1] * step;
      if (nr < 0 || nc < 0 || nc > 23 || nr >= (d?.days.length ?? 0)) return;
      // Blank cells are disabled; skip them to the next cell that holds data.
      const next = grid.current.querySelector<HTMLElement>(`[data-cell="${nr},${nc}"]:not(:disabled)`);
      if (next) return next.focus();
    }
  };

  const action = state.filters.action ? actionLabel(state.filters.action) : "all actions";
  const scope = d ? scopeNote(d) : null;
  let firstFocusable = true;

  return (
    <div className="min-h-0 overflow-auto px-[22px] py-[18px]">
      <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Heatmap</h3>
      <p className="mt-2 mb-3.5 text-[12px] text-mute">
        {metricLabel(state.metric)}, {state.metric === "gas_price" ? "chain-wide (the action filter does not apply to block base fees)" : action}. Each cell is one hour, UTC. This answers &quot;when is it cheapest&quot;.
        {scope ? <span className="ml-1 font-mono text-[11px]" title={scope.full}>{scope.short}</span> : null}
      </p>
      {notice ? (
        <p role="status" className="mb-3 text-[12px] text-mute">
          {notice.text}
        </p>
      ) : null}
      <div className="mb-3">
        <Segmented
          label="Heatmap mode"
          value={state.mode}
          options={[
            { key: "days", label: "Every day" },
            { key: "compare", label: "Before vs after subsidy" },
          ]}
          onChange={(mode) => onChange({ mode })}
        />
      </div>

      {h.status === "loading" && !d ? <p role="status" className="text-mute">Loading the heatmap…</p> : null}
      {h.status === "error" && !d ? <p role="status" className="text-c2">Heatmap data is unavailable. Retrying every 15 seconds.</p> : null}
      {h.status === "error" && d ? <p role="status" className="mb-2 text-[11px] text-c2">Refresh failed; showing the last data.</p> : null}
      {d && !d.window.start ? <p className="text-mute">No blocks ingested yet. Start the Collector to fill the grid.</p> : null}

      {d && d.window.start && state.mode === "days" ? (
        <>
          <div ref={grid} role="grid" aria-label={`Heatmap of ${metricLabel(state.metric)} by UTC day and hour`} onKeyDown={onKey} className="grid grid-cols-[70px_repeat(24,minmax(0,1fr))] gap-[2px] font-mono text-[10px]">
            <div role="row" className="contents">
              <div />
              {HOURS.map((hh) => (
                <div key={hh} role="columnheader" className="pb-[3px] text-center text-mute">
                  {hh}
                </div>
              ))}
            </div>
            {d.days.map((day, r) => (
              <div key={day} role="row" className="contents">
                <div role="rowheader" className={`flex items-center ${day === cliffDay ? "text-accent" : "text-mute"}`}>
                  {dayLabel(day)}
                  {day === cliffDay ? " *" : ""}
                </div>
                {(d.cells[r] ?? []).map((c, hour) => {
                  const t = Date.parse(`${day}T00:00:00Z`) + hour * HOUR;
                  if (c.s === "o") return <div key={hour} role="gridcell" aria-hidden className="h-6" />;
                  const after = atMs !== null && t > atMs;
                  const has = c.s === "d" && !after;
                  const bg = has ? (c.v === null ? BLANK : cssColor(costColor(c.v / max))) : BLANK;
                  const key = `${day}T${HOURS[hour]}:00Z`;
                  const text = `${dayLabel(day)} ${HOURS[hour]}:00 UTC: ${!has ? (after ? "after the scrubber time" : "no data ingested") : `${formatValue(c.v, state.metric)}, n = ${c.n.toLocaleString("en-US")}`}`;
                  const tab = has && firstFocusable;
                  if (tab) firstFocusable = false;
                  return (
                    <button
                      key={hour}
                      type="button"
                      role="gridcell"
                      data-cell={`${r},${hour}`}
                      tabIndex={tab ? 0 : -1}
                      disabled={!has}
                      title={text}
                      aria-label={text}
                      aria-selected={selectedHour === key}
                      onClick={() => open(day, hour)}
                      className={`h-6 rounded-[2px] ${has ? "cursor-pointer hover:outline hover:outline-1 hover:outline-text" : "cursor-default"} ${selectedHour === key ? "outline outline-2 outline-accent" : ""}`}
                      style={{ background: bg }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <Legend max={d.max} metric={d.metric} />
          <p className="mt-3 text-[12px] text-mute">
            * {dayLabel(d.subsidy_end.slice(0, 10))} is the day the Robinhood Wallet rebate ends. {state.at ? "Cells after the scrubber position are blank." : ""}
          </p>
        </>
      ) : null}

      {d && d.window.start && state.mode === "compare" && d.compare ? (
        <>
          <div className="grid grid-cols-[70px_repeat(24,minmax(0,1fr))] gap-[2px] font-mono text-[10px]" role="table" aria-label={`Average ${metricLabel(state.metric)} by UTC hour, before and after the subsidy end`}>
            <div className="contents" role="row">
              <div />
              {HOURS.map((hh) => (
                <div key={hh} role="columnheader" className="pb-[3px] text-center text-mute">
                  {hh}
                </div>
              ))}
            </div>
            {(["before", "after"] as const).map((side) => {
              const s = d.compare?.[side];
              return (
                <div key={side} className="contents" role="row">
                  <div role="rowheader" className="flex items-center text-mute">
                    {side === "before" ? "Before" : "After"}
                  </div>
                  {HOURS.map((hh, hour) => {
                    const v = s?.values[hour] ?? null;
                    const text = `${side === "before" ? "Before" : "After"}, ${hh}:00 UTC: ${v === null ? "no data" : `${formatValue(v, state.metric)}, n = ${(s?.n[hour] ?? 0).toLocaleString("en-US")}`}`;
                    return <div key={hh} role="cell" title={text} aria-label={text} className="h-6 rounded-[2px]" style={{ background: v === null ? BLANK : cssColor(costColor(v / max)) }} />;
                  })}
                </div>
              );
            })}
          </div>
          <Legend max={d.max} metric={d.metric} />
          <p className="mt-3 text-[12px] text-mute">
            Averages by hour of day over the days of this window. Before: {d.compare.before.days} day{d.compare.before.days === 1 ? "" : "s"} with data.{" "}
            {d.compare.after.days === 0
              ? `After: no data from ${dayLabel(d.subsidy_end.slice(0, 10))} yet.`
              : `After has ${d.compare.after.full_days} full day${d.compare.after.full_days === 1 ? "" : "s"} of data so far (${d.compare.after.days} with any), so hourly averages are noisy.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
