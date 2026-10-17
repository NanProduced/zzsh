import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,fingerprintRequest,invalid} from '../supply/supply-util';
import {legacyOwnerUserId} from '../supply/legacy-user-migration';
import {assertLegacyCommissionEvidence,legacyCommissionMaturity,legacyEconomicDutyId,legacyPlanYuanToCents,legacyTimeMicros} from '../order/legacy-continuation-model';
import type {LegacyHistoricalLiabilityInput} from '../order/legacy-liability-intake';
import type {LegacyCompletedCommissionImport} from '../order/legacy-continuation-evidence';
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

/* ---------------------------------------------------------------------------------------------------------------------
 * FIN-ORDER-2 formal batch assembly. Pure and offline: it builds the exact bodies, idempotency keys and fingerprints that
 * the EXISTING maintenance commands consume (importLegacyHistoricalLiability / importLegacyCompletedCommission), and
 * preflights them against the sealed parent target facts and an optional root-supplied exact current read. It never
 * approves, never connects, and writeAllowed is always false: execution approval, target resource and the actor stay
 * outside this package. One bad row is isolated with its reason; it never fails or hides the rest of the batch.
 * ------------------------------------------------------------------------------------------------------------------- */
export type LegacyParentTargetFact={legacyId:string;parentOrderId:string;sourceDigest:string;bindingDigest:string;sourceSnapshot:Record<string,string|null>|null;sourceCompletedAt:string|null;ownerUserId:string;renterUserId:string;accountId:string};
export type LegacyCurrentDutyFact={id:string;kind:string;sourceRecordId:string;amountCents:string;status:string;counterpartyUserId:string|null;settledBy:string|null;admissionId?:string|null};
/** Exact current read for one target order (root window). Absent means CURRENT_TARGET_UNREAD: never admitted, never 0. */
export type LegacyCurrentTargetFact={orderId:string;readRef:string;headRevision:string|null;depositAmountCents:string|null;duties:LegacyCurrentDutyFact[]};
export type LegacyBatchRowState='ADMISSION_CANDIDATE'|'ALREADY_APPLIED'|'MISSING_FACT'|'CONFLICT'|'LEGACY_TERMINAL'|'OBSERVE_ONLY';
export type LegacyBatchCommand<B>={operation:string;resourceId:string;idempotencyKey:string;fingerprint:string;body:B;recovery:'REPLAY_SAME_ACTOR_KEY_BODY'};
export type LegacyBatchEffect={dutyId:string;kind:'RENTER_REFUND'|'DEPOSIT_COMPENSATION'|'COMMISSION';amountCents:string;beneficiaryUserId:string|null;status:'PENDING'|'SETTLED';settledBy:'LEGACY_RECORDS'|null;maturityAt?:string;maturedByCutoff?:boolean};
export type LegacyBatchRow<B>={sourceKey:string;orderId:string|null;group:string;state:LegacyBatchRowState;admitted:boolean;reasons:string[];command:LegacyBatchCommand<B>|null;effect:LegacyBatchEffect|null};
export type LegacyBatchAssembly<B>={schema:'legacy-finance-order-batch.v1';family:string;batchId:string;writeAllowed:false;inputDigest:string;rows:LegacyBatchRow<B>[];
 counts:Record<LegacyBatchRowState,number>;byGroup:Record<string,{rows:number;effectCents:string;states:Partial<Record<LegacyBatchRowState,number>>}>;conserved:boolean;distinctSourceKeys:number;pendingFacts:Record<string,number>};
