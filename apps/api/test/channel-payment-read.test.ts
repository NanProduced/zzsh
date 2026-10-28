import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import type { PoolClient } from "pg";
import { readChannelPaymentRequest, readOrderPaymentSummary } from "../src/order/channel-payment-read";
import { allowedQrUrl, readFormalPaymentEvidence } from "../src/order/channel-payment-formal-read";
import { createHash } from "node:crypto";
import { bindFormalJoinpayCollectionAdmission, bindJoinpayCollectionProfile, COLLECTION_REQUIRED_RULES,
  describeCollectionProfile, readCollectionProfileEvidence, readFormalCollectionAdmission,
  type CollectionProfileOperation, type CollectionServerProfile } from "../src/order/joinpay-collection-profile";
import { JOINPAY_SIGNATURE_ORDER, joinpayMd5Sign } from "../src/order/joinpay-protocol";

const USER = { userId: "usr_renter", sessionId: "session_read" };
const AT = "2026-10-22T03:00:00.000000Z";
const request = (patch: Record<string, unknown> = {}) => ({
  id: "payreq_1", order_id: "ord_1", channel: "JOINPAY", state: "UNKNOWN", method: "ALIPAY_NATIVE",
  amount_cents: "9999999999999999", currency: "CNY", merchant_identity_id: "mid_synthetic", channel_order_no: "ZZ261022_000123",
  config_profile_id: "profile_fixture", protocol_version: "AGG_TRADERT_2_6", key_version_ref: "kv_synthetic",
  evidence_level: "SYNTHETIC_PROTOCOL", created_at: AT, updated_at: AT, ...patch,
});
const confirmation = (patch: Record<string, unknown> = {}) => ({
  id: "payment_1", order_id: "ord_1", source: "CONTROLLED", disposition: "APPLIED", reason_code: null,
  amount_cents: "9999999999999999", currency: "CNY", accepted_at: AT, ...patch,
});
const observation = (patch: Record<string, unknown> = {}) => ({
  id: "payobs_1", request_id: "payreq_1", channel: "JOINPAY", merchant_identity_id: "mid_synthetic", channel_order_no: "ZZ261022_000123",
  config_profile_id: "profile_fixture", protocol_version: "AGG_TRADERT_2_6", key_version_ref: "kv_synthetic", operation: "QUERY_RESPONSE",
  source: "EXECUTOR", evidence_level: "SYNTHETIC_PROTOCOL", event: "E4", result: "QUERY_SUCCEEDED", reason: null,
  channel_status: "100", channel_trx_no: "trx_synthetic", provider_paid_at_raw: "2026-10-22 11:00:00", raw_sha256: "a".repeat(64),
  observed_at: AT, stale: false, late: false, conflict: false, ...patch,
});
const snapshot = (patch: Record<string, unknown> = {}) => ({
  order: { id: "ord_1", display_no: "ZZ261022-000123", status: "PENDING_PAYMENT", paid_at: null, paid_confirmation_id: "payment_1", hold_expired: false, created_at: AT },
  request: request(), confirmation: null, observations: [observation()], conflicts: [], conflicts_truncated: false, latest_observed_at: AT, ...patch,
});

// 替身仅提供单语句结果，不模拟 SQL 执行、PG 权限或事务。
type AnomalyFixture = { ready?: boolean; rows?: Record<string, unknown>[] };
function fixture(row: ReturnType<typeof snapshot> | null = snapshot(), deployment = true, owner = USER.userId, anomaly: AnomalyFixture = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes("AS anomaly_ready")) return { rows: [{ anomaly_ready: anomaly.ready !== false }] };
    if (sql.startsWith("WITH anomaly_confirmation AS")) return { rows: [{ items: anomaly.rows ?? [] }] };
    if (sql.includes("to_regclass")) return { rows: [{ ready: deployment }] };
    if (sql.startsWith("SELECT id FROM zzsh_order.rental_order")) return { rows: values[1] === owner ? [{ id: "ord_1" }] : [] };
    assert.ok(sql.startsWith("WITH scoped AS"));
    return { rows: row && (values[1] === null || values[1] === owner) ? [row] : [] };
  } } as unknown as Pick<PoolClient, "query">;
  return { client, calls };
}
const anomalyRow = (patch: Record<string, unknown> = {}) => ({
  stable_id: "CONFIRMATION:payment_2", observed_at: AT, confirmation_id: "payment_2", request_id: "payreq_1",
  disposition: "REVIEW_REQUIRED", reason_code: "DUPLICATE_PAYMENT", amount_cents: "20000", currency: "CNY",
  merchant_order_no: "ZZ261022_000123", provider_transaction_id: "trx_second", source: "JOINPAY", source_kind: "CONFIRMATION",
  merchant_identity_id: "mid_synthetic",
  evidence_raw_sha256: "b".repeat(64), event: null, result: null, schema_outcome: null, signature_outcome: null,
  binding_outcome: null, anchor_ownership: "MATCH", ...patch,
});
async function user(row = snapshot()) {
  const f = fixture(row), result = await readChannelPaymentRequest(f.client, { orderId: "ord_1", origin: "NATIVE", actor: USER });
  assert.equal(result.available, true);
  if (!result.available) throw new Error("Expected available view");
  return result.view;
}
const admin = (f: ReturnType<typeof fixture>, financeReadable = true) => readOrderPaymentSummary(f.client, { orderId: "ord_1", origin: "NATIVE", financeReadable });

