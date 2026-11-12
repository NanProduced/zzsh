import type { PoolClient } from "pg";
import type { AccountImageCdn, AccountImageDelivery } from "./account-image-cdn";
import type { LegacyImageCdnDelivery, LegacyImageProof } from "./legacy-image-cdn";
import { isLegacyImagePath, type LegacyMediaRecord } from "./legacy-path-media";
import { readLegacyPublishedReference } from "./legacy-published-reference";

export type PublicListingProjection = Record<string, unknown> & {
  id: string;
  versionId: string;
  media: { assetId: string; url: string; coverUrl?: string; detailUrl?: string }[];
  legacyImages?: { position: number; url: string; cdnUrl?: string; state?: "PENDING_IMPORT" | "UNAVAILABLE" }[];
};

type LegacyReference = NonNullable<Awaited<ReturnType<typeof readLegacyPublishedReference>>>;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const key = (accountId: string, versionId: string) => JSON.stringify([accountId, versionId]);

/** Input DTOs must already have passed the public listing reader. */
async function readNativeReferences(client: PoolClient, listings: PublicListingProjection[]): Promise<Map<string, LegacyReference>> {
  const wanted = listings.filter(item => item.source !== "LEGACY_READ_ONLY" && idPattern.test(item.id) && idPattern.test(item.versionId) && item.media.length === 0);
  const result = new Map<string, LegacyReference>();
  if (!wanted.length) return result;
  const requested = new Set(wanted.map(item => key(item.id, item.versionId)));
  const rows = (await client.query<{ accountId: string; versionId: string; marker: string | null; payloadMarker: string | null }>(
    `SELECT v.account_id AS "accountId",v.id AS "versionId",v.attributes->>'legacy_published_reference' AS "marker",
            v.payload#>>'{declaration,attributes,legacy_published_reference}' AS "payloadMarker"
       FROM zzsh_supply.listing_version v
       JOIN unnest($1::text[],$2::text[]) AS wanted(account_id,version_id) ON wanted.account_id=v.account_id AND wanted.version_id=v.id
       JOIN zzsh_supply.rental_account a ON a.id=v.account_id
       JOIN zzsh_supply.listing_publication p ON p.account_id=v.account_id AND p.version_id=v.id AND p.owner_user_id=a.owner_user_id AND p.game_id=a.game_id
         AND p.content_hash=v.content_hash AND p.rule_release_id=v.rule_release_id
      WHERE v.origin='NATIVE' AND ((v.review_state='PUBLISHED' AND p.source='OWNER_DIRECT') OR (v.review_state='APPROVED' AND p.source='LEGACY_APPROVED'))
        AND jsonb_typeof(v.attributes->'legacy_published_reference')='string'
        AND jsonb_typeof(v.payload#>'{declaration,attributes,legacy_published_reference}')='string'
        AND CASE WHEN jsonb_typeof(v.payload#>'{declaration,mediaBindings}')='array' THEN jsonb_array_length(v.payload#>'{declaration,mediaBindings}')=0 ELSE false END
        AND NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_media lm WHERE lm.version_id=v.id)`,
    [wanted.map(item => item.id), wanted.map(item => item.versionId)],
  )).rows;
  for (const row of rows) {
    if (!requested.has(key(row.accountId, row.versionId)) || typeof row.marker !== "string" || !/^[a-f0-9]{64}$/.test(row.marker) || row.marker !== row.payloadMarker) continue;
    const reference = await readLegacyPublishedReference(client, row.accountId, row.marker);
    if (reference) result.set(key(row.accountId, row.versionId), reference);
  }
  return result;
}

/** Revalidates the frozen marker for the exact already-public native version. */
export async function readNativeLegacyPathReference(client: PoolClient, listing: PublicListingProjection): Promise<LegacyReference | null> {
  return (await readNativeReferences(client, [listing])).get(key(listing.id, listing.versionId)) ?? null;
}

