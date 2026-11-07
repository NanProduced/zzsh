import type {FinanceEntry,FinanceFacts} from './admin-finance-read';
import type {FinanceOrderFact} from './admin-finance-order-read';
import type {AdminLegacyDutyFinance} from './legacy-duty-finance-store';
import {exactCents} from './finance-money';
import {sourceYuanToCents,type HistoricalRefundAttempt} from './personal-finance-read';
import {legacyEpochTimestamp,legacyOrderReadState} from '../order/legacy-order-read';
import {canonicalize} from '../supply/content-hash';
import {sha256Hex} from '../supply/supply-util';

export type OrderSettlementMoney={knowledge:'KNOWN'|'UNKNOWN';cents:string|null;reasonCodes:string[]};
export type OrderSettlementFacts={legacyDutyReady:boolean;duties:AdminLegacyDutyFinance[]};
export type AdminOrderSettlementEvidence={
 schema:'admin-order-settlement-evidence.v1';documentRef:string;readiness:'READY'|'UNAVAILABLE';
 posting:{state:'POSTED'|'FINALIZED_ZERO'|'NOT_POSTED'|'UNKNOWN';ref:string|null;postedAt:string|null};
 captured:OrderSettlementMoney;ownerNet:OrderSettlementMoney;refundPayable:OrderSettlementMoney;refunded:OrderSettlementMoney;historicalRefund:OrderSettlementMoney;
 /** The verified posting's platform component. It is not net profit and excludes distribution/channel costs. */
 platformContribution:OrderSettlementMoney;
 platformComponents?:{code:string;cents:string;payer:'OWNER'|'RENTER'|'NONE'|null;feeBase:string|null;feeRate:string|null}[];
 refundDueAt:string|null;channel:{state:'UNKNOWN';reference:null};
 dutyRefs:{documentRef:string|null;kind:string;state:string;amount:OrderSettlementMoney}[];reasonCodes:string[];
};
type OrderFinanceTransaction={
 documentRef:string;number:string;kind:'PAYMENT'|'REFUND';source:'NATIVE'|'LEGACY_MYSQL';state:string;
 amountCents:string|null;occurredAt:string|null;channelArrival:'UNKNOWN';
 originalStatus?:string|null;payWay?:string|null;payWayLabel?:string|null;
 refundAttempts?:HistoricalRefundAttempt[];sourceRefundFlags?:string[];
};
type OrderFinanceBusiness={
 payment:{state:'SITE_ACCEPTED'|'LEGACY_RECORDED_PAID'|'UNPAID'|'REVIEW_REQUIRED'|'UNKNOWN';amount:OrderSettlementMoney;occurredAt:string|null};
 settlementState:'POSTED'|'FINALIZED_ZERO'|'NOT_SETTLED'|'LEGACY_RECORDED_COMPLETE'|'UNKNOWN';
 /** Original sale earnings before separate deductions and the original recorded refund amount. */
 legacyCompletedAmounts:{ownerEarnings:OrderSettlementMoney;refundAmount:OrderSettlementMoney}|null;
 paymentAttempts:OrderFinanceTransaction[];refundOrders:OrderFinanceTransaction[];reasonCodes:string[];
};
const unknown=(reason:string):OrderSettlementMoney=>({knowledge:'UNKNOWN',cents:null,reasonCodes:[reason]});
function money(value:unknown,reason:string):OrderSettlementMoney{
 try{const cents=exactCents(value);return BigInt(cents)<0n?unknown(reason):{knowledge:'KNOWN',cents,reasonCodes:[]};}catch{return unknown(reason);}
}
function same(values:(string|null|undefined)[]):string|null{
 const first=values[0];return typeof first==='string'&&first.length>0&&values.every(v=>v===first)?first:null;
}
function legacyCompletedAmounts(order:FinanceOrderFact):OrderFinanceBusiness['legacyCompletedAmounts']{
 const source=order.legacySource;
 if(source?.entity!=='la_order'||!source.completedAt||order.originalOrderStatus!=='4'||order.originalPaymentStatus!=='1')return null;
 const snapshot=source.snapshot;
 try{
  if(String(snapshot.id)!==order.sourceId||snapshot.order_sn!==order.number||String(snapshot.order_status)!=='4'||String(snapshot.pay_is)!=='1'||
   sha256Hex(canonicalize(snapshot))!==order.sourceDigest||Date.parse(legacyEpochTimestamp(snapshot.confirm_time)??'')!==Date.parse(source.completedAt))return null;
 }catch{return null;}
 const original=(value:unknown,reason:string)=>{try{return money(sourceYuanToCents(value),reason);}catch{return unknown(reason);}};
 return{ownerEarnings:original(snapshot.sale_earnings,'LEGACY_OWNER_EARNINGS_SOURCE_UNAVAILABLE'),
  refundAmount:original(snapshot.return_order_money,'LEGACY_REFUND_AMOUNT_SOURCE_UNAVAILABLE')};
}

