import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { A, Bars, External, Facts, int, pct, ProfileShell, Section, short, Table, usd, utc } from "../../../components/profile/Profile.tsx";
import { WalletGraph } from "../../../components/graph/WalletGraph.tsx";
import { getWalletGraph } from "../../../server/graph.ts";
import { getDb } from "../../../server/http.ts";
import { getWallet } from "../../../server/wallet.ts";
import { NA } from "../../../lib/format.ts";

// Wallet profile (PROJECT.md 15): age, transactions per action, total fee paid, active hours, nearest counterparties
// the ego graph (Phase 9) and the subsidy indicator (share of likely paid transactions, an estimate: KL-6). Public chain data only; no guessed
// identity labels. Activity covers the ingested blocks; balance, total sent and contract-or-not are read from RPC.

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ address: string }> };
const valid = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: valid(address) ? `Wallet ${short(address)}, Metro` : "Metro" };
}

export default async function WalletPage({ params }: Params) {
  const { address } = await params;
  if (!valid(address)) notFound();
  const db = getDb();
  const [w, graph] = await Promise.all([getWallet(db, address.toLowerCase()), getWalletGraph(db, address.toLowerCase())]);
  const g = w.ingested;
  const balance = w.chain ? Number(w.chain.balance_eth) : null;
  const seen = g.tx_count > 0;

  return (
    <ProfileShell kind="Wallet">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[34px] leading-none font-bold">{short(w.address)}</h1>
        <span className="rounded-[3px] border border-line px-1.5 py-px text-[10px] tracking-[0.08em] text-mute uppercase">{w.chain ? (w.chain.is_contract ? "Contract" : "Account") : "Type unknown"}</span>
      </header>
      <p className="mt-2 font-mono text-[12px] text-mute">
        {w.address} · <External href={w.explorer_url}>explorer</External>
      </p>

      <div className="mt-4">
        <Facts
          items={[
            { label: "Balance", value: balance !== null && Number.isFinite(balance) ? `${balance.toFixed(balance < 1 ? 6 : 4)} ETH` : NA, title: "Read from RPC now" },
            { label: "Sent, all time", value: w.chain ? int.format(w.chain.sent_total) : NA, title: "Account nonce read from RPC: transactions this address has sent on the chain" },
            { label: "First seen", value: g.first_seen ? utc(g.first_seen) : NA, title: "In Metro's ingested blocks" },
            { label: "Last seen", value: g.last_seen ? utc(g.last_seen) : NA, title: "In Metro's ingested blocks" },
            { label: "Transactions", value: int.format(g.tx_count), title: "Sent or received, in the ingested blocks" },
            { label: "Fee paid", value: usd(g.fee_paid_usd), title: "Sum of fees of the transactions it sent, USD" },
            { label: "Paid share", value: pct(g.paid_share), title: "Share of its sent transactions classed likely paid: an estimate from a heuristic (KL-6)" },
            { label: "Fail rate", value: pct(g.fail_rate), title: "Share of its sent transactions that failed" },
          ]}
        />
        <p className="mt-2 text-[11px] text-mute">
          {w.chain ? "Balance, all-time sent count and contract status are read from the chain now." : "The chain could not be read, so balance and type are not shown."} Everything else covers only the blocks Metro has ingested{seen ? "" : ", where this address does not appear"}. Paid share is an estimate. Metro shows no identity labels.
        </p>
      </div>

      {seen || graph.nodes.length > 0 ? (
        <>
          <Section title="Transactions by action" note="Transactions it sent, with the total fee per action type.">
            <Table head={["Action", "Transactions", "Fee paid"]} empty="It sent no transactions in the ingested blocks." rows={g.actions.map((a) => [a.label, int.format(a.tx_count), usd(a.fee_usd)])} />
          </Section>

          {g.sent > 0 ? (
            <Section title="Active hours" note="Transactions it sent per hour of the day, UTC.">
              <Bars values={g.hours} labels={HOURS} format={(v) => `${int.format(v)} tx`} />
            </Section>
          ) : null}

          <Section title="Ego graph" note="The addresses it exchanges native or token transfers with, in the ingested blocks.">
            <WalletGraph data={graph} />
          </Section>

          <Section title="Nearest counterparties" note="Addresses it exchanges transactions with most often. The table version of the graph above.">
            <div className="grid grid-cols-2 gap-6">
              <Table head={["Sent to", "Transactions"]} empty="Sent to: none in the ingested blocks." rows={g.counterparties.sent_to.map((c) => [<A key="a" href={`/wallet/${c.address}`}>{short(c.address)}</A>, int.format(c.tx_count)])} />
              <Table head={["Received from", "Transactions"]} empty="Received from: none in the ingested blocks." rows={g.counterparties.received_from.map((c) => [<A key="a" href={`/wallet/${c.address}`}>{short(c.address)}</A>, int.format(c.tx_count)])} />
            </div>
          </Section>

          <Section title="Newest transactions">
            <Table
              head={["Transaction", "Direction", "Action", "Fee", "Status", "Time"]}
              empty=""
              rows={g.recent.map((r) => [
                <A key="h" href={`/tx/${r.hash}`}>
                  {short(r.hash, 8, 4)}
                </A>,
                r.direction === "out" ? "sent" : "received",
                r.action,
                usd(r.fee_usd),
                <span key="s" className={r.status === "failed" ? "text-c2" : ""}>
                  {r.status}
                </span>,
                utc(r.ts),
              ])}
            />
          </Section>
        </>
      ) : null}
    </ProfileShell>
  );
}
