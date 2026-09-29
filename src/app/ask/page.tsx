import type { Metadata } from "next";
import type { AskResponseT } from "../../lib/api-types.ts";
import { ProfileShell, Section } from "../../components/profile/Profile.tsx";
import { AnswerCard, SurveyorPane } from "../../components/surveyor/SurveyorPane.tsx";
import { getStoredAnswer } from "../../server/ask.ts";
import { getDb } from "../../server/http.ts";

// /ask (PROJECT.md 7, 13.3; Phase 10): the Surveyor workspace, and the public page of a shared answer (?a=<id>). The
// saved answer is rendered as it was stored; no model runs here.

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Surveyor, Metro" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AskPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 300) : "";
  const id = typeof sp.a === "string" ? sp.a : "";
  const shared = id ? await getStoredAnswer(getDb(), id) : null;
  const sharedCard: AskResponseT | null = shared
    ? {
        id: null,
        question: "",
        topic: "none",
        title: "",
        scope: { window: "", action: null, token: null, address: null },
        answer: shared.answer,
        model_used: shared.modelUsed,
        layer: 0,
        layer_name: "Shared",
        validated: shared.validated,
        sources: shared.sources,
        trail: [],
        cached: false,
        refused_reason: null,
        quota: { limit: 0, used: 0, remaining: 0, reset: "" },
        generated_at: shared.createdAt,
      }
    : null;
  return (
    <ProfileShell kind="Surveyor">
      <h1 className="font-display text-[34px] leading-none font-bold">Surveyor</h1>
      <p className="mt-2 max-w-[92ch] text-[13px] text-mute">
        Metro's built-in analyst. Code maps the question to one of the listed topics and reads the computed facts; a free model on OpenRouter writes the explanation; a validator checks every number it wrote against those facts before the answer appears. Questions are limited per day and answers are cached per question and facts, so asking the same thing again is instant.
      </p>
      {id ? (
        <Section title="Shared answer">
          {sharedCard ? (
            <AnswerCard r={sharedCard} />
          ) : (
            <p className="text-[12px] text-mute">There is no answer with that id. It may have been removed; ask again below.</p>
          )}
        </Section>
      ) : null}
      <Section title="Ask">
        <SurveyorPane seed={q ? { question: q } : null} />
      </Section>
      <Section title="What it will not do">
        <ul className="list-disc space-y-1 pl-5 text-[12px] text-mute">
          <li>No financial advice and no price predictions: it explains what the chain data shows.</li>
          <li>No identity or intent claims: the Graph groups wallets by patterns it can explain, nothing more.</li>
          <li>No raw data and no SQL: it reads the computed facts, and every number is checked against them.</li>
        </ul>
      </Section>
    </ProfileShell>
  );
}
