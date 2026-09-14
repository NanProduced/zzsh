import type { INestApplication } from "@nestjs/common";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import {
  ADMIN_PERMISSION,
  fieldAccessFrom,
  hasPermission,
  loadEffectiveAdminAccess,
} from "./admin-authorization";
import {
  assignAdministratorAccess,
  createAdministrator,
  createRole,
  listAdministrators,
  listRolesAndCatalog,
  lockActor,
  nextAdminLogin,
  readAdministratorDetail,
  requireDirectoryPermission,
  updateAdministrator,
  updateRole,
} from "./admin-directory";
import {
  recordAudit,
  SecurityApiError,
  setAuditContext,
  withTransaction,
} from "./security-core";
import { handleAdminApprovalRoute } from "./approval-audit";
import { handleAdminAuditRoute } from "./admin-audit";
import {
  listRestorableUsers,
  restoreDeactivatedUserAccount,
  type RealNameProvider,
  type UserObligationReader,
} from "./user-identity";

export { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";

export type AuthSecurityNodeRequest = {
  method?: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
};

export type AuthSecurityNodeResponse = {
  headersSent?: boolean;
  setHeader: (name: string, value: string | string[]) => AuthSecurityNodeResponse;
  status: (status: number) => AuthSecurityNodeResponse;
  json: (body: unknown) => void;
};

type NodeRequest = AuthSecurityNodeRequest;
type NodeResponse = AuthSecurityNodeResponse;

type SessionState = {
  user?: {
    id?: string;
    name?: string;
    email?: string;
    username?: string;
    displayUsername?: string;
    suspended?: boolean;
    twoFactorEnabled?: boolean;
  };
  session?: {
    id?: string;
    userId?: string;
    token?: string;
    locked?: boolean;
    createdAt?: Date | string;
    expiresAt?: Date | string;
  };
} | null;

type AuthApi = {
  getSession: (options: { headers: Headers }) => Promise<SessionState>;
  verifyPassword?: (options: { body: { password: string }; headers: Headers }) => Promise<unknown>;
  verifyTOTP?: (options: { body: { code: string }; headers: Headers }) => Promise<unknown>;
};

type AuthLike = { api: AuthApi };
type PasswordHasher = (password: string) => Promise<string>;
type PasswordVerifier = (password: string, hash: string) => Promise<boolean>;

export type AdminSecurityNotification = {
  event: "admin.frozen" | "admin.unfrozen" | "admin.recovery.issued" | "admin.recovery.completed" | "admin.recovery.disaster.issued";
  /** Stable outbox id supplied to a delivery adapter for idempotent retries. */
  eventId?: string;
  actorId: string;
  targetAdminId: string;
  reason?: string;
  requestId: string;
};

export type AuthSecurityOptions = {
  pool: Pool;
  adminAuth: AuthLike;
  userAuth: AuthLike;
  apiOrigin: string;
  adminOrigin: string;
  userOrigin: string;
  adminBootstrapSecret?: string;
  notifyAdminSecurity?: (notification: AdminSecurityNotification) => Promise<void>;
  hashPassword: PasswordHasher;
  verifyPassword: PasswordVerifier;
  rateLimitState: Map<string, { failures: number; resetAt: number }>;
  securityVerificationBudget: { inFlight: number };
  realNameProvider: RealNameProvider;
  userObligationReader: UserObligationReader;
  testOperationsEnabled: boolean;
};

type Credentials = {
  headers: Headers;
  conflict: boolean;
  malformed: boolean;
};

export type AdminContext = {
  userId: string;
  sessionId: string;
  credentials: Credentials;
  security: { status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN"; isBoss: boolean; passwordChangeRequired: boolean };
  sessionLocked: boolean;
};

const SECURITY_ADVISORY_LOCK = 805101;
const RECOVERY_TTL_MS = 10 * 60 * 1000;
const SECURITY_RATE_LIMIT_MAX_FAILURES = 5;
const SECURITY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const SECURITY_RATE_LIMIT_MAX_BUCKETS = 1024;
const SECURITY_VERIFICATION_MAX_IN_FLIGHT = 128;
const NOTIFICATION_CLAIM_LEASE_MS = 30 * 1000;
const NOTIFICATION_MAX_BACKOFF_MS = 5 * 60 * 1000;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rateLimitKey(request: NodeRequest, scope: string, principal?: string): string {
  const nodeRequest = request as NodeRequest & { ip?: string; socket?: { remoteAddress?: string } };
  const address = nodeRequest.ip ?? nodeRequest.socket?.remoteAddress ?? "anonymous";
  return `${scope}:${principal ?? "anonymous"}:${address}`;
}

function pruneExpiredRateLimitBuckets(state: AuthSecurityOptions["rateLimitState"], now: number): void {
  for (const [key, bucket] of state) {
    if (bucket.resetAt <= now) state.delete(key);
  }
}

function checkRateLimit(options: AuthSecurityOptions, key: string): void {
  const state = options.rateLimitState;
  const now = Date.now();
  pruneExpiredRateLimitBuckets(state, now);
  const bucket = state.get(key);
  if (!bucket) return;
  if (bucket.failures >= SECURITY_RATE_LIMIT_MAX_FAILURES) {
    throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "Too many authentication attempts");
  }
}

function recordRateLimitFailure(options: AuthSecurityOptions, key: string): void {
  const state = options.rateLimitState;
  const now = Date.now();
  pruneExpiredRateLimitBuckets(state, now);
  const current = state.get(key);
  if (!current && state.size >= SECURITY_RATE_LIMIT_MAX_BUCKETS) {
    // ponytail: bounded process-local table; use a shared limiter before multi-instance rollout.
    throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "Too many authentication attempts");
  }
  const bucket = current ?? { failures: 0, resetAt: now + SECURITY_RATE_LIMIT_WINDOW_MS };
  bucket.failures += 1;
  state.set(key, bucket);
}

