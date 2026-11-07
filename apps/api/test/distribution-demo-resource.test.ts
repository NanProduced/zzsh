import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { createLocalDemoCloneResource, readEcsTestDemoRegistration, verifyLocalDemoCloneProof } from '../src/finance/ecs-test-demo-resource';
import { assertLocalDistributionAssembly, createDemoNativeDistributionScope, distributionPolicyScopeOf, readInvitationPolicyInTransaction } from '../src/finance/distribution-policy-store';
import { assertDistributionManagementAssembly, assertDistributionManagementResource, createDemoDistributionManagementResource } from '../src/finance/distribution-management-resource';

function fixture() {
 const doc={schema:'zzsh.r07-demo-clone-restored.v1',status:'RESTORED_AND_VERIFIED',
  verification:{sameExportedSnapshot:true,dataSummaryMatched:true,keySetsMatched:true,objectAclMatched:true,roleSecurityMatchedWithDeclaredExceptions:true,rlsAndDefinerMatched:true,runtimeAccessTested:true,sourceWrites:0,intentionalExceptions:[{code:'OWNER_DEPRIVILEGED',role:'zzsh'},{code:'DATABASE_EPOCH_CHANGED'}]},
  source:{database:'zzsh_test_regression',oid:'16390',marker:'zzsh:regression-test:v1',systemIdentifier:'7704972584346443810',archiveSha256:'a'.repeat(64),aclSha256:'b'.repeat(64)},
  target:{database:'zzsh_test_r07_delivery_20261108',oid:'411',marker:'zzsh:r07-delivery-clone:v1',systemIdentifier:'7705473419326033954',host:'127.0.0.1',port:55434,nonce:'1234567890abcdef',owner:{name:'zzsh',oid:'222'},migration:{name:'zzsh_regression_migration',oid:'223'},runtime:{name:'zzsh_regression_runtime',oid:'333'}}};
 const bytes=Buffer.from(JSON.stringify(doc)),proof=verifyLocalDemoCloneProof(bytes,createHash('sha256').update(bytes).digest('hex'));
 const config={profile:'dev',provider:'fake',testOperationsEnabled:false,host:'127.0.0.1',port:4232,database:{target:'local-compose',targetProfile:'dev',host:'127.0.0.1',port:55434,name:doc.target.database,user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}} as Parameters<typeof createLocalDemoCloneResource>[0]['config'];
 const env={APP_PROFILE:'dev',NODE_ENV:'development',LOCAL_DEMO_CLONE_FINANCE_ENABLED:'true',JOINPAY_COLLECTION_ENABLED:'false',JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false'};
 const origins={apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231',secureCookies:false};
 const demo=createLocalDemoCloneResource({config,env,origins,proof,reference:'fixture',administratorId:'synthetic_admin'});
 return {demo,origins,doc};
}

test('demo distribution and management accept only the exact branded bundle and no real channel',()=>{
 const {demo,origins}=fixture(),scope=createDemoNativeDistributionScope(demo),management=createDemoDistributionManagementResource(demo,scope);
 const options={...origins,testOperationsEnabled:false,distributionScope:scope,ecsTestDemo:{demo}};
 assert.equal(distributionPolicyScopeOf(scope),'NATIVE');
 assert.doesNotThrow(()=>assertLocalDistributionAssembly(scope,options));
 assert.doesNotThrow(()=>assertDistributionManagementAssembly(management,scope,options));
 const other=fixture().demo;
 assert.throws(()=>createDemoNativeDistributionScope({...demo}));
 assert.throws(()=>createDemoDistributionManagementResource(other,scope));
 assert.throws(()=>assertLocalDistributionAssembly(scope,{...options,ecsTestDemo:{demo:other}}));
 assert.throws(()=>assertLocalDistributionAssembly(scope,{...options,joinpayCollection:{}}));
 assert.throws(()=>assertLocalDistributionAssembly(scope,{...options,userOrigin:'http://127.0.0.1:9999'}));
 assert.throws(()=>assertDistributionManagementAssembly(management,scope,{...options,distributionScope:undefined}));
 assert.throws(()=>assertDistributionManagementAssembly({...management},scope,options));
});

test('demo policy and management reads verify the clone while writes lock its active registration',async()=>{
 const {demo,origins,doc}=fixture(),scope=createDemoNativeDistributionScope(demo),management=createDemoDistributionManagementResource(demo,scope),proof=readEcsTestDemoRegistration(demo),calls:string[]=[];
 let tx='on',active=true;
 const client={getTransactionStatus:()=> 'T',connectionParameters:{host:'127.0.0.1',port:55434,database:doc.target.database,user:'zzsh_regression_runtime'},query:async(sql:string,args?:unknown[])=>{
  calls.push(sql);
  if(sql.includes("current_setting('transaction_read_only') AS state"))return{rows:[{state:tx}]};
  if(sql.startsWith('SELECT set_config'))return{rows:[]};
  if(sql.includes('AS "databaseName"'))return{rows:[{databaseName:doc.target.database,currentUser:'zzsh_regression_runtime',owner:'zzsh',isSuperuser:false,canCreateRole:false,canCreateDb:false,canReplicate:false,canBypassRls:false,canCreateDatabase:false,canCreateIamSchema:false,canCreateUserSchema:false,canCreateAdminSchema:false,canCreateSupplySchema:false,canCreateContentSchema:false,canCreateOrderSchema:false,canUpdateAudit:false,canDeleteAudit:false,canTruncateAudit:false}]};
  if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false}]};
  if(sql.includes('FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=$1 FOR SHARE'))return{rows:[{canonical_registration:proof.canonical,registration_digest:proof.digest,active,demo_xid:'100'}]};
  if(sql.includes('AS database_oid'))return{rows:[{database:doc.target.database,database_oid:'411',system_identifier:doc.target.systemIdentifier,marker:doc.target.marker,owner:'zzsh',owner_oid:'222',owner_super:false,owner_bypass:false,owner_createrole:false,owner_createdb:false,owner_replication:false,owner_login:false,owner_has_membership:false,runtime_role:'zzsh_regression_runtime',runtime_role_oid:'333',clone_nonce:doc.target.nonce,migration_role_oid:'223',schema_owner:'zzsh_regression_migration',migration_super:false,migration_bypass:false,migration_createrole:false,migration_createdb:false,migration_replication:false,migration_has_membership:false,rolsuper:false,rolbypassrls:false,runtime_owns_business_routine:false,canonical_registration:proof.canonical,registration_digest:proof.digest,active,demo_xid:'100'}]};
  if(sql.includes("to_regclass('zzsh_order.distribution_policy_version')"))return{rows:[sql.includes('AS complete')?{complete:true}:{ready:true}]};
  if(sql.includes('SELECT v.* FROM zzsh_order.distribution_policy_head')){assert.equal(args?.[0],'NATIVE');return{rows:[]};}
  if(sql.includes("to_regprocedure('zzsh_order.distribution_management_contract_version()')"))return{rows:[{ready:true}]};
  if(sql.includes('SELECT zzsh_order.distribution_management_contract_version()'))return{rows:[{version:1}]};
  if(sql.includes('AS audit_insert'))return{rows:[{audit_insert:true,idempotency:true,policy_insert:true,head_update:true,participant_update:true,code_insert:true,code_update:true}]};
  throw Error('unexpected synthetic query');
 }} as unknown as PoolClient;
 assert.equal((await readInvitationPolicyInTransaction(client,scope)).knowledge,'UNKNOWN');
 assert(!calls.some(sql=>sql.includes('FOR SHARE')),'read-only policy reads never take a write lease');
 await assertDistributionManagementResource(client,management);
 tx='off';calls.length=0;await assertDistributionManagementResource(client,management,'WRITE');
 assert(calls.some(sql=>sql.includes('FOR SHARE')),'management write locks its exact demo registration');
 active=false;await assert.rejects(assertDistributionManagementResource(client,management,'WRITE'),{status:503});
  tx='on';assert.equal(await assertDistributionManagementResource(client,management),false,'inactive registration stays readable but is not write-ready');
 assert.doesNotThrow(()=>assertDistributionManagementAssembly(management,scope,{...origins,testOperationsEnabled:false,distributionScope:scope,ecsTestDemo:{demo}}));
});
