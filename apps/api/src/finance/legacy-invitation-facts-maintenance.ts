import type {PoolClient} from 'pg';
import {recordAudit,setAuditContext} from '../auth/security-core';
import {authorizeFinanceMaintenance,isReviewedFinanceMaintenanceEndpoint,isReviewedFinanceMaintenanceResource,type FinanceOpeningReview} from './personal-finance-maintenance';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,invalid,conflict,forbidden,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {prepareLegacyInvitationFacts,invitationFactHash,invitationFactTypes,invitationFactSourceDigest,invitationFactCodeId,legacyInvitationFactsOperation,legacyInvitationCountsOperation,projectLegacyInvitationQualification,type LegacyInvitationFactsInput,type LegacyInvitationRawFact,type LegacyInvitationFactSource} from './legacy-invitation-facts';

import {readLegacyDistributionQualifications} from './admin-distribution-read';
import {readDistributionPolicyRowInTransaction} from './distribution-policy-store';
import {authorizeSystemInvitationMigration,type SystemInvitationMigrationActor} from '../legacy-load/system-user-migration';

type Actor={userId:string;sessionId:string;requestId:string};
type InvitationActor=Actor|SystemInvitationMigrationActor;
export type LegacyInvitationFactsReview={ref:string;attempt:string;actor:{userId:string;sessionId:string};resource:FinanceOpeningReview['resource']&{ownerOid:number};notBefore:string;expiresAt:string;sourceDigest:string;bodyDigest:string;phase:'IMPORT'|'COUNTS'|'QUALIFY';nonce?:string;systemIdentifier?:string};
export type LegacyInvitationFactsAdmission=Readonly<{kind:'REVIEWED_LEGACY_INVITATION_FACTS'}>;
export type LegacyQualificationIndex=Readonly<{kind:'REVIEWED_LEGACY_QUALIFICATION_INDEX'}>;
type IndexedFact={sourceDigest:string;projection:ReturnType<typeof projectLegacyInvitationQualification>};
type QualificationIndexState={client:PoolClient;actor:string;context:string;xid:string;events:string;facts:Map<string,IndexedFact|null>};
const admissions=new WeakMap<object,{review:LegacyInvitationFactsReview;recoverOnly:boolean;qualificationIndex?:LegacyQualificationIndex}>(),qualificationIndexes=new WeakMap<object,QualificationIndexState>(),hex=/^[a-f0-9]{64}$/;
const factAction='distribution.legacy_facts.imported',countAction='distribution.legacy_facts.counts_closed';
function transaction(c:PoolClient){if(c.getTransactionStatus()!=='T')throw conflict('Caller-owned invitation fact transaction required');}
function cloneCountsReview(r:LegacyInvitationFactsReview):boolean{
 return r.phase==='COUNTS'&&r.resource.host==='127.0.0.1'&&r.resource.port===55434
  &&r.resource.database==='zzsh_test_r07_delivery_20261108'&&r.resource.marker==='zzsh:r07-delivery-clone:v1'
  &&r.resource.owner==='zzsh'&&r.resource.role==='zzsh_regression_migration'&&typeof r.nonce==='string'&&/^[a-f0-9]{24}$/.test(r.nonce)
  &&typeof r.systemIdentifier==='string'&&/^[0-9]+$/.test(r.systemIdentifier)&&r.systemIdentifier!=='7704972584346443810';
}
function reviewShape(r:LegacyInvitationFactsReview){
 ensureOnlyFields(r,['ref','attempt','actor','resource','notBefore','expiresAt','sourceDigest','bodyDigest','phase','nonce','systemIdentifier']);ensureOnlyFields(r.actor,['userId','sessionId']);ensureOnlyFields(r.resource,['host','port','database','oid','owner','ownerOid','marker','role','roleOid','migrationProfile','systemIdentifier','nonce']);
 const clone=cloneCountsReview(r);if(r.systemIdentifier!==undefined&&!clone)throw invalid('Delivery clone only admits exact reviewed count closure');
 if(clone&&(r.resource.migrationProfile!==undefined||r.resource.systemIdentifier!==undefined||r.resource.nonce!==undefined)
  ||r.resource.migrationProfile!==undefined&&r.nonce!==undefined&&r.nonce!==r.resource.nonce)throw invalid('Invitation target profile or epoch differs');
 if(r.phase==='QUALIFY'&&r.resource.database==='zzsh_test_regression'&&(typeof r.nonce!=='string'||!/^[a-z0-9_]{12,40}$/.test(r.nonce)))throw invalid('Exact qualification regression epoch required');
 if(![r.ref,r.attempt,r.actor.userId,r.actor.sessionId].every(x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(x))||!hex.test(r.sourceDigest)||!hex.test(r.bodyDigest)||!['IMPORT','COUNTS','QUALIFY'].includes(r.phase)
  ||r.resource.host!=='127.0.0.1'||!clone&&!isReviewedFinanceMaintenanceEndpoint(r.resource)||r.resource.database==='zzsh_test_regression'&&!isReviewedFinanceMaintenanceResource(r.resource)||r.resource.oid===2220718||!/^(zzsh_dev_daily|zzsh_test_[a-z0-9_]+)$/.test(r.resource.database)
  ||![r.resource.oid,r.resource.ownerOid,r.resource.roleOid].every(x=>Number.isSafeInteger(x)&&x>0&&x<=4294967295)||![r.resource.owner,r.resource.role].every(x=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(x))
  ||typeof r.resource.marker!=='string'||!r.resource.marker||r.resource.marker.length>1024||/[\x00-\x1f\x7f]/.test(r.resource.marker)
  ||![r.notBefore,r.expiresAt].every(x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x)))||Date.parse(r.expiresAt)<=Date.parse(r.notBefore))throw invalid('Exact internal invitation fact review required');
}
async function resource(c:PoolClient,actor:Actor,r:LegacyInvitationFactsReview,recover=false,planOnly=false){
 transaction(c);const p=(c as PoolClient&{connectionParameters?:{host:string;port:number;database:string;user:string}}).connectionParameters;
 if(!p||p.host!==r.resource.host||Number(p.port)!==r.resource.port||p.database!==r.resource.database||p.user!==r.resource.role||actor.userId!==r.actor.userId||actor.sessionId!==r.actor.sessionId)throw forbidden('Invitation review connection or actor differs');
 const row=(await c.query(`/* invitation-facts resource */ SELECT d.oid::int AS oid,current_database() AS database,pg_get_userbyid(d.datdba) AS owner,d.datdba::int AS "ownerOid",
  shobj_description(d.oid,'pg_database') AS marker,current_user AS role,r.oid::int AS "roleOid",clock_timestamp() AS now,current_setting('transaction_read_only') AS read_only,current_setting('zzsh.regression_run',true) AS nonce,
  (SELECT count(*)::int FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='zzsh_order' AND t.relname IN('distribution_participant','distribution_invite_code','invitation_relation') AND pg_get_userbyid(t.relowner)=current_user) AS owned,
  zzsh_order.distribution_policy_contract_version()>=2 AS complete${cloneCountsReview(r)||r.resource.migrationProfile!==undefined?`,(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"`:''}
  FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
 if(!row||['oid','database','owner','ownerOid','marker','role','roleOid'].some(k=>row[k]!==r.resource[k as keyof LegacyInvitationFactsReview['resource']])||r.nonce!==undefined&&row.nonce!==r.nonce
  ||cloneCountsReview(r)&&row.systemIdentifier!==r.systemIdentifier||r.resource.migrationProfile!==undefined&&(row.systemIdentifier!==r.resource.systemIdentifier||row.nonce!==r.resource.nonce)
  ||row.owned!==3||row.complete!==true||!planOnly&&!recover&&row.read_only!=='off')throw conflict('Invitation target identity, table ownership or contract differs');
 const now=new Date(row.now).getTime();if(!Number.isFinite(now)||now<Date.parse(r.notBefore)||!recover&&now>=Date.parse(r.expiresAt))throw forbidden('Invitation fact execution window is not active');
}
async function admitted(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,scope:LegacyInvitationFactsAdmission,phase:'IMPORT'|'COUNTS',recover=false){
 const a=admissions.get(scope);if(!a||a.review.phase!==phase||!recover&&a.recoverOnly||a.review.bodyDigest!==invitationFactHash(input)||a.review.sourceDigest!==invitationFactHash(input.source))throw forbidden('Original invitation fact admission differs');
 await resource(c,actor,a.review,recover);await authorizeFinanceMaintenance(c,actor);return a.review;
}
function qualificationContext(review:LegacyInvitationFactsReview){const {bodyDigest:_,...context}=review;return canonicalize(context);}
function qualificationActor(actor:Actor){return canonicalize(actor);}
async function assertQualificationIndex(c:PoolClient,actor:Actor,review:LegacyInvitationFactsReview,index:LegacyQualificationIndex){
 transaction(c);const state=qualificationIndexes.get(index);
 if(!state||state.client!==c||state.actor!==qualificationActor(actor)||state.context!==qualificationContext(review))throw forbidden('Qualification index scope differs');
 const row=(await c.query(`/* qualification index transaction */ SELECT pg_current_xact_id_if_assigned()::text AS xid,
  EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND relation='zzsh_iam.audit_event'::regclass AND mode='ShareLock' AND granted) AS source_locked`)).rows[0];
 if(!row||row.xid!==state.xid||row.source_locked!==true)throw conflict('Qualification index transaction or source lock changed');
 const events=(await c.query("/* qualification index source versions */ SELECT id,xmin::text AS version FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.imported' AND outcome='SUCCESS' ORDER BY id")).rows;
 if(canonicalize(events)!==state.events)throw conflict('Original qualification audit source changed');
 return state;
}

/** Internal maintenance assembly only. This opaque token cannot be supplied through request JSON. */
export async function bindReviewedLegacyInvitationFacts(c:PoolClient,actor:Actor,review:LegacyInvitationFactsReview,mode:'execute'|'recover'='execute',qualificationIndex?:LegacyQualificationIndex):Promise<LegacyInvitationFactsAdmission>{
 reviewShape(review);if(!['execute','recover'].includes(mode))throw invalid('Original invitation admission mode required');await resource(c,actor,review,mode==='recover');await authorizeFinanceMaintenance(c,actor);
 if(qualificationIndex){if(mode!=='execute'||review.phase!=='QUALIFY')throw forbidden('Qualification index is limited to reviewed execution');await assertQualificationIndex(c,actor,review,qualificationIndex);}
 const value=Object.freeze({kind:'REVIEWED_LEGACY_INVITATION_FACTS' as const});admissions.set(value,{review:JSON.parse(canonicalize(review)),recoverOnly:mode==='recover',qualificationIndex});return value;
}

/** The audit source and graph stay locked until the caller commits or rolls back this local transaction. */
export async function prepareReviewedLegacyQualificationIndex(c:PoolClient,actor:Actor,scope:LegacyInvitationFactsAdmission):Promise<LegacyQualificationIndex>{
 const admission=admissions.get(scope);if(!admission||admission.recoverOnly||admission.review.phase!=='QUALIFY'||admission.review.resource.database!=='zzsh_test_regression')throw forbidden('Reviewed local qualification admission required');
 const review=admission.review;await resource(c,actor,review);await authorizeFinanceMaintenance(c,actor);await lockActor(c,actor);
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 await c.query('LOCK TABLE zzsh_iam.audit_event IN SHARE MODE');
 const xid=(await c.query('/* qualification index pin transaction */ SELECT pg_current_xact_id()::text AS xid')).rows[0]?.xid;
 if(typeof xid!=='string'||!/^\d+$/.test(xid))throw conflict('Qualification transaction identity unavailable');
 const events=(await c.query("/* qualification index source versions */ SELECT id,xmin::text AS version FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.imported' AND outcome='SUCCESS' ORDER BY id")).rows;
 if(!events.length||events.some(row=>typeof row.id!=='string'||typeof row.version!=='string'||!/^\d+$/.test(row.version)||BigInt(row.version)===(BigInt(xid)&4294967295n)))throw conflict('Original qualification audit source is not stable');
 const facts=new Map<string,IndexedFact|null>();let selected=0;
 for(const event of events){
  const rows=(await c.query("/* qualification index source packet */ SELECT details->'source' AS source,details->'facts' AS facts,jsonb_typeof(details->'facts') AS facts_type,details#>>'{source,receiptSha256}' AS receipt FROM zzsh_iam.audit_event WHERE id=$1 AND xmin::text=$2",[event.id,event.version])).rows;
  if(rows.length!==1)throw conflict('Original qualification audit packet changed');const row=rows[0];if(row.receipt!==review.sourceDigest)continue;selected++;
  if(row.facts_type===null)continue;if(row.facts_type!=='array'||!Array.isArray(row.facts))throw conflict('Original qualification audit facts are invalid');
  for(const raw of row.facts){const fact=raw as LegacyInvitationRawFact,id=fact?.userId;if(typeof id!=='string')continue;
   if(facts.has(id)){facts.set(id,null);continue;}
   try{const source=row.source as LegacyInvitationFactSource,sourceDigest=invitationFactSourceDigest(source,fact);facts.set(id,{sourceDigest,projection:projectLegacyInvitationQualification(source,fact,sourceDigest)});}catch{facts.set(id,null);}
  }
 }
 if(!selected)throw conflict('Original qualification audit source is missing');
 const index=Object.freeze({kind:'REVIEWED_LEGACY_QUALIFICATION_INDEX' as const});qualificationIndexes.set(index,{client:c,actor:qualificationActor(actor),context:qualificationContext(review),xid,events:canonicalize(events),facts});
 await assertQualificationIndex(c,actor,review,index);return index;
}

export async function readReviewedLegacyQualificationIndex(c:PoolClient,actor:Actor,review:LegacyInvitationFactsReview,index:LegacyQualificationIndex,ids:string[]){
 const state=await assertQualificationIndex(c,actor,review,index),result=new Map<string,ReturnType<typeof projectLegacyInvitationQualification>>();
 const rows=(await c.query("/* qualification index participants */ SELECT user_id,source_digest FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL' AND user_id=ANY($1::text[])",[ids])).rows;
 for(const row of rows){const fact=state.facts.get(row.user_id);if(fact&&fact.sourceDigest===row.source_digest)result.set(row.user_id,fact.projection);}return result;
}
const digestFingerprint=(operation:string,bodyDigest:string)=>fingerprintRequest(operation,undefined,{bodyDigest});
export type LegacyQualificationBatch={
 scope:'LOCAL_CONTROLLED'|'NATIVE';policyId:string;policyDigest:string;
 subjects:{userId:string;sourceDigest:string;revision:string;levelCode:string;frozen:boolean}[];
};

/** Root-admitted metadata transition using the original audited qualification and the exact active policy. */
export async function qualifyReviewedLegacyParticipants(c:PoolClient,actor:Actor,input:LegacyQualificationBatch,scope:LegacyInvitationFactsAdmission){
 const admission=admissions.get(scope),bodyDigest=invitationFactHash(input);
 if(!admission||admission.recoverOnly||admission.review.phase!=='QUALIFY'||admission.review.bodyDigest!==bodyDigest)throw forbidden('Reviewed legacy qualification batch required');
 const review=admission.review;
 ensureOnlyFields(input,['scope','policyId','policyDigest','subjects']);
 if(!['LOCAL_CONTROLLED','NATIVE'].includes(input.scope)||!hex.test(input.policyDigest)||!Array.isArray(input.subjects)||!input.subjects.length||input.subjects.length>1000)throw invalid('Bounded exact legacy qualification batch required');
 for(const s of input.subjects){
  ensureOnlyFields(s,['userId','sourceDigest','revision','levelCode','frozen']);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(s.userId)||!hex.test(s.sourceDigest)||!/^[1-9]\d{0,18}$/.test(s.revision)||!/^legacy_[1-9]\d{0,18}$/.test(s.levelCode)||typeof s.frozen!=='boolean')throw invalid('Original qualification subject and revision required');
 }
 const ids=input.subjects.map(s=>s.userId).sort();
 if(new Set(ids).size!==ids.length)throw invalid('Duplicate original qualification subject');
 const verify=async()=>{await resource(c,actor,review);await authorizeFinanceMaintenance(c,actor);};
 await verify();await lockActor(c,actor);
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 const operation='distribution.legacy-qualification.v1',key='legacy-qualification-'+bodyDigest;
 const result=await withIdempotency(c,{realm:'admin',principalId:actor.userId,operation},key,digestFingerprint(operation,bodyDigest),verify,async()=>{
  const locked=await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[ids]);
  if(locked.rowCount!==ids.length)throw conflict('Original qualification subject missing');
  const {policy}=await readDistributionPolicyRowInTransaction(c,true,input.scope);
  if(!policy||policy.versionId!==input.policyId||policy.digest!==input.policyDigest||policy.config.schema!=='distribution-policy.v3'||!policy.config.enabled||policy.config.legacySource.receiptSha256!==review.sourceDigest)throw conflict('Reviewed active legacy policy differs');
  const codes=new Set(policy.config.levels.map(l=>l.code));
  const original=admission.qualificationIndex?await readReviewedLegacyQualificationIndex(c,actor,review,admission.qualificationIndex,ids):await readLegacyDistributionQualifications(c,ids,review.sourceDigest);
  for(const s of input.subjects){const fact=original.get(s.userId);if(!fact||fact.eligibility!=='ELIGIBLE'||fact.commissionFrozen!==s.frozen||s.levelCode!=='legacy_'+fact.levelId||!codes.has(s.levelCode))throw conflict('Original qualification flags or active level differ');}
  const updated=await c.query(`UPDATE zzsh_order.distribution_participant p SET eligibility='ELIGIBLE',level_code=x."levelCode",policy_version_id=$2,revision=p.revision+1
    FROM jsonb_to_recordset($1::jsonb) x("userId" text,"sourceDigest" text,revision bigint,"levelCode" text,frozen boolean)
    WHERE p.user_id=x."userId" AND p.source_digest=x."sourceDigest" AND p.revision=x.revision
      AND p.source_type='LEGACY_MYSQL' AND p.eligibility='UNKNOWN' AND p.policy_version_id IS NULL AND p.level_code IS NULL
      AND p.commission_frozen IS NOT DISTINCT FROM x.frozen`,[JSON.stringify(input.subjects),input.policyId]);
  if(updated.rowCount!==ids.length)throw conflict('Original participant qualification CAS differs');
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.legacy_qualification.admitted',objectType:'distribution_policy_version',objectId:input.policyId,outcome:'SUCCESS',reason:'Reviewed legacy grade and qualification provenance',details:{bodyDigest,participants:ids.length,sourceDigest:review.sourceDigest,reviewRef:review.ref,attempt:review.attempt,financialEffects:false}});
  await verify();
  return {status:200,body:{bodyDigest,policyId:input.policyId,participants:ids.length,financialEffects:false}};
 });
 if(admission.qualificationIndex)await assertQualificationIndex(c,actor,review,admission.qualificationIndex);return result;
}

const fingerprint=(operation:string,input:LegacyInvitationFactsInput)=>digestFingerprint(operation,invitationFactHash(input));
const systemActor=(actor:InvitationActor):actor is SystemInvitationMigrationActor=>'kind' in actor&&actor.kind==='SYSTEM_INVITATION_MIGRATION';
const receiptScope=(actor:InvitationActor,operation:string)=>JSON.stringify([systemActor(actor)?'system':'admin',systemActor(actor)?actor.id:actor.userId,operation,null]);
function expectedReceipt(input:LegacyInvitationFactsInput){const p=prepareLegacyInvitationFacts(input,invitationFactHash(input));return{bodyDigest:p.bodyDigest,sourceDigest:invitationFactHash(input.source),policyVersionId:input.policy?.versionId??null,participants:p.subjects.length,codes:p.subjects.length,relations:p.relations.length,financialEffects:false,
 subjectProofs:p.subjects.map(s=>({userId:s.userId,sourceDigest:s.sourceDigest}))};}
async function requireOriginalAudit(c:PoolClient,actor:InvitationActor,bodyDigest:string,action:string,details:Record<string,unknown>){
 const rows=(await c.query(`/* invitation-facts original audit */ SELECT actor_type,actor_id,session_id,details,to_jsonb(e)->>'legacy_migration_manifest_sha256' AS source_manifest FROM zzsh_iam.audit_event e
  WHERE object_id=$1 AND action=$2 AND object_type='legacy_invitation_batch' AND outcome='SUCCESS'`,[bodyDigest,action])).rows;
 const row=rows[0],identity=systemActor(actor)?row?.actor_type==='system'&&row.actor_id===actor.id&&row.session_id===null&&row.source_manifest===actor.sourceDatasetSha256
  :row?.actor_type==='admin'&&row.actor_id===actor.userId&&typeof row.session_id==='string'&&!!row.session_id;
 if(rows.length!==1||!identity||canonicalize(row.details)!==canonicalize(details))
  throw conflict('Original invitation audit is missing or differs');
}
async function requireImportReceipt(c:PoolClient,actor:InvitationActor,input:LegacyInvitationFactsInput){
 const p=prepareLegacyInvitationFacts(input,invitationFactHash(input)),row=(await c.query('/* invitation-facts original receipt */ SELECT request_fingerprint,response_status,response_body,publish_required FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2',[receiptScope(actor,legacyInvitationFactsOperation),p.key])).rows[0];
 if(!row||row.request_fingerprint!==fingerprint(legacyInvitationFactsOperation,input)||row.response_status!==200||row.publish_required!==false||canonicalize(row.response_body)!==canonicalize(expectedReceipt(input)))throw conflict('Original successful invitation import receipt required');
 await requireOriginalAudit(c,actor,p.bodyDigest,factAction,{bodyDigest:p.bodyDigest,source:input.source,facts:input.subjects,financialEffects:false});
}
async function identityProofs(c:PoolClient,input:LegacyInvitationFactsInput,lock:boolean){
 const all=[...input.subjects,...input.anchors.map(a=>a.fact)],rows=(await c.query(`/* invitation-facts identities */ SELECT x.user_id,x.legacy_id,x.identity_digest,
  EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=x.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS'
   AND a.details->>'sourceSystem'='legacy_mysql_restore' AND a.details->>'sourceEntity'='la_user' AND a.details->>'legacyId'=x.legacy_id AND a.details->>'sourceDigest'=x.identity_digest) AS proved
  FROM jsonb_to_recordset($1::jsonb) x(user_id text,legacy_id text,identity_digest text) JOIN zzsh_auth_user."user" u ON u.id=x.user_id ORDER BY u.id ${lock?'FOR UPDATE OF u':''}`,
  [JSON.stringify(all.map(s=>({user_id:s.userId,legacy_id:s.legacyId,identity_digest:s.identitySourceDigest})))])).rows;
 if(rows.length!==all.length||rows.some(r=>r.proved!==true))throw conflict('Original migrated identity/source digest is not closed');
}
async function immutableRows(c:PoolClient,input:LegacyInvitationFactsInput,subjects:LegacyInvitationFactsInput['subjects'],includeAudit=false){
 const ids=subjects.map(s=>s.userId),participants=(await c.query('/* invitation-facts participants */ SELECT user_id,source_type,source_ref,source_digest,revision::text,invitees_knowledge FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[])',[ids])).rows;
 const codes=(await c.query("/* invitation-facts codes */ SELECT id,user_id,display_code,match_code,source_type,source_system,source_entity,source_id,source_digest FROM zzsh_order.distribution_invite_code WHERE user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL'",[ids])).rows;
 const edges=(await c.query("/* invitation-facts original edges */ SELECT id,type,child_user_id,parent_user_id,policy_version_id,source_type,source_ref,source_digest FROM zzsh_order.invitation_relation WHERE child_user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL'",[ids])).rows;
 const pm=new Map(participants.map(r=>[r.user_id,r])),cm=new Map(codes.map(r=>[r.user_id,r])),em=new Map(edges.map(r=>[r.id,r]));let wantedEdges=0;
 if(participants.length!==subjects.length||codes.length!==subjects.length)throw conflict('Original invitation participant/code source is missing');
 for(const s of subjects){const p=pm.get(s.userId),code=cm.get(s.userId),sourceDigest=invitationFactSourceDigest(input.source,s);
  if(!p||p.source_type!=='LEGACY_MYSQL'||p.source_ref!==input.source.sourceSystem+':la_user:'+s.legacyId+':invitation-facts:v2'||p.source_digest!==sourceDigest
   ||!code||code.id!==invitationFactCodeId(s.legacyId)||code.user_id!==s.userId||code.display_code!==s.codeSource.code||code.match_code!==s.codeSource.code.toUpperCase()||code.source_type!=='LEGACY_MYSQL'||code.source_system!==input.source.sourceSystem||code.source_entity!=='la_user'||code.source_id!==s.legacyId||code.source_digest!==invitationFactHash(s.codeSource))throw conflict('Original immutable invitation fact/code differs');
  for(const type of invitationFactTypes)if(s.parents[type].knowledge==='KNOWN_PARENT'){
   const expected=prepareEdge(input.source,s,type),row=em.get(expected.id);wantedEdges++;
   if(!row||row.type!==expected.type||row.child_user_id!==expected.childUserId||row.parent_user_id!==expected.parentUserId||row.policy_version_id!==(input.policy?.versionId??null)||row.source_ref!==expected.sourceRef||row.source_digest!==expected.sourceDigest)throw conflict('Original immutable invitation edge differs');
  }
 }if(edges.length!==wantedEdges)throw conflict('Unexpected original invitation edge exists');
 if(includeAudit){const p=prepareLegacyInvitationFacts(input,invitationFactHash(input)),audit=(await c.query("/* invitation-facts canonical provenance */ SELECT details FROM zzsh_iam.audit_event WHERE object_id=$1 AND action=$2 AND outcome='SUCCESS'",[p.bodyDigest,factAction])).rows;
  if(audit.length!==1||canonicalize(audit[0]!.details)!==canonicalize({bodyDigest:p.bodyDigest,source:input.source,facts:input.subjects,financialEffects:false}))throw conflict('Original canonical qualification/user/code provenance differs');
 }return{participants,codes,edges};
}
// The relation function is the same pure source projection used by the whole-population planner.
import {invitationFactRelation as prepareEdge} from './legacy-invitation-facts';
async function anchors(c:PoolClient,actor:InvitationActor,input:LegacyInvitationFactsInput){
 if(!input.anchors.length)return;
 const keys=[...new Set(input.anchors.map(a=>a.batchKey))],rows=(await c.query('/* invitation-facts parent receipts */ SELECT key,request_fingerprint,response_status,response_body,publish_required FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])',[receiptScope(actor,legacyInvitationFactsOperation),keys])).rows;
 const receipts=new Map(rows.map(r=>[r.key,{...r,proofs:new Map((Array.isArray(r.response_body?.subjectProofs)?r.response_body.subjectProofs:[]).map((p:any)=>[p.userId,p.sourceDigest]))}]));
 for(const a of input.anchors){const r=receipts.get(a.batchKey),body=r?.response_body;if(!r||r.request_fingerprint!==digestFingerprint(legacyInvitationFactsOperation,a.batchDigest)||r.response_status!==200||r.publish_required!==false||body?.bodyDigest!==a.batchDigest||body?.sourceDigest!==invitationFactHash(input.source)||body.policyVersionId!==(input.policy?.versionId??null)||r.proofs.get(a.fact.userId)!==invitationFactSourceDigest(input.source,a.fact))throw conflict('Original imported parent receipt differs');}
 await immutableRows(c,input,input.anchors.map(a=>a.fact));
}
async function currentPolicy(c:PoolClient,input:LegacyInvitationFactsInput,lock=false){
 if(input.policy===null)return;const p=input.policy,row=(await c.query('/* invitation-facts existing policy */ SELECT v.scope,v.schema_version,v.canonical_config,v.config_digest,h.current_version_id FROM zzsh_order.distribution_policy_version v JOIN zzsh_order.distribution_policy_head h ON h.scope=v.scope WHERE v.id=$1'+(lock?' FOR SHARE OF v,h':''),[p.versionId])).rows[0];
 if(!row||row.scope!==p.scope||row.schema_version!=='distribution-policy.v2'||row.current_version_id!==p.versionId||row.config_digest!==p.configDigest||row.canonical_config!==canonicalize(p.config))throw conflict('Exact published uniform policy head is not available');
}
async function lockActor(c:PoolClient,actor:Actor){await c.query('SELECT s.id FROM zzsh_auth_admin.session s JOIN zzsh_auth_admin."user" u ON u.id=s."userId" JOIN zzsh_iam.admin_security a ON a.admin_user_id=u.id WHERE s.id=$1 AND u.id=$2 FOR SHARE OF s,u,a',[actor.sessionId,actor.userId]);}
async function insertOriginalInvitationRows(c:PoolClient,input:LegacyInvitationFactsInput,p:ReturnType<typeof prepareLegacyInvitationFacts>){
 const ids=p.subjects.map(s=>s.userId),conflicts=(await c.query(`/* invitation-facts no overwrite */ SELECT
  EXISTS(SELECT 1 FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[])) OR
  EXISTS(SELECT 1 FROM zzsh_order.distribution_invite_code WHERE user_id=ANY($1::text[]) OR match_code=ANY($2::text[])) OR
  EXISTS(SELECT 1 FROM zzsh_order.invitation_relation WHERE child_user_id=ANY($1::text[])) AS present`,[ids,input.subjects.map(s=>s.codeSource.code.toUpperCase())])).rows[0];if(!conflicts||conflicts.present!==false)throw conflict('Existing invitation fact/code/relation cannot be overwritten');
 await c.query('SET CONSTRAINTS ALL DEFERRED');
 const participants=p.subjects.map(s=>({user_id:s.userId,eligibility:s.eligibility,commission_frozen:s.commissionFrozen,policy_version_id:s.policyVersionId,inviter_knowledge:s.inviterKnowledge,leader_knowledge:s.leaderKnowledge,invitees_knowledge:s.inviteesKnowledge,source_ref:s.sourceRef,source_digest:s.sourceDigest}));
 await c.query(`INSERT INTO zzsh_order.distribution_participant(user_id,eligibility,commission_frozen,level_code,policy_version_id,revision,inviter_knowledge,leader_knowledge,invitees_knowledge,source_type,source_ref,source_digest)
  SELECT x.user_id,x.eligibility,x.commission_frozen,NULL,x.policy_version_id,1,x.inviter_knowledge,x.leader_knowledge,x.invitees_knowledge,'LEGACY_MYSQL',x.source_ref,x.source_digest
  FROM jsonb_to_recordset($1::jsonb) x(user_id text,eligibility text,commission_frozen boolean,policy_version_id text,inviter_knowledge text,leader_knowledge text,invitees_knowledge text,source_ref text,source_digest text) ORDER BY x.user_id`,[JSON.stringify(participants)]);
 await c.query(`INSERT INTO zzsh_order.distribution_invite_code(id,user_id,display_code,source_type,source_system,source_entity,source_id,source_digest)
  SELECT x.id,x.user_id,x.code,'LEGACY_MYSQL','legacy_mysql_restore','la_user',x.legacy_id,x.digest FROM jsonb_to_recordset($1::jsonb) x(id text,user_id text,code text,legacy_id text,digest text) ORDER BY x.id`,[JSON.stringify(p.subjects.map(s=>({id:s.codeId,user_id:s.userId,code:s.fact.codeSource.code,legacy_id:s.fact.legacyId,digest:s.codeDigest})))]);
 if(p.relations.length)await c.query(`INSERT INTO zzsh_order.invitation_relation(id,type,child_user_id,parent_user_id,policy_version_id,source_type,source_ref,source_digest)
  SELECT x.id,x.type,x.child_user_id,x.parent_user_id,$2::text,'LEGACY_MYSQL',x.source_ref,x.source_digest FROM jsonb_to_recordset($1::jsonb) x(id text,type text,child_user_id text,parent_user_id text,source_ref text,source_digest text) ORDER BY x.id`,[JSON.stringify(p.relations.map(r=>({id:r.id,type:r.type,child_user_id:r.childUserId,parent_user_id:r.parentUserId,source_ref:r.sourceRef,source_digest:r.sourceDigest}))),input.policy?.versionId??null]);
}
/** Read-only exact target preflight for Root; this result is not execution authority. */
export async function planReviewedLegacyInvitationFactsTarget(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,reviewedDigest:string,review:LegacyInvitationFactsReview){
 const p=prepareLegacyInvitationFacts(input,reviewedDigest);reviewShape(review);if(review.bodyDigest!==p.bodyDigest||review.sourceDigest!==invitationFactHash(input.source))throw conflict('Target plan review differs');
 await resource(c,actor,review,false,true);await authorizeFinanceMaintenance(c,actor);await identityProofs(c,input,false);await anchors(c,actor,input);await currentPolicy(c,input);
 const conflicts=(await c.query(`/* invitation-facts target conflicts */ SELECT
  (SELECT count(*)::text FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[])) AS participants,
  (SELECT count(*)::text FROM zzsh_order.distribution_invite_code WHERE user_id=ANY($1::text[]) OR match_code=ANY($2::text[])) AS codes,
  (SELECT count(*)::text FROM zzsh_order.invitation_relation WHERE child_user_id=ANY($1::text[])) AS relations`,[p.subjects.map(s=>s.userId),input.subjects.map(s=>s.codeSource.code.toUpperCase())])).rows[0];
 if(!conflicts||Object.values(conflicts).some(v=>v!=='0'))throw conflict('Target participant/code/relation already exists; recover original key before continuing');
 return{bodyDigest:p.bodyDigest,key:p.key,sourceDigest:invitationFactHash(input.source),participants:p.subjects.length,codes:p.subjects.length,relations:p.relations.length,conflicts,financialEffects:false,executable:false};
}
/** No transaction management here: every write, original receipt and audit belongs to Root's caller-owned checkpoint. */
export async function importReviewedLegacyInvitationFacts(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,reviewedDigest:string,scope:LegacyInvitationFactsAdmission){
 const p=prepareLegacyInvitationFacts(input,reviewedDigest);await admitted(c,actor,input,scope,'IMPORT');await lockActor(c,actor);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 const result=await withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:legacyInvitationFactsOperation},p.key,fingerprint(legacyInvitationFactsOperation,input),()=>admitted(c,actor,input,scope,'IMPORT').then(()=>undefined),async()=>{
  await identityProofs(c,input,true);await anchors(c,actor,input);await currentPolicy(c,input,true);
  await insertOriginalInvitationRows(c,input,p);
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:factAction,objectType:'legacy_invitation_batch',objectId:p.bodyDigest,outcome:'SUCCESS',reason:'Reviewed original invitation facts; no financial replay',details:{bodyDigest:p.bodyDigest,source:input.source,facts:input.subjects,financialEffects:false}});
  await admitted(c,actor,input,scope,'IMPORT');await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:expectedReceipt(input)};
 });
 if(canonicalize(result.body)!==canonicalize(expectedReceipt(input)))throw conflict('Original invitation receipt differs');await requireImportReceipt(c,actor,input);await identityProofs(c,input,false);await immutableRows(c,input,input.subjects,true);await admitted(c,actor,input,scope,'IMPORT');return result;
}

