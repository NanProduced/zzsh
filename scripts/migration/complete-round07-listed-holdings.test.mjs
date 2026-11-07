import assert from 'node:assert/strict';import { spawnSync } from 'node:child_process';import { fileURLToPath } from 'node:url';import test from 'node:test';
import { applyHoldingTransaction, assertHoldingTrial, listedHoldingMode } from './complete-round07-listed-holdings.mjs';
test('execute trial receipt flag is distinct from the trial mode',()=>{
 assert.equal(listedHoldingMode(['--trial','--input','plan.json']),'--trial');
 assert.equal(listedHoldingMode(['--execute','--trial-receipt','trial.json','--trial-sha','hash']),'--execute');
 assert.throws(()=>listedHoldingMode(['--execute','--trial','trial.json']),/R07_HOLDING_MODE_INVALID/);
});
test('listed holding trial must match every missing account and acknowledged rollback',()=>{
 const plan={target:{oid:'1'},rows:[{sourceId:'1',alreadyPresent:false},{sourceId:'2',alreadyPresent:true}]};
 const trial={schema:'zzsh.round07-listed-holdings-trial.v1',status:'ALL_ROLLED_BACK',planSha256:'x',target:plan.target,sourceIds:['1'],rollbackAck:true,lockReleased:true,connectionsClosed:true};
 assert.doesNotThrow(()=>assertHoldingTrial(plan,trial,'x'));for(const changed of [{rollbackAck:false},{sourceIds:[]},{planSha256:'other'}])assert.throws(()=>assertHoldingTrial(plan,{...trial,...changed},'x'));
});
test('all holding writes share a transaction, and failures preserve commit uncertainty',async()=>{
 const commands=[],saved=[],client={query:async sql=>{commands.push(sql);return{command:sql}}};
 const success=await applyHoldingTransaction({client,rows:[1,2],apply:async row=>commands.push('WRITE '+row),save:s=>saved.push(structuredClone(s))});
 assert.equal(success.status,'COMMIT_ACK');assert.deepEqual(commands,['BEGIN','WRITE 1','WRITE 2','COMMIT']);assert.equal(saved[0].status,'COMMIT_INTENT');
 const before=[],state=[];await assert.rejects(applyHoldingTransaction({client:{query:async sql=>{before.push(sql);return{command:sql}}},rows:[1],apply:async()=>{throw Error('reject')},save:s=>state.push(structuredClone(s))}));
 assert.deepEqual(before,['BEGIN','ROLLBACK']);assert.equal(state.at(-1).status,'STOPPED_BEFORE_COMMIT');assert.equal(state.at(-1).rollbackAck,true);
 const lost=[],unknown=[];await assert.rejects(applyHoldingTransaction({client:{query:async sql=>{lost.push(sql);if(sql==='COMMIT')throw Error('lost');return{command:sql}}},rows:[1],apply:async()=>{},save:s=>unknown.push(structuredClone(s))}));
 assert.deepEqual(lost,['BEGIN','COMMIT']);assert.equal(unknown.at(-1).status,'COMMIT_UNKNOWN');
});
test('listed holding helper defaults to no connections',()=>{const p=spawnSync(process.execPath,[fileURLToPath(new URL('./complete-round07-listed-holdings.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(p.status,0);assert.equal(JSON.parse(p.stdout).connections,0);});
