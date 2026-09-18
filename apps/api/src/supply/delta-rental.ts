import {
  addDecimal,
  ceilDiv,
  DecimalError,
  formatDecimalExact,
  formatScaledInteger,
  parseNonNegativeDecimal,
  parseSignedDecimal,
  subtractDecimal,
  yuanAmountObject,
  type Decimal,
} from "./decimal";
import { ensureOnlyFields, invalid } from "./supply-util";
import type { ExpiryDisclosure, InternalQuote, QuoteAmount, QuoteUnitAmount } from "./pricing";

export const DELTA_QUOTE_SCHEMA_VERSION = 1;
export const DELTA_HAFF_RATIO_SCHEMA = "haff-ratio-v1";
export const DELTA_HAFF_BASE_PER_MILLION = 1_000_000n;
export const DELTA_ROUNDING_POLICY = "HALF_UP_CENT_V1";

export type DeltaQuoteReasonCode =
  | "DEPENDENCY_UNAVAILABLE"
  | "ROUNDING_POLICY_UNSUPPORTED"
  | "INVALID_QUANTITY"
  | "INVALID_DENOMINATOR"
  | "RULE_INPUT_MISSING"
  | "TERM_UNDETERMINED"
  | "EXPIRY_UNKNOWN";

export type DeltaHaffRule = {
  schema: string;
  baseBySafeBox: Record<string, string>;
  vitalityDeltaByLevel: Record<string, string>;
  bearDeltaByLevel: Record<string, string>;
  dailyDeltaByTermOption: Record<string, string>;
  options: Record<string, { delta: string; enabled: boolean }>;
  spreadDelta?: string;
};

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;
const SIGNED_DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(?:\.\d{1,8})?$/;
const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

function parsePositiveDecimalMap(value: unknown, label: string, allowZero: boolean): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} is invalid`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CODE_PATTERN.test(key) || typeof entry !== "string" || !DECIMAL_PATTERN.test(entry)) throw invalid(`${label} is invalid`);
    if (!allowZero && /^0(?:\.0+)?$/.test(entry)) throw invalid(`${label} must be positive`);
    result[key] = formatDecimalExact(parseSignedDecimal(entry, 8, label));
  }
  if (Object.keys(result).length === 0) throw invalid(`${label} must not be empty`);
  return result;
}

function parseSignedDecimalMap(value: unknown, label: string, integerKeys: boolean): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} is invalid`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (integerKeys ? !/^(0|[1-9]\d*)$/.test(key) : !CODE_PATTERN.test(key)) throw invalid(`${label} is invalid`);
    if (typeof entry !== "string" || !SIGNED_DECIMAL_PATTERN.test(entry)) throw invalid(`${label} is invalid`);
    result[key] = formatDecimalExact(parseSignedDecimal(entry, 8, label));
  }
  if (Object.keys(result).length === 0) throw invalid(`${label} must not be empty`);
  return result;
}

export function validateDeltaHaffRule(value: unknown, mode: "SPREAD" | "PERCENT"): DeltaHaffRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Haff rule is invalid");
  const rule = value as Record<string, unknown>;
  ensureOnlyFields(rule, ["schema", "baseBySafeBox", "vitalityDeltaByLevel", "bearDeltaByLevel", "dailyDeltaByTermOption", "options", "spreadDelta"]);
  if (rule.schema !== DELTA_HAFF_RATIO_SCHEMA) throw invalid("Haff rule schema is unsupported");
  const baseBySafeBox = parsePositiveDecimalMap(rule.baseBySafeBox, "Haff base ratios", false);
  const vitalityDeltaByLevel = parseSignedDecimalMap(rule.vitalityDeltaByLevel, "Haff vitality deltas", true);
  const bearDeltaByLevel = parseSignedDecimalMap(rule.bearDeltaByLevel, "Haff bear deltas", true);
  const dailyDeltaByTermOption = parseSignedDecimalMap(rule.dailyDeltaByTermOption, "Haff daily deltas", false);
  if (!rule.options || typeof rule.options !== "object" || Array.isArray(rule.options)) throw invalid("Haff options are invalid");
  const options: Record<string, { delta: string; enabled: boolean }> = {};
  let enabledOptions = 0;
  for (const [key, entry] of Object.entries(rule.options as Record<string, unknown>)) {
    if (!CODE_PATTERN.test(key) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Haff options are invalid");
    const option = entry as Record<string, unknown>;
    ensureOnlyFields(option, ["delta", "enabled"]);
    if (typeof option.delta !== "string" || !SIGNED_DECIMAL_PATTERN.test(option.delta) || typeof option.enabled !== "boolean") throw invalid("Haff options are invalid");
    if (option.enabled) enabledOptions += 1;
    options[key] = { delta: formatDecimalExact(parseSignedDecimal(option.delta, 8, "option delta")), enabled: option.enabled };
  }
  if (Object.keys(options).length === 0 || enabledOptions === 0) throw invalid("Haff rule requires at least one enabled option");
  if (mode === "SPREAD") {
    if (typeof rule.spreadDelta !== "string" || !DECIMAL_PATTERN.test(rule.spreadDelta)) throw invalid("Spread delta is required for SPREAD mode");
    return { schema: DELTA_HAFF_RATIO_SCHEMA, baseBySafeBox, vitalityDeltaByLevel, bearDeltaByLevel, dailyDeltaByTermOption, options, spreadDelta: formatDecimalExact(parseSignedDecimal(rule.spreadDelta, 8, "spread delta")) };
  }
  if (rule.spreadDelta !== undefined) throw invalid("Spread delta is only valid for SPREAD mode");
  return { schema: DELTA_HAFF_RATIO_SCHEMA, baseBySafeBox, vitalityDeltaByLevel, bearDeltaByLevel, dailyDeltaByTermOption, options };
}

