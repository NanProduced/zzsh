import type { PoolClient } from 'pg';
import { updateSettings, checkUpdatePublication, updateVisibility, type UpdateSettings, type PublicUpdate, type UpdatesPage, type UpdateSurface } from '@zzsh/content/updates';
import { inspectContentMarkdown } from '@zzsh/content/api-markdown';
import { conflict, invalid } from '../supply/supply-util';
import { ADMIN_PERMISSION, requirePermission, type EffectiveAdminAccess } from '../auth/admin-authorization';

export function checkedUpdateSettings(value: unknown): UpdateSettings {
  try { return updateSettings(value); } catch (error) { throw invalid(error instanceof Error ? error.message : 'Update settings are invalid'); }
}
export function requireUpdatePromotionPermission(access: EffectiveAdminAccess, value: unknown): void {
  if (checkedUpdateSettings(value).tickerEnabled) requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
}
export async function prepareUpdateSettings(body: string, value: unknown): Promise<UpdateSettings> {
  const settings = checkedUpdateSettings(value);
  return { ...settings, mediaIds: settings.format === 'markdown' ? (await inspectContentMarkdown(body)).mediaIds : [] };
}
const alive = `(v."update_settings"->>'validUntil' IS NULL OR (v."update_settings"->>'validUntil')::timestamptz > $1::timestamptz)`;
const pin = `(i."type" = 'ANNOUNCEMENT' AND ${alive} AND COALESCE((v."update_settings"->>'pinned')::boolean, false) AND (v."update_settings"->>'pinnedUntil')::timestamptz > $1::timestamptz)`;
export async function checkUpdateRelease(client: PoolClient, item: { id: string; type: string }, value: unknown): Promise<void> {
  let settings: UpdateSettings;
  try { settings = checkUpdatePublication(item.type, value); } catch (error) { throw invalid(error instanceof Error ? error.message : 'Update publication settings are invalid'); }
  if (!updateVisibility(settings).pinned) return;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('content-updates-pin', 0))`);
  const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_content"."content_item" i JOIN "zzsh_content"."content_version" v ON v."item_id"=i."id" AND v."state"='PUBLISHED' WHERE ${pin} AND i."id" <> $2`, [new Date().toISOString(), item.id]);
  if (Number(count.rows[0]!.count) >= 3) throw conflict('最多同时置顶3条有效公告，请先取消其他公告置顶或等待过期');
}
type UpdateRow = { id: string; versionId: string; type: 'ANNOUNCEMENT' | 'NEWS'; title: string; summary: string; body?: string; publishedAt: Date; gameName: string | null; coverMediaId: string | null; settings: unknown };
const from = `FROM "zzsh_content"."content_item" i JOIN "zzsh_content"."content_version" v ON v."item_id"=i."id" AND v."state"='PUBLISHED' LEFT JOIN "zzsh_supply"."game" g ON g."id"=i."game_id" LEFT JOIN "zzsh_supply"."media_asset" m ON m."id"=v."cover_media_id" AND m."purpose"='CONTENT_MEDIA' AND m."ownership_kind"='PLATFORM_CONTENT' AND m."review_state"='APPROVED' AND m."access_class"='PUBLIC_DISPLAY' AND m."public_storage_key" IS NOT NULL`;
const fields = `i."id", i."type", v."id" AS "versionId", v."title", v."summary", v."published_at" AS "publishedAt", g."name" AS "gameName", m."id" AS "coverMediaId", v."update_settings" AS settings`;
async function dto(client: PoolClient, row: UpdateRow, now: number): Promise<PublicUpdate> {
  const settings = checkedUpdateSettings(row.settings), visibility = updateVisibility(settings, now), mediaUrls: Record<string, string | null> = {};
  if (row.body !== undefined && settings.mediaIds.length) {
    const qualified = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_supply"."media_asset" WHERE "id"=ANY($1::text[]) AND "purpose"='CONTENT_MEDIA' AND "ownership_kind"='PLATFORM_CONTENT' AND "review_state"='APPROVED' AND "access_class"='PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL`, [settings.mediaIds]);
    const available = new Set(qualified.rows.map(x => x.id));
    for (const id of settings.mediaIds) mediaUrls[id] = available.has(id) ? `/api/v1/content/media/${encodeURIComponent(id)}/content` : null;
  }
  return { ...row, publishedAt: row.publishedAt.toISOString(), settings, expired: visibility.expired, pinned: visibility.pinned, mediaUrls };
}
export async function listPublicUpdates(client: PoolClient, input: { type?: string; page: number; limit: number; surface?: 'home' | UpdateSurface; gameId?: string }): Promise<UpdatesPage> {
  const now = new Date(), params: unknown[] = [now.toISOString()], where = [`i."type" IN ('ANNOUNCEMENT','NEWS')`];
  if (input.type) { params.push(input.type); where.push(`i."type"=$${params.length}`); }
  if (input.surface === 'home') where.push(`${alive} AND COALESCE((v."update_settings"->>'tickerEnabled')::boolean,false) AND (v."update_settings"->>'tickerUntil')::timestamptz > $1::timestamptz AND (v."update_settings"->>'tickerFrom' IS NULL OR (v."update_settings"->>'tickerFrom')::timestamptz <= $1::timestamptz)`);
  else if (input.surface) {
    params.push(input.surface); where.push(`${alive} AND i."type"='ANNOUNCEMENT' AND v."update_settings"->'surfaces' @> jsonb_build_array($${params.length}::text)`);
    if (input.gameId) { params.push(input.gameId); where.push(`(i."game_id" IS NULL OR i."game_id"=$${params.length})`); }
    else where.push(`i."game_id" IS NULL`);
  }
  const count = await client.query<{ total: string }>(`SELECT count(*)::text AS total ${from} WHERE ${where.join(' AND ')} AND $1::timestamptz IS NOT NULL`, params);
  params.push(input.limit, (input.page - 1) * input.limit);
  const rows = await client.query<UpdateRow>(`SELECT ${fields} ${from} WHERE ${where.join(' AND ')} ORDER BY ${input.surface ? '' : `${pin} DESC NULLS LAST, `} v."published_at" DESC, i."id" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = Number(count.rows[0]!.total);
  return { items: await Promise.all(rows.rows.map(row => dto(client, row, now.getTime()))), page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit), asOf: now.toISOString() };
}
export async function readPublicUpdate(client: PoolClient, id: string): Promise<PublicUpdate | null> {
  const rows = await client.query<UpdateRow>(`SELECT ${fields}, v."body" ${from} WHERE i."id"=$1 AND i."type" IN ('ANNOUNCEMENT','NEWS')`, [id]);
  return rows.rows[0] ? dto(client, rows.rows[0], Date.now()) : null;
}
