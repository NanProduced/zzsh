import type { INestApplication } from "@nestjs/common";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SupplyGateReader } from "../supply/publishing";

import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import {
  loadEffectiveAdminAccess,
} from "./admin-authorization";
import { deriveDashboardPreset, type DashboardPreset } from "./admin-dashboard-preset";
import { readAdminGameScope, type AdminGameScope } from "./admin-scope";
import {
  listAdminDirectory,
  readAdminDirectoryDetail,
  readAdminGameScopeRoute,
  handleAssignAdministratorGameScope,
  listAdminRoles,
  handleCreateAdministrator,
  handleUpdateAdministrator,
  handleAssignAdministrator,
  handleCreateRole,
  handleUpdateRole,
} from "./admin-directory";
import { setPin, changePin, lockPin, unlockPin } from "./admin-security-pin-routes";
import { changeAdminFreezeState, changeUserAccountFreezeState, changeLoginTwoFactorPreference, revokeSelfSessions, resetAdminCredential, forceLogoutAdmin } from "./admin-security-account-routes";
import { listPendingRecovery, requestRecovery, confirmRecovery, completeRecovery } from "./admin-security-recovery-routes";
import { bootstrapAdmin, activateEnrollment, readSecurityOperation } from "./admin-security-bootstrap-routes";
import {
  recordAudit,
  SecurityApiError,
  setAuditContext,
  withTransaction,
} from "./security-core";
import { handleAdminApprovalRoute } from "./approval-audit";
import { readAdminLoginTwoFactorRequired } from "./admin-login-two-factor";
import { handleAdminAuditRoute } from "./admin-audit";
import {
  type RealNameProvider,
  type AccountCancelObligationReader,
  type UserObligationReader,
} from "./user-identity";
import type { ImIdentityIntentRepository, ImIdentityProvisioner } from "../im/identity-lifecycle";
import { ADMIN_BRUTE_FORCE_POLICY, ADMIN_CAPTCHA_REQUIRED_REASON, adminAuthSubjects, clearAdminAuthFailures, gateAdminAuth, recordAdminAuthFailure, type AdminBruteForce } from "./admin-brute-force";
import { resolveAdminClientIp } from "./admin-client-ip";
import {
  AdminSecurityCommandError,
  adminSecurityCommandFingerprint,
  adminSecurityCommandId,
  type AdminSecurityCommandAction,
  type AdminSecurityCommandReceipt,
  type AdminSecurityCommandRejection,
  type AdminSecurityCommandScope,
} from "./admin-security-commands";

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
  send?: (body: unknown) => void;
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

export type ApprovalOperationExecutorInput = {
  requestId: string;
  operationCode: string;
  payloadVersion: number;
  operationPayload: Record<string, unknown>;
  operationPayloadHash: string;
  requestedBy: string;
  decidedBy: string;
  expiresAt: Date | string;
};

export type ApprovalOperationExecutor = (
  client: PoolClient,
  input: ApprovalOperationExecutorInput,
  actor: { userId: string; sessionId: string },
  requestId: string,
) => Promise<{ resultCode: string; resultDetail?: string }>;

