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
  hasUsefulUserPreview,
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

test('UserPreviewCard renders neutral authorized summary with initial fallback and no extra business detail request', async (t) => {
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
          canOpen: true,
          onOpen: () => { opened = true; },
          openLabel: '查看号主资料',
        })
      )
    );
  });
  await settle();

  // This fixture has no avatar asset; opening the card never fetches business detail.
  assert.equal(fetchCalled, false, 'Preview rendering must make no extra business detail request');

  // 2. Neutral name and masked phone, without a host relationship badge.
  const text = container.textContent;
  assert.ok(text.includes('凉介'), 'Renders user name');
  assert.equal(container.querySelector('[data-slot="badge"]'), null, 'user identity does not inherit a row relationship');
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
          canOpen: false,
          deniedReason: '当前身份没有查看该用户权限。',
        })
      )
    );
  });
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('匿名用户'));
  assert.equal(container.querySelector('[data-slot="badge"]'), null, 'no relationship badge is supplied by the host');
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

test('OrderPreviewCard neutrally displays order state, renter, owner and exact amount', async (t) => {
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
          renterName: '租客小李',
          ownerName: '号主老王',
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
  assert.ok(text.includes('租客：租客小李'), 'Renders neutral renter name');
  assert.ok(text.includes('号主：号主老王'), 'Renders neutral owner name');
  assert.equal(text.includes('本单身份'), false, 'Subjective host role text removed');
  assert.equal(text.includes('对方：@'), false, 'Subjective counterparty prefix removed');
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

test('UserPreviewCard renders membership, credit and risk facts when available', async (t) => {
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
          name: '高危VIP用户',
          membershipTier: '黄金会员',
          creditState: 'KNOWN',
          creditScore: 85,
          riskFlag: true,
          accountStatus: '正常',
        })
      )
    );
  });
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('高危VIP用户'));
  assert.ok(text.includes('会员：黄金会员'));
  assert.ok(text.includes('信用分：85'));
  assert.ok(text.includes('高危'));
  assert.equal(text.includes('安全'), false, 'Unflagged or flagged must never say safe');
});

test('AccountPreviewCard displays haff, materials, term and login method neutrally without default tag', async (t) => {
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
        createElement(AccountPreviewCard, {
          accountId: 'acc_test_1',
          displayNo: 'ACC-20261022-888',
          title: '顶级全装账号',
          gameName: '三角洲行动',
          haffText: '1500万',
          materialsText: '6级甲×2',
          termText: '2天',
          loginMethodText: '扫码登录',
          sourceText: '本单快照',
        })
      )
    );
  });
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('ACC-20261022-888'));
  assert.ok(text.includes('哈夫币：1500万'));
  assert.ok(text.includes('6级甲×2'));
  assert.ok(text.includes('租期：2天'));
  assert.ok(text.includes('上号方式：扫码登录'));
  assert.ok(text.includes('资料来源：本单快照'));
  assert.equal(text.includes('本单账号'), false, 'Default tag 本单账号 must be removed');
});

test('user preview shows the authorized public number, permanent tier, zero credit and Beijing login time without a request', async t => {
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Preview must not fetch'); });
  await act(async () => root.render(createElement(UserPreviewCard, {
    name: '合成已核用户', userId: 'synthetic-user-private-id', businessNo: '202610260001',
    accountStatus: '正常', realNameStatus: '已实名', lastLoginAt: '2026-10-25T23:58:00.000Z', riskFlag: true,
    membershipSummary: { state: 'ready', growth: { knowledge: 'KNOWN', effectiveTier: 'BLACK_GOLD' } },
    creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 0, revision: '1' },
  })));
  const text = container.textContent;
  assert.match(text, /202610260001/); assert.match(text, /黑金（永久）/); assert.match(text, /信用分：0/);
  assert.match(text, /正常/); assert.match(text, /已实名/); assert.match(text, /内部高危/);
  assert.match(text, /最后登录/); assert.match(text, /2026[/-]10[/-]26/); assert.match(text, /07:58/);
  assert.doesNotMatch(text, /synthetic-user-private-id|安全|租客|号主/);
  assert.equal(requests, 0);
  const copy = container.querySelector('[aria-label="复制用户编号"]'); assert.ok(copy);
  await act(async () => copy.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })));
  assert.equal(globalThis.__lastCopied, '202610260001');
});

test('denied and unknown summaries override stale scalar membership and credit values', async t => {
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  for (const props of [
    { membershipSummary: { state: 'denied', permission: 'membership.growth.read.summary' }, creditSummary: { state: 'denied', permission: 'credit.read' } },
    { membershipSummary: { state: 'ready', growth: { knowledge: 'UNKNOWN', effectiveTier: 'GOLD' } }, creditSummary: { state: 'ready', knowledge: 'NOT_INITIALIZED', score: null } },
    { creditState: 'DENIED' }, { creditState: 'OUT_OF_SCOPE' }, { creditState: 'UNKNOWN' },
  ]) {
    await act(async () => root.render(createElement(UserPreviewCard, { name: '合成用户', membershipTier: props.membershipSummary ? '秘密旧等级' : undefined, creditState: 'KNOWN', creditScore: 99, ...props })));
    assert.doesNotMatch(container.textContent, /秘密旧等级|信用分：99/);
  }
});

