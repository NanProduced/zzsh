import assert from 'node:assert/strict';import { spawnSync } from 'node:child_process';import { fileURLToPath } from 'node:url';import test from 'node:test';
import { assertR07BossBinding } from './create-round07-boss-session.mjs';
const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123'},registered={database:'zzsh_test_regression',oid:'42',nonce:'a'.repeat(24),instance};
const resource={database:registered.database,oid:registered.oid,nonce:registered.nonce,instance},binding={status:'R07_BOOTSTRAP_API_LISTENING',port:4242,origins:{apiOrigin:'http://127.0.0.1:4242',adminOrigin:'http://127.0.0.1:4241'},NoIM:true,financialCommandCapabilities:false,workersEnabled:false,resource,actualResource:{...resource,read_only:'on'}};
const actor={realm:'admin',origin:'http://127.0.0.1:4241',username:'zz00001',userId:'admin',password:'synthetic',totp:{encoding:'base32',secret:'JBSWY3DPEHPK3PXP'}};
test('Boss session requires this R07 instance, local runtime and actual Boss profile',()=>{assert.doesNotThrow(()=>assertR07BossBinding(binding,registered,actor));
 for(const change of [x=>{x.port=4232;},x=>{x.workersEnabled=true;},x=>{x.actualResource.instance.systemIdentifier='wrong';}]){const bad=structuredClone(binding);change(bad);assert.throws(()=>assertR07BossBinding(bad,registered,actor));}
 assert.throws(()=>assertR07BossBinding(binding,registered,{...actor,username:'zz00002'}));});
test('Boss helper defaults to a no-connection plan',()=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('./create-round07-boss-session.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).connections,0);});
