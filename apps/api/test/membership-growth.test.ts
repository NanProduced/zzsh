import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseCompleteOffer,
  computeGrowthOfferPlan,
  contributionFromSettlement,
  hasOverlappingEntitlement,
  normalTierForPoints,
  quoteToGrowthOfferPlan,
  replayGrowthProjection,
  entitlementStateAt,
  roundHalfUpCents,
  validateBenefitPolicy,
  validateEntitlementCandidate,
  type GrowthBenefitPolicy,
  type GrowthContribution,
} from "../src/auth/membership-growth";
import { compatRule } from "./pricing-compat-fixture";

const contribution = (patch: Partial<GrowthContribution> = {}): GrowthContribution => ({
  userId: "user_1",
  sourceKey: "RENTAL_SETTLEMENT:order_1:v1",
  sourceType: "RENTAL_SETTLEMENT",
  sourceId: "order_1",
  settlementVersion: "v1",
  effectiveAt: "2026-10-01T00:00:00.000Z",
  recordedAt: "2026-10-01T00:00:00.000Z",
  amountCents: "100",
  status: "SETTLED",
  eligible: true,
  revision: 0,
  ...patch,
});

function policy(): GrowthBenefitPolicy {
  const haff = (value: string) => ({ status: "CONFIGURED" as const, kind: "HAFF_RATIO" as const, schema: "haff-ratio-v1" as const, priceVersionId: "price-v1", costBasisRef: "sealed-cost-basis-v1", baseBySafeBox: { box: value }, spreadDelta: "0" });
  const material = (value: string) => { const delta = BigInt(value); return { status: "CONFIGURED" as const, kind: "FIXED_UNIT" as const, itemId: "item", unit: "PIECE" as const, unitQuantity: "1", buyerUnitAmount: String(1000n - delta), ownerUnitAmount: String(100n + delta), priceVersionId: "price-v1", costBasisRef: "sealed-cost-basis-v1" }; };
  const contract = (name: GrowthBenefitPolicy["tiers"]["STANDARD"]["tier"], value: string, mode: "ordinary" | "custom" | "fast") => ({ mode, priceVersionId: "price-v1", haff: haff(value), materials: { item: material(value) } });
  const tier = (name: GrowthBenefitPolicy["tiers"]["STANDARD"]["tier"], discount: string) => ({
    tier: name,
    tenantDeposit: name === "STANDARD" || name === "SILVER" ? "ACCOUNT_BASE" as const : "WAIVED" as const,
    pricing: { ordinary: contract(name, discount, "ordinary"), custom: contract(name, discount, "custom"), fast: contract(name, discount, "fast") },
    entitlementCap: contract(name, discount, "ordinary"),
  });
  return {
    schema: "membership-growth-v1",
    version: "benefits-v1",
    status: "DRAFT",
    effectiveAt: null,
    sourceRef: "sealed-cost-basis-v1",
    tiers: {
      STANDARD: tier("STANDARD", "0"), SILVER: tier("SILVER", "100"), GOLD: tier("GOLD", "500"), PLATINUM: tier("PLATINUM", "700"), DIAMOND: tier("DIAMOND", "1000"),
    },
    entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" },
  };
}

test("HALF_UP uses the aggregate, not per-order integer points", () => {
  assert.equal(roundHalfUpCents(499_949n), 4_999n);
  assert.equal(roundHalfUpCents(499_950n), 5_000n);
  const result = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [
    contribution({ amountCents: "49", sourceKey: "RENTAL_SETTLEMENT:a:v1" }),
    contribution({ amountCents: "49", sourceKey: "MATERIAL_CONSUMPTION:b:v1", sourceType: "MATERIAL_CONSUMPTION", sourceId: "b" }),
  ] });
  assert.equal(result.rollingCents, "98");
  assert.equal(result.rollingPoints, "1");
  assert.equal(normalTierForPoints(5_000n), "SILVER");
});

