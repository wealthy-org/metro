import { sql } from "drizzle-orm";
import { log } from "../collector/log.ts";
import type { Db } from "../db/client.ts";
import { facts as factsTable, insights as insightsTable } from "../db/schema.ts";
import { anchorAt, subsidyEnd } from "../server/filters.ts";
import { computeFacts, engineWindows } from "./facts.ts";
import { evaluate, type FactRow } from "./insights.ts";

// One engine run (PROJECT.md 13.1, 13.2): facts for the newest ingested block, then every rule. Called by the
// Collector every 10 minutes while it runs and by the daily cron route (Phase 7 D1, KL-26). The facts are read in
// parallel over the pool; the writes are one database transaction behind an advisory lock, so a Collector run and a
// cron call never interleave their writes (the later one is skipped, and the next run catches up).

const LOCK_KEY = 7_707_001;
const EXPIRY_MS = 25 * 3_600_000; // Phase 7 D4
const FACT_RETENTION_DAYS = 30;

export function minSample(): number {
  const v = Number.parseInt(process.env.MIN_SAMPLE ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

export type EngineResult =
  | { status: "skipped"; reason: "locked" | "no_data" }
  | { status: "done"; anchor: string; facts: number; insights: number; findings: number; pruned: number; ms: number };

const factKey = (key: string, start: Date, end: Date) => `${key}|${start.toISOString()}|${end.toISOString()}`;

export async function runEngine(db: Db, now = new Date()): Promise<EngineResult> {
  const t0 = Date.now();
  const anchor = await anchorAt(db, null);
  if (!anchor) {
    log("info", "insight engine skipped", { source: "engine", reason: "no_data" });
    return { status: "skipped", reason: "no_data" };
  }
  const end = new Date(subsidyEnd());
  const windows = engineWindows(anchor, end);
  const { facts, ctx } = await computeFacts(db, windows);

  const result = await db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    const lock = await t.execute(sql`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`);
    if (!(lock.rows[0] as { ok?: boolean } | undefined)?.ok) return { status: "skipped", reason: "locked" } as const;

    const stored: FactRow[] = [];
    if (facts.length) {
      const out = await t
        .insert(factsTable)
        .values(facts.map((f) => ({ key: f.key, windowStart: f.start, windowEnd: f.end, value: String(f.value), n: f.n, computedAt: now })))
        .onConflictDoUpdate({
          target: [factsTable.key, factsTable.windowStart, factsTable.windowEnd],
          set: { value: sql`excluded.value`, n: sql`excluded.n`, computedAt: sql`excluded.computed_at` },
        })
        .returning({ id: factsTable.id, key: factsTable.key, start: factsTable.windowStart, end: factsTable.windowEnd });
      const ids = new Map(out.map((r) => [factKey(r.key, r.start, r.end), r.id]));
      for (const f of facts) {
        const id = ids.get(factKey(f.key, f.start, f.end));
        if (id !== undefined) stored.push({ ...f, id });
      }
    }

    const drafts = evaluate(stored, { ...ctx, minSample: minSample(), windows, subsidyEnd: end });
    // Every rule runs every time, so the new set replaces the old one: a finding that no longer holds disappears.
    await t.delete(insightsTable);
    if (drafts.length) {
      await t.insert(insightsTable).values(
        drafts.map((d) => ({
          id: d.id,
          rule: d.rule,
          status: d.status,
          text: d.text,
          factsRef: d.factIds,
          severity: d.severity,
          n: d.n,
          windowStart: d.start,
          windowEnd: d.end,
          evidenceUrl: d.evidenceUrl,
          createdAt: now,
          expiresAt: new Date(now.getTime() + EXPIRY_MS),
        })),
      );
    }
    // Facts nobody references and older than the retention are dropped (KL-1). Insights and Dispatch (Phase 11)
    // record what they cite.
    const pruned = await t.execute(sql`
      DELETE FROM facts f WHERE f.computed_at < ${new Date(now.getTime() - FACT_RETENTION_DAYS * 86_400_000)}
        AND NOT EXISTS (SELECT 1 FROM insights i WHERE i.facts_ref @> to_jsonb(f.id))
        AND NOT EXISTS (SELECT 1 FROM dispatch d WHERE d.facts_ref @> to_jsonb(f.id))`);
    return {
      status: "done",
      anchor: anchor.toISOString(),
      facts: stored.length,
      insights: drafts.length,
      findings: drafts.filter((d) => d.status === "finding").length,
      pruned: pruned.rowCount ?? 0,
      ms: 0,
    } as const;
  });
  if (result.status === "done") {
    const done = { ...result, ms: Date.now() - t0 };
    log("info", "insight engine run", { source: "engine", ...done });
    return done;
  }
  log("info", "insight engine skipped", { source: "engine", reason: result.reason });
  return result;
}
