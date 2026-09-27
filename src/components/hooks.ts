"use client";

import { useEffect, useState } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

// `stale` marks data that belongs to the previous url while the new one loads, so a view can keep it on screen
// instead of blanking. If the new url fails before any success, the old data is dropped: it describes something else.
export type Polled<T> = { status: "loading" | "ready" | "error"; data: T | null; stale: boolean };

// Fetches `url` now and every `intervalMs` while the tab is visible. Keeps the last good data on error.
// A null url disables fetching.
export function usePolling<T>(url: string | null, intervalMs: number): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ status: "loading", data: null, stale: false });

  useEffect(() => {
    if (!url) {
      setState({ status: "loading", data: null, stale: false });
      return;
    }
    let controller: AbortController | null = null;
    let last: T | null = null;
    setState((s) => ({ status: "loading", data: s.data, stale: s.data !== null }));

    async function poll() {
      if (document.hidden || !url) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        last = (await res.json()) as T;
        setState({ status: "ready", data: last, stale: false });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ status: "error", data: last, stale: false });
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, [url, intervalMs]);

  return state;
}
