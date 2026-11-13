import type { PoolClient } from "pg";
import { updateVisibilitySql } from "../content/updates";
import { conflict } from "./supply-util";

/** Bind the planned change to an already public version, even if the announcement is edited later. */
export async function assertPublishedPricingAnnouncement(client: PoolClient, gameId: string, versionId: string, effectiveAt: string) {
  const now = updateVisibilitySql("at.now"), effective = updateVisibilitySql("$3");
  const announcement = (await client.query(`WITH at AS MATERIALIZED (SELECT clock_timestamp() AS now)
    SELECT v.id FROM zzsh_content.content_version v
    JOIN zzsh_content.content_item i ON i.id=v.item_id CROSS JOIN at
    WHERE v.id=$1 AND i.type='ANNOUNCEMENT' AND (i.game_id=$2 OR i.game_id IS NULL)
      AND v.state='PUBLISHED' AND v.published_at<=at.now AND at.now<$3::timestamptz
      AND ${now.visible} AND ${now.alive} AND ${effective.visible}
    FOR SHARE OF v,i`, [versionId, gameId, effectiveAt])).rows[0];
  if (!announcement) throw conflict("请先发布适用于该游戏的调价公告");
}