async function countsProof(c:PoolClient,input:LegacyInvitationFactsInput){
 const ids=input.subjects.map(s=>s.userId),rows=(await c.query("/* invitation-facts all original children */ SELECT id,type,parent_user_id,source_digest FROM zzsh_order.invitation_relation WHERE parent_user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL' ORDER BY id COLLATE \"C\"",[ids])).rows;
 const byParent=new Map<string,Record<string,Array<[string,string]>>>();for(const r of rows){if(!invitationFactTypes.includes(r.type))throw conflict('Original relation type differs');const p=byParent.get(r.parent_user_id)??{};(p[r.type]??=[]).push([r.id,r.source_digest]);byParent.set(r.parent_user_id,p);}
 return input.subjects.map(s=>{for(const t of invitationFactTypes){const actual=byParent.get(s.userId)?.[t]??[],proof=s.children[t];if(actual.length!==proof.knownCount||invitationFactHash(actual)!==proof.setDigest)throw conflict('Original child relation set is not completely imported');}
  return{userId:s.userId,knowledge:invitationFactTypes.every(t=>s.children[t].sourceCount===s.children[t].knownCount)?'KNOWN':'UNKNOWN',sourceDigest:invitationFactSourceDigest(input.source,s)};});
}
async function closeOriginalInvitationCounts(c:PoolClient,input:LegacyInvitationFactsInput,p:ReturnType<typeof prepareLegacyInvitationFacts>){
 await identityProofs(c,input,true);await immutableRows(c,input,input.subjects,true);const counts=await countsProof(c,input);
 const revisions=(await c.query('/* invitation-facts count CAS */ SELECT user_id,revision::text,invitees_knowledge FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR UPDATE',[counts.map(s=>s.userId)])).rows,map=new Map(revisions.map(r=>[r.user_id,r]));
 const updates=counts.filter(s=>map.get(s.userId)?.invitees_knowledge!==s.knowledge).map(s=>({user_id:s.userId,knowledge:s.knowledge,source_digest:s.sourceDigest,revision:map.get(s.userId)?.revision}));
 if(updates.length){const changed=await c.query(`UPDATE zzsh_order.distribution_participant p SET invitees_knowledge=x.knowledge,revision=p.revision+1 FROM jsonb_to_recordset($1::jsonb) x(user_id text,knowledge text,source_digest text,revision bigint)
  WHERE p.user_id=x.user_id AND p.source_type='LEGACY_MYSQL' AND p.source_digest=x.source_digest AND p.revision=x.revision`,[JSON.stringify(updates)]);if(changed.rowCount!==updates.length)throw conflict('Invitation count revision changed');}
 return{bodyDigest:p.bodyDigest,sourceDigest:invitationFactHash(input.source),subjects:counts.length,known:counts.filter(s=>s.knowledge==='KNOWN').length,unknown:counts.filter(s=>s.knowledge==='UNKNOWN').length,financialEffects:false};
}
export async function closeReviewedLegacyInvitationCounts(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,reviewedDigest:string,scope:LegacyInvitationFactsAdmission){
 const p=prepareLegacyInvitationFacts(input,reviewedDigest);await admitted(c,actor,input,scope,'COUNTS');await lockActor(c,actor);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 await requireImportReceipt(c,actor,input);
 const result=await withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:legacyInvitationCountsOperation},p.key,fingerprint(legacyInvitationCountsOperation,input),()=>admitted(c,actor,input,scope,'COUNTS').then(()=>undefined),async()=>{
  const body=await closeOriginalInvitationCounts(c,input,p);
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:countAction,objectType:'legacy_invitation_batch',objectId:p.bodyDigest,outcome:'SUCCESS',reason:'Exact original child set reconciled',details:body});await admitted(c,actor,input,scope,'COUNTS');await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body};
 });
 const recovered=await recoverReviewedLegacyInvitationFacts(c,actor,input,reviewedDigest,scope,'COUNTS');if(recovered.knowledge!=='KNOWN')throw conflict('Original invitation count receipt unavailable');await admitted(c,actor,input,scope,'COUNTS');return result;
}
async function recoverOriginalInvitationFacts(c:PoolClient,actor:InvitationActor,input:LegacyInvitationFactsInput,p:ReturnType<typeof prepareLegacyInvitationFacts>,phase:'IMPORT'|'COUNTS'){
 const operation=phase==='IMPORT'?legacyInvitationFactsOperation:legacyInvitationCountsOperation;
 const row=(await c.query('/* invitation-facts original receipt */ SELECT request_fingerprint,response_status,response_body,publish_required FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2',[receiptScope(actor,operation),p.key])).rows[0];if(!row)return{knowledge:'UNKNOWN' as const,receipt:null};
 if(phase==='COUNTS')await requireImportReceipt(c,actor,input);
 if(row.request_fingerprint!==fingerprint(operation,input)||row.response_status!==200||row.publish_required!==false)throw conflict('Original invitation receipt key/body differs');await identityProofs(c,input,false);await immutableRows(c,input,input.subjects,true);
 if(phase==='IMPORT'){if(canonicalize(row.response_body)!==canonicalize(expectedReceipt(input)))throw conflict('Original invitation import receipt differs');await requireOriginalAudit(c,actor,p.bodyDigest,factAction,{bodyDigest:p.bodyDigest,source:input.source,facts:input.subjects,financialEffects:false});}
 else{const counts=await countsProof(c,input),expected={bodyDigest:p.bodyDigest,sourceDigest:invitationFactHash(input.source),subjects:counts.length,known:counts.filter(s=>s.knowledge==='KNOWN').length,unknown:counts.filter(s=>s.knowledge==='UNKNOWN').length,financialEffects:false};
  if(canonicalize(row.response_body)!==canonicalize(expected))throw conflict('Original invitation count receipt differs');await requireOriginalAudit(c,actor,p.bodyDigest,countAction,expected);
  const current=(await c.query('SELECT user_id,invitees_knowledge FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[])',[counts.map(s=>s.userId)])).rows,m=new Map(current.map(r=>[r.user_id,r.invitees_knowledge]));if(counts.some(s=>m.get(s.userId)!==s.knowledge))throw conflict('Current original invitation count coverage differs');
 }return{knowledge:'KNOWN' as const,receipt:{status:row.response_status,body:row.response_body}};
}
/** Absence is UNKNOWN; this never writes a replacement key or repairs an uncertain commit. */
export async function recoverReviewedLegacyInvitationFacts(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,reviewedDigest:string,scope:LegacyInvitationFactsAdmission,phase:'IMPORT'|'COUNTS'='IMPORT'){
 const p=prepareLegacyInvitationFacts(input,reviewedDigest);await admitted(c,actor,input,scope,phase,true);
 const result=await recoverOriginalInvitationFacts(c,actor,input,p,phase);await admitted(c,actor,input,scope,phase,true);return result;
}

