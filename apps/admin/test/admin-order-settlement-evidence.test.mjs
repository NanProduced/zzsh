import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {createOfflineAdminSource} from './offline-admin-source.mjs';

const response=(body,status=200)=>({ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>body});
const known=cents=>({knowledge:'KNOWN',cents,reasonCodes:[]}),unknown=()=>({knowledge:'UNKNOWN',cents:null,reasonCodes:['ORIGINAL_BASIS_UNAVAILABLE']});
const native={id:'order_native',displayNo:'ORDER-NATIVE',status:'PAID',title:'订单原快照',accountId:'account_1',accountDisplayNo:'A-001',gameId:'delta',ownerUserId:'owner',renterUserId:'renter',ownerName:'号主',renterName:'租客',createdAt:'2026-10-01T00:00:00Z',paidAt:null,payment:{state:'RECORDED_PAID',recordedAt:null,recordedAmount:{currency:'CNY',unit:'yuan',amount:'159.08',scale:2}},amounts:{totalDue:{currency:'CNY',unit:'yuan',amount:'159.08',scale:2},rental:null,deposit:null},source:{origin:'NATIVE'}};
const facts=(ref='ORDER:order_native',extra={})=>({schema:'admin-order-settlement-evidence.v1',documentRef:ref,readiness:'READY',posting:{state:'POSTED',ref:'posting_1',postedAt:'2026-10-01T02:00:00Z'},captured:known('15908'),ownerNet:known('9000'),refundPayable:known('0'),refunded:unknown(),historicalRefund:unknown(),refundDueAt:null,channel:{state:'UNKNOWN',reference:null},dutyRefs:[],reasonCodes:[],...extra});
const finance=(url,orderSettlement=facts(),extra={})=>{const q=new URL(String(url),'http://localhost').searchParams;return{contractVersion:'admin-finance.read.v1',applied:{scope:q.get('scope')??'ALL',from:q.get('from'),to:q.get('to'),period:q.get('period')==='1',bucket:'ALL',kind:'ALL',state:'ALL',q:''},snapshot:'snapshot-1',contextKey:'context-1',snapshotVersion:'version-1',asOf:'2026-10-01T02:00:00Z',document:{ref:orderSettlement.documentRef,number:'ORDER-NATIVE',kind:'REFUND',state:'REFUND_PAYABLE_RECORDED',occurredAt:null,requestedAmountCents:null,subjects:[],entryCount:0,amounts:[]},entries:[],orderSettlement,...extra};};
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
async function until(predicate){for(let i=0;i<120;i++){if(predicate())return;await settle();}throw Error('Settlement evidence condition timed out');}
async function setup(t,permissions=['order.read','finance.read']){
 const browser=new Window({url:'http://127.0.0.1:4311/orders/order_native'});
 Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,MutationObserver:browser.MutationObserver,ResizeObserver:browser.ResizeObserver,CSS:browser.CSS,FormData:browser.FormData,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);
 const {createRoot}=await import('react-dom/client'),tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),source=await createOfflineAdminSource({root:tree});
 const chain=await source.ssrLoadModule('/apps/admin/src/views/admin-order-chain-view.tsx'),funds=await source.ssrLoadModule('/apps/admin/src/views/admin-finance-view.tsx');
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node),opened=[];
 const snapshot={authenticated:true,adminUserId:'settlement-reader',user:{name:'财务读取员',username:'READ',twoFactorEnabled:true},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},session:{id:'settlement-session',locked:false,pinConfigured:true,createdAt:null,expiresAt:null},permissions};
 const props={snapshot,objectOnly:true,initialOrderId:native.id,onOpenPath:(...args)=>opened.push(args),onQueryChange:()=>{},refreshNonce:0};
 const render=()=>act(async()=>root.render(createElement(chain.AdminOrderChainView,props)));
 t.after(async()=>{funds.clearFinanceContexts();await act(async()=>root.unmount());await source.close();browser.happyDOM.abort();});
 return{node,root,source,props,render,opened,funds};
}
const button=(node,text)=>[...node.querySelectorAll('button')].find(b=>b.textContent.trim()===text);

