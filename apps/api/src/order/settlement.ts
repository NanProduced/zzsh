import {
  DecimalError,
  decimalToBigInt,
  divideToScale,
  multiplyDecimal,
  parseNonNegativeDecimal,
  parseSignedDecimal,
} from "../supply/decimal";
import { centsToYuan } from "./order";
import type { QuoteAmount } from "../supply/pricing";

export const SETTLEMENT_ROUNDING_POLICY = "HALF_UP_CENT_V1_SETTLEMENT_TOTAL_V1";
export const FULL_PAYOUT_RATE = { numerator: 8n, denominator: 100n };

export type SettlementEndReason =
  | "NORMAL"
  | "TENANT_VOLUNTARY_EARLY"
  | "OWNER_OR_ACCOUNT_EARLY"
  | "CANCELLED_BEFORE_START"
  | "UNKNOWN";

export type FullPayoutSelection = "SELECTED" | "NOT_SELECTED" | "UNKNOWN";
export type InventoryUnit = "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
export type ConfirmationParty = "RENTER" | "OWNER" | "SUPPORT";

/** Frozen `InternalQuote.pricingInputs.exactRatios` row for the opening haff line. */
export type SettlementExactRatio = {
  buyerNumerator: string;
  buyerDenominator: string;
  ownerNumerator: string;
  ownerDenominator: string;
};

export type SettlementInventoryLine = {
  itemId: string;
  unit: InventoryUnit;
  pricingKind: "HAFF_RATIO" | "FIXED_UNIT";
  openingQuantity: string;
  remainingQuantity: string | null;
  unitQuantity: string;
  buyerUnitAmount: string;
  ownerUnitAmount: string;
  prepaidBuyerAmount: string;
  prepaidOwnerAmount: string;
  exactRatio?: SettlementExactRatio | null;
};

export type ComputeSettlementInput = {
  orderId: string;
  settlementVersionId: string;
  openingVersionId: string;
  quoteDigest: string;
  paymentDigest: string;
  roundingPolicy: string;
  feePolicyVersion: string;
  renterUserId: string;
  ownerUserId: string;
  rentalStarted: boolean;
  endReason: SettlementEndReason;
  depositAmount: string;
  capturedAmount: string;
  fullPayout: FullPayoutSelection;
  fullPayoutPolicyRef: string | null;
  haff: SettlementInventoryLine;
  items: readonly SettlementInventoryLine[];
};

export type SettlementComputation = {
  ok: boolean;
  reasons: string[];
  early: boolean | null;
  amounts: {
    haffConsumedBuyer: QuoteAmount;
    haffConsumedOwner: QuoteAmount;
    haffSpread: QuoteAmount;
    itemConsumedBuyer: QuoteAmount;
    itemConsumedOwner: QuoteAmount;
    itemSpread: QuoteAmount;
    unusedItemRefund: QuoteAmount;
    unusedHaffRefund: QuoteAmount;
    earlyMakeup: QuoteAmount;
    feeBase: QuoteAmount;
    feeRate: string;
    feeAmount: QuoteAmount;
    feePayer: "OWNER" | "RENTER" | "NONE";
    ownerGross: QuoteAmount;
    ownerNet: QuoteAmount;
    renterCharge: QuoteAmount;
    renterRefund: QuoteAmount;
    depositRefund: QuoteAmount;
    platformHaffSpread: QuoteAmount;
    platformItemSpread: QuoteAmount;
    platformMakeup: QuoteAmount;
    platformFee: QuoteAmount;
    platformContribution: QuoteAmount;
  } | null;
  consumed: { haff: string; items: Array<{ itemId: string; consumed: string; remaining: string }> } | null;
};

export type SettlementConfirmationFacts = {
  settlementVersionId: string;
  currentVersionHash: string;
  kind: "SYSTEM" | "MANUAL_ADJUSTMENT";
  early: boolean;
  initiatorParty: ConfirmationParty;
  renterConfirmedVersionId: string | null;
  ownerConfirmedVersionId: string | null;
  renterRejectedVersionId: string | null;
  ownerRejectedVersionId: string | null;
  supportReviewedVersionId: string | null;
  opsApproval: {
    status: "APPROVED" | "PENDING" | "REJECTED";
    requesterId: string;
    approverId: string;
    payloadHash: string;
  } | null;
};

