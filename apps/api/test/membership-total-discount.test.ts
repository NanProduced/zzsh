import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTotalDiscountToQuote, allocateCombinedDiscount, payableCentsFor, unitAmountForCents } from "../src/auth/membership-total-discount";
import { computeDeltaQuote, type InternalQuote, type QuoteInput } from "../src/supply/pricing";
import { computeSettlement, SETTLEMENT_ROUNDING_POLICY, type SettlementInventoryLine } from "../src/order/settlement";
import { compatRule } from "./pricing-compat-fixture";

/** 3-cent haff + 3-cent item base quote (owner side low enough for a 90% synthetic payable share). */
function threePlusThree(): QuoteInput {
  return {
    priceVersionId: "price-v1", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1", customerTier: "STANDARD", haffRule: compatRule("70"),
    lines: [
      { itemId: "item-haff", quantity: "15600", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", customerTier: "STANDARD" },
      { itemId: "item-a", quantity: "1", unit: "PIECE", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "0.03", ownerUnitAmount: "0.01", customerTier: "STANDARD" },
    ],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "ordinary" } },
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
    deposits: { tenantDepositCents: "0", publisherBailRequirementCents: "0" },
  };
}

function settlementLine(quote: InternalQuote, itemId: string, remaining: string): SettlementInventoryLine {
  const line = quote.lines.find((entry) => entry.itemId === itemId)!;
  const ratio = quote.pricingInputs.exactRatios.find((entry) => entry.itemId === itemId);
  return {
    itemId, unit: line.unit, pricingKind: line.pricingKind, openingQuantity: line.quantity, remainingQuantity: remaining, unitQuantity: line.unitQuantity,
    buyerUnitAmount: line.buyerUnitAmount.amount, ownerUnitAmount: line.ownerUnitAmount.amount,
    prepaidBuyerAmount: line.buyerAmount.amount, prepaidOwnerAmount: line.ownerAmount.amount,
    ...(ratio ? { exactRatio: { buyerNumerator: ratio.buyerNumerator, buyerDenominator: ratio.buyerDenominator, ownerNumerator: ratio.ownerNumerator, ownerDenominator: ratio.ownerDenominator } } : {}),
  };
}

test("total discount rounds the combined base once: 3 + 3 cents at 90% is 5, never 6", () => {
  const base = computeDeltaQuote(threePlusThree());
  assert.equal(base.quotable, true);
  if (!base.quotable) return;
  assert.equal(base.quote.resourceTotal.amount, "0.06");
  assert.equal(base.quote.ownerTotal.amount, "0.03");
  const discounted = applyTotalDiscountToQuote(base.quote, "0.9");
  assert.ok(discounted);
  assert.equal(discounted.payableCents, 5n);
  assert.equal(discounted.discountCents, 1n);
  assert.equal(discounted.quote.resourceTotal.amount, "0.05");
  assert.equal(discounted.quote.ownerTotal.amount, "0.03");
  assert.equal(discounted.quote.platformFullProfit.amount, "0.02");
  const buyers = Object.fromEntries(discounted.quote.lines.map((line) => [line.itemId, line.buyerAmount.amount]));
  assert.deepEqual(buyers, { "item-a": "0.02", "item-haff": "0.03" }); // one line absorbs the remainder; 0.02 + 0.03 = 0.05
  for (const line of discounted.quote.lines) assert.ok(Number(line.buyerAmount.amount) >= Number(line.ownerAmount.amount));
  // Per-line rounding would have produced 0.03 + 0.03 = 0.06.
  assert.notEqual(Object.values(buyers).reduce((sum, value) => sum + Number(value), 0), 0.06);
});

test("total discount refuses invalid ratios and owner-income reduction, and keeps zero bases legal", () => {
  assert.equal(payableCentsFor(600n, "0.9"), 540n);
  assert.equal(payableCentsFor(5n, "1"), 5n);
  assert.equal(payableCentsFor(5n, "0.5"), 3n); // HALF_UP
  assert.equal(payableCentsFor(5n, "0.90000001"), 5n);
  assert.equal(payableCentsFor(5n, "0"), null);
  assert.equal(payableCentsFor(5n, "1.5"), null);
  assert.equal(payableCentsFor(5n, "abc"), null);
  assert.equal(payableCentsFor(5n, ""), null);
  const base = computeDeltaQuote(threePlusThree());
  if (!base.quotable) return;
  assert.equal(applyTotalDiscountToQuote(base.quote, "0.3"), null); // payable 0.02 < owner 0.03
  assert.equal(applyTotalDiscountToQuote(base.quote, "2"), null);
  // A zero base total pays zero and keeps the legal-zero order shape.
  assert.equal(payableCentsFor(0n, "0.9"), 0n);
  const zeroLines = allocateCombinedDiscount([{ itemId: "item-a", buyerCents: 0n, ownerCents: 0n }], 0n);
  assert.deepEqual(zeroLines, [0n]);
});

