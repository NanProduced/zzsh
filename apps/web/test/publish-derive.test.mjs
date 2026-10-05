import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseFromHaffM,
  baseQuantityText,
  beijingInputFromIso,
  buildRentalPricing,
  centsOfMoney,
  centsText,
  depositDeclarationCents,
  fullPayoutSelected,
  haffMInputFromBase,
  haffMText,
  isoFromBeijingInput,
  minutesToTimeValue,
  normalizeRatioInput,
  ownerQuoteBreakdown,
  ratioRangeText,
  rentalModeLabel,
  rentalPricingOf,
  roundGroupText,
  timeValueToMinutes,
  yuanFromCents,
  yuanToCents,
} from '../src/lib/publish-derive.ts';

test('owner quote breakdown sums server line amounts by unit without recomputing prices', () => {
  const breakdown = ownerQuoteBreakdown({
    ownerTotal: { amount: '310.25' },
    lines: [
      { unit: 'HAFF_BASE', ownerAmount: { amount: '300.00' } },
      { unit: 'ROUND', ownerAmount: { amount: '8.15' } },
      { unit: 'PIECE', ownerAmount: { amount: '2.10' } },
    ],
  });
  assert.deepEqual(breakdown, { haffCents: 30000n, itemCents: 1025n, totalCents: 31025n });
  assert.equal(centsText(breakdown.totalCents), '310.25');
  assert.equal(centsOfMoney({ amount: '0.01' }), 1n);
  assert.equal(centsOfMoney({ amount: '1e3' }), null);
  assert.equal(ownerQuoteBreakdown(null), null);
  assert.equal(
    ownerQuoteBreakdown({ ownerTotal: { amount: '999.00' }, lines: [{ unit: 'HAFF_BASE', ownerAmount: { amount: '1.00' } }] }),
    null,
    'a line sum that disagrees with ownerTotal must not be presented as a complete quote',
  );
});

test('haff M input converts to base exactly without floating point or lost remainder', () => {
  assert.equal(haffMInputFromBase('60000000'), '60');
  assert.equal(haffMInputFromBase('60500000'), '60.5');
  assert.equal(haffMInputFromBase('60000001'), '60.000001');
  assert.equal(haffMInputFromBase(''), '');
  assert.equal(baseFromHaffM('60'), '60000000');
  assert.equal(baseFromHaffM('60.5'), '60500000');
  assert.equal(baseFromHaffM('0.000001'), '1');
  assert.equal(baseFromHaffM('0'), '0');
  assert.equal(baseFromHaffM(''), null);
  assert.equal(baseFromHaffM('1.2345678'), null, 'more than 6 decimals is rejected, not rounded');
  assert.equal(baseFromHaffM('abc'), null);
  assert.equal(baseQuantityText('60500001'), '60,500,001');
});

test('beijing datetime input round-trips instants without shifting eight hours', () => {
  assert.equal(beijingInputFromIso('2026-10-01T04:00:00.000Z'), '2026-10-01T12:00');
  assert.equal(isoFromBeijingInput('2026-10-01T12:00'), '2026-10-01T04:00:00.000Z');
  assert.equal(beijingInputFromIso(isoFromBeijingInput('2026-01-01T00:00')), '2026-01-01T00:00');
  assert.equal(isoFromBeijingInput('2026-02-30T10:00'), null, 'impossible calendar days are rejected');
  assert.equal(isoFromBeijingInput('not-a-date'), null);
  assert.equal(beijingInputFromIso(null), '');
});

test('haff and round formatting keep M and group semantics', () => {
  assert.equal(haffMText('300000000'), '300 M');
  assert.equal(haffMText('3500000'), '3 M 500000');
  assert.equal(haffMText('0'), '0 M');
  assert.equal(haffMText('999'), '999');
  assert.equal(haffMText(''), null);
  assert.equal(roundGroupText('1020'), '17 组');
  assert.equal(roundGroupText('970'), '16 组 10 发');
  assert.equal(roundGroupText('0'), '0 发');
});

test('beijing service window minutes round-trip and keep 24:00 visible', () => {
  assert.equal(minutesToTimeValue(540), '09:00');
  assert.equal(minutesToTimeValue(0), '00:00');
  assert.equal(minutesToTimeValue(1440), '24:00');
  assert.equal(minutesToTimeValue(1441), '');
  assert.equal(timeValueToMinutes('23:59'), 1439);
  assert.equal(timeValueToMinutes('24:00'), 1440);
  assert.equal(timeValueToMinutes('9:00'), 540);
  assert.equal(roundGroupText('1020', 60), '17 组');
  assert.equal(roundGroupText('120', 30), '4 组');
});

test('rental pricing selection keeps ordinary B-free and rejects invalid custom values', () => {
  assert.deepEqual(rentalPricingOf({ rentalPricing: { rentalMode: 'fast', ownerRatioB: '48' } }), { rentalMode: 'fast', ownerRatioB: '48' });
  assert.equal(rentalPricingOf({}), null);
  assert.deepEqual(buildRentalPricing('ordinary', '42'), { rentalMode: 'ordinary' });
  assert.equal(buildRentalPricing('custom', ''), null);
  assert.equal(buildRentalPricing('custom', '0'), null);
  assert.equal(buildRentalPricing('fast', 'abc'), null);
  assert.deepEqual(buildRentalPricing('fast', '48.50'), { rentalMode: 'fast', ownerRatioB: '48.5' });
  assert.equal(normalizeRatioInput('0042.500'), '42.5');
});

test('ratio ranges and deposit declarations derive from server payloads only', () => {
  assert.equal(ratioRangeText({ min: { base: 'C', value: '-1' }, max: { base: 'C', value: '2' } }), 'C-1 ~ C+2');
  assert.equal(ratioRangeText({ min: { base: 'ABSOLUTE', value: '39' }, max: { base: 'ABSOLUTE', value: '41' } }), '39 ~ 41');
  assert.equal(ratioRangeText(undefined), null);
  assert.equal(rentalModeLabel('custom'), '自定义比例');
  assert.equal(yuanToCents('300'), '30000');
  assert.equal(yuanToCents('300.5'), '30050');
  assert.equal(yuanToCents('300.555'), null);
  assert.equal(yuanFromCents('30050'), '300.50');
  assert.equal(depositDeclarationCents({ owner_deposit_declaration: { schema: 'owner-deposit-declaration-v1', amountCents: '30000', declarationVersion: '1' } }), '30000');
  assert.equal(depositDeclarationCents({}), null);
  assert.equal(fullPayoutSelected({ full_payout_declaration: { schema: 'full-payout-declaration-v1', selected: true } }), true);
  assert.equal(fullPayoutSelected({}), null);
});
