import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { API_V1_ERROR_CODES, type ApiV1ErrorCode } from "../contracts/api-v1";
import { assertAdminCommandAuthorizedInTransaction, createTransactionalAdminSession } from "./admin-auth-session";
import {
  AdminSecurityCommandError,
  adminSecurityCommandFingerprint,
  adminSecurityCommandId,
  claimAdminSecurityCommand,
  deriveAdminSecurityCommandKey,
  nextBackupCodeGeneration,
  recordAdminSecurityCommandRejection,
  writeAdminSecurityCommandReceipt,
  type AdminSecurityCommandAction,
  type AdminSecurityCommandReceipt,
  type AdminSecurityCommandRejection,
  type AdminSecurityCommandScope,
} from "./admin-security-commands";
import { SecurityApiError, recordAudit, setAuditContext, withTransaction } from "./security-core";

/**
 * 管理员本人安全命令（改密、备份码重生成）的事务化入口。
 *
 * 为什么不能沿用内置 SDK 路由：安装的 better-auth 1.7.3 `/change-password`
 * 依次执行 updateAccount → deleteUserSessions → createSession，
 * `/two-factor/generate-backup-codes` 执行一次 adapter.update；
 * 在 `drizzleAdapter(..., { transaction: true })` 下每次 adapter 写都是
 * 各自独立提交的事务（见 @better-auth/drizzle-adapter dist/index.mjs 的
 * `transaction` 钩子与 `createCustomAdapter(db)`），因此密码更新、旧会话撤销、
 * 新会话签发并不处于同一操作级事务，也没有语义审计与命令回执。
 * 本模块把这三条链路收进一个 PG 事务，并复用 SDK 自己的密码哈希与会话生成能力。
 *
 * 路由只在 admin realm 的安全命令拦截点被调用；HTTP 层这两个路径不进白名单，
 * 外部直接访问返回 404。所有已知拒绝都以 `AdminSecurityCommandError` 抛出，
 * 由 realm 公共入口转换成合同错误，保证"首试"与"重放"走同一条错误路径。
 */

// The SDK runs its limiter on the original public path before plugin onRequest hooks.
export async function adminSelfSecurityHttpRequest(request: Request): Promise<{ request: Request } | undefined> {
  if (request.method !== "POST") return undefined;
  const url = new URL(request.url);
  const target = new Map([
    ["/api/auth/admin/change-password", "/api/auth/admin/self-security/change-password"],
    ["/api/auth/admin/two-factor/generate-backup-codes", "/api/auth/admin/self-security/generate-backup-codes"],
  ]).get(url.pathname);
  if (!target) return undefined;
  url.pathname = target;
  return { request: new Request(url, request) };
}

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

/** 与 SDK twoFactor() 默认 backupCodeOptions 一致：10 枚、10 位 [a-z0-9A-Z]、5-5 分组。 */
const BACKUP_CODE_AMOUNT = 10;
const BACKUP_CODE_LENGTH = 10;

const MESSAGE = {
  AUTH_REQUIRED: "Authentication required",
  ACCOUNT_UNAVAILABLE: "Account unavailable",
  ACCOUNT_LOCKED: "Account locked",
  CREDENTIAL_MISSING: "Credential account not found",
  CURRENT_PASSWORD_INVALID: "Current password is incorrect",
  PASSWORD_TOO_SHORT: "Password does not meet the minimum length",
  PASSWORD_TOO_LONG: "Password exceeds the maximum length",
  PASSWORD_SAME: "New password must differ from current password",
  PASSWORD_REQUIRED: "Password is required",
  TWO_FACTOR_REQUIRED: "Two-factor authentication is required",
  BACKUP_CODES_UNAVAILABLE: "Backup codes are not available",
} as const;

/** SDK 原生 APIError 报文 → 受控原因枚举；我们自己的错误直接带 reason。 */
export const ADMIN_SELF_SECURITY_MESSAGES: ReadonlyMap<string, string> = new Map<string, string>([
  [MESSAGE.ACCOUNT_UNAVAILABLE, "account_unavailable"],
  [MESSAGE.CREDENTIAL_MISSING, "credential_missing"],
  [MESSAGE.CURRENT_PASSWORD_INVALID, "invalid_current_password"],
  [MESSAGE.PASSWORD_TOO_SHORT, "password_too_short"],
  [MESSAGE.PASSWORD_TOO_LONG, "password_too_long"],
  [MESSAGE.PASSWORD_SAME, "same_password"],
  [MESSAGE.PASSWORD_REQUIRED, "password_required"],
  [MESSAGE.TWO_FACTOR_REQUIRED, "two_factor_required"],
  [MESSAGE.BACKUP_CODES_UNAVAILABLE, "backup_codes_unavailable"],
  [MESSAGE.ACCOUNT_LOCKED, "session_locked"],
  [MESSAGE.AUTH_REQUIRED, "authentication_required"],
]);

