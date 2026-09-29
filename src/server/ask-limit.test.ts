import { describe, expect, it } from "vitest";
import { identity } from "./ask-limit.ts";

// Surveyor's identity (PROJECT.md 13.3, 17; Phase 10 D3; gate F72): a cookie the caller cannot forge, and a network id
// from infrastructure headers only.
const req = (headers: Record<string, string>) => new Request("http://localhost/api/ask", { headers });
const ipOf = (h: Record<string, string>) => identity(req(h)).ipId;

describe("ask identity", () => {
  it("reads the cookie id when it is a UUID, and sets one when it is absent", () => {
    const good = identity(req({ cookie: "metro_user=6e03a5ef-e14f-4cf0-9613-2ce42e045472" }));
    expect(good.userId).toBe("c:6e03a5ef-e14f-4cf0-9613-2ce42e045472");
    expect(good.newCookie).toBeNull();
    const fresh = identity(req({}));
    expect(fresh.userId).toMatch(/^c:[0-9a-f-]{36}$/);
    expect(fresh.newCookie).toMatch(/^metro_user=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax/);
    const junk = identity(req({ cookie: "metro_user=not-a-uuid" }));
    expect(junk.newCookie).not.toBeNull();
  });

  it("takes the client IP from x-real-ip, never from a client-filled x-forwarded-for prefix", () => {
    const real = ipOf({ "x-real-ip": "10.0.0.1", "x-forwarded-for": "9.9.9.9, 10.0.0.1" });
    expect(real).not.toBeNull();
    expect(ipOf({ "x-real-ip": "10.0.0.1" })).toBe(real);
    expect(ipOf({ "x-real-ip": "10.0.0.1", "x-forwarded-for": "1.2.3.4" })).toBe(real);
  });

  it("without x-real-ip uses the last x-forwarded-for entry, the one the proxy appended", () => {
    const last = ipOf({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" });
    expect(last).not.toBeNull();
    expect(ipOf({ "x-forwarded-for": "10.0.0.1" })).toBe(last);
    expect(ipOf({ "x-forwarded-for": "8.8.8.8, 10.0.0.1" })).toBe(last);
  });

  it("no headers mean no network id", () => {
    expect(identity(req({})).ipId).toBeNull();
  });
});
