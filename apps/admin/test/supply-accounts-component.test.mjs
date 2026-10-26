import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
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

test('a 20-digit business number is submitted as an exact clue instead of being rejected as a phone', async (t) => {
  const orderNo = '20260913125844629986', calls = [];
  const h = await mountHarness(t, { permissions, fetchImpl: async url => { if (url.pathname.endsWith('/listing-reviews')) { calls.push(url); return json(page); } return json(workDetail()); } });
  await tick(h);
  const input = h.el.querySelector('input[aria-label="业务线索"]');
  await h.browser.document.defaultView.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, 'value').set.call(input, orderNo);
  input.dispatchEvent(new h.browser.Event('input', { bubbles: true }));
  await h.el.querySelector('form.sa-search').dispatchEvent(new h.browser.Event('submit', { bubbles: true, cancelable: true }));
  await tick(h);
  assert.ok(!h.el.textContent.includes('手机号请从用户管理'));
  assert.equal(new URL(calls.at(-1), 'http://localhost').searchParams.get('q'), orderNo);
  assert.equal(h.writes.length, 0);
});

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
  assert.deepEqual([...h.el.querySelectorAll('thead th')].map(th => th.textContent.trim()), ['账号 / 号主', '核心资源', '出租条件', '基础费用 / 租客押金', '业务状态', '更新时间', '操作']);
  assert.equal(new URL(calls[0], 'http://localhost').searchParams.get('limit'), '20');
  assert.ok(!h.el.querySelector('tbody').textContent.includes('当前无接新单阻塞'), 'ready status is not repeated as a reason');
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


