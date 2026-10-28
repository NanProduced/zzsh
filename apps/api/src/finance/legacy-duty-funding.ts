import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {SecurityApiError} from '../auth/security-core';
import {prepareHistoricalObservation,sourceYuanToCents} from './personal-finance-read';
import {readObservationCoverage} from './personal-finance-coverage';
import type {ReviewedOpeningLogBinding} from './legacy-finance-source-evidence';
import {LEGACY_DUTY_FINANCE_CONTRACT,type LegacyDutyFinalBasis,type LegacyDutyFundingProof,type LegacyFinanceDuty} from './legacy-duty-finance';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Legacy funding immutable source witness is inconsistent');
/** Exact inherited source meanings. An unresolved positive credit may be this liability and cannot be ignored. */
export const LEGACY_DUTY_CREDIT_SOURCES={RENTER_REFUND:['LEGACY_RENTAL_REFUND'],OWNER_CREDIT:['LEGACY_RENTAL_OWNER_INCOME'],COMMISSION:['LEGACY_DISTRIBUTION_EARNING'],DEPOSIT_COMPENSATION:['LEGACY_DEPOSIT_COMPENSATION']} as const;

/** Called after T has verified the immutable terminal basis and after the complete user/order prefix.
 * Missing source evidence is UNKNOWN. A review DTO or a zero matching target query never creates a witness. */
