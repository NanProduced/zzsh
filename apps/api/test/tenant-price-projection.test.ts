import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeltaQuote, projectDeltaQuote, type InternalQuote, type QuoteInput } from "../src/supply/pricing";
import { applyTotalDiscountToQuote } from "../src/auth/membership-total-discount";
import { publishedBaseRenterHaffRatioWanPerYuan, projectTenantPriceQuote, publishedListingFeeDisplay } from "../src/supply/tenant-price-projection";
import { compatRule } from "./pricing-compat-fixture";
import { projectOrder, type OrderRow } from "../src/order/order";

function input(mode: "SPREAD" | "PERCENT" = "SPREAD", tier: QuoteInput["customerTier"] = "STANDARD", v2 = true): QuoteInput {
  return { priceVersionId: "price-ratio-fixture", mode, commissionRate: "0.1", customerTier: tier, roundingPolicy: "HALF_UP_CENT_V1",
    haffRule: v2 ? compatRule("52") : { schema: "haff-ratio-v1", spreadDelta: "8", baseBySafeBox: { "box-a": "52" }, vitalityDeltaByLevel: { "6": "0" }, bearDeltaByLevel: { "6": "0" }, dailyDeltaByTermOption: { "daily-10m": "0" }, options: { standard: { delta: "0", enabled: true } } },
    lines: [{ itemId: "haff-ratio-fixture", quantity: "1000000", pricingKind: "HAFF_RATIO", unit: "HAFF_BASE", customerTier: tier }],
    conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", ...(v2 ? { rentalPricing: { rentalMode: "ordinary" as const } } : { pricingOptionCode: "standard" }) },
    termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }, deposits: { tenantDepositCents: "10000", publisherBailRequirementCents: "12300" } };
}
function quote(mode: "SPREAD" | "PERCENT" = "SPREAD", tier: QuoteInput["customerTier"] = "STANDARD", v2 = true): InternalQuote {
  const result = computeDeltaQuote(input(mode, tier, v2));
  assert(result.quotable, result.quotable ? "" : `${mode}/${v2 ? "v2" : "v1"}/${tier}: ${result.reasonCodes.join(",")}`);
  return result.quote;
}

test("published buyer denominator is already 万/元 and retains the existing mode admission and eight decimal places", () => {
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(quote()), "44");
  const unsupported = computeDeltaQuote(input("PERCENT"));
  assert.equal(unsupported.quotable, false, "v2 currently admits SPREAD only; this projection must not enable another mode");
  if (!unsupported.quotable) assert(unsupported.reasonCodes.includes("RULE_INPUT_MISSING"));
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(quote("SPREAD", "STANDARD", false)), "44");
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(quote("PERCENT", "STANDARD", false)), "52");
  for (const [rentalMode, ownerRatioB, expected] of [["custom", "50", "42"], ["fast", "64", "52"]] as const) {
    const configured = input(); configured.conditions.rentalPricing = { rentalMode, ownerRatioB };
    const result = computeDeltaQuote(configured); assert(result.quotable);
    assert.equal(publishedBaseRenterHaffRatioWanPerYuan(result.quote), expected);
  }
  const exact = quote(); exact.pricingInputs.denominators!.buyer = "44.12345678";
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(exact), "44.12345678");
  exact.pricingInputs.denominators!.buyer = "44.00000000";
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(exact), "44");
});

test("personal legacy repricing and total discount never replace the published STANDARD ratio", () => {
  const published = quote(), legacySelected = quote("SPREAD", "VIP");
  assert.equal(legacySelected.pricingInputs.denominators!.buyer, "46");
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(legacySelected), null, "a selected non-STANDARD quote is not the publication basis");
  assert.equal(projectTenantPriceQuote(legacySelected, published).baseRenterHaffRatioWanPerYuan, "44");
  const discounted = applyTotalDiscountToQuote(published, "0.9");
  assert(discounted);
  assert.equal(projectTenantPriceQuote(discounted.quote, published).baseRenterHaffRatioWanPerYuan, "44");
  assert.notEqual(projectTenantPriceQuote(discounted.quote, published).resourceTotal.amount, published.resourceTotal.amount);
  assert.equal(projectTenantPriceQuote(discounted.quote, published).unitAmountsInformational, true);
});

test("missing or invalid published denominator is null and is not a quote eligibility gate", () => {
  for (const value of [undefined, null, "0", "-1", 44, "NaN", "4e1", "44.123456789"]) {
    const published = quote(); (published.pricingInputs.denominators as unknown as Record<string, unknown>).buyer = value;
    assert.equal(publishedBaseRenterHaffRatioWanPerYuan(published), null);
    assert.equal(projectTenantPriceQuote(quote(), published).baseRenterHaffRatioWanPerYuan, null);
  }
  const absent = quote(); absent.pricingInputs.denominators = null;
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan(absent), null);
  assert.equal(publishedBaseRenterHaffRatioWanPerYuan({}), null);
});

