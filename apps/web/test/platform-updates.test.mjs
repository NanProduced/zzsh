import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { updateSettings, updateVisibility } from '@zzsh/content/updates';
import { loadContentFixture } from './content-fixture.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), modules = new Map();
const router = { calls: [], replace(...args) { this.calls.push(args); }, refresh() {} };
let popupAuthOpen = false;
const PopupContext = React.createContext(() => {});
const PopupDialog = {
  Root: ({ open, onOpenChange, children }) => open ? React.createElement(PopupContext.Provider, { value: onOpenChange }, children) : null,
  Portal: ({ children }) => React.createElement(React.Fragment, null, children),
  Overlay: props => React.createElement('div', props),
  Content: ({ children, ...props }) => React.createElement('section', { ...props, role: 'dialog' }, children),
  Title: ({ children }) => React.createElement('h2', null, children),
  Close: ({ children, ...props }) => { const close = React.useContext(PopupContext); return React.createElement('button', { ...props, onClick: () => close(false) }, children); },
};
function load(relative) {
  const file = path.resolve(root, relative); if (modules.has(file)) return modules.get(file).exports;
  const m = new Module(file), native = createRequire(file); modules.set(file, m); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m.require = name => {
    if (name.endsWith('.css')) return {};
    if (name === '@radix-ui/react-dialog') return PopupDialog;
    if (name === '@/components/auth/auth-overlay-provider') return { useAuthOverlay: () => ({ isOpen: popupAuthOpen }) };
    if (name === '@zzsh/ui/plate-document') return loadContentFixture('packages/ui/src/plate-document.tsx');
    if (name === 'next/link') return ({ children, scroll, prefetch, ...props }) => React.createElement('a', props, children);
    if (name === 'next/navigation') return { useRouter: () => router };
    if (name === '@/components/ui/tooltip') return { Tooltip: ({ children }) => React.createElement(React.Fragment, null, children), TooltipTrigger: ({ children }) => React.createElement(React.Fragment, null, children), TooltipContent: ({ children }) => React.createElement(React.Fragment, null, children) };
    if (name.startsWith('@/')) { const base = 'src/' + name.slice(2); for (const suffix of ['.ts', '.tsx']) if (fs.existsSync(path.resolve(root, base + suffix))) return load(base + suffix); }
    if (name.startsWith('.')) { const base = path.resolve(path.dirname(file), name); for (const suffix of ['', '.ts', '.tsx']) if (fs.existsSync(base + suffix)) return load(base + suffix); }
    return native(name);
  };
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const contract = load('src/lib/platform-updates.ts'), components = load('src/components/content/platform-update-notices.tsx'), lists = load('src/components/content/updates-list.tsx');
const now = Date.now();
const item = (id, settings = {}) => ({ id, versionId: `version_${id}`, type: 'ANNOUNCEMENT', title: `本地测试 ${id}`, summary: '说明摘要', publishedAt: '2026-10-28T00:00:00Z', gameName: null, coverMediaId: null, settings: updateSettings(settings), expired: false, pinned: false, mediaUrls: {} });
const page = items => ({ items, page: 1, limit: 12, total: items.length, totalPages: items.length ? 1 : 0, asOf: new Date(now).toISOString() });
test('update contracts reject unsafe media and constrain return navigation to a real filtered page', () => {
  const good = item('one'); assert.equal(contract.parseUpdate(good).id, good.id);
  assert.throws(() => contract.parseUpdate({ ...good, settings: { mediaIds: ['m1'] }, body: '正文', mediaUrls: { m1: 'https://external.invalid/private' } }, true));
  assert.throws(() => contract.parseUpdatesPage({ ...page([good]), totalPages: 9 }));
  assert.equal(contract.updateReturnHref('/updates?type=NEWS&page=3'), '/updates?type=NEWS&page=3&restore=1');
  for (const from of ['https://external.invalid/', '/help', '/updates?next=https://external.invalid', '/updates?page=0']) assert.equal(contract.updateReturnHref(from), '/updates?restore=1');
});
test('single-column list retains type, optional news covers, publication date, pins and real page links', () => {
  const a = { ...item('ann'), pinned: true, coverMediaId: 'ann_cover' }, b = { ...item('news'), type: 'NEWS', coverMediaId: 'news_cover' };
  const html = renderToStaticMarkup(React.createElement(lists.UpdatesList, { data: { ...page([a, b]), page: 2, total: 38, totalPages: 4 }, type: 'NEWS' }));
  assert.match(html, /置顶/); assert.match(html, /2026-10-28/); assert.match(html, /news_cover/); assert.ok(!html.includes('ann_cover'));
  assert.match(html, /type=NEWS&amp;page=3/); assert.match(html, /from=%2Fupdates%3Ftype%3DNEWS%26page%3D2/);
  const browser = new Window(); browser.document.body.innerHTML = html;
  assert.equal(browser.document.querySelectorAll('.updates-list > li').length, 2);
  assert.equal(browser.document.querySelector('.updates-filters [aria-current="page"]').textContent, '资讯');
  browser.happyDOM.abort();
});
test('an empty publication list has an explicit empty state without fabricated rows', () => {
  const html = renderToStaticMarkup(React.createElement(lists.UpdatesList, { data: page([]), type: 'ALL' }));
  assert.match(html, /暂无已发布的动态/); assert.ok(!html.includes('updates-row-copy')); assert.ok(!html.includes('updates-pagination'));
});
test('shared plate rendering preserves literal legacy text without executing it', () => {
  const { PlateDocument } = loadContentFixture('packages/ui/src/plate-document.tsx');
  const document = { format: 'plate', schemaVersion: 1, preset: 'update', value: [
    { type: 'p', children: [{ text: '# 原标题' }] },
    { type: 'p', children: [{ text: '正文' }] },
    { type: 'p', children: [{ text: '<script>alert(1)</script>' }] },
  ] };
  const html = renderToStaticMarkup(React.createElement(PlateDocument, { document }));
  const browser = new Window(); browser.document.body.innerHTML = html;
  assert.equal(browser.document.querySelector('h1,h2,script'), null);
  assert.ok(browser.document.body.textContent.includes('<script>alert(1)</script>')); browser.happyDOM.abort();
});

async function renderUpdateDetail(fixture, from) {
  const file = path.resolve(root, 'src/app/updates/[id]/page.tsx'), native = createRequire(file), exports = {};
  const dependencies = {
    'next/navigation': { notFound() { throw Error('NOT_FOUND'); } },
    '@/components/layout/service-shell': { ServiceShell: ({ children }) => React.createElement('main', null, children) },
    '@/lib/updates-server': { loadPlatformUpdate: async () => fixture },
    '@/lib/platform-updates': contract,
    '@/components/content/updates-list': lists,
    '@zzsh/ui/plate-document': loadContentFixture('packages/ui/src/plate-document.tsx'),
  };
  new Function('require', 'exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(name => name.endsWith('.css') ? {} : dependencies[name] ?? native(name), exports);
  const page = await exports.default({ params: Promise.resolve({ id: fixture.id }), searchParams: Promise.resolve({ from }) });
  return renderToStaticMarkup(page);
}

test('an expired display window preserves rule content without declaring the business rule ended', async t => {
  const settings = updateSettings({ format: 'plate', noticeKind: 'rule-change', effectiveAt: '2030-01-01T00:00:00Z', validUntil: '2030-01-02T00:00:00Z', impact: '合成规则适用范围', surfaces: ['publish'] });
  const visibility = updateVisibility(settings, Date.parse('2030-01-03T00:00:00Z'));
  assert.equal(visibility.expired, true);
  const document = { format: 'plate', schemaVersion: 1, preset: 'update', value: [{ type: 'h2', id: 'rule', children: [{ text: '规则正文' }] }, { type: 'p', children: [{ text: '合成规则正文仍完整保留。' }] }] };
  const fixture = { ...item('historical-rule'), settings, expired: visibility.expired, body: '规则正文\n合成规则正文仍完整保留。', document };
  const html = await renderUpdateDetail(fixture, '/updates?type=ANNOUNCEMENT&page=2');
  const browser = new Window(); t.after(() => browser.happyDOM.abort()); browser.document.body.innerHTML = html;
  const callout = browser.document.querySelector('.update-expired-callout')?.textContent ?? '';
  assert.match(callout, /展示有效期/); assert.match(callout, /历史查阅/);
  assert.match(callout, /实际服务状态.*相关业务页面/);
  assert.doesNotMatch(callout, /维护.*已结束|规则(?:调整)?.*已结束|活动已结束/);
  assert.ok(browser.document.querySelector('.plate-document').textContent.includes('合成规则正文仍完整保留。'));
  assert.ok(browser.document.querySelector('.update-impact').textContent.includes('合成规则适用范围'));
  assert.equal(browser.document.querySelector('.update-back').getAttribute('href'), '/updates?type=ANNOUNCEMENT&page=2&restore=1');
});
async function mount(t, component, fetcher, props = {}, options = {}) {
  const browser = new Window({ url: 'http://127.0.0.1:4470/updates?type=NEWS&page=2' });
  const keys = ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','FocusEvent','sessionStorage','IS_REACT_ACT_ENVIRONMENT','matchMedia','fetch','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame'];
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const timers = new Map(), frames = new Map(); let nextTimer = 0;
  for (const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','FocusEvent','sessionStorage']) Object.defineProperty(globalThis, key, { value: key === 'window' ? browser : key === 'document' ? browser.document : browser[key], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), fetch: fetcher,
    setInterval: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++nextTimer; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id) });
  options.beforeRender?.(browser);
  const host = browser.document.createElement('div'); browser.document.body.append(host); const reactRoot = createRoot(host);
  const settle = async action => { await act(async () => { await action?.(); await new Promise(resolve => setTimeout(resolve, 5)); }); };
  await settle(() => reactRoot.render(React.createElement(component, props)));
  t.after(async () => { await settle(() => reactRoot.unmount()); await browser.happyDOM.abort(); for (const key of keys) previous[key] ? Object.defineProperty(globalThis, key, previous[key]) : delete globalThis[key]; });
  return { browser, host, settle, timers, frames, render: next => settle(() => reactRoot.render(React.createElement(component, next))) };
}
test('home ticker rotates real published rows, pauses on hover/focus and retains a fixed view-all link', async t => {
  const rows = [item('one', { tickerEnabled: true, tickerUntil: new Date(now + 86400_000).toISOString() }), item('two', { tickerEnabled: true, tickerUntil: new Date(now + 86400_000).toISOString() })];
  const h = await mount(t, components.PlatformUpdateTicker, async () => Response.json(page(rows)));
  const title = () => h.host.querySelector('.platform-update-message a').textContent;
  assert.equal(title(), '本地测试 one'); const timer = () => [...h.timers.values()].find(x => x.delay === 5000);
  assert.ok(timer()); await h.settle(() => timer().fn()); assert.equal(title(), '本地测试 two');
  const box = h.host.querySelector('.platform-update-ticker');
  await h.settle(() => box.dispatchEvent(new h.browser.MouseEvent('mouseover', { bubbles: true })));
  assert.equal(timer(), undefined); assert.equal(box.getAttribute('data-running'), 'false');
  await h.settle(() => box.dispatchEvent(new h.browser.MouseEvent('mouseout', { bubbles: true, relatedTarget: h.browser.document.body })));
  assert.ok(timer()); await h.settle(() => h.host.querySelector('.platform-update-message a').dispatchEvent(new h.browser.FocusEvent('focusin', { bubbles: true })));
  assert.equal(timer(), undefined); assert.equal(h.host.querySelector('.platform-update-all').getAttribute('href'), '/updates');
});
test('empty/expired ticker renders no block, while a read error still offers retry', async t => {
  let failed = true;
  const h = await mount(t, components.PlatformUpdateTicker, async () => failed ? new Response('', { status: 503 }) : Response.json(page([item('expired', { tickerEnabled: true, tickerUntil: new Date(now - 1).toISOString() })])));
  assert.ok(h.host.textContent.includes('动态暂时无法读取')); assert.ok(h.host.querySelector('.platform-update-message button'));
  failed = false; await h.settle(() => h.host.querySelector('.platform-update-message button').click());
  // 无可见动态（已过期）时整块不渲染，包括查看全部入口。
  assert.equal(h.host.querySelector('.platform-update-ticker'), null);
  assert.equal(h.host.querySelector('.platform-update-all'), null);
  assert.ok(!h.host.textContent.includes('暂无可展示'));
});
test('business reminder uses the selected surface and displays effect and impact independently of home exposure', async t => {
  const requests = [], rows = [{ ...item('maintenance', { noticeKind: 'maintenance', effectiveAt: '2026-10-29T00:00:00Z', impact: '仅本地验收', surfaces: ['publish', 'rental', 'orders'] }), title: '长标题'.repeat(25) }];
  const h = await mount(t, components.BusinessUpdateNotices, async url => { requests.push(url); return Response.json(page(rows)); }, { surface: 'publish', gameId: 'delta_game' });
  assert.match(requests[0], /surface=publish/); assert.match(requests[0], /gameId=delta_game/);
  assert.ok(h.host.textContent.includes('仅本地验收') && h.host.textContent.includes('生效时间'));
  assert.equal(h.host.querySelector('a').getAttribute('href'), '/updates/maintenance');
  for (const surface of ['rental', 'orders']) {
    await h.render({ surface });
    assert.match(requests.at(-1), new RegExp(`surface=${surface}`));
    assert.ok(h.host.textContent.includes(rows[0].title));
  }
});
test('returning from detail restores the saved list scroll after the filtered page has rendered', async t => {
  router.calls.length = 0; const data = { ...page([item('one')]), page: 2, total: 25, totalPages: 3 };
  const h = await mount(t, lists.UpdatesList, async () => { throw Error('list is server supplied'); }, { data, type: 'NEWS' });
  Object.defineProperty(h.browser, 'scrollY', { value: 620, configurable: true }); let restored = null; h.browser.scrollTo = (_x, y) => { restored = y; };
  await h.settle(() => h.host.querySelector('.updates-row').dispatchEvent(new h.browser.MouseEvent('click', { bubbles: true })));
  await h.render({ data, type: 'NEWS', restore: true });
  await h.settle(() => { for (const frame of h.frames.values()) frame(); });
  assert.equal(restored, 620); assert.equal(router.calls.at(-1)[0], '/updates?type=NEWS&page=2');
});