test("用户状态表含 NONE、八状态和未知值；当前能力与 QR 动作始终关闭", async () => {
  const cases = [
    [null, "NOT_STARTED", "NO_REQUEST"], ["SUBMITTING", "SUBMITTING", "REQUEST_SUBMITTING"],
    ["UNKNOWN", "CONFIRMING", "CHANNEL_RESULT_UNKNOWN"], ["ACTION_READY", "AWAITING_PAYMENT", "ACTION_PARAMS_UNAVAILABLE"],
    ["PROCESSING_UNCONFIRMED", "PROCESSING", "ACTION_PARAMS_UNAVAILABLE"], ["REJECTED_BY_CHANNEL", "REJECTED", "CHANNEL_REJECTED"],
    ["CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "CONFIRMING_PAYMENT", "CHANNEL_RESULT_PENDING"], ["ACCEPTED", "PAID", "PAYMENT_ACCEPTED"],
    ["REVIEW_REQUIRED", "UNDER_REVIEW", "PAYMENT_REVIEW"], ["FUTURE_STATE", "STATUS_PENDING_CONFIRMATION", "UNKNOWN_STATE"],
    ["__proto__", "STATUS_PENDING_CONFIRMATION", "UNKNOWN_STATE"],
  ];
  for (const [state, displayState, actionBlockedReason] of cases) {
    const view = await user(snapshot({ request: state === null ? null : request({ state }), observations: [] }));
    assert.deepEqual(view.projection, { displayState, actionBlockedReason });
    assert.equal(view.paymentAction, null); assert.equal(view.capability.channelEnabled, false);
    assert.equal(view.capability.productionPaymentCapability, false);
  }
});

test("五级拦截优先级：APPLIED 高于迟到 REVIEW/取消/过期；待接纳高于取消", async () => {
  const closed = { ...snapshot().order, status: "CANCELLED", hold_expired: true };
  assert.deepEqual((await user(snapshot({ order: closed, request: request({ state: "REVIEW_REQUIRED" }), confirmation: confirmation() }))).projection,
    { displayState: "PAID", actionBlockedReason: "PAYMENT_ACCEPTED" });
  assert.deepEqual((await user(snapshot({ order: closed, request: request({ state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" }), confirmation: confirmation({ disposition: "REVIEW_REQUIRED" }) }))).projection,
    { displayState: "UNDER_REVIEW", actionBlockedReason: "PAYMENT_REVIEW" });
  assert.equal((await user(snapshot({ order: closed, request: request({ state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" }) }))).projection.displayState, "CONFIRMING_PAYMENT");
  for (const state of ["ACTION_READY", "PROCESSING_UNCONFIRMED"]) {
    assert.equal((await user(snapshot({ order: closed, request: request({ state }) }))).projection.actionBlockedReason, "ORDER_NOT_PAYABLE");
    assert.equal((await user(snapshot({ order: { ...closed, status: "PENDING_PAYMENT" }, request: request({ state }) }))).projection.actionBlockedReason, "HOLD_EXPIRED");
  }
});

test("请求终态不生成付款事实；原号恢复没有调度时间或人工补查", async () => {
  assert.equal((await user(snapshot({ request: request({ state: "ACCEPTED" }) }))).payment, null);
  const view = await user();
  assert.deepEqual(view.request?.recovery, { mode: "ORIGINAL_NUMBER_QUERY", nextAttemptAt: null, manualQueryOpen: false });
  assert.equal((await user(snapshot({ confirmation: confirmation() }))).payment?.amount?.cents, "9999999999999999");
  const summary = await admin(fixture(snapshot({ request: request({ state: "ACCEPTED" }) })));
  assert.equal(summary.acceptance?.state, "NONE"); assert.ok(summary.unknowns?.includes("REQUEST_TERMINAL_WITHOUT_CONFIRMATION"));
});

test("未部署区别于确实无请求；越权和不存在均 404，不串旧来源", async () => {
  const absent = fixture(snapshot(), false);
  assert.deepEqual(await readChannelPaymentRequest(absent.client, { origin: "NATIVE", orderId: "ord_1", actor: USER }), { available: false, reason: "SCHEMA_NOT_DEPLOYED" });
  assert.equal(absent.calls.length, 2); assert.ok(!absent.calls.some(c => c.sql.startsWith("WITH scoped")));
  assert.equal((await user(snapshot({ request: null }))).projection.displayState, "NOT_STARTED");
  for (const f of [fixture(null), fixture(snapshot(), true, "other_renter"), fixture(snapshot(), false, "other_renter")]) {
    await assert.rejects(readChannelPaymentRequest(f.client, { origin: "NATIVE", orderId: "ord_1", actor: USER }), { status: 404, code: "NOT_FOUND" });
  }
  const legacy = fixture();
  await assert.rejects(readChannelPaymentRequest(legacy.client, { origin: "LEGACY", orderId: "ord_1", actor: USER }), { status: 404 });
  assert.equal(legacy.calls.length, 0);
  await assert.rejects(readChannelPaymentRequest(legacy.client, { origin: "NATIVE", orderId: "ord_1", actor: { ...USER, sessionId: "" } }), { status: 404 });
});

test("Admin 缺部署和旧单返回完整 NOT_INTEGRATED/null 哨兵", async () => {
  for (const [origin, deployment] of [["NATIVE", false], ["LEGACY", true]] as const) {
    const f = fixture(snapshot(), deployment), summary = await readOrderPaymentSummary(f.client, { orderId: "ord_1", origin, financeReadable: true });
    assert.equal(summary.contractVersion, "admin-order-payment-summary.v1"); assert.equal(summary.integration, "NOT_INTEGRATED");
    assert.equal(summary.productionPaymentCapability, false); assert.equal(summary.settlement, "NOT_INTEGRATED");
    for (const k of ["originalRequest", "latestTrustedObservation", "acceptance", "conflicts", "recovery", "unknowns", "updatedAt"] as const) assert.equal(summary[k], null);
    assert.equal(f.calls.length, origin === "LEGACY" ? 0 : 1);
  }
  assert.equal((await admin(fixture(snapshot({ request: null, observations: [] })))).integration, "NOT_INTEGRATED");
});

test("finance.read 精确裁剪五路径，只输出白名单；父对象为空保持为空", async () => {
  const row = snapshot({ request: request({ raw_ref: "private_evidence", merchant_no: "secret_merchant", lease_owner: "hidden_lease", idempotency_key: "hidden_key", signature: "hidden_signature", binding: { secret: "nested_secret" } }),
    observations: [observation({ raw_ref: "private_url", openid: "hidden_openid", signature: "hidden_signature" })] });
  const visible = await admin(fixture(row));
  assert.equal(visible.originalRequest?.amount?.cents, "9999999999999999"); assert.equal(visible.originalRequest?.channelOrderNo, "ZZ261022_000123");
  assert.equal(visible.originalRequest?.merchantIdentityId, "mid_synthetic"); assert.equal(visible.originalRequest?.keyVersionRef, "kv_synthetic");
  assert.equal(visible.latestTrustedObservation?.channelTrxNo, "trx_synthetic");
  const hidden = await admin(fixture(row), false);
  for (const field of ["amount", "channelOrderNo", "merchantIdentityId", "keyVersionRef"] as const) assert.equal(hidden.originalRequest?.[field], null);
  assert.equal(hidden.latestTrustedObservation?.channelTrxNo, null);
  const truthy = await admin(fixture(row), "true" as unknown as boolean);
  assert.equal(truthy.originalRequest?.amount, null); assert.equal(truthy.latestTrustedObservation?.channelTrxNo, null);
  for (const view of [visible, hidden, await user(row)]) {
    assert.doesNotMatch(JSON.stringify(view), /private_evidence|secret_merchant|hidden_lease|hidden_key|hidden_signature|nested_secret|private_url|hidden_openid/);
  }
  const noRequest = await admin(fixture(snapshot({ request: null, confirmation: confirmation(), observations: [] })), false);
  assert.equal(noRequest.originalRequest, null); assert.equal(noRequest.latestTrustedObservation, null);
});

test("合成观察要求完整绑定；无效新行不能挤掉旧的合格行，缓存不能提升证据", async () => {
  const good = observation({ id: "payobs_good" });
  const invalids = [
    { evidence_level: "UNVERIFIED", verify_outcome: "VERIFIED" }, { evidence_level: "CHANNEL_SIGNED_VERIFIED" }, { stale: true }, { conflict: true },
    { request_id: "other_request" }, { channel: "CONTROLLED" }, { merchant_identity_id: null }, { merchant_identity_id: "other_merchant" },
    { channel_order_no: "other_order" }, { config_profile_id: "other_profile" }, { protocol_version: "other_protocol" }, { key_version_ref: "other_key" },
    { operation: "ACCEPTANCE", source: "ACCEPTANCE_GATE" }, { result: "BINDING_MISMATCH" }, { raw_sha256: "https://private.invalid/raw" },
  ];
  for (const invalid of invalids) {
    const bad = observation({ ...invalid, observed_at: "2026-10-22T04:00:00.000000Z" });
    const summary = await admin(fixture(snapshot({ observations: [bad, good] })));
    assert.equal(summary.latestTrustedObservation?.observedAt, AT);
    assert.equal(summary.latestTrustedObservation?.evidenceLevel, "SYNTHETIC_PROTOCOL");
    assert.equal((await admin(fixture(snapshot({ observations: [bad] })))).latestTrustedObservation, null);
  }
});

test("通知/查询/同步来源显式映射；同时间按 ID 稳定；不补渠道时区", async () => {
  const cases = [
    ["ASYNC_NOTIFY", "PROVIDER_INBOUND", "E4", "CHANNEL_SIGNED_SYNTHETIC", "NOTIFY", "SUCCEEDED"],
    ["QUERY_RESPONSE", "EXECUTOR", "E6", "CHANNEL_CREATED_UNPAID", "QUERY", "CREATED_UNPAID"],
    ["QUERY_RESPONSE", "EXECUTOR", "E5", "CHANNEL_REPORTED_FAILED", "QUERY", "FAILED"],
    ["SYNC_RESPONSE", "EXECUTOR", "E1", "ACTION_READY", "SYNC_RESPONSE", null],
    ["SYNC_RESPONSE", "EXECUTOR", "E1P", "PROCESSING_UNCONFIRMED", "SYNC_RESPONSE", null],
  ];
  for (const [operation, source, event, result, publicSource, status] of cases) {
    const summary = await admin(fixture(snapshot({ observations: [observation({ operation, source, event, result })] })));
    assert.equal(summary.latestTrustedObservation?.source, publicSource); assert.equal(summary.latestTrustedObservation?.channelStatus, status);
    assert.equal(summary.latestTrustedObservation?.providerPaidAtRaw, "2026-10-22 11:00:00"); assert.equal(summary.latestTrustedObservation?.providerTimeZone, "UNCONFIRMED");
    assert.ok(summary.unknowns?.includes("BINDING_EVIDENCE_NOT_REVERIFIED"));
  }
  for (const rows of [[observation({ id: "a", channel_trx_no: "a" }), observation({ id: "z", channel_trx_no: "z" })], [observation({ id: "z", channel_trx_no: "z" }), observation({ id: "a", channel_trx_no: "a" })]]) {
    assert.equal((await admin(fixture(snapshot({ observations: rows })))).latestTrustedObservation?.channelTrxNo, "z");
  }
});

test("CONTROLLED 本地付款与 ACCEPTANCE_GATE 不冒充供应商观察；APPLIED 不受后到观察影响", async () => {
  const row = snapshot({ request: request({ channel: "CONTROLLED", evidence_level: "CONTROLLED_TEST", state: "REVIEW_REQUIRED" }), confirmation: confirmation(),
    observations: [observation({ channel: "CONTROLLED", evidence_level: "CONTROLLED_TEST", operation: "ACCEPTANCE", source: "ACCEPTANCE_GATE", event: "E8", result: "REVIEW_REQUIRED" })] });
  const summary = await admin(fixture(row));
  assert.equal(summary.integration, "CONTROLLED_LOCAL"); assert.equal(summary.latestTrustedObservation, null); assert.equal(summary.acceptance?.state, "APPLIED");
  assert.equal((await user(row)).dataOrigin, "LOCAL_CONTROLLED"); assert.equal((await user(row)).projection.displayState, "PAID");
});

test("冲突只来自明确标志，排序稳定；有界范围与缺恢复计数明确为未知", async () => {
  const a = observation({ id: "a", stale: true }), z = observation({ id: "z", late: true, conflict: true, reason: "DUPLICATE_PAYMENT" });
  const summary = await admin(fixture(snapshot({ conflicts: [a, z], conflicts_truncated: true })));
  assert.deepEqual(summary.conflicts?.map(c => c.kind), ["LATE", "DUPLICATE", "STALE"]);
  assert.ok(summary.conflicts?.every(c => c.evidenceRef === `sha256:${"a".repeat(64)}`));
  assert.ok(summary.unknowns?.includes("CONFLICTS_TRUNCATED_TO_LATEST_100"));
  assert.deepEqual(summary.recovery, { mode: "ORIGINAL_NUMBER_QUERY", manualQueryOpen: false, lastAttemptAt: null, attempts: null });
  assert.equal(summary.updatedAt, AT);
});

test("C04A 首笔 APPLIED 保留，第二笔 REVIEW 并列且不覆盖首笔金额", async () => {
  const row = snapshot({ confirmation: confirmation({ amount_cents: "10000" }), request: request({ amount_cents: "10000" }) });
  const summary = await admin(fixture(row, true, USER.userId, { rows: [anomalyRow()] }));
  assert.equal(summary.acceptance?.state, "APPLIED");
  assert.equal(summary.acceptance?.confirmationId, "payment_1");
  assert.equal(summary.originalRequest?.amount?.cents, "10000");
  assert.equal(summary.anomalies?.status, "AVAILABLE");
  assert.equal(summary.anomalies?.truncated, false);
  const item = summary.anomalies?.items?.[0];
  assert.ok(item);
  assert.deepEqual({ kind: item.kind, source: item.source, level: item.evidenceLevel, trusted: item.trusted,
    disposition: item.disposition, reason: item.reasonCode, amount: item.amount?.cents, currency: item.currency,
    confirmation: item.confirmationId, trx: item.providerTransactionId, anchor: item.anchorOwnership },
  { kind: "DUPLICATE_PAYMENT", source: "CONFIRMATION", level: "JOINPAY_CONFIRMATION", trusted: true,
    disposition: "REVIEW_REQUIRED", reason: "DUPLICATE_PAYMENT", amount: "20000", currency: "CNY",
    confirmation: "payment_2", trx: "trx_second", anchor: "MATCH" });
  assert.deepEqual(summary.conflicts, []);
  assert.doesNotMatch(JSON.stringify(item), /refund|bankArrival|refundAction|actionAllowed/i);
});

test("C04A 迟到款只列异常，不把已取消订单复活为 PAID", async () => {
  const late = anomalyRow({ stable_id: "CONFIRMATION:payment_late", confirmation_id: "payment_late",
    disposition: "REVIEW_REQUIRED", reason_code: "LATE_PAYMENT", amount_cents: "10000", provider_transaction_id: "trx_late" });
  const row = snapshot({ order: { ...snapshot().order, status: "CANCELLED", hold_expired: true, paid_confirmation_id: null },
    request: request({ state: "REVIEW_REQUIRED" }),
    confirmation: confirmation({ id: "payment_late", source: "JOINPAY", disposition: "REVIEW_REQUIRED", reason_code: "LATE_PAYMENT", amount_cents: "10000" }),
    observations: [] });
  const view = await user(row), summary = await admin(fixture(row, true, USER.userId, { rows: [late] }));
  assert.equal(view.order.status, "CANCELLED");
  assert.equal(view.projection.displayState, "UNDER_REVIEW");
  assert.equal(view.payment?.disposition, "REVIEW_REQUIRED");
  assert.equal(summary.acceptance?.state, "REVIEW_REQUIRED");
  assert.equal(summary.anomalies?.items?.[0]?.kind, "LATE_PAYMENT");
  assert.equal(summary.anomalies?.items?.[0]?.amount?.cents, "10000");
});

test("C04A CONTROLLED 异常原款保持本地标签，不升级为 JOINPAY", async () => {
  const row = snapshot({ request: request({ channel: "CONTROLLED", evidence_level: "CONTROLLED_TEST" }),
    confirmation: confirmation({ source: "CONTROLLED", disposition: "REVIEW_REQUIRED", reason_code: "LATE_PAYMENT" }) });
  const summary = await admin(fixture(row, true, USER.userId, { rows: [anomalyRow({ source: "CONTROLLED", source_kind: "CONFIRMATION",
    reason_code: "LATE_PAYMENT" })] }));
  assert.equal(summary.integration, "CONTROLLED_LOCAL");
  const item = summary.anomalies?.items?.[0];
  assert.ok(item);
  assert.equal(item.source, "CONFIRMATION"); assert.equal(item.evidenceLevel, "CONTROLLED_CONFIRMATION");
  assert.equal(item.trusted, true); assert.equal(item.kind, "LATE_PAYMENT");
});

test("C04A 坏绑定观察无可信 confirmation 时金额、币种和流水保持 null", async () => {
  const bad = anomalyRow({ stable_id: "OBSERVATION:jpobs_bad", source_kind: "OBSERVATION", source: "JOINPAY",
    confirmation_id: null, request_id: "payreq_1", disposition: null, reason_code: null, amount_cents: null, currency: null,
    merchant_order_no: null, provider_transaction_id: null, evidence_raw_sha256: "c".repeat(64), event: "E5",
    result: "CHANNEL_REPORTED_FAILED", schema_outcome: "VALID", signature_outcome: "MATCH", binding_outcome: "MISMATCH",
    anchor_ownership: "UNKNOWN" });
  const row = snapshot({ confirmation: null, request: request({ state: "REVIEW_REQUIRED" }), observations: [] });
  const summary = await admin(fixture(row, true, USER.userId, { rows: [bad] }));
  const item = summary.anomalies?.items?.[0];
  assert.ok(item);
  assert.equal(item.kind, "BINDING_MISMATCH"); assert.equal(item.source, "OBSERVATION");
  assert.equal(item.evidenceLevel, "JOINPAY_OBSERVATION"); assert.equal(item.trusted, false);
  for (const field of ["amount", "currency", "confirmationId", "merchantOrderNo", "providerTransactionId"] as const) assert.equal(item[field], null);
  assert.equal(item.requestId, "payreq_1");
  assert.equal(item.anchorOwnership, "UNKNOWN");
  assert.equal(JSON.stringify(item).includes("bankArrival"), false);
});

test("C04A 首笔 APPLIED 的锚点缺失/错绑也列异常，但不改写 APPLIED 事实", async () => {
  const row = snapshot({ confirmation: confirmation({ source: "JOINPAY", amount_cents: "10000" }) });
  const mismatched = await admin(fixture(row, true, USER.userId, { rows: [anomalyRow({ confirmation_id: "payment_1", disposition: "APPLIED",
    reason_code: null, amount_cents: "10000", anchor_ownership: "OTHER_ORDER" })] }));
  assert.equal(mismatched.acceptance?.state, "APPLIED");
  assert.equal(mismatched.anomalies?.items?.[0]?.kind, "ANCHOR_OWNED_ELSEWHERE");
  assert.equal(mismatched.anomalies?.items?.[0]?.anchorOwnership, "OTHER_ORDER");
  assert.equal(mismatched.anomalies?.items?.[0]?.trusted, true);
  const missing = await admin(fixture(row, true, USER.userId, { rows: [anomalyRow({ confirmation_id: "payment_1", disposition: "APPLIED",
    reason_code: null, amount_cents: "10000", anchor_ownership: "MISSING" })] }));
  assert.equal(missing.acceptance?.state, "APPLIED");
  assert.equal(missing.anomalies?.items?.[0]?.kind, "UNKNOWN_REASON");
  assert.equal(missing.anomalies?.items?.[0]?.anchorOwnership, "MISSING");
});

test("C04A 审计冲突按动作分型：绑定冲突 vs 原流水归属冲突", async () => {
  const binding = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [
    anomalyRow({ stable_id: "AUDIT:a1", source_kind: "AUDIT", source: "JOINPAY", confirmation_id: null, amount_cents: null,
      currency: null, merchant_order_no: null, provider_transaction_id: null, evidence_raw_sha256: null, disposition: null,
      reason_code: null, anchor_ownership: "UNKNOWN", audit_action: "order.payment.conflict" }),
  ] }));
  assert.equal(binding.anomalies?.items?.[0]?.kind, "BINDING_MISMATCH");
  assert.equal(binding.anomalies?.items?.[0]?.source, "AUDIT");
  assert.equal(binding.anomalies?.items?.[0]?.anchorOwnership, "UNKNOWN");
  const ownership = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [
    anomalyRow({ stable_id: "AUDIT:a2", source_kind: "AUDIT", source: "JOINPAY", confirmation_id: null, amount_cents: null,
      currency: null, merchant_order_no: null, provider_transaction_id: null, evidence_raw_sha256: null, disposition: null,
      reason_code: null, anchor_ownership: "OTHER_ORDER", audit_action: "order.payment.collection.transaction.conflict" }),
  ] }));
  assert.equal(ownership.anomalies?.items?.[0]?.kind, "ANCHOR_OWNED_ELSEWHERE");
  assert.equal(ownership.anomalies?.items?.[0]?.anchorOwnership, "OTHER_ORDER");
});

test("C04A 同 trx 归属另单只给脱敏冲突，不泄露另单 ID/主体/金额", async () => {
  const other = anomalyRow({ stable_id: "EVIDENCE:jpe_other", source_kind: "EVIDENCE", source: "JOINPAY",
    confirmation_id: null, amount_cents: null, currency: null, merchant_order_no: null, provider_transaction_id: null,
    event: "E4", result: "E4", schema_outcome: "VALID", signature_outcome: "MATCH", binding_outcome: "MATCH", anchor_ownership: "OTHER_ORDER" });
  const summary = await admin(fixture(snapshot({ confirmation: null, request: request({ state: "REVIEW_REQUIRED" }), observations: [] }),
    true, USER.userId, { rows: [other] }));
  const item = summary.anomalies?.items?.[0];
  assert.ok(item);
  assert.equal(item.kind, "ANCHOR_OWNED_ELSEWHERE"); assert.equal(item.anchorOwnership, "OTHER_ORDER");
  assert.equal(item.requestId, "payreq_1"); assert.equal(Object.hasOwn(item, "anchorId"), false);
  const json = JSON.stringify(item);
  for (const secret of ["other_order", "other_user", "paytrx_", "999999", "other_amount"]) assert.equal(json.includes(secret), false);
  const hidden = await admin(fixture(snapshot({ confirmation: null, request: request({ state: "REVIEW_REQUIRED" }), observations: [] }),
    true, USER.userId, { rows: [other] }), false);
  assert.equal(hidden.anomalies?.items?.[0]?.requestId, null);
  assert.equal(hidden.anomalies?.items?.[0]?.evidenceRef, null);
});

test("C04A finance.read 不足只保留状态/理由/时间，裁掉金额与财务标识", async () => {
  const summary = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [anomalyRow()] }), false);
  const item = summary.anomalies?.items?.[0];
  assert.ok(item);
  assert.equal(item.kind, "DUPLICATE_PAYMENT"); assert.equal(item.reasonCode, "DUPLICATE_PAYMENT");
  assert.equal(item.observedAt, AT); assert.equal(item.anchorOwnership, "MATCH");
  for (const field of ["amount", "currency", "confirmationId", "requestId", "merchantIdentityId", "merchantOrderNo", "providerTransactionId", "evidenceRef"] as const) assert.equal(item[field], null);
  const json = JSON.stringify(item);
  for (const secret of ["20000", "trx_second", "payment_2", "ZZ261022_000123", "b".repeat(64)]) assert.equal(json.includes(secret), false);
});

test("C04A 50/51 条上限、稳定排序和截断状态准确", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => anomalyRow({
    stable_id: `CONFIRMATION:payment_${String(index).padStart(2, "0")}`,
    confirmation_id: `payment_${String(index).padStart(2, "0")}`,
  }));
  const summary = await admin(fixture(snapshot({ confirmation: confirmation({ amount_cents: "10000" }) }), true, USER.userId, { rows }));
  assert.equal(summary.anomalies?.truncated, true);
  assert.equal(summary.anomalies?.items?.length, 50);
  assert.equal(summary.anomalies?.items?.[0]?.confirmationId, "payment_50");
  assert.equal(summary.anomalies?.items?.[49]?.confirmationId, "payment_01");
  assert.ok(summary.unknowns?.includes("ANOMALIES_TRUNCATED_TO_LATEST_50"));
  assert.equal(Object.hasOwn(summary.anomalies!, "total"), false);
  const fifty = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: rows.slice(0, 50) }));
  assert.equal(fifty.anomalies?.truncated, false); assert.equal(fifty.anomalies?.items?.length, 50);
  const none = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [] }));
  assert.equal(none.anomalies?.status, "AVAILABLE"); assert.deepEqual(none.anomalies?.items, []);
  assert.equal(none.anomalies?.truncated, false); assert.equal(none.unknowns?.includes("ANOMALIES_TRUNCATED_TO_LATEST_50"), false);
});

