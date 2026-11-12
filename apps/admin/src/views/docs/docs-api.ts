import { AdminApiError, adminRequest } from "../../api";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import {
  newWriteKey,
  type DocComment,
  type DocContentSaveResult,
  type DocDeleteResult,
  type DocDetail,
  type DocDiscussion,
  type DocDiscussionPage,
  type DocDiscussionStatus,
  type DocDiscussionWriteResult,
  type DocImageSignResult,
  type DocImageUploadIntent,
  type DocSearchPage,
  type DocTrashPage,
  type DocTreeNode,
  type DocTreePage,
  type DocVersion,
} from "./docs-model";

/** P1a 内部文档库 BFF 客户端。路径与入出参严格按 requirements「P1 接口」表。 */

export const isConflict = (error: unknown): boolean => error instanceof AdminApiError && error.status === 409;
export const isForbidden = (error: unknown): boolean => error instanceof AdminApiError && error.status === 403;
export const isNotFound = (error: unknown): boolean => error instanceof AdminApiError && error.status === 404;
export const isMoveInvalid = (error: unknown): boolean =>
  error instanceof AdminApiError && error.status === 400 && (error.reason === "MOVE_INVALID" || error.details.some((d) => d.code === "MOVE_INVALID"));

/** 503 IMAGES_DISABLED：兼容 code / reason / details.reason 三种承载位置。 */
export function isImagesDisabled(error: unknown): boolean {
  if (!(error instanceof AdminApiError) || error.status !== 503) return false;
  return error.code === "IMAGES_DISABLED" || error.reason === "IMAGES_DISABLED" || error.details.some((d) => d.code === "IMAGES_DISABLED");
}

/** 404 细分：已删除（回收站）与已永久清理。服务端未给细分时按「已在回收站或不存在」兜底。 */
export function notFoundKind(error: unknown): "deleted" | "purged" | "unknown" {
  if (!(error instanceof AdminApiError)) return "unknown";
  const hints = [error.reason ?? "", ...error.details.map((d) => d.code), ...error.reasons];
  if (hints.some((hint) => /PURGED|PURGE/i.test(hint))) return "purged";
  if (hints.some((hint) => /DELETED|TRASH/i.test(hint))) return "deleted";
  return "unknown";
}

export const fetchDocTree = () => adminRequest<DocTreePage>("/docs/tree");
export const fetchDoc = (id: string) => adminRequest<DocDetail>(`/docs/${encodeURIComponent(id)}`);

export const createDoc = (body: { parentId: string | null; title: string; afterId?: string }, key = newWriteKey()) =>
  adminRequest<DocDetail>("/docs", body, "POST", { "idempotency-key": key });

export const saveDocContent = (id: string, body: { expectedRevision: string; document: PlateDocumentEnvelope }, key: string) =>
  adminRequest<DocContentSaveResult>(`/docs/${encodeURIComponent(id)}/content`, body, "PUT", { "idempotency-key": key });

// 合同要求 PATCH；adminRequest 的 method 联合未含 PATCH（不改共享 api.ts），fetch 运行时支持该方法。
export const renameDoc = (id: string, body: { expectedRevision: string; title: string }, key = newWriteKey()) =>
  adminRequest<DocDetail>(`/docs/${encodeURIComponent(id)}`, body, "PATCH", { "idempotency-key": key });

export const moveDoc = (id: string, body: { expectedRevision: string; parentId: string | null; afterId: string | null }, key = newWriteKey()) =>
  adminRequest<{ node: DocTreeNode }>(`/docs/${encodeURIComponent(id)}/move`, body, "POST", { "idempotency-key": key });

export const deleteDoc = (id: string, body: { expectedRevision: string }, key = newWriteKey()) =>
  adminRequest<DocDeleteResult>(`/docs/${encodeURIComponent(id)}`, body, "DELETE", { "idempotency-key": key });