test('U1 account filters are real server parameters, exact, resettable and recover a stale cursor', async (t) => {
  const calls = []; let mode = 'ok';
  const filteredPage = { ...page, nextCursor: 'cursor-next', games: [{ id: 'game-1', name: '三角洲' }], filterOptions: { loginMethods: [{ code: 'login_qq_qr', name: 'QQ扫码' }] } };
  const h = await mountHarness(t, { permissions, fetchImpl: async url => {
    if (url.pathname.endsWith('/listing-reviews')) {
      calls.push(url);
      if (mode === 'conflict' && new URL(url).searchParams.has('cursor')) return json({ error: { code: 'CONFLICT' } }, 409);
      return json(filteredPage);
    }
    return json(workDetail());
  } });
  await tick(h);
  const waitParam = async (key, value) => {
    for (let i = 0; i < 30; i++) {
      const last = calls.at(-1);
      if (last && new URL(last).searchParams.get(key) === value) return new URL(last).searchParams;
      await tick(h);
    }
    assert.fail(`last request did not carry ${key}=${value}: ${calls.at(-1)}`);
  };
  const choose = async (label, optionText) => {
    await h.click(h.el.querySelector(`[aria-label="${label}"]`));
    await tick(h);
    const option = [...h.browser.document.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === optionText);
    assert.ok(option, `missing option ${optionText}`);
    await act(async () => {
      option.focus();
      option.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
    await tick(h);
  };
  const fill = async (label, value) => {
    const input = h.browser.document.querySelector(`[aria-label="${label}"]`);
    assert.ok(input, `missing input ${label}`);
    Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new h.browser.Event('input', { bubbles: true }));
    await tick(h);
  };
  const clueInput = h.el.querySelector('[aria-label="业务线索"]');
  Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, 'value').set.call(clueInput, 'ZZ-TEST-A');
  clueInput.dispatchEvent(new h.browser.Event('input', { bubbles: true }));
  await tick(h);
  await h.el.querySelector('form.sa-search').dispatchEvent(new h.browser.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 30 && new URL(calls.at(-1)).searchParams.get('q') !== 'ZZ-TEST-A'; i++) await tick(h);
  assert.equal(new URL(calls.at(-1)).searchParams.get('q'), 'ZZ-TEST-A');
  await tick(h); await tick(h);
  const resetButton = [...h.el.querySelectorAll('button')].find(button => button.textContent.includes('重置筛选'));
  assert.ok(resetButton && !resetButton.disabled, 'reset is enabled after the query settles');
  await h.click(resetButton);
  for (let i = 0; i < 30 && new URL(calls.at(-1)).searchParams.get('q') !== ''; i++) await tick(h);
  assert.equal(new URL(calls.at(-1)).searchParams.get('q'), '', 'reset sends an empty query');
  assert.equal(clueInput.value, '', 'reset clears the visible query input');
  await h.click([...h.el.querySelectorAll('button')].find(button => button.textContent === '查找'));
  await tick(h); await tick(h);
  assert.equal(new URL(calls.at(-1)).searchParams.get('q'), '', 're-query cannot revive the reset clue');
  await choose('游戏', '三角洲');
  let params = await waitParam('gameId', 'game-1');
  await choose('接单资格', '可接新单');
  params = await waitParam('eligibility', 'ELIGIBLE');
  assert.equal(params.has('cursor'), false);
  await choose('账号来源', '旧平台');
  params = await waitParam('source', 'LEGACY');
  await choose('登录方式', 'QQ扫码');
  params = await waitParam('loginMethod', 'login_qq_qr');

  await h.click(h.el.querySelector('[aria-label="哈夫币"]')); await tick(h);
  await fill('哈夫币下限', '97'); await fill('哈夫币上限', '100');
  await h.click([...h.browser.document.querySelectorAll('button')].find(button => button.textContent === '确定')); await tick(h);
  params = await waitParam('haffMin', '97000000');
  assert.equal(params.get('haffMax'), '100000000');

  await h.click(h.el.querySelector('[aria-label="基础押金"]')); await tick(h);
  await fill('基础押金下限', '0'); await fill('基础押金上限', '125.30');
  await h.click([...h.browser.document.querySelectorAll('button')].find(button => button.textContent === '确定')); await tick(h);
  params = await waitParam('depositMin', '0');
  assert.equal(params.get('depositMax'), '12530');

  // An exact bound without a summary match still sends the filter; the page only shows what the server returned.
  assert.equal(new URL(calls.at(-1)).searchParams.get('eligibility'), 'ELIGIBLE');

  // Stale cursor → recover first page while keeping every filter.
  mode = 'conflict';
  await h.click(h.el.querySelector('[aria-label="下一页"]')); await tick(h); await tick(h);
  assert.ok(h.el.textContent.includes('查询上下文已变化，已重新从第1页读取；筛选条件已保留。'));
  params = new URL(calls.at(-1)).searchParams;
  assert.equal(params.has('cursor'), false);
  assert.equal(params.get('eligibility'), 'ELIGIBLE');
  assert.equal(params.get('source'), 'LEGACY');
  mode = 'ok';

  // Precision and inverted ranges are reported without a request.
  const before = calls.length;
  await h.click(h.el.querySelector('[aria-label="哈夫币"]')); await tick(h);
  await fill('哈夫币下限', '1.0000001');
  await h.click([...h.browser.document.querySelectorAll('button')].find(button => button.textContent === '确定')); await tick(h);
  assert.ok(h.browser.document.body.textContent.includes('哈夫币应为最多 6 位小数的 M 数'));
  assert.equal(calls.length, before);
  await fill('哈夫币下限', '100'); await fill('哈夫币上限', '50');
  await h.click([...h.browser.document.querySelectorAll('button')].find(button => button.textContent === '确定')); await tick(h);
  assert.ok(h.browser.document.body.textContent.includes('下限不能大于上限'));
  assert.equal(calls.length, before);

  await h.click([...h.el.querySelectorAll('button')].find(button => button.textContent.includes('重置筛选'))); await tick(h);
  params = new URL(calls.at(-1)).searchParams;
  for (const key of ['eligibility','source','loginMethod','haffMin','haffMax','depositMin','depositMax','cursor']) assert.equal(params.has(key), false, key);
  assert.equal(h.writes.length, 0);

  const restored = [];
  const h2 = await mountHarness(t, { permissions, initialQuery: { eligibility: 'BLOCKED', source: 'LEGACY', haffMin: '97000000', haffMax: '100000000', depositMin: '0', depositMax: '12530', loginMethod: 'login_qq_qr' }, fetchImpl: async url => {
    if (url.pathname.endsWith('/listing-reviews')) { restored.push(new URL(url)); return json({ ...filteredPage, items: [] }); }
    return json(workDetail());
  } });
  await tick(h2);
  const initial = restored.at(-1).searchParams;
  for (const [key, value] of Object.entries({ eligibility: 'BLOCKED', source: 'LEGACY', haffMin: '97000000', haffMax: '100000000', depositMin: '0', depositMax: '12530', loginMethod: 'login_qq_qr' })) assert.equal(initial.get(key), value, key);
  assert.equal(h2.el.querySelector('[aria-label="接单资格"]').textContent.includes('不可接新单'), true);
});

