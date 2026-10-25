import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountA, detail, mountHarness } from './supply-review-fixture.mjs';

const permissions = ['supply.review.read', 'supply.restrict', 'order.read'];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const facts = { publicVisible: false, publicSource: null, newOrders: false, reasons: ['STAFF_RESTRICTED', 'PUBLISHER_BAIL_UNCONFIRMED'], primaryReasonCode: 'STAFF_RESTRICTED', ownerPaused: false, staffRestricted: true, occupancy: 'FREE', sources: [], legacyNumbers: [] };
const row = { id: 'a', accountId: 'a', displayNo: 'TEST-A', ownerId: 'owner-a', ownerName: 'fixture owner', revision: '7', gameName: 'g', versionId: 'v-a', sequence: '1', title: 'fixture account', reviewState: 'PUBLISHED', sortAt: '2026-10-03T00:00:00.000000Z', facts };
const page = { contractVersion: 'admin-supervision.read.v1', contextKey: 'ctx', items: [row], nextCursor: null, stationOrigins: { admin: 'http://127.0.0.1:4291', user: 'http://127.0.0.1:4290' }, games: [] };
function workDetail() {
  const d = detail({ ...accountA, display_no: 'TEST-A', owner_user_id: 'owner-a', staff_restricted: true }, 'PUBLISHED');
  d.supervision = { historical: false, facts, changes: null, previousVersion: null, restrictionHistory: { state: 'NOT_RECORDED', items: [], limit: 20 }, ownerLink: { state: 'READY', userId: 'owner-a' }, orders: { state: 'READY', items: [], total: 0 } };
  d.contextKey = 'ctx'; return d;
}
const tick = async (h) => { for (let i = 0; i < 6; i++) await h.settle(); };

test('daily list uses seven columns, 20 rows and shared cursor pagination without fabricating totals', async (t) => {
  const items = [
    { ...row, id: 'ok', accountId: 'ok', displayNo: 'TEST-OK', facts: { ...facts, staffRestricted: false, primaryReasonCode: null, newOrders: true, reasons: [] } },
    { ...row, id: 'no', accountId: 'no', displayNo: 'TEST-NO', facts: { ...facts, staffRestricted: false, primaryReasonCode: null, newOrders: false, reasons: [] } },
  ];
  const calls = []; let listing = 0;
  const h = await mountHarness(t, { permissions, fetchImpl: async url => {
    if (url.pathname.endsWith('/listing-reviews')) { calls.push(url); listing++; return json({ ...page, items, nextCursor: listing === 1 ? 'cursor-1' : null }); }
    return json(workDetail());
  } });
  await tick(h);
  assert.deepEqual([...h.el.querySelectorAll('thead th')].map(th => th.textContent.trim()), ['账号 / 号主', '核心资产配置', '租用条件', '基础资源费 / 租客押金', '业务状态', '更新时间', '操作']);
  assert.equal(new URL(calls[0], 'http://localhost').searchParams.get('limit'), '20');
  assert.ok(h.el.textContent.includes('当前无接新单阻塞'));
  assert.ok(h.el.textContent.includes('不可接新单，原因未提供'));
  assert.ok(!h.el.textContent.includes('服务端未返回阻塞'));
  await h.click([...h.el.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '下一页'));
  await tick(h);
  assert.equal(new URL(calls.at(-1), 'http://localhost').searchParams.get('cursor'), 'cursor-1');
  await h.click([...h.el.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '上一页'));
  await tick(h);
  assert.equal(new URL(calls.at(-1), 'http://localhost').searchParams.has('cursor'), false);
  assert.equal(h.writes.length, 0);
});

