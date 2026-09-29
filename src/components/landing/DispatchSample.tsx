"use client";

import { useEffect, useState } from "react";
import type { DispatchListItemT } from "../../lib/api-types.ts";

// The Dispatch sample on the landing (Phase 11 gate F79): it shows the newest stored report instead of a fixed
// sample, and falls back to the shape of a report when none is written yet or the API cannot be reached.
export function DispatchSample() {
  const [newest, setNewest] = useState<{ item: DispatchListItemT; summary: string | null } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetch("/api/v1/dispatch", { cache: "no-store" });
        if (!list.ok) throw new Error("list");
        const { dispatch } = (await list.json()) as { dispatch: DispatchListItemT[] };
        const item = dispatch[0];
        if (!item) return;
        let summary: string | null = null;
        const detail = await fetch(`/api/v1/dispatch/${item.id}`, { cache: "no-store" });
        if (detail.ok) {
          const body = ((await detail.json()) as { body_md?: string }).body_md ?? "";
          summary = /## Summary\n\n([^\n]+)/.exec(body)?.[1] ?? null;
        }
        if (alive) setNewest({ item, summary });
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const panel = "whitespace-pre-wrap rounded-[4px] border border-line bg-panel p-[22px] font-mono text-[13px] leading-[1.7] text-[#c9cfdc]";
  const label = "font-medium text-accent";

  if (newest) {
    return (
      <div className={panel}>
        <b className={label}># Metro Dispatch, {newest.item.range_label}</b>
        {newest.summary ? `\n\n${newest.summary}\n\n` : "\n\n"}
        {"A report can also carry Numbers, Findings, Largest changes, lens pictures drawn from its own facts, a short method and the list of source facts.\n\n"}
        <a href={`/dispatch/${newest.item.id}`} className="underline decoration-mute underline-offset-2 hover:decoration-text">
          Open the newest report
        </a>
      </div>
    );
  }

  return (
    <div className={panel}>
      <b className={label}># Metro Dispatch</b>
      {"\n\n"}
      {failed ? "The newest report could not be read right now; its page is still at /dispatch." : "One report a day, written from the same Ledger of Facts as every lens. Each one has these parts:"}
      {"\n\n"}
      <b className={label}>## Summary</b>
      {"\nWhat moved, in two or three sentences, with the window it covers.\n\n"}
      <b className={label}>## Numbers</b>
      {"\nTransactions, blended fee, paid share (estimate), fail rate, coverage.\n\n"}
      <b className={label}>## Findings</b>
      {"\nThe top insights, each with n and window.\n\n"}
      <b className={label}>## Method</b>
      {"\nAll numbers come from fixed rules over stored facts; every figure is checked against the facts it cites."}
      {"\n\n"}
      <a href="/dispatch" className="underline decoration-mute underline-offset-2 hover:decoration-text">
        Open the archive
      </a>
    </div>
  );
}
