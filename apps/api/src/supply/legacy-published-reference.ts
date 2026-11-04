import type { PoolClient } from "pg";
import { canonicalize } from "./content-hash";
import { isLegacyImagePath } from "./legacy-path-media";
import { sha256Hex } from "./supply-util";

export async function readLegacyPublishedReference(client: PoolClient, accountId: string, expectedDigest?: string) {
  if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) return null;
  const { rows } = await client.query<{
    ownerUserId: string; gameId: string; observationVersionId: string; sourceDigest: string;
    legacyId: string; gradingCode: string | null; displayPaths: string[]; blockedPaths: string[];
  }>(`SELECT a.owner_user_id AS "ownerUserId",a.game_id AS "gameId",p.observation_version_id AS "observationVersionId",
        p.source_digest AS "sourceDigest",m.legacy_id AS "legacyId",d.snapshot#>>'{attributes,grading_code}' AS "gradingCode",
        p.display_paths AS "displayPaths",
        ARRAY(SELECT path FROM unnest(p.display_paths) AS image(path)
          WHERE EXISTS (SELECT 1 FROM zzsh_supply.legacy_account_media_paths private_media
            WHERE private_media.penalty_paths @> ARRAY[image.path]::text[])) AS "blockedPaths"
     FROM zzsh_supply.legacy_account_media_paths p
     JOIN zzsh_supply.rental_account a ON a.id=p.account_id
     JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id AND m.version_id=p.observation_version_id AND m.source_digest=p.source_digest
       AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
     JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=a.id AND h.observation_version_id=m.version_id
       AND h.source_system=m.source_system AND h.source_entity=m.source_entity AND h.legacy_id=m.legacy_id AND h.source_digest=m.source_digest
       AND h.source_status=3
     LEFT JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=a.id AND d.observation_version_id=m.version_id
       AND d.base_source_digest=m.source_digest AND d.schema_version=1
     WHERE a.id=$1`, [accountId]);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!Array.isArray(row.displayPaths) || !row.displayPaths.every(isLegacyImagePath) || !Array.isArray(row.blockedPaths)) return null;
  const digest = sha256Hex(canonicalize(["LEGACY_PUBLISHED_REFERENCE", accountId, row.ownerUserId, row.gameId,
    row.observationVersionId, row.sourceDigest, row.legacyId, row.displayPaths]));
  if (expectedDigest !== undefined && digest !== expectedDigest) return null;
  const blocked = new Set(row.blockedPaths);
  const slots = row.displayPaths.flatMap((path, position) => blocked.has(path) ? [] : [{ position, path }]);
  return slots.length ? { digest, observationVersionId: row.observationVersionId, sourceDigest: row.sourceDigest, gradingCode: row.gradingCode, slots } : null;
}
