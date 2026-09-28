"use client";

import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { TerrainResponse } from "../../lib/api-types.ts";
import { costColor } from "../../lib/city.ts";
import { bucketMs, timeLabel } from "../../lib/lenses.ts";
import type { CameraPreset } from "../../lib/view-state.ts";
import { CameraRig, presetPosition, TARGET } from "../city/CityScene.tsx";

// Terrain lens scene (PROJECT.md 10.2; prototype buildTerrain/updateTerrain): X = time buckets, Z = action or token
// rows, height and vertex color = the metric on the cost scale. Buckets without data, and buckets after the scrubber
// time, lie flat in the line color. The subsidy end is a lime plane across all rows; custom marks are thin lines.

// Sized to stay inside the stage at the City's camera presets, clear of the legend.
const WIDTH = 22;
const ROW_GAP = 2.1;
const MAX_ELEVATION = 7;
// Under the scene lights the line color reads light; the panel color keeps "no data" quieter than any value.
const EMPTY_RGB: [number, number, number] = [0x15 / 255, 0x19 / 255, 0x22 / 255];

export type TerrainHover = { row: number; bucket: number; clientX: number; clientY: number } | null;

type Props = {
  data: TerrainResponse;
  atMs: number | null;
  marks: number[];
  selectedRow: number;
  preset: CameraPreset;
  presetNonce: number;
  reducedMotion: boolean;
  onPick: (row: number, bucket: number) => void;
  onHover: (h: TerrainHover) => void;
  onContextLost: () => void;
};

type Layout = { cols: number; rows: number; depth: number; gridX: number; gridY: number; start: number; end: number };

function layoutOf(d: TerrainResponse): Layout {
  const cols = d.buckets.length;
  const rows = d.rows.length;
  const step = bucketMs(d.bucket);
  const start = cols ? Date.parse(d.buckets[0] ?? "") : 0;
  return { cols, rows, depth: Math.max(1, rows - 1) * ROW_GAP, gridX: Math.max(1, cols - 1), gridY: Math.max(1, rows - 1), start, end: start + cols * step };
}

const xOfTime = (l: Layout, t: number) => -WIDTH / 2 + ((t - l.start) / Math.max(1, l.end - l.start)) * WIDTH;

function Surface({ data, atMs, onPick, onHover }: Pick<Props, "data" | "atMs" | "onPick" | "onHover">) {
  const invalidate = useThree((s) => s.invalidate);
  const l = useMemo(() => layoutOf(data), [data]);
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(WIDTH, l.depth, l.gridX, l.gridY);
    g.rotateX(-Math.PI / 2);
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 3), 3));
    return g;
  }, [l.depth, l.gridX, l.gridY]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useLayoutEffect(() => {
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const col = geometry.attributes.color as THREE.BufferAttribute;
    const max = data.max && data.max > 0 ? data.max : 1;
    const step = bucketMs(data.bucket);
    const c = new THREE.Color();
    let idx = 0;
    for (let iy = 0; iy <= l.gridY; iy++) {
      const row = data.rows[Math.min(iy, l.rows - 1)];
      for (let ix = 0; ix <= l.gridX; ix++) {
        const b = Math.min(ix, l.cols - 1);
        const bucketStart = l.start + b * step;
        const v = row?.values[b] ?? null;
        const shown = v !== null && (atMs === null || bucketStart <= atMs);
        pos.setY(idx, shown ? (v / max) * MAX_ELEVATION : 0);
        const [r, g, bl] = shown ? costColor(v / max) : EMPTY_RGB;
        c.setRGB(r, g, bl, THREE.SRGBColorSpace);
        col.setXYZ(idx, c.r, c.g, c.b);
        idx++;
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    invalidate();
  }, [geometry, data, atMs, l, invalidate]);

  const cell = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const bucket = Math.round(((e.point.x + WIDTH / 2) / WIDTH) * l.gridX);
    const row = Math.round(((e.point.z + l.depth / 2) / l.depth) * l.gridY);
    return { bucket: Math.max(0, Math.min(l.cols - 1, bucket)), row: Math.max(0, Math.min(l.rows - 1, row)) };
  };

  return (
    <mesh
      geometry={geometry}
      onPointerMove={(e) => {
        e.stopPropagation();
        const c = cell(e);
        onHover({ ...c, clientX: e.nativeEvent.clientX, clientY: e.nativeEvent.clientY });
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta > 4) return;
        const c = cell(e);
        onPick(c.row, c.bucket);
      }}
    >
      <meshStandardMaterial vertexColors roughness={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

function TimeMark({ x, depth, lime, label }: { x: number; depth: number; lime: boolean; label: string }) {
  const color = lime ? "#c8f04a" : "#e7e9ee";
  return (
    <group position={[x, 0, 0]}>
      {lime ? (
        <mesh position={[0, 4, 0]}>
          <boxGeometry args={[0.05, 8, depth + 2]} />
          <meshBasicMaterial color={color} transparent opacity={0.07} depthWrite={false} />
        </mesh>
      ) : null}
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.08, 0.06, depth + 2]} />
        <meshBasicMaterial color={color} transparent={!lime} opacity={lime ? 1 : 0.6} />
      </mesh>
      <Html position={[0, 0.2, -depth / 2 - 1]} center zIndexRange={[20, 0]}>
        <span
          className={`pointer-events-none inline-block -translate-y-full whitespace-nowrap rounded-[2px] border bg-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] ${lime ? "border-accent text-accent" : "border-line text-text"}`}
        >
          {label}
        </span>
      </Html>
    </group>
  );
}

