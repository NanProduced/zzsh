import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {recordAudit,setAuditContext,withTransaction} from '../auth/security-core';
import {canonicalize} from '../supply/content-hash';
import {conflict,ensureOnlyFields,fingerprintRequest,invalid,withIdempotency} from '../supply/supply-util';
import {authorizeFinanceMaintenance,assertFinanceMaintenanceResource,type FinanceOpeningReview} from './personal-finance-maintenance';
import {prepareHistoricalObservation} from './personal-finance-read';
import {prepareObservationCoverage,type ObservationCoverageInput} from './personal-finance-coverage';

type Actor={userId:string;sessionId:string;requestId:string};
export type ObservationImportInput={coverage:ObservationCoverageInput;observations:Record<string,unknown>[]};
export type ObservationImportReview=Pick<FinanceOpeningReview,'ref'|'attempt'|'actor'|'resource'|'notBefore'|'expiresAt'|'inputSha256'|'cutoff'|'bodyDigest'>&{userId:string;sourceKind:ObservationCoverageInput['sourceKind']};
export type ObservationImportAdmission=Readonly<{kind:'REVIEWED_FINANCE_OBSERVATIONS'}>;
const admitted=new WeakMap<object,{review:ObservationImportReview;recoveryOnly:boolean}>();
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
  if(p.sourceKind!==c.sourceKind||expected.get(p.sourceId)!==p.sourceDigest||seen.has(p.sourceId)||p.sourceEventAt>c.cutoff)throw invalid('Observation tuple/digest/cutoff differs from reviewed coverage');
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

/** Only a separately reviewed internal runner may supply this out-of-band binding. No HTTP entry. */
export async function bindReviewedFinanceObservationAdmission(client:PoolClient,actor:Actor,review:ObservationImportReview,mode:'execute'|'recover'='execute'):Promise<ObservationImportAdmission>{
 if(!review||typeof review!=='object'||!review.actor||!review.resource)throw invalid('Exact internal observation review required');
 ensureOnlyFields(review,['ref','attempt','actor','resource','notBefore','expiresAt','inputSha256','cutoff','bodyDigest','userId','sourceKind']);
 ensureOnlyFields(review.actor,['userId','sessionId']);ensureOnlyFields(review.resource,['host','port','database','oid','owner','marker','role','roleOid']);
 const r=copy(review);
 if(![r.ref,r.attempt,r.actor.userId,r.actor.sessionId,r.userId].every(x=>typeof x==='string'&&identifier.test(x))
  ||r.resource.host!=='127.0.0.1'||r.resource.port!==55432||!/^zzsh_test_order_[a-z][a-z0-9_]{0,20}$/.test(r.resource.database)
  ||![r.resource.owner,r.resource.role].every(x=>typeof x==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(x))
  ||r.resource.marker!=='zzsh:order-reservation-test:v1'||![r.resource.oid,r.resource.roleOid].every(x=>Number.isSafeInteger(x)&&x>0)
  ||![r.inputSha256,r.bodyDigest].every(x=>typeof x==='string'&&digest.test(x))
  ||!['HISTORICAL_EARNINGS_LOG','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL'].includes(r.sourceKind)
  ||![r.notBefore,r.expiresAt,r.cutoff].every(x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x)))
  ||Date.parse(r.notBefore)>=Date.parse(r.expiresAt)||Date.parse(r.cutoff)>Date.parse(r.notBefore)||!['execute','recover'].includes(mode))throw invalid('Exact observation resource/window required');
 const token=Object.freeze({kind:'REVIEWED_FINANCE_OBSERVATIONS' as const});admitted.set(token,{review:copy(r),recoveryOnly:mode==='recover'});
 try{await authorizeFinanceMaintenance(client,actor);await assertFinanceMaintenanceResource(client,actor,r,{recover:mode==='recover',recoveryOnly:mode==='recover'});return token;}
 catch(e){admitted.delete(token);throw e;}
}

function exactObservation(row:Record<string,any>,expected:ReturnType<typeof planFinanceObservations>['observations'][number]){
 const at=new Date(row.source_event_at);
 return row.user_id===expected.userId&&row.legacy_user_id===expected.legacyUserId&&row.source_kind===expected.sourceKind
  &&row.source_type==='LEGACY_MYSQL'&&row.source_system===expected.sourceSystem&&row.source_entity===expected.sourceEntity&&row.source_id===expected.sourceId
  &&row.source_digest===expected.sourceDigest&&row.source_canonical===expected.sourceCanonical&&canonicalize(row.snapshot)===canonicalize(expected.snapshot)
  &&Number.isFinite(at.getTime())&&at.toISOString()===expected.sourceEventAt;
}

/** Caller owns the transaction. Observations/coverage do not create opening, ledger, eligibility or a withdrawal. */
export async function importReviewedFinanceObservations(client:PoolClient,actor:Actor,input:ObservationImportInput,scope:ObservationImportAdmission){
 input=copy(input);const plan=planFinanceObservations(input),c=plan.coverage;
 await authorize(client,actor,scope,input);
 const result=await withIdempotency(client,{realm:'admin',principalId:actor.userId,operation},plan.key,fingerprintRequest(operation,c.id,input),async()=>{await authorize(client,actor,scope,input);},async()=>{
  await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[c.userId]);
  await setAuditContext(client,'admin',actor.userId,actor.sessionId,actor.requestId);
  for(const o of plan.observations){
   const existing=(await client.query(`/* finance history existing observation */ SELECT * FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system=$1 AND source_entity=$2 AND source_id=$3`,[o.sourceSystem,o.sourceEntity,o.sourceId])).rows[0];
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
 for(const o of plan.observations){const actual=(await client.query(`/* finance history existing observation */ SELECT * FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system=$1 AND source_entity=$2 AND source_id=$3`,[o.sourceSystem,o.sourceEntity,o.sourceId])).rows[0];if(!actual||!exactObservation(actual,o))throw conflict('Historical recovery observation differs from original input');}
 const audit=await client.query(`/* finance history recovery audit */ SELECT 1 FROM zzsh_iam.audit_event WHERE action='finance.history.imported' AND object_type='personal_finance_observation_coverage' AND object_id=$1 AND actor_type='admin' AND actor_id=$2 AND session_id=$3 AND outcome='SUCCESS' AND details->>'bodyDigest'=$4 AND details->>'approvalRef'=$5 AND details->>'attempt'=$6`,[c.id,actor.userId,actor.sessionId,plan.bodyDigest,r.ref,r.attempt]);
 if(audit.rowCount!==1)throw conflict('Historical recovery audit is incomplete');
 await authorize(client,actor,scope,input,true);
 return{knowledge:'KNOWN' as const,key:plan.key,receipt:{status:row.status,body:row.body},originalImportVerified:true,financialEffect:'NONE' as const};
}
