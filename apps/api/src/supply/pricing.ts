import { normalizeQuote } from "./content-hash";
import {
  DecimalError,
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
  DELTA_HAFF_RATIO_SCHEMA,
  DELTA_QUOTE_SCHEMA_VERSION,
  DELTA_ROUNDING_POLICY,
  projectDeltaQuote,
  resolveDeltaHaffContext,
  type DeltaHaffRule,
  type DeltaProjectedQuote,
  type DeltaQuoteReasonCode,
  type DeltaQuoteViewer,
} from "./delta-rental";

export const QUOTE_SCHEMA_VERSION = DELTA_QUOTE_SCHEMA_VERSION;
export const HAFF_RATIO_SCHEMA = DELTA_HAFF_RATIO_SCHEMA;
export const HAFF_BASE_PER_MILLION = DELTA_HAFF_BASE_PER_MILLION;
export const ROUNDING_POLICY = DELTA_ROUNDING_POLICY;

export type QuoteReasonCode = DeltaQuoteReasonCode;
export type HaffRatioRule = DeltaHaffRule;

export type PricingLineInput = {
  itemId: string;
  quantity: string;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
  unitQuantity?: string;
  buyerUnitAmount?: string;
  ownerUnitAmount?: string;
  unit?: "HAFF_BASE" | "ROUND" | "PIECE";
};

export type EntitlementInput = {
  entitlementId: string;
  expiryKind: "PERMANENT" | "TIMED";
  expiresAt?: string;
};

export type QuoteInput = {
  priceVersionId: string;
  mode: "SPREAD" | "PERCENT";
  roundingPolicy: string;
  commissionRate?: string;
  haffRule?: HaffRatioRule;
  lines: readonly PricingLineInput[];
  conditions: {
    safeBoxCode?: string;
    vitLevel?: number;
    bearLevel?: number;
    termOptionCode?: string;
    pricingOptionCode?: string;
  };
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
  unit: "HAFF_BASE" | "ROUND" | "PIECE";
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
  schemaVersion: 1;
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
    haffRatioSchema: string | null;
    conditions: Record<string, string> | null;
    denominators: { owner: string; buyer: string } | null;
    spreadDelta: string | null;
    commissionRate: string | null;
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

export function computeDeltaQuote(input: QuoteInput): QuoteResult {
  const reasons = new Set<QuoteReasonCode>();
  const fail = (code: QuoteReasonCode): void => {
    reasons.add(code);
  };

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
  const deltaHaff = resolveDeltaHaffContext({ mode: input.mode, haffRule: input.haffRule, hasHaffLines, conditions: input.conditions });
  for (const reason of deltaHaff.reasonCodes) fail(reason);
  const { haffSchema, ownerDenominator, buyerDenominator, spreadDelta, conditions } = deltaHaff;

  const quoteLines: QuoteLine[] = [];
  const exactRatios: QuoteExactRatio[] = [];
  let resourceTotalCents = 0n;
  let ownerTotalCents = 0n;
  let totalHaffBase = 0n;

  for (const line of input.lines) {
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
        const unitQuantity = parseNonNegativeDecimal(line.unitQuantity, 0, "unit quantity");
        if (unitQuantity.value <= 0n) throw new DecimalError("unit quantity must be positive");
        const buyerUnit = parseNonNegativeDecimal(line.buyerUnitAmount, 8, "buyer unit amount");
        const buyerAmount = divideToScale(multiplyDecimal(quantity, buyerUnit), unitQuantity, 2);
        let ownerAmount: Decimal;
        let ownerUnit: Decimal;
        if (input.mode === "SPREAD") {
          const ownerUnitParsed = parseNonNegativeDecimal(line.ownerUnitAmount!, 8, "owner unit amount");
          if (subtractDecimal(ownerUnitParsed, buyerUnit).value > 0n) throw new DecimalError("owner unit amount exceeds buyer unit amount");
          ownerAmount = divideToScale(multiplyDecimal(quantity, ownerUnitParsed), unitQuantity, 2);
          ownerUnit = ownerUnitParsed;
        } else {
          const keep = subtractDecimal({ value: 1n, scale: 0 }, commissionRate ?? { value: 0n, scale: 8 });
          ownerUnit = multiplyDecimal(buyerUnit, keep);
          ownerAmount = divideToScale(multiplyDecimal(quantity, ownerUnit), unitQuantity, 2);
        }
        if (ownerAmount.value > buyerAmount.value) throw new DecimalError("owner amount exceeds buyer amount");
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

  const tenantDepositCents = centsOrNull(input.deposits?.tenantDepositCents, "tenant deposit");
  const publisherBailCents = centsOrNull(input.deposits?.publisherBailRequirementCents, "publisher bail");
  const depositConfigured = tenantDepositCents !== null && publisherBailCents !== null;

  return {
    quotable: true,
    quote: normalizeQuote({
      schemaVersion: QUOTE_SCHEMA_VERSION,
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
      unitAmountsInformational: hasHaffLines,
      roundingPolicy: ROUNDING_POLICY,
      pricingInputs: {
        haffRatioSchema: haffSchema,
        conditions: hasHaffLines ? conditions : null,
        denominators:
          ownerDenominator !== null && buyerDenominator !== null
            ? { owner: formatDecimalExact(ownerDenominator), buyer: formatDecimalExact(buyerDenominator) }
            : null,
        spreadDelta: spreadDelta === null ? null : formatDecimalExact(spreadDelta),
        commissionRate: commissionRate === null ? null : formatDecimalExact(commissionRate),
        exactRatios,
        roundingPolicy: ROUNDING_POLICY,
        depositPolicy: depositConfigured ? "CONFIGURED" : "UNCONFIGURED",
        reasonCodes: depositConfigured ? [] : ["DEPENDENCY_UNAVAILABLE"],
      },
    }),
  };
}

export const computeQuote = computeDeltaQuote;

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
