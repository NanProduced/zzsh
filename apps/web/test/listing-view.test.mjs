import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(resourceQuantityLabel(detail.resourceLines[1]), '3组（180发）');
  assert.equal(resourceQuantityLabel(detail.resourceLines[2]), '3天');
});

test('unmapped resource IDs stay explicit instead of becoming display names', () => {
  const card = toListingCard({
    ...listing,
    presentation: { ...listing.presentation, items: [] },
  });
  assert.equal(card.resourceLines[0].name, '未确认（代码 item_haff）');
});