test('row click opens quick view; pending counted; removing permission clears the open drawer', async (t) => {
  const h = await mountHarness(t, { permissions, fetchImpl: async (url) => url.pathname.endsWith('/listing-reviews') ? json(page) : json(workDetail()) });
  await tick(h);
  const tr = h.el.querySelector('tr[tabindex="0"]');
  assert.ok(tr, 'row is focusable');
  await h.click(tr); await tick(h);
  const aside = h.el.querySelector('[data-slot="dialog-content"]');
  assert.ok(aside, 'drawer opened from row click');
  assert.ok(aside.textContent.includes('1 项已确认阻塞、1 项待核'), 'pending counted in banner');
  assert.ok(aside.textContent.includes('不可接新单'));
  assert.ok(!aside.textContent.includes('全部满足'));
  h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(h); await new Promise(r => setTimeout(r, 50)); await tick(h);
  assert.equal(h.el.querySelectorAll('[data-slot="dialog-content"]').length, 0, 'Esc closes quick view');
  assert.equal(h.browser.document.activeElement?.id, 'supply-open-a', 'focus returns to the row');
  h.browser.document.activeElement.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(h);
  assert.ok(h.el.querySelector('[data-slot="dialog-content"]'), 'Enter reopens from keyboard');
  await h.render('admin', ['order.read']); await tick(h);
  assert.equal(h.el.querySelectorAll('[data-slot="dialog-content"]').length, 0, 'drawer cleared after permission removal');
  assert.equal(h.writes.length, 0);
});


test('mobile card opens Sheet and receives focus back after Escape', async (t) => {
  const h = await mountHarness(t, { permissions, fetchImpl: async (url) => url.pathname.endsWith('/listing-reviews') ? json(page) : json(workDetail()) });
  await tick(h);
  const card = h.el.querySelector('#supply-card-a');
  assert.ok(card);
  await h.click(card); await tick(h);
  assert.ok(h.el.querySelector('[data-slot="dialog-content"]'));
  h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(h); await new Promise(r => setTimeout(r, 50)); await tick(h);
  assert.equal(h.browser.document.activeElement?.id, 'supply-card-a');
  assert.equal(h.writes.length, 0);
});

test('quick view reuses loaded attributes and marks quote provenance without fetching every row', async (t) => {
  let reads = 0;
  const value = workDetail();
  value.version.quote = { resourceTotal: { amount: '212.77' }, termSeconds: '86400' };
  value.version.releaseId = 'fixture-release-7';
  value.version.declaration.attributes.vit_level = 7;
  value.version.declaration.attributes.full_payout_declaration = { selected: true };
  const h = await mountHarness(t, { permissions, fetchImpl: async url => { if (url.pathname.endsWith('/listing-reviews')) return json({ ...page, items: [row, { ...row, id: 'b', accountId: 'b' }] }); reads++; return json(value); } });
  await tick(h);
  assert.equal(reads, 0, 'list never fetches one detail per row');
  await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  assert.equal(reads, 1);
  const text = h.el.querySelector('[data-slot="dialog-content"]').textContent;
  assert.match(text, /体力等级.*7 级/);
  assert.match(text, /全额包赔.*已选/);
  assert.match(text, /212.77/);
  assert.match(text, /fixture-release-7/);
  assert.match(text, /非按当前规则重新试算/);
  assert.match(text, /租客档位口径未提供/);
  assert.equal(h.writes.length, 0);
});

test('quick resource chips use loaded frozen names and code-aware units without another request', async t => {
  const value = workDetail(); let detailReads = 0;
  value.version.declaration.inventory = [{ itemId: 'dynamic-backpack-probe', quantity: '2' }, { itemId: 'old-insurance-probe', quantity: '0' }, { itemId: 'unknown-probe', quantity: null }, { itemId: 'fraction-probe', quantity: '1.50' }];
  value.version.presentation.items = [
    { id: 'dynamic-backpack-probe', code: 'df_billable_turtle_backpack_45', name: '45格乌龟包', unit: 'PIECE' },
    { id: 'old-insurance-probe', code: 'df_billable_top_insure_card', name: '顶级保险卡', unit: 'DAY' },
    { id: 'fraction-probe', code: 'another-resource', name: '其他动态资源', unit: 'PIECE' },
  ];
  const h = await mountHarness(t, { permissions, fetchImpl: async url => {
    if (url.pathname.endsWith('/listing-reviews')) return json(page);
    detailReads++; return json(value);
  } });
  await tick(h); await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  const text = h.el.querySelector('[data-slot="dialog-content"]').textContent;
  assert.match(text, /45格乌龟包.*2 个/); assert.match(text, /顶级保险卡.*0 天/);
  assert.match(text, /名称待核.*数量未知/); assert.doesNotMatch(text, /dynamic-backpack-probe|old-insurance-probe|九格保险体验卡/);
  assert.match(text, /其他动态资源.*1\.50 件/);
  assert.equal(detailReads, 1); assert.equal(h.writes.length, 0);
});