function clearRateLimit(options: AuthSecurityOptions, key: string): void {
  options.rateLimitState.delete(key);
}

function acquireSecurityVerificationBudget(options: AuthSecurityOptions): () => void {
  const budget = options.securityVerificationBudget;
  if (budget.inFlight >= SECURITY_VERIFICATION_MAX_IN_FLIGHT) {
    // ponytail: process-local in-flight gate; use a shared limiter before multi-instance rollout.
    throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "Too many authentication verifications in progress");
  }
  budget.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budget.inFlight -= 1;
  };
}

function originAllowed(request: NodeRequest, origins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return origins.includes(origin);
}

function credentialsFromHeaders(headers: Headers): Credentials {
  const cookie = headers.get("cookie") ?? "";
  const authorization = headers.get("authorization") ?? "";
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

function credentialsOf(request: AuthSecurityNodeRequest): Credentials {
  return credentialsFromHeaders(new Headers({
    ...(headerValue(request.headers.cookie) ? { cookie: headerValue(request.headers.cookie)! } : {}),
    ...(headerValue(request.headers.authorization) ? { authorization: headerValue(request.headers.authorization)! } : {}),
  }));
}

const AUTH_SESSION_EXEMPT_PATHS = new Set(["/get-session", "/sign-out"]);
const ADMIN_ENROLLMENT_PATHS = new Set(["/two-factor/enable", "/two-factor/get-totp-uri", "/two-factor/verify-totp"]);
const ADMIN_PASSWORD_BOOTSTRAP_PATHS = new Set(["/change-password"]);

export type AuthRealmSecurityPreflightOptions = {
  realm: "user" | "admin";
  auth: AuthLike;
  pool: Pool;
};

export async function preflightAuthRealmSecurity(
  request: AuthSecurityNodeRequest,
  path: string,
  options: AuthRealmSecurityPreflightOptions,
): Promise<SecurityApiError | null> {
  const credentials = credentialsOf(request);
  if (credentials.malformed || credentials.conflict) {
    return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request rejected");
  }
  const current = await options.auth.api.getSession({ headers: credentials.headers });
  if (current?.user?.suspended && path !== "/sign-out") {
    return new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  }
  if (options.realm === "user" && current?.user?.id && path !== "/sign-out") {
    const state = await options.pool.query<{ accountStatus: string }>(
      `SELECT "account_status" AS "accountStatus" FROM "zzsh_iam"."user_identity_state" WHERE "user_id" = $1`,
      [current.user.id],
    );
    if (state.rows[0]?.accountStatus && state.rows[0].accountStatus !== "ACTIVE") {
      return new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
    }
  }
  if (options.realm !== "admin") return null;
  if (current?.user?.id) {
    const security = await readAdminSecurity(options.pool, current.user.id);
    if (!security) return new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable");
    if (security.status === "FROZEN" && path !== "/sign-out") {
      return new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
    }
    if (current.session?.locked && !AUTH_SESSION_EXEMPT_PATHS.has(path)) {
      return new SecurityApiError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked");
    }
    if (security.passwordChangeRequired && security.status === "PENDING_ENROLLMENT" &&
      !AUTH_SESSION_EXEMPT_PATHS.has(path) && !ADMIN_PASSWORD_BOOTSTRAP_PATHS.has(path)) {
      return new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Password change required");
    }
    if ((!current.user.twoFactorEnabled || security.status === "PENDING_ENROLLMENT") &&
      !AUTH_SESSION_EXEMPT_PATHS.has(path) && !ADMIN_ENROLLMENT_PATHS.has(path) && !ADMIN_PASSWORD_BOOTSTRAP_PATHS.has(path)) {
      return new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required");
    }
  } else if (current?.session?.locked && !AUTH_SESSION_EXEMPT_PATHS.has(path)) {
    return new SecurityApiError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked");
  }
  return null;
}

function sendJson(response: NodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

function sendError(response: NodeResponse, error: SecurityApiError, requestId: string): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message, requestId } }, requestId);
}

function sendInternalError(response: NodeResponse, requestId: string): void {
  sendJson(response, 500, {
    error: { code: API_V1_ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", requestId },
  }, requestId);
}

function sendSuccess(response: NodeResponse, body: unknown, requestId: string): void {
  sendJson(response, 200, body, requestId);
}

function bodyOf(request: NodeRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, maxLength = 256): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return value;
}

function pinField(body: Record<string, unknown>, field: string): string {
  const value = stringField(body, field, 6);
  if (!/^\d{6}$/.test(value)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "PIN must contain six digits");
  return value;
}

function passwordField(body: Record<string, unknown>, field: string): string {
  const value = stringField(body, field, 256);
  if (value.length < 12) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Password does not meet the minimum length");
  return value;
}

function recoveryCredentialField(body: Record<string, unknown>): string {
  const value = stringField(body, "targetRecoveryCredential", 256);
  if (value.length < 32) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Recovery credential is invalid");
  return value;
}

function reasonField(body: Record<string, unknown>): string {
  const value = stringField(body, "reason", 500).trim();
  if (value.length < 3) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "A reason is required");
  return value;
}

function sameSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function recoveryTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function routePath(request: NodeRequest, prefix: string): string {
  const source = request.originalUrl ?? request.url ?? "/";
  const withoutQuery = source.split("?", 1)[0] || "/";
  if (withoutQuery === prefix) return "/";
  if (withoutQuery.startsWith(`${prefix}/`)) return withoutQuery.slice(prefix.length) || "/";
  return withoutQuery;
}

