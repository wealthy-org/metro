"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { isLensKey, isShortWindow, NO_FILTERS, normalize, parseViewState, rawFilterCount, serializeViewState, type LensKey, type ViewState } from "../../lib/view-state.ts";
import { CityView } from "../city/CityView.tsx";
import { ExportMenu } from "../controls/ExportMenu.tsx";
import { TimeScrubber } from "../controls/TimeScrubber.tsx";
import { Toolbar } from "../controls/Toolbar.tsx";
import { FlowView } from "../flow/FlowView.tsx";
import { GraphView } from "../graph/GraphView.tsx";
import { HeatmapView } from "../heatmap/HeatmapView.tsx";
import { LaunchpadView } from "../launchpad/LaunchpadView.tsx";
import { SplitView, type SplitInspect } from "../split/SplitView.tsx";
import { WorkspacePanel } from "../panel/WorkspacePanel.tsx";
import type { Chip, StageInfo } from "../stage.tsx";
import { TerrainView } from "../terrain/TerrainView.tsx";
import { LensRail } from "./LensRail.tsx";

// The workspace at /lens/[name] (PROJECT.md 7; KL-21): rail, toolbar, lens stage, time scrubber and side panel.
// Every choice lives in the URL (PROJECT.md 11.2, 11.5; AT 9): the path names the lens, the query holds the rest.
// Updates replace the URL in place, so reloading or sharing it restores the same view.

export function Workspace({ lens }: { lens: string }) {
  const built: LensKey | null = isLensKey(lens) ? lens : null;
  const params = useSearchParams();
  const [state, setState] = useState<ViewState>(() => parseViewState(new URLSearchParams(params.toString()), built ?? "city"));
  const [info, setInfo] = useState<StageInfo | null>(null);
  const [splitInspect, setSplitInspect] = useState<SplitInspect | null>(null);

  // A lens switch is a navigation with its own query; read it again.
  useEffect(() => {
    setState(parseViewState(new URLSearchParams(window.location.search), built ?? "city"));
    setInfo(null);
    setSplitInspect(null);
  }, [built]);

  useEffect(() => {
    const onPop = () => setState(parseViewState(new URLSearchParams(window.location.search), built ?? "city"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [built]);

  const query = serializeViewState(state, false).toString();
  useEffect(() => {
    const url = `/lens/${lens}${query ? `?${query}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [lens, query]);

  const onChange = useCallback((patch: Partial<ViewState>) => setState((s) => normalize({ ...s, ...patch })), []);
  const onInfo = useCallback((i: StageInfo) => setInfo((prev) => (prev && prev.coverage.first === i.coverage.first && prev.coverage.last === i.coverage.last && prev.subsidy_end === i.subsidy_end ? prev : i)), []);
  const onAt = useCallback((at: string | null) => setState((s) => normalize({ ...s, at })), []);

  // A window longer than 24 h drops the raw-only filters (KL-20); say so instead of losing them silently (gate F27).
  const [notice, setNotice] = useState<Chip | null>(null);
  const prev = useRef(state);
  useEffect(() => {
    const p = prev.current;
    prev.current = state;
    if (p.window === state.window) return;
    if (rawFilterCount(p.filters) > 0 && rawFilterCount(state.filters) === 0 && !isShortWindow(state.window)) {
      setNotice({ text: "Token, value, wallet and status filters were cleared: they apply to windows of 24 h or less." });
    } else if (isShortWindow(state.window)) {
      setNotice(null);
    }
  }, [state]);

  // In Split the Inspector reads the clicked pane's window (gate F55): its own window and anchor, no filters; the URL
  // keeps only the selection. Until Split says which window, or when it cannot be shown, the panel shows a note.
  const split = built === "split";
  const panelState = split && splitInspect && "window" in splitInspect ? { ...state, window: splitInspect.window, at: splitInspect.at, filters: NO_FILTERS } : state;
  const panelNote = split && state.sel ? (splitInspect === null ? "Loading the split windows…" : "note" in splitInspect ? splitInspect.note : null) : null;

  return (
    <>
      <LensRail active={lens} query={query} />
      <main className="grid min-h-0 min-w-0 grid-rows-[44px_1fr_76px] bg-bg">
        {built ? <Toolbar lens={built} state={state} onChange={onChange} extra={<ExportMenu lens={built} state={state} windowLabel={built === "split" ? state.split.cmp : state.window} />} /> : <div className="border-b border-line bg-panel" />}
        {built === "city" ? <CityView state={state} onChange={onChange} onInfo={onInfo} notice={notice} /> : null}
        {built === "terrain" ? <TerrainView state={state} onChange={onChange} onInfo={onInfo} notice={notice} /> : null}
        {built === "heatmap" ? <HeatmapView state={state} onChange={onChange} onInfo={onInfo} notice={notice} /> : null}
        {built === "flow" ? <FlowView state={state} onChange={onChange} onInfo={onInfo} notice={notice} /> : null}
        {built === "launchpad" ? <LaunchpadView state={state} onChange={onChange} onInfo={onInfo} notice={notice} /> : null}
        {built === "split" ? <SplitView state={state} onChange={onChange} onInfo={onInfo} onInspect={setSplitInspect} notice={notice} /> : null}
        {built === "graph" ? <GraphView state={state} onChange={onChange} onInfo={onInfo} notice={notice} /> : null}
        {built && built !== "split" ? (
          <TimeScrubber coverage={info?.coverage ?? null} at={state.at} onAt={onAt} subsidyEnd={info?.subsidy_end ?? null} />
        ) : (
          <div className="flex items-center border-t border-line bg-panel px-3.5 text-[12px] text-mute">{built === "split" ? "Split compares its own two windows or tokens, so the time scrubber does not apply here." : null}</div>
        )}
      </main>
      <WorkspacePanel state={panelState} note={panelNote} onClear={() => onChange({ sel: null })} />
    </>
  );
}
