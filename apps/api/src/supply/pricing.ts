import { computeContentHash, normalizeContentPayload, normalizeQuote, type ContentPayloadInput, type LegacyQuoteProvenance } from "./content-hash";
import { legacyPriceInteger, quoteLegacyHaff } from "./legacy-listed-pricing";
import { calculateFixedFee, FIXED_FEE_ALGORITHM } from "./fixed-fee";
import {
  DecimalError,
  decimalToBigInt,
  divideToScale,
  formatDecimalExact,
  formatScaledInteger,
  multiplyDecimal,
  parseNonNegativeDecimal,
  subtractDecimal,
  yuanAmountObject,
  type Decimal,
} from "./decimal";
import {
  calculateDeltaTermSeconds,
  DELTA_HAFF_BASE_PER_MILLION,
  DELTA_HAFF_FIXED_SCHEMA,
  DELTA_HAFF_RATIO_SCHEMA,
  DELTA_QUOTE_SCHEMA_VERSION,
  DELTA_ROUNDING_POLICY,
  normalizeRentalPricing,
  projectDeltaQuote,
  resolveDeltaHaffContext,
  type DeltaHaffRule,
  type DeltaProjectedQuote,
  type DeltaQuoteReasonCode,
  type DeltaQuoteViewer,
  type CustomerTier,
  type DeltaHaffConditions,
} from "./delta-rental";

export const QUOTE_SCHEMA_VERSION = DELTA_QUOTE_SCHEMA_VERSION;
export const HAFF_RATIO_SCHEMA = DELTA_HAFF_RATIO_SCHEMA;
export const HAFF_BASE_PER_MILLION = DELTA_HAFF_BASE_PER_MILLION;
export const ROUNDING_POLICY = DELTA_ROUNDING_POLICY;

export type QuoteReasonCode = DeltaQuoteReasonCode;
export type HaffRatioRule = DeltaHaffRule;

export type PricingLineInput = {
  itemId: string;
  customerTier?: CustomerTier;
  quantity: string;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
  unitQuantity?: string;
  buyerUnitAmount?: string;
  ownerUnitAmount?: string;
  unit?: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
};

export type EntitlementInput = {
  entitlementId: string;
  expiryKind: "PERMANENT" | "TIMED";
  expiresAt?: string;
};

export type QuoteInput = {
  customerTier?: CustomerTier;
  priceVersionId: string;
  mode: "SPREAD" | "PERCENT";
  roundingPolicy: string;
  commissionRate?: string;
  fixedFeeAlgorithm?: typeof FIXED_FEE_ALGORITHM;
  haffRule?: HaffRatioRule;
  lines: readonly PricingLineInput[];
  conditions: DeltaHaffConditions;
  termOption: { code: string; dailyConsumption: string; durationRounding: "CEIL_DAY" };
  entitlements?: readonly EntitlementInput[];
  deposits?: {
    tenantDepositCents?: string;
    publisherBailRequirementCents?: string;
  };
};

export type QuoteAmount = { currency: "CNY"; unit: "yuan"; amount: string; scale: 2 };
export type QuoteUnitAmount = { currency: "CNY"; unit: "yuan"; amount: string; scale: 8 };

export type QuoteLine = {
  itemId: string;
  quantity: string;
  unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY";
  unitQuantity: string;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
  buyerUnitAmount: QuoteUnitAmount;
  ownerUnitAmount: QuoteUnitAmount;
  buyerAmount: QuoteAmount;
  ownerAmount: QuoteAmount;
  platformAmount: QuoteAmount;
};

export type ExpiryDisclosure = {
  entitlementId: string;
  expiresAt: string | null;
  fullTermGuaranteed: false;
};

export type QuoteExactRatio = {
  itemId: string;
  buyerNumerator: string;
  buyerDenominator: string;
  ownerNumerator: string;
  ownerDenominator: string;
};

