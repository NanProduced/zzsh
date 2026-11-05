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
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(rootPath,'src'),'@brand':path.resolve(rootPath,'../../assets/brand')}},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
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

test('lookup explains certified grouping and independently visible unverified records',async t=>{
  const ui=await mount(t);await waitFor(()=>ui.host.textContent.includes('SYNTHETIC-LOG-11437'));
  const table=ui.host.querySelector('.finance-lookup-table'),firstRow=table.querySelector('tbody tr');assert.equal(table.getAttribute('role'),'table');assert.equal(table.getAttribute('aria-label'),'业务与历史记录');assert([...table.querySelectorAll('thead th')].every(cell=>cell.getAttribute('scope')==='col'));assert.deepEqual([...firstRow.querySelectorAll('[data-label]')].map(cell=>cell.getAttribute('data-label')),['相关主体','业务进度 / 状态','金额','时间']);
  assert.match(ui.host.textContent,/提现申请扣款/);assert.match(ui.host.textContent,/提现申请记录/);assert.match(ui.host.textContent,/历史余额变动/);assert.match(ui.host.textContent,/金额不应重复相加/);assert.match(ui.host.textContent,/2 份记录/);assert.doesNotMatch(ui.host.textContent,/2 次提现|1,468\.00/);
  assert.match(ui.host.textContent,/按已核证关联合并为一笔业务/);assert.match(ui.host.textContent,/未核证或无关联查看权限的记录独立列出/);assert.match(ui.host.textContent,/原流水号仍可查/);assert.doesNotMatch(ui.host.textContent,/历史余额变动分别列示/);
  assert.match(ui.host.textContent,/原流水号 SYNTHETIC-LOG-11437/);assert.match(ui.host.textContent,/关联提现单：20260629192242694162/);
  assert.match(ui.host.textContent,/历史变动 −734\.00 元/);assert.doesNotMatch(ui.host.textContent,/用户可用.*−734/);
  await click(button('历史记录详情',ui.host));assert.match(ui.host.textContent,/已核证的提现申请与余额流水属于同一笔业务，金额不重复汇总/);
  await click(ui.host.querySelector('[data-historical-association] button'));
  const target=new URL(ui.opened.at(-1)[0],browser.location.href);assert.equal(target.pathname,association.path);assert.ok(target.searchParams.get('origin'));assert.ok(ui.requests.every(value=>value.startsWith('/api/bff/admin/finance/')));
});

test('unresolved withdrawal detail does not claim a verified relationship',async t=>{
  const unknown={...historical,association:{...association,state:'UNRESOLVED',kind:'UNKNOWN',number:null,documentRef:null,path:null}};
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await act(async()=>root.render(createElement(HistoricalFinanceDetail,{historical:unknown,recordKind:'WITHDRAWAL',orderRead:true,documentRead:true,onOpenPath(){},expanded:true})));await settle();
  assert.match(host.textContent,/关联未记录/);assert.match(host.textContent,/历史金额不改变当前钱包/);assert.doesNotMatch(host.textContent,/已核证的提现申请与余额流水/);
});

test('document shows raw fee, net and old balance separately from channels and keeps the original deep link',async t=>{
  const ui=await mount(t,{mode:'document'});await waitFor(()=>ui.host.querySelector('[data-historical-finance]')?.textContent.includes('手续费'));
  const facts=ui.host.querySelector('[data-historical-finance]');
  for(const label of ['原流水号','原金额','变动后余额（旧）','手续费','净额'])assert.ok(facts.textContent.includes(label),label);
  for(const value of ['SYNTHETIC-LOG-11437','734.00 元','502.00 元','1.00 元','733.00 元'])assert.ok(facts.textContent.includes(value),value);
  assert.match(facts.textContent,/旧平台记为成功/);assert.match(facts.textContent,/渠道未核/);assert.match(ui.host.textContent,/不改变当前钱包/);assert.doesNotMatch(ui.host.textContent,/渠道已到账|已成功到账/);
  await click([...ui.host.querySelectorAll('button')].find(button=>button.textContent.startsWith('相关历史记录')));
  const original=ui.host.querySelector('[data-finance-focus="history:synthetic-log"]');await click(original);
  const target=new URL(ui.opened.at(-1)[0],browser.location.href);assert.equal(decodeURIComponent(target.pathname.slice('/finance/documents/'.length)),debit.ref);assert.equal(target.searchParams.get('entry'),entry.id);
  assert.equal(ui.opened.at(-1)[1],'提现申请扣款 · SYNTHETIC-LOG-11437','workspace titles retain the specific record alongside its purpose');
});

