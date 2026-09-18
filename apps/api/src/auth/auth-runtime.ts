import { OrderDispatchLifecycle, type OrderDispatchOptions } from "../im/order-dispatch";
import { OrderTeamLifecycle } from "../im/order-team";
import type { YunxinOrderTeamApi } from "../im/yunxin-provider";
import { mountUserSupplyBff } from "../bff/user-supply-bff";
import { unknownSupplyGate, type SupplyGateReader } from "../supply/publishing";
import type { INestApplication } from "@nestjs/common";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { createAuthSchema } from "./auth-schema";
import { mountAuthSecurityHandlers, preflightAuthRealmSecurity, attemptLegacyCredentialUpgrade, type AdminSecurityNotification, type AuthSecurityOptions, type LegacyCredentialLookup } from "./auth-security";
import { createFakeRealNameProvider, handleUserIdentityRoute, type RealNameProvider, type UserObligationReader } from "./user-identity";
import { mountAdminBffHandlers } from "../bff/admin-bff";
import { createLocalMediaStorage, type MediaStorage } from "../supply/media";
import { resolveMediaStorage } from "../supply/media-oss";
import { mountSupplyHandlers } from "../supply/supply-routes";
import { mountContentHandlers } from "../content/content-routes";
import { mountOrderHandlers, mountUserOrderBff, type OrderRuntimeOptions } from "../order/order-routes";
import { composeSupplyGateWithOrderOccupancy } from "../order/order";
import { ConfigurationError, readSecret } from "../config/config";
import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import { setAuditContext, withTransaction } from "./security-core";
import { ImIdentityProvisioner, YunxinDynamicTokenService } from "../im/identity-lifecycle";
import { MessageScopeRecoveryLifecycle, supportManagerIdentityKey, type ConsultationRouteOptions } from "../im/consultation";
import { YunxinIdentityRepository } from "../im/yunxin-identity-repository";
import { YunxinServerApiClient, type YunxinServerApi, type YunxinSupportScopeApi } from "../im/yunxin-provider";
import type { ImMessageTransport } from "../im/im-contract";
import { mountYunxinHandlers } from "../im/yunxin-routes";

type AuthRealmName = "user" | "admin";

type AuthRuntimeConfig = {
  apiOrigin: string;
  userOrigin: string;
  adminOrigin: string;
  userSecret: string;
  adminSecret: string;
  adminBootstrapSecret?: string;
  secureCookies: boolean;
  testOperationsEnabled: boolean;
  localSmsMock?: boolean;
};

export type AuthRuntimeCapabilities = {
  testOperationsEnabled?: boolean;
};

export type AuthRuntimeOptions = AuthRuntimeConfig & {
  /** Explicit local scheduler; omitted by default, never inferred from environment flags. */
  supportDispatch?: Omit<OrderDispatchOptions, "pool">;
  orderTeams?: { membersLimit: number; intervalMs: number; batchLimit: number };
  pool: Pool;
  yunxin?: { appId: string; appKey: string; appSecret: string };
  /** Test-only local provider seam; production construction must leave this unset. */
  testYunxinProvider?: YunxinServerApi & YunxinSupportScopeApi;
  /** Test-only local message seam; production construction must leave this unset. */
  testImMessageTransport?: ImMessageTransport;
  fakeSmsOutbox?: Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" | "phone-registration" }>;
  fakeAdminNotificationOutbox?: AdminSecurityNotification[];
  rateLimitState?: Map<string, { failures: number; resetAt: number }>;
  securityVerificationBudget?: { inFlight: number };
  realNameProvider?: RealNameProvider;
  userObligationReader?: UserObligationReader;
  mediaStorage?: MediaStorage;
  testSupplyGateReader?: SupplyGateReader;
  /** Seconds a pending-payment order holds the account. Creation refuses to run when unset. */
  orderHoldSeconds?: number;
  /**
   * Explicit Better Auth rate-limit settings for the user realm. Unset keeps the library default
   * (enabled in production); the isolated auth tests pass their own settings to assert that the
   * limiter runs before any legacy credential upgrade.
   */
  userRateLimit?: Parameters<typeof import("better-auth").betterAuth>[0]["rateLimit"];
};

type NodeRequest = {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
};

type NodeResponse = {
  headersSent?: boolean;
  setHeader: (name: string, value: string | string[]) => NodeResponse;
  status: (status: number) => NodeResponse;
  json: (body: unknown) => void;
};

type SessionState = {
  user?: { id?: string; suspended?: boolean; twoFactorEnabled?: boolean };
  session?: { locked?: boolean };
} | null;

type AuthRealm = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (options: { headers: Headers }) => Promise<SessionState>;
  };
};

type AuthHandler = (request: NodeRequest, response: NodeResponse) => Promise<void>;

const USER_ALLOWED_PATHS = new Set([
  "/get-session",
  "/sign-in/identifier",
  "/sign-in/username",
  "/sign-in/phone-number",
  "/sign-out",
  "/sign-up/email",
  "/phone-number/send-otp",
  "/phone-number/verify",
  "/phone-number/request-password-reset",
  "/phone-number/reset-password",
  "/phone-registration/send-otp",
  "/phone-registration/complete",
]);

const USER_SECURITY_PATHS = new Set([
  "/identity/status",
  "/identity/verify",
  "/trade-eligibility/check",
  "/account/deactivate",
  "/account/cancel",
]);

const ADMIN_ALLOWED_PATHS = new Set([
  "/get-session",
  "/sign-in/email",
  "/sign-in/username",
  "/sign-out",
  "/change-password",
  "/two-factor/enable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
]);

