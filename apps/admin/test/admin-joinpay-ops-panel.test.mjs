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
async function setup(t, answer) {
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
  const { AdminNativeRefundPanel } = await source.ssrLoadModule('/apps/admin/src/views/admin-joinpay-ops-panel.tsx');
  const { createRoot } = await import('react-dom/client'), host = w.document.createElement('div');
  w.document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(createElement(AdminNativeRefundPanel, { orderId: 'order_synthetic', canWrite: true })));
  t.after(async () => { await act(async () => root.unmount()); await source.close(); await w.happyDOM.abort(); });
  const input = host.querySelector('[aria-label="退款金额（分）"]');
  await act(async () => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, '100'); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
  const submit = async () => { await act(async () => host.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))); await act(async () => { await new Promise(setImmediate); }); };
  return { host, calls, submit, pending: () => JSON.parse(w.sessionStorage.getItem(storageKey)) };
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
