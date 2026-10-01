"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "../hooks.ts";

// Five slow lime lines tie the closing visual to the city; drawing pauses offscreen or under reduced motion.

const LINES = 5;
const SPEED = 0.0022; // phase per frame, deliberately slow

export function Waveform({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let width = 0;
    let height = 0;
    let raf = 0;
    let phase = 0;
    let visible = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const mid = height * 0.62;
      for (let i = 0; i < LINES; i++) {
        const amp = height * (0.10 + i * 0.035);
        const freq = 0.0075 + i * 0.0016;
        const alpha = 0.5 - i * 0.075;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 3) {
          const y = mid + Math.sin(x * freq + phase * (1 + i * 0.35)) * amp + Math.sin(x * freq * 2.7 + phase * 0.6) * amp * 0.22;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(200, 240, 74, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };

    const loop = () => {
      phase += SPEED;
      draw();
      raf = requestAnimationFrame(loop);
    };

    resize();
    if (reduced) {
      draw();
      return;
    }
    const io = new IntersectionObserver((es) => {
      const on = es.some((e) => e.isIntersecting);
      if (on && !visible) {
        visible = true;
        raf = requestAnimationFrame(loop);
      } else if (!on && visible) {
        visible = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(canvas);
    const onVisibility = () => {
      if (document.hidden && visible) {
        visible = false;
        cancelAnimationFrame(raf);
      } else if (!document.hidden && !visible) {
        visible = true;
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(loop);
    const onResize = () => {
      resize();
      if (reduced) draw();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
    };
  }, [reduced]);

  return <canvas ref={ref} aria-hidden className={className} />;
}