const USER_SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
const PHONE_REGISTRATION_OTP_TTL_MS = 5 * 60 * 1000;
const PHONE_REGISTRATION_OTP_COOLDOWN_MS = 60 * 1000;
const PHONE_REGISTRATION_OTP_MAX_ATTEMPTS = 3;
const PHONE_REGISTRATION_IDENTIFIER_PREFIX = "phone-registration:";

/** Canonical form used by every phone auth operation: +86 followed by 11 digits. */
export function normalizeMainlandPhone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const compact = value.trim().replace(/[\s-]/g, "");
  const digits = compact.startsWith("+86") ? compact.slice(3) : compact.startsWith("0086") ? compact.slice(4) : compact;
  return /^1[3-9]\d{9}$/.test(digits) ? `+86${digits}` : null;
}

function phoneRegistrationIdentifier(phoneNumber: string): string {
  return `${PHONE_REGISTRATION_IDENTIFIER_PREFIX}${phoneNumber}`;
}

type IdentifierResolution = "phone-number" | "username" | "ambiguous";

async function resolveSignInIdentifier(pool: Pool, identifier: string): Promise<IdentifierResolution> {
  const phoneNumber = normalizeMainlandPhone(identifier);
  const loweredIdentifier = identifier.toLowerCase();
  const result = await pool.query<{ id: string; username: string | null; phoneNumber: string | null }>(
    `SELECT "id", "username", "phoneNumber"
       FROM "zzsh_auth_user"."user"
      WHERE ("phoneNumber" IS NOT NULL AND "phoneNumber" = $1)
         OR ("username" IS NOT NULL AND LOWER("username") = $2)`,
    [phoneNumber, loweredIdentifier],
  );
  const phoneMatch = phoneNumber ? result.rows.find((row) => row.phoneNumber === phoneNumber) : undefined;
  const usernameMatch = result.rows.find((row) => row.username?.toLowerCase() === loweredIdentifier);
  if (phoneMatch && usernameMatch && phoneMatch.id !== usernameMatch.id) return "ambiguous";
  if (phoneMatch) return "phone-number";
  if (usernameMatch) return "username";
  // Unknown phone-shaped identifiers retain the phone error path without guessing a second account.
  return phoneNumber ? "phone-number" : "username";
}

function registrationOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pathOf(request: NodeRequest): string {
  return (request.url ?? request.originalUrl ?? "/").split("?", 1)[0] || "/";
}

function originAllowed(request: NodeRequest, origins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return origins.includes(origin);
}

function sendJson(response: NodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).json(body);
}

function sendApiError(
  response: NodeResponse,
  status: number,
  code: (typeof API_V1_ERROR_CODES)[keyof typeof API_V1_ERROR_CODES],
  message: string,
  requestId: string,
): void {
  sendJson(response, status, { error: { code, message, requestId } }, requestId);
}

function authErrorCode(status: number): (typeof API_V1_ERROR_CODES)[keyof typeof API_V1_ERROR_CODES] {
  if (status === 401) return API_V1_ERROR_CODES.UNAUTHENTICATED;
  if (status === 403) return API_V1_ERROR_CODES.FORBIDDEN;
  if (status === 404) return API_V1_ERROR_CODES.NOT_FOUND;
  if (status === 409) return API_V1_ERROR_CODES.CONFLICT;
  if (status === 429) return API_V1_ERROR_CODES.RATE_LIMITED;
  if (status >= 400 && status < 500) return API_V1_ERROR_CODES.INVALID_ARGUMENT;
  return API_V1_ERROR_CODES.INTERNAL_ERROR;
}

function copyWebResponseHeaders(source: Headers): Headers {
  const target = new Headers();
  source.forEach((value, key) => {
    if (key !== "set-cookie") target.append(key, value);
  });
  const sourceWithCookies = source as Headers & { getSetCookie?: () => string[] };
  const cookies = sourceWithCookies.getSetCookie?.() ?? (source.get("set-cookie") ? [source.get("set-cookie")!] : []);
  for (const cookie of cookies) target.append("set-cookie", cookie);
  return target;
}

