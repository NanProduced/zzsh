import assert from 'node:assert/strict';
import {test} from 'node:test';
import {userId,bankRead,channelQuote,nativeIntent,historyRead,joinpayRow,json} from './withdrawal-fixtures.mjs';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:3102';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:3100';
const {forwardWithdrawalRequest}=await import('../src/lib/withdrawal-proxy.ts');
const ctx=(path=[])=>({params:Promise.resolve({path})});
const origin='http://127.0.0.1:3100';
function req(resource,path='',method='GET',body,headers={}) { return new Request(`${origin}/api/account/${resource}${path}`,{method,headers:{'x-zzsh-expected-user-id':userId,...(method==='POST'?{'origin':origin,'content-type':'application/json','idempotency-key':'original-key'}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}); }
async function mocked(run){const prior=globalThis.fetch;try{return await run();}finally{globalThis.fetch=prior;}}
function backend(run){globalThis.fetch=async(url,init)=>String(url).endsWith('/api/auth/user/get-session')?json({user:{id:userId}}):run(url,init);}

test('bank proxy uses fixed API alias, user-only cookie and masked response projection',()=>mocked(async()=>{
 let seen;backend(async(url,init)=>{seen={url:String(url),init};return json({...bankRead(),name:'SECRET_NAME',binding:{...bankRead().binding,cardNo:'SECRET_NUMBER'}},200,{'set-cookie':'zzsh_admin.session_token=must-drop','cache-control':'public,max-age=3600'});});
 const response=await forwardWithdrawalRequest(req('withdrawal-bank-binding','','GET',undefined,{cookie:'zzsh_user.session_token=synthetic; zzsh_admin.session_token=synthetic-admin; other=ignored'}),ctx(),'withdrawal-bank-binding');
 assert.equal(response.status,200);assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/withdrawal-bank-binding');assert.equal(seen.init.headers.get('origin'),origin);assert.equal(seen.init.headers.get('cookie'),'zzsh_user.session_token=synthetic');assert.equal(seen.init.redirect,'error');assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('cache-control'),'no-store');assert(!JSON.stringify(await response.json()).includes('SECRET_'));
}));
test('bank proxy refuses wrong method/body/identity/key/origin before forwarding',()=>mocked(async()=>{
 let count=0;globalThis.fetch=async()=>{count++;throw Error('must not forward');};
 const body={name:'测试',cardNo:'0000000000000000',expectedRevision:'0'};
 const cases=[
  [req('withdrawal-bank-binding','/other'),ctx(['other']),404],
  [req('withdrawal-bank-binding','/receipt?key=x&key=y'),ctx(['receipt']),400],
  [req('withdrawal-bank-binding','','POST',{...body,userId:'cannot-choose'}),ctx(),400],
  [req('withdrawal-bank-binding','','POST',{...body,cardNo:'**** **** 0000'}),ctx(),400],
  [req('withdrawal-bank-binding','','POST',body,{'idempotency-key':''}),ctx(),400],
  [req('withdrawal-bank-binding','','POST',body,{origin:'http://foreign.invalid'}),ctx(),403],
  [req('withdrawal-bank-binding','','GET',undefined,{authorization:'synthetic'}),ctx(),403],
 ];
 for(const [request,context,expected] of cases)assert.equal((await forwardWithdrawalRequest(request,context,'withdrawal-bank-binding')).status,expected);
 assert.equal(count,0);
}));
test('Native quote/request body gates remain distinct; command transport loss returns unknown',()=>mocked(async()=>{
 const calls=[];backend(async(url,init)=>{calls.push({url:String(url),init});if(String(url).endsWith('/quote'))return json(channelQuote());throw Error('offline loss');});
 const input={amountCents:'10000',destinationId:channelQuote().destination.id,policyVersion:'policy1'};
 const quoteResponse=await forwardWithdrawalRequest(req('channel-withdrawals','/quote','POST',input),ctx(['quote']),'channel-withdrawals');assert.equal(quoteResponse.status,200);assert.equal(calls[0].init.headers.get('idempotency-key'),null);assert.deepEqual(JSON.parse(calls[0].init.body),input);
 assert.equal((await forwardWithdrawalRequest(req('channel-withdrawals','','POST',{...input,expectedWalletVersion:'7'}),ctx(),'channel-withdrawals')).status,400);
 const failed=await forwardWithdrawalRequest(req('channel-withdrawals','','POST',{...input,expectedWalletVersion:channelQuote().expectedWalletVersion}),ctx(),'channel-withdrawals');assert.equal(failed.status,502);assert.equal((await failed.json()).error.code,'WRITE_OUTCOME_UNKNOWN');assert.equal(calls.at(-1).init.headers.get('idempotency-key'),'original-key');
}));
test('history proxy preserves three sources, controlled wire pagination, and rejects combined cursor',()=>mocked(async()=>{
 let calls=0;backend(async()=>{calls++;return json(historyRead());});
 const response=await forwardWithdrawalRequest(req('withdrawal-history','?source=ALL'),ctx(),'withdrawal-history');assert.equal(response.status,200);const body=await response.json();assert.equal(body.sections.controlled.data.scope,'LOCAL_CONTROLLED');assert.equal(body.sections.joinpay.data.scope,'LOCAL_NATIVE_INTENTS_ONLY');
 const invalid=await forwardWithdrawalRequest(req('withdrawal-history','?source=ALL&cursor=other'),ctx(),'withdrawal-history');assert.equal(invalid.status,400);assert.equal(calls,1);
 assert.equal((await forwardWithdrawalRequest(req('withdrawal-history','','POST',{}),ctx(),'withdrawal-history')).status,404);
}));
test('old Native ACK does not acquire a fabricated current destination and upstream auth errors remain errors',()=>mocked(async()=>{
 const old=nativeIntent();delete old.originalDestination;backend(async()=>json({source:'JOINPAY',knowledge:'KNOWN',receipt:{intent:old},mayResubmit:false}));
 const response=await forwardWithdrawalRequest(req('channel-withdrawals','/receipt?key=original-key'),ctx(['receipt']),'channel-withdrawals');assert.equal(response.status,200);assert(!Object.hasOwn((await response.json()).receipt.intent,'originalDestination'));
 backend(async()=>json({error:{code:'FORBIDDEN'}},403));assert.equal((await forwardWithdrawalRequest(req('withdrawal-history'),ctx(),'withdrawal-history')).status,403);
}));

test('stale page subject cannot dispatch bank or Native writes after cookie identity changes',()=>mocked(async()=>{
 for(const resource of ['withdrawal-bank-binding','channel-withdrawals']){
  let commands=0,reads=0;globalThis.fetch=async(url)=>{if(String(url).endsWith('/api/auth/user/get-session')){reads++;return json({user:{id:'user_B'},session:{token:'SYNTHETIC_NOT_FOR_OUTPUT'}});}commands++;return json(resource==='withdrawal-bank-binding'?bankRead():{intent:{...nativeIntent(),userId:'user_B'}});};
  const body=resource==='withdrawal-bank-binding'?{name:'SYNTHETIC_A',cardNo:'0000000000000015',expectedRevision:'0'}:{amountCents:'10000',destinationId:channelQuote().destination.id,policyVersion:'policy1',expectedWalletVersion:channelQuote().expectedWalletVersion};
  const response=await forwardWithdrawalRequest(req(resource,'','POST',body,{'x-zzsh-expected-user-id':'user_A',cookie:'zzsh_user.session_token=SYNTHETIC_B'}),ctx(),resource);
  assert.equal(response.status,401);assert.equal((await response.json()).error.code,'IDENTITY_CHANGED');assert.equal(commands,0);assert.equal(reads,1);
 }
}));
test('missing expected subject and anonymous session never reach a business resource',()=>mocked(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(null);};
 const missing=new Request(origin+'/api/account/withdrawal-bank-binding');assert.equal((await forwardWithdrawalRequest(missing,ctx(),'withdrawal-bank-binding')).status,400);assert.equal(calls,0);
 assert.equal((await forwardWithdrawalRequest(req('withdrawal-bank-binding'),ctx(),'withdrawal-bank-binding')).status,401);assert.equal(calls,1);
}));
test('subject confirmation and business request share captured user cookie without exposing auth payload',()=>mocked(async()=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return String(url).endsWith('/api/auth/user/get-session')?json({user:{id:userId},session:{token:'SYNTHETIC_SESSION_SECRET'}}):json(bankRead());};
 const response=await forwardWithdrawalRequest(req('withdrawal-bank-binding','','GET',undefined,{cookie:'zzsh_user.session_token=ORIGINAL; zzsh_admin.session_token=DROP'}),ctx(),'withdrawal-bank-binding');
 assert.equal(response.status,200);assert.equal(calls.length,2);for(const call of calls){assert.equal(call.init.headers.get('cookie'),'zzsh_user.session_token=ORIGINAL');assert.equal(call.init.cache,'no-store');assert.equal(call.init.redirect,'error');}
 assert(!JSON.stringify(await response.json()).includes('SYNTHETIC_SESSION_SECRET'));
}));
test('an upstream receipt for another subject is rejected before reaching the page',()=>mocked(async()=>{
 backend(async()=>json({source:'JOINPAY',knowledge:'KNOWN',receipt:{intent:{...nativeIntent(),userId:'another_user'}},mayResubmit:false}));
 const response=await forwardWithdrawalRequest(req('channel-withdrawals','/receipt?key=original-key'),ctx(['receipt']),'channel-withdrawals');assert.equal(response.status,502);assert.equal((await response.json()).error.code,'EVIDENCE_UNAVAILABLE');
}));