test("same source revisions replace, pending and identity-mismatched rows never merge", () => {
  const result = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [
    contribution({ amountCents: "499949", sourceKey: "RENTAL_SETTLEMENT:order_2:v1" }),
    contribution({ amountCents: "499950", sourceKey: "RENTAL_SETTLEMENT:order_2:v1", revision: 1, previousAmountCents: "499949" }),
    contribution({ amountCents: "999999", sourceKey: "RENTAL_SETTLEMENT:pending:v1", status: "PENDING" }),
    contribution({ userId: "user_2", amountCents: "999999", sourceKey: "RENTAL_SETTLEMENT:other:v1" }),
  ] });
  assert.equal(result.rollingPoints, "5000");
  assert.equal(result.pending.length, 1);
  assert.ok(result.excluded.some((row) => row.reason === "IDENTITY_MISMATCH"));
});

test("stable source chains apply VOID and successive replace/increment corrections once", () => {
  const source = "RENTAL_SETTLEMENT:stable-source";
  const base = contribution({ sourceKey: source, amountCents: "1000000", sourceId: "stable-source" });
  const replaced = contribution({ sourceKey: source, amountCents: "700000", previousAmountCents: "1000000", correctionMode: "REPLACE", correctionOf: source, sourceId: "refund-1", revision: 1, recordedAt: "2026-10-02T00:00:00.000Z" });
  const incremented = contribution({ sourceKey: source, amountCents: "-200000", correctionMode: "INCREMENT", correctionOf: source, sourceId: "refund-2", revision: 2, recordedAt: "2026-10-03T00:00:00.000Z" });
  const projected = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [base, replaced, incremented] });
  assert.equal(projected.rollingCents, "500000");
  const replayed = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [base, replaced, incremented, { ...incremented }] });
  assert.equal(replayed.rollingCents, "500000");
  assert.throws(() => replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [base, { ...base, amountCents: "999999", revision: 0 }] }), (error: any) => error.code === "SOURCE_REVISION_CONFLICT");
  const voided = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [...[base, replaced, incremented], contribution({ sourceKey: source, status: "VOID", revision: 3, recordedAt: "2026-10-04T00:00:00.000Z" })] });
  assert.equal(voided.rollingPoints, "0");
  assert.ok(voided.excluded.some((item) => item.sourceKey === source && item.reason === "VOID"));
});

test("90-day expiration anchors one seven-day buffer and does not re-anchor offline", () => {
  const row = contribution({ amountCents: "1000000", effectiveAt: "2026-07-12T00:00:00.000Z", recordedAt: "2026-07-12T00:00:00.000Z", sourceKey: "RENTAL_SETTLEMENT:expiring:v1" });
  const active = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", previousTier: "GOLD", contributions: [row] });
  assert.equal(active.rollingPoints, "0");
  assert.equal(active.grace.state, "ACTIVE");
  assert.equal(active.grace.until, "2026-10-17T00:00:00.000Z");
  const boundary = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-17T00:00:00.000Z", previousTier: "GOLD", contributions: [row] });
  assert.equal(boundary.grace.state, "EXPIRED");
  const offline = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-25T00:00:00.000Z", previousTier: "GOLD", contributions: [row] });
  assert.equal(offline.grace.until, "2026-10-17T00:00:00.000Z");
  assert.equal(offline.grace.state, "EXPIRED");
  const first = contribution({ sourceKey: "RENTAL_SETTLEMENT:first-expiry:v1", amountCents: "1000000", effectiveAt: "2026-01-01T00:00:00.000Z", recordedAt: "2026-01-01T00:00:00.000Z" });
  const second = contribution({ sourceKey: "RENTAL_SETTLEMENT:second-expiry:v1", amountCents: "600000", effectiveAt: "2026-01-06T00:00:00.000Z", recordedAt: "2026-01-06T00:00:00.000Z" });
  const fixed = replayGrowthProjection({ userId: "user_1", asOf: "2026-04-10T00:00:00.000Z", previousTier: "GOLD", contributions: [first, second] });
  assert.equal(fixed.effectiveTier, "STANDARD");
  assert.equal(fixed.grace.until, "2026-04-08T00:00:00.000Z");
});