test('homepage popup defers to authentication and remembers each published version in this browser', async t => {
  const { HomeAnnouncement } = load('src/components/content/home-announcement.tsx');
  let version = 'v1'; popupAuthOpen = true;
  const document = { format: 'plate', schemaVersion: 1, preset: 'update', value: [{ type: 'p', children: [{ text: '重要公告正文' }] }] };
  const fixture = () => ({ ...item('popup', { homePopup: true }), versionId: version, body: '重要公告正文', document });
  const fetcher = async url => ({ ok: true, json: async () => { const result = fixture(); if (String(url).includes('?')) return { ...page([result]), limit: 1 }; const { homePopup, ...settings } = result.settings; return { ...result, settings }; } });
  const h = await mount(t, HomeAnnouncement, fetcher, { key: 'first' });
  assert.equal(h.browser.document.querySelector('[role="dialog"]'), null, '认证弹窗优先');
  popupAuthOpen = false; await h.render({ key: 'first' });
  assert.match(h.browser.document.querySelector('[role="dialog"]').textContent, /重要公告正文/);
  await h.settle(() => [...h.browser.document.querySelectorAll('button')].find(x => x.textContent === '我知道了').click());
  assert.equal(h.browser.localStorage.getItem('zzsh:home-announcement:popup'), 'v1');
  await h.render({ key: 'again' });
  assert.equal(h.browser.document.querySelector('[role="dialog"]'), null, '同一版本不重复展示');
  version = 'v2'; await h.render({ key: 'new-version' });
  assert.ok(h.browser.document.querySelector('[role="dialog"]'), '新发布版本可再次展示');
  popupAuthOpen = false;
});

