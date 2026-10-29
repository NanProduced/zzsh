import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { assertJoinpayRefundTerminalFact, type NativeRefundTerminalFact } from "../order/joinpay-refund-source";
import { verifyPrestartRefundLiability } from "./prestart-refund-liability";
import type { PrestartPaymentBasis } from "../order/prestart-termination";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const SHA = /^[a-f0-9]{64}$/;
const cents = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)
  && BigInt(value) <= 9999999999999999n;
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const conflict = (message: string) => new SecurityApiError(409, "CONFLICT", message);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** 纯账务计划没有准入能力；虚构输入只能验证分录守恒，不能产生退款事实。 */
export function planNativeRentalRefundJournal(input: {
  intentId: string; postingId: string | null; basisKind?: "PRESTART_TERMINATION"; paymentConfirmationId: string; renterUserId: string;
  refundOrderNo: string; amountCents: string; factsDigest: string;
}) {
  if (![input.intentId, input.paymentConfirmationId, input.renterUserId, input.refundOrderNo].every(v => typeof v === "string" && ID.test(v))
    || (input.postingId===null?input.basisKind!=="PRESTART_TERMINATION":!ID.test(input.postingId))
    || !cents(input.amountCents) || !SHA.test(input.factsDigest)) throw conflict("Invalid native refund journal basis");
  const key = hash(input.intentId).slice(0, 40);
  const rootId = `native_refund_root_${key}`, eventId = `native_refund_paid_${key}`;
  const details = Object.freeze({ nativeRefundIntentId: input.intentId, postingId: input.postingId,
    paymentConfirmationId: input.paymentConfirmationId, refundOrderNo: input.refundOrderNo, factsDigest: input.factsDigest });
  return Object.freeze({ evidenceLevel: "PLAN_ONLY" as const, rootId, eventId,
    lines: Object.freeze([
      Object.freeze({ id: `${eventId}_1`, line: 1, account: "RENTER_REFUND_PAYABLE" as const,
        debit: input.amountCents, credit: "0", subject: input.renterUserId, details }),
      Object.freeze({ id: `${eventId}_2`, line: 2, account: "PAYOUT_CLEARING" as const,
        debit: "0", credit: input.amountCents, subject: null, details }),
    ]) });
}

type IntentRow = {
  id: string; posting_id: string | null; order_id: string; payment_confirmation_id: string; renter_user_id: string;
  merchant_identity_id: string; original_payment_trx_no: string; original_payment_order_no: string;
  responsibility_version_hash: string; refund_order_no: string; amount_cents: string; currency: string;
  payment_source: string; evidence_level: string; state: string; budget_disposition: string; requires_review: boolean;
  terminal_evidence_id: string | null; terminal_root_id: string | null; terminal_event_id: string | null;
  provider_refund_trx_no: string | null; completed_at: string | null; revision: string;
  basis_kind?: "POSTING" | "REVIEW_CONFIRMATION" | "PRESTART_TERMINATION"; liability_root_id: string | null; liability_event_id: string | null;
};
const columns = `id,posting_id,order_id,payment_confirmation_id,renter_user_id,merchant_identity_id,
  original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,
  amount_cents::text,currency,payment_source,evidence_level,state,budget_disposition,requires_review,
  terminal_evidence_id,terminal_root_id,terminal_event_id,provider_refund_trx_no,completed_at::text,revision::text,
  basis_kind,liability_root_id,liability_event_id`;

function assertBinding(row: IntentRow, fact: NativeRefundTerminalFact) {
  const kind = row.basis_kind ?? "POSTING";
  if (row.id !== fact.intentId || row.posting_id !== fact.postingId || row.order_id !== fact.orderId
    || row.payment_confirmation_id !== fact.paymentConfirmationId || row.renter_user_id !== fact.renterUserId
    || row.merchant_identity_id !== fact.merchantIdentityId || row.original_payment_trx_no !== fact.originalPaymentTrxNo
    || row.original_payment_order_no !== fact.originalPaymentOrderNo || row.responsibility_version_hash !== fact.responsibilityVersionHash
    || row.refund_order_no !== fact.refundOrderNo || row.amount_cents !== fact.amountCents || row.currency !== "CNY"
    || fact.currency !== "CNY" || row.payment_source !== "JOINPAY" || row.evidence_level !== "JOINPAY_FORMAL"
    || kind === "POSTING" && (row.posting_id === null || fact.postingId !== row.posting_id)
    || !["POSTING","REVIEW_CONFIRMATION","PRESTART_TERMINATION"].includes(kind)
    || kind !== "POSTING" && (row.posting_id !== null || fact.postingId !== null || fact.basisKind !== kind
      || kind === "REVIEW_CONFIRMATION" && fact.abnormalConfirmationId !== row.payment_confirmation_id || !row.liability_root_id || !row.liability_event_id)) {
    throw unavailable("Native refund terminal binding changed");
  }
}

