import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4301/users/user_normal' });
browser.matchMedia = (query) => {
  const max = query.match(/max-width:\s*(\d+)px/);
  return { media: query, matches: max ? false : false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} };
};
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'localStorage', 'sessionStorage']) globalThis[name] = name === 'window' ? browser : browser[name];
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  root: rootPath,
  cacheDir: path.resolve(rootPath, '../../tmp/admin-test-cache/workspace-origin-links'),
  configFile: false,
  plugins: [
    react(),
    {
      name: "origin-links-workbench-stub",
      enforce: "pre",
      resolveId(id, importer) {
        const normalized = id.replaceAll("\\", "/");
        const fromPageContent = importer?.replaceAll("\\", "/").endsWith("/src/workspace/page-content.tsx");
        if (fromPageContent && id === './settings-page') return '\0settings-preview-host-stub';
        if (fromPageContent && id === './account-security-page') return '\0account-security-host-stub';
        return (normalized.endsWith("/src/workspace/workbench.tsx") || ((id === "./workbench" || id === "./workbench.tsx") && fromPageContent)) ? "\0origin-links-workbench-stub" : undefined;
      },
      load(id) {
        // Routing tests keep leaf UI isolated; their behavior has dedicated component suites.
        if (id === '\0settings-preview-host-stub') return 'import {createElement} from "react"; export function SettingsWorkspace(){return createElement("div",null,"新版设置五分区")}';
        if (id === '\0account-security-host-stub') return 'import {createElement} from "react"; export function AccountSecurityPage(p){return createElement("section",null,"修改登录密码",createElement("button",{onClick:p.onLock},"立即锁定当前会话"))}';
        if (id !== "\0origin-links-workbench-stub") return undefined;
        return `import { createElement } from "react";
export function WorkbenchPage() { return createElement("div", { "data-stub": "workbench" }); }
export default WorkbenchPage;`;
      },
    },
  ],
  resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { WorkspacePageContent } = await vite.ssrLoadModule('/src/workspace/page-content.tsx');
const { tabFromLocation, tabHref, upsertTab } = await vite.ssrLoadModule('/src/workspace/tab-model.ts');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = { userId: 'user_normal', name: '林舟', image: null, username: null, displayUsername: null, maskedPhone: '188****1101', accountStatus: 'ACTIVE', suspended: false, identityStatus: 'UNKNOWN', ageStatus: 'UNKNOWN', source: { kind: 'MIGRATED', legacyId: '88001' }, registeredAt: '2026-09-24T04:00:00Z', registeredAtSource: 'LOCAL', createdAt: '2026-09-24T04:00:00Z', updatedAt: '2026-09-24T04:00:00Z', localCreatedAt: '2026-09-24T04:00:00Z', resourceSummary: { state: 'ready', count: 1, publishedCount: 1 }, orderSummary: { state: 'ready', currentCount: 1 }, lastBusinessActivity: { state: 'not_connected', domains: ['ORDER', 'SUPPLY'] } };
const order = { orderId: 'order_cancel', displayNo: 'TEST-1003', status: 'CANCELLED', role: 'renter', title: '订单快照', counterpartyName: '另一方', gameId: 'delta', amounts: { rental: { currency: 'CNY', unit: 'yuan', amount: '60.00', scale: 2 }, deposit: { currency: 'CNY', unit: 'yuan', amount: '100.00', scale: 2 }, totalDue: { currency: 'CNY', unit: 'yuan', amount: '160.00', scale: 2 } }, createdAt: user.createdAt, paidAt: null, cancelledAt: user.createdAt, cancelReason: '支付后取消', expiredAwaitingCancel: false };

