import { invalid } from "./supply-util";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CENTS = /^(0|[1-9]\d{0,23})$/;
const POSITIVE = /^[1-9]\d{0,23}$/;

export const DEPOSIT_RECOMMENDATION_GROUPS = ["LEGACY_GOLD", "LEGACY_AGENT", "LEGACY_KNIFE", "LEGACY_WEAPON", "NONE"] as const;
type RecommendationGroup = typeof DEPOSIT_RECOMMENDATION_GROUPS[number];

export type FundingPolicy = {
  schema: "funding-policy-v1";
  policyVersion: string;
  recommendation: {
    schema: "deposit-recommendation-v1";
    algorithm: "delta-deposit-owner-declared-v1";
    version: "1";
    currency: "CNY";
    unit: "cent";
    inputSpec: {
      schema: "deposit-recommendation-input-v1";
      identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"];
      attributeFields: {
        safeBoxCode: "declaration.attributes.safe_box_code";
        vitality: "declaration.attributes.vit_level";
        bear: "declaration.attributes.bear_level";
        dive: "declaration.attributes.dive_level";
        skinIds: "declaration.skins[].skinId";
      };
      currency: "CNY";
      unit: "cent";
    };
    parameters: {
      safeBoxWeightsByCode: Record<string, string>;
      vitalityAtLeast7Cents: string;
      bearAtLeast7Cents: string;
      diveAtLeast3Cents: string;
      skinGroupById: Record<string, RecommendationGroup>;
      skinWeights: Record<Exclude<RecommendationGroup, "NONE">, { firstCents: string; subsequentCents: string }>;
      rounding: { mode: "CEIL"; unitCents: "5000"; zeroFallbackCents: "5000" };
      upperLimitCents: string;
    };
  };
  ownerDepositRules: {
    schema: "owner-deposit-rule-v1";
    currency: "CNY";
    unit: "cent";
    normal: { minCents: "1"; zeroAllowed: false };
    fullPayoutSelected: { minCents: "30000"; zeroAllowed: false };
    capCents: string;
  };
  guaranteeRequirement: {
    schema: "account-guarantee-requirement-v1";
    version: "1";
    scope: "GAME_ACCOUNT";
    currency: "CNY";
    unit: "cent";
    mode: "FIXED_CENTS" | "NOT_REQUIRED";
    requiredCents: string;
  };
  proofValidity: { schema: "guarantee-proof-validity-v1"; satisfiedMode: "FIXED_DAYS"; satisfiedDays: string };
  vipWaiver: boolean;
  svipWaiver: boolean;
  fullPayoutPolicyRef: string;
  fullPayoutPolicyVersion: string;
  disclosureVersion: string;
};

export type OwnerDepositDeclaration = {
  schema: "owner-deposit-declaration-v1";
  amountCents: string;
  declarationVersion: string;
};

export type DepositRecommendationInput = {
  accountId: string;
  gameId: string;
  listingVersionId: string;
  priceVersionId: string;
  ruleReleaseId: string;
  safeBoxCode: string | null;
  vitality: number | null;
  bear: number | null;
  dive: number | null;
  skinIds: readonly string[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid(`${label} has unsupported fields`);
  return result;
}

function text(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !pattern.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function cents(value: unknown, label: string, positive = false): string {
  const pattern = positive ? POSITIVE : CENTS;
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${label} is invalid`);
  return BigInt(value).toString();
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label} is invalid`);
  return value;
}

function mapOfCents(value: unknown, label: string): Record<string, string> {
  const source = object(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!ID.test(key)) throw invalid(`${label} is invalid`);
    result[key] = cents(entry, label);
  }
  if (Object.keys(result).length === 0) throw invalid(`${label} is empty`);
  return result;
}

function parseSkinGroups(value: unknown): Record<string, RecommendationGroup> {
  const source = object(value, "skinGroupById");
  const result: Record<string, RecommendationGroup> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!ID.test(key) || typeof entry !== "string" || !DEPOSIT_RECOMMENDATION_GROUPS.includes(entry as RecommendationGroup)) throw invalid("skinGroupById is invalid");
    result[key] = entry as RecommendationGroup;
  }
  return result;
}

