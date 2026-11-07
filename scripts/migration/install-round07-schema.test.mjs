import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizeRegisteredTarget } from './local-target-registry.mjs';
import { assertR07RegistrationReceipt, validateR07SchemaRequest, validateR07FinalJournal } from './install-round07-schema.mjs';

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

test('schema install defaults to an offline plan',()=>{
 const p=spawnSync(process.execPath,[new URL('./install-round07-schema.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});
 assert.equal(p.status,0);const report=JSON.parse(p.stdout);assert.equal(report.status,'PLAN_ONLY');assert.equal(report.connections,0);assert.equal(report.targetWrites,0);
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
