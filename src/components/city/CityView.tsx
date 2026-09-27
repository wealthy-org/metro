"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CityResponse } from "../../lib/api-types.ts";
import {
  buildingHeights,
  CITY_METRICS,
  CITY_WINDOWS,
  costColor,
  cssColor,
  feeScale,
  formatMetric,
  metricValue,
  RAW_WINDOW_MAX_SECONDS,
  type CityMetric,
  type CityWindow,
} from "../../lib/city.ts";
import { usePolling, useReducedMotion } from "../hooks.ts";
import { CityFallback } from "./CityFallback.tsx";
import type { CameraPreset, HoverInfo } from "./CityScene.tsx";

// WebGL only exists in the browser; the scene is never rendered on the server.
const CityScene = dynamic(() => import("./CityScene.tsx"), { ssr: false });

export type Selection = { kind: "action" | "token"; key: string } | null;

const POLL_MS = 15_000;
const int = new Intl.NumberFormat("en-US");
const hm = (iso: string) => iso.slice(11, 16);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Short form for the toolbar; the full text (with the unclassified count) goes in the tooltip.
function scopeNote(d: CityResponse): { short: string; full: string } {
  const { start, end, basis } = d.window;
  if (!start || !end) return { short: "No blocks ingested yet", full: "No blocks ingested yet" };
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  const range =
    basis === "agg_day"
      ? `${day(start)} to ${day(end)} UTC, whole days`
      : sameDay
        ? `${hm(start)} to ${hm(end)} UTC`
        : `${day(start)} ${hm(start)} to ${day(end)} ${hm(end)} UTC`;
  const tx = `${int.format(d.n)} tx`;
  const other = d.other_tx_count > 0 ? `, ${int.format(d.other_tx_count)} classified "other" have no building` : "";
  return { short: `${range} · ${tx}`, full: `${range} · ${tx}${other}` };
}

type GlState = "checking" | "ok" | "none" | "lost";

