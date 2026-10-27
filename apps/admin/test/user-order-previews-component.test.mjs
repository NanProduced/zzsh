import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Only two order rows are rendered. Keep the real directory, BFF and House previews;
// unrelated workspace leaves follow the existing origin-links harness boundary.
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/users/synthetic-preview-subject?section=orders' });
browser.matchMedia = query => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'localStorage', 'sessionStorage']) globalThis[name] = name === 'window' ? browser : browser[name];
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  root: rootPath, configFile: false,
  plugins: [react(), {
    name: 'order-previews-unrendered-workspace-leaves', enforce: 'pre',
    resolveId(id, importer) {
      const parent = importer?.replaceAll('\\', '/');
      if (!parent?.endsWith('/src/workspace/page-content.tsx')) return;
      if (['./settings-page', './account-security-page', './workbench', './workbench.tsx'].includes(id)) return '\0order-preview-leaf:' + id;
    },
    load(id) {
      if (!id.startsWith('\0order-preview-leaf:')) return;
      return 'export function SettingsWorkspace(){return null;} export function AccountSecurityPage(){return null;} export function WorkbenchPage(){return null;}';
    },
  }],
  resolve: { alias: { '@': path.join(rootPath, 'src'), '@brand': path.resolve(rootPath, '../../assets/brand') } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { UserDirectoryView } = await vite.ssrLoadModule('/src/views/user-directory/user-directory-view.tsx');
const { WorkspacePageContent } = await vite.ssrLoadModule('/src/workspace/page-content.tsx');
const { tabFromLocation } = await vite.ssrLoadModule('/src/workspace/tab-model.ts');
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const subject = 'synthetic-preview-subject';
const permissions = ['user.directory.read', 'order.read', 'supply.rental_account.read'];
const money = amount => ({ currency: 'CNY', unit: 'yuan', scale: 2, amount });
const user = {
  userId: subject, name: '合成测试用户', image: null, username: null, displayUsername: null, maskedPhone: '188****1100', maskedEmail: null,
  accountStatus: 'ACTIVE', suspended: false, identityStatus: 'UNKNOWN', ageStatus: 'UNKNOWN',
  source: { kind: 'LOCAL', legacyId: null }, registeredAt: '2026-10-20T00:00:00Z', registeredAtSource: 'LOCAL',
  createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', localCreatedAt: '2026-10-20T00:00:00Z',
  resourceSummary: { state: 'ready', count: 1, publishedCount: 1 },
  orderSummary: { state: 'ready', currentCount: 2, renterCurrentCount: 1, ownerCurrentCount: 1 },
  lastBusinessActivity: { state: 'not_connected', domains: ['ORDER', 'SUPPLY'] },
};
const knownOrder = {
  orderId: 'synthetic-preview-order-1', displayNo: 'SYNTHETIC-ORDER-1', accountId: 'synthetic-preview-account-1', accountDisplayNo: 'SYNTHETIC-ACCOUNT-1',
  status: 'PAID', role: 'renter', title: '本单冻结账号快照', counterpartyUserId: 'synthetic-preview-owner-1', counterpartyName: '下单时昵称',
  counterpartySummary: { name: '现在的昵称', image: null, maskedPhone: '188****1101' },
  gameId: 'delta', createdAt: '2026-10-21T01:00:00Z', paidAt: '2026-10-21T01:01:00Z', cancelledAt: null, cancelReason: null,
  amounts: { rental: money('60.00'), deposit: money('100.00'), totalDue: money('160.00') }, payment: { state: 'RECORDED_PAID' },
};
const unknownOrder = {
  ...knownOrder, orderId: 'synthetic-preview-order-2', displayNo: 'SYNTHETIC-ORDER-2', role: 'owner', status: 'CANCELLED', title: '旧单金额资料待核',
  accountId: undefined, accountDisplayNo: '12345678', counterpartyUserId: undefined, counterpartyName: '旧单对方昵称', counterpartySummary: undefined,
  amounts: { rental: null, deposit: null, totalDue: null }, payment: { state: 'UNKNOWN' }, source: { origin: 'LEGACY' },
};
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }
async function waitFor(fn) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw Error('Order preview component condition timed out'); await settle(); } }
const namedButton = (name, within = browser.document) => [...within.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') || element.textContent.trim()) === name);
const previewRegion = label => [...browser.document.querySelectorAll('[role="region"]')].find(element => element.getAttribute('aria-label') === label);
async function click(element) { assert.ok(element, 'expected the requested control'); await act(async () => element.click()); await settle(); }
async function openPreview(label, regionLabel) {
  const trigger = namedButton(label); await click(trigger); await waitFor(() => previewRegion(regionLabel));
  return { card: previewRegion(regionLabel), close: async () => { await click(trigger); await waitFor(() => !previewRegion(regionLabel)); } };
}
let serial = 0;
async function mount(t, options = {}) {
  browser.localStorage.clear(); browser.sessionStorage.clear();
  const query = { section: 'orders', ...options.query };
  browser.history.replaceState(null, '', `/users/${subject}?${new URLSearchParams(query)}`);
  const calls = [], opened = [];
  const actorPermissions = options.permissions ?? permissions;
  const snapshot = { authenticated: true, adminUserId: 'synthetic-preview-admin-' + ++serial,
    user: { name: '合成测试运营', username: 'SYNTHETIC-ADMIN', twoFactorEnabled: true },
    security: { status: 'ACTIVE', isBoss: false, passwordChangeRequired: false },
    session: { id: 'synthetic-preview-session-' + serial, locked: false, pinConfigured: true }, permissions: actorPermissions };
  const rows = options.rows ?? [knownOrder, unknownOrder];
  assert.equal(rows.length <= 2, true, 'bounded fixture must never grow into a full directory');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), method: init.method ?? 'GET' });
    assert.equal(init.method ?? 'GET', 'GET', 'previews must never issue commands');
    if (url.pathname === `/api/bff/admin/users/${subject}`) return json({ user });
    if (url.pathname === `/api/bff/admin/users/${subject}/orders`) return json({ items: structuredClone(rows), nextCursor: null, limit: 20 });
    throw Error('Unexpected order preview request: ' + url.pathname);
  };
  const host = browser.document.createElement('div'); host.className = 'workspace-root'; browser.document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [tab, setTab] = useState(tabFromLocation(browser.location.pathname, browser.location.search));
    const props = { tab, snapshot, refreshNonce: 0,
      onOpenPath: (target, title) => opened.push({ target, title }),
      onQueryChange: changed => setTab(current => ({ ...current, query: { ...current.query, ...changed } })) };
    return options.workspace ? createElement(WorkspacePageContent, { ...props, idleMinutes: 10, onIdleMinutes() {}, onLock() {}, onRefresh: async () => snapshot, onRecoveryCompleted() {}, onDirtyChange() {} }) : createElement(UserDirectoryView, props);
  }
  t.after(async () => {
    await act(async () => root.unmount()); host.remove(); await settle(); globalThis.fetch = previousFetch;
  });
  await act(async () => root.render(createElement(Harness))); await settle();
  if (actorPermissions.includes('order.read')) await waitFor(() => host.querySelectorAll('[data-order-id]').length === rows.length);
  else await waitFor(() => host.querySelector('[role="region"][aria-label="订单记录"]')?.textContent.includes('无权限'));
  return { host, calls, opened, snapshot };
}

