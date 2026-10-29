import { randomUUID } from "node:crypto";
import {
  isHttpOrigin,
  readBoundedBody,
  sanitizeResponse,
} from "../../../../lib/user-proxy.ts";

// Public content proxy: anonymous same-site reads of /api/v1/content.
// GET only; no cookies are forwarded and no write methods exist upstream.
const local = process.env.NODE_ENV !== "production";
const apiOrigin =
  process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin =
  process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const id = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const getPath = new RegExp(
  `^/(?:carousel|activity|items|items/${id}|updates|updates/${id}|resources|resources/${id}|media/${id}/content)$`,
);
const mediaPath = new RegExp(`^/media/${id}/content$`);
const error = (status: number, code: string, requestId: string) =>
  Response.json(
    { error: { code, message: "内容请求未完成", requestId } },
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
      (key === "url" || key === "mediaUrl" || key === "mobileMediaUrl") &&
      typeof child === "string" &&
      child.startsWith("/api/v1/content/") &&
      getPath.test(child.slice("/api/v1/content".length))
        ? "/api/content" + child.slice("/api/v1/content".length)
        : localUrls(child),
    ]),
  );
}
export async function GET(
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
  if (request.headers.has("authorization")) return error(403, "FORBIDDEN", requestId);
  const { path: segments } = await context.params,
    path = "/" + segments.join("/");
  if (!getPath.test(path)) return error(404, "NOT_FOUND", requestId);
  const deadline = AbortSignal.timeout(15000);
  let upstream: Response;
  try {
    upstream = await fetch(
      new URL("/api/v1/content" + path + new URL(request.url).search, apiOrigin),
      {
        method: "GET",
        headers: { origin: webOrigin, "x-request-id": requestId },
        cache: "no-store",
        redirect: "error",
        signal: deadline,
      },
    );
  } catch {
    return error(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({ "x-request-id": requestId, "x-content-type-options": "nosniff" });
  const upstreamCache = upstream.headers.get("cache-control");
  responseHeaders.set("cache-control", upstreamCache ?? "no-store");
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
      return new Response(bytes, { status: upstream.status, headers: responseHeaders });
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