async function readAdminSecurity(pool: Pool | PoolClient, userId: string): Promise<AdminContext["security"] | null> {
  const result = await pool.query<{ status: AdminContext["security"]["status"]; isBoss: boolean; passwordChangeRequired: boolean }>(
    `SELECT "status", "is_boss" AS "isBoss", "password_change_required" AS "passwordChangeRequired" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function readAdminContext(
  request: AuthSecurityNodeRequest,
  options: AuthSecurityOptions,
  mode: { allowPending?: boolean; allowLocked?: boolean } = {},
): Promise<AdminContext> {
  const credentials = credentialsOf(request);
  if (credentials.conflict || credentials.malformed) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request rejected");
  }
  const current = await options.adminAuth.api.getSession({ headers: credentials.headers });
  const userId = current?.user?.id;
  const sessionId = current?.session?.id;
  if (!userId || !sessionId) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  const security = await readAdminSecurity(options.pool, userId);
  if (!security) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable");
  if (security.status === "FROZEN") throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  if (!mode.allowPending && security.status !== "ACTIVE") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required");
  }
  if (!mode.allowPending && current.user?.twoFactorEnabled !== true) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required");
  }
  if (!mode.allowLocked && current.session?.locked) {
    throw new SecurityApiError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked");
  }
  return {
    userId,
    sessionId,
    credentials,
    security,
    sessionLocked: current.session?.locked === true,
  };
}

/** Strict supply-context recheck; the session ID comes from prior SDK authentication. */
export async function assertAdminContextInTransaction(client: PoolClient, context: {userId:string;sessionId:string}): Promise<void> {
  const session = (await client.query<{locked:boolean;twoFactorEnabled:boolean}>(`SELECT s."locked",u."twoFactorEnabled" FROM "zzsh_auth_admin"."session" s JOIN "zzsh_auth_admin"."user" u ON u."id"=s."userId" WHERE s."id"=$1 AND s."userId"=$2 AND s."expiresAt">clock_timestamp()`, [context.sessionId,context.userId])).rows[0];
  if (!session) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  const security = await readAdminSecurity(client, context.userId);
  if (!security) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable");
  if (security.status === "FROZEN") throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  if (security.status !== "ACTIVE" || session.twoFactorEnabled !== true) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required");
  if (session.locked) throw new SecurityApiError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked");
}

export type AdminSessionSnapshot =
  | { authenticated: false }
  | {
      authenticated: true;
      adminUserId: string;
      user: { name?: string; email?: string; username?: string; displayUsername?: string; twoFactorEnabled: boolean };
      security: { status: AdminContext["security"]["status"]; isBoss: boolean; passwordChangeRequired: boolean };
      session: { id: string; locked: boolean; pinConfigured: boolean; createdAt: string | null; expiresAt: string | null };
      permissions: string[];
    };

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

export async function getAdminSessionSnapshot(headers: Headers, options: AuthSecurityOptions): Promise<AdminSessionSnapshot> {
  const credentials = credentialsFromHeaders(headers);
  if (credentials.conflict || credentials.malformed) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request rejected");
  }
  const current = await options.adminAuth.api.getSession({ headers: credentials.headers });
  const userId = current?.user?.id;
  const sessionId = current?.session?.id;
  if (!userId || !sessionId || current?.user?.suspended) return { authenticated: false };
  const security = await readAdminSecurity(options.pool, userId);
  if (!security || security.status === "FROZEN") return { authenticated: false };
  const session = await options.pool.query<{ pinConfigured: boolean }>(
    `SELECT "pinHash" IS NOT NULL AS "pinConfigured" FROM "zzsh_auth_admin"."session" WHERE "id" = $1`,
    [sessionId],
  );
  const access = await loadEffectiveAdminAccess(options.pool, userId);
  return {
    authenticated: true,
    adminUserId: userId,
    user: {
      ...(current.user?.name ? { name: current.user.name } : {}),
      ...(current.user?.email ? { email: current.user.email } : {}),
      ...(current.user?.username ? { username: current.user.username } : {}),
      ...(current.user?.displayUsername ? { displayUsername: current.user.displayUsername } : {}),
      twoFactorEnabled: current.user?.twoFactorEnabled === true,
    },
    security: { status: security.status, isBoss: security.isBoss, passwordChangeRequired: security.passwordChangeRequired },
    session: {
      id: sessionId,
      locked: current.session?.locked === true,
      pinConfigured: session.rows[0]?.pinConfigured === true,
      createdAt: isoDate(current.session?.createdAt),
      expiresAt: isoDate(current.session?.expiresAt),
    },
    permissions: access ? [...access.permissions].sort() : [],
  };
}

export async function queueAdminSecurityNotification(
  client: PoolClient,
  notification: AdminSecurityNotification,
): Promise<string> {
  const id = `notification_${randomUUID().replaceAll("-", "")}`;
  await client.query(
    `INSERT INTO "zzsh_iam"."admin_security_notification_outbox"
      ("id", "event", "actor_id", "target_admin_id", "reason", "request_id")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, notification.event, notification.actorId, notification.targetAdminId, notification.reason ?? null, notification.requestId],
  );
  return id;
}

export type AdminSecurityNotificationRetryResult = {
  claimed: number;
  delivered: number;
  failed: number;
  lostClaim: number;
};

type NotificationOutboxRow = {
  id: string;
  event: AdminSecurityNotification["event"];
  actorId: string;
  targetAdminId: string;
  reason: string | null;
  requestId: string;
  attempts: number;
  claimToken: string;
};

function notificationBackoffMs(attempts: number): number {
  // ponytail: bounded exponential retry is enough for the local outbox seam; add a scheduler policy when a real channel is authorized.
  return Math.min(NOTIFICATION_MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(9, Math.max(0, attempts - 1)));
}

