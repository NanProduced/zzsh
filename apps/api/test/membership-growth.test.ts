import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseCompleteOffer,
  computeGrowthOfferPlan,
  contributionFromSettlement,
  hasOverlappingEntitlement,
  isLegacyPricingContract,
  isNotPriced,
  isTotalDiscountContract,
  normalTierForPoints,
  quoteToGrowthOfferPlan,
  replayGrowthProjection,
  entitlementStateAt,
  roundHalfUpCents,
  sealedEnabledRentalModes,
  validateBenefitPolicy,
  validateEntitlementCandidate,
  type GrowthBenefitPolicy,
  type GrowthContribution,
  type GrowthPricingContract,
  type ModePricingContract,
} from "../src/auth/membership-growth";
import { compatRule } from "./pricing-compat-fixture";

function configuredMode(tier: GrowthBenefitPolicy["tiers"]["STANDARD"], mode: "ordinary" | "custom" | "fast"): GrowthPricingContract {
  const contract = tier.pricing[mode];
  if (!contract || isNotPriced(contract) || !isLegacyPricingContract(contract)) throw new Error(`expected a configured legacy ${mode} contract`);
  return contract;
}

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
  const silverMaterial = configuredMode(bad.tiers.SILVER, "ordinary").materials.item!;
  const goldMaterial = configuredMode(bad.tiers.GOLD, "ordinary").materials.item!;
  if (silverMaterial.status === "CONFIGURED" && goldMaterial.status === "CONFIGURED") {
    silverMaterial.buyerUnitAmount = "1";
    silverMaterial.ownerUnitAmount = "1";
    goldMaterial.buyerUnitAmount = "9";
    goldMaterial.ownerUnitAmount = "9";
  }
  assert.equal(validateBenefitPolicy(bad).valid, false);
  const unknown = policy();
  configuredMode(unknown.tiers.DIAMOND, "fast").haff = { status: "NOT_PRICED", reason: "渠道成本未封存" };
  assert.equal(validateBenefitPolicy(unknown).valid, true);
  assert.equal(validateBenefitPolicy(unknown).publishable, false);
  assert.ok(validateBenefitPolicy(unknown).warnings.some((value) => value.includes("cost_basis_missing")));
  const invalid = policy();
  invalid.tiers.STANDARD.tenantDeposit = "INVALID" as never;
  (configuredMode(invalid.tiers.STANDARD, "ordinary").haff as { status: string }).status = "INVALID";
  const invalidResult = validateBenefitPolicy(invalid);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.publishable, false);
  const spread = policy();
  for (const tier of Object.values(spread.tiers)) for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = configuredMode(tier, mode).haff;
    if (haff.status === "CONFIGURED") { haff.baseBySafeBox.box = "100"; haff.spreadDelta = "10"; }
  }
  for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = configuredMode(spread.tiers.GOLD, mode).haff;
    if (haff.status === "CONFIGURED") haff.spreadDelta = "90";
  }
  assert.equal(validateBenefitPolicy(spread).valid, false);
  const baseAndSpread = policy();
  for (const tier of Object.values(baseAndSpread.tiers)) for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = configuredMode(tier, mode).haff;
    if (haff.status === "CONFIGURED") { haff.baseBySafeBox.box = "100"; haff.spreadDelta = "10"; }
  }
  for (const mode of ["ordinary", "custom", "fast"] as const) {
    const haff = configuredMode(baseAndSpread.tiers.GOLD, mode).haff;
    if (haff.status === "CONFIGURED") { haff.baseBySafeBox.box = "110"; haff.spreadDelta = "105"; }
  }
  assert.equal(validateBenefitPolicy(baseAndSpread).valid, false);
});