function parseSkinWeights(value: unknown): Record<Exclude<RecommendationGroup, "NONE">, { firstCents: string; subsequentCents: string }> {
  const source = exact(value, DEPOSIT_RECOMMENDATION_GROUPS.filter((group) => group !== "NONE"), "skinWeights");
  const result = {} as Record<Exclude<RecommendationGroup, "NONE">, { firstCents: string; subsequentCents: string }>;
  for (const group of DEPOSIT_RECOMMENDATION_GROUPS.filter((item) => item !== "NONE") as Exclude<RecommendationGroup, "NONE">[]) {
    const entry = exact(source[group], ["firstCents", "subsequentCents"], `skinWeights.${group}`);
    result[group] = { firstCents: cents(entry.firstCents, `skinWeights.${group}.firstCents`), subsequentCents: cents(entry.subsequentCents, `skinWeights.${group}.subsequentCents`) };
  }
  return result;
}

export function validateFundingPolicy(value: unknown): FundingPolicy {
  const root = exact(value, ["schema", "policyVersion", "recommendation", "ownerDepositRules", "guaranteeRequirement", "proofValidity", "vipWaiver", "svipWaiver", "fullPayoutPolicyRef", "fullPayoutPolicyVersion", "disclosureVersion"], "fundingPolicy");
  if (root.schema !== "funding-policy-v1") throw invalid("Funding policy schema is unsupported");
  const recommendation = exact(root.recommendation, ["schema", "algorithm", "version", "currency", "unit", "inputSpec", "parameters"], "recommendation");
  if (recommendation.schema !== "deposit-recommendation-v1" || recommendation.algorithm !== "delta-deposit-owner-declared-v1" || recommendation.version !== "1" || recommendation.currency !== "CNY" || recommendation.unit !== "cent") throw invalid("Funding recommendation is invalid");
  const inputSpec = exact(recommendation.inputSpec, ["schema", "identityFields", "attributeFields", "currency", "unit"], "recommendation.inputSpec");
  if (inputSpec.schema !== "deposit-recommendation-input-v1" || inputSpec.currency !== "CNY" || inputSpec.unit !== "cent") throw invalid("Funding input specification is invalid");
  if (JSON.stringify(inputSpec.identityFields) !== JSON.stringify(["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"])) throw invalid("Funding identity fields are invalid");
  const attributeFields = exact(inputSpec.attributeFields, ["safeBoxCode", "vitality", "bear", "dive", "skinIds"], "recommendation.inputSpec.attributeFields");
  if (attributeFields.safeBoxCode !== "declaration.attributes.safe_box_code" || attributeFields.vitality !== "declaration.attributes.vit_level" || attributeFields.bear !== "declaration.attributes.bear_level" || attributeFields.dive !== "declaration.attributes.dive_level" || attributeFields.skinIds !== "declaration.skins[].skinId") throw invalid("Funding attribute fields are invalid");
  const parameters = exact(recommendation.parameters, ["safeBoxWeightsByCode", "vitalityAtLeast7Cents", "bearAtLeast7Cents", "diveAtLeast3Cents", "skinGroupById", "skinWeights", "rounding", "upperLimitCents"], "recommendation.parameters");
  const rounding = exact(parameters.rounding, ["mode", "unitCents", "zeroFallbackCents"], "recommendation.parameters.rounding");
  if (rounding.mode !== "CEIL" || rounding.unitCents !== "5000" || rounding.zeroFallbackCents !== "5000") throw invalid("Funding rounding is invalid");
  const parsedParameters = {
    safeBoxWeightsByCode: mapOfCents(parameters.safeBoxWeightsByCode, "safeBoxWeightsByCode"),
    vitalityAtLeast7Cents: cents(parameters.vitalityAtLeast7Cents, "vitalityAtLeast7Cents"),
    bearAtLeast7Cents: cents(parameters.bearAtLeast7Cents, "bearAtLeast7Cents"),
    diveAtLeast3Cents: cents(parameters.diveAtLeast3Cents, "diveAtLeast3Cents"),
    skinGroupById: parseSkinGroups(parameters.skinGroupById),
    skinWeights: parseSkinWeights(parameters.skinWeights),
    rounding: { mode: "CEIL" as const, unitCents: "5000" as const, zeroFallbackCents: "5000" as const },
    upperLimitCents: cents(parameters.upperLimitCents, "upperLimitCents", true),
  };
  const owner = exact(root.ownerDepositRules, ["schema", "currency", "unit", "normal", "fullPayoutSelected", "capCents"], "ownerDepositRules");
  if (owner.schema !== "owner-deposit-rule-v1" || owner.currency !== "CNY" || owner.unit !== "cent") throw invalid("Owner deposit rules are invalid");
  const normal = exact(owner.normal, ["minCents", "zeroAllowed"], "ownerDepositRules.normal");
  const full = exact(owner.fullPayoutSelected, ["minCents", "zeroAllowed"], "ownerDepositRules.fullPayoutSelected");
  if (normal.minCents !== "1" || normal.zeroAllowed !== false || full.minCents !== "30000" || full.zeroAllowed !== false) throw invalid("Owner deposit minimum rules are invalid");
  const capCents = cents(owner.capCents, "ownerDepositRules.capCents", true);
  if (BigInt(capCents) < 30000n || capCents !== parsedParameters.upperLimitCents) throw invalid("Owner deposit cap does not match recommendation cap");
  const guarantee = exact(root.guaranteeRequirement, ["schema", "version", "scope", "currency", "unit", "mode", "requiredCents"], "guaranteeRequirement");
  const guaranteeMode = guarantee.mode;
  if (guarantee.schema !== "account-guarantee-requirement-v1" || guarantee.version !== "1" || guarantee.scope !== "GAME_ACCOUNT" || guarantee.currency !== "CNY" || guarantee.unit !== "cent" || typeof guaranteeMode !== "string" || !["FIXED_CENTS", "NOT_REQUIRED"].includes(guaranteeMode)) throw invalid("Guarantee requirement is invalid");
  const requiredCents = cents(guarantee.requiredCents, "guaranteeRequirement.requiredCents");
  if (guaranteeMode === "FIXED_CENTS" && requiredCents === "0") throw invalid("Fixed guarantee requirement must be positive");
  if (guaranteeMode === "NOT_REQUIRED" && requiredCents !== "0") throw invalid("NOT_REQUIRED guarantee must be zero");
  const proofValidity = exact(root.proofValidity, ["schema", "satisfiedMode", "satisfiedDays"], "proofValidity");
  if (proofValidity.schema !== "guarantee-proof-validity-v1" || proofValidity.satisfiedMode !== "FIXED_DAYS") throw invalid("Proof validity is invalid");
  const satisfiedDays = cents(proofValidity.satisfiedDays, "proofValidity.satisfiedDays", true);
  return {
    schema: "funding-policy-v1",
    policyVersion: text(root.policyVersion, "policyVersion"),
    recommendation: {
      schema: "deposit-recommendation-v1", algorithm: "delta-deposit-owner-declared-v1", version: "1", currency: "CNY", unit: "cent",
      inputSpec: { schema: "deposit-recommendation-input-v1", identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"], attributeFields: { safeBoxCode: "declaration.attributes.safe_box_code", vitality: "declaration.attributes.vit_level", bear: "declaration.attributes.bear_level", dive: "declaration.attributes.dive_level", skinIds: "declaration.skins[].skinId" }, currency: "CNY", unit: "cent" },
      parameters: parsedParameters,
    },
    ownerDepositRules: { schema: "owner-deposit-rule-v1", currency: "CNY", unit: "cent", normal: { minCents: "1", zeroAllowed: false }, fullPayoutSelected: { minCents: "30000", zeroAllowed: false }, capCents },
    guaranteeRequirement: { schema: "account-guarantee-requirement-v1", version: "1", scope: "GAME_ACCOUNT", currency: "CNY", unit: "cent", mode: guaranteeMode as "FIXED_CENTS" | "NOT_REQUIRED", requiredCents },
    proofValidity: { schema: "guarantee-proof-validity-v1", satisfiedMode: "FIXED_DAYS", satisfiedDays },
    vipWaiver: bool(root.vipWaiver, "vipWaiver"), svipWaiver: bool(root.svipWaiver, "svipWaiver"),
    fullPayoutPolicyRef: text(root.fullPayoutPolicyRef, "fullPayoutPolicyRef"), fullPayoutPolicyVersion: text(root.fullPayoutPolicyVersion, "fullPayoutPolicyVersion"), disclosureVersion: text(root.disclosureVersion, "disclosureVersion"),
  };
}

export function validateOwnerDepositDeclaration(value: unknown): OwnerDepositDeclaration | null {
  if (value === undefined || value === null) return null;
  const entry = exact(value, ["schema", "amountCents", "declarationVersion"], "ownerDepositDeclaration");
  if (entry.schema !== "owner-deposit-declaration-v1") throw invalid("Owner deposit declaration schema is invalid");
  return { schema: "owner-deposit-declaration-v1", amountCents: cents(entry.amountCents, "ownerDepositDeclaration.amountCents"), declarationVersion: text(entry.declarationVersion, "ownerDepositDeclaration.declarationVersion") };
}

export function validateOwnerDepositAmount(policy: FundingPolicy, amountCents: string, fullPayoutSelected: boolean): void {
  const amount = BigInt(amountCents);
  const minimum = BigInt(fullPayoutSelected ? policy.ownerDepositRules.fullPayoutSelected.minCents : policy.ownerDepositRules.normal.minCents);
  if (amount < minimum || amount > BigInt(policy.ownerDepositRules.capCents)) throw invalid("Owner deposit declaration is outside the current policy");
}

export function computeDepositRecommendation(policy: FundingPolicy, input: DepositRecommendationInput): string {
  const p = policy.recommendation.parameters;
  if (![input.accountId, input.gameId, input.listingVersionId, input.priceVersionId, input.ruleReleaseId].every((value) => ID.test(value))) throw invalid("Deposit recommendation identity is invalid");
  const safeBoxWeight = input.safeBoxCode ? p.safeBoxWeightsByCode[input.safeBoxCode] : undefined;
  if (!input.safeBoxCode || safeBoxWeight === undefined || input.vitality === null || input.bear === null || input.dive === null || !Number.isSafeInteger(input.vitality) || !Number.isSafeInteger(input.bear) || !Number.isSafeInteger(input.dive)) throw invalid("Deposit recommendation inputs are unavailable");
  let total = BigInt(safeBoxWeight);
  if (input.vitality >= 7) total += BigInt(p.vitalityAtLeast7Cents);
  if (input.bear >= 7) total += BigInt(p.bearAtLeast7Cents);
  if (input.dive >= 3) total += BigInt(p.diveAtLeast3Cents);
  const counts = new Map<Exclude<RecommendationGroup, "NONE">, number>();
  for (const skinId of input.skinIds) {
    const group = p.skinGroupById[skinId];
    if (group === undefined) throw invalid("Deposit recommendation skin mapping is unavailable");
    if (group === "NONE") continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  for (const [group, count] of counts) {
    const weights = p.skinWeights[group];
    total += BigInt(weights.firstCents) + BigInt(Math.max(0, count - 1)) * BigInt(weights.subsequentCents);
  }
  const unit = 5000n;
  const rounded = total === 0n ? 5000n : ((total + unit - 1n) / unit) * unit;
  const capped = rounded > BigInt(p.upperLimitCents) ? BigInt(p.upperLimitCents) : rounded;
  return capped.toString();
}
