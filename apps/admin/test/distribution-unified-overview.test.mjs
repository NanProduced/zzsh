import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { setup, snap, json, settle, click } from './distribution-ops-fixture.mjs';
import { overviewFixture } from './distribution-unified-overview-fixture.mjs';

function sectionFixture(value,url){
  const section=new URL(String(url),'http://fixture.invalid').searchParams.get('section');
  if(section==='CORE')return{...value,section};
  if(section==='EARNINGS_RANKING')return{section,asOf:value.asOf,ranking:{items:value.rankings.earnings,knowledge:'KNOWN',reasonCodes:[]}};
  if(section==='INVITE_RANKING')return{section,asOf:value.asOf,ranking:value.rankings.directInvites};
  throw Error('unexpected overview section');
}

async function probe(t, value = overviewFixture(), permissions = ['distribution.dashboard.read','user.directory.read']) {
  const h = await setup(), oldFetch = globalThis.fetch, calls = [], paths = [];
  Object.assign(globalThis, { ResizeObserver: h.browser.ResizeObserver, SVGElement: h.browser.SVGElement });
  h.browser.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 224, width: 640, height: 224 });
  globalThis.fetch = h.browser.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return json(sectionFixture(value,url)); };
  const m = await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx');
  let props = { snapshot: snap(permissions), query: { from:'2026-11-01',to:'2026-11-03' }, onOpenPath: (...args) => paths.push(args), onQueryChange: next => { props = { ...props, query: next }; } };
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
  assert.match(h.host.textContent,/4 个/); assert.equal(h.calls.length,3);
  const rankings = h.host.querySelector('[data-distribution-rankings]');
  assert.ok(rankings);
  const rankingNames = [...rankings.querySelectorAll('button')].filter(b => b.textContent.trim() === '可读受益人');
  assert.equal(rankingNames.length, 2);
  for (const name of rankingNames) {
    assert.equal(name.disabled, false);
  }
  assert.equal([...rankings.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === '预览用户 可读受益人').length, 2);
  await click(h.button('发生额')); assert.match(h.host.textContent,/按佣金原始发生时间统计/); assert.equal(h.calls.length,3);
  assert.ok(h.calls.every(c=>(c.options.method??'GET')==='GET'));
});

test('period changes reread with new dates while the current state and recent scope stay unchanged',async t=>{
  const h=await probe(t); await h.render({query:{from:'2024-01-01',to:'2024-01-31'}});
  assert.equal(h.calls.length,5); assert.equal(h.calls.filter(call=>/from=2024-01-01/.test(call.url)).length,2);
  assert.match(h.host.textContent,/佣金记录已结算¥44,416.95/); assert.match(h.host.textContent,/DIST-1/);
  await click(h.button('查看全部')); assert.deepEqual(h.paths,[['/distribution/earnings','佣金明细']]);
});

test('unknown source and restricted relations do not become zero or a clickable directory result',async t=>{
  const value=overviewFixture(),unknown={knowledge:'UNKNOWN',cents:null,count:null,reasonCodes:['LEGACY_SOURCE_NOT_INSTALLED']};
  value.current={settled:unknown,pending:unknown,recovery:unknown,needsReview:unknown}; value.scope.network='UNAVAILABLE';
  value.participants.eligible=unknown;value.rankings.earnings=[];value.rankings.directInvites={knowledge:'UNKNOWN',items:[],reasonCodes:['GLOBAL_RELATION_SCOPE_UNAVAILABLE']};value.trend=[];
  const h=await probe(t,value,['distribution.dashboard.read']);
  assert.match(h.host.textContent,/佣金记录已结算未核定/);assert.doesNotMatch(h.host.textContent,/佣金记录已结算¥0.00/);
  assert.match(h.host.textContent,/当前游戏范围无法读取全平台关系网络/);
  assert.equal([...h.host.querySelectorAll('button')].find(b=>b.textContent==='可读受益人')?.disabled,true);
});

