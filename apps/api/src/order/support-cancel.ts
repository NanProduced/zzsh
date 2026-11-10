import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hashApprovalPayload } from "../auth/approval-audit";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { recognizePrestartRefundLiability, verifyPrestartRefundLiability } from "../finance/prestart-refund-liability";
import { assertSupportOrderAccess, type ManualCloseActor } from "./manual-close";
import { lockSettlement } from "./settlement-record";
import { readPrestartRefundProgress } from "./prestart-refund-store";
import { assertEcsTestDemoOrderAdmission, assertEcsTestDemoResource, demoFinanceScope } from "../finance/ecs-test-demo-resource";
import type { PrestartPaymentBasis } from "./prestart-termination";
import {
  supportCancelEligibility, supportCancelConflict,supportPoststartCancellationAllocation,supportPoststartCancellationEligibility,
  type SupportCancelFacts, type SupportCancelReason,
} from "./support-cancel-model";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const conflict = (message: string) => new SecurityApiError(409, "CONFLICT", message);
const missing = () => new SecurityApiError(404, "NOT_FOUND", "Order not found");
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const SUPPORT_CANCEL_VERSION = "admin-support-cancel.v1";

type SupportFactsRow = {
  id: string; status: string; revision: string; paid_confirmation_id: string | null; renter_user_id: string; owner_user_id: string;
  cancel_reason: string | null; cancelled_at: string | null; confirmation_id: string | null; payment_source: string | null;
  disposition: string | null; currency: string | null; amount_cents: string | null; merchant_identity_id: string | null;
  merchant_order_no: string | null; channel_trx_no: string | null; order_cents: string | null;
  opening_confirmed: boolean; has_posting: boolean; pending_settlement: boolean; pending_adjustment: boolean;
  earning_count: string; active_refund_count: string; other_termination: boolean;
};
type SupportTerminationRow = {
  id: string; order_id: string; state: string; requested_by_party: string; requested_by_admin_user_id: string | null;
  reason: string; last_reason: string | null; approved_at: string | null; basis_digest: string; payment_basis: PrestartPaymentBasis;
  liability_root_id: string | null; liability_event_id: string | null;
};

/** 缺少 0121 的申请方列/完整性函数时明确不可用，不能当成“没有申请”。 */
export async function assertSupportCancelSchema(client: PoolClient) {
  const row = (await client.query(`SELECT to_regclass('zzsh_order.prestart_termination') IS NOT NULL
    AND to_regclass('zzsh_order.prestart_termination_decision') IS NOT NULL
    AND to_regprocedure('zzsh_order.prestart_liability_complete(text)') IS NOT NULL
    AND to_regprocedure('zzsh_order.native_prestart_refund_liability_complete(text)') IS NOT NULL
    AND to_regprocedure('zzsh_order.native_prestart_refund_terminal_complete(text)') IS NOT NULL
    AND to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.prestart_termination')
      AND attname='requested_by_admin_user_id' AND attnum>0 AND NOT attisdropped)
    AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('zzsh_order.prestart_termination')
      AND tgname IN('prestart_termination_guard','prestart_request_closure') AND NOT tgisinternal AND tgenabled='O')=2 AS ready`)).rows[0];
  if (row?.ready !== true) throw unavailable("Support cancellation schema is not deployed");
}