test("black gold is lifetime evidence and a later correction is review-required", () => {
  const old = contribution({ amountCents: "5000000", effectiveAt: "2025-01-01T00:00:00.000Z", sourceKey: "RENTAL_SETTLEMENT:lifetime:v1" });
  const qualified = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [old] });
  assert.equal(qualified.rollingPoints, "0");
  assert.equal(qualified.lifetimePoints, "50000");
  assert.equal(qualified.effectiveTier, "BLACK_GOLD");
  const review = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", existingBlackGold: true, contributions: [contribution({ amountCents: "0", sourceKey: "RENTAL_SETTLEMENT:lifetime:v1", effectiveAt: old.effectiveAt, previousAmountCents: old.amountCents, revision: 1 })] });
  assert.equal(review.blackGold, "REVIEW_REQUIRED");
  assert.equal(review.effectiveTier, "BLACK_GOLD");
});

test("settlement adapter excludes deposits, penalties and unsettled amounts", () => {
  assert.equal(contributionFromSettlement({ userId: "user_1", settlementId: "d1", settlementVersion: "v1", component: "DEPOSIT", effectiveAt: "2026-10-01T00:00:00.000Z", recordedAt: "2026-10-01T00:00:00.000Z", amountCents: "100", status: "SETTLED", revision: 0 }).accepted, false);
  const pending = contributionFromSettlement({ userId: "user_1", settlementId: "s1", settlementVersion: "v1", component: "RENTAL_SETTLEMENT", effectiveAt: "2026-10-01T00:00:00.000Z", recordedAt: "2026-10-01T00:00:00.000Z", amountCents: "100", status: "PENDING", revision: 0 });
  assert.equal(pending.accepted, false);
  if (!pending.accepted) assert.equal(pending.reason, "NOT_SETTLED");
});