export type DeltaPriceLineInputBody = {
  itemId: string;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
  unitQuantity?: string;
  buyerUnitAmount?: string;
  ownerUnitAmount?: string;
};

export function parseDeltaPriceLines(value: unknown, mode: "SPREAD" | "PERCENT"): DeltaPriceLineInputBody[] {
  if (!Array.isArray(value)) throw invalid("Price lines must be an array");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Price line is invalid");
    const line = entry as Record<string, unknown>;
    const itemId = line.itemId;
    const pricingKind = line.pricingKind;
    if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 128) throw invalid("Price line item is invalid");
    if (pricingKind !== "FIXED_UNIT" && pricingKind !== "HAFF_RATIO") throw invalid("Price line kind is invalid");
    if (seen.has(itemId)) throw invalid("Price lines must not repeat an item");
    seen.add(itemId);
    const parsed: DeltaPriceLineInputBody = { itemId, pricingKind };
    const unitQuantity = line.unitQuantity;
    if (unitQuantity !== undefined) {
      if (typeof unitQuantity !== "string" || !/^[1-9]\d{0,23}$/.test(unitQuantity)) throw invalid("Unit quantity is invalid");
      parsed.unitQuantity = unitQuantity;
    }
    for (const field of ["buyerUnitAmount", "ownerUnitAmount"] as const) {
      const entryValue = line[field];
      if (entryValue === undefined) continue;
      if (typeof entryValue !== "string" || !DECIMAL_PATTERN.test(entryValue)) throw invalid("Unit amount is invalid");
      parsed[field] = entryValue;
    }
    if (pricingKind === "FIXED_UNIT") {
      if (parsed.unitQuantity === undefined || parsed.buyerUnitAmount === undefined) throw invalid("Fixed lines require a buyer unit amount");
      if (mode === "SPREAD" && parsed.ownerUnitAmount === undefined) throw invalid("SPREAD fixed lines require an owner unit amount");
      if (mode === "PERCENT" && parsed.ownerUnitAmount !== undefined) throw invalid("PERCENT fixed lines derive the owner amount");
    } else if ([parsed.unitQuantity, parsed.buyerUnitAmount, parsed.ownerUnitAmount].some((entryValue) => entryValue !== undefined)) {
      throw invalid("Haff ratio lines cannot define unit amounts");
    }
    return parsed;
  });
}

export type DeltaHaffConditions = {
  safeBoxCode?: string;
  vitLevel?: number;
  bearLevel?: number;
  termOptionCode?: string;
  pricingOptionCode?: string;
};

export type DeltaHaffContext = {
  haffSchema: string | null;
  ownerDenominator: Decimal | null;
  buyerDenominator: Decimal | null;
  spreadDelta: Decimal | null;
  conditions: Record<string, string>;
  reasonCodes: DeltaQuoteReasonCode[];
};

export function resolveDeltaHaffContext(input: {
  mode: "SPREAD" | "PERCENT";
  haffRule?: DeltaHaffRule | null;
  hasHaffLines: boolean;
  conditions: DeltaHaffConditions;
}): DeltaHaffContext {
  const reasons = new Set<DeltaQuoteReasonCode>();
  const fail = (code: DeltaQuoteReasonCode): void => { reasons.add(code); };
  let haffSchema: string | null = null;
  let ownerDenominator: Decimal | null = null;
  let buyerDenominator: Decimal | null = null;
  let spreadDelta: Decimal | null = null;
  const conditions: Record<string, string> = {};
  const haffRule = input.haffRule;

  if (input.mode === "SPREAD" && (!haffRule || typeof haffRule.spreadDelta !== "string")) fail("RULE_INPUT_MISSING");
  if (input.hasHaffLines) {
    if (!haffRule || haffRule.schema !== DELTA_HAFF_RATIO_SCHEMA) {
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
  return { haffSchema, ownerDenominator, buyerDenominator, spreadDelta, conditions, reasonCodes: [...reasons] };
}

export function calculateDeltaTermSeconds(
  totalHaffBase: bigint,
  termOption: { dailyConsumption: string; durationRounding: "CEIL_DAY" },
): { termSeconds: string | null; reasonCodes: DeltaQuoteReasonCode[] } {
  if (totalHaffBase <= 0n) return { termSeconds: null, reasonCodes: ["TERM_UNDETERMINED"] };
  try {
    const daily = parseNonNegativeDecimal(termOption.dailyConsumption, 0, "daily consumption");
    if (daily.value <= 0n) throw new DecimalError("daily consumption must be positive");
    if (termOption.durationRounding !== "CEIL_DAY") throw new DecimalError("unsupported duration rounding");
    return { termSeconds: (ceilDiv(totalHaffBase, daily.value) * 86_400n).toString(), reasonCodes: [] };
  } catch {
    return { termSeconds: null, reasonCodes: ["TERM_UNDETERMINED"] };
  }
}

export class DeltaDeclarationError extends Error {}

const DELTA_LEVEL_FIELDS = ["vitLevel", "bearLevel", "vit_level", "bear_level", "dive_level", "character_level", "awm_weapon_count", "service_window_start_minute", "service_window_end_minute"] as const;
const DELTA_TEXT_FIELDS = ["safe_box_code", "grading_code", "login_method_code", "legacy_helmet_code", "legacy_armor_code", "legacy_insure_code", "service_window_timezone", "region_province", "region_city", "info_source"] as const;
const DELTA_BOOLEAN_FIELDS = ["ban_record", "face_is_self", "service_window_cross_midnight"] as const;

function deltaFields(value: object, allowed: readonly string[]): void {
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !allowed.includes(key))) throw new DeltaDeclarationError("Unsupported Delta declaration field");
}

