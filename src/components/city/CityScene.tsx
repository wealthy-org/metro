"use client";

import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import * as THREE from "three";
import { BUILDING_FOOTPRINT, formatMetric, metricValue, slotPosition, type CityBuilding, type CityMetric } from "../../lib/city.ts";
import type { CameraPreset } from "../../lib/view-state.ts";
import type { CameraSync } from "./camera-sync.ts";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export type { CameraPreset };

// Orbit values from the prototype (setCam): theta, phi and radius around the target. Shared with the Terrain.
export const TARGET = new THREE.Vector3(0, 1.5, 0);
const PRESETS: Record<CameraPreset, { th: number; ph: number; rad: number }> = {
  angle: { th: 0.8, ph: 0.95, rad: 34 },
  top: { th: -Math.PI / 2, ph: 0.12, rad: 34 },
  street: { th: 0.55, ph: 1.42, rad: 18 },
};
export const presetPosition = (p: CameraPreset) => {
  const { th, ph, rad } = PRESETS[p];
  return new THREE.Vector3(TARGET.x + rad * Math.sin(ph) * Math.cos(th), TARGET.y + rad * Math.cos(ph), TARGET.z + rad * Math.sin(ph) * Math.sin(th));
};

// 7 action buildings plus up to 6 Pons tokens (lib/city.ts).
const CAPACITY = 13;
const ROADS = [-10, -5, 0, 5, 10];
const EASE_MS = 600;

export type HoverInfo = { index: number; clientX: number; clientY: number } | null;

type SceneProps = {
  buildings: CityBuilding[];
  heights: number[];
  colors: [number, number, number][];
  metric: CityMetric;
  selectedIndex: number;
  preset: CameraPreset;
  presetNonce: number;
  reducedMotion: boolean;
  onSelect: (index: number) => void;
  onHover: (info: HoverInfo) => void;
  onContextLost: () => void;
  vehicles: VehicleSet | null;
  vehiclesMoving: boolean;
  // Automatic quality reduction (PROJECT.md 24.6, AT 29; Phase 13): 0 full, 1 lower DPR, 2 fewer vehicles. The scene
  // reports its measured frame rate once a second while it animates, so the view can step the level.
  quality?: 0 | 1 | 2;
  onFps?: (fps: number) => void;
  // Split lens (Phase 8 D4): the value under each label, the buildings marked as the largest changes, and a camera
  // shared with the other pane.
  valueLabels?: string[];
  marked?: number[];
  cameraSync?: CameraSync;
};

// One frame-rate number per second while the scene renders; a passive component, no DOM.
function FpsSampler({ onFps }: { onFps: (fps: number) => void }) {
  const acc = useRef({ frames: 0, t: 0 });
  useFrame((_, dt) => {
    const a = acc.current;
    a.frames += 1;
    a.t += dt;
    if (a.t >= 1) {
      onFps(a.frames / a.t);
      a.frames = 0;
      a.t = 0;
    }
  });
  return null;
}

function SyncCamera({ sync }: { sync: CameraSync }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!controls) return;
    const me = Symbol("pane");
    let active = false;
    const start = () => (active = true);
    const end = () => (active = false);
    const change = () => {
      if (active) sync.publish(camera.position.clone(), me);
    };
    controls.addEventListener("start", start);
    controls.addEventListener("end", end);
    controls.addEventListener("change", change);
    const off = sync.subscribe((pos, from) => {
      if (from === me) return;
      camera.position.copy(pos);
      controls.target.copy(TARGET);
      controls.update();
      invalidate();
    });
    return () => {
      controls.removeEventListener("start", start);
      controls.removeEventListener("end", end);
      controls.removeEventListener("change", change);
      off();
    };
  }, [sync, camera, controls, invalidate]);
  return null;
}

