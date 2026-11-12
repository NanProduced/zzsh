import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {recordAudit,setAuditContext,withTransaction} from '../auth/security-core';
import {canonicalize} from '../supply/content-hash';
import {conflict,ensureOnlyFields,fingerprintRequest,invalid,withIdempotency} from '../supply/supply-util';
import {authorizeFinanceMaintenance,assertFinanceMaintenanceResource,authorizeMaintenanceBatch,closeMaintenanceBatch,isReviewedFinanceMaintenanceEndpoint,isReviewedFinanceMaintenanceResource,type FinanceOpeningReview} from './personal-finance-maintenance';
import {prepareHistoricalObservation} from './personal-finance-read';
import {OBSERVATION_ENTITIES,prepareObservationCoverage,assertFinanceSingleCutoff,type ObservationCoverageInput} from './personal-finance-coverage';
import {authorizeSystemEmptyFinanceMigration,systemFinanceMigrationId,type SystemFinanceMigrationActor} from '../legacy-load/system-user-migration';

type Actor={userId:string;sessionId:string;requestId:string};
export type ObservationImportInput={coverage:ObservationCoverageInput;observations:Record<string,unknown>[]};
export type ObservationImportReview=Pick<FinanceOpeningReview,'ref'|'attempt'|'actor'|'resource'|'notBefore'|'expiresAt'|'inputSha256'|'cutoff'|'bodyDigest'>&{userId:string;sourceKind:ObservationCoverageInput['sourceKind']};
export type ObservationImportAdmission=Readonly<{kind:'REVIEWED_FINANCE_OBSERVATIONS'}>;
const admitted=new WeakMap<object,{review:ObservationImportReview;recoveryOnly:boolean;emptyBatchDigest?:string}>();
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=/^[a-f0-9]{64}$/;
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const operation='finance.history.import';
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

export function planFinanceObservations(input:ObservationImportInput){
 input=copy(input);ensureOnlyFields(input,['coverage','observations']);
 const c=prepareObservationCoverage(input.coverage);
 if(!Array.isArray(input.observations)||input.observations.length!==c.importedCount)throw invalid('Observation rows do not close reviewed coverage');
 const expected=new Map(input.coverage.imported.map(r=>[r.sourceId,r.sourceDigest]));
 const seen=new Set<string>();
 const observations=input.observations.map(snapshot=>{
  const p=prepareHistoricalObservation(snapshot,{userId:c.userId,legacyUserId:c.legacyUserId,sourceSystem:c.sourceSystem,basisId:null});
  if(p.sourceKind!==c.sourceKind||p.sourceEntity!==c.sourceEntity||expected.get(p.sourceId)!==p.sourceDigest||seen.has(p.sourceId)||p.sourceEventAt>c.cutoff)throw invalid('Observation tuple/digest/cutoff differs from reviewed coverage');
  seen.add(p.sourceId);return{...p,id:'history_'+sha(canonicalize([p.sourceSystem,p.sourceEntity,p.sourceId])).slice(0,40),snapshot};
 });
 return{coverage:c,observations,bodyDigest:sha(canonicalize(input)),key:'history-import-'+sha(canonicalize([c.userId,c.sourceSystem,c.sourceKind,c.cutoff])).slice(0,40)};
}

function binding(scope:ObservationImportAdmission){const b=admitted.get(scope);if(!b)throw invalid('Finance observation admission is not internally bound');return b;}
async function authorize(client:PoolClient,actor:Actor,scope:ObservationImportAdmission,input:ObservationImportInput,recover=false){
 const b=binding(scope),r=b.review,c=input.coverage;
 if(sha(canonicalize(input))!==r.bodyDigest||c.userId!==r.userId||c.sourceKind!==r.sourceKind||c.cutoff!==r.cutoff||c.inputSha256!==r.inputSha256)throw invalid('Observation input differs from exact internal review');
 await authorizeFinanceMaintenance(client,actor);
 await assertFinanceMaintenanceResource(client,actor,r,{recover,recoveryOnly:b.recoveryOnly});
 const schema=(await client.query(`/* finance history maintenance schema */ SELECT
  to_regclass('zzsh_order.personal_finance_observation_coverage') IS NOT NULL AS ready,
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_order.personal_finance_observation_coverage')) AS owner`)).rows[0];
 if(schema?.ready!==true||schema.owner!==r.resource.role)throw conflict('Historical coverage schema/owner is not admitted');
 const identity=await client.query(`/* finance history source identity */ SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
  AND details->>'sourceSystem'=$2 AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=$3 AND details->>'sourceDigest'=$4`,[c.userId,c.sourceSystem,c.legacyUserId,c.identityDigest]);
 if(identity.rowCount!==1)throw conflict('Historical observation source identity is not exact');
 return r;
}

function validateObservationImportReview(review:ObservationImportReview,mode:'execute'|'recover'){
 if(!review||typeof review!=='object'||!review.actor||!review.resource)throw invalid('Exact internal observation review required');
 ensureOnlyFields(review,['ref','attempt','actor','resource','notBefore','expiresAt','inputSha256','cutoff','bodyDigest','userId','sourceKind']);
 ensureOnlyFields(review.actor,['userId','sessionId']);ensureOnlyFields(review.resource,['host','port','database','oid','owner','marker','role','roleOid','migrationProfile','systemIdentifier','nonce']);
 const r=copy(review);
 if(![r.ref,r.attempt,r.actor.userId,r.actor.sessionId,r.userId].every(x=>typeof x==='string'&&identifier.test(x))
  ||!isReviewedFinanceMaintenanceEndpoint(r.resource)||!isReviewedFinanceMaintenanceResource(r.resource)
  ||![r.resource.owner,r.resource.role].every(x=>typeof x==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(x))
  ||![r.resource.oid,r.resource.roleOid].every(x=>Number.isSafeInteger(x)&&x>0)
  ||![r.inputSha256,r.bodyDigest].every(x=>typeof x==='string'&&digest.test(x))
  ||!Object.hasOwn(OBSERVATION_ENTITIES,r.sourceKind)
  ||![r.notBefore,r.expiresAt,r.cutoff].every(x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x)))
  ||Date.parse(r.notBefore)>=Date.parse(r.expiresAt)||Date.parse(r.cutoff)>Date.parse(r.notBefore)||!['execute','recover'].includes(mode))throw invalid('Exact observation resource/window required');
 return r;
}

/** Only a separately reviewed internal runner may supply this out-of-band binding. No HTTP entry. */
export async function bindReviewedFinanceObservationAdmission(client:PoolClient,actor:Actor,review:ObservationImportReview,mode:'execute'|'recover'='execute'):Promise<ObservationImportAdmission>{
 const r=validateObservationImportReview(review,mode);
 const token=Object.freeze({kind:'REVIEWED_FINANCE_OBSERVATIONS' as const});admitted.set(token,{review:copy(r),recoveryOnly:mode==='recover'});
 try{await authorizeFinanceMaintenance(client,actor);await assertFinanceMaintenanceResource(client,actor,r,{recover:mode==='recover',recoveryOnly:mode==='recover'});return token;}
 catch(e){admitted.delete(token);throw e;}
}
/** 批级绑定：逐个做纯 JS 评审校验，然后一次鉴权覆盖整批（批内必须共享 actor/resource/窗口）。 */
export async function bindReviewedFinanceObservationAdmissionBatch(client:PoolClient,actor:Actor,reviews:ObservationImportReview[],mode:'execute'|'recover'='execute'):Promise<ObservationImportAdmission[]>{
 if(!Array.isArray(reviews)||reviews.length<1||reviews.length>1000)throw invalid('Bounded observation review batch required');
 const normalized=reviews.map(r=>validateObservationImportReview(r,mode));
 await authorizeMaintenanceBatch(client,actor,normalized,{recover:mode==='recover',recoveryOnly:mode==='recover'});
 return normalized.map(r=>{const token=Object.freeze({kind:'REVIEWED_FINANCE_OBSERVATIONS' as const});admitted.set(token,{review:copy(r),recoveryOnly:mode==='recover'});return token;});
}