test('overview sections load independently and do not retain another identity\'s data',async t=>{
  const h=await setup(),oldFetch=globalThis.fetch,value=overviewFixture();let releaseCore,releaseOther,second=false;
  t.after(async()=>{globalThis.fetch=oldFetch;await h.close();});
  globalThis.fetch=h.browser.fetch=async url=>{
    const section=new URL(String(url),'http://fixture.invalid').searchParams.get('section');
    if(second)return new Promise(resolve=>{releaseOther=()=>resolve(json(sectionFixture(value,url)));});
    if(section==='CORE')return new Promise(resolve=>{releaseCore=()=>resolve(json(sectionFixture(value,url)));});
    return json(sectionFixture(value,url));
  };
  const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx');
  const props={snapshot:snap(['distribution.dashboard.read','user.directory.read'],'first','session-a'),query:{from:'2026-11-01',to:'2026-11-03'},onOpenPath(){}};
  const ui=await h.mount(m.DistributionOverviewPage,props);await settle();
  assert.ok(ui.host.querySelector('[aria-label="正在读取佣金概览"]'));assert.match(ui.host.textContent,/可读受益人/);
  await act(async()=>releaseCore());await settle();assert.match(ui.host.textContent,/佣金记录已结算/);
  second=true;await act(async()=>ui.root.render(createElement(m.DistributionOverviewPage,{...props,snapshot:snap(['distribution.dashboard.read','user.directory.read'],'second','session-b')})));
  assert.doesNotMatch(ui.host.textContent,/可读受益人|44,416\.95/);assert.ok(ui.host.querySelector('[aria-label="正在读取佣金概览"]'));
});

test('expand top 100 only skeletons rankings and keeps current metrics visible', async t => {
  const h = await setup(), oldFetch = globalThis.fetch, calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  Object.assign(globalThis, { ResizeObserver: h.browser.ResizeObserver, SVGElement: h.browser.SVGElement });
  h.browser.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 224, width: 640, height: 224 });
  const value = overviewFixture();
  globalThis.fetch = h.browser.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('rankingLimit=100')) {
      await gate;
      const expanded = overviewFixture();
      expanded.applied = { ...expanded.applied, rankingLimit: 100 };
      expanded.rankings.earnings = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, name: `排行${i}`, roles: ['INVITER'], cents: String(1000 - i), count: '1' }));
      return json(sectionFixture(expanded,url));
    }
    return json(sectionFixture(value,url));
  };
  const m = await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx');
  let props = {
    snapshot: snap(['distribution.dashboard.read','user.directory.read']),
    query: { from: '2026-11-01', to: '2026-11-03' },
    onOpenPath: () => {},
    onQueryChange: next => { props = { ...props, query: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) }; },
  };
  const ui = await h.mount(m.DistributionOverviewPage, props); await settle();
  t.after(async () => { globalThis.fetch = oldFetch; await h.close(); });
  assert.match(ui.host.textContent, /佣金记录已结算¥44,416.95/);
  assert.equal(ui.host.querySelector('[aria-label="正在更新排行"]'), null);
  const expand = [...ui.host.querySelectorAll('button')].find(b => b.textContent.trim() === '展开前 100');
  assert.ok(expand);
  await click(expand);
  await act(async () => { ui.root.render(createElement(m.DistributionOverviewPage, props)); });
  await settle();
  assert.match(ui.host.textContent, /佣金记录已结算¥44,416.95/);
  assert.ok(ui.host.querySelector('[aria-label="正在更新排行"]'), 'ranking region should skeleton while loading');
  assert.doesNotMatch(ui.host.textContent, /正在读取分销概览/);
  assert.ok(calls.some(url => url.includes('rankingLimit=100')));
  release();
  await settle();
  assert.equal(ui.host.querySelector('[aria-label="正在更新排行"]'), null);
  assert.match(ui.host.textContent, /排行0/);
});
