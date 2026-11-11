import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runLocalSourceStages } from './run-local-source-workflow.mjs';
import { assertRoundSourceOrigin } from './local-round-contract.mjs';
import { assertNextSourceTools, NEXT_SOURCE_SCRIPTS } from './local-round-dependencies.mjs';
import { NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';
import { captureBoundLegacyBankSource, releaseBoundLegacyBankSource, useBoundLegacyBankSource } from './local-legacy-bank-source.mjs';

test('source stages preserve dependencies and do not report completion before verification',async()=>{
 const calls=[],values=Object.fromEntries(['prepare','restore','capture','finance','refund'].map(name=>[name,{name}]));
 const step=async(name,...args)=>{calls.push(name);if(name==='restore')assert.equal(args[0],values.prepare);
  if(name==='capture')assert.equal(args[0],values.restore);if(name==='finance'||name==='refund'){assert.equal(args[0],values.restore);assert.equal(args[1],values.capture);}return values[name];};
 const result=await runLocalSourceStages(step,async input=>{calls.push('verify');assert.deepEqual(input,{prepared:values.prepare,restored:values.restore,source:values.capture,funds:values.finance,refund:values.refund});return 'verified';});
 assert.equal(result,'verified');assert.deepEqual(calls,['prepare','restore','capture','finance','refund','verify']);
});
test('any failed source stage stops immediately without retries or verification',async()=>{
 for(const failed of ['prepare','restore','capture','finance','refund']){
  const calls=[];await assert.rejects(runLocalSourceStages(async name=>{calls.push(name);if(name===failed)throw Error('synthetic failure');return {};},async()=>{calls.push('verify');}),/synthetic failure/);
  assert.equal(calls.at(-1),failed);assert.equal(calls.filter(name=>name===failed).length,1);assert(!calls.includes('verify'));
 }
});
test('source workflow defaults to a no-write plan and rejects malformed execution arguments',()=>{
 const path=fileURLToPath(new URL('./run-local-source-workflow.mjs',import.meta.url)),plan=spawnSync(process.execPath,[path],{encoding:'utf8'});
 assert.equal(plan.status,0);const p=JSON.parse(plan.stdout);assert.equal(p.status,'PLAN_ONLY');assert.equal(p.targetWrites,0);assert.equal(p.automaticCleanup,false);
 const invalid=spawnSync(process.execPath,[path,'--execute','--input','missing','--input-sha','0'.repeat(64),'--extra','x'],{encoding:'utf8'});
 assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/SOURCE_WORKFLOW_ARGUMENTS_INVALID/);
});

test('registered synthetic MySQL source workflow binds captured facts and refuses mismatched round evidence',
 {skip:!process.env.ZZSH_SYNTH_SOURCE_WORKFLOW_INPUT&&!process.env.ZZSH_SYNTH_SOURCE_WORKFLOW_SHA,timeout:180000},async()=>{
 const inputPath=process.env.ZZSH_SYNTH_SOURCE_WORKFLOW_INPUT,inputSha=process.env.ZZSH_SYNTH_SOURCE_WORKFLOW_SHA,hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 assert(isAbsolute(inputPath??'')&&resolve(inputPath).toLowerCase().startsWith(resolve('E:/zzsh-local-state/restricted/migration-source-workflow-synth-').toLowerCase())&&/^[a-f0-9]{64}$/.test(inputSha??''));
 const bytes=readFileSync(inputPath);assert.equal(hash(bytes),inputSha);const spec=JSON.parse(bytes);
 assert(/^next-synth-[a-z0-9-]+$/.test(spec.suffix??'')&&isAbsolute(spec.dump??'')&&resolve(spec.dump).toLowerCase().includes('migration-mysql-fixture-')&&spec.dump.endsWith('synthetic.sql'));
 const path=fileURLToPath(new URL('./run-local-source-workflow.mjs',import.meta.url));
 const run=spawnSync(process.execPath,[path,'--execute','--input',inputPath,'--input-sha',inputSha],{encoding:'utf8',timeout:180000,maxBuffer:65536,windowsHide:true});
 assert.equal(run.status,0,'SYNTHETIC_SOURCE_WORKFLOW_FAILED');const output=JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));assert.equal(output.status,'SOURCE_CAPTURED_DATASET_NOT_PREPARED');
 const workflowBytes=readFileSync(output.receipt),workflow=JSON.parse(workflowBytes),readRef=ref=>{const file=ref.path.endsWith('.json')?ref.path:ref.path+'/receipt.json',b=readFileSync(file);assert.equal(hash(b),ref.sha256);return JSON.parse(b);};
 const source=readRef(workflow.result.source),funds=readRef(workflow.result.funds),refund=readRef(workflow.result.refundAttempts),binding=readRef(workflow.result.sourceBinding);
 const round={target:{migrationProfile:NEXT_MIGRATION_PROFILE},...workflow.result,sourceWorkflow:{path:output.receipt,sha256:hash(workflowBytes)}},dataset={sourceReceiptSha256:round.source.sha256,
  sourceCutoff:binding.restoreRecord.cutoff,sourceOrigin:{bindingSha256:round.sourceBinding.sha256,dumpSha256:binding.restoreRecord.dumpSha256}};
 assertRoundSourceOrigin(round,source,dataset,binding,funds,refund,workflow,spec);
 const files=Object.fromEntries([...NEXT_SOURCE_SCRIPTS,'local-source-adapter.mjs','../local-auth.mjs'].map(name=>[name,hash(readFileSync(new URL(name,import.meta.url)))]));
 assertNextSourceTools(round,binding,[source,funds,refund],files,workflow);
 assert.throws(()=>assertRoundSourceOrigin(round,source,{...dataset,sourceOrigin:{...dataset.sourceOrigin,dumpSha256:'0'.repeat(64)}},binding,funds,refund,workflow,spec));
 const token=await captureBoundLegacyBankSource({sourceDir:round.source.path,sourceReceiptSha256:round.source.sha256,sourceBinding:round.sourceBinding.path,sourceBindingSha256:round.sourceBinding.sha256},JSON.stringify);
 try{assert.equal(useBoundLegacyBankSource(token).rows.length,1);}finally{releaseBoundLegacyBankSource(token);}
 assert.equal(Object.keys(source.files).length,18);assert.equal(workflow.targetWrites,0);
});
