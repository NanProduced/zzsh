import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../auth/security-core";

import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "./content-hash";
import { normalizeMainlandPhone } from "../auth/phone-number";
import { lockLegacySource } from "./legacy-observation";
import {
  conflict,
  fingerprintRequest,
  invalid,
  sha256Hex,
  withIdempotency,
} from "./supply-util";

export type LegacyOwnerMigrationActor = {
  id: string;
  sessionId: string;
  requestId: string;
};

/** Source status facts copied from the frozen legacy user row; never inferred here. */
export type LegacyOwnerStatusEvidence = {
  realNameBound: boolean;
  /** true ADULT, false MINOR, null unknown; derived from legacy id_card evidence upstream. */
  ageAdult: boolean | null;
  disabled: boolean;
  deleted: boolean;
};

export type LegacyOwnerPasswordEvidence = {
  version: "legacy-md5-v1";
  md5: string;
  salt: string;
};

export type LegacyOwnerEvidence = {
  sourceSystem: string;
  sourceEntity: string;
  legacyId: string;
  sourceDigest: string;
  evidenceRef: string;
  nickname: string;
  mobile: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  status: LegacyOwnerStatusEvidence;
  /** The legacy credential is preserved as-is; a locally usable password is never invented. */
  legacyPassword: LegacyOwnerPasswordEvidence | null;
};

export type LegacyOwnerMigrationInput = {
  evidence: LegacyOwnerEvidence;
  /** sha256 of the canonical evidence payload, binding the flags to one exact record. */
  evidenceDigest: string;
};

export type LegacyOwnerMigrationResult = {
  userId: string;
  replayed: boolean;
};

/** One caller-owned checkpoint, tied to the exact frozen plan; failures stay isolated by source row. */
export async function migrateLegacyUserBatch(
  pool: Pool, inputs: readonly LegacyOwnerMigrationInput[], actor: LegacyOwnerMigrationActor,
  cursor: { planSha256: string; nextIndex: number }, planSha256: string, batchSize = 500,
) {
  if (!/^[a-f0-9]{64}$/.test(planSha256) || cursor.planSha256 !== planSha256 || !Number.isSafeInteger(cursor.nextIndex) || cursor.nextIndex < 0 || cursor.nextIndex > inputs.length || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw invalid("Invalid legacy batch checkpoint");
  const results: Array<{ index: number; outcome: "MAPPED" | "REPLAYED" | "QUARANTINED"; userId?: string; errorCode?: string }> = [];
  const end = Math.min(inputs.length, cursor.nextIndex + batchSize);
  for (let index = cursor.nextIndex; index < end; index++) {
    try {
      const result = await withTransaction(pool, client => migrateLegacyOwner(client, inputs[index]!, actor));
      results.push({ index, outcome: result.replayed ? "REPLAYED" : "MAPPED", userId: result.userId });
    } catch (error) {
      // Connection/permission/audit failures have unknown operational consequences: stop, retain the cursor.
      if (!(error && typeof error === "object" && "status" in error && [400,409].includes(Number(error.status)))) throw error;
      results.push({ index, outcome: "QUARANTINED", errorCode: "SOURCE_CONFLICT" });
    }
  }
  return { cursor: { planSha256, nextIndex: end }, complete: end === inputs.length, results };
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MD5_PATTERN = /^[a-f0-9]{32}$/;
const SALT_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const OPERATION_MIGRATE = "supply.legacy.owner-migrate";
const MIGRATED_PROVIDER = "legacy_mysql_restore";

type NormalizedLegacyOwner = {
  evidence: LegacyOwnerEvidence;
  evidenceDigest: string;
};

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sourceReference(input: {
  sourceSystem: unknown;
  sourceEntity: unknown;
  legacyId: unknown;
  evidenceRef: unknown;
  sourceDigest: unknown;
}): void {
  if (
    typeof input.sourceDigest !== "string" ||
    !DIGEST_PATTERN.test(input.sourceDigest) ||
    ![input.sourceSystem, input.sourceEntity, input.legacyId, input.evidenceRef].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 512,
    )
  )
    throw invalid("Legacy source reference is required");
}

function normalizeMobile(value: unknown): string {
  const normalized = normalizeMainlandPhone(value);
  if (!normalized) throw invalid("Legacy owner mobile is invalid");
  return normalized.slice(3);
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value)))
    throw invalid("Legacy owner timestamp is invalid");
  return value;
}

