"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { buildingHeights, feeScale, type CityBuilding } from "../../lib/city.ts";
import { Buildings, Ground } from "../city/CityScene.tsx";

// Landing hero (project-4-metro-landing.html lines 398 to 454): the live City buildings under a slowly turning camera.
// Decorative: no picking, hidden from assistive technology; the caption under the headline states the data.
// prefers-reduced-motion stops the rotation, and frames stop while the canvas is off screen.

const noop = () => {};

function Orbit({ reduced, visible }: { reduced: boolean; visible: boolean }) {
  const camera = useThree((s) => s.camera);
  const theta = useRef(0.7);
  useFrame((_, dt) => {
    if (!reduced && visible) theta.current += Math.min(dt, 0.05) * 0.05;
    const rad = 44;
    const ph = 0.98;
    camera.position.set(6 + rad * Math.sin(ph) * Math.cos(theta.current), rad * Math.cos(ph) * 0.9 + 4, rad * Math.sin(ph) * Math.sin(theta.current));
    camera.lookAt(-8, 3, 0);
  });
  return null;
}

export default function HeroScene({ buildings, reduced, visible }: { buildings: CityBuilding[]; reduced: boolean; visible: boolean }) {
  const heights = useMemo(() => buildingHeights(buildings, "tx_count"), [buildings]);
  const colors = useMemo(() => feeScale(buildings).colors, [buildings]);

  return (
    <Canvas
      frameloop={reduced || !visible ? "demand" : "always"}
      flat
      dpr={[1, 2]}
      camera={{ fov: 42, near: 0.1, far: 200 }}
      gl={{ antialias: true }}
      aria-hidden
      style={{ pointerEvents: "none" }}
      onCreated={({ gl }) => gl.domElement.addEventListener("webglcontextlost", (e) => e.preventDefault())}
    >
      <color attach="background" args={["#0b0d12"]} />
      <fog attach="fog" args={["#0b0d12", 34, 88]} />
      <hemisphereLight args={["#9fb2d6", "#0b0d12", 0.9 * Math.PI]} />
      <directionalLight position={[-14, 24, 10]} intensity={0.7 * Math.PI} />
      <Ground />
      <Buildings buildings={buildings} heights={heights} colors={colors} selectedIndex={-1} onSelect={noop} onHover={noop} />
      <Orbit reduced={reduced} visible={visible} />
    </Canvas>
  );
}
