import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  computeSettlement,
  settlementConfirmationReady,
  SETTLEMENT_ROUNDING_POLICY,
  type ComputeSettlementInput,
  type SettlementConfirmationFacts,
  type SettlementEndReason,
  type FullPayoutSelection,
} from "../src/order/settlement";

const HAFF = "100000000";

function baseInput(over: {
  remainingHaff: string | null;
  remainingItems: string | null;
  endReason: SettlementEndReason;
  fullPayout?: FullPayoutSelection;
  rentalStarted?: boolean;
  capturedAmount?: string;
  depositAmount?: string;
  haffBuyer?: string;
  haffOwner?: string;
}): ComputeSettlementInput {
  return {
    orderId: "order_1",
    settlementVersionId: "set_v1",
    openingVersionId: "open_v1",
    quoteDigest: "quote_1",
    paymentDigest: "pay_1",
    roundingPolicy: SETTLEMENT_ROUNDING_POLICY,
    feePolicyVersion: "full-payout-v1",
    renterUserId: "user_renter",
    ownerUserId: "user_owner",
    rentalStarted: over.rentalStarted ?? true,
    endReason: over.endReason,
    depositAmount: over.depositAmount ?? "300.00",
    capturedAmount: over.capturedAmount ?? "650.00",
    fullPayout: over.fullPayout ?? "SELECTED",
    fullPayoutPolicyRef: (over.fullPayout ?? "SELECTED") === "SELECTED" ? "policy_v1" : null,
    haff: {
      itemId: "haff",
      unit: "HAFF_BASE",
      pricingKind: "HAFF_RATIO",
      openingQuantity: HAFF,
      remainingQuantity: over.remainingHaff,
      unitQuantity: "1000000",
      buyerUnitAmount: "0",
      ownerUnitAmount: "0",
      prepaidBuyerAmount: over.haffBuyer ?? "250.00",
      prepaidOwnerAmount: over.haffOwner ?? "200.00",
      exactRatio: {
        buyerNumerator: over.haffBuyer ?? "250.00",
        buyerDenominator: "1",
        ownerNumerator: over.haffOwner ?? "200.00",
        ownerDenominator: "1",
      },
    },
    items: [
      {
        itemId: "kit",
        unit: "PIECE",
        pricingKind: "FIXED_UNIT",
        openingQuantity: "10",
        remainingQuantity: over.remainingItems,
        unitQuantity: "1",
        buyerUnitAmount: "10.00000000",
        ownerUnitAmount: "4.00000000",
        prepaidBuyerAmount: "100.00",
        prepaidOwnerAmount: "40.00",
      },
    ],
  };
}

function money(
  result: ReturnType<typeof computeSettlement>,
  key: Exclude<keyof NonNullable<ReturnType<typeof computeSettlement>["amounts"]>, "feePayer" | "feeRate">,
) {
  assert.ok(result.amounts, result.reasons.join(","));
  return result.amounts![key].amount;
}

test("normal 80M/2 items selected payout matches Owner vector", () => {
  const r = computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" }));
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(r.early, false);
  assert.equal(money(r, "ownerGross"), "168.00");
  assert.equal(money(r, "feeAmount"), "13.44");
  assert.equal(r.amounts!.feePayer, "OWNER");
  assert.equal(money(r, "ownerNet"), "154.56");
  assert.equal(money(r, "renterCharge"), "220.00");
  assert.equal(money(r, "renterRefund"), "430.00");
  assert.equal(money(r, "platformContribution"), "65.44");
  assert.equal(money(r, "depositRefund"), "300.00");
  assert.equal(money(r, "earlyMakeup"), "0.00");
});

test("tenant voluntary early 50M/2 items selected payout matches Owner vector", () => {
  const r = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY" }));
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(r.early, true);
  assert.equal(money(r, "ownerGross"), "108.00");
  assert.equal(money(r, "ownerNet"), "108.00");
  assert.equal(money(r, "earlyMakeup"), "25.00");
  assert.equal(money(r, "feeAmount"), "19.20");
  assert.equal(r.amounts!.feePayer, "RENTER");
  assert.equal(money(r, "renterCharge"), "189.20");
  assert.equal(money(r, "renterRefund"), "460.80");
  assert.equal(money(r, "platformContribution"), "81.20");
});