export function projectAdminOrderFinanceBusiness(order:FinanceOrderFact,receipt:AdminOrderSettlementEvidence,facts:Pick<FinanceFacts,'entries'|'legacyOrderObservations'|'orderSettlementFacts'>):OrderFinanceBusiness{
 const legacy=order.sourceType==='LEGACY_MYSQL', legacyState=legacyOrderReadState(Number(order.originalOrderStatus),Number(order.originalPaymentStatus??NaN));
 const completedAmounts=legacy?legacyCompletedAmounts(order):null;
 const payment:OrderFinanceBusiness['payment']={state:'UNKNOWN',amount:unknown('ORDER_PAYMENT_AMOUNT_UNAVAILABLE'),occurredAt:null};
 if(legacy){
  // The order snapshot is the business payment record. Its child observations are attempts.
  if(legacyState.paymentState==='RECORDED_PAID'){
   payment.state='LEGACY_RECORDED_PAID';
   payment.amount=money(order.recordedPaidCents,'LEGACY_ORDER_PAYMENT_AMOUNT_UNAVAILABLE');
   payment.occurredAt=order.legacySource?.paidAt??null;
  }else if(legacyState.paymentState==='RECORDED_UNPAID')payment.state='UNPAID';
 }else if(order.payment?.state==='SITE_ACCEPTED'){
  payment.state='SITE_ACCEPTED';
  payment.amount=money(order.payment.amountCents,'ORDER_PAYMENT_AMOUNT_UNAVAILABLE');
  payment.occurredAt=order.payment.confirmedAt;
 }else if(order.payment?.state==='NO_ACCEPTED_PAYMENT')payment.state='UNPAID';
 else if(order.payment?.state==='REVIEW_REQUIRED')payment.state='REVIEW_REQUIRED';

 let settlementState:OrderFinanceBusiness['settlementState']='UNKNOWN';
 if(receipt.posting.state==='POSTED'||receipt.posting.state==='FINALIZED_ZERO')settlementState=receipt.posting.state;
 else if(!legacy&&order.postingState==='NOT_POSTED')settlementState='NOT_SETTLED';
 else if(completedAmounts)settlementState='LEGACY_RECORDED_COMPLETE';
 else if(legacy&&['PAID','PENDING_PAYMENT'].includes(legacyState.status)&&!order.legacySource?.completedAt&&facts.orderSettlementFacts?.legacyDutyReady&&
   facts.orderSettlementFacts.duties.every(duty=>['PENDING','MATURED','VOID'].includes(duty.state)))settlementState='NOT_SETTLED';

 const transactions:OrderFinanceTransaction[]=[];
 if(legacy){
  for(const row of facts.legacyOrderObservations??[]){
   if(row.kind!=='PAYMENT'&&row.kind!=='REFUND')continue;
   const state=row.kind==='PAYMENT'?({'0':'RECORDED_UNPAID','1':'RECORDED_PAID'}[row.originalStatus??'']):
    ({'0':'RECORDED_PENDING','1':'RECORDED_SUCCESS','2':'RECORDED_FAILED'}[row.originalStatus??'']);
   transactions.push({...row,kind:row.kind,source:'LEGACY_MYSQL',state:state??'UNKNOWN'});
  }
 }else{
  for(const row of facts.entries){
   if(row.classification!=='LOCAL_SOURCE_WITHOUT_POSTING'||row.sourceType!=='NATIVE'||row.subjectId!==order.renterId||
    !row.related.some(link=>link.ref===order.ref))continue;
   if(row.sourceEntity!=='payment_request'&&row.sourceEntity!=='channel_refund_intent')continue;
   transactions.push({documentRef:row.documentRef,number:row.documentNumber,kind:row.sourceEntity==='payment_request'?'PAYMENT':'REFUND',
    source:'NATIVE',state:row.state,amountCents:money(row.evidence.requestedAmountCents,'ORDER_TRANSACTION_AMOUNT_UNAVAILABLE').cents,
    occurredAt:row.occurredAt,channelArrival:'UNKNOWN',payWay:null,payWayLabel:null});
  }
 }
 const paymentAttempts=transactions.filter(row=>row.kind==='PAYMENT'),refundOrders=transactions.filter(row=>row.kind==='REFUND');
 const reasonCodes=paymentAttempts.filter(row=>row.state==='RECORDED_PAID').length>1?['LEGACY_MULTIPLE_RECORDED_PAID_ATTEMPTS']:[];
 return{payment,settlementState,legacyCompletedAmounts:completedAmounts,paymentAttempts,refundOrders,reasonCodes};
}

