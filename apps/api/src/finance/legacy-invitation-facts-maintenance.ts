import type {PoolClient} from 'pg';
import {recordAudit} from '../auth/security-core';
import {authorizeFinanceMaintenance} from './personal-finance-maintenance';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,invalid,conflict,forbidden,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {prepareLegacyInvitationFacts,invitationFactHash,invitationFactTypes,invitationFactSourceDigest,invitationFactCodeId,legacyInvitationFactsOperation,legacyInvitationCountsOperation,type LegacyInvitationFactsInput} from './legacy-invitation-facts';

type Actor={userId:string;sessionId:string;requestId:string};
export type LegacyInvitationFactsReview={ref:string;attempt:string;actor:{userId:string;sessionId:string};resource:{host:'127.0.0.1';port:55432;database:string;oid:number;owner:string;ownerOid:number;marker:string;role:string;roleOid:number};notBefore:string;expiresAt:string;sourceDigest:string;bodyDigest:string;phase:'IMPORT'|'COUNTS'};
export type LegacyInvitationFactsAdmission=Readonly<{kind:'REVIEWED_LEGACY_INVITATION_FACTS'}>;
const admissions=new WeakMap<object,{review:LegacyInvitationFactsReview;recoverOnly:boolean}>(),hex=/^[a-f0-9]{64}$/;
const factAction='distribution.legacy_facts.imported',countAction='distribution.legacy_facts.counts_closed';
function transaction(c:PoolClient){if(c.getTransactionStatus()!=='T')throw conflict('Caller-owned invitation fact transaction required');}
function reviewShape(r:LegacyInvitationFactsReview){
 ensureOnlyFields(r,['ref','attempt','actor','resource','notBefore','expiresAt','sourceDigest','bodyDigest','phase']);ensureOnlyFields(r.actor,['userId','sessionId']);ensureOnlyFields(r.resource,['host','port','database','oid','owner','ownerOid','marker','role','roleOid']);
 if(![r.ref,r.attempt,r.actor.userId,r.actor.sessionId].every(x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(x))||!hex.test(r.sourceDigest)||!hex.test(r.bodyDigest)||!['IMPORT','COUNTS'].includes(r.phase)
  ||r.resource.host!=='127.0.0.1'||r.resource.port!==55432||r.resource.database==='zzsh_test_regression'||r.resource.oid===2220718||!/^(zzsh_dev_daily|zzsh_test_[a-z0-9_]+)$/.test(r.resource.database)
  ||![r.resource.oid,r.resource.ownerOid,r.resource.roleOid].every(x=>Number.isSafeInteger(x)&&x>0&&x<=4294967295)||![r.resource.owner,r.resource.role].every(x=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(x))
  ||typeof r.resource.marker!=='string'||!r.resource.marker||r.resource.marker.length>1024||/[\x00-\x1f\x7f]/.test(r.resource.marker)
  ||![r.notBefore,r.expiresAt].every(x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x)))||Date.parse(r.expiresAt)<=Date.parse(r.notBefore))throw invalid('Exact internal invitation fact review required');
}
async function resource(c:PoolClient,actor:Actor,r:LegacyInvitationFactsReview,recover=false,planOnly=false){
 transaction(c);const p=(c as PoolClient&{connectionParameters?:{host:string;port:number;database:string;user:string}}).connectionParameters;
 if(!p||p.host!==r.resource.host||Number(p.port)!==r.resource.port||p.database!==r.resource.database||p.user!==r.resource.role||actor.userId!==r.actor.userId||actor.sessionId!==r.actor.sessionId)throw forbidden('Invitation review connection or actor differs');
 const row=(await c.query(`/* invitation-facts resource */ SELECT d.oid::int AS oid,current_database() AS database,pg_get_userbyid(d.datdba) AS owner,d.datdba::int AS "ownerOid",
  shobj_description(d.oid,'pg_database') AS marker,current_user AS role,r.oid::int AS "roleOid",clock_timestamp() AS now,current_setting('transaction_read_only') AS read_only,
  (SELECT count(*)::int FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='zzsh_order' AND t.relname IN('distribution_participant','distribution_invite_code','invitation_relation') AND pg_get_userbyid(t.relowner)=current_user) AS owned,
  zzsh_order.distribution_policy_contract_version()>=2 AS complete
  FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
 if(!row||['oid','database','owner','ownerOid','marker','role','roleOid'].some(k=>row[k]!==r.resource[k as keyof LegacyInvitationFactsReview['resource']])||row.owned!==3||row.complete!==true||!planOnly&&!recover&&row.read_only!=='off')throw conflict('Invitation target identity, table ownership or contract differs');
 const now=new Date(row.now).getTime();if(!Number.isFinite(now)||now<Date.parse(r.notBefore)||!recover&&now>=Date.parse(r.expiresAt))throw forbidden('Invitation fact execution window is not active');
}
async function admitted(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,scope:LegacyInvitationFactsAdmission,phase:'IMPORT'|'COUNTS',recover=false){
 const a=admissions.get(scope);if(!a||a.review.phase!==phase||!recover&&a.recoverOnly||a.review.bodyDigest!==invitationFactHash(input)||a.review.sourceDigest!==invitationFactHash(input.source))throw forbidden('Original invitation fact admission differs');
 await resource(c,actor,a.review,recover);await authorizeFinanceMaintenance(c,actor);return a.review;
}
/** Internal maintenance assembly only. This opaque token cannot be supplied through request JSON. */
export async function bindReviewedLegacyInvitationFacts(c:PoolClient,actor:Actor,review:LegacyInvitationFactsReview,mode:'execute'|'recover'='execute'):Promise<LegacyInvitationFactsAdmission>{
 reviewShape(review);if(!['execute','recover'].includes(mode))throw invalid('Original invitation admission mode required');await resource(c,actor,review,mode==='recover');await authorizeFinanceMaintenance(c,actor);
 const value=Object.freeze({kind:'REVIEWED_LEGACY_INVITATION_FACTS' as const});admissions.set(value,{review:JSON.parse(canonicalize(review)),recoverOnly:mode==='recover'});return value;
}
const digestFingerprint=(operation:string,bodyDigest:string)=>fingerprintRequest(operation,undefined,{bodyDigest});
const fingerprint=(operation:string,input:LegacyInvitationFactsInput)=>digestFingerprint(operation,invitationFactHash(input));
function expectedReceipt(input:LegacyInvitationFactsInput){const p=prepareLegacyInvitationFacts(input,invitationFactHash(input));return{bodyDigest:p.bodyDigest,sourceDigest:invitationFactHash(input.source),policyVersionId:input.policy?.versionId??null,participants:p.subjects.length,codes:p.subjects.length,relations:p.relations.length,financialEffects:false,
 subjectProofs:p.subjects.map(s=>({userId:s.userId,sourceDigest:s.sourceDigest}))};}
async function requireImportReceipt(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput){
 const p=prepareLegacyInvitationFacts(input,invitationFactHash(input)),row=(await c.query('/* invitation-facts original receipt */ SELECT request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2',[JSON.stringify(['admin',actor.userId,legacyInvitationFactsOperation,null]),p.key])).rows[0];
 if(!row||row.request_fingerprint!==fingerprint(legacyInvitationFactsOperation,input)||row.response_status!==200||canonicalize(row.response_body)!==canonicalize(expectedReceipt(input)))throw conflict('Original successful invitation import receipt required');
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
 const codes=(await c.query('/* invitation-facts codes */ SELECT id,user_id,display_code,match_code,source_type,source_system,source_entity,source_id,source_digest FROM zzsh_order.distribution_invite_code WHERE user_id=ANY($1::text[])',[ids])).rows;
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
async function anchors(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput){
 if(!input.anchors.length)return;
 const keys=[...new Set(input.anchors.map(a=>a.batchKey))],rows=(await c.query('/* invitation-facts parent receipts */ SELECT key,request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])',[JSON.stringify(['admin',actor.userId,legacyInvitationFactsOperation,null]),keys])).rows;
 const receipts=new Map(rows.map(r=>[r.key,{...r,proofs:new Map((Array.isArray(r.response_body?.subjectProofs)?r.response_body.subjectProofs:[]).map((p:any)=>[p.userId,p.sourceDigest]))}]));
 for(const a of input.anchors){const r=receipts.get(a.batchKey),body=r?.response_body;if(!r||r.request_fingerprint!==digestFingerprint(legacyInvitationFactsOperation,a.batchDigest)||r.response_status!==200||body?.bodyDigest!==a.batchDigest||body?.sourceDigest!==invitationFactHash(input.source)||body.policyVersionId!==(input.policy?.versionId??null)||r.proofs.get(a.fact.userId)!==invitationFactSourceDigest(input.source,a.fact))throw conflict('Original imported parent receipt differs');}
 await immutableRows(c,input,input.anchors.map(a=>a.fact));
}
async function currentPolicy(c:PoolClient,input:LegacyInvitationFactsInput,lock=false){
 if(input.policy===null)return;const p=input.policy,row=(await c.query('/* invitation-facts existing policy */ SELECT v.scope,v.schema_version,v.canonical_config,v.config_digest,h.current_version_id FROM zzsh_order.distribution_policy_version v JOIN zzsh_order.distribution_policy_head h ON h.scope=v.scope WHERE v.id=$1'+(lock?' FOR SHARE OF v,h':''),[p.versionId])).rows[0];
 if(!row||row.scope!==p.scope||row.schema_version!=='distribution-policy.v2'||row.current_version_id!==p.versionId||row.config_digest!==p.configDigest||row.canonical_config!==canonicalize(p.config))throw conflict('Exact published uniform policy head is not available');
}
async function lockActor(c:PoolClient,actor:Actor){await c.query('SELECT s.id FROM zzsh_auth_admin.session s JOIN zzsh_auth_admin."user" u ON u.id=s."userId" JOIN zzsh_iam.admin_security a ON a.admin_user_id=u.id WHERE s.id=$1 AND u.id=$2 FOR SHARE OF s,u,a',[actor.sessionId,actor.userId]);}
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
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:factAction,objectType:'legacy_invitation_batch',objectId:p.bodyDigest,outcome:'SUCCESS',reason:'Reviewed original invitation facts; no financial replay',details:{bodyDigest:p.bodyDigest,source:input.source,facts:input.subjects,financialEffects:false}});
  await admitted(c,actor,input,scope,'IMPORT');await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:expectedReceipt(input)};
 });
 if(canonicalize(result.body)!==canonicalize(expectedReceipt(input)))throw conflict('Original invitation receipt differs');await identityProofs(c,input,false);await immutableRows(c,input,input.subjects,true);await admitted(c,actor,input,scope,'IMPORT');return result;
}

async function countsProof(c:PoolClient,input:LegacyInvitationFactsInput){
 const ids=input.subjects.map(s=>s.userId),rows=(await c.query("/* invitation-facts all original children */ SELECT id,type,parent_user_id,source_digest FROM zzsh_order.invitation_relation WHERE parent_user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL' ORDER BY id COLLATE \"C\"",[ids])).rows;
 const byParent=new Map<string,Record<string,Array<[string,string]>>>();for(const r of rows){if(!invitationFactTypes.includes(r.type))throw conflict('Original relation type differs');const p=byParent.get(r.parent_user_id)??{};(p[r.type]??=[]).push([r.id,r.source_digest]);byParent.set(r.parent_user_id,p);}
 return input.subjects.map(s=>{for(const t of invitationFactTypes){const actual=byParent.get(s.userId)?.[t]??[],proof=s.children[t];if(actual.length!==proof.knownCount||invitationFactHash(actual)!==proof.setDigest)throw conflict('Original child relation set is not completely imported');}
  return{userId:s.userId,knowledge:invitationFactTypes.every(t=>s.children[t].sourceCount===s.children[t].knownCount)?'KNOWN':'UNKNOWN',sourceDigest:invitationFactSourceDigest(input.source,s)};});
}
export async function closeReviewedLegacyInvitationCounts(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,reviewedDigest:string,scope:LegacyInvitationFactsAdmission){
 const p=prepareLegacyInvitationFacts(input,reviewedDigest);await admitted(c,actor,input,scope,'COUNTS');await lockActor(c,actor);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 await requireImportReceipt(c,actor,input);
 const result=await withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:legacyInvitationCountsOperation},p.key,fingerprint(legacyInvitationCountsOperation,input),()=>admitted(c,actor,input,scope,'COUNTS').then(()=>undefined),async()=>{
  await identityProofs(c,input,true);await immutableRows(c,input,input.subjects,true);const counts=await countsProof(c,input);
  const revisions=(await c.query('/* invitation-facts count CAS */ SELECT user_id,revision::text,invitees_knowledge FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR UPDATE',[counts.map(s=>s.userId)])).rows,map=new Map(revisions.map(r=>[r.user_id,r]));
  const updates=counts.filter(s=>map.get(s.userId)?.invitees_knowledge!==s.knowledge).map(s=>({user_id:s.userId,knowledge:s.knowledge,source_digest:s.sourceDigest,revision:map.get(s.userId)?.revision}));
  if(updates.length){const changed=await c.query(`UPDATE zzsh_order.distribution_participant p SET invitees_knowledge=x.knowledge,revision=p.revision+1 FROM jsonb_to_recordset($1::jsonb) x(user_id text,knowledge text,source_digest text,revision bigint)
   WHERE p.user_id=x.user_id AND p.source_type='LEGACY_MYSQL' AND p.source_digest=x.source_digest AND p.revision=x.revision`,[JSON.stringify(updates)]);if(changed.rowCount!==updates.length)throw conflict('Invitation count revision changed');}
  const body={bodyDigest:p.bodyDigest,sourceDigest:invitationFactHash(input.source),subjects:counts.length,known:counts.filter(s=>s.knowledge==='KNOWN').length,unknown:counts.filter(s=>s.knowledge==='UNKNOWN').length,financialEffects:false};
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:countAction,objectType:'legacy_invitation_batch',objectId:p.bodyDigest,outcome:'SUCCESS',reason:'Exact original child set reconciled',details:body});await admitted(c,actor,input,scope,'COUNTS');await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body};
 });
 const recovered=await recoverReviewedLegacyInvitationFacts(c,actor,input,reviewedDigest,scope,'COUNTS');if(recovered.knowledge!=='KNOWN')throw conflict('Original invitation count receipt unavailable');await admitted(c,actor,input,scope,'COUNTS');return result;
}
/** Absence is UNKNOWN; this never writes a replacement key or repairs an uncertain commit. */
export async function recoverReviewedLegacyInvitationFacts(c:PoolClient,actor:Actor,input:LegacyInvitationFactsInput,reviewedDigest:string,scope:LegacyInvitationFactsAdmission,phase:'IMPORT'|'COUNTS'='IMPORT'){
 const p=prepareLegacyInvitationFacts(input,reviewedDigest);await admitted(c,actor,input,scope,phase,true);const operation=phase==='IMPORT'?legacyInvitationFactsOperation:legacyInvitationCountsOperation;
 const row=(await c.query('/* invitation-facts original receipt */ SELECT request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2',[JSON.stringify(['admin',actor.userId,operation,null]),p.key])).rows[0];if(!row)return{knowledge:'UNKNOWN' as const,receipt:null};
 if(phase==='COUNTS')await requireImportReceipt(c,actor,input);
 if(row.request_fingerprint!==fingerprint(operation,input)||row.response_status!==200)throw conflict('Original invitation receipt key/body differs');await identityProofs(c,input,false);await immutableRows(c,input,input.subjects,true);
 if(phase==='IMPORT'){if(canonicalize(row.response_body)!==canonicalize(expectedReceipt(input)))throw conflict('Original invitation import receipt differs');}
 else{const counts=await countsProof(c,input),expected={bodyDigest:p.bodyDigest,sourceDigest:invitationFactHash(input.source),subjects:counts.length,known:counts.filter(s=>s.knowledge==='KNOWN').length,unknown:counts.filter(s=>s.knowledge==='UNKNOWN').length,financialEffects:false};
  if(canonicalize(row.response_body)!==canonicalize(expected))throw conflict('Original invitation count receipt differs');
  const current=(await c.query('SELECT user_id,invitees_knowledge FROM zzsh_order.distribution_participant WHERE user_id=ANY($1::text[])',[counts.map(s=>s.userId)])).rows,m=new Map(current.map(r=>[r.user_id,r.invitees_knowledge]));if(counts.some(s=>m.get(s.userId)!==s.knowledge))throw conflict('Current original invitation count coverage differs');
 }await admitted(c,actor,input,scope,phase,true);return{knowledge:'KNOWN' as const,receipt:{status:row.response_status,body:row.response_body}};
}
