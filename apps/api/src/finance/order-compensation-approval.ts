import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SecurityApiError } from '../auth/security-core';
import type { ApprovalOperationExecutor } from '../auth/auth-security';
import { canonicalize } from '../supply/content-hash';
import { legacyCompensationBasis, nativeCompensationBasis, ORDER_COMPENSATION_OPERATION, parseCompensationPayload, type CompensationPayload } from './order-compensation-contract';
import { compensationTriggersSql, compensationFunctionsSafeSql, compensationIncidentIndexSafeSql } from './order-compensation-schema';

const unavailable = (message: string): never => { throw new SecurityApiError(409, 'CONFLICT', message); };
const sha = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');

async function compensationReady(client: PoolClient): Promise<boolean> {
  const row=(await client.query(`SELECT to_regclass('zzsh_order.order_compensation_posting') IS NOT NULL
    AND to_regprocedure('zzsh_order.post_order_compensation(text)') IS NOT NULL
    AND to_regprocedure('zzsh_order.order_compensation_posting_complete(text)') IS NOT NULL
    AND has_function_privilege(current_user,to_regprocedure('zzsh_order.post_order_compensation(text)'),'EXECUTE')
    AND has_function_privilege(current_user,to_regprocedure('zzsh_order.order_compensation_posting_complete(text)'),'EXECUTE')
    AND has_table_privilege(current_user,to_regclass('zzsh_order.order_compensation_posting'),'SELECT')
    AND NOT has_any_column_privilege(current_user,to_regclass('zzsh_order.order_compensation_posting'),'INSERT')
    AND NOT has_any_column_privilege(current_user,to_regclass('zzsh_order.order_compensation_posting'),'UPDATE')
    AND NOT has_table_privilege(current_user,to_regclass('zzsh_order.order_compensation_posting'),'DELETE')
    AND (${compensationTriggersSql})=11 AND (${compensationFunctionsSafeSql}) AND (${compensationIncidentIndexSafeSql}) AS ready`)).rows[0];
  return row?.ready === true;
}

/** A source-qualified order and its original payment are rechecked at request and approval. */
export async function compensationOrderBasis(client: PoolClient, origin: 'NATIVE' | 'LEGACY', orderId: string) {
  if (origin === 'NATIVE') {
    const row = (await client.query(`SELECT o.id,o.game_id AS "gameId",o.owner_user_id AS "ownerUserId",o.renter_user_id AS "renterUserId",
      o.account_id AS "accountId",o.listing_version_id AS "listingVersionId",o.content_hash AS "contentHash",o.rule_release_id AS "ruleReleaseId",o.quote_snapshot AS quote,
      c.id AS "paymentId",c.amount_cents::text AS "paidCents"
      FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id
       AND c.order_id=o.id AND c.disposition='APPLIED' AND c.currency='CNY' AND c.amount_cents=o.rental_amount_cents+o.deposit_amount_cents WHERE o.id=$1`, [orderId])).rows[0];
    if (!row) return null;
    const basis = nativeCompensationBasis(row);
    if (!basis) return { origin, orderId, gameId:row.gameId, ownerUserId:row.ownerUserId, state:'UNKNOWN' as const, sourceDigest:null };
    return { origin, orderId, gameId:row.gameId, ownerUserId:row.ownerUserId, state:basis.selected ? 'SELECTED' as const : 'NOT_SELECTED' as const, sourceDigest:basis.sourceDigest };
  }
  const row = (await client.query(`SELECT id,game_id AS "gameId",owner_user_id AS "ownerUserId",source_digest AS "originalDigest",
    source_snapshot AS snapshot,source_pay_status FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1`, [orderId])).rows[0];
  if (!row || row.source_pay_status !== 1 || !row.snapshot) return null;
  try { if (sha(row.snapshot) !== row.originalDigest) return null; } catch { return null; }
  const sourceDigest = legacyCompensationBasis({ id:row.id, gameId:row.gameId, ownerUserId:row.ownerUserId, sourceDigest:row.originalDigest });
  return sourceDigest ? { origin, orderId, gameId:row.gameId, ownerUserId:row.ownerUserId, state:'LEGACY_REVIEW' as const, sourceDigest } : null;
}