export async function readLegacyDutyFundingProof(c:PoolClient,duty:LegacyFinanceDuty,basis:LegacyDutyFinalBasis):Promise<{knowledge:'KNOWN';proof:LegacyDutyFundingProof}|{knowledge:'UNKNOWN';reason:string}>{
 if(!duty.counterpartyUserId||duty.id!==basis.dutyId||basis.amountCents!==duty.amountCents)return{knowledge:'UNKNOWN',reason:'DUTY_FINAL_BASIS_NOT_BOUND'};
 const opening=(await c.query(`/* legacy funding immutable opening */ SELECT b.id,b.source_system,b.source_id,b.source_digest,b.covered_set_digest,
  to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff
  FROM zzsh_order.wallet_coverage wc JOIN zzsh_order.finance_opening_basis b ON b.id=wc.basis_id AND b.user_id=wc.user_id
  WHERE wc.user_id=$1 AND wc.origin='RECONCILED_OPENING' AND b.source_kind='LEGACY_OPENING'`,[duty.counterpartyUserId])).rows[0];
 if(!opening)return{knowledge:'UNKNOWN',reason:'LEGACY_OPENING_WITNESS_NOT_ADMITTED'};
 if(opening.source_system!=='legacy_mysql_restore'||typeof opening.source_id!=='string')throw unavailable();
 const contract=(await c.query(`/* legacy reviewed source proof contract */ SELECT to_regprocedure('zzsh_order.legacy_opening_source_proof(text)') IS NOT NULL AS ready`)).rows[0];
 if(typeof contract?.ready!=='boolean')throw unavailable();
 const sourceProof=contract.ready?(await c.query(`/* sealed legacy source bindings only; no raw review */ SELECT zzsh_order.legacy_opening_source_proof($1) AS proof`,[opening.id])).rows[0]?.proof:null;
 if(sourceProof!=null&&(sourceProof.schema!=='reviewed-opening-log-bindings.v1'||sourceProof.basisId!==opening.id||sourceProof.userId!==duty.counterpartyUserId
  ||sourceProof.legacyUserId!==opening.source_id||sourceProof.sourceDigest!==opening.source_digest||sourceProof.coveredDigest!==opening.covered_set_digest
  ||sourceProof.cutoff!==opening.cutoff||!Array.isArray(sourceProof.logBindings)||sourceProof.logBindings.length>10000
  ||typeof sourceProof.digest!=='string'||!/^[a-f0-9]{64}$/.test(sourceProof.digest)))throw unavailable();
 const logBindings=new Map<string,ReviewedOpeningLogBinding>();
 for(const b of sourceProof?.logBindings??[]){if(typeof b.observationId!=='string'||logBindings.has(b.observationId)||!['observationDigest','sourceDigest'].every(k=>typeof b[k]==='string'&&/^[a-f0-9]{64}$/.test(b[k]))
   ||!['sourceKind','sourceEntity','sourceId','beneficiaryRole'].every(k=>typeof b[k]==='string'))throw unavailable();logBindings.set(b.observationId,b);}
 const coverage=await readObservationCoverage(c,duty.counterpartyUserId,'HISTORICAL_EARNINGS_LOG');
 if(coverage.knowledge!=='KNOWN')return{knowledge:'UNKNOWN',reason:coverage.reason};
 if(coverage.cutoff!==opening.cutoff)return{knowledge:'UNKNOWN',reason:'OPENING_AND_HISTORY_CUTOFF_DIFFER'};
 const order=(await c.query(`/* legacy funding original order identity */ SELECT legacy_id,original_order_no FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1 AND source_digest=$2`,[duty.orderId,basis.parentSourceDigest])).rows[0];
 if(!order||String(order.legacy_id)!==basis.parentSourceId)return{knowledge:'UNKNOWN',reason:'LEGACY_FUNDING_ORDER_SOURCE_MISSING'};
 const sourceId=duty.kind==='COMMISSION'?duty.sourceRecordId:String(order.legacy_id),entity=duty.kind==='COMMISSION'?'la_distribution_order':'la_order';
 const covered=await c.query(`/* legacy funding covered responsibility */ SELECT 1 FROM zzsh_order.finance_covered_event WHERE user_id=$1 AND source_entity=$2 AND source_id=$3 AND source_kind=ANY($4::text[])`,[duty.counterpartyUserId,entity,sourceId,LEGACY_DUTY_CREDIT_SOURCES[duty.kind]]);
 if(covered.rowCount)return{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_ALREADY_IN_STORED'};
 const rows=(await c.query(`/* legacy funding complete earning references */ SELECT source_id,source_digest,source_canonical,snapshot FROM zzsh_order.personal_finance_observation
  WHERE user_id=$1 AND source_kind='HISTORICAL_EARNINGS_LOG' AND source_system='legacy_mysql_restore' AND source_entity='la_log_earnings' ORDER BY source_id COLLATE "C" LIMIT 20001`,[duty.counterpartyUserId])).rows;
 if(rows.length>20000)return{knowledge:'UNKNOWN',reason:'LEGACY_FUNDING_SUBJECT_HISTORY_LIMIT'};
 if(String(rows.length)!==coverage.count)throw unavailable();
 const refs:string[]=[];const relevant=LEGACY_DUTY_CREDIT_SOURCES[duty.kind] as readonly string[];
 const knownTypes=new Set([...Object.values(LEGACY_DUTY_CREDIT_SOURCES).flat(),'LEGACY_WITHDRAWAL','LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN']);
 const coveredRoots=rows.length?(await c.query(`/* legacy funding immutable credited roots */ SELECT source_kind,source_entity,source_id,source_type,source_digest,beneficiary_role FROM zzsh_order.finance_covered_event WHERE basis_id=$1 AND user_id=$2 ORDER BY source_kind,source_entity,source_id COLLATE "C" LIMIT 20001`,[opening.id,duty.counterpartyUserId])).rows:[];
 if(coveredRoots.length>20000)return{knowledge:'UNKNOWN',reason:'LEGACY_FUNDING_COVERED_ROOT_LIMIT'};
 if(coveredRoots.some(r=>r.source_type!=='LEGACY_MYSQL'||typeof r.source_digest!=='string'||!/^[a-f0-9]{64}$/.test(r.source_digest)))throw unavailable();
 const rootKeys=new Set(coveredRoots.map(r=>canonicalize([r.source_kind,r.source_entity,r.source_id])));
 for(const row of rows){
  let original:Record<string,unknown>;try{original=JSON.parse(row.source_canonical);const p=prepareHistoricalObservation(original,{userId:duty.counterpartyUserId,legacyUserId:opening.source_id,sourceSystem:opening.source_system,basisId:null});if(p.sourceDigest!==row.source_digest||p.sourceId!==row.source_id||p.sourceCanonical!==row.source_canonical||canonicalize(row.snapshot)!==p.sourceCanonical)throw unavailable();}catch{throw unavailable();}
  refs.push(row.source_id+':'+row.source_digest);
  if(original.action!==1||sourceYuanToCents(original.amount)==='0')continue;
  const binding=logBindings.get(row.source_id);
  if(binding){
   if(binding.observationDigest!==row.source_digest||!coveredRoots.some(r=>r.source_kind===binding.sourceKind&&r.source_entity===binding.sourceEntity
    &&r.source_id===binding.sourceId&&r.source_digest===binding.sourceDigest&&r.beneficiary_role===binding.beneficiaryRole))throw unavailable();
   if(relevant.includes(binding.sourceKind)&&binding.sourceEntity===entity&&binding.sourceId===sourceId)return{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_PREVIOUSLY_CREDITED'};
   continue;
  }
  if(original.referenceType==='LEGACY_WITHDRAWAL_RETURN')return{knowledge:'UNKNOWN',reason:'LEGACY_WITHDRAWAL_RETURN_PROOF_NOT_REVIEWED'};
  if(typeof original.referenceType!=='string'||!knownTypes.has(original.referenceType))return{knowledge:'UNKNOWN',reason:'LEGACY_POSITIVE_CREDIT_REFERENCE_UNRESOLVED'};
  if(relevant.includes(original.referenceType)&&[sourceId,String(order.original_order_no)].includes(String(original.referenceId))
   ||relevant.includes(original.referenceType)&&String(original.referenceSn)===String(order.original_order_no))return{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_PREVIOUSLY_CREDITED'};
  const logRoot=['LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN'].includes(original.referenceType);
  const priorEntity=original.referenceType==='LEGACY_DISTRIBUTION_EARNING'?'la_distribution_order':original.referenceType==='LEGACY_WITHDRAWAL'?'la_withdraw_apply':logRoot?'la_log_earnings':'la_order';
  const priorId=logRoot?row.source_id:String(original.referenceId);
  if(!rootKeys.has(canonicalize([original.referenceType,priorEntity,priorId])))return{knowledge:'UNKNOWN',reason:'LEGACY_POSITIVE_CREDIT_SOURCE_NOT_PROVEN'};
 }
 const other=await c.query(`/* legacy funding other final responsibility */ SELECT 1 FROM zzsh_order.legacy_duty_finance_fact WHERE order_id=$1 AND kind=$2 AND subject_user_id=$3 AND (duty_id=$4 OR facts_canonical::jsonb#>>'{duty,sourceRecordId}'=$5)`,[duty.orderId,duty.kind,duty.counterpartyUserId,duty.id,duty.sourceRecordId]);
 if(other.rowCount)return{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_HAS_FINAL_POSTING'};
 const witness={openingBasisId:opening.id as string,openingSourceDigest:opening.source_digest as string,coveredSetDigest:opening.covered_set_digest as string,historyCoverageVersion:coverage.version,historyReferenceDigest:sha(refs.join('\n')),historyCutoff:coverage.cutoff,sourceCount:coverage.count,
  ...(sourceProof?{sourceProofDigest:sourceProof.digest as string}:{})};
 return{knowledge:'KNOWN',proof:{contractVersion:LEGACY_DUTY_FINANCE_CONTRACT,dutyId:duty.id,orderId:duty.orderId,kind:duty.kind,subjectId:duty.counterpartyUserId,amountCents:duty.amountCents,currency:'CNY',originalSourceSystem:'legacy_mysql_restore',originalSourceEntity:entity,originalSourceId:sourceId,originalSourceDigest:duty.kind==='COMMISSION'?basis.sourceRecordDigest:basis.parentSourceDigest,originalOrderNumber:order.original_order_no||null,finalEvidenceDigest:basis.evidenceDigest,coverageDecision:'NOT_PREVIOUSLY_CREDITED',coverageEvidenceDigest:sha(canonicalize(witness)),sourceStatus:'CONFIRMED_UNPAID_LIABILITY',evidenceRef:basis.evidenceId,witness}};
}