test("renter projection is a recursive whitelist including amount and expiry objects", () => {
  const internal = quote(), source = internal as unknown as Record<string, any>;
  source.ownerTotal.amount = "98765.43";
  source.resourceTotal.sourceRef = "PRIVATE_RESOURCE_REFERENCE";
  source.lines[0].buyerAmount.cost = "PRIVATE_COST";
  source.lines[0].buyerUnitAmount.keys = "PRIVATE_KEYS";
  source.expiryDisclosures = [{ entitlementId: "public-disclosure", expiresAt: null, fullTermGuaranteed: false, sourceRef: "PRIVATE_EXPIRY_REFERENCE" }];
  const before = JSON.stringify(internal), projected = projectTenantPriceQuote(internal, internal);
  const forbidden = /owner|cost|profit|pricingInputs|sourceRef|publisherBail|keys/i;
  const visit = (value: unknown) => { if (!value || typeof value !== "object") return; for (const [key, child] of Object.entries(value)) { assert.doesNotMatch(key, forbidden); visit(child); } };
  visit(projected); assert.equal(JSON.stringify(internal), before);
  assert(!JSON.stringify(projected).includes("PRIVATE_")); assert(!JSON.stringify(projected).includes("98765.43"));
  assert.equal(projected.tenantDeposit?.amount, "100.00"); assert.equal(projected.tenantPayableTotal?.amount, projectDeltaQuote(internal, "public").tenantPayableTotal?.amount);
});

test("zero amounts keep declared stock, unknown deposits remain null and unitQuantity is never invented", () => {
  const internal = quote(); internal.lines[0]!.buyerAmount.amount = "0.00"; internal.lines[0]!.buyerUnitAmount.amount = "0.00000000"; internal.resourceTotal.amount = "0.00";
  internal.tenantDeposit = null;
  const projected = projectTenantPriceQuote(internal, internal);
  assert.equal(projected.lines[0]!.quantity, "1000000"); assert.equal(projected.lines[0]!.buyerAmount.amount, "0.00");
  assert.equal(projected.tenantDeposit, null); assert.equal(projected.tenantPayableTotal, null);
  (internal.lines[0] as unknown as Record<string, unknown>).unitQuantity = undefined;
  assert.throws(() => projectTenantPriceQuote(internal, internal), (error: unknown) => (error as { status?: number }).status === 503);
});

test("owner quote and order expose own frozen income without renter private prices", () => {
  const internal = quote();
  const before = JSON.stringify(internal);
  const owner = projectDeltaQuote(internal, "owner");
  assert.equal(owner.ownerTotal, internal.ownerTotal);
  for (const key of ["resourceTotal", "tenantDeposit", "tenantPayableTotal", "platformFullProfit", "pricingInputs"]) assert.equal(key in owner, false, key);
  for (const line of owner.lines) {
    assert.equal("buyerAmount" in line, false); assert.equal("buyerUnitAmount" in line, false);
    assert.ok(line.ownerAmount); assert.ok(line.ownerUnitAmount);
  }
  const row = { id: "order-1", quoteSnapshot: internal, status: "PAID", rentalAmountCents: "12345", depositAmountCents: "54321" } as OrderRow;
  const owned = projectOrder(row, "owner") as Record<string, any>;
  assert.deepEqual(owned.amounts, { rental: null, deposit: null, totalDue: null, currency: "CNY", ownerExpectedIncome: internal.ownerTotal });
  assert.equal(owned.amountsPerspective, "OWNER");
  const rented = projectOrder(row, "renter") as Record<string, any>;
  assert.equal(rented.amounts.rental.amount, "123.45");
  assert.equal(rented.quote.ownerTotal, undefined);
  const support = projectOrder(row, "admin") as Record<string, any>;
  assert.ok(support.quote.lines[0].buyerAmount); assert.ok(support.quote.lines[0].ownerAmount);
  assert.equal(support.quote.pricingInputs, undefined);
  assert.equal(JSON.stringify(internal), before);
});

test("order payment provenance distinguishes a simulated confirmation and never asserts bank arrival", () => {
  const base = { id: "order-1", quoteSnapshot: quote(), status: "PAID", rentalAmountCents: "100", depositAmountCents: "0" } as OrderRow;
  for (const party of ["renter", "owner", "admin"] as const) {
    for (const [input,source] of [["CONTROLLED","SIMULATED"],["JOINPAY","JOINPAY"],["OTHER","UNKNOWN"],[null,"UNKNOWN"]] as const) {
      const row = { ...base, paymentSource: input };
      assert.deepEqual(projectOrder(row, party).paymentProvenance, { source, channelArrival: "UNKNOWN" });
    }
    assert.equal("paymentProvenance" in projectOrder({ ...base, status: "PENDING_PAYMENT" }, party), false);
  }
});


test("listing fee display reads sealed tenant money without promoting unknown deposit or missing components", () => {
  const internal = quote(), projected = projectTenantPriceQuote(internal, internal);
  assert.deepEqual(publishedListingFeeDisplay(projected), {
    basis: "PUBLISHED_OFFER", completeness: "COMPLETE", haffRental: projected.resourceTotal,
    materials: { currency: "CNY", unit: "yuan", amount: "0.00", scale: 2 },
    resourceTotal: projected.resourceTotal, deposit: projected.tenantDeposit,
  });
  assert.deepEqual(publishedListingFeeDisplay({ ...projected, lines: undefined, tenantDeposit: null }), {
    basis: "PUBLISHED_OFFER", completeness: "PARTIAL", haffRental: null, materials: null,
    resourceTotal: projected.resourceTotal, deposit: null,
  });
});
