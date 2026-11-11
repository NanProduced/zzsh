import { normalizeTime } from "../supply/content-hash";
import { fixedFeeAllowsPayableRatio, parseFixedFeeRates, type FixedFeeRates } from "../supply/fixed-fee";
import { entitlementPricingSummary, validateBenefitPolicy, type GrowthBenefitPolicy, type RentalMode } from "./membership-growth";

type FeeVersion = { effectiveAt: string; generation: string; rates: FixedFeeRates; protectedModes: readonly RentalMode[] };
type BenefitVersion = { effectiveAt: string; version: string; policy: GrowthBenefitPolicy };
type Entitlement = { startsAt: string; endsAt: string; pricing: unknown };
export type FixedFeeTimelineInput = { from: string; fees: readonly FeeVersion[]; benefits: readonly BenefitVersion[]; entitlements: readonly Entitlement[] };
export type FixedFeeTimelineResult = { valid: true } | { valid: false; reason: string; at: string; mode?: RentalMode };

const instant = (value: string) => {
  const result = normalizeTime(value);
  if (!result) throw new Error("missing instant");
  return result;
};
const sequence = (value: string) => {
  if (!/^[1-9]\d{0,18}$/.test(value)) throw new Error("invalid version");
  return BigInt(value);
};

/** Checks every effective price/policy interval; the caller must supply a complete, locked database snapshot. */
export function validateFixedFeeTimeline(input: FixedFeeTimelineInput): FixedFeeTimelineResult {
  let from = "";
  try {
    from = instant(input.from);
    const fees = input.fees.map(row => ({ ...row, effectiveAt: instant(row.effectiveAt), generationNo: sequence(row.generation), rates: parseFixedFeeRates(row.rates) }));
    const benefits = input.benefits.map(row => ({ ...row, effectiveAt: instant(row.effectiveAt), versionNo: sequence(row.version) }));
    const entitlements = input.entitlements.map(row => ({ ...row, startsAt: instant(row.startsAt), endsAt: instant(row.endsAt) }));
    if (new Set(fees.map(row => row.generation)).size !== fees.length || new Set(benefits.map(row => row.version)).size !== benefits.length) throw new Error("duplicate version");
    if (entitlements.some(row => row.startsAt >= row.endsAt)) throw new Error("invalid entitlement interval");
    const events = [...new Set([from, ...fees.map(row => row.effectiveAt), ...benefits.map(row => row.effectiveAt), ...entitlements.map(row => row.startsAt)]
      .filter(at => at >= from))].sort();
    for (const at of events) {
      const fee = fees.filter(row => row.effectiveAt <= at).sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt)
        || (left.generationNo > right.generationNo ? -1 : left.generationNo < right.generationNo ? 1 : 0))[0];
      if (!fee) return { valid: false, reason: "FEE_POLICY_UNAVAILABLE", at };
      const benefit = benefits.filter(row => row.effectiveAt <= at).sort((left, right) => left.versionNo > right.versionNo ? -1 : left.versionNo < right.versionNo ? 1 : 0)[0];
      if (!benefit) return { valid: false, reason: "BENEFIT_POLICY_UNAVAILABLE", at };
      const checked = validateBenefitPolicy(benefit.policy, { enabledModes: fee.protectedModes, fixedFeeRates: fee.rates });
      if (!checked.publishable) return { valid: false, reason: "BENEFIT_POLICY_INCOMPATIBLE", at };
      for (const entitlement of entitlements) {
        if (entitlement.startsAt > at || entitlement.endsAt <= at) continue;
        const pricing = entitlementPricingSummary(entitlement.pricing);
        if (pricing.knowledge !== "KNOWN") return { valid: false, reason: "ENTITLEMENT_PRICING_UNAVAILABLE", at };
        const applicable = "scope" in pricing ? fee.protectedModes : [pricing.mode];
        for (const mode of applicable) {
          if (!fee.protectedModes.includes(mode)) continue;
          if (!fixedFeeAllowsPayableRatio(fee.rates[mode], pricing.payableRatio)) return { valid: false, reason: "ENTITLEMENT_DISCOUNT_EXCEEDS_FEE", at, mode };
        }
      }
    }
    return { valid: true };
  } catch { return { valid: false, reason: "TIMELINE_UNAVAILABLE", at: from }; }
}
