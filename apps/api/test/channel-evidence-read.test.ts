import assert from "node:assert/strict";
// MODEL/SYNTHETIC fixtures only: no production row, key, raw body or channel response is embedded here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PoolClient } from "pg";
import * as paymentRead from "../src/order/channel-payment-read";
import type { AdminOrderPaymentSummary, AdminPaymentAnomalySection } from "../src/order/channel-payment-read";
import * as refundRead from "../src/finance/channel-finance-read";
import {
  createChannelEvidenceReadScope, readAdminChannelPaymentEvidence, readAdminChannelRefundEvidence,
  readAdminChannelWithdrawalEvidence, searchAdminChannelOriginals,
} from "../src/finance/channel-evidence-read";

type Row = Record<string, unknown>;
type Call = { sql: string; values: readonly unknown[] };
const DB = "zzsh_test_evidence", USER = "zzsh_evidence_reader", ADMIN = "admin_evidence_1", MERCHANT = "mi_evidence_1";
const AS_OF = "2026-10-26T09:00:00.000000Z";
const ISO_1 = "2026-10-26T08:01:00.000000Z";
const ISO_2 = "2026-10-26T08:40:00.000000Z";
const ISO_3 = "2026-10-26T08:50:00.000000Z";
const DIGEST_A = "a".repeat(64), DIGEST_B = "b".repeat(64), DIGEST_C = "c".repeat(64), DIGEST_D = "d".repeat(64);

class FakeClient {
  readonly calls: Call[] = [];
  constructor(private readonly respond: (sql: string, values: readonly unknown[]) => Row[] | Promise<Row[]>) {}
  async query(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: await this.respond(sql, values), rowCount: 0 };
  }
}
const pool = (client: FakeClient) => client as unknown as PoolClient;
const resource = (overrides: Partial<Row> = {}): Row => ({ database: DB, runtime_user: USER, as_of: AS_OF, ...overrides });
const isResource = (sql: string) => sql.includes("current_database() AS database");
const isSchema = (call: Call, table: string) => call.sql.includes("FROM pg_attribute") && call.values[0] === table;
const noWrites = (calls: readonly Call[]) => assert.ok(calls.every(call =>
  !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(call.sql) && !/FOR\s+UPDATE/i.test(call.sql) && !/pg_advisory/i.test(call.sql)));

function stub(target: object, key: string, value: unknown): () => void {
  const record = target as unknown as Record<string, unknown>;
  const original = record[key];
  record[key] = value;
  return () => { record[key] = original; };
}
function scope(options: { finance?: boolean; order?: boolean; user?: boolean; merchants?: string[]; orders?: string[]; users?: string[] } = {}) {
  return createChannelEvidenceReadScope({ database: DB, runtimeUser: USER, adminId: ADMIN,
    merchantIds: options.merchants ?? [MERCHANT], financeReadable: options.finance ?? true,
    orderReadable: options.order ?? true, userReadable: options.user ?? true,
    readableOrderIds: options.orders ?? ["ord_1"], readableUserIds: options.users ?? ["user_1"] });
}
const statusOf = (error: unknown, status: number, code: string) => {
  assert.ok(error instanceof Error, "expected SecurityApiError");
  const value = error as Error & { status?: number; code?: string };
  assert.equal(value.status, status); assert.equal(value.code, code); return true;
};

function paymentSummary(overrides: Partial<AdminOrderPaymentSummary> = {}): AdminOrderPaymentSummary {
  return {
    contractVersion: "admin-order-payment-summary.v1", integration: "JOINPAY", productionPaymentCapability: false,
    dataOrigin: "JOINPAY_PROVIDER",
    originalRequest: { id: "preq_1", channelOrderNo: "ORDER_1", method: "ALIPAY_NATIVE",
      amount: { cents: "10000", currency: "CNY" }, merchantIdentityId: MERCHANT, protocolVersion: "2.6",
      keyVersionRef: "kv_1", createdAt: ISO_1 },
    latestTrustedObservation: { source: "QUERY", evidenceLevel: "JOINPAY_VERIFIED", channelStatus: "SUCCEEDED",
      channelTrxNo: "TRX_1", providerPaidAtRaw: "2026-10-26 16:01:00", providerPaidAt: "2026-10-26T08:01:00.000Z",
      providerTimeZone: "EXPLICIT_OFFSET", providerTimeOffsetMinutes: 480, evidenceRef: `sha256:${DIGEST_A}`,
      observedAt: ISO_1 },
    acceptance: { state: "APPLIED", confirmationId: "pc_1", reasonCode: null },
    conflicts: [{ kind: "STALE", observedAt: ISO_2, evidenceRef: `sha256:${DIGEST_B}` }],
    recovery: { mode: "NONE", manualQueryOpen: false, lastAttemptAt: null, attempts: null },
    settlement: "NOT_INTEGRATED", unknowns: ["PROVIDER_TIMEZONE"], updatedAt: ISO_2, ...overrides,
  };
}
const emptyPaymentSummary = (): AdminOrderPaymentSummary => paymentSummary({ integration: "NOT_INTEGRATED",
  dataOrigin: "UNKNOWN", originalRequest: null, latestTrustedObservation: null, acceptance: null, conflicts: null,
  recovery: null, settlement: "NOT_INTEGRATED", unknowns: null, updatedAt: null });

function paymentClient(options: { confirmation?: Row[]; request?: Row[]; failure?: Row[]; schema?: boolean } = {}) {
  return new FakeClient((sql, values) => {
    if (isResource(sql)) return [resource()];
    if (sql.includes("FROM zzsh_order.payment_request") && sql.includes("SELECT state")) return options.request ?? [{ state: "ACTION_READY", updated_at: ISO_1 }];
    if (sql.includes("FROM zzsh_order.payment_confirmation")) return options.confirmation ?? [{ amount_cents: "10000", currency: "CNY", accepted_at: ISO_1 }];
    if (sql.includes("FROM pg_attribute") && values[0] === "zzsh_order.joinpay_collection_observation") return [{ ready: options.schema ?? true }];
    if (sql.includes("FROM zzsh_order.joinpay_collection_observation")) return options.failure ?? [];
    throw new Error(`Unexpected payment SQL: ${sql}`);
  });
}

type RefundSummary = Awaited<ReturnType<typeof refundRead.readAdminOrderRefundSummary>>;
function refundIntent(intentId: string, orderNo: string, cents: string, disposition: "ALLOCATED" | "CONSUMED" | "RELEASED",
  localState = "SUCCEEDED"): NonNullable<RefundSummary["intents"]>[number] {
  return { intentId, refundOrderNo: orderNo, amount: { cents, currency: "CNY" }, localState, budgetDisposition: disposition,
    requiresReview: false, evidenceId: `rfe_${intentId}`, rootId: "fer_1", eventId: "fe_1", mayResubmit: false, bankArrival: "UNKNOWN" } as unknown as NonNullable<RefundSummary["intents"]>[number];
}
function refundSummary(intents: NonNullable<RefundSummary["intents"]>): RefundSummary {
  return { contractVersion: "admin-order-refund-summary.v1", integration: "INTEGRATED", intents,
    bankArrival: "UNKNOWN", reasonCodes: ["LOCAL_RECORDS_ONLY_TERMINAL_EVIDENCE_NOT_REVALIDATED"] } as unknown as RefundSummary;
}
const postingRow = (overrides: Row = {}): Row => ({ id: "spost_1", payment_confirmation_id: "pc_1", version_hash: "vh_1",
  captured_cents: "10000", renter_refund_cents: "200", system_renter_refund_cents: "250", refund_due_at: ISO_2,
  posted_at: ISO_1, confirmation_currency: "CNY", confirmation_amount_cents: "10000", payment_source: "JOINPAY",
  confirmation_disposition: "APPLIED", ...overrides });
