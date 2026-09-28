import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { RULES } from "../engine/insights.ts";
import { minSample } from "../engine/run.ts";
import type { FactsResponse, FactT, InsightsResponse, InsightT } from "../lib/api-types.ts";
import { subjectsOf } from "../lib/insight-match.ts";
import { iso, num, rows } from "./query.ts";

// Reads of the Ledger of Facts and the active insights (PROJECT.md 13.1, 13.2, 16). Active means not yet expired;
// findings come first, attention before info, then "not enough data" rows (AT 15 shows those too).

export type InsightQuery = { rule: string | null; status: "finding" | "not_enough_data" | null; severity: "info" | "attention" | null };

const RULE_IDS: readonly string[] = RULES.map((r) => r.rule);
export const isRule = (v: string) => RULE_IDS.includes(v);

export function parseInsightQuery(params: URLSearchParams): InsightQuery | string {
  const rule = params.get("rule");
  const status = params.get("status");
  const severity = params.get("severity");
  if (rule !== null && !isRule(rule)) return `rule must be one of ${RULE_IDS.join(", ")}`;
  if (status !== null && status !== "finding" && status !== "not_enough_data") return "status must be finding or not_enough_data";
  if (severity !== null && severity !== "info" && severity !== "attention") return "severity must be info or attention";
  return { rule, status, severity };
}

export async function getInsights(db: Db, q: InsightQuery = { rule: null, status: null, severity: null }, now = new Date()): Promise<InsightsResponse> {
  const out = await rows(db, sql`
    SELECT id, rule, status, severity, text, n, window_start, window_end, evidence_url, facts_ref, created_at, expires_at
    FROM insights
    WHERE expires_at > ${now}
      ${q.rule ? sql`AND rule = ${q.rule}` : sql``}
      ${q.status ? sql`AND status = ${q.status}` : sql``}
      ${q.severity ? sql`AND severity = ${q.severity}` : sql``}
    ORDER BY (status = 'finding') DESC, (severity = 'attention') DESC, created_at DESC, rule, id`);
  const refs = (x: Record<string, unknown>) => (Array.isArray(x.facts_ref) ? x.facts_ref.map(Number).filter(Number.isFinite) : []);
  const ids = [...new Set(out.flatMap(refs))];
  const cited = ids.length
    ? await rows(db, sql`SELECT id, key, window_start FROM facts WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const factById = new Map(cited.map((f) => [num(f.id), { key: String(f.key), start: iso(f.window_start) ?? "" }]));
  const insights: InsightT[] = out.map((x) => ({
    id: String(x.id),
    rule: String(x.rule),
    title: RULES.find((r) => r.rule === x.rule)?.title ?? String(x.rule),
    status: x.status === "finding" ? "finding" : "not_enough_data",
    severity: x.severity === "attention" ? "attention" : "info",
    text: String(x.text),
    n: num(x.n),
    window: { start: iso(x.window_start) ?? "", end: iso(x.window_end) ?? "" },
    evidence_url: String(x.evidence_url),
    facts_ref: refs(x),
    subjects: subjectsOf(refs(x).flatMap((id) => factById.get(id) ?? [])),
    created_at: iso(x.created_at) ?? "",
    expires_at: iso(x.expires_at) ?? "",
  }));
  return {
    total: insights.length,
    findings: insights.filter((i) => i.status === "finding").length,
    min_sample: minSample(),
    computed_at: insights.reduce<string | null>((m, i) => (m === null || i.created_at > m ? i.created_at : m), null),
    insights,
    generated_at: new Date().toISOString(),
  };
}

const PREFIX = /^[a-z0-9_.]{0,128}$/;
export const isFactPrefix = (v: string) => PREFIX.test(v);

// Facts whose key starts with `prefix`, newest computation first. `prefix` is validated to [a-z0-9_.] and matched
// with LIKE after escaping, so it can never widen the match.
export async function getFacts(db: Db, prefix: string, limit = 500): Promise<FactsResponse> {
  const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const out = await rows(db, sql`
    SELECT id, key, window_start, window_end, value, n, computed_at FROM facts
    WHERE key LIKE ${pattern} ORDER BY computed_at DESC, key, window_start DESC LIMIT ${limit}`);
  const facts: FactT[] = out.map((x) => ({
    id: num(x.id),
    key: String(x.key),
    window: { start: iso(x.window_start) ?? "", end: iso(x.window_end) ?? "" },
    value: num(x.value),
    n: num(x.n),
    computed_at: iso(x.computed_at) ?? "",
  }));
  return { prefix, total: facts.length, facts, generated_at: new Date().toISOString() };
}