test("sealed release modes decide which contracts are required, and pending values stay draft-only", () => {
  const approved = () => { const value = policy(); value.status = "APPROVED"; return value; };
  const enabledOrdinaryCustom = ["ordinary", "custom"] as const;
  // A mode the sealed release disabled is inert: NOT_PRICED fast neither warns nor blocks publish.
  const fastOff = approved();
  for (const tier of Object.values(fastOff.tiers)) configuredMode(tier, "fast").haff = { status: "NOT_PRICED", reason: "权威禁用模式" };
  const fastOffResult = validateBenefitPolicy(fastOff, { enabledModes: enabledOrdinaryCustom });
  assert.equal(fastOffResult.valid, true, JSON.stringify(fastOffResult));
  assert.equal(fastOffResult.publishable, true, JSON.stringify(fastOffResult));
  // The same policy against a release that enables fast must reject, and never invents a price.
  const fastOnResult = validateBenefitPolicy(fastOff, { enabledModes: ["ordinary", "custom", "fast"] });
  assert.equal(fastOnResult.valid, true);
  assert.equal(fastOnResult.publishable, false);
  assert.ok(fastOnResult.warnings.some((warning) => warning.includes("cost_basis_missing")));
  // A dropped disabled-mode contract drifts downstream, so a configured one is still shape-checked.
  const badDisabled = approved();
  configuredMode(badDisabled.tiers.GOLD, "fast").mode = "ordinary" as never;
  assert.equal(validateBenefitPolicy(badDisabled, { enabledModes: enabledOrdinaryCustom }).valid, false);
  // Pending values are draft-savable but never publishable.
  const pending = approved();
  const pendingContract = configuredMode(pending.tiers.GOLD, "ordinary");
  if (pendingContract.haff.status === "CONFIGURED") {
    pendingContract.haff.baseBySafeBox.box = "";
    pendingContract.haff.costBasisRef = "";
  }
  const pendingMaterial = pendingContract.materials.item!;
  if (!isNotPriced(pendingMaterial)) pendingMaterial.buyerUnitAmount = "";
  const pendingResult = validateBenefitPolicy(pending, { enabledModes: enabledOrdinaryCustom });
  assert.equal(pendingResult.valid, true, JSON.stringify(pendingResult));
  assert.equal(pendingResult.publishable, false);
  assert.ok(pendingResult.warnings.some((warning) => warning.includes("value_pending")));
  // Release catalog coverage is a publish blocker; a unit that contradicts the catalog is invalid.
  const coverage = approved();
  const coverageResult = validateBenefitPolicy(coverage, { enabledModes: enabledOrdinaryCustom, catalog: { safeBoxes: ["box", "box-2"], materials: [{ itemId: "item", unit: "PIECE" }] } });
  assert.equal(coverageResult.publishable, false);
  assert.ok(coverageResult.warnings.some((warning) => warning.includes("box-2.catalog_missing")));
  const mismatched = approved();
  const mismatchResult = validateBenefitPolicy(mismatched, { enabledModes: enabledOrdinaryCustom, catalog: { safeBoxes: ["box"], materials: [{ itemId: "item", unit: "DAY" }] } });
  assert.equal(mismatchResult.valid, false);
  assert.ok(mismatchResult.errors.some((error) => error.includes("unit_mismatch")));
  // SPREAD releases price through a spread delta, so an enabled contract without one cannot publish.
  const noSpread = approved();
  const noSpreadHaff = configuredMode(noSpread.tiers.GOLD, "custom").haff;
  if (isNotPriced(noSpreadHaff)) throw new Error("fixture must be configured");
  delete noSpreadHaff.spreadDelta;
  const noSpreadResult = validateBenefitPolicy(noSpread, { enabledModes: enabledOrdinaryCustom, releaseMode: "SPREAD" });
  assert.equal(noSpreadResult.publishable, false);
  assert.ok(noSpreadResult.warnings.some((warning) => warning.includes("spread_required")));
});

