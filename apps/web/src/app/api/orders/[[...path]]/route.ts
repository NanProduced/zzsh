import { randomUUID } from "node:crypto";
import {
  isHttpOrigin,
  userCookies,
  copySetCookies,
  readBoundedBody,
  BodyTooLargeError,
  sanitizeResponse,
} from "../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin =
  process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin =
  process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const id = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const getPath = new RegExp(`^/(?:${id})?$`);
const postPath = new RegExp(`^/(?:${id}/cancel)?$`);
const error = (status: number, code: string, requestId: string) =>
  Response.json(
    { error: { code, message: "订单请求未完成", requestId } },
    {
      status,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    },
  );
async function forward(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const supplied = request.headers.get("x-request-id"),
    requestId =
      supplied && new RegExp(`^${id}$`).test(supplied)
        ? supplied
        : "req_web_" + randomUUID().replaceAll("-", "");
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin))
    return error(503, "INTERNAL_ERROR", requestId);
  const { path: segments } = await context.params,
    path = "/" + (segments ?? []).join("/"),
    method = request.method;
  if (
    !(method === "GET" ? getPath : postPath).test(path) ||
    !["GET", "POST"].includes(method)
  )
    return error(404, "NOT_FOUND", requestId);
  if (
    request.headers.has("authorization") ||
    (method !== "GET" && request.headers.get("origin") !== webOrigin)
  )
    return error(403, "FORBIDDEN", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId }),
    cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  const deadline = AbortSignal.timeout(15000);
  let body: ArrayBuffer | undefined;
  if (method !== "GET") {
    const mime = request.headers.get("content-type") ?? "";
    if (!mime.toLowerCase().startsWith("application/json"))
      return error(400, "INVALID_ARGUMENT", requestId);
    headers.set("content-type", "application/json");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    try {
      body = await readBoundedBody(request, 64 * 1024, deadline);
    } catch (e) {
      return error(
        e instanceof BodyTooLargeError ? 413 : 400,
        "INVALID_ARGUMENT",
        requestId,
      );
    }
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      new URL(
        "/api/bff/user/orders" + path + new URL(request.url).search,
        apiOrigin,
      ),
      {
        method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: deadline,
      },
    );
  } catch {
    return error(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "x-request-id": requestId,
    "x-content-type-options": "nosniff",
  });
  for (const v of copySetCookies(upstream.headers))
    responseHeaders.append("set-cookie", v);
  for (const h of ["retry-after", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  try {
    const bytes = await readBoundedBody(upstream, 2 * 1024 * 1024, deadline);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return Response.json(sanitizeResponse(payload), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return error(502, "INTERNAL_ERROR", requestId);
  }
}
export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  return forward(request, context);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  return forward(request, context);
}