const END_REASONS = ["NORMAL", "TENANT_VOLUNTARY_EARLY", "OWNER_OR_ACCOUNT_EARLY", "CANCELLED_BEFORE_START"] as const;
const PAYOUTS = ["SELECTED", "NOT_SELECTED"] as const;
const KINDS = ["SYSTEM", "MANUAL_ADJUSTMENT"] as const;
const PARTIES = ["RENTER", "OWNER", "SUPPORT"] as const;
const ITEM_UNITS = ["ROUND", "PIECE", "DAY"] as const;

type Rat = { n: bigint; d: bigint };
const abs = (n: bigint) => (n < 0n ? -n : n);
const gcd = (a: bigint, b: bigint) => {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
};
const rat = (n: bigint, d = 1n): Rat => {
  if (d === 0n) throw new DecimalError("denominator must not be zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
};
const radd = (a: Rat, b: Rat) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const rsub = (a: Rat, b: Rat) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const rRoundCents = (yuan: Rat) => divideToScale({ value: yuan.n * 100n, scale: 0 }, { value: yuan.d, scale: 0 }, 0).value;
const yuan = (cents: bigint): QuoteAmount => centsToYuan(cents);
const centsOf = (text: string, label: string) => decimalToBigInt(parseNonNegativeDecimal(text, 2, label), 2);
const qtyOf = (text: string, label: string) => decimalToBigInt(parseNonNegativeDecimal(text, 0, label), 0);

function requiredId(value: unknown, reason: string, reasons: string[]) {
  if (typeof value !== "string" || value.trim() === "") reasons.push(reason);
}

function oneOf(value: unknown, allowed: readonly string[], reason: string, reasons: string[]) {
  if (typeof value !== "string" || !allowed.includes(value)) reasons.push(reason);
}

function yuanRatio(numer: string, denom: string, label: string): Rat {
  const n = parseNonNegativeDecimal(numer, 18, `${label}.n`);
  const d = parseNonNegativeDecimal(denom, 18, `${label}.d`);
  if (d.value === 0n) throw new DecimalError(`${label} denominator must not be zero`);
  return rat(n.value * 10n ** BigInt(d.scale), d.value * 10n ** BigInt(n.scale));
}

function lineConsumed(line: SettlementInventoryLine, reasons: string[], prefix: string) {
  let opening: bigint;
  try {
    opening = qtyOf(line.openingQuantity, `${prefix}.opening`);
  } catch {
    reasons.push(`${prefix}_OPENING_INVALID`);
    return null;
  }
  if (line.remainingQuantity === null || line.remainingQuantity === undefined) {
    reasons.push(`${prefix}_REMAINING_UNKNOWN`);
    return null;
  }
  if (typeof line.remainingQuantity !== "string") {
    reasons.push(`${prefix}_REMAINING_INVALID`);
    return null;
  }
  let remaining: bigint;
  try {
    remaining = decimalToBigInt(parseSignedDecimal(line.remainingQuantity, 0, `${prefix}.remaining`), 0);
  } catch {
    reasons.push(`${prefix}_REMAINING_INVALID`);
    return null;
  }
  if (remaining < 0n) reasons.push(`${prefix}_REMAINING_NEGATIVE`);
  if (remaining > opening) reasons.push(`${prefix}_REMAINING_EXCEEDS_OPENING`);
  if (reasons.some((r) => r.startsWith(prefix))) return null;
  return { opening, remaining, consumed: opening - remaining };
}

function fixedCents(consumed: bigint, unitAmount: string, unitQuantity: string, label: string) {
  const unitQty = parseNonNegativeDecimal(unitQuantity, 0, `${label}.unitQuantity`);
  if (unitQty.value <= 0n) throw new DecimalError(`${label} unit quantity must be positive`);
  const unit = parseNonNegativeDecimal(unitAmount, 8, `${label}.unitAmount`);
  return divideToScale(multiplyDecimal({ value: consumed, scale: 0 }, unit), unitQty, 2).value;
}

function makeupExact(F: Rat, consumed: bigint, declared: bigint) {
  if (declared <= 0n || F.n <= 0n) return rat(0n);
  if (consumed * 2n <= declared) return rat(F.n * (declared - consumed), F.d * declared);
  if (consumed * 10n < declared * 7n) return rat(F.n * (declared * 7n - consumed * 10n), F.d * declared * 4n);
  return rat(0n);
}

function parseExactRatio(ratio: SettlementExactRatio | null | undefined, prefix: string, reasons: string[]): { buyer: Rat; owner: Rat } | null {
  if (!ratio || typeof ratio !== "object") {
    reasons.push(`${prefix}_EXACT_RATIO_MISSING`);
    return null;
  }
  try {
    const buyer = yuanRatio(ratio.buyerNumerator, ratio.buyerDenominator, `${prefix}.buyer`);
    const owner = yuanRatio(ratio.ownerNumerator, ratio.ownerDenominator, `${prefix}.owner`);
    if (owner.n * buyer.d > buyer.n * owner.d) reasons.push(`${prefix}_OWNER_EXCEEDS_BUYER`);
    return { buyer, owner };
  } catch {
    reasons.push(`${prefix}_EXACT_RATIO_INVALID`);
    return null;
  }
}

export function computeSettlement(input: ComputeSettlementInput): SettlementComputation {
  const reasons: string[] = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reasons: ["SETTLEMENT_INPUT_INVALID"], early: null, amounts: null, consumed: null };
  }
  requiredId(input.orderId, "ORDER_ID_MISSING", reasons);
  requiredId(input.settlementVersionId, "SETTLEMENT_VERSION_MISSING", reasons);
  requiredId(input.openingVersionId, "OPENING_VERSION_MISSING", reasons);
  requiredId(input.quoteDigest, "QUOTE_DIGEST_MISSING", reasons);
  requiredId(input.paymentDigest, "PAYMENT_DIGEST_MISSING", reasons);
  requiredId(input.feePolicyVersion, "FEE_POLICY_VERSION_MISSING", reasons);
  requiredId(input.renterUserId, "RENTER_MISSING", reasons);
  requiredId(input.ownerUserId, "OWNER_MISSING", reasons);
  if (input.roundingPolicy !== SETTLEMENT_ROUNDING_POLICY) reasons.push("ROUNDING_POLICY_UNSUPPORTED");
  if (input.rentalStarted !== true && input.rentalStarted !== false) reasons.push("RENTAL_STARTED_UNKNOWN");
  oneOf(input.endReason, END_REASONS, "END_REASON_UNKNOWN", reasons);
  oneOf(input.fullPayout, PAYOUTS, "FULL_PAYOUT_UNKNOWN", reasons);
  if (input.fullPayout === "SELECTED" && (typeof input.fullPayoutPolicyRef !== "string" || input.fullPayoutPolicyRef.trim() === "")) {
    reasons.push("FULL_PAYOUT_POLICY_REF_MISSING");
  }
  if (input.rentalStarted === false && input.endReason !== "CANCELLED_BEFORE_START") reasons.push("RENTAL_NOT_STARTED");
  if (input.rentalStarted === true && input.endReason === "CANCELLED_BEFORE_START") reasons.push("END_REASON_INCONSISTENT");
  if (!input.haff || typeof input.haff !== "object") reasons.push("HAFF_MISSING");
  if (!Array.isArray(input.items)) reasons.push("ITEMS_INVALID");

  let captured: bigint;
  let deposit: bigint;
  try {
    captured = centsOf(input.capturedAmount, "captured");
    deposit = centsOf(input.depositAmount, "deposit");
  } catch {
    reasons.push("AMOUNT_INVALID");
    return { ok: false, reasons, early: null, amounts: null, consumed: null };
  }

  const seen = new Set<string>();
  if (input.haff) requiredId(input.haff.itemId, "HAFF_ITEM_ID_MISSING", reasons);
  if (input.haff?.itemId) seen.add(input.haff.itemId);
  if (input.haff && (input.haff.pricingKind !== "HAFF_RATIO" || input.haff.unit !== "HAFF_BASE")) reasons.push("HAFF_PRICING_UNSUPPORTED");

  const haffQty = input.haff ? lineConsumed(input.haff, reasons, "HAFF") : null;
  let B = 0n;
  let O = 0n;
  let Q = 0n;
  let q = 0n;
  let Hb = 0n;
  let Ho = 0n;
  let unusedHaff = 0n;
  let exactHb = rat(0n);
  let F = rat(0n);
  const exact = input.haff ? parseExactRatio(input.haff.exactRatio, "HAFF", reasons) : null;
  try {
    if (input.haff) {
      B = centsOf(input.haff.prepaidBuyerAmount, "haff.prepaidBuyer");
      O = centsOf(input.haff.prepaidOwnerAmount, "haff.prepaidOwner");
    }
  } catch {
    reasons.push("HAFF_AMOUNT_INVALID");
  }
  if (exact && rRoundCents(exact.buyer) !== B) reasons.push("HAFF_PREPAID_MISMATCH");
  if (exact && rRoundCents(exact.owner) !== O) reasons.push("HAFF_PREPAID_MISMATCH");
  if (haffQty) {
    Q = haffQty.opening;
    q = haffQty.consumed;
    if (Q === 0n && (B !== 0n || O !== 0n || (exact && (exact.buyer.n !== 0n || exact.owner.n !== 0n)))) {
      reasons.push("HAFF_PREPAID_MISMATCH");
    }
  }
  if (haffQty && exact && Q > 0n) {
    exactHb = rat(q * exact.buyer.n, Q * exact.buyer.d);
    const exactHo = rat(q * exact.owner.n, Q * exact.owner.d);
    Hb = rRoundCents(exactHb);
    Ho = rRoundCents(exactHo);
    unusedHaff = B - Hb;
    if (unusedHaff < 0n) reasons.push("HAFF_CONSUMED_EXCEEDS_PREPAID");
    F = rsub(exact.buyer, exact.owner);
    if (F.n * 5n * exact.buyer.d > exact.buyer.n * 2n * F.d && q * 10n < Q * 7n) reasons.push("HAFF_SPREAD_RATIO_UNSAFE");
  }

  let Gb = 0n;
  let Go = 0n;
  let unusedItems = 0n;
  let ownerFull = O;
  let resourcePrepaid = B;
  let anyItemConsumed = false;
  const itemConsumed: Array<{ itemId: string; consumed: string; remaining: string }> = [];
  const items = Array.isArray(input.items) ? input.items : [];
  for (const line of items) {
    if (line == null || typeof line !== "object" || Array.isArray(line)) {
      reasons.push("ITEM_INVALID");
      continue;
    }
    const prefix = `ITEM_${line.itemId ?? "missing"}`;
    if (typeof line.itemId !== "string" || line.itemId.trim() === "") reasons.push("ITEM_ID_MISSING");
    else if (seen.has(line.itemId)) reasons.push(`${prefix}_DUPLICATE`);
    else seen.add(line.itemId);
    if (line.pricingKind !== "FIXED_UNIT" || !ITEM_UNITS.includes(line.unit as (typeof ITEM_UNITS)[number])) {
      reasons.push(`${prefix}_PRICING_UNSUPPORTED`);
    }
    let prepaidB: bigint;
    let prepaidO: bigint;
    try {
      prepaidB = centsOf(line.prepaidBuyerAmount, `${prefix}.prepaidBuyer`);
      prepaidO = centsOf(line.prepaidOwnerAmount, `${prefix}.prepaidOwner`);
      const opening = qtyOf(line.openingQuantity, `${prefix}.opening`);
      const expectedB = fixedCents(opening, line.buyerUnitAmount, line.unitQuantity, prefix);
      const expectedO = fixedCents(opening, line.ownerUnitAmount, line.unitQuantity, prefix);
      if (expectedB !== prepaidB || expectedO !== prepaidO) reasons.push(`${prefix}_PREPAID_MISMATCH`);
      const buyerUnit = parseNonNegativeDecimal(line.buyerUnitAmount, 8, `${prefix}.buyerUnit`);
      const ownerUnit = parseNonNegativeDecimal(line.ownerUnitAmount, 8, `${prefix}.ownerUnit`);
      if (decimalToBigInt(ownerUnit, 8) > decimalToBigInt(buyerUnit, 8)) reasons.push(`${prefix}_OWNER_EXCEEDS_BUYER`);
    } catch {
      reasons.push(`${prefix}_AMOUNT_INVALID`);
      continue;
    }
    ownerFull += prepaidO;
    resourcePrepaid += prepaidB;
    const qty = lineConsumed(line, reasons, prefix);
    if (!qty) continue;
    try {
      const consumedB = fixedCents(qty.consumed, line.buyerUnitAmount, line.unitQuantity, prefix);
      const consumedO = fixedCents(qty.consumed, line.ownerUnitAmount, line.unitQuantity, prefix);
      if (consumedB > prepaidB) reasons.push(`${prefix}_CONSUMED_EXCEEDS_PREPAID`);
      Gb += consumedB;
      Go += consumedO;
      unusedItems += prepaidB - consumedB;
      if (qty.consumed !== 0n) anyItemConsumed = true;
      itemConsumed.push({ itemId: line.itemId, consumed: qty.consumed.toString(), remaining: qty.remaining.toString() });
    } catch {
      reasons.push(`${prefix}_AMOUNT_INVALID`);
    }
  }

  const started = input.rentalStarted === true;
  const cancelledBeforeStart = input.rentalStarted === false && input.endReason === "CANCELLED_BEFORE_START";
  if (cancelledBeforeStart && (q !== 0n || anyItemConsumed)) reasons.push("CONSUMED_BEFORE_START");
  if (started && haffQty && Q === 0n) reasons.push("HAFF_CONSUMPTION_RATIO_UNDEFINED");
  const early = started && Q > 0n ? q * 10n < Q * 7n : null;
  if (early === true && input.endReason === "NORMAL") reasons.push("END_REASON_INCONSISTENT");
  if (early === false && (input.endReason === "TENANT_VOLUNTARY_EARLY" || input.endReason === "OWNER_OR_ACCOUNT_EARLY")) {
    reasons.push("END_REASON_INCONSISTENT");
  }
  let makeup = rat(0n);
  if (started && early === true && input.endReason === "TENANT_VOLUNTARY_EARLY") makeup = makeupExact(F, q, Q);

  const renterHaffTotal = rRoundCents(radd(exactHb, makeup));
  const makeupCents = renterHaffTotal - rRoundCents(exactHb);
  const ownerConsumed = Ho + Go;

  let fee = 0n;
  let feeBase = 0n;
  let feePayer: "OWNER" | "RENTER" | "NONE" = "NONE";
  if (cancelledBeforeStart || input.fullPayout === "NOT_SELECTED") {
    fee = 0n;
  } else if (input.fullPayout === "SELECTED" && started && !reasons.includes("FULL_PAYOUT_POLICY_REF_MISSING")) {
    if (input.endReason === "TENANT_VOLUNTARY_EARLY") {
      feeBase = ownerFull;
      feePayer = "RENTER";
    } else if (input.endReason === "NORMAL" || input.endReason === "OWNER_OR_ACCOUNT_EARLY") {
      feeBase = ownerConsumed;
      feePayer = "OWNER";
    }
    fee = divideToScale({ value: feeBase * FULL_PAYOUT_RATE.numerator, scale: 0 }, { value: FULL_PAYOUT_RATE.denominator, scale: 0 }, 0).value;
  }

  const ownerGross = ownerConsumed;
  const ownerNet = feePayer === "OWNER" ? ownerGross - fee : ownerGross;
  const renterCharge = renterHaffTotal + Gb + (feePayer === "RENTER" ? fee : 0n);
  const renterRefund = captured - renterCharge;
  if (captured !== resourcePrepaid + deposit) reasons.push("CAPTURED_MISMATCH");
  if (renterCharge > resourcePrepaid) reasons.push("CHARGE_EXCEEDS_RESOURCE_PREPAYMENT");
  if (renterRefund < 0n) reasons.push("INSUFFICIENT_PREPAYMENT");

  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      early,
      amounts: null,
      consumed: haffQty ? { haff: q.toString(), items: itemConsumed } : null,
    };
  }

  const haffSpread = rRoundCents(exactHb) - Ho;
  const itemSpread = Gb - Go;
  const platformContribution = haffSpread + itemSpread + makeupCents + fee;
  return {
    ok: true,
    reasons: [],
    early,
    consumed: { haff: q.toString(), items: itemConsumed },
    amounts: {
      haffConsumedBuyer: yuan(rRoundCents(exactHb)),
      haffConsumedOwner: yuan(Ho),
      haffSpread: yuan(haffSpread),
      itemConsumedBuyer: yuan(Gb),
      itemConsumedOwner: yuan(Go),
      itemSpread: yuan(itemSpread),
      unusedItemRefund: yuan(unusedItems),
      unusedHaffRefund: yuan(unusedHaff),
      earlyMakeup: yuan(makeupCents),
      feeBase: yuan(feeBase),
      feeRate: input.fullPayout === "SELECTED" ? "0.08" : "0",
      feeAmount: yuan(fee),
      feePayer,
      ownerGross: yuan(ownerGross),
      ownerNet: yuan(ownerNet),
      renterCharge: yuan(renterCharge),
      renterRefund: yuan(renterRefund),
      depositRefund: yuan(deposit),
      platformHaffSpread: yuan(haffSpread),
      platformItemSpread: yuan(itemSpread),
      platformMakeup: yuan(makeupCents),
      platformFee: yuan(fee),
      platformContribution: yuan(platformContribution),
    },
  };
}

