import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createOfflineAdminSource } from './offline-admin-source.mjs';

test('first 503 keeps the original batch reachable, blocks a new key and refreshes completed rows', async t => {
  const browser = new Window({ url: 'http://127.0.0.1:3101/distribution-policy' });
  for (const name of ['document','HTMLElement','Element','Node','Event','CustomEvent','MouseEvent','KeyboardEvent','MutationObserver','ResizeObserver','DOMRect','HTMLInputElement','HTMLButtonElement','HTMLTextAreaElement','HTMLSelectElement','DocumentFragment','SVGElement']) if (browser[name]) globalThis[name] = browser[name];
  Object.assign(globalThis, { window:browser, localStorage:browser.localStorage, IS_REACT_ACT_ENVIRONMENT:true,
    getComputedStyle:browser.getComputedStyle.bind(browser), requestAnimationFrame:browser.requestAnimationFrame.bind(browser), cancelAnimationFrame:browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const originalFetch=globalThis.fetch, calls=[];
  let completed=false, posts=0, originalBody;
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const batch=state=>({schema:'distribution-maintenance-batch.v1',operation:'DUE_SETTLE',state,requestId:originalBody.requestId,fingerprint:'a'.repeat(64),plan:{earningIds:[{earningId:'earning_1',version:'1'}]},results:[{id:'earning_1',status:state==='COMPLETE'?'SETTLED':'UNKNOWN'}],notAttempted:0});
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input),browser.location.href), method=init.method??'GET'; calls.push({path:url.pathname,method,body:init.body});
    if(url.pathname.endsWith('/accruals')) return json({scope:'NATIVE',examined:1,nextCursor:null,orders:[{orderId:'order_1',status:completed?'COMPLETE':'MISSING',reason:null,items:[],postedAt:'2026-10-31T00:00:00Z'}]});
    if(url.pathname.endsWith('/due-settlements')&&method==='POST'){
      posts++; const body=JSON.parse(init.body); if(!originalBody)originalBody=body;else assert.deepEqual(body,originalBody);
      if(posts===1)return json({httpStatus:503,batch:batch('UNKNOWN'),replayed:false},503);
      completed=true; return json({httpStatus:200,batch:batch('COMPLETE'),replayed:true});
    }
    if(url.pathname.includes('/batches/')){assert.equal(url.pathname.split('/').at(-1),originalBody.requestId);return json({httpStatus:503,batch:batch('UNKNOWN'),replayed:true});}
    throw new Error('Unexpected request '+method+' '+url.pathname);
  };
  const loader=await createOfflineAdminSource({root:fileURLToPath(new URL('../../../',import.meta.url))});
  const {DistributionMaintenancePanel}=await loader.ssrLoadModule('/apps/admin/src/views/distribution-maintenance-panel.tsx');
  const {createRoot}=await import('react-dom/client');
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
  t.after(async()=>{await act(async()=>root.unmount());globalThis.fetch=originalFetch;await loader.close();await browser.happyDOM.abort();});
  const settle=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
  const button=text=>[...browser.document.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
  const click=async text=>{const node=button(text);assert.ok(node,text);assert.equal(node.disabled,false,text);await act(async()=>node.dispatchEvent(new browser.MouseEvent('click',{bubbles:true})));await settle();};
  await act(async()=>root.render(createElement(DistributionMaintenancePanel)));await settle();
  await click('执行到期入账');await click('确认执行');
  assert.equal(posts,1);assert.ok(button('读原批次'));assert.ok(button('重试原批次'));
  assert.equal(button('执行到期入账').disabled,true);assert.equal(button('重放可恢复漏计提').disabled,true);
  await click('读原批次');assert.match(browser.document.body.textContent,/UNKNOWN/);assert.equal(posts,1);
  await click('重试原批次');assert.equal(posts,2);assert.equal(host.querySelector('[aria-label="原批次恢复"]'),null);
  assert.match(host.textContent,/COMPLETE/);assert.equal(button('重放可恢复漏计提').disabled,true,'latest rescan must replace old MISSING row');
  assert.equal(button('执行到期入账').disabled,false);
  assert.equal(new Set(calls.filter(call=>call.method==='POST').map(call=>JSON.parse(call.body).requestId)).size,1);
});
