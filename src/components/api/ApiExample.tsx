"use client";

import { useEffect, useState } from "react";

// A live example response for /api (Phase 12): the endpoint is fetched once on view, shown pretty-printed (trimmed)
// and paired with a copyable curl line built from the current origin.
export function ApiExample({ path, height = 220 }: { path: string; height?: number }) {
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  // The origin is only known in the browser; the line starts with an ellipsis so server and client markup match.
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    let alive = true;
    (async () => {
      try {
        const res = await fetch(path, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const text = JSON.stringify(await res.json(), null, 2);
        if (alive) setBody(text.length > 3_000 ? `${text.slice(0, 3_000)}\n… (trimmed)` : text);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);

  const curl = `curl '${origin || "…"}${path}'`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-2 rounded-[3px] border border-line bg-bg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-mute">{curl}</code>
        <button type="button" onClick={() => void copy()} className="rounded-[3px] border border-line bg-panel2 px-2 py-[3px] text-[11px] hover:border-mute">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap" style={{ maxHeight: height }}>
        {body ?? (failed ? "The example could not be read right now; the endpoint itself still answers (see the curl line)." : "Loading the live example…")}
      </pre>
    </div>
  );
}
