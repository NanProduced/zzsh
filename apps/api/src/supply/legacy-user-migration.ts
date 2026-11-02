import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../auth/security-core";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";

import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit, setAuditContext } from "../auth/security-core";
import { ensureInitialProfileAvatar } from "../profile/profile-avatar";
import { canonicalize } from "./content-hash";
import { normalizeMainlandPhone } from "../auth/phone-number";
import { lockLegacySource } from "./legacy-observation";
import { parseLegacyContactProjection, type LegacyContactProjection } from "../legacy-load/legacy-contact-projection";
import {
  conflict,
  forbidden,
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
  mobile: string | null;
  /** Only a reviewed whole-source projection may separate contact from authentication. V1 remains unchanged. */
  contactProjection?: LegacyContactProjection;
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
  const status = normalizeStatus(value.status);
  const projected = value.contactProjection === undefined ? undefined : parseLegacyContactProjection(value.contactProjection, {
    legacyId: String(value.legacyId), sourceDigest: String(value.sourceDigest),
    mobile: value.mobile === null || value.mobile === "" ? null : normalizeMobile(value.mobile), deleted: status.deleted, disabled: status.disabled,
  });
  if (projected && (value.sourceSystem !== MIGRATED_PROVIDER || value.sourceEntity !== "la_user")) throw invalid("Legacy contact projection source is not supported");
  return {
    sourceSystem: String(value.sourceSystem),
    sourceEntity: String(value.sourceEntity),
    legacyId: String(value.legacyId),
    sourceDigest: String(value.sourceDigest),
    evidenceRef: String(value.evidenceRef),
    nickname,
    mobile: projected ? value.mobile === null || value.mobile === "" ? null : normalizeMobile(value.mobile) : normalizeMobile(value.mobile),
    ...(projected ? { contactProjection: projected } : {}),
    sourceCreatedAt: normalizeTimestamp(value.sourceCreatedAt),
    sourceUpdatedAt: normalizeTimestamp(value.sourceUpdatedAt),
    status,
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

export function legacyOwnerMigrationKey(evidence: Pick<LegacyOwnerEvidence, "sourceSystem" | "sourceEntity" | "legacyId">) {
  return sha256Hex(JSON.stringify([OPERATION_MIGRATE, evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId]));
}

export function legacyOwnerContactCorrectionKey(evidence: Pick<LegacyOwnerEvidence, "sourceSystem" | "sourceEntity" | "legacyId">) {
  return sha256Hex(JSON.stringify(["supply.legacy.contact-projection", evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId]));
}

function derivedStatusValues(status: LegacyOwnerStatusEvidence): { accountStatus: string; identityStatus: string; ageStatus: string } {
  return {
    accountStatus: status.deleted ? "CANCELLED" : status.disabled ? "FROZEN" : "ACTIVE",
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

async function authorizeLegacyContactMigrationAdmin(client: PoolClient, actor: LegacyOwnerMigrationActor, lock = false) {
  if (lock) await assertAdminCommandAuthorizedInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  else await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  const access = await loadEffectiveAdminAccess(client, actor.id);
  requirePermission(access, "supply.catalog.manage");
  if (!access?.isBoss || access.status !== "ACTIVE" || access.passwordChangeRequired) throw forbidden("Active Boss required for legacy authentication projection");
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
  const idempotencyKey = legacyOwnerMigrationKey(evidence);
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: actor.id, operation: OPERATION_MIGRATE },
    idempotencyKey,
    fingerprintRequest(OPERATION_MIGRATE, undefined, evidence),
    async () => {
      await authorizeLegacyMigrationAdmin(client, actor);
      if (evidence.contactProjection) await authorizeLegacyContactMigrationAdmin(client, actor, true);
    },
    async () => {
      await lockLegacySource(client, evidence);
      const userId = legacyOwnerUserId(evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId);
      const projection = evidence.contactProjection;
      const phoneNumber = projection ? projection.authenticationPhone : `+86${evidence.mobile}`;
      const email = projection ? `legacy-${sha256Hex(userId)}@phone.zzsh.invalid` : `phone-${sha256Hex(phoneNumber!)}@phone.zzsh.invalid`;
      const providerReference = `${evidence.sourceEntity}:${evidence.legacyId}`;
      const existing = (await client.query<{ id: string; name: string; email: string; phoneNumber: string | null; phoneNumberVerified: boolean; suspended: boolean; username?: string | null }>(
        projection
          ? `SELECT "id","name","email","phoneNumber","phoneNumberVerified","suspended","username" FROM "zzsh_auth_user"."user" WHERE "id"=$1 OR ($2::text IS NOT NULL AND "phoneNumber"=$2) OR "username"=$3 FOR UPDATE`
          : `SELECT "id","name","email","phoneNumber","phoneNumberVerified","suspended" FROM "zzsh_auth_user"."user" WHERE "id"=$1 OR "phoneNumber"=$2 FOR UPDATE`,
        projection ? [userId, phoneNumber, projection.sourceSn] : [userId, phoneNumber],
      )).rows;
      if (existing.length > 0) {
        const row = existing[0]!;
        const userMatches =
          existing.length === 1 &&
          row.id === userId &&
          row.name === evidence.nickname &&
          row.email === email &&
          row.phoneNumber === phoneNumber &&
          (!projection || row.username === projection.sourceSn) &&
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
          await client.query<{ id: string; password: string | null; legacyPasswordMd5: string | null; legacyPasswordSalt: string | null; legacyPasswordVersion: string | null; legacyPasswordUpgradedAt: string | null }>(
            `SELECT "id","password","legacyPasswordMd5","legacyPasswordSalt","legacyPasswordVersion","legacyPasswordUpgradedAt"
               FROM "zzsh_auth_user"."account" WHERE "userId"=$1 AND "providerId"='credential'`,
            [userId],
          )
        ).rows[0];
        if (evidence.legacyPassword) {
          const upgradedInPlace = credential !== undefined
            && credential.password !== null
            && credential.legacyPasswordMd5 === null
            && credential.legacyPasswordVersion === null
            && credential.legacyPasswordSalt === null
            && credential.legacyPasswordUpgradedAt !== null;
          const compatible = credential !== undefined && (upgradedInPlace
            ? (await client.query(
                `SELECT 1 FROM "zzsh_iam"."audit_event"
                  WHERE "object_id"=$1 AND "object_type"='auth_account' AND "actor_type"='user' AND "actor_id"=$2
                    AND "action"='user.legacy_password.upgraded' AND "outcome"='SUCCESS' LIMIT 1`,
                [credential.id, userId],
              )).rowCount === 1
            : credential.password === null
              && credential.legacyPasswordMd5 === evidence.legacyPassword.md5
              && credential.legacyPasswordSalt === evidence.legacyPassword.salt
              && credential.legacyPasswordVersion === evidence.legacyPassword.version);
          if (!compatible) throw conflict("The legacy owner credential conflicts with the supplied evidence");
        } else if (credential) {
          throw conflict("The legacy owner unexpectedly has a local credential");
        }
        return { status: 200, body: { userId } };
      }
      const now = new Date();
      await client.query(projection
        ? `INSERT INTO "zzsh_auth_user"."user" ("id","name","email","emailVerified","createdAt","updatedAt","phoneNumber","phoneNumberVerified","suspended","username","displayUsername") VALUES ($1,$2,$3,false,$4,$4,$5,false,false,$6,$6)`
        : `INSERT INTO "zzsh_auth_user"."user" ("id","name","email","emailVerified","createdAt","updatedAt","phoneNumber","phoneNumberVerified","suspended") VALUES ($1,$2,$3,false,$4,$4,$5,false,false)`,
        projection ? [userId, evidence.nickname, email, now, phoneNumber, projection.sourceSn] : [userId, evidence.nickname, email, now, phoneNumber]);
      await ensureInitialProfileAvatar(client, "user", userId, actor.requestId);
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
          ...(projection ? { contactProjection: { ...projection, authenticationPhone: undefined, authenticationPhoneBound: phoneNumber !== null } } : {}),
          result: "MIGRATED",
        },
      });
      return { status: 200, body: { userId } };
    },
  );
  return { userId: (result.body as { userId: string }).userId, replayed: result.replayed };
}

