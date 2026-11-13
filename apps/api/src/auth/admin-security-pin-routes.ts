import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";
import {
  bodyOf, commandAcceptedBody, commandReplayBody, pinField, readAdminContext,
  rejectionEnvelopeOf, securityCommandScope, sendSuccess, verifyAdminReauthentication,
} from "./auth-security";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import { assertAdminCommandAuthorizedInTransaction } from "./admin-auth-session";
import {
  AdminSecurityCommandError, claimAdminSecurityCommand, recordAdminSecurityCommandRejection, writeAdminSecurityCommandReceipt,
  type AdminSecurityCommandReceipt, type AdminSecurityCommandRejection,
} from "./admin-security-commands";
import { markSupportPresenceLockedForSession, markSupportPresenceUnlockedForSession } from "../im/support-presence-session";

/** 本人 PIN 命令组：set/change/lock/unlock。命令幂等、回执与拒绝逻辑见各 handler。 */

export async function setPin(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const pin = pinField(bodyOf(request), "pin");
  const scope = securityCommandScope(request, options, "pin.set", context, ["pin.set", context.sessionId, pin]);
  const pinHash = await options.hashPassword(pin);
  const result = { pinConfigured: true, sessionId: context.sessionId } satisfies Record<string, unknown>;
  let replay: AdminSecurityCommandReceipt | undefined;
  try {
    await withTransaction(options.pool, async (client) => {
      await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
      // 事务内复核会话归属/有效期/撤销/锁态与 ACTIVE+2FA 准入，不信任事务前快照；
      // 回执重放同样先过这道门，回执存在不构成权限凭证。
      const guard = await assertAdminCommandAuthorizedInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
      if (scope) {
        const claim = await claimAdminSecurityCommand(client, scope);
        if (claim.mode === "replay") { replay = claim.receipt; return; }
      }
      if (guard.pinHash) {
        throw new AdminSecurityCommandError(409, API_V1_ERROR_CODES.CONFLICT, "PIN is already configured", "pin_already_configured");
      }
      await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinHash" = $1, "pinFailures" = 0, "locked" = false, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [pinHash, context.sessionId]);
      if (scope) await writeAdminSecurityCommandReceipt(client, scope, { status: "completed", result }, requestId);
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.set", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId, details: { commandId: scope?.commandId ?? null } });
    });
  } catch (error) {
    if (scope && error instanceof AdminSecurityCommandError) {
      const rejection = rejectionEnvelopeOf(error);
      await recordAdminSecurityCommandRejection(options.pool, scope, rejection, requestId, (client) => recordAudit(client, {
        actorType: "admin",
        actorId: context.userId,
        sessionId: context.sessionId,
        action: "admin.pin.set",
        objectType: "admin_session",
        objectId: context.sessionId,
        outcome: "FAILURE",
        requestId,
        reason: rejection.reason ?? rejection.message,
        details: { commandId: scope?.commandId ?? null },
      }));
    }
    throw error;
  }
  if (replay) { sendSuccess(response, commandReplayBody(replay, "SET"), requestId); return; }
  sendSuccess(response, commandAcceptedBody("SET", scope, result), requestId);
}

export async function changePin(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const body = bodyOf(request);
  const currentPin = pinField(body, "currentPin");
  const nextPin = pinField(body, "newPin");
  const scope = securityCommandScope(request, options, "pin.change", context, ["pin.change", context.sessionId, currentPin, nextPin]);
  const nextHash = await options.hashPassword(nextPin);
  const result = { pinChanged: true, sessionId: context.sessionId } satisfies Record<string, unknown>;
  let failure: AdminSecurityCommandError | undefined;
  let replay: AdminSecurityCommandReceipt | undefined;
  try {
    await withTransaction(options.pool, async (client) => {
      await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
      const guard = await assertAdminCommandAuthorizedInTransaction(client, { userId: context.userId, sessionId: context.sessionId });
      if (scope) {
        const claim = await claimAdminSecurityCommand(client, scope);
        if (claim.mode === "replay") { replay = claim.receipt; return; }
      }
      if (!guard.pinHash) {
        throw new AdminSecurityCommandError(409, API_V1_ERROR_CODES.CONFLICT, "PIN is not configured", "pin_not_configured");
      }
      if (!await options.verifyPassword(currentPin, guard.pinHash)) {
        const pinFailures = guard.pinFailures + 1;
        const locked = pinFailures >= 5;
        const reason = locked ? "pin_attempt_limit" : "invalid_pin";
        const envelope: AdminSecurityCommandRejection = {
          status: locked ? 423 : 401,
          code: locked ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.UNAUTHENTICATED,
          message: locked ? "Account locked" : "PIN rejected",
          reason,
        };
        await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinFailures" = $1, "locked" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $3`, [pinFailures, locked, context.sessionId]);
        // 失败计次、拒绝回执与语义审计同事务提交：同命令重复不会二次扣次，新的真实尝试仍按原规则计次。
        if (scope) await writeAdminSecurityCommandReceipt(client, scope, { status: "rejected", reason, rejection: envelope }, requestId);
        await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.change", objectType: "admin_session", objectId: context.sessionId, outcome: "FAILURE", requestId, reason, details: { pinFailures, locked, commandId: scope?.commandId ?? null } });
        failure = new AdminSecurityCommandError(envelope.status, envelope.code, envelope.message, envelope.reason);
        return;
      }
      await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinHash" = $1, "pinFailures" = 0, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [nextHash, context.sessionId]);
      if (scope) await writeAdminSecurityCommandReceipt(client, scope, { status: "completed", result }, requestId);
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.change", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId, details: { commandId: scope?.commandId ?? null } });
    });
  } catch (error) {
    if (scope && error instanceof AdminSecurityCommandError) {
      const rejection = rejectionEnvelopeOf(error);
      await recordAdminSecurityCommandRejection(options.pool, scope, rejection, requestId, (client) => recordAudit(client, {
        actorType: "admin",
        actorId: context.userId,
        sessionId: context.sessionId,
        action: "admin.pin.change",
        objectType: "admin_session",
        objectId: context.sessionId,
        outcome: "FAILURE",
        requestId,
        reason: rejection.reason ?? rejection.message,
        details: { commandId: scope?.commandId ?? null },
      }));
    }
    throw error;
  }
  if (replay) { sendSuccess(response, commandReplayBody(replay, "CHANGED"), requestId); return; }
  if (failure) throw failure;
  sendSuccess(response, commandAcceptedBody("CHANGED", scope, result), requestId);
}

