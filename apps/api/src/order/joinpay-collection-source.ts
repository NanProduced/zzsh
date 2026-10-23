import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit } from "../auth/security-core";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { decodeJoinpayQuery, type RequestState } from "./joinpay-protocol";
import { assertFormalCollectionProfile, assertFormalInitialAdmission, describeCollectionProfile, inspectJoinpayCollectionNotification,
  inspectJoinpayCollectionResponse, joinpayProviderTimeToUtc, readCollectionProfileEvidence, readFormalCollectionAdmission,
  JoinpayCollectionProfileError, type BoundCollectionProfile, type CollectionPersistedBinding, type CollectionProfileOperation,
  type FormalCollectionAdmission, type FormalCollectionAdmissionView } from "./joinpay-collection-profile";
import type { PaymentInput } from "./payment-confirmation";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const JOINPAY_COLLECTION_EVIDENCE_LIMIT = 65536;
export type FormalCollectionSourceOptions = {
  admission: FormalCollectionAdmission;
  profileFor: (operation: CollectionProfileOperation, original: Readonly<CollectionPersistedBinding>,
    pinned?: Readonly<{ profileId: string; profileSha256: string; keyVersionRef: string }>) => BoundCollectionProfile;
  keyFor: (keyVersionRef: string) => string;
};
type Row = {
  request_id: string; order_id: string; state: RequestState; merchant_identity_id: string; channel_order_no: string; amount_cents: string;
  method: "ALIPAY_NATIVE" | "WEIXIN_NATIVE"; config_profile_id: string; key_version_ref: string; channel: string; evidence_level: string;
  wire_merchant_no: string; trade_merchant_no: string; product_name: string; notify_url: string; initial_profile_sha256: string;
  formal_admission_ref: string | null; formal_admission_sha256: string | null; formal_admission_canonical: string | null;
};
const COLUMNS = `r.id AS request_id,r.order_id,r.state,r.merchant_identity_id,r.channel_order_no,r.amount_cents::text,r.method,r.config_profile_id,
 r.key_version_ref,r.channel,r.evidence_level,b.wire_merchant_no,b.trade_merchant_no,b.product_name,b.notify_url,b.initial_profile_sha256,
 b.formal_admission_ref,b.formal_admission_sha256,b.formal_admission_canonical`;
