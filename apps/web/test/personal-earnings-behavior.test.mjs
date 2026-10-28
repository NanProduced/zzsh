import assert from 'node:assert/strict';import {test} from 'node:test';import {createRequire,Module} from 'node:module';import {readFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),require=createRequire(tree+'/package.json'),React=require('react'),{Window}=require('happy-dom'),ts=require('typescript');
const client=require(tree+'/apps/web/src/lib/distribution-earnings-client.ts'),wallet=require(tree+'/apps/web/src/lib/personal-wallet-client.ts');
const compiled=ts.transpileModule(readFileSync(tree+'/apps/web/src/components/account/personal-earnings.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const at='2026-10-04T00:00:00.000000Z',old={id:'history:one',origin:'LEGACY_MYSQL',state:'SETTLED',role:'RENTER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'1234'},occurredAt:at,dueAt:null,dueAtKnowledge:'UNKNOWN',fundsDisposition:'HISTORICAL_STATUS_ONLY',recoveryRequiredCents:null,includedInOpening:true,version:null,accountingEffect:'OBSERVATION_ONLY_NO_NEW_CREDIT',businessReference:{type:'LEGACY_UNRESOLVED',id:'legacy'},channelArrivalKnowledge:'UNKNOWN'};
const native={...old,id:'native:two',origin:'NATIVE',state:'RECOVERY_REQUIRED',role:'OWNER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'1000'},dueAt:at,dueAtKnowledge:'KNOWN',fundsDisposition:'SETTLED',recoveryRequiredCents:'1000',includedInOpening:false,version:'3',accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'}};
const base=user=>({contractVersion:'distribution-earnings.read.v1',projectionVersion:2,subjectId:user,snapshotVersion:'v1',asOf:at});
const page=(user,items=[old,native])=>({...base(user),state:'ALL',knowledge:'UNKNOWN',count:null,mappedRecordCount:String(items.length),reason:'HISTORICAL_EARNINGS_COVERAGE_NOT_CLOSED',totalAmountKnowledge:'UNKNOWN',amountsByOrigin:{scope:'SOURCE_RECORDS_ONLY',native:{knowledge:'UNKNOWN',amountCents:null},historical:{knowledge:'UNKNOWN',amountCents:null},mappedHistoricalAmountCents:items.filter(i=>i.origin==='LEGACY_MYSQL').reduce((s,i)=>s+BigInt(i.amount.amountCents),0n).toString()},items,nextCursor:null});
async function probe(fetcher,query='view=invite'){
 const w=new Window({url:'http://127.0.0.1:4200/account?'+query}),previous=globalThis.fetch;
 Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,MouseEvent:w.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});globalThis.fetch=fetcher;
 const session={status:'authenticated',userId:'user_A',identityVersion:1,revalidations:0,revalidate(){this.revalidations++;}},m=new Module(tree+'/earnings-ui-probe.cjs');
 let params=new URLSearchParams(query),render;
 const navigation=[];const router={push(href){navigation.push(href);params=new URL(href,w.location.origin).searchParams;}};
 m.filename=tree+'/earnings-ui-probe.cjs';m.paths=Module._nodeModulePaths(tree);m.require=name=>{
  if(name==='next/link')return({scroll:_scroll,...props})=>React.createElement('a',props);
  if(name==='next/navigation')return{useSearchParams:()=>params,useRouter:()=>router};
  if(name==='@/components/session/user-session-provider')return{useUserSession:()=>session,useUserSessionStore:()=>({getSnapshot:()=>session})};
  if(name==='@/lib/distribution-earnings-client')return client;if(name==='@/lib/personal-wallet-client')return wallet;
  if(name==='@/lib/order-client')return require(tree+'/apps/web/src/lib/order-client.ts');if(name.endsWith('.css'))return{};return require(name);
 };
 m._compile(compiled,m.filename);const host=w.document.createElement('div');w.document.body.append(host);const root=require('react-dom/client').createRoot(host);
 const settle=async()=>{for(let i=0;i<3;i++)await React.act(async()=>{await new Promise(setImmediate);});};
 render=async()=>{await React.act(async()=>root.render(React.createElement(m.exports.PersonalEarnings,{scope:session.userId+':'+session.identityVersion})));await settle();};
 return{host,session,settle,render,navigation,params:()=>params,
  async setQuery(query){params=new URLSearchParams(query);await render();},
  async click(label){const button=[...host.querySelectorAll('button')].find(b=>b.textContent.includes(label));assert(button);const before=params.toString();await React.act(async()=>button.dispatchEvent(new w.MouseEvent('click',{bubbles:true})));if(before!==params.toString())await render();await settle();return button;},
  async close(){await React.act(async()=>root.unmount());await w.happyDOM.abort();globalThis.fetch=previous;}
 };
}

