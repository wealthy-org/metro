"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FlowResponse, FlowRowT } from "../../lib/api-types.ts";
import { actionLabel, CITY_ACTIONS, costColor, cssColor, feeTop } from "../../lib/city.ts";
import { NA, shortHex } from "../../lib/format.ts";
import { formatValue, timeLabel } from "../../lib/lenses.ts";
import { dataQuery, type ViewState } from "../../lib/view-state.ts";
import { usePolling, useReducedMotion } from "../hooks.ts";
import { StageChips, StageOverlay, type Chip, type StageInfo } from "../stage.tsx";
import { samplingText, useBlockSampling } from "./sampling.ts";

// Flow lens (PROJECT.md 10.3; prototype flowFrame and .feed). Every transaction is a particle from its source through
// its action type to the Pons token it moved; color is its fee on the view's scale, size its value. Live data comes
// from RPC (Phase 6 D3, KL-23), sampled and saying so (gate F30); a scrubbed time replays the ingested blocks. At most
// MAX particles stay in view (PROJECT.md 10.3), the oldest dropped first, and the count is stated.

const MAX = 2_000;
const LIVE_POLL_MS = 2_000;
const FEED_ROWS = 50;
const ACTION_KEYS = CITY_ACTIONS.map((a) => a.key as string);

type Particle = { row: FlowRowT; a: number; t: number; s: number; size: number; x?: number; y?: number };

