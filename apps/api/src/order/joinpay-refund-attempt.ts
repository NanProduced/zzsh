import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "../auth/security-core";
import { conflict, invalid } from "../supply/supply-util";
import { consumeNativeRentalRefundTerminal } from "../finance/native-rental-refund-store";
import { assertRefundResource, createFormalRefundIntent, formalRefundBinding, lockFormalRefundContext, FORMAL_REFUND_COLUMNS,
  type FormalRefundCreateInput, type FormalRefundRow, type NativeRefundState } from "./channel-refund-store";
import { assertFormalRefundProfile, describeRefundProfile, inspectRefundProfile, produceRefundRequest, readFormalRefundAdmission,
  readRefundOutbound, readRefundProfileEvidence, refundCompleteTimeToUtc, refundFailureMayRelease, refundWayAccepted, RefundProfileError, type BoundRefundProfile, type RefundBinding, type RefundOperation, type RefundOutbound } from "./joinpay-refund-profile";
import { captureRefundTerminalFact, refundTerminalConflicts, type RefundSourceOptions } from "./joinpay-refund-source";
import { preflightJoinpayRefundResponse } from "./joinpay-refund-protocol";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex"), fresh = (p: string) => `${p}_${randomUUID().replaceAll("-", "")}`;
export const JOINPAY_REFUND_MAX_AUTOMATIC_QUERIES = 10;
const leaseExpired = Symbol("refund live lease changed");
export class RefundAttemptCommitUnknown extends Error { readonly code = "REFUND_EXECUTION_UNKNOWN"; constructor(readonly intentId: string, readonly phase: "CLAIM" | "RESULT") { super("Recover the original refund before any new attempt"); } }
async function confirmed<T>(pool: Pool, id: string, phase: "CLAIM" | "RESULT", callback: (c: PoolClient) => Promise<T>) {
  let done = false; try { return await withTransaction(pool, async c => { const v = await callback(c); done = true; return v; }); }
  catch (error) { if (done) throw new RefundAttemptCommitUnknown(id, phase); throw error; }
}
export const createJoinpayNativeRefund = (pool: Pool, input: FormalRefundCreateInput) => withTransaction(pool, c => createFormalRefundIntent(c, input));
export type RefundExecution = RefundSourceOptions & { pool: Pool; fetch?: typeof globalThis.fetch };
type Prepared = { row: FormalRefundRow; binding: RefundBinding; profile: BoundRefundProfile; operation: "SUBMIT" | "QUERY"; attemptId: string; key: string; request: RefundOutbound; owner: string; version: string };
export type RefundExchange = Readonly<{ body: Uint8Array | null; responseComplete: boolean; receivedBytes: number; httpStatus: number | null;
  failure: "TIMEOUT" | "ABORTED" | "BODY_TOO_LARGE" | "HTTP_STATUS" | "NETWORK_ERROR" | null; evidenceLevel: "SYNTHETIC_PROTOCOL" | "PROVIDER_RESPONSE" }>;
