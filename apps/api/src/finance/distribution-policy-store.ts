import type {Pool,PoolClient} from 'pg';import {createHash} from 'node:crypto';
import {withTransaction,recordAudit,SecurityApiError} from '../auth/security-core';import {assertAdminContextInTransaction} from '../auth/auth-security';import {loadEffectiveAdminAccess,hasPermission,requirePermission} from '../auth/admin-authorization';
import {canonicalize} from '../supply/content-hash';import {ensureOnlyFields,invalid,conflict,forbidden,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {validateDistributionPolicy,type DistributionPolicyConfig} from './distribution-policy';
import {ConfigurationError,type AppConfig} from '../config/config';
export type LocalDistributionScope=Readonly<{kind:'LOCAL_CONTROLLED_DISTRIBUTION'}>;
type CreationReceipt={database:string;resourceOid:number;owner:string;marker:string;migrationRole:string;runtimeRole:string};
const localName='zzsh_test_order_credit_admin_batch2',localRuntime='zzsh_order_credit_admin_batch2_r',localMigration='zzsh_order_credit_admin_batch2_m',localMarker='zzsh:order-reservation-test:v1';
const localProofs=new WeakMap<LocalDistributionScope,Readonly<CreationReceipt>>();
/** Explicit server assembly from the resource creation receipt; never HTTP or environment input. */
export function createLocalDistributionScope(config:AppConfig,receipt:CreationReceipt):LocalDistributionScope{
 if(config.profile!=='test'||config.provider!=='fake'||!config.testOperationsEnabled
  ||config.database.target!=='local-compose'||config.database.host!=='127.0.0.1'||config.database.port!==55432
  ||config.database.name!==localName||config.database.user!==localRuntime
  ||receipt.database!==localName||receipt.runtimeRole!==localRuntime||receipt.migrationRole!==localMigration
  ||receipt.owner!=='zzsh'||receipt.marker!==localMarker||!Number.isSafeInteger(receipt.resourceOid)||receipt.resourceOid<=0||receipt.resourceOid>4294967295
  ||[793252,878001,893390,881699,820148,833000,869754].includes(receipt.resourceOid))throw new ConfigurationError('Exact local test/fake distribution creation receipt required');
 const value=Object.freeze({kind:'LOCAL_CONTROLLED_DISTRIBUTION' as const});localProofs.set(value,Object.freeze({...receipt}));return value;
}
export function assertLocalDistributionAssembly(binding:LocalDistributionScope|undefined,options:{testOperationsEnabled:boolean;secureCookies:boolean;apiOrigin:string;userOrigin:string;adminOrigin:string}){
 if(binding===undefined)return;
 if(!localProofs.has(binding)||!options.testOperationsEnabled||options.secureCookies||process.env.NODE_ENV==='production'
  ||options.apiOrigin!=='http://127.0.0.1:4282'||options.userOrigin!=='http://127.0.0.1:4280'||options.adminOrigin!=='http://127.0.0.1:4281')throw new ConfigurationError('Local distribution scope requires its explicit test API assembly');
}
export const DISTRIBUTION_POLICY_PERMISSION={read:'personal.distribution.policy.read',manage:'personal.distribution.policy.manage'} as const;
type Actor={userId:string;sessionId:string;requestId:string};const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),scope='LOCAL_CONTROLLED';
async function authorize(c:PoolClient,actor:Actor,write=false){await assertAdminContextInTransaction(c,actor);const user=(await c.query('SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1',[actor.userId])).rows[0];if(!user||user.suspended)throw forbidden('Policy operator unavailable');const access=await loadEffectiveAdminAccess(c,actor.userId);if(write)requirePermission(access,DISTRIBUTION_POLICY_PERMISSION.manage);else if(!hasPermission(access,DISTRIBUTION_POLICY_PERMISSION.read)&&!hasPermission(access,DISTRIBUTION_POLICY_PERMISSION.manage))throw forbidden('Policy read permission required');}
async function resource(c:PoolClient, allowUnadmitted=false,binding?:LocalDistributionScope){const r=(await c.query("SELECT d.oid,current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker,to_regclass('zzsh_order.distribution_policy_version') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AS complete FROM pg_database d WHERE d.datname=current_database()")).rows[0];
 if(binding!==undefined){
  const proof=localProofs.get(binding);
  if(!proof||!r||r.name!==proof.database||Number(r.oid)!==proof.resourceOid||r.marker!==proof.marker||![proof.runtimeRole,proof.migrationRole].includes(r.role)||r.complete!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution resource differs');
  const shape=(await c.query(`SELECT pg_get_userbyid(d.datdba) AS owner,r.rolsuper,r.rolbypassrls,
   to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.distribution_invite_code') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AS complete
   FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  if(!shape||shape.owner!==proof.owner||shape.rolsuper!==false||shape.rolbypassrls!==false||shape.complete!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution schema or role unavailable');
  return true;
 }
 const resources=[['zzsh_test_m2_auth_auth_compat',820148,'zzsh_m2_auth_compat_','zzsh:m2-auth-test:v1'],['zzsh_test_m2_auth_auth_compat_ui',833000,'zzsh_m2_auth_compat_ui_','zzsh:m2-auth-test:v1'],['zzsh_test_order_personal_finance',869754,'zzsh_order_personal_finance_','zzsh:order-reservation-test:v1']] as const;
 const expected=resources.find(([name,oid])=>r?.name===name&&Number(r.oid)===oid);if(!expected&&allowUnadmitted)return false;if(!expected||r.marker!==expected[3]||![expected[2]+'r',expected[2]+'m'].includes(r.role)||!r.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution policy resource or schema unavailable');return true;}

function decode(row:Record<string,any>){if(sha(row.canonical_config)!==row.config_digest)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Policy digest differs');let config:DistributionPolicyConfig;try{config=validateDistributionPolicy(JSON.parse(row.canonical_config));if(canonicalize(config)!==row.canonical_config)throw Error();}catch{throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Policy schema is not valid');}return{versionId:row.id,revision:String(row.revision),digest:row.config_digest,config,createdAt:new Date(row.created_at).toISOString()};}
/** Caller has verified its resource. Payment and relation writers may pin the immutable head. */
export async function readDistributionPolicyRowInTransaction(c:PoolClient,lockHead=false){const row=(await c.query(`SELECT v.* FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version v ON v.id=h.current_version_id AND v.scope=h.scope AND v.revision=h.revision WHERE h.scope=$1${lockHead?' FOR SHARE OF h':''}`,[scope])).rows[0];return row?{knowledge:'KNOWN' as const,policy:decode(row)}:{knowledge:'UNKNOWN' as const,policy:null,reason:'POLICY_NOT_CONFIGURED'};}
const read=readDistributionPolicyRowInTransaction;
export async function readDistributionPolicy(pool:Pool,actor:Actor,binding?:LocalDistributionScope){return withTransaction(pool,async c=>{await authorize(c,actor);await resource(c,false,binding);return read(c);});}
/** Domain-only current policy read; caller retains its own user/registration authorization. */
export async function readActiveDistributionPolicyInTransaction(c:PoolClient,lockHead=false,binding?:LocalDistributionScope){await resource(c,false,binding);return read(c,lockHead);}
/** Registration remains available before distribution admission; policy reads/writes elsewhere stay strict. */
export async function readRegistrationDistributionPolicyInTransaction(c:PoolClient,binding?:LocalDistributionScope){
 if(!await resource(c,true,binding))return{knowledge:'UNKNOWN' as const,policy:null,reason:'DISTRIBUTION_RESOURCE_NOT_ADMITTED'};
 return read(c,true);
}
export async function configureDistributionPolicy(pool:Pool,actor:Actor,body:Record<string,unknown>,key:string,binding?:LocalDistributionScope){ensureOnlyFields(body,['expectedRevision','config','reason']);if(typeof body.expectedRevision!=='string'||!/^(0|[1-9]\d{0,18})$/.test(body.expectedRevision)||typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500||!body.config||typeof body.config!=='object'||Array.isArray(body.config))throw invalid('Exact revision, typed configuration and reason required');const config=validateDistributionPolicy(body.config as Record<string,unknown>),canonical=canonicalize(config),digest=sha(canonical);return withTransaction(pool,async c=>{
 await authorize(c,actor,true);await resource(c,false,binding);return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.policy.configure'},key,fingerprintRequest('distribution.policy.configure',scope,body),()=>authorize(c,actor,true),async()=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:LOCAL_CONTROLLED',0))");const head=(await c.query('SELECT revision::text,current_version_id FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[scope])).rows[0],before=head?head.revision:'0';if(before!==body.expectedRevision)throw conflict('Distribution policy changed; reload before saving');const revision=(BigInt(before)+1n).toString(),id='distribution_policy_'+sha(canonicalize([scope,revision,digest])).slice(0,40);
  await c.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,$2,$3,'distribution-policy.v1',$4,$5,$6)`,[id,revision,scope,canonical,digest,actor.userId]);if(head){const changed=await c.query('UPDATE zzsh_order.distribution_policy_head SET revision=$2,current_version_id=$3 WHERE scope=$1 AND revision=$4',[scope,revision,id,before]);if(changed.rowCount!==1)throw conflict('Policy head CAS failed');}else await c.query('INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES($1,$2,$3)',[scope,revision,id]);
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.policy.configured',objectType:'distribution_policy_version',objectId:id,outcome:'SUCCESS',reason:body.reason as string,details:{beforeRevision:before,revision,digest,scope}});await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:await read(c)};
 });
});}


