/**
 * message_scope_operation 作用域恢复：租约领取、失败分类、云信群对账与状态机收敛，
 * 以及 MessageScopeRecoveryLifecycle 的定时恢复循环。
 */

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
} from "../auth/admin-authorization";
import {
  assertAdminContextInTransaction,
  type AdminContext,
} from "../auth/auth-security";
import {
  recordAudit,
  SecurityApiError,
  setAuditContext,
  withTransaction,
} from "../auth/security-core";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  normalizeImIdentityKey,
  type ImIdentityProvisionInput,
  type ImIdentityKey,
  type ImProvisionResult,
} from "./identity-lifecycle";
import {
  createImScopeLease,
  onLeaseConnection,
  lockTeamBinding,
  type ScopeLease,
} from "./scope-lease";
import {
  lockDispatchGate,
  lockSupportMutation,
} from "./support-dispatch";
import { readLatestHandoverNote } from "./support-management";
import {
  YunxinApiError,
  YunxinTransportError,
  supportMarkerMatches,
  type YunxinSupportTeamExistenceLookup,
  type YunxinSupportTeamLookup,
  type YunxinSupportTeamState,
} from "./yunxin-provider";
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import {
  createHash,
  randomBytes,
} from "node:crypto";
import type { PoolClient } from "pg";
import {
  type ConsultationRouteOptions,
  type MessageScopeOperationState,
  type MessageScopeOperationType,
  SUPPORT_MANAGER_SUBJECT_ID,
  type ScopeOperationRow,
  decrementPresence,
  numberValue,
  readConsultation,
  readThreadById,
  requireSupportAccessFor,
  unavailable,
  writeEvent,
} from "./consultation-internals";

export const SCOPE_OPERATION_SELECT = `
  SELECT "id", "app_id" AS "appId", "consultation_id" AS "consultationId", "operation_type" AS "operationType",
         "state", "scope_version" AS "scopeVersion", "owner_account_id" AS "ownerAccountId",
         "user_account_id" AS "userAccountId", "previous_admin_id" AS "previousAdminId",
         "target_admin_id" AS "targetAdminId", "previous_admin_account_id" AS "previousAdminAccountId",
         "target_admin_account_id" AS "targetAdminAccountId", "provider_team_id" AS "providerTeamId",
          "attempt_count" AS "attemptCount", "lease_token_hash" AS "leaseTokenHash", "lease_until" AS "leaseUntil",
         "next_retry_at" AS "nextRetryAt",
         "last_failure_class" AS "lastFailureClass", "last_failure_detail" AS "lastFailureDetail"
    FROM "zzsh_iam"."im_consultation_scope_operation"`;

export const SCOPE_LEASE_MS = 30_000;

export const SCOPE_RETRY_BASE_MS = 5_000;

export const SCOPE_RETRY_CAP_MS = 5 * 60_000;

export const SCOPE_AUTO_ATTEMPT_LIMIT = 8;

export type ScopeOperationClaim = ScopeOperationRow & { leaseToken: string; attemptCount: number };

export type ScopeFailureClass = "IDENTITY_PENDING" | "PROVIDER_UNKNOWN" | "PROVIDER_TRANSIENT" | "REMOTE_MISMATCH" | "DB_WRITEBACK_UNKNOWN" | "STALE_OPERATION" | "REQUIRES_MANUAL_REVIEW";

export class ScopeOperationFailure extends Error {
  constructor(readonly failureClass: ScopeFailureClass, readonly detail: string, readonly manual = failureClass !== "IDENTITY_PENDING") {
    super(detail);
  }
}

export type ScopeRecoveryFailureObserver = (failureClass: ScopeFailureClass | "RECOVERY_UNEXPECTED") => void;

export function recoveryFailureClass(error: unknown): ScopeFailureClass | "RECOVERY_UNEXPECTED" {
  if (error instanceof ScopeOperationFailure) return error.failureClass;
  if (error instanceof YunxinApiError) return error.retryable ? "PROVIDER_UNKNOWN" : "REQUIRES_MANUAL_REVIEW";
  if (error instanceof YunxinTransportError) return "PROVIDER_UNKNOWN";
  return "RECOVERY_UNEXPECTED";
}

export function reportRecoveryFailure(observer: ScopeRecoveryFailureObserver | undefined, error: unknown): void {
  if (!observer) return;
  try {
    observer(recoveryFailureClass(error));
  } catch {
    // Recovery observation must not take down the worker or hide the persisted state.
  }
}

export function createScopeLease(options: ConsultationRouteOptions, claim: ScopeOperationClaim): ScopeLease {
  return createImScopeLease(options.pool, options.appId, async (db) => {
    const result = await db.query(`UPDATE zzsh_iam.im_consultation_scope_operation
      SET lease_until=clock_timestamp()+($3::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2 AND state='RUNNING' AND lease_token_hash=$4 AND lease_until>clock_timestamp() RETURNING id`,
      [options.appId,claim.id,SCOPE_LEASE_MS,scopeLeaseHash(claim.leaseToken)]);
    return result.rowCount===1;
  }, () => new ScopeOperationFailure("STALE_OPERATION", "scope lease is no longer valid", true));
}

export function scopeOperationId(): string {
  return `im_scope_op_${randomBytes(16).toString("hex")}`;
}

/** 用户结束本轮的操作 id 由客户端 operationId 派生，同输入重放命中同一行。 */
export function userCloseOperationId(appId: string, userId: string, operationId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([appId, userId, operationId]), "utf8").digest("hex");
  return `im_scope_op_${digest.slice(0, 32)}`;
}

export function scopeLeaseHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function scopeOperationState(value: string): MessageScopeOperationState {
  if (value === "PENDING" || value === "RUNNING" || value === "UNKNOWN" || value === "SUCCEEDED" || value === "FAILED" || value === "NEEDS_REVIEW") return value;
  throw new Error("IM scope operation state is invalid");
}

export function scopeOperationRow(row: ScopeOperationRow): ScopeOperationRow {
  return { ...row, operationType: row.operationType, state: scopeOperationState(row.state) };
}

export async function readScopeOperation(client: PoolClient, appId: string, operationId: string, lock = false): Promise<ScopeOperationRow> {
  const result = await client.query<ScopeOperationRow>(`${SCOPE_OPERATION_SELECT} WHERE "app_id" = $1 AND "id" = $2${lock ? " FOR UPDATE" : ""}`, [appId, operationId]);
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "IM scope operation not found");
  return scopeOperationRow(row);
}