async function claimPendingAdminSecurityNotifications(
  pool: Pool,
  options: { batchSize: number; leaseMs: number; outboxIds?: readonly string[] },
): Promise<NotificationOutboxRow[]> {
  const idsFilter = options.outboxIds ? `AND "id" = ANY($3::text[])` : "";
  const queryValues: unknown[] = options.outboxIds
    ? [options.batchSize, options.leaseMs, [...options.outboxIds]]
    : [options.batchSize, options.leaseMs];
  return withTransaction(pool, async (client) => {
    const selected = await client.query<Omit<NotificationOutboxRow, "claimToken"> & { claimToken: string | null }>(
      `SELECT "id", "event", "actor_id" AS "actorId", "target_admin_id" AS "targetAdminId", "reason", "request_id" AS "requestId", "attempts", "claim_token" AS "claimToken"
         FROM "zzsh_iam"."admin_security_notification_outbox"
        WHERE "status" = 'PENDING'
          AND "next_attempt_at" <= clock_timestamp()
          AND ("claimed_at" IS NULL OR "claimed_at" <= clock_timestamp() - ($2::bigint * interval '1 millisecond'))
          ${idsFilter}
        ORDER BY "next_attempt_at", "created_at", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      queryValues,
    );
    const claimed: NotificationOutboxRow[] = [];
    for (const row of selected.rows) {
      const claimToken = `claim_${randomUUID().replaceAll("-", "")}`;
      const updated = await client.query<{ attempts: number }>(
        `UPDATE "zzsh_iam"."admin_security_notification_outbox"
            SET "claimed_at" = clock_timestamp(), "claim_token" = $1, "attempts" = "attempts" + 1
          WHERE "id" = $2 AND "status" = 'PENDING'
        RETURNING "attempts"`,
        [claimToken, row.id],
      );
      if (updated.rows[0]) claimed.push({ ...row, attempts: updated.rows[0].attempts, claimToken });
    }
    return claimed;
  });
}

async function hasActiveNotificationClaim(pool: Pool, row: NotificationOutboxRow, leaseMs: number): Promise<boolean> {
  // ponytail: one bounded validation query per claimed row prevents a slow batch worker from sending after lease loss.
  const active = await pool.query(
    `SELECT 1
       FROM "zzsh_iam"."admin_security_notification_outbox"
      WHERE "id" = $1
        AND "status" = 'PENDING'
        AND "claim_token" = $2
        AND "claimed_at" > clock_timestamp() - ($3::bigint * interval '1 millisecond')`,
    [row.id, row.claimToken, leaseMs],
  );
  return active.rowCount === 1;
}

export async function retryPendingAdminSecurityNotifications(
  pool: Pool,
  notify: (notification: AdminSecurityNotification) => Promise<void>,
  options: { batchSize?: number; leaseMs?: number; outboxIds?: readonly string[] } = {},
): Promise<AdminSecurityNotificationRetryResult> {
  const batchSize = options.batchSize ?? 50;
  const leaseMs = options.leaseMs ?? NOTIFICATION_CLAIM_LEASE_MS;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("notification batch size is invalid");
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 10 * 60 * 1000) throw new Error("notification claim lease is invalid");
  const claimed = await claimPendingAdminSecurityNotifications(pool, { batchSize, leaseMs, outboxIds: options.outboxIds });
  const result: AdminSecurityNotificationRetryResult = { claimed: claimed.length, delivered: 0, failed: 0, lostClaim: 0 };
  for (const row of claimed) {
    const notification: AdminSecurityNotification = {
      event: row.event,
      eventId: row.id,
      actorId: row.actorId,
      targetAdminId: row.targetAdminId,
      ...(row.reason ? { reason: row.reason } : {}),
      requestId: row.requestId,
    };
    if (!await hasActiveNotificationClaim(pool, row, leaseMs)) {
      result.lostClaim += 1;
      continue;
    }
    try {
      await notify(notification);
      const delivered = await pool.query(
        `UPDATE "zzsh_iam"."admin_security_notification_outbox"
            SET "status" = 'DELIVERED', "last_error" = NULL, "delivered_at" = clock_timestamp(),
                "claimed_at" = NULL, "claim_token" = NULL
          WHERE "id" = $1 AND "status" = 'PENDING' AND "claim_token" = $2
            AND "claimed_at" > clock_timestamp() - ($3::bigint * interval '1 millisecond')`,
        [row.id, row.claimToken, leaseMs],
      );
      if (delivered.rowCount === 1) result.delivered += 1;
      else result.lostClaim += 1;
    } catch {
      const failed = await pool.query(
        `UPDATE "zzsh_iam"."admin_security_notification_outbox"
            SET "status" = 'PENDING', "last_error" = 'delivery_failed', "delivered_at" = NULL,
                "next_attempt_at" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
                "claimed_at" = NULL, "claim_token" = NULL
          WHERE "id" = $1 AND "status" = 'PENDING' AND "claim_token" = $2
            AND "claimed_at" > clock_timestamp() - ($4::bigint * interval '1 millisecond')`,
        [row.id, row.claimToken, notificationBackoffMs(row.attempts), leaseMs],
      );
      if (failed.rowCount === 1) result.failed += 1;
      else result.lostClaim += 1;
    }
  }
  return result;
}

async function deliverAdminSecurityNotification(
  options: AuthSecurityOptions,
  outboxId: string,
): Promise<void> {
  if (!options.notifyAdminSecurity) return;
  try {
    await retryPendingAdminSecurityNotifications(options.pool, options.notifyAdminSecurity, { outboxIds: [outboxId], batchSize: 1 });
  } catch {
    // The committed security mutation remains authoritative; a later outbox retry must reconcile delivery.
  }
}

async function requireBoss(context: AdminContext, options: AuthSecurityOptions): Promise<void> {
  if (!context.security.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
  const current = await readAdminSecurity(options.pool, context.userId);
  if (!current?.isBoss || current.status !== "ACTIVE") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
  }
}

async function verifyAdminReauthentication(
  request: NodeRequest,
  context: AdminContext,
  body: Record<string, unknown>,
  options: AuthSecurityOptions,
): Promise<void> {
  const password = passwordField(body, "password");
  const code = stringField(body, "totpCode", 16);
  if (!/^\d{6}$/.test(code)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Two-factor code is invalid");
  const key = rateLimitKey(request, "admin.reauthentication", context.userId);
  checkRateLimit(options, key);
  const releaseVerificationBudget = acquireSecurityVerificationBudget(options);
  try {
    if (!options.adminAuth.api.verifyPassword || !options.adminAuth.api.verifyTOTP) throw new Error("reauthentication API unavailable");
    const verifiedPassword = await options.adminAuth.api.verifyPassword({ body: { password }, headers: context.credentials.headers });
    const verifiedTotp = await options.adminAuth.api.verifyTOTP({ body: { code }, headers: context.credentials.headers });
    if ((verifiedPassword as { status?: boolean } | undefined)?.status === false || (verifiedTotp as { status?: boolean } | undefined)?.status === false) {
      throw new Error("reauthentication rejected");
    }
    clearRateLimit(options, key);
  } catch {
    recordRateLimitFailure(options, key);
    throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Password and two-factor verification are required");
  } finally {
    releaseVerificationBudget();
  }
}

async function bootstrapAdmin(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  if (!options.adminBootstrapSecret) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Controlled bootstrap is unavailable");
  const body = bodyOf(request);
  const bootstrapSecret = stringField(body, "bootstrapSecret", 256);
  if (!sameSecret(bootstrapSecret, options.adminBootstrapSecret)) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Controlled bootstrap is unavailable");
  }
  if (body.username !== undefined) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Administrator login is generated by the server");
  const email = body.email === undefined ? undefined : stringField(body, "email", 320).trim().toLowerCase();
  const name = stringField(body, "name", 120).trim();
  const password = passwordField(body, "password");
  if (!name || (email !== undefined && !email.includes("@"))) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  const passwordHash = await options.hashPassword(password);
  const result = await withTransaction(options.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [SECURITY_ADVISORY_LOCK]);
    const now = new Date();
    const bosses = await client.query<{ id: string; status: AdminContext["security"]["status"]; bootstrapExpiresAt: Date | null; firstActivatedAt: Date | null }>(
      `SELECT "admin_user_id" AS id, "status", "bootstrap_expires_at" AS "bootstrapExpiresAt", "first_activated_at" AS "firstActivatedAt"
         FROM "zzsh_iam"."admin_security" WHERE "is_boss" = true FOR UPDATE`,
    );
    const expiredPendingBosses = bosses.rows.filter((boss) => boss.status === "PENDING_ENROLLMENT" && !boss.firstActivatedAt && (!boss.bootstrapExpiresAt || boss.bootstrapExpiresAt.getTime() <= now.getTime()));
    if (expiredPendingBosses.length > 0) {
      await setAuditContext(client, "system", undefined, undefined, requestId);
      for (const boss of expiredPendingBosses) {
        // Controlled reinitialization only removes an expired bootstrap identity with no immutable activation evidence.
        await client.query(`DELETE FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`, [boss.id]);
        await client.query(`DELETE FROM "zzsh_auth_admin"."user" WHERE "id" = $1`, [boss.id]);
      }
    }
    const remainingBosses = await client.query<{ id: string }>(
      `SELECT "admin_user_id" AS id FROM "zzsh_iam"."admin_security" WHERE "is_boss" = true FOR UPDATE`,
    );
    if (remainingBosses.rows.length >= 2) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "The two boss accounts already exist");
    const login = await nextAdminLogin(client);
    const loginEmail = email ?? `${login.username}@admin.zzsh.invalid`;
    const duplicate = await client.query(
      `SELECT "id" FROM "zzsh_auth_admin"."user" WHERE "email" = $1 OR "username" = $2 LIMIT 1`,
      [loginEmail, login.username],
    );
    if (duplicate.rows.length > 0) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator identity already exists");
    const id = `admin_${randomUUID().replaceAll("-", "")}`;
    await setAuditContext(client, "system", undefined, undefined, requestId);
    await client.query(
      `INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
       VALUES ($1, $2, $3, $4, $4, $5, $6, false, false)`,
      [id, name, loginEmail, now, login.username, login.displayUsername],
    );
    await client.query(
      `INSERT INTO "zzsh_auth_admin"."account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
      [`account_${randomUUID().replaceAll("-", "")}`, id, passwordHash, now],
    );
    await client.query(
      `INSERT INTO "zzsh_iam"."admin_security" ("admin_user_id", "status", "is_boss", "password_change_required", "bootstrap_expires_at")
       VALUES ($1, 'PENDING_ENROLLMENT', true, true, $2)`,
      [id, new Date(now.getTime() + 15 * 60 * 1000)],
    );
    await recordAudit(client, {
      actorType: "system",
      action: "admin.bootstrap.created",
      objectType: "admin_user",
      objectId: id,
      outcome: "SUCCESS",
      requestId,
      details: { isBoss: true },
    });
    return {
      adminUserId: id,
      username: login.username,
      displayUsername: login.displayUsername,
      status: "PENDING_ENROLLMENT",
      isBoss: true,
      passwordChangeRequired: true,
    } as const;
  });
  sendSuccess(response, result, requestId);
}

