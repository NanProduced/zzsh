import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,invalid} from '../supply/supply-util';
import {prepareHistoricalObservation,sourceYuanToCents} from './personal-finance-read';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const id=/^[1-9]\d{0,23}$/,digest=/^[a-f0-9]{64}$/;
const logFields=['id','sn','action','amount','userId','sourceId','createdAt','changeType','leftAmount'];
const provedLogKinds=['LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION','LEGACY_WITHDRAWAL_RETURN'];
export type ReviewedEconomicSource={sourceKind:string;sourceEntity:string;sourceId:string;beneficiaryRole:string;sourceEventAt:string;sourceCanonical:string;sourceDigest:string};
export type ReviewedOpeningLogBinding={observationId:string;observationDigest:string;sourceKind:string;sourceEntity:string;sourceId:string;beneficiaryRole:string;sourceDigest:string};
export type ReviewedFinanceLogEvidence={observationId:string;originalDigest:string;extractSha256:string;canonical:string;digest:string};
export type FinanceSourceProof={schema:'legacy-finance-source-proof.v1';sources:ReviewedEconomicSource[];logBindings:ReviewedOpeningLogBinding[];supplementalLogs:ReviewedFinanceLogEvidence[]};

type Subject={userId:string;legacyUserId:string};
type Input={covered:ReviewedEconomicSource[];observations:Record<string,unknown>[];logBindings?:ReviewedOpeningLogBinding[];sourceEvidence?:ReviewedFinanceLogEvidence[];included:string[];cutoff:string};
const epoch=(value:unknown)=>{const text=String(value);return /^[1-9]\d{0,9}$/.test(text)&&BigInt(text)<=4294967295n?BigInt(text):null;};
function object(canonical:string):Record<string,unknown>{
 let value:unknown;try{value=JSON.parse(canonical);}catch{throw invalid('Original source canonical required');}
 if(!value||typeof value!=='object'||Array.isArray(value)||canonical.length>262144||canonicalize(value)!==canonical)throw invalid('Exact original source canonical required');
 return value as Record<string,unknown>;
}
export function isStoredEconomicSource(kind:string,entity:string,role:string){
 return kind==='LEGACY_DISTRIBUTION_EARNING'&&entity==='la_distribution_order'&&['TASK_REFERRAL','RENTER_REFERRAL','OWNER_REFERRAL'].includes(role)
  ||kind==='LEGACY_WITHDRAWAL'&&entity==='la_withdraw_apply'&&role==='WALLET_HOLDER'
  ||['LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION'].includes(kind)&&entity==='la_order'&&role==='OWNER'
  ||['LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN'].includes(kind)&&entity==='la_log_earnings'&&role==='WALLET_HOLDER';
}
/** Shared by offline preparation and the opaque stored-opening admission; no source tuple is inferred from a log number. */
export function reviewedOpeningCoveredSet(sources:ReviewedEconomicSource[],subject:Subject,cutoff:string):string[][]{
 if(!Array.isArray(sources)||sources.length>5000)throw invalid('Bounded original economic sources required');
 const rows=sources.map(source=>{
  if(!source||typeof source!=='object')throw invalid('Original economic source required');
  ensureOnlyFields(source,['sourceKind','sourceEntity','sourceId','beneficiaryRole','sourceEventAt','sourceCanonical','sourceDigest']);
  const at=epoch(source.sourceEventAt);
  if(![source.sourceKind,source.sourceEntity,source.sourceId,source.beneficiaryRole,source.sourceEventAt,source.sourceDigest].every(value=>typeof value==='string')
   ||!id.test(source.sourceId)||!digest.test(source.sourceDigest)||typeof source.sourceCanonical!=='string'||sha(source.sourceCanonical)!==source.sourceDigest
   ||at===null||at*1000n>BigInt(Date.parse(cutoff)))throw invalid('Original economic canonical/time required');
  object(source.sourceCanonical);
  if(!isStoredEconomicSource(source.sourceKind,source.sourceEntity,source.beneficiaryRole))throw invalid('Reviewed typed economic source required');
  return[subject.userId,source.sourceKind,'LEGACY_MYSQL',source.sourceEntity,source.sourceId,source.beneficiaryRole,source.sourceEventAt,source.sourceDigest];
 }).sort((a,b)=>{const x=JSON.stringify(a.slice(1,6)),y=JSON.stringify(b.slice(1,6));return x<y?-1:x>y?1:0;});
 if(new Set(rows.map(row=>JSON.stringify(row.slice(1,6)))).size!==rows.length)throw invalid('Duplicate economic root');
 return rows;
}
function withdrawalAmount(source:Record<string,unknown>){
 const gross=sourceYuanToCents(source.money),fee=sourceYuanToCents(source.handling_fee),net=sourceYuanToCents(source.left_money);
 if(BigInt(gross)!==BigInt(fee)+BigInt(net)||String(source.is_delete)!=='0')throw invalid('Original withdrawal gross/fee/net or deletion differs');
 return gross;
}
/** Supplementary fields are separately sealed; the original nine-field canonical is never replaced. */
function supplementalEvidence(input:Input,logs:Map<string,Record<string,unknown>>){
 const result=new Set<string>(),seen=new Set<string>();
 if(input.sourceEvidence!==undefined&&!Array.isArray(input.sourceEvidence))throw invalid('Supplementary source evidence must be an array');
 for(const evidence of input.sourceEvidence??[]){
  if(!evidence||typeof evidence!=='object')throw invalid('Supplementary source evidence required');
  ensureOnlyFields(evidence,['observationId','originalDigest','extractSha256','canonical','digest']);
  const original=logs.get(evidence.observationId);
  if(!original||![1006,1007,1008].includes(Number(original.changeType))||!id.test(evidence.observationId)||seen.has(evidence.observationId)
   ||!digest.test(evidence.extractSha256)||!digest.test(evidence.originalDigest)||!digest.test(evidence.digest)
   ||typeof evidence.canonical!=='string'||sha(evidence.canonical)!==evidence.digest||sha(canonicalize(original))!==evidence.originalDigest)throw invalid('Supplementary source identity/digest differs');
  seen.add(evidence.observationId);
  const extended=object(evidence.canonical);ensureOnlyFields(extended,[...logFields,'source_sn','remark','extra']);
  if(logFields.some(key=>!Object.hasOwn(extended,key)||canonicalize(extended[key])!==canonicalize(original[key])))throw invalid('Supplement changed the original log');
  const fields=['source_sn','remark','extra'];
  if(fields.some(key=>Object.hasOwn(extended,key)&&extended[key]!==null&&typeof extended[key]!=='string'))throw invalid('Supplementary source fields must retain their original values');
  // Absence is unknown; an explicitly extracted empty string or null remains a distinct original value.
  if(fields.every(key=>Object.hasOwn(extended,key)))result.add(evidence.observationId);
 }
 return result;
}

