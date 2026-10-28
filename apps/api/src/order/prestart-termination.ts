import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hashApprovalPayload } from "../auth/approval-audit";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { gameScopeSql } from "../auth/admin-scope";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { lockSettlement, type SettlementActor } from "./settlement-record";
import { readOrderTeamAccess } from "../im/order-team-access";
import { readPrestartRefundProgress } from "./prestart-refund-store";
import { prestartLiabilityPlan, recognizePrestartRefundLiability, verifyPrestartRefundLiability } from "../finance/prestart-refund-liability";
import { assertPrestartDecision, prestartTerminationEligibility, PRESTART_TERMINATION_STATES, PRESTART_TERMINATION_VERSION,
  type PrestartFacts, type PrestartTerminationState } from "./prestart-termination-model";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unavailable = (m: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", m);
const conflict = (m: string) => new SecurityApiError(409, "CONFLICT", m);
const missing = () => new SecurityApiError(404, "NOT_FOUND", "Order not found");
const utc = (c: string) => `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type PrestartPaymentBasis = Readonly<{
  orderId: string; renterUserId: string; ownerUserId: string; paymentConfirmationId: string;
  source: "JOINPAY" | "CONTROLLED"; merchantIdentityId: string; merchantOrderNo: string; channelTrxNo: string;
  amountCents: string; currency: "CNY"; digest: string;
}>;
type OrderFacts = {
  id: string; renter_user_id: string; owner_user_id: string; revision: string; status: string; order_cents: string;
  paid_confirmation_id: string | null; confirmation_id: string | null; payment_source: string | null;
  disposition: string | null; currency: string | null; amount_cents: string | null;
  merchant_identity_id: string | null; merchant_order_no: string | null; channel_trx_no: string | null;
  opening_confirmed: boolean; has_posting: boolean; pending_adjustment: boolean; earning_count: string;
  as_of: string; accepted_at: string | null;
};
type TerminationRow = {
  id: string; order_id: string; requested_by_user_id: string; requested_by_party: string; reason: string;
  state: PrestartTerminationState; revision: string; basis_digest: string; payment_basis: PrestartPaymentBasis;
  created_at: string; updated_at: string; approved_at: string | null; liability_root_id: string | null;
  liability_event_id: string | null; last_reason: string | null;
};
const COLUMNS = `id,order_id,requested_by_user_id,requested_by_party,reason,state,revision::text,basis_digest,payment_basis,
  ${utc("created_at")} AS created_at,${utc("updated_at")} AS updated_at,${utc("approved_at")} AS approved_at,
  liability_root_id,liability_event_id,last_reason`;

/** 缺结构/读取权限时不把它报成无申请，安装和权限由总Master归口。 */
export async function assertPrestartTerminationSchema(client: PoolClient) {
  const row = (await client.query(`SELECT to_regclass('zzsh_order.prestart_termination') IS NOT NULL
    AND to_regclass('zzsh_order.prestart_termination_decision') IS NOT NULL
    AND to_regprocedure('zzsh_order.prestart_liability_complete(text)') IS NOT NULL
    AND(SELECT count(*)=2 FROM pg_trigger WHERE tgrelid=to_regclass('zzsh_order.prestart_termination')
      AND tgname IN('prestart_termination_guard','prestart_request_closure') AND NOT tgisinternal AND tgenabled='O')
    AND has_table_privilege(current_user,to_regclass('zzsh_order.prestart_termination'),'SELECT') AS ready`)).rows[0];
  if (row?.ready !== true) throw unavailable("Prestart termination schema is not deployed");
}

async function originalFacts(client: PoolClient, orderId: string): Promise<OrderFacts> {
  const row = (await client.query<OrderFacts>(`SELECT o.id,o.renter_user_id,o.owner_user_id,o.revision::text,o.status,
    (o.rental_amount_cents+o.deposit_amount_cents)::text AS order_cents,o.paid_confirmation_id,c.id AS confirmation_id,
    c.source AS payment_source,c.disposition,c.currency,c.amount_cents::text,c.merchant_scope_id AS merchant_identity_id,
    c.merchant_order_no,c.provider_transaction_id AS channel_trx_no,${utc("statement_timestamp()")} AS as_of,${utc("c.accepted_at")} AS accepted_at,
    EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND (x.status='CONFIRMED'
      OR (SELECT count(DISTINCT party) FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=x.id AND a.version_no=x.version_no)=2)) AS opening_confirmed,
    EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id) AS has_posting,
    EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.kind='MANUAL_ADJUSTMENT' AND v.superseded_at IS NULL) AS pending_adjustment,
    (SELECT count(*) FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')::text AS earning_count
    FROM zzsh_order.rental_order o LEFT JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id WHERE o.id=$1`, [orderId])).rows[0];
  if (!row) throw missing();
  if (![row.opening_confirmed,row.has_posting,row.pending_adjustment].every(v => typeof v === "boolean")) throw unavailable("Prestart facts are incomplete");
  return row;
}
function eligibility(row: OrderFacts) {
  const facts: PrestartFacts = { orderState: row.status, paymentSource: row.payment_source, paymentDisposition: row.disposition,
    currency: row.currency, paidCents: row.amount_cents, orderCents: row.order_cents,
    paymentBound: row.confirmation_id !== null && row.confirmation_id === row.paid_confirmation_id,
    openingConfirmed: row.opening_confirmed, hasPosting: row.has_posting, pendingAdjustment: row.pending_adjustment,
    monetaryEarningCount: row.earning_count };
  return prestartTerminationEligibility(facts);
}
function paymentBasis(row: OrderFacts): PrestartPaymentBasis {
  if (!row.confirmation_id || !["JOINPAY","CONTROLLED"].includes(row.payment_source ?? "") || row.disposition !== "APPLIED"
    || row.currency !== "CNY" || !row.amount_cents || !row.merchant_identity_id || !row.merchant_order_no || !row.channel_trx_no) throw unavailable("Original applied payment is unavailable");
  const value = { orderId: row.id, renterUserId: row.renter_user_id, ownerUserId: row.owner_user_id,
    paymentConfirmationId: row.confirmation_id, source: row.payment_source as "JOINPAY" | "CONTROLLED",
    merchantIdentityId: row.merchant_identity_id, merchantOrderNo: row.merchant_order_no, channelTrxNo: row.channel_trx_no,
    amountCents: row.amount_cents, currency: "CNY" as const };
  return { ...value, digest: hashApprovalPayload({ schema: "prestart-payment-basis.v1", ...value }).hash };
}
function projection(row: TerminationRow | null, moneyReadable = true) {
  if (!row) return null;
  if (!PRESTART_TERMINATION_STATES.includes(row.state) || !row.payment_basis || row.payment_basis.digest !== row.basis_digest) throw unavailable("Prestart request is inconsistent");
  prestartLiabilityPlan(row.id,row.payment_basis);
  return { id: row.id, revision: row.revision, state: row.state, requestedByParty: row.requested_by_party,
    reason: row.reason, reviewReason: row.last_reason, createdAt: row.created_at, updatedAt: row.updated_at, approvedAt: row.approved_at,
    fullRefundCents: moneyReadable ? row.payment_basis.amountCents : null, currency: "CNY" as const,
    dataOrigin: row.payment_basis.source === "JOINPAY" ? "JOINPAY_LOCAL_ACCEPTANCE" as const : "LOCAL_CONTROLLED" as const,
    liabilityRecognized: row.state === "APPROVED" && row.liability_root_id !== null && row.liability_event_id !== null,
    channelSubmission: "NOT_REPORTED" as const, bankArrival: "UNKNOWN" as const };
}
async function current(client: PoolClient, orderId: string, lock = false) {
  return (await client.query<TerminationRow>(`SELECT ${COLUMNS} FROM zzsh_order.prestart_termination WHERE order_id=$1
    ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`, [orderId])).rows[0] ?? null;
}

/** 上层Admin reader先完成对象/finance授权；本地原责任不要求存在正常posting。 */
export async function readPrestartFinanceProjection(client:PoolClient,orderId:string){
 const row=await current(client,orderId);
 if(!row||row.state!=='APPROVED'||row.payment_basis?.source!=='JOINPAY')return null;
 await verifyPrestartRefundLiability(client,row.id,row.payment_basis,row.liability_root_id,row.liability_event_id);
 return {terminationId:row.id,paymentConfirmationId:row.payment_basis.paymentConfirmationId,merchantIdentityId:row.payment_basis.merchantIdentityId,
  originalCents:row.payment_basis.amountCents,liabilityRootId:row.liability_root_id,liabilityEventId:row.liability_event_id,
  refund:await readPrestartRefundProgress(client,row.id,row.payment_basis,true)};
}

/** GET只读授权与事实，不使用资金/订单FOR UPDATE锁，不出网或补写责任。 */
export async function readPrestartTermination(client: PoolClient, actor: SettlementActor, orderId: string) {
  if (!ID.test(orderId)) throw missing();
  let adminMoney = false;
  let canReview = false;
  if (actor.realm === "user") {
    await assertUserContextInTransaction(client, actor, "READ");
    const own = (await client.query(`SELECT id FROM zzsh_order.rental_order WHERE id=$1 AND (renter_user_id=$2 OR owner_user_id=$2)`, [orderId,actor.userId])).rowCount;
    if (own !== 1) throw missing();
  } else {
    await assertAdminContextInTransaction(client, actor);
    const access = await loadEffectiveAdminAccess(client,actor.userId);
    if (access?.status !== "ACTIVE" || !access.permissions.has(ADMIN_PERMISSION.orderRead)) throw new SecurityApiError(403,"FORBIDDEN","Order read required");
    const own = (await client.query(`SELECT o.id FROM zzsh_order.rental_order o WHERE o.id=$1 AND ${gameScopeSql("o.game_id","$2","$3")}`,
      [orderId,actor.userId,access.isBoss])).rowCount;
    if (own !== 1) throw missing();
    const team = access.permissions.has(ADMIN_PERMISSION.orderSettlementWrite)
      ? await readOrderTeamAccess(client,actor,orderId,"read") : null;
    canReview = team?.teamState === "READY" && team.canRead === true;
    adminMoney = access.permissions.has(ADMIN_PERMISSION.financeRead) || canReview;
  }
  await assertPrestartTerminationSchema(client);
  const facts = await originalFacts(client,orderId), request = await current(client,orderId);
  const moneyReadable = actor.realm === "user" ? actor.userId === facts.renter_user_id : adminMoney;
  const allowed = eligibility(facts);
  if (request?.state === "APPROVED") await verifyPrestartRefundLiability(client,request.id,request.payment_basis,request.liability_root_id,request.liability_event_id);
  const refund=request?.state==='APPROVED'?await readPrestartRefundProgress(client,request.id,request.payment_basis,moneyReadable):null;
  return { contractVersion: PRESTART_TERMINATION_VERSION, orderId, orderRevision: facts.revision,
    eligibility: {...allowed,refundCents: moneyReadable ? allowed.refundCents : null}, request: projection(request,moneyReadable),refund,
    coverage:"LOCAL_REGISTERED_ONLY" as const,canReview,asOf:facts.as_of??null,localAcceptanceObservedAt:facts.accepted_at??null,
    unknowns:["CHANNEL_QUERY_NOT_PERFORMED","BANK_ARRIVAL_NOT_VERIFIED"],bankArrival: "UNKNOWN" as const };
}

/** 与既有开租/结算共用dispatch→admin→双方→game→account→order锁序。 */
export async function authorizePrestartWrite(client: PoolClient, actor: SettlementActor, orderId: string) {
  if (!ID.test(orderId)) throw missing();
  return lockSettlement(client,orderId,actor,"PRESTART_TERMINATION");
}

export async function requestPrestartTermination(client: PoolClient, actor: SettlementActor, input: { orderId: string; expectedOrderRevision: string; reason: string; requestId: string }) {
  if (actor.realm !== "user") throw new SecurityApiError(403,"FORBIDDEN","An order party must request termination");
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || Buffer.byteLength(input.reason,"utf8")>600
    || typeof input.expectedOrderRevision !== "string" || !/^[1-9][0-9]{0,18}$/.test(input.expectedOrderRevision) || !ID.test(input.requestId)) throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid termination request");
  await authorizePrestartWrite(client,actor,input.orderId);
  await assertPrestartTerminationSchema(client);
  const facts = await originalFacts(client,input.orderId), permitted = eligibility(facts);
  if (facts.revision !== input.expectedOrderRevision) throw conflict("Order changed; reload the original order");
  if (!permitted.allowed) throw conflict(permitted.reason!);
  const found = await current(client,input.orderId,true);
  if (found && found.state !== "REJECTED") return { status:200,body:{ contractVersion:PRESTART_TERMINATION_VERSION,request:projection(found,actor.userId===facts.renter_user_id),existing:true,orderId:input.orderId } };
  const basis = paymentBasis(facts), id = `pterm_${randomUUID().replaceAll("-","")}`;
  const row = (await client.query<TerminationRow>(`INSERT INTO zzsh_order.prestart_termination
    (id,order_id,requested_by_user_id,requested_by_party,reason,basis_digest,payment_basis,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING ${COLUMNS}`,
    [id,input.orderId,actor.userId,actor.userId===facts.renter_user_id?"RENTER":"OWNER",input.reason.trim(),basis.digest,JSON.stringify(basis),input.requestId])).rows[0]!;
  await recordAudit(client,{actorType:"user",actorId:actor.userId,sessionId:actor.sessionId,action:"order.prestart.termination.requested",
    objectType:"prestart_termination",objectId:id,requestId:input.requestId,outcome:"SUCCESS",details:{orderId:input.orderId,basisDigest:basis.digest,channelResult:"NOT_SUBMITTED"}});
  return {status:200,body:{contractVersion:PRESTART_TERMINATION_VERSION,orderId:input.orderId,request:projection(row,actor.userId===facts.renter_user_id),existing:false}};
}

export async function reviewPrestartTermination(client: PoolClient, actor: SettlementActor, input: {
  orderId: string; terminationId: string; expectedRevision: unknown; decision: unknown; assessment?: unknown; reason: unknown; requestId: string;
}) {
  if (actor.realm !== "admin") throw new SecurityApiError(403,"FORBIDDEN","Support review is required");
  const review = assertPrestartDecision(input);
  if (!ID.test(input.terminationId) || !ID.test(input.requestId)) throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid termination reference");
  await authorizePrestartWrite(client,actor,input.orderId);
  await assertPrestartTerminationSchema(client);
  const row = await current(client,input.orderId,true);
  if (!row || row.id!==input.terminationId) throw missing();
  if (row.state==="APPROVED") {
    if(review.decision!=="APPROVE")throw conflict("Termination is already approved");
    await verifyPrestartRefundLiability(client,row.id,row.payment_basis,row.liability_root_id,row.liability_event_id);
    return {status:200,body:{contractVersion:PRESTART_TERMINATION_VERSION,orderId:input.orderId,request:projection(row),existing:true,channelResult:"NOT_SUBMITTED"}};
  }
  if (row.state==="REJECTED" || row.revision!==review.expectedRevision) throw conflict("Termination review changed");
  const facts = await originalFacts(client,input.orderId);
  let liability: {rootId:string;eventId:string}|null = null;
  if (review.decision==="APPROVE") {
    const permitted = eligibility(facts);
    if (!permitted.allowed) throw conflict(permitted.reason!);
    if (paymentBasis(facts).digest!==row.basis_digest) throw conflict("Original applied payment changed");
  }
  const state = review.decision==="APPROVE"?"APPROVED":review.decision==="REJECT"?"REJECTED":"REVIEW_REQUIRED";
  const changed = (await client.query<TerminationRow>(`UPDATE zzsh_order.prestart_termination SET state=$2,revision=revision+1,last_reason=$3,
    approved_at=CASE WHEN $2='APPROVED' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
    WHERE id=$1 AND revision=$4::bigint AND state IN('REQUESTED','REVIEW_REQUIRED') RETURNING ${COLUMNS}`,
    [row.id,state,review.reason,review.expectedRevision])).rows[0];
  if (!changed) throw conflict("Termination review changed");
  await client.query(`INSERT INTO zzsh_order.prestart_termination_decision(id,termination_id,result_revision,decision,assessment,reason,admin_user_id,session_id,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[`pterm_decision_${randomUUID().replaceAll("-","")}`,row.id,changed.revision,review.decision,
    review.assessment??null,review.reason,actor.userId,actor.sessionId,input.requestId]);
  if (state==="APPROVED") {
    liability = await recognizePrestartRefundLiability(client,row.id,row.payment_basis,input.requestId);
    await client.query(`UPDATE zzsh_order.prestart_termination SET liability_root_id=$2,liability_event_id=$3 WHERE id=$1`,[row.id,liability.rootId,liability.eventId]);
    const cancelled = await client.query(`UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='PRESTART_TERMINATED',cancelled_at=clock_timestamp(),
      revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND status='PAID' AND paid_confirmation_id=$2`,[row.order_id,row.payment_basis.paymentConfirmationId]);
    if (cancelled.rowCount!==1) throw conflict("Original paid order changed");
    await verifyPrestartRefundLiability(client,row.id,row.payment_basis,liability.rootId,liability.eventId);
    changed.liability_root_id=liability.rootId;changed.liability_event_id=liability.eventId;
  }
  await recordAudit(client,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,action:"order.prestart.termination.reviewed",
    objectType:"prestart_termination",objectId:row.id,requestId:input.requestId,outcome:"SUCCESS",details:{orderId:row.order_id,decision:review.decision,
    basisDigest:row.basis_digest,liabilityRootId:liability?.rootId??null,frozenDistributionBasisNotReversed:true,channelResult:"NOT_SUBMITTED"}});
  return {status:200,body:{contractVersion:PRESTART_TERMINATION_VERSION,orderId:input.orderId,request:projection(changed),existing:false,
    localFundsEffect:state==="APPROVED"?"REFUND_LIABILITY_RECOGNIZED":"NONE",channelResult:"NOT_SUBMITTED",bankArrival:"UNKNOWN"}};
}
