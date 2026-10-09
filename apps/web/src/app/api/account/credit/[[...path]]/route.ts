import { randomUUID } from "node:crypto";
import { isHttpOrigin, readBoundedBody, userCookies } from "../../../../../lib/user-proxy.ts";

const apiOrigin = process.env.ZZSH_API_ORIGIN ?? "";
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? "";
const error = (status: number, code: string, requestId: string) => Response.json({ error: { code, message: "信用与保证金暂不可用", requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });

function allowed(path: string[], method: string): boolean {
  if (method === "GET") return path.length === 0 || path.length === 1 && ["overview", "events", "guarantees"].includes(path[0]!);
  if (method !== "POST") return false;
  return path.length === 1 && path[0] === "recovery-requests"
    || path.length === 3 && path[0] === "accounts" && path[2] === "payment-intents"
    || path.length === 3 && path[0] === "guarantees" && path[2] === "refund-requests";
}

async function forward(request: Request, path: string[], method: string, requestId: string): Promise<Response> {
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin) || request.headers.has("authorization") || !allowed(path, method)) return error(403, "FORBIDDEN", requestId);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== webOrigin) return error(403, "FORBIDDEN", requestId);
  const url = new URL(`/api/v1/users/me/credit${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}`, apiOrigin);
  const headers = new Headers({ origin: webOrigin, "x-request-id": requestId });
  const cookie = userCookies(request.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  const idempotency = request.headers.get("idempotency-key");
  if (idempotency) headers.set("idempotency-key", idempotency);
  let body: ArrayBuffer | undefined;
  if (method === "POST") {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(400, "INVALID_ARGUMENT", requestId);
    try { body = await readBoundedBody(request, 64 * 1024); } catch { return error(413, "INVALID_ARGUMENT", requestId); }
    headers.set("content-type", "application/json");
  }
  try {
    const response = await fetch(url, { method, headers, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
    const bytes = await response.arrayBuffer();
    return new Response(bytes, { status: response.status, headers: { "cache-control": "no-store", "content-type": "application/json", "x-request-id": requestId, "x-content-type-options": "nosniff" } });
  } catch {
    return error(502, "INTERNAL_ERROR", requestId);
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const requestId = `req_credit_${randomUUID().replaceAll("-", "")}`;
  return forward(request, (await params).path ?? [], "GET", requestId);
}

export async function POST(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const requestId = `req_credit_${randomUUID().replaceAll("-", "")}`;
  return forward(request, (await params).path ?? [], "POST", requestId);
}
