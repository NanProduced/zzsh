import type { Pool, PoolClient } from "pg";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { assertAdminContextInTransaction } from '../auth/auth-security';
import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { assertGameScopeUsable, readAdminGameScope, scopeAllowsGame } from "../auth/admin-scope";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, forbidden, invalid, notFound } from "../supply/supply-util";
import { createFormalRefundIntent, createNativeRefundIntent, createSandboxPrestartRefundIntent, type FormalRefundCreateInput } from "./channel-refund-store";
import { createAbnormalFormalRefundIntent } from "./joinpay-abnormal-refund-store";
import { createPrestartFormalRefundIntent } from "./prestart-refund-store";
import { describeRefundProfile, type BoundRefundProfile, type FormalRefundAdmission } from "./joinpay-refund-profile";
import type {LocalSandboxRefundOptions} from './local-sandbox-refund-source';
import {sandboxForChannelRequestCapability} from './channel-payment-store';
import {assertLocalFinancialSandboxResource,localFinancialSandboxRegistration} from '../finance/local-financial-sandbox-resource';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CENTS = /^[1-9][0-9]{0,15}$/;
export type AdminNativeRefundActor = Readonly<{ userId: string; sessionId: string }>;
export type AdminNativeRefundExecution = Readonly<{ admission?: FormalRefundAdmission; initialProfile?: BoundRefundProfile; localSandbox?:LocalSandboxRefundOptions }>;
export type AdminNativeRefundInput = Readonly<{
  actor: AdminNativeRefundActor; orderId: string; amountCents: string; reason?: string; postingId?: string;
  idempotencyKey: unknown; requestId: string;
}>;
type Posting = { id: string; renter_user_id: string; due_at: string; frozen_cents: string; due: boolean };
export class AdminRefundCommitUnknown extends SecurityApiError {
  constructor(readonly originalKey: string) { super(503, "EVIDENCE_UNAVAILABLE", "Refund result is unknown; recover only the original idempotency key"); }
}

/** 复用Admin权限与游戏对象范围；order.settlement.write是命令权限，finance.read只读不能发起退款。 */
export async function authorizeAdminNativeRefund(client: PoolClient, actor: AdminNativeRefundActor, orderId: string,readOnly=false): Promise<void> {
  if(readOnly)await assertAdminContextInTransaction(client,actor);
  else await assertAdminCommandAuthorizedInTransaction(client, { userId: actor.userId, sessionId: actor.sessionId });
  const access = await loadEffectiveAdminAccess(client, actor.userId);
  if (access?.status !== "ACTIVE" || !access.permissions.has(ADMIN_PERMISSION.orderSettlementWrite)) throw forbidden();
  const order = (await client.query<{ game_id: string }>(`SELECT game_id FROM zzsh_order.rental_order WHERE id=$1`, [orderId])).rows[0];
  if (!order) throw notFound();
  if (!access.isBoss) {
    const scope = await readAdminGameScope(client, actor.userId);
    assertGameScopeUsable(scope, false);
    if (!scopeAllowsGame(scope, false, order.game_id)) throw forbidden();
  }
  // IM group availability does not block an authorized operator from handling this order.
}

function localExecution(execution:AdminNativeRefundExecution){
  const local=execution.localSandbox;
  const sandbox=local?sandboxForChannelRequestCapability(local.capability):undefined;
  if(local&&(!sandbox||execution.admission||execution.initialProfile||sandbox!==local.sandbox))throw invalid('Local and formal refund assemblies are exclusive');
  return local;
}
async function selectPosting(client: PoolClient, orderId: string, postingId: string | undefined,source:'JOINPAY'|'CONTROLLED'='JOINPAY'): Promise<Posting> {
  const rows = (await client.query<Posting>(`SELECT p.id,o.renter_user_id,to_char(p.refund_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at,
      p.renter_refund_cents::text AS frozen_cents,p.refund_due_at<=clock_timestamp() AS due
    FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.rental_order o ON o.id=p.order_id
    JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=o.id
    WHERE p.order_id=$1 AND c.source='${source}' AND c.disposition='APPLIED' AND c.currency='CNY'
      AND p.currency='CNY' AND p.captured_cents=c.amount_cents${postingId ? " AND p.id=$2" : ""}
    ORDER BY p.posted_at DESC,p.id DESC LIMIT 2`, postingId ? [orderId, postingId] : [orderId])).rows;
  if (!rows.length) throw notFound();
  // 同一订单只允许一个当前过账责任；歧义必须显式指定，不能由系统任选一笔退。
  if (rows.length > 1) throw conflict("Multiple settlement postings require an explicit postingId");
  return rows[0]!;
}

