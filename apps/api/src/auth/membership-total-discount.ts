import { ceilDiv, decimalToBigInt, divideToScale, formatScaledInteger, multiplyDecimal, parseNonNegativeDecimal, yuanAmountObject } from "../supply/decimal";
import { normalizeQuote } from "../supply/content-hash";
import type { InternalQuote, QuoteExactRatio, QuoteLine } from "../supply/pricing";

/**
 * Owner rule (2026-10-19): membership and entitlement benefits discount the combined base total of
 * haff rent + item resource fees once, expressed as a payable share. Per-line amounts are a stable
 * allocation of that single aggregate discount so the frozen order/settlement basis stays consistent;
 * the base haff rule and item unit prices are never rewritten.
 */

const RATIO_SCALE = 100_000_000n; // payroll ratio is parsed at 8 decimals

export function centsOfAmount(amount: string): bigint {
  return decimalToBigInt(parseNonNegativeDecimal(amount, 2, "amount"), 2);
}

/** HALF_UP cents for `baseCents × payableRatio` (ratio text in (0, 1]). */
export function payableCentsFor(baseCents: bigint, payableRatio: string): bigint | null {
  let ratio: { value: bigint; scale: number };
  try { ratio = parseNonNegativeDecimal(payableRatio, 8, "payableRatio"); } catch { return null; }
  const divisor = 10n ** BigInt(ratio.scale);
  if (ratio.value <= 0n || ratio.value > divisor) return null; // (0, 1]
  return (baseCents * ratio.value + divisor / 2n) / divisor;
}

export type DiscountLineFact = { itemId: string; buyerCents: bigint; ownerCents: bigint };

/**
 * Stable allocation of one combined discount across lines, capped by each line's own margin so no
 * component ever drops below its owner amount. Proportional shares (floor) with the remainder handed
 * out by largest fractional part; ties resolve by larger base amount, then itemId.
 */
export function allocateCombinedDiscount(lines: readonly DiscountLineFact[], payableCents: bigint): bigint[] | null {
  const baseTotal = lines.reduce((sum, line) => sum + line.buyerCents, 0n);
  if (payableCents < 0n || payableCents > baseTotal) return null;
  let remaining = baseTotal - payableCents;
  const discounts = lines.map(() => 0n);
  const capacity = lines.map((line) => line.buyerCents > line.ownerCents ? line.buyerCents - line.ownerCents : 0n);
  if (remaining > capacity.reduce((sum, value) => sum + value, 0n)) return null; // would reduce owner income
  let guard = lines.length + 2;
  while (remaining > 0n) {
    if (guard-- <= 0) return null;
    const active = lines.map((_line, index) => index).filter((index) => capacity[index]! > 0n);
    if (active.length === 0) return null;
    const weightTotal = active.reduce((sum, index) => sum + lines[index]!.buyerCents, 0n);
    let progressed = false;
    if (weightTotal > 0n) {
      const take = active.map((index) => {
        const share = (remaining * lines[index]!.buyerCents) / weightTotal;
        return share < capacity[index]! ? share : capacity[index]!;
      });
      const takeTotal = take.reduce((sum, value) => sum + value, 0n);
      if (takeTotal > 0n) {
        active.forEach((index, position) => { discounts[index]! += take[position]!; capacity[index]! -= take[position]!; });
        remaining -= takeTotal;
        progressed = true;
      }
    }
    if (!progressed) {
      const ranked = [...active].sort((left, right) => {
        const leftRemainder = weightTotal > 0n ? (remaining * lines[left]!.buyerCents) % weightTotal : 0n;
        const rightRemainder = weightTotal > 0n ? (remaining * lines[right]!.buyerCents) % weightTotal : 0n;
        if (leftRemainder !== rightRemainder) return leftRemainder > rightRemainder ? -1 : 1;
        if (lines[left]!.buyerCents !== lines[right]!.buyerCents) return lines[left]!.buyerCents > lines[right]!.buyerCents ? -1 : 1;
        return lines[left]!.itemId.localeCompare(lines[right]!.itemId);
      });
      for (const index of ranked) {
        if (remaining === 0n) break;
        if (capacity[index]! <= 0n) continue;
        discounts[index]! += 1n; capacity[index]! -= 1n; remaining -= 1n;
        progressed = true;
      }
    }
    if (!progressed) return null;
  }
  return lines.map((line, index) => line.buyerCents - discounts[index]!);
}