test('historical list, mobile card and quick view expose existing source facts without new queries or current-quote claims', async (t) => {
  const historicalRead = {
    resourceNo: 'OLD-7', canCreateOrder: false, trade: 'UNKNOWN', quote: null,
    historicalQuote: { haffRentYuan: '125.30', goodsYuan: '0.00', depositYuan: '0.00', termDays: '10', dailyHaffBase: '10000000' },
    display: { state: 'KNOWN', facts: {
      schema: 'legacy-listing-display-v1', rentalMode: 'custom', attributes: { vit_level: 0 },
      resources: [{ code: 'haff', name: '哈夫币', quantity: '97000000', unit: 'HAFF_BASE' }, { code: 'ammo', name: '弹药', quantity: null, unit: 'ROUND' }],
      attributeDisplay: { safeBox: { code: 'box', displayName: '基础安全箱', mappingStatus: 'CONFIRMED', issueCode: null }, grading: null, loginMethod: { code: 'wechat', displayName: '微信扫码', mappingStatus: 'CONFIRMED', issueCode: null }, serviceWindow: null },
      sourceUpdatedAt: '2026-09-09T10:38:00Z',
    } },
  };
  const historicalRow = { ...row, versionId: null, sequence: null, summary: null, facts: { ...facts, historicalRead } };
  const value = workDetail();
  value.version = null;
  value.supervision.facts = historicalRow.facts;
  let detailReads = 0;
  const h = await mountHarness(t, { permissions, fetchImpl: async url => {
    if (url.pathname.endsWith('/listing-reviews')) return json({ ...page, items: [historicalRow] });
    detailReads++; return json(value);
  } });
  await tick(h);
  for (const selector of ['#supply-open-a', '#supply-card-a']) {
    const text = h.el.querySelector(selector).textContent;
    assert.match(text, /历史租金 ¥125.30/);
    assert.match(text, /历史物资费 ¥0.00/);
    assert.match(text, /历史 ¥0.00/);
    assert.match(text, /历史 97 M 哈夫币/);
    assert.match(text, /历史编号 OLD-7.*基础安全箱/);
  }
  assert.equal(detailReads, 0, 'existing row projection is enough for both list layouts');
  await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  const section = h.el.querySelector('[data-historical-summary]');
  assert.ok(section, 'historical details are separate from current declarations');
  assert.match(section.textContent, /历史租金.*¥125.30/);
  assert.match(section.textContent, /历史物资费.*¥0.00/);
  assert.match(section.textContent, /历史押金.*¥0.00/);
  assert.match(section.textContent, /历史租期.*10 天/);
  assert.match(section.textContent, /历史编号 OLD-7/);
  assert.match(section.textContent, /来源更新：/);
  const toggle = [...h.el.querySelectorAll('button')].find(button => button.textContent.trim() === '历史来源记录（仅参考）');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await h.click(toggle); await tick(h);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.match(section.textContent, /弹药.*数量待核/);
  assert.ok(!section.textContent.includes('冻结报价'));
  assert.equal(detailReads, 1, 'only the existing quick-view detail read is used');
  assert.equal(h.writes.length, 0);
});

test('detail failure remains unknown in quick view instead of empty or perpetual loading', async (t) => {
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json(page) : json({ message: 'fixture failure' }, 500) });
  await tick(h); await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  const text = h.el.querySelector('[data-slot="dialog-content"]').textContent;
  assert.match(text, /详情未读到/);
  assert.ok(!text.includes('读取中…'));
  assert.ok(!text.includes('当前授权范围内未匹配订单'));
  assert.equal(h.writes.length, 0);
});

