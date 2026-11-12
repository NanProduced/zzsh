import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeR07DistributionCandidate } from './prepare-round07-distribution-candidate.mjs';
import { legacyDistributionPolicy, loadLegacyDistributionPrerequisite, normalizedDistributionPolicyFormat, validatedLegacyDistributionPayload, verifyLegacyDistributionPrerequisite } from './local-distribution-qualification-plan.mjs';

test('candidate retains exact source rows required by the read-only qualification planner',()=>{
 const digest='a'.repeat(64),source={receiptSha256:digest,configurationSha256:digest,levelsSha256:digest};
 const values={open:'1',level:'1',openCondition:'1',isSelfRebate:'0',settlementTiming:'1',settlementTime:'7.0'};
 const configuration=Object.entries(values).map(([name,value])=>({name,value,is_delete:'0'}));
 const rawLevels=[{id:'1',weights:'1',is_default:'1',first_ratio:'20.00',second_ratio:'20.00',name:'青铜',is_delete:'0'}];
 const result=makeR07DistributionCandidate(source,configuration,rawLevels);
 assert.deepEqual(result.configuration,configuration);assert.deepEqual(result.rawLevels,rawLevels);
 assert.deepEqual(result.approvalPayloads,[legacyDistributionPolicy({scope:'NATIVE',...source,configuration,rawLevels})]);
 assert.throws(()=>makeR07DistributionCandidate(source,undefined,rawLevels));
 assert.throws(()=>makeR07DistributionCandidate(source,configuration,undefined));
});

