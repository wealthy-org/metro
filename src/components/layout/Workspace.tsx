"use client";

import { useState } from "react";
import { CITY_WINDOWS, RAW_WINDOW_MAX_SECONDS, type CityMetric, type CityWindow } from "../../lib/city.ts";
import { CityView, type Selection } from "../city/CityView.tsx";
import { WorkspacePanel } from "../panel/WorkspacePanel.tsx";

// Stage and side panel share the selected building, window and metric. Renders two grid cells of the app grid.
export function Workspace() {
  const [metric, setMetric] = useState<CityMetric>("tx_count");
  const [window, setWindow] = useState<CityWindow>("24h");
  const [selected, setSelected] = useState<Selection>(null);

  const changeWindow = (w: CityWindow) => {
    setWindow(w);
    // Wallets are not counted beyond 24 h (KL-17); fall back to transactions rather than show flat buildings.
    const seconds = CITY_WINDOWS.find((x) => x.key === w)?.seconds ?? Infinity;
    if (metric === "wallets" && seconds > RAW_WINDOW_MAX_SECONDS) setMetric("tx_count");
  };

  return (
    <>
      <CityView metric={metric} onMetric={setMetric} window={window} onWindow={changeWindow} selected={selected} onSelect={setSelected} />
      <WorkspacePanel selected={selected} window={window} onClear={() => setSelected(null)} />
    </>
  );
}
