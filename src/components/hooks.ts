"use client";

import { useEffect, useRef, useState } from "react";

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

// `stale` marks data that belongs to an earlier url while the current one loads, so a view can keep it on screen
// instead of blanking. If the current url fails before any success, the old data is dropped: it describes something else.
export type Polled<T> = { status: "loading" | "ready" | "error"; data: T | null; stale: boolean };

// Fetches `url`, and again every `pollMs` while the tab is visible (null: once). At most one request is in flight:
// when the url changes during a request (scrubbing, playback), the request finishes and only the newest url is
// fetched next, so fast changes skip intermediate steps instead of cancelling every request. A null url disables it.
export function usePolling<T>(url: string | null, pollMs: number | null): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ status: "loading", data: null, stale: false });
  const wanted = useRef<string | null>(url);
  const busy = useRef(false);
  const lastGood = useRef<{ url: string; data: T } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    wanted.current = url;
    if (!url) {
      lastGood.current = null;
      setState({ status: "loading", data: null, stale: false });
      return;
    }
    const controller = new AbortController();

    async function run(u: string) {
      busy.current = true;
      try {
        const res = await fetch(u, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as T;
        lastGood.current = { url: u, data };
        if (alive.current) setState({ status: "ready", data, stale: u !== wanted.current });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const keep = lastGood.current && lastGood.current.url === u ? lastGood.current.data : null;
        if (alive.current && u === wanted.current) setState({ status: "error", data: keep, stale: false });
      } finally {
        busy.current = false;
      }
      const next = wanted.current;
      if (next && next !== u && alive.current && !controller.signal.aborted) void run(next);
    }

    setState((s) => ({ status: "loading", data: s.data, stale: s.data !== null }));
    if (!busy.current) void run(url);

    const poll = () => {
      if (!document.hidden && !busy.current && wanted.current === url) void run(url);
    };
    const timer = pollMs === null ? null : setInterval(poll, pollMs);
    document.addEventListener("visibilitychange", poll);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      // The url changed: an in-flight request for it keeps running and hands over to the newest url when done.
      if (wanted.current === null) controller.abort();
    };
  }, [url, pollMs]);

  return state;
}
