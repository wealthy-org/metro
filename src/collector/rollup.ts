import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

const MINUTE_MS = 60_000;
const floorMinute = (d: Date) => new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// Recomputes agg_minute from txs for every minute in [from, to]. Whole minutes are rebuilt from raw rows, so a minute
// filled partly by the live loop and partly by the backfill ends up exact (PROJECT.md 9.1 step 5).
export async function rollupMinutes(db: Db, from: Date, to: Date): Promise<void> {
  const start = floorMinute(from);
  const end = new Date(floorMinute(to).getTime() + MINUTE_MS);
  await db.execute(sql`
    INSERT INTO agg_minute (ts, action, tx_count, gas_used, fee_usd_sum, fee_usd_median, wallets)
    SELECT date_trunc('minute', ts), action, count(*), sum(gas_used), sum(fee_usd),
           percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd), count(DISTINCT from_address)
    FROM txs
    WHERE ts >= ${start} AND ts < ${end}
    GROUP BY 1, 2
    ON CONFLICT (ts, action) DO UPDATE SET
      tx_count = excluded.tx_count, gas_used = excluded.gas_used, fee_usd_sum = excluded.fee_usd_sum,
      fee_usd_median = excluded.fee_usd_median, wallets = excluded.wallets`);
}

// Recomputes agg_day (UTC) for the given days from txs.
export async function rollupDays(db: Db, days: Iterable<string>): Promise<void> {
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid day "${day}"`);
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(start.getTime() + 86_400_000);
    await db.execute(sql`
      INSERT INTO agg_day (date, action, subsidy_class, tx_count, gas_used, fee_usd_avg, fee_usd_median, active_wallets, failed_tx_count)
      SELECT ${day}::date, action, subsidy_class, count(*), sum(gas_used), avg(fee_usd),
             percentile_disc(0.5) WITHIN GROUP (ORDER BY fee_usd), count(DISTINCT from_address),
             count(*) FILTER (WHERE status = 0)
      FROM txs
      WHERE ts >= ${start} AND ts < ${end}
      GROUP BY action, subsidy_class
      ON CONFLICT (date, action, subsidy_class) DO UPDATE SET
        tx_count = excluded.tx_count, gas_used = excluded.gas_used, fee_usd_avg = excluded.fee_usd_avg,
        fee_usd_median = excluded.fee_usd_median, active_wallets = excluded.active_wallets,
        failed_tx_count = excluded.failed_tx_count`);
  }
}

// Minute rollups run after every batch; day rollups scan a whole day of txs, so they run at most every
// DAY_INTERVAL_MS per day and once more on shutdown.
const DAY_INTERVAL_MS = 5 * 60_000;

export class Rollups {
  private readonly db: Db;
  private readonly dirtyDays = new Set<string>();
  private lastDayRun = 0;

  constructor(db: Db) {
    this.db = db;
  }

  async afterBatch(timestamps: readonly Date[]): Promise<void> {
    if (timestamps.length === 0) return;
    const times = timestamps.map((t) => t.getTime());
    await rollupMinutes(this.db, new Date(Math.min(...times)), new Date(Math.max(...times)));
    for (const t of timestamps) this.dirtyDays.add(isoDay(t));
    if (Date.now() - this.lastDayRun >= DAY_INTERVAL_MS) await this.flushDays();
  }

  async flushDays(): Promise<void> {
    const days = [...this.dirtyDays];
    this.dirtyDays.clear();
    this.lastDayRun = Date.now();
    try {
      await rollupDays(this.db, days);
    } catch (err) {
      // Keep the days dirty so the next flush retries them.
      for (const d of days) this.dirtyDays.add(d);
      throw err;
    }
  }
}
