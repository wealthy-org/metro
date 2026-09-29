import { existsSync } from "node:fs";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BlockBundle } from "../collector/ingest.ts";
import { rollupDays, rollupMinutes } from "../collector/rollup.ts";
import { writeBatch } from "../collector/writer.ts";
import { createDb, type Db } from "../db/client.ts";
import { aggDay, aggMinute, blocks, dispatch as dispatchTable, facts, txs } from "../db/schema.ts";
import { dailyReport, runDispatch } from "./build.ts";
import { fmtInt, fmtPct, fmtUsd } from "./parts.ts";

// Dispatch against the Neon dev branch (Phase 11 verification, AT 24): one report per UTC day, every number a stored
// fact. Opt in with RUN_DB_TESTS=1. Fixture day 2020-04-01, own block range, removed afterwards; visible to the
// production site for the few seconds the test runs (KL-22). The model ladder and the budget store are mocked, so the
// test never calls OpenRouter or Redis and the prose falls back to the template.

vi.mock("../analyst/ladder.ts", () => ({
  writeExplanation: vi.fn(async (o: { template: string }) => ({ text: o.template, modelUsed: "template", trail: ["test"] })),
}));
vi.mock("../analyst/budget.ts", () => ({ availableModels: vi.fn(async () => []), setLatestAnswer: vi.fn(async () => {}) }));
vi.mock("../analyst/facts.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analyst/facts.ts")>();
  return {
    ...actual,
    collectTopicData: vi.fn(async () => ({
      topic: "subsidy",
      title: "Subsidy impact",
      scope: { window: "24h", action: null, token: null, address: null },
      lens_url: "/subsidy",
      cites: [],
      extras: [],
      times: [],
      factsPrompt: "",
      template: "Subsidy template (test)",
      enough: false,
      missing: "test",
      labels: {},
    })),
  };
});

const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 917_200_000_000;
const DAY = "2020-04-01";
const at = (hhmmss: string) => new Date(`${DAY}T${hhmmss}Z`);
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const hashOf = (n: number, i: number) => `0x42${n.toString(16).padStart(50, "0")}${i.toString(16).padStart(12, "0")}`;

type Spec = { action: "swap" | "approve" | "contract_call"; fee: string; from: string; status?: number };

