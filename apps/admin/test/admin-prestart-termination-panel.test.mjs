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
const button=(ui,label)=>[...ui.w.document.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
test('审核读取只GET，责任/本地核销/未知与原号并列，零默认渠道命令',async t=>{
 const ui=await setup(t,'/apps/admin/src/views/admin-prestart-termination-panel.tsx',{componentName:'AdminPrestartTerminationPanel',orderId:'order_1',binding,canWrite:true},()=>response(ctx));
 assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].method,'GET');assert.match(ui.host.textContent,/159\.08/);assert.match(ui.host.textContent,/本站尚未核销/);assert.match(ui.host.textContent,/结果未记录/);assert.doesNotMatch(ui.host.textContent,/UNKNOWN/);assert.match(ui.host.textContent,/银行到账未记录/);
 assert.doesNotMatch(ui.host.textContent,/核对原路退款责任|登记全额原路退款意图/);
 assert.equal(ui.host.textContent.includes('已经到账'),false);
});
test('未开租受控付款与退款清楚区分模拟结果',async t=>{
 const simulated={...ctx,request:{...ctx.request,dataOrigin:'LOCAL_CONTROLLED'},refund:{...ctx.refund,dataOrigin:'LOCAL_CONTROLLED',simulationScope:'ECS_TEST_SIMULATED',
  totals:{...ctx.refund.totals,consumedCents:'15908'},intents:[{...ctx.refund.intents[0],state:'SUCCEEDED',localWriteOff:'RECORDED'}]}};
 const ui=await setup(t,'/apps/admin/src/views/admin-prestart-termination-panel.tsx',{componentName:'AdminPrestartTerminationPanel',orderId:'order_1',binding,canWrite:true},()=>response(simulated));
 assert.match(ui.host.textContent,/模拟付款/);assert.match(ui.host.textContent,/模拟退款已完成/);assert.match(ui.host.textContent,/不会实际退回款项/);
 assert.doesNotMatch(ui.host.textContent,/登记全额原路退款意图|已经到账/);
});
test('缺少受控来源或演示范围冲突时不显示退款结果',async t=>{
 const invalid={...ctx,refund:{...ctx.refund,simulationScope:'ECS_TEST_SIMULATED'}};
 const ui=await setup(t,'/apps/admin/src/views/admin-prestart-termination-panel.tsx',{componentName:'AdminPrestartTerminationPanel',orderId:'order_1',binding,canWrite:true},()=>response(invalid));
 assert.match(ui.host.textContent,/终止依据读取不可用/);assert.doesNotMatch(ui.host.textContent,/模拟退款已完成|已经到账/);
});

test('未开租审核遇202 UNKNOWN按原键/原体恢复；更换主体不串原审核',async t=>{
 const scope='admin_1:session_1:order_1',body={expectedRevision:'2',decision:'APPROVE',assessment:'NO_USE_NO_DISPUTE',reason:'合成未交付核实'},
  key='synthetic_original_review_key',props={componentName:'AdminPrestartTerminationPanel',orderId:'order_1',binding,canWrite:true},
  draft={...ctx,eligibility:{allowed:true,reason:null,refundCents:'15908'},request:{...ctx.request,state:'REQUESTED',liabilityRecognized:false}};
 const ui=await setup(t,'/apps/admin/src/views/admin-prestart-termination-panel.tsx',props,c=>c.method==='POST'?response({outcome:'UNKNOWN',originalKeyRequired:true},{status:202}):response(draft),
  storage=>storage.setItem('zzsh.admin.prestart.'+scope,JSON.stringify({version:1,scope,key,terminationId:'term_1',body})));
 assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);
 await ui.click(button(ui,'处理结束申请'));
 const recovery=()=>button(ui,'恢复原审核请求');
 await ui.click(recovery());assert.equal(ui.calls.filter(c=>c.method==='POST').length,0);await ui.click(button(ui,'确认处理'));
 assert.match(ui.host.textContent,/原键及原审核内容已保留/);await ui.click(recovery());await ui.click(button(ui,'确认处理'));
 const writes=ui.calls.filter(c=>c.method==='POST');assert.equal(writes.length,2);
 for(const w of writes){assert.equal(new Headers(w.headers).get('idempotency-key'),key);assert.deepEqual(JSON.parse(w.body),body);}
 await ui.render({...props,canWrite:false});assert.equal(recovery()?.disabled,true,'pending request remains visible but cannot be replayed after permission loss');
 await ui.render({...props,binding:{adminUserId:'other_admin',sessionId:'other_session'}});assert.equal(recovery(),undefined);
 assert.equal(ui.calls.filter(c=>c.method==='POST').length,2);
});
