// SYNTHETIC_READER_COMPONENT：真实组件/API解析，HTTP仅内存替身，不执行渠道或资金命令。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createOfflineAdminSource } from './offline-admin-source.mjs';

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const storageKey = 'zzsh.admin.refund.pending.order_synthetic';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function setup(t, answer, options = {}) {
  const w = new Window({ url: 'https://synthetic-admin.invalid/orders/order_synthetic' });
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    Event: w.Event, MouseEvent: w.MouseEvent, CustomEvent: w.CustomEvent, MutationObserver: w.MutationObserver,
    ResizeObserver: w.ResizeObserver, CSS: w.CSS, sessionStorage: w.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  globalThis.getComputedStyle = w.getComputedStyle.bind(w);
  globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  const calls = [];
  globalThis.fetch = async (url, init) => { const call = { url, ...init }; calls.push(call); return answer(call, calls.length); };
  const source = await createOfflineAdminSource({ root: tree });
  const module = await source.ssrLoadModule('/apps/admin/src/views/admin-joinpay-ops-panel.tsx'), { AdminNativeRefundPanel } = module;
  const { createRoot } = await import('react-dom/client'), host = w.document.createElement('div');
  w.document.body.append(host); const root = createRoot(host);
  options.seed?.(w.sessionStorage);
  const render = async binding => { await act(async () => root.render(createElement(AdminNativeRefundPanel, { orderId: 'order_synthetic', canWrite: true, binding }))); await act(async () => new Promise(setImmediate)); };
  await render(options.binding);
  t.after(async () => { await act(async () => root.unmount()); await source.close(); await w.happyDOM.abort(); });
  const input = host.querySelector('[aria-label="退款金额（分）"]');
  await act(async () => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, '100'); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
  const submit = async () => { await act(async () => host.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))); await act(async () => { await new Promise(setImmediate); }); };
  return { host, calls, submit, render, module, storage:w.sessionStorage, pending: () => JSON.parse(w.sessionStorage.getItem(options.binding ? `${storageKey}.${JSON.stringify([options.binding.adminUserId,options.binding.sessionId])}` : storageKey)) };
}

test('invalid successful HTTP response keeps the original refund recovery key', async t => {
  const ui = await setup(t, () => response(null)); await ui.submit();
  assert.ok(ui.pending()?.key); assert.match(ui.host.textContent, /结果未知/);
  assert.doesNotMatch(ui.host.textContent, /已建立本地退款申请/);
  assert.equal(ui.calls.filter(c => c.method === 'POST').length, 1);
});

test('a rejected recovery after UNKNOWN preserves both key and request body', async t => {
  const ui = await setup(t, (_call, count) => response({ error: { code: count === 1 ? 'EVIDENCE_UNAVAILABLE' : 'FORBIDDEN' } }, count === 1 ? 503 : 403));
  await ui.submit(); const original = ui.pending(); assert.ok(original.key); await ui.submit();
  assert.equal(ui.pending()?.key, original.key);
  assert.equal(ui.calls[0].headers['idempotency-key'], ui.calls[1].headers['idempotency-key']);
  assert.equal(ui.calls[0].body, ui.calls[1].body); assert.match(ui.host.textContent, /原键恢复/);
});

test('a valid local receipt can complete request recovery without claiming channel arrival', async t => {
  const ui = await setup(t, call => response(call.method === 'GET' ? { items: [] } : {
    contractVersion: 'admin-native-refund.v1', replayed: false, intentId: 'refund_synthetic', refundOrderNo: 'RF_SYNTHETIC',
    amountCents: '100', currency: 'CNY', state: 'READY', budgetDisposition: 'ALLOCATED',
    channel: { result: 'NOT_SUBMITTED', bankArrival: 'UNKNOWN' } }));
  await ui.submit(); assert.equal(ui.pending(), null); assert.match(ui.host.textContent, /已建立本地退款申请/);
  assert.match(ui.host.textContent, /到账未核定/);
});

test('storage failure blocks a first refund POST instead of losing its original key on reload', async t => {
  const ui=await setup(t,()=>response(null));globalThis.sessionStorage={getItem:key=>ui.storage.getItem(key),setItem:()=>{throw Error('SYNTHETIC_QUOTA');},removeItem:key=>ui.storage.removeItem(key)};await ui.submit();
  assert.equal(ui.calls.length,0);assert.match(ui.host.textContent,/阻止.*提交/);
});

test('malformed original recovery data never becomes a new refund request', async t => {
  const ui=await setup(t,()=>response(null),{seed:s=>s.setItem(storageKey,'{broken')});await ui.submit();
  assert.equal(ui.calls.length,0);assert.equal(ui.storage.getItem(storageKey),'{broken');assert.match(ui.host.textContent,/原请求.*不可读/);
});

