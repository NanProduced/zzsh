"use client";
/**
 * 客服工作台「聊天」模块：咨询会话主列（头部/通知/消息时间线/输入区）与详情右栏。
 * 发送、重试、撤回、删除与接待操作仍由 im-support-view.tsx 编排，本文件只做展示与本地输入态。
 */
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { ArrowDown, Check, ChevronLeft, CircleAlert, FileText, Headphones, Images, MessageSquareText, MoreHorizontal, ShieldCheck, Smile, Video } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { ProfileImage } from "@zzsh/ui/profile-image";
import { collapseImSystemNotices, imSystemNoticeLabel } from "@zzsh/im-client/message-state";
import { CHAT_EMOJIS, MessageReplyQuote, useMessageLongPress } from "@zzsh/ui/message-actions";
import { MediaDraftBar, mediaSummaryOf, type MessageMediaDraft } from "@zzsh/ui/message-media";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { ActionTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { adminRequest } from "../api";
import { supportedImageUrl } from "./im-support-guards";
import { messageScopeLabel } from "./im-support-vocabulary";
import { SupportMessageBody, supportMessageSummary } from "./im-support-message-body";
import { ConsultationUserCard } from "./im-support-user-card";
import { ConsultationEventsCard, ConsultationRoundsTimeline } from "./im-support-events";
import { EntityPreviewTrigger } from "../components/admin-preview";
import { Button } from "../components/ui/button";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../components/ui/input-group";
import { Kbd } from "../components/ui/kbd";
import { dayKeyOf, dayLabelOf, formatBytes, initialOf } from "./im-support-format";
import {
  CLOSE_OUTCOME_UNKNOWN_NOTICE, GROUP_WINDOW_MS, MAX_STAGED_IMAGES, ROUND_CLOSED_NOTICE,
  SUPPORT_QUICK_REPLIES, readSupportQuickReplies, roundHeadlineOf, storeSupportQuickReplies,
  supportMessageAuthor, typeLabel,
  type Consultation, type DraftImage, type FailedText, type QuickReplyItem, type SupportMessage,
} from "./im-support-view-model";

type ProfileScope = { profile: boolean; orders: boolean; resources: boolean };
type ActiveAftersale = { id: string; orderId: string; orderDisplayNo: string | null; threadId: string };
type LongPress = ReturnType<typeof useMessageLongPress>;

function replySummaryOf(message: SupportMessage): string {
  return message.image ? "[图片]" : mediaSummaryOf(message) ?? (message.text.trim() ? supportMessageSummary(message.text).trim().slice(0, 120) : "消息");
}

/** 个人常用语：只插入草稿，不自动发送；编辑状态内置，仅本机保存。 */
function SupportQuickReplies({ adminUserId, disabled, onInsert }: { adminUserId: string; disabled: boolean; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReplyItem[]>(() => readSupportQuickReplies(adminUserId));
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<QuickReplyItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { setQuickReplies(readSupportQuickReplies(adminUserId)); }, [adminUserId]);
  return <Popover open={open} onOpenChange={setOpen}>
    <Tooltip>
      <TooltipTrigger render={<PopoverTrigger render={<button type="button" className="im-wb-tool" data-action="quick-replies" aria-label="常用语" disabled={disabled}><MessageSquareText size={15} /></button>} />} />
      <TooltipContent>常用语</TooltipContent>
    </Tooltip>
    <PopoverContent side="top" align="start" className="w-80 p-0">
      {editing ? (
        <div className="p-3 space-y-2 text-xs" data-panel="quick-replies-editor">
          <div className="flex items-center justify-between border-b pb-1.5 font-medium">
            <span>编辑个人常用语</span>
            <span className="text-[11px] text-muted-foreground">{drafts.length}/15</span>
          </div>
          <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
            {drafts.map((item, index) => (
              <div key={index} className="flex flex-col gap-1 rounded border p-1.5 bg-muted/30">
                <div className="flex items-center justify-between gap-1">
                  <input
                    className="h-6 flex-1 rounded border px-1.5 text-xs bg-background"
                    placeholder="标签（≤10字）"
                    maxLength={10}
                    value={item.label}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDrafts((prev) => prev.map((q, i) => i === index ? { ...q, label: val } : q));
                    }}
                  />
                  <button
                    type="button"
                    className="text-destructive hover:underline px-1"
                    onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
                  >
                    删除
                  </button>
                </div>
                <textarea
                  className="w-full rounded border p-1 text-xs resize-none bg-background"
                  rows={2}
                  placeholder="回复内容（≤200字）"
                  maxLength={200}
                  value={item.text}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDrafts((prev) => prev.map((q, i) => i === index ? { ...q, text: val } : q));
                  }}
                />
              </div>
            ))}
            {drafts.length < 15 ? (
              <Button type="button" variant="outline" size="xs" className="w-full" onClick={() => setDrafts((prev) => [...prev, { label: "", text: "" }])}>
                + 添加常用语
              </Button>
            ) : null}
          </div>
          {error ? <p className="text-destructive text-[11px]">{error}</p> : null}
          <div className="flex items-center justify-between pt-1 border-t">
            <Button type="button" variant="ghost" size="xs" onClick={() => { setDrafts([...SUPPORT_QUICK_REPLIES]); setError(""); }}>
              恢复默认
            </Button>
            <div className="flex gap-1.5">
              <Button type="button" variant="outline" size="xs" onClick={() => { setEditing(false); setError(""); }}>
                取消
              </Button>
              <Button type="button" size="xs" onClick={() => {
                const cleaned = drafts.map((q) => ({ label: q.label.trim(), text: q.text.trim() })).filter((q) => q.label && q.text);
                if (!cleaned.length) { setError("至少保留一条有效常用语"); return; }
                try {
                  storeSupportQuickReplies(adminUserId, cleaned);
                  setQuickReplies(cleaned);
                  setEditing(false);
                  setError("");
                } catch {
                  setError("保存到本地失败，请检查浏览器存储空间");
                }
              }}>
                保存
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="im-wb-quick-replies" role="group" aria-label="常用语">
            {quickReplies.map((item) => (
              <button key={item.label} type="button" data-action="insert-quick-reply" onClick={() => { onInsert(item.text); setOpen(false); }}>
                <strong>{item.label}</strong><span>{item.text}</span>
              </button>
            ))}
          </div>
          <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground flex items-center justify-between">
            <span>仅本机保存</span>
            <button type="button" className="text-xs text-primary hover:underline" data-action="manage-quick-replies" onClick={() => { setDrafts(quickReplies); setError(""); setEditing(true); }}>
              管理常用语
            </button>
          </div>
        </>
      )}
    </PopoverContent>
  </Popover>;
}