export type AuthSecurityOptions = {
  pool: Pool;
  directoryReadPool?: Pool;
  adminAuth: AuthLike;
  userAuth: AuthLike;
  apiOrigin: string;
  adminOrigin: string;
  userOrigin: string;
  adminBootstrapSecret?: string;
  notifyAdminSecurity?: (notification: AdminSecurityNotification) => Promise<void>;
  hashPassword: PasswordHasher;
  verifyPassword: PasswordVerifier;
  /** HKDF 派生的命令指纹子密钥；缺省时本人安全命令退化为无命令身份（旧行为）。 */
  adminSecurityCommandKey?: Buffer;
  /** 管理员防爆破（共享存储 + ALTCHA）；缺省时仅保留进程内限流（旧行为，测试用）。 */
  adminBruteForce?: AdminBruteForce;
  rateLimitState: Map<string, { failures: number; resetAt: number }>;
  securityVerificationBudget: { inFlight: number };
  realNameProvider: RealNameProvider;
  userSmsConfiguration?: import("./sms-templates").SmsTemplateConfiguration;
  /** Stable identity-only HMAC key; independent from rotating authentication secrets. */
  userIdentitySubjectKey?: Buffer;
  userLegacyIdentityProfileKey?: Buffer;
  userRealNamePolicy?: { dailyLimit: number; minIntervalSeconds: number };
  settlementAdmission?: import("../order/joinpay-collection-profile").FormalCollectionAdmission;
  userObligationReader: UserObligationReader;
  accountCancelObligationReader: AccountCancelObligationReader;
  testOperationsEnabled: boolean;
  approvalOperationExecutor?: ApprovalOperationExecutor;
  /** Same explicit write capability as the distribution executor; never the read-only scope. */
  distributionPolicyWriteScope?: import('../finance/distribution-policy-store').LocalDistributionScope;
  imProvisioner?: ImIdentityProvisioner;
  imIdentityRepository?: ImIdentityIntentRepository;
  imAppId?: string;
  /** Existing read-only supply gate. Absent means the directory cannot claim a public version. */
  supplyGateReader?: SupplyGateReader;
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

const SECURITY_RATE_LIMIT_MAX_FAILURES = 5;
const SECURITY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const SECURITY_RATE_LIMIT_MAX_BUCKETS = 1024;
const SECURITY_VERIFICATION_MAX_IN_FLIGHT = 128;
const NOTIFICATION_CLAIM_LEASE_MS = 30 * 1000;
const NOTIFICATION_MAX_BACKOFF_MS = 5 * 60 * 1000;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function rateLimitKey(request: NodeRequest, scope: string, principal?: string): string {
  const nodeRequest = request as NodeRequest & { ip?: string; socket?: { remoteAddress?: string } };
  const address = nodeRequest.ip ?? nodeRequest.socket?.remoteAddress ?? "anonymous";
  return `${scope}:${principal ?? "anonymous"}:${address}`;
}

function pruneExpiredRateLimitBuckets(state: AuthSecurityOptions["rateLimitState"], now: number): void {
  for (const [key, bucket] of state) {
    if (bucket.resetAt <= now) state.delete(key);
  }
}

export function checkRateLimit(options: AuthSecurityOptions, key: string): void {
  const state = options.rateLimitState;
  const now = Date.now();
  pruneExpiredRateLimitBuckets(state, now);
  const bucket = state.get(key);
  if (!bucket) return;
  if (bucket.failures >= SECURITY_RATE_LIMIT_MAX_FAILURES) {
    throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "Too many authentication attempts");
  }
}

export function recordRateLimitFailure(options: AuthSecurityOptions, key: string): void {
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

export function clearRateLimit(options: AuthSecurityOptions, key: string): void {
  options.rateLimitState.delete(key);
}

export function acquireSecurityVerificationBudget(options: AuthSecurityOptions): () => void {
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

export function sendError(response: NodeResponse, error: SecurityApiError, requestId: string): void {
  // 稳定原因枚举（reason）是合同字段；SDK/数据库原始错误与秘密不外发。
  const reason = (error as { reason?: unknown }).reason;
  sendJson(
    response,
    error.status,
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
      },
    },
    requestId,
  );
}

export function sendInternalError(response: NodeResponse, requestId: string): void {
  sendJson(response, 500, {
    error: { code: API_V1_ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", requestId },
  }, requestId);
}

export function sendSuccess(response: NodeResponse, body: unknown, requestId: string): void {
  sendJson(response, 200, body, requestId);
}

export function bodyOf(request: NodeRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return body as Record<string, unknown>;
}

export function stringField(body: Record<string, unknown>, field: string, maxLength = 256): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return value;
}