test('demo withdrawal proxy forwards only the captured user and original target key, stripping extra fields',()=>mocked(async()=>{
 let seen;const scope='LOCAL_DEMO_SIMULATED',target={id:'demo_target',kind:'BANK_CARD',mask:'**** **** 1234',amountCents:'10000',currency:'CNY',expiresAt:'2026-11-08T08:00:00.000Z',policyVersion:'demo_policy'};
 backend(async(url,init)=>{seen={url:String(url),init};return json({contractVersion:'demo-withdrawal-target.v1',scope,target:{...target,secret:'SENSITIVE_PAYLOAD'},bankArrival:'UNKNOWN',extra:'SENSITIVE_PAYLOAD'});});
 const body={bankBindingId:'bank_1',bankBindingRevision:'2',amountCents:'10000'};
 const response=await forwardWithdrawalRequest(req('demo-withdrawal','/target','POST',body,{cookie:'zzsh_user.session_token=synthetic; zzsh_admin.session_token=drop'}),ctx(['target']),'demo-withdrawal');
 assert.equal(response.status,200);assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/me/demo-withdrawal/target');
 assert.equal(seen.init.headers.get('idempotency-key'),'original-key');assert.equal(seen.init.headers.get('cookie'),'zzsh_user.session_token=synthetic');
 const result=await response.json();assert.deepEqual(result.target,target);assert(!JSON.stringify(result).includes('SENSITIVE_PAYLOAD'));
}));

