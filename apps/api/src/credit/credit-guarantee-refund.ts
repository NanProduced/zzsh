import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import type { UserObligationReader } from "../auth/user-identity";
import { canonicalize } from "../supply/content-hash";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { CREDIT_GUARANTEE_CAP_CENTS, hash, ID, id, reason } from "./credit-guarantee-internals";

export type DelistedGuaranteeRefund = {
  state: "NONE" | "REQUESTED" | "REVIEW_REQUIRED";
  refunds: Array<{ refundId: string; amountCents: string; status: string; providerState: string; providerAction: "NOT_AUTHORIZED" | "NO_NEW_ACTION" }>;
  reason?: string;
};

/** Shared by the automatic-refund selector and the locked eligibility check. Account alias is `a`. */
export const AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE = `a.staff_restricted
    OR EXISTS(SELECT 1 FROM zzsh_iam.im_aftersale_record f JOIN zzsh_order.rental_order o ON o.id=f.order_id
      WHERE o.account_id=a.id AND f.order_source='NATIVE' AND f.state='PENDING')
    OR EXISTS(SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=a.owner_user_id AND e.subject_role='OWNER'
      AND e.event_type='BREACH_CONFIRMED' AND ((e.source_type='ACCOUNT' AND e.source_id=a.id)
        OR (e.source_type='ORDER' AND EXISTS(SELECT 1 FROM zzsh_order.rental_order o WHERE o.id=e.source_id AND o.account_id=a.id)))
      AND NOT EXISTS(SELECT 1 FROM zzsh_credit.credit_event reversal WHERE reversal.reversal_of_id=e.id))`;

/** Caller holds the account lock, which also serializes new aftersales. */
export async function automaticGuaranteeRefundIssue(client: PoolClient, accountId: string, ownerUserId: string): Promise<string | null> {
  const credit = await client.query(`SELECT user_id FROM zzsh_credit.user_credit_state WHERE user_id=$1 FOR SHARE`, [ownerUserId]);
  if (credit.rowCount !== 1) return "CREDIT_BASIS_UNAVAILABLE";
  const row = (await client.query<{ unresolved: boolean }>(`SELECT ${AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE} AS unresolved
    FROM zzsh_supply.rental_account a WHERE a.id=$1 AND a.owner_user_id=$2`, [accountId, ownerUserId])).rows[0];
  return row?.unresolved === false ? null : "GUARANTEE_REVIEW_REQUIRED";
}