function nativeReceipt(order:FinanceOrderFact,entries:readonly FinanceEntry[],base:AdminOrderSettlementEvidence):AdminOrderSettlementEvidence{
 const rows=entries.filter(row=>row.documentRef===order.ref);
 if(!rows.length)return{...base,posting:{state:'NOT_POSTED',ref:null,postedAt:null},reasonCodes:['ORDER_NO_CURRENT_POSTING']};
 const field=(name:string)=>same(rows.map(row=>row.evidence[name]));
 const captured=money(field('postingCapturedCents'),'SETTLEMENT_CAPTURED_UNAVAILABLE'),ownerNet=money(field('postingOwnerNetCents'),'SETTLEMENT_OWNER_NET_UNAVAILABLE'),refundPayable=money(field('refundPayableCents'),'SETTLEMENT_REFUND_RESPONSIBILITY_UNAVAILABLE'),platform=money(field('postedPlatformContributionCents'),'SETTLEMENT_PLATFORM_COMPONENT_UNAVAILABLE');
 const postingId=field('postingId'),paymentId=field('paymentConfirmationId'),versionId=field('settlementVersionId'),versionHash=field('settlementVersionHash'),postedAt=field('postedAt'),refundDueAt=field('refundDueAt');
 const headers=[captured,ownerNet,refundPayable,platform].every(value=>value.knowledge==='KNOWN')&&postingId&&paymentId&&versionId&&versionHash&&/^[a-f0-9]{64}$/.test(versionHash)&&postedAt&&refundDueAt;
 let balanced=false;
 if(headers&&new Set(rows.map(row=>row.id)).size===rows.length){
  try{
   const sum=(predicate:(row:FinanceEntry)=>boolean)=>rows.filter(predicate).reduce((n,row)=>n+BigInt(exactCents(row.deltaCents)),0n);
   balanced=rows.every(row=>row.knowledge==='KNOWN'&&row.sourceType==='NATIVE'&&row.classification==='CURRENT_POSTED'&&row.affectsCurrentLedger
    &&(row.accountCode==='CAPTURED_PAYMENT_SOURCE'||row.accountCode==='OWNER_AVAILABLE'&&row.subjectId===order.ownerId||row.accountCode==='RENTER_REFUND_PAYABLE'&&row.subjectId===order.renterId||row.accountCode?.startsWith('PLATFORM_')))
    &&BigInt(captured.cents!)===BigInt(ownerNet.cents!)+BigInt(refundPayable.cents!)+BigInt(platform.cents!)
    &&sum(()=>true)===0n&&sum(row=>row.accountCode==='CAPTURED_PAYMENT_SOURCE')===-BigInt(captured.cents!)
    &&sum(row=>row.accountCode==='OWNER_AVAILABLE')===BigInt(ownerNet.cents!)&&sum(row=>row.accountCode==='RENTER_REFUND_PAYABLE')===BigInt(refundPayable.cents!)
    &&sum(row=>row.accountCode?.startsWith('PLATFORM_')===true)===BigInt(platform.cents!);
  }catch{balanced=false;}
 }
 if(!balanced)return{...base,reasonCodes:['SETTLEMENT_ORIGINAL_RECEIPT_INCONSISTENT']};
 return{...base,posting:{state:'POSTED',ref:postingId,postedAt},captured,ownerNet,refundPayable,platformContribution:platform,refundDueAt,
  platformComponents:rows.filter(row=>row.accountCode?.startsWith('PLATFORM_')).map(row=>({code:row.accountCode!,cents:exactCents(row.deltaCents),
   payer:['OWNER','RENTER','NONE'].includes(row.evidence.feePayer??'')?row.evidence.feePayer as 'OWNER'|'RENTER'|'NONE':null,
   feeBase:row.evidence.feeBase??null,feeRate:row.evidence.feeRate??null})),
  reasonCodes:['REFUND_PAYABLE_NOT_CHANNEL_PAYMENT','PLATFORM_CONTRIBUTION_IS_NOT_NET_PROFIT']};
}
/** No quote recalculation, current policy lookup, financial write or channel result inference. */
export function projectAdminOrderSettlementEvidence(order:FinanceOrderFact,entries:readonly FinanceEntry[],legacy?:OrderSettlementFacts):AdminOrderSettlementEvidence{
 const base:AdminOrderSettlementEvidence={schema:'admin-order-settlement-evidence.v1',documentRef:order.ref,readiness:order.sourceType==='NATIVE'||legacy?.legacyDutyReady===true?'READY':'UNAVAILABLE',posting:{state:'UNKNOWN',ref:null,postedAt:null},
  captured:unknown('ORIGINAL_CAPTURED_EVIDENCE_UNAVAILABLE'),ownerNet:unknown('ORIGINAL_OWNER_NET_EVIDENCE_UNAVAILABLE'),refundPayable:unknown('ORIGINAL_REFUND_RESPONSIBILITY_UNAVAILABLE'),refunded:unknown('REFUND_PAYMENT_SOURCE_NOT_AVAILABLE'),historicalRefund:unknown('HISTORICAL_REFUND_SOURCE_UNAVAILABLE'),platformContribution:unknown('SETTLEMENT_PLATFORM_COMPONENT_UNAVAILABLE'),refundDueAt:null,channel:{state:'UNKNOWN',reference:null},dutyRefs:[],reasonCodes:[]};
 if(order.sourceType==='NATIVE')return nativeReceipt(order,entries,base);
 const raw=order.legacySource?.snapshot.return_order_money;
 try{base.historicalRefund=money(sourceYuanToCents(raw),'HISTORICAL_REFUND_SOURCE_INVALID');}catch{if(raw!==null&&raw!==undefined)base.historicalRefund=unknown('HISTORICAL_REFUND_SOURCE_INVALID');}
 const duties=(legacy?.duties??[]).map(duty=>{
  if(duty.knowledge==='UNKNOWN')return duty;
  const party=duty.kind==='RENTER_REFUND'?order.renterId:duty.kind==='OWNER_CREDIT'||duty.kind==='DEPOSIT_COMPENSATION'?order.ownerId:null;
  return duty.orderId===order.id&&(!party||party===duty.subjectId)&&duty.parentSourceId===order.sourceId&&duty.parentSourceDigest===order.sourceDigest?duty:{...duty,knowledge:'UNKNOWN' as const,amountCents:null,reference:null,reasonCodes:['LEGACY_DUTY_ORDER_BINDING_UNAVAILABLE']};
 });
 base.dutyRefs=duties.map(duty=>({documentRef:duty.knowledge==='KNOWN'?`LEGACY_DUTY:${duty.dutyId}`:null,kind:duty.kind,state:duty.state,amount:duty.knowledge==='KNOWN'?money(duty.amountCents,'ORIGINAL_DUTY_AMOUNT_INVALID'):unknown(duty.reasonCodes[0]??'ORIGINAL_DUTY_FINANCE_UNAVAILABLE')}));
 const component=(kind:AdminLegacyDutyFinance['kind'],reason:string)=>{const matching=duties.filter(duty=>duty.kind===kind);return matching.length===1&&matching[0]!.knowledge==='KNOWN'?money(matching[0]!.amountCents,reason):unknown(matching.length>1?'ORIGINAL_DUTY_RESPONSIBILITY_AMBIGUOUS':reason);};
 base.ownerNet=component('OWNER_CREDIT','ORIGINAL_OWNER_NET_EVIDENCE_UNAVAILABLE');base.refundPayable=component('RENTER_REFUND','ORIGINAL_REFUND_RESPONSIBILITY_UNAVAILABLE');
 if(duties.length&&duties.every(duty=>duty.knowledge==='KNOWN')){
  const zero=duties.every(duty=>duty.finalization==='FINALIZED_ZERO'&&duty.amountCents==='0'),positive=duties.some(duty=>duty.finalization==='POSTED'&&money(duty.amountCents,'INVALID_DUTY_AMOUNT').knowledge==='KNOWN'&&BigInt(duty.amountCents!)>0n);
  if(zero||positive)base.posting={state:zero?'FINALIZED_ZERO':'POSTED',ref:same(duties.map(duty=>duty.reference?.id)),postedAt:same(duties.map(duty=>duty.postedAt))};
 }
 base.reasonCodes=[...new Set(['HISTORICAL_REFUND_NOT_CURRENT_RESPONSIBILITY','REFUND_PAYABLE_NOT_CHANNEL_PAYMENT',...(legacy?.legacyDutyReady===true?[]:['LEGACY_DUTY_FINANCE_NOT_AVAILABLE']),...duties.flatMap(duty=>duty.reasonCodes)])];
 return base;
}