export type AdminSelfSecurityRuntime = { pool: Pool; commandKey: Buffer };

type CommandOutcome<T> = { replay: AdminSecurityCommandReceipt } | T;

type AuthenticatedAdmin = Awaited<ReturnType<typeof createTransactionalAdminSession>>;

function reject(
  status: number,
  code: ApiV1ErrorCode,
  message: string,
  reason: string,
): never {
  throw new AdminSecurityCommandError(status, code, message, reason);
}

/** 重放一条"明确拒绝"的回执：原样复现首试的 HTTP 状态、code、message 与 reason。 */
function replayRejection(receipt: AdminSecurityCommandReceipt): never {
  const rejection = receipt.rejection;
  if (rejection) {
    throw new AdminSecurityCommandError(rejection.status, rejection.code, rejection.message, rejection.reason ?? receipt.reason);
  }
  // 历史行没有拒绝信封时也不能包装成成功；退回可识别的冲突。
  throw new AdminSecurityCommandError(409, API_V1_ERROR_CODES.CONFLICT, "Original command was rejected", receipt.reason ?? "rejected");
}

function commandScope(
  runtime: AdminSelfSecurityRuntime,
  action: AdminSecurityCommandAction,
  adminUserId: string,
  commandId: string,
  target: { kind: "session" | "credential"; id: string },
  fingerprintInput: readonly unknown[],
): AdminSecurityCommandScope {
  return {
    adminUserId,
    commandId,
    action,
    target,
    fingerprint: adminSecurityCommandFingerprint(runtime.commandKey, fingerprintInput),
  };
}

function rejectionOf(error: SecurityApiError): AdminSecurityCommandRejection {
  const reason = (error as AdminSecurityCommandError).reason;
  return { status: error.status, code: error.code, message: error.message, ...(reason ? { reason } : {}) };
}

