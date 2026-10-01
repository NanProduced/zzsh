import { randomUUID } from "node:crypto";
import { isHttpOrigin, readBoundedBody, userCookies } from "../../../../lib/user-proxy.ts";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function error(status: number, code: string, requestId: string) {
  return Response.json(
    { error: { code, message: "会员等级暂时无法读取", requestId } },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

const machineCode = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function projectMembership(payload: unknown, status: number, requestId: string) {
  const record = recordOf(payload);
  const upstreamError = record ? recordOf(record.error) : null;
  if (status < 200 || status >= 300 || (record !== null && record.error != null)) {
    const code = typeof upstreamError?.code === "string" && machineCode.test(upstreamError.code) ? upstreamError.code : "INTERNAL_ERROR";
    const message = typeof upstreamError?.message === "string" && upstreamError.message.trim() ? upstreamError.message : "会员等级暂时无法读取";
    const echoed = typeof upstreamError?.requestId === "string" && requestIdPattern.test(upstreamError.requestId) ? upstreamError.requestId : requestId;
    return { error: { code, message, requestId: echoed } };
  }
  const membership = record ? recordOf(record.membership) : null;
  const tier = membership?.tier;
  const version = membership?.version;
  return { membership: { ...(typeof tier === "string" ? { tier } : {}), ...(typeof version === "string" ? { version } : {}) } };
}

export async function GET(request: Request): Promise<Response> {
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && requestIdPattern.test(supplied) ? supplied : `req_web_${randomUUID().replaceAll("-", "")}`;
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return error(503, "INTERNAL_ERROR", requestId);
  if (request.headers.has("authorization")) return error(403, "FORBIDDEN", requestId);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  const cookies = userCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  const deadline = AbortSignal.timeout(15_000);
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/api/v1/users/me/rental-membership", apiOrigin), {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: deadline,
    });
  } catch {
    return error(503, "INTERNAL_ERROR", requestId);
  }
  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "x-request-id": requestId,
    "x-content-type-options": "nosniff",
  });
  try {
    const bytes = await readBoundedBody(upstream, 64 * 1024, deadline);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return Response.json(projectMembership(payload, upstream.status, requestId), { status: upstream.status, headers: responseHeaders });
  } catch {
    return error(502, "INTERNAL_ERROR", requestId);
  }
}

export function POST(): Response {
  return error(404, "NOT_FOUND", "req_web_method");
}
