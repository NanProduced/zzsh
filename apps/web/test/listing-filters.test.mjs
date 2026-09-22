import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeListingFilterCount,
  buildServiceWindow,
  describeServiceWindow,
  formatServiceWindowMinute,
  listingFilterKey,
  listingFiltersUrl,
  listingQuery,
  normalizeListingQuery,
  parseListingFilters,
  reconcileListingFilters,
  resourceInputFromBase,
  resourceInputToBase,
  resourceItemDisplayName,
  resourceUnitHint,
  resourceUnitShort,
  validateResourceQuantityInput,
  toggleSkinId,
  regionProvinceSelectionState,
  toggleRegionSelection,
  withFilterChange,
} from '../src/lib/listing-filters.ts';

const metadata = {
  available: true,
  reasonCode: null,
  gameId: 'game_delta',
  queryVersion: 2,
  resourceQuantityRange: true,
  filterRevision: '4',
  catalogRevision: '9',
  ruleReleaseId: 'release_1',
  defaultSort: { sort: 'latest', direction: 'DESC', label: '最新发布' },
  fields: [
    { key: 'resources', operator: 'MIN', label: '资源', enabled: true, order: 1, items: [{ itemId: 'item_haff', min: '0', max: '999999999999999999999999' }] },
    { key: 'safeBoxCodes', operator: 'IN', label: '安全箱', enabled: true, order: 2, options: [{ value: 'safe_1', label: '基础安全箱' }] },
    { key: 'gradingCodes', operator: 'IN', label: '段位', enabled: true, order: 3, options: [{ value: 'grade_1', label: '青铜' }] },
    { key: 'loginMethodCodes', operator: 'IN', label: '登录方式', enabled: true, order: 4, options: [{ value: 'login_1', label: '微信扫码' }] },
    { key: 'vitality', operator: 'MIN', label: '体力', enabled: true, order: 5, levels: [4, 5, 6] },
    { key: 'bear', operator: 'MIN', label: '负重', enabled: true, order: 6, levels: [4, 5, 6] },
    { key: 'regions', operator: 'IN', label: '地区', enabled: true, order: 7, regions: [{ province: '省', city: '市' }] },
    { key: 'serviceWindow', operator: 'OVERLAPS', label: '在线时间', enabled: true, order: 8 },
    { key: 'skinGroups', operator: 'GROUPED', label: '皮肤', enabled: true, order: 9, categoryIds: ['category_agent'] },
  ],
  sorts: [
    { key: 'latest', label: '最新发布', enabled: true, order: 1 },
    { key: 'resourceTotal', label: '资源报价金额', enabled: true, order: 2 },
    { key: 'coreQuantity', label: '核心资源数量', enabled: true, order: 3, itemIds: ['item_haff'] },
    { key: 'value', label: '综合性价比', enabled: false, order: 4 },
  ],
  directions: ['ASC', 'DESC'],
  items: [{ id: 'item_haff', code: 'haff', name: '哈夫币', unit: 'HAFF_BASE' }],
  categories: [{ id: 'category_agent', parentId: null, name: '干员皮肤' }],
  skinCatalogUrl: '/api/supply/games/game_delta/catalog',
  limits: { urlBytes: 8192, resources: 16, skinGroups: 8, skinIds: 50, enumValues: 50, regions: 20, limit: 50, scanBudget: 200 },
  livePages: true,
};

const base = parseListingFilters({});

test('resource display names prefer stable codes and gate legacy names to Delta context', () => {
  assert.equal(resourceItemDisplayName({ code: 'df_billable_level6_bullet', name: '六级子弹' }), '6级子弹');
  assert.equal(resourceItemDisplayName({ code: 'different_resource', name: '六级子弹' }, { gameCode: 'delta' }), '六级子弹');
  assert.equal(resourceItemDisplayName({ name: '六级子弹' }, { gameCode: 'delta' }), '6级子弹');
  assert.equal(resourceItemDisplayName({ name: '六级子弹' }), '六级子弹');
  assert.equal(resourceItemDisplayName(undefined), '未确认');
  assert.equal(resourceItemDisplayName({ code: 'unknown_resource' }), '未确认');
});