test("multi-mode entitlement caps stay bounded to their tier and keep legacy single contracts readable", () => {
  const approved = () => { const value = policy(); value.status = "APPROVED"; return value; };
  const byMode = approved();
  for (const tier of Object.values(byMode.tiers)) {
    tier.entitlementCap = { byMode: { ordinary: configuredMode(tier, "ordinary"), custom: configuredMode(tier, "custom") } };
  }
  const result = validateBenefitPolicy(byMode, { enabledModes: ["ordinary", "custom"] });
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.publishable, true, JSON.stringify(result));
  const p = policy();
  const friend = { userId: "user_1", kind: "FRIEND" as const, scopeKey: "game:delta", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-12-30T00:00:00.000Z", depositWaived: false, reason: "客服专项服务", requestedBy: "admin_1" };
  const capPolicy = policy();
  capPolicy.tiers.GOLD.entitlementCap = { byMode: { ordinary: configuredMode(capPolicy.tiers.GOLD, "ordinary"), custom: configuredMode(capPolicy.tiers.GOLD, "custom") } };
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: configuredMode(capPolicy.tiers.GOLD, "custom") }, "STANDARD", capPolicy).valid, true);
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: configuredMode(capPolicy.tiers.GOLD, "ordinary") }, "STANDARD", capPolicy).valid, true);
  // A cap more generous than the tier boundary would let FRIEND beat GOLD: rejected, not silently accepted.
  const tooDeep = policy();
  const goldOrdinary = configuredMode(tooDeep.tiers.GOLD, "ordinary");
  const tooDeepCap = JSON.parse(JSON.stringify(goldOrdinary)) as GrowthPricingContract;
  const tooDeepMaterial = tooDeepCap.materials.item!;
  if (tooDeepMaterial.status !== "CONFIGURED") throw new Error("fixture must be configured");
  tooDeepMaterial.buyerUnitAmount = "400"; // GOLD buyer is 500: a cheaper cap is the more generous direction
  tooDeep.tiers.GOLD.entitlementCap = { byMode: { ordinary: tooDeepCap } };
  const deepResult = validateBenefitPolicy(tooDeep, { enabledModes: ["ordinary", "custom"] });
  assert.equal(deepResult.publishable, false);
  assert.ok(deepResult.warnings.some((warning) => warning.includes("below_tier_boundary")));
  // Legacy single-contract caps keep their original single-mode behavior.
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: configuredMode(p.tiers.GOLD, "ordinary") }, "STANDARD", p).valid, true);
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: configuredMode(p.tiers.GOLD, "custom") }, "STANDARD", p).valid, false);
});

test("sealedEnabledRentalModes reads the release authoritative modes and fails closed", () => {
  assert.deepEqual(sealedEnabledRentalModes(compatRule()), ["ordinary", "custom", "fast"]);
  const fastOff = compatRule();
  fastOff.compatibility!.modes.fast = { enabled: false };
  assert.deepEqual(sealedEnabledRentalModes(fastOff), ["ordinary", "custom"]);
  assert.deepEqual(sealedEnabledRentalModes({ schema: "haff-ratio-v1", baseBySafeBox: { "box-a": "50" }, options: {}, spreadDelta: "10", vitalityDeltaByLevel: {}, bearDeltaByLevel: {}, dailyDeltaByTermOption: {} }), ["ordinary"]);
  assert.equal(sealedEnabledRentalModes(null), null);
  assert.equal(sealedEnabledRentalModes({ schema: "haff-ratio-v2" }), null);
  assert.equal(sealedEnabledRentalModes({ schema: "haff-ratio-v2", baseBySafeBox: {}, compatibility: { modes: { ordinary: { enabled: false } } } }), null);
  assert.equal(sealedEnabledRentalModes({ schema: "unknown" }), null);
});