export type LegacyOwnerContactTarget = {
  id: string; username: string | null; displayUsername: string | null; phoneNumber: string | null; phoneNumberVerified: boolean | null;
  email: string; suspended: boolean; updatedAt: string;
  accountStatus: string; identityStatus: string; ageStatus: string; identityVersion: string;
  provider: string; providerReference: string; migrationSourceDigest: string | null; migrationLegacyId: string | null;
};

export function legacyOwnerContactTargetDigest(target: LegacyOwnerContactTarget): string {
  return sha256Hex(canonicalize(target));
}

/** Maintenance-only fresh CAS input. Contact values stay in the private execution package, not public reports. */
export async function readLegacyOwnerContactTarget(client: PoolClient, userId: string, actor: LegacyOwnerMigrationActor, lock = false): Promise<LegacyOwnerContactTarget> {
  const row = (await readLegacyOwnerContactTargets(client, [userId], actor, lock))[0];
  if (!row) throw conflict("Legacy contact target is not present");
  return row;
}

export async function readLegacyOwnerContactTargets(client: PoolClient, userIds: readonly string[], actor: LegacyOwnerMigrationActor, lock = false): Promise<LegacyOwnerContactTarget[]> {
  if (!userIds.length || userIds.length > 1000 || userIds.some(id => typeof id !== "string" || !ID_PATTERN.test(id)) || new Set(userIds).size !== userIds.length) throw invalid("Bounded exact legacy contact targets required");
  await authorizeLegacyContactMigrationAdmin(client, actor, lock);
  return (await client.query<LegacyOwnerContactTarget>(`SELECT u.id,u.username,u."phoneNumber",u."phoneNumberVerified",u."displayUsername",u.email,u.suspended,
      to_char(u."updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
      i.account_status AS "accountStatus",i.identity_status AS "identityStatus",i.age_status AS "ageStatus",i.version::text AS "identityVersion",
      i.provider,i.provider_reference AS "providerReference",a.details->>'sourceDigest' AS "migrationSourceDigest",a.details->>'legacyId' AS "migrationLegacyId"
    FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state i ON i.user_id=u.id
    LEFT JOIN LATERAL (SELECT details FROM zzsh_iam.audit_event WHERE object_id=u.id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
      AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' ORDER BY occurred_at DESC LIMIT 1) a ON true
    WHERE u.id=ANY($1::text[]) ORDER BY u.id${lock ? " FOR UPDATE OF u,i" : ""}`, [userIds])).rows;
}

