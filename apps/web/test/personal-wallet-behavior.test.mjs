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
 for(const [sourceKind,label] of [['NATIVE_SETTLEMENT','出租结算'],['NATIVE_REFERRAL_EARNING_SETTLED','分销收益'],['JOINPAY_WITHDRAWAL_RESERVED','提现申请扣款'],['JOINPAY_WITHDRAWAL_RELEASED','提现资金退回'],['CONTROLLED_WITHDRAWAL_RESERVE','提现申请扣款']])
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
