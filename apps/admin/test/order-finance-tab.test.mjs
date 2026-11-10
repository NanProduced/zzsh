import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createOfflineAdminSource } from './offline-admin-source.mjs';

const known=cents=>({knowledge:'KNOWN',cents,reasonCodes:[]}), unknown=()=>({knowledge:'UNKNOWN',cents:null,reasonCodes:[]});
const transaction=(ref,amount,extra={})=>({documentRef:ref,number:ref,kind:'REFUND',source:'NATIVE',paymentSource:'CONTROLLED',state:'SUCCEEDED',amountCents:amount,occurredAt:null,channelArrival:'UNKNOWN',payWay:null,payWayLabel:null,...extra});
const evidence=(extra={})=>({schema:'admin-order-settlement-evidence.v1',documentRef:'ORDER:o1',readiness:'READY',posting:{state:'POSTED',ref:'p1',postedAt:'2026-11-01T00:00:00Z'},captured:known('10000'),ownerNet:known('6000'),refundPayable:known('3000'),platformContribution:known('1000'),refunded:unknown(),historicalRefund:unknown(),refundDueAt:null,channel:{state:'UNKNOWN',reference:null},dutyRefs:[],reasonCodes:[],business:{payment:{state:'SITE_ACCEPTED',amount:known('10000'),occurredAt:null},settlementState:'POSTED',legacyCompletedAmounts:null,paymentAttempts:[],refundOrders:[transaction('REFUND_INTENT:r1','3000')],reasonCodes:[]},...extra});

async function setup(t){
 const browser=new Window({url:'http://127.0.0.1:4311/'});
 Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,MutationObserver:browser.MutationObserver,ResizeObserver:browser.ResizeObserver,CSS:browser.CSS,FormData:browser.FormData,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);
 const source=await createOfflineAdminSource({root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')});
 const {OrderFinanceTab}=await source.ssrLoadModule('/apps/admin/src/views/order-finance-tab.tsx');
 const {createRoot}=await import('react-dom/client'),node=document.createElement('div');document.body.append(node);const root=createRoot(node);
 t.after(async()=>{await act(async()=>root.unmount());await source.close();browser.happyDOM.abort();});
 return {node,render:props=>act(async()=>root.render(createElement(OrderFinanceTab,props)))};
}
const distribution={state:'unavailable'};

test('one source-qualified refund is shown once and a local result does not claim channel receipt',async t=>{
 const ui=await setup(t);await ui.render({state:'ready',evidence:evidence(),distribution,refundSummary:{contractVersion:'v1',integration:'INTEGRATED',intents:[],bankArrival:'UNKNOWN',coverage:'COMPLETE_WITHIN_LIMIT'}});
 assert.match(ui.node.textContent,/REFUND_INTENT:r1/);assert.match(ui.node.textContent,/本地受控记录/);assert.match(ui.node.textContent,/渠道到账未取得依据/);
 assert.equal((ui.node.textContent.match(/REFUND_INTENT:r1/g)??[]).length,1);assert.doesNotMatch(ui.node.textContent,/银行已到账|真实汇聚退款成功/);
});
test('unbalanced or unavailable proof never turns into a posted allocation or zero',async t=>{
 const ui=await setup(t);await ui.render({state:'ready',evidence:evidence({platformContribution:known('2000')}),distribution});
 assert.match(ui.node.textContent,/不完整或不平衡/);assert.equal(ui.node.querySelector('[aria-label="本单结算分配"]'),null);assert.doesNotMatch(ui.node.textContent,/已记入号主可用余额/);
 await ui.render({state:'unavailable',distribution});assert.match(ui.node.textContent,/不能视为零/);assert.doesNotMatch(ui.node.textContent,/100\.00 元|已结算/);
});
test('separately authorized refund summary survives missing finance-document permission',async t=>{
 const ui=await setup(t);await ui.render({state:'forbidden',distribution,refundSummary:{contractVersion:'v1',integration:'INTEGRATED',intents:[{intentId:'r2',refundOrderNo:'R-2',amount:{cents:'1500',currency:'CNY'},localState:'PROCESSING',budgetDisposition:'ALLOCATED',requiresReview:false,bankArrival:'UNKNOWN'}],bankArrival:'UNKNOWN'}});
 assert.match(ui.node.textContent,/无权查看本单资金凭证/);assert.match(ui.node.textContent,/R-2/);assert.match(ui.node.textContent,/15\.00 元/);assert.match(ui.node.textContent,/仅覆盖汇聚来源/);
});
test('refund marked for review does not present local success as its current state',async t=>{
 const ui=await setup(t);await ui.render({state:'forbidden',distribution,refundSummary:{contractVersion:'v1',integration:'INTEGRATED',intents:[{intentId:'r2',refundOrderNo:'R-2',amount:{cents:'1500',currency:'CNY'},localState:'SUCCEEDED',budgetDisposition:'CONSUMED',requiresReview:true,bankArrival:'UNKNOWN'}],bankArrival:'UNKNOWN'}});
 assert.match(ui.node.textContent,/状态需核对/);assert.doesNotMatch(ui.node.textContent,/本地记录成功/);
});
test('legacy source total is not presented as a current refund or ledger posting',async t=>{
 const ui=await setup(t),old=evidence({documentRef:'LEGACY_ORDER:l1',posting:{state:'UNKNOWN',ref:null,postedAt:null},captured:unknown(),ownerNet:unknown(),refundPayable:unknown(),platformContribution:unknown(),historicalRefund:known('1080'),business:{payment:{state:'LEGACY_RECORDED_PAID',amount:known('7680'),occurredAt:null},settlementState:'LEGACY_RECORDED_COMPLETE',legacyCompletedAmounts:{ownerEarnings:known('6000'),refundAmount:known('1080')},paymentAttempts:[],refundOrders:[],reasonCodes:[]}});
 await ui.render({state:'ready',evidence:old,distribution});assert.match(ui.node.textContent,/旧平台记录已付款/);assert.match(ui.node.textContent,/退款金额原记/);assert.equal((ui.node.textContent.match(/10\.80 元/g)??[]).length,1);assert.doesNotMatch(ui.node.textContent,/退款已到账|已记入号主可用余额/);
});