test("C04A 结构缺失与确实无异常分开；NOT_INTEGRATED 保持 null", async () => {
  const missing = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { ready: false }));
  assert.deepEqual(missing.anomalies, { contractVersion: "admin-order-payment-anomalies.v1", status: "SCHEMA_NOT_DEPLOYED", limit: 50, truncated: null, items: null });
  assert.ok(missing.unknowns?.includes("ANOMALY_SCHEMA_NOT_DEPLOYED"));
  const notIntegrated = await admin(fixture(snapshot(), false));
  assert.equal(notIntegrated.integration, "NOT_INTEGRATED"); assert.equal(notIntegrated.anomalies, undefined);
});

test("C04A 未知原因/未知来源不丢行、不回显原值、不补 0", async () => {
  const future = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [
    anomalyRow({ confirmation_id: "payment_future", reason_code: "FUTURE_REASON", amount_cents: "not-a-number" }),
  ] }));
  const futureItem = future.anomalies?.items?.[0];
  assert.ok(futureItem);
  assert.equal(futureItem.kind, "UNKNOWN_REASON"); assert.equal(futureItem.reasonCode, "UNKNOWN_REASON");
  assert.equal(futureItem.amount, null); assert.equal(JSON.stringify(futureItem).includes("FUTURE_REASON"), false);
  const unknownSource = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [
    anomalyRow({ source_kind: "FUTURE_SOURCE", source: "FUTURE_SOURCE", confirmation_id: null, amount_cents: null, currency: null,
      disposition: null, reason_code: null, provider_transaction_id: null, merchant_order_no: null, evidence_raw_sha256: null, anchor_ownership: "FUTURE" }),
  ] }));
  const unknownItem = unknownSource.anomalies?.items?.[0];
  assert.ok(unknownItem);
  assert.equal(unknownItem.source, "UNKNOWN"); assert.equal(unknownItem.kind, "UNKNOWN_REASON");
  assert.equal(unknownItem.trusted, false); assert.equal(unknownItem.anchorOwnership, "UNKNOWN");
  const unconfirmed = await admin(fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [
    anomalyRow({ stable_id: "EVIDENCE:jpe_unconfirmed", source_kind: "EVIDENCE", source: "JOINPAY", confirmation_id: null,
      amount_cents: null, currency: null, merchant_order_no: null, provider_transaction_id: null, event: "E4", result: "E4",
      schema_outcome: "VALID", signature_outcome: "MATCH", binding_outcome: "MATCH", anchor_ownership: "MISSING" }),
  ] }));
  const unconfirmedItem = unconfirmed.anomalies?.items?.[0];
  assert.ok(unconfirmedItem);
  assert.equal(unconfirmedItem.kind, "UNKNOWN_REASON"); assert.equal(unconfirmedItem.reasonCode, "UNCONFIRMED_SUCCESS");
  assert.equal(unconfirmedItem.trusted, false); assert.equal(unconfirmedItem.anchorOwnership, "MISSING");
  assert.equal(unconfirmedItem.amount, null);
});

