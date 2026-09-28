import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EXPLORER_URL } from "../../../../config/known-contracts.ts";
import { A, Bars, External, Facts, int, pct, ProfileShell, Section, short, Table, usd, utc } from "../../../components/profile/Profile.tsx";
import { formatAge, formatCountCompact, formatDay, formatUsdCompact, NA } from "../../../lib/format.ts";
import { getDb } from "../../../server/http.ts";
import { getToken } from "../../../server/token.ts";

// Token profile (PROJECT.md 15): metadata, age, holders and their change, top-10 share, volume, the fee trend of the
// transactions that moved it, related insights, and the launch for Pons tokens. Holders come from the ingested
// token transfers (Phase 6 D1), market figures from GeckoTerminal (D2), supply and non-Pons metadata from RPC (D4).

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ address: string }> };
const valid = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: valid(address) ? `Token ${short(address)}, Metro` : "Metro" };
}

export default async function TokenPage({ params }: Params) {
  const { address } = await params;
  if (!valid(address)) notFound();
  const t = await getToken(getDb(), address.toLowerCase());
  if (!t) notFound();

  const h = t.holders;
  const change = h ? h.holders - h.holders_24h_ago : null;
  // Age is to now; holders and activity stop at the newest ingested block (the anchor), as the note says.
  const nowMs = Date.now();
  const partial = h && !h.complete ? `Partial: from ${int.format(h.blocks_ingested ?? 0)} of ${int.format(h.blocks_expected ?? 0)} blocks since the launch.` : undefined;
  const unknown = h ? undefined : "No transfer of this token is in the ingested blocks yet";
  const supply = t.supply ? Number(t.supply.formatted) : null;
  const title = t.symbol ?? short(t.address);

  return (
    <ProfileShell kind="Token">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[34px] leading-none font-bold">{title}</h1>
        {t.name ? <span className="text-[15px] text-mute">{t.name}</span> : null}
        <span className="rounded-[3px] border border-line px-1.5 py-px text-[10px] tracking-[0.08em] text-mute uppercase">{t.is_pons ? "Pons token" : "ERC-20"}</span>
      </header>
      <p className="mt-2 font-mono text-[12px] text-mute">
        {t.address} · {t.decimals} decimals · <External href={`${EXPLORER_URL}/token/${t.address}`}>explorer</External>
      </p>

      <div className="mt-4">
        <Facts
          items={[
            { label: "Age", value: t.launch ? formatAge(t.launch.ts, nowMs) : NA, title: t.launch ? `Launched ${utc(t.launch.ts)}` : "Launch not recorded: only Pons launches are" },
            { label: "Holders", value: h ? `${int.format(h.holders)}${h.complete ? "" : "*"}` : NA, title: unknown ?? partial ?? "Addresses with a positive balance, from token transfers" },
            { label: "Change 24 h", value: change === null ? NA : change > 0 ? `+${int.format(change)}` : int.format(change), title: unknown ?? partial },
            { label: "Top 10 hold", value: <span className={h?.top10_share !== null && h?.top10_share !== undefined && h.top10_share > 0.5 ? "text-c1" : ""}>{h ? pct(h.top10_share) : NA}</span>, title: unknown ?? partial ?? "Share of supply held by the 10 largest holders, leaving out the token's Pons curve pool and the factory" },
            { label: "In pool", value: h?.excluded.length ? pct(h.pool_share) : NA, title: unknown ?? (h?.excluded.length ? `Share of supply in ${h.excluded.map((a) => short(a)).join(" and ")} (curve pool, factory)` : "Not a Pons token: no curve pool") },
            { label: "Price", value: t.market?.price_usd != null ? usd(t.market.price_usd) : NA, title: "GeckoTerminal, now" },
            { label: "Volume 24 h", value: t.market?.volume_24h_usd != null ? formatUsdCompact(t.market.volume_24h_usd) : NA, title: "Sum over its pools, GeckoTerminal, now" },
            { label: "Supply", value: supply !== null && Number.isFinite(supply) ? formatCountCompact(supply) : NA, title: t.supply ? `${t.supply.formatted}, totalSupply read from RPC` : undefined },
          ]}
        />
        <p className="mt-2 text-[11px] text-mute">
          {h
            ? `Holders and top-10 share are counted from the transfers Metro has ingested${t.anchor ? `, up to ${utc(t.anchor)}` : ""}; the top ten leave out the token's curve pool and the factory, whose part is "In pool".${partial ? ` * ${partial} These figures may be off.` : ""} A top-10 share above 50% is highlighted as a measured fact, not a judgement.`
            : `Holders are n/a: no transfer of this token is in the blocks Metro has ingested${t.anchor ? ` (up to ${utc(t.anchor)})` : ""}.`}
          {t.market_available ? "" : " GeckoTerminal is unreachable, so price and volume are not shown."}
        </p>
      </div>

      {t.launch ? (
        <Section title="Launch" note={t.launch.source === "rpc" ? "From the Pons factory's TokenLaunched event, read over RPC: this launch is newer than the ingested blocks." : "From the Pons factory's TokenLaunched event."}>
          <Facts
            items={[
              { label: "Block", value: t.launch.source === "ingested" ? <A href={`/lens/city?at=${t.launch.ts.slice(0, 16)}Z`}>{int.format(t.launch.block)}</A> : int.format(t.launch.block), title: t.launch.source === "rpc" ? "Not ingested yet: read from the factory logs over RPC" : undefined },
              { label: "Time", value: utc(t.launch.ts) },
              { label: "Creator", value: <A href={`/wallet/${t.launch.creator}`}>{short(t.launch.creator)}</A> },
              { label: "Creator on explorer", value: <External href={t.launch.creator_url}>open</External> },
            ]}
          />
        </Section>
      ) : null}

      <Section title="Transactions and fees, 7 days" note="Transactions that moved this token per UTC day, and their average fee in USD. Ingested blocks only.">
        {t.daily.length ? (
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="mb-1 text-[11px] text-mute">Transactions</div>
              <Bars values={t.daily.map((d) => d.n)} labels={t.daily.map((d) => formatDay(d.date))} format={(v) => `${int.format(v)} tx`} />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-mute">Average fee, USD</div>
              <Bars values={t.daily.map((d) => d.avg_fee_usd)} labels={t.daily.map((d) => formatDay(d.date))} format={usd} color="#f0b429" />
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-mute">No blocks ingested yet.</p>
        )}
      </Section>

      {t.market?.pools.length ? (
        <Section title="Pools" note="From GeckoTerminal, now.">
          <Table
            head={["Pool", "DEX", "Volume 24 h", "Liquidity"]}
            empty=""
            rows={t.market.pools.map((p) => [
              <External key="p" href={`https://www.geckoterminal.com/robinhood/pools/${p.address}`}>
                {p.name}
              </External>,
              p.dex ?? NA,
              p.volume_24h_usd === null ? NA : formatUsdCompact(p.volume_24h_usd),
              p.reserve_usd === null ? NA : formatUsdCompact(p.reserve_usd),
            ])}
          />
        </Section>
      ) : null}

      <Section title="Newest transfers" note="The 10 newest transfers in the ingested blocks.">
        <Table
          head={["Transaction", "From", "To", "Amount", "Time"]}
          empty="No transfers of this token in the ingested blocks."
          rows={t.transfers.map((x) => [
            <A key="h" href={`/tx/${x.tx_hash}`}>
              {short(x.tx_hash, 8, 4)}
            </A>,
            <A key="f" href={`/wallet/${x.from}`}>
              {short(x.from)}
            </A>,
            <A key="t" href={`/wallet/${x.to}`}>
              {short(x.to)}
            </A>,
            Number.isFinite(Number(x.amount)) ? formatCountCompact(Number(x.amount)) : x.amount,
            utc(x.ts),
          ])}
        />
      </Section>

      <Section title="Related insights">
        <p className="text-[12px] text-mute">None yet. Insights about this token will be listed here, each with its evidence, once Metro computes insights.</p>
      </Section>
    </ProfileShell>
  );
}
