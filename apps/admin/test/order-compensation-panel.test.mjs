// Synthetic HTTP responses only; no database or payment provider is contacted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act,createElement } from 'react';
import { createOfflineAdminSource } from './offline-admin-source.mjs';

const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const snapshot={authenticated:true,adminUserId:'synthetic_admin',user:{name:'运营',username:'OPS',twoFactorEnabled:true},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},session:{id:'synthetic_session',locked:false,pinConfigured:true,createdAt:null,expiresAt:null},permissions:['order.read','order.compensation.request','order.compensation.approve','approval.request.create','approval.request.read','approval.request.approve']};
async function setup(t,answer,origin='NATIVE'){
 const w=new Window({url:'https://synthetic-admin.invalid/orders/synthetic_order'});
 Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,MouseEvent:w.MouseEvent,CustomEvent:w.CustomEvent,MutationObserver:w.MutationObserver,ResizeObserver:w.ResizeObserver,CSS:w.CSS,sessionStorage:w.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});globalThis.getComputedStyle=w.getComputedStyle.bind(w);globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
 const calls=[];globalThis.fetch=async(url,init={})=>{const call={url:String(url),...init};calls.push(call);return answer(call);};
 const source=await createOfflineAdminSource({root:tree}),{OrderCompensationPanel}=await source.ssrLoadModule('/apps/admin/src/views/order-compensation-panel.tsx'),{createRoot}=await import('react-dom/client');
 const host=w.document.createElement('div'),actions=w.document.createElement('div');w.document.body.append(host,actions);const root=createRoot(host);
 await act(async()=>{root.render(createElement(OrderCompensationPanel,{snapshot,orderId:'synthetic_order',displayNo:'ZZ-SYNTHETIC',origin,actionsTarget:actions,onOpenPath:()=>{},refreshNonce:0}));await new Promise(setImmediate);});
 t.after(async()=>{await act(async()=>root.unmount());await source.close();await w.happyDOM.abort();});
 const wait=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));}throw Error('compensation UI timed out');};
 const button=(container,label)=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
 const fill=async(label,value,textarea=false)=>{const el=w.document.querySelector(`[aria-label="${label}"]`);assert(el);await act(async()=>{Object.getOwnPropertyDescriptor((textarea?w.HTMLTextAreaElement:w.HTMLInputElement).prototype,'value').set.call(el,value);el.dispatchEvent(new w.Event('input',{bubbles:true}));});};
 return{w,host,actions,calls,wait,button,fill};
}
const basis={origin:'NATIVE',orderId:'synthetic_order',gameId:'game_1',ownerUserId:'owner_1',state:'SELECTED',sourceDigest:'a'.repeat(64)};
test('compensation entry requires a second confirmation and preserves the exact submitted request',async t=>{
 let submitted;
 const ui=await setup(t,call=>{if(call.url.includes('/compensation?'))return response({schema:'admin-order-compensation.v1',basis,state:'READY',items:[],truncated:false});
  if(call.url.endsWith('/security/approvals/requests')){submitted=JSON.parse(call.body);return response({approvalRequestId:'approval_req_synthetic'});}
  if(call.url.includes('/approvals/requests/detail'))return response({requestId:'approval_req_synthetic',operation:{code:'order.compensation.grant'},status:'PENDING',business:{compensation:submitted.payload}});
  throw Error('unexpected synthetic request '+call.url);});
 await ui.wait(()=>ui.button(ui.actions,'申请包赔赔偿')&&!ui.button(ui.actions,'申请包赔赔偿').disabled);
 await act(async()=>ui.button(ui.actions,'申请包赔赔偿').click());
 await ui.fill('赔偿金额（元）','12.34');await ui.fill('事故或工单编号','工单 123');await ui.fill('处理原因','已核对处理原因',true);await ui.fill('核对依据','工单记录 123');
 await act(async()=>ui.button(ui.w.document,'核对并提交').click());assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);
 const alert=ui.w.document.querySelector('[role="alertdialog"]');assert(alert);assert.match(alert.textContent,/12\.34 元/);
 await act(async()=>ui.button(alert,'返回核对').click());assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);assert.equal(ui.w.document.querySelector('[aria-label="赔偿金额（元）"]').value,'12.34');
 await act(async()=>ui.button(ui.w.document,'核对并提交').click());const again=ui.w.document.querySelector('[role="alertdialog"]');await act(async()=>{ui.button(again,'确认提交').click();await new Promise(setImmediate);});
 await ui.wait(()=>ui.calls.some(c=>c.method==='POST'));assert.equal(ui.calls.filter(c=>c.method==='POST').length,1);assert.equal(submitted.payload.amountCents,'1234');assert.equal(submitted.payload.ownerUserId,'owner_1');
});
test('missing schema or an unselected plan does not permit a new compensation request',async t=>{
 const ui=await setup(t,()=>response({schema:'admin-order-compensation.v1',basis:{...basis,state:'NOT_SELECTED'},state:'READY',items:[],truncated:false}));
 await ui.wait(()=>ui.button(ui.actions,'申请包赔赔偿'));assert.equal(ui.button(ui.actions,'申请包赔赔偿').disabled,true);assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);
});
test('legacy order requires an explicit review of its original coverage before submission',async t=>{
 const ui=await setup(t,()=>response({schema:'admin-order-compensation.v1',basis:{...basis,origin:'LEGACY',state:'LEGACY_REVIEW'},state:'READY',items:[],truncated:false}),'LEGACY');
 await ui.wait(()=>ui.button(ui.actions,'申请包赔赔偿')&&!ui.button(ui.actions,'申请包赔赔偿').disabled);
 await act(async()=>ui.button(ui.actions,'申请包赔赔偿').click());
 await ui.fill('赔偿金额（元）','12.34');await ui.fill('事故或工单编号','工单 123');await ui.fill('处理原因','已核对处理原因',true);await ui.fill('核对依据','工单记录 123');
 const next=ui.button(ui.w.document,'核对并提交');assert.equal(next.disabled,true);
 const confirmation=ui.w.document.querySelector('[aria-label="已核实旧订单选择了全额包赔"]');assert(confirmation);
 await act(async()=>confirmation.click());assert.equal(next.disabled,false,confirmation.outerHTML);assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);
});