test('payment history hides unrelated empty withdrawal and distribution fields but keeps applicable evidence',async t=>{
  const paymentHistory={...historical,changeType:null,purposeCode:'PAYMENT_RECORD',purposeLabel:'旧平台付款记录',originalLogNumber:null,balanceAfterCents:null,feeCents:null,netCents:null,originalStatus:'0',originalStatusLabel:'旧平台未付款',association:{...association,state:'UNRESOLVED',kind:'UNKNOWN',number:null,documentRef:null,path:null}};
  const paymentDoc={...debit,ref:'HISTORY_PAYMENT:payment',kind:'PAYMENT',historical:paymentHistory};
  const evidence={originalReference:'123',originalStatus:'0',originalOrderType:'1',originalNumber:'OLD-PAY',originalRatio:null,originalLevel:null,originalBankName:null,originalRecipientMask:null,originalMobileMask:null,originalDestinationMask:null,originalOperatorSourceId:null,originalNetCents:null,originalFeeCents:null,historicalBalanceAfterCents:null,dueAt:null,policyVersion:null,channelArrival:'UNKNOWN'};
  const ui=await mount(t,{mode:'document',doc:paymentDoc,lines:[{...entry,documentRef:paymentDoc.ref,kind:'PAYMENT',historical:paymentHistory}],evidence});await waitFor(()=>ui.host.textContent.includes('旧平台付款记录'));
  const facts=ui.host.querySelector('[data-historical-finance]');assert.match(facts.textContent,/原金额/);assert.doesNotMatch(facts.textContent,/原流水号|变动后余额|手续费|净额/);
  await click(button('原始来源字段',ui.host));assert.match(ui.host.textContent,/原编号[\s\S]*OLD-PAY/);assert.match(ui.host.textContent,/渠道到账[\s\S]*未取得依据/);assert.doesNotMatch(ui.host.textContent,/原分销比例|原分销层级|旧收款银行|原净额|原手续费|历史记录后余额|计划转可用时间/);
  await click([...ui.host.querySelectorAll('button')].find(b=>b.textContent.startsWith('资金来源与版本')));assert.match(ui.host.textContent,/历史记录未纳入期初覆盖/);assert.doesNotMatch(ui.host.textContent,/历史未记录，未入当前余额/);
});

test('old payment attempts and commission business records show source amounts, not balance movement',async t=>{
  const payment=(status)=>({...debit,ref:`HISTORY_PAYMENT:payment-${status}`,kind:'PAYMENT',number:`PAY-${status}`,amounts:[{bucket:'AVAILABLE',knownNetCents:'-66450',unknownCount:0}],historical:{...historical,amountSemantics:'BUSINESS_RECORD',changeType:null,purposeCode:'PAYMENT_RECORD',purposeLabel:'旧平台付款记录',originalLogNumber:null,recordedAmountCents:'66450',originalStatus:status,originalStatusLabel:status==='0'?'旧平台未付款':'旧平台已付款',association:{...association,state:'UNRESOLVED',kind:'UNKNOWN',number:null,documentRef:null,path:null}}});
  const distribution={...debit,ref:'HISTORY_DISTRIBUTION:earning',kind:'DISTRIBUTION',number:'DIST-1',amounts:[{bucket:'PENDING_EARNINGS',knownNetCents:'1776',unknownCount:0}],historical:{...historical,amountSemantics:'BUSINESS_RECORD',changeType:null,purposeCode:'DISTRIBUTION_INCOME',purposeLabel:'分销收益记录',originalLogNumber:null,recordedAmountCents:'1776'}};
  const balance={...debit,ref:'HISTORY_EARNINGS:balance',historical:{...historical,amountSemantics:'BALANCE_RECORD',purposeCode:'DISTRIBUTION_INCOME',purposeLabel:'分销收入',recordedAmountCents:'73400'}};
  const ui=await mount(t,{documents:[payment('0'),payment('1'),distribution,balance]});await waitFor(()=>ui.host.textContent.includes('PAY-0'));
  const rows=[...ui.host.querySelectorAll('tbody tr')];
  for(const n of ['PAY-0','PAY-1']){const row=rows.find(r=>r.textContent.includes(n));assert.match(row.textContent,/记录金额 664\.50 元/);assert.doesNotMatch(row.textContent,/历史变动|−664\.50/);}
  assert.match(rows.find(r=>r.textContent.includes('DIST-1')).textContent,/记录金额 17\.76 元/);
  assert.match(rows.find(r=>r.textContent.includes('SYNTHETIC-LOG-11437')).textContent,/历史变动 −734\.00 元/);
});