test('Orders keeps order/account facts inline and only previews the related user without extra business GETs', async t => {
  const h = await mount(t), initialReads = structuredClone(h.calls);
  assert.deepEqual(h.snapshot.permissions, permissions);
  assert.equal(initialReads.length, 2, 'only user detail and its paginated orders are read');
  assert.equal(initialReads[0].params.registrationTime, 'ORIGINAL');
  assert.equal(initialReads[1].params.limit, '20');
  assert.equal(h.host.querySelector('[aria-label^="预览订单"]'), null); assert.equal(h.host.querySelector('[aria-label^="预览账号"]'), null);
  assert.ok(namedButton('SYNTHETIC-ORDER-1', h.host)); assert.ok(namedButton('账号 SYNTHETIC-ACCOUNT-1', h.host));
  const preview = await openPreview('预览用户 下单时昵称', '用户预览：下单时昵称');
  assert.equal(h.opened.length, 0, 'explicit info control does not navigate');
  assert.deepEqual(h.calls, initialReads, 'opening the related user preview must not fetch business detail');
  await preview.close(); assert.deepEqual(h.calls, initialReads);
});

test('inline order amounts preserve due/deposit and distinguish unknown from a legitimate zero', async t => {
  const h = await mount(t);
  const known = h.host.querySelector('[data-order-id="synthetic-preview-order-1"]');
  assert.match(h.host.querySelector('thead').textContent, /本单应付/); assert.match(known.textContent, /160\.00 元/);
  assert.match(known.textContent, /资源 60\.00 元 · 押金 100\.00 元/); assert.match(known.textContent, /租入/);
  assert.equal(/实付|到账|号主收益/.test(known.textContent), false);
  await click(namedButton('SYNTHETIC-ORDER-1', known));
  assert.equal(h.opened.at(-1).target, '/orders/synthetic-preview-order-1');
  const unknown = h.host.querySelector('[data-order-id="synthetic-preview-order-2"]');
  assert.match(unknown.textContent, /待核/); assert.match(unknown.textContent, /旧平台订单/);
  assert.equal(/0\.00|实付|到账/.test(unknown.textContent), false); assert.match(unknown.textContent, /资源 待核 · 押金 待核/);
});

