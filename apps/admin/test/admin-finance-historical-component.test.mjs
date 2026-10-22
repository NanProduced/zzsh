import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=new Window({url:'http://127.0.0.1:4291/finance'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','ResizeObserver','CSS','localStorage','sessionStorage'])globalThis[key]=key==='window'?browser:browser[key];
Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(rootPath,'src'),'@brand':path.resolve(rootPath,'../../assets/brand')}},server:{middlewareMode:true,hmr:false,ws:false}});
const formats=await vite.ssrLoadModule('/src/views/admin-finance-api.ts');
const {AdminFinanceView,HistoricalFinanceDetail,clearFinanceContexts}=await vite.ssrLoadModule('/src/views/admin-finance-view.tsx');
const {UserDetailFinance}=await vite.ssrLoadModule('/src/views/user-directory/user-detail-finance.tsx');
after(async()=>{await vite.close();await browser.happyDOM.abort();});
const at='2026-06-29T11:22:42Z';
const association={state:'MATCHED',kind:'WITHDRAWAL',documentRef:'HISTORY_WITHDRAWAL:synthetic-5053',number:'20260629192242694162',path:'/finance/documents/HISTORY_WITHDRAWAL%3Asynthetic-5053',role:'WITHDRAWER',originalStatus:'3',originalStatusLabel:'旧平台记为成功'};
const historical={changeType:'1002',purposeCode:'WITHDRAWAL_DEBIT',purposeLabel:'提现申请扣款',originalLogNumber:'SYNTHETIC-LOG-11437',recordedAmountCents:'73400',balanceAfterCents:'50200',feeCents:'100',netCents:'73300',originalStatus:null,originalStatusLabel:null,channelState:'UNVERIFIED',association};
const debit={ref:'HISTORY_EARNINGS:synthetic-log',number:'11437',kind:'EARNINGS',state:'HISTORICAL_OBSERVED',occurredAt:at,requestedAmountCents:null,subjects:[{id:'synthetic-user',name:'用户一'}],entryCount:1,amounts:[{bucket:'AVAILABLE',knownNetCents:'-73400',unknownCount:0}],historical};
const application={...debit,ref:association.documentRef,number:association.number,kind:'WITHDRAWAL',requestedAmountCents:'73400',historical:{...historical,changeType:null,purposeCode:'WITHDRAWAL_APPLICATION',purposeLabel:'提现申请记录',originalLogNumber:null,originalStatus:'3',originalStatusLabel:'旧平台记为成功',association:{state:'UNRESOLVED',kind:'UNKNOWN',documentRef:null,number:null,path:null,role:null,originalStatus:null,originalStatusLabel:null}}};
const entry={id:'history:synthetic-log',documentRef:debit.ref,documentNumber:debit.number,subjectId:'synthetic-user',subjectName:'用户一',bucket:'AVAILABLE',direction:'OUT',deltaCents:'-73400',knowledge:'KNOWN',kind:debit.kind,state:debit.state,classification:'HISTORICAL_UNCOVERED',affectsCurrentWallet:false,affectsCurrentLedger:false,occurredAt:at,importedAt:'2026-10-22T00:00:00Z',sourceType:'LEGACY_MYSQL',sourceSystem:'legacy_mysql_restore',sourceEntity:'la_log_earnings',sourceId:'11437',sourceDigest:'a'.repeat(64),basisId:null,reasonCodes:[],accountCode:null,evidence:{},historical};
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
async function waitFor(condition){const until=Date.now()+3000;while(!condition()){if(Date.now()>until)throw Error('Historical finance condition timed out');await settle();}}
const button=(label,host=browser.document)=>[...host.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
async function click(node){assert.ok(node);await act(async()=>node.click());await settle();}
let serial=0;
async function mount(t,{mode='lookup',documents=[debit,application],doc=debit,lines=[entry],permissions=['finance.read','finance.document.read','order.read'],evidence={},related=[],query={}}={}){
  clearFinanceContexts();browser.sessionStorage.clear();
  const snapshot={authenticated:true,adminUserId:`historical-admin-${++serial}`,user:{name:'运营甲',username:'OPERATOR'},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},session:{id:`historical-session-${serial}`,locked:false},permissions};
  const opened=[],requests=[],host=browser.document.createElement('div');host.className='workspace-root';browser.document.body.append(host);const root=createRoot(host),prior=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{assert.equal(init.method??'GET','GET');requests.push(String(url));const address=new URL(url,browser.location.href),params=address.searchParams;
    const linkedApplication=address.pathname.endsWith(encodeURIComponent(application.ref));
    const documentLines=linkedApplication?[{...entry,id:'associated-entry',documentRef:application.ref,documentNumber:application.number,kind:'WITHDRAWAL',historical:application.historical}]:lines;
    const payload={contractVersion:'admin-finance.read.v1',applied:{scope:params.get('scope')??'ALL',period:params.get('period')==='1',from:params.get('from'),to:params.get('to'),q:params.get('q')??'',kind:'ALL',state:'ALL',bucket:'ALL'},snapshot:'synthetic-snapshot',asOf:at,contextKey:'synthetic-context',snapshotVersion:'synthetic-version',documents,documentCount:documents.length,entryCount:documentLines.length,page:1,pageSize:20,hasMore:false,...(mode==='document'?{document:linkedApplication?application:doc,entries:documentLines,evidence:linkedApplication?{}:evidence,related:linkedApplication?[]:related,reasonCodes:[]}:{} )};
    return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});};
  const props={tab:{id:`history-${serial}`,path:mode==='document'?`/finance/documents/${encodeURIComponent(doc.ref)}`:'/finance',query,closable:true,kind:'unknown',title:'资金'},snapshot,onOpenPath:(...args)=>opened.push(args),onQueryChange(){},onRefresh:async()=>props.snapshot,refreshNonce:0};
  await act(async()=>root.render(createElement(AdminFinanceView,props)));await settle();
  t.after(async()=>{globalThis.fetch=prior;clearFinanceContexts();await act(async()=>root.unmount());host.remove();await settle();});
  return{host,opened,requests,props,render:async()=>{await act(async()=>root.render(createElement(AdminFinanceView,props)));await settle();}};
}

