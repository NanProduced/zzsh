import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNoR07NameCollision, assertR07ContainerCreated, assertR07Image, assertR07Volume, createR07Container, validateR07ContainerPlan } from './prepare-round07-postgres.mjs';

const imageId='sha256:'+'a'.repeat(64),containerId='b'.repeat(64);
const plan={schema:'zzsh.round07-postgres-container-plan.v1',nameSuffix:'fixture-01',containerName:'zzsh-r07-postgres-fixture-01',volumeName:'zzsh-r07-pgdata-fixture-01',imageId,
 host:'127.0.0.1',port:55433,taskLabel:'round07-migration',databaseUser:'zzsh',automaticCleanup:false,
 password:{path:'E:/zzsh/zzsh/apps/api/.secrets/round07-postgres-fixture-01/postgres_password',sha256:'c'.repeat(64)}};
const image={Id:imageId,Os:'linux',Architecture:'amd64',RepoTags:['postgres:16-alpine'],Config:{Env:['PG_MAJOR=16','PGDATA=/var/lib/postgresql/data']}};
const container={Id:containerId,Image:imageId,State:{Running:true},Config:{Labels:{'zzsh.task':'round07-migration'},Env:['POSTGRES_PASSWORD_FILE=/run/secrets/r07-pg-password']},
 HostConfig:{AutoRemove:false,Privileged:false},NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55433'}]}},
 Mounts:[{Type:'volume',Name:plan.volumeName,Destination:'/var/lib/postgresql/data',RW:true},{Type:'bind',Source:plan.password.path,Destination:'/run/secrets/r07-pg-password',RW:false}]};

test('container plan and pinned PostgreSQL image reject changed target or unknown ownership',()=>{
 assert.doesNotThrow(()=>validateR07ContainerPlan(plan));assert.doesNotThrow(()=>assertR07Image(image,imageId));
 for(const change of [{port:55432},{host:'0.0.0.0'},{automaticCleanup:true},{volumeName:'shared'},{password:{...plan.password,path:'E:/other/password'}}])assert.throws(()=>validateR07ContainerPlan({...plan,...change}));
 assert.throws(()=>assertR07Image({...image,Config:{Env:['PG_MAJOR=18']}},imageId));
 assert.throws(()=>assertNoR07NameCollision([plan.containerName],[],plan));assert.throws(()=>assertNoR07NameCollision([],[plan.volumeName],plan));
});
test('created container and data volume must retain exact id, loopback port, task label and secret mount',()=>{
 assert.doesNotThrow(()=>assertR07ContainerCreated(container,plan,containerId));assert.doesNotThrow(()=>assertR07Volume({Name:plan.volumeName,Labels:{'zzsh.task':plan.taskLabel},Driver:'local'},plan));
 const bad=structuredClone(container);bad.NetworkSettings.Ports['5432/tcp'][0].HostIp='0.0.0.0';assert.throws(()=>assertR07ContainerCreated(bad,plan,containerId));
 const mutable=structuredClone(container);mutable.Mounts[1].RW=true;assert.throws(()=>assertR07ContainerCreated(mutable,plan,containerId));
 assert.throws(()=>assertR07Volume({Name:plan.volumeName,Labels:{},Driver:'local'},plan));
});
test('container creation saves intent before each step and never removes resources after a failure',()=>{
 const commands=[],snapshots=[];let n=0;
 const run=args=>{commands.push(args);n++;if(n===2)throw Object.assign(Error('lost reply'),{code:'ETIMEDOUT'});return plan.volumeName;};
 assert.throws(()=>createR07Container({plan,run,save:x=>snapshots.push(structuredClone(x))}));
 assert.equal(snapshots.at(-1).steps.at(-1).status,'INTENT');assert.equal(snapshots.at(-1).steps.at(-1).name,'container');
 assert(commands.every(args=>!['rm','prune','kill'].includes(args[0])));assert(commands.flat().every(arg=>!String(arg).startsWith('POSTGRES_PASSWORD=')));
});
test('container creation only acknowledges the ordered volume, container and start responses',()=>{
 const events=[],replies=[plan.volumeName,containerId,containerId],result=createR07Container({plan,run:()=>replies.shift(),save:x=>events.push(structuredClone(x))});
 assert.equal(result.containerId,containerId);assert.deepEqual(result.steps.map(x=>x.status),['ACK','ACK','ACK']);assert.equal(events.at(-1).steps.at(-1).name,'start');
});
test('container helper defaults to a no-connection, no-creation plan',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./prepare-round07-postgres.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(r.status,0);
 const p=JSON.parse(r.stdout);assert.equal(p.dbConnections,0);assert.equal(p.containersCreated,0);assert.equal(p.automaticCleanup,false);
});

test('a later local migration uses a separate labelled resource and explicit free loopback port',()=>{
 const next={...plan,schema:'zzsh.local-migration-postgres-container-plan.v1',containerName:'zzsh-migration-postgres-fixture-01',
  volumeName:'zzsh-migration-pgdata-fixture-01',port:55435,taskLabel:'local-migration-next',
  password:{...plan.password,path:'E:/zzsh/zzsh/apps/api/.secrets/migration-postgres-fixture-01/postgres_password'}};
 assert.doesNotThrow(()=>validateR07ContainerPlan(next));
 for(const change of [{port:55432},{port:55433},{port:55434},{port:0},{port:65536},{port:'55435'},
  {host:'0.0.0.0'},{taskLabel:'round07-migration'},{containerName:plan.containerName},{volumeName:plan.volumeName},{password:plan.password}])
  assert.throws(()=>validateR07ContainerPlan({...next,...change}));
 const created=structuredClone(container);created.Config.Labels['zzsh.task']=next.taskLabel;
 created.NetworkSettings.Ports['5432/tcp'][0].HostPort='55435';created.Mounts[0].Name=next.volumeName;created.Mounts[1].Source=next.password.path;
 assert.doesNotThrow(()=>assertR07ContainerCreated(created,next,containerId));
 const wrongPort=structuredClone(created);wrongPort.NetworkSettings.Ports['5432/tcp'][0].HostPort='55433';
 assert.throws(()=>assertR07ContainerCreated(wrongPort,next,containerId));
 const calls=[],replies=[next.volumeName,containerId,containerId];
 createR07Container({plan:next,run:args=>{calls.push(args);return replies.shift();},save:()=>{}});
 assert(calls[1].includes('127.0.0.1:55435:5432'));assert(!calls.flat().some(arg=>String(arg).startsWith('POSTGRES_PASSWORD=')));
});

test('an execute invocation cannot override the sealed port',()=>{
 const file=fileURLToPath(new URL('./prepare-round07-postgres.mjs',import.meta.url));
 const r=spawnSync(process.execPath,[file,'--execute','--port','55435'],{encoding:'utf8'});
 assert.notEqual(r.status,0);assert.match(r.stderr,/R07_CONTAINER_PORT_INVALID/);
});