test("owner or account early 50M/2 items does not shift makeup or fee to renter", () => {
  const r = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "OWNER_OR_ACCOUNT_EARLY" }));
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(r.early, true);
  assert.equal(money(r, "earlyMakeup"), "0.00");
  assert.equal(money(r, "feeAmount"), "8.64");
  assert.equal(r.amounts!.feePayer, "OWNER");
  assert.equal(money(r, "ownerNet"), "99.36");
  assert.equal(money(r, "renterCharge"), "145.00");
  assert.equal(money(r, "renterRefund"), "505.00");
  assert.equal(money(r, "platformContribution"), "45.64");
});

test("unselected payout skips fee but keeps applicable haff makeup", () => {
  const r = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY", fullPayout: "NOT_SELECTED" }));
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(money(r, "feeAmount"), "0.00");
  assert.equal(r.amounts!.feePayer, "NONE");
  assert.equal(money(r, "earlyMakeup"), "25.00");
  assert.equal(money(r, "ownerNet"), "108.00");
});

test("unknown payout or end reason cannot auto-settle", () => {
  const unknownPay = computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL", fullPayout: "UNKNOWN" }));
  assert.equal(unknownPay.ok, false);
  assert.ok(unknownPay.reasons.includes("FULL_PAYOUT_UNKNOWN"));
  const unknownEnd = computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "UNKNOWN" }));
  assert.equal(unknownEnd.ok, false);
  assert.ok(unknownEnd.reasons.includes("END_REASON_UNKNOWN"));
});

test("cancel before start charges no fee or makeup", () => {
  const r = computeSettlement(baseInput({ remainingHaff: HAFF, remainingItems: "10", endReason: "CANCELLED_BEFORE_START", rentalStarted: false }));
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(r.early, null);
  assert.equal(money(r, "feeAmount"), "0.00");
  assert.equal(money(r, "earlyMakeup"), "0.00");
  assert.equal(money(r, "ownerNet"), "0.00");
  assert.equal(money(r, "renterRefund"), "650.00");
});

test("started zero consumption tenant voluntary still uses full payout base", () => {
  const r = computeSettlement(baseInput({ remainingHaff: HAFF, remainingItems: "10", endReason: "TENANT_VOLUNTARY_EARLY" }));
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(r.early, true);
  assert.equal(money(r, "feeBase"), "240.00");
  assert.equal(money(r, "feeAmount"), "19.20");
  assert.equal(r.amounts!.feePayer, "RENTER");
  assert.equal(money(r, "earlyMakeup"), "50.00");
});

test("unused and fully used items, deposit fully refunded", () => {
  const unused = computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "10", endReason: "NORMAL" }));
  assert.equal(unused.ok, true, unused.reasons.join(","));
  assert.equal(money(unused, "itemConsumedBuyer"), "0.00");
  assert.equal(money(unused, "unusedItemRefund"), "100.00");
  assert.equal(money(unused, "depositRefund"), "300.00");
  const full = computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "0", endReason: "NORMAL" }));
  assert.equal(full.ok, true, full.reasons.join(","));
  assert.equal(money(full, "itemConsumedBuyer"), "100.00");
  assert.equal(money(full, "unusedItemRefund"), "0.00");
});

test("ROUND 60-unit line uses quote divideToScale", () => {
  const input = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL", fullPayout: "NOT_SELECTED" });
  input.items = [
    {
      itemId: "ammo",
      unit: "ROUND",
      pricingKind: "FIXED_UNIT",
      openingQuantity: "1020",
      remainingQuantity: "900",
      unitQuantity: "60",
      buyerUnitAmount: "10.00000000",
      ownerUnitAmount: "4.00000000",
      prepaidBuyerAmount: "170.00",
      prepaidOwnerAmount: "68.00",
    },
  ];
  input.capturedAmount = "720.00";
  const r = computeSettlement(input);
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(money(r, "itemConsumedBuyer"), "20.00");
  assert.equal(money(r, "itemConsumedOwner"), "8.00");
  assert.equal(money(r, "unusedItemRefund"), "150.00");
});

