import { randomUUID } from "node:crypto";
import { isHttpOrigin, readBoundedBody, userCookies } from "../../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
function fail(status: number, code: string, requestId: string): Response {
  return Response.json({ error: { code, message: "成长消费明细暂时无法读取", requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
}

export async function GET(request: Request): Promise<Response> {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied) ? supplied : `req_growth_${randomUUID().replaceAll("-", "")}`;
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return fail(503, "EVIDENCE_UNAVAILABLE", requestId);
  const origin = request.headers.get("origin");
  if (request.headers.has("authorization") || origin && origin !== webOrigin) return fail(403, "FORBIDDEN", requestId);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !["scope", "limit", "cursor"].includes(key) || query.getAll(key).length !== 1)) return fail(400, "INVALID_ARGUMENT", requestId);
  const scope = query.get("scope"), limit = query.get("limit"), cursor = query.get("cursor");
  if (scope !== null && !["LIFETIME", "ROLLING"].includes(scope) || limit !== null && (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50) || cursor !== null && (cursor.length === 0 || cursor.length > 4096)) return fail(400, "INVALID_ARGUMENT", requestId);
  const target = new URL("/api/v1/users/me/membership-growth/consumption", apiOrigin);
  target.search = query.toString();
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  const cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  const deadline = AbortSignal.timeout(15_000);
  try {
    const upstream = await fetch(target, { method: "GET", headers, cache: "no-store", redirect: "error", signal: deadline });
    const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(upstream, 128 * 1024, deadline)));
    return Response.json(body, { status: upstream.status, headers: { "cache-control": "no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" } });
  } catch { return fail(502, "EVIDENCE_UNAVAILABLE", requestId); }
}

export function POST(): Response { return fail(404, "NOT_FOUND", "req_growth_method"); }
