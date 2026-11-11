import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizeRegisteredTarget } from './local-target-registry.mjs';
import { assertR07RegistrationReceipt, validateR07SchemaRequest, validateR07FinalJournal, schemaInitialBaseline, assertSchemaBaselineHistory, assertInitialDatabaseReadback, assertSchemaToolBinding } from './install-round07-schema.mjs';

const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},nonce='a'.repeat(24),digest='b'.repeat(64);
const target={oid:'123',nonce,instance,migrationRoleOid:'790',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'};
const raw={database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',oid:target.oid,nonce,owner:'zzsh',instance,
 roles:{migration:{name:'zzsh_regression_migration',oid:'790'},runtime:{name:'zzsh_regression_runtime',oid:'789'}},
 protectedDataset:{status:target.bootstrapReservation,bootstrapReservation:target.bootstrapReservation,manifestSha256:digest,epoch:{oid:target.oid,nonce}}};
const request={schema:'zzsh.round07-schema-install-request.v1',target,datasetSha256:digest,migrationsDigest:'c'.repeat(64),credentialsSha256:'d'.repeat(64),registrySha256:'e'.repeat(64)};

test('schema install requires an exact isolated instance, epoch, roles and reserved dataset',()=>{
 const registry=normalizeRegisteredTarget(raw);assert.doesNotThrow(()=>validateR07SchemaRequest(request,registry));
 assert.throws(()=>validateR07SchemaRequest({...request,target:{...target,instance:{...instance,systemIdentifier:'999'}}},registry));
 assert.throws(()=>validateR07SchemaRequest(request,normalizeRegisteredTarget({...raw,pendingReset:{oid:'123'}})));
 assert.throws(()=>validateR07SchemaRequest(request,normalizeRegisteredTarget({...raw,instance:{...instance,port:55432}})));
 assert.throws(()=>validateR07SchemaRequest({...request,datasetSha256:'d'.repeat(64)},registry));
 assert.throws(()=>validateR07SchemaRequest(request,normalizeRegisteredTarget({...raw,protectedDataset:{...raw.protectedDataset,epoch:{oid:'124',nonce}}})));
});

test('next-round schema requires its own registered profile, port and registration receipt',()=>{
 const nextInstance={...instance,port:55435},profile='LOCAL_MIGRATION_NEXT_V1';
 const registry=normalizeRegisteredTarget({...raw,instance:nextInstance,migrationProfile:profile});
 const tools=Object.fromEntries(['install-round07-schema.mjs','business-initial-seeds.mjs','business-initial-tail-seeds.mjs',
  'local-target-registry.mjs','local-distribution-qualification-plan.mjs','local-load-checkpoint.mjs','../local-auth.mjs',
  '../../apps/api/src/database/business-migration-compat.ts'].map(name=>[name,digest]));
 const nextTarget={...target,instance:nextInstance,migrationProfile:profile},nextRequest={...request,target:nextTarget,initialBaseline:'release_production_0174',initialBaselineManifestSha256:digest,schemaTools:tools,releaseCommit:'a'.repeat(40)};
 assert.doesNotThrow(()=>validateR07SchemaRequest(nextRequest,registry));
 assert.throws(()=>validateR07SchemaRequest({...nextRequest,schemaTools:undefined},registry),/SCHEMA_TOOL_BINDING_INVALID/);
 assert.throws(()=>validateR07SchemaRequest({...nextRequest,releaseCommit:undefined},registry),/SCHEMA_RELEASE_COMMIT_REQUIRED/);
 assert.throws(()=>assertSchemaToolBinding(tools,{...tools,'business-initial-tail-seeds.mjs':'f'.repeat(64)}),/SCHEMA_TOOL_CHANGED/);
 assert.throws(()=>assertSchemaToolBinding({...tools,unexpected:digest},tools),/SCHEMA_TOOL_BINDING_INVALID/);
 assert.throws(()=>validateR07SchemaRequest({...nextRequest,initialBaseline:undefined,initialBaselineManifestSha256:undefined},registry),/SCHEMA_NEXT_BASELINE_REQUIRED/);
 assert.throws(()=>validateR07SchemaRequest({...nextRequest,initialBaseline:'release_production_0153'},registry),/SCHEMA_NEXT_BASELINE_REQUIRED/);
 for(const bad of [{...nextTarget,migrationProfile:undefined},{...nextTarget,instance:{...nextInstance,port:55433}}])
  assert.throws(()=>validateR07SchemaRequest({...nextRequest,target:bad},registry));
 const receipt={status:'MIGRATION_TARGET_REGISTERED',oid:registry.oid,nonce:registry.nonce,instance:nextInstance,roleReadback:true,unlockAck:true,maintenanceClosed:true};
 assert.doesNotThrow(()=>assertR07RegistrationReceipt(receipt,registry));
 assert.throws(()=>assertR07RegistrationReceipt({...receipt,status:'R07_TARGET_REGISTERED'},registry));
});

test('schema install defaults to an offline plan',()=>{
 const p=spawnSync(process.execPath,[new URL('./install-round07-schema.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});
 assert.equal(p.status,0);const report=JSON.parse(p.stdout);assert.equal(report.status,'PLAN_ONLY');assert.equal(report.connections,0);assert.equal(report.targetWrites,0);
});

test('explicit new baseline is bound to its manifest while old sealed requests stay compatible',()=>{
 const registry=normalizeRegisteredTarget(raw),selected={...request,initialBaseline:'release_production_0174',initialBaselineManifestSha256:digest};
 assert.equal(schemaInitialBaseline(request),'release_production_0153');assert.equal(schemaInitialBaseline(selected),'release_production_0174');
 assert.doesNotThrow(()=>validateR07SchemaRequest(selected,registry));
 for(const changed of [{...selected,initialBaseline:'release_0141'},{...selected,initialBaseline:'../outside'},
  {...selected,initialBaselineManifestSha256:'unknown'},{...request,initialBaselineManifestSha256:digest}])
  assert.throws(()=>validateR07SchemaRequest(changed,registry),/SCHEMA_BASELINE_BINDING_INVALID/);
});

test('baseline readback requires its exact first hash and final journal timestamp',()=>{
 const baseline={profile:'PRODUCTION',migrationHash:'c'.repeat(64),when:101},last={when:103};
 const history=[{hash:baseline.migrationHash,createdAt:'101'},{hash:'d'.repeat(64),createdAt:'103'}];
 assert.doesNotThrow(()=>assertSchemaBaselineHistory(history,baseline,last));
 for(const changed of [[],[{...history[0],hash:'f'.repeat(64)},history[1]],[{...history[0],createdAt:'100'},history[1]],[history[0],{...history[1],createdAt:'102'}]])
  assert.throws(()=>assertSchemaBaselineHistory(changed,baseline,last),/SCHEMA_BASELINE_HISTORY_MISMATCH/);
});

test('initial readback rejects unbound canonical proof and incomplete seed inventory before SQL',async()=>{
 const dir=new URL('../../apps/api/migrations/initial/release_production_0174/',import.meta.url);
 const baseline=JSON.parse(readFileSync(new URL('manifest.json',dir),'utf8'));
 const proof=JSON.parse(readFileSync(new URL('CANONICAL-SEED-PROOF.json',dir),'utf8'));
 const client={query:async()=>{throw Error('UNEXPECTED_QUERY')}};
 await assert.rejects(()=>assertInitialDatabaseReadback(client,baseline,{...proof,sourceChainSha256:'0'.repeat(64)}),/INITIAL_CANONICAL_SEED_PROOF_INVALID/);
 await assert.rejects(()=>assertInitialDatabaseReadback(client,{...baseline,seedCounts:baseline.seedCounts.slice(1)},proof),/SCHEMA_SEED_MANIFEST_INVALID/);
});

test('schema installation refuses registration without role readback, unlock and closed connection',()=>{
 const registry=normalizeRegisteredTarget(raw),receipt={status:'R07_TARGET_REGISTERED',oid:registry.oid,nonce:registry.nonce,instance,roleReadback:true,unlockAck:true,maintenanceClosed:true};
 assert.doesNotThrow(()=>assertR07RegistrationReceipt(receipt,registry));
 for(const change of [{unlockAck:false},{maintenanceClosed:false},{roleReadback:false},{instance:{...instance,systemIdentifier:'999'}}])
  assert.throws(()=>assertR07RegistrationReceipt({...receipt,...change},registry),/SCHEMA_TARGET_REGISTRATION_UNCONFIRMED/);
});

test('fresh schema binds the final journal entry to the sealed migration set without hardcoding its version',()=>{
 for(const idx of [161,162,163]){const tag=String(idx).padStart(4,'0')+'_change',journal={entries:[{idx,tag,when:1793730640482+idx}]};
  assert.equal(validateR07FinalJournal(journal,{['business/'+tag+'.sql']:digest}).idx,idx);
  assert.throws(()=>validateR07FinalJournal(journal,{}));
 }
 for(const last of [{idx:160,tag:'0160_old',when:1},{idx:161,tag:'0162_wrong',when:1},{idx:161,tag:'../0161_escape',when:1},{idx:161,tag:'0161_valid',when:0}])
  assert.throws(()=>validateR07FinalJournal({entries:[last]},{['business/'+last.tag+'.sql']:digest}));
});
