import { extractPlate, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";

/**
 * P1a 内部文档库前端合同类型。字段与 requirements「P1 接口」表一一对应，
 * 不新增合同外字段；服务端可能多给的字段一律忽略。
 */

export type DocTreeNode = {
  id: string;
  parentId: string | null;
  depth: number;
  title: string;
  sortKey: string;
  updatedAt: string;
  updatedBy: string;
};

export type DocVersionKind = "CREATE" | "EDIT" | "RESTORE" | "ANNOTATE";

/** 版本列表行 / 单个版本。列表可能不带 document，单个版本一定带。 */
export type DocVersion = {
  id: string;
  seq: number;
  kind: DocVersionKind;
  savedAt: string;
  authorAdminId?: string;
  saveCount?: number;
  restoredFromVersionId?: string | null;
  document?: PlateDocumentEnvelope;
};

export type DocDetail = {
  node: DocTreeNode;
  version: DocVersion & { document: PlateDocumentEnvelope };
  revision: string;
};

export type DocContentSaveResult = {
  revision: string;
  versionId: string;
  seq: number;
  merged: boolean;
  savedAt: string;
  orphanedDiscussionIds?: string[];
};

export type DocDeleteResult = { deletedCount: number; batchId: string; purgeAt: string };

export type DocTrashItem = {
  batchId: string;
  rootNodeId: string;
  title: string;
  deletedAt: string;
  deletedBy: string;
  count: number;
  purgeAt: string;
};

export type DocImageUploadIntent = {
  imageId: string;
  upload: { url: string; fields?: Record<string, string>; headers?: Record<string, string>; expiresAt: string };
};

export type DocImageSignResult = { urls: Record<string, { url: string; expiresAt: string }> };

export type DocTreePage = { nodes: DocTreeNode[] };
export type DocTrashPage = { items: DocTrashItem[]; nextCursor?: string | null };
/** 搜索出参合同只约定「只匹配标题」；兼容 items / nodes 两种列表键与游标。 */
export type DocSearchPage = { items?: DocTreeNode[]; nodes?: DocTreeNode[]; nextCursor?: string | null };

// --- P1b 划词评论 -------------------------------------------------------------

export type DocDiscussionStatus = "OPEN" | "RESOLVED";
export type DocAnchorState = "PRESENT" | "ORPHANED";

export type DocComment = {
  id: string;
  discussionId: string;
  body: string;
  authorAdminId: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type DocDiscussion = {
  id: string;
  nodeId: string;
  anchorText: string;
  status: DocDiscussionStatus;
  anchorState: DocAnchorState;
  createdByAdminId: string;
  createdAt: string;
  resolvedByAdminId: string | null;
  resolvedAt: string | null;
  comments: DocComment[];
};

export type DocDiscussionPage = { discussions: DocDiscussion[] };

/** 建讨论 / 解决返回 ANNOTATE 版本与带 mark 变化的正文；revision 不变。 */
export type DocDiscussionWriteResult = {
  discussion: DocDiscussion;
  versionId: string;
  seq: number;
  document: PlateDocumentEnvelope;
  revision: string;
};

export const DOC_ANCHOR_MAX = 500;
export const DOC_COMMENT_MAX = 2000;

/** 前端生成讨论 id：dsc_ + uuid（去横线），即正文 comment_<id> mark 的 id。 */
export function newDiscussionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `dsc_${uuid.replaceAll("-", "").slice(0, 32)}`;
}

export function discussionGroups(items: readonly DocDiscussion[]): { open: DocDiscussion[]; resolved: DocDiscussion[] } {
  return { open: items.filter((item) => item.status === "OPEN"), resolved: items.filter((item) => item.status === "RESOLVED") };
}

export function openDiscussionIds(items: readonly DocDiscussion[]): string[] {
  return items.filter((item) => item.status === "OPEN").map((item) => item.id);
}

/** 移除某讨论的 comment_<id> mark（解决 / 本地同步用），保留文字与其他 mark。 */
export function removeDiscussionMark(value: PlateNode[], discussionId: string): PlateNode[] {
  const key = `comment_${discussionId}`;
  const walk = (node: PlateNode): PlateNode => {
    if (typeof node.text === "string") {
      if (!(key in node)) return node;
      const out = { ...node };
      delete out[key];
      return out;
    }
    if (!node.children) return node;
    return { ...node, children: node.children.map(walk) };
  };
  return value.map(walk);
}

/** 在本地未保存正文上补加新讨论的 mark（与服务端同一投影规则）；找不到锚点返回 null。 */
export function addDiscussionMark(value: PlateNode[], discussionId: string, anchorText: string, anchorOffset?: number): PlateNode[] | null {
  if (!anchorText) return null;
  const envelope: PlateDocumentEnvelope = { format: "plate", schemaVersion: 1, preset: "internal", value };
  const plain = extractPlate(envelope).plainText;
  const at = anchorOffset ?? plain.indexOf(anchorText);
  if (at < 0 || plain.slice(at, at + anchorText.length) !== anchorText) return null;
  const start = at;
  const end = at + anchorText.length;
  const positions = new Map<string, { start: number; end: number }>();
  let cursor = 0;
  const measure = (node: PlateNode, path: string): void => {
    if (typeof node.text === "string") {
      positions.set(path, { start: cursor, end: cursor + node.text.length });
      cursor += node.text.length;
      return;
    }
    if (node.type === "img") { cursor += typeof node.alt === "string" ? node.alt.length : 0; return; }
    if (node.type === "hr" || node.type === "toc") return;
    const separator = node.type === "tr" ? "\t"
      : node.type === "p" || node.type === "h2" || node.type === "h3" || node.type === "h4" || node.type === "code_line" || node.type === "a" ? ""
      : "\n";
    (node.children ?? []).forEach((child, index) => {
      if (index > 0) cursor += separator.length;
      measure(child, `${path},${index}`);
    });
  };
  value.forEach((node, index) => {
    if (index > 0) cursor += 1;
    measure(node, String(index));
  });
  const key = `comment_${discussionId}`;
  let marked = false;
  const rebuild = (nodes: PlateNode[], path: string): PlateNode[] => nodes.flatMap((node, index) => {
    const childPath = path ? `${path},${index}` : String(index);
    if (typeof node.text === "string") {
      const position = positions.get(childPath);
      if (!position) return [node];
      const from = Math.max(position.start, start);
      const to = Math.min(position.end, end);
      if (from >= to) return [node];
      marked = true;
      const localFrom = from - position.start;
      const localTo = to - position.start;
      const { text, ...marks } = node;
      const out: PlateNode[] = [];
      if (localFrom > 0) out.push({ ...marks, text: text.slice(0, localFrom) });
      out.push({ ...marks, [key]: true, text: text.slice(localFrom, localTo) });
      if (localTo < text.length) out.push({ ...marks, text: text.slice(localTo) });
      return out;
    }
    if (!node.children) return [node];
    return [{ ...node, children: rebuild(node.children, childPath) }];
  });
  const next = rebuild(value, "");
  return marked ? next : null;
}

export const DOC_TITLE_MAX = 200;
export const DOC_SEARCH_MAX = 100;
export const DOC_MAX_DEPTH = 3;
export const DOC_TRASH_DAYS = 30;

export function docPath(id: string): string {
  return `/docs/${encodeURIComponent(id)}`;
}

export function newWriteKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `idem_${uuid.replaceAll("-", "")}`;
}