test('U2 the first column has three business layers, a new number only, and one lightweight legacy marker', async t => {
  const identityFacts = { ...facts, staffRestricted: false, newOrders: true, reasons: [], primaryReasonCode: null, sources: [{ sourceSystem: 'LEGACY', sourceEntity: 'account', sourceId: 'OLD-9', businessNo: 'OLD-9' }], legacyNumbers: ['OLD-9'] };
  const summary = {
    displaySource: 'CURRENT_VERSION', versionId: 'v-identity', sequence: '2', refs: {}, timing: { accountCreatedAt: row.sortAt },
    haff: { itemId: 'haff', quantity: '10000000', unit: 'HAFF_BASE' }, materials: [], term: null, login: null,
    config: { safeBox: '顶级安全箱', characterLevel: null, grading: '巅峰', gradingDivision: '3' }, feeSummary: null, quote: null, baseDeposit: null,
    fullPayout: 'NOT_DECLARED', guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null },
  };
  const identityRow = { ...row, displayNo: 'ZZ-2026-000001', ownerName: '这是一位名字很长的号主用于核对换行', facts: identityFacts, summary };
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [identityRow] }) : json(workDetail()) });
  await tick(h);
  for (const selector of ['#supply-open-a', '#supply-card-a']) {
    const text = h.el.querySelector(selector).textContent;
    assert.match(text, /10 M 哈夫币 · 顶级安全箱 · 巅峰 3/);
    assert.match(text, /编号：ZZ-2026-000001/);
    assert.equal(text.includes('OLD-9'), false, 'the old number stays out of the first column');
    assert.match(text, /旧平台/);
    assert.match(text, /这是一位名字很长的号主用于核对换行/);
    assert.equal(text.includes('来源：'), false, 'no per-row technical source notes');
  }
  const unassigned = { ...identityRow, displayNo: null, facts: { ...identityFacts, sources: [] }, summary: null };
  const h2 = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [unassigned] }) : json(workDetail()) });
  await tick(h2);
  assert.match(h2.el.querySelector('#supply-open-a').textContent, /编号未分配/);
  assert.equal(h2.el.querySelector('#supply-open-a').textContent.includes('OLD-9'), false);
  assert.equal(h2.writes.length, 0);
  assert.equal(h.writes.length, 0);
});