/** 本退款产品的单次有界标准fetch；不伪造收款请求品牌、不自动retry。 */
export async function exchangeRefundRequest(request: RefundOutbound, dependencies: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}): Promise<RefundExchange> {
  const wire = readRefundOutbound(request); if (wire.purpose === "SYNTHETIC_PROTOCOL") throw new RefundProfileError("REFUND_SYNTHETIC_TRANSPORT_FORBIDDEN");
  const suppliedFetch = dependencies.fetch, signal = dependencies.signal, fetcher = suppliedFetch ?? globalThis.fetch, controller = new AbortController();
  const chunks: Uint8Array[] = [], deadline = performance.now() + 8000; let bytes = 0, kept = 0, status: number | null = null, complete = false, failure: RefundExchange["failure"] = null, timeout = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); }; controller.signal.addEventListener("abort", cancel, { once: true });
  const expired = () => { if (performance.now() >= deadline) { timeout = true; controller.abort(); } return controller.signal.aborted; };
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, 8000); let abortListener: (() => void) | undefined;
  const interrupted = new Promise<void>(resolve => { abortListener = () => { failure = timeout ? "TIMEOUT" : "ABORTED"; resolve(); }; if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener("abort", abortListener, { once: true }); });
  async function once() {
    if (expired()) return;
    try {
      const r = await fetcher(wire.endpoint, { method: "POST", body: wire.body, headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json" }, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
      status = r.status; if (expired()) { void r.body?.cancel().catch(() => {}); return; }
      const len = r.headers.get("content-length"); if (len && /^\d+$/.test(len) && BigInt(len) > 65536n) { failure = "BODY_TOO_LARGE"; void r.body?.cancel().catch(() => {}); return; }
      if (r.body) { reader = r.body.getReader(); for (;;) { const next = await reader.read(); if (expired()) return; if (next.done) break;
        if (!(next.value instanceof Uint8Array)) { failure = "NETWORK_ERROR"; cancel(); return; }
        bytes += next.value.byteLength; const part = new Uint8Array(next.value.subarray(0, 65536 - kept)); if (part.length) { chunks.push(part); kept += part.length; }
        if (bytes > 65536) { failure = "BODY_TOO_LARGE"; cancel(); return; }
      } }
      complete = true; if (status !== 200) failure = "HTTP_STATUS";
    } catch { if (!controller.signal.aborted) failure = "NETWORK_ERROR"; }
  }
  try { await Promise.race([once(), interrupted]); if (expired()) { failure = timeout ? "TIMEOUT" : "ABORTED"; complete = false; } }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", cancel); if (abortListener) controller.signal.removeEventListener("abort", abortListener); }
  return Object.freeze({ body: complete || kept ? Buffer.concat(chunks) : null, responseComplete: complete, receivedBytes: bytes, httpStatus: status, failure,
    evidenceLevel: suppliedFetch === undefined ? "PROVIDER_RESPONSE" : "SYNTHETIC_PROTOCOL" });
}
async function prepare(o: RefundExecution, intentId: string, owner: string, minimumIntervalSeconds?: number): Promise<Prepared | null> {
  return confirmed(o.pool, intentId, "CLAIM", async c => {
    const row = await lockFormalRefundContext(c, o.admission, intentId); if (["SUCCEEDED", "FAILED"].includes(row.state)) return null;
    const tables = (await c.query(`SELECT to_regclass('zzsh_order.joinpay_refund_attempt') IS NOT NULL AND to_regclass('zzsh_order.joinpay_refund_observation') IS NOT NULL AND to_regclass('zzsh_order.joinpay_refund_evidence') IS NOT NULL AS ready`)).rows[0];
    if (tables?.ready !== true) throw conflict("Native refund schema is not integrated");
    // 与原请求行锁同事务重核，两个worker不能靠扫描时的旧快照绕过补查间隔/预算。
    if (minimumIntervalSeconds !== undefined) {
      const due = (await c.query(`SELECT count(*) FILTER(WHERE operation='QUERY')<$3::integer
        AND COALESCE(max(created_at)<=clock_timestamp()-make_interval(secs=>$2::integer),true) AS allowed
        FROM zzsh_order.joinpay_refund_attempt WHERE intent_id=$1`, [intentId, minimumIntervalSeconds, JOINPAY_REFUND_MAX_AUTOMATIC_QUERIES])).rows[0]?.allowed;
      if (typeof due !== "boolean") throw conflict("Refund recovery timing evidence unavailable");
      if (!due) return null;
    }
    const operation = row.state === "READY" && row.lease_version === "0" ? "SUBMIT" : "QUERY", binding = formalRefundBinding(row, o.admission);
    if (operation === "SUBMIT") { const review = (await c.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND merchant_identity_id=$1 AND original_payment_trx_no=$2 AND requires_review) AS blocked`, [row.merchant_identity_id, row.original_payment_trx_no])).rows[0]; if (review?.blocked !== false) return null; }
    const profile = o.profileFor(operation, Object.freeze({ ...binding })), p = describeRefundProfile(profile, operation); assertFormalRefundProfile(o.admission, profile, operation);
    const updated = (await c.query<FormalRefundRow>(`UPDATE zzsh_order.channel_refund_intent SET state=CASE WHEN state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END,
      lease_version=lease_version+1,lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds',revision=revision+1
      WHERE id=$1 AND payment_source='JOINPAY' AND state IN ('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED') AND due_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING ${FORMAL_REFUND_COLUMNS}`, [intentId, owner])).rows[0]; if (!updated) return null;
    let key: string; try { key = o.keyFor(p.keyVersionRef); } catch { throw new RefundProfileError("REFUND_KEY_UNAVAILABLE"); }
    const request = produceRefundRequest(profile, operation, binding, key), wire = readRefundOutbound(request), attemptId = fresh("rfa");
    await c.query(`INSERT INTO zzsh_order.joinpay_refund_attempt(id,intent_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,admission_sha256,request_body,request_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [attemptId, intentId, operation, updated.lease_version, owner, p.profileId, readRefundProfileEvidence(profile), p.profileSha256, p.keyVersionRef, readFormalRefundAdmission(o.admission).sha256, Buffer.from(wire.body), request.requestSha256]);
    await recordAudit(c, { actorType: "system", action: "order.refund.native.claimed", objectType: "channel_refund_intent", objectId: intentId, outcome: "SUCCESS", requestId: attemptId, details: { operation, leaseVersion: updated.lease_version, requestSha256: request.requestSha256 } });
    return { row: updated, binding, profile, operation, attemptId, key, request, owner, version: updated.lease_version };
  });
}
type Received = { operation: RefundOperation; profile: BoundRefundProfile; key: string | null; attemptId: string | null; version: string | null; owner: string | null; exchange: RefundExchange };
async function recordReceived(c: PoolClient, o: RefundSourceOptions, intentId: string, received: Received, requestId: string) {
  const row = await lockFormalRefundContext(c, o.admission, intentId), binding = formalRefundBinding(row, o.admission), p = describeRefundProfile(received.profile, received.operation);
  const reviewOnly = row.requires_review || row.state === "REVIEW_REQUIRED";
  assertFormalRefundProfile(o.admission, received.profile, received.operation);
  const liveSql = `SELECT lease_version=$2::bigint AND lease_owner=$3 AND lease_until>clock_timestamp() AS current FROM zzsh_order.channel_refund_intent WHERE id=$1`;
  const leaseArgs = [intentId, received.version, received.owner], live = received.operation === "NOTIFY" || (await c.query(liveSql, leaseArgs)).rows[0]?.current === true;
  async function persist(stale: boolean) {
    let schema = "NOT_CHECKED", signature = "NOT_CHECKED", bound = "NOT_CHECKED", next: NativeRefundState = row.state, event = stale ? "STALE" : "UNKNOWN", qualified = false, hardConflict = false;
    if (!stale && received.exchange.responseComplete && received.exchange.failure === null && received.exchange.body !== null && received.key !== null) {
      const body = received.operation === "NOTIFY" ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(received.exchange.body) : received.exchange.body;
      const d = inspectRefundProfile(received.profile, received.operation, body, binding, received.key);
      signature = d.signature; schema = signature === "NOT_CHECKED" ? "INVALID" : "VALID";
      bound = signature !== "MATCH" ? "NOT_CHECKED" : ["BINDING_MISMATCH", "REFUND_TRANSACTION_MISMATCH"].includes(d.reason ?? "") ? "MISMATCH" : "MATCH";
      const terminal = d.result === "CHANNEL_REPORTED_SUCCEEDED" && !!d.completedAtRaw && !!d.providerRefundTrxNo && refundWayAccepted(received.profile, d.refundWay) ? "SUCCEEDED"
        : d.result === "CHANNEL_REPORTED_FAILED" && refundFailureMayRelease(received.profile, d) ? "FAILED" : null;
      qualified = terminal !== null && received.exchange.evidenceLevel === "PROVIDER_RESPONSE";
      hardConflict = !!row.terminal_evidence_id && signature === "MATCH" && (terminal !== null && terminal !== row.state || d.reason === "REFUND_TRANSACTION_MISMATCH");
      if(row.terminal_evidence_id && qualified && terminal) hardConflict ||= refundTerminalConflicts({terminal:row.state,refundTransactionNo:row.provider_refund_trx_no,completedAt:row.completed_at===null?null:new Date(row.completed_at).toISOString()},
        {terminal,refundTransactionNo:d.providerRefundTrxNo??null,completedAt:d.completedAtRaw?refundCompleteTimeToUtc(received.profile,d.completedAtRaw):null});
      if (signature === "MATCH" && bound === "MATCH" && d.providerRefundTrxNo) {
        await c.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-transaction:v1','JOINPAY',$1::text,$2::text)::text,0))`, [row.merchant_identity_id, d.providerRefundTrxNo]);
        const owner = (await c.query(`SELECT id FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND merchant_identity_id=$1 AND provider_refund_trx_no=$2 AND id<>$3`, [row.merchant_identity_id, d.providerRefundTrxNo, row.id])).rows[0];
        if (owner) hardConflict = true;
      }
      if (hardConflict || reviewOnly && qualified) event = "REVIEW";
      else if (qualified) event = row.terminal_evidence_id ? "TERMINAL" : "PENDING_TERMINAL";
      else if (signature === "MATCH" && bound === "MATCH" && !["SUCCEEDED", "FAILED"].includes(row.state)) {
        next = d.result === "PROCESSING" || d.result === "APPLICATION_ACCEPTED" ? "PROCESSING" : "UNKNOWN"; event = next === "PROCESSING" ? "PROCESSING" : "UNKNOWN";
      }
    } else if (!stale && received.exchange.responseComplete && received.exchange.failure === null && received.exchange.body !== null && received.key === null) schema = "INVALID";
    else if (!stale && received.operation !== "NOTIFY" && !["SUCCEEDED", "FAILED"].includes(row.state)) next = "UNKNOWN";
    const observationId = fresh("rfo"), e = received.exchange;
    await c.query(`INSERT INTO zzsh_order.joinpay_refund_observation(id,intent_id,attempt_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,
      raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [observationId, intentId, received.attemptId, received.operation, received.version, received.owner, p.profileId, readRefundProfileEvidence(received.profile), p.profileSha256, p.keyVersionRef,
        e.body === null ? null : Buffer.from(e.body), e.body === null ? null : sha(e.body), e.responseComplete, e.httpStatus, e.receivedBytes, e.failure, event, schema, signature, bound, e.evidenceLevel, row.state, next, requestId]);
    if (hardConflict) await c.query(`UPDATE zzsh_order.channel_refund_intent SET requires_review=true,revision=revision+1 WHERE id=$1 AND NOT requires_review`, [intentId]);
    if (next !== row.state) {
      const changed = await c.query(`UPDATE zzsh_order.channel_refund_intent SET state=$2,revision=revision+1 WHERE id=$1 AND state=$3 AND revision=$4::bigint
        AND ($5::boolean OR (lease_version=$6::bigint AND lease_owner=$7 AND lease_until>clock_timestamp()))`, [intentId, next, row.state, row.revision, received.operation === "NOTIFY", received.version, received.owner]);
      if (changed.rowCount !== 1) throw Object.assign(conflict("Refund lease changed"), { [leaseExpired]: true });
    }
    let terminal: Awaited<ReturnType<typeof consumeNativeRentalRefundTerminal>> | null = null;
    if (qualified && !hardConflict && !reviewOnly) { const fact = await captureRefundTerminalFact(c, o, intentId, observationId); if (fact) terminal = await consumeNativeRentalRefundTerminal(c, { fact, requestId }); }
    await recordAudit(c, { actorType: "system", action: "order.refund.native.observed", objectType: "channel_refund_intent", objectId: intentId, outcome: "SUCCESS", requestId,
      details: { observationId, operation: received.operation, event, evidenceLevel: e.evidenceLevel, terminal: terminal?.event ?? null, rawSha256: e.body === null ? null : sha(e.body) } });
    return { intentId, observationId, event, terminal, ack: terminal && ["CONSUMED", "RELEASED", "REPLAYED"].includes(terminal.event) ? "success" as const : "fail" as const };
  }
  if (!live) return persist(true);
  await c.query("SAVEPOINT native_refund_result");
  try { const result = await persist(false); await c.query("RELEASE SAVEPOINT native_refund_result"); return result; }
  catch (error) {
    const e = error as { code?: string; constraint?: string; [leaseExpired]?: boolean };
    if (received.operation === "NOTIFY" || !(e[leaseExpired] === true || e.code === "23514" && e.constraint === "joinpay_refund_live_lease")) throw error;
    await c.query("ROLLBACK TO SAVEPOINT native_refund_result");
    if ((await c.query(liveSql, leaseArgs)).rows[0]?.current !== false) throw error;
    const result = await persist(true); await c.query("RELEASE SAVEPOINT native_refund_result"); return result;
  }
}
export async function executeJoinpayRefund(o: RefundExecution, intentId: string, owner: string, minimumIntervalSeconds?: number) {
  if (!ID.test(intentId) || !ID.test(owner) || minimumIntervalSeconds !== undefined && (!Number.isSafeInteger(minimumIntervalSeconds) || minimumIntervalSeconds < 30 || minimumIntervalSeconds > 86400)) throw invalid();
  readFormalRefundAdmission(o.admission); const a = await prepare(o, intentId, owner, minimumIntervalSeconds); if (!a) return null;
  const exchange = await exchangeRefundRequest(a.request, { fetch: o.fetch });
  return confirmed(o.pool, intentId, "RESULT", c => recordReceived(c, o, intentId, { operation: a.operation, profile: a.profile, key: a.key, attemptId: a.attemptId, version: a.version, owner: a.owner, exchange }, a.attemptId));
}
/** 通知只定位已知原号后取唯一key；原件/终态同一事务提交，异常不回成功。 */
export async function receiveJoinpayRefundNotification(o: RefundExecution, intentId: string, raw: string, requestId: string) {
  if (!ID.test(intentId) || !ID.test(requestId) || Buffer.byteLength(raw) > 65536 || /\p{Cs}/u.test(raw)) throw invalid();
  readFormalRefundAdmission(o.admission);
  return confirmed(o.pool, intentId, "RESULT", async c => {
    await assertRefundResource(c, o.admission); const row = await lockFormalRefundContext(c, o.admission, intentId), binding = formalRefundBinding(row, o.admission);
    const profile = o.profileFor("NOTIFY", Object.freeze({ ...binding })), p = describeRefundProfile(profile, "NOTIFY"); assertFormalRefundProfile(o.admission, profile, "NOTIFY");
    let key: string | null = null;
    if (preflightJoinpayRefundResponse("REFUND_NOTIFY", raw).ok) {
      try { key = o.keyFor(p.keyVersionRef); } catch { throw new RefundProfileError("REFUND_KEY_UNAVAILABLE"); }
    }
    return recordReceived(c, o, intentId, { operation: "NOTIFY", profile, key, attemptId: null, version: null, owner: null,
      exchange: Object.freeze({ body: Buffer.from(raw), responseComplete: true, receivedBytes: Buffer.byteLength(raw), httpStatus: null, failure: null, evidenceLevel: "PROVIDER_RESPONSE" }) }, requestId);
  });
}
/** 内部恢复纯SELECT；对象范围/摘要脱敏由Admin reader再裁剪，不补退款事实或重发。 */
export async function readNativeRefundRecovery(c: PoolClient, intentId: string) {
  if (!ID.test(intentId)) throw invalid(); const r = (await c.query(`SELECT id,refund_order_no,state,budget_disposition,requires_review,terminal_evidence_id,terminal_root_id,terminal_event_id FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='JOINPAY'`, [intentId])).rows[0];
  return r ? { intentId: r.id, originalRefundOrderNo: r.refund_order_no, state: r.state, budgetDisposition: r.budget_disposition, requiresReview: r.requires_review,
    evidenceId: r.terminal_evidence_id, rootId: r.terminal_root_id, eventId: r.terminal_event_id, mayResubmit: false } : null;
}