test('legacy order root with a recorded payment does not acquire a second unknown business amount',async t=>{
  const original={...debit,ref:'LEGACY_ORDER:old-order',number:'OLD-ORDER',kind:'SETTLEMENT',state:'HISTORICAL_ORDER_RECORDED',requestedAmountCents:null,amounts:[],historical:undefined,
    orderLifecycle:{origin:'LEGACY_MYSQL',orderStatus:'COMPLETED',payment:{state:'LEGACY_RECORDED',amountCents:'66450',confirmedAt:null,hasReviewPayment:null},postingState:'LEGACY_OBSERVATION'}};
  const ui=await mount(t,{documents:[original]});await waitFor(()=>ui.host.textContent.includes('旧单付款原记'));
  const row=ui.host.querySelector('tbody tr');assert.match(row.textContent,/664\.50 元/);assert.match(row.textContent,/旧单付款原记/);assert.doesNotMatch(row.textContent,/记录金额 未记录/);
});

test('an unverified source never becomes a confirmed historical balance change',async t=>{
  const suspect={...historical,amountSemantics:'UNVERIFIED',purposeCode:'WITHDRAWAL_DEBIT',purposeLabel:'提现申请扣款'};
  const doc={...debit,ref:'HISTORY_EARNINGS:suspect',historical:suspect};
  assert.equal(formats.financeIsHistoricalBalance(doc),false);assert.equal(formats.historicalFinanceAmount(doc,'-73400'),'记录金额待核实');assert.match(formats.financeBusinessLabel(doc),/来源待核/);
  const line={...entry,documentRef:doc.ref,historical:suspect};
  const ui=await mount(t,{mode:'document',doc,lines:[line]});await waitFor(()=>ui.host.textContent.includes('来源待核'));
  assert.doesNotMatch(ui.host.textContent,/余额扣款记录/);await click([...ui.host.querySelectorAll('button')].find(b=>b.textContent.startsWith('相关历史记录')));
  assert.match(ui.host.textContent,/记录金额待核实/);assert.match(ui.host.textContent,/余额变动依据待核/);assert.doesNotMatch(ui.host.textContent,/历史变动 −734\.00/);
  let copied='';t.mock.method(browser.navigator.clipboard,'writeText',async value=>{copied=value;});await click(button('复制摘要',ui.host));assert.match(copied,/记录金额待核实/);assert.match(copied,/原金额（待核）：734\.00 元/);assert.doesNotMatch(copied,/历史变动 −734\.00/);
});