test('R2 an over-budget filter fails explicitly and keeps the submitted conditions', async t => {
  const calls = [];
  const h = await mountHarness(t, { permissions, initialQuery: { eligibility: 'UNKNOWN', source: 'LEGACY' }, fetchImpl: async url => {
    if (url.pathname.endsWith('/listing-reviews')) { calls.push(new URL(url)); return json({ error: { code: 'EVIDENCE_UNAVAILABLE' } }, 503); }
    return json(workDetail());
  } });
  await tick(h);
  assert.match(h.el.textContent, /筛选范围过大，暂不能完整核对；已保留筛选条件，请缩小条件后重试。/);
  assert.match(h.el.querySelector('[aria-label="接单资格"]').textContent, /资格待核/);
  assert.match(h.el.querySelector('[aria-label="账号来源"]').textContent, /旧平台/);
  assert.equal(calls.at(-1).searchParams.get('eligibility'), 'UNKNOWN');
  assert.equal(calls.at(-1).searchParams.get('source'), 'LEGACY');
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


test('U3 account base fees show the exact same-version split in list, quick view and complete detail, including zero', async t => {
  const feeSummary = { completeness: 'COMPLETE', haffRental: { amount: '100.00' }, materials: { amount: '0.00' }, resourceTotal: { amount: '100.00' } };
  const feeSummaryRow = { ...row, facts: { ...facts, staffRestricted: false, reasons: [], newOrders: true, primaryReasonCode: null }, summary: {
    displaySource: 'CURRENT_VERSION', versionId: 'v-a', sequence: '1', refs: {}, timing: { accountCreatedAt: row.sortAt },
    haff: { itemId: 'haff', quantity: '10000000', unit: 'HAFF_BASE' }, materials: [], term: null, login: null, config: null,
    feeSummary, quote: { currency: 'CNY', resourceTotal: { amount: '100.00' }, tenantDeposit: null, tenantPayableTotal: null, frozen: true, personalised: false }, baseDeposit: { amountCents: '5000' }, fullPayout: 'NOT_DECLARED',
    guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null },
  } };
  const detailValue = workDetail();
  detailValue.version.feeSummary = feeSummary;
  detailValue.version.quote = { resourceTotal: { amount: '100.00' }, termSeconds: '86400' };
  detailValue.version.declaration.attributes.owner_deposit_declaration = { schema: 'owner-deposit-declaration-v1', declarationVersion: 'v-a', amountCents: '5000' };
  detailValue.supervision.facts = feeSummaryRow.facts;
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [feeSummaryRow] }) : json(detailValue) });
  await tick(h);
  const cell = h.el.querySelector('#supply-open-a td:nth-child(4)').textContent;
  assert.match(cell, /哈夫币租金\s*¥100\.00/);
  assert.match(cell, /物资费\s*¥0\.00/);
  assert.match(cell, /租客基础押金\s*¥50\.00/);
  assert.match(cell, /原预付三项已闭合/);
  await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  let dialog = h.el.querySelector('[data-slot="dialog-content"]').textContent;
  assert.match(dialog, /哈夫币租金\s*¥100\.00/);
  assert.match(dialog, /物资费\s*¥0\.00/);
  assert.match(dialog, /租客基础押金（号主申报）\s*¥50\.00/);
  assert.match(dialog, /资源费合计（资料版冻结参考）\s*¥100\.00/);
  h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(h); await new Promise(r => setTimeout(r, 50)); await tick(h);
  await h.render('admin', permissions, 'a', { context: 'situation' }); await tick(h);
  const complete = h.el.textContent;
  assert.match(complete, /哈夫币租金\s*¥100\.00/);
  assert.match(complete, /物资费\s*¥0\.00/);
  assert.match(complete, /租客基础押金（号主申报）\s*¥50\.00/);
  assert.match(complete, /资源费合计（资料版冻结参考）\s*¥100\.00/);
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


