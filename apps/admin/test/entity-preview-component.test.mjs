import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement, StrictMode, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/supply/accounts' });
let width = 1440;
browser.matchMedia = query => ({
  media: query,
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
});
Object.defineProperty(browser, 'innerWidth', { get: () => width, configurable: true });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver']) {
  globalThis[name] = name === 'window' ? browser : browser[name];
}
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...browser.navigator,
    clipboard: {
      writeText: async (text) => {
        globalThis.__lastCopied = text;
      },
    },
  },
  configurable: true,
});
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  root: rootPath,
  configFile: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(rootPath, 'src'),
      '@brand': path.resolve(rootPath, '../../assets/brand'),
    },
  },
  server: { middlewareMode: true, hmr: false },
});

const {
  UserPreviewCard,
  AccountPreviewCard,
  OrderPreviewCard,
  EntityPreviewTrigger,
} = await vite.ssrLoadModule('/src/components/admin-preview/index.ts');
const { OwnerHoverCard } = await vite.ssrLoadModule('/src/views/supply-accounts/owner-hover-card.tsx');

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}

async function waitFor(check) {
  for (let tries = 0; tries < 100; tries++) { if (check()) return; await settle(); }
  throw new Error('Entity preview condition timed out');
}

test('UserPreviewCard renders authentic owner summary with initial fallback, tags, and zero network calls', async (t) => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };

  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  let opened = false;
  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(UserPreviewCard, {
          name: '凉介',
          userId: 'user_1e937dc575d8b73453',
          maskedPhone: '+86153****5095',
          roleTag: '号主',
          canOpen: true,
          onOpen: () => { opened = true; },
          openLabel: '查看号主资料',
        })
      )
    );
  });
  await settle();

  // 1. Zero requests made
  assert.equal(fetchCalled, false, 'Preview rendering must make 0 network requests');

  // 2. Name, roleTag, masked phone
  const text = container.textContent;
  assert.ok(text.includes('凉介'), 'Renders user name');
  assert.ok(text.includes('号主'), 'Renders custom role tag');
  assert.ok(text.includes('+86153****5095'), 'Renders masked phone');
  assert.equal(text.includes('user_1e937dc575d8b73453'), false, 'UUID is not displayed');
  assert.equal(text.includes('ID:'), false, 'UUID snippets do not add display noise');
  assert.ok(container.querySelector('[aria-label^="复制用户"]'), 'stable ID remains available through the explicit copy action');

  // 3. Detail link action and stopPropagation
  const linkBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('查看号主资料'));
  assert.ok(linkBtn, 'Action link button exists when canOpen is true');
  await act(async () => {
    linkBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
  assert.equal(opened, true, 'onOpen callback called on button click');
});

test('UserPreviewCard handles missing phone and unauthorized downgrade gracefully', async (t) => {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(UserPreviewCard, {
          name: '匿名用户',
          userId: undefined,
          maskedPhone: null,
          roleTag: '买家',
          canOpen: false,
          deniedReason: '当前身份没有查看该用户权限。',
        })
      )
    );
  });
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('匿名用户'));
  assert.ok(text.includes('买家'));
  assert.equal(text.includes('脱敏联系方式未提供'), false, 'missing optional contact data adds no noise');
  assert.ok(text.includes('当前身份没有查看该用户权限'), 'Shows clear denied reason');

  const linkBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('查看用户资料'));
  assert.equal(linkBtn, undefined, 'No detail navigation button when canOpen is false');
});

test('AccountPreviewCard displays numbers, title, known facts and omits speculative data', async (t) => {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  let accountOpened = false;
  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(AccountPreviewCard, {
          displayNo: 'ZZ20261019000001',
          accountId: 'acc_1001',
          gameName: '三角洲行动',
          title: '全枪皮高配号 · 满级干员',
          tag: '本单账号',
          facts: {
            staffRestricted: true,
            ownerPaused: true,
            reviewState: 'APPROVED',
          },
          canOpen: true,
          onOpen: () => { accountOpened = true; },
        })
      )
    );
  });
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('ZZ20261019000001'), 'Displays account number');
  assert.ok(text.includes('三角洲行动'), 'Displays game name');
  assert.ok(text.includes('全枪皮高配号'), 'Displays title');
  assert.ok(text.includes('本单账号'), 'Displays context tag');
  assert.ok(text.includes('平台限制'), 'Displays staffRestricted fact badge');
  assert.ok(text.includes('号主暂停'), 'Displays ownerPaused fact badge');
  assert.ok(text.includes('审核通过'), 'APPROVED is an approval fact');
  assert.equal(text.includes('已发布'), false, 'approval alone does not establish publication');

  const detailBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('查看账号详情'));
  assert.ok(detailBtn);
  await act(async () => {
    detailBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
  assert.equal(accountOpened, true);
});