const FROM = ` FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id`;
function original(row: Row, view: FormalCollectionAdmissionView, admission: FormalCollectionAdmission): Readonly<CollectionPersistedBinding> {
  if (row.channel !== "JOINPAY" || row.evidence_level !== "JOINPAY_CANDIDATE" || row.merchant_identity_id !== view.merchantIdentityId
    || row.wire_merchant_no !== view.wireMerchantNo || !row.formal_admission_ref || !row.formal_admission_sha256 || !row.formal_admission_canonical
    || sha(row.formal_admission_canonical) !== row.formal_admission_sha256) throw conflict("Original formal collection admission is unavailable");
  assertFormalInitialAdmission(admission, row.formal_admission_ref, row.formal_admission_sha256);
  let initial: { kind?: string; reference?: string; appId?: string; database?: string; runtimeUser?: string; merchantIdentityId?: string; wireMerchantNo?: string;
    acceptedProfiles?: { operation: string; profileId: string; profileSha256: string; keyVersionRef: string }[] };
  try { initial = JSON.parse(row.formal_admission_canonical); } catch { throw conflict("Original collection admission is not canonical"); }
  if (initial.kind !== "JOINPAY_FORMAL_SERVER_REVIEW" || initial.reference !== row.formal_admission_ref || initial.appId !== view.appId || initial.database !== view.database || initial.runtimeUser !== view.runtimeUser
    || initial.merchantIdentityId !== row.merchant_identity_id || initial.wireMerchantNo !== row.wire_merchant_no
    || !Array.isArray(initial.acceptedProfiles) || !initial.acceptedProfiles.some(p => p.operation === "SUBMIT" && p.profileId === row.config_profile_id
      && p.profileSha256 === row.initial_profile_sha256 && p.keyVersionRef === row.key_version_ref)) throw conflict("Original formal merchant binding differs");
  return Object.freeze({ requestId: row.request_id, originalOrderNo: row.channel_order_no, amountCents: row.amount_cents, method: row.method,
    wireMerchantNo: row.wire_merchant_no, tradeMerchantNo: row.trade_merchant_no, productName: row.product_name, notifyUrl: row.notify_url,
    profileId: row.config_profile_id, keyVersionRef: row.key_version_ref, merchantIdentityId: row.merchant_identity_id });
}
async function resource(client: PoolClient, view: FormalCollectionAdmissionView): Promise<string> {
  const identity = (await client.query(`SELECT current_database() AS db,current_user AS actor,pg_current_xact_id()::text AS xid`)).rows[0];
  if (identity?.db !== view.database || identity?.actor !== view.runtimeUser || !/^[1-9]\d*$/.test(identity.xid ?? "")) throw conflict("Formal collection resource differs");
  return identity.xid;
}
export async function readFormalCollectionRequest(client: PoolClient, admission: FormalCollectionAdmission, requestId: string) {
  if (!ID.test(requestId)) throw invalid(); const view = readFormalCollectionAdmission(admission); await resource(client, view);
  const row = (await client.query<Row>(`SELECT ${COLUMNS}${FROM} WHERE r.id=$1 FOR UPDATE OF r`, [requestId])).rows[0];
  if (!row) throw notFound(); return original(row, view, admission);
}
function key(options: FormalCollectionSourceOptions, reference: string): string {
  try { return options.keyFor(reference); } catch { throw new JoinpayCollectionProfileError("COLLECTION_KEY_UNAVAILABLE"); }
}
type QueryRaw = { observation_id: string; raw_body: Buffer; raw_sha256: string; profile_id: string; profile_sha256: string; key_version_ref: string;
  profile_canonical: string; operation: string; event: string; response_complete: boolean; http_status: number; transport_failure: string | null };
