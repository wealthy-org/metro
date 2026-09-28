"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CityResponse, FlowResponse, HeatmapResponse, InsightsResponse, LaunchpadResponse, TerrainResponse } from "../../lib/api-types.ts";
import { CITY_ACTIONS, costColor, cssColor, feeTop } from "../../lib/city.ts";
import { formatAge, NA } from "../../lib/format.ts";
import { timeLabel } from "../../lib/lenses.ts";
import { usePolling, useReducedMotion } from "../hooks.ts";

// Landing at `/` (audit A17, KL-21): project-4-metro-landing.html converted section by section to the PROJECT.md 5
// stack. Every "sample data" figure of the file is replaced by live data from the existing endpoints, or by an explicit
// empty state where the feature is built in a later phase (PROJECT.md 3.2). Copy that is no longer true is corrected.

const HeroScene = dynamic(() => import("./HeroScene.tsx"), { ssr: false });
const APP = "/lens/city";
const int = new Intl.NumberFormat("en-US");

const btn = "inline-flex min-h-12 items-center justify-center rounded-[3px] border px-[22px] text-[15px] font-semibold no-underline";
const btnPrimary = `${btn} border-accent bg-accent text-[#10130a] hover:bg-[#d6f76e]`;
const btnPlain = `${btn} border-line bg-panel2 hover:border-mute`;
const eyebrow = "mb-3.5 font-mono text-[12px] uppercase tracking-[0.12em] text-accent";
const h2 = "font-display text-[clamp(38px,5.4vw,68px)] font-extrabold leading-[.95] tracking-[0.005em]";
const lead = "max-w-[56ch] text-[19px] text-mute";
const wrap = "mx-auto w-full max-w-[1200px] px-8 max-[980px]:px-5";

// Fade and rise into view, as the file's .rv / IntersectionObserver. Content is visible by default (server render,
// no JavaScript, reduced motion); after mount only blocks still below the viewport are hidden until they scroll in,
// so nothing already on screen flickers.
function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || !("IntersectionObserver" in window)) return setHidden(false);
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    setHidden(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setHidden(false), io.disconnect()), { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);
  return (
    <div ref={ref} className={`${className} ${reduced ? "" : "transition-[opacity,transform] duration-[600ms] ease-out"} ${hidden ? "translate-y-[18px] opacity-0" : "translate-y-0 opacity-100"}`}>
      {children}
    </div>
  );
}

const LENSES = [
  { key: "city", n: "01", name: "City", q: "Which actions carry the volume, and what do they cost?", text: "One building per action type and per Pons token. Height follows the metric you choose, color is the fee. Click a building to open its numbers." },
  { key: "terrain", n: "02", name: "Terrain", q: "How did each action move over time?", text: "Time across, action types (or Pons tokens) in depth, height and color from the metric. The 29 September line is drawn across it." },
  { key: "flow", n: "03", name: "Flow", q: "What is moving right now, and how much does it pay?", text: "Every live transaction is a particle from source through action type to token, colored by fee. Pause it, filter it, click a dot." },
  { key: "graph", n: "04", name: "Graph", q: "Which wallets keep moving value between each other?", text: "Wallets and contracts as nodes, transfers as lines. Groups come from patterns Metro can explain, such as a shared first funder. It shows at most 1,500 nodes and says when it trims.", phase: "Phase 9" },
  { key: "heatmap", n: "05", name: "Heatmap", q: "When is it cheapest to swap?", text: "One cell per hour. It answers when swapping is cheapest, and compares the hours before and after the rebate ended." },
  { key: "launchpad", n: "06", name: "Launchpad", q: "Which new Pons tokens are growing, and who holds them?", text: "New Pons tokens with age, holders, swap volume and how much the top ten holders own. Ownership above 50 percent is highlighted as a fact, not a verdict." },
  { key: "split", n: "07", name: "Split", q: "What changed after the rebate ended?", text: "Two windows side by side with the difference marked. If the later window is not full, the page shows how many days it has.", phase: "Phase 8" },
] as const;

