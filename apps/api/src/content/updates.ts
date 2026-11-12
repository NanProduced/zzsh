import type { PoolClient } from 'pg';
import { projectLegacyUpdate } from '@zzsh/content/legacy-plate';
import { updateSettings, checkUpdatePublication, updateVisibility, type UpdateSettings, type PublicUpdate, type UpdatesPage, type UpdateSurface } from '@zzsh/content/updates';
import { extractPlate, validatePlateDocument, type PlateDocumentEnvelope } from '@zzsh/content/plate';
import { conflict, invalid } from '../supply/supply-util';
import { ADMIN_PERMISSION, requirePermission, type EffectiveAdminAccess } from '../auth/admin-authorization';

export function checkedUpdateSettings(value: unknown): UpdateSettings {
  try { return updateSettings(value); } catch (error) { throw invalid(error instanceof Error ? error.message : 'Update settings are invalid'); }
}
export function requireUpdatePromotionPermission(access: EffectiveAdminAccess, value: unknown): void {
  const settings = checkedUpdateSettings(value);
  if (settings.tickerEnabled || settings.homePopup) requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
}
/** 公告/资讯正文唯一格式：plate（update 预设）。草稿可保存未核验文本，发布再核占位词。 */
export function checkedUpdateDocument(value: unknown, mode: 'draft' | 'publish' = 'draft'): PlateDocumentEnvelope {
  const checked = validatePlateDocument(value, { preset: 'update', mode });
  if (!checked.ok) {
    throw invalid(`正文未通过校验：${checked.errors.slice(0, 5).map(error => `${error.path} ${error.code}`).join('；')}`);
  }
  return value as PlateDocumentEnvelope;
}
/** body 列存纯文本投影（≤20000 字节）供列表摘要；mediaIds 从 document 重算。 */
export function updateProjection(document: PlateDocumentEnvelope): { body: string; mediaIds: string[] } {
  const extracted = extractPlate(document);
  return { body: extracted.plainText, mediaIds: extracted.mediaIds.sort() };
}
/** 离线 seed 工具以纯文本提供正文时，按段落 shaping 成 plate update 文档；存储始终为 plate。 */
export function updateDocumentFromBody(body: string): PlateDocumentEnvelope {
  const value = body.split(/\n+/).map(line => line.trim()).filter(Boolean).map(text => ({ type: "p", children: [{ text }] }));
  return { format: "plate", schemaVersion: 1, preset: "update", value: value.length ? value : [{ type: "p", children: [{ text: "" }] }] };
}
export function prepareUpdateSettings(value: unknown, mediaIds: readonly string[]): Omit<UpdateSettings, 'homePopup'> & { homePopup?: boolean } {
  const { homePopup, ...settings } = checkedUpdateSettings(value);
  return { ...settings, ...(homePopup ? { homePopup: true } : {}), mediaIds: [...mediaIds].sort() };
}
export function projectStoredUpdate(body: string | undefined, value: unknown, document?: PlateDocumentEnvelope | null) {
  const stored = value && typeof value === "object" ? value as { format?: string } : {};
  const settings = checkedUpdateSettings({ ...stored, format: "plate" });
  const projected = document ?? (body !== undefined ? projectLegacyUpdate(body, stored.format) : undefined);
  return { document: projected, settings: projected ? { ...settings, mediaIds: updateProjection(projected).mediaIds } : settings };
}

