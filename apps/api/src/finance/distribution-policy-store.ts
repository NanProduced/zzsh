import type {Pool,PoolClient} from 'pg';import {createHash} from 'node:crypto';
import {withTransaction,recordAudit,SecurityApiError} from '../auth/security-core';import {assertAdminContextInTransaction} from '../auth/auth-security';import {loadEffectiveAdminAccess,hasPermission,requirePermission} from '../auth/admin-authorization';
import {canonicalize} from '../supply/content-hash';import {ensureOnlyFields,invalid,conflict,forbidden,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {validateDistributionPolicy,type DistributionPolicyConfig} from './distribution-policy';
import {prepareDistributionPolicyChange,type DistributionPolicyChange} from './distribution-policy-change';
import {ConfigurationError,type AppConfig} from '../config/config';
export type LocalDistributionScope=Readonly<{kind:'LOCAL_CONTROLLED_DISTRIBUTION'}>;
type CreationReceipt={database:string;resourceOid:number;owner:string;marker:string;migrationRole:string;runtimeRole:string;ownerOid?:number;migrationRoleOid?:number;runtimeRoleOid?:number};
const localName='zzsh_test_order_credit_admin_batch2',localRuntime='zzsh_order_credit_admin_batch2_r',localMigration='zzsh_order_credit_admin_batch2_m',localMarker='zzsh:order-reservation-test:v1';
const milestoneName='zzsh_test_order_milestone_real_1',milestoneRuntime='zzsh_order_milestone_real_1_r',milestoneMigration='zzsh_order_milestone_real_1_m';
const localProofs=new WeakMap<LocalDistributionScope,Readonly<CreationReceipt&{readOnly:boolean}>>();
/** Explicit server assembly from the resource creation receipt; never HTTP or environment input. */
export function createLocalDistributionScope(config:AppConfig,receipt:CreationReceipt):LocalDistributionScope{
 return createScope(config,receipt,false);
}
/** Exact milestone GET capability; it cannot admit registration, policy or relation writes. */
export function createLocalDistributionReadScope(config:AppConfig,receipt:CreationReceipt):LocalDistributionScope{
 return createScope(config,receipt,true);
}
function createScope(config:AppConfig,receipt:CreationReceipt,readOnly:boolean):LocalDistributionScope{
 const milestone=receipt.database===milestoneName,name=milestone?milestoneName:localName,runtime=milestone?milestoneRuntime:localRuntime,migration=milestone?milestoneMigration:localMigration;
 if(config.profile!=='test'||config.provider!=='fake'||!readOnly&&!config.testOperationsEnabled||readOnly&&!milestone
  ||config.database.target!=='local-compose'||config.database.host!=='127.0.0.1'||config.database.port!==55432
  ||config.database.name!==name||config.database.user!==runtime
  ||receipt.database!==name||receipt.runtimeRole!==runtime||receipt.migrationRole!==migration
  ||receipt.owner!=='zzsh'||receipt.marker!==localMarker||!Number.isSafeInteger(receipt.resourceOid)||receipt.resourceOid<=0||receipt.resourceOid>4294967295
  ||milestone&&(receipt.resourceOid!==952624||receipt.ownerOid!==10||receipt.migrationRoleOid!==952625||receipt.runtimeRoleOid!==952626)
  ||[793252,878001,893390,881699,820148,833000,869754].includes(receipt.resourceOid))throw new ConfigurationError('Exact local test/fake distribution creation receipt required');
 const value=Object.freeze({kind:'LOCAL_CONTROLLED_DISTRIBUTION' as const});localProofs.set(value,Object.freeze({...receipt,readOnly}));return value;
}
export function assertLocalDistributionAssembly(binding:LocalDistributionScope|undefined,options:{testOperationsEnabled:boolean;secureCookies:boolean;apiOrigin:string;userOrigin:string;adminOrigin:string}){
 if(binding===undefined)return;
 const receipt=localProofs.get(binding),port=receipt?.database===milestoneName?4220:4280;
 if(!localProofs.has(binding)||!receipt?.readOnly&&!options.testOperationsEnabled||options.secureCookies||process.env.NODE_ENV==='production'
  ||options.apiOrigin!==`http://127.0.0.1:${port+2}`||options.userOrigin!==`http://127.0.0.1:${port}`||options.adminOrigin!==`http://127.0.0.1:${port+1}`)throw new ConfigurationError('Local distribution scope requires its explicit test API assembly');
}
export const DISTRIBUTION_POLICY_PERMISSION={read:'personal.distribution.policy.read',manage:'personal.distribution.policy.manage'} as const;
type Actor={userId:string;sessionId:string;requestId:string};const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),scope='LOCAL_CONTROLLED';
async function authorize(c:PoolClient,actor:Actor,write=false){await assertAdminContextInTransaction(c,actor);const user=(await c.query('SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1',[actor.userId])).rows[0];if(!user||user.suspended)throw forbidden('Policy operator unavailable');const access=await loadEffectiveAdminAccess(c,actor.userId);if(write)requirePermission(access,DISTRIBUTION_POLICY_PERMISSION.manage);else if(!hasPermission(access,DISTRIBUTION_POLICY_PERMISSION.read)&&!hasPermission(access,DISTRIBUTION_POLICY_PERMISSION.manage))throw forbidden('Policy read permission required');return access;}
async function resource(c:PoolClient, allowUnadmitted=false,binding?:LocalDistributionScope,maintenanceOwner=false,readOnly=false){const r=(await c.query("SELECT d.oid,current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker,to_regclass('zzsh_order.distribution_policy_version') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AS complete FROM pg_database d WHERE d.datname=current_database()")).rows[0];
 if(binding!==undefined){
  const proof=localProofs.get(binding);
  const roles=maintenanceOwner&&proof?.database===milestoneName?[proof.owner]:proof?proof.readOnly?[proof.runtimeRole]:[proof.runtimeRole,proof.migrationRole]:[];
  if(!proof||proof.readOnly&&!readOnly||!r||maintenanceOwner&&proof.database!==milestoneName||r.name!==proof.database||Number(r.oid)!==proof.resourceOid||r.marker!==proof.marker||!roles.includes(r.role)||r.complete!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution resource differs');
  const shape=(await c.query(`SELECT pg_get_userbyid(d.datdba) AS owner,d.datdba::int AS "ownerOid",r.oid::int AS "roleOid",r.rolsuper,r.rolbypassrls,
   to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.distribution_invite_code') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AS complete
   FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  const expectedRole=maintenanceOwner?proof.ownerOid:r.role===proof.runtimeRole?proof.runtimeRoleOid:proof.migrationRoleOid;
  if(!shape||shape.owner!==proof.owner||!maintenanceOwner&&(shape.rolsuper!==false||shape.rolbypassrls!==false)||shape.complete!==true
   ||proof.database===milestoneName&&(shape.ownerOid!==proof.ownerOid||shape.roleOid!==expectedRole))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution schema or role unavailable');
  return true;
 }
 const resources=[['zzsh_test_m2_auth_auth_compat',820148,'zzsh_m2_auth_compat_','zzsh:m2-auth-test:v1'],['zzsh_test_m2_auth_auth_compat_ui',833000,'zzsh_m2_auth_compat_ui_','zzsh:m2-auth-test:v1'],['zzsh_test_order_personal_finance',869754,'zzsh_order_personal_finance_','zzsh:order-reservation-test:v1']] as const;
 const expected=resources.find(([name,oid])=>r?.name===name&&Number(r.oid)===oid);if(!expected&&allowUnadmitted)return false;if(!expected||r.marker!==expected[3]||![expected[2]+'r',expected[2]+'m'].includes(r.role)||!r.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution policy resource or schema unavailable');return true;}
/** Internal historical migration only: the exact receipt admits owner10, never the runtime role or an arbitrary local database. */
export async function assertReviewedDistributionMaintenanceResource(c:PoolClient,binding:LocalDistributionScope){return resource(c,false,binding,true);}

function decode(row:Record<string,any>,expectedScope:'LOCAL_CONTROLLED'|'NATIVE'='LOCAL_CONTROLLED'){if(sha(row.canonical_config)!==row.config_digest)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Policy digest differs');let config:DistributionPolicyConfig;try{config=validateDistributionPolicy(JSON.parse(row.canonical_config),expectedScope);if(canonicalize(config)!==row.canonical_config)throw Error();}catch{throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Policy schema is not valid');}return{versionId:row.id,revision:String(row.revision),digest:row.config_digest,config,createdAt:new Date(row.created_at).toISOString()};}
/** Caller has verified its resource. Payment and relation writers may pin the immutable head. */
export async function readDistributionPolicyRowInTransaction(c:PoolClient,lockHead=false,policyScope:'LOCAL_CONTROLLED'|'NATIVE'=scope){if(policyScope!=='LOCAL_CONTROLLED'&&policyScope!=='NATIVE')throw invalid('Unsupported distribution policy scope');const row=(await c.query(`SELECT v.* FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version v ON v.id=h.current_version_id AND v.scope=h.scope AND v.revision=h.revision WHERE h.scope=$1${lockHead?' FOR SHARE OF h':''}`,[policyScope])).rows[0];return row?{knowledge:'KNOWN' as const,policy:decode(row,policyScope)}:{knowledge:'UNKNOWN' as const,policy:null,reason:'POLICY_NOT_CONFIGURED'};}
const read=readDistributionPolicyRowInTransaction;
export async function readDistributionPolicy(pool:Pool,actor:Actor,binding?:LocalDistributionScope,writeBinding?:LocalDistributionScope){return withTransaction(pool,async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const access=await authorize(c,actor);await resource(c,false,binding,false,true);const changeContext=await readDistributionChangeContext(c,actor.userId,access?.isBoss===true||access?.permissions.has('approval.request.read')===true,writeBinding!==undefined&&localProofs.get(writeBinding)?.readOnly===false);return{...await read(c),...(changeContext.contractReady?{semanticsVersion:'distribution-policy.lifecycle.v2' as const}:{}),changeContext};});}
async function readDistributionChangeContext(c:PoolClient,adminId:string,canReadRequests:boolean,writeAssemblyReady:boolean){
 const marker=(await c.query("SELECT to_regclass('zzsh_iam.approval_request') IS NOT NULL AS requests_ready,to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS contract_ready")).rows[0];
 const base={schema:'distribution-policy-change-context.v1' as const,state:'UNAVAILABLE' as 'UNAVAILABLE'|'EMPTY'|'PENDING',request:null as null|{requestId:string;status:string;requestedBy:string;requesterName:string|null;createdAt:string;deciderName:string|null;decidedAt:string|null;expectedPolicyId:string|null;expectedRevision:string|null;expectedPolicyDigest:string|null;changes:unknown},contractReady:false,writeAssemblyReady,reasonCodes:[] as string[]};
 if(!marker?.requests_ready)return{...base,reasonCodes:['APPROVAL_REQUEST_SOURCE_UNAVAILABLE']};
 const contractReady=marker.contract_ready===true&&(await c.query('SELECT zzsh_order.distribution_policy_contract_version() AS version')).rows[0]?.version===2;
 const requests=(await c.query(`SELECT r.id,r.status,r.requested_by,r.operation_payload,u.name AS requester_name,d.name AS decider_name,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at FROM zzsh_iam.approval_request r LEFT JOIN zzsh_auth_admin."user" u ON u.id=r.requested_by LEFT JOIN zzsh_auth_admin."user" d ON d.id=r.decided_by WHERE r.operation_code='distribution.policy.publish' AND r.status IN ('PENDING','APPROVED','EXECUTION_FAILED') AND r.expires_at>clock_timestamp() ORDER BY r.created_at DESC,r.id COLLATE "C" DESC LIMIT 2`)).rows;
 if(requests.length>1)return{...base,contractReady,reasonCodes:['MULTIPLE_ACTIVE_DISTRIBUTION_REQUESTS']};
 if(!requests.length)return{...base,state:'EMPTY' as const,contractReady,reasonCodes:contractReady?[]:['UNIFORM_DISTRIBUTION_CONTRACT_NOT_INSTALLED']};
 const r=requests[0],p=r.operation_payload;const readable=canReadRequests||r.requested_by===adminId;
 return{...base,state:'PENDING' as const,contractReady,request:readable?{requestId:r.id,status:r.status,requestedBy:r.requested_by,requesterName:typeof r.requester_name==='string'?r.requester_name:null,createdAt:r.created_at,deciderName:typeof r.decider_name==='string'?r.decider_name:null,decidedAt:r.decided_at??null,expectedPolicyId:typeof p?.expectedPolicyId==='string'?p.expectedPolicyId:null,expectedRevision:typeof p?.expectedRevision==='string'?p.expectedRevision:null,expectedPolicyDigest:typeof p?.expectedPolicyDigest==='string'?p.expectedPolicyDigest:null,changes:p?.changes??null}:null,reasonCodes:readable?[]:['POLICY_CHANGE_DETAILS_FORBIDDEN']};
}
/** Domain-only current policy read; caller retains its own user/registration authorization. */
export async function readActiveDistributionPolicyInTransaction(c:PoolClient,lockHead=false,binding?:LocalDistributionScope){await resource(c,false,binding);return read(c,lockHead);}
/** Invitation reads do not require write admission; its capability still uses the original gate. */
export async function readInvitationPolicyInTransaction(c:PoolClient,binding?:LocalDistributionScope){
 if(!(await c.query("SELECT to_regclass('zzsh_order.distribution_policy_version') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AS complete")).rows[0]?.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution policy sources are not installed');
 const admitted=await resource(c,true,binding,false,true),writeResourceAdmitted=admitted&&(binding===undefined||localProofs.get(binding)?.readOnly!==true);return{...await readDistributionPolicyRowInTransaction(c),writeResourceAdmitted};
}
/** Registration remains available before distribution admission; policy reads/writes elsewhere stay strict. */
export async function readRegistrationDistributionPolicyInTransaction(c:PoolClient,binding?:LocalDistributionScope){
 if(!await resource(c,true,binding))return{knowledge:'UNKNOWN' as const,policy:null,reason:'DISTRIBUTION_RESOURCE_NOT_ADMITTED'};
 return read(c,true);
}
export async function configureDistributionPolicy(pool:Pool,actor:Actor,body:Record<string,unknown>,key:string,binding?:LocalDistributionScope){ensureOnlyFields(body,['expectedRevision','config','reason']);if(typeof body.expectedRevision!=='string'||!/^(0|[1-9]\d{0,18})$/.test(body.expectedRevision)||typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500||!body.config||typeof body.config!=='object'||Array.isArray(body.config))throw invalid('Exact revision, typed configuration and reason required');const config=validateDistributionPolicy(body.config as Record<string,unknown>),canonical=canonicalize(config),digest=sha(canonical);if(config.schema!=='distribution-policy.v1')throw forbidden('Uniform policy requires approved execution');return withTransaction(pool,async c=>{
 await authorize(c,actor,true);await resource(c,false,binding);return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.policy.configure'},key,fingerprintRequest('distribution.policy.configure',scope,body),async()=>{await authorize(c,actor,true);},async()=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:LOCAL_CONTROLLED',0))");const head=(await c.query('SELECT revision::text,current_version_id FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[scope])).rows[0],before=head?head.revision:'0';if(before!==body.expectedRevision)throw conflict('Distribution policy changed; reload before saving');const revision=(BigInt(before)+1n).toString(),id='distribution_policy_'+sha(canonicalize([scope,revision,digest])).slice(0,40);
  await c.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,$2,$3,'distribution-policy.v1',$4,$5,$6)`,[id,revision,scope,canonical,digest,actor.userId]);if(head){const changed=await c.query('UPDATE zzsh_order.distribution_policy_head SET revision=$2,current_version_id=$3 WHERE scope=$1 AND revision=$4',[scope,revision,id,before]);if(changed.rowCount!==1)throw conflict('Policy head CAS failed');}else await c.query('INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES($1,$2,$3)',[scope,revision,id]);
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.policy.configured',objectType:'distribution_policy_version',objectId:id,outcome:'SUCCESS',reason:body.reason as string,details:{beforeRevision:before,revision,digest,scope}});await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:await read(c)};
 });
});}



