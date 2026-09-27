"use client";

import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import * as THREE from "three";
import { BUILDING_FOOTPRINT, formatMetric, metricValue, slotPosition, type CityBuilding, type CityMetric } from "../../lib/city.ts";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export type CameraPreset = "angle" | "top" | "street";

// Orbit values from the prototype (setCam): theta, phi and radius around the target.
const TARGET = new THREE.Vector3(0, 1.5, 0);
const PRESETS: Record<CameraPreset, { th: number; ph: number; rad: number }> = {
  angle: { th: 0.8, ph: 0.95, rad: 34 },
  top: { th: -Math.PI / 2, ph: 0.12, rad: 34 },
  street: { th: 0.55, ph: 1.42, rad: 18 },
};
const presetPosition = (p: CameraPreset) => {
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
};

function Buildings({ buildings, heights, colors, onSelect, onHover }: Pick<SceneProps, "buildings" | "heights" | "colors" | "onSelect" | "onHover">) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);

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
    });
    m.count = buildings.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // Raycasting against instances uses the bounding sphere; heights change with the metric.
    m.computeBoundingSphere();
    invalidate();
  }, [buildings, heights, colors, invalidate]);

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
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.6} />
    </instancedMesh>
  );
}

function SelectionOutline({ index, height }: { index: number; height: number }) {
  const { x, z } = slotPosition(index);
  // Only the edges are rendered; the source box is not in the scene, so R3F will not dispose it.
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  useEffect(() => () => box.dispose(), [box]);
  return (
    <lineSegments position={[x, height / 2, z]} scale={[BUILDING_FOOTPRINT + 0.25, height + 0.2, BUILDING_FOOTPRINT + 0.25]}>
      <edgesGeometry args={[box]} />
      <lineBasicMaterial color="#c8f04a" />
    </lineSegments>
  );
}

function Labels({ buildings, heights, metric, selectedIndex, onSelect }: Pick<SceneProps, "buildings" | "heights" | "metric" | "selectedIndex" | "onSelect">) {
  return (
    <>
      {buildings.map((b, i) => {
        const { x, z } = slotPosition(i);
        const selected = i === selectedIndex;
        return (
          <Html key={`${b.kind}:${b.key}`} position={[x, (heights[i] ?? 0) + 0.3, z]} center zIndexRange={[20, 0]} style={{ transform: "translateY(-50%)" }}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={selected}
              aria-label={`${b.label}: ${formatMetric(metricValue(b, metric), metric)}. Inspect`}
              className={`whitespace-nowrap text-center text-[11px] tracking-[0.04em] [text-shadow:0_1px_3px_#000] ${selected ? "text-accent" : "text-text"}`}
            >
              {b.label}
              <small className="mt-0.5 block rounded-[2px] bg-bg/80 px-[5px] py-px font-mono text-[10px] text-text">{formatMetric(metricValue(b, metric), metric)}</small>
            </button>
          </Html>
        );
      })}
    </>
  );
}

// Moves the camera to a preset: eased over EASE_MS, or at once under prefers-reduced-motion.
function CameraRig({ preset, nonce, reducedMotion }: { preset: CameraPreset; nonce: number; reducedMotion: boolean }) {
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

function Ground() {
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
      aria-label="City lens: one building per action type and per top Pons token"
    >
      <color attach="background" args={["#0b0d12"]} />
      <fog attach="fog" args={["#0b0d12", 40, 95]} />
      {/* Prototype intensities (three r128 legacy lights) scaled by pi for physically based lighting. */}
      <hemisphereLight args={["#9fb2d6", "#0b0d12", 0.85 * Math.PI]} />
      <directionalLight position={[-14, 24, 10]} intensity={0.7 * Math.PI} />
      <Ground />
      <Buildings buildings={props.buildings} heights={props.heights} colors={props.colors} onSelect={props.onSelect} onHover={props.onHover} />
      {props.selectedIndex >= 0 ? <SelectionOutline index={props.selectedIndex} height={selectedHeight} /> : null}
      {created ? <Labels buildings={props.buildings} heights={props.heights} metric={props.metric} selectedIndex={props.selectedIndex} onSelect={props.onSelect} /> : null}
      <OrbitControls makeDefault target={TARGET.toArray()} enablePan={false} enableDamping={false} minDistance={10} maxDistance={70} minPolarAngle={0.1} maxPolarAngle={1.5} />
      <CameraRig preset={props.preset} nonce={props.presetNonce} reducedMotion={props.reducedMotion} />
    </Canvas>
  );
}