function RowLabels({ data, selectedRow, onPick }: Pick<Props, "data" | "selectedRow" | "onPick">) {
  const l = layoutOf(data);
  return (
    <>
      {data.rows.map((r, i) => (
        <Html key={`${r.kind}:${r.key}`} position={[-WIDTH / 2 - 0.6, 0.2, -l.depth / 2 + i * ROW_GAP]} center zIndexRange={[20, 0]} style={{ transform: "translateX(-50%)" }}>
          <button
            type="button"
            onClick={() => onPick(i, -1)}
            aria-pressed={i === selectedRow}
            aria-label={`${r.label}: inspect`}
            className={`whitespace-nowrap text-[11px] tracking-[0.04em] [text-shadow:0_1px_3px_#000] ${i === selectedRow ? "text-accent" : "text-text"}`}
          >
            {r.label}
          </button>
        </Html>
      ))}
    </>
  );
}

export default function TerrainScene(props: Props) {
  const [created, setCreated] = useState(false);
  const l = layoutOf(props.data);
  const cliff = Date.parse(props.data.subsidy_end);
  const cliffInside = cliff >= l.start && cliff <= l.end;

  return (
    <Canvas
      frameloop="demand"
      flat
      dpr={[1, 2]}
      camera={{ fov: 45, near: 0.1, far: 200, position: presetPosition("angle").toArray() }}
      gl={{ antialias: true }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          props.onContextLost();
        });
        setCreated(true);
      }}
      aria-label="Terrain lens: time across, action types or tokens in depth, height and color from the metric"
    >
      <color attach="background" args={["#0b0d12"]} />
      <fog attach="fog" args={["#0b0d12", 40, 95]} />
      <hemisphereLight args={["#9fb2d6", "#0b0d12", 0.85 * Math.PI]} />
      <directionalLight position={[-14, 24, 10]} intensity={0.7 * Math.PI} />
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]}>
        <planeGeometry args={[WIDTH + 2, l.depth + 2]} />
        <meshBasicMaterial color="#0e1118" />
      </mesh>
      {l.cols > 0 && l.rows > 0 ? <Surface data={props.data} atMs={props.atMs} onPick={props.onPick} onHover={props.onHover} /> : null}
      {created && cliffInside ? <TimeMark x={xOfTime(l, cliff)} depth={l.depth} lime label={`Subsidy ends ${timeLabel(cliff).slice(0, 6)}`} /> : null}
      {created
        ? props.marks.filter((m) => m >= l.start && m <= l.end).map((m) => <TimeMark key={m} x={xOfTime(l, m)} depth={l.depth} lime={false} label={`Mark ${timeLabel(m)}`} />)
        : null}
      {created ? <RowLabels data={props.data} selectedRow={props.selectedRow} onPick={props.onPick} /> : null}
      <OrbitControls makeDefault target={TARGET.toArray()} enablePan={false} enableDamping={false} minDistance={10} maxDistance={70} minPolarAngle={0.1} maxPolarAngle={1.5} />
      <CameraRig preset={props.preset} nonce={props.presetNonce} reducedMotion={props.reducedMotion} />
    </Canvas>
  );
}
