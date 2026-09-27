import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";

const created = new Set<string>();

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoDay(d);
}

// Creates the daily txs partitions (UTC) that the given timestamps fall into.
export async function ensureTxPartitions(db: Db, timestamps: readonly Date[]): Promise<void> {
  const days = [...new Set(timestamps.map(isoDay))].filter((d) => !created.has(d));
  for (const day of days) {
    // day is produced by toISOString above, so it is always YYYY-MM-DD and safe to inline.
    const name = `txs_${day.replaceAll("-", "")}`;
    await db.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "txs" FOR VALUES FROM ('${day}') TO ('${nextDay(day)}')`),
    );
    created.add(day);
  }
}