test('lookup explains the application and debit as two records of one withdrawal without adding them',async t=>{
  const ui=await mount(t);await waitFor(()=>ui.host.textContent.includes('SYNTHETIC-LOG-11437'));
  assert.match(ui.host.textContent,/提现申请扣款/);assert.match(ui.host.textContent,/提现申请记录/);assert.match(ui.host.textContent,/2 份记录/);assert.doesNotMatch(ui.host.textContent,/2 次提现|1,468\.00/);
  assert.match(ui.host.textContent,/原流水号 SYNTHETIC-LOG-11437/);assert.match(ui.host.textContent,/关联提现单：20260629192242694162/);
  assert.match(ui.host.textContent,/历史变动 −734\.00 元/);assert.doesNotMatch(ui.host.textContent,/用户可用.*−734/);
  await click(button('历史记录详情',ui.host));assert.match(ui.host.textContent,/同一笔业务，不重复汇总/);
  await click(ui.host.querySelector('[data-historical-association] button'));
  const target=new URL(ui.opened.at(-1)[0],browser.location.href);assert.equal(target.pathname,association.path);assert.ok(target.searchParams.get('origin'));assert.ok(ui.requests.every(value=>value.startsWith('/api/bff/admin/finance/')));
});

test('document shows raw fee, net and old balance separately from channels and keeps the original deep link',async t=>{
  const ui=await mount(t,{mode:'document'});await waitFor(()=>ui.host.querySelector('[data-historical-finance]')?.textContent.includes('手续费'));
  const facts=ui.host.querySelector('[data-historical-finance]');
  for(const label of ['原流水号','原金额','变动后余额（旧）','手续费','净额'])assert.ok(facts.textContent.includes(label),label);
  for(const value of ['SYNTHETIC-LOG-11437','734.00 元','502.00 元','1.00 元','733.00 元'])assert.ok(facts.textContent.includes(value),value);
  assert.match(facts.textContent,/旧平台记为成功/);assert.match(facts.textContent,/渠道未核/);assert.match(ui.host.textContent,/不改变当前钱包/);assert.doesNotMatch(ui.host.textContent,/渠道已到账|已成功到账/);
  const original=ui.host.querySelector('[data-finance-focus="history:synthetic-log"]');await click(original);
  const target=new URL(ui.opened.at(-1)[0],browser.location.href);assert.equal(decodeURIComponent(target.pathname.slice('/finance/documents/'.length)),debit.ref);assert.equal(target.searchParams.get('entry'),entry.id);
  assert.equal(ui.opened.at(-1)[1],'提现申请扣款 · SYNTHETIC-LOG-11437','workspace titles retain the specific record alongside its purpose');
});