function normalizeStatus(value: unknown): LegacyOwnerStatusEvidence {
  if (!recordValue(value) || Object.keys(value).sort().join(",") !== "ageAdult,deleted,disabled,realNameBound")
    throw invalid("Legacy owner status evidence is invalid");
  if (typeof value.realNameBound !== "boolean" || typeof value.disabled !== "boolean" || typeof value.deleted !== "boolean")
    throw invalid("Legacy owner status evidence is invalid");
  if (value.ageAdult !== null && typeof value.ageAdult !== "boolean")
    throw invalid("Legacy owner age evidence is invalid");
  return {
    realNameBound: value.realNameBound,
    ageAdult: value.ageAdult as boolean | null,
    disabled: value.disabled,
    deleted: value.deleted,
  };
}

function normalizeLegacyPassword(value: unknown): LegacyOwnerPasswordEvidence | null {
  if (value === null || value === undefined) return null;
  if (!recordValue(value) || Object.keys(value).sort().join(",") !== "md5,salt,version")
    throw invalid("Legacy owner password evidence is invalid");
  if (value.version !== "legacy-md5-v1" || typeof value.md5 !== "string" || !MD5_PATTERN.test(value.md5))
    throw invalid("Legacy owner password evidence is invalid");
  if (typeof value.salt !== "string" || !SALT_PATTERN.test(value.salt))
    throw invalid("Legacy owner password salt is invalid");
  return { version: "legacy-md5-v1", md5: value.md5.toLowerCase(), salt: value.salt };
}

function normalizeEvidence(value: unknown): LegacyOwnerEvidence {
  if (!recordValue(value)) throw invalid("Legacy owner evidence is invalid");
  sourceReference(value as {
    sourceSystem: unknown; sourceEntity: unknown; legacyId: unknown; evidenceRef: unknown; sourceDigest: unknown;
  });
  if (typeof value.nickname !== "string") throw invalid("Legacy owner nickname is invalid");
  const nickname = value.nickname;
  if (nickname.trim().length === 0) throw invalid("Legacy owner nickname is invalid");
  return {
    sourceSystem: String(value.sourceSystem),
    sourceEntity: String(value.sourceEntity),
    legacyId: String(value.legacyId),
    sourceDigest: String(value.sourceDigest),
    evidenceRef: String(value.evidenceRef),
    nickname,
    mobile: normalizeMobile(value.mobile),
    sourceCreatedAt: normalizeTimestamp(value.sourceCreatedAt),
    sourceUpdatedAt: normalizeTimestamp(value.sourceUpdatedAt),
    status: normalizeStatus(value.status),
    legacyPassword: normalizeLegacyPassword(value.legacyPassword),
  };
}

/** Validates and digests one exact evidence payload; used by the writer and the converter. */
export function legacyOwnerEvidenceDigest(evidence: LegacyOwnerEvidence): string {
  return sha256Hex(canonicalize(normalizeEvidence(evidence)));
}

/** Pure boundary normalization used by both the writer and its offline tests. */
export function normalizeLegacyOwnerInput(input: LegacyOwnerMigrationInput): NormalizedLegacyOwner {
  if (!recordValue(input) || Object.keys(input).sort().join(",") !== "evidence,evidenceDigest")
    throw invalid("Legacy owner migration is invalid");
  const evidence = normalizeEvidence(input.evidence);
  if (typeof input.evidenceDigest !== "string" || !DIGEST_PATTERN.test(input.evidenceDigest))
    throw invalid("Legacy owner evidence digest is required");
  if (sha256Hex(canonicalize(evidence)) !== input.evidenceDigest)
    throw invalid("Legacy owner evidence digest does not match the supplied evidence");
  return { evidence, evidenceDigest: input.evidenceDigest };
}

