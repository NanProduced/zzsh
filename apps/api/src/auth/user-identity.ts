import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import { ADMIN_PERMISSION, requirePermission } from "./admin-authorization";
import { lockActor } from "./admin-directory";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";

export const FAKE_REAL_NAME_SCENARIOS = [
  "VERIFIED_ADULT",
  "VERIFIED_MINOR",
  "REJECTED",
  "UNKNOWN",
  "FAULT",
] as const;

export type FakeRealNameScenario = (typeof FAKE_REAL_NAME_SCENARIOS)[number];
export type IdentityStatus = "UNVERIFIED" | "VERIFIED" | "REJECTED" | "UNKNOWN";
export type AgeStatus = "UNKNOWN" | "ADULT" | "MINOR";
export type AccountStatus = "ACTIVE" | "DEACTIVATED" | "CANCELLED";

export type RealNameProviderInput = {
  userId: string;
  fullName: string;
  documentNumber: string;
};

export type RealNameVerificationResult = {
  status: "VERIFIED" | "REJECTED" | "UNKNOWN";
  ageStatus: AgeStatus;
  provider: "fake";
  providerReference: string | null;
  reasonCode?: "provider_rejected" | "provider_unknown";
};

export type RealNameProvider = {
  verify: (input: RealNameProviderInput) => Promise<RealNameVerificationResult>;
};

export type UserObligationStatus = "NONE" | "PENDING" | "UNKNOWN";
export type UserObligationReader = (userId: string, client: PoolClient) => Promise<UserObligationStatus>;

export type UserIdentityState = {
  accountStatus: AccountStatus;
  identityStatus: IdentityStatus;
  ageStatus: AgeStatus;
  provider: string;
  version: number;
};

export function createFakeRealNameProvider(scenario: FakeRealNameScenario): RealNameProvider {
  return {
    async verify(input) {
      if (!input.userId || !input.fullName || !input.documentNumber) throw new Error("fake real-name input is incomplete");
      if (scenario === "FAULT") throw new Error("fake real-name provider fault");
      const providerReference = `fake_${createHash("sha256").update(`${scenario}:${input.userId}`).digest("hex").slice(0, 24)}`;
      if (scenario === "VERIFIED_ADULT") return { status: "VERIFIED", ageStatus: "ADULT", provider: "fake", providerReference };
      if (scenario === "VERIFIED_MINOR") return { status: "VERIFIED", ageStatus: "MINOR", provider: "fake", providerReference };
      if (scenario === "REJECTED") return { status: "REJECTED", ageStatus: "UNKNOWN", provider: "fake", providerReference: null, reasonCode: "provider_rejected" };
      return { status: "UNKNOWN", ageStatus: "UNKNOWN", provider: "fake", providerReference: null, reasonCode: "provider_unknown" };
    },
  };
}

export type UserContext = { userId: string; sessionId: string };

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function credentialsOf(request: AuthSecurityNodeRequest): { headers: Headers; conflict: boolean; malformed: boolean } {
  const cookie = headerValue(request.headers.cookie) ?? "";
  const authorization = headerValue(request.headers.authorization) ?? "";
  const bearer = authorization.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  return {
    headers: new Headers({
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    }),
    conflict: Boolean(cookie && bearer),
    malformed: Boolean(authorization && !bearer),
  };
}

function originAllowed(request: AuthSecurityNodeRequest, origins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return origins.includes(origin);
}

function routePath(request: AuthSecurityNodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "/";
  const path = source.split("?", 1)[0] || "/";
  const prefix = "/api/auth/user";
  if (path === prefix) return "/";
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path;
}

function bodyOf(request: AuthSecurityNodeRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return value;
}

function optionalReason(request: AuthSecurityNodeRequest): string | undefined {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return undefined;
  const value = (request.body as Record<string, unknown>).reason;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 500) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Reason is invalid");
  }
  return value.trim();
}

function sendJson(response: AuthSecurityNodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

function sendError(response: AuthSecurityNodeResponse, error: SecurityApiError, requestId: string): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message, requestId } }, requestId);
}

