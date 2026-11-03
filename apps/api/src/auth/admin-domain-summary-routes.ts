import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { parseAdminOrderPageQuery } from "../order/order-routes";
import { requireAdminAccess, safely, type SupplyResponse } from "../supply/supply-routes";
import { forbidden, invalid, notFound, sendJson, sha256Hex, type SupplyNodeRequest } from "../supply/supply-util";
import { gameScopeSignature, readAdminGameScope } from "./admin-scope";
import { readAdminDomainSummaryInTransaction, type AdminDomainSummaryRequest } from "./admin-domain-summary";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "./auth-security";
import { withDirectoryRead, withDirectoryReadTransaction } from "./user-directory-read";
import { parseUserDirectoryFilter } from "./user-directory-routes";

const SUMMARY_PATH = /^\/api\/(?:v1\/admin|bff\/admin)\/(users|orders)\/overview-stats$/;
const header = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export function parseAdminDomainSummaryQuery(domain: "USERS" | "ORDERS", query: URLSearchParams): AdminDomainSummaryRequest {
  // A GET must not carry the POST-only phone predicate or a pagination snapshot credential.
  for (const key of query.keys()) if (query.getAll(key).length !== 1 || ["phone", "contextKey", "cursor", "restoreKey"].includes(key)) throw invalid("Unsupported summary argument", key);
  if (domain === "ORDERS") return { domain, filter: parseAdminOrderPageQuery(query) };
  // Numbered mode shares the list's exact allowlist and rejects unsupported fields.
  const listQuery = new URLSearchParams(query);
  if (!listQuery.has("page")) listQuery.set("page", "1");
  return { domain, filter: parseUserDirectoryFilter(listQuery, false) };
}

async function accessKey(client: PoolClient, context: { userId: string; sessionId: string }): Promise<string> {
  await assertAdminContextInTransaction(client, context);
  const access = await requireAdminAccess(client, context.userId);
  const scope = await readAdminGameScope(client, context.userId);
  return sha256Hex(JSON.stringify([context.userId, context.sessionId, access.isBoss, [...access.permissions].sort(), gameScopeSignature(scope)]));
}

export async function handleAdminDomainSummary(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("Cache-Control", "private, no-store");
  await safely(response, requestId, async () => {
    const url = new URL(request.originalUrl ?? request.url ?? "/", options.apiOrigin);
    const match = SUMMARY_PATH.exec(url.pathname);
    if (request.method !== "GET" || !match) throw notFound();
    const origin = header(request.headers.origin);
    if (origin && origin !== options.adminOrigin && origin !== options.apiOrigin || header(request.headers["sec-fetch-site"]) === "cross-site") throw forbidden();
    const parsed = parseAdminDomainSummaryQuery(match[1] === "users" ? "USERS" : "ORDERS", url.searchParams);
    const pool = options.directoryReadPool ?? options.pool;
    await withDirectoryRead(pool, request, response, async signal => {
      const context = await readAdminContext(request, options);
      const result = await withDirectoryReadTransaction(pool, signal, async client => ({
        authorizationKey: await accessKey(client, context),
        body: await readAdminDomainSummaryInTransaction(client, context, parsed),
      }));
      signal.throwIfAborted();
      const freshKey = await withDirectoryReadTransaction(pool, signal, client => accessKey(client, context));
      if (freshKey !== result.authorizationKey) throw forbidden("Summary access changed; reload");
      signal.throwIfAborted();
      sendJson(response, 200, result.body, requestId, "private, no-store");
    });
  });
}

/** Mount before the users/orders detail routers, which accept arbitrary object IDs. */
export function mountAdminDomainSummary(app: INestApplication, options: AuthSecurityOptions): void {
  app.getHttpAdapter().getInstance().use("/api/v1/admin", (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => {
    const path = (request.originalUrl ?? request.url ?? "").split("?", 1)[0] ?? "";
    if (!SUMMARY_PATH.test(path)) return next();
    return handleAdminDomainSummary(request, response, options);
  });
}