// Lit-window look of the prototype and the landing hero (PROJECT.md 20, audit A16): each building glows in its own cost
// color. MeshStandardMaterial has one emissive color for all instances, so the instance color is added as emissive
// light in the shader, scaled per instance by aGlow (0.25, or 0.75 for the selected building, as in the prototype).
const GLOW = 0.25;
const GLOW_SELECTED = 0.75;

function glowMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aGlow;\nvarying float vGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = aGlow;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * vGlow;\n#endif");
  };
  m.customProgramCacheKey = () => "metro-building-glow";
  return m;
}

export function Buildings({ buildings, heights, colors, selectedIndex, onSelect, onHover }: Pick<SceneProps, "buildings" | "heights" | "colors" | "selectedIndex" | "onSelect" | "onHover">) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const material = useMemo(glowMaterial, []);
  const glow = useMemo(() => new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY).fill(GLOW), 1), []);
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    buildings.forEach((_, i) => {
      const { x, z } = slotPosition(i);
      const h = heights[i] ?? 0;
      dummy.position.set(x, h / 2, z);
      dummy.scale.set(BUILDING_FOOTPRINT, h, BUILDING_FOOTPRINT);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      const [r, g, b] = colors[i] ?? [0, 0, 0];
      m.setColorAt(i, color.setRGB(r, g, b, THREE.SRGBColorSpace));
      glow.setX(i, i === selectedIndex ? GLOW_SELECTED : GLOW);
    });
    m.count = buildings.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    glow.needsUpdate = true;
    // Raycasting against instances uses the bounding sphere; heights change with the metric.
    m.computeBoundingSphere();
    invalidate();
  }, [buildings, heights, colors, selectedIndex, glow, invalidate]);

  const index = (e: ThreeEvent<PointerEvent | MouseEvent>) => (typeof e.instanceId === "number" && e.instanceId < buildings.length ? e.instanceId : null);

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, CAPACITY]}
      onPointerMove={(e) => {
        e.stopPropagation();
        const i = index(e);
        onHover(i === null ? null : { index: i, clientX: e.nativeEvent.clientX, clientY: e.nativeEvent.clientY });
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        // A drag that orbits the camera also ends in a click; only a still pointer selects.
        if (e.delta > 4) return;
        const i = index(e);
        if (i !== null) onSelect(i);
      }}
    >
      <boxGeometry args={[1, 1, 1]}>
        <primitive object={glow} attach="attributes-aGlow" />
      </boxGeometry>
      <primitive object={material} attach="material" />
    </instancedMesh>
  );
}

