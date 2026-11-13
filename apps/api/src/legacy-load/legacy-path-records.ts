import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { requirePermission } from "../auth/admin-authorization";
import { lockActor } from "../auth/admin-directory";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { parseLegacyImagePaths } from "../supply/legacy-path-media";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { authorizeSystemAccountMigration, type SystemAccountMigrationActor } from "./system-user-migration";
import { assertGameScope, conflict, fingerprintRequest, invalid, notFound, sha256Hex, withIdempotency } from "../supply/supply-util";

export function prepareLegacyPathRecord(sourceRow: Record<string, unknown>) {
  if (!sourceRow || typeof sourceRow !== "object" || Array.isArray(sourceRow) || !/^[1-9][0-9]*$/.test(String(sourceRow.id ?? "")) || !/^[1-9][0-9]*$/.test(String(sourceRow.user_id ?? "")) || !Object.hasOwn(sourceRow, "img_paths") || !Object.hasOwn(sourceRow, "punishment_img_url")) throw invalid("Legacy image source is incomplete");
  try {
    return { legacyId: String(sourceRow.id), ownerUserId: legacyOwnerUserId("legacy_mysql_restore", "la_user", String(sourceRow.user_id)), sourceDigest: sha256Hex(canonicalize(sourceRow)),
      displayPaths: parseLegacyImagePaths(sourceRow.img_paths), penaltyPaths: parseLegacyImagePaths(sourceRow.punishment_img_url) };
  } catch { throw invalid("Legacy image source is invalid"); }
}

export function legacyPathMigrationDigest(accountId: string, sourceRow: Record<string, unknown>): string {
  return sha256Hex(canonicalize({ accountId, ...prepareLegacyPathRecord(sourceRow) }));
}

