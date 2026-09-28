import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ProfileShell, Section } from "../../components/profile/Profile.tsx";
import { FULL_BLOCK_SHARE } from "../../engine/facts.ts";
import { RULES, THRESHOLDS, type Rule } from "../../engine/insights.ts";
import { minSample } from "../../engine/run.ts";
import { subsidyEnd } from "../../server/filters.ts";

// /methodology (PROJECT.md 7): metric definitions, the insight rules and their thresholds, and the limits a reader
// needs to judge a number. Thresholds and MIN_SAMPLE are read from the engine, so the page cannot drift from it.

export const metadata: Metadata = { title: "Methodology, Metro" };
// MIN_SAMPLE and SUBSIDY_END_DATE are read from the environment the engine uses; re-rendered hourly so a changed
// value shows without a redeploy (gate F46).
export const revalidate = 3600;

const pct = (v: number) => `${Math.round(v * 100)}%`;

const RULE_TEXT: Record<Rule, { measures: string; window: string; condition: string; evidence: string; severity: string }> = {
  cheapest_hour: { measures: "Median swap fee per UTC clock hour", window: "The 24 clock hours ending with the newest block's hour", condition: "At least two hours with the minimum sample; reports the lowest and highest", evidence: "Heatmap cell of the cheapest hour, swaps only; the Inspector shows its median", severity: "Info" },
  action_cost_rank: { measures: "Median fee per transaction for each action type", window: "Last 24 h", condition: "At least two action types with the minimum sample", evidence: "City at Avg fee, with the dearest action in the Inspector (median row)", severity: "Info" },
  gas_spike: { measures: "Average block base fee per clock hour against the median of those hourly values", window: "Last 7 whole UTC days", condition: `An hour at ${THRESHOLDS.gasSpike} times the median or more; reports the peak and the longest run`, evidence: "Heatmap at Gas price, the peak hour selected", severity: "Attention" },
  subsidy_shift: { measures: "Transactions per covered block and paid share (estimate), before and after the subsidy end", window: "7 days before and up to 7 days after", condition: "Both windows with the minimum sample; states how many days the after window covers and the share of blocks sampled", evidence: "The Subsidy Cliff page", severity: "Info" },
  fast_pons_growth: { measures: "Holder change over 24 h per Pons token", window: "Last 24 h", condition: "The largest growth, when that token has the minimum number of holders", evidence: "The token profile (Change 24 h)", severity: "Info" },
  holder_concentration: { measures: "Share of supply held by the 10 largest holders, the token's curve pool and the Pons factory left out", window: "From the launch to the newest block", condition: `Above ${pct(THRESHOLDS.concentration)}, for tokens with the minimum number of holders; up to five tokens`, evidence: "The token profile (Top 10 hold, In pool)", severity: "Info" },
  dominant_wallet: { measures: "The busiest sender's share of an action type's transactions", window: "Last 24 h", condition: `${pct(THRESHOLDS.dominantWallet)} or more, for action types with the minimum sample; the ArbOS system sender is left out`, evidence: "The wallet profile", severity: "Info" },
  failure_rate_rise: { measures: "Share of failed transactions", window: "Last hour against the 24 h before it", condition: `At least ${THRESHOLDS.failRateRatio} times and ${Math.round(THRESHOLDS.failRatePoints * 100)} percentage points higher; names the action with the most failures`, evidence: "City at Fail rate over 1 h, that action in the Inspector", severity: "Attention" },
  block_usage: { measures: `Blocks using ${pct(FULL_BLOCK_SHARE)} or more of their gas limit`, window: "Last 24 h", condition: "At least one such block; names the hour with the most", evidence: "Heatmap at Gas, the busiest hour selected", severity: "Attention" },
  composition_shift: { measures: "Each action type's share of all transactions", window: "Last 24 h against the 24 h before", condition: `The largest change, when it is ${Math.round(THRESHOLDS.compositionPoints * 100)} percentage points or more`, evidence: "City over 24 h with that action in the Inspector (current and previous count)", severity: "Info" },
};

