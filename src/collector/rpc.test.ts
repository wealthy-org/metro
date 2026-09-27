import { describe, expect, it } from "vitest";
import { RPC_POOL } from "../../config/known-contracts.ts";
import { RpcPool } from "./rpc.ts";

describe("RpcPool", () => {
  it("spreads consecutive blocks over every primary endpoint", () => {
    const pool = new RpcPool([...RPC_POOL]);
    const primaries = RPC_POOL.filter((e) => e.primary).length;
    expect(pool.size).toBe(primaries);
    const clients = new Set(Array.from({ length: primaries * 2 }, (_, i) => pool.forBlock(BigInt(1_000 + i))));
    expect(clients.size).toBe(primaries);
  });

  it("falls back to all endpoints when none is marked primary", () => {
    const pool = new RpcPool([{ url: "https://a.example", batch: false, primary: false }, { url: "https://b.example", batch: false, primary: false }]);
    expect(pool.size).toBe(2);
  });
});
