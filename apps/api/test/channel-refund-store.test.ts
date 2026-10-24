// 内存分支/事务边界检查；不证明SQL约束、真实并发或真实渠道通过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../src/config/config";
import { withTransaction } from "../src/auth/security-core";
import { fingerprintRequest } from "../src/supply/supply-util";
import { createSyntheticChannelRequestCapability } from "../src/order/channel-payment-store";
import { claimRefundIntent, createNativeRefundIntent, createFormalRefundIntent, readRecoverableRefundIntent, recordRefundTransportFailure } from "../src/order/channel-refund-store";

const config = { profile: "test", provider: "fake", testOperationsEnabled: true,
  database: { target: "local-compose", host: "127.0.0.1", port: 55432, name: "zzsh_test_order_refund_synth", user: "zzsh_order_refund_synth_r" } } as AppConfig;
const cap = () => createSyntheticChannelRequestCapability({ config, resourceSet: "refund_synth", evidenceLevel: "CONTROLLED_TEST" });
type Row = Record<string, any>;
function fakeDb() {
  const s = { now: 1_000_000, isolation: "read committed", auditFailure: false, expireOnLock: false,
    basis: { order_id: "order_1", payment_confirmation_id: "payment_1", renter_user_id: "renter_1", version_hash: "a".repeat(64),
      due_at: new Date(0).toISOString(), source: "CONTROLLED", merchant_scope_id: "merchant_synth", provider_transaction_id: "paid_synth",
      merchant_order_no: "ZZ20261019-000002", paid_cents: "1000", responsibility_cents: "600", currency: "CNY" } as Row | null,
    intents: new Map<string, Row>(), observations: [] as Row[], audits: [] as Row[], seen: [] as string[], rollbacks: 0 };
  let snapshot: { intents: Map<string, Row>; observations: Row[]; audits: Row[] } | undefined;
  const one = (row?: Row) => ({ rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 });
  const query = async (sql: string, p: any[] = []) => {
    s.seen.push(sql);
    if (sql === "BEGIN") { snapshot = structuredClone({ intents: s.intents, observations: s.observations, audits: s.audits }); return one(); }
    if (sql === "COMMIT") { snapshot = undefined; return one(); }
    if (sql === "ROLLBACK") { assert.ok(snapshot); Object.assign(s, snapshot); snapshot = undefined; s.rollbacks++; return one(); }
    if (sql.includes("current_database() AS db")) return one({ db: config.database.name, actor: config.database.user });
    if (sql.includes("current_setting('transaction_isolation')")) return one({ isolation: s.isolation });
    if (sql.includes("FROM zzsh_order.settlement_posting")) return p[0] === "posting_1" ? one(s.basis ?? undefined) : one();
    if (sql.includes("pg_advisory_xact_lock")) return one();
    if (sql.includes("WHERE posting_id=$1 AND idempotency_key=$2")) return one([...s.intents.values()].find(r => r.posting_id === p[0] && r.idempotency_key === p[1]));
    if (sql.includes("COALESCE(sum(amount_cents)")) {
      const rows = [...s.intents.values()].filter(r => r.payment_source === p[0] && r.merchant_identity_id === p[1] && r.original_payment_trx_no === p[2]);
      const total = (selected: Row[]) => selected.reduce((n, r) => n + BigInt(r.amount_cents), 0n).toString();
      return one({ paid_allocated: total(rows), responsibility_allocated: total(rows.filter(r => r.posting_id === p[3])) });
    }
    if (sql.includes("INSERT INTO zzsh_order.channel_refund_intent")) {
      const r = { id: p[0], posting_id: p[1], order_id: p[2], payment_confirmation_id: p[3], renter_user_id: p[4],
        payment_source: p[5], merchant_identity_id: p[6], original_payment_trx_no: p[7], original_payment_order_no: p[8],
        responsibility_version_hash: p[9], refund_order_no: p[10], amount_cents: p[11], currency: "CNY", idempotency_key: p[12],
        request_fingerprint: p[13], due_at: p[14], state: "READY", revision: "1", lease_version: "0", lease_owner: null, lease_until: null };
      s.intents.set(r.id, r); return one(r);
    }
    if (sql.includes("FROM zzsh_order.channel_refund_intent WHERE id=$1")) {
      const r = s.intents.get(p[0]); if (r && sql.includes("FOR UPDATE") && s.expireOnLock) { s.now = r.lease_until; s.expireOnLock = false; }
      return one(r);
    }
    if (sql.includes("UPDATE zzsh_order.channel_refund_intent SET")) {
      const r = s.intents.get(p[0]); if (!r) return one();
      if (sql.includes("lease_version=lease_version+1")) {
        if (new Date(r.due_at).getTime() > s.now || (r.lease_until !== null && r.lease_until > s.now)) return one();
        Object.assign(r, { state: r.state === "READY" ? "SUBMITTING" : "UNKNOWN", lease_version: String(BigInt(r.lease_version) + 1n),
          lease_owner: p[1], lease_until: s.now + p[2] * 1000, revision: String(BigInt(r.revision) + 1n) });
      } else {
        if (!["SUBMITTING", "UNKNOWN"].includes(r.state) || r.lease_version !== p[1] || r.lease_owner !== p[2] || r.lease_until <= s.now) return one();
        r.state = "UNKNOWN"; r.revision = String(BigInt(r.revision) + 1n);
      }
      return one(r);
    }
    if (sql.includes("INSERT INTO zzsh_order.channel_refund_observation")) {
      s.observations.push({ id: p[0], intent_id: p[1], event: p[2], reason: p[3], version: p[4], owner: p[5], before: p[6], after: p[7], requestId: p[8] }); return one();
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) {
      if (s.auditFailure) throw Error("AUDIT_UNAVAILABLE"); s.audits.push({ action: p[4], objectId: p[6], details: JSON.parse(p[10]) }); return one();
    }
    throw Error(`UNEXPECTED_SQL:${sql}`);
  };
  const client = { query, release() {} } as unknown as PoolClient;
  return { s, client, pool: { connect: async () => client } as Pool };
}
const reserve = (db: ReturnType<typeof fakeDb>, amountCents = "150", idempotencyKey = "partial_1", capability: unknown = cap()) =>
  createNativeRefundIntent(db.client, { postingId: "posting_1", amountCents, idempotencyKey, requestId: "request_1", capability });