export function validateReviewedOpeningSources(input:Input,subject:Subject):boolean{
 const unresolved=input.observations.filter(row=>row.kind==='earningsLog'&&row.referenceType==='UNRESOLVED_ECONOMIC_SOURCE');
 if(input.logBindings!==undefined&&!Array.isArray(input.logBindings))throw invalid('Opening log proofs must be an array');
 if(!input.logBindings?.length)return unresolved.length===0&&!input.covered.some(row=>provedLogKinds.includes(row.sourceKind))&&!input.sourceEvidence?.length;
 if(input.logBindings.length!==unresolved.length||input.logBindings.length>10000)throw invalid('Exact one-to-one opening log proofs required');
 const observations=new Map(unresolved.map(row=>[String(row.sourceId),row]));
 const logs=new Map<string,Record<string,unknown>>(),bindings=new Map<string,ReviewedOpeningLogBinding>();
 for(const binding of input.logBindings){
  ensureOnlyFields(binding,['observationId','observationDigest','sourceKind','sourceEntity','sourceId','beneficiaryRole','sourceDigest']);
  if(!id.test(binding.observationId)||!id.test(binding.sourceId)||!digest.test(binding.observationDigest)||!digest.test(binding.sourceDigest)||bindings.has(binding.observationId))throw invalid('Opening log proof is duplicate or invalid');
  const row=observations.get(binding.observationId);if(!row)throw invalid('Opening log proof has no original observation');
  const observation=prepareHistoricalObservation(row,{...subject,sourceSystem:'legacy_mysql_restore',basisId:null});
  const proof=row.rawSource as {entity?:string;canonical?:string;digest?:string}|undefined;
  if(observation.sourceDigest!==binding.observationDigest||proof?.entity!=='la_log_earnings'||typeof proof.canonical!=='string'||sha(proof.canonical)!==proof.digest)throw invalid('Opening original log bytes differ');
  const log=object(proof.canonical);ensureOnlyFields(log,logFields);
  if(logFields.some(key=>!Object.hasOwn(log,key))||String(log.id)!==binding.observationId||String(log.userId)!==subject.legacyUserId||String(log.sourceId)!==row.referenceId||log.sn!==row.legacyLogNumber||log.amount!==row.amount||log.action!==row.action||log.createdAt!==row.createdAt||log.changeType!==row.legacyChangeType||log.leftAmount!==row.leftAmount)throw invalid('Opening log subject, amount or direction changed');
  bindings.set(binding.observationId,binding);logs.set(binding.observationId,log);
 }
 const supplemental=supplementalEvidence(input,logs),usedRoots=new Set<ReviewedEconomicSource>();
 const sources=new Map(input.covered.map(source=>[source,object(source.sourceCanonical)])),byId=new Map<string,ReviewedEconomicSource[]>(),byReference=new Map<string,Record<string,unknown>[]>(),included=new Set(input.included);
 for(const source of input.covered){const group=byId.get(source.sourceId);if(group)group.push(source);else byId.set(source.sourceId,[source]);}
 for(const log of logs.values()){const key=String(log.sourceId),group=byReference.get(key);if(group)group.push(log);else byReference.set(key,[log]);}
 const atCutoff=(time:unknown)=>{const value=epoch(time);return value!==null&&value*1000n<=BigInt(Date.parse(input.cutoff));};
 for(const [source,attempt] of sources){
  if(source.sourceKind!=='LEGACY_WITHDRAWAL'||String(attempt.status)!=='4')continue;
  const amount=withdrawalAmount(attempt),related=byReference.get(source.sourceId)??[];
  const debit=related.filter(log=>log.changeType===1002),returns=related.filter(log=>[1003,1004,1005].includes(Number(log.changeType)));
  if(debit.length!==1||returns.length!==1||![1003,1004].includes(Number(returns[0]!.changeType)))throw invalid('Failed withdrawal requires one exact debit and one supported return');
  const a=debit[0]!,b=returns[0]!;
  if(String(attempt.userId)!==subject.legacyUserId||a.action!==2||b.action!==1||sourceYuanToCents(a.amount)!==amount||sourceYuanToCents(b.amount)!==amount
   ||!atCutoff(a.createdAt)||!atCutoff(b.createdAt)||!atCutoff(attempt.create_time)||epoch(a.createdAt)!<epoch(attempt.create_time)!||epoch(b.createdAt)!<epoch(a.createdAt)!
   ||!included.has('la_log_earnings:'+a.id)||!included.has('la_log_earnings:'+b.id))throw invalid('Withdrawal return subject, gross or event time differs');
  const roots=(byId.get(String(b.id))??[]).filter(root=>root.sourceKind==='LEGACY_WITHDRAWAL_RETURN'&&root.sourceCanonical===canonicalize(b));
  if(roots.length!==1)throw invalid('Withdrawal return requires its own original log root');
 }
 let complete=true;
 for(const [observationId,log] of logs){
  let incomplete=false;
  const possible=new Set([...(byId.get(String(log.sourceId))??[]),...(byId.get(observationId)??[])]);
  const candidates=[...possible].filter(source=>{
   const value=sources.get(source)!;if(String(value.id)!==source.sourceId)return false;
   let amount:string,eventAt:unknown,action:number;
   if(source.sourceKind==='LEGACY_DISTRIBUTION_EARNING'&&source.sourceEntity==='la_distribution_order'){
    if(String(log.sourceId)!==source.sourceId||String(value.user_id)!==subject.legacyUserId||String(value.order_type)!=='1'||String(value.status)!=='2'||String(value.is_delete)!=='0'||source.beneficiaryRole!==({2:'RENTER_REFERRAL',3:'OWNER_REFERRAL'} as Record<string,string>)[String(value.level)]||log.changeType!==1001)return false;
    amount=sourceYuanToCents(value.earnings);eventAt=value.settle_time;action=1;
   }else if(source.sourceKind==='LEGACY_RENTAL_OWNER_INCOME'&&source.sourceEntity==='la_order'&&source.beneficiaryRole==='OWNER'){
    if(String(log.sourceId)!==source.sourceId||String(value.sale_user_id)!==subject.legacyUserId||String(value.order_status)!=='4'||String(value.pay_is)!=='1'||log.changeType!==1001)return false;
    const net=BigInt(sourceYuanToCents(value.sale_earnings))-BigInt(sourceYuanToCents(value.full_payout_money));if(net<0n)return false;amount=net.toString();eventAt=value.confirm_time;action=1;
   }else if(source.sourceKind==='LEGACY_WITHDRAWAL'&&source.sourceEntity==='la_withdraw_apply'&&source.beneficiaryRole==='WALLET_HOLDER'){
    if(String(log.sourceId)!==source.sourceId||String(value.userId)!==subject.legacyUserId||!['3','4'].includes(String(value.status))||log.changeType!==1002)return false;
    if(String(value.status)==='3'&&!atCutoff(value.payment_time))incomplete=true;
    amount=withdrawalAmount(value);eventAt=value.create_time;action=2;
   }else if(source.sourceKind==='LEGACY_WITHDRAWAL_RETURN'&&source.sourceEntity==='la_log_earnings'&&source.beneficiaryRole==='WALLET_HOLDER'){
    if(source.sourceId!==observationId||source.sourceCanonical!==canonicalize(log)||![1003,1004].includes(Number(log.changeType)))return false;
    if(!(byId.get(String(log.sourceId))??[]).some(root=>root.sourceKind==='LEGACY_WITHDRAWAL'&&String(sources.get(root)!.status)==='4'&&String(sources.get(root)!.userId)===subject.legacyUserId))return false;
    amount=sourceYuanToCents(value.amount);eventAt=value.createdAt;action=1;
   }else if(source.sourceKind==='LEGACY_ADMIN_LOG'&&source.sourceEntity==='la_log_earnings'&&source.beneficiaryRole==='WALLET_HOLDER'){
    if(source.sourceId!==observationId||source.sourceCanonical!==canonicalize(log)||String(log.sourceId)!=='0'||![1006,1007].includes(Number(log.changeType)))return false;
    if(!supplemental.has(observationId))incomplete=true;amount=sourceYuanToCents(value.amount);eventAt=value.createdAt;action=log.changeType===1006?1:2;
   }else if(source.sourceKind==='LEGACY_DEPOSIT_COMPENSATION'&&source.sourceEntity==='la_order'&&source.beneficiaryRole==='OWNER'){
    if(String(log.sourceId)!==source.sourceId||String(value.sale_user_id)!==subject.legacyUserId||String(value.pay_is)!=='1'||String(value.is_settle)!=='3'||log.changeType!==1008)return false;
    if(!supplemental.has(observationId))incomplete=true;amount=sourceYuanToCents(value.deposit_amount);eventAt=log.createdAt;action=1;
   }else return false;
   return atCutoff(eventAt)&&atCutoff(log.createdAt)&&epoch(log.createdAt)!>=epoch(eventAt)!&&source.sourceEventAt===String(eventAt)&&log.action===action&&sourceYuanToCents(log.amount)===amount;
  });
  if(candidates.length!==1)throw invalid('Opening log economic source is missing or ambiguous');
  const source=candidates[0]!,binding=bindings.get(observationId)!;
  for(const key of ['sourceKind','sourceEntity','sourceId','beneficiaryRole','sourceDigest'] as const)if(binding[key]!==source[key])throw invalid('Opening log proof points to another economic source');
  if(usedRoots.has(source))throw invalid('Opening economic source credited by more than one log');usedRoots.add(source);
  if(provedLogKinds.includes(source.sourceKind)&&!included.has('la_log_earnings:'+observationId))throw invalid('Reviewed economic log must be in the opening covered set');
  if(incomplete)complete=false;
 }
 if(input.covered.some(source=>provedLogKinds.includes(source.sourceKind)&&!usedRoots.has(source)))throw invalid('Reviewed economic root has no exact original log');
 return complete;
}
