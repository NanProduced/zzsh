import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeListingFilterCount,
  listingFilterKey,
  listingFiltersUrl,
  listingQuery,
  normalizeListingQuery,
  parseListingFilters,
  toggleSkinId,
  withFilterChange,
} from '../src/lib/listing-filters.ts';

const base = parseListingFilters({});

test('listing filters accept only stable IDs, integer quantities and valid cursors', () => {
  const parsed = parseListingFilters({
    game: 'game_delta',
    item: 'item_haff',
    minQty: '20000000',
    skinId: ['skin_a', 'skin_a', 'bad skin', 'skin_b'],
    match: 'ALL',
    q: '  M4A1   金色 ',
    cursor: 'eyJpZCI6ImEifQ',
    limit: '3',
  });
  assert.deepEqual(parsed, {
    game: 'game_delta',
    item: 'item_haff',
    minQty: '20000000',
    skinIds: ['skin_a', 'skin_b'],
    match: 'ALL',
    q: 'M4A1 金色',
    cursor: 'eyJpZCI6ImEifQ',
    limit: 3,
  });
  const hostile = parseListingFilters({
    game: '../admin',
    item: 'item haff',
    minQty: '-1',
    skinId: 'skin\u0000x',
    match: 'SOME',
    q: '\u0000bad',
    cursor: 'not a cursor!',
    limit: '999',
  });
  assert.deepEqual(hostile, { game: null, item: null, minQty: null, skinIds: [], match: 'ANY', q: null, cursor: null, limit: 12 });
  assert.equal(normalizeListingQuery('   '), null);
});

test('server query uses contract names and only sends minQuantity with an item', () => {
  const withoutItem = listingQuery({ ...base, minQty: '100' });
  assert.equal(withoutItem.has('minQuantity'), false);
  const query = listingQuery({
    game: 'game_1',
    item: 'item_1',
    minQty: '100',
    skinIds: ['skin_a', 'skin_b'],
    match: 'ALL',
    q: 'local-search-only',
    cursor: 'cur_1',
    limit: 5,
  });
  assert.equal(query.toString(), 'gameId=game_1&itemId=item_1&minQuantity=100&skinId=skin_a&skinId=skin_b&skinMatch=ALL&q=local-search-only&limit=5&cursor=cur_1');
});

test('filter changes reset the cursor while pagination keeps it', () => {
  const paged = { ...base, skinIds: ['skin_a'], cursor: 'cur_1' };
  assert.equal(withFilterChange(paged, { skinIds: ['skin_a', 'skin_b'] }).cursor, null);
  assert.equal(listingFilterKey(paged), listingFilterKey({ ...paged, cursor: null }));
  assert.equal(listingFiltersUrl(paged).includes('cursor=cur_1'), true);
  assert.equal(listingFiltersUrl(withFilterChange(paged, { q: 'x' })).includes('cursor'), false);
  assert.equal(listingFiltersUrl(base), '/accounts');
});

test('server search is part of the request key and clears with the full filter set', () => {
  const q = '[SEC真实来源] 100%_';
  const paged = { ...base, q, cursor: 'cur_2' };
  const query = listingQuery(paged);
  assert.equal(query.get('q'), q);
  assert.equal(listingFilterKey(paged), listingFilterKey({ ...paged, cursor: null }));
  assert.deepEqual(withFilterChange(paged, { q: null }), { ...base, q: null, cursor: null });
});

test('skin toggles stay stable and filter count reflects active server filters', () => {
  const first = toggleSkinId(base, 'skin_a');
  assert.deepEqual(first.skinIds, ['skin_a']);
  assert.deepEqual(toggleSkinId(first, 'skin_a').skinIds, []);
  assert.equal(activeListingFilterCount({ ...base, item: 'item_1', minQty: '5', skinIds: ['skin_a'], q: 'x' }), 4);
  assert.equal(activeListingFilterCount({ ...base, minQty: '5' }), 0);
});
