import assert from 'node:assert/strict';import {test} from 'node:test';import {createRequire,Module} from 'node:module';import {readFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {loadInformation} from './information-module.mjs';
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),require=createRequire(tree+'/package.json'),React=require('react'),{Window}=require('happy-dom'),ts=require('typescript'),client=require(tree+'/apps/web/src/lib/personal-wallet-client.ts'),information=loadInformation();
const compiled=ts.transpileModule(readFileSync(tree+'/apps/web/src/components/account/personal-wallet.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const at='2026-10-03T02:31:22.516000Z',ctx=(id='user_A')=>({contractVersion:'personal-finance.read.v1',projectionVersion:2,subjectId:id,asOf:at,snapshotVersion:'snapshot_1',coverage:{knowledge:'KNOWN',origin:'RECONCILED_OPENING',coverageVersion:'1'}}),money=n=>({currency:'CNY',unit:'cent',knowledge:n===null?'UNKNOWN':'KNOWN',amountCents:n});
const wallet=(id='user_A',amount='123456')=>({wallet:{...ctx(id),projectionVersion:undefined,ledgerRevision:'1',readRevision:'1',buckets:{available:money(amount),reserved:money(null),restricted:money(null),pendingEarnings:money(null),refundPayable:money(null)},withdrawable:{...money(null),reasonCodes:['POLICY_NOT_CONFIRMED']}}});
const entry={schemaVersion:1,id:'ledger:entry_A',occurredAt:at,importedAt:at,bucket:'AVAILABLE',deltaCents:'123456',kind:'POSTED',includedInOpening:false,sourceKind:'OPENING',source:{type:'LEGACY_MYSQL',system:'restore',entity:'la_user',id:'100'},businessReference:{type:'UNKNOWN',id:null,number:'PRIVATE_SOURCE_A'},balanceAfterCents:null};
const page=(id='user_A')=>({...ctx(id),bucket:'ALL',items:[entry],nextCursor:'original_cursor',totals:{count:'2',historicalCoverage:'INCLUDED',meaning:'covered',byBucket:[{bucket:'AVAILABLE',count:'2',postedNetCents:'123456',coveredHistoricalNetCents:'123456',uncoveredHistoricalNetCents:'0',coveredCount:'1',uncoveredCount:'0'}]}});
const reply=(b,status=200)=>Response.json(b,{status}),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function probe(fetcher,query=''){const w=new Window({url:'http://127.0.0.1:4200/account?view=wallet'});Object.assign(globalThis,{window:w,localStorage:w.localStorage,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,MouseEvent:w.MouseEvent,DOMException:w.DOMException,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});const previous=globalThis.fetch;globalThis.fetch=async (...args)=>{const response=await fetcher(...args),url=new URL(String(args[0]),'http://fixture.invalid');if(!response.ok||url.searchParams.get('projectionVersion')!=='3')return response;const body=await response.json();if(body.projectionVersion===2){body.projectionVersion=3;const itemV3=item=>{const value={purpose:'UNKNOWN',...item};if(value.kind==='HISTORICAL'){value.historicalAmountSemantics='BALANCE_RECORD';if(value.purpose==='UNKNOWN')value.businessReference={type:'UNKNOWN',id:null,number:null};}return value;};if(body.entry)body.entry=itemV3(body.entry);if(Array.isArray(body.items))body.items=body.items.map(itemV3);if(body.totals?.byBucket)body.totals.byBucket=body.totals.byBucket.map(t=>({...t,coveredHistoricalNetCents:null,uncoveredHistoricalNetCents:null}));}return reply(body,response.status);};const session={status:'authenticated',userId:'user_A',identityVersion:1,revalidations:0,revalidate(){this.revalidations++;}},store={getSnapshot:()=>session};let params=new URLSearchParams(query);const m=new Module(tree+'/wallet-probe.cjs');m.filename=tree+'/wallet-probe.cjs';m.paths=Module._nodeModulePaths(tree);m.require=name=>{if(name==='./bank-binding-workspace')return{BankBindingWorkspace:({scope})=>React.createElement('section',{'data-testid':'bank-binding-workspace','data-scope':scope},'绑卡与提现候选')};if(name==='next/link')return({scroll:_scroll,...props})=>React.createElement('a',props);if(name==='next/navigation')return{useSearchParams:()=>params};if(name==='@/components/session/user-session-provider')return{useUserSession:()=>session,useUserSessionStore:()=>store};if(name==='./controlled-withdrawal'){const child=new Module(tree+'/withdrawal-probe.cjs');child.filename=tree+'/withdrawal-probe.cjs';child.paths=m.paths;child.require=n=>n==='@/lib/controlled-withdrawal-client'?require(tree+'/apps/web/src/lib/controlled-withdrawal-client.ts'):m.require(n);child._compile(ts.transpileModule(readFileSync(tree+'/apps/web/src/components/account/controlled-withdrawal.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,child.filename);return child.exports;}if(name==='@/lib/personal-wallet-client')return client;if(name==='@/lib/withdrawal-bank-binding-client')return require(tree+'/apps/web/src/lib/withdrawal-bank-binding-client.ts');if(name==='@/lib/order-client')return require(tree+'/apps/web/src/lib/order-client.ts');if(name==='@/components/ui/information')return information;if(name.endsWith('.css'))return{};return require(name);};m._compile(compiled,m.filename);const host=w.document.createElement('div');w.document.body.append(host);const root=require('react-dom/client').createRoot(host),commits=[],settle=async()=>{for(let i=0;i<3;i++)await React.act(async()=>{await new Promise(setImmediate);});};function Frame(){const scope=`${session.userId}:${session.identityVersion}`;React.useLayoutEffect(()=>{commits.push({scope,text:host.textContent});});return React.createElement(m.exports.PersonalWallet,{scope});}const render=async()=>{await React.act(async()=>root.render(React.createElement(Frame)));await settle();};return{host,session,render,settle,commits,async fill(selector,value){const target=host.querySelector(selector);assert(target,selector);const proto=target.tagName==='SELECT'?w.HTMLSelectElement.prototype:w.HTMLInputElement.prototype;await React.act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(target,value);target.dispatchEvent(new w.Event(target.tagName==='SELECT'?'change':'input',{bubbles:true}));});await settle();},async click(selector){const target=host.querySelector(selector);assert(target,selector);await React.act(async()=>{target.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));await new Promise(setImmediate);});await settle();},async setQuery(q){params=new URLSearchParams(q);await render();},async close(){await React.act(async()=>root.unmount());await w.happyDOM.abort();globalThis.fetch=previous;}};}
test('exact large amounts and UNKNOWN are distinct from known zero',()=>{assert.equal(client.walletMoney('999999999999999999999999'),'¥9,999,999,999,999,999,999,999.99');assert.equal(client.walletMoney(null),'未记录');assert.equal(client.walletMoney('0'),'¥0.00');assert.equal(client.walletMoney('-1',true),'− ¥0.01');assert.throws(()=>client.walletMoney('-0'));});

test('native wallet labels distinguish settlement, referral and withdrawal without claiming bank arrival',()=>{
 for(const [sourceKind,label] of [['NATIVE_SETTLEMENT','出租结算'],['SUPPORT_CANCELLATION_RECOGNIZED','订单取消收益'],['NATIVE_REFERRAL_EARNING_SETTLED','分销收益'],['ORDER_COMPENSATION_PAID','包赔赔偿'],['JOINPAY_WITHDRAWAL_RESERVED','提现申请扣款'],['JOINPAY_WITHDRAWAL_RELEASED','提现资金退回'],['CONTROLLED_WITHDRAWAL_RESERVE','提现申请扣款']])
  assert.equal(client.financeEntryLabel({...entry,sourceKind}),label);
 assert.equal(client.financeEntryLabel({...entry,sourceKind:'UNRECOGNIZED'}),'资金记录');
});

test('wallet client can request v3 explicitly while keeping v2 as its compatibility default',async()=>{
 const prior=globalThis.fetch,requests=[];try{
  const item={...entry,sourceKind:'NATIVE_SETTLEMENT',purpose:'UNKNOWN'};
  globalThis.fetch=async url=>{requests.push(String(url));return reply(String(url).includes('/entries/')?{...ctx(),projectionVersion:3,entry:item}:{...page(),projectionVersion:3,items:[item],totals:{...page().totals,byBucket:page().totals.byBucket.map(t=>({...t,coveredHistoricalNetCents:null,uncoveredHistoricalNetCents:null}))}});};
  assert.equal((await client.readMyWalletEntries('user_A','ALL',null,undefined,3)).items[0].purpose,'UNKNOWN');
  assert.equal((await client.readMyWalletEntry('user_A',entry.id,undefined,3)).entry.purpose,'UNKNOWN');
  assert(requests.every(url=>new URL(url,'http://fixture.invalid').searchParams.get('projectionVersion')==='3'));
  globalThis.fetch=async()=>reply({...ctx(),projectionVersion:3,entry:{...item,purpose:'BAD'}});
  await assert.rejects(client.readMyWalletEntry('user_A',entry.id,undefined,3),e=>e.code==='FINANCE_CONTRACT_REQUIRED');
 }finally{globalThis.fetch=prior;}
});

test('wallet timestamps distinguish authoritative day, explicit unknown and compatible record time',async()=>{
 const previous=globalThis.fetch;
 try{
  for(const times of [{},{postedAt:null,recordedAt:at},{postedAt:null,recordedAt:null},{postedAt:'2026-10-02T15:59:59.000Z',recordedAt:at}]){
   globalThis.fetch=async()=>reply({...ctx(),entry:{...entry,...times}});
   const parsed=(await client.readMyWalletEntry('user_A',entry.id)).entry;
   assert.equal(Object.hasOwn(parsed,'postedAt'),Object.hasOwn(times,'postedAt'));
   if(Object.hasOwn(times,'postedAt'))assert.equal(parsed.postedAt,times.postedAt);
   assert.equal(Object.hasOwn(parsed,'recordedAt'),Object.hasOwn(times,'recordedAt'));if(Object.hasOwn(times,'recordedAt'))assert.equal(parsed.recordedAt,times.recordedAt);
   const p=await probe(async url=>reply(String(url).includes('/entries/')?{...ctx(),entry:{...entry,...times}}:String(url).includes('/entries?')?{...page(),items:[{...entry,...times}]}:wallet()),'wallet=entries');
   try{
    await p.render();const record=p.host.querySelector('.wallet-record');
    if(!Object.hasOwn(times,'postedAt'))assert.match(record.textContent,/记录时间/);
    else if(times.postedAt===null){assert.match(record.textContent,/记录时间/);assert.equal(record.querySelector('time').getAttribute('dateTime'),at);}
    else assert.equal(record.querySelector('time').getAttribute('dateTime'),times.postedAt);
    await p.setQuery('wallet=entry&entry=ledger%3Aentry_A');
    const detail=p.host.querySelector('.wallet-entry-detail');
    assert.match(detail.textContent,times.postedAt?/入账时间/:/记录时间/);
   }finally{await p.close();}
  }
  globalThis.fetch=async()=>reply({...ctx(),entry:{...entry,postedAt:'invalid-date'}});
  await assert.rejects(client.readMyWalletEntry('user_A',entry.id),e=>e.code==='FINANCE_CONTRACT_REQUIRED');
 }finally{globalThis.fetch=previous;}
});

test('historical balance records show their occurrence time in list and detail',async()=>{
 const historical={...entry,id:'history:source_time',kind:'HISTORICAL',sourceKind:'HISTORICAL_EARNINGS_LOG',purpose:'OWNER_RENTAL_INCOME',deltaCents:'1234',postedAt:null,recordedAt:'2026-11-03T07:47:05.000Z'};
 const p=await probe(async url=>reply(String(url).includes('/entries/')?{...ctx(),entry:historical}:String(url).includes('/entries?')?{...page(),items:[historical]}:wallet()),'wallet=entries');
 try{await p.render();const record=p.host.querySelector('.wallet-record');assert(record);assert.match(record.textContent,/出租收益/);assert.equal(record.querySelector('time').getAttribute('dateTime'),at);
  await p.setQuery('wallet=entry&entry=history%3Asource_time');const detail=p.host.querySelector('.wallet-entry-detail');assert(detail);assert.match(detail.textContent,/发生时间/);assert(![...detail.querySelectorAll('dt')].some(dt=>dt.textContent==='记录时间'));
 }finally{await p.close();}
});

test('unverified historical evidence never displays a confirmed amount or time, while verified unknown purpose retains the amount',async()=>{
 const source={type:'LEGACY_MYSQL',system:'legacy_mysql_restore',entity:'la_log_earnings',id:'11'},ref={type:'UNKNOWN',id:null,number:null};
 const bad={...entry,id:'history:unverified',kind:'HISTORICAL',sourceKind:'HISTORICAL_EARNINGS_LOG',purpose:'UNKNOWN',historicalAmountSemantics:'UNVERIFIED',deltaCents:null,occurredAt:null,postedAt:null,includedInOpening:null,source,businessReference:ref,balanceAfterCents:null};
 const good={...bad,id:'history:known',historicalAmountSemantics:'BALANCE_RECORD',deltaCents:'777',occurredAt:at,postedAt:at,includedInOpening:false};
 const value={...page(),projectionVersion:3,items:[bad,good],nextCursor:null,totals:{...page().totals,byBucket:page().totals.byBucket.map(t=>({...t,coveredHistoricalNetCents:null,uncoveredHistoricalNetCents:null}))}};
 const p=await probe(async url=>reply(String(url).includes('/entries/')?{...ctx(),projectionVersion:3,entry:bad}:String(url).includes('/entries?')?value:wallet()),'wallet=entries');
 try{await p.render();const rows=[...p.host.querySelectorAll('.wallet-record')];assert.equal(rows.length,2);assert.match(rows[0].textContent,/金额待核/);assert.match(rows[0].textContent,/来源待核/);assert.match(rows[0].textContent,/发生时间待核实/);assert.doesNotMatch(rows[0].textContent,/¥|已入账|已扣除/);assert.match(rows[1].textContent,/余额变动/);assert.match(rows[1].textContent,/¥7\.77/);
  await p.setQuery('wallet=entry&entry=history%3Aunverified');const detail=p.host.querySelector('.wallet-entry-detail');assert(detail);assert.match(detail.textContent,/金额待核/);assert.match(detail.textContent,/来源和金额暂未确认/);assert.doesNotMatch(detail.textContent,/¥|已计入原有余额|旧平台余额变动/);
 }finally{await p.close();}
});

test('wallet list distinguishes exact known empty proof, uncovered zero and actual partial records without POST',async()=>{
 for(const known of [false,true]){
  const empty={...page(),items:[],nextCursor:null,totals:{...page().totals,count:'0',byBucket:[]},...(known?{listCoverage:{knowledge:'KNOWN',count:'0',mappedRecordCount:'0',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:'2026-10-03T00:00:00.000Z',version:'coverage-v1'}}:{})},methods=[];
  const p=await probe(async(url,options)=>{methods.push(options?.method??'GET');return reply(String(url).includes('/entries?')?empty:wallet());},'wallet=entries');
  try{await p.render();assert.match(p.host.textContent,known?/暂无流水/:/流水仍在核对/);assert.match(p.host.textContent,known?/共 0 条/:/部分记录仍在核对/);assert(methods.every(m=>m==='GET'));}finally{await p.close();}
 }
});
test('wallet list parser rejects a claimed complete source without an actual proof version',async()=>{
 const prior=globalThis.fetch;try{const value={...page(),listCoverage:{knowledge:'KNOWN',count:'2',mappedRecordCount:'2',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:'2026-10-03T00:00:00.000Z',version:null}};globalThis.fetch=async()=>reply(value);await assert.rejects(client.readMyWalletEntries('user_A','ALL',null),e=>e.code==='FINANCE_CONTRACT_REQUIRED');}finally{globalThis.fetch=prior;}
});

test('historical records retain source meaning without claiming a new balance credit',async()=>{
 const items=[{...entry,id:'history:covered',kind:'HISTORICAL',sourceKind:'HISTORICAL_EARNINGS_LOG',purpose:'OWNER_RENTAL_INCOME',includedInOpening:true},
  {...entry,id:'history:uncovered',kind:'HISTORICAL',sourceKind:'HISTORICAL_EARNINGS_LOG',purpose:'DISTRIBUTION_INCOME',includedInOpening:false},
  {...entry,id:'ledger:movement',sourceKind:'NATIVE_SETTLEMENT'}];
 const value={...page(),items,totals:{...page().totals,count:'3'},listCoverage:{knowledge:'KNOWN',count:'3',mappedRecordCount:'3',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:at,version:'proof'}};
 const p=await probe(async url=>reply(String(url).includes('/entries/')?{...ctx(),entry:items[1]}:String(url).includes('/entries?')?value:wallet()),'wallet=entries');
 try{await p.render();const rows=[...p.host.querySelectorAll('.wallet-record')];assert.equal(rows.length,3);assert.match(rows[0].textContent,/出租收益.*旧平台记录/);assert.match(rows[1].textContent,/分销收益.*旧平台记录/);assert.doesNotMatch(rows[1].textContent,/已入账|已扣除/);assert.match(rows[2].textContent,/出租结算/);
  assert.doesNotMatch(p.host.textContent,/仅看可用余额变动|待退款|待结算收益/);await p.setQuery('wallet=entry&entry=history%3Auncovered');assert.doesNotMatch(p.host.querySelector('.wallet-entry-detail').textContent,/已计入原有余额|已入账|已扣除/);
 }finally{await p.close();}
});

test('wallet list and detail label only server-proved simulated activity',async()=>{
 const simulated={...entry,id:'ledger:demo',sourceKind:'NATIVE_SETTLEMENT',dataOrigin:'LOCAL_DEMO_SIMULATED',bankArrival:'UNKNOWN'};
 const uncertain={...entry,id:'ledger:uncertain',sourceKind:'CONTROLLED_WITHDRAWAL_RESERVE',dataOrigin:'UNKNOWN',bankArrival:'UNKNOWN'};
 const ordinary={...entry,id:'ledger:ordinary',sourceKind:'NATIVE_SETTLEMENT'};
 const value={...page(),items:[simulated,uncertain,ordinary],nextCursor:null,totals:{...page().totals,count:'3'}};
 const p=await probe(async url=>reply(String(url).includes('/entries/')?{...ctx(),entry:simulated}:String(url).includes('/entries?')?value:wallet()),'wallet=entries');
 try{await p.render();const rows=[...p.host.querySelectorAll('.wallet-record')];assert.equal(rows.length,3);
  assert.match(rows[0].textContent,/模拟/);assert.match(rows[1].textContent,/来源待核/);assert.doesNotMatch(rows[1].textContent,/模拟/);assert.doesNotMatch(rows[2].textContent,/模拟|来源待核/);
  await p.setQuery('wallet=entry&entry=ledger%3Ademo');assert.match(p.host.querySelector('.wallet-entry-detail').textContent,/模拟资金记录/);assert.match(p.host.textContent,/不会产生真实收款或打款/);
 }finally{await p.close();}
});

test('the overview keeps the opening out of recent activity',async()=>{
 const movement={...entry,id:'ledger:movement',sourceKind:'NATIVE_SETTLEMENT'};
 const p=await probe(async url=>reply(String(url).includes('/entries?')?{...page(),items:[entry,movement]}:wallet()),'');
 try{await p.render();const rows=[...p.host.querySelectorAll('.wallet-overview-table-section .wallet-record')];assert.deepEqual(rows.map(row=>row.dataset.walletEntry),['ledger:movement']);assert.equal(p.host.querySelector('.wallet-overview-table-section [data-wallet-entry="'+entry.id+'"]'),null);}finally{await p.close();}
});

test('time filter uses the displayed posting or record time',async()=>{
 const date=days=>new Date(Date.now()-days*86400000).toISOString();
 const items=[{...entry,id:'ledger:recent',sourceKind:'NATIVE_SETTLEMENT',occurredAt:date(20),postedAt:date(2)},
  {...entry,id:'ledger:old',sourceKind:'NATIVE_SETTLEMENT',occurredAt:date(2),postedAt:date(20)},
  {...entry,id:'ledger:unknown',sourceKind:'NATIVE_SETTLEMENT',occurredAt:date(2),postedAt:null}];
 const value={...page(),items,nextCursor:null,totals:{...page().totals,count:'3'},listCoverage:{knowledge:'KNOWN',count:'3',mappedRecordCount:'3',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:at,version:'proof'}};
 const p=await probe(async url=>reply(String(url).includes('/entries?')?value:wallet()),'wallet=entries');
 try{await p.render();assert.equal(p.host.querySelector('[aria-label="按时间筛选"] .wallet-toggle-chip').getAttribute('aria-pressed'),'true');await p.click('.wallet-toggle-chip:last-child');assert.equal(p.host.querySelector('.wallet-toggle-chip:last-child').getAttribute('aria-pressed'),'true');assert.deepEqual([...p.host.querySelectorAll('.wallet-record')].map(row=>row.dataset.walletEntry),['ledger:recent','ledger:unknown']);assert.match(p.host.textContent,/已按所选时间筛选当前记录/);}finally{await p.close();}
});

test('overview keeps unavailable card state unknown and rereads its masked card on return',async()=>{
 const saved=tail=>({contractVersion:'withdrawal-bank-binding.v1',integration:'INTEGRATED',expectedRevision:'1',binding:{id:'bank',revision:'1',cardMask:'**** **** '+tail,holderNameMask:'测**',updatedAt:at,ownershipVerification:'NOT_VERIFIED'}});
 let bankReply=reply({error:{code:'UNAVAILABLE'}},503),reads=0;
 const p=await probe(async url=>{const s=String(url);if(s.includes('/withdrawal-bank-binding')){reads++;return bankReply;}return reply(s.includes('/entries?')?page():wallet());});
 try{await p.render();assert.match(p.host.textContent,/收款资料暂时无法确认/);assert.doesNotMatch(p.host.textContent,/尚未绑定收款银行卡/);
  bankReply=reply(saved('1111'));await p.setQuery('wallet=withdraw');await p.setQuery('');assert.match(p.host.textContent,/\*\*\*\* \*\*\*\* 1111/);
  bankReply=reply(saved('2222'));await p.setQuery('wallet=withdraw');await p.setQuery('');assert.match(p.host.textContent,/\*\*\*\* \*\*\*\* 2222/);assert.doesNotMatch(p.host.textContent,/1111/);
  bankReply=reply(saved('3333'));await p.click('.account-module-heading button');assert.match(p.host.textContent,/\*\*\*\* \*\*\*\* 3333/);assert.doesNotMatch(p.host.textContent,/2222/);assert.equal(reads,4);
 }finally{await p.close();}
});

test('overview never displays the previous identity card during a user switch',async()=>{
 const gate=deferred();let user='user_A';
 const bank={contractVersion:'withdrawal-bank-binding.v1',integration:'INTEGRATED',expectedRevision:'1',binding:{id:'bank',revision:'1',cardMask:'**** **** 1111',holderNameMask:'测**',updatedAt:at,ownershipVerification:'NOT_VERIFIED'}};
 const p=await probe(async url=>{const s=String(url);if(s.includes('/withdrawal-bank-binding'))return user==='user_A'?reply(bank):gate.promise;return reply(s.includes('/entries?')?page(user):wallet(user));});
 try{await p.render();assert.match(p.host.textContent,/1111/);const mark=p.commits.length;user='user_B';p.session.userId=user;p.session.identityVersion=2;await p.render();
  const first=p.commits.slice(mark).find(commit=>commit.scope==='user_B:2');assert(first);assert.doesNotMatch(first.text,/1111|测\*\*/);assert.doesNotMatch(p.host.textContent,/1111/);
 }finally{gate.resolve(reply({contractVersion:'withdrawal-bank-binding.v1',integration:'NOT_INTEGRATED',expectedRevision:null,binding:null}));await p.close();}
});
test('real contract identity and malformed money are rejected without synthesizing zero',async()=>{const original=globalThis.fetch;try{globalThis.fetch=async()=>reply(wallet('user_B'));await assert.rejects(client.readMyWallet('user_A'),e=>e.status===401);const malformed=wallet();malformed.wallet.buckets.available.amountCents=123456;globalThis.fetch=async()=>reply(malformed);await assert.rejects(client.readMyWallet('user_A'),e=>e.code==='FINANCE_CONTRACT_REQUIRED');}finally{globalThis.fetch=original;}});
test('wallet overview shows balance and withdrawal entry without inventing eligibility or issuing a POST',async()=>{const methods=[];const p=await probe(async(url,options)=>{methods.push(options?.method??'GET');return reply(String(url).includes('/entries?')?page():wallet());});try{await p.render();assert.match(p.host.textContent,/¥1,234\.56/);assert.equal(p.host.querySelector('.wallet-funds-summary a').getAttribute('href'),'/account?view=wallet&wallet=withdraw');await p.setQuery('wallet=withdraw-local');assert.match(p.host.textContent,/提现条件尚未确认/);assert(p.host.querySelector('button:disabled'));assert(methods.every(m=>m==='GET'));}finally{await p.close();}});
test('overview does not present non-balance accounting buckets as extra balances',async()=>{
 const data=wallet();Object.assign(data.wallet.buckets,{reserved:money('500'),pendingEarnings:money('1200'),refundPayable:money('800'),restricted:money(null)});
 const methods=[];const p=await probe(async(url,options)=>{methods.push(options?.method??'GET');return String(url).includes('/withdrawals')?reply({error:{code:'CONTROLLED_RESOURCE_NOT_ADMITTED'}},503):reply(String(url).includes('/entries?')?page():data);});
 try{await p.render();assert.match(p.host.querySelector('[data-wallet-bucket="available"]').textContent,/¥1,234\.56/);assert.equal(p.host.querySelectorAll('[data-wallet-bucket]').length,1);assert.match(p.host.querySelector('.wallet-funds-summary').textContent,/可提现金额暂未确认/);assert.doesNotMatch(p.host.querySelector('.wallet-funds-summary').textContent,/占用金额|待结算收益|退款应付|限制金额/);const parsed=await client.readMyWallet('user_A');assert.equal(parsed.buckets.reserved.amountCents,'500');assert.equal(parsed.buckets.pendingEarnings.amountCents,'1200');assert.equal(parsed.buckets.refundPayable.amountCents,'800');assert.equal(parsed.buckets.restricted.knowledge,'UNKNOWN');assert.equal(parsed.withdrawable.knowledge,'UNKNOWN');assert(methods.every(method=>method==='GET'));}finally{await p.close();}
});
test('a known zero withdrawal field remains zero in the contract without becoming a second overview balance',async()=>{
 const data=wallet();data.wallet.withdrawable=money('0');data.wallet.withdrawable.reasonCodes=[];
 const p=await probe(async url=>reply(String(url).includes('/entries?')?page():data));try{await p.render();assert.match(p.host.querySelector('[data-wallet-bucket="available"]').textContent,/¥1,234\.56/);assert.equal(p.host.querySelector('[data-wallet-bucket="withdrawable"]'),null);assert.equal((await client.readMyWallet('user_A')).withdrawable.amountCents,'0');}finally{await p.close();}
});
test('detail retry keeps list snapshot and missing record balance unknown without order links',async()=>{
 let details=0,lists=0;const p=await probe(async url=>{const s=String(url);if(s.includes('/entries/'))return ++details===1?reply({error:{code:'INTERNAL_ERROR'}},503):reply({...ctx(),entry});if(s.includes('/entries?')){lists++;return reply(page());}return reply(wallet());},'wallet=entries');
 try{await p.render();const url=new URL(p.host.querySelector('.wallet-record').href);await p.click('.wallet-record');await p.setQuery(url.searchParams.toString());await p.click('.account-empty-state button');assert.equal(details,2);assert.equal(lists,1);const facts=p.host.querySelector('.wallet-entry-detail');assert.match(facts.textContent,/当时余额未记录/);assert.doesNotMatch(facts.textContent,/当时余额¥1,234\.56/);assert.equal(facts.querySelectorAll('a').length,0);await p.setQuery('wallet=entries');assert.equal(lists,1);assert.equal(document.activeElement.dataset.walletEntry,entry.id);}finally{await p.close();}
});
test('continuation failure retains original entries/cursor and successful retry appends once',async()=>{let attempts=0;const p=await probe(async(url)=>{if(!String(url).includes('/entries?'))return reply(wallet());if(!String(url).includes('cursor='))return reply(page());attempts++;if(attempts===1)return reply({error:{code:'INTERNAL_ERROR'}},503);return reply({...page(),items:[{...entry,id:'history:entry_B',kind:'HISTORICAL',sourceKind:'HISTORICAL_EARNINGS_LOG',includedInOpening:true}],nextCursor:null});},'wallet=entries');try{await p.render();await p.click('.wallet-load-more');assert.equal(p.host.querySelectorAll('.wallet-record').length,1);assert.match(p.host.textContent,/PRIVATE_SOURCE_A/);await p.click('.wallet-read-error button');assert.equal(p.host.querySelectorAll('.wallet-record').length,2);assert.equal(attempts,2);}finally{await p.close();}});
test('definite 401 on continuation clears all private projections and revalidates identity',async()=>{const p=await probe(async url=>reply(String(url).includes('cursor=')?{error:{code:'UNAUTHENTICATED'}}:String(url).includes('/entries?')?page():wallet(),String(url).includes('cursor=')?401:200),'wallet=entries');try{await p.render();assert.match(p.host.textContent,/PRIVATE_SOURCE_A/);await p.click('.wallet-load-more');assert.doesNotMatch(p.host.textContent,/PRIVATE_SOURCE_A|¥1,234\.56/);assert.equal(p.session.revalidations,1);}finally{await p.close();}});
test('late old-user replies cannot flash or replace the new identity',async()=>{const late=deferred();let phase='A';const p=await probe(async url=>phase==='A'?late.promise:reply(String(url).includes('/entries?')?{...page('user_B'),items:[]}:wallet('user_B','2222')));try{await p.render();phase='B';p.session.userId='user_B';p.session.identityVersion=2;await p.render();await React.act(async()=>late.resolve(reply(wallet('user_A','987654'))));await p.settle();assert.match(p.host.textContent,/¥22\.22/);assert.doesNotMatch(p.host.textContent,/9,876\.54|PRIVATE_SOURCE_A/);}finally{late.resolve(reply(wallet()));await p.close();}});
for(const bucket of ['AVAILABLE'])test(`${bucket} detail and return retain bucket, loaded pages and scroll location`,async()=>{
 let listReads=0;const a={...entry,bucket,id:'ledger:first'},b={...entry,bucket,id:'ledger:second'};
 const p=await probe(async url=>{const s=String(url);if(s.includes('/entries?')){listReads++;return reply({...page(),bucket,items:s.includes('cursor=')?[b]:[a],nextCursor:s.includes('cursor=')?null:'original_cursor',totals:{...page().totals,byBucket:[{...page().totals.byBucket[0],bucket}]}});}if(s.includes('/entries/'))return reply({...ctx(),entry:a});return reply(wallet());},`wallet=entries&bucket=${bucket}`);
 try{await p.render();await p.click('.wallet-load-more');assert.equal(p.host.querySelectorAll('.wallet-record').length,2);Object.defineProperty(window,'scrollY',{value:350,configurable:true});window.scrollTo=opts=>{window.__lastScroll=opts;};const record=p.host.querySelector('.wallet-record'),url=new URL(record.getAttribute('href'),'http://127.0.0.1:4200');assert.equal(url.searchParams.get('bucket'),bucket);await p.click('.wallet-record');await p.setQuery(url.searchParams.toString());assert(p.host.querySelector('.wallet-entry-detail'));const back=new URL(p.host.querySelector('.account-detail-back').getAttribute('href'),'http://127.0.0.1:4200');assert.equal(back.searchParams.get('bucket'),bucket);await p.setQuery(back.searchParams.toString());assert.equal(p.host.querySelectorAll('.wallet-record').length,2);assert.equal(listReads,2);assert.equal(window.__lastScroll.top,350);assert.equal(document.activeElement.dataset.walletEntry,a.id);assert.equal(p.host.querySelector(".wallet-delta").dataset.direction,bucket==="AVAILABLE"?"in":undefined);}finally{await p.close();}
});
test('detail deep link without list context defaults explicitly to ALL',async()=>{const p=await probe(async url=>reply(String(url).includes('/entries/')?{...ctx(),entry}:String(url).includes('/entries?')?page():wallet()),'wallet=entry&entry=ledger%3Aentry_A');try{await p.render();const back=new URL(p.host.querySelector('.account-detail-back').getAttribute('href'),'http://127.0.0.1:4200');assert.equal(back.searchParams.get('wallet'),'entries');assert.equal(back.searchParams.get('bucket'),null);}finally{await p.close();}});
test('detail requires exact same ID and subject; another same-user record is rejected',async()=>{const old=globalThis.fetch;try{globalThis.fetch=async()=>reply({...ctx(),entry});assert.equal((await client.readMyWalletEntry('user_A','ledger:entry_A')).entry.id,'ledger:entry_A');globalThis.fetch=async()=>reply({...ctx(),entry:{...entry,id:'ledger:entry_B'}});await assert.rejects(client.readMyWalletEntry('user_A','ledger:entry_A'),e=>e.code==='FINANCE_CONTRACT_REQUIRED');globalThis.fetch=async()=>reply({...ctx('user_B'),entry});await assert.rejects(client.readMyWalletEntry('user_A','ledger:entry_A'),e=>e.status===401);}finally{globalThis.fetch=old;}});
test('new wallet client requests projection 2 for list and detail and rejects missing/unknown server versions',async()=>{
 const previous=globalThis.fetch,requests=[];try{globalThis.fetch=async(url,options)=>{requests.push({url:String(url),options});return reply(String(url).includes('/entries/')?{...ctx(),entry:{...entry,bucket:'RESERVED'}}:{...page(),bucket:'RESERVED',items:[{...entry,bucket:'RESERVED'}],totals:{...page().totals,byBucket:[{...page().totals.byBucket[0],bucket:'RESERVED'}]}});};assert.equal((await client.readMyWalletEntries('user_A','RESERVED',null)).items[0].bucket,'RESERVED');assert.equal((await client.readMyWalletEntry('user_A',entry.id)).entry.bucket,'RESERVED');assert(requests.every(r=>new URL(r.url,'http://fixture.invalid').searchParams.get('projectionVersion')==='2'&&r.options.method===undefined));
  for(const projectionVersion of [undefined,1,3]){globalThis.fetch=async()=>reply({...page(),projectionVersion});await assert.rejects(client.readMyWalletEntries('user_A','ALL',null),e=>e.status===502);}
 }finally{globalThis.fetch=previous;}
});
test('old non-balance bucket links open the all-movements view',async()=>{
 for(const oldBucket of ['REFUND_PAYABLE','RESERVED','PENDING_EARNINGS']){
  const requests=[],p=await probe(async url=>{requests.push(String(url));return reply(String(url).includes('/entries?')?page():wallet());},'wallet=entries&bucket='+oldBucket);
  try{await p.render();assert(p.host.querySelector('.wallet-record'));assert(!p.host.querySelector('nav[aria-label="流水类型"]'));assert(requests.filter(url=>url.includes('/entries?')).every(url=>new URL(url,'http://fixture.invalid').searchParams.get('bucket')==='ALL'));}finally{await p.close();}
 }
});

test('late detail A cannot replace the already selected detail B',async()=>{const late=deferred();const p=await probe(async url=>String(url).includes('/entries/ledger%3Aentry_A')?late.promise:reply(String(url).includes('/entries/')?{...ctx(),entry:{...entry,id:'ledger:entry_B',businessReference:{...entry.businessReference,number:'PRIVATE_DETAIL_B'}}}:String(url).includes('/entries?')?page():wallet()),'wallet=entry&entry=ledger%3Aentry_A');try{await p.render();await p.setQuery('wallet=entry&entry=ledger%3Aentry_B');await React.act(async()=>late.resolve(reply({...ctx(),entry:{...entry,businessReference:{...entry.businessReference,number:'PRIVATE_DETAIL_A'}}})));await p.settle();assert.match(p.host.querySelector('.wallet-entry-detail').textContent,/PRIVATE_DETAIL_B/);assert.doesNotMatch(p.host.querySelector('.wallet-entry-detail').textContent,/PRIVATE_DETAIL_A/);}finally{late.resolve(reply({...ctx(),entry}));await p.close();}});

const localScope=()=>({scope:'LOCAL_CONTROLLED',subjectId:'user_A',coverage:{knowledge:'KNOWN',meaning:'EXPLICIT_LOCAL_INTENTS_ONLY_NOT_TOTAL_HISTORICAL_WALLET',cohorts:[{id:'cohort',revision:'1',start:at,end:'2026-10-05T00:00:00Z'}]},items:[],destinations:[{id:'bank',kind:'BANK_CARD',mask:'local bank',policyVersion:'server_policy',perIntentCents:'200',canQuote:true}],totals:{reservedCents:'0',payoutCents:'0',feeCents:'0'},globalReserved:'UNKNOWN'});
test('overview reads known local pending zero while leaving global historical reserved unknown',async()=>{const p=await probe(async url=>reply(String(url).includes('/withdrawals')?localScope():String(url).includes('/entries?')?page():wallet()));try{await p.render();assert.equal(p.host.querySelector(".wallet-attention"),null);assert.equal((await client.readMyWallet('user_A')).buckets.reserved.knowledge,'UNKNOWN');assert.doesNotMatch(p.host.textContent,/没有提现申请|暂无提现申请/);}finally{await p.close();}});
test('withdrawal401 immediately clears wallet projections through the shared identity boundary',async()=>{const p=await probe(async url=>reply(String(url).includes('/withdrawals')?{error:{code:'UNAUTHENTICATED'}}:String(url).includes('/entries?')?page():wallet(),String(url).includes('/withdrawals')?401:200));try{await p.render();assert.doesNotMatch(p.host.textContent,/¥1,234\.56|PRIVATE_SOURCE_A/);assert.equal(p.session.revalidations,1);}finally{await p.close();}});
test('real form reads server quote and cannot submit until amount, target and fees are confirmed',async()=>{let quotes=0;const p=await probe(async(url,options)=>{if(String(url).endsWith('/withdrawals/quote')){quotes++;const b=JSON.parse(options.body);assert.deepEqual(b,{amountCents:'200',destinationId:'bank',policyVersion:'server_policy',expectedWalletVersion:'1'});return reply({quote:{scope:'LOCAL_CONTROLLED',userId:'user_A',destinationId:'bank',destination:{id:'bank',mask:'local bank'},policyVersion:'server_policy',ledgerRevision:'1',acceptedAt:at,grossCents:'200',netCents:'100',feeCents:'100',requestKey:'server-original-key',globalWithdrawable:'UNKNOWN',identityMeaning:'EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC'}});}return reply(String(url).includes('/withdrawals')?localScope():String(url).includes('/entries?')?page():wallet());},'wallet=withdraw-local');try{await p.render();assert(p.host.querySelector('button[type="submit"]').disabled);await p.fill('#withdraw-destination','bank');await p.fill('#withdraw-amount','2.00');assert.equal(p.host.querySelector('button[type="submit"]').disabled,false);await p.click('button[type="submit"]');assert.equal(quotes,1);assert.match(p.host.textContent,/手续费¥1\.00/);assert.match(p.host.textContent,/预计到账/);assert.match(p.host.textContent,/提交测试申请/);}finally{await p.close();}});

const withdrawalMarker = 'zzsh.withdrawal.pending.v1:user_A';
test('F2: unreadable withdrawal catalog with no known intent is neutral and never reads as a pending application',async()=>{
  const p=await probe(async url=>String(url).includes('/withdrawals')?reply({error:{code:'CONTROLLED_RESOURCE_NOT_ADMITTED'}},503):reply(String(url).includes('/entries?')?page():wallet()));
  try{
    localStorage.removeItem(withdrawalMarker);
    await p.render();
    assert.equal(p.host.querySelector('.wallet-attention'),null);
    assert.doesNotMatch(p.host.textContent,/没有提现申请|暂无提现申请|提现处理中/);
    assert(p.host.querySelector('a[href*="wallet=withdraw"]'));
    assert.equal(p.host.querySelector('a[href*="wallet=withdraw-local"]'),null, 'the overview does not add recovery noise without a known intent');
    // 目录失败不阻塞钱包主读取，也不退化成空申请列表或开启提现。
    assert.match(p.host.textContent,/¥1,234\.56/);
    assert.doesNotMatch(p.host.textContent,/本轮暂无申请记录/);
  }finally{await p.close();}
});

test('a partial local history keeps the recovery entry without claiming older records are pending',async()=>{
 const terminal={scope:'LOCAL_CONTROLLED',evidenceLevel:'LOCAL_CONTROLLED',id:'local-1',userId:'user_A',state:'FAILED',operationVersion:'1',fundsDisposition:'RELEASE_POSTED',amountCents:'200',netCents:'100',feeCents:'100',destinationId:'bank',policyVersion:'server_policy',acceptedAt:at,terminal:{state:'FAILED',reference:'receipt-1'}};
 const local={...localScope(),items:[terminal],pagination:{asOf:at,snapshotVersion:'snapshot-local',mappedRecordCount:'2',nextCursor:'next-page'}};
 const p=await probe(async url=>reply(String(url).includes('/withdrawals')?local:String(url).includes('/entries?')?page():wallet()),'wallet=withdraw');
 try{localStorage.removeItem(withdrawalMarker);await p.render();assert(p.host.querySelector('a[href*="wallet=withdraw-local"]'));assert.doesNotMatch(p.host.textContent,/提现处理中|有一笔提现申请/);}finally{await p.close();}
});

test('an unavailable local catalog keeps its records entry on the withdrawal page',async()=>{
 const p=await probe(async url=>String(url).includes('/withdrawals')?reply({error:{code:'EVIDENCE_UNAVAILABLE'}},503):reply(String(url).includes('/entries?')?page():wallet()),'wallet=withdraw');
 try{localStorage.removeItem(withdrawalMarker);await p.render();assert(p.host.querySelector('a[href*="wallet=withdraw-local"]'));assert.doesNotMatch(p.host.textContent,/提现处理中|有一笔提现申请/);}finally{await p.close();}
});

for(const availability of ['NOT_ADMITTED','NOT_CONFIGURED','NOT_IN_SCOPE'])test(`an HTTP 200 ${availability} catalog keeps its records entry`,async()=>{
 const body={contractVersion:'personal-withdrawals.read.v1',subjectId:'user_A',source:'ALL',state:'ALL',historical:{source:'HISTORICAL_WITHDRAWAL',availability:'NOT_INSTALLED',coverage:{knowledge:'UNKNOWN',reason:'HISTORY_NOT_INSTALLED'},items:[],mappedRecordCount:null,count:null,asOf:null,snapshotVersion:null,nextCursor:null},controlled:{availability,reason:'UNAVAILABLE',data:null}};
 const p=await probe(async url=>reply(String(url).includes('/withdrawals')?body:String(url).includes('/entries?')?page():wallet()),'wallet=withdraw');
 try{localStorage.removeItem(withdrawalMarker);await p.render();assert(p.host.querySelector('a[href*="wallet=withdraw-local"]'));assert.doesNotMatch(p.host.textContent,/提现处理中|有一笔提现申请/);}finally{await p.close();}
});
test('F2: a known original intent still carries pending semantics when the catalog is unreadable',async()=>{
  const p=await probe(async url=>String(url).includes('/withdrawals')?reply({error:{code:'EVIDENCE_UNAVAILABLE'}},503):reply(String(url).includes('/entries?')?page():wallet()));
  try{
    localStorage.setItem(withdrawalMarker,JSON.stringify({version:1,userId:'user_A',key:'original-key',body:{amountCents:'200',destinationId:'bank',policyVersion:'server_policy',expectedWalletVersion:'1'}}));
    await p.render();
    assert.match(p.host.textContent,/提现处理中/);
    assert.match(p.host.textContent,/提现申请状态未记录/);
    assert.match(p.host.textContent,/避免重复申请/);
    assert.doesNotMatch(p.host.textContent,/提现信息暂时无法读取/);
  }finally{localStorage.removeItem(withdrawalMarker);await p.close();}
});

test('an unreadable withdrawal marker does not claim a specific application exists',async()=>{
  const calls=[],p=await probe(async (url,options)=>{calls.push(options?.method??'GET');return String(url).includes('/withdrawals')?reply({error:{code:'EVIDENCE_UNAVAILABLE'}},503):reply(String(url).includes('/entries?')?page():wallet());});
  try{localStorage.setItem(withdrawalMarker,'unreadable');await p.render();assert.match(p.host.textContent,/提现申请状态未记录/);assert.doesNotMatch(p.host.textContent,/有一笔提现申请/);assert.equal(localStorage.getItem(withdrawalMarker),'unreadable');assert(calls.every(method=>method==='GET'));}finally{localStorage.removeItem(withdrawalMarker);await p.close();}
});

for(const pane of ['', 'wallet=withdraw', 'wallet=withdraw-local'])for(const marker of ['valid','unreadable'])test(`identity switch clears ${marker} withdrawal state before the first ${pane||'overview'} frame`,async()=>{
 let who='user_A';const p=await probe(async url=>String(url).includes('/withdrawals')?reply({error:{code:'EVIDENCE_UNAVAILABLE'}},503):reply(String(url).includes('/entries?')?page(who):wallet(who)),pane);
 const saved=marker==='valid'?JSON.stringify({version:1,userId:'user_A',key:'original-key',body:{amountCents:'200',destinationId:'bank',policyVersion:'server_policy',expectedWalletVersion:'1'}}):'unreadable';
 try{
  localStorage.setItem(withdrawalMarker,saved);await p.render();assert.match(p.host.textContent,/提现处理中|上次申请结果未记录/);
  p.commits.length=0;who='user_B';p.session.userId='user_B';p.session.identityVersion=2;await p.render();
  const first=p.commits.find(frame=>frame.scope==='user_B:2');assert(first);assert.doesNotMatch(first.text,/提现处理中|提现申请状态未记录|上次申请结果未记录/);assert.equal(localStorage.getItem(withdrawalMarker),saved);
 }finally{localStorage.removeItem(withdrawalMarker);await p.close();}
});

test('wallet keeps opening-balance facts without exposing platform source labels',async()=>{
 const p=await probe(async url=>String(url).includes('/entries/')?reply({...ctx(),entry}):String(url).includes('/entries?')?reply(page()):reply(wallet()),'wallet=entries');
 try{await p.render();assert.doesNotMatch(p.host.textContent,/旧平台|本平台/);assert.match(p.host.textContent,/余额记录/);const url=new URL(p.host.querySelector('.wallet-record').href);await p.click('.wallet-record');await p.setQuery(url.searchParams.toString());assert.doesNotMatch(p.host.textContent,/旧平台|本平台/);assert.match(p.host.textContent,/当时余额未记录/);}finally{await p.close();}
});


test('BIND-03 wallet entry renders the new workspace independently of unreadable wallet money and keeps legacy recovery reachable',async()=>{const p=await probe(async()=>reply({error:{code:'EVIDENCE_UNAVAILABLE'}},503),'wallet=withdraw');try{localStorage.setItem(withdrawalMarker,JSON.stringify({version:1,userId:'user_A',key:'original-key',body:{amountCents:'200',destinationId:'bank',policyVersion:'server_policy',expectedWalletVersion:'1'}}));await p.render();assert(p.host.querySelector('[data-testid="bank-binding-workspace"]'));assert.equal(p.host.querySelector('[data-testid="bank-binding-workspace"]').dataset.scope,'user_A:1');assert.match(p.host.textContent,/银行卡与提现/);assert(p.host.querySelector('a[href*="wallet=withdraw-local"]'));assert(!p.host.querySelector('.controlled-withdrawal'));}finally{localStorage.removeItem(withdrawalMarker);await p.close();}});

test('an uncovered historical movement is neutral in list and detail',async()=>{
 const historic={...entry,id:'history:uncovered',kind:'HISTORICAL',sourceKind:'HISTORICAL_EARNINGS_LOG',purpose:'WITHDRAWAL_REJECTED_RETURN',deltaCents:'1776',includedInOpening:false};
 const p=await probe(async url=>String(url).includes('/entries/')?reply({...ctx(),entry:historic}):String(url).includes('/entries?')?reply({...page(),items:[historic]}):reply(wallet()),'wallet=entries');
 try{await p.render();const row=p.host.querySelector('.wallet-record');assert.match(row.textContent,/提现退回.*旧平台记录/);assert.doesNotMatch(row.textContent,/已入账|已扣除/);
  await p.setQuery('wallet=entry&entry=history%3Auncovered');const detail=p.host.querySelector('.wallet-entry-detail');assert(detail);assert.match(detail.textContent,/是否计入原有余额，暂未确认/);assert.doesNotMatch(detail.textContent,/已计入原有余额|已入账|已扣除/);
 }finally{await p.close();}
});

test('balance history does not offer refund or pending-earnings filters',async()=>{
 const empty={...page(),items:[],nextCursor:null,totals:{...page().totals,count:'0',byBucket:[]},listCoverage:{knowledge:'KNOWN',count:'0',mappedRecordCount:'0',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:at,version:'proof'}};
 const p=await probe(async url=>String(url).includes('/entries?')?reply(empty):reply(wallet()),'wallet=entries');
 try{await p.render();assert.match(p.host.textContent,/暂无流水/);assert.doesNotMatch(p.host.textContent,/待退款|待结算收益|提现处理中/);}finally{await p.close();}
});

/* --- Personal Wallet Native Withdrawal Behavior Tests --- */
const withdrawalWallet = (snapshotVersion = "snapshot_1", nativeWithdrawal) => ({ subjectId: "user_A", contractVersion: "personal-finance.read.v1", asOf: at, snapshotVersion, coverage: { knowledge: "KNOWN", origin: "RECONCILED_OPENING", coverageVersion: "1" }, ledgerRevision: "1", readRevision: snapshotVersion === "snapshot_1" ? "1" : "2", buckets: { available: money("123456"), reserved: money(null), restricted: money(null), pendingEarnings: money(null), refundPayable: money(null) }, withdrawable: { ...money(null), reasonCodes: ["POLICY_NOT_CONFIRMED"] }, nativeWithdrawal });
const nativeDebt = (amount = "312") => ({ scope: "NATIVE_REFERRAL_OBLIGATIONS_ONLY", subjectInScope: true, globalWithdrawable: "UNKNOWN", reservationState: amount === "0" ? "REQUIRES_CURRENT_QUOTE" : "BLOCKED_BY_RECOVERY", recovery: { knowledge: "KNOWN", outstandingCents: amount, earningCount: amount === "0" ? "0" : "1", scope: "NATIVE_REFERRAL_OBLIGATIONS_ONLY" } });
const withdrawalLocalScope = nativeWithdrawal => ({ scope: "LOCAL_CONTROLLED", subjectId: "user_A", coverage: { knowledge: "KNOWN", meaning: "EXPLICIT_LOCAL_INTENTS_ONLY_NOT_TOTAL_HISTORICAL_WALLET", cohorts: [{ id: "cohort", revision: "1", start: at, end: "2026-10-05T00:00:00Z" }] }, nativeWithdrawal, items: [], destinations: [{ id: "bank", kind: "BANK_CARD", mask: "local bank", policyVersion: "server_policy", perIntentCents: "200", canQuote: true }], totals: { reservedCents: "0", payoutCents: "0", feeCents: "0" }, globalReserved: "UNKNOWN" });
const compiledWithdrawal = ts.transpileModule(readFileSync(`${tree}/apps/web/src/components/account/controlled-withdrawal.tsx`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

async function probeWithdrawal(fetcher) {
  const window = new Window({ url: "http://127.0.0.1:4200/account?view=wallet" });
  Object.assign(globalThis, { window, localStorage: window.localStorage, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, revalidations: 0, revalidate() { this.revalidations++; } };
  const store = { getSnapshot: () => session };
  const module = new Module(`${tree}/wallet-withdrawal-probe.cjs`);
  module.filename = `${tree}/wallet-withdrawal-probe.cjs`;
  module.paths = Module._nodeModulePaths(tree);
  module.require = name => {
    if (name === "@/components/session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => store };
    if (name === "@/lib/personal-wallet-client") return client;
    if (name === "@/lib/controlled-withdrawal-client") return require(`${tree}/apps/web/src/lib/controlled-withdrawal-client.ts`);
    if (name === "@/components/ui/information") return information; if (name === "@/lib/order-client") return require(`${tree}/apps/web/src/lib/order-client.ts`); if (name === "@/lib/withdrawal-bank-binding-client") return require(`${tree}/apps/web/src/lib/withdrawal-bank-binding-client.ts`); if (name.endsWith(".css")) return {};
    if (name === "next/link") return props => React.createElement("a", props);
    return require(name);
  };
  module._compile(compiledWithdrawal, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const settle = async () => { for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(setImmediate); }); };
  const commits = [];
  function StableProbe({value}) {
    const scope = `${session.userId}:${session.identityVersion}`;
    React.useLayoutEffect(() => { commits.push({scope, detail:host.querySelector('[aria-label="历史提现记录详情"]')?.textContent??''}); });
    return React.createElement(module.exports.ControlledWithdrawal,{wallet:value,scope,onWalletChanged(){}});
  }
  return {
    host,
    session,
    commits,
    settle,
    async render(value) { await React.act(async () => root.render(React.createElement(StableProbe, { value }))); await settle(); },
    async fill(selector, value) { const target = host.querySelector(selector); assert(target); const proto = target.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await React.act(async () => { Object.getOwnPropertyDescriptor(proto, "value").set.call(target, value); target.dispatchEvent(new window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); await settle(); },
    async click(selector) { const target = host.querySelector(selector); assert(target); await React.act(async () => { target.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(setImmediate); }); await settle(); },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); globalThis.fetch = previousFetch; }
  };
}

test("read-only wallet revision change reloads eligibility and invalidates a late old quote", async () => {
  let debt = false, scopeReads = 0;
  const late = deferred();
  const p = await probeWithdrawal(async url => { if (String(url).endsWith("/quote")) return late.promise; scopeReads++; return reply(localScope(debt ? nativeDebt() : nativeDebt("0"))); });
  try {
    await p.render(withdrawalWallet("snapshot_1", nativeDebt("0")));
    await p.fill("#withdraw-destination", "bank"); await p.fill("#withdraw-amount", "2"); await p.click("button[type=submit]");
    debt = true;
    await p.render(withdrawalWallet("snapshot_2", nativeDebt()));
    late.resolve(reply({ quote: { scope: "LOCAL_CONTROLLED", userId: "user_A", destinationId: "bank", destination: { id: "bank", mask: "local bank" }, policyVersion: "server_policy", ledgerRevision: "1", acceptedAt: at, grossCents: "200", netCents: "100", feeCents: "100", requestKey: "old-key", globalWithdrawable: "UNKNOWN", identityMeaning: "EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC" } }));
    await p.settle();
    assert(scopeReads >= 2); assert.match(p.host.textContent, /邀请收益待退回/); assert.equal(p.host.querySelector(".wallet-withdraw-quote"), null); assert(p.host.querySelector("button[type=submit]").disabled);
  } finally { late.resolve(reply({})); await p.close(); }
});

const historyItem={id:'history:obs_A',source:'HISTORICAL_WITHDRAWAL',sourceReference:{type:'LEGACY_MYSQL',system:'restore',entity:'la_withdraw_apply',id:'PRIVATE_HISTORY_A'},originalNumber:'PRIVATE_HISTORY_A',sourceStatus:2,amountCents:'10000',netCents:'9900',feeCents:'100',occurredAt:at,importedAt:at,sourceDigest:'a'.repeat(64),includedInOpening:false,accountingEffect:'OBSERVATION_ONLY_NO_NEW_DEBIT',channelArrivalKnowledge:'UNKNOWN'};
const historyRead=(user='user_A',items=[historyItem])=>({contractVersion:'personal-withdrawals.read.v1',subjectId:user,source:'ALL',state:'ALL',historical:{source:'HISTORICAL_WITHDRAWAL',availability:items.length?'AVAILABLE':'NOT_IMPORTED',coverage:{knowledge:'UNKNOWN',reason:'HISTORICAL_WITHDRAWAL_COVERAGE_NOT_CLOSED'},items,mappedRecordCount:String(items.length),count:null,asOf:at,snapshotVersion:'history-v1',nextCursor:null},controlled:{availability:'NOT_ADMITTED',reason:'CONTROLLED_RESOURCE_NOT_ADMITTED',data:null}});
test('history remains readable without a wallet, keeps the raw source status and never enables a withdrawal form',async()=>{
 let posts=0;const p=await probeWithdrawal(async(_url,options)=>{if(options.method==='POST')posts++;return reply(historyRead());});
 try{await p.render(null);assert.match(p.host.querySelector('[data-testid="historical-withdrawals"]').textContent,/处理中|¥100\.00/);assert.doesNotMatch(p.host.textContent,/到账成功/);assert.equal(p.host.querySelector('.wallet-withdraw-form'),null);assert.equal(posts,0);assert.match(p.host.textContent,/到账情况未记录/);}
 finally{await p.close();}
});
test('new identity render cannot expose the old history detail before passive effects clear it',async()=>{
 const late=deferred();let phase='A';const p=await probeWithdrawal(async url=>phase==='B'?late.promise:reply(String(url).includes('history%3A')?{contractVersion:'personal-withdrawals.read.v1',subjectId:'user_A',source:'HISTORICAL_WITHDRAWAL',item:historyItem}:historyRead()));
 try{await p.render(null);await p.click('[data-testid="historical-withdrawals"] .wallet-withdraw-record button');assert.match(p.host.querySelector('[aria-label="历史提现记录详情"]').textContent,/PRIVATE_HISTORY_A/);phase='B';p.session.userId='user_B';p.session.identityVersion=2;const mark=p.commits.length;await p.render(null);const firstB=p.commits.slice(mark).find(commit=>commit.scope==='user_B:2');assert(firstB,'new-scope layout commit was observed');assert.doesNotMatch(firstB.detail,/PRIVATE_HISTORY_A/);late.resolve(reply(historyRead('user_B',[])));await p.settle();assert.doesNotMatch(p.host.textContent,/PRIVATE_HISTORY_A/);}
 finally{late.resolve(reply(historyRead('user_B',[])));await p.close();}
});
test('revoked history detail clears prior private projection and does not retry a business command',async()=>{
 let deny=false,posts=0;const p=await probeWithdrawal(async(url,options)=>{if(options.method==='POST')posts++;if(String(url).includes('history%3A'))return deny?reply({error:{code:'UNAUTHENTICATED'}},401):reply({contractVersion:'personal-withdrawals.read.v1',subjectId:'user_A',source:'HISTORICAL_WITHDRAWAL',item:historyItem});return reply(historyRead());});
 try{await p.render(null);await p.click('[data-testid="historical-withdrawals"] .wallet-withdraw-record button');assert.match(p.host.textContent,/PRIVATE_HISTORY_A/);deny=true;await p.click('[data-testid="historical-withdrawals"] .wallet-withdraw-record button');assert.doesNotMatch(p.host.textContent,/PRIVATE_HISTORY_A/);assert.equal(p.session.revalidations,1);assert.equal(posts,0);}
 finally{await p.close();}
});
test('unreadable original marker blocks new actions without hiding readable history or rewriting the marker',async()=>{let gets=0,posts=0;const p=await probeWithdrawal(async(_url,options)=>{if(options.method==='POST')posts++;else gets++;return reply(historyRead());});try{localStorage.setItem('zzsh.withdrawal.pending.v1:user_A','bad original marker');await p.render(null);assert(gets>0);assert.match(p.host.querySelector('[data-testid="historical-withdrawals"]').textContent,/处理中/);assert.match(p.host.textContent,/上次申请结果未记录/);assert.equal(localStorage.getItem('zzsh.withdrawal.pending.v1:user_A'),'bad original marker');assert.equal(posts,0);}finally{await p.close();}});

test("native debt parser rejects contradictory eligibility and unknown zero", () => {
  assert.equal(client.parseNativeReservation(undefined), undefined);
  assert.equal(client.parseNativeReservation(nativeDebt()).recovery.outstandingCents, "312");
  assert.throws(() => client.parseNativeReservation({ ...nativeDebt(), reservationState: "REQUIRES_CURRENT_QUOTE" }));
  assert.throws(() => client.parseNativeReservation({ ...nativeDebt(), recovery: { knowledge: "UNKNOWN", outstandingCents: "0", earningCount: "0", reason: "missing" } }));
});

test("debt blocks new actions but preserves original receipt recovery and available balance", async () => {
  const methods = [];
  const p = await probeWithdrawal(async (url, options) => { methods.push(options?.method ?? "GET"); return reply(String(url).includes("/withdrawals") ? withdrawalLocalScope(nativeDebt()) : { wallet: wallet("snapshot_1", nativeDebt()) }); });
  try {
    localStorage.setItem("zzsh.withdrawal.pending.v1:user_A", JSON.stringify({ version: 1, userId: "user_A", key: "original", body: { amountCents: "200", destinationId: "bank", policyVersion: "policy", expectedWalletVersion: "1" } }));
    await p.render(withdrawalWallet("snapshot_1", nativeDebt()));
    assert.match(p.host.textContent, /¥3\.12.*邀请收益待退回/); assert.match(p.host.textContent, /¥1,234\.56/); assert(p.host.querySelector("button[type=submit]").disabled);
    const recover = [...p.host.querySelectorAll("button")].find(button => button.textContent === "查询申请进度"); assert(recover); assert.equal(recover.disabled, false); assert(methods.every(method => method === "GET"));
  } finally { await p.close(); }
});

test("R2: the amount field's helper is actually bound to the control it explains", async () => {
  const p = await probeWithdrawal(async () => reply(withdrawalLocalScope(nativeDebt("0"))));
  try {
    await p.render(withdrawalWallet("snapshot_1", nativeDebt("0")));
    const input = p.host.querySelector("#withdraw-amount");
    assert(input, "#withdraw-amount 必须渲染");
    const label = p.host.querySelector('label[for="withdraw-amount"]');
    assert(label, "金额字段必须有 for 指向控件的 label");
    const describedBy = input.getAttribute("aria-describedby");
    assert(describedBy, "金额控件必须有 aria-describedby");
    const ids = describedBy.split(/\s+/).filter(Boolean);
    assert(ids.length >= 1, "aria-describedby 不能为空");
    const targets = ids.map(id => p.host.querySelector(`[id="${id}"]`));
    assert(targets.every(Boolean), "aria-describedby 必须指向真实存在的元素");
    assert(targets.some(node => /余额/.test(node.textContent || "")), "说明必须包含余额口径");
    assert(targets.some(node => node.textContent.includes("测试申请金额")), "说明必须包含每笔准入");
    // 没有说明的目标字段不应留下悬空引用。
    const destination = p.host.querySelector("#withdraw-destination");
    assert(destination, "#withdraw-destination 必须渲染");
    assert.equal(destination.getAttribute("aria-describedby"), null);
  } finally { await p.close(); }
});

/* --- Personal Earnings Behavior Tests --- */
const earningsClient=require(tree+'/apps/web/src/lib/distribution-earnings-client.ts');
const compiledEarnings=ts.transpileModule(readFileSync(tree+'/apps/web/src/components/account/personal-earnings.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const earningsAt='2026-10-04T00:00:00.000000Z',earningsOld={id:'history:one',origin:'LEGACY_MYSQL',state:'SETTLED',role:'RENTER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'1234'},occurredAt:earningsAt,dueAt:null,dueAtKnowledge:'UNKNOWN',fundsDisposition:'HISTORICAL_STATUS_ONLY',recoveryRequiredCents:null,includedInOpening:true,version:null,accountingEffect:'OBSERVATION_ONLY_NO_NEW_CREDIT',businessReference:{type:'LEGACY_UNRESOLVED',id:'legacy'},channelArrivalKnowledge:'UNKNOWN'};
const earningsNative={...earningsOld,id:'native:two',origin:'NATIVE',state:'RECOVERY_REQUIRED',role:'OWNER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'1000'},dueAt:earningsAt,dueAtKnowledge:'KNOWN',fundsDisposition:'SETTLED',recoveryRequiredCents:'1000',includedInOpening:false,version:'3',accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'}};
const earningsBase=user=>({contractVersion:'distribution-earnings.read.v1',projectionVersion:2,subjectId:user,snapshotVersion:'v1',asOf:earningsAt});
const earningsPage=(user,items=[earningsOld,earningsNative])=>({...earningsBase(user),state:'ALL',knowledge:'UNKNOWN',count:null,mappedRecordCount:String(items.length),reason:'HISTORICAL_EARNINGS_COVERAGE_NOT_CLOSED',totalAmountKnowledge:'UNKNOWN',amountsByOrigin:{scope:'SOURCE_RECORDS_ONLY',native:{knowledge:'UNKNOWN',amountCents:null},historical:{knowledge:'UNKNOWN',amountCents:null},mappedHistoricalAmountCents:items.filter(i=>i.origin==='LEGACY_MYSQL').reduce((s,i)=>s+BigInt(i.amount.amountCents),0n).toString()},items,nextCursor:null});
async function probeEarnings(fetcher,query='view=invite'){
 const w=new Window({url:'http://127.0.0.1:4200/account?'+query}),previous=globalThis.fetch;
 Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,MouseEvent:w.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});globalThis.fetch=fetcher;
 const session={status:'authenticated',userId:'user_A',identityVersion:1,revalidations:0,revalidate(){this.revalidations++;}},m=new Module(tree+'/earnings-ui-probe.cjs');
 let params=new URLSearchParams(query),render,refreshNonce=0;
 const navigation=[];const router={push(href){navigation.push(href);params=new URL(href,w.location.origin).searchParams;}};
 m.filename=tree+'/earnings-ui-probe.cjs';m.paths=Module._nodeModulePaths(tree);m.require=name=>{
  if(name==='next/link')return({scroll:_scroll,...props})=>React.createElement('a',props);
  if(name==='next/navigation')return{useSearchParams:()=>params,useRouter:()=>router};
  if(name==='@/components/session/user-session-provider')return{useUserSession:()=>session,useUserSessionStore:()=>({getSnapshot:()=>session})};
  if(name==='@/lib/distribution-earnings-client')return earningsClient;if(name==='@/lib/personal-wallet-client')return client;
  if(name==='@/lib/order-client')return require(tree+'/apps/web/src/lib/order-client.ts');if(name.endsWith('.css'))return{};return require(name);
 };
 m._compile(compiledEarnings,m.filename);const host=w.document.createElement('div');w.document.body.append(host);const root=require('react-dom/client').createRoot(host);
 const settle=async()=>{for(let i=0;i<3;i++)await React.act(async()=>{await new Promise(setImmediate);});};
 render=async()=>{await React.act(async()=>root.render(React.createElement(m.exports.PersonalEarnings,{scope:session.userId+':'+session.identityVersion,refreshNonce})));await settle();};
 return{host,session,settle,render,navigation,params:()=>params,
  async refresh(){refreshNonce++;await render();},
  async setQuery(query){params=new URLSearchParams(query);await render();},
  async click(label){const button=[...host.querySelectorAll('button')].find(b=>b.textContent.includes(label));assert(button);const before=params.toString();await React.act(async()=>button.dispatchEvent(new w.MouseEvent('click',{bubbles:true})));if(before!==params.toString())await render();await settle();return button;},
  async close(){await React.act(async()=>root.unmount());await w.happyDOM.abort();globalThis.fetch=previous;}
 };
}

test('actual earnings component preserves partial truth, shows original history and returns focus to its row',async()=>{let lists=0;const p=await probeEarnings(async url=>{if(String(url).includes('/history%3Aone'))return Response.json({...earningsBase('user_A'),item:earningsOld});lists++;return Response.json(earningsPage('user_A'));});try{await p.render();assert.match(p.host.textContent,/已显示 2 条 · 完整数量待核/);const button=await p.click('邀请租客下单');assert.match(p.host.querySelector('.earning-detail').textContent,/已包含在余额中，不会重复计算/);assert.match(p.host.querySelector('.earning-detail').textContent,/未核定/);assert.equal(document.activeElement,p.host.querySelector('h4'));await p.click('返回收益列表');assert.equal(document.activeElement,button);assert.equal(lists,1);}finally{await p.close();}});

test('U07 opening, refreshing and back/forward preserve the exact earning and existing account query',async()=>{
 const fetcher=async url=>Response.json(String(url).includes('/history%3Aone')?{...earningsBase('user_A'),item:earningsOld}:earningsPage('user_A'));
 const p=await probeEarnings(fetcher,'view=invite&tab=earnings&page=2');let target;
 try{await p.render();await p.click('邀请租客下单');target=p.navigation.at(-1);assert.ok(target,'opening detail must produce a stable URL');
  const q=new URL(target,'http://127.0.0.1').searchParams;assert.equal(q.get('earning'),'history:one');assert.equal(q.get('view'),'invite');assert.equal(q.get('page'),'2');assert.equal(q.get('tab'),'earnings');
  await p.click('返回收益列表');assert.equal(p.params().get('earning'),null);assert.equal(p.params().get('page'),'2');
  await p.setQuery(q.toString());assert.match(p.host.querySelector('.earning-detail').textContent,/邀请租客下单详情/);
 }finally{await p.close();}
 const restored=await probeEarnings(fetcher,new URL(target,'http://127.0.0.1').searchParams.toString());
 try{await restored.render();assert.match(restored.host.querySelector('.earning-detail').textContent,/邀请租客下单详情/);}finally{await restored.close();}
});

test('U04 real detail shows frozen terms without inventing a base, and history explains missing original terms',async()=>{
 const calculation={knowledge:'KNOWN',policyVersion:'FROZEN_POLICY_ONLY',beneficiaryLevelCode:'LEVEL_FROZEN',percent:'7.5',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null};
 const p=await probeEarnings(async()=>Response.json({...earningsBase('user_A'),item:{...earningsNative,calculation}}),'view=invite&earning=native%3Atwo');
 try{await p.render();const text=p.host.querySelector('.earning-calculation').textContent;assert.match(text,/7\.5%/);assert.match(text,/LEVEL_FROZEN/);assert.doesNotMatch(text,/FROZEN_POLICY_ONLY/);assert.equal(earningsClient.earningsDetail({...earningsBase('user_A'),item:{...earningsNative,calculation}},'user_A','native:two',2).item.calculation.policyVersion,'FROZEN_POLICY_ONLY');assert.match(text,/四舍五入到分/);assert.match(text,/扣除补偿费用/);assert.doesNotMatch(text,/基数.*¥/);}finally{await p.close();}
 const historical=await probeEarnings(async()=>Response.json({...earningsBase('user_A'),item:{...earningsOld,state:'EXPIRED',includedInOpening:false}}),'view=invite&earning=history%3Aone');
 try{await historical.render();const text=historical.host.querySelector('.earning-calculation').textContent;assert.match(text,/原计算比例待核/);assert.match(text,/原因尚未提供/);assert.doesNotMatch(text,/5%|0%/);}finally{await historical.close();}
});

test('U07 malformed IDs do not fetch and late previous detail cannot replace the current URL target',async()=>{
 let calls=0;const bad=await probeEarnings(async()=>{calls++;throw Error('invalid id must not fetch');},'view=invite&earning=bad%2Fpath');
 try{await bad.render();assert.equal(calls,0);assert.match(bad.host.textContent,/这条佣金记录暂不可用/);}finally{await bad.close();}
 let resolve;const pending=new Promise(done=>{resolve=done;});
 const p=await probeEarnings(async url=>String(url).includes('history%3Aone')?pending:Response.json({...earningsBase('user_A'),item:{...earningsOld,id:'history:other',amount:{...earningsOld.amount,amountCents:'9900'}}}),'view=invite&earning=history%3Aone');
 try{await p.render();await p.setQuery('view=invite&earning=history%3Aother');await React.act(async()=>resolve(Response.json({...earningsBase('user_A'),item:earningsOld})));await p.settle();assert.match(p.host.querySelector('.earning-detail').textContent,/99\.00/);assert.doesNotMatch(p.host.querySelector('.earning-detail').textContent,/12\.34/);}finally{resolve(Response.json({...earningsBase('user_A'),item:earningsOld}));await p.close();}
});

test('U07 returning to a filtered list preserves loaded pages and its signed next-cursor progress',async()=>{
 let lists=0;const first={...earningsPage('user_A',[earningsOld]),state:'SETTLED',mappedRecordCount:'2',nextCursor:'original-signed-cursor'};
 const p=await probeEarnings(async url=>{const s=String(url);if(s.includes('/history%3Aone'))return Response.json({...earningsBase('user_A'),snapshotVersion:'ALL-state-detail-snapshot',item:earningsOld});lists++;assert.equal(new URL(s,'http://127.0.0.1').searchParams.get('state'),'SETTLED');return Response.json(s.includes('cursor=')?{...first,items:[{...earningsNative,state:'SETTLED',recoveryRequiredCents:null}],nextCursor:null}:first);},'view=invite&earningState=SETTLED&page=2&cursor=existing-account-cursor');
 try{await p.render();await p.click('加载更多收益');assert.equal(p.host.querySelectorAll('.earning-record').length,2);await p.click('邀请租客下单');assert.equal(p.params().get('earningState'),'SETTLED');assert.equal(p.params().get('cursor'),'existing-account-cursor');await p.click('返回收益列表');assert.equal(p.host.querySelectorAll('.earning-record').length,2);assert.equal(lists,2);assert.equal(p.params().get('page'),'2');}finally{await p.close();}
});
test('recovery detail preserves unsettled debt instead of claiming a reversal or payout',async()=>{const p=await probeEarnings(async url=>Response.json(String(url).includes('/native%3Atwo')?{...earningsBase('user_A'),item:earningsNative}:earningsPage('user_A')));try{await p.render();await p.click('邀请号主出租');const text=p.host.querySelector('.earning-detail').textContent;assert.match(text,/待追回金额/);assert.match(text,/需要追回的金额还没扣完/);assert.doesNotMatch(text,/已到账|已扣回/);}finally{await p.close();}});
test('definite 401 clears list and detail and revalidates shared identity',async()=>{let denied=false;const p=await probeEarnings(async()=>denied?Response.json({error:{code:'UNAUTHENTICATED'}},{status:401}):Response.json(earningsPage('user_A')));try{await p.render();assert.equal(p.host.querySelectorAll('.earning-record').length,2);denied=true;await p.refresh();assert.equal(p.host.querySelectorAll('.earning-record').length,0);assert.equal(p.session.revalidations,1);}finally{await p.close();}});
test('late previous identity earnings never replace the new subject list',async()=>{let phase='old',resolveOld;const pending=new Promise(r=>resolveOld=r),p=await probeEarnings(async()=>phase==='old'?pending:Response.json(earningsPage('user_B',[{...earningsOld,amount:{...earningsOld.amount,amountCents:'9900'}}])));try{await p.render();phase='new';p.session.userId='user_B';p.session.identityVersion=2;await p.render();await React.act(async()=>resolveOld(Response.json(earningsPage('user_A'))));await p.settle();assert.match(p.host.textContent,/99\.00/);assert.doesNotMatch(p.host.textContent,/12\.34/);}finally{resolveOld(Response.json(earningsPage('user_A')));await p.close();}});
test('next-page snapshot drift clears stale records instead of joining incompatible states',async()=>{const p=await probeEarnings(async url=>Response.json(String(url).includes('cursor=')?{...earningsPage('user_A',[earningsNative]),snapshotVersion:'changed',mappedRecordCount:'2'}:{...earningsPage('user_A',[earningsOld]),mappedRecordCount:'2',nextCursor:'next'}));try{await p.render();await p.click('加载更多收益');assert.equal(p.host.querySelectorAll('.earning-record').length,0);assert.match(p.host.textContent,/佣金记录已更新/);}finally{await p.close();}});
test('new platform zero finalization is visible next to unchanged original pending amount and is never labelled paid out',async()=>{const entry={...earningsOld,state:'PENDING',includedInOpening:false,currentFinance:{knowledge:'KNOWN',state:'SETTLED',amountCents:'0',zeroFinalization:true,reference:{type:'FINANCE_EVENT',id:'final-zero',digest:'a'.repeat(64)}}},p=await probeEarnings(async url=>Response.json(String(url).includes('/history%3Aone')?{...earningsBase('user_A'),item:entry}:earningsPage('user_A',[entry])));try{await p.render();assert.match(p.host.querySelector('.earning-record').textContent,/状态待确认/);await p.click('邀请租客下单');const detail=p.host.querySelector('.earning-detail').textContent;assert.match(detail,/原记录状态待结算/);assert.match(detail,/入账金额¥0\.00/);assert.match(detail,/本次入账金额为零/);assert.doesNotMatch(detail,/已到账|已打款/);}finally{await p.close();}});

test('uniform frozen calculation uses its own rate and never renders a missing grade as unknown',async()=>{
 const calculation={knowledge:'KNOWN',policyVersion:'FROZEN_UNIFORM',beneficiaryLevelCode:null,rateMode:'UNIFORM',percent:'2.125',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null};
 const p=await probeEarnings(async url=>{assert.equal(new URL(String(url),'http://fixture.invalid').searchParams.get('calculationVersion'),'2');return Response.json({...earningsBase('user_A'),item:{...earningsNative,calculation}});},'view=invite&earning=native%3Atwo');
 try{await p.render();const text=p.host.querySelector('.earning-calculation').textContent;assert.match(text,/2\.125%/);assert.doesNotMatch(text,/FROZEN_UNIFORM/);assert.doesNotMatch(text,/付款时分销等级|null|undefined|适用比例及等级待确认/);}finally{await p.close();}
});

test('Native frozen terms are not relabelled local-controlled or channel arrival',async()=>{
 const calculation={knowledge:'KNOWN',policyVersion:'NATIVE_FROZEN',beneficiaryLevelCode:null,rateMode:'UNIFORM',percent:'2',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'NATIVE',orderNumber:null};
 const p=await probeEarnings(async()=>Response.json({...earningsBase('user_A'),item:{...earningsNative,calculation}}),'view=invite&earning=native%3Atwo');try{await p.render();const text=p.host.querySelector('.earning-calculation').textContent;assert.match(text,/佣金按订单结算后/);assert.doesNotMatch(text,/本地联验政策|已到账/);}finally{await p.close();}
});
test('current responsibility VOID/MATURED is shown apart from the original state and never claims payout',async()=>{
 const resp=(patch={})=>({knowledge:'KNOWN',dutyId:'legacy_duty_a',orderId:'legacy_order_b',state:'VOID',amountCents:'900',currency:'CNY',revision:'2',revised:true,maturityAt:'2026-10-05T00:00:00.000000Z',settledBy:null,...patch});
 const entry={...earningsOld,currentResponsibility:resp()},p=await probeEarnings(async url=>Response.json(String(url).includes('/history%3Aone')?{...earningsBase('user_A'),item:entry}:earningsPage('user_A',[entry])));
 try{await p.render();assert.match(p.host.querySelector('.earning-record').textContent,/¥9\.00已取消/);assert.doesNotMatch(p.host.querySelector('.earning-record').textContent,/历史记录|原记录：/);await p.click('邀请租客下单');const detail=p.host.querySelector('.earning-detail').textContent;assert.match(detail,/原记录状态已结算/);assert.match(detail,/这笔佣金已取消/);assert.match(detail,/¥9\.00/);assert.match(detail,/金额调整/);assert.doesNotMatch(detail,/已到账|已打款/);}finally{await p.close();}
 const matured={...earningsOld,currentResponsibility:resp({state:'MATURED'})},q=await probeEarnings(async url=>Response.json(String(url).includes('/history%3Aone')?{...earningsBase('user_A'),item:matured}:earningsPage('user_A',[matured])));
 try{await q.render();assert.match(q.host.querySelector('.earning-record').textContent,/¥9\.00已到期，待结算/);await q.click('邀请租客下单');const detail=q.host.querySelector('.earning-detail').textContent;assert.match(detail,/收益进度已到可结算时间，等待结算/);assert.match(detail,/预计可结算时间/);assert.doesNotMatch(detail,/已到账|已打款/);}finally{await q.close();}
});
test('Root a settled duty without verified finance retains the original row state and never claims verified accounting',async()=>{
 const item={...earningsOld,currentResponsibility:{knowledge:'KNOWN',dutyId:'legacy_duty_a',orderId:'legacy_order_b',state:'SETTLED',amountCents:'900',currency:'CNY',revision:'3',revised:true,maturityAt:at,settledBy:'FINANCE'}};
 const p=await probeEarnings(async url=>Response.json(String(url).includes('/history%3Aone')?{...earningsBase('user_A'),item}:earningsPage('user_A',[item])));
 try{
  await p.render();const row=p.host.querySelector('.earning-record').textContent;
  assert.match(row,/¥9\.00已结算/);assert.doesNotMatch(row,/原记录：|历史记录/);assert.doesNotMatch(row,/本站财账已终定|已按原责任入账/);
  await p.click('邀请租客下单');const detail=p.host.querySelector('.earning-detail').textContent;
  assert.match(detail,/记录显示已结清/);assert.doesNotMatch(detail,/本站财账已终定|已按原责任入账/);
 }finally{await p.close();}
});

const unifiedRecord=(item,key,effectiveState=item.state,amountCents=item.amount.amountCents,responsibility=null)=>({id:item.id,key:'commission:'+key.repeat(64),effectiveState,amountCents,occurredAt:item.occurredAt,stateKnowledge:effectiveState==='UNKNOWN'?'UNKNOWN':'KNOWN',detail:{source:{type:item.origin,system:'source',entity:'commissions',id:item.id},stateBasis:responsibility?'CURRENT_RESPONSIBILITY':effectiveState==='UNKNOWN'?'UNKNOWN':item.origin==='NATIVE'?'POSTED_RECORD':'SOURCE_RECORD',originalState:item.state,originalAmountCents:item.amount.amountCents,currentResponsibility:responsibility??(item.origin==='NATIVE'?null:{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_NOT_ADMITTED'}),currentFinance:item.origin==='NATIVE'?null:{knowledge:'UNKNOWN',reason:'LEGACY_FINANCE_NOT_ADMITTED_OR_NOT_FINALIZED'},accountingEffect:item.accountingEffect,bankArrival:'UNKNOWN',reasonCodes:[]}});
const unifiedSummary=(states,patch={})=>{const count=states.reduce((n,s)=>n+BigInt(s.count),0n).toString(),amount=states.reduce((n,s)=>n+BigInt(s.amountCents),0n).toString();return{scope:'COMMISSION_RECORDS',knowledge:'KNOWN',count,mappedRecordCount:count,amountCents:amount,knownSubtotalCents:amount,unknownStateCount:'0',unclassifiedRecordCount:'0',states,coverage:{knowledge:'KNOWN',cutoff:at,reasonCodes:[]},reasonCodes:[],...patch};};
test('actual unified timeline keeps both sources together with exact revised amounts and source details only after opening',async()=>{
 const duty={knowledge:'KNOWN',dutyId:'duty',orderId:'order',state:'MATURED',amountCents:'900',currency:'CNY',revision:'2',revised:true,maturityAt:at,settledBy:null};
 const legacy={...earningsOld,currentResponsibility:duty},n={...earningsNative,state:'SETTLED',fundsDisposition:'SETTLED',recoveryRequiredCents:null,amount:{...earningsNative.amount,amountCents:'999999999999999999999999'}};
 legacy.record=unifiedRecord(legacy,'a','MATURED','900',duty);n.record=unifiedRecord(n,'b');
 const summary=unifiedSummary([{state:'MATURED',count:'1',amountCents:'900'},{state:'SETTLED',count:'1',amountCents:n.amount.amountCents}]);
 const p=await probeEarnings(async url=>Response.json(String(url).includes('/history%3Aone')?{...earningsBase('user_A'),item:legacy}:{...earningsPage('user_A',[n,legacy]),recordSummary:summary}));
 try{await p.render();const rows=[...p.host.querySelectorAll('.earning-record')];assert.equal(rows.length,2);assert.match(rows[1].textContent,/¥9\.00已到期，待结算/);assert.doesNotMatch(rows.map(row=>row.textContent).join(''),/历史|本平台|原生/);assert.equal(p.host.querySelectorAll('select').length,1);assert.match(p.host.querySelector('.earnings-total').textContent,/¥10,000,000,000,000,000,000,008\.99/);assert.match(p.host.querySelector('.earnings-total').textContent,/不代表余额/);await p.click('邀请租客下单');const details=p.host.querySelector('.earning-record-explanation');assert.equal(details.open,false);assert.match(details.textContent,/历史记录/);assert.match(details.textContent,/原记录金额¥12\.34/);assert.match(p.host.querySelector('.earning-detail-amount').textContent,/¥9\.00/);assert.doesNotMatch(p.host.querySelector('.earning-detail').textContent,/已到账|已打款/);}finally{await p.close();}
});
test('state selection requests effective filters and an empty pending page remains incomplete when other records are unclassified',async()=>{
 const requests=[],pending=unifiedSummary([],{knowledge:'UNKNOWN',count:null,amountCents:null,unclassifiedRecordCount:'1'}),entry={...earningsOld,state:'PENDING'};entry.record=unifiedRecord(entry,'c','UNKNOWN');
 const unknown=unifiedSummary([{state:'UNKNOWN',count:'1',amountCents:'1234'}],{knowledge:'UNKNOWN',count:null,amountCents:null,unknownStateCount:'1',unclassifiedRecordCount:'1'});
 const p=await probeEarnings(async url=>{const state=new URL(String(url),'http://fixture').searchParams.get('state');requests.push(state);return Response.json({...earningsPage('user_A',state==='UNKNOWN'?[entry]:[]),state,mappedRecordCount:state==='UNKNOWN'?'1':'0',recordSummary:state==='UNKNOWN'?unknown:pending});},'view=invite&earningState=PENDING');
 try{await p.render();assert.match(p.host.textContent,/另有 1 条记录状态待确认/);assert.match(p.host.querySelector('.earnings-empty').textContent,/完整数量仍待核对/);assert.doesNotMatch(p.host.querySelector('.earnings-empty').textContent,/暂无佣金记录/);const select=p.host.querySelector('select');await React.act(async()=>{select.value='UNKNOWN';select.dispatchEvent(new window.Event('change',{bubbles:true}));});await p.render();assert.equal(requests.at(-1),'UNKNOWN');assert.equal(p.params().get('earningState'),'UNKNOWN');assert.match(p.host.querySelector('.earning-record').textContent,/状态待确认/);assert.equal(p.host.querySelectorAll('.earning-record').length,1);}finally{await p.close();}
});

test('commission filters group choices without removing or merging states',async()=>{
 const p=await probeEarnings(async()=>Response.json(earningsPage('user_A',[earningsOld])));
 try{await p.render();const select=p.host.querySelector('select');assert.deepEqual([...select.querySelectorAll('optgroup')].map(group=>group.label),['结算进度','其他状态']);assert.deepEqual([...select.options].map(option=>option.value),['ALL','PENDING','MATURED','SETTLED','VOID','REVOKED','RECOVERY_REQUIRED','EXPIRED','UNKNOWN']);assert.doesNotMatch(p.host.querySelector('.earning-record').textContent,/GMT\+08:00/);}finally{await p.close();}
});
test('a duplicate economic key on a later page clears records and never double counts one revised event',async()=>{
 const a={...earningsOld,record:unifiedRecord(earningsOld,'d')},other={...earningsOld,id:'history:other'};other.record={...unifiedRecord(other,'d')};const summary=unifiedSummary([{state:'SETTLED',count:'2',amountCents:'2468'}]);
 const p=await probeEarnings(async url=>Response.json({...earningsPage('user_A',String(url).includes('cursor=')?[other]:[a]),mappedRecordCount:'2',nextCursor:String(url).includes('cursor=')?null:'signed-next',recordSummary:summary}));
 try{await p.render();assert.equal(p.host.querySelectorAll('.earning-record').length,1);await p.click('加载更多收益');assert.equal(p.host.querySelectorAll('.earning-record').length,0);assert.match(p.host.textContent,/佣金记录已更新/);}finally{await p.close();}
});

test('refresh keeps the same subject, state and valid continuation when the source snapshot is unchanged',async()=>{
 const first={...earningsPage('user_A',[earningsOld]),state:'SETTLED',mappedRecordCount:'3',nextCursor:'first-cursor'},calls=[];
 const second={...earningsNative,state:'SETTLED',recoveryRequiredCents:null},third={...earningsOld,id:'history:third'};
 const p=await probeEarnings(async url=>{const q=new URL(String(url),'http://fixture').searchParams;calls.push({state:q.get('state'),cursor:q.get('cursor')});return Response.json(q.get('cursor')==='first-cursor'?{...first,items:[second],nextCursor:'second-cursor'}:q.get('cursor')==='second-cursor'?{...first,items:[third],nextCursor:null}:first);},'view=invite&earningState=SETTLED');
 try{await p.render();await p.click('加载更多收益');assert.equal(p.host.querySelectorAll('.earning-record').length,2);await p.refresh();assert.equal(p.host.querySelectorAll('.earning-record').length,2);assert.equal(p.params().get('earningState'),'SETTLED');await p.click('加载更多收益');assert.equal(calls.at(-1).cursor,'second-cursor');assert.equal(calls.at(-1).state,'SETTLED');assert.equal(p.host.querySelectorAll('.earning-record').length,3);}finally{await p.close();}
});

/* --- Personal Invitations Behavior Tests --- */
const invitationClient=require(tree+'/apps/web/src/lib/invitation-client.ts');
const compiledInvitations=ts.transpileModule(readFileSync(tree+'/apps/web/src/components/account/personal-invitations.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const compiledSummary=ts.transpileModule(readFileSync(tree+'/apps/web/src/components/account/personal-distribution-summary.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const invitationUnknown=user=>({scope:'LOCAL_CONTROLLED',subjectId:user,policyKnowledge:'UNKNOWN',policyVersion:null,policyEnabled:null,participant:{knowledge:'UNKNOWN',eligibility:'UNKNOWN',levelCode:null,revision:null},ownCode:{knowledge:'UNKNOWN',code:null},inviter:{knowledge:'UNKNOWN',relation:null},leader:{knowledge:'UNKNOWN',relation:null}});
const invitationList=(user,nickname)=>({subjectId:user,knowledge:'KNOWN',count:nickname?'1':'0',countMeaning:'RELATIONS_NOT_UNIQUE_PEOPLE',nextCursor:null,items:nickname?[{id:'relation_'+user,type:'INVITER',nickname,boundAt:'2026-10-04T02:00:00Z',sourceType:'NATIVE_REGISTRATION'}]:[]});
async function probeInvitations(fetcher,includeSummary=false){const w=new Window({url:'http://127.0.0.1:4200/account?view=invite'}),previous=globalThis.fetch;Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,MouseEvent:w.MouseEvent,localStorage:w.localStorage,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});globalThis.fetch=fetcher;const session={status:'authenticated',userId:'user_A',identityVersion:1,revalidations:0,revalidate(){this.revalidations++;}},m=new Module(tree+'/invitation-ui-probe.cjs');m.filename=tree+'/invitation-ui-probe.cjs';m.paths=Module._nodeModulePaths(tree);m.require=name=>{if(name==='next/link')return({scroll:_scroll,...props})=>React.createElement('a',props);if(name==='@/components/session/user-session-provider')return{useUserSession:()=>session,useUserSessionStore:()=>({getSnapshot:()=>session})};if(name==='@/lib/invitation-client')return invitationClient;if(name==='@/lib/personal-wallet-client')return client;if(name==='@/lib/order-client')return require(tree+'/apps/web/src/lib/order-client.ts');if(name==='@/lib/distribution-earnings-client')return require(tree+'/apps/web/src/lib/distribution-earnings-client.ts');if(name==='@/lib/distribution-summary-client')return require(tree+'/apps/web/src/lib/distribution-summary-client.ts');if(name==='./personal-distribution-summary'){const child=new Module(tree+'/summary-ui-probe.cjs');child.filename=tree+'/summary-ui-probe.cjs';child.paths=m.paths;child.require=m.require;child._compile(compiledSummary,child.filename);return child.exports;}if(name==='./personal-earnings')return{PersonalEarnings:props=>React.createElement('div',{'data-earnings-refresh':props.refreshNonce,'data-earnings-scope':props.scope},'收益入口')};if(name==='./personal-wallet')return{WalletSummary:()=>React.createElement('div',null,'钱包入口')};if(name.endsWith('.css'))return{};return require(name);};m._compile(compiledInvitations,m.filename);const host=w.document.createElement('div');w.document.body.append(host);const root=require('react-dom/client').createRoot(host),settle=async()=>{for(let i=0;i<3;i++)await React.act(async()=>{await new Promise(setImmediate);});};return{host,session,settle,async render(){await React.act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(m.exports.PersonalInvitations,{scope:`${session.userId}:${session.identityVersion}`}),includeSummary?React.createElement(m.require('./personal-distribution-summary').PersonalDistributionSummary,{scope:`${session.userId}:${session.identityVersion}`}):null,includeSummary?React.createElement('span',null,'钱包入口'):null)));await settle();},async click(text){const button=[...host.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert(button);await React.act(async()=>button.dispatchEvent(new w.MouseEvent('click',{bubbles:true})));await settle();},async close(){await React.act(async()=>root.unmount());await w.happyDOM.abort();globalThis.fetch=previous;}};}
test('unknown invitation source never becomes a fake zero or an enabled share/bind action',async()=>{const methods=[],p=await probeInvitations(async(url,o)=>{methods.push(o?.method??'GET');return Response.json(String(url).includes('/invitees?')?{subjectId:'user_A',knowledge:'UNKNOWN',count:null,items:[],nextCursor:null}:invitationUnknown('user_A'));});try{await p.render();assert.match(p.host.textContent,/数量待核定/);assert.doesNotMatch(p.host.textContent,/0 条关系/);assert([...p.host.querySelectorAll('.invitation-actions button')].every(b=>b.disabled));assert.equal(p.host.querySelector('#leader-invitation-code'),null);assert(methods.every(m=>m==='GET'));}finally{await p.close();}});
test('enabled policy without parent does not render parent card or binding form',async()=>{
 for(const capability of [false,undefined]){const methods=[],p=await probeInvitations(async(url,o)=>{methods.push(o?.method??'GET');return Response.json(String(url).includes('/invitees?')?invitationList('user_A','CONFIRMED_INVITEE'):{...invitationUnknown('user_A'),policyKnowledge:'KNOWN',policyVersion:'policy',policyEnabled:true,...(capability===undefined?{}:{canBindLeader:capability}),participant:{knowledge:'KNOWN',eligibility:'INELIGIBLE',levelCode:null,revision:'1'},ownCode:{knowledge:'KNOWN',code:'MY_CODE'},leader:{knowledge:'KNOWN_NONE',relation:null}});});
  try{await p.render();assert.equal(p.host.querySelector('form'),null);assert.equal(p.host.querySelector('#leader-invitation-code'),null);assert.equal(p.host.querySelector('.invitation-parent'),null);assert(methods.every(m=>m==='GET'));assert.equal(invitationClient.pendingLeaderBinding('user_A'),null);}finally{await p.close();}
 }
});
test('known parent displays parent status while missing parent hides section',async()=>{
 const leaderRelation = { id: 'leader_1', parentUserId: 'user_leader', sourceType: 'NATIVE_REGISTRATION', boundAt: '2026-10-04T02:00:00Z', boundAtKnowledge: 'KNOWN' };
 const p=await probeInvitations(async url=>Response.json(String(url).includes('/invitees?')?invitationList('user_A',null):{...invitationUnknown('user_A'),policyKnowledge:'KNOWN',policyVersion:'policy',policyEnabled:true,participant:{knowledge:'KNOWN',eligibility:'INELIGIBLE',levelCode:null,revision:'1'},ownCode:{knowledge:'KNOWN',code:'MY_CODE'},inviter:{knowledge:'KNOWN_PARENT',relation:leaderRelation},leader:{knowledge:'KNOWN_PARENT',relation:leaderRelation}}));
 try{await p.render();assert(p.host.querySelector('.invitation-parent'));assert.match(p.host.querySelector('.invitation-parent').textContent,/已绑定/);assert.equal(p.host.querySelector('form'),null);}finally{await p.close();}
});
test('a corrupt original binding marker blocks writes but preserves its bytes and still reads confirmed relations',async()=>{
 const original='{"original-key":"KEEP-BROKEN-ORIGINAL"',methods=[],p=await probeInvitations(async(url,o)=>{methods.push(o?.method??'GET');return Response.json(String(url).includes('/invitees?')?invitationList('user_A','CONFIRMED_WITH_BAD_MARKER'):{...invitationUnknown('user_A'),policyKnowledge:'KNOWN',policyVersion:'policy',policyEnabled:true,participant:{knowledge:'KNOWN',eligibility:'ELIGIBLE',levelCode:'L1',revision:'1'},leader:{knowledge:'KNOWN_NONE',relation:null}});});
 try{localStorage.setItem('zzsh.invitation.binding.pending.v1:user_A',original);await p.render();assert.match(p.host.textContent,/CONFIRMED_WITH_BAD_MARKER/);assert.match(p.host.textContent,/暂时无法确认上次绑定/);assert.equal(p.host.querySelector('.invitation-parent'),null);assert.equal(p.host.querySelector('form'),null);assert.equal(methods.length,3,'overview, invitees and independent self-terms reads');assert(methods.every(method=>method==='GET'));assert.equal(localStorage.getItem('zzsh.invitation.binding.pending.v1:user_A'),original);}finally{await p.close();}
});
test('one definite401 clears both private projections even when the parallel list response succeeded',async()=>{let fail=false;const p=await probeInvitations(async url=>Response.json(String(url).includes('/invitees?')?invitationList('user_A','PRIVATE_NICKNAME_A'):fail?{error:{code:'UNAUTHENTICATED'}}:invitationUnknown('user_A'),{status:fail&&!String(url).includes('/invitees?')?401:200}));try{await p.render();assert.match(p.host.textContent,/PRIVATE_NICKNAME_A/);fail=true;await p.click('刷新邀请与佣金');assert.doesNotMatch(p.host.textContent,/PRIVATE_NICKNAME_A/);assert(p.session.revalidations>=1);}finally{await p.close();}});
test('late old-subject replies cannot replace the new subject relation list',async()=>{let resolveOld,phase='A';const late=new Promise(r=>resolveOld=r),p=await probeInvitations(async url=>phase==='A'?late:Response.json(String(url).includes('/invitees?')?invitationList('user_B','NEW_SUBJECT_NICKNAME'):invitationUnknown('user_B')));try{await p.render();phase='B';p.session.userId='user_B';p.session.identityVersion=2;await p.render();await React.act(async()=>resolveOld(Response.json(invitationList('user_A','PRIVATE_OLD_NICKNAME'))));await p.settle();assert.match(p.host.textContent,/NEW_SUBJECT_NICKNAME/);assert.doesNotMatch(p.host.textContent,/PRIVATE_OLD_NICKNAME/);}finally{resolveOld(Response.json(invitationUnknown('user_A')));await p.close();}});
const partial=(tail=false)=>({subjectId:'user_A',knowledge:'UNKNOWN',type:'ALL',snapshotVersion:'partial-v1',count:null,mappedRelationCount:'2',nextCursor:tail?null:'page-2',items:[{id:tail?'r1':'r2',type:'INVITER',nickname:tail?'SECOND_CONFIRMED':'FIRST_CONFIRMED',boundAt:null,boundAtKnowledge:'UNKNOWN',sourceType:'LEGACY_MYSQL'}]});
test('partial confirmed relations remain visible and can paginate without inventing totals or binding time',async()=>{const p=await probeInvitations(async url=>Response.json(String(url).includes('/invitees?')?partial(String(url).includes('cursor=')):invitationUnknown('user_A')));try{await p.render();assert.match(p.host.textContent,/FIRST_CONFIRMED/);assert.match(p.host.textContent,/已确认 2 条 · 总数待核定/);assert.match(p.host.textContent,/原绑定时间未核定/);await p.click('继续读取关系');assert.match(p.host.textContent,/SECOND_CONFIRMED/);assert.match(p.host.textContent,/FIRST_CONFIRMED/);assert.equal(p.host.querySelectorAll('.invitation-list li').length,2);}finally{await p.close();}});
test('401 and snapshot drift on a partial next page clear private relations',async()=>{for(const failure of ['401','snapshot']){const p=await probeInvitations(async url=>{if(!String(url).includes('/invitees?'))return Response.json(invitationUnknown('user_A'));if(!String(url).includes('cursor='))return Response.json(partial());return failure==='401'?Response.json({error:{code:'UNAUTHENTICATED'}},{status:401}):Response.json({...partial(true),snapshotVersion:'new'});});try{await p.render();await p.click('继续读取关系');assert.doesNotMatch(p.host.textContent,/FIRST_CONFIRMED|SECOND_CONFIRMED/);if(failure==='401')assert.equal(p.session.revalidations,1);else assert.match(p.host.textContent,/关系或政策已变化/);}finally{await p.close();}}});

const termsKnown=(over={})=>({rateMode:'LEVEL',rates:{renterPercent:'3',ownerPercent:'2'},schema:'distribution-terms.self.v2',subjectId:'user_A',scope:'LOCAL_CONTROLLED',knowledge:'KNOWN',applicable:true,reason:null,policyVersion:'pv-2',participantPolicyVersion:'pv-1',level:{code:'L2',rank:2,renterPercent:'3',ownerPercent:'2'},accountModes:['ordinary'],minimumAccrualCents:'100',settlementDelayDays:7,...over});
test('one refresh covers invitation, relations, terms and earnings while a transient failure retains the original relation cursor',async()=>{
 const requests=[];let fail=false;
 const p=await probeInvitations(async url=>{const u=String(url);requests.push(u);if(u.includes('/terms'))return Response.json(termsKnown());if(u.includes('/invitees?'))return fail&&!u.includes('cursor=')?Response.json({error:{code:'UNAVAILABLE'}},{status:503}):Response.json(partial(u.includes('cursor=')));return Response.json(invitationUnknown('user_A'));});
 try{await p.render();assert.equal(p.host.querySelector('.distribution-summary'),null);assert.equal(p.host.querySelectorAll('.personal-invitations .invitation-code').length,1);assert.equal(p.host.querySelector('[data-earnings-refresh]').getAttribute('data-earnings-refresh'),'0');const before=requests.length;fail=true;await p.click('刷新邀请与佣金');assert.equal(p.host.querySelector('[data-earnings-refresh]').getAttribute('data-earnings-refresh'),'1');assert.equal(p.host.querySelector('[data-earnings-scope]').getAttribute('data-earnings-scope'),'user_A:1');assert(requests.slice(before).some(url=>url.includes('/terms')));assert(requests.slice(before).some(url=>url.includes('/invitees?')));assert.match(p.host.textContent,/FIRST_CONFIRMED/);fail=false;await p.click('继续读取关系');assert(requests.at(-1).includes('cursor=page-2'));assert.match(p.host.textContent,/SECOND_CONFIRMED/);}finally{await p.close();}
});
test('GAP-014 self terms show only own level and version, labelled LOCAL_CONTROLLED, without hiding relations',async()=>{const p=await probeInvitations(async url=>Response.json(String(url).includes('/terms')?termsKnown():String(url).includes('/invitees?')?invitationList('user_A','REL_VISIBLE'):invitationUnknown('user_A')));try{await p.render();const card=p.host.querySelector('.invitation-terms');assert(card);assert.match(card.textContent,/等级 L2/);assert.match(card.textContent,/3%/);assert.match(card.textContent,/2%/);assert.match(card.textContent,/7 天/);assert.match(card.textContent,/¥1\.00/);assert.doesNotMatch(card.textContent,/pv-2|pv-1/);assert.equal(invitationClient.distributionTerms(termsKnown(),'user_A').policyVersion,'pv-2');assert.match(card.textContent,/测试规则，不代表正式佣金比例/);assert.doesNotMatch(card.textContent,/L1|升级/);assert.match(p.host.textContent,/REL_VISIBLE/);}finally{await p.close();}});
test('GAP-014 NATIVE terms are labelled as the frozen formal policy, never as local controlled',async()=>{const p=await probeInvitations(async url=>Response.json(String(url).includes('/terms')?termsKnown({scope:'NATIVE'}):String(url).includes('/invitees?')?invitationList('user_A','REL_VISIBLE'):invitationUnknown('user_A')));try{await p.render();const card=p.host.querySelector('.invitation-terms');assert(card);assert.match(card.textContent,/佣金按订单发生时的规则计算/);assert.doesNotMatch(card.textContent,/本地受控政策/);assert.match(card.textContent,/等级 L2/);}finally{await p.close();}});
test('GAP-014 unknown terms never show a default level or zero; terms failure keeps relations',async()=>{const unknownTerms={...termsKnown(),knowledge:'UNKNOWN',applicable:null,reason:'LEVEL_NOT_IN_CURRENT_POLICY',level:null,rateMode:null,rates:null,accountModes:null,minimumAccrualCents:null,settlementDelayDays:null};let mode='unknown';const p=await probeInvitations(async url=>String(url).includes('/terms')?(mode==='unknown'?Response.json(unknownTerms):Response.json({error:{code:'INTERNAL_ERROR'}},{status:503})):Response.json(String(url).includes('/invitees?')?invitationList('user_A','REL_STILL_VISIBLE'):invitationUnknown('user_A')));try{await p.render();let card=p.host.querySelector('.invitation-terms');assert.match(card.textContent,/佣金规则待确认/);assert.match(card.textContent,/当前等级的佣金规则待确认/);assert.doesNotMatch(card.textContent,/0%|¥0|等级 /);mode='fail';await p.close();}finally{}
 const q=await probeInvitations(async url=>String(url).includes('/terms')?Response.json({error:{code:'INTERNAL_ERROR'}},{status:503}):Response.json(String(url).includes('/invitees?')?invitationList('user_A','REL_STILL_VISIBLE'):invitationUnknown('user_A')));try{await q.render();assert.match(q.host.querySelector('.invitation-terms').textContent,/适用条款暂时无法读取/);assert.match(q.host.textContent,/REL_STILL_VISIBLE/);}finally{await q.close();}});
test('GAP-014 malformed or foreign terms payload fails closed in the client',async()=>{const {distributionTerms}=invitationClient;assert.throws(()=>distributionTerms({...termsKnown(),levels:[{code:'L1'}]},'user_A'));assert.throws(()=>distributionTerms(termsKnown(),'user_B'),e=>e.status===401);assert.throws(()=>distributionTerms({...termsKnown(),applicable:true,level:null},'user_A'));assert.throws(()=>distributionTerms({...termsKnown(),knowledge:'UNKNOWN'},'user_A'));assert.equal(distributionTerms(termsKnown(),'user_A').level.code,'L2');});

test('I01 long policy versions retain their complete text and use local wrapping styles', async () => {
 const policyVersion='distribution_policy_'+ 'a'.repeat(40),participantPolicyVersion='distribution_policy_'+ 'b'.repeat(40);
 const p=await probeInvitations(async url=>Response.json(String(url).includes('/terms')?termsKnown({policyVersion,participantPolicyVersion}):String(url).includes('/invitees?')?invitationList('user_A',null):invitationUnknown('user_A')));
 try {
  const style=document.createElement('style');
  style.textContent=readFileSync(tree+'/apps/web/src/components/account/personal-invitations.css','utf8');
  document.head.append(style);
  await p.render();
  const source=p.host.querySelector('.invitation-terms .invitation-source');
  assert(!source.textContent.includes(policyVersion));assert(!source.textContent.includes(participantPolicyVersion));const parsed=invitationClient.distributionTerms(termsKnown({policyVersion,participantPolicyVersion}),'user_A');assert.equal(parsed.policyVersion,policyVersion);assert.equal(parsed.participantPolicyVersion,participantPolicyVersion);
  assert.equal(window.getComputedStyle(source).overflowWrap,'anywhere');
  assert.equal(parseFloat(window.getComputedStyle(p.host.querySelector('.personal-invitations')).minWidth),0);
  assert.notEqual(window.getComputedStyle(source).whiteSpace,'nowrap');
  assert(!['hidden','clip'].includes(window.getComputedStyle(source).overflowX));
 } finally {await p.close();}
});

test('uniform terms render explicit zero and disabled accrual without a fake grade or changing relations',async()=>{
 const methods=[],p=await probeInvitations(async(url,o)=>{methods.push(o?.method??'GET');return Response.json(String(url).includes('/terms')?termsKnown({rateMode:'UNIFORM',rates:{renterPercent:'0',ownerPercent:'2.125'},level:null,applicable:false,reason:'POLICY_DISABLED'}):String(url).includes('/invitees?')?invitationList('user_A','REL_PRESERVED'):invitationUnknown('user_A'));});
 try{await p.render();const text=p.host.querySelector('.invitation-terms').textContent;assert.match(text,/统一分佣比例/);assert.match(text,/0%/);assert.match(text,/2\.125%/);assert.match(text,/佣金计划暂未开放/);assert.match(text,/转入可用余额/);assert.doesNotMatch(text,/等级登记|无适用等级|到账/);assert.match(p.host.textContent,/REL_PRESERVED/);assert(methods.every(m=>m==='GET'));}finally{await p.close();}
});

const summaryProbe=fetcher=>probeInvitations(fetcher,true);
const selfSummary=(userId,amount='100')=>{const metric=(cents,count='1')=>({knowledge:'KNOWN',cents,count,reasonCodes:[]});return{contractVersion:'distribution-self-summary.v1',asOf:'2026-11-02T03:00:00Z',subjectId:userId,native:{settled:metric(amount),pending:metric('0'),recovery:metric('0'),revoked:metric('0'),orders:metric('0','1')},legacy:{settled:metric('0'),pending:metric('0'),expired:metric('0'),coverage:'UNKNOWN'},flow:{accrued:metric('0'),settled:metric('0'),monthSettled:metric('0'),reversed:metric('0'),recovered:metric('0')},network:{inviter:metric('0','1'),leader:metric('0','1')},trend:[],recent:[],reasonCodes:[],unified:{scope:'COMMISSION_RECORDS',knowledge:'KNOWN',count:'1',mappedRecordCount:'1',amountCents:amount,knownSubtotalCents:amount,unknownStateCount:'0',states:[{state:'SETTLED',count:'1',amountCents:amount}],coverage:{knowledge:'KNOWN',cutoff:null,reasonCodes:[]},reasonCodes:[]},recentRecords:[]};};
test('summary 503 is isolated from confirmed relations, wallet and existing earnings',async()=>{
 const p=await summaryProbe(async url=>String(url).endsWith('/summary')?Response.json({error:{code:'EVIDENCE_UNAVAILABLE'}},{status:503}):Response.json(String(url).includes('/invitees?')?invitationList('user_A','RELATION_STILL_VISIBLE'):invitationUnknown('user_A')));
 try{await p.render();assert.match(p.host.querySelector('.distribution-summary').textContent,/佣金记录概况暂时无法读取/);assert.match(p.host.textContent,/RELATION_STILL_VISIBLE/);assert.match(p.host.textContent,/钱包入口/);assert.match(p.host.textContent,/收益入口/);}finally{await p.close();}
});
test('summary late old-subject response never replaces the current own projection',async()=>{
 let release;const p=await summaryProbe(async url=>String(url).endsWith('/summary')?(p.session.userId==='user_A'?new Promise(resolve=>release=()=>resolve(Response.json(selfSummary('user_A','97865')))):Response.json(selfSummary('user_B','200'))):Response.json(String(url).includes('/invitees?')?invitationList(p.session.userId,'CURRENT_RELATION'):invitationUnknown(p.session.userId)));
 try{await p.render();p.session.userId='user_B';p.session.identityVersion++;await p.render();await React.act(async()=>release());await p.settle();const summary=p.host.querySelector('.distribution-summary');assert.match(summary.textContent,/¥2\.00/);assert.doesNotMatch(summary.textContent,/978\.65/);}finally{await p.close();}
});
test('summary uses the unified known subtotal and never sums old source metrics',async()=>{
 const body=selfSummary('user_A','95');body.native.settled={knowledge:'KNOWN',cents:'90000',count:'1',reasonCodes:[]};body.legacy.settled={knowledge:'KNOWN',cents:'80000',count:'1',reasonCodes:[]};body.unified={...body.unified,knowledge:'UNKNOWN',count:null,mappedRecordCount:'2',amountCents:null,knownSubtotalCents:'95',unknownStateCount:'1',states:[{state:'SETTLED',count:'1',amountCents:'95'},{state:'UNKNOWN',count:'1',amountCents:'0'}],coverage:{knowledge:'UNKNOWN',cutoff:null,reasonCodes:['CURRENT_COMMISSION_STATE_NOT_CLOSED']}};
 const p=await summaryProbe(async url=>String(url).endsWith('/summary')?Response.json(body):Response.json(String(url).includes('/invitees?')?invitationList('user_A','VISIBLE'):invitationUnknown('user_A')));
 try{await p.render();const summary=p.host.querySelector('.distribution-summary');assert.match(summary.textContent,/已收录金额小计¥0\.95/);assert.match(summary.textContent,/完整数量待核|暂不能确认完整数量/);assert.match(summary.textContent,/1 条状态待核，不作为当前待入账/);assert.doesNotMatch(summary.textContent,/900\.00|800\.00|本平台当前存量|历史观察/);assert.match(p.host.textContent,/VISIBLE/);}finally{await p.close();}
 const zero=selfSummary('user_A','0');zero.unified={...zero.unified,count:'0',mappedRecordCount:'0',states:[]};const q=await summaryProbe(async url=>String(url).endsWith('/summary')?Response.json(zero):Response.json(String(url).includes('/invitees?')?invitationList('user_A',''):invitationUnknown('user_A')));try{await q.render();assert.match(q.host.querySelector('.distribution-summary').textContent,/记录金额合计¥0\.00/);assert.match(q.host.querySelector('.distribution-summary').textContent,/没有已收录的佣金记录/);}finally{await q.close();}
});
test('a summary-only 401 clears its value and asks the shared identity store to revalidate',async()=>{
 let fail=false;const p=await summaryProbe(async url=>String(url).endsWith('/summary')?(fail?Response.json({error:{code:'UNAUTHENTICATED'}},{status:401}):Response.json(selfSummary('user_A','97865'))):Response.json(String(url).includes('/invitees?')?invitationList('user_A','VISIBLE_RELATION'):invitationUnknown('user_A')));
 try{await p.render();assert.match(p.host.querySelector('.distribution-summary').textContent,/978\.65/);fail=true;const button=p.host.querySelector('.distribution-summary button');await React.act(async()=>button.dispatchEvent(new window.MouseEvent('click',{bubbles:true})));await p.settle();assert.equal(p.session.revalidations,1);assert.doesNotMatch(p.host.querySelector('.distribution-summary').textContent,/978\.65/);assert.match(p.host.querySelector('.distribution-summary').textContent,/登录身份已变化/);}finally{await p.close();}
});
test('unified summary renders 25-digit record aggregates exactly without changing the wallet or old metrics',async()=>{
 const amount='1000000000000000000001233',body=selfSummary('user_A','100');body.unified={...body.unified,count:'2',mappedRecordCount:'2',amountCents:amount,knownSubtotalCents:amount,states:[{state:'SETTLED',count:'2',amountCents:amount}]};
 const p=await summaryProbe(async url=>String(url).endsWith('/summary')?Response.json(body):Response.json(String(url).includes('/invitees?')?invitationList('user_A','REL_VISIBLE'):invitationUnknown('user_A')));
 try{await p.render();assert.match(p.host.querySelector('.distribution-summary-stats').textContent,/¥10,000,000,000,000,000,000,012\.33/);assert.match(p.host.querySelector('.distribution-summary').textContent,/记录金额不等于可用余额/);assert.match(p.host.textContent,/钱包入口/);assert.match(p.host.textContent,/REL_VISIBLE/);}finally{await p.close();}
});
test('missing invitation code and unmapped empty relations stay pending without source-based disabled wording or a false zero',async()=>{
 const relations={subjectId:'user_A',knowledge:'UNKNOWN',count:null,mappedRelationCount:'0',countMeaning:'RELATIONS_NOT_UNIQUE_PEOPLE',snapshotVersion:'mapping-pending',nextCursor:null,items:[],reason:'INVITEE_MAPPING_NOT_CLOSED'};
 const p=await probeInvitations(async url=>Response.json(String(url).includes('/invitees?')?relations:invitationUnknown('user_A')));
 try{await p.render();assert.match(p.host.textContent,/邀请信息尚在核对/);const list=p.host.querySelector('.invitation-list');assert.match(list.textContent,/总数待核定|核对/);assert.doesNotMatch(list.textContent,/当前没有邀请关系|暂无邀请关系|0 条邀请关系/);assert.doesNotMatch(p.host.textContent,/旧用户只读|旧用户不支持|原生.*历史.*二选/);assert.equal(p.host.querySelector('.invitation-code button').disabled,true);}finally{await p.close();}
});
test('a foreign successful summary is an identity error rather than an endless loading state or another user amount',async()=>{
 const p=await summaryProbe(async url=>String(url).endsWith('/summary')?Response.json(selfSummary('another-user','97865')):Response.json(String(url).includes('/invitees?')?invitationList('user_A','REL_OWN'):invitationUnknown('user_A')));
 try{await p.render();const summary=p.host.querySelector('.distribution-summary');assert.match(summary.textContent,/登录身份已变化/);assert.doesNotMatch(summary.textContent,/978\.65|正在读取/);assert.equal(p.session.revalidations,1);assert.match(p.host.textContent,/REL_OWN/);}finally{await p.close();}
});

/* --- Bank Binding & Withdrawal Workspace Behavior Tests --- */
const { WithdrawalRequestError } = require(tree + '/apps/web/src/lib/withdrawal-client-core.ts');
const { validateBankBindingInput } = require(tree + '/apps/web/src/lib/withdrawal-bank-binding-client.ts');
const bankWorkspaceFile = tree + '/apps/web/src/components/account/bank-binding-workspace.tsx';
const bankWorkspaceSource = readFileSync(bankWorkspaceFile, 'utf8');

const bankAt = '2026-10-25T00:00:00.000Z';
const demoLimits = {minCents:'200',maxCents:'1000000'};
const bank = (revision = '1', tail = '0015') => ({ contractVersion: 'withdrawal-bank-binding.v1', integration: 'INTEGRATED', expectedRevision: revision, binding: { id: 'bank-1', revision, cardMask: '**** **** ' + tail, holderNameMask: '测**', updatedAt: bankAt, ownershipVerification: 'NOT_VERIFIED' } });
const emptyBank = { contractVersion: 'withdrawal-bank-binding.v1', integration: 'INTEGRATED', expectedRevision: '0', binding: null };
const unavailableBank = { contractVersion: 'withdrawal-bank-binding.v1', integration: 'NOT_INTEGRATED', expectedRevision: null, binding: null };
const options = (binding = bank(), allowed = true, extra = {}) => ({ contractVersion: 'withdrawal-request-context.v1', bankBinding: binding, canQuote: allowed, policy: { version: 'policy-1', minCents: '100', maxCents: '100000', fee: { kind: 'FIXED', cents: '100' }, maxIntents: 3, quotaStart: bankAt, quotaEnd: '2026-10-26T00:00:00.000Z' }, reasonCodes: allowed ? [] : ['BANK_BINDING_REQUIRED'], bankOwnershipVerification: 'NOT_VERIFIED', bankArrival: 'UNKNOWN', ...extra });
const quote = { contractVersion: 'native-withdrawal.v1', source: 'JOINPAY', grossCents: '10000', netCents: '9900', feeCents: '100', policyVersion: 'policy-1', destination: { id: 'bank-1', revision: '1', mask: '**** **** 0015' }, expectedWalletVersion: 'jwdq1:' + 'a'.repeat(64), ledgerRevision: '1', globalWithdrawable: 'UNKNOWN' };
const intent = { contractVersion: 'native-withdrawal.v1', source: 'JOINPAY', userId: 'user_A', id: 'intent-1', amountCents: '10000', netCents: '9900', feeCents: '100', currency: 'CNY', state: 'RESERVED', operationVersion: '1', fundsDisposition: 'RESERVED', requiresReview: false, merchantOrderNo: 'OFFLINE-ORDER-1', policyVersion: 'policy-1', destinationId: 'bank-1', acceptedAt: bankAt, bankArrival: 'UNKNOWN', globalWithdrawable: 'UNKNOWN', originalDestination: { id: 'bank-1', revision: '1', cardMask: '**** **** 0015', basis: 'ORIGINAL_INTENT', bankOwnershipVerification: 'UNKNOWN' } };
const bankHistoryItem = (id = 'history:h1') => ({ id, source: 'HISTORICAL_WITHDRAWAL', sourceStatus: 2, amountCents: '10000', netCents: '9900', feeCents: '100', occurredAt: bankAt });
const localItem = { id: 'local-1', state: 'RESERVED', amountCents: '5000', netCents: '4900', feeCents: '100', acceptedAt: bankAt };
const nativeItem = { ...intent, id: 'joinpay:intent-1', occurredAt: bankAt, sourceReference: { type: 'NATIVE', system: 'zzsh', entity: 'joinpay_withdrawal_intent', id: 'intent-1' }, intentId: 'intent-1', evidenceLevel: 'LOCAL_RECORDS_NOT_REVALIDATED', platformSerialNo: null, mayResubmit: false, reasonCodes: [] };
const nativeHistoryPage = () => Array.from({ length: 20 }, (_, i) => {
  const intentId = `intent-${String(20 - i).padStart(2, '0')}`;
  return { ...nativeItem, id: `joinpay:${intentId}`, intentId, occurredAt: '2026-10-24T00:00:00.000Z' };
});
function history(sourceName, { items = [], cursor = null, snapshot = 'snap-1', availability = 'AVAILABLE' } = {}) {
  const notRequested = { availability: 'NOT_REQUESTED', reasonCodes: [], data: null };
  const data = sourceName === 'HISTORICAL' ? { items, coverage: { knowledge: 'KNOWN' }, asOf: bankAt, snapshotVersion: snapshot, nextCursor: cursor }
    : sourceName === 'LOCAL_CONTROLLED' ? { items, pagination: { asOf: bankAt, snapshotVersion: snapshot, nextCursor: cursor } }
      : { items, count: String(items.length), asOf: bankAt, snapshotVersion: snapshot, nextCursor: cursor, scope: 'LOCAL_NATIVE_INTENTS_ONLY' };
  const key = { HISTORICAL: 'historical', LOCAL_CONTROLLED: 'controlled', JOINPAY: 'joinpay' }[sourceName];
  return { contractVersion: 'personal-withdrawals.read.v2', subjectId: 'user_A', source: sourceName, state: 'ALL', sections: { historical: notRequested, controlled: notRequested, joinpay: notRequested, [key]: { availability, reasonCodes: availability === 'AVAILABLE' ? [] : ['NOT_INSTALLED'], data: availability === 'AVAILABLE' ? data : null } } };
}


async function probeBankWorkspace(overrides = {}) {
  const window = new Window({ url: 'http://127.0.0.1:4220/account?view=wallet&wallet=withdraw' });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  const session = { status: 'authenticated', userId: 'user_A', identityVersion: 1, revalidate() {} }, store = { getSnapshot: () => session };
  const calls = [], changes = [], commits = [];
  let pendingBank = overrides.pendingBank ?? null, pendingNative = overrides.pendingNative ?? null, pendingDemo = overrides.pendingDemo ?? null;
  const bankApi = {
    validateBankBindingInput, readBankBinding: async () => bank(), pendingBankBinding: () => pendingBank,
    saveBankBinding: async (userId, body, opts) => { calls.push({ method: 'saveBank', userId, body, opts }); pendingBank = null; return bank('2', body.cardNo.slice(-4)); },
    recoverBankBinding: async () => ({ knowledge: 'UNKNOWN', receipt: null, current: null }), ...overrides.bank,
  };
  const channelApi = {
    readChannelWithdrawalOptions: async () => options(), pendingChannelWithdrawal: () => pendingNative,
    quoteChannelWithdrawal: async (userId, input) => { calls.push({ method: 'quote', userId, input }); return quote; },
    submitChannelWithdrawal: async (userId, value, opts) => { calls.push({ method: 'submit', userId, value, opts }); pendingNative = null; return intent; },
    recoverChannelWithdrawal: async () => ({ knowledge: 'UNKNOWN', receipt: null, current: null }), readChannelWithdrawal: async () => intent, ...overrides.channel,
  };
  const demoApi = {
    pendingDemoWithdrawal: () => pendingDemo,
    readDemoAvailability: async () => { throw new WithdrawalRequestError(404, 'NOT_FOUND'); },
    createDemoTarget: async () => { throw Error('unexpected demo target'); }, quoteDemoWithdrawal: async () => { throw Error('unexpected demo quote'); },
    confirmDemoWithdrawal: async () => { throw Error('unexpected demo confirm'); }, recoverDemoWithdrawal: async () => ({knowledge:'UNKNOWN',pending:pendingDemo,intent:null}),
    discardDemoTarget: async () => { pendingDemo=null; }, readDemoIntent: async () => { throw Error('unexpected demo read'); }, ...overrides.demo,
  };
  const historyApi = {
    readWithdrawalHistory: async (userId, query) => { calls.push({ method: 'history', userId, query }); return history(query.source); },
    readWithdrawalHistoryItem: async () => ({ contractVersion: 'personal-withdrawals.read.v2', subjectId: 'user_A', source: 'JOINPAY', availability: 'AVAILABLE', reasonCodes: [], data: { item: nativeItem, scope: 'LOCAL_NATIVE_INTENTS_ONLY' } }), recoverWithdrawalFromHistory: async () => ({ contractVersion: 'personal-withdrawals.read.v2', subjectId:'user_A', source:'JOINPAY', knowledge:'UNKNOWN',item:null,mayResubmit:false,receiptMeaning:'CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK' }), ...overrides.history,
  };
  // Control adapters isolate business UI behavior; real library visuals require browser verification.
  const Button = ({ children, onPress, isDisabled, variant: _variant, ...props }) => React.createElement('button', { ...props, disabled: isDisabled, onClick: onPress, type: props.type ?? 'button' }, children);
  const Input = props => React.createElement('input', props);
  const ConfirmAlertDialog = props => props.open ? React.createElement('div', { role: 'alertdialog' }, React.createElement('h2', null, props.title), props.description, props.consequences,
    React.createElement('button', { disabled: props.busy, onClick: () => props.onOpenChange(false) }, props.cancelLabel), React.createElement('button', { disabled: props.busy || props.confirmDisabled, onClick: props.onConfirm }, props.confirmLabel)) : null;
  const module = new Module(bankWorkspaceFile); module.filename = bankWorkspaceFile; module.paths = Module._nodeModulePaths(tree);
  module.require = name => {
    if (name === '@heroui/react') return { Button };
    if (name === '@/components/ui/form-controls') return { Input };
    if (name === '@/components/ui/information') return information;
    if (name === '@/components/ui/alert-dialog') return { ConfirmAlertDialog };
    if (name === '@/components/session/user-session-provider') return { useUserSession: () => session, useUserSessionStore: () => store };
    if (name === '@/lib/withdrawal-bank-binding-client') return bankApi;
    if (name === '@/lib/channel-withdrawal-client') return channelApi;
    if (name === '@/lib/demo-withdrawal-client') return demoApi;
    if (name === '@/lib/withdrawal-history-client') return historyApi;
    if (name === 'next/link') return ({ children, ...props }) => React.createElement('a', props, children);
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/')) return require(tree + '/apps/web/src/' + name.slice(2) + '.ts');
    return require(name);
  };
  module._compile(ts.transpileModule(bankWorkspaceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, bankWorkspaceFile);
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = require('react-dom/client').createRoot(host);
  const settle = async () => { for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise(setImmediate); }); };
  function Track() { const scope = `${session.userId}:${session.identityVersion}`; React.useLayoutEffect(() => { commits.push({ scope, text: host.textContent }); }); return React.createElement(module.exports.BankBindingWorkspace, { scope, availableBalance: overrides.availableBalance, ledgerRevision: overrides.ledgerRevision, onWalletChanged: () => changes.push('wallet') }); }
  const render = async () => { await React.act(async () => root.render(React.createElement(Track))); await settle(); };
  const click = async (text, within = host) => { const b = [...within.querySelectorAll('button')].find(x => x.textContent.includes(text)); assert(b, `missing button ${text}`); assert.equal(b.disabled, false, `button ${text} disabled`); await React.act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise(setImmediate); }); await settle(); };
  const fill = async (selector, value) => { const input = host.querySelector(selector); assert(input, selector); await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); await settle(); };
  const submit = async selector => { const form = host.querySelector(selector); assert(form); await React.act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await new Promise(setImmediate); }); await settle(); };
  return { host, session, bankApi, channelApi, demoApi, historyApi, calls, changes, commits, render, settle, click, fill, submit, setPendingBank: x => { pendingBank = x; }, setPendingNative: x => { pendingNative = x; }, setPendingDemo: x => { pendingDemo = x; }, async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); } };
}

test('workspace composes installed controls and never persists raw inputs itself', () => {
  assert.ok(!/<(?:input|select|button|dialog)\b/.test(bankWorkspaceSource));
  assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(bankWorkspaceSource));
});

test('demo withdrawal keeps test wording and confirms the server quote without claiming bank payout', async()=>{
 const scope='LOCAL_DEMO_SIMULATED',target={id:'target-1',kind:'BANK_CARD',mask:'**** **** 0015',amountCents:'10000',currency:'CNY',expiresAt:'2026-11-08T08:00:00.000Z',policyVersion:'policy-1'};
 const body={amountCents:'10000',destinationId:'target-1',policyVersion:'policy-1',expectedWalletVersion:'7'};
 const demoQuote={destinationId:'target-1',policyVersion:'policy-1',ledgerRevision:'7',acceptedAt:bankAt,currency:'CNY',grossCents:'10000',netCents:'9900',feeCents:'100',requestKey:'demo-key'};
 const result={id:'intent-demo',state:'SUCCEEDED',fundsDisposition:'PAYOUT_POSTED',amountCents:'10000',netCents:'9900',feeCents:'100',acceptedAt:bankAt};
 const p=await probeBankWorkspace({availableBalance:'15000',ledgerRevision:'7',demo:{readDemoAvailability:async()=>({scope,withdrawalEnabled:true,limits:demoLimits,observedAt:at})}});
 p.demoApi.createDemoTarget=async(userId,receivedScope,input)=>{assert.equal(receivedScope,scope);const ready={version:1,userId,scope,stage:'target-ready',key:'target-key',body:input,target};p.setPendingDemo(ready);p.calls.push({method:'demo-target'});return ready;};
 p.demoApi.quoteDemoWithdrawal=async(userId,receivedScope,receivedTarget,walletVersion)=>{assert.equal(receivedScope,scope);assert.equal(receivedTarget.id,target.id);assert.equal(walletVersion,'7');return{body,quote:demoQuote};};
 p.demoApi.confirmDemoWithdrawal=async(userId,receivedScope,receivedBody,receivedQuote)=>{assert.equal(receivedScope,scope);assert.deepEqual(receivedBody,body);assert.equal(receivedQuote.requestKey,'demo-key');p.calls.push({method:'demo-confirm'});p.setPendingDemo(null);return result;};
 try {await p.render();assert.match(p.host.textContent,/银行卡提现/);assert.match(p.host.textContent,/不会向银行卡打款/);await p.fill('.bank-withdraw-form input','100');await p.submit('.bank-withdraw-form');
  assert.match(p.host.textContent,/提现净额/);await p.submit('.bank-withdraw-form');p.setPendingBank({userId:'user_A',key:'bank-original',expectedRevision:'1'});
  await p.click('确认提交申请',p.host.querySelector('[role="alertdialog"]'));assert.match(p.host.textContent,/请先确认收款资料的保存结果/);assert.equal(p.calls.filter(x=>x.method==='demo-confirm').length,0);
  p.setPendingBank(null);await p.submit('.bank-withdraw-form');await p.click('确认提交申请',p.host.querySelector('[role="alertdialog"]'));
  assert.equal(p.calls.filter(x=>x.method==='demo-target').length,1);assert.equal(p.calls.filter(x=>x.method==='demo-confirm').length,1);assert.equal(p.changes.length,1);
  assert.match(p.host.textContent,/处理完成/);assert.match(p.host.textContent,/不会向银行卡打款/);
 }finally{await p.close();}
});

test('an unknown demo write blocks a second request and queries the original result',async()=>{
 const scope='LOCAL_DEMO_SIMULATED',pending={version:1,userId:'user_A',scope,stage:'target',key:'original-target',body:{bankBindingId:'bank-1',bankBindingRevision:'1',amountCents:'10000'}};
 const p=await probeBankWorkspace({availableBalance:'15000',ledgerRevision:'7',pendingDemo:pending,demo:{readDemoAvailability:async()=>({scope,withdrawalEnabled:true,limits:demoLimits,observedAt:at})}});
 p.demoApi.recoverDemoWithdrawal=async(userId,receivedScope)=>{assert.equal(userId,'user_A');assert.equal(receivedScope,scope);p.calls.push({method:'demo-recover'});return{knowledge:'UNKNOWN',pending,intent:null};};
 try{await p.render();assert.match(p.host.textContent,/上次提现结果待确认/);await p.click('查询原申请');assert.match(p.host.textContent,/原申请仍未确认/);assert.equal(p.calls.filter(x=>x.method==='demo-recover').length,1);assert.equal(p.calls.filter(x=>x.method==='demo-target').length,0);}
 finally{await p.close();}
});

test('demo withdrawal refuses a newly pending bank save before declaring a target',async()=>{
 const scope='LOCAL_DEMO_SIMULATED',p=await probeBankWorkspace({availableBalance:'15000',ledgerRevision:'7',demo:{readDemoAvailability:async()=>({scope,withdrawalEnabled:true,limits:demoLimits,observedAt:at})}});
 try {await p.render();await p.fill('.bank-withdraw-form input','100');p.setPendingBank({userId:'user_A',key:'bank-original',expectedRevision:'1'});
  await p.submit('.bank-withdraw-form');assert.match(p.host.textContent,/请先确认收款资料的保存结果/);assert.equal(p.calls.filter(x=>x.method==='demo-target').length,0);
 }finally{await p.close();}
});

test('demo withdrawal explains only the identity reason returned by the server',async()=>{
 for(const [code,expected] of [['DEMO_WITHDRAW_IDENTITY_REQUIRED',/请先完成本人实名认证/],['DEMO_WITHDRAW_ADULT_REQUIRED',/确认已成年后/],['DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED',/实名信息来源暂时无法确认/]]){
  const scope='LOCAL_DEMO_SIMULATED',p=await probeBankWorkspace({availableBalance:'15000',ledgerRevision:'7',demo:{readDemoAvailability:async()=>({scope,withdrawalEnabled:true,limits:demoLimits,observedAt:at}),createDemoTarget:async()=>{throw new WithdrawalRequestError(403,code);}}});
  try{await p.render();await p.fill('.bank-withdraw-form input','100');await p.submit('.bank-withdraw-form');assert.match(p.host.textContent,expected);assert.doesNotMatch(p.host.textContent,/实名认证已过期/);}finally{await p.close();}
 }
});

test('demo amount limits are shown and invalid amounts never create a target',async()=>{
 const scope='LOCAL_DEMO_SIMULATED',p=await probeBankWorkspace({availableBalance:'1500000',ledgerRevision:'7',demo:{readDemoAvailability:async()=>({scope,withdrawalEnabled:true,limits:demoLimits,observedAt:at})}});
 try{
  await p.render();assert.match(p.host.textContent,/单笔范围.*2\.00.*10,000\.00/);
  await p.fill('.bank-withdraw-form input','1');await p.submit('.bank-withdraw-form');
  assert.match(p.host.textContent,/提现金额需在/);assert.equal(p.calls.filter(x=>x.method==='demo-target').length,0);
  await p.click('本次最多');assert.equal(p.host.querySelector('.bank-withdraw-form input').value,'10000.00');
 }finally{await p.close();}
});

test('withdrawal shows only the confirmed wallet balance and keeps a missing balance unknown', async () => {
  for (const [amount, expected] of [['123456', /¥1,234\.56/], [null, /未记录/]]) {
    const p=await probeBankWorkspace({availableBalance:amount});
    try { await p.render(); assert.match(p.host.querySelector('.bank-available').textContent, expected); assert.equal(p.calls.filter(call=>call.method==='submit').length,0); } finally { await p.close(); }
  }
});

test('not-integrated binding is not displayed as no bank and cannot create a quote', async () => {
  const p = await probeBankWorkspace({ bank: { readBankBinding: async () => unavailableBank }, channel: { readChannelWithdrawalOptions: async () => options(unavailableBank, false) } });
  try { await p.render(); assert.match(p.host.textContent, /暂时无法查看收款资料/); assert.doesNotMatch(p.host.textContent, /尚未绑定收款银行卡/); assert.equal([...p.host.querySelectorAll('button')].some(x => x.textContent === '绑定银行卡'), false); await p.fill('.bank-withdraw-form input', '100'); assert.equal(p.host.querySelector('.bank-withdraw-form button').disabled, true); assert.equal(p.calls.filter(x => x.method === 'quote').length, 0); } finally { await p.close(); }
});

test('unavailable bank information stays unknown in the withdrawal steps', async () => {
  const p=await probeBankWorkspace({bank:{readBankBinding:async()=>unavailableBank},channel:{readChannelWithdrawalOptions:async()=>options(unavailableBank,false)}});
  try { await p.render(); const steps=p.host.querySelector('[aria-label="提现指引流程"]'); assert.match(steps.textContent,/收款资料未记录/);assert.doesNotMatch(p.host.textContent,/自动解锁|极速审核到账|尚未绑定收款银行卡/); } finally { await p.close(); }
});

test('filling a large balance preserves every cent without promising withdrawal eligibility', async () => {
  const p=await probeBankWorkspace({availableBalance:'9007199254740993'});
  try { await p.render(); await p.click('全部提现'); assert.equal(p.host.querySelector('.bank-withdraw-form input').value,'90071992547409.93'); assert.doesNotMatch(p.host.textContent,/随时将账户余额提现到账/); assert.equal(p.calls.filter(call=>call.method==='quote').length,0); } finally { await p.close(); }
});

test('editing never prefills previous name/card and saved data is not bank verification', async () => {
  const p = await probeBankWorkspace();
  try { await p.render(); await p.click('修改收款资料'); assert.equal(p.host.querySelector('[name="bank-holder-name"]').value, ''); assert.equal(p.host.querySelector('[name="bank-card-number"]').value, ''); assert.match(p.host.textContent, /银行卡归属尚未核验/); assert.doesNotMatch(p.host.querySelector('.bank-saved .info-status-badge').textContent, /验证/); } finally { await p.close(); }
});

test('binding UNKNOWN re-enters original data without allocating a replacement request', async () => {
  const marker = { userId: 'user_A', key: 'old-binding-key', expectedRevision: '0' };
  const p = await probeBankWorkspace({ pendingBank: marker, bank: { readBankBinding: async () => emptyBank } });
  try { await p.render(); assert.match(p.host.textContent, /上次保存结果未记录/); await p.click('重新输入原资料'); assert.equal(p.host.querySelector('[name="bank-card-number"]').value, ''); await p.fill('[name="bank-holder-name"]', '离线测试甲'); await p.fill('[name="bank-card-number"]', '0000000000000015'); await p.submit('.bank-binding-form'); const call = p.calls.find(x => x.method === 'saveBank'); assert.equal(call.opts.resume, true); assert.deepEqual(call.opts.expectedPending,marker); assert.notEqual(call.opts.expectedPending,marker); assert.equal(call.body.expectedRevision, '0'); assert.equal(call.body.cardNo, '0000000000000015'); assert.equal(p.host.querySelector('.bank-binding-form'), null); } finally { await p.close(); }
});

test('known bank save with failed current read never substitutes its old ACK', async () => {
  const p = await probeBankWorkspace({ pendingBank: { userId: 'user_A', key: 'k', expectedRevision: '0' }, bank: { recoverBankBinding: async () => { p.setPendingBank(null); return { knowledge: 'KNOWN', receipt: bank('1','1234'), current: null }; } } });
  try { await p.render(); await p.click('查询保存结果'); const panel = p.host.querySelector('.bank-binding-panel'); assert.match(panel.textContent, /上次保存已确认，请刷新查看当前收款资料/); assert.doesNotMatch(panel.textContent, /1234/); assert.equal(panel.querySelector('.bank-saved'), null); } finally { await p.close(); }
});

test('server quote values require explicit confirmation before withdrawal submission', async () => {
  const p = await probeBankWorkspace();
  try { await p.render(); await p.fill('.bank-withdraw-form input', '100'); await p.submit('.bank-withdraw-form'); assert.deepEqual(p.calls.find(x => x.method === 'quote').input, { amountCents: '10000', destinationId: 'bank-1', policyVersion: 'policy-1' }); assert.match(p.host.querySelector('.bank-quote').textContent, /¥99\.00/); assert.match(p.host.querySelector('.bank-quote').textContent, /手续费由你承担。确认前不会扣款，到账情况以收款记录为准/); assert.equal(p.calls.filter(x => x.method === 'submit').length, 0); await p.click('确认提现申请'); assert.ok(p.host.querySelector('[role="alertdialog"]')); assert.equal(p.calls.filter(x => x.method === 'submit').length, 0); await p.click('确认提交申请'); assert.equal(p.calls.filter(x => x.method === 'submit').length, 1); assert.match(p.host.querySelector('[aria-label="原提现申请记录"]').textContent, /未记录/); } finally { await p.close(); }
});

test('identity and quota show only server facts; missing or unknown values stay unknown', async () => {
  const identity = { identityStatus: 'VERIFIED', ageStatus: 'ADULT', verifiedAt: bankAt };
  const quota = { used: '1', maxIntents: 3, remaining: 2, windowStart: bankAt, windowEnd: '2026-10-26T00:00:00.000Z' };
  const known = await probeBankWorkspace({ channel: { readChannelWithdrawalOptions: async () => options(bank(), true, { identity, quota }) } });
  try {
    await known.render();
    const box = known.host.querySelector('[aria-label="提现资格与次数"]');
    const values = [...box.querySelectorAll('dd')].map(node => node.textContent);
    assert.ok(values.includes('已实名')); assert.ok(values.includes('已成年')); assert.ok(values.includes('1 / 3 笔')); assert.ok(values.includes('2 笔'));
    assert.equal(values.filter(value => value.includes('至')).length, 1, 'the server window is displayed once');
  } finally { await known.close(); }
  for (const extra of [{ identity: null, quota: null }, { identity: { identityStatus: 'VERIFIED_NEXT', ageStatus: 'ADULT_NEXT', verifiedAt: null }, quota: null }]) {
    const p = await probeBankWorkspace({ channel: { readChannelWithdrawalOptions: async () => options(bank(), true, extra) } });
    try {
      await p.render();
      const box = p.host.querySelector('[aria-label="提现资格与次数"]');
      const values = [...box.querySelectorAll('dd')].map(node => node.textContent);
      assert.ok(values.includes('实名状态未记录')); assert.ok(values.includes('年龄状态未记录'));
      assert.equal(values.includes('已实名') || values.includes('已成年'), false);
      assert.match(box.textContent, /提现次数未记录/);
      assert.doesNotMatch(box.textContent, /剩余 0 笔/);
    } finally { await p.close(); }
  }
});

test('invalid or zero amount is explained without issuing a quote', async () => {
  const p = await probeBankWorkspace();
  try { await p.render(); for (const input of ['0','1.234','bad']) { await p.fill('.bank-withdraw-form input', input); await p.submit('.bank-withdraw-form'); assert.match(p.host.textContent, /大于0、最多两位小数/); } assert.equal(p.calls.filter(x => x.method === 'quote').length, 0); } finally { await p.close(); }
});

test('unknown withdrawal recovery stays available when new options fail; ACK is not current state', async () => {
  const pending = { userId: 'user_A', key: 'old-native-key', body: { amountCents: '10000', destinationId: 'bank-1', policyVersion: 'policy-1', expectedWalletVersion: quote.expectedWalletVersion } };
  const p = await probeBankWorkspace({ pendingNative: pending, channel: { readChannelWithdrawalOptions: async () => { throw new WithdrawalRequestError(503,'NOT_INTEGRATED'); }, recoverChannelWithdrawal: async () => { p.setPendingNative(null); return { knowledge: 'KNOWN', receipt: { ...intent, state: 'SUCCEEDED', originalDestination: { ...intent.originalDestination, cardMask: '**** **** 1234' } }, current: null }; } } });
  try { await p.render(); await p.click('查询提现进度'); assert.match(p.host.textContent, /申请已确认，请刷新查看最新进度/); assert.equal(p.host.querySelector('[aria-label="原提现申请记录"]'), null); assert.doesNotMatch(p.host.textContent, /1234/); assert.equal(p.calls.filter(x => x.method === 'submit').length, 0); } finally { await p.close(); }
});

test('the unified timeline follows source cursors and marks unavailable history as partial', async () => {
  const seen = [];
  const p = await probeBankWorkspace({ history: { readWithdrawalHistory: async (_user, query) => { seen.push(query); return query.source === 'HISTORICAL' ? history(query.source,{items:[bankHistoryItem(query.cursor?'history:h1':'history:h2')],cursor:query.cursor?null:'history-next',snapshot:'h'}) : query.source === 'LOCAL_CONTROLLED' ? history(query.source,{items:[localItem],snapshot:'c'}) : history(query.source,{availability:'NOT_INTEGRATED'}); } } });
  try { await p.render(); const section = p.host.querySelector('[aria-label="提现记录"]'); assert.match(section.textContent, /当前列表可能不完整/); assert(seen.some(query => query.source === 'HISTORICAL' && query.cursor === 'history-next')); assert.equal(section.querySelectorAll('.bank-history-row').length,3); assert.match(section.textContent,/处理中/); assert.match(section.textContent,/测试记录，未实际打款/); } finally { await p.close(); }
});

test('historical original destination never falls back to the current bank', async () => {
  const old = { ...nativeItem, originalDestination: null };
  const p = await probeBankWorkspace({ history: { readWithdrawalHistory: async (_user, query) => history(query.source,{items:query.source==='JOINPAY'?[old]:[]}), readWithdrawalHistoryItem: async()=>({contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{item:old,scope:'LOCAL_NATIVE_INTENTS_ONLY'}}) } });
  try { await p.render(); const section = p.host.querySelector('[aria-label="提现记录"]'); await p.click('详情',section); assert.match(section.textContent,/原收款目标未提供/); assert.doesNotMatch(section.textContent,/0015/); assert.match(section.textContent,/未记录/); } finally { await p.close(); }
});

test('historical detail shows the original number and source amounts without claiming bank arrival', async () => {
  const old = { ...bankHistoryItem(), originalNumber: '旧提现_2026-001', amountCents: '10000', netCents: '9500', feeCents: '100' };
  const p = await probeBankWorkspace({ history: { readWithdrawalHistory: async (_user, query) => history(query.source,{items:query.source==='HISTORICAL'?[old]:[]}), readWithdrawalHistoryItem: async()=>({contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'HISTORICAL_WITHDRAWAL',item:old}) } });
  try { await p.render(); const section=p.host.querySelector('[aria-label="提现记录"]'); await p.click('详情',section); assert.match(section.textContent,/旧提现_2026-001/); assert.match(section.textContent,/金额按原记录展示/); assert.match(section.textContent,/未记录/); assert.doesNotMatch(section.textContent,/按申请金额减手续费/); } finally { await p.close(); }
});

test('identity changes hide previous bank data and diagnostics before effect cleanup', async () => {
  const gate = deferred(); let second = false;
  const p = await probeBankWorkspace({ bank:{ readBankBinding:async()=>second?gate.promise:bank('1','1111') }, channel:{ readChannelWithdrawalOptions:async()=>second?gate.promise:options(),quoteChannelWithdrawal:async()=>{throw new WithdrawalRequestError(503,'TEST_FAILURE','PRIVATE_A_TRACE');} },history:{readWithdrawalHistory:async(_user,query)=>second?gate.promise:history(query.source)} });
  try { await p.render(); await p.fill('.bank-withdraw-form input','100'); await p.submit('.bank-withdraw-form'); assert.match(p.host.textContent,/PRIVATE_A_TRACE/); const mark=p.commits.length; second=true; p.session.userId='user_B';p.session.identityVersion=2;await p.render();const first=p.commits.slice(mark).find(x=>x.scope==='user_B:2');assert(first);assert.doesNotMatch(first.text,/1111|PRIVATE_A_TRACE/); } finally { await p.close(); }
});

test('editing bank invalidates a late quote without leaving the new quote action permanently busy', async () => {
  const gate=deferred();let current=bank();let quoted=0;
  const p=await probeBankWorkspace({bank:{readBankBinding:async()=>current,saveBankBinding:async()=>{current=bank('2','0023');return current;}},channel:{readChannelWithdrawalOptions:async()=>options(current),quoteChannelWithdrawal:async()=>{quoted++;return quoted===1?gate.promise:{...quote,destination:{...quote.destination,revision:'2',mask:'**** **** 0023'}};}}});
  try{await p.render();await p.fill('.bank-withdraw-form input','100');await p.submit('.bank-withdraw-form');await p.click('修改收款资料');await p.fill('[name="bank-holder-name"]','离线测试甲');await p.fill('[name="bank-card-number"]','0000000000000023');await p.submit('.bank-binding-form');gate.resolve(quote);await p.settle();assert.equal(p.host.querySelector('.bank-quote'),null);assert.equal(p.host.querySelector('.bank-withdraw-form button').disabled,false);await p.submit('.bank-withdraw-form');assert.match(p.host.querySelector('.bank-quote').textContent,/0023/);}finally{gate.resolve(quote);await p.close();}
});

test('history-key recovery can show local records without clearing the original ACK recovery slot', async () => {
  const pending={userId:'user_A',key:'native-old-key',body:{amountCents:'10000',destinationId:'bank-1',policyVersion:'policy-1',expectedWalletVersion:quote.expectedWalletVersion}};const seen=[];
  const p=await probeBankWorkspace({pendingNative:pending,channel:{readChannelWithdrawalOptions:async()=>{throw new WithdrawalRequestError(503,'NOT_INTEGRATED');}},history:{recoverWithdrawalFromHistory:async(userId,key)=>{seen.push({userId,key});return {contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',knowledge:'KNOWN',item:nativeItem,mayResubmit:false,receiptMeaning:'CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK'};}}});
  try{await p.render();await p.click('查看申请记录');assert.deepEqual(seen,[{userId:'user_A',key:'native-old-key'}]);assert.match(p.host.querySelector('[aria-label="申请记录"]').textContent,/上次提交结果仍未记录/);assert.equal(p.channelApi.pendingChannelWithdrawal().key,'native-old-key');assert.equal(p.host.querySelector('.bank-withdraw-form button').disabled,true);assert.equal(p.calls.filter(x=>x.method==='submit').length,0);}finally{await p.close();}
});

test('saved binding with failed latest read clears raw draft and requests a refresh instead of another save', async()=>{
  const p=await probeBankWorkspace({bank:{saveBankBinding:async()=>{throw new WithdrawalRequestError(503,'BANK_BINDING_CURRENT_READ_UNAVAILABLE');}}});
  try{await p.render();await p.click('修改收款资料');await p.fill('[name="bank-holder-name"]','离线测试甲');await p.fill('[name="bank-card-number"]','0000000000000015');await p.submit('.bank-binding-form');assert.equal(p.host.querySelector('.bank-binding-form'),null);assert.match(p.host.querySelector('.bank-binding-panel').textContent,/上次保存已确认，请刷新查看当前收款资料/);assert.equal(p.host.querySelector('.bank-saved'),null);}finally{await p.close();}
});

test('revoking one history source clears its open private detail without hiding the other sources', async()=>{
  let revoked=false;
  const p=await probeBankWorkspace({history:{readWithdrawalHistory:async(_user,query)=>{if(query.source==='JOINPAY'&&revoked)throw new WithdrawalRequestError(403,'FORBIDDEN');return history(query.source,{items:query.source==='JOINPAY'?[nativeItem]:query.source==='LOCAL_CONTROLLED'?[localItem]:[]});},readWithdrawalHistoryItem:async()=>({contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{item:{...nativeItem,merchantOrderNo:'PRIVATE_DETAIL_BEFORE_REVOCATION'},scope:'LOCAL_NATIVE_INTENTS_ONLY'}})}});
  try{await p.render();const section=p.host.querySelector('[aria-label="提现记录"]');const target=[...section.querySelectorAll('.bank-history-row')].find(row=>row.textContent.includes('0015'));const detailButton=target?.querySelector('button');assert(detailButton);await React.act(async()=>detailButton.click());await p.settle();assert.match(section.textContent,/PRIVATE_DETAIL_BEFORE_REVOCATION/);revoked=true;await p.click('刷新',section);assert.doesNotMatch(section.textContent,/PRIVATE_DETAIL_BEFORE_REVOCATION/);assert.equal(section.querySelector('.bank-history-detail'),null);assert.equal(section.querySelectorAll('.bank-history-row').length,1);assert.match(section.textContent,/当前列表可能不完整/);}finally{await p.close();}
});

for(const denialStatus of [401,403]){
 test(`a late history page cannot restore private rows after detail ${denialStatus}`,async()=>{
  const later=deferred(),items=nativeHistoryPage(),local={...localItem,acceptedAt:bankAt};
  const p=await probeBankWorkspace({history:{readWithdrawalHistory:async(_user,query)=>query.source==='JOINPAY'&&query.cursor?later.promise:history(query.source,{items:query.source==='JOINPAY'?items:query.source==='LOCAL_CONTROLLED'?[local]:[],cursor:query.source==='JOINPAY'?'next':null}),readWithdrawalHistoryItem:async()=>{throw new WithdrawalRequestError(denialStatus,denialStatus===401?'UNAUTHENTICATED':'FORBIDDEN');}}});
  try{
   let revalidations=0;p.session.revalidate=()=>{revalidations++;};await p.render();const section=p.host.querySelector('[aria-label="提现记录"]');
   assert.equal(section.querySelectorAll('.bank-history-row').length, 5); while([...section.querySelectorAll('button')].some(b=>b.textContent.includes('查看更多记录'))){await p.click('查看更多记录',section);} assert.ok(section.querySelectorAll('.bank-history-row').length>=20); await p.click('加载更多记录',section);
   const target=[...section.querySelectorAll('.bank-history-row')].find(row=>row.textContent.includes('0015'));assert(target);await React.act(async()=>target.querySelector('button').click());await p.settle();
   assert.equal([...section.querySelectorAll('.bank-history-row')].filter(row=>row.textContent.includes('0015')).length,0);
   if(denialStatus===403)assert.match(section.textContent,/测试记录，未实际打款/);else{assert.equal(section.querySelectorAll('.bank-history-row').length,0);assert.equal(revalidations,1);}
   await React.act(async()=>later.resolve(history('JOINPAY',{items:[{...nativeItem,id:'joinpay:late',intentId:'late',occurredAt:'2026-10-23T00:00:00.000Z'}]})));await p.settle();
   assert.equal([...section.querySelectorAll('.bank-history-row')].filter(row=>row.textContent.includes('0015')).length,0);
   if(denialStatus===403)assert.match(section.textContent,/测试记录，未实际打款/);else assert.equal(section.querySelectorAll('.bank-history-row').length,0);
  }finally{later.resolve(history('JOINPAY'));await p.close();}
 });
}

test('a late detail cannot reappear after its history source is forbidden',async()=>{
 const detail=deferred(),items=nativeHistoryPage();
 const p=await probeBankWorkspace({history:{readWithdrawalHistory:async(_user,query)=>{if(query.source==='JOINPAY'&&query.cursor)throw new WithdrawalRequestError(403,'FORBIDDEN');return history(query.source,{items:query.source==='JOINPAY'?items:query.source==='LOCAL_CONTROLLED'?[localItem]:[],cursor:query.source==='JOINPAY'?'next':null});},readWithdrawalHistoryItem:async()=>detail.promise}});
 try{
  await p.render(); const section = p.host.querySelector('[aria-label="提现记录"]'); while ([...section.querySelectorAll('button')].some(b => b.textContent.includes('查看更多记录'))) { await p.click('查看更多记录', section); } const target = [...section.querySelectorAll('.bank-history-row')].find(row => row.textContent.includes('0015')); assert(target);
  await React.act(async()=>target.querySelector('button').click());await p.settle();await p.click('加载更多记录',section);
  assert.equal(section.querySelector('.bank-history-detail'),null);
  await React.act(async()=>detail.resolve({contractVersion:'personal-withdrawals.read.v2',subjectId:'user_A',source:'JOINPAY',availability:'AVAILABLE',reasonCodes:[],data:{item:{...nativeItem,merchantOrderNo:'PRIVATE_LATE_DETAIL'},scope:'LOCAL_NATIVE_INTENTS_ONLY'}}));await p.settle();
  assert.doesNotMatch(section.textContent,/PRIVATE_LATE_DETAIL/);assert.equal(section.querySelector('.bank-history-detail'),null);
 }finally{detail.resolve(null);await p.close();}
});

for(const [caseName,changed] of [['missing',null],['different-key',{userId:'user_A',key:'replacement-key',expectedRevision:'0'}],['different-revision',{userId:'user_A',key:'original-key',expectedRevision:'9'}]]){
  test(`recovery form keeps its original mode and stops when marker is ${caseName}`,async()=>{
    const original={userId:'user_A',key:'original-key',expectedRevision:'0'};
    const p=await probeBankWorkspace({pendingBank:original,bank:{readBankBinding:async()=>emptyBank}});
    try{await p.render();await p.click('重新输入原资料');await p.fill('[name="bank-holder-name"]','离线测试甲');await p.fill('[name="bank-card-number"]','0000000000000015');p.setPendingBank(changed);await p.submit('.bank-binding-form');assert.equal(p.calls.filter(x=>x.method==='saveBank').length,0);assert.match(p.host.querySelector('.bank-binding-form').textContent,/上次保存状态已变化/);assert.match(p.host.querySelector('.bank-binding-form button[type="submit"]').textContent,/确认并继续保存/);assert.equal(p.host.querySelector('.bank-binding-form button[type="submit"]').disabled,true);await p.click('取消填写');assert.match(p.host.querySelector('.bank-binding-panel').textContent,/上次保存结果未记录/);assert.equal([...p.host.querySelectorAll('.bank-binding-panel button')].some(x=>x.textContent==='修改收款资料'||x.textContent==='绑定银行卡'),false);}finally{await p.close();}
  });
}

test('a new edit never turns itself into a resume when another pending marker appears',async()=>{
  const marker={userId:'user_A',key:'other-request',expectedRevision:'1'};
  const p=await probeBankWorkspace();
  try{await p.render();await p.click('修改收款资料');await p.fill('[name="bank-holder-name"]','离线新资料');await p.fill('[name="bank-card-number"]','0000000000000023');p.setPendingBank(marker);await p.submit('.bank-binding-form');assert.equal(p.calls.filter(x=>x.method==='saveBank').length,0);assert.match(p.host.querySelector('.bank-binding-form').textContent,/上次保存结果未记录/);assert.equal(p.host.querySelector('.bank-binding-form button[type="submit"]').textContent,'保存收款资料');await p.click('重新输入原资料');assert.equal(p.host.querySelector('[name="bank-holder-name"]').value,'');assert.equal(p.host.querySelector('[name="bank-card-number"]').value,'');await p.fill('[name="bank-holder-name"]','离线原资料');await p.fill('[name="bank-card-number"]','0000000000000015');await p.submit('.bank-binding-form');const call=p.calls.find(x=>x.method==='saveBank');assert.equal(call.opts.resume,true);assert.deepEqual(call.opts.expectedPending,marker);assert.equal(call.body.expectedRevision,'1');}finally{await p.close();}
});

test('readonly recovery uses the selected original key after marker replacement and leaves the other request intact',async()=>{
  const original={userId:'user_A',key:'original-key',expectedRevision:'0'},replacement={userId:'user_A',key:'replacement-key',expectedRevision:'1'},seen=[];
  const p=await probeBankWorkspace({pendingBank:original,bank:{recoverBankBinding:async(userId,opts)=>{seen.push({userId,expectedPending:opts.expectedPending});return {knowledge:'KNOWN',receipt:bank('1'),current:bank('2','0023')};}}});
  try{await p.render();await p.click('重新输入原资料');p.setPendingBank(replacement);await p.submit('.bank-binding-form');await p.click('查询保存结果');assert.deepEqual(seen,[{userId:'user_A',expectedPending:original}]);assert.deepEqual(p.bankApi.pendingBankBinding(),replacement);assert.equal(p.calls.filter(x=>x.method==='saveBank').length,0);assert.match(p.host.querySelector('.bank-binding-panel').textContent,/上次保存结果未记录/);}finally{await p.close();}
});

test('formal admission quota/age blockers use their exact server reason copy, not a generic failure', async () => {
  const p = await probeBankWorkspace({ channel: { readChannelWithdrawalOptions: async () => ({ ...options(bank(), false),
    reasonCodes: ['ADULT_STATUS_REQUIRED', 'WITHDRAWAL_QUOTA_EXHAUSTED'] }) } });
  try {
    await p.render();
    assert.match(p.host.textContent, /当前年龄资料不符合提现要求/);
    assert.match(p.host.textContent, /今日提现申请次数已用完/);
    assert.doesNotMatch(p.host.textContent, /暂未满足服务端提现条件/);
  } finally { await p.close(); }
});