const claim = (db: ReturnType<typeof fakeDb>, intentId: string, owner = "worker_1") =>
  claimRefundIntent(db.client, { intentId, owner, ttlSeconds: 30, requestId: "claim_1", capability: cap() });
const failure = (db: ReturnType<typeof fakeDb>, intentId: string, version = "1", owner = "worker_1") =>
  recordRefundTransportFailure(db.client, { intentId, version, owner, reason: "TIMEOUT", requestId: "failure_1", capability: cap() });

test("部分退款占用冻结责任；原支付号与分精度保持，额度不是退款到账", async () => {
  const db = fakeDb(), first = await reserve(db), second = await reserve(db, "450", "partial_2");
  assert.equal(first.intent.originalPayment.orderNo, "ZZ20261019-000002");
  assert.match(first.intent.refundOrderNo, /^RF[0-9a-f]{28}$/); assert.notEqual(second.intent.refundOrderNo, first.intent.refundOrderNo);
  assert.equal(first.intent.amountCents, "150"); assert.equal(first.intent.budgetDisposition, "ALLOCATED");
  assert.equal(first.intent.formalRefund, false); assert.equal(first.intent.sendable, false); assert.equal(first.intent.evidenceLevel, "CONTROLLED_TEST");
  await assert.rejects(reserve(db, "1", "partial_3"), /exceeds/); assert.equal(db.s.intents.size, 2);
  const lock = db.s.seen.findIndex(q => q.includes("pg_advisory_xact_lock"));
  assert.ok(lock < db.s.seen.findIndex(q => q.includes("COALESCE(sum(amount_cents)")));
});

