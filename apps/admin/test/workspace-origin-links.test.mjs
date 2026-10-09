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
  configFile: false,
  plugins: [
    react(),
    {
      name: "origin-links-workbench-stub",
      enforce: "pre",
      resolveId(id, importer) {
        const normalized = id.replaceAll("\\", "/");
        const fromPageContent = importer?.replaceAll("\\", "/").endsWith("/src/workspace/page-content.tsx");
        return (normalized.endsWith("/src/workspace/workbench.tsx") || ((id === "./workbench" || id === "./workbench.tsx") && fromPageContent)) ? "\0origin-links-workbench-stub" : undefined;
      },
      load(id) {
        if (id !== "\0origin-links-workbench-stub") return undefined;
        return `import { createElement } from "react";
export function WorkbenchPage() { return createElement("div", { "data-stub": "workbench" }); }
export default WorkbenchPage;`;
      },
    },
  ],
  resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } },
  server: { middlewareMode: true, hmr: false },
});
const { WorkspacePageContent } = await vite.ssrLoadModule('/src/workspace/page-content.tsx');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = { userId: 'user_normal', name: '林舟', image: null, username: null, displayUsername: null, maskedPhone: '188****1101', accountStatus: 'ACTIVE', suspended: false, identityStatus: 'UNKNOWN', ageStatus: 'UNKNOWN', source: { kind: 'MIGRATED', legacyId: '88001' }, registeredAt: '2026-09-24T04:00:00Z', registeredAtSource: 'LOCAL', createdAt: '2026-09-24T04:00:00Z', updatedAt: '2026-09-24T04:00:00Z', localCreatedAt: '2026-09-24T04:00:00Z', resourceSummary: { state: 'ready', count: 1 }, orderSummary: { state: 'ready', currentCount: 1 }, lastBusinessActivity: { state: 'not_connected', domains: ['ORDER', 'SUPPLY'] } };
const order = { orderId: 'order_cancel', displayNo: 'TEST-1003', status: 'CANCELLED', role: 'renter', title: '订单快照', counterpartyName: '另一方', gameId: 'delta', amounts: { rental: { currency: 'CNY', unit: 'yuan', amount: '60.00', scale: 2 }, deposit: { currency: 'CNY', unit: 'yuan', amount: '100.00', scale: 2 }, totalDue: { currency: 'CNY', unit: 'yuan', amount: '160.00', scale: 2 } }, createdAt: user.createdAt, paidAt: null, cancelledAt: user.createdAt, cancelReason: '支付后取消', expiredAwaitingCancel: false };

globalThis.fetch = async (input) => {
  const url = new URL(String(input), browser.location.href);
  if (url.pathname === '/api/bff/admin/users/user_normal') return json({ user });
  if (url.pathname.endsWith('/orders')) return json({ items: [order], nextCursor: null });
  if (url.pathname.endsWith('/rental-accounts')) return json({ items: [], nextCursor: null });
  if (url.pathname.endsWith('/audit-events')) return json({ items: [], nextCursor: null });
  return json({ error: { code: 'NOT_FOUND' } }, 404);
};

async function settle(ms = 25) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(fn, timeout = 3000) { const until = Date.now() + timeout; while (!fn()) { if (Date.now() > until) throw new Error('Component condition timed out'); await settle(); } }
const namedButton = (name) => [...browser.document.querySelectorAll('button')].find((e) => (e.getAttribute('aria-label') || e.textContent.trim()) === name);
async function click(element) { assert.ok(element, 'expected clickable element'); await act(async () => element.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }))); await settle(); }

function snapshot(permissions, isBoss = false) {
  return { authenticated: true, adminUserId: 'admin-1', user: { name: '测试管理员', username: 'ZZ00001', twoFactorEnabled: true }, security: { status: 'ACTIVE', isBoss, passwordChangeRequired: false }, session: { id: 'session-1', locked: false, pinConfigured: true, createdAt: null, expiresAt: null }, permissions };
}

async function mount(t, initialTab, snap) {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  function Harness() {
    const [tab, setTab] = useState(initialTab);
    return createElement(WorkspacePageContent, {
      tab,
      snapshot: snap,
      idleMinutes: 10,
      onIdleMinutes: () => {},
      onLock: () => {},
      onRefresh: async () => snap,
      onRecoveryCompleted: () => {},
      onOpenPath: (path, title) => { opened.push({ path, title }); },
      onDirtyChange: () => {},
      onQueryChange: (query) => setTab((current) => ({ ...current, query })),
      refreshNonce: 0,
    });
  }
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await settle(); });
  await act(async () => root.render(createElement(Harness)));
  await settle();
  return { opened };
}

const userTab = { id: 'user:user_normal', title: 'user_normal', path: '/users/user_normal', query: {}, closable: true, kind: 'user-object', objectType: 'user', objectId: 'user_normal' };
const orderTab = (query) => ({ id: 'order:order_cancel', title: 'TEST-1003', path: '/orders/order_cancel', query, closable: true, kind: 'order-object', objectType: 'order', objectId: 'order_cancel' });

test('user detail order link carries the origin user and the order page offers a return path', async (t) => {
  const h = await mount(t, userTab, snapshot(['user.directory.read', 'order.read']));
  await waitFor(() => namedButton('查看订单记录'));
  await click(namedButton('查看订单记录'));
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
  assert.equal(noOrigin.opened.length, 0);

  const noPermission = await mount(t, orderTab({ fromUserId: 'user_normal', fromUserSection: 'orders' }), snapshot(['order.read']));
  await settle(60);
  assert.equal(namedButton('返回来源用户'), undefined, 'without user.directory.read the return entry stays hidden');
});