test("C04A 异常投影 SQL 错误原样传播，不吞成空异常", async () => {
  const error = Object.assign(new Error("anomaly_sql_denied"), { code: "42501" });
  const client = { async query(sql: string) {
    if (sql.includes("AS anomaly_ready")) return { rows: [{ anomaly_ready: true }] };
    if (sql.startsWith("WITH anomaly_confirmation AS")) throw error;
    if (sql.includes("to_regclass")) return { rows: [{ ready: true }] };
    if (sql.startsWith("WITH scoped AS")) return { rows: [snapshot({ confirmation: confirmation() })] };
    throw new Error("unexpected_sql");
  } } as unknown as Pick<PoolClient, "query">;
  await assert.rejects(readOrderPaymentSummary(client, { orderId: "ord_1", origin: "NATIVE", financeReadable: true }), value => value === error);
});

test("C04A 异常 SQL 只读、有界、按原锚点关联；用户 GET 不执行扫描", async () => {
  const f = fixture(snapshot({ confirmation: confirmation() }), true, USER.userId, { rows: [anomalyRow()] });
  await admin(f);
  const calls = f.calls.filter(call => call.sql.startsWith("WITH anomaly_confirmation AS"));
  assert.equal(calls.length, 1);
  const sql = calls[0]!.sql;
  assert.match(sql, /LIMIT 51/); assert.match(sql, /ORDER BY observed_at DESC,stable_id COLLATE "C" DESC/);
  assert.match(sql, /p\.joinpay_anchor_id/); assert.doesNotMatch(sql, /a\.confirmation_id/);
  for (const table of ["joinpay_collection_evidence", "joinpay_collection_observation", "payment_channel_transaction", "audit_event", "occurred_at"]) assert.match(sql, new RegExp(table));
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|LOCK|BEGIN|COMMIT)\b|FOR UPDATE|FOR SHARE|advisory|raw_body|raw_query|profile_canonical|admission_canonical|key_version_ref|key_ref|hmac|merchant_key/i);
  const userFixture = fixture(snapshot({ confirmation: confirmation() }));
  await readChannelPaymentRequest(userFixture.client, { orderId: "ord_1", origin: "NATIVE", actor: USER });
  assert.equal(userFixture.calls.length, 2);
  assert.equal(userFixture.calls.some(call => call.sql.startsWith("WITH anomaly_confirmation AS")), false);
});