test('actual earnings component preserves partial truth, shows original history and returns focus to its row',async()=>{let lists=0;const p=await probe(async url=>{if(String(url).includes('/history%3Aone'))return Response.json({...base('user_A'),item:old});lists++;return Response.json(page('user_A'));});try{await p.render();assert.match(p.host.textContent,/已确认 2 条 · 总数待核定/);const button=await p.click('购买分佣');assert.match(p.host.querySelector('.earning-detail').textContent,/已包含在期初余额，不会再次入账/);assert.match(p.host.querySelector('.earning-detail').textContent,/未核定/);assert.equal(document.activeElement,p.host.querySelector('h4'));await p.click('返回收益列表');assert.equal(document.activeElement,button);assert.equal(lists,1);}finally{await p.close();}});

test('U07 opening, refreshing and back/forward preserve the exact earning and existing account query',async()=>{
 const fetcher=async url=>Response.json(String(url).includes('/history%3Aone')?{...base('user_A'),item:old}:page('user_A'));
 const p=await probe(fetcher,'view=invite&tab=earnings&page=2');let target;
 try{await p.render();await p.click('购买分佣');target=p.navigation.at(-1);assert.ok(target,'opening detail must produce a stable URL');
  const q=new URL(target,'http://127.0.0.1').searchParams;assert.equal(q.get('earning'),'history:one');assert.equal(q.get('view'),'invite');assert.equal(q.get('page'),'2');assert.equal(q.get('tab'),'earnings');
  await p.click('返回收益列表');assert.equal(p.params().get('earning'),null);assert.equal(p.params().get('page'),'2');
  await p.setQuery(q.toString());assert.match(p.host.querySelector('.earning-detail').textContent,/购买分佣详情/);
 }finally{await p.close();}
 const restored=await probe(fetcher,new URL(target,'http://127.0.0.1').searchParams.toString());
 try{await restored.render();assert.match(restored.host.querySelector('.earning-detail').textContent,/购买分佣详情/);}finally{await restored.close();}
});

test('U04 real detail shows frozen terms without inventing a base, and history explains missing original terms',async()=>{
 const calculation={knowledge:'KNOWN',policyVersion:'FROZEN_POLICY_ONLY',beneficiaryLevelCode:'LEVEL_FROZEN',percent:'7.5',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null};
 const p=await probe(async()=>Response.json({...base('user_A'),item:{...native,calculation}}),'view=invite&earning=native%3Atwo');
 try{await p.render();const text=p.host.querySelector('.earning-calculation').textContent;assert.match(text,/7\.5%/);assert.match(text,/LEVEL_FROZEN/);assert.match(text,/FROZEN_POLICY_ONLY/);assert.match(text,/四舍五入到分/);assert.match(text,/不在本人收益明细中公开/);assert.doesNotMatch(text,/基数.*¥/);}finally{await p.close();}
 const historical=await probe(async()=>Response.json({...base('user_A'),item:{...old,state:'EXPIRED',includedInOpening:false}}),'view=invite&earning=history%3Aone');
 try{await historical.render();const text=historical.host.querySelector('.earning-calculation').textContent;assert.match(text,/历史来源未记录/);assert.match(text,/未记录失效原因/);assert.doesNotMatch(text,/5%|0%/);}finally{await historical.close();}
});

test('U07 malformed IDs do not fetch and late previous detail cannot replace the current URL target',async()=>{
 let calls=0;const bad=await probe(async()=>{calls++;throw Error('invalid id must not fetch');},'view=invite&earning=bad%2Fpath');
 try{await bad.render();assert.equal(calls,0);assert.match(bad.host.textContent,/这条收益记录当前不可用/);}finally{await bad.close();}
 let resolve;const pending=new Promise(done=>{resolve=done;});
 const p=await probe(async url=>String(url).includes('history%3Aone')?pending:Response.json({...base('user_A'),item:{...old,id:'history:other',amount:{...old.amount,amountCents:'9900'}}}),'view=invite&earning=history%3Aone');
 try{await p.render();await p.setQuery('view=invite&earning=history%3Aother');await React.act(async()=>resolve(Response.json({...base('user_A'),item:old})));await p.settle();assert.match(p.host.querySelector('.earning-detail').textContent,/99\.00/);assert.doesNotMatch(p.host.querySelector('.earning-detail').textContent,/12\.34/);}finally{resolve(Response.json({...base('user_A'),item:old}));await p.close();}
});

