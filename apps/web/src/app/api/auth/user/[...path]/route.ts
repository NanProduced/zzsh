import { randomUUID } from "node:crypto";

const LOCAL_ONLY = process.env.NODE_ENV !== "production";
const API_ORIGIN = process.env.ZZSH_API_ORIGIN ?? (LOCAL_ONLY ? "http://127.0.0.1:3102" : "");
const WEB_ORIGIN = process.env.ZZSH_WEB_ORIGIN ?? (LOCAL_ONLY ? "http://127.0.0.1:3100" : "");
const USER_AUTH_PATHS = new Set([
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
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const USER_COOKIE = /^(?:__Secure-|__Host-)?zzsh_user\.(?:session_token(?:\.\d+)?|dont_remember)$/;

function userCookies(value: string | null): string | undefined {
  const cookies = (value ?? "").split(";").map((part) => part.trim()).filter((part) => USER_COOKIE.test(part.split("=", 1)[0] ?? ""));
  return cookies.length > 0 ? cookies.join("; ") : undefined;
}

function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:token|sessionToken|accessToken|refreshToken)$/i.test(key)).map(([key, nested]) => [key, sanitizeResponse(nested)]));
}

function copySetCookies(source: Headers): string[] {
  const headers = source as Headers & { getSetCookie?: () => string[] };
  const cookie = source.get("set-cookie");
  return headers.getSetCookie?.() ?? (cookie ? [cookie] : []);
}

function errorResponse(status: number, code: string, requestId: string): Response {
  return Response.json({ error: { code, message: "Authentication request rejected", requestId } }, { status, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
}

async function forward(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? `req_web_${randomUUID().replaceAll("-", "")}`;
  const { path } = await params;
  const authPath = `/${path.join("/")}`;
  if (!USER_AUTH_PATHS.has(authPath)) return errorResponse(404, "NOT_FOUND", requestId);
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && request.headers.get("origin") !== WEB_ORIGIN) return errorResponse(403, "FORBIDDEN", requestId);
  const headers = new Headers({ Origin: WEB_ORIGIN, "X-Request-Id": requestId });
  const cookie = userCookies(request.headers.get("cookie"));
  if (cookie) headers.set("Cookie", cookie);
  const contentType = request.headers.get("content-type");
  if (contentType?.toLowerCase().startsWith("application/json")) headers.set("Content-Type", "application/json");
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/api/auth/user${authPath}`, API_ORIGIN), { method, headers, body, cache: "no-store" });
  } catch {
    return errorResponse(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => { if (RESPONSE_HEADERS.has(key)) responseHeaders.set(key, value); });
  for (const cookieValue of copySetCookies(upstream.headers)) responseHeaders.append("Set-Cookie", cookieValue);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Request-Id", requestId);
  const text = method === "HEAD" ? "" : await upstream.text();
  if (!text) return new Response(null, { status: upstream.status, headers: responseHeaders });
  let payload: unknown;
  try { payload = sanitizeResponse(JSON.parse(text)); } catch { return errorResponse(502, "INTERNAL_ERROR", requestId); }
  return new Response(JSON.stringify(payload), { status: upstream.status, headers: responseHeaders });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
export async function HEAD(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> { return forward(request, context); }