test('a different administrator gets a fresh scope while the original recovery remains intact', async t => {
  const binding={adminUserId:'admin_A',sessionId:'session_A'},ui=await setup(t,()=>response(null),{binding});await ui.submit();
  const original=ui.pending();assert.ok(original?.key);await ui.render({adminUserId:'admin_B',sessionId:'session_B'});
  assert.equal(ui.host.querySelector('[aria-label="退款金额（分）"]').value,'');assert.equal(ui.pending().key,original.key);
  assert.doesNotMatch(ui.host.textContent,/存在结果未知的申请/);
});

test('foreign legacy recovery is not overwritten by a new administrator', async t => {
  const legacy={key:'original_foreign_key',amount:'200',reason:'原退款内容',orderId:'order_synthetic',adminUserId:'admin_old',sessionId:'old_session'},binding={adminUserId:'admin_new',sessionId:'new_session'};
  const ui=await setup(t,()=>response(null),{binding,seed:s=>s.setItem(storageKey,JSON.stringify(legacy))});await ui.submit();
  assert.deepEqual(JSON.parse(ui.storage.getItem(storageKey)),legacy);assert.ok(ui.pending()?.key);
});

test('unknown or malformed query outcomes are not rendered as an acquired provider observation', async t => {
  const ui=await setup(t,()=>response(null));
  for(const bad of [null,{},[],{outcome:{}},{outcome:{kind:'NEW_VENDOR_STATE'},channelArrival:'UNKNOWN'},{outcome:{kind:'OBSERVED'},channelArrival:'ARRIVED'}]){
    const text=ui.module.queryOutcomeText(bad);assert.match(text,/未知/);assert.doesNotMatch(text,/已取得/);
  }
});

test('owned legacy recovery without optional reason keeps its original key and empty-body meaning', async t=>{
  const binding={adminUserId:'admin_A',sessionId:'session_A'},legacy={key:'legacy_owned_key',amount:'100',...binding};
  const ui=await setup(t,()=>response(null),{binding,seed:s=>s.setItem(storageKey,JSON.stringify(legacy))});await ui.submit();
  assert.equal(ui.calls[0].headers['idempotency-key'],legacy.key);assert.deepEqual(JSON.parse(ui.calls[0].body),{amountCents:'100'});
});

test('conflicting owned recovery records block a new POST without choosing or deleting either key', async t=>{
  const binding={adminUserId:'admin_A',sessionId:'session_A'},v={key:'original_A',amount:'100',reason:'',orderId:'order_synthetic',...binding};
  const ui=await setup(t,()=>response(null),{binding,seed:s=>{s.setItem(storageKey,JSON.stringify(v));s.setItem(`${storageKey}.${JSON.stringify([binding.adminUserId,binding.sessionId])}`,JSON.stringify({...v,key:'original_B'}));}});
  await ui.submit();assert.equal(ui.calls.length,0);assert.match(ui.host.textContent,/冲突/);assert.equal(JSON.parse(ui.storage.getItem(storageKey)).key,'original_A');
});


test('query observation requires the actual contract, operation, object and corresponding event', async t => {
  const ui=await setup(t,()=>response(null));
  for(const operation of ['REFUND_QUERY','PAYOUT_QUERY','COLLECTION_QUERY']){
    const expected={operation,objectId:'original_query'},event=operation==='COLLECTION_QUERY'?'E4':'TERMINAL';
    const receipt={contractVersion:'admin-joinpay-query.v1',...expected,channelArrival:'UNKNOWN',outcome:{kind:'OBSERVED',event}};
    assert.match(ui.module.queryOutcomeText(receipt,200,expected),/已取得渠道观察/);
    for(const bad of [ {...receipt,contractVersion:'other.v1'}, {...receipt,objectId:'other'}, {...receipt,operation:operation==='PAYOUT_QUERY'?'REFUND_QUERY':'PAYOUT_QUERY'},
      ...[undefined,null,{},'',operation==='COLLECTION_QUERY'?'TERMINAL':'E4'].map(value=>({...receipt,outcome:{kind:'OBSERVED',event:value}})) ]) {
      const text=ui.module.queryOutcomeText(bad,200,expected);assert.match(text,/未知/);assert.doesNotMatch(text,/已取得/);
    }
    for(const kind of ['UNKNOWN','SKIPPED','NOT_DISPATCHED'])assert.doesNotMatch(ui.module.queryOutcomeText({...receipt,outcome:{kind}},200,expected),/已取得/);
  }
});
