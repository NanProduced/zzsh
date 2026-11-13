/**
 * 成长模型门面。实现按时间与金额、等级与贡献回放、权益合同、报价选择拆开。
 * 原有公开符号仍从这里导出，调用方 import 路径不变。
 * 函数用可写 let 而不是 `export {x} from`：后者编译成只读 getter，
 * 既有 t.mock.method 无法替换 chooseCompleteOffer。
 */
import * as benefit from "./membership-growth-benefit";
import * as money from "./membership-growth-money";
import * as offer from "./membership-growth-offer";
import * as replay from "./membership-growth-replay";

export const MEMBERSHIP_GROWTH_SCHEMA = money.MEMBERSHIP_GROWTH_SCHEMA;
export const GROWTH_WINDOW_MS = money.GROWTH_WINDOW_MS;
export const GRACE_WINDOW_MS = money.GRACE_WINDOW_MS;
export const NORMAL_GROWTH_TIERS = replay.NORMAL_GROWTH_TIERS;
export const GROWTH_THRESHOLDS = replay.GROWTH_THRESHOLDS;

export type {
  ContributionAdapterResult,
  GrowthContribution,
  GrowthContributionStatus,
  GrowthGrace,
  GrowthProjection,
  GrowthReplayInput,
  GrowthSourceType,
  GrowthTier,
  NormalGrowthTier,
  RentalMode,
  SettledContributionFact,
} from "./membership-growth-replay";
export type {
  EntitlementCandidate,
  EntitlementCap,
  EntitlementCapByMode,
  EntitlementDiscountRange,
  EntitlementKind,
  EntitlementPricingSummary,
  EntitlementRanges,
  EntitlementValidation,
  ExistingEntitlement,
  GrowthBenefitPolicy,
  GrowthPricingContract,
  HaffPricingParameter,
  MaterialPricingParameter,
  ModePricingContract,
  NotPricedParameter,
  PolicyValidation,
  PolicyValidationContext,
  TierBenefitConfig,
  TotalDiscountContract,
  UnifiedEntitlementRangeProjection,
} from "./membership-growth-benefit";
export type { GrowthOfferBuildInput, GrowthOfferPlan, OfferBinding, OfferChoice } from "./membership-growth-offer";

export let GrowthRuleError = money.GrowthRuleError;
export type GrowthRuleError = money.GrowthRuleError;

export let growthInstantMicros = money.growthInstantMicros;
export let growthWindowStartAt = money.growthWindowStartAt;
export let parseDepositAllowanceCents = money.parseDepositAllowanceCents;
export let tenantDepositAfterBenefit = money.tenantDepositAfterBenefit;
export let roundHalfUpCents = money.roundHalfUpCents;

export let normalTierForPoints = replay.normalTierForPoints;
export let growthTierForPoints = replay.growthTierForPoints;
export let contributionFromSettlement = replay.contributionFromSettlement;
export let projectGrowthConsumptionSources = replay.projectGrowthConsumptionSources;
export let replayGrowthProjection = replay.replayGrowthProjection;

export let isTotalDiscountContract = benefit.isTotalDiscountContract;
export let isUnifiedTotalDiscountContract = benefit.isUnifiedTotalDiscountContract;
export let isLegacyPricingContract = benefit.isLegacyPricingContract;
export let isEntitlementCapByMode = benefit.isEntitlementCapByMode;
export let entitlementCapForMode = benefit.entitlementCapForMode;
export let sealedEnabledRentalModes = benefit.sealedEnabledRentalModes;
export let entitlementRangeForMode = benefit.entitlementRangeForMode;
export let isNotPriced = benefit.isNotPriced;
export let projectUniformEntitlementRange = benefit.projectUniformEntitlementRange;
export let entitlementPricingSummary = benefit.entitlementPricingSummary;
export let validateBenefitPolicy = benefit.validateBenefitPolicy;
export let assertValidBenefitPolicy = benefit.assertValidBenefitPolicy;
export let assertPublishableBenefitPolicy = benefit.assertPublishableBenefitPolicy;
export let validateEntitlementCandidate = benefit.validateEntitlementCandidate;
export let hasOverlappingEntitlement = benefit.hasOverlappingEntitlement;
export let entitlementStateAt = benefit.entitlementStateAt;

export let quoteToGrowthOfferPlan = offer.quoteToGrowthOfferPlan;
export let computeGrowthOfferPlan = offer.computeGrowthOfferPlan;
export let chooseCompleteOffer = offer.chooseCompleteOffer;
