import { isHttpOrigin, userCookies, copySetCookies, sanitizeResponse, readBoundedBody, BodyTooLargeError } from "../../../../../lib/user-proxy.ts";
import { randomUUID } from "node:crypto";

const LOCAL_ONLY = process.env.NODE_ENV !== "production";
const API_ORIGIN = process.env.ZZSH_API_ORIGIN ?? (LOCAL_ONLY ? "http://127.0.0.1:3102" : "");
const WEB_ORIGIN = process.env.ZZSH_WEB_ORIGIN ?? (LOCAL_ONLY ? "http://127.0.0.1:3100" : "");
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;

const ORIGIN_CONFIGURATION_VALID = isHttpOrigin(API_ORIGIN) && isHttpOrigin(WEB_ORIGIN);
const USER_AUTH_PATHS = new Set([
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
  "/identity/status",
  "/identity/verify",
  "/trade-eligibility/check",
  "/account/deactivate",
  "/account/cancel",
]);
const USER_SECURITY_POST_PATHS = new Set([
  "/identity/verify",
  "/trade-eligibility/check",
  "/account/deactivate",
  "/account/cancel",
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
function errorResponse(status: number, code: string, requestId: string): Response {
  return Response.json({ error: { code, message: "Authentication request rejected", requestId } }, { status, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
}

async function forward(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? `req_web_${randomUUID().replaceAll("-", "")}`;
  if (!ORIGIN_CONFIGURATION_VALID) return errorResponse(503, "INTERNAL_ERROR", requestId);
  const { path } = await params;
  const authPath = `/${path.join("/")}`;
  if (!USER_AUTH_PATHS.has(authPath)) return errorResponse(404, "NOT_FOUND", requestId);
  const method = request.method.toUpperCase();
  const expectedSecurityMethod = authPath === "/identity/status" ? "GET" : USER_SECURITY_POST_PATHS.has(authPath) ? "POST" : undefined;
  if (expectedSecurityMethod && method !== expectedSecurityMethod) return errorResponse(404, "NOT_FOUND", requestId);
  if (method !== "GET" && method !== "HEAD" && request.headers.get("origin") !== WEB_ORIGIN) return errorResponse(403, "FORBIDDEN", requestId);
  const headers = new Headers({ Origin: WEB_ORIGIN, "X-Request-Id": requestId });
  const cookie = userCookies(request.headers.get("cookie"));
  if (cookie) headers.set("Cookie", cookie);
  const contentType = request.headers.get("content-type");
  if (contentType?.toLowerCase().startsWith("application/json")) headers.set("Content-Type", "application/json");
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const rawLength = request.headers.get("content-length");
    const contentLength = rawLength === null ? undefined : Number(rawLength);
    if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES)) {
      return errorResponse(413, "INVALID_ARGUMENT", requestId);
    }
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return errorResponse(error instanceof BodyTooLargeError ? 413 : 400, "INVALID_ARGUMENT", requestId);
    }
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/api/auth/user${authPath}`, API_ORIGIN), { method, headers, body, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    return errorResponse(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => { if (RESPONSE_HEADERS.has(key)) responseHeaders.set(key, value); });
  for (const cookieValue of copySetCookies(upstream.headers)) responseHeaders.append("Set-Cookie", cookieValue);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Request-Id", requestId);
  let text: string;
  try {
    text = method === "HEAD" ? "" : await upstream.text();
  } catch {
    return errorResponse(502, "INTERNAL_ERROR", requestId);
  }
  if (!text) return new Response(null, { status: upstream.status, headers: responseHeaders });
  let payload: unknown;
  try { payload = sanitizeResponse(JSON.parse(text)); } catch { return errorResponse(502, "INTERNAL_ERROR", requestId); }
  return new Response(JSON.stringify(payload), { status: upstream.status, headers: responseHeaders });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
export async function HEAD(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
