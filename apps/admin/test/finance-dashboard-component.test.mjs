import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const snapshot = { authenticated: true, adminUserId: 'admin', user: { name: '运营', username: 'OPS', twoFactorEnabled: true }, security: { status: 'ACTIVE', isBoss: false, passwordChangeRequired: false }, session: { id: 'session', locked: false, pinConfigured: true, createdAt: null, expiresAt: null }, permissions: ['finance.read', 'order.read', 'user.directory.read'] };
const reply = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
async function until(condition) { for (let i=0; i<100; i++) { if (condition()) return; await settle(); } throw new Error('dashboard render timed out'); }
let vite;
after(async () => { await vite?.close(); });
async function setup(t, permissions = snapshot.permissions) {
  const browser = new Window({ url: 'http://127.0.0.1:4231/finance' });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, CSS: browser.CSS, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.getComputedStyle=browser.getComputedStyle.bind(browser); globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser); globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);
  Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
  const { createRoot } = await import('react-dom/client');
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  vite ??= await createServer({ configFile: false, root: tree, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, cacheDir: path.resolve(tree, 'tmp/admin-test-cache/funds-dashboard'), plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const { FinanceDashboardView } = await vite.ssrLoadModule('/apps/admin/src/views/finance-dashboard.tsx');
  const node = browser.document.createElement('div'); browser.document.body.append(node); const root = createRoot(node), opened = [], queries = [];
  const props = { tab: { id: 'finance-overview', path: '/finance', kind: 'finance-overview', title: '资金与经营看板', query: {}, closable: true }, snapshot: { ...snapshot, permissions }, refreshNonce: 0, onOpenPath: (...args) => opened.push(args), onQueryChange: query => queries.push(query) };
  const render = () => act(async () => root.render(createElement(FinanceDashboardView, props)));
  t.after(async () => { await act(async () => root.unmount()); browser.happyDOM.abort(); });
  return { node, props, render, opened, queries, browser };
}
function fixture(url) {
  if (url.includes('/dashboard/trend')) return { version:'admin.finance-dashboard-trend.v1', period:{from:'2026-11-01',to:'2026-11-03',asOf:'2026-11-03T08:00:00.000000Z',granularity:'day'},legacy:'RECORDED_PARTIAL',estimateState:'RECORDED_PARTIAL',openingReferenceAt:'2026-11-03T07:47:05Z',insights:{cancelled:'1',completed:'2',active:'0',unknown:'0',repeatRenters:'1',nativeOrders:'0',legacyOrders:'3',frequency:[{orders:1,users:'1'},{orders:2,users:'1'}]},points:[{date:'2026-11-01',orders:'2',knownAmounts:'2',cents:'30000',legacyOrders:'2',estimateOrders:'2',estimateKnown:'2',estimateCents:'400',estimateDiscrepancies:'1',settlements:'1',knownContributions:'1',contributionCents:'1200'},{date:'2026-11-03',orders:'1',knownAmounts:'0',cents:'0',legacyOrders:'1',estimateOrders:'0',estimateKnown:'0',estimateCents:null,settlements:null,knownContributions:null,contributionCents:null}] };
  if (url.includes('/dashboard/customers')) return {version:'admin.finance-dashboard-customers.v1',period:{from:'2026-11-01',to:'2026-11-03',asOf:'2026-11-03T08:00:00.000000Z',granularity:'day'},basis:'settled',legacy:'RECORDED_PARTIAL',continuations:'INCLUDED',omittedCount:'1',items:[{userId:'u1',name:'客户甲',orderCount:'2',paidCents:'30000',contributionCents:'1200',latestAt:'2026-11-01T08:00:00Z',omittedCount:'1',legacyOrderCount:'2',compensationRecordCount:'0',historicalCompensationCents:null}]};
  if (url.includes('/dashboard/contributions')) return {version:'admin.finance-dashboard-contributions.v1',asOf:'2026-11-03T08:00:00.000000Z',basis:'settled',page:1,pageSize:20,total:'1',knownCount:'1',knownCents:'1200',items:[{orderId:'o1',number:'ORDER-1',source:'LEGACY',at:'2026-11-02T08:00:00Z',paidCents:'10000',ownerCents:'6000',refundCents:'2800',contributionCents:'1200'}]};
  if (url.includes('/dashboard/merchant')) return {version:'admin.finance-dashboard-merchant.v1',state:'NOT_CONFIGURED',accounts:[]};
  if (url.includes('/dashboard/channels')) return {version:'admin.finance-dashboard-channels.v1',state:'NOT_CONFIGURED',items:[]};
  if (url.includes('/finance/overview')) return {version:'admin.finance-overview.v1',asOf:'2026-11-03T08:00:00Z',ledgerBalances:[{bucket:'AVAILABLE',balanceCents:'500',state:'KNOWN'},{bucket:'PLATFORM',balanceCents:'100',state:'KNOWN'},{bucket:'REFUND_PAYABLE',balanceCents:'0',state:'KNOWN'},{bucket:'RESERVED',balanceCents:'0',state:'KNOWN'}]};
  throw new Error('unexpected request');
}

test('dashboard separates unknown channel facts from known business records and switches ranking basis', async t => {
  const calls=[]; globalThis.fetch=async url=>{calls.push(String(url));const value=fixture(String(url));if(String(url).includes('/dashboard/trend')||String(url).includes('/dashboard/customers'))value.continuations='RECORDED_PARTIAL';return reply(value);};
  const ui=await setup(t); await ui.render(); await until(()=>ui.node.textContent.includes('客户甲'));
  assert.match(ui.node.textContent,/资金与经营看板/); assert.match(ui.node.textContent,/汇聚未接入/);
  assert.match(ui.node.textContent,/300\.00 元/); assert.match(ui.node.textContent,/12\.00 元/);
  assert.match(ui.node.textContent,/1 笔金额依据缺失/); assert.match(ui.node.textContent,/平台自有权益待核实/);
  assert.match(ui.node.textContent,/已付订单状态/);assert.match(ui.node.textContent,/已取消1 笔/);assert.match(ui.node.textContent,/1 单：1 人/);assert.match(ui.node.textContent,/2 单：1 人/);
  assert.match(ui.node.textContent,/历史数据覆盖待核/);
  assert.ok(ui.node.querySelector('button[aria-label="历史数据覆盖待核说明"]'));
  assert.match(ui.node.textContent,/付款订单预计基础价差4\.00 元/);
  assert.match(ui.node.textContent,/1 笔已完成订单的记录价差与结算公式不一致/);
  assert.doesNotMatch(ui.node.textContent,/银行已到账|净利润12/);
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='付款时间').click());
  await until(()=>calls.some(url=>url.includes('/dashboard/customers')&&url.includes('basis=paid')));
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='Top 50').click());
  await until(()=>calls.some(url=>url.includes('/dashboard/customers')&&url.includes('limit=50')));
  assert.equal(ui.node.querySelector('select'),null,'来源使用统一 Select 组件');
  assert.equal(ui.node.querySelector('details'),null,'展开使用统一 Collapsible 组件');
  await act(async()=>ui.node.querySelector('button[aria-label="查看本期付款订单"]').click());
  let opened=new URL(ui.opened.at(-1)[0],'http://local');
  assert.equal(opened.pathname,'/orders');assert.equal(opened.searchParams.get('paidFrom'),'2026-11-01T00:00:00+08:00');assert.equal(opened.searchParams.get('paidTo'),'2026-11-03T08:00:00.000001Z');
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='已取消').click());
  opened=new URL(ui.opened.at(-1)[0],'http://local');assert.equal(opened.searchParams.get('status'),'CANCELLED');
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='付款订单预计').click());
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='查看计算说明').click());
  await until(()=>ui.browser.document.body.textContent.includes('结算毛贡献 = 订单实付基数'));
  assert.match(ui.browser.document.body.textContent,/未扣分销、未加预计包赔/);
  assert.match(ui.browser.document.body.textContent,/实付 1,000 元、租客应退 200 元、号主收益 600 元/);
  assert.match(ui.browser.document.body.textContent,/客服取消订单时的资金分配不计入此项/);
  await act(async()=>[...ui.browser.document.querySelectorAll('button')].find(button=>button.textContent.includes('关闭说明')).click());
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent.includes('查看排行明细')).click());
  await until(()=>ui.node.textContent.includes('每单平均贡献'));
  assert.match(ui.node.textContent,/6\.00 元/);
});

