import { legacyPriceInteger } from "./legacy-listed-pricing";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A marker check is not a source authorization: the listing and its hash must also be verified by the caller. */
export function isLegacyListedQuote(value: unknown): boolean {
  const quote = record(value), source = record(quote?.legacyQuote);
  return quote?.schemaVersion === 3 && quote.quoteSource === "LEGACY_QUOTED"
    && source?.schema === "legacy-listed-quote-v1" && source.sourceSystem === "legacy_mysql_restore"
    && source.sourceEntity === "la_rental_accounts";
}

/** Read the source formula ratio; frozen amounts and settlement ratios are independent. */
export function legacyListedSourceRatio(value: unknown, side: "buyer" | "owner"): string | null {
  if (!isLegacyListedQuote(value)) return null;
  const quote = record(value)!, source = record(quote.legacyQuote), inputs = record(quote.pricingInputs);
  const denominators = record(inputs?.denominators), compatibility = record(inputs?.compatibility);
  if (!Array.isArray(quote.lines)) return null;
  const lines = quote.lines.map(record).filter(line => line?.pricingKind === "HAFF_RATIO" && line.unit === "HAFF_BASE");
  if (lines.length !== 1 || quote.lines.filter(line => record(line)?.pricingKind === "HAFF_RATIO").length !== 1
    || !source || !inputs || !denominators || !compatibility || inputs.haffRatioSchema !== "legacy-listed-v1"
    || quote.currency !== "CNY" || !["ordinary", "custom", "fast"].includes(String(source.rentalMode))
    || typeof source.legacyId !== "string" || !/^[1-9]\d{0,23}$/.test(source.legacyId)
    || typeof source.observationVersionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.observationVersionId)
    || typeof source.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceDigest)
    || typeof source.sourcePolicyDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.sourcePolicyDigest)
    || typeof source.fullPayoutSelected !== "boolean" || typeof source.haffMillions !== "string"
    || compatibility.customerTier !== "STANDARD" || compatibility.rentalMode !== source.rentalMode
    || compatibility.ownerRatioB !== source.ownerRatio || inputs.spreadDelta !== source.spread
    || typeof source.ownerRatio !== "string" || typeof source.spread !== "string") return null;
  try {
    const owner = legacyPriceInteger(source.ownerRatio, false), spread = legacyPriceInteger(source.spread, true);
    const quantity = legacyPriceInteger(source.haffMillions, false) * 1000000n;
    if (lines[0]!.quantity !== quantity.toString() || lines[0]!.unitQuantity !== "1000000"
      || owner <= spread || denominators.owner !== source.ownerRatio || denominators.buyer !== (owner - spread).toString()) return null;
    return side === "owner" ? owner.toString() : (owner - spread).toString();
  } catch { return null; }
}