/** Caller owns the transaction; authentication and source/target bindings are checked once per batch. */
export async function recordLegacyPathRecords(client: PoolClient, inputs: Array<{ accountId: string; sourceRow: Record<string, unknown> }>, actor: { id: string; sessionId: string; requestId: string } | SystemAccountMigrationActor) {
  if (!inputs.length || inputs.length > 100 || new Set(inputs.map(input => input.accountId)).size !== inputs.length) throw invalid("Legacy image batch is invalid");
  if ("kind" in actor) {
    const next = inputs.map(input => ({ accountId: input.accountId, ...prepareLegacyPathRecord(input.sourceRow) })).sort((a,b)=>a.accountId<b.accountId?-1:a.accountId>b.accountId?1:0);
    const digest = sha256Hex(canonicalize(next)), batchId = `legacy-media-batch:${digest}`, operation = "supply.legacy.image_paths";
    const fingerprint = fingerprintRequest(operation, batchId, next);
    let mapped: Array<{ accountId: string; ownerUserId: string; legacyId: string; observationVersionId: string; sourceDigest: string }> = [];
    const result = await withIdempotency(client, { realm: "system", principalId: actor.id, operation, resourceId: batchId }, batchId, fingerprint,
      async replay => {
        if (replay?.publishRequired) throw conflict("Original system image paths receipt differs");
        for (const row of next) await authorizeSystemAccountMigration(client, actor, { operation: "MEDIA", accountId: row.accountId,
          sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: row.legacyId, sourceDigest: row.sourceDigest,
          payloadDigest: sha256Hex(canonicalize(row)) });
        mapped = (await client.query<typeof mapped[number]>(`SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",m.legacy_id AS "legacyId",
          m.version_id AS "observationVersionId",m.source_digest AS "sourceDigest" FROM zzsh_supply.rental_account a
          JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id WHERE a.id=ANY($1::text[])
          AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' ORDER BY a.id FOR UPDATE OF a`, [next.map(row=>row.accountId)])).rows;
        if (mapped.length !== next.length) throw conflict("Legacy image source is unavailable");
        const byId = new Map(mapped.map(row=>[row.accountId,row]));
        for (const row of next) {
          const match=byId.get(row.accountId);
          if (!match || match.legacyId!==row.legacyId || match.ownerUserId!==row.ownerUserId || match.sourceDigest!==row.sourceDigest) throw conflict("Legacy image source changed");
        }
        const sourceAudits = (await client.query<{ accountId: string; matched: number; total: number }>(`SELECT m.account_id AS "accountId",
          count(a.id) FILTER (WHERE a.actor_type='system' AND a.actor_id=$2 AND a.session_id IS NULL AND a.legacy_migration_manifest_sha256=$3
            AND a.details->>'legacyId'=m.legacy_id AND a.details->>'sourceDigest'=m.source_digest AND a.details#>>'{after,currentVersionId}'=m.version_id)::int AS matched,
          count(a.id)::int AS total FROM zzsh_supply.legacy_supply_map m LEFT JOIN zzsh_iam.audit_event a ON a.object_id=m.account_id
            AND a.object_type='rental_account' AND a.action='supply.publication.legacy_observed' AND a.outcome='SUCCESS'
          WHERE m.account_id=ANY($1::text[]) AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' GROUP BY m.account_id`,
        [next.map(row=>row.accountId),actor.id,actor.sourceDatasetSha256])).rows;
        if (sourceAudits.length!==next.length || sourceAudits.some(row=>row.matched!==1||row.total!==1)) throw conflict("Original system image account evidence differs");
        const prior=(await client.query<{accountId:string;observationVersionId:string;sourceDigest:string;displayPaths:string[];penaltyPaths:string[];migrationId:string|null;manifest:string|null;batchId:string|null}>(`
          SELECT account_id AS "accountId",observation_version_id AS "observationVersionId",source_digest AS "sourceDigest",display_paths AS "displayPaths",
            penalty_paths AS "penaltyPaths",created_by_migration_id AS "migrationId",migration_manifest_sha256 AS manifest,migration_batch_id AS "batchId"
          FROM zzsh_supply.legacy_account_media_paths WHERE account_id=ANY($1::text[])`,[next.map(row=>row.accountId)])).rows;
        const audit=(await client.query<{matched:number;total:number}>(`SELECT count(*) FILTER (WHERE actor_type='system' AND actor_id=$2 AND session_id IS NULL
          AND legacy_migration_manifest_sha256=$3 AND details->>'sourceBindingDigest'=$4 AND details->>'count'=$5)::int AS matched,count(*)::int AS total
          FROM zzsh_iam.audit_event WHERE action='supply.legacy.image_paths_recorded' AND object_type='legacy_media_batch' AND object_id=$1 AND outcome='SUCCESS'`,
        [batchId,actor.id,actor.sourceDatasetSha256,digest,String(next.length)])).rows[0];
        if (!audit || (replay ? prior.length!==next.length || audit.matched!==1 || audit.total!==1 : prior.length!==0 || audit.total!==0))
          throw conflict("Original system image paths evidence differs");
        const priorById=new Map(prior.map(row=>[row.accountId,row]));
        if (replay) for (const row of next) {
          const old=priorById.get(row.accountId),match=byId.get(row.accountId)!;
          if (!old || old.observationVersionId!==match.observationVersionId || old.sourceDigest!==row.sourceDigest
            || old.migrationId!==actor.id || old.manifest!==actor.sourceDatasetSha256 || old.batchId!==batchId
            || canonicalize(old.displayPaths)!==canonicalize(row.displayPaths) || canonicalize(old.penaltyPaths)!==canonicalize(row.penaltyPaths))
            throw conflict("Original system image paths differ");
        }
        return false;
      }, async () => {
        const byId=new Map(mapped.map(row=>[row.accountId,row]));
        const rows=next.map(row=>({accountId:row.accountId,observationVersionId:byId.get(row.accountId)!.observationVersionId,
          sourceDigest:row.sourceDigest,displayPaths:row.displayPaths,penaltyPaths:row.penaltyPaths}));
        await client.query(`INSERT INTO zzsh_supply.legacy_account_media_paths(account_id,observation_version_id,source_digest,display_paths,penalty_paths,
          created_by_admin_id,created_by_migration_id,migration_manifest_sha256,migration_batch_id)
          SELECT r."accountId",r."observationVersionId",r."sourceDigest",ARRAY(SELECT jsonb_array_elements_text(r."displayPaths")),
            ARRAY(SELECT jsonb_array_elements_text(r."penaltyPaths")),NULL,$2,$3,$4
          FROM jsonb_to_recordset($1::jsonb) AS r("accountId" text,"observationVersionId" text,"sourceDigest" text,"displayPaths" jsonb,"penaltyPaths" jsonb)`,
        [JSON.stringify(rows),actor.id,actor.sourceDatasetSha256,batchId]);
        await recordAudit(client,{actorType:"system",actorId:actor.id,legacyMigrationManifestSha256:actor.sourceDatasetSha256,requestId:actor.requestId,
          action:"supply.legacy.image_paths_recorded",objectType:"legacy_media_batch",objectId:batchId,outcome:"SUCCESS",
          details:{sourceSystem:"legacy_mysql_restore",sourceEntity:"la_rental_accounts",sourceDatasetSha256:actor.sourceDatasetSha256,
            migrationRunDigest:actor.id.slice("legacy-account-migration:".length),count:rows.length,sourceBindingDigest:digest}});
        return {status:200,body:{inserted:rows.length,replayed:0}};
      });
    if(result.status!==200||canonicalize(result.body)!==canonicalize({inserted:next.length,replayed:0}))throw conflict("Original system image paths receipt differs");
    return result.replayed ? {inserted:0,replayed:next.length} : result.body as {inserted:number;replayed:number};
  }
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
