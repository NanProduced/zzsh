import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import type { PoolClient } from "pg";
import { readChannelPaymentRequest, readOrderPaymentSummary } from "../src/order/channel-payment-read";

const USER = { userId: "usr_renter", sessionId: "session_read" };
const AT = "2026-10-22T03:00:00.000000Z";
const request = (patch: Record<string, unknown> = {}) => ({
  id: "payreq_1", order_id: "ord_1", channel: "JOINPAY", state: "UNKNOWN", method: "ALIPAY_NATIVE",
  amount_cents: "9999999999999999", currency: "CNY", merchant_identity_id: "mid_synthetic", channel_order_no: "ZZ261022_000123",
  config_profile_id: "profile_fixture", protocol_version: "AGG_TRADERT_2_6", key_version_ref: "kv_synthetic",
  evidence_level: "SYNTHETIC_PROTOCOL", created_at: AT, updated_at: AT, ...patch,
});
const confirmation = (patch: Record<string, unknown> = {}) => ({
  id: "payment_1", source: "CONTROLLED", disposition: "APPLIED", reason_code: null,
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
  order: { id: "ord_1", display_no: "ZZ261022-000123", status: "PENDING_PAYMENT", paid_at: null, hold_expired: false, created_at: AT },
  request: request(), confirmation: null, observations: [observation()], conflicts: [], conflicts_truncated: false, latest_observed_at: AT, ...patch,
});

// 替身仅提供单语句结果，不模拟 SQL 执行、PG 权限或事务。
function fixture(row: ReturnType<typeof snapshot> | null = snapshot(), deployment = true, owner = USER.userId) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes("to_regclass")) return { rows: [{ ready: deployment }] };
    if (sql.startsWith("SELECT id FROM zzsh_order.rental_order")) return { rows: values[1] === owner ? [{ id: "ord_1" }] : [] };
    assert.ok(sql.startsWith("WITH scoped AS"));
    return { rows: row && (values[1] === null || values[1] === owner) ? [row] : [] };
  } } as unknown as Pick<PoolClient, "query">;
  return { client, calls };
}
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
  const script = `const Module=require('node:module'),fs=require('node:fs'),net=require('node:net'),http=require('node:http'),https=require('node:https');
    require(${JSON.stringify(createRequire(__filename).resolve("../src/supply/supply-util"))});
    const load=Module._load;Module._load=function(name,...args){if(name==='pg'||name==='pg-pool')throw Error('unexpected_pg');return load.call(this,name,...args)};
    const stop=()=>{throw Error('unexpected_side_effect')};net.connect=net.createConnection=http.request=http.get=https.request=https.get=stop;
    global.setTimeout=global.setInterval=global.setImmediate=stop;
    const read=fs.readFileSync;fs.readFileSync=function(path,...args){if(/\\.env|\\.secrets/.test(String(path)))throw Error('unexpected_private_read');return read.call(this,path,...args)};
    process.env=new Proxy(process.env,{get(){throw Error('unexpected_env_read')}});
    const readModule=require(${JSON.stringify(target)});
    readModule.readOrderPaymentSummary({query:async()=>{throw Error('unexpected_sql')}},{origin:'LEGACY',orderId:'ord_1',financeReadable:false}).then(r=>{if(r.integration!=='NOT_INTEGRATED')throw Error('unexpected_result')});`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