async function activateEnrollment(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options, { allowPending: true });
  if (context.security.status !== "PENDING_ENROLLMENT") {
    throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator enrollment is not pending");
  }
  if (context.security.passwordChangeRequired) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Password change required");
  }
  const current = await options.adminAuth.api.getSession({ headers: context.credentials.headers });
  if (current?.user?.twoFactorEnabled !== true) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Two-factor enrollment is required");
  await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    // Bootstrap lock order: admin_security, then the activation audit mutation.
    const locked = await client.query<{ status: string; passwordChangeRequired: boolean; bootstrapExpiresAt: Date | null; bootstrapUsedAt: Date | null; firstActivatedAt: Date | null }>(
      `SELECT "status", "password_change_required" AS "passwordChangeRequired", "bootstrap_expires_at" AS "bootstrapExpiresAt", "bootstrap_used_at" AS "bootstrapUsedAt", "first_activated_at" AS "firstActivatedAt"
         FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1 FOR UPDATE`,
      [context.userId],
    );
    if (locked.rows[0]?.status !== "PENDING_ENROLLMENT") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator enrollment is not pending");
    if (locked.rows[0]?.passwordChangeRequired) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Password change required");
    if (!locked.rows[0].bootstrapExpiresAt || locked.rows[0].bootstrapExpiresAt.getTime() <= Date.now() || locked.rows[0].bootstrapUsedAt) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator bootstrap has expired");
    }
    await client.query(`UPDATE "zzsh_iam"."admin_security"
       SET "status" = 'ACTIVE',
           "bootstrap_expires_at" = NULL,
           "bootstrap_used_at" = clock_timestamp(),
           "first_activated_at" = COALESCE("first_activated_at", clock_timestamp()),
           "last_full_authenticated_at" = clock_timestamp(),
           "updated_at" = clock_timestamp()
       WHERE "admin_user_id" = $1`, [context.userId]);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.enrollment.activated",
      objectType: "admin_security",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
    });
  });
  sendSuccess(response, { status: "ACTIVE" }, requestId);
}

