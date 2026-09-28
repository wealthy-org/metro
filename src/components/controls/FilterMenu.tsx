"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isShortWindow, NO_FILTERS, parseEthAmount, RAW_FILTER_REASON, rawFilterCount, STATUSES, WALLET_CLASSES, type Filters, type TxStatus, type ViewState, type WalletClass } from "../../lib/view-state.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const field = "w-full rounded-[3px] border border-line bg-bg px-2 py-[5px] font-mono text-[12px] text-text";
const labelText = "mb-1 block text-[11px] uppercase tracking-[0.08em] text-mute";

// Token, minimum value, wallet class and status (PROJECT.md 11.2). They need raw rows, so they apply to windows of
// 24 h or less (KL-20); for longer windows the button is disabled and says why.
export function FilterMenu({ state, onChange }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const allowed = isShortWindow(state.window);
  const count = rawFilterCount(state.filters);
  const [token, setToken] = useState(state.filters.token ?? "");
  const [value, setValue] = useState(state.filters.minValue ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToken(state.filters.token ?? "");
    setValue(state.filters.minValue ?? "");
    setError(null);
    panel.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
    // Runs on open only: opening resets the drafts to the applied filters.
  }, [open]);

  const set = (patch: Partial<Filters>) => onChange({ filters: { ...state.filters, ...patch } });

  function applyText() {
    const t = token.trim();
    const v = value.trim();
    if (t && !ADDRESS.test(t)) return setError("Token must be a 0x address of 40 hex characters.");
    if (v && !parseEthAmount(v)) return setError("Minimum value must be an ETH amount such as 0.5.");
    setError(null);
    set({ token: t ? t.toLowerCase() : null, minValue: v || null });
  }

  return (
    <div className="relative flex-none">
      <button
        ref={button}
        type="button"
        disabled={!allowed}
        title={allowed ? "Token, value, wallet class and status" : RAW_FILTER_REASON}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={`rounded-[3px] border px-[11px] py-[5px] text-[12px] ${
          !allowed ? "cursor-not-allowed border-line text-mute/50" : count > 0 ? "border-accent text-accent" : "border-line text-mute hover:text-text"
        }`}
      >
        Filters{count > 0 ? ` · ${count}` : ""}
      </button>
      {open ? (
        <div ref={panel} id={id} role="dialog" aria-label="Filters" className="absolute top-full left-0 z-50 mt-1.5 w-[300px] rounded-[3px] border border-line bg-panel p-3.5 shadow-[0_8px_24px_rgba(0,0,0,.45)]">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              applyText();
            }}
          >
            <label className="mb-3 block">
              <span className={labelText}>Token moved</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} onBlur={applyText} placeholder="0x… token address" spellCheck={false} className={field} />
            </label>
            <label className="mb-3 block">
              <span className={labelText}>Minimum value, ETH</span>
              <input value={value} onChange={(e) => setValue(e.target.value)} onBlur={applyText} inputMode="decimal" placeholder="e.g. 0.5" className={field} />
            </label>
            <button type="submit" className="sr-only">
              Apply
            </button>
          </form>
          <label className="mb-3 block">
            <span className={labelText}>Wallet class</span>
            <select value={state.filters.wallet ?? ""} onChange={(e) => set({ wallet: (e.target.value || null) as WalletClass | null })} className={field}>
              <option value="">All wallets</option>
              {WALLET_CLASSES.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-3 block">
            <span className={labelText}>Status</span>
            <select value={state.filters.status ?? ""} onChange={(e) => set({ status: (e.target.value || null) as TxStatus | null })} className={field}>
              <option value="">Success and failed</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "success" ? "Successful only" : "Failed only"}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <p role="alert" className="mb-2 text-[12px] text-c2">
              {error}
            </p>
          ) : null}
          <p className="mb-3 text-[11px] text-mute">Wallet class is an estimate from fee patterns, not an official label. Applies to windows of 24 h or less.</p>
          <button
            type="button"
            disabled={count === 0}
            onClick={() => {
              setToken("");
              setValue("");
              onChange({ filters: { ...NO_FILTERS, action: state.filters.action } });
            }}
            className="rounded-[3px] border border-line bg-panel2 px-[11px] py-[6px] text-[12px] enabled:hover:border-mute disabled:text-mute/50"
          >
            Clear these filters
          </button>
        </div>
      ) : null}
    </div>
  );
}
