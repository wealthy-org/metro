import type { Hex } from "viem";
import { memoized, readClient } from "./rpc-read.ts";

// Contract or not, read from the chain (Phase 9 gate F67, KL-32). Metro only knows a contract from its own data, so the
// busiest addresses of a Graph view, the selected one and the center of an ego graph are asked with eth_getCode. Code
// rarely changes: each answer is kept for a day. The read is time-boxed so a slow RPC never holds the Graph back; what
// answers late is kept for the next request. An address the chain did not answer is simply absent from the result.

export type CodeReader = (addresses: string[]) => Promise<Map<string, boolean>>;

// How many of a view's busiest addresses are checked; the Inspector checks its own address too.
export const CODE_CHECKED = 60;
const CODE_TTL_MS = 24 * 3_600_000;
const CODE_BUDGET_MS = 2_500;

export const readCode: CodeReader = async (addresses) => {
  const out = new Map<string, boolean>();
  const all = Promise.all(
    [...new Set(addresses)].map(async (a) => {
      try {
        out.set(a, await memoized(`code|${a}`, CODE_TTL_MS, async () => ((await readClient().getCode({ address: a as Hex })) ?? "0x") !== "0x"));
      } catch {
        // Not answered: unknown, left out.
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, CODE_BUDGET_MS)))]);
  clearTimeout(timer);
  return new Map(out);
};