test("R1-01 cap boundary: a cap may be stricter but never more generous than its own tier", () => {
  const approved = () => { const value = policy(); value.status = "APPROVED"; return value; };
  const enabledOrdinaryCustom = ["ordinary", "custom"] as const;
  type GoldTier = GrowthBenefitPolicy["tiers"]["GOLD"];
  const capPolicy = (prepare: (copy: GrowthPricingContract, tierName: "GOLD" | "DIAMOND", mode: "ordinary" | "custom") => void = () => undefined) => {
    const value = approved();
    for (const tierName of ["GOLD", "DIAMOND"] as const) {
      const tier: GoldTier = value.tiers[tierName];
      const byMode: Partial<Record<"ordinary" | "custom", ModePricingContract>> = {};
      for (const mode of ["ordinary", "custom"] as const) {
        const copy = JSON.parse(JSON.stringify(configuredMode(tier, mode))) as GrowthPricingContract;
        prepare(copy, tierName, mode);
        byMode[mode] = copy;
      }
      tier.entitlementCap = { byMode };
    }
    return value;
  };
  const materialOf = (contract: GrowthPricingContract, itemId = "item") => {
    const material = contract.materials[itemId];
    if (!material || material.status === "NOT_PRICED") throw new Error("fixture must be configured");
    return material;
  };
  const haffOf = (contract: GrowthPricingContract) => {
    if (contract.haff.status !== "CONFIGURED") throw new Error("fixture must be configured");
    return contract.haff;
  };
  const result = (value: GrowthBenefitPolicy) => validateBenefitPolicy(value, { enabledModes: enabledOrdinaryCustom });

  assert.equal(result(capPolicy()).publishable, true);
  // Material price: equal passes; a cheaper cap (0.49-like, here 490) is the deeper direction and must fail.
  const deeperMaterial = result(capPolicy((copy) => { materialOf(copy).buyerUnitAmount = String(Number(materialOf(copy).buyerUnitAmount) - 10); }));
  assert.equal(deeperMaterial.publishable, false);
  assert.ok(deeperMaterial.warnings.some((warning) => warning.includes("below_tier_boundary")));
  const stricterMaterial = result(capPolicy((copy) => { materialOf(copy).buyerUnitAmount = String(Number(materialOf(copy).buyerUnitAmount) + 10); }));
  assert.equal(stricterMaterial.publishable, true, JSON.stringify(stricterMaterial));
  // HAFF ratio: raising the cap ratio is cheaper for the buyer and must fail; lowering it stays legal.
  const deeperHaff = result(capPolicy((copy) => { haffOf(copy).baseBySafeBox.box = "600"; }));
  assert.equal(deeperHaff.publishable, false);
  assert.ok(deeperHaff.warnings.some((warning) => warning.includes("below_tier_boundary")));
  const stricterHaff = result(capPolicy((copy) => { haffOf(copy).baseBySafeBox.box = "400"; }));
  assert.equal(stricterHaff.publishable, true, JSON.stringify(stricterHaff));
  // Spread: with the tier at 6, a cap at 8 (tighter) and at 6 (equal) pass; a cap at 5 (cheaper) fails.
  const spread = (value: GrowthPricingContract, delta: string) => { haffOf(value).spreadDelta = delta; };
  const tierSpread6 = (value: GrowthBenefitPolicy) => { for (const tierName of ["GOLD", "DIAMOND"] as const) for (const mode of ["ordinary", "custom"] as const) haffOf(configuredMode(value.tiers[tierName], mode)).spreadDelta = "6"; };
  const equalSpread = approved(); tierSpread6(equalSpread);
  for (const tierName of ["GOLD", "DIAMOND"] as const) equalSpread.tiers[tierName].entitlementCap = { byMode: { ordinary: JSON.parse(JSON.stringify(configuredMode(equalSpread.tiers[tierName], "ordinary"))), custom: JSON.parse(JSON.stringify(configuredMode(equalSpread.tiers[tierName], "custom"))) } };
  assert.equal(result(equalSpread).publishable, true, JSON.stringify(result(equalSpread)));
  const stricterSpread = capPolicy((copy) => spread(copy, "8"));
  tierSpread6(stricterSpread);
  assert.equal(result(stricterSpread).publishable, true, JSON.stringify(result(stricterSpread)));
  const deeperSpread = capPolicy((copy) => spread(copy, "5"));
  tierSpread6(deeperSpread);
  assert.equal(result(deeperSpread).publishable, false);
  assert.ok(result(deeperSpread).warnings.some((warning) => warning.includes("below_tier_boundary")));
  // Legacy single caps: a stricter legacy cap stays publishable, a deeper one is rejected, payload untouched.
  const legacy = approved();
  const legacyCopy = JSON.parse(JSON.stringify(configuredMode(legacy.tiers.GOLD, "ordinary"))) as GrowthPricingContract;
  materialOf(legacyCopy).buyerUnitAmount = String(Number(materialOf(legacyCopy).buyerUnitAmount) + 10);
  legacy.tiers.GOLD.entitlementCap = legacyCopy;
  const legacyBefore = JSON.stringify(legacy.tiers.GOLD.entitlementCap);
  assert.equal(result(legacy).publishable, true, JSON.stringify(result(legacy)));
  assert.equal(JSON.stringify(legacy.tiers.GOLD.entitlementCap), legacyBefore);
  const legacyDeeper = approved();
  const legacyDeeperCopy = JSON.parse(JSON.stringify(configuredMode(legacyDeeper.tiers.GOLD, "ordinary"))) as GrowthPricingContract;
  materialOf(legacyDeeperCopy).buyerUnitAmount = String(Number(materialOf(legacyDeeperCopy).buyerUnitAmount) - 10);
  legacyDeeper.tiers.GOLD.entitlementCap = legacyDeeperCopy;
  assert.equal(result(legacyDeeper).publishable, false);
});