function deltaHumanText(value: unknown): string {
  if (typeof value !== "string") throw new DeltaDeclarationError("Invalid Delta declaration text");
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

function deltaDecimalText(value: unknown): string {
  if (typeof value !== "string") throw new DeltaDeclarationError("Invalid Delta declaration decimal");
  try {
    const parsed = parseSignedDecimal(value, 24, "declaration decimal");
    return parsed.scale ? formatScaledInteger(parsed.value, parsed.scale).replace(/\.?0+$/, "") : parsed.value.toString();
  } catch {
    throw new DeltaDeclarationError("Invalid Delta declaration decimal");
  }
}

export function normalizeDeltaAttributes(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = [...DELTA_LEVEL_FIELDS, ...DELTA_TEXT_FIELDS, ...DELTA_BOOLEAN_FIELDS, "secret_kd"];
  deltaFields(value, allowed);
  return Object.fromEntries(allowed.map((key) => {
    const child = value[key] ?? null;
    if (child === null) return [key, null];
    if ((DELTA_LEVEL_FIELDS as readonly string[]).includes(key) && (!Number.isSafeInteger(child) || Number(child) < 0 || Number(child) > 2147483647)) throw new DeltaDeclarationError("Invalid Delta level");
    if ((DELTA_BOOLEAN_FIELDS as readonly string[]).includes(key) && typeof child !== "boolean") throw new DeltaDeclarationError("Invalid Delta flag");
    if (key === "secret_kd") return [key, deltaDecimalText(child)];
    if ((DELTA_TEXT_FIELDS as readonly string[]).includes(key)) return [key, deltaHumanText(child)];
    return [key, child];
  }));
}

export type DeltaQuoteViewer = "public" | "owner" | "admin";

type DeltaProjectedLine = {
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

export type DeltaProjectedQuote = {
  schemaVersion: 1;
  currency: "CNY";
  ruleReleaseId: string | null;
  lines: DeltaProjectedLine[];
  resourceTotal: QuoteAmount;
  termSeconds: string;
  expiryDisclosures: ExpiryDisclosure[];
  unitAmountsInformational: boolean;
  tenantDeposit?: QuoteAmount | null;
  tenantPayableTotal: QuoteAmount | null;
  ownerTotal?: QuoteAmount;
  publisherBailRequirement?: QuoteAmount | null;
  contentHash?: string;
  platformFullProfit?: QuoteAmount;
  pricingInputs?: InternalQuote["pricingInputs"];
  roundingPolicy?: string;
};

function tenantPayableTotal(resourceTotal: QuoteAmount, tenantDeposit: QuoteAmount | null | undefined): QuoteAmount | null {
  if (tenantDeposit == null) return null;
  const resourceCents = parseNonNegativeDecimal(resourceTotal.amount, 2, "resource total").value;
  const depositCents = parseNonNegativeDecimal(tenantDeposit.amount, 2, "tenant deposit").value;
  return yuanAmountObject(resourceCents + depositCents);
}

export function projectDeltaQuote(quote: InternalQuote | DeltaProjectedQuote, viewer: DeltaQuoteViewer): DeltaProjectedQuote {
  const lines: DeltaProjectedLine[] = quote.lines.map((line) => {
    const projected: DeltaProjectedLine = {
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
    if (viewer === "admin") projected.platformAmount = line.platformAmount;
    return projected;
  });
  const projected: DeltaProjectedQuote = {
    schemaVersion: quote.schemaVersion,
    currency: quote.currency,
    ruleReleaseId: quote.ruleReleaseId,
    lines,
    resourceTotal: quote.resourceTotal,
    tenantDeposit: quote.tenantDeposit,
    tenantPayableTotal: tenantPayableTotal(quote.resourceTotal, quote.tenantDeposit),
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