export type LegacyOwnerContactCorrectionInput = LegacyOwnerMigrationInput & { expectedTargetDigest: string };

export type LegacyOwnerNumberInput = {
  sourceSystem: "legacy_mysql_restore"; sourceEntity: "la_user"; legacyId: string;
  sourceDigest: string; sourceSn: string; expectedTargetDigest: string;
};

export function legacyOwnerNumberBindingKey(input: Pick<LegacyOwnerNumberInput, "sourceSystem" | "sourceEntity" | "legacyId">) {
  return sha256Hex(JSON.stringify(["supply.legacy.number-bind", input.sourceSystem, input.sourceEntity, input.legacyId]));
}

/** Source SN is an authentication alias, never a guess at the internal source UID. */
export async function bindLegacyOwnerNumber(client: PoolClient, input: LegacyOwnerNumberInput, actor: LegacyOwnerMigrationActor) {
  if (!input || Object.keys(input).sort().join(",") !== "expectedTargetDigest,legacyId,sourceDigest,sourceEntity,sourceSn,sourceSystem"
    || input.sourceSystem !== MIGRATED_PROVIDER || input.sourceEntity !== "la_user" || !/^[1-9]\d{0,23}$/.test(input.legacyId)
    || !DIGEST_PATTERN.test(input.sourceDigest) || !DIGEST_PATTERN.test(input.expectedTargetDigest)
    || typeof input.sourceSn !== "string" || !input.sourceSn.length || input.sourceSn.length > 128 || /[\x00-\x1f\x7f]/.test(input.sourceSn)) throw invalid("Exact reviewed legacy number and fresh target required");
  const userId = legacyOwnerUserId(input.sourceSystem, input.sourceEntity, input.legacyId), operation = "supply.legacy.number-bind";
  return withIdempotency(client, { realm: "admin", principalId: actor.id, operation, resourceId: userId }, legacyOwnerNumberBindingKey(input),
    fingerprintRequest(operation, userId, input), () => authorizeLegacyContactMigrationAdmin(client, actor, true), async () => {
      await lockLegacySource(client, input);
      const current = await readLegacyOwnerContactTarget(client, userId, actor, true);
      if (legacyOwnerContactTargetDigest(current) !== input.expectedTargetDigest || current.migrationSourceDigest !== input.sourceDigest || current.migrationLegacyId !== input.legacyId) throw conflict("Legacy number source or target changed");
      if (current.username !== null && current.username !== input.sourceSn || current.displayUsername !== null && current.displayUsername !== input.sourceSn) throw conflict("Current username is not the reviewed legacy number");
      const occupied = (await client.query("SELECT id FROM zzsh_auth_user.\"user\" WHERE id<>$1 AND username=$2 FOR UPDATE", [userId, input.sourceSn])).rows;
      if (occupied.length) throw conflict("Legacy public number is occupied by another identity");
      await setAuditContext(client, "admin", actor.id, actor.sessionId, actor.requestId);
      const updated = await client.query(`UPDATE zzsh_auth_user."user" SET username=$2,"displayUsername"=$2,"updatedAt"=clock_timestamp()
        WHERE id=$1 AND "updatedAt"=$3::timestamptz AND username IS NOT DISTINCT FROM $4::text`, [userId, input.sourceSn, current.updatedAt, current.username]);
      if (updated.rowCount !== 1) throw conflict("Legacy number compare-and-set failed");
      await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId: actor.requestId,
        action: "user.legacy_number.bound", objectType: "user", objectId: userId, outcome: "SUCCESS",
        reason: "按原来源摘要绑定旧公开编号；联系方式、凭据、身份状态和资金不变", details: {
          sourceSystem: input.sourceSystem, sourceEntity: input.sourceEntity, legacyId: input.legacyId, sourceDigest: input.sourceDigest, sourceSn: input.sourceSn,
          originalTargetDigest: input.expectedTargetDigest, beforeUsername: current.username, authenticationPhoneUnchanged: true,
          identityAndCredentialUnchanged: true, financialEffects: false,
        } });
      return { status: 200, body: { userId, sourceSn: input.sourceSn, sourceDigest: input.sourceDigest, financialEffects: false } };
    });
}

