"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { costColor, cssColor } from "../../lib/city.ts";

// The 5,000-object check (PROJECT.md 24.6, AT 29; Phase 13 D2). Synthetic instances, clearly labeled as test data,
// rendered with the same instancing approach as the City. The frame rate is measured here and shown; the page only
// exists in development.

const COUNT = 5_000;
const COLUMNS = 100;

function Instances() {
  const mesh = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const x = (i % COLUMNS) - COLUMNS / 2;
      const z = Math.floor(i / COLUMNS) - COUNT / COLUMNS / 2;
      const h = 0.6 + ((i * 2654435761) % 1000) / 1000 * 2.4;
      position.set(x, h / 2, z);
      scale.set(0.7, h, 0.7);
      matrix.compose(position, quaternion, scale);
      m.setMatrixAt(i, matrix);
      m.setColorAt(i, color.set(cssColor(costColor(((i * 40503) % 1000) / 1000))));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, []);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// One number per second, handed to the DOM overlay; the frame loop itself never triggers a React render.
function Fps({ onFps }: { onFps: (fps: number) => void }) {
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

export function StressScene() {
  const [fps, setFps] = useState<number | null>(null);
  return (
    <div className="relative min-h-0 flex-1">
      <Canvas frameloop="always" flat dpr={[1, 2]} camera={{ fov: 45, near: 0.1, far: 400, position: [60, 55, 60] }}>
        <color attach="background" args={["#0b0d12"]} />
        <Instances />
        <OrbitControls makeDefault enableDamping={false} />
        <Fps onFps={setFps} />
      </Canvas>
      <div className="absolute top-3.5 right-3.5 rounded-[3px] border border-line bg-panel px-[11px] py-2 text-[11px] text-mute">
        <div className="mb-1">{COUNT.toLocaleString("en-US")} synthetic instances, test data</div>
        <div aria-live="off">{fps === null ? "Measuring…" : `Frame rate: ${fps.toFixed(0)} fps`}</div>
      </div>
    </div>
  );
}
