import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {validateUpgradeAuthority,validateUpgradeEvidence} from './run-round07-0161-upgrade.mjs';

const sha='a'.repeat(64),target={bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',oid:'42',nonce:'b'.repeat(24),instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}};
test('0161 authority binds one migration, exact instance, no money and a short live window',()=>{
 const now=Date.parse('2026-01-01T00:05:00Z'),a={schema:'zzsh.r07-0161-upgrade-authority.v1',approvedBy:'Root',status:'APPROVED',planSha256:sha,target,operation:'APPLY_0161_ONLY',maxMigrations:1,lock:'806006',allowFinancialWrites:false,notBefore:'2026-01-01T00:00:00Z',expiresAt:'2026-01-01T00:10:00Z',approvalRef:'r',attempt:'1'};
 assert.doesNotThrow(()=>validateUpgradeAuthority(a,sha,target,now));
 for(const patch of [{target:{...target,oid:'43'}},{allowFinancialWrites:true},{maxMigrations:2},{lock:'1'},{expiresAt:'2026-01-01T00:04:00Z'},{expiresAt:'2026-01-01T00:30:00Z'},{approvalRef:''}])assert.throws(()=>validateUpgradeAuthority({...a,...patch},sha,target,now));
});
test('upgrade requires complete rolled-back batches, unchanged preimage and the tested exact SQL',()=>{
 const refs=Object.fromEntries(['previousPlan','previousInput','previousAuthority','failure'].map(k=>[k,{sha256:sha}])),batches=Array.from({length:175},(_,i)=>({bodyDigest:'batch'+i}));
 const round={target,dataset:{sha256:sha},source:{sha256:sha}},previousInput={target,dataset:round.dataset,source:round.source},previousPlan={inputSha256:sha,datasetSha256:sha,sourceDigest:sha,batches},previousAuthority={inputSha256:sha,planSha256:sha};
 const failure={status:'STOPPED',error:{code:'57014'},transaction:{status:'ROLLBACK_ACKNOWLEDGED'},rollbackAck:true,lockReleased:true,clientsClosed:true,financialWrites:0,inputSha256:sha,target,batches:batches.map(b=>({...b,status:'ACK_IN_OPEN_TRANSACTION'}))};
 const inspection={schema:'zzsh.r07-qualification-constraint-analysis.v1',status:'READ_ONLY_CONSTRAINT_ANALYSIS_COMPLETE',previous:{plan:sha,input:sha,authority:sha,failure:sha},target,preimage:{counts:{participants:174846,receipts:0,audits:0,policy_heads:1},mismatches:{accepted:0,ineligible:0,unresolved:0}},rollbackAck:true,clientClosed:true,targetWrites:0};
 const synthetic={status:'SYNTHETIC_TRIGGER_PROOF_PASS',syntheticOnly:true,migrationSha256:sha,migrationReplay:2,cases:['replica-only-participant-guard','replica-only-relation-guard','replica-session','incomplete-trigger-events','mismatched-inviter','mismatched-leader']};
 const args={round,previousPlan,previousInput,previousAuthority,failure,inspection,synthetic,refs,sources:{migrationSha256:sha}};assert.doesNotThrow(()=>validateUpgradeEvidence(args));
 for(const changed of [{...args,failure:{...failure,rollbackAck:false}},{...args,failure:{...failure,batches:failure.batches.slice(1)}},{...args,inspection:{...inspection,preimage:{...inspection.preimage,counts:{...inspection.preimage.counts,receipts:1}}}},{...args,synthetic:{...synthetic,migrationSha256:'b'.repeat(64)}},{...args,round:{...round,target:{...target,oid:'9'}}}])assert.throws(()=>validateUpgradeEvidence(changed));
});
test('upgrade defaults to an offline plan',()=>{const p=spawnSync(process.execPath,[new URL('./run-round07-0161-upgrade.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});assert.equal(p.status,0);assert.equal(JSON.parse(p.stdout).connections,0);});
