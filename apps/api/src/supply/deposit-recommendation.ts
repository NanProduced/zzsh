import { invalid } from "./supply-util";

export const DEPOSIT_SKIN_TYPES = ["AGENT", "MELEE_TYPE", "FIREARM"] as const;
export type DepositSkinType = typeof DEPOSIT_SKIN_TYPES[number];
export type DepositSkinRule = { ownerKind: DepositSkinType; rarityCode: string | null; firstCents: string | null; subsequentCents: string | null };
export type DepositSkinOverride = { skinId: string; amountCents: string | null };
export type DepositSkinFacts = {
  schema: "deposit-skin-facts-v1";
  gameId: string;
  listingVersionId: string;
  catalogRevision: string;
  skins: Array<{ skinId: string; ownerKind: DepositSkinType; rarityCode: string | null }>;
};
export type DepositRecommendationV2 = {
  schema: "deposit-recommendation-v2";
  algorithm: "delta-deposit-type-rarity-v2";
  version: "2";
  currency: "CNY";
  unit: "cent";
  inputSpec: {
    schema: "deposit-recommendation-input-v2";
    identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"];
    attributeFields: {
      safeBoxCode: "declaration.attributes.safe_box_code";
      vitality: "declaration.attributes.vit_level";
      bear: "declaration.attributes.bear_level";
      dive: "declaration.attributes.dive_level";
      skinIds: "declaration.skins[].skinId";
      skinFacts: "catalog.skinFacts";
    };
    currency: "CNY";
    unit: "cent";
  };
  parameters: {
    safeBoxWeightsByCode: Record<string, string>;
    vitalityAtLeast7Cents: string;
    bearAtLeast7Cents: string;
    diveAtLeast3Cents: string;
    skinRules: DepositSkinRule[];
    skinOverrides: DepositSkinOverride[];
    rounding: { mode: "CEIL"; unitCents: "5000"; zeroFallbackCents: "5000" };
    upperLimitCents: string;
  };
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CENTS = /^(0|[1-9]\d{0,23})$/;

function entry(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} is invalid`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid(`${label} is invalid`);
  return value as Record<string, unknown>;
}
function amount(value: unknown, allowUnconfigured: boolean): string | null {
  if (value === null && allowUnconfigured) return null;
  if (typeof value !== "string" || !CENTS.test(value)) throw invalid("Skin deposit amount is unconfigured or invalid");
  return value;
}

export function parseDepositSkinRules(rulesValue: unknown, overridesValue: unknown, allowUnconfigured: boolean): { skinRules: DepositSkinRule[]; skinOverrides: DepositSkinOverride[] } {
  if (!Array.isArray(rulesValue) || rulesValue.length > 512 || !Array.isArray(overridesValue) || overridesValue.length > 2000) throw invalid("Skin deposit rules are invalid");
  const keys = new Set<string>();
  const skinRules = rulesValue.map(value => {
    const row = entry(value, ["ownerKind", "rarityCode", "firstCents", "subsequentCents"], "Skin deposit rule");
    if (!DEPOSIT_SKIN_TYPES.includes(row.ownerKind as DepositSkinType) || (row.rarityCode !== null && (typeof row.rarityCode !== "string" || !ID.test(row.rarityCode)))) throw invalid("Skin deposit match is invalid");
    const key = JSON.stringify([row.ownerKind, row.rarityCode]);
    if (keys.has(key)) throw invalid("Skin deposit match is duplicated");
    keys.add(key);
    return { ownerKind: row.ownerKind as DepositSkinType, rarityCode: row.rarityCode as string | null, firstCents: amount(row.firstCents, allowUnconfigured), subsequentCents: amount(row.subsequentCents, allowUnconfigured) };
  });
  if (!allowUnconfigured && DEPOSIT_SKIN_TYPES.some(kind => !skinRules.some(row => row.ownerKind === kind && row.rarityCode === null))) throw invalid("Every skin type requires an explicit fallback deposit rule");
  const ids = new Set<string>();
  const skinOverrides = overridesValue.map(value => {
    const row = entry(value, ["skinId", "amountCents"], "Skin deposit override");
    if (typeof row.skinId !== "string" || !ID.test(row.skinId) || ids.has(row.skinId)) throw invalid("Skin deposit override is invalid or duplicated");
    ids.add(row.skinId);
    return { skinId: row.skinId, amountCents: amount(row.amountCents, allowUnconfigured) };
  });
  return { skinRules, skinOverrides };
}

/** The caller supplies one server-read catalog revision for exactly this declaration. */
export function computeSkinDepositV2(parameters: Pick<DepositRecommendationV2["parameters"], "skinRules" | "skinOverrides">, input: { gameId: string; listingVersionId: string; skinIds: readonly string[]; skinFacts?: DepositSkinFacts }): bigint {
  const { skinRules, skinOverrides } = parseDepositSkinRules(parameters.skinRules, parameters.skinOverrides, false);
  const facts = entry(input.skinFacts, ["schema", "gameId", "listingVersionId", "catalogRevision", "skins"], "Deposit skin facts");
  if (facts.schema !== "deposit-skin-facts-v1" || facts.gameId !== input.gameId || facts.listingVersionId !== input.listingVersionId || typeof facts.catalogRevision !== "string" || !/^[1-9]\d{0,19}$/.test(facts.catalogRevision) || !Array.isArray(facts.skins) || facts.skins.length !== input.skinIds.length) throw invalid("Deposit skin facts do not match this declaration");
  const ids = new Set(input.skinIds);
  if (ids.size !== input.skinIds.length || [...ids].some(id => typeof id !== "string" || !ID.test(id))) throw invalid("Deposit skin identities are invalid or duplicated");
  const overrides = new Map(skinOverrides.map(row => [row.skinId, row.amountCents!]));
  const counts = new Map<DepositSkinRule, number>();
  let total = 0n;
  for (const value of facts.skins) {
    const skin = entry(value, ["skinId", "ownerKind", "rarityCode"], "Deposit skin fact");
    if (typeof skin.skinId !== "string" || !ids.delete(skin.skinId) || !DEPOSIT_SKIN_TYPES.includes(skin.ownerKind as DepositSkinType) || (skin.rarityCode !== null && (typeof skin.rarityCode !== "string" || !ID.test(skin.rarityCode)))) throw invalid("Deposit skin fact is unavailable or duplicated");
    const override = overrides.get(skin.skinId);
    if (override !== undefined) { total += BigInt(override); continue; }
    const rule = skinRules.find(row => row.ownerKind === skin.ownerKind && row.rarityCode === skin.rarityCode)
      ?? skinRules.find(row => row.ownerKind === skin.ownerKind && row.rarityCode === null);
    if (!rule) throw invalid("Skin deposit rule is unavailable");
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  for (const [rule, count] of counts) total += BigInt(rule.firstCents!) + BigInt(count - 1) * BigInt(rule.subsequentCents!);
  return total;
}