test('order payment review is not presented as absent and channel copy follows its source',async t=>{
 const ui=await setup(t);const {AdminOrderSettlementEvidence,orderSettlementSummary}=await ui.source.ssrLoadModule('/apps/admin/src/views/admin-order-settlement-evidence.tsx');
 const business={payment:{state:'REVIEW_REQUIRED',amount:unknown(),occurredAt:null},settlementState:'UNKNOWN',legacyCompletedAmounts:null,paymentAttempts:[],refundOrders:[],reasonCodes:[]};
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence:facts(undefined,{business})})));
 assert.match(ui.node.textContent,/异常收款需复核/);assert.match(ui.node.textContent,/金额待核实/);assert.doesNotMatch(ui.node.textContent,/异常收款未记录|旧平台渠道到账情况/);assert.match(ui.node.textContent,/渠道到账情况未取得/);assert.match(orderSettlementSummary(facts(undefined,{business})).join('\n'),/异常收款需复核 · 金额待核实/);
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence:facts('LEGACY_ORDER:old',{business})})));
 assert.match(ui.node.textContent,/旧平台渠道到账情况未取得/);assert.doesNotMatch(ui.node.textContent,/不影响到账结论/);
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence:facts('LEGACY_ORDER:old',{posting:{state:'NOT_POSTED',ref:null,postedAt:null},business}),paymentState:'RECORDED_UNPAID'})));
 assert.match(ui.node.textContent,/旧平台记录未付款，渠道情况未取得/);assert.doesNotMatch(ui.node.textContent,/本站未记录付款/);
 await act(async()=>button(ui.node,'展开缺失清单').click());const channel=[...ui.node.querySelectorAll('dl > div')].find(row=>row.querySelector('dt')?.textContent==='渠道到账');assert.equal(channel.querySelector('dd').textContent,'未取得依据');
});

test('one legacy source refund is displayed once without hiding distinct refund documents',async t=>{
 const ui=await setup(t);const {AdminOrderSettlementEvidence,orderSettlementSummary}=await ui.source.ssrLoadModule('/apps/admin/src/views/admin-order-settlement-evidence.tsx');
 const refund={documentRef:'HISTORY_REFUND:separate',number:'separate-refund',kind:'REFUND',source:'LEGACY_MYSQL',state:'RECORDED_SUCCESS',amountCents:'1080',occurredAt:'2026-10-01T03:00:00Z',channelArrival:'UNKNOWN'};
 const business={payment:{state:'LEGACY_RECORDED_PAID',amount:known('7680'),occurredAt:null},settlementState:'LEGACY_RECORDED_COMPLETE',legacyCompletedAmounts:{ownerEarnings:known('6000'),refundAmount:known('1080')},paymentAttempts:[],refundOrders:[refund],reasonCodes:[]};
 const evidence=facts('LEGACY_ORDER:old',{posting:{state:'UNKNOWN',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:unknown(),historicalRefund:known('1080'),business});
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence})));
 assert.equal((ui.node.textContent.match(/10\.80 元/g)??[]).length,1);assert.match(ui.node.textContent,/旧单退款金额原记/);assert.doesNotMatch(ui.node.textContent,/历史应退记录/);
 assert.equal((orderSettlementSummary(evidence).join('\n').match(/10\.80 元/g)??[]).length,1);
 await act(async()=>[...ui.node.querySelectorAll('button')].find(b=>b.textContent.includes('退款单据')).click());assert.match(ui.node.textContent,/separate-refund/);assert.equal((ui.node.textContent.match(/10\.80 元/g)??[]).length,2);
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence:{...evidence,historicalRefund:known('1200')}})));
 assert.match(ui.node.textContent,/旧单退款金额原记[\s\S]*10\.80 元/);assert.match(ui.node.textContent,/历史应退记录[\s\S]*12\.00 元/);assert.match(ui.node.textContent,/旧订单退款原记金额不一致/);
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence:{...evidence,historicalRefund:unknown()}})));assert.match(ui.node.textContent,/旧订单退款原记待核对/);assert.doesNotMatch(ui.node.textContent,/旧订单退款原记金额不一致/);
});