test('preview usefulness recognizes authorized public facts while absent login data stays absent', async t => {
  const base = { name: '同名', image: null, maskedPhone: null };
  for (const facts of [{ businessNo: '202610260001' }, { accountStatus: '正常' }, { realNameStatus: '已实名' }, { lastLoginAt: '2026-10-26T00:00:00Z' }]) {
    assert.equal(hasUsefulUserPreview({ ...base, ...facts }, '同名'), true);
  }
  assert.equal(hasUsefulUserPreview({ ...base, lastLoginAt: 'NOT_A_DATE' }, '同名'), false);
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(UserPreviewCard, { name: '同名', lastLoginAt: null, riskFlag: false })));
  assert.doesNotMatch(container.textContent, /最后登录|普通会员|信用分：0|安全/);
});

test('account preview presents same-version conditions and labels a frozen deposit without implying availability', async t => {
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Preview must not fetch'); });
  await act(async () => root.render(createElement(AccountPreviewCard, {
    displayNo: 'ZZ202610260001', gameName: '三角洲行动', safeBoxText: '顶级安全箱（3×3）', rankText: '钻石 I',
    haffText: '160 M', materialsText: 'AWM子弹 65发 · 六级甲 9件', termText: '2天', loginMethodText: '微信扫码',
    depositText: '¥0.00', depositLabel: '本单冻结押金', sourceText: '本单冻结版本',
  })));
  const text = container.textContent;
  assert.match(text, /顶级安全箱/); assert.match(text, /钻石 I/); assert.match(text, /160 M/); assert.match(text, /AWM子弹 65发/);
  assert.match(text, /2天/); assert.match(text, /微信扫码/); assert.match(text, /本单冻结押金/); assert.match(text, /¥0\.00/);
  assert.doesNotMatch(text, /基础押金|可租|可接单|租入|租出/); assert.equal(requests, 0);
});

test('account preview keeps meaningful historical provenance but suppresses an order-origin-only line', async t => {
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(AccountPreviewCard, { displayNo: 'SYNTHETIC', sourceText: '新平台订单' })));
  assert.doesNotMatch(container.textContent, /资料来源|新平台订单|基础押金/);
  await act(async () => root.render(createElement(AccountPreviewCard, { displayNo: 'SYNTHETIC', sourceText: '历史账号参考' })));
  assert.match(container.textContent, /历史账号参考/); assert.doesNotMatch(container.textContent, /本单冻结版本/);
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

test('both callers share an objective preview gate and an empty supply summary preserves only its original link', async t => {
  assert.equal(hasUsefulUserPreview({ name: '同名', image: null, maskedPhone: null, riskFlag: false }, '同名'), false);
  assert.equal(hasUsefulUserPreview({ name: ' 同名 ', image: '', maskedPhone: ' ' }, '同名'), false);
  assert.equal(hasUsefulUserPreview({ name: '当前新名', image: null, maskedPhone: null }, '历史旧名'), true);
  const container = browser.document.createElement('div'); browser.document.body.append(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let opened = 0, rows = 0;
  await act(async () => root.render(createElement('div', { onClick: () => rows++ }, createElement(OwnerHoverCard, { ownerName: '同名', ownerId: 'synthetic-owner-id', summary: { name: '同名', image: null, maskedPhone: null }, canOpen: true, onOpenOwner: () => opened++ }))));
  assert.equal(container.querySelector('[aria-label^="预览号主"]'), null);
  await act(async () => container.querySelector('button').dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })));
  assert.equal(opened, 1); assert.equal(rows, 0);
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
  assert.equal([...popup.querySelectorAll('[data-slot="badge"]')].some(badge => badge.textContent.trim() === '号主'), false, 'the shared user card does not inherit the supply row relationship');
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

test('CLARITY-02 AccountPreviewCard: legacy badge hides old number; price block precedes basic info', async (t) => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); t.after(() => { act(() => root.unmount()); container.remove(); });
  await act(async () => root.render(createElement(AccountPreviewCard, { displayNo: null, legacy: true, priceTitle: '旧单原单金额', priceRows: [['哈夫币比例', '旧单未记录比例'], ['押金', '未知']], loginMethodText: '微信扫码', safeBoxText: '6格' })));
  const text = container.textContent;
  assert.match(text, /旧平台账号/); assert.match(text, /旧平台/);
  assert.doesNotMatch(text, /账号编号待核/);
  assert.ok(text.indexOf('哈夫币比例') < text.indexOf('上号方式'), '价格块在基础信息前');
  assert.ok(text.indexOf('上号方式') < text.indexOf('安全箱'));
  assert.match(text, /押金未知/, '未知不补 0');
});
