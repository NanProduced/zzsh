import assert from "node:assert/strict";
import test from "node:test";

import { readFormalSupplyGate } from "../src/supply/funding-authority";

const policy = (mode: "NOT_REQUIRED" | "FIXED_CENTS") => ({
  schema: "funding-policy-v1",
  policyVersion: "g0-policy-v1",
  recommendation: {
    schema: "deposit-recommendation-v1",
    algorithm: "delta-deposit-owner-declared-v1",
    version: "1",
    currency: "CNY",
    unit: "cent",
    inputSpec: {
      schema: "deposit-recommendation-input-v1",
      identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"],
      attributeFields: {
        safeBoxCode: "declaration.attributes.safe_box_code",
        vitality: "declaration.attributes.vit_level",
        bear: "declaration.attributes.bear_level",
        dive: "declaration.attributes.dive_level",
        skinIds: "declaration.skins[].skinId",
      },
      currency: "CNY",
      unit: "cent",
    },
    parameters: {
      safeBoxWeightsByCode: { basic: "1" },
      vitalityAtLeast7Cents: "0",
      bearAtLeast7Cents: "0",
      diveAtLeast3Cents: "0",
      skinGroupById: { skin: "NONE" },
      skinWeights: {
        LEGACY_GOLD: { firstCents: "0", subsequentCents: "0" },
        LEGACY_AGENT: { firstCents: "0", subsequentCents: "0" },
        LEGACY_KNIFE: { firstCents: "0", subsequentCents: "0" },
        LEGACY_WEAPON: { firstCents: "0", subsequentCents: "0" },
      },
      rounding: { mode: "CEIL", unitCents: "5000", zeroFallbackCents: "5000" },
      upperLimitCents: "100000",
    },
  },
  ownerDepositRules: {
    schema: "owner-deposit-rule-v1",
    currency: "CNY",
    unit: "cent",
    normal: { minCents: "1", zeroAllowed: false },
    fullPayoutSelected: { minCents: "30000", zeroAllowed: false },
    capCents: "100000",
  },
  guaranteeRequirement: {
    schema: "account-guarantee-requirement-v1",
    version: "1",
    scope: "GAME_ACCOUNT",
    currency: "CNY",
    unit: "cent",
    mode,
    requiredCents: mode === "NOT_REQUIRED" ? "0" : "3000",
  },
  proofValidity: { schema: "guarantee-proof-validity-v1", satisfiedMode: "FIXED_DAYS", satisfiedDays: "7" },
  vipWaiver: true,
  svipWaiver: true,
  fullPayoutPolicyRef: "g0-full-payout",
  fullPayoutPolicyVersion: "1",
  disclosureVersion: "g0-disclosure",
});

function clientFor(value: unknown, proofRows: unknown[] = []) {
  return {
    query: async (sql: string) => {
      if (sql.includes("account_guarantee_proof")) return { rows: proofRows };
      if (sql.includes("zzsh_credit.user_credit_state")) return { rows: [{ score: 100, revision: "1" }] };
      if (sql.includes("SELECT a.id AS \"accountId\"")) return { rows: [{ accountId: "account-1", ownerUserId: "user-1", gameId: "game-1", currentVersionId: null, versionId: null, priceVersionId: "price-1", releaseId: "release-1", policy: value, policyStatus: "SEALED", priceStatus: "SEALED", payload: null }] };
      if (sql.includes("owner_guarantee_requirement")) return { rows: [] };
      return { rows: [{ priceVersionId: "price-1", policy: value, status: "SEALED", gameId: "game-1", releaseId: "release-1" }] };
    },
  } as never;
}

test("G0 derives a stable policy reference for valid NOT_REQUIRED without a proof row", async () => {
  const gate = await readFormalSupplyGate(clientFor(policy("NOT_REQUIRED")), { id: "account-1", owner_user_id: "user-1" } as never);
  assert.deepEqual(gate, { publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "policy:price-1:g0-policy-v1:NOT_REQUIRED" });
});

test("G0 keeps positive requirements and invalid policies fail closed", async () => {
  const fixed = await readFormalSupplyGate(clientFor(policy("FIXED_CENTS")), { id: "account-1", owner_user_id: "user-1" } as never);
  assert.deepEqual(fixed, { publisherBail: "UNKNOWN", occupancy: "UNKNOWN", reference: null });
  const invalidPolicy = { ...policy("NOT_REQUIRED"), guaranteeRequirement: { ...policy("NOT_REQUIRED").guaranteeRequirement, requiredCents: "1" } };
  const invalidGate = await readFormalSupplyGate(clientFor(invalidPolicy), { id: "account-1", owner_user_id: "user-1" } as never);
  assert.deepEqual(invalidGate, { publisherBail: "UNKNOWN", occupancy: "UNKNOWN", reference: null });
});
