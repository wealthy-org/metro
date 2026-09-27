// Lens switcher (PROJECT.md 7: vertical rail on the left). Icons from project-4-metro-prototype.html.
// Lenses that are not built yet stay visible but disabled with a "soon" label (user decision 2026-09-27).

type Lens = { key: string; label: string; path: string; ready: boolean };

const LENSES: Lens[] = [
  { key: "city", label: "City", path: "M3 21V11h5v10M8 21V4h8v17M16 21v-8h5v8M2 21h20", ready: true },
  { key: "terrain", label: "Terrain", path: "M2 20l6-11 4 6 3-4 7 9z", ready: false },
  { key: "flow", label: "Flow", path: "M3 6h12M3 12h18M3 18h9M15 3l4 3-4 3M17 9l4 3-4 3", ready: false },
  { key: "graph", label: "Graph", path: "", ready: false },
  { key: "heatmap", label: "Heatmap", path: "M3 3h6v6H3zM15 3h6v6h-6zM9 9h6v6H9zM3 15h6v6H3zM15 15h6v6h-6z", ready: false },
  { key: "launchpad", label: "Launchpad", path: "M4 21V3M4 4h13l-3 4 3 4H4", ready: false },
  { key: "split", label: "Split", path: "M3 4h8v16H3zM13 4h8v16h-8z", ready: false },
];

function Icon({ lens }: { lens: Lens }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-[22px] fill-none stroke-current stroke-[1.8] [stroke-linejoin:round]">
      {lens.key === "graph" ? (
        <>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="8" r="2.5" />
          <circle cx="10" cy="18" r="2.5" />
          <path d="M8 7l8 1M7 8l3 8M17 10l-6 7" />
        </>
      ) : (
        <path d={lens.path} />
      )}
    </svg>
  );
}

export function LensRail({ active }: { active: string }) {
  return (
    <nav className="flex flex-col border-r border-line bg-panel py-2" aria-label="Lenses">
      {LENSES.map((lens) => {
        const selected = lens.key === active;
        // "Launchpad" is wider than the 64 px rail at the prototype's 0.06em tracking, so long labels drop it.
        const tracking = lens.label.length > 7 ? "tracking-normal" : "tracking-[0.06em]";
        return (
          <button
            key={lens.key}
            type="button"
            aria-current={selected ? "page" : undefined}
            aria-disabled={!lens.ready || undefined}
            disabled={!lens.ready}
            title={lens.ready ? lens.label : `${lens.label}: coming soon`}
            className={`relative flex h-14 flex-col items-center justify-center gap-[3px] text-[10px] uppercase ${tracking} ${
              selected ? "text-accent before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-[3px] before:bg-accent" : lens.ready ? "text-mute hover:text-text" : "cursor-not-allowed text-mute/60"
            }`}
          >
            <Icon lens={lens} />
            {lens.label}
            {lens.ready ? null : <span className="text-[8px] leading-none tracking-[0.08em] text-mute">soon</span>}
          </button>
        );
      })}
    </nav>
  );
}