export function pinField(body: Record<string, unknown>, field: string): string {
  const value = stringField(body, field, 6);
  if (!/^\d{6}$/.test(value)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "PIN must contain six digits");
  return value;
}

export function passwordField(body: Record<string, unknown>, field: string): string {
  const value = stringField(body, field, 256);
  if (value.length < 12) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Password does not meet the minimum length");
  return value;
}

export function recoveryCredentialField(body: Record<string, unknown>): string {
  const value = stringField(body, "targetRecoveryCredential", 256);
  if (value.length < 32) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Recovery credential is invalid");
  return value;
}

export function reasonField(body: Record<string, unknown>): string {
  const value = stringField(body, "reason", 500).trim();
  if (value.length < 3) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "A reason is required");
  return value;
}

export function sameSecret(left: string, right: string): boolean {
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
export async function assertAdminContextInTransaction(
  client: PoolClient,
  context: {userId:string;sessionId:string},
  options: { allowLocked?: boolean } = {},
): Promise<void> {
  const session = (await client.query<{locked:boolean;twoFactorEnabled:boolean;suspended:boolean}>(`SELECT s."locked",u."twoFactorEnabled",u."suspended" FROM "zzsh_auth_admin"."session" s JOIN "zzsh_auth_admin"."user" u ON u."id"=s."userId" WHERE s."id"=$1 AND s."userId"=$2 AND s."expiresAt">clock_timestamp()`, [context.sessionId,context.userId])).rows[0];
  // E-R3-03: same suspended gate as the locking command guard (assertAdminCommandAuthorizedInTransaction).
  if (!session || session.suspended === true) throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Authentication required");
  const security = await readAdminSecurity(client, context.userId);
  if (!security) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Account unavailable");
  if (security.status === "FROZEN") throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Account unavailable");
  if (security.status !== "ACTIVE" || session.twoFactorEnabled !== true) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Additional verification required");
  if (session.locked && !options.allowLocked) throw new SecurityApiError(423, API_V1_ERROR_CODES.FORBIDDEN, "Account locked");
}

export type AdminSessionSnapshot =
  | { authenticated: false }
  | {
      authenticated: true;
      adminUserId: string;
      user: { name?: string; email?: string; username?: string; displayUsername?: string; image?: string | null; twoFactorEnabled: boolean };
      security: { status: AdminContext["security"]["status"]; isBoss: boolean; passwordChangeRequired: boolean; loginTwoFactorRequired?: boolean };
      session: { id: string; locked: boolean; pinConfigured: boolean; createdAt: string | null; expiresAt: string | null };
      permissions: string[];
      gameScope?: AdminGameScope;
      dashboardPreset: DashboardPreset;
    };

function isoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

let adminSessionLastActiveUnavailable = false;

/**
 * 最近活跃时间节流写入（≥5 分钟才更新一次）。列来自迁移 0119：未应用（42703）后本进程不再尝试；
 * 任何失败都吞掉，绝不影响会话快照与登录。
 */
async function touchAdminSessionLastActive(pool: Pool, sessionId: string): Promise<void> {
  if (adminSessionLastActiveUnavailable) return;
  try {
    await pool.query(
      `UPDATE "zzsh_auth_admin"."session" SET "last_active_at" = clock_timestamp()
        WHERE "id" = $1 AND ("last_active_at" IS NULL OR "last_active_at" < clock_timestamp() - interval '5 minutes')`,
      [sessionId],
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === "42703") adminSessionLastActiveUnavailable = true;
  }
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
  await touchAdminSessionLastActive(options.pool, sessionId);
  const access = await loadEffectiveAdminAccess(options.pool, userId);
  const loginTwoFactorRequired = await readAdminLoginTwoFactorRequired(options.pool, userId);
  return {
    authenticated: true,
    adminUserId: userId,
    user: {
      ...(current.user?.name ? { name: current.user.name } : {}),
      ...(current.user?.email ? { email: current.user.email } : {}),
      ...(current.user?.username ? { username: current.user.username } : {}),
      ...(current.user?.displayUsername ? { displayUsername: current.user.displayUsername } : {}),
      ...(typeof (current.user as { image?: unknown } | undefined)?.image === "string" && (current.user as { image: string }).image.startsWith("/api/v1/profile/avatars/") ? { image: (current.user as { image: string }).image } : {}),
      twoFactorEnabled: current.user?.twoFactorEnabled === true,
    },
    security: { status: security.status, isBoss: security.isBoss, passwordChangeRequired: security.passwordChangeRequired, ...(loginTwoFactorRequired === undefined ? {} : { loginTwoFactorRequired }) },
    session: {
      id: sessionId,
      locked: current.session?.locked === true,
      pinConfigured: session.rows[0]?.pinConfigured === true,
      createdAt: isoDate(current.session?.createdAt),
      expiresAt: isoDate(current.session?.expiresAt),
    },
    permissions: access ? [...access.permissions].sort() : [],
    gameScope: access?.isBoss ? { mode: "ALL_GAMES", gameIds: [] } : await readAdminGameScope(options.pool, userId),
    dashboardPreset: deriveDashboardPreset(access ?? {
      status: "ACTIVE",
      isBoss: false,
      passwordChangeRequired: false,
      permissions: new Set<string>(),
    }),
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

export async function deliverAdminSecurityNotification(
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

export async function requireBoss(context: AdminContext, options: AuthSecurityOptions): Promise<void> {
  if (!context.security.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
  const current = await readAdminSecurity(options.pool, context.userId);
  if (!current?.isBoss || current.status !== "ACTIVE") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss permission required");
  }
}

export async function verifyAdminReauthentication(
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
  const bf = options.adminBruteForce;
  const subjects = bf ? adminAuthSubjects(`admin:${context.userId}`, resolveAdminClientIp(request as unknown as Parameters<typeof resolveAdminClientIp>[0], bf.clientIp)) : [];
  if (bf) await gateAdminAuth(bf, "step-up", subjects, { required: true, payload: body.altcha });
  const releaseVerificationBudget = acquireSecurityVerificationBudget(options);
  let verified = false;
  try {
    if (!options.adminAuth.api.verifyPassword || !options.adminAuth.api.verifyTOTP) throw new Error("reauthentication API unavailable");
    const verifiedPassword = await options.adminAuth.api.verifyPassword({ body: { password }, headers: context.credentials.headers });
    const verifiedTotp = await options.adminAuth.api.verifyTOTP({ body: { code }, headers: context.credentials.headers });
    if ((verifiedPassword as { status?: boolean } | undefined)?.status === false || (verifiedTotp as { status?: boolean } | undefined)?.status === false) {
      throw new Error("reauthentication rejected");
    }
    clearRateLimit(options, key);
    verified = true;
  } catch {
    recordRateLimitFailure(options, key);
  } finally {
    releaseVerificationBudget();
  }
  if (verified) {
    if (bf) await clearAdminAuthFailures(bf, "step-up", subjects);
    return;
  }
  if (bf) {
    const failure = await recordAdminAuthFailure(bf, "step-up", subjects, ensureApiV1RequestId(request));
    if (!failure || failure.lockedUntil) throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "尝试次数过多，请稍后再试");
    if (failure.failures >= ADMIN_BRUTE_FORCE_POLICY.captchaThreshold) {
      throw Object.assign(new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Password and two-factor verification are required"), { reason: ADMIN_CAPTCHA_REQUIRED_REASON });
    }
  }
  throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Password and two-factor verification are required");
}


/**
 * 本人 PIN 命令绑定原会话：同一 (管理员, 命令标识) 的重复/并发请求由命令范围锁串行化，
 * 回执只在业务事务内提交；仅完全缺失 Idempotency-Key 时保持旧调用。
 */
export function securityCommandScope(
  request: NodeRequest,
  options: AuthSecurityOptions,
  action: AdminSecurityCommandAction,
  context: AdminContext,
  fingerprintInput: readonly unknown[],
): AdminSecurityCommandScope | undefined {
  const commandId = adminSecurityCommandId(request.headers);
  if (!commandId) return undefined;
  if (options.adminSecurityCommandKey?.length !== 32) {
    throw new AdminSecurityCommandError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Security command unavailable", "command_key_unavailable");
  }
  return {
    adminUserId: context.userId,
    commandId,
    action,
    target: { kind: "session", id: context.sessionId },
    fingerprint: adminSecurityCommandFingerprint(options.adminSecurityCommandKey, fingerprintInput),
  };
}

export function rejectionEnvelopeOf(error: AdminSecurityCommandError): AdminSecurityCommandRejection {
  return {
    status: error.status,
    code: error.code,
    message: error.message,
    ...(error.reason ? { reason: error.reason } : {}),
  };
}

/** 重放"明确拒绝"必须原样复现首试的状态/code/message/reason，绝不包装成 SET/CHANGED 成功。 */
export function rejectionErrorOf(receipt: AdminSecurityCommandReceipt): AdminSecurityCommandError {
  const rejection = receipt.rejection;
  if (rejection) {
    return new AdminSecurityCommandError(rejection.status, rejection.code, rejection.message, rejection.reason ?? receipt.reason);
  }
  return new AdminSecurityCommandError(409, API_V1_ERROR_CODES.CONFLICT, "Original command was rejected", receipt.reason ?? "rejected");
}

export function commandReplayBody(receipt: AdminSecurityCommandReceipt, status: string): Record<string, unknown> {
  if (receipt.status === "rejected") throw rejectionErrorOf(receipt);
  return {
    status,
    replayed: true,
    action: receipt.action,
    commandId: receipt.commandId,
    receipt: receipt.result ?? null,
    createdAt: receipt.createdAt,
  };
}

export function commandAcceptedBody(status: string, scope: AdminSecurityCommandScope | undefined, result: Record<string, unknown>): Record<string, unknown> {
  return { status, commandId: scope?.commandId ?? null, receipt: scope ? result : null };
}

export function queryValue(request: NodeRequest, name: string): string | undefined {
  const source = request.originalUrl ?? request.url ?? "";
  const index = source.indexOf("?");
  if (index < 0) return undefined;
  const value = new URLSearchParams(source.slice(index + 1)).get(name);
  return value && value.length > 0 ? value : undefined;
}

export type LegacyCredentialOutcome = "retry" | "none" | "change-required" | "already-changed" | "new-password-invalid";

export type LegacyCredentialLookup = { username: string } | { phoneNumber: string } | { userId: string };

/**
 * Server-side password compatibility, behind the normal sign-in body validation and throttle.
 * The userId lookup is only for a server-resolved source-bound legacy public number, never a public userId field.
 * It returns "retry" when the verified subject may continue through normal session creation:
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
  return withTransaction(pool, (client) => verifyUserCredentialInTransaction(client, verifyPassword, hashPassword, lookup, password, requestId));
}

/** Same compatibility path, sharing the caller's lock/transaction with session creation or reset. */
export async function verifyUserCredentialInTransaction(
  client: PoolClient, verifyPassword: PasswordVerifier, hashPassword: PasswordHasher,
  lookup: LegacyCredentialLookup, password: string, requestId: string, mode: "active-only" | "sign-in" = "active-only", newPassword?: string,
): Promise<LegacyCredentialOutcome> {
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
        WHERE ${"userId" in lookup ? 'u."id" = $1' : "username" in lookup ? 'u."username" = $1' : 'u."phoneNumber" = $1'} AND a."providerId" = 'credential'
        FOR UPDATE OF a`,
      ["userId" in lookup ? lookup.userId : "username" in lookup ? lookup.username : lookup.phoneNumber],
    );
    const row = account.rows[0];
    if (!row) return "none";
    const frozen = row.accountStatus === "FROZEN";
    // Sign-in verifies the secret before disclosing a freeze; it still cannot create a session or upgrade this credential.
    if ((row.suspended || row.accountStatus !== "ACTIVE") && !(mode === "sign-in" && frozen)) return "none";
    if (!row.legacyPasswordMd5) {
      if (!row.password) return "none";
      if (!await verifyPassword(password, row.password)) return "none";
      if (newPassword !== undefined) return "already-changed";
      return "retry";
    }
    const legacyHash = row.legacyPasswordVersion === "legacy-md5-v1" && row.legacyPasswordSalt !== null
      ? createHash("md5").update(password + row.legacyPasswordSalt, "utf8").digest("hex")
      : row.legacyPasswordVersion === "legacy-md5-v0"
        ? createHash("md5").update(password, "utf8").digest("hex")
        : undefined;
    if (!legacyHash || !sameSecret(row.legacyPasswordMd5, legacyHash)) return "none";
    if (frozen) return "retry";
    if (mode === "sign-in" && newPassword === undefined) return "change-required";
    if (newPassword !== undefined && (newPassword.length < 12 || newPassword.length > 128 || newPassword === password)) {
      return "new-password-invalid";
    }
    const passwordHash = await hashPassword(newPassword ?? password);
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
}

/**
 * 本人安全命令的非敏感原结果读取：只按当前会话确定的管理员身份读取，
 * 不重放命令、不签发会话、不返回密码/PIN/备份码明文，也不返回请求指纹。
 * 未找到记录只说明无法确认，不证明命令没有执行。
 */

/**
 * 批准高影响审批时的动态码复核。审批写不再在外层统一要求「密码 + 动态码」：
 * 分级判断挪进审批路由，在读出申请行、知道申请类型之后才调用本函数；
 * 中低影响批准、驳回、撤回都不复核，任何审批操作都不再要求密码。
 */
export async function verifyApprovalDecisionTotp(
  request: NodeRequest,
  context: AdminContext,
  body: Record<string, unknown>,
  options: AuthSecurityOptions,
): Promise<void> {
  const code = typeof body.totpCode === "string" ? body.totpCode : "";
  if (!/^\d{6}$/.test(code)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Two-factor code is invalid");
  // R4：动态码失败计数与锁定必须落在共享存储里，并且以账号为主体（换 IP 不能重置）。
  // 进程内限流桶只作为第二道即时保护，不能替代持久封锁。仍然不要密码、不要人机验证。
  const bf = options.adminBruteForce;
  const subjects = bf ? adminAuthSubjects(`admin:${context.userId}`, resolveAdminClientIp(request as unknown as Parameters<typeof resolveAdminClientIp>[0], bf.clientIp)) : [];
  if (bf) await gateAdminAuth(bf, "approval-totp", subjects, { required: false, payload: undefined });
  const key = rateLimitKey(request, "admin.approval.decision.totp", context.userId);
  checkRateLimit(options, key);
  const releaseVerificationBudget = acquireSecurityVerificationBudget(options);
  let verified = false;
  try {
    if (!options.adminAuth.api.verifyTOTP) throw new Error("two-factor verification API unavailable");
    const result = await options.adminAuth.api.verifyTOTP({ body: { code }, headers: context.credentials.headers });
    if ((result as { status?: boolean } | undefined)?.status === false) throw new Error("two-factor verification rejected");
    clearRateLimit(options, key);
    verified = true;
  } catch {
    recordRateLimitFailure(options, key);
  } finally {
    releaseVerificationBudget();
  }
  if (verified) {
    if (bf) await clearAdminAuthFailures(bf, "approval-totp", subjects);
    return;
  }
  if (bf) {
    const failure = await recordAdminAuthFailure(bf, "approval-totp", subjects, ensureApiV1RequestId(request));
    if (!failure || failure.lockedUntil) throw new SecurityApiError(429, API_V1_ERROR_CODES.RATE_LIMITED, "尝试次数过多，请稍后再试");
  }
  throw new SecurityApiError(401, API_V1_ERROR_CODES.UNAUTHENTICATED, "Two-factor verification is required");
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
    if (path.startsWith("/approvals")) {
      // 动态码分级由审批路由在读出申请类型后决定；外层不再剥离复核字段、不再要求密码。
      return await handleAdminApprovalRoute(request, response, requestId, options, readAdminContext);
    }
    if (path.startsWith("/audit")) {
      if (request.method === "POST" && path === "/audit/purge") {
        // 日志清理为不可逆高风险写：实时复核密码 + TOTP（必要时 ALTCHA），剥离复核字段后交给清理路由。
        const context = await readAdminContext(request, options);
        const body = bodyOf(request);
        await verifyAdminReauthentication(request, context, body, options);
        for (const key of ["password", "totpCode", "altcha"]) delete body[key];
      }
      return await handleAdminAuditRoute(request, response, requestId, options, readAdminContext);
    }
    if (request.method === "GET") {
      if (path === "/captcha/challenge") {
        if (!options.adminBruteForce) {
          sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
          return;
        }
        response.setHeader("Cache-Control", "no-store");
        sendSuccess(response, await options.adminBruteForce.captcha.challenge(), requestId);
        return;
      }
      if (path === "/admins") return await listAdminDirectory(request, response, requestId, options);
      if (path === "/admins/detail") return await readAdminDirectoryDetail(request, response, requestId, options);
      if (path === "/admins/scope") return await readAdminGameScopeRoute(request, response, requestId, options);
      if (path === "/roles") return await listAdminRoles(request, response, requestId, options);
      if (path === "/recovery/pending") return await listPendingRecovery(request, response, requestId, options);
      sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
      return;
    }
    if (request.method !== "POST") {
      sendError(response, new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found"), requestId);
      return;
    }
    if (path === "/bootstrap") return await bootstrapAdmin(request, response, requestId, options);
    if (path === "/enrollment/activate") return await activateEnrollment(request, response, requestId, options);
    if (path === "/operation") return await readSecurityOperation(request, response, requestId, options);
    if (path === "/pin/set") return await setPin(request, response, requestId, options);
    if (path === "/pin/change") return await changePin(request, response, requestId, options);
    if (path === "/pin/lock") return await lockPin(request, response, requestId, options);
    if (path === "/pin/unlock") return await unlockPin(request, response, requestId, options);
    if (path === "/freeze") return await changeAdminFreezeState(request, response, requestId, options, "FROZEN");
    if (path === "/unfreeze") return await changeAdminFreezeState(request, response, requestId, options, "ACTIVE");
    if (path === "/admins/force-logout") return await forceLogoutAdmin(request, response, requestId, options);
    if (path === "/self-sessions/revoke") return await revokeSelfSessions(request, response, requestId, options);
    if (path === "/login-two-factor") return await changeLoginTwoFactorPreference(request, response, requestId, options);
    if (path === "/admins/reset-password") return await resetAdminCredential(request, response, requestId, options, "password");
    if (path === "/admins/reset-2fa") return await resetAdminCredential(request, response, requestId, options, "two_factor");
    if (path === "/users/freeze") return await changeUserAccountFreezeState(request, response, requestId, options, "FROZEN");
    if (path === "/users/unfreeze") return await changeUserAccountFreezeState(request, response, requestId, options, "ACTIVE");
    if (path === "/admins/create") return await handleCreateAdministrator(request, response, requestId, options);
    if (path === "/admins/update") return await handleUpdateAdministrator(request, response, requestId, options);
    if (path === "/admins/assign") return await handleAssignAdministrator(request, response, requestId, options);
    if (path === "/admins/scope") return await handleAssignAdministratorGameScope(request, response, requestId, options);
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
