export const fundingPolicyFixture = (mode: "NOT_REQUIRED" | "FIXED_CENTS") => ({
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

/** Test-only gate evidence for a draft actually bound to this synthetic account. */
export async function syntheticPublicationCreditGate(client: import("pg").PoolClient, accountId: string, gate: import("../src/supply/publishing").SupplyGate): Promise<import("../src/supply/publishing").SupplyGate> {
  if (gate.creditGuarantee || !gate.reference || !["NOT_REQUIRED", "SATISFIED"].includes(gate.publisherBail)) return gate;
  const row = (await client.query<{ owner: string; game: string; version: string; state: string; release: string; price: string | null }>(`
    SELECT a.owner_user_id AS owner,a.game_id AS game,v.id AS version,v.review_state AS state,v.rule_release_id AS release,
      v.payload#>>'{ruleRefs,priceVersionId}' AS price FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id WHERE a.id=$1`, [accountId])).rows[0];
  if (!row || !["DRAFT", "SUBMITTED"].includes(row.state) || !row.release || !row.price) return gate;
  return { ...gate, creditGuarantee: { status: gate.publisherBail as "NOT_REQUIRED" | "SATISFIED", accountId,
    ownerUserId: row.owner, gameId: row.game, listingVersionId: row.version, releaseId: row.release, priceVersionId: row.price,
    creditRevision: "1", coverageRevision: gate.publisherBail === "SATISFIED" ? "synthetic" : null,
    requiredCents: gate.publisherBail === "NOT_REQUIRED" ? "0" : "1", reference: gate.reference } };
}