test('inline native title is frozen, legacy title is current account data and missing resource fields are not invented', async t => {
  const h = await mount(t);
  const cell = h.host.querySelector('[data-order-id="synthetic-preview-order-1"]').children[1];
  assert.match(cell.textContent, /本单冻结账号快照/); assert.equal(cell.textContent.includes('当前账号资料'), false);
  assert.equal(/已上架|可租|报价|号主暂停|平台限制|皮肤|哈夫币|租期：|登录：/.test(cell.textContent), false);
  assert.equal(cell.querySelector('img'), null, 'order rows never supply a skin or current listing image');
  assert.match(h.host.querySelector('[data-order-id="synthetic-preview-order-2"]').children[1].textContent, /当前账号资料/);
  await click(namedButton('账号 SYNTHETIC-ACCOUNT-1', h.host));
  assert.equal(h.opened.at(-1).target, '/supply/accounts/synthetic-preview-account-1');
  assert.equal(h.calls.length, 2);
});

test('formal order facts keep original resource units and distinguish historical account rules from an order term',async t=>{
  const original={...unknownOrder,accountDisplayNo:null,orderFacts:{termSeconds:null,resources:[{code:'df_billable_haff',quantity:'12.50',unit:null},{code:'df_billable_coffee',quantity:'0',unit:null}]},accountFacts:{source:'LEGACY_ACCOUNT',resources:[{code:'haff_base',name:'哈夫币',quantity:'97000000',unit:'HAFF_BASE'}],loginMethodText:'微信扫码',termDays:'10'}};
  const native={...knownOrder,orderFacts:{termSeconds:'86401',resources:[]},accountFacts:{source:'ORDER_VERSION',resources:[{code:'haff_base',name:'哈夫币',quantity:'50000000',unit:'HAFF_BASE'}],loginMethodText:'QQ扫码'}};
  const h=await mount(t,{rows:[original,native]}),old=h.host.querySelector('[data-order-id="synthetic-preview-order-2"]').children[1],current=h.host.querySelector('[data-order-id="synthetic-preview-order-1"]').children[1];
  assert.match(old.textContent,/原单资源：哈夫币 12\.50/);assert.doesNotMatch(old.textContent,/97 M|12\.50 M|咖啡豆 0/,'current inventory never replaces frozen order quantities or invents a unit');
  assert.match(old.textContent,/历史账号租期规则：10天/);assert.match(old.textContent,/历史账号登录：微信扫码/);
  assert.match(current.textContent,/下单账号资料：50 M 哈夫币/);assert.match(current.textContent,/租期：86401秒/,'fractional hours are never rounded into a false duration');assert.match(current.textContent,/登录：QQ扫码/);
  assert.equal(h.calls.length,2);
});

