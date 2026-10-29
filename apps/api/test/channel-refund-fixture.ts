// 最小原生责任fixture：复用已有PAID订单和有效当事人/客服，不新建供给、身份、权限或IM群。
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { withTransaction } from "../src/auth/security-core";
import { assertSyntheticChannelRequestCapability } from "../src/order/channel-payment-store";
import { recordOpening, confirmOpening, previewSettlement, submitSettlement, decideSettlement } from "../src/order/settlement-record";

type Actor = { realm: "user" | "admin"; userId: string; sessionId: string };
type Line = { itemId: string; quantity: string };
type FixtureInput = { orderId: string; requestId: string; capability: unknown; renter: Actor; owner: Actor; support: Actor;
  openingLines: Line[]; remainingLines: Line[] };
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const validLines = (v: Line[]) => Array.isArray(v) && v.length > 0 && v.length <= 64 && new Set(v.map(x=>x?.itemId)).size===v.length
  && v.every(x => token(x?.itemId) && typeof x.quantity === "string" && /^(0|[1-9]\d{0,18})$/.test(x.quantity));
const body = (r: { status: number; body: Record<string, unknown> }) => {
  if (r.status !== 200) throw Error("REFUND_FIXTURE_SETTLEMENT_BLOCKED:"+JSON.stringify(r.body.reasons ?? [])); return r.body;
};

/** 所有fixture业务写在同一事务。授权、原冻结数量、预览hash、双方确认与原过账守卫均由现有业务执行。 */
export async function createNativeRefundPostingFixture(pool: Pool, input: FixtureInput) {
  if (!token(input.orderId) || !token(input.requestId) || !validLines(input.openingLines) || !validLines(input.remainingLines)
    || ![input.renter,input.owner,input.support].every(a => a && token(a.userId) && token(a.sessionId))
    || input.renter.realm !== "user" || input.owner.realm !== "user" || input.support.realm !== "admin"
    || input.renter.userId === input.owner.userId) throw Error("REFUND_FIXTURE_INPUT_INVALID");
  let postingId: string | null = null, stage = "PREFLIGHT";
  try {
    const posted = await withTransaction(pool, async client => {
      if (await assertSyntheticChannelRequestCapability(client, input.capability) !== "CONTROLLED_TEST") throw Error("REFUND_FIXTURE_CONTROLLED_CAPABILITY_REQUIRED");
      const source = (await client.query(`SELECT o.renter_user_id,o.owner_user_id,c.id AS confirmation_id
        FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
        WHERE o.id=$1 AND o.status='PAID' AND c.source='CONTROLLED' AND c.disposition='APPLIED' AND c.currency='CNY'
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id)
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)`, [input.orderId])).rows[0];
      if (!source || source.renter_user_id !== input.renter.userId || source.owner_user_id !== input.owner.userId) throw Error("REFUND_FIXTURE_ORIGINAL_PAID_ORDER_REQUIRED");
      stage = "OPENING";
      const opened = body(await recordOpening(client, input.orderId, input.support, input.openingLines, input.requestId));
      const openings = opened.openings as Array<{ id: string; versionNo: number }>;
      assert.equal(openings.length, 1); const opening = openings[0]!;
      body(await confirmOpening(client,input.orderId,opening.id,opening.versionNo,input.renter,input.requestId));
      body(await confirmOpening(client,input.orderId,opening.id,opening.versionNo,input.owner,input.requestId));
      stage = "NORMAL_SETTLEMENT";
      const preview = body(await previewSettlement(client,input.orderId,input.renter,input.remainingLines));
      if (preview.early !== false || typeof preview.versionHash !== "string") throw Error("REFUND_FIXTURE_NORMAL_SETTLEMENT_REQUIRED");
      const submitted = body(await submitSettlement(client,input.orderId,input.renter,input.remainingLines,preview.versionHash,input.requestId));
      const settlement = submitted.settlement as { id: string; versionHash: string; decisions: Array<{ party: string; action: string }> } | null;
      assert.ok(settlement); assert.ok(settlement.decisions.some(d=>d.party==='RENTER'&&d.action==='CONFIRM'));
      body(await decideSettlement(client,input.orderId,settlement.id,input.owner,"CONFIRM",settlement.versionHash,null,input.requestId));
      const p = (await client.query(`SELECT p.id,p.order_id,p.payment_confirmation_id,p.version_hash,p.renter_refund_cents::text AS refund_cents,
        p.refund_due_at<=clock_timestamp() AS due FROM zzsh_order.settlement_posting p
        JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.status='COMPLETED'
        WHERE p.order_id=$1 AND p.payment_confirmation_id=$2 AND p.early=false`, [input.orderId,source.confirmation_id])).rows[0];
      if (!p || p.due!==true || BigInt(p.refund_cents)<8n) throw Error("REFUND_FIXTURE_DUE_POSITIVE_RESPONSIBILITY_REQUIRED");
      postingId = p.id; stage = "POSTED_AWAITING_COMMIT"; return p;
    });
    stage = "COMMITTED";
    return { scope: "CONTROLLED_TEST" as const, postingId: posted.id as string, orderId: input.orderId,
      paymentConfirmationId: posted.payment_confirmation_id as string, versionHash: posted.version_hash as string,
      refundCents: posted.refund_cents as string, formalRefund: false as const,
      notRun: ["post-commit membership/distribution callbacks", "real IM or merchant service"] };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { refundFixturePartial: { orderId: input.orderId, postingId,
      stage, commitOutcome: stage==='POSTED_AWAITING_COMMIT'?'UNKNOWN':'NOT_CONFIRMED',retainOriginalReferences:true,retryAuthorized:false } });
  }
}
