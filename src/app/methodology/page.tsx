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

const SURVEYOR: [string, string][] = [
  ["Topics", "A question maps to one of twelve topics: the cheapest and dearest hour, the fee per action, a gas spike, the subsidy shift, the fastest-growing Pons launch, holder concentration, a dominant wallet, the fail rate, block usage, the composition shift, one token, or one wallet. Anything else is refused with the reason."],
  ["How a question maps", "Keyword rules decide most questions without a model call. What they miss is classified by one model call that returns a topic and scope, which code validates against the lists; a question that maps to nothing useful is refused, not guessed."],
  ["The number check", "Every number a model writes must equal a fact value rounded to the digits written, after the stated unit conversions (%, K, M, B), or be part of the facts' context (sample sizes, window lengths, dates and hours). Anything else rejects the answer."],
  ["The model ladder", "Six free OpenRouter models, one vendor per layer, then a fixed template with no model. A layer is left only for a technical failure (rate limit, server error, timeout, model unavailable), after at most three retries with backoff; a wrong number or advice-like wording retries the same layer twice first. When the account itself is rate limited, or every layer fails, the template answers with the same facts."],
  ["Advice and accusations", "Answers that give financial advice, predict prices, or make identity or intent claims are rejected by the same check and retried or replaced by the template. Refusals name the reason."],
  ["Quota and cache", "Ten questions a day per browser, and three times that per network address, counted by a hashed value; the IP itself is never stored. The same question over the same facts is served from the answer cache and does not count again. Across all of Metro there is also a daily cap of 45 model calls on the free OpenRouter account, with at most 20 per minute."],
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
  ["Graph nodes and edges", "Nodes are addresses; an edge is a native ETH transfer or a token transfer between two of them in the window. The ArbOS sender, the zero address (mints and burns) and failed transactions (they move no value) are left out. The Graph covers windows of 24 h or less and shows at most 1,500 nodes; above that it keeps the strongest neighbours and says how many it trimmed. Node color is the average fee the address paid as sender; grey means it sent nothing in the window. A node is called a contract when Metro knows it is one or when its code on the chain is not empty; the chain is asked for the 60 busiest addresses of a view, the selected address and the center of an ego graph, and any other address stays an address until then."],
  ["Graph groups", "A ring marks wallets that received ETH by plain transfers from the same address in the window, when that address funded at least 2 wallets. It is a pattern in the ingested transfers, not an identity, and not a claim about intent. A wallet's first funder cannot be known from sampled blocks, so Metro does not use it."],
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
        <p className="mt-2 max-w-[80ch] text-[12px] text-mute">
          The bridge rule now has a verified real example: an L2 to L1 withdrawal through ArbSys (block 70,247,568, 23 Sep 2026 05:01 UTC, event <code className="font-mono text-[11px]">L2ToL1Tx</code>) classifies as bridge in the Collector's own classifier (<code className="font-mono text-[11px]">scripts/scan-bridge.ts</code> re-checks any time). L1 to L2 deposits (Nitro transaction types 0x64 and 0x69) have not been observed yet in the scanned windows; when one appears it follows the same rule.
        </p>
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

      <Section title="Surveyor" note="The built-in analyst answers from the Ledger of Facts only (PROJECT.md 13.3).">
        <Rows rows={SURVEYOR} />
      </Section>

      <Section title="Dispatch reports" note="Written reports: one a day for the previous UTC day, the subsidy impact report, and custom reports over a chosen range (PROJECT.md 14).">
        <div className="max-w-[80ch] space-y-2 text-[14px] text-mute">
          <p>Every report is built from the same Ledger of Facts as the lenses: the range's figures (transactions, blended fee, paid share, fail rate, coverage, per-action shares and per-hour counts, and the same figures for the window before, so the changes are facts too) are stored first, then the text is written from them and every number in it is checked against them before the report is stored. <a href="/api/v1/dispatch" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">/api/v1/dispatch</a> lists the reports; each report page prints cleanly, downloads as Markdown, and links the lens views it drew on.</p>
          <p>The pictures in a report are SVG drawn from those facts, not screenshots: the daily run has no browser. Reports are cited back into the facts table, so pruning never removes a fact a report rests on.</p>
        </div>
      </Section>

      <Section title="Accuracy cross-check" note="PROJECT.md 19 and AT 6: estimated day totals against an independent random sample over RPC and growthepie's per-day count.">
        <div className="max-w-[80ch] space-y-2 text-[14px] text-mute">
          <p>
            The stored sample days use 12 fixed-offset slices of 30 blocks, three seconds each (KL-28); with so few samples one burst can throw the day estimate off, and the measured difference from the uniform random reference (n = 1,000 single blocks a day over RPC, <code className="font-mono text-[12px]">eth_getBlockTransactionCountByNumber</code>) ran +5.1% to +254.7% across 22 to 28 Sep 2026, mean +90.9% (KL-37). The reference itself sat +4.6% from growthepie, which is in step with the ArbOS internal transaction counted in every block (KL-7; its share is shown beside the difference on{" "}
            <a href="/data" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
              /data
            </a>
            ).
          </p>
          <p>
            The tolerance is therefore stated from measurement, not assumed: at n = 1,000 the reference carries ±95% of 4% to 9%, and it is the number the cross-check compares against; the stored totals stay labeled estimates and their difference is reported as it is. Sampling those days denser (more slices) would tighten the stored totals and is a separate decision (KL-37, option (b), not taken).
          </p>
        </div>
      </Section>

      <Section title="Limits">
        <Rows rows={LIMITS} />
        <p className="mt-3 max-w-[80ch] text-[14px] text-mute">
          The tables behind every view, their coverage, the day-by-day cross-check and the CSV exports are on{" "}
          <a href="/data" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
            /data
          </a>
          ; the public read endpoints, their limits and live examples are documented on{" "}
          <a href="/api" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
            /api
          </a>
          .
        </p>
      </Section>
    </ProfileShell>
  );
}
