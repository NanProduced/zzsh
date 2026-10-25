import { randomUUID } from "node:crypto";
import { isHttpOrigin, userCookies, readBoundedBody, BodyTooLargeError } from "./user-proxy.ts";
import { parseBankBinding, parseBankBindingReceipt, validateBankBindingInput } from "./withdrawal-bank-binding-client.ts";
import { parseChannelIntent, parseChannelQuote, parseChannelRecovery, parseWithdrawalOptions } from "./channel-withdrawal-client.ts";
import { parseWithdrawalHistoryDetail, parseWithdrawalHistoryRecovery, projectWithdrawalHistory, withdrawalHistoryQuery } from "./withdrawal-history-client.ts";
import { WITHDRAWAL_SUBJECT_HEADER, cents, id, key, record, text, type WithdrawalResource } from "./withdrawal-client-core.ts";

const api = process.env.ZZSH_API_ORIGIN ?? "", web = process.env.ZZSH_WEB_ORIGIN ?? "";
const failure = (status: number, code: string, requestId: string) => Response.json({ error: { code, message: "资料或申请暂时无法确认，请保留原请求并稍后查询。", requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
function only(body: Record<string, unknown>, fields: string[]) { if (Object.keys(body).sort().join() !== [...fields].sort().join()) throw Error(); }
function singleKey(query: URLSearchParams) { if (query.size !== 1 || query.getAll("key").length !== 1) throw Error(); key(query.get("key")); }
function subject(value: Record<string, unknown>) { return id(value.subjectId); }
function nativeIntent(value: unknown, userId: string) {
  const raw = record(value), parsed = parseChannelIntent(raw, userId);
  if (Object.hasOwn(raw, "originalDestination")) return parsed;
  const { originalDestination: _missing, ...originalShape } = parsed;
  return originalShape;
}
function project(resource: WithdrawalResource, path: string, method: string, value: unknown, query: URLSearchParams, expectedUserId: string) {
  if (resource === "withdrawal-bank-binding") return path === "receipt" ? parseBankBindingReceipt(value) : parseBankBinding(value);
  const b = record(value);
  if (resource === "withdrawal-history") {
    const userId = subject(b); if (userId !== expectedUserId) throw Error();
    if (path === "receipt") return parseWithdrawalHistoryRecovery(b, userId);
    if (path) return parseWithdrawalHistoryDetail(b, userId, path);
    const result = projectWithdrawalHistory(b, userId), expected = withdrawalHistoryQuery({ source: (query.get("source") ?? "ALL") as "ALL", state: query.get("state") ?? "ALL", limit: query.has("limit") ? Number(query.get("limit")) : 20, cursor: query.get("cursor") });
    if (result.source !== expected.source || result.state !== expected.state) throw Error();
    return result;
  }
  if (path === "options") return parseWithdrawalOptions(b);
  if (path === "quote") return parseChannelQuote(b);
  if (path === "receipt") {
    const known = b.receipt === null ? null : record(record(b.receipt).intent);
    parseChannelRecovery(b, expectedUserId);
    return { source: "JOINPAY", knowledge: b.knowledge, receipt: known ? { intent: nativeIntent(known, expectedUserId) } : null, mayResubmit: false };
  }
  if (method === "GET" && (b.source !== "JOINPAY" || b.mayResubmit !== false)) throw Error();
  const intent = nativeIntent(b.intent, expectedUserId);
  if (path && intent.id !== path) throw Error();
  return method === "GET" ? { source: "JOINPAY", intent, mayResubmit: false } : { intent };
}

export async function forwardWithdrawalRequest(request: Request, context: { params: Promise<{ path?: string[] }> }, resource: WithdrawalResource): Promise<Response> {
  const requestId = `req_withdrawal_${randomUUID().replaceAll("-", "")}`;
  if (!["withdrawal-bank-binding", "channel-withdrawals", "withdrawal-history"].includes(resource)) return failure(404, "NOT_FOUND", requestId);
  if (!isHttpOrigin(api) || !isHttpOrigin(web)) return failure(503, "EVIDENCE_UNAVAILABLE", requestId);
  if (request.headers.has("authorization") || request.headers.get("sec-fetch-site") === "cross-site" || request.headers.has("origin") && request.headers.get("origin") !== web) return failure(403, "FORBIDDEN", requestId);
  const parts = (await context.params).path ?? [], method = request.method;
  if (parts.length > 1 || !["GET", "POST"].includes(method)) return failure(404, "NOT_FOUND", requestId);
  const path = parts[0] ?? "", query = new URL(request.url).searchParams;
  let body: Record<string, unknown> | undefined, originalKey: string | undefined, expectedUserId: string;
  try {
    if (method === "GET" && (request.body || request.headers.has("transfer-encoding") || request.headers.has("content-length") && request.headers.get("content-length") !== "0")) throw Error();
    if (resource === "withdrawal-bank-binding") {
      if (!["", "receipt"].includes(path) || method === "POST" && path) return failure(404, "NOT_FOUND", requestId);
      if (path === "receipt") singleKey(query); else if (query.size) throw Error();
    } else if (resource === "channel-withdrawals") {
      if (method === "GET") {
        if (!path || path === "quote") return failure(404, "NOT_FOUND", requestId);
        if (path === "receipt") singleKey(query); else { if (query.size) throw Error(); if (path !== "options") id(path); }
      } else if (!["", "quote"].includes(path)) return failure(404, "NOT_FOUND", requestId);
      else if (query.size) throw Error();
    } else {
      if (method !== "GET") return failure(404, "NOT_FOUND", requestId);
      if (path === "receipt") singleKey(query);
      else if (path) { if (query.size || !/^(history|controlled|joinpay):[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(path)) throw Error(); }
      else {
        for (const q of query.keys()) if (!["source", "state", "cursor", "limit"].includes(q) || query.getAll(q).length !== 1) throw Error();
        withdrawalHistoryQuery({ source: (query.get("source") ?? "ALL") as "ALL", state: query.get("state") ?? "ALL", limit: query.has("limit") ? Number(query.get("limit")) : 20, cursor: query.get("cursor") });
      }
    }
    if (method === "POST") {
      if (request.headers.get("origin") !== web || request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return failure(403, "FORBIDDEN", requestId);
      const raw = record(JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))));
      if (resource === "withdrawal-bank-binding") { only(raw, ["name", "cardNo", "expectedRevision"]); body = validateBankBindingInput(raw as { name: string; cardNo: string; expectedRevision: string }); }
      else {
        only(raw, path === "quote" ? ["amountCents", "destinationId", "policyVersion"] : ["amountCents", "destinationId", "policyVersion", "expectedWalletVersion"]);
        const amountCents = cents(raw.amountCents); if (BigInt(amountCents) <= 0n) throw Error();
        body = { amountCents, destinationId: id(raw.destinationId), policyVersion: id(raw.policyVersion) };
        if (!path) { const token = text(raw.expectedWalletVersion, 512); if (!/^jwdq1:[a-f0-9]{64}$/.test(token)) throw Error(); body.expectedWalletVersion = token; }
      }
      if (!path) originalKey = key(request.headers.get("idempotency-key"));
    }
    expectedUserId = id(request.headers.get(WITHDRAWAL_SUBJECT_HEADER));
  } catch (error) { return failure(error instanceof BodyTooLargeError ? 413 : 400, "INVALID_ARGUMENT", requestId); }
  const headers = new Headers({ origin: web, "x-request-id": requestId });
  const cookie = userCookies(request.headers.get("cookie")); if (cookie) headers.set("cookie", cookie);
  if (body) headers.set("content-type", "application/json");
  if (originalKey) headers.set("idempotency-key", originalKey);
  const url = new URL(`/api/bff/user/${resource}${path ? "/" + encodeURIComponent(path) : ""}`, api); url.search = query.toString();
  const isCommand = method === "POST" && !path;
  try {
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
    // 读取同一请求捕获的Cookie所属用户，防止旧页面在跨标签切换后写入另一账号。
    const authHeaders = new Headers({ origin: web, "x-request-id": requestId }); if (cookie) authHeaders.set("cookie", cookie);
    const auth = await fetch(new URL("/api/auth/user/get-session", api), { method: "GET", headers: authHeaders, cache: "no-store", redirect: "error", signal: deadline });
    if (!auth.ok) return failure(auth.status >= 400 && auth.status < 500 ? auth.status : 503, auth.status === 403 ? "FORBIDDEN" : auth.status >= 400 && auth.status < 500 ? "UNAUTHENTICATED" : "EVIDENCE_UNAVAILABLE", requestId);
    const session = JSON.parse(new TextDecoder().decode(await readBoundedBody(auth, 64 * 1024, deadline)));
    if (session === null || session.user === null) return failure(401, "UNAUTHENTICATED", requestId);
    if (id(record(record(session).user).id) !== expectedUserId) return failure(401, "IDENTITY_CHANGED", requestId);
    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", redirect: "error", signal: deadline });
    const value = JSON.parse(new TextDecoder().decode(await readBoundedBody(response, 256 * 1024, deadline)));
    if (!response.ok) {
      const code = typeof value?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code) ? value.error.code : "INTERNAL_ERROR";
      return failure(response.status, code, requestId);
    }
    const result = project(resource, path, method, value, query, expectedUserId);
    return Response.json(result, { headers: { "cache-control": "no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" } });
  } catch { return failure(502, isCommand ? "WRITE_OUTCOME_UNKNOWN" : "EVIDENCE_UNAVAILABLE", requestId); }
}