export function SupportChatPane({ selected, selectedMessages, operatorName, operatorAvatar, profileScope, adminUserId, sessionId, permissions, onOpenPath, isMine, claimReady, canManageSupport, canTransfer, canOperateSelected, serverCanSend, busy, connection, sending, canEdit, canSend, sendBlocked, imageInFlight, closeOutcomeUnknown, blocked, detailsOpen, mobilePane, notice, activeAftersale, readOnlyReason, readOnlyPlaceholder, historyMore, historyState, historyLoading, selectedFailedText, selectedPending, selectedMedia, selectedReply, selectedStaged, draft, chatHeadingRef, closeTriggerRef, transferTriggerRef, detailsTriggerRef, composerRef, onBackToQueue, onClaim, onOpenClose, onOpenTransfer, onToggleDetails, onReconcile, onRetryHistory, onLoadEarlier, onRetryFailedText, onRetryPendingImage, onRemovePending, onRetryMedia, onRemoveMedia, onClearReply, onSend, onStageFiles, onStageMedia, onRemoveStaged, onDraftChange, onInsertText, onMessageContextMenu, messageLongPress, onOpenAftersale }: {
  selected: Consultation | null;
  selectedMessages: SupportMessage[];
  operatorName: string;
  operatorAvatar?: string | null;
  profileScope: ProfileScope;
  adminUserId: string;
  sessionId: string;
  permissions: readonly string[];
  onOpenPath?: (path: string, title?: string) => void;
  isMine: boolean;
  claimReady: boolean;
  canManageSupport: boolean;
  canTransfer: boolean;
  canOperateSelected: boolean;
  serverCanSend: boolean;
  busy: boolean;
  connection: string;
  sending: boolean;
  canEdit: boolean;
  canSend: boolean;
  sendBlocked: boolean;
  imageInFlight: boolean;
  closeOutcomeUnknown: boolean;
  blocked: boolean;
  detailsOpen: boolean;
  mobilePane: "queue" | "chat" | "details";
  notice?: string;
  activeAftersale: ActiveAftersale | null;
  readOnlyReason: string | null;
  readOnlyPlaceholder: string | null;
  historyMore: boolean;
  historyState: "loading" | "ready" | "error" | "forbidden" | undefined;
  historyLoading: boolean;
  selectedFailedText: FailedText | null;
  selectedPending: DraftImage | null;
  selectedMedia: MessageMediaDraft | null;
  selectedReply: SupportMessage | null;
  selectedStaged: DraftImage[];
  draft: string;
  chatHeadingRef: RefObject<HTMLElement | null>;
  closeTriggerRef: RefObject<HTMLButtonElement | null>;
  transferTriggerRef: RefObject<HTMLButtonElement | null>;
  detailsTriggerRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onBackToQueue: () => void;
  onClaim: () => void;
  onOpenClose: () => void;
  onOpenTransfer: () => void;
  onToggleDetails: () => void;
  onReconcile: () => void;
  onRetryHistory: () => void;
  onLoadEarlier: () => void;
  onRetryFailedText: () => void;
  onRetryPendingImage: () => void;
  onRemovePending: () => void;
  onRetryMedia: () => void;
  onRemoveMedia: () => void;
  onClearReply: () => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onStageFiles: (files: File[]) => void;
  onStageMedia: (file: File, kind: "video" | "file") => void;
  onRemoveStaged: (item: DraftImage) => void;
  onDraftChange: (value: string) => void;
  onInsertText: (insertion: string) => void;
  onMessageContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  messageLongPress: LongPress;
  onOpenAftersale: () => void;
}) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const composingRef = useRef(false);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const authorFor = (message: SupportMessage) => supportMessageAuthor(message, selected, operatorName, operatorAvatar);
  const userHoverCard = selected ? <div className="im-wb-author-hover">
    <ConsultationUserCard consultationId={selected.id} rowUserId={selected.user?.id ?? ""} fallbackName={selected.user?.name || selected.user?.username || "平台用户"}
      request={adminRequest} scope={profileScope}
      onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")} />
  </div> : null;
  const jumpToMessage = (messageId: string) => {
    const target = selectedMessages.find((message) => message.id === messageId || message.source?.messageServerId === messageId || message.source?.messageClientId === messageId);
    if (!target) return;
    const node = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === target.id);
    if (!node) return;
    node.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const targetNode = node.querySelector<HTMLElement>(".im-wb-bub") ?? node;
    targetNode.classList.add("message-quote-target");
    window.setTimeout(() => targetNode.classList.remove("message-quote-target"), 1600);
  };
  const emptyStreamState = (state: "loading" | "ready" | "error" | "forbidden" | undefined, hasSelection: boolean) => (
    hasSelection && state === "loading"
      ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
      : hasSelection && state === "error"
        ? <div className="im-wb-empty"><CircleAlert size={22} /><strong>消息读取失败</strong><span>已加载的消息仍保留。</span><button type="button" data-action="retry-history" onClick={onRetryHistory}>重新读取</button></div>
        : hasSelection && state === "forbidden"
          ? <div className="im-wb-empty"><ShieldCheck size={22} /><strong>无法查看该会话历史</strong></div>
          : <div className="im-wb-empty"><Headphones size={22} /><strong>{hasSelection ? "等待第一条消息" : "尚未选择会话"}</strong><span>{hasSelection ? "该会话暂时没有可读消息。" : "从左侧队列选择会话。"}</span></div>);

  let timelineDay = "";
  // Bot 欢迎/阶段卡已经说明建群或成员变化时，不再重复技术通知；没有 Bot 覆盖时保留一条兜底。
  const botAccountId = selected?.botAccountId ?? null;
  const noticeScope = selected?.type ?? "SERVICE";
  const timelineMessages = collapseImSystemNotices(selectedMessages, {
    hasBotMessage: Boolean(botAccountId && selectedMessages.some((message) => message.from !== "system" && !message.revoked && message.senderId === botAccountId)),
    noticeOf: (message) => message.notice ?? null,
  });
  const timelineItems = timelineMessages.map((message, index) => {
    const nodes = [];
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      timelineDay = dayKey;
      nodes.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><Marker className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
    }
    if (message.from === "system") {
      const label = message.notice ? imSystemNoticeLabel(message.notice.kind, noticeScope) : message.text;
      if (label === null) return nodes;
      nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} tabIndex={-1} onContextMenu={onMessageContextMenu} {...messageLongPress}><Marker className="im-wb-sys" variant="separator"><MarkerContent>{label}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
      return nodes;
    }
    const previous = timelineMessages[index - 1];
    const author = authorFor(message);
    const grouped = Boolean(author.role !== "机器人" && previous && previous.from !== "system" && previous.senderId === message.senderId && (message.createTime ?? 0) - (previous.createTime ?? 0) < GROUP_WINDOW_MS);
    const imageUrl = message.image ? supportedImageUrl(message.image.url) : null;
    const imageThumbnailUrl = message.image ? supportedImageUrl(message.image.thumbnailUrl) : null;
    const mine = message.self === true;
    nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"} tabIndex={-1} onContextMenu={onMessageContextMenu} {...messageLongPress}>
      <Message align={mine ? "end" : "start"} className="im-wb-msg" data-message-id={message.id} data-from={message.from} data-self={mine} data-grouped={grouped}>
        {author.role === "平台用户" && userHoverCard ? <EntityPreviewTrigger enableTouchButton={false} side="right" align="start" touchLabel={`预览用户 ${author.name}`} className="im-wb-author-preview"
          trigger={<button type="button" className="im-wb-av-button" aria-label={`查看用户 ${author.name}`}><MessageAvatar className="im-wb-av" aria-hidden="true"><ProfileImage src={author.avatar} fallback={initialOf(author.name)} /></MessageAvatar></button>}
          content={userHoverCard} /> : <MessageAvatar className="im-wb-av" aria-hidden="true">{author.role === "机器人" ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : <ProfileImage src={author.avatar} fallback={initialOf(author.name)} />}</MessageAvatar>}
        <MessageContent className="im-wb-msg-body">
          {grouped ? null : <MessageHeader className="im-wb-msg-meta">{author.role === "平台用户" && userHoverCard
            ? <EntityPreviewTrigger enableTouchButton={false} side="right" align="start" touchLabel={`预览用户 ${author.name}`} className="im-wb-author-preview"
                trigger={<button type="button" className="im-wb-author-name-trigger"><b>{author.name}</b></button>} content={userHoverCard} />
            : <b>{author.name}</b>}<span className="im-wb-role-tag" data-role={author.role}>{author.role}</span>{mine ? null : <time>{message.time}</time>}</MessageHeader>}
          <SupportMessageBody message={{ ...message.source, text: message.text, media: message.media, revoked: message.revoked }}
            image={message.image ? { url: imageUrl, thumbnailUrl: imageThumbnailUrl, name: message.image.name } : null}
            replySenderName={(() => { const target = selectedMessages.find((item) => item.id === message.source?.reply?.messageId || item.source?.messageServerId === message.source?.reply?.messageId || item.source?.messageClientId === message.source?.reply?.messageId); return target ? authorFor(target).name : null; })()}
            onJump={jumpToMessage} onOpenOrder={onOpenPath ? id => onOpenPath(`/orders/${encodeURIComponent(id)}`, "订单详情") : undefined}
            legacyScopeKey={`${adminUserId}:${sessionId}:${permissions.join(",")}:${selected?.id ?? ""}:${selected?.version ?? ""}:${selected?.state ?? ""}:${selected?.assignedAdmin?.id ?? ""}`}
            allowLegacyOrderOpen={profileScope.orders} resolveLegacyOrder={selected ? (id, signal) => adminRequest(`/im/consultations/${encodeURIComponent(selected.id)}/legacy-orders/${encodeURIComponent(id)}`, undefined, "GET", {}, signal) : undefined}
            align={mine ? "end" : "start"} />
          {mine && !message.revoked ? <MessageFooter className="im-wb-msg-status"><time>{message.time}</time><Check size={11} />已发送</MessageFooter> : null}
        </MessageContent>
      </Message>
    </MessageScrollerPrimitive.Item>);
    return nodes;
  }).flat();

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };
  const onComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type === "image/jpeg" || file.type === "image/png");
    if (files.length) { event.preventDefault(); onStageFiles(files); }
  };
  const onComposerDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) onStageFiles(files);
  };

  return <main className="im-wb-chat">
    <header className="im-wb-chat-head" ref={chatHeadingRef} tabIndex={-1} data-focus-target="chat">
      <button type="button" className="im-wb-back" data-action="back-to-queue" onClick={onBackToQueue}><ChevronLeft size={14} />队列</button>
      <span className="im-wb-chat-av" aria-hidden="true"><ProfileImage src={selected?.user?.avatar} fallback={initialOf(selected?.user?.name || selected?.user?.username || "客")} /></span>
      <div className="im-wb-chat-title">
        <h2>{selected ? `${selected.user?.name || selected.user?.username || "平台用户"} · ${typeLabel(selected.type)}` : "选择一条会话"}</h2>
        <span className="im-wb-chat-sub">{!selected ? "等待用户咨询" : roundHeadlineOf(selected)}</span>
      </div>
      <div className="im-wb-chat-actions">
        {claimReady && canManageSupport ? <ActionTooltip content="自动分配异常时由管理岗接管"><button type="button" className="im-wb-btn im-wb-btn-outline" data-action="claim-consultation" onClick={onClaim} disabled={busy || connection !== "CONNECTED"}>接管会话</button></ActionTooltip> : null}
        {claimReady && !canManageSupport ? <span className="im-wb-state">系统分配中…</span> : null}
        {selected && isMine && selected.messageScopeState !== "FAILED" ? <ActionTooltip content={!serverCanSend && canOperateSelected ? "本轮尚未就绪，暂不可结束" : undefined}><button ref={closeTriggerRef} type="button" data-action="close-consultation" className="im-wb-btn im-wb-btn-outline" onClick={onOpenClose} disabled={busy || !canOperateSelected || !serverCanSend || closeOutcomeUnknown || blocked}>{!canOperateSelected ? "无本类型接待权限" : closeOutcomeUnknown ? "结束结果未确认" : "结束本轮"}</button></ActionTooltip> : null}
        <button ref={transferTriggerRef} type="button" data-action="open-transfer" className="im-wb-btn im-wb-btn-outline" onClick={onOpenTransfer} disabled={!canTransfer || !selected || selected.state !== "ACTIVE" || !isMine || selected.messageScopeState !== "READY" || busy}>{canTransfer ? "转交" : "无转交权限"}</button>
        <ActionTooltip content={detailsOpen ? "收起会话详情" : "展开会话详情"}><button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-outline im-wb-btn-icon" aria-label={detailsOpen ? "收起会话详情" : "展开会话详情"} aria-expanded={detailsOpen} aria-controls="im-wb-details" data-action="toggle-details" onClick={onToggleDetails}><MoreHorizontal size={15} /></button></ActionTooltip>
      </div>
    </header>
    {readOnlyReason ? <p className="im-wb-scope-note" data-tone="readonly" data-action="support-readonly" role="status"><ShieldCheck size={13} />{readOnlyReason}</p> : null}
    {activeAftersale && selected?.threadId === activeAftersale.threadId ? <p className="im-wb-notice" role="status">当前跟进售后：订单 {activeAftersale.orderDisplayNo ?? "—"} · {activeAftersale.id}<button type="button" className="im-wb-link" onClick={onOpenAftersale}>查看售后记录</button>{onOpenPath ? <button type="button" className="im-wb-link" onClick={() => onOpenPath(`/orders/${activeAftersale.orderId}`)}>订单详情</button> : null}</p> : null}
    {notice && (notice !== ROUND_CLOSED_NOTICE || selected?.state === "CLOSED") ? <p className="im-wb-notice" role="status"><CircleAlert size={14} />{notice}</p> : null}
    {selected && closeOutcomeUnknown ? <p className="im-wb-notice" data-tone="warn" role="status"><CircleAlert size={14} />{CLOSE_OUTCOME_UNKNOWN_NOTICE}</p> : null}
    <div className="im-wb-stream-wrap">
      {selected?.messageScopeState === "FAILED" ? <div className="im-wb-empty"><CircleAlert size={22} /><strong>会话待人工核验</strong><span>请先完成核验再回复。</span>{selected.assignedAdmin?.id === adminUserId && canTransfer ? <button type="button" className="im-wb-btn" data-action="reconcile-consultation" onClick={onReconcile} disabled={busy}>核验并恢复</button> : null}</div>
        : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor">
          <MessageScrollerPrimitive.Root className="im-wb-scroller">
            <MessageScrollerPrimitive.Viewport preserveScrollOnPrepend className="im-wb-viewport" aria-label="会话消息" onContextMenu={onMessageContextMenu}><MessageScrollerPrimitive.Content className="im-wb-content">
              {selectedMessages.length ? <>
                {selected && historyMore ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="im-wb-history-more"><button type="button" onClick={onLoadEarlier} disabled={historyLoading}>{historyLoading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}
                {timelineItems}
              </> : <MessageScrollerPrimitive.Item messageId="empty">{emptyStreamState(selected ? historyState : undefined, Boolean(selected))}</MessageScrollerPrimitive.Item>}
            </MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport>
            <ActionTooltip content="跳到最新消息"><MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button></ActionTooltip>
          </MessageScrollerPrimitive.Root>
        </MessageScrollerPrimitive.Provider>}
    </div>
    {selectedFailedText ? <p className="im-wb-pending" role="status"><CircleAlert size={13} />发送结果未确认，草稿已保留。<button type="button" data-action="retry-text" onClick={onRetryFailedText} disabled={busy || !canSend}>{selectedFailedText.messageClientId ? "原消息重试" : "刷新历史核对"}</button></p> : null}
    {selectedPending ? <div className="im-wb-draft" data-state={selectedPending.state}>
      <img src={selectedPending.previewUrl} alt={selectedPending.name} />
      <span>{selectedPending.name} · {formatBytes(selectedPending.size)} · {selectedPending.state === "SENDING" ? `上传中 ${selectedPending.progress}%` : selectedPending.state === "UNKNOWN" ? "结果未确认" : "发送失败"}</span>
      <button type="button" onClick={onRetryPendingImage} disabled={sending || imageInFlight || !canSend}>{selectedPending.messageClientId ? "原消息重试" : "重试"}</button>
      <ActionTooltip content={selectedPending.state === "UNKNOWN" ? "结果未确认时不可移除原图片" : undefined}><span className="im-wb-tooltip-anchor"><button type="button" onClick={onRemovePending} disabled={sendBlocked || !canSend || selectedPending.state === "UNKNOWN"}>移除</button></span></ActionTooltip>
    </div> : null}
    {selectedMedia ? <MediaDraftBar draft={selectedMedia} onRetry={onRetryMedia} onRemove={onRemoveMedia} disabled={busy || sending} /> : null}
    {selectedReply ? <MessageReplyQuote label={replySummaryOf(selectedReply)} onCancel={onClearReply} /> : null}
    <form className="im-wb-composer" onSubmit={onSend} onDragOver={(event) => event.preventDefault()} onDrop={onComposerDrop}>
      {selectedStaged.length ? <AttachmentGroup className="im-wb-tray">{selectedStaged.map((item, idx) => <Attachment key={item.key} className="im-wb-tray-item" data-state={item.state} state={item.state === "DECODING" ? "processing" : "idle"} size="xs">
        <AttachmentMedia variant="image"><img src={item.previewUrl} alt="" /></AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{selectedStaged.length > 1 ? `${idx + 1}. ` : ""}{item.name}</AttachmentTitle>
          <AttachmentDescription>{item.state === "DECODING" ? "检查中" : "待发送"}</AttachmentDescription>
        </AttachmentContent>
        <AttachmentAction data-action="remove-staged" onClick={() => onRemoveStaged(item)} disabled={sendBlocked} aria-label={`移除 ${item.name}`}>×</AttachmentAction>
      </Attachment>)}
        <span className="im-wb-tray-count">{selectedStaged.length + (selectedPending ? 1 : 0)}/{MAX_STAGED_IMAGES}</span></AttachmentGroup> : null}
      <InputGroup className="im-wb-composer-box">
        <InputGroupTextarea ref={composerRef} value={draft} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={onComposerKeyDown} onPaste={onComposerPaste}
          onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
          aria-label="输入客服消息" rows={3}
          placeholder={!selected ? "从左侧选择会话" : selected.state === "WAITING" ? "接入会话后可回复" : selected.state === "ACTIVE" && !isMine ? readOnlyPlaceholder ?? "仅负责客服可发送消息" : selected.messageScopeState === "FAILED" ? messageScopeLabel("FAILED") : connection !== "CONNECTED" ? "消息通道未连接，草稿会保留" : "输入回复…"}
          disabled={!canEdit} />
        <InputGroupAddon align="block-end" className="im-wb-composer-tools">
          <TooltipProvider delay={200}>
            <SupportQuickReplies adminUserId={adminUserId} disabled={!canEdit || sendBlocked} onInsert={onInsertText} />
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <Tooltip>
                <TooltipTrigger render={<PopoverTrigger render={<button type="button" className="im-wb-tool" aria-label="表情" disabled={!canEdit || sendBlocked}><Smile size={15} /></button>} />} />
                <TooltipContent>表情</TooltipContent>
              </Tooltip>
              <PopoverContent side="top" align="start" className="w-auto p-0"><div className="chat-emoji-grid">
                {CHAT_EMOJIS.map((item) => <button key={item.emoji} type="button" className="chat-emoji-button" aria-label={item.label} onClick={() => { onInsertText(item.emoji); setEmojiOpen(false); }}>{item.emoji}</button>)}
              </div></PopoverContent>
            </Popover>
            <Tooltip>
              <TooltipTrigger render={<label className="im-wb-tool" aria-label="发送图片" />}>
                <Images size={15} /><input type="file" accept="image/jpeg,image/png" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; onStageFiles(files); }} disabled={!canEdit || sendBlocked} />
              </TooltipTrigger>
              <TooltipContent>发送图片</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<button type="button" className="im-wb-tool" aria-label="发送视频" onClick={() => videoInputRef.current?.click()} disabled={!canEdit || sendBlocked} />}><Video size={15} /></TooltipTrigger>
              <TooltipContent>发送视频</TooltipContent>
            </Tooltip>
            <input ref={videoInputRef} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onStageMedia(file, "video"); }} disabled={!canEdit || sendBlocked || selectedMedia?.state === "UNKNOWN"} />
            <Tooltip>
              <TooltipTrigger render={<button type="button" className="im-wb-tool" aria-label="发送文件" onClick={() => fileInputRef.current?.click()} disabled={!canEdit || sendBlocked} />}><FileText size={15} /></TooltipTrigger>
              <TooltipContent>发送文件</TooltipContent>
            </Tooltip>
            <input ref={fileInputRef} type="file" accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onStageMedia(file, "file"); }} disabled={!canEdit || sendBlocked || selectedMedia?.state === "UNKNOWN"} />
          </TooltipProvider>
          <span className="im-wb-hint im-wb-hint-right"><Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行</span>
          <button type="submit" className="im-wb-send" disabled={!canSend || busy || sendBlocked || (!draft.trim() && !selectedStaged.length && !(selectedPending?.state === "FAILED") && selectedMedia?.state !== "READY")}>{busy ? "处理中…" : "发送"}</button>
        </InputGroupAddon>
      </InputGroup>
    </form>
  </main>;
}

