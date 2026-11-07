import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { PayoutCommitUnknown, queryJoinpayPayout, type PayoutExecution } from "../finance/joinpay-payout-attempt";
import { readPayoutScope } from "../finance/joinpay-payout-profile";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requireOrigin, requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { authorizeAdminNativeRefund, type AdminNativeRefundActor } from "./native-refund-command";
import { queryJoinpayRefund, resolveNativeRefundTerminal, resumeNativeRefundReview, RefundAttemptCommitUnknown, type RefundExecution } from "./joinpay-refund-attempt";
import {executeLegacyRefund,resolveLegacyRefundTerminal,resumeLegacyRefundReview,retryLegacyRefund} from './legacy-refund-attempt';
import {authorizeLegacyRefundReviewAccess} from './legacy-refund-review-store';
import { CollectionAttemptCommitUnknown, executeJoinpayCollectionAttempt, type JoinpayCollectionExecution } from "./joinpay-collection-attempt";

const PREFIXES = ["/api/v1/admin/joinpay", "/api/bff/admin/joinpay"] as const;
const PATH = /^\/(refunds|legacy-refunds|withdrawals|collection-requests)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(query-only|submit|resume|retry|resolve)$/;
const INTERVAL = 30;
export type AdminJoinpayQueryOptions = Readonly<{
  refund?: Omit<RefundExecution, "pool"> & {legacyRefundsEnabled?:boolean};
  collection?: Omit<JoinpayCollectionExecution, "pool">;
  /** 仅queryJoinpayPayout；绝不交executeJoinpayPayout/AUTO。 */
  payout?: Omit<PayoutExecution, "pool">;
  workerStatus?: () => Readonly<Partial<Record<"refund" | "legacyRefund" | "payout" | "collection", WorkerRaw>>>;
}>;
type WorkerRaw = { stopped: boolean; failure: { code: string; phase?: string } | null };
/** 白名单投影：去掉intentId/postingId/idempotencyKey等对象标识，只留运行态与稳定错误码。 */
export function projectWorkerStatus(raw: Readonly<Partial<Record<"refund" | "legacyRefund" | "payout" | "collection", WorkerRaw>>> | undefined) {
  const one = (w: WorkerRaw | undefined) => !w ? { configured: false, running: false, failureCode: null, failurePhase: null, lastSuccessfulQueryAt: null }
    : { configured: true, running: !w.stopped, failureCode: typeof w.failure?.code === "string" && /^[A-Z_]{1,64}$/.test(w.failure.code) ? w.failure.code : w.failure ? "UNKNOWN" : null,
      failurePhase: w.failure?.phase === "CLAIM" || w.failure?.phase === "RESULT" || w.failure?.phase === "ALLOCATION" ? w.failure.phase : null, lastSuccessfulQueryAt: null };
  return { contractVersion: "admin-joinpay-worker-status.v1" as const, refund: one(raw?.refund), legacyRefund:one(raw?.legacyRefund), payout: one(raw?.payout), collection: one(raw?.collection), channelArrival: "UNKNOWN" as const };
}
type Operation = "REFUND_QUERY" | "REFUND_RESUME" | "REFUND_RESOLVE" | "LEGACY_REFUND_QUERY" | "LEGACY_REFUND_SUBMIT" | "LEGACY_REFUND_RESUME" | "LEGACY_REFUND_RETRY" | "LEGACY_REFUND_RESOLVE" | "PAYOUT_QUERY" | "COLLECTION_QUERY";
const dto = (operation: Operation, objectId: string, outcome: Record<string, unknown>, localFundsEffect: string, requestId: string) =>
  ({ contractVersion: "admin-joinpay-query.v1" as const, operation, objectId, outcome, channelArrival: "UNKNOWN" as const, localFundsEffect, requestId });

