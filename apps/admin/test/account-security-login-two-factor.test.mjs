import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/settings/security' });
browser.matchMedia = query => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'localStorage', 'sessionStorage']) globalThis[name] = name === 'window' ? browser : browser[name];
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  root: rootPath, configFile: false, plugins: [react()],
  resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } },
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { external: ['@zzsh/content'] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { LoginTwoFactorPanel } = await vite.ssrLoadModule('/src/workspace/account-security-page.tsx');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
const button = name => [...browser.document.querySelectorAll('button')].find(element => element.textContent.trim() === name);
function typeInto(element, value) {
  Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new browser.Event('input', { bubbles: true }));
}
const snap = (security, twoFactorEnabled = true) => ({
  authenticated: true, adminUserId: 'admin-1', user: { username: 'ZZ00001', twoFactorEnabled },
  security: { status: 'ACTIVE', isBoss: true, passwordChangeRequired: false, ...security },
  session: { id: 's1', locked: false, pinConfigured: false, createdAt: null, expiresAt: null }, permissions: [],
});
async function mount(t, snapshot) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ path: new URL(String(input), browser.location.href).pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    return json({ data: { loginTwoFactorRequired: false, changed: true } });
  };
  let refreshed = 0;
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(LoginTwoFactorPanel, { snapshot, onRefresh: async () => { refreshed += 1; return snapshot; } })));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, calls, refreshed: () => refreshed };
}

test('关闭登录 2FA 需要密码与动态码，并提交到自助接口', async (t) => {
  const { host, calls, refreshed } = await mount(t, snap({ loginTwoFactorRequired: true }));
  assert.match(host.textContent, /登录时验证/);
  assert.match(host.textContent, /敏感操作仍需当场验证动态码/);
  await act(async () => button('关闭登录验证').click()); await settle();
  const submit = button('确认关闭');
  assert.equal(submit.disabled, true);
  const inputs = [...host.querySelectorAll('input')];
  await act(async () => { typeInto(inputs[0], 'correct-horse-battery'); typeInto(inputs[1], '123456'); }); await settle();
  assert.equal(button('确认关闭').disabled, false);
  await act(async () => button('确认关闭').click()); await settle();
  const post = calls.find(call => call.path.endsWith('/security/login-two-factor'));
  assert.ok(post, 'expected POST to login-two-factor');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { enabled: false, password: 'correct-horse-battery', totpCode: '123456' });
  assert.equal(refreshed(), 1);
  assert.match(host.textContent, /敏感操作仍需验证 2FA/);
});

test('已关闭时提供开启；服务端未返回字段时不提供开关', async (t) => {
  const off = await mount(t, snap({ loginTwoFactorRequired: false }));
  assert.match(off.host.textContent, /登录时不验证/);
  assert.ok([...off.host.querySelectorAll('button')].some(b => b.textContent.trim() === '开启登录验证'));
  const missing = await mount(t, snap({}));
  assert.match(missing.host.textContent, /服务端未接入/);
  assert.equal([...missing.host.querySelectorAll('button')].length, 0);
});

test('未绑定 2FA 时只显示状态，不提供开关', async (t) => {
  const { host } = await mount(t, snap({ loginTwoFactorRequired: true }, false));
  assert.equal([...host.querySelectorAll('button')].length, 0);
  assert.match(host.textContent, /需先完成 2FA 绑定/);
});