/** 异常REVIEW原款的应退负债计划：只用于已审核、无posting的异常basis。 */
export function planAbnormalNativeRentalRefundJournal(input: {
  intentId: string; paymentConfirmationId: string; renterUserId: string; refundOrderNo: string;
  amountCents: string; factsDigest: string;
}) {
  if (![input.intentId, input.paymentConfirmationId, input.renterUserId, input.refundOrderNo].every(v => typeof v === "string" && ID.test(v))
    || !cents(input.amountCents) || !SHA.test(input.factsDigest)) throw conflict("Invalid abnormal native refund journal basis");
  const key = hash(input.intentId).slice(0, 40);
  const rootId = `native_refund_root_${key}`, eventId = `native_refund_paid_${key}`;
  const details = Object.freeze({ nativeRefundIntentId: input.intentId, postingId: null,
    paymentConfirmationId: input.paymentConfirmationId, refundOrderNo: input.refundOrderNo, factsDigest: input.factsDigest });
  return Object.freeze({ evidenceLevel: "PLAN_ONLY" as const, rootId, eventId,
    lines: Object.freeze([
      Object.freeze({ id: `${eventId}_1`, line: 1, account: "RENTER_REFUND_PAYABLE" as const,
        debit: input.amountCents, credit: "0", subject: input.renterUserId, details }),
      Object.freeze({ id: `${eventId}_2`, line: 2, account: "JOINPAY_UNALLOCATED_RECEIPT" as const,
        debit: "0", credit: input.amountCents, subject: null, details }),
    ]) });
}

