"use client";

import { useState } from "react";
import type { DispatchListItemT } from "../../lib/api-types.ts";
import { utcMinute as utc } from "../../lib/format.ts";
import { usePolling } from "../hooks.ts";
import { Markdown } from "./Markdown.tsx";

// Dispatch tab (PROJECT.md 14; Phase 11): the newest reports from /api/v1/dispatch, with Copy Markdown for the newest
// and links to every report page.

const POLL_MS = 120_000;
const KIND_LABEL: Record<string, string> = { daily: "Daily", custom: "Custom", subsidy_impact: "Subsidy impact" };

export function DispatchPane() {
  const res = usePolling<{ dispatch: DispatchListItemT[] }>("/api/v1/dispatch", POLL_MS);
  const list = res.data?.dispatch ?? [];
  const newest = list[0] ?? null;
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copyMarkdown = async (id: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(`/api/v1/dispatch/${id}`);
      const j = (await r.json()) as { body_md?: string };
      if (!r.ok || !j.body_md) throw new Error("read failed");
      await navigator.clipboard.writeText(j.body_md);
      setNote("Markdown copied");
    } catch {
      setNote("The report could not be copied.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Dispatch</h3>
      <p className="mb-3 text-[12px] text-mute">
        One report a day from the same Ledger of Facts: the numbers, the findings, what moved most. Reports are written by the daily cron and by the builder on the{" "}
        <a href="/dispatch" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
          Dispatch page
        </a>
        ; each prints cleanly or downloads as Markdown.
      </p>
      {res.status === "loading" && !res.data ? <p role="status" className="text-mute">Loading reports…</p> : null}
      {res.status === "error" && !res.data ? <p role="status" className="text-c2">Reports are unavailable. Retrying every two minutes.</p> : null}
      {res.data && list.length === 0 ? <p className="text-mute">No report has been written yet. The daily cron writes the first one after a UTC day closes.</p> : null}
      {newest ? (
        <div className="rounded-[3px] border border-line bg-bg p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-[13px]">{KIND_LABEL[newest.kind] ?? newest.kind} report</p>
              <p className="font-mono text-[11px] text-mute">
                {newest.range_label} · written {utc(newest.created_at)}
              </p>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void copyMarkdown(newest.id)}
                className={`rounded-[3px] border border-line bg-panel2 px-[9px] py-[5px] text-[11px] ${busy ? "cursor-not-allowed text-mute" : "hover:border-mute"}`}
              >
                Copy Markdown
              </button>
              <a href={`/dispatch/${newest.id}`} className="rounded-[3px] border border-line bg-panel2 px-[9px] py-[5px] text-[11px] hover:border-mute">
                Open
              </a>
            </div>
          </div>
          {note ? (
            <p role="status" className="mt-1.5 text-[11px] text-mute">
              {note}
            </p>
          ) : null}
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-mute">Preview</summary>
            <div className="mt-2 max-h-[420px] overflow-auto rounded-[3px] border border-line p-3">
              <MarkdownBody id={newest.id} />
            </div>
          </details>
        </div>
      ) : null}
      {list.length > 1 ? (
        <>
          <h4 className="mt-4 mb-1.5 text-[11px] font-medium tracking-[0.08em] text-mute uppercase">Earlier reports</h4>
          <ul className="space-y-1 text-[12px]">
            {list.slice(1, 9).map((r) => (
              <li key={r.id}>
                <a href={`/dispatch/${r.id}`} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
                  {r.id}
                </a>{" "}
                <span className="font-mono text-[11px] text-mute">
                  {KIND_LABEL[r.kind] ?? r.kind} · {r.range_label}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

// The preview fetches the body once when it is first opened.
function MarkdownBody({ id }: { id: string }) {
  const res = usePolling<{ body_md: string }>(`/api/v1/dispatch/${id}`, null);
  if (!res.data) return <p className="text-[12px] text-mute">{res.status === "error" ? "The report could not be read." : "Loading…"}</p>;
  return <Markdown body={res.data.body_md} />;
}
