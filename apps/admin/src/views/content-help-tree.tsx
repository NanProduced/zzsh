import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, FileText, MoreHorizontal, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FloatingStatusMessage, StatusMessage } from "../components/ui-elements";
import type { PlateEditorHandle } from "../components/plate/plate-editor";
import {
  createHelpArticle, createHelpFolder, deleteHelpNode, fetchHelpTree,
  isConflict, isForbidden, isSlugRetired, moveHelpNode, renameHelpNode,
  type HelpTreeNode,
} from "./docs/docs-help-api";
import { DOC_MAX_DEPTH, buildDocTree, canMoveDoc, flattenDocTree, newWriteKey } from "./docs/docs-model";
import { resourcePath, type ContentOperation, type ResourceDetail } from "./content-resources-model";
import { useContentResourceWrite } from "./content-resource-write";
import "./docs/docs.css";
import { displayTitle } from "./content-help-icons";
import { HelpWorkspaceDialogs } from "./content-help-dialogs";
import { HelpTreeRow } from "./content-help-tree-row";
import "./content-management.css";
import "./content-help-workspace.css";

const DocumentEditor = lazy(() => import("./content-resource-editor").then(module => ({ default: module.ContentResourceEditor })));

type DropZone = "before" | "inside" | "after";
/** 与规则手册同一编辑链路：详情缺正文时按最新版本补齐 editorSource（只读授权接口）。 */
async function withEditorSource(detail: ResourceDetail): Promise<ResourceDetail> {
  if (detail.draft?.payload || detail.published?.payload || detail.baseline || detail.current.payload) return detail;
  const latest = detail.versions[0];
  if (!latest) throw new Error("内容正文缺失，请重新读取。");
  const source = await adminRequest<NonNullable<ResourceDetail["editorSource"]>>(`${resourcePath(detail.key)}/versions/${encodeURIComponent(latest.id)}`);
  if (source.version.id !== latest.id || source.version.revision !== latest.revision || !source.version.payload || !Array.isArray(source.media)) throw new Error("历史版本读取不完整，请重新读取。");
  return { ...detail, editorSource: source };
}

type HelpTreeProps = {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  refreshNonce: number;
  onDirtyChange: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
};

export function ContentHelpTree(props: HelpTreeProps) {
  const { snapshot } = props;
  const canManage = snapshot.security.isBoss || hasPermission(snapshot, "content.platform.edit");
  const canReviewMedia = snapshot.security.isBoss || hasPermission(snapshot, "content.platform.publish");
  const canPublish = canReviewMedia || hasPermission(snapshot, "content.help.publish");
  const canViewHistory = canManage || canPublish || hasPermission(snapshot, "content.platform.read");
  const scope = [snapshot.adminUserId, snapshot.session.id, canManage, canReviewMedia, canPublish, canViewHistory].join(":");
  return <HelpWorkspace key={scope} {...props} access={{ canManage, canReviewMedia, canPublish, canViewHistory }} />;
}