async function factsOf(client: PoolClient, orderId: string): Promise<SupportFactsRow> {
  const row = (await client.query<SupportFactsRow>(`SELECT o.id,o.status,o.revision::text,o.paid_confirmation_id,o.renter_user_id,o.owner_user_id,
    o.cancel_reason,${utc("o.cancelled_at")} AS cancelled_at,c.id AS confirmation_id,c.source AS payment_source,c.disposition,
    c.currency,c.amount_cents::text,c.merchant_scope_id AS merchant_identity_id,c.merchant_order_no,
    c.provider_transaction_id AS channel_trx_no,(o.rental_amount_cents+o.deposit_amount_cents)::text AS order_cents,
    EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND (x.status='CONFIRMED'
      OR (SELECT count(DISTINCT party) FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=x.id AND a.version_no=x.version_no)=2)) AS opening_confirmed,
    EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id) AS has_posting,
    EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.superseded_at IS NULL) AS pending_settlement,
    EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.kind='MANUAL_ADJUSTMENT' AND v.superseded_at IS NULL) AS pending_adjustment,
    (SELECT count(*) FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')::text AS earning_count,
    (SELECT count(*) FROM zzsh_order.channel_refund_intent i WHERE i.order_id=o.id
      AND i.budget_disposition<>'RELEASED')::text AS active_refund_count,
    EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=o.id AND t.state<>'REJECTED'
      AND t.requested_by_party<>'SUPPORT') AS other_termination
    FROM zzsh_order.rental_order o
    LEFT JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
    WHERE o.id=$1`, [orderId])).rows[0];
  if (!row) throw missing();
  if (![row.opening_confirmed,row.has_posting,row.pending_settlement,row.pending_adjustment,row.other_termination]
    .every(v => typeof v === "boolean") || typeof row.earning_count !== "string" || typeof row.active_refund_count !== "string")
    throw unavailable("Support cancellation facts are incomplete");
  return row;
}

function modelFacts(row: SupportFactsRow): SupportCancelFacts {
  return {
    orderState: row.status, paymentSource: row.payment_source, paymentDisposition: row.disposition, currency: row.currency,
    paidCents: row.amount_cents, orderCents: row.order_cents,
    paymentBound: row.confirmation_id !== null && row.confirmation_id === row.paid_confirmation_id,
    openingConfirmed: row.opening_confirmed, hasPosting: row.has_posting, pendingSettlement: row.pending_settlement,
    pendingAdjustment: row.pending_adjustment, monetaryEarningCount: row.earning_count,
    activeRefundCount: row.active_refund_count, otherTermination: row.other_termination,
  };
}

function paymentBasis(row: SupportFactsRow, allowControlled: boolean): PrestartPaymentBasis {
  if (!row.confirmation_id || !(row.payment_source === "JOINPAY" || allowControlled && row.payment_source === "CONTROLLED") || row.disposition !== "APPLIED" || row.currency !== "CNY"
    || !row.amount_cents || !row.merchant_identity_id || !row.merchant_order_no || !row.channel_trx_no)
    throw unavailable("Original applied payment is unavailable");
  const value = { orderId: row.id, renterUserId: row.renter_user_id, ownerUserId: row.owner_user_id,
    paymentConfirmationId: row.confirmation_id, source: row.payment_source as "JOINPAY" | "CONTROLLED",
    merchantIdentityId: row.merchant_identity_id, merchantOrderNo: row.merchant_order_no, channelTrxNo: row.channel_trx_no,
    amountCents: row.amount_cents, currency: "CNY" as const };
  return { ...value, digest: hashApprovalPayload({ schema: "prestart-payment-basis.v1", ...value }).hash };
}

async function demoForFacts(client:PoolClient,actor:ManualCloseActor,facts:SupportFactsRow,mode:'WRITE'|'READ_ORIGINAL') {
  if(facts.payment_source!=='CONTROLLED'||!actor.ecsTestDemo)return null;
  const registration=await assertEcsTestDemoResource(client,actor.ecsTestDemo,mode);
  await assertEcsTestDemoOrderAdmission(client,actor.ecsTestDemo,facts.id,mode);
  return {resource:actor.ecsTestDemo,active:registration.active};
}

async function latestSupportTermination(client: PoolClient, orderId: string, lock = false): Promise<SupportTerminationRow | null> {
  return (await client.query<SupportTerminationRow>(`SELECT id,order_id,state,requested_by_party,requested_by_admin_user_id,reason,last_reason,
    ${utc("approved_at")} AS approved_at,basis_digest,payment_basis,liability_root_id,liability_event_id
    FROM zzsh_order.prestart_termination WHERE order_id=$1 AND requested_by_party='SUPPORT'
    ORDER BY created_at DESC,id COLLATE "C" DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`, [orderId])).rows[0] ?? null;
}

function projectSupport(row: SupportTerminationRow) {
  return { terminationId: row.id, state: row.state, reason: row.reason, reviewReason: row.last_reason,
    approvedAt: row.approved_at, requestedByAdminUserId: row.requested_by_admin_user_id,
    refundCents: row.payment_basis?.amountCents ?? null, currency: "CNY" as const,
    liabilityRecognized: row.state === "APPROVED" && row.liability_root_id !== null && row.liability_event_id !== null };
}