test('new restriction does not present a previous restriction review or attach an old reason', async (t) => {
  const value = workDetail();
  value.account.staff_restricted = false;
  value.supervision.facts = { ...facts, staffRestricted: false, reasons: ['PUBLISHER_BAIL_UNCONFIRMED'] };
  value.supervision.restrictionHistory = { state: 'READY', limit: 20, items: [{ id: 'old', restricted: true, reason: 'old reason uniquely marked', actorName: 'fixture actor', occurredAt: '2026-10-01T00:00:00Z' }] };
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'review' }, fetchImpl: async () => json(value) });
  await tick(h);
  assert.match(h.el.textContent, /新增运营限制/);
  assert.ok(!h.el.textContent.includes('复核已有限制 · 原限制与证据'));
  await h.fillReason('fixture new restriction');
  await h.click(h.btn('核对后确认运营限制')); await tick(h);
  const dialog = h.el.querySelector('[data-slot="dialog-content"]');
  assert.ok(dialog);
  assert.ok(!dialog.textContent.includes('old reason uniquely marked'));
  assert.equal(h.writes.length, 0, 'opening confirmation remains read-only');
});

test('nested row control keyboard does not trigger the row and shared components own interactive controls', async (t) => {
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json(page) : json(workDetail()) });
  await tick(h);
  const reason = h.el.querySelector('#supply-open-a button[aria-label="查看全部 2 项原因"]');
  assert.ok(reason);
  reason.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(h);
  assert.equal(h.el.querySelectorAll('[data-slot="dialog-content"]').length, 0, 'child keydown is not a row activation');
  assert.equal(h.el.querySelectorAll('select, details, summary, button:not([data-slot]), input:not([data-slot]):not([aria-hidden]):not([type=hidden])').length, 0);
  assert.equal(h.writes.length, 0);
});

test('complete account detail preserves dirty reason when version-switch confirmation is cancelled', async (t) => {
  const value = workDetail();
  value.account.staff_restricted = false;
  value.history.push({ ...value.history[0], id: 'v-old', sequence: '0' });
  let reads = 0;
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'review' }, fetchImpl: async () => { reads++; return json(value); } });
  await tick(h); await h.fillReason('fixture unsaved version check');
  await h.click(h.btn('返回账号资料')); await tick(h);
  await h.click(h.btn('历史版本与审核记录')); await tick(h);
  await h.click(h.btn('第 0 版 · 已发布(直发)')); await tick(h);
  assert.ok(h.el.querySelector('[data-slot="dialog-content"]'));
  await h.click(h.btn('保留说明')); await tick(h);
  assert.equal(reads, 1, 'cancel did not fetch another version');
  await h.click(h.btn('新增运营限制')); await tick(h);
  assert.equal(h.el.querySelector('textarea').value, 'fixture unsaved version check');
  assert.equal(h.writes.length, 0);
});

test('archive follows independent eligibility facts even when the compatibility available flag is true', async (t) => {
  const value = workDetail();
  value.account.staff_restricted = false;
  value.available = true;
  value.supervision.facts = { ...facts, staffRestricted: false, publicVisible: null, newOrders: null, occupancy: 'UNKNOWN', reasons: ['FUNDING_UNKNOWN'] };
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'archive' }, fetchImpl: async () => json(value) });
  await tick(h);
  assert.match(h.el.textContent, /新单资格待核/);
  assert.match(h.el.textContent, /公开状态待核/);
  assert.ok(!h.el.textContent.includes('当前可公开出租'));
  assert.equal(h.el.querySelectorAll('select, details, summary, button:not([data-slot]), input:not([data-slot]):not([aria-hidden]):not([type=hidden])').length, 0);
  assert.equal(h.writes.length, 0);
});

