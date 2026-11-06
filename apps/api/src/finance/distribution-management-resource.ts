import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {type AppConfig,ConfigurationError} from '../config/config';
import {REGRESSION_DATABASE,REGRESSION_MARKER,REGRESSION_MIGRATION_USER,REGRESSION_RUNTIME_USER} from '../config/test-resource';
import {assertBusinessRuntimeIdentity} from '../database/business';
import {SecurityApiError} from '../auth/security-core';
import {assertLocalNativeDistributionReadOnlyAssembly,assertRegisteredLocalNativeDistributionReadBinding,assertRegisteredLocalNativeDistributionReadResource,isRegisteredLocalNativeDistributionReadScope,type LocalDistributionScope,type RegisteredLocalNativeDistributionBinding} from './distribution-policy-store';

export type DistributionManagementResource=Readonly<{kind:'PROVISIONED_DISTRIBUTION_MANAGEMENT'|'REGISTERED_R06_DISTRIBUTION_MANAGEMENT_PREVIEW'}>;
type Proof={kind:'PROVISIONED';database:string;runtimeUser:string}|{kind:'R06_PREVIEW';readScope:LocalDistributionScope};
const resources=new WeakMap<DistributionManagementResource,Proof>();
type Origins={apiOrigin:string;userOrigin:string;adminOrigin:string;secureCookies:boolean};
type R06SwapProof={bytes:Uint8Array;sha256:string};

function assertR06SwapProof(proof:R06SwapProof,binding:RegisteredLocalNativeDistributionBinding){
 const invalid=()=>{throw new ConfigurationError('R06_DISTRIBUTION_MANAGEMENT_SWAP_PROOF_INVALID');};
 if(!(proof?.bytes instanceof Uint8Array)||proof.bytes.length<2||proof.bytes.length>1024*1024||typeof proof.sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.sha256)
  ||createHash('sha256').update(proof.bytes).digest('hex')!==proof.sha256)invalid();
 let swap:any;try{swap=JSON.parse(Buffer.from(proof.bytes).toString('utf8'));}catch{invalid();}
 const target=swap?.targetIdentity,oid=(value:unknown,expected:number)=>/^[1-9]\d{0,9}$/.test(String(value??''))&&Number(value)===expected;
 if(swap?.status!=='COMMIT_ACK'||swap.commitAck!==true||swap.registrationAck!==true||swap.unlockAck!==true||swap.maintenanceClosed!==true
  ||target?.read_only!=='on'||target.rollbackAck!==true||target.clientClosed!==true||target.database!==binding.database||target.marker!==binding.marker
  ||target.nonce!==binding.nonce||target.owner!==binding.owner||target.migrationRole!==binding.migrationRole||target.runtimeRole!==binding.runtimeRole
  ||!oid(target.oid,binding.resourceOid)||!oid(swap.stageOid,binding.resourceOid)||!oid(target.ownerOid,binding.ownerOid)
  ||!oid(target.migrationRoleOid,binding.migrationRoleOid)||!oid(target.runtimeRoleOid,binding.runtimeRoleOid))invalid();
}

/** Uses the application's non-test runtime identity. No payment/merchant capability is acquired. */
export function createProvisionedDistributionManagementResource(config:AppConfig):DistributionManagementResource{
 if(!['dev','ecs-test','production'].includes(config.profile)||config.database.targetProfile!==config.profile
  ||config.database.user!==config.database.runtimeUser||![config.database.name,config.database.user].every(v=>/^[a-z][a-z0-9_]{0,62}$/.test(v))
  ||/^zzsh_(?:test|provider_test)(?:_|$)/.test(config.database.name)||config.database.user===REGRESSION_RUNTIME_USER)
  throw new ConfigurationError('Distribution management requires a validated non-test application runtime');
 const value=Object.freeze({kind:'PROVISIONED_DISTRIBUTION_MANAGEMENT' as const});
 resources.set(value,{kind:'PROVISIONED',database:config.database.name,runtimeUser:config.database.runtimeUser});return value;
}

/** Explicit local preview only. The binding must come from the verified R06 registry + swap receipt. */
export function createRegisteredR06DistributionManagementPreview(input:{enabled?:boolean;config:AppConfig;binding:RegisteredLocalNativeDistributionBinding;readScope:LocalDistributionScope;origins:Origins;swapProof:R06SwapProof}):DistributionManagementResource|undefined{
 if(input.enabled===undefined||input.enabled===false)return undefined;
 if(input.enabled!==true)throw new ConfigurationError('R06_DISTRIBUTION_MANAGEMENT_PREVIEW_FLAG_INVALID');
 const {config,binding,readScope,origins}=input;
 if(process.env.NODE_ENV==='production'||config.profile!=='test'||config.provider!=='fake'||config.testOperationsEnabled
  ||config.host!=='127.0.0.1'||config.port!==4232||config.database.target!=='local-compose'||config.database.targetProfile!=='test'
  ||config.database.host!=='127.0.0.1'||config.database.port!==55432||config.database.name!==REGRESSION_DATABASE
  ||config.database.user!==REGRESSION_RUNTIME_USER||config.database.runtimeUser!==REGRESSION_RUNTIME_USER
  ||binding.database!==REGRESSION_DATABASE||binding.marker!==REGRESSION_MARKER||binding.owner!=='zzsh'
  ||binding.runtimeRole!==REGRESSION_RUNTIME_USER||binding.migrationRole!==REGRESSION_MIGRATION_USER
  ||origins.secureCookies!==false||origins.apiOrigin!=='http://127.0.0.1:4232'
  ||origins.userOrigin!=='http://127.0.0.1:4230'||origins.adminOrigin!=='http://127.0.0.1:4231')
  throw new ConfigurationError('R06_DISTRIBUTION_MANAGEMENT_PREVIEW_CONTEXT_INVALID');
 assertRegisteredLocalNativeDistributionReadBinding(readScope,binding);
 assertR06SwapProof(input.swapProof,binding);
 const value=Object.freeze({kind:'REGISTERED_R06_DISTRIBUTION_MANAGEMENT_PREVIEW' as const});
 resources.set(value,{kind:'R06_PREVIEW',readScope});return value;
}