export async function buildAdminSelfSecurityPlugin(options: { pool: Pool; adminSecret: string }) {
  const { createAuthEndpoint, getSessionFromCtx } = await import("better-auth/api");
  const { setSessionCookie } = await import("better-auth/cookies");
  const { generateRandomString, symmetricEncrypt } = await import("better-auth/crypto");
  const runtime: AdminSelfSecurityRuntime = { pool: options.pool, commandKey: deriveAdminSecurityCommandKey(options.adminSecret) };

  const requestIdOf = (ctx: { headers?: Headers }) => ctx.headers?.get("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}`;

  const changePassword = createAuthEndpoint("/self-security/change-password", {
    method: "POST",
    body: z.object({
      currentPassword: z.string().min(1).max(256),
      newPassword: z.string().min(1).max(256),
      revokeOtherSessions: z.boolean().optional(),
    }),
  }, async (ctx) => {
    const commandId = adminSecurityCommandId(ctx.headers);
    const current = await getSessionFromCtx(ctx);
    const userId = current?.user?.id;
    const sessionId = current?.session?.id;
    if (!userId || !sessionId) reject(401, API_V1_ERROR_CODES.UNAUTHENTICATED, MESSAGE.AUTH_REQUIRED, "authentication_required");
    if (current!.session!.locked) reject(423, API_V1_ERROR_CODES.FORBIDDEN, MESSAGE.ACCOUNT_LOCKED, "session_locked");
    const requestId = requestIdOf(ctx);
    const action: AdminSecurityCommandAction = "password.change";
    const scope = commandId
      ? commandScope(runtime, action, userId, commandId, { kind: "credential", id: userId },
        [action, userId, ctx.body.currentPassword, ctx.body.newPassword])
      : undefined;

    let outcome: CommandOutcome<{ authenticated: AuthenticatedAdmin; result: Record<string, unknown> }>;
    try {
      if (ctx.body.newPassword.length < MIN_PASSWORD_LENGTH) {
        reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.PASSWORD_TOO_SHORT, "password_too_short");
      }
      if (ctx.body.newPassword.length > MAX_PASSWORD_LENGTH) {
        reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.PASSWORD_TOO_LONG, "password_too_long");
      }
      if (ctx.body.currentPassword === ctx.body.newPassword) {
        reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.PASSWORD_SAME, "same_password");
      }
      outcome = await withTransaction(options.pool, async (client) => {
        await setAuditContext(client, "admin", userId, sessionId, requestId);
        // 首登改密允许 PENDING_ENROLLMENT 且尚未绑定 2FA；其余准入由同一函数在事务内复核。
        await assertAdminCommandAuthorizedInTransaction(client, { userId, sessionId }, { allowPending: true });
        if (scope) {
          const claim = await claimAdminSecurityCommand(client, scope);
          if (claim.mode === "replay") return { replay: claim.receipt } as const;
        }
        const account = (await client.query<{ id: string; password: string | null }>(
          `SELECT "id", "password" FROM "zzsh_auth_admin"."account" WHERE "userId" = $1 AND "providerId" = 'credential' FOR UPDATE`,
          [userId],
        )).rows[0];
        if (!account?.password) reject(403, API_V1_ERROR_CODES.FORBIDDEN, MESSAGE.CREDENTIAL_MISSING, "credential_missing");
        let verified = false;
        try {
          verified = await ctx.context.password.verify({ hash: account.password!, password: ctx.body.currentPassword });
        } catch {
          verified = false;
        }
        if (!verified) reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.CURRENT_PASSWORD_INVALID, "invalid_current_password");
        const nextHash = await ctx.context.password.hash(ctx.body.newPassword);
        // 先撤销全部旧会话再写新密码：中途失败时最坏是重新登录，不会留下"密码已改但旧会话仍有效"。
        const revoked = await client.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`, [userId]);
        await client.query(
          `UPDATE "zzsh_auth_admin"."account" SET "password" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $1`,
          [account.id, nextHash],
        );
        const authenticated = await createTransactionalAdminSession(client, ctx, userId);
        const revokedSessionCount = revoked.rowCount ?? 0;
        const result = {
          passwordChanged: true,
          sessionsRotated: true,
          revokedSessionCount,
          newSessionId: authenticated.session.id,
        } satisfies Record<string, unknown>;
        if (scope) await writeAdminSecurityCommandReceipt(client, scope, { status: "completed", result }, requestId);
        await recordAudit(client, {
          actorType: "admin",
          actorId: userId,
          sessionId,
          action: "admin.password.changed",
          objectType: "admin_user",
          objectId: userId,
          outcome: "SUCCESS",
          requestId,
          details: { commandId: commandId ?? null, revokedSessionCount, newSessionId: authenticated.session.id },
        });
        return { authenticated, result };
      });
    } catch (error) {
      // 只有已知拒绝才落拒绝回执；未知异常保持 unconfirmed，绝不伪装成"明确拒绝"。
      if (scope && error instanceof AdminSecurityCommandError) {
        const rejection = rejectionOf(error);
        await recordAdminSecurityCommandRejection(options.pool, scope, rejection, requestId, (client) => recordAudit(client, {
          actorType: "admin",
          actorId: userId,
          sessionId,
          action: "admin.password.change",
          objectType: "admin_user",
          objectId: userId,
          outcome: "FAILURE",
          requestId,
          reason: rejection.reason ?? rejection.message,
          details: { commandId: commandId ?? null },
        }));
      }
      throw error;
    }
    if ("replay" in outcome) {
      if (outcome.replay.status === "rejected") replayRejection(outcome.replay);
      const replay = outcome.replay;
      return ctx.json({
        status: true,
        replayed: true,
        action: replay.action,
        commandId: replay.commandId,
        receipt: replay.result ?? null,
        createdAt: replay.createdAt,
      });
    }
    await setSessionCookie(ctx, outcome.authenticated, false, {
      maxAge: Math.max(0, Math.floor((new Date(outcome.authenticated.session.expiresAt).getTime() - Date.now()) / 1000)),
    });
    // 不返回 token / user：原始会话 token 只经 Set-Cookie 交付，正文只留必要非敏感字段。
    return ctx.json({ status: true, action, commandId: commandId ?? null, receipt: outcome.result });
  });

  const generateBackupCodes = createAuthEndpoint("/self-security/generate-backup-codes", {
    method: "POST",
    body: z.object({ password: z.string().min(1).max(256).optional() }),
  }, async (ctx) => {
    const commandId = adminSecurityCommandId(ctx.headers);
    const current = await getSessionFromCtx(ctx);
    const userId = current?.user?.id;
    const sessionId = current?.session?.id;
    if (!userId || !sessionId) reject(401, API_V1_ERROR_CODES.UNAUTHENTICATED, MESSAGE.AUTH_REQUIRED, "authentication_required");
    if (current!.session!.locked) reject(423, API_V1_ERROR_CODES.FORBIDDEN, MESSAGE.ACCOUNT_LOCKED, "session_locked");
    const requestId = requestIdOf(ctx);
    const action: AdminSecurityCommandAction = "backup-codes.generate";
    const password = ctx.body.password;
    const scope = commandId
      ? commandScope(runtime, action, userId, commandId, { kind: "credential", id: userId }, [action, userId, password])
      : undefined;

    let outcome: CommandOutcome<{ codes: string[]; result: Record<string, unknown> }>;
    try {
      if (current!.user!.twoFactorEnabled !== true) {
        reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.TWO_FACTOR_REQUIRED, "two_factor_required");
      }
      if (!password) reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.PASSWORD_REQUIRED, "password_required");
      outcome = await withTransaction(options.pool, async (client) => {
        await setAuditContext(client, "admin", userId, sessionId, requestId);
        await assertAdminCommandAuthorizedInTransaction(client, { userId, sessionId });
        if (scope) {
          const claim = await claimAdminSecurityCommand(client, scope);
          if (claim.mode === "replay") return { replay: claim.receipt } as const;
        }
        const account = (await client.query<{ password: string | null }>(
          `SELECT "password" FROM "zzsh_auth_admin"."account" WHERE "userId" = $1 AND "providerId" = 'credential' FOR UPDATE`,
          [userId],
        )).rows[0];
        if (!account?.password) reject(403, API_V1_ERROR_CODES.FORBIDDEN, MESSAGE.CREDENTIAL_MISSING, "credential_missing");
        let verified = false;
        try {
          verified = await ctx.context.password.verify({ hash: account.password!, password });
        } catch {
          verified = false;
        }
        if (!verified) reject(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, MESSAGE.CURRENT_PASSWORD_INVALID, "invalid_current_password");
        const twoFactor = (await client.query<{ id: string }>(
          `SELECT "id" FROM "zzsh_auth_admin"."twoFactor" WHERE "userId" = $1 FOR UPDATE`,
          [userId],
        )).rows[0];
        if (!twoFactor) reject(403, API_V1_ERROR_CODES.FORBIDDEN, MESSAGE.BACKUP_CODES_UNAVAILABLE, "backup_codes_unavailable");
        const codes = Array.from({ length: BACKUP_CODE_AMOUNT }, () => generateRandomString(BACKUP_CODE_LENGTH, "a-z", "0-9", "A-Z"))
          .map((code) => `${code.slice(0, 5)}-${code.slice(5)}`);
        // SDK twoFactor() 默认 storeBackupCodes:"encrypted"；用同一 secretConfig 编码，
        // 既有 verify-backup-code / getBackupCodes 才能解码新码。禁止降级成明文 JSON。
        const stored = await symmetricEncrypt({ key: ctx.context.secretConfig, data: JSON.stringify(codes) });
        await client.query(
          `UPDATE "zzsh_auth_admin"."twoFactor" SET "backupCodes" = $2 WHERE "id" = $1`,
          [twoFactor.id, stored],
        );
        // 包含无key旧调用：新schema是部署前置，代次独立于可选命令回执原子推进。
        const generation = await nextBackupCodeGeneration(client, userId);
        const result = { generated: true, ...generation, codeCount: codes.length } satisfies Record<string, unknown>;
        if (scope) await writeAdminSecurityCommandReceipt(client, scope, { status: "completed", result }, requestId);
        await recordAudit(client, {
          actorType: "admin",
          actorId: userId,
          sessionId,
          action: "admin.backup_codes.generated",
          objectType: "admin_user",
          objectId: userId,
          outcome: "SUCCESS",
          requestId,
          details: { commandId: commandId ?? null, generation: generation.generation, generationId: generation.generationId, codeCount: codes.length },
        });
        return { codes, result };
      });
    } catch (error) {
      if (scope && error instanceof AdminSecurityCommandError) {
        const rejection = rejectionOf(error);
        await recordAdminSecurityCommandRejection(options.pool, scope, rejection, requestId, (client) => recordAudit(client, {
          actorType: "admin",
          actorId: userId,
          sessionId,
          action: "admin.backup_codes.generate",
          objectType: "admin_user",
          objectId: userId,
          outcome: "FAILURE",
          requestId,
          reason: rejection.reason ?? rejection.message,
          details: { commandId: commandId ?? null },
        }));
      }
      throw error;
    }
    if ("replay" in outcome) {
      // 明文新码只在首次成功响应交付一次；重复命令绝不再生成一批，也不谎称还能交付。
      if (outcome.replay.status === "rejected") replayRejection(outcome.replay);
      const replay = outcome.replay;
      return ctx.json({
        status: true,
        replayed: true,
        action: replay.action,
        commandId: replay.commandId,
        receipt: replay.result ?? null,
        createdAt: replay.createdAt,
      });
    }
    return ctx.json({
      status: true,
      backupCodes: outcome.codes,
      action,
      commandId: commandId ?? null,
      receipt: outcome.result,
    });
  });

  return {
    id: "admin-self-security",
    onRequest: adminSelfSecurityHttpRequest,
    endpoints: {
      adminSelfChangePassword: changePassword,
      adminSelfGenerateBackupCodes: generateBackupCodes,
    },
  };
}
