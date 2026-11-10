import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { assertEcsTestDemoResource, demoFinanceScope, readEcsTestDemoRegistration, type DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { readLegacyDutyFundingProof } from "../finance/legacy-duty-funding";
import { legacyDutyBasisFromTrade } from "../finance/legacy-duty-finance";
import { canonicalize } from "../supply/content-hash";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { lockLegacyContinuationOrder } from "./legacy-continuation-evidence";
import { authorizeLegacyFinanceDuty, postLegacyFinanceDuty, type LegacyFinanceDutyAuthority } from "./legacy-finance-duty";
import { readLegacyDutyBasis } from "./legacy-duty-basis";
import { readLockedLegacyRefundSource } from "./legacy-refund-review-source";
import type { LegacyContinuationActor } from "./legacy-continuation-model";

// TODO(正式上线前): 移除旧单测试退款适配，不能把模拟假设用于真实退款。
type Input={dutyId:string;expectedDutyRevision:string;expectedHeadRevision:string;assumption:"SIMULATION_ASSUME_NO_PRIOR_REFUND";reason:string};
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const unavailable=()=>new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","旧单模拟退款记录暂不可核实");

/** Advisory only: the write locks and verifies every source again in its own transaction. */
export async function readDemoLegacyRefundReadiness(client:PoolClient,actor:LegacyContinuationActor,orderId:string,dutyId:string,demo:DemoFinanceResource) {
  const registration=await assertEcsTestDemoResource(client,demo,"READ_ORIGINAL");
  const authority=await authorizeLegacyFinanceDuty(client,actor,orderId,"RENTER_REFUND"),locked=await lockLegacyContinuationOrder(client,orderId);
  const duty=locked.duties.find(item=>item.id===dutyId && item.kind==="RENTER_REFUND");if(!duty)throw notFound();
  const receipt=await readDemoLegacyRefund(client,orderId,dutyId,demo);
  const base={scope:demoFinanceScope(demo),headRevision:locked.head?.revision??null,dutyRevision:duty.revision,receipt,bankArrival:"UNKNOWN" as const};
  const no=(reason:string)=>({...base,canSubmit:false,reason});
  if(receipt)return no("SIMULATION_ALREADY_EXISTS");
  if(!registration.active)return no("SIMULATION_DISABLED");
  if(!locked.head || !(String(locked.head.stage)==="4" || String(locked.head.stage)==="5" && locked.head.command==="SUPPORT_CANCEL"))return no("ORDER_NOT_SETTLED");
  if(duty.status!=="PENDING" || duty.settledBy!==null)return no("DUTY_ALREADY_PROCESSED");
  if(duty.amountCents==="0")return no("NO_REFUND_DUE");
  try {
    const source=await readLockedLegacyRefundSource(client,authority.binding,locked.head,duty);
    if(!source.refundDueAt)return no("REFUND_DUE_UNKNOWN");
    if((await client.query<{due:boolean}>("SELECT $1::timestamptz<=clock_timestamp() AS due",[source.refundDueAt])).rows[0]?.due!==true)return no("REFUND_NOT_DUE");
    if(!/^[1-9][0-9]{0,23}$/.test(source.dutyCents)||!/^[1-9][0-9]{0,23}$/.test(source.paidCents))return no("ORIGINAL_SOURCE_UNAVAILABLE");
    if(BigInt(source.dutyCents)>BigInt(source.paidCents))return no("REFUND_AMOUNT_EXCEEDS_PAYMENT");
    const existing=(await client.query(`SELECT 1 FROM zzsh_order.legacy_refund_case WHERE duty_id=$1 OR original_payment_order_no=$2
      UNION ALL SELECT 1 FROM zzsh_order.ecs_demo_legacy_refund WHERE duty_id=$1 OR payment_order_no=$2 LIMIT 1`,[duty.id,source.paymentOrderNo])).rows[0];
    if(existing)return no("ORIGINAL_REFUND_CONFLICT");
    const adapted=legacyDutyBasisFromTrade(duty,await readLegacyDutyBasis(client,orderId,duty));
    if(adapted.knowledge!=="KNOWN" || (await readLegacyDutyFundingProof(client,duty,adapted.basis)).knowledge!=="KNOWN")return no("LIABILITY_COVERAGE_UNAVAILABLE");
    return {...base,canSubmit:true,reason:null};
  } catch(error) {
    if(error instanceof SecurityApiError && [409,503].includes(error.status))return no("ORIGINAL_SOURCE_UNAVAILABLE");
    throw error;
  }
}

/** Only a due, original old-order responsibility may enter the distinct demo ledger. */
export async function simulateLegacyRefund(client:PoolClient,actor:LegacyContinuationActor,orderId:string,input:Input,
  authority:LegacyFinanceDutyAuthority,demo:DemoFinanceResource) {
  if(actor.realm!=="admin" || input.assumption!=="SIMULATION_ASSUME_NO_PRIOR_REFUND" || typeof input.reason!=="string"
    || [...input.reason.trim()].length<3 || input.reason.length>500)throw invalid("请确认模拟假设并填写操作原因");
  const registration=await assertEcsTestDemoResource(client,demo);
  if(!(await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR SHARE`,[authority.binding.accountId])).rowCount)throw conflict("旧账号资料暂不可核实");
  const locked=await lockLegacyContinuationOrder(client,orderId),duty=locked.duties.find(item=>item.id===input.dutyId);
  if(!duty || !locked.head || locked.head.revision!==input.expectedHeadRevision || duty.revision!==input.expectedDutyRevision)throw conflict("订单结算状态已变化");
  const source=await readLockedLegacyRefundSource(client,authority.binding,locked.head,duty);
  if(!source.refundDueAt || (await client.query<{due:boolean}>("SELECT $1::timestamptz<=clock_timestamp() AS due",[source.refundDueAt])).rows[0]?.due!==true)
    throw conflict("退款尚未到期或到期时间无法核实");
  if(!/^[1-9][0-9]{0,23}$/.test(source.dutyCents) || !/^[1-9][0-9]{0,23}$/.test(source.paidCents)
    || BigInt(source.dutyCents)>BigInt(source.paidCents))throw conflict("原付款或应退金额无法核实");
  const conflictRow=(await client.query(`SELECT 1 FROM zzsh_order.legacy_refund_case WHERE duty_id=$1 OR original_payment_order_no=$2
    UNION ALL SELECT 1 FROM zzsh_order.ecs_demo_legacy_refund WHERE duty_id=$1 OR payment_order_no=$2 LIMIT 1`,[duty.id,source.paymentOrderNo])).rows[0];
  if(conflictRow)throw conflict("原付款已有退款处理记录，请核对原记录");
  const posted=await postLegacyFinanceDuty(client,actor,orderId,"RENTER_REFUND",
    {dutyId:duty.id,expectedRevision:duty.revision,reason:input.reason.trim()},authority);
  const digest=posted.body.reference.digest,id='demo_legacy_refund_'+sha(duty.id).slice(0,40),eventId='demo_legacy_refund_paid_'+sha(duty.id).slice(0,40);
  await client.query(`INSERT INTO zzsh_order.ecs_demo_legacy_refund(id,registration_ref,order_id,duty_id,renter_user_id,payment_record_id,
    payment_order_no,source_digest,duty_fact_digest,amount_cents,paid_cents,event_id,assumption,actor_id,session_id,request_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [id,registration.reference,orderId,duty.id,source.renterUserId,source.paymentRecordId,source.paymentOrderNo,source.sourceDigest,digest,
    source.dutyCents,source.paidCents,eventId,input.assumption,actor.userId,actor.sessionId,actor.requestId,input.reason.trim()]);
  const revision=(await client.query<{revision:string}>(`SELECT ledger_revision::text AS revision FROM zzsh_order.wallet_revision WHERE user_id=$1`,[source.renterUserId])).rows[0]?.revision;
  if(!revision)throw unavailable();
  await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
    SELECT $1,root_id,'DEMO_LEGACY_REFUND_PAID',$2,$3 FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=$4`,[eventId,source.renterUserId,revision,duty.id]);
  const details=JSON.stringify({demoLegacyRefundId:id,dataOrigin:"SIMULATED",orderId,dutyFactDigest:digest});
  await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
    VALUES($1,$3,1,'RENTER_REFUND_PAYABLE',$4,0,$5,$6::jsonb),($2,$3,2,'PAYOUT_CLEARING',0,$4,NULL,$6::jsonb)`,
  [eventId+'_1',eventId+'_2',eventId,source.dutyCents,source.renterUserId,details]);
  await recordAudit(client,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
    action:"demo.legacy.refund.simulated",objectType:"legacy_order_duty",objectId:duty.id,outcome:"SUCCESS",reason:input.reason.trim(),
    details:{operationId:id,assumption:input.assumption,bankArrival:"UNKNOWN"}});
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  return {status:200,body:await readDemoLegacyRefund(client,orderId,duty.id,demo)};
}

/** Only the immutable operation and its balanced original journal qualify as a simulated result. */
export async function readDemoLegacyRefund(client:PoolClient,orderId:string,dutyId:string,demo:DemoFinanceResource) {
  const registration=await assertEcsTestDemoResource(client,demo,"READ_ORIGINAL"),proof=readEcsTestDemoRegistration(demo);
  const rows=(await client.query<any>(`SELECT x.id,x.order_id,x.duty_id,x.renter_user_id,x.amount_cents::text,x.paid_cents::text,x.source_digest,
    x.duty_fact_digest,x.payment_order_no,x.assumption,x.event_id,x.created_xid::text,x.created_at,
    f.facts_digest,f.amount_cents::text AS fact_amount,f.parent_source_digest,f.subject_user_id,f.root_id,f.created_xid::text AS fact_xid,
    e.kind,e.subject_user_id AS event_subject,e.economic_root_id,e.created_xid::text AS event_xid,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('line',l.line_no,'account',l.account_code,'debit',l.debit_cents::text,
      'credit',l.credit_cents::text,'subject',l.counterparty_user_id,'details',l.details) ORDER BY l.line_no)
      FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=x.event_id),'[]'::jsonb) AS lines,
    EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='demo.legacy.refund.simulated' AND a.object_id=x.duty_id
      AND a.actor_type='admin' AND a.actor_id=x.actor_id AND a.session_id=x.session_id AND a.request_id=x.request_id AND a.outcome='SUCCESS'
      AND a.details->>'operationId'=x.id AND a.details->>'assumption'=x.assumption AND a.details->>'bankArrival'='UNKNOWN') AS audited
    FROM zzsh_order.ecs_demo_legacy_refund x JOIN zzsh_order.legacy_duty_finance_fact f ON f.duty_id=x.duty_id
    JOIN zzsh_order.finance_event e ON e.id=x.event_id WHERE x.order_id=$1 AND x.duty_id=$2 AND x.registration_ref=$3 LIMIT 2`,
  [orderId,dutyId,registration.reference])).rows;
  if(!rows.length)return null;if(rows.length!==1)throw unavailable();const r=rows[0];
  const expected={demoLegacyRefundId:r.id,dataOrigin:'SIMULATED',orderId,dutyFactDigest:r.duty_fact_digest};
  const lines=[{line:1,account:'RENTER_REFUND_PAYABLE',debit:r.amount_cents,credit:'0',subject:r.renter_user_id,details:expected},
    {line:2,account:'PAYOUT_CLEARING',debit:'0',credit:r.amount_cents,subject:null,details:expected}];
  if(r.id!=='demo_legacy_refund_'+sha(dutyId).slice(0,40)||r.event_id!=='demo_legacy_refund_paid_'+sha(dutyId).slice(0,40)
    || r.source_digest!==r.parent_source_digest || r.facts_digest!==r.duty_fact_digest || r.amount_cents!==r.fact_amount
    || r.renter_user_id!==r.subject_user_id || r.renter_user_id!==r.event_subject || r.economic_root_id!==r.root_id
    || r.kind!=='DEMO_LEGACY_REFUND_PAID' || r.created_xid!==r.fact_xid || r.created_xid!==r.event_xid || r.audited!==true
    || r.assumption!=='SIMULATION_ASSUME_NO_PRIOR_REFUND' || canonicalize(r.lines)!==canonicalize(lines)
    || !/^[1-9][0-9]{0,23}$/.test(r.amount_cents) || !/^[1-9][0-9]{0,23}$/.test(r.paid_cents)
    || BigInt(r.amount_cents)>BigInt(r.paid_cents) || !proof.digest)throw unavailable();
  return {contractVersion:'demo-legacy-refund.v1' as const,scope:demoFinanceScope(demo),orderId,dutyId,operationId:r.id,
    amountCents:r.amount_cents,paidCents:r.paid_cents,assumption:r.assumption,simulatedAt:new Date(r.created_at).toISOString(),
    state:'SIMULATED' as const,bankArrival:'UNKNOWN' as const};
}
