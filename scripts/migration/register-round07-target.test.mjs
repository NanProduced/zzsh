import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertFreshR07Cluster, assertR07Container, createR07Database } from './register-round07-target.mjs';

const id='a'.repeat(64),container={Id:id,Config:{Labels:{'zzsh.task':'round07-migration'}},State:{Running:true},NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55433'}]}}};
const identity={database:'postgres',role:'zzsh',superuser:true,version:160013,systemIdentifier:'12345',databaseExists:false,rolesExist:false};

test('only a uniquely identified loopback R07 container is accepted',()=>{
 assert.doesNotThrow(()=>assertR07Container(container,id));
 assert.throws(()=>assertR07Container({...container,Id:'b'.repeat(64)},id));
 assert.throws(()=>assertR07Container({...container,Config:{Labels:{}}},id));
 assert.throws(()=>assertR07Container({...container,NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'0.0.0.0',HostPort:'55433'}]}}},id));
 assert.throws(()=>assertR07Container({...container,State:{Running:false}},id));
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