test('DENIED hides relation identity in detail, evidence, secondary links and copied summary',async t=>{
  const denied={...historical,association:{...association,state:'DENIED',kind:'ORDER',number:'PRIVATE_ORDER_NUMBER',documentRef:'PRIVATE_REF',path:'/orders/PRIVATE_ORDER_ID',role:'OWNER'}};
  const privateDoc={...debit,historical:denied};const ui=await mount(t,{mode:'document',doc:privateDoc,lines:[{...entry,historical:denied}],evidence:{originalReference:'PRIVATE_ORDER_ID',originalOrderNumber:'PRIVATE_ORDER_NUMBER',ownerSubjectId:'PRIVATE_SUBJECT'},related:[{ref:'PRIVATE_REF',label:'PRIVATE_ORDER_NUMBER',path:'/orders/PRIVATE_ORDER_ID'}]});
  await waitFor(()=>ui.host.textContent.includes('关联信息无权限'));assert.doesNotMatch(ui.host.textContent,/PRIVATE_/);assert.equal(ui.host.querySelector('[data-historical-association] button'),null);
  let copied='';t.mock.method(browser.navigator.clipboard,'writeText',async value=>{copied=value;});await click(button('复制摘要',ui.host));
  assert.doesNotMatch(copied,/PRIVATE_/);assert.match(copied,/历史记录不改变当前钱包/);assert.match(copied,/原流水号：SYNTHETIC-LOG-11437/);
});

test('permission loss cannot retain a previously authorized order number or link',async t=>{
  const related={...historical,purposeCode:'OWNER_RENTAL_INCOME',purposeLabel:'号主租赁收入',association:{...association,kind:'ORDER',number:'PERMISSION_ORDER_NUMBER',documentRef:'ORDER:permission-order',path:'/orders/permission-order',role:'OWNER'}};
  const ui=await mount(t,{mode:'document',doc:{...debit,historical:related},lines:[{...entry,historical:related}],evidence:{originalOrderNumber:'PERMISSION_ORDER_NUMBER'}});await waitFor(()=>ui.host.textContent.includes('PERMISSION_ORDER_NUMBER'));
  ui.props.snapshot={...ui.props.snapshot,permissions:['finance.read','finance.document.read']};await ui.render();assert.doesNotMatch(ui.host.textContent,/PERMISSION_ORDER_NUMBER/);
  await waitFor(()=>ui.host.textContent.includes('关联信息无权限'));assert.doesNotMatch(ui.host.textContent,/PERMISSION_ORDER_NUMBER/);assert.equal(ui.host.querySelector('[data-historical-association] button'),null);
});

test('unresolved and ambiguous facts expose no guessed association and retain unknown amounts and original codes',async t=>{
  const unknown=state=>({...debit,ref:`HISTORY_EARNINGS:${state}`,historical:{...historical,changeType:'9999',purposeCode:'UNKNOWN',purposeLabel:'用途待核',recordedAmountCents:null,balanceAfterCents:'-10',feeCents:null,netCents:null,association:{...association,state,number:'UNPROVED_NUMBER',documentRef:'UNPROVED_REF',path:'/orders/UNPROVED_ID'}}});
  const ui=await mount(t,{documents:[unknown('UNRESOLVED'),unknown('AMBIGUOUS')]});await waitFor(()=>ui.host.textContent.includes('用途待核'));
  assert.match(ui.host.textContent,/关联待核/);assert.match(ui.host.textContent,/多条关联候选/);assert.doesNotMatch(ui.host.textContent,/UNPROVED_/);assert.equal(ui.host.querySelector('[data-historical-association] button'),null);
  await click(button('历史记录详情',ui.host));assert.match(ui.host.textContent,/9999/);assert.match(ui.host.textContent,/−0\.10 元/);assert.match(ui.host.textContent,/未核定/);
});

test('purpose comes from the API rather than the amount sign and unsafe association routes are ignored',()=>{
  const value={...debit,historical:{...historical,changeType:'1006',purposeCode:'PLATFORM_CREDIT',purposeLabel:'平台加款'}};
  assert.equal(formats.financeBusinessLabel(value),'平台加款');assert.equal(formats.financeRecordState({...debit,historical:{...historical,originalStatusLabel:'成功'}}),'旧平台状态：成功');
  for(const path of ['https://foreign.invalid/orders/id','//foreign.invalid/id','javascript:alert(1)','/settings'])assert.equal(formats.historicalAssociationPath({...historical,association:{...association,path}},{orderRead:true,documentRead:true}),null);
  assert.equal(formats.historicalAssociationPath(historical,{orderRead:true,documentRead:false}),null);
  assert.equal(formats.historicalAssociationPath({...historical,association:{...association,path:null}},{orderRead:false,documentRead:true}),'/finance/documents/HISTORY_WITHDRAWAL%3Asynthetic-5053');
});

