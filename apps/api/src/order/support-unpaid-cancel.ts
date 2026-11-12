import type { PoolClient } from "pg";
import { lockActor } from "../auth/admin-directory";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { assertSupportOrderAccess, type ManualCloseActor } from "./manual-close";
import { lockOrderPartiesInOrder } from "./order";
import { hasUnpaidPaymentEvidence, requireFreshPaymentSnapshot, UNPAID_PAYMENT_FACT_COLUMNS, type UnpaidPaymentFacts } from "./unpaid-payment-facts";

type Facts = { id: string; accountId: string; renterUserId: string; ownerUserId: string; gameId: string;
  status: string; revision: string; cancelReason: string | null } & UnpaidPaymentFacts;
const missing = () => new SecurityApiError(404, "NOT_FOUND", "Order not found");

async function assertSchema(client: PoolClient) {
  const row = (await client.query(`SELECT count(*)::int AS count FROM pg_constraint
    WHERE conrelid=to_regclass('zzsh_order.rental_order') AND convalidated
      AND conname IN ('rental_order_cancel_reason_check','rental_order_payment_shape')
      AND pg_get_constraintdef(oid) LIKE '%SUPPORT_UNPAID%'`)).rows[0];
  if (row?.count !== 2) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Unpaid cancellation schema is unavailable");
}

async function facts(client: PoolClient, orderId: string): Promise<Facts> {
  const row = (await client.query<Facts>(`SELECT o.id,o.account_id AS "accountId",o.renter_user_id AS "renterUserId",
    o.owner_user_id AS "ownerUserId",o.game_id AS "gameId",o.status,o.revision::text,o.cancel_reason AS "cancelReason",
    ${UNPAID_PAYMENT_FACT_COLUMNS}
    FROM zzsh_order.rental_order o WHERE o.id=$1`, [orderId])).rows[0];
  if (!row) throw missing();
  hasUnpaidPaymentEvidence(row);
  return row;
}

function eligibility(row: Facts) {
  const reason = row.status !== "PENDING_PAYMENT" ? "ORDER_NOT_PENDING"
    : hasUnpaidPaymentEvidence(row) ? "PAYMENT_REVIEW_REQUIRED" : null;
  return { allowed: reason === null, reason };
}

export async function readSupportUnpaidCancellation(client: PoolClient, actor: ManualCloseActor, orderId: string) {
  await assertSupportOrderAccess(client, orderId, actor);
  await assertSchema(client);
  const row = await facts(client, orderId);
  return { contractVersion: "admin-support-unpaid-cancel.v1", orderId, orderRevision: row.revision,
    orderStatus: row.status, cancelReason: row.cancelReason, eligibility: eligibility(row) };
}

/** Only a pending order with no payment request or confirmation can use this shortcut. */
export async function supportCancelUnpaidOrder(client: PoolClient, actor: ManualCloseActor, input: {
  orderId: string; expectedOrderRevision: string; reason: string; requestId: string;
}) {
  await requireFreshPaymentSnapshot(client);
  const access = await lockActor(client, actor.userId);
  if (access.passwordChangeRequired) throw new SecurityApiError(403, "FORBIDDEN", "Password change required");
  await assertAdminCommandAuthorizedInTransaction(client, actor);
  await assertSupportOrderAccess(client, input.orderId, actor);
  await assertSchema(client);
  const before = await facts(client, input.orderId);
  await lockOrderPartiesInOrder(client, before.renterUserId, before.ownerUserId);
  await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR SHARE`, [before.gameId]);
  await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [before.accountId]);
  await client.query(`SELECT id FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE`, [input.orderId]);
  // Read payment evidence after acquiring the order lock: a waiting statement's snapshot may predate a just-created request.
  const row = await facts(client, input.orderId);
  if (row.accountId !== before.accountId || row.renterUserId !== before.renterUserId || row.ownerUserId !== before.ownerUserId || row.gameId !== before.gameId)
    throw new SecurityApiError(409, "CONFLICT", "Order binding changed");
  const state = row.revision !== input.expectedOrderRevision ? { allowed: false, reason: "ORDER_CHANGED" } : eligibility(row);
  if (!state.allowed) return { status: 409, body: { contractVersion: "admin-support-unpaid-cancel.v1", orderId: row.id,
    orderRevision: row.revision, orderStatus: row.status, outcome: "BLOCKED", reason: state.reason, reasons: [state.reason] } };
  const changed = await client.query(`UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='SUPPORT_UNPAID',
    cancelled_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
    WHERE id=$1 AND status='PENDING_PAYMENT' AND revision=$2::bigint AND paid_confirmation_id IS NULL AND paid_at IS NULL`,
  [row.id, row.revision]);
  if (changed.rowCount !== 1) throw new SecurityApiError(409, "CONFLICT", "Order changed");
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId,
    action: "order.support_cancel_unpaid", objectType: "rental_order", objectId: row.id, outcome: "SUCCESS",
    reason: input.reason, requestId: input.requestId,
    details: { before: { status: "PENDING_PAYMENT", revision: row.revision },
      after: { status: "CANCELLED", cancelReason: "SUPPORT_UNPAID" }, channelClosed: false } });
  return { status: 200, body: { contractVersion: "admin-support-unpaid-cancel.v1", orderId: row.id,
    orderRevision: (BigInt(row.revision) + 1n).toString(), orderStatus: "CANCELLED", cancelReason: "SUPPORT_UNPAID",
    outcome: "CANCELLED", channelClosed: false } };
}