function refundClient(options: { posting?: Row[]; postingSchema?: boolean; confirmationSchema?: boolean } = {}) {
  return new FakeClient((sql, values) => {
    if (isResource(sql)) return [resource()];
    if (sql.includes("FROM pg_attribute") && values[0] === "zzsh_order.settlement_posting") return [{ ready: options.postingSchema ?? true }];
    if (sql.includes("FROM pg_attribute") && values[0] === "zzsh_order.payment_confirmation") return [{ ready: options.confirmationSchema ?? true }];
    if (sql.includes("FROM zzsh_order.settlement_posting")) return options.posting ?? [postingRow()];
    if (sql.includes("SELECT id,merchant_identity_id FROM zzsh_order.channel_refund_intent")) return (values[1] as string[]).map(id => ({ id, merchant_identity_id: MERCHANT }));
    throw new Error(`Unexpected refund SQL: ${sql}`);
  });
}

const admission = JSON.stringify({ kind: "JOINPAY_WITHDRAWAL_BUSINESS_ADMISSION", userId: "user_1",
  target: { userId: "user_1", destinationId: "bank_1", revision: "3", mask: "**** **** 1234",
    receiverAccountNoEnc: "SECRET_FULL_CARD", receiverNameEnc: "SECRET_NAME" } });
const admissionSha = createHash("sha256").update(admission).digest("hex");
const withdrawalRow = (overrides: Row = {}): Row => ({ id: "jwd_1", user_id: "user_1", gross_cents: "10000",
  net_cents: "9800", fee_cents: "200", currency: "CNY", state: "SUCCEEDED", operation_version: "4",
  funds_disposition: "PAYOUT_POSTED", requires_review: false, merchant_order_no: "M123456789012",
  platform_serial_no: "PS_1", policy_version: "wd.v1", destination_id: "bank_1", destination_revision: "3",
  admission_canonical: admission, admission_sha256: admissionSha, accepted_at: ISO_1, merchant_identity_id: MERCHANT,
  economic_root_id: "fer_1", reserve_event_id: "fe_1", terminal_evidence_id: "pwe_1",
  provider_fee_cents: "150", provider_fee_raw: "150", receiver_account_no_enc: "SECRET_FULL_CARD", ...overrides });
function withdrawalClient(options: { rows?: Row[]; schema?: boolean } = {}) {
  return new FakeClient((sql, values) => {
    if (isResource(sql)) return [resource()];
    if (sql.includes("FROM pg_attribute") && values[0] === "zzsh_order.joinpay_withdrawal_intent") return [{ ready: options.schema ?? true }];
    if (sql.includes("FROM zzsh_order.joinpay_withdrawal_intent")) return options.rows ?? [withdrawalRow()];
    throw new Error(`Unexpected withdrawal SQL: ${sql}`);
  });
}

function searchClient(options: { product: "COLLECTION" | "REFUND" | "PAYOUT"; rows: Row[]; schema?: boolean }) {
  const table = options.product === "COLLECTION" ? "zzsh_order.payment_request"
    : options.product === "REFUND" ? "zzsh_order.channel_refund_intent" : "zzsh_order.joinpay_withdrawal_intent";
  return new FakeClient((sql, values) => {
    if (isResource(sql)) return [resource()];
    if (sql.includes("FROM pg_attribute") && values[0] === table) return [{ ready: options.schema ?? true }];
    if (options.product === "COLLECTION" && sql.includes("FROM pg_attribute") && values[0] === "zzsh_order.payment_channel_transaction") return [{ ready: options.schema ?? true }];
    if (sql.includes("FROM zzsh_order.payment_request")) return options.rows;
    if (sql.includes("FROM zzsh_order.channel_refund_intent")) return options.rows;
    if (sql.includes("FROM zzsh_order.joinpay_withdrawal_intent")) return options.rows;
    throw new Error(`Unexpected search SQL: ${sql}`);
  });
}
const collectionRow = (overrides: Row = {}): Row => ({ request_id: "preq_1", order_id: "ord_1", merchant_identity_id: MERCHANT,
  merchant_order_no: "ORDER_1", method: "ALIPAY_NATIVE", state: "ACTION_READY", amount_cents: "10000", currency: "CNY",
  evidence_level: "JOINPAY_CANDIDATE", recorded_at: ISO_1, channel_trx_no: null, ...overrides });
const refundSearchRow = (overrides: Row = {}): Row => ({ intent_id: "rfi_1", order_id: "ord_1", merchant_identity_id: MERCHANT,
  posting_id: "spost_1", refund_order_no: "RF1", original_payment_order_no: "ORDER_1", provider_refund_trx_no: "RTRX_1",
  original_payment_trx_no: "PTRX_1", state: "SUCCEEDED", budget_disposition: "CONSUMED", amount_cents: "100", currency: "CNY",
  evidence_level: "JOINPAY_CANDIDATE", requires_review: false, terminal_evidence_id: "rfe_1", recorded_at: ISO_1, ...overrides });
const payoutSearchRow = (overrides: Row = {}): Row => ({ intent_id: "jwd_1", user_id: "user_1", merchant_identity_id: MERCHANT,
  merchant_order_no: "M123456789012", platform_serial_no: "PS_1", state: "SUCCEEDED", funds_disposition: "PAYOUT_POSTED",
  gross_cents: "10000", net_cents: "9800", fee_cents: "200", currency: "CNY", requires_review: false,
  economic_root_id: "fer_1", reserve_event_id: "fe_1", terminal_evidence_id: "pwe_1", recorded_at: ISO_1, ...overrides });

test("scope token rejects fabricated grants and foreign resources before business SQL", async () => {
  const fabricated = new FakeClient(() => { throw new Error("must not query"); });
  await assert.rejects(() => readAdminChannelPaymentEvidence(pool(fabricated), {} as never, { orderId: "ord_1", origin: "NATIVE" }),
    (error) => statusOf(error, 403, "FORBIDDEN"));
  assert.equal(fabricated.calls.length, 0);

  assert.throws(() => createChannelEvidenceReadScope({ database: DB, runtimeUser: USER, adminId: ADMIN,
    merchantIds: ["bad merchant"], financeReadable: true, orderReadable: true, userReadable: true }),
  (error) => statusOf(error, 400, "INVALID_ARGUMENT"));

  const foreign = new FakeClient((sql) => isResource(sql) ? [resource({ database: "other" })] : []);
  await assert.rejects(() => readAdminChannelPaymentEvidence(pool(foreign), scope(), { orderId: "ord_1", origin: "NATIVE" }),
    (error) => statusOf(error, 503, "EVIDENCE_UNAVAILABLE"));
  assert.equal(foreign.calls.length, 1);
});