test('resource names respect legacy originals and native frozen names with dynamic backpack units', async t => {
  const legacy = { ...unknownOrder, orderFacts: { termSeconds: null, resources: [{ code: 'df_billable_top_insure_card', quantity: '7', unit: 'DAY' }] } };
  const native = { ...knownOrder, source: { origin: 'NATIVE' }, accountFacts: { source: 'ORDER_VERSION', loginMethodText: 'QQ扫码', resources: [
    { code: 'df_billable_top_insure_card', name: '九格保险体验卡', quantity: '7', unit: 'DAY' },
    { code: 'df_billable_turtle_backpack_45', name: '45格乌龟包', quantity: '2', unit: 'PIECE' },
  ] } };
  const h = await mount(t, { rows: [legacy, native] });
  const old = h.host.querySelector('[data-order-id="synthetic-preview-order-2"]').children[1].textContent;
  const current = h.host.querySelector('[data-order-id="synthetic-preview-order-1"]').children[1].textContent;
  assert.match(old, /顶级保险卡 7 天/); assert.doesNotMatch(old, /九格保险体验卡/);
  assert.match(current, /九格保险体验卡 7 天/); assert.match(current, /45格乌龟包 2 个/); assert.doesNotMatch(current, /顶级保险卡/);
  assert.equal(h.calls.length, 2);
});

test('native resource without a frozen name never inherits the legacy insurance label', async t => {
  const native = { ...knownOrder, source: { origin: 'NATIVE' }, accountFacts: { source: 'ORDER_VERSION', resources: [
    { code: 'df_billable_top_insure_card', quantity: '7', unit: 'DAY' },
  ] } };
  const h = await mount(t, { rows: [native] }), text = h.host.querySelector('[data-order-id="synthetic-preview-order-1"]').children[1].textContent;
  assert.match(text, /物资名称未提供 7 天/); assert.doesNotMatch(text, /顶级保险卡|九格保险体验卡/);
});

test('same-name user preview consumes authorized membership, known zero credit and risk without another GET',async t=>{
  const summary={name:'下单时昵称',image:null,maskedPhone:null,riskFlag:true,membershipSummary:{state:'ready',growth:{knowledge:'UNKNOWN',effectiveTier:null}},creditSummary:{state:'ready',knowledge:'KNOWN',score:0,revision:'1'}};
  const h=await mount(t,{rows:[{...knownOrder,counterpartySummary:summary}]}),before=structuredClone(h.calls);
  const p=await openPreview('预览用户 下单时昵称','用户预览：下单时昵称');
  assert.match(p.card.textContent,/等级待核/);assert.match(p.card.textContent,/信用分：0/);assert.match(p.card.textContent,/高危/);assert.doesNotMatch(p.card.textContent,/安全|最后登录/);
  assert.deepEqual(h.calls,before);await p.close();
});

test('native and legacy orders sharing an id remain distinct rows with their own source and amount',async t=>{
  const h=await mount(t,{rows:[knownOrder,{...unknownOrder,orderId:knownOrder.orderId}]}),rows=[...h.host.querySelectorAll('[data-order-id]')];
  assert.equal(rows.length,2);assert.equal(rows[0].dataset.orderOrigin,'NATIVE');assert.equal(rows[1].dataset.orderOrigin,'LEGACY');
  assert.match(rows[0].textContent,/160\.00 元/);assert.match(rows[1].textContent,/旧平台订单/);assert.doesNotMatch(rows[1].textContent,/160\.00/);
});

