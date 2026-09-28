import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { A, External, Facts, int, ProfileShell, Section, short, Table, usd, utc } from "../../../components/profile/Profile.tsx";
import { getDb } from "../../../server/http.ts";
import { getTx } from "../../../server/tx.ts";
import { NA } from "../../../lib/format.ts";

// Transaction page (PROJECT.md 7): the transaction, its token transfers, how Metro classified it, and where it sits
// in the lenses. A hash Metro has not ingested is read from RPC and says so (Phase 6 D5).

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ hash: string }> };
const valid = (h: string) => /^0x[0-9a-fA-F]{64}$/.test(h);
const SUBSIDY: Record<string, string> = { likely_subsidized: "Likely subsidized", likely_paid: "Likely paid", unknown: "Unknown" };
// The Inspector's button style (WorkspacePanel "Restart 3D", "Back to live").
const BUTTON = "rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] text-text no-underline hover:border-mute";

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { hash } = await params;
  return { title: valid(hash) ? `Transaction ${short(hash, 8, 4)}, Metro` : "Metro" };
}

export default async function TxPage({ params }: Params) {
  const { hash } = await params;
  if (!valid(hash)) notFound();
  const t = await getTx(getDb(), hash.toLowerCase());
  if (!t) notFound();

  const gwei = Number(BigInt(t.gas_price_wei)) / 1e9;
  const value = Number(t.value_eth);

  return (
    <ProfileShell kind="Transaction">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[34px] leading-none font-bold">{t.action_label}</h1>
        <span className={`rounded-[3px] border px-1.5 py-px text-[10px] tracking-[0.08em] uppercase ${t.status === "failed" ? "border-c2 text-c2" : "border-line text-mute"}`}>{t.status}</span>
      </header>
      <p className="mt-2 font-mono text-[12px] break-all text-mute">
        {t.hash} · <External href={t.explorer_url}>explorer</External>
      </p>
      {t.source === "rpc" ? (
        <p role="status" className="mt-3 rounded-[3px] border border-c1 px-[11px] py-2 text-[12px] text-c1">
          Not in Metro&apos;s ingested blocks. Read from the chain&apos;s RPC just now: the action type is computed with the Collector&apos;s rules and not stored, and the USD fee uses the current ETH price, as the live Flow does.
        </p>
      ) : null}

      <div className="mt-4">
        <Facts
          items={[
            { label: "Block", value: int.format(t.block) },
            { label: "Time", value: utc(t.ts) },
            { label: "From", value: <A href={`/wallet/${t.from}`}>{short(t.from)}</A> },
            { label: "To", value: t.to ? <A href={`/wallet/${t.to}`}>{short(t.to)}</A> : "contract creation" },
            { label: "Value", value: `${Number.isFinite(value) ? value.toFixed(value === 0 ? 0 : 6) : t.value_eth} ETH`, title: `${t.value_eth} ETH` },
            { label: "Fee", value: usd(t.fee_usd), title: t.fee_usd_basis === "current" ? "Fee in ETH times the current ETH price" : t.fee_usd_basis === "minute" ? "Fee in ETH times the ETH price of that minute" : "The ETH price could not be read" },
            { label: "Fee, ETH", value: t.fee_eth, title: "Gas used times effective gas price" },
            { label: "Gas price", value: `${gwei.toFixed(4)} Gwei` },
            { label: "Gas used", value: int.format(Number(t.gas_used)) },
            { label: "Method", value: t.method ?? NA, title: "First 4 bytes of the input" },
            { label: "Action", value: t.action, title: "Metro's deterministic classifier (PROJECT.md 9.3)" },
            { label: "Subsidy class", value: SUBSIDY[t.subsidy_class] ?? t.subsidy_class, title: "An estimate from a heuristic (KL-6), not a fact about who paid" },
          ]}
        />
      </div>

      <Section title="Token transfers" note={t.transfers.some((x) => x.amount_is_raw) ? "Raw amounts are shown for tokens whose decimals Metro does not store." : undefined}>
        <Table
          head={["Token", "From", "To", "Amount"]}
          empty="This transaction moved no tokens."
          rows={t.transfers.map((x) => [
            <A key="t" href={`/token/${x.token}`}>
              {x.symbol ?? short(x.token)}
              {x.is_pons ? " (Pons)" : ""}
            </A>,
            <A key="f" href={`/wallet/${x.from}`}>
              {short(x.from)}
            </A>,
            <A key="o" href={`/wallet/${x.to}`}>
              {short(x.to)}
            </A>,
            `${x.amount}${x.amount_is_raw ? " (raw)" : ""}`,
          ])}
        />
      </Section>

      <Section title="In the lenses" note={t.source === "ingested" ? "Open the lenses at the minute of this transaction." : "The lenses count ingested blocks only, so this transaction is not in them yet."}>
        {t.source === "ingested" ? (
          <div className="flex flex-wrap gap-2">
            {t.positions.map((p) => (
              <Link key={p.lens} href={p.href} prefetch={false} className={BUTTON}>
                {p.lens}
              </Link>
            ))}
          </div>
        ) : (
          <Link href="/lens/flow" prefetch={false} className={BUTTON}>
            Live Flow
          </Link>
        )}
      </Section>
    </ProfileShell>
  );
}
