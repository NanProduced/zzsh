import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {assertAdminContextInTransaction} from '../auth/auth-security';
import {assertAdminCommandAuthorizedInTransaction} from '../auth/admin-auth-session';
import {ADMIN_PERMISSION,hasPermission,loadEffectiveAdminAccess,requirePermission} from '../auth/admin-authorization';
import {recordAudit,SecurityApiError,withTransaction} from '../auth/security-core';
import {canonicalize} from '../supply/content-hash';
import {conflict,ensureOnlyFields,fingerprintRequest,invalid,notFound,withIdempotency} from '../supply/supply-util';
import {distributionPolicyScopeOf,readDistributionPolicyRowInTransaction,readInvitationPolicyInTransaction,type LocalDistributionScope} from './distribution-policy-store';
import {assertDistributionManagementResource,type DistributionManagementResource} from './distribution-management-resource';
import {applyLevelCommand,managedDistributionPolicy,parseLevelCommand} from './distribution-level-management';
import {readCurrentInviteCodes} from './distribution-invite-code';

type Actor={userId:string;sessionId:string;requestId:string};
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const reason=(value:unknown)=>{if(typeof value!=='string'||value.trim().length<3||value.length>500)throw invalid('Reason must contain 3 to 500 characters');return value.trim();};
const revision=(value:unknown)=>{if(typeof value!=='string'||!/^[1-9]\d{0,18}$/.test(value))throw invalid('Expected revision required');return value;};
const subject=(value:string)=>{if(!idPattern.test(value))throw invalid('Invalid participant');return value;};

