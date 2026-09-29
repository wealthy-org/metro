"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// The custom report builder (PROJECT.md 14.2; Phase 11 D4). The range is whole UTC days inside the ingested coverage,
// at most 31 days; the lens pictures and the optional sections are picked here. One report counts as one Surveyor
// question.
const LENS_OPTIONS = [
  { value: "both", label: "City and Heatmap" },
  { value: "city", label: "City only" },
  { value: "heatmap", label: "Heatmap only" },
  { value: "none", label: "No pictures" },
] as const;

export function ReportBuilder({ firstDay, lastDay }: { firstDay: string; lastDay: string }) {
  const router = useRouter();
  const [from, setFrom] = useState(lastDay);
  const [to, setTo] = useState(lastDay);
  const [lenses, setLenses] = useState<(typeof LENS_OPTIONS)[number]["value"]>("both");
  const [findings, setFindings] = useState(true);
  const [changes, setChanges] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const field = "rounded-[3px] border border-line bg-panel2 px-2 py-[5px] font-mono text-[12px] text-text [color-scheme:dark]";
  const submit = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to, lenses, sections: { findings, changes } }) });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) {
        setError(j.error ?? "The report could not be built. Try again.");
        return;
      }
      setNote("Report written; opening it…");
      router.push(`/dispatch/${j.id}`);
    } catch {
      setError("The report could not be built. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 text-[12px] text-mute">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          From
          <input type="date" min={firstDay} max={lastDay} value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
        </label>
        <label className="flex items-center gap-1.5">
          to
          <input type="date" min={firstDay} max={lastDay} value={to} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
        <label className="flex items-center gap-1.5">
          Pictures
          <select value={lenses} onChange={(e) => setLenses(e.target.value as typeof lenses)} className={field}>
            {LENS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={findings} onChange={(e) => setFindings(e.target.checked)} />
          Findings
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={changes} onChange={(e) => setChanges(e.target.checked)} />
          Largest changes
        </label>
        <button type="button" disabled={busy} onClick={() => void submit()} className={`rounded-[3px] border px-[11px] py-[6px] text-[12px] ${busy ? "cursor-not-allowed border-line text-mute" : "border-accent bg-accent font-semibold text-[#10130a] hover:opacity-90"}`}>
          {busy ? "Writing…" : "Build report"}
        </button>
      </div>
      <p>
        Whole UTC days between {firstDay} and {lastDay}; at most 31 days. {lenses === "none" ? "The report carries no pictures." : `${LENS_OPTIONS.find((o) => o.value === lenses)?.label ?? ""} pictures are drawn from the report's own facts.`} Summary, Numbers, Method and Sources are always included. One report counts as one Surveyor question. Figures rest on the ingested blocks of those days, which are sampled (12 slices of 30 blocks per UTC day).
      </p>
      {error ? (
        <p role="alert" className="text-c1">
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="text-mute">
          {note}
        </p>
      ) : null}
    </div>
  );
}
