import type { PoolClient } from "pg";
import { DEFAULT_RESOURCES, resourceMediaIds, validateResource, validateResourceKey, validateResourceMedia, type ContentResource } from "@zzsh/content";

import { conflict, ensureOnlyFields, invalid } from "../supply/supply-util";

export async function requireContentMedia(client: PoolClient, mediaId: string): Promise<void> {
  const row = await client.query(`SELECT 1 FROM "zzsh_supply"."media_asset" WHERE "id" = $1 AND "purpose" = 'CONTENT_MEDIA'`, [mediaId]);
  if (row.rows.length === 0) throw invalid("Cover media must be an existing content media asset");
}

export async function requirePublicContentMedia(client: PoolClient, mediaId: string, label: string): Promise<void> {
  const row = await client.query(
    `SELECT 1 FROM "zzsh_supply"."media_asset"
      WHERE "id" = $1 AND "purpose" = 'CONTENT_MEDIA' AND "review_state" = 'APPROVED'
        AND "access_class" = 'PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL`,
    [mediaId],
  );
  if (row.rows.length === 0) throw conflict(`${label} must be approved and publicly displayable`);
}

export function checkedResource(key: string, value: unknown): ContentResource {
  try {
    validateResourceKey(key);
    return validateResource(key, value);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "Content resource is invalid");
  }
}

export function isMediaResource(payload: ContentResource): boolean {
  return payload.kind === "contact" || payload.kind === "banner" || payload.kind === "carousel";
}

export function fixedCarouselDraft(source: ContentResource): ContentResource {
  const template = DEFAULT_RESOURCES["placement:HOME_HERO"];
  if (source.kind !== "carousel" || template?.kind !== "carousel") throw invalid("Carousel template is unavailable");
  return checkedResource("placement:HOME_HERO", {
    ...template,
    slides: template.slides.map(slot => {
      const previous = source.slides.find(slide => slide.id === slot.id);
      return { ...slot, mediaId: previous?.mediaId ?? null, mobileMediaId: previous?.mobileMediaId ?? null };
    }),
  });
}

/** guide / notice 正文为 plate；mediaIds 由共享校验从 document 重算，不信任调用方清单。 */
export async function prepareResourceDraft(key: string, value: unknown): Promise<ContentResource> {
  return checkedResource(key, value);
}

/** Fixed-page resources keep their original metadata; this boundary accepts images only. */
export function replaceResourceMedia(key: string, payload: ContentResource, input: unknown): ContentResource {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Media fields are required");
  const media = input as Record<string, unknown>;
  if (payload.kind === "contact") {
    ensureOnlyFields(media, ["qrMediaId"]);
    if (!("qrMediaId" in media)) throw invalid("qrMediaId is required");
    return checkedResource(key, { ...payload, qrMediaId: media.qrMediaId });
  }
  if (payload.kind === "banner") {
    ensureOnlyFields(media, ["mediaId", "mobileMediaId"]);
    if (!("mediaId" in media) || !("mobileMediaId" in media)) throw invalid("Both image references are required");
    return checkedResource(key, { ...payload, mediaId: media.mediaId, mobileMediaId: media.mobileMediaId });
  }
  if (payload.kind === "carousel") {
    const template = DEFAULT_RESOURCES["placement:HOME_HERO"];
    if (template?.kind !== "carousel" || JSON.stringify(payload.slides.map(slide => slide.id)) !== JSON.stringify(template.slides.map(slide => slide.id))) {
      throw conflict("Legacy carousel positions are not automatically mapped; explicitly restore a version to create the fixed-position draft first");
    }
    ensureOnlyFields(media, ["slides"]);
    if (!Array.isArray(media.slides) || media.slides.length !== payload.slides.length) throw invalid("Existing carousel positions cannot be added or removed");
    const inputSlides = media.slides;
    const slides = payload.slides.map((slide, index) => {
      const entry = inputSlides[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Carousel image fields are invalid");
      const fields = entry as Record<string, unknown>;
      ensureOnlyFields(fields, ["id", "mediaId", "mobileMediaId"]);
      if (fields.id !== slide.id || !("mediaId" in fields) || !("mobileMediaId" in fields)) throw invalid("Carousel positions and order cannot change");
      return { ...slide, mediaId: fields.mediaId, mobileMediaId: fields.mobileMediaId };
    });
    return checkedResource(key, { ...payload, slides });
  }
  throw invalid("Only fixed image resources accept media replacement");
}

export async function requireResourceMedia(client: PoolClient, payload: ContentResource, publishing: boolean, resourceKey?: string): Promise<void> {
  const ids = resourceMediaIds(payload);
  const isArticle = payload.kind === "guide" || payload.kind === "notice";
  // Unchecked draft text is inert and must be recoverable, including unresolved image references.
  if (isArticle && !publishing) return;
  if (!ids.length) return;
  const result = await client.query<{ id: string; reviewState: string; accessClass: string; publicStorageKey: string | null; width: number; height: number }>(
    `SELECT "id", "width", "height", "review_state" AS "reviewState", "access_class" AS "accessClass", "public_storage_key" AS "publicStorageKey"
       FROM "zzsh_supply"."media_asset" WHERE "id" = ANY($1::text[])
        AND "purpose" = 'CONTENT_MEDIA' AND "ownership_kind" = 'PLATFORM_CONTENT'${publishing ? " FOR SHARE" : ""}`,
    [ids],
  );
  if (result.rows.length !== ids.length) throw invalid("Only platform content media can be referenced");
  if (publishing && result.rows.some(row => row.reviewState !== "APPROVED" || row.accessClass !== "PUBLIC_DISPLAY" || !row.publicStorageKey)) {
    throw conflict("Every referenced media asset must be approved and publicly displayable");
  }
  if (publishing) { try { validateResourceMedia(payload, result.rows); } catch (error) { throw invalid(error instanceof Error ? error.message : "Resource image dimensions are invalid"); } }
}