const loadedOrder = { id: 'order_cancel', displayNo: 'TEST-1003', status: 'CANCELLED', title: '订单快照', accountId: 'account_1', accountDisplayNo: null, gameId: 'delta', ownerUserId: 'user_owner', renterUserId: 'user_normal', ownerName: '号主', renterName: user.name, createdAt: user.createdAt, paidAt: null, payment: { state: 'UNKNOWN', recordedAt: null, recordedAmount: null }, amounts: order.amounts, source: { origin: 'LEGACY' } };
const readFixture = async (input) => {
  const url = new URL(String(input), browser.location.href);
  const admin = { id: 'admin-fixture', username: 'ZZ00002', name: '测试运营', status: 'ACTIVE', isBoss: false, roles: [], createdAt: '2026-09-24T04:00:00Z' };
  if (url.pathname.endsWith('/security/admins')) return json({ admins: [admin] });
  if (url.pathname.endsWith('/security/admins/detail')) return json({ ...admin, allowPermissions: [], denyPermissions: [], effectivePermissions: ['order.read'] });
  if (url.pathname.endsWith('/security/roles')) return json({ roles: [], permissions: [] });
  if (url.pathname.endsWith('/supply/games')) return json({ games: [] });
  if (url.pathname === '/api/bff/admin/users' || url.pathname === '/api/bff/admin/users/lookup') return json({ items: [user], nextCursor: null, limit: 20 });
  if (url.pathname === '/api/bff/admin/users/user_normal') return json({ user });
  if (/^\/api\/bff\/admin\/orders\/[^/]+$/.test(url.pathname)) return json({ order: { ...loadedOrder, id: url.pathname.split('/').at(-1), displayNo: url.pathname.endsWith('/order_cancel') ? 'TEST-1003' : 'TEST-OTHER' } });
  if (url.pathname.endsWith('/orders')) return json({ items: [order], nextCursor: null });
  if (url.pathname.endsWith('/rental-accounts')) return json({ items: [], nextCursor: null });
  if (url.pathname.endsWith('/audit-events')) return json({ items: [], nextCursor: null });
  return json({ error: { code: 'NOT_FOUND' } }, 404);
};
globalThis.fetch = readFixture;

async function settle(ms = 25) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(fn, timeout = 3000) { const until = Date.now() + timeout; while (!fn()) { if (Date.now() > until) throw new Error('Component condition timed out'); await settle(); } }
const namedButton = (name) => [...browser.document.querySelectorAll('button')].find((e) => (e.getAttribute('aria-label') || e.textContent.trim()) === name);
async function click(element) { assert.ok(element, 'expected clickable element'); await act(async () => element.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }))); await settle(); }
async function input(element, value) { assert.ok(element); await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new browser.Event('input', { bubbles: true })); }); await settle(); }

function snapshot(permissions, isBoss = false) {
  return { authenticated: true, adminUserId: 'admin-1', user: { name: '测试管理员', username: 'ZZ00001', twoFactorEnabled: true }, security: { status: 'ACTIVE', isBoss, passwordChangeRequired: false }, session: { id: 'session-1', locked: false, pinConfigured: true, createdAt: null, expiresAt: null }, permissions };
}

async function mount(t, initialTab, snap, followNavigation = false) {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  const queries = [];
  let locks = 0;
  let currentTab = initialTab, replaceTab, replaceSnapshot;
  function Harness() {
    const [tab, setTab] = useState(initialTab);
    const [actor, setActor] = useState(snap);
    currentTab = tab;
    replaceTab = setTab;
    replaceSnapshot = setActor;
    return createElement(WorkspacePageContent, {
      tab,
      snapshot: actor,
      idleMinutes: 10,
      onIdleMinutes: () => {},
      onLock: () => { locks += 1; },
      onRefresh: async () => actor,
      onRecoveryCompleted: () => {},
      onOpenPath: (path, title) => {
        opened.push({ path, title });
        if (followNavigation) {
          const target = new URL(path, browser.location.href), next = tabFromLocation(target.pathname, target.search);
          setTab((current) => upsertTab([current], title ? { ...next, title } : next).find((item) => item.id === next.id));
        }
      },
      onDirtyChange: () => {},
      onQueryChange: (query) => { queries.push(query); setTab((current) => ({ ...current, query })); },
      refreshNonce: 0,
    });
  }
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await settle(); });
  await act(async () => root.render(createElement(Harness)));
  await settle();
  return { container, opened, queries, locks: () => locks, tab: () => currentTab,
    replaceSnapshot: async (next) => { await act(async () => replaceSnapshot(next)); await settle(); },
    replaceTab: async (next) => { await act(async () => replaceTab(next)); await settle(); } };
}

