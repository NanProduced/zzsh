import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  conditionLines,
  detailBreadcrumbs,
  formatMoneyLabel,
  haffRatioLabel,
  haffMillionsLabel,
  termLabel,
  listingResourceLinesLabel,
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
  assert.deepEqual(card.resourceLines, [{ itemId: 'item_haff', code: null, name: '哈夫币', quantity: '60000000', quantityLabel: '60 M', unitLabel: '哈夫币', costAmount: '150.00', costLabel: '¥150.00', unitPriceLabel: '¥0.00000250 / 1 哈夫币' }]);
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
  assert.equal(conditionLines({ grading_code: 'future', login_method_code: 'steam_cn' })[0].value, '未确认（代码 future）');
  assert.equal(conditionLines({ grading_code: 'future', login_method_code: 'steam_cn' })[1].value, '未确认（代码 steam_cn）');
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
  assert.equal(differentCode.resourceLines[0].name, '六级子弹');
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
  assert.equal(card.resourceLines[0].name, '未确认（代码 item_haff）');
});

const accountCardCode = ts.transpileModule(
  readFileSync(new URL('../src/components/delta/account-card.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }
).outputText;

const accountCardExports = {};
new Function('require', 'exports', accountCardCode)((name) => {
  if (name === '@/lib/listing-view') return { haffRatioLabel, resourceQuantityLabel };
  if (name === '@/lib/account-return') return {};
  if (name === './login-method-icon') return { LoginMethodIcon: () => null };
  if (name === '@/components/favorites/favorite-button') return { FavoriteButton: () => null };
  if (name === '@/components/ui/tooltip') return { Tooltip: () => null, TooltipContent: () => null, TooltipTrigger: () => null };
  if (name === '@/components/ui/thumbnail-carousel') return { ThumbnailCarousel: () => null };
  return {};
}, accountCardExports);

const { composeGridTitle, composeListTitle, orderedQuoteResources, skinChipTone, moneyValue, listTermRuleLabel } = accountCardExports;

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
    rest: '3×3安全箱 · 钻石 50级',
  });

  // Case 2: No haff + composite parts
  assert.deepEqual(composeGridTitle(cardWithSafeBoxAndRank, null), {
    haff: null,
    rest: '3×3安全箱 · 钻石 50级',
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

  // Case 7: All missing -> fallback to displayNo or generic
  const cardEmpty = {
    title: '',
    displayNo: 'A-005',
    conditionLines: [],
  };
  assert.deepEqual(composeGridTitle(cardEmpty, null), {
    haff: null,
    rest: '账号 A-005',
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

  // Case 1: Real displayNo identity + haff highlight + safe box and rank secondary
  assert.deepEqual(composeListTitle(cardWithSafeBoxAndRank, '120M'), {
    identity: '账号 A-101',
    haff: '120M 哈夫币',
    rest: '1×2安全箱 · 白银 30级',
  });

  // Case 2: DisplayNo identity without safe box
  const cardWithoutSafeBox = {
    title: '120M 哈夫币 极品全装号',
    displayNo: 'A-102',
    conditionLines: [
      { key: 'grading_code', value: '白银' },
    ],
  };
  assert.deepEqual(composeListTitle(cardWithoutSafeBox, '120M'), {
    identity: '账号 A-102',
    haff: '120M 哈夫币',
    rest: '白银',
  });

  // Case 3: Custom title identity when displayNo is absent
  const cardCustomTitle = {
    title: '三角洲行动 · 顶配战术号',
    displayNo: null,
    conditionLines: [],
  };
  assert.deepEqual(composeListTitle(cardCustomTitle, '120M'), {
    identity: '三角洲行动 · 顶配战术号',
    haff: '120M 哈夫币',
    rest: '',
  });

  assert.equal(composeListTitle({
    title: '铂金段位·377M哈夫币·多资源配置',
    displayNo: null,
    conditionLines: [],
  }, '377M').identity, '铂金段位 · 多资源配置');

  // Case 4: Missing identity and title fallback
  const cardEmpty = {
    title: '',
    displayNo: null,
    conditionLines: [],
  };
  assert.deepEqual(composeListTitle(cardEmpty, null), {
    identity: '游戏账号',
    haff: null,
    rest: '',
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

test('missing term rule stays explicitly unconfirmed', () => {
  assert.equal(listTermRuleLabel(null), '租期规则待确认');
  assert.equal(listTermRuleLabel(''), '租期规则待确认');
  assert.equal(listTermRuleLabel('日消耗 10M (测试)'), '租期规则 待确认');
  assert.equal(listTermRuleLabel('按月租用'), '租期规则 按月租用');
});
