import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { assertActiveInTransaction } from "../auth/user-identity";
import { notFound } from "../supply/supply-util";
import { calculateWithdrawalAmounts, type WithdrawalFee } from "./withdrawal-ledger";
import { assertPayoutProfile, assertPayoutReviewStrategy, assertPayoutStart, createWithdrawalAdmission, describePayoutProfile,
  type BoundPayoutProfile, type PayoutScope, type WithdrawalPolicy } from "./joinpay-payout-profile";
import { readWithdrawalBankBinding, readWithdrawalBankBindingForPayout, type WithdrawalBankBindingOptions } from "./withdrawal-bank-binding";
import type { NativeWithdrawalActor, NativeWithdrawalOptions } from "./native-withdrawal-store";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
// 描述明确的赋值实现，不是官方向量、开户验证或对本地AES密文的再次编码。
const implementation = "receiverAccountNoEnc=stored.cardNo;receiverNameEnc=stored.name;receiverAccountType=201;no-transformation-v1";
export const JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION = Object.freeze({ reference: "ZZSH_BANK_VALUE_PASSTHROUGH_CONTRACT_V1", sha256: sha(implementation) });
export type WithdrawalBankPolicy = Readonly<{ version: string; reference: string; reviewSha256: string; minCents: string; maxCents: string;
  fee: WithdrawalFee; frequencyBasis: WithdrawalPolicy["frequencyBasis"]; maxIntents: number; reviewStrategy: WithdrawalPolicy["reviewStrategy"];
  quotaUtcOffsetMinutes: number; identityMaximumAgeSeconds: number; validFrom: string; expiresAt: string }>;
type SourceOptions = { scope: PayoutScope; profile: BoundPayoutProfile; bankBinding: WithdrawalBankBindingOptions; policy: WithdrawalBankPolicy; identityProvider: string;
  targetEncoding: "LEGACY_CODE_PASSTHROUGH"; destinationAuthorization: "AUTHENTICATED_USER_DECLARATION" };
type IdentityRow = { accountStatus: string; identityStatus: string; ageStatus: string; provider: string; providerReference: string | null;
  version: number; verifiedAt: string | null; now: string };
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const actual = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0
  && Buffer.byteLength(value) <= 512 && !/SYNTHETIC|MODEL|LOCAL_CONTROLLED/i.test(value);
const utc = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function definition(input: WithdrawalBankPolicy): WithdrawalBankPolicy {
  const p = JSON.parse(JSON.stringify(input)) as WithdrawalBankPolicy;
  if (Object.keys(p).some(k => !["version", "reference", "reviewSha256", "minCents", "maxCents", "fee", "frequencyBasis", "maxIntents", "reviewStrategy", "quotaUtcOffsetMinutes", "identityMaximumAgeSeconds", "validFrom", "expiresAt"].includes(k))
    || typeof p.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.version) || !actual(p.reference) || typeof p.reviewSha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.reviewSha256)
    || ![p.minCents, p.maxCents].every(v => typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v) && BigInt(v) <= 9999999999999999n)
    || BigInt(p.minCents) > BigInt(p.maxCents) || !["ACCEPTED_INTENT", "ACTIVE_OR_SUCCEEDED"].includes(p.frequencyBasis)
    || !Number.isSafeInteger(p.maxIntents) || p.maxIntents < 1 || !["VERIFIED_DIRECT_EXECUTION", "MERCHANT_REVIEW_REQUIRED"].includes(p.reviewStrategy)
    || !Number.isInteger(p.quotaUtcOffsetMinutes) || Math.abs(p.quotaUtcOffsetMinutes) > 840
    || !Number.isSafeInteger(p.identityMaximumAgeSeconds) || p.identityMaximumAgeSeconds < 60 || p.identityMaximumAgeSeconds > 31536000
    || !utc(p.validFrom) || !utc(p.expiresAt) || p.validFrom >= p.expiresAt) throw unavailable("WITHDRAWAL_POLICY_UNAVAILABLE");
  calculateWithdrawalAmounts(p.minCents, p.fee);
  if (Object.keys(p.fee).some(k => !(p.fee.kind === "FIXED" ? ["kind", "cents"] : ["kind", "numerator", "denominator", "rounding"]).includes(k))) throw unavailable("WITHDRAWAL_POLICY_UNAVAILABLE");
  return Object.freeze({ ...p, fee: Object.freeze({ ...p.fee }) });
}
function currentPolicy(p: WithdrawalBankPolicy, now: string): WithdrawalPolicy {
  if (!utc(now) || now < p.validFrom || now >= p.expiresAt) throw unavailable("WITHDRAWAL_POLICY_EXPIRED");
  const offset = p.quotaUtcOffsetMinutes * 60000, start = Math.floor((Date.parse(now) + offset) / 86400000) * 86400000 - offset;
  const body = { version: p.version, reference: p.reference, minCents: p.minCents, maxCents: p.maxCents, fee: p.fee, frequencyBasis: p.frequencyBasis,
    quotaStart: new Date(start).toISOString(), quotaEnd: new Date(start + 86400000).toISOString(), maxIntents: p.maxIntents,
    reviewStrategy: p.reviewStrategy, validFrom: p.validFrom, expiresAt: p.expiresAt };
  return Object.freeze({ ...body, sha256: sha(JSON.stringify([p, body])) });
}
async function identity(c: PoolClient, userId: string) {
  await assertActiveInTransaction(c, userId);
  return (await c.query<IdentityRow>(`SELECT account_status AS "accountStatus",identity_status AS "identityStatus",age_status AS "ageStatus",provider,
    provider_reference AS "providerReference",version,to_char(verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "verifiedAt",
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
    FROM "zzsh_iam"."user_identity_state" WHERE user_id=$1`, [userId])).rows[0];
}
function identityReason(row: IdentityRow | undefined, p: WithdrawalBankPolicy, expectedProvider: string) {
  if (!row || row.accountStatus !== "ACTIVE" || row.identityStatus !== "VERIFIED") return "IDENTITY_NOT_VERIFIED";
  if (row.ageStatus !== "ADULT") return "ADULT_STATUS_REQUIRED";
  if (row.provider !== expectedProvider || !actual(row.providerReference)) return "REAL_IDENTITY_SOURCE_REQUIRED";
  if (!Number.isSafeInteger(row.version) || row.version < 1 || !utc(row.verifiedAt) || !utc(row.now) || row.verifiedAt > row.now
    || Date.parse(row.now) >= Date.parse(row.verifiedAt) + p.identityMaximumAgeSeconds * 1000) return "IDENTITY_PROOF_EXPIRED_OR_INVALID";
  return null;
}

