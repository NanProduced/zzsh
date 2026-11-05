import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {validateLegacyListedExecutionPlan} from './legacy-listed-execution-plan.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),canonical=x=>JSON.stringify(x);
function fixture(){
 const sourceCanonical='{"id":"1"}',policyCanonical='{"evidence":"fixture"}',sourceDigest=sha(sourceCanonical),proofSha256=sha(policyCanonical),sourceReceiptSha256='a'.repeat(64);
 const authorityCanonical='{"synthetic":"test-only"}',policyAuthoritySha256=sha(authorityCanonical);
 const intake={accountId:'account',isFullPayout:'1',source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_rental_accounts',legacyId:'1',sourceDigest},legacyQuoteEvidence:{sourceCanonical,policyCanonical,policyBinding:{proofSha256,sourceReceiptSha256,sourceId:'1',sourceDigest,expectedAccountCount:1,authorityCanonical,authoritySha256:policyAuthoritySha256}}};
 return {schema:'zzsh.legacy-listed-execution-plan.v2',target:{oid:'1'},compiled:{api:'hash'},sourceAccountCount:1,policyBundleSha256:proofSha256,sourceReceiptSha256,policyAuthoritySha256,
  rows:[{sourceId:'1',body:{intake},scope:'scope',key:'key',fingerprint:'fingerprint',sourceQuoteDigest:'b'.repeat(64),policyDigest:'c'.repeat(64)}]};
}
const binding=()=>({scope:'scope',key:'key',fingerprint:'fingerprint'}),check=x=>validateLegacyListedExecutionPlan(x,{oid:'1'},{api:'hash'},canonical,binding);
test('complete source-bound full-payout batch passes and partial, duplicate or changed evidence stops before execution',()=>{
 const x=fixture();assert.equal(check(x).length,1);
 for(const mutate of [p=>{p.rows[0].blocked='BLOCKED';},p=>{p.rows[0].body.intake.legacyQuoteEvidence.sourceCanonical='{}';},p=>{p.rows[0].body.intake.legacyQuoteEvidence.policyCanonical='{}';},p=>{p.rows[0].body.intake.legacyQuoteEvidence.policyBinding.sourceId='2';},p=>{p.rows[0].body.intake.isFullPayout='2';},p=>{p.rows[0].key='changed';},p=>{p.sourceAccountCount=2;},p=>{p.rows.push(structuredClone(p.rows[0]));p.sourceAccountCount=2;}]){const changed=structuredClone(x);mutate(changed);assert.throws(()=>check(changed));}
});
