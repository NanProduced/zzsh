import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "../auth/security-core";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { createCollectionPaymentRequest, claimCollectionPaymentRequestLease, bindFormalJoinpayTransaction, type PaymentActor, type PaymentRequestView } from "./channel-payment-store";
import { evaluateJoinpayTransportFailure, joinpayTransition, type JoinpayEvent, type RequestState } from "./joinpay-protocol";
import { JoinpayCollectionProfileError, describeCollectionProfile, assertCollectionRequestBinding, readCollectionProfileEvidence, produceJoinpayCollectionRequest, inspectJoinpayCollectionResponse,
  assertFormalCollectionProfile, assertFormalCollectionStart, readFormalCollectionAdmission,
  type FormalCollectionAdmission, type BoundCollectionProfile, type CollectionOperation, type CollectionPersistedBinding, type CollectionProfileSnapshot } from "./joinpay-collection-profile";
import { exchangeJoinpayCollection } from "./joinpay-collection-transport";
import { captureJoinpayCollectionEvidence, readFormalJoinpayPaymentFact, readFormalCollectionRequest, type FormalCollectionSourceOptions } from "./joinpay-collection-source";
import { createNativePaymentDistributionAdmission, createNativePaymentDistributionStore } from "../finance/distribution-payment-store";
import { confirmOrderPayment } from "./payment-confirmation";

const collectionLeaseConflict = Symbol("collection lease conflict");
// 本地自动恢复预算；耗尽仍保留未知，不据此认定渠道失败或换号付款。
export const JOINPAY_COLLECTION_MAX_AUTOMATIC_QUERIES = 10;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fresh = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
type InitialWire = { tradeMerchantNo: string; productName: string; notifyUrl: string };
type Original = CollectionPersistedBinding & { orderId: string; state: RequestState; leaseVersion: string; evidenceMode: "OFFICIAL" | "SYNTHETIC" };
type OriginalRow = { request_id: string; order_id: string; state: RequestState; revision: string; lease_version: string; evidence_level: string; channel: string;
  channel_order_no: string; amount_cents: string; method: "ALIPAY_NATIVE" | "WEIXIN_NATIVE"; merchant_identity_id: string;
  config_profile_id: string; key_version_ref: string; wire_merchant_no: string; trade_merchant_no: string; product_name: string; notify_url: string;
  evidence_mode: "OFFICIAL" | "SYNTHETIC"; formal_admission_ref: string | null };
const ORIGINAL_SQL = `SELECT r.id AS request_id,r.order_id,r.state,r.revision::text,r.lease_version::text,r.evidence_level,r.channel,
 r.channel_order_no,r.amount_cents::text,r.method,r.merchant_identity_id,r.config_profile_id,r.key_version_ref,
 b.wire_merchant_no,b.trade_merchant_no,b.product_name,b.notify_url,b.evidence_mode,to_jsonb(b)->>'formal_admission_ref' AS formal_admission_ref
 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id WHERE r.id=$1`;