const userTab = { id: 'user:user_normal', title: 'user_normal', path: '/users/user_normal', query: {}, closable: true, kind: 'user-object', objectType: 'user', objectId: 'user_normal' };
const orderTab = (query) => ({ id: 'order:order_cancel', title: 'TEST-1003', path: '/orders/order_cancel', query, closable: true, kind: 'order-object', objectType: 'order', objectId: 'order_cancel' });

test('user detail order link carries the origin user and the order page offers a return path', async (t) => {
  const h = await mount(t, userTab, snapshot(['user.directory.read', 'order.read']));
  await waitFor(() => namedButton('TEST-1003'));
  await click(namedButton('TEST-1003'));
  assert.equal(h.opened.at(-1).path, '/orders/order_cancel?fromUserId=user_normal&fromUserSection=orders', 'order link carries the source user context');

  const container2 = await mount(t, orderTab({ fromUserId: 'user_normal', fromUserSection: 'orders' }), snapshot(['user.directory.read', 'order.read']));
  await waitFor(() => namedButton('返回来源用户'));
  await click(namedButton('返回来源用户'));
  assert.equal(container2.opened.at(-1).path, '/users/user_normal?section=orders', 'return path lands back on the source user orders section');
});

test('order detail without an origin user or without user permission shows no return button', async (t) => {
  const noOrigin = await mount(t, orderTab({}), snapshot(['user.directory.read', 'order.read']));
  await settle(60);
  assert.equal(namedButton('返回来源用户'), undefined, 'no origin user means no return button');
  assert.ok(noOrigin.opened.every((item) => item.path === '/orders/order_cancel'), 'only the order title may update without an origin');

  const noPermission = await mount(t, orderTab({ fromUserId: 'user_normal', fromUserSection: 'orders' }), snapshot(['order.read']));
  await settle(60);
  assert.equal(namedButton('返回来源用户'), undefined, 'without user.directory.read the return entry stays hidden');
});

test('admin list keeps its query filters inside the workspace tab without opening any dialog', async (t) => {
  const query = { q: '测试', status: 'ACTIVE' };
  const list = { id: 'admins', title: '管理员', path: '/admins', query, closable: true, kind: 'admins' };
  const read = snapshot(['admin.account.read', 'admin.role.read', 'admin.permission.read']);
  const h = await mount(t, list, read);
  await waitFor(() => namedButton('测试运营'));
  assert.equal(browser.document.querySelectorAll('tbody tr').length, 1, 'tab 查询里的筛选要真的生效');
  assert.equal(browser.document.querySelector('[data-admin-detail]'), null, '列表挂载不自动打开信息弹窗');
  assert.equal(h.opened.length, 0);
  // 信息弹窗叠加在工作区之上的行为由组件套件与真实浏览器覆盖：
  // happy-dom 在 workspace 样式表上重算弹窗会触发 RangeError，不是产品缺陷。
});