function SelectionOutline({ index, height, color = "#c8f04a" }: { index: number; height: number; color?: string }) {
  const { x, z } = slotPosition(index);
  // Only the edges are rendered; the source box is not in the scene, so R3F will not dispose it.
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  useEffect(() => () => box.dispose(), [box]);
  return (
    <lineSegments position={[x, height / 2, z]} scale={[BUILDING_FOOTPRINT + 0.25, height + 0.2, BUILDING_FOOTPRINT + 0.25]}>
      <edgesGeometry args={[box]} />
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

// With `marked` given (Split), the value under a name shows only for marked and selected buildings, so seven labels
// in a small pane stay readable (gate F56); the button's accessible name always carries the value.
function Labels({ buildings, heights, metric, selectedIndex, onSelect, valueLabels, marked }: Pick<SceneProps, "buildings" | "heights" | "metric" | "selectedIndex" | "onSelect" | "valueLabels" | "marked">) {
  return (
    <>
      {buildings.map((b, i) => {
        const { x, z } = slotPosition(i);
        const selected = i === selectedIndex;
        const value = valueLabels?.[i] ?? formatMetric(metricValue(b, metric), metric);
        const showValue = !marked || selected || marked.includes(i);
        return (
          <Html key={`${b.kind}:${b.key}`} position={[x, (heights[i] ?? 0) + 0.3, z]} center zIndexRange={[20, 0]} style={{ transform: "translateY(-50%)" }}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={selected}
              aria-label={`${b.label}: ${value}. Inspect`}
              className={`whitespace-nowrap text-center text-[11px] tracking-[0.04em] [text-shadow:0_1px_3px_#000] ${selected ? "text-accent" : "text-text"}`}
            >
              {b.label}
              {showValue ? <small className="mt-0.5 block rounded-[2px] bg-bg/80 px-[5px] py-px font-mono text-[10px] text-text">{value}</small> : null}
            </button>
          </Html>
        );
      })}
    </>
  );
}

// Moves the camera to a preset: eased over EASE_MS, or at once under prefers-reduced-motion.
export function CameraRig({ preset, nonce, reducedMotion }: { preset: CameraPreset; nonce: number; reducedMotion: boolean }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const invalidate = useThree((s) => s.invalidate);
  const tween = useRef<{ from: THREE.Vector3; to: THREE.Vector3; start: number } | null>(null);

  useLayoutEffect(() => {
    const to = presetPosition(preset);
    if (reducedMotion || !controls) {
      camera.position.copy(to);
      camera.lookAt(TARGET);
      controls?.target.copy(TARGET);
      controls?.update();
      tween.current = null;
    } else {
      tween.current = { from: camera.position.clone(), to, start: performance.now() };
    }
    invalidate();
    // nonce lets the same preset be applied again after the user orbited away.
  }, [preset, nonce, reducedMotion, camera, controls, invalidate]);

  useFrame(() => {
    const t = tween.current;
    if (!t) return;
    const k = Math.min(1, (performance.now() - t.start) / EASE_MS);
    const eased = 1 - (1 - k) ** 3;
    camera.position.lerpVectors(t.from, t.to, eased);
    controls?.target.copy(TARGET);
    controls?.update();
    if (k < 1) invalidate();
    else tween.current = null;
  });
  return null;
}

// Vehicles (PROJECT.md 10.1; prototype buildCity/moveVehicles): one per sampled live transaction, on the roads, color
// = its fee against the dearest in view, speed following TPS. They move only while `moving` (live data, no reduced
// motion); otherwise they stand still. The demand frame loop is kept running only while they move.
export type VehicleSet = { colors: [number, number, number][]; tps: number | null };
const MAX_VEHICLES = 300;

function Vehicles({ set, moving }: { set: VehicleSet; moving: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const lanes = useMemo(
    () =>
      Array.from({ length: MAX_VEHICLES }, (_, i) => {
        const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
        const road = ROADS[Math.floor(r(1) * ROADS.length)] ?? 0;
        return { horizontal: r(2) < 0.5, lane: road + (r(3) < 0.5 ? -0.25 : 0.25), p: r(4) * 24 - 12, s: (0.4 + r(5) * 0.8) * (r(6) < 0.5 ? 1 : -1) };
      }),
    [],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const count = Math.min(MAX_VEHICLES, set.colors.length);

  const place = (m: THREE.InstancedMesh) => {
    for (let i = 0; i < count; i++) {
      const v = lanes[i];
      if (!v) continue;
      if (v.horizontal) {
        dummy.position.set(v.p, 0.14, v.lane);
        dummy.rotation.set(0, Math.PI / 2, 0);
      } else {
        dummy.position.set(v.lane, 0.14, v.p);
        dummy.rotation.set(0, 0, 0);
      }
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.count = count;
    m.instanceMatrix.needsUpdate = true;
  };

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const c = new THREE.Color();
    set.colors.slice(0, MAX_VEHICLES).forEach(([r, g, b], i) => m.setColorAt(i, c.setRGB(r, g, b, THREE.SRGBColorSpace)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    place(m);
    invalidate();
    // place() reads count and lanes, both derived from the set.
  }, [set, invalidate]);

  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m || !moving || count === 0) return;
    const speed = 0.6 + Math.min(2, (set.tps ?? 0) / 100);
    for (let i = 0; i < count; i++) {
      const v = lanes[i];
      if (!v) continue;
      v.p += v.s * Math.min(dt, 0.05) * speed * 3;
      if (v.p > 12) v.p = -12;
      if (v.p < -12) v.p = 12;
    }
    place(m);
    invalidate();
  });

  useEffect(() => {
    if (moving) invalidate();
  }, [moving, invalidate]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX_VEHICLES]} raycast={() => null}>
      <boxGeometry args={[0.32, 0.16, 0.6]} />
      <meshBasicMaterial />
    </instancedMesh>
  );
}