test('demo withdrawal proxy keeps the server amount range and definitive amount rejection',()=>mocked(async()=>{
 const availability={contractVersion:'demo-withdrawal-availability.v1',scope:'LOCAL_DEMO_SIMULATED',withdrawalEnabled:true,
  limits:{minCents:'200',maxCents:'1000000'},productionPayoutCapability:false,bankArrival:'UNKNOWN',observedAt:'2026-11-08T08:00:00.000Z'};
 backend(async(url)=>String(url).endsWith('/target')?json({error:{code:'DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE'}},422):json(availability));
 const read=await forwardWithdrawalRequest(req('demo-withdrawal'),ctx(),'demo-withdrawal');
 assert.equal(read.status,200);assert.deepEqual((await read.json()).limits,availability.limits);
 const rejected=await forwardWithdrawalRequest(req('demo-withdrawal','/target','POST',{bankBindingId:'bank_1',bankBindingRevision:'1',amountCents:'100'}),ctx(['target']),'demo-withdrawal');
 assert.equal(rejected.status,422);assert.equal((await rejected.json()).error.code,'DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE');
}));

test('demo withdrawal proxy preserves uncertain writes and rejects unexpected paths and cross-user commands',()=>mocked(async()=>{
 let commands=0;backend(async()=>{commands++;throw Error('lost response');});
 const body={amountCents:'10000',destinationId:'demo_target',policyVersion:'demo_policy',expectedWalletVersion:'7'};
 const failed=await forwardWithdrawalRequest(req('demo-withdrawal','/confirm','POST',body),ctx(['confirm']),'demo-withdrawal');
 assert.equal(failed.status,502);assert.equal((await failed.json()).error.code,'WRITE_OUTCOME_UNKNOWN');
 assert.equal((await forwardWithdrawalRequest(req('demo-withdrawal','/receipt?key=a&key=b'),ctx(['receipt']),'demo-withdrawal')).status,400);
 assert.equal((await forwardWithdrawalRequest(req('demo-withdrawal','/unknown','POST',body),ctx(['unknown']),'demo-withdrawal')).status,404);
 globalThis.fetch=async url=>String(url).endsWith('/api/auth/user/get-session')?json({user:{id:'another_user'}}):(++commands,json({}));
 const stale=await forwardWithdrawalRequest(req('demo-withdrawal','/target','POST',{bankBindingId:'bank_1',bankBindingRevision:'1',amountCents:'10000'}),ctx(['target']),'demo-withdrawal');
 assert.equal(stale.status,401);assert.equal(commands,1);
}));

