import assert from 'node:assert/strict';import {test} from 'node:test';
import {quoteLocalWithdrawal,pendingLocalWithdrawal,submitLocalWithdrawal,recoverLocalWithdrawal,readLocalWithdrawal,yuanToCents,parseWithdrawalRead,parseWithdrawalDetail,readMyWithdrawalRecords,readMyWithdrawalRecord} from '../src/lib/controlled-withdrawal-client.ts';
const user='user_test',body={amountCents:'200',destinationId:'code',policyVersion:'local_v1',expectedWalletVersion:'1'},quote={...body,requestKey:'original-server-key',netCents:'196',feeCents:'4',destinationMask:'local code',acceptedAt:'2026-10-04T00:00:00Z'};
const intent={id:'wd_1',scope:'LOCAL_CONTROLLED',evidenceLevel:'LOCAL_CONTROLLED',userId:user,state:'UNKNOWN',operationVersion:'3',fundsDisposition:'RESERVED',amountCents:'200',netCents:'196',feeCents:'4',destinationId:'code',policyVersion:'local_v1',acceptedAt:'2026-10-04T00:00:00Z',terminal:null};
async function withBrowser(run){const fetch=globalThis.fetch,storage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),nav=Object.getOwnPropertyDescriptor(globalThis,'navigator'),values=new Map();let locked=false;Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,_options,fn)=>{if(locked)return fn(null);locked=true;try{return await fn({name:'test'});}finally{locked=false;}}}}});try{await run(values);}finally{globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'localStorage',storage);else delete globalThis.localStorage;if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator;}}
test('exact yuan conversion rejects rounding, exponent and misleading zero formats',()=>{assert.equal(yuanToCents('999999999999999999999.99'),'99999999999999999999999');for(const n of ['2.001','1e2','-2','02',''])assert.throws(()=>yuanToCents(n));});
test('quote verifies server fees, subject, requested destination and wallet revision',async()=>{const old=globalThis.fetch;const q={...body,requestKey:'original-server-key',scope:'LOCAL_CONTROLLED',userId:user,grossCents:'200',netCents:'196',feeCents:'4',ledgerRevision:'1',globalWithdrawable:'UNKNOWN',identityMeaning:'EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC',destination:{id:'code',mask:'local code'},acceptedAt:quote.acceptedAt};try{globalThis.fetch=async()=>Response.json({quote:q});assert.deepEqual(await quoteLocalWithdrawal(user,body),quote);for(const patch of [{ledgerRevision:'2'},{feeCents:'3'},{destinationId:'other'}]){globalThis.fetch=async()=>Response.json({quote:{...q,...patch}});await assert.rejects(quoteLocalWithdrawal(user,body),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');}globalThis.fetch=async()=>Response.json({quote:{...q,userId:'other'}});await assert.rejects(quoteLocalWithdrawal(user,body),e=>e.status===401);}finally{globalThis.fetch=old;}});
test('ACK loss preserves one original key, prohibits repeat POST and recovers only that receipt',()=>withBrowser(async()=>{let posts=0,originalKey;globalThis.fetch=async(u,o)=>{if(o.method==='POST'){posts++;originalKey=o.headers['idempotency-key'];assert(pendingLocalWithdrawal(user));throw Error('ACK lost');}assert(String(u).includes('/receipt?key='+originalKey));return Response.json({scope:'LOCAL_CONTROLLED',knowledge:'UNKNOWN',receipt:null});};await assert.rejects(submitLocalWithdrawal(user,quote,()=>true));assert.equal(posts,1);await assert.rejects(submitLocalWithdrawal(user,quote,()=>true),e=>e.code==='WITHDRAWAL_UNRESOLVED');assert.equal(await recoverLocalWithdrawal(user,()=>true),null);assert(pendingLocalWithdrawal(user));globalThis.fetch=async u=>String(u).includes('/receipt?')?Response.json({scope:'LOCAL_CONTROLLED',knowledge:'KNOWN',receipt:{intent}}):Response.json({intent:{...intent,state:'SUCCEEDED',operationVersion:'5',fundsDisposition:'PAYOUT_POSTED',terminal:{state:'SUCCEEDED',reference:'local_operation'}}});assert.equal((await recoverLocalWithdrawal(user,()=>true)).state,'SUCCEEDED');assert.equal(pendingLocalWithdrawal(user),null);assert.equal(posts,1);}));
test('accepted write with failed readback keeps marker across identity401 and same-user recovery',()=>withBrowser(async()=>{globalThis.fetch=async(u,o)=>o.method==='POST'?Response.json({intent}):Response.json({error:{code:'UNAUTHENTICATED'}},{status:401});await assert.rejects(submitLocalWithdrawal(user,quote,()=>true),e=>e.status===401);assert(pendingLocalWithdrawal(user));await assert.rejects(recoverLocalWithdrawal(user,()=>true),e=>e.status===401);assert(pendingLocalWithdrawal(user));assert.equal(pendingLocalWithdrawal('other'),null);}));
test('late identity change keeps write marker and suppresses readback or new submission',()=>withBrowser(async()=>{let active=true,reads=0;globalThis.fetch=async()=>{active=false;reads++;return Response.json({intent});};await assert.rejects(submitLocalWithdrawal(user,quote,()=>active),e=>e.status===401);assert.equal(reads,1);assert(pendingLocalWithdrawal(user));assert.equal(await recoverLocalWithdrawal(user,()=>active),null);}));
test('definite validation rejection clears intent; malformed accepted response stays unresolved',()=>withBrowser(async()=>{globalThis.fetch=async()=>Response.json({error:{code:'CONFLICT'}},{status:409});await assert.rejects(submitLocalWithdrawal(user,quote,()=>true),e=>e.status===409);assert.equal(pendingLocalWithdrawal(user),null);globalThis.fetch=async()=>Response.json({intent:{...intent,feeCents:'3'}});await assert.rejects(submitLocalWithdrawal(user,quote,()=>true));assert(pendingLocalWithdrawal(user));}));
test('cross-tab lock unavailable and unreadable pending marker both prevent a business POST',()=>withBrowser(async values=>{let posts=0;globalThis.fetch=async()=>{posts++;return Response.json({intent});};navigator.locks.request=async(_key,_opts,fn)=>fn(null);await assert.rejects(submitLocalWithdrawal(user,quote,()=>true),e=>e.code==='WITHDRAWAL_UNRESOLVED');values.set('zzsh.withdrawal.pending.v1:'+user,'bad json');assert.throws(()=>pendingLocalWithdrawal(user),e=>e.code==='PENDING_MARKER_UNREADABLE');assert.equal(posts,0);}));
test('readback rejects another ID even for same user; terminal disposition remains exact',async()=>{const old=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({intent:{...intent,id:'wd_other'}});await assert.rejects(readLocalWithdrawal(user,'wd_1'));globalThis.fetch=async()=>Response.json({intent:{...intent,state:'SUCCEEDED',fundsDisposition:'RELEASE_POSTED',terminal:{state:'SUCCEEDED',reference:'local'}}});await assert.rejects(readLocalWithdrawal(user,'wd_1'));}finally{globalThis.fetch=old;}});
const historyAt='2026-10-04T00:00:00.000000Z',historyItem={id:'history:obs_z',source:'HISTORICAL_WITHDRAWAL',sourceReference:{type:'LEGACY_MYSQL',system:'restore',entity:'la_withdraw_apply',id:'42'},sourceStatus:2,amountCents:'10000',netCents:'9900',feeCents:'100',occurredAt:historyAt,importedAt:historyAt,sourceDigest:'a'.repeat(64),includedInOpening:false,accountingEffect:'OBSERVATION_ONLY_NO_NEW_DEBIT',channelArrivalKnowledge:'UNKNOWN'};
const historyEnvelope=()=>({contractVersion:'personal-withdrawals.read.v1',subjectId:user,source:'ALL',state:'ALL',historical:{source:'HISTORICAL_WITHDRAWAL',availability:'AVAILABLE',coverage:{knowledge:'UNKNOWN',reason:'HISTORICAL_WITHDRAWAL_COVERAGE_NOT_CLOSED'},items:[historyItem],mappedRecordCount:'1',count:null,asOf:historyAt,snapshotVersion:'history-source-1',nextCursor:null},controlled:{availability:'NOT_ADMITTED',reason:'CONTROLLED_RESOURCE_NOT_ADMITTED',data:null}});
test('source-complete history permits populated or proved empty pages without enabling a writer',()=>{
 for(const items of [[],[historyItem]]){
  const b=historyEnvelope();Object.assign(b.historical,{items,mappedRecordCount:String(items.length),count:String(items.length),coverage:{knowledge:'KNOWN',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:'2026-10-04T00:00:00.000Z',version:'reviewed-source-v1'}});
  const r=parseWithdrawalRead(b,user);assert.equal(r.historical.count,String(items.length));assert.equal(r.historical.coverage.version,'reviewed-source-v1');assert.equal(r.controlled.data,null);
  for(const patch of [{version:null},{cutoff:'2026-10-05T00:00:00.000Z'},{reason:'CLIENT_SAYS_COMPLETE'}]){
   const bad=structuredClone(b);Object.assign(bad.historical.coverage,patch);assert.throws(()=>parseWithdrawalRead(bad,user));
  }
  const mismatch=structuredClone(b);mismatch.historical.count='9';assert.throws(()=>parseWithdrawalRead(mismatch,user));
 }
});
test('historical withdrawal stays source-qualified, partial and never a balance or paid-channel claim',()=>{const read=parseWithdrawalRead(historyEnvelope(),user);assert.equal(read.historical.items[0].sourceStatus,2);assert.equal(read.historical.count,null);assert.equal(read.controlled.data,null);for(const patch of [{channelArrivalKnowledge:'KNOWN'},{source:'LOCAL_CONTROLLED'},{amountCents:'1.001'},{accountingEffect:'NEW_DEBIT'}]){const b=historyEnvelope();b.historical.items=[{...historyItem,...patch}];assert.throws(()=>parseWithdrawalRead(b,user),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');}});
test('zero without coverage remains unknown while proved-native empty has an explicit origin reason',()=>{const b=historyEnvelope();Object.assign(b.historical,{items:[],availability:'NOT_IMPORTED',mappedRecordCount:'0'});assert.equal(parseWithdrawalRead(b,user).historical.count,null);b.historical.count='0';assert.throws(()=>parseWithdrawalRead(b,user));Object.assign(b.historical,{availability:'AVAILABLE',coverage:{knowledge:'KNOWN',reason:'PROVED_NATIVE_NO_LEGACY_HISTORY'}});assert.equal(parseWithdrawalRead(b,user).historical.count,'0');b.historical.items=[historyItem];assert.throws(()=>parseWithdrawalRead(b,user));});
test('history requests only issue GET, encode exact source IDs and reject mixed query combinations before fetch',async()=>{const old=globalThis.fetch,seen=[];globalThis.fetch=async(url,options)=>{seen.push({url:String(url),options});return Response.json(String(url).includes('history%3A')?{contractVersion:'personal-withdrawals.read.v1',subjectId:user,source:'HISTORICAL_WITHDRAWAL',item:historyItem}:historyEnvelope());};try{assert.equal((await readMyWithdrawalRecords(user)).historical.items.length,1);assert.equal((await readMyWithdrawalRecord(user,historyItem.id)).item.id,historyItem.id);assert(seen[1].url.endsWith('/history%3Aobs_z'));assert(seen.every(row=>row.options.method==='GET'&&!row.options.body));const count=seen.length;for(const filter of [{source:'ALL',cursor:'x'},{source:'HISTORICAL',state:'SUCCEEDED'},{source:'LOCAL_CONTROLLED',state:'2'},{limit:101}])await assert.rejects(readMyWithdrawalRecords(user,filter),e=>e.status===400);assert.equal(seen.length,count);assert.throws(()=>parseWithdrawalDetail({contractVersion:'personal-withdrawals.read.v1',subjectId:user,source:'HISTORICAL_WITHDRAWAL',item:historyItem},user,'controlled:obs_z'));assert.throws(()=>parseWithdrawalRead({...historyEnvelope(),subjectId:'other'},user),e=>e.status===401);}finally{globalThis.fetch=old;}});
test('history read rejects a response for another requested source or state',async()=>{const old=globalThis.fetch;globalThis.fetch=async()=>Response.json(historyEnvelope());try{await assert.rejects(readMyWithdrawalRecords(user,{source:'HISTORICAL'}),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');await assert.rejects(readMyWithdrawalRecords(user,{source:'HISTORICAL',state:'2'}),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');}finally{globalThis.fetch=old;}});


/* --- Channel Withdrawal Client Tests --- */

import {parseChannelQuote,parseChannelIntent,parseWithdrawalOptions,quoteChannelWithdrawal,submitChannelWithdrawal,recoverChannelWithdrawal,pendingChannelWithdrawal} from '../src/lib/channel-withdrawal-client.ts';
import {createDemoTarget,quoteDemoWithdrawal,confirmDemoWithdrawal,pendingDemoWithdrawal,recoverDemoWithdrawal,parseDemoAvailability,parseDemoResult,parseDemoTarget,parseDemoQuote,parseDemoReceipt} from '../src/lib/demo-withdrawal-client.ts';
import {parseBankBinding,readBankBinding,saveBankBinding,recoverBankBinding,pendingBankBinding,validateBankBindingInput} from '../src/lib/withdrawal-bank-binding-client.ts';
import {userId,bankRead,options,channelQuote,nativeIntent,json,withStorage} from './withdrawal-fixtures.mjs';

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
test('withdrawal options parse server identity/quota without inventing eligibility or counts',()=>{
 const identity={identityStatus:'VERIFIED',ageStatus:'ADULT',verifiedAt:'2026-10-25T00:00:00.000000Z'};
 const quota={used:'1',maxIntents:3,remaining:2,windowStart:'2026-10-24T16:00:00.000000Z',windowEnd:'2026-10-25T16:00:00.000000Z'};
 let o=parseWithdrawalOptions({...options(),identity,quota});
 assert.deepEqual(o.identity,identity);assert.deepEqual(o.quota,quota);
 o=parseWithdrawalOptions({...options(),identity:null,quota:null});assert.equal(o.identity,null);assert.equal(o.quota,null);
 o=parseWithdrawalOptions({...options(),identity:{identityStatus:'VERIFIED_NEXT',ageStatus:'UNKNOWN_NEXT',verifiedAt:null},quota:{...quota,used:'4',remaining:0}});
 assert.equal(o.identity.identityStatus,'VERIFIED_NEXT');assert.equal(o.identity.ageStatus,'UNKNOWN_NEXT');assert.equal(o.quota.used,'4');assert.equal(o.quota.remaining,0);
 for(const bad of [
  {identity:{identityStatus:'VERIFIED',ageStatus:'ADULT'}},
  {identity:{identityStatus:'VERIFIED',ageStatus:'ADULT',verifiedAt:'yesterday'}},
  {quota:{...quota,used:'01'}},
  {quota:{...quota,maxIntents:0}},
  {quota:{...quota,remaining:-1}},
  {quota:{...quota,remaining:4}},
  {quota:{...quota,windowEnd:quota.windowStart}},
  {quota:{...quota,used:1}},
 ]) assert.throws(()=>parseWithdrawalOptions({...options(),...bad}),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');
});
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
test('additive identity and quota fields are ignored rather than exposed or treated as authority',()=>{
 const identity={identityStatus:'VERIFIED_NEXT',ageStatus:'UNKNOWN_NEXT',verifiedAt:null,provider:'future_field'};
 const quota={used:'4',maxIntents:3,remaining:0,windowStart:'2026-10-24T16:00:00Z',windowEnd:'2026-10-25T16:00:00Z',frequencyBasis:'future_field'};
 const parsed=parseWithdrawalOptions({...options(),canQuote:false,reasonCodes:['WITHDRAWAL_QUOTA_EXHAUSTED'],identity,quota});
 assert.equal(parsed.canQuote,false);assert.equal(parsed.identity.identityStatus,'VERIFIED_NEXT');
 assert.equal(parsed.quota.remaining,0);assert.equal(Object.hasOwn(parsed.identity,'provider'),false);
 assert.equal(Object.hasOwn(parsed.quota,'frequencyBasis'),false);
});

/* --- Demo Withdrawal Client Tests --- */

const demoScope='LOCAL_DEMO_SIMULATED',demoAt='2026-11-08T08:00:00.000Z';
const demoTarget={id:'target-1',kind:'BANK_CARD',mask:'**** **** 0015',amountCents:'10000',currency:'CNY',expiresAt:demoAt,policyVersion:'policy-1'};
const demoTargetResponse={contractVersion:'demo-withdrawal-target.v1',scope:demoScope,target:demoTarget,bankArrival:'UNKNOWN'};
const demoBody={amountCents:'10000',destinationId:'target-1',policyVersion:'policy-1',expectedWalletVersion:'7'};
const demoQuote={destinationId:'target-1',policyVersion:'policy-1',ledgerRevision:'7',acceptedAt:demoAt,currency:'CNY',grossCents:'10000',netCents:'9900',feeCents:'100',requestKey:'original-confirm'};
const demoQuoteResponse={contractVersion:'demo-withdrawal-quote.v1',scope:demoScope,quote:demoQuote,bankArrival:'UNKNOWN'};
const demoIntent={id:'demo-intent',state:'RESERVED',fundsDisposition:'RESERVED',amountCents:'10000',netCents:'9900',feeCents:'100',acceptedAt:demoAt};
const demoResult={contractVersion:'demo-withdrawal-result.v1',scope:demoScope,intent:demoIntent,bankArrival:'UNKNOWN'};
const demoReceipt=(stage,knowledge,value)=>({contractVersion:stage==='target'?'demo-withdrawal-target-receipt.v1':'demo-withdrawal-receipt.v1',scope:demoScope,knowledge,receipt:value,mayReapply:false,bankArrival:'UNKNOWN'});

test('target and payout preserve separate original keys after response loss',()=>withStorage(async()=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});throw Error('lost');};
 await assert.rejects(createDemoTarget(userId,demoScope,{bankBindingId:'bank-1',bankBindingRevision:'1',amountCents:'10000'}));
 const original=pendingDemoWithdrawal(userId);assert.equal(original.stage,'target');assert.equal(calls[0].init.headers['idempotency-key'],original.key);
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return json(demoReceipt('target','UNKNOWN',null));};
 assert.equal((await recoverDemoWithdrawal(userId,demoScope)).knowledge,'UNKNOWN');assert.equal(pendingDemoWithdrawal(userId).key,original.key);
 globalThis.fetch=async()=>json(demoReceipt('target','KNOWN',demoTargetResponse));const recovered=await recoverDemoWithdrawal(userId,demoScope);
 assert.equal(recovered.pending.stage,'target-ready');assert.equal(recovered.pending.key,original.key);
 globalThis.fetch=async()=>json(demoQuoteResponse);const quoted=await quoteDemoWithdrawal(userId,demoScope,recovered.pending.target,'7');assert.deepEqual(quoted.body,demoBody);
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});throw Error('lost confirm');};
 await assert.rejects(confirmDemoWithdrawal(userId,demoScope,quoted.body,quoted.quote));const confirm=pendingDemoWithdrawal(userId);
 assert.equal(confirm.stage,'confirm');assert.equal(confirm.key,'original-confirm');assert.equal(calls.at(-1).init.headers['idempotency-key'],'original-confirm');
 globalThis.fetch=async()=>json(demoReceipt('confirm','UNKNOWN',null));assert.equal((await recoverDemoWithdrawal(userId,demoScope)).knowledge,'UNKNOWN');
 assert.equal(pendingDemoWithdrawal(userId).key,'original-confirm');
 globalThis.fetch=async()=>json(demoReceipt('confirm','KNOWN',demoResult));assert.equal((await recoverDemoWithdrawal(userId,demoScope)).intent.id,'demo-intent');
 assert.equal(pendingDemoWithdrawal(userId),null);assert(!calls.some(call=>call.url.includes('joinpay')));
}));

test('wrong scope or mismatched amounts never release the original pending confirmation',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json(demoTargetResponse);const ready=await createDemoTarget(userId,demoScope,{bankBindingId:'bank-1',bankBindingRevision:'1',amountCents:'10000'});
 globalThis.fetch=async()=>json(demoQuoteResponse);const quoted=await quoteDemoWithdrawal(userId,demoScope,ready.target,'7');
 globalThis.fetch=async()=>{throw Error('lost');};await assert.rejects(confirmDemoWithdrawal(userId,demoScope,quoted.body,quoted.quote));
 globalThis.fetch=async()=>json({...demoReceipt('confirm','KNOWN',demoResult),scope:'ECS_TEST_SIMULATED'});await assert.rejects(recoverDemoWithdrawal(userId,demoScope));
 assert.equal(pendingDemoWithdrawal(userId).key,'original-confirm');
 globalThis.fetch=async()=>json(demoReceipt('confirm','KNOWN',{...demoResult,intent:{...demoIntent,amountCents:'20000',netCents:'19900'}}));
 await assert.rejects(recoverDemoWithdrawal(userId,demoScope));assert.equal(pendingDemoWithdrawal(userId).key,'original-confirm');
}));

