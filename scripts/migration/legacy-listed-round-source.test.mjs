import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRoundSourceProof,validateRoundTrialReceipt,validateRoundAccountSet} from './legacy-listed-round-source.mjs';
const canonical=x=>JSON.stringify(x);
function fixture(){
 const target={oid:'123',nonce:'a'.repeat(24),migrationRoleOid:'77',bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'};
 const round={schema:'zzsh.local-round.v1',target,source:{path:'E:/zzsh-local-state/restricted/source',sha256:'src'},dataset:{sha256:'data'},display:{sha256:'display'},paths:{sha256:'paths'},holdingOverlay:{sha256:'overlay'},actor:{path:'E:/zzsh-local-state/restricted/actor.json',sha256:'actor'},credentials:'E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/regression_test/credentials.json',apiDist:'E:/zzsh/runtime/api/dist/src',buildFiles:{'supply/content-hash.js':'built'}};
 const core={status:'DATASET_AND_GROWTH_ACK_READBACK_PASS',completion:{status:'COMPLETE'},inputSha256:'round',datasetSha256:'data',target};
 const audit={status:'OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN',dbConnections:0,targetWrites:0,sourceReceiptSha256:'src',r06DatasetManifestSha256:'data',sourceBindingSha256:'origin',policyBundleCanonicalSha256:'policy',policyAuthorityCanonicalSha256:'authority',r06AccountsSha256:'accounts',r06DisplayFileSha256:'display-file',r06PathsFileSha256:'paths-file',skinOverlaySha256:'overlay',accounts:[{}]};
 const binding={schema:'zzsh.legacy-listed-round-binding.v1',roundInputSha256:'round',sourceBindingSha256:'origin',policyBundleSha256:'policy',policyAuthoritySha256:'authority',sourceDir:round.source.path,loaderSha256:'loader',helperSha256:'helper',creditGuaranteeEnabled:false,expectedAccountCount:1,window:{notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z'}};
 const observed={oid:'123',nonce:target.nonce,credentials:round.credentials,actorFile:round.actor.path,apiDist:round.apiDist,actorSha256:'actor',resource:{database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',oid:'123',nonce:target.nonce,roles:{migration:{oid:'77'}}},sourceReceiptSha256:'src',datasetManifestSha256:'data',displayManifestSha256:'display',pathsReceiptSha256:'paths',accountFileSha256:'accounts',datasetAccountSha256:'accounts',userFileSha256:'users',datasetUserSha256:'users',displayFileSha256:'display-file',pathsFileSha256:'paths-file',holdingOverlaySha256:'overlay',sourceBindingSha256:'origin',policyBundleSha256:'policy',policyAuthoritySha256:'authority',loaderSha256:'loader',helperSha256:'helper',creditGuaranteeEnabled:false,compiled:{'supply/content-hash':'built'},now:Date.parse('2026-11-05T00:00:00.000Z')};
 return {binding,round,core,audit,observed};
}
const check=x=>validateRoundSourceProof(x.binding,x.round,x.core,x.audit,x.observed,canonical);
test('accepts a complete round/source/build/actor binding',()=>assert.equal(check(fixture()),true));
test('rejects altered target, role, actor, source, build, policy or guarantee mode',()=>{
 const mutations=[x=>x.observed.oid='999',x=>x.observed.nonce='b'.repeat(24),x=>x.observed.resource.roles.migration.oid='78',x=>x.observed.actorSha256='other',x=>x.observed.sourceReceiptSha256='other',x=>x.observed.accountFileSha256='other',x=>x.observed.userFileSha256='other',x=>x.observed.displayFileSha256='other',x=>x.observed.pathsFileSha256='other',x=>x.observed.holdingOverlaySha256='other',x=>x.observed.compiled['supply/content-hash']='other',x=>x.observed.policyBundleSha256='other',x=>x.observed.policyAuthoritySha256='other',x=>x.observed.helperSha256='other',x=>x.observed.loaderSha256='other',x=>x.observed.creditGuaranteeEnabled=true];
 for(const mutate of mutations){const x=fixture();mutate(x);assert.throws(()=>check(x),/LISTED_ROUND_(BINDING|BUILD)_CHANGED/)}
});
test('requires successful core receipt and independent offline audit',()=>{
 for(const mutate of [x=>x.core.status='STOPPED',x=>x.core.completion.status='INCOMPLETE',x=>x.core.inputSha256='other',x=>x.audit.dbConnections=1,x=>x.audit.targetWrites=1,x=>x.audit.accounts=[]]){const x=fixture();mutate(x);assert.throws(()=>check(x),/LISTED_ROUND_BINDING_CHANGED/)}
});
test('expired window refuses writes but permits read-only recovery',()=>{
 const x=fixture();x.observed.now=Date.parse('2027-01-02T00:00:00.000Z');assert.throws(()=>check(x),/WINDOW_INACTIVE/);x.observed.allowExpiredReadOnly=true;assert.equal(check(x),true);
});
test('trial must match exact target, plan, order, complete results and rollbacks',()=>{
 const target={oid:'123'},rows=[{sourceId:'a'},{sourceId:'b'}],receipt={inputSha:'plan',target,results:[{sourceId:'a',state:'READY'},{sourceId:'b',state:'ALREADY_PUBLISHED'}],rollbackAcknowledged:2};
 assert.equal(validateRoundTrialReceipt(receipt,'plan',target,rows,canonical),true);
 for(const mutate of [x=>x.inputSha='other',x=>x.target.oid='other',x=>x.rollbackAcknowledged=1,x=>x.results[1].state='REJECTED',x=>x.results.reverse(),x=>x.results.pop()]){const x=structuredClone(receipt);mutate(x);assert.throws(()=>validateRoundTrialReceipt(x,'plan',target,rows,canonical),/TRIAL_RECEIPT_NOT_COMPLETE/)}
});

test('plan, audited scope and policy must contain exactly the same unique accounts and digests',()=>{
 const d='a'.repeat(64),plan={listings:[{sourceId:'1',sourceDigest:d}]},audit={accounts:[{sourceId:'1',sourceDigest:d}]},policy={supplement:{accountSourceDigests:[{id:'1',sha256:d}]}};
 assert.equal(validateRoundAccountSet(plan,audit,policy,1),true);
 for(const mutate of [x=>x.plan.listings=[],x=>x.plan.listings[0].sourceDigest='b'.repeat(64),x=>x.audit.accounts[0].sourceId='2',x=>x.policy.supplement.accountSourceDigests[0].id='2']){
  const x=structuredClone({plan,audit,policy});mutate(x);assert.throws(()=>validateRoundAccountSet(x.plan,x.audit,x.policy,1),/ACCOUNT_SET_CHANGED/);
 }
 const execution={rows:[{sourceId:'1',body:{intake:{source:{sourceDigest:d}}}}]};assert.equal(validateRoundAccountSet(execution,audit,policy,1),true);
});