export function supportBotAccountId(options: ConsultationRouteOptions): string | null {
  return options.supportManager ? deriveYunxinAccountId(options.supportManager.key) : null;
}

export function supportManagerAccount(options: ConsultationRouteOptions): { key: ImIdentityKey; accountId: string } {
  if (!options.supportManager) throw unavailable("IM support manager is not configured");
  const key = normalizeImIdentityKey(options.supportManager.key);
  if (key.appId !== options.appId || key.realm !== "system" || key.kind !== "SYSTEM" || key.platformSubjectId !== SUPPORT_MANAGER_SUBJECT_ID) {
    throw new Error("IM support manager identity is invalid");
  }
  return { key, accountId: deriveYunxinAccountId(key) };
}

export async function ensureSupportManager(options: ConsultationRouteOptions): Promise<string | null> {
  const manager = supportManagerAccount(options);
  const input: ImIdentityProvisionInput = { key: manager.key, displayName: "洲洲助手（Bot）", ...(options.supportManager?.avatarUrl ? { avatar: options.supportManager.avatarUrl } : {}) };
  const result: ImProvisionResult = await options.supportManager!.provisioner.ensure(input);
  if (result.mapping.accountId !== manager.accountId
    || result.mapping.key.appId !== manager.key.appId
    || result.mapping.key.realm !== manager.key.realm
    || result.mapping.key.kind !== manager.key.kind
    || result.mapping.key.platformSubjectId !== manager.key.platformSubjectId
    || result.mapping.identityMarker !== buildYunxinIdentityMarker(manager.key)) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "IM support manager identity mismatch", true);
  }
  if (result.outcome === "READY") return manager.accountId;
  if (result.outcome === "PENDING") return null;
  throw new ScopeOperationFailure("REMOTE_MISMATCH", "IM support manager is blocked", true);
}

export function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(SCOPE_RETRY_CAP_MS, SCOPE_RETRY_BASE_MS * 2 ** exponent);
}

export function providerFailure(error: unknown): ScopeOperationFailure {
  if (error instanceof ScopeOperationFailure) return error;
  if (error instanceof YunxinApiError) {
    return new ScopeOperationFailure(error.retryable ? "PROVIDER_UNKNOWN" : "REQUIRES_MANUAL_REVIEW", `yunxin:${error.operation}`, true);
  }
  if (error instanceof YunxinTransportError) return new ScopeOperationFailure("PROVIDER_UNKNOWN", `yunxin:${error.operation}`, true);
  return new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "scope operation writeback is unknown", true);
}

export function remoteActionMayStillBeInFlight(failureClass: string | null): boolean {
  // ponytail: without a provider idempotency/result fence, every non-identity failure stays fail-closed.
  return failureClass !== "IDENTITY_PENDING";
}

export function exactMembers(team: YunxinSupportTeamState, required: string[]): boolean {
  if (team.memberAccountIds.length !== required.length) return false;
  const expected = new Set(required);
  return team.memberAccountIds.every((accountId) => expected.has(accountId));
}

export function allowedMembers(team: YunxinSupportTeamState, allowed: string[]): boolean {
  const expected = new Set(allowed);
  return team.memberAccountIds.every((accountId) => expected.has(accountId));
}

/**
 * Thread-scoped Team creation. The operation carries no target agent: the Team
 * starts with the server manager as owner and the user as member; agents are
 * added per-claim. The operation row is what makes a provider create
 * recoverable without ever creating a second Team.
 */