function safeWebError(status: number, requestId: string): Response {
  return new Response(JSON.stringify({
    error: {
      code: authErrorCode(status),
      message: status >= 500 ? "Internal server error" : "Authentication request rejected",
      requestId,
    },
  }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

async function safeWebAuthHandler(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}`;
  try {
    const response = await handler(request);
    const headers = copyWebResponseHeaders(response.headers);
    headers.set("x-request-id", requestId);
    if (response.status >= 400) {
      headers.delete("content-length");
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify({
        error: {
          code: authErrorCode(response.status),
          message: response.status >= 500 ? "Internal server error" : "Authentication request rejected",
          requestId,
        },
      }), { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return safeWebError(500, requestId);
  }
}

type AdminSecurityStatus = "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";

const LEGACY_RETRY_HEADER = "x-zzsh-legacy-retry";

type UserSignInHookContext = {
  path: string;
  body: unknown;
  headers: Headers;
  context: { returned?: unknown };
};

type LegacyAfterHookDeps = {
  pool: Pool;
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  isAPIError: (value: unknown) => value is { status: string };
  retrySignIn: (signIn: "username" | "phone-number", body: Record<string, unknown>, headers: Headers) => Promise<Response>;
};

function legacyLookupOf(path: string, body: Record<string, unknown>): LegacyCredentialLookup | null {
  if (path === "/sign-in/username") {
    const username = body.username;
    if (typeof username !== "string" || username.length === 0) return null;
    // The username plugin looks the account up with the same lowercased identifier.
    return { username: username.toLowerCase() };
  }
  const phoneNumber = body.phoneNumber;
  if (typeof phoneNumber !== "string" || phoneNumber.length === 0) return null;
  // The phone-number plugin uses the validated value unchanged.
  return { phoneNumber };
}

/**
 * Better Auth after hook: runs only once the sign-in endpoint finished, which means the installed
 * rate limiter and the endpoint body schema already accepted the request. When the endpoint
 * rejected the credentials, stored credential state decides whether a legacy upgrade applies;
 * only then is the standard sign-in endpoint executed once more (marked so the hook does not
 * recurse) and its response replaces the rejection. Invalid bodies never reach this branch
 * because the endpoint returns a 400, and rate-limited requests never reach the endpoint at all.
 */
async function handleUserLegacyAfterHook(
  ctx: UserSignInHookContext,
  deps: LegacyAfterHookDeps,
): Promise<Response | undefined> {
  if (ctx.path !== "/sign-in/username" && ctx.path !== "/sign-in/phone-number") return undefined;
  if (ctx.headers?.get?.(LEGACY_RETRY_HEADER) === "1") return undefined;
  const returned = ctx.context?.returned;
  if (!deps.isAPIError(returned) || returned.status !== "UNAUTHORIZED") return undefined;
  if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) return undefined;
  const body = ctx.body as Record<string, unknown>;
  const password = body.password;
  if (typeof password !== "string" || password.length === 0) return undefined;
  const lookup = legacyLookupOf(ctx.path, body);
  if (!lookup) return undefined;
  const requestId = ctx.headers?.get?.("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}`;
  const outcome = await attemptLegacyCredentialUpgrade(deps.pool, deps.verifyPassword, deps.hashPassword, lookup, password, requestId);
  if (outcome !== "retry") return undefined;
  const headers = new Headers(ctx.headers);
  headers.set(LEGACY_RETRY_HEADER, "1");
  const signIn = ctx.path === "/sign-in/username" ? "username" : "phone-number";
  // The Response replaces the endpoint rejection; its own status and Set-Cookie are preserved.
  return await deps.retrySignIn(signIn, body, headers);
}

async function readAdminSecurity(pool: Pool, userId: string): Promise<{ status: AdminSecurityStatus; passwordChangeRequired: boolean } | null> {
  const result = await pool.query<{ status: AdminSecurityStatus; passwordChangeRequired: boolean }>(
    `SELECT "status", "password_change_required" AS "passwordChangeRequired" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function assertAdminSessionCreationAllowed(pool: Pool, userId: string, APIError: typeof import("better-auth/api").APIError): Promise<void> {
  const security = await readAdminSecurity(pool, userId);
  if (!security || security.status === "FROZEN") {
    throw new APIError("FORBIDDEN", { message: "Account unavailable" });
  }
}

function buildFakePhoneNumberPlugin(
  phoneNumber: typeof import("better-auth/plugins").phoneNumber,
  outbox: Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" | "phone-registration" }>,
  localSmsMock = false,
) {
  return phoneNumber({
    phoneNumberValidator: (value) => Boolean(normalizeMainlandPhone(value)),
    sendOTP: async ({ phoneNumber: target, code }: { phoneNumber: string; code: string }) => {
      outbox.set(target, { code: localSmsMock ? "888888" : code, sentAt: new Date().toISOString(), purpose: "phone-verification" });
    },
    sendPasswordResetOTP: async ({ phoneNumber: target, code }: { phoneNumber: string; code: string }) => {
      outbox.set(`${target}-request-password-reset`, { code: localSmsMock ? "888888" : code, sentAt: new Date().toISOString(), purpose: "password-reset" });
    },
  });
}

function buildPhoneRegistrationPlugin(
  createAuthEndpoint: typeof import("better-auth/api").createAuthEndpoint,
  APIError: typeof import("better-auth/api").APIError,
  setSessionCookie: typeof import("better-auth/cookies").setSessionCookie,
  pool: Pool,
  outbox: Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" | "phone-registration" }>,
  fakeSmsEnabled: boolean,
  localSmsMock: boolean,
  signInIdentifier: { dispatch?: (identifier: string, password: string, headers: Headers, kind?: "phone" | "username") => Promise<Response> },
) {
  const bodyOf = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new APIError("BAD_REQUEST", { message: "Invalid authentication request" });
    }
    return value as Record<string, unknown>;
  };
  const phoneFrom = (body: Record<string, unknown>): string => {
    const phone = normalizeMainlandPhone(body.phoneNumber);
    if (!phone) throw new APIError("BAD_REQUEST", { message: "Invalid phone number" });
    return phone;
  };
  const passwordFrom = (body: Record<string, unknown>): string => {
    if (typeof body.password !== "string" || body.password.length === 0) {
      throw new APIError("BAD_REQUEST", { message: "Invalid password" });
    }
    return body.password;
  };
  const codeFrom = (body: Record<string, unknown>): string => {
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      throw new APIError("BAD_REQUEST", { message: "Invalid verification code" });
    }
    return body.code;
  };
  const noStore = { noStore: true } as const;

  return {
    id: "phone-registration",
    version: "1.0.0",
    endpoints: {
      signInIdentifier: createAuthEndpoint("/sign-in/identifier", { method: "POST", metadata: noStore }, async (ctx) => {
        const body = bodyOf(ctx.body);
        const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
        const password = passwordFrom(body);
        if (!identifier || identifier.length > 128 || !signInIdentifier.dispatch) {
          throw new APIError("BAD_REQUEST", { message: "Invalid authentication request" });
        }
        const kind = body.kind === undefined ? undefined : body.kind === "phone" || body.kind === "username" ? body.kind : null;
        if (kind === null) throw new APIError("BAD_REQUEST", { message: "Invalid authentication request" });
        return signInIdentifier.dispatch(identifier, password, ctx.headers ?? new Headers(), kind);
      }),
      sendPhoneRegistrationOTP: createAuthEndpoint("/phone-registration/send-otp", { method: "POST", metadata: noStore }, async (ctx) => {
        if (!fakeSmsEnabled) throw new APIError("NOT_IMPLEMENTED", { message: "SMS provider is not configured" });
        const phoneNumber = phoneFrom(bodyOf(ctx.body));
        const identifier = phoneRegistrationIdentifier(phoneNumber);
        const code = localSmsMock ? "888888" : registrationOtp();
        const now = new Date();
        await withTransaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identifier]);
          const previous = await client.query<{ createdAt: Date }>(
            `SELECT "createdAt" FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1 ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`,
            [identifier],
          );
          if (previous.rows[0] && now.getTime() - new Date(previous.rows[0].createdAt).getTime() < PHONE_REGISTRATION_OTP_COOLDOWN_MS) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "Verification code rate limited" });
          }
          await client.query(`DELETE FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`, [identifier]);
          await client.query(
            `INSERT INTO "zzsh_auth_user"."verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $5)`,
            [`verification_${randomUUID().replaceAll("-", "")}`, identifier, `${code}:0`, new Date(now.getTime() + PHONE_REGISTRATION_OTP_TTL_MS), now],
          );
        });
        outbox.set(identifier, { code, sentAt: now.toISOString(), purpose: "phone-registration" });
        return ctx.json({ status: true });
      }),
      completePhoneRegistration: createAuthEndpoint("/phone-registration/complete", { method: "POST", metadata: noStore }, async (ctx) => {
        const body = bodyOf(ctx.body);
        const phoneNumber = phoneFrom(body);
        const code = codeFrom(body);
        const unified = body.loginOrRegister === true;
        const password = unified && body.password === undefined ? undefined : passwordFrom(body);
        if (body.acceptedTerms !== true) throw new APIError("BAD_REQUEST", { message: "Terms must be accepted" });
        const minPasswordLength = ctx.context.password.config.minPasswordLength;
        const maxPasswordLength = ctx.context.password.config.maxPasswordLength;
        if (password !== undefined && (password.length < minPasswordLength || password.length > maxPasswordLength)) {
          throw new APIError("BAD_REQUEST", { message: "Invalid password" });
        }
        const passwordHash = password === undefined ? undefined : await ctx.context.password.hash(password);
        const userId = ctx.context.generateId({ model: "user" }) || `user_${randomUUID().replaceAll("-", "")}`;
        let resolvedUserId = userId;
        let requiresPassword = false;
        const accountId = ctx.context.generateId({ model: "account" }) || `account_${randomUUID().replaceAll("-", "")}`;
        const identifier = phoneRegistrationIdentifier(phoneNumber);
        const requestId = (ctx.headers ?? new Headers()).get("x-request-id") ?? `req_${randomUUID().replaceAll("-", "")}`;
        try {
          const invalidVerification = await withTransaction(pool, async (client) => {
            await setAuditContext(client, "system", undefined, undefined, requestId);
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identifier]);
            const verification = await client.query<{ id: string; value: string; expiresAt: Date }>(
              `SELECT "id", "value", "expiresAt" FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1 ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`,
              [identifier],
            );
            const row = verification.rows[0];
            if (!row) {
              return true;
            }
            const [storedCode, attemptsText] = row.value.split(":");
            const attempts = Number.parseInt(attemptsText ?? "0", 10);
            if (Number.isSafeInteger(attempts) && attempts >= PHONE_REGISTRATION_OTP_MAX_ATTEMPTS) {
              return true;
            }
            if (new Date(row.expiresAt).getTime() <= Date.now()) {
              await client.query(`DELETE FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`, [identifier]);
              return true;
            }
            if (!/^\d{6}$/.test(storedCode ?? "") || !Number.isSafeInteger(attempts)) {
              await client.query(`DELETE FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`, [identifier]);
              return true;
            }
            if (storedCode !== code) {
              await client.query(`UPDATE "zzsh_auth_user"."verification" SET "value" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [row.id, `${storedCode}:${attempts + 1}`]);
              return true;
            }
            const existing = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_auth_user"."user" WHERE "phoneNumber" = $1 FOR UPDATE`, [phoneNumber]);
            if (existing.rowCount) {
              if (!unified) throw new APIError("CONFLICT", { message: "Phone number is already registered" });
              resolvedUserId = existing.rows[0]!.id;
              await client.query(`DELETE FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`, [identifier]);
              return false;
            }
            if (passwordHash === undefined) {
              // Keep the verified code until password completion; the same expiry and attempt budget still apply.
              requiresPassword = true;
              return false;
            }
            await client.query(`DELETE FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`, [identifier]);
            const now = new Date();
            const email = `phone-${createHash("sha256").update(phoneNumber).digest("hex")}@phone.zzsh.invalid`;
            await client.query(
              `INSERT INTO "zzsh_auth_user"."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "phoneNumber", "phoneNumberVerified", "suspended") VALUES ($1, $2, $3, false, $4, $4, $5, true, false)`,
              [userId, "洲洲用户", email, now, phoneNumber],
            );
            await client.query(
              `INSERT INTO "zzsh_auth_user"."account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
              [accountId, userId, passwordHash, now],
            );
            await client.query(
              `INSERT INTO "zzsh_iam"."user_identity_state" ("user_id", "account_status", "identity_status", "age_status", "provider", "version", "updated_at") VALUES ($1, 'ACTIVE', 'UNVERIFIED', 'UNKNOWN', 'none', 1, $2)`,
              [userId, now],
            );
            return false;
          });
          if (invalidVerification) throw new APIError("BAD_REQUEST", { message: "Invalid verification code" });
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "23505") {
            throw new APIError("CONFLICT", { message: "Phone number is already registered" });
          }
          throw error;
        }
        if (requiresPassword) return ctx.json({ status: true, requiresPassword: true });
        const user = await ctx.context.internalAdapter.findUserById(resolvedUserId);
        if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to create user" });
        const session = await ctx.context.internalAdapter.createSession(resolvedUserId);
        if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Failed to create session" });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ status: true });
      }),
    },
    rateLimit: [
      { window: 10, max: 3, pathMatcher: (path: string) => path === "/sign-in/identifier" },
      { window: 60, max: 5, pathMatcher: (path: string) => path.startsWith("/phone-registration/") },
    ],
  };
}

export function loadAuthRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
  capabilities: AuthRuntimeCapabilities = {},
): Omit<AuthRuntimeOptions, "pool"> {
  const apiOrigin = env.AUTH_API_ORIGIN?.trim() || `http://127.0.0.1:${env.PORT?.trim() || "3102"}`;
  const userOrigin = env.AUTH_USER_ORIGIN?.trim() || "http://127.0.0.1:3100";
  const adminOrigin = env.AUTH_ADMIN_ORIGIN?.trim() || "http://127.0.0.1:3101";
  for (const [key, value] of [["AUTH_API_ORIGIN", apiOrigin], ["AUTH_USER_ORIGIN", userOrigin], ["AUTH_ADMIN_ORIGIN", adminOrigin]] as const) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConfigurationError(`${key} must be an absolute http(s) origin`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new ConfigurationError(`${key} must be an absolute http(s) origin`);
    }
  }

  const userSecret = readSecret(env, "AUTH_USER_SECRET", "AUTH_USER_SECRET_FILE", workingDirectory);
  const adminSecret = readSecret(env, "AUTH_ADMIN_SECRET", "AUTH_ADMIN_SECRET_FILE", workingDirectory);
  if (userSecret.length < 32 || adminSecret.length < 32) {
    throw new ConfigurationError("Better Auth secrets must be at least 32 characters");
  }
  if (userSecret === adminSecret) {
    throw new ConfigurationError("AUTH_USER_SECRET and AUTH_ADMIN_SECRET must be different");
  }
  const adminBootstrapSecret = env.AUTH_ADMIN_BOOTSTRAP_SECRET !== undefined || env.AUTH_ADMIN_BOOTSTRAP_SECRET_FILE !== undefined
    ? readSecret(env, "AUTH_ADMIN_BOOTSTRAP_SECRET", "AUTH_ADMIN_BOOTSTRAP_SECRET_FILE", workingDirectory)
    : undefined;
  if (adminBootstrapSecret !== undefined && adminBootstrapSecret.length < 32) {
    throw new ConfigurationError("AUTH_ADMIN_BOOTSTRAP_SECRET must be at least 32 characters");
  }
  if (adminBootstrapSecret !== undefined && (adminBootstrapSecret === userSecret || adminBootstrapSecret === adminSecret)) {
    throw new ConfigurationError("AUTH_ADMIN_BOOTSTRAP_SECRET must be different from Better Auth secrets");
  }
  const mockSetting = env.AUTH_LOCAL_SMS_MOCK ?? "false";
  if (mockSetting !== "true" && mockSetting !== "false") throw new ConfigurationError("AUTH_LOCAL_SMS_MOCK must be true or false");
  const localSmsMock = mockSetting === "true";
  if (localSmsMock && (
    !["dev", "test"].includes(env.APP_PROFILE ?? "") || env.NODE_ENV === "production" ||
    env.PROVIDER_MODE !== "fake" || env.DB_TARGET !== "local-compose" ||
    env.HOST !== "127.0.0.1" || env.DB_HOST !== "127.0.0.1" ||
    !/^zzsh_(dev|test)(_|$)/.test(env.DB_NAME ?? "") ||
    ![apiOrigin, userOrigin, adminOrigin].every((origin) => new URL(origin).hostname === "127.0.0.1")
  )) throw new ConfigurationError("AUTH_LOCAL_SMS_MOCK requires local dev/test, fake providers and loopback origins/database; forbidden in production");
  const secureCookies = env.AUTH_SECURE_COOKIES === "true";
  if (env.NODE_ENV === "production" && !secureCookies) {
    throw new ConfigurationError("AUTH_SECURE_COOKIES=true is required in production");
  }
  return {
    apiOrigin,
    userOrigin,
    adminOrigin,
    userSecret,
    adminSecret,
    adminBootstrapSecret,
    secureCookies,
    localSmsMock,
    testOperationsEnabled: capabilities.testOperationsEnabled === true,
    // Independent of PROVIDER_MODE: selecting OSS media storage never turns SMS,
    // identity or payment providers into real mode.
    mediaStorage: resolveMediaStorage(env, workingDirectory),
  };
}

export async function mountAuthHandlers(
  app: INestApplication,
  options: AuthRuntimeOptions,
): Promise<void> {
  const [{ betterAuth }, { drizzleAdapter }, { toNodeHandler }, { bearer, phoneNumber, twoFactor, username }, { APIError, createAuthEndpoint, createAuthMiddleware, isAPIError }, { setSessionCookie }, { hashPassword, verifyPassword }] = await Promise.all([
    import("better-auth"),
    import("@better-auth/drizzle-adapter"),
    import("better-auth/node"),
    import("better-auth/plugins"),
    import("better-auth/api"),
    import("better-auth/cookies"),
    import("better-auth/crypto"),
  ]);

  const userSchema = createAuthSchema("zzsh_auth_user");
  const adminSchema = createAuthSchema("zzsh_auth_admin");
  const userDatabase = drizzle(options.pool);
  const adminDatabase = drizzle(options.pool);
  if ((options.testYunxinProvider || options.testImMessageTransport) && !options.testOperationsEnabled) {
    throw new ConfigurationError("Test IM providers require test operations capability");
  }
  const fakeSmsOutbox = options.fakeSmsOutbox ?? new Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" | "phone-registration" }>();
  const trustedOrigins = [options.apiOrigin, options.userOrigin, options.adminOrigin];
  const yunxinRuntime = options.yunxin
      ? (() => {
        const repository = new YunxinIdentityRepository(options.pool);
        const provider = options.testYunxinProvider ?? new YunxinServerApiClient({
          appKey: options.yunxin!.appKey,
          appSecret: options.yunxin!.appSecret,
        });
        const provisioner = new ImIdentityProvisioner(repository, provider);
        return {
          repository,
          provider,
          provisioner,
          tokenService: new YunxinDynamicTokenService(repository, options.yunxin!),
        };
      })()
    : undefined;
  const yunxinConsultation: ConsultationRouteOptions | undefined = yunxinRuntime ? {
    ...(options.supportDispatch?.appId === options.yunxin!.appId ? { wakeDispatch: () => app.get(OrderDispatchLifecycle).wake() } : {}),
    pool: options.pool,
    appId: options.yunxin!.appId,
    provider: yunxinRuntime.provider,
    ...(options.testImMessageTransport ? { messageTransport: options.testImMessageTransport } : {}),
    supportManager: {
      key: supportManagerIdentityKey(options.yunxin!.appId),
      provisioner: yunxinRuntime.provisioner,
    },
  } : undefined;
  // Filled right after the user auth instance exists; the after hook only runs at request time.
  const userSignInApi: { retry?: (signIn: "username" | "phone-number", body: Record<string, unknown>, headers: Headers) => Promise<Response> } = {};
  const signInIdentifier: { dispatch?: (identifier: string, password: string, headers: Headers, kind?: "phone" | "username") => Promise<Response> } = {};
  const legacyHook = (ctx: unknown) => handleUserLegacyAfterHook(ctx as UserSignInHookContext, {
    pool: options.pool,
    hashPassword,
    verifyPassword: (password, hash) => verifyPassword({ password, hash }),
    isAPIError,
    retrySignIn: (signIn, body, headers) => {
      if (!userSignInApi.retry) throw new Error("user sign-in API is unavailable");
      return userSignInApi.retry(signIn, body, headers);
    },
  });
  const common = {
    baseURL: options.apiOrigin,
    trustedOrigins,
    session: {
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        locked: { type: "boolean", defaultValue: false, input: false },
        pinHash: { type: "string", required: false, input: false, returned: false },
        pinFailures: { type: "number", defaultValue: 0, input: false },
      },
    },
    user: {
      additionalFields: {
        suspended: { type: "boolean", defaultValue: false, input: false },
      },
    },
    emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true },
    advanced: { useSecureCookies: options.secureCookies },
    logger: { disabled: true },
    onAPIError: { throw: true },
  } as const;

  const userAuth = betterAuth({
    ...common,
    appName: "洲洲商行用户认证",
    basePath: "/api/auth/user",
    secret: options.userSecret,
    database: drizzleAdapter(userDatabase, { provider: "pg", schema: userSchema, transaction: true }),
    session: { ...common.session, expiresIn: USER_SESSION_EXPIRES_IN_SECONDS },
    user: common.user,
    plugins: [
      username({ immutableUsername: true }),
      bearer(),
      buildFakePhoneNumberPlugin(phoneNumber, fakeSmsOutbox, options.localSmsMock),
      buildPhoneRegistrationPlugin(createAuthEndpoint, APIError, setSessionCookie, options.pool, fakeSmsOutbox, options.fakeSmsOutbox !== undefined || options.localSmsMock === true, options.localSmsMock === true, signInIdentifier),
    ],
    advanced: { ...common.advanced, cookiePrefix: "zzsh_user" },
    ...(options.userRateLimit ? { rateLimit: options.userRateLimit } : {}),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!["/sign-in/phone-number", "/phone-number/send-otp", "/phone-number/verify", "/phone-number/request-password-reset", "/phone-number/reset-password"].includes(ctx.path)) return;
        if (!ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) return;
        const phoneNumber = normalizeMainlandPhone((ctx.body as Record<string, unknown>).phoneNumber);
        if (!phoneNumber) throw new APIError("BAD_REQUEST", { message: "Invalid phone number" });
        (ctx.body as Record<string, unknown>).phoneNumber = phoneNumber;
      }),
      after: createAuthMiddleware(legacyHook),
    },
    databaseHooks: {
      verification: {
        create: {
          before: async (data) => {
            // Only user phone challenges; admin TOTP and other verification records are untouched.
            if (options.localSmsMock && /^\+86\d{11}(?:-request-password-reset)?$/.test(data.identifier)) {
              return { data: { ...data, value: "888888:0" } };
            }
            return { data };
          },
        },
      },
      session: {
        create: {
          before: async (data: { userId: string }) => {
            const result = await options.pool.query<{ suspended: boolean; accountStatus: string | null }>(
              `SELECT u."suspended", s."account_status" AS "accountStatus"
                 FROM "zzsh_auth_user"."user" u
                 LEFT JOIN "zzsh_iam"."user_identity_state" s ON s."user_id" = u."id"
                WHERE u."id" = $1`,
              [data.userId],
            );
            if (result.rows[0]?.suspended || result.rows[0]?.accountStatus && result.rows[0].accountStatus !== "ACTIVE") {
              throw new APIError("FORBIDDEN", { message: "Account unavailable" });
            }
            return { data };
          },
        },
      },
    },
  });

  signInIdentifier.dispatch = async (identifier, password, headers, kind) => {
    const phoneNumber = normalizeMainlandPhone(identifier);
    const resolution = kind === "phone" ? "phone-number" : kind === "username" ? "username" : await resolveSignInIdentifier(options.pool, identifier);
    if (resolution === "ambiguous") throw new APIError("BAD_REQUEST", { message: "Ambiguous authentication identifier" });
    const response = resolution === "phone-number"
      ? await userAuth.api.signInPhoneNumber({ body: { phoneNumber: phoneNumber ?? identifier, password }, headers, asResponse: true })
      : await userAuth.api.signInUsername({ body: { username: identifier.toLowerCase(), password }, headers, asResponse: true });
    return response as Response;
  };

  const adminAuth = betterAuth({
    ...common,
    appName: "洲洲商行管理认证",
    basePath: "/api/auth/admin",
    secret: options.adminSecret,
    database: drizzleAdapter(adminDatabase, { provider: "pg", schema: adminSchema, transaction: true }),
    session: { ...common.session, expiresIn: ADMIN_SESSION_EXPIRES_IN_SECONDS },
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [username({ immutableUsername: true }), bearer(), twoFactor()],
    advanced: { ...common.advanced, cookiePrefix: "zzsh_admin" },
     hooks: {
       before: createAuthMiddleware(async (ctx) => {
         if (ctx.path === "/sign-in/email" || ctx.path === "/sign-in/username") {
           ctx.body.rememberMe = true;
         }
         if (ctx.path !== "/change-password") return;
         if (ctx.body.currentPassword === ctx.body.newPassword) {
           throw new APIError("BAD_REQUEST", { message: "New password must differ from current password" });
        }
        ctx.body.revokeOtherSessions = true;
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (data: { userId: string }) => {
            const result = await options.pool.query<{ suspended: boolean }>(
              'SELECT "suspended" FROM "zzsh_auth_admin"."user" WHERE "id" = $1',
              [data.userId],
            );
            if (result.rows[0]?.suspended) throw new APIError("FORBIDDEN", { message: "Account unavailable" });
            await assertAdminSessionCreationAllowed(options.pool, data.userId, APIError);
            return { data };
          },
          after: async (session: { userId: string }) => {
            await options.pool.query(
              `UPDATE "zzsh_iam"."admin_security" AS security
                  SET "last_full_authenticated_at" = clock_timestamp(),
                      "updated_at" = clock_timestamp()
                 FROM "zzsh_auth_admin"."user" AS admin_user
                WHERE security."admin_user_id" = $1
                  AND admin_user."id" = security."admin_user_id"
                  AND security."status" = 'ACTIVE'
                  AND admin_user."twoFactorEnabled" = true`,
              [session.userId],
            );
          },
        },
      },
    },
  });

  userSignInApi.retry = async (signIn, body, headers) => {
    // The hook body was already validated by the same endpoint; the cast only bridges the
    // per-endpoint generated body types.
    const response = signIn === "username"
      ? await userAuth.api.signInUsername({ body: body as never, headers, asResponse: true })
      : await userAuth.api.signInPhoneNumber({ body: body as never, headers, asResponse: true });
    return response as unknown as Response;
  };

  const userWebHandler = (request: Request) => safeWebAuthHandler(userAuth.handler, request);
  const adminWebHandler = (request: Request) => safeWebAuthHandler(adminAuth.handler, request);
  const userNodeHandler = toNodeHandler(userWebHandler) as unknown as AuthHandler;
  const adminNodeHandler = toNodeHandler(adminWebHandler) as unknown as AuthHandler;
  const securityOptions: AuthSecurityOptions = {
    pool: options.pool,
    adminAuth: adminAuth as unknown as Parameters<typeof mountAuthSecurityHandlers>[1]["adminAuth"],
    userAuth: userAuth as unknown as Parameters<typeof mountAuthSecurityHandlers>[1]["userAuth"],
    apiOrigin: options.apiOrigin,
    adminOrigin: options.adminOrigin,
    userOrigin: options.userOrigin,
    adminBootstrapSecret: options.adminBootstrapSecret,
    notifyAdminSecurity: options.fakeAdminNotificationOutbox
      ? async (notification) => { options.fakeAdminNotificationOutbox!.push(notification); }
      : undefined,
    hashPassword,
    verifyPassword: (password, hash) => verifyPassword({ password, hash }),
    // ponytail: process-local failure buckets are the minimum BFF guard; use a shared limiter before multi-instance rollout.
    rateLimitState: options.rateLimitState ?? new Map(),
    securityVerificationBudget: options.securityVerificationBudget ?? { inFlight: 0 },
    realNameProvider: options.realNameProvider ?? createFakeRealNameProvider("UNKNOWN"),
    userObligationReader: async (userId,client) => {
      const pending=await client.query("SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id WHERE a.owner_user_id=$1 AND v.review_state IN ('SUBMITTED','APPROVED') LIMIT 1",[userId]);
      if(pending.rowCount) return "PENDING";
      const orderPending=await client.query("SELECT 1 FROM zzsh_order.rental_order WHERE status IN ('PENDING_PAYMENT','PAID') AND (renter_user_id=$1 OR owner_user_id=$1) LIMIT 1",[userId]);
      if(orderPending.rowCount) return "PENDING";
      return options.userObligationReader ? options.userObligationReader(userId,client) : "UNKNOWN";
    },
    testOperationsEnabled: options.testOperationsEnabled,
    ...(yunxinRuntime ? {
      imProvisioner: yunxinRuntime.provisioner,
      imIdentityRepository: yunxinRuntime.repository,
      imAppId: options.yunxin!.appId,
    } : {}),
  };
  (app as unknown as { useBodyParser: (parser: "json", rawBody: boolean) => void }).useBodyParser("json", true);
  mountRealm(
    app,
    "user",
    userAuth as unknown as AuthRealm,
    userNodeHandler,
    [options.apiOrigin, options.userOrigin],
    USER_ALLOWED_PATHS,
    options.pool,
    async (request, response, path) => USER_SECURITY_PATHS.has(path) && await handleUserIdentityRoute(request, response, securityOptions),
  );
  mountRealm(app, "admin", adminAuth as unknown as AuthRealm, adminNodeHandler, [options.apiOrigin, options.adminOrigin], ADMIN_ALLOWED_PATHS, options.pool);
  mountAuthSecurityHandlers(app, securityOptions);
  if (yunxinRuntime) {
    mountYunxinHandlers(app, {
      security: securityOptions,
      appId: options.yunxin!.appId,
      repository: yunxinRuntime.repository,
      provisioner: yunxinRuntime.provisioner,
      tokenService: yunxinRuntime.tokenService,
      consultation: yunxinConsultation,
    });
    app.get(MessageScopeRecoveryLifecycle).start(yunxinConsultation!);
  }
  if(options.testSupplyGateReader && !options.testOperationsEnabled) throw new Error("Supply fixtures require test operations capability");
  // Occupancy truth comes from the order table; the base reader keeps the
  // publisher-bail seam semantics (UNKNOWN fails closed until M5).
  const supplyGateReader=composeSupplyGateWithOrderOccupancy(options.testSupplyGateReader ?? unknownSupplyGate);
  const mediaStorage = options.mediaStorage ?? createLocalMediaStorage(join(process.cwd(), "uploads"));
  const orderHoldSeconds = options.orderHoldSeconds ?? (() => {
    const raw = process.env.ORDER_HOLD_SECONDS?.trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  })();
  const orderOptions: OrderRuntimeOptions = { ...securityOptions, orderHoldSeconds, supplyGateReader };
  mountAdminBffHandlers(app, {
    apiOrigin: options.apiOrigin,
    adminOrigin: options.adminOrigin,
    adminAuthHandler: adminWebHandler,
    adminSecurityOptions: securityOptions,
    supply: { ...securityOptions, mediaStorage, supplyGateReader },
    order: orderOptions,
    ...(yunxinRuntime ? {
      yunxin: {
        security: securityOptions,
        appId: options.yunxin!.appId,
        repository: yunxinRuntime.repository,
        provisioner: yunxinRuntime.provisioner,
        tokenService: yunxinRuntime.tokenService,
        consultation: yunxinConsultation,
      },
    } : {}),
  });
  mountUserSupplyBff(app,{...securityOptions,mediaStorage,supplyGateReader});
  mountSupplyHandlers(app, {
    ...securityOptions,
    mediaStorage,
    supplyGateReader,
  });
  mountContentHandlers(app, {
    ...securityOptions,
    mediaStorage,
    supplyGateReader,
  });
  mountOrderHandlers(app, orderOptions);
  mountUserOrderBff(app, orderOptions);
  if (options.orderTeams) {
    const provider=yunxinRuntime?.provider as (YunxinOrderTeamApi | undefined);
    if(!yunxinRuntime || !provider?.createOrderTeam || !provider.readOrderTeam) throw new ConfigurationError("Order Teams require an explicitly configured provider");
    app.get(OrderTeamLifecycle).start({pool:options.pool,appId:options.yunxin!.appId,provider,identities:yunxinRuntime.provisioner,membersLimit:options.orderTeams.membersLimit},options.orderTeams.intervalMs,options.orderTeams.batchLimit);
  }
  if (options.supportDispatch) app.get(OrderDispatchLifecycle).start({ ...options.supportDispatch, pool: options.pool,
    onResult: (result) => { if(options.orderTeams)app.get(OrderTeamLifecycle).wake(); options.supportDispatch!.onResult?.(result); } });
}