/** bigint revision 一律按字符串比较与回传，避免 JS 精度损失。 */
export function normalizeRevision(value: unknown): string {
  return typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
}

export type DocTreeRoot = { node: DocTreeNode; children: DocTreeRoot[] };

export function buildDocTree(nodes: readonly DocTreeNode[]): DocTreeRoot[] {
  const byId = new Map<string, DocTreeRoot>();
  for (const node of nodes) byId.set(node.id, { node, children: [] });
  const roots: DocTreeRoot[] = [];
  for (const entry of byId.values()) {
    const parent = entry.node.parentId ? byId.get(entry.node.parentId) : undefined;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }
  const sort = (list: DocTreeRoot[]) => {
    list.sort((a, b) => (a.node.sortKey < b.node.sortKey ? -1 : a.node.sortKey > b.node.sortKey ? 1 : 0));
    for (const entry of list) sort(entry.children);
  };
  sort(roots);
  return roots;
}

export function flattenDocTree(roots: readonly DocTreeRoot[], expanded: ReadonlySet<string>): DocTreeNode[] {
  const out: DocTreeNode[] = [];
  const walk = (list: readonly DocTreeRoot[]) => {
    for (const entry of list) {
      out.push(entry.node);
      if (entry.children.length && expanded.has(entry.node.id)) walk(entry.children);
    }
  };
  walk(roots);
  return out;
}