export async function beginThreadTeamProvision(
  options: ConsultationRouteOptions,
  threadId: string,
  roundId: string,
): Promise<{ operationId: string } | null> {
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  const manager = supportManagerAccount(options);
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const thread = await readThreadById(client, options.appId, threadId, true);
    const row = await readConsultation(client, options.appId, roundId, true);
    if (row.threadId !== threadId) return null;
    if (thread.messageScopeState === "READY" && thread.messageScopeId) {
      // The Team already exists: copy it onto the open round instead of creating another.
      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_id" = $3, "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" <> 'CLOSED'
            AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)
            AND "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')`,
        [options.appId, roundId, thread.messageScopeId],
      );
      return null;
    }
    if (row.state === "CLOSED") return null;
    const active = (await client.query<{ id: string }>(
      `SELECT o."id" FROM "zzsh_iam"."im_consultation_scope_operation" o
         JOIN "zzsh_iam"."im_consultation" c ON c."id" = o."consultation_id"
        WHERE c."app_id" = $1 AND c."thread_id" = $2 AND o."operation_type" = 'CREATE'
          AND o."state" IN ('PENDING', 'RUNNING', 'UNKNOWN')
        LIMIT 1 FOR UPDATE OF o`,
      [options.appId, threadId],
    )).rows[0];
    if (active) return null;
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "message_scope_state" = 'PROVISIONING', "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" IN ('PENDING', 'FAILED')`,
      [options.appId, threadId],
    );
    let scopeVersion = numberValue(row.messageScopeVersion);
    if (row.messageScopeId === null && (row.messageScopeState === "PENDING" || row.messageScopeState === "FAILED")) {
      const updated = await client.query<{ messageScopeVersion: string | number }>(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = 'PROVISIONING', "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" <> 'CLOSED'
            AND "message_scope_state" IN ('PENDING', 'FAILED') AND "message_scope_id" IS NULL
          RETURNING "message_scope_version" AS "messageScopeVersion"`,
        [options.appId, roundId],
      );
      if (updated.rowCount === 1 && updated.rows[0]) scopeVersion = numberValue(updated.rows[0].messageScopeVersion);
    }
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'CREATE',$4,$5,$6,$7)`,
      [operationId, options.appId, roundId, scopeVersion, manager.accountId, thread.userAccountId, thread.messageScopeId],
    );
    return { operationId };
  });
}

export async function claimScopeOperation(options: ConsultationRouteOptions, operationId: string): Promise<ScopeOperationClaim | null> {
  const leaseToken = randomBytes(32).toString("base64url");
  const result = await options.pool.query<ScopeOperationRow>(
    `UPDATE "zzsh_iam"."im_consultation_scope_operation"
        SET "state" = 'RUNNING', "attempt_count" = "attempt_count" + 1,
            "lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
            "lease_token_hash" = $4, "last_failure_class" = NULL,
            "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "id" = $2
        AND (
          ("state" = 'PENDING' AND "next_retry_at" <= clock_timestamp())
          OR ("state" = 'UNKNOWN' AND "last_failure_class" = 'IDENTITY_PENDING'
              AND "next_retry_at" <= clock_timestamp())
        )
      RETURNING "id", "app_id" AS "appId", "consultation_id" AS "consultationId", "operation_type" AS "operationType",
                "state", "scope_version" AS "scopeVersion", "owner_account_id" AS "ownerAccountId",
                "user_account_id" AS "userAccountId", "previous_admin_id" AS "previousAdminId",
                "target_admin_id" AS "targetAdminId", "previous_admin_account_id" AS "previousAdminAccountId",
                "target_admin_account_id" AS "targetAdminAccountId", "provider_team_id" AS "providerTeamId",
                "attempt_count" AS "attemptCount", "lease_token_hash" AS "leaseTokenHash", "lease_until" AS "leaseUntil",
                "next_retry_at" AS "nextRetryAt",
                "last_failure_class" AS "lastFailureClass", "last_failure_detail" AS "lastFailureDetail"`,
    [options.appId, operationId, SCOPE_LEASE_MS, scopeLeaseHash(leaseToken)],
  );
  const row = result.rows[0];
  return row ? { ...scopeOperationRow(row), leaseToken, attemptCount: numberValue(row.attemptCount) } : null;
}

export async function settleScopeOperationFailure(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  failure: ScopeOperationFailure,
): Promise<"RETRYING" | "NEEDS_REVIEW"> {
  const needsReview = failure.manual || remoteActionMayStillBeInFlight(failure.failureClass) || claim.attemptCount >= SCOPE_AUTO_ATTEMPT_LIMIT;
  const nextState: MessageScopeOperationState = needsReview ? "NEEDS_REVIEW" : "UNKNOWN";
  await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = $3, "next_retry_at" = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              "lease_until" = NULL, "lease_token_hash" = NULL,
              "last_failure_class" = $5, "last_failure_detail" = $6, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $7
            AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, nextState, needsReview ? 0 : retryDelayMs(claim.attemptCount), failure.failureClass, failure.detail.slice(0, 512), scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope lease changed before failure was recorded", true);
    // A failed claim releases the reservation it took; an already-written claim keeps its load.
    if (claim.operationType === "ADD_MEMBER" && claim.targetAdminId && row.assignedAdminId !== claim.targetAdminId) {
      await decrementPresence(client, options.appId, claim.targetAdminId);
    }
    if (needsReview) {
      const nextScopeState = "FAILED";
      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = $3, "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2
            AND "message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING')`,
        [options.appId, claim.consultationId, nextScopeState],
      );
      await client.query(
        `UPDATE "zzsh_iam"."im_support_thread" t
            SET "message_scope_state" = 'FAILED', "version" = t."version" + 1, "updated_at" = clock_timestamp()
          FROM "zzsh_iam"."im_consultation" c
         WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"
           AND t."message_scope_state" = 'PROVISIONING'`,
        [options.appId, claim.consultationId],
      );
    }
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: needsReview ? "im.scope.recovery.needs_review" : "im.scope.recovery.deferred",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "FAILURE",
      requestId: `im_scope_${claim.id}`,
      reason: failure.failureClass,
      details: { operationType: claim.operationType, attemptCount: claim.attemptCount },
    });
  });
  return needsReview ? "NEEDS_REVIEW" : "RETRYING";
}

export async function quarantineUncertainScopeOperations(options: ConsultationRouteOptions, limit: number): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const candidates = (await client.query<{
      id: string;
      consultationId: string;
      ownerAccountId: string;
      operationType: MessageScopeOperationType;
      state: "RUNNING" | "UNKNOWN";
      lastFailureClass: string | null;
    }>(
      `SELECT "id", "consultation_id" AS "consultationId", "owner_account_id" AS "ownerAccountId",
              "operation_type" AS "operationType", "state", "last_failure_class" AS "lastFailureClass"
         FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND (
          ("state" = 'RUNNING' AND "lease_until" <= clock_timestamp())
          OR ("state" = 'UNKNOWN' AND "last_failure_class" IS DISTINCT FROM 'IDENTITY_PENDING'
              AND COALESCE("last_failure_detail", '') NOT LIKE 'remote action may still be in flight;%')
        )
        ORDER BY "next_retry_at", "updated_at", "id"
        LIMIT $2`,
      [options.appId, limit],
    )).rows;

    for (const candidate of candidates) {
      await readConsultation(client, options.appId, candidate.consultationId, true);
      const detail = "remote action may still be in flight; local lease is not provider fencing";
      const updated = candidate.state === "RUNNING"
        ? await client.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "state" = 'NEEDS_REVIEW', "next_retry_at" = clock_timestamp(),
                  "lease_until" = NULL, "lease_token_hash" = NULL,
                  "last_failure_class" = 'PROVIDER_UNKNOWN',
                  "last_failure_detail" = left($3 || COALESCE("last_failure_detail", ''), 512),
                  "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING'
              AND "lease_until" <= clock_timestamp()`,
          [options.appId, candidate.id, `${detail}; `],
        )
        : await client.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "next_retry_at" = clock_timestamp(),
                  "last_failure_class" = COALESCE("last_failure_class", 'PROVIDER_UNKNOWN'),
                  "last_failure_detail" = left($3 || COALESCE("last_failure_detail", ''), 512),
                  "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'UNKNOWN'
              AND "last_failure_class" IS DISTINCT FROM 'IDENTITY_PENDING'
              AND COALESCE("last_failure_detail", '') NOT LIKE 'remote action may still be in flight;%'`,
          [options.appId, candidate.id, `${detail}; `],
        );
      if (updated.rowCount !== 1) continue;

      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = 'FAILED', "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2
            AND "message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING')`,
        [options.appId, candidate.consultationId],
      );
      await client.query(
        `UPDATE "zzsh_iam"."im_support_thread" t
            SET "message_scope_state" = 'FAILED', "version" = t."version" + 1, "updated_at" = clock_timestamp()
          FROM "zzsh_iam"."im_consultation" c
         WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"
           AND t."message_scope_state" = 'PROVISIONING'`,
        [options.appId, candidate.consultationId],
      );
      await recordAudit(client, {
        actorType: "system",
        actorId: candidate.ownerAccountId,
        action: "im.scope.recovery.quarantined",
        objectType: "im_consultation_scope_operation",
        objectId: candidate.id,
        outcome: "FAILURE",
        requestId: `im_scope_${candidate.id}`,
        reason: candidate.state === "RUNNING" ? "PROVIDER_UNKNOWN" : candidate.lastFailureClass ?? "PROVIDER_UNKNOWN",
        details: { operationType: candidate.operationType, previousState: candidate.state, remoteFence: "unavailable" },
      });
    }
  });
}

