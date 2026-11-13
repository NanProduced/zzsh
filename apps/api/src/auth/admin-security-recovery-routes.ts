import type { AdminContext, AdminSecurityNotification, AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";
import {
  acquireSecurityVerificationBudget, bodyOf, checkRateLimit, clearRateLimit, deliverAdminSecurityNotification,
  passwordField, queueAdminSecurityNotification, rateLimitKey, readAdminContext, recoveryCredentialField,
  recoveryTokenHash, recordRateLimitFailure, requireBoss, sendSuccess, stringField,
} from "./auth-security";
import { adminAuthSubjects, gateAdminAuth, recordAdminAuthFailure } from "./admin-brute-force";
import { resolveAdminClientIp } from "./admin-client-ip";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import { endSupportPresenceForAdmin } from "../im/support-presence-session";
import { randomUUID } from "node:crypto";

/** 灾难恢复命令组：申请/确认/完成与待处理列表。令牌哈希、限速与 brute-force 门禁见各 handler。 */

const RECOVERY_TTL_MS = 10 * 60 * 1000;

export async function listPendingRecovery(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  await requireBoss(context, options);
  const result = await options.pool.query<{
    requestId: string;
    username: string | null;
    displayName: string;
    status: string;
    createdAt: Date;
    expiresAt: Date;
  }>(
    `SELECT r."id" AS "requestId",
        COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username",
        u."name" AS "displayName", r."status",
        r."created_at" AS "createdAt", r."expires_at" AS "expiresAt"
       FROM "zzsh_iam"."admin_recovery_request" r
       JOIN "zzsh_auth_admin"."user" u ON u."id" = r."target_admin_user_id"
      WHERE r."status" = 'PENDING' AND r."expires_at" > clock_timestamp()
      ORDER BY r."created_at"`,
  );
  sendSuccess(response, {
    requests: result.rows.map((row) => ({
      id: row.requestId,
      username: row.username ?? "未分配账号",
      name: row.displayName,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    })),
  }, requestId);
}

export async function requestRecovery(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const body = bodyOf(request);
  const targetAdminIdInput = typeof body.targetAdminId === "string" && body.targetAdminId.length > 0
    ? stringField(body, "targetAdminId", 128)
    : undefined;
  const usernameInput = typeof body.username === "string" && body.username.length > 0
    ? stringField(body, "username", 64).trim().toLowerCase()
    : undefined;
  if (!targetAdminIdInput && !usernameInput) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Administrator login is required");
  const password = passwordField(body, "password");
  const targetRecoveryCredential = recoveryCredentialField(body);
  const recoveryTokenDigest = recoveryTokenHash(targetRecoveryCredential);
  const rateKey = rateLimitKey(request, "admin.recovery.request", targetAdminIdInput ?? usernameInput);
  checkRateLimit(options, rateKey);
  const bf = options.adminBruteForce;
  const subjects = bf ? adminAuthSubjects(`recovery:${targetAdminIdInput ?? usernameInput}`, resolveAdminClientIp(request as unknown as Parameters<typeof resolveAdminClientIp>[0], bf.clientIp)) : [];
  if (bf) await gateAdminAuth(bf, "recovery", subjects, { required: false, payload: undefined });
  const releaseVerificationBudget = acquireSecurityVerificationBudget(options);
  let result: { recoveryRequestId: string; status: "PENDING"; target: { username: string; name: string } };
  try {
    result = await withTransaction(options.pool, async (client) => {
      // Recovery request lock order: target account -> target security -> recovery row (insert).
      const targetLookup = await client.query<{
        id: string;
        username: string | null;
        displayUsername: string | null;
        name: string;
      }>(
        `SELECT u."id", u."username", u."displayUsername", u."name"
           FROM "zzsh_auth_admin"."user" u
          WHERE u."id" = $1 OR LOWER(u."username") = $2
          LIMIT 1`,
        [targetAdminIdInput ?? "", usernameInput ?? ""],
      );
      const targetAdminId = targetLookup.rows[0]?.id;
      if (!targetAdminId) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Password verification is required");
      const account = await client.query<{ id: string; password: string | null }>(
        `SELECT "id", "password" FROM "zzsh_auth_admin"."account"
          WHERE "userId" = $1 AND "providerId" = 'credential' FOR UPDATE`,
        [targetAdminId],
      );
      const target = await client.query<{ isBoss: boolean; status: AdminContext["security"]["status"] }>(
        `SELECT "is_boss" AS "isBoss", "status" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
        [targetAdminId],
      );
      const accountRow = account.rows[0];
      const targetRow = target.rows[0];
      if (!accountRow?.password || !targetRow || targetRow.status !== "ACTIVE" || !await options.verifyPassword(password, accountRow.password)) {
        throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Password verification is required");
      }
      await setAuditContext(client, "admin", targetAdminId, undefined, requestId);
      const id = `recovery_${randomUUID().replaceAll("-", "")}`;
      await client.query(
        `INSERT INTO "zzsh_iam"."admin_recovery_request" ("id", "target_admin_user_id", "requested_by", "status", "recovery_token_hash", "expires_at") VALUES ($1, $2, $3, 'PENDING', $4, $5)`,
        [id, targetAdminId, targetAdminId, recoveryTokenDigest, new Date(Date.now() + RECOVERY_TTL_MS)],
      );
      await recordAudit(client, { actorType: "admin", actorId: targetAdminId, action: "admin.recovery.requested", objectType: "admin_recovery_request", objectId: id, outcome: "SUCCESS", requestId, details: { targetIsBoss: targetRow.isBoss, passwordAuthenticated: true } });
      return {
        recoveryRequestId: id,
        status: "PENDING",
        target: {
          username: targetLookup.rows[0]?.displayUsername ?? targetLookup.rows[0]?.username ?? "未分配账号",
          name: targetLookup.rows[0]?.name ?? "管理员",
        },
      };
    });
    clearRateLimit(options, rateKey);
  } catch (error) {
    if (error instanceof SecurityApiError && error.status === 401) {
      recordRateLimitFailure(options, rateKey);
      if (bf) {
        const failure = await recordAdminAuthFailure(bf, "recovery", subjects, requestId);
        if (!failure || failure.lockedUntil) throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "尝试次数过多，请稍后再试");
      }
    }
    throw error;
  } finally {
    releaseVerificationBudget();
  }
  sendSuccess(response, result, requestId);
}

export async function confirmRecovery(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  await requireBoss(context, options);
  const body = bodyOf(request);
  const recoveryRequestId = stringField(body, "recoveryRequestId", 128);
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    // Confirmation lock order: actor security -> target security -> recovery row -> target sessions.
    const actor = await client.query<{ status: AdminContext["security"]["status"]; isBoss: boolean }>(
      `SELECT "status", "is_boss" AS "isBoss" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
      [context.userId],
    );
    if (!actor.rows[0]?.isBoss || actor.rows[0].status !== "ACTIVE") {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
    }
    const targetLookup = await client.query<{ targetAdminId: string }>(
      `SELECT "target_admin_user_id" AS "targetAdminId" FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1`,
      [recoveryRequestId],
    );
    const targetAdminId = targetLookup.rows[0]?.targetAdminId;
    if (!targetAdminId) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Recovery request is not usable");
    const target = await client.query<{ isBoss: boolean; status: AdminContext["security"]["status"] }>(`SELECT "is_boss" AS "isBoss", "status" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`, [targetAdminId]);
    if (!target.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    if (target.rows[0].status === "FROZEN") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Frozen administrator cannot use recovery");
    const recovery = await client.query<{ targetAdminId: string; requestedBy: string; status: string; recoveryTokenHash: string | null; expiresAt: Date }>(
      `SELECT "target_admin_user_id" AS "targetAdminId", "requested_by" AS "requestedBy", "status", "recovery_token_hash" AS "recoveryTokenHash", "expires_at" AS "expiresAt"
         FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1 FOR UPDATE`,
      [recoveryRequestId],
    );
    const requestRow = recovery.rows[0];
    if (!requestRow || requestRow.status !== "PENDING" || !requestRow.recoveryTokenHash || requestRow.expiresAt.getTime() <= Date.now()) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Recovery request is not usable");
    if (requestRow.requestedBy === context.userId) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "A second independent boss is required");
    await client.query(`UPDATE "zzsh_iam"."admin_recovery_request" SET "status" = 'ISSUED', "confirmed_by" = $1 WHERE "id" = $2`, [context.userId, recoveryRequestId]);
    await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [requestRow.targetAdminId]);
    await endSupportPresenceForAdmin(client, requestRow.targetAdminId, "REVOKED", new Date());
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.recovery.issued", objectType: "admin_recovery_request", objectId: recoveryRequestId, outcome: "SUCCESS", requestId, details: { targetAdminId: requestRow.targetAdminId, targetIsBoss: target.rows[0].isBoss, targetStatus: target.rows[0].status } });
    const notification = { event: "admin.recovery.issued", actorId: context.userId, targetAdminId: requestRow.targetAdminId, requestId } satisfies AdminSecurityNotification;
    const notificationId = await queueAdminSecurityNotification(client, notification);
    return { response: { status: "ISSUED" }, notification, notificationId };
  });
  await deliverAdminSecurityNotification(options, result.notificationId);
  sendSuccess(response, result.response, requestId);
}

export async function completeRecovery(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const body = bodyOf(request);
  const targetRecoveryCredential = recoveryCredentialField(body);
  const newPassword = passwordField(body, "newPassword");
  const passwordHash = await options.hashPassword(newPassword);
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin_recovery_target", undefined, undefined, requestId);
    const targetLookup = await client.query<{ targetAdminId: string }>(
      `SELECT "target_admin_user_id" AS "targetAdminId" FROM "zzsh_iam"."admin_recovery_request" WHERE "recovery_token_hash" = $1`,
      [recoveryTokenHash(targetRecoveryCredential)],
    );
    const targetAdminId = targetLookup.rows[0]?.targetAdminId;
    if (!targetAdminId) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Recovery credential is not usable");
    }
    // Completion lock order: target account -> target security -> recovery row -> dependent auth rows.
    const account = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_auth_admin"."account" WHERE "userId" = $1 AND "providerId" = 'credential' FOR UPDATE`, [targetAdminId]);
    if (!account.rows[0]) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator credential is unavailable");
    const target = await client.query<{ status: AdminContext["security"]["status"] }>(
      `SELECT "status" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
      [targetAdminId],
    );
    if (!target.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    if (target.rows[0].status === "FROZEN") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Frozen administrator cannot use recovery");
    const recovery = await client.query<{ id: string; targetAdminId: string; requestedBy: string; confirmedBy: string | null; recoveryMethod: string; offlineConfirmationId: string | null; status: string; expiresAt: Date }>(
      `SELECT "id", "target_admin_user_id" AS "targetAdminId", "requested_by" AS "requestedBy", "confirmed_by" AS "confirmedBy", "recovery_method" AS "recoveryMethod", "offline_confirmation_id" AS "offlineConfirmationId", "status", "expires_at" AS "expiresAt"
         FROM "zzsh_iam"."admin_recovery_request" WHERE "recovery_token_hash" = $1 FOR UPDATE`,
      [recoveryTokenHash(targetRecoveryCredential)],
    );
    const requestRow = recovery.rows[0];
    if (!requestRow || requestRow.status !== "ISSUED" || requestRow.expiresAt.getTime() <= Date.now()) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Recovery credential is not usable");
    }
    await client.query(`UPDATE "zzsh_iam"."admin_recovery_request" SET "status" = 'EXPIRED', "recovery_token_hash" = NULL WHERE "target_admin_user_id" = $1 AND "id" <> $2 AND "status" IN ('PENDING', 'ISSUED')`, [requestRow.targetAdminId, requestRow.id]);
    await client.query(`UPDATE "zzsh_auth_admin"."account" SET "password" = $1, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [passwordHash, account.rows[0].id]);
    await client.query(`DELETE FROM "zzsh_auth_admin"."twoFactor" WHERE "userId" = $1`, [requestRow.targetAdminId]);
    await client.query(`UPDATE "zzsh_auth_admin"."user" SET "twoFactorEnabled" = false, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [requestRow.targetAdminId]);
    await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [requestRow.targetAdminId]);
    await endSupportPresenceForAdmin(client, requestRow.targetAdminId, "REVOKED", new Date());
    const nextStatus = "PENDING_ENROLLMENT";
    await client.query(`UPDATE "zzsh_iam"."admin_security"
       SET "status" = $1, "password_change_required" = false, "bootstrap_expires_at" = clock_timestamp() + interval '15 minutes', "bootstrap_used_at" = NULL, "updated_at" = clock_timestamp()
       WHERE "admin_user_id" = $2`, [nextStatus, requestRow.targetAdminId]);
    await client.query(`UPDATE "zzsh_iam"."admin_recovery_request" SET "status" = 'COMPLETED', "recovery_token_hash" = NULL, "completed_at" = clock_timestamp() WHERE "id" = $1`, [requestRow.id]);
    await recordAudit(client, { actorType: "admin_recovery_target", actorId: requestRow.targetAdminId, action: "admin.recovery.completed", objectType: "admin_user", objectId: requestRow.targetAdminId, outcome: "SUCCESS", requestId, details: { recoveryRequestId: requestRow.id, requestedBy: requestRow.requestedBy, confirmedBy: requestRow.confirmedBy, recoveryMethod: requestRow.recoveryMethod, offlineConfirmationId: requestRow.offlineConfirmationId } });
    const notification = { event: "admin.recovery.completed", actorId: requestRow.targetAdminId, targetAdminId: requestRow.targetAdminId, requestId } satisfies AdminSecurityNotification;
    const notificationId = await queueAdminSecurityNotification(client, notification);
    return { response: { status: nextStatus }, notification, notificationId };
  });
  await deliverAdminSecurityNotification(options, result.notificationId);
  sendSuccess(response, result.response, requestId);
}