export function Ground() {
  return (
    <>
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color="#0e1118" roughness={1} />
      </mesh>
      {ROADS.map((p) => (
        <group key={p}>
          <mesh rotation-x={-Math.PI / 2} position={[p, 0.02, 0]}>
            <planeGeometry args={[1.2, 24]} />
            <meshBasicMaterial color="#1b202b" />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, p]}>
            <planeGeometry args={[24, 1.2]} />
            <meshBasicMaterial color="#1b202b" />
          </mesh>
        </group>
      ))}
      {/* Pons district plate behind the action blocks (prototype buildCity). The legend explains it. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 7.5]}>
        <planeGeometry args={[22, 11]} />
        <meshBasicMaterial color="#141a24" />
      </mesh>
    </>
  );
}

export default function CityScene(props: SceneProps) {
  const selectedHeight = props.selectedIndex >= 0 ? (props.heights[props.selectedIndex] ?? 0) : 0;
  // drei Html mounted before the canvas connects its event target renders an empty wrapper that never fills in,
  // so the HTML labels wait until the canvas reports it is created.
  const [created, setCreated] = useState(false);

  return (
    <Canvas
      // The scene is static until the data or the camera changes, so frames render only on demand.
      frameloop="demand"
      flat
      dpr={[1, (props.quality ?? 0) === 0 ? 2 : (props.quality ?? 0) === 1 ? 1.5 : 1]}
      camera={{ fov: 45, near: 0.1, far: 200, position: presetPosition("angle").toArray() }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          props.onContextLost();
        });
        setCreated(true);
      }}
      aria-label="City lens: one building per action type and per top Pons token"
    >
      <color attach="background" args={["#0b0d12"]} />
      <fog attach="fog" args={["#0b0d12", 40, 95]} />
      {/* Prototype intensities (three r128 legacy lights) scaled by pi for physically based lighting. */}
      <hemisphereLight args={["#9fb2d6", "#0b0d12", 0.85 * Math.PI]} />
      <directionalLight position={[-14, 24, 10]} intensity={0.7 * Math.PI} />
      <Ground />
      {props.vehicles ? <Vehicles set={props.vehicles} moving={props.vehiclesMoving} /> : null}
      <Buildings buildings={props.buildings} heights={props.heights} colors={props.colors} selectedIndex={props.selectedIndex} onSelect={props.onSelect} onHover={props.onHover} />
      {props.selectedIndex >= 0 ? <SelectionOutline index={props.selectedIndex} height={selectedHeight} /> : null}
      {/* Largest changes (Split): a white outline, since the accent belongs to the selection (StyleGuide). */}
      {(props.marked ?? []).filter((i) => i !== props.selectedIndex).map((i) => (
        <SelectionOutline key={`mark-${i}`} index={i} height={props.heights[i] ?? 0} color="#e7e9ee" />
      ))}
      {created ? <Labels buildings={props.buildings} heights={props.heights} metric={props.metric} selectedIndex={props.selectedIndex} onSelect={props.onSelect} valueLabels={props.valueLabels} marked={props.marked} /> : null}
      <OrbitControls makeDefault target={TARGET.toArray()} enablePan={false} enableDamping={false} minDistance={10} maxDistance={70} minPolarAngle={0.1} maxPolarAngle={1.5} />
      <CameraRig preset={props.preset} nonce={props.presetNonce} reducedMotion={props.reducedMotion} />
      {props.cameraSync ? <SyncCamera sync={props.cameraSync} /> : null}
      {props.onFps ? <FpsSampler onFps={props.onFps} /> : null}
    </Canvas>
  );
}