test("R1-06 an enabled slot with a mismatched contract mode is invalid, never publishable", () => {
  const value = policy();
  value.status = "APPROVED";
  configuredMode(value.tiers.STANDARD, "ordinary").mode = "fast" as never;
  const mismatched = validateBenefitPolicy(value, { enabledModes: ["ordinary", "custom"] });
  assert.equal(mismatched.valid, false);
  assert.equal(mismatched.publishable, false);
  // The same policy without the drift keeps the control green.
  const control = policy();
  control.status = "APPROVED";
  assert.equal(validateBenefitPolicy(control, { enabledModes: ["ordinary", "custom"] }).publishable, true);
});

test("total-discount contracts stay draft-only when pending, monotonic per tier, and caps never deepen", () => {
  const discount = (mode: "ordinary" | "custom" | "fast", payableRatio = "0.9") => ({ status: "CONFIGURED" as const, kind: "TOTAL_DISCOUNT" as const, mode, priceVersionId: "price-v1", payableRatio, costBasisRef: "synthetic-cost" });
  const discountPolicy = (): GrowthBenefitPolicy => {
    const value = policy();
    value.status = "DRAFT";
    for (const tier of Object.values(value.tiers)) {
      for (const mode of ["ordinary", "custom", "fast"] as const) tier.pricing[mode] = discount(mode);
      tier.entitlementCap = { byMode: { ordinary: discount("ordinary"), custom: discount("custom") } };
    }
    return value;
  };
  const enabled = ["ordinary", "custom"] as const;
  const result = (value: GrowthBenefitPolicy) => validateBenefitPolicy(value, { enabledModes: enabled });
  const approved = () => { const value = discountPolicy(); value.status = "APPROVED"; return value; };
  assert.equal(result(approved()).publishable, true, JSON.stringify(result(approved())));
  // Ratio and cost basis are pending facts: valid drafts, never publishable.
  const pending = approved();
  for (const tier of Object.values(pending.tiers)) tier.pricing.ordinary = discount("ordinary", "");
  const pendingResult = result(pending);
  assert.equal(pendingResult.valid, true);
  assert.equal(pendingResult.publishable, false);
  assert.ok(pendingResult.warnings.some((warning) => warning.includes("payableRatio.value_pending")));
  // Invalid shares and mode drift are structural errors.
  const invalid = approved();
  for (const tier of Object.values(invalid.tiers)) tier.pricing.ordinary = discount("ordinary", "1.5");
  assert.equal(result(invalid).valid, false);
  const drift = approved();
  const standardOrdinary = drift.tiers.STANDARD.pricing.ordinary!;
  if (!isTotalDiscountContract(standardOrdinary)) throw new Error("fixture must be a discount");
  standardOrdinary.mode = "fast";
  assert.equal(result(drift).valid, false);
  // A higher tier may never pay a larger share of the same base total.
  const inverted = approved();
  for (const mode of enabled) {
    const silver = inverted.tiers.SILVER.pricing[mode]!;
    if (!isTotalDiscountContract(silver)) throw new Error("fixture must be a discount");
    silver.payableRatio = "0.95";
  }
  const invertedResult = result(inverted);
  assert.equal(invertedResult.valid, false);
  assert.ok(invertedResult.errors.some((error) => error.includes("discount_not_monotonic")));
  // Caps: an equal or stricter share passes, a deeper cap and a legacy/discount mix block publish.
  const capPolicy = (prepare: (cap: ReturnType<typeof discount>, tierName: "GOLD" | "DIAMOND", mode: "ordinary" | "custom") => void) => {
    const value = approved();
    for (const tierName of ["GOLD", "DIAMOND"] as const) {
      const byMode: Record<string, ReturnType<typeof discount>> = {};
      for (const mode of enabled) { const cap = discount(mode); prepare(cap, tierName, mode); byMode[mode] = cap; }
      value.tiers[tierName].entitlementCap = { byMode };
    }
    return value;
  };
  assert.equal(result(capPolicy(() => undefined)).publishable, true);
  const stricterCap = result(capPolicy((cap) => { cap.payableRatio = "0.95"; }));
  assert.equal(stricterCap.publishable, true, JSON.stringify(stricterCap));
  const deeperCap = result(capPolicy((cap) => { cap.payableRatio = "0.85"; }));
  assert.equal(deeperCap.publishable, false);
  assert.ok(deeperCap.warnings.some((warning) => warning.includes("below_tier_boundary")));
  const mixedCap = approved();
  mixedCap.tiers.GOLD.entitlementCap = configuredMode(policy().tiers.GOLD, "ordinary");
  const mixedResult = result(mixedCap);
  assert.equal(mixedResult.publishable, false);
  assert.ok(mixedResult.warnings.some((warning) => warning.includes("contract_kind_mismatch")));
  // Manual grant: equal or stricter than the cap passes, a deeper share is beyond policy.
  const grantPolicy = capPolicy(() => undefined);
  grantPolicy.status = "APPROVED";
  const friend = { userId: "user_1", kind: "FRIEND" as const, scopeKey: "game:delta:account-a", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-20T00:00:00.000Z", depositWaived: false, reason: "客服专项服务", requestedBy: "admin_1" };
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: discount("ordinary", "0.9") }, "STANDARD", grantPolicy).valid, true);
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: discount("ordinary", "0.95") }, "STANDARD", grantPolicy).valid, true);
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: discount("ordinary", "0.85") }, "STANDARD", grantPolicy).valid, false);
  const legacyCandidate = configuredMode(policy().tiers.GOLD, "ordinary");
  assert.equal(validateEntitlementCandidate({ ...friend, pricing: legacyCandidate }, "STANDARD", grantPolicy).valid, false);
});

