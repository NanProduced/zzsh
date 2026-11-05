import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyQualificationReceipts} from './local-distribution-qualification-readback.mjs';

function fixture(){
 const plan={policyId:'policy',batches:[{bodyDigest:'a',body:{subjects:[{},{}]}},{bodyDigest:'b',body:{subjects:[{}]}}]},sourceDigest='source',actorId='actor';
 const fingerprint=(op,_,body)=>op+':'+body.bodyDigest;
 const records=plan.batches.map(b=>({key:'legacy-qualification-'+b.bodyDigest,fingerprint:fingerprint('distribution.legacy-qualification.v1',undefined,{bodyDigest:b.bodyDigest}),status:200,body:{bodyDigest:b.bodyDigest,policyId:'policy',participants:b.body.subjects.length,financialEffects:false}}));
 const audits=plan.batches.map(b=>({details:{bodyDigest:b.bodyDigest,sourceDigest,participants:b.body.subjects.length,financialEffects:false,reviewRef:'review',attempt:'attempt'}}));
 const client={query:async(sql,values)=>{if(sql.includes('idempotency_record')){assert.equal(values[0],JSON.stringify(['admin','actor','distribution.legacy-qualification.v1',null]));return{rows:records};}assert.deepEqual(values,['actor','policy',['a','b']]);return{rows:audits};}};
 return{plan,sourceDigest,actorId,fingerprint,records,audits,client};
}
test('every original qualification batch has its matching idempotency and audit receipt',async()=>{
 const f=fixture();assert.deepEqual(await verifyQualificationReceipts(f.client,f,f.fingerprint),{batches:2,participants:3});
});
test('missing or mismatched source, amount or original key makes readback fail closed',async()=>{
 for(const variant of ['missing-idempotency','wrong-fingerprint','wrong-count','missing-audit','wrong-source','duplicate-audit']){
  const f=fixture();
  if(variant==='missing-idempotency')f.records.pop();
  if(variant==='wrong-fingerprint')f.records[0].fingerprint='wrong';
  if(variant==='wrong-count')f.records[0].body.participants=99;
  if(variant==='missing-audit')f.audits.pop();
  if(variant==='wrong-source')f.audits[0].details.sourceDigest='other';
  if(variant==='duplicate-audit')f.audits[1]=f.audits[0];
  await assert.rejects(verifyQualificationReceipts(f.client,f,f.fingerprint),/QUALIFICATION_/ ,variant);
 }
});
