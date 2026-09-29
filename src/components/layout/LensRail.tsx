import Link from "next/link";

// Lens switcher (PROJECT.md 7: vertical rail on the left). Icons from project-4-metro-prototype.html.
// Each lens is its own route, /lens/[name] (KL-21); switching keeps the rest of the view in the query.

export type RailLens = { key: string; label: string; path: string };

export const RAIL_LENSES: RailLens[] = [
  { key: "city", label: "City", path: "M3 21V11h5v10M8 21V4h8v17M16 21v-8h5v8M2 21h20" },
  { key: "terrain", label: "Terrain", path: "M2 20l6-11 4 6 3-4 7 9z" },
  { key: "flow", label: "Flow", path: "M3 6h12M3 12h18M3 18h9M15 3l4 3-4 3M17 9l4 3-4 3" },
  { key: "graph", label: "Graph", path: "" },
  { key: "heatmap", label: "Heatmap", path: "M3 3h6v6H3zM15 3h6v6h-6zM9 9h6v6H9zM3 15h6v6H3zM15 15h6v6h-6z" },
  { key: "launchpad", label: "Launchpad", path: "M4 21V3M4 4h13l-3 4 3 4H4" },
  { key: "split", label: "Split", path: "M3 4h8v16H3zM13 4h8v16h-8z" },
];

function Icon({ lens }: { lens: RailLens }) {
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

export function LensRail({ active, query }: { active: string; query: string }) {
  return (
    <nav className="flex flex-col border-r border-line bg-panel py-2" aria-label="Lenses">
      {RAIL_LENSES.map((lens, index) => {
        const selected = lens.key === active;
        // "Launchpad" is wider than the 64 px rail at the prototype's 0.06em tracking, so long labels drop it.
        const tracking = lens.label.length > 7 ? "tracking-normal" : "tracking-[0.06em]";
        const base = `relative flex h-14 flex-col items-center justify-center gap-[3px] text-[10px] uppercase ${tracking}`;
        return (
          <Link
            key={lens.key}
            href={`/lens/${lens.key}${query ? `?${query}` : ""}`}
            aria-current={selected ? "page" : undefined}
            aria-keyshortcuts={String(index + 1)}
            title={`${lens.label} (${index + 1})`}
            className={`${base} ${selected ? "text-accent before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-[3px] before:bg-accent" : "text-mute hover:text-text"}`}
          >
            <Icon lens={lens} />
            {lens.label}
          </Link>
        );
      })}
    </nav>
  );
}
