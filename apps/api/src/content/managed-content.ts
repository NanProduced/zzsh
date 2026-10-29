import type { PoolClient } from "pg";
import { DEFAULT_RESOURCES, RESOURCE_DEFINITIONS, RESOURCE_SCHEMA, resourceMediaIds, type ContentResource, type PublicContentResource, type CarouselResource } from "@zzsh/content";
import { checkedResource, fixedCarouselDraft, listAdminCarousel, loadContentItem, loadContentVersions, type ContentItemRow, type ContentVersionRow } from "./content";
import { conflict, notFound } from "../supply/supply-util";

export type ResourceScope = { scope: "platform" | "game"; gameId?: string };
export type ResourceDetail = {
  key: string;
  definition: (typeof RESOURCE_DEFINITIONS)[number] | null;
  item: ContentItemRow | null;
  draft: ContentVersionRow | null;
  published: ContentVersionRow | null;
  versions: ContentVersionRow[];
  current: PublicContentResource;
  baseline: ContentResource | null;
};

export async function loadResourceItem(client: PoolClient, key: string, forUpdate = false): Promise<ContentItemRow | null> {
  const result = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_content"."content_item" WHERE "type" = 'RESOURCE' AND "resource_key" = $1`, [key]);
  return result.rows[0] ? loadContentItem(client, result.rows[0].id, forUpdate) : null;
}

export async function lockManagedResource(client: PoolClient, key: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`content-resource:${key}`]);
}

export async function builtinResource(client: PoolClient, key: string, includeLegacy = false): Promise<ContentResource | null> {
  const value = DEFAULT_RESOURCES[key];
  if (!value) return null;
  if (key !== "placement:HOME_HERO" || !includeLegacy) return checkedResource(key, value);
  const rows = (await listAdminCarousel(client, "HOME_HERO", 100, null)).items;
  if (rows.length > 30) throw conflict("Existing carousel has more than 30 entries; reconcile before adopting it");
  return fixedCarouselDraft(checkedResource(key, {
    kind: "carousel", title: "首页轮播", slides: rows.map(row => ({
      id: row.id, mediaId: row.mediaId, mobileMediaId: null, imageAlt: row.imageAlt, mobileImageAlt: "",
      title: row.title, description: row.description, linkUrl: row.linkUrl, enabled: row.enabled, sortOrder: row.sortOrder,
      startsAt: row.startsAt ? new Date(row.startsAt).toISOString() : null, endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
    })),
  }));
}

function publishedSnapshot(version: { id: string; sequence: number; publishedAt: Date | null } | undefined): PublicContentResource["version"] {
  if (!version) return null;
  if (!version.publishedAt) throw conflict("Published content snapshot metadata is missing");
  return { id: version.id, sequence: version.sequence, publishedAt: new Date(version.publishedAt).toISOString() };
}

async function projectResource(client: PoolClient, key: string, item: ContentItemRow | null, versions: ContentVersionRow[]): Promise<PublicContentResource> {
  const published = versions.find(version => version.state === "PUBLISHED");
  const hasPublication = versions.some(version => version.publishedAt !== null);
  const payload = published ? checkedResource(key, published.payload) : hasPublication ? null : await builtinResource(client, key);
  const ids = payload ? resourceMediaIds(payload) : [];
  const eligible = ids.length ? (await client.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_supply"."media_asset" WHERE "id" = ANY($1::text[])
      AND "ownership_kind" = 'PLATFORM_CONTENT' AND "purpose" = 'CONTENT_MEDIA'
      AND "review_state" = 'APPROVED' AND "access_class" = 'PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL`, [ids],
  )).rows : [];
  const available = new Set(eligible.map(row => row.id));
  return {
    schema: RESOURCE_SCHEMA, key, source: published || hasPublication || (item && !payload) ? "MANAGED" : key === "placement:HOME_HERO" ? "LEGACY" : "BUILTIN",
    state: payload ? "available" : hasPublication ? "withdrawn" : "unpublished", payload, version: publishedSnapshot(published),
    media: ids.map(id => ({ id, url: available.has(id) ? `/api/v1/content/media/${encodeURIComponent(id)}/content` : null })),
  };
}

