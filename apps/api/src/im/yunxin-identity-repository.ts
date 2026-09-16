import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

import {
  ImIdentityInvariantError,
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  normalizeImIdentityKey,
  type ImIdentityIntent,
  type ImIdentityQueryExecutor,
  type ImIdentityKey,
  type ImIdentityMapping,
  type ImIdentityMutation,
  type ImIdentityRepository,
  type ImIdentityStatus,
  type ImProvisionClaim,
  type ImProvisionFailure,
} from "./identity-lifecycle";

const TABLE = '"zzsh_iam"."im_identity_mapping"';
const SELECT_COLUMNS = `
  "id", "provider", "app_id" AS "appId", "realm", "identity_kind" AS "identityKind",
  "platform_subject_id" AS "platformSubjectId", "account_id" AS "accountId",
  "identity_marker" AS "identityMarker", "status", "version", "attempt_count" AS "attemptCount",
  "attempt_lease_until" AS "attemptLeaseUntil", "next_retry_at" AS "nextRetryAt",
  "last_failure_class" AS "lastFailureClass", "last_failure_provider_code" AS "lastFailureProviderCode"`;

type DbRow = {
  id: string;
  provider: string;
  appId: string;
  realm: string;
  identityKind: string;
  platformSubjectId: string;
  accountId: string;
  identityMarker: string;
  status: string;
  version: number | string;
  attemptCount: number | string;
  attemptLeaseUntil: Date | string | null;
  nextRetryAt: Date | string | null;
  lastFailureClass: string | null;
  lastFailureProviderCode: number | string | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function integer(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ImIdentityInvariantError();
  return parsed;
}

function isoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ImIdentityInvariantError();
  return new Date(parsed).toISOString();
}

function status(value: string): ImIdentityStatus {
  if (value === "PENDING" || value === "READY" || value === "FAILED_PERMANENT" || value === "DISABLED" || value === "REVOKED") {
    return value;
  }
  throw new ImIdentityInvariantError();
}

function failureClass(value: string): ImProvisionFailure["class"] {
  if (value === "UNKNOWN_RESULT" || value === "TRANSIENT_PROVIDER" || value === "PERMANENT_PROVIDER" || value === "ACCOUNT_OWNERSHIP_CONFLICT") {
    return value;
  }
  throw new ImIdentityInvariantError();
}

function mapRow(row: DbRow): ImIdentityMapping {
  if (row.provider !== "yunxin" || !row.id || !row.appId || !row.realm || !row.identityKind || !row.platformSubjectId || !row.accountId || !row.identityMarker) {
    throw new ImIdentityInvariantError();
  }
  if (row.identityKind !== "USER" && row.identityKind !== "ADMIN" && row.identityKind !== "SYSTEM") {
    throw new ImIdentityInvariantError();
  }
  const key = normalizeImIdentityKey({
    provider: "yunxin",
    appId: row.appId,
    realm: row.realm,
    kind: row.identityKind,
    platformSubjectId: row.platformSubjectId,
  });
  const lastFailure = row.lastFailureClass === null
    ? null
    : {
        class: failureClass(row.lastFailureClass),
        providerCode: row.lastFailureProviderCode === null ? null : integer(row.lastFailureProviderCode),
      };
  return {
    id: row.id,
    key,
    accountId: row.accountId,
    identityMarker: row.identityMarker,
    status: status(row.status),
    version: integer(row.version),
    attemptCount: integer(row.attemptCount),
    attemptLeaseUntil: isoDate(row.attemptLeaseUntil),
    nextRetryAt: isoDate(row.nextRetryAt),
    lastFailure,
  };
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

function assertIntent(intent: ImIdentityIntent): ImIdentityKey {
  const key = normalizeImIdentityKey(intent.key);
  if (intent.accountId !== deriveYunxinAccountId(key) || intent.identityMarker !== buildYunxinIdentityMarker(key)) {
    throw new ImIdentityInvariantError();
  }
  return key;
}

function assertRetryDelay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10 * 60 * 1_000) throw new ImIdentityInvariantError();
}

export class YunxinIdentityRepository implements ImIdentityRepository {
  constructor(private readonly pool: Pool) {}