function mountRealm(
  app: INestApplication,
  realm: AuthRealmName,
  auth: AuthRealm,
  handler: AuthHandler,
  origins: readonly string[],
  allowedPaths: ReadonlySet<string>,
  pool: Pool,
  before?: (request: NodeRequest, response: NodeResponse, path: string) => Promise<boolean>,
): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: NodeRequest, response: NodeResponse) => Promise<void>) => void;
  };
  expressApp.use(`/api/auth/${realm}`, async (request, response) => {
    const requestId = ensureApiV1RequestId(request);
    response.setHeader("X-Request-Id", requestId);
    const path = pathOf(request);
    if (before && await before(request, response, path)) return;
    if (!allowedPaths.has(path) || !originAllowed(request, origins)) {
      const status = path === "/" || !originAllowed(request, origins) ? 403 : 404;
      sendApiError(response, status, status === 403 ? API_V1_ERROR_CODES.FORBIDDEN : API_V1_ERROR_CODES.NOT_FOUND, "Request rejected", requestId);
      return;
    }
    try {
      request.headers["x-request-id"] = requestId;
      const rejection = await preflightAuthRealmSecurity(request, path, { realm, auth, pool });
      if (rejection) {
        sendApiError(response, rejection.status, rejection.code, rejection.message, requestId);
        return;
      }
      await handler(request, response);
    } catch {
      sendApiError(response, 500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Internal server error", requestId);
    }
  });
}
