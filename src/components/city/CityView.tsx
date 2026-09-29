"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CityResponse, FlowResponse } from "../../lib/api-types.ts";
import { buildingHeights, costColor, cssColor, feeScale, feeTop, formatMetric, metricValue, type CityMetric } from "../../lib/city.ts";
import { dataQuery, metricLabel, type ViewState } from "../../lib/view-state.ts";
import { samplingText, useBlockSampling } from "../flow/sampling.ts";
import { usePolling, useReducedMotion } from "../hooks.ts";
import { hm, POLL_MS, scopeNote, StageChips, StageOverlay, useWebGl, type Chip, type StageInfo } from "../stage.tsx";
import { CityFallback } from "./CityFallback.tsx";
import type { HoverInfo, VehicleSet } from "./CityScene.tsx";

// WebGL only exists in the browser; the scene is never rendered on the server.
const CityScene = dynamic(() => import("./CityScene.tsx"), { ssr: false });

const int = new Intl.NumberFormat("en-US");
const VEHICLE_POLL_MS = 5_000;

export function CityView({ state, onChange, onInfo, notice }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; notice: Chip | null }) {
  const metric = state.metric as CityMetric;
  const city = usePolling<CityResponse>(`/api/lens/city/data?${dataQuery(state)}`, state.at ? null : POLL_MS);
  // Vehicles: the newest transactions read live (Phase 6 D3, KL-23), from the Flow endpoint. None when scrubbed.
  const flow = usePolling<FlowResponse>(state.at ? null : `/api/lens/flow/data?${dataQuery(state)}`, state.at ? null : VEHICLE_POLL_MS);
  const reducedMotion = useReducedMotion();
  const [gl, setGl] = useWebGl();
  const [sceneKey, setSceneKey] = useState(0);
  const [presetNonce, setPresetNonce] = useState(0);
  // Table view (PROJECT.md 19; Phase 13): the bars that also replace the scene without WebGL, on demand.
  const [view, setView] = useState<"scene" | "table">("scene");
  // Automatic quality reduction (PROJECT.md 24.6, AT 29; Phase 13): under 45 fps for two samples steps down (first
  // DPR, then vehicle count), stable at 55 fps or more for five samples steps back up. Measured only while moving.
  const [quality, setQuality] = useState<0 | 1 | 2>(0);
  const lowSamples = useRef(0);
  const highSamples = useRef(0);
  // Unmounting the canvas (switching to Table) fires a final context-lost event; only a loss while the scene is on
  // screen counts, and switching back gets a fresh context.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  // Tooltip position relative to the stage, measured when the pointer moves rather than during render.
  const onHover = useCallback((h: HoverInfo) => {
    const rect = stage.current?.getBoundingClientRect();
    setHover(h && rect ? { index: h.index, x: h.clientX - rect.left, y: h.clientY - rect.top } : null);
  }, []);

  useEffect(() => {
    if (city.data) onInfo({ coverage: city.data.coverage, subsidy_end: city.data.subsidy_end });
  }, [city.data, onInfo]);

  const buildings = useMemo(() => city.data?.buildings ?? [], [city.data]);
  const heights = useMemo(() => buildingHeights(buildings, metric), [buildings, metric]);
  const fees = useMemo(() => feeScale(buildings), [buildings]);
  const sel = state.sel && state.sel.kind !== "hour" ? state.sel : null;
  const selectedIndex = sel ? buildings.findIndex((b) => b.kind === sel.kind && b.key === sel.key) : -1;
  const select = (i: number) => {
    const b = buildings[i];
    if (b) onChange({ sel: { kind: b.kind, key: b.key } });
  };
  const label = metricLabel(metric);
  const hovered = hover ? buildings[hover.index] : undefined;
  const tokenCount = buildings.filter((b) => b.kind === "token").length;
  const vehicles = useMemo<VehicleSet | null>(() => {
    const rows = flow.data?.rows;
    if (state.at || !rows?.length) return null;
    const sample = rows.slice(0, 300);
    const top = feeTop(sample.map((r) => r.fee_usd));
    return { colors: sample.map((r) => costColor(Math.min(1, r.fee_usd / top))), tps: flow.data?.tps ?? null };
  }, [flow.data, state.at]);
  const vehiclesMoving = vehicles !== null && !reducedMotion && flow.status !== "error";
  const movingRef = useRef(false);
  useEffect(() => {
    movingRef.current = vehiclesMoving;
  }, [vehiclesMoving]);
  const onFps = useCallback((fps: number) => {
    if (!movingRef.current) return;
    if (fps < 45) {
      highSamples.current = 0;
      lowSamples.current += 1;
      if (lowSamples.current >= 2) {
        lowSamples.current = 0;
        setQuality((q) => (q < 2 ? ((q + 1) as 0 | 1 | 2) : q));
      }
    } else if (fps >= 55) {
      lowSamples.current = 0;
      highSamples.current += 1;
      if (highSamples.current >= 5) {
        highSamples.current = 0;
        setQuality((q) => (q > 0 ? ((q - 1) as 0 | 1 | 2) : q));
      }
    } else {
      lowSamples.current = 0;
      highSamples.current = 0;
    }
  }, []);
  const shownVehicles = vehicles && quality === 2 ? { ...vehicles, colors: vehicles.colors.slice(0, 150) } : vehicles;
  // Reduced motion means no vehicles at all (AT 28), not parked ones.
  const sceneVehicles = reducedMotion ? null : shownVehicles;
  const sampled = samplingText(useBlockSampling(state.at ? null : flow.data));
  const byVolume = city.data?.district.ranked_by === "volume_24h_usd";

  let overlay: string | null = null;
  if (city.status === "loading" && !city.data) overlay = "Loading the city…";
  else if (city.status === "error" && !city.data) overlay = "City data is unavailable. Retrying every 15 seconds.";
  else if (city.data && !city.data.window.start) overlay = state.at ? "No blocks were ingested before this point in time." : "No blocks ingested yet. Start the Collector to fill the city.";
  else if (city.data && city.data.n === 0) overlay = "No transactions in this window and filter. Pick a longer window, clear filters or move the scrubber.";

  const scope = city.data ? scopeNote(city.data, city.data.other_tx_count > 0 ? `, ${int.format(city.data.other_tx_count)} classified "other" have no building` : "") : null;
  // The window ends at the newest block at or before the scrubber time; say so when blocks are missing in between.
  const endMs = city.data?.window.end ? Date.parse(city.data.window.end) : null;
  const atMs = state.at ? Date.parse(`${state.at.slice(0, 16)}:59Z`) : null;
  const gap = endMs !== null && atMs !== null && atMs - endMs > 5 * 60_000 ? `No blocks ingested between ${hm(city.data?.window.end ?? "")} and ${state.at?.slice(11, 16)} UTC; the window ends at the last block before the scrubber.` : null;

  return (
    <div ref={stage} className={`relative min-h-0 overflow-hidden ${hovered ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}>
      {gl === "ok" && view === "scene" ? (
        <CityScene
          key={sceneKey}
          buildings={buildings}
          heights={heights}
          colors={fees.colors}
          metric={metric}
          selectedIndex={selectedIndex}
          preset={state.cam}
          presetNonce={presetNonce}
          reducedMotion={reducedMotion}
          onSelect={select}
          onHover={onHover}
          onContextLost={() => {
            if (viewRef.current === "scene") setGl("lost");
          }}
          vehicles={sceneVehicles}
          vehiclesMoving={vehiclesMoving}
          quality={quality}
          onFps={onFps}
        />
      ) : null}

      {view === "table" || gl === "none" || gl === "lost" ? (
        <div className="absolute inset-0 overflow-auto p-6 pt-16">
          <h3 className="mb-1 font-display text-[22px] font-bold">{gl === "none" ? "3D is unavailable in this browser" : gl === "lost" ? "The 3D view stopped" : "Table view"}</h3>
          <p className="mb-4 max-w-[60ch] text-mute">
            {gl === "none"
              ? "WebGL could not start. The same buildings are shown below as bars: length is the selected metric, color is the average fee."
              : gl === "lost"
                ? "The graphics context was lost. The same buildings are shown below as bars until 3D is restarted."
                : "The same buildings as bars: length is the selected metric, color is the average fee. Click a bar to inspect it."}
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
        <div className="absolute top-3.5 right-3.5 z-30 flex gap-2">
          <div className="flex overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="View">
            {(["scene", "table"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`border-r border-line px-[11px] py-1.5 text-[12px] last:border-r-0 ${view === v ? "bg-panel2 text-accent" : "text-mute hover:text-text"}`}
              >
                {v === "scene" ? "3D" : "Table"}
              </button>
            ))}
          </div>
          {view === "scene" ? (
            <div className="flex overflow-hidden rounded-[3px] border border-line bg-panel" role="group" aria-label="Camera">
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
        </div>
      ) : null}

      <StageChips
        items={[
          scope ? { text: scope.short, title: scope.full } : null,
          notice,
          gap ? { text: gap } : null,
          city.status === "error" && city.data ? { text: "Refresh failed; showing the last data. Retrying.", tone: "error" } : null,
          city.stale ? { text: "Updating…", tone: "mute" } : null,
        ]}
      />

      <div className="absolute bottom-3.5 left-3.5 z-30 max-w-[280px] rounded-[3px] border border-line bg-panel px-[11px] py-[9px] text-[11px] text-mute">
        <div>Building color: average fee per transaction, USD. Height: {label}.</div>
        <div className="my-[5px] h-2 w-[180px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
        <div className="flex w-[180px] justify-between font-mono">
          <span>{formatMetric(fees.min, "avg_fee_usd")}</span>
          <span>{formatMetric(fees.max, "avg_fee_usd")}</span>
        </div>
        {city.data ? (
          <div className="mt-1.5">
            {tokenCount > 0
              ? `Back plate: Pons district, the ${tokenCount} Pons token${tokenCount === 1 ? "" : "s"} with the ${byVolume ? "highest 24 h USD volume (GeckoTerminal)" : "most transactions in this window"}.`
              : "Back plate: Pons district. No Pons token moved in this window."}
          </div>
        ) : null}
        {!reducedMotion && shownVehicles && gl === "ok" && view === "scene" ? (
          <div className="mt-1">
            Vehicles: the {shownVehicles.colors.length} newest transactions, read live from RPC; color is the fee{vehiclesMoving ? ", speed follows TPS" : ""}.{sampled ? ` ${sampled}.` : ""}
          </div>
        ) : null}
        {quality > 0 && gl === "ok" && view === "scene" ? (
          <div className="mt-1">
            Quality reduced: {quality === 1 ? "lower resolution" : "lower resolution and fewer vehicles"} (the frame rate stayed under 45 fps). It recovers when the frame rate is stable.
          </div>
        ) : null}
        {metric === "fail_rate" && tokenCount > 0 ? <div className="mt-1">Tokens have no fail rate: failed transactions move no tokens.</div> : null}
      </div>

      {gl === "ok" && view === "scene" ? (
        <div className="pointer-events-none absolute bottom-2.5 left-1/2 z-30 -translate-x-1/2 text-[11px] text-mute">Drag to orbit. Scroll to zoom. Click a building or its label to inspect it.</div>
      ) : null}

      {hovered && hover ? (
        <div className="pointer-events-none absolute z-40 max-w-[240px] rounded-[3px] border border-line bg-panel2 px-[9px] py-[7px] text-[12px]" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b className="font-mono font-medium">{hovered.label}</b>
          <br />
          {label}: <b className="font-mono font-medium">{formatMetric(metricValue(hovered, metric), metric)}</b>
          <br />
          Avg fee: <b className="font-mono font-medium">{formatMetric(hovered.avg_fee_usd, "avg_fee_usd")}</b>
        </div>
      ) : null}

      <StageOverlay text={overlay} />
    </div>
  );
}
