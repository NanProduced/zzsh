import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rq = createRequire(path.join(tree, 'package.json'));
const React = rq('react'), ts = rq('typescript'), { Window } = rq('happy-dom');

test('real skin preview restores its clicked trigger after Escape and close, alongside the gallery control', async (t) => {
  // Radix selects its layout-effect implementation on first import. Keep one DOM alive for this whole test.
  const window = new Window({ url: 'http://127.0.0.1:3100/accounts/offline-synthetic' });
  Object.assign(globalThis, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent, NodeFilter: window.NodeFilter, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'KeyboardEvent', 'PointerEvent', 'FocusEvent']) globalThis[name] = window[name];
  let requests = 0;
  globalThis.fetch = window.fetch = async () => { requests++; throw new Error('NETWORK_REFUSED_OFFLINE_TEST'); };

  const empty = () => null, cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const absolute = path.join(tree, file), m = new Module(absolute);
    m.filename = absolute; m.paths = Module._nodeModulePaths(tree);
    m.require = (name) => {
      if (name.endsWith('.css')) return {};
      if (name === 'next/link') return ({ children, ...props }) => React.createElement('a', props, children);
      if (name === 'next/image') return { getImageProps: (props) => ({ props }) };
      if (name === '@/components/delta/account-card') return {
        composeGridTitle: () => ({ haff: '', rest: '离线账号' }), isHaff: () => false,
        moneyValue: (value, fallback) => value ?? fallback, orderedQuoteResources: () => [],
        accountHref: (id) => '/accounts/' + id,
      };
      if (name === '@/components/session/user-session-provider') return { useUserSession: () => ({ status: 'guest' }) };
      if (name === '@/components/favorites/favorite-button') return { FavoriteButton: empty, FavoriteNotice: empty };
      if (name === '@/components/order/rental-confirm-panel') return { RentalConfirmPanel: empty };
      if (name === '@/components/supply/skin-media-thumb') return load('apps/web/src/components/supply/skin-media-thumb.tsx');
      if (name === '@/lib/listing-view') return load('apps/web/src/lib/listing-view.ts');
      if (name === '@/lib/listing-filters') return load('apps/web/src/lib/listing-filters.ts');
      if (name.startsWith('./') || name.startsWith('../')) {
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
        return load(/\.tsx?$/.test(relative) ? relative : relative + '.ts');
      }
      if (name.startsWith('@/')) return {};
      return rq(name);
    };
    let source = fs.readFileSync(absolute, 'utf8');
    if (file.endsWith('listing-detail.tsx')) source = source.replace('function ReadyDetail(', 'export function ReadyDetail(').replace('function DetailGallery(', 'export function DetailGallery(');
    m._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, absolute);
    cache.set(file, m.exports);
    return m.exports;
  }

  const components = load('apps/web/src/components/market/listing-detail.tsx');
  const host = document.createElement('div'); document.body.append(host);
  const root = rq('react-dom/client').createRoot(host);
  const data = {
    id: 'ACCOUNT_SYNTHETIC', gameId: 'GAME_SYNTHETIC', versionId: 'VERSION_SYNTHETIC', releaseId: 'RELEASE_SYNTHETIC',
    title: '离线账号', publicTitle: '离线账号', displayNo: 'ZZ20261018000116', conditionLines: [], resourceLines: [],
    skinTags: [{ id: 'SKIN_SYNTHETIC', name: '测试外观', ownerKind: 'AGENT', rarityName: null, mediaId: 'MEDIA_SYNTHETIC' }],
    media: [], entitlementNames: [], termLabel: '1天', resourceTotalLabel: '待核定', canCreateOrder: false,
  };
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  try {
    for (const [kind, closing] of [['skin', 'escape'], ['skin', 'close'], ['gallery', 'escape']]) {
      await React.act(async () => root.render(kind === 'skin'
        ? React.createElement(components.ReadyDetail, { data })
        : React.createElement(components.DetailGallery, { title: '画廊控制', media: [{ assetId: 'ASSET_SYNTHETIC', url: '/offline-a.png', category: 'SHOWCASE' }] })));
      await settle();
      const trigger = host.querySelector(kind === 'skin' ? '.account-skin-card-media-btn' : '.detail-gallery-main');
      assert.ok(trigger, `${kind}: trigger exists`);
      trigger.focus(); assert.equal(document.activeElement === trigger, true);
      await React.act(async () => trigger.click()); await settle();
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog, `${kind}/${closing}: real Radix portal opens`);
      assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent,
        kind === 'skin' ? '测试外观 大图预览' : '画廊控制 大图预览');
      await React.act(async () => closing === 'escape'
        ? dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
        : dialog.querySelector('[aria-label="关闭预览"]').click());
      await settle();
      assert.equal(document.querySelector('[role="dialog"]'), null, `${kind}/${closing}: dialog closes`);
      assert.equal(trigger.isConnected, true);
      assert.equal(document.activeElement === trigger, true, `${kind}/${closing}: focus returns to its still-connected trigger`);
      t.diagnostic(`${kind}/${closing}: real portal opened, closed, and restored its trigger`);
    }
    assert.equal(requests, 0, 'component test performs no network requests');
  } finally {
    await React.act(async () => root.unmount());
    await window.happyDOM.abort();
  }
});
