import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { setup, snap, json, settle, click } from './distribution-ops-fixture.mjs';

// Synthetic response/UI fixture only; no service, authentication, PostgreSQL or provider acceptance.
import { overviewFixture } from './distribution-unified-overview-fixture.mjs';

async function probe(t, value = overviewFixture(), permissions = ['distribution.dashboard.read','user.directory.read']) {
  const h = await setup(), oldFetch = globalThis.fetch, calls = [], paths = [];
  Object.assign(globalThis, { ResizeObserver: h.browser.ResizeObserver, SVGElement: h.browser.SVGElement });
  h.browser.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 224, width: 640, height: 224 });
  globalThis.fetch = h.browser.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return json(value); };
  const m = await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx');
  let props = { snapshot: snap(permissions), query: { from:'2026-11-01',to:'2026-11-03' }, onOpenPath: (...args) => paths.push(args) };
  const ui = await h.mount(m.DistributionOverviewPage, props); await settle();
  t.after(async () => { globalThis.fetch = oldFetch; await h.close(); });
  return { ...h, ...ui, calls, paths, button: text => [...ui.host.querySelectorAll('button')].find(b => b.textContent.trim() === text),
    render: async patch => { props = { ...props, ...patch }; await act(async () => ui.root.render(createElement(m.DistributionOverviewPage,props))); await settle(); } };
}

test('one business overview keeps four current metrics, three period metrics and one precise recent table', async t => {
  const h = await probe(t), text = h.host.textContent;
  assert.doesNotMatch(text,/当前原生|历史观察（只读）|历史佣金观察|数据占位|样式示意|示例用户/);
  assert.match(text,/佣金记录已结算¥44,416.95/); assert.match(text,/责任待核对 3 条/); assert.match(text,/有 2 条已结算记录未确认入账时刻/);
  assert.equal(h.host.querySelector('time').dateTime,'2026-11-03T03:42:00Z'); assert.match(text,/11:42/);
  assert.equal(h.host.querySelectorAll('table').length,1); assert.match(text,/¥90,071,992,547,409.93/);
  assert.equal(h.host.querySelectorAll('dl')[0].children.length,4); assert.equal(h.host.querySelectorAll('dl')[1].children.length,3);
  await click(h.button('计佣关系')); assert.match(h.host.textContent,/4 个/); assert.equal(h.calls.length,1);
  await click(h.button('发生额')); assert.match(h.host.textContent,/按佣金原始发生时间统计/); assert.equal(h.calls.length,1);
  assert.ok(h.calls.every(c=>(c.options.method??'GET')==='GET'));
});

test('period changes reread with new dates while the current state and recent scope stay unchanged',async t=>{
  const h=await probe(t); await h.render({query:{from:'2024-01-01',to:'2024-01-31'}});
  assert.equal(h.calls.length,2); assert.match(h.calls[1].url,/from=2024-01-01/);
  assert.match(h.host.textContent,/佣金记录已结算¥44,416.95/); assert.match(h.host.textContent,/DIST-1/);
  await click(h.button('查看全部')); assert.deepEqual(h.paths,[['/distribution/earnings','佣金明细']]);
});

test('unknown source and restricted relations do not become zero or a clickable directory result',async t=>{
  const value=overviewFixture(),unknown={knowledge:'UNKNOWN',cents:null,count:null,reasonCodes:['LEGACY_SOURCE_NOT_INSTALLED']};
  value.current={settled:unknown,pending:unknown,recovery:unknown,needsReview:unknown}; value.scope.network='UNAVAILABLE';
  value.participants.eligible=unknown;value.rankings.earnings=[];value.rankings.directInvites={knowledge:'UNKNOWN',items:[],reasonCodes:['GLOBAL_RELATION_SCOPE_UNAVAILABLE']};value.trend=[];
  const h=await probe(t,value,['distribution.dashboard.read']);
  assert.match(h.host.textContent,/佣金记录已结算未核定/);assert.doesNotMatch(h.host.textContent,/佣金记录已结算¥0.00/);
  await click(h.button('计佣关系'));assert.match(h.host.textContent,/当前游戏范围无法读取全平台关系网络/);
  assert.equal([...h.host.querySelectorAll('button')].find(b=>b.textContent==='可读受益人')?.disabled,true);
});