function exactObservation(row:Record<string,any>,expected:ReturnType<typeof planFinanceObservations>['observations'][number]){
 const at=new Date(row.source_event_at);
 return row.user_id===expected.userId&&row.legacy_user_id===expected.legacyUserId&&row.source_kind===expected.sourceKind
  &&row.source_type==='LEGACY_MYSQL'&&row.source_system===expected.sourceSystem&&row.source_entity===expected.sourceEntity&&row.source_id===expected.sourceId
  &&row.source_digest===expected.sourceDigest&&row.source_canonical===expected.sourceCanonical&&canonicalize(row.snapshot)===canonicalize(expected.snapshot)
  &&Number.isFinite(at.getTime())&&at.toISOString()===expected.sourceEventAt;
}

async function existingObservations(client:PoolClient,plan:ReturnType<typeof planFinanceObservations>){
 if(!plan.observations.length)return new Map<string,Record<string,any>>();
 const {sourceSystem,sourceEntity}=plan.coverage;
 const rows=(await client.query(`/* finance history existing observation */ SELECT * FROM zzsh_order.personal_finance_observation
   WHERE source_type='LEGACY_MYSQL' AND source_system=$1 AND source_entity=$2 AND source_id=ANY($3::text[])`,
 [sourceSystem,sourceEntity,plan.observations.map(o=>o.sourceId)])).rows;
 return new Map<string,Record<string,any>>(rows.map(row=>[row.source_id,row]));
}

/** Caller owns the transaction. Observations/coverage do not create opening, ledger, eligibility or a withdrawal. */
export async function importReviewedFinanceObservations(client:PoolClient,actor:Actor,input:ObservationImportInput,scope:ObservationImportAdmission){
 input=copy(input);const plan=planFinanceObservations(input),c=plan.coverage;
 await authorize(client,actor,scope,input);
 const result=await withIdempotency(client,{realm:'admin',principalId:actor.userId,operation},plan.key,fingerprintRequest(operation,c.id,input),async()=>{await authorize(client,actor,scope,input);},async()=>{
  await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[c.userId]);
  if(c.sourceKind==='HISTORICAL_EARNINGS_LOG')await assertFinanceSingleCutoff(client,{userId:c.userId,cutoff:c.cutoff,write:'OBSERVATION'});
  await setAuditContext(client,'admin',actor.userId,actor.sessionId,actor.requestId);
  const prior=await existingObservations(client,plan);
  for(const o of plan.observations){
   const existing=prior.get(o.sourceId);
   if(existing){if(!exactObservation(existing,o))throw conflict('Original observation changed; reconciliation required');continue;}
   await client.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,basis_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,source_event_at,included_in_opening,snapshot)
    VALUES($1,$2,NULL,$3,'LEGACY_MYSQL',$4,$5,$6,$7,$8,$9,$10::timestamptz,false,$11::jsonb)`,[o.id,o.userId,o.sourceKind,o.sourceSystem,o.legacyUserId,o.sourceEntity,o.sourceId,o.sourceDigest,o.sourceCanonical,o.sourceEventAt,JSON.stringify(o.snapshot)]);
  }
  await client.query(`INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
   VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[c.id,c.userId,c.sourceSystem,c.legacyUserId,c.sourceKind,c.sourceEntity,c.cutoff,c.inputSha256,c.identityDigest,c.sourceCount,c.importedCount,c.isolatedCount,c.sourceSetDigest,c.importedSetDigest,c.isolatedSetDigest,c.bodyDigest,c.canonical]);
  const r=binding(scope).review;
  await recordAudit(client,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,action:'finance.history.imported',objectType:'personal_finance_observation_coverage',objectId:c.id,requestId:actor.requestId,outcome:'SUCCESS',details:{bodyDigest:plan.bodyDigest,inputSha256:c.inputSha256,coverageBodyDigest:c.bodyDigest,subjectId:c.userId,sourceKind:c.sourceKind,sourceCount:c.sourceCount,importedCount:c.importedCount,isolatedCount:c.isolatedCount,approvalRef:r.ref,attempt:r.attempt,financialEffect:'NONE'}});
  return{status:200,body:{coverageId:c.id,subjectId:c.userId,sourceKind:c.sourceKind,bodyDigest:plan.bodyDigest,importedCount:c.importedCount,isolatedCount:c.isolatedCount,financialEffect:'NONE'}};
 });
 await authorize(client,actor,scope,input);return result;
}

export async function importReviewedFinanceObservationsBatch(pool:Pool,actor:Actor,inputs:ObservationImportInput[],scopes:ObservationImportAdmission[]){
 inputs=copy(inputs);if(inputs.length<1||inputs.length>1000||inputs.length!==scopes.length)throw invalid('Exact bounded observation batch required');
 const plans=inputs.map(planFinanceObservations);if(new Set(plans.map(p=>p.coverage.id)).size!==plans.length)throw invalid('Duplicate coverage in batch');
 const pairs=inputs.map((input,i)=>({input,scope:scopes[i]!,id:plans[i]!.coverage.userId+':'+plans[i]!.coverage.id})).sort((a,b)=>a.id<b.id?-1:1);
 return withTransaction(pool,async client=>{
  const results=[];for(const p of pairs)results.push(await importReviewedFinanceObservations(client,actor,p.input,p.scope));
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');return results;
 });
}

