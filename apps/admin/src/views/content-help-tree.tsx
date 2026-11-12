import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArchiveRestore, BookOpen, ChevronDown, ChevronRight, Coins, FileText, Folder, Headphones, KeyRound, Megaphone, MoreHorizontal, Plus, RefreshCw, ScrollText, Search, Shield, Store, Ticket, Trash2 } from "lucide-react";
import { adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FloatingStatusMessage, StatusMessage } from "../components/ui-elements";
import type { PlateEditorHandle } from "../components/plate/plate-editor";
import {
  createHelpArticle, createHelpFolder, deleteHelpNode, fetchHelpTrash, fetchHelpTree, helpArticleStateLabel,
  isConflict, isForbidden, isSlugRetired, moveHelpNode, renameHelpNode, restoreHelpTrash,
  type HelpTrashItem, type HelpTreeNode,
} from "./docs/docs-help-api";
import { DOC_MAX_DEPTH, buildDocTree, canMoveDoc, docTime, flattenDocTree, newWriteKey, purgeDaysLeft } from "./docs/docs-model";
import { resourcePath, type ContentOperation, type ResourceDetail } from "./content-resources-model";
import { useContentResourceWrite } from "./content-resource-write";
import "./docs/docs.css";
import "./content-management.css";
import "./content-help-workspace.css";

const DocumentEditor = lazy(() => import("./content-resource-editor").then(module => ({ default: module.ContentResourceEditor })));

type DropZone = "before" | "inside" | "after";
const groupIcons = {
  folder: { label: "文件夹", Icon: Folder },
  rental: { label: "租用", Icon: Ticket },
  publish: { label: "出租", Icon: Store },
  fees: { label: "费用", Icon: Coins },
  account: { label: "账号", Icon: KeyRound },
  "after-sale": { label: "客服", Icon: Headphones },
  membership: { label: "动态", Icon: Megaphone },
  agreement: { label: "协议", Icon: ScrollText },
  book: { label: "手册", Icon: BookOpen },
  shield: { label: "安全", Icon: Shield },
};
const groupIconOptions = [{ value: "", label: "默认图标" }, ...Object.entries(groupIcons).map(([value, { label }]) => ({ value, label }))];

function groupIcon(key: string | null | undefined) {
  return key && Object.hasOwn(groupIcons, key) ? groupIcons[key as keyof typeof groupIcons].Icon : Folder;
}

function HelpIconSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <label className="docs-move-field">
      <span>分组图标</span>
      <Select value={value} items={groupIconOptions} onValueChange={next => onChange(next ?? "")} disabled={disabled}>
        <SelectTrigger aria-label="分组图标"><SelectValue /></SelectTrigger>
        <SelectContent>{groupIconOptions.map(option => {
          const Icon = groupIcon(option.value);
          return <SelectItem key={option.value} value={option.value}><Icon size={15} aria-hidden="true" />{option.label}</SelectItem>;
        })}</SelectContent>
      </Select>
    </label>
  );
}

