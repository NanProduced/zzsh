import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDepositRecommendation, validateFundingPolicy, validateFundingPolicyDraft, type DepositRecommendationInput } from "../src/supply/funding-policy";
import { computeSkinDepositV2, type DepositRecommendationV2, type DepositSkinFacts } from "../src/supply/deposit-recommendation";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

// Synthetic amounts only: these are not proposed platform rates.
function policyFixture() {
  const v1 = fundingPolicyFixture("NOT_REQUIRED");
  const { skinWeights: _weights, skinGroupById: _groups, ...parameters } = v1.recommendation.parameters;
  const recommendation: DepositRecommendationV2 = {
    schema: "deposit-recommendation-v2", algorithm: "delta-deposit-type-rarity-v2", version: "2", currency: "CNY", unit: "cent",
    inputSpec: { schema: "deposit-recommendation-input-v2", identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"], attributeFields: { safeBoxCode: "declaration.attributes.safe_box_code", vitality: "declaration.attributes.vit_level", bear: "declaration.attributes.bear_level", dive: "declaration.attributes.dive_level", skinIds: "declaration.skins[].skinId", skinFacts: "catalog.skinFacts" }, currency: "CNY", unit: "cent" },
    parameters: { ...parameters, rounding: { mode: "CEIL", unitCents: "5000", zeroFallbackCents: "5000" },
      skinRules: [
        { ownerKind: "AGENT", rarityCode: null, firstCents: "100", subsequentCents: "50" },
        { ownerKind: "FIREARM", rarityCode: null, firstCents: "500", subsequentCents: "30" },
        { ownerKind: "MELEE_TYPE", rarityCode: null, firstCents: "1000", subsequentCents: "300" },
        { ownerKind: "AGENT", rarityCode: "q_fixture", firstCents: "5000", subsequentCents: "1200" },
      ], skinOverrides: [{ skinId: "a_override", amountCents: "700" }],
    },
  };
  return { ...v1, policyVersion: "synthetic-v2", recommendation };
}
function inputFixture(skins: DepositSkinFacts["skins"] = []): DepositRecommendationInput & { skinFacts: DepositSkinFacts } {
  return { accountId: "account_fixture", gameId: "game_fixture", listingVersionId: "listing_fixture", priceVersionId: "price_fixture", ruleReleaseId: "release_fixture", safeBoxCode: "basic", vitality: 6, bear: 6, dive: 2, skinIds: skins.map(skin => skin.skinId), skinFacts: { schema: "deposit-skin-facts-v1", gameId: "game_fixture", listingVersionId: "listing_fixture", catalogRevision: "1235", skins } };
}

test("v2 matches override, exact type/rarity and explicit type fallback without order dependence", () => {
  const p = policyFixture(), input = inputFixture([
    { skinId: "a1", ownerKind: "AGENT", rarityCode: "q_fixture" },
    { skinId: "a2", ownerKind: "AGENT", rarityCode: "q_fixture" },
    { skinId: "a_override", ownerKind: "AGENT", rarityCode: "q_fixture" },
    { skinId: "a_unknown", ownerKind: "AGENT", rarityCode: null },
    { skinId: "a_unlisted_quality", ownerKind: "AGENT", rarityCode: "another_quality" },
    { skinId: "f1", ownerKind: "FIREARM", rarityCode: "q_fixture" },
    { skinId: "m1", ownerKind: "MELEE_TYPE", rarityCode: null },
  ]);
  assert.equal(computeSkinDepositV2(p.recommendation.parameters, input), 8550n);
  assert.equal(computeSkinDepositV2(p.recommendation.parameters, { ...input, skinFacts: { ...input.skinFacts, skins: [...input.skinFacts.skins].reverse() } }), 8550n);
  assert.equal(computeDepositRecommendation(validateFundingPolicy(p), input), "10000");
  assert.equal(computeDepositRecommendation(validateFundingPolicy(p), inputFixture([{ skinId: "a_override", ownerKind: "AGENT", rarityCode: "q_fixture" }])), "5000", "override never also consumes the first group slot");
});

test("v2 draft null is saved as unconfigured while explicit zero is calculable", () => {
  const p = policyFixture(); p.recommendation.parameters.skinRules[0]!.firstCents = null;
  assert.equal((validateFundingPolicyDraft(p).recommendation as DepositRecommendationV2).parameters.skinRules[0]!.firstCents, null);
  assert.throws(() => validateFundingPolicy(p), /unconfigured/);
  assert.throws(() => computeDepositRecommendation(validateFundingPolicyDraft(p), inputFixture()), /unconfigured/);
  p.recommendation.parameters.skinRules[0]!.firstCents = "0";
  p.recommendation.parameters.skinRules[0]!.subsequentCents = "0";
  p.recommendation.parameters.skinOverrides[0]!.amountCents = "0";
  p.recommendation.parameters.safeBoxWeightsByCode.basic = "0";
  assert.equal(computeSkinDepositV2(p.recommendation.parameters, inputFixture([{ skinId: "a_override", ownerKind: "AGENT", rarityCode: null }])), 0n);
  assert.equal(computeDepositRecommendation(validateFundingPolicy(p), inputFixture([{ skinId: "a_override", ownerKind: "AGENT", rarityCode: null }])), "5000", "existing total-zero fallback remains unchanged");
});

test("v2 incomplete type coverage, duplicate rules, ambiguous or invalid money fail closed", () => {
  const missing = policyFixture(); missing.recommendation.parameters.skinRules = missing.recommendation.parameters.skinRules.filter(row => row.ownerKind !== "MELEE_TYPE");
  assert.doesNotThrow(() => validateFundingPolicyDraft(missing));
  assert.throws(() => validateFundingPolicy(missing), /fallback/);
  for (const change of [
    (p: ReturnType<typeof policyFixture>) => p.recommendation.parameters.skinRules.push({ ...p.recommendation.parameters.skinRules[0]! }),
    (p: ReturnType<typeof policyFixture>) => p.recommendation.parameters.skinOverrides.push({ ...p.recommendation.parameters.skinOverrides[0]! }),
    (p: ReturnType<typeof policyFixture>) => { p.recommendation.parameters.skinRules[0]!.firstCents = "01"; },
    (p: ReturnType<typeof policyFixture>) => { p.recommendation.parameters.skinRules[0]!.firstCents = "1.0"; },
    (p: ReturnType<typeof policyFixture>) => { (p.recommendation.parameters as unknown as Record<string, unknown>).skinGroupById = {}; },
    (p: ReturnType<typeof policyFixture>) => { (p.recommendation.parameters.skinRules[0] as unknown as Record<string, unknown>).collectibleMultiplier = "2"; },
  ]) { const p = policyFixture(); change(p); assert.throws(() => validateFundingPolicyDraft(p)); }
});

test("v2 facts bind game, declaration version and exactly the selected identities", () => {
  const p = validateFundingPolicy(policyFixture());
  const input = inputFixture([{ skinId: "a1", ownerKind: "AGENT", rarityCode: null }]);
  for (const change of [
    (i: ReturnType<typeof inputFixture>) => { delete (i as DepositRecommendationInput).skinFacts; },
    (i: ReturnType<typeof inputFixture>) => { i.skinFacts.gameId = "other_game"; },
    (i: ReturnType<typeof inputFixture>) => { i.skinFacts.listingVersionId = "other_listing"; },
    (i: ReturnType<typeof inputFixture>) => { i.skinFacts.catalogRevision = "0"; },
    (i: ReturnType<typeof inputFixture>) => { i.skinFacts.skins = []; },
    (i: ReturnType<typeof inputFixture>) => { i.skinFacts.skins[0]!.skinId = "other_skin"; },
    (i: ReturnType<typeof inputFixture>) => { (i.skinFacts.skins[0] as unknown as Record<string, unknown>).ownerKind = null; },
    (i: ReturnType<typeof inputFixture>) => { delete (i.skinFacts.skins[0] as unknown as Record<string, unknown>).rarityCode; },
    (i: ReturnType<typeof inputFixture>) => { i.skinIds = ["a1", "a1"]; i.skinFacts.skins.push({ ...i.skinFacts.skins[0]! }); },
  ]) { const i = structuredClone(input); change(i); assert.throws(() => computeDepositRecommendation(p, i)); }
  assert.equal(computeDepositRecommendation(p, inputFixture()), "5000");
});

test("v1 frozen policy replay and non-skin recommendation rules remain unchanged", () => {
  const legacy = validateFundingPolicy(fundingPolicyFixture("NOT_REQUIRED"));
  const v2 = validateFundingPolicy(policyFixture());
  assert.deepEqual(legacy.ownerDepositRules, v2.ownerDepositRules);
  assert.deepEqual(legacy.guaranteeRequirement, v2.guaranteeRequirement);
  assert.equal(computeDepositRecommendation(legacy, { ...inputFixture(), skinIds: ["skin"], skinFacts: undefined }), "5000");
  assert.throws(() => computeDepositRecommendation(legacy, { ...inputFixture(), skinIds: ["new_skin"] }), /mapping/);
  const p = policyFixture(); p.recommendation.parameters.upperLimitCents = "30000"; p.ownerDepositRules.capCents = "30000";
  p.recommendation.parameters.vitalityAtLeast7Cents = "999999999999999999999999";
  assert.equal(computeDepositRecommendation(validateFundingPolicy(p), { ...inputFixture(), vitality: 7 }), "30000", "BigInt, ceiling and shared cap are retained");
  assert.throws(() => computeDepositRecommendation(v2, { ...inputFixture(), vitality: null }), /unavailable/);
});