for (const context of ['changes', 'archive']) {
  test(`account image Dialog preserves authorized source and returns focus (${context})`, async (t) => {
    const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context }, fetchImpl: async () => json(workDetail()) });
    await tick(h);
    const trigger = [...h.el.querySelectorAll('button')].find(x => x.getAttribute('aria-label')?.startsWith('放大核对'));
    assert.ok(trigger);
    const src = trigger.querySelector('img').getAttribute('src');
    trigger.focus(); await h.click(trigger); await tick(h);
    const dialog = h.el.querySelector('[data-account-image]');
    assert.ok(dialog);
    assert.equal(dialog.querySelector('img').getAttribute('src'), src);
    assert.match(src, /m-display/);
    assert.equal(dialog.querySelectorAll('a[download]').length, 0);
    assert.equal(h.el.querySelectorAll('dialog').length, 0, 'account no longer uses native dialog');
    h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(h); await new Promise(r => setTimeout(r, 50)); await tick(h);
    assert.equal(h.el.querySelector('[data-account-image]'), null);
    assert.equal(h.browser.document.activeElement, trigger);
    assert.equal(h.writes.length, 0);
  });
}

/* ---------- F1 / F4：账号列表本轮返修反例 ---------- */

test('F1 the list offers no uncontracted disposition and never reports one as recorded', async (t) => {
  const h = await mountHarness(t, { permissions: ['supply.review.read', 'supply.review.decide', 'supply.restrict', 'supply.quote.internal.read', 'user.directory.read'], isBoss: true, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json(page) : json(workDetail()) });
  await tick(h);
  for (const label of ['批量下架', '批量退还保证金', '上架账号', '下架账号', '退款处理', '全选本页账号', '确认执行', '确认下架', '确认退还']) {
    assert.equal(h.el.textContent.includes(label), false, `no ${label} entry`);
    assert.equal(h.el.querySelector(`[aria-label="${label}"]`), null, `no ${label} control`);
  }
  assert.equal(h.el.querySelectorAll('thead [role="checkbox"], thead input[type="checkbox"]').length, 0, 'the selection column is gone with the bulk commands');
  assert.ok(!h.el.textContent.includes('操作指令已记录') && !h.el.textContent.includes('操作已记录'));
  assert.equal(h.writes.length, 0, 'reading the list performs no write');
});

test('F1 rows still show read-only facts as unprovided instead of inventing them', async (t) => {
  const h = await mountHarness(t, { permissions: ['supply.review.read'], fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json(page) : json(workDetail()) });
  await tick(h);
  const rowText = h.el.querySelector('#supply-open-a').textContent;
  assert.ok(rowText.includes('未提供') || rowText.includes('未申报'), rowText);
  assert.ok(!rowText.includes('免保证金'), 'missing guarantee facts never read as waived');
  assert.ok(!rowText.includes('❌'), 'a missing payout declaration is not marked refused');
  assert.equal(h.el.querySelectorAll('#supply-open-a [aria-label="查看详情"], #supply-open-a [aria-label="复制编号"]').length, 2, 'only the read/copy entries stay');
});

test('F4 the owner entry navigates from the current row and stays inert without a ready projection', async (t) => {
  const ready = { ...row, ownerLink: { state: 'READY' }, ownerSummary: { name: '阿洛甲', image: null, maskedPhone: '138****8000' } };
  const denied = { ...row, id: 'b', accountId: 'b', ownerId: 'owner-b', ownerName: '乙', ownerLink: { state: 'DENIED' } };
  const legacy = { ...row, id: 'c', accountId: 'c', ownerId: 'owner-c', ownerName: '丙' };
  const h = await mountHarness(t, { permissions: ['supply.review.read', 'user.directory.read'], fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [ready, denied, legacy] }) : json(workDetail()) });
  await tick(h);
  const trigger = id => [...h.el.querySelectorAll(`#supply-open-${id} button`)].find(button => button.textContent.startsWith('@'));
  await h.click(trigger('a')); await tick(h);
  assert.equal(h.routes.length, 1, JSON.stringify(h.routes));
  assert.match(h.routes[0].path, /^\/users\/owner-a\?fromSupplyId=a/);
  for (const id of ['b', 'c']) {
    await h.click(trigger(id)); await tick(h);
    assert.equal(h.routes.length, 1, `row ${id} without a READY projection never navigates`);
  }
  assert.equal(trigger('c')?.getAttribute('aria-disabled'), 'true', 'a row without a READY projection is explicitly inert');
  assert.equal(trigger('b')?.getAttribute('aria-disabled'), 'true');
  assert.equal(trigger('a')?.getAttribute('aria-disabled'), 'false');
});