test('OrderPreviewCard displays order state, role, counterparty and exact amount', async (t) => {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  let orderOpened = false;
  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement(OrderPreviewCard, {
          orderId: 'order_test_101',
          displayNo: 'ORD-20261022-001',
          status: 'PAID',
          statusLabel: '已支付',
          role: 'renter',
          counterpartyName: '号主老王',
          title: '三角洲行动优质账号',
          createdAt: '2026-10-22 14:00',
          amountText: '本单应付 68.00 元',
          sourceOrigin: 'LEGACY',
          canOpen: true,
          onOpen: () => { orderOpened = true; },
        })
      )
    );
  });
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('ORD-20261022-001'), 'Renders order display number');
  assert.ok(text.includes('已支付'), 'Renders status label');
  assert.ok(text.includes('本单身份：租客'), 'Renders role');
  assert.ok(text.includes('对方：@号主老王'), 'Renders counterparty');
  assert.ok(text.includes('本单应付 68.00 元'), 'Renders exact amount without alteration');
  assert.ok(text.includes('旧单'), 'Renders legacy order badge');

  const detailBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('查看订单详情'));
  assert.ok(detailBtn);
  await act(async () => {
    detailBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
  assert.equal(orderOpened, true);
});

test('OwnerHoverCard in supply view prevents event bubbling to row drawer', async (t) => {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  let rowClicked = false;
  let ownerOpened = false;

  await act(async () => {
    root.render(
      createElement(StrictMode, null,
        createElement('div', {
          onClick: () => { rowClicked = true; },
        },
          createElement(OwnerHoverCard, {
            ownerName: '测试号主',
            ownerId: 'user_supply_101',
            summary: {
              name: '测试号主真实名',
              image: null,
              maskedPhone: '138****0000',
            },
            canOpen: true,
            onOpenOwner: () => { ownerOpened = true; },
          })
        )
      )
    );
  });
  await settle();

  // Click the trigger button @测试号主
  const triggerBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('@测试号主'));
  assert.ok(triggerBtn, 'Trigger button renders');

  await act(async () => {
    triggerBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();

  assert.equal(ownerOpened, true, 'onOpenOwner is triggered');
  assert.equal(rowClicked, false, 'Clicking trigger MUST NOT bubble to parent row container');
});

test('explicit preview opens in the workspace portal and its copy and detail actions never open the row', async t => {
  const container = browser.document.createElement('div'); container.className = 'workspace-root'; browser.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let rows = 0, opened = 0, requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Preview must not fetch'); });
  await act(async () => root.render(createElement('div', { onClick: () => rows++, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') rows++; } },
    createElement(OwnerHoverCard, { ownerName: '预览号主', ownerId: 'synthetic-owner-id', summary: { name: '预览号主', image: null, maskedPhone: 'SYNTHETIC-***-PHONE' }, canOpen: true, onOpenOwner: () => opened++ }))));
  const trigger = container.querySelector('[aria-label="预览号主 @预览号主 信息"]');
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })); });
  await waitFor(() => container.querySelector('[data-slot="popover-content"][data-open]'));
  const popup = container.querySelector('[data-slot="popover-content"]');
  assert.equal(popup.closest('.workspace-root'), container);
  const copy = popup.querySelector('[aria-label^="复制用户"]');
  await act(async () => copy.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })));
  await waitFor(() => globalThis.__lastCopied === 'synthetic-owner-id');
  await waitFor(() => popup.querySelector('[role="status"]')?.textContent === '已复制');
  t.mock.method(navigator.clipboard, 'writeText', async () => { throw new Error('SYNTHETIC_CLIPBOARD_REJECTION'); });
  await act(async () => copy.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })));
  await waitFor(() => popup.querySelector('[role="status"]')?.textContent === '复制失败，请重试');
  const detail = [...popup.querySelectorAll('button')].find(button => button.textContent.includes('查看号主资料'));
  await act(async () => {
    detail.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    detail.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  assert.equal(opened, 1); assert.equal(rows, 0); assert.equal(requests, 0);
  await act(async () => popup.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })));
  await waitFor(() => !container.querySelector('[data-slot="popover-content"][data-open]'));
  assert.equal(browser.document.activeElement, trigger);
});