/** Only call with an already-authorized public listing and its server-loaded account record. */
export async function authorizeLegacyPublicSlot(client: PoolClient, listing: PublicListingProjection, row: LegacyMediaRecord | null, index: number): Promise<string | null> {
  if (!row || listing.id !== row.accountId || typeof listing.versionId !== "string" || !Number.isSafeInteger(index) || index < 0 || !Array.isArray(listing.media) || listing.media.length !== 0 || !Array.isArray(row.displayPaths) || !isLegacyImagePath(row.displayPaths[index]) || row.sourceDigest !== row.currentSourceDigest) return null;
  const url = `/api/v1/supply/listings/${row.accountId}/legacy-images/${index}`;
  if (!Array.isArray(listing.legacyImages) || !listing.legacyImages.some((item: unknown) => item !== null && typeof item === "object" && (item as { url?: unknown }).url === url)) return null;
  if (listing.source === "LEGACY_READ_ONLY") return listing.versionId === row.observationVersionId ? row.observationVersionId : null;
  const reference = await readNativeLegacyPathReference(client, listing);
  return reference && reference.sourceDigest === row.sourceDigest && reference.observationVersionId === row.observationVersionId && reference.slots.some(slot => slot.position === index && slot.path === row.displayPaths[index]) ? reference.observationVersionId : null;
}

/** Listings must already have passed their ordinary public-read guards. */
export async function readLegacyPublicSlots<T extends PublicListingProjection>(client: PoolClient, listings: T[]): Promise<Map<T, Array<{ position: number; path: string }>>> {
  const wanted = listings.filter(item => item.source === "LEGACY_READ_ONLY" && item.media.length === 0);
  const nativeReferences = await readNativeReferences(client, listings);
  const slots = new Map<T, Array<{ position: number; path: string }>>();
  if (!wanted.length && !nativeReferences.size) return slots;
  const rows = wanted.length ? (await client.query<{ accountId: string; observationVersionId: string; displayPaths: string[] }>(
    `SELECT p.account_id AS "accountId",p.observation_version_id AS "observationVersionId",p.display_paths AS "displayPaths"
       FROM zzsh_supply.legacy_account_media_paths p
       JOIN zzsh_supply.rental_account a ON a.id=p.account_id
       JOIN zzsh_supply.legacy_supply_map m ON m.account_id=p.account_id AND m.version_id=p.observation_version_id AND m.source_digest=p.source_digest
         AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
      WHERE p.account_id=ANY($1::text[])`, [wanted.map(item => item.id)],
  )).rows : [];
  const allPaths = [...new Set(rows.flatMap(row => Array.isArray(row.displayPaths) ? row.displayPaths.filter(isLegacyImagePath) : []))];
  const blocked = allPaths.length ? new Set((await client.query<{ path: string }>(
    `SELECT candidate.path FROM unnest($1::text[]) AS candidate(path)
      WHERE EXISTS (SELECT 1 FROM zzsh_supply.legacy_account_media_paths private_media WHERE private_media.penalty_paths @> ARRAY[candidate.path]::text[])`, [allPaths],
  )).rows.map(row => row.path)) : new Set<string>();
  const images = new Map(rows.map(row => [row.accountId, row]));
  for (const item of listings) {
    if (typeof item.id === "string" && typeof item.versionId === "string") {
      const reference = nativeReferences.get(key(item.id, item.versionId));
      if (reference) { slots.set(item, reference.slots); continue; }
    }
    const image = typeof item.id === "string" ? images.get(item.id) : undefined, paths = image?.displayPaths;
    if (!paths || !Array.isArray(paths) || paths.some(path => !isLegacyImagePath(path)) || !wanted.includes(item) || item.versionId !== image.observationVersionId) continue;
    slots.set(item, paths.flatMap((path, position) => blocked.has(path) ? [] : [{ position, path }]));
  }
  return slots;
}