export type InternalQuote = {
  schemaVersion: 1 | 2 | 3 | 4;
  quoteSource?: "LEGACY_QUOTED";
  legacyQuote?: LegacyQuoteProvenance;
  currency: "CNY";
  priceVersionId: string;
  ruleReleaseId: string | null;
  mode: "SPREAD" | "PERCENT";
  lines: QuoteLine[];
  resourceTotal: QuoteAmount;
  ownerTotal: QuoteAmount;
  platformFullProfit: QuoteAmount;
  tenantDeposit: QuoteAmount | null;
  publisherBailRequirement: QuoteAmount | null;
  termSeconds: string;
  expiryDisclosures: ExpiryDisclosure[];
  unitAmountsInformational: boolean;
  roundingPolicy: string;
  pricingInputs: {
    compatibility?: import("./delta-rental").DeltaHaffContext["compatibility"] | { rentalMode: "ordinary" | "custom" | "fast"; customerTier: "STANDARD"; ownerRatioB: string };
    haffRatioSchema: string | null;
    conditions: Record<string, string> | null;
    denominators: { owner: string; buyer: string } | null;
    spreadDelta: string | null;
    commissionRate: string | null;
    fixedFeeAlgorithm?: typeof FIXED_FEE_ALGORITHM;
    fixedFeeGrossCents?: string;
    exactRatios: QuoteExactRatio[];
    roundingPolicy: string;
    depositPolicy: "CONFIGURED" | "UNCONFIGURED";
    reasonCodes: QuoteReasonCode[];
  };
  contentHash?: string;
};

export type QuoteResult =
  | { quotable: true; quote: InternalQuote }
  | { quotable: false; reasonCodes: QuoteReasonCode[] };

function quoteUnitAmount(value: Decimal): QuoteUnitAmount {
  const rounded = divideToScale(value, { value: 1n, scale: 0 }, 8);
  return { currency: "CNY", unit: "yuan", amount: formatScaledInteger(rounded.value, 8), scale: 8 };
}

function centsOrNull(text: string | undefined, label: string): bigint | null {
  if (text === undefined) return null;
  const parsed = parseNonNegativeDecimal(text, 0, label);
  return parsed.value;
}

export function computeFixedUnitAmounts(line: PricingLineInput, mode: "SPREAD" | "PERCENT", commissionRate: Decimal | null = null) {
  if (line.pricingKind !== "FIXED_UNIT" || line.unitQuantity === undefined || line.buyerUnitAmount === undefined
    || (mode === "SPREAD" && line.ownerUnitAmount === undefined)
    || (mode === "PERCENT" && line.ownerUnitAmount !== undefined)) throw new DecimalError("fixed price inputs are missing");
  const quantity = parseNonNegativeDecimal(line.quantity, 0, "quantity");
  const unitQuantity = parseNonNegativeDecimal(line.unitQuantity, 0, "unit quantity");
  if (unitQuantity.value <= 0n) throw new DecimalError("unit quantity must be positive");
  const buyerUnit = parseNonNegativeDecimal(line.buyerUnitAmount, 8, "buyer unit amount");
  const buyerAmount = divideToScale(multiplyDecimal(quantity, buyerUnit), unitQuantity, 2);
  const ownerUnit = mode === "SPREAD" ? parseNonNegativeDecimal(line.ownerUnitAmount!, 8, "owner unit amount")
    : multiplyDecimal(buyerUnit, subtractDecimal({ value: 1n, scale: 0 }, commissionRate ?? {value:0n,scale:8}));
  if (subtractDecimal(ownerUnit, buyerUnit).value > 0n) throw new DecimalError("owner unit amount is invalid");
  const ownerAmount = divideToScale(multiplyDecimal(quantity, ownerUnit), unitQuantity, 2);
  if (ownerAmount.value > buyerAmount.value) throw new DecimalError("owner amount exceeds buyer amount");
  return { quantity, unitQuantity, buyerUnit, ownerUnit, buyerAmount, ownerAmount };
}

export function computeDeltaQuote(input: QuoteInput): QuoteResult {
  return computeDeltaQuoteInternal(input);
}

