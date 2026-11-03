import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createOfflineAdminSource } from './offline-admin-source.mjs';

const summary = (patch = {}) => ({ schema: 'admin.domain-summary.v1', domain: 'USERS', state: 'KNOWN', reason: null, asOf: '2026-11-03T02:03:04.123456Z', total: '9007199254740997', coverage: 'FULL_AUTHORIZED_FILTER_SET', drilldown: { filters: { page: '1' } },
  statuses: ['ACTIVE', 'RESTRICTED', 'FROZEN', 'CANCELLED', 'UNKNOWN'].map((status, i) => ({ status, count: i ? '1' : '9007199254740993', drilldown: status === 'UNKNOWN' ? null : { filters: { accountStatus: status, page: '1' } } })), membership: { state: 'UNKNOWN', reason: 'MEMBERSHIP_DISTRIBUTION_NOT_IMPLEMENTED', counts: null }, ...patch });
async function mount(t, value = summary(), override = {}) {
  const browser = new Window({ url: 'http://127.0.0.1:4221/users' });
  for (const key of ['document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'SVGElement']) if (browser[key]) globalThis[key] = browser[key];
  Object.assign(globalThis, { window: browser, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
  browser.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 220, width: 640, height: 220 });
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL('../../../', import.meta.url)) });
  const { DomainSummaryBlock } = await source.ssrLoadModule('/apps/admin/src/components/dashboard/domain-summary-block.tsx');
  const model = await source.ssrLoadModule('/apps/admin/src/components/dashboard/domain-summary-model.ts');
  const { createRoot } = await import('react-dom/client');
  const node = browser.document.createElement('div'); browser.document.body.append(node); const root = createRoot(node), clicks = [], reads = [];
  let props = { domain: 'USERS', identity: 'admin-session-a', queryKey: '', read: async signal => { reads.push(signal); return model.parseDomainSummary(value, 'USERS'); }, onStatus: status => clicks.push(status), refreshNonce: 0, ...override };
  const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(setImmediate); }); };
  const render = async (next = {}) => { props = { ...props, ...next }; await act(async () => root.render(createElement(DomainSummaryBlock, props))); await settle(); };
  t.after(async () => { await act(async () => root.unmount()); await source.close(); node.remove(); await browser.happyDOM.abort(); });
  await render();
  const renderOther = async (Component, next) => { await act(async () => root.render(createElement(Component, next))); await settle(); };
  return { node, model, source, browser, render, renderOther, settle, clicks, reads, button: text => [...node.querySelectorAll('button')].find(button => button.textContent === text) };
}

test('full-set counts preserve precision, Beijing server time and status meanings without page totals', async t => {
  const h = await mount(t);
  assert.match(h.node.textContent, /9,007,199,254,740,997/);
  assert.match(h.node.textContent, /9,007,199,254,740,993/);
  assert.equal(h.node.querySelector('time').dateTime, '2026-11-03T02:03:04.123456Z');
  assert.match(h.node.textContent, /10:03:04/);
  assert.match(h.node.textContent, /会员等级分布暂不可用/);
  assert.doesNotMatch(h.node.textContent, /50k|15\.2|API_CAPACITY|可正常交易|待交付|已完成结算/);
  const active = h.node.querySelector('[aria-label="筛选正常：9,007,199,254,740,993"]');
  await act(async () => active.click()); assert.deepEqual(h.clicks, ['ACTIVE']);
  assert.equal(h.button('状态待核1').disabled, true);
});

test('known empty is zero; partial/unknown/forbidden never become zero and show no stale statistics', async t => {
  const h = await mount(t, summary({ total: '0', statuses: summary().statuses.map(s => ({ ...s, count: '0' })) }));
  assert.match(h.node.textContent, /用户总数0/);
  await h.render({ identity: 'new-session', read: async () => summary({ state: 'UNKNOWN', total: null, statuses: null, coverage: null, reason: 'USER_GAME_SCOPE_AGGREGATE_NOT_SUPPORTED' }) });
  assert.match(h.node.textContent, /归属尚不能完整核定/); assert.doesNotMatch(h.node.textContent, /用户总数0/);
  await h.render({ identity: 'another-session', read: async () => summary({ state: 'FORBIDDEN', total: null, statuses: null, coverage: null }) });
  assert.match(h.node.textContent, /当前权限不含这组统计/); assert.doesNotMatch(h.node.textContent, /9,007/);
});

