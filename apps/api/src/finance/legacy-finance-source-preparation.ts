import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,invalid} from '../supply/supply-util';
import {prepareHistoricalObservation,sourceYuanToCents,sourceSignedYuanToCents} from './personal-finance-read';
import {prepareObservationCoverage,type ObservationKind} from './personal-finance-coverage';
import type {ObservationImportInput} from './personal-finance-observation-maintenance';
import type {StoredOpeningInput} from './personal-finance-maintenance';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),old=/^[1-9]\d{0,23}$/,digest=/^[a-f0-9]{64}$/,target=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
type Subject={userId:string;legacyUserId:string;identityDigest:string};
type PreviewSubject=Pick<Subject,'userId'|'legacyUserId'>;
function previewSubject(s:PreviewSubject){if(!s||typeof s.userId!=='string'||!target.test(s.userId)||typeof s.legacyUserId!=='string'||!old.test(s.legacyUserId))throw invalid('Exact existing identity binding required');}
function subject(s:Subject){previewSubject(s);if(typeof s.identityDigest!=='string'||!digest.test(s.identityDigest))throw invalid('Exact existing identity binding required');}
function sourceId(v:unknown){const s=String(v);if(!old.test(s)||!Number.isSafeInteger(Number(s)))throw invalid('Historical source ID is not losslessly representable');return Number(s);}
function integer(v:unknown){if(typeof v!=='number'||!Number.isSafeInteger(v))throw invalid('Original frozen integer required');return v;}
function rawEvidence(entity:string,r:Record<string,unknown>){const canonical=canonicalize(r);return{entity,canonical,digest:sha(canonical)};}
/** Only fields in the existing 20261006 frozen sections enter these previews. Log sn is never source_sn.
 * The unresolved label grants no financial source proof; it deliberately blocks a stored/posting candidate. */
export function prepareFrozenFinanceObservation(kind:ObservationKind,raw:Record<string,unknown>,s:Subject){
 subject(s);return frozenObservation(kind,raw,s);
}
function frozenObservation(kind:ObservationKind,raw:Record<string,unknown>,s:PreviewSubject){
 let row:Record<string,unknown>;
 if(kind==='HISTORICAL_EARNINGS_LOG'){
  ensureOnlyFields(raw,['id','sn','action','amount','userId','sourceId','createdAt','changeType','leftAmount']);
  if(String(raw.userId)!==s.legacyUserId||![1,2].includes(integer(raw.action)))throw invalid('Original earnings direction/subject required');
  row={kind:'earningsLog',sourceId:sourceId(raw.id),sourceUserId:sourceId(raw.userId),amount:raw.amount,leftAmount:raw.leftAmount,action:raw.action,createdAt:integer(raw.createdAt),
   referenceType:'UNRESOLVED_ECONOMIC_SOURCE',referenceId:String(raw.sourceId),referenceSn:null,legacyChangeType:integer(raw.changeType),legacyLogNumber:raw.sn,rawSource:rawEvidence('la_log_earnings',raw)};
 }else if(kind==='HISTORICAL_WITHDRAWAL'){
  ensureOnlyFields(raw,['id','sn','type','money','status','userId','batch_no','is_delete','left_money','create_time','handling_fee','payment_time']);
  if(String(raw.userId)!==s.legacyUserId||![1,2,3,4,5].includes(integer(raw.status)))throw invalid('Original withdrawal subject/status required');
  const gross=sourceYuanToCents(raw.money),fee=sourceSignedYuanToCents(raw.handling_fee),net=sourceSignedYuanToCents(raw.left_money);
  const sourceAnomalies=[...(BigInt(fee)<0n?['NEGATIVE_SOURCE_FEE']:[]),...(BigInt(net)<0n?['NEGATIVE_SOURCE_NET']:[]),...(BigInt(fee)+BigInt(net)!==BigInt(gross)?['SOURCE_GROSS_FEE_NET_MISMATCH']:[])];
  row={kind:'withdrawObservation',sourceId:sourceId(raw.id),sourceUserId:sourceId(raw.userId),amount:raw.money,sourceStatus:raw.status,createdAt:integer(raw.create_time),fee:raw.handling_fee,net:raw.left_money,
   referenceType:'LEGACY_WITHDRAWAL',referenceId:String(raw.id),referenceSn:raw.sn,sourcePaidAt:raw.payment_time,sourceDeleted:raw.is_delete,sourceAnomalies,rawSource:rawEvidence('la_withdraw_apply',raw)};
 }else if(kind==='HISTORICAL_DISTRIBUTION'){
  ensureOnlyFields(raw,['id','sn','user_id','order_type','order_id','earnings','level','level_id','ratio','status','settle_time','is_delete','create_time','update_time']);
  if(raw.user_id!==s.legacyUserId||!['1','2'].includes(String(raw.order_type))||!['1','2','3'].includes(String(raw.status))||!['1','2','3'].includes(String(raw.level)))throw invalid('Typed distribution source/role/subject required');
  row={kind:'historicalDistribution',sourceId:sourceId(raw.id),sourceUserId:sourceId(raw.user_id),amount:raw.earnings,sourceStatus:Number(raw.status),sourceUpdatedAt:sourceId(raw.update_time),level:Number(raw.level),orderId:sourceId(raw.order_id),
   sourceOrderType:String(raw.order_type),sourceNumber:raw.sn,sourceRatio:raw.ratio,sourceDeleted:raw.is_delete,sourceSettlementTime:raw.settle_time,rawSource:rawEvidence('la_distribution_order',raw)};
 }else throw invalid('Supported frozen finance source kind required');
 const prepared=prepareHistoricalObservation(row,{userId:s.userId,legacyUserId:s.legacyUserId,sourceSystem:'legacy_mysql_restore',basisId:null});
 return{row,sourceId:prepared.sourceId,sourceDigest:prepared.sourceDigest,sourceEventAt:prepared.sourceEventAt,financialSource:kind==='HISTORICAL_EARNINGS_LOG'?'UNKNOWN' as const:'OBSERVATION_ONLY' as const};
}

