import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { UserContext } from "../auth/user-identity";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { recordAudit, withTransaction } from "../auth/security-core";
import { assertEcsTestDemoResource, demoFinanceScope, readEcsTestDemoRegistration, type DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE, automaticGuaranteeRefundIssue, lockGuaranteeSubject, recordGuaranteePaymentResult, recordGuaranteeRefundResult } from "./credit-guarantee";

// TODO(正式上线前): 移除此测试渠道适配；模拟回执不能作为汇聚或银行到账证据。
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const ref = (kind: "pay" | "refund", digest: string, id: string) =>
  `demo_g_${kind}_${createHash("sha256").update(`${digest}:${id}`).digest("hex").slice(0, 40)}`;
const source = "ECS_DEMO_GUARANTEE";

/** Test-only channel: the business payment and ledger use their normal transaction and idempotency. */
export async function confirmDemoGuaranteePayment(client: PoolClient, demo: DemoFinanceResource, actor: UserContext & { requestId: string }, accountId: string, paymentId: string) {
  if (!id(accountId) || !id(paymentId) || !id(actor.requestId)) throw invalid();
  const registration = await assertEcsTestDemoResource(client, demo);
  const proof = readEcsTestDemoRegistration(demo);
  await assertUserContextInTransaction(client, actor);
  const subject = await lockGuaranteeSubject(client, "payment", paymentId);
  if (subject.accountId !== accountId || subject.ownerUserId !== actor.userId) throw notFound();
  const row = (await client.query<{ status: string; providerState: string; amount: string; merchant: string; receipt: Record<string, unknown> | null; transactionId: string | null; eligible: boolean }>(`
    SELECT p.status,p.provider_request_state AS "providerState",p.amount_cents::text AS amount,p.merchant_order_no AS merchant,
      p.original_receipt AS receipt,p.provider_transaction_id AS "transactionId",
      (p.created_at>=s.registered_at AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a
       WHERE a.object_type='owner_guarantee_payment' AND a.object_id=p.id AND a.actor_type='user'
         AND a.actor_id=p.owner_user_id AND a.action='credit.guarantee.payment_intent_created'
         AND a.outcome='SUCCESS' AND a.occurred_at>=s.registered_at)) AS eligible
      FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=$2
      WHERE p.id=$1 AND p.owner_user_id=$3 FOR UPDATE OF p`, [paymentId, registration.reference, actor.userId])).rows[0];
  if (!row || row.eligible !== true) throw notFound();
  const transactionId = ref("pay", proof.digest, paymentId);
  const receipt = { source, scope: demoFinanceScope(demo), registrationDigest: proof.digest, paymentId, merchantOrderNo: row.merchant };
  if (row.status === "CONFIRMED") {
    if (row.providerState !== "CONFIRMED" || row.transactionId !== transactionId || row.receipt?.source !== source
      || row.receipt?.registrationDigest !== proof.digest || row.receipt?.paymentId !== paymentId || row.receipt?.merchantOrderNo !== row.merchant) {
      throw conflict("原缴款来源不属于当前模拟环境，请联系客服核对");
    }
  } else if (subject.lifecycle !== "ACTIVE" || row.status !== "REQUESTED" || row.providerState !== "NOT_AUTHORIZED" || row.receipt !== null || row.transactionId !== null) {
    throw conflict("缴款状态待核实，请查询原记录");
  }
  const result = await recordGuaranteePaymentResult(client, { paymentId, outcome: "CONFIRMED", receivedAmountCents: row.amount,
    providerTransactionId: transactionId, receipt, requestId: actor.requestId });
  if (!result.duplicate) await recordAudit(client, { actorType: "user", actorId: actor.userId, sessionId: actor.sessionId,
    action: "demo.guarantee.payment_confirmed", objectType: "owner_guarantee_payment", objectId: paymentId, outcome: "SUCCESS",
    requestId: actor.requestId, details: { scope: demoFinanceScope(demo), bankArrival: "UNKNOWN" } });
  return { ...result, scope: demoFinanceScope(demo), bankArrival: "UNKNOWN" as const };
}