/** Called after permanent delisting or settlement. No channel request is made here. */
async function enqueueAutomaticGuaranteeRefund(client: PoolClient, input: {
  accountId: string; ownerUserId: string; requestId: string;
}, reason: "ACCOUNT_DELISTED" | "ORDER_COMPLETED"): Promise<DelistedGuaranteeRefund> {
  if (![input.accountId, input.ownerUserId, input.requestId].every(value => typeof value === "string" && ID.test(value))) throw invalid("Guarantee refund subject is invalid");
  const account = (await client.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM zzsh_supply.rental_account WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
    [input.accountId, input.ownerUserId],
  )).rows[0];
  if (!account) throw notFound();
  if (account.lifecycle !== (reason === "ACCOUNT_DELISTED" ? "DELISTED" : "ARCHIVED")) throw conflict("Only a permanently delisted or completed account can request automatic guarantee return");
  const requirements = (await client.query<{ id: string; status: string }>(
    `SELECT id,status FROM zzsh_order.owner_guarantee_requirement WHERE account_id=$1 AND owner_user_id=$2 ORDER BY id FOR UPDATE`,
    [input.accountId, input.ownerUserId],
  )).rows;
  if (!requirements.length) {
    // No payment obligation is not proof of a waiver: require the immutable publication fact.
    const waiver = (await client.query<{ waived: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v
        ON v.id=a.current_version_id AND v.account_id=a.id
      JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=a.id
        AND p.owner_user_id=a.owner_user_id AND p.game_id=a.game_id AND p.rule_release_id=v.rule_release_id
        AND p.content_hash=v.content_hash
      WHERE a.id=$1 AND a.owner_user_id=$2 AND p.credit_guarantee_waived IS TRUE
        AND p.credit_guarantee_waived_revision > 0) AS waived`, [input.accountId, input.ownerUserId])).rows[0];
    return waiver?.waived === true ? { state: "NONE", refunds: [] }
      : { state: "REVIEW_REQUIRED", refunds: [], reason: "PUBLICATION_GUARANTEE_UNAVAILABLE" };
  }

  const review = async (reason: string): Promise<DelistedGuaranteeRefund> => {
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='RESTRICTED',updated_at=clock_timestamp()
      WHERE account_id=$1 AND owner_user_id=$2 AND status IN ('OPEN','COVERED')`, [input.accountId, input.ownerUserId]);
    return { state: "REVIEW_REQUIRED", refunds: [], reason };
  };
  if (requirements.some(requirement => requirement.status === "RESTRICTED")) return review("GUARANTEE_REVIEW_REQUIRED");
  const issue = await automaticGuaranteeRefundIssue(client, input.accountId, input.ownerUserId);
  if (issue) return review(issue);
  let unresolved: boolean;
  if (reason === "ORDER_COMPLETED") {
    const result = (await client.query<{ eligible: boolean }>(
      `SELECT zzsh_order.completed_guarantee_refund_eligible($1,$2) AS eligible`, [input.accountId, input.ownerUserId],
    )).rows[0];
    if (typeof result?.eligible !== "boolean") throw conflict("Completed account refund basis is unavailable");
    unresolved = !result.eligible;
  } else {
    const obligations = (await client.query<{ unresolved: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=$1 AND
      (o.status IN ('PENDING_PAYMENT','PAID','COMPLETED') OR EXISTS(SELECT 1 FROM zzsh_order.rental_opening op WHERE op.order_id=o.id AND op.status='CONFIRMED')))
    OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=$1 AND l.source_pay_status IS DISTINCT FROM 0)
    OR EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register l WHERE l.account_id=$1) AS unresolved`, [input.accountId])).rows[0];
    if (!obligations || typeof obligations.unresolved !== "boolean") throw conflict("Account rental history is unavailable");
    unresolved = obligations.unresolved;
  }
  if (unresolved) return review("ACCOUNT_ORDER_REVIEW_REQUIRED");

  type Payment = { id: string; status: string; providerState: string; amountCents: string; evidenceComplete: boolean };
  type ExistingRefund = { id: string; paymentId: string; amountCents: string; status: string; providerState: string; releasePolicyState: string };
  const pending: Array<{ requirementId: string; payment: Payment; existing?: ExistingRefund }> = [];
  for (const requirement of requirements) {
    const payments = (await client.query<Payment>(`SELECT p.id,p.status,p.provider_request_state AS "providerState",
      COALESCE(p.observed_amount_cents,p.amount_cents)::text AS "amountCents",
      (p.observed_amount_cents IS NOT NULL AND p.provider_transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM zzsh_order.finance_event e JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
        JOIN zzsh_order.settlement_ledger_entry cash ON cash.id=p.ledger_entry_ref AND cash.finance_event_id=e.id
        WHERE e.id=p.finance_event_id AND e.kind='GUARANTEE_CAPTURE' AND e.subject_user_id=p.owner_user_id
          AND root.source_kind='NATIVE_GUARANTEE' AND root.source_entity='owner_guarantee_payment'
          AND root.source_id=p.id AND root.subject_user_id=p.owner_user_id AND root.source_digest=p.source_digest
          AND cash.account_code='GUARANTEE_CASH' AND cash.debit_cents=COALESCE(p.observed_amount_cents,p.amount_cents) AND cash.credit_cents=0
          AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry x WHERE x.finance_event_id=e.id)=2
          AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry held WHERE held.finance_event_id=e.id
            AND held.account_code='GUARANTEE_HELD' AND held.counterparty_user_id=p.owner_user_id
            AND held.debit_cents=0 AND held.credit_cents=COALESCE(p.observed_amount_cents,p.amount_cents)))) AS "evidenceComplete"
      FROM zzsh_order.owner_guarantee_payment p WHERE p.requirement_id=$1 AND p.owner_user_id=$2 ORDER BY p.created_at,p.id FOR UPDATE OF p`,
      [requirement.id, input.ownerUserId])).rows;
    if (payments.some(payment => payment.status !== "CONFIRMED" && (payment.status !== "FAILED" || payment.providerState !== "FAILED"))) return review("PAYMENT_UNCERTAIN");
    const confirmed = payments.filter(payment => payment.status === "CONFIRMED");
    if (confirmed.length > 1) return review("MULTIPLE_CONFIRMED_PAYMENTS");
    if (!confirmed.length) continue;
    const payment = confirmed[0]!;
    if (payment.providerState !== "CONFIRMED" || payment.evidenceComplete !== true || !/^[1-9]\d{0,4}$/.test(payment.amountCents)
      || BigInt(payment.amountCents) > CREDIT_GUARANTEE_CAP_CENTS) return review("PAYMENT_EVIDENCE_UNAVAILABLE");
    const refunds = (await client.query<ExistingRefund>(`SELECT id,payment_id AS "paymentId",amount_cents::text AS "amountCents",status,provider_request_state AS "providerState",
      release_policy_state AS "releasePolicyState" FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=$1 ORDER BY created_at,id FOR UPDATE`,
      [requirement.id])).rows;
    if (refunds.length > 1 || refunds.some(refund => refund.paymentId !== payment.id || refund.amountCents !== payment.amountCents
      || refund.releasePolicyState !== "AUTO_APPROVED" || !["REQUESTED", "PROCESSING", "UNKNOWN", "SUCCEEDED"].includes(refund.status))) return review("REFUND_REVIEW_REQUIRED");
    pending.push({ requirementId: requirement.id, payment, ...(refunds[0] ? { existing: refunds[0] } : {}) });
  }
  const refunds: DelistedGuaranteeRefund["refunds"] = [];
  for (const item of pending) {
    if (item.existing) {
      refunds.push({ refundId: item.existing.id, amountCents: item.existing.amountCents, status: item.existing.status, providerState: item.existing.providerState, providerAction: "NO_NEW_ACTION" });
      continue;
    }
    const refundId = `guarantee_refund_${randomUUID().replaceAll("-", "")}`;
    const requestKey = `${reason === "ACCOUNT_DELISTED" ? "delist" : "complete"}-${createHash("sha256").update(item.requirementId).digest("hex")}`;
    const fingerprint = hash([reason === "ACCOUNT_DELISTED" ? "GUARANTEE_DELIST_V1" : "GUARANTEE_COMPLETED_V1", input.ownerUserId, input.accountId, item.requirementId, item.payment.id, item.payment.amountCents]);
    await client.query(`INSERT INTO zzsh_order.owner_guarantee_refund(id,requirement_id,payment_id,owner_user_id,request_key,request_fingerprint,
      amount_cents,status,provider,provider_request_state,release_policy_state,release_decision_reason,release_decision_fingerprint,release_decided_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED','HUIJU','NOT_AUTHORIZED','AUTO_APPROVED',$8,$6,clock_timestamp())`,
      [refundId, item.requirementId, item.payment.id, input.ownerUserId, requestKey, fingerprint, item.payment.amountCents, reason]);
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUND_REQUESTED',updated_at=clock_timestamp() WHERE id=$1`, [item.requirementId]);
    refunds.push({ refundId, amountCents: item.payment.amountCents, status: "REQUESTED", providerState: "NOT_AUTHORIZED", providerAction: "NOT_AUTHORIZED" });
  }
  return { state: refunds.length ? "REQUESTED" : "NONE", refunds };
}

