import {WalletRequestError} from './personal-wallet-client.ts';
export type UnifiedGuaranteeEvent={id:string;eventKind:'REQUIREMENT'|'PAYMENT_ATTEMPT'|'REFUND_ATTEMPT'|'PAYMENT_OBSERVATION'|'ACCOUNT_OBSERVATION';accountId:string|null;accountNumber:string|null;occurredAt:string|null;recordedAt:string;amountCents:string|null;
 source:{type:'NATIVE'|'LEGACY_MYSQL';entity:string;id:string};requirement:{id:string;status:string;requiredCents:string}|null;
 paymentAttempt:{id:string;status:string;providerState:string|null;merchantOrderNumber:string|null}|null;refundAttempt:{id:string;paymentId:string;status:string;providerState:string;releasePolicyState:string}|null;
 localPosting:{knowledge:'KNOWN'|'UNKNOWN';amountCents:string|null;postedAt:string|null;reason:string}|null;classification:string|null;conflicts:string[];channelArrival:'UNKNOWN'};
export type UnifiedGuaranteePage={contractVersion:'owner-guarantee-history.read.v2';projectionVersion:2;subjectId:string;asOf:string;snapshotVersion:string;items:UnifiedGuaranteeEvent[];nextCursor:string|null;
 coverage:{knowledge:'KNOWN'|'UNKNOWN';count:string|null;mappedRecordCount:string;reason:string;cutoff:string|null};sources:{native:{knowledge:'KNOWN'|'UNKNOWN';count:string|null};legacy:{knowledge:'KNOWN'|'UNKNOWN';count:string|null;reason:string}};
 unknownTimeCount:string;postedHeld:{knowledge:'KNOWN'|'UNKNOWN';amountCents:string|null;scope:'POSTED_LEDGER_ONLY';reason:string};liability:{knowledge:'UNKNOWN';amountCents:null};channelArrival:'UNKNOWN'};