test('legitimate zero due and deposit amounts remain zero rather than unknown', async t => {
  const zero = { ...knownOrder, amounts: { rental: money('0.00'), deposit: money('0.00'), totalDue: money('0.00') } };
  const h = await mount(t, { rows: [zero] }), cell = h.host.querySelector('tbody tr').lastElementChild;
  assert.match(cell.textContent, /0\.00 元/); assert.match(cell.textContent, /资源 0\.00 元 · 押金 0\.00 元/); assert.equal(cell.textContent.includes('待核'), false);
});

test('counterparty preview distinguishes current nickname and links to the same user/order as the original name', async t => {
  const h = await mount(t), baseline = structuredClone(h.calls);
  const p = await openPreview('预览用户 下单时昵称', '用户预览：下单时昵称');
  assert.match(p.card.textContent, /当前昵称：现在的昵称/);
  assert.match(p.card.textContent, /188\*\*\*\*1101/);
  assert.equal(p.card.textContent.includes('号主'), false, 'the shared user card is neutral');
  assert.equal(p.card.textContent.includes(knownOrder.counterpartyUserId), false);
  assert.ok(namedButton('复制用户 ID', p.card));
  await click(namedButton('查看用户资料', p.card));
  const expected = '/users/synthetic-preview-owner-1?fromOrderId=synthetic-preview-order-1';
  assert.equal(h.opened.at(-1).target, expected);
  await p.close(); await click(namedButton('下单时昵称', h.host));
  assert.equal(h.opened.at(-1).target, expected);
  assert.deepEqual(h.calls, baseline);
});

test('old DTOs keep ordinary names; missing stable IDs never create empty previews or guessed routes', async t => {
  const old = { ...knownOrder, counterpartySummary: undefined };
  const noIds = { ...unknownOrder, counterpartySummary: { name: '无稳定ID的昵称', image: null, maskedPhone: '188****1102' } };
  const h = await mount(t, { rows: [old, noIds] });
  assert.equal(namedButton('预览用户 下单时昵称'), undefined, 'older server without summary does not show an empty preview');
  const legacy = h.host.querySelector('[data-order-id="synthetic-preview-order-2"]');
  assert.match(legacy.textContent, /旧来源号 12345678/);
  assert.match(legacy.textContent, /旧单对方昵称/);
  assert.equal(legacy.querySelector('[aria-label^="预览账号"]'), null);
  assert.equal(legacy.querySelector('[aria-label^="预览用户"]'), null);
  assert.equal(namedButton('12345678', legacy), undefined);
  assert.equal(namedButton('旧单对方昵称', legacy), undefined);
  await click(namedButton('下单时昵称', h.host));
  assert.equal(h.opened.at(-1).target, '/users/synthetic-preview-owner-1?fromOrderId=synthetic-preview-order-1');
  assert.equal(h.calls.length, 2, 'missing summary must not trigger a directory reverse lookup');
});

test('without account read permission the inline title remains readable but the account link does not open', async t => {
  const h = await mount(t, { permissions: ['user.directory.read', 'order.read'] });
  const link = namedButton('账号 SYNTHETIC-ACCOUNT-1', h.host);
  assert.equal(link.getAttribute('aria-disabled'), 'true'); await click(link); assert.equal(h.opened.length, 0);
  assert.match(h.host.querySelector('tbody tr').children[1].textContent, /本单冻结账号快照/);
  assert.equal(h.host.querySelector('[aria-label^="预览账号"]'), null);
  assert.equal(h.opened.length, 0); assert.equal(h.calls.length, 2);
});

test('missing order read permission avoids the orders GET and every order preview', async t => {
  const h = await mount(t, { permissions: ['user.directory.read'] });
  assert.equal(h.calls.length, 1); assert.equal(h.calls.some(call => call.path.endsWith('/orders')), false);
  assert.equal(h.host.querySelector('[aria-label^="预览订单"]'), null);
  assert.equal(h.host.querySelector('[data-order-id]'), null);
});