test('URL state is normalized and v2 query includes metadata revisions and supported semantics', () => {
  const parsed = parseListingFilters({
    game: 'game_delta',
    filters: JSON.stringify({
      resources: [{ itemId: 'item_haff', minQuantity: '20000000' }],
      skinGroups: [{ categoryId: 'category_agent', ids: ['skin_a', 'skin_a', 'bad skin', 'skin_b'], match: 'ALL' }],
    }),
    sort: 'coreQuantity',
    direction: 'ASC',
    coreItemId: 'item_haff',
    q: '  M4A1   金色 ',
    cursor: 'eyJpZCI6ImEifQ',
    limit: '3',
    view: 'grid',
  });
  assert.deepEqual(parsed, {
    game: 'game_delta',
    filters: {
      resources: [{ itemId: 'item_haff', minQuantity: '20000000' }],
      skinGroups: [{ categoryId: 'category_agent', ids: ['skin_a', 'skin_b'], match: 'ALL' }],
    },
    q: 'M4A1 金色', sort: 'coreQuantity', direction: 'ASC', coreItemId: 'item_haff',
    cursor: 'eyJpZCI6ImEifQ', limit: 3, viewMode: 'grid',
  });
  const query = listingQuery(parsed, metadata);
  assert.equal(query.get('queryVersion'), '2');
  assert.equal(query.get('filterRevision'), '4');
  assert.equal(query.get('catalogRevision'), '9');
  assert.equal(query.get('ruleReleaseId'), 'release_1');
  assert.deepEqual(JSON.parse(query.get('filters')), parsed.filters);
  assert.equal(query.get('sort'), 'coreQuantity');
  assert.equal(query.get('coreItemId'), 'item_haff');
  assert.equal(query.get('cursor'), parsed.cursor);
  assert.equal(query.get('minQuantity'), null);
  assert.equal(normalizeListingQuery('   '), null);
});

test('filter changes replace state and clear cursor; presentation mode does not affect the API key', () => {
  const paged = { ...base, game: 'game_delta', filters: { skinGroups: [{ categoryId: 'category_agent', ids: ['skin_a'], match: 'ANY' }] }, cursor: 'cur_1' };
  assert.equal(withFilterChange(paged, { q: 'M4' }).cursor, null);
  assert.equal(listingFilterKey(paged, metadata), listingFilterKey({ ...paged, cursor: null, viewMode: 'grid' }, metadata));
  assert.equal(listingFiltersUrl(paged).includes('cursor=cur_1'), true);
  assert.equal(listingFiltersUrl(withFilterChange(paged, { q: 'M4' })).includes('cursor'), false);
  assert.equal(listingFiltersUrl(base), '/accounts');
  assert.equal(listingFiltersUrl({ ...base, viewMode: 'grid' }), '/accounts?view=grid');
});

test('resource bounds normalize as inclusive min/max strings and remain cursor-bound', () => {
  const inputs = [
    { itemId: 'item_haff', minQuantity: '0' },
    { itemId: 'item_haff', maxQuantity: '9007199254740993' },
    { itemId: 'item_haff', minQuantity: '9007199254740993', maxQuantity: '9007199254740993' },
  ];
  for (const resource of inputs) {
    const parsed = parseListingFilters({ filters: JSON.stringify({ resources: [resource] }) });
    assert.deepEqual(parsed.filters.resources, [resource]);
    assert.deepEqual(JSON.parse(listingQuery({ ...parsed, game: 'game_delta' }, metadata).get('filters')), { resources: [resource] });
  }
  const lower = { ...base, game: 'game_delta', filters: { resources: [{ itemId: 'item_haff', minQuantity: '10' }] } };
  const bounded = { ...lower, filters: { resources: [{ itemId: 'item_haff', minQuantity: '10', maxQuantity: '20' }] } };
  assert.notEqual(listingFilterKey(lower, metadata), listingFilterKey(bounded, metadata));
  assert.deepEqual(parseListingFilters({ filters: JSON.stringify({ resources: [{ itemId: 'item_haff' }, { itemId: 'item_haff', minQuantity: '', maxQuantity: '2' }, { itemId: 'item_haff', minQuantity: '3', maxQuantity: '2' }] }) }).filters, {});
});

