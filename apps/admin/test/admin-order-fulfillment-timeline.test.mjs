import assert from 'node:assert/strict';
import {test} from 'node:test';
import {act,createElement} from 'react';
import {Window} from 'happy-dom';
import {createOfflineAdminSource} from './offline-admin-source.mjs';

test('履约时间线区分新旧、未确认和已过账，只展示有依据的事件',async t=>{
 const w=new Window({url:'http://127.0.0.1:4291/orders'});
 Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Element:w.Element,Node:w.Node,Event:w.Event,IS_REACT_ACT_ENVIRONMENT:true});
 const source=await createOfflineAdminSource({root:process.cwd().replace(/[\\/]apps[\\/]admin$/,'')});
 const {OrderFulfillmentTimeline}=await source.ssrLoadModule('/apps/admin/src/views/admin-order-fulfillment-timeline.tsx');
 const {createRoot}=await import('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());await source.close();await w.happyDOM.abort();});
 const order={status:'PAID',createdAt:'2026-11-01T00:00:00Z',paidAt:'2026-11-01T00:01:00Z',payment:{state:'RECORDED_PAID'},source:{origin:'NATIVE'},progress:{opening:{state:'AWAITING_CONFIRMATION',confirmedAtUtc:null},ending:{state:'NOT_STARTED',postedAtUtc:null}}};
 const render=async(props)=>act(async()=>root.render(createElement(OrderFulfillmentTimeline,{order,settlement:null,legacy:null,paymentTitle:'支付已记录',paymentTimeText:'支付时间未记录',formatTime:x=>x??'未记录',...props})));
 await render({settlement:{openings:[{versionNo:2,status:'DRAFT',createdAt:'2026-11-01T00:02:00Z',acks:[{party:'RENTER',source:'ON_BEHALF',createdAt:'2026-11-01T00:03:00Z'}]}]}});
 assert.match(host.textContent,/等待双方确认开租/);assert.match(host.textContent,/租客：客服协助确认/);assert.match(host.textContent,/号主：待确认/);assert.doesNotMatch(host.textContent,/开租已确认|结算已过账/);
 await render({order:{...order,status:'COMPLETED',completedAt:'2026-11-02T00:00:00Z',progress:{opening:{state:'CONFIRMED',confirmedAtUtc:'2026-11-01T00:05:00Z'},ending:{state:'POSTED',postedAtUtc:'2026-11-02T00:00:00Z'}}}});
 assert.match(host.textContent,/结算已过账/);assert.doesNotMatch(host.textContent,/订单完成记录/);
 await render({order:{...order,status:'COMPLETED',source:{origin:'LEGACY'},completedAt:'2026-11-02T00:00:00Z',progress:null}});
 assert.match(host.textContent,/订单完成（旧站记录）/);assert.doesNotMatch(host.textContent,/开租已确认/);
 await render({order:{...order,status:'CANCELLED',source:{origin:'LEGACY'},cancelledAt:null,progress:null}});
 assert.match(host.textContent,/订单已取消/);assert.match(host.textContent,/取消时间未记录/);assert.doesNotMatch(host.textContent,/已退款|开租已确认/);
});