test('workspace original links and card actions preserve the same user filters and supply origin', async t => {
  const h = await mount(t, { workspace: true, permissions: [...permissions, 'supply.review.read'], query: {
    role: 'renter', status: 'PAID', fromSupplyId: 'synthetic-source-supply', fromSupplyContext: 'archive', fromSupplyVersionId: 'synthetic-source-version',
  } });
  assert.equal(h.calls.find(call => call.path.endsWith('/orders')).params.role, 'renter');
  assert.equal(h.calls.find(call => call.path.endsWith('/orders')).params.status, 'PAID');
  for (const entry of [
    { original: 'SYNTHETIC-ORDER-1', pathname: '/orders/synthetic-preview-order-1', userOrigin: true },
    { original: '账号 SYNTHETIC-ACCOUNT-1', pathname: '/supply/reviews/synthetic-preview-account-1', userOrigin: true },
    { label: '预览用户 下单时昵称', region: '用户预览：下单时昵称', footer: '查看用户资料', original: '下单时昵称', pathname: '/users/synthetic-preview-owner-1' },
  ]) {
    const before = h.opened.length;
    let viaCard;
    if (entry.label) { const p = await openPreview(entry.label, entry.region); assert.equal(h.opened.length, before); await click(namedButton(entry.footer, p.card)); viaCard = h.opened.at(-1); await p.close(); }
    await click(namedButton(entry.original, h.host));
    if (viaCard) assert.deepEqual(h.opened.at(-1), viaCard, 'card action keeps the original link callback and title');
    const target = new URL(h.opened.at(-1).target, browser.location.href);
    assert.equal(target.pathname, entry.pathname);
    assert.equal(target.searchParams.get('fromSupplyId'), 'synthetic-source-supply');
    assert.equal(target.searchParams.get('fromSupplyContext'), 'archive');
    assert.equal(target.searchParams.get('fromSupplyVersionId'), 'synthetic-source-version');
    if (entry.userOrigin) {
      assert.equal(target.searchParams.get('fromUserId'), subject);
      assert.equal(target.searchParams.get('fromUserSection'), 'orders');
    } else assert.equal(target.searchParams.get('fromOrderId'), knownOrder.orderId);
    if (target.pathname.startsWith('/orders/')) {
      assert.equal(target.searchParams.get('fromUserRole'), 'renter');
      assert.equal(target.searchParams.get('fromUserStatus'), 'PAID');
    }
  }
  assert.equal(h.calls.length, 2);
});

test('explicit counterpart origin B wins over inherited order A while unspecified drilldowns retain A', async t => {
  const originOrder = 'synthetic-source-order-A';
  const h = await mount(t, { workspace: true, query: { fromOrderId: originOrder } });
  const baseline = structuredClone(h.calls);
  await click(namedButton('返回来源订单', h.host));
  assert.equal(h.opened.at(-1).target, '/orders/' + originOrder);

  await click(namedButton('下单时昵称', h.host));
  const original = h.opened.at(-1);
  const viaName = new URL(original.target, browser.location.href);
  assert.equal(viaName.pathname, '/users/' + knownOrder.counterpartyUserId);
  assert.equal(viaName.searchParams.get('fromOrderId'), knownOrder.orderId,
    'the explicitly selected order B must not be replaced with source order A');
  const p = await openPreview('预览用户 下单时昵称', '用户预览：下单时昵称');
  await click(namedButton('查看用户资料', p.card));
  assert.deepEqual(h.opened.at(-1), original, 'counterparty name and preview footer use the same explicit B origin');
  await p.close();

  for (const [name, pathname] of [
    ['SYNTHETIC-ORDER-1', '/orders/' + knownOrder.orderId],
    ['账号 SYNTHETIC-ACCOUNT-1', '/supply/reviews/' + knownOrder.accountId],
  ]) {
    await click(namedButton(name, h.host));
    const target = new URL(h.opened.at(-1).target, browser.location.href);
    assert.equal(target.pathname, pathname);
    assert.equal(target.searchParams.get('fromOrderId'), originOrder,
      'a target without its own explicit order origin still inherits A');
    assert.equal(target.searchParams.get('fromUserId'), subject);
    assert.equal(target.searchParams.get('fromUserSection'), 'orders');
  }
  assert.deepEqual(h.calls, baseline, 'origin changes only navigation, never trigger preview reads');
});
