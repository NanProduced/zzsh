import assert from 'node:assert/strict';
import {test} from 'node:test';
import {userId,bankRead,channelQuote,nativeIntent,historyRead,json} from './withdrawal-fixtures.mjs';
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