  async ensureIntent(intent: ImIdentityIntent): Promise<ImIdentityMapping> {
    return this.ensureIntentWithExecutor({
      query: <T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]) => this.pool.query<T>(text, values),
    }, intent);
  }

  async ensureIntentInTransaction(executor: ImIdentityQueryExecutor, intent: ImIdentityIntent): Promise<ImIdentityMapping> {
    return this.ensureIntentWithExecutor(executor, intent);
  }

  private async ensureIntentWithExecutor(executor: ImIdentityQueryExecutor, intent: ImIdentityIntent): Promise<ImIdentityMapping> {
    const key = assertIntent(intent);
    const id = `im_${randomBytes(16).toString("hex")}`;
    try {
      const inserted = await executor.query<DbRow>(
        `INSERT INTO ${TABLE}
          ("id", "provider", "app_id", "realm", "identity_kind", "platform_subject_id", "account_id", "identity_marker", "status")
         VALUES ($1, 'yunxin', $2, $3, $4, $5, $6, $7, 'PENDING')
         ON CONFLICT ("provider", "app_id", "realm", "identity_kind", "platform_subject_id") DO NOTHING
         RETURNING ${SELECT_COLUMNS}`,
        [id, key.appId, key.realm, key.kind, key.platformSubjectId, intent.accountId, intent.identityMarker],
      );
      if (inserted.rows[0]) return mapRow(inserted.rows[0]);
    } catch (error) {
      if (uniqueViolation(error)) throw new ImIdentityInvariantError();
      throw error;
    }
    const existingResult = await executor.query<DbRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
        WHERE "provider" = $1 AND "app_id" = $2 AND "realm" = $3 AND "identity_kind" = $4 AND "platform_subject_id" = $5`,
      [key.provider, key.appId, key.realm, key.kind, key.platformSubjectId],
    );
    const existing = existingResult.rows[0] ? mapRow(existingResult.rows[0]) : null;
    if (!existing || existing.accountId !== intent.accountId || existing.identityMarker !== intent.identityMarker) {
      throw new ImIdentityInvariantError();
    }
    return existing;
  }

  async findByKey(input: ImIdentityKey): Promise<ImIdentityMapping | null> {
    const key = normalizeImIdentityKey(input);
    const result = await this.pool.query<DbRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
        WHERE "provider" = $1 AND "app_id" = $2 AND "realm" = $3 AND "identity_kind" = $4 AND "platform_subject_id" = $5`,
      [key.provider, key.appId, key.realm, key.kind, key.platformSubjectId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listMappings(appId: string, limit = 100): Promise<ImIdentityMapping[]> {
    if (!appId || appId.length > 128 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ImIdentityInvariantError();
    const result = await this.pool.query<DbRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
        WHERE "provider" = 'yunxin' AND "app_id" = $1
        ORDER BY "updated_at" DESC, "id" DESC LIMIT $2`,
      [appId, limit],
    );
    return result.rows.map(mapRow);
  }

  async claimProvisionAttempt(input: {
    mappingId: string;
    expectedVersion: number;
    now: Date;
    leaseMs: number;
  }): Promise<ImProvisionClaim | null> {
    void input.now;
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 10 * 60 * 1_000) {
      throw new ImIdentityInvariantError();
    }
    const leaseToken = randomBytes(32).toString("base64url");
    const result = await this.pool.query<DbRow>(
      `UPDATE ${TABLE}
          SET "version" = "version" + 1,
              "attempt_count" = "attempt_count" + 1,
              "attempt_lease_until" = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              "attempt_lease_token_hash" = $3,
              "next_retry_at" = NULL,
              "updated_at" = clock_timestamp()
        WHERE "id" = $1
          AND "version" = $2
          AND "status" = 'PENDING'
          AND ("attempt_lease_until" IS NULL OR "attempt_lease_until" <= clock_timestamp())
          AND ("next_retry_at" IS NULL OR "next_retry_at" <= clock_timestamp())
      RETURNING ${SELECT_COLUMNS}`,
      [input.mappingId, input.expectedVersion, sha256(leaseToken), input.leaseMs],
    );
    return result.rows[0] ? { mapping: mapRow(result.rows[0]), leaseToken } : null;
  }

  async markReady(input: { mappingId: string; expectedVersion: number; leaseToken: string }): Promise<ImIdentityMutation> {
    return this.updateOwned(
      input,
      `"status" = 'READY', "attempt_lease_until" = NULL, "attempt_lease_token_hash" = NULL, "next_retry_at" = NULL,
       "last_failure_class" = NULL, "last_failure_provider_code" = NULL`,
    );
  }

  async markRetryableFailure(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
    failure: ImProvisionFailure;
    retryAfterMs: number;
  }): Promise<ImIdentityMutation> {
    assertRetryDelay(input.retryAfterMs);
    return this.updateOwned(
      input,
      `"next_retry_at" = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
       "last_failure_class" = $5, "last_failure_provider_code" = $6,
       "attempt_lease_until" = NULL, "attempt_lease_token_hash" = NULL`,
      [input.retryAfterMs, input.failure.class, input.failure.providerCode],
    );
  }

  async markPermanentFailure(input: {
    mappingId: string;
    expectedVersion: number;
    leaseToken: string;
    failure: ImProvisionFailure;
  }): Promise<ImIdentityMutation> {
    return this.updateOwned(
      input,
      `"status" = 'FAILED_PERMANENT', "next_retry_at" = NULL,
       "last_failure_class" = $4, "last_failure_provider_code" = $5,
       "attempt_lease_until" = NULL, "attempt_lease_token_hash" = NULL`,
      [input.failure.class, input.failure.providerCode],
    );
  }

  private async updateOwned(
    input: { mappingId: string; expectedVersion: number; leaseToken: string },
    setSql: string,
    extra: unknown[] = [],
  ): Promise<ImIdentityMutation> {
    // An expired lease may finish if no newer claim superseded it; version/hash CAS blocks stale workers after takeover.
    const result = await this.pool.query<DbRow>(
      `UPDATE ${TABLE}
          SET ${setSql}, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "id" = $1
          AND "version" = $2
          AND "status" = 'PENDING'
          AND "attempt_lease_token_hash" = $3
      RETURNING ${SELECT_COLUMNS}`,
      [input.mappingId, input.expectedVersion, sha256(input.leaseToken), ...extra],
    );
    if (result.rows[0]) return { applied: true, mapping: mapRow(result.rows[0]) };
    const current = await this.findById(input.mappingId);
    if (!current) throw new ImIdentityInvariantError();
    return { applied: false, mapping: current };
  }

  private async findById(id: string): Promise<ImIdentityMapping | null> {
    const result = await this.pool.query<DbRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE "id" = $1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}
