import type {FinanceEntry} from './admin-finance-read';
import type {FinanceOrderFact} from './admin-finance-order-read';
import type {AdminLegacyDutyFinance} from './legacy-duty-finance-store';
import {exactCents} from './finance-money';
import {sourceYuanToCents} from './personal-finance-read';

export type OrderSettlementMoney={knowledge:'KNOWN'|'UNKNOWN';cents:string|null;reasonCodes:string[]};
export type OrderSettlementFacts={legacyDutyReady:boolean;duties:AdminLegacyDutyFinance[]};
export type AdminOrderSettlementEvidence={
 schema:'admin-order-settlement-evidence.v1';documentRef:string;readiness:'READY'|'UNAVAILABLE';
 posting:{state:'POSTED'|'FINALIZED_ZERO'|'NOT_POSTED'|'UNKNOWN';ref:string|null;postedAt:string|null};
 captured:OrderSettlementMoney;ownerNet:OrderSettlementMoney;refundPayable:OrderSettlementMoney;refunded:OrderSettlementMoney;historicalRefund:OrderSettlementMoney;
 refundDueAt:string|null;channel:{state:'UNKNOWN';reference:null};
 dutyRefs:{documentRef:string|null;kind:string;state:string;amount:OrderSettlementMoney}[];reasonCodes:string[];
};
const unknown=(reason:string):OrderSettlementMoney=>({knowledge:'UNKNOWN',cents:null,reasonCodes:[reason]});
function money(value:unknown,reason:string):OrderSettlementMoney{
 try{const cents=exactCents(value);return BigInt(cents)<0n?unknown(reason):{knowledge:'KNOWN',cents,reasonCodes:[]};}catch{return unknown(reason);}
}
function same(values:(string|null|undefined)[]):string|null{
 const first=values[0];return typeof first==='string'&&first.length>0&&values.every(v=>v===first)?first:null;
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
 return{...base,posting:{state:'POSTED',ref:postingId,postedAt},captured,ownerNet,refundPayable,refundDueAt,reasonCodes:['REFUND_PAYABLE_NOT_CHANNEL_PAYMENT']};
}
/** No quote recalculation, current policy lookup, financial write or channel result inference. */
export function projectAdminOrderSettlementEvidence(order:FinanceOrderFact,entries:readonly FinanceEntry[],legacy?:OrderSettlementFacts):AdminOrderSettlementEvidence{
 const base:AdminOrderSettlementEvidence={schema:'admin-order-settlement-evidence.v1',documentRef:order.ref,readiness:order.sourceType==='NATIVE'||legacy?.legacyDutyReady===true?'READY':'UNAVAILABLE',posting:{state:'UNKNOWN',ref:null,postedAt:null},
  captured:unknown('ORIGINAL_CAPTURED_EVIDENCE_UNAVAILABLE'),ownerNet:unknown('ORIGINAL_OWNER_NET_EVIDENCE_UNAVAILABLE'),refundPayable:unknown('ORIGINAL_REFUND_RESPONSIBILITY_UNAVAILABLE'),refunded:unknown('REFUND_PAYMENT_SOURCE_NOT_AVAILABLE'),historicalRefund:unknown('HISTORICAL_REFUND_SOURCE_UNAVAILABLE'),refundDueAt:null,channel:{state:'UNKNOWN',reference:null},dutyRefs:[],reasonCodes:[]};
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
