import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertDatasetCaptureProfile, assertFreshR07Cluster, assertR07Container, assertNextContainerBinding, createR07Database } from './register-round07-target.mjs';

const id='a'.repeat(64),container={Id:id,Config:{Labels:{'zzsh.task':'round07-migration'}},State:{Running:true},NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55433'}]}}};
const identity={database:'postgres',role:'zzsh',superuser:true,version:160013,systemIdentifier:'12345',databaseExists:false,rolesExist:false};

test('registration binds the capture receipt and does not admit a new source as old R07',()=>{
 const bytes=value=>Buffer.from(JSON.stringify(value)),digest=value=>createHash('sha256').update(value).digest('hex');
 const old=bytes({status:'CAPTURED_READ_ONLY'}),fresh=bytes({status:'CAPTURED_READ_ONLY',sourceOrigin:{schema:'zzsh.local-source-origin.v2'}});
 assert.doesNotThrow(()=>assertDatasetCaptureProfile({sourceReceiptSha256:digest(old)},old,false));
 assert.doesNotThrow(()=>assertDatasetCaptureProfile({sourceReceiptSha256:digest(fresh)},fresh,true));
 assert.throws(()=>assertDatasetCaptureProfile({sourceReceiptSha256:digest(fresh)},fresh,false),/TARGET_SOURCE_PROFILE_MISMATCH/);
 assert.throws(()=>assertDatasetCaptureProfile({sourceReceiptSha256:digest(old)},old,true),/TARGET_SOURCE_PROFILE_MISMATCH/);
 assert.throws(()=>assertDatasetCaptureProfile({sourceReceiptSha256:digest(old)},fresh,false),/TARGET_SOURCE_RECEIPT_CHANGED/);
});

test('only a uniquely identified loopback R07 container is accepted',()=>{
 assert.doesNotThrow(()=>assertR07Container(container,id));
 assert.throws(()=>assertR07Container({...container,Id:'b'.repeat(64)},id));
 assert.throws(()=>assertR07Container({...container,Config:{Labels:{}}},id));
 assert.throws(()=>assertR07Container({...container,NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'0.0.0.0',HostPort:'55433'}]}}},id));
 assert.throws(()=>assertR07Container({...container,State:{Running:false}},id));
});

test('next target must bind the exact sealed container, image, port and secret reference',()=>{
 const imageId='sha256:'+'a'.repeat(64),secretPath='E:/zzsh/zzsh/apps/api/.secrets/migration-postgres-fixture-01/postgres_password',secretSha256='c'.repeat(64);
 const containerPlan={schema:'zzsh.local-migration-postgres-container-plan.v1',nameSuffix:'fixture-01',containerName:'zzsh-migration-postgres-fixture-01',
  volumeName:'zzsh-migration-pgdata-fixture-01',imageId,host:'127.0.0.1',port:55435,taskLabel:'local-migration-next',databaseUser:'zzsh',automaticCleanup:false,
  password:{path:secretPath,sha256:secretSha256}};
 const value={Id:id,Image:imageId,State:{Running:true},Config:{Labels:{'zzsh.task':containerPlan.taskLabel},Env:['POSTGRES_PASSWORD_FILE=/run/secrets/r07-pg-password']},
  HostConfig:{AutoRemove:false,Privileged:false},NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55435'}]}},
  Mounts:[{Type:'volume',Name:containerPlan.volumeName,Destination:'/var/lib/postgresql/data',RW:true},
   {Type:'bind',Source:secretPath,Destination:'/run/secrets/r07-pg-password',RW:false}]};
 const args={containerPlan,container:value,id,secretPath,secretSha256};assert.doesNotThrow(()=>assertNextContainerBinding(args));
 for(const change of [{id:'b'.repeat(64)},{secretPath:secretPath+'-other'},{secretSha256:'d'.repeat(64)},
  {containerPlan:{...containerPlan,schema:'zzsh.round07-postgres-container-plan.v1'}},
  {container:{...value,Image:'sha256:'+'b'.repeat(64)}},
  {container:{...value,NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55433'}]}}}}])
  assert.throws(()=>assertNextContainerBinding({...args,...change}));
});

test('an existing database, existing role or changed PG instance stops before creation',()=>{
 assert.doesNotThrow(()=>assertFreshR07Cluster(identity,'12345'));
 for(const value of [{...identity,databaseExists:true},{...identity,rolesExist:true},{...identity,systemIdentifier:'999'},
   {...identity,version:150000},{...identity,superuser:false}])assert.throws(()=>assertFreshR07Cluster(value,'12345'));
});

test('creation keeps per-step intent and stops on unknown outcome without cleanup or retry',async()=>{
 const commands=[],events=[],client={query:async sql=>{commands.push(sql);if(commands.length===3)throw Object.assign(Error('connection lost'),{code:'ECONNRESET'});}};
 const passwords={migration:'m'.repeat(32),runtime:'r'.repeat(32)};
 await assert.rejects(createR07Database(client,passwords,'b'.repeat(24),event=>events.push(event)));
 assert.equal(commands.length,3);assert.deepEqual(events.at(-1),{stage:'database',status:'INTENT'});
 assert(commands.every(sql=>!/^\s*(DROP|TRUNCATE)\b/i.test(sql)));
 assert(!JSON.stringify(events).includes(passwords.migration));assert(!JSON.stringify(events).includes(passwords.runtime));
});

test('successful creation acknowledges each forward-only step',async()=>{
 const commands=[],events=[],client={query:async sql=>{commands.push(sql);}};
 await createR07Database(client,{migration:'m'.repeat(32),runtime:'r'.repeat(32)},'b'.repeat(24),event=>events.push(event));
 assert.equal(commands.length,7);assert.equal(events.length,14);assert(events.every((event,i)=>event.status===(i%2?'ACK':'INTENT')));
 assert(commands.every(sql=>!/^\s*(DROP|TRUNCATE)\b/i.test(sql)));
});

test('registration defaults to an offline plan',()=>{
 const p=spawnSync(process.execPath,[new URL('./register-round07-target.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});
 assert.equal(p.status,0);const x=JSON.parse(p.stdout);assert.equal(x.status,'PLAN_ONLY');assert.equal(x.connections,0);assert.equal(x.targetWrites,0);
});