/** 仅按已冻结过账责任创建正式退款意图；渠道提交由既有恢复worker按原号执行。 */
export async function requestAdminNativeRefund(pool: Pool, execution: AdminNativeRefundExecution, input: AdminNativeRefundInput) {
  const local=localExecution(execution);
  const key = validateIdempotencyKey(input.idempotencyKey);
  if (!ID.test(input.orderId) || !ID.test(input.requestId) || !CENTS.test(input.amountCents)
    || input.postingId !== undefined && !ID.test(input.postingId)
    || input.reason !== undefined && (typeof input.reason !== "string" || Buffer.byteLength(input.reason, "utf8") > 400 || input.reason.trim().length < 1)) throw invalid();
  let completed = false;
  try { return await withTransaction(pool, async client => {
    await authorizeAdminNativeRefund(client, input.actor, input.orderId);
    // 新准入交给已有store在原键重放之后检查，关闭新退款不能阻断旧键恢复。
    const profile = execution.initialProfile, snapshot = profile ? describeRefundProfile(profile, "SUBMIT") : undefined;
    const posting = await selectPosting(client, input.orderId, input.postingId,local?'CONTROLLED':'JOINPAY');
    if (!posting.due) throw conflict("Refund responsibility is not due");
    if (BigInt(input.amountCents) > BigInt(posting.frozen_cents)) throw conflict("Refund exceeds frozen responsibility");
    const create: FormalRefundCreateInput = { postingId: posting.id, renterUserId: posting.renter_user_id,
      amountCents: input.amountCents, idempotencyKey: key, requestId: input.requestId,
      admission: execution.admission, profile, notifyUrl: snapshot?.notifyUrl,
      ...(input.reason === undefined ? {} : { reason: input.reason.trim() }) };
    const receipt = local ? await createNativeRefundIntent(client,{postingId:posting.id,amountCents:input.amountCents,idempotencyKey:key,requestId:input.requestId,capability:local.capability})
      .then(r=>({replayed:r.replayed,intentId:r.intent.intentId,refundOrderNo:r.intent.refundOrderNo,state:r.intent.state,budgetDisposition:r.intent.budgetDisposition}))
      :await createFormalRefundIntent(client, create);
    // Old same-key requests remain recoverable; a new manual request must record why.
    if (!receipt.replayed && (!input.reason || input.reason.trim().length < 3)) throw invalid("Refund reason is required");
    if (!receipt.replayed) await recordAudit(client, { actorType: "admin", actorId: input.actor.userId, sessionId: input.actor.sessionId,
      action: local?'order.refund.local.requested':"order.refund.native.requested", objectType: "channel_refund_intent", objectId: receipt.intentId, outcome: "SUCCESS",
      requestId: input.requestId, details: { postingId: posting.id, amountCents: input.amountCents, currency: "CNY",
        reasonProvided: input.reason !== undefined, supportReason: input.reason?.trim() ?? null, channelResult: "NOT_SUBMITTED" } });
    const result = { contractVersion: "admin-native-refund.v1" as const, replayed: receipt.replayed,
      intentId: receipt.intentId, refundOrderNo: receipt.refundOrderNo, amountCents: input.amountCents, currency: "CNY" as const,
      state: receipt.state, budgetDisposition: receipt.budgetDisposition,
      responsibility: { postingId: posting.id, frozenCents: posting.frozen_cents, dueAt: posting.due_at },
      channel: { result: receipt.replayed ? "UNKNOWN" as const : "NOT_SUBMITTED" as const, bankArrival: "UNKNOWN" as const },...(local?{dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false}:{}) };
    completed = true;
    return result;
  }); } catch (error) { if (completed) throw new AdminRefundCommitUnknown(key); throw error; }
}