function channelResultOf(progress: Awaited<ReturnType<typeof readPrestartRefundProgress>>): "NOT_SUBMITTED" | "UNKNOWN" | "SUCCEEDED" | "FAILED_NO_EXECUTION" {
  if (progress.integration !== "INTEGRATED" || !progress.intents?.length) return progress.integration === "INTEGRATED" ? "NOT_SUBMITTED" : "UNKNOWN";
  const states = progress.intents.map(intent => intent.state);
  if (states.every(state => state === "SUCCEEDED")) return "SUCCEEDED";
  if (states.every(state => state === "FAILED")) return "FAILED_NO_EXECUTION";
  if (states.some(state => ["SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED"].includes(state))) return "UNKNOWN";
  return states.some(state => state === "READY") ? "NOT_SUBMITTED" : "UNKNOWN";
}

async function existingResult(client: PoolClient, row: SupportTerminationRow, facts: SupportFactsRow, existing: boolean, demo:Awaited<ReturnType<typeof demoForFacts>>) {
  if (row.state !== "APPROVED" || !row.liability_root_id || !row.liability_event_id) throw unavailable("Support cancellation is inconsistent");
  if (facts.status !== "CANCELLED" || facts.cancel_reason !== "SUPPORT_CANCELLED_REFUND") throw unavailable("Support cancellation order state is inconsistent");
  await verifyPrestartRefundLiability(client, row.id, row.payment_basis, row.liability_root_id, row.liability_event_id);
  const refund = await readPrestartRefundProgress(client, row.id, row.payment_basis, true,undefined,demo?.resource);
  return { status: 200, body: {
    contractVersion: SUPPORT_CANCEL_VERSION, orderId: facts.id, orderRevision: facts.revision, existing,
    orderStatus: "CANCELLED", cancelReason: "SUPPORT_CANCELLED_REFUND", cancelledAt: facts.cancelled_at,
    supportCancellation: projectSupport(row), refund,
    eligibility: { allowed: false, reason: "ALREADY_CANCELLED" as SupportCancelReason,
      refundCents: row.payment_basis?.amountCents ?? null, openingConfirmed: facts.opening_confirmed },
    openingConfirmed: facts.opening_confirmed,
    channel: { result: existing && !demo ? channelResultOf(refund) : "NOT_SUBMITTED", bankArrival: "UNKNOWN" as const },
    ...(demo?{simulationScope:demoFinanceScope(demo.resource)}:{}),
  } };
}

/**
 * 客服取消：仅限未正式开租。复用 prestart 全额原款责任和正式退款意图链，
 * 但申请方固定为 SUPPORT，订单取消原因独立；本命令不提交渠道、不把本地责任写成到账。
 */
