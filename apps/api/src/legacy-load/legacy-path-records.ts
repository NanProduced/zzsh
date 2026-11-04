import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { requirePermission } from "../auth/admin-authorization";
import { lockActor } from "../auth/admin-directory";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { parseLegacyImagePaths } from "../supply/legacy-path-media";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { assertGameScope, conflict, invalid, notFound, sha256Hex } from "../supply/supply-util";

export function prepareLegacyPathRecord(sourceRow: Record<string, unknown>) {
  if (!sourceRow || typeof sourceRow !== "object" || Array.isArray(sourceRow) || !/^[1-9][0-9]*$/.test(String(sourceRow.id ?? "")) || !/^[1-9][0-9]*$/.test(String(sourceRow.user_id ?? "")) || !Object.hasOwn(sourceRow, "img_paths") || !Object.hasOwn(sourceRow, "punishment_img_url")) throw invalid("Legacy image source is incomplete");
  try {
    return { legacyId: String(sourceRow.id), ownerUserId: legacyOwnerUserId("legacy_mysql_restore", "la_user", String(sourceRow.user_id)), sourceDigest: sha256Hex(canonicalize(sourceRow)),
      displayPaths: parseLegacyImagePaths(sourceRow.img_paths), penaltyPaths: parseLegacyImagePaths(sourceRow.punishment_img_url) };
  } catch { throw invalid("Legacy image source is invalid"); }
}

/** Caller owns the transaction; authentication and source/target bindings are checked once per batch. */
export async function recordLegacyPathRecords(client: PoolClient, inputs: Array<{ accountId: string; sourceRow: Record<string, unknown> }>, actor: { id: string; sessionId: string; requestId: string }) {
  if (!inputs.length || inputs.length > 100 || new Set(inputs.map(input => input.accountId)).size !== inputs.length) throw invalid("Legacy image batch is invalid");
  const access = await lockActor(client, actor.id);
  await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  requirePermission(access, "supply.catalog.manage");
  const next = inputs.map(input => ({ accountId: input.accountId, ...prepareLegacyPathRecord(input.sourceRow) }));
  const mapped = (await client.query<{ accountId: string; ownerUserId: string; legacyId: string; gameId: string; observationVersionId: string; sourceDigest: string }>(
    `SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",m.legacy_id AS "legacyId",a.game_id AS "gameId",m.version_id AS "observationVersionId",m.source_digest AS "sourceDigest"
       FROM zzsh_supply.rental_account a JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id
      WHERE a.id=ANY($1::text[]) AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' ORDER BY a.id FOR UPDATE OF a`,
    [next.map(row => row.accountId)],
  )).rows;
  if (mapped.length !== next.length || new Set(mapped.map(row => row.accountId)).size !== next.length) throw notFound();
  for (const gameId of new Set(mapped.map(row => row.gameId))) await assertGameScope(client, actor.id, access!.isBoss, gameId);
  const byId = new Map(mapped.map(row => [row.accountId, row]));
  for (const row of next) {
    const match = byId.get(row.accountId);
    if (!match || match.legacyId !== row.legacyId || match.ownerUserId !== row.ownerUserId || match.sourceDigest !== row.sourceDigest) throw conflict("Legacy image source changed");
  }
  const prior = (await client.query<{ accountId: string; observationVersionId: string; sourceDigest: string; displayPaths: string[]; penaltyPaths: string[] }>(
    `SELECT account_id AS "accountId",observation_version_id AS "observationVersionId",source_digest AS "sourceDigest",display_paths AS "displayPaths",penalty_paths AS "penaltyPaths" FROM zzsh_supply.legacy_account_media_paths WHERE account_id=ANY($1::text[])`, [next.map(row => row.accountId)],
  )).rows;
  const existing = new Map(prior.map(row => [row.accountId, row]));
  const pending = next.filter(row => {
    const old = existing.get(row.accountId); if (!old) return true;
    if (old.observationVersionId !== byId.get(row.accountId)!.observationVersionId || old.sourceDigest !== row.sourceDigest || JSON.stringify(old.displayPaths) !== JSON.stringify(row.displayPaths) || JSON.stringify(old.penaltyPaths) !== JSON.stringify(row.penaltyPaths)) throw conflict("Legacy image paths conflict with recorded source");
    return false;
  });
  if (pending.length) {
    const rows = pending.map(row => ({ accountId: row.accountId, observationVersionId: byId.get(row.accountId)!.observationVersionId, sourceDigest: row.sourceDigest, displayPaths: row.displayPaths, penaltyPaths: row.penaltyPaths }));
    await client.query(`INSERT INTO zzsh_supply.legacy_account_media_paths(account_id,observation_version_id,source_digest,display_paths,penalty_paths,created_by_admin_id)
      SELECT r."accountId",r."observationVersionId",r."sourceDigest",ARRAY(SELECT jsonb_array_elements_text(r."displayPaths")),ARRAY(SELECT jsonb_array_elements_text(r."penaltyPaths")),$2
      FROM jsonb_to_recordset($1::jsonb) AS r("accountId" text,"observationVersionId" text,"sourceDigest" text,"displayPaths" jsonb,"penaltyPaths" jsonb)`, [JSON.stringify(rows), actor.id]);
    await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId: actor.requestId,
      action: "supply.legacy.image_paths_recorded", objectType: "legacy_media_batch", objectId: actor.requestId, outcome: "SUCCESS",
      details: { count: rows.length, sourceBindingDigest: sha256Hex(canonicalize(rows)) } });
  }
  return { inserted: pending.length, replayed: next.length - pending.length };
}

export async function recordLegacyPathRecord(client: PoolClient, accountId: string, sourceRow: Record<string, unknown>, actor: { id: string; sessionId: string; requestId: string }) {
  const result = await recordLegacyPathRecords(client, [{ accountId, sourceRow }], actor);
  return { accountId, replayed: result.replayed === 1 };
}