/** No receipt is UNKNOWN; read errors propagate. Never calls an importer or creates a new key. */
export async function recoverReviewedFinanceObservations(client:PoolClient,actor:Actor,input:ObservationImportInput,scope:ObservationImportAdmission){
 input=copy(input);const plan=planFinanceObservations(input),c=plan.coverage;
 const r=await authorize(client,actor,scope,input,true);
 const row=(await client.query(`SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[JSON.stringify(['admin',actor.userId,operation,null]),plan.key])).rows[0];
 if(!row)return{knowledge:'UNKNOWN' as const,key:plan.key,receipt:null};
 if(row.fingerprint!==fingerprintRequest(operation,c.id,input)||row.status!==200||row.body?.coverageId!==c.id||row.body?.subjectId!==c.userId||row.body?.sourceKind!==c.sourceKind||row.body?.bodyDigest!==plan.bodyDigest||row.body?.importedCount!==c.importedCount||row.body?.isolatedCount!==c.isolatedCount||row.body?.financialEffect!=='NONE')throw conflict('Historical recovery differs from original receipt');
 const coverage=(await client.query(`/* finance history recovery coverage */ SELECT body_digest FROM zzsh_order.personal_finance_observation_coverage WHERE id=$1 AND user_id=$2`,[c.id,c.userId])).rows[0];
 if(coverage?.body_digest!==c.bodyDigest)throw conflict('Historical recovery lacks original coverage');
 const prior=await existingObservations(client,plan);
 for(const o of plan.observations){const actual=prior.get(o.sourceId);if(!actual||!exactObservation(actual,o))throw conflict('Historical recovery observation differs from original input');}
 const audit=await client.query(`/* finance history recovery audit */ SELECT 1 FROM zzsh_iam.audit_event WHERE action='finance.history.imported' AND object_type='personal_finance_observation_coverage' AND object_id=$1 AND actor_type='admin' AND actor_id=$2 AND session_id=$3 AND outcome='SUCCESS' AND details->>'bodyDigest'=$4 AND details->>'approvalRef'=$5 AND details->>'attempt'=$6`,[c.id,actor.userId,actor.sessionId,plan.bodyDigest,r.ref,r.attempt]);
 if(audit.rowCount!==1)throw conflict('Historical recovery audit is incomplete');
 await authorize(client,actor,scope,input,true);
 return{knowledge:'KNOWN' as const,key:plan.key,receipt:{status:row.status,body:row.body},originalImportVerified:true,financialEffect:'NONE' as const};
}

function emptyPlans(inputs:ObservationImportInput[]){
 if(!Array.isArray(inputs)||inputs.length<1||inputs.length>400)throw invalid('Bounded proved-empty coverage batch required');
 const plans=inputs.map(input=>({input,plan:planFinanceObservations(input)}));
 if(plans.some(({plan})=>plan.coverage.sourceCount!==0||plan.coverage.importedCount!==0||plan.coverage.isolatedCount!==0||plan.observations.length!==0)||new Set(plans.map(p=>p.plan.coverage.id)).size!==plans.length)throw invalid('Every empty coverage must prove an exact zero source set');
 return plans.sort((a,b)=>{const left=a.plan.coverage.userId+':'+a.plan.coverage.id,right=b.plan.coverage.userId+':'+b.plan.coverage.id;return left<right?-1:left>right?1:0;});
}

/** Same per-subject source contract and original keys; only actor/resource checks are shared by one bounded transaction. */
export async function bindReviewedEmptyFinanceObservationBatch(client:PoolClient,actor:Actor,inputs:ObservationImportInput[],reviews:ObservationImportReview[],mode:'execute'|'recover'='execute'){
 const plans=emptyPlans(inputs);if(!Array.isArray(reviews)||reviews.length!==inputs.length)throw invalid('Every empty coverage needs its original exact review');
 const first=validateObservationImportReview(reviews[0]!,mode);
 for(let i=0;i<inputs.length;i++){
  const review=validateObservationImportReview(reviews[i]!,mode),input=inputs[i]!;
  if(review.bodyDigest!==sha(canonicalize(input))||review.userId!==input.coverage.userId||review.sourceKind!==input.coverage.sourceKind||review.cutoff!==input.coverage.cutoff||review.inputSha256!==input.coverage.inputSha256||['ref','attempt','actor','resource','notBefore','expiresAt','inputSha256','cutoff'].some(key=>canonicalize(review[key as keyof ObservationImportReview])!==canonicalize(first[key as keyof ObservationImportReview])))throw invalid('Empty batch changed its reviewed source, actor or resource');
 }
 const scope=await bindReviewedFinanceObservationAdmission(client,actor,first,mode);binding(scope).emptyBatchDigest=sha(canonicalize(inputs));
 return scope;
}

async function emptyReceiptFacts(client:PoolClient,actor:Actor,plans:ReturnType<typeof emptyPlans>,r:ObservationImportReview,lock=false){
 const scopeKey=JSON.stringify(['admin',actor.userId,operation,null]);
 const receipts=(await client.query(`/* finance empty original receipts */ SELECT key,request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])${lock?' FOR UPDATE':''}`,[scopeKey,plans.map(p=>p.plan.key)])).rows;
 const facts=(await client.query(`/* finance empty original coverage audit */ SELECT c.id,c.body_digest,c.source_canonical,(SELECT count(*)::text FROM zzsh_order.personal_finance_observation o WHERE o.user_id=c.user_id AND o.source_system=c.source_system AND o.source_kind=c.source_kind AND (o.source_event_at IS NULL OR o.source_event_at<=c.source_cutoff)) AS actual_count,a.actor_id,a.session_id,a.details FROM zzsh_order.personal_finance_observation_coverage c LEFT JOIN zzsh_iam.audit_event a ON a.object_id=c.id AND a.action='finance.history.imported' AND a.object_type='personal_finance_observation_coverage' AND a.actor_type='admin' AND a.outcome='SUCCESS' WHERE c.id=ANY($1::text[])`,[plans.map(p=>p.plan.coverage.id)])).rows;
 const receiptsByKey=new Map<string,(typeof receipts)[number]>(),factsById=new Map<string,typeof facts>();
 for(const row of receipts)if(!receiptsByKey.has(row.key))receiptsByKey.set(row.key,row);
 for(const row of facts){const rows=factsById.get(row.id);if(rows)rows.push(row);else factsById.set(row.id,[row]);}
 return plans.map(({input,plan})=>{
  const c=plan.coverage,receipt=receiptsByKey.get(plan.key),original=factsById.get(c.id)??[],body={coverageId:c.id,subjectId:c.userId,sourceKind:c.sourceKind,bodyDigest:plan.bodyDigest,importedCount:0,isolatedCount:0,financialEffect:'NONE'};
  if(!receipt){if(original.length)throw conflict('Empty coverage exists without its original receipt');return{plan,input,body,knowledge:'UNKNOWN' as const};}
  const fact=original[0];
  if(receipt.request_fingerprint!==fingerprintRequest(operation,c.id,input)||receipt.response_status!==200||canonicalize(receipt.response_body)!==canonicalize(body)||original.length!==1||fact.actual_count!=='0'||fact.body_digest!==c.bodyDigest||fact.source_canonical!==c.canonical||fact.actor_id!==actor.userId||fact.session_id!==actor.sessionId||fact.details?.bodyDigest!==plan.bodyDigest||fact.details?.approvalRef!==r.ref||fact.details?.attempt!==r.attempt)throw conflict('Empty coverage original receipt, source or audit differs');
  return{plan,input,body,knowledge:'KNOWN' as const};
 });
}

async function lockReviewedEmptySubjects(client:PoolClient,plans:ReturnType<typeof emptyPlans>,r:Pick<ObservationImportReview,'cutoff'>,scopeKey:string){
 await client.query(`/* finance empty original key locks */ SELECT pg_advisory_xact_lock(hashtextextended(k,0)) FROM unnest($1::text[]) WITH ORDINALITY keys(k,n) ORDER BY n`,[plans.map(p=>JSON.stringify(['supply-idempotency',scopeKey,p.plan.key]))]);
 const subjects=[...new Set(plans.map(p=>p.plan.coverage.userId))].sort();
 if((await client.query(`/* finance empty subject locks */ SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,[subjects])).rowCount!==subjects.length)throw conflict('Empty batch subject is not mapped');
 const sourceRows=plans.map(({plan:{coverage:c}})=>({user_id:c.userId,legacy_user_id:c.legacyUserId,identity_digest:c.identityDigest}));
 const invalidSubjects=await client.query(`/* finance empty exact source identities */ SELECT x.user_id FROM jsonb_to_recordset($1::jsonb) x(user_id text,legacy_user_id text,identity_digest text) WHERE (SELECT count(*) FROM zzsh_iam.audit_event a WHERE a.object_id=x.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS' AND a.details->>'sourceSystem'='legacy_mysql_restore' AND a.details->>'sourceEntity'='la_user' AND a.details->>'legacyId'=x.legacy_user_id AND a.details->>'sourceDigest'=x.identity_digest)<>1`,[JSON.stringify(sourceRows)]);
 if(invalidSubjects.rows.length)throw conflict('Empty batch original source identity changed');
 const earnings=plans.filter(p=>p.plan.coverage.sourceKind==='HISTORICAL_EARNINGS_LOG').map(p=>p.plan.coverage.userId);
 const cutoff=(await client.query(`/* finance empty single cutoff */ SELECT EXISTS(SELECT 1 FROM zzsh_order.finance_opening_basis b WHERE b.user_id=ANY($1::text[]) AND b.source_kind='LEGACY_OPENING' AND b.source_system='legacy_mysql_restore' AND b.source_cutoff<>$2::timestamptz) OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation_coverage c WHERE c.user_id=ANY($1::text[]) AND c.source_system='legacy_mysql_restore' AND c.source_kind='HISTORICAL_EARNINGS_LOG' AND c.source_entity='la_log_earnings' AND c.source_cutoff<>$2::timestamptz) AS differs`,[earnings,r.cutoff])).rows[0];
 if(typeof cutoff?.differs!=='boolean'||cutoff.differs)throw conflict('Empty earnings coverage and original opening cutoffs differ');
}

