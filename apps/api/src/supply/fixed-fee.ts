import { DecimalError, divideToScale, formatDecimalExact, parseNonNegativeDecimal } from "./decimal";
import { FULL_PAYOUT_RATE } from "./full-payout-fee";
import type { RentalMode } from "./delta-rental";

export const FIXED_FEE_ALGORITHM = "FIXED_TOTAL_V1" as const;

export type FixedFeeLine = Readonly<{ itemId: string; grossCents: bigint }>;
export type FixedFeeRates = Readonly<Record<RentalMode, string>>;

function fixedFeeRate(rateText: string) {
  if (typeof rateText !== "string" || rateText.length > 10) throw new DecimalError("fixed fee rate is invalid");
  const rate = parseNonNegativeDecimal(rateText, 8, "fixed fee rate");
  if (rate.value >= 10n ** BigInt(rate.scale)) throw new DecimalError("fixed fee rate must be less than one");
  return rate;
}

export function parseFixedFeeRates(value: unknown): FixedFeeRates {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "custom,fast,ordinary") throw new DecimalError("fixed fee rates are incomplete");
  const rates = value as Record<string, unknown>;
  const parse = (mode: RentalMode) => {
    const rate = fixedFeeRate(rates[mode] as string);
    if (rate.value * FULL_PAYOUT_RATE.denominator > 10n ** BigInt(rate.scale) * (FULL_PAYOUT_RATE.denominator - FULL_PAYOUT_RATE.numerator))
      throw new DecimalError("Fixed fee and full-payout fee cannot exceed owner gross income");
    return formatDecimalExact(rate);
  };
  return { ordinary: parse("ordinary"), custom: parse("custom"), fast: parse("fast") };
}

export function fixedFeeRateForMode(rates: FixedFeeRates, mode: RentalMode): string {
  if (!["ordinary", "custom", "fast"].includes(mode)) throw new DecimalError("rental mode is invalid");
  return parseFixedFeeRates(rates)[mode];
}

/** Membership's payable share must leave at least the owner's pre-coverage share. */
export function fixedFeeAllowsPayableRatio(rateText: string, payableRatioText: string): boolean {
  const rate = fixedFeeRate(rateText);
  if (typeof payableRatioText !== "string" || payableRatioText.length > 10) throw new DecimalError("payable ratio is invalid");
  const payable = parseNonNegativeDecimal(payableRatioText, 8, "payable ratio");
  const rateUnit = 10n ** BigInt(rate.scale), payableUnit = 10n ** BigInt(payable.scale);
  if (payable.value <= 0n || payable.value > payableUnit) throw new DecimalError("payable ratio must be in (0, 1]");
  return rate.value * payableUnit + payable.value * rateUnit >= rateUnit * payableUnit;
}

/** Calculates one whole-order fee and allocates its cents without changing the total. */
export function calculateFixedFee(lines: readonly FixedFeeLine[], rateText: string) {
  if (!Array.isArray(lines)) throw new DecimalError("fixed fee input is invalid");
  const rate = fixedFeeRate(rateText);
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line || typeof line.itemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(line.itemId) || seen.has(line.itemId)) throw new DecimalError("fixed fee item is invalid");
    if (typeof line.grossCents !== "bigint" || line.grossCents < 0n) throw new DecimalError("fixed fee base must not be negative");
    seen.add(line.itemId);
  }
  const grossCents = lines.reduce((sum, line) => sum + line.grossCents, 0n);
  const feeCents = divideToScale({ value: grossCents * rate.value, scale: rate.scale }, { value: 1n, scale: 0 }, 0).value;
  const allocations = lines.map((line) => grossCents === 0n ? 0n : line.grossCents * feeCents / grossCents);
  let remainder = feeCents - allocations.reduce((sum, value) => sum + value, 0n);
  if (remainder > 0n) {
    const ranked = lines.map((line, index) => ({ index, itemId: line.itemId, remainder: line.grossCents * feeCents % grossCents }))
      .sort((a, b) => a.remainder === b.remainder ? (a.itemId < b.itemId ? -1 : 1) : a.remainder > b.remainder ? -1 : 1);
    for (const line of ranked) {
      if (remainder === 0n) break;
      allocations[line.index] = allocations[line.index]! + 1n;
      remainder -= 1n;
    }
  }
  if (remainder !== 0n || allocations.some((fee, index) => fee > lines[index]!.grossCents)) throw new DecimalError("fixed fee allocation is invalid");
  return { grossCents, feeCents, lines: lines.map((line, index) => ({
    itemId: line.itemId, grossCents: line.grossCents, feeCents: allocations[index]!, ownerCents: line.grossCents - allocations[index]!,
  })) };
}
