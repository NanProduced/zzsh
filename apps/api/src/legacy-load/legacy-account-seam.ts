/**
 * Controlled maintenance seam for creating the target rental account of a
 * migrated legacy owner. There is intentionally no public route: a migrated
 * owner has no locally usable password, and the only passwordless login
 * (phone OTP) would set phoneNumberVerified=true and break the audited
 * migrateLegacyOwner replay contract. The caller must already own a
 * transaction; the account owner is derived from the source tuple and must
 * already carry the matching migrateLegacyOwner identity and audit evidence.
 */

import type { PoolClient } from "pg";

import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { assignAccountNumber } from "../supply/account-number";
import { GAME_SERVICE, requireWritableGameService } from "../supply/game-services";
import { lockLegacySource } from "../supply/legacy-observation";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { authorizeSystemAccountMigration, type SystemAccountMigrationActor } from "./system-user-migration";
import {
  assertGameScope,
  conflict,
  fingerprintRequest,
  invalid,
  sha256Hex,
  withIdempotency,
} from "../supply/supply-util";

export type LegacyAccountCreationActor = { id: string; sessionId: string; requestId: string };

export type LegacyAccountCreationInput = {
  sourceSystem: "legacy_mysql_restore";
  sourceEntity: "la_rental_accounts";
  legacyId: string;
  sourceDigest: string;
  evidenceRef: string;
  owner: { legacyId: string; sourceDigest: string };
  gameId: string;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION = "supply.legacy.account-create";
const MIGRATED_PROVIDER = "legacy_mysql_restore";

/** Deterministic target id: the same source account replays to the same local account. */
export function legacyAccountId(sourceSystem: string, sourceEntity: string, legacyId: string): string {
  return `account_${sha256Hex(JSON.stringify(["legacy-account", sourceSystem, sourceEntity, legacyId])).slice(0, 40)}`;
}

function normalized(input: LegacyAccountCreationInput): LegacyAccountCreationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Legacy account creation is invalid");
  if (Object.keys(input).sort().join(",") !== "evidenceRef,gameId,legacyId,owner,sourceDigest,sourceEntity,sourceSystem")
    throw invalid("Legacy account creation is invalid");
  if (input.sourceSystem !== MIGRATED_PROVIDER || input.sourceEntity !== "la_rental_accounts")
    throw invalid("Legacy account source is not verified");
  if (typeof input.legacyId !== "string" || !ID_PATTERN.test(input.legacyId) || typeof input.gameId !== "string" || !ID_PATTERN.test(input.gameId))
    throw invalid("Legacy account identifier is invalid");
  if (typeof input.sourceDigest !== "string" || !DIGEST_PATTERN.test(input.sourceDigest))
    throw invalid("Legacy account digest is required");
  if (typeof input.evidenceRef !== "string" || input.evidenceRef.length === 0 || input.evidenceRef.length > 512)
    throw invalid("Legacy account evidence reference is invalid");
  if (!input.owner || typeof input.owner !== "object" || Object.keys(input.owner).sort().join(",") !== "legacyId,sourceDigest")
    throw invalid("Legacy account owner binding is invalid");
  if (typeof input.owner.legacyId !== "string" || !ID_PATTERN.test(input.owner.legacyId) || !DIGEST_PATTERN.test(input.owner.sourceDigest))
    throw invalid("Legacy account owner binding is invalid");
  return input;
}