test('malformed or rounded aggregate is rejected instead of presented as a known zero', async t => {
  const h = await mount(t);
  for (const broken of [summary({ total: 0 }), summary({ total: '0' }), summary({ asOf: 'today' }), summary({ statuses: [] }), summary({ state: 'UNKNOWN' })]) assert.throws(() => h.model.parseDomainSummary(broken, 'USERS'), /格式无效/);
  await h.render({ identity: 'bad-response', read: async () => { throw new Error('private raw failure'); } });
  assert.match(h.node.textContent, /状态概览暂时无法读取/); assert.doesNotMatch(h.node.textContent, /private raw|用户总数0/);
});

test('collapse is remembered and identity/filter change aborts the original read; stale result cannot render', async t => {
  let finish, originalSignal;
  const h = await mount(t, summary(), { read: signal => { originalSignal = signal; return new Promise(resolve => { finish = resolve; }); } });
  await act(async () => h.button('收起').click()); assert.equal(h.browser.localStorage.getItem('zzsh:domain-summary:USERS'), 'collapsed');
  await h.render({ identity: 'changed', queryKey: 'accountStatus=FROZEN', read: async () => summary({ state: 'NO_GAME_SCOPE', total: null, statuses: null, coverage: null }) });
  assert.equal(originalSignal.aborted, true);
  finish(summary()); await h.settle();
  await act(async () => h.button('展开').click());
  assert.match(h.node.textContent, /尚未分配可读取的游戏范围/); assert.doesNotMatch(h.node.textContent, /9,007/);
});

