import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertMysqlClientFile, assertMysqlContainer, assertMysqlFrozen, assertMysqlImage, assertMysqlSourceBinding, assertMysqlVolume, createMysqlSourceContainer, hashDump, mysqlMainProcessReady, restoreMysqlDump, validateMysqlSourcePlan } from './prepare-local-mysql-source.mjs';

const imageId='sha256:'+'a'.repeat(64),id='b'.repeat(64),nonce='c'.repeat(32);
const plan={schema:'zzsh.local-mysql-source-plan.v1',suffix:'fixture-01',containerName:'zzsh-migration-mysql-fixture-01',volumeName:'zzsh-migration-mysql-data-fixture-01',
 taskLabel:'local-migration-mysql-source',resourceNonce:nonce,imageId,toolSha256:'1'.repeat(64),checkpointToolSha256:'2'.repeat(64),database:'sg_zzsh_restore',automaticCleanup:false,
 dump:{path:'E:/zzsh-local-state/restricted/source.sql',sha256:'d'.repeat(64),bytes:10,exportStartedAt:'2026-11-03T07:00:00Z',cutoff:'2026-11-03T07:01:00Z',cutoffMeaning:'EXPORT_COMPLETED_NOT_PROVEN_STOP_WRITE'},
 credentials:{passwordFile:'E:/zzsh/zzsh/apps/api/.secrets/migration-mysql-fixture-01/root-password',clientFile:'E:/zzsh/zzsh/apps/api/.secrets/migration-mysql-fixture-01/client.cnf',passwordSha256:'e'.repeat(64),clientSha256:'f'.repeat(64)}};
const image={Id:imageId,Os:'linux',Architecture:'amd64',RepoTags:['mysql:8.0.45'],Config:{Env:['MYSQL_MAJOR=8.0','MYSQL_VERSION=8.0.45-1.el9']}};
const container={Id:id,Name:'/'+plan.containerName,Image:imageId,State:{Running:true,StartedAt:'2026-11-09T00:05:00Z'},HostConfig:{NetworkMode:'none',Privileged:false,AutoRemove:false,Tmpfs:{'/run/zzsh-source':'rw,noexec,nosuid,nodev,mode=0700'}},NetworkSettings:{Ports:{}},
 Config:{Labels:{'zzsh.task':plan.taskLabel,'zzsh.nonce':nonce},Env:['MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql-password','MYSQL_DATABASE=sg_zzsh_restore'],Cmd:['--skip-networking=ON','--event-scheduler=DISABLED','--local-infile=OFF']},
 Mounts:[{Type:'volume',Name:plan.volumeName,Destination:'/var/lib/mysql',RW:true},{Type:'bind',Source:plan.credentials.passwordFile,Destination:'/run/secrets/mysql-password',RW:false}]};
const frozen={database:'sg_zzsh_restore',serverUuid:'12345678-1234-1234-1234-123456789abc',readOnly:1,superReadOnly:1,skipNetworking:1,localInfile:0,eventScheduler:'DISABLED',requiredTables:4};

