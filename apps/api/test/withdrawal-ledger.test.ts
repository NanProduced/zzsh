// PURE_LEDGER_PLAN：只核共同金额/分录计划，不构造正式来源或实际记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWithdrawalAmounts, planWithdrawalLedger, type WithdrawalLedgerPlan } from '../src/finance/withdrawal-ledger';
import type { WithdrawalLedgerPlan as ControlledLedgerPlan } from '../src/finance/controlled-withdrawal';

const identity = { id: 'pure_withdrawal_model', userId: 'pure_subject' };
function total(plan: WithdrawalLedgerPlan, side: 'debitCents' | 'creditCents') { return plan.lines.reduce((sum, line) => sum + BigInt(line[side]), 0n); }
const status = (code: number) => (error: unknown) => (error as { status?: number }).status === code;

test('共同用户费用只按显式固定或比例规则计算，精确舍入到分', () => {
  assert.deepEqual(calculateWithdrawalAmounts('12345', { kind: 'FIXED', cents: '100' }), { grossCents: '12345', netCents: '12245', feeCents: '100' });
  const ratio = { kind: 'RATIO' as const, numerator: '2', denominator: '100', rounding: 'HALF_UP_CENT' as const };
  assert.deepEqual(calculateWithdrawalAmounts('225', ratio), { grossCents: '225', netCents: '220', feeCents: '5' });
  assert.equal(calculateWithdrawalAmounts('224', ratio).feeCents, '4');
  assert.deepEqual(calculateWithdrawalAmounts('999999999999999999999999', ratio), { grossCents: '999999999999999999999999', feeCents: '20000000000000000000000', netCents: '979999999999999999999999' });
});
test('金额边界和规则错误保持既有400/409/503语义，没有默认费率', () => {
  for (const value of ['-0', '-1', '1.00', '01', '1000000000000000000000000', 100]) assert.throws(() => calculateWithdrawalAmounts(value as string, { kind: 'FIXED', cents: '0' }), status(400));
  assert.throws(() => calculateWithdrawalAmounts('100', { kind: 'FIXED', cents: '-1' }), status(400));
  for (const cents of ['100', '101']) assert.throws(() => calculateWithdrawalAmounts('100', { kind: 'FIXED', cents }), status(409));
  for (const fee of [null, { kind: 'OTHER' }, { kind: 'RATIO', numerator: '1', denominator: '0', rounding: 'HALF_UP_CENT' }, { kind: 'RATIO', numerator: '101', denominator: '100', rounding: 'HALF_UP_CENT' }, { kind: 'RATIO', numerator: '1', denominator: '100', rounding: 'OTHER' }]) assert.throws(() => calculateWithdrawalAmounts('100', fee as never), status(503));
});
test('预留、付款、释放的原形状与精确科目守恒，fee零不产生第三行', () => {
  for (const fee of ['0', '100']) {
    const input = Object.freeze({ ...identity, ...calculateWithdrawalAmounts('12345', { kind: 'FIXED', cents: fee }) });
    for (const kind of ['RESERVE', 'PAYOUT', 'RELEASE'] as const) {
      const plan: ControlledLedgerPlan = planWithdrawalLedger(input, kind);
      assert.deepEqual(Object.keys(plan), ['kind', 'intentId', 'subjectUserId', 'lines']);
      assert.equal(total(plan, 'debitCents'), 12345n); assert.equal(total(plan, 'creditCents'), 12345n);
      assert.equal(plan.lines.length, kind === 'PAYOUT' && fee !== '0' ? 3 : 2);
      const expected = kind === 'RESERVE' ? [['WALLET_AVAILABLE', '12345', '0', identity.userId], ['WALLET_RESERVED', '0', '12345', identity.userId]]
        : kind === 'RELEASE' ? [['WALLET_RESERVED', '12345', '0', identity.userId], ['WALLET_AVAILABLE', '0', '12345', identity.userId]]
          : [['WALLET_RESERVED', '12345', '0', identity.userId], ['PAYOUT_CLEARING', '0', input.netCents, null], ...(fee === '0' ? [] : [['WITHDRAW_FEE', '0', fee, null]])];
      assert.deepEqual(plan.lines.map(l => [l.accountCode, l.debitCents, l.creditCents, l.counterpartyUserId]), expected);
      assert.equal(input.grossCents, '12345');
    }
  }
});
test('纯计划拒绝不守恒、负数、缺主体和未知动作，不借计划获得资金能力', () => {
  const input = { ...identity, grossCents: '100', netCents: '99', feeCents: '1' };
  for (const patch of [{ grossCents: '101' }, { netCents: '0', feeCents: '100' }, { feeCents: '-1' }, { userId: '' }, { id: '' }]) assert.throws(() => planWithdrawalLedger({ ...input, ...patch }, 'PAYOUT'), status(400));
  assert.throws(() => planWithdrawalLedger(input, 'OTHER' as never), status(400));
  const result = planWithdrawalLedger(input, 'PAYOUT'); assert.equal('mode' in result, false); assert.equal('evidenceLevel' in result, false); assert.equal('fact' in result, false);
});