test('invalid URL values are ignored, while URL query conditions survive JSON encoding', () => {
  const hostile = parseListingFilters({
    game: '../admin', filters: '{"safeBoxCodes":["bad value"],"vitality":{"min":999}}',
    q: '\u0000bad', cursor: 'not a cursor!', limit: '999', view: 'tile',
  });
  assert.deepEqual(hostile, { ...base });
  const q = '[SEC真实来源] 100%_';
  const paged = { ...base, game: 'game_delta', q, cursor: 'cur_2' };
  assert.equal(listingQuery(paged).get('q'), q);
  assert.equal(listingFilterKey(paged), listingFilterKey({ ...paged, cursor: null }));
  assert.deepEqual(withFilterChange(paged, { q: null }), { ...paged, q: null, cursor: null });
});

test('skin groups preserve ANY/ALL, toggle by category, and count real conditions', () => {
  const first = toggleSkinId(base, 'category_agent', 'skin_a');
  assert.deepEqual(first.filters.skinGroups, [{ categoryId: 'category_agent', ids: ['skin_a'], match: 'ANY' }]);
  assert.deepEqual(toggleSkinId(first, 'category_agent', 'skin_a').filters.skinGroups, undefined);
  const active = {
    ...base,
    filters: {
      resources: [{ itemId: 'item_haff', minQuantity: '5' }], safeBoxCodes: ['safe_1'],
      skinGroups: [{ categoryId: 'category_agent', ids: ['skin_a', 'skin_b'], match: 'ALL' }],
    }, q: 'x',
  };
  assert.equal(activeListingFilterCount(active), 5);
});

test('409 metadata reconciliation retains only still-enabled conditions and sorts', () => {
  const stale = {
    ...base,
    game: 'game_old', sort: 'value', coreItemId: 'removed', direction: 'SIDEWAYS',
    filters: {
      resources: [{ itemId: 'item_haff', minQuantity: '2' }, { itemId: 'removed', minQuantity: '3' }],
      safeBoxCodes: ['safe_1', 'removed'], gradingCodes: ['removed'], loginMethodCodes: ['login_1'],
      vitality: { min: 5 }, bear: { min: 7 }, regions: [{ province: '省', city: '市' }, { province: 'other', city: 'city' }],
      skinGroups: [
        { categoryId: 'category_agent', ids: ['skin_a', 'skin_gone'], match: 'ALL' },
        { categoryId: 'category_removed', ids: ['skin_b'], match: 'ANY' },
      ],
    }, cursor: 'cur_old',
  };
  const reconciled = reconcileListingFilters(stale, metadata, new Set(['skin_a']));
  assert.equal(reconciled.game, 'game_delta');
  assert.equal(reconciled.sort, 'latest');
  assert.equal(reconciled.direction, 'DESC');
  assert.equal(reconciled.coreItemId, null);
  assert.equal(reconciled.cursor, null);
  assert.deepEqual(reconciled.filters, {
    resources: [{ itemId: 'item_haff', minQuantity: '2' }], safeBoxCodes: ['safe_1'],
    loginMethodCodes: ['login_1'], vitality: { min: 5 }, regions: [{ province: '省', city: '市' }],
    skinGroups: [{ categoryId: 'category_agent', ids: ['skin_a'], match: 'ALL' }],
  });
});