test("同key重放优先于已用满额度，同key异金额拒绝，不追加意图或成功审计", async () => {
  const db = fakeDb(), first = await reserve(db, "600"); await claim(db, first.intent.intentId); await failure(db, first.intent.intentId);
  const auditCount = db.s.audits.length, replay = await reserve(db, "600");
  assert.equal(replay.replayed, true); assert.equal(replay.intent.intentId, first.intent.intentId); assert.equal(replay.intent.state, "UNKNOWN");
  assert.equal(replay.intent.refundOrderNo, first.intent.refundOrderNo); assert.equal(db.s.audits.length, auditCount);
  await assert.rejects(reserve(db, "599"), (e: any) => e.code === "IDEMPOTENCY_KEY_REUSED"); assert.equal(db.s.intents.size, 1);
});

test("责任与原付款两道金额上限都保留，UNKNOWN继续占用", async () => {
  const db = fakeDb(); db.s.basis!.paid_cents = "200";
  const first = await reserve(db, "200"); await claim(db, first.intent.intentId); await failure(db, first.intent.intentId);
  await assert.rejects(reserve(db, "1", "next"), /exceeds/); assert.equal(db.s.intents.size, 1);
});

test("正整数分和出站边界：不用浮点，不接0、负数、小数、前导0或超限", async () => {
  const db = fakeDb();
  for (const amount of ["0", "-1", "1.1", "01", "99999999999999999", 1, null]) await assert.rejects(reserve(db, amount as string));
  db.s.basis!.paid_cents = db.s.basis!.responsibility_cents = "9999999999999999";
  assert.equal((await reserve(db, "9999999999999999")).intent.amountCents, "9999999999999999");
});

test("没有完整原责任、币种或受控源时拒绝；不能将JOINPAY合成能力升级为退款", async () => {
  const missing = fakeDb(); missing.s.basis = null; await assert.rejects(reserve(missing), /not found/i);
  for (const [field, value] of [["source", "JOINPAY"], ["currency", "USD"]]) {
    const db = fakeDb(); db.s.basis![field!] = value; await assert.rejects(reserve(db), /source unavailable/);
  }
  const db = fakeDb(); await assert.rejects(reserve(db, "150", "key", {}));
  const synthetic = createSyntheticChannelRequestCapability({ config, resourceSet: "refund_synth", evidenceLevel: "SYNTHETIC_PROTOCOL" });
  await assert.rejects(reserve(db, "150", "key", synthetic)); assert.equal(db.s.intents.size, 0);
  db.s.isolation = "repeatable read"; await assert.rejects(reserve(db), /READ COMMITTED/);
});

test("到期之前允许保留意图但不领取；到期后首次领取只返回SUBMIT，原号不变", async () => {
  const db = fakeDb(); db.s.basis!.due_at = new Date(db.s.now + 2000).toISOString();
  const { intent } = await reserve(db); assert.equal(await claim(db, intent.intentId), null);
  db.s.now += 2000; const lease = await claim(db, intent.intentId); assert.ok(lease);
  assert.equal(lease.operation, "SUBMIT"); assert.equal(lease.version, "1"); assert.equal(lease.intent.state, "SUBMITTING");
  assert.equal(lease.intent.refundOrderNo, intent.refundOrderNo); assert.equal(await claim(db, intent.intentId, "worker_2"), null);
});

test("已领取后崩溃：租约到期只QUERY原号，不重新申请或释放额度", async () => {
  const db = fakeDb(), { intent } = await reserve(db, "600"); await claim(db, intent.intentId); db.s.now += 30000;
  const recovered = await claim(db, intent.intentId, "worker_2"); assert.ok(recovered);
  assert.equal(recovered.operation, "QUERY"); assert.equal(recovered.version, "2"); assert.equal(recovered.intent.state, "UNKNOWN");
  assert.equal(recovered.intent.refundOrderNo, intent.refundOrderNo); assert.equal(recovered.intent.budgetDisposition, "ALLOCATED");
  await assert.rejects(reserve(db, "1", "another"), /exceeds/);
});