test('unverified legacy business observations do not present the original amount or status as confirmed',async t=>{
  const base={...historical,amountSemantics:'UNVERIFIED',originalLogNumber:null,changeType:null,recordedAmountCents:'66450',originalStatusLabel:'旧平台记为成功'};
  const rows=[
    {...debit,ref:'HISTORY_PAYMENT:bad',kind:'PAYMENT',number:'BAD-PAY',requestedAmountCents:null,historical:{...base,purposeCode:'PAYMENT_RECORD',purposeLabel:'旧平台付款记录'}},
    {...debit,ref:'HISTORY_DISTRIBUTION:bad',kind:'DISTRIBUTION',number:'BAD-DIST',requestedAmountCents:null,historical:{...base,purposeCode:'DISTRIBUTION_INCOME',purposeLabel:'分销收益记录'}},
    {...application,ref:'HISTORY_WITHDRAWAL:bad',number:'BAD-APPLY',requestedAmountCents:'66450',historical:{...base,purposeCode:'WITHDRAWAL_APPLICATION',purposeLabel:'提现申请记录'}}
  ];
  const ui=await mount(t,{documents:rows});await waitFor(()=>ui.host.textContent.includes('BAD-PAY'));
  for(const row of ui.host.querySelectorAll('.finance-lookup-table tbody tr')){assert.match(row.textContent,/记录金额待核实/);assert.match(row.textContent,/来源待核/);assert.doesNotMatch(row.textContent,/664\.50 元|旧平台记为成功/);}
  const app=rows[2],line={...entry,id:'history:bad-apply',documentRef:app.ref,kind:'WITHDRAWAL',sourceEntity:'la_withdraw_apply',historical:app.historical};
  const detail=await mount(t,{mode:'document',doc:app,lines:[line]});await waitFor(()=>detail.host.textContent.includes('记录金额待核实'));
  assert.match(detail.host.querySelector('.finance-document-result').textContent,/记录金额待核实/);assert.doesNotMatch(detail.host.querySelector('.finance-document-result').textContent,/664\.50/);assert.match(detail.host.textContent,/原金额（待核）/);
});

test('old payment detail and copied summary never present a requested amount as a balance deduction',async t=>{
  const paymentHistory={...historical,amountSemantics:'BUSINESS_RECORD',changeType:null,purposeCode:'PAYMENT_RECORD',purposeLabel:'旧平台付款记录',originalLogNumber:null,recordedAmountCents:'66450',originalStatus:'0',originalStatusLabel:'旧平台未付款',association:{...association,state:'UNRESOLVED',kind:'UNKNOWN',number:null,documentRef:null,path:null}};
  const doc={...debit,ref:'HISTORY_PAYMENT:payment',kind:'PAYMENT',historical:paymentHistory};
  const line={...entry,id:'history:payment',documentRef:doc.ref,kind:'PAYMENT',deltaCents:'-66450',sourceEntity:'la_pay_order',historical:paymentHistory};
  const ui=await mount(t,{mode:'document',doc,lines:[line]});await waitFor(()=>ui.host.textContent.includes('旧平台付款记录'));
  assert.match(ui.host.textContent,/1 条历史记录/);assert.doesNotMatch(ui.host.textContent,/1 条分录/);
  await click([...ui.host.querySelectorAll('button')].find(b=>b.textContent.startsWith('相关历史记录')));
  assert.match(ui.host.textContent,/记录金额 664\.50 元/);assert.match(ui.host.textContent,/不作为余额变动/);assert.doesNotMatch(ui.host.textContent,/历史变动 −664\.50|减少/);
  let copied='';t.mock.method(browser.navigator.clipboard,'writeText',async value=>{copied=value;});await click(button('复制摘要',ui.host));
  assert.match(copied,/记录金额 664\.50 元/);assert.doesNotMatch(copied,/历史变动|−664\.50/);
});

test('finance detail only offers the order channel shortcut for a native order',async t=>{
  const paymentHistory={...historical,amountSemantics:'BUSINESS_RECORD',changeType:null,purposeCode:'PAYMENT_RECORD',purposeLabel:'旧平台付款记录',originalLogNumber:null,association:{...association,state:'MATCHED',kind:'ORDER',documentRef:'LEGACY_ORDER:old',number:'OLD-ORDER',path:'/orders/old'}};
  const old={...debit,ref:'HISTORY_PAYMENT:old',kind:'PAYMENT',historical:paymentHistory};
  const oldUi=await mount(t,{mode:'document',doc:old,lines:[{...entry,documentRef:old.ref,kind:'PAYMENT',historical:paymentHistory}],related:[{ref:'LEGACY_ORDER:old',label:'OLD-ORDER',path:'/orders/old'}]});await waitFor(()=>oldUi.host.textContent.includes('旧平台付款记录'));
  assert.match(oldUi.host.textContent,/旧渠道依据尚未接入/);assert.equal(button('在汇聚对账查看本单',oldUi.host),undefined);
  const native={...debit,ref:'PAYMENT_REQUEST:native',kind:'PAYMENT',state:'READY',historical:undefined};
  const nativeUi=await mount(t,{mode:'document',doc:native,lines:[],related:[{ref:'ORDER:native',label:'本站订单',path:'/orders/native'}]});await waitFor(()=>Boolean(button('在汇聚对账查看本单',nativeUi.host)));
  await click(button('在汇聚对账查看本单',nativeUi.host));const target=new URL(nativeUi.opened.at(-1)[0],browser.location.href);assert.equal(target.pathname,'/finance/channels');assert.equal(target.searchParams.get('fromOrderId'),'native');
});