test('FLOW02 Root F3: public image review is read-only, explicit draft remains usable, and pending writes cannot switch context',async t=>{
 const all=[...permissions,'supply.review.decide','supply.duplicate.review'];
 const d=detail({...accountA,display_no:'PUBLIC-CONTEXT',owner_user_id:'owner-a',staff_restricted:false},'SUBMITTED');d.version.id='draft-v3';d.version.sequence='3';d.version.declaration.title='Private draft v3';d.version.declaration.mediaBindings[0].byteHash='a'.repeat(64);d.version.declaration.mediaBindings[0].mediaRevision='2';
 d.contextKey='root-f3';d.supervision={historical:false,facts:{...facts,publicVisible:true,newOrders:true,reasons:[],staffRestricted:false,publicVersionId:'public-v1',publicBasis:{id:'public-v1',accountId:'a',releaseId:'release-v1',title:'Original public v1',description:null,attributes:{},presentation:{items:[],skins:[],entitlements:[]},media:[],quote:null,termOption:null,fullPayoutSelected:null,publishedAt:'2026-10-21T01:02:03Z'}},changes:null,previousVersion:null,restrictionHistory:{state:'NOT_RECORDED',items:[],limit:20},ownerLink:{state:'READY',userId:'owner-a'},orders:{state:'READY',items:[],total:0}};
 let resolveFirst,attempts=0;const h=await mountHarness(t,{permissions:all,initialAccountId:'a',initialQuery:{context:'situation'},strict:true,fetchImpl:async(url,init)=>{if(init.method==='POST'){if(++attempts===1)return await new Promise(resolve=>{resolveFirst=()=>resolve(json({error:{code:'INTERNAL_ERROR'}},500));});return json({error:{code:'INTERNAL_ERROR'}},500);}if(url.pathname.endsWith('/listing-reviews'))return json({items:[]});return json(d);}});t.after(()=>resolveFirst?.());await tick(h);
 assert.match(h.el.querySelector('#supply-detail-title').textContent,/Original public v1/);await h.click(h.btn('审核与图片'));await tick(h);assert.equal(h.el.querySelector('textarea[aria-label="本次图片核对说明"]'),null);assert(!h.btn('确认前核对并隔离本图'));assert.match(h.el.textContent,/疑似重复线索/);assert.equal(h.writes.length,0);
 await h.click(h.btn('查看当前草稿'));await tick(h);assert.match(h.el.querySelector('#supply-detail-title').textContent,/Private draft v3/);await h.fillReason('source-bound current draft review');assert.equal(h.btn('确认前核对并隔离本图').disabled,false);
 await h.click(h.btn('账号资料'));await tick(h);const back=h.btn('回到对外版本');assert(back&&!back.disabled);await h.click(h.btn('通过历史审核'));await tick(h);assert.equal(back.disabled,true,'an open version-bound confirmation cannot change context');
 await h.click(h.btn('确认通过历史审核'));await tick(h);assert.equal(h.writes.length,1);assert(resolveFirst);assert.equal(back.disabled,true,'in-flight request keeps the selected version');await h.click(back);assert.match(h.el.querySelector('#supply-detail-title').textContent,/Private draft v3/);
 resolveFirst();await tick(h);assert.match(h.el.textContent,/结果未确认/);assert.equal(back.disabled,true,'UNKNOWN cannot return to a writable alternate context');
 await h.click(h.btn('确认通过历史审核'));await tick(h);assert.equal(h.writes.length,2);assert.equal(h.writes[0].key,h.writes[1].key);assert.equal(h.writes[0].rawBody,h.writes[1].rawBody);
});
