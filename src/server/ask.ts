import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { AskResponseT, AskSourceT } from "../lib/api-types.ts";
import { analystAnswers } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { availableModels, setLatestAnswer } from "../analyst/budget.ts";
import { collectTopicData, type Cite } from "../analyst/facts.ts";
import { writeExplanation } from "../analyst/ladder.ts";
import { mapQuestion } from "../analyst/map.ts";
import { lensFor, normalizeScope, type Scope, type ScopeInput } from "../analyst/topics.ts";
import { numberContext } from "../analyst/validator.ts";
import { checkQuota, countAsk, type AskIdentity } from "./ask-limit.ts";
import { num, rows } from "./query.ts";

// One ask, from text to a checked answer (PROJECT.md 13.3; Phase 10). The order is the one PROJECT.md fixes: map the
// question to a topic, take the facts (computing and storing what the Ledger lacks), serve the cache when the same
// question over the same facts was answered before, otherwise run the ladder, validate, store, and answer with its
// sources. A quota-exceeded or refused ask carries its reason and no model output.

const CACHE_TTL_DAYS = 7;

export type AskOutcome = { response: AskResponseT; status: number };

const questionHash = (topic: string, scope: Scope, cites: Cite[]) =>
  createHash("sha256").update(`${topic}|${scope.window}|${scope.action ?? "-"}|${scope.token ?? "-"}|${scope.address ?? "-"}|${cites.map((c) => `${c.id}:${c.value}:${c.n}`).join(",")}`).digest("hex");

const sourceOf = (c: Cite, lensUrl: string): AskSourceT => ({ fact_key: c.key, value: c.value, n: c.n, window: { start: c.start.toISOString(), end: c.end.toISOString() }, lens_url: lensUrl });

async function sourcesFromIds(db: Db, ids: number[], lens: (key: string) => string): Promise<AskSourceT[]> {
  if (!ids.length) return [];
  const out = await rows(db, sql`SELECT id, key, window_start, window_end, value, n FROM facts WHERE id = ANY(${sql.param(ids)}::bigint[]) ORDER BY id`);
  return out.map((x) => ({ fact_key: String(x.key), value: num(x.value), n: num(x.n), window: { start: new Date(String(x.window_start)).toISOString(), end: new Date(String(x.window_end)).toISOString() }, lens_url: lens(String(x.key)) }));
}

export async function askSurveyor(db: Db, opts: { question: string; scope: ScopeInput; identity: AskIdentity }): Promise<AskOutcome> {
  const question = opts.question.trim();
  const base = normalizeScope(opts.scope);
  const generated = new Date().toISOString();
  const quota = await checkQuota(db, opts.identity);
  const shell = {
    id: null,
    question,
    topic: "none",
    title: "",
    scope: base,
    answer: "",
    model_used: "",
    layer: 0,
    layer_name: "",
    validated: true,
    sources: [] as AskSourceT[],
    trail: [] as string[],
    cached: false,
    refused_reason: null as string | null,
    quota: { limit: quota.limit, used: quota.used, remaining: quota.remaining, reset: quota.reset },
    generated_at: generated,
  };
  if (!quota.allowed) {
    return {
      status: 429,
      response: {
        ...shell,
        refused_reason: `The daily limit of ${quota.limit} questions is used (${quota.reason === "ip" ? "this network" : "this browser"}). The limit resets at ${quota.reset.slice(0, 16).replace("T", " ")} UTC.`,
      },
    };
  }
  const available = await availableModels();
  const mapping = await mapQuestion(question, base, available);
  if (mapping.kind === "refused") {
    await countAsk(db, opts.identity);
    return { status: 200, response: { ...shell, trail: mapping.trail, refused_reason: mapping.reason, quota: { ...shell.quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) } } };
  }
  if (mapping.kind === "unclear") {
    await countAsk(db, opts.identity);
    return {
      status: 200,
      response: {
        ...shell,
        trail: [...mapping.trail, "The question was counted; no model wrote anything."],
        refused_reason: "Surveyor could not place that question. Try an example question, or ask about fees, activity, holders or the subsidy.",
        quota: { ...shell.quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) },
      },
    };
  }
  const { topic, scope } = mapping;
  const data = await collectTopicData(db, topic, scope);
  const trail = [...mapping.trail];
  const withData = { ...shell, topic, title: data.title, scope };
  const counted = { used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) };
  if (!data.enough) {
    await countAsk(db, opts.identity);
    trail.push(`Not enough data: ${data.missing ?? "the facts are too thin"}; the template says so instead of guessing.`);
    return { status: 200, response: { ...withData, answer: data.template, model_used: "template", layer: 7, layer_name: "Template", sources: data.cites.map((c) => sourceOf(c, data.lens_url)), trail, quota: { ...shell.quota, ...counted } } };
  }
  const hash = questionHash(topic, scope, data.cites);
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000);
  const [hit] = await db
    .select({ id: analystAnswers.id, answer: analystAnswers.answer, modelUsed: analystAnswers.modelUsed, validated: analystAnswers.validated, factsRef: analystAnswers.factsRef })
    .from(analystAnswers)
    .where(and(eq(analystAnswers.questionHash, hash), gte(analystAnswers.createdAt, cutoff)))
    .orderBy(desc(analystAnswers.createdAt))
    .limit(1);
  if (hit) {
    trail.push("Served from the cache for the same topic, scope and facts; no model call, and it does not count against the limit.");
    return {
      status: 200,
      response: {
        ...withData,
        id: hit.id,
        answer: hit.answer,
        model_used: hit.modelUsed,
        layer: 0,
        layer_name: "Cache",
        validated: hit.validated,
        cached: true,
        sources: await sourcesFromIds(db, hit.factsRef, () => data.lens_url),
        trail,
      },
    };
  }
  const ctx = numberContext(
    data.cites.map((c) => ({ key: c.key, value: c.value, n: c.n })),
    data.extras,
    data.times,
  );
  const out = await writeExplanation({ question, prompt: data.factsPrompt, template: data.template, ctx, available });
  await countAsk(db, opts.identity);
  const id = randomUUID();
  await db.insert(analystAnswers).values({ id, questionHash: hash, factsRef: data.cites.map((c) => c.id), answer: out.text, modelUsed: out.modelUsed, validated: out.validated });
  if (topic === "subsidy") await setLatestAnswer("subsidy", id);
  return {
    status: 200,
    response: {
      ...withData,
      id,
      answer: out.text,
      model_used: out.modelUsed,
      layer: out.layer,
      layer_name: out.layerName,
      validated: out.validated,
      sources: data.cites.map((c) => sourceOf(c, data.lens_url)),
      trail: [...trail, ...out.trail],
      quota: { ...shell.quota, ...counted },
    },
  };
}

// A stored answer by id, for the share link /ask?a=<id> (PROJECT.md 13.3: an answer can be shared). No model runs.
export async function getStoredAnswer(db: Db, id: string): Promise<{ answer: string; modelUsed: string; validated: boolean; createdAt: string; sources: AskSourceT[] } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [row] = await db.select({ answer: analystAnswers.answer, modelUsed: analystAnswers.modelUsed, validated: analystAnswers.validated, createdAt: analystAnswers.createdAt, factsRef: analystAnswers.factsRef }).from(analystAnswers).where(eq(analystAnswers.id, id)).limit(1);
  if (!row) return null;
  return { answer: row.answer, modelUsed: row.modelUsed, validated: row.validated, createdAt: row.createdAt.toISOString(), sources: await sourcesFromIds(db, row.factsRef, lensFor) };
}