async function queryRaw(client: PoolClient, observationId: string, requestId: string): Promise<QueryRaw> {
  const row = (await client.query<QueryRaw>(`SELECT o.id AS observation_id,o.raw_body,o.raw_sha256,o.event,o.response_complete,o.http_status,o.transport_failure,
    a.profile_id,a.profile_sha256,a.key_version_ref,a.profile_canonical,a.operation FROM zzsh_order.joinpay_collection_observation o
    JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id AND a.request_id=o.request_id WHERE o.id=$1 AND o.request_id=$2`, [observationId, requestId])).rows[0];
  if (!row || row.operation !== "QUERY" || row.event !== "E4" || row.response_complete !== true || row.http_status !== 200 || row.transport_failure !== null
    || !Buffer.isBuffer(row.raw_body) || row.raw_body.length > JOINPAY_COLLECTION_EVIDENCE_LIMIT || sha(row.raw_body) !== row.raw_sha256
    || sha(row.profile_canonical) !== row.profile_sha256) throw conflict("Original complete query evidence is unavailable");
  return row;
}
export type CapturedCollectionEvidence = Readonly<{ evidenceId: string; requestId: string; event: string; acknowledgement: "success" | "fail" }>;
/** 调用方持原事务；没有初始正式准入的旧模型行绝不在此补写或提升。 */
export async function captureJoinpayCollectionEvidence(client: PoolClient, options: FormalCollectionSourceOptions, input:
  { operation: "NOTIFY"; rawQuery: string } | { operation: "QUERY"; requestId: string; observationId: string }): Promise<CapturedCollectionEvidence> {
  const view = readFormalCollectionAdmission(options.admission); await resource(client, view);
  let row: Row | undefined;
  if (input.operation === "NOTIFY") {
    if (typeof input.rawQuery !== "string" || Buffer.byteLength(input.rawQuery, "utf8") > JOINPAY_COLLECTION_EVIDENCE_LIMIT) throw invalid("Notification exceeds the raw query limit");
    const locator = decodeJoinpayQuery(input.rawQuery);
    if (!locator.ok || locator.raw.get("r1_MerchantNo")?.value !== view.wireMerchantNo) throw notFound();
    const orderNo = locator.raw.get("r2_OrderNo")?.value;
    if (!orderNo || !/^[A-Za-z0-9_]{1,50}$/.test(orderNo)) throw notFound();
    row = (await client.query<Row>(`SELECT ${COLUMNS}${FROM} WHERE r.channel='JOINPAY' AND r.merchant_identity_id=$1 AND r.channel_order_no=$2 FOR UPDATE OF r`,
      [view.merchantIdentityId, orderNo])).rows[0];
  } else {
    if (!ID.test(input.requestId) || !ID.test(input.observationId)) throw invalid();
    row = (await client.query<Row>(`SELECT ${COLUMNS}${FROM} WHERE r.id=$1 FOR UPDATE OF r`, [input.requestId])).rows[0];
  }
  if (!row) throw notFound();
  const binding = original(row, view, options.admission), rawQuery = input.operation === "NOTIFY" ? input.rawQuery : null;
  const pinned = input.operation === "QUERY" ? await queryRaw(client, input.observationId, row.request_id) : undefined;
  const profile = options.profileFor(input.operation, binding, pinned && Object.freeze({ profileId: pinned.profile_id, profileSha256: pinned.profile_sha256, keyVersionRef: pinned.key_version_ref }));
  assertFormalCollectionProfile(options.admission, profile, input.operation);
  const snapshot = describeCollectionProfile(profile, input.operation), canonical = readCollectionProfileEvidence(profile, input.operation);
  if (pinned && (snapshot.profileId !== pinned.profile_id || snapshot.profileSha256 !== pinned.profile_sha256 || snapshot.keyVersionRef !== pinned.key_version_ref
    || canonical !== pinned.profile_canonical)) throw conflict("Query profile differs from its committed attempt");
  const raw = rawQuery === null ? pinned!.raw_body : Buffer.from(rawQuery, "utf8"), rawSha = sha(raw);
  const decision = input.operation === "NOTIFY" ? inspectJoinpayCollectionNotification(profile, rawQuery!, binding, key(options, snapshot.keyVersionRef))
    : inspectJoinpayCollectionResponse(profile, "QUERY", raw, binding, key(options, snapshot.keyVersionRef));
  const trx = input.operation === "NOTIFY" ? decision.values?.r7_TrxNo : decision.values?.r5_TrxNo;
  const paidAt = decision.verified && decision.event === "E4" && decision.providerPaidAtRaw
    ? joinpayProviderTimeToUtc(profile, input.operation, decision.providerPaidAtRaw) : null;
  const evidenceId = `jpe_${sha(JSON.stringify([row.request_id, input.operation, rawSha, snapshot.profileSha256, snapshot.keyVersionRef])).slice(0, 32)}`;
  const inserted = await client.query(`INSERT INTO zzsh_order.joinpay_collection_evidence(id,request_id,operation,origin_observation_id,raw_query,raw_sha256,
    profile_id,profile_sha256,profile_canonical,key_version_ref,initial_admission_ref,initial_admission_sha256,
    admission_ref,admission_sha256,admission_canonical,event,result,schema_outcome,signature_outcome,binding_outcome,channel_trx_no,provider_paid_at_raw,provider_paid_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT(id) DO NOTHING`,
    [evidenceId, row.request_id, input.operation, input.operation === "QUERY" ? input.observationId : null, rawQuery === null ? null : raw, rawSha,
      snapshot.profileId, snapshot.profileSha256, canonical, snapshot.keyVersionRef, row.formal_admission_ref, row.formal_admission_sha256,
      view.reference, view.sha256, view.canonical, decision.event, decision.result, decision.schema, decision.signature, decision.binding,
      trx ?? null, decision.providerPaidAtRaw ?? null, paidAt]);
  if (inserted.rowCount === 1) await recordAudit(client, { actorType: "system", action: "order.payment.collection.evidence.captured", objectType: "payment_request", objectId: row.request_id,
    requestId: evidenceId, outcome: "SUCCESS", details: { evidenceId, operation: input.operation, event: decision.event, rawSha256: rawSha } });
  return { evidenceId, requestId: row.request_id, event: decision.event,
    acknowledgement: decision.verified && (decision.event === "E4" || decision.event === "E5") ? "success" : "fail" };
}

