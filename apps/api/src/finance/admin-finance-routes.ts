import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { safely, type SupplyResponse } from "../supply/supply-routes";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import type { ListingCursorKey } from "../supply/listing-cursor";
import { ADMIN_FINANCE_VERSION, parseAdminFinanceFilters, resolveFinanceLookup, loadAdminFinanceFacts, filterAdminFinanceEntries, financeSnapshot, financeDocuments, financeOrderDocuments, financePeriodProjection, readAdminFinanceSubject, readAdminFinanceDocument, type FinanceActor } from "./admin-finance-read";
import { generateAdminFinanceCsv, prepareAdminFinanceExport, observeAdminFinanceDelivery } from "./admin-finance-export";

export type AdminFinanceOptions = AuthSecurityOptions & { listingCursorKey?: ListingCursorKey };
export async function authorizeAdminFinance(client: PoolClient, context: { userId: string; sessionId: string }, operation: "lookup" | "document" | "complete"): Promise<FinanceActor & { complete: boolean }> {
  await assertAdminContextInTransaction(client, context);
  const access = await loadEffectiveAdminAccess(client, context.userId);
  if (access?.passwordChangeRequired) throw new SecurityApiError(403, "FORBIDDEN", "Password change required");
  const full = access?.status === "ACTIVE" && access.permissions.has(ADMIN_PERMISSION.financeRead);
  const documents = access?.status === "ACTIVE" && access.permissions.has(ADMIN_PERMISSION.financeDocumentRead);
  if (operation === "complete" ? !full : operation === "document" ? !documents : !full && !documents) throw new SecurityApiError(403, "FORBIDDEN", "Finance permission required");
  return { ...context, complete: full, authorizationKey: createHash("sha256").update(canonicalize([...access!.permissions].sort())).digest("hex") };
}
function pageNumber(query: URLSearchParams, name: string, fallback: number, max: number): number {
  const value = query.get(name) ?? String(fallback);
  if (!/^[1-9]\d{0,5}$/.test(value) || Number(value) > max) throw invalid("Invalid finance page");
  return Number(value);
}
function reference(value: string): string {
  let decoded: string; try { decoded = decodeURIComponent(value); } catch { throw invalid("Invalid finance reference"); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(decoded)) throw invalid("Invalid finance reference");
  return decoded;
}
export async function handleAdminFinanceRead(request: SupplyNodeRequest, response: SupplyResponse, options: AdminFinanceOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    const url = new URL(request.originalUrl ?? request.url ?? "", options.apiOrigin);
    const match = /^\/api\/(?:v1\/admin|bff\/admin)\/finance\/(lookup|period|export|subjects\/[^/]+|documents\/[^/]+)$/.exec(url.pathname);
    if ((request.method ?? "GET") !== "GET" || !match) throw notFound();
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== options.adminOrigin && origin !== options.apiOrigin || request.headers["sec-fetch-site"] === "cross-site") throw forbidden();
    const route = match[1]!, complete = route === "period" || route === "export" || route.startsWith("subjects/");
    const operation = complete ? "complete" : route.startsWith("documents/") ? "document" : "lookup";
    const filters = parseAdminFinanceFilters(url.searchParams, new Date(), route === "period" || route === "export");
    filters.q = resolveFinanceLookup(filters.q, [options.adminOrigin, options.userOrigin, options.apiOrigin]);
    const context = await readAdminContext(request, options);
    const page = pageNumber(url.searchParams, "page", 1, 100_000), pageSize = pageNumber(url.searchParams, "pageSize", 20, 100);
    const token = url.searchParams.get("snapshot");
    if ((page > 1 || route === "export") && !token) throw invalid("Finance snapshot is required");
    const result = await withTransaction(options.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const actor = await authorizeAdminFinance(client, context, operation);
      if (route === "lookup" && !actor.complete && !filters.q) throw invalid("A document lookup reference is required");
      const facts = await loadAdminFinanceFacts(client,{filters,...(route==="lookup"?{lookup:{exact:!actor.complete}}:{}),...(route.startsWith("subjects/")?{subjectId:reference(route.slice(9))}:{}),...(route.startsWith("documents/")?{documentRef:reference(route.slice(10))}:{}),page,pageSize}), snapshot = financeSnapshot(facts, filters, actor, options.listingCursorKey, token);
      const common = { contractVersion: ADMIN_FINANCE_VERSION, currency: "CNY", amountUnit: "CENT", timezone: "Asia/Shanghai", applied: filters, snapshot: snapshot.token, asOf: snapshot.asOf, contextKey: actor.authorizationKey, snapshotVersion: facts.version };
      if (route.startsWith("subjects/")) return { actor, body: { ...common, ...await readAdminFinanceSubject(client, facts, reference(route.slice(9)), snapshot.asOf) } };
      if (route.startsWith("documents/")) return { actor, body: { ...common, ...readAdminFinanceDocument(facts, reference(route.slice(10)), url.searchParams.get("entry")) } };
      const entries = route === "lookup" ? [...facts.entries].sort((a,b)=>(b.occurredAt??"").localeCompare(a.occurredAt??"")||(a.id<b.id?1:a.id>b.id?-1:0)) : filterAdminFinanceEntries(facts, filters, filters.period);
      let documents = financeDocuments(entries);
      if (route === "lookup") {
        const byRef = new Map([...financeOrderDocuments(facts, filters), ...documents].map(document => [document.ref, document]));
        documents = facts.lookupPage!.refs.map(ref => {
          const document=byRef.get(ref);if(!document)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Finance page projection unavailable");return document;
        });
      }
      const start = (page - 1) * pageSize;
      if (route === "export") return { actor, generated: generateAdminFinanceCsv(entries, filters, snapshot.asOf, facts.version), token: snapshot.token, body: common };
      if (route === "lookup") {
        const query = filters.q.toLocaleLowerCase("zh-CN");
        const subjects = actor.complete && query ? facts.subjectCandidates??{items:[],total:0} : {items:[],total:0};
        return { actor, body: { ...common, documents, subjects: subjects.items, subjectCount: subjects.total, documentCount: facts.lookupPage!.documentCount, entryCount: facts.lookupPage!.entryCount, page, pageSize, hasMore: start + pageSize < facts.lookupPage!.documentCount || start + pageSize < subjects.total } };
      }
      return { actor, body: { ...common, entries: entries.slice(start, start + pageSize), documentCount: documents.length, entryCount: entries.length, page, pageSize, hasMore: start + pageSize < entries.length,
        reconciliation: financePeriodProjection(entries), gaps: ["PERIOD_BALANCE_PROOF_NOT_AVAILABLE", ...(!facts.withdrawalsReady ? ["WITHDRAWAL_SOURCE_NOT_AVAILABLE"] : []), "NATIVE_DISTRIBUTION_NOT_AVAILABLE", "CHANNEL_COST_NOT_AVAILABLE"] } };
    });
    if (result.generated) {
      const receipt = await prepareAdminFinanceExport(options, result.actor, filters, result.token!, result.generated, requestId);
      if (!response.send) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Finance file delivery is unavailable");
      observeAdminFinanceDelivery(response, options, result.actor, receipt);
      response.status(200).setHeader("Cache-Control", "no-store").setHeader("X-Request-Id", requestId)
        .setHeader("Content-Type", "text/csv; charset=utf-8").setHeader("X-Content-Type-Options", "nosniff")
        .setHeader("Content-Disposition", `attachment; filename="admin-finance-${filters.from}-${filters.to}.csv"`)
        .setHeader("X-Finance-Export-Phase", receipt.phase).setHeader("X-Finance-Row-Count", String(receipt.rowCount)).setHeader("X-Finance-File-Digest", receipt.fileDigest);
      response.send(result.generated.bytes); return;
    }
    await withTransaction(options.pool, async client => {
      const current = await authorizeAdminFinance(client, result.actor, operation);
      if (current.authorizationKey !== result.actor.authorizationKey) throw new SecurityApiError(409, "CONFLICT", "Finance access changed; reload");
    });
    sendJson(response, 200, result.body, requestId);
  });
}
export function mountAdminFinanceRead(app: INestApplication, options: AdminFinanceOptions | (() => AdminFinanceOptions | undefined)): void {
  for (const prefix of ["/api/v1/admin/finance", "/api/bff/admin/finance"]) app.getHttpAdapter().getInstance().use(prefix, (request: SupplyNodeRequest, response: SupplyResponse) => {
    const resolved = typeof options === "function" ? options() : options;
    if (resolved) return handleAdminFinanceRead(request, response, resolved);
    const requestId = ensureApiV1RequestId(request);
    return safely(response, requestId, async () => { throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Finance authentication context is not ready"); });
  });
}
