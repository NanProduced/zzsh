// 真实PG阶段函数；导入不建池/连库/安装DDL。调用方须先完成独立窗口、硬预登记和合法posted fixture。
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../src/config/config";
import { withTransaction } from "../src/auth/security-core";
import { fingerprintRequest } from "../src/supply/supply-util";
import { createSyntheticChannelRequestCapability } from "../src/order/channel-payment-store";
import { claimRefundIntent, createNativeRefundIntent, readRecoverableRefundIntent, recordRefundTransportFailure, type RefundIntent } from "../src/order/channel-refund-store";

type Input = { postingId: string; attempt: string; resourceSet: string; config: AppConfig; guardPool?: Pool };
export const CHANNEL_REFUND_PG_EVIDENCE = "CONTROLLED_DATABASE_CONTRACT" as const;
type Basis = { order_id: string; payment_confirmation_id: string; renter_user_id: string; version_hash: string; due_at: string;
  source: string; merchant_scope_id: string; provider_transaction_id: string; merchant_order_no: string; refund_cents: string; paid_cents: string; due: boolean };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 不创建或修复parent事实。没有合法原生posting、已占额度或缺DDL/权限时，必须交回准备阶段。 */
export async function runChannelRefundPostgres(pool: Pool, input: Input) {
  if (!input || typeof input.postingId !== "string" || !ID.test(input.postingId) || typeof input.attempt !== "string" || !ID.test(input.attempt)) throw Error("REFUND_PG_INPUT_INVALID");
  const capability = createSyntheticChannelRequestCapability({ config: input.config, resourceSet: input.resourceSet, evidenceLevel: "CONTROLLED_TEST" });
  const checks: string[] = [], committedIntentIds: string[] = [];
  let originalIntent: RefundIntent | undefined;
  const tag = fingerprintRequest("refund.pg.attempt.v1", input.attempt, null).slice(0, 24);
  const key = (label: string) => `refund-pg:${tag}:${label}`;
  const requestId = `refundpg_${tag}`;
  const create = (client: PoolClient, amountCents: string, label: string) => createNativeRefundIntent(client, {
    postingId: input.postingId, amountCents, idempotencyKey: key(label), requestId, capability });
  try {
    const identity = (await pool.query(`SELECT current_database() AS db,current_user AS actor,
      to_regclass('zzsh_order.channel_refund_intent') IS NOT NULL AND to_regclass('zzsh_order.channel_refund_observation') IS NOT NULL AS ready`)).rows[0];
    if (identity?.db !== input.config.database.name || identity?.actor !== input.config.database.user) throw Error("REFUND_PG_IDENTITY_MISMATCH");
    if (identity.ready !== true) throw Error("REFUND_SCHEMA_REQUIRED");
    const basis = (await pool.query<Basis>(`SELECT p.order_id,p.payment_confirmation_id,o.renter_user_id,p.version_hash,p.refund_due_at::text AS due_at,
      c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,p.renter_refund_cents::text AS refund_cents,
      c.amount_cents::text AS paid_cents,p.refund_due_at<=clock_timestamp() AS due
      FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
      JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
      WHERE p.id=$1 AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED'
        AND c.source='CONTROLLED' AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents`, [input.postingId])).rows[0];
    if (!basis || basis.due !== true || typeof basis.refund_cents !== "string" || !/^[1-9][0-9]{0,15}$/.test(basis.refund_cents)
      || BigInt(basis.refund_cents) < 8n) throw Error("LEGAL_DUE_REFUND_POSTING_FIXTURE_REQUIRED");
    const allocated = async () => (await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS total
      FROM zzsh_order.channel_refund_intent WHERE payment_source=$1 AND merchant_identity_id=$2 AND original_payment_trx_no=$3`,
      [basis.source, basis.merchant_scope_id, basis.provider_transaction_id])).rows[0].total as string;
    if (await allocated() !== "0") throw Error("REFUND_FIXTURE_ALREADY_ALLOCATED_NO_RETRY");
    checks.push("RN01_ORIGINAL_APPLIED_POSTING_BOUND");

    const rawInsert = (client: PoolClient, amount: string, label: string, source = "CONTROLLED", currency = "CNY") => client.query(
      `INSERT INTO zzsh_order.channel_refund_intent(id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,
        merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,
        amount_cents,currency,idempotency_key,request_fingerprint,due_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [`refundpg_${tag}_${label}`, input.postingId, basis.order_id, basis.payment_confirmation_id, basis.renter_user_id, source,
        basis.merchant_scope_id, basis.provider_transaction_id, basis.merchant_order_no, basis.version_hash,
        `RF${fingerprintRequest("refund.pg.raw", label, tag).slice(0,28)}`, amount, currency, key(label),
        fingerprintRequest("rental.refund.intent", input.postingId, { amountCents: amount }), basis.due_at]);
    for (const [i, amount] of ["0", "-1", "1.2", "NaN", "Infinity", "10000000000000000"].entries()) {
      await assert.rejects(withTransaction(pool, c => rawInsert(c, amount, `bad${i}`)), (e: unknown) => ["23514", "22003"].includes((e as { code: string }).code));
    }
    // 当前schema支持正式JOINPAY；此负例只证明CONTROLLED原款不能借改source绕过正式准入。
    await assert.rejects(withTransaction(pool, c => rawInsert(c, "1", "wrongsource", "JOINPAY")), (e: unknown) => (e as { code: string }).code === "23514");
    await assert.rejects(withTransaction(pool, c => rawInsert(c, "1", "wrongcurrency", "CONTROLLED", "USD")), (e: unknown) => (e as { code: string }).code === "23514");
    checks.push("RN06_SQL_NO_ROUNDING_OR_NONFINITE", "RN16_SQL_SOURCE_AND_CURRENCY_CLOSED");

    const rollback = Error("REFUND_PG_INTENTIONAL_ROLLBACK");
    let rolledBackId = "";
    await assert.rejects(withTransaction(pool, async c => { rolledBackId = (await create(c, "1", "rollback")).intent.intentId; throw rollback; }), e => e === rollback);
    const rolledBack = (await pool.query(`SELECT (SELECT count(*)::int FROM zzsh_order.channel_refund_intent WHERE id=$1) AS intents,
      (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id=$1) AS audits`, [rolledBackId])).rows[0];
    assert.deepEqual(rolledBack, { intents: 0, audits: 0 });
    checks.push("RN12_ROLLBACK_AFTER_INTENT_AND_AUDIT");

    const firstAmount = (BigInt(basis.refund_cents) / 2n + 1n).toString();
    const readyA = deferred<RefundIntent>(), releaseA = deferred<boolean>(), pidB = deferred<number>();
    const cancelA = Error("REFUND_PG_CONCURRENCY_CANCELLED");
    const a = withTransaction(pool, async c => {
      const created = (await create(c, firstAmount, "first")).intent; originalIntent = created; readyA.resolve(created);
      if (!await releaseA.promise) throw cancelA;
      return created;
    });
    a.catch(error => readyA.reject(error));
    let b: Promise<{ error: unknown }> | undefined;
    try {
      await readyA.promise;
      b = withTransaction(pool, async c => {
        pidB.resolve((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
        await rawInsert(c, firstAmount, "competitor");
        throw Error("REFUND_PG_UNEXPECTED_RAW_INSERT_ACCEPTED");
      }).then(() => ({ error: Error("REFUND_PG_UNEXPECTED_COMMIT") }), error => { pidB.reject(error); return { error }; });
      const pid = await pidB.promise;
      let sawWait = false;
      for (let n = 0; n < 30; n++) {
        sawWait = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting`, [pid])).rows[0].waiting === true;
        if (sawWait) break; await pause(20);
      }
      assert.equal(sawWait, true, "direct SQL writer must really wait on the common funds lock");
      releaseA.resolve(true);
      const first = await a; committedIntentIds.push(first.intentId);
      assert.equal(((await b).error as { code: string }).code, "23514");
      assert.equal(await allocated(), firstAmount);
    } finally {
      releaseA.resolve(false);
      await Promise.allSettled(b ? [a, b] : [a]);
    }
    checks.push("RN04_RN05_REAL_LOCK_WAIT_SQL_CAP_AFTER_COMMIT");

    const first = originalIntent!;
    const replay = await withTransaction(pool, c => create(c, firstAmount, "first"));
    assert.equal(replay.replayed, true); assert.equal(replay.intent.intentId, first.intentId); assert.equal(replay.intent.refundOrderNo, first.refundOrderNo);
    await assert.rejects(withTransaction(pool, c => create(c, "1", "first")), (e: unknown) => (e as { code: string }).code === "IDEMPOTENCY_KEY_REUSED");
    const rest = (BigInt(basis.refund_cents) - BigInt(firstAmount)).toString();
    const second = await withTransaction(pool, c => create(c, rest, "second")); committedIntentIds.push(second.intent.intentId);
    assert.notEqual(second.intent.refundOrderNo, first.refundOrderNo); assert.equal(await allocated(), basis.refund_cents);
    await assert.rejects(withTransaction(pool, c => create(c, "1", "over")), (e: unknown) => (e as { code: string }).code === "CONFLICT");
    checks.push("RN02_RN03_PARTIAL_REPLAY_AND_EXACT_CAP");

    return await finishControlledRefundPg(pool,input,capability,basis,first,tag,requestId,checks,committedIntentIds,allocated,create);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { refundPgPartial: { checks, committedIntentIds,
      originalIntentId: originalIntent?.intentId ?? null, originalRefundOrderNo: originalIntent?.refundOrderNo ?? null, retainOriginalRecords: true, retryAuthorized: false } });
  }
}


async function finishControlledRefundPg(pool:Pool,input:Input,capability:unknown,basis:Basis,first:RefundIntent,tag:string,requestId:string,
 checks:string[],committedIntentIds:string[],allocated:()=>Promise<string>,
 create:(c:PoolClient,amount:string,label:string)=>ReturnType<typeof createNativeRefundIntent>){
    if(input.guardPool){const identity=(await input.guardPool.query('SELECT current_database() AS db,current_user AS actor')).rows[0];
      if(identity?.db!==input.config.database.name||identity.actor!==`zzsh_order_${input.resourceSet}_m`)throw Error('REFUND_GUARD_PROBE_RESOURCE_DIFF');}
    for (const sql of ["UPDATE zzsh_order.channel_refund_intent SET amount_cents=amount_cents-1 WHERE id=$1", "DELETE FROM zzsh_order.channel_refund_intent WHERE id=$1"]) {
      await assert.rejects(withTransaction(pool, c => c.query(sql, [first.intentId])), (e: unknown) => ["40001","42501"].includes((e as { code: string }).code));
      if(input.guardPool)await assert.rejects(withTransaction(input.guardPool,c=>c.query(sql,[first.intentId])),(e:unknown)=>(e as {code:string}).code==='40001');
    }
    await assert.rejects(withTransaction(pool, async c => { await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); return create(c, "1", "rr"); }), (e: unknown) => (e as { code: string }).code === "CONFLICT");
    checks.push(input.guardPool?"RN07_RUNTIME_ACL_AND_OWNER_TRIGGER_IMMUTABLE":"RN07_RUNTIME_REJECTION_ONLY", "RN14_REPEATABLE_READ_CLOSED");

    const owner = `refundworker_${tag}`;
    const lease = await withTransaction(pool, c => claimRefundIntent(c, { intentId: first.intentId, owner, ttlSeconds: 3, requestId, capability }));
    assert.ok(lease); assert.equal(lease.operation, "SUBMIT");
    assert.equal(await withTransaction(pool, c => claimRefundIntent(c, { intentId: first.intentId, owner, ttlSeconds: 1, requestId, capability })), null);
    const unknown = await withTransaction(pool, c => recordRefundTransportFailure(c, { intentId: first.intentId, owner, version: lease.version, reason: "TIMEOUT", requestId, capability }));
    assert.equal(unknown.event, "UNKNOWN"); assert.equal(unknown.intent.state, "UNKNOWN"); assert.equal(await allocated(), basis.refund_cents);
    let expired = false;
    for (let n = 0; n < 80; n++) { expired = (await pool.query(`SELECT lease_until<=clock_timestamp() AS expired FROM zzsh_order.channel_refund_intent WHERE id=$1`, [first.intentId])).rows[0].expired;
      if (expired) break; await pause(50); }
    assert.equal(expired, true);
    const recovered = await withTransaction(pool, c => claimRefundIntent(c, { intentId: first.intentId, owner: `${owner}_2`, ttlSeconds: 30, requestId, capability }));
    assert.ok(recovered); assert.equal(recovered.operation, "QUERY"); assert.equal(recovered.intent.refundOrderNo, first.refundOrderNo);
    const stale = await withTransaction(pool, c => recordRefundTransportFailure(c, { intentId: first.intentId, owner, version: lease.version, reason: "TIMEOUT", requestId, capability }));
    assert.equal(stale.event, "STALE"); assert.equal(stale.intent.revision, recovered.intent.revision); assert.equal(await allocated(), basis.refund_cents);
    const restored = await withTransaction(pool, c => readRecoverableRefundIntent(c, first.intentId, capability));
    assert.equal(restored?.originalPayment.orderNo, basis.merchant_order_no); assert.equal(restored?.refundOrderNo, first.refundOrderNo); assert.equal(restored?.formalRefund, false);
    checks.push("RN09_RN11_LEASE_TIMEOUT_QUERY_RECOVERY_NO_RELEASE");
    return { scope: "CONTROLLED_TEST" as const, evidence: CHANNEL_REFUND_PG_EVIDENCE, checks, postingId: input.postingId, committedIntentIds, allocatedCents: basis.refund_cents,
      originalRefundOrderNo: first.refundOrderNo, formalRefund: false as const,
      notCovered: ["RN08_FUTURE_DUE_POSTING", "RN10_REAL_ROW_WAIT_ACROSS_EXPIRY", "RN12_AUDIT_INSERT_FAILURE", "RN13_RUNTIME_ACL_RECONVERGENCE", "RN15_REAL_COMMIT_UNKNOWN", "formal/legacy/guarantee refund"] };
}

/** 已核失败attempt的两笔原预算续验；不重新建原单/意图，不把此前失败改成成功。 */
export async function resumeChannelRefundPostgres(pool:Pool,input:Input & {originalAttempt:string}){
 if(!input||!ID.test(input.postingId)||!ID.test(input.attempt)||!ID.test(input.originalAttempt)||!input.guardPool)throw Error('REFUND_PG_RESUME_INPUT_INVALID');
 const capability=createSyntheticChannelRequestCapability({config:input.config,resourceSet:input.resourceSet,evidenceLevel:'CONTROLLED_TEST'});
 const identity=(await pool.query('SELECT current_database() AS db,current_user AS actor')).rows[0];
 if(identity?.db!==input.config.database.name||identity.actor!==input.config.database.user)throw Error('REFUND_PG_IDENTITY_MISMATCH');
 const basis=(await pool.query<Basis>(`SELECT p.order_id,p.payment_confirmation_id,o.renter_user_id,p.version_hash,p.refund_due_at::text AS due_at,
  c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,p.renter_refund_cents::text AS refund_cents,
  c.amount_cents::text AS paid_cents,p.refund_due_at<=clock_timestamp() AS due
  FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
  JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
  WHERE p.id=$1 AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED' AND c.source='CONTROLLED'
   AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents`,[input.postingId])).rows[0];
 if(!basis||!basis.due||!/^([1-9][0-9]{0,15})$/.test(basis.refund_cents))throw Error('REFUND_RESUME_ORIGINAL_POSTING_DIFF');
 const tag=fingerprintRequest('refund.pg.attempt.v1',input.originalAttempt,null).slice(0,24),key=(label:string)=>`refund-pg:${tag}:${label}`,requestId=`refundpg_${tag}`;
 const rows=(await pool.query<{id:string;idempotency_key:string}>(`SELECT id,idempotency_key FROM zzsh_order.channel_refund_intent
  WHERE posting_id=$1 AND payment_source='CONTROLLED' ORDER BY id`,[input.postingId])).rows;
 if(rows.length!==2||!rows.some(r=>r.idempotency_key===key('first'))||!rows.some(r=>r.idempotency_key===key('second')))throw Error('REFUND_RESUME_EXACT_TWO_KEYS_REQUIRED');
 const first=await withTransaction(pool,c=>readRecoverableRefundIntent(c,rows.find(r=>r.idempotency_key===key('first'))!.id,capability));
 const second=await withTransaction(pool,c=>readRecoverableRefundIntent(c,rows.find(r=>r.idempotency_key===key('second'))!.id,capability));
 if(!first||!second||first.state!=='READY'||second.state!=='READY'||first.leaseVersion!=='0'||second.leaseVersion!=='0'
  ||first.paymentConfirmationId!==basis.payment_confirmation_id||second.paymentConfirmationId!==basis.payment_confirmation_id
  ||first.amountCents!==(BigInt(basis.refund_cents)/2n+1n).toString()||BigInt(first.amountCents)+BigInt(second.amountCents)!==BigInt(basis.refund_cents))throw Error('REFUND_RESUME_ORIGINAL_FACTS_DIFF');
 const allocated=async()=>(await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS total FROM zzsh_order.channel_refund_intent
  WHERE payment_source=$1 AND merchant_identity_id=$2 AND original_payment_trx_no=$3`,[basis.source,basis.merchant_scope_id,basis.provider_transaction_id])).rows[0].total as string;
 if(await allocated()!==basis.refund_cents)throw Error('REFUND_RESUME_ORIGINAL_BUDGET_DIFF');
 const checks=['RESUME_EXACT_ORIGINAL_KEYS_BINDINGS_AND_FULL_ALLOCATION'],ids=rows.map(r=>r.id);
 const create=(c:PoolClient,amountCents:string,label:string)=>createNativeRefundIntent(c,{postingId:input.postingId,amountCents,idempotencyKey:key(label),requestId,capability});
 try{return {...await finishControlledRefundPg(pool,input,capability,basis,first,tag,requestId,checks,ids,allocated,create),resumedFrom:input.originalAttempt,prefixNotReplayed:true};}
 catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{refundPgPartial:{checks,committedIntentIds:ids,originalIntentId:first.intentId,retainOriginalRecords:true,retryAuthorized:false}});}
}