async function insertEmptyCoverages(client:PoolClient,plans:ReturnType<typeof emptyPlans>){
 const rows=plans.map(({plan:{coverage:c}})=>({id:c.id,user_id:c.userId,source_system:c.sourceSystem,legacy_user_id:c.legacyUserId,source_kind:c.sourceKind,source_entity:c.sourceEntity,source_cutoff:c.cutoff,input_sha256:c.inputSha256,identity_digest:c.identityDigest,source_count:0,imported_count:0,isolated_count:0,source_set_digest:c.sourceSetDigest,imported_set_digest:c.importedSetDigest,isolated_set_digest:c.isolatedSetDigest,body_digest:c.bodyDigest,source_canonical:c.canonical}));
 await client.query(`/* finance empty coverage insert */ INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical) SELECT id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical FROM jsonb_populate_recordset(NULL::zzsh_order.personal_finance_observation_coverage,$1::jsonb) ORDER BY user_id COLLATE "C",id COLLATE "C"`,[JSON.stringify(rows)]);
}

/** Caller owns the transaction. Coverage triggers, original per-subject receipts and audits remain active. */
export async function importReviewedEmptyFinanceObservationBatch(client:PoolClient,actor:Actor,inputs:ObservationImportInput[],scope:ObservationImportAdmission){
 inputs=copy(inputs);const bound=binding(scope),plans=emptyPlans(inputs);
 if(bound.emptyBatchDigest!==sha(canonicalize(inputs)))throw invalid('Empty batch differs from its exact internal review');
 const r=await authorize(client,actor,scope,inputs[0]!);
 const scopeKey=JSON.stringify(['admin',actor.userId,operation,null]);
 await lockReviewedEmptySubjects(client,plans,r,scopeKey);
 const original=await emptyReceiptFacts(client,actor,plans,r,true),fresh=original.filter(p=>p.knowledge==='UNKNOWN');
 await setAuditContext(client,'admin',actor.userId,actor.sessionId,actor.requestId);
 if(fresh.length){
  await insertEmptyCoverages(client,fresh);
  const audit=fresh.map(({plan:{coverage:c},plan})=>({id:'audit_'+randomUUID().replaceAll('-',''),object_id:c.id,details:{bodyDigest:plan.bodyDigest,inputSha256:c.inputSha256,coverageBodyDigest:c.bodyDigest,subjectId:c.userId,sourceKind:c.sourceKind,sourceCount:0,importedCount:0,isolatedCount:0,approvalRef:r.ref,attempt:r.attempt,financialEffect:'NONE'}}));
  await client.query(`/* finance empty original audit insert */ INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details) SELECT x.id,'admin',$2,$3,'finance.history.imported','personal_finance_observation_coverage',x.object_id,'SUCCESS',$4,NULL,clock_timestamp(),x.details FROM jsonb_to_recordset($1::jsonb) x(id text,object_id text,details jsonb)`,[JSON.stringify(audit),actor.userId,actor.sessionId,actor.requestId]);
  await client.query(`/* finance empty original receipt insert */ INSERT INTO zzsh_supply.idempotency_record(scope_key,key,request_fingerprint,response_status,response_body,publish_required) SELECT $2,x.key,x.fingerprint,200,x.body,false FROM jsonb_to_recordset($1::jsonb) x(key text,fingerprint text,body jsonb)`,[JSON.stringify(fresh.map(({plan,input,body})=>({key:plan.key,fingerprint:fingerprintRequest(operation,plan.coverage.id,input),body}))),scopeKey]);
 }
 await authorize(client,actor,scope,inputs[0]!);
 return{status:200,body:{coverageCount:plans.length,created:fresh.length,replayed:plans.length-fresh.length,financialEffect:'NONE'}};
}

/** Read-only original-key recovery; absence stays UNKNOWN and never mints a new receipt. */
export async function recoverReviewedEmptyFinanceObservationBatch(client:PoolClient,actor:Actor,inputs:ObservationImportInput[],scope:ObservationImportAdmission){
 if(binding(scope).emptyBatchDigest!==sha(canonicalize(inputs)))throw invalid('Empty recovery batch changed');
 const r=await authorize(client,actor,scope,inputs[0]!,true),facts=await emptyReceiptFacts(client,actor,emptyPlans(inputs),r);
 await authorize(client,actor,scope,inputs[0]!,true);
 return facts.map(p=>({key:p.plan.key,coverageId:p.plan.coverage.id,knowledge:p.knowledge,receipt:p.knowledge==='KNOWN'?{status:200,body:p.body}:null,financialEffect:'NONE' as const}));
}

export const COMPACT_EMPTY_COVERAGE_VERSION='BATCH_V2';
const compactEmptyOperation='finance.history.empty_batch.import.v1';
export function compactEmptyFinanceBatchProof(inputs:ObservationImportInput[],r:Pick<ObservationImportReview,'ref'|'attempt'|'actor'|'resource'|'inputSha256'|'cutoff'>,requestId:string){
 if(!r||r.resource?.migrationProfile!=='LOCAL_MIGRATION_NEXT_V1'||!/^\d+$/.test(r.resource.systemIdentifier??'')||!/^[a-f0-9]{24}$/.test(r.resource.nonce??'')||!Number.isSafeInteger(r.resource.oid)||r.resource.oid<=0
  ||![r.ref,r.attempt,r.actor?.userId,r.actor?.sessionId,requestId].every(value=>typeof value==='string'&&identifier.test(value))||!digest.test(r.inputSha256)
  ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.cutoff)||!Number.isFinite(Date.parse(r.cutoff))
  ||!Array.isArray(inputs)||inputs.length<1||inputs.length>400||inputs.some(input=>input?.coverage?.inputSha256!==r.inputSha256||input.coverage.cutoff!==r.cutoff))
  throw invalid('Compact empty batches require an exact source and bound next-round target');
 emptyPlans(inputs);
 const value={schema:'finance-empty-coverage-batch.v1',inputsDigest:sha(canonicalize(inputs)),inputSha256:r.inputSha256,cutoff:r.cutoff,
  coverageCount:inputs.length,reviewRef:r.ref,reviewAttempt:r.attempt,actor:{userId:r.actor.userId,sessionId:r.actor.sessionId},requestId,
  target:{systemIdentifier:r.resource.systemIdentifier,oid:r.resource.oid,nonce:r.resource.nonce},financialEffect:'NONE' as const};
 const batchId='history-empty-batch-'+sha(canonicalize(value)).slice(0,40),body={...value,batchId};
 return {batchId,body,fingerprint:sha(canonicalize([compactEmptyOperation,batchId,body]))};
}