test('funds explanation gives a concrete reservation example without hiding unknown balances', async t => {
  globalThis.fetch=async url=>reply(fixture(String(url)));
  const ui=await setup(t);await ui.render();await until(()=>ui.node.textContent.includes('客户甲'));
  assert.match(ui.node.textContent,/平台自有权益待核实/);
  assert.ok(ui.node.querySelector('button[aria-label="退款责任净额 · 账内说明"]'));
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='了解资金关系').click());
  await until(()=>ui.browser.document.body.textContent.includes('申请提现 100 元'));
  assert.match(ui.browser.document.body.textContent,/可用余额为 500 元，提现预留为 100 元/);
  assert.match(ui.browser.document.body.textContent,/不能说明旧业务已经结清/);
});

test('dashboard serializes reads against the shared pool and ranking controls do not reload the trend', async t => {
  let active=0,maxActive=0;const calls=[];
  globalThis.fetch=async url=>{calls.push(String(url));active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return reply(fixture(String(url)));};
  const ui=await setup(t);await ui.render();await until(()=>ui.node.textContent.includes('客户甲'));
  assert.equal(maxActive,1);
  const trends=calls.filter(url=>url.includes('/dashboard/trend')).length;
  await act(async()=>[...ui.node.querySelectorAll('button')].find(button=>button.textContent==='付款时间').click());
  await until(()=>calls.some(url=>url.includes('/dashboard/customers')&&url.includes('basis=paid')));
  assert.equal(calls.filter(url=>url.includes('/dashboard/trend')).length,trends);
});

