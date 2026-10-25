import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseChannelQuote,parseChannelIntent,parseWithdrawalOptions,quoteChannelWithdrawal,submitChannelWithdrawal,recoverChannelWithdrawal,pendingChannelWithdrawal} from '../src/lib/channel-withdrawal-client.ts';
import {userId,channelQuote,nativeIntent,options,json,withStorage} from './withdrawal-fixtures.mjs';

test('Native quote preserves original token and optional CNY wire field without treating ledger revision as token',()=>{
 const q=parseChannelQuote(channelQuote());assert(q.expectedWalletVersion.startsWith('jwdq1:'));assert.equal(q.ledgerRevision,'7');assert(!Object.hasOwn(q,'currency'));
 assert.throws(()=>parseChannelQuote({...channelQuote(),currency:'USD'}));assert.throws(()=>parseChannelQuote({...channelQuote(),expectedWalletVersion:'7'}));assert.throws(()=>parseChannelQuote({...channelQuote(),netCents:'1'}));
 const o=parseWithdrawalOptions(options());assert.equal(o.canQuote,true);assert.equal(o.bankOwnershipVerification,'NOT_VERIFIED');assert.equal(o.bankArrival,'UNKNOWN');assert(!('remainingCount' in o.policy));
 assert.throws(()=>parseWithdrawalOptions({...options(),policy:null,canQuote:true}));
});
test('Native quote sends three references; reserve freezes token/body/key and unknown recovery never resubmits',()=>withStorage(async({values})=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});if(String(url).endsWith('/quote'))return json(channelQuote());throw Error('response lost');};
 const input={amountCents:'10000',destinationId:channelQuote().destination.id,policyVersion:'policy1'};
 const q=await quoteChannelWithdrawal(userId,input);assert.deepEqual(JSON.parse(calls[0].init.body),input);assert.equal(calls[0].init.headers['x-zzsh-expected-user-id'],userId);assert(!('idempotency-key' in calls[0].init.headers));
 await assert.rejects(()=>submitChannelWithdrawal(userId,q));const pending=pendingChannelWithdrawal(userId);assert(pending);assert.equal(pending.body.expectedWalletVersion,q.expectedWalletVersion);assert.equal(pending.body.amountCents,'10000');assert(!JSON.stringify([...values.values()]).includes('cardNo'));
 await assert.rejects(()=>submitChannelWithdrawal(userId,q),e=>e.code==='PENDING_REQUEST_EXISTS');
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return json({source:'JOINPAY',knowledge:'UNKNOWN',receipt:null,mayResubmit:false});};
 assert.equal((await recoverChannelWithdrawal(userId)).knowledge,'UNKNOWN');assert.equal(pendingChannelWithdrawal(userId).key,pending.key);assert.equal(calls.at(-1).init.method,'GET');
 globalThis.fetch=async url=>String(url).includes('/receipt?')?json({source:'JOINPAY',knowledge:'KNOWN',receipt:{intent:nativeIntent()},mayResubmit:false}):json({source:'JOINPAY',intent:{...nativeIntent(),state:'PROCESSING',operationVersion:'2'},mayResubmit:false});
 const found=await recoverChannelWithdrawal(userId);assert.equal(found.receipt.originalDestination.cardMask,'**** **** 0000');assert.equal(found.receipt.bankArrival,'UNKNOWN');assert.equal(found.receipt.state,'RESERVED');assert.equal(found.current.state,'PROCESSING');assert.equal(pendingChannelWithdrawal(userId),null);
}));
test('a failed quote is not reported as an unknown withdrawal command',()=>withStorage(async()=>{
 globalThis.fetch=async()=>{throw Error('offline');};await assert.rejects(()=>quoteChannelWithdrawal(userId,{amountCents:'10000',destinationId:channelQuote().destination.id,policyVersion:'policy1'}),e=>e.code==='NETWORK_ERROR'&&!e.uncertain);assert.equal(pendingChannelWithdrawal(userId),null);
}));
test('Native intent keeps original target unknown when absent and never borrows a current card',()=>{
 const old=nativeIntent();delete old.originalDestination;old.currentBank={cardMask:'**** **** 9999'};const read=parseChannelIntent(old,userId);assert.equal(read.originalDestination,null);assert(!JSON.stringify(read).includes('9999'));
 assert.equal(read.acceptedAt,'2026-10-25 00:00:00+00');
 assert.throws(()=>parseChannelIntent(nativeIntent(),'another_user'),e=>e.code==='IDENTITY_CHANGED');
 const mismatch=nativeIntent();mismatch.originalDestination.id='bank_wrong';
 assert.throws(()=>parseChannelIntent(mismatch,userId),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');
});
test('a mismatched native recovery receipt keeps the original unresolved marker',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);await assert.rejects(()=>submitChannelWithdrawal(userId,channelQuote()));const original=pendingChannelWithdrawal(userId);
 globalThis.fetch=async()=>json({source:'JOINPAY',knowledge:'KNOWN',receipt:{intent:{...nativeIntent(),amountCents:'20000',netCents:'19900'}},mayResubmit:false});
 await assert.rejects(()=>recoverChannelWithdrawal(userId));assert.equal(pendingChannelWithdrawal(userId).key,original.key);
}));