export async function supportCancelOrder(client: PoolClient, actor: ManualCloseActor, input: {
  orderId: string; expectedOrderRevision: string; reason: string; requestId: string;
}) {
  if (!ID.test(input.orderId) || !ID.test(input.requestId)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Invalid support cancellation reference");
  await lockSettlement(client, input.orderId, { ...actor, realm: "admin" }, "PRESTART_TERMINATION", true);
  await assertSupportCancelSchema(client);
  let facts = await factsOf(client, input.orderId);
  const demo=await demoForFacts(client,actor,facts,'WRITE');
  const current = await latestSupportTermination(client, input.orderId, true);
  if (current && current.state !== "REJECTED") return existingResult(client, current, facts, true,demo);
  if (facts.revision !== input.expectedOrderRevision) {
    const changed = supportCancelConflict(input.orderId, "ORDER_CHANGED"); changed.body.orderRevision = facts.revision; return changed;
  }
  const eligibility = supportCancelEligibility(modelFacts(facts),demo?.active===true);
  if (!eligibility.allowed) return supportCancelConflict(input.orderId, eligibility.reason!);
  const basis = paymentBasis(facts,demo?.active===true);
  const terminationId = `pterm_${randomUUID().replaceAll("-", "")}`;
  const inserted = await client.query(`INSERT INTO zzsh_order.prestart_termination
    (id,order_id,requested_by_user_id,requested_by_party,requested_by_admin_user_id,reason,basis_digest,payment_basis,request_id)
    VALUES($1,$2,NULL,'SUPPORT',$3,$4,$5,$6::jsonb,$7) RETURNING id`,
    [terminationId, input.orderId, actor.userId, input.reason, basis.digest, JSON.stringify(basis), input.requestId]);
  if (inserted.rowCount !== 1) throw conflict("Support cancellation changed");
  const approved = await client.query(`UPDATE zzsh_order.prestart_termination SET state='APPROVED',revision=2,last_reason=$2,
    updated_at=clock_timestamp() WHERE id=$1 AND state='REQUESTED' AND revision=1 RETURNING id`,
    [terminationId, input.reason]);
  if (approved.rowCount !== 1) throw conflict("Support cancellation changed");
  await client.query(`INSERT INTO zzsh_order.prestart_termination_decision
    (id,termination_id,result_revision,decision,assessment,reason,admin_user_id,session_id,request_id)
    VALUES($1,$2,2,'APPROVE','SUPPORT_FULL_REFUND',$3,$4,$5,$6)`,
    [`pterm_decision_${randomUUID().replaceAll("-", "")}`, terminationId, input.reason, actor.userId, actor.sessionId, input.requestId]);
  const liability = await recognizePrestartRefundLiability(client, terminationId, basis, input.requestId, "support-full-refund.v1");
  await client.query(`UPDATE zzsh_order.prestart_termination SET liability_root_id=$2,liability_event_id=$3 WHERE id=$1`,
    [terminationId, liability.rootId, liability.eventId]);
  const cancelled = (await client.query<{ cancelledAt: string; revision: string }>(`UPDATE zzsh_order.rental_order
    SET status='CANCELLED',cancel_reason='SUPPORT_CANCELLED_REFUND',cancelled_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
    WHERE id=$1 AND status='PAID' AND paid_confirmation_id=$2 AND revision=$3
    RETURNING ${utc("cancelled_at")} AS "cancelledAt",revision::text AS revision`,
    [input.orderId, basis.paymentConfirmationId, facts.revision])).rows[0];
  if (!cancelled) throw conflict("Original paid order changed");
  await verifyPrestartRefundLiability(client, terminationId, basis, liability.rootId, liability.eventId);
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId,
    action: "order.support_cancel", objectType: "prestart_termination", objectId: terminationId, outcome: "SUCCESS",
    requestId: input.requestId, details: { orderId: input.orderId, decision: "APPROVE", basisDigest: basis.digest,
      liabilityRootId: liability.rootId, refundCents: basis.amountCents, currency: "CNY", reason: input.reason,
      cancelReason: "SUPPORT_CANCELLED_REFUND", requestedByParty: "SUPPORT", channelResult: "NOT_SUBMITTED", bankArrival: "UNKNOWN" } });
  const row = (await client.query<SupportTerminationRow>(`SELECT id,order_id,state,requested_by_party,requested_by_admin_user_id,reason,last_reason,
    ${utc("approved_at")} AS approved_at,basis_digest,payment_basis,liability_root_id,liability_event_id
    FROM zzsh_order.prestart_termination WHERE id=$1`, [terminationId])).rows[0]!;
  facts = { ...facts, status: "CANCELLED", cancel_reason: "SUPPORT_CANCELLED_REFUND", revision: cancelled.revision,
    cancelled_at: cancelled.cancelledAt };
  const refund = await readPrestartRefundProgress(client, terminationId, basis, true,undefined,demo?.resource);
  return { status: 200, body: {
    contractVersion: SUPPORT_CANCEL_VERSION, orderId: input.orderId, orderRevision: cancelled.revision, existing: false,
    orderStatus: "CANCELLED", cancelReason: "SUPPORT_CANCELLED_REFUND", cancelledAt: cancelled.cancelledAt,
    supportCancellation: projectSupport(row), refund,
    eligibility: { allowed: false, reason: "ALREADY_CANCELLED" as SupportCancelReason,
      refundCents: basis.amountCents, openingConfirmed: facts.opening_confirmed },
    openingConfirmed: facts.opening_confirmed,
    channel: { result: "NOT_SUBMITTED" as const, bankArrival: "UNKNOWN" as const },
    ...(demo?{simulationScope:demoFinanceScope(demo.resource)}:{}),
  } };
}

