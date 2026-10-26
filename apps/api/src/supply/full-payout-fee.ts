import { DecimalError, divideToScale } from './decimal';

export const FULL_PAYOUT_FEE_ROUNDING_POLICY = 'HALF_UP_CENT_V1_SETTLEMENT_TOTAL_V1';
export const FULL_PAYOUT_RATE = { numerator: 8n, denominator: 100n };

/** One total in cents; fee is rounded once, never once per inventory line. */
export function fullPayoutServiceFeeCents(baseCents: bigint): bigint {
  if (baseCents < 0n) throw new DecimalError('Full-payout fee base must not be negative');
  return divideToScale({ value: baseCents * FULL_PAYOUT_RATE.numerator, scale: 0 }, { value: FULL_PAYOUT_RATE.denominator, scale: 0 }, 0).value;
}