test('chart uses real Recharts bar payload; click and keyboard-accessible count share the same state filter', async t => {
  const h = await mount(t, summary({ total: '5', statuses: summary().statuses.map(s => ({ ...s, count: '1' })) }));
  const bar = h.node.querySelector('.recharts-bar-rectangle path');
  assert.ok(bar, 'real bar renders with measured width');
  await act(async () => bar.dispatchEvent(new h.browser.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(h.clicks, ['ACTIVE']);
  const frozen = h.node.querySelector('[aria-label="筛选已冻结：1"]');
  await act(async () => frozen.click()); assert.deepEqual(h.clicks, ['ACTIVE', 'FROZEN']);
});

test('list and summary reuse identical applied field/time predicates, without a cursor or snapshot token', async t => {
  const h = await mount(t);
  const { UserDirectoryBff, EMPTY_FILTERS, userDirectoryFilterQuery } = await h.source.ssrLoadModule('/apps/admin/src/views/user-directory/user-directory-data.ts');
  const { adminOrderListQuery } = await h.source.ssrLoadModule('/apps/admin/src/views/admin-order-chain-view.tsx');
  const filters = { ...EMPTY_FILTERS, q: '用户名称', status: 'FROZEN', from: '2026-11-01', to: '2026-11-02', tier: 'DIAMOND', creditMin: '20' };
  const summaryQuery = userDirectoryFilterQuery(filters);
  const previousFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async url => { calls.push(new URL(url, h.browser.location.origin)); return new Response(JSON.stringify({ paginationMode: 'page', items: [], page: 1, pageSize: 20, total: 0, contextKey: 'a'.repeat(64), nextCursor: null, limit: 20 }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = previousFetch; });
  await new UserDirectoryBff({ permissions: ['user.directory.read'] }).list(filters, { page: 1, pageSize: 20 }, new AbortController().signal);
  const actual = calls[0].searchParams; actual.delete('page'); actual.delete('pageSize');
  assert.deepEqual([...actual], [...summaryQuery]);
  assert.equal(summaryQuery.get('registeredBefore'), '2026-11-03T00:00:00+08:00');
  const order = { kind: 'account', q: 'ZZ000123', status: 'PAID', origin: '', from: '2026-11-01', to: '2026-11-02', fundsResolution: '', paymentOpen: '', createdFrom: '', createdTo: '', paymentConfirmedFrom: '2026-11-01T00:00:00+08:00', paymentConfirmedTo: '2026-11-03T00:00:00+08:00' };
  const listOrderQuery = adminOrderListQuery(order, 6, 20, 'b'.repeat(64)), summaryOrderQuery = adminOrderListQuery(order, 1, 20);
  listOrderQuery.delete('restoreKey'); listOrderQuery.set('page', '1');
  assert.deepEqual([...listOrderQuery], [...summaryOrderQuery]);
  assert.equal(summaryOrderQuery.get('createdTo'), '2026-11-03T00:00:00+08:00');
  assert.equal(summaryOrderQuery.get('qKind'), 'account');
  assert.equal(summaryOrderQuery.has('restoreKey'), false);
});

test('production user list and production order list actually read server summaries and drill into page one', async t => {
  const h = await mount(t), calls = [], listCalls = [];
  const { UserList } = await h.source.ssrLoadModule('/apps/admin/src/views/user-directory/user-directory-list.tsx');
  const { AdminOrderChainView } = await h.source.ssrLoadModule('/apps/admin/src/views/admin-order-chain-view.tsx');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const address = new URL(url, h.browser.location.origin); calls.push(address);
    let data;
    if (address.pathname.endsWith('/users/overview-stats')) {
      const selected = address.searchParams.get('accountStatus');
      data = summary({ total: selected ? '1' : '5', statuses: summary().statuses.map(s => ({ ...s, count: !selected || s.status === selected ? '1' : '0' })) });
    } else if (address.pathname.endsWith('/orders/overview-stats')) data = summary({ domain: 'ORDERS', total: '4', membership: null,
      statuses: ['PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED', 'UNKNOWN'].map(status => ({ status, count: status === 'UNKNOWN' ? '0' : '1', drilldown: status === 'UNKNOWN' ? null : { filters: { page: '1', status } } })) });
    else data = { items: [], page: Number(address.searchParams.get('page') || 1), pageSize: 20, total: 4, contextKey: 'a'.repeat(64) };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const snapshot = { authenticated: true, adminUserId: 'summary-admin', session: { id: 'summary-session', locked: false }, security: { isBoss: true, status: 'ACTIVE', passwordChangeRequired: false }, permissions: ['order.read', 'user.directory.read'] };
  const adapter = { snapshot, has: () => true, list: async (filter, options) => { listCalls.push({ filter, options }); return { mode: 'page', rows: [], page: options.page, pageSize: 20, total: 5, contextKey: 'a'.repeat(64) }; } };
  await h.renderOther(UserList, { adapter, tab: { id: 'summary-users', query: { page: '6' } }, onQueryChange() {}, onOpenPath() {}, refreshNonce: 0 });
  assert.ok(calls.some(c => c.pathname.endsWith('/users/overview-stats')));
  assert.match(h.node.textContent, /用户总数5/);
  await act(async () => h.node.querySelector('[aria-label="筛选已冻结：1"]').click()); await h.settle();
  assert.equal(listCalls.at(-1).filter.status, 'FROZEN'); assert.equal(listCalls.at(-1).options.page, 1);
  assert.ok(calls.some(c => c.pathname.endsWith('/users/overview-stats') && c.searchParams.get('accountStatus') === 'FROZEN'));
  await h.renderOther(AdminOrderChainView, { snapshot, initialQuery: { page: '2' }, onOpenPath() {}, onQueryChange() {}, refreshNonce: 0 });
  assert.ok(calls.some(c => c.pathname.endsWith('/orders/overview-stats')));
  assert.match(h.node.textContent, /订单总数4/);
  await act(async () => h.node.querySelector('[aria-label="筛选已付款：1"]').click()); await h.settle();
  assert.ok(calls.some(c => c.pathname.endsWith('/orders') && c.searchParams.get('status') === 'PAID' && c.searchParams.get('page') === '1'));
  assert.doesNotMatch(h.node.textContent, /已完成结算|已付款待交付/);
});
