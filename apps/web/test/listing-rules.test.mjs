import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeListingFilterCount,
  resolveSkinOwner,
  buildServiceWindow,
  describeServiceWindow,
  formatServiceWindowMinute,
  listingFilterKey,
  listingFiltersUrl,
  listingQuery,
  listingUrlRejectedValues,
  listingRequestBudget,
  listingRequestTargets,
  normalizeListingQuery,
  parseListingFilters,
  reconcileListingFilters,
  resourceInputFromBase,
  resourceInputToBase,
  resourceItemDisplayName,
  resourceUnitHint,
  resourceUnitShort,
  resourceUnitLabel,
  validateResourceQuantityInput,
  toggleSkinId,
  skinGroupOptions,
  regionProvinceSelectionState,
  toggleRegionSelection,
  withFilterChange,
} from '../src/lib/listing-filters.ts';

test('both registered six-round aliases convert once while other ammunition and insurance keep their base units',()=>{
  for(const code of ['level6_round','df_billable_level6_bullet']) {
    const item={code,unit:'ROUND'};
    assert.equal(resourceInputToBase('2',item),'120');
    assert.equal(resourceInputFromBase('120',item),'2');
    assert.equal(validateResourceQuantityInput('0',item,{min:'0',max:'120'}),'0');
    assert.equal(resourceInputToBase('120',item,'base'),'120');
    assert.equal(resourceUnitShort(item),'组');
  }
  for(const code of ['awm_round','df_billable_awm_bullet','df_billable_barrett_bullet']) assert.equal(resourceInputToBase('2',{code,unit:'ROUND'}),'2');
  assert.equal(resourceUnitLabel('PIECE','top_insure_card_piece'),'张');
  assert.equal(resourceUnitLabel('DAY','top_insure_card_piece'),'天');
  assert.equal(resourceUnitLabel('PIECE','coffee'),'件');
  assert.equal(resourceUnitLabel('PIECE','df_billable_turtle_backpack_45'),'个');
  assert.equal(resourceInputToBase('3',{code:'df_billable_turtle_backpack_45',unit:'PIECE'}),'3');
});

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

test('type-based skin filters keep their meaning through selection, URL and reconciliation', () => {
  const typeField = { key: 'skinGroups', operator: 'GROUPED', label: '皮肤', enabled: true, order: 9, ownerKinds: ['AGENT', 'FIREARM', 'MELEE_TYPE'] };
  const typedMetadata = { ...metadata, skinGrouping: 'TYPE', categories: [], fields: metadata.fields.map(field => field.key === 'skinGroups' ? typeField : field) };
  assert.deepEqual(skinGroupOptions(typeField, null).map(item => item.name), ['干员外观', '枪械外观', '近战外观']);
  const selected = toggleSkinId({ ...base, game: 'game_delta' }, 'MELEE_TYPE', 'skin_melee');
  assert.deepEqual(selected.filters.skinGroups, [{ ownerKind: 'MELEE_TYPE', ids: ['skin_melee'], match: 'ANY' }]);
  const parsed = parseListingFilters(Object.fromEntries(new URL(listingFiltersUrl(selected), 'https://example.test').searchParams));
  assert.deepEqual(parsed.filters.skinGroups, selected.filters.skinGroups);
  assert.deepEqual(reconcileListingFilters(parsed, typedMetadata).filters.skinGroups, selected.filters.skinGroups);
  const legacy = toggleSkinId({ ...base, game: 'game_delta' }, 'category_agent', 'skin_agent');
  assert.equal(reconcileListingFilters(legacy, typedMetadata).filters.skinGroups, undefined);
});


test('resource display names prefer stable codes and gate legacy names to Delta context', () => {
  assert.equal(resourceItemDisplayName({ code: 'df_billable_level6_bullet', name: '六级子弹' }), '6级子弹');
  assert.equal(resourceItemDisplayName({ code: 'df_billable_level6_helmet', name: '六级头盔' }), '6级头盔');
  assert.equal(resourceItemDisplayName({ code: 'df_billable_level6_armor', name: '六级护甲' }), '6级护甲');
  assert.equal(resourceItemDisplayName({ code: 'different_resource', name: '六级子弹' }, { gameCode: 'delta' }), '6级子弹');
  assert.equal(resourceItemDisplayName({ name: '六级子弹' }, { gameCode: 'delta' }), '6级子弹');
  assert.equal(resourceItemDisplayName({ name: '六级头盔' }, { gameCode: 'delta' }), '6级头盔');
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
  assert.equal(listingFiltersUrl(paged).includes('cursor=cur_1'), false);
  assert.equal(listingFiltersUrl(withFilterChange(paged, { q: 'M4' })).includes('cursor'), false);
  assert.equal(listingFiltersUrl(base), '/accounts');
  assert.equal(listingFiltersUrl({ ...base, viewMode: 'grid' }), '/accounts?view=grid');
  assert.equal(listingFiltersUrl({ ...paged, coreItemId: 'item_haff' }).includes('coreItemId'), false);
  assert.equal(listingFiltersUrl({ ...paged, sort: 'coreQuantity', coreItemId: 'item_haff', limit: 3 }).includes('limit='), false);
});

test('share URL canonicalizes unordered condition collections', () => {
  const first = { ...base, game: 'game_delta', filters: {
    resources: [{ itemId: 'item_haff', minQuantity: '2' }],
    safeBoxCodes: ['safe_2', 'safe_1'],
    regions: [{ province: '乙省', city: '乙市' }, { province: '甲省', city: '甲市' }],
    skinGroups: [{ categoryId: 'category_agent', ids: ['skin_b', 'skin_a'], match: 'ALL' }],
  } };
  const second = { ...first, filters: {
    resources: [{ itemId: 'item_haff', minQuantity: '2' }],
    safeBoxCodes: ['safe_1', 'safe_2'],
    regions: [{ province: '甲省', city: '甲市' }, { province: '乙省', city: '乙市' }],
    skinGroups: [{ categoryId: 'category_agent', ids: ['skin_a', 'skin_b'], match: 'ALL' }],
  } };
  assert.equal(listingFiltersUrl(first), listingFiltersUrl(second));
});