test('settlement explanations are readable and deduplicated while raw codes remain in technical trace',async t=>{
 const ui=await setup(t);const {AdminOrderSettlementEvidence}=await ui.source.ssrLoadModule('/apps/admin/src/views/admin-order-settlement-evidence.tsx');
 const evidence=facts('LEGACY_ORDER:old',{reasonCodes:['HISTORICAL_REFUND_NOT_CURRENT_RESPONSIBILITY','ORIGINAL_CAPTURED_EVIDENCE_UNAVAILABLE','SETTLEMENT_CAPTURED_UNAVAILABLE','FUTURE_UNKNOWN_A','FUTURE_UNKNOWN_B']});
 await act(async()=>ui.root.render(createElement(AdminOrderSettlementEvidence,{evidence})));await act(async()=>button(ui.node,'依据与说明').click());
 assert.match(ui.node.textContent,/历史退款原记不等于当前应退责任/);assert.equal((ui.node.textContent.match(/原入账基数依据未取得/g)??[]).length,1);assert.equal((ui.node.textContent.match(/部分原始资金依据尚未确认/g)??[]).length,1);assert.doesNotMatch(ui.node.textContent,/HISTORICAL_REFUND_NOT_CURRENT_RESPONSIBILITY|FUTURE_UNKNOWN_A/);
 await act(async()=>button(ui.node,'技术追溯').click());assert.match(ui.node.textContent,/HISTORICAL_REFUND_NOT_CURRENT_RESPONSIBILITY/);assert.match(ui.node.textContent,/FUTURE_UNKNOWN_A/);assert.match(ui.node.textContent,/FUTURE_UNKNOWN_B/);
});