/** Corrects only authentication projection after reviewed source planning; business identity and money do not move. */
export async function reconcileLegacyOwnerContactProjection(client: PoolClient, input: LegacyOwnerContactCorrectionInput, actor: LegacyOwnerMigrationActor) {
  if (!input || Object.keys(input).sort().join(",") !== "evidence,evidenceDigest,expectedTargetDigest" || !DIGEST_PATTERN.test(input.expectedTargetDigest)) throw invalid("Fresh contact target CAS required");
  const normalized = normalizeLegacyOwnerInput({ evidence: input.evidence, evidenceDigest: input.evidenceDigest });
  const e = normalized.evidence, projection = e.contactProjection;
  if (!projection) throw invalid("Contact-aware source contract required");
  const userId = legacyOwnerUserId(e.sourceSystem, e.sourceEntity, e.legacyId);
  const operation = "supply.legacy.contact-projection";
  const key = legacyOwnerContactCorrectionKey(e);
  return withIdempotency(client, { realm: "admin", principalId: actor.id, operation, resourceId: userId }, key,
    fingerprintRequest(operation, userId, input), async () => { await authorizeLegacyContactMigrationAdmin(client, actor, true); }, async () => {
      await lockLegacySource(client, e);
      const current = await readLegacyOwnerContactTarget(client, userId, actor, true);
      if (legacyOwnerContactTargetDigest(current) !== input.expectedTargetDigest) throw conflict("Legacy contact target changed after fresh read");
      const status = derivedStatusValues(e.status);
      if (current.provider !== MIGRATED_PROVIDER || current.providerReference !== `${e.sourceEntity}:${e.legacyId}` || current.migrationSourceDigest !== e.sourceDigest || current.migrationLegacyId !== e.legacyId
        || current.accountStatus !== status.accountStatus || current.identityStatus !== status.identityStatus || current.ageStatus !== status.ageStatus || current.suspended)
        throw conflict("Legacy contact source identity or state changed");
      if (current.phoneNumberVerified === true) throw conflict("Verified current contact cannot be replaced by legacy projection");
      if (current.username !== null && current.username !== projection.sourceSn || current.displayUsername !== null && current.displayUsername !== projection.sourceSn) throw conflict("Current username is not the reviewed legacy number");
      const sourcePhone = e.mobile === null ? null : normalizeMainlandPhone(e.mobile);
      if (current.phoneNumber !== null && current.phoneNumber !== sourcePhone) throw conflict("Current contact no longer matches the frozen source");
      // A freeze is never an opportunity to hand a phone to another ACTIVE identity.
      if (current.accountStatus === "FROZEN" && current.phoneNumber !== projection.authenticationPhone) throw conflict("Frozen legacy authentication contact requires separate review");
      const occupied = (await client.query<{ id: string }>(`SELECT id FROM zzsh_auth_user."user" WHERE id<>$1 AND (username=$2 OR ($3::text IS NOT NULL AND "phoneNumber"=$3)) FOR UPDATE`, [userId, projection.sourceSn, projection.authenticationPhone])).rows;
      if (occupied.length) throw conflict("Reviewed legacy authentication projection is occupied by another identity");
      await setAuditContext(client, "admin", actor.id, actor.sessionId, actor.requestId);
      const update = await client.query(`UPDATE zzsh_auth_user."user" SET "phoneNumber"=$2,"phoneNumberVerified"=false,username=$3,"displayUsername"=$3,"updatedAt"=clock_timestamp()
        WHERE id=$1 AND "updatedAt"=$4::timestamptz AND username IS NOT DISTINCT FROM $5::text AND "phoneNumber" IS NOT DISTINCT FROM $6::text AND "phoneNumberVerified" IS NOT DISTINCT FROM $7::boolean`,
        [userId, projection.authenticationPhone, projection.sourceSn, current.updatedAt, current.username, current.phoneNumber, current.phoneNumberVerified]);
      if (update.rowCount !== 1) throw conflict("Legacy contact compare-and-set failed");
      await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId: actor.requestId,
        action: "user.legacy_contact.projected", objectType: "user", objectId: userId, outcome: "SUCCESS",
        reason: "旧业务主体与认证联系方式分离；原状态、原凭据和资金关系不变", details: {
          sourceSystem: e.sourceSystem, sourceEntity: e.sourceEntity, legacyId: e.legacyId, sourceDigest: e.sourceDigest,
          sourceContactRef: projection.sourceContactRef, sourceContactDigest: projection.sourceContactDigest, groupDigest: projection.groupDigest,
          decision: projection.decision, sourceSn: projection.sourceSn, originalTargetDigest: input.expectedTargetDigest,
          before: { authenticationPhoneBound: current.phoneNumber !== null, username: current.username, accountStatus: current.accountStatus },
          after: { authenticationPhoneBound: projection.authenticationPhone !== null, username: projection.sourceSn, accountStatus: current.accountStatus },
          identityAndCredentialUnchanged: true, financialEffects: false, result: "AUTHENTICATION_CONTACT_PROJECTED" } });
      return { status: 200, body: { userId, sourceDigest: e.sourceDigest, projectionDigest: sha256Hex(canonicalize(projection)), authenticationPhoneBound: projection.authenticationPhone !== null, financialEffects: false } };
    });
}
