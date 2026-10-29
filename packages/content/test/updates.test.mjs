import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings, checkUpdatePublication, updateVisibility, plainTextMarkdown } from '../updates.cjs';
import { inspectMarkdown } from '../markdown.mjs';
test('ticker and pin have independent windows; expiry leaves historical content readable', () => {
  const s = { tickerEnabled: true, tickerFrom: '2026-10-28T00:00:00Z', tickerUntil: '2026-10-29T00:00:00Z', pinned: true, pinnedUntil: '2026-10-30T00:00:00Z', validUntil: '2026-10-29T12:00:00Z' };
  assert.deepEqual(updateVisibility(s, Date.parse('2026-10-29T06:00:00Z')), { expired: false, ticker: false, pinned: true, reminder: false });
  assert.deepEqual(updateVisibility(s, Date.parse(s.validUntil)), { expired: true, ticker: false, pinned: false, reminder: false });
  assert.equal(updateVisibility(s, Date.parse(s.tickerFrom)).ticker, true);
});
test('critical reminders and publication controls fail closed', () => {
  assert.throws(() => checkUpdatePublication('NEWS', { pinned: true, pinnedUntil: '2026-10-30T00:00:00Z' }));
  assert.throws(() => checkUpdatePublication('ANNOUNCEMENT', { tickerEnabled: true }));
  assert.throws(() => checkUpdatePublication('ANNOUNCEMENT', { noticeKind: 'maintenance' }));
  assert.throws(() => updateSettings({ validUntil: '2026-02-30T00:00:00Z' }));
  assert.throws(() => updateSettings({ surfaces: ['publish', 'publish'] }));
  assert.equal(checkUpdatePublication('ANNOUNCEMENT', { noticeKind: 'rule-change', effectiveAt: '2026-10-28T01:00:00Z', impact: '出租页面', surfaces: ['publish'] }).surfaces[0], 'publish');
});
test('legacy defaults never opt into exposure or reinterpret markup', async () => {
  assert.equal(updateSettings().format, 'plain'); assert.equal(updateVisibility({}).ticker, false);
  const original = '# 规则\nTitle\n===\n<script>x</script>\n![图](media://secret)';
  const parsed = await inspectMarkdown(plainTextMarkdown(original));
  assert.equal(parsed.blocking, 0); assert.deepEqual(parsed.toc, []); assert.deepEqual(parsed.mediaIds, []);
  assert.equal(parsed.plainText.replace(/\s/g, ""), original.replace(/\s/g, ""));
});