export type SystemInvitationReceiptBaseline=Readonly<{kind:'SYSTEM_INVITATION_RECEIPT_BASELINE'}>;
const systemInvitationBaselines=new WeakMap<object,{client:PoolClient;actor:SystemInvitationMigrationActor;binding:string;
 fence:SystemInvitationMigrationActor['assertMigrationFence'];source:SystemInvitationMigrationActor['assertSourceEvidence']}>();
const invitationBinding=(actor:SystemInvitationMigrationActor)=>canonicalize([actor.id,actor.requestId,actor.sourceDatasetSha256,actor.target,actor.fenceEpochSha256]);
function systemInvitationSource(input:LegacyInvitationFactsInput,phase:'IMPORT'|'COUNTS'){
 if(input.policy!==null)throw forbidden('System invitation migration cannot activate a distribution policy');
 const p=prepareLegacyInvitationFacts(input,invitationFactHash(input));return{phase,key:p.key,sourceDigest:invitationFactHash(input.source),bodyDigest:p.bodyDigest};
}
/** One baseline per exclusive migration fence; an existing foreign receipt requires review. */
export async function bindSystemInvitationReceiptBaseline(c:PoolClient,actor:SystemInvitationMigrationActor,input:LegacyInvitationFactsInput,phase:'IMPORT'|'COUNTS',readOnly=false):Promise<SystemInvitationReceiptBaseline>{
 const source=systemInvitationSource(input,phase);await authorizeSystemInvitationMigration(c,actor,source,readOnly);
 const imports=receiptScope(actor,legacyInvitationFactsOperation),counts=receiptScope(actor,legacyInvitationCountsOperation);
 const row=(await c.query(`/* invitation system original receipt baseline */ SELECT EXISTS(
   SELECT 1 FROM zzsh_supply.idempotency_record WHERE (position('"distribution.legacy-facts.v2.import"' IN scope_key)>0 OR position('"distribution.legacy-facts.v2.counts"' IN scope_key)>0)
     AND scope_key<>$1 AND scope_key<>$2) OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event e
       WHERE action IN ('distribution.legacy_facts.imported','distribution.legacy_facts.counts_closed') AND object_type='legacy_invitation_batch'
         AND (actor_type IS DISTINCT FROM 'system' OR actor_id IS DISTINCT FROM $3 OR to_jsonb(e)->>'legacy_migration_manifest_sha256' IS DISTINCT FROM $4)) AS conflicts`,
  [imports,counts,actor.id,actor.sourceDatasetSha256])).rows[0];
 if(typeof row?.conflicts!=='boolean'||row.conflicts)throw conflict('Existing invitation receipts or audits require review');
 await authorizeSystemInvitationMigration(c,actor,source,readOnly);
 const token=Object.freeze({kind:'SYSTEM_INVITATION_RECEIPT_BASELINE' as const});
 systemInvitationBaselines.set(token,{client:c,actor,binding:invitationBinding(actor),fence:actor.assertMigrationFence,source:actor.assertSourceEvidence});return token;
}
function assertSystemInvitationBaseline(c:PoolClient,actor:SystemInvitationMigrationActor,token:SystemInvitationReceiptBaseline){
 const bound=token&&systemInvitationBaselines.get(token);
 if(!bound||bound.client!==c||bound.actor!==actor||bound.binding!==invitationBinding(actor)||bound.fence!==actor.assertMigrationFence||bound.source!==actor.assertSourceEvidence)
  throw conflict('System invitation receipt baseline is unavailable');
}
async function noOrphanInvitationAudit(c:PoolClient,bodyDigest:string,action:string){
 const row=(await c.query(`SELECT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_type='legacy_invitation_batch' AND object_id=$1 AND action=$2) AS present`,[bodyDigest,action])).rows[0];
 if(row?.present!==false)throw conflict('Invitation batch has partial original evidence');
}
/** Exact original graph and qualifications only; no policy or commission is granted. */
export async function importSystemLegacyInvitationFacts(c:PoolClient,actor:SystemInvitationMigrationActor,input:LegacyInvitationFactsInput,baseline:SystemInvitationReceiptBaseline){
 const source=systemInvitationSource(input,'IMPORT'),p=prepareLegacyInvitationFacts(input,source.bodyDigest),verify=()=>authorizeSystemInvitationMigration(c,actor,source);
 await verify();assertSystemInvitationBaseline(c,actor,baseline);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 const result=await withIdempotency(c,{realm:'system',principalId:actor.id,operation:legacyInvitationFactsOperation},p.key,fingerprint(legacyInvitationFactsOperation,input),
  async replay=>{await verify();const previous=await recoverOriginalInvitationFacts(c,actor,input,p,'IMPORT');if((replay!==null)!==(previous.knowledge==='KNOWN'))throw conflict('Invitation import receipt is inconsistent');},
  async()=>{await noOrphanInvitationAudit(c,p.bodyDigest,factAction);await identityProofs(c,input,true);await anchors(c,actor,input);await setAuditContext(c,'system',actor.id,undefined,actor.requestId);
   await insertOriginalInvitationRows(c,input,p);await recordAudit(c,{actorType:'system',actorId:actor.id,legacyMigrationManifestSha256:actor.sourceDatasetSha256,requestId:actor.requestId,
    action:factAction,objectType:'legacy_invitation_batch',objectId:p.bodyDigest,outcome:'SUCCESS',details:{bodyDigest:p.bodyDigest,source:input.source,facts:input.subjects,financialEffects:false}});
   await verify();await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:expectedReceipt(input)};});
 await requireImportReceipt(c,actor,input);await identityProofs(c,input,false);await immutableRows(c,input,input.subjects,true);await verify();return result;
}
export async function closeSystemLegacyInvitationCounts(c:PoolClient,actor:SystemInvitationMigrationActor,input:LegacyInvitationFactsInput,baseline:SystemInvitationReceiptBaseline){
 const source=systemInvitationSource(input,'COUNTS'),p=prepareLegacyInvitationFacts(input,source.bodyDigest),verify=()=>authorizeSystemInvitationMigration(c,actor,source);
 await verify();assertSystemInvitationBaseline(c,actor,baseline);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");await requireImportReceipt(c,actor,input);
 const result=await withIdempotency(c,{realm:'system',principalId:actor.id,operation:legacyInvitationCountsOperation},p.key,fingerprint(legacyInvitationCountsOperation,input),
  async replay=>{await verify();const previous=await recoverOriginalInvitationFacts(c,actor,input,p,'COUNTS');if((replay!==null)!==(previous.knowledge==='KNOWN'))throw conflict('Invitation count receipt is inconsistent');},
  async()=>{await noOrphanInvitationAudit(c,p.bodyDigest,countAction);const body=await closeOriginalInvitationCounts(c,input,p);
   await recordAudit(c,{actorType:'system',actorId:actor.id,legacyMigrationManifestSha256:actor.sourceDatasetSha256,requestId:actor.requestId,
    action:countAction,objectType:'legacy_invitation_batch',objectId:p.bodyDigest,outcome:'SUCCESS',details:body});
   await verify();await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body};});
 const recovered=await recoverOriginalInvitationFacts(c,actor,input,p,'COUNTS');if(recovered.knowledge!=='KNOWN')throw conflict('Original invitation count receipt unavailable');await verify();return result;
}
/** Missing original receipt remains UNKNOWN; this entry only accepts a read-only recovery batch. */
export async function recoverSystemLegacyInvitationFacts(c:PoolClient,actor:SystemInvitationMigrationActor,input:LegacyInvitationFactsInput,baseline:SystemInvitationReceiptBaseline,phase:'IMPORT'|'COUNTS'='IMPORT'){
 const source=systemInvitationSource(input,phase),p=prepareLegacyInvitationFacts(input,source.bodyDigest);
 await authorizeSystemInvitationMigration(c,actor,source,true);assertSystemInvitationBaseline(c,actor,baseline);
 const result=await recoverOriginalInvitationFacts(c,actor,input,p,phase);await authorizeSystemInvitationMigration(c,actor,source,true);return result;
}