export function enqueueDelistedGuaranteeRefund(client: PoolClient, input: { accountId: string; ownerUserId: string; requestId: string }) {
  return enqueueAutomaticGuaranteeRefund(client, input, "ACCOUNT_DELISTED");
}

export function enqueueCompletedGuaranteeRefund(client: PoolClient, input: { accountId: string; ownerUserId: string; requestId: string }) {
  return enqueueAutomaticGuaranteeRefund(client, input, "ORDER_COMPLETED");
}

export async function requestGuaranteeRefund(client: PoolClient, input: { userId: string; requirementId: string; requestKey: string; requestFingerprint: string; obligationReader: UserObligationReader }): Promise<Record<string, unknown>> {
  if (!ID.test(input.userId) || !ID.test(input.requestKey) || !/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw invalid("Guarantee refund idempotency data is invalid");
  const requirementId = id(input.requirementId, "requirementId");
  const requirement = (await client.query<{ id: string; ownerUserId: string; requiredCents: string; status: string }>(`SELECT id,owner_user_id AS "ownerUserId",required_cents::text AS "requiredCents",status FROM zzsh_order.owner_guarantee_requirement WHERE id=$1 FOR UPDATE`, [requirementId])).rows[0];
  if (!requirement || requirement.ownerUserId !== input.userId) throw notFound();
  const existing = (await client.query(`SELECT id,request_fingerprint AS "requestFingerprint",status,amount_cents::text AS "amountCents",payment_id AS "paymentId",release_policy_state AS "releasePolicyState" FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=$1 AND request_key=$2`, [requirementId, input.requestKey])).rows[0];
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) throw conflict("Refund request key is already bound to different evidence");
    return { refundId: existing.id, requirementId, paymentId: existing.paymentId, amountCents: existing.amountCents, status: existing.status, releasePolicyState: existing.releasePolicyState, duplicate: true, provider: "HUIJU", providerAction: "NOT_AUTHORIZED" };
  }
  const activeRefund = (await client.query(`SELECT id FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=$1 AND status IN ('REQUESTED','PROCESSING','UNKNOWN','SUCCEEDED') LIMIT 1`, [requirementId])).rowCount;
  if (activeRefund) throw conflict("A guarantee refund is already pending or completed");
  const payments = (await client.query<{ id: string; amountCents: string; observedAmountCents: string | null }>(
    `SELECT id,amount_cents::text AS "amountCents",observed_amount_cents::text AS "observedAmountCents"
       FROM zzsh_order.owner_guarantee_payment
      WHERE requirement_id=$1 AND status='CONFIRMED' AND provider_request_state='CONFIRMED' AND finance_event_id IS NOT NULL AND ledger_entry_ref IS NOT NULL
      ORDER BY created_at DESC FOR UPDATE`,
    [requirementId],
  )).rows;
  if (payments.length !== 1 || BigInt(payments[0]!.observedAmountCents ?? payments[0]!.amountCents) < BigInt(requirement.requiredCents)) throw conflict("Guarantee funds are not fully covered or reconciled");
  const obligation = await input.obligationReader(input.userId, client);
  if (obligation !== "NONE") throw conflict(obligation === "UNKNOWN" ? "Guarantee refund responsibility is unknown" : "Unprocessed responsibility prevents guarantee release");
  const refundId = `guarantee_refund_${randomUUID().replaceAll("-", "")}`;
  const amountCents = payments[0]!.observedAmountCents ?? payments[0]!.amountCents;
  await client.query(`INSERT INTO zzsh_order.owner_guarantee_refund(id,requirement_id,payment_id,owner_user_id,request_key,request_fingerprint,amount_cents,status,provider,provider_request_state,release_policy_state) VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED','HUIJU','NOT_AUTHORIZED','OWNER_DECISION_REQUIRED')`, [refundId, requirementId, payments[0]!.id, input.userId, input.requestKey, input.requestFingerprint, amountCents]);
  await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUND_REQUESTED',updated_at=clock_timestamp() WHERE id=$1`, [requirementId]);
  return { refundId, requirementId, paymentId: payments[0]!.id, amountCents, status: "REQUESTED", releasePolicyState: "OWNER_DECISION_REQUIRED", provider: "HUIJU", providerAction: "NOT_AUTHORIZED", duplicate: false };
}

