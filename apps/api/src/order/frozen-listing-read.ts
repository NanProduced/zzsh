import type { PoolClient } from "pg";
import { effectivePublicationStateSql, projectPublicAttributeDisplay } from "../supply/listing-query";
import { publicAccountNumber } from "../supply/account-number";

/** Shared frozen-version reader (B2). Admin `readNativeFrozenAccounts` reuses `frozenResourceLines`. */
export type FrozenResourceLine = { itemId: string; code: string; name: string | null; quantity: string | null; unit: string };
export function frozenResourceLines(presentationItems: unknown, resources: Array<{ itemId: string; code: string; quantity: string | null; unit: string }>): FrozenResourceLine[] {
  const frozen = new Map<string, Record<string, unknown> | null>();
  for (const item of Array.isArray(presentationItems) ? presentationItems : [])
    if (item && typeof item === "object" && typeof item.id === "string") frozen.set(item.id, frozen.has(item.id) ? null : item);
  return resources.map(item => {
    const original = frozen.get(item.itemId);
    const name = typeof original?.name === "string" && original.name.trim() ? original.name : null;
    return { itemId: item.itemId, code: typeof original?.code === "string" ? original.code : item.code, name, quantity: item.quantity,
      unit: typeof original?.unit === "string" ? original.unit : item.unit };
  });
}

export type ListingFactsSource = "ORDER_VERSION" | "ACCOUNT_CURRENT";
export type OrderListingFacts = {
  source: ListingFactsSource; versionId: string | null; rentalMode: string | null;
  attributeDisplay: { safeBox: string | null; grading: string | null; loginMethod: string | null };
  resourceLines: FrozenResourceLine[]; termSeconds: string | null;
};
export type OrderEntitlement = { id: string; name: string | null; nameSource: "ORDER_VERSION" | "CURRENT_CATALOG" | "UNKNOWN"; expiresAt: string | null; expiryKind: "PERMANENT" | "TIMED" | null; fullTermGuaranteed: boolean | null };
export type OrderUserFacts = {
  accountDisplayNo: string | null;
  listingFacts: OrderListingFacts | null; listingFactsUnknownReason: string | null;
  entitlements: OrderEntitlement[] | null; entitlementsUnknownReason: string | null;
};
export type OrderFactsInput = {
  origin: "NATIVE" | "LEGACY"; orderId: string; accountId: string | null; versionId?: string | null; contentHash?: string | null;
  ownerUserId?: string | null;
};

const RESOURCE_AGG = `COALESCE(jsonb_agg(jsonb_build_object('itemId',l.item_id,'code',i.code,'quantity',l.quantity::text,'unit',i.unit) ORDER BY i.sort_order,i.id) FILTER(WHERE i.id IS NOT NULL),'[]'::jsonb) AS resources`;
/** Party-scoped (owner or renter of the order); version must match the order's frozen content_hash. */
export const NATIVE_ORDER_FACTS_SQL = `SELECT /* user-order-frozen-listing */ o.id AS "orderId",a.display_no AS "accountDisplayNo",v.id AS "versionId",v.attributes,
   v.presentation->'items' AS "presentationItems",v.presentation->'entitlements' AS "presentationEntitlements",
   o.term_seconds::text AS "termSeconds",o.quote_snapshot->'expiryDisclosures' AS disclosures,${RESOURCE_AGG}
  FROM jsonb_to_recordset($1::jsonb) AS wanted("orderId" text)
  JOIN zzsh_order.rental_order o ON o.id=wanted."orderId" AND (o.owner_user_id=$2 OR o.renter_user_id=$2)
  JOIN zzsh_supply.rental_account a ON a.id=o.account_id
  LEFT JOIN zzsh_supply.listing_version v ON v.id=o.listing_version_id AND v.account_id=o.account_id AND v.content_hash=o.content_hash
  LEFT JOIN zzsh_supply.inventory_line l ON l.version_id=v.id
  LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id
  GROUP BY o.id,a.display_no,v.id,v.attributes,v.presentation,o.term_seconds,o.quote_snapshot`;