test("negative net consumption is explicitly unknown and unapproved time does not activate an entitlement", () => {
  const negative = replayGrowthProjection({ userId: "user_1", asOf: "2026-10-10T00:00:00.000Z", contributions: [contribution({ amountCents: "-100" })] });
  assert.equal(negative.effectiveTier, "UNKNOWN");
  assert.equal(entitlementStateAt({ status: "PENDING", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" }, "2026-10-10T00:00:00.000Z"), "PENDING");
  assert.equal(entitlementStateAt({ status: "APPROVED_PENDING_EXECUTION", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" }, "2026-10-10T00:00:00.000Z"), "APPROVED_PENDING_EXECUTION");
  assert.equal(entitlementStateAt({ status: "EXECUTED_PENDING_START", startsAt: "2026-10-11T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" }, "2026-10-10T00:00:00.000Z"), "EXECUTED_PENDING_START");
  assert.equal(entitlementStateAt({ status: "REPLACED", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z" }, "2026-10-10T00:00:00.000Z"), "REPLACED");
});

test("benefit policy requires monotonic configured savings and preserves missing cost basis", () => {
  const valid = policy();
  assert.equal(validateBenefitPolicy(valid).valid, true);
  assert.equal(validateBenefitPolicy(valid).publishable, false);
  const bad = policy();
  const silverMaterial = bad.tiers.SILVER.pricing.ordinary.materials.item!;
  const goldMaterial = bad.tiers.GOLD.pricing.ordinary.materials.item!;
  if (silverMaterial.status === "CONFIGURED" && goldMaterial.status === "CONFIGURED") {
    silverMaterial.buyerUnitAmount = "1";
    silverMaterial.ownerUnitAmount = "1";
    goldMaterial.buyerUnitAmount = "9";
    goldMaterial.ownerUnitAmount = "9";
  }
  assert.equal(validateBenefitPolicy(bad).valid, false);
  const unknown = policy();
  unknown.tiers.DIAMOND.pricing.fast.haff = { status: "NOT_PRICED", reason: "渠道成本未封存" };
  assert.equal(validateBenefitPolicy(unknown).valid, true);
  assert.equal(validateBenefitPolicy(unknown).publishable, false);
  assert.ok(validateBenefitPolicy(unknown).warnings.some((value) => value.includes("cost_basis_missing")));
  const invalid = policy();
  invalid.tiers.STANDARD.tenantDeposit = "INVALID" as never;
  (invalid.tiers.STANDARD.pricing.ordinary.haff as { status: string }).status = "INVALID";
  const invalidResult = validateBenefitPolicy(invalid);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.publishable, false);
  const spread = policy();
  for (const tier of Object.values(spread.tiers)) for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = tier.pricing[mode].haff;
    if (haff.status === "CONFIGURED") { haff.baseBySafeBox.box = "100"; haff.spreadDelta = "10"; }
  }
  for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = spread.tiers.GOLD.pricing[mode].haff;
    if (haff.status === "CONFIGURED") haff.spreadDelta = "90";
  }
  assert.equal(validateBenefitPolicy(spread).valid, false);
  const baseAndSpread = policy();
  for (const tier of Object.values(baseAndSpread.tiers)) for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = tier.pricing[mode].haff;
    if (haff.status === "CONFIGURED") { haff.baseBySafeBox.box = "100"; haff.spreadDelta = "10"; }
  }
  for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = baseAndSpread.tiers.GOLD.pricing[mode].haff;
    if (haff.status === "CONFIGURED") { haff.baseBySafeBox.box = "110"; haff.spreadDelta = "105"; }
  }
  assert.equal(validateBenefitPolicy(baseAndSpread).valid, false);
});

test("entitlement limits are typed, bounded and non-overlapping", () => {
  const p = policy();
  const candidate = { userId: "user_1", kind: "FRIEND" as const, scopeKey: "game:delta:account-a", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-12-30T00:00:00.000Z", pricing: p.tiers.GOLD.pricing.ordinary, depositWaived: false, reason: "客服专项服务", requestedBy: "admin_1" };
  const friendValidation = validateEntitlementCandidate(candidate, "STANDARD", p);
  assert.equal(friendValidation.valid, true, JSON.stringify(friendValidation));
  const prestigeValidation = validateEntitlementCandidate({ ...candidate, kind: "PRESTIGE", pricing: p.tiers.DIAMOND.pricing.ordinary }, "STANDARD", p);
  assert.equal(prestigeValidation.valid, true, JSON.stringify(prestigeValidation));
  assert.equal(validateEntitlementCandidate({ ...candidate, endsAt: "2027-01-01T00:00:00.000Z" }, "STANDARD", p).valid, false);
  assert.equal(hasOverlappingEntitlement([{ ...candidate, id: "old", status: "ACTIVE" }], { ...candidate, id: "new" }), true);
  assert.equal(hasOverlappingEntitlement([{ ...candidate, id: "old", status: "ACTIVE" }], { ...candidate, id: "old" }), false);
});

test("complete plans choose one price basis while deposit waiver stays independent", () => {
  const binding = { userId: "u", accountId: "a", ownerUserId: "o", listingVersionId: "l", ruleReleaseId: "r", quantityDigest: "q" };
  const result = chooseCompleteOffer([
    { source: "GROWTH", rentalTotalCents: "12000", depositCents: "30000", depositWaived: false, priceVersion: "p1", benefitVersion: "b1", binding },
    { source: "FRIEND", rentalTotalCents: "13000", depositCents: "30000", depositWaived: true, priceVersion: "p1", benefitVersion: "e1", binding, entitlementId: "ent_1", validUntil: "2026-12-30T00:00:00.000Z" },
  ], "2026-10-10T00:00:00.000Z");
  assert.equal(result.knowledge, "KNOWN");
  if (result.knowledge === "KNOWN") {
    assert.equal(result.selected.source, "GROWTH");
    assert.equal(result.priceBasis, "GROWTH");
    assert.equal(result.depositBasis, "FRIEND");
    assert.equal(result.depositCents, "0");
  }
  const tie = chooseCompleteOffer([
    { source: "FRIEND", rentalTotalCents: "12000", depositCents: "30000", depositWaived: false, priceVersion: "p1", benefitVersion: "e1", binding },
    { source: "GROWTH", rentalTotalCents: "12000", depositCents: "30000", depositWaived: false, priceVersion: "p1", benefitVersion: "b1", binding },
  ], "2026-10-10T00:00:00.000Z");
  assert.equal(tie.knowledge, "KNOWN");
  if (tie.knowledge === "KNOWN") assert.equal(tie.selected.source, "GROWTH");
});

test("quote adapter preserves zero money instead of rejecting padded cents", () => {
  const plan = quoteToGrowthOfferPlan({ priceVersionId: "p1", resourceTotal: { amount: "0.00" }, tenantDeposit: { amount: "0.00" } } as never, { source: "GROWTH", benefitVersion: "b1", binding: { userId: "u", accountId: "a", ownerUserId: "o", listingVersionId: "l", ruleReleaseId: "r", quantityDigest: "q" } });
  assert.equal(plan.rentalTotalCents, "0");
  assert.equal(plan.depositCents, "0");
  assert.equal(plan.depositWaived, true);
});

test("growth quote adapter calls the existing delta calculator for ordinary, custom and fast", () => {
  const binding = { userId: "u", accountId: "a", ownerUserId: "o", listingVersionId: "listing-v1", ruleReleaseId: "release-v1", quantityDigest: "quantity-v1" };
  for (const rentalMode of ["ordinary", "custom", "fast"] as const) {
    const quote = {
      priceVersionId: "price-v1",
      mode: "SPREAD" as const,
      roundingPolicy: "HALF_UP_CENT_V1",
      customerTier: "STANDARD" as const,
      haffRule: compatRule(),
      lines: [{ itemId: "haff", quantity: "60000000", pricingKind: "HAFF_RATIO" as const, unit: "HAFF_BASE" as const, customerTier: "STANDARD" as const }],
      conditions: {
        safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m",
        rentalPricing: rentalMode === "ordinary" ? { rentalMode } : { rentalMode, ownerRatioB: rentalMode === "custom" ? "46" : "55" },
      },
      termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" as const },
      deposits: { tenantDepositCents: "30000", publisherBailRequirementCents: "0" },
    };
    const result = computeGrowthOfferPlan({ quote, source: "GROWTH", benefitVersion: "benefit-v1", binding });
    assert.equal(result.knowledge, "KNOWN", `${rentalMode} should use computeDeltaQuote ${JSON.stringify(result)}`);
    if (result.knowledge === "KNOWN") {
      assert.equal(result.plan.priceVersion, "price-v1");
      assert.deepEqual(result.plan.binding, binding);
      assert.equal(result.plan.depositCents, "30000");
    }
  }
  const mismatch = chooseCompleteOffer([
    { source: "GROWTH", rentalTotalCents: "100", depositCents: "0", depositWaived: true, priceVersion: "p", benefitVersion: "b", binding },
    { source: "FRIEND", rentalTotalCents: "90", depositCents: "0", depositWaived: true, priceVersion: "p", benefitVersion: "e", binding: { ...binding, quantityDigest: "other" } },
  ], "2026-10-10T00:00:00.000Z");
  assert.deepEqual(mismatch, { knowledge: "UNKNOWN", reason: "BINDING_MISMATCH" });
});

test("E-R3-02 one microsecond asOf drives facts, corrections, rolling window, grace and the shared offer choice", () => {
  const at = (frac: string) => `2026-10-16T08:00:00.${frac}Z`;
  const asOf = at("123456");
  const replay = (asOfValue: string, rows: GrowthContribution[], extra: Record<string, unknown> = {}) => replayGrowthProjection({ userId: "user_1", asOf: asOfValue, contributions: rows, ...extra });
  // Same-millisecond future fact (reviewer counterexample): not yet effective at .123456, effective from .123900.
  const future = contribution({ effectiveAt: at("123900"), recordedAt: at("123900"), amountCents: "1000000" });
  assert.equal(replay(asOf, [future]).rollingPoints, "0");
  assert.equal(replay(asOf, [future]).normalTier, "STANDARD");
  assert.equal(replay(at("123899"), [future]).rollingPoints, "0");
  assert.equal(replay(at("123900"), [future]).rollingPoints, "10000");
  assert.equal(replay(at("123900"), [future]).normalTier, "GOLD");
  // Same-millisecond correction recorded after asOf is not applied yet.
  const base = contribution({ effectiveAt: "2026-10-10T00:00:00.000000Z", recordedAt: "2026-10-10T00:00:00.000000Z", amountCents: "1000000" });
  const corr = contribution({ effectiveAt: "2026-10-10T00:00:00.000000Z", recordedAt: at("123900"), amountCents: "0", revision: 1, correctionMode: "REPLACE", previousAmountCents: "1000000" });
  assert.equal(replay(asOf, [base, corr]).rollingPoints, "10000");
  assert.equal(replay(at("123900"), [base, corr]).rollingPoints, "0");
  // 90-day rolling exit at microsecond precision.
  const early = contribution({ effectiveAt: "2026-07-18T08:00:00.123456Z", recordedAt: "2026-07-18T08:00:00.123456Z", amountCents: "1000000" });
  assert.equal(replay("2026-10-16T08:00:00.123455Z", [early]).rollingPoints, "10000");
  assert.equal(replay("2026-10-16T08:00:00.123456Z", [early]).rollingPoints, "0");
  assert.equal(replay("2026-10-16T08:00:00.123455Z", [early]).active[0]!.expiresAt, "2026-10-16T08:00:00.123456Z");
  // Grace (keep-tier) ends exactly 7 days after the microsecond drop.
  const drop = "2026-10-09T08:00:00.123456Z";
  assert.equal(replay("2026-10-16T08:00:00.123455Z", [], { previousTier: "GOLD", lastTierDropAt: drop }).grace.state, "ACTIVE");
  assert.equal(replay("2026-10-16T08:00:00.123455Z", [], { previousTier: "GOLD", lastTierDropAt: drop }).effectiveTier, "GOLD");
  assert.equal(replay("2026-10-16T08:00:00.123456Z", [], { previousTier: "GOLD", lastTierDropAt: drop }).grace.state, "EXPIRED");
  // Old millisecond/second inputs keep their historical output form; > 6 digits is rejected, never truncated.
  assert.equal(replay("2026-10-01T00:00:00.000Z", []).asOf, "2026-10-01T00:00:00.000Z");
  assert.equal(replay("2026-10-01T00:00:00Z", []).asOf, "2026-10-01T00:00:00.000Z");
  assert.equal(replay(asOf, []).asOf, asOf);
  assert.throws(() => replay("2026-10-01T00:00:00.1234567Z", []), /microsecond|invalid/i);
  // Shared chooseCompleteOffer: a FRIEND waiver valid until .123900 is still valid at .123456 (deposit 0), not at/after .123900.
  const binding = { userId: "u", accountId: "a", ownerUserId: "o", listingVersionId: "l", ruleReleaseId: "r", quantityDigest: "q" };
  const growthPlan = { source: "GROWTH" as const, rentalTotalCents: "10000", depositCents: "30000", depositWaived: false, priceVersion: "p", benefitVersion: "1", binding };
  const friend = { ...growthPlan, source: "FRIEND" as const, rentalTotalCents: "12000", depositCents: "0", depositWaived: true, entitlementId: "f", validUntil: at("123900") };
  const live = chooseCompleteOffer([growthPlan, friend], asOf);
  assert.equal(live.knowledge, "KNOWN");
  if (live.knowledge === "KNOWN") assert.deepEqual([live.priceBasis, live.depositBasis, live.depositCents], ["GROWTH", "FRIEND", "0"]);
  const atEnd = chooseCompleteOffer([growthPlan, friend], at("123900"));
  if (atEnd.knowledge === "KNOWN") assert.deepEqual([atEnd.depositBasis, atEnd.depositCents], ["GROWTH", "30000"]); else assert.fail();
  const after = chooseCompleteOffer([growthPlan, friend], at("123901"));
  if (after.knowledge === "KNOWN") assert.equal(after.depositCents, "30000"); else assert.fail();
  // Entitlement state at the same microsecond semantics.
  assert.equal(entitlementStateAt({ startsAt: "2026-10-01T00:00:00Z", endsAt: at("123900"), status: "ACTIVE" }, asOf), "ACTIVE");
  assert.equal(entitlementStateAt({ startsAt: "2026-10-01T00:00:00Z", endsAt: at("123456"), status: "ACTIVE" }, asOf), "EXPIRED");
  assert.equal(entitlementStateAt({ startsAt: at("123900"), endsAt: "2026-10-20T00:00:00Z", status: "EXECUTED_PENDING_START" }, asOf), "EXECUTED_PENDING_START");
});