test('listing URL budget guards every real GET prefix, not only the share page', () => {
  const conditions = {
    resources: Array.from({ length: 16 }, (_, index) => ({
      itemId: `item_${String(index).padStart(3, '0')}${'x'.repeat(90)}`,
      minQuantity: '1',
      maxQuantity: '999999999999999999999999',
    })),
    skinGroups: [{
      categoryId: 'category_1',
      match: 'ALL',
      ids: Array.from({ length: 33 }, (_, index) => `skin_${String(index).padStart(3, '0')}${'x'.repeat(118)}`),
    }],
  };
  const longMetadata = { ...metadata, filterRevision: '123', catalogRevision: '456', ruleReleaseId: `release_${'r'.repeat(90)}` };
  const filters = parseListingFilters({ game: 'game_delta', filters: JSON.stringify(conditions) });
  const targets = listingRequestTargets(filters, longMetadata, null);

  assert.deepEqual(targets.map(({ kind, bytes }) => ({ kind, bytes })), [
    { kind: 'page', bytes: 8005 },
    { kind: 'webBff', bytes: 8221 },
    { kind: 'apiBff', bytes: 8230 },
    { kind: 'api', bytes: 8224 },
  ]);
  assert.equal(listingRequestBudget(filters, longMetadata, null)?.kind, 'webBff');
  assert.equal(filters.filters.resources.length, 16);
  assert.equal(filters.filters.skinGroups[0].ids.length, 33);
  assert.equal(listingRequestBudget({ ...filters, filters: {} }, longMetadata, null), null);
  const nextPage = listingRequestTargets({ ...filters, cursor: 'cursor_' + 'x'.repeat(1000) }, longMetadata, 'cursor_' + 'x'.repeat(1000));
  assert.equal(nextPage.find(({ kind }) => kind === 'webBff').bytes > 8192, true);
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

test('normalizing a URL only warns when a recognizable value was actually rejected', () => {
  // 静默规范化：补默认游戏、补默认排序、省掉与默认值相同的 direction、忽略无法识别的多余 query。
  assert.deepEqual(listingUrlRejectedValues({}, parseListingFilters({})), []);
  assert.deepEqual(listingUrlRejectedValues({ game: 'game_4a3eebc1f36f40a5bbadc97e44f5023b' }, parseListingFilters({ game: 'game_4a3eebc1f36f40a5bbadc97e44f5023b' })), []);
  assert.deepEqual(listingUrlRejectedValues({ sort: 'latest' }, parseListingFilters({ sort: 'latest' })), []);
  assert.deepEqual(listingUrlRejectedValues({ direction: 'DESC' }, parseListingFilters({ direction: 'DESC' })), []);
  assert.deepEqual(listingUrlRejectedValues({ direction: 'ASC' }, parseListingFilters({ direction: 'ASC' })), []);
  assert.deepEqual(listingUrlRejectedValues({ q: 'awm' }, parseListingFilters({ q: 'awm' })), []);
  assert.deepEqual(listingUrlRejectedValues({ unknownParam: 'x', cursor: 'not-a-cursor' }, parseListingFilters({ unknownParam: 'x', cursor: 'not-a-cursor' })), []);

  // 真的被拒绝/改写：形状非法的 sort、非法 direction、非法 game、空 q、无法解析的 filters。
  // 注意：形状合法但服务端未启用的 sort（如 'bogus'）由 reconcileListingFilters 依 metadata
  // 收敛，走 changed 分支的另一条提示，不归本函数判定。
  assert.deepEqual(listingUrlRejectedValues({ sort: '!!' }, parseListingFilters({ sort: '!!' })), ['sort']);
  assert.deepEqual(listingUrlRejectedValues({ sort: 'a'.repeat(65) }, parseListingFilters({ sort: 'a'.repeat(65) })), ['sort']);
  assert.deepEqual(listingUrlRejectedValues({ sort: 'bogus' }, parseListingFilters({ sort: 'bogus' })), []);
  assert.deepEqual(listingUrlRejectedValues({ direction: 'sideways' }, parseListingFilters({ direction: 'sideways' })), ['direction']);
  assert.deepEqual(listingUrlRejectedValues({ game: '!!' }, parseListingFilters({ game: '!!' })), ['game']);
  assert.deepEqual(listingUrlRejectedValues({ q: '   ' }, parseListingFilters({ q: '   ' })), ['q']);
  assert.deepEqual(listingUrlRejectedValues({ filters: 'not-json' }, parseListingFilters({ filters: 'not-json' })), ['filters']);
  assert.deepEqual(listingUrlRejectedValues({ filters: '{"regions":[]}' }, parseListingFilters({ filters: '{"regions":[]}' })), ['filters']);
  assert.deepEqual(listingUrlRejectedValues({ sort: '!!', direction: 'sideways' }, parseListingFilters({ sort: '!!', direction: 'sideways' })), ['sort', 'direction']);
});

test('skin owner stays scoped to the active category kind', () => {
  const owners = [{ id: 'owner_agent', kind: 'AGENT' }, { id: 'owner_firearm', kind: 'FIREARM' }];
  assert.equal(resolveSkinOwner(owners, 'owner_agent', 'AGENT'), 'owner_agent');
  assert.equal(resolveSkinOwner(owners, 'owner_agent', 'MELEE_TYPE'), '', '近战类别在 2108 后没有 owner，重读回落时不得继续带旧 ownerId');
  assert.equal(resolveSkinOwner(owners, 'owner_agent', 'FIREARM'), '');
  assert.equal(resolveSkinOwner(owners, 'owner_agent', null), 'owner_agent', '旧类别无 ownerKind 时保持原行为');
  assert.equal(resolveSkinOwner(owners, '', 'AGENT'), '');
  assert.equal(resolveSkinOwner(undefined, 'owner_agent', 'AGENT'), '');
});

test('ratio sort and tactical core items serialize and reconcile correctly', () => {
  const multiSortMetadata = {
    ...metadata,
    sorts: [
      ...metadata.sorts.filter(s => s.key !== 'coreQuantity'),
      { key: 'coreQuantity', label: '核心资源数量', enabled: true, order: 3, itemIds: ['item_haff', 'item_awm', 'item_helmet', 'item_armor'] },
      { key: 'ratio', label: '比例排序', enabled: true, order: 5, itemIds: ['item_haff'] },
    ],
    items: [
      ...metadata.items,
      { id: 'item_awm', code: 'awm_round', name: 'AWM子弹', unit: 'ROUND' },
      { id: 'item_helmet', code: 'level6_helmet', name: '6级头盔', unit: 'PIECE' },
      { id: 'item_armor', code: 'level6_armor', name: '6级护甲', unit: 'PIECE' },
    ],
  };

  const ratioFilters = { ...base, game: 'game_delta', sort: 'ratio', coreItemId: 'item_haff', direction: 'DESC' };
  const ratioQuery = listingQuery(ratioFilters, multiSortMetadata);
  assert.equal(ratioQuery.get('sort'), 'ratio');
  assert.equal(ratioQuery.get('coreItemId'), 'item_haff');
  assert.equal(ratioQuery.get('direction'), 'DESC');
  assert.equal(listingFiltersUrl(ratioFilters), '/accounts?game=game_delta&sort=ratio&coreItemId=item_haff');

  const tacticalFilters = { ...base, game: 'game_delta', sort: 'coreQuantity', coreItemId: 'item_awm', direction: 'ASC' };
  const tacticalQuery = listingQuery(tacticalFilters, multiSortMetadata);
  assert.equal(tacticalQuery.get('sort'), 'coreQuantity');
  assert.equal(tacticalQuery.get('coreItemId'), 'item_awm');
  assert.equal(tacticalQuery.get('direction'), 'ASC');
  assert.equal(listingFiltersUrl(tacticalFilters), '/accounts?game=game_delta&sort=coreQuantity&direction=ASC&coreItemId=item_awm');

  const reconciled = reconcileListingFilters(ratioFilters, multiSortMetadata);
  assert.equal(reconciled.sort, 'ratio');
  assert.equal(reconciled.coreItemId, 'item_haff');
});


/* --- Listing View Presentation Rules --- */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as listingFilters from '../src/lib/listing-filters.ts';
import {
  conditionLines,
  detailBreadcrumbs,
  formatMoneyLabel,
  haffRatioLabel,
  haffMillionsLabel,
  termLabel,
  listingResourceLinesLabel,
  publicAvailabilityLabel,
  resourceQuantityLabel,
  toListingCard,
  toListingDetail,
  unitLabel,
} from '../src/lib/listing-view.ts';

const listing = {
  id: 'account_1',
  displayNo: 'A-001',
  versionId: 'version_1',
  title: '三角洲资源账号',
  description: '合成公开说明',
  attributes: { safe_box_code: 'safe_box_3x3', vit_level: 6, bear_level: null, grading_code: '6', login_method_code: 'legacy_login_wechat', region_province: '广东省', secret_kd: '1.20', service_window_start_minute: 540, service_window_end_minute: 1380 },
  safeBox: { code: 'safe_box_3x3', displayName: '顶级安全箱(3*3)' },
  termOption: { code: 'daily-10m', displayName: '日消耗 10M', dailyConsumption: { quantity: '10000000', unit: 'HAFF_BASE' } },
  attributeDisplay: {
    safeBox: { code: 'safe_box_3x3', displayName: '顶级安全箱(3*3)', mappingStatus: 'CONFIRMED', issueCode: null },
    grading: { code: '6', displayName: '钻石', mappingStatus: 'CONFIRMED', issueCode: null },
    loginMethod: { code: 'legacy_login_wechat', displayName: '微信扫码', mappingStatus: 'CONFIRMED', issueCode: null },
    serviceWindow: { startMinute: 540, endMinute: 1380, displayName: '09:00–23:00' },
  },
  presentation: {
    items: [{ id: 'item_haff', name: '哈夫币', unit: 'HAFF_BASE' }],
    skins: [{ id: 'skin_1', name: 'M4A1 金色', categoryName: '武器' }],
    entitlements: [],
  },
  quote: {
    schemaVersion: 1,
    currency: 'CNY',
    ruleReleaseId: 'release_1',
    lines: [{ itemId: 'item_haff', quantity: '60000000', unit: 'HAFF_BASE', unitQuantity: '1', buyerUnitAmount: { currency: 'CNY', unit: 'yuan', amount: '0.00000250', scale: 8 }, buyerAmount: { currency: 'CNY', unit: 'yuan', amount: '150.00', scale: 2 } }],
    resourceTotal: { currency: 'CNY', unit: 'yuan', amount: '150.00', scale: 2 },
    tenantDeposit: null,
    tenantPayableTotal: null,
    termSeconds: String(6 * 86400),
    expiryDisclosures: [],
    unitAmountsInformational: true,
  },
  media: [
    { assetId: 'asset_b', position: 1, url: '/api/supply/listings/account_1/media/asset_b' },
    { assetId: 'asset_a', position: 0, url: '/api/supply/listings/account_1/media/asset_a' },
  ],
};

test('money, quantity and term formatting stay on server values', () => {
  assert.equal(formatMoneyLabel({ currency: 'CNY', unit: 'yuan', amount: '150.00', scale: 2 }), '¥150.00');
  assert.equal(formatMoneyLabel(null), null);
  assert.equal(haffMillionsLabel('60000000'), '60');
  assert.equal(haffMillionsLabel('1500000'), '1.5');
  assert.equal(haffMillionsLabel('500000'), '0.5');
  assert.equal(termLabel(String(6 * 86400)), '6 天');
  assert.equal(termLabel(String(36 * 3600)), '1.5 天');
  assert.equal(termLabel(undefined), '以平台确认的租期为准');
  assert.equal(unitLabel('HAFF_BASE'), '哈夫币');
  assert.equal(unitLabel('ROUND'), '发');
  assert.equal(unitLabel('DAY'), '天');
  assert.equal(unitLabel('CUSTOM'), 'CUSTOM');
});

test('card view uses presentation names, public conditions and server totals', () => {
  const card = toListingCard(listing);
  assert.equal(card.id, 'account_1');
  assert.equal(card.resourceTotalLabel, '¥150.00');
  assert.equal(card.haffRentLabel, '¥150.00');
  // Haff-only quote has an explicitly known zero item subtotal.
  assert.equal(card.itemResourceTotalLabel, '¥0.00');
  assert.equal(card.depositLabel, null);
  assert.equal(card.payableTotalLabel, null);
  assert.equal(card.termLabel, '6 天');
  assert.deepEqual(card.resourceLines, [{ itemId: 'item_haff', mediaId: null, code: null, name: '哈夫币', quantity: '60000000', quantityLabel: '60 M', unitLabel: '哈夫币', costAmount: '150.00', costLabel: '¥150.00', unitPriceLabel: '< ¥0.01 / 1 哈夫币' }]);
  assert.deepEqual(card.skinNames, ['M4A1 金色']);
  assert.deepEqual(card.skinLabels, ['武器 · M4A1 金色']);
  assert.deepEqual(card.conditionLines.map((line) => line.key), ['safe_box_code', 'vit_level', 'grading_code', 'login_method_code', 'region_province', 'secret_kd', 'service_window', 'term_option', 'daily_consumption']);
  assert.equal(card.conditionLines[0].value, '顶级安全箱(3*3)');
  assert.equal(card.conditionLines[2].value, '钻石');
  assert.equal(card.conditionLines[3].value, '微信扫码');
  assert.equal(card.loginMethod?.displayName, '微信扫码');
  assert.equal(card.conditionLines[6].value, '09:00–23:00');
  assert.equal(listingResourceLinesLabel(card), '60 M 哈夫币');
  assert.equal(haffRatioLabel('60000000', '150.00'), '40万/元');
  assert.equal(haffRatioLabel('60000000', null), '待确认');
  const largeQuantity = (9007199254740992n / 20000n) * 20000n + 9999n;
  assert.equal(haffRatioLabel(largeQuantity.toString(), '2.00'), `${(largeQuantity + 10000n) / 20000n}万/元`);
  assert.equal(card.imageUrl, '/api/supply/listings/account_1/media/asset_a');
  const detail = toListingDetail(listing);
  assert.deepEqual(detail.media.map((media) => media.assetId), ['asset_a', 'asset_b']);
  assert.equal(detail.description, '合成公开说明');
  assert.equal(detail.gameName, null);
  const withGame = toListingDetail({ ...listing, game: { id: 'game_1', code: 'delta', name: '三角洲行动' } });
  assert.equal(withGame.gameName, '三角洲行动');
  assert.deepEqual(detailBreadcrumbs(withGame.gameName), [
    { label: '首页', href: '/' },
    { label: '三角洲行动' },
    { label: '租账号', href: '/accounts' },
    { label: '账号详情' },
  ]);
});

test('market uses the small CDN cover, details use the full variant, and missing CDN data stays compatible', () => {
  const coverUrl = 'https://listing-images.example.com/public/listing/a/asset_a/cdn_v/640.webp';
  const detailUrl = 'https://listing-images.example.com/public/listing/a/asset_a/cdn_v/1920.webp';
  const distributed = { ...listing, media: [listing.media[0], { ...listing.media[1], coverUrl, detailUrl }] };
  assert.equal(toListingCard(distributed).imageUrl, coverUrl);
  const detail = toListingDetail(distributed);
  assert.equal(detail.media[0].url, detailUrl);
  assert.equal(detail.media[0].coverUrl, coverUrl);
  assert.equal(detail.media[1].url, listing.media[0].url);
});

test('legacy CDN image loads directly while a confirmed missing slot keeps its migration status', () => {
  const cdnUrl = 'https://listing-images.example.com/public/legacy/cdn_v/accountsImage/20261112/showcase.png';
  const legacy = { ...listing, media: [], legacyImages: [
    { position: 0, url: '/api/supply/listings/account_1/legacy-images/0', cdnUrl },
    { position: 1, url: '/api/supply/listings/account_1/legacy-images/1', state: 'PENDING_IMPORT' },
  ] };
  const card = toListingCard(legacy);
  assert.equal(card.imageUrl, cdnUrl);
  assert.equal(card.media[0].legacy, undefined);
  assert.equal(card.media[1].legacy, true);
  assert.equal(card.media[1].legacyState, 'PENDING_IMPORT');
});

test('detail breadcrumb stays generic without a server-confirmed game', () => {
  for (const value of [null, undefined, '']) {
    assert.deepEqual(detailBreadcrumbs(value), [
      { label: '首页', href: '/' },
      { label: '租账号', href: '/accounts' },
      { label: '账号详情' },
    ]);
  }
});

test('condition lines skip absent fields and keep unknown keys out', () => {
  assert.deepEqual(conditionLines({ vit_level: null, bear_level: '', grading_code: undefined }), []);
  assert.equal(JSON.stringify(conditionLines({ vit_level: 7 })).includes('safe'), false);
  assert.equal(conditionLines({ grading_code: 'future', login_method_code: 'steam_cn' })[0].value, '未确认');
  assert.equal(conditionLines({ grading_code: 'future', login_method_code: 'steam_cn' })[1].value, '未确认');
});

test('resource labels use catalog code and quoted unit quantity', () => {
  const detail = toListingCard({
    ...listing,
    presentation: {
      ...listing.presentation,
      items: [
        ...listing.presentation.items,
        { id: 'item_bullet', code: 'df_billable_level6_bullet', name: '六级子弹', unit: 'ROUND' },
        { id: 'item_card', code: 'df_billable_top_insure_card', name: '顶级保险体验卡', unit: 'DAY' },
      ],
    },
    quote: {
      ...listing.quote,
      lines: [
        ...listing.quote.lines,
        { itemId: 'item_bullet', quantity: '180', unit: 'ROUND', unitQuantity: '60', buyerUnitAmount: { currency: 'CNY', unit: 'yuan', amount: '10.00000000', scale: 8 }, buyerAmount: { currency: 'CNY', unit: 'yuan', amount: '30.00', scale: 2 } },
        { itemId: 'item_card', quantity: '3', unit: 'DAY', unitQuantity: '1', buyerUnitAmount: { currency: 'CNY', unit: 'yuan', amount: '5.00000000', scale: 8 }, buyerAmount: { currency: 'CNY', unit: 'yuan', amount: '15.00', scale: 2 } },
      ],
    },
  });
  assert.equal(detail.resourceLines[1].code, 'df_billable_level6_bullet');
  assert.equal(detail.resourceLines[1].name, '6级子弹');
  assert.equal(detail.resourceLines[1].quantityLabel, '3组（180发）');
  assert.equal(detail.resourceLines[2].quantityLabel, '3');
  assert.equal(detail.haffRentLabel, '¥150.00');
  assert.equal(detail.itemResourceTotalLabel, '¥45.00');
  assert.equal(resourceQuantityLabel(detail.resourceLines[1]), '3组（180发）');
  assert.equal(resourceQuantityLabel(detail.resourceLines[2]), '3天');
});

test('legacy inventory expresses level6 rounds in groups without a current price line', () => {
  for (const code of ['level6_round', 'df_billable_level6_bullet']) {
    for (const quantity of ['0', '120', '121']) {
      const source = {
        ...listing, source: 'LEGACY_READ_ONLY', canCreateOrder: false, quote: null,
        historicalQuote: { haffRent: { currency: 'CNY', unit: 'yuan', amount: '1.00', scale: 2 }, goods: { currency: 'CNY', unit: 'yuan', amount: '1.00', scale: 2 }, deposit: { currency: 'CNY', unit: 'yuan', amount: '0.00', scale: 2 }, termDays: 1 },
        presentation: { items: [{ id: 'level6', code, name: '6级子弹', unit: 'ROUND' }], skins: [], entitlements: [] },
        inventory: [{ itemId: 'level6', quantity, unit: 'ROUND' }],
      };
      for (const project of [toListingCard, toListingDetail]) {
        const line = project(source).resourceLines[0];
        assert.equal(line.quantity, quantity, 'the stored rounds are unchanged');
        assert.equal(resourceQuantityLabel(line), quantity === '121' ? '121发' : `${BigInt(quantity) / 60n}组（${quantity}发）`);
      }
    }
  }
});

test('card and detail share code-first resource names and only use Delta legacy fallback', () => {
  const line = { itemId: 'item_bullet', quantity: '180', unit: 'ROUND', unitQuantity: '60', buyerUnitAmount: { currency: 'CNY', unit: 'yuan', amount: '10.00000000', scale: 8 }, buyerAmount: { currency: 'CNY', unit: 'yuan', amount: '30.00', scale: 2 } };
  const project = (item, game = { id: 'game_delta', code: 'delta', name: '三角洲行动' }) => ({
    ...listing,
    game,
    presentation: { ...listing.presentation, items: [item] },
    quote: { ...listing.quote, lines: [line] },
  });

  const known = toListingCard(project({ id: 'item_bullet', code: 'df_billable_level6_bullet', name: '六级子弹', unit: 'ROUND' }));
  assert.deepEqual([known.resourceLines[0].itemId, known.resourceLines[0].code, known.resourceLines[0].name, known.resourceLines[0].quantity, known.resourceLines[0].quantityLabel], ['item_bullet', 'df_billable_level6_bullet', '6级子弹', '180', '3组（180发）']);

  const differentCode = toListingCard(project({ id: 'item_bullet', code: 'different_resource', name: '六级子弹', unit: 'ROUND' }));
  assert.equal(differentCode.resourceLines[0].name, '6级子弹');
  assert.equal(differentCode.resourceLines[0].quantityLabel, '180');

  const legacy = toListingCard(project({ id: 'item_bullet', name: '六级子弹', unit: 'ROUND' }));
  assert.equal(legacy.resourceLines[0].name, '6级子弹');
  assert.equal(legacy.resourceLines[0].code, null);
  assert.equal(legacy.resourceLines[0].quantityLabel, '180');
  assert.equal(toListingDetail(project({ id: 'item_bullet', name: '六级子弹', unit: 'ROUND' })).resourceLines[0].name, '6级子弹');
  assert.equal(toListingCard(project({ id: 'item_bullet', name: '六级子弹', unit: 'ROUND' }, null)).resourceLines[0].name, '六级子弹');
});

test('unmapped resource IDs stay explicit instead of becoming display names', () => {
  const card = toListingCard({
    ...listing,
    presentation: { ...listing.presentation, items: [] },
  });
  assert.equal(card.resourceLines[0].name, '未确认');
});

const accountTitleCode = ts.transpileModule(
  readFileSync(new URL('../src/lib/account-title.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText;
const accountTitleExports = {};
new Function('require', 'exports', accountTitleCode)((name) => {
  if (name === './listing-filters' || name === '@/lib/listing-filters') return listingFilters;
  return {};
}, accountTitleExports);

const accountCardCode = ts.transpileModule(
  readFileSync(new URL('../src/components/delta/account-card.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }
).outputText;

const accountCardExports = {};
new Function('require', 'exports', accountCardCode)((name) => {
  if (name === '@/lib/account-title') return accountTitleExports;
  if (name === '@/lib/listing-filters') return listingFilters;
  if (name === '@/lib/listing-view') return { haffRatioLabel, resourceQuantityLabel, skinQualityLabel: listingViewSk7.skinQualityLabel };
  if (name === '@/lib/account-return') return {};
  if (name === './login-method-icon') return { LoginMethodIcon: () => null };
  if (name === '@/components/favorites/favorite-button') return { FavoriteButton: () => null };
  if (name === '@/components/ui/tooltip') return { Tooltip: () => null, TooltipContent: () => null, TooltipTrigger: () => null };
  if (name === '@/components/ui/thumbnail-carousel') return { ThumbnailCarousel: () => null };
  return {};
}, accountCardExports);

const { composeGridTitle, composeListTitle, orderedQuoteResources, skinChipTone, moneyValue, termBadgeLabel, dailyConsumptionBadgeLabel, listingFactBadges } = accountCardExports;

test('grid resource projection excludes Haff-only quote lines', () => {
  const haff = { itemId: 'haff', code: null, name: '哈夫币', unitLabel: '哈夫币', quantity: '60000000' };
  const bullet = { itemId: 'bullet', code: 'df_billable_level6_bullet', name: '6级子弹', unitLabel: '发', quantity: '120' };

  assert.deepEqual(orderedQuoteResources({ resourceLines: [haff] }), []);
  assert.deepEqual(orderedQuoteResources({ resourceLines: [haff, bullet] }).map((line) => line.itemId), ['bullet']);
});

test('composeGridTitle handles haff, composite parts, fallback titles and prefix deduplication', () => {
  const cardWithSafeBoxAndRank = {
    title: '60M 哈夫币 极品全装号',
    displayNo: 'A-001',
    conditionLines: [
      { key: 'safe_box_code', value: '3*3安全箱' },
      { key: 'grading_code', value: '钻石' },
      { key: 'character_level', value: '50级' },
    ],
  };

  // Case 1: Haff + composite parts (safeBox + rank)
  assert.deepEqual(composeGridTitle(cardWithSafeBoxAndRank, '60M'), {
    haff: '60M 哈夫币',
    rest: '3×3安全箱 · 钻石 · 50级',
  });

  // Case 2: No haff + composite parts
  assert.deepEqual(composeGridTitle(cardWithSafeBoxAndRank, null), {
    haff: null,
    rest: '3×3安全箱 · 钻石 · 50级',
  });

  // Case 3: Haff only, missing composite parts -> fallback to title with deduplication
  const cardHaffPrefix = {
    title: '60M 哈夫币 极品满配全装',
    displayNo: 'A-002',
    conditionLines: [],
  };
  assert.deepEqual(composeGridTitle(cardHaffPrefix, '60M'), {
    haff: '60M 哈夫币',
    rest: '极品满配全装',
  });

  // Case 4: Title with dot/dash separator deduplication
  const cardHaffDot = {
    title: '60M哈夫币 · 精选热卖号',
    displayNo: 'A-003',
    conditionLines: [],
  };
  assert.deepEqual(composeGridTitle(cardHaffDot, '60M'), {
    haff: '60M 哈夫币',
    rest: '精选热卖号',
  });

  // Case 5: Title without haff quantity prefix
  const cardNoPrefix = {
    title: '三角洲顶级传家宝账号',
    displayNo: 'A-004',
    conditionLines: [],
  };
  assert.deepEqual(composeGridTitle(cardNoPrefix, '60M'), {
    haff: '60M 哈夫币',
    rest: '三角洲顶级传家宝账号',
  });

  // Case 6: No haff, missing composite parts -> fallback to title
  assert.deepEqual(composeGridTitle(cardNoPrefix, null), {
    haff: null,
    rest: '三角洲顶级传家宝账号',
  });

  // Case 7: All missing -> generic identity; the number stays in the copy control only
  const cardEmpty = {
    title: '',
    displayNo: 'A-005',
    conditionLines: [],
  };
  assert.deepEqual(composeGridTitle(cardEmpty, null), {
    haff: null,
    rest: '游戏账号',
  });
});

test('composeListTitle prioritizes real identity, highlights haff, and leaves secondary summary', () => {
  const cardWithSafeBoxAndRank = {
    title: '120M 哈夫币 极品全装号',
    displayNo: 'A-101',
    conditionLines: [
      { key: 'safe_box_code', value: '1*2安全箱' },
      { key: 'grading_code', value: '白银' },
      { key: 'character_level', value: '30级' },
    ],
  };

  // Case 1: unified presentation title; raw identity is not leaked, composite parts ordered consistently
  assert.deepEqual(composeListTitle(cardWithSafeBoxAndRank, '120M'), {
    identity: '',
    haff: '120M 哈夫币',
    rest: '1×2安全箱 · 白银 · 30级',
  });

  // Case 2: Without safe box
  const cardWithoutSafeBox = {
    title: '120M 哈夫币 极品全装号',
    displayNo: 'A-102',
    conditionLines: [
      { key: 'grading_code', value: '白银' },
    ],
  };
  assert.deepEqual(composeListTitle(cardWithoutSafeBox, '120M'), {
    identity: '',
    haff: '120M 哈夫币',
    rest: '白银',
  });
  assert.equal(composeListTitle({ title: '', displayNo: 'A-103', conditionLines: [] }, null).identity, '');

  assert.deepEqual(composeListTitle({
    title: '120M 哈夫币 · 3×3安全箱 · 钻石段位 60级',
    displayNo: null,
    conditionLines: [
      { key: 'safe_box_code', value: '3*3安全箱' },
      { key: 'grading_code', value: '钻石' },
      { key: 'character_level', value: '60级' },
    ],
  }, '120M'), {
    identity: '',
    haff: '120M 哈夫币',
    rest: '3×3安全箱 · 钻石 · 60级',
  });

  // Case 3: Title without attributes fallbacks to cleaned title
  const cardCustomTitle = {
    title: '三角洲行动 · 顶配战术号',
    displayNo: null,
    conditionLines: [],
  };
  assert.deepEqual(composeListTitle(cardCustomTitle, '120M'), {
    identity: '',
    haff: '120M 哈夫币',
    rest: '三角洲行动 · 顶配战术号',
  });

  // Case 4: Missing identity and title fallback
  const cardEmpty = {
    title: '',
    displayNo: null,
    conditionLines: [],
  };
  assert.deepEqual(composeListTitle(cardEmpty, null), {
    identity: '',
    haff: null,
    rest: '游戏账号',
  });
});

test('skinChipTone maps strictly by category code and name without guessing by item name', () => {
  // Knife / melee: teal
  assert.equal(skinChipTone({ name: '刺刀', categoryCode: 'knife', categoryName: '近战' }), 'teal');
  assert.equal(skinChipTone({ name: '暗影军刺', categoryCode: 'melee', categoryName: null }), 'teal');
  assert.equal(skinChipTone({ name: '龙炎近战', categoryCode: null, categoryName: '近战武器' }), 'teal');

  // Operator / agent: purple
  assert.equal(skinChipTone({ name: '红狼', categoryCode: 'operator_skin', categoryName: '干员' }), 'purple');
  assert.equal(skinChipTone({ name: '蜂医', categoryCode: 'agent', categoryName: null }), 'purple');
  assert.equal(skinChipTone({ name: '特战角色', categoryCode: null, categoryName: '角色外观' }), 'purple');

  // Weapon / gun: blue
  assert.equal(skinChipTone({ name: 'M4A1 金色', categoryCode: 'weapon', categoryName: '武器' }), 'blue');
  assert.equal(skinChipTone({ name: 'AK47 火蛇', categoryCode: 'gun_skin', categoryName: null }), 'blue');
  assert.equal(skinChipTone({ name: '巴雷特 毁灭', categoryCode: null, categoryName: '枪械皮肤' }), 'blue');

  // Same item name under different categories produces correct category tone, never guessing from name
  const knifeItem = { name: '黑海玫瑰', categoryCode: 'knife', categoryName: '近战' };
  const gunItem = { name: '黑海玫瑰', categoryCode: 'weapon', categoryName: '枪械' };
  const operatorItem = { name: '黑海玫瑰', categoryCode: 'operator', categoryName: '干员' };
  assert.equal(skinChipTone(knifeItem), 'teal');
  assert.equal(skinChipTone(gunItem), 'blue');
  assert.equal(skinChipTone(operatorItem), 'purple');

  // Missing or unknown category -> default neutral tone, never guesses from keyword in name
  assert.equal(skinChipTone({ name: '军刀之王', categoryCode: null, categoryName: null }), 'default');
  assert.equal(skinChipTone({ name: '红狼特战', categoryCode: 'unknown_cat', categoryName: '其他' }), 'default');
  assert.equal(skinChipTone({ name: 'AKM 突击步枪', categoryCode: undefined, categoryName: undefined }), 'default');
});

test('moneyValue and card amounts strictly reflect server quote line breakdown', () => {
  // moneyValue helper behavior
  assert.equal(moneyValue(null), '待确认');
  assert.equal(moneyValue(undefined), '待确认');
  assert.equal(moneyValue(''), '待确认');
  assert.equal(moneyValue('   '), '待确认');
  assert.equal(moneyValue('以平台确认为准'), '待确认');
  assert.equal(moneyValue('¥150.00'), '¥150.00');
  assert.equal(moneyValue('¥0.00'), '¥0.00');
  assert.equal(moneyValue('¥0.00', '无物品费用'), '无物品费用');
  assert.equal(moneyValue('¥0', '无需押金'), '无需押金');

  // Server contract verification on toListingCard
  const card = toListingCard(listing);
  // Real contract fields present
  assert.equal(card.resourceTotalLabel, '¥150.00');
  assert.equal(card.depositLabel, null);
  assert.equal(card.payableTotalLabel, null);

  // Breakdown labels are grouped from quote line buyerAmount values; no subtraction is used.
  assert.equal(card.haffRentLabel, '¥150.00');
  assert.equal(card.itemResourceTotalLabel, '¥0.00');

  // In card mode breakdown:
  // - 租金/资源费用 use exact quote line groups
  // - 总资源费 remains card.resourceTotalLabel
  // - 押金 uses card.depositLabel
  // - 合计 uses card.payableTotalLabel
  // Unknown or null amounts become "待确认"
  assert.equal(moneyValue(card.resourceTotalLabel), '¥150.00');
  assert.equal(moneyValue(card.depositLabel), '待确认');
  assert.equal(moneyValue(card.payableTotalLabel), '待确认');
});

test('quote subtotals distinguish known zero groups from absent quote data', () => {
  const noQuote = toListingCard({
    ...listing,
    quote: { ...listing.quote, lines: [], resourceTotal: null },
  });
  assert.equal(noQuote.haffRentLabel, null);
  assert.equal(noQuote.itemResourceTotalLabel, null);

  const itemZero = toListingCard({
    ...listing,
    presentation: {
      ...listing.presentation,
      items: [...listing.presentation.items, { id: 'item_armor', code: 'df_billable_level6_armor', name: '6级护甲', unit: 'COUNT' }],
    },
    quote: {
      ...listing.quote,
      lines: [
        ...listing.quote.lines,
        { itemId: 'item_armor', quantity: '1', unit: 'COUNT', unitQuantity: '1', buyerUnitAmount: { currency: 'CNY', unit: 'yuan', amount: '0.00000000', scale: 8 }, buyerAmount: { currency: 'CNY', unit: 'yuan', amount: '0.00', scale: 2 } },
      ],
    },
  });
  assert.equal(itemZero.haffRentLabel, '¥150.00');
  assert.equal(itemZero.itemResourceTotalLabel, '¥0.00');
  assert.equal(moneyValue(itemZero.itemResourceTotalLabel, '无物品费用'), '无物品费用');
});

test('term and daily consumption badges drop noise and keep a compact unit', () => {
  assert.equal(termBadgeLabel(null), null);
  assert.equal(termBadgeLabel(''), null);
  assert.equal(termBadgeLabel('-'), null);
  assert.equal(termBadgeLabel('待确认'), null);
  assert.equal(termBadgeLabel('15天'), '租期15天');
  assert.equal(termBadgeLabel('15 天'), '租期15天');
  assert.equal(termBadgeLabel('租期15天'), '租期15天');
  assert.equal(dailyConsumptionBadgeLabel(null), null);
  assert.equal(dailyConsumptionBadgeLabel('-'), null);
  assert.equal(dailyConsumptionBadgeLabel('待确认'), null);
  assert.equal(dailyConsumptionBadgeLabel('10 M 哈夫币'), '10M/天');
  assert.equal(dailyConsumptionBadgeLabel('每日消耗10M'), '10M/天');
  assert.equal(dailyConsumptionBadgeLabel('每天消耗 10M'), '10M/天');
  assert.equal(dailyConsumptionBadgeLabel('10M/天'), '10M/天');
  assert.deepEqual(
    listingFactBadges({ termValue: '20天', dailyValue: '10 M 哈夫币', ratio: '39万/元' }).map((badge) => badge.text),
    ['租期20天', '10M/天', '39万/元']
  );
  assert.deepEqual(listingFactBadges({ termValue: null, dailyValue: null, ratio: null }), []);
});

test('skin presentation carries the stable owner, base name and media summary', () => {
  const view = toListingCard({
    ...listing,
    presentation: {
      ...listing.presentation,
      skins: [{ ...listing.presentation.skins[0], ownerName: '骇爪', baseName: '维什戴尔', mediaId: 'asset_skin' }],
    },
  });
  assert.deepEqual(view.skinTags, [{ id: 'skin_1', name: 'M4A1 金色', categoryCode: null, categoryName: '武器', ownerName: '骇爪', baseName: '维什戴尔', mediaId: 'asset_skin' }]);
});


test('historical listing keeps exact source amounts without inventing a current payable total', () => {
  const money = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
  const historical = { ...listing, source: 'LEGACY_READ_ONLY', canCreateOrder: false, quote: null,
    historicalQuote: { haffRent: money('2038.00'), goods: money('20.00'), deposit: money('50.00'), termDays: '102' },
    inventory: [{ itemId: 'legacy-unknown', quantity: null, unit: 'ROUND' }, { itemId: 'legacy-zero', quantity: '0', unit: 'PIECE' }] };
  const view = toListingCard(historical);
  assert.equal(view.historicalReadOnly, true);
  assert.equal(toListingCard({...historical,displayNo:'AC0000000001'}).displayNo,'AC0000000001');
  assert.equal(toListingCard({...historical,displayNo:null}).displayNo,null);
  assert.equal(view.haffRentLabel, '¥2038.00');
  assert.equal(view.resourceTotalLabel, '¥2058.00');
  assert.equal(view.payableTotalLabel, null);
  assert.equal(view.rentalMode, null);
  assert.equal(toListingCard({...historical,rentalMode:'fast',displaySchema:'legacy-listing-display-v1'}).rentalMode,'fast');
  assert.equal(view.termLabel, '102 天');
  assert.doesNotMatch(view.termLabel, /旧站/);
  assert.equal(view.resourceLines[0].quantityLabel, '未确认');
  assert.equal(view.resourceLines[1].quantity, '0');
  assert.equal(view.resourceLines[0].costAmount, null);
  assert.equal(view.resourceLines[1].unitPriceLabel, null);
  // F3: real holdings and public display media project through the historical adapter.
  assert.deepEqual(view.media.map((item) => item.assetId), ['asset_a', 'asset_b']);
  assert.equal(view.imageUrl, '/api/supply/listings/account_1/media/asset_a');
  assert.deepEqual(view.skinNames, ['M4A1 金色']);
  assert.deepEqual(view.skinLabels, ['武器 · M4A1 金色']);
  assert.deepEqual(view.skinTags, [{ id: 'skin_1', name: 'M4A1 金色', categoryCode: null, categoryName: '武器' }]);
  assert.equal(Object.hasOwn(view, 'skinsWithheld'), false);
  const withheld = toListingCard({ ...historical, presentation: { ...listing.presentation, skinsWithheld: 2 } });
  assert.equal(withheld.skinsWithheld, 2, 'pending declared skins stay visible as a count instead of an empty declaration');
  for (const bad of [0, -1, 1.5, '2', null]) assert.equal(Object.hasOwn(toListingCard({ ...historical, presentation: { ...listing.presentation, skinsWithheld: bad } }), 'skinsWithheld'), false);
  const empty = toListingCard({ ...historical, media: [], presentation: { ...listing.presentation, skins: [] } });
  assert.equal(empty.media.length, 0);
  assert.equal(empty.imageUrl, undefined);
  assert.deepEqual(empty.skinNames, []);
  assert.throws(() => toListingCard({ ...historical, canCreateOrder: true }));
  assert.throws(() => toListingCard({ ...listing, quote: null }));
});

test('legacy image slots keep order without replacing actual bound media', () => {
  const money = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
  const historical = { ...listing, source: 'LEGACY_READ_ONLY', canCreateOrder: false, quote: null, media: [],
    historicalQuote: { haffRent: money('1.00'), goods: money('0.00'), deposit: money('0.00'), termDays: '1' }, inventory: [],
    legacyImages: [{ position: 1, url: '/api/supply/listings/account_1/legacy-images/1' }, { position: 0, url: '/api/supply/listings/account_1/legacy-images/0' }] };
  const view = toListingCard(historical);
  assert.deepEqual(view.media.map(item => [item.assetId, item.legacy]), [['legacy-slot-0', true], ['legacy-slot-1', true]]);
  assert.equal(view.imageUrl, '/api/supply/listings/account_1/legacy-images/0');
  const existing = toListingCard({ ...historical, media: [{ assetId: 'real_asset', position: 0, url: '/api/supply/listings/account_1/media/real_asset' }] });
  assert.equal(existing.media[0].assetId, 'real_asset'); assert.equal(existing.media[0].legacy, undefined);
  const published = toListingCard({ ...listing, media: [], legacyImages: [{ position: 0, url: '/api/supply/listings/account_1/legacy-images/0' }], availability: { state: 'RENTABLE' }, canCreateOrder: true });
  assert.equal(published.imageUrl, '/api/supply/listings/account_1/legacy-images/0');
  assert.equal(published.media[0].legacy, true); assert.equal(published.canCreateOrder, true);
});

test('historical detail consumes the frozen haff rent for the display ratio only, never for goods rows', () => {
  const money = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
  const historical = { ...listing, source: 'LEGACY_READ_ONLY', canCreateOrder: false, quote: null,
    historicalQuote: { haffRent: money('98.00'), goods: money('72.40'), deposit: money('100.00'), termDays: '2' },
    presentation: { ...listing.presentation, items: [
      { id: 'legacy-display:haff_base', code: 'haff_base', name: '哈夫币', unit: 'HAFF_BASE' },
      { id: 'legacy-display:awm_round', code: 'awm_round', name: 'AWM子弹', unit: 'ROUND' },
    ] },
    inventory: [
      { itemId: 'legacy-display:haff_base', quantity: '40000000', unit: 'HAFF_BASE' },
      { itemId: 'legacy-display:awm_round', quantity: '47', unit: 'ROUND' },
    ] };
  const view = toListingCard(historical);
  const haff = view.resourceLines.find((line) => line.unitLabel === '哈夫币');
  assert.equal(haff.costAmount, '98.00', 'the haff line carries its own frozen rent record');
  assert.equal(haffRatioLabel(haff.quantity, haff.costAmount), '41万/元');
  assert.equal(haff.costLabel, null, 'the row keeps no per-row fee display');
  assert.equal(haff.unitPriceLabel, null);
  assert.equal(view.resourceLines.find((line) => line.unitLabel === '发').costAmount, null, 'goods rows never inherit the aggregate 72.40');
  assert.equal(view.itemResourceTotalLabel, '¥72.40');
  // The owner's declaration reaches the card; absence and legacy stay unknown, not 普通赔付.
  assert.equal(toListingCard({ ...listing, fullPayoutSelected: true }).fullPayoutSelected, true);
  assert.equal(toListingCard({ ...listing, fullPayoutSelected: false }).fullPayoutSelected, false);
  assert.equal(toListingCard(listing).fullPayoutSelected, null);
  assert.equal(view.fullPayoutSelected, null);
});

test('public native availability keeps readable occupied/offline cards distinct from rentability',()=>{
 const money=amount=>({currency:'CNY',unit:'yuan',amount,scale:2});
 for(const state of ['PENDING_PAYMENT','RENTED','OCCUPIED','OFFLINE','UNKNOWN','UNAVAILABLE']){
  const card=toListingCard({...listing,availability:{state},canCreateOrder:false});assert.equal(card.canCreateOrder,false);assert.equal(card.availabilityState,state);assert.ok(card.availabilityLabel);assert.equal(card.displayNo,listing.displayNo);
 }
 assert.throws(()=>toListingCard({...listing,availability:{state:'OFFLINE'},canCreateOrder:true}));
 const historical=toListingCard({...listing,source:'LEGACY_READ_ONLY',canCreateOrder:false,quote:null,historicalQuote:{haffRent:money('1.00'),goods:money('2.00'),deposit:money('3.00'),termDays:'1'},inventory:[],sourceAvailability:{state:'RENTED',asOfUtc:'2026-09-13T00:00:00Z'}});
 assert.equal(historical.canCreateOrder,false);assert.equal(historical.availabilityState,'LEGACY_READ_ONLY');assert.equal(historical.availabilityLabel,'暂不可租');assert.equal(historical.sourceAvailabilityLabel,'来源状态为已出租');
 const derived=toListingCard({...listing,source:'LEGACY_READ_ONLY',title:'',canCreateOrder:false,quote:null,historicalQuote:{haffRent:money('1.00'),goods:money('2.00'),deposit:money('3.00'),termDays:'1'},inventory:[{itemId:'item_haff',quantity:'60000000',unit:'HAFF_BASE'}]});
 assert.match(derived.title,/60 M 哈夫币/);assert.doesNotMatch(derived.title,/历史资料|旧平台|首批/);
});

test('I03 rentable cards and details omit the unavailable badge while other states keep their labels', () => {
  const labels = {
    RENTABLE: null,
    PENDING_PAYMENT: '待付款 · 暂不可租',
    RENTED: '已出租',
    OCCUPIED: '暂不可租',
    OFFLINE: '已下架',
    UNKNOWN: '暂不可租',
    UNAVAILABLE: '暂不可租',
    LEGACY_READ_ONLY: '暂不可租',
  };
  for (const [state, label] of Object.entries(labels)) {
    assert.equal(publicAvailabilityLabel(state), label, state);
    if (state === 'LEGACY_READ_ONLY') continue;
    for (const project of [toListingCard, toListingDetail]) {
      const card = project({ ...listing, availability: { state }, canCreateOrder: state === 'RENTABLE' });
      assert.equal(card.availabilityLabel, label, state);
      assert.equal(card.canCreateOrder, state === 'RENTABLE', state);
    }
  }
  for (const state of [undefined, null, 'FUTURE_STATE']) assert.equal(publicAvailabilityLabel(state), '暂不可租');
});

test('AVAILABILITY-ABSENT: missing fields stay unknown and only an explicit RENTABLE grant opens orders', () => {
  // An older or incomplete DTO with neither field must never default to rentable.
  const missing = toListingCard({ ...listing, availability: undefined, canCreateOrder: undefined });
  assert.equal(missing.availabilityState, 'UNKNOWN');
  assert.equal(missing.availabilityLabel, '暂不可租');
  assert.equal(missing.canCreateOrder, false);

  // Explicit RENTABLE without the server grant is still not orderable. The delivered state stays
  // RENTABLE (no unavailable badge), but the order gate and the automatic preview stay closed.
  const noGrant = toListingDetail({ ...listing, releaseId: 'release_1', availability: { state: 'RENTABLE' }, canCreateOrder: undefined });
  assert.equal(noGrant.availabilityState, 'RENTABLE');
  assert.equal(noGrant.availabilityLabel, null);
  assert.equal(noGrant.canCreateOrder, false);
  assert.equal(noGrant.autoPreview, false);

  // Explicit RENTABLE + true keeps the existing rentable contract, including auto preview.
  const granted = toListingDetail({ ...listing, releaseId: 'release_1', availability: { state: 'RENTABLE' }, canCreateOrder: true });
  assert.equal(granted.availabilityState, 'RENTABLE');
  assert.equal(granted.availabilityLabel, null);
  assert.equal(granted.canCreateOrder, true);
  assert.equal(granted.autoPreview, true);

  // Historical records stay read-only with their own state even when availability is absent.
  const money = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
  const historical = toListingCard({ ...listing, source: 'LEGACY_READ_ONLY', canCreateOrder: false, quote: null,
    historicalQuote: { haffRent: money('1.00'), goods: money('0.00'), deposit: money('0.00'), termDays: '1' }, inventory: [] });
  assert.equal(historical.availabilityState, 'LEGACY_READ_ONLY');
  assert.equal(historical.canCreateOrder, false);

  // An explicit positive grant without a RENTABLE state stays contradictory, including when
  // the availability field itself is absent.
  for (const availability of [undefined, { state: 'UNKNOWN' }, { state: 'OFFLINE' }]) {
    assert.throws(() => toListingCard({ ...listing, availability, canCreateOrder: true }), /Inconsistent public availability/);
  }
});


test('registered migration catalog codes use the existing card resource roles without name guessing', () => {
  assert.equal(accountCardExports.canonicalResourceCode('level6_round'), 'df_billable_level6_bullet');
  assert.equal(accountCardExports.canonicalResourceCode('awm_round'), 'df_billable_awm_bullet');
  assert.equal(accountCardExports.canonicalResourceCode('unrelated_item'), 'unrelated_item');
  assert.equal(accountCardExports.canonicalResourceCode(null), null);
});

test('detail adds public title/time/expiry consumption without inventing missing declarations',()=>{
 const listing={id:'a',displayNo:null,title:'',description:'public',publishedAt:'2026-10-08T07:33:16Z',attributes:{},media:[],presentation:{items:[],skins:[],entitlements:[{id:'e',name:'体验权益'}]},quote:{schemaVersion:2,lines:[],resourceTotal:{currency:'CNY',unit:'yuan',amount:'0.00',scale:2},tenantDeposit:null,tenantPayableTotal:null,termSeconds:'86400',expiryDisclosures:[{entitlementId:'e',expiresAt:'2026-10-09T07:00:00Z',fullTermGuaranteed:false}]}};
  const detail=toListingDetail(listing);assert.equal(detail.publicTitle,null);assert.equal(detail.publishedAt,listing.publishedAt);assert.equal(detail.depositLabel,null);assert.deepEqual(detail.entitlementDetails,[{id:'e',name:'体验权益',expiresAt:'2026-10-09T07:00:00Z',expiryState:'TIMED'}]);assert.equal(detail.faceIsSelf, null); assert.equal(detail.banRecord, null);
  assert.equal(toListingDetail({ ...listing, attributes: { face_is_self: false, ban_record: true } }).faceIsSelf, false);
  assert.equal(toListingDetail({ ...listing, attributes: { face_is_self: false, ban_record: true } }).banRecord, true);
  assert.equal(toListingDetail({ ...listing, attributes: { face_is_self: true, ban_record: false } }).faceIsSelf, true);
  assert.equal(toListingDetail({ ...listing, attributes: { face_is_self: true, ban_record: false } }).banRecord, false);
  delete listing.publishedAt;listing.quote.expiryDisclosures=[];assert.equal(toListingDetail(listing).publishedAt,null);assert.equal(toListingDetail(listing).entitlementDetails[0].expiresAt,null);assert.equal(toListingDetail(listing).entitlementDetails[0].expiryState,'MISSING');
  listing.quote.expiryDisclosures=[{entitlementId:'e',expiresAt:null,fullTermGuaranteed:false}];assert.equal(toListingDetail(listing).entitlementDetails[0].expiryState,'PERMANENT');
});

// SKIN-MODEL-7: list, detail, publish and filter surfaces share one type/quality conversion.
// Type comes only from the verified owner kind; quality only from the server-delivered name.
import * as listingViewSk7 from '../src/lib/listing-view.ts';

test('SK7 skin type comes only from owner kind and quality only from the delivered name', () => {
  const { skinTypeLabel, skinQualityLabel, skinFacetLabel, SKIN_TYPE_LABELS } = listingViewSk7;
  assert.deepEqual(SKIN_TYPE_LABELS, { AGENT: '干员外观', FIREARM: '枪械外观', MELEE_TYPE: '近战外观' });
  for (const kind of ['CATEGORY', undefined, null, 'toString', 'agent']) assert.equal(skinTypeLabel(kind), null, String(kind));
  assert.equal(skinQualityLabel({ rarityName: '  ' }), null);
  assert.equal(skinQualityLabel({ rarityCode: 'q_fixture' }), null, 'a bare code is never turned into a label');
  assert.equal(skinQualityLabel({ name: 'M4A1 金色', categoryName: '干员金皮（旧分组）' }), null, 'red/gold names or legacy groups never become a quality');
  assert.equal(skinFacetLabel({ ownerKind: 'AGENT', rarityName: ' 测试品质 ' }), '干员外观 · 测试品质');
  assert.equal(skinFacetLabel({ ownerKind: 'MELEE_TYPE' }), '近战外观');
  assert.equal(skinFacetLabel({ rarityName: '测试品质' }), '测试品质');
  assert.equal(skinFacetLabel({ categoryName: '干员金皮（旧分组）' }), null);
});

test('SK7 list and detail project the same id, type and quality; absent snapshot keys stay absent', () => {
  const l = structuredClone(listing);
  l.presentation.skins = [
    { id: 's1', name: '露娜-黑·天际线', ownerName: '露娜', ownerKind: 'AGENT', rarityCode: 'q1', rarityName: '品质甲', rarityBasis: 'PLATFORM_REFERENCE', isCollectible: false, defaultState: 'NON_DEFAULT', mediaKind: 'PROMO_POSTER', categoryName: '干员外观' },
    { id: 's2', name: '露娜-另一外观', ownerName: '露娜', ownerKind: 'AGENT', rarityCode: 'q2', rarityName: '品质乙', categoryName: '干员外观' },
    { id: 's3', name: '战术斧头-黑鹰', baseName: '黑鹰', ownerName: '战术斧头', ownerKind: 'MELEE_TYPE', rarityCode: null, rarityName: null, categoryName: '近战相关待核词条' },
    { id: 's4', name: 'Vector-黑鹰', baseName: '黑鹰', ownerName: 'Vector', ownerKind: 'FIREARM', rarityCode: null, rarityName: null, categoryName: '枪械外观' },
    { id: 's5', name: '旧快照皮肤', categoryCode: 'df_skin_category_agent_gold', categoryName: '干员金皮（旧分组）' },
  ];
  const card = toListingCard(l), detail = toListingDetail(l);
  assert.deepEqual(card.skinTags, detail.skinTags, 'list and detail read the same projection');
  const tags = card.skinTags;
  assert.deepEqual(tags.map((t) => t.id), ['s1', 's2', 's3', 's4', 's5']);
  const facets = tags.map((t) => listingViewSk7.skinFacetLabel(t));
  assert.deepEqual(facets, ['干员外观 · 品质甲', '干员外观 · 品质乙', '近战外观', '枪械外观', null], 'same type, different quality; same base name, different owner type');
  assert.deepEqual([tags[0].rarityBasis, tags[0].isCollectible, tags[0].defaultState], ['PLATFORM_REFERENCE', false, 'NON_DEFAULT']);
  assert.equal(tags[0].mediaKind, 'PROMO_POSTER', 'frozen poster kind reaches the shared preview through listing projection');
  assert.equal(Object.hasOwn(tags[4], 'mediaKind'), false, 'old snapshot does not gain a media kind');
  assert.deepEqual([tags[2].ownerKind, tags[2].rarityName], ['MELEE_TYPE', null]);
  for (const key of ['ownerKind', 'rarityCode', 'rarityName', 'rarityBasis', 'isCollectible', 'defaultState']) assert.equal(Object.hasOwn(tags[4], key), false, `old snapshot keeps ${key} absent`);
});

test('SK7 chip tone prefers the verified owner kind over category text', () => {
  assert.equal(skinChipTone({ name: 'x', ownerKind: 'MELEE_TYPE', categoryCode: 'df_skin_category_agent', categoryName: '干员外观' }), 'teal');
  assert.equal(skinChipTone({ name: 'x', ownerKind: 'AGENT', categoryCode: 'weapon', categoryName: '枪械外观' }), 'purple');
  assert.equal(skinChipTone({ name: 'x', ownerKind: 'FIREARM', categoryCode: 'df_skin_category_knife', categoryName: '近战相关待核词条' }), 'blue');
  assert.equal(skinChipTone({ name: 'x', categoryCode: 'df_skin_category_agent_gold', categoryName: '干员金皮（旧分组）' }), 'purple', 'without a verified owner kind the existing category fallback is unchanged');
});


test('public declarations keep false distinct and never expose private source', () => {
  const rows = conditionLines({ next_season_pass: false, demulan_unlocked: true, info_source: 'private-campaign' });
  assert.equal(rows.find(r => r.key === 'next_season_pass').value, '不计划购买');
  assert.equal(rows.find(r => r.key === 'demulan_unlocked').value, '已解锁');
  assert.equal(rows.some(r => r.key === 'info_source'), false);
  assert.equal(conditionLines({ next_season_pass: null }).some(r => r.key === 'next_season_pass'), false);
});


test('public resource projections preserve all eight facts and never turn frozen days into cards',()=>{
  const items=[['haff','haff_base','HAFF_BASE','2000000','1000000'],['six','level6_round','ROUND','120','60'],['awm','awm_round','ROUND','2','1'],['barrett','df_billable_barrett_bullet','ROUND','2','1'],['armor','level6_armor','PIECE','0','1'],['helmet','level6_helmet','PIECE','1','1'],['coffee','coffee','PIECE','1','1'],['card','top_insure_card_piece','PIECE','3','1'],['old-card','df_billable_top_insure_card','DAY','4','1']];
  const money=amount=>({currency:'CNY',unit:'yuan',amount,scale:2});
  const listing={id:'synthetic',title:'synthetic contract',attributes:{},description:null,media:[],presentation:{items:items.map(([id,code,unit])=>({id,code,unit,name:code})),skins:[],entitlements:[]},quote:{lines:items.map(([itemId,,unit,quantity,unitQuantity])=>({itemId,unit,quantity,unitQuantity,buyerAmount:money('1.00'),buyerUnitAmount:money('1.00')})),resourceTotal:money('9.00'),tenantDeposit:null,tenantPayableTotal:null,termSeconds:'86400',expiryDisclosures:[]}};
  const card=toListingCard(listing);
  assert.equal(card.resourceLines.length,9);
  const line=id=>card.resourceLines.find(row=>row.itemId===id);
  assert.equal(line('six').quantityLabel,'2组（120发）');
  assert.equal(line('awm').quantity,'2');assert.equal(line('barrett').quantity,'2');
  assert.equal(resourceQuantityLabel(line('armor')),'0件');
  assert.equal(resourceQuantityLabel(line('card')),'3张');
  assert.equal(resourceQuantityLabel(line('old-card')),'4天');
  assert.equal(resourceQuantityLabel(line('coffee')),'1件');
  assert.equal(card.depositLabel,null);
});
