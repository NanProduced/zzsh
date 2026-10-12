"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDown, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, Headphones, Images, MoreHorizontal, Search, X } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { decodeImSystemNotice } from "@zzsh/im-client/message-state";
import type { NimMessageLike, NimWebClientLike, NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import {
  OrderTeamPanel, escalationReviewReason, escalationStateLabel, orderTeamLabel, orderTeamMemberRole,
  type OrderTeamAccess, type OrderTeamAsideView, type OrderTeamConversationView, type OrderTeamListItem, type OrderTeamListView,
} from "@zzsh/ui/order-team-panel";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatBytes, formatDateTime, formatTime, initialOf } from "./im-support-format";
import { OrderFulfillmentSection } from "./im-support-fulfillment";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../components/ui/input-group";
import { Kbd } from "../components/ui/kbd";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../components/ui/attachment";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "../components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import "@zzsh/ui/order-team.css";

const GROUP_WINDOW_MS = 300_000;
const MAX_STAGED_IMAGES = 6;
const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件" };
const PRICING_LABELS: Record<string, string> = { HAFF_RATIO: "按比例计价", FIXED_UNIT: "按数量计价" };

type Requester = <T>(path: string) => Promise<T>;

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

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="grid gap-2">
    <h3 className="px-0.5 text-sm font-semibold text-foreground">{title}</h3>
    {children}
  </section>;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [notice, setNotice] = useState("");
  const currentValue = useRef(value);
  currentValue.current = value;
  useEffect(() => setNotice(""), [label, value]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      if (currentValue.current === value) setNotice(`已复制${label}`);
    } catch {
      if (currentValue.current === value) setNotice("复制失败，请选择原文复制");
    }
  };
  return (
    <><Item size="sm" className="im-rail-fact px-4 py-2">
      <ItemContent><ItemDescription className="text-xs">{label}</ItemDescription></ItemContent>
      <ItemActions className="im-rail-value-actions">
        <span className="im-rail-value text-sm font-medium tabular-nums">{value}</span>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="im-rail-icon" aria-label={`复制${label}`} onClick={() => void copy()} />}>
          {notice.startsWith("已复制") ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </TooltipTrigger><TooltipContent>{notice || `复制${label}`}</TooltipContent></Tooltip>
      </ItemActions>
    </Item>
    {notice ? <p className="im-rail-copy-status" data-state={notice.startsWith("已复制") ? "success" : "error"} role="status">{notice}</p> : null}</>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <Item size="sm" className="px-4 py-2">
      <ItemContent><ItemDescription className="text-xs">{label}</ItemDescription></ItemContent>
      <ItemActions><span className="text-sm font-medium">{value}</span></ItemActions>
    </Item>
  );
}

/** 时间只取服务端值；不可解析时直说，不用本地时钟补一个看起来像事实的时间。 */
function serverTime(value: string): string {
  return formatDateTime(value);
}