/** System migration records one receipt per proved-empty batch; it never posts money. */
export function systemCompactEmptyFinanceBatchProof(inputs:ObservationImportInput[],actor:SystemFinanceMigrationActor){
 if(actor.kind!=='SYSTEM_FINANCE_MIGRATION'||actor.id!==systemFinanceMigrationId(actor.sourceDatasetSha256,actor.target)
  ||typeof actor.requestId!=='string'||!identifier.test(actor.requestId)||!Array.isArray(inputs)||!inputs.length)
  throw invalid('Compact system source is invalid');
 emptyPlans(inputs);const first=inputs[0]!.coverage;
 if(!digest.test(first.inputSha256)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(first.cutoff)
  ||!Number.isFinite(Date.parse(first.cutoff))||inputs.some(input=>input.coverage.inputSha256!==first.inputSha256||input.coverage.cutoff!==first.cutoff))
  throw invalid('Compact system source does not share one input and cutoff');
 const value={schema:'finance-empty-coverage-batch.system.v1',sourceSystem:'legacy_mysql_restore',sourceEntity:'EMPTY_FINANCE_COVERAGE',
  sourceDatasetSha256:actor.sourceDatasetSha256,migrationRunDigest:actor.id.slice('legacy-finance-migration:'.length),
  inputsDigest:sha(canonicalize(inputs)),inputSha256:first.inputSha256,cutoff:first.cutoff,coverageCount:inputs.length,requestId:actor.requestId,
  target:{systemIdentifier:actor.target.systemIdentifier,oid:actor.target.databaseOid,nonce:actor.target.nonce},financialEffect:'NONE' as const};
 const batchId='history-empty-batch-'+sha(canonicalize(value)).slice(0,40),body={...value,batchId};
 return{batchId,body,fingerprint:sha(canonicalize([compactEmptyOperation,batchId,body]))};
}

export type SystemEmptyReceiptBaseline=Readonly<{kind:'SYSTEM_EMPTY_RECEIPT_BASELINE'}>;
const systemEmptyBaselines=new WeakMap<object,{client:PoolClient;actor:SystemFinanceMigrationActor;binding:string;
 fence:SystemFinanceMigrationActor['assertMigrationFence'];source:SystemFinanceMigrationActor['assertSourceEvidence']}>();
function systemFinanceBinding(actor:SystemFinanceMigrationActor){
 return canonicalize([actor.id,actor.requestId,actor.sourceDatasetSha256,actor.target,actor.fenceEpochSha256]);
}

/** One scan per exclusive migration fence; business writers must stay disconnected until it is released. */
export async function bindSystemEmptyReceiptBaseline(client:PoolClient,actor:SystemFinanceMigrationActor,inputs:ObservationImportInput[],readOnly=false):Promise<SystemEmptyReceiptBaseline>{
 const proof=systemCompactEmptyFinanceBatchProof(inputs,actor),source={inputsDigest:proof.body.inputsDigest,inputSha256:proof.body.inputSha256,cutoff:proof.body.cutoff};
 await authorizeSystemEmptyFinanceMigration(client,actor,source,readOnly);
 const currentScope=JSON.stringify(['system',actor.id,compactEmptyOperation,null]);
 const row=(await client.query(`/* finance system old receipt baseline */ WITH relevant AS MATERIALIZED (
  SELECT scope_key FROM zzsh_supply.idempotency_record WHERE position('"finance.history.import"' IN scope_key)>0
    OR position('"finance.history.empty_batch.import.v1"' IN scope_key)>0)
  SELECT EXISTS(SELECT 1 FROM relevant WHERE (scope_key::jsonb->>0='admin' AND scope_key::jsonb->>2 IN ('finance.history.import','finance.history.empty_batch.import.v1'))
    OR (scope_key::jsonb->>0='system' AND (scope_key::jsonb->>2='finance.history.import'
      OR (scope_key::jsonb->>2='finance.history.empty_batch.import.v1' AND scope_key<>$1)))) AS conflicts`,[currentScope])).rows[0];
 if(typeof row?.conflicts!=='boolean'||row.conflicts)throw conflict('Existing finance history receipts require review');
 await authorizeSystemEmptyFinanceMigration(client,actor,source,readOnly);
 const token=Object.freeze({kind:'SYSTEM_EMPTY_RECEIPT_BASELINE' as const});
 systemEmptyBaselines.set(token,{client,actor,binding:systemFinanceBinding(actor),fence:actor.assertMigrationFence,source:actor.assertSourceEvidence});return token;
}
function assertSystemEmptyReceiptBaseline(client:PoolClient,actor:SystemFinanceMigrationActor,token:SystemEmptyReceiptBaseline){
 const bound=token&&systemEmptyBaselines.get(token);
 if(!bound||bound.client!==client||bound.actor!==actor||bound.binding!==systemFinanceBinding(actor)
  ||bound.fence!==actor.assertMigrationFence||bound.source!==actor.assertSourceEvidence)throw conflict('System finance receipt baseline is unavailable');
}

