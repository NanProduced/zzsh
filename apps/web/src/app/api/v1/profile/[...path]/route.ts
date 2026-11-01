import { randomUUID } from "node:crypto";
import {
  BodyTooLargeError,
  copySetCookies,
  isHttpOrigin,
  readBoundedBody,
  sanitizeResponse,
  userCookies,
} from "../../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const id = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const getPath = new RegExp(`^/(?:avatar|avatar/preview|avatar/operation-result|avatars/(?:user|admin)/${id}/(?:0|[1-9]\\d{0,18})|avatars/presets/[a-z0-9][a-z0-9-]{1,31}/\\d+/content)$`);
const postPath = new RegExp(`^/avatar/(?:default|upload-intents)$`);
const putPath = new RegExp(`^/avatar/uploads/${id}$`);
const mediaPath = new RegExp(`^/(?:avatar/preview|avatars/(?:user|admin)/${id}/(?:0|[1-9]\\d{0,18})|avatars/presets/[a-z0-9][a-z0-9-]{1,31}/\\d+/content)$`);

function error(status: number, code: string, requestId: string, message = "头像请求未完成") {
  return Response.json({ error: { code, message, requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export async function PUT(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && new RegExp(`^${id}$`).test(supplied) ? supplied : "req_web_" + randomUUID().replaceAll("-", "");
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return error(503, "INTERNAL_ERROR", requestId);
  const { path: segments } = await context.params;
  const path = "/" + segments.join("/");
  const method = request.method.toUpperCase();
  const allowed = method === "GET" ? getPath : method === "POST" ? postPath : method === "PUT" ? putPath : null;
  if (!allowed || !allowed.test(path)) return error(404, "NOT_FOUND", requestId);
  if (request.headers.has("authorization") || (method !== "GET" && request.headers.get("origin") !== webOrigin)) return error(403, "FORBIDDEN", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  const cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  const upload = method === "PUT";
  const deadline = AbortSignal.timeout(15000);
  let body: ArrayBuffer | undefined;
  if (method !== "GET") {
    const mime = request.headers.get("content-type") ?? "";
    if (upload ? !["image/png", "image/jpeg", "image/webp"].includes(mime) : !mime.toLowerCase().startsWith("application/json")) {
      return error(400, "INVALID_ARGUMENT", requestId);
    }
    headers.set("content-type", upload ? mime : "application/json");
    for (const name of ["idempotency-key", ...(upload ? ["x-upload-token"] : [])]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    try {
      body = await readBoundedBody(request, upload ? 10 * 1024 * 1024 : 64 * 1024, deadline);
    } catch (failure) {
      return error(failure instanceof BodyTooLargeError ? 413 : 400, "INVALID_ARGUMENT", requestId);
    }
  } else if (path === "/avatar/operation-result" && request.headers.has("idempotency-key")) {
    headers.set("idempotency-key", request.headers.get("idempotency-key")!);
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/api/v1/profile${path}${new URL(request.url).search}`, apiOrigin), {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
  } catch {
    return error(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({ "x-request-id": requestId, "x-content-type-options": "nosniff" });
  for (const value of copySetCookies(upstream.headers)) responseHeaders.append("set-cookie", value);
  const mime = upstream.headers.get("content-type")?.split(";")[0] ?? "";
  if (upstream.ok && mediaPath.test(path) && ["image/png", "image/jpeg", "image/webp"].includes(mime)) {
    const cacheControl = upstream.headers.get("cache-control");
    responseHeaders.set("content-type", mime);
    responseHeaders.set("cache-control", cacheControl ?? "public, max-age=0, must-revalidate");
    try {
      const bytes = await readBoundedBody(upstream, 10 * 1024 * 1024, deadline);
      return new Response(bytes, { status: upstream.status, headers: responseHeaders });
    } catch {
      return error(502, "INTERNAL_ERROR", requestId);
    }
  }
  responseHeaders.set("cache-control", "no-store");
  try {
    const bytes = await readBoundedBody(upstream, 2 * 1024 * 1024, deadline);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return Response.json(sanitizeResponse(payload), { status: upstream.status, headers: responseHeaders });
  } catch {
    return error(502, "INTERNAL_ERROR", requestId);
  }
}