async function authorize(c:PoolClient,actor:Actor,permission:string,write=false){
 if(write)await assertAdminCommandAuthorizedInTransaction(c,actor);else await assertAdminContextInTransaction(c,actor);
 const access=await loadEffectiveAdminAccess(c,actor.userId);requirePermission(access,permission);
 if(access?.passwordChangeRequired)throw new SecurityApiError(403,'FORBIDDEN','Password change required');
 return access;
}
async function authorizePolicyRead(c:PoolClient,actor:Actor){
 await assertAdminContextInTransaction(c,actor);const access=await loadEffectiveAdminAccess(c,actor.userId);
 if(!hasPermission(access,ADMIN_PERMISSION.distributionLevelManage)&&!hasPermission(access,ADMIN_PERMISSION.distributionParticipantRead))requirePermission(access,ADMIN_PERMISSION.distributionLevelManage);
 if(access?.passwordChangeRequired)throw new SecurityApiError(403,'FORBIDDEN','Password change required');
 return access;
}
function accessKey(access:NonNullable<Awaited<ReturnType<typeof loadEffectiveAdminAccess>>>,actor:Actor){
 return sha(canonicalize([actor.userId,actor.sessionId,access.status,access.isBoss,access.passwordChangeRequired,[...access.permissions].sort()]));
}
async function recheckRead(pool:Pool,actor:Actor,key:string,kind:'policy'|'participants'){
 await withTransaction(pool,async c=>{await c.query('SET TRANSACTION READ ONLY');
  const access=kind==='policy'?await authorizePolicyRead(c,actor):await authorize(c,actor,ADMIN_PERMISSION.distributionParticipantRead);
  if(!access||accessKey(access,actor)!==key)throw new SecurityApiError(403,'FORBIDDEN','Distribution access changed; reload');
 });
}
async function lockGraphAndPolicy(c:PoolClient,scope:string){
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:'||$1,0))",[scope]);
}
async function lockedPolicy(c:PoolClient,expectedPolicyId:string,expectedRevision:string){
 const scope='NATIVE';await lockGraphAndPolicy(c,scope);
 const head=(await c.query('SELECT current_version_id,revision::text FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[scope])).rows[0];
 if(!head||head.current_version_id!==expectedPolicyId||head.revision!==expectedRevision)throw conflict('Distribution policy changed; reload');
 const current=await readDistributionPolicyRowInTransaction(c,false,scope);
 if(current.knowledge!=='KNOWN'||current.policy.versionId!==head.current_version_id)throw conflict('Distribution policy unavailable');
 return current.policy;
}

async function currentPolicy(c:PoolClient,binding?:LocalDistributionScope,resource?:DistributionManagementResource){
 if(resource){const writeAssemblyReady=await assertDistributionManagementResource(c,resource);return{...await readDistributionPolicyRowInTransaction(c,false,'NATIVE'),writeAssemblyReady};}
 return{...await readInvitationPolicyInTransaction(c,binding),writeAssemblyReady:false};
}
export async function readManagementPolicy(pool:Pool,actor:Actor,binding?:LocalDistributionScope,resource?:DistributionManagementResource){
 const result=await withTransaction(pool,async c=>{
 await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const access=await authorizePolicyRead(c,actor);
 if(!access)throw new SecurityApiError(403,'FORBIDDEN','Active administrator required');
 const result=await currentPolicy(c,binding,resource),scope=resource?'NATIVE':distributionPolicyScopeOf(binding);
 const body=result.knowledge==='KNOWN'?{knowledge:'KNOWN' as const,policy:{...result.policy,managed:managedDistributionPolicy(result.policy.config)},scope,writeAssemblyReady:result.writeAssemblyReady}:
  {knowledge:'UNKNOWN' as const,policy:null,reason:result.reason,scope,writeAssemblyReady:result.writeAssemblyReady};
 return{body,key:accessKey(access,actor)};
 });await recheckRead(pool,actor,result.key,'policy');return result.body;
}

/** Deliberately excludes finance, order, referral-network and sensitive identity data. */
export async function readManagementParticipants(pool:Pool,actor:Actor,query:{q:string;page:number},binding?:LocalDistributionScope,resource?:DistributionManagementResource){const result=await withTransaction(pool,async c=>{
 await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const access=await authorize(c,actor,ADMIN_PERMISSION.distributionParticipantRead);
 if(!access)throw new SecurityApiError(403,'FORBIDDEN','Active administrator required');
 const hasName=hasPermission(access,ADMIN_PERMISSION.userDirectoryRead),q=query.q.trim();
 if(q.length>100||!Number.isInteger(query.page)||query.page<1||query.page>10000)throw invalid('Invalid participant search');
 const readiness=(await c.query("SELECT to_regprocedure('zzsh_order.distribution_management_contract_version()') IS NOT NULL AS ready,has_column_privilege(current_user,'zzsh_order.distribution_participant','commission_frozen','UPDATE') AS freeze_ready")).rows[0];
 const marker=readiness?.ready===true;
 const filter=q.replace(/[\\%_]/g,'\\$&');
 const rows=(await c.query(`SELECT p.user_id,p.eligibility,p.commission_frozen,p.level_code,p.revision::text,
   ${hasName?'u.name':'NULL::text AS name'},codes.display_code,codes.id AS code_id,count(*) OVER()::int AS total
  FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id
  LEFT JOIN LATERAL(SELECT CASE WHEN count(*)=1 THEN min(id) END AS id,CASE WHEN count(*)=1 THEN min(display_code) END AS display_code
   FROM zzsh_order.distribution_invite_code WHERE user_id=p.user_id${marker?' AND active':''}) codes ON true
  WHERE ($1='' OR p.user_id ILIKE $2 ESCAPE '\\' ${hasName?"OR u.name ILIKE $2 ESCAPE '\\'":''})
  ORDER BY p.user_id COLLATE "C" LIMIT 20 OFFSET $3`,[q,`%${filter}%`,(query.page-1)*20])).rows;
 const policy=await currentPolicy(c,binding,resource);
 const managed=policy.knowledge==='KNOWN'?managedDistributionPolicy(policy.policy.config):null;
 const body={items:rows.map(r=>({userId:r.user_id,name:r.name??null,eligibility:r.eligibility,frozen:r.commission_frozen,revision:r.revision,
  levelCode:r.level_code,levelName:r.level_code?managed?.levelNames[r.level_code]??null:null,inviteCode:r.display_code??null,inviteCodeId:r.code_id??null})),
  total:rows.length?String(rows[0].total):null,page:query.page,hasMore:rows.length===20,writeAssemblyReady:policy.writeAssemblyReady,
  freezeWriteReady:policy.writeAssemblyReady&&marker&&readiness?.freeze_ready===true&&hasPermission(access,ADMIN_PERMISSION.distributionParticipantManage),
  policy:policy.knowledge==='KNOWN'?{versionId:policy.policy.versionId,revision:policy.policy.revision,schema:policy.policy.config.schema,levels:managed!.levels.map(l=>({code:l.code,name:managed!.levelNames[l.code]}))}:null};
 return{body,key:accessKey(access,actor)};
 });await recheckRead(pool,actor,result.key,'participants');return result.body;
}

export async function changeDistributionLevelPolicy(pool:Pool,actor:Actor,body:Record<string,unknown>,key:string,resource?:DistributionManagementResource){
 ensureOnlyFields(body,['expectedPolicyId','expectedRevision','command','reason']);
 if(typeof body.expectedPolicyId!=='string'||!idPattern.test(body.expectedPolicyId)||!body.command||typeof body.command!=='object'||Array.isArray(body.command))throw invalid('Exact policy and command required');
 const expectedRevision=revision(body.expectedRevision),why=reason(body.reason),command=parseLevelCommand(body.command as Record<string,unknown>),expectedPolicyId=body.expectedPolicyId;
 return withTransaction(pool,async c=>{
  await authorize(c,actor,ADMIN_PERMISSION.distributionLevelManage,true);await assertDistributionManagementResource(c,resource,'WRITE');
  return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.level.change'},key,fingerprintRequest('distribution.level.change',undefined,body),
   ()=>authorize(c,actor,ADMIN_PERMISSION.distributionLevelManage,true).then(()=>{}),async()=>{
    const previous=await lockedPolicy(c,expectedPolicyId,expectedRevision),scope='NATIVE';
    const plan=applyLevelCommand(previous.config,command),canonical=canonicalize(plan.config),digest=sha(canonical),next=(BigInt(expectedRevision)+1n).toString();
    const policyId='distribution_policy_'+sha(canonicalize([scope,next,digest])).slice(0,40);
    await c.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id)
      VALUES($1,$2,$3,'distribution-policy.v4',$4,$5,$6)`,[policyId,next,scope,canonical,digest,actor.userId]);
    const changed=await c.query('UPDATE zzsh_order.distribution_policy_head SET revision=$2,current_version_id=$3 WHERE scope=$1 AND revision=$4 AND current_version_id=$5',[scope,next,policyId,expectedRevision,expectedPolicyId]);
    if(changed.rowCount!==1)throw conflict('Distribution policy changed');
    const reassigned=await c.query(`UPDATE zzsh_order.distribution_participant p SET level_code=$1,policy_version_id=$2,revision=p.revision+1
     FROM zzsh_order.distribution_policy_version original WHERE original.id=p.policy_version_id AND original.scope=$3
      AND ((p.level_code IS NULL AND original.schema_version='distribution-policy.v2') OR ($4::text IS NOT NULL AND p.level_code=$4))`,[plan.defaultCode,policyId,scope,plan.removedCode]);
    await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.level.changed',objectType:'distribution_policy_version',objectId:policyId,outcome:'SUCCESS',reason:why,
     details:{beforePolicyId:expectedPolicyId,beforeRevision:expectedRevision,revision:next,digest,action:command.action,removedCode:plan.removedCode,reassigned:reassigned.rowCount,scope}});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:{versionId:policyId,revision:next,config:plan.config,reassigned:reassigned.rowCount}};
   });
 });
}

export async function changeParticipantLevel(pool:Pool,actor:Actor,userId:string,body:Record<string,unknown>,key:string,resource?:DistributionManagementResource){
 subject(userId);ensureOnlyFields(body,['expectedPolicyId','expectedPolicyRevision','expectedParticipantRevision','levelCode','reason']);
 if(typeof body.expectedPolicyId!=='string'||!idPattern.test(body.expectedPolicyId)||typeof body.levelCode!=='string')throw invalid('Exact policy and level required');
 const policyId=body.expectedPolicyId,policyRevision=revision(body.expectedPolicyRevision),participantRevision=revision(body.expectedParticipantRevision),levelCode=body.levelCode,why=reason(body.reason);
 return withTransaction(pool,async c=>{
  await authorize(c,actor,ADMIN_PERMISSION.distributionParticipantManage,true);await assertDistributionManagementResource(c,resource,'WRITE');
  return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.participant.level',resourceId:userId},key,fingerprintRequest('distribution.participant.level',userId,body),
   ()=>authorize(c,actor,ADMIN_PERMISSION.distributionParticipantManage,true).then(()=>{}),async()=>{
    const previous=await lockedPolicy(c,policyId,policyRevision);
    if(previous.config.schema==='distribution-policy.v2'||!previous.config.levels.some(l=>l.code===levelCode))throw conflict('Selected level is not available in the current policy');
    const p=(await c.query(`SELECT p.level_code,p.policy_version_id,p.revision::text,v.scope FROM zzsh_order.distribution_participant p
      LEFT JOIN zzsh_order.distribution_policy_version v ON v.id=p.policy_version_id WHERE p.user_id=$1 FOR UPDATE OF p`,[userId])).rows[0];
    if(!p)throw notFound();if(p.revision!==participantRevision||p.scope!=='NATIVE')throw conflict('Participant changed or original policy scope is unknown');
    const updated=await c.query('UPDATE zzsh_order.distribution_participant SET level_code=$2,policy_version_id=$3,revision=revision+1 WHERE user_id=$1 AND revision=$4',[userId,levelCode,policyId,participantRevision]);
    if(updated.rowCount!==1)throw conflict('Participant changed');
    await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.participant.level_changed',objectType:'distribution_participant',objectId:userId,outcome:'SUCCESS',reason:why,
     details:{beforeLevel:p.level_code,levelCode,previousPolicyId:p.policy_version_id,policyId,previousRevision:participantRevision}});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:{userId,levelCode,revision:(BigInt(participantRevision)+1n).toString()}};
   });
 });
}

/** The flag changes future payment eligibility only; frozen order bases and existing earnings are untouched. */
export async function setParticipantCommissionFrozen(pool:Pool,actor:Actor,userId:string,body:Record<string,unknown>,key:string,resource?:DistributionManagementResource){
 subject(userId);ensureOnlyFields(body,['expectedParticipantRevision','frozen','reason']);
 const expectedRevision=revision(body.expectedParticipantRevision),why=reason(body.reason);
 if(typeof body.frozen!=='boolean')throw invalid('Explicit frozen state required');const frozen=body.frozen;
 return withTransaction(pool,async c=>{
  await authorize(c,actor,ADMIN_PERMISSION.distributionParticipantManage,true);await assertDistributionManagementResource(c,resource,'WRITE');
  return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.participant.freeze',resourceId:userId},key,fingerprintRequest('distribution.participant.freeze',userId,body),
   ()=>authorize(c,actor,ADMIN_PERMISSION.distributionParticipantManage,true).then(()=>{}),async()=>{
    const available=(await c.query("SELECT has_column_privilege(current_user,'zzsh_order.distribution_participant','commission_frozen','UPDATE') AS allowed")).rows[0]?.allowed;
    if(available!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution freeze runtime grant unavailable');
    // Payment freezes beneficiary facts under this same graph lock before taking participant locks.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
    const participant=(await c.query('SELECT commission_frozen,revision::text FROM zzsh_order.distribution_participant WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
    if(!participant)throw notFound();if(participant.revision!==expectedRevision)throw conflict('Participant changed; reload');
    if(typeof participant.commission_frozen!=='boolean')throw conflict('Original freeze state is unknown; verify before changing');
    const changed=participant.commission_frozen!==frozen;
    if(changed){const result=await c.query('UPDATE zzsh_order.distribution_participant SET commission_frozen=$2,revision=revision+1 WHERE user_id=$1 AND revision=$3',[userId,frozen,expectedRevision]);
     if(result.rowCount!==1)throw conflict('Participant changed; reload');}
    const next=changed?(BigInt(expectedRevision)+1n).toString():expectedRevision;
    await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.participant.freeze_changed',objectType:'distribution_participant',objectId:userId,outcome:'SUCCESS',reason:why,
     details:{beforeFrozen:participant.commission_frozen,frozen,changed,beforeRevision:expectedRevision,revision:next}});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:{userId,frozen,revision:next,changed}};
   });
 });
}

export async function rotateParticipantInviteCode(pool:Pool,actor:Actor,userId:string,body:Record<string,unknown>,key:string,resource?:DistributionManagementResource){
 subject(userId);ensureOnlyFields(body,['expectedCodeId','code','reason']);
 if(typeof body.expectedCodeId!=='string'||!idPattern.test(body.expectedCodeId)||typeof body.code!=='string'||!/^[A-Za-z0-9_-]{1,30}$/.test(body.code))throw invalid('Current and replacement invite codes required');
 const expectedCodeId=body.expectedCodeId,code=body.code,why=reason(body.reason);
 return withTransaction(pool,async c=>{
  await authorize(c,actor,ADMIN_PERMISSION.distributionParticipantManage,true);await assertDistributionManagementResource(c,resource,'WRITE');
  return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.participant.invite_code',resourceId:userId},key,fingerprintRequest('distribution.participant.invite_code',userId,body),
   ()=>authorize(c,actor,ADMIN_PERMISSION.distributionParticipantManage,true).then(()=>{}),async()=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
    const p=(await c.query('SELECT user_id FROM zzsh_order.distribution_participant WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];if(!p)throw notFound();
    const codes=await readCurrentInviteCodes(c,userId);if(codes.length!==1||codes[0].id!==expectedCodeId)throw conflict('Current invitation code changed or is ambiguous');
    if((await c.query('SELECT 1 FROM zzsh_order.distribution_invite_code WHERE match_code=$1',[code.toUpperCase()])).rowCount)throw conflict('Invitation code has already been used');
    const changed=await c.query('UPDATE zzsh_order.distribution_invite_code SET active=false WHERE id=$1 AND user_id=$2 AND active',[expectedCodeId,userId]);
    if(changed.rowCount!==1)throw conflict('Invitation code changed');
    const sourceId=randomUUID(),id='invite_code_'+sha(sourceId).slice(0,40),sourceDigest=sha(canonicalize({userId,previousCodeId:expectedCodeId,code,sourceId}));
    await c.query(`INSERT INTO zzsh_order.distribution_invite_code(id,user_id,display_code,source_type,source_system,source_entity,source_id,source_digest)
      VALUES($1,$2,$3,'ADMIN_MANAGED','zzsh','admin_invite_code',$4,$5)`,[id,userId,code,sourceId,sourceDigest]);
    await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.invite_code.changed',objectType:'distribution_participant',objectId:userId,outcome:'SUCCESS',reason:why,
     details:{previousCodeId:expectedCodeId,codeId:id,sourceDigest}});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:{userId,code,codeId:id}};
   });
 });
}