async function readCompactCoverage(client:PoolClient,plans:ReturnType<typeof emptyPlans>){
 const ids=plans.map(p=>p.plan.coverage.id);
 return (await client.query(`/* finance compact coverage */ SELECT c.id,c.user_id,c.source_kind,c.source_count,c.imported_count,c.isolated_count,c.body_digest,c.source_canonical,
  (SELECT count(*)::text FROM zzsh_order.personal_finance_observation o WHERE o.user_id=c.user_id AND o.source_system=c.source_system AND o.source_kind=c.source_kind AND (o.source_event_at IS NULL OR o.source_event_at<=c.source_cutoff)) AS actual_count
  FROM zzsh_order.personal_finance_observation_coverage c WHERE c.id=ANY($1::text[])`,[ids])).rows;
}
function compactCoverageMatches(coverage:Record<string,any>[],plans:ReturnType<typeof emptyPlans>){
 const byId=new Map(coverage.map(row=>[row.id,row]));
 return byId.size===plans.length&&!plans.some(({plan:{coverage:c}})=>{const row=byId.get(c.id);return !row||row.user_id!==c.userId||row.source_kind!==c.sourceKind
   ||[row.source_count,row.imported_count,row.isolated_count,row.actual_count].some(value=>String(value)!=='0')||row.body_digest!==c.bodyDigest||row.source_canonical!==c.canonical;});
}
async function readCompactEmptyBatch(client:PoolClient,actor:Actor,plans:ReturnType<typeof emptyPlans>,proof:ReturnType<typeof compactEmptyFinanceBatchProof>,lock=false){
 const ids=plans.map(p=>p.plan.coverage.id),oldScope=JSON.stringify(['admin',actor.userId,operation,null]);
 const compactScope=JSON.stringify(['admin',actor.userId,compactEmptyOperation,null]);
 const oldReceipts=(await client.query(`/* finance compact old receipts */ SELECT key FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])`,[oldScope,plans.map(p=>p.plan.key)])).rows;
 const oldAudits=(await client.query(`/* finance compact old audits */ SELECT object_id FROM zzsh_iam.audit_event WHERE action='finance.history.imported' AND object_type='personal_finance_observation_coverage' AND object_id=ANY($1::text[]) LIMIT 1`,[ids])).rows;
 if(oldReceipts.length||oldAudits.length)throw conflict('Compact empty batch overlaps individual import evidence');
 const coverage=await readCompactCoverage(client,plans);
 const audit=(await client.query(`/* finance compact batch audit */ SELECT actor_id,session_id,request_id,details FROM zzsh_iam.audit_event WHERE action='finance.history.empty_batch.imported' AND object_type='personal_finance_observation_coverage_batch' AND object_id=$1 AND actor_type='admin' AND outcome='SUCCESS'`,[proof.batchId])).rows;
 const receipt=(await client.query(`/* finance compact batch receipt */ SELECT request_fingerprint,response_status,response_body,publish_required FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2${lock?' FOR UPDATE':''}`,[compactScope,proof.batchId])).rows;
 if(!receipt.length){if(coverage.length||audit.length)throw conflict('Compact empty batch has partial original evidence');return{knowledge:'UNKNOWN' as const,receipt:null};}
 if(receipt.length!==1||receipt[0].request_fingerprint!==proof.fingerprint||receipt[0].response_status!==200||receipt[0].publish_required!==false||canonicalize(receipt[0].response_body)!==canonicalize(proof.body)
  ||audit.length!==1||audit[0].actor_id!==actor.userId||audit[0].session_id!==actor.sessionId||audit[0].request_id!==actor.requestId||canonicalize(audit[0].details)!==canonicalize(proof.body)
  ||coverage.length!==plans.length)throw conflict('Compact empty batch original evidence differs');
 if(!compactCoverageMatches(coverage,plans))
  throw conflict('Compact empty batch coverage differs from its original source');
 return{knowledge:'KNOWN' as const,receipt:{status:200,body:proof.body}};
}

async function readSystemCompactEmptyBatch(client:PoolClient,actor:SystemFinanceMigrationActor,plans:ReturnType<typeof emptyPlans>,
 proof:ReturnType<typeof systemCompactEmptyFinanceBatchProof>,lock=false){
 const ids=plans.map(p=>p.plan.coverage.id),scopeKey=JSON.stringify(['system',actor.id,compactEmptyOperation,null]);
 const oldAudits=(await client.query(`/* finance compact old audits */ SELECT object_id FROM zzsh_iam.audit_event
  WHERE action='finance.history.imported' AND object_type='personal_finance_observation_coverage' AND object_id=ANY($1::text[]) LIMIT 1`,[ids])).rows;
 if(oldAudits.length)throw conflict('Compact empty batch overlaps individual import evidence');
 const coverage=await readCompactCoverage(client,plans);
 const audit=(await client.query(`/* finance system compact batch audit */ SELECT actor_type,actor_id,session_id,request_id,details,
  to_jsonb(e)->>'legacy_migration_manifest_sha256' AS source_manifest FROM zzsh_iam.audit_event e
  WHERE action='finance.history.empty_batch.imported' AND object_type='personal_finance_observation_coverage_batch' AND object_id=$1 AND outcome='SUCCESS'`,[proof.batchId])).rows;
 const receipt=(await client.query(`/* finance system compact batch receipt */ SELECT request_fingerprint,response_status,response_body,publish_required
  FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2${lock?' FOR UPDATE':''}`,[scopeKey,proof.batchId])).rows;
 if(!receipt.length){if(coverage.length||audit.length)throw conflict('Compact empty batch has partial original evidence');return{knowledge:'UNKNOWN' as const};}
 if(receipt.length!==1||receipt[0].request_fingerprint!==proof.fingerprint||receipt[0].response_status!==200||receipt[0].publish_required!==false
  ||canonicalize(receipt[0].response_body)!==canonicalize(proof.body)||audit.length!==1||audit[0].actor_type!=='system'
  ||audit[0].actor_id!==actor.id||audit[0].session_id!==null||audit[0].request_id!==actor.requestId
  ||audit[0].source_manifest!==actor.sourceDatasetSha256||canonicalize(audit[0].details)!==canonicalize(proof.body)
  ||!compactCoverageMatches(coverage,plans))throw conflict('Compact empty batch original evidence differs');
 return{knowledge:'KNOWN' as const,receipt:{status:200,body:proof.body}};
}

/** Internal system source only. The caller owns the transaction and the exact source/fence capability. */
export async function importSystemCompactEmptyFinanceObservationBatch(client:PoolClient,actor:SystemFinanceMigrationActor,inputs:ObservationImportInput[],baseline:SystemEmptyReceiptBaseline){
 inputs=copy(inputs);const plans=emptyPlans(inputs),proof=systemCompactEmptyFinanceBatchProof(inputs,actor);
 const source={inputsDigest:proof.body.inputsDigest,inputSha256:proof.body.inputSha256,cutoff:proof.body.cutoff};
 await authorizeSystemEmptyFinanceMigration(client,actor,source);
 assertSystemEmptyReceiptBaseline(client,actor,baseline);
 const oldScope=JSON.stringify(['system',actor.id,operation,null]);
 await lockReviewedEmptySubjects(client,plans,{cutoff:proof.body.cutoff},oldScope);
 const result=await withIdempotency(client,{realm:'system',principalId:actor.id,operation:compactEmptyOperation},proof.batchId,proof.fingerprint,
  async replay=>{const previous=await readSystemCompactEmptyBatch(client,actor,plans,proof,true);if((replay!==null)!==(previous.knowledge==='KNOWN'))throw conflict('Compact empty batch receipt is inconsistent');},
  async()=>{await setAuditContext(client,'system',actor.id,undefined,actor.requestId);await insertEmptyCoverages(client,plans);
   await recordAudit(client,{actorType:'system',actorId:actor.id,legacyMigrationManifestSha256:actor.sourceDatasetSha256,
    requestId:actor.requestId,action:'finance.history.empty_batch.imported',objectType:'personal_finance_observation_coverage_batch',
    objectId:proof.batchId,outcome:'SUCCESS',details:proof.body});return{status:200,body:proof.body};});
 await authorizeSystemEmptyFinanceMigration(client,actor,source);
 return{status:result.status,body:{coverageCount:plans.length,created:result.replayed?0:plans.length,replayed:result.replayed?plans.length:0,
  financialEffect:'NONE' as const,batchId:proof.batchId}};
}

/** Recovery is read-only and uses the original source, target and batch key. */
export async function recoverSystemCompactEmptyFinanceObservationBatch(client:PoolClient,actor:SystemFinanceMigrationActor,inputs:ObservationImportInput[],baseline:SystemEmptyReceiptBaseline){
 inputs=copy(inputs);const plans=emptyPlans(inputs),proof=systemCompactEmptyFinanceBatchProof(inputs,actor);
 const source={inputsDigest:proof.body.inputsDigest,inputSha256:proof.body.inputSha256,cutoff:proof.body.cutoff};
 await authorizeSystemEmptyFinanceMigration(client,actor,source,true);
 assertSystemEmptyReceiptBaseline(client,actor,baseline);
 const result=await readSystemCompactEmptyBatch(client,actor,plans,proof);
 await authorizeSystemEmptyFinanceMigration(client,actor,source,true);
 return{knowledge:result.knowledge,batchId:proof.batchId,receipt:result.knowledge==='KNOWN'?result.receipt:null,financialEffect:'NONE' as const};
}