export function FlowView({ state, onInfo, notice }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; notice: Chip | null }) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [minFee, setMinFee] = useState("");
  const live = state.at === null;
  // Pause stops polling but keeps the url, so the particles and columns stay as they are.
  const flow = usePolling<FlowResponse>(`/api/lens/flow/data?${dataQuery(state)}`, live && !paused ? LIVE_POLL_MS : null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const parts = useRef<Map<string, Particle>>(new Map());
  const mode = useRef<string | null>(null);
  const [shownCount, setShownCount] = useState(0);
  const [dropped, setDropped] = useState(0);
  const d = flow.data;
  const sampled = samplingText(useBlockSampling(live ? d : null));

  useEffect(() => {
    if (d) onInfo({ coverage: d.coverage, subsidy_end: d.subsidy_end });
  }, [d, onInfo]);

  // Merge new rows into the particle set (gate F33). The set starts over when the source changes (live, or a replay
  // at another scrubber time), and a response left over from the previous source is ignored instead of mixed in.
  useEffect(() => {
    if (!d) return;
    if ((live ? "rpc" : "ingested") !== d.source) return;
    const key = live ? "live" : `replay|${state.at}`;
    const map = parts.current;
    if (mode.current !== key || !live) {
      map.clear();
      if (mode.current !== key) setDropped(0);
      mode.current = key;
    }
    // The first set starts spread along the paths (prototype initFlow); later reads enter over about a second.
    const first = map.size === 0;
    let seed = map.size;
    for (const row of d.rows) {
      if (map.has(row.hash)) continue;
      const a = ACTION_KEYS.indexOf(row.action);
      seed += 1;
      const spread = (seed * 0.618034) % 1;
      map.set(row.hash, { row, a, t: reduced || first ? spread : -spread * 0.3, s: 0.12 + ((seed * 7919) % 100) / 450, size: 1 + Math.min(3, Math.log10(1 + row.value_eth * 1_000)) });
    }
    let removed = 0;
    while (map.size > MAX) {
      map.delete(map.keys().next().value as string);
      removed += 1;
    }
    if (removed) setDropped((n) => n + removed);
    setShownCount(map.size);
  }, [d, live, reduced, state.at]);

  // Animation: the prototype's two-leg path, speed scaled by TPS. Paused or reduced motion draws one still frame.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    const speed = 0.6 + Math.min(2, (d?.tps ?? 0) / 100);
    const tokens = [...(d?.tokens.map((t) => t.label) ?? []), "Other token", "No token"];
    // The token row follows the column as drawn now, so a change of the Pons district never points a particle at a
    // row that moved or is gone.
    const tokenIndex = new Map((d?.tokens ?? []).map((t, i) => [t.key, i]));
    const rowOf = (row: FlowRowT) => {
      const pons = row.tokens.map((t) => tokenIndex.get(t)).find((i) => i !== undefined);
      return pons !== undefined ? pons : row.tokens.length ? tokens.length - 2 : tokens.length - 1;
    };
    const top = feeTop([...parts.current.values()].map((p) => p.row.fee_usd));

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Prototype column positions, started lower so the scope chips in the top left never cover the first labels.
      // The token column stops above the feed box in the bottom right corner.
      const xL = w * 0.14;
      const xM = w * 0.5;
      const xR = w * 0.8;
      const ay = (i: number) => h * (0.2 + (i * 0.68) / (ACTION_KEYS.length - 1));
      const by = (i: number) => h * (0.2 + (i * 0.44) / Math.max(1, tokens.length - 1));
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = "#8f97a8";
      ctx.textAlign = "center";
      ctx.fillText("sources", xL, h * 0.5 + 90);
      ctx.fillText("action type", xM, ay(0) - 38);
      ctx.textAlign = "left";
      ctx.fillText("token", xR + 14, by(0) - 26);
      ACTION_KEYS.forEach((k, i) => {
        ctx.fillStyle = "#3a4152";
        ctx.fillRect(xM - 4, ay(i) - 14, 8, 28);
        ctx.fillStyle = "#e7e9ee";
        ctx.textAlign = "center";
        ctx.fillText(actionLabel(k), xM, ay(i) - 20);
      });
      tokens.forEach((label, i) => {
        ctx.fillStyle = "#3a4152";
        ctx.fillRect(xR - 4, by(i) - 10, 8, 20);
        ctx.fillStyle = i < tokens.length - 2 ? "#e7e9ee" : "#8f97a8";
        ctx.textAlign = "left";
        ctx.fillText(label, xR + 14, by(i) + 4);
      });
      ctx.fillStyle = "#3a4152";
      ctx.fillRect(xL - 4, h * 0.5 - 70, 8, 140);

      const list = [...parts.current.values()];
      for (const p of list) {
        if (!paused && !reduced) {
          p.t += p.s * dt * speed;
          if (p.t >= 1) p.t -= 1;
        }
        if (p.t < 0) {
          p.x = undefined;
          continue;
        }
        const ph = p.t < 0.5 ? p.t * 2 : (p.t - 0.5) * 2;
        const aY = p.a < 0 ? h * 0.5 : ay(p.a);
        const straight = p.a < 0;
        const x = straight ? xL + (xR - xL) * p.t : p.t < 0.5 ? xL + (xM - xL) * ph : xM + (xR - xM) * ph;
        const b = by(rowOf(p.row));
        const y = straight ? h * 0.5 + (b - h * 0.5) * p.t : p.t < 0.5 ? h * 0.5 + (aY - h * 0.5) * ph : aY + (b - aY) * ph;
        ctx.fillStyle = cssColor(costColor(Math.min(1, p.row.fee_usd / top)));
        ctx.globalAlpha = p.row.status === "failed" ? 0.45 : 0.85;
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
        p.x = x;
        p.y = y;
      }
      ctx.globalAlpha = 1;
      if (!paused && !reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onResize = () => requestAnimationFrame(draw);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [d, paused, reduced, shownCount]);

  // Click a particle: open its transaction (PROJECT.md 3.1, every visual traces back to its source).
  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: { hash: string; d: number } | null = null;
    for (const p of parts.current.values()) {
      if (p.x === undefined || p.y === undefined) continue;
      const dist = Math.hypot(p.x - px, p.y - py);
      if (dist < 8 && (!best || dist < best.d)) best = { hash: p.row.hash, d: dist };
    }
    if (best) router.push(`/tx/${best.hash}`);
  };

  const min = Number(minFee);
  const feed = (d?.rows ?? []).filter((r) => !minFee || (Number.isFinite(min) && r.fee_usd >= min)).slice(0, FEED_ROWS);
  const scope = d
    ? d.source === "rpc"
      ? `Live from RPC: blocks ${d.blocks?.first.toLocaleString("en-US")}–${d.blocks?.last.toLocaleString("en-US")}, ${d.tps?.toFixed(0) ?? NA} tx/s`
      : d.window.end
        ? `Ingested blocks up to ${timeLabel(Date.parse(d.window.end))} UTC (scrubber)`
        : "No blocks ingested before the scrubber time"
    : null;

  let overlay: string | null = null;
  // As in the City: say when the replay ends well before the scrubber because blocks are missing in between.
  const endMs = d?.source === "ingested" && d.window.end ? Date.parse(d.window.end) : null;
  const atMs = state.at ? Date.parse(`${state.at.slice(0, 16)}:59Z`) : null;
  const gap = endMs !== null && atMs !== null && atMs - endMs > 5 * 60_000 ? `No blocks ingested between ${timeLabel(endMs)} and ${state.at?.slice(11, 16)} UTC; the replay shows the last blocks before the scrubber.` : null;
  if (flow.status === "loading" && !d && !paused) overlay = live ? "Reading the newest blocks…" : "Loading the ingested blocks…";
  else if (flow.status === "error" && !d) overlay = live ? "The live read from RPC failed. Retrying." : "Flow data is unavailable.";
  else if (d && d.rows.length === 0) overlay = "No transactions match the filters in these blocks.";

  return (
    <div className="relative min-h-0 overflow-hidden">
      <canvas ref={canvas} onClick={pick} className="absolute inset-0 size-full cursor-crosshair" role="img" aria-label={`Flow: ${shownCount} transactions as particles from source to action type to token`} />

      <StageChips
        items={[
          scope ? { text: scope, title: d?.source === "rpc" ? "Read live from the chain's RPC in the web tier; these transactions may not be ingested yet, so the other lenses may not count them (KL-23)." : undefined } : null,
          sampled ? { text: sampled, title: "Each live read covers the newest blocks. The chain makes more blocks than that between two reads, and those are not shown (PROJECT.md 10.3)." } : null,
          notice,
          gap ? { text: gap } : null,
          { text: `${shownCount.toLocaleString("en-US")} particles${dropped ? `, ${dropped.toLocaleString("en-US")} older dropped` : ""} (cap ${MAX.toLocaleString("en-US")})`, title: `At most ${MAX.toLocaleString("en-US")} particles stay in view; the oldest leave first (PROJECT.md 10.3).` },
          flow.status === "error" && d ? { text: "Refresh failed; showing the last particles. Retrying.", tone: "error" } : null,
          paused ? { text: "Paused", tone: "mute" } : null,
        ]}
      />

      <div className="absolute top-3.5 right-3.5 z-30 flex gap-2">
        {/* The label says what a press does; no aria-pressed on top of a changing label (gate F40). */}
        <button type="button" onClick={() => setPaused((p) => !p)} className="rounded-[3px] border border-line bg-panel px-[11px] py-1.5 text-[12px] text-text hover:border-mute">
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      <div className="absolute right-3.5 bottom-3.5 z-30 w-[300px] rounded-[3px] border border-line bg-panel font-mono text-[11px]">
        <div className="flex items-center justify-between gap-2 border-b border-line px-[9px] py-[5px] text-mute">
          <span>Newest {feed.length}</span>
          <label className="flex items-center gap-1">
            fee ≥ $
            <input value={minFee} onChange={(e) => setMinFee(e.target.value)} inputMode="decimal" placeholder="0" aria-label="Minimum fee in USD" className="w-14 rounded-[2px] border border-line bg-bg px-1 py-px text-text" />
          </label>
        </div>
        <div className="max-h-[158px] overflow-auto">
          {feed.map((r) => (
            <a key={r.hash} href={`/tx/${r.hash}`} className="flex justify-between gap-2 border-b border-line px-[9px] py-[5px] text-text no-underline last:border-b-0 hover:bg-panel2">
              <span>{shortHex(r.hash, 6, 3)}</span>
              <span className="truncate text-mute">{r.action}</span>
              <span className={r.status === "failed" ? "text-c2" : ""} title={r.status === "failed" ? "Failed" : undefined}>{formatValue(r.fee_usd, "avg_fee_usd")}</span>
            </a>
          ))}
        </div>
      </div>

      <div className="absolute bottom-3.5 left-3.5 z-30 max-w-[300px] rounded-[3px] border border-line bg-panel px-[11px] py-[9px] text-[11px] text-mute">
        <div>Particle color: fee, from $0 to the 95th percentile fee in view (dearer ones share the reddest). Size: value moved. Faded: failed. Action &quot;other&quot; has no column and goes straight to its token.</div>
        <div className="my-[5px] h-2 w-[180px] rounded-[2px]" style={{ background: `linear-gradient(90deg, ${cssColor(costColor(0))}, ${cssColor(costColor(0.5))}, ${cssColor(costColor(1))})` }} />
        <div className="mt-1">Click a particle or a feed row to open the transaction.</div>
      </div>

      <StageOverlay text={overlay} />
    </div>
  );
}
