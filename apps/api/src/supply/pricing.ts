import { normalizeQuote } from "./content-hash";
import {
  addDecimal,
  ceilDiv,
  DecimalError,
  divideToScale,
  formatDecimalExact,
  formatScaledInteger,
  multiplyDecimal,
  parseNonNegativeDecimal,
  parseSignedDecimal,
  subtractDecimal,
  yuanAmountObject,
  type Decimal,
} from "./decimal";

export const QUOTE_SCHEMA_VERSION = 1;
export const HAFF_RATIO_SCHEMA = "haff-ratio-v1";
export const HAFF_BASE_PER_MILLION = 1_000_000n;
export const ROUNDING_POLICY = "HALF_UP_CENT_V1";

export type QuoteReasonCode =
  | "DEPENDENCY_UNAVAILABLE"
  | "ROUNDING_POLICY_UNSUPPORTED"
  | "INVALID_QUANTITY"
  | "INVALID_DENOMINATOR"
  | "RULE_INPUT_MISSING"
  | "TERM_UNDETERMINED"
  | "EXPIRY_UNKNOWN";

export type HaffRatioRule = {
  schema: string;
  baseBySafeBox: Record<string, string>;
  vitalityDeltaByLevel: Record<string, string>;
  bearDeltaByLevel: Record<string, string>;
  dailyDeltaByTermOption: Record<string, string>;
  options: Record<string, { delta: string; enabled: boolean }>;
  spreadDelta?: string;
};

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