function bundle(n: number, ts: Date, specs: Spec[]): BlockBundle {
  return {
    block: { number: n, hash: `0x43${n.toString(16).padStart(62, "0")}`, ts, gasUsed: "300", gasLimit: "1000", baseFee: "20000000", txCount: specs.length },
    txs: specs.map((s, i) => ({
      hash: hashOf(n, i),
      block: n,
      ts,
      fromAddress: s.from,
      toAddress: null,
      value: "0",
      gasUsed: "100",
      gasPrice: "1",
      feeEth: "0",
      feeUsd: s.fee,
      status: s.status ?? 1,
      method: null,
      action: s.action,
      subsidyClass: "likely_paid",
    })),
    transfers: [],
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("Dispatch reports (PROJECT.md 14, AT 24)", () => {
  let db: Db;
  let end: () => Promise<void>;
  let subsidyBefore: typeof dispatchTable.$inferSelect | null = null;
  const now = new Date("2020-04-02T00:05:00Z");

  async function cleanup() {
    await db.delete(aggMinute).where(and(gte(aggMinute.ts, at("00:00:00")), lte(aggMinute.ts, at("23:59:59"))));
    await db.delete(aggDay).where(sql`date = ${DAY}::date`);
    await db.delete(txs).where(and(gte(txs.block, BASE), lte(txs.block, BASE + 100)));
    await db.delete(blocks).where(and(gte(blocks.number, BASE), lte(blocks.number, BASE + 100)));
    await db.delete(facts).where(sql`key LIKE 'dispatch\\_%' AND window_start >= ${new Date("2020-03-31T00:00:00Z")} AND window_start < ${new Date("2020-04-02T00:00:00Z")}`);
    await db.delete(dispatchTable).where(eq(dispatchTable.id, `daily-${DAY}`));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200401"`));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    [subsidyBefore = null] = await db.select().from(dispatchTable).where(eq(dispatchTable.id, "subsidy-impact"));
    await cleanup();
    // 10:xx: three swaps. 15:xx: an approve and a failed contract call.
    await writeBatch(db, null, [
      bundle(BASE + 1, at("10:10:00"), [
        { action: "swap", fee: "0.01", from: A },
        { action: "swap", fee: "0.03", from: B },
        { action: "swap", fee: "0.02", from: A },
      ]),
      bundle(BASE + 2, at("15:20:00"), [
        { action: "approve", fee: "0.002", from: B },
        { action: "contract_call", fee: "0.001", from: C, status: 0 },
      ]),
    ]);
    await rollupMinutes(db, at("10:00:00"), at("16:00:00"));
    await rollupDays(db, [DAY]);
  });

  afterAll(async () => {
    if (db) {
      if (subsidyBefore) {
        await db.insert(dispatchTable).values(subsidyBefore).onConflictDoUpdate({ target: dispatchTable.id, set: subsidyBefore });
      } else {
        await db.delete(dispatchTable).where(eq(dispatchTable.id, "subsidy-impact"));
      }
      await cleanup();
    }
    await end();
  });

  it("writes the day once, reuses it on a second run, and stores its facts (AT 24)", async () => {
    const first = await runDispatch(db, now);
    expect(first).toEqual({ daily: `daily-${DAY}`, subsidy: "subsidy-impact", created: true });
    const second = await runDispatch(db, now);
    expect(second).toEqual({ daily: `daily-${DAY}`, subsidy: "subsidy-impact", created: false });
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(dispatchTable).where(eq(dispatchTable.id, `daily-${DAY}`));
    expect(Number(count?.n)).toBe(1);
    const [row] = await db.select({ kind: dispatchTable.kind, range: dispatchTable.rangeLabel, model: dispatchTable.modelUsed }).from(dispatchTable).where(eq(dispatchTable.id, `daily-${DAY}`));
    expect(row).toMatchObject({ kind: "daily", range: DAY, model: "template" });
  });

  it("states only numbers that are facts, and the facts it lists all exist (AT 24)", async () => {
    const report = await dailyReport(db, now);
    const ids = [...new Set(report.factsRef)];
    expect(ids.length).toBeGreaterThan(0);
    const stored = await db.select({ id: facts.id, key: facts.key, value: facts.value }).from(facts).where(inArray(facts.id, ids));
    expect(stored.length).toBe(ids.length);
    expect(stored.filter((f) => f.key.startsWith("dispatch_")).length).toBeGreaterThan(0);

    // The day's numbers equal a direct SQL read of the daily aggregates the report was built from.
    const [row] = (await db.execute(sql`SELECT sum(tx_count) AS tx, sum(failed_tx_count) AS failed, sum(fee_usd_avg * tx_count) AS fee_sum FROM agg_day WHERE date = ${DAY}::date`)).rows;
    const tx = Number(row?.tx);
    const fee = Number(row?.fee_sum) / tx;
    const failRate = Number(row?.failed) / tx;
    expect(tx).toBe(5);
    expect(report.bodyMd).toContain(`- Transactions: ${fmtInt(tx)} (n = ${fmtInt(tx)})`);
    expect(report.bodyMd).toContain(`- Blended fee: ${fmtUsd(fee)} (n = ${fmtInt(tx)})`);
    expect(report.bodyMd).toContain(`- Paid share (estimate): ${fmtPct(1)} (n = ${fmtInt(tx)})`);
    expect(report.bodyMd).toContain(`- Fail rate: ${fmtPct(failRate)} (n = ${fmtInt(tx)})`);
    expect(stored.some((f) => f.key === "dispatch_tx" && Number(f.value) === tx)).toBe(true);

    // Every cite is listed under Sources (the refs may also carry the facts of cited insights), and the body carries
    // the fixed sections.
    const sources = (report.bodyMd.split("## Sources")[1] ?? "").split("\n").filter((l) => l.startsWith("- "));
    expect(sources.length).toBeGreaterThan(0);
    expect(report.factsRef.length).toBeGreaterThanOrEqual(sources.length);
    for (const head of ["# Metro Dispatch", "## Summary", "## Numbers", "## Method", "## Sources"]) {
      expect(report.bodyMd).toContain(head);
    }
  }, 30_000);
});
