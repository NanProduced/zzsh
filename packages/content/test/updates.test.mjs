import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings, checkUpdatePublication, updateVisibility, DEFAULT_UPDATE_SETTINGS } from '../updates.cjs';

test('format is plate only; plain and markdown are rejected', () => {
  assert.equal(DEFAULT_UPDATE_SETTINGS.format, 'plate');
  assert.equal(updateSettings().format, 'plate');
  assert.throws(() => updateSettings({ format: 'plain' }), /动态发布设置无效/);
  assert.throws(() => updateSettings({ format: 'markdown' }), /动态发布设置无效/);
});

test('ticker and pin have independent windows; expiry leaves historical content readable', () => {
  const s = { tickerEnabled: true, tickerFrom: '2026-10-28T00:00:00Z', tickerUntil: '2026-10-29T00:00:00Z', pinned: true, pinnedUntil: '2026-10-30T00:00:00Z', validUntil: '2026-10-29T12:00:00Z' };
  assert.deepEqual(updateVisibility(s, Date.parse('2026-10-29T06:00:00Z')), { expired: false, visible: true, ticker: false, pinned: true, reminder: false });
  assert.deepEqual(updateVisibility(s, Date.parse(s.validUntil)), { expired: true, visible: false, ticker: false, pinned: false, reminder: false });
  assert.equal(updateVisibility(s, Date.parse(s.tickerFrom)).ticker, true);
});

test('visibleFrom gates every public surface until the scheduled time', () => {
  const s = { visibleFrom: '2026-11-01T00:00:00Z', tickerEnabled: true, tickerUntil: '2026-12-01T00:00:00Z', pinned: true, pinnedUntil: '2026-12-01T00:00:00Z', surfaces: ['publish'] };
  const before = updateVisibility(s, Date.parse('2026-10-31T23:59:59Z'));
  assert.deepEqual(before, { expired: false, visible: false, ticker: false, pinned: false, reminder: false });
  const at = updateVisibility(s, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(at.visible, true);
  assert.equal(at.ticker, true);
  assert.equal(at.pinned, true);
  assert.equal(at.reminder, true);
  // null visibleFrom is immediately visible.
  assert.equal(updateVisibility({ ...s, visibleFrom: null }, Date.parse('2026-10-01T00:00:00Z')).visible, true);
});

test('visibleFrom must be a valid UTC timestamp', () => {
  assert.throws(() => updateSettings({ visibleFrom: '2026-02-30T00:00:00Z' }), /visibleFrom/);
  assert.throws(() => updateSettings({ visibleFrom: '2026-11-01' }), /visibleFrom/);
  assert.equal(updateSettings({ visibleFrom: '2026-11-01T00:00:00Z' }).visibleFrom, '2026-11-01T00:00:00Z');
  assert.equal(updateSettings({ visibleFrom: null }).visibleFrom, null);
});

test('critical reminders and publication controls fail closed', () => {
  assert.throws(() => checkUpdatePublication('NEWS', { pinned: true, pinnedUntil: '2026-10-30T00:00:00Z' }));
  assert.throws(() => checkUpdatePublication('ANNOUNCEMENT', { tickerEnabled: true }));
  assert.throws(() => checkUpdatePublication('ANNOUNCEMENT', { noticeKind: 'maintenance' }));
  assert.throws(() => updateSettings({ validUntil: '2026-02-30T00:00:00Z' }));
  assert.throws(() => updateSettings({ surfaces: ['publish', 'publish'] }));
  assert.equal(checkUpdatePublication('ANNOUNCEMENT', { noticeKind: 'rule-change', effectiveAt: '2026-10-28T01:00:00Z', impact: '出租页面', surfaces: ['publish'] }).surfaces[0], 'publish');
});

test('home popup is opt-in and restricted to announcements', () => {
  assert.equal(updateSettings({}).homePopup, false);
  assert.throws(() => updateSettings({ homePopup: 'true' }), /动态发布设置无效/);
  assert.throws(() => checkUpdatePublication('NEWS', { homePopup: true }), /只有平台公告/);
  assert.equal(checkUpdatePublication('ANNOUNCEMENT', { homePopup: true }).homePopup, true);
});