export type FinanceObservationSourcePreview=ReturnType<typeof frozenObservation>&{executable:false;identityAudit:'UNBOUND'};
/** Source-only preparation needs the frozen mapping, not a fabricated migration-audit digest. Import admission stays separate. */
export function previewFrozenFinanceObservation(kind:ObservationKind,raw:Record<string,unknown>,s:PreviewSubject):FinanceObservationSourcePreview{
 previewSubject(s);
 let normalized=raw;
 if(kind==='HISTORICAL_DISTRIBUTION'){
  ensureOnlyFields(raw,['id','sn','user_id','order_type','order_id','earnings','level','level_id','ratio','status','settle_time','is_delete','create_time','update_time']);
  normalized={...raw};
  for(const key of ['id','user_id','order_type','order_id','level','level_id','status','settle_time','is_delete','create_time','update_time']){
   const value=raw[key];if(typeof value==='number'&&!Number.isSafeInteger(value))throw invalid('Original frozen integer required');
   if(typeof value!=='number'&&typeof value!=='string')throw invalid('Original frozen distribution field required');
   normalized[key]=String(value);
  }
 }
 const result=frozenObservation(kind,normalized,s);
 if(kind==='HISTORICAL_DISTRIBUTION'){
  result.row.rawSource=rawEvidence('la_distribution_order',raw);
  result.row.sourceRatio=raw.ratio??null;
  const prepared=prepareHistoricalObservation(result.row,{userId:s.userId,legacyUserId:s.legacyUserId,sourceSystem:'legacy_mysql_restore',basisId:null});
  result.sourceDigest=prepared.sourceDigest;
 }
 return{...result,executable:false as const,identityAudit:'UNBOUND' as const};
}

/** Construct an exact observation/coverage body, without credentials, approval or a DB call. A zero source universe is explicit. */
export function prepareFrozenFinanceHistory(input:{subject:Subject;sourceKind:ObservationKind;inputSha256:string;cutoff:string;sourceCount:number;rows:Record<string,unknown>[];isolated:{sourceId:string;sourceDigest:string;reason:string}[]}):ObservationImportInput{
 subject(input.subject);if(!Array.isArray(input.rows))throw invalid('Frozen rows required');
 const rows=input.rows.map(r=>prepareFrozenFinanceObservation(input.sourceKind,r,input.subject));
 if(rows.some(r=>r.sourceEventAt>input.cutoff))throw invalid('Source event exceeds the frozen cutoff');
 const coverage={...input.subject,sourceSystem:'legacy_mysql_restore',sourceKind:input.sourceKind,inputSha256:input.inputSha256,cutoff:input.cutoff,sourceCount:input.sourceCount,imported:rows.map(({sourceId,sourceDigest})=>({sourceId,sourceDigest})),isolated:input.isolated};
 prepareObservationCoverage(coverage);return{coverage,observations:rows.map(r=>r.row)};
}