test('ordinary order without financial permission makes no finance or controlled settlement request',async t=>{
 const calls=[];globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),method:init.method??'GET'});return response({order:native});};const ui=await setup(t,['order.read']);await ui.render();await until(()=>ui.node.textContent.includes(native.displayNo));await settle();
 ui.props.snapshot={...ui.props.snapshot,permissions:['order.read','finance.document.read']};await ui.render();await until(()=>ui.node.textContent.includes(native.displayNo));await settle();assert.equal(calls.filter(c=>c.url.includes('/finance/')||c.url.includes('/settlement')).length,0);assert(calls.every(c=>c.method==='GET'));assert.match(ui.node.textContent,/开租未记录/);
});
test('order body renders before financial evidence and a failed read never becomes no posting',async t=>{
 let finish;const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return String(url).includes('/finance/')?new Promise(resolve=>{finish=resolve;}):response({order:native});};const ui=await setup(t);await ui.render();await until(()=>!!finish&&ui.node.textContent.includes(native.displayNo));assert.match(ui.node.textContent,/正在读取资金依据/);assert(!calls.some(p=>p.includes('/settlement')));
 await act(async()=>finish(response({error:{code:'EVIDENCE_UNAVAILABLE',requestId:'req-settlement-503'}},503)));await until(()=>ui.node.textContent.includes('资金依据暂不可用'));assert.match(ui.node.textContent,/req-settlement-503/);assert.doesNotMatch(ui.node.textContent,/已证实无过账|已退款|已开租/);
});
test('source-qualified native evidence preserves exact zero and keeps refund and channel unknown',async t=>{
 const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return response(String(url).includes('/finance/')?finance(url):{order:native});};const ui=await setup(t);await ui.render();await until(()=>ui.node.textContent.includes('159.08 元'));
 const card=ui.node.querySelector('[data-order-settlement-evidence]');assert(card);assert.match(card.textContent,/号主结算净额/);assert.match(card.textContent,/90\.00 元/);assert.match(card.textContent,/0\.00 元/);assert.match(card.textContent,/已知事实/);assert.match(card.textContent,/渠道到账情况未取得/);assert.doesNotMatch(card.textContent,/旧平台未记录渠道信息/);await act(async()=>button(card,'尚未取得依据的金额').click());assert.match(card.textContent,/退款出款记录[\s\S]*未记录/);await act(async()=>button(card,'展开缺失清单').click());assert.match(card.textContent,/渠道到账[\s\S]*未取得依据/);assert.doesNotMatch(card.textContent,/历史应退记录|已退款|已到账/);assert.match(ui.node.textContent,/开租未记录/);assert.equal(calls.filter(p=>p.includes('/finance/')).length,1);assert(calls.some(p=>decodeURIComponent(p).includes('/finance/documents/ORDER:order_native')));ui.props.refreshNonce++;await ui.render();await until(()=>ui.node.textContent.includes('90.00 元'));assert.equal(calls.filter(p=>p.includes('/finance/')).length,2,'refresh waits for its current order body, rather than querying once for the stale body');
});
test('403 404 and 503 are distinct from a successfully proved NOT_POSTED fact',async t=>{
 const ui=await setup(t);let code=403;globalThis.fetch=async url=>response(String(url).includes('/finance/')?{error:{code:'EVIDENCE_UNAVAILABLE',requestId:'req-'+code}}:{order:native},String(url).includes('/finance/')?code:200);
 for(const [status,text]of[[403,'当前无权读取本单资金依据'],[404,'未找到当前范围内可读的资金单据'],[503,'资金依据暂不可用']]){code=status;ui.props.refreshNonce++;await ui.render();await until(()=>ui.node.textContent.includes(text));assert.doesNotMatch(ui.node.textContent,/已证实无过账/);}
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url,facts(undefined,{posting:{state:'NOT_POSTED',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:unknown()})):{order:native});ui.props.refreshNonce++;await ui.render();await until(()=>ui.node.textContent.includes('当前未查到过账记录'));assert.doesNotMatch(ui.node.querySelector('[data-order-settlement-evidence]').textContent,/0\.00 元/);
});
test('409 clears prior proof and a late financial response cannot survive order or permission changes',async t=>{
 const ui=await setup(t);let mode='ready',finish;globalThis.fetch=async url=>{if(String(url).includes('/finance/'))return mode==='slow'?new Promise(resolve=>{finish=resolve;}):mode==='conflict'?response({error:{code:'CONFLICT'}},409):response(finance(url));return response({order:{...native,id:ui.props.initialOrderId,displayNo:ui.props.initialOrderId==='order_next'?'NEXT-ORDER':native.displayNo}});};
 await ui.render();await until(()=>ui.node.textContent.includes('159.08 元'));mode='conflict';ui.props.refreshNonce++;await ui.render();await until(()=>ui.node.textContent.includes('资金依据已变化'));assert(!ui.node.textContent.includes('90.00 元'));
 mode='slow';ui.props.refreshNonce++;await ui.render();await until(()=>!!finish);const stale=finish;ui.props.initialOrderId='order_next';ui.props.snapshot={...ui.props.snapshot,permissions:['order.read']};await ui.render();await until(()=>ui.node.textContent.includes('NEXT-ORDER'));await act(async()=>stale(response(finance('/finance',facts()))));assert(!ui.node.textContent.includes('90.00 元'));assert(!ui.node.textContent.includes('ORDER-NATIVE'));
});
test('legacy refund observations and nullable duties never pretend channel success; verified duty has a reloadable return',async t=>{
 const legacy={...native,id:'legacy_order_1',displayNo:'LEGACY-ONE',source:{origin:'LEGACY'},legacyAmounts:{refund:{currency:'CNY',unit:'yuan',amount:'999.00',scale:2},refundChannelState:'UNKNOWN'}};
 const evidence=facts('LEGACY_ORDER:legacy_order_1',{posting:{state:'UNKNOWN',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:unknown(),historicalRefund:known('12345'),refunded:{knowledge:'UNKNOWN',cents:'99900',reasonCodes:[]},dutyRefs:[{documentRef:'LEGACY_DUTY:duty_1',kind:'RENTER_REFUND',state:'SETTLED',amount:known('0')},{documentRef:null,kind:'OWNER_CREDIT',state:'PENDING',amount:unknown()}]});
 const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return response(String(url).includes('/finance/')?finance(url,evidence):{order:legacy});};const ui=await setup(t);ui.props.initialOrderId=legacy.id;await ui.render();await until(()=>ui.node.textContent.includes('123.45 元'));
 const card=ui.node.querySelector('[data-order-settlement-evidence]');assert.match(card.textContent,/历史应退记录/);assert.doesNotMatch(card.textContent,/999\.00|已退款|已到账/);assert.match(card.textContent,/租客退款责任 · 原责任已终定/);assert.match(card.textContent,/号主收益责任 · 原责任待处理/);assert.match(card.textContent,/关联依据未记录/);assert.equal(card.querySelectorAll('button[data-duty-ref]').length,1);await act(async()=>card.querySelector('button[data-duty-ref]').click());const target=new URL(ui.opened.at(-1)[0],'http://localhost');assert.equal(decodeURIComponent(target.pathname),'/finance/documents/LEGACY_DUTY:duty_1');assert.equal(target.searchParams.get('financeReturn'),'/orders/legacy_order_1');assert.equal(ui.funds.financeOriginPath(target.searchParams.get('origin'),ui.props.snapshot),'/orders/legacy_order_1');assert(calls.some(p=>decodeURIComponent(p).includes('/finance/documents/LEGACY_ORDER:legacy_order_1')));
});
test('finance detail reuses the already fetched evidence, hides duplicate flat fields and preserves duty source filters',async t=>{
 const calls=[];const evidence=facts(undefined,{dutyRefs:[{documentRef:'LEGACY_DUTY:duty_2',kind:'COMMISSION',state:'MATURED',amount:unknown()}]});globalThis.fetch=async url=>{calls.push(String(url));return response(finance(url,evidence,{evidence:{postingCapturedCents:'15908',refundPayableCents:'0',refundPaidCents:null,refundDueAt:null,channelState:'UNKNOWN',postedAt:'2026-10-01T02:00:00Z'}}));};const ui=await setup(t,['order.read','finance.document.read']);const props={tab:{id:'finance-order',path:'/finance/documents/ORDER%3Aorder_native',kind:'finance-document',title:'订单资金',query:{from:'2026-10-01',to:'2026-10-02',q:'20261023123456789012'},closable:true},snapshot:ui.props.snapshot,onOpenPath:(...args)=>ui.opened.push(args),onQueryChange:()=>{},onRefresh:async()=>ui.props.snapshot,refreshNonce:0};await act(async()=>ui.root.render(createElement(ui.funds.AdminFinanceView,props)));await until(()=>ui.node.textContent.includes('159.08 元'));
 assert.equal(calls.length,1);assert.equal(ui.node.querySelectorAll('[data-order-settlement-evidence]').length,1);assert.equal(ui.node.textContent.split('159.08 元').length-1,1);assert.equal(ui.node.querySelector('.finance-fact-list')?.textContent.includes('退款应付')??false,false);await act(async()=>ui.node.querySelector('button[data-duty-ref]').click());const target=new URL(ui.opened.at(-1)[0],'http://localhost');assert.equal(decodeURIComponent(target.pathname),'/finance/documents/LEGACY_DUTY:duty_2');assert.equal(target.searchParams.get('from'),'2026-10-01');assert.equal(target.searchParams.get('q'),'20261023123456789012');assert(target.searchParams.get('financeReturn')?.startsWith('/finance/documents/'));
});
test('partial and absent projections preserve unknown, and a response bound to another root is discarded',async t=>{
 const ui=await setup(t);let mode='partial';globalThis.fetch=async url=>{if(!String(url).includes('/finance/'))return response({order:native});if(mode==='absent')return response(finance(url,facts(),{orderSettlement:undefined}));if(mode==='foreign')return response(finance(url,facts('LEGACY_ORDER:foreign',{ownerNet:known('87654321')})));return response(finance(url,facts(undefined,{readiness:'UNAVAILABLE',refundPayable:{knowledge:'UNKNOWN',cents:'0',reasonCodes:[]}})));};await ui.render();await until(()=>ui.node.textContent.includes('部分资金依据暂未就绪'));const card=ui.node.querySelector('[data-order-settlement-evidence]');assert.match(card.textContent,/90\.00 元/);await act(async()=>button(card,'尚未取得依据的金额').click());const refundRow=[...card.querySelectorAll('dl > div')].find(row=>row.querySelector('dt')?.textContent==='租客应退责任');assert.equal(refundRow.querySelector('dd').textContent,'未记录');
 mode='absent';ui.props.refreshNonce++;await ui.render();await until(()=>ui.node.textContent.includes('尚未提供受权订单资金依据'));assert(!ui.node.textContent.includes('90.00 元'));
 mode='foreign';ui.props.refreshNonce++;await ui.render();await until(()=>ui.node.textContent.includes('资金依据暂不可用'));assert.doesNotMatch(ui.node.textContent,/876,543\.21|foreign/);
});
test('finance to order to user retains a safe reloadable finance source alongside the order origin',async t=>{
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url):{order:native});const ui=await setup(t,['order.read','finance.read','user.directory.read']);const source='/finance?scope=renter&from=2026-10-01&to=2026-10-02&period=1';const token=ui.funds.registerFinanceOrigin(source,ui.funds.financeContextIdentity(ui.props.snapshot));ui.props.initialQuery={financeOrigin:token,financeReturn:source};await ui.render();await until(()=>ui.node.textContent.includes('159.08 元'));await act(async()=>button(ui.node,'租客').click());const target=new URL(ui.opened.at(-1)[0],'http://localhost');assert.equal(target.pathname,'/users/renter');assert.equal(target.searchParams.get('fromOrderId'),native.id);assert.equal(target.searchParams.get('financeReturn'),source);ui.funds.clearFinanceContexts();assert.equal(ui.funds.financeOriginPath(target.searchParams.get('financeOrigin'),ui.props.snapshot,target.searchParams.get('financeReturn')),source);
});
test('CHAIN unpaid cancelled order does not grow an unknown settlement wall and keeps channel not applicable',async t=>{
 const cancelled={...native,status:'CANCELLED',payment:{state:'RECORDED_UNPAID',recordedAt:null,recordedAmount:null}};
 const unknownFacts=facts(undefined,{posting:{state:'NOT_POSTED',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:unknown(),refunded:unknown(),refundDueAt:null});
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url,unknownFacts):{order:cancelled});
 const ui=await setup(t);ui.props.initialOrderId=cancelled.id;await ui.render();await until(()=>ui.node.textContent.includes('当前未查到过账记录'));
 const card=ui.node.querySelector('[data-order-settlement-evidence]');
 assert.match(card.textContent,/当前未查到过账记录/);
 assert.match(card.textContent,/本站未记录付款，渠道另核/);
 assert.doesNotMatch(card.textContent,/渠道到账[^]*不适用/);
 assert.equal(card.textContent.includes('退款责任到期'),false);
 assert.equal(card.textContent.includes('原入账基数'),false);
 assert.doesNotMatch(card.textContent,/0\.00 元/);
});
test('FINALIZED_ZERO is a zero responsibility finalization without ledger posting or channel payment',async t=>{
 const legacy={...native,id:'legacy_zero',displayNo:'LEGACY-ZERO',source:{origin:'LEGACY'}};
 const zero=facts('LEGACY_ORDER:legacy_zero',{posting:{state:'FINALIZED_ZERO',ref:'LEGACY_DUTY:duty_zero',postedAt:'2026-10-01T02:00:00Z'},captured:unknown(),ownerNet:known('0'),refundPayable:known('0'),refunded:unknown(),historicalRefund:known('0'),dutyRefs:[{documentRef:'LEGACY_DUTY:duty_zero',kind:'RENTER_REFUND',state:'SETTLED',amount:known('0')},{documentRef:'LEGACY_DUTY:owner_zero',kind:'OWNER_CREDIT',state:'SETTLED',amount:known('0')},{documentRef:'LEGACY_DUTY:compensation_zero',kind:'DEPOSIT_COMPENSATION',state:'SETTLED',amount:known('0')}]});
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url,zero):{order:legacy});const ui=await setup(t);ui.props.initialOrderId=legacy.id;await ui.render();await until(()=>ui.node.textContent.includes('零额责任已终定'));const card=ui.node.querySelector('[data-order-settlement-evidence]');assert.match(card.textContent,/号主租赁收益责任/);assert.match(card.textContent,/责任终定时间/);assert.match(card.textContent,/0\.00 元/);assert.match(card.textContent,/旧平台渠道到账情况未取得/);await act(async()=>button(card,'尚未取得依据的金额').click());assert.match(card.textContent,/退款出款记录[\s\S]*未记录/);await act(async()=>button(card,'展开缺失清单').click());assert.match(card.textContent,/渠道到账[\s\S]*未取得依据/);assert.doesNotMatch(card.textContent,/原过账|原入账基数|已退款|已到账|渠道已付|号主结算净额/);
 await act(async()=>button(card,'依据与说明').click());assert.match(card.textContent,/原责任依据/);assert.doesNotMatch(card.textContent,/原过账/);const {orderSettlementSummary}=await ui.source.ssrLoadModule('/apps/admin/src/views/admin-order-settlement-evidence.tsx');const summary=orderSettlementSummary(zero).join('\n');assert.match(summary,/责任终定：零额责任已终定/);assert.match(summary,/号主租赁收益责任：0\.00 元/);assert.doesNotMatch(summary,/原过账|原入账|结算过账|渠道已付|已退款|已到账/);
});