/** 客服可在开租后按原款分配；结算草稿不要求人工预先关闭。 */
export async function supportCancelAfterOpening(client:PoolClient,actor:ManualCloseActor,input:{
 orderId:string;expectedOrderRevision:string;reason:string;refundCents:string;ownerCents:string;requestId:string;
}) {
 if(!ID.test(input.orderId)||!ID.test(input.requestId))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid support cancellation reference");
 await lockSettlement(client,input.orderId,{...actor,realm:"admin"},"PRESTART_TERMINATION",true);
 await assertSupportCancelSchema(client);
 const facts=await factsOf(client,input.orderId),demo=await demoForFacts(client,actor,facts,'WRITE');
 if(facts.revision!==input.expectedOrderRevision)return supportCancelConflict(input.orderId,"ORDER_CHANGED");
 const eligibility=supportPoststartCancellationEligibility(modelFacts(facts),demo?.active===true);
 if(!eligibility.allowed)return supportCancelConflict(input.orderId,eligibility.reason!);
 const amount=supportPoststartCancellationAllocation({paidCents:facts.amount_cents,previouslyAllocatedCents:'0',
  refundCents:input.refundCents,ownerCents:input.ownerCents});
 const ready=(await client.query(`SELECT to_regprocedure('zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text)') IS NOT NULL
  AND has_function_privilege(current_user,to_regprocedure('zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text)'),'EXECUTE') AS ready`)).rows[0]?.ready;
 if(ready!==true)throw unavailable("Poststart cancellation schema is not deployed");
 const value=(await client.query<{value:any}>(`SELECT zzsh_order.cancel_order_after_start($1,$2::bigint,$3::numeric,$4::numeric,$5) AS value`,
  [input.orderId,input.expectedOrderRevision,amount.refundCents,amount.ownerCents,input.reason])).rows[0]?.value;
 if(!value||value.orderId!==input.orderId||value.status!=='CANCELLED'||value.paidCents!==amount.paidCents
  ||value.refundCents!==amount.refundCents||value.ownerCents!==amount.ownerCents
  ||value.platformContributionCents!==amount.platformContributionCents||value.commissionCents!=='0'||value.channelResult!=='NOT_SUBMITTED')
  throw unavailable("Poststart cancellation receipt differs");
 const recorded=(await client.query<{revision:string;cancelled_at:string|null}>(`SELECT revision::text,${utc('cancelled_at')} AS cancelled_at
  FROM zzsh_order.rental_order WHERE id=$1 AND status='CANCELLED' AND cancel_reason='SUPPORT_AFTER_START_CANCELLED'`,[input.orderId])).rows[0];
 if(!recorded||recorded.revision!==(BigInt(facts.revision)+1n).toString()||!recorded.cancelled_at)
  throw unavailable("Poststart cancellation order receipt is unavailable");
 return {status:200,body:{contractVersion:SUPPORT_CANCEL_VERSION,orderId:input.orderId,
  orderRevision:recorded.revision,orderStatus:'CANCELLED',cancelReason:'SUPPORT_AFTER_START_CANCELLED',cancelledAt:recorded.cancelled_at,
  eligibility:{allowed:false,reason:'ALREADY_CANCELLED',refundCents:amount.refundCents,openingConfirmed:true},
  openingConfirmed:true,supportCancellation:null,refund:null,existing:false,channel:{result:'NOT_SUBMITTED',bankArrival:'UNKNOWN'},
  poststartCancellation:{caseId:value.caseId,refundCents:amount.refundCents,ownerCents:amount.ownerCents,
   platformContributionCents:amount.platformContributionCents,commissionCents:'0',reason:input.reason},
  ...(demo?{simulationScope:demoFinanceScope(demo.resource)}:{})}};
}