export async function attachCreatedTeam(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string, threadId: string): Promise<boolean> {
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await lockTeamBinding(client, options.appId, teamId);
    if ((await client.query(`SELECT 1 FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2`, [options.appId,teamId])).rowCount) throw new ScopeOperationFailure("REMOTE_MISMATCH", "Team is already bound to an order", true);
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING" || operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) return false;
    if (row.threadId !== threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation thread changed before scope attach", true);
    const thread = await readThreadById(client, options.appId, threadId, true);
    // One Team per thread: a second remote create must never overwrite an existing binding.
    if (thread.messageScopeId && thread.messageScopeId !== teamId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread already has a different Team", true);
    }
    const bound = await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "message_scope_id" = $3, "message_scope_state" = 'READY',
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2
          AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)
          AND "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')`,
      [options.appId, threadId, teamId],
    );
    if (bound.rowCount !== 1 && !(thread.messageScopeId === teamId && thread.messageScopeState === "READY")) {
      throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "thread scope writeback is unknown");
    }
    if (row.state !== "CLOSED" && (row.messageScopeId === null || row.messageScopeId === teamId)
      && row.messageScopeState !== "READY") {
      const updated = await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_id" = $3, "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" <> 'CLOSED'
            AND "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')
            AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)`,
        [options.appId, claim.consultationId, teamId],
      );
      if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", `scope create writeback is unknown: state=${row.messageScopeState} scopeId=${row.messageScopeId ?? "null"} team=${teamId}`);
    }
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before completion", true);
    await recordAudit(client, { actorType: "system", actorId: claim.ownerAccountId, action: "im.scope.ready", objectType: "im_consultation_scope_operation", objectId: claim.id, outcome: "SUCCESS", requestId: `im_scope_${claim.id}` });
    return true;
  });
}

export async function rememberCreatedTeamCandidate(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string, connection: PoolClient): Promise<void> {
  await onLeaseConnection(connection, async (client) => {
    await lockDispatchGate(client, options.appId);
    await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING" || operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) {
      throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before team candidate was recorded", true);
    }
    if (operation.providerTeamId && operation.providerTeamId !== teamId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create returned multiple team IDs", true);
    }
    const recorded = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = COALESCE("provider_team_id", $3), "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING'
          AND "lease_token_hash" = $4 AND "lease_until" > clock_timestamp()` ,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (recorded.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before team candidate was recorded", true);
  });
}

