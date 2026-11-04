import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceWithdrawalTimeline, emptyWithdrawalTimeline, hasMoreWithdrawalTimeline, removeWithdrawalTimelineSource, withdrawalTimeMicros } from '../src/lib/withdrawal-timeline.ts';

const sources = ['HISTORICAL', 'LOCAL_CONTROLLED', 'JOINPAY'];
const snapshot = { available: true, coverageKnown: true, snapshot: 'snapshot', asOf: '2026-10-30T00:00:00.000Z' };

test('merges independent source cursors across pages without losing or repeating records', async () => {
  const all = Array.from({ length: 75 }, (_, n) => ({ id: `record-${n}`, source: sources[n % 3], at: new Date(Date.UTC(2026, 9, 30) - n * 1000).toISOString() }));
  const calls = [];
  const read = async (source, cursor) => {
    const rows = all.filter(row => row.source === source), offset = Number(cursor ?? 0), items = rows.slice(offset, offset + 4);
    calls.push({ source, cursor });
    return { ...snapshot, items, cursor: offset + items.length < rows.length ? String(offset + items.length) : null };
  };
  let state = emptyWithdrawalTimeline();
  while (hasMoreWithdrawalTimeline(state)) state = await advanceWithdrawalTimeline(state, read);
  assert.deepEqual(state.items.map(item => item.id), all.map(item => item.id));
  assert.equal(new Set(state.items.map(item => item.id)).size, 75);
  assert(sources.every(source => calls.filter(call => call.source === source).length > 1));
  assert.equal(state.partial, false);
});

test('unavailable source is partial and cannot be represented as a complete empty history', async () => {
  const state = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), async source => source === 'JOINPAY'
    ? { ...snapshot, available: false, coverageKnown: false, items: [], cursor: null }
    : { ...snapshot, items: source === 'HISTORICAL' ? [{ source, id: 'history:1', at: '2026-10-29T00:00:00Z' }] : [], cursor: null });
  assert.equal(state.partial, true);
  assert.deepEqual(state.items.map(item => item.id), ['history:1']);
  assert.equal(hasMoreWithdrawalTimeline(state), false);
  const revoked = removeWithdrawalTimelineSource(state, 'HISTORICAL');
  assert.deepEqual(revoked.items, []);
  assert.equal(revoked.partial, true);
});

test('a source snapshot change on continuation rejects instead of merging inconsistent pages', async () => {
  const read = async (source, cursor) => ({ ...snapshot, snapshot: cursor ? 'changed' : snapshot.snapshot,
    items: source === 'HISTORICAL' ? [{ source, id: cursor ? 'history:2' : 'history:1', at: cursor ? '2026-10-28T00:00:00Z' : '2026-10-29T00:00:00Z' }] : [],
    cursor: source === 'HISTORICAL' && !cursor ? 'next' : null });
  const first = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), read, 1);
  await assert.rejects(() => advanceWithdrawalTimeline(first, read, 1), /WITHDRAWAL_SNAPSHOT_CHANGED/);
  assert.deepEqual(first.items.map(item => item.id), ['history:1']);
});

test('orders sub-millisecond records by exact time, then breaks exact ties by ID', async () => {
  assert.equal(withdrawalTimeMicros('2026-10-30T08:00:00.123456+08:00') - withdrawalTimeMicros('2026-10-30T00:00:00.123000Z'), 456n);
  assert.throws(() => withdrawalTimeMicros('invalid'), /WITHDRAWAL_TIME_INVALID/);
  assert.throws(() => withdrawalTimeMicros('2026-02-30T00:00:00.000Z'), /WITHDRAWAL_TIME_INVALID/);
  const state = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), async source => ({ ...snapshot,
    items: source === 'HISTORICAL' ? [{ source, id: 'history:1', at: '2026-10-30T00:00:00.123456Z' }]
      : source === 'LOCAL_CONTROLLED' ? [{ source, id: 'controlled:1', at: '2026-10-30T08:00:00.123789+08:00' }]
      : [{ source, id: 'joinpay:1', at: '2026-10-30T00:00:00.123456Z' }], cursor: null }));
  assert.deepEqual(state.items.map(item => item.id), ['controlled:1', 'joinpay:1', 'history:1']);
  assert.equal(state.temporalTies, true);
});

test('bounded scan returns a continuation when many short source pages are needed', async () => {
  let calls = 0;
  const read = async (source, cursor) => {
    calls++;
    if (source !== 'HISTORICAL') return { ...snapshot, items: [], cursor: null };
    const n = Number(cursor ?? 0);
    return { ...snapshot, items: [{ source, id: `history:${n}`, at: new Date(Date.UTC(2026, 9, 30) - n * 1000).toISOString() }], cursor: n < 19 ? String(n + 1) : null };
  };
  let state = await advanceWithdrawalTimeline(emptyWithdrawalTimeline(), read);
  assert.equal(calls, 12);
  assert.equal(state.scanIncomplete, true);
  assert.equal(hasMoreWithdrawalTimeline(state), true);
  state = await advanceWithdrawalTimeline(state, read);
  assert.equal(state.items.length, 20);
  assert.equal(hasMoreWithdrawalTimeline(state), false);
});