const accountTab = { id: 'account', title: '账号安全', path: '/account', query: {}, closable: true, kind: 'account' };
const settingsTab = { id: 'settings', title: '设置', path: '/settings', query: {}, closable: true, kind: 'settings' };
test('normal environment keeps the legacy account security page and its lock callback', async (t) => {
  browser.location.href = 'http://127.0.0.1:3101/account';
  const h = await mount(t, accountTab, snapshot([]));
  assert.ok(browser.document.body.textContent.includes('修改登录密码'));
  assert.equal(browser.document.body.textContent.includes('新版设置五分区'), false);
  const lock = namedButton('立即锁定当前会话');
  assert.ok(lock && !lock.disabled, 'normal security action must remain available');
  await click(lock); assert.equal(h.locks(), 1);
});
test('the formal settings route mounts the five-section host regardless of environment', async (t) => {
  for (const host of ['http://127.0.0.1:3101/settings', 'http://127.0.0.1:4381/settings']) {
    browser.location.href = host;
    await mount(t, settingsTab, snapshot([]));
    assert.ok(browser.document.body.textContent.includes('新版设置五分区'), `settings mounts the new host on ${host}`);
    assert.equal(namedButton('立即锁定当前会话'), undefined, 'settings no longer borrows the legacy account page');
  }
});
test('account stays on the legacy page even on the isolated 4381 port', async (t) => {
  browser.location.href = 'http://127.0.0.1:4381/account';
  await mount(t, accountTab, snapshot([]));
  assert.ok(namedButton('立即锁定当前会话'), 'legacy account ability is preserved on every port');
  assert.equal(browser.document.body.textContent.includes('新版设置五分区'), false);
});
test('an external hostname on port 4381 retains the ordinary security page', async (t) => {
  browser.location.href = 'http://example.invalid:4381/account';
  await mount(t, accountTab, snapshot([]));
  assert.equal(browser.document.body.textContent.includes('新版设置五分区'), false);
  assert.ok(namedButton('立即锁定当前会话'));
});
test('formal settings wiring is not port-gated and the security entry targets the settings section', async () => {
  const { readFileSync } = await import('node:fs');
  const source = (name) => readFileSync(path.join(rootPath, 'src/workspace', name), 'utf8');
  assert.match(source('sidebar.tsx'), /onNavigate\("\/settings\?section=security"\)/, 'security entry targets the formal settings section');
  assert.doesNotMatch(source('sidebar.tsx'), /isLocalSettingsPreview/, 'security entry is not port-gated');
  const page = source('page-content.tsx');
  assert.doesNotMatch(page, /isLocalSettingsPreview|settingsPreview/, 'formal routes no longer depend on the preview port');
  assert.match(page, /tab\.kind === "account"[\s\S]*AccountSecurityPage/, 'account keeps the legacy page');
  const account = source('account-security-page.tsx');
  for (const marker of ['FreezePanel', 'RecoveryView', 'PinPanel', 'PasswordChangePanel']) {
    assert.ok(account.includes(marker), `legacy account page keeps ${marker}`);
  }
});

test('clearing user filters replaces the workspace query, including the old cursor', async (t) => {
  const list = { ...tabFromLocation('/users'), query: { q: '林舟', status: 'ACTIVE', source: 'MIGRATED', cursor: 'OLD_CURSOR' } };
  const h = await mount(t, list, snapshot(['user.directory.read']));
  await waitFor(() => browser.document.querySelector('.ud-directory tbody tr'));
  // The toolbar keeps one reset entry; the duplicate clear control was removed.
  await click(namedButton('重置'));
  await waitFor(() => browser.document.querySelector('[aria-label="查找用户"]').value === '');
  assert.deepEqual(h.queries.at(-1), { sort: 'registered_desc' }, 'omitted filters must be removed instead of merged back');
  assert.deepEqual(tabFromLocation('/users', tabHref(h.tab()).split('?')[1]).query, { sort: 'registered_desc' }, 'refresh receives only the cleared query');
});

test('phone lookup removes an older public search without persisting the phone', async (t) => {
  const h = await mount(t, { ...tabFromLocation('/users'), query: { q: '林舟' } }, snapshot(['user.directory.read', 'user.phone.lookup']));
  await waitFor(() => browser.document.querySelector('.ud-directory tbody tr'));
  await input(browser.document.querySelector('[aria-label="查找用户"]'), '18800001101');
  await click(namedButton('查询'));
  assert.deepEqual(h.queries.at(-1), { sort: 'registered_desc' }, 'neither the old nickname nor the phone belongs in the workspace query');
});

