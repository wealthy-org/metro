"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMetric } from "../../lib/city.ts";
import { shortHex } from "../../lib/format.ts";
import { clusterLabel, nodeColors, type GraphNode, type GraphResponse } from "../../lib/graph.ts";
import type { LayoutIn, LayoutOut } from "./layout.worker.ts";

// Canvas 2D drawing of the Graph (prototype graphFrame; PROJECT.md 10.4). Positions come from the layout worker; this
// component only draws, pans, zooms and hit-tests. Node color: the cost scale of the average fee paid (Phase 9 D3);
// size: the selected metric; the selected node carries the accent; group members a thin ring, white for the group of
// the selected node.

export type GraphSizeMetric = "tx_count" | "gas_volume" | "fail_rate";
type View = { k: number; x: number; y: number };

const EDGE = "#2a3140";
const EDGE_NEAR = "#8f97a8";
const RING = "rgba(143,151,168,0.85)";
const ACCENT = "#c8f04a";
const TEXT = "#e7e9ee";

const sizeValue = (n: GraphNode, m: GraphSizeMetric) => (m === "tx_count" ? n.transfers : m === "gas_volume" ? n.gas_volume : (n.fail_rate ?? 0));
export const nodeName = (n: GraphNode) => n.label ?? shortHex(n.id);