export function settlementConfirmationReady(facts: SettlementConfirmationFacts): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (facts == null || typeof facts !== "object") {
    return { ready: false, reasons: ["CONFIRMATION_FACTS_MISSING"] };
  }
  requiredId(facts.settlementVersionId, "SETTLEMENT_VERSION_MISSING", reasons);
  requiredId(facts.currentVersionHash, "VERSION_HASH_MISSING", reasons);
  oneOf(facts.kind, KINDS, "SETTLEMENT_KIND_UNKNOWN", reasons);
  if (facts.early !== true && facts.early !== false) reasons.push("EARLY_FLAG_UNKNOWN");
  oneOf(facts.initiatorParty, PARTIES, "INITIATOR_UNKNOWN", reasons);
  if (facts.renterRejectedVersionId === facts.settlementVersionId || facts.ownerRejectedVersionId === facts.settlementVersionId) {
    reasons.push("PARTY_REJECTED");
  }
  if (facts.renterConfirmedVersionId !== facts.settlementVersionId) reasons.push("RENTER_CONFIRMATION_MISSING");
  if (facts.ownerConfirmedVersionId !== facts.settlementVersionId) reasons.push("OWNER_CONFIRMATION_MISSING");
  if (facts.early === true && facts.supportReviewedVersionId !== facts.settlementVersionId) reasons.push("SUPPORT_REVIEW_MISSING");
  if (facts.kind === "MANUAL_ADJUSTMENT") {
    const ap = facts.opsApproval;
    if (!ap || typeof ap !== "object" || ap.status !== "APPROVED") reasons.push("OPS_APPROVAL_MISSING");
    else {
      if (typeof ap.requesterId !== "string" || ap.requesterId.trim() === "" || typeof ap.approverId !== "string" || ap.approverId.trim() === "") {
        reasons.push("OPS_ACTOR_MISSING");
      } else if (ap.requesterId === ap.approverId) reasons.push("OPS_SELF_APPROVE");
      if (ap.payloadHash !== facts.currentVersionHash) reasons.push("OPS_PAYLOAD_STALE");
    }
  }
  return { ready: reasons.length === 0, reasons };
}