/** Apply both image sources to a page whose listings passed the public visibility checks. */
export async function projectPublicListingImages(client: PoolClient, listings: PublicListingProjection[], cdn?: AccountImageCdn): Promise<PublicListingProjection[]> {
  const slots = await readLegacyPublicSlots(client, listings);
  const serving = cdn?.mode === "serve" ? cdn : undefined;
  const legacy = serving?.legacy?.enabled ? serving.legacy : undefined;
  const nativeAccounts = serving ? [...new Set(listings.filter(item => item.media.length).map(item => item.id))] : [];
  const legacyAccounts = legacy ? [...new Set(listings.filter(item => slots.get(item)?.length || item.legacyImages?.length).map(item => item.id))] : [];
  const deliveries = nativeAccounts.length ? (await client.query<AccountImageDelivery>(
    `SELECT id, account_id AS "accountId", asset_id AS "assetId" FROM zzsh_supply.account_image_cdn_delivery
      WHERE account_id=ANY($1::text[]) AND state='READY'`, [nativeAccounts],
  )).rows : [];
  type LegacyStatus = LegacyImageCdnDelivery & Pick<LegacyImageProof, "sha256" | "byteSize" | "mime"> & { state: "READY" | "PENDING_IMPORT" | "UNAVAILABLE" };
  const legacyDeliveries = legacyAccounts.length ? (await client.query<LegacyStatus>(
    `SELECT id, account_id AS "accountId", version_id AS "versionId", position, source_path AS "sourcePath", state, sha256, byte_size AS "byteSize", mime
       FROM zzsh_supply.legacy_image_cdn_delivery WHERE account_id=ANY($1::text[]) AND state IN ('READY','PENDING_IMPORT','UNAVAILABLE')`, [legacyAccounts],
  )).rows : [];
  const legacySlots = new Map(legacyDeliveries.filter(row => {
    const proof = legacy?.proof(row.sourcePath);
    return proof?.sha256 === row.sha256 && proof.byteSize === row.byteSize && proof.mime === row.mime;
  }).map(row => [JSON.stringify([row.accountId, row.versionId, row.position]), row]));
  const ready = new Map(deliveries.map(row => [key(row.accountId, row.assetId), row]));

  return listings.map(listing => {
    const authorized = slots.get(listing);
    const legacyImages = authorized?.map(({ position }) => ({ position, url: `/api/v1/supply/listings/${listing.id}/legacy-images/${position}` })) ?? listing.legacyImages;
    if (!legacyImages && !ready.size) return listing;
    return {
      ...listing,
      media: serving && ready.size ? listing.media.map(image => {
        const delivery = ready.get(key(listing.id, image.assetId));
        return delivery ? { ...image, coverUrl: serving.url(delivery, 640), detailUrl: serving.url(delivery, 1920) } : image;
      }) : listing.media,
      ...(legacyImages ? { legacyImages: legacyImages.map(image => {
        const delivery = legacySlots.get(JSON.stringify([listing.id, listing.versionId, image.position]));
        if (!legacy || !delivery || (authorized && !authorized.some(slot => slot.position === image.position && slot.path === delivery.sourcePath))) return image;
        return delivery.state === "READY" ? { ...image, cdnUrl: legacy.url(delivery) } : { ...image, state: delivery.state };
      }) } : {}),
    };
  });
}

/** Invoke only after the caller has checked the administrator's account permission and game scope. */
export async function readLegacyPathCounts(client: PoolClient, accountId: string, observationVersionId: string): Promise<{ displayCount: number; penaltyCount: number } | null> {
  return (await client.query<{ displayCount: number; penaltyCount: number }>(
    `SELECT cardinality(p.display_paths)::int AS "displayCount",cardinality(p.penalty_paths)::int AS "penaltyCount"
       FROM zzsh_supply.legacy_account_media_paths p JOIN zzsh_supply.legacy_supply_map m
         ON m.account_id=p.account_id AND m.version_id=p.observation_version_id AND m.source_digest=p.source_digest
        AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
      WHERE p.account_id=$1 AND p.observation_version_id=$2`, [accountId, observationVersionId],
  )).rows[0] ?? null;
}