export async function readAndValidateTeam(options: ConsultationRouteOptions, teamId: string, ownerAccountId: string): Promise<YunxinSupportTeamState> {
  const team = await options.provider!.getSupportTeam(teamId);
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team state is not readable");
  if (team.ownerAccountId !== ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team owner is not the server manager", true);
  return team;
}

export async function readTeamWithLease(options: ConsultationRouteOptions, lease: ScopeLease, teamId: string): Promise<YunxinSupportTeamState | null> {
  return lease.mutate(`team:${teamId}`, () => options.provider!.getSupportTeam(teamId));
}

export async function findTeamWithLease(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  input: { appId: string; consultationId: string; ownerAccountId: string },
): Promise<YunxinSupportTeamLookup> {
  return lease.mutate(`consultation:${input.consultationId}`, () => options.provider!.findSupportTeam(input));
}

export async function mutateTeamMember(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  teamId: string,
  ownerAccountId: string,
  action: () => Promise<void>,
): Promise<YunxinSupportTeamState> {
  return lease.mutate(`team:${teamId}`, async () => {
    await action();
    return readAndValidateTeam(options, teamId, ownerAccountId);
  });
}

export async function convergeCreateTeam(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  lease: ScopeLease,
  team: YunxinSupportTeamState,
  required: string[],
  threadId: string,
  markerId: string,
): Promise<void> {
  if (!allowedMembers(team, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team contains an unauthorized member", true);
  let current = team;
  for (const accountId of required) {
    if (current.memberAccountIds.includes(accountId)) continue;
    current = await mutateTeamMember(options, lease, current.teamId, claim.ownerAccountId,
      () => options.provider!.addSupportTeamMember(current.teamId, claim.ownerAccountId, accountId));
  }
  if (!exactMembers(current, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team members do not match consultation", true);
  if (supportMarkerMatches(current.serverExtension,options.appId,markerId)!==true) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation Team marker is not confirmed", true);
  if (!await attachCreatedTeam(options, claim, current.teamId, threadId)) throw new ScopeOperationFailure("STALE_OPERATION", "scope operation lost its consultation version", true);
}

export async function reconcileCreate(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner || owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create identity is inconsistent", true);
  const threadRow = (await options.pool.query<{ threadId: string | null }>(
    `SELECT "thread_id" AS "threadId" FROM "zzsh_iam"."im_consultation" WHERE "app_id" = $1 AND "id" = $2`,
    [options.appId, claim.consultationId],
  )).rows[0];
  const threadId = threadRow?.threadId;
  if (!threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create has no support thread", true);
  const targetAdminAccountId = claim.targetAdminAccountId;
  if (Boolean(targetAdminAccountId) !== Boolean(claim.targetAdminId)) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create target is inconsistent", true);
  }
  const required = targetAdminAccountId
    ? [owner, claim.userAccountId, targetAdminAccountId]
    : [owner, claim.userAccountId];
  // Legacy round-scoped operations keep their original Team marker; thread-scoped creates use the thread id.
  const markerId = targetAdminAccountId ? claim.consultationId : threadId;
  let team: YunxinSupportTeamState | null = null;
  if (claim.providerTeamId) {
    team = await readTeamWithLease(options, lease, claim.providerTeamId);
    if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "recorded support team candidate is not readable");
  }
  await lease.assertValid();
  if (!team) {
    const lookup = await findTeamWithLease(options, lease, { appId: options.appId, consultationId: markerId, ownerAccountId: owner });
    if (lookup.status === "AMBIGUOUS") throw new ScopeOperationFailure("REQUIRES_MANUAL_REVIEW", "support team cannot be uniquely located", true);
    if (lookup.status === "FOUND") team = lookup.team;
  }
  if (!team) {
    team = await lease.mutate(`consultation:${claim.consultationId}`, async (connection) => {
      const created = await options.provider!.createSupportTeam({
        appId: options.appId,
        consultationId: markerId,
        ownerAccountId: owner,
        memberAccountIds: required.filter((accountId) => accountId !== owner),
      });
      await rememberCreatedTeamCandidate(options, claim, created.teamId, connection);
      return readAndValidateTeam(options, created.teamId, owner);
    });
  }
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team state is not readable");
  await convergeCreateTeam(options, claim, lease, team, required, threadId, markerId);
}

export async function completeTransferRecovery(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId, claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before reconciliation", true);
    if (!row.threadId) throw new ScopeOperationFailure("STALE_OPERATION", "transfer has no support thread", true);
    const thread = await readThreadById(client, options.appId, row.threadId, true);
    if (thread.messageScopeId !== teamId || thread.messageScopeState !== "READY") {
      throw new ScopeOperationFailure("STALE_OPERATION", "transfer thread Team changed", true);
    }
    const projectThreadResponsible = async () => {
      await client.query(
        `UPDATE "zzsh_iam"."im_support_thread"
            SET "peer_account_id" = $3, "state" = 'ACTIVE', "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2`,
        [options.appId, thread.id, claim.targetAdminAccountId],
      );
    };
    if (row.state === "ACTIVE" && row.messageScopeState === "READY" && row.messageScopeId === teamId && row.assignedAdminId === claim.targetAdminId && row.peerAccountId === claim.targetAdminAccountId) {
      await projectThreadResponsible();
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
                "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before completion", true);
      return;
    }
    if (row.state !== "ACTIVE" || row.messageScopeState !== "TRANSFERRING" || row.messageScopeId !== teamId || row.assignedAdminId !== claim.previousAdminId || row.peerAccountId !== claim.previousAdminAccountId) {
      throw new ScopeOperationFailure("STALE_OPERATION", "transfer consultation version changed", true);
    }
    await decrementPresence(client, options.appId, claim.previousAdminId);
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "assigned_admin_id" = $3, "peer_account_id" = $4, "message_scope_state" = 'READY',
              "message_scope_version" = "message_scope_version" + 1, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" = 'TRANSFERRING'`,
      [options.appId, claim.consultationId, claim.targetAdminId, claim.targetAdminAccountId],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "transfer writeback is unknown");
    // The thread keeps the same Team; only the responsible agent reference moves.
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread" t
          SET "peer_account_id" = $3, "state" = 'ACTIVE', "version" = t."version" + 1, "updated_at" = clock_timestamp()
        FROM "zzsh_iam"."im_consultation" c
       WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"`,
      [options.appId, claim.consultationId, claim.targetAdminAccountId],
    );
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before completion", true);
    const note = claim.previousAdminId && claim.targetAdminId
      ? await readLatestHandoverNote(client, options.appId, "CONSULTATION", claim.consultationId, claim.previousAdminId, claim.targetAdminId)
      : null;
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "TRANSFERRED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: claim.previousAdminId, toAdminId: claim.targetAdminId, peerAccountId: claim.targetAdminAccountId, details: { recovered: true, ...(note ? { note } : {}) } });
    await recordAudit(client, { actorType: "system", actorId: claim.ownerAccountId, action: "im.scope.transfer.recovered", objectType: "im_consultation_scope_operation", objectId: claim.id, outcome: "SUCCESS", requestId: `im_scope_${claim.id}` });
  });
}

export async function reconcileTransfer(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !claim.providerTeamId || !claim.previousAdminAccountId || !claim.targetAdminAccountId || !claim.previousAdminId || !claim.targetAdminId) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "transfer identity is inconsistent", true);
  }
  let team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation team is missing", true);
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation owner changed", true);
  const allowed = [owner, claim.userAccountId, claim.previousAdminAccountId, claim.targetAdminAccountId];
  if (!allowedMembers(team, allowed)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation has an unauthorized member", true);
  if (!team.memberAccountIds.includes(claim.targetAdminAccountId)) {
    team = await mutateTeamMember(options, lease, team.teamId, owner,
      () => options.provider!.addSupportTeamMember(team!.teamId, owner, claim.targetAdminAccountId!));
  }
  if (team.memberAccountIds.includes(claim.previousAdminAccountId)) {
    team = await mutateTeamMember(options, lease, team.teamId, owner,
      () => options.provider!.removeSupportTeamMember(team!.teamId, owner, claim.previousAdminAccountId!));
  }
  if (!exactMembers(team, [owner, claim.userAccountId, claim.targetAdminAccountId])) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation members did not converge", true);
  }
  await completeTransferRecovery(options, claim, team.teamId);
}

