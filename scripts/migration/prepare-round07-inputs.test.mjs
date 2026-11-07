import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeRegisteredTarget } from './local-target-registry.mjs';
import { assertR07AssemblyRuntime, makeR07AdminInput, makeR07Target } from './prepare-round07-inputs.mjs';

const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},nonce='a'.repeat(24),hash='b'.repeat(64);
const registry=normalizeRegisteredTarget({database:'zzsh_test_regression',oid:'123',nonce,owner:'zzsh',marker:'zzsh:regression-test:v1',instance,
 roles:{migration:{name:'migration',oid:'790'},runtime:{name:'runtime',oid:'789'}},
 protectedDataset:{status:'ROUND07_BOOTSTRAP_RESERVED',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',manifestSha256:hash,epoch:{oid:'123',nonce}}});
const schema={status:'CLEAN_SCHEMA_INSTALLED',oid:'123',nonce,instance,finalOrdinal:160,commitAck:true,migrationAck:true,runtimeAclReadback:true,
 hashes:[hash],journalSha256:hash,historySha256:hash,readbackRollbackAck:true,readbackClientClosed:true,unlockAck:true,maintenanceClosed:true};
const target=makeR07Target(registry,schema),resource={database:target.database,oid:target.oid,resourceOid:target.oid,nonce,instance};
const binding={status:'R07_BOOTSTRAP_API_LISTENING',port:4242,origins:{apiOrigin:'http://127.0.0.1:4242',adminOrigin:'http://127.0.0.1:4241'},
 NoIM:true,financialCommandCapabilities:false,workersEnabled:false,formalAppMounted:true,maintenanceLockReleased:true,maintenanceClosed:true,
 resource,actualResource:{...resource,read_only:'on',migration_role_oid:'790'},initialization:{nonce,imProvisioner:false,imIdentityRepository:false,imAppId:null}};
const names={'boss-one':'本地管理员一','boss-two':'本地管理员二',operations:'本地运营',support:'本地客服'};
const ref={path:'E:/fixture',sha256:hash};
test('input assembly binds the fresh target and only accepts a completed R07 schema',()=>{
 assert.equal(target.instance.port,55433);assert.throws(()=>makeR07Target(registry,{...schema,instance:{...instance,systemIdentifier:'9'}}));
 assert.throws(()=>makeR07Target(registry,{...schema,runtimeAclReadback:false}));
 const changed=normalizeRegisteredTarget({...registry,roles:{migration:{name:'migration',oid:'790'},runtime:{name:'runtime',oid:'789'}},protectedDataset:{...registry.protectedDataset,status:'BUILDING'}});
 assert.throws(()=>makeR07Target(changed,schema),/R07_ASSEMBLY_RESERVATION_CHANGED/);
});
test('runtime assembly rejects another port, role, instance or enabled worker',()=>{
 assert.doesNotThrow(()=>assertR07AssemblyRuntime(binding,target));
 for(const change of [x=>{x.port=4232;},x=>{x.workersEnabled=true;},x=>{x.actualResource.migration_role_oid='12';},x=>{x.actualResource.instance.systemIdentifier='9';}]){
  const wrong=structuredClone(binding);change(wrong);assert.throws(()=>assertR07AssemblyRuntime(wrong,target));
 }
});
test('admin input contains only refs, stage and exact sealed hashes',()=>{
 const input=makeR07AdminInput({stage:'bosses',target,bindingRef:ref,credentialRef:ref,bootstrapSecret:ref,names,resource:'round07'});
 assert.equal(input.stage,'bosses');assert.equal(input.credentialsSha256,hash);assert.equal(input.bootstrapSecretSha256,hash);assert.equal(input.serverBinding.sha256,hash);
 assert.throws(()=>makeR07AdminInput({stage:'staff',target,bindingRef:ref,credentialRef:ref,bootstrapSecret:ref,names,resource:'round07'}));
 const staff=makeR07AdminInput({stage:'staff',target,bindingRef:ref,credentialRef:ref,bootstrapSecret:ref,names,resource:'round07',bossProfile:ref});assert.equal(staff.bossProfileSha256,hash);
});
test('assembly defaults to a no-connection, no-write plan',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./prepare-round07-inputs.mjs',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0);const plan=JSON.parse(result.stdout);assert.equal(plan.connections,0);assert.equal(plan.targetWrites,0);
});
