// SYNTHETIC_READER_COMPONENT：真实组件，HTTP仅内存替身，不执行渠道或资金。
import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {createOfflineAdminSource} from './offline-admin-source.mjs';
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const response=(v,status=200)=>Response.json(v,{status});
const at='2026-10-28T00:00:00.000000Z';
const ctx={contractVersion:'order-prestart-termination.v1',orderId:'order_1',coverage:'LOCAL_REGISTERED_ONLY',bankArrival:'UNKNOWN',canReview:true,
 eligibility:{allowed:false,reason:'ORDER_NOT_PAID',refundCents:null},
 request:{id:'term_1',revision:'2',state:'APPROVED',reason:'申请未开租结束',reviewReason:'核实无争议',fullRefundCents:'15908',liabilityRecognized:true,dataOrigin:'JOINPAY_LOCAL_ACCEPTANCE',bankArrival:'UNKNOWN'},
 refund:{integration:'INTEGRATED',truncated:false,channelRecordsChecked:false,bankArrival:'UNKNOWN',
 totals:{originalCents:'15908',allocatedCents:'15908',consumedCents:'0',releasedCents:'0',remainingCents:'0',totalsComplete:true},
 intents:[{intentId:'refund_1',refundOrderNo:'RF'+'a'.repeat(28),state:'UNKNOWN',firstSubmit:'DISPATCHED',blockedReason:null,localWriteOff:'NOT_RECORDED',updatedAt:at}]}};
const binding={adminUserId:'admin_1',sessionId:'session_1'};
async function setup(t,component,props,answer,seedStorage){
 const w=new Window({url:'https://synthetic-admin.invalid/orders/order_1'});
 Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,MouseEvent:w.MouseEvent,
  CustomEvent:w.CustomEvent,MutationObserver:w.MutationObserver,ResizeObserver:w.ResizeObserver,CSS:w.CSS,sessionStorage:w.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(globalThis,'navigator',{value:w.navigator,configurable:true});globalThis.getComputedStyle=w.getComputedStyle.bind(w);
 globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
 seedStorage?.(w.sessionStorage);
 const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{const c={url:String(url),...init};calls.push(c);return answer(c,calls.length);};
 const source=await createOfflineAdminSource({root:tree}),module=await source.ssrLoadModule(component),Component=module[props.componentName];
 const {createRoot}=await import('react-dom/client'),host=w.document.createElement('div');w.document.body.append(host);const root=createRoot(host);
 const render=async p=>{await act(async()=>root.render(createElement(Component,p)));await act(async()=>new Promise(setImmediate));};
 await render(props);
 t.after(async()=>{await act(async()=>root.unmount());globalThis.fetch=old;await source.close();await w.happyDOM.abort();});
 const click=async el=>{await act(async()=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true})));await act(async()=>new Promise(setImmediate));};
 return{host,calls,w,render,click,root,module};
}
const originalProps={componentName:'AdminOriginalRefundPanel',orderId:'order_1',basis:'PRESTART_TERMINATION',reference:'term_1',canWrite:true,binding};
test('未开租退款按固定原引用登记；缺复核确认与无权时按钮关闭',async t=>{
 const ui=await setup(t,'/apps/admin/src/views/admin-original-refund-panel.tsx',originalProps,()=>response({contractVersion:'admin-prestart-native-refund.v1',orderId:'order_1',terminationId:'term_1',outcome:'ALLOCATED',replayed:false,
  intentId:'refund_1',refundOrderNo:'RF'+'a'.repeat(28),state:'READY',budgetDisposition:'ALLOCATED',channel:{result:'NOT_SUBMITTED',bankArrival:'UNKNOWN'}}));
 let button=ui.host.querySelector('button');assert.equal(button.disabled,true);await ui.click(ui.host.querySelector('input[type=checkbox]'));button=ui.host.querySelector('button');assert.equal(button.disabled,false);await ui.click(button);
 assert.equal(ui.calls.length,1);assert.match(ui.calls[0].url,/term_1\/refund-requests$/);assert.deepEqual(JSON.parse(ui.calls[0].body),{});
 assert.match(ui.host.textContent,/渠道提交与银行到账未核定/);
 await ui.render({...originalProps,canWrite:false});assert.equal(ui.host.textContent,'');
});
test('坏2xx回执保留原键/body；重复点击只恢复原退款，不覆盖UNKNOWN',async t=>{
 const ui=await setup(t,'/apps/admin/src/views/admin-original-refund-panel.tsx',originalProps,()=>response({wrong:'shape'}));
 await ui.click(ui.host.querySelector('input[type=checkbox]'));await ui.click(ui.host.querySelector('button'));
 assert.match(ui.host.textContent,/原引用、原内容和原键已保留/);await ui.click(ui.host.querySelector('button'));
 assert.equal(ui.calls.length,2);assert.equal(new Headers(ui.calls[0].headers).get('idempotency-key'),new Headers(ui.calls[1].headers).get('idempotency-key'));
 assert.equal(ui.calls[0].body,ui.calls[1].body);assert.deepEqual(JSON.parse(ui.calls[0].body),{});
});
test('审核读取只GET，责任/本地核销/未知与原号并列，零默认渠道命令',async t=>{
 const ui=await setup(t,'/apps/admin/src/views/admin-prestart-termination-panel.tsx',{componentName:'AdminPrestartTerminationPanel',orderId:'order_1',binding,canWrite:true},()=>response(ctx));
 assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].method,'GET');assert.match(ui.host.textContent,/159\.08/);assert.match(ui.host.textContent,/本站尚未核销/);assert.match(ui.host.textContent,/UNKNOWN/);assert.match(ui.host.textContent,/银行到账未核定/);
 assert.equal(ui.host.textContent.includes('已经到账'),false);
});
test('纯回执解析不把review、坏枚举或数组当已登记/渠道成功',async t=>{
 const ui=await setup(t,'/apps/admin/src/views/admin-original-refund-panel.tsx',{...originalProps,canWrite:false},()=>response(null));
 const parse=ui.module.originalRefundReceipt;
 const expected={orderId:'order_1',reference:'term_1'},review={contractVersion:'admin-prestart-native-refund.v1',orderId:'order_1',terminationId:'term_1',replayed:false,outcome:'REVIEW_REQUIRED',reason:'ORIGINAL_ORDER_NO_AMBIGUOUS',channel:{result:'NOT_SUBMITTED',bankArrival:'UNKNOWN'}};
 assert.deepEqual(parse(review,'PRESTART_TERMINATION',expected),{review:true,reason:'ORIGINAL_ORDER_NO_AMBIGUOUS'});
 for(const v of [null,[],{},ctx,{...review,terminationId:'other'},{...review,replayed:true},{contractVersion:'admin-prestart-native-refund.v1',replayed:false,outcome:'SUCCEEDED',channel:{result:'SUCCEEDED',bankArrival:'ARRIVED'}}])assert.throws(()=>parse(v,'PRESTART_TERMINATION',expected));
});

