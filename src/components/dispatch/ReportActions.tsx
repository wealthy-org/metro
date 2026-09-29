"use client";

import { useState } from "react";

// The actions of one report (PROJECT.md 14.1; Phase 11 D1): Download Markdown, the browser's print dialog for PDF, and
// a share link. Printing uses the print stylesheet in globals.css.
export function ReportActions({ id, body, title }: { id: string; body: string; title: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const download = () => {
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `metro-${id}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/dispatch/${id}`);
      setCopied("Link copied");
    } catch {
      setCopied(`${window.location.origin}/dispatch/${id}`);
    }
  };
  const button = "rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute";
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <button type="button" onClick={download} className={button}>
        Download Markdown
      </button>
      <button type="button" onClick={() => window.print()} className={button} title={`Print or save “${title}” as PDF`}>
        Download PDF
      </button>
      <button type="button" onClick={() => void copy()} className={button}>
        Copy link
      </button>
      {copied ? (
        <span role="status" className="text-[11px] text-mute">
          {copied}
        </span>
      ) : null}
    </div>
  );
}