export async function lockPin(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const session = await client.query<{ pinHash: string | null; locked: boolean }>(
      `SELECT "pinHash", "locked" FROM "zzsh_auth_admin"."session" WHERE "id" = $1 FOR UPDATE`,
      [context.sessionId],
    );
    const row = session.rows[0];
    if (!row || !row.pinHash) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "PIN is not configured");
    if (row.locked) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Session is already locked");
    await client.query(`UPDATE "zzsh_auth_admin"."session" SET "locked" = true, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [context.sessionId]);
    // Locking pauses dispatch immediately but keeps reception ownership and timing.
    // The page stops its IM connection; a locked-page liveness heartbeat keeps the
    // interval alive until unlock reconnects, or the 30-minute lost sweep ends it.
    const support = await markSupportPresenceLockedForSession(client, context.userId, context.sessionId);
    await recordAudit(client, {
      actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
      action: "admin.pin.locked", objectType: "admin_session", objectId: context.sessionId,
      outcome: "SUCCESS", requestId,
      details: { supportPresencePaused: support.presence },
    });
  });
  sendSuccess(response, { status: "LOCKED" }, requestId);
}

export async function unlockPin(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options, { allowLocked: true });
  if (!context.sessionLocked) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Session is not PIN locked");
  const body = bodyOf(request);
  if (typeof body.pin === "string") {
    let failure: { status: number; message: string } | undefined;
    await withTransaction(options.pool, async (client) => {
      await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
      const session = await client.query<{ pinHash: string | null; pinFailures: number; locked: boolean }>(
        `SELECT "pinHash", "pinFailures", "locked" FROM "zzsh_auth_admin"."session" WHERE "id" = $1 FOR UPDATE`,
        [context.sessionId],
      );
      const row = session.rows[0];
      if (!row || !row.pinHash) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "PIN is not configured");
      if (!row.locked) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Session is not PIN locked");
      const pin = pinField(body, "pin");
      if (row.pinFailures >= 5 || !await options.verifyPassword(pin, row.pinHash)) {
        const pinFailures = Math.min(5, row.pinFailures + (row.pinFailures >= 5 ? 0 : 1));
        const limitReached = pinFailures >= 5;
        const locked = true;
        await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinFailures" = $1, "locked" = true, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [pinFailures, context.sessionId]);
        await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.unlock", objectType: "admin_session", objectId: context.sessionId, outcome: "FAILURE", requestId, reason: row.pinFailures >= 5 ? "pin_attempt_limit" : "invalid_pin", details: { pinFailures, locked, method: "pin" } });
        failure = { status: limitReached ? 423 : 401, message: limitReached ? "Account locked" : "PIN rejected" };
        return;
      }
      await client.query(`UPDATE "zzsh_auth_admin"."session" SET "locked" = false, "pinFailures" = 0, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [context.sessionId]);
      const support = await markSupportPresenceUnlockedForSession(client, context.userId, context.sessionId);
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.unlock", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId, details: { method: "pin", supportPresencePaused: support.presence } });
    });
    if (failure) throw new SecurityApiError(failure.status, failure.status === 423 ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.UNAUTHENTICATED, failure.message);
    sendSuccess(response, { status: "UNLOCKED", method: "PIN" }, requestId);
    return;
  }

  const newPin = body.newPin === undefined ? undefined : pinField(body, "newPin");
  await verifyAdminReauthentication(request, context, body, options);
  const nextHash = newPin === undefined ? undefined : await options.hashPassword(newPin);
  await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const locked = await client.query<{ locked: boolean }>(`SELECT "locked" FROM "zzsh_auth_admin"."session" WHERE "id" = $1 FOR UPDATE`, [context.sessionId]);
    if (!locked.rows[0]?.locked) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Session is not PIN locked");
    if (nextHash === undefined) {
      await client.query(`UPDATE "zzsh_auth_admin"."session" SET "locked" = false, "pinFailures" = 0, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [context.sessionId]);
    } else {
      await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinHash" = $1, "locked" = false, "pinFailures" = 0, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [nextHash, context.sessionId]);
    }
    const support = await markSupportPresenceUnlockedForSession(client, context.userId, context.sessionId);
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.unlock", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId, details: { method: "password_2fa", pinReset: nextHash !== undefined, supportPresencePaused: support.presence } });
  });
  sendSuccess(response, { status: "UNLOCKED", method: "PASSWORD_2FA", pinReset: nextHash !== undefined }, requestId);
}
