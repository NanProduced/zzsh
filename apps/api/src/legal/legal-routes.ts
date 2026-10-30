import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { ADMIN_PERMISSION, hasPermission, requirePermission } from "../auth/admin-authorization";
import { recordAudit, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { decodeId, requireAdminAccess, requireOrigin, safely } from "../supply/supply-routes";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest, type SupplyNodeResponse } from "../supply/supply-util";
import {
  createLegalDraft,
  listLegalDocuments,
  readLegalDocumentById,
  parseLegalDocType,
  readCurrentLegalDocument,
  readCurrentPlatformDocuments,
  sealLegalDocument,
  updateLegalDraft,
  type LegalDocType,
} from "./legal-documents";

type Options = AuthSecurityOptions;
type Response = SupplyNodeResponse & { send?: (body: Buffer | string) => void };

const DOC_ROUTES: Record<string, LegalDocType> = { terms: "PLATFORM_TERMS", privacy: "PLATFORM_PRIVACY" };

function summary(document: Awaited<ReturnType<typeof readCurrentLegalDocument>>) {
  return document ? { id: document.id, docType: document.docType, title: document.title, digest: document.digest, effectiveAt: document.effectiveAt } : null;
}

async function handlePublic(request: SupplyNodeRequest, response: Response, options: Options): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path } = requestPath(request, "/api/v1/legal-documents");
  if (!requireOrigin(request, response, options, requestId)) return;
  if ((request.method ?? "GET").toUpperCase() !== "GET") throw notFound();
  if (path === "/current") {
    const result = await withTransaction(options.pool, async client => {
      const current = await readCurrentPlatformDocuments(client);
      return { terms: summary(current.terms), privacy: summary(current.privacy) };
    });
    sendJson(response, 200, result, requestId, "public, max-age=0, must-revalidate");
    return;
  }
  const docType = DOC_ROUTES[path.slice(1)];
  if (!docType) throw notFound();
  const document = await withTransaction(options.pool, client => readCurrentLegalDocument(client, docType));
  if (!document) {
    sendJson(response, 200, { docType, state: "PENDING", title: docType === "PLATFORM_TERMS" ? "平台服务协议" : "用户隐私政策" }, requestId, "public, max-age=0, must-revalidate");
    return;
  }
  sendJson(response, 200, { docType, state: "PUBLISHED", document }, requestId, "public, max-age=0, must-revalidate");
}

function requestPath(request: SupplyNodeRequest, prefix: string): { path: string } {
  const raw = (request.originalUrl ?? request.url ?? "/").split("?", 1)[0] ?? "/";
  return { path: raw.startsWith(prefix) ? raw.slice(prefix.length) || "/" : raw };
}

async function snapshot(client: PoolClient, id: string): Promise<Record<string, unknown> | null> {
  return readLegalDocumentById(client, id);
}

async function writeAudit(client: PoolClient, actorId: string, sessionId: string, requestId: string, action: string, id: string, before: unknown, after: unknown): Promise<void> {
  await recordAudit(client, {
    actorType: "admin", actorId, sessionId, action, objectType: "legal_document_version", objectId: id,
    outcome: "SUCCESS", requestId, reason: action, details: { before, after, result: "APPLIED" },
  });
}

async function handleAdmin(request: SupplyNodeRequest, response: Response, options: Options): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  if (!requireOrigin(request, response, options, requestId)) return;
  const context = await readAdminContext(request, options);
  const actor = { id: context.userId, sessionId: context.sessionId };
  const method = (request.method ?? "GET").toUpperCase();
  const path = requestPath(request, "/api/v1/admin/legal-documents").path;

  if (method === "GET" && path === "/") {
    const docType = new URL(request.url ?? "/", "http://local").searchParams.get("docType");
    const result = await withTransaction(options.pool, async client => {
      const access = await requireAdminAccess(client, actor.id);
      if (![ADMIN_PERMISSION.contentPlatformRead, ADMIN_PERMISSION.contentPlatformEdit, ADMIN_PERMISSION.contentPlatformPublish].some(permission => hasPermission(access, permission))) {
        requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      }
      return listLegalDocuments(client, docType ? parseLegalDocType(docType) : undefined);
    });
    sendJson(response, 200, { versions: result }, requestId);
    return;
  }
  if (method === "POST" && path === "/drafts") {
    const body = bodyOf(request);
    const result = await withTransaction(options.pool, async client => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
      const draft = await createLegalDraft(client, actor.id, body);
      await writeAudit(client, actor.id, actor.sessionId, requestId, "legal.document.draft.create", draft.id, null, draft);
      return draft;
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const update = /^\/drafts\/([^/]+)$/.exec(path);
  if (method === "PUT" && update) {
    const id = decodeId(update[1]!);
    const body = bodyOf(request);
    const result = await withTransaction(options.pool, async client => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformEdit);
      const before = await snapshot(client, id);
      const draft = await updateLegalDraft(client, id, body);
      await writeAudit(client, actor.id, actor.sessionId, requestId, "legal.document.draft.update", id, before, draft);
      return draft;
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  const seal = /^\/drafts\/([^/]+)\/seal$/.exec(path);
  if (method === "POST" && seal) {
    const id = decodeId(seal[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["expectedRevision"]);
    const result = await withTransaction(options.pool, async client => {
      const access = await requireAdminAccess(client, actor.id);
      requirePermission(access, ADMIN_PERMISSION.contentPlatformPublish);
      const before = await snapshot(client, id);
      const sealed = await sealLegalDocument(client, actor.id, id, body.expectedRevision);
      await writeAudit(client, actor.id, actor.sessionId, requestId, "legal.document.seal", id, before, sealed);
      return sealed;
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  throw notFound();
}

export function mountLegalHandlers(app: INestApplication, options: Options): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: Response) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/legal-documents", (request, response) => safely(response, ensureApiV1RequestId(request), () => handlePublic(request, response, options)));
  expressApp.use("/api/v1/admin/legal-documents", (request, response) => safely(response, ensureApiV1RequestId(request), () => handleAdmin(request, response, options)));
}
