import { createHash } from "node:crypto";
import { decimalToBigInt, divideToScale, multiplyDecimal, parseNonNegativeDecimal, parseSignedDecimal, formatDecimalAtScale, formatScaledInteger } from "./decimal";
import { CUSTOMER_TIERS, DeltaDeclarationError, normalizeDeltaAttributes, normalizeRentalPricing } from "./delta-rental";
import { legacyPriceInteger, quoteLegacyHaff } from "./legacy-listed-pricing";
import { calculateFixedFee, FIXED_FEE_ALGORITHM } from "./fixed-fee";
import type { InternalQuote } from "./pricing";

export class ContentHashError extends Error {}

export type InventoryDeclaration = { itemId: string; quantity: string };
export type EntitlementDeclaration = {
  entitlementId: string;
  value: unknown;
  expiresAt: string | null;
  expiryKnowledge: "KNOWN" | "UNKNOWN";
};
export type MediaBindingDeclaration = { assetId: string; byteHash: string; purpose: string; position: number };

export type ContentDeclaration = {
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  inventory: readonly InventoryDeclaration[];
  skins: readonly string[];
  entitlements: readonly EntitlementDeclaration[];
  termOptionCode: string;
  pricingOptionCode: string;
  mediaBindings: readonly MediaBindingDeclaration[];
};

export type ContentRuleRefs = {
  releaseId: string;
  catalogRevision?: string;
  priceVersionId: string;
  termVersionId: string;
  agreementVersionId: string;
  agreementDigest: string;
};

export type ContentPayloadInput = {
  schemaVersion: 1 | 2 | 3 | 4;
  accountId: string;
  gameId: string;
  declaration: ContentDeclaration;
  ruleRefs: ContentRuleRefs;
  quoteValues: Record<string, unknown>;
  pricingPolicy?: { schema: "pricing-policy-v1"; pricingModel: "SPREAD" | "FIXED_FEE"; scheduleId: string; generation: string; effectiveAt: string; priceVersionId: string };
  quoteSource?: "LEGACY_QUOTED";
  legacyQuote?: LegacyQuoteProvenance;
};

export type LegacyQuoteProvenance = {
  schema: "legacy-listed-quote-v1"; sourceSystem: "legacy_mysql_restore"; sourceEntity: "la_rental_accounts";
  legacyId: string; observationVersionId: string; sourceDigest: string; sourcePolicyDigest: string;
  haffMillions: string; ownerRatio: string; spread: string; recordedOwnerYuan: string;
  recordedTenantYuan: string | null; recordedVipYuan: string | null; depositYuan: string; rentalDays: string;
  rentalMode: "ordinary" | "custom" | "fast"; fullPayoutSelected: boolean;
};

const MAX_DEPTH = 24;

function fields(value: object, allowed: readonly string[]): void {
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !allowed.includes(key))) throw new ContentHashError("Unsupported content field");
}

export function humanText(value: string): string {
  if (typeof value !== "string") throw new ContentHashError("Invalid text");
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

function integerText(value: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ContentHashError("Invalid integer");
  return BigInt(value).toString();
}

function decimalText(value: string, scale?: number): string {
  try {
    const parsed = parseSignedDecimal(value, 24, "content decimal");
    if (scale !== undefined) return formatDecimalAtScale(parsed, scale);
    return parsed.scale ? formatScaledInteger(parsed.value, parsed.scale).replace(/\.?0+$/, "") : parsed.value.toString();
  } catch { throw new ContentHashError("Invalid exact decimal"); }
}

export function normalizeTime(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) throw new ContentHashError("Time must have at most microsecond precision");
  const local = new Date(match[1] + "Z");
  const utc = new Date(match[1]! + match[3]!);
  if (!Number.isFinite(utc.getTime()) || !Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== match[1]) throw new ContentHashError("Invalid time");
  return utc.toISOString().slice(0, 19) + "." + (match[2] ?? "").padEnd(6, "0") + "Z";
}