test('business funds keep old order payment singular while preserving attempts and partial refunds',async t=>{
 const legacy={...native,id:'legacy_order_business',source:{...native.source,origin:'LEGACY'}};
 const at='2026-10-01T03:00:00Z';
 const payment=(id,state,cents)=>({documentRef:'HISTORY_PAYMENT:'+id,number:id,kind:'PAYMENT',source:'LEGACY_MYSQL',state,amountCents:cents,occurredAt:at,channelArrival:'UNKNOWN'});
 const refund=(id,cents)=>({documentRef:'HISTORY_REFUND:'+id,number:id,kind:'REFUND',source:'LEGACY_MYSQL',state:'RECORDED_SUCCESS',amountCents:cents,occurredAt:at,channelArrival:'UNKNOWN'});
 const evidence=facts('LEGACY_ORDER:'+legacy.id,{posting:{state:'NOT_POSTED',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:unknown(),business:{
  payment:{state:'LEGACY_RECORDED_PAID',amount:known('92345'),occurredAt:at},
  settlementState:'NOT_SETTLED',legacyCompletedAmounts:null,
  paymentAttempts:[payment('first-attempt','RECORDED_UNPAID','92345'),payment('second-attempt','RECORDED_PAID','92345')],
  refundOrders:[refund('first-refund','2000'),refund('second-refund','3000')],reasonCodes:[],
 }});
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url,evidence,{legacyOrderObservations:[...evidence.business.paymentAttempts,...evidence.business.refundOrders]}):{order:legacy});
 const ui=await setup(t,['order.read','finance.read','finance.document.read']);ui.props.initialOrderId=legacy.id;ui.props.initialQuery={section:'finance'};
 await ui.render();await until(()=>ui.node.textContent.includes('923.45 元'));
 const card=ui.node.querySelector('[data-order-settlement-evidence]');
 assert.equal(card.textContent.split('923.45 元').length-1,1);
 assert.match(card.textContent,/订单实付923\.45 元旧平台记录已付/);
 assert.match(card.textContent,/未结算/);
 assert.doesNotMatch(card.textContent,/first-attempt|first-refund|银行已到账|0\.00 元/);
 await act(async()=>[...card.querySelectorAll('button')].find(b=>b.textContent.includes('付款尝试')).click());
 await until(()=>card.textContent.includes('second-attempt'));
 assert.match(card.textContent,/first-attempt原状态未付款[\s\S]*second-attempt原状态已付款/);
 await act(async()=>[...card.querySelectorAll('button')].find(b=>b.textContent.includes('退款单据')).click());
 await until(()=>card.textContent.includes('second-refund'));
 assert.match(card.textContent,/first-refund原状态退款成功20\.00 元[\s\S]*second-refund原状态退款成功30\.00 元/);
 assert.match(ui.node.textContent,/旧渠道依据尚未接入/);
 assert(![...ui.node.querySelectorAll('button')].some(b=>b.textContent.includes('在汇聚对账查看本单')));
 const support=ui.node.querySelector('aside.oc-related');
 assert.ok(support, 'legacy orders retain their customer-service group section');
 assert.match(support.textContent,/订单群/);
});