export async function completeClaimRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  threadId: string,
): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "claim lease changed before reconciliation", true);
    const thread = await readThreadById(client, options.appId, threadId, true);
    if (row.threadId !== threadId) throw new ScopeOperationFailure("STALE_OPERATION", "claim thread changed", true);
    if (thread.messageScopeId !== teamId || thread.messageScopeState !== "READY") {
      throw new ScopeOperationFailure("STALE_OPERATION", "claim team is no longer bound to the thread", true);
    }
    if (!claim.targetAdminId || !claim.targetAdminAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "claim target is inconsistent", true);
    const alreadyClaimed = row.state === "ACTIVE" && row.assignedAdminId === claim.targetAdminId
      && row.peerAccountId === claim.targetAdminAccountId;
    if (!alreadyClaimed) {
      if (row.state !== "WAITING" || row.assignedAdminId !== null) {
        throw new ScopeOperationFailure("STALE_OPERATION", "claim consultation changed", true);
      }
      if (row.messageScopeId !== null && row.messageScopeId !== teamId) {
        throw new ScopeOperationFailure("STALE_OPERATION", "claim round scope changed", true);
      }
      if (row.messageScopeState !== "READY") throw new ScopeOperationFailure("STALE_OPERATION", "claim round scope is not ready", true);
      const updated = await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "state" = 'ACTIVE', "assigned_admin_id" = $3, "peer_account_id" = $4,
                "message_scope_id" = COALESCE("message_scope_id", $5), "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'WAITING' AND "assigned_admin_id" IS NULL
            AND "message_scope_state" = 'READY'`,
        [options.appId, claim.consultationId, claim.targetAdminId, claim.targetAdminAccountId, teamId],
      );
      if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "claim writeback is unknown");
      const automatic = (await client.query<{automatic:boolean}>(`SELECT EXISTS(SELECT 1 FROM zzsh_iam.audit_event
        WHERE action='im.consultation.auto_assign.requested' AND object_type='im_consultation'
          AND object_id=$1 AND request_id=$2) AS automatic`,[claim.consultationId,claim.id])).rows[0]?.automatic === true;
      await writeEvent(client, { consultationId: claim.consultationId, eventType: automatic ? "ASSIGNED" : "CLAIMED",
        actorType: automatic ? "system" : "admin", actorId: automatic ? claim.ownerAccountId : claim.targetAdminId,
        toAdminId: claim.targetAdminId, peerAccountId: claim.targetAdminAccountId, details: { threadId } });
      await recordAudit(client, { actorType: "admin", actorId: claim.targetAdminId, action: "im.consultation.claimed", objectType: "im_consultation", objectId: claim.consultationId, outcome: "SUCCESS", requestId: `im_scope_${claim.id}`, details: { threadId, roundSeq: row.roundSeq } });
    }
    // Re-applying the thread projection also repairs a crash after the round writeback.
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread"
          SET "state" = 'ACTIVE', "peer_account_id" = $3, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2`,
      [options.appId, threadId, claim.targetAdminAccountId],
    );
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "claim lease changed before completion", true);
  });
}

/** Claim adds the agent to the existing thread Team; only then does the round become ACTIVE. */
export async function reconcileAddMember(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner || owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "claim identity is inconsistent", true);
  if (!claim.providerTeamId || !claim.targetAdminId || !claim.targetAdminAccountId) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "claim operation is incomplete", true);
  }
  const threadId = await readRoundThreadId(options, claim.consultationId);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support thread Team is not readable");
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team owner changed", true);
  const required = [owner, claim.userAccountId, claim.targetAdminAccountId];
  if (!allowedMembers(team, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team contains an unauthorized member", true);
  let current = team;
  if (!current.memberAccountIds.includes(claim.targetAdminAccountId)) {
    current = await mutateTeamMember(options, lease, current.teamId, owner,
      () => options.provider!.addSupportTeamMember(current.teamId, owner, claim.targetAdminAccountId!));
  }
  if (!exactMembers(current, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team members did not converge", true);
  if (supportMarkerMatches(current.serverExtension, options.appId, threadId) !== true
    && supportMarkerMatches(current.serverExtension, options.appId, claim.consultationId) !== true) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team marker is not confirmed", true);
  }
  await completeClaimRecovery(options, claim, current.teamId, threadId);
}

export async function readRoundThreadId(options: ConsultationRouteOptions, consultationId: string): Promise<string> {
  const row = (await options.pool.query<{ threadId: string | null }>(
    `SELECT "thread_id" AS "threadId" FROM "zzsh_iam"."im_consultation" WHERE "app_id" = $1 AND "id" = $2`,
    [options.appId, consultationId],
  )).rows[0];
  if (!row?.threadId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation has no support thread", true);
  return row.threadId;
}

export async function completeCloseRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  expectedScopeState: "REVOKING" | "FAILED" = "REVOKING",
): Promise<void> {
  if (claim.appId !== options.appId || claim.operationType !== "CLOSE" || claim.providerTeamId !== teamId) {
    throw new ScopeOperationFailure("STALE_OPERATION", "close operation is not bound to this team", true);
  }
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId, claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before reconciliation", true);
    if (row.state === "CLOSED" && row.messageScopeState === "REVOKED") {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
                "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before completion", true);
      return;
    }
    const expectedScopeVersion = numberValue(claim.scopeVersion) + (expectedScopeState === "FAILED" ? 1 : 0);
    if (
      row.state !== "ACTIVE"
      || row.messageScopeState !== expectedScopeState
      || row.messageScopeId !== teamId
      || numberValue(row.messageScopeVersion) !== expectedScopeVersion
    ) {
      throw new ScopeOperationFailure("STALE_OPERATION", "close consultation version changed", true);
    }
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED', "message_scope_state" = 'REVOKED',
              "message_scope_version" = "message_scope_version" + 1, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "message_scope_state" = $3`,
      [options.appId, claim.consultationId, expectedScopeState],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "close writeback is unknown");
    await decrementPresence(client, options.appId, row.assignedAdminId);
    // Legacy CLOSE dismissed the remote Team; the thread must not pretend that history is recoverable.
    await client.query(
      `UPDATE "zzsh_iam"."im_support_thread" t
          SET "state" = 'IDLE', "peer_account_id" = NULL,
              "message_scope_id" = NULL, "message_scope_state" = 'PENDING',
              "version" = t."version" + 1, "updated_at" = clock_timestamp()
        FROM "zzsh_iam"."im_consultation" c
       WHERE c."app_id" = $1 AND c."id" = $2 AND t."id" = c."thread_id"`,
      [options.appId, claim.consultationId],
    );
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "CLOSED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: row.assignedAdminId, peerAccountId: row.peerAccountId, details: { recovered: true } });
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
              "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before completion", true);
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: expectedScopeState === "FAILED" ? "im.scope.close.reconciled" : "im.scope.close.recovered",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "SUCCESS",
      requestId: `im_scope_${claim.id}`,
      ...(expectedScopeState === "FAILED" ? { details: { providerAbsenceConfirmed: true } } : {}),
    });
  });
}

export async function readSupportTeamExistenceWithLease(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  claim: ScopeOperationClaim,
): Promise<YunxinSupportTeamExistenceLookup> {
  if (!claim.providerTeamId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close operation has no provider team", true);
  return lease.mutate(`team:${claim.providerTeamId}`, () => options.provider!.readSupportTeamExistence({
    appId: options.appId,
    consultationId: claim.consultationId,
    ownerAccountId: claim.ownerAccountId,
    teamId: claim.providerTeamId!,
  }));
}

export async function reconcileClose(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !claim.providerTeamId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close identity is inconsistent", true);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) {
    const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
    if (existence.status !== "ABSENT") {
      throw new ScopeOperationFailure(
        existence.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH",
        "support team absence could not be confirmed",
        true,
      );
    }
    await completeCloseRecovery(options, claim, claim.providerTeamId);
    return;
  }
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close team owner changed", true);
  const afterDismiss = await lease.mutate(`team:${claim.providerTeamId}`, async () => {
    await options.provider!.dismissSupportTeam(claim.providerTeamId!, owner);
    return options.provider!.readSupportTeamExistence({
      appId: options.appId,
      consultationId: claim.consultationId,
      ownerAccountId: owner,
      teamId: claim.providerTeamId!,
    });
  });
  if (afterDismiss.status !== "ABSENT") {
    throw new ScopeOperationFailure(
      afterDismiss.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH",
      "support team still exists or has the wrong identity after dismiss",
      true,
    );
  }
  await completeCloseRecovery(options, claim, claim.providerTeamId);
}

export async function reconcileCloseAfterKnownAbsence(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  if (claim.operationType !== "CLOSE" || !claim.providerTeamId) {
    throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation operation is invalid", true);
  }
  const owner = supportManagerAccount(options).accountId;
  if (owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation owner changed", true);
  const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
  if (existence.status === "AMBIGUOUS") {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation team identity is ambiguous", true);
  }
  if (existence.status === "FOUND") {
    throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team still exists after close reconciliation", true);
  }
  await completeCloseRecovery(options, claim, claim.providerTeamId, "FAILED");
}

export async function completeRoundCloseRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  threadId: string,
  teamGone = false,
): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "round close lease changed before reconciliation", true);
    const thread = await readThreadById(client, options.appId, threadId, true);
    if (row.threadId !== threadId) throw new ScopeOperationFailure("STALE_OPERATION", "round close thread changed", true);
    const settleSuccess = async () => {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
                "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "round close lease changed before completion", true);
    };
    if (row.state === "CLOSED" && thread.state === "IDLE") {
      await settleSuccess();
      return;
    }
    if (!claim.previousAdminId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close operation has no responsible agent", true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== claim.previousAdminId || row.messageScopeState !== "REVOKING"
      || row.messageScopeId !== teamId) {
      throw new ScopeOperationFailure("STALE_OPERATION", "round close consultation changed", true);
    }
    if (!teamGone && (thread.messageScopeId !== teamId || thread.messageScopeState !== "READY")) {
      throw new ScopeOperationFailure("STALE_OPERATION", "round close thread scope changed", true);
    }
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED', "message_scope_state" = 'READY',
              "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "message_scope_state" = 'REVOKING'`,
      [options.appId, claim.consultationId],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "round close writeback is unknown");
    await decrementPresence(client, options.appId, claim.previousAdminId);
    // 结束本轮不 dismiss Team、不删除历史；线程回 IDLE 等待用户再次触发。
    await client.query(
      teamGone
        ? `UPDATE "zzsh_iam"."im_support_thread"
              SET "state" = 'IDLE', "peer_account_id" = NULL,
                  "message_scope_id" = NULL, "message_scope_state" = 'PENDING',
                  "version" = "version" + 1, "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2`
        : `UPDATE "zzsh_iam"."im_support_thread"
              SET "state" = 'IDLE', "peer_account_id" = NULL,
                  "version" = "version" + 1, "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2`,
      [options.appId, threadId],
    );
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "CLOSED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: claim.previousAdminId, peerAccountId: claim.previousAdminAccountId, details: { roundClosed: true, threadId, teamRetained: !teamGone } });
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: teamGone ? "im.scope.round_close.reconciled" : "im.scope.round_close.completed",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "SUCCESS",
      requestId: `im_scope_${claim.id}`,
      details: { threadId, teamRetained: !teamGone },
    });
    await settleSuccess();
  });
}