function HelpWorkspace({ snapshot, refreshNonce, onDirtyChange, onWriteLockChange, access }: HelpTreeProps & {
  access: { canManage: boolean; canReviewMedia: boolean; canPublish: boolean; canViewHistory: boolean };
}) {
  const { canManage, canReviewMedia, canPublish, canViewHistory } = access;
  const canWrite = canManage || canPublish;
  const storageKey = `zzsh.admin.help-workspace:${snapshot.adminUserId}`;
  const remembered = useRef< { openKey: string | null; activeId: string | null; expanded: string[] } | null>(null);
  const readRemembered = useRef(false);
  if (!readRemembered.current) {
    readRemembered.current = true;
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (value && (value.openKey === null || typeof value.openKey === "string") && (value.activeId === null || typeof value.activeId === "string") && Array.isArray(value.expanded) && value.expanded.every((id: unknown) => typeof id === "string")) remembered.current = value;
    } catch { /* Ignore invalid local navigation state. */ }
  }
  const [nodes, setNodes] = useState<HelpTreeNode[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; zone: DropZone } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [create, setCreate] = useState<{ kind: "FOLDER" | "ARTICLE"; parentId: string | null } | null>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createIcon, setCreateIcon] = useState("");
  const createRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const focusEditorKey = useRef<string | null>(null);
  const focusCreatedArticle = useCallback((key: string, editor: PlateEditorHandle) => {
    if (focusEditorKey.current !== key) return;
    focusEditorKey.current = null;
    editor.focusStart();
  }, []);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rename, setRename] = useState<HelpTreeNode | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameIcon, setRenameIcon] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HelpTreeNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveParent, setMoveParent] = useState("");
  const [moveAfter, setMoveAfter] = useState("");
  const [confirmMove, setConfirmMove] = useState<{ id: string; parentId: string | null; afterId: string | null } | null>(null);
  const [initialOpen, setInitialOpen] = useState<string | null>(null);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);

  // 文章编辑器：与规则手册同一 resource 编辑链路，落在编辑态而非只读预览。
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>();
  const [feedbackKey, setFeedbackKey] = useState<string | null>(null);
  const [readBackConflict, setReadBackConflict] = useState(false);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [flowBusy, setFlowBusy] = useState(false);
  const [publishFlow, setPublishFlow] = useState(false);
  const publishFlowRef = useRef(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ key: string | null } | null>(null);
  const writer = useContentResourceWrite(snapshot.adminUserId, snapshot.session.id, true);
  const locked = canWrite && (writer.locked || flowBusy);
  const navigationLocked = locked || publishFlow;
  const pendingWrite = canWrite && (Boolean(writer.pending) || writer.blocked);

  const treeSeq = useRef(0), detailSeq = useRef(0), flowSeq = useRef(0);
  const initializedTree = useRef(false);
  const flowRef = useRef<number | null>(null), dirtyRef = useRef(false), alive = useRef(true);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, { ...node, title: displayTitle(node) }])), [nodes]);
  const openNode = openKey ? nodes.find(node => node.resourceKey === openKey) : undefined;
  const activeNode = activeId ? byId.get(activeId) : undefined;
  const selectedFolder = activeNode?.kind === "FOLDER" ? activeNode.id : activeNode?.parentId ?? openNode?.parentId ?? null;
  const folderPath: string[] = [];
  for (let parent = openNode?.parentId; parent && folderPath.length < DOC_MAX_DEPTH;) {
    const folder = byId.get(parent);
    if (!folder) break;
    folderPath.unshift(folder.title);
    parent = folder.parentId;
  }
  const query = search.trim().toLocaleLowerCase();
  const visibleNodes = useMemo(() => {
    if (!query) return nodes;
    const ids = new Set<string>();
    for (const node of nodes) {
      if (node.kind !== "ARTICLE" || !displayTitle(node).toLocaleLowerCase().includes(query)) continue;
      ids.add(node.id);
      for (let parent = node.parentId; parent && !ids.has(parent); parent = byId.get(parent)?.parentId ?? null) ids.add(parent);
    }
    return nodes.filter(node => ids.has(node.id));
  }, [byId, nodes, query]);
  const roots = useMemo(() => buildDocTree(visibleNodes.map(node => ({ ...node, title: displayTitle(node) }))), [visibleNodes]);
  const treeExpanded = useMemo(() => query ? new Set(visibleNodes.filter(node => node.kind === "FOLDER").map(node => node.id)) : expanded, [expanded, query, visibleNodes]);

  const loadTree = useCallback(async () => {
    const seq = ++treeSeq.current;
    setStatus("loading");
    setErrorMessage(undefined);
    try {
      const page = await fetchHelpTree();
      if (seq !== treeSeq.current || !alive.current) return;
      const list = Array.isArray(page.nodes) ? page.nodes : [];
      const origin = (page as typeof page & { publicOrigin?: unknown }).publicOrigin;
      try {
        const url = typeof origin === "string" ? new URL(origin) : null;
        setPublicOrigin(url && (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin && !url.username && !url.password ? url.origin : null);
      } catch { setPublicOrigin(null); }
      setNodes(list);
      setStatus("ready");
      const initial = !initializedTree.current;
      initializedTree.current = true;
      const ids = new Set(list.map(node => node.id));
      if (initial) {
        const selected = remembered.current
          ? list.find(node => node.kind === "ARTICLE" && node.resourceKey === remembered.current?.openKey)
          : list.find(node => node.kind === "ARTICLE" && node.resourceKey);
        const ancestors: string[] = [];
        for (let parent = selected?.parentId; parent && ancestors.length < DOC_MAX_DEPTH;) {
          ancestors.unshift(parent);
          parent = list.find(node => node.id === parent)?.parentId;
        }
        setExpanded(new Set(remembered.current ? remembered.current.expanded.filter(id => ids.has(id)) : ancestors));
        setActiveId(remembered.current?.activeId && ids.has(remembered.current.activeId) ? remembered.current.activeId : selected?.id ?? null);
        if (selected?.resourceKey) setInitialOpen(selected.resourceKey);
      } else setExpanded(current => new Set([...current].filter(id => ids.has(id))));
    } catch (failure) {
      if (seq !== treeSeq.current || !alive.current) return;
      setStatus("error");
      setErrorMessage(isForbidden(failure) ? "没有权限" : undefined);
    }
  }, []);

  useEffect(() => { alive.current = true; return () => { alive.current = false; ++treeSeq.current; ++detailSeq.current; }; }, []);
  useEffect(() => { void loadTree(); }, [loadTree, refreshNonce]);
  useEffect(() => { onWriteLockChange?.(navigationLocked); }, [navigationLocked, onWriteLockChange]);
  useEffect(() => { onDirtyChange(dirtyRef.current || navigationLocked); }, [navigationLocked, onDirtyChange]);
  useEffect(() => () => { onWriteLockChange?.(false); onDirtyChange(false); }, [onWriteLockChange, onDirtyChange]);

  const dirty = useCallback((value: boolean) => { dirtyRef.current = value; onDirtyChange(value); }, [onDirtyChange]);
  const reportPublishing = useCallback((value: boolean) => { publishFlowRef.current = value; setPublishFlow(value); }, []);

  const helpActionError = (failure: unknown, fallback: string): string =>
    isConflict(failure) ? "目录已更新，请核对后重试。" : isForbidden(failure) ? "没有权限。" : isSlugRetired(failure) ? "此文章地址已被使用，请换一个。" : fallback;

  const openResource = useCallback(async (key: string) => {
    const seq = ++detailSeq.current;
    setOpenKey(key); setDetail(null); setDetailLoading(true); setDetailError(undefined); setFeedbackKey(null); setReadBackConflict(false);
    writer.clearConflict();
    try {
      const value = await withEditorSource(await adminRequest<ResourceDetail>(resourcePath(key)));
      if (seq !== detailSeq.current || !alive.current) return;
      setDetail(value);
      setEditorGeneration(current => current + 1);
    } catch (failure) {
      if (seq !== detailSeq.current || !alive.current) return;
      setDetailError(friendlyError(failure));
    } finally {
      if (seq === detailSeq.current && alive.current) setDetailLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (initialOpen) { setInitialOpen(null); void openResource(initialOpen); } }, [initialOpen, openResource]);
  useEffect(() => {
    if (status !== "ready" || initialOpen || !initializedTree.current) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ openKey, activeId, expanded: [...expanded] })); } catch { /* Navigation remains usable without storage. */ }
  }, [status, initialOpen, storageKey, openKey, activeId, expanded]);

  const navigate = (key: string | null) => {
    setDirectoryOpen(false);
    dirty(false);
    if (key !== null) { void openResource(key); return; }
    ++detailSeq.current;
    setOpenKey(null); setDetail(null); setDetailError(undefined); setDetailLoading(false);
  };

  const requestNavigation = (key: string | null, reload = false) => {
    if (locked || flowRef.current || publishFlowRef.current) return;
    if (!reload && key === openKey) { setDirectoryOpen(false); return; }
    if (dirtyRef.current) { setPendingNavigation({ key }); return; }
    navigate(key);
  };

  const openArticle = (node: HelpTreeNode) => {
    if (!node.resourceKey) { setActionError("无法打开此文章，请刷新目录后重试。"); return; }
    requestNavigation(node.resourceKey);
  };

  const accept = (value: ResourceDetail, reset: boolean) => {
    if (!alive.current) return;
    setDetail(value);
    const title = value.draft?.payload?.title ?? value.published?.payload?.title ?? value.current.payload?.title;
    setNodes(current => current.map(node => node.resourceKey === value.key
      ? { ...node, title: title ?? node.title, published: Boolean(value.published), hasDraft: Boolean(value.draft) }
      : node));
    if (reset) { setEditorGeneration(current => current + 1); dirty(false); }
  };

  const write = async (operation: ContentOperation, body: Record<string, unknown>) => {
    const publishing = operation === "content.resource.publish" || operation === "content.resource.withdraw";
    if (!detail || locked || flowRef.current || (publishing ? !canPublish : !canManage)) return;
    const key = detail.key, seq = detailSeq.current; let current = detail;
    setFeedbackKey(key);
    const flow = ++flowSeq.current; flowRef.current = flow; setFlowBusy(true);
    try {
      if (operation === "content.resource.draft.save" || operation === "content.resource.media-draft.save") {
        if (!current.draft) {
          const created = await writer.write(key, "content.resource.draft.create", {});
          if (!created || !alive.current || seq !== detailSeq.current) return;
          current = created;
          accept(created, false);
        }
        if (!current.draft || !current.item) return;
        body = { ...body, versionId: current.draft.id, expectedRevision: current.item.revision };
      }
      const result = await writer.write(key, operation, body);
      // 与规则手册同一契约：draft.save 不重挂载编辑器（避免保存闪烁），由编辑器就地推进基线；
      // 其它操作（建草稿/发布/撤回/恢复）重置工作副本。
      if (result && alive.current && seq === detailSeq.current) {
        if (operation === "content.resource.draft.create") focusEditorKey.current = key;
        accept(result, operation !== "content.resource.draft.save");
        return result;
      }
    } finally { if (flowRef.current === flow) { flowRef.current = null; if (alive.current) setFlowBusy(false); } }
  };

  const recover = async () => {
    const original = writer.pending;
    if (original) setFeedbackKey(original.resourceId);
    const result = await writer.recover();
    if (!result || !original) return;
    if (openKey !== original.resourceId) { void loadTree(); return; }
    const keepLocalEdits = original.operation === "content.resource.draft.save" && dirtyRef.current;
    if (keepLocalEdits && (!original.expectedRevision
      || result.item?.revision !== String(BigInt(original.expectedRevision) + 1n)
      || result.draft?.id !== original.versionId)) {
      setReadBackConflict(true);
      return;
    }
    accept(result, !keepLocalEdits && original.operation !== "content.resource.draft.create");
  };

  const relatedOptions = useMemo(() => nodes
    .filter((node) => node.kind === "ARTICLE" && node.resourceKey?.startsWith("guide:"))
    .map((node) => ({ slug: node.resourceKey!.slice("guide:".length), title: displayTitle(node) })), [nodes]);

  /* ---- 树写操作 ---- */

  const moveNode = async (id: string, parentId: string | null, afterId: string | null) => {
    if (navigationLocked || publishFlowRef.current) return;
    setActionError(null);
    const node = byId.get(id);
    if (!node) return;
    try {
      await moveHelpNode(id, { expectedRevision: node.revision, parentId, afterId });
      if (parentId) setExpanded(current => new Set([...current, parentId]));
      setNotice("已更新目录位置。");
      void loadTree();
    } catch (failure) {
      setActionError(helpActionError(failure, "移动未完成，请核对目录位置后重试。"));
      void loadTree();
    }
  };

  const affectsOnline = (id: string) => nodes.some(node => {
    if (node.kind !== "ARTICLE" || node.published === false) return false;
    for (let current: HelpTreeNode | undefined = node; current; current = current.parentId ? byId.get(current.parentId) : undefined) if (current.id === id) return true;
    return false;
  });
  const requestMove = (id: string, parentId: string | null, afterId: string | null) => {
    if (affectsOnline(id)) setConfirmMove({ id, parentId, afterId });
    else void moveNode(id, parentId, afterId);
  };

  const beginCreate = (kind: "FOLDER" | "ARTICLE", parentId: string | null = null) => {
    setCreate({ kind, parentId }); setCreateTitle(""); setCreateSlug(""); setCreateIcon(""); setCreateError(null);
    createRequest.current = null;
  };

  const beginRename = (node: HelpTreeNode) => {
    setRename(node); setRenameTitle(displayTitle(node)); setRenameIcon(node.iconKey ?? ""); setRenameError(null);
  };

  const submitCreate = async () => {
    if (busy || navigationLocked || !create) return;
    const title = createTitle.trim();
    const max = create.kind === "FOLDER" ? 40 : 200;
    if (!title || [...title].length > max) { setCreateError(`标题需 1–${max} 字。`); return; }
    setBusy(true);
    setCreateError(null);
    const { kind, parentId } = create;
    const folderBody = { parentId, title, ...(parentId === null && createIcon ? { iconKey: createIcon } : {}) };
    const articleBody = { parentId, title, ...(createSlug.trim() ? { slug: createSlug.trim() } : {}) };
    const fingerprint = JSON.stringify([kind, kind === "FOLDER" ? folderBody : articleBody]);
    const key = createRequest.current?.fingerprint === fingerprint ? createRequest.current.key : newWriteKey();
    createRequest.current = { fingerprint, key };
    try {
      const result = kind === "FOLDER" ? await createHelpFolder(folderBody, key) : await createHelpArticle(articleBody, key);
      setCreate(null);
      setSearch("");
      if (parentId) setExpanded(current => new Set([...current, parentId]));
      setNotice(kind === "FOLDER" ? "已新建分组。" : "已新建文章草稿。");
      void loadTree();
      if (kind === "ARTICLE" && result.node) {
        focusEditorKey.current = result.node.resourceKey ?? null;
        openArticle(result.node);
      }
    } catch (failure) {
      setCreateError(helpActionError(failure, "创建未完成。可保留填写内容并重试。"));
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    if (busy || navigationLocked || !rename) return;
    const title = renameTitle.trim();
    const max = rename.kind === "FOLDER" ? 40 : 200;
    if (!title || [...title].length > max) { setRenameError(`标题需 1–${max} 字。`); return; }
    setBusy(true);
    setRenameError(null);
    try {
      await renameHelpNode(rename.id, { expectedRevision: rename.revision, title, ...(rename.parentId === null ? { iconKey: renameIcon || null } : {}) });
      setRename(null);
      setNotice("已保存分组。");
      void loadTree();
    } catch (failure) {
      setRenameError(helpActionError(failure, "重命名未完成，请刷新后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (busy || navigationLocked || !deleteTarget) return;
    let removesOpen = false;
    for (let node = openNode; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
      if (node.id === deleteTarget.id) { removesOpen = true; break; }
    }
    if (removesOpen && (dirtyRef.current || locked || flowRef.current)) {
      setDeleteTarget(null);
      setActionError("请先处理当前文章的未保存修改，再删除。");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await deleteHelpNode(deleteTarget.id, { expectedRevision: deleteTarget.revision });
      setDeleteTarget(null);
      if (removesOpen) navigate(null);
      setNotice(`已将 ${result.deletedCount} 项移到回收站。`);
      void loadTree();
    } catch (failure) {
      setActionError(helpActionError(failure, "删除未完成，请刷新后重试。"));
      setDeleteTarget(null);
      void loadTree();
    } finally {
      setBusy(false);
    }
  };

  const createParentOptions = useMemo(() => [
    { value: "", label: "帮助目录顶层" },
    ...nodes.filter((node) => node.kind === "FOLDER" && node.depth < DOC_MAX_DEPTH).map((node) => ({ value: node.id, label: `${" ".repeat(node.depth - 1)}${displayTitle(node)}` })),
  ], [nodes]);

  const openMoveDialog = (id: string) => { setMoveId(id); setMoveParent(byId.get(id)?.parentId ?? ""); setMoveAfter(""); };

  const moveParentOptions = useMemo(() => {
    if (!moveId) return [];
    const candidates = nodes.filter((node) => node.id !== moveId && node.kind === "FOLDER" && canMoveDoc(moveId, node.id, byId));
    return [
      { value: "", label: "帮助目录顶层" },
      ...candidates.map((node) => ({ value: node.id, label: `${" ".repeat(node.depth - 1)}${displayTitle(node)}` })),
    ];
  }, [moveId, nodes, byId]);

  const siblingsOf = (parentId: string | null) => nodes.filter((node) => node.parentId === parentId).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const movePositionOptions = useMemo(() => {
    const parentId = moveParent || null;
    const children = siblingsOf(parentId).filter((node) => node.id !== moveId);
    return [{ value: "", label: "排在最前" }, ...children.map((node) => ({ value: node.id, label: `在「${displayTitle(node)}」之后` }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveParent, moveId, nodes]);

  /* ---- 树渲染 / 键盘 / 拖拽 ---- */

  const flatVisible = useMemo(() => flattenDocTree(roots, treeExpanded).map(node => node.id), [roots, treeExpanded]);
  const focusId = activeId !== null && flatVisible.includes(activeId) ? activeId : flatVisible[0];

  const focusRow = useCallback((id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "treeitem" || !focusId) return;
    const index = flatVisible.indexOf(focusId);
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? flatVisible.length - 1
        : Math.max(0, Math.min(flatVisible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      focusRow(flatVisible[next]!);
      return;
    }
    const node = byId.get(focusId);
    if (!node) return;
    const firstChild = siblingsOf(node.id).find(child => visibleNodes.includes(child));
    if (event.key === "ArrowRight" && firstChild) {
      event.preventDefault();
      if (treeExpanded.has(node.id)) focusRow(firstChild.id);
      else toggleExpanded(node.id);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (firstChild && treeExpanded.has(node.id) && !query) toggleExpanded(node.id);
      else if (node.parentId) focusRow(node.parentId);
    }
  };

  const dropTarget = (target: HelpTreeNode, zone: DropZone): { parentId: string | null; afterId: string | null } | null => {
    if (!dragId || dragId === target.id) return null;
    if (zone === "inside") {
      // ARTICLE 不能有子节点；服务端仍是最终边界。
      if (target.kind !== "FOLDER") return null;
      if (!canMoveDoc(dragId, target.id, byId)) return null;
      const children = siblingsOf(target.id).filter((node) => node.id !== dragId);
      return { parentId: target.id, afterId: children[children.length - 1]?.id ?? null };
    }
    if (!canMoveDoc(dragId, target.parentId, byId)) return null;
    const siblings = siblingsOf(target.parentId).filter((node) => node.id !== dragId);
    const index = siblings.findIndex((node) => node.id === target.id);
    if (index < 0) return null;
    return zone === "before"
      ? { parentId: target.parentId, afterId: siblings[index - 1]?.id ?? null }
      : { parentId: target.parentId, afterId: target.id };
  };

  const onRowDragOver = (event: DragEvent<HTMLDivElement>, target: HelpTreeNode) => {
    if (!dragId || !canManage) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    const zone: DropZone = ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
    if (dropTarget(target, zone)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropHint({ id: target.id, zone });
    } else {
      setDropHint(null);
    }
  };

  const onRowDrop = (event: DragEvent<HTMLDivElement>, target: HelpTreeNode) => {
    event.preventDefault();
    const hint = dropHint;
    setDragId(null);
    setDropHint(null);
    if (!dragId || !hint || hint.id !== target.id) return;
    const destination = dropTarget(target, hint.zone);
    if (!destination) { setNotice("无法移动到该位置：超出三层或目标是其子节点。"); return; }
    requestMove(dragId, destination.parentId, destination.afterId);
  };

  const setRowRef = (id: string) => (element: HTMLElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  };

  const rowShared = {
    siblingsOf, visibleNodes, treeExpanded, dropHint, focusId, openKey, selectedFolder,
    canManage, query, navigationLocked, setActiveId, openArticle, toggleExpanded, setDragId, setDropHint,
    onRowDragOver, onRowDrop, setRowRef, beginCreate, beginRename, requestMove, openMoveDialog, setActionError, setDeleteTarget,
  };

  return (
    <div className="content-management help-workspace">
      <div className="help-workspace-grid" data-article-open={Boolean(openKey)} data-directory-open={directoryOpen}>
        <aside className="help-directory" aria-label="帮助目录">
          <header className="help-directory-header">
            <h2>帮助目录</h2>
            {canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button type="button" size="sm" variant="secondary" disabled={navigationLocked} />}><Plus size={14} aria-hidden="true" />新建</DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => beginCreate("FOLDER")}>新建分组</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => beginCreate("ARTICLE", selectedFolder)}>新建文章</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : <span className="help-tree-status">只读</span>}
            {openKey ? (
              <Button type="button" size="icon-sm" variant="ghost" className="help-directory-toggle" aria-label={directoryOpen ? "收起目录" : "展开目录"} aria-expanded={directoryOpen} onClick={() => setDirectoryOpen(value => !value)}>
                {directoryOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              </Button>
            ) : null}
          </header>
          <div className="help-directory-content">
            <div className="help-directory-search">
              <div className="docs-tree-search">
                <Search size={14} aria-hidden="true" />
                <Input aria-label="搜索帮助文章" placeholder="搜索文章" type="search" value={search} onChange={event => setSearch(event.target.value)} />
              </div>
            </div>
            <FloatingStatusMessage error={actionError ?? undefined} success={notice ?? undefined} />
            <div className="docs-tree-scroll help-directory-tree">
              {status === "loading" && nodes.length === 0 ? (
                <div className="docs-tree-skeleton" role="status" aria-label="帮助目录加载中">
                  {[70, 55, 62, 48].map((width, index) => <Skeleton key={index} className="docs-tree-skeleton-row" style={{ width: `${width}%` }} />)}
                </div>
              ) : status === "error" ? (
                <div className="docs-tree-empty" role="alert">
                  <p>{errorMessage || "帮助目录暂时无法读取。"}</p>
                  <Button type="button" size="xs" variant="secondary" onClick={() => void loadTree()}>重试</Button>
                </div>
              ) : visibleNodes.length === 0 ? (
                <div className="docs-tree-empty"><p>{query ? "没有找到匹配的文章。" : "帮助目录还是空的。"}</p></div>
              ) : (
                <div role="tree" aria-label="帮助中心目录" className="docs-tree" onKeyDown={onTreeKeyDown}>
                  {roots.map(root => <HelpTreeRow key={root.node.id} {...rowShared} node={root.node as HelpTreeNode} />)}
                </div>
              )}
            </div>
            <footer className="help-directory-footer">
              {canViewHistory ? <Button type="button" size="sm" variant="ghost" disabled={navigationLocked} onClick={() => setTrashOpen(true)}><Trash2 size={14} aria-hidden="true" />回收站</Button> : null}
              <Button type="button" size="icon-sm" variant="ghost" aria-label="刷新目录" title="刷新目录" disabled={navigationLocked} loading={status === "loading"} onClick={() => void loadTree()}><RefreshCw size={14} aria-hidden="true" /></Button>
            </footer>
          </div>
        </aside>
        <section className="help-writing-pane" aria-label="帮助文章">
          {!detail && pendingWrite && !writer.busy ? (
            <div className="help-writing-state">
              <h3>有待核对的内容操作</h3>
              <StatusMessage error={writer.error} />
              <Button type="button" variant="secondary" loading={writer.busy} disabled={writer.blocked} onClick={() => void recover()}>核对原操作结果</Button>
            </div>
          ) : null}
          {openKey && detailLoading && !detail ? (
            <div className="help-writing-state" role="status" aria-label="读取文章正文">
              <Skeleton className="h-7 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" />
            </div>
          ) : null}
          {detailError && openKey && !detail ? (
            <div className="help-writing-state">
              <StatusMessage error={`文章读取失败：${detailError}`} />
              <Button type="button" size="sm" variant="secondary" onClick={() => void openResource(openKey)}>重试</Button>
            </div>
          ) : null}
          {!openKey && !pendingWrite ? (
            <div className="help-writing-empty"><FileText size={23} aria-hidden="true" /><p>从目录选择一篇文章</p></div>
          ) : null}
          {detail ? (
            <Suspense fallback={<div className="help-writing-state" role="status" aria-label="编辑器加载中"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-4 w-full" /></div>}>
              <DocumentEditor
                key={`${detail.key}:${editorGeneration}`}
                detail={detail}
                canEdit={canManage}
                canPublish={canPublish}
                locked={locked}
                busy={writer.busy || flowBusy}
                pending={pendingWrite}
                pendingPublish={writer.blocked || (writer.pending?.resourceId === detail.key && writer.pending.operation !== "content.resource.draft.save")}
                operationError={canWrite && (feedbackKey === detail.key || writer.blocked) ? writer.error : undefined}
                success={feedbackKey === detail.key ? writer.success : undefined}
                conflict={readBackConflict || (feedbackKey === detail.key && writer.conflict)}
                onReload={() => requestNavigation(detail.key, true)}
                onRecover={pendingWrite && !writer.blocked ? () => void recover() : undefined}
                onWrite={write}
                canUpload={canManage}
                canReview={canReviewMedia}
                relatedOptions={relatedOptions}
                canBrowseMedia
                onClose={() => requestNavigation(null)}
                onDirtyChange={dirty}
                onEditorMount={focusCreatedArticle}
                onPublishProgress={reportPublishing}
                helpDirectoryLabel={folderPath.join(" / ") || "帮助目录"}
                publicUrl={publicOrigin && detail.published && openNode?.resourceKey?.startsWith("guide:") ? new URL(`/help/${encodeURIComponent(openNode.resourceKey.slice(6))}`, publicOrigin).href : undefined}
                canViewHistory={canViewHistory}
              />
            </Suspense>
          ) : null}
        </section>
      </div>
      <HelpWorkspaceDialogs
        pendingNavigation={pendingNavigation}
        setPendingNavigation={setPendingNavigation}
        locked={locked}
        flowRef={flowRef}
        navigate={navigate}
        trashOpen={trashOpen}
        setTrashOpen={setTrashOpen}
        canViewHistory={canViewHistory}
        canPublish={canPublish}
        refreshNonce={refreshNonce}
        loadTree={() => void loadTree()}
        create={create}
        setCreate={setCreate}
        busy={busy}
        createTitle={createTitle}
        setCreateTitle={setCreateTitle}
        createSlug={createSlug}
        setCreateSlug={setCreateSlug}
        submitCreate={() => void submitCreate()}
        createParentOptions={createParentOptions}
        createIcon={createIcon}
        setCreateIcon={setCreateIcon}
        createError={createError}
        rename={rename}
        setRename={setRename}
        renameTitle={renameTitle}
        setRenameTitle={setRenameTitle}
        submitRename={() => void submitRename()}
        renameIcon={renameIcon}
        setRenameIcon={setRenameIcon}
        renameError={renameError}
        moveId={moveId}
        setMoveId={setMoveId}
        byId={byId}
        affectsOnline={affectsOnline}
        moveParent={moveParent}
        setMoveParent={setMoveParent}
        moveParentOptions={moveParentOptions}
        moveAfter={moveAfter}
        setMoveAfter={setMoveAfter}
        movePositionOptions={movePositionOptions}
        moveNode={(id, parentId, afterId) => void moveNode(id, parentId, afterId)}
        confirmMove={confirmMove}
        setConfirmMove={setConfirmMove}
        deleteTarget={deleteTarget}
        setDeleteTarget={setDeleteTarget}
        confirmDelete={() => void confirmDelete()}
      />
    </div>
  );
}