test("payment evidence exposes separate order/request/merchant numbers, trusted result and last failure", async () => {
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => paymentSummary());
  const client = paymentClient({ failure: [{ event: "E5", http_status: 200, transport_failure: null,
    response_complete: true, schema_outcome: "VALID", signature_outcome: "MATCH", binding_outcome: "MATCH",
    raw_sha256: DIGEST_D, observed_at: ISO_3 }] });
  try {
    const result = await readAdminChannelPaymentEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.integration, "JOINPAY");
    assert.equal(result.orderId, "ord_1"); assert.equal(result.requestId, "preq_1");
    assert.equal(result.merchantIdentityId, MERCHANT); assert.equal(result.merchantOrderNo, "ORDER_1");
    assert.equal(result.productFamily, "ALIPAY_NATIVE"); assert.equal(result.request?.state, "ACTION_READY");
    assert.deepEqual(result.amounts.requested, { cents: "10000", currency: "CNY" });
    assert.deepEqual(result.amounts.accepted, { cents: "10000", currency: "CNY" });
    assert.equal(result.amounts.trustedChannel, null);
    assert.equal(result.trustedObservation?.channelStatus, "SUCCEEDED");
    assert.equal(result.trustedObservation?.channelTrxNo, "TRX_1");
    assert.equal(result.trustedObservation?.providerPaidAt, "2026-10-26T08:01:00.000Z");
    assert.equal(result.trustedObservation?.ageSeconds, 3540);
    assert.equal(result.lastFailure?.kind, "CHANNEL_REPORTED_FAILED");
    assert.equal(result.lastFailure?.ageSeconds, 600);
    assert.equal(result.lastFailure?.usedForAcceptance, false);
    assert.equal(result.lastConflict?.kind, "STALE");
    assert.equal(result.fees.paymentFee, null); assert.equal(result.fees.settleAmount, null);
    assert.equal(result.fees.settleDerivation, "NOT_COMPUTED");
    assert.ok(result.reasonCodes.includes("SETTLE_NOT_DERIVED_FROM_PAYMENT_MINUS_FEE"));
    assert.ok(result.reasonCodes.includes("TRUSTED_CHANNEL_AMOUNT_NOT_STORED"));
    assert.equal(result.bankArrival, "UNKNOWN");
    assert.ok(client.calls.length <= 5);
    assert.ok(client.calls.filter(call => !isResource(call.sql) && !call.sql.includes("FROM pg_attribute"))
      .every(call => /LIMIT \d+/.test(call.sql)));
    noWrites(client.calls);
  } finally { restore(); }
});

test("C04A 异常区沿既有安全证据读取透传，不重解 raw", async () => {
  const anomalies: AdminPaymentAnomalySection = {
    contractVersion: "admin-order-payment-anomalies.v1", status: "AVAILABLE", limit: 50, truncated: false,
    items: [{ kind: "DUPLICATE_PAYMENT", source: "CONFIRMATION", evidenceLevel: "JOINPAY_CONFIRMATION", trusted: true,
      observedAt: ISO_1, disposition: "REVIEW_REQUIRED", reasonCode: "DUPLICATE_PAYMENT",
      amount: { cents: "20000", currency: "CNY" }, currency: "CNY", confirmationId: "pc_2", requestId: "preq_1",
      merchantIdentityId: MERCHANT,
      merchantOrderNo: "ORDER_1", providerTransactionId: "TRX_2", anchorOwnership: "MATCH", evidenceRef: `sha256:${DIGEST_B}` }],
  };
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => paymentSummary({ anomalies }));
  const client = paymentClient();
  try {
    const result = await readAdminChannelPaymentEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.deepEqual(result.anomalies, anomalies);
    assert.equal(result.anomalies?.items?.[0]?.kind, "DUPLICATE_PAYMENT");
    assert.equal(JSON.stringify(result).includes("raw_body"), false);
    noWrites(client.calls);
  } finally { restore(); }
});

test("Master：首笔商户获准也不能透传另一商户的异常确认金额和流水",async()=>{
  const anomalies={contractVersion:"admin-order-payment-anomalies.v1",status:"AVAILABLE",limit:50,truncated:false,
    items:[{kind:"DUPLICATE_PAYMENT",source:"CONFIRMATION",evidenceLevel:"JOINPAY_CONFIRMATION",trusted:true,
      observedAt:ISO_1,disposition:"REVIEW_REQUIRED",reasonCode:"DUPLICATE_PAYMENT",merchantIdentityId:"mi_not_authorized",
      amount:{cents:"4321",currency:"CNY"},currency:"CNY",confirmationId:"private_confirmation",requestId:"preq_1",
      merchantOrderNo:"PRIVATE_ORDER",providerTransactionId:"PRIVATE_TRX",anchorOwnership:"MATCH",evidenceRef:null}]} as unknown as AdminPaymentAnomalySection;
  const restore=stub(paymentRead,"readOrderPaymentSummary",async()=>paymentSummary({anomalies}));
  try{await assert.rejects(readAdminChannelPaymentEvidence(pool(paymentClient()),scope(),{orderId:"ord_1",origin:"NATIVE"}),e=>statusOf(e,404,"NOT_FOUND"));}
  finally{restore();}
});

test("payment evidence redacts nested finance fields without dropping acceptance state", async () => {
  const base = paymentSummary();
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => paymentSummary({
    originalRequest: { ...base.originalRequest!, amount: null, merchantIdentityId: null, channelOrderNo: null },
    latestTrustedObservation: { ...base.latestTrustedObservation!, channelTrxNo: null },
    acceptance: { state: "PENDING", confirmationId: null, reasonCode: null },
  }));
  const client = paymentClient();
  try {
    const result = await readAdminChannelPaymentEvidence(pool(client), scope({ finance: false }), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.merchantIdentityId, null); assert.equal(result.merchantOrderNo, null);
    assert.equal(result.amounts.requested, null); assert.equal(result.amounts.accepted, null);
    assert.equal(result.trustedObservation?.channelTrxNo, null);
    assert.equal(result.acceptance.state, "PENDING");
    assert.ok(result.reasonCodes.includes("FINANCE_PERMISSION_REDACTED"));
    assert.ok(!JSON.stringify(result).includes("10000"));
    assert.ok(!client.calls.some(call => call.sql.includes("FROM zzsh_order.payment_confirmation")));
  } finally { restore(); }
});

