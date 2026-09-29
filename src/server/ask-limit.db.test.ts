import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.ts";
import { analystAnswers, facts, users } from "../db/schema.ts";
import { askDailyLimit, checkQuota, countAsk, IP_CAP_FACTOR, type AskIdentity } from "./ask-limit.ts";
import { getStoredAnswer } from "./ask.ts";

// Surveyor's quota and stored answers against the real database (PROJECT.md 13.3, 17; AT 22). Opt in with
// RUN_DB_TESTS=1. Rows are keyed by random ids and removed afterwards.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

describe.skipIf(!enabled)("ask quota and stored answers (AT 22)", () => {
  let db: Db;
  let end: () => Promise<void>;
  const userId = `c:${randomUUID()}`;
  const ipId = `ip:${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  const otherId = `c:${randomUUID()}`;
  const answerId = randomUUID();
  const factKey = `test_fact.${randomUUID().slice(0, 8)}`;
  const identity: AskIdentity = { userId, ipId, newCookie: null };

  async function cleanup() {
    await db.delete(users).where(inArray(users.id, [userId, ipId, otherId]));
    await db.delete(analystAnswers).where(eq(analystAnswers.id, answerId));
    await db.delete(facts).where(eq(facts.key, factKey));
  }

  beforeAll(async () => {
    const created = createDb(process.env.DATABASE_URL, 2);
    db = created.db;
    end = () => created.pool.end();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await end();
  });

  it("counts asks per id and resets on a new UTC day", async () => {
    expect(await checkQuota(db, identity)).toMatchObject({ allowed: true, used: 0, remaining: askDailyLimit() });
    await countAsk(db, identity);
    await countAsk(db, identity);
    expect(await checkQuota(db, identity)).toMatchObject({ allowed: true, used: 2, remaining: askDailyLimit() - 2 });
    await db.execute(sql`UPDATE users SET last_ask_date = CURRENT_DATE - 1 WHERE id = ${userId}`);
    expect((await checkQuota(db, identity)).used).toBe(0);
    await countAsk(db, identity);
    expect((await checkQuota(db, identity)).used).toBe(1);
  });

  it("the per-browser limit blocks when reached", async () => {
    await db.execute(sql`UPDATE users SET daily_ask_count = ${askDailyLimit()}, last_ask_date = CURRENT_DATE WHERE id = ${userId}`);
    expect(await checkQuota(db, identity)).toMatchObject({ allowed: false, reason: "user", remaining: 0 });
  });

  it("the network cap (three times the limit) catches a cleared cookie", async () => {
    const clearedCookie: AskIdentity = { userId: otherId, ipId, newCookie: null };
    await db.execute(sql`UPDATE users SET daily_ask_count = ${askDailyLimit() * IP_CAP_FACTOR}, last_ask_date = CURRENT_DATE WHERE id = ${ipId}`);
    expect(await checkQuota(db, clearedCookie)).toMatchObject({ allowed: false, reason: "ip" });
    await db.execute(sql`UPDATE users SET daily_ask_count = 0 WHERE id = ${ipId}`);
    expect((await checkQuota(db, clearedCookie)).allowed).toBe(true);
  });

  it("a stored answer comes back by id with its sources, and unknown ids are null", async () => {
    const [f] = await db
      .insert(facts)
      .values({ key: factKey, windowStart: new Date("2026-09-22T00:00:00Z"), windowEnd: new Date("2026-09-29T00:00:00Z"), value: "0.9995", n: 42 })
      .returning({ id: facts.id });
    await db.insert(analystAnswers).values({ id: answerId, questionHash: "f".repeat(64), factsRef: [f?.id ?? 0], answer: "Paid share reads 99.95%.", modelUsed: "test-model", validated: true });
    const got = await getStoredAnswer(db, answerId);
    expect(got).toMatchObject({ answer: "Paid share reads 99.95%.", modelUsed: "test-model", validated: true });
    expect(got?.sources).toEqual([
      { fact_key: factKey, value: 0.9995, n: 42, window: { start: "2026-09-22T00:00:00.000Z", end: "2026-09-29T00:00:00.000Z" }, lens_url: "/subsidy" },
    ]);
    expect(await getStoredAnswer(db, "not-an-id")).toBeNull();
    expect(await getStoredAnswer(db, randomUUID())).toBeNull();
  });
});
