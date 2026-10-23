export type AdminGrowthTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND";
export type AdminEntitlementKind = "FRIEND" | "PRESTIGE";
export type AdminPricingMode = "ordinary" | "custom" | "fast";
export type UnifiedScope = "ALL_ENABLED_RENTAL_MODES";

export const UNIFIED_PRICING_SCHEMA = "membership-unified-pricing.v1" as const;
export const UNIFIED_PRICING_SCOPE: UnifiedScope = "ALL_ENABLED_RENTAL_MODES";

export type UnifiedTierProjection = {
  knowledge: "KNOWN" | "UNKNOWN";
  payableRatio: string | null;
  reasonCodes: string[];
};

export type UnifiedRangeProjection = {
  knowledge: "KNOWN" | "UNKNOWN";
  minPayableRatio: string | null;
  maxPayableRatio: string | null;
  priceVersionId: string | null;
  costBasisRef: string | null;
  reasonCodes: string[];
};

export type UnifiedPricingProjection = {
  schema: typeof UNIFIED_PRICING_SCHEMA;
  scope: UnifiedScope;
  knowledge: "KNOWN" | "UNKNOWN";
  tiers: Record<AdminGrowthTier, UnifiedTierProjection>;
  entitlementRanges: Record<AdminEntitlementKind, UnifiedRangeProjection>;
};

export type UnifiedPricingInput = {
  schema: typeof UNIFIED_PRICING_SCHEMA;
  scope: UnifiedScope;
  tiers: Record<AdminGrowthTier, { payableRatio: string }>;
  entitlementRanges: Record<AdminEntitlementKind, { minPayableRatio: string; maxPayableRatio: string }>;
};

export type UnifiedDraft = {
  tiers: Record<AdminGrowthTier, string>;
  ranges: Record<AdminEntitlementKind, { min: string; max: string }>;
};

export type AdminGrowthCapability = {
  canDraft?: boolean;
  canChangeEntitlementRanges?: boolean;
  canRequestEntitlement?: boolean;
  depositAllowanceSupported?: boolean;
  unifiedPricingSupported?: boolean;
  canSimulateProfit?: boolean;
};

export type EntitlementPricingSummary =
  | { knowledge: "KNOWN"; kind: "TOTAL_DISCOUNT"; scope: UnifiedScope; payableRatio: string }
  | { knowledge: "KNOWN"; kind: "TOTAL_DISCOUNT"; mode: AdminPricingMode; payableRatio: string }
  | { knowledge: "LEGACY"; kind: "LEGACY" }
  | { knowledge: "UNKNOWN"; kind: "UNKNOWN" };

export type EntitlementPricingPayload = {
  status: "CONFIGURED";
  kind: "TOTAL_DISCOUNT";
  scope: UnifiedScope;
  priceVersionId: string;
  payableRatio: string;
  costBasisRef: string;
};

export const UNIFIED_PRICING_REASON_LABELS: Record<string, string> = {
  POLICY_UNAVAILABLE: "政策未读取",
  ENABLED_MODES_UNAVAILABLE: "启用的租赁路径未读取",
  LEGACY_PRICING_REQUIRES_REVIEW: "旧计价合同需复核",
  UNIFIED_PRICE_UNAVAILABLE: "统一价格依据暂不可用",
  UNIFIED_RANGE_UNAVAILABLE: "统一礼遇范围暂不可用",
  LEGACY_MODE_VALUES_DIFFER: "旧路径数值或依据不一致，需重新填写统一值",
  UNIFIED_PRICING_REQUIRED: "统一折扣尚未配置",
};

export function unifiedReasonText(reasonCodes: readonly string[] | undefined): string {
  if (!reasonCodes?.length) return "待核";
  return reasonCodes.map((code) => UNIFIED_PRICING_REASON_LABELS[code] ?? code).join("；");
}