function computeDeltaQuoteInternal(input: QuoteInput, retainedPublishedSelection?: ReturnType<typeof normalizeRentalPricing>): QuoteResult {
  const reasons = new Set<QuoteReasonCode>();
  const fail = (code: QuoteReasonCode): void => {
    reasons.add(code);
  };
  const fixedFee = input.fixedFeeAlgorithm === FIXED_FEE_ALGORITHM;
  if ((input.fixedFeeAlgorithm !== undefined && !fixedFee)
      || (fixedFee && (input.mode !== "PERCENT" || input.haffRule?.schema !== DELTA_HAFF_FIXED_SCHEMA))
      || (!fixedFee && input.haffRule?.schema === DELTA_HAFF_FIXED_SCHEMA)) fail("RULE_INPUT_MISSING");

  if (input.roundingPolicy !== ROUNDING_POLICY) {
    return { quotable: false, reasonCodes: ["ROUNDING_POLICY_UNSUPPORTED"] };
  }

  let commissionRate: Decimal | null = null;
  if (input.mode === "PERCENT") {
    if (input.commissionRate === undefined) {
      fail("RULE_INPUT_MISSING");
    } else {
      try {
        commissionRate = parseNonNegativeDecimal(input.commissionRate, 8, "commission rate");
        if (subtractDecimal(commissionRate, { value: 1n, scale: 0 }).value >= 0n) fail("RULE_INPUT_MISSING");
      } catch {
        fail("RULE_INPUT_MISSING");
      }
    }
  }

  const hasHaffLines = input.lines.some((line) => line.pricingKind === "HAFF_RATIO");
  const deltaHaff = resolveDeltaHaffContext({ mode: input.mode, haffRule: input.haffRule, hasHaffLines, conditions: input.conditions, customerTier: input.customerTier }, retainedPublishedSelection);
  for (const reason of deltaHaff.reasonCodes) fail(reason);
  const { haffSchema, ownerDenominator, buyerDenominator, spreadDelta, conditions } = deltaHaff;

  const quoteLines: QuoteLine[] = [];
  const exactRatios: QuoteExactRatio[] = [];
  let resourceTotalCents = 0n;
  let ownerTotalCents = 0n;
  let totalHaffBase = 0n;

  for (const line of input.lines) {
    if (deltaHaff.compatibility && line.customerTier !== input.customerTier) {
      fail("RULE_INPUT_MISSING");
      continue;
    }
    let quantity: Decimal;
    try {
      quantity = parseNonNegativeDecimal(line.quantity, 0, "quantity");
    } catch {
      fail("INVALID_QUANTITY");
      continue;
    }
    if (line.pricingKind === "FIXED_UNIT") {
      if (line.unitQuantity === undefined || line.buyerUnitAmount === undefined) {
        fail("RULE_INPUT_MISSING");
        continue;
      }
      if (input.mode === "SPREAD" && line.ownerUnitAmount === undefined) {
        fail("RULE_INPUT_MISSING");
        continue;
      }
      if (input.mode === "PERCENT" && line.ownerUnitAmount !== undefined) {
        fail("RULE_INPUT_MISSING");
        continue;
      }
      try {
        const { unitQuantity, buyerUnit, ownerUnit, buyerAmount, ownerAmount } = computeFixedUnitAmounts(line, input.mode, commissionRate);
        pushLine(quoteLines, line, quantity, unitQuantity, buyerUnit, ownerUnit, buyerAmount.value, ownerAmount.value);
        resourceTotalCents += buyerAmount.value;
        ownerTotalCents += ownerAmount.value;
      } catch {
        fail("DEPENDENCY_UNAVAILABLE");
      }
      continue;
    }
    if (line.pricingKind !== "HAFF_RATIO") {
      fail("DEPENDENCY_UNAVAILABLE");
      continue;
    }
    if (ownerDenominator === null || buyerDenominator === null || ownerDenominator.value <= 0n || buyerDenominator.value <= 0n) {
      continue;
    }
    totalHaffBase += quantity.value;
    const hundred = { value: 100n, scale: 0 };
    const million = { value: HAFF_BASE_PER_MILLION, scale: 0 };
    try {
      const buyerAmount = divideToScale(multiplyDecimal(quantity, hundred), multiplyDecimal(million, buyerDenominator), 2);
      let ownerAmount: Decimal;
      if (input.mode === "SPREAD") {
        ownerAmount = divideToScale(multiplyDecimal(quantity, hundred), multiplyDecimal(million, ownerDenominator), 2);
      } else {
        const keep = subtractDecimal({ value: 1n, scale: 0 }, commissionRate ?? { value: 0n, scale: 8 });
        ownerAmount = divideToScale(multiplyDecimal(multiplyDecimal(quantity, hundred), keep), multiplyDecimal(million, buyerDenominator), 2);
      }
      if (ownerAmount.value > buyerAmount.value) throw new DecimalError("owner amount exceeds buyer amount");
      const buyerUnit = divideToScale(hundred, buyerDenominator, 8);
      const keep = subtractDecimal({ value: 1n, scale: 0 }, commissionRate ?? { value: 0n, scale: 0 });
      const ownerUnit = input.mode === "SPREAD"
        ? divideToScale(hundred, ownerDenominator, 8)
        : divideToScale(multiplyDecimal(hundred, keep), buyerDenominator, 8);
      pushLine(quoteLines, { ...line, unit: line.unit ?? "HAFF_BASE" }, quantity, million, buyerUnit, ownerUnit, buyerAmount.value, ownerAmount.value);
      resourceTotalCents += buyerAmount.value;
      ownerTotalCents += ownerAmount.value;
      const ownerNumerator = input.mode === "SPREAD" ? multiplyDecimal(quantity, hundred) : multiplyDecimal(multiplyDecimal(quantity, hundred), keep);
      exactRatios.push({
        itemId: line.itemId,
        buyerNumerator: formatScaledInteger(quantity.value * 100n, 0),
        buyerDenominator: formatScaledInteger(HAFF_BASE_PER_MILLION * buyerDenominator.value, buyerDenominator.scale),
        ownerNumerator: formatDecimalExact(ownerNumerator),
        ownerDenominator: formatDecimalExact(multiplyDecimal(million, input.mode === "SPREAD" ? ownerDenominator : buyerDenominator)),
      });
    } catch {
      fail("DEPENDENCY_UNAVAILABLE");
    }
  }

  const expiryDisclosures: ExpiryDisclosure[] = [];
  for (const entitlement of input.entitlements ?? []) {
    if (entitlement.expiryKind === "TIMED") {
      if (!entitlement.expiresAt) {
        fail("EXPIRY_UNKNOWN");
        continue;
      }
      expiryDisclosures.push({ entitlementId: entitlement.entitlementId, expiresAt: entitlement.expiresAt, fullTermGuaranteed: false });
    } else {
      expiryDisclosures.push({ entitlementId: entitlement.entitlementId, expiresAt: null, fullTermGuaranteed: false });
    }
  }

  const term = calculateDeltaTermSeconds(totalHaffBase, input.termOption);
  for (const reason of term.reasonCodes) fail(reason);
  const termSeconds = term.termSeconds;

  if (reasons.size > 0 || termSeconds === null) {
    return { quotable: false, reasonCodes: [...reasons].sort() };
  }

  if (fixedFee) {
    try {
      const allocated = calculateFixedFee(quoteLines.map((line) => ({
        itemId: line.itemId, grossCents: decimalToBigInt(parseNonNegativeDecimal(line.buyerAmount.amount, 2, "buyer amount"), 2),
      })), input.commissionRate!);
      const byItem = new Map(allocated.lines.map((line) => [line.itemId, line]));
      for (let i = 0; i < quoteLines.length; i++) {
        const line = quoteLines[i]!, part = byItem.get(line.itemId)!;
        quoteLines[i] = { ...line, ownerUnitAmount: { ...line.buyerUnitAmount },
          ownerAmount: yuanAmountObject(part.ownerCents), platformAmount: yuanAmountObject(part.feeCents) };
      }
      for (const ratio of exactRatios) {
        const owner = byItem.get(ratio.itemId)!.ownerCents;
        const numerator = parseNonNegativeDecimal(ratio.buyerNumerator, 18, "buyer numerator");
        const denominator = parseNonNegativeDecimal(ratio.buyerDenominator, 18, "buyer denominator");
        const buyerBelowRoundedOwner = numerator.value * 10n ** BigInt(denominator.scale) * 100n
          < owner * denominator.value * 10n ** BigInt(numerator.scale);
        ratio.ownerNumerator = buyerBelowRoundedOwner ? ratio.buyerNumerator : owner.toString();
        ratio.ownerDenominator = buyerBelowRoundedOwner ? ratio.buyerDenominator : "100";
      }
      ownerTotalCents = allocated.grossCents - allocated.feeCents;
    } catch {
      return { quotable: false, reasonCodes: ["DEPENDENCY_UNAVAILABLE"] };
    }
  }

  const tenantDepositCents = centsOrNull(input.deposits?.tenantDepositCents, "tenant deposit");
  const publisherBailCents = centsOrNull(input.deposits?.publisherBailRequirementCents, "publisher bail");
  const depositConfigured = tenantDepositCents !== null && publisherBailCents !== null;

  return {
    quotable: true,
    quote: normalizeQuote({
      schemaVersion: fixedFee ? 4 : deltaHaff.compatibility ? 2 : QUOTE_SCHEMA_VERSION,
      currency: "CNY",
      priceVersionId: input.priceVersionId,
      ruleReleaseId: null,
      mode: input.mode,
      lines: quoteLines,
      resourceTotal: yuanAmountObject(resourceTotalCents),
      ownerTotal: yuanAmountObject(ownerTotalCents),
      platformFullProfit: yuanAmountObject(resourceTotalCents - ownerTotalCents),
      tenantDeposit: tenantDepositCents === null ? null : yuanAmountObject(tenantDepositCents),
      publisherBailRequirement: publisherBailCents === null ? null : yuanAmountObject(publisherBailCents),
      termSeconds,
      expiryDisclosures,
      unitAmountsInformational: hasHaffLines || fixedFee,
      roundingPolicy: ROUNDING_POLICY,
      pricingInputs: {
        ...(deltaHaff.compatibility ? { compatibility: deltaHaff.compatibility } : {}),
        haffRatioSchema: haffSchema,
        conditions: hasHaffLines ? conditions : null,
        denominators:
          ownerDenominator !== null && buyerDenominator !== null
            ? { owner: formatDecimalExact(ownerDenominator), buyer: formatDecimalExact(buyerDenominator) }
            : null,
        spreadDelta: spreadDelta === null ? null : formatDecimalExact(spreadDelta),
        commissionRate: commissionRate === null ? null : formatDecimalExact(commissionRate),
        ...(fixedFee ? { fixedFeeAlgorithm: FIXED_FEE_ALGORITHM, fixedFeeGrossCents: resourceTotalCents.toString() } : {}),
        exactRatios,
        roundingPolicy: ROUNDING_POLICY,
        depositPolicy: depositConfigured ? "CONFIGURED" : "UNCONFIGURED",
        reasonCodes: depositConfigured ? [] : ["DEPENDENCY_UNAVAILABLE"],
      },
    }),
  };
}