test('demo projections require simulation scope and exact money without bank arrival claims',()=>{
 assert.throws(()=>parseDemoTarget({...demoTargetResponse,scope:'JOINPAY'}));
 assert.throws(()=>parseDemoTarget({...demoTargetResponse,target:{...demoTarget,mask:'123456789'}}));
 assert.throws(()=>parseDemoResult({...demoResult,bankArrival:'SUCCEEDED'}));
 assert.throws(()=>parseDemoResult({...demoResult,intent:{...demoIntent,netCents:'1'}}));
 assert.throws(()=>parseDemoResult({...demoResult,intent:{...demoIntent,state:'SUCCEEDED'}}));
});

test('availability requires a valid server-provided amount range',()=>{
 const base={contractVersion:'demo-withdrawal-availability.v1',scope:demoScope,withdrawalEnabled:true,productionPayoutCapability:false,bankArrival:'UNKNOWN',observedAt:demoAt,limits:{minCents:'200',maxCents:'1000000'}};
 assert.deepEqual(parseDemoAvailability(base).limits,{minCents:'200',maxCents:'1000000'});
 for(const limits of [undefined,{minCents:'0',maxCents:'100'}, {minCents:'300',maxCents:'200'}, {minCents:'2.00',maxCents:'1000'}])assert.throws(()=>parseDemoAvailability({...base,limits}));
});

