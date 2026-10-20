import type { FundingPolicy, PriceVersionRecord, RulesResponse, SkinDepositRecommendation, SkinDepositRule } from "../../api";

export const SKIN_DEPOSIT_TYPES = { AGENT: "干员", MELEE_TYPE: "近战外观", FIREARM: "枪械" };
export type SkinDepositDraft = {
  policyVersion: string;
  rules: Array<{ ownerKind: SkinDepositRule["ownerKind"]; rarityCode: string | null; first: string; subsequent: string }>;
  overrides: Array<{ skinId: string; amount: string }>;
};
export function depositCentsToYuan(value: string | null): string {
  if (value === null) return "";
  const n = BigInt(value); return `${n / 100n}${n % 100n ? `.${(n % 100n).toString().padStart(2, "0").replace(/0$/, "")}` : ""}`;
}
export function depositYuanToCents(value: string): string | null {
  if (!value.trim()) return null;
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value.trim())) throw new Error("加价金额须为非负数，最多两位小数；留空表示待配置。");
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = BigInt(`${whole}${fraction.padEnd(2, "0")}`).toString();
  if (cents.length > 24) throw new Error("加价金额超出可用范围。");
  return cents;
}
export function skinDepositDraft(policy: FundingPolicy): SkinDepositDraft {
  const r = policy.recommendation;
  return r.schema === "deposit-recommendation-v2" ? {
    policyVersion: policy.policyVersion,
    rules: r.parameters.skinRules.map(row => ({ ownerKind: row.ownerKind, rarityCode: row.rarityCode, first: depositCentsToYuan(row.firstCents), subsequent: depositCentsToYuan(row.subsequentCents) })),
    overrides: r.parameters.skinOverrides.map(row => ({ skinId: row.skinId, amount: depositCentsToYuan(row.amountCents) })),
  } : {
    policyVersion: "", rules: (Object.keys(SKIN_DEPOSIT_TYPES) as SkinDepositRule["ownerKind"][]).map(ownerKind => ({ ownerKind, rarityCode: null, first: "", subsequent: "" })), overrides: [],
  };
}
export function buildSkinDepositPolicy(base: FundingPolicy, draft: SkinDepositDraft): FundingPolicy & { recommendation: SkinDepositRecommendation } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(draft.policyVersion)) throw new Error("请填写本次资金政策版本标识。");
  const p = base.recommendation.parameters;
  return { ...structuredClone(base), policyVersion: draft.policyVersion, recommendation: {
    schema: "deposit-recommendation-v2", algorithm: "delta-deposit-type-rarity-v2", version: "2", currency: "CNY", unit: "cent",
    inputSpec: { schema: "deposit-recommendation-input-v2", identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"], attributeFields: { safeBoxCode: "declaration.attributes.safe_box_code", vitality: "declaration.attributes.vit_level", bear: "declaration.attributes.bear_level", dive: "declaration.attributes.dive_level", skinIds: "declaration.skins[].skinId", skinFacts: "catalog.skinFacts" }, currency: "CNY", unit: "cent" },
    parameters: { safeBoxWeightsByCode: structuredClone(p.safeBoxWeightsByCode), vitalityAtLeast7Cents: p.vitalityAtLeast7Cents, bearAtLeast7Cents: p.bearAtLeast7Cents, diveAtLeast3Cents: p.diveAtLeast3Cents,
      skinRules: draft.rules.map(row => ({ ownerKind: row.ownerKind, rarityCode: row.rarityCode, firstCents: depositYuanToCents(row.first), subsequentCents: depositYuanToCents(row.subsequent) })),
      skinOverrides: draft.overrides.map(row => ({ skinId: row.skinId, amountCents: depositYuanToCents(row.amount) })), rounding: structuredClone(p.rounding), upperLimitCents: p.upperLimitCents },
  } };
}
export function skinDepositIssues(draft: SkinDepositDraft): string[] {
  const issues: string[] = [], keys = new Set<string>(), ids = new Set<string>();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(draft.policyVersion)) issues.push("资金政策版本未填写或格式有误");
  for (const kind of Object.keys(SKIN_DEPOSIT_TYPES)) if (!draft.rules.some(row => row.ownerKind === kind && row.rarityCode === null)) issues.push(`${SKIN_DEPOSIT_TYPES[kind as keyof typeof SKIN_DEPOSIT_TYPES]}缺少类型兜底规则`);
  for (const row of draft.rules) {
    const key = JSON.stringify([row.ownerKind, row.rarityCode]);
    if (keys.has(key)) issues.push("类型与品质的匹配行重复");
    keys.add(key);
    try { if (depositYuanToCents(row.first) === null || depositYuanToCents(row.subsequent) === null) issues.push("皮肤加价行仍有待配置金额"); } catch (failure) { issues.push((failure as Error).message); }
  }
  for (const row of draft.overrides) {
    if (!row.skinId || ids.has(row.skinId)) issues.push("单词条覆盖未选词条或重复");
    ids.add(row.skinId);
    try { if (depositYuanToCents(row.amount) === null) issues.push("单词条覆盖仍有待配置金额"); } catch (failure) { issues.push((failure as Error).message); }
  }
  return [...new Set(issues)];
}

/** Copy the current price contract only when initializing an empty, newly created price draft. */
export function skinDepositSaveBody(rules: RulesResponse, target: PriceVersionRecord, base: PriceVersionRecord, policy: FundingPolicy): Record<string, unknown> {
  const result: Record<string, unknown> = { expectedRevision: target.revision, fundingPolicy: policy };
  if (rules.priceLines.some(line => line.priceVersionId === target.id)) return result;
  const lines = rules.priceLines.filter(line => line.priceVersionId === base.id);
  if (!lines.length) throw new Error("缺少可复用的价格行，请先完成原价格草稿配置。");
  return { ...result, mode: base.mode, ...(base.commissionRate === null ? {} : { commissionRate: base.commissionRate }), haffRule: base.haffRule, roundingPolicy: base.roundingPolicy,
    lines: lines.map(({ itemId, customerTier, pricingKind, unitQuantity, buyerUnitAmount, ownerUnitAmount }) => ({ itemId, ...(customerTier === undefined ? {} : { customerTier }), pricingKind, ...(pricingKind === "FIXED_UNIT" ? { unitQuantity, buyerUnitAmount, ...(base.mode === "SPREAD" && ownerUnitAmount !== null ? { ownerUnitAmount } : {}) } : {}) })) };
}