export type PublishedQuoteProof = { accountId: string; gameId: string; contentHash: string; payload: ContentPayloadInput };

/** The caller must supply the authenticated, published listing read from the database. */
function computePublishedQuote(input: QuoteInput, proof: PublishedQuoteProof, model: "FIXED_FEE" | "SPREAD"): QuoteResult {
  const failed: QuoteResult = { quotable: false, reasonCodes: ["RULE_INPUT_MISSING"] };
  try {
    if (!proof || !/^[a-f0-9]{64}$/.test(proof.contentHash)
      || (model === "FIXED_FEE" ? input.fixedFeeAlgorithm !== FIXED_FEE_ALGORITHM : input.mode !== "SPREAD" || input.haffRule?.schema !== "haff-ratio-v2" || input.fixedFeeAlgorithm !== undefined)) return failed;
    const payload = normalizeContentPayload(proof.payload);
    if (payload.schemaVersion !== (model === "FIXED_FEE" ? 4 : 2) || payload.accountId !== proof.accountId || payload.gameId !== proof.gameId
      || computeContentHash(payload) !== proof.contentHash) return failed;
    const original = normalizeQuote(payload.quoteValues);
    if (model === "FIXED_FEE" && (!payload.pricingPolicy || payload.pricingPolicy.pricingModel !== "FIXED_FEE")
      || model === "SPREAD" && (original.mode !== "SPREAD" || payload.pricingPolicy && payload.pricingPolicy.pricingModel !== "SPREAD")
      || original.priceVersionId !== (payload.pricingPolicy?.priceVersionId ?? payload.ruleRefs.priceVersionId)
      || original.ruleReleaseId !== payload.ruleRefs.releaseId) return failed;
    const accepted = normalizeRentalPricing(payload.declaration.attributes.rentalPricing);
    const selected = normalizeRentalPricing(input.conditions.rentalPricing);
    if (accepted.rentalMode !== selected.rentalMode || accepted.ownerRatioB !== selected.ownerRatioB) return failed;
    const conditions = original.pricingInputs.conditions;
    if (!conditions || conditions.safeBoxCode !== input.conditions.safeBoxCode || conditions.vitLevel !== String(input.conditions.vitLevel)
      || conditions.bearLevel !== String(input.conditions.bearLevel) || conditions.termOptionCode !== input.conditions.termOptionCode
      || input.conditions.termOptionCode !== payload.declaration.termOptionCode) return failed;
    const attrs = payload.declaration.attributes;
    if (attrs.safe_box_code !== conditions.safeBoxCode || String(attrs.vit_level ?? attrs.vitLevel) !== conditions.vitLevel
      || String(attrs.bear_level ?? attrs.bearLevel) !== conditions.bearLevel) return failed;
    const originalLines = new Map(original.lines.map(line => [line.itemId, line]));
    const inventory = new Map(payload.declaration.inventory.map(line => [line.itemId, line.quantity]));
    if (originalLines.size !== original.lines.length || inventory.size !== original.lines.length || input.lines.length !== original.lines.length
      || new Set(input.lines.map(line => line.itemId)).size !== input.lines.length
      || input.lines.some(line => {
        const frozen = originalLines.get(line.itemId);
        return !frozen || inventory.get(line.itemId) !== frozen.quantity || line.quantity !== frozen.quantity
          || line.unit !== frozen.unit || line.pricingKind !== frozen.pricingKind
          || (line.pricingKind === "FIXED_UNIT" && line.unitQuantity !== frozen.unitQuantity);
      })) return failed;
    const result = computeDeltaQuoteInternal(input, accepted);
    return result.quotable && (result.quote.termSeconds !== original.termSeconds
      || JSON.stringify(result.quote.expiryDisclosures) !== JSON.stringify(original.expiryDisclosures)) ? failed : result;
  } catch { return failed; }
}

