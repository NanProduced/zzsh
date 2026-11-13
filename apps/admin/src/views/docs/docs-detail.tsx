import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, CircleDot, Copy, History, Loader2, MessageSquareText, MoreHorizontal, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { extractPlate, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FloatingStatusMessage, StatusMessage } from "../../components/ui-elements";
import { friendlyError } from "../../api";
import { deleteDoc, fetchDoc, isConflict, isForbidden, isNotFound, notFoundKind, renameDoc } from "./docs-api";
import { useDocImageUrls } from "./docs-images";
import { useDocUploads } from "./docs-upload-queue";
import {
  DOC_ANCHOR_MAX,
  DOC_TITLE_MAX,
  docAncestors,
  docPath,
  normalizeRevision,
  saveClock,
  type DocDetail,
  type DocDiscussion,
  type DocDiscussionWriteResult,
  type DocTreeNode,
} from "./docs-model";
import { useDocAutosave, type DocSavePhase } from "./use-doc-autosave";
import { DocsVersions } from "./docs-versions";
import { DocsDiscussions, type DocsDiscussionView } from "./docs-discussions";
import type { PlateEditorHandle } from "../../components/plate/plate-editor";
import type { PlateCommentAnchor } from "../../components/plate/shell/comment-toolbar-button";
import type { PlateCommentTarget } from "../../components/plate/shell/page-block";

import PlateEditor from "../../components/plate/plate-editor-loader";

type LoadState = "loading" | "ready" | "error" | "forbidden" | "deleted" | "purged" | "missing";

type DiscussionPanel = { view: DocsDiscussionView; blockId?: string; trigger?: HTMLElement };