function CityArt({ d }: { d: CityResponse | null }) {
  const b = (d?.buildings ?? []).filter((x) => x.tx_count > 0);
  if (!d || !b.length) return <p className="text-[15px] text-mute">{d ? "No transactions in the last 24 h of ingested data." : "Loading live data…"}</p>;
  const maxN = Math.max(...b.map((x) => x.tx_count));
  const maxFee = Math.max(...b.map((x) => x.avg_fee_usd ?? 0)) || 1;
  const w = 360 / b.length;
  return (
    <svg viewBox="0 0 400 300" role="img" aria-label={`Live City: ${b.length} buildings, ${int.format(d.n)} transactions`} className="h-auto max-h-[340px] w-full">
      {b.map((x, i) => {
        const h = Math.max(4, (x.tx_count / maxN) * 230);
        return (
          <g key={x.key}>
            <rect x={20 + i * w + 4} y={262 - h} width={w - 8} height={h} fill={x.avg_fee_usd === null ? "#3a4152" : cssColor(costColor((x.avg_fee_usd ?? 0) / maxFee))}>
              <title>{`${x.label}: ${int.format(x.tx_count)} tx`}</title>
            </rect>
            <rect x={20 + i * w + 4} y={262 - h} width={w - 8} height={6} fill="#fff" opacity={0.18} />
          </g>
        );
      })}
      <rect x={20} y={262} width={360} height={6} fill="#242a36" />
    </svg>
  );
}

function TerrainArt({ d }: { d: TerrainResponse | null }) {
  if (!d || !d.max) return <p className="text-[15px] text-mute">{d ? "No transactions in the last 24 h of ingested data." : "Loading live data…"}</p>;
  const max = d.max;
  const cols = d.buckets.length;
  return (
    <svg viewBox="0 0 400 300" role="img" aria-label="Live Terrain: transactions per action over the last 24 hours" className="h-auto max-h-[340px] w-full">
      {d.rows.map((r, i) => {
        const y = 60 + i * 30;
        const pts = r.values.map((v, b) => (v === null ? null : `${(30 + (b / Math.max(1, cols - 1)) * 340).toFixed(1)},${(y - (v / max) * 70).toFixed(1)}`)).filter(Boolean);
        const peak = Math.max(0, ...r.values.map((v) => v ?? 0));
        return pts.length ? <polyline key={r.key} points={pts.join(" ")} fill="none" stroke={cssColor(costColor(peak / max))} strokeWidth={1.6} opacity={0.85} /> : null;
      })}
      <line x1={30} y1={270} x2={370} y2={270} stroke="#242a36" />
      <text x={30} y={286} className="fill-mute font-mono text-[10px]">{timeLabel(Date.parse(d.buckets[0] ?? ""))}</text>
      <text x={370} y={286} textAnchor="end" className="fill-mute font-mono text-[10px]">UTC</text>
    </svg>
  );
}

function HeatArt({ d }: { d: HeatmapResponse | null }) {
  if (!d || !d.max) return <p className="text-[15px] text-mute">{d ? "No fees in the last 7 days of ingested data." : "Loading live data…"}</p>;
  const max = d.max;
  const rows = d.days.slice(-9);
  const offset = d.days.length - rows.length;
  return (
    <svg viewBox="0 0 400 300" role="img" aria-label="Live Heatmap: average fee per UTC hour" className="h-auto max-h-[340px] w-full">
      {rows.map((day, r) =>
        (d.cells[offset + r] ?? []).map((c, h) => <rect key={`${day}-${h}`} x={24 + h * 15} y={30 + r * 28} width={13} height={24} fill={c.s === "d" && c.v !== null ? cssColor(costColor(c.v / max)) : "#151922"} />),
      )}
      <text x={24} y={290} className="fill-mute font-mono text-[10px]">00</text>
      <text x={200} y={290} className="fill-mute font-mono text-[10px]">12</text>
      <text x={360} y={290} className="fill-mute font-mono text-[10px]">23 UTC</text>
    </svg>
  );
}

