import {createHash} from 'node:crypto';import type {PoolClient} from 'pg';import {canonicalize} from '../supply/content-hash';import {conflict,invalid} from '../supply/supply-util';
import {readFormalCollectionAdmission,type FormalCollectionAdmission} from '../order/joinpay-collection-profile';
import {assertBusinessRuntimeIdentity} from '../database/business';
import {type AppConfig,ConfigurationError} from '../config/config';
import {REGRESSION_DATABASE,REGRESSION_MARKER,REGRESSION_RUNTIME_USER} from '../config/test-resource';
export type NativeOriginResource=Readonly<{resourceSet:string;resourceOid:number}>|Readonly<{kind:'NATIVE_WALLET_ORIGIN'|'CONTROLLED_NATIVE_WALLET_ORIGIN'|'PROVISIONED_NATIVE_WALLET_ORIGIN'}>;
const formalOrigins=new WeakMap<NativeOriginResource,{admission:FormalCollectionAdmission;database:string;runtimeUser:string}>();
const controlledOrigins=new WeakMap<NativeOriginResource,{oid:number;nonce:string;runtimeRoleOid:number}>();
const provisionedOrigins=new WeakMap<NativeOriginResource,{database:string;runtimeUser:string}>();
/** Validated application configuration, not merchant authority. SQL still requires the owner's current exact admission row. */
export function createProvisionedNativeWalletOriginResource(config:AppConfig):NativeOriginResource{
 if(!['dev','ecs-test','production'].includes(config.profile)||config.database.targetProfile!==config.profile
  ||config.database.user!==config.database.runtimeUser||![config.database.name,config.database.user].every(v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(v))
  ||/^zzsh_(?:test|provider_test)(?:_|$)/.test(config.database.name)||config.database.user===REGRESSION_RUNTIME_USER)
  throw new ConfigurationError('Provisioned native origin requires a validated non-test application runtime');
 const resource=Object.freeze({kind:'PROVISIONED_NATIVE_WALLET_ORIGIN' as const});
 provisionedOrigins.set(resource,{database:config.database.name,runtimeUser:config.database.runtimeUser});return resource;
}
/** Internal local regression authority only; an actual immutable owner admission row remains required. */
export function createControlledNativeWalletOriginResource(input:{config:AppConfig;resourceOid:number;nonce:string;runtimeRoleOid:number}):NativeOriginResource{
 const c=input.config;
 if(c.profile!=='test'||c.provider!=='fake'||!c.testOperationsEnabled||process.env.NODE_ENV==='production'
  ||c.database.target!=='local-compose'||c.database.targetProfile!=='test'||c.database.host!=='127.0.0.1'||c.database.port!==55432
  ||c.database.name!==REGRESSION_DATABASE||c.database.user!==REGRESSION_RUNTIME_USER||c.database.runtimeUser!==REGRESSION_RUNTIME_USER
  ||!Number.isSafeInteger(input.resourceOid)||input.resourceOid<=0||!Number.isSafeInteger(input.runtimeRoleOid)||input.runtimeRoleOid<=0||!/^[a-f0-9]{24}$/.test(input.nonce))
  throw new ConfigurationError('Controlled native origin requires the exact test/fake regression resource');
 const resource=Object.freeze({kind:'CONTROLLED_NATIVE_WALLET_ORIGIN' as const});controlledOrigins.set(resource,{oid:input.resourceOid,nonce:input.nonce,runtimeRoleOid:input.runtimeRoleOid});return resource;
}
/** Resource proof only; the database owner must separately provision the exact native-origin admission row. */
export function createNativeWalletOriginResource(admission:FormalCollectionAdmission):NativeOriginResource{
 const view=readFormalCollectionAdmission(admission),resource=Object.freeze({kind:'NATIVE_WALLET_ORIGIN' as const});
 formalOrigins.set(resource,{admission,database:view.database,runtimeUser:view.runtimeUser});return resource;
}
export function assertNativeWalletOriginAssembly(resource:NativeOriginResource|undefined,admission:FormalCollectionAdmission|undefined):boolean{
 if(resource&&controlledOrigins.has(resource)){if(admission!==undefined||process.env.NODE_ENV==='production')throw invalid('Controlled native origin cannot cross formal/production assembly');return false;}
 const provisioned=resource&&provisionedOrigins.get(resource);
 if(provisioned){if(admission!==undefined){const view=readFormalCollectionAdmission(admission);if(view.database!==provisioned.database||view.runtimeUser!==provisioned.runtimeUser)throw invalid('Provisioned native origin admission is cross-wired');}return false;}
 const formal=resource&&formalOrigins.get(resource);if(!formal)return false;
 if(formal.admission!==admission)throw invalid('Native wallet origin admission is cross-wired');return true;
}
const marker='zzsh:order-reservation-test:v1';
/** New-user registration transaction only. Explicit assembly resource; no environment fallback.
 * An uninstalled template or a resource that does not match the assembly stays UNKNOWN and never
 * reports a fabricated zero. Only the 0066 structured missing-admission result is UNKNOWN;
 * every other database-side failure propagates and aborts the registration transaction. */