function sendInternalError(response: AuthSecurityNodeResponse, requestId: string): void {
  sendJson(response, 500, { error: { code: API_V1_ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", requestId } }, requestId);
}

export async function readUserContext(request: AuthSecurityNodeRequest, options: AuthSecurityOptions): Promise<UserContext> {
  const credentials = credentialsOf(request);
  if (credentials.conflict || credentials.malformed) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request rejected");
  }
  const current = await options.userAuth.api.getSession({ headers: credentials.headers });
  const userId = current?.user?.id;
  const sessionId = current?.session?.id;
  if (!userId || !sessionId) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  const state = await options.pool.query<{ suspended: boolean; accountStatus: AccountStatus }>(
    `SELECT u."suspended", COALESCE(s."account_status", 'ACTIVE') AS "accountStatus"
       FROM "zzsh_auth_user"."user" u
       LEFT JOIN "zzsh_iam"."user_identity_state" s ON s."user_id" = u."id"
      WHERE u."id" = $1`,
    [userId],
  );
  if (!state.rows[0] || state.rows[0].suspended || state.rows[0].accountStatus !== "ACTIVE") {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  }
  return { userId, sessionId };
}

async function readState(pool: Pool | PoolClient, userId: string): Promise<UserIdentityState | null> {
  const result = await pool.query<UserIdentityState>(
    `SELECT "account_status" AS "accountStatus", "identity_status" AS "identityStatus", "age_status" AS "ageStatus", "provider", "version"
       FROM "zzsh_iam"."user_identity_state" WHERE "user_id" = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export type RestorableUserCandidate = {
  id: string;
  username: string;
  name: string;
  accountStatus: "DEACTIVATED";
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listRestorableUsers(pool: Pool, search: string): Promise<{ users: RestorableUserCandidate[] }> {
  const normalized = search.trim();
  if (normalized.length < 2 || normalized.length > 64) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Search text must contain 2 to 64 characters");
  }
  const result = await pool.query<RestorableUserCandidate>(
    `SELECT u."id", COALESCE(NULLIF(u."username", ''), u."id") AS "username", u."name",
            s."account_status" AS "accountStatus"
       FROM "zzsh_auth_user"."user" u
       JOIN "zzsh_iam"."user_identity_state" s ON s."user_id" = u."id"
      WHERE s."account_status" = 'DEACTIVATED'
        AND (u."username" ILIKE $1 ESCAPE '\\' OR u."name" ILIKE $1 ESCAPE '\\')
      ORDER BY u."name", u."username", u."id"
      LIMIT 50`,
    [`%${escapeLike(normalized)}%`],
  );
  return { users: result.rows.map((row) => ({ ...row, accountStatus: "DEACTIVATED" })) };
}

export async function restoreDeactivatedUserAccount(
  context: { userId: string; sessionId: string },
  targetUserId: string,
  reason: string,
  requestId: string,
  options: AuthSecurityOptions,
): Promise<{ id: string; username: string; name: string; status: "ACTIVE"; revokedSessions: number; revokedVerifications: number }> {
  return withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    requirePermission(actor, ADMIN_PERMISSION.userAccountRestore);
    const target = await client.query<{
      id: string;
      username: string | null;
      name: string;
      suspended: boolean;
      accountStatus: AccountStatus | null;
    }>(
      `SELECT u."id", u."username", u."name", u."suspended",
              s."account_status" AS "accountStatus"
          FROM "zzsh_auth_user"."user" u
          JOIN "zzsh_iam"."user_identity_state" s ON s."user_id" = u."id"
         WHERE u."id" = $1
        FOR UPDATE OF u, s`,
      [targetUserId],
    );
    const row = target.rows[0];
    if (!row || row.accountStatus === null) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Only a deactivated account can be restored");
    }
    if (row.accountStatus === "CANCELLED") {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Cancelled accounts cannot be restored");
    }
    if (row.accountStatus !== "DEACTIVATED") {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Only a deactivated account can be restored");
    }

    const revoked = await revokeUserCredentials(client, row.id);
    const revokedSessions = revoked.sessions;
    const revokedVerifications = revoked.verifications;
    await client.query(`UPDATE "zzsh_auth_user"."user" SET "suspended" = false, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [row.id]);
    const updated = await client.query(
      `UPDATE "zzsh_iam"."user_identity_state"
          SET "account_status" = 'ACTIVE', "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "user_id" = $1 AND "account_status" = 'DEACTIVATED'
      RETURNING "user_id"`,
      [row.id],
    );
    if (updated.rowCount !== 1) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Account state changed; refresh and retry");
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "user.account.restored",
      objectType: "user_account",
      objectId: row.id,
      outcome: "SUCCESS",
      reason,
      requestId,
      details: {
        beforeAccountStatus: "DEACTIVATED",
        afterAccountStatus: "ACTIVE",
        revokedSessions,
        revokedVerifications,
        identityAndAgeUnchanged: true,
      },
    });
    return {
      id: row.id,
      username: row.username ?? row.id,
      name: row.name,
      status: "ACTIVE",
      revokedSessions,
      revokedVerifications,
    };
  });
}