/** Next-round empty history keeps per-subject coverage but uses one transaction receipt and audit for the frozen batch. */
export async function importReviewedCompactEmptyFinanceObservationBatch(client:PoolClient,actor:Actor,inputs:ObservationImportInput[],scope:ObservationImportAdmission){
 if((client as PoolClient&{getTransactionStatus?:()=>string}).getTransactionStatus?.()!=='T')throw invalid('Compact empty batch requires a transaction');
 inputs=copy(inputs);const bound=binding(scope),plans=emptyPlans(inputs);
 if(bound.emptyBatchDigest!==sha(canonicalize(inputs)))throw invalid('Compact empty batch differs from its exact review');
 const r=await authorize(client,actor,scope,inputs[0]!),proof=compactEmptyFinanceBatchProof(inputs,r,actor.requestId),oldScope=JSON.stringify(['admin',actor.userId,operation,null]);
 await lockReviewedEmptySubjects(client,plans,r,oldScope);
 const result=await withIdempotency(client,{realm:'admin',principalId:actor.userId,operation:compactEmptyOperation},proof.batchId,proof.fingerprint,
  async replay=>{const previous=await readCompactEmptyBatch(client,actor,plans,proof,true);if((replay!==null)!==(previous.knowledge==='KNOWN'))throw conflict('Compact empty batch receipt is inconsistent');},
  async()=>{await setAuditContext(client,'admin',actor.userId,actor.sessionId,actor.requestId);await insertEmptyCoverages(client,plans);
   await recordAudit(client,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'finance.history.empty_batch.imported',
    objectType:'personal_finance_observation_coverage_batch',objectId:proof.batchId,outcome:'SUCCESS',details:proof.body});
   return{status:200,body:proof.body};});
 await authorize(client,actor,scope,inputs[0]!);
 return{status:result.status,body:{coverageCount:plans.length,created:result.replayed?0:plans.length,replayed:result.replayed?plans.length:0,financialEffect:'NONE' as const,batchId:proof.batchId}};
}

/** Original batch recovery is read-only; no per-subject receipt is fabricated. */
export async function recoverReviewedCompactEmptyFinanceObservationBatch(client:PoolClient,actor:Actor,inputs:ObservationImportInput[],scope:ObservationImportAdmission){
 if((client as PoolClient&{getTransactionStatus?:()=>string}).getTransactionStatus?.()!=='T')throw invalid('Compact empty recovery requires a transaction');
 inputs=copy(inputs);const bound=binding(scope),plans=emptyPlans(inputs);
 if(bound.emptyBatchDigest!==sha(canonicalize(inputs)))throw invalid('Compact empty recovery changed');
 const tx=(await client.query(`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only`)).rows[0];
 if(!['repeatable read','serializable'].includes(tx?.isolation)||tx?.read_only!=='on')throw invalid('Compact empty recovery requires a consistent read-only transaction');
 const r=await authorize(client,actor,scope,inputs[0]!,true),proof=compactEmptyFinanceBatchProof(inputs,r,actor.requestId),result=await readCompactEmptyBatch(client,actor,plans,proof);
 await authorize(client,actor,scope,inputs[0]!,true);
 return{knowledge:result.knowledge,batchId:proof.batchId,receipt:result.receipt,financialEffect:'NONE' as const};
}

/** 批级资金历史写入：整批 4 条 jsonb_to_recordset 语句（observation / coverage / audit / receipt），
 *  鉴权批首批尾各一次。语义与 importReviewedFinanceObservations 完全一致：
 *  同一切点、原键身份、幂等回执、金额集合摘要全部保留。调用方负责事务与提交。 */
