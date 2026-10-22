import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Follow the existing directory harness while exercising the new detail and actual BFF adapter.
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/users/synthetic-user-uuid-040e81c3dc9b' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'localStorage', 'sessionStorage']) globalThis[name] = name === 'window' ? browser : browser[name];
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({ root: rootPath, configFile: false, plugins: [react()], resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { UserDetail } = await vite.ssrLoadModule('/src/views/user-directory/user-directory-detail.tsx');
const { UserDirectoryBff } = await vite.ssrLoadModule('/src/views/user-directory/user-directory-data.ts');
const { tabFromLocation } = await vite.ssrLoadModule('/src/workspace/tab-model.ts');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const subject = 'synthetic-user-uuid-040e81c3dc9b';
const defaultPermissions = ['user.directory.read', 'order.read', 'supply.rental_account.read', 'membership.growth.read.summary', 'credit.read', 'user.wallet.read'];
const money = amount => ({ currency: 'CNY', unit: 'yuan', scale: 2, amount });
const rawUser = {
  userId: subject, name: '测试用户林舟', image: null, username: null, displayUsername: null, maskedPhone: '188****1101', maskedEmail: null, phoneNumberVerified: false,
  accountStatus: 'ACTIVE', suspended: false, identityStatus: 'VERIFIED', ageStatus: 'ADULT', identity: { status: 'VERIFIED', ageStatus: 'ADULT', provider: 'legacy_mysql_restore', verifiedAt: null },
  source: { kind: 'MIGRATED', legacyId: '880001', sourceCreatedAt: '2017-01-02T00:00:00Z', sourceUpdatedAt: null },
  registeredAt: '2018-05-06T03:20:00Z', registeredAtSource: 'LEGACY', createdAt: '2026-10-12T04:00:00Z', localCreatedAt: '2026-10-12T04:00:00Z', updatedAt: '2026-10-22T04:00:00Z', localUpdatedAt: '2026-10-22T04:00:00Z',
  resourceSummary: { state: 'ready', count: 99, publishedCount: 2 }, orderSummary: { state: 'ready', currentCount: 3, renterCurrentCount: 1, ownerCurrentCount: 2 },
  membershipSummary: { state: 'ready', growth: { knowledge: 'KNOWN', effectiveTier: 'STANDARD' }, entitlements: [] }, creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 80, revision: '1' },
  walletSummary: { state: 'ready', amountCents: '15000' }, riskFlag: false, riskRevision: 0, lastBusinessActivity: { state: 'not_connected', domains: ['ORDER', 'SUPPLY'] },
};
const order = index => ({ orderId: `synthetic-order-${index}`, displayNo: `SYNTHETIC-ORDER-${index}`, accountId: 'synthetic-account', accountDisplayNo: 'SYNTHETIC-ACCOUNT-001', status: 'PAID', role: index % 2 ? 'owner' : 'renter', title: '订单快照', counterpartyName: '交易另一方', gameId: 'delta', createdAt: '2026-10-22T01:00:00Z', paidAt: '2026-10-22T01:01:00Z', cancelledAt: null, cancelReason: null,
  amounts: { rental: money('60.00'), deposit: money('100.00'), totalDue: money('160.00') }, payment: { state: 'RECORDED_PAID' } });
const resource = { accountId: 'synthetic-account', displayNo: 'SYNTHETIC-ACCOUNT-001', lifecycle: 'ACTIVE', ownerPaused: true, staffRestricted: false, legacyHold: 'NONE', game: { id: 'delta', name: '三角洲行动' }, publication: { currentlyPublished: true, versionPublished: false } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const failure = status => json({ error: { code: status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', requestId: 'synthetic-layout-request' } }, status);
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function waitFor(fn) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw Error('Detail layout condition timed out'); await settle(); } }
const namedButton = (name, within = browser.document) => [...within.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') || item.textContent.trim()) === name);
const region = label => browser.document.querySelector(`[role="region"][aria-label="${label}"]`);
async function click(element) { assert.ok(element, 'expected the requested control'); await act(async () => element.click()); await settle(); }
let serial = 0;
async function mount(t, options = {}) {
  browser.localStorage.clear(); browser.sessionStorage.clear(); browser.history.replaceState(null, '', `/users/${subject}${options.section ? `?section=${options.section}` : ''}`);
  const calls = [], opened = [];
  let detailStatus = options.detailStatus ?? null, releaseDetail, forceRefresh;
  const snapshot = { authenticated: true, adminUserId: `synthetic-layout-admin-${++serial}`, user: { name: '只读测试管理员', username: 'SYNTHETIC-ADMIN', twoFactorEnabled: true }, security: { status: 'ACTIVE', isBoss: false, passwordChangeRequired: false }, session: { id: `synthetic-layout-session-${serial}`, locked: false, pinConfigured: true }, permissions: options.permissions ?? defaultPermissions };
  const adapter = new UserDirectoryBff(snapshot);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url), browser.location.href); const params = Object.fromEntries(address.searchParams); calls.push({ pathname: address.pathname, params, method: init.method ?? 'GET', body: init.body });
    assert.equal(init.method === 'POST' || init.method === 'DELETE', false, 'layout checks must not issue commands');
    if (address.pathname === `/api/bff/admin/users/${subject}`) {
      if (detailStatus) return failure(detailStatus);
      const reply = () => json({ user: { ...structuredClone(rawUser), ...options.user } });
      if (options.deferDetail && !releaseDetail) return new Promise(resolve => { releaseDetail = () => resolve(reply()); });
      return reply();
    }
    if (address.pathname.endsWith('/orders')) {
      const capacity = Number(params.limit ?? '20'); const next = params.cursor === 'synthetic-next-order-page';
      return json({ items: next ? [order(91)] : Array.from({ length: Math.min(capacity, 6) }, (_, index) => order(index)), nextCursor: options.orderNext && !next ? 'synthetic-next-order-page' : null, limit: capacity });
    }
    if (address.pathname.endsWith('/rental-accounts')) return json({ items: [resource], nextCursor: null, limit: Number(params.limit ?? '20') });
    if (address.pathname.endsWith('/notes')) return json({ items: [{ id: 'synthetic-note', text: '这是一条后台处理备注', author: { id: 'synthetic-note-author', displayName: '运营小林' }, createdAt: '2026-10-22T02:00:00Z', canDelete: false }], nextCursor: null, capabilities: { canCreate: false, canManage: false } });
    if (address.pathname.endsWith('/membership-growth')) return json({ subjectId: subject, authorizationState: 'SUMMARY_AUTHORIZED', growth: { knowledge: 'KNOWN', effectiveTier: 'SILVER', rollingPoints: '120', lifetimePoints: '500', grace: null }, entitlements: [] });
    if (address.pathname.endsWith('/audit-events')) return json({ items: [], nextCursor: null, limit: 20 });
    throw Error(`Unexpected layout read: ${address.pathname}`);
  };
  const host = browser.document.createElement('div'); host.className = 'workspace-root'; browser.document.body.append(host); const root = createRoot(host);
  function Harness() {
    const [tab, setTab] = useState(tabFromLocation(browser.location.pathname, browser.location.search)); const [refresh, setRefresh] = useState(0); forceRefresh = () => setRefresh(value => value + 1);
    return createElement(UserDetail, { adapter, snapshot, tab, refreshNonce: refresh, onQueryChange: query => { browser.history.replaceState(null, '', `${tab.path}?${new URLSearchParams(query)}`); setTab({ ...tab, query }); }, onOpenPath: (target, title) => opened.push({ target, title }) });
  }
  t.after(async () => { globalThis.fetch = previousFetch; await act(async () => root.unmount()); host.remove(); await settle(); });
  await act(async () => root.render(createElement(Harness))); await settle();
  return { host, calls, opened, snapshot, releaseDetail: async () => { assert.ok(releaseDetail); await act(async () => releaseDetail()); await settle(); }, failDetail: status => { detailStatus = status; }, refresh: async () => { await act(async () => forceRefresh()); await settle(); } };
}

test('detail has seven correctly named House tabs and retains visited content while switching', async t => {
  const h = await mount(t); await waitFor(() => h.host.querySelector('[role="tablist"]'));
  assert.deepEqual([...h.host.querySelectorAll('[role="tab"]')].map(item => item.textContent), ['概览', '订单记录', '当前上架账号', '会员与礼遇', '信用', '资金', '账号安全']);
  const overview = region('概览'); await click(namedButton('订单记录')); await waitFor(() => region('订单记录'));
  assert.equal(overview.hidden, true); assert.equal(overview.isConnected, true); await click(namedButton('概览')); assert.equal(region('概览'), overview); assert.equal(overview.hidden, false);
});

test('overview shows the original registration date without UUID, age or local filing noise', async t => {
  const h = await mount(t); await waitFor(() => h.host.querySelector('h1'));
  assert.equal(h.host.querySelector('h1').textContent, rawUser.name); const header = h.host.querySelector('.udv-user-header');
  assert.match(header.textContent, /2018[/-]05[/-]06/); assert.equal(header.textContent.includes('2026'), false);
  for (const noise of [subject, '年龄', '成年', '本平台建档', '2017', '880001']) assert.equal(h.host.textContent.includes(noise), false, noise);
  assert.equal(h.calls.find(call => call.pathname === `/api/bff/admin/users/${subject}`).params.registrationTime, 'ORIGINAL');
  assert.ok(h.host.querySelector(`[aria-label="复制用户ID：${rawUser.name}"]`));
});

test('missing identity details and registration facts stay unavailable rather than invented', async t => {
  const h = await mount(t, { user: { registeredAt: null, registeredAtSource: 'UNKNOWN', walletSummary: { state: 'unknown' }, membershipSummary: { state: 'ready', growth: { knowledge: 'UNKNOWN', effectiveTier: null }, entitlements: [] } } });
  await waitFor(() => h.host.querySelector('.udv-identity'));
  const identity = h.host.querySelector('.udv-identity'); assert.equal(identity.querySelectorAll('dd')[0].textContent, '暂无资料'); assert.equal(identity.querySelectorAll('dd')[1].textContent, '暂无资料');
  assert.match(identity.textContent, /188\*\*\*\*1101/); assert.equal(namedButton('查看明文'), undefined); assert.match(h.host.querySelector('.udv-user-header').textContent, /待核/);
  assert.equal(h.host.querySelector('.udv-user-header').textContent.includes('2026'), false); assert.equal(h.host.querySelector('.udv-wallet strong').textContent, '待核'); assert.equal(h.host.textContent.includes('普通会员'), false);
});

test('overview requests only five recent orders and keeps comments read-only', async t => {
  const h = await mount(t); await waitFor(() => region('概览')?.querySelectorAll('tbody tr').length === 5);
  const orders = h.calls.filter(call => call.pathname.endsWith('/orders')); assert.equal(orders.length, 1); assert.equal(orders[0].params.limit, '5');
  assert.match(region('概览').textContent, /后台处理备注/); assert.equal(namedButton('添加备注'), undefined); assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('order tab sends real cursor and capacity changes, resetting the cursor for a new capacity', async t => {
  const h = await mount(t, { section: 'orders', orderNext: true }); await waitFor(() => region('订单记录')?.querySelector('table'));
  assert.equal(h.calls.find(call => call.pathname.endsWith('/orders')).params.limit, '20'); await click(namedButton('下一页', region('订单记录')));
  await waitFor(() => h.calls.some(call => call.params.cursor === 'synthetic-next-order-page')); await waitFor(() => region('订单记录')?.querySelector('tbody')?.textContent.includes('SYNTHETIC-ORDER-91'));
  await click(namedButton('每页容量', region('订单记录'))); await waitFor(() => browser.document.querySelector('[role="option"]'));
  const fifty = [...browser.document.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === '50 条/页'); await click(fifty);
  await waitFor(() => h.calls.some(call => call.pathname.endsWith('/orders') && call.params.limit === '50'));
  const latest = h.calls.filter(call => call.pathname.endsWith('/orders')).at(-1); assert.equal(latest.params.cursor, undefined); assert.equal(latest.params.limit, '50');
});

test('current accounts use the published collection and retain an owner-paused publication fact', async t => {
  const h = await mount(t, { section: 'resources' }); await waitFor(() => region('当前上架账号')?.querySelector('tbody tr'));
  const read = h.calls.find(call => call.pathname.endsWith('/rental-accounts')); assert.equal(read.params.publication, 'published'); assert.equal(read.params.limit, '20');
  assert.match(region('当前上架账号').textContent, /号主暂停/); assert.match(region('当前上架账号').textContent, /已上架/);
  assert.equal(h.host.querySelector('.udv-business').textContent.includes('99'), false); assert.match(h.host.querySelector('.udv-business').textContent, /上架\s*2/);
});

test('permission-scoped detail does not request resource facts or expose wallet and write controls', async t => {
  const h = await mount(t, { section: 'resources', permissions: ['user.directory.read'] }); await waitFor(() => region('当前上架账号')?.textContent.includes('无权限'));
  assert.equal(h.calls.some(call => call.pathname.endsWith('/rental-accounts')), false); assert.equal(h.host.querySelector('.udv-wallet'), null); assert.equal(h.host.querySelector('.udv-business').textContent, '');
  for (const name of ['标记高危', '取消高危标记', '查看明文', '处理账号', '添加备注']) assert.equal(namedButton(name), undefined, name);
});

test('membership handling preserves the exact user and return context', async t => {
  const h = await mount(t, { section: 'growth', permissions: [...defaultPermissions, 'membership.entitlement.request'] }); await waitFor(() => namedButton('办理此用户礼遇'));
  await click(namedButton('办理此用户礼遇')); const opened = new URL(h.opened.at(-1).target, browser.location.href);
  assert.equal(opened.pathname, '/membership-growth'); assert.equal(opened.searchParams.get('userId'), subject); assert.equal(opened.searchParams.get('fromUserId'), subject); assert.equal(opened.searchParams.get('fromUserSection'), 'growth');
  assert.equal(h.calls.filter(call => call.pathname.endsWith('/membership-growth')).length, 1);
});

test('first-load skeleton reserves the detail and failure has a visible retry before any user facts', async t => {
  const loading = await mount(t, { deferDetail: true }); assert.ok(loading.host.querySelector('[aria-label="正在读取用户信息"]')); assert.equal(loading.host.querySelector('h1'), null); assert.equal(loading.calls.length, 1);
  await loading.releaseDetail(); await waitFor(() => loading.host.querySelector('h1'));
});

test('initial reader rejection shows no user facts; a fresh retry restores the real page', async t => {
  const h = await mount(t, { detailStatus: 503 }); await waitFor(() => h.host.querySelector('[role="alert"]'));
  assert.match(h.host.textContent, /用户详情加载失败/); assert.equal(h.host.querySelector('.ud-detail'), null); assert.equal(h.calls.some(call => call.pathname.endsWith('/notes') || call.pathname.endsWith('/orders')), false);
  h.failDetail(null); await click(namedButton('重试')); await waitFor(() => h.host.querySelector('h1')); assert.equal(h.host.querySelector('h1').textContent, rawUser.name);
});

test('refresh network failure stays at the top and preserves readable facts, while permission rejection clears them', async t => {
  const h = await mount(t); await waitFor(() => h.host.querySelector('h1')); h.failDetail(503); await h.refresh(); await waitFor(() => h.host.querySelector('[role="alert"]'));
  assert.equal(h.host.querySelector('.ud-detail').firstElementChild.getAttribute('role'), 'alert'); assert.equal(h.host.querySelector('h1').textContent, rawUser.name);
  h.failDetail(403); await h.refresh(); await waitFor(() => h.host.querySelector('[role="alert"]'));
  assert.equal(h.host.querySelector('h1'), null, 'server-side permission loss must not retain the cached user facts'); assert.equal(h.host.querySelector('.udv-wallet'), null);
});