/** 与领取共用事务；系统attempt由executionOwner关联到实际管理员，不把查询许可记成资金成功。 */
async function recordAdminQuery(client: PoolClient, actor: AdminNativeRefundActor, operation: Operation, objectId: string, executionOwner: string, requestId: string) {
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId,
    action: operation==='LEGACY_REFUND_SUBMIT'?'joinpay.admin.refund.submit.authorized':operation==='LEGACY_REFUND_RESUME'||operation==='REFUND_RESUME'?'joinpay.admin.refund.resume.authorized':operation==='LEGACY_REFUND_RETRY'?'joinpay.admin.refund.retry.authorized':operation==='LEGACY_REFUND_RESOLVE'||operation==='REFUND_RESOLVE'?'joinpay.admin.refund.resolve.authorized':"joinpay.admin.query.authorized", objectType: ['REFUND_QUERY','REFUND_RESUME','REFUND_RESOLVE'].includes(operation) ? "channel_refund_intent" : ['LEGACY_REFUND_QUERY','LEGACY_REFUND_SUBMIT','LEGACY_REFUND_RESUME','LEGACY_REFUND_RETRY','LEGACY_REFUND_RESOLVE'].includes(operation) ? "legacy_refund_intent" : operation === "PAYOUT_QUERY" ? "joinpay_withdrawal_intent" : "payment_request",
    objectId, outcome: "SUCCESS", requestId, details: { operation, executionOwner,
      ...(['LEGACY_REFUND_SUBMIT','LEGACY_REFUND_RETRY'].includes(operation)?{firstDispatchRequested:true}:{firstDispatchAllowed:false}),channelResult: "NOT_QUERIED" } });
}

/** 同claim事务内、锁资金前授权；复用订单命令权限order.settlement.write与游戏范围，finance.read不足。 */
async function authorizeByOrder(client: PoolClient, actor: AdminNativeRefundActor, sql: string, id: string): Promise<void> {
  const row = (await client.query<{ order_id: string | null }>(sql, [id])).rows[0];
  if (!row) throw notFound();
  if (!row.order_id) throw forbidden();
  await authorizeAdminNativeRefund(client, actor, row.order_id);
}
const REFUND_ORDER = `SELECT order_id FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='JOINPAY'`;
const COLLECTION_ORDER = `SELECT order_id FROM zzsh_order.payment_request WHERE id=$1`;

/**
 * 提现QUERY-only授权：同claim事务内、锁资金前复核命令会话(ACTIVE/当前session)+finance.withdrawal.query。
 * 对象范围：现有机制没有按用户/商户的财务ACL，首期只放行平台财务范围(Boss全字典或finance.read)；
 * 原intent的商户身份必须等于已装配QUERY scope，否则拒绝。不用order.settlement.write，不假扮用户。
 */
export async function authorizeAdminWithdrawalQuery(client: PoolClient, actor: AdminNativeRefundActor, intentId: string, merchantIdentityId: string): Promise<void> {
  await assertAdminCommandAuthorizedInTransaction(client, { userId: actor.userId, sessionId: actor.sessionId });
  const access = await loadEffectiveAdminAccess(client, actor.userId);
  if (access?.status !== "ACTIVE" || !access.permissions.has(ADMIN_PERMISSION.financeWithdrawalQuery)) throw forbidden();
  if (!access.isBoss && !access.permissions.has(ADMIN_PERMISSION.financeRead)) throw forbidden();
  const row = (await client.query<{ merchant_identity_id: string }>(`SELECT merchant_identity_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1`, [intentId])).rows[0];
  if (!row) throw notFound();
  if (row.merchant_identity_id !== merchantIdentityId) throw forbidden();
}