test('the owner-income samples retain distinct API order paths instead of deriving one from a legacy number',async t=>{
  const samples=[['77.00','7700','14998'],['59.00','5900','16789'],['130.00','13000','12097']];
  const documents=samples.map(([_yuan,cents,legacyId],index)=>({...debit,ref:`HISTORY_EARNINGS:sample-${index}`,number:`ROW-${index}`,amounts:[{bucket:'AVAILABLE',knownNetCents:cents,unknownCount:0}],historical:{...historical,purposeCode:'OWNER_RENTAL_INCOME',purposeLabel:'号主租赁收入',originalLogNumber:`SYNTHETIC-INCOME-${index}`,recordedAmountCents:cents,association:{...association,kind:'ORDER',documentRef:`ORDER:stable-${index}`,number:`BUSINESS-ORDER-${legacyId}`,path:`/orders/stable-${index}`,role:'OWNER'}}}));
  const ui=await mount(t,{documents});await waitFor(()=>ui.host.querySelectorAll('[data-historical-association] button').length===3);
  for(const [yuan]of samples)assert.ok(ui.host.textContent.includes(`${yuan} 元`),yuan);
  for(const [index,node]of [...ui.host.querySelectorAll('[data-historical-association] button')].entries()){await click(node);assert.equal(ui.opened.at(-1)[0],`/orders/stable-${index}`);}
});

test('old DTOs remain readable without fabricating fee, association or a business number',async t=>{
  const {historical:_historical,...old}=debit;const ui=await mount(t,{documents:[old]});await waitFor(()=>ui.host.textContent.includes('记录编号 11437'));
  assert.match(ui.host.textContent,/旧平台记录/);assert.match(ui.host.textContent,/历史变动 −734\.00 元/);assert.equal(ui.host.querySelector('[data-historical-finance]'),null);assert.doesNotMatch(ui.host.textContent,/关联提现单|净额 0|手续费 0/);
});

test('related finance-document navigation retains its entry and a source origin with exact return filters',async t=>{
  const sourceQuery={scope:'synthetic-user',from:'2026-06-29',to:'2026-06-30',period:'1',q:'SYNTHETIC-LOG-11437',entry:entry.id};
  const path=`${association.path}?entry=associated-entry`;
  const ui=await mount(t,{mode:'document',query:sourceQuery,related:[{ref:association.documentRef,label:'关联提现申请',path}]});
  await waitFor(()=>button('关联提现申请',ui.host));await click(button('关联提现申请',ui.host));
  const target=new URL(ui.opened.at(-1)[0],browser.location.href);assert.equal(target.pathname,association.path);assert.equal(target.searchParams.get('entry'),'associated-entry');assert.ok(target.searchParams.get('origin'),'the related path uses the common finance origin registry');
  for(const [key,value]of Object.entries(sourceQuery).filter(([key])=>key!=='entry'))assert.equal(target.searchParams.get(key),value,key);
  ui.props.tab={...ui.props.tab,id:'linked-finance-record',path:target.pathname,query:Object.fromEntries(target.searchParams)};await ui.render();
  await waitFor(()=>ui.host.querySelector('#finance-title')?.textContent==='提现申请记录');await click(button('返回来源',ui.host));
  const back=new URL(ui.opened.at(-1)[0],browser.location.href);assert.equal(decodeURIComponent(back.pathname.slice('/finance/documents/'.length)),debit.ref);
  for(const [key,value]of Object.entries(sourceQuery))assert.equal(back.searchParams.get(key),value,`restored ${key}`);
});

test('user-finance table shares the same historical facts while the current wallet stays unchanged',async t=>{
  const permissions=['finance.read','finance.document.read','order.read'],opened=[],adapter={snapshot:{authenticated:true,adminUserId:`user-history-${++serial}`,session:{id:`user-history-session-${serial}`,locked:false},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},permissions},has:code=>permissions.includes(code),
    finance:async()=>({documents:[debit,application]}),consumption:async()=>({knowledge:'UNKNOWN',amountCents:null,knownAmountCents:'0',components:{haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null},total:0,unknownCount:0,page:1,pageSize:20,items:[]})};
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);await act(async()=>root.render(createElement(UserDetailFinance,{adapter,user:{id:'synthetic-user',name:'用户一',walletSummary:{state:'ready',amountCents:'15000'}},refreshNonce:0,onOpenPath:(...args)=>opened.push(args)})));t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await waitFor(()=>host.querySelector('[aria-label="用户资金单据"]')?.textContent.includes('提现申请扣款'));
  assert.match(host.textContent,/150\.00 元/);const table=host.querySelector('[aria-label="用户资金单据"]');assert.match(table.textContent,/原流水号 SYNTHETIC-LOG-11437/);assert.match(table.textContent,/历史变动 −734\.00 元/);assert.doesNotMatch(table.textContent,/用户可用 −734/);
  const applicationRow=table.querySelectorAll('tbody tr')[1];assert.match(applicationRow.textContent,/原申请 734\.00 元/);assert.doesNotMatch(applicationRow.textContent,/历史变动/,'the application is not presented as another wallet debit');
  await click(table.querySelector('[data-historical-association] button'));const target=new URL(opened.at(-1)[0],browser.location.href);assert.equal(target.pathname,association.path);assert.ok(target.searchParams.get('origin'));
});
