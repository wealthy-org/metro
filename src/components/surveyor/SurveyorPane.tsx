"use client";

import { useEffect, useState } from "react";
import type { AskResponseT } from "../../lib/api-types.ts";
import { formatCountCompact } from "../../lib/format.ts";
import { TOPICS } from "../../analyst/topics.ts";
import type { ViewState } from "../../lib/view-state.ts";

// Surveyor's ask box and answer card (PROJECT.md 13.3; Phase 10). Free text within the listed topics, mapped by code
// first; the answer shows the model that wrote it, the facts it used, the ladder trail, and a share link. The same
// component serves the side panel and /ask. The scope defaults to the view the asker is looking at.

export type AskSeed = { question: string; scope?: { action?: string | null; token?: string | null; address?: string | null } } | null;

const EXAMPLES = ["hours", "cost", "spike", "subsidy", "fastest", "concentration", "dominant", "fails", "blocks", "composition"] as const;

const scopeOf = (state: ViewState | null, seed: AskSeed) => ({
  window: state?.window ?? "24h",
  action: seed?.scope?.action ?? state?.filters.action ?? null,
  token: seed?.scope?.token ?? (state?.sel?.kind === "token" ? state.sel.key : (state?.filters.token ?? null)),
  address: seed?.scope?.address ?? (state?.sel?.kind === "address" ? state.sel.key : null),
});

const badge = "rounded-[3px] border border-line bg-panel2 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute";

export function SurveyorPane({ state = null, seed = null }: { state?: ViewState | null; seed?: AskSeed }) {
  const [question, setQuestion] = useState(seed?.question ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponseT | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (seed?.question) {
      setQuestion(seed.question);
      setResult(null);
      setError(null);
    }
  }, [seed]);

  const submit = async (q: string) => {
    const text = q.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text, scope: scopeOf(state, seed) }) });
      if (!res.ok && res.status !== 429) throw new Error(`status ${res.status}`);
      setResult((await res.json()) as AskResponseT);
    } catch {
      setError("Surveyor is unavailable right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  const share = async (id: string) => {
    const url = `${window.location.origin}/ask?a=${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied("Link copied");
    } catch {
      setCopied(url);
    }
  };

  return (
    <div className="text-[12px]">
      <p className="mb-3 text-mute">Ask in your own words, within the listed topics. Surveyor is given computed facts only, and code checks every number it writes against those facts.</p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <label className="sr-only" htmlFor="ask-question">
          Your question
        </label>
        <textarea
          id="ask-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="e.g. When is swapping cheapest?"
          className="w-full resize-none rounded-[3px] border border-line bg-panel2 px-2 py-1.5 text-[12px] text-text"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-mute">{question.length}/300</span>
          <button type="submit" disabled={busy || question.trim().length < 3} className={`rounded-[3px] border px-[11px] py-[6px] text-[12px] ${busy || question.trim().length < 3 ? "cursor-not-allowed border-line text-mute" : "border-accent bg-accent font-semibold text-[#10130a] hover:opacity-90"}`}>
            {busy ? "Asking…" : "Ask Surveyor"}
          </button>
        </div>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((k) => (
          <button key={k} type="button" onClick={() => void submit(TOPICS[k].question)} disabled={busy} className="rounded-[3px] border border-line bg-panel2 px-2 py-[3px] text-[11px] text-mute hover:border-mute hover:text-text">
            {TOPICS[k].question}
          </button>
        ))}
      </div>

      {error ? (
        <p role="status" className="mt-3 text-c2">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="mt-3 text-mute">
          Reading the facts and walking the model ladder…
        </p>
      ) : null}
      {result ? <AnswerCard r={result} onShare={share} copied={copied} /> : null}
    </div>
  );
}

export function AnswerCard({ r, onShare, copied }: { r: AskResponseT; onShare?: (id: string) => void; copied?: string | null }) {
  const refused = r.refused_reason !== null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {r.topic !== "none" ? <span className="font-display text-[16px] font-bold tracking-[0.01em]">{r.title}</span> : null}
        {r.cached ? <span className={badge}>cache</span> : null}
        {!refused && r.model_used ? <span className={badge}>{r.cached ? r.model_used : `${r.layer_name} · ${r.model_used}`}</span> : null}
        {!refused ? <span className={badge}>checked against {r.sources.length} fact{r.sources.length === 1 ? "" : "s"}</span> : null}
      </div>
      {refused ? (
        <p role="status" className="rounded-[3px] border border-c1 px-[11px] py-2 text-c1">
          {r.refused_reason}
        </p>
      ) : (
        <blockquote className="border-l-[3px] border-accent py-0.5 pl-3 text-[13px] leading-relaxed">{r.answer}</blockquote>
      )}
      {!refused && r.sources.length ? (
        <>
          <h4 className="mt-3 mb-1 text-[10px] font-medium tracking-[0.08em] text-mute uppercase">Sources (the facts behind every number)</h4>
          <table className="w-full border-collapse text-[11px]">
            <tbody>
              {r.sources.map((s) => (
                <tr key={`${s.fact_key}|${s.window.start}`}>
                  <td className="border-b border-line py-[5px] pr-1.5 font-mono">{s.fact_key}</td>
                  <td className="border-b border-line py-[5px] pr-1.5 text-right font-mono">{Number.isInteger(s.value) ? s.value.toLocaleString("en-US") : Math.abs(s.value) >= 1000 ? formatCountCompact(s.value) : s.value.toPrecision(4)}</td>
                  <td className="border-b border-line py-[5px] pr-1.5 text-right font-mono text-mute">n {s.n.toLocaleString("en-US")}</td>
                  <td className="border-b border-line py-[5px] text-right">
                    <a href={s.lens_url} aria-label={`Open ${s.fact_key} in its lens`} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
                      open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {r.trail.length ? (
        <details className="mt-3 text-[11px] text-mute">
          <summary className="cursor-pointer">How this answer was made ({r.trail.length} step{r.trail.length === 1 ? "" : "s"})</summary>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4">
            {r.trail.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </details>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-mute">
        {r.quota.limit ? (
          <span>
            {r.quota.remaining} of {r.quota.limit} questions left today
          </span>
        ) : null}
        {r.id && onShare ? (
          <button type="button" onClick={() => onShare(r.id as string)} className="rounded-[3px] border border-line bg-panel2 px-2 py-[3px] text-text hover:border-mute">
            Copy share link
          </button>
        ) : null}
        {copied ? <span role="status">{copied}</span> : null}
      </div>
      {r.id ? (
        <p className="mt-1 text-[10px] text-mute">
          Shareable: <a href={`/ask?a=${r.id}`} className="font-mono text-text underline decoration-mute underline-offset-2 hover:decoration-text">/ask?a={r.id.slice(0, 8)}…</a>
        </p>
      ) : null}
    </div>
  );
}
