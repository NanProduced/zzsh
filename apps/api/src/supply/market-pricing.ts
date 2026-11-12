import type { PoolClient } from "pg";
import type { ContentPayloadInput } from "./content-hash";
import { formatDecimalAtScale, parseNonNegativeDecimal, yuanAmountObject } from "./decimal";
import type { TenantPriceQuote } from "./tenant-price-projection";

export type MarketPricing = { fixed: string | null; spread: string | null; ready: boolean; revision: string | null };
const signature = "zzsh_supply.public_market_price(jsonb,text,text)";
const unconfigured: MarketPricing = { fixed: null, spread: null, ready: false, revision: null };

export async function readMarketPricing(client: PoolClient, gameId: string | null): Promise<MarketPricing> {
  const shape = (await client.query<{ schedules: boolean; ready: boolean }>(`SELECT /* market-pricing-schema */
    to_regclass('zzsh_supply.pricing_policy_schedule') IS NOT NULL AS schedules,
    COALESCE(has_function_privilege(current_user,to_regprocedure($1),'EXECUTE'),false) AS ready`, [signature])).rows[0];
  if (!shape?.schedules) return unconfigured;
  const plans = (await client.query<{ model: string; price: string; id: string }>(`SELECT DISTINCT ON (game_id,pricing_model)
    pricing_model AS model,price_version_id AS price,id
    FROM zzsh_supply.pricing_policy_schedule WHERE ($1::text IS NULL OR game_id=$1) AND effective_at<=transaction_timestamp()
    ORDER BY game_id,pricing_model,effective_at DESC,generation DESC`, [gameId])).rows;
  if (!plans.length) return unconfigured;
  return { fixed: plans.find(p => p.model === "FIXED_FEE")?.price ?? null, spread: plans.find(p => p.model === "SPREAD")?.price ?? null,
    ready: shape.ready === true, revision: JSON.stringify([shape.ready === true, plans.map(plan => plan.id)]) };
}

export type MarketPrice = { amount: string; ratio: string; lines: { itemId: string; amount: string; unitAmount: string }[] };

export function marketPriceTarget(payload: ContentPayloadInput, pricing: MarketPricing, ownerDirect: boolean) {
  if (payload.schemaVersion === 4) return { scheduled: true, priceId: ownerDirect ? pricing.fixed : null };
  if (payload.schemaVersion === 2 && payload.quoteValues.mode === "SPREAD" && ownerDirect && pricing.spread)
    return { scheduled: true, priceId: pricing.spread };
  return { scheduled: !!payload.pricingPolicy, priceId: null };
}

export async function readMarketPrice(client: PoolClient, payload: ContentPayloadInput, gameId: string, priceId: string) {
  return (await client.query<{ price: MarketPrice | null }>("SELECT zzsh_supply.public_market_price($1::jsonb,$2,$3) AS price",
    [JSON.stringify(payload), gameId, priceId])).rows[0]?.price ?? null;
}

export function applyMarketPrice(quote: TenantPriceQuote, price: MarketPrice | null): TenantPriceQuote | null {
  if (!price || !Array.isArray(price.lines) || price.lines.length !== quote.lines.length) return null;
  try {
    const ratio = parseNonNegativeDecimal(price.ratio, 8, "market ratio");
    if (ratio.value <= 0n) return null;
    const byItem = new Map(price.lines.map(line => [line.itemId, line]));
    let cents = 0n;
    const lines = quote.lines.map(line => {
      const amounts = byItem.get(line.itemId)!;
      const amount = parseNonNegativeDecimal(amounts.amount, 2, "market amount");
      const unit = parseNonNegativeDecimal(amounts.unitAmount, 8, "market unit amount");
      const lineCents = BigInt(formatDecimalAtScale(amount, 2).replace(".", ""));
      cents += lineCents;
      return { ...line, buyerAmount: yuanAmountObject(lineCents), buyerUnitAmount: { ...line.buyerUnitAmount, amount: formatDecimalAtScale(unit, 8) } };
    });
    const resourceTotal = yuanAmountObject(cents);
    if (resourceTotal.amount !== price.amount) return null;
    return { ...quote, lines, resourceTotal, baseRenterHaffRatioWanPerYuan: price.ratio,
      tenantPayableTotal: quote.tenantDeposit === null ? null : yuanAmountObject(cents + BigInt(quote.tenantDeposit.amount.replace(".", ""))) };
  } catch { return null; }
}
