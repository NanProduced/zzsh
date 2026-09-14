import type { PoolClient } from "pg";

const FIELDS: Record<string, string> = {
  game: "id code name description enabled current_release_id cover_media_id catalog_revision",
  billable_item: "id game_id code name unit quantity_scale required enabled sort_order media_id",
  skin_rarity: "id game_id code name enabled sort_order",
  skin_category: "id game_id code name parent_id sort_order enabled form_visible",
  skin: "id game_id code name category_id rarity_code enabled form_visible media_id",
  entitlement: "id game_id code name value_kind expiry_kind enabled",
  price_version: "id game_id mode status commission_rate haff_rule rounding_policy compensation_policy_ref revision",
  term_version: "id game_id status revision",
  agreement_version: "id game_id title digest status revision",
  rule_release: "id game_id price_version_id term_version_id agreement_version_id generation",
  media_upload_intent: "id game_id account_id purpose ownership_kind owner_user_id uploaded_by_realm uploaded_by_user_id uploaded_by_admin_id declared_mime declared_size consumed_asset_id",
  media_asset: "id game_id purpose ownership_kind owner_user_id content_hash mime byte_size width height review_state access_class revision review_reason",
  game_service_operation: "id game_id service_code enabled revision",
  firearm_classification: "id game_id code name enabled sort_order revision source_namespace source_token source_note",
  firearm: "id game_id code name classification_id enabled sort_order media_id revision source_namespace source_token source_note",
  firearm_alias: "id game_id firearm_id locale name enabled sort_order revision source_namespace source_token source_note",
  gunsmith_code: "id game_id firearm_id code note mode_code status last_reviewed_at revision source_namespace source_token source_note",
};

export function auditObjectType(operation: string): string {
  if (operation.startsWith("supply.game.")) return "game";
  if (operation.startsWith("supply.catalog.")) return ({ items: "billable_item", rarities: "skin_rarity", categories: "skin_category", skins: "skin", entitlements: "entitlement" } as Record<string, string>)[operation.split(".")[2]!]!;
  if (operation.startsWith("supply.rules.")) return operation.includes("release") ? "rule_release" : operation.split(".")[2]!.replace("_draft", "_version");
  if (operation.startsWith("supply.game_service.")) return "game_service_operation";
  if (operation.startsWith("supply.gunsmith.classification.")) return "firearm_classification";
  if (operation.startsWith("supply.gunsmith.firearm.")) return "firearm";
  if (operation.startsWith("supply.gunsmith.alias.")) return "firearm_alias";
  if (operation.startsWith("supply.gunsmith.code.")) return "gunsmith_code";
  return operation.includes("upload_intent") ? "media_upload_intent" : "media_asset";
}

export async function auditSnapshot(client: PoolClient, table: string, id: string): Promise<Record<string, unknown> | null> {
  const fields = FIELDS[table];
  if (!fields) throw new Error("Unknown supply audit object");
  // Explicit fields: never copy upload tokens, agreement bodies or original evidence.
  const row = (await client.query<Record<string, unknown>>(`SELECT ${fields.split(" ").map((f) => `"${f}"`).join(", ")} FROM zzsh_supply."${table}" WHERE id = $1${table === "rule_release" ? "" : " FOR UPDATE"}`, [id])).rows[0];
  if (!row) return null;
  if (table === "price_version") row.lines = (await client.query(`SELECT item_id, customer_tier, pricing_kind, unit_quantity, buyer_unit_amount, owner_unit_amount FROM zzsh_supply.price_line WHERE price_version_id = $1 ORDER BY item_id, customer_tier`, [id])).rows;
  if (table === "term_version") row.options = (await client.query(`SELECT code, name, daily_consumption, duration_rounding FROM zzsh_supply.term_option WHERE version_id = $1 ORDER BY code`, [id])).rows;
  if (["billable_item", "skin_rarity", "skin_category", "skin", "entitlement"].includes(table)) row.catalogRevision = (await client.query(`SELECT catalog_revision::text AS revision FROM zzsh_supply.game WHERE id = $1`, [row.game_id])).rows[0]?.revision;
  if (table === "media_asset") row.bindings = (await client.query(`SELECT 'game' AS object_type, id FROM zzsh_supply.game WHERE cover_media_id = $1 UNION ALL SELECT 'skin' AS object_type, id FROM zzsh_supply.skin WHERE media_id = $1 UNION ALL SELECT 'billable_item' AS object_type, id FROM zzsh_supply.billable_item WHERE media_id = $1 UNION ALL SELECT 'firearm' AS object_type, id FROM zzsh_supply.firearm WHERE media_id = $1 ORDER BY object_type, id`, [id])).rows;
  return row;
}