export function docSubtreeDepth(id: string, byId: ReadonlyMap<string, DocTreeNode>): number {
  let max = 0;
  for (const node of byId.values()) {
    let cursor: DocTreeNode | undefined = node;
    let steps = 0;
    while (cursor && cursor.id !== id && steps <= DOC_MAX_DEPTH + 1) {
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      steps += 1;
    }
    if (cursor?.id === id) max = Math.max(max, steps + 1);
  }
  return Math.max(1, max);
}

export function isDescendant(id: string, maybeAncestorId: string, byId: ReadonlyMap<string, DocTreeNode>): boolean {
  let cursor = byId.get(id);
  let steps = 0;
  while (cursor?.parentId && steps <= DOC_MAX_DEPTH + 1) {
    if (cursor.parentId === maybeAncestorId) return true;
    cursor = byId.get(cursor.parentId);
    steps += 1;
  }
  return false;
}

/** 客户端预检：成环、超三层。服务端仍是最终边界（400 MOVE_INVALID）。 */
export function canMoveDoc(id: string, parentId: string | null, byId: ReadonlyMap<string, DocTreeNode>): boolean {
  const node = byId.get(id);
  if (!node) return false;
  if (parentId === id) return false;
  if (parentId) {
    const parent = byId.get(parentId);
    if (!parent || isDescendant(parentId, id, byId)) return false;
    return parent.depth + docSubtreeDepth(id, byId) <= DOC_MAX_DEPTH;
  }
  return docSubtreeDepth(id, byId) <= DOC_MAX_DEPTH;
}

export function docAncestors(node: DocTreeNode, byId: ReadonlyMap<string, DocTreeNode>): DocTreeNode[] {
  const out: DocTreeNode[] = [];
  let cursor = node.parentId ? byId.get(node.parentId) : undefined;
  let steps = 0;
  while (cursor && steps <= DOC_MAX_DEPTH) {
    out.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    steps += 1;
  }
  return out;
}

/** 回收站「N 天后永久清理」：向上取整，至少显示 1 天（到期当天由服务端清理）。 */
export function purgeDaysLeft(purgeAt: string, now: number = Date.now()): number {
  const target = Date.parse(purgeAt);
  if (Number.isNaN(target)) return DOC_TRASH_DAYS;
  return Math.max(1, Math.ceil((target - now) / 86_400_000));
}

const BEIJING_HHMM = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const BEIJING_FULL = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function saveClock(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : BEIJING_HHMM.format(date);
}

export function docTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : BEIJING_FULL.format(date);
}

export function versionKindLabel(kind: string): string {
  if (kind === "CREATE") return "创建";
  if (kind === "RESTORE") return "回滚";
  if (kind === "ANNOTATE") return "评论标注";
  return "编辑";
}

/** 标题搜索只查标题；q 上限 100 字（按码点计）。 */
export function docSearchError(q: string): string | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  if ([...trimmed].length > DOC_SEARCH_MAX) return `搜索词最多 ${DOC_SEARCH_MAX} 字，请缩短后重试。`;
  return null;
}

export function searchResults(page: DocSearchPage | null | undefined): DocTreeNode[] {
  return page?.items ?? page?.nodes ?? [];
}