export async function readResourceDetail(client: PoolClient, key: string): Promise<ResourceDetail> {
  const item = await loadResourceItem(client, key);
  if (!item && !DEFAULT_RESOURCES[key]) throw notFound();
  const versions = item ? await loadContentVersions(client, item.id, true) : [];
  return {
    key, definition: RESOURCE_DEFINITIONS.find(value => value.key === key) ?? null, item,
    draft: versions.find(version => version.state === "DRAFT") ?? null,
    published: versions.find(version => version.state === "PUBLISHED") ?? null,
    versions: versions.slice(0, 20).map(version => ({ ...version, body: "", payload: null })),
    current: await projectResource(client, key, item, versions), baseline: !item ? await builtinResource(client, key, true) : null,
  };
}

export async function readPublicResource(client: PoolClient, key: string): Promise<PublicContentResource> {
  const item = await loadResourceItem(client, key);
  if (!item && !DEFAULT_RESOURCES[key]) throw notFound();
  const result = await projectResource(client, key, item, item ? await loadContentVersions(client, item.id, true) : []);
  if (result.state === "unpublished") throw notFound();
  return result;
}

export async function listResourceKeys(client: PoolClient, input: { scope?: ResourceScope; kind?: "guide" | "placement"; after?: string; limit: number }): Promise<{ keys: string[]; nextCursor: string | null }> {
  const defaults = input.scope?.scope === "game" ? [] : Object.keys(DEFAULT_RESOURCES);
  const gameId = input.scope?.scope === "game" ? input.scope.gameId : null;
  const rows = await client.query<{ key: string }>(
    `SELECT key FROM (
      SELECT unnest($1::text[]) AS key
      UNION SELECT i."resource_key" AS key FROM "zzsh_content"."content_item" i
        WHERE i."type" = 'RESOURCE' AND ($2::boolean OR i."game_id" IS NOT DISTINCT FROM $3::text)
          AND ($7::boolean OR EXISTS (SELECT 1 FROM "zzsh_content"."content_version" v WHERE v."item_id" = i."id" AND v."published_at" IS NOT NULL))
    ) resources WHERE ($4::text IS NULL OR key LIKE $4) AND key > $5 ORDER BY key LIMIT $6`,
    [defaults, input.scope === undefined, gameId, input.kind ? `${input.kind}:%` : null, input.after ?? "", input.limit + 1, input.scope !== undefined],
  );
  const more = rows.rows.length > input.limit;
  const keys = rows.rows.slice(0, input.limit).map(row => row.key);
  return { keys, nextCursor: more ? keys[keys.length - 1]! : null };
}