/** This capability is separate from the NATIVE policy/payment/registration scopes. */
export function assertDistributionManagementAssembly(resource:DistributionManagementResource|undefined,readScope:LocalDistributionScope|undefined,options:Origins&{
 testOperationsEnabled:boolean;distributionScope?:LocalDistributionScope;settlementRecordingEnabled?:boolean;distributionEarnings?:unknown;
 joinpayCollection?:unknown;joinpayRefund?:unknown;joinpayWithdrawal?:unknown;joinpayAccountRead?:unknown;joinpayAccountObservation?:unknown;
 localControlledPayments?:unknown;localFinancialSandbox?:unknown;nativeWithdrawalScope?:unknown;distributionDue?:unknown;
}):void{
 if(resource===undefined)return;
 const proof=resources.get(resource);if(!proof)throw new ConfigurationError('DISTRIBUTION_MANAGEMENT_ASSEMBLY_INVALID');
 if(proof.kind==='PROVISIONED'){
  if(isRegisteredLocalNativeDistributionReadScope(readScope))throw new ConfigurationError('R06_DISTRIBUTION_MANAGEMENT_PREVIEW_REQUIRED');
  return;
 }
 if(process.env.NODE_ENV==='production'||readScope!==proof.readScope||options.apiOrigin!=='http://127.0.0.1:4232'
  ||options.userOrigin!=='http://127.0.0.1:4230'||options.adminOrigin!=='http://127.0.0.1:4231'||options.secureCookies!==false)
  throw new ConfigurationError('R06_DISTRIBUTION_MANAGEMENT_PREVIEW_ASSEMBLY_INVALID');
 assertLocalNativeDistributionReadOnlyAssembly(readScope,options.distributionScope,options);
}
export async function assertDistributionManagementResource(c:PoolClient,resource?:DistributionManagementResource){
 const proof=resource&&resources.get(resource);
 if(!proof)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution management write resource is not assembled');
 if(proof.kind==='R06_PREVIEW')await assertRegisteredLocalNativeDistributionReadResource(c,proof.readScope);
 else await assertBusinessRuntimeIdentity(c,{database:{name:proof.database,user:proof.runtimeUser,runtimeUser:proof.runtimeUser}});
 const row=(await c.query("SELECT to_regprocedure('zzsh_order.distribution_management_contract_version()') IS NOT NULL AS ready")).rows[0];
 if(row?.ready!==true||(await c.query('SELECT zzsh_order.distribution_management_contract_version() AS version')).rows[0]?.version!==1)
  throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution management schema not installed');
 const privileges=(await c.query(`SELECT
  has_table_privilege(current_user,'zzsh_iam.audit_event','INSERT') AS audit_insert,
  has_table_privilege(current_user,'zzsh_supply.idempotency_record','SELECT') AND has_table_privilege(current_user,'zzsh_supply.idempotency_record','INSERT') AND has_any_column_privilege(current_user,'zzsh_supply.idempotency_record','UPDATE') AS idempotency,
  (SELECT bool_and(has_column_privilege(current_user,'zzsh_order.distribution_policy_version',name,'INSERT')) FROM unnest(ARRAY['id','revision','scope','schema_version','canonical_config','config_digest','created_by_admin_id']) name) AS policy_insert,
  (SELECT bool_and(has_column_privilege(current_user,'zzsh_order.distribution_policy_head',name,'UPDATE')) FROM unnest(ARRAY['revision','current_version_id']) name) AS head_update,
  (SELECT bool_and(has_column_privilege(current_user,'zzsh_order.distribution_participant',name,'UPDATE')) FROM unnest(ARRAY['level_code','policy_version_id','revision']) name) AS participant_update,
  (SELECT bool_and(has_column_privilege(current_user,'zzsh_order.distribution_invite_code',name,'INSERT')) FROM unnest(ARRAY['id','user_id','display_code','source_type','source_system','source_entity','source_id','source_digest']) name) AS code_insert,
  has_column_privilege(current_user,'zzsh_order.distribution_invite_code','active','UPDATE') AS code_update`)).rows[0];
 if(!privileges||Object.values(privileges).some(value=>value!==true))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution management runtime grants are incomplete');
}
