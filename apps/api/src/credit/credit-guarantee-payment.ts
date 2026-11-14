import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { gameScopeSql } from "../auth/admin-scope";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { readGuaranteeContext, type GuaranteeContext } from "./credit-guarantee-context";
import { hash, ID, id } from "./credit-guarantee-internals";
import { appendGuaranteeLedger, AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE, lockGuaranteeSubject, recordGuaranteeObservation, resultReceipt, safelyEnqueueAutomaticGuaranteeRefund } from "./credit-guarantee-refund";

type GuaranteeTransactionActor = { userId: string; isBoss: boolean };

type GuaranteePaymentHistoryRow = {
  id: string;
  requirementId: string;
  merchantOrderNo: string;
  amountCents: string;
  observedAmountCents: string | null;
  status: string;
  providerRequestState: string;
  providerTransactionId: string | null;
  financeEventId: string | null;
  ledgerEntryRef: string | null;
  createdAt: string;
  simulationSource?: string | null;
};

type GuaranteeRefundHistoryRow = {
  id: string;
  requirementId: string;
  paymentId: string;
  amountCents: string;
  status: string;
  providerRequestState: string;
  providerRefundId: string | null;
  releasePolicyState: string;
  financeEventId: string | null;
  ledgerEntryRef: string | null;
  createdAt: string;
  simulationSource?: string | null;
};

