import type { ContentPayloadInput } from "../src/supply/content-hash";

export function legacyPayload(): ContentPayloadInput {
  const money = (amount: string) => ({ currency: "CNY" as const, unit: "yuan" as const, amount, scale: 2 as const });
  const unit = (amount: string) => ({ currency: "CNY" as const, unit: "yuan" as const, amount, scale: 8 as const });
  const roundingPolicy = "LEGACY_WHOLE_YUAN_PREPAY_V1";
  return {
    schemaVersion: 3, accountId: "legacy-account", gameId: "game",
    declaration: { title: "fixture", description: null, attributes: { rentalPricing: { rentalMode: "ordinary" },
      legacy_published_reference: "c".repeat(64), full_payout_declaration: { schema: "full-payout-declaration-v1", selected: false },
      owner_deposit_declaration: { schema: "owner-deposit-declaration-v1", amountCents: "20000", declarationVersion: "legacy-trade-intake-v1" } },
      inventory: [{ itemId: "haff", quantity: "150000000" }], skins: [], entitlements: [], termOptionCode: "daily-10m", pricingOptionCode: "", mediaBindings: [] },
    ruleRefs: { releaseId: "release", priceVersionId: "price", termVersionId: "term", agreementVersionId: "agreement", agreementDigest: "d".repeat(64) },
    quoteSource: "LEGACY_QUOTED", legacyQuote: { schema: "legacy-listed-quote-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "42", observationVersionId: "observation", sourceDigest: "a".repeat(64), sourcePolicyDigest: "b".repeat(64),
      haffMillions: "150", ownerRatio: "43", spread: "6", recordedOwnerYuan: "349.00", recordedTenantYuan: "405.00", recordedVipYuan: "385.00", depositYuan: "200.00", rentalDays: "15", rentalMode: "ordinary", fullPayoutSelected: false },
    quoteValues: { schemaVersion: 3, currency: "CNY", priceVersionId: "price", ruleReleaseId: "release", mode: "SPREAD", quoteSource: "LEGACY_QUOTED",
      legacyQuote: { schema: "legacy-listed-quote-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "42", observationVersionId: "observation", sourceDigest: "a".repeat(64), sourcePolicyDigest: "b".repeat(64), haffMillions: "150", ownerRatio: "43", spread: "6", recordedOwnerYuan: "349.00", recordedTenantYuan: "405.00", recordedVipYuan: "385.00", depositYuan: "200.00", rentalDays: "15", rentalMode: "ordinary", fullPayoutSelected: false },
      lines: [{ itemId: "haff", quantity: "150000000", unit: "HAFF_BASE", unitQuantity: "1000000", pricingKind: "HAFF_RATIO", buyerUnitAmount: unit("2.70000000"), ownerUnitAmount: unit("2.32666667"), buyerAmount: money("405.00"), ownerAmount: money("349.00"), platformAmount: money("56.00") }],
      resourceTotal: money("405.00"), ownerTotal: money("349.00"), platformFullProfit: money("56.00"), tenantDeposit: money("200.00"), publisherBailRequirement: money("0.00"), termSeconds: "1296000", expiryDisclosures: [], unitAmountsInformational: true, roundingPolicy,
      pricingInputs: { haffRatioSchema: "legacy-listed-v1", compatibility: { rentalMode: "ordinary", customerTier: "STANDARD", ownerRatioB: "43" }, conditions: null, denominators: { owner: "43", buyer: "37" }, spreadDelta: "6", commissionRate: null,
        exactRatios: [{ itemId: "haff", buyerNumerator: "40500", buyerDenominator: "100", ownerNumerator: "34900", ownerDenominator: "100" }], roundingPolicy, depositPolicy: "CONFIGURED", reasonCodes: [] } },
  };
}
