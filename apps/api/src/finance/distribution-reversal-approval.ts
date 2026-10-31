import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ApprovalOperationExecutor } from '../auth/auth-security';
import { loadEffectiveAdminAccess, hasPermission } from '../auth/admin-authorization';
import { SecurityApiError } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { ensureOnlyFields, invalid } from '../supply/supply-util';

export const DISTRIBUTION_REVERSAL_OPERATION = 'distribution.earning.reverse';
export type DistributionReversalRequest = { schema: 'distribution-reversal-request.v1'; earningId: string; orderId: string; amountCents: string; full: true; reason: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function parseDistributionReversalRequest(value: Record<string, unknown>): DistributionReversalRequest {
  ensureOnlyFields(value, ['schema', 'earningId', 'orderId', 'amountCents', 'full', 'reason']);
  if (value.schema !== 'distribution-reversal-request.v1' || typeof value.earningId !== 'string' || !ID.test(value.earningId)
    || typeof value.orderId !== 'string' || !ID.test(value.orderId) || typeof value.amountCents !== 'string' || !/^[1-9]\d{0,23}$/.test(value.amountCents)
    || value.full !== true || typeof value.reason !== 'string' || value.reason.trim().length < 3 || value.reason.length > 500)
    throw invalid('Exact full original earning reversal authorization required');
  return { schema: 'distribution-reversal-request.v1', earningId: value.earningId, orderId: value.orderId, amountCents: value.amountCents, full: true, reason: value.reason.trim() };
}
async function assertOriginalEarning(client: PoolClient, input: DistributionReversalRequest) {
  const row = (await client.query(`SELECT e.id,e.order_id,e.amount_cents::text,e.state,e.beneficiary_role,
      (SELECT count(*) FROM zzsh_order.rental_referral_transition t WHERE t.earning_id=e.id AND t.action IN('REVOKE','RECOVER'))::int AS reversals
    FROM zzsh_order.rental_referral_earning e WHERE e.id=$1 AND e.order_id=$2 FOR UPDATE`, [input.earningId, input.orderId])).rows[0];
  if (!row || String(row.amount_cents) !== input.amountCents || !['PENDING', 'SETTLED', 'RECOVERY_REQUIRED'].includes(row.state) || row.reversals !== 0)
    throw new SecurityApiError(409, 'CONFLICT', 'Original earning is not eligible for a first full reversal');
  return row;
}
/** Creation-time validation: the approved amount is exactly the original root; partial correction is not this contract. */
export async function validateDistributionReversalSubmission(client: PoolClient, payload: Record<string, unknown>) {
  const input = parseDistributionReversalRequest(payload);
  await assertOriginalEarning(client, input);
  const existing = (await client.query("SELECT id FROM zzsh_iam.approval_request WHERE operation_code=$1 AND status IN('PENDING','APPROVED','EXECUTION_FAILED') AND operation_payload->>'earningId'=$2 AND expires_at>clock_timestamp() LIMIT 1",
    [DISTRIBUTION_REVERSAL_OPERATION, input.earningId])).rows[0];
  if (existing) throw new SecurityApiError(409, 'CONFLICT', 'A full reversal request for this earning already requires handling');
}
/** Authorization only: no money is written here. The owner maintenance declaration consumes this approved request. */
export function createDistributionReversalApprovalExecutor(): ApprovalOperationExecutor {
  return async (client, input, actor) => {
    if (input.operationCode !== DISTRIBUTION_REVERSAL_OPERATION || input.payloadVersion !== 1) throw new SecurityApiError(409, 'CONFLICT', 'Unsupported distribution reversal operation');
    const access = await loadEffectiveAdminAccess(client, actor.userId);
    if (!access || access.status !== 'ACTIVE' || access.passwordChangeRequired || !hasPermission(access, 'personal.distribution.policy.manage')) throw new SecurityApiError(403, 'FORBIDDEN', 'Distribution reversal execution permission required');
    if (input.requestedBy === input.decidedBy) throw new SecurityApiError(409, 'CONFLICT', 'Reversal requester cannot approve itself');
    const decider = await loadEffectiveAdminAccess(client, input.decidedBy);
    if (!decider || decider.status !== 'ACTIVE' || decider.isBoss !== true) throw new SecurityApiError(403, 'FORBIDDEN', 'Boss approval required for a full reversal');
    if (createHash('sha256').update(canonicalize(input.operationPayload)).digest('hex') !== input.operationPayloadHash) throw new SecurityApiError(409, 'CONFLICT', 'Approved reversal payload changed');
    const now = Date.now(), expires = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(expires) || expires <= now) throw new SecurityApiError(409, 'CONFLICT', 'Approved reversal request expired');
    const payload = parseDistributionReversalRequest(input.operationPayload);
    await assertOriginalEarning(client, payload);
    return { resultCode: 'DISTRIBUTION_REVERSAL_AUTHORIZED', resultDetail: payload.earningId };
  };
}
