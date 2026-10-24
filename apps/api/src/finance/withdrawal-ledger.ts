import { SecurityApiError } from '../auth/security-core';
import { conflict, invalid } from '../supply/supply-util';
import { divideToScale } from '../supply/decimal';
import { exactCents } from './finance-money';

export type WithdrawalFee =
  | { kind: 'FIXED'; cents: string }
  | { kind: 'RATIO'; numerator: string; denominator: string; rounding: 'HALF_UP_CENT' };
export type WithdrawalAmounts = { grossCents: string; netCents: string; feeCents: string };
export type WithdrawalLedgerInput = WithdrawalAmounts & { id: string; userId: string };
export type WithdrawalLedgerPlan = {
  kind: 'RESERVE' | 'RELEASE' | 'PAYOUT'; intentId: string; subjectUserId: string;
  lines: { accountCode: string; debitCents: string; creditCents: string; counterpartyUserId: string | null }[];
};

function unsigned(value: unknown): bigint {
  const amount = BigInt(exactCents(value));
  if (amount < 0n) throw invalid('Unsigned cents required');
  return amount;
}
const invalidPolicy = () => new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'WITHDRAW_POLICY_INVALID');

/** 只计算已明确给定的用户手续费；渠道费及准入政策不属于此函数。 */
export function calculateWithdrawalAmounts(grossCents: string, feeRule: WithdrawalFee): WithdrawalAmounts {
  const gross = unsigned(grossCents);
  let fee: bigint;
  if (feeRule?.kind === 'FIXED') fee = unsigned(feeRule.cents);
  else if (feeRule?.kind === 'RATIO') {
    const numerator = unsigned(feeRule.numerator), denominator = unsigned(feeRule.denominator);
    if (denominator === 0n || numerator > denominator || feeRule.rounding !== 'HALF_UP_CENT') throw invalidPolicy();
    fee = divideToScale({ value: gross * numerator, scale: 0 }, { value: denominator, scale: 0 }, 0).value;
  } else throw invalidPolicy();
  if (gross <= fee) throw conflict('Net payout must be positive');
  return { grossCents: gross.toString(), netCents: (gross - fee).toString(), feeCents: fee.toString() };
}

/** 共同账本的纯计划；没有来源证明、接纳或写资金能力。 */
export function planWithdrawalLedger(intent: WithdrawalLedgerInput, kind: WithdrawalLedgerPlan['kind']): WithdrawalLedgerPlan {
  if (!intent || typeof intent.id !== 'string' || !intent.id || typeof intent.userId !== 'string' || !intent.userId
    || !['RESERVE', 'PAYOUT', 'RELEASE'].includes(kind)) throw invalid('Withdrawal ledger binding required');
  const gross = unsigned(intent.grossCents), net = unsigned(intent.netCents), fee = unsigned(intent.feeCents);
  if (net === 0n || gross !== net + fee) throw invalid('Frozen payout amounts are invalid');
  const line = (accountCode: string, debitCents: string, creditCents: string, user = true) => ({ accountCode, debitCents, creditCents, counterpartyUserId: user ? intent.userId : null });
  const lines = kind === 'RESERVE'
    ? [line('WALLET_AVAILABLE', intent.grossCents, '0'), line('WALLET_RESERVED', '0', intent.grossCents)]
    : kind === 'RELEASE'
      ? [line('WALLET_RESERVED', intent.grossCents, '0'), line('WALLET_AVAILABLE', '0', intent.grossCents)]
      : [line('WALLET_RESERVED', intent.grossCents, '0'), line('PAYOUT_CLEARING', '0', intent.netCents, false), ...(intent.feeCents === '0' ? [] : [line('WITHDRAW_FEE', '0', intent.feeCents, false)])];
  return { kind, intentId: intent.id, subjectUserId: intent.userId, lines };
}
