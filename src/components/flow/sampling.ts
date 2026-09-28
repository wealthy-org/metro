"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowResponse } from "../../lib/api-types.ts";

// Stated sampling for the live Flow and the City vehicles (PROJECT.md 10.3, gate F30). Each live read covers the
// newest blocks only, while the chain makes more blocks than that between two reads. Comparing the last block of two
// reads in a row gives how many new blocks the read saw out of how many the chain made.
export type BlockSampling = { read: number; produced: number | null; share: number | null };

export function useBlockSampling(d: FlowResponse | null): BlockSampling | null {
  const prevLast = useRef<number | null>(null);
  const [s, setS] = useState<BlockSampling | null>(null);
  useEffect(() => {
    if (!d || d.source !== "rpc" || !d.blocks) {
      prevLast.current = null;
      setS(null);
      return;
    }
    const { first, last } = d.blocks;
    const read = last - first + 1;
    const prev = prevLast.current;
    if (prev !== null && last === prev) return; // the same shared read again
    prevLast.current = last;
    // The first read, or one after a gap longer than a minute of blocks: only the read size is known.
    if (prev === null || last < prev || last - prev > 3_000) {
      setS((old) => (old && old.produced !== null ? old : { read, produced: null, share: null }));
      return;
    }
    const produced = last - prev;
    const seen = Math.min(read, produced);
    setS({ read: seen, produced, share: seen / produced });
  }, [d]);
  return s;
}

export function samplingText(s: BlockSampling | null): string | null {
  if (!s) return null;
  if (s.produced === null) return `Sampled: the newest ${s.read} blocks of each read`;
  return `Sampled: ${s.read} of the last ${s.produced} new blocks (${Math.round((s.share ?? 1) * 100)}%)`;
}