/** Legacy orders (Owner decision): the account's CURRENT effective public version, labelled ACCOUNT_CURRENT. */
export const LEGACY_ORDER_FACTS_SQL = `SELECT /* user-legacy-order-current-listing */ s.id AS "orderId",a.display_no AS "accountDisplayNo",v.id AS "versionId",v.attributes,
   v.presentation->'items' AS "presentationItems",NULL::jsonb AS "presentationEntitlements",NULL::text AS "termSeconds",NULL::jsonb AS disclosures,${RESOURCE_AGG}
  FROM jsonb_to_recordset($1::jsonb) AS wanted("orderId" text)
  JOIN zzsh_order.legacy_order_read_snapshot s ON s.id=wanted."orderId" AND (s.owner_user_id=$2 OR s.renter_user_id=$2)
  JOIN zzsh_supply.rental_account a ON a.id=s.account_id
  LEFT JOIN LATERAL (SELECT cv.* FROM zzsh_supply.listing_publication p JOIN zzsh_supply.listing_version cv ON cv.id=p.version_id AND cv.account_id=p.account_id
     WHERE p.account_id=a.id AND ${effectivePublicationStateSql("cv", "p")} ORDER BY cv.sequence DESC LIMIT 1) v ON true
  LEFT JOIN zzsh_supply.inventory_line l ON l.version_id=v.id
  LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id
  GROUP BY s.id,a.display_no,v.id,v.attributes,v.presentation`;

type FactsRow = { orderId: string; accountDisplayNo: unknown; versionId: string | null; attributes: Record<string, unknown> | null; presentationItems: unknown;
  presentationEntitlements: unknown; termSeconds: string | null; disclosures: unknown; resources: Array<{ itemId: string; code: string; quantity: string | null; unit: string }> };

export function projectListingFacts(row: FactsRow, source: ListingFactsSource, showVersionId: boolean): OrderListingFacts | null {
  if (!row.versionId) return null;
  const attrs = row.attributes ?? {};
  const display = projectPublicAttributeDisplay(attrs);
  const mode = (attrs.rentalPricing as { rentalMode?: unknown } | undefined)?.rentalMode;
  return {
    source, versionId: showVersionId ? row.versionId : null, rentalMode: typeof mode === "string" ? mode : null,
    attributeDisplay: { safeBox: display.safeBox?.displayName ?? null, grading: display.grading?.displayName ?? null, loginMethod: display.loginMethod?.displayName ?? null },
    resourceLines: frozenResourceLines(row.presentationItems, Array.isArray(row.resources) ? row.resources : []),
    termSeconds: row.termSeconds,
  };
}

export function projectEntitlements(disclosures: unknown, presentation: unknown, catalog: ReadonlyMap<string, { name: string | null; expiryKind: "PERMANENT" | "TIMED" | null }>): OrderEntitlement[] | null {
  if (!Array.isArray(disclosures)) return null;
  const frozen = new Map<string, string>();
  for (const e of Array.isArray(presentation) ? presentation : []) if (e && typeof e.id === "string" && typeof e.name === "string" && e.name.trim()) frozen.set(e.id, e.name);
  const out: OrderEntitlement[] = [];
  for (const d of disclosures) {
    if (!d || typeof d !== "object" || typeof d.entitlementId !== "string") continue;
    const cat = catalog.get(d.entitlementId);
    const frozenName = frozen.get(d.entitlementId);
    out.push({ id: d.entitlementId, name: frozenName ?? cat?.name ?? null, nameSource: frozenName ? "ORDER_VERSION" : cat?.name ? "CURRENT_CATALOG" : "UNKNOWN",
      expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null, expiryKind: cat?.expiryKind ?? null,
      fullTermGuaranteed: typeof d.fullTermGuaranteed === "boolean" ? d.fullTermGuaranteed : null });
  }
  return out;
}

