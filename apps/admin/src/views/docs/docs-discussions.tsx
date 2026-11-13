import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, flip, offset, shift, useFloating } from "@platejs/floating";
import { Check, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/plate/ui/tooltip";
import { workspacePortalContainer } from "@/lib/workspace-portal";
import { friendlyError } from "../../api";
import {
  addDocComment,
  createDocDiscussion,
  deleteDocComment,
  editDocComment,
  fetchDocDiscussions,
  isConflict,
  isForbidden,
  reopenDocDiscussion,
  resolveDocDiscussion,
} from "./docs-api";
import {
  DOC_ANCHOR_MAX,
  docTime,
  newDiscussionId,
  newWriteKey,
  openDiscussionIds,
  type DocDiscussion,
  type DocDiscussionWriteResult,
} from "./docs-model";
import { CommentComposer, DocsComment } from "./docs-comment";

export type DocsDiscussionView =
  | { kind: "overview" }
  | { kind: "draft" }
  | { kind: "block"; ids: string[]; activeId: string };

export type DocsDiscussionsProps = {
  docId: string;
  view: DocsDiscussionView | null;
  anchor: HTMLElement | null;
  onClose: () => void;
  refreshKey: number;
  onDirtyChange?: (dirty: boolean) => void;
  canComment: boolean;
  currentAdminId: string;
  draftAnchor: string | null;
  anchorOffset?: number;
  expectedRevision?: string;
  submitBlocked?: string | null;
  documentBusy?: boolean;
  onAnnotatingChange: (busy: boolean) => boolean;
  onDraftCancel: () => void;
  onReselectDraft: () => void;
  onResumeDraft: () => void;
  hoverId: string | null;
  onActiveIdChange: (id: string) => void;
  onHoverIdChange: (id: string | null) => void;
  presentIds: ReadonlySet<string>;
  onOpenThread: (discussion: DocDiscussion) => void;
  onCreated: (result: DocDiscussionWriteResult) => void;
  onResolved: (result: DocDiscussionWriteResult) => void;
  onOpenIdsChange: (ids: string[]) => void;
};

type ListState = { status: "loading" | "ready" | "error"; items: DocDiscussion[]; error?: string };

export function DocsDiscussions({
  docId, view, anchor, onClose, refreshKey, onDirtyChange, canComment, currentAdminId, draftAnchor, anchorOffset, expectedRevision, submitBlocked, documentBusy, onAnnotatingChange, onDraftCancel, onReselectDraft, onResumeDraft,
  hoverId, onActiveIdChange, onHoverIdChange, presentIds, onOpenThread,
  onCreated, onResolved, onOpenIdsChange,
}: DocsDiscussionsProps) {
  const [listState, setListState] = useState<ListState>({ status: "loading", items: [] });
  const [composer, setComposer] = useState("");
  const [creating, setCreating] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyBusy, setReplyBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ commentId: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyDiscussion, setBusyDiscussion] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; error?: string; success?: string } | null>(null);
  const loadSeq = useRef(0);
  const createAttempt = useRef<{ signature: string; id: string; key: string } | null>(null);
  const replyAttempts = useRef(new Map<string, { body: string; key: string }>());
  const editedComment = editing && listState.items.flatMap((discussion) => discussion.comments).find((comment) => comment.id === editing.commentId);
  const dirty = creating || replyBusy !== null || busyDiscussion !== null || Boolean(composer.trim()) ||
    Object.values(replyDrafts).some((body) => Boolean(body.trim())) ||
    Boolean(editing && editedComment?.body !== editing.body);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setListState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await fetchDocDiscussions(docId);
      if (seq !== loadSeq.current) return;
      const items = page.discussions ?? [];
      setListState({ status: "ready", items });
    } catch (failure) {
      if (seq !== loadSeq.current) return;
      setListState((current) => ({ ...current, status: "error", error: friendlyError(failure) }));
    }
  }, [docId]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { if (view?.kind === "overview") void load(); }, [load, view?.kind]);
  useEffect(() => {
    if (listState.status === "ready") onOpenIdsChange(openDiscussionIds(listState.items.filter((item) => item.anchorState === "PRESENT")));
  }, [listState, onOpenIdsChange]);

  const fail = (id: string, failure: unknown) => {
    if (isForbidden(failure)) setFeedback({ id, error: "没有权限" });
    else if (isConflict(failure)) { setFeedback({ id, error: "讨论状态已变化，正在读取最新记录。" }); void load(); }
    else setFeedback({ id, error: friendlyError(failure) });
  };

  const submitDiscussion = async () => {
    const body = composer.trim();
    if (!draftAnchor || !body || creating || busyDiscussion || !canComment || submitBlocked) return;
    if (!onAnnotatingChange(true)) return;
    setCreating(true);
    setFeedback(null);
    try {
      const signature = JSON.stringify([draftAnchor, anchorOffset, expectedRevision, body]);
      const attempt = createAttempt.current?.signature === signature
        ? createAttempt.current
        : { signature, id: newDiscussionId(), key: newWriteKey() };
      createAttempt.current = attempt;
      const result = await createDocDiscussion(docId, { discussionId: attempt.id, anchorText: draftAnchor, anchorOffset, expectedRevision, body }, attempt.key);
      createAttempt.current = null;
      setComposer("");
      setListState((current) => ({ status: "ready", items: [...current.items.filter((item) => item.id !== result.discussion.id), result.discussion] }));
      onCreated(result);
      onDraftCancel();
      setFeedback({ id: result.discussion.id, success: "评论已发布。" });
      void load();
    } catch (failure) {
      if (isConflict(failure)) setFeedback({ id: "draft", error: "正文已变更。请保留评论内容，读取最新正文后重新选择原文。" });
      else fail("draft", failure);
    } finally {
      setCreating(false);
      onAnnotatingChange(false);
    }
  };

  const submitReply = async (discussionId: string) => {
    const body = (replyDrafts[discussionId] ?? "").trim();
    if (!body || replyBusy || !canComment) return;
    setReplyBusy(discussionId);
    setFeedback(null);
    try {
      const previous = replyAttempts.current.get(discussionId);
      const attempt = previous?.body === body ? previous : { body, key: newWriteKey() };
      replyAttempts.current.set(discussionId, attempt);
      const { comment } = await addDocComment(discussionId, { body }, attempt.key);
      replyAttempts.current.delete(discussionId);
      setReplyDrafts((current) => ({ ...current, [discussionId]: "" }));
      setListState((current) => ({
        ...current,
        items: current.items.map((item) => item.id === discussionId && !item.comments.some((existing) => existing.id === comment.id)
          ? { ...item, comments: [...item.comments, comment] } : item),
      }));
      void load();
    } catch (failure) {
      fail(discussionId, failure);
    } finally {
      setReplyBusy(null);
    }
  };

  const submitEdit = async () => {
    if (!editing || replyBusy) return;
    const body = editing.body.trim();
    if (!body) return;
    setReplyBusy(editing.commentId);
    setFeedback(null);
    try {
      await editDocComment(editing.commentId, { body });
      setEditing(null);
      await load();
    } catch (failure) {
      fail(editedComment?.discussionId ?? editing.commentId, failure);
    } finally {
      setReplyBusy(null);
    }
  };

  const submitDelete = async (commentId: string) => {
    if (replyBusy) return;
    setReplyBusy(commentId);
    setFeedback(null);
    try {
      await deleteDocComment(commentId);
      setConfirmDelete(null);
      await load();
    } catch (failure) {
      fail(listState.items.find((item) => item.comments.some((comment) => comment.id === commentId))?.id ?? commentId, failure);
    } finally {
      setReplyBusy(null);
    }
  };

  const submitResolve = async (discussionId: string) => {
    if (busyDiscussion || creating || documentBusy || !canComment) return;
    if (!onAnnotatingChange(true)) return;
    setBusyDiscussion(discussionId);
    setFeedback(null);
    try {
      const result = await resolveDocDiscussion(discussionId);
      setListState((current) => ({ ...current, items: current.items.map((item) => item.id === discussionId ? result.discussion : item) }));
      onResolved(result);
      setFeedback({ id: discussionId, success: "讨论已解决。" });
      void load();
    } catch (failure) {
      fail(discussionId, failure);
    } finally {
      setBusyDiscussion(null);
      onAnnotatingChange(false);
    }
  };

  const submitReopen = async (discussionId: string) => {
    if (busyDiscussion || !canComment) return;
    setBusyDiscussion(discussionId);
    setFeedback(null);
    try {
      const { discussion } = await reopenDocDiscussion(discussionId);
      setListState((current) => ({ ...current, items: current.items.map((item) => item.id === discussionId ? discussion : item) }));
      setFeedback({ id: discussionId, success: "讨论已重开。" });
      void load();
    } catch (failure) {
      fail(discussionId, failure);
    } finally {
      setBusyDiscussion(null);
    }
  };

  const overview = view?.kind === "overview";
  const block = view?.kind === "block" ? view : null;
  const isOrphaned = (item: DocDiscussion) => item.status === "OPEN" && (item.anchorState === "ORPHANED" || !presentIds.has(item.id));
  const active = block && listState.items.find((item) => item.id === block.activeId);
  const choices = block ? listState.items.filter((item) => block.ids.includes(item.id) && (item.status === "OPEN" || item.id === block.activeId)) : [];
  const activeFeedback = feedback?.id === (active?.id ?? view?.kind) ? feedback : null;
  const reply = active ? replyDrafts[active.id] ?? "" : "";
  const title = overview ? "文档评论" : view?.kind === "draft" ? "评论选区" : "段落评论";
  const { refs, floatingStyles, isPositioned } = useFloating({
    open: Boolean(view),
    strategy: "fixed",
    transform: false,
    placement: overview ? "bottom-end" : "right-start",
    middleware: [offset(10), flip({ padding: 12, fallbackPlacements: overview ? ["top-end", "bottom-start"] : ["bottom-end", "top-end", "left-start"] }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  const floating = refs.floating;
  const setReference = refs.setReference;
  useLayoutEffect(() => { setReference(anchor); }, [anchor, setReference]);
  useEffect(() => {
    if (!view || anchor && !isPositioned) return;
    const frame = requestAnimationFrame(() => {
      if (view.kind === "block" && document.activeElement?.matches("[data-slate-editor]")) return;
      const panel = floating.current;
      const target = view.kind === "draft" ? panel?.querySelector<HTMLElement>('[aria-label="评论内容"]') ?? panel : panel;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
    // Repositioning as the document changes preserves the user's current focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floating, isPositioned, view?.kind]);
  useEffect(() => {
    if (!view) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      const dialog = event.target instanceof Element && event.target.closest('[role="dialog"],[role="alertdialog"]');
      if (dialog && dialog !== floating.current) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [floating, onClose, view]);

  if (!view) return null;
  const groups = [
    { label: "未解决", items: listState.items.filter((item) => item.status === "OPEN" && !isOrphaned(item)) },
    { label: "已解决", items: listState.items.filter((item) => item.status === "RESOLVED") },
    { label: "无法定位原文", items: listState.items.filter(isOrphaned) },
  ];
  const loading = listState.status === "loading" && listState.items.length === 0;

  return createPortal(
    <TooltipProvider delayDuration={300}>
    <aside
      ref={refs.setFloating}
      className="docs-comment-panel plate-overlay"
      id="internal-doc-comments"
      role="dialog"
      aria-modal="false"
      aria-label={title}
      tabIndex={-1}
      data-view={view.kind}
      data-positioned={isPositioned || !anchor ? "true" : undefined}
      style={floatingStyles}
    >
      <div className="docs-comment-panel-head">
        <h2 className={block ? "sr-only" : undefined}>{view.kind === "draft" ? "评论" : title}</h2>
        <div className="docs-comment-actions">
          {overview && draftAnchor ? <Button type="button" size="xs" variant="secondary" onClick={onResumeDraft}>继续评论草稿</Button> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="关闭评论" onClick={onClose}>
                <X size={14} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>关闭评论</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {activeFeedback?.error ? <p className="docs-inline-error" role="alert">{activeFeedback.error}</p> : null}
      {activeFeedback?.success ? <p className="sr-only" role="status">{activeFeedback.success}</p> : null}
      {view.kind === "draft" && canComment && draftAnchor ? (
        <div className="docs-discussion-composer" data-testid="discussion-composer">
          <CommentComposer label="评论内容" placeholder="写下你的评论…" value={composer} sendLabel="发布评论"
            sending={creating} disabled={Boolean(submitBlocked || busyDiscussion)} onChange={setComposer} onSend={() => void submitDiscussion()} />
          {submitBlocked ? <p className="docs-tree-note" role="status">{submitBlocked}</p> : null}
          <div className="docs-comment-actions">
            {submitBlocked && !documentBusy ? <Button type="button" size="sm" variant="ghost" onClick={() => { setFeedback(null); onReselectDraft(); }}>重新选择原文</Button> : null}
            <Button type="button" size="sm" variant="ghost" disabled={creating} onClick={() => { setComposer(""); setFeedback(null); createAttempt.current = null; onDraftCancel(); onClose(); }}>取消</Button>
          </div>
        </div>
      ) : null}

      {view.kind !== "draft" && loading ? (
        <div role="status" aria-label="讨论列表加载中" className="docs-versions-skeleton">
          <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {view.kind !== "draft" && listState.status === "error" ? (
        <div role="alert" className="docs-inline-error">
          <p>讨论暂时无法读取：{listState.error}</p>
          <Button type="button" size="xs" variant="secondary" onClick={() => void load()}>重试</Button>
        </div>
      ) : null}
      {overview && listState.items.length > 0 ? (
        <div className="docs-discussion-scroll">
          {groups.map(({ label, items }) => (
            <section className="docs-discussion-group" aria-label={`${label}讨论`} key={label}>
              <h3 className="docs-discussion-group-title">{label}（{items.length}）</h3>
              {items.length ? (
                <ul className="docs-discussion-list">
                  {items.map((item) => (
                    <li key={item.id} onMouseEnter={() => onHoverIdChange(item.id)} onMouseLeave={() => onHoverIdChange(null)}>
                      <button type="button" className="docs-discussion-summary" data-hover={hoverId === item.id || undefined} onClick={() => onOpenThread(item)}>
                        <span>{item.anchorText}</span>
                        <small>{item.comments.filter((comment) => !comment.deletedAt).length} 条留言</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
      {overview && listState.status === "ready" && !listState.items.length ? <p className="docs-comment-empty">{canComment ? "选中正文中的文字即可评论。" : "还没有评论。"}</p> : null}
      {block && !active && listState.status === "ready" ? <p className="docs-comment-empty">这条评论暂时不可用。</p> : null}
      {active ? (
        <article className="docs-discussion-thread" data-status={active.status} data-orphaned={isOrphaned(active) || undefined} aria-label="讨论">
          {canComment ? (
            <div className="docs-thread-action">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    {active.status === "OPEN" ? (
                      <Button type="button" size="icon-xs" variant="ghost" aria-label="解决" disabled={documentBusy || creating}
                        loading={busyDiscussion === active.id} onClick={() => void submitResolve(active.id)}>
                        <Check size={14} aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button type="button" size="icon-xs" variant="ghost" aria-label="重开"
                        loading={busyDiscussion === active.id} onClick={() => void submitReopen(active.id)}>
                        <RotateCcw size={13} aria-hidden="true" />
                      </Button>
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{active.status === "RESOLVED" ? "重开讨论" : documentBusy ? "正文保存后即可解决讨论" : "解决讨论"}</TooltipContent>
              </Tooltip>
            </div>
          ) : null}
          {choices.length > 1 ? (
            <div className="docs-discussion-tabs" role="group" aria-label="切换评论">
              {choices.map((item, index) => (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <Button type="button" size="xs" variant={item.id === active.id ? "secondary" : "ghost"} aria-pressed={item.id === active.id} aria-label={`第 ${index + 1} 条评论，${item.anchorText}`} onClick={() => onActiveIdChange(item.id)}>
                      第 {index + 1} 条
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{item.anchorText.slice(0, DOC_ANCHOR_MAX)}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          ) : null}
          <div className="docs-discussion-scroll" key={active.id}>
            {isOrphaned(active) ? (
              <div className="docs-discussion-anchor-row">
                <blockquote className="docs-discussion-anchor">{active.anchorText}</blockquote>
                <Badge variant="unknown">无法定位原文</Badge>
              </div>
            ) : null}
            <ul className="docs-comment-list" aria-label="回复列表">{active.comments.map((comment) => <DocsComment key={comment.id} comment={comment} currentAdminId={currentAdminId} editing={editing} setEditing={setEditing} replyBusy={replyBusy} submitEdit={() => void submitEdit()} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} canComment={canComment} submitDelete={(id) => void submitDelete(id)} />)}</ul>
          </div>
          {canComment && (active.status === "OPEN" || reply.trim()) ? (
            <CommentComposer label="回复内容" placeholder="回复…" value={reply} sendLabel="回复"
              sending={replyBusy === active.id} disabled={active.status === "RESOLVED"}
              onChange={(value) => setReplyDrafts((current) => ({ ...current, [active.id]: value }))}
              onSend={() => void submitReply(active.id)} />
          ) : null}
        </article>
      ) : null}
    </aside>
    </TooltipProvider>,
    workspacePortalContainer() ?? document.body,
  );
}
