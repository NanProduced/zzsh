import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ApprovalOperationExecutor } from '../auth/auth-security';
import { loadEffectiveAdminAccess, hasPermission } from '../auth/admin-authorization';
import { assertGameScopeUsable, isAllGamesScope, readAdminGameScope, scopeAllowsGame } from '../auth/admin-scope';
import { SecurityApiError } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { ensureOnlyFields, invalid, notFound } from '../supply/supply-util';

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
/**
 * Object scope of a reversal = the original order's game, read from the server. The payload never carries
 * a gameId, so a caller cannot choose which game the authorization applies to.
 */
export async function reversalObjectGameId(client: Pool | PoolClient, earningId: string, orderId: string) {
  const row = (await client.query(`SELECT o.game_id FROM zzsh_order.rental_referral_earning e
    JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE e.id=$1 AND e.order_id=$2`, [earningId, orderId])).rows[0] as { game_id: string } | undefined;
  if (!row || typeof row.game_id !== 'string' || !row.game_id) throw notFound();
  return row.game_id;
}
/** One batched derivation for approval reads so actions, candidates and the domain decision agree. */
export async function reversalObjectGameIds(client: Pool | PoolClient, requests: readonly { earningId: string }[]) {
  const ids = [...new Set(requests.map(row => String(row?.earningId ?? '')))];
  if (!ids.length) return new Map<string, string>();
  if (ids.some(id => !ID.test(id))) throw notFound();
  const rows = (await client.query(`SELECT e.id AS "earningId", o.game_id AS "gameId" FROM zzsh_order.rental_referral_earning e
    JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE e.id=ANY($1::text[])`, [ids])).rows as { earningId: string; gameId: string }[];
  const scopes = new Map(rows.map(row => [row.earningId, row.gameId]));
  // A reversal whose original order cannot be resolved fails closed rather than reading as unscoped.
  for (const id of ids) if (!scopes.get(id)) throw notFound();
  return scopes;
}
/** Active administrator plus the current game scope of the original order; Boss and ALL_GAMES stay as contracted. */
export async function assertReversalObjectScope(client: Pool | PoolClient, adminUserId: string, gameId: string) {
  const access = await loadEffectiveAdminAccess(client, adminUserId);
  if (!access || access.status !== 'ACTIVE') throw new SecurityApiError(403, 'FORBIDDEN', 'Reversal actor must remain active');
  if (access.isBoss) return access;
  const scope = await readAdminGameScope(client, adminUserId);
  assertGameScopeUsable(scope, false);
  if (!isAllGamesScope(scope) && !scopeAllowsGame(scope, false, gameId)) throw new SecurityApiError(403, 'FORBIDDEN', 'Original earning order is outside the admin game scope');
  return access;
}
async function assertOriginalEarning(client: PoolClient, input: DistributionReversalRequest) {
  const row = (await client.query(`SELECT e.id,e.order_id,e.amount_cents::text,e.state,e.beneficiary_role,o.game_id,
      (SELECT count(*) FROM zzsh_order.rental_referral_transition t WHERE t.earning_id=e.id AND t.action IN('REVOKE','RECOVER'))::int AS reversals
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE e.id=$1 AND e.order_id=$2 FOR UPDATE`, [input.earningId, input.orderId])).rows[0];
  if (!row || typeof row.game_id !== 'string' || !row.game_id || String(row.amount_cents) !== input.amountCents
    || !['PENDING', 'SETTLED', 'RECOVERY_REQUIRED'].includes(row.state) || row.reversals !== 0)
    throw new SecurityApiError(409, 'CONFLICT', 'Original earning is not eligible for a first full reversal');
  return row as { id: string; order_id: string; amount_cents: string; state: string; beneficiary_role: string; game_id: string; reversals: number };
}
/** Creation-time validation: the approved amount is exactly the original root and the requester still covers that order. */
export async function validateDistributionReversalSubmission(client: PoolClient, payload: Record<string, unknown>, actorUserId: string) {
  const input = parseDistributionReversalRequest(payload);
  const earning = await assertOriginalEarning(client, input);
  await assertReversalObjectScope(client, actorUserId, earning.game_id);
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
    const earning = await assertOriginalEarning(client, payload);
    // The executing operator and the Boss who decided must both still cover the original order's game.
    await assertReversalObjectScope(client, actor.userId, earning.game_id);
    await assertReversalObjectScope(client, input.decidedBy, earning.game_id);
    return { resultCode: 'DISTRIBUTION_REVERSAL_AUTHORIZED', resultDetail: payload.earningId };
  };
}
