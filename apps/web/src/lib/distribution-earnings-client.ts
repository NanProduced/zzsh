import {commissionStateLabel as uiCommissionStateLabel} from '@zzsh/ui/display-distribution';
import {WalletRequestError} from './personal-wallet-client.ts';
const originalStates=['ALL','PENDING','SETTLED','REVOKED','RECOVERY_REQUIRED','EXPIRED'] as const;
export const earningStates=['ALL','PENDING','MATURED','SETTLED','VOID','REVOKED','RECOVERY_REQUIRED','EXPIRED','UNKNOWN'] as const;
export type EarningFilter=typeof earningStates[number];
export type CommissionRecordState=Exclude<EarningFilter,'ALL'>;
export function commissionStateLabel(state:EarningFilter):string{return state==='ALL'?'全部记录':uiCommissionStateLabel(state);}
export type CurrentLegacyFinance={knowledge:'UNKNOWN';reason:string}|{knowledge:'KNOWN';state:'SETTLED';amountCents:string;zeroFinalization:boolean;reference:{type:'LEDGER_ENTRY'|'FINANCE_EVENT';id:string;digest:string}};
export type CurrentLegacyResponsibility={knowledge:'UNKNOWN';reason:string}|{knowledge:'KNOWN';dutyId:string;orderId:string;state:'PENDING'|'MATURED'|'SETTLED'|'VOID';amountCents:string;currency:'CNY';revision:string;revised:boolean;maturityAt:string|null;settledBy:'FINANCE'|'LEGACY_RECORDS'|null};
export type EarningCalculation={knowledge:'NOT_RECORDED'|'UNKNOWN';reason:string}|{knowledge:'KNOWN';policyVersion:string;beneficiaryLevelCode:string|null;rateMode?:'UNIFORM';percent:string;basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE';baseDisclosure:'INTERNAL_SETTLEMENT_ONLY';rounding:'HALF_UP_CENT';cap:'COMBINED_ROLES_NOT_ABOVE_BASE';scope:'LOCAL_CONTROLLED'|'NATIVE';orderNumber:string|null};
export type EarningItem={id:string;origin:'NATIVE'|'LEGACY_MYSQL';state:Exclude<typeof originalStates[number],'ALL'>;role:string;amount:{currency:'CNY';unit:'cent';amountCents:string};occurredAt:string;dueAt:string|null;dueAtKnowledge:'KNOWN'|'UNKNOWN';fundsDisposition:string;recoveryRequiredCents:string|null;includedInOpening:boolean;version:string|null;accountingEffect:string;businessReference:{type:string;id:string|null};channelArrivalKnowledge:'UNKNOWN';currentFinance?:CurrentLegacyFinance|null;currentResponsibility?:CurrentLegacyResponsibility|null;calculation?:EarningCalculation;record?:CommissionRecord};
export type CommissionRecord={id:string;key:string;effectiveState:CommissionRecordState;amountCents:string;occurredAt:string;stateKnowledge:'KNOWN'|'UNKNOWN';detail:{source:{type:'NATIVE'|'LEGACY_MYSQL';system:string;entity:string;id:string};stateBasis:'POSTED_RECORD'|'CURRENT_RESPONSIBILITY'|'SOURCE_RECORD'|'UNKNOWN';originalState:string;originalAmountCents:string;accountingEffect:'EXISTING_LEDGER_EVENT'|'OBSERVATION_ONLY_NO_NEW_CREDIT';currentResponsibility:CurrentLegacyResponsibility|null;currentFinance:CurrentLegacyFinance|null;bankArrival:'UNKNOWN';reasonCodes:string[]}};
export type CommissionRecordSummary={scope:'COMMISSION_RECORDS';knowledge:'KNOWN'|'UNKNOWN';count:string|null;mappedRecordCount:string;amountCents:string|null;knownSubtotalCents:string;unknownStateCount:string;unclassifiedRecordCount?:string;states:{state:CommissionRecordState;count:string;amountCents:string}[];coverage:{knowledge:'KNOWN'|'UNKNOWN';cutoff:string|null;reasonCodes:string[]};reasonCodes:string[]};
export type EarningsContext={contractVersion:'distribution-earnings.read.v1';subjectId:string;snapshotVersion:string;asOf:string;projectionVersion?:2};
type SourceAmount={knowledge:'KNOWN'|'UNKNOWN';amountCents:string|null};
export type EarningsPage=EarningsContext&{state:EarningFilter;knowledge:'KNOWN'|'UNKNOWN';count:string|null;mappedRecordCount:string;reason:string|null;totalAmountKnowledge:'KNOWN'|'UNKNOWN';amountsByOrigin?:{scope:'SOURCE_RECORDS_ONLY';native:SourceAmount;historical:SourceAmount;mappedHistoricalAmountCents:string|null};items:EarningItem[];nextCursor:string|null;recordSummary?:CommissionRecordSummary};
export type EarningsDetail=EarningsContext&{item:EarningItem};
const bad=()=>new WalletRequestError(502,'EARNINGS_CONTRACT_REQUIRED');
const obj=(v:any)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw bad();return v;};
const text=(v:any,max=200):string=>{if(typeof v!=='string'||!v||v.length>max)throw bad();return v;};
const cents=(v:any):string=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v))throw bad();return v;};
const time=(v:any):string=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw bad();return v;};
function context(v:any,userId:string,expectedVersion?:1|2):EarningsContext{if(v.subjectId!==userId)throw new WalletRequestError(401,'IDENTITY_CHANGED');const version=v.projectionVersion===undefined?1:v.projectionVersion;if(v.contractVersion!=='distribution-earnings.read.v1'||![1,2].includes(version)||expectedVersion!==undefined&&version!==expectedVersion)throw bad();return{contractVersion:v.contractVersion,subjectId:userId,snapshotVersion:text(v.snapshotVersion),asOf:time(v.asOf),...(version===2?{projectionVersion:2 as const}:{})};}
function calculation(value:any,legacy:boolean):EarningCalculation{
 const c=obj(value);
 if(c.knowledge==='NOT_RECORDED'&&legacy&&c.reason==='HISTORICAL_CALCULATION_NOT_RECORDED')return{knowledge:'NOT_RECORDED',reason:c.reason};
 if(c.knowledge==='UNKNOWN'&&!legacy&&['ORIGINAL_BASIS_UNAVAILABLE','FROZEN_CALCULATION_NOT_VERIFIED','UNIFORM_CALCULATION_REQUIRES_VERSION_2'].includes(c.reason))return{knowledge:'UNKNOWN',reason:c.reason};
 if(c.knowledge!=='KNOWN'||legacy||typeof c.percent!=='string'||!/^(0|[1-9]\d{0,2})(?:\.\d{1,8})?$/.test(c.percent)||Number(c.percent)>100
  ||c.basis!=='FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE'||c.baseDisclosure!=='INTERNAL_SETTLEMENT_ONLY'||c.rounding!=='HALF_UP_CENT'||c.cap!=='COMBINED_ROLES_NOT_ABOVE_BASE'||!['LOCAL_CONTROLLED','NATIVE'].includes(c.scope))throw bad();
 if(c.rateMode!==undefined&&c.rateMode!=='UNIFORM'||c.rateMode==='UNIFORM'&&c.beneficiaryLevelCode!==null)throw bad();
 return{knowledge:'KNOWN',policyVersion:text(c.policyVersion,128),beneficiaryLevelCode:c.rateMode==='UNIFORM'?null:text(c.beneficiaryLevelCode,64),...(c.rateMode==='UNIFORM'?{rateMode:'UNIFORM' as const}:{}),percent:c.percent,basis:c.basis,baseDisclosure:c.baseDisclosure,rounding:c.rounding,cap:c.cap,scope:c.scope,orderNumber:c.orderNumber===null?null:text(c.orderNumber,80)};
}
function parseCurrentFinance(value:any,legacy:boolean):CurrentLegacyFinance|null{
 if(!legacy){if(value!==undefined&&value!==null)throw bad();return null;}
const f=value===undefined?{knowledge:'UNKNOWN',reason:'LEGACY_FINANCE_NOT_ADMITTED_OR_NOT_FINALIZED'}:obj(value);if(f.knowledge==='KNOWN'){const ref=obj(f.reference),n=cents(f.amountCents);if(f.state!=='SETTLED'||f.zeroFinalization!==(n==='0')||ref.type!==(n==='0'?'FINANCE_EVENT':'LEDGER_ENTRY')||typeof ref.digest!=='string'||!/^[a-f0-9]{64}$/.test(ref.digest))throw bad();return {knowledge:'KNOWN',state:'SETTLED',amountCents:n,zeroFinalization:f.zeroFinalization,reference:{type:ref.type,id:text(ref.id),digest:ref.digest}};}else if(f.knowledge==='UNKNOWN')return {knowledge:'UNKNOWN',reason:text(f.reason)};else throw bad();
}
function parseCurrentResponsibility(value:any,legacy:boolean):CurrentLegacyResponsibility|null{
 if(!legacy){if(value!==undefined&&value!==null)throw bad();return null;}
const f=value===undefined?{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_NOT_ADMITTED'}:obj(value);if(f.knowledge==='KNOWN'){
   const state=f.state;if(!['PENDING','MATURED','SETTLED','VOID'].includes(state)||f.currency!=='CNY'||typeof f.revised!=='boolean'||typeof f.revision!=='string'||!/^[1-9]\d{0,18}$/.test(f.revision)||(f.settledBy!==null)!==(state==='SETTLED')||state==='SETTLED'&&!['FINANCE','LEGACY_RECORDS'].includes(f.settledBy))throw bad();
   return {knowledge:'KNOWN',dutyId:text(f.dutyId),orderId:text(f.orderId),state,amountCents:cents(f.amountCents),currency:'CNY',revision:f.revision,revised:f.revised,maturityAt:f.maturityAt===null?null:time(f.maturityAt),settledBy:f.settledBy};
 }else if(f.knowledge==='UNKNOWN')return {knowledge:'UNKNOWN',reason:text(f.reason)};else throw bad();
}
const integer=(value:unknown):string=>{if(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value))throw bad();return value;};
const reasons=(value:unknown):string[]=>{if(!Array.isArray(value)||value.length>100||value.some(reason=>typeof reason!=='string'||!reason||reason.length>200))throw bad();return value;};
const recordTime=(value:unknown):string=>{if(typeof value!=='string'||value.length>80||!Number.isFinite(Date.parse(value)))throw bad();return value;};
export function commissionRecord(value:unknown):CommissionRecord{
 const r=obj(value),d=obj(r.detail),source=obj(d.source),legacy=source.type==='LEGACY_MYSQL';
 if(!['NATIVE','LEGACY_MYSQL'].includes(source.type)||!/^commission:[a-f0-9]{64}$/.test(r.key)||!earningStates.includes(r.effectiveState)||r.effectiveState==='ALL'||!['KNOWN','UNKNOWN'].includes(r.stateKnowledge)||(r.effectiveState==='UNKNOWN')!==(r.stateKnowledge==='UNKNOWN')||!['POSTED_RECORD','CURRENT_RESPONSIBILITY','SOURCE_RECORD','UNKNOWN'].includes(d.stateBasis)||!originalStates.includes(d.originalState)||d.originalState==='ALL'||!['EXISTING_LEDGER_EVENT','OBSERVATION_ONLY_NO_NEW_CREDIT'].includes(d.accountingEffect)||d.bankArrival!=='UNKNOWN')throw bad();
 const id=text(r.id);if(!/^(native|history):[A-Za-z0-9_-]{1,180}$/.test(id)||!Object.hasOwn(d,'currentFinance')||!Object.hasOwn(d,'currentResponsibility'))throw bad();
 return{id,key:r.key,effectiveState:r.effectiveState,amountCents:cents(r.amountCents),occurredAt:recordTime(r.occurredAt),stateKnowledge:r.stateKnowledge,detail:{source:{type:source.type,system:text(source.system),entity:text(source.entity),id:text(source.id)},stateBasis:d.stateBasis,originalState:d.originalState,originalAmountCents:cents(d.originalAmountCents),accountingEffect:d.accountingEffect,currentFinance:parseCurrentFinance(d.currentFinance,legacy),currentResponsibility:parseCurrentResponsibility(d.currentResponsibility,legacy),bankArrival:'UNKNOWN',reasonCodes:reasons(d.reasonCodes)}};
}
export function commissionRecordSummary(value:unknown):CommissionRecordSummary{
 const r=obj(value),coverage=obj(r.coverage);if(r.scope!=='COMMISSION_RECORDS'||!['KNOWN','UNKNOWN'].includes(r.knowledge)||!['KNOWN','UNKNOWN'].includes(coverage.knowledge)||!Array.isArray(r.states)||r.states.length>earningStates.length-1)throw bad();
 const mapped=integer(r.mappedRecordCount),unknown=integer(r.unknownStateCount),unclassified=r.unclassifiedRecordCount===undefined?undefined:integer(r.unclassifiedRecordCount),subtotal=integer(r.knownSubtotalCents),count=r.count===null?null:integer(r.count),amount=r.amountCents===null?null:integer(r.amountCents);
 const states:CommissionRecordSummary['states']=r.states.map((value:any)=>{const state=obj(value);if(!earningStates.includes(state.state)||state.state==='ALL')throw bad();return{state:state.state as CommissionRecordState,count:integer(state.count),amountCents:integer(state.amountCents)}});
 if(new Set(states.map((s:any)=>s.state)).size!==states.length||states.reduce((n:bigint,s:any)=>n+BigInt(s.count),0n)!==BigInt(mapped)||states.reduce((n:bigint,s:any)=>n+BigInt(s.amountCents),0n)!==BigInt(subtotal)||BigInt(unknown)>BigInt(mapped))throw bad();
 if((states.find(s=>s.state==='UNKNOWN')?.count??'0')!==unknown||unclassified!==undefined&&BigInt(unclassified)<BigInt(unknown))throw bad();
 if(r.knowledge==='KNOWN'?(coverage.knowledge!=='KNOWN'||unknown!=='0'||unclassified!==undefined&&unclassified!=='0'||count!==mapped||amount!==subtotal):(count!==null||amount!==null))throw bad();
 return{scope:'COMMISSION_RECORDS',knowledge:r.knowledge,count,mappedRecordCount:mapped,amountCents:amount,knownSubtotalCents:subtotal,unknownStateCount:unknown,...(unclassified===undefined?{}:{unclassifiedRecordCount:unclassified}),states,coverage:{knowledge:coverage.knowledge,cutoff:coverage.cutoff===null?null:recordTime(coverage.cutoff),reasonCodes:reasons(coverage.reasonCodes)},reasonCodes:reasons(r.reasonCodes)};
}
/** Record aggregates may exceed the wallet's single-amount bound; they are never wallet balances. */
export function commissionRecordMoney(value:string|null|undefined):string{
 if(value===null||value===undefined)return '待核定';const n=BigInt(integer(value));return '¥'+(n/100n).toLocaleString('zh-CN')+'.'+(n%100n).toString().padStart(2,'0');
}
function item(value:any,projectionVersion:1|2=1):EarningItem{
 const r=obj(value),a=obj(r.amount),reference=obj(r.businessReference),legacy=r.origin==='LEGACY_MYSQL';
 if(!legacy&&r.origin!=='NATIVE'||!originalStates.includes(r.state)||r.state==='ALL'||a.currency!=='CNY'||a.unit!=='cent'||r.channelArrivalKnowledge!=='UNKNOWN'||typeof r.includedInOpening!=='boolean')throw bad();
 const amount=cents(a.amountCents),debt=r.recoveryRequiredCents===null?null:cents(r.recoveryRequiredCents),id=text(r.id);
 if(!new RegExp('^'+(legacy?'history':'native')+':[A-Za-z0-9_-]{1,180}$').test(id))throw bad();
 if(legacy){if(!['PENDING','SETTLED','EXPIRED'].includes(r.state)||r.dueAt!==null||r.dueAtKnowledge!=='UNKNOWN'||r.version!==null||debt!==null||r.fundsDisposition!=='HISTORICAL_STATUS_ONLY'||r.accountingEffect!=='OBSERVATION_ONLY_NO_NEW_CREDIT'||reference.type!=='LEGACY_UNRESOLVED')throw bad();}
 else{if(r.state==='EXPIRED'||!['RENTER_REFERRAL','OWNER_REFERRAL'].includes(r.role)||r.includedInOpening||r.dueAtKnowledge!=='KNOWN'||r.accountingEffect!=='EXISTING_LEDGER_EVENT'||reference.type!=='RENTAL_ORDER'||typeof r.version!=='string'||!/^[1-9]\d{0,18}$/.test(r.version))throw bad();time(r.dueAt);if(r.state==='RECOVERY_REQUIRED'?(r.fundsDisposition!=='SETTLED'||debt!==amount||BigInt(amount)<=0n):(r.fundsDisposition!==r.state||debt!==null))throw bad();}
 const currentFinance=projectionVersion===2?parseCurrentFinance(r.currentFinance,legacy):null,currentResponsibility=projectionVersion===2?parseCurrentResponsibility(r.currentResponsibility,legacy):null;
 const record=projectionVersion===2&&r.record!==undefined?commissionRecord(r.record):undefined;
 if(record&&(record.id!==id||record.detail.source.type!==r.origin||record.detail.originalState!==r.state||record.detail.originalAmountCents!==amount))throw bad();
 return{id,origin:r.origin,state:r.state,role:text(r.role,40),amount:{currency:'CNY',unit:'cent',amountCents:amount},occurredAt:time(r.occurredAt),dueAt:legacy?null:r.dueAt,dueAtKnowledge:r.dueAtKnowledge,fundsDisposition:r.fundsDisposition,recoveryRequiredCents:debt,includedInOpening:r.includedInOpening,version:r.version,accountingEffect:r.accountingEffect,businessReference:{type:reference.type,id:reference.id===null?null:text(reference.id)},channelArrivalKnowledge:'UNKNOWN',...(projectionVersion===2?{currentFinance,currentResponsibility,...(record?{record}:{}),...(r.calculation===undefined?{}:{calculation:calculation(r.calculation,legacy)})}:{})};
}
export function earningsPage(value:unknown,userId:string,state:EarningFilter,expectedVersion?:1|2):EarningsPage{
 const r=obj(value),base=context(r,userId,expectedVersion),version=base.projectionVersion??1;if(version===1&&!originalStates.includes(state as any)||r.state!==state||!['KNOWN','UNKNOWN'].includes(r.knowledge)||(r.knowledge==='KNOWN')!==(r.count!==null)||!(version===2?['KNOWN','UNKNOWN']:['UNKNOWN']).includes(r.totalAmountKnowledge)||!Array.isArray(r.items)||r.items.length>50)throw bad();
 const count=r.count===null?null:cents(r.count),mapped=cents(r.mappedRecordCount),items=r.items.map((v:any)=>item(v,version)),cursor=r.nextCursor===null?null:text(r.nextCursor,4096);
 if(count!==null&&count!==mapped||BigInt(mapped)<BigInt(items.length)||cursor&&!items.length||new Set(items.map((i:EarningItem)=>i.id)).size!==items.length||items.some((i:EarningItem)=>state!=='ALL'&&(version===2&&i.record?i.record.effectiveState:i.state)!==state))throw bad();
 const amount=(v:any):SourceAmount=>{const a=obj(v);if(!['KNOWN','UNKNOWN'].includes(a.knowledge)||(a.knowledge==='KNOWN')!==(a.amountCents!==null))throw bad();return{knowledge:a.knowledge,amountCents:a.amountCents===null?null:cents(a.amountCents)};};
 const amounts=version===2?(()=>{const a=obj(r.amountsByOrigin);if(a.scope!=='SOURCE_RECORDS_ONLY')throw bad();return{scope:'SOURCE_RECORDS_ONLY' as const,native:amount(a.native),historical:amount(a.historical),mappedHistoricalAmountCents:cents(a.mappedHistoricalAmountCents)};})():undefined;
 // Source amount coverage does not close unclassified current responsibility states.
 if(amounts&&((r.totalAmountKnowledge==='KNOWN')!==(amounts.native.knowledge==='KNOWN'&&amounts.historical.knowledge==='KNOWN')
  ||amounts.historical.amountCents!==null&&amounts.historical.amountCents!==amounts.mappedHistoricalAmountCents))throw bad();
 const recordSummary=version===2&&r.recordSummary!==undefined?commissionRecordSummary(r.recordSummary):undefined;
 if(recordSummary&&(recordSummary.mappedRecordCount!==mapped||state==='ALL'&&recordSummary.unclassifiedRecordCount!==undefined&&recordSummary.unclassifiedRecordCount!==recordSummary.unknownStateCount))throw bad();
 if(items.some((i:EarningItem)=>i.record)&&new Set(items.map((i:EarningItem)=>i.record?.key??i.id)).size!==items.length)throw bad();
 return{...base,state,knowledge:r.knowledge,count,mappedRecordCount:mapped,reason:r.reason===null?null:text(r.reason),totalAmountKnowledge:r.totalAmountKnowledge,...(amounts?{amountsByOrigin:amounts}:{}),...(recordSummary?{recordSummary}:{}),items,nextCursor:cursor};
}
export function earningsDetail(value:unknown,userId:string,id:string,expectedVersion?:1|2):EarningsDetail{const r=obj(value),base=context(r,userId,expectedVersion),entry=item(r.item,base.projectionVersion??1);if(entry.id!==id)throw bad();return{...base,item:entry};}
async function get(path:string,signal?:AbortSignal){let response:Response;try{response=await fetch('/api/account/earnings'+path,{credentials:'same-origin',cache:'no-store',signal});}catch(e){if(signal?.aborted)throw e;throw new WalletRequestError(0,'NETWORK_ERROR');}const body=await response.json().catch(()=>null);if(!response.ok)throw new WalletRequestError(response.status,body?.error?.code??'EARNINGS_UNAVAILABLE');return body;}
export async function readEarnings(userId:string,state:EarningFilter,cursor:string|null=null,signal?:AbortSignal){const q=new URLSearchParams({state,limit:'20',projectionVersion:'2'});if(cursor)q.set('cursor',cursor);return earningsPage(await get('?'+q,signal),userId,state,2);}
export async function readEarningDetail(userId:string,id:string,signal?:AbortSignal){return earningsDetail(await get('/'+encodeURIComponent(id)+'?projectionVersion=2&calculationVersion=2',signal),userId,id,2);}