const STATES:LegacyBatchRowState[]=['ADMISSION_CANDIDATE','ALREADY_APPLIED','MISSING_FACT','CONFLICT','LEGACY_TERMINAL','OBSERVE_ONLY'];
const code=(e:unknown)=>e instanceof Error&&/^[A-Z][A-Z0-9_]{2,80}$/.test(e.message)?e.message:'SOURCE_EVIDENCE_INVALID';
const proofOf=(row:Record<string,unknown>)=>{const canonical=canonicalize(row);return{canonical,digest:sha(canonical)};};
function indexParents(parents:readonly LegacyParentTargetFact[]){const m=new Map<string,LegacyParentTargetFact>();for(const p of parents){if(m.has(p.legacyId))throw invalid('Duplicate parent target fact');m.set(p.legacyId,p);}return m;}
function indexCurrent(current:readonly LegacyCurrentTargetFact[]|null){if(current===null)return null;const m=new Map<string,LegacyCurrentTargetFact>();for(const c of current){if(m.has(c.orderId)||!c.readRef)throw invalid('Exact current target read required');m.set(c.orderId,c);}return m;}
/** Parent binding exactly as legacy_order_read_snapshot holds it; the A/F row only nominates it. */
function bindParent(p:LegacyParentTargetFact|undefined,mappedOrderId:string):{reasons:string[];state:LegacyBatchRowState|null}{
 if(!p||!p.sourceSnapshot)return{state:'MISSING_FACT',reasons:['CURRENT_PARENT_TARGET_MISSING']};
 if(p.parentOrderId!==mappedOrderId||p.parentOrderId!=='legacy_order_'+sha(JSON.stringify(['legacy_mysql_restore','la_order',p.legacyId])).slice(0,40))return{state:'CONFLICT',reasons:['PARENT_TARGET_MISMATCH']};
 if(sha(canonicalize(p.sourceSnapshot))!==p.sourceDigest||p.sourceSnapshot.id!==p.legacyId)return{state:'CONFLICT',reasons:['PARENT_SOURCE_DIGEST_MISMATCH']};
 return{state:null,reasons:[]};
}
function existingDutyState(cur:LegacyCurrentTargetFact|undefined,effect:LegacyBatchEffect,sourceRecordId:string):{state:LegacyBatchRowState|null;reasons:string[]}{
 if(!cur)return{state:null,reasons:['CURRENT_TARGET_UNREAD']};
 // the command's economic key is (order, kind, source record); any row on that key with another id/amount/beneficiary conflicts
 const keyed=cur.duties.filter(d=>d.id===effect.dutyId||d.kind===effect.kind&&d.sourceRecordId===sourceRecordId);
 if(keyed.length===0)return{state:null,reasons:[]};
 const d=keyed[0]!;
 if(keyed.length!==1||d.id!==effect.dutyId||d.kind!==effect.kind||d.sourceRecordId!==sourceRecordId||d.amountCents!==effect.amountCents||d.counterpartyUserId!==effect.beneficiaryUserId)return{state:'CONFLICT',reasons:['LIABILITY_ECONOMIC_KEY_CONFLICT']};
 return{state:'ALREADY_APPLIED',reasons:d.status===effect.status?['ORIGINAL_KEY_REPLAY_ONLY']:['DUTY_ALREADY_'+d.status,'ORIGINAL_KEY_REPLAY_ONLY']};
}
function summarize<B>(family:string,batchId:string,inputDigest:string,rows:LegacyBatchRow<B>[],sourceRows:number):LegacyBatchAssembly<B>{
 const counts=Object.fromEntries(STATES.map(s=>[s,0])) as Record<LegacyBatchRowState,number>,byGroup:LegacyBatchAssembly<B>['byGroup']={},pendingFacts:Record<string,number>={};
 for(const r of rows){counts[r.state]+=1;const g=byGroup[r.group]??={rows:0,effectCents:'0',states:{}};g.rows+=1;g.states[r.state]=(g.states[r.state]??0)+1;if(r.effect)g.effectCents=(BigInt(g.effectCents)+BigInt(r.effect.amountCents)).toString();
  if(!r.admitted)for(const reason of r.reasons)pendingFacts[reason]=(pendingFacts[reason]??0)+1;}
 // every input row (duplicates included, each as CONFLICT) has exactly one state; distinct keys are reported, not used to hide a row
 const conserved=rows.length===sourceRows&&STATES.reduce((n,s)=>n+counts[s],0)===sourceRows,distinctSourceKeys=new Set(rows.map(r=>r.sourceKey)).size;
 return{schema:'legacy-finance-order-batch.v1',family,batchId,writeAllowed:false,inputDigest,rows,counts,byGroup,conserved,distinctSourceKeys,pendingFacts};
}