/** Approval preparation and execution share the same explicit write/resource/contract admission. */
export async function assertDistributionPolicyWriteReadyInTransaction(c:PoolClient,binding?:LocalDistributionScope){
 if(!binding)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Approved distribution write scope is not assembled');
 await resource(c,false,binding);
 const marker=(await c.query("SELECT to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS ready")).rows[0];
 if(marker?.ready!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Uniform distribution contract not installed');
 if((await c.query('SELECT zzsh_order.distribution_policy_contract_version() AS version')).rows[0]?.version!==2)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Uniform distribution contract mismatch');
}
/** Same transaction/CAS/audit as the existing store; new uniform writes have a separately installed contract. */
export async function applyApprovedDistributionPolicyInTransaction(c:PoolClient,actor:Actor,input:DistributionPolicyChange,approval:{approvalRequestId:string;payloadHash:string},binding:LocalDistributionScope){
 await authorize(c,actor,true);await assertDistributionPolicyWriteReadyInTransaction(c,binding);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approval.approvalRequestId)||!/^[a-f0-9]{64}$/.test(approval.payloadHash))throw conflict('Approved distribution reference invalid');
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:LOCAL_CONTROLLED',0))");
 const head=(await c.query('SELECT revision::text,current_version_id FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[scope])).rows[0];
 if(!head||head.revision!==input.expectedRevision||head.current_version_id!==input.expectedPolicyId)throw conflict('Distribution policy changed; approved baseline is stale');
 const previous=await read(c);if(previous.knowledge!=='KNOWN')throw conflict('Original distribution policy unavailable');
 const config=prepareDistributionPolicyChange(previous.policy,input),canonical=canonicalize(config),digest=sha(canonical),revision=(BigInt(input.expectedRevision)+1n).toString(),id='distribution_policy_'+sha(canonicalize([scope,revision,digest])).slice(0,40);
 await c.query('INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,revision,scope,config.schema,canonical,digest,actor.userId]);
 const changed=await c.query('UPDATE zzsh_order.distribution_policy_head SET revision=$2,current_version_id=$3 WHERE scope=$1 AND revision=$4',[scope,revision,id,input.expectedRevision]);if(changed.rowCount!==1)throw conflict('Policy head CAS failed');
 await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.policy.approved_executed',objectType:'distribution_policy_version',objectId:id,outcome:'SUCCESS',reason:input.reason,details:{approvalRequestId:approval.approvalRequestId,approvedPayloadHash:approval.payloadHash,beforePolicyId:previous.policy.versionId,beforeRevision:input.expectedRevision,revision,digest,scope}});
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');const result=await read(c);if(result.knowledge!=='KNOWN'||result.policy.versionId!==id)throw conflict('Approved policy readback mismatch');return result;
}