type GuaranteeLedgerKind = "GUARANTEE_CAPTURE" | "GUARANTEE_REFUND";

export async function appendGuaranteeLedger(client: PoolClient, input: { kind: GuaranteeLedgerKind; sourceId: string; requirementId: string; ownerUserId: string; amountCents: string; sourceDigest: string }): Promise<{ financeEventId: string; ledgerEntryRef: string; rootId: string }> {
  if (!/^[1-9]\d{0,23}$/.test(input.amountCents) || !/^[0-9a-f]{64}$/.test(input.sourceDigest)) throw invalid("Guarantee ledger evidence is invalid");
  const rootId = `guarantee_root_${input.sourceId}`;
  const eventId = `guarantee_event_${input.sourceId}_${input.kind === "GUARANTEE_CAPTURE" ? "capture" : "refund"}`;
  const lineOneId = `guarantee_line_${input.sourceId}_${input.kind === "GUARANTEE_CAPTURE" ? "capture" : "refund"}_1`;
  const lineTwoId = `guarantee_line_${input.sourceId}_${input.kind === "GUARANTEE_CAPTURE" ? "capture" : "refund"}_2`;
  const details = { guaranteeId: input.sourceId, requirementId: input.requirementId, economicRootId: rootId, sourceDigest: input.sourceDigest };
  await client.query(
    `INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
     VALUES($1,NULL,'NATIVE_GUARANTEE','NATIVE','zzsh-credit-guarantee',$2,$3,$4,'OWNER','credit-guarantee-v1',$5)
     ON CONFLICT(id) DO NOTHING`,
    [rootId, input.kind === "GUARANTEE_CAPTURE" ? "owner_guarantee_payment" : "owner_guarantee_refund", input.sourceId, input.ownerUserId, input.sourceDigest],
  );
  const root = (await client.query<{ sourceEntity: string; sourceId: string; subjectUserId: string; sourceDigest: string }>(`SELECT source_entity AS "sourceEntity",source_id AS "sourceId",subject_user_id AS "subjectUserId",source_digest AS "sourceDigest" FROM zzsh_order.finance_economic_root WHERE id=$1`, [rootId])).rows[0];
  if (!root || root.sourceId !== input.sourceId || root.subjectUserId !== input.ownerUserId || root.sourceDigest !== input.sourceDigest || root.sourceEntity !== (input.kind === "GUARANTEE_CAPTURE" ? "owner_guarantee_payment" : "owner_guarantee_refund")) throw conflict("Guarantee economic root differs from the original receipt");
  await client.query(
    `INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
     VALUES($1,$2,$3,$4,0) ON CONFLICT(economic_root_id,kind) DO NOTHING`,
    [eventId, rootId, input.kind, input.ownerUserId],
  );
  const event = (await client.query<{ kind: string; subjectUserId: string; economicRootId: string }>(`SELECT kind,subject_user_id AS "subjectUserId",economic_root_id AS "economicRootId" FROM zzsh_order.finance_event WHERE id=$1`, [eventId])).rows[0];
  if (!event || event.kind !== input.kind || event.subjectUserId !== input.ownerUserId || event.economicRootId !== rootId) throw conflict("Guarantee finance event differs from the original receipt");
  const heldDebit = input.kind === "GUARANTEE_REFUND" ? input.amountCents : "0";
  const heldCredit = input.kind === "GUARANTEE_CAPTURE" ? input.amountCents : "0";
  const cashDebit = input.kind === "GUARANTEE_CAPTURE" ? input.amountCents : "0";
  const cashCredit = input.kind === "GUARANTEE_REFUND" ? input.amountCents : "0";
  const existing = (await client.query<{ id: string; lineNo: number; accountCode: string; debitCents: string; creditCents: string; counterpartyUserId: string | null; details: unknown }>(`SELECT id,line_no AS "lineNo",account_code AS "accountCode",debit_cents::text AS "debitCents",credit_cents::text AS "creditCents",counterparty_user_id AS "counterpartyUserId",details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`, [eventId])).rows;
  if (existing.length === 0) {
    await client.query(
      `INSERT INTO zzsh_order.settlement_ledger_entry(id,posting_id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
       VALUES($1,NULL,$2,1,'GUARANTEE_CASH',$3,$4,NULL,NULL,$5::jsonb),($6,NULL,$2,2,'GUARANTEE_HELD',$7,$8,$9,NULL,$5::jsonb)`,
      [lineOneId, eventId, cashDebit, cashCredit, JSON.stringify(details), lineTwoId, heldDebit, heldCredit, input.ownerUserId],
    );
  } else {
    if (existing.length !== 2) throw conflict("Guarantee ledger batch is incomplete");
    const expected = [
      { id: lineOneId, lineNo: 1, accountCode: "GUARANTEE_CASH", debitCents: cashDebit, creditCents: cashCredit, counterpartyUserId: null },
      { id: lineTwoId, lineNo: 2, accountCode: "GUARANTEE_HELD", debitCents: heldDebit, creditCents: heldCredit, counterpartyUserId: input.ownerUserId },
    ];
    for (const target of expected) {
      const row = existing.find((entry) => entry.lineNo === target.lineNo);
      if (!row || row.id !== target.id || row.accountCode !== target.accountCode || row.debitCents !== target.debitCents || row.creditCents !== target.creditCents || row.counterpartyUserId !== target.counterpartyUserId || canonicalize(row.details) !== canonicalize(details)) throw conflict("Existing guarantee ledger lines differ from the original receipt");
    }
  }
  return { financeEventId: eventId, ledgerEntryRef: lineOneId, rootId };
}

