"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ChevronLeft, ChevronRight, CircleAlert, Headphones, Images, MoreHorizontal, Search, Smile } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { decodeImSystemNotice } from "@zzsh/im-client/message-state";
import type { NimMessageLike, NimWebClientLike, NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import {
  OrderTeamPanel, escalationStateLabel, orderTeamLabel, orderTeamMemberRole,
  type OrderTeamAccess, type OrderTeamAsideView, type OrderTeamConversationView, type OrderTeamListItem, type OrderTeamListView,
} from "@zzsh/ui/order-team-panel";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatBytes, formatDateTime, formatTime, initialOf } from "./im-support-format";
import { CHAT_EMOJIS, MessageQuoted, MessageReplyQuote } from "@zzsh/ui/message-actions";
import "@zzsh/ui/message-actions.css";
import { MediaDraftBar, MediaMessage, mediaMessageOf } from "@zzsh/ui/message-media";
import "@zzsh/ui/message-media.css";
import { OrderCardMessage } from "@zzsh/ui/order-card";
import { OrderFulfillmentSection } from "./im-support-fulfillment";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../components/ui/input-group";
import { Kbd } from "../components/ui/kbd";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../components/ui/attachment";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import "@zzsh/ui/order-team.css";
import "./im-order-rail.css";

const GROUP_WINDOW_MS = 300_000;
const MAX_STAGED_IMAGES = 6;
const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件" };

type Requester = <T>(path: string) => Promise<T>;

/** Exact integer cents only; anything else stays unknown and is never rendered as 0. */
function centsOf(value: string | null | undefined): bigint | null {
  return typeof value === "string" && /^(0|[1-9]\d{0,17})$/.test(value) ? BigInt(value) : null;
}

function quantityOf(value: string): bigint | null {
  return /^(0|[1-9]\d{0,18})$/.test(value) ? BigInt(value) : null;
}

function grouped(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function yuanOf(cents: bigint): string {
  const text = cents.toString().padStart(3, "0");
  return `¥${grouped(BigInt(text.slice(0, -2)))}.${text.slice(-2)}`;
}

function imageOf(message: NimMessageLike): { url: string | null; name: string } | null {
  if (message.messageType !== 1) return null;
  const attachment = message.attachment;
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return null;
  const record = attachment as { url?: unknown; thumbUrl?: unknown; name?: unknown };
  const url = supportedImageUrl(record.url) ?? supportedImageUrl(record.thumbUrl);
  return { url, name: typeof record.name === "string" ? record.name : "订单图片" };
}

/** 发送者署名只认成员表：映射缺失时中性降级，绝不借用当前接待者或买家的身份。 */
function authorOf(info: OrderTeamAccess, senderId: string, accountId: string, operatorName: string) {
  const member = info.members.find((item) => item.accountId === senderId);
  if (senderId === accountId) return { name: member?.name?.trim() || operatorName, role: member ? orderTeamMemberRole(member) : "平台客服" };
  if (!member) return { name: "未署名成员", role: null as string | null };
  return { name: member.name?.trim() || orderTeamMemberRole(member), role: orderTeamMemberRole(member) };
}

/** 终态订单的阶段文案只说明“已结束”，不退回过分配/匹配等过程词。 */
function orderStageLabel(order: Parameters<typeof orderTeamLabel>[0]): string {
  const status = order.orderStatus ?? order.status;
  if (status === "COMPLETED") return "已完成 · 已结束";
  if (status === "CANCELLED") return "已取消 · 已结束";
  return orderTeamLabel(order);
}

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="im-rail-section">
    <h3 className="im-rail-section-title">{title}</h3>
    <div className="im-rail-section-body">{children}</div>
  </section>;
}

/** 时间只取服务端值；不可解析时直说，不用本地时钟补一个看起来像事实的时间。 */
function serverTime(value: string): string {
  return formatDateTime(value);
}

/**
 * Admin order workbench: the shared order-team panel keeps every read,
 * authorization, draft and send decision; this module only decides how the
 * loaded facts are presented in the three-column case workspace.
 */