const METRICS: [string, ReactNode][] = [
  ["Transactions", "Count of transactions in the window, every type stored by the Collector, the ArbOS internal one included."],
  ["Gas volume", "Sum of gas used."],
  ["Average fee", "Fee in ETH (gas used times effective gas price) times the ETH price of that minute, averaged. Shown as \"Avg fee (blended)\"."],
  ["Median fee", "percentile_disc(0.5) of the USD fee: an actual fee, the lower middle one for an even count. From raw rows, so only for windows of 24 h or less and for single hours."],
  ["Gas price", "Average base fee of the blocks, in Gwei, chain-wide."],
  ["Wallets", "Distinct sending addresses. Windows of 24 h or less only."],
  ["Fail rate", "Share of transactions with a failed receipt."],
  ["Paid share (estimate)", "Share of user transactions classed likely paid by the subsidy heuristic below. ArbOS internal transactions are left out of it."],
  ["Holders", "Addresses with a positive balance of a token, counted from the token transfers Metro has ingested since the launch. Marked partial when blocks since the launch are missing."],
  ["Top 10 hold", "Balance of the 10 largest holders over the sum of positive balances (the supply), leaving out the token's Pons curve pool and the factory; their part is shown as \"In pool\"."],
  ["Volume 24h", "USD volume over a token's pools from GeckoTerminal, the current value whatever the window."],
];