test('F2 public v1 stays the single basis across list, quick view and complete detail until the draft is explicitly chosen', async (t) => {
  const publicBasis = {
    id: 'v-public', releaseId: 'rel-public', contentHash: 'hash-public', accountId: 'a', title: null, description: '对外说明',
    attributes: { safe_box_code: 'safe_box_3x3', login_method_code: 'login_qq_qr' },
    attributeDisplay: { safeBox: { displayName: '顶级安全箱' }, grading: { displayName: '巅峰' }, loginMethod: { displayName: 'QQ扫码' }, serviceWindow: null },
    presentation: { items: [{ id: 'haff', name: '哈夫币', unit: 'HAFF_BASE' }, { id: 'bullet', name: '巴雷特子弹', unit: 'ROUND' }], skins: [], entitlements: [] },
    media: [],
    quote: { resourceTotal: { amount: '111.00' }, termSeconds: '172800', baseRenterHaffRatioWanPerYuan: '10.00', lines: [
      { itemId: 'haff', quantity: '10000000', unit: 'HAFF_BASE', buyerAmount: { amount: '100.00' } },
      { itemId: 'bullet', quantity: '1', unit: 'ROUND', buyerAmount: { amount: '11.00' } },
    ] },
    termOption: { code: 'two-day', displayName: '两日', dailyConsumption: { quantity: '5000000', unit: 'HAFF_BASE' } },
    fullPayoutSelected: true, publishedAt: '2026-10-01T00:00:00.000Z', baseDeposit: { amountCents: '12530' },
    feeSummary: { completeness: 'COMPLETE', haffRental: { amount: '100.00' }, materials: { amount: '11.00' }, resourceTotal: { amount: '111.00' } },
  };
  const publicFacts = { ...facts, publicVisible: true, newOrders: true, reasons: [], staffRestricted: false, primaryReasonCode: null, occupancy: 'FREE', publicBasis };
  const publicRow = { ...row, facts: publicFacts, summary: {
    displaySource: 'PUBLIC_VERSION', versionId: 'v-public', sequence: null, contentHash: 'hash-public', title: '对外标题', description: '对外说明', refs: { ruleReleaseId: 'rel-public', priceVersionId: null, contentHash: 'hash-public', catalogRevision: null, publicationSource: 'PUBLIC', publishedAt: '2026-10-01T00:00:00.000Z' }, timing: { accountCreatedAt: row.sortAt, accountUpdatedAt: null, versionCreatedAt: null },
    haff: { itemId: 'haff', quantity: '10000000', unit: 'HAFF_BASE' }, materials: [{ itemId: 'bullet', name: '巴雷特子弹', code: 'barrett', quantity: '1', unit: 'ROUND' }], materialsTotal: 1,
    term: { code: 'two-day', name: '两日', dailyConsumption: '5000000', termSeconds: '172800' }, login: { code: 'login_qq_qr', displayName: 'QQ扫码' }, config: { safeBox: '顶级安全箱', characterLevel: null, grading: '巅峰', gradingDivision: null },
    feeSummary: publicBasis.feeSummary, quote: { currency: 'CNY', resourceTotal: { amount: '111.00' }, tenantDeposit: null, tenantPayableTotal: null, frozen: true, personalised: false }, baseDeposit: { amountCents: '12530' }, fullPayout: 'SELECTED',
    guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: 'CONFIRMED', recordedProof: null },
  } };
  const current = workDetail();
  current.version.sequence = '3'; current.version.id = 'v-current'; current.version.contentHash = 'hash-current';
  current.version.declaration.title = '旧号 OLD-7 原题'; current.version.declaration.inventory = [{ itemId: 'haff', quantity: '12000000' }];
  current.version.quote = { resourceTotal: { amount: '212.77' }, termSeconds: '259200' };
  current.version.termOption = { code: 'three-day', displayName: '三日', dailyConsumption: { quantity: '7000000', unit: 'HAFF_BASE' } };
  current.version.feeSummary = { completeness: 'COMPLETE', haffRental: { amount: '200.00' }, materials: { amount: '12.77' }, resourceTotal: { amount: '212.77' } };
  current.supervision.facts = publicFacts;
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [publicRow] }) : json(current) });
  await tick(h);
  assert.match(h.el.querySelector('#supply-open-a').textContent, /10 M 哈夫币 · 顶级安全箱 · 巅峰/);
  assert.ok(h.el.querySelector('#supply-open-a').textContent.includes('对外版'));
  await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  let dialog = h.el.querySelector('[data-slot="dialog-content"]');
  assert.match(dialog.textContent, /10 M 哈夫币 · 顶级安全箱 · 巅峰/);
  assert.match(dialog.textContent, /版本 v-public/);
  assert.match(dialog.textContent, /摘要 hash-public/);
  assert.match(dialog.textContent, /哈夫币租金\s*¥100\.00/);
  assert.match(dialog.textContent, /物资费\s*¥11\.00/);
  assert.match(dialog.textContent, /资料租期（冻结原值）\s*2 天/);
  assert.equal(dialog.textContent.includes('旧号 OLD-7'), false);
  assert.equal(dialog.textContent.includes('对外标题'), false, 'the original public title is not the neutral heading');
  assert.equal(dialog.textContent.includes('212.77'), false);
  await h.click([...dialog.querySelectorAll('button')].find(button => button.textContent === '查看当前草稿')); await tick(h);
  dialog = h.el.querySelector('[data-slot="dialog-content"]');
  assert.match(dialog.textContent, /12 M 哈夫币 · 未确认（代码 box-a）/);
  assert.equal(dialog.textContent.includes('旧号 OLD-7'), false, 'the old original title never becomes the neutral heading');
  assert.match(dialog.textContent, /摘要 hash-current/);
  assert.match(dialog.textContent, /资料租期（冻结原值）\s*3 天/);
  assert.match(dialog.textContent, /212\.77/);
  await h.click([...dialog.querySelectorAll('button')].find(button => button.textContent === '回到对外版')); await tick(h);
  assert.match(h.el.querySelector('[data-slot="dialog-content"]').textContent, /版本 v-public/);
  await h.render('admin', permissions, 'a', { context: 'situation' }); await tick(h);
  const complete = h.el.textContent;
  assert.match(complete, /租客当前看到的版本/);
  assert.match(complete, /版本 v-public · 摘要 hash-public/);
  assert.match(complete, /哈夫币租金\s*¥100\.00/);
  assert.match(complete, /资料租期（冻结原值）\s*2 天/);
  assert.equal(complete.includes('212.77'), false, 'the complete detail starts from the same public basis');
  const draftButton = [...h.el.querySelectorAll('button')].find(button => button.textContent === '查看当前草稿');
  assert.ok(draftButton, 'the draft is reachable only through the explicit switch');
  await h.click(draftButton); await tick(h);
  assert.match(h.el.textContent, /旧号 OLD-7 原题/);
  assert.equal(h.writes.length, 0);
});

