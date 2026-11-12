import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdtempSync,readFileSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {assertFirstAdminAuthorizationSeeds,assertFirstAdminSchemaBinding,assertFirstAdminUnclaimed} from './initialize-first-administrators.mjs';
import {CANONICAL_AUTHORIZATION_TABLES,initialSeedRowsDigest} from './business-initial-seeds.mjs';

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

test('first administrator execution preserves an existing claim or result',()=>{
 const dir=mkdtempSync(join(process.cwd(),'tmp','first-admin-unclaimed-')),claim=join(dir,'claim.json'),result=join(dir,'result.json');
 try{
  assert.doesNotThrow(()=>assertFirstAdminUnclaimed(claim,result));
  writeFileSync(claim,'original claim');assert.throws(()=>assertFirstAdminUnclaimed(claim,result),/FIRST_ADMIN_ORIGINAL_ATTEMPT_EXISTS/);
  assert.equal(readFileSync(claim,'utf8'),'original claim');unlinkSync(claim);
  writeFileSync(result,'COMMIT_UNKNOWN');assert.throws(()=>assertFirstAdminUnclaimed(claim,result),/FIRST_ADMIN_ORIGINAL_ATTEMPT_EXISTS/);
  assert.equal(readFileSync(result,'utf8'),'COMMIT_UNKNOWN');
 }finally{for(const path of [claim,result])if(existsSync(path))unlinkSync(path);rmdirSync(dir);}
});

const restricted=resolve('E:/zzsh-local-state/restricted');
test('a claimed original attempt is rejected before credentials or source verification', {skip:!existsSync(restricted)},()=>{
 const dir=mkdtempSync(join(restricted,'first-admin-claimed-test-')),prepared=join(dir,'prepared.json');
 const bytes=JSON.stringify({schema:'zzsh.first-admin-initialization.v1',requestId:'initial-admin-01234567-89ab-cdef-0123-456789abcdef'});
 const digest=createHash('sha256').update(bytes).digest('hex');writeFileSync(prepared,bytes);
 try{
  for(const name of ['claim.json','result.json']){
   const existing=join(dir,name);writeFileSync(existing,'original attempt');
   const run=spawnSync(process.execPath,[fileURLToPath(new URL('./initialize-first-administrators.mjs',import.meta.url)),
    '--execute','--attempt',dir,'--prepared-sha',digest],{encoding:'utf8'});
   assert.equal(run.status,1);assert.equal(JSON.parse(run.stderr).code,'FIRST_ADMIN_ORIGINAL_ATTEMPT_EXISTS');
   const changed=spawnSync(process.execPath,[fileURLToPath(new URL('./initialize-first-administrators.mjs',import.meta.url)),
    '--execute','--attempt',dir,'--prepared-sha','0'.repeat(64)],{encoding:'utf8'});
   assert.equal(changed.status,1);assert.equal(JSON.parse(changed.stderr).outcome,'REVIEW_REQUIRED');
   assert.notEqual(JSON.parse(changed.stderr).code,'FIRST_ADMIN_ORIGINAL_ATTEMPT_EXISTS');
   if(name==='claim.json'){
    const readback=spawnSync(process.execPath,[fileURLToPath(new URL('./initialize-first-administrators.mjs',import.meta.url)),
     '--readback','--attempt',dir,'--prepared-sha',digest],{encoding:'utf8'});
    assert.equal(readback.status,1);assert.notEqual(JSON.parse(readback.stderr).code,'FIRST_ADMIN_ORIGINAL_ATTEMPT_EXISTS');
   }
   assert.equal(readFileSync(existing,'utf8'),'original attempt');assert.equal(existsSync(join(dir,'initial-passwords.json')),false);
   unlinkSync(existing);
  }
 }finally{for(const name of ['claim.json','result.json','prepared.json']){const path=join(dir,name);if(existsSync(path))unlinkSync(path);}rmdirSync(dir);}
});

test('first administrator authorization readback rejects changed role and permission seeds',async()=>{
 const rows=Object.fromEntries(CANONICAL_AUTHORIZATION_TABLES.map((name,index)=>[name,[{id:index,code:name}]]));
 const proof=Object.fromEntries(Object.entries(rows).map(([name,value])=>[name,{count:value.length,sha256:initialSeedRowsDigest(value)}]));
 const calls=[];const client={getTransactionStatus:()=> 'T',query:async sql=>{
  calls.push(sql);if(sql.startsWith('LOCK TABLE'))return {rows:[]};
  const name=CANONICAL_AUTHORIZATION_TABLES.find(table=>sql.endsWith('FROM '+table+' t'));
  assert(name);return {rows:rows[name].map(row=>({row}))};
 }};
 await assertFirstAdminAuthorizationSeeds(client,proof,true);
 assert(calls[0].startsWith('LOCK TABLE '));assert.equal(calls.length,5);
 calls.length=0;await assertFirstAdminAuthorizationSeeds(client,proof);assert(!calls.some(sql=>sql.startsWith('LOCK TABLE')));
 for(const changed of [[],[{id:99,code:'extra'}],[...rows['zzsh_iam.admin_role_permission'],{id:99,code:'extra'}]]){
  const original=rows['zzsh_iam.admin_role_permission'];rows['zzsh_iam.admin_role_permission']=changed;
  await assert.rejects(assertFirstAdminAuthorizationSeeds(client,proof),/FIRST_ADMIN_AUTHORIZATION_SEEDS_CHANGED/);
  rows['zzsh_iam.admin_role_permission']=original;
 }
 const incomplete={...proof};delete incomplete['zzsh_iam.admin_role'];
 await assert.rejects(assertFirstAdminAuthorizationSeeds(client,incomplete),/FIRST_ADMIN_AUTHORIZATION_PROOF_INVALID/);
 await assert.rejects(assertFirstAdminAuthorizationSeeds({...client,getTransactionStatus:()=> 'I'},proof),/FIRST_ADMIN_AUTHORIZATION_TRANSACTION_REQUIRED/);
});
