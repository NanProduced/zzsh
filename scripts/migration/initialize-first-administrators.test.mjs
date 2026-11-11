import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertFirstAdminSchemaBinding} from './initialize-first-administrators.mjs';

function fixture(){
 const target={oid:'42',nonce:'a'.repeat(24),migrationRoleOid:'43',migrationProfile:'LOCAL_MIGRATION_NEXT_V1',
  bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',instance:{host:'127.0.0.1',port:55439,systemIdentifier:'123'}};
 const request={target,initialBaseline:'release_production_0174',initialBaselineManifestSha256:'a'.repeat(64),
  initialTailSeedProofSha256:'b'.repeat(64),releaseCommit:'c'.repeat(40)};
 const receipt={...target,status:'CLEAN_SCHEMA_INSTALLED',commitAck:true,migrationAck:true,runtimeAclReadback:true,
  readbackRollbackAck:true,readbackClientClosed:true,unlockAck:true,maintenanceClosed:true,targetFence:'HELD_ACROSS_SCHEMA_AND_ACL',
  targetFenceReleased:true,initialSeedReadback:{status:'INITIAL_SEEDS_AND_COMMENTS_VERIFIED'},historySha256:'d'.repeat(64),journalSha256:'e'.repeat(64),
  initialBaseline:request.initialBaseline,initialBaselineManifestSha256:request.initialBaselineManifestSha256,
  initialTailSeedProofSha256:request.initialTailSeedProofSha256,releaseCommit:request.releaseCommit};
 return{request,receipt};
}

test('initial administrators require the exact new-target schema and release proof',()=>{
 const {request,receipt}=fixture();assert.doesNotThrow(()=>assertFirstAdminSchemaBinding(request,receipt));
 for(const change of [r=>{r.oid='44';},r=>{r.instance.systemIdentifier='456';},r=>{r.initialSeedReadback.status='UNKNOWN';},
  r=>{r.targetFenceReleased=false;},r=>{r.releaseCommit='f'.repeat(40);},r=>{r.historySha256='';}]){
  const altered=structuredClone(receipt);change(altered);assert.throws(()=>assertFirstAdminSchemaBinding(request,altered));
 }
});

test('initial admin command without a mode only prints a no-connection plan',()=>{
 const run=spawnSync(process.execPath,[fileURLToPath(new URL('./initialize-first-administrators.mjs',import.meta.url))],{encoding:'utf8'});
 assert.equal(run.status,0);const result=JSON.parse(run.stdout);
 assert.equal(result.status,'PLAN_ONLY');assert.equal(result.connections,0);assert.equal(result.targetWrites,0);
});