export type AdminAbnormalNativeRefundInput = Readonly<{
  actor: AdminNativeRefundActor; orderId: string; confirmationId: string; idempotencyKey: unknown; requestId: string;reason?:string;
}>;
/** 已核实重复/迟到REVIEW原款的人工核准；只建原责任/意图，不出网、不生成渠道成功。 */
export async function requestAdminAbnormalNativeRefund(pool: Pool, execution: AdminNativeRefundExecution, input: AdminAbnormalNativeRefundInput) {
  if(localExecution(execution))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Local sandbox does not admit abnormal formal refunds');
  if (!ID.test(input.orderId) || !ID.test(input.confirmationId) || !ID.test(input.requestId)) throw invalid();
  if(input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.trim().length<3||Buffer.byteLength(input.reason)>600))throw invalid();
  const key = validateIdempotencyKey(input.idempotencyKey);
  let completed = false;
  try { return await withTransaction(pool, async client => {
    await authorizeAdminNativeRefund(client, input.actor, input.orderId);
    const result = await createAbnormalFormalRefundIntent(client, { orderId: input.orderId, confirmationId: input.confirmationId,
      idempotencyKey: key, requestId: input.requestId,
      ...(execution?.admission === undefined ? {} : { admission: execution.admission }),
      ...(execution?.initialProfile === undefined ? {} : { profile: execution.initialProfile }) });
    if (result.kind === "REVIEW_REQUIRED") {
      await recordAudit(client, { actorType: "admin", actorId: input.actor.userId, sessionId: input.actor.sessionId,
        action: "order.refund.abnormal.review_required", objectType: "payment_confirmation", objectId: input.confirmationId,
        outcome: "SUCCESS", requestId: input.requestId, reason: result.reason,
        details: { confirmationId: input.confirmationId, orderId: input.orderId, channelResult: "NOT_SUBMITTED",reviewReason:input.reason?.trim()??null } });
      completed = true;
      return { contractVersion: "admin-abnormal-native-refund.v1" as const, replayed: false, outcome: "REVIEW_REQUIRED" as const,
        reason: result.reason, confirmationId: input.confirmationId, intentId: null, state: "REVIEW_REQUIRED" as const,
        amountCents: null, currency: null, responsibility: null, channel: { result: "NOT_SUBMITTED" as const, bankArrival: "UNKNOWN" as const } };
    }
    if (result.kind !== "REPLAYED") await recordAudit(client, { actorType: "admin", actorId: input.actor.userId, sessionId: input.actor.sessionId,
      action: "order.refund.abnormal.requested", objectType: "channel_refund_intent", objectId: result.intentId, outcome: "SUCCESS",
      requestId: input.requestId, details: { confirmationId: result.confirmationId, evidenceId: result.evidenceId, anchorId: result.anchorId,
        amountCents: result.amountCents, currency: "CNY", reasonCode: result.reasonCode, channelResult: "NOT_SUBMITTED", reviewDecision: "APPROVED",reviewReason:input.reason?.trim()??null } });
    completed = true;
    return { contractVersion: "admin-abnormal-native-refund.v1" as const, replayed: result.kind === "REPLAYED", outcome: result.kind,
      intentId: result.intentId, refundOrderNo: result.refundOrderNo, state: result.state, budgetDisposition: result.budgetDisposition,
      amountCents: result.amountCents, currency: "CNY" as const,
      responsibility: { confirmationId: result.confirmationId, evidenceId: result.evidenceId, anchorId: result.anchorId,
        reasonCode: result.reasonCode, liabilityRootId: result.liabilityRootId, liabilityEventId: result.liabilityEventId },
      channel: { result: result.kind === "REPLAYED" ? "UNKNOWN" as const : "NOT_SUBMITTED" as const, bankArrival: "UNKNOWN" as const } };
  }); } catch (error) { if (completed) throw new AdminRefundCommitUnknown(key); throw error; }
}

type RefundRow = { id: string; posting_id: string | null; refund_order_no: string; amount_cents: string; state: string;
  budget_disposition: string; requires_review: boolean; provider_refund_trx_no: string | null; completed_at: string | null;
  frozen_cents: string | null; allocated_cents: string; latest_event: string | null; latest_evidence_level: string | null; latest_observed_at: string | null };

