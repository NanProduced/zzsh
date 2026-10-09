import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountA, detail, mountHarness } from './supply-review-fixture.mjs';

const permissions = ['supply.review.read', 'supply.restrict', 'supply.review.decide', 'order.read', 'user.directory.read'];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function workDetailWithSources() {
  const result = detail({ ...accountA, display_no: 'TEST-A', owner_user_id: 'owner-a' }, 'PUBLISHED');
  result.supervision = {
    historical: false,
    facts: {
      publicVisible: true, newOrders: true, reasons: [], ownerPaused: false, staffRestricted: false,
      occupancy: 'FREE', publicSource: 'NATIVE_PUBLICATION',
      sources: [
        { sourceSystem: 'legacy_mysql_restore', sourceEntity: 'RentalAccounts', sourceId: 'src-998', businessNo: 'RA-10086' },
        { sourceSystem: 'legacy_mysql_restore', sourceEntity: 'RentalAccounts', sourceId: 'src-997', businessNo: null },
      ],
      legacyNumbers: ['RA-10086'],
    },
    changes: null, previousVersion: null,
    restrictionHistory: { state: 'NOT_RECORDED', items: [], limit: 20 },
    ownerLink: { state: 'READY', userId: 'owner-a' },
    orders: { state: 'READY', items: [], total: 0 },
  };
  result.contextKey = 'fixture-context';
  return result;
}

const row = (id) => ({
  id, accountId: id, displayNo: 'TEST-' + id, ownerId: 'owner-' + id, ownerName: 'fixture owner', revision: '7',
  gameName: 'fixture game', versionId: 'v-' + id, sequence: '1', title: 'fixture account', reviewState: 'PUBLISHED',
  sortAt: '2026-10-03T00:00:00.000000Z',
  facts: { publicVisible: true, publicSource: 'NATIVE_PUBLICATION', newOrders: true, reasons: [], ownerPaused: false, staffRestricted: false, occupancy: 'FREE', sources: [], legacyNumbers: [] },
});
const page = (items) => ({ contractVersion: 'admin-supervision.read.v1', contextKey: 'fixture-context', items, nextCursor: null, stationOrigins: { admin: 'http://127.0.0.1:4291', user: 'http://127.0.0.1:4290' }, games: [] });
const tick = async (h) => { for (let i = 0; i < 6; i++) await h.settle(); };

test('detail situation section shows per-source legacy numbers and honest pending labels', async (t) => {
  const h = await mountHarness(t, {
    permissions,
    initialAccountId: 'a',
    initialQuery: { context: 'situation' },
    fetchImpl: async () => json(workDetailWithSources()),
  });
  await tick(h);
  const text = h.el.textContent;
  assert.ok(text.includes('RA-10086'), 'known legacy business number visible');
  assert.ok(text.includes('旧编号：待核'), 'missing businessNo shown as pending, not blank or zero');
  assert.ok(text.includes('旧业务编号'), 'aggregate legacy number row present');
  assert.ok(!text.includes('未记录旧来源'), 'sources exist so the no-source label stays hidden');
});

test('empty filtered view probes the all-view once and offers a switch hint', async (t) => {
  const requested = [];
  const h = await mountHarness(t, {
    permissions,
    fetchImpl: async (url) => {
      const view = url.searchParams.get('view');
      const q = url.searchParams.get('q');
      requested.push({ view, q });
      if (view === 'restricted') return json(page([]));
      if (q === 'TEST-X') return json(page([row('x')]));
      return json(page([row('a')]));
    },
  });
  await tick(h);
  assert.ok(h.el.textContent.includes('TEST-a'), 'initial all-view row visible');
  const before = requested.length;

  await h.click(h.btn('运营限制'));
  await tick(h);
  assert.ok(h.el.textContent.includes('当前范围没有匹配账号'), 'restricted view is empty');
  assert.ok(!h.el.textContent.includes('视图下有匹配'), 'no query text means no probe and no hint');
  assert.equal(requested.length - before, 1, 'view switch issues exactly one list request');

  const input = h.el.querySelector('input');
  Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, 'value').set.call(input, 'TEST-X');
  input.dispatchEvent(new h.browser.Event('input', { bubbles: true }));
  await h.settle();
  await h.click(h.btn('查找'));
  await tick(h);
  assert.ok(requested.some((r) => r.view === 'restricted' && r.q === 'TEST-X'), 'filtered query issued');
  assert.ok(requested.some((r) => r.view === 'all' && r.q === 'TEST-X'), 'all-view probe issued after empty filtered result');
  assert.ok(h.el.textContent.includes('同一线索在“全部账号”视图下有匹配'), 'switch hint visible');
});

test('no probe without a query, and probe failure stays silent', async (t) => {
  const requested = [];
  const h = await mountHarness(t, {
    permissions,
    fetchImpl: async (url) => {
      const view = url.searchParams.get('view');
      const q = url.searchParams.get('q');
      requested.push({ view, q });
      if (view === 'all' && q === 'X') throw new Error('fixture probe failure');
      return json(page([]));
    },
  });
  await tick(h);
  assert.ok(h.el.textContent.includes('当前范围没有匹配账号'), 'all view empty');
  assert.ok(!h.el.textContent.includes('视图下有匹配'), 'empty all-view does not probe');
  assert.equal(requested.filter((r) => r.q === '').length >= 1, true);
  assert.equal(requested.filter((r) => r.view === 'all' && r.q !== '').length, 0, 'all view with q never probes itself');

  await h.click(h.btn('运营限制'));
  await tick(h);
  const input = h.el.querySelector('input');
  Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, 'value').set.call(input, 'X');
  input.dispatchEvent(new h.browser.Event('input', { bubbles: true }));
  await h.settle();
  await h.click(h.btn('查找'));
  await tick(h);
  assert.ok(h.el.textContent.includes('当前范围没有匹配账号'), 'main empty state still rendered');
  assert.ok(!h.el.textContent.includes('视图下有匹配'), 'failed probe stays silent');
  assert.ok(!h.el.textContent.includes('fixture probe failure'), 'probe failure never surfaces as an error');
  assert.equal(requested.filter((r) => r.view === 'restricted' && r.q === 'X').length, 1, 'filtered query issued once');
  assert.equal(requested.filter((r) => r.view === 'all' && r.q === 'X').length, 1, 'probe attempted once and failed quietly');
});
