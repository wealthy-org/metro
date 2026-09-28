"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Coverage } from "../../lib/api-types.ts";
import { isoMinuteDate, toIsoMinute } from "../../lib/view-state.ts";
import { Segmented } from "./Toolbar.tsx";
import { NA } from "../../lib/format.ts";

// Time scrubber (PROJECT.md 11.3; prototype lines 108 to 115 and 246 to 253). The track runs from the first to the
// newest ingested block. Moving the thumb sets the view time `at`; the right end is live (at = null). Play advances
// one step per second at 1x.

const STEPS = [60_000, 300_000, 3_600_000, 86_400_000];
const MAX_STEPS = 1_000;
const SPEEDS = [1, 5, 20] as const;

const label = (t: number) => {
  const d = new Date(t);
  const day = `${String(d.getUTCDate()).padStart(2, "0")} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
  return `${day} ${d.toISOString().slice(11, 16)}`;
};

export function TimeScrubber({
  coverage,
  at,
  onAt,
  subsidyEnd,
  extra,
}: {
  coverage: Coverage | null;
  at: string | null;
  onAt: (at: string | null) => void;
  subsidyEnd: string | null;
  extra?: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  const track = useMemo(() => {
    const first = coverage?.first ? Date.parse(coverage.first) : null;
    const last = coverage?.last ? Date.parse(coverage.last) : null;
    if (first === null || last === null || last <= first) return null;
    const step = STEPS.find((s) => (last - first) / s <= MAX_STEPS) ?? 86_400_000;
    const start = Math.floor(first / step) * step;
    const max = Math.max(1, Math.floor((last - start) / step));
    return { first, last, step, start, max };
  }, [coverage?.first, coverage?.last]);

  const atMs = at ? isoMinuteDate(at).getTime() : null;
  const index = !track ? 0 : atMs === null ? track.max : Math.max(0, Math.min(track.max, Math.round((atMs - track.start) / track.step)));
  const indexRef = useRef(index);
  // The play timer reads the latest position; the ref is written after render, not during it (gate F24).
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  const toAt = (i: number) => (!track || i >= track.max ? null : toIsoMinute(Math.max(track.first, track.start + i * track.step)));

  useEffect(() => {
    if (!playing || !track) return;
    const timer = setInterval(() => {
      const next = indexRef.current + 1;
      if (next >= track.max) {
        setPlaying(false);
        onAt(null);
      } else {
        onAt(toAt(next));
      }
    }, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, track, onAt]);

  const cliffMs = subsidyEnd ? Date.parse(subsidyEnd) : null;
  const cliffDay = cliffMs === null ? "" : label(cliffMs).slice(0, 6);
  const cliffPct = track && cliffMs !== null && cliffMs >= track.start && cliffMs <= track.last ? ((cliffMs - track.start) / (track.max * track.step)) * 100 : null;
  const cliffText =
    cliffMs === null
      ? ""
      : cliffPct !== null
        ? `${cliffDay} marks the end of the rebate`
        : track && cliffMs > track.last
          ? `Rebate ends ${cliffDay}, after the newest block`
          : `Rebate ended ${cliffDay}, before the first block`;
  const nowText = !track ? "No blocks ingested yet" : atMs === null ? `Live · ${label(track.last)} UTC` : `${label(atMs)} UTC`;

  return (
    <div className="flex h-[76px] min-w-0 items-center gap-3.5 border-t border-line bg-panel px-3.5">
      <button
        type="button"
        disabled={!track}
        aria-label={playing ? "Pause history" : "Play history"}
        aria-pressed={playing}
        onClick={() => {
          if (!track) return;
          if (!playing && index >= track.max) onAt(toAt(0));
          setPlaying((p) => !p);
        }}
        className="flex size-10 flex-none items-center justify-center rounded-[3px] border border-line bg-panel2 enabled:hover:border-mute disabled:opacity-50"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 fill-text">
          {playing ? <path d="M3 2h3.5v12H3zM9.5 2H13v12H9.5z" /> : <path d="M3 2l11 6-11 6z" />}
        </svg>
      </button>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex justify-between gap-3 font-mono text-[11px] text-mute">
          <span className="whitespace-nowrap">{track ? label(track.start) : NA}</span>
          <span className="truncate text-center" title={cliffText}>
            {cliffText}
          </span>
          <span className="whitespace-nowrap">{track ? label(track.last) : NA}</span>
        </div>
        <div className="relative">
          <input
            type="range"
            min={0}
            max={track?.max ?? 1}
            step={1}
            value={index}
            disabled={!track}
            onChange={(e) => {
              setPlaying(false);
              onAt(toAt(Number(e.target.value)));
            }}
            aria-label="Point in time"
            aria-valuetext={nowText}
            className="h-6 w-full accent-accent"
          />
          {cliffPct !== null ? <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent" style={{ left: `${cliffPct}%` }} /> : null}
        </div>
      </div>
      <Segmented label="Replay speed" value={String(speed)} options={SPEEDS.map((s) => ({ key: String(s), label: `${s}x` }))} onChange={(v) => setSpeed(Number(v) as (typeof SPEEDS)[number])} />
      {extra}
      <div className="flex min-w-[150px] flex-none flex-col items-end gap-1">
        <span className="font-mono text-[12px]" aria-live="off">
          {nowText}
        </span>
        {at ? (
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              onAt(null);
            }}
            className="rounded-[3px] border border-line px-2 py-px text-[11px] text-mute hover:text-text"
          >
            Back to live
          </button>
        ) : null}
      </div>
    </div>
  );
}