export type FormalJoinpayPaymentFact = PaymentInput & Readonly<{ source: "JOINPAY"; merchantScopeId: string; paymentRequestId: string; evidenceId: string; anchorId: string }>;
export type FormalJoinpayFactScope = Readonly<{ appId: string; database: string; runtimeUser: string; admissionSha256: string;
  paymentRequestId: string; evidenceId: string; anchorId: string; merchantOrderNo: string }>;
const facts = new WeakMap<object, { client: PoolClient; xid: string; scope: FormalJoinpayFactScope }>();
/** 只从持久原件重验产生品牌；没有通用register或从HTTP事实JSON创建的入口。 */
export async function readFormalJoinpayPaymentFact(client: PoolClient, options: FormalCollectionSourceOptions, evidenceId: string, requestId: string): Promise<FormalJoinpayPaymentFact> {
  if (!ID.test(evidenceId) || !ID.test(requestId)) throw invalid();
  const view = readFormalCollectionAdmission(options.admission), xid = await resource(client, view);
  const evidence = (await client.query(`SELECT * FROM zzsh_order.joinpay_collection_evidence WHERE id=$1`, [evidenceId])).rows[0];
  if (!evidence || !["NOTIFY", "QUERY"].includes(evidence.operation) || evidence.event !== "E4") throw conflict("Successful original collection evidence is required");
  const row = (await client.query<Row>(`SELECT ${COLUMNS}${FROM} WHERE r.id=$1 FOR UPDATE OF r`, [evidence.request_id])).rows[0];
  if (!row) throw notFound();
  const binding = original(row, view, options.admission);
  if (evidence.initial_admission_ref !== row.formal_admission_ref || evidence.initial_admission_sha256 !== row.formal_admission_sha256
    || typeof evidence.admission_canonical !== "string" || sha(evidence.admission_canonical) !== evidence.admission_sha256) throw conflict("Evidence admission differs from its original request");
  assertFormalInitialAdmission(options.admission, evidence.admission_ref, evidence.admission_sha256);
  let accepted: Record<string, unknown>;
  try { accepted = JSON.parse(evidence.admission_canonical); } catch { throw conflict("Evidence admission is invalid"); }
  if (accepted.kind !== "JOINPAY_FORMAL_SERVER_REVIEW" || accepted.reference !== evidence.admission_ref || accepted.appId !== view.appId
    || accepted.database !== view.database || accepted.runtimeUser !== view.runtimeUser || accepted.merchantIdentityId !== row.merchant_identity_id
    || accepted.wireMerchantNo !== row.wire_merchant_no) throw conflict("Evidence merchant admission differs");
  const profile = options.profileFor(evidence.operation, binding, Object.freeze({ profileId: evidence.profile_id, profileSha256: evidence.profile_sha256, keyVersionRef: evidence.key_version_ref }));
  assertFormalCollectionProfile(options.admission, profile, evidence.operation);
  const snapshot = describeCollectionProfile(profile, evidence.operation);
  if (snapshot.profileId !== evidence.profile_id || snapshot.profileSha256 !== evidence.profile_sha256 || snapshot.keyVersionRef !== evidence.key_version_ref
    || readCollectionProfileEvidence(profile, evidence.operation) !== evidence.profile_canonical || sha(evidence.profile_canonical) !== evidence.profile_sha256) throw conflict("Evidence profile differs");
  const storedQuery = evidence.operation === "QUERY" ? await queryRaw(client, evidence.origin_observation_id, row.request_id) : null;
  const raw: Buffer = storedQuery ? storedQuery.raw_body : evidence.raw_query;
  if (!Buffer.isBuffer(raw) || raw.length > JOINPAY_COLLECTION_EVIDENCE_LIMIT || sha(raw) !== evidence.raw_sha256
    || storedQuery && (storedQuery.profile_sha256 !== snapshot.profileSha256 || storedQuery.key_version_ref !== snapshot.keyVersionRef)) throw conflict("Evidence raw bytes differ");
  let rawQuery: string | undefined;
  if (!storedQuery) { try { rawQuery = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { throw conflict("Notification raw bytes are invalid UTF8"); } }
  const decision = evidence.operation === "QUERY" ? inspectJoinpayCollectionResponse(profile, "QUERY", raw, binding, key(options, snapshot.keyVersionRef))
    : inspectJoinpayCollectionNotification(profile, rawQuery!, binding, key(options, snapshot.keyVersionRef));
  const trx = evidence.operation === "QUERY" ? decision.values?.r5_TrxNo : decision.values?.r7_TrxNo;
  if (!decision.verified || decision.event !== "E4" || !trx || !decision.providerPaidAtRaw) throw conflict("Original collection source did not verify");
  const paidAt = joinpayProviderTimeToUtc(profile, evidence.operation, decision.providerPaidAtRaw);
  if (trx !== evidence.channel_trx_no || decision.providerPaidAtRaw !== evidence.provider_paid_at_raw
    || new Date(evidence.provider_paid_at).toISOString() !== paidAt) throw conflict("Persisted collection facts differ from the signed original");
  const funds = ["JOINPAY", row.merchant_identity_id, trx];
  const anchorId = `paytrx_${sha(JSON.stringify(funds)).slice(0, 32)}`;
  const fact = Object.freeze({ source: "JOINPAY" as const, merchantScopeId: row.merchant_identity_id, orderId: row.order_id,
    merchantOrderNo: row.channel_order_no, providerTransactionId: trx, amountCents: row.amount_cents, currency: "CNY", providerPaidAt: paidAt,
    requestId, paymentRequestId: row.request_id, evidenceId, anchorId });
  facts.set(fact, { client, xid, scope: Object.freeze({ appId: view.appId, database: view.database, runtimeUser: view.runtimeUser,
    admissionSha256: view.sha256, paymentRequestId: row.request_id, evidenceId, anchorId, merchantOrderNo: row.channel_order_no }) });
  return fact;
}
export async function readVerifiedJoinpayFactScope(client: PoolClient, fact: unknown): Promise<FormalJoinpayFactScope> {
  const proof = fact && typeof fact === "object" ? facts.get(fact) : null;
  if (!proof || proof.client !== client) throw invalid("Payment fact is not verified on this transaction");
  const row = (await client.query(`SELECT current_database() AS db,current_user AS actor,pg_current_xact_id()::text AS xid`)).rows[0];
  if (row?.db !== proof.scope.database || row?.actor !== proof.scope.runtimeUser || row?.xid !== proof.xid) throw invalid("Formal payment fact transaction differs");
  return proof.scope;
}
/** 内部恢复只读；不返回raw、不出网、不填补漏失basis。 */
export async function readJoinpayCollectionEvidenceRecovery(client: PoolClient, evidenceId: string) {
  if (!ID.test(evidenceId)) throw invalid();
  const row = (await client.query(`SELECT e.id,e.request_id,e.operation,e.raw_sha256,e.event,e.channel_trx_no,r.channel_order_no,
    p.id AS confirmation_id,p.disposition,b.basis_digest FROM zzsh_order.joinpay_collection_evidence e
    JOIN zzsh_order.payment_request r ON r.id=e.request_id LEFT JOIN zzsh_order.payment_confirmation p
      ON p.source='JOINPAY' AND p.merchant_scope_id=r.merchant_identity_id AND p.provider_transaction_id=e.channel_trx_no AND p.order_id=r.order_id
    LEFT JOIN zzsh_order.payment_distribution_basis b ON b.payment_confirmation_id=p.id WHERE e.id=$1`, [evidenceId])).rows[0];
  return row ? { evidenceId: row.id, requestId: row.request_id, originalOrderNo: row.channel_order_no, operation: row.operation,
    rawSha256: row.raw_sha256, event: row.event, confirmationId: row.confirmation_id ?? null, disposition: row.disposition ?? null,
    basisKnowledge: row.disposition === "APPLIED" ? row.basis_digest ? "PRESENT_REQUIRES_ORIGINAL_READ" : "UNKNOWN_MISSING_ORIGINAL_BASIS" : "NOT_APPLIED", mayResubmit: false } : null;
}