// Landing flow drawing (file line 460) filled with one live read: 7 action bars, token bars, a dot per transaction
// placed along its path by its position in the read, colored by fee against the 95th percentile.
function FlowArt({ d }: { d: FlowResponse | null }) {
  if (!d || !d.rows.length) return <p className="text-[15px] text-mute">{d ? "No transactions in the newest blocks." : "Reading the newest blocks…"}</p>;
  const actions = CITY_ACTIONS.map((a) => a.key as string);
  const tokens = [...d.tokens.map((t) => t.key), "other", "none"];
  const ay = (i: number) => 40 + i * (220 / (actions.length - 1));
  const by = (i: number) => 40 + i * (220 / Math.max(1, tokens.length - 1));
  const fees = d.rows.map((r) => r.fee_usd);
  const top = feeTop(fees);
  const rows = d.rows.slice(0, 120);
  return (
    <svg viewBox="0 0 400 300" role="img" aria-label={`Live Flow: ${rows.length} transactions from blocks ${d.blocks?.first ?? ""} to ${d.blocks?.last ?? ""}`} className="h-auto max-h-[340px] w-full">
      {actions.map((a, i) => (
        <rect key={a} x={190} y={ay(i) - 10} width={6} height={20} fill="#3a4152" />
      ))}
      {tokens.map((t, i) => (
        <rect key={t} x={360} y={by(i) - 8} width={6} height={16} fill="#3a4152" />
      ))}
      <rect x={30} y={100} width={6} height={100} fill="#3a4152" />
      {rows.map((r, i) => {
        const t = ((i * 37) % 100) / 100;
        const a = Math.max(0, actions.indexOf(r.action));
        const pons = r.tokens.map((k) => d.tokens.findIndex((x) => x.key === k)).find((k) => k >= 0);
        const b = pons !== undefined ? pons : r.tokens.length ? tokens.length - 2 : tokens.length - 1;
        const x = t < 0.5 ? 33 + (193 - 33) * t * 2 : 193 + (363 - 193) * (t - 0.5) * 2;
        const y = t < 0.5 ? 150 + (ay(a) - 150) * t * 2 : ay(a) + (by(b) - ay(a)) * (t - 0.5) * 2;
        return <circle key={r.hash} cx={x.toFixed(1)} cy={y.toFixed(1)} r={1.5 + Math.min(2, Math.log10(1 + r.value_eth * 1_000))} fill={cssColor(costColor(Math.min(1, r.fee_usd / top)))} opacity={r.status === "failed" ? 0.45 : 0.85} />;
      })}
    </svg>
  );
}