const validRow = (r: unknown): r is FactsRow => !!r && typeof (r as FactsRow).orderId === "string";

/** One bounded read per origin for this page (no N+1). Missing rows ⇒ null + unknownReason. */
export async function readOrderUserFacts(client: PoolClient, userId: string, inputs: OrderFactsInput[]): Promise<Map<string, OrderUserFacts>> {
  const result = new Map<string, OrderUserFacts>();
  const native = inputs.filter(i => i.origin === "NATIVE").map(i => ({ orderId: i.orderId }));
  const legacy = inputs.filter(i => i.origin === "LEGACY" && i.accountId).map(i => ({ orderId: i.orderId }));
  const nativeRows = native.length ? (await client.query<FactsRow>(NATIVE_ORDER_FACTS_SQL, [JSON.stringify(native), userId])).rows.filter(validRow) : [];
  const legacyRows = legacy.length ? (await client.query<FactsRow>(LEGACY_ORDER_FACTS_SQL, [JSON.stringify(legacy), userId])).rows.filter(validRow) : [];
  const ids = [...new Set(nativeRows.flatMap(r => Array.isArray(r.disclosures) ? r.disclosures.map((d: any) => d?.entitlementId).filter((x: unknown) => typeof x === "string") : []))];
  const catalog = new Map<string, { name: string | null; expiryKind: "PERMANENT" | "TIMED" | null }>();
  if (ids.length) for (const row of (await client.query<{ id: string; name: string | null; expiryKind: "PERMANENT" | "TIMED" | null }>(
    `SELECT id,name,expiry_kind AS "expiryKind" FROM zzsh_supply.entitlement WHERE id=ANY($1::text[])`, [ids])).rows) if (row && typeof row.id === "string") catalog.set(row.id, row);
  const byInput = new Map(inputs.map(i => [`${i.origin}:${i.orderId}`, i]));
  for (const row of nativeRows) {
    const facts = projectListingFacts(row, "ORDER_VERSION", true);
    const ents = projectEntitlements(row.disclosures, row.presentationEntitlements, catalog);
    result.set(`NATIVE:${row.orderId}`, { accountDisplayNo: publicAccountNumber(row.accountDisplayNo), listingFacts: facts, listingFactsUnknownReason: facts ? null : "ORDER_VERSION_UNREADABLE",
      entitlements: ents, entitlementsUnknownReason: ents ? null : "NOT_DISCLOSED" });
  }
  for (const row of legacyRows) {
    const input = byInput.get(`LEGACY:${row.orderId}`);
    const facts = projectListingFacts(row, "ACCOUNT_CURRENT", input?.ownerUserId === userId);
    result.set(`LEGACY:${row.orderId}`, { accountDisplayNo: publicAccountNumber(row.accountDisplayNo), listingFacts: facts, listingFactsUnknownReason: facts ? null : "ACCOUNT_PUBLIC_VERSION_MISSING",
      entitlements: null, entitlementsUnknownReason: "NOT_FROZEN" });
  }
  for (const i of inputs) if (!result.has(`${i.origin}:${i.orderId}`))
    result.set(`${i.origin}:${i.orderId}`, { accountDisplayNo: null, listingFacts: null, listingFactsUnknownReason: i.accountId ? "UNREADABLE" : "ACCOUNT_UNLINKED", entitlements: null, entitlementsUnknownReason: "UNREADABLE" });
  return result;
}

export function applyOrderUserFacts(item: Record<string, unknown>, facts: OrderUserFacts | undefined): void {
  if (!facts) return;
  item.accountDisplayNo = facts.accountDisplayNo;
  item.listingFacts = facts.listingFacts;
  item.listingFactsUnknownReason = facts.listingFactsUnknownReason;
  item.entitlements = facts.entitlements;
  item.entitlementsUnknownReason = facts.entitlementsUnknownReason;
}
