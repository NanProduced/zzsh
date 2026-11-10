import type { PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { invalid, notFound } from "../supply/supply-util";

export const OWNER_REFUND_MINIMAL_VERSION = "owner-refund-minimal.v1";
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPEN_STATES = ["READY", "SUBMITTING", "PROCESSING", "REVIEW_REQUIRED", "UNKNOWN"] as const;

export type OwnerRefundProgress = "NONE" | "PROCESSING" | "NEEDS_REVIEW" | "UNKNOWN" | "DONE" | "NOT_APPLICABLE";

export type OwnerRefundMinimalSummary = Readonly<{
  contractVersion: typeof OWNER_REFUND_MINIMAL_VERSION;
  subjectId: string;
  orderId: string;
  orderStatus: string;
  progress: OwnerRefundProgress;
  label: string;
  note: string;
  openIntentCount: number;
  asOf: string;
}>;

const COPY: Record<OwnerRefundProgress, { label: string; note: string }> = {
  NONE: { label: "暂无退款处理记录", note: "订单主状态以页面展示为准；没有可证的退款处理中事实。" },
  PROCESSING: { label: "退款处理中", note: "订单主状态仍为已取消或已完成；到账情况不以本摘要为准。" },
  NEEDS_REVIEW: { label: "退款需要核对", note: "请联系客服；本摘要不展示租客收款资料。" },
  UNKNOWN: { label: "退款结果未确认", note: "退款记录尚未确认；请稍后查看或联系客服。" },
  DONE: { label: "退款已处理", note: "以退款记录为准，不代表银行到账。" },
  NOT_APPLICABLE: { label: "不适用退款进度", note: "当前订单状态没有可展示的号主退款摘要。" },
};

/** Authorized minimal refund progress for the order owner. Never returns bank or renter payout details. */
export async function readOwnerRefundMinimalSummary(
  client: PoolClient,
  actor: UserContext,
  input: { orderId: unknown },
): Promise<OwnerRefundMinimalSummary> {
  if (!input || typeof input.orderId !== "string" || !ORDER_ID.test(input.orderId)) throw invalid("Invalid order identifier");
  await assertUserContextInTransaction(client, actor, "READ");
  const orderId = input.orderId;
  const order = (await client.query<{ status: string; cancel_reason: string | null; paid_confirmation_id: string | null; owner_user_id: string; as_of: string }>(
    `SELECT o.status,o.cancel_reason,o.paid_confirmation_id,o.owner_user_id,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of
     FROM zzsh_order.rental_order o WHERE o.id=$1`,
    [orderId],
  )).rows[0];
  if (!order || order.owner_user_id !== actor.userId) throw notFound();
  if (order.status === "PENDING_PAYMENT") {
    const copy = COPY.NOT_APPLICABLE;
    return { contractVersion: OWNER_REFUND_MINIMAL_VERSION, subjectId: actor.userId, orderId, orderStatus: order.status, progress: "NOT_APPLICABLE", label: copy.label, note: copy.note, openIntentCount: 0, asOf: order.as_of };
  }
  const prestart = order.status === "CANCELLED" && ["PRESTART_TERMINATED", "SUPPORT_CANCELLED_REFUND"].includes(order.cancel_reason ?? "");
  const poststart = order.status === "CANCELLED" && order.cancel_reason === "SUPPORT_AFTER_START_CANCELLED";
  const intents = (await client.query<{ state: string; count: string }>(
    `SELECT i.state,count(*)::text AS count
     FROM zzsh_order.channel_refund_intent i
     WHERE i.order_id=$1 AND (NOT $2::boolean OR (i.basis_kind='${poststart ? "SUPPORT_CANCELLATION" : "PRESTART_TERMINATION"}' AND i.payment_confirmation_id=$3))
     GROUP BY i.state`,
    [orderId, prestart || poststart, order.paid_confirmation_id ?? null],
  )).rows;
  const counts = new Map(intents.map((row) => [row.state, Number(row.count)]));
  const openIntentCount = OPEN_STATES.reduce((sum, state) => sum + (counts.get(state) ?? 0), 0);
  const succeeded = counts.get("SUCCEEDED") ?? 0;
  const failed = counts.get("FAILED") ?? 0;
  const knownStates = new Set([...OPEN_STATES, "SUCCEEDED", "FAILED"]);
  const unknownState = intents.some(row => !knownStates.has(row.state as typeof OPEN_STATES[number] | "SUCCEEDED" | "FAILED"));
  let progress: OwnerRefundProgress = "NONE";
  if ((counts.get("REVIEW_REQUIRED") ?? 0) > 0) progress = "NEEDS_REVIEW";
  else if ((counts.get("UNKNOWN") ?? 0) > 0 || unknownState) progress = "UNKNOWN";
  else if (openIntentCount > 0) progress = "PROCESSING";
  else if (failed > 0) progress = succeeded > 0 ? "UNKNOWN" : "NEEDS_REVIEW";
  else if (succeeded > 0) progress = "DONE";
  else if (prestart && order.paid_confirmation_id) {
    const available = (await client.query<{ ready: boolean }>(`SELECT COALESCE(
      has_table_privilege(current_user,to_regclass('zzsh_order.prestart_termination'),'SELECT') AND
      has_function_privilege(current_user,to_regprocedure('zzsh_order.prestart_liability_complete(text)'),'EXECUTE'),false) AS ready`)).rows[0]?.ready === true;
    if (available) {
      const result = (await client.query<{ ready: boolean }>(`SELECT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
        WHERE t.order_id=$1 AND t.state='APPROVED' AND zzsh_order.prestart_liability_complete(t.id)) AS ready`, [orderId])).rows[0];
      progress = result?.ready === true ? "PROCESSING" : "UNKNOWN";
    } else progress = "UNKNOWN";
  } else if (prestart) progress = "UNKNOWN";
  else if (poststart && order.paid_confirmation_id) {
    const available = (await client.query<{ ready: boolean }>(`SELECT COALESCE(
      has_table_privilege(current_user,to_regclass('zzsh_order.support_poststart_cancellation'),'SELECT') AND
      has_function_privilege(current_user,to_regprocedure('zzsh_order.support_poststart_cancellation_complete(text)'),'EXECUTE'),false) AS ready`)).rows[0]?.ready === true;
    if (available) {
      const result = (await client.query<{ amount: string; ready: boolean }>(`SELECT p.refund_cents::text AS amount,
        zzsh_order.support_poststart_cancellation_complete(p.id) AS ready FROM zzsh_order.support_poststart_cancellation p
        WHERE p.order_id=$1 AND p.payment_confirmation_id=$2`, [orderId, order.paid_confirmation_id])).rows[0];
      progress = result?.ready === true && typeof result.amount === "string" && /^(0|[1-9][0-9]{0,15})$/.test(result.amount)
        ? result.amount === "0" ? "NONE" : "PROCESSING" : "UNKNOWN";
    } else progress = "UNKNOWN";
  } else if (poststart) progress = "UNKNOWN";
  else if (order.status === "CANCELLED" || order.status === "COMPLETED") progress = "NONE";
  else progress = "NOT_APPLICABLE";
  const copy = COPY[progress];
  return {
    contractVersion: OWNER_REFUND_MINIMAL_VERSION,
    subjectId: actor.userId,
    orderId,
    orderStatus: order.status,
    progress,
    label: copy.label,
    note: copy.note,
    openIntentCount,
    asOf: order.as_of,
  };
}