export async function reconcileRoundClose(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner || owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close identity is inconsistent", true);
  if (!claim.providerTeamId || !claim.previousAdminAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close operation is incomplete", true);
  const threadId = await readRoundThreadId(options, claim.consultationId);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) {
    const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
    if (existence.status !== "ABSENT") {
      throw new ScopeOperationFailure(existence.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH", "support team absence could not be confirmed", true);
    }
    // 线程 Team 已不存在：本轮按本地事实结束，线程不再声称旧历史可恢复。
    await completeRoundCloseRecovery(options, claim, claim.providerTeamId, threadId, true);
    return;
  }
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close Team owner changed", true);
  if (supportMarkerMatches(team.serverExtension, options.appId, threadId) !== true
    && supportMarkerMatches(team.serverExtension, options.appId, claim.consultationId) !== true) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "round close Team marker is not confirmed", true);
  }
  let current = team;
  if (current.memberAccountIds.includes(claim.previousAdminAccountId)) {
    current = await mutateTeamMember(options, lease, current.teamId, owner,
      () => options.provider!.removeSupportTeamMember(current.teamId, owner, claim.previousAdminAccountId!));
  }
  if (current.memberAccountIds.includes(claim.previousAdminAccountId)) {
    throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "responsible agent is still a Team member after removal", true);
  }
  if (!allowedMembers(current, [owner, claim.userAccountId])) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "support thread Team retained an unauthorized member", true);
  }
  await completeRoundCloseRecovery(options, claim, current.teamId, threadId);
}

export function activeLease(value: Date | string | null): boolean {
  if (value === null) return false;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp > Date.now();
}