test('resource reconciliation checks each supplied endpoint and drops unsupported upper bounds visibly', () => {
  const rangeMetadata = { ...metadata, items: [...metadata.items, { id: 'item_kit', code: 'kit', name: '道具', unit: 'PIECE' }], fields: metadata.fields.map((entry) => entry.key === 'resources' ? { ...entry, items: [...entry.items, { itemId: 'item_kit', min: '0', max: '10' }] } : entry) };
  const range = { ...base, game: 'game_delta', filters: { resources: [
    { itemId: 'item_haff', minQuantity: '2', maxQuantity: '3' },
    { itemId: 'item_kit', maxQuantity: '4' },
  ] } };
  assert.deepEqual(reconcileListingFilters(range, rangeMetadata).filters.resources, [
    { itemId: 'item_haff', minQuantity: '2', maxQuantity: '3' },
    { itemId: 'item_kit', maxQuantity: '4' },
  ]);
  const maxOnly = { ...range, filters: { resources: [{ itemId: 'item_kit', maxQuantity: '4' }] } };
  assert.deepEqual(reconcileListingFilters(maxOnly, rangeMetadata).filters.resources, [{ itemId: 'item_kit', maxQuantity: '4' }]);
  for (const rangeCapability of [false, undefined]) {
    const legacyMetadata = { ...rangeMetadata };
    if (rangeCapability === undefined) delete legacyMetadata.resourceQuantityRange;
    else legacyMetadata.resourceQuantityRange = rangeCapability;
    const minOnly = reconcileListingFilters(range, legacyMetadata);
    assert.deepEqual(minOnly.filters.resources, [{ itemId: 'item_haff', minQuantity: '2' }]);
    assert.notEqual(listingFiltersUrl(minOnly), listingFiltersUrl(range));
    assert.doesNotMatch(listingQuery(minOnly, legacyMetadata).get('filters') ?? '', /maxQuantity/);
    const unsupportedMaxOnly = reconcileListingFilters(maxOnly, legacyMetadata);
    assert.equal(unsupportedMaxOnly.filters.resources, undefined);
    assert.equal(listingQuery(unsupportedMaxOnly, legacyMetadata).has('filters'), false);
  }
});

test('province tri-state expands only configured cities and rejects over-budget selection atomically', () => {
  const regions = [
    ...Array.from({ length: 12 }, (_, index) => ({ province: '甲省', city: `甲市${index}` })),
    ...Array.from({ length: 10 }, (_, index) => ({ province: '乙省', city: `乙市${index}` })),
  ];
  const synthetic = { ...metadata, fields: metadata.fields.map((entry) => entry.key === 'regions' ? { ...entry, regions } : entry) };
  assert.equal(regionProvinceSelectionState([], '甲省', regions.slice(0, 12).map(({ city }) => city)), 'none');
  const first = toggleRegionSelection(base, '甲省', regions.slice(0, 12).map(({ city }) => city), synthetic, 'province');
  assert.equal(first.error, null);
  assert.equal(first.filters.filters.regions.length, 12);
  assert.equal(regionProvinceSelectionState([{ province: '甲省', city: '甲市0' }], '甲省', regions.slice(0, 12).map(({ city }) => city)), 'partial');
  const denied = toggleRegionSelection(first.filters, '乙省', regions.slice(12).map(({ city }) => city), synthetic, 'province');
  assert.match(denied.error, /最多可选 20 个地区/);
  assert.equal(denied.filters, first.filters);
  const removed = toggleRegionSelection(first.filters, '甲省', [], synthetic, 'city', '甲市0');
  assert.equal(removed.error, null);
  assert.equal(removed.filters.filters.regions.length, 11);
  const selectedThenCleared = toggleRegionSelection(first.filters, '甲省', regions.slice(0, 12).map(({ city }) => city), synthetic, 'province');
  assert.deepEqual(selectedThenCleared.filters.filters.regions, undefined);
  const tinyUrl = { ...synthetic, limits: { ...synthetic.limits, urlBytes: 10 } };
  const tooLong = toggleRegionSelection(base, '甲省', regions.slice(0, 1).map(({ city }) => city), tinyUrl, 'province');
  assert.match(tooLong.error, /筛选条件过长/);
  assert.equal(tooLong.filters, base);
});

test('display quantities convert exactly to API base units, including decimal M and 60-round groups', () => {
  const haff = { unit: 'HAFF_BASE', code: 'haff' };
  const bullets = { unit: 'ROUND', code: 'df_billable_level6_bullet' };
  assert.equal(resourceInputToBase('2.5', haff), '2500000');
  assert.equal(resourceInputFromBase('2500000', haff), '2.5');
  assert.equal(resourceInputToBase('3', bullets), '180');
  assert.equal(resourceInputFromBase('181', bullets), null);
  assert.equal(resourceInputFromBase('181', bullets, 'base'), '181');
  assert.throws(() => resourceInputToBase('0.01', bullets), /无法精确换算/);
});

