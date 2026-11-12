import { AdminApiError, adminRequest } from "../../api";
import { isConflict, isForbidden } from "./docs-api";
import { newWriteKey } from "./docs-model";

/** 目录结构即时生效，正文仍按资源版本保存和发布。 */
export type HelpTreeNode = {
  id: string;
  parentId: string | null;
  depth: number;
  kind: "FOLDER" | "ARTICLE";
  title: string | null;
  description?: string | null;
  iconKey?: string | null;
  /** ARTICLE 必填：guide:<slug> */
  resourceKey?: string | null;
  sortKey: string;
  revision: string;
  updatedAt: string;
  updatedBy: string;
  published?: boolean;
  hasDraft?: boolean;
  referenceCount?: number;
};

export type HelpTreePage = { nodes: HelpTreeNode[] };

export type HelpDeleteResult = { deletedCount: number; batchId: string; purgeAt: string; referenceCount?: number };

export type HelpTrashItem = {
  batchId: string;
  rootNodeId: string;
  title: string | null;
  deletedAt: string;
  deletedBy: string;
  count: number;
  purgeAt: string;
};

export type HelpTrashPage = { items: HelpTrashItem[]; nextCursor?: string | null };

export { isConflict, isForbidden };

export const fetchHelpTree = () => adminRequest<HelpTreePage>("/content/help-tree");

export const createHelpFolder = (body: { parentId: string | null; title: string; description?: string; iconKey?: string | null; afterId?: string }, key = newWriteKey()) =>
  adminRequest<{ node: HelpTreeNode }>("/content/help-tree/folders", body, "POST", { "idempotency-key": key });

/** 创建草稿并同时挂到帮助目录。 */
export const createHelpArticle = (body: { parentId: string | null; title: string; slug?: string }, key = newWriteKey()) =>
  adminRequest<{ node: HelpTreeNode }>("/content/help-tree/articles", body, "POST", { "idempotency-key": key });

export const renameHelpNode = (id: string, body: { expectedRevision: string; title: string; description?: string; iconKey?: string | null }, key = newWriteKey()) =>
  adminRequest<{ node: HelpTreeNode }>(`/content/help-tree/${encodeURIComponent(id)}`, body, "PATCH", { "idempotency-key": key });

export const moveHelpNode = (id: string, body: { expectedRevision: string; parentId: string | null; afterId: string | null }, key = newWriteKey()) =>
  adminRequest<{ node: HelpTreeNode }>(`/content/help-tree/${encodeURIComponent(id)}/move`, body, "POST", { "idempotency-key": key });

export const deleteHelpNode = (id: string, body: { expectedRevision: string }, key = newWriteKey()) =>
  adminRequest<HelpDeleteResult>(`/content/help-tree/${encodeURIComponent(id)}`, body, "DELETE", { "idempotency-key": key });

export const fetchHelpTrash = (cursor?: string | null) =>
  adminRequest<HelpTrashPage>(`/content/help-tree/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);

/** 恢复回到删除前状态：已发布的立即上线、草稿仍是草稿；需发布权限。 */
export const restoreHelpTrash = (batchId: string, key = newWriteKey()) =>
  adminRequest<{ node?: HelpTreeNode }>(`/content/help-tree/trash/${encodeURIComponent(batchId)}/restore`, {}, "POST", { "idempotency-key": key });

/** ARTICLE 状态标签：未发布 / 已发布 / 有未发布修改。 */
export function helpArticleStateLabel(node: HelpTreeNode): string {
  if (node.kind !== "ARTICLE" || typeof node.published !== "boolean") return "";
  if (node.published && node.hasDraft) return "有未发布修改";
  if (node.published) return "已发布";
  return "未发布";
}

export const isSlugRetired = (error: unknown): boolean =>
  error instanceof AdminApiError && error.status === 400 && (error.reason === "SLUG_RETIRED" || error.details.some((d) => d.code === "SLUG_RETIRED"));