test('settlement contribution opens scoped evidence and then the original order',async t=>{
 const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return reply(fixture(String(url)));};
 const ui=await setup(t);await ui.render();await until(()=>ui.node.textContent.includes('客户甲'));
 await act(async()=>ui.node.querySelector('button[aria-label="查看本期结算贡献明细"]').click());
 await until(()=>ui.browser.document.body.textContent.includes('ORDER-1'));
 const request=new URL(calls.find(url=>url.includes('/dashboard/contributions')),'http://local');
 assert.equal(request.searchParams.get('basis'),'settled');assert.equal(request.searchParams.get('from'),'2026-11-01');
 await act(async()=>[...ui.browser.document.querySelectorAll('button')].find(button=>button.textContent.includes('ORDER-1')).click());
 assert.equal(ui.opened.at(-1)[0],'/orders/o1?section=finance');
});

test('custom date range retains the first day and applies the second selection', async t => {
  globalThis.fetch=async url=>reply(fixture(String(url)));
  const ui=await setup(t);await ui.render();await until(()=>ui.node.textContent.includes('客户甲'));
  await act(async()=>ui.node.querySelector('button[aria-label="选择自定义日期"]').click());
  await until(()=>ui.browser.document.querySelectorAll('button[data-day]').length>2);
  const days=[...ui.browser.document.querySelectorAll('button[data-day]:not([disabled])')].slice(0,2);
  await act(async()=>days[0].click());assert.equal(ui.queries.length,0);
  await act(async()=>days[1].click());await until(()=>ui.queries.length===1);
  assert.equal(ui.queries[0].range,'custom');assert.match(ui.queries[0].from,/^\d{4}-\d{2}-\d{2}$/);assert.ok(ui.queries[0].to>=ui.queries[0].from);
});

test('dashboard does not request or reveal ranking without directory permission', async t => {
  const calls=[]; globalThis.fetch=async url=>{calls.push(String(url));return reply(fixture(String(url)));};
  const ui=await setup(t,['finance.read','order.read']);await ui.render();
  await until(()=>ui.node.textContent.includes('查看客户排行需要订单和用户管理权限'));
  assert.ok(!calls.some(url=>url.includes('/dashboard/customers')));
  assert.doesNotMatch(ui.node.textContent,/客户甲/);
});
