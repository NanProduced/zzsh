import { randomUUID } from "node:crypto";
import { isHttpOrigin, readBoundedBody, userCookies } from "../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(status: number, code: string, requestId: string): Response {
  return Response.json({ error: { code, message: "会员成长暂时无法读取", requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
}

export async function GET(request: Request): Promise<Response> {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && REQUEST_ID.test(supplied) ? supplied : `req_web_${randomUUID().replaceAll("-", "")}`;
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return fail(503, "INTERNAL_ERROR", requestId);
  if (request.headers.has("authorization")) return fail(403, "FORBIDDEN", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  const cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  const deadline = AbortSignal.timeout(15_000);
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/api/v1/users/me/membership-growth", apiOrigin), { method: "GET", headers, cache: "no-store", redirect: "error", signal: deadline });
  } catch {
    return fail(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({ "cache-control": "no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" });
  try {
    const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(upstream, 128 * 1024, deadline)));
    return Response.json(body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return fail(502, "INTERNAL_ERROR", requestId);
  }
}

export function POST(): Response {
  return fail(404, "NOT_FOUND", "req_web_method");
}
