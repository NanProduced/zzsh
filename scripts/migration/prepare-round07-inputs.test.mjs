import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeRegisteredTarget } from './local-target-registry.mjs';
import { assertR07AssemblyRuntime, makeR07AdminInput, makeR07RoundSecurityBindings, makeR07Target } from './prepare-round07-inputs.mjs';

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
test('input assembly carries the next-round target profile without changing R07 artifacts',()=>{
 const nextInstance={...instance,port:55435},migrationProfile='LOCAL_MIGRATION_NEXT_V1';
 const nextRegistry=normalizeRegisteredTarget({database:registry.database,oid:registry.oid,nonce,owner:'zzsh',marker:registry.marker,instance:nextInstance,migrationProfile,
  roles:{migration:{name:'migration',oid:'790'},runtime:{name:'runtime',oid:'789'}},protectedDataset:registry.protectedDataset});
 const nextSchema={...schema,instance:nextInstance,migrationProfile,targetFence:'HELD_ACROSS_SCHEMA_AND_ACL',targetFenceReleased:true,initialBaseline:'release_production_0174',initialSeedReadback:{status:'INITIAL_SEEDS_AND_COMMENTS_VERIFIED'},initialBaselineManifestSha256:hash,initialTailSeedProofSha256:hash,releaseCommit:'a'.repeat(40)};
 const nextTarget=makeR07Target(nextRegistry,nextSchema);
 assert.throws(()=>makeR07Target(nextRegistry,{...nextSchema,targetFenceReleased:false}),/BOOTSTRAP_TARGET_OR_SCHEMA_CHANGED/);
 assert.equal(nextTarget.migrationProfile,migrationProfile);assert.equal(nextTarget.instance.port,55435);
 const nextBinding={...binding,resource:{...binding.resource,instance:nextInstance,migrationProfile},actualResource:{...binding.actualResource,instance:nextInstance,migrationProfile}};
 assert.doesNotThrow(()=>assertR07AssemblyRuntime(nextBinding,nextTarget));
 assert.throws(()=>assertR07AssemblyRuntime({...nextBinding,resource:{...nextBinding.resource,migrationProfile:undefined}},nextTarget));
 assert.equal(target.migrationProfile,undefined);
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
test('fresh round assembly binds the legacy identity key and the same reviewed legal pair',()=>{
 const buildFiles=Object.fromEntries(['legal/legal-documents.js','auth/security-core.js','supply/content-hash.js','supply/supply-util.js'].map(name=>[name,hash]));
 const terms='1'.repeat(64),privacy='2'.repeat(64),effectiveAt='2026-01-01T00:00:00.000Z';
 const input={dataset:{identityProfiles:{schema:'zzsh.legacy-identity-profile-source.v1',verified:2,ready:2,invalid:0},refundRelationshipPolicy:'legacy-refund-relationship-v2'},
  legalRef:ref,legalInput:{schema:'zzsh.legal-initial-source.v1',effectiveAt,terms:{sha256:terms},privacy:{sha256:privacy},build:{...buildFiles}},
  business:{catalogModel:'OWNER_KIND_V2',legal:{status:'INITIALIZED',inputSha256:hash,effectiveAt,terms:{sourceSha256:terms,digest:hash},privacy:{sourceSha256:privacy,digest:hash}}},
  buildFiles,secrets:{databaseMaintenance:ref,identitySubjectHmac:ref,identityProfile:{path:'E:/other-key',sha256:'c'.repeat(64)}},
  runtimeBinding:{identitySubjectKeySha256:hash,legacyIdentityProfileKeySha256:'c'.repeat(64)}};
 assert.deepEqual(makeR07RoundSecurityBindings(input),{legal:ref,secrets:input.secrets});
 for(const change of [
  x=>{delete x.dataset.identityProfiles},x=>{x.dataset.identityProfiles.invalid=1},x=>{delete x.dataset.refundRelationshipPolicy},x=>{delete x.business.catalogModel},x=>{delete x.secrets.identityProfile},
  x=>{x.secrets.identityProfile.sha256=x.secrets.identitySubjectHmac.sha256},x=>{x.business.legal.inputSha256='0'.repeat(64)},
  x=>{x.runtimeBinding.legacyIdentityProfileKeySha256='0'.repeat(64)},x=>{delete x.runtimeBinding.identitySubjectKeySha256},
  x=>{x.legalInput.privacy.sha256='0'.repeat(64)},x=>{x.legalInput.build['legal/legal-documents.js']='0'.repeat(64)},
  x=>{delete x.legalInput.terms.sha256;delete x.business.legal.terms.sourceSha256},
  x=>{x.legalInput.effectiveAt='not-a-date';x.business.legal.effectiveAt='not-a-date'},
 ]){
  const wrong=structuredClone(input);change(wrong);assert.throws(()=>makeR07RoundSecurityBindings(wrong));
 }
});
test('assembly defaults to a no-connection, no-write plan',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./prepare-round07-inputs.mjs',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0);const plan=JSON.parse(result.stdout);assert.equal(plan.connections,0);assert.equal(plan.targetWrites,0);
});