test('user detail section changes retain order and supply origin context', async (t) => {
  const origin = { fromOrderId: 'order_source', fromSupplyId: 'account_source', fromSupplyContext: 'archive', fromSupplyVersionId: 'version_source' };
  const h = await mount(t, { ...userTab, query: origin }, snapshot(['user.directory.read', 'order.read', 'supply.review.read']));
  await waitFor(() => namedButton('账号安全'));
  await click(namedButton('账号安全'));
  assert.deepEqual(h.queries.at(-1), { ...origin, section: 'security' });
  await click(namedButton('订单记录'));
  assert.deepEqual(h.queries.at(-1), { ...origin, section: 'orders' }, 'detail sections still send partial query changes');
});

test('clearing detail order filters through the workspace removes both request filters and retains its origin', async (t) => {
  const reads = [];
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const address = new URL(String(url), browser.location.href);
    if (address.pathname === '/api/bff/admin/users/user_normal/orders') reads.push(address.searchParams);
    return readFixture(url, init);
  });
  const origin = { fromOrderId: 'order_source', fromSupplyId: 'account_source', fromSupplyContext: 'archive' };
  const h = await mount(t, { ...userTab, query: { ...origin, section: 'orders', role: 'renter', status: 'current' } }, snapshot(['user.directory.read', 'order.read']));
  await waitFor(() => reads.length && namedButton('交易方向'));
  assert.equal(reads.at(-1).get('role'), 'renter');
  assert.equal(reads.at(-1).get('status'), 'current');

  for (const [label, cleared] of [['交易方向', 'role'], ['订单状态', 'status']]) {
    const before = reads.length;
    await click(namedButton(label));
    const openOptions = () => [...browser.document.querySelectorAll('[data-slot="select-content"][data-open] [role="option"]')];
    await waitFor(() => openOptions().length);
    const all = openOptions().find(option => option.textContent.trim() === '全部');
    assert.ok(all);
    await act(async () => { all.focus(); all.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); });
    await waitFor(() => reads.length > before);
    assert.equal(reads.at(-1).has(cleared), false, `${cleared} is omitted from the actual BFF request`);
    for (const [key, value] of Object.entries(origin)) assert.equal(h.tab().query[key], value, key);
    assert.equal(h.tab().query.section, 'orders');
  }
  assert.equal(reads.at(-1).has('role'), false);
  assert.equal(reads.at(-1).has('status'), false);
});

for (const transition of [
  { name: 'session locks', change: actor => ({ ...actor, session: { ...actor.session, locked: true } }) },
  { name: 'administrator is frozen', change: actor => ({ ...actor, security: { ...actor.security, status: 'FROZEN' } }) },
  { name: 'password change becomes required', change: actor => ({ ...actor, security: { ...actor.security, passwordChangeRequired: true } }) },
]) test(`the real directory adapter clears disclosed data and stops business I/O when ${transition.name}`, async (t) => {
  const disclosedPhone = 'SYNTHETIC-PHONE-PLAINTEXT';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    const address = new URL(String(url), browser.location.href);
    calls.push({ path: address.pathname, method: init.method ?? 'GET' });
    if (address.pathname === '/api/bff/admin/users/user_normal/sensitive-profile') return json({
      userId: 'user_normal', phoneNumber: disclosedPhone, realName: null, identityNumber: null,
      availability: { phoneNumber: 'AVAILABLE', realName: 'NOT_RECORDED', identityNumber: 'NOT_RECORDED' },
    });
    if (address.pathname.endsWith('/notes')) return json({ items: [], nextCursor: null, capabilities: { canCreate: false, canManage: false } });
    return readFixture(url, init);
  });
  const actor = snapshot(['user.directory.read', 'user.identity.sensitive.read']);
  const h = await mount(t, userTab, actor);
  await waitFor(() => namedButton('展开实名与联系方式'));
  await click(namedButton('展开实名与联系方式'));
  await waitFor(() => namedButton('查看明文'));
  await click(namedButton('查看明文'));
  await waitFor(() => h.container.textContent.includes(disclosedPhone));
  const before = calls.length;

  await h.replaceSnapshot(transition.change(actor));
  assert.equal(h.container.textContent.includes(disclosedPhone), false, 'plaintext leaves the DOM immediately');
  assert.equal(calls.length, before, 'an inactive or locked surface must not start another business read or command');

  await h.replaceSnapshot(actor);
  await waitFor(() => namedButton('展开实名与联系方式'));
  await click(namedButton('展开实名与联系方式'));
  await waitFor(() => namedButton('查看明文'));
  assert.equal(h.container.textContent.includes(disclosedPhone), false, 'restoring the same session never restores disclosed plaintext');
  assert.equal(calls.filter(call => call.path.endsWith('/sensitive-profile')).length, 1, 'disclosure requires a fresh explicit click');
  assert.deepEqual(calls.filter(call => call.method !== 'GET'), [{ path: '/api/bff/admin/users/user_normal/sensitive-profile', method: 'POST' }], 'no user write is dispatched by lifecycle changes');
});