test('U07 returning to a filtered list preserves loaded pages and its signed next-cursor progress',async()=>{
 let lists=0;const first={...page('user_A',[old]),state:'SETTLED',mappedRecordCount:'2',nextCursor:'original-signed-cursor'};
 const p=await probe(async url=>{const s=String(url);if(s.includes('/history%3Aone'))return Response.json({...base('user_A'),snapshotVersion:'ALL-state-detail-snapshot',item:old});lists++;assert.equal(new URL(s,'http://127.0.0.1').searchParams.get('state'),'SETTLED');return Response.json(s.includes('cursor=')?{...first,items:[{...native,state:'SETTLED',recoveryRequiredCents:null}],nextCursor:null}:first);},'view=invite&earningState=SETTLED&page=2&cursor=existing-account-cursor');
 try{await p.render();await p.click('加载更多收益');assert.equal(p.host.querySelectorAll('.earning-record').length,2);await p.click('购买分佣');assert.equal(p.params().get('earningState'),'SETTLED');assert.equal(p.params().get('cursor'),'existing-account-cursor');await p.click('返回收益列表');assert.equal(p.host.querySelectorAll('.earning-record').length,2);assert.equal(lists,2);assert.equal(p.params().get('page'),'2');}finally{await p.close();}
});
test('recovery detail preserves unsettled debt instead of claiming a reversal or payout',async()=>{const p=await probe(async url=>Response.json(String(url).includes('/native%3Atwo')?{...base('user_A'),item:native}:page('user_A')));try{await p.render();await p.click('上架分佣');const text=p.host.querySelector('.earning-detail').textContent;assert.match(text,/待追回金额/);assert.match(text,/尚未完成扣回/);assert.doesNotMatch(text,/已到账|已扣回/);}finally{await p.close();}});
test('definite 401 clears list and detail and revalidates shared identity',async()=>{let denied=false;const p=await probe(async()=>denied?Response.json({error:{code:'UNAUTHENTICATED'}},{status:401}):Response.json(page('user_A')));try{await p.render();assert.equal(p.host.querySelectorAll('.earning-record').length,2);denied=true;await p.click('重新读取');assert.equal(p.host.querySelectorAll('.earning-record').length,0);assert.equal(p.session.revalidations,1);}finally{await p.close();}});
test('late previous identity earnings never replace the new subject list',async()=>{let phase='old',resolveOld;const pending=new Promise(r=>resolveOld=r),p=await probe(async()=>phase==='old'?pending:Response.json(page('user_B',[{...old,amount:{...old.amount,amountCents:'9900'}}])));try{await p.render();phase='new';p.session.userId='user_B';p.session.identityVersion=2;await p.render();await React.act(async()=>resolveOld(Response.json(page('user_A'))));await p.settle();assert.match(p.host.textContent,/99\.00/);assert.doesNotMatch(p.host.textContent,/12\.34/);}finally{resolveOld(Response.json(page('user_A')));await p.close();}});
test('next-page snapshot drift clears stale records instead of joining incompatible states',async()=>{const p=await probe(async url=>Response.json(String(url).includes('cursor=')?{...page('user_A',[native]),snapshotVersion:'changed',mappedRecordCount:'2'}:{...page('user_A',[old]),mappedRecordCount:'2',nextCursor:'next'}));try{await p.render();await p.click('加载更多收益');assert.equal(p.host.querySelectorAll('.earning-record').length,0);assert.match(p.host.textContent,/收益记录已变化/);}finally{await p.close();}});
test('new platform zero finalization is visible next to unchanged original pending amount and is never labelled paid out',async()=>{const entry={...old,state:'PENDING',includedInOpening:false,currentFinance:{knowledge:'KNOWN',state:'SETTLED',amountCents:'0',zeroFinalization:true,reference:{type:'FINANCE_EVENT',id:'final-zero',digest:'a'.repeat(64)}}},p=await probe(async url=>Response.json(String(url).includes('/history%3Aone')?{...base('user_A'),item:entry}:page('user_A',[entry])));try{await p.render();assert.match(p.host.textContent,/已终定 · 零额/);await p.click('购买分佣');const detail=p.host.querySelector('.earning-detail').textContent;assert.match(detail,/原记录状态待结算/);assert.match(detail,/本平台承接金额¥0\.00/);assert.match(detail,/零额终定，没有资金分录/);assert.doesNotMatch(detail,/已到账|已打款/);}finally{await p.close();}});

test('uniform frozen calculation uses its own rate and never renders a missing grade as unknown',async()=>{
 const calculation={knowledge:'KNOWN',policyVersion:'FROZEN_UNIFORM',beneficiaryLevelCode:null,rateMode:'UNIFORM',percent:'2.125',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null};
 const p=await probe(async url=>{assert.equal(new URL(String(url),'http://fixture.invalid').searchParams.get('calculationVersion'),'2');return Response.json({...base('user_A'),item:{...native,calculation}});},'view=invite&earning=native%3Atwo');
 try{await p.render();const text=p.host.querySelector('.earning-calculation').textContent;assert.match(text,/2\.125%/);assert.match(text,/统一比例/);assert.match(text,/FROZEN_UNIFORM/);assert.doesNotMatch(text,/付款时分销等级|null|undefined|适用比例及等级待确认/);}finally{await p.close();}
});

test('Native frozen terms are not relabelled local-controlled or channel arrival',async()=>{
 const calculation={knowledge:'KNOWN',policyVersion:'NATIVE_FROZEN',beneficiaryLevelCode:null,rateMode:'UNIFORM',percent:'2',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'NATIVE',orderNumber:null};
 const p=await probe(async()=>Response.json({...base('user_A'),item:{...native,calculation}}),'view=invite&earning=native%3Atwo');try{await p.render();const text=p.host.querySelector('.earning-calculation').textContent;assert.match(text,/原付款冻结政策/);assert.doesNotMatch(text,/本地联验政策|已到账/);}finally{await p.close();}
});