test('an applicable but unknown historical payment status remains visible',()=>{
  const payment={...historical,changeType:null,purposeCode:'PAYMENT_RECORD',originalLogNumber:null,balanceAfterCents:null,feeCents:null,netCents:null,originalStatus:null};
  assert.ok(formats.historicalFinanceFacts(payment).some(([label,value])=>label==='原状态码'&&value==='未取得'));
});

test('unknown legacy purpose does not hide potentially applicable empty fields',async t=>{
  const unknown={...historical,changeType:'9999',purposeCode:'UNKNOWN',purposeLabel:'用途待核',feeCents:null,netCents:null};
  const doc={...debit,ref:'HISTORY_EARNINGS:unknown',historical:unknown};
  const ui=await mount(t,{mode:'document',doc,lines:[{...entry,documentRef:doc.ref,historical:unknown}],evidence:{originalRatio:null,originalBankName:null}});
  await waitFor(()=>ui.host.textContent.includes('用途待核'));await click(button('原始来源字段',ui.host));assert.match(ui.host.textContent,/原分销比例[\s\S]*未取得/);assert.match(ui.host.textContent,/旧收款银行[\s\S]*未取得/);
  assert.ok(formats.historicalFinanceFacts(unknown).some(([name,value])=>name==='手续费'&&value==='未记录'));
});