test('a successful order title update retains the source user and its return path', async (t) => {
  const origin = { fromUserId: 'user_normal', fromUserSection: 'resources' };
  const h = await mount(t, orderTab(origin), snapshot(['user.directory.read', 'order.read']), true);
  await waitFor(() => h.opened.some((item) => item.title === 'TEST-1003'));
  assert.deepEqual(h.tab().query, origin, 'real host navigation must keep the order source after its response arrives');
  await click(namedButton('返回来源用户'));
  assert.equal(h.opened.at(-1).path, '/users/user_normal?section=resources');
});

for (const [name, nextOrigin] of [
  ['changes', { fromUserId: 'user_other', fromUserSection: 'resources' }],
  ['is removed', {}],
]) test('an in-flight order uses the latest source when it ' + name, async (t) => {
  let release;
  t.mock.method(globalThis, 'fetch', (url, init) => new URL(String(url), browser.location.href).pathname === '/api/bff/admin/orders/order_cancel'
    ? new Promise((resolve) => { release = resolve; })
    : readFixture(url, init));
  const h = await mount(t, orderTab({ fromUserId: 'user_normal', fromUserSection: 'orders' }), snapshot(['user.directory.read', 'order.read']), true);
  await waitFor(() => release);
  await h.replaceTab(orderTab(nextOrigin));
  await act(async () => release(json({ order: loadedOrder })));
  await waitFor(() => h.opened.some((item) => item.title === 'TEST-1003'));
  assert.deepEqual(h.tab().query, nextOrigin, 'a late title update cannot resurrect the prior source');
});

test('switching to another order aborts the old response before it can restore a source', async (t) => {
  let release, oldSignal;
  t.mock.method(globalThis, 'fetch', (url, init) => new URL(String(url), browser.location.href).pathname === '/api/bff/admin/orders/order_cancel'
    ? new Promise((resolve) => { release = resolve; oldSignal = init.signal; })
    : readFixture(url, init));
  const h = await mount(t, orderTab({ fromUserId: 'user_normal' }), snapshot(['user.directory.read', 'order.read']), true);
  await waitFor(() => release);
  const other = tabFromLocation('/orders/order_other', 'fromUserId=user_other&fromUserSection=orders');
  await h.replaceTab(other);
  await waitFor(() => h.opened.some((item) => item.title === 'TEST-OTHER'));
  assert.equal(oldSignal.aborted, true);
  await act(async () => release(json({ order: loadedOrder })));
  await settle();
  assert.equal(h.tab().objectId, 'order_other');
  assert.deepEqual(h.tab().query, other.query);
  assert.equal(h.opened.some((item) => item.title === 'TEST-1003'), false);
});