test("unknown payment origin never falls back to controlled and failed bindings never promote trust", async () => {
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => paymentSummary({ dataOrigin: "UNKNOWN" }));
  const client = paymentClient({ failure: [{ event: "E4", http_status: 200, transport_failure: null,
    response_complete: true, schema_outcome: "VALID", signature_outcome: "MATCH", binding_outcome: "MISMATCH",
    raw_sha256: DIGEST_C, observed_at: ISO_3 }] });
  try {
    const result = await readAdminChannelPaymentEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.dataOrigin, "UNKNOWN");
    assert.ok(result.reasonCodes.includes("UNKNOWN_PAYMENT_SOURCE"));
    assert.ok(!JSON.stringify(result).includes("LOCAL_CONTROLLED"));
    assert.equal(result.lastFailure?.kind, "BINDING_MISMATCH");
    assert.equal(result.trustedObservation?.channelStatus, "SUCCEEDED");
    assert.equal(result.lastFailure?.usedForAcceptance, false);
  } finally { restore(); }
});

test("free-form transport failures stay transport failures and do not leak the raw message", async () => {
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => paymentSummary());
  const client = paymentClient({ failure: [{ event: "E1", http_status: 200, transport_failure: "socket reset by peer",
    response_complete: false, schema_outcome: "NOT_CHECKED", signature_outcome: "NOT_CHECKED", binding_outcome: "NOT_CHECKED",
    raw_sha256: null, observed_at: ISO_3 }] });
  try {
    const result = await readAdminChannelPaymentEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.lastFailure?.kind, "TRANSPORT_FAILURE");
    assert.equal(result.lastFailure?.failureCode, null);
    assert.ok(!JSON.stringify(result).includes("socket reset by peer"));
  } finally { restore(); }
});

test("payment evidence returns explicit not-integrated/not-applicable without inventing a request", async () => {
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => emptyPaymentSummary());
  const integratedClient = paymentClient();
  try {
    const result = await readAdminChannelPaymentEvidence(pool(integratedClient), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "NOT_INTEGRATED"); assert.equal(result.requestId, null);
    assert.ok(result.reasonCodes.includes("PAYMENT_EVIDENCE_NOT_INTEGRATED_OR_NOT_RECORDED"));
    assert.equal(integratedClient.calls.length, 1);
  } finally { restore(); }
  const legacyClient = paymentClient();
  const legacy = await readAdminChannelPaymentEvidence(pool(legacyClient), scope(), { orderId: "ord_1", origin: "LEGACY" });
  assert.equal(legacy.status, "NOT_APPLICABLE");
  assert.ok(legacy.reasonCodes.includes("LEGACY_PAYMENT_SOURCE_NOT_INTEGRATED"));
  assert.equal(legacyClient.calls.length, 1);
});

test("refund evidence separates responsibility, allocation, consumption and release without fake residual", async () => {
  const summary = refundSummary([
    refundIntent("rfi_1", "RF1", "100", "CONSUMED"),
    refundIntent("rfi_2", "RF2", "50", "ALLOCATED", "PROCESSING"),
    { ...refundIntent("rfi_3", "RF3", "30", "RELEASED", "FAILED"), observations: [{ amountCents: "100" }] } as never,
  ]);
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => summary);
  const client = refundClient();
  try {
    const result = await readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "INTEGRATED"); assert.equal(result.coverage, "LOCAL_REGISTERED_ONLY");
    assert.equal(result.intents?.length, 3);
    assert.deepEqual(result.totals, { requestedCents: "180", allocatedCents: "50", consumedCents: "100", releasedCents: "30" });
    assert.equal(result.residualCents, null);
    assert.ok(result.reasonCodes.includes("RESIDUAL_NOT_DERIVED_FROM_REQUESTS"));
    assert.equal(result.trustedActualRefundCents, null); assert.equal(result.trustedRefundTrxNo, null);
    assert.equal(result.trustedCompletedAt, null);
    assert.ok(result.reasonCodes.includes("TERMINAL_EVIDENCE_NOT_REVALIDATED"));
    assert.ok(result.reasonCodes.includes("CONSUMED_IS_LOCAL_ACCOUNTING_NOT_CHANNEL_SUCCESS"));
    assert.equal(result.posting?.responsibility?.cents, "200");
    assert.equal(result.posting?.paymentSource, "JOINPAY");
    assert.equal(result.posting?.captured?.cents, "10000");
    assert.equal(result.bankArrival, "UNKNOWN"); assert.equal(result.safeTarget, null);
    assert.ok(client.calls.length <= 5); noWrites(client.calls);
  } finally { restore(); }
});


test("C04B-02 abnormal refund basis keeps unique responsibility totals and blocked facts", async () => {
  const abnormalIntent = { ...refundIntent("rfi_abn", "RF" + "a".repeat(28), "5000", "ALLOCATED", "READY"),
    basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "pc_abn", liabilityRootId: "root_abn",
    liabilityEventId: "event_abn", firstSubmit: { dispatch: "NEVER_DISPATCHED", blockedReason: "ORIGINAL_ORDER_NO_AMBIGUOUS",
      blockedAt: ISO_1, blockedAuditCount: 1, trust: "LOCAL_AUDIT_AND_ATTEMPT" } };
  const summary = { ...refundSummary([abnormalIntent]), abnormalResponsibilities: [{
    confirmationId: "pc_abn", reasonCode: "LATE_PAYMENT", originalCents: "5000", allocatedCents: "5000",
    consumedCents: "0", releasedCents: "0", remainingCents: "0", totalsComplete: true, state: "REVIEW_REQUIRED",
    intentIds: ["rfi_abn"], liabilityRootId: "root_abn", liabilityEventId: "event_abn",
    merchantIdentityId: MERCHANT, firstSubmit: abnormalIntent.firstSubmit }],
    responsibilityBudget: { originalCents: "5000", allocatedCents: "5000", consumedCents: "0", releasedCents: "0",
      remainingCents: "0", totalsComplete: true } } as unknown as RefundSummary;
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => summary);
  const client = refundClient({ posting: [] });
  try {
    const result = await readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "INTEGRATED");
    assert.equal(result.posting, null);
    assert.equal(result.intents![0]!.basisKind, "REVIEW_CONFIRMATION");
    assert.equal(result.intents![0]!.firstSubmit!.blockedReason, "ORIGINAL_ORDER_NO_AMBIGUOUS");
    assert.equal(result.abnormalResponsibilities![0]!.originalCents, "5000");
    assert.equal(result.responsibilityTotals!.originalCents, "5000");
    assert.equal(result.responsibilityTotals!.totalsComplete, true);
    assert.ok(result.reasonCodes.includes("INTENT_TOTALS_ARE_NOT_UNIQUE_RESPONSIBILITY"));
    assert.ok(result.reasonCodes.includes("BANK_ARRIVAL_UNKNOWN"));
    noWrites(client.calls);
  } finally { restore(); }
});

