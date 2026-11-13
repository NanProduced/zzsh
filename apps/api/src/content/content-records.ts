import type { PoolClient } from "pg";
import type { ContentResource } from "@zzsh/content";
import { projectLegacyResource } from "@zzsh/content/legacy-plate";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import type { UpdateSettings } from "@zzsh/content/updates";
import { projectStoredUpdate } from "./updates";

export type ContentItemRow = {
  id: string;
  type: string;
  resourceKey: string | null;
  gameId: string | null;
  gameName: string | null;
  sortOrder: number;
  revision: string;
  createdByAdminId: string | null;
  source?: "SYSTEM_INITIAL" | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentVersionRow = {
  id: string;
  itemId: string;
  sequence: number;
  state: string;
  title: string;
  summary: string;
  body: string;
  payload: ContentResource | PlateDocumentEnvelope | null;
  updateSettings?: UpdateSettings;
  coverMediaId: string | null;
  revision: string;
  publishedAt: Date | null;
  publishedByAdminId: string | null;
  source?: "SYSTEM_INITIAL" | null;
  createdAt: Date;
  updatedAt: Date;
};

export const ITEM_FIELDS = `i."id", i."type", i."resource_key" AS "resourceKey", i."game_id" AS "gameId", g."name" AS "gameName", i."sort_order" AS "sortOrder",
  i."revision"::text AS "revision", CASE WHEN to_jsonb(i)->>'system_initial_sha256' IS NULL THEN i."created_by_admin_id" END AS "createdByAdminId",
  CASE WHEN to_jsonb(i)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS source, i."created_at" AS "createdAt", i."updated_at" AS "updatedAt"`;

export const VERSION_FIELDS = `v."id", v."item_id" AS "itemId", v."sequence", v."state", v."title", v."summary", v."body", v."payload", CASE WHEN v."update_settings"->'homePopup' = 'false'::jsonb THEN v."update_settings" - 'homePopup' ELSE v."update_settings" END AS "updateSettings",
  v."cover_media_id" AS "coverMediaId", v."revision"::text AS "revision", v."published_at" AS "publishedAt",
  CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NULL THEN v."published_by_admin_id" END AS "publishedByAdminId",
  CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS source, v."created_at" AS "createdAt", v."updated_at" AS "updatedAt"`;

export async function loadContentItem(client: PoolClient, itemId: string, forUpdate = false): Promise<ContentItemRow | null> {
  const result = await client.query<ContentItemRow>(
    `SELECT ${ITEM_FIELDS} FROM "zzsh_content"."content_item" i
       LEFT JOIN "zzsh_supply"."game" g ON g."id" = i."game_id"
      WHERE i."id" = $1${forUpdate ? " FOR UPDATE OF i" : ""}`,
    [itemId],
  );
  return result.rows[0] ?? null;
}

export async function loadContentVersions(client: PoolClient, itemId: string, activePayloadsOnly = false): Promise<ContentVersionRow[]> {
  return (
    await client.query<ContentVersionRow>(
      `SELECT ${activePayloadsOnly ? VERSION_FIELDS.replace('v."payload"', `CASE WHEN v."state" IN ('DRAFT', 'PUBLISHED') THEN v."payload" ELSE NULL END AS "payload"`) : VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."item_id" = $1 ORDER BY v."sequence" DESC, v."id" DESC`,
      [itemId],
    )
  ).rows;
}

export async function loadContentVersion(client: PoolClient, versionId: string, forUpdate = false): Promise<ContentVersionRow | null> {
  const result = await client.query<ContentVersionRow>(
    `SELECT ${VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."id" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

/** Project persisted pre-Plate versions. Request payloads still use the strict Plate validators. */
export function projectStoredVersion(version: ContentVersionRow): ContentVersionRow {
  const payload = projectLegacyResource(version.payload);
  if (payload) return { ...version, payload };
  if (!version.payload && (version.updateSettings as { format?: string } | undefined)?.format !== "plate"
    && (version.body || Object.keys(version.updateSettings ?? {}).length > 0)) {
    const projected = projectStoredUpdate(version.body, version.updateSettings);
    return { ...version, payload: projected.document ?? null, updateSettings: projected.settings };
  }
  return version;
}