async function setPin(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const pin = pinField(bodyOf(request), "pin");
  const pinHash = await options.hashPassword(pin);
  await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const session = await client.query<{ pinHash: string | null }>(
      `SELECT "pinHash" FROM "zzsh_auth_admin"."session" WHERE "id" = $1 FOR UPDATE`,
      [context.sessionId],
    );
    if (!session.rows[0]) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
    if (session.rows[0].pinHash) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "PIN is already configured");
    await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinHash" = $1, "pinFailures" = 0, "locked" = false, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [pinHash, context.sessionId]);
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.set", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId });
  });
  sendSuccess(response, { status: "SET" }, requestId);
}

async function changePin(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const body = bodyOf(request);
  const currentPin = pinField(body, "currentPin");
  const nextPin = pinField(body, "newPin");
  const nextHash = await options.hashPassword(nextPin);
  let failure: { status: number; message: string } | undefined;
  await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const session = await client.query<{ pinHash: string | null; pinFailures: number; locked: boolean }>(
      `SELECT "pinHash", "pinFailures", "locked" FROM "zzsh_auth_admin"."session" WHERE "id" = $1 FOR UPDATE`,
      [context.sessionId],
    );
    const row = session.rows[0];
    if (!row || !row.pinHash) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "PIN is not configured");
    if (row.locked) throw new SecurityApiError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked");
    if (!await options.verifyPassword(currentPin, row.pinHash)) {
      const pinFailures = row.pinFailures + 1;
      const locked = pinFailures >= 5;
      await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinFailures" = $1, "locked" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $3`, [pinFailures, locked, context.sessionId]);
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.change", objectType: "admin_session", objectId: context.sessionId, outcome: "FAILURE", requestId, reason: locked ? "pin_attempt_limit" : "invalid_pin", details: { pinFailures, locked } });
      failure = { status: locked ? 423 : 401, message: locked ? "Account locked" : "PIN rejected" };
      return;
    }
    await client.query(`UPDATE "zzsh_auth_admin"."session" SET "pinHash" = $1, "pinFailures" = 0, "updatedAt" = clock_timestamp() WHERE "id" = $2`, [nextHash, context.sessionId]);
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.change", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId });
  });
  if (failure) throw new SecurityApiError(failure.status, failure.status === 423 ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.UNAUTHENTICATED, failure.message);
  sendSuccess(response, { status: "CHANGED" }, requestId);
}

async function lockPin(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.locked", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId });
  });
  sendSuccess(response, { status: "LOCKED" }, requestId);
}

async function unlockPin(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.unlock", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId, details: { method: "pin" } });
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
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.pin.unlock", objectType: "admin_session", objectId: context.sessionId, outcome: "SUCCESS", requestId, details: { method: "password_2fa", pinReset: nextHash !== undefined } });
  });
  sendSuccess(response, { status: "UNLOCKED", method: "PASSWORD_2FA", pinReset: nextHash !== undefined }, requestId);
}

