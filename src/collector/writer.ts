import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { ensureTxPartitions } from "../db/partitions.ts";
import { blocks, ingestCursor, ponsLaunches, tokens, tokenTransfers, txs } from "../db/schema.ts";
import type { BlockBundle } from "./ingest.ts";

// Stays under Postgres' 65,535 bind-parameter limit for the widest table (txs, 14 columns).
const CHUNK = 1_000;

// forward (live): block = highest written, never decreases. backward (backfill): block = lowest written, never increases.
export type CursorUpdate = {
  name: string;
  direction: "forward" | "backward";
  range?: { start: number; end: number };
  blocksPerSecond?: number;
};

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

// ON CONFLICT DO UPDATE rejects a statement that touches the same row twice.
function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((r) => [key(r), r])).values()];
}

// Writes a batch of blocks and moves the cursor in one transaction, so a crash leaves either all or none (PROJECT.md 9.1).
// cursor is null for manual re-ingest of an arbitrary range, which must not move any cursor past unprocessed blocks.
export async function writeBatch(db: Db, cursor: CursorUpdate | null, bundles: BlockBundle[]): Promise<void> {
  if (bundles.length === 0) return;
  const allTxs = bundles.flatMap((b) => b.txs);
  const allTransfers = bundles.flatMap((b) => b.transfers);
  const allTokens = uniqueBy(bundles.flatMap((b) => b.tokens), (t) => t.address);
  const allLaunches = uniqueBy(bundles.flatMap((b) => b.launches), (l) => l.tokenAddress);
  const numbers = bundles.map((b) => b.block.number);

  await ensureTxPartitions(db, allTxs.map((t) => t.ts));

  await db.transaction(async (tx) => {
    await tx.insert(blocks).values(bundles.map((b) => b.block)).onConflictDoNothing();
    for (const rows of chunks(allTxs)) await tx.insert(txs).values(rows).onConflictDoNothing();
    for (const rows of chunks(allTransfers)) await tx.insert(tokenTransfers).values(rows).onConflictDoNothing();
    if (allTokens.length > 0) {
      await tx.insert(tokens).values(allTokens).onConflictDoUpdate({ target: tokens.address, set: { isPons: true } });
    }
    if (allLaunches.length > 0) await tx.insert(ponsLaunches).values(allLaunches).onConflictDoNothing();
    if (cursor === null) return;

    const forward = cursor.direction === "forward";
    const block = forward ? Math.max(...numbers) : Math.min(...numbers);
    const blocksPerSecond = cursor.blocksPerSecond ?? null;
    await tx
      .insert(ingestCursor)
      .values({
        name: cursor.name,
        block,
        rangeStart: cursor.range?.start ?? null,
        rangeEnd: cursor.range?.end ?? null,
        blocksPerSecond,
      })
      .onConflictDoUpdate({
        target: ingestCursor.name,
        set: {
          block: forward ? sql`GREATEST(${ingestCursor.block}, excluded.block)` : sql`LEAST(${ingestCursor.block}, excluded.block)`,
          updatedAt: sql`now()`,
          ...(blocksPerSecond === null ? {} : { blocksPerSecond }),
        },
      });
  });
}

export async function recordError(db: Db, cursorName: string, message: string): Promise<void> {
  await db
    .update(ingestCursor)
    .set({ lastError: message.slice(0, 500), lastErrorAt: sql`now()` })
    .where(eq(ingestCursor.name, cursorName));
}
