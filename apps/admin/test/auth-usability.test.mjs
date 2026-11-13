import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import React, { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { REMEMBERED_ADMIN_IDENTIFIER_KEY, readRememberedAdminIdentifier, saveRememberedAdminIdentifier } from '../src/lib/login-preference.ts';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/login' });
browser.matchMedia = query => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'localStorage', 'sessionStorage']) globalThis[name] = name === 'window' ? browser : browser[name];
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({ root: rootPath, configFile: false, plugins: [react()],
  resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
const { LoginView } = await vite.ssrLoadModule('/src/views/login-view.tsx');
const { AuthShell } = await vite.ssrLoadModule('/src/components/devl/auth-shell.tsx');
const { ParticleField } = await vite.ssrLoadModule('/src/components/devl/particle-field.tsx');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

test('light status text uses the existing readable theme foregrounds while retaining tinted fills', () => {
  const css = readFileSync(path.join(rootPath, 'src/styles.css'), 'utf8');
  const light = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/)[1];
  const luminance = color => color.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index], 0);
  for (const tone of ['success', 'warning']) {
    const color = light.match(new RegExp(`--${tone}-foreground:\\s*(#[0-9a-f]{6})`))[1];
    assert.ok(1.05 / (luminance(color) + .05) >= 4.5);
    assert.match(css, new RegExp(`\\.status-badge\\.${tone}\\s*\\{[^}]*color:\\s*var\\(--${tone}-foreground\\)`));
  }
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
function input(element, value) {
  Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new browser.Event('input', { bubbles: true }));
}
async function login(t) {
  const host = browser.document.createElement('div'); browser.document.body.append(host); const root = createRoot(host), submitted = [];
  function Harness() { const [identifier, setIdentifier] = React.useState(''); return createElement(AuthShell, { forceMobile: true }, createElement(LoginView, { identifier, onIdentifier: setIdentifier, loading: false, onSubmit: (...args) => submitted.push(args), onRecovery() {} })); }
  await act(async () => root.render(createElement(Harness))); await settle();
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, submitted };
}

test('remember is explicit, defaults off, saves only the login identifier and clears immediately when cancelled', async t => {
  browser.localStorage.clear(); const { host, submitted } = await login(t);
  const box = host.querySelector('#remember-account'); assert.equal(box.checked, false);
  await act(async () => { input(host.querySelector('#admin-identifier'), 'SYNTHETIC_ADMIN'); input(host.querySelector('#admin-password'), 'SYNTHETIC_PASSWORD'); });
  await act(async () => host.querySelector('form').dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(submitted.length, 1); assert.equal(browser.localStorage.length, 0);
  await act(async () => box.click());
  await act(async () => host.querySelector('form').dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(browser.localStorage.getItem(REMEMBERED_ADMIN_IDENTIFIER_KEY), 'SYNTHETIC_ADMIN');
  assert.equal(browser.localStorage.length, 1); assert.equal(browser.sessionStorage.length, 0);
  assert.ok(!browser.localStorage.getItem(REMEMBERED_ADMIN_IDENTIFIER_KEY).includes('PASSWORD'));
  await act(async () => box.click()); assert.equal(browser.localStorage.length, 0);
});

test('an explicitly remembered identifier restores without restoring a password or session', async t => {
  browser.localStorage.clear(); saveRememberedAdminIdentifier('SYNTHETIC_SAVED'); const { host } = await login(t);
  assert.equal(host.querySelector('#admin-identifier').value, 'SYNTHETIC_SAVED');
  assert.equal(host.querySelector('#admin-password').value, '');
  assert.equal(host.querySelector('#remember-account').checked, true);
  assert.equal(saveRememberedAdminIdentifier('bad\nvalue'), false);
  assert.equal(readRememberedAdminIdentifier(), 'SYNTHETIC_SAVED');
});

test('password visibility remains hidden by default and its real button is keyboard focusable', async t => {
  browser.localStorage.clear(); const { host } = await login(t); const eye = host.querySelector('button[aria-label="显示密码"]');
  assert.equal(eye.tabIndex, 0); assert.equal(host.querySelector('#admin-password').type, 'password');
  eye.focus(); assert.equal(browser.document.activeElement, eye);
  await act(async () => eye.click()); assert.equal(host.querySelector('#admin-password').type, 'text');
  assert.equal(eye.getAttribute('aria-label'), '隐藏密码');
});

test('particle artwork renders a static reduced-motion frame and stops scheduling when hidden or offscreen', async () => {
  const old = { raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame, image: globalThis.Image, io: globalThis.IntersectionObserver, ro: globalThis.ResizeObserver, media: browser.matchMedia, rect: browser.HTMLElement.prototype.getBoundingClientRect, context: browser.HTMLCanvasElement.prototype.getContext };
  const frames = new Map(); let sequence = 0, reduced = false, hidden = false, motionChange, intersection, paints = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  browser.matchMedia = query => ({ media: query, get matches() { return query.includes('reduced-motion') ? reduced : false; }, addEventListener(_event, cb) { if (query.includes('reduced-motion')) motionChange = cb; }, removeEventListener() {} });
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  browser.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 160, height: 120, top: 0, left: 0, right: 160, bottom: 120 });
  browser.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, drawImage() {}, beginPath() {}, fill() { paints++; }, arc() {}, getImageData(_x, _y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(255) }; } });
  globalThis.Image = class { width = 2; height = 2; set src(_value) { queueMicrotask(() => this.onload?.()); } };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.IntersectionObserver = class { constructor(callback) { intersection = callback; } observe() {} disconnect() {} };
  const flush = () => { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(0); };
  const host = browser.document.createElement('div'); browser.document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ParticleField, { src: 'synthetic.png', sampleStep: 20, threshold: 1 })));
    flush(); assert.equal(frames.size, 1, 'visible normal artwork continues its single frame loop');
    hidden = true; browser.document.dispatchEvent(new browser.Event('visibilitychange')); assert.equal(frames.size, 0);
    hidden = false; browser.document.dispatchEvent(new browser.Event('visibilitychange')); flush(); assert.equal(frames.size, 1);
    reduced = true; motionChange(); flush(); assert.equal(frames.size, 0, 'reduced motion has no repeating frame'); assert.ok(paints > 0, 'the artwork is preserved as a static figure');
    reduced = false; motionChange(); assert.equal(frames.size, 1); intersection([{ isIntersecting: false }]); assert.equal(frames.size, 0);
    intersection([{ isIntersecting: true }]); flush(); assert.equal(frames.size, 1);
  } finally {
    await act(async () => root.unmount()); host.remove(); assert.equal(frames.size, 0);
    globalThis.requestAnimationFrame = old.raf; globalThis.cancelAnimationFrame = old.cancel; globalThis.Image = old.image; globalThis.IntersectionObserver = old.io; globalThis.ResizeObserver = old.ro;
    browser.matchMedia = old.media; browser.HTMLElement.prototype.getBoundingClientRect = old.rect; browser.HTMLCanvasElement.prototype.getContext = old.context;
  }
});
