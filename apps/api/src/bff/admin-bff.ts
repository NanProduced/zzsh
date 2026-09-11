import type { INestApplication } from "@nestjs/common";

import { getWorkspaceLayout, saveWorkspaceLayout } from "../auth/admin-workspace-layout";
import {
  getAdminSessionSnapshot,
  handleAdminSecurity,
  preflightAuthRealmSecurity,
  readAdminContext,
  SecurityApiError,
  type AuthSecurityNodeRequest,
  type AuthSecurityNodeResponse,
  type AuthSecurityOptions,
} from "../auth/auth-security";
import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";

type NodeRequest = AuthSecurityNodeRequest & {
  ip?: string;
  socket?: { remoteAddress?: string };
};

type NodeResponse = AuthSecurityNodeResponse & {
  send?: (body: unknown) => void;
};

type WebAuthHandler = (request: Request) => Promise<Response>;

export type AdminBffOptions = {
  apiOrigin: string;
  adminOrigin: string;
  adminAuthHandler: WebAuthHandler;
  adminSecurityOptions: AuthSecurityOptions;
};

const AUTH_PATHS = new Map([
  ["/auth/sign-in", "/api/auth/admin/sign-in/email"],
  ["/auth/sign-in/username", "/api/auth/admin/sign-in/username"],
  ["/auth/sign-out", "/api/auth/admin/sign-out"],
  ["/auth/change-password", "/api/auth/admin/change-password"],
  ["/auth/two-factor/enable", "/api/auth/admin/two-factor/enable"],
  ["/auth/two-factor/verify-totp", "/api/auth/admin/two-factor/verify-totp"],
  ["/auth/two-factor/verify-backup-code", "/api/auth/admin/two-factor/verify-backup-code"],
  ["/auth/two-factor/generate-backup-codes", "/api/auth/admin/two-factor/generate-backup-codes"],
]);

const SECURITY_PATHS = new Map([
  ["/security/enrollment/activate", "/api/v1/admin/security/enrollment/activate"],
  ["/security/pin/set", "/api/v1/admin/security/pin/set"],
  ["/security/pin/change", "/api/v1/admin/security/pin/change"],
  ["/security/pin/lock", "/api/v1/admin/security/pin/lock"],
  ["/security/pin/unlock", "/api/v1/admin/security/pin/unlock"],
  ["/security/freeze", "/api/v1/admin/security/freeze"],
  ["/security/unfreeze", "/api/v1/admin/security/unfreeze"],
  ["/security/admins/force-logout", "/api/v1/admin/security/admins/force-logout"],
  ["/security/admins", "/api/v1/admin/security/admins"],
  ["/security/admins/detail", "/api/v1/admin/security/admins/detail"],
  ["/security/admins/create", "/api/v1/admin/security/admins/create"],
  ["/security/admins/update", "/api/v1/admin/security/admins/update"],
  ["/security/admins/assign", "/api/v1/admin/security/admins/assign"],
  ["/security/roles", "/api/v1/admin/security/roles"],
  ["/security/roles/create", "/api/v1/admin/security/roles/create"],
  ["/security/roles/update", "/api/v1/admin/security/roles/update"],
  ["/security/recovery/request", "/api/v1/admin/security/recovery/request"],
  ["/security/recovery/confirm", "/api/v1/admin/security/recovery/confirm"],
  ["/security/recovery/complete", "/api/v1/admin/security/recovery/complete"],
  ["/security/recovery/pending", "/api/v1/admin/security/recovery/pending"],
  ["/security/users/restore-candidates", "/api/v1/admin/security/users/restore-candidates"],
  ["/security/users/restore", "/api/v1/admin/security/users/restore"],
  ["/security/approvals/templates", "/api/v1/admin/security/approvals/templates"],
  ["/security/approvals/templates/update", "/api/v1/admin/security/approvals/templates/update"],
  ["/security/approvals/requests", "/api/v1/admin/security/approvals/requests"],
  ["/security/approvals/requests/mine", "/api/v1/admin/security/approvals/requests/mine"],
  ["/security/approvals/requests/pending", "/api/v1/admin/security/approvals/requests/pending"],
  ["/security/approvals/requests/detail", "/api/v1/admin/security/approvals/requests/detail"],
  ["/security/approvals/requests/decision", "/api/v1/admin/security/approvals/requests/decision"],
  ["/security/approvals/requests/add-candidate", "/api/v1/admin/security/approvals/requests/add-candidate"],
  ["/security/approvals/requests/execute", "/api/v1/admin/security/approvals/requests/execute"],
  ["/security/approvals/audit/events", "/api/v1/admin/security/approvals/audit/events"],
  ["/security/audit/events", "/api/v1/admin/security/audit/events"],
]);

