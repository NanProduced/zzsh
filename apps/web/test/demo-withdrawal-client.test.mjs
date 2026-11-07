import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDemoTarget,quoteDemoWithdrawal,confirmDemoWithdrawal,pendingDemoWithdrawal,recoverDemoWithdrawal,parseDemoResult,parseDemoTarget,parseDemoQuote,parseDemoReceipt} from '../src/lib/demo-withdrawal-client.ts';
import {userId,json,withStorage} from './withdrawal-fixtures.mjs';

const scope='LOCAL_DEMO_SIMULATED',at='2026-11-08T08:00:00.000Z';
const target={id:'target-1',kind:'BANK_CARD',mask:'**** **** 0015',amountCents:'10000',currency:'CNY',expiresAt:at,policyVersion:'policy-1'};
const targetResponse={contractVersion:'demo-withdrawal-target.v1',scope,target,bankArrival:'UNKNOWN'};
const body={amountCents:'10000',destinationId:'target-1',policyVersion:'policy-1',expectedWalletVersion:'7'};
const quote={destinationId:'target-1',policyVersion:'policy-1',ledgerRevision:'7',acceptedAt:at,currency:'CNY',grossCents:'10000',netCents:'9900',feeCents:'100',requestKey:'original-confirm'};
const quoteResponse={contractVersion:'demo-withdrawal-quote.v1',scope,quote,bankArrival:'UNKNOWN'};
const intent={id:'demo-intent',state:'RESERVED',fundsDisposition:'RESERVED',amountCents:'10000',netCents:'9900',feeCents:'100',acceptedAt:at};
const result={contractVersion:'demo-withdrawal-result.v1',scope,intent,bankArrival:'UNKNOWN'};
const receipt=(stage,knowledge,value)=>({contractVersion:stage==='target'?'demo-withdrawal-target-receipt.v1':'demo-withdrawal-receipt.v1',scope,knowledge,receipt:value,mayReapply:false,bankArrival:'UNKNOWN'});

test('target and payout preserve separate original keys after response loss',()=>withStorage(async()=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});throw Error('lost');};
 await assert.rejects(createDemoTarget(userId,scope,{bankBindingId:'bank-1',bankBindingRevision:'1',amountCents:'10000'}));
 const original=pendingDemoWithdrawal(userId);assert.equal(original.stage,'target');assert.equal(calls[0].init.headers['idempotency-key'],original.key);
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return json(receipt('target','UNKNOWN',null));};
 assert.equal((await recoverDemoWithdrawal(userId,scope)).knowledge,'UNKNOWN');assert.equal(pendingDemoWithdrawal(userId).key,original.key);
 globalThis.fetch=async()=>json(receipt('target','KNOWN',targetResponse));const recovered=await recoverDemoWithdrawal(userId,scope);
 assert.equal(recovered.pending.stage,'target-ready');assert.equal(recovered.pending.key,original.key);
 globalThis.fetch=async()=>json(quoteResponse);const quoted=await quoteDemoWithdrawal(userId,scope,recovered.pending.target,'7');assert.deepEqual(quoted.body,body);
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});throw Error('lost confirm');};
 await assert.rejects(confirmDemoWithdrawal(userId,scope,quoted.body,quoted.quote));const confirm=pendingDemoWithdrawal(userId);
 assert.equal(confirm.stage,'confirm');assert.equal(confirm.key,'original-confirm');assert.equal(calls.at(-1).init.headers['idempotency-key'],'original-confirm');
 globalThis.fetch=async()=>json(receipt('confirm','UNKNOWN',null));assert.equal((await recoverDemoWithdrawal(userId,scope)).knowledge,'UNKNOWN');
 assert.equal(pendingDemoWithdrawal(userId).key,'original-confirm');
 globalThis.fetch=async()=>json(receipt('confirm','KNOWN',result));assert.equal((await recoverDemoWithdrawal(userId,scope)).intent.id,'demo-intent');
 assert.equal(pendingDemoWithdrawal(userId),null);assert(!calls.some(call=>call.url.includes('joinpay')));
}));

test('wrong scope or mismatched amounts never release the original pending confirmation',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json(targetResponse);const ready=await createDemoTarget(userId,scope,{bankBindingId:'bank-1',bankBindingRevision:'1',amountCents:'10000'});
 globalThis.fetch=async()=>json(quoteResponse);const quoted=await quoteDemoWithdrawal(userId,scope,ready.target,'7');
 globalThis.fetch=async()=>{throw Error('lost');};await assert.rejects(confirmDemoWithdrawal(userId,scope,quoted.body,quoted.quote));
 globalThis.fetch=async()=>json({...receipt('confirm','KNOWN',result),scope:'ECS_TEST_SIMULATED'});await assert.rejects(recoverDemoWithdrawal(userId,scope));
 assert.equal(pendingDemoWithdrawal(userId).key,'original-confirm');
 globalThis.fetch=async()=>json(receipt('confirm','KNOWN',{...result,intent:{...intent,amountCents:'20000',netCents:'19900'}}));
 await assert.rejects(recoverDemoWithdrawal(userId,scope));assert.equal(pendingDemoWithdrawal(userId).key,'original-confirm');
}));

test('demo projections require simulation scope and exact money without bank arrival claims',()=>{
 assert.throws(()=>parseDemoTarget({...targetResponse,scope:'JOINPAY'}));
 assert.throws(()=>parseDemoTarget({...targetResponse,target:{...target,mask:'123456789'}}));
 assert.throws(()=>parseDemoResult({...result,bankArrival:'SUCCEEDED'}));
 assert.throws(()=>parseDemoResult({...result,intent:{...intent,netCents:'1'}}));
 assert.throws(()=>parseDemoResult({...result,intent:{...intent,state:'SUCCEEDED'}}));
});

test('accepts the synthetic backend HTTP receipt with the actual policy and request-key formats',()=>{
 const actualTarget={...target,id:'sandbox_wdd_d266291ccb5546bedc65420066faee705b62cab9',mask:'**** **** 0000',amountCents:'2500',policyVersion:'OWNER_LOCAL_RESTORED_20261003_v1_BANK_CARD'};
 const actualQuote={...quote,destinationId:actualTarget.id,policyVersion:actualTarget.policyVersion,ledgerRevision:'1',grossCents:'2500',netCents:'2400',requestKey:'local-withdrawal-10defca76ca68843ae0e09a34e85183c79c2026b4b2442e4'};
 const actualResult={...result,intent:{...intent,id:'wd_1e629d1313af2ce0ed5b945adbf71f4e63647307',amountCents:'2500',netCents:'2400'}};
 assert.equal(parseDemoTarget({...targetResponse,target:actualTarget}).target.policyVersion,actualTarget.policyVersion);
 assert.equal(parseDemoQuote({...quoteResponse,quote:actualQuote}).quote.requestKey,actualQuote.requestKey);
 assert.equal(parseDemoReceipt(receipt('confirm','KNOWN',actualResult),'confirm').knowledge,'KNOWN');
});