export function OrderWorkbenchPane({ identity, adminUserId, operatorName, client, connection, active, sendAllowed, canManualClose, request, onAuthError }: {
  identity: string;
  adminUserId: string;
  operatorName: string;
  client: NimWebClientLike | null;
  connection: NimWebConnectionState | "idle" | "error";
  active: boolean;
  sendAllowed: boolean;
  canManualClose?: boolean;
  request: Requester;
  onAuthError: (status: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const orderComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [pane, setPane] = useState<"list" | "chat" | "details">("list");
  const [imageErrors, setImageErrors] = useState<Record<string, number>>({});
  const chatHeadingRef = useRef<HTMLElement | null>(null);
  const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousPaneRef = useRef(pane);
  const selectedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const orderVideoInput = useRef<HTMLInputElement | null>(null);
  const orderFileInput = useRef<HTMLInputElement | null>(null);
  const onComposerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, []);

  const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
  useEffect(() => { setPane("list"); setQuery(""); setImageErrors({}); }, [identity]);
  const openDetails = () => { setDetailsOpen(true); if (isNarrow()) setPane("details"); };
  const closeDetails = () => {
    const narrow = isNarrow();
    setDetailsOpen(false);
    if (!narrow) { detailsTriggerRef.current?.focus(); return; }
    setPane(selectedRef.current ? "chat" : "list");
    requestAnimationFrame(() => {
      (selectedRef.current ? chatHeadingRef.current : document.querySelector<HTMLElement>('.im-wb-pane--orders .im-wb-queue [data-active="true"]'))?.focus();
    });
  };

  useEffect(() => {
    if (previousPaneRef.current === pane) return;
    previousPaneRef.current = pane;
    if (!isNarrow()) return;
    const target = pane === "chat"
      ? chatHeadingRef.current
      : pane === "details"
        ? document.querySelector<HTMLElement>('[data-action="collapse-order-details"]')
        : document.querySelector<HTMLElement>('.im-wb-pane--orders .im-wb-queue [data-active="true"]') ?? document.querySelector<HTMLElement>(".im-wb-pane--orders .im-wb-queue .im-wb-row");
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof Node && target.contains(active)) return;
    target.focus();
  }, [pane]);

  const renderList = ({ items, selectedId, onSelect, loading, refreshing, nextCursor, onLoadMore }: OrderTeamListView) => {
    selectedRef.current = selectedId;
    const text = query.trim().toLowerCase();
    const rows = text ? items.filter((row: OrderTeamListItem) => `${row.title} ${row.displayNo} ${orderStageLabel(row)}`.toLowerCase().includes(text)) : items;
    return (
      <aside className="im-wb-queue" aria-label="我参与的订单群">
        <div className="im-wb-queue-head"><strong>我参与的订单群</strong><b>{items.length}</b></div>
        <label className="im-wb-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索筛选当前列表" aria-label="搜索订单群" /></label>
        <p className="im-wb-filter-note">仅筛选本机已加载的订单群，计数不代表全部；「我参与的」即当前目录已授权的群。</p>
        <div className="im-wb-rows">
          {loading && !items.length ? <p className="im-wb-list-empty"><strong>正在读取订单群…</strong></p> : null}
          {rows.map((row) => {
            const ended = row.status === "COMPLETED" || row.status === "CANCELLED";
            const fact = !ended && row.teamState === "READY"
              ? row.firstResponseOverdue ? "首响超时" : escalationStateLabel(row.escalationState ?? "NOT_STARTED", row.firstResponseAt ?? null)
              : null;
            const todo = !ended ? row.todo ?? null : null;
            const due = !ended && row.dueAt ? `到期 ${serverTime(row.dueAt)}` : null;
            return (
              <button type="button" key={row.id} className="im-wb-row" data-active={selectedId === row.id} aria-current={selectedId === row.id ? "page" : undefined}
                onClick={() => { setImageErrors({}); onSelect(row.id); setPane("chat"); }}>
                <span className="im-wb-row-av" aria-hidden="true">{initialOf(row.title)}</span>
                <span className="im-wb-row-copy">
                  <span className="im-wb-row-top"><b>{row.title}</b><i className="im-wb-tag">{row.displayNo}</i></span>
                  <span className="im-wb-row-snip">{orderStageLabel(row)}</span>
                  {todo || due || fact ? <span className="im-wb-row-foot">
                    {todo ? <em data-tone="todo">{todo}</em> : null}
                    {due ? <small>{due}</small> : null}
                    {fact ? <em data-tone={row.firstResponseOverdue ? "warn" : undefined}>{fact}</em> : null}
                  </span> : null}
                </span>
              </button>
            );
          })}
          {!rows.length && items.length ? <p className="im-wb-list-empty"><strong>当前列表没有匹配订单群</strong><span>试试其他账号名称或订单编号。</span></p> : null}
          {nextCursor ? <button type="button" className="im-wb-more" disabled={loading || refreshing} onClick={onLoadMore}>{refreshing ? "正在读取…" : "更多订单群"}</button> : null}
        </div>
      </aside>
    );
  };

  const renderConversation = (view: OrderTeamConversationView) => {
    const { info, messages } = view;
    const jumpToMessage = (messageId: string) => {
      const target = messages.find((message) => message.id === messageId || message.messageClientId === messageId || message.messageServerId === messageId);
      if (!target) return;
      const node = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === target.id);
      if (!node) return;
      node.scrollIntoView?.({ block: "center", behavior: "smooth" });
      const targetNode = node.querySelector<HTMLElement>(".im-wb-bub") ?? node;
      targetNode.classList.add("message-quote-target");
      window.setTimeout(() => targetNode.classList.remove("message-quote-target"), 1600);
    };
    const insertEmoji = (emoji: string) => {
      const el = orderComposerRef.current;
      const start = el?.selectionStart ?? view.draft.length;
      const end = el?.selectionEnd ?? start;
      const next = `${view.draft.slice(0, start)}${emoji}${view.draft.slice(end)}`;
      if (next.length > 4000) return;
      view.setDraft(next);
      setEmojiOpen(false);
      requestAnimationFrame(() => {
        el?.focus();
        const position = start + emoji.length;
        el?.setSelectionRange(position, position);
      });
    };
    const scope = info.members.map((member) => orderTeamMemberRole(member));
    const visibleScope = [...new Set(scope)].join("、");
    let timelineDay = "";
    const items = messages.map((message, index) => {
      const nodes = [];
      const dayKey = dayKeyOf(message.createTime);
      if (dayKey && dayKey !== timelineDay) {
        timelineDay = dayKey;
        nodes.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><Marker className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
      }
      const notice = decodeImSystemNotice(message);
      if (notice) {
        nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id}><Marker className="im-wb-sys" variant="separator"><MarkerContent>{notice.text}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
        return nodes;
      }
      const previous = messages[index - 1];
      const grouped = Boolean(previous && !decodeImSystemNotice(previous) && previous.senderId === message.senderId && (message.createTime ?? 0) - (previous.createTime ?? 0) < GROUP_WINDOW_MS);
      const self = message.senderId === view.accountId;
      const author = authorOf(info, message.senderId, view.accountId, operatorName);
      const card = message.card;
      const media = mediaMessageOf(message);
      const image = imageOf(message);
      const imageUrl = image?.url ?? null;
      const failed = Boolean(imageUrl && imageErrors[message.id]);
      const revoked = message.revoked === true;
      const text = typeof message.text === "string" && message.text.trim() ? message.text : message.messageType === 0 || image || media ? "" : "暂不支持展示的消息类型";
      nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={!self}>
        <Message align={self ? "end" : "start"} className="im-wb-msg" data-self={self} data-grouped={grouped} data-message-id={message.id} onContextMenu={view.menuHandlers.onContextMenu} {...view.menuHandlers.longPress}>
          <MessageAvatar className="im-wb-av" aria-hidden="true">{initialOf(author.name)}</MessageAvatar>
          <MessageContent className="im-wb-msg-body" data-card={card ? "true" : undefined}>
            {grouped ? null : <MessageHeader className="im-wb-msg-meta"><b>{author.name}</b>{author.role ? <span className="im-wb-role-tag" data-role={author.role}>{author.role}</span> : null}{self ? null : <time>{formatTime(message.createTime)}</time>}</MessageHeader>}
            {revoked ? <Bubble align={self ? "end" : "start"} variant={self ? "default" : "secondary"}>
              <BubbleContent className="im-wb-bub" data-revoked="true">消息已撤回</BubbleContent>
            </Bubble> : card ? <OrderCardMessage message={message} info={info} onOpenOrder={() => { window.location.assign(`/orders/${encodeURIComponent(info.orderId)}`); }} /> : <Bubble align={self ? "end" : "start"} variant={self ? "default" : "secondary"}>
              <BubbleContent className="im-wb-bub">
                {media ? <MediaMessage media={media}/> : image ? (imageUrl
                ? (failed
                  ? <button type="button" className="im-wb-thumb im-wb-thumb-failed" onClick={() => setImageErrors((current) => { const next = { ...current }; delete next[message.id]; return next; })} aria-label={`重新加载图片 ${image.name}`}>图片加载失败 · 点击重试</button>
                  : <button type="button" className="im-wb-thumb" aria-label={`查看图片 ${image.name}`} onClick={(event) => view.openImage(imageUrl, image.name, event.currentTarget)}><img src={imageUrl} alt={image.name} loading="lazy" onError={() => setImageErrors((current) => ({ ...current, [message.id]: Date.now() }))} /></button>)
                : <span className="im-wb-thumb-missing">图片暂不可预览</span>) : text}
                {message.reply ? <MessageQuoted text={message.reply.text ?? "消息"} senderName={info.members.find((member) => member.accountId === message.reply!.senderId)?.name?.trim() || null} onJump={() => jumpToMessage(message.reply!.messageId)} /> : null}
              </BubbleContent>
            </Bubble>}
            {self && !card && !revoked ? <MessageFooter className="im-wb-msg-status"><time>{formatTime(message.createTime)}</time><span>已发送</span></MessageFooter> : null}
          </MessageContent>
        </Message>
      </MessageScrollerPrimitive.Item>);
      return nodes;
    }).flat();

    return (
      <div className="im-wb-chat">
        <header className="im-wb-chat-head" ref={chatHeadingRef} tabIndex={-1}>
          <button type="button" className="im-wb-back" data-action="back-to-order-list" onClick={() => setPane("list")}><ChevronLeft size={14} />列表</button>
          <span className="im-wb-chat-av" aria-hidden="true">{initialOf(info.account.title)}</span>
          <div className="im-wb-chat-title">
            <h2><span className="im-wb-chat-user">{info.gameName} · 订单 {info.displayNo}</span></h2>
            <span>{info.account.title} · {visibleScope || "群内成员"}共同可见</span>
          </div>
          <div className="im-wb-chat-actions">
            <span className="im-wb-state">成员 {info.members.length}</span>
            <button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-icon" data-action="toggle-order-details" aria-label={detailsOpen ? "收起本单详情" : "展开本单详情"} aria-expanded={detailsOpen} aria-controls="im-order-details"
              onClick={() => { if (detailsOpen) closeDetails(); else openDetails(); }}><MoreHorizontal size={15} /></button>
          </div>
        </header>
        {view.error ? <p className="im-wb-notice" data-tone="warn" role="alert"><CircleAlert size={14} />{view.error}</p> : null}
        <div className="im-wb-stream-wrap">
          <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor">
            <MessageScrollerPrimitive.Root className="im-wb-scroller">
              <MessageScrollerPrimitive.Viewport className="im-wb-viewport" aria-label="订单群消息">
                <MessageScrollerPrimitive.Content className="im-wb-content">
                  {view.hasMore && messages.length ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="im-wb-history-more"><button type="button" disabled={view.reading} onClick={view.onLoadEarlier}>{view.reading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}
                  {items.length ? items : <MessageScrollerPrimitive.Item messageId="empty">{view.reading
                    ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
                    : <div className="im-wb-empty"><Headphones size={22} /><strong>本单群还没有可读消息</strong><span>连接状态：{view.connection === "CONNECTED" ? "已连接" : view.connection === "RECONNECTING" ? "网络中断，正在重连" : "连接不可用"}。</span><button type="button" onClick={view.onRefresh}>重新读取</button></div>}</MessageScrollerPrimitive.Item>}
                </MessageScrollerPrimitive.Content>
              </MessageScrollerPrimitive.Viewport>
              <MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>
            </MessageScrollerPrimitive.Root>
          </MessageScrollerPrimitive.Provider>
        </div>
        {view.textRetry ? <p className="im-wb-pending" role="status"><CircleAlert size={13} />上一条文字发送结果未确认，草稿已保留。<button type="button" data-action="order-retry-text" onClick={view.onRetryText} disabled={view.sending || !view.canSend || !view.textRetry.messageClientId}>原消息重试</button></p> : null}
        {view.pendingImage ? <div className="im-wb-draft" data-state={view.pendingImage.state}>
          <img src={view.pendingImage.previewUrl} alt={view.pendingImage.name} />
          <span>{view.pendingImage.name} · {formatBytes(view.pendingImage.size)} · {view.pendingImage.state === "SENDING" ? `上传中 ${view.pendingImage.progress}%` : view.pendingImage.state === "UNKNOWN" ? "结果未确认" : view.pendingImage.state === "FAILED" ? "发送失败" : "待发送"}</span>
          <button type="button" onClick={view.onRetryPendingImage} disabled={view.sending || view.isImageSending || !view.canSend}>{view.pendingImage.messageClientId ? "原消息重试" : "重试"}</button>
          <button type="button" onClick={view.onRemovePending} disabled={view.sending || view.isImageSending || view.pendingImage.state === "UNKNOWN" || !view.canSend} title={view.pendingImage.state === "UNKNOWN" ? "结果未确认时不可移除原图片" : undefined}>移除</button>
        </div> : null}
        {view.mediaDraft ? <MediaDraftBar draft={view.mediaDraft} onRetry={view.onRetryMedia} onRemove={view.onRemoveMedia} disabled={view.sending}/> : null}
        {view.replyLabel ? <MessageReplyQuote label={view.replyLabel} onCancel={view.onCancelReply} /> : null}
        {!view.canSend ? <div className="im-wb-composer im-wb-composer-readonly" role="status"><CircleAlert size={14} aria-hidden="true" />{info.orderStatus === "COMPLETED" || info.orderStatus === "CANCELLED" ? "本单已结束，仅可查看历史消息" : "当前只可阅读本单消息；历史与草稿会保留"}</div> : <form className="im-wb-composer" onSubmit={(event) => { event.preventDefault(); void view.onSubmit(event); }}>
          {view.stagedImages.length ? <AttachmentGroup className="im-wb-tray">{view.stagedImages.map((item, idx) => <Attachment key={item.previewUrl} className="im-wb-tray-item" data-state={item.state} state={item.state === "DECODING" ? "processing" : "idle"} size="xs">
            <AttachmentMedia variant="image"><img src={item.previewUrl} alt="" /></AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{view.stagedImages.length > 1 ? `${idx + 1}. ` : ""}{item.name}</AttachmentTitle>
              <AttachmentDescription>{item.state === "DECODING" ? "检查中" : "待发送"}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentAction data-action="order-remove-staged" onClick={() => view.onRemoveStaged(item.previewUrl)} disabled={view.sending || view.isImageSending} aria-label={`移除 ${item.name}`}>×</AttachmentAction>
          </Attachment>)}
            <span className="im-wb-tray-count">{view.stagedImages.length + (view.pendingImage ? 1 : 0)}/{MAX_STAGED_IMAGES}</span></AttachmentGroup> : null}
          <InputGroup className="im-wb-composer-box">
            <InputGroupTextarea ref={orderComposerRef} value={view.draft} onChange={(event) => view.setDraft(event.target.value)} onKeyDown={onComposerKeyDown}
              onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
              aria-label="输入订单群消息" rows={3} maxLength={4000}
              placeholder={!view.canSend ? "当前只可阅读，草稿会保留" : view.connection !== "CONNECTED" ? "云信通道未连接，草稿会保留" : "输入消息…"}
              disabled={!view.canSend} />
            <InputGroupAddon align="block-end" className="im-wb-composer-tools">
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger render={<button type="button" className="im-wb-tool" aria-label="表情" disabled={!view.canSend || view.imageBlocked || view.isImageSending} />}><Smile size={14} /></PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-auto p-0"><div className="chat-emoji-grid">
                  {CHAT_EMOJIS.map((item) => <button key={item.emoji} type="button" className="chat-emoji-button" aria-label={item.label} onClick={() => insertEmoji(item.emoji)}>{item.emoji}</button>)}
                </div></PopoverContent>
              </Popover>
              <label className="im-wb-tool"><Images size={14} />图片<input type="file" accept="image/jpeg,image/png" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; view.onStageFiles(files); }} disabled={!view.canSend || view.imageBlocked || view.isImageSending || view.isMediaSending} /></label>
              <button type="button" className="im-wb-tool" aria-label="发送视频" onClick={() => orderVideoInput.current?.click()} disabled={!view.canSend || view.imageBlocked || view.isImageSending || view.isMediaSending}>视频</button>
              <input ref={orderVideoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) view.onStageMedia(file, "video"); }} disabled={!view.canSend || view.isImageSending || view.isMediaSending || view.mediaDraft?.state === "UNKNOWN"} />
              <button type="button" className="im-wb-tool" aria-label="发送文件" onClick={() => orderFileInput.current?.click()} disabled={!view.canSend || view.imageBlocked || view.isImageSending || view.isMediaSending}>文件</button>
              <input ref={orderFileInput} type="file" accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) view.onStageMedia(file, "file"); }} disabled={!view.canSend || view.isImageSending || view.isMediaSending || view.mediaDraft?.state === "UNKNOWN"} />
              <button type="button" className="im-wb-tool" data-action="order-insert-summary" disabled={!view.canSend}
                onClick={() => view.setDraft(`${view.draft ? `${view.draft}\n` : ""}【本单信息】${info.account.title}（订单 ${info.displayNo}）`)}>本单信息</button>
              <span className="im-wb-hint im-wb-hint-right"><Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行</span>
              <button type="submit" className="im-wb-send" disabled={!view.canSend || view.connection !== "CONNECTED" || view.sending || view.isImageSending || view.isMediaSending || view.imageBlocked || (!view.draft.trim() && !view.stagedImages.length && !(view.pendingImage?.state === "FAILED") && view.mediaDraft?.state !== "READY")}>{view.sending ? "发送中…" : "发送"}</button>
            </InputGroupAddon>
          </InputGroup>
        </form>}
      </div>
    );
  };

  const renderAside = ({ info }: OrderTeamAsideView) => {
    const frozen = info.frozenInventory ?? [];
    const quote = info.terms && info.terms.basis === "QUOTE" ? info.terms : null;
    const termsByItem = new Map((quote?.lines ?? []).map((line) => [line.itemId, line]));
    const amountOf = (line: { itemId: string }) => centsOf(termsByItem.get(line.itemId)?.buyerAmount);
    const sumQuantity = (lines: typeof frozen): bigint | null => {
      let total: bigint | null = 0n;
      for (const line of lines) {
        const quantity = quantityOf(line.quantity);
        if (quantity === null) return null;
        if (total !== null) total += quantity;
      }
      return lines.length ? total : null;
    };
    const sumAmount = (lines: typeof frozen): bigint | null => {
      let total: bigint | null = 0n;
      for (const line of lines) {
        const cents = amountOf(line);
        if (cents === null) return null;
        if (total !== null) total += cents;
      }
      return lines.length ? total : null;
    };
    // 数量 0 只表示没有这一项：不进摘要、不计入合计，也不标异常。
    const visible = frozen.filter((line) => quantityOf(line.quantity) !== 0n);
    const coinLines = visible.filter((line) => line.unit === "HAFF_BASE");
    const itemLines = visible.filter((line) => line.unit !== "HAFF_BASE");
    const coinQuantity = sumQuantity(coinLines);
    const coinAmount = sumAmount(coinLines);
    const itemAmount = sumAmount(itemLines);
    const buyer = info.members.find((member) => member.party === "BUYER");
    const owner = info.members.find((member) => member.party === "OWNER");
    const partyRow = (role: string, member: typeof buyer) => (
      <div className="im-rail-party" key={role}>
        <span className="im-rail-party-role">{role}</span>
        <span className="im-rail-party-name">{member ? member.name?.trim() || "未署名" : "成员表未列"}</span>
      </div>
    );
    const ended = info.orderStatus === "COMPLETED" || info.orderStatus === "CANCELLED";
    const amountUnknown = quote !== null && (
      (coinLines.length > 0 && coinAmount === null) || (itemLines.length > 0 && itemAmount === null)
    );
    return (
      <aside id="im-order-details" className="order-team-aside im-wb-details" aria-label="本单详情" hidden={!detailsOpen}>
        <div className="im-wb-details-head"><strong>本单详情</strong></div>
        <div className="im-order-rail">
          <RailSection title="账号价值">
            {visible.length ? <>
              <div className="im-rail-value">
                {coinLines.length ? <div className="im-rail-value-line" data-kind="haff">
                  <span className="im-rail-value-name">哈夫币</span>
                  <span className="im-rail-value-figures">
                    <b>{coinQuantity === null ? "数量待核对" : `${grouped(coinQuantity)} 哈夫币`}</b>
                    <em data-unknown={coinAmount === null ? "true" : undefined}>{coinAmount === null ? "金额待核对" : yuanOf(coinAmount)}</em>
                  </span>
                </div> : null}
                {itemLines.length ? <>
                  <div className="im-rail-value-line" data-kind="items">
                    <span className="im-rail-value-name">物品资源 · {itemLines.length} 项</span>
                    <span className="im-rail-value-figures">
                      <em data-unknown={itemAmount === null ? "true" : undefined}>{itemAmount === null ? "总价待核对" : yuanOf(itemAmount)}</em>
                    </span>
                  </div>
                  {itemLines.slice(0, 3).map((line, index) => <div className="im-rail-value-item" key={`${line.itemId}-${index}`}>
                    <span>{line.name ?? "物资"}</span>
                    <b>{line.quantity}{line.unit ? ` ${UNIT_LABELS[line.unit] ?? line.unit}` : ""}</b>
                  </div>)}
                  {itemLines.length > 3 ? <p className="im-rail-note">另有 {itemLines.length - 3} 项物品资源，未在摘要中展开。</p> : null}
                </> : null}
              </div>
              <div className="im-rail-section-foot">
                <span>冻结清单 · {visible.length} 项</span>
                <a className="im-rail-link" data-action="order-open-inventory" href={`/orders/${encodeURIComponent(info.orderId)}`}>查看完整清单<ChevronRight aria-hidden="true" /></a>
              </div>
            </> : <div className="im-rail-value-empty">
              <p className="im-rail-empty">{frozen.length ? "冻结清单中没有数量大于 0 的项目。" : "本单没有返回冻结清单。"}</p>
              <a className="im-rail-link" data-action="order-open-inventory" href={`/orders/${encodeURIComponent(info.orderId)}`}>查看完整清单<ChevronRight aria-hidden="true" /></a>
            </div>}
            <p className="im-rail-note">按本单冻结报价的买家口径展示；不代表结算或到账。</p>
            {quote === null
              ? <p className="im-rail-note">订单未返回可用冻结报价，金额保持待核对。</p>
              : amountUnknown ? <p className="im-rail-note">部分项目缺少冻结报价，金额保持待核对。</p> : null}
          </RailSection>

          <RailSection title="账号与双方">
            <div className="im-rail-account">
              <p className="im-rail-account-title">{info.account.title}</p>
              <p className="im-rail-account-sub">{info.gameName} · 成交快照账号</p>
              <div className="im-rail-parties">
                {partyRow("买家", buyer)}
                {partyRow("号主", owner)}
              </div>
            </div>
          </RailSection>

          {/* 已结束订单的进度与终态只在顶部阶段条呈现；右栏不再重复状态卡。 */}
          {ended ? null : <OrderFulfillmentSection key={info.orderId} orderId={info.orderId} displayNo={info.displayNo} viewerId={adminUserId} orderStatus={info.orderStatus} canManualClose={canManualClose === true && info.members.some((member) => member.party === "STAFF" && member.platformId === adminUserId)} {...(info.frozenInventory ? { frozenInventory: info.frozenInventory } : {})} />}
        </div>
      </aside>
    );
  };

  return (
    <OrderTeamPanel
      key={identity} identity={identity} realm="admin" layout="aside" client={client} connection={connection} active={active}
      sendAllowed={sendAllowed} request={request} onAuthError={onAuthError}
      gridPane={pane} gridDetailsOpen={detailsOpen}
      renderList={renderList} renderAside={renderAside} renderConversation={renderConversation}
    />
  );
}
