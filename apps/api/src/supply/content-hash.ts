import { createHash } from "node:crypto";
import { parseSignedDecimal, formatDecimalAtScale, formatScaledInteger } from "./decimal";
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
  priceVersionId: string;
  termVersionId: string;
  agreementVersionId: string;
  agreementDigest: string;
};

export type ContentPayloadInput = {
  schemaVersion: 1;
  accountId: string;
  gameId: string;
  declaration: ContentDeclaration;
  ruleRefs: ContentRuleRefs;
  quoteValues: Record<string, unknown>;
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

function normalizeAttributes(value: Record<string, unknown>): Record<string, unknown> {
  const levels = ["vitLevel", "bearLevel", "vit_level", "bear_level", "dive_level", "character_level", "awm_weapon_count", "service_window_start_minute", "service_window_end_minute"];
  const texts = ["grading_code", "login_method_code", "legacy_helmet_code", "legacy_armor_code", "legacy_insure_code", "service_window_timezone", "region_province", "region_city", "info_source"];
  const booleans = ["ban_record", "face_is_self", "service_window_cross_midnight"];
  fields(value, [...levels, ...texts, ...booleans, "secret_kd"]);
  return Object.fromEntries([...levels, ...texts, ...booleans, "secret_kd"].map((key) => {
    const child = value[key] ?? null;
    if (child === null) return [key, null];
    if (levels.includes(key) && (!Number.isSafeInteger(child) || Number(child) < 0 || Number(child) > 2147483647)) throw new ContentHashError("Invalid level");
    if (booleans.includes(key) && typeof child !== "boolean") throw new ContentHashError("Invalid flag");
    return [key, key === "secret_kd" ? decimalText(child as string) : texts.includes(key) ? humanText(child as string) : child];
  }));
}

export function normalizeQuote(value: Record<string, unknown> | InternalQuote): InternalQuote {
  fields(value, ["schemaVersion", "currency", "priceVersionId", "ruleReleaseId", "mode", "lines", "resourceTotal", "ownerTotal", "platformFullProfit", "tenantDeposit", "publisherBailRequirement", "termSeconds", "expiryDisclosures", "unitAmountsInformational", "roundingPolicy", "pricingInputs"]);
  const q = value as InternalQuote;
  if (q.schemaVersion !== 1 || q.currency !== "CNY" || !["SPREAD", "PERCENT"].includes(q.mode) || !Array.isArray(q.lines)) throw new ContentHashError("Invalid quote");
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
  fields(p, ["haffRatioSchema", "conditions", "denominators", "spreadDelta", "commissionRate", "exactRatios", "roundingPolicy", "depositPolicy", "reasonCodes"]);
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

export function normalizeDeclaration(declaration: ContentDeclaration): ContentDeclaration {
  fields(declaration, ["title", "description", "attributes", "inventory", "skins", "entitlements", "termOptionCode", "pricingOptionCode", "mediaBindings"]);
  for (const media of declaration.mediaBindings) { fields(media, ["assetId", "byteHash", "purpose", "position"]); if (!Number.isSafeInteger(media.position) || media.position < 0) throw new ContentHashError("Invalid position"); }
  ensureUnique(declaration.inventory.map((item) => item.itemId), "inventory");
  ensureUnique(declaration.entitlements.map((item) => item.entitlementId), "entitlements");
  ensureUnique(declaration.skins, "skins");
  ensureUnique(declaration.mediaBindings.map((item) => `${item.purpose}:${item.position}:${item.assetId}`), "mediaBindings");
  return {
    title: humanText(declaration.title),
    description: declaration.description == null ? null : humanText(declaration.description),
    attributes: normalizeAttributes(declaration.attributes),
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

function canonicalize(value: unknown, depth: number): string {
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
  fields(input, ["schemaVersion", "accountId", "gameId", "declaration", "ruleRefs", "quoteValues"]);
  fields(input.ruleRefs, ["releaseId", "priceVersionId", "termVersionId", "agreementVersionId", "agreementDigest"]);
  if (Object.values(input.ruleRefs).some((value) => typeof value !== "string")) throw new ContentHashError("Invalid rule reference");
  if (input.schemaVersion !== 1) throw new ContentHashError("Invalid content schema");
  return {
    schemaVersion: 1,
    accountId: input.accountId,
    gameId: input.gameId,
    declaration: normalizeDeclaration(input.declaration),
    ruleRefs: input.ruleRefs,
    quoteValues: normalizeQuote(input.quoteValues) as unknown as Record<string, unknown>,
  };
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
