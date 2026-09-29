"use client";

import { useState } from "react";
import { csvString, exportFileName, lensCsv } from "../../lib/export.ts";
import { lensDataUrl, type ViewState } from "../../lib/view-state.ts";

// Export CSV and PNG for the lens on screen (PROJECT.md 11.5; Phase 11 D4). CSV refetches the same API body the view
// is showing and writes its rows; PNG captures the stage's canvas, or its SVG for lenses without one. Files are named
// `metro-<lens>-<window>-<time>`. PNG is unavailable on views that draw no picture.

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function svgToPng(svg: SVGSVGElement): Promise<Blob | null> {
  const box = svg.getBoundingClientRect();
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(Math.max(1, Math.round(box.width))));
  copy.setAttribute("height", String(Math.max(1, Math.round(box.height))));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((ok, fail) => {
      img.onload = ok;
      img.onerror = fail;
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(box.width * 2));
    canvas.height = Math.max(1, Math.round(box.height * 2));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok) => canvas.toBlob((b) => ok(b), "image/png"));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ExportMenu({ lens, state, windowLabel }: { lens: string; state: ViewState; windowLabel: string }) {
  const [busy, setBusy] = useState<"csv" | "png" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onCsv = async () => {
    const url = lensDataUrl(lens, state);
    if (!url) {
      setNote("Export CSV: this view needs a selection first.");
      return;
    }
    setBusy("csv");
    setNote(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setNote("Export CSV: the data could not be read. Try again.");
        return;
      }
      const t = lensCsv(lens, await res.json());
      if (!t) {
        setNote("Export CSV: this lens has no table to export.");
        return;
      }
      download(exportFileName(lens, windowLabel, state.at), new Blob([csvString(t.header, t.rows)], { type: "text/csv;charset=utf-8" }));
    } catch {
      setNote("Export CSV: the data could not be read. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const onPng = async () => {
    setBusy("png");
    setNote(null);
    try {
      const main = document.querySelector("main");
      const canvas = main?.querySelector("canvas");
      let blob: Blob | null = null;
      if (canvas) {
        blob = await new Promise((ok) => (canvas as HTMLCanvasElement).toBlob((b) => ok(b), "image/png"));
      } else {
        const svg = main?.querySelector("svg");
        if (svg) blob = await svgToPng(svg as SVGSVGElement);
      }
      if (!blob) {
        setNote("Export PNG: this view draws no picture; export CSV instead.");
        return;
      }
      download(exportFileName(lens, windowLabel, state.at).replace(/\.csv$/, ".png"), blob);
    } finally {
      setBusy(null);
    }
  };

  const button = "rounded-[3px] border border-line bg-panel2 px-[9px] py-[5px] text-[11px] hover:border-mute";
  return (
    <div className="ml-auto flex flex-none items-center gap-1.5">
      {note ? (
        <span role="status" className="max-w-[240px] truncate text-[11px] text-mute" title={note}>
          {note}
        </span>
      ) : null}
      <button type="button" onClick={() => void onCsv()} disabled={busy !== null} className={`${button} ${busy !== null ? "cursor-not-allowed text-mute" : ""}`} title="Download the rows behind this view as CSV">
        {busy === "csv" ? "…" : "CSV"}
      </button>
      <button type="button" onClick={() => void onPng()} disabled={busy !== null} className={`${button} ${busy !== null ? "cursor-not-allowed text-mute" : ""}`} title="Download the stage as PNG">
        {busy === "png" ? "…" : "PNG"}
      </button>
    </div>
  );
}
