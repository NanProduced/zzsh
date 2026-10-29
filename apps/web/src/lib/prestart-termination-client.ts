import { OrderRequestError, requestOrderJson, requestOrderWrite } from "./order-client.ts";

export type PrestartRequest = { id:string;revision:string;state:"REQUESTED"|"REVIEW_REQUIRED"|"REJECTED"|"APPROVED";
  requestedByParty:"RENTER"|"OWNER";reason:string;reviewReason:string|null;createdAt:string;updatedAt:string;approvedAt:string|null;
  fullRefundCents:string|null;currency:"CNY";dataOrigin:"JOINPAY_LOCAL_ACCEPTANCE"|"LOCAL_CONTROLLED";liabilityRecognized:boolean;
  channelSubmission:"NOT_REPORTED";bankArrival:"UNKNOWN" };
export type PrestartView = { contractVersion:"order-prestart-termination.v1";orderId:string;orderRevision:string;
  eligibility:{allowed:boolean;reason:string|null;refundCents:string|null};request:PrestartRequest|null;
  refund:PrestartRefundProgress|null;
  coverage:"LOCAL_REGISTERED_ONLY";asOf:string|null;localAcceptanceObservedAt:string|null;unknowns:string[];bankArrival:"UNKNOWN" };
const invalid=()=>new OrderRequestError(502,{error:{code:"PRESTART_CONTRACT_REQUIRED",message:"未开租结束依据暂不可用，请保留原请求并重读"}});
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw invalid();return v as Record<string,unknown>;};
const text=(v:unknown,max=600)=>{if(typeof v!=="string"||!v||v.length>max)throw invalid();return v;};
const id=(v:unknown)=>{const s=text(v,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s))throw invalid();return s;};
const revision=(v:unknown)=>{const s=text(v,19);if(!/^[1-9][0-9]*$/.test(s))throw invalid();return s;};
const cents=(v:unknown)=>{if(v===null)return null;const s=text(v,16);if(!/^[1-9][0-9]*$/.test(s))throw invalid();return s;};
const time=(v:unknown)=>{if(v===null)return null;const s=text(v,40);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(s)||!Number.isFinite(Date.parse(s)))throw invalid();return s;};
const REASONS=["ORDER_NOT_PAID","PAYMENT_BASIS_UNAVAILABLE","PRESTART_FACTS_UNAVAILABLE","RENTAL_ALREADY_STARTED","SETTLEMENT_ALREADY_POSTED","MANUAL_ADJUSTMENT_REVIEW","DISTRIBUTION_RECONCILIATION_REQUIRED"];
export type PrestartRefundProgress={integration:'NOT_INTEGRATED'|'INTEGRATED'|'UNAVAILABLE';truncated:boolean;reason:string|null;bankArrival:'UNKNOWN';
 totals:{originalCents:string;allocatedCents:string;consumedCents:string;releasedCents:string;remainingCents:string;totalsComplete:true}|null;
 intents:{intentId:string|null;refundOrderNo:string|null;state:string;amountCents:string|null;firstSubmit:'DISPATCHED'|'NEVER_DISPATCHED'|'UNKNOWN';
  blockedReason:string|null;localWriteOff:'RECORDED'|'NOT_RECORDED';savedChannelEvidence:{terminal:string;channelRefundTrxNo:string|null;completedAt:string|null;observedAt:string|null;trust:'SAVED_EVIDENCE_NOT_REVALIDATED'}|null}[]|null};