async function assertActiveInTransaction(client: PoolClient, userId: string): Promise<void> {
  const user = await client.query<{ suspended: boolean }>(
    `SELECT "suspended" FROM "zzsh_auth_user"."user" WHERE "id" = $1 FOR UPDATE`,
    [userId],
  );
  const state = await readState(client, userId);
  if (!user.rows[0] || user.rows[0].suspended || (state && state.accountStatus !== "ACTIVE")) {
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  }
}

async function verifyIdentity(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  context: UserContext,
): Promise<void> {
  const body = bodyOf(request);
  if (Object.keys(body).some((field) => field !== "fullName" && field !== "documentNumber")) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Only identity fields are accepted");
  }
  const fullName = stringField(body, "fullName", 120);
  const documentNumber = stringField(body, "documentNumber", 64);
  let result: RealNameVerificationResult;
  try {
    result = await options.realNameProvider.verify({ userId: context.userId, fullName, documentNumber });
  } catch {
    await withTransaction(options.pool, async (client) => {
      await setAuditContext(client, "user", context.userId, context.sessionId, requestId);
      await recordAudit(client, {
        actorType: "user",
        actorId: context.userId,
        sessionId: context.sessionId,
        action: "user.identity.verification",
        objectType: "user_identity_state",
        objectId: context.userId,
        outcome: "FAILURE",
        reason: "provider_fault",
        requestId,
      });
    });
    throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "实名服务暂时无法确认，请稍后重试");
  }

  const state = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "user", context.userId, context.sessionId, requestId);
    await assertActiveInTransaction(client, context.userId);
    const verifiedAt = result.status === "VERIFIED" ? new Date() : null;
    const saved = await client.query<UserIdentityState>(
      `INSERT INTO "zzsh_iam"."user_identity_state"
        ("user_id", "account_status", "identity_status", "age_status", "provider", "provider_reference", "version", "verified_at", "updated_at")
       VALUES ($1, 'ACTIVE', $2, $3, $4, $5, 1, $6, clock_timestamp())
       ON CONFLICT ("user_id") DO UPDATE SET
         "identity_status" = EXCLUDED."identity_status",
         "age_status" = EXCLUDED."age_status",
         "provider" = EXCLUDED."provider",
         "provider_reference" = EXCLUDED."provider_reference",
         "version" = "zzsh_iam"."user_identity_state"."version" + 1,
         "verified_at" = EXCLUDED."verified_at",
         "updated_at" = clock_timestamp()
       RETURNING "account_status" AS "accountStatus", "identity_status" AS "identityStatus", "age_status" AS "ageStatus", "provider", "version"`,
      [context.userId, result.status, result.ageStatus, result.provider, result.providerReference, verifiedAt],
    );
    await recordAudit(client, {
      actorType: "user",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "user.identity.verification",
      objectType: "user_identity_state",
      objectId: context.userId,
      outcome: result.status === "VERIFIED" ? "SUCCESS" : "FAILURE",
      reason: result.reasonCode,
      requestId,
      details: { provider: result.provider, status: result.status, ageStatus: result.ageStatus },
    });
    return saved.rows[0]!;
  });

  const message = result.status === "VERIFIED"
    ? (result.ageStatus === "ADULT" ? "实名校验已通过。" : "实名已通过，但未满足受保护交易的年龄要求。")
    : result.status === "REJECTED" ? "实名服务拒绝了本次校验，请检查资料后重试。" : "实名服务暂时无法确认，请稍后重试。";
  sendJson(response, 200, { status: state.identityStatus, ageStatus: state.ageStatus, version: state.version, message }, requestId);
}