function OrderInventoryDialog({ info, onClose, triggerRef }: { info: OrderTeamAccess; onClose: () => void; triggerRef: { current: HTMLButtonElement | null } }) {
  const lines = info.frozenInventory ?? [];
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="im-order-inventory-dialog" aria-label="本单冻结库存清单" showCloseButton={false} finalFocus={triggerRef}>
        <div className="im-wb-dialog-head">
          <div><strong>冻结库存清单</strong><span>{info.gameName} · 订单 {info.displayNo}</span></div>
          <Button type="button" variant="ghost" size="icon-sm" className="im-rail-icon" data-action="close-inventory" onClick={onClose} aria-label="关闭清单"><X aria-hidden="true" /></Button>
        </div>
        {lines.length ? (
          <div className="im-order-inventory-scroll" tabIndex={0} role="region" aria-label="冻结库存清单内容"><Table className="im-order-table">
            <TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">数量</TableHead><TableHead>计价口径</TableHead></TableRow></TableHeader>
            <TableBody>{lines.map((line) => (
              <TableRow key={line.itemId}><TableCell>{line.name ?? line.itemId}</TableCell><TableCell className="text-right tabular-nums">{line.quantity}{line.unit ? ` ${UNIT_LABELS[line.unit] ?? line.unit}` : ""}</TableCell><TableCell>{PRICING_LABELS[line.pricingKind] ?? "计价口径未识别"}</TableCell></TableRow>
            ))}</TableBody>
          </Table></div>
        ) : <p className="im-wb-dialog-empty">本单没有可显示的冻结库存清单，数量以履约核对结果为准。</p>}
        <p className="im-wb-dialog-hint">这是本单冻结的库存依据，不等于已确认的期初录入；录入与确认在「当前任务」中按阶段进行。</p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin order workbench: the shared order-team panel keeps every read,
 * authorization, draft and send decision; this module only decides how the
 * loaded facts are presented in the three-column case workspace.
 */
export function OrderWorkbenchPane({ identity, adminUserId, operatorName, client, connection, active, sendAllowed, request, onAuthError }: {
  identity: string;
  adminUserId: string;
  operatorName: string;
  client: NimWebClientLike | null;
  connection: NimWebConnectionState | "idle" | "error";
  active: boolean;
  sendAllowed: boolean;
  request: Requester;
  onAuthError: (status: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 1180);
  const [pane, setPane] = useState<"list" | "chat" | "details">("list");
  const [imageErrors, setImageErrors] = useState<Record<string, number>>({});
  const [inventoryOrderId, setInventoryOrderId] = useState<string | null>(null);
  const chatHeadingRef = useRef<HTMLElement | null>(null);
  const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inventoryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousPaneRef = useRef(pane);
  const selectedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const onComposerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, []);

  const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
  const closeInventory = () => setInventoryOrderId(null);
  useEffect(() => setInventoryOrderId(null), [identity, active]);
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
    const rows = text ? items.filter((row: OrderTeamListItem) => `${row.title} ${row.displayNo} ${orderTeamLabel(row)}`.toLowerCase().includes(text)) : items;
    return (
      <aside className="im-wb-queue" aria-label="我参与的订单群">
        <div className="im-wb-queue-head"><strong>我参与的订单群</strong><b>{items.length}</b></div>
        <label className="im-wb-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索筛选当前列表" aria-label="搜索订单群" /></label>
        <p className="im-wb-filter-note">仅筛选本机已加载的订单群，计数不代表全部；「我参与的」即当前目录已授权的群。</p>
        <div className="im-wb-rows">
          {loading && !items.length ? <p className="im-wb-list-empty"><strong>正在读取订单群…</strong></p> : null}
          {rows.map((row) => {
            const fact = row.teamState === "READY" ? escalationStateLabel(row.escalationState ?? "NOT_STARTED", row.firstResponseAt ?? null) : null;
            return (
              <button type="button" key={row.id} className="im-wb-row" data-active={selectedId === row.id} aria-current={selectedId === row.id ? "page" : undefined}
                onClick={() => { setInventoryOrderId(null); setImageErrors({}); onSelect(row.id); setPane("chat"); }}>
                <span className="im-wb-row-av" aria-hidden="true">{initialOf(row.title)}</span>
                <span className="im-wb-row-copy">
                  <span className="im-wb-row-top"><b>{row.title}</b><i className="im-wb-tag">{row.displayNo}</i></span>
                  <span className="im-wb-row-snip">{orderTeamLabel(row)}</span>
                  {fact ? <span className="im-wb-row-foot"><em>{fact}</em></span> : null}
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
      const image = imageOf(message);
      const imageUrl = image?.url ?? null;
      const failed = Boolean(imageUrl && imageErrors[message.id]);
      const text = typeof message.text === "string" && message.text.trim() ? message.text : message.messageType === 0 || image ? "" : "暂不支持展示的消息类型";
      nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={!self}>
        <Message align={self ? "end" : "start"} className="im-wb-msg" data-self={self} data-grouped={grouped}>
          <MessageAvatar className="im-wb-av" aria-hidden="true">{initialOf(author.name)}</MessageAvatar>
          <MessageContent className="im-wb-msg-body">
            {grouped ? null : <MessageHeader className="im-wb-msg-meta"><b>{author.name}</b>{author.role ? <span className="im-wb-role-tag" data-role={author.role}>{author.role}</span> : null}{self ? null : <time>{formatTime(message.createTime)}</time>}</MessageHeader>}
            <Bubble align={self ? "end" : "start"} variant={self ? "default" : "secondary"}>
              <BubbleContent className="im-wb-bub">{image ? (imageUrl
                ? (failed
                  ? <button type="button" className="im-wb-thumb im-wb-thumb-failed" onClick={() => setImageErrors((current) => { const next = { ...current }; delete next[message.id]; return next; })} aria-label={`重新加载图片 ${image.name}`}>图片加载失败 · 点击重试</button>
                  : <button type="button" className="im-wb-thumb" aria-label={`查看图片 ${image.name}`} onClick={(event) => view.openImage(imageUrl, image.name, event.currentTarget)}><img src={imageUrl} alt={image.name} loading="lazy" onError={() => setImageErrors((current) => ({ ...current, [message.id]: Date.now() }))} /></button>)
                : <span className="im-wb-thumb-missing">图片暂不可预览</span>) : text}</BubbleContent>
            </Bubble>
            {self ? <MessageFooter className="im-wb-msg-status"><time>{formatTime(message.createTime)}</time><span>已发送</span></MessageFooter> : null}
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
        {!view.canSend ? <p className="im-wb-action-note"><CircleAlert size={13} />当前只可阅读本单消息；已加载历史与草稿保留。</p> : null}
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
        <form className="im-wb-composer" onSubmit={(event) => { event.preventDefault(); void view.onSubmit(event); }}>
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
            <InputGroupTextarea value={view.draft} onChange={(event) => view.setDraft(event.target.value)} onKeyDown={onComposerKeyDown}
              onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
              aria-label="输入订单群消息" rows={3} maxLength={4000}
              placeholder={!view.canSend ? "当前只可阅读，草稿会保留" : view.connection !== "CONNECTED" ? "云信通道未连接，草稿会保留" : "输入消息…"}
              disabled={!view.canSend} />
            <InputGroupAddon align="block-end" className="im-wb-composer-tools">
              <label className="im-wb-tool"><Images size={14} />图片<input type="file" accept="image/jpeg,image/png" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; view.onStageFiles(files); }} disabled={!view.canSend || view.imageBlocked || view.isImageSending} /></label>
              <button type="button" className="im-wb-tool" data-action="order-insert-summary" disabled={!view.canSend}
                onClick={() => view.setDraft(`${view.draft ? `${view.draft}\n` : ""}【本单信息】${info.account.title}（订单 ${info.displayNo}）`)}>本单信息</button>
              <span className="im-wb-hint im-wb-hint-right"><Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行</span>
              <button type="submit" className="im-wb-send" disabled={!view.canSend || view.connection !== "CONNECTED" || view.sending || view.isImageSending || view.imageBlocked || (!view.draft.trim() && !view.stagedImages.length && !(view.pendingImage?.state === "FAILED"))}>{view.sending ? "发送中…" : "发送"}</button>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    );
  };

  const renderAside = ({ info, fulfillment }: OrderTeamAsideView) => {
    const lines = info.frozenInventory ?? [];
    const esc = info.supportEscalation;
    const review = escalationReviewReason(esc);
    const tracking = escalationStateLabel(esc.state, esc.firstResponseAt ?? null);
    return (
      <aside id="im-order-details" className="order-team-aside im-wb-details" aria-label="本单详情" hidden={!detailsOpen}>
        <div className="im-wb-details-head"><strong>本单详情</strong>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="im-rail-icon" data-action="collapse-order-details" onClick={closeDetails} aria-label="收起本单详情" />}><X aria-hidden="true" /></TooltipTrigger><TooltipContent>收起本单详情</TooltipContent></Tooltip></div>
        <div className="im-order-rail">
          {fulfillment}

          <RailSection title="本单账号">
            <Card className="im-order-card">
              <CardContent className="grid gap-0 p-0">
                <Item size="sm" className="px-4 py-3">
                  <ItemMedia variant="icon" className="im-order-avatar" aria-hidden="true">{initialOf(info.account.title)}</ItemMedia>
                  <ItemContent>
                    <ItemTitle className="line-clamp-2">{info.account.title}</ItemTitle>
                    <ItemDescription>{info.gameName} · 成交快照账号</ItemDescription>
                  </ItemContent>
                </Item>
                <ItemSeparator />
                <CopyRow label="稳定账号ID" value={info.account.id} />
                <CopyRow label="订单编号" value={info.displayNo} />
              </CardContent>
            </Card>
          </RailSection>

          <RailSection title="冻结库存摘要">
            <Card className="im-order-card">
              {lines.length ? <>
                <Table className="im-order-table">
                  <TableHeader><TableRow><TableHead>项目</TableHead><TableHead className="text-right">数量</TableHead></TableRow></TableHeader>
                  <TableBody>{lines.slice(0, 4).map((line) => (
                    <TableRow key={line.itemId}><TableCell className="font-medium">{line.name ?? line.itemId}</TableCell><TableCell className="text-right tabular-nums">{line.quantity}{line.unit ? ` ${UNIT_LABELS[line.unit] ?? line.unit}` : ""}</TableCell></TableRow>
                  ))}</TableBody>
                </Table>
                <CardFooter className="justify-end gap-1 px-3 py-2">
                  {lines.length > 4 ? <span className="mr-auto text-xs text-muted-foreground">共 {lines.length} 项</span> : null}
                  <Button variant="link" size="sm" data-action="order-open-inventory" ref={inventoryTriggerRef} onClick={() => setInventoryOrderId(info.orderId)}>查看完整清单<ChevronRight aria-hidden="true" /></Button>
                </CardFooter>
              </> : <CardDescription className="px-4 py-3">本单还没有可显示的库存清单。</CardDescription>}
            </Card>
          </RailSection>

          <RailSection title={`群成员 · ${info.members.length}`}>
            <Card className="im-order-card">
              <CardContent className="grid gap-0 p-0">
                <ItemGroup role="list" className="im-order-members divide-y divide-border">
                  {info.members.map((member) => {
                    const name = member.name?.trim() || orderTeamMemberRole(member);
                    return (
                      <Item key={member.accountId} size="sm" className="px-4 py-2.5">
                        <ItemMedia variant="icon" className="im-order-avatar" aria-hidden="true">{initialOf(name)}</ItemMedia>
                        <ItemContent><ItemTitle className="truncate">{name}</ItemTitle>{member.party !== "STAFF" ? <ItemDescription>用户编号 {member.platformId}</ItemDescription> : null}</ItemContent>
                        <ItemActions><Badge variant="outline" className="im-order-role" data-role={orderTeamMemberRole(member)}>{orderTeamMemberRole(member)}</Badge></ItemActions>
                      </Item>
                    );
                  })}
                </ItemGroup>
              </CardContent>
            </Card>
          </RailSection>

          <RailSection title="接待跟踪">
            <Card className="im-order-card">
              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:bg-muted/50">
                  <ItemMedia variant="icon" className="im-order-avatar" aria-hidden="true"><Headphones /></ItemMedia>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium leading-snug">{tracking}</span>
                    {review ? <span className="text-xs leading-normal text-muted-foreground">{review}</span> : null}
                  </span>
                  <ChevronDown className="im-rail-disclosure size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent className="divide-y divide-border border-t">
                  <FactRow label="提醒节点" value={esc.state === "RUNNING" && esc.remindDueAt ? serverTime(esc.remindDueAt) : "暂未提供"} />
                  <FactRow label="首响时间" value={esc.firstResponseAt ? serverTime(esc.firstResponseAt) : "尚无客服回应"} />
                  <FactRow label="补派轮次" value={String(esc.addRound)} />
                  {esc.state === "NOT_STARTED" ? <p className="px-4 py-2 text-xs text-muted-foreground">本单群未启用接待跟踪。</p> : null}
                </CollapsibleContent>
              </Collapsible>
            </Card>
          </RailSection>
          {inventoryOrderId === info.orderId ? <OrderInventoryDialog info={info} onClose={closeInventory} triggerRef={inventoryTriggerRef} /> : null}
        </div>
      </aside>
    );
  };

  return (
    <TooltipProvider delay={250}><OrderTeamPanel
      key={identity} identity={identity} realm="admin" layout="aside" client={client} connection={connection} active={active}
      sendAllowed={sendAllowed} request={request} onAuthError={onAuthError}
      gridPane={pane} gridDetailsOpen={detailsOpen}
      renderFulfillment={({ orderId, displayNo, frozenInventory }) => <OrderFulfillmentSection orderId={orderId} displayNo={displayNo} viewerId={adminUserId} {...(frozenInventory ? { frozenInventory } : {})} />}
      renderList={renderList} renderAside={renderAside} renderConversation={renderConversation}
    /></TooltipProvider>
  );
}
