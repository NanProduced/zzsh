import {WalletRequestError} from './personal-wallet-client.ts';
export const earningStates=['ALL','PENDING','SETTLED','REVOKED','RECOVERY_REQUIRED','EXPIRED'] as const;
export type EarningFilter=typeof earningStates[number];
export type EarningItem={id:string;origin:'NATIVE'|'LEGACY_MYSQL';state:Exclude<EarningFilter,'ALL'>;role:string;amount:{currency:'CNY';unit:'cent';amountCents:string};occurredAt:string;dueAt:string|null;dueAtKnowledge:'KNOWN'|'UNKNOWN';fundsDisposition:string;recoveryRequiredCents:string|null;includedInOpening:boolean;version:string|null;accountingEffect:string;businessReference:{type:string;id:string|null};channelArrivalKnowledge:'UNKNOWN'};
export type EarningsContext={contractVersion:'distribution-earnings.read.v1';subjectId:string;snapshotVersion:string;asOf:string};
export type EarningsPage=EarningsContext&{state:EarningFilter;knowledge:'KNOWN'|'UNKNOWN';count:string|null;mappedRecordCount:string;reason:string|null;totalAmountKnowledge:'UNKNOWN';items:EarningItem[];nextCursor:string|null};
export type EarningsDetail=EarningsContext&{item:EarningItem};
const bad=()=>new WalletRequestError(502,'EARNINGS_CONTRACT_REQUIRED');
const obj=(v:any)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw bad();return v;};
const text=(v:any,max=200):string=>{if(typeof v!=='string'||!v||v.length>max)throw bad();return v;};
const cents=(v:any):string=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v))throw bad();return v;};
const time=(v:any):string=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw bad();return v;};
function context(v:any,userId:string):EarningsContext{if(v.subjectId!==userId)throw new WalletRequestError(401,'IDENTITY_CHANGED');if(v.contractVersion!=='distribution-earnings.read.v1')throw bad();return{contractVersion:v.contractVersion,subjectId:userId,snapshotVersion:text(v.snapshotVersion),asOf:time(v.asOf)};}
function item(value:any):EarningItem{
 const r=obj(value),a=obj(r.amount),reference=obj(r.businessReference),legacy=r.origin==='LEGACY_MYSQL';
 if(!legacy&&r.origin!=='NATIVE'||!earningStates.includes(r.state)||r.state==='ALL'||a.currency!=='CNY'||a.unit!=='cent'||r.channelArrivalKnowledge!=='UNKNOWN'||typeof r.includedInOpening!=='boolean')throw bad();
 const amount=cents(a.amountCents),debt=r.recoveryRequiredCents===null?null:cents(r.recoveryRequiredCents),id=text(r.id);
 if(!new RegExp('^'+(legacy?'history':'native')+':[A-Za-z0-9_-]{1,180}$').test(id))throw bad();
 if(legacy){if(!['PENDING','SETTLED','EXPIRED'].includes(r.state)||r.dueAt!==null||r.dueAtKnowledge!=='UNKNOWN'||r.version!==null||debt!==null||r.fundsDisposition!=='HISTORICAL_STATUS_ONLY'||r.accountingEffect!=='OBSERVATION_ONLY_NO_NEW_CREDIT'||reference.type!=='LEGACY_UNRESOLVED')throw bad();}
 else{if(r.state==='EXPIRED'||!['RENTER_REFERRAL','OWNER_REFERRAL'].includes(r.role)||r.includedInOpening||r.dueAtKnowledge!=='KNOWN'||r.accountingEffect!=='EXISTING_LEDGER_EVENT'||reference.type!=='RENTAL_ORDER'||typeof r.version!=='string'||!/^[1-9]\d{0,18}$/.test(r.version))throw bad();time(r.dueAt);if(r.state==='RECOVERY_REQUIRED'?(r.fundsDisposition!=='SETTLED'||debt!==amount||BigInt(amount)<=0n):(r.fundsDisposition!==r.state||debt!==null))throw bad();}
 return{id,origin:r.origin,state:r.state,role:text(r.role,40),amount:{currency:'CNY',unit:'cent',amountCents:amount},occurredAt:time(r.occurredAt),dueAt:legacy?null:r.dueAt,dueAtKnowledge:r.dueAtKnowledge,fundsDisposition:r.fundsDisposition,recoveryRequiredCents:debt,includedInOpening:r.includedInOpening,version:r.version,accountingEffect:r.accountingEffect,businessReference:{type:reference.type,id:reference.id===null?null:text(reference.id)},channelArrivalKnowledge:'UNKNOWN'};
}
export function earningsPage(value:unknown,userId:string,state:EarningFilter):EarningsPage{
 const r=obj(value),base=context(r,userId);if(r.state!==state||!['KNOWN','UNKNOWN'].includes(r.knowledge)||(r.knowledge==='KNOWN')!==(r.count!==null)||r.totalAmountKnowledge!=='UNKNOWN'||!Array.isArray(r.items)||r.items.length>50)throw bad();
 const count=r.count===null?null:cents(r.count),mapped=cents(r.mappedRecordCount),items=r.items.map(item),cursor=r.nextCursor===null?null:text(r.nextCursor,4096);
 if(count!==null&&count!==mapped||BigInt(mapped)<BigInt(items.length)||cursor&&!items.length||new Set(items.map((i:EarningItem)=>i.id)).size!==items.length||items.some((i:EarningItem)=>state!=='ALL'&&i.state!==state))throw bad();
 return{...base,state,knowledge:r.knowledge,count,mappedRecordCount:mapped,reason:r.reason===null?null:text(r.reason),totalAmountKnowledge:'UNKNOWN',items,nextCursor:cursor};
}
export function earningsDetail(value:unknown,userId:string,id:string):EarningsDetail{const r=obj(value),base=context(r,userId),entry=item(r.item);if(entry.id!==id)throw bad();return{...base,item:entry};}
async function get(path:string,signal?:AbortSignal){let response:Response;try{response=await fetch('/api/account/earnings'+path,{credentials:'same-origin',cache:'no-store',signal});}catch(e){if(signal?.aborted)throw e;throw new WalletRequestError(0,'NETWORK_ERROR');}const body=await response.json().catch(()=>null);if(!response.ok)throw new WalletRequestError(response.status,body?.error?.code??'EARNINGS_UNAVAILABLE');return body;}
export async function readEarnings(userId:string,state:EarningFilter,cursor:string|null=null,signal?:AbortSignal){const q=new URLSearchParams({state,limit:'20'});if(cursor)q.set('cursor',cursor);return earningsPage(await get('?'+q,signal),userId,state);}
export async function readEarningDetail(userId:string,id:string,signal?:AbortSignal){return earningsDetail(await get('/'+encodeURIComponent(id),signal),userId,id);}
