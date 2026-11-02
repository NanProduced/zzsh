import type { PoolClient } from "pg";

import { assertAdminContextInTransaction } from "../auth/auth-security";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { assertGameScopeUsable, readAdminGameScope, scopeAllowsGame } from "../auth/admin-scope";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import type { FormalCollectionAdmission } from "./joinpay-collection-profile";

const conflict = (message: string) => new SecurityApiError(409, "CONFLICT", message);
const forbidden = (message = "Access denied") => new SecurityApiError(403, "FORBIDDEN", message);
const missing = () => new SecurityApiError(404, "NOT_FOUND", "Order not found");
const CONTEXT = (actor: { userId: string; sessionId: string }) => ({ realm: "admin" as const, userId: actor.userId, sessionId: actor.sessionId });

export type ManualCloseActor = { userId: string; sessionId: string; settlementAdmission?: FormalCollectionAdmission };

/**
 * Shared support command boundary: active admin with order settlement write,
 * game scope, and a joined STAFF identity on this order's READY team.
 */
export async function assertSupportOrderAccess(client: PoolClient, orderId: string, actor: ManualCloseActor): Promise<void> {
  await assertAdminContextInTransaction(client, CONTEXT(actor));
  const access = await loadEffectiveAdminAccess(client, actor.userId);
  if (!access || access.status !== "ACTIVE" || !hasPermission(access, ADMIN_PERMISSION.orderSettlementWrite)) throw forbidden();
  const order = (await client.query<{ gameId: string }>(`SELECT game_id AS "gameId" FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0];
  if (!order) throw missing();
  const scope = await readAdminGameScope(client, actor.userId);
  assertGameScopeUsable(scope, access.isBoss);
  if (!access.isBoss && !scopeAllowsGame(scope, false, order.gameId)) throw forbidden();
  const joined = (await client.query(
    `SELECT 1 FROM zzsh_order.im_order_member mm
      JOIN zzsh_iam.im_identity_mapping m ON m.id = mm.identity_id AND m.app_id = mm.app_id
      JOIN zzsh_order.im_order_group g ON g.order_id = mm.order_id AND g.app_id = mm.app_id
     WHERE mm.order_id = $1 AND mm.party = 'STAFF' AND mm.state = 'JOINED'
       AND m.realm = 'admin' AND m.identity_kind = 'ADMIN' AND m.status = 'READY'
       AND m.platform_subject_id = $2 AND g.team_state = 'READY' LIMIT 1`,
    [orderId, actor.userId],
  )).rowCount;
  if (!joined) throw forbidden("Only joined support can handle this order");
}

export async function assertManualCloseAccess(client: PoolClient, orderId: string, actor: ManualCloseActor): Promise<void> {
  await assertSupportOrderAccess(client, orderId, actor);
}

export async function manualCloseOrder(
  client: PoolClient,
  orderId: string,
  actor: ManualCloseActor,
  remark: string,
  requestId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  await assertManualCloseAccess(client, orderId, actor);
  const order = (await client.query<{
    status: string; cancelReason: string | null; paidConfirmationId: string | null; cancelledAt: string | null; openingConfirmed: boolean;
  }>(`SELECT status, cancel_reason AS "cancelReason", paid_confirmation_id AS "paidConfirmationId",
             cancelled_at::text AS "cancelledAt",
             EXISTS(SELECT 1 FROM zzsh_order.rental_opening op WHERE op.order_id=o.id AND op.status='CONFIRMED') AS "openingConfirmed"
        FROM zzsh_order.rental_order o WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
  if (!order) throw missing();
  if (order.status === "CANCELLED" && order.cancelReason === "MANUAL_CLOSE") {
    return { status: 200, body: { orderId, status: "CANCELLED", cancelReason: "MANUAL_CLOSE", cancelledAt: order.cancelledAt,
      localFundsEffect: "NONE", financeHandling: "OFFLINE_REQUIRED", alreadyClosed: true } };
  }
  if (order.status !== "PAID" || !order.paidConfirmationId) throw conflict("ORDER_NOT_CLOSABLE");
  if(typeof order.openingConfirmed!=="boolean")throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Opening facts are unavailable");
  const resolution=order.openingConfirmed
    ?{code:"SETTLEMENT_REQUIRED",readPath:`/api/v1/admin/orders/${orderId}/settlement`,message:"请按实际消耗完成结算后结束订单。"}
    :{code:"PRESTART_REFUND_REQUIRED",readPath:`/api/v1/admin/orders/${orderId}/support-cancel`,message:"请办理未开租客服取消，确认原款应退责任后结束订单。"};
  await recordAudit(client, {
    actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, action: "order.manual_close.rejected",
    objectType: "rental_order", objectId: orderId, outcome: "FAILURE", requestId,reason:"LEGAL_RESOLUTION_REQUIRED",
    details: {remark,orderStatus:"PAID",resolution:resolution.code,moneyUnchanged:true},
  });
  return {status:409,body:{error:{code:"CONFLICT",message:resolution.message,reason:resolution.code},orderId,status:"PAID",resolution,
    localFundsEffect:"NONE",orderUnchanged:true}};
}
