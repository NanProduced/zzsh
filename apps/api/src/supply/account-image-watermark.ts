import type { Pool, PoolClient } from "pg";

import { recordAudit } from "../auth/security-core";
import { conflict, ensureOnlyFields, invalid } from "./supply-util";

export const ACCOUNT_IMAGE_VARIANT_EDGES = [640, 1920] as const;
export type AccountImageEdge = (typeof ACCOUNT_IMAGE_VARIANT_EDGES)[number];
export type AccountImageWatermarkSettings = {
  enabled: boolean;
  logoAssetId: string | null;
  position: "nw" | "ne" | "sw" | "se";
  sizePercent: number;
  opacityPercent: number;
  marginPercent: number;
};
type AccountImageWatermarkPolicy = AccountImageWatermarkSettings & { revision: string };
export type AccountImageWatermark = AccountImageWatermarkPolicy & { logoStorageKey: string | null };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fields = ["enabled", "logoAssetId", "position", "sizePercent", "opacityPercent", "marginPercent"] as const;
function integerField(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid("水印数值超出允许范围", field);
  return value;
}

export function parseAccountWatermarkSettings(body: Record<string, unknown>): AccountImageWatermarkSettings {
  const { enabled, logoAssetId, position } = body;
  if (typeof enabled !== "boolean") throw invalid("请设置是否启用水印", "enabled");
  if (logoAssetId !== null && (typeof logoAssetId !== "string" || !ID.test(logoAssetId))) throw invalid("Logo 素材编号无效", "logoAssetId");
  if (enabled && logoAssetId === null) throw invalid("请选择平台 Logo", "logoAssetId");
  if (position !== "nw" && position !== "ne" && position !== "sw" && position !== "se") throw invalid("水印位置无效", "position");
  return { enabled, logoAssetId, position, sizePercent: integerField(body, "sizePercent", 5, 30),
    opacityPercent: integerField(body, "opacityPercent", 1, 100), marginPercent: integerField(body, "marginPercent", 0, 10) };
}

export function parseAccountWatermarkUpdate(body: Record<string, unknown>): AccountImageWatermarkSettings & { expectedRevision: string } {
  ensureOnlyFields(body, [...fields, "expectedRevision"]);
  if (typeof body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision)) throw invalid("水印规则版本无效", "expectedRevision");
  return { ...parseAccountWatermarkSettings(body), expectedRevision: body.expectedRevision };
}

const WATERMARK_COLUMNS = `revision::text, enabled, logo_asset_id AS "logoAssetId", position,
  size_percent AS "sizePercent", opacity_percent AS "opacityPercent", margin_percent AS "marginPercent"`;

export async function readAccountWatermarkPolicy(client: Pool | PoolClient): Promise<AccountImageWatermarkPolicy> {
  const policy = (await client.query<AccountImageWatermarkPolicy>(
    `SELECT ${WATERMARK_COLUMNS} FROM zzsh_supply.account_image_watermark WHERE singleton`,
  )).rows[0];
  if (!policy) throw conflict("账号图片水印规则未安装");
  return policy;
}

export async function readAccountWatermarkLogo(client: Pool | PoolClient, assetId: string): Promise<string> {
  const logo = (await client.query<{ storageKey: string }>(
    `SELECT public_storage_key AS "storageKey" FROM zzsh_supply.media_asset
      WHERE id=$1 AND purpose='CONTENT_MEDIA' AND ownership_kind='PLATFORM_CONTENT' AND game_id IS NULL
        AND mime='image/png' AND review_state='APPROVED' AND access_class='PUBLIC_DISPLAY' AND technical_state='READY'
        AND public_storage_key ~ '^[a-f0-9]{64}$'`, [assetId],
  )).rows[0];
  if (!logo) throw invalid("Logo 必须是已审核公开的 PNG 平台素材", "logoAssetId");
  return logo.storageKey;
}

export async function resolveAccountImageWatermark(client: Pool | PoolClient, policy: AccountImageWatermarkPolicy): Promise<AccountImageWatermark> {
  const logoStorageKey = policy.enabled && policy.logoAssetId ? await readAccountWatermarkLogo(client, policy.logoAssetId) : null;
  return { ...policy, logoStorageKey };
}

export async function updateAccountWatermarkPolicy(client: PoolClient, actor: { id: string; sessionId: string }, input: ReturnType<typeof parseAccountWatermarkUpdate>, requestId: string) {
  const before = await readAccountWatermarkPolicy(client);
  if (before.revision !== input.expectedRevision) throw conflict("水印规则已更新，请重新读取");
  if (input.logoAssetId && (input.enabled || input.logoAssetId !== before.logoAssetId)) await readAccountWatermarkLogo(client, input.logoAssetId);
  if (fields.every(field => before[field] === input[field])) return before;
  const after = (await client.query<AccountImageWatermarkPolicy>(
    `UPDATE zzsh_supply.account_image_watermark SET revision=revision+1, enabled=$2, logo_asset_id=$3, position=$4,
       size_percent=$5, opacity_percent=$6, margin_percent=$7, updated_by_admin_id=$8, updated_at=clock_timestamp()
     WHERE singleton AND revision=$1 RETURNING ${WATERMARK_COLUMNS}`,
    [input.expectedRevision, input.enabled, input.logoAssetId, input.position, input.sizePercent, input.opacityPercent, input.marginPercent, actor.id],
  )).rows[0];
  if (!after) throw conflict("水印规则已更新，请重新读取");
  await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId,
    action: "supply.account_image_watermark.updated", objectType: "account_image_watermark", objectId: "global",
    outcome: "SUCCESS", requestId, details: { before, after } });
  return after;
}
