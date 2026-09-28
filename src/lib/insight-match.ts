import type { InsightT } from "./api-types.ts";

// Which insights mention an object (PROJECT.md 11.1: the Inspector lists "insight yang menyebutnya"; 15: the token
// profile lists related insights). An insight mentions every subject of the facts it cites (gate F48: the cost
// ranking cites five actions, not only the one its evidence selects), and whatever its evidence link selects.
// Browser-safe.

export type Subject = { kind: "action" | "token" | "hour" | "wallet"; key: string };

const hourKey = (iso: string) => `${iso.slice(0, 13)}:00Z`;

// Subjects named by fact keys (`metric.subject`, see api.md 1.5a), as "kind:key" strings.
export function subjectsOf(facts: { key: string; start: string }[]): string[] {
  const out = new Set<string>();
  for (const { key, start } of facts) {
    const [metric = "", a, b] = key.split(".");
    if (metric === "median_fee_usd" && a && !b) out.add(`action:${a}`);
    if (metric === "median_fee_usd" && b === "hour") out.add(`hour:${hourKey(start)}`);
    if ((metric === "base_fee_gwei" || metric === "full_blocks") && (a === "hour")) out.add(`hour:${hourKey(start)}`);
    if ((metric === "holder_growth_24h" || metric === "top10_share" || metric === "pool_share") && a) out.add(`token:${a}`);
    if (metric === "wallet_share" && a && b) {
      out.add(`action:${a}`);
      out.add(`wallet:${b}`);
    }
    if ((metric === "fail_rate" || metric === "action_share") && a && a !== "all") out.add(`action:${a}`);
  }
  return [...out].sort();
}

export function mentions(insight: Pick<InsightT, "evidence_url" | "subjects">, s: Subject): boolean {
  const key = s.kind === "hour" ? s.key : s.key.toLowerCase();
  if (insight.subjects.includes(`${s.kind}:${key}`)) return true;
  const [path = "", query = ""] = insight.evidence_url.split("?");
  if (s.kind === "token" && path === `/token/${key}`) return true;
  if (s.kind === "wallet" && path === `/wallet/${key}`) return true;
  const sel = new URLSearchParams(query).get("sel");
  if (!sel) return false;
  const sep = sel.indexOf(":");
  const kind = sel.slice(0, sep);
  const value = sel.slice(sep + 1);
  return kind === s.kind && (kind === "hour" ? value === s.key : value.toLowerCase() === key);
}

export const relatedTo = (insights: InsightT[], s: Subject) => insights.filter((i) => mentions(i, s));
