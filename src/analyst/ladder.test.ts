import { describe, expect, it } from "vitest";
import { ANALYST_MODELS } from "../../config/analyst-models.ts";
import { writeExplanation, type LadderDeps } from "./ladder.ts";
import { ModelError } from "./openrouter.ts";
import { numberContext } from "./validator.ts";

// The ladder walk (PROJECT.md 13.4; AT 17 to AT 20), with faked model and budget calls so no network or Redis is used.

const ctx = numberContext([{ key: "median_fee_usd.swap", value: 0.009256131477023, n: 2147 }], [24], []);
const opts = {
  question: "Which action costs the most?",
  prompt: "Facts:\n- Swap: median fee $0.00926 (n = 2147)",
  template: "Swap is the costliest action at $0.00926 per transaction, over 2,147 transactions in the last 24 hours.",
  ctx,
  available: null,
};
const okText = "Swap is the costliest action at $0.00926 (n = 2,147).";
const badText = "Swap is the costliest action at $0.05 (n = 99).";
const adviceText = "You should sell everything right now.";

const spend: LadderDeps["spend"] = async () => ({ ok: true, used: 1, degraded: false });
const layer1 = ANALYST_MODELS[0]?.model ?? "";

describe("the model ladder", () => {
  it("AT 17: a wrong number retries the same layer, then the next layer answers", async () => {
    const calls: string[] = [];
    const deps: LadderDeps = {
      spend,
      chat: async (model) => {
        calls.push(model);
        return { text: calls.length <= 3 ? badText : okText, model };
      },
    };
    const out = await writeExplanation(opts, deps);
    expect(out.text).toBe(okText);
    expect(out.layer).toBe(2);
    // Two validator retries on layer 1, then layer 2 answers first time.
    expect(calls).toHaveLength(4);
    expect(out.trail.join(" ")).toMatch(/not in the facts/);
    expect(out.trail.join(" ")).toMatch(/stricter reminder/);
  });

  it("AT 18: advice-like wording is rejected like a wrong number", async () => {
    const calls: string[] = [];
    const deps: LadderDeps = {
      spend,
      chat: async (model) => {
        calls.push(model);
        return { text: calls.length <= 3 ? adviceText : okText, model };
      },
    };
    const out = await writeExplanation(opts, deps);
    expect(out.text).toBe(okText);
    expect(out.layer).toBe(2);
    expect(out.trail.join(" ")).toMatch(/advice/);
  });

  it("AT 19: a technical failure retries the same model, and the answering model is recorded", async () => {
    const calls: string[] = [];
    const deps: LadderDeps = {
      spend,
      chat: async (model) => {
        calls.push(model);
        if (calls.length === 1) throw new ModelError("timeout", "no answer within 45000 ms");
        return { text: okText, model };
      },
    };
    const out = await writeExplanation(opts, deps);
    expect(out.text).toBe(okText);
    expect(out.layer).toBe(1);
    expect(out.modelUsed).toBe(layer1);
    expect(calls[0]).toBe(layer1);
    expect(out.trail.join(" ")).toMatch(/retry 1 of 3 after 500 ms/);
  });

  it("AT 20: a rate-limited account stops the ladder and the template answers, validated", async () => {
    const calls: string[] = [];
    const deps: LadderDeps = {
      spend,
      chat: async () => {
        calls.push("x");
        throw new ModelError("rate_limit", "the model endpoint rate limited the call", 429);
      },
    };
    const out = await writeExplanation(opts, deps);
    expect(out.text).toBe(opts.template);
    expect(out.layerName).toBe("Template");
    expect(out.validated).toBe(true);
    expect(calls).toHaveLength(2);
    expect(out.trail.join(" ")).toMatch(/rate limited twice/);
  });

  it("every layer failing on validation falls to the template too", async () => {
    const deps: LadderDeps = { spend, chat: async (model) => ({ text: badText, model }) };
    const out = await writeExplanation(opts, deps);
    expect(out.text).toBe(opts.template);
    expect(out.layerName).toBe("Template");
    expect(out.trail.join(" ")).toMatch(/Every layer failed/);
  });

  it("a spent budget falls to the template without a model call", async () => {
    let called = 0;
    const deps: LadderDeps = {
      spend: async () => ({ ok: false, reason: "day", used: 45, degraded: false }),
      chat: async (model) => {
        called++;
        return { text: okText, model };
      },
    };
    const out = await writeExplanation(opts, deps);
    expect(called).toBe(0);
    expect(out.text).toBe(opts.template);
    expect(out.trail.join(" ")).toMatch(/budget is spent/);
  });

  it("a model missing from the cron list is skipped", async () => {
    const calls: string[] = [];
    const deps: LadderDeps = {
      spend,
      chat: async (model) => {
        calls.push(model);
        return { text: okText, model };
      },
    };
    const onlySecond = ANALYST_MODELS[1]?.model ?? "";
    const out = await writeExplanation({ ...opts, available: [onlySecond] }, deps);
    expect(calls).toEqual([onlySecond]);
    expect(out.layer).toBe(2);
    expect(out.trail.join(" ")).toMatch(/not on the model list/);
  });
});
