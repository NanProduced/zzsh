import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { hashApprovalPayload } from "../auth/approval-audit";
import { SecurityApiError } from "../auth/security-core";
import type { PrestartPaymentBasis } from "../order/prestart-termination";

const unavailable = () => new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Original prestart refund liability is unavailable");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function prestartLiabilityPlan(terminationId: string, basis: PrestartPaymentBasis) {
  const { digest, ...fields } = basis;
  if (!ID.test(terminationId) || ![fields.orderId,fields.renterUserId,fields.ownerUserId,fields.paymentConfirmationId,
    fields.merchantIdentityId,fields.merchantOrderNo,fields.channelTrxNo].every(v=>typeof v==="string"&&ID.test(v))
    || !["JOINPAY","CONTROLLED"].includes(fields.source) || fields.currency!=="CNY" || typeof fields.amountCents!=="string"
    || !/^[1-9][0-9]{0,15}$/.test(fields.amountCents) || digest!==hashApprovalPayload({schema:"prestart-payment-basis.v1",...fields}).hash) throw unavailable();
  const key=createHash("sha256").update(basis.paymentConfirmationId).digest("hex").slice(0,40);
  return { rootId:`prestart_refund_${key}`,eventId:`prestart_liability_${key}`,terminationId,basis,
    lines:[{account:"CAPTURED_PAYMENT_SOURCE",debit:basis.amountCents,credit:"0",user:null},
      {account:"RENTER_REFUND_PAYABLE",debit:"0",credit:basis.amountCents,user:basis.renterUserId}] as const };
}

/** 不只认关联ID：独立核原根/事件与恰好两条、按原款和本人绑定的分录。 */
export async function verifyPrestartRefundLiability(client: PoolClient, terminationId: string, basis: PrestartPaymentBasis, rootId: string|null, eventId: string|null, duringRecognition = false) {
  const plan=prestartLiabilityPlan(terminationId,basis);
  if(rootId!==plan.rootId||eventId!==plan.eventId) throw unavailable();
  const valid=(await client.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root r
    JOIN zzsh_order.finance_event e ON e.economic_root_id=r.id
    JOIN zzsh_order.prestart_termination t ON t.id=$3 AND t.state='APPROVED' AND t.basis_digest=$5
    JOIN zzsh_order.rental_order o ON o.id=t.order_id AND o.paid_confirmation_id=$7
    JOIN zzsh_order.payment_confirmation c ON c.id=$7 AND c.order_id=o.id AND c.disposition='APPLIED'
    WHERE r.id=$1 AND e.id=$2 AND r.source_kind='NATIVE_PRESTART_REFUND' AND r.source_type='NATIVE'
      AND r.source_system='zzsh' AND r.source_entity='prestart_termination' AND r.source_id=$3
      AND r.subject_user_id=$4 AND r.source_digest=$5 AND e.kind='REFUND_LIABILITY_RECOGNIZED' AND e.subject_user_id=$4
      AND c.amount_cents=$6::numeric AND c.currency='CNY' AND c.source=t.payment_basis->>'source'
      AND c.merchant_scope_id=t.payment_basis->>'merchantIdentityId' AND c.provider_transaction_id=t.payment_basis->>'channelTrxNo'
      AND c.merchant_order_no=t.payment_basis->>'merchantOrderNo' AND o.renter_user_id=$4
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND x.status='CONFIRMED')
      AND ((o.status='CANCELLED' AND o.cancel_reason='PRESTART_TERMINATED' AND t.liability_root_id=r.id AND t.liability_event_id=e.id)
        OR($8::boolean AND o.status='PAID' AND t.approved_xid=pg_current_xact_id_if_assigned()))
      AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=2
      AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id AND l.line_no=1
        AND l.account_code='CAPTURED_PAYMENT_SOURCE' AND l.debit_cents=$6::numeric AND l.credit_cents=0 AND l.counterparty_user_id IS NULL
        AND l.source_payment_confirmation_id=$7 AND l.posting_id IS NULL)
      AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id AND l.line_no=2
        AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=$6::numeric AND l.counterparty_user_id=$4
        AND l.source_payment_confirmation_id IS NULL AND l.posting_id IS NULL)) AS valid`,
    [rootId,eventId,terminationId,basis.renterUserId,basis.digest,basis.amountCents,basis.paymentConfirmationId,duringRecognition])).rows[0]?.valid;
  if(valid!==true)throw unavailable();
  return plan;
}

export async function recognizePrestartRefundLiability(client:PoolClient,terminationId:string,basis:PrestartPaymentBasis,requestId:string){
  const plan=prestartLiabilityPlan(terminationId,basis);
  const old=(await client.query(`SELECT id FROM zzsh_order.finance_economic_root WHERE id=$1`,[plan.rootId])).rows;
  if(old.length){await verifyPrestartRefundLiability(client,terminationId,basis,plan.rootId,plan.eventId);return plan;}
  await client.query(`INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,
    subject_user_id,beneficiary_role,policy_version,source_digest) VALUES($1,NULL,'NATIVE_PRESTART_REFUND','NATIVE','zzsh','prestart_termination',$2,$3,'RENTER','prestart-full-refund.v1',$4)`,
    [plan.rootId,terminationId,basis.renterUserId,basis.digest]);
  // 原款root守卫仅补零版本计数器，不建立钱包来源；共同用户锁已串行化本次账务。
  const revision=(await client.query(`SELECT ledger_revision::text FROM zzsh_order.wallet_revision WHERE user_id=$1`,[basis.renterUserId])).rows[0]?.ledger_revision;
  if(typeof revision!=="string"||!/^[0-9]+$/.test(revision))throw unavailable();
  await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
    VALUES($1,$2,'REFUND_LIABILITY_RECOGNIZED',$3,$4)`,[plan.eventId,plan.rootId,basis.renterUserId,revision]);
  for(const [n,line]of plan.lines.entries())await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry
    (id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[`${plan.eventId}_${n+1}`,plan.eventId,n+1,line.account,line.debit,line.credit,line.user,
    n===0?basis.paymentConfirmationId:null,JSON.stringify({prestartTerminationId:terminationId,basisDigest:basis.digest,paymentConfirmationId:basis.paymentConfirmationId,dataOrigin:basis.source==='JOINPAY'?'JOINPAY_LOCAL_ACCEPTANCE':'LOCAL_CONTROLLED'})]);
  await verifyPrestartRefundLiability(client,terminationId,basis,plan.rootId,plan.eventId,true);
  return plan;
}