test('a definitive amount rejection clears only its uncommitted original target',()=>withStorage(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{code:'DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE'}},{status:422});};
 await assert.rejects(createDemoTarget(userId,demoScope,{bankBindingId:'bank-1',bankBindingRevision:'1',amountCents:'100'}));
 assert.equal(calls,1);assert.equal(pendingDemoWithdrawal(userId),null);
}));

test('accepts the synthetic backend HTTP receipt with the actual policy and request-key formats',()=>{
 const actualTarget={...demoTarget,id:'sandbox_wdd_d266291ccb5546bedc65420066faee705b62cab9',mask:'**** **** 0000',amountCents:'2500',policyVersion:'OWNER_LOCAL_RESTORED_20261003_v1_BANK_CARD'};
 const actualQuote={...demoQuote,destinationId:actualTarget.id,policyVersion:actualTarget.policyVersion,ledgerRevision:'1',grossCents:'2500',netCents:'2400',requestKey:'local-withdrawal-10defca76ca68843ae0e09a34e85183c79c2026b4b2442e4'};
 const actualResult={...demoResult,intent:{...demoIntent,id:'wd_1e629d1313af2ce0ed5b945adbf71f4e63647307',amountCents:'2500',netCents:'2400'}};
 assert.equal(parseDemoTarget({...demoTargetResponse,target:actualTarget}).target.policyVersion,actualTarget.policyVersion);
 assert.equal(parseDemoQuote({...demoQuoteResponse,quote:actualQuote}).quote.requestKey,actualQuote.requestKey);
 assert.equal(parseDemoReceipt(demoReceipt('confirm','KNOWN',actualResult),'confirm').knowledge,'KNOWN');
});

