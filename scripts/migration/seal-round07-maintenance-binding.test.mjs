import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { makeR07MaintenanceBinding, maintenanceBindingOutput } from './seal-round07-maintenance-binding.mjs';
const hash=n=>n.repeat(64),instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},target={oid:'42',nonce:'a'.repeat(24),instance,migrationRoleOid:'91',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'};
const round={schema:'zzsh.local-round.v1',target,dataset:{sha256:hash('1')},apiDist:'E:/work/api/src',bootstrapEvidence:{runtime:{sha256:hash('2')},bundle:{sha256:hash('3')}},dependencyBinding:{buildManifest:{sha256:hash('4')}}};
const receipt={inputSha256:hash('5'),datasetSha256:hash('1'),status:'DATASET_AND_GROWTH_ACK_READBACK_PASS',completion:{status:'COMPLETE'},target};
const resource={database:'zzsh_test_regression',oid:'42',nonce:target.nonce,instance,marker:'zzsh:regression-test:v1'};
const binding={status:'R07_BOOTSTRAP_API_LISTENING',port:4242,origins:{apiOrigin:'http://127.0.0.1:4242'},pid:100,at:'2026-11-05T00:00:00Z',stopFile:'E:/stop',NoIM:true,financialCommandCapabilities:false,workersEnabled:false,formalAppMounted:true,maintenanceLockReleased:true,maintenanceClosed:true,
 resource,actualResource:{...resource,read_only:'on',migration_role_oid:'91'},copyManifestSha256:hash('3'),compiledRoot:'E:/work/api/src'};
const input={round,receipt,binding,roundSha:hash('5'),receiptSha:hash('6'),buildSha:hash('4'),runtimeSha:hash('2')};
test('maintenance binding only seals matching completed round and exact isolated runtime',()=>{
 assert.equal(makeR07MaintenanceBinding(input).status,'R07_MAINTENANCE_API_LISTENING');
 for(const change of [x=>{x.receipt.completion.status='INCOMPLETE';},x=>{x.receipt.target.instance.systemIdentifier='2';},x=>{x.binding.workersEnabled=true;},x=>{x.binding.actualResource.migration_role_oid='5';},x=>{x.binding.port=4232;},x=>{x.runtimeSha=hash('8');}]){
  const wrong={...input,round:structuredClone(round),receipt:structuredClone(receipt),binding:structuredClone(binding)};
  change(wrong);assert.throws(()=>makeR07MaintenanceBinding(wrong),/R07_MAINTENANCE_EVIDENCE_CHANGED/);
 }
});
test('maintenance seal defaults to no connections',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./seal-round07-maintenance-binding.mjs',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).connections,0);
});
test('maintenance binding is written under runtime and rejects other roots and symlinks',()=>{
 const root=resolve('fixture/runtime'),out=join(root,'round07-binding'),stat=()=>({isSymbolicLink:()=>false});
 assert.equal(maintenanceBindingOutput(out,{runtimeRoot:root,stat}),out);
 assert.throws(()=>maintenanceBindingOutput(resolve(root,'../restricted/binding'),{runtimeRoot:root,stat}),/R07_BINDING_PATH_REQUIRED/);
 assert.throws(()=>maintenanceBindingOutput(out,{runtimeRoot:root,stat:()=>({isSymbolicLink:()=>true})}),/R07_BINDING_LINK_REFUSED/);
});