const GET_SECURITY_PATHS = new Set([
  "/security/admins",
  "/security/admins/detail",
  "/security/roles",
  "/security/recovery/pending",
  "/security/users/restore-candidates",
  "/security/approvals/templates",
  "/security/approvals/requests/mine",
  "/security/approvals/requests/pending",
  "/security/approvals/requests/detail",
  "/security/approvals/audit/events",
  "/security/audit/events",
]);

// The 2FA challenge is cookie-backed after password sign-in; keep the allowlist
// narrow while forwarding that challenge and the resulting admin session.
const ADMIN_AUTH_COOKIE = /^(?:__Secure-|__Host-)?zzsh_admin\.(?:session_token(?:\.\d+)?|two_factor|dont_remember|trust_device)$/;
const SENSITIVE_RESPONSE_KEYS = new Set(["token", "sessionToken", "accessToken", "refreshToken", "pinHash"]);
const AUTH_RESPONSE_HEADERS = new Set(["cache-control", "content-type", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestPath(request: NodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "/";
  const path = source.split("?", 1)[0] || "/";
  const prefix = "/api/bff/admin";
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length) || "/";
  return path;
}

function requestQuery(request: NodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "";
  const index = source.indexOf("?");
  return index >= 0 ? source.slice(index) : "";
}

function originAllowed(request: NodeRequest, adminOrigin: string): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return origin === adminOrigin;
}

function adminSessionCookie(request: NodeRequest): string {
  const raw = headerValue(request.headers.cookie) ?? "";
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator > 0 && ADMIN_AUTH_COOKIE.test(part.slice(0, separator).trim());
    })
    .join("; ");
}

function requestHeaders(request: NodeRequest, requestId: string, adminOrigin: string): Headers {
  const headers = new Headers({
    accept: "application/json",
    origin: adminOrigin,
    "x-request-id": requestId,
  });
  const cookie = adminSessionCookie(request);
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_RESPONSE_KEYS.has(key)) continue;
    result[key] = sanitizeResponse(child);
  }
  return result;
}

function sendJson(response: NodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response
    .status(status)
    .setHeader("X-Request-Id", requestId)
    .setHeader("Cache-Control", "no-store")
    .json(body);
}

function sendError(
  response: NodeResponse,
  status: number,
  code: (typeof API_V1_ERROR_CODES)[keyof typeof API_V1_ERROR_CODES],
  message: string,
  requestId: string,
): void {
  sendJson(response, status, { error: { code, message, requestId } }, requestId);
}

function copyCookies(source: Headers): string[] {
  const withCookies = source as Headers & { getSetCookie?: () => string[] };
  return withCookies.getSetCookie?.() ?? (source.get("set-cookie") ? [source.get("set-cookie")!] : []);
}

function copyResponseHeaders(source: Headers, response: NodeResponse, requestId: string): void {
  source.forEach((value, key) => {
    if (AUTH_RESPONSE_HEADERS.has(key)) response.setHeader(key, value);
  });
  const cookies = copyCookies(source);
  if (cookies.length > 0) response.setHeader("Set-Cookie", cookies);
  response.setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store");
}