export function computePublishedFixedFeeQuote(input: QuoteInput, proof: PublishedQuoteProof): QuoteResult {
  return computePublishedQuote(input, proof, "FIXED_FEE");
}

export function computePublishedSpreadQuote(input: QuoteInput, proof: PublishedQuoteProof): QuoteResult {
  return computePublishedQuote(input, proof, "SPREAD");
}

export const computeQuote = computeDeltaQuote;

/** Legacy source prices are frozen once; later membership discounts use this quote as their base. */
export function computeLegacyListedQuote(input: { provenance: LegacyQuoteProvenance; priceVersionId: string; ruleReleaseId: string;
  lines: readonly PricingLineInput[]; tenantDepositCents: string; publisherBailRequirementCents: string; expiryDisclosures: ExpiryDisclosure[] }): InternalQuote {
  const p = input.provenance, base = quoteLegacyHaff({ haffMillions: p.haffMillions, ownerRatio: p.ownerRatio, spread: p.spread, recordedOwnerYuan: p.recordedOwnerYuan });
  const haff = input.lines.filter(line => line.pricingKind === "HAFF_RATIO" && line.unit === "HAFF_BASE");
  if (haff.length !== 1 || input.lines.filter(line => line.pricingKind === "HAFF_RATIO").length !== 1
    || haff[0]!.quantity !== (legacyPriceInteger(p.haffMillions, false) * HAFF_BASE_PER_MILLION).toString()) throw new Error("LEGACY_HAFF_QUANTITY_MISMATCH");
  const buyerCents = BigInt(base.renterCents), ownerCents = BigInt(base.ownerCents), millions = legacyPriceInteger(p.haffMillions, false);
  const unitFor = (cents: bigint) => quoteUnitAmount(divideToScale({ value: cents, scale: 2 }, { value: millions, scale: 0 }, 8));
  const lines: QuoteLine[] = [{ itemId: haff[0]!.itemId, quantity: haff[0]!.quantity, unit: "HAFF_BASE", unitQuantity: HAFF_BASE_PER_MILLION.toString(), pricingKind: "HAFF_RATIO",
    buyerUnitAmount: unitFor(buyerCents), ownerUnitAmount: unitFor(ownerCents), buyerAmount: yuanAmountObject(buyerCents), ownerAmount: yuanAmountObject(ownerCents), platformAmount: yuanAmountObject(buyerCents - ownerCents) }];
  let buyerTotal = buyerCents, ownerTotal = ownerCents;
  for (const line of input.lines.filter(item => item.pricingKind !== "HAFF_RATIO")) {
    const values = computeFixedUnitAmounts(line, "SPREAD");
    pushLine(lines, line, values.quantity, values.unitQuantity, values.buyerUnit, values.ownerUnit, values.buyerAmount.value, values.ownerAmount.value);
    buyerTotal += values.buyerAmount.value; ownerTotal += values.ownerAmount.value;
  }
  const tenant = parseNonNegativeDecimal(input.tenantDepositCents, 0, "tenant deposit").value;
  const ownerBail = parseNonNegativeDecimal(input.publisherBailRequirementCents, 0, "publisher bail").value;
  const roundingPolicy = "LEGACY_WHOLE_YUAN_PREPAY_V1";
  return normalizeQuote({ schemaVersion: 3, quoteSource: "LEGACY_QUOTED", legacyQuote: p, currency: "CNY", priceVersionId: input.priceVersionId,
    ruleReleaseId: input.ruleReleaseId, mode: "SPREAD", lines, resourceTotal: yuanAmountObject(buyerTotal), ownerTotal: yuanAmountObject(ownerTotal),
    platformFullProfit: yuanAmountObject(buyerTotal - ownerTotal), tenantDeposit: yuanAmountObject(tenant), publisherBailRequirement: yuanAmountObject(ownerBail),
    termSeconds: (legacyPriceInteger(p.rentalDays, false) * 86400n).toString(), expiryDisclosures: input.expiryDisclosures, unitAmountsInformational: true, roundingPolicy,
    pricingInputs: { haffRatioSchema: "legacy-listed-v1", compatibility: { rentalMode: p.rentalMode, customerTier: "STANDARD", ownerRatioB: p.ownerRatio }, conditions: null,
      denominators: { owner: p.ownerRatio, buyer: base.buyerRatio }, spreadDelta: p.spread, commissionRate: null,
      exactRatios: [{ itemId: haff[0]!.itemId, buyerNumerator: base.renterCents, buyerDenominator: "100", ownerNumerator: base.ownerCents, ownerDenominator: "100" }],
      roundingPolicy, depositPolicy: "CONFIGURED", reasonCodes: [] } });
}

function pushLine(
  quoteLines: QuoteLine[],
  line: PricingLineInput,
  quantity: Decimal,
  unitQuantity: Decimal,
  buyerUnit: Decimal,
  ownerUnit: Decimal,
  buyerCents: bigint,
  ownerCents: bigint,
): void {
  quoteLines.push({
    itemId: line.itemId,
    quantity: quantity.value.toString(),
    unit: line.unit ?? (line.pricingKind === "HAFF_RATIO" ? "HAFF_BASE" : "PIECE"),
    unitQuantity: unitQuantity.value.toString(),
    pricingKind: line.pricingKind,
    buyerUnitAmount: quoteUnitAmount(buyerUnit),
    ownerUnitAmount: quoteUnitAmount(ownerUnit),
    buyerAmount: yuanAmountObject(buyerCents),
    ownerAmount: yuanAmountObject(ownerCents),
    platformAmount: yuanAmountObject(buyerCents - ownerCents),
  });
}

export type QuoteViewer = DeltaQuoteViewer;
export type ProjectedQuote = DeltaProjectedQuote;
export { projectDeltaQuote };
export const projectQuote = projectDeltaQuote;