test('R2 quick title treats an empty current title as missing and keeps the accessible neutral name', async t => {
  const summary = { displaySource: 'CURRENT_VERSION', versionId: 'v-a', sequence: '1', refs: {}, timing: { accountCreatedAt: row.sortAt }, haff: { itemId: 'haff', quantity: '10000000', unit: 'HAFF_BASE' }, materials: [], term: null, login: null, config: { safeBox: '顶级安全箱', characterLevel: null, grading: '钻石', gradingDivision: null }, feeSummary: null, quote: null, baseDeposit: null, fullPayout: 'NOT_DECLARED', guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null } };
  const emptyRow = { ...row, facts: { ...facts, staffRestricted: false, reasons: [], newOrders: true, primaryReasonCode: null }, summary };
  const current = workDetail(); current.version.id = 'v-a'; current.version.declaration.title = ''; current.version.declaration.inventory = [{ itemId: 'haff', quantity: '10000000' }]; current.version.presentation = { items: [{ id: 'haff', name: '哈夫币', unit: 'HAFF_BASE' }] }; current.version.attributeDisplay = { safeBox: { displayName: '顶级安全箱' }, grading: { displayName: '钻石' }, loginMethod: null, serviceWindow: null }; current.supervision.facts = emptyRow.facts;
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [emptyRow] }) : json(current) });
  await tick(h); await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  const dialog = h.el.querySelector('[data-slot="dialog-content"]');
  const title = dialog.querySelector('[data-slot="dialog-title"]');
  assert.equal(title.textContent, '10 M 哈夫币 · 顶级安全箱 · 钻石');
  assert.notEqual(title.textContent.trim(), '', 'an empty source title cannot empty the DialogTitle');
  assert.ok(dialog.getAttribute('aria-labelledby') === 'qv-title' && title.id === 'qv-title');
  assert.equal(dialog.textContent.includes('旧号 OLD-7'), false);
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