export async function importReviewedFinanceObservationsBatchOn(client:PoolClient,actor:Actor,inputs:ObservationImportInput[],scopes:ObservationImportAdmission[]){
 inputs=copy(inputs);
 if(!Array.isArray(inputs)||inputs.length<1||inputs.length>1000||inputs.length!==scopes.length)throw invalid('Bounded observation batch required');
 const plans=inputs.map(planFinanceObservations);
 if(new Set(plans.map(p=>p.coverage.id)).size!==plans.length)throw invalid('Duplicate coverage in batch');
 const pairs=plans.map((plan,i)=>({input:inputs[i]!,scope:scopes[i]!,plan})).sort((a,b)=>a.plan.coverage.id<b.plan.coverage.id?-1:a.plan.coverage.id>b.plan.coverage.id?1:0);
 // 每个对象仍必须与自己的内部评审逐字段一致（纯 JS，无 SQL）
 for(const p of pairs){const r=binding(p.scope).review,c=p.plan.coverage;
  if(sha(canonicalize(p.input))!==r.bodyDigest||c.userId!==r.userId||c.sourceKind!==r.sourceKind||c.cutoff!==r.cutoff||c.inputSha256!==r.inputSha256)
   throw invalid('Observation input differs from exact internal review');}
 const window=await authorizeMaintenanceBatch(client,actor,pairs.map(p=>binding(p.scope).review));
 const scopeKey=JSON.stringify(['admin',actor.userId,operation,null]);
 await client.query(`/* finance history batch key locks */ SELECT pg_advisory_xact_lock(hashtextextended(k,0)) FROM unnest($1::text[]) WITH ORDINALITY keys(k,n) ORDER BY n`,
  [pairs.map(p=>JSON.stringify(['supply-idempotency',scopeKey,p.plan.key]))]);
 const subjects=[...new Set(pairs.map(p=>p.plan.coverage.userId))].sort();
 if((await client.query(`/* finance history batch subject locks */ SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,[subjects])).rowCount!==subjects.length)throw conflict('Observation batch subject is not mapped');
 const invalidSubjects=await client.query(`/* finance history batch source identities */ SELECT x.user_id FROM jsonb_to_recordset($1::jsonb) x(user_id text,legacy_user_id text,source_system text,identity_digest text)
   WHERE (SELECT count(*) FROM zzsh_iam.audit_event a WHERE a.object_id=x.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS'
     AND a.details->>'sourceSystem'=x.source_system AND a.details->>'sourceEntity'='la_user' AND a.details->>'legacyId'=x.legacy_user_id
     AND a.details->>'sourceDigest'=x.identity_digest)<>1`,
  [JSON.stringify(pairs.map(p=>({user_id:p.plan.coverage.userId,legacy_user_id:p.plan.coverage.legacyUserId,source_system:p.plan.coverage.sourceSystem,identity_digest:p.plan.coverage.identityDigest})))]);
 if(invalidSubjects.rows.length)throw conflict('Observation batch original source identity changed');
 const earnings=pairs.filter(p=>p.plan.coverage.sourceKind==='HISTORICAL_EARNINGS_LOG');
 if(earnings.length){
  const cutoffs=[...new Set(earnings.map(p=>p.plan.coverage.cutoff))];
  if(cutoffs.length!==1)throw conflict('Observation batch earnings cutoffs differ');
  const differs=(await client.query(`/* finance history batch single cutoff */ SELECT EXISTS(SELECT 1 FROM zzsh_order.finance_opening_basis b WHERE b.user_id=ANY($1::text[]) AND b.source_kind='LEGACY_OPENING' AND b.source_cutoff<>$2::timestamptz)
    OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation_coverage c WHERE c.user_id=ANY($1::text[]) AND c.source_kind='HISTORICAL_EARNINGS_LOG' AND c.source_entity='la_log_earnings' AND c.source_cutoff<>$2::timestamptz) AS differs`,
   [[...new Set(earnings.map(p=>p.plan.coverage.userId))],cutoffs[0]])).rows[0];
  if(typeof differs?.differs!=='boolean'||differs.differs)throw conflict('Earnings coverage and original opening cutoffs differ');
 }
 const keyRows=pairs.flatMap(p=>p.plan.observations.map(o=>({source_system:p.plan.coverage.sourceSystem,source_entity:p.plan.coverage.sourceEntity,source_id:o.sourceId})));
 const prior=new Map<string,Record<string,any>>();
 if(keyRows.length){const rows=(await client.query(`/* finance history batch existing observations */ SELECT o.* FROM jsonb_to_recordset($1::jsonb) x(source_system text,source_entity text,source_id text)
   JOIN zzsh_order.personal_finance_observation o ON o.source_type='LEGACY_MYSQL' AND o.source_system=x.source_system AND o.source_entity=x.source_entity AND o.source_id=x.source_id`,
  [JSON.stringify(keyRows)])).rows;for(const row of rows)prior.set(row.source_system+'|'+row.source_entity+'|'+row.source_id,row);}
 const receipts=await client.query(`/* finance history batch original receipts */ SELECT key,request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[]) FOR UPDATE`,[scopeKey,pairs.map(p=>p.plan.key)]);
 const receiptByKey=new Set<string>(receipts.rows.map((r:any)=>r.key));
 const fresh=pairs.filter(p=>!receiptByKey.has(p.plan.key));
 const observationRows:any[]=[],coverageRows:any[]=[],auditRows:any[]=[],receiptRows:any[]=[];
 for(const {input,plan,scope} of fresh){
  const c=plan.coverage,r=binding(scope).review;
  for(const o of plan.observations){
   const found=prior.get(c.sourceSystem+'|'+c.sourceEntity+'|'+o.sourceId);
   if(found){if(!exactObservation(found,o))throw conflict('Original observation changed; reconciliation required');continue;}
   observationRows.push({id:o.id,user_id:o.userId,basis_id:null,source_kind:o.sourceKind,source_type:'LEGACY_MYSQL',source_system:o.sourceSystem,legacy_user_id:o.legacyUserId,source_entity:o.sourceEntity,source_id:o.sourceId,source_digest:o.sourceDigest,source_canonical:o.sourceCanonical,source_event_at:o.sourceEventAt,included_in_opening:false,snapshot:o.snapshot});
  }
  coverageRows.push({id:c.id,user_id:c.userId,source_system:c.sourceSystem,legacy_user_id:c.legacyUserId,source_kind:c.sourceKind,source_entity:c.sourceEntity,source_cutoff:c.cutoff,input_sha256:c.inputSha256,identity_digest:c.identityDigest,source_count:c.sourceCount,imported_count:c.importedCount,isolated_count:c.isolatedCount,source_set_digest:c.sourceSetDigest,imported_set_digest:c.importedSetDigest,isolated_set_digest:c.isolatedSetDigest,body_digest:c.bodyDigest,source_canonical:c.canonical});
  auditRows.push({id:'audit_'+randomUUID().replaceAll('-',''),object_id:c.id,details:{bodyDigest:plan.bodyDigest,inputSha256:c.inputSha256,coverageBodyDigest:c.bodyDigest,subjectId:c.userId,sourceKind:c.sourceKind,sourceCount:c.sourceCount,importedCount:c.importedCount,isolatedCount:c.isolatedCount,approvalRef:r.ref,attempt:r.attempt,authorizedAt:window.authorizedAt,windowExpiresAt:window.windowExpiresAt,financialEffect:'NONE'}});
  receiptRows.push({key:plan.key,fingerprint:fingerprintRequest(operation,c.id,input),body:{coverageId:c.id,subjectId:c.userId,sourceKind:c.sourceKind,bodyDigest:plan.bodyDigest,importedCount:c.importedCount,isolatedCount:c.isolatedCount,financialEffect:'NONE'}});
 }
 if(coverageRows.length){
  if(observationRows.length)await client.query(`/* finance history batch observations */ INSERT INTO zzsh_order.personal_finance_observation(id,user_id,basis_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,source_event_at,included_in_opening,snapshot)
   SELECT x.id,x.user_id,x.basis_id,x.source_kind,x.source_type,x.source_system,x.legacy_user_id,x.source_entity,x.source_id,x.source_digest,x.source_canonical,x.source_event_at::timestamptz,x.included_in_opening,x.snapshot::jsonb
   FROM jsonb_to_recordset($1::jsonb) x(id text,user_id text,basis_id text,source_kind text,source_type text,source_system text,legacy_user_id text,source_entity text,source_id text,source_digest text,source_canonical text,source_event_at text,included_in_opening boolean,snapshot jsonb)
   ORDER BY x.user_id COLLATE "C",x.id COLLATE "C"`,[JSON.stringify(observationRows)]);
  await client.query(`/* finance history batch coverage */ INSERT INTO zzsh_order.personal_finance_observation_coverage(id,user_id,source_system,legacy_user_id,source_kind,source_entity,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,source_canonical)
   SELECT x.id,x.user_id,x.source_system,x.legacy_user_id,x.source_kind,x.source_entity,x.source_cutoff::timestamptz,x.input_sha256,x.identity_digest,x.source_count,x.imported_count,x.isolated_count,x.source_set_digest,x.imported_set_digest,x.isolated_set_digest,x.body_digest,x.source_canonical
   FROM jsonb_to_recordset($1::jsonb) x(id text,user_id text,source_system text,legacy_user_id text,source_kind text,source_entity text,source_cutoff text,input_sha256 text,identity_digest text,source_count integer,imported_count integer,isolated_count integer,source_set_digest text,imported_set_digest text,isolated_set_digest text,body_digest text,source_canonical text)
   ORDER BY x.user_id COLLATE "C",x.id COLLATE "C"`,[JSON.stringify(coverageRows)]);
  await client.query(`/* finance history batch audit */ INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
   SELECT x.id,'admin',$2,$3,'finance.history.imported','personal_finance_observation_coverage',x.object_id,'SUCCESS',$4,NULL,clock_timestamp(),x.details
   FROM jsonb_to_recordset($1::jsonb) x(id text,object_id text,details jsonb) ORDER BY x.object_id COLLATE "C"`,[JSON.stringify(auditRows),actor.userId,actor.sessionId,actor.requestId]);
  await client.query(`/* finance history batch receipts */ INSERT INTO zzsh_supply.idempotency_record(scope_key,key,request_fingerprint,response_status,response_body,publish_required)
   SELECT $2,x.key,x.fingerprint,200,x.body,false FROM jsonb_to_recordset($1::jsonb) x(key text,fingerprint text,body jsonb) ORDER BY x.key COLLATE "C"`,[JSON.stringify(receiptRows),scopeKey]);
 }
 await closeMaintenanceBatch(client,actor,binding(pairs[0]!.scope).review);
 return{status:200,body:{coverageCount:pairs.length,created:fresh.length,replayed:pairs.length-fresh.length,observations:observationRows.length,authorizedAt:window.authorizedAt,windowExpiresAt:window.windowExpiresAt,financialEffect:'NONE'}};
}