export type DocsDetailProps = {
  docId: string;
  nodes: DocTreeNode[];
  canManage: boolean;
  canComment: boolean;
  currentAdminId: string;
  refreshNonce: number;
  autoFocusTitle?: boolean;
  onTitleFocused?: () => void;
  onOpenPath: (path: string, title?: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onTreeChanged: () => void;
};

function SaveStatus({ phase, savedAt, message }: { phase: DocSavePhase; savedAt: string | null; message: string | null }) {
  const clock = saveClock(savedAt);
  const icon = phase === "saving" ? <Loader2 size={13} aria-hidden="true" className="docs-spin motion-reduce:animate-none" />
    : phase === "saved" ? <Check size={13} aria-hidden="true" />
    : phase === "conflict" ? <TriangleAlert size={13} aria-hidden="true" />
    : phase === "failed" ? <AlertCircle size={13} aria-hidden="true" />
    : <CircleDot size={13} aria-hidden="true" />;
  const text = phase === "saving" ? (message ?? "保存中")
    : phase === "saved" ? `已保存${clock ? ` ${clock}` : ""}`
    : phase === "conflict" ? "冲突"
    : phase === "failed" ? "未保存"
    : phase === "dirty" ? "未保存"
    : "";
  if (!text) return null;
  return (
    <span className="docs-save-status" data-phase={phase} role="status" aria-live="polite">
      {icon}<span>{text}</span>
      {phase === "failed" && message ? <span className="docs-save-detail">{message}</span> : null}
    </span>
  );
}

export function DocsDetail({ docId, nodes, canManage, canComment, currentAdminId, refreshNonce, autoFocusTitle, onTitleFocused, onOpenPath, onDirtyChange, onTreeChanged }: DocsDetailProps) {
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ key: number; value: PlateNode[] }>({ key: 0, value: [] });
  const [document, setDocument] = useState<PlateDocumentEnvelope | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [titleCommitRequested, setTitleCommitRequested] = useState(false);
  const renamePending = useRef(false);
  const annotationPending = useRef(false);
  const queuedDocument = useRef(false);
  const [annotating, setAnnotating] = useState(false);
  const cancelTitleBlur = useRef(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [panel, setPanel] = useState<DiscussionPanel | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [discussionRefresh, setDiscussionRefresh] = useState(0);
  const [openIds, setOpenIds] = useState<string[]>();
  const [commentsDirty, setCommentsDirty] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const commentsButton = useRef<HTMLButtonElement>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const localDoc = useRef<PlateDocumentEnvelope | null>(null);
  const loadSeq = useRef(0);
  const seedKey = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageTarget = useRef<string | null>(null);
  const lastImgError = useRef(0);
  const editorRegion = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PlateEditorHandle>(null);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const focusBodyOnMount = useRef(false);
  const titleFocused = useRef(false);
  const orphanedKey = useRef("");
  const savedCommentKey = useRef("");
  const [draftAnchor, setDraftAnchor] = useState<PlateCommentAnchor | null>(null);
  const [hoverCommentId, setHoverCommentId] = useState<string | null>(null);

  const showDiscussionNotice = useCallback((message: string) => {
    setActionError(null);
    setActionSuccess(message);
  }, []);

  const blockElement = useCallback((id: string | undefined) => {
    if (!id) return;
    return [...(editorRegion.current?.querySelectorAll<HTMLElement>("[data-plate-block-id]") ?? [])]
      .find((block) => block.dataset.plateBlockId === id);
  }, []);
  const handleCommentRequest = useCallback((anchor: PlateCommentAnchor) => {
    setDraftAnchor(anchor);
    setPanel({ view: { kind: "draft" }, blockId: anchor.blockId, trigger: blockElement(anchor.blockId) });
  }, [blockElement]);
  const closeComments = useCallback(() => {
    const closing = panelRef.current;
    setPanel(null);
    setHoverCommentId(null);
    requestAnimationFrame(() => {
      if (panelRef.current) return;
      const target = closing?.trigger?.isConnected ? closing.trigger : blockElement(closing?.blockId) ?? commentsButton.current;
      target?.focus({ preventScroll: true });
    });
  }, [blockElement]);
  const handleDraftCancel = useCallback(() => {
    setDraftAnchor(null);
    editorRef.current?.clearDraftComment();
  }, []);
  const handleCommentClick = useCallback(({ blockId, ids, trigger, selectedId }: PlateCommentTarget) => {
    const current = panelRef.current;
    if (!selectedId && current?.view.kind === "block" && current.blockId === blockId && current.trigger === trigger) {
      closeComments();
      return;
    }
    const activeId = selectedId ?? ids[0];
    if (activeId) setPanel({ view: { kind: "block", ids, activeId }, blockId, trigger });
  }, [closeComments]);

  const handleOpenThread = useCallback((discussion: DocDiscussion) => {
    const marks = editorRegion.current?.querySelectorAll<HTMLElement>("[data-comment-ids]");
    const target = discussion.status === "OPEN" && discussion.anchorState === "PRESENT"
      ? [...(marks ?? [])].find((mark) => mark.dataset.commentIds?.split(" ").includes(discussion.id))
      : undefined;
    const block = target?.closest<HTMLElement>("[data-plate-block-id]");
    const ids = new Set([discussion.id]);
    for (const mark of block?.querySelectorAll<HTMLElement>("[data-comment-ids]") ?? []) {
      for (const id of mark.dataset.commentIds?.split(" ") ?? []) ids.add(id);
    }
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.classList.add("plate-comment--flash");
      setTimeout(() => target.classList.remove("plate-comment--flash"), 1200);
    }
    setPanel({ view: { kind: "block", ids: [...ids], activeId: discussion.id }, blockId: block?.dataset.plateBlockId, trigger: target ?? commentsButton.current ?? undefined });
  }, []);
  const handleOpenIdsChange = useCallback((ids: string[]) => {
    setOpenIds((current) => current?.join(" ") === ids.join(" ") ? current : ids);
  }, []);

  const updateDocument = useCallback((next: PlateDocumentEnvelope) => {
    localDoc.current = next;
    setDocument(next);
  }, []);

  const bumpSeed = useCallback((value: PlateNode[]) => {
    seedKey.current += 1;
    setSeed({ key: seedKey.current, value });
  }, []);

  const autosave = useDocAutosave({
    docId,
    enabled: canManage && loadState === "ready",
    onSaved: (result) => {
      setDetail((current) => (current ? { ...current, revision: normalizeRevision(result.revision) } : current));
      const key = (result.orphanedDiscussionIds ?? []).join(" ");
      const marks = localDoc.current ? extractPlate(localDoc.current).commentIds.join(" ") : "";
      if (key !== orphanedKey.current || marks !== savedCommentKey.current) {
        orphanedKey.current = key;
        savedCommentKey.current = marks;
        setDiscussionRefresh((value) => value + 1);
      }
    },
    onConflict: () => {
      // 编辑器转只读但保留本地内容：以本地最新值 remount，可复制。
      const local = localDoc.current;
      if (local) bumpSeed(local.value);
    },
  });
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  const conflict = autosave.phase === "conflict";
  const failedSave = autosave.phase === "failed";
  const bodyDirty = queuedDocument.current || autosave.phase !== "idle" && autosave.phase !== "saved";
  const titleDirty = canManage && detail !== null && titleDraft !== detail.node.title;
  const blockIds = useMemo(() => new Set(document?.value.flatMap((block) => typeof block.id === "string" ? [block.id] : [])), [document]);
  const presentIds = useMemo(() => new Set(document ? extractPlate(document).commentIds : []), [document]);
  const imageIds = useMemo(() => document ? extractPlate(document).imageIds : [], [document]);
  const uploads = useDocUploads(docId, editorRef, canManage && !conflict && loadState === "ready", blockIds);
  const clearUploads = uploads.clear;
  const dirty = bodyDirty || titleDirty || commentsDirty || renaming || annotating || uploads.dirty;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const flushQueuedDocument = useCallback(() => {
    if (renamePending.current || annotationPending.current || !queuedDocument.current || !localDoc.current) return;
    queuedDocument.current = false;
    autosaveRef.current.schedule(localDoc.current);
  }, []);
  const handleAnnotatingChange = useCallback((busy: boolean) => {
    if (busy && (annotationPending.current || renamePending.current || autosaveRef.current.hasPendingChanges() || ["conflict", "failed"].includes(autosaveRef.current.phase))) return false;
    annotationPending.current = busy;
    setAnnotating(busy);
    if (!busy) flushQueuedDocument();
    return true;
  }, [flushQueuedDocument]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadState("loading");
    setLoadError(null);
    setActionError(null);
    setCopyFallback(null);
    setPanel(null);
    setOpenIds(undefined);
    setDraftAnchor(null);
    setCommentsDirty(false);
    clearUploads();
    imageTarget.current = null;
    orphanedKey.current = "";
    queuedDocument.current = false;
    try {
      const result = await fetchDoc(docId);
      if (seq !== loadSeq.current) return;
      const revision = normalizeRevision(result.revision);
      const document = result.version.document;
      savedCommentKey.current = extractPlate(document).commentIds.join(" ");
      updateDocument(document);
      setDetail({ ...result, revision });
      setTitleDraft(result.node.title);
      setTitleCommitRequested(false);
      setTitleError(null);
      bumpSeed(document.value);
      autosaveRef.current.reset(revision, result.version.savedAt);
      setLoadState("ready");
    } catch (failure) {
      if (seq !== loadSeq.current) return;
      if (isForbidden(failure)) setLoadState("forbidden");
      else if (isNotFound(failure)) {
        const kind = notFoundKind(failure);
        setLoadState(kind === "purged" ? "purged" : kind === "deleted" ? "deleted" : "missing");
      } else {
        setLoadState("error");
        setLoadError(friendlyError(failure));
      }
    }
  }, [docId, bumpSeed, clearUploads, updateDocument]);

  const lastNonce = useRef(refreshNonce);
  useEffect(() => {
    if (lastNonce.current !== refreshNonce) {
      lastNonce.current = refreshNonce;
      if (dirtyRef.current) return;
    }
    void load();
  }, [load, refreshNonce]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const { urls: imageUrls, error: imageError, refresh: refreshImages } = useDocImageUrls(loadState === "ready" ? docId : null, imageIds);
  useEffect(() => {
    if (loadState !== "ready" || !autoFocusTitle || !titleInput.current) return;
    titleInput.current.focus({ preventScroll: true });
    titleInput.current.select();
    onTitleFocused?.();
  }, [autoFocusTitle, loadState, onTitleFocused]);
  const setEditorHandle = useCallback((editor: PlateEditorHandle | null) => {
    editorRef.current = editor;
    if (!editor || !focusBodyOnMount.current) return;
    focusBodyOnMount.current = false;
    editor.focusStart();
  }, []);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const node = detail?.node;
  const ancestors = node ? docAncestors(node, byId) : [];
  const subtreeCount = node ? nodes.filter((item) => isWithin(item.id, node.id, byId)).length : 0;

  // 标题外部变更（加载/改名/树刷新）同步到 inline 输入；用户正在输入时不覆盖。
  const nodeTitle = node?.title;
  useEffect(() => {
    if (!titleFocused.current && nodeTitle !== undefined) setTitleDraft(nodeTitle);
  }, [nodeTitle]);

  const handleEditorChange = useCallback((envelope: PlateDocumentEnvelope) => {
    const previous = localDoc.current;
    updateDocument(envelope);
    if (previous && openIds?.length) {
      const after = new Set(extractPlate(envelope).commentIds);
      const lost = extractPlate(previous).commentIds.filter((id) => !after.has(id) && openIds.includes(id));
      if (lost.length > 0) showDiscussionNotice(`${lost.length} 条评论失去原文位置，仍可从「评论」查看。`);
    }
    if (renamePending.current || annotationPending.current) queuedDocument.current = true;
    else autosaveRef.current.schedule(envelope);
  }, [openIds, showDiscussionNotice, updateDocument]);

  const applyDiscussionDocument = useCallback((result: DocDiscussionWriteResult, mode: "create" | "resolve") => {
    const revision = normalizeRevision(result.revision);
    if (revision !== autosaveRef.current.getRevision()) { autosaveRef.current.conflict(); return; }
    const editor = editorRef.current;
    if (!editor) return;
    const { discussion } = result;
    const next = editor.applyDiscussionMark(discussion.id, mode === "create" ? discussion.anchorText : undefined);
    updateDocument(next);
    setDetail((current) => current ? {
      ...current,
      revision,
      version: { ...current.version, id: result.versionId, seq: result.seq, document: result.document },
    } : current);
  }, [updateDocument]);
  const handleDiscussionCreated = useCallback((result: DocDiscussionWriteResult) => {
    applyDiscussionDocument(result, "create");
    const id = result.discussion.id;
    setPanel((current) => current?.view.kind === "draft" ? { ...current, view: { kind: "block", ids: [id], activeId: id } } : current);
  }, [applyDiscussionDocument]);
  const handleDiscussionResolved = useCallback((result: DocDiscussionWriteResult) => applyDiscussionDocument(result, "resolve"), [applyDiscussionDocument]);
  const pickImages = useCallback((blockId: string) => {
    imageTarget.current = blockId;
    fileInput.current?.click();
  }, []);

  const onImageError = () => {
    const now = Date.now();
    if (now - lastImgError.current < 5000) return;
    lastImgError.current = now;
    void refreshImages(imageIds);
  };

  const submitTitle = useCallback(async () => {
    if (!detail || !canManage || renamePending.current || conflict || failedSave) return;
    const title = titleDraft.trim();
    if (!title || [...title].length > DOC_TITLE_MAX) { setTitleError(`标题需 1–${DOC_TITLE_MAX} 字。`); return; }
    if (title === detail.node.title) { setTitleError(null); setTitleDraft(detail.node.title); return; }
    if (bodyDirty || annotationPending.current) { setTitleCommitRequested(true); return; }
    renamePending.current = true;
    setRenaming(true);
    setTitleError(null);
    try {
      const result = await renameDoc(docId, { expectedRevision: autosaveRef.current.getRevision(), title });
      setDetail((current) => (current ? { ...current, node: result.node, revision: normalizeRevision(result.revision) } : current));
      autosaveRef.current.adoptRevision(result.revision);
      setTitleDraft(result.node.title);
      onTreeChanged();
    } catch (failure) {
      if (isConflict(failure)) autosaveRef.current.conflict();
      else setTitleError(friendlyError(failure));
    } finally {
      renamePending.current = false;
      setRenaming(false);
      flushQueuedDocument();
    }
  }, [bodyDirty, canManage, conflict, detail, docId, failedSave, flushQueuedDocument, onTreeChanged, titleDraft]);
  useEffect(() => {
    if (titleCommitRequested && !bodyDirty && !annotating && !titleFocused.current) {
      setTitleCommitRequested(false);
      void submitTitle();
    }
  }, [annotating, bodyDirty, submitTitle, titleCommitRequested]);

  const confirmDelete = async () => {
    if (!detail || deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      const result = await deleteDoc(docId, { expectedRevision: autosave.getRevision() });
      setDeleteOpen(false);
      onTreeChanged();
      onOpenPath("/docs?view=trash", "回收站");
      setActionSuccess(`已删除 ${result.deletedCount} 篇文档，30 天内可在回收站恢复。`);
    } catch (failure) {
      if (isConflict(failure)) { autosave.conflict(); setDeleteOpen(false); }
      else setActionError(friendlyError(failure));
    } finally {
      setDeleting(false);
    }
  };

  const copyLocal = async () => {
    const local = localDoc.current;
    if (!local) return;
    const body = extractPlate(local).plainText;
    const text = titleDirty ? [titleDraft, body].join("\n\n") : body;
    try {
      await navigator.clipboard.writeText(text);
      setActionSuccess("本地内容已复制，可粘贴到别处保存。");
    } catch {
      setCopyFallback(text);
    }
  };

  if (loadState === "loading") {
    return (
      <div className="docs-detail docs-detail-state" role="status" aria-label="文档加载中">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (loadState === "forbidden") {
    return <div className="docs-detail docs-detail-state" role="alert"><StatusMessage error="没有权限" /><Button type="button" variant="secondary" onClick={() => onOpenPath("/docs")}>返回文档库</Button></div>;
  }
  if (loadState === "deleted" || loadState === "missing" || loadState === "purged") {
    const purged = loadState === "purged";
    return (
      <div className="docs-detail docs-detail-state" role="alert">
        <StatusMessage tone="warning" error={purged ? "该文档已被永久清理" : loadState === "deleted" ? "该文档已在回收站" : "该文档已在回收站或不存在"} />
        <div className="docs-state-actions">
          {!purged && canManage ? <Button type="button" variant="secondary" onClick={() => onOpenPath("/docs?view=trash", "回收站")}>去回收站</Button> : null}
          <Button type="button" variant="secondary" onClick={() => onOpenPath("/docs")}>返回</Button>
        </div>
      </div>
    );
  }
  if (loadState === "error" || !detail || !node) {
    return (
      <div className="docs-detail docs-detail-state" role="alert">
        <StatusMessage error={`文档暂时无法读取${loadError ? `：${loadError}` : ""}`} />
        <Button type="button" variant="secondary" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />重试</Button>
      </div>
    );
  }

  const envelope = localDoc.current ?? detail.version.document;
  const readOnly = !canManage || conflict;
  const liveAnchor = draftAnchor ? editorRef.current?.currentDraftAnchor() : null;
  const submitBlocked = bodyDirty || renaming
    ? conflict || failedSave ? "正文有未保存的修改，请先保留本地输入。" : "正文保存后即可发布评论。"
    : draftAnchor && liveAnchor?.text !== draftAnchor.text
      ? "选区已变更。请保留评论内容，重新选择原文。"
      : null;
  const activeCommentId = panel?.view.kind === "block" ? panel.view.activeId : null;
  const overviewOpen = panel?.view.kind === "overview";

  return (
    <div className="docs-detail">
      <header className="docs-workbar">
        <nav className="docs-breadcrumb" aria-label="文档位置">
          <button type="button" onClick={() => onOpenPath("/docs")}>内部文档</button>
          {ancestors.map((ancestor) => (
            <span key={ancestor.id} className="docs-breadcrumb-item">
              <span aria-hidden="true">/</span>
              <button type="button" onClick={() => onOpenPath(docPath(ancestor.id), ancestor.title)}>{ancestor.title}</button>
            </span>
          ))}
        </nav>
        <div className="docs-head-actions">
          {!canManage ? <Badge variant="unknown">只读</Badge> : null}
          {canManage ? <SaveStatus phase={autosave.phase} savedAt={autosave.savedAt} message={autosave.message} /> : null}
          {canComment ? (
            <Button ref={commentsButton} type="button" variant={overviewOpen ? "secondary" : "ghost"} size="sm" aria-expanded={overviewOpen} aria-haspopup="dialog" aria-controls={overviewOpen ? "internal-doc-comments" : undefined} onClick={(event) => {
              if (overviewOpen) closeComments();
              else setPanel({ view: { kind: "overview" }, trigger: event.currentTarget });
            }}>
              <MessageSquareText size={15} aria-hidden="true" />评论
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setVersionsOpen(true)}>
            <History size={15} aria-hidden="true" />版本历史
          </Button>
          {canManage && !conflict ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="更多文档操作" />}>
                <MoreHorizontal size={16} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="docs-overlay">
                <DropdownMenuItem variant="destructive" disabled={dirty} onClick={() => { setActionError(null); setDeleteOpen(true); }}>
                  <Trash2 size={14} aria-hidden="true" />删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <div className="docs-detail-main plate-page-canvas">
      <div className="docs-title-block">
        {canManage && !conflict ? (
          <div className="docs-title-field" data-title={titleDraft || "无标题"}>
            <textarea
              ref={titleInput}
              className="docs-title-input"
              aria-label="文档标题"
              value={titleDraft}
              maxLength={DOC_TITLE_MAX}
              placeholder="无标题"
              rows={1}
              disabled={renaming}
              onChange={(event) => setTitleDraft(event.target.value.replace(/[\r\n]+/g, " "))}
              onFocus={() => { titleFocused.current = true; setTitleCommitRequested(false); }}
              onBlur={() => {
                titleFocused.current = false;
                if (!cancelTitleBlur.current) void submitTitle();
                cancelTitleBlur.current = false;
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitTitle();
                  if (!titleDraft.trim() || [...titleDraft.trim()].length > DOC_TITLE_MAX) return;
                  cancelTitleBlur.current = true;
                  if (editorRef.current) editorRef.current.focusStart();
                  else { focusBodyOnMount.current = true; event.currentTarget.blur(); }
                }
                if (event.key === "Escape") {
                  cancelTitleBlur.current = true;
                  setTitleDraft(node.title);
                  setTitleError(null);
                  setTitleCommitRequested(false);
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
        ) : (
          <h1 className="docs-title">{conflict && titleDirty ? titleDraft || node.title : node.title}</h1>
        )}
        {titleError ? <p className="docs-inline-error" role="alert">{titleError}</p> : null}
      </div>

      <FloatingStatusMessage error={actionError ?? undefined} success={actionSuccess ?? undefined} />

      {conflict || failedSave ? (
        <div className="docs-conflict-banner" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{conflict ? "别人刚改过，刷新后再改" : "正文未保存，输入仍在当前页面。"}</span>
          <div className="docs-conflict-actions">
            <Button type="button" size="xs" variant="secondary" onClick={() => void copyLocal()}><Copy size={12} aria-hidden="true" />复制本地内容</Button>
            <Button type="button" size="xs" variant="secondary" onClick={() => setReloadOpen(true)}><RefreshCw size={12} aria-hidden="true" />读取最新正文</Button>
          </div>
        </div>
      ) : null}
      {copyFallback !== null ? (
        <div className="docs-copy-fallback">
          <p className="docs-tree-note">自动复制不可用，请手动全选复制以下本地内容：</p>
          <textarea readOnly value={copyFallback} aria-label="本地内容副本" rows={8} onFocus={(event) => event.currentTarget.select()} />
        </div>
      ) : null}

      {imageError ? <p className="docs-tree-note" role="status">{imageError}</p> : null}

      {canManage ? (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            tabIndex={-1}
            className="docs-file-input"
            aria-label="选择要插入的图片"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              const target = imageTarget.current ?? editorRef.current?.selectedBlockId();
              event.target.value = "";
              imageTarget.current = null;
              if (target) uploads.enqueue(files, target);
            }}
          />
          {uploads.unplaced}
        </>
      ) : null}

      <div className={canManage ? "docs-editor-region" : "docs-editor-region docs-readonly"} ref={editorRegion} onErrorCapture={onImageError}>
        {canManage || canComment ? (
          <Suspense fallback={<div className="docs-editor-loading" role="status"><Skeleton className="h-64 w-full" /><span>编辑器加载中…</span></div>}>
            <PlateEditor
              key={`${docId}:${seed.key}`}
              ref={setEditorHandle}
              preset="internal"
              canvas
              value={seed.value}
              onChange={handleEditorChange}
              readOnly={readOnly}
              imageUrls={imageUrls}
              onCommentRequest={canComment && !conflict && !draftAnchor ? handleCommentRequest : undefined}
              commentAnchorMax={DOC_ANCHOR_MAX}
              onPickImages={canManage ? pickImages : undefined}
              onPasteImages={canManage ? uploads.enqueue : undefined}
              pageBlocks={{
                activeId: activeCommentId,
                activeBlockId: panel?.blockId,
                hoverId: hoverCommentId,
                openIds,
                blockActions: canManage ? "internal" : undefined,
                onCommentClick: canComment ? handleCommentClick : undefined,
                onCommentHover: canComment ? setHoverCommentId : undefined,
                afterBlock: uploads.afterBlock,
              }}
            />
          </Suspense>
        ) : (
          <PlateDocument document={envelope} imageUrls={imageUrls} />
        )}
      </div>
      </div>

      {canComment ? (
        <DocsDiscussions
          docId={docId}
          view={panel?.view ?? null}
          anchor={panel ? blockElement(panel.blockId) ?? commentsButton.current : null}
          onClose={closeComments}
          refreshKey={discussionRefresh}
          onDirtyChange={setCommentsDirty}
          canComment={canComment}
          currentAdminId={currentAdminId}
          draftAnchor={draftAnchor?.text ?? null}
          anchorOffset={liveAnchor?.offset ?? draftAnchor?.offset}
          expectedRevision={detail.revision}
          submitBlocked={submitBlocked}
          documentBusy={bodyDirty || renaming || annotating}
          onAnnotatingChange={handleAnnotatingChange}
          onDraftCancel={handleDraftCancel}
          onReselectDraft={() => { handleDraftCancel(); closeComments(); }}
          onResumeDraft={() => {
            if (draftAnchor) setPanel({ view: { kind: "draft" }, blockId: draftAnchor.blockId, trigger: blockElement(draftAnchor.blockId) });
          }}
          hoverId={hoverCommentId}
          onActiveIdChange={(id) => setPanel((current) => current?.view.kind === "block" ? { ...current, view: { ...current.view, activeId: id } } : current)}
          onHoverIdChange={setHoverCommentId}
          presentIds={presentIds}
          onOpenThread={handleOpenThread}
          onCreated={handleDiscussionCreated}
          onResolved={handleDiscussionResolved}
          onOpenIdsChange={handleOpenIdsChange}
        />
      ) : null}

      <DocsVersions
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        docId={docId}
        docTitle={node.title}
        canManage={canManage && !dirty}
        currentRevision={() => autosaveRef.current.getRevision()}
        onRestored={(restored) => {
          const revision = normalizeRevision(restored.revision);
          updateDocument(restored.version.document);
          setDetail({ ...restored, revision });
          setPanel(null);
          setDiscussionRefresh((value) => value + 1);
          bumpSeed(restored.version.document.value);
          autosaveRef.current.reset(revision, restored.version.savedAt);
          onTreeChanged();
        }}
        onConflict={() => autosaveRef.current.conflict()}
      />

      <Dialog open={reloadOpen} onOpenChange={setReloadOpen}>
        <DialogContent role="alertdialog" className="docs-overlay">
          <DialogTitle>读取最新正文？</DialogTitle>
          <DialogDescription>读取服务端正文会放弃当前未保存的输入。</DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus onClick={() => setReloadOpen(false)}>继续保留输入</Button>
            <Button type="button" variant="danger" onClick={() => { setReloadOpen(false); void load(); }}>放弃并读取</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}>
        <DialogContent role="alertdialog" className="docs-overlay">
          <DialogTitle>删除「{node.title}」？</DialogTitle>
          <DialogDescription>
            将删除该文档及其子文档（共 {Math.max(1, subtreeCount)} 篇），进入回收站保留 30 天，到期永久清理。恢复需要管理权限。
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus disabled={deleting} onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button type="button" variant="danger" loading={deleting} onClick={() => void confirmDelete()}>删除整棵子树</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function isWithin(id: string, ancestorId: string, byId: ReadonlyMap<string, DocTreeNode>): boolean {
  let cursor = byId.get(id);
  let steps = 0;
  while (cursor && steps <= 4) {
    if (cursor.id === ancestorId) return true;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    steps += 1;
  }
  return false;
}
