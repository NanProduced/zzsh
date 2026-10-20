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
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: window.ResizeObserver, SVGElement: window.SVGElement, ShadowRoot: window.ShadowRoot, CSS: window.CSS,
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
        kind === 'skin' ? '测试外观 皮肤图片' : '画廊控制 大图预览');
      if (kind === 'skin') {
        const preview = dialog.querySelector('img');
        assert.equal(preview.getAttribute('alt'), '测试外观 皮肤图片');
        assert.equal(preview.getAttribute('src'), '/api/supply/media/MEDIA_SYNTHETIC/content');
        assert.equal(preview.getAttribute('data-state'), 'loading');
        assert.match(dialog.textContent, /品质待核/);
        await React.act(async () => preview.dispatchEvent(new window.Event('error')));
        assert.match(dialog.textContent, /图片暂不可用/);
        await React.act(async () => dialog.querySelector('.skin-preview-retry').click());
        const recovered = dialog.querySelector('img');
        assert.ok(recovered, 'preview retries through the same real-media URL');
        await React.act(async () => recovered.dispatchEvent(new window.Event('load')));
        assert.equal(recovered.getAttribute('data-state'), 'loaded');
        assert.equal(dialog.textContent.includes('图片加载中'), false);
      }
      await React.act(async () => closing === 'escape'
        ? dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
        : dialog.querySelector('[aria-label="关闭预览"]').click());
      await settle();
      assert.equal(document.querySelector('[role="dialog"]'), null, `${kind}/${closing}: dialog closes`);
      assert.equal(trigger.isConnected, true);
      assert.equal(document.activeElement === trigger, true, `${kind}/${closing}: focus returns to its still-connected trigger`);
      t.diagnostic(`${kind}/${closing}: real portal opened, closed, and restored its trigger`);
    }

    const { Drawer } = await import('@heroui/react/drawer');
    const { SkinMediaPreview } = load('apps/web/src/components/supply/skin-media-thumb.tsx');
    const h = React.createElement;
    function NestedPicker() {
      const [drawerOpen, setDrawerOpen] = React.useState(true);
      const [pickerOpen, setPickerOpen] = React.useState(true);
      const picker = pickerOpen ? h('div', { className: 'skin-preview-test-picker', onKeyDown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPickerOpen(false); }
      } },
      h('input', { type: 'checkbox', defaultChecked: true, 'aria-label': '保留临时选择' }),
      h(SkinMediaPreview, { skin: data.skinTags[0], triggerClassName: 'skin-preview-test-trigger' }, '预览图片')) : null;
      return h(Drawer, { isOpen: drawerOpen, onOpenChange: setDrawerOpen },
        h(Drawer.Trigger, null, '打开测试筛选'),
        h(Drawer.Backdrop, { variant: 'opaque' },
          h(Drawer.Content, { placement: 'bottom' },
            h(Drawer.Dialog, { className: 'skin-preview-test-drawer' },
              h(Drawer.Header, null, h(Drawer.Heading, null, '测试筛选')),
              h(Drawer.Body, null, h('button', { type: 'button' }, '底层控件'), picker)))));
    }
    await React.act(async () => root.render(h(NestedPicker))); await settle();
    const drawer = document.querySelector('.skin-preview-test-drawer');
    assert.ok(drawer, 'real HeroUI Drawer opens');
    for (const closing of ['escape', 'close']) {
      const trigger = drawer.querySelector('.skin-preview-test-trigger');
      trigger.focus();
      await React.act(async () => trigger.click()); await settle();
      const preview = document.querySelector('.skin-preview-content');
      assert.ok(preview, 'nested real Radix preview opens');
      assert.equal(preview.inert, false, 'the real Drawer observer must not make its nested preview inert');
      assert.equal(preview.closest('[inert], [aria-hidden="true"]'), null, 'preview stays in the accessible tree');
      assert.equal(preview.contains(document.activeElement), true, 'focus enters the preview rather than remaining in the Drawer');
      await React.act(async () => preview.querySelector('img').dispatchEvent(new window.Event('error')));
      const close = preview.querySelector('[aria-label="关闭预览"]'), retry = preview.querySelector('.skin-preview-retry');
      for (const [start, shiftKey, expected] of [[close, true, retry], [retry, false, close]]) {
        start.focus();
        const tab = new window.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey, bubbles: true, cancelable: true });
        await React.act(async () => start.dispatchEvent(tab));
        assert.equal(tab.defaultPrevented, true, 'Radix wraps focus at the preview boundary');
        assert.equal(document.activeElement, expected, 'Tab stays inside the preview, outside controls cannot receive it');
      }
      await React.act(async () => closing === 'escape'
        ? close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
        : close.click());
      await settle();
      assert.equal(document.querySelector('.skin-preview-content'), null);
      assert.equal(document.querySelector('.skin-preview-test-drawer'), drawer, 'Escape/close keeps the outer Drawer open');
      assert.ok(drawer.querySelector('.skin-preview-test-picker'), 'Escape closes only the preview, not the inline picker');
      assert.equal(drawer.querySelector('[aria-label="保留临时选择"]').checked, true, 'staged selection survives');
      assert.equal(document.activeElement, trigger, 'focus returns to the exact nested trigger');
      t.diagnostic(`nested Drawer/${closing}: real observer, focus containment, selection and return trigger passed`);
    }
    assert.equal(requests, 0, 'component test performs no network requests');
  } finally {
    await React.act(async () => root.unmount());
    await window.happyDOM.abort();
  }
});
