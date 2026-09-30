// Railway / GitHub Actions cron entry (Phase 14, KL-40): sample the last complete UTC day into the same Neon branch
// production reads. The 400 MB guard and the idempotent slice logic live in sample-days.ts (KL-1, KL-28).
//
//   node scripts/sample-yesterday.ts
import { sampleRange, yesterdayUtc } from "./sample-days.ts";
import { log } from "../src/collector/log.ts";

const day = yesterdayUtc();
log("info", "sampling the last complete UTC day", { day });
try {
  await sampleRange(day, day, 12, 30);
} catch (err) {
  // A failed run must exit non-zero so the cron marks it failed; the JSON line keeps the reason in the logs.
  log("error", "sampled backfill failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
}
