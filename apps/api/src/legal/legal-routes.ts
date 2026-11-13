import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { ADMIN_PERMISSION, hasPermission, requirePermission } from "../auth/admin-authorization";
import { recordAudit, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { decodeId, requireAdminAccess, requireOrigin, runIdempotentWrite, safely } from "../supply/supply-routes";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest, type SupplyNodeResponse } from "../supply/supply-util";
import {
  createLegalDraft,
  FIXED_DOC_TYPES,
  listLegalDocuments,
  readLegalDocumentById,
  parseFixedDocType,
  readCurrentLegalDocument,
  readCurrentPlatformDocuments,
  returnLegalDocumentToDraft,
  updateLegalDraft,
  type LegalDocType,
} from "./legal-documents";
import {
  FIXED_DOCUMENT_PUBLISH_PERMISSION,
  FIXED_DOCUMENT_SUBMIT_PERMISSION,
  blockChangeCounts,
  diffDocumentBlocks,
  submitFixedDocumentPublish,
} from "./fixed-document-publish";
import { fixedDocumentPlainText } from "./fixed-document-projection";

type Options = AuthSecurityOptions;
type Response = SupplyNodeResponse & { send?: (body: Buffer | string) => void };

const DOC_ROUTES = new Map<string, LegalDocType>([["terms", "PLATFORM_TERMS"], ["privacy", "PLATFORM_PRIVACY"]]);

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
  // 提前结算告知随订单适用版本读取，不在平台文书公开路由暴露。
  const docType = DOC_ROUTES.get(path.slice(1));
  if (!docType) throw notFound();
  const version = new URL(request.originalUrl ?? request.url ?? "/", "http://local").searchParams.get("version") ?? undefined;
  const document = await withTransaction(options.pool, client => readCurrentLegalDocument(client, docType, undefined, version));
  if (!document) {
    if (version !== undefined) throw notFound();
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

function canReadLegal(access: Awaited<ReturnType<typeof requireAdminAccess>>): boolean {
  return [ADMIN_PERMISSION.contentPlatformRead, ADMIN_PERMISSION.contentPlatformEdit, ADMIN_PERMISSION.contentPlatformPublish,
    FIXED_DOCUMENT_SUBMIT_PERMISSION, FIXED_DOCUMENT_PUBLISH_PERMISSION].some(permission => hasPermission(access, permission));
}

export async function handleLegalAdminRoute(request: SupplyNodeRequest, response: Response, options: Options): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  if (!requireOrigin(request, response, options, requestId)) return;
  const context = await readAdminContext(request, options);
  const actor = { id: context.userId, sessionId: context.sessionId };
  const method = (request.method ?? "GET").toUpperCase();
  const path = requestPath(request, "/api/v1/admin/legal-documents").path;

  if (method === "GET" && path === "/") {
    const requestedType = new URL(request.url ?? "/", "http://local").searchParams.get("docType");
    const docType = requestedType ? parseFixedDocType(requestedType) : undefined;
    const result = await withTransaction(options.pool, async client => {
      const access = await requireAdminAccess(client, actor.id);
      if (!canReadLegal(access)) requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      const versions = await listLegalDocuments(client, docType);
      const current = await Promise.all((docType ? [docType] : FIXED_DOC_TYPES).map(type => readCurrentLegalDocument(client, type)));
      return { versions, current: current.filter(version => version !== null) };
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  if (method === "POST" && path === "/drafts") {
    const body = bodyOf(request);
    await runIdempotentWrite(
      options, request, response, requestId,
      { principalId: actor.id, operation: "legal.document.draft.create" },
      { realm: "admin", id: actor.id, sessionId: actor.sessionId }, body,
      async client => { requirePermission(await requireAdminAccess(client, actor.id), ADMIN_PERMISSION.contentPlatformEdit); },
      async client => {
        const draft = await createLegalDraft(client, actor.id, body);
        await writeAudit(client, actor.id, actor.sessionId, requestId, "legal.document.draft.create", draft.id, null, draft);
        return { status: 200, body: draft };
      },
    );
    return;
  }
  const update = /^\/drafts\/([^/]+)$/.exec(path);
  if (method === "PUT" && update) {
    const id = decodeId(update[1]!);
    const body = bodyOf(request);
    await runIdempotentWrite(
      options, request, response, requestId,
      { principalId: actor.id, operation: "legal.document.draft.update", resourceId: id },
      { realm: "admin", id: actor.id, sessionId: actor.sessionId }, body,
      async client => { requirePermission(await requireAdminAccess(client, actor.id), ADMIN_PERMISSION.contentPlatformEdit); },
      async client => {
        const before = await snapshot(client, id);
        const draft = await updateLegalDraft(client, id, body);
        await writeAudit(client, actor.id, actor.sessionId, requestId, "legal.document.draft.update", id, before, draft);
        return { status: 200, body: draft };
      },
    );
    return;
  }
  // 用户端预览与线上差异：只读，按块比对纯文字，不改任何存储正文。
  const diff = /^\/drafts\/([^/]+)\/diff$/.exec(path);
  if (method === "GET" && diff) {
    const id = decodeId(diff[1]!);
    const result = await withTransaction(options.pool, async client => {
      const access = await requireAdminAccess(client, actor.id);
      if (!canReadLegal(access)) requirePermission(access, ADMIN_PERMISSION.contentPlatformRead);
      const draft = await readLegalDocumentById(client, id);
      if (!draft) throw notFound();
      const current = await readCurrentLegalDocument(client, draft.docType);
      const blocks = diffDocumentBlocks(current ? fixedDocumentPlainText(current) : "", fixedDocumentPlainText(draft));
      return { draft, current, blocks, changes: blockChangeCounts(blocks) };
    });
    sendJson(response, 200, result, requestId);
    return;
  }
  // 审批被驳回 / 撤回后退回草稿；仍在处理中的申请不能退回。
  const back = /^\/drafts\/([^/]+)\/return$/.exec(path);
  if (method === "POST" && back) {
    const id = decodeId(back[1]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, []);
    await runIdempotentWrite(
      options, request, response, requestId,
      { principalId: actor.id, operation: "legal.document.return", resourceId: id },
      { realm: "admin", id: actor.id, sessionId: actor.sessionId }, body,
      async client => { requirePermission(await requireAdminAccess(client, actor.id), FIXED_DOCUMENT_SUBMIT_PERMISSION); },
      async client => {
        const before = await snapshot(client, id);
        const draft = await returnLegalDocumentToDraft(client, id);
        await writeAudit(client, actor.id, actor.sessionId, requestId, "legal.document.return", id, before, draft);
        return { status: 200, body: draft };
      },
    );
    return;
  }
  // 提交「固定文书发布」审批：同一事务重核冻结事实、建真实申请、法律文书草稿置 PENDING。
  // 生效只能由审批中心决定事务内的执行器完成，这里不写任何决定或执行回执。
  if (method === "POST" && path === "/fixed-document-submissions") {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["items", "reason"]);
    await runIdempotentWrite(
      options, request, response, requestId,
      { principalId: actor.id, operation: "content.fixed_document.submit" },
      { realm: "admin", id: actor.id, sessionId: actor.sessionId },
      body,
      async client => {
        const access = await requireAdminAccess(client, actor.id);
        requirePermission(access, FIXED_DOCUMENT_SUBMIT_PERMISSION);
        requirePermission(access, ADMIN_PERMISSION.approvalRequestCreate);
      },
      async client => {
        const submission = await submitFixedDocumentPublish(client, actor, { payload: { items: body.items }, reason: body.reason as string }, requestId);
        return { status: 200, body: submission };
      },
    );
    return;
  }
  throw notFound();
}

export function mountLegalHandlers(app: INestApplication, options: Options): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: Response) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/legal-documents", (request, response) => safely(response, ensureApiV1RequestId(request), () => handlePublic(request, response, options)));
  expressApp.use("/api/v1/admin/legal-documents", (request, response) => safely(response, ensureApiV1RequestId(request), () => handleLegalAdminRoute(request, response, options)));
}