export const fetchDocVersions = (id: string, cursor?: string | null) =>
  adminRequest<{ items?: DocVersion[]; versions?: DocVersion[]; nextCursor?: string | null }>(
    `/docs/${encodeURIComponent(id)}/versions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );

export const fetchDocVersion = (id: string, versionId: string) =>
  adminRequest<{ version: DocVersion }>(`/docs/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`).then(result => result.version);

export const restoreDocVersion = (id: string, body: { expectedRevision: string; versionId: string }, key = newWriteKey()) =>
  adminRequest<DocDetail>(`/docs/${encodeURIComponent(id)}/restore-version`, body, "POST", { "idempotency-key": key });

export const fetchDocTrash = (cursor?: string | null) =>
  adminRequest<DocTrashPage>(`/docs/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);

export const restoreDocTrash = (batchId: string, body: { parentId?: string | null }, key = newWriteKey()) =>
  adminRequest<{ node: DocTreeNode }>(`/docs/trash/${encodeURIComponent(batchId)}/restore`, body, "POST", { "idempotency-key": key });

export const searchDocs = (params: { q: string; cursor?: string | null }) => {
  const query = new URLSearchParams({ q: params.q });
  if (params.cursor) query.set("cursor", params.cursor);
  return adminRequest<DocSearchPage>(`/docs/search?${query}`);
};

export const uploadDocImageIntent = (nodeId: string, body: { mime: string; bytes: number; width: number; height: number }, key = newWriteKey()) =>
  adminRequest<DocImageUploadIntent>(`/docs/${encodeURIComponent(nodeId)}/images`, body, "POST", { "idempotency-key": key });

export const completeDocImage = (imageId: string, key = newWriteKey()) =>
  adminRequest<{ imageId: string; status: string }>(`/docs/images/${encodeURIComponent(imageId)}/complete`, {}, "POST", { "idempotency-key": key });

export const signDocImages = (nodeId: string, imageIds: string[]) =>
  adminRequest<DocImageSignResult>(`/docs/${encodeURIComponent(nodeId)}/images/sign`, { imageIds }, "POST");

export function versionItems(page: { items?: DocVersion[]; versions?: DocVersion[] } | null | undefined): DocVersion[] {
  return page?.items ?? page?.versions ?? [];
}

// --- P1b 划词评论 -------------------------------------------------------------

export const fetchDocDiscussions = (id: string, status?: DocDiscussionStatus) =>
  adminRequest<DocDiscussionPage>(`/docs/${encodeURIComponent(id)}/discussions${status ? `?status=${status}` : ""}`);

export const createDocDiscussion = (id: string, body: { discussionId: string; anchorText: string; anchorOffset?: number; expectedRevision?: string; body: string }, key = newWriteKey()) =>
  adminRequest<DocDiscussionWriteResult>(`/docs/${encodeURIComponent(id)}/discussions`, body, "POST", { "idempotency-key": key });

export const addDocComment = (discussionId: string, body: { body: string }, key = newWriteKey()) =>
  adminRequest<{ comment: DocComment }>(`/docs/discussions/${encodeURIComponent(discussionId)}/comments`, body, "POST", { "idempotency-key": key });

export const editDocComment = (commentId: string, body: { body: string }, key = newWriteKey()) =>
  adminRequest<{ comment: DocComment }>(`/docs/comments/${encodeURIComponent(commentId)}`, body, "PATCH", { "idempotency-key": key });

export const deleteDocComment = (commentId: string, key = newWriteKey()) =>
  adminRequest<{ comment: DocComment }>(`/docs/comments/${encodeURIComponent(commentId)}`, {}, "DELETE", { "idempotency-key": key });

export const resolveDocDiscussion = (discussionId: string, key = newWriteKey()) =>
  adminRequest<DocDiscussionWriteResult>(`/docs/discussions/${encodeURIComponent(discussionId)}/resolve`, {}, "POST", { "idempotency-key": key });

export const reopenDocDiscussion = (discussionId: string, key = newWriteKey()) =>
  adminRequest<{ discussion: DocDiscussion }>(`/docs/discussions/${encodeURIComponent(discussionId)}/reopen`, {}, "POST", { "idempotency-key": key });