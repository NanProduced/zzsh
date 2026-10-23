// SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL：虚构配置/KAT/钥和内存PG替身；零真实渠道、零PG。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createJoinpayCollectionRequest, executeJoinpayCollectionAttempt, readJoinpayCollectionRecovery } from "../src/order/joinpay-collection-attempt";
import { createPaymentRequest, claimPaymentRequestLease, recordExecutorFailure, recordJoinpayNotify, bindChannelTransaction } from "../src/order/channel-payment-store";
import { bindJoinpayCollectionProfile, COLLECTION_REQUIRED_RULES, type CollectionServerProfile, type CollectionKnownAnswer } from "../src/order/joinpay-collection-profile";
import { JOINPAY_SIGNATURE_ORDER } from "../src/order/joinpay-protocol";

const KEY = "SYNTHETIC_MERCHANT_KEY_NOT_REAL", KEY2 = "SYNTHETIC_ROTATED_KEY_NOT_REAL", VECTOR_KEY = "SYNTHETIC_PUBLIC_VECTOR_KEY";
const MERCHANT = "888000000000001", ORDER = "order_model", hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const sign = (order: readonly string[], v: Record<string, string>, key = KEY) => createHash("md5").update(order.map(k => v[k] ?? "").join("") + key).digest("hex");
function descriptor(): CollectionServerProfile {
  const evidence = { source: "JOINPAY_OFFICIAL" as const, reference: "SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL_NOT_REAL", sha256: "1".repeat(64) };
  const answer = (order: readonly string[]): CollectionKnownAnswer => { const values = Object.fromEntries(order.map((k, i) => [k, "MODEL_" + i]));
    return { ...evidence, values, vectorKey: VECTOR_KEY, expectedHmac: sign(order, values, VECTOR_KEY) }; };
  return { profileId: "model_profile1", merchantIdentityId: "synthetic_stable1", wireMerchantNo: MERCHANT, tradeMerchantNo: "MODEL_TRADE",
    notifyUrl: "https://example.invalid/notify", purpose: "COLLECTION", evidenceMode: "OFFICIAL",
    operations: Object.fromEntries((["SUBMIT", "QUERY"] as const).map(op => [op, { keyVersionRef: "model_key1",
      rules: Object.fromEntries(COLLECTION_REQUIRED_RULES[op].map(r => [r, evidence])),
      requestKnownAnswer: answer(op === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPayRequest : JOINPAY_SIGNATURE_ORDER.queryOrderRequest),
      responseKnownAnswer: answer(op === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse : JOINPAY_SIGNATURE_ORDER.queryOrderResponse) }])) };
}
type Row = Record<string, any>;
function db() {
  const state = { now: 1_000_000, requests: new Map<string, Row>(), bindings: new Map<string, Row>(), attempts: [] as Row[], observations: [] as Row[],
    idem: new Map<string, Row>(), audit: [] as Row[], payable: true, confirmation: false, claimOrderOverride: null as string | null };
  const trace: string[] = []; let nextCommitLoss: "CLAIM" | "RESULT" | null = null, failAudit: "CLAIM" | "RESULT" | null = null;
  let expiresOn: "STATE_UPDATE" | "OBSERVATION_INSERT" | null = null, rejectObservation = false;
  const one = (r?: Row) => ({ rows: r ? [structuredClone(r)] : [], rowCount: r ? 1 : 0 });
  function client() { let local: typeof state | null = null, saved: typeof state | null = null, txPhase = "";
    const data = () => local ?? state;
    return { query: async (sql: string, p: any[] = []) => {
      trace.push(sql); const s = data();
      if (sql === "BEGIN") { local = structuredClone(state); txPhase = ""; return one(); }
      if (sql === "ROLLBACK") { local = null; return one(); }
      if (sql === "SAVEPOINT collection_result_effect") { saved = structuredClone(local); return one(); }
      if (sql === "ROLLBACK TO SAVEPOINT collection_result_effect") { local = structuredClone(saved); return one(); }
      if (sql === "RELEASE SAVEPOINT collection_result_effect") { saved = null; return one(); }
      if (sql === "COMMIT") { const now = state.now; if (local) Object.assign(state, local); state.now = now; local = null;
        if (nextCommitLoss === txPhase) { nextCommitLoss = null; throw Object.assign(Error("SYNTHETIC_ACK_LOSS"), { code: "ECONNRESET" }); } return one(); }
      if (sql.includes("pg_advisory_xact_lock")) return one();
      if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) return one(s.idem.get(p[0] + p[1]));
      if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) { s.idem.set(p[0] + p[1], { requestFingerprint: p[2], responseStatus: p[3], responseBody: JSON.parse(p[4]), publishRequired: false }); return one(); }
      if (sql.startsWith("SELECT renter_user_id FROM zzsh_order.rental_order")) return one({ renter_user_id: "renter" });
      if (sql.startsWith("SELECT renter_user_id, status, display_no")) return one({ renter_user_id: "renter", status: "PENDING_PAYMENT", display_no: "ZZMODEL-1", currency: "CNY", total: "12345" });
      if (sql.startsWith("SELECT hold_until > clock_timestamp()")) return one({ open: s.payable, has_confirmation: s.confirmation });
      if (sql.includes("FROM zzsh_order.payment_request WHERE order_id=$1")) return one([...s.requests.values()].find(r => r.order_id === p[0]));
      if (sql.startsWith("SELECT 1 FROM zzsh_order.payment_request WHERE channel=")) return one();
      if (sql.startsWith("INSERT INTO zzsh_order.payment_request")) { const names = ["id", "order_id", "channel", "merchant_identity_id", "config_profile_id", "protocol_version", "key_version_ref", "platform_order_no", "channel_order_no", "amount_cents", "wire_amount_yuan", "method", "evidence_level"];
        const r: Row = { ...Object.fromEntries(names.map((n, i) => [n, p[i]])), currency: "CNY", state: "SUBMITTING", revision: "1", lease_version: "0", lease_owner: null, lease_until: null,
          created_at: "2026-10-23T00:00:00.000000Z", updated_at: "2026-10-23T00:00:00.000000Z" }; s.requests.set(r.id, r); return one(r); }
      if (sql.startsWith("SELECT request_id FROM zzsh_order.joinpay_collection_binding")) return one(s.bindings.get(p[0]));
      if (sql.startsWith("INSERT INTO zzsh_order.joinpay_collection_binding")) { const names = ["request_id", "wire_merchant_no", "trade_merchant_no", "product_name", "notify_url", "initial_profile_sha256", "evidence_mode"];
        s.bindings.set(p[0], Object.fromEntries(names.map((n, i) => [n, p[i]]))); return one(); }
      if (sql.startsWith("SELECT r.id AS request_id")) { const r = s.requests.get(p[0]), b = s.bindings.get(p[0]); return one(r && b && { ...r, ...b, request_id: r.id }); }
      if (sql.startsWith("SELECT status,hold_until>clock_timestamp()")) return one({ status: "PENDING_PAYMENT", open: s.payable });
      if (sql.startsWith("UPDATE zzsh_order.payment_request\n      SET lease_version")) { const r = s.requests.get(p[0]);
        if (!r || !p[3].includes(r.state) || !p[4].includes(r.evidence_level) || (r.lease_until !== null && r.lease_until > state.now)) return one();
        Object.assign(r, { lease_version: String(BigInt(r.lease_version) + 1n), lease_owner: p[1], lease_until: state.now + p[2] * 1000, revision: String(BigInt(r.revision) + 1n) });
        txPhase = "CLAIM"; return one({ ...r, channel_order_no: s.claimOrderOverride ?? r.channel_order_no }); }
      if (sql.startsWith("INSERT INTO zzsh_order.joinpay_collection_attempt")) { const names = ["id", "request_id", "lease_version", "lease_owner", "operation", "profile_id", "profile_canonical", "profile_sha256", "key_version_ref", "evidence_mode", "request_body", "request_sha256"];
        s.attempts.push(Object.fromEntries(names.map((n, i) => [n, p[i]]))); return one(); }
      if (sql.startsWith("SELECT lease_version=$2::bigint")) { const r = s.requests.get(p[0]); return one({ current: !!r && r.lease_version === p[1] && r.lease_owner === p[2] && r.lease_until > state.now }); }
      if (sql.startsWith("UPDATE zzsh_order.payment_request SET state=")) { const r = s.requests.get(p[0]);
        if (r && expiresOn === "STATE_UPDATE") { state.now = r.lease_until + 1; expiresOn = null; }
        if (!r || r.state !== p[2] || r.revision !== p[3] || r.lease_version !== p[4] || r.lease_owner !== p[5] || r.lease_until <= state.now) return one();
        r.state = p[1]; r.revision = String(BigInt(r.revision) + 1n); return { rows: [], rowCount: 1 }; }
      if (sql.startsWith("INSERT INTO zzsh_order.joinpay_collection_observation")) { txPhase = "RESULT";
        if (expiresOn === "OBSERVATION_INSERT") { state.now = s.requests.get(p[2])!.lease_until + 1; expiresOn = null; throw Object.assign(Error("MODEL_EXPIRED_OBSERVATION"), { code: "23514", constraint: "joinpay_collection_lease_current" }); }
        if (rejectObservation) throw Object.assign(Error("MODEL_OTHER_CONSTRAINT"), { code: "23514" });
        const names = ["id", "attempt_id", "request_id", "raw_body", "raw_sha256", "http_status", "response_complete", "received_bytes", "transport_failure", "event", "result", "schema_outcome", "signature_outcome", "binding_outcome", "verified", "state_before", "state_after", "channel_status", "provider_paid_at_raw", "channel_trx_no"];
        s.observations.push(Object.fromEntries(names.map((n, i) => [n, p[i]]))); return one(); }
      if (sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')) { if (failAudit === txPhase && txPhase) throw Object.assign(Error("SYNTHETIC_AUDIT_DENIED"), { code: "42501" }); s.audit.push({ action: p[3], object: p[5] }); return one(); }
      if (sql.startsWith("SELECT a.id,a.operation")) { const a = s.attempts.filter(a => a.request_id === p[0]).at(-1); return one(a); }
      if (sql.includes("FROM zzsh_order.payment_request WHERE id=$1")) return one(s.requests.get(p[0]));
      if (sql.includes("WHERE channel='JOINPAY' AND merchant_identity_id=$1 AND channel_order_no=$2")) return one([...s.requests.values()].find(r => r.merchant_identity_id === p[0] && r.channel_order_no === p[1]));
      throw Error("UNEXPECTED_MODEL_SQL: " + sql.slice(0, 90));
    }, release: () => {} } as unknown as PoolClient;
  }
  return { state, trace, pool: { connect: async () => client() } as Pool, client,
    loseCommit: (phase: "CLAIM" | "RESULT") => { nextCommitLoss = phase; }, denyAudit: (phase: "CLAIM" | "RESULT") => { failAudit = phase; },
    expireDuringRecord: (phase: "STATE_UPDATE" | "OBSERVATION_INSERT") => { expiresOn = phase; }, rejectOtherConstraint: () => { rejectObservation = true; } };
}
async function created(model: ReturnType<typeof db>, input = descriptor()) {
  const profile = bindJoinpayCollectionProfile(input);
  const result = await createJoinpayCollectionRequest(model.pool, { actor: { userId: "renter" }, orderId: ORDER, idempotencyKey: "model_idem1", method: "ALIPAY_NATIVE", profile,
    wire: { tradeMerchantNo: input.tradeMerchantNo, productName: "虚构商品 + %26", notifyUrl: input.notifyUrl } });
  return { profile, id: result.request.requestId, result };
}
function response(query = false, key = KEY, patch: Record<string, string> = {}) {
  const values = query ? { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: "ZZMODEL_1", r3_Amount: "123.45", r5_TrxNo: "MODEL_TRX", r7_Fee: "0.00", r8_FrpCode: "ALIPAY_NATIVE",
    ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", rd_OpenId: "model", re_DiscountAmount: "0.00", rf_PayTime: "2026-10-23 10:00:00", rj_BankCode: "ALIPAY", ro_SettleAmount: "123.45", ...patch }
    : { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: "ZZMODEL_1", r3_Amount: "123.45", r4_Cur: "1", r6_FrpCode: "ALIPAY_NATIVE", r7_TrxNo: "MODEL_TRX", ra_Code: "100", rb_CodeMsg: "MODEL", rc_Result: "https://example.invalid/qr", ...patch };
  return JSON.stringify({ ...values, hmac: sign(query ? JOINPAY_SIGNATURE_ORDER.queryOrderResponse : JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse, values as Record<string, string>, key) });
}
const execution = (model: ReturnType<typeof db>, profile: ReturnType<typeof bindJoinpayCollectionProfile>, fetch: typeof globalThis.fetch) => ({ pool: model.pool, profileFor: () => profile, keyFor: () => KEY, fetch });
const fakeFetch = (body: string, callback?: (body: string) => void): typeof globalThis.fetch => (async (_url: unknown, init?: RequestInit) => { callback?.(String(init?.body)); return new Response(body, { status: 200 }); }) as typeof globalThis.fetch;

test("新入口复用对象/幂等/hold；重放保留原wire和初始profile，不依赖当前新配置", async () => {
  const model = db(), first = await created(model), bad = descriptor(); bad.operations = {};
  const replay = await createJoinpayCollectionRequest(model.pool, { actor: { userId: "renter" }, orderId: ORDER, idempotencyKey: "model_idem1", method: "ALIPAY_NATIVE", profile: bindJoinpayCollectionProfile(bad),
    wire: { tradeMerchantNo: "CHANGED", productName: "CHANGED", notifyUrl: "https://changed.invalid" } });
  assert.equal(replay.replayed, true); assert.equal(replay.request.requestId, first.id); assert.equal(model.state.bindings.size, 1);
  assert.equal(model.state.bindings.get(first.id)!.trade_merchant_no, "MODEL_TRADE");
  await assert.rejects(createJoinpayCollectionRequest(model.pool, { actor: { userId: "outsider" }, orderId: ORDER, idempotencyKey: "model_idem1", method: "ALIPAY_NATIVE", profile: first.profile,
    wire: { tradeMerchantNo: "MODEL_TRADE", productName: "商品", notifyUrl: "https://example.invalid/notify" } }), { code: "NOT_FOUND" });
  const closed = db(); closed.state.payable = false; await assert.rejects(created(closed), { code: "CONFLICT", paymentReason: "ORDER_NOT_PAYABLE" }); assert.equal(closed.state.requests.size, 0);
});
test("旧SYNTHETIC/A2/伪造profile不能创建正式候选，旧行也不能提升", async () => {
  for (const mode of ["synthetic", "a2", "forged"] as const) {
    const model = db(), input = descriptor();
    if (mode === "synthetic") { input.evidenceMode = "SYNTHETIC"; input.profileId = "SYNTHETIC_profile"; for (const op of Object.values(input.operations)) if (op) { for (const r of Object.values(op.rules)) if (r !== "NOT_OBTAINED") r.source = "SYNTHETIC"; for (const k of [op.requestKnownAnswer, op.responseKnownAnswer]) if (k !== "NOT_OBTAINED") k.source = "SYNTHETIC"; } }
    if (mode === "a2") input.purpose = "A2_SIGNATURE_ONLY";
    if (mode === "forged") { await assert.rejects(created(model, { ...input, profileId: "bad profile" })); continue; }
    await assert.rejects(created(model, input)); assert.equal(model.state.requests.size, 0);
  }
  const model = db(), p = await created(model); model.state.requests.get(p.id)!.evidence_level = "SYNTHETIC_PROTOCOL";
  for (const r of model.state.idem.values()) r.responseBody.evidenceLevel = "SYNTHETIC_PROTOCOL";
  await assert.rejects(created(model), { code: "EVIDENCE_UNAVAILABLE" }); assert.equal(model.state.attempts.length, 0);
});
test("新wire在同事务提交前走producer同一无key校验，错配/超长不留下原请求或幂等回执", async () => {
  for (const patch of [{ tradeMerchantNo: "WRONG" }, { notifyUrl: "https://wrong.invalid/notify" }, { productName: "x".repeat(31) }, { productName: "\uD800" }]) {
    const model = db(), input = descriptor();
    await assert.rejects(createJoinpayCollectionRequest(model.pool, { actor: { userId: "renter" }, orderId: ORDER, idempotencyKey: "wire_test", method: "ALIPAY_NATIVE",
      profile: bindJoinpayCollectionProfile(input), wire: { tradeMerchantNo: input.tradeMerchantNo, productName: "正常", notifyUrl: input.notifyUrl, ...patch } }));
    assert.equal(model.state.requests.size, 0); assert.equal(model.state.bindings.size, 0); assert.equal(model.state.idem.size, 0);
  }
});
test("真实调用链模型：attempt及审计提交后才发一次；保存精确出站/raw/profile原件但无APPLIED", async () => {
  const model = db(), p = await created(model), raw = response(); let calls = 0;
  const result = await executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(raw, body => { calls++; assert.equal(model.state.attempts.length, 1);
    const attempt = model.state.attempts[0]!; assert.equal(Buffer.from(attempt.request_body).toString(), body); assert.equal(attempt.request_sha256, hash(body));
    assert.equal(attempt.profile_sha256, hash(attempt.profile_canonical)); assert.equal(attempt.profile_canonical.includes(KEY), false);
  })), { requestId: p.id, workerId: "worker1" });
  assert.equal(result.kind, "OBSERVED"); assert.equal(calls, 1); assert.equal(model.state.requests.get(p.id)!.state, "ACTION_READY");
  assert.equal(model.state.observations.length, 1); const obs = model.state.observations[0]!; assert.equal(obs.raw_sha256, hash(raw)); assert.equal(Buffer.from(obs.raw_body).toString(), raw);
  assert.equal(obs.response_complete, true); assert.equal(obs.verified, true); assert.equal(model.state.requests.get(p.id)!.state === "ACCEPTED", false);
  const recovered = await readJoinpayCollectionRecovery(model.client(), p.id); assert.equal(recovered!.originalOrderNo, "ZZMODEL_1"); assert.equal(JSON.stringify(recovered).includes("hmac"), false);
});
test("QUERY轮换当前profile/key，原请求/原号/金额/稳定资金身份不变且不重发SUBMIT", async () => {
  const model = db(), p = await created(model); await executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(response())), { requestId: p.id, workerId: "worker1" });
  model.state.now += 31000; const next = descriptor(); next.profileId = "model_profile2"; next.operations.QUERY!.keyVersionRef = "model_key2";
  const used: string[] = [], original = structuredClone(model.state.requests.get(p.id));
  const result = await executeJoinpayCollectionAttempt({ pool: model.pool, profileFor: () => bindJoinpayCollectionProfile(next), keyFor: ref => { used.push(ref); return KEY2; },
    fetch: fakeFetch(response(true, KEY2), body => assert.equal(new URLSearchParams(body).get("p2_OrderNo"), "ZZMODEL_1")) }, { requestId: p.id, workerId: "worker2" });
  assert.equal(result.kind, "OBSERVED"); assert.deepEqual(used, ["model_key2"]); assert.equal(model.state.attempts[1]!.operation, "QUERY");
  assert.equal(model.state.attempts[1]!.profile_id, "model_profile2"); assert.equal(model.state.requests.get(p.id)!.config_profile_id, original!.config_profile_id);
  assert.equal(model.state.requests.get(p.id)!.key_version_ref, "model_key1"); assert.equal(model.state.requests.get(p.id)!.state, "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE");
});
test("profile回调不能原地改原号/金额，0send且不提交错误attempt", async () => {
  for (const field of ["originalOrderNo", "amountCents"] as const) { const model = db(), p = await created(model); let sent = 0;
    await assert.rejects(executeJoinpayCollectionAttempt({ pool: model.pool, profileFor: (_op, binding) => { binding[field] = "CHANGED"; return p.profile; }, keyFor: () => KEY,
      fetch: fakeFetch(response(), () => sent++) }, { requestId: p.id, workerId: "worker" }));
    assert.equal(sent, 0); assert.equal(model.state.attempts.length, 0); assert.equal(model.state.requests.get(p.id)!.channel_order_no, "ZZMODEL_1"); }
});
test("claim返回的原号必须等于私有DB快照，错绑不写attempt也不发送", async () => {
  const model = db(), p = await created(model); model.state.claimOrderOverride = "CHANGED_ORIGINAL"; let sent = 0;
  await assert.rejects(executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(response(), () => sent++)), { requestId: p.id, workerId: "worker" }), { code: "CONFLICT" });
  assert.equal(sent, 0); assert.equal(model.state.attempts.length, 0); assert.equal(model.state.requests.get(p.id)!.lease_version, "0");
});
test("CLAIM提交ACK丢失不发送；原lease过期后只QUERY原号", async () => {
  const model = db(), p = await created(model); model.loseCommit("CLAIM"); let sent = 0;
  const options = execution(model, p.profile, fakeFetch(response(true), () => sent++));
  await assert.rejects(executeJoinpayCollectionAttempt(options, { requestId: p.id, workerId: "worker1" }), { code: "PAYMENT_EXECUTION_UNKNOWN", phase: "CLAIM" });
  assert.equal(sent, 0); assert.equal(model.state.attempts.length, 1); model.state.now += 31000;
  const result = await executeJoinpayCollectionAttempt(options, { requestId: p.id, workerId: "worker2" }); assert.equal(result.kind === "OBSERVED" && result.operation, "QUERY"); assert.equal(sent, 1);
});
test("RESULT提交ACK丢失保留原件，后续恢复不重新SUBMIT", async () => {
  const model = db(), p = await created(model); model.loseCommit("RESULT"); let sent = 0, keyReads = 0;
  const options = { ...execution(model, p.profile, fakeFetch(response(), () => sent++)), keyFor: () => { keyReads++; return KEY; } };
  await assert.rejects(executeJoinpayCollectionAttempt(options, { requestId: p.id, workerId: "worker1" }), { code: "PAYMENT_EXECUTION_UNKNOWN", phase: "RESULT" });
  assert.equal(sent, 1); assert.equal(model.state.observations.length, 1);
  const skipped = await executeJoinpayCollectionAttempt(options, { requestId: p.id, workerId: "worker2" }); assert.equal(skipped.kind, "SKIPPED"); assert.equal(sent, 1); assert.equal(keyReads, 1);
});
test("旧lease晚到只追加STALE，新的owner/version/state不被覆盖", async () => {
  const model = db(), p = await created(model);
  const result = await executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(response(), () => {
    const r = model.state.requests.get(p.id)!; model.state.now += 31000; r.lease_version = "2"; r.lease_owner = "new_worker"; r.lease_until = model.state.now + 30000; r.revision = "3";
  })), { requestId: p.id, workerId: "old_worker" });
  assert.equal(result.kind === "OBSERVED" && result.observation.event, "E9"); const r = model.state.requests.get(p.id)!;
  assert.equal(r.lease_owner, "new_worker"); assert.equal(r.revision, "3"); assert.equal(r.state, "SUBMITTING"); assert.equal(model.state.observations[0]!.verified, false);
});
test("租约在状态写/观察插入间跨期：回滚局部effect后真实重核，只存一次STALE原件不重发HTTP", async () => {
  for (const stage of ["STATE_UPDATE", "OBSERVATION_INSERT"] as const) { const model = db(), p = await created(model); model.expireDuringRecord(stage); let sent = 0;
    const raw = response(); const result = await executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(raw, () => sent++)), { requestId: p.id, workerId: "worker" });
    assert.equal(sent, 1); assert.equal(result.kind === "OBSERVED" && result.observation.event, "E9"); assert.equal(model.state.requests.get(p.id)!.state, "SUBMITTING");
    assert.equal(model.state.requests.get(p.id)!.revision, "2"); assert.equal(model.state.observations.length, 1); assert.equal(model.state.observations[0]!.verified, false);
    assert.equal(Buffer.from(model.state.observations[0]!.raw_body).toString(), raw); assert.ok(model.trace.includes("ROLLBACK TO SAVEPOINT collection_result_effect"));
  }
});
test("非租约原因的23514不能吞成STALE成功", async () => { const model = db(), p = await created(model); model.rejectOtherConstraint();
  await assert.rejects(executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(response())), { requestId: p.id, workerId: "worker" }), { code: "23514" });
  assert.equal(model.state.observations.length, 0); assert.equal(model.state.requests.get(p.id)!.state, "SUBMITTING");
});
test("非200完整body及中断前缀分别保留，未知不验签不补空完整", async () => {
  for (const partial of [false, true]) { const model = db(), p = await created(model), text = "MODEL_HTTP_BODY";
    const fetch = (async () => partial ? new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); }, pull(c) { c.error(Error("MODEL_STREAM_LOST")); } }), { status: 200 })
      : new Response(text, { status: 503 })) as typeof globalThis.fetch;
    await executeJoinpayCollectionAttempt(execution(model, p.profile, fetch), { requestId: p.id, workerId: "worker" });
    const obs = model.state.observations[0]!; assert.equal(obs.verified, false); assert.equal(obs.response_complete, !partial); assert.equal(Buffer.from(obs.raw_body).toString(), text);
    assert.equal(model.state.requests.get(p.id)!.state, "UNKNOWN");
  }
});
test("审计失败整事务回滚：CLAIM不发送，RESULT不留半条观察", async () => {
  for (const phase of ["CLAIM", "RESULT"] as const) { const model = db(), p = await created(model); model.denyAudit(phase); let sent = 0;
    await assert.rejects(executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(response(), () => sent++)), { requestId: p.id, workerId: "worker" }), { code: "42501" });
    assert.equal(sent, phase === "CLAIM" ? 0 : 1); assert.equal(model.state.observations.length, 0); assert.equal(model.state.attempts.length, phase === "CLAIM" ? 0 : 1);
  }
});
test("旧合成创建重放/claim/result/通知/锚点不允许触碰正式候选", async () => {
  const model = db(), p = await created(model), c = model.client();
  await assert.rejects(createPaymentRequest(c, { actor: { userId: "renter" }, orderId: ORDER, idempotencyKey: "model_idem1", method: "ALIPAY_NATIVE" }), { code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(await claimPaymentRequestLease(c, { requestId: p.id, owner: "synthetic_worker", ttlSeconds: 10 }), null);
  await assert.rejects(recordExecutorFailure(c, { requestId: p.id, leaseVersion: "1", leaseOwner: "worker", operation: "SYNC_RESPONSE", reason: "TIMEOUT", rawRef: "model" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(recordJoinpayNotify(c, { rawQuery: `r1_MerchantNo=${MERCHANT}&r2_OrderNo=ZZMODEL_1`, rawRef: "model", resolveMerchant: () => "synthetic_stable1", keyFor: () => KEY }), { code: "EVIDENCE_UNAVAILABLE" });
  await assert.rejects(bindChannelTransaction(c, { channel: "JOINPAY", merchantIdentityId: "synthetic_stable1", channelTrxNo: "MODEL_TRX", orderId: ORDER, requestId: p.id, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" }), { code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(model.state.requests.get(p.id)!.lease_version, "0"); assert.equal(model.state.observations.length, 0);
});

test("无关23514/40001即使伴随租约到期也原样抛出，不变成STALE成功", async () => {
  for (const code of ["23514", "40001"]) { const model = db(), p = await created(model); let injected = false, sent = 0;
    const connect = model.pool.connect.bind(model.pool);
    model.pool.connect = async () => { const client = await connect(), query = client.query.bind(client);
      client.query = (async (sql: string, args?: unknown[]) => {
        if (!injected && sql.startsWith("INSERT INTO zzsh_order.joinpay_collection_observation")) {
          injected = true; model.state.now = model.state.requests.get(p.id)!.lease_until + 1;
          throw Object.assign(Error("MODEL_UNRELATED_CONSTRAINT"), { code, constraint: "unrelated_fixture_check" });
        }
        return query(sql, args);
      }) as PoolClient["query"]; return client;
    };
    await assert.rejects(executeJoinpayCollectionAttempt(execution(model, p.profile, fakeFetch(response(), () => sent++)),
      { requestId: p.id, workerId: "worker" }), { code, constraint: "unrelated_fixture_check" });
    assert.equal(sent, 1); assert.equal(model.state.observations.length, 0);
    assert.equal(model.state.requests.get(p.id)!.state, "SUBMITTING");
  }
});

test("钥提供方异常不携带钥内容且0发送、不提交attempt", async () => {
  const model = db(), p = await created(model); let sent = 0;
  await assert.rejects(executeJoinpayCollectionAttempt({ ...execution(model, p.profile, fakeFetch(response(), () => sent++)),
    keyFor: () => { throw Error(KEY + " private key details"); } }, { requestId: p.id, workerId: "worker" }), error => {
      assert.equal((error as { code?: string }).code, "COLLECTION_KEY_UNAVAILABLE");
      assert.equal(String(error).includes(KEY), false); return true;
    });
  assert.equal(sent, 0); assert.equal(model.state.attempts.length, 0);
});