export async function validateCompensationSubmission(client: PoolClient, value: unknown, checkDuplicate = false): Promise<CompensationPayload> {
  const payload = parseCompensationPayload(value);
  if (!payload) return unavailable('赔偿申请资料不完整或金额不正确');
  if (!await compensationReady(client)) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','赔偿入账能力暂未就绪');
  const basis = await compensationOrderBasis(client,payload.origin,payload.orderId);
  if (!basis || basis.gameId !== payload.gameId || basis.ownerUserId !== payload.ownerUserId || basis.sourceDigest !== payload.sourceDigest) return unavailable('订单或保障依据已变化，请重新核对');
  if (basis.state !== 'SELECTED' && basis.state !== 'LEGACY_REVIEW') return unavailable('未取得本单有效的全额包赔依据');
  if (checkDuplicate && payload.origin === 'NATIVE') {
    // Hold the account through approval creation so guarantee release sees the pending case.
    const account = await client.query(`SELECT a.id FROM zzsh_supply.rental_account a JOIN zzsh_order.rental_order o ON o.account_id=a.id
      WHERE o.id=$1 AND a.owner_user_id=$2 FOR SHARE OF a`, [payload.orderId, payload.ownerUserId]);
    if (account.rowCount !== 1) return unavailable('订单或保障依据已变化，请重新核对');
  }
  if (checkDuplicate && (await client.query(`SELECT 1 FROM zzsh_iam.approval_request WHERE operation_code=$1 AND operation_payload->>'origin'=$2
    AND operation_payload->>'orderId'=$3 AND lower(operation_payload->>'caseRef')=lower($4) AND status IN('PENDING','APPROVED','EXECUTED','EXECUTION_FAILED') LIMIT 1`,
    [ORDER_COMPENSATION_OPERATION,payload.origin,payload.orderId,payload.caseRef])).rowCount) return unavailable('此事故已有赔偿申请，请先核对原申请');
  return payload;
}

export async function readCompensationCases(client: PoolClient, origin: 'NATIVE' | 'LEGACY', orderId: string) {
  const ready=await compensationReady(client);
  if (!ready) return { state:'UNAVAILABLE' as const,items:[],truncated:false };
  const rows=(await client.query(`SELECT a.id,a.status,a.operation_payload->>'amountCents' AS "amountCents",a.operation_payload->>'caseRef' AS "caseRef",
    a.operation_payload->>'reason' AS reason,a.created_at AS "createdAt",a.decided_at AS "decidedAt",p.id AS "postingId",p.created_at AS "postedAt",
    CASE WHEN p.id IS NULL THEN false ELSE zzsh_order.order_compensation_posting_complete(p.id) END AS verified
    FROM zzsh_iam.approval_request a LEFT JOIN zzsh_order.order_compensation_posting p ON p.approval_request_id=a.id
    WHERE a.operation_code=$1 AND a.operation_payload->>'origin'=$2 AND a.operation_payload->>'orderId'=$3
    ORDER BY a.created_at DESC,a.id DESC LIMIT 101`,[ORDER_COMPENSATION_OPERATION,origin,orderId])).rows;
  return { state:'READY' as const,items:rows.slice(0,100),truncated:rows.length>100 };
}

/** Only the approved original request is eligible; posting is delegated to the guarded DB function. */
export const executeOrderCompensation: ApprovalOperationExecutor = async (client,input,actor,requestId) => {
  if (input.operationCode !== ORDER_COMPENSATION_OPERATION || input.payloadVersion !== 1 || sha(input.operationPayload) !== input.operationPayloadHash || input.decidedBy !== actor.userId) return unavailable('赔偿审批依据不一致');
  await validateCompensationSubmission(client,input.operationPayload);
  const result=(await client.query<{value:{caseId:string;eventId:string}}>('SELECT zzsh_order.post_order_compensation($1) AS value',[input.requestId])).rows[0]?.value;
  if (!result || typeof result.caseId !== 'string' || typeof result.eventId !== 'string') throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','赔偿入账结果待核对');
  return { resultCode:'ORDER_COMPENSATION_POSTED',resultDetail:result.caseId };
};