type Disposition=LegacyHistoricalLiabilityInput['classification'];
export type LegacyLiabilitySourceRow={classification:Disposition;legacyOrderId:string;mappedOrderId:string;originalOrder:Record<string,string|null>|null;refundRecord:Record<string,unknown>|null;evidenceRef:string;nominated?:{amountCents:string}};
const SELECTED=['order_status','pay_is','is_settle','return_order_money','deposit_amount'],HELD_NEGATIVE=/^-(0|[1-9]\d{0,21})(?:\.\d{1,2})?$/;
/** 18/1 -> RENTER_REFUND net duty, 6 -> LEGACY_RECORDS terminal (not payable), 61 -> REFUND_SOURCE_RECORD_ONLY audit (no duty). */
export function assembleLegacyLiabilityBatch(input:{batchId:string;parents:readonly LegacyParentTargetFact[];current:readonly LegacyCurrentTargetFact[]|null;rows:readonly LegacyLiabilitySourceRow[]}):LegacyBatchAssembly<LegacyHistoricalLiabilityInput>{
 const parents=indexParents(input.parents),current=indexCurrent(input.current),operation='order.legacy.liability.import';
 const counts=new Map<string,number>();for(const r of input.rows)counts.set(r.legacyOrderId,(counts.get(r.legacyOrderId)??0)+1);
 const rows=input.rows.map((r):LegacyBatchRow<LegacyHistoricalLiabilityInput>=>{
  const base={sourceKey:'la_order:'+r.legacyOrderId,orderId:r.mappedOrderId??null,group:r.classification,admitted:false,command:null,effect:null};
  try{
   if(!['COMPLETED_UNREFUNDED','DETAINED','POSTED_CONFISCATION','REFUND_RECORD_EXISTS'].includes(r.classification)||!old.test(r.legacyOrderId)||!r.evidenceRef||r.evidenceRef.length>512)return{...base,state:'CONFLICT',reasons:['LIABILITY_SOURCE_INVALID']};
   if(counts.get(r.legacyOrderId)!==1)return{...base,state:'CONFLICT',reasons:['DUPLICATE_SOURCE_ROW']};
   const parent=parents.get(r.legacyOrderId),b=bindParent(parent,r.mappedOrderId);if(b.state)return{...base,state:b.state,reasons:b.reasons};
   const snap=parent!.sourceSnapshot!,order=r.originalOrder;
   if(!order||!Object.hasOwn(order,'detain_money'))return{...base,state:'MISSING_FACT',reasons:['ORIGINAL_DETAIN_COLUMN_MISSING']};
   // the frozen original row may carry fewer columns than the snapshot; every shared column must agree and the selected ones must exist
   if(SELECTED.some(k=>!Object.hasOwn(order,k)))return{...base,state:'MISSING_FACT',reasons:['ORIGINAL_SELECTED_FIELDS_MISSING']};
   if(Object.keys(snap).some(k=>Object.hasOwn(order,k)&&order[k]!==snap[k]))return{...base,state:'CONFLICT',reasons:['LIABILITY_SOURCE_EVIDENCE_MISMATCH']};
   const record:Record<string,string|null>={...Object.fromEntries(Object.keys(snap).map(k=>[k,snap[k]!])),detain_money:order.detain_money!};
   const status=Number(snap.order_status),held=snap.is_settle;
   if(snap.pay_is!=='1')return{...base,state:'CONFLICT',reasons:['LIABILITY_SOURCE_BINDING']};
   const expected=r.classification==='COMPLETED_UNREFUNDED'?held==='0'&&status===4:r.classification==='DETAINED'?held==='2'&&status===4:r.classification==='POSTED_CONFISCATION'?held==='3':status===5;
   if(!expected)return{...base,state:'CONFLICT',reasons:['LIABILITY_CLASSIFICATION_MISMATCH']};
   const settlementRecord=proofOf(record);
   const body:LegacyHistoricalLiabilityInput={orderId:r.mappedOrderId,parentSourceDigest:parent!.sourceDigest,classification:r.classification,evidenceRef:r.evidenceRef,settlementRecord};
   let effect:LegacyBatchEffect|null=null,state:LegacyBatchRowState='ADMISSION_CANDIDATE';const reasons:string[]=[];
   if(r.classification==='REFUND_RECORD_EXISTS'){
    const rec=r.refundRecord;
    if(!rec||rec.order_id!==r.legacyOrderId||typeof rec.id!=='string'||!old.test(rec.id))return{...base,state:'MISSING_FACT',reasons:['REFUND_RECORD_EVIDENCE_MISSING']};
    if(typeof record.return_order_money!=='string'||BigInt(legacyPlanYuanToCents(record.return_order_money))<=0n)return{...base,state:'CONFLICT',reasons:['CANCELLED_POSITIVE_RETURN_REQUIRED']};
    body.refundRecord=proofOf(rec);state='OBSERVE_ONLY';reasons.push('REFUND_SOURCE_RECORD_ONLY','CHANNEL_ARRIVAL_UNKNOWN');
   }else if(r.classification==='POSTED_CONFISCATION'){
    const cur=current?.get(r.mappedOrderId),deposit=cur?.depositAmountCents??null;
    effect={dutyId:legacyEconomicDutyId(r.mappedOrderId,'DEPOSIT_COMPENSATION',r.legacyOrderId),kind:'DEPOSIT_COMPENSATION',amountCents:deposit??legacyPlanYuanToCents(snap.deposit_amount??''),beneficiaryUserId:parent!.ownerUserId,status:'SETTLED',settledBy:'LEGACY_RECORDS'};
    state='LEGACY_TERMINAL';reasons.push('LEGACY_TERMINAL_NO_PAYABLE');if(cur&&deposit===null)return{...base,state:'MISSING_FACT',reasons:['DEPOSIT_AMOUNT_UNPROVEN']};if(!cur)reasons.push('TARGET_DEPOSIT_CENTS_UNREAD');
   }else{
    if(record.return_order_money===null||record.return_order_money===undefined)return{...base,state:'MISSING_FACT',reasons:['REFUND_AMOUNT_UNPROVEN']};
    const gross=BigInt(legacyPlanYuanToCents(record.return_order_money)),raw=record.detain_money,detain=raw==null||HELD_NEGATIVE.test(raw)?0n:BigInt(legacyPlanYuanToCents(raw));
    if(gross<detain)return{...base,state:'CONFLICT',reasons:['REFUND_NET_NEGATIVE']};
    effect={dutyId:legacyEconomicDutyId(r.mappedOrderId,'RENTER_REFUND',r.legacyOrderId),kind:'RENTER_REFUND',amountCents:(gross-detain).toString(),beneficiaryUserId:parent!.renterUserId,status:'PENDING',settledBy:null};
   }
   if(r.nominated&&r.nominated.amountCents!==(effect?.amountCents??'0'))return{...base,state:'CONFLICT',reasons:['NOMINATED_AMOUNT_DRIFT'],effect};
   const command={operation,resourceId:r.mappedOrderId,idempotencyKey:sha(r.mappedOrderId),fingerprint:fingerprintRequest(operation,r.mappedOrderId,body),body,recovery:'REPLAY_SAME_ACTOR_KEY_BODY' as const};
   if(effect){const e=existingDutyState(current?.get(r.mappedOrderId),effect,r.legacyOrderId);if(e.state==='CONFLICT')return{...base,state:'CONFLICT',reasons:e.reasons,command,effect};if(e.state)return{...base,state:e.state,reasons:[...reasons,...e.reasons],command,effect};reasons.push(...e.reasons);}
   else if(!current?.get(r.mappedOrderId))reasons.push('CURRENT_TARGET_UNREAD');
   return{...base,state,admitted:!reasons.includes('CURRENT_TARGET_UNREAD')&&!reasons.includes('TARGET_DEPOSIT_CENTS_UNREAD'),reasons,command,effect};
  }catch(e){return{...base,state:'CONFLICT',reasons:[code(e)]};}
 });
 return summarize('LEGACY_LIABILITY_86',input.batchId,sha(canonicalize(input as unknown as Record<string,unknown>)),rows,input.rows.length);
}