export async function readGuaranteeTransactions(client: PoolClient, userId: string, actor?: GuaranteeTransactionActor) {
  const scoped = actor ? `AND (${gameScopeSql("a.game_id","$3","$2")})` : "";
  const requirementParams = actor ? [userId, actor.isBoss, actor.userId] : [userId];
  const requirements = (await client.query(`SELECT r.id AS "requirementId",r.account_id AS "accountId",r.listing_version_id AS "listingVersionId",r.price_version_id AS "priceVersionId",r.base_cents::text AS "baseCents",r.required_cents::text AS "requiredCents",r.score_snapshot AS "scoreSnapshot",r.status AS "requirementStatus",r.created_at::text AS "requirementCreatedAt",
    CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.owner_guarantee_refund f WHERE f.requirement_id=r.id AND f.owner_user_id=r.owner_user_id
      AND f.status='REQUESTED' AND f.provider_request_state='NOT_AUTHORIZED' AND f.release_policy_state='AUTO_APPROVED')
      THEN CASE
        WHEN r.status='RESTRICTED' OR (${AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE}) THEN true
        WHEN NOT EXISTS(SELECT 1 FROM zzsh_credit.user_credit_state c WHERE c.user_id=a.owner_user_id) THEN NULL
        WHEN a.lifecycle='ARCHIVED' THEN NOT zzsh_order.completed_guarantee_refund_eligible(a.id,a.owner_user_id)
        WHEN a.lifecycle='DELISTED' THEN false
      END END AS "automaticRefundNeedsReview"
    FROM zzsh_order.owner_guarantee_requirement r
    JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 ${scoped} ORDER BY r.created_at DESC,r.id DESC`, requirementParams)).rows as Array<Record<string, unknown> & { requirementId: string }>;
  if (!requirements.length) return [];
  const requirementIds = requirements.map((row) => row.requirementId);
  const payments = (await client.query<GuaranteePaymentHistoryRow>(`SELECT id,requirement_id AS "requirementId",merchant_order_no AS "merchantOrderNo",amount_cents::text AS "amountCents",observed_amount_cents::text AS "observedAmountCents",status,provider_request_state AS "providerRequestState",provider_transaction_id AS "providerTransactionId",finance_event_id AS "financeEventId",ledger_entry_ref AS "ledgerEntryRef",created_at::text AS "createdAt",
    CASE WHEN original_receipt->>'source'='ECS_DEMO_GUARANTEE' THEN original_receipt->>'scope' END AS "simulationSource"
    FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=ANY($1::text[]) ORDER BY requirement_id,created_at,id`, [requirementIds])).rows;
  const refunds = (await client.query<GuaranteeRefundHistoryRow>(`SELECT id,requirement_id AS "requirementId",payment_id AS "paymentId",amount_cents::text AS "amountCents",status,provider_request_state AS "providerRequestState",provider_refund_id AS "providerRefundId",release_policy_state AS "releasePolicyState",finance_event_id AS "financeEventId",ledger_entry_ref AS "ledgerEntryRef",created_at::text AS "createdAt",
    CASE WHEN original_receipt->>'source'='ECS_DEMO_GUARANTEE' THEN original_receipt->>'scope' END AS "simulationSource"
    FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=ANY($1::text[]) ORDER BY requirement_id,created_at,id`, [requirementIds])).rows;
  const paymentsByRequirement = new Map<string, GuaranteePaymentHistoryRow[]>();
  const refundsByRequirement = new Map<string, GuaranteeRefundHistoryRow[]>();
  for (const payment of payments) (paymentsByRequirement.get(payment.requirementId) ?? (paymentsByRequirement.set(payment.requirementId, []), paymentsByRequirement.get(payment.requirementId)!)).push(payment);
  for (const refund of refunds) (refundsByRequirement.get(refund.requirementId) ?? (refundsByRequirement.set(refund.requirementId, []), refundsByRequirement.get(refund.requirementId)!)).push(refund);
  return requirements.map((requirement) => {
    const paymentHistory = paymentsByRequirement.get(requirement.requirementId) ?? [];
    const refundHistory = refundsByRequirement.get(requirement.requirementId) ?? [];
    const payment = paymentHistory[paymentHistory.length - 1] ?? null;
    const refund = refundHistory[refundHistory.length - 1] ?? null;
    return {
      ...requirement,
      paymentId: payment?.id ?? null,
      merchantOrderNo: payment?.merchantOrderNo ?? null,
      paymentAmountCents: payment?.amountCents ?? null,
      paymentObservedAmountCents: payment?.observedAmountCents ?? null,
      paymentStatus: payment?.status ?? null,
      paymentProviderState: payment?.providerRequestState ?? null,
      providerTransactionId: payment?.providerTransactionId ?? null,
      paymentFinanceEventId: payment?.financeEventId ?? null,
      paymentLedgerEntryRef: payment?.ledgerEntryRef ?? null,
      paymentCreatedAt: payment?.createdAt ?? null,
      refundId: refund?.id ?? null,
      refundPaymentId: refund?.paymentId ?? null,
      refundAmountCents: refund?.amountCents ?? null,
      refundStatus: refund?.status ?? null,
      refundProviderState: refund?.providerRequestState ?? null,
      providerRefundId: refund?.providerRefundId ?? null,
      refundPolicyState: refund?.releasePolicyState ?? null,
      refundFinanceEventId: refund?.financeEventId ?? null,
      refundLedgerEntryRef: refund?.ledgerEntryRef ?? null,
      refundCreatedAt: refund?.createdAt ?? null,
      paymentHistory,
      refundHistory,
    };
  });
}

