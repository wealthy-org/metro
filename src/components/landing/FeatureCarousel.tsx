"use client";

import { useState, type KeyboardEvent } from "react";

// A user-controlled, keyboard-operable progression through Surveyor's fact-checking steps; no autoplay.

export type CarouselStep = { k: string; t: string; p: string; who: string };

export function FeatureCarousel({ steps }: { steps: CarouselStep[] }) {
  const [active, setActive] = useState(0);
  const step = steps[active] ?? steps[0];
  if (!step) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const focused = steps.findIndex((_, i) => document.activeElement?.id === `surveyor-step-${i}`);
    const current = focused >= 0 ? focused : active;
    const next = (current + (e.key === "ArrowRight" ? 1 : steps.length - 1)) % steps.length;
    setActive(next);
    document.getElementById(`surveyor-step-${next}`)?.focus();
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-panel p-2" role="group" aria-label="How Surveyor answers">
      <div className="rounded-[7px] bg-bg px-5 py-6">
        <div className="flex flex-wrap justify-center gap-2" role="tablist" aria-label="Steps" onKeyDown={onKey}>
          {steps.map((s, i) => {
            const on = i === active;
            const done = i < active;
            return (
              <button
                key={s.k}
                id={`surveyor-step-${i}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls="surveyor-step-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(i)}
                className={`flex min-h-11 items-center gap-2 rounded-[3px] border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors ${
                  on ? "border-accent/60 bg-accent/10 text-accent" : done ? "border-mute/70 text-mute" : "border-mute/70 text-mute hover:text-text"
                }`}
              >
                <span className={`flex size-4 items-center justify-center rounded-[2px] text-[10px] ${on ? "bg-accent text-[#10130a]" : "border border-line"}`}>{done ? "✓" : i + 1}</span>
                {s.k}
              </button>
            );
          })}
        </div>
        <div id="surveyor-step-panel" role="tabpanel" aria-labelledby={`surveyor-step-${active}`} className="mx-auto mt-7 max-w-[62ch] text-center">
          <h3 className="font-display text-[30px] font-bold leading-[1.05]">{step.t}</h3>
          <p className="mt-2.5 text-[16px] text-mute">{step.p}</p>
          <div className="mx-auto mt-4 w-fit border-t border-dashed border-line px-6 pt-2.5 font-mono text-[11px] text-mute">{step.who}</div>
        </div>
      </div>
    </div>
  );
}