/** 消费真实身份行及本人版本化绑卡；不新增银行卡要素验证服务或每用户运行白名单。 */
export function createBankBoundWithdrawalOptions(input: SourceOptions): NativeWithdrawalOptions {
  const p = definition(input.policy), scope = assertPayoutProfile(input.scope, input.profile, "SUBMIT"), descriptor = describePayoutProfile(input.profile, "SUBMIT");
  assertPayoutStart(input.scope); assertPayoutReviewStrategy(input.profile, p.reviewStrategy);
  const { binding: _binding, ...targetRules } = descriptor.targetRules;
  if (!actual(input.identityProvider) || /^(fake|mock|test|synthetic|legacy|none)/i.test(input.identityProvider)
    || input.targetEncoding !== "LEGACY_CODE_PASSTHROUGH" || input.destinationAuthorization !== "AUTHENTICATED_USER_DECLARATION"
    || descriptor.targetRules.encodingImplementationRef !== JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION.reference
    || descriptor.targetRules.encodingImplementationSha256 !== JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION.sha256
    || input.bankBinding.database !== scope.database || input.bankBinding.runtimeUser !== scope.runtimeUser || !input.bankBinding.protection
    || typeof input.bankBinding.protection.keyFor !== "function") throw unavailable("WITHDRAWAL_BANK_SOURCE_UNAVAILABLE");
  const loadAdmission: NonNullable<NativeWithdrawalOptions["loadAdmission"]> = async (c, userId, body) => {
    if (body.policyVersion !== p.version) throw notFound();
    const row = await identity(c, userId), reason = identityReason(row, p, input.identityProvider);
    if (reason) throw unavailable(reason);
    const policy = currentPolicy(p, row!.now), bank = await readWithdrawalBankBindingForPayout(c, userId, body.destinationId, input.bankBinding);
    const verified = row!, identityProof = { userId, provider: verified.provider, providerReference: verified.providerReference,
      version: verified.version, verifiedAt: verified.verifiedAt, identityStatus: verified.identityStatus, ageStatus: verified.ageStatus };
    return createWithdrawalAdmission(input.scope, { reference: `USER_WITHDRAWAL_AUTHORIZATION:${bank.bindingId}:${bank.revision}`,
      reviewSha256: p.reviewSha256, userId, policy,
      identity: { provider: verified.provider, providerReference: verified.providerReference!, version: verified.version,
        proofReference: `USER_IDENTITY_STATE:${userId}:${verified.version}`, proofSha256: sha(JSON.stringify(identityProof)),
        validUntil: new Date(Math.min(Date.parse(verified.verifiedAt!) + p.identityMaximumAgeSeconds * 1000, Date.parse(p.expiresAt))).toISOString() },
      target: { destinationId: bank.bindingId, revision: bank.revision, userId, mask: bank.cardMask, fingerprint: bank.sourceDigest,
        // 历史字段名保留；依据是已认证用户的目标声明，绝不称为银行归属验证通过。
        bankOwnershipReference: `USER_AUTHORIZED_BANK_BINDING:${bank.bindingId}:${bank.revision}`, bankOwnershipSha256: bank.sourceDigest,
        ...targetRules, receiverAccountNoEnc: bank.cardNo, receiverNameEnc: bank.name, receiverAccountType: "201" } });
  };
  const readContext = async (c: PoolClient, actor: NativeWithdrawalActor) => {
    const bank = await readWithdrawalBankBinding(c, actor, input.bankBinding), row = await identity(c, actor.userId), reason = identityReason(row, p, input.identityProvider);
    let policy: WithdrawalPolicy | null = null; try { if (row) policy = currentPolicy(p, row.now); } catch { /* 只读表达不可用，不伪造有效政策。 */ }
    const reasons = [...(bank.integration !== "INTEGRATED" ? ["BANK_BINDING_NOT_INTEGRATED"] : !bank.binding ? ["BANK_BINDING_REQUIRED"] : []),
      ...(reason ? [reason] : []), ...(!policy ? ["WITHDRAWAL_POLICY_UNAVAILABLE"] : [])];
    return { contractVersion: "withdrawal-request-context.v1", bankBinding: bank, policy: policy ? { version: policy.version, minCents: policy.minCents,
      maxCents: policy.maxCents, fee: policy.fee, maxIntents: policy.maxIntents, quotaStart: policy.quotaStart, quotaEnd: policy.quotaEnd } : null,
      canQuote: reasons.length === 0, reasonCodes: reasons, bankOwnershipVerification: "NOT_VERIFIED", bankArrival: "UNKNOWN" };
  };
  return { scope: input.scope, initialProfile: input.profile, loadAdmission, readContext };
}