export type LegacyCommissionSourceRow={sourceRecord:Record<string,unknown>;parentLegacyOrderId:string;mappedOrderId:string;bucket:'INFLIGHT_PARENT'|'COMPLETED_PARENT';evidenceRef:string;nominated?:{beneficiaryLegacyId:string;amountCents:string}};
/** 208 completed parents -> existing importLegacyCompletedCommission body (original amount/time + old 7 days vs the real
 *  cutoff). 162 in-flight rows stay source facts until a real T confirm; status 2/3 stay settled/void source facts. */
export function assembleLegacyCompletedCommissionBatch(input:{batchId:string;cutoff:string;parents:readonly LegacyParentTargetFact[];current:readonly LegacyCurrentTargetFact[]|null;verifiedBeneficiaries:readonly string[]|null;rows:readonly LegacyCommissionSourceRow[]}):LegacyBatchAssembly<LegacyCompletedCommissionImport>{
 const parents=indexParents(input.parents),current=indexCurrent(input.current),operation='order.legacy.commission.completed-import';
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(input.cutoff))throw invalid('Exact six-digit source cutoff required');legacyTimeMicros(input.cutoff);
 const verified=input.verifiedBeneficiaries===null?null:new Set(input.verifiedBeneficiaries);
 const ids=new Map<string,number>();for(const r of input.rows){const k=String(r.sourceRecord?.id);ids.set(k,(ids.get(k)??0)+1);}
 const rows=input.rows.map((r):LegacyBatchRow<LegacyCompletedCommissionImport>=>{
  const raw=r.sourceRecord??{},id=String(raw.id),base={sourceKey:'la_distribution_order:'+id,orderId:r.mappedOrderId??null,group:r.bucket,admitted:false,command:null,effect:null};
  try{
   if(!old.test(id)||raw.order_id!==r.parentLegacyOrderId||!r.evidenceRef||r.evidenceRef.length>512)return{...base,state:'CONFLICT',reasons:['COMMISSION_SOURCE_EVIDENCE_INVALID']};
   if(ids.get(id)!==1)return{...base,state:'CONFLICT',reasons:['DUPLICATE_SOURCE_ROW']};
   const commission={id,beneficiaryId:String(raw.user_id),level:String(raw.level),ratio:String(raw.ratio),status:String(raw.status),storedEarnings:String(raw.earnings)};
   if(raw.is_delete!==undefined&&raw.is_delete!=='0')return{...base,state:'CONFLICT',reasons:['COMMISSION_SOURCE_DELETED']};
   if(r.nominated&&(r.nominated.beneficiaryLegacyId!==commission.beneficiaryId||r.nominated.amountCents!==legacyPlanYuanToCents(commission.storedEarnings)))return{...base,state:'CONFLICT',reasons:['NOMINATED_BENEFICIARY_OR_AMOUNT_DRIFT']};
   if(commission.status==='2')return{...base,state:'OBSERVE_ONLY',reasons:['ALREADY_SETTLED_SOURCE']};
   if(commission.status==='3')return{...base,state:'OBSERVE_ONLY',reasons:['ALREADY_VOID_SOURCE']};
   if(r.bucket==='INFLIGHT_PARENT')return{...base,state:'OBSERVE_ONLY',reasons:['T_CONFIRM_RUNTIME']};
   const parent=parents.get(r.parentLegacyOrderId),b=bindParent(parent,r.mappedOrderId);if(b.state)return{...base,state:b.state,reasons:b.reasons};
   const snap=parent!.sourceSnapshot!;
   if(snap.order_status!=='4'||snap.pay_is!=='1')return{...base,state:'CONFLICT',reasons:['COMPLETED_COMMISSION_SOURCE_INVALID']};
   const sourceRecord={sourceRecordId:id,...proofOf(raw),evidenceRef:r.evidenceRef};
   assertLegacyCommissionEvidence(sourceRecord,r.parentLegacyOrderId,commission);
   if(!parent!.sourceCompletedAt)return{...base,state:'MISSING_FACT',reasons:['TARGET_COMPLETED_AT_UNBOUND']};
   const at=parent!.sourceCompletedAt,confirm=snap.confirm_time??'';
   if(!/^(0|[1-9]\d{0,11})$/.test(confirm)||BigInt(confirm)*1000000n!==legacyTimeMicros(at))return{...base,state:'CONFLICT',reasons:['COMPLETED_TIME_SOURCE_MISMATCH']};
   const amountCents=legacyPlanYuanToCents(commission.storedEarnings),sourceDigest=parent!.sourceDigest;
   const finalAmountEvidenceCanonical=canonicalize({parentSourceDigest:sourceDigest,sourceRecordDigest:sourceRecord.digest,beneficiaryLegacyId:commission.beneficiaryId,amountCents,cutoff:input.cutoff});
   const timeEvidenceCanonical=canonicalize({parentSourceDigest:sourceDigest,sourceRecordDigest:sourceRecord.digest,kind:'COMPLETED_AT',at,sourceValue:confirm,sourceUnit:'UNIX_SECONDS',cutoff:input.cutoff});
   const time={kind:'COMPLETED_AT' as const,at,evidenceDigest:sha(timeEvidenceCanonical)},maturity=legacyCommissionMaturity(time,input.cutoff);
   const body:LegacyCompletedCommissionImport={orderId:r.mappedOrderId,sourceDigest,finalAmountEvidenceDigest:sha(finalAmountEvidenceCanonical),finalAmountEvidenceCanonical,timeEvidenceCanonical,evidenceRef:r.evidenceRef,cutoff:input.cutoff,time,sourceTimeValue:confirm,sourceTimeUnit:'UNIX_SECONDS',commission,sourceRecord};
   const dutyId=legacyEconomicDutyId(r.mappedOrderId,'COMMISSION',id),beneficiaryUserId=legacyOwnerUserId('legacy_mysql_restore','la_user',commission.beneficiaryId);
   const effect:LegacyBatchEffect={dutyId,kind:'COMMISSION',amountCents,beneficiaryUserId,status:'PENDING',settledBy:null,maturityAt:maturity.maturityAt,maturedByCutoff:maturity.maturedByCutoff};
   const command={operation,resourceId:r.mappedOrderId,idempotencyKey:sha(id),fingerprint:fingerprintRequest(operation,r.mappedOrderId,body),body,recovery:'REPLAY_SAME_ACTOR_KEY_BODY' as const};
   const reasons:string[]=[];
   if(!verified||!verified.has(commission.beneficiaryId))reasons.push('BENEFICIARY_IDENTITY_UNVERIFIED');
   const admissionId='legacy_admission_'+sha(dutyId).slice(0,40),cur=current?.get(r.mappedOrderId);
   if(cur){const d=cur.duties.find(x=>x.id===dutyId);if(d){if(d.kind!=='COMMISSION'||d.sourceRecordId!==id||d.amountCents!==amountCents||d.counterpartyUserId!==beneficiaryUserId||(d.admissionId??null)!==admissionId)return{...base,state:'CONFLICT',reasons:['COMMISSION_ADMISSION_CONFLICT'],command,effect};
     return{...base,state:'ALREADY_APPLIED',reasons:d.status==='PENDING'?['ORIGINAL_KEY_REPLAY_ONLY']:['DUTY_ALREADY_'+d.status,'ORIGINAL_KEY_REPLAY_ONLY'],command,effect};}}
   else reasons.push('CURRENT_TARGET_UNREAD');
   return{...base,state:reasons.includes('BENEFICIARY_IDENTITY_UNVERIFIED')?'MISSING_FACT':'ADMISSION_CANDIDATE',admitted:reasons.length===0,reasons,command,effect};
  }catch(e){return{...base,state:'CONFLICT',reasons:[code(e)]};}
 });
 return summarize('LEGACY_COMMISSION_370',input.batchId,sha(canonicalize(input as unknown as Record<string,unknown>)),rows,input.rows.length);
}