export async function createLegacyOwnerRentalAccount(
  client: PoolClient,
  input: LegacyAccountCreationInput,
  actor: LegacyAccountCreationActor | SystemAccountMigrationActor,
): Promise<{ accountId: string; replayed: boolean }> {
  const normalizedInput = normalized(input);
  const ownerUserId = legacyOwnerUserId(MIGRATED_PROVIDER, "la_user", normalizedInput.owner.legacyId);
  const accountId = legacyAccountId(normalizedInput.sourceSystem, normalizedInput.sourceEntity, normalizedInput.legacyId);
  const idempotencyKey = sha256Hex(JSON.stringify([OPERATION, normalizedInput.sourceSystem, normalizedInput.sourceEntity, normalizedInput.legacyId]));
  const fingerprint = fingerprintRequest(OPERATION, accountId, normalizedInput);
  const systemActor = "kind" in actor && actor.kind === "SYSTEM_ACCOUNT_MIGRATION" ? actor : null;
  const payloadDigest = sha256Hex(JSON.stringify(normalizedInput));
  if (systemActor && !/^[1-9][0-9]{0,23}$/.test(normalizedInput.legacyId)) throw invalid("Legacy account source is invalid");
  const result = await withIdempotency(
    client,
    { realm: systemActor ? "system" : "admin", principalId: actor.id, operation: OPERATION, resourceId: accountId },
    idempotencyKey,
    fingerprint,
    async () => {
      const access = systemActor ? null : await loadEffectiveAdminAccess(client, actor.id);
      if (systemActor) await authorizeSystemAccountMigration(client, systemActor, { operation:"CREATE", accountId,
        sourceSystem:normalizedInput.sourceSystem,sourceEntity:normalizedInput.sourceEntity,legacyId:normalizedInput.legacyId,
        sourceDigest:normalizedInput.sourceDigest,payloadDigest });
      else requirePermission(access, "supply.catalog.manage");
      await requireWritableGameService(client, normalizedInput.gameId, GAME_SERVICE.ACCOUNT_RENTAL);
      if (!systemActor) await assertGameScope(client, actor.id, access!.isBoss, normalizedInput.gameId);
      const owner = (
        await client.query<{ provider: string; provider_reference: string; account_status: string; suspended: boolean; migration_proven: boolean }>(
          `SELECT i.provider, i.provider_reference, i.account_status, u.suspended,
                  EXISTS (SELECT 1 FROM zzsh_iam.audit_event e
                    WHERE e.object_id=u.id AND e.object_type='user' AND e.action='user.legacy_owner.migrated' AND e.outcome='SUCCESS'
                      AND e.details->>'sourceSystem'=$2 AND e.details->>'sourceEntity'='la_user'
                      AND e.details->>'legacyId'=$3 AND e.details->>'sourceDigest'=$4
                      AND (e.actor_type='admin' OR (e.actor_type='system' AND e.session_id IS NULL
                        AND to_jsonb(e)->>'legacy_migration_manifest_sha256' ~ '^[a-f0-9]{64}$'
                        AND e.details->>'sourceDatasetSha256'=to_jsonb(e)->>'legacy_migration_manifest_sha256'
                        AND e.details->>'migrationRunDigest' ~ '^[a-f0-9]{64}$'
                        AND e.actor_id='legacy-user-migration:'||(e.details->>'migrationRunDigest')))) AS migration_proven
             FROM zzsh_auth_user."user" u
             JOIN zzsh_iam.user_identity_state i ON i.user_id = u.id
            WHERE u.id = $1`,
          [ownerUserId, normalizedInput.sourceSystem, normalizedInput.owner.legacyId, normalizedInput.owner.sourceDigest],
        )
      ).rows[0];
      // Importing an unpublished historical holding does not restore the owner's trading eligibility.
      if (!owner || owner.provider !== MIGRATED_PROVIDER || owner.provider_reference !== `la_user:${normalizedInput.owner.legacyId}`
        || !["ACTIVE","FROZEN","CANCELLED"].includes(owner.account_status) || typeof owner.suspended !== "boolean")
        throw conflict("The target account owner is not the migrated legacy owner");
      if (!owner.migration_proven) throw conflict("The target account owner has no matching migration evidence");
      return false;
    },
    async () => {
      await lockLegacySource(client, normalizedInput);
      const existing = (
        await client.query<{ owner_user_id: string; game_id: string }>(
          `SELECT owner_user_id, game_id FROM zzsh_supply.rental_account WHERE id=$1`,
          [accountId],
        )
      ).rows[0];
      if (existing) {
        if (existing.owner_user_id !== ownerUserId || existing.game_id !== normalizedInput.gameId)
          throw conflict("The legacy account conflicts with the recorded target account");
        return { status: 200, body: { accountId } };
      }
      await client.query(
        `INSERT INTO "zzsh_supply"."rental_account" ("id", "owner_user_id", "game_id") VALUES ($1, $2, $3)`,
        [accountId, ownerUserId, normalizedInput.gameId],
      );
      await recordAudit(client, {
        actorType: systemActor ? "system" : "admin",
        actorId: actor.id,
        ...(systemActor ? {legacyMigrationManifestSha256:systemActor.sourceDatasetSha256} : {sessionId:(actor as LegacyAccountCreationActor).sessionId}),
        requestId: actor.requestId,
        action: "supply.legacy.account_created",
        objectType: "rental_account",
        objectId: accountId,
        outcome: "SUCCESS",
        reason: "按受限来源证据为迁移号主建立目标账号；真实本人未登录，不重置旧密码、不伪造实名",
        details: {
          sourceSystem: normalizedInput.sourceSystem,
          sourceEntity: normalizedInput.sourceEntity,
          legacyId: normalizedInput.legacyId,
          sourceDigest: normalizedInput.sourceDigest,
          ...(systemActor ? {sourceDatasetSha256:systemActor.sourceDatasetSha256,migrationRunDigest:systemActor.id.slice("legacy-account-migration:".length),payloadDigest} : {}),
          evidenceRef: normalizedInput.evidenceRef,
          ownerUserId,
          ownerLegacyId: normalizedInput.owner.legacyId,
          ownerSourceDigest: normalizedInput.owner.sourceDigest,
          gameId: normalizedInput.gameId,
          result: "CREATED",
          seam: "LEGACY_ACCOUNT_CREATE",
        },
      });
      return { status: 200, body: { accountId } };
    },
  );
  await assignAccountNumber(client, accountId);
  return { accountId, replayed: result.replayed };
}
