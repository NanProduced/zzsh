import { createHash,randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { SecurityApiError,recordAudit,withTransaction } from "../auth/security-core";
import { conflict,fingerprintRequest,invalid,notFound } from "../supply/supply-util";
import { verifyPrestartRefundLiability } from "../finance/prestart-refund-liability";
import { FORMAL_REFUND_COLUMNS,lockRefundFunds,assertRefundResource,type FormalRefundRow } from "./channel-refund-store";
import { assertFormalRefundProfile,assertRefundStart,assertRefundBinding,describeRefundProfile,type FormalRefundAdmission,type BoundRefundProfile } from "./joinpay-refund-profile";
import type { PrestartPaymentBasis } from "./prestart-termination";
import type { RefundExecution } from "./joinpay-refund-attempt";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Term={id:string;order_id:string;state:string;payment_basis:PrestartPaymentBasis;basis_digest:string;approved_at:string;liability_root_id:string;liability_event_id:string};
const unavailable=()=>new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Original prestart refund admission unavailable");

/** 只投影持久原责任和退款结果；saved evidence未重新验签，不推断银行到账。 */
export async function readPrestartRefundProgress(client:PoolClient,terminationId:string,b:PrestartPaymentBasis,moneyReadable:boolean){
 const ready=(await client.query(`SELECT to_regprocedure('zzsh_order.native_prestart_refund_terminal_complete(text)') IS NOT NULL
  AND to_regprocedure('zzsh_order.native_prestart_refund_liability_complete(text)') IS NOT NULL AS ready`)).rows[0]?.ready;
 if(ready!==true)return {integration:'NOT_INTEGRATED' as const,intents:null,truncated:false,totals:null,reason:'REFUND_SCHEMA_NOT_DEPLOYED' as const,
  channelRecordsChecked:false as const,bankArrival:'UNKNOWN' as const};
 const rows=(await client.query(`SELECT i.id,i.order_id,i.renter_user_id,i.payment_confirmation_id,i.basis_kind,i.payment_source,i.evidence_level,
   i.merchant_identity_id,i.original_payment_order_no,i.original_payment_trx_no,i.amount_cents::text,i.currency,i.responsibility_version_hash,
   i.refund_order_no,i.state,i.budget_disposition,i.requires_review,i.terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,
   to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
   CASE WHEN i.state IN('SUCCEEDED','FAILED') THEN zzsh_order.native_prestart_refund_terminal_complete(i.id)
     ELSE zzsh_order.native_prestart_refund_liability_complete(i.id) END AS complete,
   EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt a WHERE a.intent_id=i.id AND a.operation='SUBMIT') AS dispatched,
   (SELECT a.details->>'gateReason' FROM zzsh_iam.audit_event a WHERE a.object_type='channel_refund_intent' AND a.object_id=i.id
     AND a.action='order.refund.prestart.first_submit.blocked' AND a.outcome='FAILURE' ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1) AS blocked_reason,
   e.terminal AS saved_terminal,e.refund_transaction_no AS saved_trx,
   to_char(le.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS local_written_off_at,
   to_char(e.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS saved_completed_at,
   to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS saved_at
  FROM zzsh_order.channel_refund_intent i LEFT JOIN zzsh_order.joinpay_refund_evidence e ON e.id=i.terminal_evidence_id AND e.intent_id=i.id
  LEFT JOIN zzsh_order.finance_event le ON le.id=i.terminal_event_id AND le.kind='REFUND_PAID'
  WHERE i.payment_confirmation_id=$1 AND i.basis_kind='PRESTART_TERMINATION'
  ORDER BY i.created_at,i.id COLLATE "C" LIMIT 51`,[b.paymentConfirmationId])).rows;
 let allocated=0n,consumed=0n,released=0n,valid=true;
 const intents=rows.slice(0,50).map(r=>{
  const bound=r.order_id===b.orderId&&r.renter_user_id===b.renterUserId&&r.payment_confirmation_id===b.paymentConfirmationId
   &&r.payment_source==='JOINPAY'&&r.evidence_level==='JOINPAY_FORMAL'&&r.basis_kind==='PRESTART_TERMINATION'
   &&r.merchant_identity_id===b.merchantIdentityId&&r.original_payment_order_no===b.merchantOrderNo&&r.original_payment_trx_no===b.channelTrxNo
   &&r.amount_cents===b.amountCents&&r.currency==='CNY'&&r.responsibility_version_hash===b.digest&&r.complete===true
   &&['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(r.state)
   &&['ALLOCATED','CONSUMED','RELEASED'].includes(r.budget_disposition)&&typeof r.requires_review==='boolean'&&typeof r.dispatched==='boolean'
   &&typeof r.id==='string'&&ID.test(r.id)&&typeof r.refund_order_no==='string'&&/^RF[0-9a-f]{28}$/.test(r.refund_order_no);
  if(!bound)valid=false;
  else if(r.budget_disposition==='CONSUMED'){allocated+=BigInt(b.amountCents);consumed+=BigInt(b.amountCents);}
  else if(r.budget_disposition==='ALLOCATED')allocated+=BigInt(b.amountCents);else released+=BigInt(b.amountCents);
  return {intentId:typeof r.id==='string'&&ID.test(r.id)?r.id:null,refundOrderNo:bound&&moneyReadable?r.refund_order_no:null,
   state:bound?r.state:'CONFLICT',budgetDisposition:bound?r.budget_disposition:null,amountCents:bound&&moneyReadable?r.amount_cents:null,
   requiresReview:!bound||r.requires_review,updatedAt:bound?r.updated_at:null,
   firstSubmit:bound?r.dispatched?'DISPATCHED':'NEVER_DISPATCHED':'UNKNOWN',blockedReason:bound&&r.blocked_reason==='ORIGINAL_ORDER_NO_AMBIGUOUS'?r.blocked_reason:null,
   savedChannelEvidence:bound&&r.saved_terminal&&moneyReadable?{terminal:r.saved_terminal,channelRefundTrxNo:r.saved_trx,
     completedAt:r.saved_completed_at,observedAt:r.saved_at,trust:'SAVED_EVIDENCE_NOT_REVALIDATED' as const}:null,
   terminalEvidenceId:bound&&moneyReadable?r.terminal_evidence_id??null:null,terminalRootId:bound&&moneyReadable?r.terminal_root_id??null:null,
   terminalEventId:bound&&moneyReadable?r.terminal_event_id??null:null,
   localWrittenOffAt:bound&&r.state==='SUCCEEDED'&&r.budget_disposition==='CONSUMED'?r.local_written_off_at??null:null,
   localWriteOff:bound&&r.state==='SUCCEEDED'&&r.budget_disposition==='CONSUMED'?'RECORDED':'NOT_RECORDED',bankArrival:'UNKNOWN' as const};
 });
 const budgetConflict=rows.length<=50&&allocated>BigInt(b.amountCents),complete=valid&&!budgetConflict&&rows.length<=50;
 return {integration:valid&&!budgetConflict?'INTEGRATED' as const:'UNAVAILABLE' as const,intents,truncated:rows.length>50,
  totals:complete&&moneyReadable?{originalCents:b.amountCents,allocatedCents:allocated.toString(),consumedCents:consumed.toString(),
    releasedCents:released.toString(),remainingCents:(BigInt(b.amountCents)-allocated).toString(),totalsComplete:true}:null,
  reason:!valid?'REFUND_BINDING_CONFLICT' as const:budgetConflict?'REFUND_BUDGET_CONFLICT' as const:rows.length>50?'REFUND_LIST_TRUNCATED' as const:b.source==='CONTROLLED'?'LOCAL_CONTROLLED_ONLY' as const:null,
  completedLocallyAt:complete&&consumed===BigInt(b.amountCents)?intents.find(i=>i.localWriteOff==='RECORDED')?.localWrittenOffAt??null:null,
  channelRecordsChecked:false as const,bankArrival:'UNKNOWN' as const};
}

/** 调用方已持有共同资金→原号→用户→intent锁；首派前再次核同原号唯一性。 */
export async function readPrestartRefundGate(client:PoolClient,row:FormalRefundRow){
 const rows=(await client.query<Term>(`SELECT id,order_id,state,payment_basis,basis_digest,approved_at::text,liability_root_id,liability_event_id
  FROM zzsh_order.prestart_termination WHERE state='APPROVED' AND order_id=$1 AND payment_basis->>'paymentConfirmationId'=$2`,[row.order_id,row.payment_confirmation_id])).rows;
 const term=rows[0],b=term?.payment_basis;
 if(rows.length!==1||!b||b.source!=='JOINPAY'||b.amountCents!==row.amount_cents||b.digest!==row.responsibility_version_hash
  ||b.renterUserId!==row.renter_user_id||b.merchantIdentityId!==row.merchant_identity_id||b.merchantOrderNo!==row.original_payment_order_no
  ||b.channelTrxNo!==row.original_payment_trx_no||term.liability_root_id!==row.liability_root_id||term.liability_event_id!==row.liability_event_id)throw unavailable();
 await verifyPrestartRefundLiability(client,term.id,b,row.liability_root_id,row.liability_event_id);
 const count=(await client.query(`SELECT count(DISTINCT provider_transaction_id)::text AS transactions FROM zzsh_order.payment_confirmation
  WHERE source='JOINPAY' AND merchant_scope_id=$1 AND merchant_order_no=$2 AND disposition IN('APPLIED','REVIEW_REQUIRED')`,[b.merchantIdentityId,b.merchantOrderNo])).rows[0]?.transactions;
 if(typeof count!=='string'||!/^\d+$/.test(count))throw unavailable();
 return {valid:count==='1',reason:count==='1'?null:'ORIGINAL_ORDER_NO_AMBIGUOUS',orderNoTrxCount:count};
}

export class PrestartRefundAllocationUnknown extends Error{
 readonly code='REFUND_ALLOCATION_UNKNOWN';
 constructor(readonly terminationId:string,readonly idempotencyKey:string){super('Recover the original prestart refund key');}
}
export const prestartRefundAllocationKey=(id:string)=>`auto_prestart_${createHash('sha256').update(id).digest('hex').slice(0,40)}`;

/** 无新SUBMIT配置即关闭；不替失败/释放的原意图自动换键重试。 */
export async function allocatePrestartJoinpayRefunds(o:RefundExecution,limit:number,signal?:AbortSignal){
 const result={selected:0,allocated:0,replayed:0,skipped:0};
 if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw invalid();
 if(!o.initialProfile||signal?.aborted)return result;
 const a=assertFormalRefundProfile(o.admission,o.initialProfile,'SUBMIT');assertRefundStart(o.admission);
 const scan=await o.pool.connect();let rows:{id:string}[];
 try{
  const r=(await scan.query('SELECT current_database() AS db,current_user AS actor')).rows[0];
  if(r?.db!==a.database||r?.actor!==a.runtimeUser)throw unavailable();
  const ready=(await scan.query(`SELECT to_regclass('zzsh_order.prestart_termination') IS NOT NULL AS ready`)).rows[0];
  if(ready?.ready===false)return result;if(ready?.ready!==true)throw unavailable();
  rows=(await scan.query<{id:string}>(`SELECT t.id FROM zzsh_order.prestart_termination t
   WHERE t.state='APPROVED' AND t.payment_basis->>'source'='JOINPAY' AND t.payment_basis->>'merchantIdentityId'=$1
    AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_confirmation_id=t.payment_basis->>'paymentConfirmationId')
   ORDER BY t.approved_at,t.id LIMIT $2`,[a.merchantIdentityId,limit])).rows;
 }finally{scan.release();}
 if(rows.length>limit||rows.some(r=>typeof r.id!=='string'||!ID.test(r.id))||new Set(rows.map(r=>r.id)).size!==rows.length)throw unavailable();
 result.selected=rows.length;
 for(const row of rows){
  if(signal?.aborted)break;
  const key=prestartRefundAllocationKey(row.id);let completed=false;
  try{
   const receipt=await withTransaction(o.pool,async c=>{const v=await createPrestartFormalRefundIntent(c,{terminationId:row.id,idempotencyKey:key,
    requestId:key,admission:o.admission,profile:o.initialProfile});completed=true;return v;});
   if(receipt.kind==='ALLOCATED')result.allocated++;else if(receipt.kind==='REPLAYED')result.replayed++;else result.skipped++;
  }catch(error){if(completed)throw new PrestartRefundAllocationUnknown(row.id,key);throw error;}
 }
 return result;
}

/** 只从核准终止和原APPLIED款建全额intent；从不接客户端金额、目标或渠道原号。 */
export async function createPrestartFormalRefundIntent(client:PoolClient,input:{terminationId:string;idempotencyKey:unknown;requestId:string;admission?:FormalRefundAdmission;profile?:BoundRefundProfile}){
 const key=validateIdempotencyKey(input.idempotencyKey);if(!ID.test(input.terminationId)||!ID.test(input.requestId))throw invalid();
 const term=(await client.query<Term>(`SELECT id,order_id,state,payment_basis,basis_digest,approved_at::text,liability_root_id,liability_event_id
  FROM zzsh_order.prestart_termination WHERE id=$1 AND state='APPROVED'`,[input.terminationId])).rows[0];
 if(!term)throw notFound();const b=term.payment_basis;
 if(!b||b.source!=='JOINPAY'||b.digest!==term.basis_digest)throw unavailable();
 await lockRefundFunds(client,'JOINPAY',b.merchantIdentityId,b.channelTrxNo);
 await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',$1::text,$2::text)::text,0))`,[b.merchantIdentityId,b.merchantOrderNo]);
 if((await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[b.renterUserId])).rowCount!==1)throw unavailable();
 await verifyPrestartRefundLiability(client,term.id,b,term.liability_root_id,term.liability_event_id);
 const fingerprint=fingerprintRequest('prestart.refund.intent',term.id,{confirmationId:b.paymentConfirmationId,amountCents:b.amountCents,basisDigest:b.digest});
 const old=(await client.query<FormalRefundRow>(`SELECT ${FORMAL_REFUND_COLUMNS} FROM zzsh_order.channel_refund_intent
  WHERE payment_confirmation_id=$1 AND idempotency_key=$2`,[b.paymentConfirmationId,key])).rows[0];
 if(old){
  if(old.basis_kind!=='PRESTART_TERMINATION'||old.payment_source!=='JOINPAY'||old.evidence_level!=='JOINPAY_FORMAL'||old.request_fingerprint!==fingerprint
   ||old.posting_id!==null||old.currency!=='CNY'||old.order_id!==b.orderId||old.renter_user_id!==b.renterUserId||old.merchant_identity_id!==b.merchantIdentityId
   ||old.original_payment_trx_no!==b.channelTrxNo||old.original_payment_order_no!==b.merchantOrderNo
   ||old.liability_root_id!==term.liability_root_id||old.liability_event_id!==term.liability_event_id||old.amount_cents!==b.amountCents)throw conflict('Original prestart refund key has different facts');
  if(createHash('sha256').update(old.initial_admission_canonical).digest('hex')!==old.initial_admission_sha256)throw unavailable();
  let a:any;try{a=JSON.parse(old.initial_admission_canonical);}catch{throw unavailable();}
  const resource=(await client.query(`SELECT current_database() AS db,current_user AS actor`)).rows[0];
  if(a.kind!=='FORMAL_NATIVE_REFUND_SERVER_REVIEW'||a.reference!==old.initial_admission_ref||a.merchantIdentityId!==b.merchantIdentityId
   ||resource?.db!==a.database||resource.actor!==a.runtimeUser||a.merchantNo!==old.wire_merchant_no
   ||!Array.isArray(a.acceptedProfiles)||!a.acceptedProfiles.some((p:any)=>p.operation==='SUBMIT'&&p.profileId===old.initial_profile_id
     &&p.profileSha256===old.initial_profile_sha256&&p.keyVersionRef===old.initial_key_version_ref))throw unavailable();
  return{kind:'REPLAYED' as const,intentId:old.id,refundOrderNo:old.refund_order_no,state:old.state,budgetDisposition:old.budget_disposition};
 }
 if(!input.admission||!input.profile)throw unavailable();
 const admission=assertFormalRefundProfile(input.admission,input.profile,'SUBMIT'),p=describeRefundProfile(input.profile,'SUBMIT');
 assertRefundStart(input.admission);await assertRefundResource(client,input.admission);
 if(admission.merchantIdentityId!==b.merchantIdentityId||p.merchantNo!==admission.merchantNo)throw unavailable();
 const original=(await client.query(`SELECT count(DISTINCT c.provider_transaction_id)::text AS transactions,
  bool_or(c.id=$3 AND c.disposition='APPLIED' AND o.status='CANCELLED' AND o.cancel_reason='PRESTART_TERMINATED' AND o.paid_confirmation_id=c.id
    AND c.currency='CNY' AND c.amount_cents=$4::numeric AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_binding bnd
      WHERE bnd.request_id=c.joinpay_request_id AND bnd.wire_merchant_no=$5)) AS bound
  FROM zzsh_order.payment_confirmation c JOIN zzsh_order.rental_order o ON o.id=c.order_id
  WHERE c.source='JOINPAY' AND c.merchant_scope_id=$1 AND c.merchant_order_no=$2 AND c.disposition IN('APPLIED','REVIEW_REQUIRED')`,
  [b.merchantIdentityId,b.merchantOrderNo,b.paymentConfirmationId,b.amountCents,admission.merchantNo])).rows[0];
 if(original?.bound!==true)throw unavailable();
 if(original.transactions!=='1')return{kind:'REVIEW_REQUIRED' as const,reason:'ORIGINAL_ORDER_NO_AMBIGUOUS' as const};
 const budget=(await client.query(`SELECT COALESCE(sum(amount_cents) FILTER(WHERE budget_disposition<>'RELEASED'),0)::text AS allocated,
  bool_or(requires_review) AS requires_review FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND merchant_identity_id=$1
   AND original_payment_trx_no=$2`,[b.merchantIdentityId,b.channelTrxNo])).rows[0];
 if(!budget||budget.allocated!=='0'||budget.requires_review!==null&&typeof budget.requires_review!=='boolean'||budget.requires_review===true)throw conflict('Original full refund is allocated or requires review');
 const id=`refund_${randomUUID().replaceAll('-','')}`,number=`RF${fingerprintRequest('prestart.refund.number',term.id,[b.merchantIdentityId,b.channelTrxNo,key]).slice(0,28)}`;
 assertRefundBinding(input.profile,'SUBMIT',{intentId:id,postingId:null,basisKind:'PRESTART_TERMINATION',orderId:b.orderId,paymentConfirmationId:b.paymentConfirmationId,
  renterUserId:b.renterUserId,merchantIdentityId:b.merchantIdentityId,merchantNo:p.merchantNo,originalPaymentOrderNo:b.merchantOrderNo,originalPaymentTrxNo:b.channelTrxNo,
  responsibilityVersionHash:b.digest,refundOrderNo:number,amountCents:b.amountCents,currency:'CNY',notifyUrl:p.notifyUrl,reason:'PRESTART_TERMINATED',
  fundsAccount:p.fundsAccount,profileId:p.profileId,initialProfileSha256:p.profileSha256,keyVersionRef:p.keyVersionRef});
 const row=(await client.query<FormalRefundRow>(`INSERT INTO zzsh_order.channel_refund_intent
  (id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,merchant_identity_id,original_payment_trx_no,original_payment_order_no,
   responsibility_version_hash,refund_order_no,amount_cents,currency,idempotency_key,request_fingerprint,due_at,evidence_level,
   initial_admission_ref,initial_admission_sha256,initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,
   initial_key_version_ref,notify_url,funds_account,refund_reason,basis_kind,liability_root_id,liability_event_id)
  VALUES($1,NULL,$2,$3,$4,'JOINPAY',$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13::timestamptz,'JOINPAY_FORMAL',
   $14,$15,$16,$17,$18,$19,$20,$21,$22,'PRESTART_TERMINATED','PRESTART_TERMINATION',$23,$24) RETURNING ${FORMAL_REFUND_COLUMNS}`,
  [id,b.orderId,b.paymentConfirmationId,b.renterUserId,b.merchantIdentityId,b.channelTrxNo,b.merchantOrderNo,b.digest,number,b.amountCents,key,fingerprint,term.approved_at,
   admission.reference,admission.sha256,admission.canonical,p.merchantNo,p.profileId,p.profileSha256,p.keyVersionRef,p.notifyUrl,p.fundsAccount??null,term.liability_root_id,term.liability_event_id])).rows[0];
 if(!row)throw unavailable();
 await recordAudit(client,{actorType:'system',action:'order.refund.prestart.allocated',objectType:'channel_refund_intent',objectId:row.id,requestId:input.requestId,
  outcome:'SUCCESS',details:{terminationId:term.id,paymentConfirmationId:b.paymentConfirmationId,amountCents:b.amountCents,currency:'CNY',channelResult:'NOT_SUBMITTED'}});
 return{kind:'ALLOCATED' as const,intentId:row.id,refundOrderNo:row.refund_order_no,state:row.state,budgetDisposition:row.budget_disposition};
}
