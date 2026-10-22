import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Use the existing Admin component-test setup and real House controls.
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/users/synthetic-user' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'localStorage', 'sessionStorage']) globalThis[name] = name === 'window' ? browser : browser[name];
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({ root: rootPath, configFile: false, plugins: [react()], resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { CreditPanel } = await vite.ssrLoadModule('/src/views/user-directory/credit-panel.tsx');
const { AdminApiError } = await vite.ssrLoadModule('/src/api.ts');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const initialEvent = { id: 'synthetic-initial', eventType: 'INITIALIZED', visibleReason: '初始信用建立', scoreBefore: 100, scoreAfter: 100, appliedDeltaScore: 0, createdAt: '2026-10-22T00:00:00Z', actorAdminId: null };
const deductionEvent = { id: 'synthetic-deduction', eventType: 'MANUAL_DEDUCTION', visibleReason: '核实后的扣分说明', scoreBefore: 80, scoreAfter: 70, appliedDeltaScore: -10, createdAt: '2026-10-22T01:00:00Z', actorAdminId: 'synthetic-operator', actorAdminName: '运营小林', reversed: false };
let serial = 0;
function adapter({ score = 70, initialized = true, writable = true, unknown = false, readbackFails = false, guaranteeRead = false } = {}) {
  const data = { credit: initialized ? { userId: 'synthetic-user', score, revision: '7', events: [deductionEvent, initialEvent].map(item => ({ ...item })) } : null, recoveryRequests: [], guarantees: [], transactions: [] };
  const calls = { read: [], write: [] };
  let shouldLoseResponse = unknown;
  let failNextRead = false;
  const permissions = ['credit.read', ...(writable ? ['credit.decide'] : []), ...(guaranteeRead ? ['credit.guarantee.read'] : [])];
  return {
    calls, data,
    snapshot: { adminUserId: `synthetic-admin-${++serial}`, session: { id: `synthetic-session-${serial}`, locked: false }, security: { status: 'ACTIVE', passwordChangeRequired: false }, permissions },
    has: permission => permissions.includes(permission), hasCreditGuaranteeRead: () => guaranteeRead,
    credit: async id => { calls.read.push(id); if (failNextRead) { failNextRead = false; throw new AdminApiError(503, 'INTERNAL_ERROR'); } return id === 'synthetic-user' ? structuredClone(data) : { credit: { userId: id, score: 41, revision: '1', events: [] }, recoveryRequests: [], guarantees: [], transactions: [] }; },
    creditDecide: async (url, body, _signal, key) => {
      calls.write.push({ url, body: structuredClone(body), key });
      if (shouldLoseResponse) { shouldLoseResponse = false; throw new AdminApiError(0, 'NETWORK_ERROR'); }
      const reverse = url.endsWith('/reverse');
      const before = data.credit.score;
      const event = { ...deductionEvent, id: `synthetic-event-${calls.write.length}`, eventType: reverse ? 'MANUAL_DEDUCTION_REVERSED' : 'MANUAL_DEDUCTION', scoreBefore: before, scoreAfter: reverse ? Math.min(100, before + 10) : before - body.amount, visibleReason: body.visibleReason, reversed: false };
      event.appliedDeltaScore = event.scoreAfter - before;
      if (reverse) data.credit.events.find(item => item.id === 'synthetic-deduction').reversed = true;
      data.credit.score = event.scoreAfter; data.credit.revision = String(BigInt(data.credit.revision) + 1n); data.credit.events.unshift(event);
      if (readbackFails) failNextRead = true;
      return { event: { id: event.id } };
    },
  };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function waitFor(fn) { const limit = Date.now() + 2500; while (!fn()) { if (Date.now() > limit) throw Error('Credit component condition timed out'); await settle(); } }
const button = name => [...browser.document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') || item.textContent.trim()) === name);
async function click(element) { assert.ok(element, 'expected an available control'); await act(async () => element.click()); await settle(); }
async function fill(element, value) { assert.ok(element); await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new browser.Event('input', { bubbles: true })); element.dispatchEvent(new browser.Event('change', { bubbles: true })); }); await settle(); }
async function mount(t, config = {}) {
  browser.sessionStorage.clear(); globalThis.sessionStorage = browser.sessionStorage;
  const a = config.adapter ?? adapter(config);
  const historyCalls = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url), browser.location.href); historyCalls.push({ path: address.pathname, search: address.search, method: init.method ?? 'GET' });
    assert.match(address.pathname, /^\/api\/bff\/admin\/credit\/users\/[^/]+\/guarantee-history$/);
    return new Response(JSON.stringify({ contractVersion: 'admin-owner-guarantee-history.read.v1', subjectId: address.pathname.split('/').at(-2), adminActorId: a.snapshot.adminUserId,
      contextKey: 'synthetic-history-context', snapshotVersion: null, asOf: null, nextCursor: null, items: [], channelArrival: 'UNKNOWN', liability: { knowledge: 'UNKNOWN', amountCents: null },
      coverage: { knowledge: 'KNOWN', count: '0', mappedRecordCount: '0' }, postedHeld: { knowledge: 'KNOWN', amountCents: '0', scope: 'POSTED_LEDGER_ONLY' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  if (config.initialIntent) browser.sessionStorage.setItem(`zzsh.admin.credit.${encodeURIComponent(`${a.snapshot.adminUserId}:${a.snapshot.session.id}:synthetic-user`)}`, JSON.stringify(config.initialIntent(a)));
  const host = browser.document.createElement('div'); host.className = 'workspace-root'; browser.document.body.append(host);
  let root = createRoot(host); let subject = { id: 'synthetic-user', name: '测试用户' }; let active = true; let changed = 0;
  const props = () => ({ adapter: a, user: subject, refreshNonce: 0, active, changed: () => { changed += 1; } });
  await act(async () => root.render(createElement(CreditPanel, props()))); await settle();
  t.after(async () => { globalThis.sessionStorage = browser.sessionStorage; globalThis.fetch = priorFetch; await act(async () => root.unmount()); host.remove(); await settle(); });
  return { a, host, historyCalls, changes: () => changed,
    remount: async () => { await act(async () => root.unmount()); root = createRoot(host); await act(async () => root.render(createElement(CreditPanel, props()))); await settle(); },
    subject: async value => { subject = value; await act(async () => root.render(createElement(CreditPanel, props()))); await settle(); },
    active: async value => { active = value; await act(async () => root.render(createElement(CreditPanel, props()))); await settle(); },
  };
}
async function openDeduction(amount = '17', explanation = '本次人工扣分，用户可见') {
  await click(button('手动扣分')); await waitFor(() => browser.document.querySelector('[role="dialog"]'));
  await fill(browser.document.querySelector('[aria-label="扣分数量"]'), amount);
  await fill(browser.document.querySelector('[aria-label="扣分说明"]'), explanation);
}

test('credit uses a compact real table and semantic score without the fixed-ten source form', async t => {
  const h = await mount(t); await waitFor(() => h.host.querySelector('table'));
  assert.deepEqual([...h.host.querySelectorAll('th')].map(item => item.textContent), ['时间', '变更', '分数变化', '用户可见说明', '操作人', '操作']);
  assert.match(h.host.textContent, /运营小林/); assert.match(h.host.textContent, /说明对用户可见/); assert.ok(h.host.querySelector('[data-variant="warning"]'));
  for (const noise of ['来源类型', '来源编号', '主体角色', '内部依据', '确认扣 10 分', '版本 7']) assert.equal(h.host.textContent.includes(noise), false, noise);
  assert.equal(h.host.querySelector('details,select'), null); assert.equal(h.host.querySelector('textarea'), null);
});

test('unknown initial score remains unknown and cannot open a deduction', async t => {
  const h = await mount(t, { initialized: false }); await waitFor(() => button('手动扣分'));
  assert.ok(button('手动扣分').disabled); assert.match(h.host.textContent, /未评分/); assert.match(h.host.textContent, /暂未建立信用记录/); assert.equal(h.host.textContent.includes('100分'), false);
});

test('a deduction dialog validates the amount and submits only amount, visible reason and revision', async t => {
  const h = await mount(t); await openDeduction('71'); assert.ok(button('确认扣分').disabled);
  for (const value of ['0', '-1', '2.5', '101', '01']) { await fill(browser.document.querySelector('[aria-label="扣分数量"]'), value); assert.ok(button('确认扣分').disabled); }
  await fill(browser.document.querySelector('[aria-label="扣分数量"]'), '17'); assert.equal(button('确认扣分').disabled, false);
  await click(button('确认扣分')); await waitFor(() => h.changes() === 1);
  assert.equal(h.a.calls.write.length, 1); assert.equal(h.a.calls.write[0].url, 'users/synthetic-user/deductions');
  assert.deepEqual(h.a.calls.write[0].body, { amount: 17, expectedRevision: '7', visibleReason: '本次人工扣分，用户可见' });
  assert.match(h.a.calls.write[0].key, /^idem_[a-f0-9]{32}$/); assert.equal(h.a.data.credit.score, 53); assert.equal(browser.document.querySelector('[role="dialog"]'), null);
});

test('a read-only role sees records without deduction or correction controls', async t => {
  const h = await mount(t, { writable: false }); await waitFor(() => h.host.querySelector('table'));
  assert.equal(button('手动扣分'), undefined); assert.equal(button('更正这笔扣分：核实后的扣分说明'), undefined); assert.equal(h.a.calls.write.length, 0);
  assert.equal(button('号主保证金与收退记录'), undefined); assert.equal(h.historyCalls.length, 0);
});

test('unavailable browser storage refuses a write before contacting the API', async t => {
  const h = await mount(t); await openDeduction();
  globalThis.sessionStorage = { getItem: browser.sessionStorage.getItem.bind(browser.sessionStorage), setItem() { throw Error('synthetic storage unavailable'); }, removeItem: browser.sessionStorage.removeItem.bind(browser.sessionStorage) };
  await click(button('确认扣分')); assert.equal(h.a.calls.write.length, 0); assert.match(h.host.textContent, /尚未提交/);
});

test('an unknown response survives remount and retries the identical path, body and key', async t => {
  const h = await mount(t, { unknown: true }); await openDeduction(); await click(button('确认扣分'));
  await waitFor(() => button('核对原操作')); const original = h.a.calls.write[0]; assert.ok(button('手动扣分').disabled);
  await h.remount(); await waitFor(() => button('核对原操作')); await click(button('核对原操作')); await waitFor(() => h.changes() === 1);
  assert.equal(h.a.calls.write.length, 2); assert.deepEqual(h.a.calls.write[1], original); assert.equal(h.a.data.credit.score, 53);
});

test('accepted write with failed readback survives remount and only rereads', async t => {
  const h = await mount(t, { readbackFails: true }); await openDeduction(); await click(button('确认扣分'));
  await waitFor(() => button('重新读取')); assert.equal(h.a.calls.write.length, 1);
  assert.equal(JSON.parse(browser.sessionStorage.getItem(browser.sessionStorage.key(0))).phase, 'readback');
  await h.remount(); await waitFor(() => button('重新读取')); await click(button('重新读取')); await waitFor(() => h.changes() === 1);
  assert.equal(h.a.calls.write.length, 1); assert.equal(browser.sessionStorage.length, 0);
});

test('correction targets the original manual event and uses a visible reason without arbitrary points', async t => {
  const h = await mount(t); await waitFor(() => button('更正这笔扣分：核实后的扣分说明')); await click(button('更正这笔扣分：核实后的扣分说明'));
  await waitFor(() => browser.document.querySelector('[aria-label="更正说明"]')); assert.equal(browser.document.querySelector('[aria-label="扣分数量"]'), null);
  await fill(browser.document.querySelector('[aria-label="更正说明"]'), '复核后确认误扣，进行更正'); await click(button('确认更正')); await waitFor(() => h.changes() === 1);
  assert.equal(h.a.calls.write[0].url, 'users/synthetic-user/deductions/synthetic-deduction/reverse');
  assert.deepEqual(h.a.calls.write[0].body, { expectedRevision: '7', visibleReason: '复核后确认误扣，进行更正' }); assert.equal(h.a.data.credit.score, 80);
});

test('inactive or locked content does not read or expose credit fields', async t => {
  const h = await mount(t); await waitFor(() => h.host.querySelector('table')); const before = h.a.calls.read.length;
  await h.active(false); assert.equal(h.host.textContent, ''); assert.equal(h.a.calls.read.length, before);
  await h.active(true); await waitFor(() => h.host.querySelector('table')); assert.ok(h.a.calls.read.length > before);
});

test('late accepted response is bound to the old user and cannot overwrite the next user', async t => {
  const a = adapter(); const originalWrite = a.creditDecide; let finish;
  a.creditDecide = (...args) => new Promise(resolve => { finish = async () => resolve(await originalWrite(...args)); });
  const h = await mount(t, { adapter: a }); await openDeduction(); await click(button('确认扣分'));
  await h.subject({ id: 'synthetic-other-user', name: '另一用户' }); await waitFor(() => h.host.textContent.includes('41'));
  await act(async () => finish()); await settle(); assert.equal(h.changes(), 0); assert.equal(h.host.textContent.includes('等待读取记录'), false); assert.match(h.host.textContent, /41/);
  assert.equal(JSON.parse(browser.sessionStorage.getItem(browser.sessionStorage.key(0))).phase, 'readback');
});

test('credit history pages the complete returned collection using the common pagination', async t => {
  const a = adapter(); a.data.credit.events = Array.from({ length: 45 }, (_, index) => ({ ...deductionEvent, id: `synthetic-row-${index}`, visibleReason: `扣分说明第${index + 1}条` }));
  const h = await mount(t, { adapter: a }); await waitFor(() => h.host.querySelectorAll('tbody tr').length === 20);
  assert.match(h.host.textContent, /共 45 条记录/); await click(button('下一页')); assert.match(h.host.querySelector('tbody').textContent, /扣分说明第21条/);
  await click(button('末页')); assert.equal(h.host.querySelectorAll('tbody tr').length, 5); assert.equal(a.calls.read.length, 1, 'paging a complete credit snapshot does not repeat business reads');
});

test('an accepted event missing from the next projection remains pending until an exact readback finds it', async t => {
  const a = adapter(); const read = a.credit; const write = a.creditDecide; let hide = false;
  a.creditDecide = async (...args) => { const result = await write(...args); hide = true; return result; };
  a.credit = async id => { const result = await read(id); if (hide) result.credit.events = result.credit.events.filter(item => !item.id.startsWith('synthetic-event-')); return result; };
  const h = await mount(t, { adapter: a }); await openDeduction(); await click(button('确认扣分')); await waitFor(() => button('重新读取'));
  assert.equal(h.changes(), 0); assert.equal(a.calls.write.length, 1); hide = false;
  await click(button('重新读取')); await waitFor(() => h.changes() === 1); assert.equal(a.calls.write.length, 1);
});

test('permission rejection during original UNKNOWN recovery cannot discard the stored responsibility', async t => {
  const a = adapter(); a.creditDecide = async (url, body, _signal, key) => { a.calls.write.push({ url, body, key }); throw new AdminApiError(a.calls.write.length === 1 ? 0 : 403, 'FORBIDDEN'); };
  await mount(t, { adapter: a }); await openDeduction(); await click(button('确认扣分')); await waitFor(() => button('核对原操作'));
  const stored = browser.sessionStorage.getItem(browser.sessionStorage.key(0)); await click(button('核对原操作'));
  assert.equal(browser.sessionStorage.getItem(browser.sessionStorage.key(0)), stored); assert.ok(button('手动扣分').disabled); assert.deepEqual(a.calls.write[1], a.calls.write[0]);
});

test('a second mounted panel cannot replace an unresolved original intent or key', async t => {
  const a = adapter(); const write = a.creditDecide; const queue = [];
  a.creditDecide = (...args) => new Promise(resolve => queue.push(async () => resolve(await write(...args))));
  const h = await mount(t, { adapter: a });
  const secondHost = browser.document.createElement('div'); browser.document.body.append(secondHost); const secondRoot = createRoot(secondHost);
  t.after(async () => { await act(async () => secondRoot.unmount()); secondHost.remove(); });
  await act(async () => secondRoot.render(createElement(CreditPanel, { adapter: a, user: { id: 'synthetic-user', name: '测试用户' }, refreshNonce: 0 }))); await settle();
  await openDeduction(); await click(button('确认扣分')); const original = browser.sessionStorage.getItem(browser.sessionStorage.key(0));
  const secondOpen = [...secondHost.querySelectorAll('button')].find(item => item.textContent.trim() === '手动扣分'); await click(secondOpen);
  await fill(browser.document.querySelector('[aria-label="扣分数量"]'), '18'); await fill(browser.document.querySelector('[aria-label="扣分说明"]'), '第二窗口的不同扣分说明'); await click(button('确认扣分'));
  assert.equal(queue.length, 1); assert.equal(browser.sessionStorage.getItem(browser.sessionStorage.key(0)), original); assert.match(secondHost.textContent, /上一笔操作/);
  await act(async () => queue[0]()); await waitFor(() => h.changes() === 1); assert.equal(a.calls.write.length, 1);
});

test('guarantee details preserve every payment and refund attempt without exposing command buttons', async t => {
  const a = adapter({ guaranteeRead: true });
  a.data.transactions = [{ requirementId: 'synthetic-requirement', accountId: 'synthetic-account', paymentHistory: [
    { id: 'synthetic-pay-1', status: 'FAILED', amountCents: '500', merchantOrderNo: 'synthetic-merchant-1' },
    { id: 'synthetic-pay-2', status: 'CONFIRMED', amountCents: '500', observedAmountCents: '500', merchantOrderNo: 'synthetic-merchant-2' },
  ], refundHistory: [{ id: 'synthetic-refund-1', status: 'FAILED', amountCents: '500' }, { id: 'synthetic-refund-2', status: 'UNKNOWN', amountCents: '500' }] }];
  a.data.recoveryRequests = [{ id: 'synthetic-recovery', status: 'PENDING', reason: '等待人工复核', createdAt: '2026-10-22T00:00:00Z', decisionReason: null }];
  const h = await mount(t, { adapter: a }); await waitFor(() => button('号主保证金与收退记录')); await click(button('号主保证金与收退记录'));
  await waitFor(() => button('支付尝试 2 笔')); await click(button('支付尝试 2 笔')); await click(button('退款尝试 2 笔'));
  for (const ref of ['synthetic-merchant-1', 'synthetic-merchant-2', 'synthetic-refund-1', 'synthetic-refund-2']) assert.ok(h.host.textContent.includes(ref), ref);
  assert.match(h.host.textContent, /资格、收退记录与渠道到账分别核对/); assert.match(h.host.textContent, /待核/);
  await click(button('恢复申请')); assert.match(h.host.textContent, /待审核/);
  for (const command of ['批准 +10', '驳回', '允许原路退还', '发起支付', '发起退款']) assert.equal(button(command), undefined, command);
  assert.equal(a.calls.write.length, 0); assert.equal(h.historyCalls.length, 1);
});

test('guarantee history remains independently readable after the credit reader fails, and denied roles do not fetch it', async t => {
  const a = adapter({ guaranteeRead: true }); a.credit = async () => { throw new AdminApiError(503, 'INTERNAL_ERROR'); };
  const h = await mount(t, { adapter: a }); await waitFor(() => h.host.textContent.includes('信用记录读取失败'));
  await click(button('保证金来源记录')); await waitFor(() => h.host.textContent.includes('号主保证金历史来源'));
  assert.equal(h.historyCalls.length, 1); assert.equal(h.historyCalls[0].path, '/api/bff/admin/credit/users/synthetic-user/guarantee-history');
  await h.active(false); assert.equal(h.host.textContent, ''); assert.equal(h.historyCalls.length, 1);
});

test('legacy unresolved credit intent stays preserved without enabling its closed historical writer', async t => {
  const a = adapter(); const h = await mount(t, { adapter: a, initialIntent: current => ({ subject: `${current.snapshot.adminUserId}:${current.snapshot.session.id}:synthetic-user`, path: 'breaches', body: { userId: 'synthetic-user', sourceType: 'ORDER', sourceId: 'synthetic-order', visibleReason: '历史待核说明' }, key: 'synthetic-original-key', generation: 11, persisted: true, phase: 'unknown' }) });
  await waitFor(() => h.host.textContent.includes('历史操作暂不支持再次提交')); assert.equal(button('核对原操作'), undefined); assert.ok(button('手动扣分').disabled);
  await h.remount(); await waitFor(() => h.host.textContent.includes('历史操作暂不支持再次提交')); assert.equal(a.calls.write.length, 0); assert.equal(JSON.parse(browser.sessionStorage.getItem(browser.sessionStorage.key(0))).key, 'synthetic-original-key');
});