test('preview button opacity is conditioned on pointer capability rather than viewport width', async t => {
  const { compile } = await import('@tailwindcss/node');
  const container = browser.document.createElement('div'); browser.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  width = 1024;
  await act(async () => root.render(createElement(EntityPreviewTrigger, { trigger: createElement('button', null, '对象'), content: createElement('div', null, '预览'), touchLabel: '显式对象预览' })));
  const button = container.querySelector('[aria-label="显式对象预览"]');
  assert.ok(button, 'wide touch devices still have an explicit preview control');
  const candidates = button.className.split(/\s+/).filter(value => value.endsWith(':opacity-0'));
  const compiler = await compile('@import "tailwindcss";', { base: rootPath, onDependency() {} });
  for (const candidate of candidates) {
    const css = compiler.build([candidate]);
    assert.match(css, /hover:\s*hover/, 'hiding requires a device that can hover');
    assert.match(css, /pointer:\s*fine/, 'coarse touch pointers keep the explicit button visible');
  }
});

test('the real supply session boundary unmounts previews without changing the business child or reviving an open card', async t => {
  const { SupplyListingReviewView } = await vite.ssrLoadModule('/src/views/supply-listing-review-view.tsx');
  const actor = { authenticated: true, adminUserId: 'synthetic-preview-admin', session: { id: 'synthetic-preview-session', locked: false }, security: { isBoss: false, status: 'ACTIVE', passwordChangeRequired: false }, permissions: ['supply.review.read'] };
  const boundary = (state = {}) => SupplyListingReviewView({ snapshot: { ...actor, session: { ...actor.session, locked: state.locked ?? false }, security: { ...actor.security, ...state } }, refreshNonce: 0, initialQuery: {}, onDirtyChange() {}, onOpenPath() {}, onQueryChange() {} });
  const initial = boundary();
  assert.ok([Symbol.for('react.context'), Symbol.for('react.provider')].includes(initial.type.$$typeof), 'production owns the session boundary, not a test enabled formula');
  const container = browser.document.createElement('div'); container.className = 'workspace-root'; browser.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Preview must not fetch'); });
  function WorkProbe() {
    return createElement('div', null, createElement('input', { 'aria-label': '未提交的处理说明', defaultValue: '尚未提交' }),
      createElement(OwnerHoverCard, { ownerName: '会话测试号主', ownerId: 'synthetic-owner-id', summary: { name: '会话测试号主', image: null, maskedPhone: 'SYNTHETIC-***-PHONE' }, canOpen: false }));
  }
  const render = async state => {
    const next = boundary(state);
    assert.equal(next.type, initial.type);
    assert.equal(next.props.children.type, initial.props.children.type, 'the original SupplyWork component is retained');
    assert.equal(next.props.children.key, initial.props.children.key, 'security changes do not remount the business child');
    await act(async () => root.render(createElement(next.type, next.props, createElement(WorkProbe))));
  };
  await render();
  const input = container.querySelector('input');
  for (const state of [{ locked: true }, { status: 'FROZEN' }, { passwordChangeRequired: true }]) {
    const button = container.querySelector('[aria-label="预览号主 @会话测试号主 信息"]');
    await act(async () => button.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })));
    await waitFor(() => container.querySelector('[data-slot="popover-content"][data-open]'));
    await render(state);
    assert.equal(container.querySelector('[data-slot="popover-content"]'), null);
    assert.equal(container.querySelector('[data-slot="hover-card-content"]'), null);
    assert.equal(container.querySelector('input'), input, 'unrelated work remains mounted');
    await render();
    assert.equal(container.querySelector('[data-slot="popover-content"]'), null, 'unlock does not revive the card');
    assert.equal(input.value, '尚未提交');
  }
  assert.equal(requests, 0);
});