test("combined allocation keeps the component sum, owner floors and a stable order", () => {
  const lines = [
    { itemId: "item-a", buyerCents: 1000n, ownerCents: 400n },
    { itemId: "item-b", buyerCents: 333n, ownerCents: 300n },
    { itemId: "item-c", buyerCents: 1n, ownerCents: 1n },
  ];
  const payable = 900n;
  const first = allocateCombinedDiscount(lines, payable);
  assert.ok(first);
  assert.equal(first.reduce((sum, value) => sum + value, 0n), payable);
  for (const [index, line] of lines.entries()) assert.ok(first[index]! >= line.ownerCents, `${line.itemId} below owner floor`);
  assert.deepEqual(allocateCombinedDiscount(lines, payable), first); // deterministic
  assert.equal(allocateCombinedDiscount(lines, 300n), null); // below owner floor total
  assert.equal(allocateCombinedDiscount(lines, 2000n), null); // payable above base total
});

test("unit amount solver reproduces settlement cents exactly and never goes below the owner unit", () => {
  const solved = unitAmountForCents(2n, 1n, "0.01000000", 1n, 1n);
  assert.ok(solved);
  assert.equal(solved.achievedCents, 2n);
  assert.ok(BigInt(solved.unitAmount.replace(".", "")) >= 1_000_000n);
  assert.deepEqual(unitAmountForCents(1n, 1n, "0.01000000", 1n, 1n), { unitAmount: "0.01000000", achievedCents: 1n });
  assert.equal(unitAmountForCents(1n, 0n, "0.00000000", 0n, 1n), null);
});

test("frozen discounted quote settles with conservation, discount-aware consumption and early makeup", () => {
  const base = computeDeltaQuote(threePlusThree());
  assert.equal(base.quotable, true);
  if (!base.quotable) return;
  const discounted = applyTotalDiscountToQuote(base.quote, "0.9");
  assert.ok(discounted);
  const quote = discounted.quote;
  const haff = settlementLine(quote, "item-haff", "0");
  const item = settlementLine(quote, "item-a", "0");
  const common = {
    orderId: "order-1", settlementVersionId: "sv-1", openingVersionId: "op-1", quoteDigest: "d".repeat(64), paymentDigest: "p".repeat(64),
    roundingPolicy: SETTLEMENT_ROUNDING_POLICY, feePolicyVersion: "1", renterUserId: "renter-1", ownerUserId: "owner-1",
    depositAmount: "0.00", capturedAmount: "0.05", fullPayout: "NOT_SELECTED" as const, fullPayoutPolicyRef: null,
  };
  // Normal full consumption: renter charge equals the discounted prepaid total, owner keeps the frozen owner total.
  const normal = computeSettlement({ ...common, rentalStarted: true, endReason: "NORMAL", haff, items: [item] });
  assert.equal(normal.ok, true, JSON.stringify(normal));
  assert.equal(normal.amounts!.renterCharge.amount, "0.05");
  assert.equal(normal.amounts!.renterRefund.amount, "0.00");
  assert.equal(normal.amounts!.ownerNet.amount, "0.03");
  assert.equal(normal.amounts!.haffConsumedBuyer.amount, "0.03");
  assert.equal(normal.amounts!.itemConsumedBuyer.amount, "0.02");
  assert.equal(normal.amounts!.platformContribution.amount, "0.02"); // base spread 0.03 − discount 0.01
  // Partial consumption refunds the unused discounted prepayment, never the pre-discount amount.
  const partial = computeSettlement({ ...common, rentalStarted: true, endReason: "TENANT_VOLUNTARY_EARLY", haff: settlementLine(quote, "item-haff", "5600"), items: [settlementLine(quote, "item-a", "1")] });
  assert.equal(partial.ok, true, JSON.stringify(partial));
  assert.equal(partial.amounts!.haffConsumedBuyer.amount, "0.02"); // 10000/15600 × 0.03
  assert.equal(partial.amounts!.itemConsumedBuyer.amount, "0.00");
  const cents = (value: string) => BigInt(value.replace(".", ""));
  assert.equal(cents(partial.amounts!.renterCharge.amount), cents("0.02") + cents(partial.amounts!.earlyMakeup.amount));
  assert.equal(cents(partial.amounts!.renterCharge.amount) + cents(partial.amounts!.renterRefund.amount), cents("0.05"));
  assert.ok(Number(partial.amounts!.unusedHaffRefund.amount) + Number(partial.amounts!.unusedItemRefund.amount) > 0);
  // The legacy (undiscounted) quote stays fully consumable under the same settlement contract.
  const legacy = computeSettlement({ ...common, capturedAmount: "0.06", rentalStarted: true, endReason: "NORMAL", haff: settlementLine(base.quote, "item-haff", "0"), items: [settlementLine(base.quote, "item-a", "0")] });
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(legacy.amounts!.renterCharge.amount, "0.06");
  assert.equal(legacy.amounts!.ownerNet.amount, "0.03");
});
