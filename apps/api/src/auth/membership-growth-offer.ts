/** 报价选择。从 membership-growth 原样移出，未知结果判定不变。 */
import { computeDeltaQuote, type InternalQuote, type QuoteInput } from "../supply/pricing";
import { parseCents, parseInstant, parseMoneyCents, tenantDepositAfterBenefit } from "./membership-growth-money";

export type OfferBinding = {
  userId: string;
  accountId: string;
  ownerUserId: string;
  listingVersionId: string;
  ruleReleaseId: string;
  quantityDigest: string;
};

export type GrowthOfferPlan = {
  source: "GROWTH" | "FRIEND" | "PRESTIGE";
  rentalTotalCents: string;
  depositCents: string | null;
  depositWaived: boolean;
  priceVersion: string;
  benefitVersion: string;
  binding: OfferBinding;
  entitlementId?: string;
  validUntil?: string | null;
};

export function quoteToGrowthOfferPlan(quote: InternalQuote, input: Omit<GrowthOfferPlan, "rentalTotalCents" | "depositCents" | "depositWaived" | "priceVersion"> & { source: GrowthOfferPlan["source"] }): GrowthOfferPlan {
  const depositCents = quote.tenantDeposit === null ? null : parseMoneyCents(quote.tenantDeposit.amount, "tenantDeposit").toString();
  return { ...input, priceVersion: quote.priceVersionId, rentalTotalCents: parseMoneyCents(quote.resourceTotal.amount, "resourceTotal").toString(), depositCents, depositWaived: depositCents === "0" };
}

export type GrowthOfferBuildInput = {
  quote: QuoteInput;
  source: GrowthOfferPlan["source"];
  benefitVersion: string;
  binding: OfferBinding;
  entitlementId?: string;
  validUntil?: string | null;
  depositWaivedOverride?: boolean;
  depositAllowanceCents?: string;
};

export function computeGrowthOfferPlan(input: GrowthOfferBuildInput): { knowledge: "KNOWN"; plan: GrowthOfferPlan } | { knowledge: "UNKNOWN"; reason: "QUOTE_UNAVAILABLE"; reasonCodes: string[] } {
  const result = computeDeltaQuote(input.quote);
  if (!result.quotable) return { knowledge: "UNKNOWN", reason: "QUOTE_UNAVAILABLE", reasonCodes: result.reasonCodes };
  const plan = quoteToGrowthOfferPlan(result.quote, {
    source: input.source,
    benefitVersion: input.benefitVersion,
    binding: input.binding,
    ...(input.entitlementId === undefined ? {} : { entitlementId: input.entitlementId }),
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
  });
  const depositCents = tenantDepositAfterBenefit(plan.depositCents, input.depositWaivedOverride === true, input.depositAllowanceCents);
  return { knowledge: "KNOWN", plan: { ...plan, depositCents, depositWaived: depositCents === "0" } };
}

export type OfferChoice =
  | { knowledge: "KNOWN"; selected: GrowthOfferPlan; depositCents: string | null; priceBasis: GrowthOfferPlan["source"]; depositBasis: GrowthOfferPlan["source"] | "UNKNOWN" }
  | { knowledge: "UNKNOWN"; reason: "NO_VALID_PLAN" | "DEPOSIT_UNKNOWN" | "BINDING_MISMATCH" };

export function chooseCompleteOffer(plans: readonly GrowthOfferPlan[], asOf: string): OfferChoice {
  const now = parseInstant(asOf, "asOf");
  const valid = plans.filter((plan) => plan.validUntil === undefined || plan.validUntil === null || parseInstant(plan.validUntil, "validUntil") > now);
  if (valid.length === 0) return { knowledge: "UNKNOWN", reason: "NO_VALID_PLAN" };
  const bindingKey = (binding: OfferBinding) => JSON.stringify(binding);
  const firstBinding = valid[0]!.binding;
  if (!firstBinding || valid.some((plan) => !plan.binding || bindingKey(plan.binding) !== bindingKey(firstBinding))) return { knowledge: "UNKNOWN", reason: "BINDING_MISMATCH" };
  for (const plan of valid) {
    parseCents(plan.rentalTotalCents, "rentalTotalCents", false);
    if (plan.depositCents !== null) parseCents(plan.depositCents, "depositCents", false);
  }
  const selected = [...valid].sort((a, b) => {
    const amount = parseCents(a.rentalTotalCents, "rentalTotalCents", false) - parseCents(b.rentalTotalCents, "rentalTotalCents", false);
    if (amount !== 0n) return amount < 0n ? -1 : 1;
    return a.source === "GROWTH" ? -1 : b.source === "GROWTH" ? 1 : 0;
  })[0]!;
  // Independently choose the lowest payable deposit: allowances share one base and never add together.
  const deposits = valid.filter(plan => plan.depositWaived || plan.depositCents !== null).sort((a, b) => {
    const difference = parseCents(a.depositWaived ? "0" : a.depositCents!, "depositCents", false) - parseCents(b.depositWaived ? "0" : b.depositCents!, "depositCents", false);
    return difference < 0n ? -1 : difference > 0n ? 1 : a.source === "GROWTH" ? -1 : b.source === "GROWTH" ? 1 : 0;
  });
  const deposit = deposits[0];
  if (!deposit || valid.some(plan => plan.depositCents === null && !plan.depositWaived) && !deposit.depositWaived && deposit.depositCents !== "0") return { knowledge: "UNKNOWN", reason: "DEPOSIT_UNKNOWN" };
  return { knowledge: "KNOWN", selected, priceBasis: selected.source, depositBasis: deposit.source, depositCents: deposit.depositWaived ? "0" : deposit.depositCents };
}
