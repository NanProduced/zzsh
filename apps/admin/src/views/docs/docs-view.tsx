import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NotebookPen, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FloatingStatusMessage, StatusMessage } from "../../components/ui-elements";
import { hasPermission, type SessionSnapshot } from "../../api";
import type { WorkspaceTab } from "../../workspace/tab-model";
import { createDoc, deleteDoc, fetchDoc, fetchDocTree, isConflict, isForbidden, moveDoc } from "./docs-api";
import { DOC_MAX_DEPTH, DOC_TITLE_MAX, docAncestors, docPath, isDescendant, type DocTreeNode } from "./docs-model";
import { DocsTree } from "./docs-tree";
import { DocsDetail } from "./docs-detail";
import { DocsTrash } from "./docs-trash";
import "../../components/plate/plate-editor.css";
import "./docs.css";

export type DocsViewProps = {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  tab: WorkspaceTab;
  refreshNonce: number;
  onOpenPath: (path: string, title?: string, afterOpen?: () => void) => boolean | void;
  onQueryChange: (query: Record<string, string>) => void;
  onDirtyChange: (dirty: boolean) => void;
};

function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 960px)").matches : false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 960px)");
    const listener = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener?.("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }, []);
  return narrow;
}

export function DocsView({ snapshot, tab, refreshNonce, onOpenPath, onDirtyChange }: DocsViewProps) {
  const canRead = snapshot.security.isBoss || hasPermission(snapshot, "docs.internal.read");
  const canManage = snapshot.security.isBoss || hasPermission(snapshot, "docs.internal.manage");
  const canComment = snapshot.security.isBoss || hasPermission(snapshot, "docs.internal.comment");

  const [nodes, setNodes] = useState<DocTreeNode[]>([]);
  const [treeStatus, setTreeStatus] = useState<"loading" | "ready" | "error">("loading");
  const [treeError, setTreeError] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [treeQuery, setTreeQuery] = useState("");
  const [treeExpanded, setTreeExpanded] = useState<Set<string> | null>(null);
  const [treeRootOpen, setTreeRootOpen] = useState(true);
  const lastRevealedId = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const detailDirty = useRef(false);
  const [createParent, setCreateParent] = useState<string | null | undefined>(undefined);
  const [createTitle, setCreateTitle] = useState("");
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocTreeNode | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const treeSeq = useRef(0);
  const narrow = useNarrowScreen();

  const trashActive = tab.kind === "docs" && tab.query.view === "trash";
  const selectedId = tab.kind === "docs-object" ? tab.objectId ?? null : null;
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const reportDirty = useCallback((dirty: boolean) => {
    detailDirty.current = dirty;
    onDirtyChange(dirty);
  }, [onDirtyChange]);
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [selectedId, trashActive]);
  useEffect(() => {
    if (!selectedId) { lastRevealedId.current = null; return; }
    if (lastRevealedId.current === selectedId) return;
    const selected = byId.get(selectedId);
    if (!selected) return;
    lastRevealedId.current = selectedId;
    setTreeRootOpen(true);
    const parents = docAncestors(selected, byId).map((node) => node.id);
    if (parents.length) setTreeExpanded((current) => new Set([...(current ?? []), ...parents]));
  }, [byId, selectedId]);

  const loadTree = useCallback(async () => {
    const seq = ++treeSeq.current;
    setTreeStatus((status) => status === "ready" ? "ready" : "loading");
    setTreeError(undefined);
    try {
      const page = await fetchDocTree();
      if (seq !== treeSeq.current) return;
      setNodes(Array.isArray(page.nodes) ? page.nodes : []);
      setTreeStatus("ready");
    } catch (failure) {
      if (seq !== treeSeq.current) return;
      setTreeStatus("error");
      setTreeError(isForbidden(failure) ? "没有权限" : undefined);
    }
  }, []);

  useEffect(() => { if (canRead) void loadTree(); }, [canRead, loadTree, refreshNonce]);
  const openDoc = useCallback((id: string, title?: string, focusTitle = false) => {
    onOpenPath(docPath(id), title ?? byId.get(id)?.title ?? "文档详情", () => {
      setDrawerOpen(false);
      if (focusTitle) setFocusTitleId(id);
    });
  }, [byId, onOpenPath]);
  const clearTitleFocus = useCallback(() => setFocusTitleId(null), []);

  const openTrash = useCallback(() => {
    onOpenPath("/docs?view=trash", "回收站", () => setDrawerOpen(false));
  }, [onOpenPath]);

  const backToLibrary = useCallback(() => {
    onOpenPath("/docs", "内部文档");
  }, [onOpenPath]);

  const moveNode = useCallback(async (id: string, parentId: string | null, afterId: string | null) => {
    setActionError(null);
    try {
      // 树列表不带 revision：先读详情拿当前 revision，再按合同 move。
      const detail = await fetchDoc(id);
      await moveDoc(id, { expectedRevision: String(detail.revision), parentId, afterId });
      setNotice("已移动。");
      void loadTree();
    } catch (failure) {
      setActionError(isConflict(failure) ? "别人刚改过，刷新后再改。" : isForbidden(failure) ? "没有权限" : "移动未完成：超出三层、成环或目标已删除时服务端会拒绝。请刷新后重试。");
      void loadTree();
    }
  }, [loadTree]);

  const submitCreate = async () => {
    if (creating || createParent === undefined) return;
    const title = createTitle.trim();
    if (!title || [...title].length > DOC_TITLE_MAX) { setCreateError(`标题需 1–${DOC_TITLE_MAX} 字。`); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const detail = await createDoc({ parentId: createParent, title });
      setCreateParent(undefined);
      setCreateTitle("");
      setNotice(`已创建「${title}」。`);
      setNodes((current) => [...current, detail.node]);
      openDoc(detail.node.id, detail.node.title, true);
      void loadTree();
    } catch (failure) {
      setCreateError(isForbidden(failure) ? "没有权限" : "创建未完成，请刷新目录后重试。");
    } finally {
      setCreating(false);
    }
  };

  const confirmTreeDelete = async () => {
    if (!deleteTarget || deleting) return;
    const affectsSelection = selectedId !== null && (selectedId === deleteTarget.id || isDescendant(selectedId, deleteTarget.id, byId));
    if (affectsSelection && detailDirty.current) {
      setDeleteTarget(null);
      setActionError("这组文档包含当前未保存的内容，请先保存或保留本地输入。");
      return;
    }
    setDeleting(true);
    setActionError(null);
    try {
      const detail = await fetchDoc(deleteTarget.id);
      const result = await deleteDoc(deleteTarget.id, { expectedRevision: String(detail.revision) });
      setDeleteTarget(null);
      setNotice(`已删除 ${result.deletedCount} 篇文档，30 天内可在回收站恢复。`);
      void loadTree();
      if (affectsSelection) backToLibrary();
    } catch (failure) {
      setActionError(isConflict(failure) ? "别人刚改过，刷新后再改。" : isForbidden(failure) ? "没有权限" : "删除未完成，请刷新后重试。");
      setDeleteTarget(null);
      void loadTree();
    } finally {
      setDeleting(false);
    }
  };

  const createParentOptions = useMemo(() => [
    { value: "", label: "顶层（内部文档根）" },
    ...nodes.filter((node) => node.depth < DOC_MAX_DEPTH).map((node) => ({ value: node.id, label: `${" ".repeat(node.depth - 1)}${node.title}` })),
  ], [nodes]);

  if (!canRead) {
    return <div className="docs-shell"><section className="section-panel docs-denied" role="alert"><StatusMessage error="没有权限" /><p className="docs-tree-note">请联系管理员授权查看内部文档。</p></section></div>;
  }

  const tree = (
    <DocsTree
      nodes={nodes}
      status={treeStatus}
      errorMessage={treeError}
      canManage={canManage}
      selectedId={selectedId}
      trashActive={trashActive}
      query={treeQuery}
      onSearchChange={setTreeQuery}
      expanded={treeExpanded}
      setExpanded={setTreeExpanded}
      internalOpen={treeRootOpen}
      setInternalOpen={setTreeRootOpen}
      onRetry={() => void loadTree()}
      onOpen={(id) => openDoc(id)}
      onCreate={(parentId) => { setCreateParent(parentId); setCreateTitle(""); setCreateError(null); }}
      onMove={(id, parentId, afterId) => void moveNode(id, parentId, afterId)}
      onDelete={(id) => { const node = byId.get(id); if (node) { setActionError(null); setDeleteTarget(node); } }}
      onOpenTrash={openTrash}
    />
  );

  const showDetail = tab.kind === "docs-object" && Boolean(tab.objectId);
  const center = showDetail ? (
    <DocsDetail
      key={tab.objectId}
      docId={tab.objectId!}
      nodes={nodes}
      canManage={canManage}
      canComment={canComment}
      currentAdminId={snapshot.adminUserId}
      refreshNonce={refreshNonce}
      autoFocusTitle={focusTitleId === tab.objectId}
      onTitleFocused={clearTitleFocus}
      onOpenPath={onOpenPath}
      onDirtyChange={reportDirty}
      onTreeChanged={loadTree}
    />
  ) : trashActive ? (
    <DocsTrash nodes={nodes} canManage={canManage} refreshNonce={refreshNonce} onOpenPath={onOpenPath} onTreeChanged={() => void loadTree()} />
  ) : (
    <div className="docs-welcome">
      <NotebookPen size={28} aria-hidden="true" className="docs-welcome-icon" />
      {treeStatus === "ready" && nodes.length === 0 ? (
        <>
          <h2>还没有内部文档</h2>
          <p className="docs-tree-note">内部文档改完即生效，所有后台账号可读；运营与 BOSS 可编辑。</p>
          {canManage ? <Button type="button" onClick={() => { setCreateParent(null); setCreateTitle(""); setCreateError(null); }}><Plus size={14} aria-hidden="true" />新建文档</Button> : null}
        </>
      ) : (
        <>
          <h2>内部文档库</h2>
          <p className="docs-tree-note">从左侧选择一篇文档开始阅读{canManage ? "或编辑" : ""}。</p>
          {canManage ? <Button type="button" variant="secondary" onClick={() => { setCreateParent(null); setCreateTitle(""); setCreateError(null); }}><Plus size={14} aria-hidden="true" />新建文档</Button> : null}
        </>
      )}
    </div>
  );

  return (
    <div className="docs-shell" data-collapsed={collapsed && !narrow ? "true" : undefined}>
      {narrow ? (
        <>
          <div className="docs-narrow-bar">
            <Button type="button" variant="secondary" size="sm" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
              <PanelLeftOpen size={14} aria-hidden="true" />目录
            </Button>
            <span className="docs-narrow-title">{showDetail ? byId.get(tab.objectId!)?.title ?? "文档" : trashActive ? "回收站" : "内部文档"}</span>
          </div>
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent side="left" className="docs-tree-sheet" closeLabel="关闭目录">
              <SheetHeader><SheetTitle>文档目录</SheetTitle></SheetHeader>
              {tree}
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <aside className="docs-sidebar" aria-label="文档库侧栏">
          <div className="docs-sidebar-head">
            <span className="docs-sidebar-title"><NotebookPen size={15} aria-hidden="true" />文档库</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={collapsed ? "展开目录" : "折叠目录"} aria-expanded={!collapsed} aria-controls="docs-sidebar" onClick={() => setCollapsed((current) => !current)}>
              {collapsed ? <PanelLeftOpen size={15} aria-hidden="true" /> : <PanelLeftClose size={15} aria-hidden="true" />}
            </Button>
          </div>
          <div id="docs-sidebar" className="docs-sidebar-body" hidden={collapsed}>{tree}</div>
        </aside>
      )}

      <main ref={mainRef} className="docs-main" aria-label="文档内容">
        <FloatingStatusMessage error={actionError ?? undefined} success={notice ?? undefined} />
        {center}
      </main>

      <Dialog open={createParent !== undefined} onOpenChange={(open) => { if (!open && !creating) setCreateParent(undefined); }}>
        <DialogContent className="docs-overlay">
          <DialogTitle>新建文档</DialogTitle>
          <DialogDescription>内部文档改完即生效，不走草稿与审批。最多三层。</DialogDescription>
          <Field label="标题">
            <Input value={createTitle} maxLength={DOC_TITLE_MAX} autoFocus disabled={creating} onChange={(event) => setCreateTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void submitCreate(); } }} />
          </Field>
          <label className="docs-move-field">
            <span>父目录</span>
            <Select value={createParent ?? ""} items={createParentOptions} onValueChange={(value) => setCreateParent(value === null || value === "" ? null : String(value))} disabled={creating}>
              <SelectTrigger aria-label="父目录"><SelectValue /></SelectTrigger>
              <SelectContent className="docs-overlay">{createParentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {createError ? <p className="docs-inline-error" role="alert">{createError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={creating} onClick={() => setCreateParent(undefined)}>取消</Button>
            <Button type="button" loading={creating} onClick={() => void submitCreate()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <DialogContent role="alertdialog" className="docs-overlay">
          <DialogTitle>删除「{deleteTarget?.title}」？</DialogTitle>
          <DialogDescription>将删除该文档及其子文档，进入回收站保留 30 天，到期永久清理。</DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button type="button" variant="danger" loading={deleting} onClick={() => void confirmTreeDelete()}>删除整棵子树</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
