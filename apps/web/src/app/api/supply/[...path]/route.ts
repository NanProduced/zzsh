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
const slot = "(?:0|[1-9][0-9]{0,5})";
// Owner-approved explicit whitelist: exact public listing-number lookup is a read-only
// passthrough distinct from the generic /listings/:id branch.
const getPath = new RegExp(
  `^/(?:operation-result|games|games/${id}/(?:catalog|publishing-catalog|publishing-options|listing-filters|resource-income-preview|full-payout-terms)|gunsmith/games|gunsmith/games/${id}/firearms|gunsmith/firearms/${id}/codes|listings/lookup|listings(?:/${id}(?:/media/${id}|/legacy-images/${slot})?)?|me/(?:accounts|favorites)|accounts/${id}(?:/deposit-recommendation|/legacy-images/(?:display|penalty)/${slot})?|media/${id}/(?:access|content))$`,
);
const postPath = new RegExp(
  `^/(?:accounts|accounts/${id}/(?:drafts|quote|accept-rules|submit|withdraw|delist)|media/upload-intents|media/uploads/${id}/complete|games/${id}/owner-income-preview)$`,
);
const putPath = new RegExp(
  `^/(?:accounts/${id}/draft|favorites/${id}|media/uploads/${id})$`,
);
const mediaPath = new RegExp(
  `^/(?:media/${id}/(?:access|content)|listings/${id}/(?:media/${id}|legacy-images/${slot})|accounts/${id}/legacy-images/(?:display|penalty)/${slot})$`,
);
const legacyMediaPath = new RegExp(`^/(?:listings/${id}/legacy-images/${slot}|accounts/${id}/legacy-images/(?:display|penalty)/${slot})$`);
const originalMediaPath = new RegExp(`^/media/${id}/access$`);
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
      (key === "url" || key === "skinCatalogUrl") &&
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
  const incoming=new URL(request.url);
  if(incoming.searchParams.get("queryVersion")==="2"&&Buffer.byteLength(incoming.pathname+incoming.search,"utf8")>8192)return Response.json({error:{code:"INVALID_ARGUMENT",message:"查询地址超过8KiB",requestId,details:[{path:"url",code:"INVALID_FIELD"}]}},{status:400,headers:{"cache-control":"no-store","x-request-id":requestId}});
  const { path: segments } = await context.params,
    path = "/" + segments.join("/"),
    method = request.method;
  if (path === "/listings" && method === "GET") {
    const sortType = incoming.searchParams.get("sortType");
    const sortOrder = incoming.searchParams.get("sortOrder");
    if (sortType) {
      incoming.searchParams.delete("sortType");
      if (sortType === "default") incoming.searchParams.set("sort", "latest");
      else if (sortType === "money") incoming.searchParams.set("sort", "resourceTotal");
      else if (sortType === "haff") {
        incoming.searchParams.set("sort", "coreQuantity");
        if (!incoming.searchParams.has("coreItemId")) incoming.searchParams.set("coreItemId", "haff");
      } else if (sortType === "ratio") {
        incoming.searchParams.set("sort", "ratio");
        if (!incoming.searchParams.has("coreItemId")) incoming.searchParams.set("coreItemId", "haff");
      } else if (sortType === "awm") {
        incoming.searchParams.set("sort", "coreQuantity");
        if (!incoming.searchParams.has("coreItemId")) incoming.searchParams.set("coreItemId", "awm");
      } else if (sortType === "helmet") {
        incoming.searchParams.set("sort", "coreQuantity");
        if (!incoming.searchParams.has("coreItemId")) incoming.searchParams.set("coreItemId", "helmet");
      } else if (sortType === "armor") {
        incoming.searchParams.set("sort", "coreQuantity");
        if (!incoming.searchParams.has("coreItemId")) incoming.searchParams.set("coreItemId", "armor");
      }
    }
    if (sortOrder) {
      incoming.searchParams.delete("sortOrder");
      incoming.searchParams.set("direction", sortOrder.toUpperCase() === "ASC" ? "ASC" : "DESC");
    }
    const smallAmount = incoming.searchParams.get("smallAmount");
    if (smallAmount === "1" || smallAmount === "true") {
      incoming.searchParams.delete("smallAmount");
      try {
        const filters = JSON.parse(incoming.searchParams.get("filters") ?? "{}");
        filters.resources = filters.resources ?? [];
        const haff = filters.resources.find((r: { itemId: string }) => ["haff", "haff_base", "df_billable_haff"].includes(r.itemId));
        if (haff) haff.maxQuantity = "150000000";
        else filters.resources.push({ itemId: "haff", maxQuantity: "150000000" });
        incoming.searchParams.set("filters", JSON.stringify(filters));
      } catch {}
    }
    const lingchen = incoming.searchParams.get("lingchen");
    if (lingchen === "1" || lingchen === "true") {
      incoming.searchParams.delete("lingchen");
      try {
        const filters = JSON.parse(incoming.searchParams.get("filters") ?? "{}");
        filters.serviceWindow = { startMinute: 0, endMinute: 480, crossMidnight: false, timezone: "Asia/Shanghai" };
        incoming.searchParams.set("filters", JSON.stringify(filters));
      } catch {}
    }
  }
  if (
    !(method === "GET" || method === "HEAD" ? getPath : method === "POST" ? postPath : putPath).test(
      path,
    ) ||
    !["GET", "HEAD", "POST", "PUT"].includes(method) || (method === "HEAD" && !legacyMediaPath.test(path))
  )
    return error(404, "NOT_FOUND", requestId);
  if (
    request.headers.has("authorization") ||
    (method !== "GET" && method !== "HEAD" && request.headers.get("origin") !== webOrigin)
  )
    return error(403, "FORBIDDEN", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId }),
    cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  if (method === "GET" && path === "/operation-result" && request.headers.has("idempotency-key")) headers.set("idempotency-key", request.headers.get("idempotency-key")!);
  const directRead = method === "GET" && originalMediaPath.test(path)
    && incoming.searchParams.size === 1 && incoming.searchParams.get("delivery") === "direct";
  const browserOrigin = process.env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN?.trim() ?? "";
  const allowDirectRead = directRead && browserOrigin.startsWith("https://") && isHttpOrigin(browserOrigin);
  if (directRead && !allowDirectRead) incoming.searchParams.delete("delivery");
  const upload = method === "PUT" && path.startsWith("/media/uploads/"),
    complete = method === "POST" && path.startsWith("/media/uploads/"),
    deadline = AbortSignal.timeout(complete ? 60000 : 15000);
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
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
        "/api/bff/user/supply" + path + incoming.search,
        apiOrigin,
      ),
      {
        method,
        headers,
        body,
        cache: "no-store",
        redirect: allowDirectRead ? "manual" : "error",
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
  for (const h of ["retry-after", "etag", "x-zzsh-legacy-missing"]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  if (allowDirectRead && upstream.status === 307) {
    try {
      const url = new URL(upstream.headers.get("location") ?? "");
      if (url.origin !== new URL(browserOrigin).origin || url.username || url.password || url.hash) throw new Error();
      responseHeaders.set("Location", url.href);
      responseHeaders.set("Referrer-Policy", "no-referrer");
      return new Response(null, { status: 307, headers: responseHeaders });
    } catch {
      return error(502, "INTERNAL_ERROR", requestId);
    }
  }
  if (method === "HEAD") return new Response(null, { status: upstream.status, headers: responseHeaders });
  try {
    const mime = upstream.headers.get("content-type")?.split(";")[0] ?? "";
    const binary =
      upstream.ok &&
      mediaPath.test(path) &&
      ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/x-icon"].includes(mime);
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
export async function HEAD(request: Request, context: { params: Promise<{ path: string[] }> }) {
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