test("entitlement limits are typed, bounded and non-overlapping", () => {
  const p = policy();
  const candidate = { userId: "user_1", kind: "FRIEND" as const, scopeKey: "game:delta:account-a", startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-12-30T00:00:00.000Z", pricing: configuredMode(p.tiers.GOLD, "ordinary"), depositWaived: false, reason: "客服专项服务", requestedBy: "admin_1" };
  const friendValidation = validateEntitlementCandidate(candidate, "STANDARD", p);
  assert.equal(friendValidation.valid, true, JSON.stringify(friendValidation));
  const prestigeValidation = validateEntitlementCandidate({ ...candidate, kind: "PRESTIGE", pricing: configuredMode(p.tiers.DIAMOND, "ordinary") }, "STANDARD", p);
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

test("Q time adapter: next expiry compares numeric instants before mixed three/six-digit formatting", () => {
  const rows = [
    contribution({ sourceKey: "later", effectiveAt: "2026-10-15T00:00:00.123456Z", recordedAt: "2026-10-15T00:00:00.123456Z" }),
    contribution({ sourceKey: "earlier", effectiveAt: "2026-10-15T00:00:00.123Z", recordedAt: "2026-10-15T00:00:00.123Z" }),
  ];
  const input = { userId: "user_1", asOf: "2026-10-16T00:00:00.000Z", contributions: rows };
  const result = replayGrowthProjection(input);
  assert.deepEqual(result.active.map((row) => row.expiresAt), ["2027-01-13T00:00:00.123456Z", "2027-01-13T00:00:00.123Z"]);
  assert.equal(result.nextExpiryAt, "2027-01-13T00:00:00.123Z");
  assert.equal(replayGrowthProjection({ ...input, contributions: [] }).nextExpiryAt, null);
});
