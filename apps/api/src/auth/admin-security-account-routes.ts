import type { AdminContext, AdminSecurityNotification, AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";
import { randomBytes } from "node:crypto";
import {
  bodyOf, deliverAdminSecurityNotification, queueAdminSecurityNotification, readAdminContext,
  reasonField, requireBoss, sendSuccess, stringField, verifyAdminReauthentication,
} from "./auth-security";
import { ADMIN_PERMISSION, hasPermission } from "./admin-authorization";
import { lockActor, requireDirectoryPermission } from "./admin-directory";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import { changeUserFreezeState } from "./user-identity";
import { endSupportPresenceForAdmin, endSupportPresenceForAuthSession } from "../im/support-presence-session";

/** 账号命令组：管理员/用户冻结解冻、登录 2FA 偏好、本人会话注销、凭据重置、强制下线。 */

export async function changeAdminFreezeState(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, state: "FROZEN" | "ACTIVE"): Promise<void> {
  const context = await readAdminContext(request, options);
  const requiredPermission = state === "FROZEN" ? ADMIN_PERMISSION.accountFreeze : ADMIN_PERMISSION.accountUnfreeze;
  await requireDirectoryPermission(options.pool, context.userId, requiredPermission);
  const body = bodyOf(request);
  const targetAdminId = stringField(body, "targetAdminId", 128);
  const reason = reasonField(body);
  await verifyAdminReauthentication(request, context, body, options);
  if (targetAdminId === context.userId) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "An administrator cannot change its own availability");
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    // Freeze lock order: actor security -> actor roles -> target security -> target user -> recovery requests -> sessions.
    const actorAccess = await lockActor(client, context.userId);
    if (!hasPermission(actorAccess, requiredPermission)) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
    }
    const target = await client.query<{ status: AdminContext["security"]["status"]; isBoss: boolean; firstActivatedAt: Date | null }>(
      `SELECT "status", "is_boss" AS "isBoss", "first_activated_at" AS "firstActivatedAt" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
      [targetAdminId],
    );
    if (!target.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    if (target.rows[0].isBoss && !actorAccess.isBoss) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss identity cannot be modified by this operation");
    }
    const targetUser = await client.query<{ twoFactorEnabled: boolean }>(
      `SELECT "twoFactorEnabled" FROM "zzsh_auth_admin"."user" WHERE "id" = $1 FOR UPDATE`,
      [targetAdminId],
    );
    if (!targetUser.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    let resultingStatus: "FROZEN" | "ACTIVE" | "PENDING_ENROLLMENT" = "FROZEN";
    if (state === "FROZEN") {
      if (target.rows[0].status === "FROZEN") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator is already frozen");
      await client.query(`UPDATE "zzsh_iam"."admin_security" SET "status" = 'FROZEN', "updated_at" = clock_timestamp() WHERE "admin_user_id" = $1`, [targetAdminId]);
      await client.query(`UPDATE "zzsh_iam"."admin_recovery_request" SET "status" = 'EXPIRED', "recovery_token_hash" = NULL WHERE "target_admin_user_id" = $1 AND "status" IN ('PENDING', 'ISSUED')`, [targetAdminId]);
      await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [targetAdminId]);
      await endSupportPresenceForAdmin(client, targetAdminId, "REVOKED", new Date());
      resultingStatus = "FROZEN";
    } else {
      if (target.rows[0].status !== "FROZEN") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator is not frozen");
      const nextStatus = targetUser.rows[0].twoFactorEnabled && target.rows[0].firstActivatedAt ? "ACTIVE" : "PENDING_ENROLLMENT";
      const pendingWindow = target.rows[0].isBoss ? "15 minutes" : "7 days";
      await client.query(`UPDATE "zzsh_iam"."admin_security"
         SET "status" = $1,
             "bootstrap_expires_at" = CASE WHEN $1 = 'PENDING_ENROLLMENT' AND "is_boss" AND "first_activated_at" IS NULL THEN NULL
               WHEN $1 = 'PENDING_ENROLLMENT' AND ("bootstrap_expires_at" IS NULL OR "bootstrap_expires_at" <= clock_timestamp()) THEN clock_timestamp() + $3::interval ELSE "bootstrap_expires_at" END,
             "updated_at" = clock_timestamp()
         WHERE "admin_user_id" = $2`, [nextStatus, targetAdminId, pendingWindow]);
      resultingStatus = nextStatus;
    }
    const event = state === "FROZEN" ? "admin.frozen" : "admin.unfrozen";
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: event, objectType: "admin_security", objectId: targetAdminId, outcome: "SUCCESS", requestId, details: { reason } });
    const notification = { event, actorId: context.userId, targetAdminId, reason, requestId } satisfies AdminSecurityNotification;
    const notificationId = await queueAdminSecurityNotification(client, notification);
    return { status: resultingStatus, notification, notificationId };
  });
  await deliverAdminSecurityNotification(options, result.notificationId);
  sendSuccess(response, { status: result.status }, requestId);
}

export async function changeUserAccountFreezeState(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, next: "FROZEN" | "ACTIVE"): Promise<void> {
  const context = await readAdminContext(request, options);
  await requireDirectoryPermission(options.pool, context.userId, next === "FROZEN" ? ADMIN_PERMISSION.userAccountFreeze : ADMIN_PERMISSION.userAccountUnfreeze);
  const body = bodyOf(request);
  const targetUserId = stringField(body, "targetUserId", 128);
  const reason = reasonField(body);
  await verifyAdminReauthentication(request, context, body, options);
  const result = await changeUserFreezeState(context, targetUserId, next, reason, requestId, options);
  sendSuccess(response, {
    status: result.status,
    target: { id: result.id, username: result.username, name: result.name },
    revokedSessions: result.revokedSessions,
    revokedVerifications: result.revokedVerifications,
    message: next === "FROZEN" ? "用户账号已冻结，全部会话已下线。" : "用户账号已解冻；旧会话不会复活，请让用户重新登录。",
  }, requestId);
}

/**
 * 本人自助设置「登录时验证 2FA」。开或关都要求当场再验证密码与动态码，并写入前后审计。
 * 仅影响登录挑战；敏感操作的再验证仍要求动态码。账号必须已绑定 2FA（readAdminContext 默认要求）。
 */
export async function changeLoginTwoFactorPreference(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const body = bodyOf(request);
  if (typeof body.enabled !== "boolean") throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "enabled must be a boolean");
  const enabled = body.enabled;
  await verifyAdminReauthentication(request, context, body, options);
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    if (actor.status !== "ACTIVE") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator is not active");
    const before = await client.query<{ required: boolean }>(
      `SELECT "login_two_factor_required" AS "required" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
      [context.userId],
    );
    const previous = before.rows[0]?.required;
    if (typeof previous !== "boolean") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Login two-factor preference is unavailable");
    if (previous !== enabled) {
      await client.query(`UPDATE "zzsh_iam"."admin_security" SET "login_two_factor_required" = $1, "updated_at" = clock_timestamp() WHERE "admin_user_id" = $2`, [enabled, context.userId]);
    }
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.login_two_factor.changed",
      objectType: "admin_security",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      details: { before: { loginTwoFactorRequired: previous }, after: { loginTwoFactorRequired: enabled }, isBoss: actor.isBoss },
    });
    return { loginTwoFactorRequired: enabled, changed: previous !== enabled };
  });
  sendSuccess(response, {
    ...result,
    message: enabled ? "已开启：登录时需要验证 2FA。" : "已关闭：登录时只需密码。敏感操作仍需验证 2FA。",
  }, requestId);
}