function yuanCents(amount: string) {
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(amount);
  assert.ok(match, amount);
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

test("50/70 adjacent points and spread-ratio guard", () => {
  const at50 = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY", fullPayout: "NOT_SELECTED" }));
  const over50 = computeSettlement(baseInput({ remainingHaff: "49999999", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY", fullPayout: "NOT_SELECTED" }));
  assert.equal(at50.ok, true, at50.reasons.join(","));
  assert.equal(over50.ok, true, over50.reasons.join(","));
  assert.ok(yuanCents(money(over50, "renterCharge")) >= yuanCents(money(at50, "renterCharge")));
  const at70 = computeSettlement(baseInput({ remainingHaff: "30000000", remainingItems: "8", endReason: "NORMAL", fullPayout: "NOT_SELECTED" }));
  assert.equal(at70.early, false);
  assert.equal(money(at70, "earlyMakeup"), "0.00");
  const bound = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY", fullPayout: "NOT_SELECTED", haffBuyer: "250.00", haffOwner: "150.00" }));
  assert.equal(bound.ok, true, bound.reasons.join(","));
  const unsafe = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY", haffBuyer: "200.00", haffOwner: "80.00" }));
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.reasons.includes("HAFF_SPREAD_RATIO_UNSAFE"));
});

test("unknown remaining, negative, over-opening and insufficient funds block without deposit offset", () => {
  assert.ok(computeSettlement(baseInput({ remainingHaff: null, remainingItems: "8", endReason: "NORMAL" })).reasons.includes("HAFF_REMAINING_UNKNOWN"));
  assert.ok(computeSettlement(baseInput({ remainingHaff: "110000000", remainingItems: "8", endReason: "NORMAL" })).reasons.includes("HAFF_REMAINING_EXCEEDS_OPENING"));
  assert.ok(computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "11", endReason: "NORMAL" })).reasons.includes("ITEM_kit_REMAINING_EXCEEDS_OPENING"));
  const neg = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  neg.haff.remainingQuantity = "-1";
  assert.ok(computeSettlement(neg).reasons.includes("HAFF_REMAINING_NEGATIVE"));
  const short = computeSettlement(baseInput({ remainingHaff: "0", remainingItems: "0", endReason: "NORMAL", capturedAmount: "10.00" }));
  assert.equal(short.ok, false);
  assert.ok(short.reasons.includes("CAPTURED_MISMATCH"));
  assert.equal(short.amounts, null);
});

test("DAY uses existing unit pricing and missing remaining is blocked", () => {
  const input = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL", fullPayout: "NOT_SELECTED" });
  input.items = [
    ...input.items,
    {
    itemId: "card",
    unit: "DAY",
    pricingKind: "FIXED_UNIT",
    openingQuantity: "3",
    remainingQuantity: "1",
    unitQuantity: "1",
    buyerUnitAmount: "5.00000000",
    ownerUnitAmount: "3.00000000",
    prepaidBuyerAmount: "15.00",
    prepaidOwnerAmount: "9.00",
    },
  ];
  input.capturedAmount = "665.00";
  const r = computeSettlement(input);
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(money(r, "itemConsumedBuyer"), "30.00");
  assert.equal(money(r, "itemConsumedOwner"), "14.00");
  const unknownDay = structuredClone(input);
  unknownDay.items[1]!.remainingQuantity = null;
  assert.ok(computeSettlement(unknownDay).reasons.includes("ITEM_card_REMAINING_UNKNOWN"));
});

function confirm(over: Partial<SettlementConfirmationFacts> = {}): SettlementConfirmationFacts {
  return {
    settlementVersionId: "set_v1",
    currentVersionHash: "hash_v1",
    kind: "SYSTEM",
    early: false,
    initiatorParty: "RENTER",
    renterConfirmedVersionId: "set_v1",
    ownerConfirmedVersionId: "set_v1",
    renterRejectedVersionId: null,
    ownerRejectedVersionId: null,
    supportReviewedVersionId: null,
    opsApproval: null,
    ...over,
  };
}

test("early marked as normal, or late marked as early, cannot auto-settle", () => {
  const earlyAsNormal = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "NORMAL" }));
  assert.equal(earlyAsNormal.ok, false);
  assert.equal(earlyAsNormal.early, true);
  assert.ok(earlyAsNormal.reasons.includes("END_REASON_INCONSISTENT"));
  const lateAsEarly = computeSettlement(baseInput({ remainingHaff: "30000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY" }));
  assert.equal(lateAsEarly.ok, false);
  assert.equal(lateAsEarly.early, false);
  assert.ok(lateAsEarly.reasons.includes("END_REASON_INCONSISTENT"));
});