async function checkProtectedTradeEligibility(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  context: UserContext,
): Promise<void> {
  const body = bodyOf(request);
  if (body.action !== "protected_trade_eligibility_check") {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Unsupported eligibility check");
  }
  const state = await readState(options.pool, context.userId);
  if (!state || state.identityStatus !== "VERIFIED") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "请先完成实名校验后再进行受保护交易");
  }
  if (state.ageStatus !== "ADULT") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "当前账号不满足受保护交易的年龄要求");
  }
  sendJson(response, 200, { action: "protected_trade_eligibility_check", eligible: true, execution: "NOT_PERFORMED" }, requestId);
}

async function revokeUserCredentials(client: PoolClient, userId: string): Promise<{ sessions: number; verifications: number }> {
  const user = await client.query<{ email: string; phoneNumber: string | null }>(
    `SELECT "email", "phoneNumber" FROM "zzsh_auth_user"."user" WHERE "id" = $1 FOR UPDATE`,
    [userId],
  );
  const identifiers = new Set<string>([userId]);
  const email = user.rows[0]?.email;
  const phone = user.rows[0]?.phoneNumber;
  if (email) identifiers.add(email);
  if (phone) {
    identifiers.add(phone);
    identifiers.add(`${phone}-request-password-reset`);
  }
  const verification = await client.query(
    `WITH target_challenges AS (
       SELECT "identifier" FROM "zzsh_auth_user"."verification"
        WHERE "value" = $1 OR "identifier" = ANY($2::text[])
     )
     DELETE FROM "zzsh_auth_user"."verification" AS verification
      WHERE verification."value" = $1
         OR verification."identifier" = ANY($2::text[])
         OR verification."identifier" IN (
           SELECT '2fa-attempts-' || "identifier" FROM target_challenges
         )`,
    [userId, [...identifiers]],
  );
  const sessions = await client.query(`DELETE FROM "zzsh_auth_user"."session" WHERE "userId" = $1`, [userId]);
  return { sessions: sessions.rowCount ?? 0, verifications: verification.rowCount ?? 0 };
}

