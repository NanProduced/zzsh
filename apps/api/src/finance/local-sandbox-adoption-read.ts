// Restored original facts are read-only and never become payment/worker capabilities.
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { canonicalize } from "../supply/content-hash";
import { invalid, notFound } from "../supply/supply-util";
import { assertLocalFinancialSandboxResource, assertSandboxOriginalResource, type LocalFinancialSandbox } from "./local-financial-sandbox-resource";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, CENTS = /^(0|[1-9][0-9]{0,23})$/, SHA = /^[a-f0-9]{64}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Restored original fact chain unavailable");
const unknown = () => ({ scope: "LOCAL_CONTROLLED" as const, adoption: "ADOPTED_READ_ONLY" as const, knowledge: "UNKNOWN" as const,
  receipt: null, mayReapply: false as const, bankArrival: "UNKNOWN" as const });
async function originalRead<T>(pool: Pool, actor: UserContext, sandbox: LocalFinancialSandbox, read: (c: PoolClient) => Promise<T>) {
  return withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SELECT set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true),set_config('max_parallel_workers_per_gather','0',true)");
    await assertLocalFinancialSandboxResource(c, sandbox, "READ_ORIGINAL"); await assertUserContextInTransaction(c, actor, "READ");
    return read(c);
  });
}

/** One original order only; no declaration/admission INSERT and no verifiedPaymentFact is returned. */
export async function readAdoptedLocalPayment(pool: Pool, actor: UserContext, orderId: string, sandbox: LocalFinancialSandbox) {
  if (typeof orderId !== "string" || !ID.test(orderId)) throw invalid();
  return originalRead(pool, actor, sandbox, async c => {
    const owner = (await c.query("SELECT id FROM zzsh_order.rental_order WHERE id=$1 AND renter_user_id=$2", [orderId, actor.userId])).rows[0];
    if (!owner) throw notFound();
    const originals = (await c.query(`SELECT d.id,d.mode,d.resource_oid::text,d.app_id,d.merchant_scope_id,d.admission_id,d.admission_revision::text,
      d.merchant_order_no,d.provider_transaction_id,d.canonical_payment,d.payment_digest,d.approval_digest,
      a.mode AS admission_mode,a.resource_name,a.resource_marker,a.resource_oid::text AS admission_resource_oid,
      a.approval_digest AS admission_digest,a.revision::text AS current_admission_revision
      FROM zzsh_order.controlled_payment_declaration d JOIN zzsh_order.distribution_order_admission a ON a.id=d.admission_id AND a.order_id=d.order_id
      WHERE d.order_id=$1 ORDER BY d.id LIMIT 2`, [orderId])).rows;
    if (!originals.length) return unknown();
    if (originals.length !== 1) throw unavailable();
    const original = originals[0]!; assertSandboxOriginalResource(sandbox, original.resource_oid);
    assertSandboxOriginalResource(sandbox, original.admission_resource_oid);
    if (original.mode !== "LOCAL_CONTROLLED_DECLARED_PAYMENT" || original.admission_mode !== "LOCAL_CONTROLLED"
      || original.resource_name !== "zzsh_test_regression" || original.resource_marker !== "zzsh:regression-test:v1"
      || original.approval_digest !== original.admission_digest || original.admission_revision !== original.current_admission_revision
      || typeof original.canonical_payment !== "string" || !SHA.test(original.payment_digest) || sha(original.canonical_payment) !== original.payment_digest) throw unavailable();
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(original.canonical_payment);
      const keys = ["orderId", "merchantOrderNo", "providerTransactionId", "amountCents", "currency", "providerPaidAt", "requestId"];
      if (!doc || Array.isArray(doc) || Object.keys(doc).sort().join(",") !== keys.sort().join(",") || canonicalize(doc) !== original.canonical_payment
        || keys.some(key => typeof doc[key] !== "string") || doc.orderId !== orderId || doc.merchantOrderNo !== original.merchant_order_no
        || doc.providerTransactionId !== original.provider_transaction_id || doc.currency !== "CNY" || !CENTS.test(doc.amountCents as string)) throw Error();
    } catch { throw unavailable(); }
    const rows = (await c.query(`SELECT p.id,p.disposition,p.reason_code,p.order_id,p.merchant_scope_id,p.provider_transaction_id,p.merchant_order_no,
      p.amount_cents::text,p.currency,p.request_id,to_char(p.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS provider_paid_at,
      to_char(p.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at,
      o.paid_confirmation_id,(EXISTS(SELECT 1 FROM zzsh_iam.audit_event e WHERE e.action='order.payment.confirmed'
        AND e.object_type='rental_order' AND e.object_id=o.id AND e.outcome='SUCCESS' AND e.details->>'confirmationId'=p.id
        AND e.details->>'disposition'=p.disposition)) AS original_audit_complete,
      EXISTS(SELECT 1 FROM zzsh_order.im_order_group g WHERE g.order_id=o.id AND g.payment_confirmation_id=p.id AND g.app_id=$4) AS original_group_complete
      FROM zzsh_order.payment_confirmation p JOIN zzsh_order.rental_order o ON o.id=p.order_id
      WHERE p.source='CONTROLLED' AND p.order_id=$1 AND p.merchant_scope_id=$2 AND p.provider_transaction_id=$3 LIMIT 2`,
    [orderId, original.merchant_scope_id, original.provider_transaction_id, original.app_id])).rows;
    if (!rows.length) return unknown();
    if (rows.length !== 1) throw unavailable();
    const row = rows[0]!;
    if (row.order_id !== doc.orderId || row.merchant_order_no !== doc.merchantOrderNo || row.amount_cents !== doc.amountCents
      || row.currency !== doc.currency || row.provider_paid_at !== doc.providerPaidAt || row.request_id !== doc.requestId || row.original_audit_complete !== true
      || !["APPLIED", "REVIEW_REQUIRED"].includes(row.disposition)
      || row.disposition === "APPLIED" && (row.paid_confirmation_id !== row.id || row.original_group_complete !== true)) throw unavailable();
    return { scope: "LOCAL_CONTROLLED" as const, adoption: "ADOPTED_READ_ONLY" as const, knowledge: "KNOWN" as const,
      receipt: { orderId, declarationId: original.id, confirmationId: row.id, disposition: row.disposition as "APPLIED" | "REVIEW_REQUIRED",
        reasonCode: row.reason_code, amountCents: row.amount_cents, currency: "CNY" as const, acceptedAt: row.accepted_at },
      mayReapply: false as const, bankArrival: "UNKNOWN" as const };
  });
}

