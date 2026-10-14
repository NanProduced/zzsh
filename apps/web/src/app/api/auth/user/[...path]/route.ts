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
  "/sign-in/phone-number",
  "/sign-out",
  "/phone-registration/send-otp",
  "/phone-registration/complete",
  "/security/overview", "/profile/nickname", "/security/challenge/send", "/security/challenge/verify",
  "/security/password", "/security/email", "/security/phone", "/security/recovery/complete", "/security/operation",
  "/security/sessions", "/security/sessions/revoke", "/security/sessions/revoke-others", "/security/sessions/revoke-all",
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
function errorResponse(status: number, code: string, requestId: string, headers?: Headers, accepted = false): Response {
  return Response.json({ error: { code, message: "Authentication request rejected", requestId, ...(accepted ? { accepted: true } : {}) } }, { status, headers: headers ?? { "Cache-Control": "no-store", "X-Request-Id": requestId } });
}

async function forward(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? `req_web_${randomUUID().replaceAll("-", "")}`;
  if (!ORIGIN_CONFIGURATION_VALID) return errorResponse(503, "INTERNAL_ERROR", requestId);
  const { path } = await params;
  const authPath = `/${path.join("/")}`;
  if (!USER_AUTH_PATHS.has(authPath)) return errorResponse(404, "NOT_FOUND", requestId);
  const method = request.method.toUpperCase();
  const readPath = ["/get-session", "/identity/status", "/security/overview", "/security/sessions"].includes(authPath);
  if (method !== (readPath ? "GET" : "POST") && !(readPath && method === "HEAD" && authPath === "/get-session")) return errorResponse(404, "NOT_FOUND", requestId);
  const expectedSecurityMethod = authPath === "/identity/status" ? "GET" : USER_SECURITY_POST_PATHS.has(authPath) ? "POST" : undefined;
  if (expectedSecurityMethod && method !== expectedSecurityMethod) return errorResponse(404, "NOT_FOUND", requestId);
  if (method !== "GET" && method !== "HEAD" && request.headers.get("origin") !== WEB_ORIGIN) return errorResponse(403, "FORBIDDEN", requestId);
  const headers = new Headers({ Origin: WEB_ORIGIN, "X-Request-Id": requestId });
  // 只补转发浏览器自报的 User-Agent（客户端声明，不是服务端事实）：有界、去控制字符；
  // 浏览器没带就不设（不伪造），也绝不转发其余请求头。会话创建读取 UA 的落库效果需正常认证窗口验证。
  const userAgent = request.headers.get("user-agent");
  if (userAgent) {
    const sanitized = userAgent.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
    if (sanitized) headers.set("User-Agent", sanitized);
  }
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
    return errorResponse(502, "INTERNAL_ERROR", requestId, responseHeaders, upstream.ok);
  }
  if (!text) return new Response(null, { status: upstream.status, headers: responseHeaders });
  let payload: unknown;
  try { payload = sanitizeResponse(JSON.parse(text)); } catch { return errorResponse(502, "INTERNAL_ERROR", requestId, responseHeaders, upstream.ok); }
  return new Response(JSON.stringify(payload), { status: upstream.status, headers: responseHeaders });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
export async function HEAD(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