test('order origin wiring is limited to its own title and related resource', () => {
  const opened = [], snap = snapshot(['user.directory.read', 'order.read']);
  const element = WorkspacePageContent({ tab: orderTab({ fromUserId: 'user_normal', fromUserSection: 'orders' }), snapshot: snap, onOpenPath: (path) => opened.push(path) });
  const orderView = element.props.children.find((child) => child?.props?.initialOrderId === 'order_cancel');
  for (const [target, expectedUser] of [
    ['/orders/order_cancel', 'user_normal'],
    ['/supply/accounts/account_1?fromOrderId=order_cancel', 'user_normal'],
    ['/orders', null],
    ['/orders/order_other', null],
    ['/orders/order_other?fromUserId=user_other&fromUserSection=resources', 'user_other'],
  ]) {
    orderView.props.onOpenPath(target, '核对');
    const url = new URL(opened.at(-1), browser.location.href);
    assert.equal(url.searchParams.get('fromUserId'), expectedUser, target);
    if (target.includes('fromOrderId=')) assert.equal(url.searchParams.get('fromOrderId'), 'order_cancel');
  }
});

test('user detail order link carries role and status and return path preserves them', async (t) => {
  const container = await mount(
    t,
    orderTab({ fromUserId: 'user_normal', fromUserSection: 'orders', fromUserRole: 'renter', fromUserStatus: 'current' }),
    snapshot(['user.directory.read', 'order.read'])
  );
  await waitFor(() => namedButton('返回来源用户'));
  await click(namedButton('返回来源用户'));
  assert.equal(container.opened.at(-1).path, '/users/user_normal?section=orders&role=renter&status=current', 'return path lands back on source user orders section with role and status=current');
});

test('finance origin link and return navigation preserves user detail section', async (t) => {
  const { registerFinanceOrigin } = await vite.ssrLoadModule('/src/views/admin-finance-view.tsx');
  const snap = snapshot(['finance.read', 'user.directory.read']);
  const identity = `${snap.adminUserId}:${snap.session.id}:${[...snap.permissions].sort().join('|')}`;
  const token = registerFinanceOrigin('/users/user_normal?section=finance', identity);
  const financeTab = { id: 'finance-user', title: '资金详情', path: '/finance/users/user_normal', query: { origin: token }, closable: true, kind: 'finance-user', objectId: 'user_normal' };
  const h = await mount(t, financeTab, snap);
  await waitFor(() => namedButton('返回来源'));
  await click(namedButton('返回来源'));
  assert.equal(h.opened.at(-1).path, '/users/user_normal?section=finance', 'return path lands back on user detail finance section');
});