export function CityView({
  metric,
  onMetric,
  window,
  onWindow,
  selected,
  onSelect,
}: {
  metric: CityMetric;
  onMetric: (m: CityMetric) => void;
  window: CityWindow;
  onWindow: (w: CityWindow) => void;
  selected: Selection;
  onSelect: (s: Selection) => void;
}) {
  const city = usePolling<CityResponse>(`/api/lens/city/data?window=${window}`, POLL_MS);
  const reducedMotion = useReducedMotion();
  const [gl, setGl] = useState<GlState>("checking");
  const [sceneKey, setSceneKey] = useState(0);
  const [preset, setPreset] = useState<CameraPreset>("angle");
  const [presetNonce, setPresetNonce] = useState(0);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  // Tooltip position relative to the stage, measured when the pointer moves rather than during render.
  const onHover = useCallback((h: HoverInfo) => {
    const rect = stage.current?.getBoundingClientRect();
    setHover(h && rect ? { index: h.index, x: h.clientX - rect.left, y: h.clientY - rect.top } : null);
  }, []);

  useEffect(() => {
    const probe = document.createElement("canvas");
    setGl(probe.getContext("webgl2") || probe.getContext("webgl") ? "ok" : "none");
  }, []);

  const buildings = useMemo(() => city.data?.buildings ?? [], [city.data]);
  const heights = useMemo(() => buildingHeights(buildings, metric), [buildings, metric]);
  const fees = useMemo(() => feeScale(buildings), [buildings]);
  const selectedIndex = selected ? buildings.findIndex((b) => b.kind === selected.kind && b.key === selected.key) : -1;
  const select = (i: number) => {
    const b = buildings[i];
    if (b) onSelect({ kind: b.kind, key: b.key });
  };
  const longWindow = (CITY_WINDOWS.find((w) => w.key === window)?.seconds ?? Infinity) > RAW_WINDOW_MAX_SECONDS;
  const metricLabel = CITY_METRICS.find((m) => m.key === metric)?.label ?? metric;
  const hovered = hover ? buildings[hover.index] : undefined;
  const tokenCount = buildings.filter((b) => b.kind === "token").length;

  let overlay: string | null = null;
  if (city.status === "loading" && !city.data) overlay = "Loading the city…";
  else if (city.status === "error" && !city.data) overlay = "City data is unavailable. Retrying every 15 seconds.";
  else if (city.data && !city.data.window.start) overlay = "No blocks ingested yet. Start the Collector to fill the city.";
  else if (city.data && city.data.n === 0) overlay = "No transactions in this window. Pick a longer window or wait for the Collector.";

  return (
    <main className="grid min-h-0 min-w-0 grid-rows-[44px_1fr] bg-bg">
      <div className="flex min-w-0 items-center gap-3.5 border-b border-line bg-panel px-3.5">
        <div className="flex flex-none items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-mute">
          <span id="metric-label">Metric</span>
          <div className="flex overflow-hidden rounded-[3px] border border-line" role="group" aria-labelledby="metric-label">
            {CITY_METRICS.map((m) => {
              const unavailable = m.key === "wallets" && longWindow;
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={metric === m.key}
                  disabled={unavailable}
                  title={unavailable ? "Wallets are counted for windows of 24 h or less" : undefined}
                  onClick={() => onMetric(m.key)}
                  className={`whitespace-nowrap border-r border-line px-[11px] py-1.5 text-[12px] normal-case tracking-normal last:border-r-0 ${
                    metric === m.key ? "bg-panel2 text-accent" : unavailable ? "cursor-not-allowed text-mute/50" : "text-mute hover:text-text"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex flex-none items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-mute">
          Window
          <select
            value={window}
            onChange={(e) => onWindow(e.target.value as CityWindow)}
            className="rounded-[3px] border border-line bg-panel2 px-2 py-[5px] text-[12px] normal-case tracking-normal text-text"
          >
            {CITY_WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        {city.data ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-mute" title={scopeNote(city.data).full}>
            {scopeNote(city.data).short}
          </span>
        ) : null}
      </div>

      <div ref={stage} className={`relative min-h-0 overflow-hidden ${hovered ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}>
        {gl === "ok" ? (
          <CityScene
            key={sceneKey}
            buildings={buildings}
            heights={heights}
            colors={fees.colors}
            metric={metric}
            selectedIndex={selectedIndex}
            preset={preset}
            presetNonce={presetNonce}
            reducedMotion={reducedMotion}
            onSelect={select}
            onHover={onHover}
            onContextLost={() => setGl("lost")}
          />
        ) : null}

        {gl === "none" || gl === "lost" ? (
          <div className="absolute inset-0 overflow-auto p-6">
            <h3 className="mb-1 font-display text-[22px] font-bold">{gl === "none" ? "3D is unavailable in this browser" : "The 3D view stopped"}</h3>
            <p className="mb-4 max-w-[60ch] text-mute">
              {gl === "none"
                ? "WebGL could not start. The same buildings are shown below as bars: length is the selected metric, color is the average fee."
                : "The graphics context was lost. The same buildings are shown below as bars until 3D is restarted."}
            </p>
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
            <CityFallback buildings={buildings} colors={fees.colors} metric={metric} selectedIndex={selectedIndex} onSelect={select} />
          </div>
        ) : null}

        {gl === "ok" ? (
          <div className="absolute top-3.5 right-3.5 z-30 flex overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="Camera">
            {(["angle", "top", "street"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={preset === p}
                onClick={() => {
                  setPreset(p);
                  setPresetNonce((n) => n + 1);
                }}
                className={`border-r border-line px-[11px] py-1.5 text-[12px] capitalize last:border-r-0 ${preset === p ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`}
              >
                {p}
              </button>
            ))}
          </div>
        ) : null}

        <div className="absolute bottom-3.5 left-3.5 z-30 max-w-[280px] rounded-[3px] border border-line bg-panel px-[11px] py-[9px] text-[11px] text-mute">
          <div>Building color: average fee per transaction, USD. Height: {metricLabel}.</div>
          <div className="my-[5px] h-2 w-[180px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
          <div className="flex w-[180px] justify-between font-mono">
            <span>{formatMetric(fees.min, "avg_fee_usd")}</span>
            <span>{formatMetric(fees.max, "avg_fee_usd")}</span>
          </div>
          {city.data ? (
            <div className="mt-1.5">
              {tokenCount > 0
                ? `Back plate: Pons district, the ${tokenCount} Pons token${tokenCount === 1 ? "" : "s"} moved by the most transactions in this window.`
                : "Back plate: Pons district. No Pons token moved in this window."}
            </div>
          ) : null}
          {metric === "fail_rate" && buildings.some((b) => b.kind === "token") ? <div className="mt-1">Tokens have no fail rate: failed transactions move no tokens.</div> : null}
        </div>

        {gl === "ok" ? (
          <div className="pointer-events-none absolute bottom-2.5 left-1/2 z-30 -translate-x-1/2 text-[11px] text-mute">Drag to orbit. Scroll to zoom. Click a building or its label to inspect it.</div>
        ) : null}

        {hovered && hover ? (
          <div
            className="pointer-events-none absolute z-40 max-w-[240px] rounded-[3px] border border-line bg-panel2 px-[9px] py-[7px] text-[12px]"
            style={{ left: hover.x + 14, top: hover.y + 14 }}
          >
            <b className="font-mono font-medium">{hovered.label}</b>
            <br />
            {metricLabel}: <b className="font-mono font-medium">{formatMetric(metricValue(hovered, metric), metric)}</b>
            <br />
            Avg fee: <b className="font-mono font-medium">{formatMetric(hovered.avg_fee_usd, "avg_fee_usd")}</b>
          </div>
        ) : null}

        {overlay ? (
          <div role="status" className="pointer-events-none absolute inset-x-0 top-16 z-30 mx-auto w-fit max-w-[52ch] rounded-[3px] border border-line bg-panel px-3 py-2 text-center text-[12px] text-mute">
            {overlay}
          </div>
        ) : city.status === "error" ? (
          <div role="status" className="absolute top-3.5 left-3.5 z-30 rounded-[3px] border border-c2 bg-panel px-2.5 py-1.5 text-[11px] text-c2">
            Refresh failed; showing the last data. Retrying.
          </div>
        ) : city.stale ? (
          <div role="status" className="absolute top-3.5 left-3.5 z-30 rounded-[3px] border border-line bg-panel px-2.5 py-1.5 text-[11px] text-mute">
            Updating for the new window…
          </div>
        ) : null}
      </div>
    </main>
  );
}