test("Master：未校验绑定不等于绑定不符，先区分schema与签名结果",async()=>{
  for(const [schema,signature,binding,expected] of [
    ["INVALID","NOT_CHECKED","NOT_CHECKED","SCHEMA_INVALID"],
    ["VALID","MISMATCH","NOT_CHECKED","SIGNATURE_MISMATCH"],
    ["NOT_CHECKED","NOT_CHECKED","NOT_CHECKED","UNKNOWN_REASON"],
  ]){
    const s=await admin(fixture(snapshot({confirmation:confirmation()}),true,USER.userId,{rows:[anomalyRow({
      source_kind:"OBSERVATION",disposition:null,reason_code:null,schema_outcome:schema,
      signature_outcome:signature,binding_outcome:binding,event:"E6X",anchor_ownership:"UNKNOWN",
    })]}));
    assert.equal(s.anomalies?.items?.[0]?.reasonCode,expected);
    assert.equal(s.anomalies?.items?.[0]?.amount,null);
  }
});

test("Master SQL契约：首笔确认或历史审计不应遮住随后坏签名/绑定观察",async()=>{
  const f=fixture(snapshot({confirmation:confirmation()}));await admin(f);
  const sql=f.calls.find(c=>c.sql.startsWith("WITH anomaly_confirmation AS"))!.sql;
  assert.doesNotMatch(sql,/p\.joinpay_request_id=o\.request_id\)/);
  assert.doesNotMatch(sql,/ad\.object_id=e\.request_id\)/);
  assert.match(sql,/e\.signature_outcome IS DISTINCT FROM 'MATCH'/);
  assert.match(sql,/stable_id COLLATE "C" DESC/);
});

