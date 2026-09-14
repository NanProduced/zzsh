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
const getPath = new RegExp(
  `^/(?:games|games/${id}/(?:catalog|publishing-catalog|publishing-options)|gunsmith/games|gunsmith/games/${id}/firearms|gunsmith/firearms/${id}/codes|listings(?:/${id}(?:/media/${id})?)?|me/(?:accounts|favorites)|accounts/${id}|media/${id}/(?:access|content))$`,
);
const postPath = new RegExp(
  `^/(?:accounts|accounts/${id}/(?:drafts|quote|accept-rules|submit|withdraw|pause|resume)|media/upload-intents)$`,
);
const putPath = new RegExp(
  `^/(?:accounts/${id}/draft|favorites/${id}|media/uploads/${id})$`,
);
const mediaPath = new RegExp(
  `^/(?:media/${id}/(?:access|content)|listings/${id}/media/${id})$`,
);
const error = (status: number, code: string, requestId: string) =>
  Response.json(
    { error: { code, message: "供给请求未完成", requestId } },
    {
      status,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    },
  );
function localUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localUrls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "url" &&
      typeof child === "string" &&
      child.startsWith("/api/v1/supply/") &&
      getPath.test(child.slice("/api/v1/supply".length))
        ? "/api/supply" + child.slice("/api/v1/supply".length)
        : localUrls(child),
    ]),
  );
}
async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const supplied = request.headers.get("x-request-id"),
    requestId =
      supplied && new RegExp(`^${id}$`).test(supplied)
        ? supplied
        : "req_web_" + randomUUID().replaceAll("-", "");
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin))
    return error(503, "INTERNAL_ERROR", requestId);
  const { path: segments } = await context.params,
    path = "/" + segments.join("/"),
    method = request.method;
  if (
    !(method === "GET" ? getPath : method === "POST" ? postPath : putPath).test(
      path,
    ) ||
    !["GET", "POST", "PUT"].includes(method)
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
  const upload = method === "PUT" && path.startsWith("/media/uploads/"),
    deadline = AbortSignal.timeout(15000);
  let body: ArrayBuffer | undefined;
  if (method !== "GET") {
    const mime = request.headers.get("content-type") ?? "";
    if (
      upload
        ? !["image/png", "image/jpeg", "image/webp"].includes(mime)
        : !mime.toLowerCase().startsWith("application/json")
    )
      return error(400, "INVALID_ARGUMENT", requestId);
    headers.set("content-type", upload ? mime : "application/json");
    for (const name of [
      "idempotency-key",
      ...(upload ? ["x-upload-token"] : []),
    ]) {
      const v = request.headers.get(name);
      if (v) headers.set(name, v);
    }
    try {
      body = await readBoundedBody(
        request,
        upload ? 10 * 1024 * 1024 : 64 * 1024,
        deadline,
      );
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
        "/api/bff/user/supply" + path + new URL(request.url).search,
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
    const mime = upstream.headers.get("content-type")?.split(";")[0] ?? "";
    const binary =
      upstream.ok &&
      mediaPath.test(path) &&
      ["image/png", "image/jpeg", "image/webp"].includes(mime);
    const bytes = await readBoundedBody(
      upstream,
      binary ? 10 * 1024 * 1024 : 2 * 1024 * 1024,
      deadline,
    );
    if (binary) {
      responseHeaders.set("content-type", mime);
      return new Response(bytes, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return Response.json(localUrls(sanitizeResponse(payload)), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return error(502, "INTERNAL_ERROR", requestId);
  }
}
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return forward(request, context);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return forward(request, context);
}
export async function PUT(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return forward(request, context);
}
