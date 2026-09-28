import type { Metadata } from "next";
import { InsightCard } from "../../components/insights/InsightCard.tsx";
import { Facts, ProfileShell, Section } from "../../components/profile/Profile.tsx";
import { CompareTable, CoverageNote, change, estPerDay, BeforeAfterBars, perBlock, points, share, Timeline, usd } from "../../components/subsidy/SubsidyParts.tsx";
import { BOT_MIN_TX, BOT_PATTERN_SHARE } from "../../engine/subsidy.ts";
import { formatDay, NA } from "../../lib/format.ts";
import { getDb } from "../../server/http.ts";
import { getInsights } from "../../server/insights.ts";
import { getSubsidy, parseSubsidyParams } from "../../server/subsidy.ts";

// /subsidy (PROJECT.md 7, 12): what changed on chain around the end of the Robinhood Wallet gas rebate. The main
// timeline with the end date, the before vs after table with differences and samples, the Split panel, and the method
// (12.4). Figures come from sampled blocks (Phase 8 D1, KL-28) and say so. The written Surveyor summary is Phase 10.

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Subsidy Cliff, Metro" };

const int = new Intl.NumberFormat("en-US");

export default async function SubsidyPage() {
  const db = getDb();
  const p = parseSubsidyParams(new URLSearchParams());
  if (typeof p === "string") throw new Error(p);
  const [data, ins] = await Promise.all([getSubsidy(db, p), getInsights(db, { rule: "subsidy_shift", status: null, severity: null })]);
  const { before: b, after: a } = data;
  const tx = change(b.tx_per_block, a.tx_per_block);
  const splitHref = `/lens/split?before=${data.windows.before}&after=${data.windows.after}`;

  return (
    <ProfileShell kind="Subsidy Cliff">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[34px] leading-none font-bold">Subsidy Cliff</h1>
        <span className="rounded-[3px] border border-accent px-1.5 py-px font-mono text-[10px] tracking-[0.08em] text-accent uppercase">Rebate ends {formatDay(data.cliff_date)}</span>
      </header>
      <p className="mt-3 max-w-[76ch] text-[15px] text-mute">
        Press reports say Robinhood Chain covered gas for Robinhood Wallet transactions for 90 days from launch, ending {formatDay(data.cliff_date)} 2026, with the rebate lowered step by step from mid-August. Those are reports, not facts, so Metro checks them against the chain: {data.windows.before.replace("..", " to ")} before, {data.windows.after.replace("..", " to ")} after.
      </p>
      <CoverageNote data={data} />

      <div className="mt-4">
        <Facts
          items={[
            { label: "Tx per block", value: `${perBlock(b.tx_per_block)} → ${perBlock(a.tx_per_block)}`, title: `Transactions per covered block, before and after (change ${tx.text})` },
            { label: "Est. tx per day", value: `${estPerDay(b.est_tx_per_day)} → ${estPerDay(a.est_tx_per_day)}`, title: `Transactions per block times about ${data.blocks_per_day ? int.format(Math.round(data.blocks_per_day)) : NA} blocks per day: an estimate from the samples` },
            { label: "Paid share (est.)", value: `${share(b.paid_share, 2)} → ${share(a.paid_share, 2)}`, title: `Share of user transactions classed likely paid (${points(b.paid_share, a.paid_share)}); ArbOS internal transactions left out` },
            { label: "Median fee", value: `${usd(b.median_fee_usd)} → ${usd(a.median_fee_usd)}`, title: "Median USD fee per transaction over the covered blocks" },
            { label: "Senders per day", value: `${b.senders_per_day === null ? NA : int.format(Math.round(b.senders_per_day))} → ${a.senders_per_day === null ? NA : int.format(Math.round(a.senders_per_day))}`, title: "Distinct senders per UTC day in the covered blocks only; the full day has many more" },
            { label: "Retention", value: data.retention.value === null ? NA : share(data.retention.value), title: data.retention.reason ?? `Senders active before who are active after, of ${int.format(data.retention.n)}` },
            { label: "Bot heuristic", value: `${share(b.bot.share)} → ${share(a.bot.share)}`, title: `Share of sender-days with ${BOT_MIN_TX} or more transactions in the covered blocks, ${Math.round(BOT_PATTERN_SHARE * 100)}% or more of them the same contract call. A heuristic, not an identity` },
            { label: "Blocks covered", value: `${int.format(b.blocks_covered)} / ${int.format(a.blocks_covered)}`, title: "Blocks ingested in each window" },
          ]}
        />
        {data.retention.reason ? <p className="mt-2 text-[12px] text-mute">Retention: {data.retention.reason}</p> : null}
      </div>

      <Section title="Timeline" note="One point per UTC day with ingested blocks. The lime line is the end of the rebate.">
        <Timeline data={data} />
      </Section>

      <Section title="Before vs after, per action" note="Rates over the covered blocks; n is the transactions each row rests on. Change is the relative change of transactions per block.">
        <CompareTable data={data} columns="full" />
      </Section>

      <Section title="Subsidy classes (estimate)" note="Heuristic: a zero or near-zero fee with meaningful gas, or a paymaster in an ERC-4337 user operation, counts as likely subsidized. ArbOS internal transactions are counted apart.">
        <table className="w-full max-w-[640px] border-collapse text-[13px]">
          <thead>
            <tr className="text-[10px] tracking-[0.08em] text-mute uppercase">
              {["Class", "Before", "After"].map((h, i) => (
                <th key={h} scope="col" className={`border-b border-line px-1.5 py-1.5 font-medium ${i ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["likely_paid", "Likely paid"],
                ["likely_subsidized", "Likely subsidized"],
                ["unknown", "Unknown"],
              ] as const
            ).map(([k, label]) => (
              <tr key={k}>
                <td className="border-b border-line px-1.5 py-[7px]">{label}</td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{int.format(b.classes[k])}</td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{int.format(a.classes[k])}</td>
              </tr>
            ))}
            <tr>
              <td className="border-b border-line px-1.5 py-[7px] text-mute">ArbOS internal (not a user transaction)</td>
              <td className="border-b border-line px-1.5 py-[7px] text-right font-mono text-mute">{int.format(b.system_tx)}</td>
              <td className="border-b border-line px-1.5 py-[7px] text-right font-mono text-mute">{int.format(a.system_tx)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 max-w-[80ch] text-[12px] text-mute">
          {b.user_tx > 0
            ? `In the covered blocks before the end, ${int.format(b.classes.likely_subsidized)} of ${int.format(b.user_tx)} user transactions (${share(b.user_tx ? b.classes.likely_subsidized / b.user_tx : null, 2)}) look subsidized by these patterns${a.user_tx > 0 ? `, and ${int.format(a.classes.likely_subsidized)} of ${int.format(a.user_tx)} after` : ""}.`
            : "No user transaction is ingested in these windows yet."}{" "}
          {b.paid_share !== null && b.paid_share > 0.99
            ? "If the rebate was paid, it does not show on chain as a lower fee; it was likely paid back outside the chain. A change after the end date would then show in activity (transactions, senders, composition) rather than in the fee."
            : ""}{" "}
          <a href="/methodology" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
            How the classes are set
          </a>
        </p>
      </Section>

      <Section title="Split" note="Average fee per transaction by action, before and after. The Split lens shows the same windows as two City panes with one camera and the largest changes outlined.">
        <BeforeAfterBars data={data} metric="avg_fee_usd" />
        <a href={splitHref} className="mt-3 inline-block rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] text-text no-underline hover:border-mute">
          Open the Split lens
        </a>
      </Section>

      <Section title="Insight">
        {ins.insights.length ? ins.insights.map((i) => <InsightCard key={i.id} insight={i} />) : <p className="text-[12px] text-mute">The subsidy-shift rule has not run yet.</p>}
      </Section>

      <Section title="Surveyor summary">
        <p className="text-[12px] text-mute">Coming soon: a short written summary from Surveyor, built only from these figures, will appear here. Until then the table and the insight above are the summary.</p>
      </Section>

      <Section title="Method">
        <ul className="max-w-[80ch] list-disc space-y-1 pl-5 text-[13px] text-mute">
          <li>Each UTC day is sampled: 12 slices of 30 blocks, one every 2 hours, read from the chain after the fact. A full day is about 17 million transactions, more than Metro can store.</li>
          <li>Rates (per block, shares, fees) come from those blocks; totals per day are the per-block rate times the chain&apos;s blocks per day, an estimate.</li>
          <li>Retention needs every block of both windows; it is not computed from samples.</li>
          <li>Subsidy classes and the bot heuristic are estimates from on-chain patterns, not official labels. Metro names no wallet.</li>
          <li>
            More on every metric in the{" "}
            <a href="/methodology" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
              methodology
            </a>
            .
          </li>
        </ul>
      </Section>
    </ProfileShell>
  );
}