test('未开租审核遇202 UNKNOWN按原键/原体恢复；更换主体不串原审核',async t=>{
 const scope='admin_1:session_1:order_1',body={expectedRevision:'2',decision:'APPROVE',assessment:'NO_USE_NO_DISPUTE',reason:'合成未交付核实'},
  key='synthetic_original_review_key',props={componentName:'AdminPrestartTerminationPanel',orderId:'order_1',binding,canWrite:true},
  draft={...ctx,eligibility:{allowed:true,reason:null,refundCents:'15908'},request:{...ctx.request,state:'REQUESTED',liabilityRecognized:false}};
 const ui=await setup(t,'/apps/admin/src/views/admin-prestart-termination-panel.tsx',props,c=>c.method==='POST'?response({outcome:'UNKNOWN',originalKeyRequired:true},{status:202}):response(draft),
  storage=>storage.setItem('zzsh.admin.prestart.'+scope,JSON.stringify({version:1,scope,key,terminationId:'term_1',body})));
 assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);
 const recovery=()=>[...ui.host.querySelectorAll('button')].find(b=>b.textContent==='恢复原审核请求');
 await ui.click(recovery());assert.match(ui.host.textContent,/原键及原审核内容已保留/);await ui.click(recovery());
 const writes=ui.calls.filter(c=>c.method==='POST');assert.equal(writes.length,2);
 for(const w of writes){assert.equal(new Headers(w.headers).get('idempotency-key'),key);assert.deepEqual(JSON.parse(w.body),body);}
 await ui.render({...props,binding:{adminUserId:'other_admin',sessionId:'other_session'}});assert.equal(recovery(),undefined);
 assert.equal(ui.calls.filter(c=>c.method==='POST').length,2);
});