/** Smallest 8-decimal unit amount whose settlement formula (`quantity × unit / unitQuantity`, HALF_UP) yields exactly `targetCents`. */
export function unitAmountForCents(targetCents: bigint, ownerCents: bigint, ownerUnitAmount: string, quantity: bigint, unitQuantity: bigint): { unitAmount: string; achievedCents: bigint } | null {
  if (targetCents < 0n || quantity < 0n || unitQuantity <= 0n) return null;
  if (targetCents === ownerCents) return { unitAmount: ownerUnitAmount, achievedCents: ownerCents };
  if (quantity === 0n) return targetCents === 0n ? { unitAmount: "0", achievedCents: 0n } : null;
  const achieved = (unit: bigint) => divideToScale(multiplyDecimal({ value: quantity, scale: 0 }, { value: unit, scale: 8 }), { value: unitQuantity, scale: 0 }, 2).value;
  // Half-up to `targetCents` means unit ∈ ((2C−1)·uQ·1e6 / 2q, (2C+1)·uQ·1e6 / 2q); pick the smallest integer inside.
  const lower = (2n * targetCents - 1n) * unitQuantity * 1_000_000n;
  const denominator = 2n * quantity;
  let unit = lower <= 0n ? 0n : ceilDiv(lower, denominator);
  for (let step = 0; step < 4; step += 1) {
    const value = achieved(unit);
    if (value === targetCents) return { unitAmount: formatScaledInteger(unit, 8), achievedCents: value };
    if (value < targetCents) unit += 1n; else unit -= 1n;
  }
  return null; // the rounding grid skips this value: fail closed rather than misstate an amount
}

export type TotalDiscountQuoteResult = { quote: InternalQuote; baseCents: bigint; payableCents: bigint; discountCents: bigint };

/**
 * Applies one aggregate discount to a frozen base quote: resourceTotal becomes the payable total,
 * ownerTotal and every owner amount stay untouched, and each line's buyer side is rewritten so the
 * settlement formulas reproduce the allocated cents exactly.
 */
export function applyTotalDiscountToQuote(quote: InternalQuote, payableRatio: string): TotalDiscountQuoteResult | null {
  const baseCents = centsOfAmount(quote.resourceTotal.amount);
  const ownerTotalCents = centsOfAmount(quote.ownerTotal.amount);
  const payableCents = payableCentsFor(baseCents, payableRatio);
  if (payableCents === null || payableCents > baseCents) return null;
  if (payableCents < ownerTotalCents) return null; // owner income can never be reduced by a member discount
  const facts: DiscountLineFact[] = quote.lines.map((line) => ({ itemId: line.itemId, buyerCents: centsOfAmount(line.buyerAmount.amount), ownerCents: centsOfAmount(line.ownerAmount.amount) }));
  const payableLines = allocateCombinedDiscount(facts, payableCents);
  if (!payableLines) return null;
  const baseRatioByItem = new Map(quote.pricingInputs.exactRatios.map((ratio) => [ratio.itemId, ratio]));
  const nextLines: QuoteLine[] = [];
  const nextRatios: QuoteExactRatio[] = [];
  for (let index = 0; index < quote.lines.length; index += 1) {
    const line = quote.lines[index]!;
    const fact = facts[index]!;
    const payable = payableLines[index]!;
    const platformAmount = yuanAmountObject(payable - fact.ownerCents);
    if (line.pricingKind === "HAFF_RATIO") {
      const quantity = decimalToBigInt(parseNonNegativeDecimal(line.quantity, 0, "quantity"), 0);
      const baseRatio = baseRatioByItem.get(line.itemId);
      if (!baseRatio) return null;
      // Payable prepaid amount as a rational over the full quantity keeps consumption proportional to the frozen discount.
      nextRatios.push({ itemId: line.itemId, buyerNumerator: payable.toString(), buyerDenominator: "100", ownerNumerator: baseRatio.ownerNumerator, ownerDenominator: baseRatio.ownerDenominator });
      const buyerUnitAmount = quantity > 0n ? divideToScale({ value: payable, scale: 2 }, { value: quantity, scale: 0 }, 8) : parseNonNegativeDecimal(line.buyerUnitAmount.amount, 8, "buyerUnit");
      nextLines.push({ ...line, buyerUnitAmount: { currency: "CNY", unit: "yuan", amount: formatScaledInteger(buyerUnitAmount.value, 8), scale: 8 }, buyerAmount: yuanAmountObject(payable), platformAmount });
      continue;
    }
    const quantity = decimalToBigInt(parseNonNegativeDecimal(line.quantity, 0, "quantity"), 0);
    const unitQuantity = decimalToBigInt(parseNonNegativeDecimal(line.unitQuantity, 0, "unitQuantity"), 0);
    const solved = unitAmountForCents(payable, fact.ownerCents, line.ownerUnitAmount.amount, quantity, unitQuantity);
    if (!solved) return null;
    nextLines.push({ ...line, buyerUnitAmount: { currency: "CNY", unit: "yuan", amount: solved.unitAmount, scale: 8 }, buyerAmount: yuanAmountObject(payable), platformAmount });
  }
  const discounted = normalizeQuote({
    ...quote, lines: nextLines,
    resourceTotal: yuanAmountObject(payableCents),
    platformFullProfit: yuanAmountObject(payableCents - ownerTotalCents),
    pricingInputs: { ...quote.pricingInputs, exactRatios: nextRatios },
  });
  return { quote: discounted, baseCents, payableCents, discountCents: baseCents - payableCents };
}