async function changeAdminFreezeState(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions, state: "FROZEN" | "ACTIVE"): Promise<void> {
  const context = await readAdminContext(request, options);
  const requiredPermission = state === "FROZEN" ? ADMIN_PERMISSION.accountFreeze : ADMIN_PERMISSION.accountUnfreeze;
  await requireDirectoryPermission(options.pool, context.userId, requiredPermission);
  const body = bodyOf(request);
  const targetAdminId = stringField(body, "targetAdminId", 128);
  const reason = reasonField(body);
  await verifyAdminReauthentication(request, context, body, options);
  if (targetAdminId === context.userId) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "A boss cannot change its own availability");
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
      resultingStatus = "FROZEN";
    } else {
      if (target.rows[0].status !== "FROZEN") throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Administrator is not frozen");
      const nextStatus = targetUser.rows[0].twoFactorEnabled && target.rows[0].firstActivatedAt ? "ACTIVE" : "PENDING_ENROLLMENT";
      const pendingWindow = target.rows[0].isBoss ? "15 minutes" : "7 days";
      await client.query(`UPDATE "zzsh_iam"."admin_security"
         SET "status" = $1,
             "bootstrap_expires_at" = CASE WHEN $1 = 'PENDING_ENROLLMENT' AND ("bootstrap_expires_at" IS NULL OR "bootstrap_expires_at" <= clock_timestamp()) THEN clock_timestamp() + $3::interval ELSE "bootstrap_expires_at" END,
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

async function listRestorableUserCandidates(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  await requireDirectoryPermission(options.pool, context.userId, ADMIN_PERMISSION.userAccountRestore);
  const search = queryValue(request, "query");
  if (!search) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Search text is required");
  sendSuccess(response, await listRestorableUsers(options.pool, search), requestId);
}

async function restoreUserAccount(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const body = bodyOf(request);
  const targetUserId = stringField(body, "targetUserId", 128);
  const reason = reasonField(body);
  await verifyAdminReauthentication(request, context, body, options);
  const result = await restoreDeactivatedUserAccount(context, targetUserId, reason, requestId, options);
  sendSuccess(response, {
    status: result.status,
    target: { id: result.id, username: result.username, name: result.name },
    revokedSessions: result.revokedSessions,
    revokedVerifications: result.revokedVerifications,
    message: "用户账号已恢复为 ACTIVE；旧会话和验证凭据不会复活，请让用户重新登录。",
  }, requestId);
}

async function forceLogoutAdmin(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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

async function listAdminDirectory(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const access = await requireDirectoryPermission(options.pool, context.userId, ADMIN_PERMISSION.accountRead);
  sendSuccess(response, await listAdministrators(options.pool, fieldAccessFrom(access)), requestId);
}

async function readAdminDirectoryDetail(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const access = await requireDirectoryPermission(options.pool, context.userId, ADMIN_PERMISSION.accountRead);
  const username = queryValue(request, "username");
  if (!username) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Administrator login is required");
  sendSuccess(response, await readAdministratorDetail(options.pool, username, fieldAccessFrom(access)), requestId);
}

async function listAdminRoles(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  const access = await loadEffectiveAdminAccess(options.pool, context.userId);
  const fields = fieldAccessFrom(access);
  if (!fields.roleRead && !fields.permissionRead) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
  sendSuccess(response, await listRolesAndCatalog(options.pool, fields), requestId);
}

async function handleCreateAdministrator(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  sendSuccess(response, await createAdministrator(context, bodyOf(request), requestId, options), requestId);
}

async function handleUpdateAdministrator(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  sendSuccess(response, await updateAdministrator(context, bodyOf(request), requestId, options), requestId);
}

async function handleAssignAdministrator(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  sendSuccess(response, await assignAdministratorAccess(context, bodyOf(request), requestId, options), requestId);
}

async function handleCreateRole(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  sendSuccess(response, await createRole(context, bodyOf(request), requestId, options), requestId);
}

async function handleUpdateRole(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
  const context = await readAdminContext(request, options);
  sendSuccess(response, await updateRole(context, bodyOf(request), requestId, options), requestId);
}

function queryValue(request: NodeRequest, name: string): string | undefined {
  const source = request.originalUrl ?? request.url ?? "";
  const index = source.indexOf("?");
  if (index < 0) return undefined;
  const value = new URLSearchParams(source.slice(index + 1)).get(name);
  return value && value.length > 0 ? value : undefined;
}

async function listPendingRecovery(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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

async function requestRecovery(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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
    if (error instanceof SecurityApiError && error.status === 401) recordRateLimitFailure(options, rateKey);
    throw error;
  } finally {
    releaseVerificationBudget();
  }
  sendSuccess(response, result, requestId);
}

async function confirmRecovery(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "admin.recovery.issued", objectType: "admin_recovery_request", objectId: recoveryRequestId, outcome: "SUCCESS", requestId, details: { targetAdminId: requestRow.targetAdminId, targetIsBoss: target.rows[0].isBoss, targetStatus: target.rows[0].status } });
    const notification = { event: "admin.recovery.issued", actorId: context.userId, targetAdminId: requestRow.targetAdminId, requestId } satisfies AdminSecurityNotification;
    const notificationId = await queueAdminSecurityNotification(client, notification);
    return { response: { status: "ISSUED" }, notification, notificationId };
  });
  await deliverAdminSecurityNotification(options, result.notificationId);
  sendSuccess(response, result.response, requestId);
}

async function completeRecovery(request: NodeRequest, response: NodeResponse, requestId: string, options: AuthSecurityOptions): Promise<void> {
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

export type LegacyCredentialOutcome = "retry" | "none";

export type LegacyCredentialLookup = { username: string } | { phoneNumber: string };

/**
 * Server-side legacy password compatibility, invoked only after the standard sign-in endpoint
 * has already rejected the credentials. That position guarantees Better Auth's rate limiter and
 * body validation ran first, so an invalid body or a rate-limited request can never reach this
 * function. It returns "retry" when the standard sign-in should be executed once more:
 * - the account still carries a recognized legacy MD5 credential and the supplied password
 *   verifies: the current hash is written, the legacy columns are cleared and the audit row is
 *   committed in one transaction, serialized on the account row; or
 * - the account no longer carries a legacy credential but the supplied password verifies
 *   against the current hash, which recovers a concurrent first login that lost the upgrade
 *   race. Every other rejection (wrong password, suspended/inactive account, unknown legacy
 *   version) stays a rejection and never touches the credential.
 */
export async function attemptLegacyCredentialUpgrade(
  pool: Pool,
  verifyPassword: PasswordVerifier,
  hashPassword: PasswordHasher,
  lookup: LegacyCredentialLookup,
  password: string,
  requestId: string,
): Promise<LegacyCredentialOutcome> {
  return withTransaction(pool, async (client) => {
    const account = await client.query<{
      id: string;
      userId: string;
      password: string | null;
      legacyPasswordMd5: string | null;
      legacyPasswordVersion: string | null;
      legacyPasswordSalt: string | null;
      suspended: boolean;
      accountStatus: string;
    }>(
      `SELECT a."id", a."userId", a."password", a."legacyPasswordMd5", a."legacyPasswordVersion", a."legacyPasswordSalt",
              u."suspended", COALESCE(s."account_status", 'ACTIVE') AS "accountStatus"
         FROM "zzsh_auth_user"."account" a
         JOIN "zzsh_auth_user"."user" u ON u."id" = a."userId"
         LEFT JOIN "zzsh_iam"."user_identity_state" s ON s."user_id" = u."id"
        WHERE ${"username" in lookup ? 'u."username" = $1' : 'u."phoneNumber" = $1'} AND a."providerId" = 'credential'
        FOR UPDATE OF a`,
      ["username" in lookup ? lookup.username : lookup.phoneNumber],
    );
    const row = account.rows[0];
    if (!row || row.suspended || row.accountStatus !== "ACTIVE") return "none";
    if (!row.legacyPasswordMd5) {
      if (!row.password) return "none";
      return await verifyPassword(password, row.password) ? "retry" : "none";
    }
    const legacyHash = row.legacyPasswordVersion === "legacy-md5-v1" && row.legacyPasswordSalt !== null
      ? createHash("md5").update(password + row.legacyPasswordSalt, "utf8").digest("hex")
      : row.legacyPasswordVersion === "legacy-md5-v0"
        ? createHash("md5").update(password, "utf8").digest("hex")
        : undefined;
    if (!legacyHash || !sameSecret(row.legacyPasswordMd5, legacyHash)) return "none";
    const passwordHash = await hashPassword(password);
    await setAuditContext(client, "user", row.userId, undefined, requestId);
    const updated = await client.query(
      `UPDATE "zzsh_auth_user"."account"
          SET "password" = $1, "legacyPasswordMd5" = NULL, "legacyPasswordVersion" = NULL, "legacyPasswordSalt" = NULL,
              "legacyPasswordUpgradedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE "id" = $2 AND "legacyPasswordMd5" = $3 AND "legacyPasswordVersion" = $4
          AND "legacyPasswordSalt" IS NOT DISTINCT FROM $5`,
      [passwordHash, row.id, row.legacyPasswordMd5, row.legacyPasswordVersion, row.legacyPasswordSalt],
    );
    if (updated.rowCount !== 1) throw new Error("legacy credential upgrade did not apply");
    await recordAudit(client, { actorType: "user", actorId: row.userId, action: "user.legacy_password.upgraded", objectType: "auth_account", objectId: row.id, outcome: "SUCCESS", requestId });
    return "retry";
  });
}

export async function handleAdminSecurity(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  if (!originAllowed(request, [options.apiOrigin, options.adminOrigin])) {
    sendError(response, new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected"), requestId);
    return;
  }
  try {
    const path = routePath(request, "/api/v1/admin/security");
    if (path.startsWith("/approvals")) return await handleAdminApprovalRoute(request, response, requestId, options, readAdminContext);
    if (path.startsWith("/audit")) return await handleAdminAuditRoute(request, response, requestId, options, readAdminContext);
    if (request.method === "GET") {
      if (path === "/admins") return await listAdminDirectory(request, response, requestId, options);
      if (path === "/admins/detail") return await readAdminDirectoryDetail(request, response, requestId, options);
      if (path === "/roles") return await listAdminRoles(request, response, requestId, options);
      if (path === "/recovery/pending") return await listPendingRecovery(request, response, requestId, options);
      if (path === "/users/restore-candidates") return await listRestorableUserCandidates(request, response, requestId, options);
      sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
      return;
    }
    if (request.method !== "POST") {
      sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
      return;
    }
    if (path === "/bootstrap") return await bootstrapAdmin(request, response, requestId, options);
    if (path === "/enrollment/activate") return await activateEnrollment(request, response, requestId, options);
    if (path === "/pin/set") return await setPin(request, response, requestId, options);
    if (path === "/pin/change") return await changePin(request, response, requestId, options);
    if (path === "/pin/lock") return await lockPin(request, response, requestId, options);
    if (path === "/pin/unlock") return await unlockPin(request, response, requestId, options);
    if (path === "/freeze") return await changeAdminFreezeState(request, response, requestId, options, "FROZEN");
    if (path === "/unfreeze") return await changeAdminFreezeState(request, response, requestId, options, "ACTIVE");
    if (path === "/admins/force-logout") return await forceLogoutAdmin(request, response, requestId, options);
    if (path === "/users/restore") return await restoreUserAccount(request, response, requestId, options);
    if (path === "/admins/create") return await handleCreateAdministrator(request, response, requestId, options);
    if (path === "/admins/update") return await handleUpdateAdministrator(request, response, requestId, options);
    if (path === "/admins/assign") return await handleAssignAdministrator(request, response, requestId, options);
    if (path === "/roles/create") return await handleCreateRole(request, response, requestId, options);
    if (path === "/roles/update") return await handleUpdateRole(request, response, requestId, options);
    if (path === "/recovery/request") return await requestRecovery(request, response, requestId, options);
    if (path === "/recovery/confirm") return await confirmRecovery(request, response, requestId, options);
    if (path === "/recovery/complete") return await completeRecovery(request, response, requestId, options);
    sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
  } catch (error) {
    if (error instanceof SecurityApiError) sendError(response, error, requestId);
    else sendInternalError(response, requestId);
  }
}

export function mountAuthSecurityHandlers(app: INestApplication, options: AuthSecurityOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: NodeRequest, response: NodeResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/admin/security", (request, response) => handleAdminSecurity(request, response, options));
}