const alive = `(v."update_settings"->>'validUntil' IS NULL OR (v."update_settings"->>'validUntil')::timestamptz > $1::timestamptz)`;
// visibleFrom 之前整条动态不可见；未来时间即定时，不引入任务队列。
const visible = `(v."update_settings"->>'visibleFrom' IS NULL OR (v."update_settings"->>'visibleFrom')::timestamptz <= $1::timestamptz)`;
const pin = `(i."type" = 'ANNOUNCEMENT' AND ${alive} AND ${visible} AND COALESCE((v."update_settings"->>'pinned')::boolean, false) AND (v."update_settings"->>'pinnedUntil')::timestamptz > $1::timestamptz)`;
export async function checkUpdateRelease(client: PoolClient, item: { id: string; type: string; gameId?: string | null }, value: unknown): Promise<void> {
  let settings: UpdateSettings;
  try { settings = checkUpdatePublication(item.type, value); } catch (error) { throw invalid(error instanceof Error ? error.message : 'Update publication settings are invalid'); }
  if (settings.homePopup && item.gameId !== null) throw invalid('只有平台公告可启用首页弹窗');
  if (!updateVisibility(settings).pinned) return;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('content-updates-pin', 0))`);
  const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_content"."content_item" i JOIN "zzsh_content"."content_version" v ON v."item_id"=i."id" AND v."state"='PUBLISHED' WHERE ${pin} AND i."id" <> $2`, [new Date().toISOString(), item.id]);
  if (Number(count.rows[0]!.count) >= 3) throw conflict('最多同时置顶3条有效公告，请先取消其他公告置顶或等待过期');
}
type UpdateRow = { id: string; versionId: string; type: 'ANNOUNCEMENT' | 'NEWS'; title: string; summary: string; body?: string; document?: PlateDocumentEnvelope | null; publishedAt: Date; gameName: string | null; coverMediaId: string | null; settings: unknown };
const from = `FROM "zzsh_content"."content_item" i JOIN "zzsh_content"."content_version" v ON v."item_id"=i."id" AND v."state"='PUBLISHED' LEFT JOIN "zzsh_supply"."game" g ON g."id"=i."game_id" LEFT JOIN "zzsh_supply"."media_asset" m ON m."id"=v."cover_media_id" AND m."purpose"='CONTENT_MEDIA' AND m."ownership_kind"='PLATFORM_CONTENT' AND m."review_state"='APPROVED' AND m."access_class"='PUBLIC_DISPLAY' AND m."public_storage_key" IS NOT NULL`;
const fields = `i."id", i."type", v."id" AS "versionId", v."title", v."summary", v."published_at" AS "publishedAt", g."name" AS "gameName", m."id" AS "coverMediaId", v."update_settings" AS settings`;
async function dto(client: PoolClient, row: UpdateRow, now: number, includeHomePopup = false): Promise<PublicUpdate> {
  const { settings, document } = projectStoredUpdate(row.body, row.settings, row.document), visibility = updateVisibility(settings, now), mediaUrls: Record<string, string | null> = {};
  if (row.body !== undefined && settings.mediaIds.length) {
    const qualified = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_supply"."media_asset" WHERE "id"=ANY($1::text[]) AND "purpose"='CONTENT_MEDIA' AND "ownership_kind"='PLATFORM_CONTENT' AND "review_state"='APPROVED' AND "access_class"='PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL`, [settings.mediaIds]);
    const available = new Set(qualified.rows.map(x => x.id));
    for (const id of settings.mediaIds) mediaUrls[id] = available.has(id) ? `/api/v1/content/media/${encodeURIComponent(id)}/content` : null;
  }
  const { homePopup, ...legacySettings } = settings;
  return { ...row, document, publishedAt: row.publishedAt.toISOString(), settings: includeHomePopup ? settings : legacySettings, expired: visibility.expired, pinned: visibility.pinned, mediaUrls };
}
export async function listPublicUpdates(client: PoolClient, input: { type?: string; page: number; limit: number; surface?: 'home' | 'home-popup' | UpdateSurface; gameId?: string }): Promise<UpdatesPage> {
  const now = new Date(), params: unknown[] = [now.toISOString()], where = [`i."type" IN ('ANNOUNCEMENT','NEWS')`, visible];
  if (input.type) { params.push(input.type); where.push(`i."type"=$${params.length}`); }
  if (input.surface === 'home') where.push(`${alive} AND COALESCE((v."update_settings"->>'tickerEnabled')::boolean,false) AND (v."update_settings"->>'tickerUntil')::timestamptz > $1::timestamptz AND (v."update_settings"->>'tickerFrom' IS NULL OR (v."update_settings"->>'tickerFrom')::timestamptz <= $1::timestamptz)`);
  else if (input.surface === 'home-popup') where.push(`${alive} AND i."type"='ANNOUNCEMENT' AND i."game_id" IS NULL AND v."update_settings"->'homePopup' = 'true'::jsonb`);
  else if (input.surface) {
    params.push(input.surface); where.push(`${alive} AND i."type"='ANNOUNCEMENT' AND v."update_settings"->'surfaces' @> jsonb_build_array($${params.length}::text)`);
    if (input.gameId) { params.push(input.gameId); where.push(`(i."game_id" IS NULL OR i."game_id"=$${params.length})`); }
    else where.push(`i."game_id" IS NULL`);
  }
  const count = await client.query<{ total: string }>(`SELECT count(*)::text AS total ${from} WHERE ${where.join(' AND ')} AND $1::timestamptz IS NOT NULL`, params);
  params.push(input.limit, (input.page - 1) * input.limit);
  const rows = await client.query<UpdateRow>(`SELECT ${fields} ${from} WHERE ${where.join(' AND ')} ORDER BY ${input.surface ? '' : `${pin} DESC NULLS LAST, `} v."published_at" DESC, i."id" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = Number(count.rows[0]!.total);
  return { items: await Promise.all(rows.rows.map(row => dto(client, row, now.getTime(), input.surface === 'home-popup'))), page: input.page, limit: input.limit, total, totalPages: Math.ceil(total / input.limit), asOf: now.toISOString() };
}
export async function readPublicUpdate(client: PoolClient, id: string): Promise<PublicUpdate | null> {
  const now = new Date();
  const rows = await client.query<UpdateRow>(`SELECT ${fields}, v."body", v."payload" AS document ${from} WHERE i."id"=$2 AND i."type" IN ('ANNOUNCEMENT','NEWS') AND ${visible}`, [now.toISOString(), id]);
  return rows.rows[0] ? dto(client, rows.rows[0], now.getTime()) : null;
}
