// SYNTHETIC_SOURCE_COMPONENT：全部是离线假设，不是商户开通或真实身份事实。
import { bindPayoutProfile, createPayoutScope, type PayoutProfileInput } from "../../src/finance/joinpay-payout-profile";
import { saveWithdrawalBankBinding } from "../../src/finance/withdrawal-bank-binding";
import { JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION, type WithdrawalBankPolicy } from "../../src/finance/joinpay-withdrawal-bank-source";
import { actor, input, fixture } from "./withdrawal-bank-binding-model";
const H = "1".repeat(64);
export function profile(operation: PayoutProfileInput["operation"]): PayoutProfileInput {
  return { operation, purpose: "MERCHANT_PAYOUT", profileId: "unit_" + operation, keyVersionRef: "unit_merchant_key", merchantIdentityId: "unit_merchant", userNo: "999900000000005",
    database: "unit_bank_database", runtimeUser: "unit_bank_r", reviewRef: "unit_review", reviewSha256: H,
    wire: { productCode: "BANK_PAY_DAILY_ORDER", isChecked: "202", paidDesc: "虚构测试", paidUse: "201", callbackUrl: "https://callback.invalid/api/v1/withdrawals/joinpay/notifications" },
    rules: { dataEncoding: "OBJECT", statusCodeToken: "STRING", statusToken: "NUMBER", amountToken: "NUMBER", feeToken: "NUMBER", accountTypeToken: "NUMBER", optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT",
      numericSigning: "RAW_JSON_TOKEN", unknownFields: "REJECT", notFoundShape: "IDENTITY_ONLY_214", targetBinding: "EXACT_RECORDED_OPAQUE_VALUE", providerFeeUnit: "CNY_YUAN" },
    requestUtcOffsetMinutes: 480, targetRules: { binding: "EXACT_RECORDED_OPAQUE_VALUE", encodingRuleRef: "unit_legacy_source_rule", encodingRuleSha256: H,
      encodingImplementationRef: JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION.reference, encodingImplementationSha256: JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION.sha256, targetEchoRuleRef: "unit_exact_echo_rule", targetEchoRuleSha256: H },
    feePolicy: { reference: "unit_merchant_fee_rule", sha256: H, providerUnit: "CNY_YUAN", merchantBearsFee: true, maxProviderFeeCents: "100", unpaidGuarantee: null }, knownAnswer: "NOT_OBTAINED",
    ...(operation === "NOTIFY" ? { acknowledgement: { reference: "unit_ack_rule", sha256: H, rule: "JSON_STATUS_2001_2002" as const, semantic: "VERIFIED_BOUND_OBSERVATION_COMMITTED" as const } } : {}) };
}
export function policy(): WithdrawalBankPolicy { return { version: "unit_policy", reference: "unit_business_policy", reviewSha256: H, minCents: "200", maxCents: "1000000", fee: { kind: "FIXED", cents: "100" },
  frequencyBasis: "ACTIVE_OR_SUCCEEDED", maxIntents: 2, reviewStrategy: "VERIFIED_DIRECT_EXECUTION", quotaUtcOffsetMinutes: 480, identityMaximumAgeSeconds: 86400,
  validFrom: "2026-10-24T00:00:00.000Z", expiresAt: "2026-10-30T00:00:00.000Z" }; }
export function configuration(f: ReturnType<typeof fixture>, changes: Partial<WithdrawalBankPolicy> = {}) {
  const profiles = ["SUBMIT", "QUERY", "NOTIFY"].map(op => bindPayoutProfile(profile(op as PayoutProfileInput["operation"])));
  const scope = createPayoutScope({ reference: "unit_scope", reviewSha256: H, database: f.options.database, runtimeUser: f.options.runtimeUser,
    merchantIdentityId: "unit_merchant", userNo: "999900000000005", profiles });
  return { scope, profile: profiles[0]!, bankBinding: f.options, policy: { ...policy(), ...changes }, identityProvider: "unit_identity_provider", targetEncoding: "LEGACY_CODE_PASSTHROUGH" as const, destinationAuthorization: "AUTHENTICATED_USER_DECLARATION" as const };
}
export function verified(f: ReturnType<typeof fixture>) { Object.assign(f.state.identityRow, { identityStatus: "VERIFIED", ageStatus: "ADULT", provider: "unit_identity_provider", providerReference: "unit_verified_reference" }); }
export async function bound() { const f = fixture(), b = await saveWithdrawalBankBinding(f.pool, actor, input, "unit_bank", f.options); return { f, id: b.body.binding!.id }; }
