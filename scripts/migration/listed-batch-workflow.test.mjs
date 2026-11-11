import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runListedBatchWorkflow} from './listed-batch-workflow.mjs';

function fixture(fail){
 const calls=[],events=[],steps={};
 for(const name of ['prepareSource','prepareTarget','trial','execute','readback','finalize','emptyReadback'])steps[name]=async value=>{
  const index=typeof value==='number'?value:value?.index??null;calls.push([name,index]);
  if(fail?.name===name&&fail.index===index)throw Error('SYNTHETIC_STOP');return {name,index};
 };
 return {calls,events,steps,record:async event=>events.push(event)};
}
test('listed batch runner defaults to planning and refuses an incomplete execute command',()=>{
 const script=fileURLToPath(new URL('./run-listed-batches.mjs',import.meta.url)),plan=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000});
 assert.equal(plan.status,0,plan.stderr);assert.deepEqual([JSON.parse(plan.stdout).status,JSON.parse(plan.stdout).connections,JSON.parse(plan.stdout).targetWrites],['PLAN_ONLY',0,0]);
 const invalid=spawnSync(process.execPath,[script,'--execute'],{encoding:'utf8',timeout:5000});assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/LISTED_RUN_ARGUMENTS_INVALID/);
});
test('all batches are prepared and trialled before writing, then independently read back',async()=>{
 const x=fixture(),result=await runListedBatchWorkflow({batchCount:3,steps:x.steps,record:x.record});
 assert.equal(result.name,'finalize');assert.deepEqual(x.calls.map(call=>call[0]),['prepareSource','prepareSource','prepareSource','prepareTarget','prepareTarget','prepareTarget','trial','trial','trial','execute','readback','execute','readback','execute','readback','finalize']);
 assert.equal(x.events.length,32);assert.deepEqual(x.events.at(-1),{stage:'all-batch-readback',index:null,status:'ACK',result:{name:'finalize',index:null}});
});
test('trial failure stops before any target write; an uncertain write is never retried',async()=>{
 for(const fail of [{name:'trial',index:2},{name:'execute',index:2},{name:'readback',index:1}]){
  const x=fixture(fail);await assert.rejects(runListedBatchWorkflow({batchCount:3,steps:x.steps,record:x.record}),/SYNTHETIC_STOP/);
  if(fail.name==='trial')assert(!x.calls.some(call=>call[0]==='execute'));
  if(fail.name==='execute')assert.equal(x.calls.filter(call=>call[0]==='execute'&&call[1]===2).length,1);
  assert(!x.calls.some(call=>call[0]==='finalize'));assert.equal(x.events.at(-1).status,'INTENT');
 }
});
test('a failed post-commit journal update stops without a second write',async()=>{
 const x=fixture(),record=async event=>{x.events.push(event);if(event.stage==='execute'&&event.status==='ACK')throw Error('SYNTHETIC_JOURNAL_FAILURE');};
 await assert.rejects(runListedBatchWorkflow({batchCount:2,steps:x.steps,record}),/SYNTHETIC_JOURNAL_FAILURE/);
 assert.equal(x.calls.filter(call=>call[0]==='execute').length,1);assert(!x.calls.some(call=>call[0]==='readback'||call[0]==='finalize'));
});
test('empty source uses its own readback and never starts a publication',async()=>{
 const x=fixture(),result=await runListedBatchWorkflow({batchCount:0,steps:x.steps,record:x.record});
 assert.equal(result.name,'emptyReadback');assert.deepEqual(x.calls,[['emptyReadback',null]]);
 await assert.rejects(runListedBatchWorkflow({batchCount:1,steps:{},record:x.record}),/LISTED_WORKFLOW_INVALID/);
});
