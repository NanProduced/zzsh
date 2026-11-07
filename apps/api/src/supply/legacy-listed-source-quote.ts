import { canonicalize, type LegacyQuoteProvenance } from "./content-hash";
import { calculateDeltaTermSeconds } from "./delta-rental";
import { legacyDisplayMatchesSource, type LegacyDisplaySnapshot } from "./legacy-display-snapshot";
import { DELTA_LEGACY_RESOURCES } from "./legacy-observation";
import { readLegacyListedPolicy } from "./legacy-listed-policy";
import { readLegacyListedSource } from "./legacy-listed-source";
import { computeLegacyListedQuote, type ExpiryDisclosure, type PricingLineInput } from "./pricing";

const MATERIALS = {
  level6_bullet_num: ["level6_bullet_price", "bulletSale", "60"],
  awm_bullet_num: ["awm_bullet_price", "awmSale", "1"],
  barrett_bullet_num: ["barrett_bullet_price", "barrettBulletSale", "1"],
  level6_armor_num: ["level6_armor_price", "armorSale", "1"],
  level6_helmet_num: ["level6_helmet_price", "helmetSale", "1"],
  coffee_num: ["coffee_price", "coffeeSale", "1"],
  top_insure_card_num: ["top_insure_card_price", "experienceCardSale", "1"],
} as const;

/**
 * Pure, source-bound quote candidate. Expected evidence hashes must come from a separately reviewed
 * controlled importer. Constructing a candidate alone never publishes a listing or authorizes payment.
 */
export function buildLegacyListedSourceQuote(input: {
  sourceCanonical: string;
  source: { sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; observationVersionId: string };
  policyCanonical: string; policyBinding: Parameters<typeof readLegacyListedPolicy>[1];
  display: LegacyDisplaySnapshot;
  catalog: readonly { id: string; code: string; unit: string; quantityScale: number }[];
  declaredInventory: readonly { itemId: string; quantity: string }[];
  termOption: { dailyConsumption: string; durationRounding: "CEIL_DAY" };
  priceVersionId: string; ruleReleaseId: string; publisherBailRequirementCents: string;
  expiryDisclosures: ExpiryDisclosure[];
}) {
  const source = readLegacyListedSource(input.sourceCanonical, input.source);
  const row = JSON.parse(input.sourceCanonical) as Record<string, string | null>;
  const binding = input.policyBinding;
  if (binding.sourceId !== input.source.legacyId || binding.sourceDigest !== input.source.sourceDigest || binding.legacyGameId !== row.game_id)
    throw new Error("LEGACY_POLICY_SOURCE_BINDING_MISMATCH");
  const policy = readLegacyListedPolicy(input.policyCanonical, binding);
  if (!legacyDisplayMatchesSource(row, input.display)) throw new Error("LEGACY_DISPLAY_SOURCE_MISMATCH");
  if (typeof row.default_consume_type !== "string" || !/^[1-3]$/.test(row.default_consume_type)
    || input.termOption.dailyConsumption !== (BigInt(row.default_consume_type) * 10000000n).toString()) throw new Error("LEGACY_DAILY_CONSUMPTION_MISMATCH");
  const term = calculateDeltaTermSeconds(BigInt(source.haffMillions) * 1000000n, input.termOption);
  if (term.termSeconds !== (BigInt(source.rentalDays) * 86400n).toString()) throw new Error("LEGACY_RENTAL_TERM_MISMATCH");
  const lines: PricingLineInput[] = [];
  for (const [field, codes] of DELTA_LEGACY_RESOURCES) {
    const resource = input.display.resources.find(item => item.field === field);
    const found = input.catalog.filter(item => (codes as readonly string[]).includes(item.code));
    if (!resource || resource.quantity === null || found.length !== 1 || found[0]!.unit !== resource.unit || found[0]!.quantityScale !== 0)
      throw new Error("LEGACY_RESOURCE_BINDING_MISMATCH");
    const item = found[0]!;
    if (field === "haff") lines.push({ itemId:item.id, quantity:resource.quantity, unit:"HAFF_BASE", pricingKind:"HAFF_RATIO" });
    else {
      const [ownerKey, saleKey, unitQuantity] = MATERIALS[field];
      const owner = row[ownerKey], buyer = policy.salePrices[saleKey];
      if (typeof owner !== "string" || typeof buyer !== "string") throw new Error("LEGACY_RESOURCE_PRICE_MISSING");
      lines.push({ itemId:item.id, quantity:resource.quantity, unit:resource.unit as "ROUND" | "PIECE" | "DAY", pricingKind:"FIXED_UNIT", unitQuantity, buyerUnitAmount:buyer, ownerUnitAmount:owner });
    }
  }
  const expectedInventory = lines.map(({ itemId, quantity }) => ({ itemId, quantity })).sort((a,b)=>a.itemId.localeCompare(b.itemId));
  const declared = [...input.declaredInventory].sort((a,b)=>a.itemId.localeCompare(b.itemId));
  if (canonicalize(expectedInventory) !== canonicalize(declared)) throw new Error("LEGACY_INVENTORY_SOURCE_MISMATCH");
  const provenance: LegacyQuoteProvenance = { schema:"legacy-listed-quote-v1", sourceSystem:"legacy_mysql_restore", sourceEntity:"la_rental_accounts",
    legacyId:input.source.legacyId, observationVersionId:input.source.observationVersionId, sourceDigest:input.source.sourceDigest, sourcePolicyDigest:policy.policyDigest,
    haffMillions:source.haffMillions, ownerRatio:source.ownerRatio, spread:source.rentalMode === "fast" ? policy.fastSpread : policy.ordinarySpread,
    recordedOwnerYuan:source.recordedOwnerYuan, recordedTenantYuan:source.recordedTenantYuan as string | null, recordedVipYuan:source.recordedVipYuan as string | null,
    depositYuan:source.depositYuan, rentalDays:source.rentalDays, rentalMode:source.rentalMode, fullPayoutSelected:source.fullPayoutSelected };
  const deposit = source.depositYuan.split(".");
  const tenantDepositCents = (BigInt(deposit[0]!) * 100n + BigInt((deposit[1] ?? "").padEnd(2,"0"))).toString();
  return { provenance, quote:computeLegacyListedQuote({ provenance, priceVersionId:input.priceVersionId, ruleReleaseId:input.ruleReleaseId,
    lines, tenantDepositCents, publisherBailRequirementCents:input.publisherBailRequirementCents, expiryDisclosures:input.expiryDisclosures }),
    policyCanonical:policy.policyCanonical, temporalLimit:policy.temporalLimit };
}