const SELF_SESSION_REVOKE_MAX = 50;

/**
 * 本人注销其他会话（单条或「退出其他设备」固定集合）。
 * - 当前会话受保护（409），只删除本人名下、未过期、且在本次确认集合内的会话；
 * - 与其他敏感动作一致：当场验证本人密码与动态码（step-up）；
 * - 写入 admin.self.sessions.revoked 审计（scope + 实际注销数）。
 */
export async function revokeSelfSessions(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const body = bodyOf(request);
  const scope = body.scope === "one" || body.scope === "others" ? body.scope : undefined;
  const ids = Array.isArray(body.sessionIds) ? body.sessionIds : undefined;
  if (
    !scope || !ids || ids.length === 0 || ids.length > SELF_SESSION_REVOKE_MAX
    || ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)
    || new Set(ids).size !== ids.length || (scope === "one" && ids.length !== 1)
  ) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Session selection is invalid");
  }
  if (ids.includes(context.sessionId)) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Current session is protected");
  await verifyAdminReauthentication(request, context, body, options);
  const revokedSessionCount = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    if (actor.status !== "ACTIVE") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator is not active");
    const deleted = await client.query<{ id: string }>(
      `DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1 AND "id" = ANY($2::text[]) AND "id" <> $3 AND "expiresAt" > clock_timestamp()
       RETURNING "id"`,
      [context.userId, ids, context.sessionId],
    );
    const count = deleted.rowCount ?? 0;
    if (scope === "one" && count === 0) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Session not found");
    const revokedAt = new Date();
    for (const row of deleted.rows) await endSupportPresenceForAuthSession(client, row.id, "REVOKED", revokedAt);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.self.sessions.revoked",
      objectType: "admin_user",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      details: { scope, requestedSessionCount: ids.length, revokedSessionCount: count },
    });
    return count;
  });
  sendSuccess(response, { status: true, revokedSessionCount }, requestId);
}