export function normalizeQuote(value: Record<string, unknown> | InternalQuote): InternalQuote {
  const q = value as InternalQuote;
  fields(value, ["schemaVersion", "currency", "priceVersionId", "ruleReleaseId", "mode", "lines", "resourceTotal", "ownerTotal", "platformFullProfit", "tenantDeposit", "publisherBailRequirement", "termSeconds", "expiryDisclosures", "unitAmountsInformational", "roundingPolicy", "pricingInputs", ...(q.schemaVersion === 3 ? ["quoteSource", "legacyQuote"] : [])]);
  if (![1, 2, 3, 4].includes(q.schemaVersion) || q.currency !== "CNY" || !["SPREAD", "PERCENT"].includes(q.mode) || !Array.isArray(q.lines)) throw new ContentHashError("Invalid quote");
  if (q.schemaVersion === 3) {
    if (q.quoteSource !== "LEGACY_QUOTED" || !q.legacyQuote) throw new ContentHashError("Legacy quote source is missing");
    validateLegacyProvenance(q.legacyQuote);
  }
  const amount = <T extends { currency: "CNY"; unit: "yuan"; amount: string; scale: 2 | 8 }>(v: T, scale: 2 | 8): T => {
    fields(v, ["currency", "unit", "amount", "scale"]);
    if (v.currency !== "CNY" || v.unit !== "yuan" || v.scale !== scale) throw new ContentHashError("Invalid amount unit");
    return { ...v, amount: decimalText(v.amount, scale) };
  };
  ensureUnique(q.lines.map((l) => l.itemId), "quote lines");
  const lines = sortByKeys(q.lines.map((l) => {
    fields(l, ["itemId", "quantity", "unit", "unitQuantity", "pricingKind", "buyerUnitAmount", "ownerUnitAmount", "buyerAmount", "ownerAmount", "platformAmount"]);
    return { ...l, quantity: integerText(l.quantity), unitQuantity: integerText(l.unitQuantity), buyerUnitAmount: amount(l.buyerUnitAmount, 8), ownerUnitAmount: amount(l.ownerUnitAmount, 8), buyerAmount: amount(l.buyerAmount, 2), ownerAmount: amount(l.ownerAmount, 2), platformAmount: amount(l.platformAmount, 2) };
  }), (l) => l.itemId);
  const p = q.pricingInputs;
  if (q.schemaVersion === 1 && ["haff-ratio-v2", "haff-ratio-v3"].includes(p.haffRatioSchema ?? "")) throw new ContentHashError("Compatibility quote requires a later schema");
  fields(p, ["haffRatioSchema", "conditions", "denominators", "spreadDelta", "commissionRate", "exactRatios", "roundingPolicy", "depositPolicy", "reasonCodes", ...(q.schemaVersion !== 1 ? ["compatibility"] : []), ...(q.schemaVersion === 4 ? ["fixedFeeAlgorithm", "fixedFeeGrossCents"] : [])]);
  if (q.schemaVersion === 2) {
    const c = p.compatibility;
    if (!c || q.mode !== "SPREAD" || p.haffRatioSchema !== "haff-ratio-v2") throw new ContentHashError("Invalid compatibility quote");
    fields(c, ["rentalMode", "customerTier", "baseRatioC", "ownerRatioB", "memberDelta"]);
    if (!["ordinary", "custom", "fast"].includes(c.rentalMode) || !CUSTOMER_TIERS.includes(c.customerTier)) throw new ContentHashError("Invalid compatibility inputs");
    if (!("baseRatioC" in c) || !("memberDelta" in c)) throw new ContentHashError("Invalid compatibility inputs");
    for (const key of ["baseRatioC", "ownerRatioB", "memberDelta"] as const) decimalText(c[key]);
  }
  if (q.schemaVersion === 3) {
    const c = p.compatibility;
    if (!c || q.mode !== "SPREAD" || p.haffRatioSchema !== "legacy-listed-v1") throw new ContentHashError("Invalid legacy quote");
    fields(c, ["rentalMode", "customerTier", "ownerRatioB"]);
    if (!["ordinary", "custom", "fast"].includes(c.rentalMode) || c.customerTier !== "STANDARD") throw new ContentHashError("Invalid legacy quote inputs");
    legacyPriceInteger(c.ownerRatioB, false);
  }
  if (q.schemaVersion === 4) {
    const c = p.compatibility;
    if (!c || q.mode !== "PERCENT" || p.haffRatioSchema !== "haff-ratio-v3" || p.fixedFeeAlgorithm !== FIXED_FEE_ALGORITHM
        || p.spreadDelta !== null || typeof p.commissionRate !== "string" || !p.denominators || q.unitAmountsInformational !== true
        || typeof p.fixedFeeGrossCents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(p.fixedFeeGrossCents))
      throw new ContentHashError("Invalid fixed-fee quote");
    fields(c, ["rentalMode", "customerTier", "baseRatioC", "ownerRatioB", "memberDelta"]);
    if (!["ordinary", "custom", "fast"].includes(c.rentalMode) || c.customerTier !== "STANDARD"
        || !("baseRatioC" in c) || !("memberDelta" in c) || decimalText(c.memberDelta) !== "0"
        || decimalText(c.ownerRatioB) !== decimalText(p.denominators.buyer)
        || decimalText(p.denominators.owner) !== decimalText(p.denominators.buyer)) throw new ContentHashError("Invalid fixed-fee inputs");
    let allocation: ReturnType<typeof calculateFixedFee>;
    try {
      if (parseNonNegativeDecimal(c.baseRatioC, 8, "base ratio").value <= 0n
          || parseNonNegativeDecimal(p.denominators.buyer, 8, "buyer ratio").value <= 0n) throw new Error();
      const haff = lines.filter((line) => line.pricingKind === "HAFF_RATIO");
      if (haff.length !== 1 || haff[0]!.unit !== "HAFF_BASE" || haff[0]!.unitQuantity !== "1000000") throw new Error();
      allocation = calculateFixedFee(lines.map((line) => {
        const quantity = parseNonNegativeDecimal(line.quantity, 0, "quantity");
        const unitQuantity = parseNonNegativeDecimal(line.unitQuantity, 0, "unit quantity");
        if (unitQuantity.value <= 0n) throw new Error();
        if (line.pricingKind === "HAFF_RATIO") return { itemId: line.itemId,
          grossCents: divideToScale({ value: quantity.value * 100n, scale: 0 },
            multiplyDecimal({ value: 1000000n, scale: 0 }, parseNonNegativeDecimal(p.denominators!.buyer, 8, "buyer ratio")), 2).value };
        if (line.pricingKind !== "FIXED_UNIT" || !["ROUND", "PIECE", "DAY"].includes(line.unit)) throw new Error();
        return { itemId: line.itemId, grossCents: divideToScale(multiplyDecimal(quantity,
          parseNonNegativeDecimal(line.buyerUnitAmount.amount, 8, "buyer unit")), unitQuantity, 2).value };
      }), p.commissionRate);
    } catch { throw new ContentHashError("Invalid fixed-fee rate or basis"); }
    const cents = (v: string) => decimalToBigInt(parseNonNegativeDecimal(v, 2, "fixed quote amount"), 2);
    const buyer = lines.reduce((sum, line) => sum + cents(line.buyerAmount.amount), 0n);
    const owner = lines.reduce((sum, line) => sum + cents(line.ownerAmount.amount), 0n);
    const platform = lines.reduce((sum, line) => sum + cents(line.platformAmount.amount), 0n);
    if (buyer !== cents(q.resourceTotal.amount) || owner !== cents(q.ownerTotal.amount)
        || platform !== cents(q.platformFullProfit.amount) || buyer !== owner + platform
        || allocation.grossCents !== BigInt(p.fixedFeeGrossCents) || buyer > allocation.grossCents
        || owner !== allocation.grossCents - allocation.feeCents
        || allocation.lines.some((line, index) => line.ownerCents !== cents(lines[index]!.ownerAmount.amount))
        || lines.some((line) => cents(line.buyerAmount.amount) !== cents(line.ownerAmount.amount) + cents(line.platformAmount.amount)))
      throw new ContentHashError("Fixed-fee quote totals do not balance");
  }
  if (p.conditions) fields(p.conditions, ["safeBoxCode", "vitLevel", "bearLevel", "termOptionCode", "pricingOptionCode"]);
  if (p.denominators) fields(p.denominators, ["owner", "buyer"]);
  ensureUnique(p.exactRatios.map((r) => r.itemId), "exact ratios");
  ensureUnique(q.expiryDisclosures.map((d) => d.entitlementId), "expiry disclosures");
  return {
    ...q, lines, ruleReleaseId: q.ruleReleaseId ?? null, termSeconds: integerText(q.termSeconds),
    resourceTotal: amount(q.resourceTotal, 2), ownerTotal: amount(q.ownerTotal, 2), platformFullProfit: amount(q.platformFullProfit, 2),
    tenantDeposit: q.tenantDeposit == null ? null : amount(q.tenantDeposit, 2), publisherBailRequirement: q.publisherBailRequirement == null ? null : amount(q.publisherBailRequirement, 2),
    expiryDisclosures: sortByKeys(q.expiryDisclosures.map((d) => { fields(d, ["entitlementId", "expiresAt", "fullTermGuaranteed"]); return { ...d, expiresAt: normalizeTime(d.expiresAt) }; }), (d) => d.entitlementId),
    pricingInputs: { ...p, spreadDelta: p.spreadDelta == null ? null : decimalText(p.spreadDelta), commissionRate: p.commissionRate == null ? null : decimalText(p.commissionRate),
      denominators: p.denominators ? { owner: decimalText(p.denominators.owner), buyer: decimalText(p.denominators.buyer) } : null,
      exactRatios: sortByKeys(p.exactRatios.map((r) => { fields(r, ["itemId", "buyerNumerator", "buyerDenominator", "ownerNumerator", "ownerDenominator"]); return { itemId: r.itemId, buyerNumerator: decimalText(r.buyerNumerator), buyerDenominator: decimalText(r.buyerDenominator), ownerNumerator: decimalText(r.ownerNumerator), ownerDenominator: decimalText(r.ownerDenominator) }; }), (r) => r.itemId), reasonCodes: [...p.reasonCodes].sort() },
  };
}

