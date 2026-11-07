import type {Pool,PoolClient} from 'pg';import {createHash} from 'node:crypto';
import {withTransaction,recordAudit,SecurityApiError} from '../auth/security-core';import {assertAdminContextInTransaction} from '../auth/auth-security';import {loadEffectiveAdminAccess,hasPermission,requirePermission} from '../auth/admin-authorization';
import {canonicalize} from '../supply/content-hash';import {ensureOnlyFields,invalid,conflict,forbidden,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {validateDistributionPolicy,type DistributionPolicyConfig} from './distribution-policy';
import {prepareDistributionPolicyChange,initialDistributionPolicyConfig,isInitialPolicyChange,type DistributionPolicyChange,type DistributionPolicyUpdate,type DistributionPolicyInitial} from './distribution-policy-change';
import {ConfigurationError,isEcsTestWithoutJoinpay,type AppConfig} from '../config/config';
import {assertBusinessRuntimeIdentity} from '../database/business';
import {assertControlledRegressionResource,type ControlledRegressionResource} from './controlled-regression-resource';
import {REGRESSION_DATABASE,REGRESSION_MARKER,REGRESSION_RUNTIME_USER} from '../config/test-resource';
import {readFormalCollectionAdmission,type FormalCollectionAdmission} from '../order/joinpay-collection-profile';
import {assertLocalFinancialSandboxAssembly,assertLocalFinancialSandboxResource,localFinancialSandboxRegistration,type LocalFinancialSandbox} from './local-financial-sandbox-resource';
export type LocalDistributionScope=Readonly<{kind:'LOCAL_CONTROLLED_DISTRIBUTION'|'NATIVE_DISTRIBUTION'}>;
export type DistributionPolicyScopeKind='LOCAL_CONTROLLED'|'NATIVE';
type CreationReceipt={database:string;resourceOid:number;owner:string;marker:string;migrationRole:string;runtimeRole:string;ownerOid?:number;migrationRoleOid?:number;runtimeRoleOid?:number};
export type RegisteredLocalNativeDistributionBinding=Required<CreationReceipt>&{nonce:string};
type DistributionOrigins=Readonly<{apiOrigin:string;userOrigin:string;adminOrigin:string}>;
const localName='zzsh_test_order_credit_admin_batch2',localRuntime='zzsh_order_credit_admin_batch2_r',localMigration='zzsh_order_credit_admin_batch2_m',localMarker='zzsh:order-reservation-test:v1';
const milestoneName='zzsh_test_order_milestone_real_1',milestoneRuntime='zzsh_order_milestone_real_1_r',milestoneMigration='zzsh_order_milestone_real_1_m';
const localProofs=new WeakMap<LocalDistributionScope,Readonly<CreationReceipt&{readOnly:boolean;origins?:DistributionOrigins;sandbox?:LocalFinancialSandbox;nativeReadNonce?:string;nativeReadPort?:number}>>();
const nativeProofs=new WeakMap<LocalDistributionScope,Readonly<{kind:'NATIVE';database:string;runtimeUser:string;admissionSha256:string|null;withoutJoinpay:boolean}>>();
type ReviewedDistributionInstance=Readonly<{host:'127.0.0.1';port:55432|55433;systemIdentifier:string}>;
const reviewedLocalNativeProofs=new WeakMap<LocalDistributionScope,Readonly<{proof:ControlledRegressionResource;owner:string;ownerOid:number;instance?:ReviewedDistributionInstance}>>();
/** Formal NATIVE scope comes only from the reviewed formal collection admission; no receipt or env shortcut. */
export function createNativeDistributionPolicyScope(admission:FormalCollectionAdmission):LocalDistributionScope{
 const view=readFormalCollectionAdmission(admission),value=Object.freeze({kind:'NATIVE_DISTRIBUTION' as const});
 nativeProofs.set(value,Object.freeze({kind:'NATIVE' as const,database:view.database,runtimeUser:view.runtimeUser,admissionSha256:view.sha256,withoutJoinpay:false}));return value;
}
/** Business policy and relationships can use the target resource without granting payment authority. */
export function createEcsTestDistributionPolicyScope(config:Pick<AppConfig,'provider'|'database'>&Partial<Pick<AppConfig,'profile'>>,env:NodeJS.ProcessEnv):LocalDistributionScope{
 const db=config.database;
 if(!isEcsTestWithoutJoinpay(env)||config.profile!=='ecs-test'||config.provider!=='real'||db.target!=='ecs-test'||db.targetProfile!=='ecs-test'
  ||!/^zzsh_ecs_test(?:_[a-z0-9_]+)?$/.test(db.name)||db.name.length>63||!/^[a-z][a-z0-9_]{0,62}$/.test(db.user)||db.user!==db.runtimeUser)
  throw new ConfigurationError('ECS_TEST_DISTRIBUTION_RESOURCE_INVALID');
 const value=Object.freeze({kind:'NATIVE_DISTRIBUTION' as const});
 nativeProofs.set(value,Object.freeze({kind:'NATIVE' as const,database:db.name,runtimeUser:db.user,admissionSha256:null,withoutJoinpay:true}));return value;
}
/** Offline migration only; the original regression proof is rechecked on every transaction. */
export function createReviewedLocalNativeDistributionScope(proof:ControlledRegressionResource,owner:{owner:string;ownerOid:number;instance?:ReviewedDistributionInstance}):LocalDistributionScope{
 if(!owner||!/^[a-z][a-z0-9_]{0,62}$/.test(owner.owner)||owner.owner===REGRESSION_RUNTIME_USER||!Number.isSafeInteger(owner.ownerOid)||owner.ownerOid<=0||owner.ownerOid>4294967295)
  throw new ConfigurationError('REVIEWED_LOCAL_NATIVE_DISTRIBUTION_OWNER_INVALID');
 const instance=owner.instance;
 if(instance&&(instance.host!=='127.0.0.1'||![55432,55433].includes(instance.port)||!/^[0-9]+$/.test(instance.systemIdentifier)))throw new ConfigurationError('REVIEWED_LOCAL_NATIVE_DISTRIBUTION_INSTANCE_INVALID');
 const value=Object.freeze({kind:'NATIVE_DISTRIBUTION' as const});reviewedLocalNativeProofs.set(value,Object.freeze({proof,owner:owner.owner,ownerOid:owner.ownerOid,...(instance?{instance:Object.freeze({...instance})}:{})}));return value;
}
export function distributionPolicyScopeOf(binding:LocalDistributionScope|undefined):DistributionPolicyScopeKind{return binding!==undefined&&(nativeProofs.has(binding)||reviewedLocalNativeProofs.has(binding)||localProofs.get(binding)?.nativeReadNonce!==undefined)?'NATIVE':'LOCAL_CONTROLLED';}
/** Explicit server assembly from the resource creation receipt; never HTTP or environment input. */
export function createLocalDistributionScope(config:AppConfig,receipt:CreationReceipt):LocalDistributionScope{
 return createScope(config,receipt,false);
}
/** Exact milestone GET capability; it cannot admit registration, policy or relation writes. */
export function createLocalDistributionReadScope(config:AppConfig,receipt:CreationReceipt):LocalDistributionScope{
 return createScope(config,receipt,true);
}
/** Uses the existing policy/approval/relationship rules; environment enrollment never creates a policy or participant. */
export function createSandboxDistributionPolicyScope(sandbox:LocalFinancialSandbox):LocalDistributionScope{
 const registration=localFinancialSandboxRegistration(sandbox).registration,value=Object.freeze({kind:'LOCAL_CONTROLLED_DISTRIBUTION' as const});
 localProofs.set(value,Object.freeze({...registration.resource,readOnly:false,origins:registration.origins,sandbox}));return value;
}
/** Server-registered receipt only; this capability admits GETs on the exact resource and origins, never writes. */
export function createRegisteredLocalDistributionReadScope(config:AppConfig,receipt:Required<CreationReceipt>,origins:DistributionOrigins&{secureCookies:boolean}):LocalDistributionScope{
 const oid=(value:number)=>Number.isSafeInteger(value)&&value>0&&value<=4294967295;
 const localOrigin=(value:string)=>{try{const url=new URL(value);return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Boolean(url.port)&&url.origin===value;}catch{return false;}};
 if(!['test','dev'].includes(config.profile)||config.provider!=='fake'||config.host!=='127.0.0.1'
  ||config.database.target!=='local-compose'||config.database.host!=='127.0.0.1'||![55432,55433].includes(config.database.port)
  ||config.database.name!==receipt.database||config.database.user!==receipt.runtimeRole||config.database.runtimeUser!==receipt.runtimeRole
  ||!['database','owner','runtimeRole','migrationRole'].every(key=>{const value=receipt[key as keyof CreationReceipt];return typeof value==='string'&&value.length>0&&value.length<=63&&value===value.trim()&&!/[\x00-\x1f\x7f]/.test(value);})
  ||typeof receipt.marker!=='string'||!receipt.marker.length||receipt.marker.length>1024||/[\x00-\x1f\x7f]/.test(receipt.marker)
  ||![receipt.resourceOid,receipt.ownerOid,receipt.runtimeRoleOid,receipt.migrationRoleOid].every(oid)
  ||receipt.runtimeRole===receipt.owner||receipt.runtimeRole===receipt.migrationRole||receipt.runtimeRoleOid===receipt.ownerOid||receipt.runtimeRoleOid===receipt.migrationRoleOid
  ||(receipt.owner===receipt.migrationRole)!==(receipt.ownerOid===receipt.migrationRoleOid)
  ||origins.secureCookies!==false||![origins.apiOrigin,origins.userOrigin,origins.adminOrigin].every(localOrigin)
  ||new Set([origins.apiOrigin,origins.userOrigin,origins.adminOrigin]).size!==3||origins.apiOrigin!==`http://127.0.0.1:${config.port}`)throw new ConfigurationError('Exact registered local fake distribution read receipt and origins required');
 const value=Object.freeze({kind:'LOCAL_CONTROLLED_DISTRIBUTION' as const});
 localProofs.set(value,Object.freeze({...receipt,readOnly:true,origins:Object.freeze({apiOrigin:origins.apiOrigin,userOrigin:origins.userOrigin,adminOrigin:origins.adminOrigin}),sandbox:undefined}));return value;
}
/** One registered local regression epoch can read the NATIVE policy without payment or write admission. */
export function createRegisteredLocalNativeDistributionReadScope(config:AppConfig,receipt:Required<CreationReceipt>&{nonce:string},origins:DistributionOrigins&{secureCookies:boolean}):LocalDistributionScope{
 if(config.profile!=='test'||config.testOperationsEnabled||process.env.NODE_ENV==='production'||config.database.targetProfile!=='test'
  ||config.database.name!==REGRESSION_DATABASE||config.database.user!==REGRESSION_RUNTIME_USER||receipt.marker!==REGRESSION_MARKER
  ||typeof receipt.nonce!=='string'||!/^[a-f0-9]{24}$/.test(receipt.nonce))throw new ConfigurationError('Exact registered local native distribution read resource required');
 const base=createRegisteredLocalDistributionReadScope(config,receipt,origins),proof=localProofs.get(base)!;
 const value=Object.freeze({kind:'NATIVE_DISTRIBUTION' as const});
 localProofs.set(value,Object.freeze({...proof,nativeReadNonce:receipt.nonce,nativeReadPort:config.database.port}));return value;
}
export function assertRegisteredLocalNativeDistributionReadScope(scope:LocalDistributionScope):void{
 if(localProofs.get(scope)?.nativeReadNonce===undefined)throw new ConfigurationError('REGISTERED_LOCAL_NATIVE_READ_SCOPE_REQUIRED');
}
/** A read capability is never a write capability; this only compares a server-owned registered epoch. */
export function assertRegisteredLocalNativeDistributionReadBinding(scope:LocalDistributionScope,binding:RegisteredLocalNativeDistributionBinding):void{
 const proof=localProofs.get(scope);
 if(!proof||proof.nativeReadNonce===undefined||!proof.readOnly||proof.database!==binding.database||proof.resourceOid!==binding.resourceOid
  ||proof.owner!==binding.owner||proof.ownerOid!==binding.ownerOid||proof.marker!==binding.marker||proof.migrationRole!==binding.migrationRole
  ||proof.migrationRoleOid!==binding.migrationRoleOid||proof.runtimeRole!==binding.runtimeRole||proof.runtimeRoleOid!==binding.runtimeRoleOid
  ||proof.nativeReadNonce!==binding.nonce)throw new ConfigurationError('REGISTERED_LOCAL_NATIVE_READ_BINDING_MISMATCH');
}
export function isRegisteredLocalNativeDistributionReadScope(scope:LocalDistributionScope|undefined):boolean{
 return scope!==undefined&&localProofs.get(scope)?.nativeReadNonce!==undefined;
}

/** This local read brand cannot be combined with write, funds or distribution worker assembly. */
export function assertLocalNativeDistributionReadOnlyAssembly(readScope:LocalDistributionScope|undefined,writeScope:LocalDistributionScope|undefined,options:{testOperationsEnabled:boolean;settlementRecordingEnabled?:boolean;distributionEarnings?:unknown;joinpayCollection?:unknown;joinpayRefund?:unknown;joinpayWithdrawal?:unknown;joinpayAccountRead?:unknown;joinpayAccountObservation?:unknown;localControlledPayments?:unknown;localFinancialSandbox?:unknown;nativeWithdrawalScope?:unknown;distributionDue?:unknown}):void{
 const localNative=(scope:LocalDistributionScope|undefined)=>scope!==undefined&&localProofs.get(scope)?.nativeReadNonce!==undefined;
 if(!localNative(readScope)&&!localNative(writeScope))return;
 if(localNative(writeScope)||writeScope!==undefined||options.testOperationsEnabled||options.settlementRecordingEnabled||options.distributionEarnings||options.joinpayCollection||options.joinpayRefund||options.joinpayWithdrawal||options.joinpayAccountRead||options.joinpayAccountObservation||options.localControlledPayments||options.localFinancialSandbox||options.nativeWithdrawalScope||options.distributionDue)
  throw new ConfigurationError('LOCAL_NATIVE_DISTRIBUTION_READ_ONLY_ASSEMBLY_REQUIRED');
}
export function assertLocalNativeDistributionWriteUnavailable(binding:LocalDistributionScope|undefined):void{
 if(binding!==undefined&&localProofs.get(binding)?.nativeReadNonce!==undefined)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Local native distribution scope is read only');
}
function createScope(config:AppConfig,receipt:CreationReceipt,readOnly:boolean):LocalDistributionScope{
 const milestone=receipt.database===milestoneName,name=milestone?milestoneName:localName,runtime=milestone?milestoneRuntime:localRuntime,migration=milestone?milestoneMigration:localMigration;
 if(config.profile!=='test'||config.provider!=='fake'||!readOnly&&!config.testOperationsEnabled||readOnly&&!milestone
  ||config.database.target!=='local-compose'||config.database.host!=='127.0.0.1'||![55432,55433].includes(config.database.port)
  ||config.database.name!==name||config.database.user!==runtime
  ||receipt.database!==name||receipt.runtimeRole!==runtime||receipt.migrationRole!==migration
  ||receipt.owner!=='zzsh'||receipt.marker!==localMarker||!Number.isSafeInteger(receipt.resourceOid)||receipt.resourceOid<=0||receipt.resourceOid>4294967295
  ||milestone&&(receipt.resourceOid!==952624||receipt.ownerOid!==10||receipt.migrationRoleOid!==952625||receipt.runtimeRoleOid!==952626)
  ||[793252,878001,893390,881699,820148,833000,869754].includes(receipt.resourceOid))throw new ConfigurationError('Exact local test/fake distribution creation receipt required');
 const value=Object.freeze({kind:'LOCAL_CONTROLLED_DISTRIBUTION' as const});localProofs.set(value,Object.freeze({...receipt,readOnly,origins:undefined,sandbox:undefined}));return value;
}
export function assertLocalDistributionAssembly(binding:LocalDistributionScope|undefined,options:{testOperationsEnabled:boolean;secureCookies:boolean;apiOrigin:string;userOrigin:string;adminOrigin:string;joinpayCollection?:unknown;joinpayRefund?:unknown;joinpayWithdrawal?:unknown;joinpayAccountObservation?:unknown;localControlledPayments?:unknown;localFinancialSandbox?:unknown;distributionEarnings?:unknown;settlementRecordingEnabled?:boolean}){
 if(binding===undefined)return;
 if(reviewedLocalNativeProofs.has(binding))throw new ConfigurationError('REVIEWED_LOCAL_NATIVE_DISTRIBUTION_IS_OFFLINE_ONLY');
 const native=nativeProofs.get(binding);
 if(native){
  const https=(origin:string)=>/^https:\/\/[^/]+(?:\/.*)?$/.test(origin)&&!/^https:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(origin);
  if(options.secureCookies!==true||!https(options.apiOrigin)||!https(options.userOrigin)||!https(options.adminOrigin))throw new ConfigurationError('Native distribution scope requires secure non-local production origins');
  if(native.withoutJoinpay&&(options.testOperationsEnabled||options.settlementRecordingEnabled||options.distributionEarnings||options.joinpayCollection||options.joinpayRefund||options.joinpayWithdrawal||options.joinpayAccountObservation||options.localControlledPayments||options.localFinancialSandbox))
   throw new ConfigurationError('ECS_TEST_DISTRIBUTION_PAYMENT_ASSEMBLY_FORBIDDEN');
  return;
 }
 const receipt=localProofs.get(binding),port=receipt?.database===milestoneName?4220:4280;
 if(receipt?.sandbox){assertLocalFinancialSandboxAssembly(receipt.sandbox,options);return;}
 const origins=receipt?.origins??{apiOrigin:`http://127.0.0.1:${port+2}`,userOrigin:`http://127.0.0.1:${port}`,adminOrigin:`http://127.0.0.1:${port+1}`};
 if(!localProofs.has(binding)||!receipt?.readOnly&&!options.testOperationsEnabled||options.secureCookies||process.env.NODE_ENV==='production'
  ||options.apiOrigin!==origins.apiOrigin||options.userOrigin!==origins.userOrigin||options.adminOrigin!==origins.adminOrigin)throw new ConfigurationError('Local distribution scope requires its explicit test API assembly');
}
export const DISTRIBUTION_POLICY_PERMISSION={read:'personal.distribution.policy.read',manage:'personal.distribution.policy.manage'} as const;
type Actor={userId:string;sessionId:string;requestId:string};const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),scope='LOCAL_CONTROLLED';
async function authorize(c:PoolClient,actor:Actor,write=false){await assertAdminContextInTransaction(c,actor);const user=(await c.query('SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1',[actor.userId])).rows[0];if(!user||user.suspended)throw forbidden('Policy operator unavailable');const access=await loadEffectiveAdminAccess(c,actor.userId);if(write)requirePermission(access,DISTRIBUTION_POLICY_PERMISSION.manage);else if(!hasPermission(access,DISTRIBUTION_POLICY_PERMISSION.read)&&!hasPermission(access,DISTRIBUTION_POLICY_PERMISSION.manage))throw forbidden('Policy read permission required');return access;}
async function resource(c:PoolClient, allowUnadmitted=false,binding?:LocalDistributionScope,maintenanceOwner=false,readOnly=false){
 const reviewed=binding&&reviewedLocalNativeProofs.get(binding);
 if(reviewed){
  const connection=(c as PoolClient&{connectionParameters?:{host?:string;port?:number;database?:string;user?:string}}).connectionParameters;
  if(maintenanceOwner||c.getTransactionStatus()!=='T'||!connection||connection.host!==(reviewed.instance?.host??'127.0.0.1')||Number(connection.port)!==(reviewed.instance?.port??55432)||connection.database!==REGRESSION_DATABASE||connection.user!==REGRESSION_RUNTIME_USER)
   throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Reviewed local distribution connection differs');
  await assertControlledRegressionResource(c,reviewed.proof,'DISTRIBUTION');
  if(reviewed.instance){const actual=(await c.query('SELECT system_identifier::text AS system_identifier FROM pg_control_system()')).rows[0];
   if(actual?.system_identifier!==reviewed.instance.systemIdentifier)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Reviewed local distribution cluster differs');}
  const state=(await c.query(`SELECT pg_get_userbyid(d.datdba) AS owner,d.datdba::int AS "ownerOid",
   to_regclass('zzsh_order.distribution_policy_version') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AND to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.distribution_invite_code') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AS complete
   FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  if(!state||state.owner!==reviewed.owner||Number(state.ownerOid)!==reviewed.ownerOid)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Reviewed local distribution owner differs');
  if(state.complete!==true){if(allowUnadmitted)return false;throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Reviewed local distribution structure unavailable');}
  return true;
 }
 const r=(await c.query("SELECT d.oid,current_database() AS name,current_user AS role,current_setting('zzsh.regression_run',true) AS nonce,shobj_description(d.oid,'pg_database') AS marker,to_regclass('zzsh_order.distribution_policy_version') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AS complete FROM pg_database d WHERE d.datname=current_database()")).rows[0];
 const native=nativeProofs.get(binding!);
 if(native){
  if(maintenanceOwner||!r||r.name!==native.database||r.role!==native.runtimeUser)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound native distribution resource differs');
  const shape=(await c.query(`SELECT pg_get_userbyid(d.datdba) AS owner,d.datdba::int AS "ownerOid",r.oid::int AS "roleOid",r.rolsuper,r.rolbypassrls,
   to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.distribution_invite_code') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AS complete
   FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  if(!shape||shape.rolsuper!==false||shape.rolbypassrls!==false||(!native.withoutJoinpay&&native.admissionSha256?.length!==64)||(native.withoutJoinpay&&native.admissionSha256!==null))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound native distribution schema or role unavailable');
  if(r.complete!==true||shape.complete!==true){if(allowUnadmitted)return false;throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound native distribution structure unavailable');}
  if(native.withoutJoinpay){try{await assertBusinessRuntimeIdentity(c,{database:{name:native.database,user:native.runtimeUser,runtimeUser:native.runtimeUser}});}catch{throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound native distribution runtime identity unavailable');}}
  return true;
 }
 if(binding!==undefined){
  const proof=localProofs.get(binding);
  if(!proof)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution resource differs');
  if(proof.sandbox){if(maintenanceOwner)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Sandbox is not a legacy maintenance authority');const checked=await assertLocalFinancialSandboxResource(c,proof.sandbox,readOnly||allowUnadmitted?'READ_ORIGINAL':'WRITE');return allowUnadmitted?checked.active:true;}
  if(proof.nativeReadNonce!==undefined){
   const connection=(c as PoolClient&{connectionParameters?:{host?:string;port?:number;database?:string;user?:string}}).connectionParameters;
   if(process.env.NODE_ENV==='production'||maintenanceOwner||!readOnly||c.getTransactionStatus()!=='T'||!connection||connection.host!=='127.0.0.1'||Number(connection.port)!==proof.nativeReadPort||connection.database!==proof.database||connection.user!==proof.runtimeRole||r?.nonce!==proof.nativeReadNonce)
    throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound local native distribution read resource differs');
  }
  const roles=maintenanceOwner&&proof.database===milestoneName?[proof.owner]:proof.readOnly?[proof.runtimeRole]:[proof.runtimeRole,proof.migrationRole];
  if(proof.readOnly&&!readOnly||!r||maintenanceOwner&&proof.database!==milestoneName||r.name!==proof.database||Number(r.oid)!==proof.resourceOid||r.marker!==proof.marker||!roles.includes(r.role)||r.complete!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution resource differs');
  const shape=(await c.query(`SELECT pg_get_userbyid(d.datdba) AS owner,d.datdba::int AS "ownerOid",r.oid::int AS "roleOid",r.rolsuper,r.rolbypassrls,
   ${proof.origins?'m.oid::int AS "migrationRoleOid",m.rolsuper AS "migrationSuper",m.rolbypassrls AS "migrationBypass",':''}
   to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.distribution_invite_code') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AS complete
   FROM pg_database d JOIN pg_roles r ON r.rolname=current_user ${proof.origins?'LEFT JOIN pg_roles m ON m.rolname=$1':''} WHERE d.datname=current_database()`,proof.origins?[proof.migrationRole]:[])).rows[0];
  const expectedRole=maintenanceOwner?proof.ownerOid:r.role===proof.runtimeRole?proof.runtimeRoleOid:proof.migrationRoleOid;
  if(!shape||shape.owner!==proof.owner||!maintenanceOwner&&(shape.rolsuper!==false||shape.rolbypassrls!==false)||shape.complete!==true
   ||(proof.database===milestoneName||proof.origins)&&(shape.ownerOid!==proof.ownerOid||shape.roleOid!==expectedRole)
   ||proof.origins&&(shape.migrationRoleOid!==proof.migrationRoleOid||shape.migrationSuper!==false||shape.migrationBypass!==false))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound distribution schema or role unavailable');
  if(proof.nativeReadNonce!==undefined){try{await assertBusinessRuntimeIdentity(c,{database:{name:proof.database,user:proof.runtimeRole,runtimeUser:proof.runtimeRole}});}catch{throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Bound local native distribution runtime identity unavailable');}}
  return true;
 }
 const resources=[['zzsh_test_m2_auth_auth_compat',820148,'zzsh_m2_auth_compat_','zzsh:m2-auth-test:v1'],['zzsh_test_m2_auth_auth_compat_ui',833000,'zzsh_m2_auth_compat_ui_','zzsh:m2-auth-test:v1'],['zzsh_test_order_personal_finance',869754,'zzsh_order_personal_finance_','zzsh:order-reservation-test:v1']] as const;
 const expected=resources.find(([name,oid])=>r?.name===name&&Number(r.oid)===oid);if(!expected&&allowUnadmitted)return false;if(!expected||r.marker!==expected[3]||![expected[2]+'r',expected[2]+'m'].includes(r.role)||!r.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution policy resource or schema unavailable');return true;}
/** Internal historical migration only: the exact receipt admits owner10, never the runtime role or an arbitrary local database. */
export async function assertReviewedDistributionMaintenanceResource(c:PoolClient,binding:LocalDistributionScope){return resource(c,false,binding,true);}
/** Identity verification only; the read scope itself remains incapable of authorizing a write. */
export async function assertRegisteredLocalNativeDistributionReadResource(c:PoolClient,binding:LocalDistributionScope){
 assertRegisteredLocalNativeDistributionReadScope(binding);await resource(c,false,binding,false,true);
}

function decode(row:Record<string,any>,expectedScope:'LOCAL_CONTROLLED'|'NATIVE'='LOCAL_CONTROLLED'){if(sha(row.canonical_config)!==row.config_digest)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Policy digest differs');let config:DistributionPolicyConfig;try{config=validateDistributionPolicy(JSON.parse(row.canonical_config),expectedScope);if(canonicalize(config)!==row.canonical_config)throw Error();}catch{throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Policy schema is not valid');}return{versionId:row.id,revision:String(row.revision),digest:row.config_digest,config,createdAt:new Date(row.created_at).toISOString()};}
/** Caller has verified its resource. Payment and relation writers may pin the immutable head. */
export async function readDistributionPolicyRowInTransaction(c:PoolClient,lockHead=false,policyScope:'LOCAL_CONTROLLED'|'NATIVE'=scope){if(policyScope!=='LOCAL_CONTROLLED'&&policyScope!=='NATIVE')throw invalid('Unsupported distribution policy scope');const row=(await c.query(`SELECT v.* FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version v ON v.id=h.current_version_id AND v.scope=h.scope AND v.revision=h.revision WHERE h.scope=$1${lockHead?' FOR SHARE OF h':''}`,[policyScope])).rows[0];return row?{knowledge:'KNOWN' as const,policy:decode(row,policyScope)}:{knowledge:'UNKNOWN' as const,policy:null,reason:'POLICY_NOT_CONFIGURED'};}
const read=readDistributionPolicyRowInTransaction;
export async function readDistributionPolicy(pool:Pool,actor:Actor,binding?:LocalDistributionScope,writeBinding?:LocalDistributionScope){return withTransaction(pool,async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const access=await authorize(c,actor);await resource(c,false,binding,false,true);const changeContext=await readDistributionChangeContext(c,actor.userId,access?.isBoss===true||access?.permissions.has('approval.request.read')===true,writeBinding!==undefined&&(nativeProofs.has(writeBinding)||localProofs.get(writeBinding)?.readOnly===false));return{...await read(c,false,distributionPolicyScopeOf(binding)),scope:distributionPolicyScopeOf(binding),...(changeContext.contractReady?{semanticsVersion:'distribution-policy.lifecycle.v2' as const}:{}),changeContext};});}
async function readDistributionChangeContext(c:PoolClient,adminId:string,canReadRequests:boolean,writeAssemblyReady:boolean){
 const marker=(await c.query("SELECT to_regclass('zzsh_iam.approval_request') IS NOT NULL AS requests_ready,to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS contract_ready")).rows[0];
 const base={schema:'distribution-policy-change-context.v1' as const,state:'UNAVAILABLE' as 'UNAVAILABLE'|'EMPTY'|'PENDING',request:null as null|{requestId:string;status:string;requestedBy:string;requesterName:string|null;createdAt:string;deciderName:string|null;decidedAt:string|null;expectedPolicyId:string|null;expectedRevision:string|null;expectedPolicyDigest:string|null;changes:unknown},contractReady:false,writeAssemblyReady,reasonCodes:[] as string[]};
 if(!marker?.requests_ready)return{...base,reasonCodes:['APPROVAL_REQUEST_SOURCE_UNAVAILABLE']};
 const contractReady=marker.contract_ready===true&&(await c.query('SELECT zzsh_order.distribution_policy_contract_version() AS version')).rows[0]?.version===2;
 const requests=(await c.query(`SELECT r.id,r.status,r.requested_by,r.operation_payload,u.name AS requester_name,d.name AS decider_name,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at FROM zzsh_iam.approval_request r LEFT JOIN zzsh_auth_admin."user" u ON u.id=r.requested_by LEFT JOIN zzsh_auth_admin."user" d ON d.id=r.decided_by WHERE r.operation_code='distribution.policy.publish' AND r.status IN ('PENDING','APPROVED','EXECUTION_FAILED') AND r.expires_at>clock_timestamp() ORDER BY r.created_at DESC,r.id COLLATE "C" DESC LIMIT 2`)).rows;
 if(requests.length>1)return{...base,contractReady,reasonCodes:['MULTIPLE_ACTIVE_DISTRIBUTION_REQUESTS']};
 if(!requests.length)return{...base,state:'EMPTY' as const,contractReady,reasonCodes:contractReady?[]:['UNIFORM_DISTRIBUTION_CONTRACT_NOT_INSTALLED']};
 const r=requests[0],p=r.operation_payload;const readable=canReadRequests||r.requested_by===adminId;
 return{...base,state:'PENDING' as const,contractReady,request:readable?{requestId:r.id,status:r.status,requestedBy:r.requested_by,requesterName:typeof r.requester_name==='string'?r.requester_name:null,createdAt:r.created_at,deciderName:typeof r.decider_name==='string'?r.decider_name:null,decidedAt:r.decided_at??null,initial:p?.schema==='distribution-policy-initialize.v1'||p?.schema==='distribution-policy-initialize.v2',expectedPolicyId:typeof p?.expectedPolicyId==='string'?p.expectedPolicyId:null,expectedRevision:typeof p?.expectedRevision==='string'?p.expectedRevision:null,expectedPolicyDigest:typeof p?.expectedPolicyDigest==='string'?p.expectedPolicyDigest:null,changes:p?.schema==='distribution-policy-initialize.v1'||p?.schema==='distribution-policy-initialize.v2'?p.config:p?.changes??null}:null,reasonCodes:readable?[]:['POLICY_CHANGE_DETAILS_FORBIDDEN']};
}
/** Domain-only current policy read; caller retains its own user/registration authorization. */
export async function readActiveDistributionPolicyInTransaction(c:PoolClient,lockHead=false,binding?:LocalDistributionScope){await resource(c,false,binding);return read(c,lockHead,distributionPolicyScopeOf(binding));}
/** Invitation reads do not require write admission; its capability still uses the original gate. */
export async function readInvitationPolicyInTransaction(c:PoolClient,binding?:LocalDistributionScope){
 if(!(await c.query("SELECT to_regclass('zzsh_order.distribution_policy_version') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AS complete")).rows[0]?.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution policy sources are not installed');
 const admitted=await resource(c,true,binding,false,true),writeResourceAdmitted=admitted&&(binding===undefined||nativeProofs.has(binding)||reviewedLocalNativeProofs.has(binding)||localProofs.get(binding)?.readOnly!==true);return{...await readDistributionPolicyRowInTransaction(c,false,distributionPolicyScopeOf(binding)),writeResourceAdmitted};
}
/** Registration remains available before distribution admission; policy reads/writes elsewhere stay strict. */
export async function readRegistrationDistributionPolicyInTransaction(c:PoolClient,binding?:LocalDistributionScope){
 if(!await resource(c,true,binding))return{knowledge:'UNKNOWN' as const,policy:null,reason:'DISTRIBUTION_RESOURCE_NOT_ADMITTED'};
 return read(c,true,distributionPolicyScopeOf(binding));
}
export async function configureDistributionPolicy(pool:Pool,actor:Actor,body:Record<string,unknown>,key:string,binding?:LocalDistributionScope){const policyScope=distributionPolicyScopeOf(binding);if(policyScope!=='LOCAL_CONTROLLED')throw forbidden('Native distribution policy requires approved execution');ensureOnlyFields(body,['expectedRevision','config','reason']);if(typeof body.expectedRevision!=='string'||!/^(0|[1-9]\d{0,18})$/.test(body.expectedRevision)||typeof body.reason!=='string'||body.reason.trim().length<3||body.reason.length>500||!body.config||typeof body.config!=='object'||Array.isArray(body.config))throw invalid('Exact revision, typed configuration and reason required');const config=validateDistributionPolicy(body.config as Record<string,unknown>),canonical=canonicalize(config),digest=sha(canonical);if(config.schema!=='distribution-policy.v1')throw forbidden('Uniform policy requires approved execution');return withTransaction(pool,async c=>{
 await authorize(c,actor,true);await resource(c,false,binding);return withIdempotency(c,{realm:'admin',principalId:actor.userId,operation:'distribution.policy.configure'},key,fingerprintRequest('distribution.policy.configure',policyScope,body),async()=>{await authorize(c,actor,true);},async()=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:'||$1,0))",[policyScope]);const head=(await c.query('SELECT revision::text,current_version_id FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[policyScope])).rows[0],before=head?head.revision:'0';if(before!==body.expectedRevision)throw conflict('Distribution policy changed; reload before saving');const revision=(BigInt(before)+1n).toString(),id='distribution_policy_'+sha(canonicalize([policyScope,revision,digest])).slice(0,40);
  await c.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,$2,$3,'distribution-policy.v1',$4,$5,$6)`,[id,revision,policyScope,canonical,digest,actor.userId]);if(head){const changed=await c.query('UPDATE zzsh_order.distribution_policy_head SET revision=$2,current_version_id=$3 WHERE scope=$1 AND revision=$4',[policyScope,revision,id,before]);if(changed.rowCount!==1)throw conflict('Policy head CAS failed');}else await c.query('INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES($1,$2,$3)',[policyScope,revision,id]);
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.policy.configured',objectType:'distribution_policy_version',objectId:id,outcome:'SUCCESS',reason:body.reason as string,details:{beforeRevision:before,revision,digest,scope:policyScope}});await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{status:200,body:await read(c,false,policyScope)};
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
export async function applyApprovedDistributionPolicyInTransaction(c:PoolClient,actor:Actor,input:DistributionPolicyUpdate,approval:{approvalRequestId:string;payloadHash:string},binding:LocalDistributionScope){
 await authorize(c,actor,true);await assertDistributionPolicyWriteReadyInTransaction(c,binding);const policyScope=distributionPolicyScopeOf(binding);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approval.approvalRequestId)||!/^[a-f0-9]{64}$/.test(approval.payloadHash))throw conflict('Approved distribution reference invalid');
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:'||$1,0))",[policyScope]);
 const head=(await c.query('SELECT revision::text,current_version_id FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[policyScope])).rows[0];
 if(!head||head.revision!==input.expectedRevision||head.current_version_id!==input.expectedPolicyId)throw conflict('Distribution policy changed; approved baseline is stale');
 const previous=await read(c,false,policyScope);if(previous.knowledge!=='KNOWN')throw conflict('Original distribution policy unavailable');
 const config=prepareDistributionPolicyChange(previous.policy,input),canonical=canonicalize(config),digest=sha(canonical),revision=(BigInt(input.expectedRevision)+1n).toString(),id='distribution_policy_'+sha(canonicalize([policyScope,revision,digest])).slice(0,40);
 await c.query('INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,revision,policyScope,config.schema,canonical,digest,actor.userId]);
 const changed=await c.query('UPDATE zzsh_order.distribution_policy_head SET revision=$2,current_version_id=$3 WHERE scope=$1 AND revision=$4',[policyScope,revision,id,input.expectedRevision]);if(changed.rowCount!==1)throw conflict('Policy head CAS failed');
 await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.policy.approved_executed',objectType:'distribution_policy_version',objectId:id,outcome:'SUCCESS',reason:input.reason,details:{approvalRequestId:approval.approvalRequestId,approvedPayloadHash:approval.payloadHash,beforePolicyId:previous.policy.versionId,beforeRevision:input.expectedRevision,revision,digest,scope:policyScope}});
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');const result=await read(c,false,policyScope);if(result.knowledge!=='KNOWN'||result.policy.versionId!==id)throw conflict('Approved policy readback mismatch');return result;
}

/** Approved first version only. It never reuses a fabricated expected head/revision. */
export async function initializeApprovedDistributionPolicyInTransaction(c:PoolClient,actor:Actor,input:DistributionPolicyInitial,approval:{approvalRequestId:string;payloadHash:string},binding:LocalDistributionScope){
 await authorize(c,actor,true);await assertDistributionPolicyWriteReadyInTransaction(c,binding);const policyScope=distributionPolicyScopeOf(binding);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approval.approvalRequestId)||!/^[a-f0-9]{64}$/.test(approval.payloadHash))throw conflict('Approved distribution reference invalid');
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:'||$1,0))",[policyScope]);
 const head=(await c.query('SELECT revision::text,current_version_id FROM zzsh_order.distribution_policy_head WHERE scope=$1 FOR UPDATE',[policyScope])).rows[0];
 if(head)throw conflict('Distribution policy already exists; use the update contract');
 const config=initialDistributionPolicyConfig(input,policyScope),canonical=canonicalize(config),digest=sha(canonical),id='distribution_policy_'+sha(canonicalize([policyScope,'1',digest])).slice(0,40);
 await c.query('INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,1,$2,$3,$4,$5,$6)',[id,policyScope,config.schema,canonical,digest,actor.userId]);
 await c.query('INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES($1,1,$2)',[policyScope,id]);
 await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'distribution.policy.approved_initialized',objectType:'distribution_policy_version',objectId:id,outcome:'SUCCESS',reason:input.reason,details:{approvalRequestId:approval.approvalRequestId,approvedPayloadHash:approval.payloadHash,revision:'1',digest,scope:policyScope}});
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');const result=await read(c,false,policyScope);if(result.knowledge!=='KNOWN'||result.policy.versionId!==id)throw conflict('Initial policy readback mismatch');return result;
}