const LIMITS: [string, string][] = [
  ["Coverage", "The Collector does not run all the time yet, so the database holds only some stretches of blocks. Every lens and insight names its window; a window with no ingested blocks shows nothing rather than a zero."],
  ["When numbers refresh", "Facts and insights are recomputed every 10 minutes while the Collector runs and once a day by a scheduled job. An insight expires 25 hours after it was computed."],
  ["ETH price", "Historical ETH prices come at 5-minute resolution, so a USD fee uses the price of its 5-minute step."],
  ["ArbOS internal transactions", "Every block carries an internal transaction (sometimes two) with a zero fee and the class unknown. They count in transaction totals and fee averages, and are left out of paid share, which is about user transactions."],
  ["Sampled days", "Around the subsidy end, each UTC day is sampled: 12 slices of 30 blocks, one every 2 hours, because a full day is about 17 million transactions. Rates and shares from those blocks hold; per-day totals are the per-block rate times the chain's blocks per day, an estimate. Lenses over those days count only the sampled transactions. Retention is not computed from samples."],
  ["Subsidy classes", "likely_subsidized, likely_paid and unknown come from a heuristic on fees and ERC-4337 paymasters. They are estimates. In the checked blocks no user transaction paid a zero fee, so the rebate does not show on chain as a lower fee and the heuristic finds few subsidized transactions. The wallet class filter maps to these classes."],
  ["Filters on long windows", "Token, value, wallet and status filters need raw rows, so they apply to windows of 24 h or less, and always in the live Flow."],
  ["Live Flow", "The live Flow and the City's vehicles read the newest blocks straight from the chain's RPC. A read covers 10 blocks while the chain makes more between two reads; the lens states the share it shows. These transactions may not be ingested yet, so other lenses may not count them."],
  ["Launchpad", "Launches newer than the ingested blocks are read from the factory's logs for display. Their holders and activity are unknown until their blocks are ingested."],
  ["Swaps on Pons curves", "Buys and sells on a Pons token's curve pool count as swaps from their CurveBuy and CurveSell events."],
  ["Block usage", "Blocks on this chain use a tiny share of their very large gas limit, so the block-usage rule is expected to find nothing."],
];

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[220px_1fr] gap-x-6 gap-y-2.5 text-[14px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium">{k}</dt>
          <dd className="max-w-[78ch] text-mute">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function MethodologyPage() {
  const n = minSample();
  const end = subsidyEnd().slice(0, 10);
  return (
    <ProfileShell kind="Methodology">
      <h1 className="font-display text-[34px] leading-none font-bold">Methodology</h1>
      <p className="mt-3 max-w-[72ch] text-[15px] text-mute">
        How Metro counts, which rules turn counts into insights, and what the numbers cannot tell you. Independent analytics for Robinhood Chain. Not affiliated with Robinhood.
      </p>

      <Section title="Where the numbers come from">
        <div className="max-w-[80ch] space-y-2 text-[14px] text-mute">
          <p>The Collector reads blocks, transactions and receipts from the chain&apos;s RPC and writes them to Postgres with their classification. Minute and day rollups are computed from those rows. Every lens reads the same rows and rollups.</p>
          <p>Windows end at the newest ingested block, not at the clock, so a paused Collector shows its last real numbers together with how far behind it is. A lens opened at a scrubber time ends at the newest block before that time.</p>
          <p>Supporting sources: DefiLlama for the ETH price and chain economics, the Blockscout stats service for chain totals, GeckoTerminal for Pons token volume, price and pools.</p>
        </div>
      </Section>

      <Section title="Metrics">
        <Rows rows={METRICS} />
      </Section>

      <Section title="Action types" note="Each transaction gets exactly one type, by the first rule that matches.">
        <ol className="max-w-[80ch] list-decimal space-y-1 pl-5 text-[14px] text-mute">
          <li><b className="font-medium text-text">Bridge</b>: a Nitro deposit or retryable transaction, or a call to or event from a known bridge.</li>
          <li><b className="font-medium text-text">Token launch</b>: a TokenLaunched event from the Pons factory.</li>
          <li><b className="font-medium text-text">Swap</b>: a swap event from a known router or pool (Uniswap V2, V3, V4, Pons curve buys and sells), or a known swap method.</li>
          <li><b className="font-medium text-text">ERC-20 transfer</b>: an ERC-20 Transfer event without a swap.</li>
          <li><b className="font-medium text-text">Native transfer</b>: value sent to an account without code and without input.</li>
          <li><b className="font-medium text-text">Approve</b>: an approve or setApprovalForAll call.</li>
          <li><b className="font-medium text-text">Contract call</b>: any other call to a contract.</li>
          <li><b className="font-medium text-text">Other</b>: none of the above. Counted in totals, without a City building.</li>
        </ol>
      </Section>

      <Section title="The Ledger of Facts">
        <div className="max-w-[80ch] space-y-2 text-[14px] text-mute">
          <p>Every number an insight cites is first stored as a fact: a key, a window, a value and the sample size n, computed by SQL and code. Facts are listed at <a href="/api/v1/facts" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">/api/v1/facts</a>. A later AI analyst may only write about these facts, and every number it writes is checked against them.</p>
        </div>
      </Section>

      <Section title="Insight rules" note={`Every insight states n and its window. A rule with fewer than ${n} samples is shown as "not enough data", never as a finding. The wording states measured facts; it does not guess intent or advise buying or selling.`}>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-[10px] tracking-[0.08em] text-mute uppercase">
              {["Rule", "Measures", "Window", "Reported when", "Evidence", "Severity"].map((h) => (
                <th key={h} scope="col" className="border-b border-line px-1.5 py-1.5 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RULES.map((r) => {
              const t = RULE_TEXT[r.rule];
              return (
                <tr key={r.rule} className="align-top">
                  <td className="border-b border-line px-1.5 py-[7px] font-medium">{r.title}</td>
                  <td className="border-b border-line px-1.5 py-[7px] text-mute">{t.measures}</td>
                  <td className="border-b border-line px-1.5 py-[7px] text-mute">{t.window}</td>
                  <td className="border-b border-line px-1.5 py-[7px] text-mute">{t.condition}</td>
                  <td className="border-b border-line px-1.5 py-[7px] text-mute">{t.evidence}</td>
                  <td className="border-b border-line px-1.5 py-[7px] text-mute">{t.severity}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 max-w-[80ch] text-[12px] text-mute">
          The evidence link opens the view at the minute of the newest block the insight used, so the lens computes the same window. Wallet profiles count every ingested block, which matches the 24 h figure while the ingested data spans no more than 24 h. The subsidy end is {end} (00:00 UTC).
        </p>
      </Section>

      <Section title="Limits">
        <Rows rows={LIMITS} />
      </Section>
    </ProfileShell>
  );
}