// One version query for the page keeps the public help index independent of its number of articles.
export async function listPublicResources(client: PoolClient, input: { scope?: ResourceScope; kind?: "guide" | "placement"; after?: string; limit: number }): Promise<{ items: PublicContentResource[]; nextCursor: string | null }> {
  const page = await listResourceKeys(client, input);
  if (!page.keys.length) return { items: [], nextCursor: null };
  const rows = await client.query<{
    key: string; itemId: string; itemRevision: string; gameId: string | null; id: string; sequence: number; state: string; publishedAt: Date | null; payload: ContentResource | null;
  }>(
    `SELECT i."resource_key" AS key, i."id" AS "itemId", i."revision"::text AS "itemRevision", i."game_id" AS "gameId",
        v."id", v."sequence", v."state", v."published_at" AS "publishedAt", CASE WHEN v."state" = 'PUBLISHED' THEN v."payload" ELSE NULL END AS "payload"
       FROM "zzsh_content"."content_item" i JOIN "zzsh_content"."content_version" v ON v."item_id" = i."id"
      WHERE i."type" = 'RESOURCE' AND i."resource_key" = ANY($1::text[]) ORDER BY v."sequence" DESC`, [page.keys],
  );
  const items: PublicContentResource[] = [];
  const payloads: Array<{ key: string; payload: ContentResource | null; managed: boolean; withdrawn: boolean; version: PublicContentResource["version"] }> = [];
  for (const key of page.keys) {
    const versions = rows.rows.filter(row => row.key === key);
    const published = versions.find(row => row.state === "PUBLISHED");
    const hasPublication = versions.some(row => row.publishedAt !== null);
    const payload = published ? checkedResource(key, published.payload) : hasPublication ? null : await builtinResource(client, key);
    payloads.push({ key, payload, managed: Boolean(published || hasPublication || (versions.length && !payload)), withdrawn: hasPublication, version: publishedSnapshot(published) });
  }
  const allIds = [...new Set(payloads.flatMap(row => row.payload ? resourceMediaIds(row.payload) : []))];
  const media = allIds.length ? (await client.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_supply"."media_asset" WHERE "id" = ANY($1::text[]) AND "purpose" = 'CONTENT_MEDIA'
      AND "ownership_kind" = 'PLATFORM_CONTENT' AND "review_state" = 'APPROVED' AND "access_class" = 'PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL`, [allIds],
  )).rows : [];
  const available = new Set(media.map(row => row.id));
  for (const row of payloads) items.push({
    schema: RESOURCE_SCHEMA, key: row.key, source: row.managed ? "MANAGED" : row.key === "placement:HOME_HERO" ? "LEGACY" : "BUILTIN",
    state: row.payload ? "available" : row.withdrawn ? "withdrawn" : "unpublished", payload: row.payload, version: row.version,
    media: row.payload ? resourceMediaIds(row.payload).map(id => ({ id, url: available.has(id) ? `/api/v1/content/media/${encodeURIComponent(id)}/content` : null })) : [],
  });
  return { items, nextCursor: page.nextCursor };
}

export async function managedCarousel(client: PoolClient): Promise<{ managed: boolean; items: Record<string, unknown>[] }> {
  const item = await loadResourceItem(client, "placement:HOME_HERO");
  if (!item) return { managed: false, items: [] };
  const versions = await loadContentVersions(client, item.id, true);
  if (!versions.some(version => version.publishedAt !== null)) return { managed: false, items: [] };
  const value = await projectResource(client, "placement:HOME_HERO", item, versions);
  if (!value.payload) return { managed: true, items: [] };
  const payload = value.payload as CarouselResource;
  const media = new Map(value.media.map(entry => [entry.id, entry.url]));
  const time = (await client.query<{ now: Date }>(`SELECT clock_timestamp() AS now`)).rows[0]?.now;
  if (!time) throw conflict("Carousel time is unavailable");
  const now = new Date(time).getTime();
  return { managed: true, items: payload.slides.filter(slide => slide.enabled && slide.mediaId && media.get(slide.mediaId)
    && (!slide.startsAt || Date.parse(slide.startsAt) <= now) && (!slide.endsAt || now < Date.parse(slide.endsAt)))
    .sort((a, b) => b.sortOrder - a.sortOrder || a.id.localeCompare(b.id)).map(slide => ({
      id: slide.id, slotCode: "HOME_HERO", title: slide.title, description: slide.description, imageAlt: slide.imageAlt,
      linkUrl: slide.linkUrl, sortOrder: slide.sortOrder, startsAt: slide.startsAt, endsAt: slide.endsAt,
      mediaUrl: slide.mediaId ? media.get(slide.mediaId) : null, mobileMediaUrl: slide.mobileMediaId ? media.get(slide.mobileMediaId) ?? null : null,
      mobileImageAlt: slide.mobileImageAlt || slide.imageAlt,
    })) };
}
