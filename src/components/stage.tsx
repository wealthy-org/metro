"use client";

import { useEffect, useState } from "react";
import type { CityResponse, Coverage } from "../lib/api-types.ts";
import { filterSummary } from "../lib/view-state.ts";

// Pieces every lens stage shares (City, Terrain, Heatmap): polling interval, scope note, stage chips, the empty or
// error overlay, and WebGL detection. Moved out of CityView (Phase 5 gate F26).

export const POLL_MS = 15_000;
const int = new Intl.NumberFormat("en-US");
export const hm = (iso: string) => iso.slice(11, 16);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Window, sample size and active filters: the scope every number on the stage belongs to (PROJECT.md 3.4).
export function scopeNote(d: Pick<CityResponse, "window" | "n" | "filters">, extra = ""): { short: string; full: string } {
  const { start, end, basis } = d.window;
  if (!start || !end) return { short: "No blocks ingested yet", full: "No blocks ingested yet" };
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  const range =
    basis === "agg_day" ? `${day(start)} to ${day(end)} UTC, whole days` : sameDay ? `${hm(start)} to ${hm(end)} UTC` : `${day(start)} ${hm(start)} to ${day(end)} ${hm(end)} UTC`;
  const filters = filterSummary(d.filters);
  const short = `${range} · ${int.format(d.n)} tx${filters.length ? ` · ${filters.length} filter${filters.length === 1 ? "" : "s"}` : ""}`;
  return { short, full: `${range} · ${int.format(d.n)} tx${filters.length ? ` · ${filters.join(", ")}` : ""}${extra}` };
}

export type StageInfo = { coverage: Coverage; subsidy_end: string };
type GlState = "checking" | "ok" | "none" | "lost";

export function useWebGl(): [GlState, (s: GlState) => void] {
  const [gl, setGl] = useState<GlState>("checking");
  useEffect(() => {
    const probe = document.createElement("canvas");
    setGl(probe.getContext("webgl2") || probe.getContext("webgl") ? "ok" : "none");
  }, []);
  return [gl, setGl];
}

export type Chip = { text: string; title?: string; tone?: "mute" | "error" };

// Top-left notes of a stage. A chip with a title (the scope note) keeps one line and shows the rest on hover; the
// others wrap, since their whole sentence matters.
export function StageChips({ items }: { items: (Chip | null)[] }) {
  const shown = items.filter((x): x is Chip => x !== null);
  if (!shown.length) return null;
  return (
    <div className="pointer-events-none absolute top-3.5 left-3.5 z-30 flex max-w-[60%] flex-col items-start gap-1.5">
      {shown.map((c) => (
        <div
          key={c.text}
          role={c.tone ? "status" : undefined}
          title={c.title}
          className={`pointer-events-auto max-w-full rounded-[3px] border bg-panel px-2.5 py-1.5 font-mono text-[11px] ${c.title ? "truncate" : "whitespace-normal"} ${c.tone === "error" ? "border-c2 text-c2" : "border-line text-mute"}`}
        >
          {c.text}
        </div>
      ))}
    </div>
  );
}

// Loading, empty and error states, centred in the stage so they never cover the chips (Phase 5 gate F21).
export function StageOverlay({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
      <div role="status" className="max-w-[52ch] rounded-[3px] border border-line bg-panel px-3 py-2 text-center text-[12px] text-mute">
        {text}
      </div>
    </div>
  );
}
