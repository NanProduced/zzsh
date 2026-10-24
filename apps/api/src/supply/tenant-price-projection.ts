import { SecurityApiError } from "../auth/security-core";
import { formatDecimalExact, formatDecimalAtScale, parseNonNegativeDecimal } from "./decimal";
import { projectDeltaQuote, type InternalQuote, type QuoteAmount, type QuoteUnitAmount } from "./pricing";

type PublicQuote = ReturnType<typeof projectDeltaQuote>;
export type TenantPriceLine = Pick<PublicQuote["lines"][number], "itemId" | "quantity" | "unit" | "unitQuantity" | "buyerUnitAmount" | "buyerAmount">;
export type TenantPriceQuote = {
  schemaVersion: 1 | 2;
  currency: "CNY";
  ruleReleaseId: string | null;
  lines: TenantPriceLine[];
  resourceTotal: QuoteAmount;
  tenantDeposit: QuoteAmount | null;
  tenantPayableTotal: QuoteAmount | null;
  termSeconds: string;
  expiryDisclosures: InternalQuote["expiryDisclosures"];
  unitAmountsInformational: boolean;
  rentalMode?: "ordinary" | "custom" | "fast";
  /** Published STANDARD buyer ratio, before this renter's benefits; 万哈夫币/元. */
  baseRenterHaffRatioWanPerYuan: string | null;
};

const unavailable = (): never => { throw new SecurityApiError(503, "CONFIRMATION_DEPENDENCY_UNAVAILABLE", "Tenant price projection is unavailable"); };
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The caller must first verify the publication tuple/hash; an arbitrary quote is not publication authority. */
export function publishedBaseRenterHaffRatioWanPerYuan(publishedQuote: unknown): string | null {
  const quote = record(publishedQuote), inputs = record(quote?.pricingInputs), denominators = record(inputs?.denominators);
  if (!quote || !inputs || !denominators || !Array.isArray(quote.lines) || !quote.lines.some(line => record(line)?.unit === "HAFF_BASE")) return null;
  const compatibility = record(inputs.compatibility);
  if (compatibility && compatibility.customerTier !== "STANDARD") return null;
  if (quote.schemaVersion === 1 && inputs.haffRatioSchema !== "haff-ratio-v1"
    || quote.schemaVersion === 2 && (inputs.haffRatioSchema !== "haff-ratio-v2" || compatibility?.customerTier !== "STANDARD")
    || quote.schemaVersion !== 1 && quote.schemaVersion !== 2 || typeof denominators.buyer !== "string") return null;
  try {
    // pricing uses Q * 100 / (1,000,000 * D): D is already 万哈夫币/元.
    const ratio = parseNonNegativeDecimal(denominators.buyer, 8, "published buyer ratio");
    return ratio.value > 0n ? formatDecimalExact(ratio) : null;
  } catch { return null; }
}

function decimalText(value: unknown, maxScale: number, positive = false): string {
  if (typeof value !== "string") return unavailable();
  try {
    const parsed = parseNonNegativeDecimal(value, maxScale, "tenant quote value");
    if (positive && parsed.value === 0n) return unavailable();
    return value;
  } catch { return unavailable(); }
}

function amount(value: unknown, scale: 2): QuoteAmount;
function amount(value: unknown, scale: 8): QuoteUnitAmount;
function amount(value: unknown, scale: 2 | 8): QuoteAmount | QuoteUnitAmount {
  const item = record(value);
  if (!item || item.currency !== "CNY" || item.unit !== "yuan" || item.scale !== scale) return unavailable();
  const text = decimalText(item.amount, scale);
  const formatted = formatDecimalAtScale(parseNonNegativeDecimal(text, scale, "tenant quote amount"), scale);
  return scale === 2 ? { currency: "CNY", unit: "yuan", amount: formatted, scale: 2 } : { currency: "CNY", unit: "yuan", amount: formatted, scale: 8 };
}

export function projectTenantMoney(value: unknown): QuoteAmount { return amount(value, 2); }

/** Renter-only nested whitelist. publishedQuote must be the bound publication, never the selected discounted offer. */
export function projectTenantPriceQuote(quote: InternalQuote, publishedQuote: unknown): TenantPriceQuote {
  let projected: PublicQuote;
  try { projected = projectDeltaQuote(quote, "public"); }
  catch { return unavailable(); }
  if (![1, 2].includes(projected.schemaVersion) || projected.currency !== "CNY" || !Array.isArray(projected.lines)
    || !Array.isArray(projected.expiryDisclosures) || typeof projected.unitAmountsInformational !== "boolean"
    || projected.ruleReleaseId !== null && typeof projected.ruleReleaseId !== "string") return unavailable();
  const lines = projected.lines.map((line): TenantPriceLine => {
    if (typeof line.itemId !== "string" || !line.itemId || typeof line.unit !== "string" || !line.unit) return unavailable();
    return { itemId: line.itemId, quantity: decimalText(line.quantity, 8), unit: line.unit,
      unitQuantity: decimalText(line.unitQuantity, 8, true), buyerUnitAmount: amount(line.buyerUnitAmount, 8), buyerAmount: amount(line.buyerAmount, 2) };
  });
  const expiryDisclosures = projected.expiryDisclosures.map(item => {
    if (typeof item.entitlementId !== "string" || !item.entitlementId || item.fullTermGuaranteed !== false
      || item.expiresAt !== null && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt)))) return unavailable();
    return { entitlementId: item.entitlementId, expiresAt: item.expiresAt, fullTermGuaranteed: false as const };
  });
  const rentalMode = projected.rentalMode;
  if (rentalMode !== undefined && rentalMode !== "ordinary" && rentalMode !== "custom" && rentalMode !== "fast") return unavailable();
  return {
    schemaVersion: projected.schemaVersion, currency: "CNY", ruleReleaseId: projected.ruleReleaseId,
    lines, resourceTotal: amount(projected.resourceTotal, 2),
    tenantDeposit: projected.tenantDeposit == null ? null : amount(projected.tenantDeposit, 2),
    tenantPayableTotal: projected.tenantPayableTotal == null ? null : amount(projected.tenantPayableTotal, 2),
    termSeconds: decimalText(projected.termSeconds, 0), expiryDisclosures, unitAmountsInformational: projected.unitAmountsInformational,
    ...(rentalMode === undefined ? {} : { rentalMode }),
    baseRenterHaffRatioWanPerYuan: publishedBaseRenterHaffRatioWanPerYuan(publishedQuote),
  };
}