const ADMIN_CREDENTIAL_RESET_TTL = "7 days";

/**
 * Boss 为其他非 Boss 管理员重置密码或 2FA。
 * - 仅 Boss（requireBoss + 事务内 lockActor 复核），发起方当场再验证密码与动态码；
 * - 不能重置自己，不能重置另一位 Boss，冻结账号需先解冻；
 * - 重置密码：签发一次性临时密码（仅本次响应返回），下次登录强制改密；
 * - 重置 2FA：清除绑定，下次登录必须重新绑定；
 * - 两者都会撤销目标全部会话与未完成登录挑战，并写入前后状态审计。
 */
export async function resetAdminCredential(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, kind: "password" | "two_factor"): Promise<void> {
  const context = await readAdminContext(request, options);
  await requireBoss(context, options);
  const body = bodyOf(request);
  const targetAdminId = stringField(body, "targetAdminId", 128);
  const reason = reasonField(body);
  await verifyAdminReauthentication(request, context, body, options);
  if (targetAdminId === context.userId) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "An administrator cannot reset its own credentials here");
  const temporaryPassword = kind === "password" ? randomBytes(18).toString("base64url") : null;
  const passwordHash = temporaryPassword ? await options.hashPassword(temporaryPassword) : null;
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    if (!actor.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
    const account = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_auth_admin"."account" WHERE "userId" = $1 AND "providerId" = 'credential' FOR UPDATE`, [targetAdminId]);
    const target = await client.query<{ status: AdminContext["security"]["status"]; isBoss: boolean; passwordChangeRequired: boolean }>(
      `SELECT "status", "is_boss" AS "isBoss", "password_change_required" AS "passwordChangeRequired"
         FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
      [targetAdminId],
    );
    const before = target.rows[0];
    if (!before) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    if (before.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss credentials cannot be reset by this operation");
    if (before.status === "FROZEN") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Frozen administrator must be unfrozen first");
    const targetUser = await client.query<{ username: string | null; name: string; email: string; phoneNumber: string | null; twoFactorEnabled: boolean }>(
      `SELECT "username", "name", "email", "phoneNumber", "twoFactorEnabled" FROM "zzsh_auth_admin"."user" WHERE "id" = $1 FOR UPDATE`,
      [targetAdminId],
    );
    const user = targetUser.rows[0];
    if (!user) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    if (kind === "password") {
      if (!account.rows[0]) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator credential is unavailable");
      await client.query(`UPDATE "zzsh_auth_admin"."account" SET "password" = $1, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [passwordHash, account.rows[0].id]);
    } else {
      await client.query(`DELETE FROM "zzsh_auth_admin"."twoFactor" WHERE "userId" = $1`, [targetAdminId]);
      await client.query(`UPDATE "zzsh_auth_admin"."user" SET "twoFactorEnabled" = false, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [targetAdminId]);
    }
    const passwordChangeRequired = kind === "password" ? true : before.passwordChangeRequired;
    await client.query(`UPDATE "zzsh_iam"."admin_security"
       SET "status" = 'PENDING_ENROLLMENT', "password_change_required" = $1,
           "bootstrap_expires_at" = clock_timestamp() + $2::interval, "bootstrap_used_at" = NULL, "updated_at" = clock_timestamp()
       WHERE "admin_user_id" = $3`, [passwordChangeRequired, ADMIN_CREDENTIAL_RESET_TTL, targetAdminId]);
    const identifiers = [targetAdminId, user.email, user.phoneNumber].filter((value): value is string => Boolean(value));
    const sessions = await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [targetAdminId]);
    await endSupportPresenceForAdmin(client, targetAdminId, "REVOKED", new Date());
    const challenges = await client.query(
      `WITH target_challenges AS (
         SELECT "identifier" FROM "zzsh_auth_admin"."verification" WHERE "value" = $1
       )
       DELETE FROM "zzsh_auth_admin"."verification" AS verification
        WHERE verification."value" = $1
           OR verification."identifier" = ANY($2::text[])
           OR verification."identifier" IN (
             SELECT '2fa-attempts-' || "identifier" FROM target_challenges
           )`,
      [targetAdminId, identifiers],
    );
    const twoFactorEnabledAfter = kind === "two_factor" ? false : user.twoFactorEnabled;
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: kind === "password" ? "admin.password.reset" : "admin.two_factor.reset",
      objectType: "admin_user",
      objectId: targetAdminId,
      outcome: "SUCCESS",
      reason,
      requestId,
      details: {
        before: { status: before.status, passwordChangeRequired: before.passwordChangeRequired, twoFactorEnabled: user.twoFactorEnabled },
        after: { status: "PENDING_ENROLLMENT", passwordChangeRequired, twoFactorEnabled: twoFactorEnabledAfter },
        revokedSessions: sessions.rowCount,
        revokedChallenges: challenges.rowCount,
      },
    });
    return { id: targetAdminId, username: user.username ?? targetAdminId, name: user.name, revokedSessions: sessions.rowCount, revokedChallenges: challenges.rowCount };
  });
  sendSuccess(response, {
    status: kind === "password" ? "PASSWORD_RESET" : "TWO_FACTOR_RESET",
    target: { id: result.id, username: result.username, name: result.name, accountStatus: "PENDING_ENROLLMENT" },
    ...(temporaryPassword ? { temporaryPassword } : {}),
    revokedSessions: result.revokedSessions,
    revokedChallenges: result.revokedChallenges,
    message: kind === "password"
      ? "已签发一次性临时密码，仅显示这一次；对方下次登录需改密。其全部会话已撤销。"
      : "已清除对方的 2FA 绑定，下次登录需重新绑定。其全部会话已撤销。",
  }, requestId);
}

export async function forceLogoutAdmin(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  await requireBoss(context, options);
  const body = bodyOf(request);
  const targetAdminId = stringField(body, "targetAdminId", 128);
  const reason = reasonField(body);
  await verifyAdminReauthentication(request, context, body, options);
  if (targetAdminId === context.userId) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "An administrator cannot force-log out its own session");
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    if (!actor.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
    const target = await client.query<{ status: AdminContext["security"]["status"]; isBoss: boolean }>(
      `SELECT "status", "is_boss" AS "isBoss"
         FROM "zzsh_iam"."admin_security"
        WHERE "admin_user_id" = $1
        FOR UPDATE`,
      [targetAdminId],
    );
    if (!target.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    if (target.rows[0].isBoss && !actor.isBoss) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss identity cannot be controlled by this operation");
    }
    const targetUser = await client.query<{ username: string | null; name: string; email: string; phoneNumber: string | null }>(
      `SELECT "username", "name", "email", "phoneNumber"
         FROM "zzsh_auth_admin"."user"
        WHERE "id" = $1
        FOR UPDATE`,
      [targetAdminId],
    );
    if (!targetUser.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
    const identifiers = [targetAdminId, targetUser.rows[0].email, targetUser.rows[0].phoneNumber].filter((value): value is string => Boolean(value));
    const sessions = await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [targetAdminId]);
    await endSupportPresenceForAdmin(client, targetAdminId, "REVOKED", new Date());
    const challenges = await client.query(
      `WITH target_challenges AS (
         SELECT "identifier" FROM "zzsh_auth_admin"."verification" WHERE "value" = $1
       )
       DELETE FROM "zzsh_auth_admin"."verification" AS verification
        WHERE verification."value" = $1
           OR verification."identifier" = ANY($2::text[])
           OR verification."identifier" IN (
             SELECT '2fa-attempts-' || "identifier" FROM target_challenges
           )`,
      [targetAdminId, identifiers],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.session.force_logged_out",
      objectType: "admin_user",
      objectId: targetAdminId,
      outcome: "SUCCESS",
      reason,
      requestId,
      details: {
        revokedSessions: sessions.rowCount,
        revokedChallenges: challenges.rowCount,
        accountStatus: target.rows[0].status,
        accountStatusUnchanged: true,
      },
    });
    return {
      id: targetAdminId,
      username: targetUser.rows[0].username ?? targetAdminId,
      name: targetUser.rows[0].name,
      status: target.rows[0].status,
      revokedSessions: sessions.rowCount,
      revokedChallenges: challenges.rowCount,
    };
  });
  sendSuccess(response, {
    status: "SESSIONS_REVOKED",
    target: { id: result.id, username: result.username, name: result.name, accountStatus: result.status },
    revokedSessions: result.revokedSessions,
    revokedChallenges: result.revokedChallenges,
    message: "目标管理员的全部设备会话和未完成登录挑战已撤销；账号状态未改变，后续登录仍需密码与 2FA。",
  }, requestId);
}