test("C04B-02-R1 abnormal conflict responsibility stays visible without fake amounts", async () => {
  const summary = { ...refundSummary([]), abnormalResponsibilities: [{
    confirmationId: "pc_bad", reasonCode: "LATE_PAYMENT", originalCents: null, allocatedCents: null,
    consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, state: "CONFLICT",
    intentIds: ["rfi_bad"], liabilityRootId: null, liabilityEventId: null, merchantIdentityId: null,
    firstSubmit: null, reasonCodes: ["ABNORMAL_LIABILITY_MISMATCH"] }],
    responsibilityBudget: { originalCents: null, allocatedCents: null, consumedCents: null,
      releasedCents: null, remainingCents: null, totalsComplete: false } } as unknown as RefundSummary;
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => summary);
  const client = refundClient({ posting: [] });
  try {
    const result = await readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "INTEGRATED");
    assert.equal(result.abnormalResponsibilities!.length, 1);
    assert.equal(result.abnormalResponsibilities![0]!.state, "CONFLICT");
    assert.equal(result.abnormalResponsibilities![0]!.originalCents, null);
    assert.equal(result.abnormalResponsibilities![0]!.totalsComplete, false);
    assert.equal(result.responsibilityTotals!.totalsComplete, false);
    assert.equal(result.intentTotalsComplete, false);
    assert.equal(result.totals.requestedCents, null);
    assert.equal(result.intentTotals.allocatedCents, null);
    assert(result.abnormalResponsibilities![0]!.reasonCodes.includes("ABNORMAL_LIABILITY_MISMATCH"));
    assert(result.reasonCodes.includes("REFUND_INTENT_TOTALS_INCOMPLETE"));
    assert(!result.reasonCodes.includes("NO_LOCAL_REFUND_INTENTS"));
    noWrites(client.calls);
  } finally { restore(); }
});

test("truncated refund coverage exposes partial intents but no totals", async () => {
  const summary = { ...refundSummary([refundIntent("rfi_1", "RF1", "100", "CONSUMED")]), truncated: true } as unknown as RefundSummary;
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => summary);
  const client = refundClient();
  try {
    const result = await readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.coverage, "TRUNCATED"); assert.equal(result.intents?.length, 1);
    assert.deepEqual(result.totals, { requestedCents: null, allocatedCents: null, consumedCents: null, releasedCents: null });
    assert.ok(result.reasonCodes.includes("REFUND_COVERAGE_TRUNCATED"));
  } finally { restore(); }
});

