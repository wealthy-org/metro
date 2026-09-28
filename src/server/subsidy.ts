import type { Db } from "../db/client.ts";
import { computeSubsidy, defaultWindows, parseWindow, windowParam, type SubsidyResult, type SubsidyWindow } from "../engine/subsidy.ts";
import { subsidyEnd } from "./filters.ts";
import { memoized } from "./rpc-read.ts";

// Subsidy Cliff reads for /subsidy, the Split lens and GET /api/v1/subsidy (PROJECT.md 12, 16). Windows default to 7
// days before and after SUBSIDY_END_DATE (10.7); the comparator (11.4) passes its own. Results are shared for 60 s.

export type SubsidyParams = { before: SubsidyWindow; after: SubsidyWindow; custom: boolean };
export type SubsidyResponse = SubsidyResult & { windows: { before: string; after: string; custom: boolean } };

export function parseSubsidyParams(params: URLSearchParams): SubsidyParams | string {
  const d = defaultWindows(new Date(subsidyEnd()));
  const before = parseWindow(params.get("before"));
  const after = parseWindow(params.get("after"));
  if (typeof before === "string") return `before: ${before}`;
  if (typeof after === "string") return `after: ${after}`;
  return { before: before ?? d.before, after: after ?? d.after, custom: before !== null || after !== null };
}

export async function getSubsidy(db: Db, p: SubsidyParams): Promise<SubsidyResponse> {
  const key = `subsidy|${windowParam(p.before)}|${windowParam(p.after)}`;
  const result = await memoized(key, 60_000, () => computeSubsidy(db, p.before, p.after, new Date(subsidyEnd())));
  return { ...result, windows: { before: windowParam(p.before), after: windowParam(p.after), custom: p.custom } };
}