test('distribution candidate binds the bytes actually consumed and refuses changed source files', {skip:process.platform!=='win32'||!existsSync('E:/zzsh-local-state/restricted')}, async t=>{
 const sha=value=>createHash('sha256').update(value).digest('hex'),dir=mkdtempSync('E:/zzsh-local-state/restricted/distribution-source-synthetic-');
 const source=join(dir,'source'),out=join(dir,'out'),badOut=join(dir,'bad'),configFile=join(source,'config.jsonl'),levelsFile=join(source,'levels.jsonl'),receiptFile=join(source,'receipt.json');
 mkdirSync(source);t.after(()=>{for(const file of [join(out,'candidate.json'),configFile,levelsFile,receiptFile])if(existsSync(file))unlinkSync(file);for(const path of [out,badOut,source,dir])if(existsSync(path))rmdirSync(path)});
 const values={open:'1',level:'1',openCondition:'1',isSelfRebate:'0',settlementTiming:'1',settlementTime:'7.0'};
 const configuration=Object.entries(values).map(([name,value])=>({name,value,is_delete:'0'})),levels=[{id:'1',weights:'1',is_default:'1',first_ratio:'20.00',second_ratio:'20.00',name:'青铜',is_delete:'0'}];
 const config=Buffer.from(configuration.map(row=>JSON.stringify(row)).join('\n')+'\n'),levelBytes=Buffer.from(levels.map(row=>JSON.stringify(row)).join('\n')+'\n');
 writeFileSync(configFile,config);writeFileSync(levelsFile,levelBytes);
 const receipt=Buffer.from(JSON.stringify({status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{
  distributionConfig:{file:'config.jsonl',sha256:sha(config),rows:configuration.length},distributionLevels:{file:'levels.jsonl',sha256:sha(levelBytes),rows:levels.length}}}));
 writeFileSync(receiptFile,receipt);
 const require=createRequire(import.meta.url),{canonicalize}=require('../../apps/api/dist/src/supply/content-hash.js'),
  {parseDistributionPolicyChange}=require('../../apps/api/dist/src/finance/distribution-policy-change.js');
 const proof=await verifyLegacyDistributionPrerequisite({sourceDir:source,receipt:JSON.parse(receipt),sourceSha256:sha(receipt),canonicalize,parsePolicy:parseDistributionPolicyChange});
 assert.equal(proof.status,'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN');assert.equal(proof.activeLevels,1);assert.equal(proof.settlementDelayDays,7);assert.equal(proof.targetWrites,0);
 const loaded=await loadLegacyDistributionPrerequisite({sourceDir:source,receipt:JSON.parse(receipt),sourceSha256:sha(receipt),canonicalize,parsePolicy:parseDistributionPolicyChange});
 assert.deepEqual(loaded.summary,proof);assert.equal(loaded.payload.config.legacySource.receiptSha256,sha(receipt));
 const sourceRef={receiptSha256:sha(receipt),configurationSha256:sha(config),levelsSha256:sha(levelBytes)},candidate=makeR07DistributionCandidate(sourceRef,configuration,levels);
 assert.equal(candidate.rawLevels[0].first_ratio,'20.00');
 const normalized=parseDistributionPolicyChange(candidate.approvalPayloads[0]);assert.equal(normalized.config.levels[0].renterPercent,'20');
 assert.deepEqual(validatedLegacyDistributionPayload(candidate.approvalPayloads[0],parseDistributionPolicyChange,canonicalize,true),normalized);
 assert.deepEqual(loaded.payload,normalized);
 assert.throws(()=>validatedLegacyDistributionPayload(candidate.approvalPayloads[0],parseDistributionPolicyChange,canonicalize,false),/DISTRIBUTION_POLICY_INVALID/);
 assert.equal(proof.policyDigest,sha(canonicalize(normalized.config)));
 assert.equal(normalizedDistributionPolicyFormat('SOURCE_API_NORMALIZED_V1',{distributionSourcePreflight:proof}),true);
 assert.equal(normalizedDistributionPolicyFormat(undefined,{}),false);
 assert.throws(()=>normalizedDistributionPolicyFormat(undefined,{distributionSourcePreflight:proof}),/DISTRIBUTION_POLICY_FORMAT_REQUIRED/);
 assert.throws(()=>normalizedDistributionPolicyFormat('SOURCE_API_NORMALIZED_V1',{}),/DISTRIBUTION_POLICY_FORMAT_UNPROVEN/);
 const run=destination=>spawnSync(process.execPath,[new URL('./prepare-round07-distribution-candidate.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),
  '--prepare','--source',source,'--source-sha',sha(receipt),'--out',destination],{encoding:'utf8',windowsHide:true});
 const first=run(out);assert.equal(first.status,0,first.stderr);assert.deepEqual(JSON.parse(readFileSync(join(out,'candidate.json'))).rawLevels,levels);
 writeFileSync(levelsFile,JSON.stringify({...levels[0],first_ratio:'30.00'})+'\n');
 await assert.rejects(verifyLegacyDistributionPrerequisite({sourceDir:source,receipt:JSON.parse(receipt),sourceSha256:sha(receipt),canonicalize,parsePolicy:parseDistributionPolicyChange}),/SOURCE_STREAM_CHANGED/);
 const changed=run(badOut);assert.equal(changed.status,1);assert(!existsSync(badOut));
 const invalid=Buffer.from(JSON.stringify({...levels[0],first_ratio:'101.00'})+'\n'),invalidReceipt=JSON.parse(receipt);
 writeFileSync(levelsFile,invalid);invalidReceipt.files.distributionLevels.sha256=sha(invalid);
 await assert.rejects(verifyLegacyDistributionPrerequisite({sourceDir:source,receipt:invalidReceipt,sourceSha256:sha(JSON.stringify(invalidReceipt)),canonicalize,parsePolicy:parseDistributionPolicyChange}));
 writeFileSync(levelsFile,levelBytes);writeFileSync(receiptFile,Buffer.from('{}'));
 await assert.rejects(loadLegacyDistributionPrerequisite({sourceDir:source,receipt:JSON.parse(receipt),sourceSha256:sha(receipt),canonicalize,parsePolicy:parseDistributionPolicyChange}),/DISTRIBUTION_PREFLIGHT_RECEIPT_CHANGED/);
});
