import { randomUUID } from "node:crypto";

import { isHttpOrigin, userCookies } from "../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const pathPattern = /^(?:\/token|\/consultations|\/messages|\/message-access)$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function errorResponse(status: number, code: string, requestId: string): Response {
  return Response.json(
    { error: { code, message: "IM 请求未完成", requestId } },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && requestIdPattern.test(supplied) ? supplied : `req_web_${randomUUID().replaceAll("-", "")}`;
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return errorResponse(503, "INTERNAL_ERROR", requestId);
  if (request.headers.has("authorization")) return errorResponse(403, "FORBIDDEN", requestId);
  const origin = request.headers.get("origin");
  if (origin && origin !== webOrigin) return errorResponse(403, "FORBIDDEN", requestId);
  const { path: segments } = await context.params;
  const path = `/${segments.join("/")}`;
  if (!pathPattern.test(path)) return errorResponse(404, "NOT_FOUND", requestId);
  const method = request.method.toUpperCase();
  if (path === "/token" && method !== "GET") return errorResponse(404, "NOT_FOUND", requestId);
  if ((path === "/consultations" || path === "/messages") && method !== "GET" && method !== "POST") return errorResponse(404, "NOT_FOUND", requestId);
  if (path === "/message-access" && method !== "GET") return errorResponse(404, "NOT_FOUND", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  headers.set("accept", "application/json");
  const cookie = userCookies(request.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  let body: string | undefined;
  if (method === "POST") {
    body = await request.text();
    if (body.length > 16_384 || !request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return errorResponse(400, "INVALID_ARGUMENT", requestId);
    }
    try {
      JSON.parse(body);
    } catch {
      return errorResponse(400, "INVALID_ARGUMENT", requestId);
    }
    headers.set("content-type", "application/json");
  }
  const upstreamPath = path === "/token" ? "/api/v1/im/user/token" : path === "/messages" ? "/api/v1/im/user/messages" : path === "/message-access" ? "/api/v1/im/user/message-access" : "/api/v1/im/user/consultations";
  const upstreamUrl = new URL(upstreamPath, apiOrigin);
  if (method === "GET" && (path === "/consultations" || path === "/messages" || path === "/message-access")) {
    const limit = new URL(request.url).searchParams.get("limit");
    if (limit !== null) upstreamUrl.searchParams.set("limit", limit);
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (conversationId !== null) upstreamUrl.searchParams.set("conversationId", conversationId);
    const operation = new URL(request.url).searchParams.get("operation");
    if (operation !== null) upstreamUrl.searchParams.set("operation", operation);
  }
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return errorResponse(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({ "cache-control": "no-store", "x-request-id": requestId });
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) responseHeaders.set("retry-after", retryAfter);
  try {
    const text = await upstream.text();
    if (!text) return new Response(null, { status: upstream.status, headers: responseHeaders });
    JSON.parse(text);
    return new Response(text, { status: upstream.status, headers: responseHeaders });
  } catch {
    return errorResponse(502, "INTERNAL_ERROR", requestId);
  }
}

export function GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(request, context);
}

export function POST(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(request, context);
}