export function GraphCanvas({
  data,
  metric,
  selected,
  onSelect,
  onOpen,
  reduced,
  label,
}: {
  data: GraphResponse;
  metric: GraphSizeMetric;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpen?: (id: string) => void;
  reduced: boolean;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | null>(null);
  const pos = useRef<Float32Array | null>(null);
  const view = useRef<View>({ k: 1, x: 0, y: 0 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const touched = useRef(false);
  const frame = useRef(0);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [settled, setSettled] = useState(false);

  const colors = useMemo(() => nodeColors(data), [data]);
  const radius = useMemo(() => {
    const vals = data.nodes.map((n) => sizeValue(n, metric));
    const max = Math.max(1e-9, ...vals);
    return vals.map((v) => 2.5 + 8 * Math.sqrt(Math.max(0, v) / max));
  }, [data, metric]);
  const selIndex = selected ? data.nodes.findIndex((n) => n.id === selected) : -1;
  const selGroup = selIndex >= 0 ? (data.nodes[selIndex]?.cluster ?? null) : null;
  const near = useMemo(() => {
    const s = new Set<number>();
    if (selIndex < 0) return s;
    for (const e of data.edges) {
      if (e.s === selIndex) s.add(e.t);
      if (e.t === selIndex) s.add(e.s);
    }
    return s;
  }, [data, selIndex]);

  const draw = useCallback(() => {
    frame.current = 0;
    const c = canvas.current;
    const p = pos.current;
    if (!c || !p) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size.current;
    const v = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * (w / 2 + v.x), dpr * (h / 2 + v.y));
    const px = (i: number) => p[i * 2] ?? 0;
    const py = (i: number) => p[i * 2 + 1] ?? 0;
    for (const e of data.edges) {
      const hot = e.s === selIndex || e.t === selIndex;
      ctx.strokeStyle = hot ? EDGE_NEAR : EDGE;
      ctx.lineWidth = (0.6 + Math.log1p(e.n) * 0.35) / v.k;
      ctx.beginPath();
      ctx.moveTo(px(e.s), py(e.s));
      ctx.lineTo(px(e.t), py(e.t));
      ctx.stroke();
    }
    data.nodes.forEach((n, i) => {
      const r = radius[i] ?? 3;
      ctx.fillStyle = colors[i] ?? EDGE;
      ctx.beginPath();
      ctx.arc(px(i), py(i), r, 0, Math.PI * 2);
      ctx.fill();
      if (i === selIndex) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2.2 / v.k;
        ctx.beginPath();
        ctx.arc(px(i), py(i), r + 2.5 / v.k, 0, Math.PI * 2);
        ctx.stroke();
      } else if (n.cluster) {
        ctx.strokeStyle = n.cluster === selGroup ? TEXT : RING;
        ctx.lineWidth = (n.cluster === selGroup ? 1.6 : 0.9) / v.k;
        ctx.beginPath();
        ctx.arc(px(i), py(i), r + 1.6 / v.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    // Names only where they help: the selected node, its neighbours when few, and the center of an ego graph.
    ctx.font = `${11 / v.k}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    const named = new Set<number>([selIndex, ...(near.size <= 12 ? near : [])]);
    if (data.center) named.add(data.nodes.findIndex((n) => n.id === data.center));
    for (const i of named) {
      const n = data.nodes[i];
      if (!n) continue;
      const text = nodeName(n);
      const x = px(i) + (radius[i] ?? 3) + 4 / v.k;
      ctx.fillStyle = "rgba(11,13,18,0.8)";
      ctx.fillRect(x - 2 / v.k, py(i) - 7 / v.k, ctx.measureText(text).width + 4 / v.k, 14 / v.k);
      ctx.fillStyle = i === selIndex ? ACCENT : TEXT;
      ctx.fillText(text, x, py(i));
    }
  }, [data, colors, radius, selIndex, selGroup, near]);

  const request = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const fit = useCallback(() => {
    const p = pos.current;
    if (!p || !data.nodes.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < data.nodes.length; i++) {
      x0 = Math.min(x0, p[i * 2] ?? 0);
      x1 = Math.max(x1, p[i * 2] ?? 0);
      y0 = Math.min(y0, p[i * 2 + 1] ?? 0);
      y1 = Math.max(y1, p[i * 2 + 1] ?? 0);
    }
    const { w, h } = size.current;
    const k = Math.min(4, Math.max(0.05, Math.min((w - 60) / Math.max(1, x1 - x0), (h - 60) / Math.max(1, y1 - y0))));
    view.current = { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
    request();
  }, [data, request]);

  // Canvas size follows its box, at the device pixel ratio (sharp on HiDPI screens).
  useEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      size.current = { w, h, dpr };
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      request();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [request]);

  // The layout restarts only when the shape of the graph changes (the same nodes and lines keep their positions and the
  // reader's zoom through a refresh) or the motion setting does; the worker calls the newest fit and draw.
  const layoutKey = useMemo(() => `${data.center ?? ""}|${data.nodes.map((n) => n.id).join(",")}|${data.edges.map((e) => `${e.s}-${e.t}`).join(",")}`, [data]);
  const dataRef = useRef(data);
  const fitRef = useRef(fit);
  const requestRef = useRef(request);
  useEffect(() => {
    dataRef.current = data;
    fitRef.current = fit;
    requestRef.current = request;
  }, [data, fit, request]);

  // One layout per shape; the worker ends with the component.
  useEffect(() => {
    const data = dataRef.current;
    const w = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    touched.current = false;
    setSettled(false);
    pos.current = null;
    let fitted = false;
    w.onmessage = (e: MessageEvent<LayoutOut>) => {
      pos.current = e.data.pos;
      if (!touched.current && (!fitted || e.data.done)) {
        fitted = true;
        fitRef.current();
      }
      if (e.data.done) setSettled(true);
      requestRef.current();
    };
    const links = new Int32Array(data.edges.length * 2);
    const weights = new Float32Array(data.edges.length);
    data.edges.forEach((e, k) => {
      links[k * 2] = e.s;
      links[k * 2 + 1] = e.t;
      weights[k] = e.n;
    });
    const r = new Float32Array(data.nodes.length);
    const maxT = Math.max(1, ...data.nodes.map((n) => n.transfers));
    data.nodes.forEach((n, i) => {
      r[i] = 2.5 + 8 * Math.sqrt(n.transfers / maxT);
    });
    const msg: LayoutIn = { type: "init", n: data.nodes.length, links, weights, radius: r, center: data.center ? data.nodes.findIndex((n) => n.id === data.center) : -1, reduced };
    w.postMessage(msg, [links.buffer, weights.buffer, r.buffer]);
    return () => {
      w.postMessage({ type: "stop" } satisfies LayoutIn);
      w.terminate();
      worker.current = null;
    };
  }, [layoutKey, reduced]);

  useEffect(() => {
    request();
  }, [request]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    const v = view.current;
    const { w, h } = size.current;
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    return { sx, sy, x: (sx - w / 2 - v.x) / v.k, y: (sy - h / 2 - v.y) / v.k };
  };
  const hit = (x: number, y: number) => {
    const p = pos.current;
    if (!p) return -1;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < data.nodes.length; i++) {
      const dx = (p[i * 2] ?? 0) - x;
      const dy = (p[i * 2 + 1] ?? 0) - y;
      const d = dx * dx + dy * dy;
      const r = (radius[i] ?? 3) + 4 / view.current.k;
      if (d <= r * r && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  };

  const drag = useRef<{ mode: "pan" | "node"; i: number; sx: number; sy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const w = toWorld(e.clientX, e.clientY);
    const i = hit(w.x, w.y);
    drag.current = { mode: i >= 0 ? "node" : "pan", i, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const w = toWorld(e.clientX, e.clientY);
    if (!d) {
      const i = hit(w.x, w.y);
      setHover(i >= 0 ? { i, x: w.sx, y: w.sy } : null);
      return;
    }
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    if (!d.moved) return;
    touched.current = true;
    if (d.mode === "pan") {
      view.current = { ...view.current, x: view.current.x + e.movementX, y: view.current.y + e.movementY };
      request();
    } else if (!reduced) {
      worker.current?.postMessage({ type: "drag", i: d.i, x: w.x, y: w.y } satisfies LayoutIn);
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "node" && d.moved) worker.current?.postMessage({ type: "release", i: d.i } satisfies LayoutIn);
    if (!d.moved) onSelect(d.i >= 0 ? (data.nodes[d.i]?.id ?? null) : null);
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const w = toWorld(e.clientX, e.clientY);
    const v = view.current;
    const k = Math.min(8, Math.max(0.05, v.k * Math.exp(-e.deltaY * 0.0015)));
    const { w: cw, h: ch } = size.current;
    view.current = { k, x: w.sx - cw / 2 - w.x * k, y: w.sy - ch / 2 - w.y * k };
    touched.current = true;
    request();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const v = view.current;
    const step = 40;
    const moves: Record<string, Partial<View>> = { ArrowLeft: { x: v.x + step }, ArrowRight: { x: v.x - step }, ArrowUp: { y: v.y + step }, ArrowDown: { y: v.y - step }, "+": { k: Math.min(8, v.k * 1.25) }, "=": { k: Math.min(8, v.k * 1.25) }, "-": { k: Math.max(0.05, v.k / 1.25) } };
    if (e.key === "0") {
      e.preventDefault();
      touched.current = false;
      fit();
      return;
    }
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    touched.current = true;
    view.current = { ...v, ...m };
    request();
  };

  const hovered = hover ? data.nodes[hover.i] : undefined;
  return (
    <div ref={wrap} className="relative h-full w-full">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="img"
        aria-label={`${label}. Arrow keys pan, plus and minus zoom, 0 fits the graph. The table view lists every node.`}
        className={`block outline-none focus-visible:outline-2 focus-visible:outline-accent ${hovered ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => {
          const w = toWorld(e.clientX, e.clientY);
          const i = hit(w.x, w.y);
          const n = i >= 0 ? data.nodes[i] : undefined;
          if (n && onOpen) onOpen(n.id);
        }}
      />
      {!settled && !reduced ? <span className="pointer-events-none absolute top-14 right-3.5 font-mono text-[11px] text-mute">Laying out…</span> : null}
      {hovered && hover ? (
        <div className="pointer-events-none absolute z-20 max-w-[260px] rounded-[3px] border border-line bg-panel2 px-[9px] py-[7px] text-[12px]" style={{ left: Math.min(hover.x + 14, size.current.w - 270), top: hover.y + 14 }}>
          <b className="font-mono">{nodeName(hovered)}</b>
          <div className="text-mute">{hovered.kind === "contract" ? "Contract" : "Address"}</div>
          <div className="font-mono">
            {hovered.transfers.toLocaleString("en-US")} transfers · sent {hovered.tx_sent.toLocaleString("en-US")} tx · avg fee {formatMetric(hovered.avg_fee_usd, "avg_fee_usd")}
          </div>
          {hovered.cluster ? <div className="text-mute">{clusterLabel({ funder: hovered.cluster, size: data.clusters.find((c) => c.funder === hovered.cluster)?.size ?? 0 })}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
