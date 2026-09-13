import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionLines,
  formatMoneyLabel,
  haffMillionsLabel,
  termLabel,
  toListingCard,
  toListingDetail,
  unitLabel,
} from '../src/lib/listing-view.ts';

const listing = {
  id: 'account_1',
  versionId: 'version_1',
  title: '三角洲资源账号',
  description: '合成公开说明',
  attributes: { vit_level: 6, bear_level: null, grading_code: 'gold', region_province: '广东' },
  presentation: {
    items: [{ id: 'item_haff', name: '哈夫币', unit: 'HAFF_BASE' }],
    skins: [{ id: 'skin_1', name: 'M4A1 金色' }],
    entitlements: [],
  },
  quote: {
    schemaVersion: 1,
    currency: 'CNY',
    ruleReleaseId: 'release_1',
    lines: [{ itemId: 'item_haff', quantity: '60000000', unit: 'HAFF_BASE', unitQuantity: '1', buyerUnitAmount: { currency: 'CNY', unit: 'yuan', amount: '0.00000250', scale: 8 }, buyerAmount: { currency: 'CNY', unit: 'yuan', amount: '150.00', scale: 2 } }],
    resourceTotal: { currency: 'CNY', unit: 'yuan', amount: '150.00', scale: 2 },
    tenantDeposit: null,
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
  assert.equal(unitLabel('CUSTOM'), 'CUSTOM');
});

test('card view uses presentation names, public conditions and server totals', () => {
  const card = toListingCard(listing);
  assert.equal(card.id, 'account_1');
  assert.equal(card.resourceTotalLabel, '¥150.00');
  assert.equal(card.depositLabel, null);
  assert.equal(card.termLabel, '6 天');
  assert.deepEqual(card.resourceLines, [{ itemId: 'item_haff', name: '哈夫币', quantityLabel: '60 M', unitLabel: '哈夫币' }]);
  assert.deepEqual(card.skinNames, ['M4A1 金色']);
  assert.deepEqual(card.conditionLines.map((line) => line.key), ['vit_level', 'grading_code', 'region_province']);
  assert.equal(card.conditionLines[0].value, '6 级');
  assert.equal(card.conditionLines[1].value, 'gold');
  assert.equal(card.imageUrl, '/api/supply/listings/account_1/media/asset_a');
  const detail = toListingDetail(listing);
  assert.deepEqual(detail.media.map((media) => media.assetId), ['asset_a', 'asset_b']);
  assert.equal(detail.description, '合成公开说明');
});

test('condition lines skip absent fields and keep unknown keys out', () => {
  assert.deepEqual(conditionLines({ vit_level: null, bear_level: '', grading_code: undefined }), []);
  assert.equal(JSON.stringify(conditionLines({ vit_level: 7 })).includes('safe'), false);
});