/** 由共同接纳服务在已有事务内调用；本函数不自行提交，也不接纳HTTP事实对象。 */
export async function consumeNativeRentalRefundTerminal(client: PoolClient, input: { fact: unknown; requestId: string }) {
  if (typeof input.requestId !== "string" || !ID.test(input.requestId)) throw conflict("Invalid refund request ID");
  const fact = await assertJoinpayRefundTerminalFact(client, input.fact);
  if (!cents(fact.amountCents) || !SHA.test(fact.factsDigest)
    || !["SUCCEEDED", "FAILED_NO_EXECUTION"].includes(fact.terminal)
    || (fact.terminal === "SUCCEEDED" && (!fact.refundTransactionNo || !fact.completedAt))) {
    throw unavailable("Native refund terminal evidence is incomplete");
  }
  // 所有原路退款调用者共同采用此锁序；不能先取intent锁再反向取得用户锁。
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:refund-funds:v1','JOINPAY',$1::text,$2::text)::text,0))`, [fact.merchantIdentityId, fact.originalPaymentTrxNo]);
  if ((await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [fact.renterUserId])).rowCount !== 1) {
    throw unavailable("Original refund renter is unavailable");
  }
  const revision = (await client.query<{ ledger_revision: string }>(`SELECT ledger_revision::text FROM zzsh_order.wallet_revision
    WHERE user_id=$1`, [fact.renterUserId])).rows[0];
  if (!revision || !/^[0-9]+$/.test(revision.ledger_revision)) throw unavailable("Original posting wallet revision is unavailable");
  const row = (await client.query<IntentRow>(`SELECT ${columns} FROM zzsh_order.channel_refund_intent WHERE id=$1 FOR UPDATE`, [fact.intentId])).rows[0];
  if (!row) throw unavailable("Original refund intent is unavailable");
  assertBinding(row, fact);
  const kind = row.basis_kind ?? "POSTING";
  if (fact.refundTransactionNo) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:refund-transaction:v1','JOINPAY',$1::text,$2::text)::text,0))`, [fact.merchantIdentityId, fact.refundTransactionNo]);
  let basisValid = false;
  if (kind === "PRESTART_TERMINATION") {
    const terms=(await client.query<{id:string;payment_basis:PrestartPaymentBasis}>(`SELECT id,payment_basis FROM zzsh_order.prestart_termination
      WHERE state='APPROVED' AND order_id=$1 AND payment_basis->>'paymentConfirmationId'=$2`,[row.order_id,row.payment_confirmation_id])).rows;
    if(terms.length!==1||terms[0]!.payment_basis.amountCents!==row.amount_cents||terms[0]!.payment_basis.digest!==row.responsibility_version_hash)throw unavailable("Original prestart refund liability is unavailable");
    await verifyPrestartRefundLiability(client,terms[0]!.id,terms[0]!.payment_basis,row.liability_root_id,row.liability_event_id);basisValid=true;
  } else if (kind === "REVIEW_CONFIRMATION") {
    const basis = (await client.query<{ valid: boolean }>(`/* abnormal review refund original immutable liability */ SELECT EXISTS(
      SELECT 1 FROM zzsh_order.channel_refund_intent i
      JOIN zzsh_order.payment_confirmation c ON c.id=i.payment_confirmation_id AND c.order_id=i.order_id
      JOIN zzsh_order.rental_order o ON o.id=i.order_id
      JOIN zzsh_order.payment_channel_transaction a ON a.id=c.joinpay_anchor_id
      JOIN zzsh_order.joinpay_collection_evidence e ON e.id=c.joinpay_evidence_id AND e.request_id=c.joinpay_request_id
      JOIN zzsh_order.finance_economic_root r ON r.id=i.liability_root_id
      JOIN zzsh_order.finance_event ev ON ev.id=i.liability_event_id AND ev.economic_root_id=r.id
      WHERE i.id=$1 AND i.basis_kind='REVIEW_CONFIRMATION' AND i.posting_id IS NULL
        AND c.source='JOINPAY' AND c.disposition='REVIEW_REQUIRED' AND c.reason_code IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
        AND c.currency='CNY' AND c.amount_cents=i.amount_cents AND o.renter_user_id=i.renter_user_id
        AND c.merchant_scope_id=i.merchant_identity_id AND c.provider_transaction_id=i.original_payment_trx_no
        AND c.merchant_order_no=i.original_payment_order_no
        AND a.channel='JOINPAY' AND a.evidence_level='JOINPAY_VERIFIED' AND a.native_order_id=c.order_id
        AND a.request_id=c.joinpay_request_id AND a.merchant_identity_id=c.merchant_scope_id AND a.channel_trx_no=c.provider_transaction_id
        AND e.event='E4' AND e.channel_trx_no=c.provider_transaction_id AND e.schema_outcome='VALID'
        AND e.signature_outcome='MATCH' AND e.binding_outcome='MATCH'
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=c.id)
        AND r.source_kind='NATIVE_ABNORMAL_REFUND' AND r.source_entity='joinpay_abnormal_refund_liability' AND r.source_id=i.payment_confirmation_id
        AND r.subject_user_id=i.renter_user_id AND r.source_digest=i.responsibility_version_hash
        AND ev.kind='REFUND_LIABILITY_RECOGNIZED' AND ev.subject_user_id=i.renter_user_id
        AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id)=2
        AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id AND l.line_no=1
          AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=i.amount_cents AND l.credit_cents=0 AND l.counterparty_user_id IS NULL)
        AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id AND l.line_no=2
          AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=i.amount_cents AND l.counterparty_user_id=i.renter_user_id)
    ) AS valid`, [row.id])).rows[0];
    basisValid = basis?.valid === true;
  } else {
    const basis = (await client.query<{ valid: boolean }>(`/* native refund original immutable liability */ SELECT
      p.order_id=i.order_id AND p.payment_confirmation_id=i.payment_confirmation_id AND p.version_hash=i.responsibility_version_hash
      AND p.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents
      AND p.renter_refund_cents>=i.amount_cents AND p.refund_due_at<=clock_timestamp() AND p.refund_due_at=i.due_at
      AND o.status='COMPLETED' AND o.paid_confirmation_id=c.id AND o.renter_user_id=i.renter_user_id
      AND c.order_id=o.id AND c.source='JOINPAY' AND c.disposition='APPLIED'
      AND c.merchant_scope_id=i.merchant_identity_id AND c.provider_transaction_id=i.original_payment_trx_no
      AND c.merchant_order_no=i.original_payment_order_no
      AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id
        AND l.account_code='RENTER_REFUND_PAYABLE' AND l.credit_cents=p.renter_refund_cents AND l.debit_cents=0
        AND l.counterparty_user_id=i.renter_user_id) AS valid
      FROM zzsh_order.channel_refund_intent i JOIN zzsh_order.settlement_posting p ON p.id=i.posting_id
      JOIN zzsh_order.payment_confirmation c ON c.id=i.payment_confirmation_id JOIN zzsh_order.rental_order o ON o.id=i.order_id
      WHERE i.id=$1`, [row.id])).rows[0];
    basisValid = basis?.valid === true;
  }
  if (!basisValid) throw unavailable(kind === "REVIEW_CONFIRMATION" ? "Original abnormal refund liability is unavailable" : "Original posted native refund liability is unavailable");
  if (row.state === "SUCCEEDED" || row.state === "FAILED") {
    const terminal = row.state === "SUCCEEDED" ? "SUCCEEDED" : "FAILED_NO_EXECUTION";
    if (terminal !== fact.terminal || row.provider_refund_trx_no !== fact.refundTransactionNo) {
      await client.query(`UPDATE zzsh_order.channel_refund_intent SET requires_review=true,revision=revision+1 WHERE id=$1 AND NOT requires_review`, [row.id]);
      await recordAudit(client, { actorType: "system", action: "order.refund.terminal.conflict", objectType: "channel_refund_intent",
        objectId: row.id, outcome: "SUCCESS", requestId: input.requestId, details: { evidenceId: fact.evidenceId, originalTerminal: terminal, budgetDisposition: row.budget_disposition } });
      return { event: "CONFLICT" as const, intentId: row.id, terminal, budgetDisposition: row.budget_disposition, rootId: row.terminal_root_id, eventId: row.terminal_event_id };
    }
    const complete = (await client.query<{ complete: boolean }>(`SELECT zzsh_order.${kind === "REVIEW_CONFIRMATION" ? "native_abnormal_refund_terminal_complete" : kind === "PRESTART_TERMINATION" ? "native_prestart_refund_terminal_complete" : "native_refund_terminal_complete"}($1) AS complete`, [row.id])).rows[0];
    if (complete?.complete !== true) throw unavailable("Original refund terminal batch is incomplete");
    return { event: "REPLAYED" as const, intentId: row.id, terminal, budgetDisposition: row.budget_disposition, rootId: row.terminal_root_id, eventId: row.terminal_event_id };
  }
  if (row.requires_review || row.state === "REVIEW_REQUIRED" || row.budget_disposition !== "ALLOCATED") {
    throw unavailable("Refund requires review and keeps its liability allocation");
  }
  if (!["SUBMITTING", "UNKNOWN", "PROCESSING"].includes(row.state)) throw conflict("Refund terminal is not executable from this state");
  const plan = kind === "REVIEW_CONFIRMATION"
    ? planAbnormalNativeRentalRefundJournal({ intentId: row.id, paymentConfirmationId: row.payment_confirmation_id,
      renterUserId: row.renter_user_id, refundOrderNo: row.refund_order_no, amountCents: row.amount_cents, factsDigest: fact.factsDigest })
    : planNativeRentalRefundJournal({ intentId: row.id, postingId: row.posting_id, ...(kind === "PRESTART_TERMINATION" ? {basisKind:"PRESTART_TERMINATION" as const} : {}), paymentConfirmationId: row.payment_confirmation_id,
      renterUserId: row.renter_user_id, refundOrderNo: row.refund_order_no, amountCents: row.amount_cents, factsDigest: fact.factsDigest });
  const succeeded = fact.terminal === "SUCCEEDED";
  if (succeeded) {
    await client.query(`INSERT INTO zzsh_order.finance_economic_root
      (id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest)
      VALUES($1,NULL,'NATIVE_RENTAL_REFUND','NATIVE','zzsh','channel_refund_intent',$2,$3,'RENTER',$4)`,
    [plan.rootId, row.id, row.renter_user_id, fact.factsDigest]);
    await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
      VALUES($1,$2,'REFUND_PAID',$3,$4)`, [plan.eventId, plan.rootId, row.renter_user_id, revision.ledger_revision]);
    for (const line of plan.lines) await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry
      (id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [line.id, plan.eventId, line.line, line.account, line.debit, line.credit, line.subject, JSON.stringify(line.details)]);
  }
  const updated = await client.query(`UPDATE zzsh_order.channel_refund_intent SET state=$2,budget_disposition=$3,
    terminal_evidence_id=$4,terminal_root_id=$5,terminal_event_id=$6,provider_refund_trx_no=$7,completed_at=$8,revision=revision+1
    WHERE id=$1 AND revision=$9 AND budget_disposition='ALLOCATED' AND NOT requires_review`,
  [row.id, succeeded ? "SUCCEEDED" : "FAILED", succeeded ? "CONSUMED" : "RELEASED", fact.evidenceId,
    succeeded ? plan.rootId : null, succeeded ? plan.eventId : null, fact.refundTransactionNo, fact.completedAt, row.revision]);
  if (updated.rowCount !== 1) throw conflict("Refund changed before terminal consumption");
  await recordAudit(client, { actorType: "system", action: succeeded ? "order.refund.liability.consumed" : "order.refund.allocation.released",
    objectType: "channel_refund_intent", objectId: row.id, outcome: "SUCCESS", requestId: input.requestId,
    details: { evidenceId: fact.evidenceId, postingId: row.posting_id, paymentConfirmationId: row.payment_confirmation_id,
      amountCents: row.amount_cents, currency: "CNY", factsDigest: fact.factsDigest,
      budgetDisposition: succeeded ? "CONSUMED" : "RELEASED", channelArrival: "UNKNOWN" } });
  return { event: succeeded ? "CONSUMED" as const : "RELEASED" as const, intentId: row.id, terminal: fact.terminal,
    budgetDisposition: succeeded ? "CONSUMED" as const : "RELEASED" as const,
    rootId: succeeded ? plan.rootId : null, eventId: succeeded ? plan.eventId : null };
}