test('withdrawal evidence keeps applicable unknown fields instead of turning them into zero',async t=>{
  const pending={...application,ref:'HISTORY_WITHDRAWAL:missing',historical:{...application.historical,feeCents:null,netCents:null}};
  const ui=await mount(t,{mode:'document',doc:pending,lines:[{...entry,documentRef:pending.ref,kind:'WITHDRAWAL',historical:pending.historical}],evidence:{originalBankName:null,originalFeeCents:null,originalNetCents:null,originalRatio:null}});
  await waitFor(()=>ui.host.textContent.includes('提现申请记录'));await click(button('原始来源字段',ui.host));
  assert.match(ui.host.textContent,/旧收款银行[\s\S]*未取得/);assert.match(ui.host.textContent,/原手续费[\s\S]*未记录/);assert.doesNotMatch(ui.host.textContent,/原分销比例|0\.00 元/);
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
  const unknown=state=>({...debit,ref:`HISTORY_EARNINGS:${state}`,historical:{...historical,changeType:'9999',purposeCode:'UNKNOWN',purposeLabel:'用途未记录',recordedAmountCents:null,balanceAfterCents:'-10',feeCents:null,netCents:null,association:{...association,state,number:'UNPROVED_NUMBER',documentRef:'UNPROVED_REF',path:'/orders/UNPROVED_ID'}}});
  const ui=await mount(t,{documents:[unknown('UNRESOLVED'),unknown('AMBIGUOUS')]});await waitFor(()=>ui.host.textContent.includes('用途未记录'));
  assert.match(ui.host.textContent,/关联未记录/);assert.match(ui.host.textContent,/多条关联候选/);assert.doesNotMatch(ui.host.textContent,/UNPROVED_/);assert.equal(ui.host.querySelector('[data-historical-association] button'),null);
  await click(button('历史记录详情',ui.host));assert.match(ui.host.textContent,/9999/);assert.match(ui.host.textContent,/−0\.10 元/);assert.match(ui.host.textContent,/未记录/);
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
  for(const [index,node]of [...ui.host.querySelectorAll('[data-historical-association] button')].entries()){await click(node);const path=new URL(ui.opened.at(-1)[0],'http://fixture.invalid');assert.equal(path.pathname,`/orders/stable-${index}`);assert.ok(path.searchParams.get('financeOrigin'));}
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
  const payment={...debit,ref:'HISTORY_PAYMENT:user-payment',kind:'PAYMENT',number:'USER-PAYMENT',amounts:[{bucket:'AVAILABLE',knownNetCents:'-66450',unknownCount:0}],historical:{...historical,amountSemantics:'BUSINESS_RECORD',purposeCode:'PAYMENT_RECORD',purposeLabel:'旧平台付款记录',originalLogNumber:null,recordedAmountCents:'66450'}};
  const suspect={...application,ref:'HISTORY_WITHDRAWAL:user-unverified',requestedAmountCents:'66450',historical:{...application.historical,amountSemantics:'UNVERIFIED',recordedAmountCents:'66450'}};
  const permissions=['finance.read','finance.document.read','order.read'],opened=[],adapter={snapshot:{authenticated:true,adminUserId:`user-history-${++serial}`,session:{id:`user-history-session-${serial}`,locked:false},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},permissions},has:code=>permissions.includes(code),
    finance:async()=>({documents:[debit,application,payment,suspect]}),consumption:async()=>({knowledge:'UNKNOWN',amountCents:null,knownAmountCents:'0',components:{haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null},total:0,unknownCount:0,page:1,pageSize:20,items:[]})};
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);await act(async()=>root.render(createElement(UserDetailFinance,{adapter,user:{id:'synthetic-user',name:'用户一',walletSummary:{state:'ready',amountCents:'15000'}},refreshNonce:0,onOpenPath:(...args)=>opened.push(args)})));t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  await waitFor(()=>host.querySelector('[aria-label="用户资金单据"]')?.textContent.includes('提现申请扣款'));
  assert.match(host.textContent,/150\.00 元/);const table=host.querySelector('[aria-label="用户资金单据"]');assert.match(table.textContent,/原流水号 SYNTHETIC-LOG-11437/);assert.match(table.textContent,/历史变动 −734\.00 元/);assert.doesNotMatch(table.textContent,/用户可用 −734/);
  const applicationRow=table.querySelectorAll('tbody tr')[1];assert.match(applicationRow.textContent,/原申请 734\.00 元/);assert.doesNotMatch(applicationRow.textContent,/历史变动/,'the application is not presented as another wallet debit');
  const paymentRow=table.querySelectorAll('tbody tr')[2];assert.match(paymentRow.textContent,/记录金额 664\.50 元/);assert.doesNotMatch(paymentRow.textContent,/历史变动|−664\.50/);
  const suspectRow=table.querySelectorAll('tbody tr')[3];assert.match(suspectRow.textContent,/记录金额待核实/);assert.doesNotMatch(suspectRow.textContent,/原申请 664\.50/);
  await click(table.querySelector('[data-historical-association] button'));const target=new URL(opened.at(-1)[0],browser.location.href);assert.equal(target.pathname,association.path);assert.ok(target.searchParams.get('origin'));
});

test('withdrawal application points to its balance debit, while debit points to the application',async t=>{
 const reverse={...historical,changeType:null,purposeCode:'WITHDRAWAL_APPLICATION',purposeLabel:'提现申请记录',association:{...association,documentRef:debit.ref,number:'SYNTHETIC-LOG-11437',path:'/finance/documents/HISTORY_EARNINGS%3Asynthetic-log'}};
 const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host),opened=[];t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 await act(async()=>root.render(createElement(HistoricalFinanceDetail,{historical:reverse,recordKind:'WITHDRAWAL',orderRead:true,documentRead:true,onOpenPath:(...args)=>opened.push(args)})));await settle();
 assert.match(host.textContent,/关联余额扣款流水：SYNTHETIC-LOG-11437/);assert.doesNotMatch(host.textContent,/关联提现单：/);await click(host.querySelector('[data-historical-association] button'));assert.match(opened[0][0],/HISTORY_EARNINGS/);
});