test("selected payout without policy ref cannot auto-settle", () => {
  const input = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  input.fullPayoutPolicyRef = null;
  const r = computeSettlement(input);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes("FULL_PAYOUT_POLICY_REF_MISSING"));
});

test("confirmation: either party may initiate; normal ready without support", () => {
  assert.equal(settlementConfirmationReady(confirm({ initiatorParty: "RENTER" })).ready, true);
  assert.equal(settlementConfirmationReady(confirm({ initiatorParty: "OWNER" })).ready, true);
  const missingOwner = settlementConfirmationReady(confirm({ ownerConfirmedVersionId: null }));
  assert.equal(missingOwner.ready, false);
  assert.ok(missingOwner.reasons.includes("OWNER_CONFIRMATION_MISSING"));
});

test("confirmation: early requires support review of the same version", () => {
  const noSupport = settlementConfirmationReady(confirm({ early: true }));
  assert.equal(noSupport.ready, false);
  assert.ok(noSupport.reasons.includes("SUPPORT_REVIEW_MISSING"));
  assert.equal(settlementConfirmationReady(confirm({ early: true, supportReviewedVersionId: "set_v1" })).ready, true);
  const staleSupport = settlementConfirmationReady(confirm({ early: true, supportReviewedVersionId: "set_old" }));
  assert.equal(staleSupport.ready, false);
});

test("confirmation: stale or rejected versions cannot reuse old acks", () => {
  const stale = settlementConfirmationReady(confirm({ renterConfirmedVersionId: "set_old" }));
  assert.equal(stale.ready, false);
  const rejected = settlementConfirmationReady(confirm({ renterRejectedVersionId: "set_v1" }));
  assert.equal(rejected.ready, false);
  assert.ok(rejected.reasons.includes("PARTY_REJECTED"));
});

test("confirmation: manual adjustment needs non-self ops approval bound to current hash", () => {
  const missing = settlementConfirmationReady(confirm({ kind: "MANUAL_ADJUSTMENT" }));
  assert.equal(missing.ready, false);
  const self = settlementConfirmationReady(confirm({
    kind: "MANUAL_ADJUSTMENT",
    opsApproval: { status: "APPROVED", requesterId: "boss", approverId: "boss", payloadHash: "hash_v1" },
  }));
  assert.equal(self.ready, false);
  assert.ok(self.reasons.includes("OPS_SELF_APPROVE"));
  const staleHash = settlementConfirmationReady(confirm({
    kind: "MANUAL_ADJUSTMENT",
    opsApproval: { status: "APPROVED", requesterId: "cs", approverId: "ops", payloadHash: "old" },
  }));
  assert.equal(staleHash.ready, false);
  const ok = settlementConfirmationReady(confirm({
    kind: "MANUAL_ADJUSTMENT",
    opsApproval: { status: "APPROVED", requesterId: "cs", approverId: "ops", payloadHash: "hash_v1" },
  }));
  assert.equal(ok.ready, true);
  const blankActor = settlementConfirmationReady(confirm({
    kind: "MANUAL_ADJUSTMENT",
    opsApproval: { status: "APPROVED", requesterId: "", approverId: "ops", payloadHash: "hash_v1" },
  }));
  assert.equal(blankActor.ready, false);
  assert.ok(blankActor.reasons.includes("OPS_ACTOR_MISSING"));
});

test("F1: haff consume uses frozen exactRatios, not rounded prepaid", () => {
  const input = baseInput({ remainingHaff: "20000000", remainingItems: "10", endReason: "NORMAL", fullPayout: "NOT_SELECTED" });
  input.items = [];
  input.capturedAmount = "500.00";
  input.haff.prepaidBuyerAmount = "200.00";
  input.haff.prepaidOwnerAmount = "166.67";
  input.haff.exactRatio = {
    buyerNumerator: "10000000000",
    buyerDenominator: "50000000",
    ownerNumerator: "10000000000",
    ownerDenominator: "60000000",
  };
  const r = computeSettlement(input);
  assert.equal(r.ok, true, r.reasons.join(","));
  assert.equal(money(r, "haffConsumedOwner"), "133.33");
  assert.equal(money(r, "haffConsumedBuyer"), "160.00");
  const missing = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  missing.haff.exactRatio = null;
  const blocked = computeSettlement(missing);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.reasons.includes("HAFF_EXACT_RATIO_MISSING"));
  assert.equal(blocked.amounts, null);
});

