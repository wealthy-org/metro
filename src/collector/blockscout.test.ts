import { describe, expect, it } from "vitest";
import { Blockscout } from "./blockscout.ts";

type Call = { url: string };

function fakeFetch(responses: (Response | Error)[], calls: Call[]): typeof fetch {
  return async (input) => {
    calls.push({ url: String(input) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const challenge = () => new Response("<html>Just a moment...</html>", { status: 403, headers: { "cf-mitigated": "challenge" } });

function client(publicResponses: (Response | Error)[], proResponses: (Response | Error)[], apiKey?: string) {
  const publicCalls: Call[] = [];
  const proCalls: Call[] = [];
  const bs = new Blockscout({
    publicBase: "https://public.example/api/v2",
    proBase: "https://pro.example/4663/api/v2",
    apiKey,
    publicFetch: fakeFetch(publicResponses, publicCalls),
    proFetch: fakeFetch(proResponses, proCalls),
  });
  return { bs, publicCalls, proCalls };
}

describe("Blockscout public-first with PRO fallback", () => {
  it("uses the public URL when it answers and never calls PRO", async () => {
    const { bs, proCalls } = client([json({ total_blocks: "1" })], [], "key");
    expect(await bs.get("/stats")).toEqual({ total_blocks: "1" });
    expect(proCalls).toHaveLength(0);
  });

  it("falls back to PRO with the key when the public URL is behind a challenge, then stays on PRO", async () => {
    const { bs, publicCalls, proCalls } = client([challenge()], [json({ a: 1 }), json({ b: 2 })], "secret");
    expect(await bs.get("/stats")).toEqual({ a: 1 });
    expect(await bs.get("/blocks", { type: "block" })).toEqual({ b: 2 });
    expect(publicCalls).toHaveLength(1);
    expect(bs.usingFallback).toBe(true);
    expect(proCalls[1]?.url).toBe("https://pro.example/4663/api/v2/blocks?type=block&apikey=secret");
  });

  it("falls back on a network error but tries public again on the next call", async () => {
    const { bs, publicCalls } = client([new Error("ECONNRESET"), json({ ok: true })], [json({ pro: true })], "key");
    expect(await bs.get("/stats")).toEqual({ pro: true });
    expect(await bs.get("/stats")).toEqual({ ok: true });
    expect(publicCalls).toHaveLength(2);
  });

  it("does not fall back on a normal 404", async () => {
    const { bs, proCalls } = client([json({ message: "not found" }, 404)], [], "key");
    await expect(bs.get("/tokens/0x0")).rejects.toThrow("HTTP 404");
    expect(proCalls).toHaveLength(0);
  });

  it("explains that a key is needed when public is blocked and no key is set", async () => {
    const { bs } = client([challenge()], []);
    await expect(bs.get("/stats")).rejects.toThrow("BLOCKSCOUT_API_KEY");
  });
});