function sortByKeys<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function ensureUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ContentHashError(`${label} contains duplicate business keys`);
    seen.add(value);
  }
}

export function normalizeDeclaration(declaration: ContentDeclaration, schemaVersion: 1 | 2 | 3 | 4 = 1): ContentDeclaration {
  fields(declaration, ["title", "description", "attributes", "inventory", "skins", "entitlements", "termOptionCode", "pricingOptionCode", "mediaBindings"]);
  for (const media of declaration.mediaBindings) { fields(media, ["assetId", "byteHash", "purpose", "position"]); if (!Number.isSafeInteger(media.position) || media.position < 0) throw new ContentHashError("Invalid position"); }
  ensureUnique(declaration.inventory.map((item) => item.itemId), "inventory");
  ensureUnique(declaration.entitlements.map((item) => item.entitlementId), "entitlements");
  ensureUnique(declaration.skins, "skins");
  ensureUnique(declaration.mediaBindings.map((item) => `${item.purpose}:${item.position}:${item.assetId}`), "mediaBindings");
  let attributes: Record<string, unknown>;
  try {
    if (schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4) {
      const { rentalPricing, ...existing } = declaration.attributes;
      attributes = { ...normalizeDeltaAttributes(existing), rentalPricing: normalizeRentalPricing(rentalPricing) };
    } else attributes = normalizeDeltaAttributes(declaration.attributes);
  } catch (error) {
    if (error instanceof DeltaDeclarationError) throw new ContentHashError(error.message);
    throw error;
  }
  return {
    title: humanText(declaration.title),
    description: declaration.description == null ? null : humanText(declaration.description),
    attributes,
    inventory: sortByKeys(declaration.inventory.map((item) => { fields(item, ["itemId", "quantity"]); return { itemId: item.itemId, quantity: integerText(item.quantity) }; }), (item) => item.itemId),
    skins: [...declaration.skins].sort(),
    entitlements: sortByKeys(declaration.entitlements.map((item) => {
      fields(item, ["entitlementId", "value", "expiresAt", "expiryKnowledge"]);
      const value = item.value ?? null;
      if (value !== null && typeof value !== "boolean" && typeof value !== "string" && !(Number.isSafeInteger(value) && Number(value) >= 0)) throw new ContentHashError("Invalid entitlement value");
      if (!["KNOWN", "UNKNOWN"].includes(item.expiryKnowledge)) throw new ContentHashError("Invalid expiry knowledge");
      return { ...item, value: typeof value === "string" ? decimalText(value) : value, expiresAt: normalizeTime(item.expiresAt ?? null) };
    }), (item) => item.entitlementId),
    termOptionCode: declaration.termOptionCode,
    pricingOptionCode: declaration.pricingOptionCode,
    mediaBindings: sortByKeys(
      declaration.mediaBindings,
      (item) => `${item.purpose}:${String(item.position).padStart(8, "0")}:${item.assetId}`,
    ),
  };
}

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new ContentHashError("payload nesting is too deep");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new ContentHashError("payload numbers must be safe integers");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const parts: string[] = [];
    for (const [key, child] of entries) {
      if (key === "contentHash") throw new ContentHashError("payload must not contain contentHash");
      parts.push(`${JSON.stringify(key.normalize("NFC"))}:${canonicalize(child, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new ContentHashError("payload contains an unsupported value");
}

export function normalizeContentPayload(input: ContentPayloadInput): ContentPayloadInput {
  fields(input, ["schemaVersion", "accountId", "gameId", "declaration", "ruleRefs", "quoteValues", "quoteSource", "legacyQuote", "pricingPolicy"]);
  fields(input.ruleRefs, ["releaseId", "priceVersionId", "termVersionId", "agreementVersionId", "agreementDigest", "catalogRevision"]);
  if (Object.values(input.ruleRefs).some((value) => typeof value !== "string")) throw new ContentHashError("Invalid rule reference");
  if (input.ruleRefs.catalogRevision !== undefined && !/^(0|[1-9]\d*)$/.test(input.ruleRefs.catalogRevision)) throw new ContentHashError("Invalid catalog revision");
  if (![1, 2, 3, 4].includes(input.schemaVersion) || input.quoteValues.schemaVersion !== input.schemaVersion) throw new ContentHashError("Invalid content schema");
  if (input.schemaVersion !== 3 && (input.quoteSource !== undefined || input.legacyQuote !== undefined)) throw new ContentHashError("Legacy source requires content schema 3");
  let pricingPolicy: ContentPayloadInput["pricingPolicy"];
  if (input.pricingPolicy !== undefined) {
    const policy = input.pricingPolicy;
    fields(policy, ["schema", "pricingModel", "scheduleId", "generation", "effectiveAt", "priceVersionId"]);
    if (policy.schema !== "pricing-policy-v1" || !["SPREAD", "FIXED_FEE"].includes(policy.pricingModel)
      || (input.schemaVersion === 2 ? policy.pricingModel !== "SPREAD" : input.schemaVersion === 4 ? policy.pricingModel !== "FIXED_FEE" : true)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(policy.scheduleId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(policy.priceVersionId)
      || !/^[1-9]\d{0,18}$/.test(policy.generation)) throw new ContentHashError("Invalid pricing policy reference");
    const quote = normalizeQuote(input.quoteValues), effectiveAt = normalizeTime(policy.effectiveAt);
    if (!effectiveAt || quote.priceVersionId !== policy.priceVersionId || quote.ruleReleaseId !== input.ruleRefs.releaseId) throw new ContentHashError("Pricing policy and listing quote disagree");
    pricingPolicy = { ...policy, effectiveAt };
  }
  if (input.schemaVersion === 2 || input.schemaVersion === 4) {
    const choice = normalizeRentalPricing(input.declaration.attributes.rentalPricing);
    const quote = normalizeQuote(input.quoteValues);
    if (quote.pricingInputs.compatibility?.customerTier !== "STANDARD" || choice.rentalMode !== quote.pricingInputs.compatibility.rentalMode || (choice.ownerRatioB !== undefined && choice.ownerRatioB !== decimalText(quote.pricingInputs.compatibility.ownerRatioB))) throw new ContentHashError("Declaration and quote pricing disagree");
  }
  if (input.schemaVersion === 3) validateLegacyContent(input);
  return {
    schemaVersion: input.schemaVersion,
    accountId: input.accountId,
    gameId: input.gameId,
    declaration: normalizeDeclaration(input.declaration, input.schemaVersion),
    ruleRefs: input.ruleRefs,
    quoteValues: normalizeQuote(input.quoteValues) as unknown as Record<string, unknown>,
    ...(pricingPolicy ? { pricingPolicy } : {}),
    ...(input.schemaVersion === 3 ? { quoteSource: input.quoteSource, legacyQuote: input.legacyQuote } : {}),
  };
}

function validateLegacyProvenance(p: LegacyQuoteProvenance): void {
  fields(p, ["schema", "sourceSystem", "sourceEntity", "legacyId", "observationVersionId", "sourceDigest", "sourcePolicyDigest", "haffMillions", "ownerRatio", "spread", "recordedOwnerYuan", "recordedTenantYuan", "recordedVipYuan", "depositYuan", "rentalDays", "rentalMode", "fullPayoutSelected"]);
  if (p.schema !== "legacy-listed-quote-v1" || p.sourceSystem !== "legacy_mysql_restore" || p.sourceEntity !== "la_rental_accounts"
    || !/^[1-9]\d{0,23}$/.test(p.legacyId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.observationVersionId) || !/^[a-f0-9]{64}$/.test(p.sourceDigest) || !/^[a-f0-9]{64}$/.test(p.sourcePolicyDigest)
    || !["ordinary", "custom", "fast"].includes(p.rentalMode) || typeof p.fullPayoutSelected !== "boolean"
    || [p.recordedTenantYuan, p.recordedVipYuan].some(value => value !== null && typeof value !== "string")) throw new ContentHashError("Legacy quote provenance is invalid");
}

function validateLegacyContent(input: ContentPayloadInput): void {
  const p = input.legacyQuote, q = normalizeQuote(input.quoteValues);
  if (input.quoteSource !== "LEGACY_QUOTED" || !p) throw new ContentHashError("Legacy quote source is missing");
  validateLegacyProvenance(p);
  try {
    const base = quoteLegacyHaff({ haffMillions: p.haffMillions, ownerRatio: p.ownerRatio, spread: p.spread, recordedOwnerYuan: p.recordedOwnerYuan });
    const days = legacyPriceInteger(p.rentalDays, false), deposit = decimalToBigInt(parseNonNegativeDecimal(p.depositYuan, 2, "legacy deposit"), 2);
    for (const value of [p.recordedTenantYuan, p.recordedVipYuan]) if (value !== null) parseNonNegativeDecimal(value, 2, "recorded legacy price");
    const cents = (value: string) => decimalToBigInt(parseNonNegativeDecimal(value, 2, "legacy quote amount"), 2);
    const haff = q.lines.filter(line => line.pricingKind === "HAFF_RATIO" && line.unit === "HAFF_BASE");
    const ratio = haff.length === 1 ? q.pricingInputs.exactRatios.find(item => item.itemId === haff[0]!.itemId) : undefined;
    const c = q.pricingInputs.compatibility, choice = normalizeRentalPricing(input.declaration.attributes.rentalPricing);
    const payout = input.declaration.attributes.full_payout_declaration as { schema?: unknown; selected?: unknown } | undefined;
    const depositDeclaration = input.declaration.attributes.owner_deposit_declaration as { schema?: unknown; amountCents?: unknown } | undefined;
    const reference = input.declaration.attributes.legacy_published_reference;
    if (q.schemaVersion !== 3 || q.quoteSource !== input.quoteSource || canonicalize(q.legacyQuote) !== canonicalize(p)
      || q.priceVersionId !== input.ruleRefs.priceVersionId || q.ruleReleaseId !== input.ruleRefs.releaseId
      || q.roundingPolicy !== "LEGACY_WHOLE_YUAN_PREPAY_V1" || q.pricingInputs.roundingPolicy !== q.roundingPolicy
      || q.pricingInputs.depositPolicy !== "CONFIGURED" || !q.tenantDeposit || cents(q.tenantDeposit.amount) !== deposit
      || q.termSeconds !== (days * 86400n).toString() || q.unitAmountsInformational !== true
      || !c || c.customerTier !== "STANDARD" || c.rentalMode !== p.rentalMode || c.ownerRatioB !== p.ownerRatio
      || choice.rentalMode !== p.rentalMode || choice.ownerRatioB !== undefined && choice.ownerRatioB !== p.ownerRatio
      || !payout || payout.schema !== "full-payout-declaration-v1" || payout.selected !== p.fullPayoutSelected
      || !depositDeclaration || depositDeclaration.schema !== "owner-deposit-declaration-v1" || depositDeclaration.amountCents !== deposit.toString()
      || typeof reference !== "string" || !/^[a-f0-9]{64}$/.test(reference)
      || q.lines.filter(line => line.pricingKind === "HAFF_RATIO").length !== 1
      || haff.length !== 1 || haff[0]!.unitQuantity !== "1000000" || haff[0]!.quantity !== (legacyPriceInteger(p.haffMillions, false) * 1000000n).toString()
      || cents(haff[0]!.ownerAmount.amount).toString() !== base.ownerCents || cents(haff[0]!.buyerAmount.amount).toString() !== base.renterCents
      || !ratio || ratio.ownerNumerator !== base.ownerCents || ratio.ownerDenominator !== "100" || ratio.buyerNumerator !== base.renterCents || ratio.buyerDenominator !== "100"
      || q.pricingInputs.exactRatios.length !== 1 || q.pricingInputs.denominators?.owner !== p.ownerRatio || q.pricingInputs.denominators?.buyer !== base.buyerRatio
      || q.pricingInputs.spreadDelta !== p.spread) throw new Error();
    let buyer = 0n, owner = 0n;
    const declared = new Map(input.declaration.inventory.map(item => [item.itemId, item.quantity]));
    if (declared.size !== input.declaration.inventory.length || declared.size !== q.lines.length) throw new Error();
    for (const line of q.lines) {
      const b = cents(line.buyerAmount.amount), o = cents(line.ownerAmount.amount);
      if (declared.get(line.itemId) !== line.quantity || b < o || cents(line.platformAmount.amount) !== b - o) throw new Error();
      if (line.pricingKind === "FIXED_UNIT") {
        if (!(["ROUND", "PIECE", "DAY"] as string[]).includes(line.unit)) throw new Error();
        const quantity = parseNonNegativeDecimal(line.quantity, 0, "legacy quantity");
        const units = parseNonNegativeDecimal(line.unitQuantity, 0, "legacy unit quantity");
        const buyerUnit = parseNonNegativeDecimal(line.buyerUnitAmount.amount, 8, "legacy buyer unit");
        const ownerUnit = parseNonNegativeDecimal(line.ownerUnitAmount.amount, 8, "legacy owner unit");
        if (units.value <= 0n || divideToScale(multiplyDecimal(quantity, buyerUnit), units, 2).value !== b
          || divideToScale(multiplyDecimal(quantity, ownerUnit), units, 2).value !== o) throw new Error();
      } else if (line.pricingKind !== "HAFF_RATIO") throw new Error();
      buyer += b; owner += o;
    }
    if (cents(q.resourceTotal.amount) !== buyer || cents(q.ownerTotal.amount) !== owner || cents(q.platformFullProfit.amount) !== buyer - owner) throw new Error();
  } catch { throw new ContentHashError("Legacy quote does not match its source facts"); }
}

export function canonicalizeContentPayload(input: ContentPayloadInput): string {
  return canonicalize(normalizeContentPayload(input), 0);
}

export function computeContentHash(input: ContentPayloadInput): string {
  return createHash("sha256").update(canonicalizeContentPayload(input), "utf8").digest("hex");
}

export function withoutContentHash<T extends { contentHash?: string }>(value: T): Omit<T, "contentHash"> {
  const { contentHash: _ignored, ...rest } = value;
  return rest;
}