/* --- Withdrawal History Client Tests --- */
import {parseWithdrawalHistory,projectWithdrawalHistory,parseWithdrawalHistoryDetail,parseWithdrawalHistoryRecovery,readWithdrawalHistory,withdrawalHistoryQuery} from '../src/lib/withdrawal-history-client.ts';
import { advanceWithdrawalTimeline, emptyWithdrawalTimeline, hasMoreWithdrawalTimeline, removeWithdrawalTimelineSource, withdrawalTimeMicros } from '../src/lib/withdrawal-timeline.ts';
import {WithdrawalRequestError} from '../src/lib/withdrawal-client-core.ts';
import {withStorage} from './withdrawal-fixtures.mjs';

test('three source history retains separate cursors/count scopes and roundtrips the controlled wire envelope',()=>{
 const raw=historyRead();raw.sections.joinpay.data.nextCursor='native_cursor';raw.sections.joinpay.data.count='10';raw.sections.controlled.data.pagination.nextCursor='controlled_cursor';raw.sections.controlled.data.pagination.mappedRecordCount='2';
 const result=parseWithdrawalHistory(raw,userId);assert.equal(result.sections.historical.data.count,'0');assert.equal(result.sections.controlled.data.pagination.nextCursor,'controlled_cursor');assert.equal(result.sections.joinpay.data.nextCursor,'native_cursor');assert.equal(result.sections.joinpay.data.scope,'LOCAL_NATIVE_INTENTS_ONLY');
 const projected=projectWithdrawalHistory(raw,userId);assert.equal(projected.sections.controlled.data.scope,'LOCAL_CONTROLLED');assert.deepEqual(parseWithdrawalHistory(projected,userId),result);
});
test('v2 controlled history roundtrips an indefinite cohort end=null but rejects undefined, empty, numeric, malformed and inverted ends',()=>{
 const cohort=(end)=>({id:'cohort',revision:'1',start:'2026-10-04T00:00:00Z',end});
 const raw=historyRead();raw.sections.controlled.data.coverage.cohorts=[cohort(null)];
 const parsed=parseWithdrawalHistory(raw,userId);assert.equal(parsed.sections.controlled.data.cohorts[0].end,null);
 const projected=projectWithdrawalHistory(raw,userId);assert.equal(projected.sections.controlled.data.coverage.cohorts[0].end,null);
 assert.deepEqual(parseWithdrawalHistory(projected,userId),parsed);
 for(const end of [undefined,'',7,'bad','2026-10-03T00:00:00Z']){
  const bad=historyRead();bad.sections.controlled.data.coverage.cohorts=[cohort(end)];
  assert.throws(()=>parseWithdrawalHistory(bad,userId),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');
 }
});
test('a legacy delegated source identity error retains its authorization type',()=>{
 const raw=historyRead();raw.sections.controlled.data.subjectId='different_user';
 assert.throws(()=>parseWithdrawalHistory(raw,userId),e=>e instanceof WithdrawalRequestError&&e.status===401&&e.code==='IDENTITY_CHANGED');
});
test('missing response source/filter metadata is not silently defaulted to ALL',()=>{
 const raw=historyRead();delete raw.source;delete raw.state;
 assert.throws(()=>parseWithdrawalHistory(raw,userId),e=>e.status===502&&e.code==='WITHDRAWAL_CONTRACT_REQUIRED');
});
test('unavailable source is not empty, and authorization failure remains an error',async()=>{
 const raw=historyRead();raw.sections.historical={availability:'UNAVAILABLE',reasonCodes:['HISTORICAL_LOCAL_EVIDENCE_UNAVAILABLE'],data:null};const result=parseWithdrawalHistory(raw,userId);assert.equal(result.sections.historical.data,null);assert.equal(result.sections.joinpay.data.count,'1');
 assert.throws(()=>parseWithdrawalHistory(raw,'other_user'),e=>e.code==='IDENTITY_CHANGED');
 await withStorage(async()=>{globalThis.fetch=async()=>json({error:{code:'FORBIDDEN'}},403);await assert.rejects(()=>readWithdrawalHistory(userId),e=>e.status===403);});
});
test('ALL cannot have combined cursor or state filter and JOINPAY requests only its own page',()=>withStorage(async()=>{
 assert.throws(()=>withdrawalHistoryQuery({source:'ALL',cursor:'x'}));assert.throws(()=>withdrawalHistoryQuery({source:'ALL',state:'SUCCEEDED'}));assert.throws(()=>withdrawalHistoryQuery({source:'JOINPAY',state:'RECONCILIATION_REQUIRED'}));
 const raw=historyRead();raw.source='JOINPAY';raw.sections.historical={availability:'NOT_REQUESTED',reasonCodes:[],data:null};raw.sections.controlled={availability:'NOT_REQUESTED',reasonCodes:[],data:null};let requested;
 globalThis.fetch=async url=>{requested=String(url);return json(raw);};await readWithdrawalHistory(userId,{source:'JOINPAY',cursor:'native_cursor',limit:10});assert.match(requested,/source=JOINPAY/);assert.match(requested,/cursor=native_cursor/);assert(!requested.includes('state=ALL'));
 globalThis.fetch=async()=>json({error:{code:'CONFLICT'}},409);await assert.rejects(()=>readWithdrawalHistory(userId,{source:'JOINPAY',cursor:'stale'}),e=>e.status===409);
}));
test('Native history detail uses data.item and original-key recovery is current local intent, not ACK or arrival',()=>{
 const row=joinpayRow();row.originalDestination.cardMask=null;const detail=parseWithdrawalHistoryDetail({contractVersion:'personal-withdrawals.read.v2',subjectId:userId,source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{scope:'LOCAL_NATIVE_INTENTS_ONLY',item:row}},userId,row.id);
 assert.equal(detail.data.item.originalDestination.cardMask,null);
 const found=parseWithdrawalHistoryRecovery({contractVersion:'personal-withdrawals.read.v2',subjectId:userId,source:'JOINPAY',knowledge:'KNOWN',item:{...row,state:'SUCCEEDED'},mayResubmit:false,receiptMeaning:'CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK'},userId);
 assert.equal(found.item.bankArrival,'UNKNOWN');assert.equal(found.item.evidenceLevel,'LOCAL_RECORDS_NOT_REVALIDATED');assert.equal(found.mayResubmit,false);
 assert.throws(()=>parseWithdrawalHistoryRecovery({...found,receiptMeaning:'ORIGINAL_ACK'},userId));
});

const sources = ['HISTORICAL', 'LOCAL_CONTROLLED', 'JOINPAY'];
const snapshot = { available: true, coverageKnown: true, snapshot: 'snapshot', asOf: '2026-10-30T00:00:00.000Z' };

test('merges independent source cursors across pages without losing or repeating records', async () => {
  const all = Array.from({ length: 75 }, (_, n) => ({ id: `record-${n}`, source: sources[n % 3], at: new Date(Date.UTC(2026, 9, 30) - n * 1000).toISOString() }));
  const calls = [];
  const read = async (source, cursor) => {
    const rows = all.filter(row => row.source === source), offset = Number(cursor ?? 0), items = rows.slice(offset, offset + 4);
    calls.push({ source, cursor });
    return { ...snapshot, items, cursor: offset + items.length < rows.length ? String(offset + items.length) : null };
  };
  let state = emptyWithdrawalTimeline();
  while (hasMoreWithdrawalTimeline(state)) state = await advanceWithdrawalTimeline(state, read);
  assert.deepEqual(state.items.map(item => item.id), all.map(item => item.id));
  assert.equal(new Set(state.items.map(item => item.id)).size, 75);
  assert(sources.every(source => calls.filter(call => call.source === source).length > 1));
  assert.equal(state.partial, false);
});

test('unavailable source is partial and cannot be represented as a complete empty history', async () => {
  const state = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), async source => source === 'JOINPAY'
    ? { ...snapshot, available: false, coverageKnown: false, items: [], cursor: null }
    : { ...snapshot, items: source === 'HISTORICAL' ? [{ source, id: 'history:1', at: '2026-10-29T00:00:00Z' }] : [], cursor: null });
  assert.equal(state.partial, true);
  assert.deepEqual(state.items.map(item => item.id), ['history:1']);
  assert.equal(hasMoreWithdrawalTimeline(state), false);
  const revoked = removeWithdrawalTimelineSource(state, 'HISTORICAL');
  assert.deepEqual(revoked.items, []);
  assert.equal(revoked.partial, true);
});