test('R2 a known 111.00 total survives unknown components in list, quick view and complete detail', async t => {
  const unknown = { completeness: 'UNKNOWN', haffRental: null, materials: null, resourceTotal: null };
  const rowWithUnknown = { ...row, facts: { ...facts, staffRestricted: false, reasons: [], newOrders: true, primaryReasonCode: null }, summary: {
    displaySource: 'CURRENT_VERSION', versionId: 'v-a', sequence: '1', refs: {}, timing: { accountCreatedAt: row.sortAt },
    haff: null, materials: [], term: null, login: null, config: null, feeSummary: unknown,
    quote: { currency: 'CNY', resourceTotal: { amount: '111.00' }, tenantDeposit: null, tenantPayableTotal: null, frozen: true, personalised: false }, baseDeposit: { amountCents: '5000' }, fullPayout: 'NOT_DECLARED',
    guarantee: { requirement: null, requirementSource: 'UNAVAILABLE', eligibility: null, recordedProof: null },
  } };
  const value = workDetail();
  value.version.feeSummary = unknown; value.version.quote = { resourceTotal: { amount: '111.00' }, termSeconds: '86400' };
  value.version.declaration.attributes.owner_deposit_declaration = { schema: 'owner-deposit-declaration-v1', declarationVersion: 'v-a', amountCents: '5000' };
  value.supervision.facts = rowWithUnknown.facts;
  const h = await mountHarness(t, { permissions, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json({ ...page, items: [rowWithUnknown] }) : json(value) });
  await tick(h);
  const cell = h.el.querySelector('#supply-open-a td:nth-child(4)').textContent;
  assert.match(cell, /资源费合计|哈夫币租金/);
  assert.match(cell, /¥111\.00/);
  assert.match(cell, /哈夫币租金\s*分项待核/);
  await h.click(h.el.querySelector('#supply-open-a')); await tick(h);
  let dialog = h.el.querySelector('[data-slot="dialog-content"]').textContent;
  assert.match(dialog, /资源费合计（资料版冻结参考）\s*¥111\.00/);
  assert.match(dialog, /哈夫币租金\s*分项待核/);
  assert.match(dialog, /物资费\s*分项待核/);
  assert.equal(dialog.includes('资源费合计（资料版冻结参考）\s*未提供'), false);
  h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(h); await new Promise(r => setTimeout(r, 50)); await tick(h);
  await h.render('admin', permissions, 'a', { context: 'situation' }); await tick(h);
  const complete = h.el.textContent;
  assert.match(complete, /资源费合计（资料版冻结参考）\s*¥111\.00/);
  assert.match(complete, /哈夫币租金\s*分项待核/);
  assert.match(complete, /物资费\s*分项待核/);
  assert.equal(h.writes.length, 0);
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
    assert.match(text, /哈夫币租金 历史 ¥125.30/);
    assert.match(text, /物资费 历史 ¥0.00/);
    assert.match(text, /租客基础押金 历史 ¥0.00/);
    assert.match(text, /历史 97 M 哈夫币/);
    assert.match(text, /基础安全箱/);
    assert.equal(text.includes('OLD-7'), false, 'the old source number stays in the detail trace, not the first column');
    assert.match(text, /旧平台/);
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