test("Master SQL契约：绑定冲突按既有confirmation对象和attempted.orderId定位，不拿命令号当payreq",async()=>{
  const f=fixture(snapshot({confirmation:confirmation()}));await admin(f);
  const sql=f.calls.find(c=>c.sql.startsWith("WITH anomaly_confirmation AS"))!.sql;
  assert.match(sql,/a\.object_type='payment_confirmation'/);
  assert.match(sql,/a\.details->'attempted'->>'orderId'=\$1/);
  assert.match(sql,/THEN a\.object_id ELSE NULL::text END AS request_id/);
});

test("汇聚合成请求与受控确认并存：按本地付款来源标记，并暴露请求/付款来源差异", async () => {
  for (const disposition of ["APPLIED", "REVIEW_REQUIRED"]) {
    const row = snapshot({ confirmation: confirmation({ disposition, reason_code: disposition === "APPLIED" ? null : "LATE_PAYMENT" }) });
    const view = await user(row), summary = await admin(fixture(row));
    assert.equal(view.dataOrigin, "LOCAL_CONTROLLED");
    assert.equal(view.payment?.disposition, disposition);
    assert.equal(summary.integration, "JOINPAY");
    assert.equal(summary.acceptance?.state, disposition);
    assert.ok(summary.unknowns?.includes("PAYMENT_SOURCE_DIFFERS_FROM_REQUEST"));
    assert.equal(summary.productionPaymentCapability, false);
    const originalOnly = snapshot({ request: null, confirmation: confirmation({ disposition }) });
    assert.equal((await user(originalOnly)).dataOrigin, "LOCAL_CONTROLLED");
    assert.equal((await admin(fixture(originalOnly))).integration, "CONTROLLED_LOCAL");
  }
});

test("金额全程为整数分字符串；大于安全整数亦不变，未知值不补零", async () => {
  for (const amount of ["9999999999999999", "9007199254740993", "1234567890123456789012345"]) {
    assert.equal((await user(snapshot({ request: request({ amount_cents: amount }), confirmation: confirmation({ amount_cents: amount }) }))).payment?.amount?.cents, amount);
    assert.equal((await admin(fixture(snapshot({ request: request({ amount_cents: amount }) })))).originalRequest?.amount?.cents, amount);
  }
  assert.equal((await user(snapshot({ request: request({ amount_cents: null }) }))).request?.amount, null);
  assert.equal((await user(snapshot({ confirmation: confirmation({ amount_cents: null }) }))).payment?.amount, null);
});

test("SQL 同语句读取事实，先 readiness，再按来源/renter/订单约束；无写锁或恢复副作用", async () => {
  const f = fixture(); await readChannelPaymentRequest(f.client, { orderId: "ord_1", origin: "NATIVE", actor: USER });
  assert.equal(f.calls.length, 2); assert.match(f.calls[0]!.sql, /to_regclass/);
  const { sql, values } = f.calls[1]!;
  assert.deepEqual(values, ["ord_1", "usr_renter"]); assert.match(sql, /id=\$1 AND \(\$2::text IS NULL OR renter_user_id=\$2\)/);
  assert.match(sql, /hold_until<=statement_timestamp\(\)/); assert.match(sql, /amount_cents::text/);
  assert.match(sql, /ORDER BY \(p.disposition='APPLIED'\) DESC,p.accepted_at DESC,p.id DESC LIMIT 1/);
  assert.match(sql, /p.order_id=o.id/); assert.match(sql, /p.id=o.paid_confirmation_id AND p.currency='CNY'/);
  assert.match(sql, /x.config_profile_id=r.config_profile_id/); assert.match(sql, /x.key_version_ref=r.key_version_ref/);
  assert.match(sql, /AND NOT x.stale AND NOT x.conflict/); assert.match(sql, /LIMIT 100/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|LOCK|BEGIN|COMMIT)\b|FOR SHARE|advisory|legacy_order|raw_ref|verify_outcome|lease_owner|idempotency_key/i);
  // hold 等号边界来自 SQL 布尔值，调用过程没有 JS 时钟判定。
  assert.equal((await user(snapshot({ order: { ...snapshot().order, hold_expired: true } }))).projection.actionBlockedReason, "HOLD_EXPIRED");
});

test("readiness/事实 SQL 的真实错误原样向上传播，不吞成未接入或空记录", async () => {
  for (const phase of ["readiness", "snapshot"]) {
    const error = Object.assign(new Error("sentinel_sql_failure"), { code: "42501" });
    const client = { async query(sql: string) { if (phase === "readiness" || sql.startsWith("WITH scoped")) throw error; return { rows: [{ ready: true }] }; } } as unknown as Pick<PoolClient, "query">;
    await assert.rejects(readChannelPaymentRequest(client, { origin: "NATIVE", orderId: "ord_1", actor: USER }), e => e === error);
    await assert.rejects(readOrderPaymentSummary(client, { origin: "NATIVE", orderId: "ord_1", financeReadable: true }), e => e === error);
  }
});