/** Recovery of the subject's exact original reserve key; cached response JSON alone cannot prove terminal money. */
export async function readAdoptedLocalWithdrawalReceipt(pool: Pool, actor: UserContext, keyValue: unknown, sandbox: LocalFinancialSandbox) {
  const key = validateIdempotencyKey(keyValue);
  return originalRead(pool, actor, sandbox, async c => {
    const accepted = (await c.query(`SELECT response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,
      [JSON.stringify(["user", actor.userId, "controlled.withdrawal.reserve", null]), key])).rows[0];
    if (!accepted) return unknown();
    const intentId = accepted.body?.intent?.id;
    if (typeof intentId !== "string" || !ID.test(intentId)) throw unavailable();
    const row = (await c.query(`SELECT i.id,i.user_id,i.state,i.operation_version::text,i.funds_disposition,i.destination_id,i.policy_version,
      i.gross_cents::text,i.net_cents::text,i.fee_cents::text,i.terminal,i.payout_key,i.input_digest,i.sandbox_registration_ref,
      to_char(i.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS accepted_at,
      a.resource_oid::text,a.resource_name,a.resource_marker,a.sandbox_registration_ref AS admission_registration,
      d.sandbox_registration_ref AS destination_registration,
      (r.id IS NOT NULL AND r.source_kind='LOCAL_CONTROLLED_WITHDRAWAL' AND r.source_type='NATIVE'
        AND r.source_system='zzsh-local-controlled' AND r.source_entity='withdrawal_intent' AND r.source_id=i.id
        AND r.subject_user_id=i.user_id AND r.policy_version=i.policy_version AND r.source_digest=i.input_digest
        AND (SELECT count(*) FILTER(WHERE kind='RESERVE') FROM zzsh_order.finance_event WHERE economic_root_id=r.id)=1
        AND (SELECT count(*) FILTER(WHERE kind='PAYOUT') FROM zzsh_order.finance_event WHERE economic_root_id=r.id)=CASE WHEN i.funds_disposition='PAYOUT_POSTED' THEN 1 ELSE 0 END
        AND (SELECT count(*) FILTER(WHERE kind='RELEASE') FROM zzsh_order.finance_event WHERE economic_root_id=r.id)=CASE WHEN i.funds_disposition='RELEASE_POSTED' THEN 1 ELSE 0 END
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_event e WHERE e.economic_root_id=r.id
          AND (e.subject_user_id<>i.user_id OR e.kind NOT IN('RESERVE','PAYOUT','RELEASE')
            OR (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)<>(SELECT count(*) FROM zzsh_order.withdrawal_expected_lines(e.id))
            OR EXISTS((SELECT line_no,account_code,debit_cents,credit_cents,counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=e.id)
              EXCEPT(SELECT * FROM zzsh_order.withdrawal_expected_lines(e.id)))
            OR EXISTS((SELECT * FROM zzsh_order.withdrawal_expected_lines(e.id))
              EXCEPT(SELECT line_no,account_code,debit_cents,credit_cents,counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=e.id))))) AS money_complete,
      EXISTS(SELECT 1 FROM zzsh_order.controlled_payout_operation op JOIN zzsh_order.withdrawal_provider_fact f ON f.intent_id=op.intent_id AND f.payout_key=op.payout_key
        WHERE op.intent_id=i.id AND op.payout_key=i.payout_key AND op.id=i.terminal->>'reference'
          AND op.final_evidence_digest=encode(sha256(convert_to(op.final_evidence_canonical,'UTF8')),'hex')
          AND op.final_evidence_digest=i.terminal->>'evidenceDigest' AND f.evidence_digest=op.final_evidence_digest
          AND f.evidence_canonical=op.final_evidence_canonical AND op.final_evidence_canonical::jsonb->>'outcome'=i.terminal->>'state'
          AND op.final_evidence_canonical::jsonb->>'intentId'=i.id AND op.final_evidence_canonical::jsonb->>'payoutKey'=i.payout_key) AS provider_complete
      FROM zzsh_order.withdrawal_intent i JOIN zzsh_order.withdrawal_admission a ON a.id=i.admission_id AND a.user_id=i.user_id
      JOIN zzsh_order.withdrawal_destination d ON d.id=i.destination_id AND d.admission_id=a.id AND d.user_id=i.user_id
      LEFT JOIN zzsh_order.finance_economic_root r ON r.id=i.economic_root_id
      WHERE i.id=$1 AND i.user_id=$2`, [intentId, actor.userId])).rows[0];
    if (!row) return unknown();
    assertSandboxOriginalResource(sandbox, row.resource_oid);
    if (row.resource_name !== "zzsh_test_regression" || row.resource_marker !== "zzsh:regression-test:v1"
      || row.sandbox_registration_ref !== null || row.admission_registration !== null || row.destination_registration !== null
      || row.user_id !== actor.userId || row.id !== intentId || ![row.gross_cents, row.net_cents, row.fee_cents].every(value => typeof value === "string" && CENTS.test(value))
      || BigInt(row.gross_cents) !== BigInt(row.net_cents) + BigInt(row.fee_cents)) throw unavailable();
    const originalIntent = accepted.body.intent;
    if (originalIntent.userId !== actor.userId || originalIntent.scope !== "LOCAL_CONTROLLED" || originalIntent.amountCents !== row.gross_cents
      || originalIntent.netCents !== row.net_cents || originalIntent.feeCents !== row.fee_cents || originalIntent.destinationId !== row.destination_id
      || originalIntent.policyVersion !== row.policy_version || originalIntent.acceptedAt !== row.accepted_at
      || !["RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"].includes(row.state)
      || !["RESERVED", "PAYOUT_POSTED", "RELEASE_POSTED"].includes(row.funds_disposition)) throw unavailable();
    const terminal = ["SUCCEEDED", "FAILED"].includes(row.state);
    if (row.money_complete !== true || terminal && (row.provider_complete !== true || row.terminal?.state !== row.state)) return unknown();
    if (row.state === "SUCCEEDED" && row.funds_disposition !== "PAYOUT_POSTED" || row.state === "FAILED" && row.funds_disposition !== "RELEASE_POSTED"
      || !terminal && row.state !== "RECONCILIATION_REQUIRED" && (row.funds_disposition !== "RESERVED" || row.terminal !== null)) return unknown();
    return { scope: "LOCAL_CONTROLLED" as const, adoption: "ADOPTED_READ_ONLY" as const, knowledge: "KNOWN" as const,
      receipt: { intent: { id: row.id, scope: "LOCAL_CONTROLLED" as const, userId: actor.userId, state: row.state,
        operationVersion: row.operation_version, fundsDisposition: row.funds_disposition, amountCents: row.gross_cents,
        netCents: row.net_cents, feeCents: row.fee_cents, destinationId: row.destination_id, policyVersion: row.policy_version,
        acceptedAt: row.accepted_at, evidenceLevel: "LOCAL_CONTROLLED" as const,
        terminal: terminal ? { state: row.terminal.state, reference: row.terminal.reference } : null } },
      terminalKnowledge: terminal ? "KNOWN" as const : "UNKNOWN" as const, mayReapply: false as const, bankArrival: "UNKNOWN" as const };
  });
}
