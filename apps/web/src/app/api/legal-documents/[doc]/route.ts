import { randomUUID } from "node:crypto";
import { isHttpOrigin } from "../../../../lib/user-proxy";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");
const id = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const allowed = new Set(["current", "terms", "privacy"]);

export async function GET(
  request: Request,
  context: { params: Promise<{ doc: string }> },
): Promise<Response> {
  const requestId = "req_web_" + randomUUID().replaceAll("-", "");
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) {
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "法律文书暂时无法读取", requestId } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (request.headers.has("authorization")) {
    return Response.json({ error: { code: "FORBIDDEN", message: "Request rejected", requestId } }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const { doc } = await context.params;
  if (!allowed.has(doc) || !new RegExp(`^${id}$`).test(doc)) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found", requestId } }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/api/v1/legal-documents/${doc}`, apiOrigin), {
      method: "GET",
      headers: { origin: webOrigin, accept: "application/json", "x-request-id": requestId },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return Response.json({ error: { code: "INTERNAL_ERROR", message: "法律文书暂时无法读取", requestId } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}
