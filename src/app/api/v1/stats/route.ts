import { CHAIN_ID } from "../../../../../config/known-contracts.ts";
import type { StatsResponse } from "../../../../lib/api-types.ts";
import { chainHead, gasPriceWei } from "../../../../server/chain.ts";
import { chainEconomics, chainStats } from "../../../../server/external.ts";
import { getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { getStats } from "../../../../server/metrics.ts";

export const dynamic = "force-dynamic";

const GWEI = 1e9;

// Ticker readout (PROJECT.md 16: GET /api/v1/stats). The database is the only hard dependency: RPC, DefiLlama
// and Blockscout values degrade to null or "unavailable" instead of failing the response.
export async function GET() {
  const lagAlert = Number(process.env.LAG_ALERT_BLOCKS ?? 100);
  try {
    const [stats, head, gas, economics, explorer] = await Promise.all([
      getStats(getDb()),
      chainHead(),
      gasPriceWei(),
      chainEconomics(),
      chainStats(),
    ]);
    const live = stats.latest?.block ?? null;
    const lag = live !== null && head ? Math.max(0, head.head - live) : null;
    const body: StatsResponse = {
      chain_id: CHAIN_ID,
      head_block: head?.head ?? null,
      live_block: live,
      lag_blocks: lag,
      lag_alert_blocks: lagAlert,
      delayed: lag !== null && lag > lagAlert,
      block_ts: stats.latest?.ts ?? null,
      gas_price_gwei: gas ? Number(gas.wei) / GWEI : null,
      base_fee_gwei: stats.latest?.base_fee_wei ? Number(stats.latest.base_fee_wei) / GWEI : null,
      tps_current: stats.latest ? stats.tps.value : null,
      tps: stats.latest ? stats.tps : null,
      avg_fee_usd: stats.latest ? stats.fees.avg_usd : null,
      median_fee_usd: stats.latest ? stats.fees.median_usd : null,
      fees: stats.latest ? stats.fees : null,
      subsidized_ratio_24h: stats.latest ? stats.subsidized.ratio : null,
      subsidized: stats.latest ? stats.subsidized : null,
      eth_usd: stats.price?.eth_usd ?? null,
      eth_usd_ts: stats.price?.ts ?? null,
      // The widest sample (24 h) is the ticker's top-level window; each metric keeps its own n and window above.
      n: stats.latest ? stats.subsidized.n : null,
      window: stats.latest ? stats.subsidized.window : null,
      chain: economics,
      chain_stats: explorer,
      generated_at: new Date().toISOString(),
    };
    return Response.json(body, { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
