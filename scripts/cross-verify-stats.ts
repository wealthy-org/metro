import { crossCheck } from "../src/server/cross-check.ts";
import { getDb } from "../src/server/http.ts";

// CLI for the accuracy cross-check (PROJECT.md 19, 22 AT 6; Phase 13 D1, option (c) 2026-09-29). Read-only: it stores
// nothing. It compares, per stored sampled day, the estimate the stored blocks give, a fresh uniform random sample of
// `--k` single blocks over RPC (the reference rate, with its 95% CI) and growthepie's per-day txcount.
//   node --env-file=.env scripts/cross-verify-stats.ts --days=7 --k=1000
const arg = (name: string, fallback: number) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number.parseInt(hit.slice(name.length + 3), 10) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const days = arg("days", 7);
const k = arg("k", 1000);
const int = new Intl.NumberFormat("en-US");
const pct = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

const r = await crossCheck(getDb(), { days, k });
console.log(`blocksPerDay=${r.blocksPerDay === null ? "n/a" : int.format(Math.round(r.blocksPerDay))} k=${r.k} days=${days} growthepie=${r.growthepieAvailable ? "yes" : "unavailable"} at=${r.generatedAt}`);
console.log("day        blocks     tx   tx/blk   stored-estimate      ±ci95   rpc-avg(n)         rpc-estimate      ±ci95   growthepie        stored-vs-rpc  stored-vs-gtp  arbos");
let storedSum = 0;
let rpcSum = 0;
let gtpSum = 0;
let diffs: number[] = [];
for (const d of r.days) {
  const s = d.stored;
  const rr = d.random;
  storedSum += s.estimate;
  if (rr) rpcSum += rr.estimate;
  if (d.growthepie) gtpSum += d.growthepie;
  if (d.storedVsRandomPct !== null) diffs.push(d.storedVsRandomPct);
  console.log(
    [
      d.day,
      String(s.blocks).padStart(7),
      String(int.format(s.tx)).padStart(7),
      String(s.txPerBlock).padStart(8),
      int.format(s.estimate).padStart(13),
      `±${int.format(s.ci95)}`.padStart(10),
      rr ? `${rr.avgTxPerBlock.toFixed(2)} (n=${rr.n})`.padStart(12) : "n/a".padStart(12),
      rr ? int.format(rr.estimate).padStart(16) : "n/a".padStart(16),
      rr ? `±${int.format(rr.ci95)}`.padStart(10) : "".padStart(10),
      d.growthepie === null ? "n/a".padStart(13) : int.format(d.growthepie).padStart(13),
      pct(d.storedVsRandomPct).padStart(13),
      pct(d.storedVsGtpPct).padStart(13),
      d.arbosShare === null ? "n/a" : `${(d.arbosShare * 100).toFixed(2)}%`,
    ].join("  "),
  );
}
const avg = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
console.log(
  `aggregate stored=${int.format(storedSum)}${rpcSum ? ` rpc=${int.format(rpcSum)}` : ""}${gtpSum ? ` gtp=${int.format(gtpSum)}` : ""}` +
    `${avg === null ? "" : `  mean(stored-vs-rpc)=${pct(avg)}`}${rpcSum && gtpSum ? `  rpc-vs-gtp=${pct((rpcSum - gtpSum) / gtpSum)}` : ""}`,
);