/** Deterministic target id: the same legacy source replays to the same local user. */
export function legacyOwnerUserId(sourceSystem: string, sourceEntity: string, legacyId: string): string {
  return `user_${sha256Hex(JSON.stringify(["legacy-owner", sourceSystem, sourceEntity, legacyId])).slice(0, 40)}`;
}

function derivedStatusValues(status: LegacyOwnerStatusEvidence): { accountStatus: string; identityStatus: string; ageStatus: string } {
  return {
    accountStatus: status.deleted ? "CANCELLED" : status.disabled ? "DEACTIVATED" : "ACTIVE",
    identityStatus: status.realNameBound ? "VERIFIED" : "UNVERIFIED",
    ageStatus: status.ageAdult === true ? "ADULT" : status.ageAdult === false ? "MINOR" : "UNKNOWN",
  };
}

async function authorizeLegacyMigrationAdmin(
  client: PoolClient,
  actor: LegacyOwnerMigrationActor,
): Promise<void> {
  const access = await loadEffectiveAdminAccess(client, actor.id);
  requirePermission(access, "supply.catalog.manage");
}

/**
 * Controlled migration seam for one real legacy user. The caller must already
 * own a transaction; there is intentionally no public route around this method.
 * Statuses come from explicit source evidence: unknown or unproven facts are
 * never upgraded, and no local password is invented for the legacy credential.
 */