test('homepage popup fails closed for stale details and remains dismissible when storage is blocked', async t => {
  const { HomeAnnouncement } = load('src/components/content/home-announcement.tsx');
  let mismatch = true;
  const candidate = { ...item('popup2', { homePopup: true }), body: '正文' };
  const fetcher = async url => ({ ok: true, json: async () => String(url).includes('?') ? { ...page([candidate]), limit: 1 } : { ...candidate, versionId: mismatch ? 'different_version' : candidate.versionId } });
  const h = await mount(t, HomeAnnouncement, fetcher, { key: 'stale' }, { beforeRender: browser => Object.defineProperty(browser, 'localStorage', { configurable: true, get() { throw Error('blocked'); } }) });
  assert.equal(h.browser.document.querySelector('[role="dialog"]'), null, '详情版本变化时不显示');
  mismatch = false; await h.render({ key: 'storage-blocked' });
  assert.ok(h.browser.document.querySelector('[role="dialog"]'));
  await h.settle(() => [...h.browser.document.querySelectorAll('button')].find(x => x.textContent === '我知道了').click());
  assert.equal(h.browser.document.querySelector('[role="dialog"]'), null, '存储受限仍可关闭');
  popupAuthOpen = true; await h.render({ key: 'storage-blocked' });
  popupAuthOpen = false; await h.render({ key: 'storage-blocked' });
  assert.equal(h.browser.document.querySelector('[role="dialog"]'), null, '存储受限时登录弹窗开关不会重复提示');
});


test('an open homepage notice closes at its display expiry', async t => {
  const { HomeAnnouncement } = load('src/components/content/home-announcement.tsx');
  const candidate = { ...item('expires', { homePopup: true, validUntil: new Date(Date.now() + 500).toISOString() }), body: '正文' };
  const fetcher = async url => ({ ok: true, json: async () => String(url).includes('?') ? { ...page([candidate]), limit: 1, asOf: new Date().toISOString() } : candidate });
  const h = await mount(t, HomeAnnouncement, fetcher);
  assert.ok(h.browser.document.querySelector('[role="dialog"]'));
  await h.settle(() => new Promise(resolve => setTimeout(resolve, 650)));
  assert.equal(h.browser.document.querySelector('[role="dialog"]'), null);
});
