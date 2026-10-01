"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../hooks.ts";

// Word-rise on first viewport entry, with no replay; reduced motion reveals the paragraph immediately.

export function TextAnimate({ text, className = "", staggerMs = 22 }: { text: string; className?: string; staggerMs?: number }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  const words = text.split(" ");
  return (
    <p ref={ref} className={className}>
      {words.map((w, i) => (
        <Fragment key={`${w}-${i}`}>
          <span
            className={`inline-block ${reduced ? "" : "transition-[opacity,transform] duration-[520ms] ease-out"} ${shown ? "translate-y-0 opacity-100" : "translate-y-[12px] opacity-0"}`}
            style={reduced ? undefined : { transitionDelay: `${i * staggerMs}ms` }}
          >
            {w}
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </p>
  );
}