test("F2: charge cannot eat deposit; capture must match frozen prepaid", () => {
  const expensive = baseInput({ remainingHaff: "50000000", remainingItems: "0", endReason: "TENANT_VOLUNTARY_EARLY" });
  expensive.capturedAmount = "1301.00";
  expensive.haff.prepaidBuyerAmount = "1.00";
  expensive.haff.prepaidOwnerAmount = "0.80";
  expensive.haff.exactRatio = {
    buyerNumerator: "1.00",
    buyerDenominator: "1",
    ownerNumerator: "0.80",
    ownerDenominator: "1",
  };
  expensive.items = [{
    itemId: "kit",
    unit: "PIECE",
    pricingKind: "FIXED_UNIT",
    openingQuantity: "10",
    remainingQuantity: "0",
    unitQuantity: "1",
    buyerUnitAmount: "100.00000000",
    ownerUnitAmount: "90.00000000",
    prepaidBuyerAmount: "1000.00",
    prepaidOwnerAmount: "900.00",
  }];
  const deposit = computeSettlement(expensive);
  assert.equal(deposit.ok, false);
  assert.ok(deposit.reasons.includes("CHARGE_EXCEEDS_RESOURCE_PREPAYMENT"));
  assert.equal(deposit.amounts, null);

  const mismatch = computeSettlement(baseInput({ remainingHaff: "50000000", remainingItems: "8", endReason: "TENANT_VOLUNTARY_EARLY", capturedAmount: "400.00" }));
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.reasons.includes("CAPTURED_MISMATCH"));
  assert.equal(mismatch.amounts, null);

  const exactFit = computeSettlement(baseInput({ remainingHaff: "0", remainingItems: "0", endReason: "NORMAL", fullPayout: "NOT_SELECTED" }));
  assert.equal(exactFit.ok, true, exactFit.reasons.join(","));
  assert.equal(money(exactFit, "renterCharge"), "350.00");
  assert.equal(money(exactFit, "renterRefund"), "300.00");
  assert.equal(money(exactFit, "depositRefund"), "300.00");

  const oneCent = computeSettlement(baseInput({ remainingHaff: "0", remainingItems: "0", endReason: "NORMAL", fullPayout: "NOT_SELECTED", capturedAmount: "649.99" }));
  assert.equal(oneCent.ok, false);
  assert.ok(oneCent.reasons.includes("CAPTURED_MISMATCH"));
  assert.equal(oneCent.amounts, null);

  const dup = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  dup.items = [...dup.items, { ...dup.items[0]!, itemId: "kit" }];
  const duplicated = computeSettlement(dup);
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.reasons.includes("ITEM_kit_DUPLICATE"));

  const prepaid = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  prepaid.items = [{ ...prepaid.items[0]!, prepaidBuyerAmount: "99.00" }];
  const prepaidMismatch = computeSettlement(prepaid);
  assert.equal(prepaidMismatch.ok, false);
  assert.ok(prepaidMismatch.reasons.includes("ITEM_kit_PREPAID_MISMATCH"));
  assert.equal(prepaidMismatch.amounts, null);
});

test("F3: cancel facts must match rental start and zero consume", () => {
  const withItems = computeSettlement(baseInput({ remainingHaff: HAFF, remainingItems: "8", endReason: "CANCELLED_BEFORE_START", rentalStarted: false }));
  assert.equal(withItems.ok, false);
  assert.ok(withItems.reasons.includes("CONSUMED_BEFORE_START"));
  assert.equal(withItems.amounts, null);
  const startedCancel = computeSettlement(baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "CANCELLED_BEFORE_START" }));
  assert.equal(startedCancel.ok, false);
  assert.ok(startedCancel.reasons.includes("END_REASON_INCONSISTENT"));
  assert.equal(startedCancel.amounts, null);
  const valid = computeSettlement(baseInput({ remainingHaff: HAFF, remainingItems: "10", endReason: "CANCELLED_BEFORE_START", rentalStarted: false }));
  assert.equal(valid.ok, true, valid.reasons.join(","));
  assert.equal(money(valid, "renterCharge"), "0.00");
  assert.equal(money(valid, "ownerNet"), "0.00");
  assert.equal(money(valid, "feeAmount"), "0.00");
});

