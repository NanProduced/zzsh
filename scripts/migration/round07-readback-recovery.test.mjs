import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { assertReadbackRecoveryOverlay, assertReviewedGrowthRuleFiles, assertGrowthRuleRetry, verifyResumeSchema } from './local-round-contract.mjs';

test('R07 growth rules must exist under the reviewed source root and match their digests',()=>{
 const root=resolve('fixture/analysis'),file=resolve(root,'front/Rule.java'),bytes=Buffer.from('rule'),digest=createHash('sha256').update(bytes).digest('hex');
 const io={root,read:()=>bytes,stat:()=>({isFile:()=>true,isSymbolicLink:()=>false})};
 assert.equal(assertReviewedGrowthRuleFiles({[file]:digest},io),true);
 for(const invalid of [null,{}, {[resolve(root,'../other/Rule.java')]:digest}, {[file]:'0'.repeat(64)}])assert.throws(()=>assertReviewedGrowthRuleFiles(invalid,io));
 assert.throws(()=>assertReviewedGrowthRuleFiles({[file]:digest},{...io,stat:()=>({isFile:()=>true,isSymbolicLink:()=>true})}),/REVIEWED_OLD_RULE_FILE_UNSAFE/);
});

test('recovery preserves original lineage and only permits the four sealed readback repairs',()=>{
 const changed=['local-funds-plan.mjs','local-round-contract.mjs','readback-local-dataset.mjs','run-local-round.mjs'].sort(),names=[...changed,'local-target-registry.mjs','../local-auth.mjs'];
 const originalFiles=Object.fromEntries(names.map(name=>[name,'a'.repeat(64)])),observedFiles=Object.fromEntries(names.map(name=>[name,(changed.includes(name)?'b':'a').repeat(64)]));
 const input={target:{bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'},resume:{schema:'zzsh.local-round-growth-resume.v1',previousInput:{sha256:'1'.repeat(64)},previousReceipt:{sha256:'2'.repeat(64)},checkpoint:{sha256:'3'.repeat(64)}}};
 const stages=['core-and-funds','display','opening','holdings','paths'].map(name=>({name,status:'ACK',code:0,signal:null}));stages.push({name:'readback',status:'INTENT',code:1,signal:null});
 const previousReceipt={status:'STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS',failure:{stage:'readback'},stages},scriptDir='fixture',proofSha256='4'.repeat(64);
 const manifest={schema:'zzsh.round07-readback-recovery-overlay.v1',scriptDir,previousInputSha256:input.resume.previousInput.sha256,previousReceiptSha256:input.resume.previousReceipt.sha256,checkpointSha256:input.resume.checkpoint.sha256,dependencyProofSha256:proofSha256,changed,files:Object.fromEntries(names.map(name=>[name,{before:originalFiles[name],after:observedFiles[name]}]))};
 const binding={input,previousReceipt,originalFiles,observedFiles,scriptDir,proofSha256};
 assert.equal(assertReadbackRecoveryOverlay(manifest,binding).status,'READBACK_RECOVERY_OVERLAY_BOUND');
 for(const bad of [
  {...binding,proofSha256:'5'.repeat(64)},
  {...binding,observedFiles:{...observedFiles,'local-target-registry.mjs':'c'.repeat(64)}},
  {...binding,previousReceipt:{...previousReceipt,stages:[...stages,{name:'growth-apply',status:'INTENT'}]}},
  {...binding,input:{...input,target:{bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'}}},
 ])assert.throws(()=>assertReadbackRecoveryOverlay(manifest,bad),/ROUND_READBACK_RECOVERY_OVERLAY_INVALID/);
 assert.throws(()=>assertReadbackRecoveryOverlay({...manifest,changed:[...changed,'local-target-registry.mjs']},binding),/ROUND_READBACK_RECOVERY_OVERLAY_INVALID/);
});

test('resume schema preflight verifies the real PostgreSQL cluster identity',async()=>{
 const target={oid:'123',nonce:'a'.repeat(24),migrationRoleOid:'42',schemaHashes:['b'.repeat(64)],instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123456'}};
 const client=id=>({async connect(){},async query(sql){if(sql.startsWith('SELECT current_database'))return{rows:[{database:'zzsh_test_regression',oid:target.oid,nonce:target.nonce,owner:'zzsh',marker:'zzsh:regression-test:v1',role:'migration',role_oid:'42',read_only:'on',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,system_identifier:id}]};if(sql.startsWith('SELECT hash'))return{rows:target.schemaHashes.map(hash=>({hash}))};return{command:sql}},async end(){}});
 assert.equal((await verifyResumeSchema(client('123456'),{target,migrationName:'migration'})).status,'LIVE_SCHEMA_READ_ONLY_VERIFIED');
 await assert.rejects(verifyResumeSchema(client('999999'),{target,migrationName:'migration'}),/ROUND_RESUME_LIVE_TARGET_CHANGED/);
});

test('a rules-only retry preserves the failed read-only growth attempt and cannot hide writes or drift',()=>{
 const h='a'.repeat(64),target={oid:'12',nonce:'b'.repeat(24),instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}},dataset={sha256:h};
 const previousInput={schema:'zzsh.local-round.v1',out:'old',target,dataset,growth:{policyId:'p'},resume:{readbackRepair:{sha256:'1'.repeat(64)}}};
 const refs=Object.fromEntries(['input','receipt','summary','readback','rulesEvidence'].map(key=>[key,{path:key,sha256:h}]));
 const rules={'E:/zzsh/analysis/old.java':'c'.repeat(64)},input=structuredClone(previousInput);input.out='new';input.growth.oldRuleFiles=rules;input.resume.readbackRepair={sha256:'2'.repeat(64)};input.resume.previousRepair=refs;
 const previousReceipt={schema:'zzsh.local-round-receipt.v1',mode:'RESUME_GROWTH',status:'STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS',inputSha256:h,failure:{stage:'growth-prepare'},stages:[{name:'schema-preflight',status:'ACK',code:0,signal:null},{name:'readback',status:'ACK',code:0,signal:null,metrics:{evidenceSha256:h}},{name:'growth-prepare',status:'INTENT',code:1}]};
 const summary={schema:'zzsh.local-growth-round-receipt.v1',mode:'--prepare',inputSha256:h,status:'STOPPED_PRESERVE_ORIGINAL_EVIDENCE',error:{message:'REVIEWED_OLD_RULE_FILES_REQUIRED'},readOnlyRollbackAck:true,readOnlyClientClosed:true,fundsWrites:0,oid:target.oid,nonce:target.nonce};
 const readback={schema:'zzsh.local-dataset-readback.v1',status:'CORE_SOURCE_TARGET_EXACT_READBACK_PASSED',differenceCount:0,targetWrites:0,rollbackConfirmed:true,lockReleased:true,connectionsClosed:true,sourceDatasetSha256:h,resource:target},rulesEvidence={growth:{oldRuleFiles:rules}};
 const args={input,previousInput,previousReceipt,summary,readback,rulesEvidence};assert.equal(assertGrowthRuleRetry(args).status,'READ_ONLY_GROWTH_PREPARATION_FAILURE_BOUND');
 for(const changed of [{...args,summary:{...summary,fundsWrites:1}},{...args,summary:{...summary,readOnlyRollbackAck:false}},{...args,readback:{...readback,differenceCount:1}},{...args,rulesEvidence:{growth:{oldRuleFiles:{}}}}])assert.throws(()=>assertGrowthRuleRetry(changed),/ROUND_GROWTH_RULE_RETRY_UNCONFIRMED/);
 const drift=structuredClone(input);drift.target.oid='99';assert.throws(()=>assertGrowthRuleRetry({...args,input:drift}),/ROUND_GROWTH_RULE_RETRY_UNCONFIRMED/);
});