function original(row: OriginalRow): Original {
  if (row.channel !== "JOINPAY" || row.evidence_level !== "JOINPAY_CANDIDATE") throw conflict("Collection request provenance differs");
  return { requestId: row.request_id, orderId: row.order_id, state: row.state, leaseVersion: row.lease_version,
    originalOrderNo: row.channel_order_no, amountCents: row.amount_cents, method: row.method,
    merchantIdentityId: row.merchant_identity_id, profileId: row.config_profile_id, keyVersionRef: row.key_version_ref,
    wireMerchantNo: row.wire_merchant_no, tradeMerchantNo: row.trade_merchant_no, productName: row.product_name, notifyUrl: row.notify_url, evidenceMode: row.evidence_mode };
}
/** 同事务复用原幂等/对象/hold/原号创建；重放只读原wire，配置变化不重算或修复缺失绑定。 */
export type JoinpayCollectionRequestInput = {
  actor: PaymentActor; orderId: string; idempotencyKey: unknown; method: "ALIPAY_NATIVE" | "WEIXIN_NATIVE";
  profile?: BoundCollectionProfile; wire?: InitialWire; admission?: FormalCollectionAdmission;
};
export async function createJoinpayCollectionRequest(pool: Pool, input: JoinpayCollectionRequestInput) {
  return withTransaction(pool, client => createJoinpayCollectionRequestInTransaction(client, input));
}
/** 已认证route可复用同一client；不另开事务，也不把认证挪到持久请求之后。 */
export async function createJoinpayCollectionRequestInTransaction(client: PoolClient, input: JoinpayCollectionRequestInput): Promise<{ replayed: boolean; status: number; request: PaymentRequestView }> {
    const result = await createCollectionPaymentRequest(client, input);
    const request = result.body as PaymentRequestView;
    const existing = (await client.query(`SELECT request_id,to_jsonb(b)->>'formal_admission_ref' AS formal_admission_ref,
      to_jsonb(b)->>'formal_admission_sha256' AS formal_admission_sha256 FROM zzsh_order.joinpay_collection_binding b WHERE request_id=$1`, [request.requestId])).rows[0];
    if (!existing) {
      if (result.replayed || request.existing) throw conflict("Original collection wire evidence is missing");
      if (!input.profile || !input.wire) throw new JoinpayCollectionProfileError("COLLECTION_OPERATION_NOT_CONFIRMED");
      const profile = describeCollectionProfile(input.profile, "SUBMIT");
      if (input.admission) assertFormalCollectionStart(input.admission);
      const formal = input.admission ? assertFormalCollectionProfile(input.admission, input.profile, "SUBMIT") : null;
      const wire = Object.freeze({ tradeMerchantNo: input.wire.tradeMerchantNo, productName: input.wire.productName, notifyUrl: input.wire.notifyUrl });
      assertCollectionRequestBinding(input.profile, "SUBMIT", { requestId: request.requestId, originalOrderNo: request.channelOrderNo,
        amountCents: request.amountCents, method: request.method, merchantIdentityId: profile.merchantIdentityId, wireMerchantNo: profile.wireMerchantNo,
        profileId: profile.profileId, keyVersionRef: profile.keyVersionRef, ...wire });
      if (input.admission) await createNativePaymentDistributionAdmission(client, input.admission, request.orderId);
      if (formal) await client.query(`INSERT INTO zzsh_order.joinpay_collection_binding
        (request_id,wire_merchant_no,trade_merchant_no,product_name,notify_url,initial_profile_sha256,evidence_mode,formal_admission_ref,formal_admission_sha256,formal_admission_canonical)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [request.requestId, profile.wireMerchantNo, wire.tradeMerchantNo,
        wire.productName, wire.notifyUrl, profile.profileSha256, profile.evidenceMode, formal.reference, formal.sha256, formal.canonical]);
      else await client.query(`INSERT INTO zzsh_order.joinpay_collection_binding
        (request_id,wire_merchant_no,trade_merchant_no,product_name,notify_url,initial_profile_sha256,evidence_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [request.requestId, profile.wireMerchantNo, wire.tradeMerchantNo,
        wire.productName, wire.notifyUrl, profile.profileSha256, profile.evidenceMode]);
      await recordAudit(client, { actorType: "user", actorId: input.actor.userId, action: "order.payment.collection.request.created",
        objectType: "payment_request", objectId: request.requestId, outcome: "SUCCESS", requestId: request.requestId,
        details: { profileId: profile.profileId, evidenceMode: profile.evidenceMode, formalAcceptance: false } });
    }
    return { replayed: result.replayed, status: result.status, request };
}

export class CollectionAttemptCommitUnknown extends Error {
  readonly code = "PAYMENT_EXECUTION_UNKNOWN";
  constructor(readonly requestId: string, readonly phase: "CLAIM" | "RESULT") {
    super("Recover the original collection request before any further attempt");
  }
}
async function confirmed<T>(pool: Pool, id: string, phase: "CLAIM" | "RESULT", callback: (client: PoolClient) => Promise<T>): Promise<T> {
  let complete = false;
  try { return await withTransaction(pool, async client => { const value = await callback(client); complete = true; return value; }); }
  catch (error) { if (complete) throw new CollectionAttemptCommitUnknown(id, phase); throw error; }
}

export type JoinpayCollectionExecution = {
  pool: Pool;
  profileFor: (operation: CollectionOperation, original: CollectionPersistedBinding) => BoundCollectionProfile;
  keyFor: (keyVersionRef: string) => string;
  fetch?: typeof globalThis.fetch;
  formal?: FormalCollectionSourceOptions;
};
type Prepared = { attemptId: string; request: Original; profile: BoundCollectionProfile; snapshot: CollectionProfileSnapshot;
  binding: CollectionPersistedBinding; key: string; operation: CollectionOperation; lease: { leaseVersion: string; leaseOwner: string };
  outbound: ReturnType<typeof produceJoinpayCollectionRequest> };

async function prepare(options: JoinpayCollectionExecution, id: string, workerId: string, recoveryMinimumIntervalSeconds?: number, allowFirstDispatch?: boolean): Promise<Prepared | null> {
  return confirmed(options.pool, id, "CLAIM", async client => {
    const row = (await client.query<OriginalRow>(`${ORIGINAL_SQL} FOR UPDATE OF r`, [id])).rows[0];
    if (!row) throw notFound();
    if (row.formal_admission_ref != null && !options.formal) throw conflict("Formal request requires explicit source admission");
    const request = original(row);
    const operation: CollectionOperation = row.lease_version === "0" && row.state === "SUBMITTING" ? "SUBMIT" : "QUERY";
    if (recoveryMinimumIntervalSeconds !== undefined) {
      if (operation === "SUBMIT" && allowFirstDispatch !== true) return null;
      // 请求行锁内重核PG时间；不能仅信任批量扫描时已经过期的资格。
      const due = (await client.query(`SELECT COALESCE(max(a.created_at),(SELECT created_at FROM zzsh_order.payment_request WHERE id=$1))
        <=clock_timestamp()-make_interval(secs=>$2::integer) AS due,
        count(*) FILTER (WHERE a.operation='QUERY')<$3::integer AS within_budget
        FROM zzsh_order.joinpay_collection_attempt a WHERE a.request_id=$1`, [id, recoveryMinimumIntervalSeconds, JOINPAY_COLLECTION_MAX_AUTOMATIC_QUERIES])).rows[0];
      if (due?.due !== true || operation === "QUERY" && due.within_budget !== true) return null;
    }
    if (operation === "SUBMIT") {
      const payable = (await client.query(`SELECT status,hold_until>clock_timestamp() AS open FROM zzsh_order.rental_order WHERE id=$1`, [request.orderId])).rows[0];
      if (payable?.status !== "PENDING_PAYMENT" || payable.open !== true) return null;
    }
    const lease = await claimCollectionPaymentRequestLease(client, { requestId: id, owner: workerId, ttlSeconds: 30 });
    if (!lease) return null;
    if (lease.channelOrderNo !== request.originalOrderNo || lease.state !== request.state
      || BigInt(lease.leaseVersion) !== BigInt(request.leaseVersion) + 1n) throw conflict("Claim differs from the original collection request");
    const profile = options.profileFor(operation, Object.freeze({ ...request })), snapshot = describeCollectionProfile(profile, operation);
    if (snapshot.merchantIdentityId !== request.merchantIdentityId || snapshot.wireMerchantNo !== request.wireMerchantNo
      || snapshot.evidenceMode !== "OFFICIAL" || snapshot.evidenceMode !== request.evidenceMode) throw conflict("Current profile differs from the original merchant provenance");
    if (operation === "SUBMIT" && (snapshot.profileId !== request.profileId || snapshot.keyVersionRef !== request.keyVersionRef)) throw conflict("First submit must use the original profile and key version");
    const binding: CollectionPersistedBinding = Object.freeze({ ...request });
    if (options.formal) {
      assertFormalCollectionProfile(options.formal.admission, profile, operation);
      const admitted = await readFormalCollectionRequest(client, options.formal.admission, id);
      for (const name of Object.keys(admitted) as (keyof CollectionPersistedBinding)[]) if (admitted[name] !== binding[name]) throw conflict("Formal original binding differs");
    }
    let key: string;
    try { key = options.keyFor(snapshot.keyVersionRef); }
    catch { throw new JoinpayCollectionProfileError("COLLECTION_KEY_UNAVAILABLE"); }
    const outbound = produceJoinpayCollectionRequest(profile, operation, binding, key);
    const attemptId = fresh("jpat");
    await client.query(`INSERT INTO zzsh_order.joinpay_collection_attempt
      (id,request_id,lease_version,lease_owner,operation,profile_id,profile_canonical,profile_sha256,key_version_ref,evidence_mode,request_body,request_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [attemptId, id, lease.leaseVersion, lease.leaseOwner, operation,
      snapshot.profileId, readCollectionProfileEvidence(profile, operation), snapshot.profileSha256, snapshot.keyVersionRef, snapshot.evidenceMode, Buffer.from(outbound.encodedBody, "utf8"), outbound.requestSha256]);
    await recordAudit(client, { actorType: "system", action: "order.payment.collection.attempt.claimed", objectType: "payment_request",
      objectId: id, outcome: "SUCCESS", requestId: attemptId, details: { operation, leaseVersion: lease.leaseVersion,
        profileId: snapshot.profileId, keyVersionRef: snapshot.keyVersionRef, formalAcceptance: false } });
    return { attemptId, request, operation, profile, snapshot, binding, key, lease, outbound };
  });
}

type Exchange = Awaited<ReturnType<typeof exchangeJoinpayCollection>>;
type Recorded = { attemptId: string; observationId: string; event: JoinpayEvent; state: RequestState; formalAcceptance: false };
async function record(options: JoinpayCollectionExecution, attempt: Prepared, response: Exchange): Promise<Recorded> {
  return confirmed(options.pool, attempt.request.requestId, "RESULT", async client => {
    const found = (await client.query<OriginalRow>(`${ORIGINAL_SQL} FOR UPDATE OF r`, [attempt.request.requestId])).rows[0];
    if (!found) throw notFound();
    let row: OriginalRow = found;
    let request = original(row);
    const leaseSql = `SELECT lease_version=$2::bigint AND lease_owner=$3 AND lease_until>clock_timestamp() AS current
      FROM zzsh_order.payment_request WHERE id=$1`;
    const leaseParams = [request.requestId, attempt.lease.leaseVersion, attempt.lease.leaseOwner];
    const current = (await client.query(leaseSql, leaseParams)).rows[0]?.current;
    if (typeof current !== "boolean") throw conflict("Collection lease evidence unavailable");
    let event: JoinpayEvent, result: string, verified = false, schema = "NOT_CHECKED", signature = "NOT_CHECKED", binding = "NOT_CHECKED";
    let values: Readonly<Record<string, string>> | undefined, rawStatus: string | undefined, paidAtRaw: string | undefined;
    if (!current) { event = "E9"; result = "STALE_LEASE"; }
    else if (response.kind === "UNKNOWN") {
      const reason = response.reason === "TIMEOUT" ? "TIMEOUT" : response.reason === "HTTP_STATUS" ? "HTTP_STATUS"
        : response.reason === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "NETWORK_ERROR";
      const outcome = evaluateJoinpayTransportFailure(attempt.operation === "SUBMIT" ? "SYNC_RESPONSE" : "QUERY_RESPONSE", request.state, true, reason);
      event = outcome.event; result = outcome.result;
    } else {
      try {
        const inspected = inspectJoinpayCollectionResponse(attempt.profile, attempt.operation, response.body, attempt.binding, attempt.key);
        ({ event, result, verified, schema, signature, binding, values, rawStatus } = inspected); paidAtRaw = inspected.providerPaidAtRaw;
      } catch { event = attempt.operation === "SUBMIT" ? "E3" : "E6X"; result = "INSPECTION_UNAVAILABLE"; }
    }
    let next = current ? joinpayTransition(event, request.state).nextState : request.state;
    if (next === "ACCEPTED") throw conflict("Collection candidate cannot accept a payment");
    const stage = { value: "STATE" as "STATE" | "OBSERVATION" | "AUDIT" };
    const persist = async (): Promise<Recorded> => {
    stage.value = "STATE";
    if (next !== request.state) {
      const changed = await client.query(`UPDATE zzsh_order.payment_request SET state=$2,revision=revision+1,updated_at=clock_timestamp()
        WHERE id=$1 AND evidence_level='JOINPAY_CANDIDATE' AND state=$3 AND revision=$4::bigint
          AND lease_version=$5::bigint AND lease_owner=$6 AND lease_until>clock_timestamp()`,
        [request.requestId, next, request.state, row.revision,
          attempt.lease.leaseVersion, attempt.lease.leaseOwner]);
      if (changed.rowCount !== 1) throw Object.assign(conflict("Collection lease changed while recording evidence"), { [collectionLeaseConflict]: true });
    }
    const complete = response.kind === "RESPONSE" || ("responseComplete" in response && response.responseComplete === true);
    const observationId = fresh("jpobs"), body = "body" in response && response.body !== undefined ? Buffer.from(response.body) : null;
    const received = "receivedBytes" in response ? response.receivedBytes : body?.byteLength ?? 0;
    stage.value = "OBSERVATION";
    await client.query(`INSERT INTO zzsh_order.joinpay_collection_observation
      (id,attempt_id,request_id,raw_body,raw_sha256,http_status,response_complete,received_bytes,transport_failure,event,result,schema_outcome,signature_outcome,binding_outcome,
       verified,state_before,state_after,channel_status,provider_paid_at_raw,channel_trx_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [observationId, attempt.attemptId, request.requestId, body, body ? sha(body) : null, "status" in response ? response.status : null, complete, received,
        response.kind === "UNKNOWN" ? response.reason : null, event, result, schema, signature, binding, verified,
        request.state, next, rawStatus ?? null, paidAtRaw ?? null, (attempt.operation === "SUBMIT" ? values?.r7_TrxNo : values?.r5_TrxNo) ?? null]);
    stage.value = "AUDIT";
    await recordAudit(client, { actorType: "system", action: "order.payment.collection.observed", objectType: "payment_request", objectId: request.requestId,
      outcome: "SUCCESS", requestId: observationId, details: { attemptId: attempt.attemptId, event, result, verified,
        evidenceMode: attempt.snapshot.evidenceMode, formalAcceptance: false } });
    return { attemptId: attempt.attemptId, observationId, event, state: next, formalAcceptance: false };
    };
    await client.query("SAVEPOINT collection_result_effect");
    try {
      const recorded = await persist(); await client.query("RELEASE SAVEPOINT collection_result_effect"); return recorded;
    } catch (error) {
      const failure = error as { code?: string; constraint?: string; [collectionLeaseConflict]?: boolean };
      const leaseFailure = failure[collectionLeaseConflict] === true || failure.constraint === "joinpay_collection_lease_current"
        && (failure.code === "23514" || failure.code === "40001");
      if (stage.value === "AUDIT" || !leaseFailure) throw error;
      // 只撤销本次尚未提交的状态/观察；重新读PG租约证实已过期，不能凭错误码自行认定STALE。
      await client.query("ROLLBACK TO SAVEPOINT collection_result_effect");
      const freshRow = (await client.query<OriginalRow>(`${ORIGINAL_SQL} FOR UPDATE OF r`, [attempt.request.requestId])).rows[0];
      if (!freshRow || (await client.query(leaseSql, leaseParams)).rows[0]?.current !== false) throw error;
      row = freshRow; request = original(freshRow); next = request.state;
      event = "E9"; result = "STALE_LEASE"; verified = false; schema = signature = binding = "NOT_CHECKED";
      values = undefined; rawStatus = paidAtRaw = undefined;
      const stale = await persist(); await client.query("RELEASE SAVEPOINT collection_result_effect"); return stale;
    }
  });
}

/** 已提交attempt之后才发送一次；领取提交未知不发请求，结果提交未知不重发SUBMIT。 */
export async function executeJoinpayCollectionAttempt(options: JoinpayCollectionExecution, input: { requestId: string; workerId: string; recoveryMinimumIntervalSeconds?: number; allowFirstDispatch?: boolean }): Promise<
  { kind: "SKIPPED" } | { kind: "OBSERVED"; operation: CollectionOperation; observation: Recorded }> {
  if (!ID.test(input.requestId) || !ID.test(input.workerId)) throw invalid();
  if (input.recoveryMinimumIntervalSeconds !== undefined && (!Number.isSafeInteger(input.recoveryMinimumIntervalSeconds)
    || input.recoveryMinimumIntervalSeconds < 30 || input.recoveryMinimumIntervalSeconds > 86400)) throw invalid();
  if (input.allowFirstDispatch !== undefined && (typeof input.allowFirstDispatch !== "boolean" || input.recoveryMinimumIntervalSeconds === undefined)) throw invalid();
  const attempt = await prepare(options, input.requestId, input.workerId, input.recoveryMinimumIntervalSeconds, input.allowFirstDispatch);
  if (!attempt) return { kind: "SKIPPED" };
  const response = await exchangeJoinpayCollection(attempt.outbound, { fetch: options.fetch });
  if (response.requestSha256 !== attempt.outbound.requestSha256) throw conflict("Transport changed the committed request bytes");
  const observation = await record(options, attempt, response);
  if (options.formal && observation.event === "E4" && attempt.operation === "QUERY") {
    await acceptJoinpayCollectionEvidence(options.pool, options.formal, { operation: "QUERY", requestId: input.requestId, observationId: observation.observationId });
  }
  return { kind: "OBSERVED", operation: attempt.operation, observation };
}

type AcceptanceInput = { operation: "NOTIFY"; rawQuery: string } | { operation: "QUERY"; requestId: string; observationId: string };
/** 资金效果与证据/basis/audit同事务；调用方不得把未确认COMMIT当ACK成功。 */
export async function acceptJoinpayCollectionEvidence(pool: Pool, options: FormalCollectionSourceOptions, input: AcceptanceInput) {
  const commandId = input.operation === "QUERY" ? input.observationId : `notify_${sha(input.rawQuery).slice(0, 32)}`;
  return confirmed(pool, commandId, "RESULT", async client => {
    const captured = await captureJoinpayCollectionEvidence(client, options, input);
    if (captured.event !== "E4") return { ...captured, payment: null, conflict: false };
    const fact = await readFormalJoinpayPaymentFact(client, options, captured.evidenceId, commandId);
    // 唯独此FK延迟到COMMIT，避免先锁order KEY SHARE再等邀请图/用户，与取消的用户→order锁形成环。
    await client.query("SET CONSTRAINTS zzsh_order.payment_channel_transaction_native_order_id_fkey DEFERRED");
    const anchor = await bindFormalJoinpayTransaction(client, fact);
    let payment: Awaited<ReturnType<typeof confirmOrderPayment>> | null = null;
    if (anchor.binding !== "OWNED_ELSEWHERE") payment = await confirmOrderPayment(client, fact, createNativePaymentDistributionStore(options.admission));
    else await recordAudit(client, { actorType: "system", action: "order.payment.collection.transaction.conflict", objectType: "payment_request",
      objectId: fact.paymentRequestId, requestId: commandId, outcome: "FAILURE", reason: "TRANSACTION_OWNED_ELSEWHERE", details: { evidenceId: fact.evidenceId, anchorId: anchor.anchorId } });
    const next = payment?.disposition === "APPLIED" ? "ACCEPTED" : "REVIEW_REQUIRED";
    await client.query(`SELECT set_config('zzsh.joinpay_evidence',$1,true)`, [captured.evidenceId]);
    const changed = await client.query(`UPDATE zzsh_order.payment_request SET state=$2,revision=revision+1,updated_at=clock_timestamp()
      WHERE id=$1 AND evidence_level='JOINPAY_CANDIDATE' AND state NOT IN('ACCEPTED','REVIEW_REQUIRED') RETURNING state`, [captured.requestId, next]);
    const actualState = changed.rows[0]?.state ?? (await client.query(`SELECT state FROM zzsh_order.payment_request WHERE id=$1`, [captured.requestId])).rows[0]?.state;
    if (actualState !== "ACCEPTED" && actualState !== "REVIEW_REQUIRED") throw conflict("Original collection request acceptance state is unavailable");
    await recordAudit(client, { actorType: "system", action: "order.payment.collection.accepted", objectType: "payment_request", objectId: captured.requestId,
      requestId: commandId, outcome: "SUCCESS", details: { evidenceId: captured.evidenceId, anchorId: anchor.anchorId, confirmationId: payment?.confirmationId ?? null,
        disposition: payment?.disposition ?? "CONFLICT", state: actualState } });
    return { ...captured, payment, conflict: anchor.binding === "OWNED_ELSEWHERE" || payment?.disposition === "CONFLICT" };
  });
}

export async function receiveJoinpayCollectionNotification(pool: Pool, options: FormalCollectionSourceOptions, rawQuery: string): Promise<{ status: 200 | 503; body: "success" | "fail" }> {
  try {
    // 在SQL/私有钥回调前校验品牌；单独OFFICIAL、拷贝对象和默认未装配均不能进入。
    readFormalCollectionAdmission(options.admission);
    if (typeof rawQuery !== "string" || Buffer.byteLength(rawQuery, "utf8") > 65536) return { status: 200, body: "fail" };
    const result = await acceptJoinpayCollectionEvidence(pool, options, { operation: "NOTIFY", rawQuery });
    return { status: 200, body: result.acknowledgement };
  } catch { return { status: 503, body: "fail" }; }
}

/** 内部恢复只读摘要；不返回签名表单/原响应，普通用户GET不能直接暴露内部原件reader。 */
export async function readJoinpayCollectionRecovery(client: PoolClient, requestId: string) {
  if (!ID.test(requestId)) throw invalid();
  const row = (await client.query<OriginalRow>(ORIGINAL_SQL, [requestId])).rows[0];
  if (!row) return null;
  const request = original(row);
  const attempts = (await client.query(`SELECT a.id,a.operation,a.profile_id,a.key_version_ref,a.lease_version::text,a.request_sha256,
    o.id AS observation_id,o.raw_sha256,o.event,o.result FROM zzsh_order.joinpay_collection_attempt a
    LEFT JOIN zzsh_order.joinpay_collection_observation o ON o.attempt_id=a.id WHERE a.request_id=$1 ORDER BY a.lease_version DESC LIMIT 1`, [requestId])).rows;
  return { requestId, originalOrderNo: request.originalOrderNo, merchantIdentityId: request.merchantIdentityId,
    amountCents: request.amountCents, state: request.state, latestAttempt: attempts[0] ?? null, formalAcceptance: false as const };
}