test("F4: missing or unknown enums cannot auto-settle or confirm", () => {
  const missingPayout = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  delete (missingPayout as { fullPayout?: FullPayoutSelection }).fullPayout;
  const coverage = computeSettlement(missingPayout);
  assert.equal(coverage.ok, false);
  assert.ok(coverage.reasons.includes("FULL_PAYOUT_UNKNOWN"));
  assert.equal(coverage.amounts, null);
  const unknownReason = computeSettlement({ ...baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" }), endReason: "UNRECOGNIZED" as SettlementEndReason });
  assert.equal(unknownReason.ok, false);
  assert.ok(unknownReason.reasons.includes("END_REASON_UNKNOWN"));
  assert.equal(unknownReason.amounts, null);
  const notStarted = computeSettlement({ ...baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" }), rentalStarted: "true" as unknown as boolean });
  assert.equal(notStarted.ok, false);
  assert.ok(notStarted.reasons.includes("RENTAL_STARTED_UNKNOWN"));

  const missingEarly = confirm();
  delete (missingEarly as { early?: boolean }).early;
  const earlyUnknown = settlementConfirmationReady(missingEarly);
  assert.equal(earlyUnknown.ready, false);
  assert.ok(earlyUnknown.reasons.includes("EARLY_FLAG_UNKNOWN"));
  const missingKind = confirm();
  delete (missingKind as { kind?: SettlementConfirmationFacts["kind"] }).kind;
  const kindUnknown = settlementConfirmationReady(missingKind);
  assert.equal(kindUnknown.ready, false);
  assert.ok(kindUnknown.reasons.includes("SETTLEMENT_KIND_UNKNOWN"));
  const unknownKind = settlementConfirmationReady({ ...confirm(), kind: "UNKNOWN" as SettlementConfirmationFacts["kind"] });
  assert.equal(unknownKind.ready, false);
  assert.ok(unknownKind.reasons.includes("SETTLEMENT_KIND_UNKNOWN"));
});

test("missing settlement input and malformed inventory entries return blocked results", () => {
  for (const raw of [null, undefined, [], "invalid"]) {
    const result = computeSettlement(raw as unknown as ComputeSettlementInput);
    assert.equal(result.ok, false);
    assert.equal(result.amounts, null);
    assert.ok(result.reasons.includes("SETTLEMENT_INPUT_INVALID"));
  }
  for (const raw of [null, undefined, [], "invalid"]) {
    const input = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
    input.items = [raw] as unknown as ComputeSettlementInput["items"];
    const result = computeSettlement(input);
    assert.equal(result.ok, false);
    assert.equal(result.amounts, null);
    assert.ok(result.reasons.includes("ITEM_INVALID"));
  }
});

test("haff identity and zero-opening value must agree with the frozen inventory", () => {
  const input = baseInput({ remainingHaff: "20000000", remainingItems: "8", endReason: "NORMAL" });
  input.haff.itemId = " ";
  const missing = computeSettlement(input);
  assert.equal(missing.ok, false);
  assert.equal(missing.amounts, null);
  assert.ok(missing.reasons.includes("HAFF_ITEM_ID_MISSING"));

  const zero = baseInput({ remainingHaff: "0", remainingItems: "10", endReason: "NORMAL" });
  zero.haff.openingQuantity = "0";
  const contradictory = computeSettlement(zero);
  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.amounts, null);
  assert.ok(contradictory.reasons.includes("HAFF_PREPAID_MISMATCH"));

  zero.haff.prepaidBuyerAmount = "0.00";
  zero.haff.prepaidOwnerAmount = "0.00";
  zero.haff.exactRatio = { buyerNumerator: "0", buyerDenominator: "1", ownerNumerator: "0", ownerDenominator: "1" };
  zero.capturedAmount = "400.00";
  const undefinedRatio = computeSettlement(zero);
  assert.equal(undefinedRatio.ok, false);
  assert.equal(undefinedRatio.early, null);
  assert.equal(undefinedRatio.amounts, null);
  assert.ok(undefinedRatio.reasons.includes("HAFF_CONSUMPTION_RATIO_UNDEFINED"));
});