/** 会话详情右栏：用户与风险摘要、真实事件投影、轮次时间线与授权恢复入口。 */
export function SupportDetailsPane({ selected, profileScope, onOpenPath, blocked, busy, detailsOpen, onClose, onRefreshAccess }: {
  selected: Consultation | null;
  profileScope: ProfileScope;
  onOpenPath?: (path: string, title?: string) => void;
  blocked: boolean;
  busy: boolean;
  detailsOpen: boolean;
  onClose: () => void;
  onRefreshAccess: () => void;
}) {
  return <aside id="im-wb-details" className="im-wb-details" aria-label="会话详情" hidden={!detailsOpen}>
    <div className="im-wb-details-head"><strong>会话详情</strong><button type="button" className="im-wb-btn im-wb-btn-icon im-wb-details-back" data-action="back-to-chat" onClick={onClose}>返回会话</button></div>
    {!selected ? <p className="im-wb-details-empty">未选择会话</p> : <>
      {/* 会话类型、状态与当前接待已在聊天头部；右栏不再重复「本次服务」，第一屏从用户与
          风险摘要开始。处理记录只陈列真实事件投影，不按当前状态推断历史；投诉的额外摘要
          只使用现有投影并逐项标注缺口。 */}
      <ConsultationUserCard key={selected.id} consultationId={selected.id} rowUserId={selected.user?.id ?? ""} fallbackName={selected.user?.name || selected.user?.username || "平台用户"}
        request={adminRequest} scope={profileScope}
        onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")} />
      <ConsultationEventsCard key={`${selected.id}:events`} consultationId={selected.id} request={adminRequest} />
      <ConsultationRoundsTimeline key={`${selected.id}:rounds`} consultationId={selected.id} currentRoundId={selected.id} request={adminRequest} />
      {blocked ? <section className="im-wb-sec"><span>授权状态</span><small>发送权限已失效</small>
        <button type="button" className="im-wb-btn" data-action="refresh-consultation-access" onClick={onRefreshAccess} disabled={busy || !selected.conversationId}>重新确认当前授权</button></section> : null}
    </>}
  </aside>;
}