/** Each pass only settles an automatic return of this same registered test resource's simulated payment. */
export async function runDemoGuaranteeRefundBatch(pool: Pool, demo: DemoFinanceResource, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw invalid();
  const proof = readEcsTestDemoRegistration(demo);
  const ids = await withTransaction(pool, async client => {
    await assertEcsTestDemoResource(client, demo);
    return (await client.query<{ id: string }>(`SELECT f.id FROM zzsh_order.owner_guarantee_refund f
      JOIN zzsh_order.owner_guarantee_payment p ON p.id=f.payment_id AND p.requirement_id=f.requirement_id AND p.owner_user_id=f.owner_user_id
      JOIN zzsh_order.owner_guarantee_requirement r ON r.id=f.requirement_id
      JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
      WHERE f.status='REQUESTED' AND f.provider_request_state='NOT_AUTHORIZED' AND f.release_policy_state='AUTO_APPROVED'
        AND (a.lifecycle='DELISTED' OR (a.lifecycle='ARCHIVED' AND zzsh_order.completed_guarantee_refund_eligible(a.id,a.owner_user_id)))
        AND r.status='REFUND_REQUESTED' AND (${AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE}) IS FALSE
        AND EXISTS(SELECT 1 FROM zzsh_credit.user_credit_state c WHERE c.user_id=a.owner_user_id)
        AND p.status='CONFIRMED' AND p.provider_request_state='CONFIRMED' AND p.original_receipt->>'source'=$1
        AND p.original_receipt->>'registrationDigest'=$2
        AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_type='owner_guarantee_payment' AND a.object_id=p.id
          AND a.actor_type='user' AND a.actor_id=p.owner_user_id AND a.action='demo.guarantee.payment_confirmed' AND a.outcome='SUCCESS')
      ORDER BY f.created_at,f.id LIMIT $3`, [source, proof.digest, limit])).rows;
  });
  let completed = 0, failed = 0;
  for (const { id: refundId } of ids) {
    try {
      const applied = await withTransaction(pool, async client => {
        await assertEcsTestDemoResource(client, demo);
        const subject = await lockGuaranteeSubject(client, "refund", refundId);
        const row = (await client.query<{ status: string; providerState: string; paymentId: string; amount: string; paidAmount: string | null; transactionId: string | null; merchant: string; receipt: Record<string, unknown> | null }>(`
          SELECT f.status,f.provider_request_state AS "providerState",f.payment_id AS "paymentId",f.amount_cents::text AS amount,
            p.observed_amount_cents::text AS "paidAmount",p.provider_transaction_id AS "transactionId",p.merchant_order_no AS merchant,p.original_receipt AS receipt
          FROM zzsh_order.owner_guarantee_refund f JOIN zzsh_order.owner_guarantee_payment p
            ON p.id=f.payment_id AND p.requirement_id=f.requirement_id AND p.owner_user_id=f.owner_user_id
          JOIN zzsh_order.owner_guarantee_requirement r ON r.id=f.requirement_id AND r.owner_user_id=f.owner_user_id
          WHERE f.id=$1 AND f.release_policy_state='AUTO_APPROVED' AND r.status='REFUND_REQUESTED' AND p.status='CONFIRMED' AND p.provider_request_state='CONFIRMED'
          FOR UPDATE OF f,p`, [refundId])).rows[0];
        if (!row || row.status !== "REQUESTED" || row.providerState !== "NOT_AUTHORIZED") return false;
        if (await automaticGuaranteeRefundIssue(client, subject.accountId, subject.ownerUserId)) return false;
        if (subject.lifecycle === "ARCHIVED" && (await client.query<{eligible:boolean}>(
          `SELECT zzsh_order.completed_guarantee_refund_eligible($1,$2) AS eligible`, [subject.accountId, subject.ownerUserId],
        )).rows[0]?.eligible !== true) return false;
        if (!["DELISTED", "ARCHIVED"].includes(subject.lifecycle) || row.amount !== row.paidAmount || row.transactionId !== ref("pay", proof.digest, row.paymentId)
          || row.receipt?.source !== source || row.receipt?.scope !== demoFinanceScope(demo) || row.receipt?.registrationDigest !== proof.digest
          || row.receipt?.paymentId !== row.paymentId || row.receipt?.merchantOrderNo !== row.merchant) throw conflict("原模拟付款依据不完整");
        await recordGuaranteeRefundResult(client, { refundId, outcome: "SUCCEEDED", refundedAmountCents: row.amount,
          providerRefundId: ref("refund", proof.digest, refundId),
          receipt: { source, scope: demoFinanceScope(demo), registrationDigest: proof.digest, paymentId: row.paymentId, refundId } });
        await recordAudit(client, { actorType: "system", action: "demo.guarantee.refund_completed", objectType: "owner_guarantee_refund",
          objectId: refundId, outcome: "SUCCESS", requestId: ref("refund", proof.digest, refundId),
          details: { scope: demoFinanceScope(demo), bankArrival: "UNKNOWN" } });
        return true;
      });
      if (applied) completed++;
    } catch { failed++; }
  }
  return { scope: demoFinanceScope(demo), selected: ids.length, completed, failed, bankArrival: "UNKNOWN" as const };
}