/** 只读预检：金额/资格/已有客服取消与退款进度；不领取、不出网、不补写责任。 */
export async function readSupportCancellation(client: PoolClient, actor: ManualCloseActor, orderId: string) {
  if (!ID.test(orderId)) throw missing();
  await assertSupportOrderAccess(client, orderId, actor);
  await assertSupportCancelSchema(client);
  const facts = await factsOf(client, orderId);
  const demo=await demoForFacts(client,actor,facts,'READ_ORIGINAL');
  const poststartEligibility=supportPoststartCancellationEligibility(modelFacts(facts),demo?.active===true);
  if(facts.status==='CANCELLED'&&facts.cancel_reason==='SUPPORT_AFTER_START_CANCELLED'){
    const terminalFn=facts.payment_source==='CONTROLLED'?'local_controlled_refund_terminal_complete':'support_cancellation_refund_terminal_complete';
    const liabilityFn=facts.payment_source==='CONTROLLED'?'local_controlled_refund_liability_complete':'support_cancellation_refund_liability_complete';
    const row=(await client.query(`SELECT p.id,p.reason,p.refund_cents::text,p.owner_cents::text,p.platform_cents::text,
      zzsh_order.support_poststart_cancellation_complete(p.id) AS complete,
      (SELECT CASE WHEN i.payment_source=$2 AND CASE WHEN i.state IN('SUCCEEDED','FAILED') THEN zzsh_order.${terminalFn}(i.id)
          ELSE zzsh_order.${liabilityFn}(i.id) END IS TRUE THEN i.state ELSE 'UNKNOWN' END
       FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=p.payment_confirmation_id
       AND i.basis_kind='SUPPORT_CANCELLATION' ORDER BY i.created_at DESC,i.id DESC LIMIT 1) AS refund_state
      FROM zzsh_order.support_poststart_cancellation p WHERE p.order_id=$1`,[orderId,facts.payment_source])).rows[0];
    if(!row||row.complete!==true)throw unavailable("Poststart cancellation record is unavailable");
    return {contractVersion:SUPPORT_CANCEL_VERSION,orderId,orderRevision:facts.revision,orderStatus:facts.status,cancelReason:facts.cancel_reason,
      cancelledAt:facts.cancelled_at,eligibility:{allowed:false,reason:'ALREADY_CANCELLED',refundCents:row.refund_cents,openingConfirmed:true},
      poststartEligibility,openingConfirmed:true,supportCancellation:null,refund:null,existing:true,
      poststartCancellation:{caseId:row.id,reason:row.reason,refundCents:row.refund_cents,ownerCents:row.owner_cents,
        platformContributionCents:row.platform_cents,commissionCents:'0',refundState:row.refund_state??'NOT_SUBMITTED'},
      channel:{result:row.refund_state??'NOT_SUBMITTED',bankArrival:'UNKNOWN'},...(demo?{simulationScope:demoFinanceScope(demo.resource)}:{})};
  }
  const current = await latestSupportTermination(client, orderId);
  if (current) {
    if (current.state !== "REJECTED") {
      const result = await existingResult(client, current, facts, true,demo);
      return { ...result.body,poststartEligibility, eligibility: { allowed: false, reason: "ALREADY_CANCELLED" as SupportCancelReason,
        refundCents: current.payment_basis?.amountCents ?? null, openingConfirmed: facts.opening_confirmed } };
    }
    if (current.state === "REJECTED") {
      const eligibility = supportCancelEligibility(modelFacts(facts),demo?.active===true);
      return { contractVersion: SUPPORT_CANCEL_VERSION, orderId, orderRevision: facts.revision, orderStatus: facts.status,
        cancelReason: facts.cancel_reason, cancelledAt: facts.cancelled_at, eligibility: { ...eligibility, refundCents: facts.amount_cents },poststartEligibility,
        openingConfirmed: facts.opening_confirmed, supportCancellation: null, refund: null, existing: false, channel: null,
        ...(demo?{simulationScope:demoFinanceScope(demo.resource)}:{}) };
    }
  }
  const eligibility = supportCancelEligibility(modelFacts(facts),demo?.active===true);
  return { contractVersion: SUPPORT_CANCEL_VERSION, orderId, orderRevision: facts.revision, orderStatus: facts.status,
    cancelReason: facts.cancel_reason, cancelledAt: facts.cancelled_at,
    eligibility: { ...eligibility, refundCents: facts.amount_cents },poststartEligibility,
    openingConfirmed: facts.opening_confirmed, supportCancellation: null, refund: null, existing: false, channel: null,
    ...(demo?{simulationScope:demoFinanceScope(demo.resource)}:{}) };
}

export type { SupportCancelFacts, SupportCancelReason } from "./support-cancel-model";