export async function claimCloseReconciliation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  requestId: string,
): Promise<ScopeOperationClaim | "SUCCEEDED" | null> {
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportTransfer)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    await requireSupportAccessFor(client, access, context.userId, row);
    const latest = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
         WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (!latest) return null;
    const detail = await readScopeOperation(client, options.appId, latest.id, true);
    if (detail.operationType !== "CLOSE") return null;
    if (detail.state === "SUCCEEDED") return "SUCCEEDED";
    if (detail.state !== "NEEDS_REVIEW") return null;
    if (row.state !== "ACTIVE") throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation consultation is no longer active", true);
    if (detail.leaseTokenHash !== null || activeLease(detail.leaseUntil)) {
      throw unavailable("IM close reconciliation lease is still active");
    }
    const closeReadEligibleFailure =
      (detail.lastFailureClass === "REQUIRES_MANUAL_REVIEW" && detail.lastFailureDetail === "yunxin:get-support-team")
      || (detail.lastFailureClass === "PROVIDER_UNKNOWN" && detail.lastFailureDetail === "yunxin:dismiss-support-team");
    if (numberValue(detail.attemptCount) !== 1 || !closeReadEligibleFailure) {
      throw unavailable("IM close reconciliation is not eligible for the single read");
    }
    if (
      !detail.providerTeamId
      || row.messageScopeId !== detail.providerTeamId
      || row.userAccountId !== detail.userAccountId
      || row.messageScopeState !== "FAILED"
      || numberValue(row.messageScopeVersion) !== numberValue(detail.scopeVersion) + 1
    ) {
      throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation binding or version changed", true);
    }
    if (supportManagerAccount(options).accountId !== detail.ownerAccountId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation manager changed", true);
    }
    const leaseToken = randomBytes(32).toString("base64url");
    const requeued = await client.query<{ id: string }>(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'PENDING', "next_retry_at" = clock_timestamp(), "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "operation_type" = 'CLOSE'
          AND "state" = 'NEEDS_REVIEW' AND "attempt_count" = 1
          AND "scope_version" = $3 AND "provider_team_id" = $4
          AND "lease_token_hash" IS NULL
          AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
        RETURNING "id"`,
      [options.appId, detail.id, detail.scopeVersion, detail.providerTeamId],
    );
    if (requeued.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation state changed", true);
    const claimed = await client.query<{ id: string }>(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'RUNNING', "attempt_count" = "attempt_count" + 1,
              "lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
              "lease_token_hash" = $4, "last_failure_class" = NULL,
              "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "operation_type" = 'CLOSE'
          AND "state" = 'PENDING' AND "attempt_count" = 1
          AND "scope_version" = $5 AND "provider_team_id" = $6
          AND "lease_token_hash" IS NULL
          AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
        RETURNING "id"`,
      [options.appId, detail.id, SCOPE_LEASE_MS, scopeLeaseHash(leaseToken), detail.scopeVersion, detail.providerTeamId],
    );
    if (claimed.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation lease changed", true);
    const claimRow = await readScopeOperation(client, options.appId, detail.id, true);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.scope.close.reconciliation.started",
      objectType: "im_consultation_scope_operation",
      objectId: detail.id,
      outcome: "SUCCESS",
      requestId,
      details: {
        providerTeamId: detail.providerTeamId,
        priorAttemptCount: 1,
        expectedScopeVersion: numberValue(row.messageScopeVersion),
        readLimit: 1,
      },
    });
    return { ...claimRow, leaseToken, attemptCount: numberValue(claimRow.attemptCount) };
  });
}

export type ScopeOperationExecutionMode = "NORMAL" | "CLOSE_ABSENCE";

export async function executeScopeOperation(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  mode: ScopeOperationExecutionMode = "NORMAL",
): Promise<"SUCCEEDED" | "RETRYING" | "NEEDS_REVIEW"> {
  const lease = createScopeLease(options, claim);
  try {
    if (claim.operationType === "CREATE") await reconcileCreate(options, claim, lease);
    else if (claim.operationType === "TRANSFER") await reconcileTransfer(options, claim, lease);
    else if (claim.operationType === "ADD_MEMBER") await reconcileAddMember(options, claim, lease);
    else if (claim.operationType === "ROUND_CLOSE") await reconcileRoundClose(options, claim, lease);
    else if (mode === "CLOSE_ABSENCE") await reconcileCloseAfterKnownAbsence(options, claim, lease);
    else await reconcileClose(options, claim, lease);
    await lease.stop();
    return "SUCCEEDED";
  } catch (error) {
    await lease.stop();
    return settleScopeOperationFailure(options, claim, providerFailure(error));
  }
}

export async function runScopeOperationNow(options: ConsultationRouteOptions, operationId: string): Promise<void> {
  const claim = await claimScopeOperation(options, operationId);
  if (!claim) return;
  const result = await executeScopeOperation(options, claim);
  if (result !== "SUCCEEDED") throw unavailable("IM message scope is being recovered");
}

export async function reconcileMessageScopes(options: ConsultationRouteOptions, limit = 10, onFailure?: ScopeRecoveryFailureObserver): Promise<number> {
  if (!options.provider || !options.supportManager) return 0;
  await quarantineUncertainScopeOperations(options, limit);
  const candidates = await options.pool.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
      WHERE "app_id" = $1 AND (
        ("state" = 'PENDING' AND "next_retry_at" <= clock_timestamp())
        OR ("state" = 'UNKNOWN' AND "last_failure_class" = 'IDENTITY_PENDING'
            AND "next_retry_at" <= clock_timestamp())
      ) ORDER BY "next_retry_at", "updated_at", "id" LIMIT $2`,
    [options.appId, limit],
  );
  let claimedCount = 0;
  for (const candidate of candidates.rows) {
    try {
      const claim = await claimScopeOperation(options, candidate.id);
      if (!claim) continue;
      claimedCount += 1;
      await executeScopeOperation(options, claim);
    } catch (error) {
      reportRecoveryFailure(onFailure, error);
    }
  }
  return claimedCount;
}

export function startMessageScopeRecovery(options: ConsultationRouteOptions, intervalMs = 30_000, onFailure?: ScopeRecoveryFailureObserver): () => Promise<void> {
  if (!options.provider || !options.supportManager) return async () => undefined;
  let stopped = false;
  let inFlight: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    const current = reconcileMessageScopes(options, 10, onFailure).catch((error) => {
      reportRecoveryFailure(onFailure, error);
    });
    inFlight = current;
    void current.finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    const current = inFlight;
    if (current) await current;
  };
}

@Injectable()
export class MessageScopeRecoveryLifecycle implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MessageScopeRecoveryLifecycle.name);
  private stopRecovery: (() => Promise<void>) | undefined;

  start(options: ConsultationRouteOptions, intervalMs = 30_000): void {
    if (this.stopRecovery) return;
    this.stopRecovery = startMessageScopeRecovery(options, intervalMs, (failureClass) => {
      this.logger.error(JSON.stringify({ event: "im.scope.recovery.failed", failureClass }));
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    const stop = this.stopRecovery;
    this.stopRecovery = undefined;
    if (stop) await stop();
  }
}