test("既有错误基础链加载后，支付模块导入与成功调用不建连/读配置/排任务", () => {
  const target = createRequire(__filename).resolve("../src/order/channel-payment-read");
  const script = `const assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs'),net=require('node:net'),http=require('node:http'),https=require('node:https');
    require(${JSON.stringify(createRequire(__filename).resolve("../src/supply/supply-util"))});
    const load=Module._load;Module._load=function(name,...args){if(name==='pg'||name==='pg-pool')throw Error('unexpected_pg');return load.call(this,name,...args)};
    const stop=()=>{throw Error('unexpected_side_effect')};net.connect=net.createConnection=http.request=http.get=https.request=https.get=stop;
    global.setTimeout=global.setInterval=global.setImmediate=stop;
    const read=fs.readFileSync;fs.readFileSync=function(path,...args){if(/\\.env|\\.secrets/.test(String(path)))throw Error('unexpected_private_read');return read.call(this,path,...args)};
    // Node 24 source-map caching reads this debug key while loading compiled modules.
    process.env=new Proxy(process.env,{get(env,key){if(key==='NODE_V8_COVERAGE')return Reflect.get(env,key);throw Error('unexpected_env_read')}});
    for(const key of ['JOINPAY_TEST_MERCHANT_NO','JOINPAY_TEST_MERCHANT_KEY','JOINPAY_PAYMENT_ENABLED'])assert.throws(()=>Reflect.get(process.env,key),/unexpected_env_read/);
    const readModule=require(${JSON.stringify(target)});
    readModule.readOrderPaymentSummary({query:async()=>{throw Error('unexpected_sql')}},{origin:'LEGACY',orderId:'ord_1',financeReadable:false}).then(r=>{if(r.integration!=='NOT_INTEGRATED')throw Error('unexpected_result')});`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("来源显式回退；历史正式确认不受当前新付款能力关闭影响，错绑/非CNY不当实付", async () => {
  const formal = snapshot({ confirmation: confirmation({ source: "JOINPAY", amount_cents: "15908" }), request: request({ evidence_level: "JOINPAY_CANDIDATE" }) });
  const view = await user(formal), summary = await admin(fixture(formal));
  assert.equal(view.dataOrigin, "JOINPAY_PROVIDER"); assert.equal(view.payment?.amount?.cents, "15908");
  assert.equal(summary.dataOrigin, "JOINPAY_PROVIDER"); assert.equal(summary.productionPaymentCapability, false);
  assert.equal(summary.acceptance?.state, "APPLIED"); assert.equal(summary.latestTrustedObservation, null);
  const mixed = snapshot({ confirmation: confirmation({ source: "JOINPAY", amount_cents: "15908" }), request: request({ channel: "CONTROLLED", evidence_level: "CONTROLLED_TEST" }) });
  assert.equal((await user(mixed)).dataOrigin, "JOINPAY_PROVIDER");
  const mixedSummary = await admin(fixture(mixed)); assert.equal(mixedSummary.dataOrigin, "JOINPAY_PROVIDER");
  assert.ok(mixedSummary.unknowns?.includes("PAYMENT_SOURCE_DIFFERS_FROM_REQUEST"));
  assert.equal((await user(snapshot({ request: request({ channel: "CONTROLLED", evidence_level: "CONTROLLED_TEST" }) }))).dataOrigin, "LOCAL_CONTROLLED");
  for (const patch of [{ currency: "USD" }, { id: "other_confirmation" }, { order_id: "other_order" }]) {
    assert.equal((await user(snapshot({ confirmation: confirmation({ source: "JOINPAY", ...patch }) }))).payment, null);
  }
  const unknown = await user(snapshot({ request: request({ evidence_level: "FUTURE" }) }));
  assert.equal(unknown.dataOrigin, "UNKNOWN"); assert.equal(unknown.projection.actionBlockedReason, "UNKNOWN_SOURCE"); assert.equal(unknown.paymentAction, null);
  const bad = await user(snapshot({ confirmation: confirmation({ source: "FUTURE" }) }));
  assert.equal(bad.dataOrigin, "UNKNOWN"); assert.equal(bad.payment, null);
});

test("QR精确主机门禁拒绝协议/子域/凭据/片段/端口/控制字符/超长与rd_Pic替代", () => {
  assert.equal(allowedQrUrl("https://qr.fixture.test/pay?t=1", ["qr.fixture.test"]), "https://qr.fixture.test/pay?t=1");
  for (const value of ["http://qr.fixture.test/pay", "https://qr.fixture.test.evil/pay", "https://sub.qr.fixture.test/pay", "https://user@qr.fixture.test/pay",
    "https://qr.fixture.test/pay#x", "https://qr.fixture.test:444/pay", "https://qr.fixture.test/pa\ny", "https://qr.fixture.test/" + "a".repeat(2048)])
    assert.equal(allowedQrUrl(value, ["qr.fixture.test"]), null, value);
  for (const hosts of [[], ["https://qr.fixture.test"], ["*.fixture.test"], ["qr.fixture.test:443"]]) assert.equal(allowedQrUrl("https://qr.fixture.test/pay", hosts), null);
});

// Only an offline assumption that the trusted server reviewed these inputs; no official evidence or provider success is asserted.
function readAssembly(operations: readonly CollectionProfileOperation[] = ["SUBMIT", "QUERY", "NOTIFY"]) {
  const evidence = { source: "JOINPAY_OFFICIAL" as const, reference: "fixture_document", sha256: "1".repeat(64) };
  const answer = (names: readonly string[]) => { const values = Object.fromEntries(names.map((name, i) => [name, "v" + i]));
    return { ...evidence, values, vectorKey: "fixture_only", expectedHmac: joinpayMd5Sign(names, values, "fixture_only") }; };
  const descriptor: CollectionServerProfile = { profileId: "fixture_profile", merchantIdentityId: "fixture_merchant", wireMerchantNo: "123456789", tradeMerchantNo: "fixture_trade",
    notifyUrl: "https://merchant.fixture.test/notify", purpose: "COLLECTION", evidenceMode: "OFFICIAL", operations: Object.fromEntries(operations.map(op => [op, {
      keyVersionRef: "fixture_key", rules: Object.fromEntries(COLLECTION_REQUIRED_RULES[op].map(rule => [rule, evidence])),
      requestKnownAnswer: op === "NOTIFY" ? "NOT_OBTAINED" : answer(JOINPAY_SIGNATURE_ORDER[op === "SUBMIT" ? "uniPayRequest" : "queryOrderRequest"]),
      responseKnownAnswer: answer(JOINPAY_SIGNATURE_ORDER[op === "SUBMIT" ? "uniPaySyncResponse" : op === "QUERY" ? "queryOrderResponse" : "asyncNotify"]),
      ...(op === "SUBMIT" ? {} : { timeOffsetMinutes: 480 }), ...(op === "NOTIFY" ? { notificationDecoding: { ra_PayTime: 0, rb_DealTime: 0 } } : {}) }])) };
  const profile = bindJoinpayCollectionProfile(descriptor), admission = bindFormalJoinpayCollectionAdmission({ kind: "JOINPAY_FORMAL_SERVER_REVIEW", reference: "fixture_review",
    reviewSha256: "2".repeat(64), appId: "fixture_app", database: "fixture_database", runtimeUser: "fixture_runtime", merchantIdentityId: descriptor.merchantIdentityId,
    wireMerchantNo: descriptor.wireMerchantNo, profiles: [profile] });
  return { profile, admission, descriptor };
}
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
function formalFixture() {
  const a = readAssembly(), v = readFormalCollectionAdmission(a.admission), sub = describeCollectionProfile(a.profile, "SUBMIT");
  const r = request({ evidence_level: "JOINPAY_CANDIDATE", state: "ACTION_READY", amount_cents: "12345", merchant_identity_id: a.descriptor.merchantIdentityId,
    config_profile_id: a.descriptor.profileId, key_version_ref: "fixture_key" });
  const raw = JSON.stringify({ r1_MerchantNo: a.descriptor.wireMerchantNo, r2_OrderNo: r.channel_order_no, r3_Amount: "123.45", r4_Cur: "1", r6_FrpCode: "ALIPAY_NATIVE", ra_Code: "100", rc_Result: "https://qr.fixture.test/pay" });
  const b: Record<string, any> = { request_id: r.id, wire_merchant_no: a.descriptor.wireMerchantNo, initial_profile_sha256: sub.profileSha256,
    formal_admission_ref: v.reference, formal_admission_sha256: v.sha256, formal_admission_canonical: v.canonical, observation: null,
    qr: { request_id: r.id, raw_base64: Buffer.from(raw).toString("base64"), raw_sha256: hash(raw), profile_id: sub.profileId, profile_sha256: sub.profileSha256, key_version_ref: sub.keyVersionRef } };
  const calls: string[] = [], state = { ready: true, database: v.database, runtime_user: v.runtimeUser };
  const client = { query: async (sql: string) => { calls.push(sql); return { rows: [sql.includes("formal_ready") ? { formal_ready: state.ready, ...state } : b] }; } } as unknown as Pick<PoolClient, "query">;
  return { ...a, b, r, calls, state, client, order: { id: "ord_1", status: "PENDING_PAYMENT", hold_expired: false, has_confirmation: false },
    options: { formalAdmission: a.admission, formalWriteRouteReady: true, qrHostAllowlist: ["qr.fixture.test"] } };
}

test("正式QR只读假设模型：完整品牌/写路由/部署/可信主机及原始SUBMIT齐备才给动作", async () => {
  const f = formalFixture();
  assert.equal((await readFormalPaymentEvidence(f.client, f.order, f.r, f.options)).qrUrl, "https://qr.fixture.test/pay");
  for (const options of [{}, { ...f.options, formalWriteRouteReady: false }, { ...f.options, qrHostAllowlist: [] },
    { ...f.options, formalAdmission: { ...f.admission } }, { ...f.options, formalAdmission: readAssembly(["QUERY"]).admission }]) {
    const result = await readFormalPaymentEvidence(f.client, f.order, f.r, options as typeof f.options);
    assert.equal(result.capability, false); assert.equal(result.qrUrl, null);
  }
  f.state.ready = false; assert.equal((await readFormalPaymentEvidence(f.client, f.order, f.r, f.options)).capability, false);
  f.state.ready = true; f.state.runtime_user = "other_runtime"; assert.equal((await readFormalPaymentEvidence(f.client, f.order, f.r, f.options)).qrUrl, null);
  assert.ok(f.calls.every(sql => !/\b(INSERT|UPDATE|DELETE|TRUNCATE|LOCK|BEGIN|COMMIT)\b|FOR SHARE|FOR UPDATE|advisory/i.test(sql)));
});

test("QR遵从订单/hold/确认优先级；原件SHA、初始准入、profile和请求绑定错误不回填", async () => {
  for (const order of [{ status: "CANCELLED" }, { hold_expired: true }, { has_confirmation: true }]) {
    const f = formalFixture(); assert.equal((await readFormalPaymentEvidence(f.client, { ...f.order, ...order }, f.r, f.options)).qrUrl, null);
  }
  for (const mutate of [(b: any) => b.formal_admission_sha256 = "f".repeat(64), (b: any) => b.qr.raw_sha256 = "f".repeat(64),
    (b: any) => b.qr.profile_sha256 = "f".repeat(64), (b: any) => b.qr.request_id = "other", (b: any) => b.qr.key_version_ref = "other",
    (b: any) => { const raw = JSON.stringify({ rd_Pic: "https://qr.fixture.test/pay" }); b.qr.raw_base64 = Buffer.from(raw).toString("base64"); b.qr.raw_sha256 = hash(raw); }]) {
    const f = formalFixture(); mutate(f.b); assert.equal((await readFormalPaymentEvidence(f.client, f.order, f.r, f.options)).qrUrl, null);
  }
});

test("正式观察仅用原件/准入/profile明示offset，finance裁剪后仍不返回raw或私密元数据", async () => {
  const f = formalFixture(), a = readFormalCollectionAdmission(f.admission), p = describeCollectionProfile(f.profile, "NOTIFY"), raw = "fixture_raw_notification";
  f.b.observation = { id: "jpe_fixture", request_id: f.r.id, operation: "NOTIFY", event: "E4", schema_outcome: "VALID", signature_outcome: "MATCH", binding_outcome: "MATCH",
    initial_admission_ref: a.reference, initial_admission_sha256: a.sha256, admission_ref: a.reference, admission_sha256: a.sha256, admission_canonical: a.canonical,
    profile_id: p.profileId, profile_sha256: p.profileSha256, profile_canonical: readCollectionProfileEvidence(f.profile, "NOTIFY"), key_version_ref: p.keyVersionRef,
    raw_base64: Buffer.from(raw).toString("base64"), raw_sha256: hash(raw), channel_trx_no: "fixture_trx", provider_paid_at_raw: "2026-10-23 10:00:00", provider_paid_at: "2026-10-23T02:00:00Z", observed_at: AT };
  const result = await readFormalPaymentEvidence(f.client, f.order, f.r, f.options);
  assert.equal(result.observation?.evidenceLevel, "JOINPAY_VERIFIED"); assert.equal(result.observation?.providerTimeZone, "EXPLICIT_OFFSET");
  assert.equal(result.observation?.providerTimeOffsetMinutes, 480); assert.equal(result.observation?.providerPaidAt, "2026-10-23T02:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(result), /fixture_raw_notification|profile_canonical|admission_canonical|fixture_key/);
  const localQuery = f.client.query.bind(f.client);
  const client = { query: async (sql: string, values?: unknown[]) => sql.startsWith("WITH scoped")
    ? { rows: [snapshot({ request: f.r, observations: [], order: { ...snapshot().order, paid_confirmation_id: null } })] }
    : sql.includes("AS ready") && !sql.includes("formal_ready") ? { rows: [{ ready: true }] } : localQuery(sql, values) } as unknown as Pick<PoolClient, "query">;
  const hidden = await readOrderPaymentSummary(client, { origin: "NATIVE", orderId: "ord_1", financeReadable: false }, f.options);
  for (const field of ["amount", "channelOrderNo", "merchantIdentityId", "keyVersionRef"] as const) assert.equal(hidden.originalRequest?.[field], null);
  assert.equal(hidden.latestTrustedObservation?.channelTrxNo, null); assert.equal(hidden.latestTrustedObservation?.evidenceLevel, "JOINPAY_VERIFIED");
  assert.doesNotMatch(JSON.stringify(hidden), /fixture_raw_notification|profile_canonical|admission_canonical|fixture_key|fixture_trx/);
  for (const [field, value] of [["provider_paid_at", "2026-10-23T10:00:00Z"], ["raw_sha256", "f".repeat(64)], ["initial_admission_ref", "other"], ["profile_sha256", "f".repeat(64)]]) {
    const before = f.b.observation[field!]; f.b.observation[field!] = value;
    assert.equal((await readFormalPaymentEvidence(f.client, f.order, f.r, f.options)).observation, null); f.b.observation[field!] = before;
  }
});

test("正式关系权限/SQL错误不能吞成无原件", async () => {
  const error = Object.assign(new Error("sql_denied"), { code: "42501" }), f = formalFixture();
  const client = { query: async () => { throw error; } } as unknown as Pick<PoolClient, "query">;
  await assert.rejects(readFormalPaymentEvidence(client, f.order, f.r, f.options), e => e === error);
});