test("有效lease的超时追加UNKNOWN；过期、错owner或旧版本只追加STALE", async () => {
  const db = fakeDb(), { intent } = await reserve(db); await claim(db, intent.intentId);
  const unknown = await failure(db, intent.intentId); assert.equal(unknown.event, "UNKNOWN"); assert.equal(unknown.intent.state, "UNKNOWN");
  const unchanged = structuredClone(db.s.intents.get(intent.intentId));
  assert.equal((await failure(db, intent.intentId, "1", "worker_other")).event, "STALE");
  assert.equal((await failure(db, intent.intentId, "2")).event, "STALE"); db.s.now += 30000;
  assert.equal((await failure(db, intent.intentId)).event, "STALE"); assert.deepEqual(db.s.intents.get(intent.intentId), unchanged);
  assert.equal(db.s.observations.length, 4); assert.ok(db.s.audits.every(r => r.details.formalRefund === false));
});

test("行锁等待跨过lease截止，写回检查使用锁后时钟，只追加STALE", async () => {
  const db = fakeDb(), { intent } = await reserve(db); await claim(db, intent.intentId);
  const before = structuredClone(db.s.intents.get(intent.intentId)); db.s.expireOnLock = true;
  assert.equal((await failure(db, intent.intentId)).event, "STALE"); assert.deepEqual(db.s.intents.get(intent.intentId), before);
});

test("恢复reader无写入；没有记录保持null", async () => {
  const db = fakeDb(), { intent } = await reserve(db); db.s.seen = [];
  assert.equal((await readRecoverableRefundIntent(db.client, intent.intentId, cap()))?.originalPayment.orderNo, "ZZ20261019-000002");
  assert.equal(await readRecoverableRefundIntent(db.client, "refund_missing", cap()), null);
  assert.equal(db.s.seen.some(q => /^(INSERT|UPDATE|DELETE)/.test(q)), false);
});

test("无效key/标识/lease和非字符串版本在写前拒绝", async () => {
  const db = fakeDb(); for (const key of [undefined, "", "bad key"]) await assert.rejects(createNativeRefundIntent(db.client, {
    postingId: "posting_1", amountCents: "150", idempotencyKey: key, requestId: "request", capability: cap() }));
  const { intent } = await reserve(db);
  for (const ttlSeconds of [0, 3601, NaN, 1.5, Infinity]) await assert.rejects(claimRefundIntent(db.client, {
    intentId: intent.intentId, owner: "worker", ttlSeconds, requestId: "claim", capability: cap() }));
  for (const version of [0, 1, "0", "-1", "1.1", "9223372036854775808"]) await assert.rejects(failure(db, intent.intentId, version as string));
  await assert.rejects(readRecoverableRefundIntent(db.client, "bad id", cap()));
  assert.equal(db.s.observations.length, 0);
});

test("审计失败向事务所有者传播；内存事务回滚意图、租约、观察，非PG证据", async () => {
  const db = fakeDb(); db.s.auditFailure = true;
  await assert.rejects(withTransaction(db.pool, client => createNativeRefundIntent(client, {
    postingId: "posting_1", amountCents: "150", idempotencyKey: "key", requestId: "request", capability: cap() })), /AUDIT_UNAVAILABLE/);
  assert.equal(db.s.intents.size, 0); db.s.auditFailure = false; const { intent } = await reserve(db); db.s.auditFailure = true;
  await assert.rejects(withTransaction(db.pool, client => claimRefundIntent(client, {
    intentId: intent.intentId, owner: "worker_1", ttlSeconds: 30, requestId: "claim", capability: cap() })), /AUDIT_UNAVAILABLE/);
  assert.equal(db.s.intents.get(intent.intentId)?.state, "READY");
  db.s.auditFailure = false; await claim(db, intent.intentId);
  const before = structuredClone(db.s.intents.get(intent.intentId)); db.s.auditFailure = true;
  await assert.rejects(withTransaction(db.pool, client => recordRefundTransportFailure(client, {
    intentId: intent.intentId, owner: "worker_1", version: "1", reason: "TIMEOUT", requestId: "request", capability: cap() })), /AUDIT_UNAVAILABLE/);
  assert.deepEqual(db.s.intents.get(intent.intentId), before); assert.equal(db.s.observations.length, 0); assert.equal(db.s.rollbacks, 3);
});