test('source plan pins the isolated name, dump, cutoff and private credentials',()=>{
 assert.doesNotThrow(()=>validateMysqlSourcePlan(plan));assert.doesNotThrow(()=>assertMysqlImage(image,imageId));
 for(const changed of [{automaticCleanup:true},{containerName:'zzsh-mysql-restore'},{volumeName:'shared'},{resourceNonce:'x'},
  {dump:{...plan.dump,sha256:'bad'}},{dump:{...plan.dump,cutoffMeaning:'CONSISTENT'}},{dump:{...plan.dump,cutoff:'2026-02-30T00:00:00Z'}},
  {dump:{...plan.dump,cutoff:'2026-11-03 07:01:00'}},{credentials:{...plan.credentials,clientFile:'E:/other'}}])
  assert.throws(()=>validateMysqlSourcePlan({...plan,...changed}));
 assert.throws(()=>assertMysqlImage({...image,RepoTags:['mysql:latest']},imageId));
});
test('source container must use its own volume, no network and readonly secret mounts',()=>{
 assert.doesNotThrow(()=>assertMysqlContainer(container,plan,id));
 assert.doesNotThrow(()=>assertMysqlContainer(container,plan,id,container.State.StartedAt));
 assert.throws(()=>assertMysqlContainer(container,plan,id,'2026-11-09T00:06:00Z'),/MYSQL_SOURCE_CONTAINER_RESTARTED/);
 assert.doesNotThrow(()=>assertMysqlVolume({Name:plan.volumeName,Driver:'local',Labels:{'zzsh.task':plan.taskLabel,'zzsh.nonce':nonce}},plan));
 assert.doesNotThrow(()=>assertMysqlClientFile('600:0:regular file',plan.credentials.clientSha256,plan.credentials.clientSha256));
 assert.throws(()=>assertMysqlClientFile('666:0:regular file',plan.credentials.clientSha256,plan.credentials.clientSha256));
 assert.throws(()=>assertMysqlClientFile('600:0:regular file','0'.repeat(64),plan.credentials.clientSha256));
 for(const mutate of [x=>x.HostConfig.NetworkMode='bridge',x=>x.Config.Labels['zzsh.nonce']='wrong',x=>x.Mounts[1].RW=true,
  x=>x.Config.Env.push('MYSQL_ROOT_PASSWORD=secret'),x=>x.Config.Cmd.pop(),x=>x.Mounts.push({Type:'bind'}),x=>delete x.HostConfig.Tmpfs]){
  const changed=structuredClone(container);mutate(changed);assert.throws(()=>assertMysqlContainer(changed,plan,id),/MYSQL_SOURCE_CONTAINER_CHANGED/);
 }
 assert.throws(()=>assertMysqlVolume({Name:plan.volumeName,Driver:'local',Labels:{'zzsh.task':plan.taskLabel,'zzsh.nonce':'wrong'}},plan));
});
test('restore readiness requires all source tables and the server to be frozen with network and scheduler disabled',()=>{
 assert.doesNotThrow(()=>assertMysqlFrozen(frozen));
 for(const change of [{readOnly:0},{superReadOnly:0},{skipNetworking:0},{localInfile:1},{eventScheduler:'OFF'},
  {requiredTables:3},{serverUuid:'bad'},{database:'other'}])assert.throws(()=>assertMysqlFrozen({...frozen,...change}),/MYSQL_SOURCE_NOT_FROZEN/);
});
test('temporary bootstrap server cannot be mistaken for the final MySQL process',()=>{
 assert.equal(mysqlMainProcessReady('docker-entrypoint',{status:0,stdout:'1\n'}),false);
 assert.equal(mysqlMainProcessReady('mysqld',{status:1,stdout:''}),false);
 assert.equal(mysqlMainProcessReady('mysqld',{status:0,stdout:'1\n'}),true);
});
test('source binding rejects changed restore evidence and does not claim the online export was consistent',()=>{
 const planSha='2'.repeat(64),bindingSha='3'.repeat(64),binding={schema:'zzsh.local-source-origin.v2',planSha256:planSha,toolSha256:plan.toolSha256,checkpointToolSha256:plan.checkpointToolSha256,
  container:{id,name:plan.containerName,imageId,volumeName:plan.volumeName,resourceNonce:nonce,startedAt:'2026-11-09T00:05:00Z'},
  source:{database:plan.database,network:'none',readOnly:true,superReadOnly:true,eventScheduler:'DISABLED',clientFile:'/run/zzsh-source/client.cnf',clientSha256:plan.credentials.clientSha256},
  restoreRecord:{dumpPath:plan.dump.path,dumpSha256:plan.dump.sha256,dumpBytes:plan.dump.bytes,exportStartedAt:plan.dump.exportStartedAt,cutoff:plan.dump.cutoff,cutoffMeaning:plan.dump.cutoffMeaning,
   consumedSha256:plan.dump.sha256,importClientExitCode:0,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'}};
 const receipt={schema:'zzsh.local-mysql-source-restore.v1',status:'MYSQL_SOURCE_RESTORED_READ_ONLY',planSha256:planSha,bindingSha256:bindingSha,containerId:id,containerStartedAt:'2026-11-09T00:05:00Z',
  imported:{sha256:plan.dump.sha256,bytes:plan.dump.bytes,clientExitCode:0,stderrPresent:false,warningObserved:false}};
 assert.doesNotThrow(()=>assertMysqlSourceBinding(plan,receipt,binding,planSha,bindingSha,id));
 for(const mutate of [x=>x.source.readOnly=false,x=>x.restoreRecord.consumedSha256='0'.repeat(64),x=>x.container.id='f'.repeat(64),x=>x.container.startedAt='2026-11-09T00:06:00Z',
  x=>x.restoreRecord.sourceExportConsistency='CONFIRMED',x=>x.source.clientSha256='0'.repeat(64)]){
  const changed=structuredClone(binding);mutate(changed);assert.throws(()=>assertMysqlSourceBinding(plan,receipt,changed,planSha,bindingSha,id),/MYSQL_SOURCE_BINDING_INVALID/);
 }
 assert.throws(()=>assertMysqlSourceBinding(plan,{...receipt,imported:{...receipt.imported,warningObserved:true}},binding,planSha,bindingSha,id));
});
test('creation persists intent before docker calls and never deletes a possibly partial restore',()=>{
 const calls=[],events=[];let n=0;assert.throws(()=>createMysqlSourceContainer({plan,run:args=>{calls.push(args);if(++n===2)throw Error('unconfirmed');return plan.volumeName;},
  save:value=>events.push(structuredClone(value))}));
 assert.equal(events.at(-1).steps.at(-1).status,'INTENT');assert.equal(events.at(-1).steps.at(-1).name,'container');
 assert(calls.every(args=>!['rm','prune','kill'].includes(args[0])));assert(!calls.flat().some(x=>String(x).startsWith('MYSQL_ROOT_PASSWORD=')));
 const replies=[plan.volumeName,id,id,''],secret=Buffer.from('synthetic-secret');let sent;
 const done=createMysqlSourceContainer({plan,clientConfig:secret,run:(_args,input)=>{if(input)sent=input;return replies.shift();},save:()=>{}});
 assert.equal(done.containerId,id);assert.equal(sent,secret);assert.deepEqual(done.steps.map(x=>x.status),['ACK','ACK','ACK','ACK']);
});
test('mysql import binds the actual streamed bytes and fails closed on partial client failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mysql-source-test-')),file=join(dir,'dump.sql'),bytes=Buffer.from('CREATE TABLE synthetic (v INT);\n');writeFileSync(file,bytes);
 const digest=createHash('sha256').update(bytes).digest('hex');let seenArgs;
 const fake=(exit=0,warning=false,stderr='')=>((_name,args)=>{seenArgs=args;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(_chunk,_encoding,done){done();},final(done){if(warning)child.stdout.write('Warning (Code 1265): synthetic\n');if(stderr)child.stderr.write(stderr);done();queueMicrotask(()=>child.emit('close',exit,null));}});return child;});
 try{
  assert.deepEqual(await hashDump(file),{sha256:digest,bytes:bytes.length});
  assert.equal((await restoreMysqlDump({containerId:id,dumpPath:file,expectedSha256:digest,expectedBytes:bytes.length,spawnProcess:fake()})).sha256,digest);
  assert(seenArgs.includes('--binary-mode'));assert(seenArgs.includes('--local-infile=0'));assert(seenArgs.includes('--skip-reconnect'));assert(seenArgs.includes('--show-warnings'));
  await assert.rejects(restoreMysqlDump({containerId:id,dumpPath:file,expectedSha256:digest,expectedBytes:bytes.length,spawnProcess:fake(1)}),/MYSQL_SOURCE_IMPORT_FAILED_PRESERVE/);
  await assert.rejects(restoreMysqlDump({containerId:id,dumpPath:file,expectedSha256:digest,expectedBytes:bytes.length,spawnProcess:fake(1,false,'ERROR 2006: synthetic private value')}),error=>{
   assert.equal(error.importAttempt.stderrClass,'MYSQL_ERROR_2006');assert(!JSON.stringify(error.importAttempt).includes('private value'));return true;});
  await assert.rejects(restoreMysqlDump({containerId:id,dumpPath:file,expectedSha256:digest,expectedBytes:bytes.length,spawnProcess:fake(0,true)}),/MYSQL_SOURCE_IMPORT_OUTPUT_REVIEW/);
  await assert.rejects(restoreMysqlDump({containerId:id,dumpPath:file,expectedSha256:'0'.repeat(64),expectedBytes:bytes.length,spawnProcess:fake()}),/MYSQL_SOURCE_CONSUMED_BYTES_CHANGED/);
 }finally{unlinkSync(file);rmdirSync(dir);}
});
test('default command is read-only planning and does not create a source',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./prepare-local-mysql-source.mjs',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0);const p=JSON.parse(result.stdout);assert.equal(p.status,'PLAN_ONLY');assert.equal(p.dbConnections,0);assert.equal(p.automaticCleanup,false);
 const changed=spawnSync(process.execPath,[fileURLToPath(new URL('./prepare-local-mysql-source.mjs',import.meta.url)),'--execute','--plan','fixture','--plan-sha','0'.repeat(64),'--dump','other'],{encoding:'utf8'});
 assert.notEqual(changed.status,0);assert.match(changed.stderr,/MYSQL_SOURCE_ARGUMENTS_INVALID/);
});