/** 本地意图与渠道观察分列；未取得终态时不得读成已退款或已到账。 */
/** 未开租核准后的全额原款分配/失败释放重提；授权和原键恢复先于新渠道资格。 */
export async function requestAdminPrestartNativeRefund(pool:Pool,execution:AdminNativeRefundExecution,input:{actor:AdminNativeRefundActor;orderId:string;terminationId:string;idempotencyKey:unknown;requestId:string}){
 const local=localExecution(execution);
 if(!ID.test(input.orderId)||!ID.test(input.terminationId)||!ID.test(input.requestId))throw invalid();
 const key=validateIdempotencyKey(input.idempotencyKey);let completed=false;
 try{return await withTransaction(pool,async c=>{
  await authorizeAdminNativeRefund(c,input.actor,input.orderId);
  const original=(await c.query(`SELECT id FROM zzsh_order.prestart_termination WHERE id=$1 AND order_id=$2 AND state='APPROVED'`,[input.terminationId,input.orderId])).rows;
  if(original.length!==1)throw notFound();
  const result=local?await createSandboxPrestartRefundIntent(c,{terminationId:input.terminationId,idempotencyKey:key,requestId:input.requestId,capability:local.capability})
    :await createPrestartFormalRefundIntent(c,{terminationId:input.terminationId,idempotencyKey:key,requestId:input.requestId,admission:execution.admission,profile:execution.initialProfile});
  await recordAudit(c,{actorType:'admin',actorId:input.actor.userId,sessionId:input.actor.sessionId,
   action:'order.refund.prestart.requested',objectType:'prestart_termination',objectId:input.terminationId,outcome:'SUCCESS',requestId:input.requestId,
   details:{orderId:input.orderId,outcome:result.kind,channelResult:'NOT_SUBMITTED',...('intentId' in result?{intentId:result.intentId}:{reason:result.reason})}});
  const receipt={contractVersion:'admin-prestart-native-refund.v1' as const,orderId:input.orderId,terminationId:input.terminationId,outcome:result.kind,
   replayed:result.kind==='REPLAYED',...result,channel:{result:result.kind==='REPLAYED'?'UNKNOWN':'NOT_SUBMITTED',bankArrival:'UNKNOWN' as const},...(local?{dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false}:{})};
  completed=true;return receipt;
 });}catch(error){if(completed)throw new AdminRefundCommitUnknown(key);throw error;}
}

export async function readAdminNativeRefunds(pool: Pool, input: { actor: AdminNativeRefundActor; orderId: string; execution?:AdminNativeRefundExecution }) {
  if (!ID.test(input.orderId)) throw invalid();
  const local=input.execution?localExecution(input.execution):undefined,source=local?'CONTROLLED':'JOINPAY';
  return withTransaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await authorizeAdminNativeRefund(client, input.actor, input.orderId,true);
    if(local)await assertLocalFinancialSandboxResource(client,local.sandbox,'READ_ORIGINAL');
    const rows = (await client.query<RefundRow>(`SELECT i.id,i.posting_id,i.refund_order_no,i.amount_cents::text,i.state,i.budget_disposition,
        i.requires_review,i.provider_refund_trx_no,i.completed_at::text,
        (SELECT p.renter_refund_cents::text FROM zzsh_order.settlement_posting p WHERE p.id=i.posting_id) AS frozen_cents,
        (SELECT COALESCE(sum(x.amount_cents),0)::text FROM zzsh_order.channel_refund_intent x WHERE x.posting_id=i.posting_id
          AND x.payment_source='${source}' AND x.budget_disposition<>'RELEASED') AS allocated_cents,
        o.event AS latest_event,o.evidence_level AS latest_evidence_level,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS latest_observed_at
      FROM zzsh_order.channel_refund_intent i
      LEFT JOIN LATERAL (SELECT x.event,${local?"'CONTROLLED_TEST' AS evidence_level":'x.evidence_level'},x.created_at FROM zzsh_order.${local?'channel_refund_observation':'joinpay_refund_observation'} x
        WHERE x.intent_id=i.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) o ON true
      WHERE i.order_id=$1 AND i.payment_source='${source}'${local?' AND i.sandbox_registration_ref=$2':''}
      ORDER BY i.created_at DESC,i.id DESC LIMIT 100`, [input.orderId,...(local?[localFinancialSandboxRegistration(local.sandbox).registration.reference]:[])])).rows;
    return { contractVersion: "admin-native-refunds.v1" as const, orderId: input.orderId,...(local?{dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false}:{}),
      items: rows.map(row => {
        const frozen = row.frozen_cents === null || !/^(0|[1-9][0-9]*)$/.test(row.frozen_cents) ? null : row.frozen_cents;
        const allocated = row.posting_id !== null && /^(0|[1-9][0-9]*)$/.test(row.allocated_cents) ? row.allocated_cents : null;
        const remaining = frozen !== null && allocated !== null ? (BigInt(frozen) > BigInt(allocated) ? (BigInt(frozen) - BigInt(allocated)).toString() : "0") : null;
        return { intentId: row.id, postingId: row.posting_id, refundOrderNo: row.refund_order_no,
          amountCents: row.amount_cents, currency: "CNY" as const, state: row.state, budgetDisposition: row.budget_disposition,
          requiresReview: row.requires_review, providerRefundTrxNo: row.provider_refund_trx_no, completedAt: row.completed_at,
          postingResponsibility: { frozenCents: frozen, allocatedCents: allocated, remainingCents: remaining },
          latestObservation: row.latest_event === null ? null : { event: row.latest_event, evidenceLevel: row.latest_evidence_level,
            observedAt: row.latest_observed_at }, channelArrival: "UNKNOWN" as const };
      }) };
  });
}