export function computeQuote(input: QuoteInput): QuoteResult {
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

  const haffRule = input.haffRule;
  const hasHaffLines = input.lines.some((line) => line.pricingKind === "HAFF_RATIO");
  let haffSchema: string | null = null;
  let ownerDenominator: Decimal | null = null;
  let buyerDenominator: Decimal | null = null;
  let spreadDelta: Decimal | null = null;
  const conditions: Record<string, string> = {};

  if (input.mode === "SPREAD" && (!haffRule || typeof haffRule.spreadDelta !== "string")) {
    fail("RULE_INPUT_MISSING");
  }

  if (hasHaffLines) {
    if (!haffRule || haffRule.schema !== HAFF_RATIO_SCHEMA) {
      fail("DEPENDENCY_UNAVAILABLE");
    } else {
      haffSchema = haffRule.schema;
      const { safeBoxCode, pricingOptionCode, termOptionCode, vitLevel, bearLevel } = input.conditions;
      if (!safeBoxCode || !pricingOptionCode || !termOptionCode || vitLevel === undefined || bearLevel === undefined) {
        fail("RULE_INPUT_MISSING");
      } else {
        conditions.safeBoxCode = safeBoxCode;
        conditions.vitLevel = String(vitLevel);
        conditions.bearLevel = String(bearLevel);
        conditions.termOptionCode = termOptionCode;
        conditions.pricingOptionCode = pricingOptionCode;
        const option = haffRule.options[pricingOptionCode];
        const base = haffRule.baseBySafeBox[safeBoxCode];
        const vitality = haffRule.vitalityDeltaByLevel[String(vitLevel)];
        const bear = haffRule.bearDeltaByLevel[String(bearLevel)];
        const daily = haffRule.dailyDeltaByTermOption[termOptionCode];
        if (base === undefined || vitality === undefined || bear === undefined || daily === undefined || !option) {
          fail("DEPENDENCY_UNAVAILABLE");
        } else {
          try {
            if (!option.enabled) fail("DEPENDENCY_UNAVAILABLE");
            const denominator = addDecimal(
              addDecimal(parseNonNegativeDecimal(base, 8, "base ratio"), parseSignedDecimal(vitality, 8, "vitality delta")),
              addDecimal(
                parseSignedDecimal(bear, 8, "bear delta"),
                addDecimal(parseSignedDecimal(daily, 8, "daily delta"), parseSignedDecimal(option.delta, 8, "option delta")),
              ),
            );
            ownerDenominator = denominator;
            if (input.mode === "SPREAD") {
              spreadDelta = parseNonNegativeDecimal(haffRule.spreadDelta!, 8, "spread delta");
              buyerDenominator = subtractDecimal(denominator, spreadDelta);
            } else {
              buyerDenominator = denominator;
            }
            if (ownerDenominator.value <= 0n || buyerDenominator.value <= 0n) fail("INVALID_DENOMINATOR");
          } catch {
            fail("DEPENDENCY_UNAVAILABLE");
          }
        }
      }
    }
  }

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

  let termSeconds: string | null = null;
  if (totalHaffBase > 0n) {
    try {
      const daily = parseNonNegativeDecimal(input.termOption.dailyConsumption, 0, "daily consumption");
      if (daily.value <= 0n) throw new DecimalError("daily consumption must be positive");
      if (input.termOption.durationRounding !== "CEIL_DAY") throw new DecimalError("unsupported duration rounding");
      const days = ceilDiv(totalHaffBase, daily.value);
      termSeconds = (days * 86_400n).toString();
    } catch {
      fail("TERM_UNDETERMINED");
    }
  } else {
    fail("TERM_UNDETERMINED");
  }

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

export type QuoteViewer = "public" | "owner" | "admin";

type ProjectedLine = {
  itemId: string;
  quantity: string;
  unit: string;
  unitQuantity: string;
  buyerUnitAmount: QuoteUnitAmount;
  buyerAmount: QuoteAmount;
  ownerUnitAmount?: QuoteUnitAmount;
  ownerAmount?: QuoteAmount;
  platformAmount?: QuoteAmount;
};

export type ProjectedQuote = {
  schemaVersion: 1;
  currency: "CNY";
  ruleReleaseId: string | null;
  lines: ProjectedLine[];
  resourceTotal: QuoteAmount;
  termSeconds: string;
  expiryDisclosures: ExpiryDisclosure[];
  unitAmountsInformational: boolean;
  tenantDeposit?: QuoteAmount | null;
  ownerTotal?: QuoteAmount;
  publisherBailRequirement?: QuoteAmount | null;
  contentHash?: string;
  platformFullProfit?: QuoteAmount;
  pricingInputs?: InternalQuote["pricingInputs"];
  roundingPolicy?: string;
};

export function projectQuote(quote: InternalQuote, viewer: QuoteViewer): ProjectedQuote {
  const lines: ProjectedLine[] = quote.lines.map((line) => {
    const projected: ProjectedLine = {
      itemId: line.itemId,
      quantity: line.quantity,
      unit: line.unit,
      unitQuantity: line.unitQuantity,
      buyerUnitAmount: line.buyerUnitAmount,
      buyerAmount: line.buyerAmount,
    };
    if (viewer === "owner" || viewer === "admin") {
      projected.ownerUnitAmount = line.ownerUnitAmount;
      projected.ownerAmount = line.ownerAmount;
    }
    if (viewer === "admin") {
      projected.platformAmount = line.platformAmount;
    }
    return projected;
  });
  const projected: ProjectedQuote = {
    schemaVersion: quote.schemaVersion,
    currency: quote.currency,
    ruleReleaseId: quote.ruleReleaseId,
    lines,
    resourceTotal: quote.resourceTotal,
    tenantDeposit: quote.tenantDeposit,
    termSeconds: quote.termSeconds,
    expiryDisclosures: quote.expiryDisclosures,
    unitAmountsInformational: quote.unitAmountsInformational,
  };
  if (viewer === "owner" || viewer === "admin") {
    projected.ownerTotal = quote.ownerTotal;
    projected.publisherBailRequirement = quote.publisherBailRequirement;
    projected.contentHash = quote.contentHash;
  }
  if (viewer === "admin") {
    projected.platformFullProfit = quote.platformFullProfit;
    projected.pricingInputs = quote.pricingInputs;
    projected.roundingPolicy = quote.roundingPolicy;
  }
  return projected;
}