export async function migrateLegacyOwner(
  client: PoolClient,
  input: LegacyOwnerMigrationInput,
  actor: LegacyOwnerMigrationActor,
): Promise<LegacyOwnerMigrationResult> {
  const normalized = normalizeLegacyOwnerInput(input);
  const { evidence, evidenceDigest } = normalized;
  const status = derivedStatusValues(evidence.status);
  const idempotencyKey = sha256Hex(
    JSON.stringify([OPERATION_MIGRATE, evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId]),
  );
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: actor.id, operation: OPERATION_MIGRATE },
    idempotencyKey,
    fingerprintRequest(OPERATION_MIGRATE, undefined, evidence),
    async () => {
      await authorizeLegacyMigrationAdmin(client, actor);
    },
    async () => {
      await lockLegacySource(client, evidence);
      const userId = legacyOwnerUserId(evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId);
      const phoneNumber = `+86${evidence.mobile}`;
      const email = `phone-${sha256Hex(phoneNumber)}@phone.zzsh.invalid`;
      const providerReference = `${evidence.sourceEntity}:${evidence.legacyId}`;
      const existing = (
        await client.query<{ id: string; name: string; email: string; phoneNumber: string; phoneNumberVerified: boolean; suspended: boolean }>(
          `SELECT "id","name","email","phoneNumber","phoneNumberVerified","suspended" FROM "zzsh_auth_user"."user"
            WHERE "id"=$1 OR "phoneNumber"=$2 FOR UPDATE`,
          [userId, phoneNumber],
        )
      ).rows;
      if (existing.length > 0) {
        const row = existing[0]!;
        const userMatches =
          existing.length === 1 &&
          row.id === userId &&
          row.name === evidence.nickname &&
          row.email === email &&
          row.phoneNumber === phoneNumber &&
          row.phoneNumberVerified === false &&
          row.suspended === false;
        if (!userMatches) throw conflict("The legacy owner conflicts with an existing local user");
        const identity = (
          await client.query<{ account_status: string; identity_status: string; age_status: string; provider: string; provider_reference: string; verified_at: string | null }>(
            `SELECT "account_status","identity_status","age_status","provider","provider_reference",to_char("verified_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "verified_at"
               FROM "zzsh_iam"."user_identity_state" WHERE "user_id"=$1`,
            [userId],
          )
        ).rows[0];
        if (
          !identity ||
          identity.account_status !== status.accountStatus ||
          identity.identity_status !== status.identityStatus ||
          identity.age_status !== status.ageStatus ||
          identity.provider !== MIGRATED_PROVIDER ||
          identity.provider_reference !== providerReference ||
          identity.verified_at !== null
        )
          throw conflict("The legacy owner identity record conflicts with the supplied evidence");
        const recorded = (
          await client.query<{ sourceDigest: string | null; evidenceDigest: string | null }>(
            `SELECT "details"->>'sourceDigest' AS "sourceDigest", "details"->>'evidenceDigest' AS "evidenceDigest"
               FROM "zzsh_iam"."audit_event"
              WHERE "object_id"=$1 AND "action"='user.legacy_owner.migrated'
              ORDER BY "occurred_at" DESC LIMIT 1`,
            [userId],
          )
        ).rows[0];
        if (!recorded || recorded.sourceDigest !== evidence.sourceDigest || recorded.evidenceDigest !== evidenceDigest)
          throw conflict("The legacy owner source conflicts with the recorded migration");
        const credential = (
          await client.query<{ password: string | null; legacyPasswordMd5: string | null; legacyPasswordSalt: string | null; legacyPasswordVersion: string | null }>(
            `SELECT "password","legacyPasswordMd5","legacyPasswordSalt","legacyPasswordVersion"
               FROM "zzsh_auth_user"."account" WHERE "userId"=$1 AND "providerId"='credential'`,
            [userId],
          )
        ).rows[0];
        if (evidence.legacyPassword) {
          if (
            !credential ||
            credential.password !== null ||
            credential.legacyPasswordMd5 !== evidence.legacyPassword.md5 ||
            credential.legacyPasswordSalt !== evidence.legacyPassword.salt ||
            credential.legacyPasswordVersion !== evidence.legacyPassword.version
          )
            throw conflict("The legacy owner credential conflicts with the supplied evidence");
        } else if (credential) {
          throw conflict("The legacy owner unexpectedly has a local credential");
        }
        return { status: 200, body: { userId } };
      }
      const now = new Date();
      await client.query(
        `INSERT INTO "zzsh_auth_user"."user" ("id","name","email","emailVerified","createdAt","updatedAt","phoneNumber","phoneNumberVerified","suspended")
         VALUES ($1,$2,$3,false,$4,$4,$5,false,false)`,
        [userId, evidence.nickname, email, now, phoneNumber],
      );
      if (evidence.legacyPassword) {
        await client.query(
          `INSERT INTO "zzsh_auth_user"."account" ("id","accountId","providerId","userId","password","legacyPasswordMd5","legacyPasswordSalt","legacyPasswordVersion","createdAt","updatedAt")
           VALUES ($1,$2,'credential',$2,NULL,$3,$4,$5,$6,$6)`,
          [
            `account_${randomUUID().replaceAll("-", "")}`,
            userId,
            evidence.legacyPassword.md5,
            evidence.legacyPassword.salt,
            evidence.legacyPassword.version,
            now,
          ],
        );
      }
      await client.query(
        `INSERT INTO "zzsh_iam"."user_identity_state"
           ("user_id","account_status","identity_status","age_status","provider","provider_reference","verified_at","version","updated_at")
         VALUES ($1,$2,$3,$4,$5,$6,NULL,1,$7)`,
        [userId, status.accountStatus, status.identityStatus, status.ageStatus, MIGRATED_PROVIDER, providerReference, now],
      );
      await recordAudit(client, {
        actorType: "admin",
        actorId: actor.id,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        action: "user.legacy_owner.migrated",
        objectType: "user",
        objectId: userId,
        outcome: "SUCCESS",
        reason: "按受限来源证据迁移旧用户状态与凭据事实；未做新渠道核验，未补造资格",
        details: {
          sourceSystem: evidence.sourceSystem,
          sourceEntity: evidence.sourceEntity,
          legacyId: evidence.legacyId,
          sourceDigest: evidence.sourceDigest,
          evidenceDigest,
          evidenceRef: evidence.evidenceRef,
          sourceCreatedAt: evidence.sourceCreatedAt,
          sourceUpdatedAt: evidence.sourceUpdatedAt,
          provider: MIGRATED_PROVIDER,
          providerReference,
          status: evidence.status,
          hasLegacyPassword: Boolean(evidence.legacyPassword),
          legacyPasswordVersion: evidence.legacyPassword?.version ?? null,
          phoneNumberVerified: false,
          result: "MIGRATED",
        },
      });
      return { status: 200, body: { userId } };
    },
  );
  return { userId: (result.body as { userId: string }).userId, replayed: result.replayed };
}