async function forwardAuth(
  request: NodeRequest,
  response: NodeResponse,
  targetPath: string,
  requestId: string,
  options: AdminBffOptions,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const headers = requestHeaders(request, requestId, options.adminOrigin);
  const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify(request.body ?? {});
  if (body !== undefined) headers.set("content-type", "application/json");
  const rejection = await preflightAuthRealmSecurity(
    {
      method,
      url: targetPath,
      originalUrl: targetPath,
      headers: Object.fromEntries(headers.entries()),
    },
    targetPath.slice("/api/auth/admin".length) || "/",
    { realm: "admin", auth: options.adminSecurityOptions.adminAuth, pool: options.adminSecurityOptions.pool },
  );
  if (rejection) {
    sendError(response, rejection.status, rejection.code, rejection.message, requestId);
    return;
  }
  let upstream: Response;
  try {
    upstream = await options.adminAuthHandler(new Request(new URL(targetPath, options.apiOrigin), { method, headers, body }));
  } catch {
    sendError(response, 500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Internal server error", requestId);
    return;
  }
  copyResponseHeaders(upstream.headers, response, requestId);
  const text = await upstream.text();
  if (!text) {
    response.status(upstream.status);
    if (response.send) response.send("");
    else response.json({});
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    sendError(response, 500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Internal server error", requestId);
    return;
  }
  response.status(upstream.status).json(sanitizeResponse(payload));
}

type CapturedResponse = {
  headersSent: boolean;
  statusCode: number;
  headers: Map<string, string | string[]>;
  body: unknown;
};

function captureResponse(): CapturedResponse & NodeResponse {
  const captured: CapturedResponse & NodeResponse = {
    headersSent: false,
    statusCode: 200,
    headers: new Map(),
    body: undefined,
    setHeader(name, value) {
      captured.headers.set(name.toLowerCase(), value);
      return captured;
    },
    status(status) {
      captured.statusCode = status;
      return captured;
    },
    json(body) {
      captured.body = body;
      captured.headersSent = true;
    },
  };
  return captured;
}

async function forwardSecurity(
  request: NodeRequest,
  response: NodeResponse,
  targetPath: string,
  requestId: string,
  options: AdminBffOptions,
): Promise<void> {
  const captured = captureResponse();
  const forwardedHeaders: Record<string, string | string[] | undefined> = { ...request.headers, "x-request-id": requestId };
  const cookie = adminSessionCookie(request);
  if (cookie) forwardedHeaders.cookie = cookie;
  else delete forwardedHeaders.cookie;
  delete forwardedHeaders.authorization;
  const rewrittenPath = `${targetPath}${requestQuery(request)}`;
  const rewritten: AuthSecurityNodeRequest = {
    ...request,
    url: rewrittenPath,
    originalUrl: rewrittenPath,
    headers: forwardedHeaders,
  };
  try {
    await handleAdminSecurity(rewritten, captured as AuthSecurityNodeResponse, options.adminSecurityOptions);
  } catch (error) {
    if (error instanceof SecurityApiError) {
      sendError(response, error.status, error.code, error.message, requestId);
    } else {
      sendError(response, 500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Internal server error", requestId);
    }
    return;
  }
  for (const [name, value] of captured.headers) response.setHeader(name, value);
  response.setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store");
  response.status(captured.statusCode).json(sanitizeResponse(captured.body));
}

async function handleAdminBff(request: NodeRequest, response: NodeResponse, options: AdminBffOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const path = requestPath(request);
  const method = (request.method ?? "GET").toUpperCase();
  if (!originAllowed(request, options.adminOrigin)) {
    sendError(response, 403, API_V1_ERROR_CODES.FORBIDDEN, "Request rejected", requestId);
    return;
  }
  if (headerValue(request.headers.authorization)) {
    sendError(response, 400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request rejected", requestId);
    return;
  }
  if (path === "/session") {
    if (method !== "GET") {
      sendError(response, 404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found", requestId);
      return;
    }
    try {
      const snapshot = await getAdminSessionSnapshot(requestHeaders(request, requestId, options.adminOrigin), options.adminSecurityOptions);
      sendJson(response, 200, snapshot, requestId);
    } catch (error) {
      if (error instanceof SecurityApiError) sendError(response, error.status, error.code, error.message, requestId);
      else sendError(response, 500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Internal server error", requestId);
    }
    return;
  }
  if (path === "/workspace/layout") {
    if (method !== "GET" && method !== "PUT") {
      sendError(response, 404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found", requestId);
      return;
    }
    try {
      const context = await readAdminContext(request, options.adminSecurityOptions);
      const payload = method === "GET"
        ? await getWorkspaceLayout(options.adminSecurityOptions.pool, context.userId)
        : await saveWorkspaceLayout(options.adminSecurityOptions.pool, context.userId, request.body);
      sendJson(response, 200, payload, requestId);
    } catch (error) {
      if (error instanceof SecurityApiError) sendError(response, error.status, error.code, error.message, requestId);
      else sendError(response, 500, API_V1_ERROR_CODES.INTERNAL_ERROR, "Internal server error", requestId);
    }
    return;
  }
  const targetPath = AUTH_PATHS.get(path) ?? SECURITY_PATHS.get(path);
  if (!targetPath || (method !== "POST" && !(method === "GET" && GET_SECURITY_PATHS.has(path)))) {
    sendError(response, 404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found", requestId);
    return;
  }
  if (AUTH_PATHS.has(path)) await forwardAuth(request, response, targetPath, requestId, options);
  else await forwardSecurity(request, response, targetPath, requestId, options);
}

export function mountAdminBffHandlers(app: INestApplication, options: AdminBffOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: NodeRequest, response: NodeResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/bff/admin", (request, response) => handleAdminBff(request, response, options));
}