test('a source snapshot change on continuation rejects instead of merging inconsistent pages', async () => {
  const read = async (source, cursor) => ({ ...snapshot, snapshot: cursor ? 'changed' : snapshot.snapshot,
    items: source === 'HISTORICAL' ? [{ source, id: cursor ? 'history:2' : 'history:1', at: cursor ? '2026-10-28T00:00:00Z' : '2026-10-29T00:00:00Z' }] : [],
    cursor: source === 'HISTORICAL' && !cursor ? 'next' : null });
  const first = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), read, 1);
  await assert.rejects(() => advanceWithdrawalTimeline(first, read, 1), /WITHDRAWAL_SNAPSHOT_CHANGED/);
  assert.deepEqual(first.items.map(item => item.id), ['history:1']);
});

test('orders sub-millisecond records by exact time, then breaks exact ties by ID', async () => {
  assert.equal(withdrawalTimeMicros('2026-10-30T08:00:00.123456+08:00') - withdrawalTimeMicros('2026-10-30T00:00:00.123000Z'), 456n);
  assert.throws(() => withdrawalTimeMicros('invalid'), /WITHDRAWAL_TIME_INVALID/);
  assert.throws(() => withdrawalTimeMicros('2026-02-30T00:00:00.000Z'), /WITHDRAWAL_TIME_INVALID/);
  const state = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), async source => ({ ...snapshot,
    items: source === 'HISTORICAL' ? [{ source, id: 'history:1', at: '2026-10-30T00:00:00.123456Z' }]
      : source === 'LOCAL_CONTROLLED' ? [{ source, id: 'controlled:1', at: '2026-10-30T08:00:00.123789+08:00' }]
      : [{ source, id: 'joinpay:1', at: '2026-10-30T00:00:00.123456Z' }], cursor: null }));
  assert.deepEqual(state.items.map(item => item.id), ['controlled:1', 'joinpay:1', 'history:1']);
  assert.equal(state.temporalTies, true);
});

test('bounded scan returns a continuation when many short source pages are needed', async () => {
  let calls = 0;
  const read = async (source, cursor) => {
    calls++;
    if (source !== 'HISTORICAL') return { ...snapshot, items: [], cursor: null };
    const n = Number(cursor ?? 0);
    return { ...snapshot, items: [{ source, id: `history:${n}`, at: new Date(Date.UTC(2026, 9, 30) - n * 1000).toISOString() }], cursor: n < 19 ? String(n + 1) : null };
  };
  let state = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), read);
  assert.equal(calls, 12);
  assert.equal(state.scanIncomplete, true);
  assert.equal(hasMoreWithdrawalTimeline(state), true);
  state = await advanceWithdrawalTimeline(state, read);
  assert.equal(state.items.length, 20);
  assert.equal(hasMoreWithdrawalTimeline(state), false);
});