export async function initializeNativeWalletOrigin(c:PoolClient,userId:string,requestId:string,resource?:NativeOriginResource){
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)||!requestId)throw invalid('Original registration subject/request required');
 const row=(await c.query("SELECT to_regprocedure('zzsh_order.initialize_native_wallet_origin(text,text,text,text)') IS NOT NULL AND to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS installed,d.oid,current_database() AS name,current_user AS role,(SELECT oid FROM pg_roles WHERE rolname=current_user) AS role_oid,current_setting('zzsh.regression_run',true) AS nonce,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE datname=current_database()")).rows[0];
 if(!row?.installed)return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_TEMPLATE_NOT_INSTALLED'};
 const formal=resource&&formalOrigins.get(resource);
 const controlled=resource&&controlledOrigins.get(resource);
 const provisioned=resource&&provisionedOrigins.get(resource);
 const admitted=formal?row.name===formal.database&&row.role===formal.runtimeUser
  :controlled?process.env.NODE_ENV!=='production'&&Number(row.oid)===controlled.oid&&row.name===REGRESSION_DATABASE&&row.role===REGRESSION_RUNTIME_USER
    &&Number(row.role_oid)===controlled.runtimeRoleOid&&row.marker===REGRESSION_MARKER&&row.nonce===controlled.nonce
  :provisioned?row.name===provisioned.database&&row.role===provisioned.runtimeUser
  :resource&&'resourceSet'in resource&&/^[a-z][a-z0-9_]{0,20}$/.test(resource.resourceSet)&&Number.isSafeInteger(resource.resourceOid)&&resource.resourceOid>0
    &&Number(row.oid)===resource.resourceOid&&row.name===`zzsh_test_order_${resource.resourceSet}`&&row.role===`zzsh_order_${resource.resourceSet}_r`&&row.marker===marker;
 if(!admitted)return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'};
 if(formal||controlled||provisioned)await assertBusinessRuntimeIdentity(c,{database:{name:row.name,user:row.role,runtimeUser:row.role}});
 const proof=(await c.query(`SELECT u.id,s.version::text AS identity_version,p.insert_xid::text AS insertion_xid
 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
 JOIN zzsh_order.native_user_insert_proof p ON p.user_id=u.id
 WHERE u.id=$1 AND NOT u.suspended AND s.account_status='ACTIVE' AND s.provider='none'
 AND p.insert_xid=pg_current_xact_id()
 AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=u.id
  AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS')`,[userId])).rows[0];
 if(!proof)throw conflict('Only a proved fresh native user INSERT can initialize wallet origin');
 const source=canonicalize({schema:'native-wallet-origin.v2',userId,insertionXid:proof.insertion_xid,identityVersion:proof.identity_version}),digest=createHash('sha256').update(source).digest('hex');
 const result=(await c.query('SELECT zzsh_order.initialize_native_wallet_origin($1,$2,$3,$4) AS result',[userId,source,digest,requestId])).rows[0]?.result;
 // The 0066 contract defines exactly one structured UNKNOWN (missing admission row); every other
 // non-KNOWN shape or template error is rejected so the registration transaction rolls back.
 if(result&&typeof result==='object'&&Object.keys(result).sort().join(',')==='knowledge,reason'&&result.knowledge==='UNKNOWN'&&result.reason==='NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED')return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'};
 if(result?.knowledge!=='KNOWN'||result?.origin!=='NATIVE_GENESIS'||result?.availableCents!=='0'||result?.reason!==undefined)throw conflict('Native origin initialization result is not verified');return result;
}
