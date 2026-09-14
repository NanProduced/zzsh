import { mountUserSupplyBff } from "../bff/user-supply-bff";
import { unknownSupplyGate, type SupplyGateReader } from "../supply/publishing";
import type { INestApplication } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
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
import { ConfigurationError, readSecret } from "../config/config";
import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";

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
};

export type AuthRuntimeCapabilities = {
  testOperationsEnabled?: boolean;
};

export type AuthRuntimeOptions = AuthRuntimeConfig & {
  pool: Pool;
  fakeSmsOutbox?: Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" }>;
  fakeAdminNotificationOutbox?: AdminSecurityNotification[];
  rateLimitState?: Map<string, { failures: number; resetAt: number }>;
  securityVerificationBudget?: { inFlight: number };
  realNameProvider?: RealNameProvider;
  userObligationReader?: UserObligationReader;
  mediaStorage?: MediaStorage;
  testSupplyGateReader?: SupplyGateReader;
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
  "/sign-in/username",
  "/sign-in/phone-number",
  "/sign-out",
  "/sign-up/email",
  "/phone-number/send-otp",
  "/phone-number/verify",
  "/phone-number/request-password-reset",
  "/phone-number/reset-password",
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
  outbox: Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" }>,
) {
  return phoneNumber({
    sendOTP: async ({ phoneNumber: target, code }: { phoneNumber: string; code: string }) => {
      outbox.set(target, { code, sentAt: new Date().toISOString(), purpose: "phone-verification" });
    },
    sendPasswordResetOTP: async ({ phoneNumber: target, code }: { phoneNumber: string; code: string }) => {
      outbox.set(`${target}-request-password-reset`, { code, sentAt: new Date().toISOString(), purpose: "password-reset" });
    },
    signUpOnVerification: {
      getTempEmail: (phone: string) => `phone-${createHash("sha256").update(phone).digest("hex")}@phone.zzsh.invalid`,
      getTempName: () => "洲洲用户",
    },
  });
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
  const [{ betterAuth }, { drizzleAdapter }, { toNodeHandler }, { bearer, phoneNumber, twoFactor, username }, { APIError, createAuthMiddleware, isAPIError }, { hashPassword, verifyPassword }] = await Promise.all([
    import("better-auth"),
    import("@better-auth/drizzle-adapter"),
    import("better-auth/node"),
    import("better-auth/plugins"),
    import("better-auth/api"),
    import("better-auth/crypto"),
  ]);

  const userSchema = createAuthSchema("zzsh_auth_user");
  const adminSchema = createAuthSchema("zzsh_auth_admin");
  const userDatabase = drizzle(options.pool);
  const adminDatabase = drizzle(options.pool);
  const fakeSmsOutbox = options.fakeSmsOutbox ?? new Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" }>();
  const trustedOrigins = [options.apiOrigin, options.userOrigin, options.adminOrigin];
  // Filled right after the user auth instance exists; the after hook only runs at request time.
  const userSignInApi: { retry?: (signIn: "username" | "phone-number", body: Record<string, unknown>, headers: Headers) => Promise<Response> } = {};
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
      buildFakePhoneNumberPlugin(phoneNumber, fakeSmsOutbox),
    ],
    advanced: { ...common.advanced, cookiePrefix: "zzsh_user" },
    ...(options.userRateLimit ? { rateLimit: options.userRateLimit } : {}),
    hooks: {
      after: createAuthMiddleware(legacyHook),
    },
    databaseHooks: {
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
      return options.userObligationReader ? options.userObligationReader(userId,client) : "UNKNOWN";
    },
    testOperationsEnabled: options.testOperationsEnabled,
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
  if(options.testSupplyGateReader && !options.testOperationsEnabled) throw new Error("Supply fixtures require test operations capability");
  const supplyGateReader=options.testSupplyGateReader ?? unknownSupplyGate;
  const mediaStorage = options.mediaStorage ?? createLocalMediaStorage(join(process.cwd(), "uploads"));
  mountAdminBffHandlers(app, {
    apiOrigin: options.apiOrigin,
    adminOrigin: options.adminOrigin,
    adminAuthHandler: adminWebHandler,
    adminSecurityOptions: securityOptions,
    supply: { ...securityOptions, mediaStorage, supplyGateReader },
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