// Landing launch board (file line 463) with the live Launchpad rows: token, age, top-10 share bar (amber above 50%).
// Ingested tokens come first, since only they have holder figures; newer launches read over RPC fill the rest (KL-24).
function LaunchArt({ d }: { d: LaunchpadResponse | null }) {
  const all = d?.tokens ?? [];
  const rows = [...all.filter((t) => t.source === "ingested"), ...all.filter((t) => t.source === "rpc")].slice(0, 5);
  if (!d || !rows.length) return <p className="text-[15px] text-mute">{d ? "No Pons token launched in the ingested blocks." : "Loading live data…"}</p>;
  const end = Date.now();
  return (
    <svg viewBox="0 0 400 300" role="img" aria-label={`Live Launchpad: ${rows.length} Pons tokens`} className="h-auto max-h-[340px] w-full">
      <text x={24} y={30} className="fill-mute font-mono text-[10px]">TOKEN</text>
      <text x={130} y={30} className="fill-mute font-mono text-[10px]">AGE</text>
      <text x={200} y={30} className="fill-mute font-mono text-[10px]">TOP 10 HOLD, POOL LEFT OUT</text>
      {rows.map((t, i) => {
        const y = 60 + i * 46;
        const share = t.holders?.top10_share ?? null;
        const w = share === null ? 0 : Math.round(share * 100) * 1.5;
        return (
          <g key={t.address}>
            <line x1={20} y1={y - 22} x2={380} y2={y - 22} stroke="#242a36" />
            <text x={24} y={y} className="fill-text font-mono text-[14px]">{(t.symbol ?? t.address.slice(0, 6)).slice(0, 10)}</text>
            <text x={130} y={y} className="fill-mute font-mono text-[10px]">{formatAge(t.launch_ts, end)}</text>
            {share === null ? (
              <text x={200} y={y} className="fill-mute font-mono text-[10px]">{t.source === "rpc" ? "not ingested yet" : NA}</text>
            ) : (
              <>
                <rect x={200} y={y - 12} width={w} height={12} fill={share > 0.5 ? "#f0b429" : "#3a4152"} />
                <text x={208 + w} y={y} className="fill-mute font-mono text-[10px]">
                  {Math.round(share * 100)}%{t.holders?.complete ? "" : "*"}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// The landing's trace card (file lines 282-287) with a real insight: the cheapest-hour finding when there is one, as
// in the file's example, else the newest finding. With no finding yet it says so instead of showing sample figures.
function TraceCard() {
  const ins = usePolling<InsightsResponse>("/api/v1/insights?status=finding", null);
  const list = ins.data?.insights ?? [];
  const i = list.find((x) => x.rule === "cheapest_hour") ?? list[0];
  if (!i) {
    const text = ins.status === "error" ? "Insights could not be loaded just now." : ins.data ? "No rule has enough data for a finding yet. Each one names its sample size and window, and opens the lens that produced it." : "Loading the newest insight…";
    return (
      <>
        <div className="mb-3 flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
          <span>Insight</span>
          <b className="font-medium text-mute">{ins.data ? "No finding yet" : ""}</b>
        </div>
        <p className="text-[20px] leading-[1.45]">{text}</p>
        <a href="/insights" className={`mt-4 ${btnPlain}`}>
          See every rule and its status
        </a>
      </>
    );
  }
  const a = i.window.start.slice(0, 16).replace("T", " ");
  const b = i.window.end.slice(0, 16).replace("T", " ");
  return (
    <>
      <div className="mb-3 flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
        <span>Insight: {i.title.toLowerCase()}</span>
        <b className={`font-medium ${i.severity === "attention" ? "text-c1" : "text-text"}`}>{i.severity === "attention" ? "Attention" : "Info"}</b>
      </div>
      <p className="text-[20px] leading-[1.45]">{i.text}</p>
      <div className="mt-4 mb-3.5 rounded-[3px] border border-line bg-bg px-3 py-2.5 font-mono text-[12px] text-mute">
        n = {int.format(i.n)} · {a} to {a.slice(0, 10) === b.slice(0, 10) ? b.slice(11) : b} UTC
      </div>
      <a href={i.evidence_url} className={btnPlain}>
        Show the evidence
      </a>
    </>
  );
}

function LensStage({ lens, city }: { lens: (typeof LENSES)[number]; city: CityResponse | null }) {
  const terrain = usePolling<TerrainResponse>(lens.key === "terrain" ? "/api/lens/terrain/data?window=24h&metric=tx_count" : null, null);
  const heat = usePolling<HeatmapResponse>(lens.key === "heatmap" ? "/api/lens/heatmap/data?window=7d&metric=avg_fee_usd" : null, null);
  const flow = usePolling<FlowResponse>(lens.key === "flow" ? "/api/lens/flow/data" : null, null);
  const launch = usePolling<LaunchpadResponse>(lens.key === "launchpad" ? "/api/lens/launchpad/data?window=24h" : null, null);
  const phase = "phase" in lens ? lens.phase : null;
  return (
    <div className="sticky top-24 flex min-h-[440px] flex-col rounded-[4px] border border-line bg-panel p-[22px] max-[980px]:static" aria-live="polite">
      <div className="mb-2.5 flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
        <span>{lens.name}</span>
        <span>{phase ? `Arrives in ${phase}` : lens.key === "flow" ? "Live from RPC" : "Live data"}</span>
      </div>
      <div className="flex min-h-[300px] flex-1 items-center justify-center">
        {lens.key === "city" ? <CityArt d={city} /> : null}
        {lens.key === "terrain" ? <TerrainArt d={terrain.data} /> : null}
        {lens.key === "heatmap" ? <HeatArt d={heat.data} /> : null}
        {lens.key === "flow" ? <FlowArt d={flow.data} /> : null}
        {lens.key === "launchpad" ? <LaunchArt d={launch.data} /> : null}
        {phase ? <p className="max-w-[36ch] text-center text-[15px] text-mute">This lens is built in {phase}. It will show real chain data only; there is no sample drawing here.</p> : null}
      </div>
      <p className="mt-3 text-[15px] text-mute">{lens.text}</p>
      {!phase ? (
        <Link href={`/lens/${lens.key}`} className="mt-3 self-start text-[14px] text-text underline decoration-mute hover:decoration-text">
          Open the {lens.name} lens
        </Link>
      ) : null}
    </div>
  );
}

function HeroCaption({ d }: { d: CityResponse | null }) {
  const range = (start: string, end: string) => {
    const a = timeLabel(Date.parse(start));
    const b = timeLabel(Date.parse(end));
    return a.slice(0, 6) === b.slice(0, 6) ? `${a} to ${b.slice(7)}` : `${a} to ${b}`;
  };
  const text = !d
    ? "Loading the live City…"
    : !d.window.start || !d.window.end
      ? "No blocks ingested yet. The scene fills when the Collector runs."
      : `Scene: the live City, ${int.format(d.n)} transactions from ${range(d.window.start, d.window.end)} UTC. Height is transactions, color is the average fee.`;
  return (
    <p className="mt-[22px] font-mono text-[12px] text-mute">
      <i aria-hidden className="mr-2 inline-block size-2 bg-mute" />
      {text}
    </p>
  );
}

export function Landing() {
  const reduced = useReducedMotion();
  const city = usePolling<CityResponse>("/api/lens/city/data?window=24h", 60_000);
  const [lensKey, setLensKey] = useState<(typeof LENSES)[number]["key"]>("city");
  const lens = LENSES.find((l) => l.key === lensKey) ?? LENSES[0];
  const hero = useRef<HTMLElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  const [gl, setGl] = useState<boolean | null>(null);

  useEffect(() => {
    const probe = document.createElement("canvas");
    setGl(Boolean(probe.getContext("webgl2") || probe.getContext("webgl")));
    const el = hero.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setHeroVisible(es.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    // Landing-only values from the file: body 17 px / 1.6, muted text #98a0b1, focus offset 3 px.
    <div className="text-[17px] leading-[1.6] [--color-mute:#98a0b1] [&_:focus-visible]:outline-offset-[3px]">
      <nav className="fixed inset-x-0 top-0 z-50 border-b border-line bg-[rgba(11,13,18,.82)] backdrop-blur-[10px]" aria-label="Main">
        <div className={`${wrap} flex h-16 items-center gap-7`}>
          <a href="#top" aria-label="Metro, top of page" className="font-display text-[26px] font-black tracking-[0.04em] text-accent no-underline">
            METRO
          </a>
          {[
            ["#lenses", "Lenses"],
            ["#subsidy", "Subsidy Cliff"],
            ["#trace", "Traceable numbers"],
            ["#surveyor", "Surveyor"],
            ["#faq", "Questions"],
          ].map(([href, text]) => (
            <a key={href} href={href} className="px-0.5 py-2 text-[14px] text-mute no-underline hover:text-text max-[980px]:hidden">
              {text}
            </a>
          ))}
          <span className="flex-1" />
          <Link href={APP} className={`${btnPrimary} min-h-11 px-4 text-[14px]`}>
            Open Metro
          </Link>
        </div>
      </nav>

      <header ref={hero} id="top" className="relative flex min-h-screen scroll-mt-16 items-end overflow-hidden pt-16 max-[980px]:min-h-[88vh]">
        <div className="absolute inset-0">
          {gl && city.data ? <HeroScene buildings={city.data.buildings} reduced={reduced} visible={heroVisible} /> : null}
          {gl === false ? <div className="size-full bg-[radial-gradient(60%_50%_at_60%_40%,#1a2130,#0b0d12)]" /> : null}
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-[linear-gradient(90deg,rgba(11,13,18,.92)_0,rgba(11,13,18,.7)_34%,rgba(11,13,18,0)_62%)]" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[46%] bg-[linear-gradient(180deg,rgba(11,13,18,0),rgba(11,13,18,.92)_62%,#0b0d12)]" />
        <div className={`${wrap} relative z-[2] pb-16 max-[980px]:pb-10`}>
          <h1 className="max-w-[9ch] font-display text-[clamp(64px,10.5vw,148px)] font-extrabold uppercase leading-[.95] tracking-[0.005em]">
            The chain, seen as a <em className="not-italic text-accent">city</em>
          </h1>
          <p className={`${lead} mt-[22px] mb-[30px] text-[#b7bece]`}>
            Metro turns every transaction on Robinhood Chain into buildings, roads and terrain you can click. Then it tells you what changed, in plain sentences with the numbers attached.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href={APP} className={btnPrimary}>
              Open the city
            </Link>
            <a href="#trace" className={btnPlain}>
              See how one number is traced
            </a>
          </div>
          <HeroCaption d={city.data} />
        </div>
      </header>

      <section id="why" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <div className={`${wrap} grid grid-cols-[1fr_1.1fr] items-start gap-16 max-[980px]:grid-cols-1 max-[980px]:gap-9`}>
          <Reveal>
            <div className={eyebrow}>Why another dashboard</div>
            <h2 className={h2}>Rows tell you what happened. Shape tells you where to look.</h2>
          </Reveal>
          <Reveal>
            <p className={`${lead} mb-[18px]`}>
              An explorer lists transactions one at a time. A chart shows one line. Neither shows that swaps got expensive at 15:00 while transfers stayed cheap, or that one token is quietly held by ten wallets.
            </p>
            <p className={lead}>
              Metro draws every action type and every Pons token as a building sized by the metric you pick and colored by what it costs. You spot the tall red one, click it, and land on the transactions behind it.
            </p>
          </Reveal>
        </div>
      </section>

      <section id="lenses" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <div className={wrap}>
          <Reveal>
            <div className={eyebrow}>Seven lenses, one data set</div>
            <h2 className={h2}>Each lens answers one question.</h2>
          </Reveal>
          <Reveal className="mt-12 grid grid-cols-[.9fr_1.1fr] items-stretch gap-14 max-[980px]:grid-cols-1 max-[980px]:gap-9">
            <div className="flex flex-col border-t border-line" role="tablist" aria-label="Lenses">
              {LENSES.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  role="tab"
                  aria-selected={l.key === lensKey}
                  onClick={() => setLensKey(l.key)}
                  className={`group grid grid-cols-[44px_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-line px-1 py-[18px] text-left ${l.key === lensKey ? "text-text" : "text-mute"}`}
                >
                  <span className="font-mono text-[12px] text-mute">{l.n}</span>
                  <b className={`font-display text-[28px] font-bold leading-none group-hover:text-accent ${l.key === lensKey ? "text-accent" : "text-text"}`}>{l.name}</b>
                  <span className="col-start-2 text-[15px]">{l.q}</span>
                </button>
              ))}
            </div>
            <LensStage lens={lens} city={city.data} />
          </Reveal>
        </div>
      </section>

      <section id="subsidy" className="scroll-mt-16 border-t border-line bg-panel py-[120px] max-[980px]:py-20">
        <div className={`${wrap} grid grid-cols-2 items-center gap-16 max-[980px]:grid-cols-1 max-[980px]:gap-9`}>
          <Reveal>
            <div className={eyebrow}>Subsidy Cliff</div>
            <div className="font-display text-[clamp(80px,12vw,168px)] font-black leading-[.85] tracking-[0.005em] text-accent">
              29 Sep
              <small className="mt-[34px] block text-[.26em] font-bold tracking-[0.06em] text-text">The rebate window closes</small>
            </div>
            <p className={`${lead} mt-[26px]`}>
              Press reports say Robinhood Chain covered gas for Robinhood Wallet transactions for 90 days from launch, ending 29 September 2026. Metro is built to measure what happens after.
            </p>
            <ul className="mt-6 list-none border-t border-line">
              {["Share of transactions that pay a fee, before and after", "Fee per action type, so you see which actions got dearer", "How many wallets active before are still active after", "Shift between swaps, transfers and launches"].map((t, i) => (
                <li key={t} className="flex gap-3.5 border-b border-line py-3 text-[16px] text-[#c4cad8]">
                  <b className="min-w-7 pt-1 font-mono text-[12px] font-medium text-accent">{String(i + 1).padStart(2, "0")}</b>
                  {t}
                </li>
              ))}
            </ul>
            <p className="mt-[18px] border-l-[3px] border-accent pl-3.5 text-[#c4cad8]">If nothing meaningful changed, Metro says so. Fees on the chain are already small, so a quiet result is a real possibility.</p>
          </Reveal>
          <Reveal>
            <div className="rounded-[4px] border border-line bg-bg p-[18px]">
              <div className="mb-2 flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
                <span>Average fee per action, USD</span>
                <b className="font-medium text-c1">Not measured yet</b>
              </div>
              <div className="flex min-h-[260px] items-center justify-center p-6 text-center text-[15px] text-mute">
                The before and after figures appear here once transactions from both sides of 29 September are ingested. The Subsidy Cliff module and the Split lens are built in Phase 8.
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="trace" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <div className={wrap}>
          <Reveal>
            <div className={eyebrow}>Traceable numbers</div>
            <h2 className={h2}>Every sentence carries its own proof.</h2>
          </Reveal>
          <div className="mt-11 grid grid-cols-[1.1fr_.9fr] items-start gap-14 max-[980px]:grid-cols-1 max-[980px]:gap-9">
            <Reveal className="relative rounded-[4px] border border-line bg-panel p-6">
              <TraceCard />
            </Reveal>
            <Reveal>
              <ol className="list-none">
                {[
                  ["The sentence comes from a rule", "A fixed rule computes the hours and fees from stored facts. No model does the arithmetic."],
                  ["It states its sample and window", 'How many transactions, which dates. Under 30 samples it says "not enough data yet" instead.'],
                  ["It opens the view that made it", "The button loads the lens with the same filters, so you can check the figure yourself."],
                ].map(([t, s], i) => (
                  <li key={t} className="relative border-b border-line py-4 pl-[46px]">
                    <span aria-hidden className="absolute top-4 left-0 flex size-[26px] items-center justify-center rounded-[2px] bg-accent font-mono text-[12px] text-bg">
                      {i + 1}
                    </span>
                    <b className="block font-display text-[22px] font-bold leading-[1.1]">{t}</b>
                    <span className="text-[15px] text-mute">{s}</span>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="surveyor" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <div className={wrap}>
          <Reveal>
            <div className={eyebrow}>Surveyor, the built-in analyst</div>
            <h2 className={h2}>An AI that writes. Code that checks.</h2>
            <p className={`${lead} mt-[18px]`}>Ask from a list of questions. Surveyor explains the answer, but it never sees raw data and never does the math. It is built in Phase 10.</p>
          </Reveal>
          <Reveal className="mt-11 grid grid-cols-4 overflow-hidden rounded-[4px] border border-line max-[980px]:grid-cols-1">
            {[
              ["Step 1", "Facts are computed", "Queries and rules produce the numbers for your question: window, action, token, metric.", "Code"],
              ["Step 2", "Surveyor writes", "A free model on OpenRouter receives only those facts and writes a short explanation.", "Model"],
              ["Step 3", "Every number is matched", "Each figure in the text must exist in the facts. A mismatch rejects the answer and asks again.", "Code"],
              ["Step 4", "Answer with sources", "You get the text, the facts it used, and the lens that shows them. Nothing unchecked reaches you.", "Code"],
            ].map(([k, t, p, who]) => (
              <div key={k} className="min-h-[230px] border-r border-line bg-panel px-[22px] py-6 last:border-r-0 max-[980px]:min-h-0 max-[980px]:border-r-0 max-[980px]:border-b max-[980px]:last:border-b-0">
                <div className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-accent">{k}</div>
                <h3 className="mb-2 font-display text-[26px] font-bold leading-[1.05]">{t}</h3>
                <p className="text-[15px] text-mute">{p}</p>
                <div className="mt-3 border-t border-dashed border-line pt-2.5 font-mono text-[11px] text-mute">{who}</div>
              </div>
            ))}
          </Reveal>
          <Reveal className="mt-[26px] flex flex-wrap overflow-hidden rounded-[4px] border border-line font-mono text-[12px]">
            <div className="contents" aria-label="Fallback order">
              {["Surveyor", "Assessor", "Mapper", "Cartographer", "Gauger", "Stray", "Template, no model"].map((l, i, a) => (
                <span key={l} className={`border-r border-line px-3.5 py-2.5 last:border-r-0 ${i === 0 ? "text-text" : i === a.length - 1 ? "text-accent" : "text-mute"}`}>
                  {l}
                </span>
              ))}
            </div>
          </Reveal>
          <Reveal>
            <p className="mt-3.5 text-[16px] text-[#c4cad8]">A rate limit or timeout moves to the next model. A wrong number never does: it retries, then falls back to a fixed template with the same figures.</p>
          </Reveal>
        </div>
      </section>

      <section id="method" className="scroll-mt-16 border-t border-line py-24 max-[980px]:py-20">
        <div className={wrap}>
          <Reveal>
            <div className={eyebrow}>Limits, stated up front</div>
            <h2 className={h2}>What Metro will not do.</h2>
          </Reveal>
          <div className="mt-10 grid grid-cols-2 gap-x-14 max-[980px]:grid-cols-1">
            {[
              ["Predict prices", "Surveyor explains what the data shows. It gives no forecast and no advice to buy or sell."],
              ["Accuse wallets", "The graph groups wallets by patterns it can explain, such as a shared first funder. It does not label anyone a bot or a fraud."],
              ["Draw a chart without data", "When there is too little data, the view says so. A lens never fills in for numbers that do not exist."],
              ["Pretend the subsidy label is official", "Which transactions were rebated is an estimate from fee patterns, and every view that uses it says so."],
            ].map(([t, p]) => (
              <Reveal key={t} className="border-t border-line py-5">
                <h3 className="mb-1.5 font-display text-[26px] font-bold leading-[1.05]">{t}</h3>
                <p className="text-[16px] text-mute">{p}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section id="dispatch" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <div className={`${wrap} grid grid-cols-[1fr_1.1fr] items-start gap-16 max-[980px]:grid-cols-1 max-[980px]:gap-9`}>
          <Reveal>
            <div className={eyebrow}>Dispatch</div>
            <h2 className={h2}>A daily report you can forward.</h2>
            <p className={`${lead} mt-[18px]`}>
              Every day at 00:10 UTC Metro writes a report from the same facts: the numbers, the findings, what moved most. Each report has its own page, and exports to Markdown or PDF. Build a custom one for any date range and lens.
            </p>
          </Reveal>
          <Reveal>
            <div className="whitespace-pre-wrap rounded-[4px] border border-line bg-panel p-[22px] font-mono text-[13px] leading-[1.7] text-[#c9cfdc]">
              <b className="font-medium text-accent"># Metro Dispatch</b>
              {"\n\nThe first report is written once Dispatch runs (Phase 11). Each one has these parts:\n\n"}
              <b className="font-medium text-accent">## Numbers</b>
              {"\n- Transactions, with the window\n- Blended fee\n- Paid share (estimate)\n\n"}
              <b className="font-medium text-accent">## Findings</b>
              {"\nThe top insights, each with n and window.\n\n"}
              <b className="font-medium text-accent">## Method</b>
              {"\nAll numbers come from fixed rules over stored facts."}
            </div>
          </Reveal>
        </div>
      </section>

      <section id="faq" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <div className={`${wrap} max-w-[900px]`}>
          <Reveal className="mb-7">
            <div className={eyebrow}>Questions</div>
            <h2 className={h2}>Before you open it.</h2>
          </Reveal>
          {[
            ["Is this live chain data?", "Yes, from the blocks ingested so far. The Collector reads Robinhood Chain in bounded runs for now, so every view states the window it covers and says so when a window has no data. Nothing on this page is sample data."],
            ["Where do the numbers come from?", "Blocks, transactions and Pons launch events from the chain's RPC; ETH prices and chain economics from DefiLlama. Blockscout and growthepie serve as cross-checks when they can be reached. Every view can show the window and sample behind it."],
            ["Do I need to connect a wallet?", "No. Metro only reads public chain data. Nothing asks for a signature or holds funds."],
            ["Does it give trading advice?", "No. It reports what happened and what it cost. It makes no price predictions and no recommendations."],
            ["Why is it desktop only?", "The lenses need room: a 3D scene next to a data panel and a time line. Below 1280 px wide, the app asks you to open it on a wider screen instead of showing a cramped version."],
            ["Is Metro affiliated with Robinhood?", "No. It is independent analytics that reads a public chain."],
          ].map(([q, a]) => (
            <details key={q} className="group border-t border-line last-of-type:border-b">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-[22px] font-display text-[28px] font-bold [&::-webkit-details-marker]:hidden">
                {q}
                <span aria-hidden className="font-mono text-[22px] text-accent group-open:hidden">
                  +
                </span>
                <span aria-hidden className="hidden font-mono text-[22px] text-accent group-open:inline">
                  -
                </span>
              </summary>
              <p className="max-w-[68ch] pb-6 text-mute">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="end" className="scroll-mt-16 border-t border-line py-[120px] max-[980px]:py-20">
        <Reveal className={wrap}>
          <h2 className={`${h2} max-w-[14ch]`}>See the chain before the cliff and after it.</h2>
          <p className={`${lead} mt-[18px] mb-7`}>Open Metro, rotate the city, and follow any building back to its transactions.</p>
          <div className="flex flex-wrap gap-3">
            <Link href={APP} className={btnPrimary}>
              Open Metro
            </Link>
            <a href="#lenses" className={btnPlain}>
              Review the lenses
            </a>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-line py-10 text-[14px] text-mute">
        <div className={`${wrap} flex flex-wrap justify-between gap-6`}>
          <span>
            <b className="font-display text-[20px] tracking-[0.04em] text-accent">METRO</b> &nbsp; Independent analytics for Robinhood Chain. Not affiliated with Robinhood.
          </span>
          <span className="font-mono text-[12px]">Data: blocks ingested from Robinhood Chain RPC.</span>
        </div>
      </footer>
    </div>
  );
}