test('finance to order and title refresh retain original business filters and return context',async t=>{
  const {registerFinanceOrigin,financeContextIdentity}=await vite.ssrLoadModule('/src/views/admin-finance-view.tsx');
  const snap=snapshot(['order.read','finance.read','finance.document.read']);
  const source='/finance?q=20260913125844629986&kind=WITHDRAWAL&from=2026-06-01&to=2026-06-30&period=1&page=2';
  const token=registerFinanceOrigin(source,financeContextIdentity(snap));const h=await mount(t,orderTab({financeOrigin:token}),snap,true);
  await waitFor(()=>h.container.textContent.includes('TEST-1003'));
  assert.equal(h.tab().query.financeOrigin,token,'title update must not discard source');
  const button=[...h.container.querySelectorAll('button')].find(button=>button.textContent.trim()==='返回来源资金');await click(button);assert.equal(h.opened.at(-1).path,source);
});
test('order funds entry uses source-qualified root and returns to the same order',async t=>{
  const {financeOriginPath}=await vite.ssrLoadModule('/src/views/admin-finance-view.tsx');const snap=snapshot(['order.read','finance.document.read']);
  const h=await mount(t,orderTab({}),snap);await waitFor(()=>h.container.textContent.includes('TEST-1003'));
  await click([...h.container.querySelectorAll('button')].find(button=>button.textContent.includes('查看资金凭证')));
  const target=new URL(h.opened.at(-1).path,browser.location.href);assert.equal(decodeURIComponent(target.pathname),'/finance/documents/LEGACY_ORDER:order_cancel');assert.equal(financeOriginPath(target.searchParams.get('origin'),snap),'/orders/order_cancel');
});
test('order reload retains a safe public finance return without the in-memory origin',async t=>{
  const {clearFinanceContexts}=await vite.ssrLoadModule('/src/views/admin-finance-view.tsx');clearFinanceContexts();const source='/finance?q=20260913125844629986&page=2&kind=WITHDRAWAL';const h=await mount(t,orderTab({financeOrigin:'lost-token',financeReturn:source}),snapshot(['order.read','finance.read']),true);await waitFor(()=>h.container.textContent.includes('TEST-1003'));assert.equal(h.tab().query.financeReturn,source);await click([...h.container.querySelectorAll('button')].find(button=>button.textContent==='返回来源资金'));assert.equal(h.opened.at(-1).path,source);
});
test('user detail credit tab has a finance return while a non-financial role has none',async t=>{
  const source='/finance?q=20260913125844629986&page=2';const tab={...userTab,query:{section:'credit',financeReturn:source}};const h=await mount(t,tab,snapshot(['user.directory.read','finance.read']));await waitFor(()=>h.container.textContent.includes('林舟'));await click([...h.container.querySelectorAll('button')].find(button=>button.textContent.includes('返回来源资金')));assert.equal(h.opened.at(-1).path,source);
  const limited=await mount(t,tab,snapshot(['user.directory.read']));await waitFor(()=>limited.container.textContent.includes('林舟'));assert.equal([...limited.container.querySelectorAll('button')].some(button=>button.textContent.includes('返回来源资金')),false);
});


test('the published drill-down keeps the collection scope and the published filter', async (t) => {
  const list = { ...tabFromLocation('/users'), query: { sort: 'registered_desc' } };
  const h = await mount(t, list, snapshot(['user.directory.read', 'supply.rental_account.read']));
  await waitFor(() => browser.document.querySelector('.ud-directory tbody tr'));
  await click(namedButton('查看用户 林舟 已上架游戏账号'));
  const target = new URL(h.opened.at(-1).path, browser.location.href);
  assert.equal(target.pathname, '/users/user_normal');
  assert.equal(target.searchParams.get('section'), 'resources');
  assert.equal(target.searchParams.get('publication'), 'published', 'the drill-down keeps the published scope');
});

test('the registration sort in the workspace query drives the directory request', async (t) => {
  const list = { ...tabFromLocation('/users'), query: { sort: 'registered_asc' } };
  const h = await mount(t, list, snapshot(['user.directory.read']));
  await waitFor(() => browser.document.querySelector('.ud-directory tbody tr'));
  assert.deepEqual(h.queries.at(-1), { sort: 'registered_asc' }, 'the applied sort stays in the workspace query');
});


test('MASTER: published account origin survives the resource detail return', async (t) => {
  const snap = snapshot(['user.directory.read', 'supply.rental_account.read']);
  const opened = [];
  const tab = { ...userTab, query: { section: 'resources', publication: 'published' } };
  const surface = WorkspacePageContent({ tab, snapshot: snap, onOpenPath: (value) => opened.push(value), onQueryChange: () => {}, refreshNonce: 0 });
  const userView = surface.props.children.find((child) => child?.props?.tab?.kind === 'user-object');
  userView.props.onOpenPath('/supply/accounts/account_1', '账号');
  const target = new URL(opened.at(-1), browser.location.href);
  assert.equal(target.searchParams.get('fromUserPublication'), 'published');
  const h = await mount(t, tabFromLocation(target.pathname, target.search), snap);
  await waitFor(() => namedButton('返回来源用户'));
  await click(namedButton('返回来源用户'));
  const returned = new URL(h.opened.at(-1).path, browser.location.href);
  assert.equal(returned.pathname, '/users/user_normal');
  assert.equal(returned.searchParams.get('section'), 'resources');
  assert.equal(returned.searchParams.get('publication'), 'published');
});