export type StoredSourceCandidate={legacyId:string;targetUserId:string|null;storedEarningsCents:string;storedMoneyCents:string;sourceDigest:string;admission:'IDENTITY_ISOLATED'|'DUPLICATE_SELECTED_SEPARATE_REVIEW'|'MAPPED_PENDING_BATCH_APPROVAL'};
export type ReviewedEconomicSource={sourceKind:string;sourceEntity:string;sourceId:string;beneficiaryRole:string;sourceEventAt:string;sourceCanonical:string;sourceDigest:string};
/** A preparation result is never a FinanceOpeningAdmission. The real writer still checks its opaque review/current audit/resource. */
export function prepareStoredOpeningCandidate(input:{candidate:StoredSourceCandidate;subject:Subject;source:{id:string;earnings:string;money:string};inputSha256:string;cutoff:string;covered:ReviewedEconomicSource[];observations:Record<string,unknown>[];included:string[]}):{state:'REVIEW_REQUIRED';reason:string}|{state:'CANDIDATE';executable:false;input:StoredOpeningInput;sourceReviews:ReviewedEconomicSource[]}{
 const {candidate:c,subject:s,source}=input;subject(s);ensureOnlyFields(source,['id','earnings','money']);
 if(c.admission!=='MAPPED_PENDING_BATCH_APPROVAL')return{state:'REVIEW_REQUIRED',reason:c.admission};
 if(c.legacyId!==s.legacyUserId||c.targetUserId!==s.userId||source.id!==s.legacyUserId||sha(JSON.stringify({id:source.id,earnings:source.earnings,money:source.money}))!==c.sourceDigest
  ||sourceYuanToCents(source.earnings)!==c.storedEarningsCents||sourceSignedYuanToCents(source.money)!==c.storedMoneyCents||!digest.test(input.inputSha256)
  ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.cutoff)||!Number.isFinite(Date.parse(input.cutoff)))throw invalid('Stored original subject/amount/digest changed');
 if(!Array.isArray(input.covered)||!Array.isArray(input.observations)||!Array.isArray(input.included)||new Set(input.included).size!==input.included.length)throw invalid('Exact source review/observation sets required');
 const covered=input.covered.map(r=>{
  if(!old.test(r.sourceId)||!digest.test(r.sourceDigest)||sha(r.sourceCanonical)!==r.sourceDigest||canonicalize(JSON.parse(r.sourceCanonical))!==r.sourceCanonical
   ||!/^\d{1,10}$/.test(r.sourceEventAt)||BigInt(r.sourceEventAt)<1n||BigInt(r.sourceEventAt)>4294967295n||Number(r.sourceEventAt)*1000>Date.parse(input.cutoff))throw invalid('Original economic canonical/time required');
  if(!(r.sourceKind==='LEGACY_DISTRIBUTION_EARNING'&&r.sourceEntity==='la_distribution_order'&&['TASK_REFERRAL','RENTER_REFERRAL','OWNER_REFERRAL'].includes(r.beneficiaryRole)
   ||r.sourceKind==='LEGACY_WITHDRAWAL'&&r.sourceEntity==='la_withdraw_apply'&&r.beneficiaryRole==='WALLET_HOLDER'
   ||['LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION'].includes(r.sourceKind)&&r.sourceEntity==='la_order'&&r.beneficiaryRole==='OWNER'
   ||r.sourceKind==='LEGACY_ADMIN_LOG'&&r.sourceEntity==='la_log_earnings'&&r.beneficiaryRole==='WALLET_HOLDER'))throw invalid('Reviewed typed economic source required');
  return[s.userId,r.sourceKind,'LEGACY_MYSQL',r.sourceEntity,r.sourceId,r.beneficiaryRole,r.sourceEventAt,r.sourceDigest];
 }).sort((a,b)=>{const x=JSON.stringify(a.slice(1,6)),y=JSON.stringify(b.slice(1,6));return x<y?-1:x>y?1:0;});
 if(new Set(covered.map(r=>JSON.stringify(r.slice(1,6)))).size!==covered.length)throw invalid('Duplicate economic root');
 const included=new Set(input.included),seen=new Set<string>();
 const admissions=input.observations.map(row=>{
  const p=prepareHistoricalObservation(row,{userId:s.userId,legacyUserId:s.legacyUserId,sourceSystem:'legacy_mysql_restore',basisId:null}),key=p.sourceEntity+':'+p.sourceId;
  if(seen.has(key)||p.sourceEventAt>input.cutoff)throw invalid('Duplicate/outside historical observation');seen.add(key);
  return{sourceEntity:p.sourceEntity,sourceId:p.sourceId,sourceDigest:p.sourceDigest,sourceEventAt:p.sourceEventAt,included:included.has(key)};
 });
 if(input.included.some(k=>!seen.has(k)))throw invalid('Included observation absent from reviewed set');
 if(input.observations.some(r=>r.kind==='earningsLog'&&r.referenceType==='UNRESOLVED_ECONOMIC_SOURCE'))return{state:'REVIEW_REQUIRED',reason:'ECONOMIC_SOURCE_REVIEW_INCOMPLETE'};
 const body:StoredOpeningInput={inputSha256:input.inputSha256,cutoff:input.cutoff,sourceCanonical:canonicalize(source),proof:{userId:s.userId,source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',sourceId:s.legacyUserId,identityDigest:s.identityDigest},availableCents:c.storedEarningsCents,sourceDigest:c.sourceDigest,coveredCount:covered.length,coveredDigest:sha(covered.map(r=>JSON.stringify(r)).join('\n')),coveredSet:covered},observations:input.observations,admissions};
 return{state:'CANDIDATE',executable:false,input:body,sourceReviews:input.covered};
}
