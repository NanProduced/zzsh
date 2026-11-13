import { normalizeTime } from "../supply/content-hash";
import type { PoolClient } from "pg";
import { fixedFeeAllowsPayableRatio, parseFixedFeeRates } from "../supply/fixed-fee";
import { entitlementPricingSummary, validateBenefitPolicy, type GrowthBenefitPolicy, type RentalMode } from "./membership-growth";

type FeeVersion = { effectiveAt: string; generation: string; rates: unknown; protectedModes: readonly RentalMode[] | null };
export type FixedFeeModeVersion = { effectiveAt: string; generation: string; pricingModel: "FIXED_FEE" | "SPREAD" };
type BenefitVersion = { effectiveAt: string; version: string; policy: GrowthBenefitPolicy };
type Entitlement = { startsAt: string; endsAt: string; pricing: unknown };
export type FixedFeeTimelineInput = { from: string; fees: readonly FeeVersion[]; modes: readonly FixedFeeModeVersion[]; frozenFees?: readonly Pick<FeeVersion, "rates" | "protectedModes">[]; benefits: readonly BenefitVersion[]; entitlements: readonly Entitlement[] };
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

const effectiveFirst = (left: { effectiveAt: string; generationNo: bigint }, right: { effectiveAt: string; generationNo: bigint }) =>
  right.effectiveAt.localeCompare(left.effectiveAt)
  || (left.generationNo > right.generationNo ? -1 : left.generationNo < right.generationNo ? 1 : 0);

/** Call in the write transaction before reading either side of a fee/benefit change. */
export async function lockFixedFeePolicyChange(client: Pick<PoolClient, "query">): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:fixed-fee:policy-compatibility',0))");
}

/** Checks every effective price/policy interval; the caller must supply a complete, locked database snapshot. */
export function validateFixedFeeTimeline(input: FixedFeeTimelineInput): FixedFeeTimelineResult {
  let from = "";
  try {
    from = instant(input.from);
    const modeSchedule = input.modes.map(row => ({ ...row, effectiveAt: instant(row.effectiveAt), generationNo: sequence(row.generation) }));
    const fees = input.fees.map(row => ({ ...row, effectiveAt: instant(row.effectiveAt), generationNo: sequence(row.generation) }));
    const benefits = input.benefits.map(row => ({ ...row, effectiveAt: instant(row.effectiveAt), versionNo: sequence(row.version) }));
    const entitlements = input.entitlements.map(row => ({ ...row, startsAt: instant(row.startsAt), endsAt: instant(row.endsAt) }))
      .sort((left, right) => left.startsAt < right.startsAt ? -1 : left.startsAt > right.startsAt ? 1 : 0);
    if (new Set(fees.map(row => row.generation)).size !== fees.length || new Set(benefits.map(row => row.version)).size !== benefits.length) throw new Error("duplicate version");
    if (entitlements.some(row => row.startsAt >= row.endsAt)) throw new Error("invalid entitlement interval");
    if (new Set(modeSchedule.map(row => row.generationNo)).size !== modeSchedule.length
      || modeSchedule.some(row => row.pricingModel !== "SPREAD" && row.pricingModel !== "FIXED_FEE")) throw new Error("invalid pricing mode timeline");
    const events = [...new Set([from, ...fees.map(row => row.effectiveAt), ...modeSchedule.map(row => row.effectiveAt), ...benefits.map(row => row.effectiveAt)]
      .filter(at => at >= from))].sort();
    for (const [index, at] of events.entries()) {
      const mode = modeSchedule.filter(row => row.effectiveAt <= at).sort(effectiveFirst)[0];
      const protectedFees = [...(input.frozenFees ?? [])];
      if (mode?.pricingModel === "FIXED_FEE") {
        const fee = fees.filter(row => row.effectiveAt <= at).sort(effectiveFirst)[0];
        if (!fee) return { valid: false, reason: "FEE_POLICY_UNAVAILABLE", at };
        protectedFees.push(fee);
      }
      if (!protectedFees.length) continue;
      const benefit = benefits.filter(row => row.effectiveAt <= at).sort((left, right) => left.versionNo > right.versionNo ? -1 : left.versionNo < right.versionNo ? 1 : 0)[0];
      if (!benefit) return { valid: false, reason: "BENEFIT_POLICY_UNAVAILABLE", at };
      const next = events[index + 1];
      for (const protectedFee of protectedFees) {
        if (!protectedFee.protectedModes?.length) return { valid: false, reason: "FEE_POLICY_UNAVAILABLE", at };
        const rates = parseFixedFeeRates(protectedFee.rates);
        const checked = validateBenefitPolicy(benefit.policy, { enabledModes: protectedFee.protectedModes, fixedFeeRates: rates });
        if (!checked.publishable) return { valid: false, reason: "BENEFIT_POLICY_INCOMPATIBLE", at };
        for (const entitlement of entitlements) {
          if (next && entitlement.startsAt >= next) break;
          if (entitlement.endsAt <= at) continue;
          const observedAt = entitlement.startsAt > at ? entitlement.startsAt : at;
          const pricing = entitlementPricingSummary(entitlement.pricing);
          if (pricing.knowledge !== "KNOWN") return { valid: false, reason: "ENTITLEMENT_PRICING_UNAVAILABLE", at: observedAt };
          const applicable = "scope" in pricing ? protectedFee.protectedModes : [pricing.mode];
          for (const mode of applicable) {
            if (!protectedFee.protectedModes.includes(mode)) continue;
            if (!fixedFeeAllowsPayableRatio(rates[mode], pricing.payableRatio)) return { valid: false, reason: "ENTITLEMENT_DISCOUNT_EXCEEDS_FEE", at: observedAt, mode };
          }
        }
      }
    }
    return { valid: true };
  } catch { return { valid: false, reason: "TIMELINE_UNAVAILABLE", at: from }; }
}