/* --- Bank Binding Client Tests --- */

const bankInput={name:' 测试用户 ',cardNo:'0000 0000 0000 0000',expectedRevision:'0'};

test('bank binding distinguishes unreadable integration from unbound and projects only masks',()=>{
 assert.deepEqual(parseBankBinding({contractVersion:'withdrawal-bank-binding.v1',integration:'NOT_INTEGRATED',binding:null,expectedRevision:null}),{contractVersion:'withdrawal-bank-binding.v1',integration:'NOT_INTEGRATED',binding:null,expectedRevision:null});
 assert.equal(parseBankBinding({contractVersion:'withdrawal-bank-binding.v1',integration:'INTEGRATED',binding:null,expectedRevision:'0'}).expectedRevision,'0');
 const raw=bankRead();raw.binding.name='PRIVATE_NAME';raw.binding.cardNo='PRIVATE_CARD';const parsed=parseBankBinding(raw);assert(!JSON.stringify(parsed).includes('PRIVATE_'));assert.equal(parsed.binding.ownershipVerification,'NOT_VERIFIED');
 assert.throws(()=>parseBankBinding({...raw,expectedRevision:'2'}));
 assert.throws(()=>validateBankBindingInput({...bankInput,cardNo:'**** **** 0000'}));
 assert.equal(validateBankBindingInput(bankInput).cardNo,'0000000000000000');
});
test('failed bank save persists only user/key/revision and recovers original receipt then current binding',()=>withStorage(async({values})=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});throw Error('offline transport loss');};
 await assert.rejects(()=>saveBankBinding(userId,bankInput),e=>e.uncertain===true);
 const pending=pendingBankBinding(userId);assert(pending);const stored=[...values.values()][0];assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),['expectedRevision','key','userId']);assert(!stored.includes('测试'));assert(!stored.includes('0000000000000000'));
 assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers['idempotency-key'],pending.key);
 assert.deepEqual(JSON.parse(calls[0].init.body),{name:'测试用户',cardNo:'0000000000000000',expectedRevision:'0'});
 globalThis.fetch=async(url)=>String(url).includes('/receipt?')?json({integration:'INTEGRATED',knowledge:'KNOWN',receipt:bankRead('1','0000')}):json(bankRead('3','2222'));
 const recovered=await recoverBankBinding(userId);assert.equal(recovered.receipt.binding.revision,'1');assert.equal(recovered.current.binding.revision,'3');assert.equal(recovered.current.binding.cardMask,'**** **** 2222');assert.equal(pendingBankBinding(userId),null);
}));
test('UNKNOWN keeps original key; refresh recovery requires explicit resume and original revision',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);
 await assert.rejects(()=>saveBankBinding(userId,bankInput));const first=pendingBankBinding(userId);
 globalThis.fetch=async()=>json({integration:'INTEGRATED',knowledge:'UNKNOWN',receipt:null});
 assert.equal((await recoverBankBinding(userId)).knowledge,'UNKNOWN');assert.equal(pendingBankBinding(userId).key,first.key);
 await assert.rejects(()=>saveBankBinding(userId,bankInput),e=>e.code==='PENDING_REQUEST_EXISTS');
 await assert.rejects(()=>saveBankBinding(userId,{...bankInput,expectedRevision:'4'},{resume:true,expectedPending:first}),e=>e.code==='RECOVERY_CONTEXT_CHANGED');
 const seen=[];globalThis.fetch=async(url,init)=>{seen.push({url:String(url),init});return json(bankRead());};
 await saveBankBinding(userId,bankInput,{resume:true,expectedPending:first});assert.equal(seen[0].init.headers['idempotency-key'],first.key);assert.equal(seen[1].init.method,'GET');assert.equal(pendingBankBinding(userId),null);
}));
test('storage failure blocks bank POST and identity switch keeps old marker without disclosing result',()=>withStorage(async({storage})=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};const original=storage.setItem;storage.setItem=()=>{throw Error('blocked');};
 await assert.rejects(()=>saveBankBinding(userId,bankInput),e=>e.code==='RECOVERY_STORAGE_UNAVAILABLE');assert.equal(calls,0);storage.setItem=original;
 let current=true;globalThis.fetch=async()=>{current=false;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,bankInput,{isCurrent:()=>current}),e=>e.code==='IDENTITY_CHANGED');assert(pendingBankBinding(userId));assert.equal(pendingBankBinding('another_user'),null);
}));
test('known bank save followed by unavailable current read is not an unknown command',()=>withStorage(async()=>{
 globalThis.fetch=async(_url,init)=>init.method==='POST'?json(bankRead()):json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);
 await assert.rejects(()=>saveBankBinding(userId,bankInput),e=>e.code==='BANK_BINDING_CURRENT_READ_UNAVAILABLE'&&!e.uncertain);assert.equal(pendingBankBinding(userId),null);
}));
test('no pending marker does not invent an INTEGRATED recovery result',()=>withStorage(async()=>{await assert.rejects(()=>recoverBankBinding(userId),e=>e.code==='NO_PENDING_REQUEST');}));
test('explicit resume without its original marker never becomes a new save',()=>withStorage(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,bankInput,{resume:true}),e=>e.code==='NO_PENDING_REQUEST');assert.equal(calls,0);assert.equal(pendingBankBinding(userId),null);
}));
test('resume freezes selected key and version instead of following a replaced recovery marker',()=>withStorage(async({storage})=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);await assert.rejects(()=>saveBankBinding(userId,bankInput));const original=pendingBankBinding(userId);
 const replacement={...original,key:'different-request'};storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(replacement));let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,bankInput,{resume:true,expectedPending:original}),e=>e.code==='RECOVERY_CONTEXT_CHANGED');assert.equal(calls,0);assert.deepEqual(pendingBankBinding(userId),replacement);
}));
test('in-flight resume retains its selected key and cannot settle a replacement marker',()=>withStorage(async({storage})=>{
 const original={userId,key:'original-request',expectedRevision:'0'},replacement={userId,key:'newer-request',expectedRevision:'4'};
 storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(original));let sentKey;
 globalThis.fetch=async(_url,init)=>{sentKey=init.headers['idempotency-key'];storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(replacement));return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,bankInput,{resume:true,expectedPending:original}),e=>e.code==='RECOVERY_CONTEXT_CHANGED');
 assert.equal(sentKey,original.key);assert.deepEqual(pendingBankBinding(userId),replacement);
}));
test('a selected recovery context cannot be downgraded to a fresh save',()=>withStorage(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,bankInput,{resume:false,expectedPending:{userId,key:'old-key',expectedRevision:'0'}}),e=>e.code==='PENDING_REQUEST_EXISTS');assert.equal(calls,0);assert.equal(pendingBankBinding(userId),null);
}));
test('contradictory original receipt revision cannot resolve a bank recovery marker',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);await assert.rejects(()=>saveBankBinding(userId,bankInput));const original=pendingBankBinding(userId);
 const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return json({integration:'INTEGRATED',knowledge:'KNOWN',receipt:bankRead('9','9999')});};
 await assert.rejects(()=>recoverBankBinding(userId),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');assert.deepEqual(pendingBankBinding(userId),original);assert.equal(calls.length,1);
}));
test('selected original-key read remains read-only after marker loss and never clears a replacement',()=>withStorage(async({storage})=>{
 const original={userId,key:'selected-original',expectedRevision:'0'};const replacement={userId,key:'newer-request',expectedRevision:'3'};storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(replacement));const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init.method});return String(url).includes('/receipt?')?json({integration:'INTEGRATED',knowledge:'KNOWN',receipt:bankRead()}):json(bankRead('4','4444'));};
 const result=await recoverBankBinding(userId,{expectedPending:original});assert.equal(result.knowledge,'KNOWN');assert(calls[0].url.includes('key=selected-original'));assert(calls.every(x=>x.method==='GET'));assert.deepEqual(pendingBankBinding(userId),replacement);
 storage.removeItem('zzsh.bank-binding-recovery.v1:'+userId);await recoverBankBinding(userId,{expectedPending:original});assert.equal(pendingBankBinding(userId),null);
}));
