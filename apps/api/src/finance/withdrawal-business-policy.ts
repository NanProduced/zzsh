import { ConfigurationError, readSecret } from "../config/config";
import { SecurityApiError } from "../auth/security-core";
import { conflict } from "../supply/supply-util";
import { calculateWithdrawalAmounts, type WithdrawalFee } from "./withdrawal-ledger";

export type WithdrawalBusinessPolicy = Readonly<{
  version: string;
  minCents: string;
  maxCents: string;
  fee: WithdrawalFee;
  frequencyBasis: "ACCEPTED_INTENT" | "ACTIVE_OR_SUCCEEDED";
  maxIntents: number;
  reviewStrategy: "VERIFIED_DIRECT_EXECUTION" | "MERCHANT_REVIEW_REQUIRED";
  quotaUtcOffsetMinutes: number;
}>;

/** Shared business limits for the real and test payout adapters. Amounts remain integer cents. */
export function quoteWithdrawalBusinessAmounts(input: {
  amountCents: string; availableCents: string; used: string | number;
  minCents: string; maxCents: string; maxIntents: number; fee: WithdrawalFee;
}) {
  const used = typeof input.used === "number" && Number.isSafeInteger(input.used) ? String(input.used) : input.used;
  if (typeof used !== "string" || !/^(0|[1-9][0-9]*)$/.test(used)
    || typeof input.availableCents !== "string" || !/^(0|[1-9][0-9]*)$/.test(input.availableCents))
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Withdrawal balance or quota unavailable");
  if (!/^[1-9][0-9]{0,23}$/.test(input.minCents) || !/^[1-9][0-9]{0,23}$/.test(input.maxCents)
    || !Number.isSafeInteger(input.maxIntents) || input.maxIntents < 1)
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Withdrawal policy unavailable");
  if (!/^[1-9][0-9]{0,23}$/.test(input.amountCents)) throw conflict("Withdrawal amount or frequency unavailable");
  const amount = BigInt(input.amountCents), min = BigInt(input.minCents), max = BigInt(input.maxCents);
  if (min > max) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Withdrawal policy unavailable");
  if (amount < min || amount > max || amount > BigInt(input.availableCents) || BigInt(used) >= BigInt(input.maxIntents))
    throw conflict("Withdrawal amount or frequency unavailable");
  return calculateWithdrawalAmounts(input.amountCents, input.fee);
}

/** 测试值仅供已登记的测试环境；正式出款仍需要独立的审核配置。 */
export const TEAM_TEST_WITHDRAWAL_POLICY: WithdrawalBusinessPolicy = Object.freeze({
  version: "OWNER_LOCAL_RESTORED_20261003_v1_BANK_CARD",
  minCents: "200",
  maxCents: "1000000",
  fee: Object.freeze({ kind: "FIXED", cents: "100" }),
  frequencyBasis: "ACTIVE_OR_SUCCEEDED",
  maxIntents: 2,
  reviewStrategy: "VERIFIED_DIRECT_EXECUTION",
  quotaUtcOffsetMinutes: 480,
});

const invalid = () => new ConfigurationError("USER_WITHDRAWAL_POLICY_INVALID");
export function parseWithdrawalBusinessPolicy(value: unknown): WithdrawalBusinessPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "fee,frequencyBasis,maxCents,maxIntents,minCents,quotaUtcOffsetMinutes,reviewStrategy,version"
    || typeof p.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.version)
    || ![p.minCents, p.maxCents].every(v => typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v))
    || BigInt(p.minCents as string) > BigInt(p.maxCents as string)
    || !["ACCEPTED_INTENT", "ACTIVE_OR_SUCCEEDED"].includes(p.frequencyBasis as string)
    || !Number.isSafeInteger(p.maxIntents) || (p.maxIntents as number) < 1
    || !["VERIFIED_DIRECT_EXECUTION", "MERCHANT_REVIEW_REQUIRED"].includes(p.reviewStrategy as string)
    || !Number.isInteger(p.quotaUtcOffsetMinutes) || Math.abs(p.quotaUtcOffsetMinutes as number) > 840
    || !p.fee || typeof p.fee !== "object" || Array.isArray(p.fee)) throw invalid();
  const fee = p.fee as Record<string, unknown>;
  const keys = Object.keys(fee).sort().join(",");
  if (!(fee.kind === "FIXED" && keys === "cents,kind")
    && !(fee.kind === "RATIO" && keys === "denominator,kind,numerator,rounding")) throw invalid();
  try { calculateWithdrawalAmounts(p.minCents as string, fee as WithdrawalFee); } catch { throw invalid(); }
  const normalizedFee:WithdrawalFee = fee.kind === "FIXED"
    ? { kind:"FIXED", cents:fee.cents as string }
    : { kind:"RATIO", numerator:fee.numerator as string, denominator:fee.denominator as string, rounding:"HALF_UP_CENT" };
  return Object.freeze({ version:p.version, minCents:p.minCents as string, maxCents:p.maxCents as string,
    fee:Object.freeze(normalizedFee), frequencyBasis:p.frequencyBasis as WithdrawalBusinessPolicy["frequencyBasis"],
    maxIntents:p.maxIntents as number, reviewStrategy:p.reviewStrategy as WithdrawalBusinessPolicy["reviewStrategy"],
    quotaUtcOffsetMinutes:p.quotaUtcOffsetMinutes as number });
}

/** 不配置时保留原渠道装配；文件和值同时存在属于配置错误。 */
export function loadWithdrawalBusinessPolicy(env:NodeJS.ProcessEnv, workingDirectory:string):WithdrawalBusinessPolicy|undefined {
  if (env.USER_WITHDRAWAL_POLICY === undefined && env.USER_WITHDRAWAL_POLICY_FILE === undefined) return undefined;
  if (env.USER_WITHDRAWAL_POLICY !== undefined && env.USER_WITHDRAWAL_POLICY_FILE !== undefined) throw invalid();
  try { return parseWithdrawalBusinessPolicy(JSON.parse(readSecret(env,"USER_WITHDRAWAL_POLICY","USER_WITHDRAWAL_POLICY_FILE",workingDirectory))); }
  catch { throw invalid(); }
}

/** 运营策略必须与真实渠道装配中的冻结规则一致，不能覆盖已审批依据。 */
export function assertWithdrawalBusinessPolicyMatches(expected:WithdrawalBusinessPolicy, actual:WithdrawalBusinessPolicy):void {
  const selected = parseWithdrawalBusinessPolicy({ version:actual.version, minCents:actual.minCents, maxCents:actual.maxCents,
    fee:actual.fee, frequencyBasis:actual.frequencyBasis, maxIntents:actual.maxIntents,
    reviewStrategy:actual.reviewStrategy, quotaUtcOffsetMinutes:actual.quotaUtcOffsetMinutes });
  if (JSON.stringify(selected) !== JSON.stringify(expected)) throw new ConfigurationError("USER_WITHDRAWAL_POLICY_MISMATCH");
}