test('legacy account capture is labelled separately from the order frozen facts',async t=>{
 const legacy={...native,id:'legacy_order_capture',source:{...native.source,origin:'LEGACY'},
  haffRatio:{source:'LEGACY_ORIGINAL_ORDER',state:'NOT_RECORDED',wanPerYuan:null,customerTier:null},
  accountView:{source:'LEGACY_ACCOUNT_SNAPSHOT',sourceAccountBaseRatioWanPerYuan:'56',sourceAccountFullPayoutSelected:true}};
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url):{order:legacy});
 const ui=await setup(t,['order.read','supply.rental_account.read']);ui.props.initialOrderId=legacy.id;await ui.render();
 await until(()=>ui.node.textContent.includes('迁入时账号：'));
 assert.match(ui.node.textContent,/迁入时账号：比例 1元=56万哈夫币 · 包赔已选择；不是本单冻结记录/);
});

test('native order keeps the authorized channel reconciliation entry and order group section',async t=>{
 globalThis.fetch=async url=>response(String(url).includes('/finance/')?finance(url):{order:native});
 const ui=await setup(t,['order.read','finance.read','finance.document.read']);ui.props.initialQuery={section:'finance'};
 await ui.render();await until(()=>ui.node.textContent.includes('159.08 元'));
 const entry=[...ui.node.querySelectorAll('button')].find(b=>b.textContent.includes('在汇聚对账查看本单'));
 assert.ok(entry);assert.match(ui.node.querySelector('aside.oc-related').textContent,/订单群/);
 await act(async()=>entry.click());const channel=new URL(ui.opened.at(-1)[0],'http://local');
 assert.equal(channel.pathname,'/finance/channels');assert.equal(channel.searchParams.get('fromOrderId'),native.id);assert.equal(channel.searchParams.get('financeReturn'),'/orders/'+native.id+'?section=finance');
});