export function resultReceipt(input: unknown): { value: Record<string, unknown>; digest: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Provider receipt is required");
  const value = input as Record<string, unknown>;
  return { value, digest: hash(value) };
}

export async function recordGuaranteeObservation(client: PoolClient, input: { paymentId?: string; refundId?: string; state: string; amountCents: string | null; providerReference: string | null; receipt: Record<string, unknown>; digest: string }): Promise<boolean> {
  const id = `guarantee_recon_${(input.paymentId ?? input.refundId)!}_${input.digest.slice(0, 24)}`;
  const inserted = await client.query(
    `INSERT INTO zzsh_order.owner_guarantee_reconciliation(id,payment_id,refund_id,observed_state,observed_amount_cents,provider_reference,canonical_payload,payload_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING`,
    [id, input.paymentId ?? null, input.refundId ?? null, input.state, input.amountCents, input.providerReference, JSON.stringify(input.receipt), input.digest],
  );
  return inserted.rowCount === 1;
}

/** Match delisting's user → account → requirement → transaction lock order for channel adapters. */
export async function lockGuaranteeSubject(client: PoolClient, kind: "payment" | "refund", id: string) {
  const subject = (await client.query<{ accountId: string; requirementId: string; ownerUserId: string }>(
    `SELECT r.account_id AS "accountId",r.id AS "requirementId",p.owner_user_id AS "ownerUserId"
       FROM zzsh_order.owner_guarantee_${kind} p JOIN zzsh_order.owner_guarantee_requirement r
         ON r.id=p.requirement_id AND r.owner_user_id=p.owner_user_id WHERE p.id=$1`, [id],
  )).rows[0];
  if (!subject) throw notFound();
  if (!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR KEY SHARE`, [subject.ownerUserId])).rowCount) throw notFound();
  const account = (await client.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM zzsh_supply.rental_account WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
    [subject.accountId, subject.ownerUserId],
  )).rows[0];
  if (!account || !(await client.query(`SELECT id FROM zzsh_order.owner_guarantee_requirement
      WHERE id=$1 AND account_id=$2 AND owner_user_id=$3 FOR UPDATE`,
    [subject.requirementId, subject.accountId, subject.ownerUserId])).rowCount) throw conflict("Guarantee subject is unavailable");
  return { ...subject, lifecycle: account.lifecycle };
}

export async function safelyEnqueueAutomaticGuaranteeRefund(client: PoolClient, subject: { accountId: string; ownerUserId: string; requestId: string }, reason: "ACCOUNT_DELISTED" | "ORDER_COMPLETED"): Promise<DelistedGuaranteeRefund> {
  await client.query("SAVEPOINT guarantee_auto_refund");
  try {
    const result = await enqueueAutomaticGuaranteeRefund(client, subject, reason);
    await client.query("RELEASE SAVEPOINT guarantee_auto_refund");
    return result;
  } catch (error) {
    // A failed follow-up must not roll back the captured payment itself.
    await client.query("ROLLBACK TO SAVEPOINT guarantee_auto_refund");
    await client.query("RELEASE SAVEPOINT guarantee_auto_refund");
    await client.query("SAVEPOINT guarantee_auto_refund_review");
    let marked = false;
    try {
      marked = ((await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='RESTRICTED',updated_at=clock_timestamp()
        WHERE account_id=$1 AND owner_user_id=$2 AND status IN ('OPEN','COVERED')`,
      [subject.accountId, subject.ownerUserId])).rowCount ?? 0) > 0;
      await client.query("RELEASE SAVEPOINT guarantee_auto_refund_review");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT guarantee_auto_refund_review");
      await client.query("RELEASE SAVEPOINT guarantee_auto_refund_review");
    }
    const code = (error as { code?: unknown })?.code;
    console.error(JSON.stringify({ event: "guarantee_auto_refund_unavailable", accountId: subject.accountId, requestId: subject.requestId, reviewMarked: marked,
      errorCode: typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN" }));
    return { state: "REVIEW_REQUIRED", refunds: [], reason: marked ? "AUTO_REFUND_UNAVAILABLE" : "AUTO_REFUND_MARKER_UNAVAILABLE" };
  }
}

export function safelyEnqueueDelistedGuaranteeRefund(client: PoolClient, subject: { accountId: string; ownerUserId: string; requestId: string }) {
  return safelyEnqueueAutomaticGuaranteeRefund(client, subject, "ACCOUNT_DELISTED");
}

export function safelyEnqueueCompletedGuaranteeRefund(client: PoolClient, subject: { accountId: string; ownerUserId: string; requestId: string }) {
  return safelyEnqueueAutomaticGuaranteeRefund(client, subject, "ORDER_COMPLETED");
}

export type GuaranteeRefundOutcome = "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
export async function recordGuaranteeRefundResult(client: PoolClient, input: { refundId: string; outcome: GuaranteeRefundOutcome; providerRefundId?: string; refundedAmountCents?: string; receipt: unknown }): Promise<Record<string, unknown>> {
  const refundId = id(input.refundId, "refundId");
  if (!["PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(input.outcome)) throw invalid("Refund outcome is invalid");
  const receipt = resultReceipt(input.receipt);
  const subject = await lockGuaranteeSubject(client, "refund", refundId);
  const row = (await client.query<{ id: string; requirementId: string; ownerUserId: string; amountCents: string; status: string; releasePolicyState: string; sourceDigest: string | null; providerRefundId: string | null; financeEventId: string | null; ledgerEntryRef: string | null }>(
    `SELECT f.id,f.requirement_id AS "requirementId",f.owner_user_id AS "ownerUserId",f.amount_cents::text AS "amountCents",f.status,f.release_policy_state AS "releasePolicyState",f.source_digest AS "sourceDigest",f.provider_refund_id AS "providerRefundId",f.finance_event_id AS "financeEventId",f.ledger_entry_ref AS "ledgerEntryRef"
       FROM zzsh_order.owner_guarantee_refund f WHERE f.id=$1 FOR UPDATE`, [refundId],
  )).rows[0];
  if (!row || row.requirementId !== subject.requirementId || row.ownerUserId !== subject.ownerUserId) throw notFound();
  const amount = input.refundedAmountCents ?? null;
  if (input.outcome === "SUCCEEDED" && (!input.providerRefundId || !ID.test(input.providerRefundId) || amount !== row.amountCents)) throw invalid("Successful refund receipt is invalid");
  const observationReceipt = { ...receipt.value, outcome: input.outcome, amountCents: amount, providerRefundId: input.providerRefundId ?? null };
  const observationDigest = hash(observationReceipt);
  if (row.status === "SUCCEEDED" && (input.outcome !== "SUCCEEDED" || row.providerRefundId !== input.providerRefundId || row.sourceDigest !== observationDigest)) throw conflict("Successful refund receipt differs from the original transaction");
  const observationInserted = await recordGuaranteeObservation(client, { refundId, state: input.outcome, amountCents: amount, providerReference: input.providerRefundId ?? null, receipt: observationReceipt, digest: observationDigest });
  if (!observationInserted && (input.outcome !== "SUCCEEDED" || row.financeEventId || row.ledgerEntryRef)) return { refundId, status: row.status, duplicate: true, providerAction: "LOCAL_CONTROLLED" };
  if (row.status === "SUCCEEDED" && input.outcome !== "SUCCEEDED") throw conflict("Successful refund cannot move backwards");
  if (input.outcome === "SUCCEEDED" && !["APPROVED", "AUTO_APPROVED"].includes(row.releasePolicyState)) throw conflict("Guarantee release policy is not approved");
  const providerState = input.outcome === "SUCCEEDED" ? "SUCCEEDED" : input.outcome === "UNKNOWN" ? "UNKNOWN" : input.outcome === "FAILED" ? "FAILED" : "SUBMITTED";
  await client.query(`UPDATE zzsh_order.owner_guarantee_refund SET status=$2,provider_request_state=$3,provider_refund_id=COALESCE($4,provider_refund_id),original_receipt=$5::jsonb,source_digest=CASE WHEN $2='SUCCEEDED' THEN $6 ELSE source_digest END,updated_at=clock_timestamp() WHERE id=$1`, [refundId, input.outcome, providerState, input.providerRefundId ?? null, JSON.stringify(observationReceipt), observationDigest]);
  let ledger: { financeEventId: string; ledgerEntryRef: string; rootId: string } | null = null;
  if (input.outcome === "SUCCEEDED") {
    ledger = await appendGuaranteeLedger(client, { kind: "GUARANTEE_REFUND", sourceId: refundId, requirementId: row.requirementId, ownerUserId: row.ownerUserId, amountCents: amount!, sourceDigest: observationDigest });
    await client.query(`UPDATE zzsh_order.owner_guarantee_refund SET finance_event_id=$2,ledger_entry_ref=$3,source_digest=$4,updated_at=clock_timestamp() WHERE id=$1`, [refundId, ledger.financeEventId, ledger.ledgerEntryRef, observationDigest]);
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUNDED',updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId]);
  } else if (input.outcome === "FAILED") {
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId, ["DELISTED", "ARCHIVED"].includes(subject.lifecycle) ? "RESTRICTED" : "COVERED"]);
  } else {
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUND_PROCESSING',updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId]);
  }
  return { refundId, requirementId: row.requirementId, status: input.outcome, providerRefundId: input.providerRefundId ?? null, financeEventId: ledger?.financeEventId ?? null, ledgerEntryRef: ledger?.ledgerEntryRef ?? null, duplicate: false, providerAction: "LOCAL_CONTROLLED" };
}

export async function decideGuaranteeRefund(client: PoolClient, input: { refundId: string; actorAdminId: string; decision: "APPROVE" | "REJECT"; reason: string }): Promise<Record<string, unknown>> {
  const refundId = id(input.refundId, "refundId");
  if (!ID.test(input.actorAdminId) || !["APPROVE", "REJECT"].includes(input.decision)) throw invalid("Guarantee release decision is invalid");
  const decisionReason = reason(input.reason, "reason");
  const row = (await client.query<{ status: string; releasePolicyState: string; decisionFingerprint: string | null }>(`SELECT status,release_policy_state AS "releasePolicyState",release_decision_fingerprint AS "decisionFingerprint" FROM zzsh_order.owner_guarantee_refund WHERE id=$1 FOR UPDATE`, [refundId])).rows[0];
  if (!row) throw notFound();
  const fingerprint = hash([input.decision, decisionReason]);
  if (row.releasePolicyState !== "OWNER_DECISION_REQUIRED") {
    if (row.decisionFingerprint !== fingerprint) throw conflict("Guarantee release decision already differs");
    return { refundId, releasePolicyState: row.releasePolicyState, duplicate: true };
  }
  await client.query(`UPDATE zzsh_order.owner_guarantee_refund SET release_policy_state=$2,release_decision_reason=$3,release_decision_fingerprint=$4,release_decided_by=$5,release_decided_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [refundId, input.decision === "APPROVE" ? "APPROVED" : "REJECTED", decisionReason, fingerprint, input.actorAdminId]);
  return { refundId, releasePolicyState: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", duplicate: false };
}