async function changeAccountState(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  context: UserContext,
  nextStatus: "DEACTIVATED" | "CANCELLED",
): Promise<void> {
  const reason = optionalReason(request);
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "user", context.userId, context.sessionId, requestId);
    await assertActiveInTransaction(client, context.userId);
    if (nextStatus === "CANCELLED") {
      let obligations: unknown;
      try {
        obligations = await options.userObligationReader(context.userId, client);
      } catch {
        throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "注销暂不能办理：当前无法确认未完成事项，请稍后重试");
      }
      if (obligations === "PENDING") {
        throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "注销暂不能办理：仍有未完成事项，请先处理后重试");
      }
      if (obligations !== "NONE") {
        throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "注销暂不能办理：当前无法确认未完成事项，请稍后重试");
      }
    }
    const revoked = await revokeUserCredentials(client, context.userId);
    if (nextStatus === "CANCELLED") {
      await client.query(
        `UPDATE "zzsh_auth_user"."account"
            SET "password" = NULL, "legacyPasswordMd5" = NULL, "legacyPasswordVersion" = NULL, "legacyPasswordSalt" = NULL,
                "accessToken" = NULL, "refreshToken" = NULL, "idToken" = NULL, "updatedAt" = clock_timestamp()
          WHERE "userId" = $1`,
        [context.userId],
      );
      await client.query(
        `UPDATE "zzsh_auth_user"."user"
            SET "name" = '已注销用户-' || substr(md5($1), 1, 12),
                "email" = 'deleted-' || substr(md5($1), 1, 24) || '@anonymized.invalid',
                "emailVerified" = false, "image" = NULL, "username" = NULL, "displayUsername" = NULL,
                "phoneNumber" = NULL, "phoneNumberVerified" = false, "suspended" = true, "updatedAt" = clock_timestamp()
          WHERE "id" = $1`,
        [context.userId],
      );
    } else {
      await client.query(`UPDATE "zzsh_auth_user"."user" SET "suspended" = true, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [context.userId]);
    }
    await client.query(
      `INSERT INTO "zzsh_iam"."user_identity_state"
        ("user_id", "account_status", "identity_status", "age_status", "provider", "provider_reference", "version", "anonymized_at", "updated_at")
       VALUES ($1, $2, 'UNVERIFIED', 'UNKNOWN', 'none', NULL, 1, $3, clock_timestamp())
       ON CONFLICT ("user_id") DO UPDATE SET
         "account_status" = EXCLUDED."account_status",
         "identity_status" = CASE WHEN EXCLUDED."account_status" = 'CANCELLED' THEN 'UNVERIFIED' ELSE "zzsh_iam"."user_identity_state"."identity_status" END,
         "age_status" = CASE WHEN EXCLUDED."account_status" = 'CANCELLED' THEN 'UNKNOWN' ELSE "zzsh_iam"."user_identity_state"."age_status" END,
         "provider" = CASE WHEN EXCLUDED."account_status" = 'CANCELLED' THEN 'none' ELSE "zzsh_iam"."user_identity_state"."provider" END,
         "provider_reference" = CASE WHEN EXCLUDED."account_status" = 'CANCELLED' THEN NULL ELSE "zzsh_iam"."user_identity_state"."provider_reference" END,
         "version" = "zzsh_iam"."user_identity_state"."version" + 1,
         "verified_at" = CASE WHEN EXCLUDED."account_status" = 'CANCELLED' THEN NULL ELSE "zzsh_iam"."user_identity_state"."verified_at" END,
         "anonymized_at" = EXCLUDED."anonymized_at",
         "updated_at" = clock_timestamp()`,
      [context.userId, nextStatus, nextStatus === "CANCELLED" ? new Date() : null],
    );
    await recordAudit(client, {
      actorType: "user",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: nextStatus === "CANCELLED" ? "user.account.cancelled" : "user.account.deactivated",
      objectType: "user_account",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      ...(reason ? { reason } : {}),
      details: { revokedSessions: revoked.sessions, revokedVerifications: revoked.verifications, anonymized: nextStatus === "CANCELLED" },
    });
    return revoked;
  });
  sendJson(response, 200, { status: nextStatus, revokedSessions: result.sessions, revokedVerifications: result.verifications, message: nextStatus === "CANCELLED" ? "账号已注销，必要历史关联保留。" : "账号已停用，当前会话和待用验证凭据已撤销。" }, requestId);
}

export async function handleUserIdentityRoute(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  options: AuthSecurityOptions,
): Promise<boolean> {
  const requestId = ensureApiV1RequestId(request);
  const path = routePath(request);
  const supported = new Set([
    "/identity/status",
    "/identity/verify",
    "/trade-eligibility/check",
    "/account/deactivate",
    "/account/cancel",
  ]);
  if (!supported.has(path)) return false;
  response.setHeader("X-Request-Id", requestId);
  if (!originAllowed(request, [options.apiOrigin, options.userOrigin])) {
    sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
    return true;
  }
  const method = request.method?.toUpperCase() ?? "";
  const readOnlyPath = path === "/identity/status";
  const writePath = path === "/identity/verify" || path === "/trade-eligibility/check" || path === "/account/deactivate" || path === "/account/cancel";
  if ((readOnlyPath && method !== "GET") || (writePath && method !== "POST")) {
    sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
    return true;
  }
  try {
    const context = await readUserContext(request, options);
    if (readOnlyPath) {
      const state = await readState(options.pool, context.userId);
      sendJson(response, 200, {
        accountStatus: state?.accountStatus ?? "ACTIVE",
        identityStatus: state?.identityStatus ?? "UNVERIFIED",
        ageStatus: state?.ageStatus ?? "UNKNOWN",
        provider: state?.provider ?? "none",
        eligibleForProtectedTrade: state?.identityStatus === "VERIFIED" && state.ageStatus === "ADULT",
      }, requestId);
      return true;
    }
    if (path === "/identity/verify") await verifyIdentity(request, response, requestId, options, context);
    else if (path === "/trade-eligibility/check") await checkProtectedTradeEligibility(request, response, requestId, options, context);
    else if (path === "/account/deactivate") await changeAccountState(request, response, requestId, options, context, "DEACTIVATED");
    else await changeAccountState(request, response, requestId, options, context, "CANCELLED");
    return true;
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestId);
    else sendInternalError(response, requestId);
    return true;
  }
}
