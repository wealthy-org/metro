import { ANALYST_MODELS, BACKOFF_MS, MAX_TECHNICAL_RETRIES, MAX_VALIDATOR_RETRIES, TEMPLATE_LAYER, WRITE_SYSTEM, type AnalystModel } from "../../config/analyst-models.ts";
import { adviceIssue } from "./advice.ts";
import { spendCall } from "./budget.ts";
import { chat, ModelError } from "./openrouter.ts";
import { checkNumbers, type NumberContext } from "./validator.ts";

// The tiered ladder (PROJECT.md 13.4). A layer is left only for a technical failure, after at most 3 retries with
// exponential backoff (13.4.1); a wrong number or advice-like wording retries the same layer at most 2 times and then
// steps down (13.4.2); when everything fails the deterministic Template answers (13.4.3). The model that answered is
// recorded (13.4.4), and every model call spends the shared budget (Phase 10 D5, D6).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LadderOutcome = { text: string; modelUsed: string; layer: number; layerName: string; validated: boolean; trail: string[] };

// The chat and budget calls are injectable so tests can walk the ladder without the network or Redis.
export type LadderDeps = { chat: typeof chat; spend: typeof spendCall };
const REAL: LadderDeps = { chat, spend: spendCall };

type LayerResult = { text: string; model: string } | { stop: "budget" | "no_key" } | { failed: true; rateLimited?: boolean };

const STRICT_REMINDER = "\n\nReminder: use only the numbers listed under Facts, exactly as written; do not mention any other count, time or amount.";

async function runLayer(layer: AnalystModel, question: string, prompt: string, ctx: NumberContext, trail: string[], degraded: { noted: boolean }, deps: LadderDeps): Promise<LayerResult> {
  // Two separate budgets (PROJECT.md 13.4.1 and 13.4.2): technical failures retry with backoff, wrong numbers or
  // advice-like wording retry the same layer; neither consumes the other.
  let techLeft = MAX_TECHNICAL_RETRIES;
  let valLeft = MAX_VALIDATOR_RETRIES;
  let strict = "";
  let rateLimited = 0;
  for (;;) {
    const budget = await deps.spend();
    if (!budget.ok) return { stop: "budget" };
    if (budget.degraded && !degraded.noted) {
      degraded.noted = true;
      trail.push("The budget store is unavailable; asks run without the global model cap and the failure is logged.");
    }
    let text: string;
    let model: string;
    try {
      const r = await deps.chat(layer.model, [
        { role: "system", content: WRITE_SYSTEM },
        { role: "user", content: `${prompt}${strict}\n\nQuestion: ${question}` },
      ]);
      text = r.text;
      model = r.model;
    } catch (err) {
      const failure = err instanceof ModelError ? err.failure : "unknown";
      if (failure === "no_key") return { stop: "no_key" };
      if (failure === "rate_limit") {
        rateLimited++;
        if (rateLimited >= 2) {
          trail.push(`${layer.name} (${layer.model}): rate limited twice; the account is limited right now, so the ladder stops here.`);
          return { failed: true, rateLimited: true };
        }
      }
      if (techLeft === 0) {
        trail.push(`${layer.name} (${layer.model}): ${failure} on the last retry; moving to the next layer.`);
        return { failed: true };
      }
      const wait = BACKOFF_MS[MAX_TECHNICAL_RETRIES - techLeft] ?? 0;
      techLeft--;
      trail.push(`${layer.name} (${layer.model}): ${failure}; retry ${MAX_TECHNICAL_RETRIES - techLeft} of ${MAX_TECHNICAL_RETRIES} after ${wait} ms.`);
      await sleep(wait);
      continue;
    }
    const issue = adviceIssue(text);
    const check = issue ? null : checkNumbers(text, ctx);
    if (!issue && check?.ok) return { text, model };
    if (valLeft === 0) {
      trail.push(`${layer.name}: ${issue ?? `${check?.bad.length ?? 0} number(s) not in the facts`} on the last retry; moving to the next layer.`);
      return { failed: true };
    }
    valLeft--;
    if (issue) {
      trail.push(`${layer.name}: the text carries ${issue}; rejected, retry ${MAX_VALIDATOR_RETRIES - valLeft} of ${MAX_VALIDATOR_RETRIES} on the same layer with a stricter reminder.`);
    } else {
      trail.push(`${layer.name}: ${check?.bad.length ?? 0} number(s) not in the facts (${(check?.bad ?? []).slice(0, 3).join(", ")}); rejected, retry ${MAX_VALIDATOR_RETRIES - valLeft} of ${MAX_VALIDATOR_RETRIES} on the same layer with a stricter reminder.`);
    }
    strict = STRICT_REMINDER;
  }
}

export async function writeExplanation(opts: { question: string; prompt: string; template: string; ctx: NumberContext; available: string[] | null }, deps: LadderDeps = REAL): Promise<LadderOutcome> {
  const { question, prompt, template, ctx, available } = opts;
  const trail: string[] = [];
  const degraded = { noted: false };
  for (const layer of ANALYST_MODELS) {
    if (available && !available.includes(layer.model) && layer.model !== "openrouter/free") {
      trail.push(`${layer.name} skipped: not on the model list.`);
      continue;
    }
    const result = await runLayer(layer, question, prompt, ctx, trail, degraded, deps);
    if ("stop" in result) {
      if (result.stop === "no_key") trail.push("OPENROUTER_API_KEY is not set; the template answers instead.");
      else trail.push("The model budget is spent; the template answers instead.");
      return { text: template, modelUsed: TEMPLATE_LAYER.model, layer: TEMPLATE_LAYER.layer, layerName: TEMPLATE_LAYER.name, validated: true, trail };
    }
    if ("failed" in result) {
      if (result.rateLimited) {
        trail.push("The account is rate limited right now; the template answers with the same facts and no model.");
        return { text: template, modelUsed: TEMPLATE_LAYER.model, layer: TEMPLATE_LAYER.layer, layerName: TEMPLATE_LAYER.name, validated: true, trail };
      }
      continue;
    }
    trail.push(`${layer.name} (${result.model}) answered; every number passed the check.`);
    return { text: result.text, modelUsed: result.model, layer: layer.layer, layerName: layer.name, validated: true, trail };
  }
  trail.push("Every layer failed; the template answers with the same facts and no model.");
  return { text: template, modelUsed: TEMPLATE_LAYER.model, layer: TEMPLATE_LAYER.layer, layerName: TEMPLATE_LAYER.name, validated: true, trail };
}