test('resource unit labels stay explicit about contract units without fabricated defaults', () => {
  const haff = { unit: 'HAFF_BASE', code: 'haff' };
  const bullets = { unit: 'ROUND', code: 'df_billable_level6_bullet' };
  const days = { unit: 'DAY', code: 'term' };
  assert.equal(resourceUnitShort(haff), 'M');
  assert.equal(resourceUnitHint(haff), '1 M = 1,000,000 哈夫币');
  assert.equal(resourceUnitShort(bullets), '组');
  assert.equal(resourceUnitHint(bullets), '1 组 = 60 发');
  assert.equal(resourceUnitShort(days), '天');
  assert.equal(resourceUnitHint(days), null);
  assert.equal(resourceUnitShort(bullets, 'base'), '发');
  assert.equal(resourceUnitHint(bullets, 'base'), null);
});

test('service window builder enforces half-hour options, full-day and cross-midnight semantics', () => {
  assert.equal(formatServiceWindowMinute(0), '00:00');
  assert.equal(formatServiceWindowMinute(1410), '23:30');
  assert.equal(formatServiceWindowMinute(1440), '24:00');
  assert.deepEqual(buildServiceWindow(null, 120), { ok: false, reason: 'missing' });
  assert.deepEqual(buildServiceWindow(480, 480), { ok: false, reason: 'equal' });
  assert.deepEqual(buildServiceWindow(0, 0), { ok: false, reason: 'equal' });
  assert.deepEqual(buildServiceWindow(1439, 120), { ok: false, reason: 'missing' });
  assert.deepEqual(buildServiceWindow(0, 1440), {
    ok: true,
    value: { startMinute: 0, endMinute: 1440, crossMidnight: false, timezone: 'Asia/Shanghai' },
  });
  assert.deepEqual(buildServiceWindow(1320, 120), {
    ok: true,
    value: { startMinute: 1320, endMinute: 120, crossMidnight: true, timezone: 'Asia/Shanghai' },
  });
  assert.equal(describeServiceWindow({ startMinute: 0, endMinute: 1440, crossMidnight: false, timezone: 'Asia/Shanghai' }), '00:00–24:00（全天）');
  assert.equal(describeServiceWindow({ startMinute: 1320, endMinute: 120, crossMidnight: true, timezone: 'Asia/Shanghai' }), '22:00–02:00（跨日）');
  assert.equal(describeServiceWindow({ startMinute: 480, endMinute: 720, crossMidnight: false, timezone: 'Asia/Shanghai' }), '08:00–12:00');
});


test('resource input validates canonical integer text and exact display bounds', () => {
  const bullets = { unit: 'ROUND', code: 'df_billable_level6_bullet' };
  const bounds = { min: '61', max: '181' };
  assert.equal(validateResourceQuantityInput('2', bullets, bounds), '120');
  assert.equal(validateResourceQuantityInput('3', bullets, bounds), '180');
  for (const value of ['', '0', '1', '4', '02', '2.0', '2e0', '-2', ' 2', '2 ', '２', '1,000']) {
    assert.throws(() => validateResourceQuantityInput(value, bullets, bounds), /2 至 3 组/);
  }
  assert.equal(validateResourceQuantityInput('181', bullets, bounds, 'base'), '181');
  assert.equal(validateResourceQuantityInput('0', { unit: 'PIECE' }, { min: '0', max: '9' }), '0');
  assert.equal(validateResourceQuantityInput('999999999999999999999999', { unit: 'PIECE' }, { min: '0', max: '999999999999999999999999' }), '999999999999999999999999');
  assert.throws(() => validateResourceQuantityInput('1000000000000000000000000', { unit: 'PIECE' }, { min: '0', max: '999999999999999999999999' }));
});
