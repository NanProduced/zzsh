import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { AppConfig } from '../src/config/config';
import { createControlledRegressionResource } from '../src/finance/controlled-regression-resource';
import { assertDistributionPolicyWriteReadyInTransaction, createReviewedLocalNativeDistributionScope } from '../src/finance/distribution-policy-store';

const nonce='a'.repeat(24),instance={host:'127.0.0.1' as const,port:55433 as const,systemIdentifier:'7704972584346443810'};
const config=(port:number)=>({profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port,name:'zzsh_test_regression',user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}} as AppConfig);
const proof=(port:number)=>createControlledRegressionResource(config(port),{resourceOid:123,nonce,runtimeRoleOid:456},'DISTRIBUTION');
function client(change:{host?:string;port?:number;database?:string;user?:string;role?:string;oid?:number;roleOid?:number;nonce?:string;marker?:string;cluster?:string;owner?:string;ownerOid?:number}={}){
 const connectionParameters={host:change.host??'127.0.0.1',port:change.port??55433,database:change.database??'zzsh_test_regression',user:change.user??'zzsh_regression_runtime'};
 const role='zzsh_regression_runtime',safe={databaseName:'zzsh_test_regression',currentUser:role,owner:'zzsh',isSuperuser:false,canCreateRole:false,canCreateDb:false,canReplicate:false,canBypassRls:false,canCreateDatabase:false,canCreateIamSchema:false,canCreateUserSchema:false,canCreateAdminSchema:false,canCreateSupplySchema:false,canCreateContentSchema:false,canCreateOrderSchema:false,canUpdateAudit:false,canDeleteAudit:false,canTruncateAudit:false};
 return {connectionParameters,getTransactionStatus:()=> 'T',query:async(sql:string)=>{
  if(sql.includes('AS "databaseName"'))return {rows:[safe]};
  if(sql.includes('AS "ownsBusinessSchema"'))return {rows:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false}]};
  if(sql.includes('AS "systemIdentifier"'))return {rows:[{oid:change.oid??123,name:'zzsh_test_regression',role:change.role??role,role_oid:change.roleOid??456,nonce:change.nonce??nonce,marker:change.marker??'zzsh:regression-test:v1',systemIdentifier:change.cluster??instance.systemIdentifier}]};
  if(sql.includes('system_identifier::text'))return {rows:[{system_identifier:change.cluster??instance.systemIdentifier}]};
  if(sql.includes('AS "ownerOid"'))return {rows:[{owner:change.owner??'zzsh',ownerOid:change.ownerOid??200,complete:true}]};
  if(sql.includes("to_regprocedure('zzsh_order.distribution_policy_contract_version()')"))return {rows:[{ready:true}]};
  if(sql.includes('distribution_policy_contract_version() AS version'))return {rows:[{version:2}]};
  return {rows:[{oid:change.oid??123,name:'zzsh_test_regression',role:change.role??role,role_oid:change.roleOid??456,nonce:change.nonce??nonce,marker:change.marker??'zzsh:regression-test:v1'}]};
 }} as unknown as PoolClient;
}

test('R07 reviewed distribution binds exact host, port, cluster and existing role/owner proof',async()=>{
 const scope=createReviewedLocalNativeDistributionScope(proof(55433),{owner:'zzsh',ownerOid:200,instance});
 await assert.doesNotReject(assertDistributionPolicyWriteReadyInTransaction(client(),scope));
 for(const changed of [{host:'localhost'},{port:55432},{database:'other'},{user:'other'},{role:'other'},{oid:124},{roleOid:457},{nonce:'b'.repeat(24)},{marker:'other'},{cluster:'999'},{owner:'other'},{ownerOid:201}])
  await assert.rejects(assertDistributionPolicyWriteReadyInTransaction(client(changed),scope));
});

test('R06 default remains restricted to 55432, and caller mutation cannot change an R07 binding',async()=>{
 const old=createReviewedLocalNativeDistributionScope(proof(55432),{owner:'zzsh',ownerOid:200});
 await assert.doesNotReject(assertDistributionPolicyWriteReadyInTransaction(client({port:55432}),old));
 await assert.rejects(assertDistributionPolicyWriteReadyInTransaction(client(),old));
 const mutable={...instance},newScope=createReviewedLocalNativeDistributionScope(proof(55433),{owner:'zzsh',ownerOid:200,instance:mutable});mutable.systemIdentifier='999';
 await assert.doesNotReject(assertDistributionPolicyWriteReadyInTransaction(client(),newScope));
 assert.throws(()=>createReviewedLocalNativeDistributionScope(proof(55433),{owner:'zzsh',ownerOid:200,instance:{...instance,systemIdentifier:''}}));
});

test('next-round distribution scope requires a branded instance and cannot grant another purpose',async()=>{
 const next={host:'127.0.0.1' as const,port:55435,systemIdentifier:instance.systemIdentifier,migrationProfile:'LOCAL_MIGRATION_NEXT_V1' as const};
 const binding={resourceOid:123,nonce,runtimeRoleOid:456,migrationInstance:next};
 const registered=createControlledRegressionResource(config(next.port),binding,'DISTRIBUTION');
 const scope=createReviewedLocalNativeDistributionScope(registered,{owner:'zzsh',ownerOid:200,instance:next});
 await assert.doesNotReject(assertDistributionPolicyWriteReadyInTransaction(client({port:55435}),scope));
 for(const change of [{port:55433},{cluster:'999'},{oid:124},{nonce:'b'.repeat(24)},{roleOid:457}])
  await assert.rejects(assertDistributionPolicyWriteReadyInTransaction(client({port:55435,...change}),scope));
 assert.throws(()=>createControlledRegressionResource(config(next.port),binding,'WITHDRAWAL'));
 assert.throws(()=>createControlledRegressionResource(config(next.port),{...binding,migrationInstance:{...next,systemIdentifier:123 as any}},'DISTRIBUTION'));
 assert.throws(()=>createControlledRegressionResource(config(next.port),{resourceOid:123,nonce,runtimeRoleOid:456},'DISTRIBUTION'));
 assert.throws(()=>createReviewedLocalNativeDistributionScope(registered,{owner:'zzsh',ownerOid:200,instance:{...next,systemIdentifier:'999'}}));
 assert.throws(()=>createReviewedLocalNativeDistributionScope({kind:'CONTROLLED_REGRESSION_RESOURCE'},{owner:'zzsh',ownerOid:200,instance:next}));
});
