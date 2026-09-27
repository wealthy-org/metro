import { existsSync } from "node:fs";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client.ts";
import { blocks, ingestCursor, tokenTransfers, txs } from "../db/schema.ts";
import type { BlockBundle } from "./ingest.ts";
import { writeBatch, type CursorUpdate } from "./writer.ts";

// Integration test against the Neon dev branch (AT 1). Opt in with RUN_DB_TESTS=1; it writes and then removes
// synthetic rows with block numbers far above the real chain head and a 2020-01-01 partition.
const enabled = process.env.RUN_DB_TESTS === "1";
if (enabled && existsSync(".env")) process.loadEnvFile(".env");

const BASE = 900_000_000_000;
const TS = new Date("2020-01-01T00:00:00Z");
const CURSOR = "test-writer";
const MANUAL_CURSOR = "test-writer-manual";
const BACK_CURSOR = "test-writer-backfill";
const LIVE: CursorUpdate = { name: CURSOR, direction: "forward" };
const BACK: CursorUpdate = { name: BACK_CURSOR, direction: "backward", range: { start: BASE + 100, end: BASE + 200 } };
const hash = (n: number, kind: string) => `0x${kind}${n.toString(16).padStart(64 - kind.length, "0")}`;

function bundle(n: number, txBlock = n): BlockBundle {
  const txHash = hash(n, "aa");
  return {
    block: { number: n, hash: hash(n, "bb"), ts: TS, gasUsed: "1", gasLimit: "2", baseFee: "3", txCount: 1 },
    txs: [
      {
        hash: txHash,
        block: txBlock,
        ts: TS,
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: "0x2222222222222222222222222222222222222222",
        value: "0",
        gasUsed: "21000",
        gasPrice: "1",
        feeEth: "0.000000000000021",
        feeUsd: "0.000000000063",
        status: 1,
        method: null,
        action: "native_transfer",
        subsidyClass: "likely_paid",
      },
    ],
    transfers: [
      {
        txHash,
        logIndex: 0,
        tokenAddress: "0x3333333333333333333333333333333333333333",
        fromAddress: "0x1111111111111111111111111111111111111111",
        toAddress: "0x2222222222222222222222222222222222222222",
        amount: "5",
        ts: TS,
      },
    ],
    tokens: [],
    launches: [],
  };
}

describe.skipIf(!enabled)("writeBatch on Postgres (PROJECT.md 9.1, AT 1)", () => {
  let db: Db;
  let end: () => Promise<void>;
  const inRange = (col: typeof blocks.number | typeof txs.block) => and(gte(col, BASE), lte(col, BASE + 1_000));

  async function cleanup() {
    await db.delete(tokenTransfers).where(sql`${tokenTransfers.txHash} like '0xaa%' and ${tokenTransfers.ts} = ${TS}`);
    await db.delete(txs).where(inRange(txs.block));
    await db.delete(blocks).where(inRange(blocks.number));
    await db.delete(ingestCursor).where(inArray(ingestCursor.name, [CURSOR, MANUAL_CURSOR, BACK_CURSOR]));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "txs_20200101"`));
  }

  async function counts() {
    const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(blocks).where(inRange(blocks.number));
    const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(txs).where(inRange(txs.block));
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(tokenTransfers).where(sql`${tokenTransfers.txHash} like '0xaa%' and ${tokenTransfers.ts} = ${TS}`);
    const [c] = await db.select({ block: ingestCursor.block }).from(ingestCursor).where(eq(ingestCursor.name, CURSOR));
    return { blocks: b?.n, txs: t?.n, transfers: r?.n, cursor: c?.block ?? null };
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

  it("re-writing the same blocks changes nothing", async () => {
    const batch = [bundle(BASE + 1), bundle(BASE + 2), bundle(BASE + 3)];
    await writeBatch(db, LIVE, batch);
    const first = await counts();
    await writeBatch(db, LIVE, batch);
    expect(await counts()).toEqual(first);
    expect(first).toEqual({ blocks: 3, txs: 3, transfers: 3, cursor: BASE + 3 });
  });

  it("never moves the cursor backwards", async () => {
    await writeBatch(db, LIVE, [bundle(BASE + 1)]);
    expect((await counts()).cursor).toBe(BASE + 3);
  });

  it("a manual range (null cursor) does not create or move a cursor", async () => {
    await writeBatch(db, null, [bundle(BASE + 4)]);
    const rows = await db.select().from(ingestCursor).where(eq(ingestCursor.name, MANUAL_CURSOR));
    expect(rows).toHaveLength(0);
    expect((await counts()).cursor).toBe(BASE + 3);
  });

  it("a failing batch leaves no partial rows and keeps the cursor", async () => {
    // The transaction references a block that does not exist, so the foreign key fails mid-transaction.
    const broken = bundle(BASE + 10, BASE + 999);
    await expect(writeBatch(db, LIVE, [broken])).rejects.toThrow();
    const [row] = await db.select().from(blocks).where(eq(blocks.number, BASE + 10));
    expect(row).toBeUndefined();
    expect((await counts()).cursor).toBe(BASE + 3);
  });

  it("a backward cursor keeps the lowest block and stores its range", async () => {
    await writeBatch(db, BACK, [bundle(BASE + 150), bundle(BASE + 149)]);
    await writeBatch(db, BACK, [bundle(BASE + 160)]);
    const [row] = await db.select().from(ingestCursor).where(eq(ingestCursor.name, BACK_CURSOR));
    expect(row).toMatchObject({ block: BASE + 149, rangeStart: BASE + 100, rangeEnd: BASE + 200 });
  });
});