test("refund posting anomalies are explicit and never pick the first row", async () => {
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => refundSummary([refundIntent("rfi_1", "RF1", "100", "CONSUMED")]));
  try {
    const none = refundClient({ posting: [] });
    const missing = await readAdminChannelRefundEvidence(pool(none), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(missing.posting, null); assert.ok(missing.reasonCodes.includes("SETTLEMENT_POSTING_NOT_RECORDED"));
    assert.equal(missing.totals.consumedCents, "100");

    const multiple = refundClient({ posting: [postingRow(), postingRow({ id: "spost_2" })] });
    const ambiguous = await readAdminChannelRefundEvidence(pool(multiple), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(ambiguous.posting, null); assert.ok(ambiguous.reasonCodes.includes("MULTIPLE_SETTLEMENT_POSTINGS"));

    const mismatch = refundClient({ posting: [postingRow({ captured_cents: "9999" })] });
    const bad = await readAdminChannelRefundEvidence(pool(mismatch), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(bad.posting, null); assert.ok(bad.reasonCodes.includes("POSTING_CAPTURE_MISMATCH"));

    const currency = refundClient({ posting: [postingRow({ confirmation_currency: "USD" })] });
    const nonCny = await readAdminChannelRefundEvidence(pool(currency), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(nonCny.posting, null); assert.ok(nonCny.reasonCodes.includes("RESPONSIBILITY_CURRENCY_NOT_CNY"));

    const notApplied = refundClient({ posting: [postingRow({ confirmation_disposition: "REVIEW_REQUIRED" })] });
    const unaccepted = await readAdminChannelRefundEvidence(pool(notApplied), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(unaccepted.posting, null); assert.ok(unaccepted.reasonCodes.includes("POSTING_CONFIRMATION_NOT_APPLIED"));
    noWrites(none.calls); noWrites(multiple.calls); noWrites(mismatch.calls); noWrites(currency.calls); noWrites(notApplied.calls);
  } finally { restore(); }
});

test("refund evidence flags local allocation over frozen responsibility without clipping the totals", async () => {
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => refundSummary([
    refundIntent("rfi_1", "RF1", "100", "CONSUMED"), refundIntent("rfi_2", "RF2", "50", "ALLOCATED", "PROCESSING"),
  ]));
  const client = refundClient({ posting: [postingRow({ renter_refund_cents: "140" })] });
  try {
    const result = await readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.deepEqual(result.totals, { requestedCents: "150", allocatedCents: "50", consumedCents: "100", releasedCents: "0" });
    assert.equal(result.posting?.responsibility?.cents, "140");
    assert.ok(result.reasonCodes.includes("LOCAL_REFUND_ALLOCATION_EXCEEDS_RESPONSIBILITY"));
    assert.equal(result.residualCents, null);
  } finally { restore(); }
});

test("refund evidence is forbidden without finance read and still returns responsibility when intents are unavailable", async () => {
  const forbiddenClient = refundClient();
  const forbidden = await readAdminChannelRefundEvidence(pool(forbiddenClient), scope({ finance: false }), { orderId: "ord_1", origin: "NATIVE" });
  assert.equal(forbidden.status, "FORBIDDEN"); assert.equal(forbidden.coverage, "INTENTS_UNAVAILABLE");
  assert.ok(forbidden.reasonCodes.includes("FINANCE_PERMISSION_REQUIRED"));
  assert.equal(forbiddenClient.calls.length, 1);

  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => ({
    contractVersion: "admin-order-refund-summary.v1", integration: "NOT_INTEGRATED", intents: null,
    bankArrival: "UNKNOWN", reasonCodes: ["FORMAL_REFUND_SCHEMA_UNAVAILABLE"],
  } as unknown as RefundSummary));
  const client = refundClient();
  try {
    const result = await readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "NOT_INTEGRATED"); assert.equal(result.intents, null);
    assert.equal(result.totals.requestedCents, null); assert.equal(result.posting?.responsibility?.cents, "200");
    assert.ok(result.reasonCodes.includes("FORMAL_REFUND_SCHEMA_UNAVAILABLE"));
  } finally { restore(); }
});

test("withdrawal evidence uses the original frozen target and keeps provider cost separate", async () => {
  const client = withdrawalClient();
  const result = await readAdminChannelWithdrawalEvidence(pool(client), scope(), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(result.status, "FOUND"); assert.equal(result.sourceFamily, "JOINPAY");
  assert.equal(result.userId, "user_1"); assert.equal(result.state, "SUCCEEDED");
  assert.equal(result.localFundsDisposition, "PAYOUT_POSTED");
  assert.deepEqual(result.amounts.grossDeduction, { cents: "10000", currency: "CNY" });
  assert.deepEqual(result.amounts.netPayout, { cents: "9800", currency: "CNY" });
  assert.deepEqual(result.amounts.userPolicyFee, { cents: "200", currency: "CNY" });
  assert.equal(result.amounts.actualChannelPayout, null);
  assert.equal(result.supplierCost.providerFee, null); assert.equal(result.supplierCost.providerFeeRaw, null);
  assert.deepEqual(result.supplierCost.reasons, ["PROVIDER_FEE_NOT_REVALIDATED_IN_READ"]);
  assert.equal(result.originalDestination?.cardMask, "**** **** 1234");
  assert.equal(result.originalDestination?.revision, "3"); assert.equal(result.originalDestination?.basis, "ORIGINAL_INTENT");
  assert.equal(result.channelTerminal?.platformSerialNo, "PS_1");
  assert.equal(result.channelTerminal?.terminalEvidenceId, "pwe_1");
  assert.deepEqual(result.references, { economicRootId: "fer_1", reserveEventId: "fe_1" });
  assert.equal(result.bankArrival, "UNKNOWN"); assert.equal(result.mayResubmit, false);
  assert.ok(result.reasonCodes.includes("LOCAL_SUCCESS_NOT_BANK_ARRIVAL"));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("SECRET_FULL_CARD")); assert.ok(!serialized.includes("SECRET_NAME"));
  assert.ok(!serialized.includes(admission)); assert.ok(!serialized.includes("provider_fee"));
  assert.ok(!client.calls.some(call => /receiver_account_no_enc|receiver_name_enc|withdrawal_bank_binding/i.test(call.sql)));
  assert.ok(client.calls.length <= 3); noWrites(client.calls);
});

test("withdrawal evidence preserves a known zero user fee and never substitutes provider cost", async () => {
  const client = withdrawalClient({ rows: [withdrawalRow({ fee_cents: "0", net_cents: "10000" })] });
  const result = await readAdminChannelWithdrawalEvidence(pool(client), scope(), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(result.status, "FOUND");
  assert.deepEqual(result.amounts.userPolicyFee, { cents: "0", currency: "CNY" });
  assert.equal(result.supplierCost.providerFee, null);
});

test("withdrawal evidence redacts nested money, target and channel numbers without reading encrypted card columns", async () => {
  const client = withdrawalClient({ rows: [{ id: "jwd_1", state: "SUCCEEDED", funds_disposition: "PAYOUT_POSTED",
    requires_review: false, accepted_at: ISO_1, merchant_identity_id: MERCHANT }] });
  const result = await readAdminChannelWithdrawalEvidence(pool(client), scope({ finance: false }), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(result.status, "FOUND"); assert.equal(result.financeRedacted, true);
  assert.equal(result.amounts.grossDeduction, null); assert.equal(result.amounts.userPolicyFee, null);
  assert.equal(result.originalDestination, null); assert.equal(result.merchantOrderNo, null);
  assert.equal(result.platformSerialNo, null); assert.equal(result.channelTerminal, null);
  assert.equal(result.userId, null); assert.equal(result.localFundsDisposition, null);
  assert.equal(result.acceptedAt, ISO_1);
  assert.ok(result.reasonCodes.includes("FINANCE_PERMISSION_REDACTED"));
  const rowQuery = client.calls.find(call => call.sql.includes("FROM zzsh_order.joinpay_withdrawal_intent"));
  assert.ok(rowQuery); assert.ok(!/gross_cents|net_cents|fee_cents|funds_disposition|admission_canonical|platform_serial_no|merchant_order_no/i.test(rowQuery!.sql));
  assert.ok(!client.calls.some(call => /withdrawal_bank_binding/i.test(call.sql)));
  noWrites(client.calls);
});

test("withdrawal evidence distinguishes missing, not integrated and invalid originals", async () => {
  const missing = withdrawalClient({ rows: [] });
  const notFound = await readAdminChannelWithdrawalEvidence(pool(missing), scope(), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(notFound.status, "NOT_FOUND_LOCAL"); assert.equal(missing.calls.length, 3);

  const absent = withdrawalClient({ schema: false });
  const notIntegrated = await readAdminChannelWithdrawalEvidence(pool(absent), scope(), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(notIntegrated.status, "NOT_INTEGRATED");
  assert.ok(notIntegrated.reasonCodes.includes("NATIVE_WITHDRAWAL_SCHEMA_UNAVAILABLE"));
  assert.equal(absent.calls.length, 2);

  const invalid = withdrawalClient({ rows: [withdrawalRow({ net_cents: "9700" })] });
  const unavailable = await readAdminChannelWithdrawalEvidence(pool(invalid), scope(), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.ok(unavailable.reasonCodes.includes("ORIGINAL_WITHDRAWAL_PROJECTION_INVALID"));

  const outOfScope = new FakeClient(() => { throw new Error("must not query"); });
  await assert.rejects(() => readAdminChannelWithdrawalEvidence(pool(outOfScope), scope(), { intentId: "jwd_1", merchantIdentityId: "mi_other" }),
    (error) => statusOf(error, 404, "NOT_FOUND"));
  assert.equal(outOfScope.calls.length, 0);
});

test("exact search finds an unposted payment request without joining the order", async () => {
  const client = searchClient({ product: "COLLECTION", rows: [collectionRow()] });
  const result = await searchAdminChannelOriginals(pool(client), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(result.status, "FOUND"); assert.equal(result.coverage, "LOCAL_REGISTERED_ONLY");
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0]?.objectKind, "PAYMENT_REQUEST");
  assert.equal(result.candidates[0]?.objectId, "preq_1"); assert.equal(result.candidates[0]?.requestId, "preq_1");
  assert.equal(result.candidates[0]?.orderId, "ord_1"); assert.equal(result.candidates[0]?.merchantOrderNo, "ORDER_1");
  assert.equal(result.candidates[0]?.channelTrxNo, null); assert.equal(result.candidates[0]?.channelTransactionRecorded, false);
  assert.equal(result.candidates[0]?.matchedNumberRole, "OBJECT_ORDER");
  assert.deepEqual(result.candidates[0]?.amount, { cents: "10000", currency: "CNY" });
  assert.equal(result.financialEffect, "NONE");
  const searchCall = client.calls.find(call => call.sql.includes("FROM zzsh_order.payment_request"));
  assert.ok(searchCall); assert.ok(!/rental_order/i.test(searchCall!.sql)); assert.ok(!/INNER JOIN/i.test(searchCall!.sql));
  assert.deepEqual(searchCall!.values.slice(0, 4), [MERCHANT, "ALIPAY_NATIVE", "ORDER_1", null]);
  assert.equal(searchCall!.values[4], 11);
  assert.ok(client.calls.length <= 4); noWrites(client.calls);
});

test("exact search requires both clues, rejects mixed candidates and never crosses merchant or product", async () => {
  const noMatch = searchClient({ product: "COLLECTION", rows: [] });
  const absent = await searchAdminChannelOriginals(pool(noMatch), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1", channelTrxNo: "TRX_1" });
  assert.equal(absent.status, "NOT_FOUND_LOCAL");
  assert.ok(absent.reasonCodes.includes("NOT_FOUND_LOCAL_MEANS_NOT_REGISTERED_OR_NOT_AUTHORIZED"));
  const call = noMatch.calls.find(value => value.sql.includes("FROM zzsh_order.payment_request"));
  assert.deepEqual(call!.values.slice(0, 4), [MERCHANT, "ALIPAY_NATIVE", "ORDER_1", "TRX_1"]);

  const wrongTrx = searchClient({ product: "COLLECTION", rows: [collectionRow({ channel_trx_no: "TRX_OTHER" })] });
  const mismatch = await searchAdminChannelOriginals(pool(wrongTrx), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1", channelTrxNo: "TRX_1" });
  assert.equal(mismatch.status, "UNAVAILABLE");
  assert.ok(mismatch.reasonCodes.includes("SEARCH_CANDIDATE_BINDING_MISMATCH"));

  const wrongProduct = searchClient({ product: "COLLECTION", rows: [collectionRow({ method: "WEIXIN_NATIVE" })] });
  const crossed = await searchAdminChannelOriginals(pool(wrongProduct), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(crossed.status, "UNAVAILABLE");

  const wrongMerchant = searchClient({ product: "COLLECTION", rows: [collectionRow({ merchant_identity_id: "mi_other" })] });
  const foreign = await searchAdminChannelOriginals(pool(wrongMerchant), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(foreign.status, "UNAVAILABLE");
});

test("exact search returns explicit ambiguity and bounded truncation", async () => {
  const ambiguousClient = searchClient({ product: "COLLECTION", rows: [collectionRow(), collectionRow({ request_id: "preq_2" })] });
  const ambiguous = await searchAdminChannelOriginals(pool(ambiguousClient), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(ambiguous.status, "AMBIGUOUS"); assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ambiguous.truncated, false); assert.ok(ambiguous.reasonCodes.includes("AMBIGUOUS_MORE_THAN_ONE_LOCAL_MATCH"));

  const truncatedClient = searchClient({ product: "COLLECTION", rows: [collectionRow(), collectionRow({ request_id: "preq_2" })] });
  const truncated = await searchAdminChannelOriginals(pool(truncatedClient), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1", limit: 1 });
  assert.equal(truncated.status, "AMBIGUOUS"); assert.equal(truncated.candidates.length, 1);
  assert.equal(truncated.truncated, true); assert.ok(truncated.reasonCodes.includes("CANDIDATES_TRUNCATED"));
  const call = truncatedClient.calls.find(value => value.sql.includes("FROM zzsh_order.payment_request"));
  assert.equal(call!.values[4], 2);
});

test("refund exact search follows the original payment numbers or the refund numbers, never mixed", async () => {
  const original = searchClient({ product: "REFUND", rows: [refundSearchRow()] });
  const found = await searchAdminChannelOriginals(pool(original), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "REFUND", merchantOrderNo: "ORDER_1", channelTrxNo: "PTRX_1" });
  assert.equal(found.status, "FOUND"); assert.equal(found.candidates[0]?.matchedNumberRole, "ORIGINAL_PAYMENT");
  assert.equal(found.candidates[0]?.merchantOrderNo, "RF1"); assert.equal(found.candidates[0]?.channelTrxNo, "RTRX_1");
  assert.equal(found.candidates[0]?.originalPaymentOrderNo, "ORDER_1");
  assert.equal(found.candidates[0]?.originalPaymentTrxNo, "PTRX_1");
  assert.equal(found.candidates[0]?.postingId, "spost_1");
  assert.equal(found.candidates[0]?.budgetDisposition, "CONSUMED");
  assert.equal(found.candidates[0]?.localTerminalEvidenceId, "rfe_1");

  const mixed = searchClient({ product: "REFUND", rows: [refundSearchRow()] });
  const mismatch = await searchAdminChannelOriginals(pool(mixed), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "REFUND", merchantOrderNo: "ORDER_1", channelTrxNo: "RTRX_1" });
  assert.equal(mismatch.status, "UNAVAILABLE"); assert.ok(mismatch.reasonCodes.includes("SEARCH_CLUE_MISMATCH"));
});

test("payout exact search keeps user and order links behind their own permissions", async () => {
  const client = searchClient({ product: "PAYOUT", rows: [payoutSearchRow()] });
  const found = await searchAdminChannelOriginals(pool(client), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "PAYOUT", channelTrxNo: "PS_1" });
  assert.equal(found.status, "FOUND"); assert.equal(found.candidates[0]?.objectKind, "JOINPAY_WITHDRAWAL_INTENT");
  assert.equal(found.candidates[0]?.userId, "user_1"); assert.equal(found.candidates[0]?.channelTrxNo, "PS_1");
  assert.equal(found.candidates[0]?.amount?.cents, "10000"); assert.equal(found.candidates[0]?.fundsDisposition, "PAYOUT_POSTED");
  assert.equal(found.candidates[0]?.economicRootId, "fer_1");

  const redacted = searchClient({ product: "PAYOUT", rows: [payoutSearchRow()] });
  const withoutUser = await searchAdminChannelOriginals(pool(redacted), scope({ user: false }), { merchantIdentityId: MERCHANT,
    productFamily: "PAYOUT", channelTrxNo: "PS_1" });
  assert.equal(withoutUser.candidates[0]?.userId, null);
  assert.ok(withoutUser.reasonCodes.includes("USER_LINK_REDACTED"));

  const collection = searchClient({ product: "COLLECTION", rows: [collectionRow()] });
  const withoutOrder = await searchAdminChannelOriginals(pool(collection), scope({ order: false }), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(withoutOrder.candidates[0]?.orderId, null);
  assert.ok(withoutOrder.reasonCodes.includes("ORDER_LINK_REDACTED"));
});

test("exact search rejects bad scopes and inputs before business SQL and reports missing schema", async () => {
  const noQuery = new FakeClient(() => { throw new Error("must not query"); });
  await assert.rejects(() => searchAdminChannelOriginals(pool(noQuery), scope(), { merchantIdentityId: "mi_other",
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" }), (error) => statusOf(error, 404, "NOT_FOUND"));
  await assert.rejects(() => searchAdminChannelOriginals(pool(noQuery), scope({ finance: false }), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" }), (error) => statusOf(error, 403, "FORBIDDEN"));
  await assert.rejects(() => searchAdminChannelOriginals(pool(noQuery), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE" }), (error) => statusOf(error, 400, "INVALID_ARGUMENT"));
  await assert.rejects(() => searchAdminChannelOriginals(pool(noQuery), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "NOT_A_PRODUCT" as never, merchantOrderNo: "ORDER_1" }), (error) => statusOf(error, 400, "INVALID_ARGUMENT"));
  await assert.rejects(() => searchAdminChannelOriginals(pool(noQuery), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1", limit: 21 }), (error) => statusOf(error, 400, "INVALID_ARGUMENT"));
  assert.equal(noQuery.calls.length, 0);

  const missing = searchClient({ product: "COLLECTION", rows: [], schema: false });
  const result = await searchAdminChannelOriginals(pool(missing), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(result.status, "NOT_INTEGRATED");
  assert.ok(result.reasonCodes.includes("COLLECTION_SCHEMA_UNAVAILABLE"));
  assert.ok(!missing.calls.some(call => call.sql.includes("FROM zzsh_order.payment_request") && !call.sql.includes("FROM pg_attribute")));
});

test("helper source has no pool/config/top-level I/O, no raw body, no key resolver, no lease or row lock", () => {
  const source = readFileSync(join(process.cwd(), "src/finance/channel-evidence-read.ts"), "utf8");
  for (const forbidden of [
    /\bfetch\s*\(/, /new\s+Pool\b/, /\.connect\s*\(/, /FOR\s+UPDATE/i, /pg_advisory/i,
    /\bINSERT\s+INTO\b/, /\bDELETE\s+FROM\b/, /\bTRUNCATE\b/, /\bUPDATE\s+[A-Za-z_]/,
    /\bkeyFor\b|\bkeyResolver\b|\bcapturePayoutFact\b|\breadVerifiedPayoutFact\b|\bcaptureRefundTerminalFact\b|\breadVerifiedRefundTerminalFact\b/,
    /\braw_body\b|\braw_query\b/, /receiver_account_no_enc|receiver_name_enc/, /from\s+["']\.\.\/config/,
    /\blease_version\b|\blease_owner\b/, /\bjoinpay_refund_observation\b|\bjoinpay_payout_observation\b/,
  ]) assert.doesNotMatch(source, forbidden);
});

test("Master: order evidence requires the exact object grant before SQL", async () => {
  const client = new FakeClient(() => { throw Error("must not query"); });
  const grant = scope({ orders: ["other_order"] });
  await assert.rejects(readAdminChannelPaymentEvidence(pool(client), grant, { orderId: "ord_1", origin: "NATIVE" }),
    error => statusOf(error, 404, "NOT_FOUND"));
  await assert.rejects(readAdminChannelRefundEvidence(pool(client), grant, { orderId: "ord_1", origin: "NATIVE" }),
    error => statusOf(error, 404, "NOT_FOUND"));
  assert.equal(client.calls.length, 0);
});

test("Master: payment financial evidence cannot cross the granted merchant", async () => {
  const s = paymentSummary();
  const restore = stub(paymentRead, "readOrderPaymentSummary", async () => paymentSummary({
    originalRequest: { ...s.originalRequest!, merchantIdentityId: "mi_other" },
  }));
  try {
    await assert.rejects(readAdminChannelPaymentEvidence(pool(paymentClient()), scope(), { orderId: "ord_1", origin: "NATIVE" }),
      error => statusOf(error, 404, "NOT_FOUND"));
  } finally { restore(); }
});

test("Master: refund merchant is checked both in new summary and 9cd binding fallback", async () => {
  const item = refundIntent("rfi_1", "RF1", "100", "ALLOCATED");
  let restore = stub(refundRead, "readAdminOrderRefundSummary", async () => refundSummary([
    Object.assign({}, item, { merchantIdentityId: "mi_other" }),
  ]));
  try {
    await assert.rejects(readAdminChannelRefundEvidence(pool(refundClient()), scope(), { orderId: "ord_1", origin: "NATIVE" }),
      error => statusOf(error, 404, "NOT_FOUND"));
  } finally { restore(); }
  restore = stub(refundRead, "readAdminOrderRefundSummary", async () => refundSummary([item]));
  const client = new FakeClient((sql) => {
    if (isResource(sql)) return [resource()];
    if (sql.includes("SELECT id,merchant_identity_id")) return [{ id: "rfi_1", merchant_identity_id: "mi_other" }];
    throw Error("merchant denial must precede posting reads");
  });
  try {
    await assert.rejects(readAdminChannelRefundEvidence(pool(client), scope(), { orderId: "ord_1", origin: "NATIVE" }),
      error => statusOf(error, 404, "NOT_FOUND"));
  } finally { restore(); }
});

test("Master: exact search only links individually granted orders and users", async () => {
  const grant = scope({ orders: ["other_order"], users: ["other_user"] });
  const payment = await searchAdminChannelOriginals(pool(searchClient({ product: "COLLECTION", rows: [collectionRow()] })), grant,
    { merchantIdentityId: MERCHANT, productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(payment.status, "FOUND"); assert.equal(payment.candidates[0]?.amount?.cents, "10000");
  assert.equal(payment.candidates[0]?.orderId, null); assert(payment.reasonCodes.includes("ORDER_LINK_REDACTED"));
  const payout = await searchAdminChannelOriginals(pool(searchClient({ product: "PAYOUT", rows: [payoutSearchRow()] })), grant,
    { merchantIdentityId: MERCHANT, productFamily: "PAYOUT", channelTrxNo: "PS_1" });
  assert.equal(payout.candidates[0]?.userId, null); assert(payout.reasonCodes.includes("USER_LINK_REDACTED"));
  const detail = await readAdminChannelWithdrawalEvidence(pool(withdrawalClient()), grant, { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(detail.userId, null); assert.equal(detail.amounts.grossDeduction?.cents, "10000");
});

test("Master: an accepted platform serial is not a terminal and unverified refund destination stays unknown", async () => {
  const processing = await readAdminChannelWithdrawalEvidence(pool(withdrawalClient({ rows: [withdrawalRow({
    state: "PROCESSING", funds_disposition: "RESERVED", terminal_evidence_id: null,
  })] })), scope(), { intentId: "jwd_1", merchantIdentityId: MERCHANT });
  assert.equal(processing.platformSerialNo, "PS_1"); assert.equal(processing.channelTerminal, null);
  assert(processing.reasonCodes.includes("NO_LOCAL_CHANNEL_TERMINAL"));
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => refundSummary([refundIntent("rfi_1", "RF1", "100", "CONSUMED")]));
  try {
    const refund = await readAdminChannelRefundEvidence(pool(refundClient()), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(refund.safeTarget, null); assert(refund.reasonCodes.includes("REFUND_TARGET_NOT_REVALIDATED"));
  } finally { restore(); }
});

test("Master: all transaction anchors for one request remain visible as ambiguity", async () => {
  const client = searchClient({ product: "COLLECTION", rows: [collectionRow({ channel_trx_no: "TRX_2" }), collectionRow({ channel_trx_no: "TRX_1" })] });
  const result = await searchAdminChannelOriginals(pool(client), scope(), { merchantIdentityId: MERCHANT,
    productFamily: "ALIPAY_NATIVE", merchantOrderNo: "ORDER_1" });
  assert.equal(result.status, "AMBIGUOUS"); assert.equal(result.candidates.length, 2);
  const sql = client.calls.find(call => call.sql.includes("LEFT JOIN LATERAL"))!.sql;
  assert.doesNotMatch(sql, /LIMIT 1\) t ON TRUE/);
  assert.match(sql, /t\.created_at DESC,t\.id COLLATE "C" DESC/);
});

test("Master: unknown refund budget is unavailable rather than a complete empty result", async () => {
  const item = Object.assign(refundIntent("rfi_1", "RF1", "100", "ALLOCATED"), { budgetDisposition: "UNKNOWN" });
  const restore = stub(refundRead, "readAdminOrderRefundSummary", async () => refundSummary([item]));
  try {
    const result = await readAdminChannelRefundEvidence(pool(refundClient()), scope(), { orderId: "ord_1", origin: "NATIVE" });
    assert.equal(result.status, "UNAVAILABLE"); assert.equal(result.coverage, "INTENTS_UNAVAILABLE");
    assert.equal(result.intents, null); assert.equal(result.totals.requestedCents, null);
  } finally { restore(); }
});