/** Admin QUERY-only：绝不首派、不接受body字段、按原号补查；提交后结果未知统一202 UNKNOWN。 */
export async function handleAdminJoinpayQueryRoute(request: SupplyNodeRequest, response: SupplyResponse,
  security: AuthSecurityOptions & { pool: Pool }, prefix: typeof PREFIXES[number], options: AdminJoinpayQueryOptions): Promise<boolean> {
  const { path } = requestPath(request, prefix);
  if (path === "/worker-status") {
    const rid = ensureApiV1RequestId(request); response.setHeader("X-Request-Id", rid);
    await safely(response, rid, async () => {
      if ((request.method ?? "GET").toUpperCase() !== "GET") throw notFound();
      if (request.headers.origin !== undefined && request.headers.origin !== security.adminOrigin && request.headers.origin !== security.apiOrigin
        || request.headers["sec-fetch-site"] === "cross-site") throw forbidden();
      const context = await readAdminContext(request, security);
      await withTransaction(security.pool, async client => {
        await assertAdminContextInTransaction(client, context);
        const access = await loadEffectiveAdminAccess(client, context.userId);
        if (access?.status !== "ACTIVE" || !access.permissions.has(ADMIN_PERMISSION.financeRead)) throw forbidden();
      });
      sendJson(response, 200, projectWorkerStatus(options.workerStatus?.()), rid);
    });
    return true;
  }
  const match = PATH.exec(path);
  if (!match || match[3]!=='query-only' && match[1]!=='legacy-refunds' && !(match[1]==='refunds'&&['resume','resolve'].includes(match[3]!))) return false;
  const requestId = ensureApiV1RequestId(request), method = (request.method ?? "GET").toUpperCase();
  response.setHeader("X-Request-Id", requestId);
  await safely(response, requestId, async () => {
    if (method !== "POST") throw notFound();
    if (!requireOrigin(request, response, security, requestId)) return;
    const context = await readAdminContext(request, security), kind = match[1]!, objectId = match[2]!, action=match[3]!;
    const body = bodyOf(request); ensureOnlyFields(body,(kind==='legacy-refunds'&&['resume','resolve'].includes(action)||kind==='refunds'&&['resume','resolve'].includes(action))?['reason']
      :kind==='legacy-refunds'&&action==='retry'?['reason','previouslyRefundedCents','noUnresolvedRefunds']:[]);
    const actor = { userId: context.userId, sessionId: context.sessionId }, owner = `adminq_${randomUUID()}`;
    if(kind==='legacy-refunds'){
      if(!options.refund || typeof options.refund.legacyRefundsEnabled!=='boolean')throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Legacy refund query is unavailable');
      try{
        const operation=action==='submit'?'LEGACY_REFUND_SUBMIT':action==='resume'?'LEGACY_REFUND_RESUME':action==='retry'?'LEGACY_REFUND_RETRY':action==='resolve'?'LEGACY_REFUND_RESOLVE':'LEGACY_REFUND_QUERY';
        const authorize=async(client:PoolClient)=>{
          const row=(await client.query<{order_id:string}>(`SELECT x.order_id FROM zzsh_order.legacy_refund_intent i
            JOIN zzsh_order.legacy_refund_case x ON x.id=i.case_id WHERE i.id=$1`,[objectId])).rows[0];
          if(!row)throw notFound();
          await authorizeLegacyRefundReviewAccess(client,{realm:'admin',...actor,requestId},row.order_id);
          await recordAdminQuery(client,actor,operation,objectId,owner,requestId);
        };
        if(action==='resume'){
          if(typeof body.reason!=='string')throw invalid('Review reason is required');
          const resumed=await resumeLegacyRefundReview({...options.refund,pool:security.pool,legacyRefundsEnabled:options.refund.legacyRefundsEnabled},objectId,actor,requestId,body.reason,authorize);
          sendJson(response,200,dto(operation,objectId,{kind:resumed.resumed?'RESUMED':'ALREADY_RESUMED',state:resumed.state},'NONE',requestId),requestId);return;
        }
        if(action==='retry'){
          if(typeof body.reason!=='string'||typeof body.previouslyRefundedCents!=='string'||typeof body.noUnresolvedRefunds!=='boolean')throw invalid('Refund review is required');
          const retried=await retryLegacyRefund({...options.refund,pool:security.pool,legacyRefundsEnabled:options.refund.legacyRefundsEnabled},objectId,actor,requestId,
            {reason:body.reason,previouslyRefundedCents:body.previouslyRefundedCents,noUnresolvedRefunds:body.noUnresolvedRefunds},authorize);
          sendJson(response,200,dto(operation,objectId,{kind:retried.created?'RETRY_CREATED':'RETRY_EXISTS',state:retried.state},'NONE',requestId),requestId);return;
        }
        if(action==='resolve'){
          if(typeof body.reason!=='string')throw invalid('Review reason is required');
          const result=await resolveLegacyRefundTerminal({...options.refund,pool:security.pool,legacyRefundsEnabled:options.refund.legacyRefundsEnabled},objectId,actor,requestId,body.reason,owner,authorize);
          const outcome=result.kind==='OBSERVED'?{kind:'OBSERVED',event:result.event}:result.kind==='SKIPPED'?{kind:'SKIPPED',reason:result.reason,state:result.state}:{kind:'NOT_DISPATCHED',state:result.state};
          sendJson(response,200,dto(operation,objectId,outcome,'NONE',requestId),requestId);return;
        }
        const out=await executeLegacyRefund({...options.refund,pool:security.pool,legacyRefundsEnabled:options.refund.legacyRefundsEnabled},objectId,owner,
          {queryOnly:action!=='submit',minimumIntervalSeconds:INTERVAL,authorize});
        const outcome=out.kind==='OBSERVED'?{kind:'OBSERVED',event:out.event,terminal:out.terminal!==null}
          :out.kind==='SKIPPED'?{kind:'SKIPPED',reason:out.reason,state:out.state}:{kind:'NOT_DISPATCHED',state:out.state};
        sendJson(response,200,dto(operation,objectId,outcome,out.kind==='OBSERVED'&&out.terminal?'TERMINAL_CONSUMED_BY_STORE':'NONE',requestId),requestId);
      }catch(error){if(!(error instanceof RefundAttemptCommitUnknown))throw error;
        sendJson(response,202,dto(action==='submit'?'LEGACY_REFUND_SUBMIT':action==='resume'?'LEGACY_REFUND_RESUME':action==='retry'?'LEGACY_REFUND_RETRY':action==='resolve'?'LEGACY_REFUND_RESOLVE':'LEGACY_REFUND_QUERY',objectId,{kind:'UNKNOWN',phase:error.phase},'UNKNOWN',requestId),requestId);}
      return;
    }
    if (kind === "withdrawals") {
      if (!options.payout) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Withdrawal query is unavailable");
      let merchantIdentityId: string;
      try { merchantIdentityId = readPayoutScope(options.payout.scope).merchantIdentityId; }
      catch { throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Withdrawal query is unavailable"); }
      try {
        const out = await queryJoinpayPayout({ ...options.payout, pool: security.pool }, objectId, owner, { minimumIntervalSeconds: INTERVAL,
          authorize: async client => { await authorizeAdminWithdrawalQuery(client, actor, objectId, merchantIdentityId);
            await recordAdminQuery(client, actor, "PAYOUT_QUERY", objectId, owner, requestId); } });
        const outcome = out.kind === "OBSERVED" ? { kind: "OBSERVED", event: out.event, terminal: out.terminal !== null, accepted: out.accepted }
          : out.kind === "SKIPPED" ? { kind: "SKIPPED", reason: out.reason, state: out.state } : { kind: "NOT_DISPATCHED", state: out.state };
        sendJson(response, 200, dto("PAYOUT_QUERY", objectId, outcome, out.kind === "OBSERVED" && out.terminal !== null ? "TERMINAL_CONSUMED_BY_STORE" : "NONE", requestId), requestId);
      } catch (error) {
        if (!(error instanceof PayoutCommitUnknown)) throw error;
        sendJson(response, 202, dto("PAYOUT_QUERY", objectId, { kind: "UNKNOWN", phase: error.phase }, "UNKNOWN", requestId), requestId);
      }
      return;
    }
    if (kind === "refunds") {
      if (!options.refund) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Refund query is unavailable");
      try {
        if(action==='resume'){
          if(typeof body.reason!=='string')throw invalid('Review reason is required');
          const resumed=await resumeNativeRefundReview({...options.refund,pool:security.pool},objectId,actor,requestId,body.reason,
            async client=>{await authorizeByOrder(client,actor,REFUND_ORDER,objectId);await recordAdminQuery(client,actor,'REFUND_RESUME',objectId,owner,requestId);});
          sendJson(response,200,dto('REFUND_RESUME',objectId,{kind:resumed.resumed?'RESUMED':'ALREADY_RESUMED',state:resumed.state},'NONE',requestId),requestId);return;
        }
        if(action==='resolve'){
          if(typeof body.reason!=='string')throw invalid('Review reason is required');
          const resolved=await resolveNativeRefundTerminal({...options.refund,pool:security.pool},objectId,actor,requestId,body.reason,
            async client=>{await authorizeByOrder(client,actor,REFUND_ORDER,objectId);await recordAdminQuery(client,actor,'REFUND_RESOLVE',objectId,owner,requestId);});
          sendJson(response,200,dto('REFUND_RESOLVE',objectId,{kind:resolved.resolved?'RESOLVED':resolved.alreadyClear?'ALREADY_RESOLVED':'REQUIRES_MANUAL',state:resolved.state},'NONE',requestId),requestId);return;
        }
        const out = await queryJoinpayRefund({ ...options.refund, pool: security.pool }, objectId, owner, { minimumIntervalSeconds: INTERVAL,
          authorize: async client => { await authorizeByOrder(client, actor, REFUND_ORDER, objectId);
            await recordAdminQuery(client, actor, "REFUND_QUERY", objectId, owner, requestId); } });
        const outcome = out.kind === "OBSERVED" ? { kind: "OBSERVED", event: out.event, terminal: out.terminal !== null }
          : out.kind === "SKIPPED" ? { kind: "SKIPPED", reason: out.reason, state: out.state } : { kind: "NOT_DISPATCHED", state: out.state };
        sendJson(response, 200, dto("REFUND_QUERY", objectId, outcome, out.kind === "OBSERVED" && out.terminal !== null ? "TERMINAL_CONSUMED_BY_STORE" : "NONE", requestId), requestId);
      } catch (error) {
        if (!(error instanceof RefundAttemptCommitUnknown)) throw error;
        sendJson(response, 202, dto(action==='resume'?'REFUND_RESUME':action==='resolve'?'REFUND_RESOLVE':'REFUND_QUERY', objectId, { kind: "UNKNOWN", phase: error.phase }, "UNKNOWN", requestId), requestId);
      }
      return;
    }
    if (!options.collection) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Collection query is unavailable");
    try {
      const out = await executeJoinpayCollectionAttempt({ ...options.collection, pool: security.pool }, { requestId: objectId, workerId: owner,
        recoveryMinimumIntervalSeconds: INTERVAL, allowFirstDispatch: false,
        authorize: async client => { await authorizeByOrder(client, actor, COLLECTION_ORDER, objectId);
          await recordAdminQuery(client, actor, "COLLECTION_QUERY", objectId, owner, requestId); } });
      const outcome = out.kind === "OBSERVED" ? { kind: "OBSERVED", event: out.observation.event } : { kind: "SKIPPED", reason: "NOT_ELIGIBLE" };
      sendJson(response, 200, dto("COLLECTION_QUERY", objectId, outcome,
        out.kind === "OBSERVED" && out.observation.event === "E4" ? "ACCEPTANCE_MAY_HAVE_APPLIED" : "NONE", requestId), requestId);
    } catch (error) {
      if (!(error instanceof CollectionAttemptCommitUnknown)) throw error;
      sendJson(response, 202, dto("COLLECTION_QUERY", objectId, { kind: "UNKNOWN", phase: error.phase }, "UNKNOWN", requestId), requestId);
    }
  });
  return true;
}

/** 仅显式共享装配挂载；未装配执行器时返回503，不读环境、不启动worker。 */
export function mountAdminJoinpayQuery(app: INestApplication, security: AuthSecurityOptions & { pool: Pool }, options: AdminJoinpayQueryOptions): void {
  for (const prefix of PREFIXES) app.getHttpAdapter().getInstance().use(prefix,
    (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) =>
      handleAdminJoinpayQueryRoute(request, response, security, prefix, options).then(handled => { if (!handled) next(); }));
}