export function parsePrestartRefund(value:unknown):PrestartRefundProgress|null{
 if(value===null||value===undefined)return null;const r=object(value);
 if(typeof r.integration!=='string'||!['NOT_INTEGRATED','INTEGRATED','UNAVAILABLE'].includes(r.integration)||typeof r.truncated!=='boolean'
  ||r.bankArrival!=='UNKNOWN'||r.channelRecordsChecked!==false||r.reason!==null&&(typeof r.reason!=='string'||!/^[A-Z_]{1,64}$/.test(r.reason)))throw invalid();
 const amount=(v:unknown)=>{const s=text(v,24);if(!/^(0|[1-9][0-9]*)$/.test(s))throw invalid();return s;};
 let totals:PrestartRefundProgress['totals']=null;
 if(r.totals!==null){const a=object(r.totals);if(a.totalsComplete!==true||r.truncated||r.integration!=='INTEGRATED')throw invalid();
  totals={originalCents:amount(a.originalCents),allocatedCents:amount(a.allocatedCents),consumedCents:amount(a.consumedCents),releasedCents:amount(a.releasedCents),remainingCents:amount(a.remainingCents),totalsComplete:true};
  if(BigInt(totals.originalCents)<BigInt(totals.allocatedCents)||BigInt(totals.allocatedCents)<BigInt(totals.consumedCents)
   ||BigInt(totals.remainingCents)!==BigInt(totals.originalCents)-BigInt(totals.allocatedCents))throw invalid();}
 let intents:PrestartRefundProgress['intents']=null;
 if(r.intents!==null){if(!Array.isArray(r.intents)||r.intents.length>50)throw invalid();intents=r.intents.map(v=>{const i=object(v);
  if(typeof i.state!=='string'||!['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED','CONFLICT'].includes(i.state)
   ||typeof i.firstSubmit!=='string'||!['DISPATCHED','NEVER_DISPATCHED','UNKNOWN'].includes(i.firstSubmit)
   ||i.blockedReason!==null&&i.blockedReason!=='ORIGINAL_ORDER_NO_AMBIGUOUS'||i.localWriteOff!=='RECORDED'&&i.localWriteOff!=='NOT_RECORDED'
   ||i.bankArrival!=='UNKNOWN')throw invalid();
  let saved:NonNullable<PrestartRefundProgress['intents']>[number]['savedChannelEvidence']=null;
  if(i.savedChannelEvidence!==null){const e=object(i.savedChannelEvidence);if(e.terminal!=='SUCCEEDED'&&e.terminal!=='FAILED_NO_EXECUTION'||e.trust!=='SAVED_EVIDENCE_NOT_REVALIDATED')throw invalid();
   saved={terminal:e.terminal,channelRefundTrxNo:e.channelRefundTrxNo===null?null:id(e.channelRefundTrxNo),completedAt:time(e.completedAt),observedAt:time(e.observedAt),trust:'SAVED_EVIDENCE_NOT_REVALIDATED'};}
  const number=i.refundOrderNo===null?null:text(i.refundOrderNo,30);if(number!==null&&!/^RF[0-9a-f]{28}$/.test(number))throw invalid();
  return {intentId:i.intentId===null?null:id(i.intentId),refundOrderNo:number,state:i.state,amountCents:cents(i.amountCents),firstSubmit:i.firstSubmit as 'DISPATCHED'|'NEVER_DISPATCHED'|'UNKNOWN',
   blockedReason:i.blockedReason as string|null,localWriteOff:i.localWriteOff as 'RECORDED'|'NOT_RECORDED',savedChannelEvidence:saved};});}
 return {integration:r.integration as PrestartRefundProgress['integration'],truncated:r.truncated,reason:r.reason as string|null,bankArrival:'UNKNOWN',totals,intents};
}
export function parsePrestartRequest(value:unknown):PrestartRequest|null{
 if(value===null)return null;const r=object(value);
 if(typeof r.state!=="string"||!["REQUESTED","REVIEW_REQUIRED","REJECTED","APPROVED"].includes(r.state)
  ||typeof r.requestedByParty!=="string"||!["RENTER","OWNER"].includes(r.requestedByParty)
  ||r.currency!=="CNY"||typeof r.dataOrigin!=="string"||!["JOINPAY_LOCAL_ACCEPTANCE","LOCAL_CONTROLLED"].includes(r.dataOrigin)||typeof r.liabilityRecognized!=="boolean"
  ||r.channelSubmission!=="NOT_REPORTED"||r.bankArrival!=="UNKNOWN"||r.state==='APPROVED'&&r.liabilityRecognized!==true
  ||r.state!=='APPROVED'&&r.liabilityRecognized!==false)throw invalid();
 const createdAt=time(r.createdAt),updatedAt=time(r.updatedAt);if(!createdAt||!updatedAt)throw invalid();
 if(r.state==='APPROVED'&&r.approvedAt===null||r.state!=='APPROVED'&&r.approvedAt!==null)throw invalid();
 return{id:id(r.id),revision:revision(r.revision),state:r.state as PrestartRequest['state'],requestedByParty:r.requestedByParty as PrestartRequest['requestedByParty'],
  reason:text(r.reason),reviewReason:r.reviewReason===null?null:text(r.reviewReason),createdAt,updatedAt,approvedAt:time(r.approvedAt),
  fullRefundCents:cents(r.fullRefundCents),currency:'CNY',dataOrigin:r.dataOrigin as PrestartRequest['dataOrigin'],liabilityRecognized:r.liabilityRecognized,
  channelSubmission:'NOT_REPORTED',bankArrival:'UNKNOWN'};
}
export function parsePrestartView(value:unknown,orderId:string):PrestartView{
 const r=object(value),e=object(r.eligibility);
 if(r.contractVersion!=='order-prestart-termination.v1'||r.orderId!==orderId||r.coverage!=='LOCAL_REGISTERED_ONLY'||r.bankArrival!=='UNKNOWN'
  ||typeof e.allowed!=='boolean'||e.reason!==null&&(typeof e.reason!=='string'||!REASONS.includes(e.reason))
  ||e.allowed&&e.reason!==null||!e.allowed&&e.reason===null||!Array.isArray(r.unknowns)||r.unknowns.length>32||!r.unknowns.every(v=>typeof v==='string'&&/^[A-Z_]{1,64}$/.test(v)))throw invalid();
 const refundCents=cents(e.refundCents);if(!e.allowed&&refundCents!==null)throw invalid();
 return{contractVersion:'order-prestart-termination.v1',orderId,orderRevision:revision(r.orderRevision),eligibility:{allowed:e.allowed,reason:e.reason as string|null,refundCents},
  request:parsePrestartRequest(r.request),refund:parsePrestartRefund(r.refund),coverage:'LOCAL_REGISTERED_ONLY',asOf:time(r.asOf),localAcceptanceObservedAt:time(r.localAcceptanceObservedAt),unknowns:r.unknowns as string[],bankArrival:'UNKNOWN'};
}
export const prestartApi={
 read:async(userId:string,orderId:string,signal?:AbortSignal)=>parsePrestartView(await requestOrderJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/prestart-termination`,{expectedUserId:userId,signal}),orderId),
 request:async(userId:string,orderId:string,key:string,body:Record<string,unknown>)=>{
  const r=object(await requestOrderWrite<unknown>(`/api/orders/${encodeURIComponent(orderId)}/prestart-termination/requests`,{expectedUserId:userId,key,body}));
  if(r.contractVersion!=='order-prestart-termination.v1'||r.orderId!==orderId||typeof r.existing!=='boolean')throw invalid();
  const request=parsePrestartRequest(r.request);if(!request)throw invalid();return{orderId,request,existing:r.existing};
 }
};