test("候选SQL保留来源/追加与不释放边界；本检查不执行DDL", () => {
  const fromApi = join(process.cwd(), "test/fixtures/channel-refund-schema.sql");
  const sql = readFileSync(existsSync(fromApi) ? fromApi : join(process.cwd(), "apps/api/test/fixtures/channel-refund-schema.sql"), "utf8");
  assert.match(sql, /payment_source = 'CONTROLLED'/); assert.match(sql, /amount_cents = trunc\(amount_cents\)/);
  assert.match(sql, /LANGUAGE plpgsql VOLATILE/); assert.match(sql, /current_setting\('transaction_isolation'\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE/); assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.ok(sql.indexOf("PERFORM pg_advisory_xact_lock") < sql.indexOf("SELECT COALESCE(sum(amount_cents)"));
  assert.doesNotMatch(sql, /GRANT|APPLIED_REFUND|SUCCEEDED|REFUNDED|RELEASED|009[0-9]_/);
});
test("旧CONTROLLED入口不能claim/read/record新JOINPAY行，原公共形状不升级",async()=>{
  const db=fakeDb(),{intent}=await reserve(db); const row=db.s.intents.get(intent.intentId)!;row.payment_source="JOINPAY";row.evidence_level="JOINPAY_FORMAL";
  const before=structuredClone(row); await assert.rejects(claim(db,intent.intentId)); await assert.rejects(failure(db,intent.intentId));
  assert.equal(await readRecoverableRefundIntent(db.client,intent.intentId,cap()),null);assert.deepEqual(row,before);assert.equal(db.s.observations.length,0);
});
test("SYNTHETIC_COMPONENT_MODEL：formal原key重放先于当前能力；对象仍先核，NULL不补升",async()=>{
  const db=fakeDb(),{intent}=await reserve(db,"150","original_key");db.s.basis!.source="JOINPAY";
  const row=db.s.intents.get(intent.intentId)!;Object.assign(row,{payment_source:"JOINPAY",evidence_level:"JOINPAY_FORMAL",initial_admission_ref:"HYPOTHETICAL_OLD_REF",budget_disposition:"ALLOCATED"});
  row.request_fingerprint=fingerprintRequest("rental.refund.intent","posting_1",{amountCents:"150",reason:null});
  const input={postingId:"posting_1",renterUserId:"renter_1",amountCents:"150",idempotencyKey:"original_key",requestId:"restore_1"};
  const before=structuredClone(row),restored=await createFormalRefundIntent(db.client,input);assert.equal(restored.replayed,true);assert.equal(restored.refundOrderNo,intent.refundOrderNo);assert.deepEqual(row,before);
  await assert.rejects(createFormalRefundIntent(db.client,{...input,renterUserId:"foreign"}),/not found/i);
  await assert.rejects(createFormalRefundIntent(db.client,{...input,amountCents:"149"}),(e:any)=>e.code==="IDEMPOTENCY_KEY_REUSED");
  await assert.rejects(createFormalRefundIntent(db.client,{...input,reason:"different"}),(e:any)=>e.code==="IDEMPOTENCY_KEY_REUSED");
  assert.equal((await createFormalRefundIntent(db.client,{...input,notifyUrl:"changed-current-config",profile:{} as any,admission:{} as any})).replayed,true);
  row.initial_admission_ref=null;await assert.rejects(createFormalRefundIntent(db.client,input),/promoted/);assert.equal(row.initial_admission_ref,null);
});