const displayTitle = (node: HelpTreeNode): string => node.title || node.resourceKey?.slice("guide:".length) || "未命名文章";

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

  const renderRow = (node: HelpTreeNode) => {
    const children = siblingsOf(node.id).filter(child => visibleNodes.includes(child));
    const isExpanded = treeExpanded.has(node.id);
    const hint = dropHint?.id === node.id ? dropHint.zone : undefined;
    const title = displayTitle(node);
    const badge = (node as HelpTreeNode & { withdrawn?: boolean }).withdrawn && !node.published && !node.hasDraft ? "已下线" : helpArticleStateLabel(node);
    const Icon = node.kind === "FOLDER" ? groupIcon(node.iconKey ?? node.id) : FileText;
    const siblings = siblingsOf(node.parentId), index = siblings.findIndex(item => item.id === node.id);
    const openRow = () => { setActiveId(node.id); if (node.kind === "ARTICLE") openArticle(node); else if (!query) toggleExpanded(node.id); };
    return (
      <div key={node.id} role="none">
        <div
          ref={setRowRef(node.id)}
          role="treeitem"
          aria-level={node.depth}
          aria-expanded={children.length ? isExpanded : undefined}
          aria-selected={node.kind === "ARTICLE" ? node.resourceKey === openKey : undefined}
          tabIndex={focusId === node.id ? 0 : -1}
          data-help-id={node.id}
          data-current-group={node.kind === "FOLDER" && selectedFolder === node.id || undefined}
          data-drop={hint}
          className="docs-tree-row"
          draggable={canManage && !query && !navigationLocked}
          onFocus={() => setActiveId(node.id)}
          onClick={openRow}
          onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openRow(); } }}
          onDragStart={(event) => { if (!canManage || query) return; setDragId(node.id); event.dataTransfer.setData("text/plain", node.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
          onDragOver={(event) => onRowDragOver(event, node)}
          onDragLeave={() => setDropHint((current) => (current?.id === node.id ? null : current))}
          onDrop={(event) => onRowDrop(event, node)}
          style={{ paddingLeft: `${0.45 + (node.depth - 1) * 0.7}rem` }}
        >
          {children.length ? (
            <button
              type="button"
              className="docs-tree-twisty"
              aria-label={isExpanded ? `折叠「${title}」` : `展开「${title}」`}
              tabIndex={-1}
              onClick={(event) => { event.stopPropagation(); if (!query) toggleExpanded(node.id); }}
            >
              {isExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            </button>
          ) : <span className="docs-tree-twisty" aria-hidden="true" />}
          <Icon size={14} aria-hidden="true" className="docs-tree-icon" />
          <span className="docs-tree-title" title={title}>{title}</span>
          {badge ? <span className="help-tree-status" title={badge}>{badge === "有未发布修改" ? "待发布" : badge === "未发布" && node.hasDraft ? "草稿" : badge}</span> : null}
          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="docs-tree-menu" disabled={navigationLocked} tabIndex={focusId === node.id ? 0 : -1} aria-label={`「${title}」操作`} onClick={(event) => event.stopPropagation()}>
                <MoreHorizontal size={14} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
                {node.kind === "FOLDER" && node.depth < DOC_MAX_DEPTH ? <DropdownMenuItem onClick={() => beginCreate("FOLDER", node.id)}>新建子分组</DropdownMenuItem> : null}
                {node.kind === "FOLDER" && node.depth < DOC_MAX_DEPTH ? <DropdownMenuItem onClick={() => beginCreate("ARTICLE", node.id)}>新建文章</DropdownMenuItem> : null}
                {node.kind === "FOLDER" ? <DropdownMenuItem onClick={() => beginRename(node)}>编辑分组</DropdownMenuItem> : <DropdownMenuItem onClick={() => openArticle(node)}>编辑文章</DropdownMenuItem>}
                <DropdownMenuItem disabled={index <= 0 || Boolean(query)} onClick={() => requestMove(node.id, node.parentId, siblings[index - 2]?.id ?? null)}>上移</DropdownMenuItem>
                <DropdownMenuItem disabled={index < 0 || index === siblings.length - 1 || Boolean(query)} onClick={() => requestMove(node.id, node.parentId, siblings[index + 1]!.id)}>下移</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openMoveDialog(node.id)}>移动到…</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => { setActionError(null); setDeleteTarget(node); }}>删除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {children.length && isExpanded ? <div role="group">{children.map(child => renderRow(child))}</div> : null}
      </div>
    );
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
                  {roots.map(root => renderRow(root.node as HelpTreeNode))}
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
      <Dialog open={pendingNavigation !== null} onOpenChange={open => { if (!open) setPendingNavigation(null); }}>
        <DialogContent role="alertdialog">
          <DialogTitle>放弃未保存的修改？</DialogTitle>
          <DialogDescription>继续后，当前文章中尚未保存的修改会丢失。</DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus onClick={() => setPendingNavigation(null)}>继续编辑</Button>
            <Button type="button" variant="danger" disabled={locked} onClick={() => {
              if (!pendingNavigation || locked || flowRef.current) return;
              navigate(pendingNavigation.key);
              setPendingNavigation(null);
            }}>放弃修改并继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent className="max-w-3xl max-h-[85dvh] overflow-y-auto">
          <DialogTitle>帮助回收站</DialogTitle>
          <DialogDescription>条目保留 30 天，恢复后回到删除前的状态。</DialogDescription>
          {trashOpen && canViewHistory ? <HelpTrashPanel canRestore={canPublish} refreshNonce={refreshNonce} onRestored={() => void loadTree()} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={create !== null} onOpenChange={(open) => { if (!open && !busy) setCreate(null); }}>
        <DialogContent>
          <DialogTitle>{create?.kind === "ARTICLE" ? "新建帮助文章" : "新建帮助分组"}</DialogTitle>
          <DialogDescription>{create?.kind === "ARTICLE" ? "文章先保存为草稿，发布后对用户可见。" : "目录最多三层，含有已发布文章的分组会显示在用户侧。"}</DialogDescription>
          <Field label="标题">
            <Input value={createTitle} maxLength={create?.kind === "FOLDER" ? 40 : 200} autoFocus disabled={busy} onChange={(event) => setCreateTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitCreate(); } }} />
          </Field>
          {create?.kind === "ARTICLE" ? <Field label="文章地址（可选）" hint="留空自动生成。发布后可使用此地址打开文章。">
            <Input value={createSlug} maxLength={120} disabled={busy} placeholder="例如 rental-getting-started" onChange={(event) => setCreateSlug(event.target.value)} />
          </Field> : null}
          <label className="docs-move-field">
            <span>父目录</span>
            <Select value={create?.parentId ?? ""} items={createParentOptions} onValueChange={(value) => setCreate((current) => current ? { ...current, parentId: value === null || value === "" ? null : String(value) } : current)} disabled={busy}>
              <SelectTrigger aria-label="父目录"><SelectValue /></SelectTrigger>
              <SelectContent>{createParentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {create?.kind === "FOLDER" && create.parentId === null ? <HelpIconSelect value={createIcon} onChange={setCreateIcon} disabled={busy} /> : null}
          {createError ? <p className="docs-inline-error" role="alert">{createError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setCreate(null)}>取消</Button>
            <Button type="button" loading={busy} onClick={() => void submitCreate()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rename !== null} onOpenChange={(open) => { if (!open && !busy) setRename(null); }}>
        <DialogContent>
          <DialogTitle>编辑分组</DialogTitle>
          <DialogDescription>分组设置保存后即时生效。</DialogDescription>
          <Field label="标题">
            <Input value={renameTitle} maxLength={rename?.kind === "FOLDER" ? 40 : 200} autoFocus disabled={busy} onChange={(event) => setRenameTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitRename(); } }} />
          </Field>
          {rename?.parentId === null ? <HelpIconSelect value={renameIcon} onChange={setRenameIcon} disabled={busy} /> : null}
          {renameError ? <p className="docs-inline-error" role="alert">{renameError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRename(null)}>取消</Button>
            <Button type="button" loading={busy} onClick={() => void submitRename()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveId !== null} onOpenChange={(open) => { if (!open) setMoveId(null); }}>
        <DialogContent>
          <DialogTitle>移动到…</DialogTitle>
          <DialogDescription>将「{moveId && byId.get(moveId) ? displayTitle(byId.get(moveId)!) : "该条目"}」移动到指定分组和位置。{moveId && affectsOnline(moveId) ? "线上目录立即更新，文章地址保持不变。" : ""}</DialogDescription>
          <div className="docs-move-fields">
            <label className="docs-move-field">
              <span>目标目录</span>
              <Select value={moveParent} items={moveParentOptions} onValueChange={(value) => { setMoveParent(value === null ? "" : String(value)); setMoveAfter(""); }}>
                <SelectTrigger aria-label="目标目录"><SelectValue /></SelectTrigger>
                <SelectContent>{moveParentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="docs-move-field">
              <span>插入位置</span>
              <Select value={moveAfter} items={movePositionOptions} onValueChange={(value) => setMoveAfter(value === null ? "" : String(value))}>
                <SelectTrigger aria-label="插入位置"><SelectValue /></SelectTrigger>
                <SelectContent>{movePositionOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setMoveId(null)}>取消</Button>
            <Button type="button" disabled={!moveId || !byId.has(moveId) || Boolean(moveParent && !byId.has(moveParent)) || Boolean(moveAfter && !byId.has(moveAfter))} onClick={() => { if (!moveId) return; void moveNode(moveId, moveParent || null, moveAfter || null); setMoveId(null); }}>移动</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmMove !== null} onOpenChange={open => { if (!open) setConfirmMove(null); }}>
        <DialogContent role="alertdialog">
          <DialogTitle>确认调整目录位置？</DialogTitle>
          <DialogDescription>将「{confirmMove && byId.get(confirmMove.id) ? displayTitle(byId.get(confirmMove.id)!) : "该条目"}」放到「{confirmMove?.parentId ? byId.get(confirmMove.parentId) ? displayTitle(byId.get(confirmMove.parentId)!) : "目标分组已变化" : "帮助目录顶层"}」{confirmMove?.afterId ? `中「${byId.get(confirmMove.afterId) ? displayTitle(byId.get(confirmMove.afterId)!) : "目标位置已变化"}」之后` : "最前面"}。线上目录立即更新，文章地址保持不变。</DialogDescription>
          <DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setConfirmMove(null)}>取消</Button><Button type="button" disabled={!confirmMove || !byId.has(confirmMove.id) || Boolean(confirmMove.parentId && !byId.has(confirmMove.parentId)) || Boolean(confirmMove.afterId && !byId.has(confirmMove.afterId))} onClick={() => { if (confirmMove) void moveNode(confirmMove.id, confirmMove.parentId, confirmMove.afterId); setConfirmMove(null); }}>确认移动</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
        <DialogContent role="alertdialog">
          <DialogTitle>删除「{deleteTarget ? displayTitle(deleteTarget) : ""}」？</DialogTitle>
          <DialogDescription>
            {deleteTarget?.kind === "ARTICLE" ? "文章将下线并移到回收站，保留 30 天。" : "分组及其中的文章会移到回收站，保留 30 天。已发布的文章会同时下线。"}
            {typeof deleteTarget?.referenceCount === "number" && deleteTarget.referenceCount > 0 ? ` 有 ${deleteTarget.referenceCount} 处引用（其他文章关联、正文链接、页脚或动态），删除后这些链接会失效。` : ""}
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus disabled={busy} onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button type="button" variant="danger" loading={busy} onClick={() => void confirmDelete()}>删除进回收站</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 帮助中心回收站（从内部文档库迁入）：批次保留 30 天；恢复回到删除前状态，需发布权限。 */
function HelpTrashPanel({ canRestore, refreshNonce, onRestored }: { canRestore: boolean; refreshNonce: number; onRestored: () => void }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; items: HelpTrashItem[]; cursor: string | null; error?: string }>({ status: "loading", items: [], cursor: null });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string | null) => {
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await fetchHelpTrash(cursor);
      setState((current) => ({
        status: "ready",
        items: cursor ? [...current.items, ...(page.items ?? [])] : page.items ?? [],
        cursor: page.nextCursor ?? null,
      }));
    } catch (failure) {
      setState({ status: "error", items: [], cursor: null, error: isForbidden(failure) ? "没有权限" : "回收站暂时无法读取" });
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshNonce]);

  const restore = async (batch: HelpTrashItem) => {
    if (restoring) return;
    setRestoring(batch.batchId);
    setActionError(null);
    setActionSuccess(null);
    try {
      await restoreHelpTrash(batch.batchId);
      setActionSuccess(`已恢复 ${batch.count} 项。`);
      onRestored();
      void load();
    } catch (failure) {
      setActionError(isForbidden(failure) ? "恢复需要帮助发布权限。" : isConflict(failure) ? "别人刚改过，刷新后再改。" : "恢复未完成，请刷新回收站后重试。");
      void load();
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="docs-trash" aria-label="帮助中心回收站">
      <div className="docs-trash-actions">
        <Button type="button" variant="ghost" size="sm" loading={state.status === "loading"} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
      </div>
        <FloatingStatusMessage error={actionError ?? undefined} success={actionSuccess ?? undefined} />
        {state.status === "loading" && state.items.length === 0 ? (
          <div role="status" aria-label="帮助回收站加载中" className="docs-trash-skeleton">
            <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" />
          </div>
        ) : state.status === "error" ? (
          <div role="alert" className="docs-detail-state">
            <StatusMessage error={state.error ?? "回收站暂时无法读取"} />
            <Button type="button" variant="secondary" onClick={() => void load()}>重试</Button>
          </div>
        ) : state.items.length === 0 ? (
          <p className="docs-trash-empty">帮助中心回收站是空的。</p>
        ) : (
          <ul className="docs-trash-list" aria-label="帮助中心回收站批次">
            {state.items.map((batch) => (
              <li key={batch.batchId} className="docs-trash-item" data-help-batch={batch.batchId}>
                <div className="docs-trash-item-main">
                  <span className="docs-trash-item-title">{batch.title ?? "（无标题）"}</span>
                  <span className="docs-trash-item-meta">共 {batch.count} 项 · 删除于 {docTime(batch.deletedAt)} · 操作人 {batch.deletedBy || "—"}</span>
                </div>
                <span className="docs-trash-purge">{purgeDaysLeft(batch.purgeAt)} 天后永久清理</span>
                {canRestore ? (
                  <Button type="button" size="sm" variant="secondary" loading={restoring === batch.batchId} disabled={restoring !== null && restoring !== batch.batchId} onClick={() => void restore(batch)}>
                    <ArchiveRestore size={13} aria-hidden="true" />恢复
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {state.cursor ? <Button type="button" size="sm" variant="secondary" loading={state.status === "loading"} onClick={() => void load(state.cursor)}>加载更多</Button> : null}
    </section>
  );
}