export async function createGuaranteePaymentIntent(client: PoolClient, input: { context: GuaranteeContext | null; accountId?: string; userId: string; requestKey: string; requestFingerprint: string }): Promise<Record<string, unknown>> {
  if (input.context && input.context.ownerUserId !== input.userId) throw notFound();
  if (!ID.test(input.requestKey) || !/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw invalid("Guarantee payment idempotency data is invalid");
  const accountId = input.accountId ?? input.context?.accountId;
  if (!accountId || !ID.test(accountId)) throw invalid("Guarantee account is invalid");
  const account = (await client.query<{ lifecycle: string }>(`SELECT lifecycle FROM zzsh_supply.rental_account WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`, [accountId, input.userId])).rows[0];
  if (!account) throw notFound();
  const existingIntents = (await client.query(`SELECT p.id,p.request_fingerprint AS "requestFingerprint",p.status,p.provider_request_state AS "providerRequestState",p.merchant_order_no AS "merchantOrderNo",p.amount_cents::text AS "amountCents",p.provider_transaction_id AS "providerTransactionId",p.finance_event_id AS "financeEventId",p.ledger_entry_ref AS "ledgerEntryRef",p.requirement_id AS "requirementId",p.owner_user_id AS "ownerUserId",r.account_id AS "accountId"
    FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_requirement r ON r.id=p.requirement_id
    WHERE p.request_key=$1 ORDER BY p.created_at,p.id FOR UPDATE OF p,r`, [input.requestKey])).rows;
  if (existingIntents.some((row) => row.ownerUserId !== input.userId || row.accountId !== accountId)) throw conflict("Payment request key is already bound to a different subject or account");
  const existing = existingIntents.find((row) => row.ownerUserId === input.userId && row.accountId === accountId);
  if (existing) {
    if (existingIntents.some((row) => row.requestFingerprint !== input.requestFingerprint)) throw conflict("Payment request key is already bound to different evidence");
    return { paymentId: existing.id, requirementId: existing.requirementId, status: existing.status, providerRequestState: existing.providerRequestState, merchantOrderNo: existing.merchantOrderNo, amountCents: existing.amountCents, providerTransactionId: existing.providerTransactionId, financeEventId: existing.financeEventId, ledgerEntryRef: existing.ledgerEntryRef, duplicate: true, provider: "HUIJU", providerAction: "NOT_AUTHORIZED" };
  }
  if (account.lifecycle !== "ACTIVE") throw conflict("出租账号已结束，不能新建保证金支付");
  const current = await readGuaranteeContext(client, accountId, input.userId, input.context?.versionId ?? undefined);
  if (!current) {
    if (!input.context) throw notFound();
    throw conflict("Guarantee context changed; refresh the current account version");
  }
  if (!input.context) input = { ...input, context: current };
  const context = input.context;
  if (!current
    || !context
    || current.accountId !== context.accountId
    || current.ownerUserId !== context.ownerUserId
    || current.versionId !== context.versionId
    || current.priceVersionId !== context.priceVersionId
    || current.releaseId !== context.releaseId
    || current.baseCents !== context.baseCents
    || current.requiredCents !== context.requiredCents
    || current.score !== context.score
    || current.creditRevision !== context.creditRevision
    || current.state !== context.state) {
    throw conflict("Guarantee context changed; refresh the current account version");
  }
  if (context.state !== "REQUIRED" && context.state !== "FAILED") throw conflict("Guarantee payment is not currently required");
  const binding = (await client.query<{ id: string; baseCents: string; requiredCents: string; policyVersion: string; gameId: string; ruleReleaseId: string }>(
    `SELECT id,base_cents::text AS "baseCents",required_cents::text AS "requiredCents",policy_version AS "policyVersion",game_id AS "gameId",rule_release_id AS "ruleReleaseId"
       FROM zzsh_order.owner_guarantee_requirement
      WHERE owner_user_id=$1 AND account_id=$2 AND price_version_id=$3 AND listing_version_id IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [input.userId, accountId, context.priceVersionId, context.versionId],
  )).rows[0];
  let requirement = binding;
  if (!requirement) {
    const requirementId = `guarantee_req_${randomUUID().replaceAll("-", "")}`;
    await client.query(
      `INSERT INTO zzsh_order.owner_guarantee_requirement(id,owner_user_id,account_id,game_id,listing_version_id,price_version_id,rule_release_id,policy_version,base_cents,required_cents,score_snapshot,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN')
       ON CONFLICT (owner_user_id,account_id,price_version_id,(COALESCE(listing_version_id,''))) DO NOTHING`,
      [requirementId, input.userId, accountId, context.gameId, context.versionId, context.priceVersionId, context.releaseId, context.policy.policyVersion, context.baseCents, context.requiredCents, context.score],
    );
    requirement = (await client.query<{ id: string; baseCents: string; requiredCents: string; policyVersion: string; gameId: string; ruleReleaseId: string }>(
      `SELECT id,base_cents::text AS "baseCents",required_cents::text AS "requiredCents",policy_version AS "policyVersion",game_id AS "gameId",rule_release_id AS "ruleReleaseId"
         FROM zzsh_order.owner_guarantee_requirement
        WHERE owner_user_id=$1 AND account_id=$2 AND price_version_id=$3 AND listing_version_id IS NOT DISTINCT FROM $4
        FOR UPDATE`,
    [input.userId, accountId, context.priceVersionId, context.versionId],
    )).rows[0];
  }
  if (!requirement || requirement.baseCents !== (context.baseCents ?? "") || requirement.requiredCents !== context.requiredCents || requirement.policyVersion !== context.policy.policyVersion || requirement.gameId !== context.gameId || requirement.ruleReleaseId !== context.releaseId) {
    throw conflict("Guarantee basis changed; refresh the current account version");
  }
  const paymentId = `guarantee_pay_${randomUUID().replaceAll("-", "")}`;
  const merchantOrderNo = `ZG${Date.now().toString(36).toUpperCase()}${paymentId.slice(-8).toUpperCase()}`;
  await client.query(`INSERT INTO zzsh_order.owner_guarantee_payment(id,requirement_id,owner_user_id,request_key,request_fingerprint,merchant_order_no,amount_cents,status,provider,provider_request_state) VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED','HUIJU','NOT_AUTHORIZED')`, [paymentId, requirement.id, input.userId, input.requestKey, input.requestFingerprint, merchantOrderNo, context.requiredCents]);
  return { paymentId, requirementId: requirement.id, status: "REQUESTED", merchantOrderNo, amountCents: context.requiredCents, provider: "HUIJU", providerAction: "NOT_AUTHORIZED", duplicate: false };
}

export type GuaranteePaymentOutcome = "ACCEPTED" | "PROCESSING" | "CONFIRMED" | "FAILED" | "UNKNOWN";
export async function recordGuaranteePaymentResult(client: PoolClient, input: { paymentId: string; outcome: GuaranteePaymentOutcome; receivedAmountCents?: string; providerTransactionId?: string; receipt: unknown; requestId?: string }): Promise<Record<string, unknown>> {
  const paymentId = id(input.paymentId, "paymentId");
  if (!["ACCEPTED", "PROCESSING", "CONFIRMED", "FAILED", "UNKNOWN"].includes(input.outcome)) throw invalid("Payment outcome is invalid");
  if (input.requestId !== undefined && !ID.test(input.requestId)) throw invalid("Payment request id is invalid");
  const receipt = resultReceipt(input.receipt);
  const subject = await lockGuaranteeSubject(client, "payment", paymentId);
  const row = (await client.query<{ id: string; requirementId: string; ownerUserId: string; expectedAmountCents: string; requiredAmountCents: string; status: string; sourceDigest: string | null; providerTransactionId: string | null; observedAmountCents: string | null; financeEventId: string | null; ledgerEntryRef: string | null }>(
    `SELECT p.id,p.requirement_id AS "requirementId",p.owner_user_id AS "ownerUserId",p.amount_cents::text AS "expectedAmountCents",r.required_cents::text AS "requiredAmountCents",p.status,p.source_digest AS "sourceDigest",p.provider_transaction_id AS "providerTransactionId",p.observed_amount_cents::text AS "observedAmountCents",p.finance_event_id AS "financeEventId",p.ledger_entry_ref AS "ledgerEntryRef"
       FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_requirement r ON r.id=p.requirement_id WHERE p.id=$1 FOR UPDATE`, [paymentId],
  )).rows[0];
  if (!row || row.requirementId !== subject.requirementId || row.ownerUserId !== subject.ownerUserId) throw notFound();
  const observedAmount = input.receivedAmountCents ?? null;
  if (observedAmount !== null && !/^(0|[1-9]\d{0,23})$/.test(observedAmount)) throw invalid("Received payment amount is invalid");
  if (input.outcome === "CONFIRMED" && (!input.providerTransactionId || !ID.test(input.providerTransactionId) || observedAmount === null || BigInt(observedAmount) <= 0n || BigInt(observedAmount) > BigInt(row.expectedAmountCents))) throw invalid("Confirmed payment receipt is invalid");
  const observationReceipt = { ...receipt.value, outcome: input.outcome, amountCents: observedAmount, providerTransactionId: input.providerTransactionId ?? null };
  const observationDigest = hash(observationReceipt);
  if (row.status === "CONFIRMED" && (input.outcome !== "CONFIRMED" || row.providerTransactionId !== input.providerTransactionId || row.observedAmountCents !== observedAmount || row.sourceDigest !== observationDigest)) throw conflict("Confirmed payment receipt differs from the original transaction");
  const observationInserted = await recordGuaranteeObservation(client, { paymentId, state: input.outcome, amountCents: observedAmount, providerReference: input.providerTransactionId ?? null, receipt: observationReceipt, digest: observationDigest });
  if (!observationInserted && (input.outcome !== "CONFIRMED" || row.financeEventId || row.ledgerEntryRef)) {
    const automaticRefund = ["DELISTED", "ARCHIVED"].includes(subject.lifecycle) && input.outcome === "CONFIRMED" && row.financeEventId && row.ledgerEntryRef
      ? await safelyEnqueueAutomaticGuaranteeRefund(client, { accountId: subject.accountId, ownerUserId: subject.ownerUserId, requestId: input.requestId ?? `guarantee_capture_${hash(paymentId).slice(0, 40)}` }, subject.lifecycle === "DELISTED" ? "ACCOUNT_DELISTED" : "ORDER_COMPLETED") : undefined;
    return { paymentId, status: row.status, duplicate: true, providerAction: "LOCAL_CONTROLLED", ...(automaticRefund ? { automaticRefund } : {}) };
  }
  if (row.status === "CONFIRMED" && input.outcome !== "CONFIRMED") throw conflict("Confirmed payment cannot move backwards");
  const providerState = input.outcome === "CONFIRMED" ? "CONFIRMED" : input.outcome === "UNKNOWN" ? "UNKNOWN" : input.outcome === "FAILED" ? "FAILED" : "SUBMITTED";
  await client.query(
    `UPDATE zzsh_order.owner_guarantee_payment SET status=$2,provider_request_state=$3,provider_transaction_id=COALESCE($4,provider_transaction_id),observed_amount_cents=COALESCE($5,observed_amount_cents),original_receipt=$6::jsonb,source_digest=CASE WHEN $2='CONFIRMED' THEN $7 ELSE source_digest END,updated_at=clock_timestamp() WHERE id=$1`,
    [paymentId, input.outcome, providerState, input.providerTransactionId ?? null, observedAmount, JSON.stringify(observationReceipt), observationDigest],
  );
  let ledger: { financeEventId: string; ledgerEntryRef: string; rootId: string } | null = null;
  if (input.outcome === "CONFIRMED") {
    ledger = await appendGuaranteeLedger(client, { kind: "GUARANTEE_CAPTURE", sourceId: paymentId, requirementId: row.requirementId, ownerUserId: row.ownerUserId, amountCents: observedAmount!, sourceDigest: observationDigest });
    await client.query(`UPDATE zzsh_order.owner_guarantee_payment SET finance_event_id=$2,ledger_entry_ref=$3,source_digest=$4,updated_at=clock_timestamp() WHERE id=$1`, [paymentId, ledger.financeEventId, ledger.ledgerEntryRef, observationDigest]);
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status=CASE WHEN $2::numeric >= required_cents THEN 'COVERED' ELSE 'OPEN' END,updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId, observedAmount]);
  }
  const automaticRefund = ["DELISTED", "ARCHIVED"].includes(subject.lifecycle) && input.outcome === "CONFIRMED"
    ? await safelyEnqueueAutomaticGuaranteeRefund(client, { accountId: subject.accountId, ownerUserId: subject.ownerUserId, requestId: input.requestId ?? `guarantee_capture_${hash(paymentId).slice(0, 40)}` }, subject.lifecycle === "DELISTED" ? "ACCOUNT_DELISTED" : "ORDER_COMPLETED") : undefined;
  return { paymentId, requirementId: row.requirementId, status: input.outcome, providerTransactionId: input.providerTransactionId ?? null, observedAmountCents: observedAmount, financeEventId: ledger?.financeEventId ?? null, ledgerEntryRef: ledger?.ledgerEntryRef ?? null, duplicate: false, providerAction: "LOCAL_CONTROLLED", ...(automaticRefund ? { automaticRefund } : {}) };
}
