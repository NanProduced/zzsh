import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseFromHaffM,
  baseQuantityText,
  beijingInputFromIso,
  buildRentalPricing,
  centsOfMoney,
  centsText,
  customTermOptions,
  depositDeclarationCents,
  fullPayoutSelected,
  haffMInputFromBase,
  haffMText,
  isoFromBeijingInput,
  minutesToTimeValue,
  matchedOwnerNetEstimate,
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

const feeMoney = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
const feePreview = (selected = true) => ({
  state: 'READY', binding: { releaseId: 'r1', catalogRevision: '1' }, totalExpectedIncome: feeMoney('215.67'),
  normalEndEstimate: { schema: 'owner-normal-end-estimate.v1', state: 'READY', scenario: 'ALL_DECLARED_INVENTORY_CONSUMED_NORMAL_END', selected,
    ownerGross: feeMoney('215.67'), serviceFee: { base: feeMoney(selected ? '215.67' : '0.00'), rate: selected ? '0.08' : '0', amount: feeMoney(selected ? '17.25' : '0.00'), payer: selected ? 'OWNER' : 'NONE' },
    ownerNet: feeMoney(selected ? '198.42' : '215.67'), policy: selected ? { fullPayoutPolicyRef: 'policy', fullPayoutPolicyVersion: '1', disclosureVersion: 'd1' } : null,
  },
});

test('normal-end estimate consumes server net and explicit zero without reusing another selection', () => {
  assert.equal(matchedOwnerNetEstimate(feePreview(), true).ownerNet.amount, '198.42');
  assert.equal(matchedOwnerNetEstimate(feePreview(false), false).serviceFee.amount.amount, '0.00');
  assert.equal(matchedOwnerNetEstimate(feePreview(), false), null);
  assert.equal(matchedOwnerNetEstimate(feePreview(), null), null);
  assert.equal(matchedOwnerNetEstimate({ ...feePreview(), normalEndEstimate: undefined }, true), null);
  assert.equal(matchedOwnerNetEstimate({ ...feePreview(), state: 'PARTIAL' }, true), null);
});

test('normal-end estimate rejects incomplete, malformed and mismatched quote facts', () => {
  for (const change of [
    p => { p.normalEndEstimate.state = 'INCOMPLETE'; },
    p => { p.normalEndEstimate.ownerNet = null; },
    p => { p.normalEndEstimate.serviceFee.amount = null; },
    p => { p.normalEndEstimate.ownerNet = feeMoney('198.43'); },
    p => { p.normalEndEstimate.ownerNet.currency = 'USD'; },
    p => { p.normalEndEstimate.ownerNet.amount = 198.42; },
    p => { p.normalEndEstimate.policy = null; },
  ]) { const p = feePreview(); change(p); assert.equal(matchedOwnerNetEstimate(p, true), null); }
  const quote = { ruleReleaseId: 'r1', catalogRevision: '1', ownerTotal: feeMoney('215.67') };
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, quote).ownerNet.amount, '198.42');
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, { ...quote, ownerTotal: feeMoney('215.68') }), null);
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, { ...quote, ruleReleaseId: 'r2' }), null);
  assert.equal(matchedOwnerNetEstimate(feePreview(), true, { ...quote, catalogRevision: '2' }), null);
});

test('custom term selection uses actual consumption and the published allowed codes', () => {
  const termOptions = [{ code: 'fake-10m', dailyConsumption: '20000000' }, { code: 'unmapped', dailyConsumption: '10000000' }, { code: 'allowed', dailyConsumption: '10000000' }];
  assert.deepEqual(customTermOptions({ termOptions, rentalTermOptions: { custom: { termOptionCodes: ['allowed'] } } }).map(t => t.code), ['allowed']);
  assert.deepEqual(customTermOptions({ termOptions, rentalTermOptions: { custom: { termOptionCodes: [] } } }), []);
  assert.deepEqual(customTermOptions({ termOptions }).map(t => t.code), ['unmapped', 'allowed']);
});

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
  assert.equal(ratioRangeText({ min: { base: 'C', value: '-1' }, max: { base: 'C', value: '2' } }), '普通比例-1 ~ 普通比例+2');
  assert.equal(ratioRangeText({ min: { base: 'ABSOLUTE', value: '39' }, max: { base: 'ABSOLUTE', value: '41' } }), '39 ~ 41');
  assert.equal(ratioRangeText({ min: { base: 'C', value: '6' } }), '最低 普通比例+6');
  assert.equal(ratioRangeText({ min: { base: 'ABSOLUTE', value: '39' } }), '最低 39');
  assert.equal(ratioRangeText({ max: { base: 'C', value: '2' } }), '最高 普通比例+2');
  assert.equal(ratioRangeText({}), null);
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