const bad=()=>new WalletRequestError(502,'GUARANTEE_HISTORY_CONTRACT_REQUIRED');
const object=(v:any):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw bad();return v;};
const text=(v:any,max=256):string=>{if(typeof v!=='string'||!v||v.length>max)throw bad();return v;};
const nullable=(v:any)=>v===null?null:text(v),amount=(v:any):string=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v))throw bad();return v;};
const time=(v:any):string|null=>{if(v===null)return null;const s=text(v,40);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(s)||!Number.isFinite(Date.parse(s)))throw bad();return s;};
const count=(v:any)=>{const c=object(v);if(!['KNOWN','UNKNOWN'].includes(c.knowledge)||(c.knowledge==='KNOWN')!==(c.count!==null))throw bad();return{knowledge:c.knowledge as 'KNOWN'|'UNKNOWN',count:c.count===null?null:amount(c.count)};};
const choices=(value:any,values:string[])=>{if(!values.includes(value))throw bad();return value;};
const requirements=['OPEN','COVERED','REFUND_REQUESTED','REFUND_PROCESSING','REFUNDED','RESTRICTED'];
function event(value:any):UnifiedGuaranteeEvent{
 const r=object(value),source=object(r.source),kind=choices(r.eventKind,['REQUIREMENT','PAYMENT_ATTEMPT','REFUND_ATTEMPT','PAYMENT_OBSERVATION','ACCOUNT_OBSERVATION']);
 const type=choices(source.type,['NATIVE','LEGACY_MYSQL']),entity=choices(source.entity,['owner_guarantee_requirement','owner_guarantee_payment','owner_guarantee_refund','la_pay_order','la_rental_accounts']);
 const expectedEntity={REQUIREMENT:'owner_guarantee_requirement',PAYMENT_ATTEMPT:'owner_guarantee_payment',REFUND_ATTEMPT:'owner_guarantee_refund',PAYMENT_OBSERVATION:'la_pay_order',ACCOUNT_OBSERVATION:'la_rental_accounts'}[kind as UnifiedGuaranteeEvent['eventKind']];
 if(r.channelArrival!=='UNKNOWN'||(type==='NATIVE')!==!['PAYMENT_OBSERVATION','ACCOUNT_OBSERVATION'].includes(kind)||entity!==expectedEntity||!Array.isArray(r.conflicts)||r.conflicts.length>8||r.conflicts.some((v:any)=>typeof v!=='string'))throw bad();
 const prefix={REQUIREMENT:'native:requirement:',PAYMENT_ATTEMPT:'native:payment:',REFUND_ATTEMPT:'native:refund:',PAYMENT_OBSERVATION:'legacy:payment:',ACCOUNT_OBSERVATION:'legacy:account:'}[kind as UnifiedGuaranteeEvent['eventKind']],id=text(r.id,400),sourceId=text(source.id);
 if(!id.startsWith(prefix)||kind!=='ACCOUNT_OBSERVATION'&&id!==prefix+sourceId)throw bad();
 const requirement=r.requirement===null?null:(()=>{const v=object(r.requirement);return{id:text(v.id),status:choices(v.status,requirements),requiredCents:amount(v.requiredCents)};})();
 const payment=r.paymentAttempt===null?null:(()=>{const p=object(r.paymentAttempt);return{id:text(p.id),status:choices(p.status,type==='NATIVE'?['REQUESTED','ACCEPTED','PROCESSING','CONFIRMED','FAILED','UNKNOWN']:['SOURCE_PAID_RECORD','SOURCE_UNPAID_RECORD','SOURCE_UNCONFIRMED']),providerState:p.providerState===null?null:choices(p.providerState,['NOT_AUTHORIZED','SUBMITTED','UNKNOWN','CONFIRMED','FAILED']),merchantOrderNumber:nullable(p.merchantOrderNumber)};})();
 const refund=r.refundAttempt===null?null:(()=>{const p=object(r.refundAttempt);return{id:text(p.id),paymentId:text(p.paymentId),status:choices(p.status,['REQUESTED','PROCESSING','SUCCEEDED','FAILED','UNKNOWN']),providerState:choices(p.providerState,['NOT_AUTHORIZED','SUBMITTED','UNKNOWN','SUCCEEDED','FAILED']),releasePolicyState:choices(p.releasePolicyState,['OWNER_DECISION_REQUIRED','APPROVED','REJECTED'])};})();
 const posting=r.localPosting===null?null:(()=>{const p=object(r.localPosting);if(!['KNOWN','UNKNOWN'].includes(p.knowledge)||(p.knowledge==='KNOWN')!==(p.amountCents!==null)||(p.knowledge==='KNOWN')!==(p.postedAt!==null))throw bad();return{knowledge:p.knowledge as 'KNOWN'|'UNKNOWN',amountCents:p.amountCents===null?null:amount(p.amountCents),postedAt:time(p.postedAt),reason:text(p.reason)};})();
 if(type==='NATIVE'&&!requirement||type==='LEGACY_MYSQL'&&(requirement||posting||refund)||(kind==='PAYMENT_ATTEMPT'||kind==='PAYMENT_OBSERVATION')!==!!payment||(kind==='REFUND_ATTEMPT')!==!!refund||kind==='REQUIREMENT'&&posting)throw bad();
 if((kind==='ACCOUNT_OBSERVATION')!==(r.amountCents===null)||payment&&payment.id!==sourceId||refund&&refund.id!==sourceId||kind==='REQUIREMENT'&&requirement?.id!==sourceId)throw bad();
 const occurredAt=time(r.occurredAt),recordedAt=time(r.recordedAt);if(!recordedAt||kind==='ACCOUNT_OBSERVATION'&&occurredAt!==null||type==='NATIVE'&&occurredAt===null)throw bad();
 return{id,eventKind:kind,accountId:nullable(r.accountId),accountNumber:nullable(r.accountNumber),occurredAt,recordedAt,amountCents:r.amountCents===null?null:amount(r.amountCents),source:{type,entity,id:sourceId},requirement,paymentAttempt:payment,refundAttempt:refund,localPosting:posting,classification:nullable(r.classification),conflicts:r.conflicts,channelArrival:'UNKNOWN'};
}
export function parseUnifiedOwnerGuaranteeHistory(value:unknown,userId:string):UnifiedGuaranteePage{
 const r=object(value);if(r.subjectId!==userId)throw new WalletRequestError(401,'IDENTITY_CHANGED');
 if(r.contractVersion!=='owner-guarantee-history.read.v2'||r.projectionVersion!==2||r.channelArrival!=='UNKNOWN'||!Array.isArray(r.items)||r.items.length>20)throw bad();
 const items=r.items.map(event),coverage=object(r.coverage),c=count(coverage),mapped=amount(coverage.mappedRecordCount),sources=object(r.sources),native=count(sources.native),legacy=count(sources.legacy),held=object(r.postedHeld);
 if(c.count!==null&&c.count!==mapped||BigInt(mapped)<BigInt(items.length)||new Set(items.map((i:UnifiedGuaranteeEvent)=>i.id)).size!==items.length||c.knowledge==='KNOWN'&&(native.knowledge!=='KNOWN'||legacy.knowledge!=='KNOWN'))throw bad();
 if(!['KNOWN','UNKNOWN'].includes(held.knowledge)||(held.knowledge==='KNOWN')!==(held.amountCents!==null)||held.scope!=='POSTED_LEDGER_ONLY'||r.liability?.knowledge!=='UNKNOWN'||r.liability?.amountCents!==null)throw bad();
 const next=r.nextCursor===null?null:text(r.nextCursor,4096),asOf=time(r.asOf);if(!asOf||next&&!items.length)throw bad();
 return{contractVersion:r.contractVersion,projectionVersion:2,subjectId:userId,asOf,snapshotVersion:text(r.snapshotVersion),items,nextCursor:next,coverage:{...c,mappedRecordCount:mapped,reason:text(coverage.reason),cutoff:time(coverage.cutoff)},sources:{native,legacy:{...legacy,reason:text(sources.legacy.reason)}},unknownTimeCount:amount(r.unknownTimeCount),postedHeld:{knowledge:held.knowledge,amountCents:held.amountCents===null?null:amount(held.amountCents),scope:'POSTED_LEDGER_ONLY',reason:text(held.reason)},liability:{knowledge:'UNKNOWN',amountCents:null},channelArrival:'UNKNOWN'};
}
export async function readMyUnifiedOwnerGuaranteeHistory(userId:string,cursor:string|null=null,signal?:AbortSignal){
 const q=new URLSearchParams({projectionVersion:'2'});if(cursor)q.set('cursor',cursor);let response:Response;
 try{response=await fetch('/api/account/wallet/guarantees?'+q,{credentials:'same-origin',cache:'no-store',signal});}catch(error){if(signal?.aborted)throw error;throw new WalletRequestError(0,'NETWORK_ERROR');}
 const body=await response.json().catch(()=>null);if(signal?.aborted)throw new DOMException('Aborted','AbortError');if(!response.ok)throw new WalletRequestError(response.status,body?.error?.code??'GUARANTEE_HISTORY_UNAVAILABLE');return parseUnifiedOwnerGuaranteeHistory(body,userId);
}
