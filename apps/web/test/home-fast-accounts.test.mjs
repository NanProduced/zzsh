import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFastAccounts } from '../src/lib/home-fast-accounts.ts';

const project = listing => ({ id: listing.id, rentalMode: listing.rentalMode });
const page = (items, nextCursor = null) => ({ items, nextCursor });
const listing = (id, rentalMode = 'ordinary') => ({ id, rentalMode });

test('home fast shelf follows cursor pages until a fast account is found', async () => {
  const seen = [];
  const result = await collectFastAccounts(async cursor => {
    seen.push(cursor);
    if (cursor === null) return page([listing('ordinary-1')], 'cursor-2');
    if (cursor === 'cursor-2') return page([listing('ordinary-2')], 'cursor-3');
    return page([listing('fast-3', 'fast')]);
  }, project);
  assert.deepEqual(seen, [null, 'cursor-2', 'cursor-3']);
  assert.deepEqual(result.accounts.map(item => item.id), ['fast-3']);
  assert.equal(result.hasMore, false);
});

test('home fast shelf does not claim exhaustion when the bounded read limit is reached', async () => {
  let reads = 0;
  const result = await collectFastAccounts(async cursor => {
    reads += 1;
    return page([listing(`ordinary-${reads}`)], `cursor-${reads + 1}`);
  }, project, 2);
  assert.equal(reads, 2);
  assert.deepEqual(result.accounts, []);
  assert.equal(result.hasMore, true);
});

test('home fast shelf stops after the display limit without reading an unnecessary page', async () => {
  let reads = 0;
  const result = await collectFastAccounts(async () => {
    reads += 1;
    return page(Array.from({ length: 8 }, (_, index) => listing(`fast-${index}`, 'fast')), 'next');
  }, project);
  assert.equal(reads, 1);
  assert.equal(result.accounts.length, 8);
  assert.equal(result.hasMore, true);
});
