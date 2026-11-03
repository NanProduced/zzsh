"use client";
import { ProfileImage } from "@zzsh/ui/profile-image";


import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ChevronLeft, ChevronRight, CircleAlert, FileText, Headphones, Images, MoreHorizontal, ReceiptText, Search, Settings, Smile, Video } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { decodeImSystemNotice } from "@zzsh/im-client/message-state";
import type { NimMessageLike, NimWebClientLike, NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import {
  OrderTeamPanel, escalationStateLabel, orderStageTone, orderTeamLabel, orderTeamMemberRole,
  type OrderTeamAccess, type OrderTeamAsideView, type OrderTeamConversationView, type OrderTeamListItem, type OrderTeamListView, type OrderTeamMember,
} from "@zzsh/ui/order-team-panel";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatBytes, formatDateTime, formatTime, initialOf } from "./im-support-format";
import { CHAT_EMOJIS, MessageActionMenu, MessageReplyQuote, type MessageActionId, type MessageActionItem } from "@zzsh/ui/message-actions";
import "@zzsh/ui/message-actions.css";
import { MediaDraftBar, mediaMessageOf } from "@zzsh/ui/message-media";
import "@zzsh/ui/message-media.css";
import { OrderCardMessage } from "@zzsh/ui/order-card";
import { EntityPreviewTrigger, UserProfilePreview } from "../components/admin-preview";
import { OrderFulfillmentSection } from "./im-support-fulfillment";
import {
  AdminOrderGroupSettingsDrawer, groupPreferenceOf, readOrderGroupPreferences, storeOrderGroupPreferences, withGroupPreference,
  ORDER_GROUP_PREF_EVENT, ORDER_GROUP_SETTINGS_EVENT,
  type InviteOrderGroupMember, type OrderGroupPreference, type OrderGroupPreferenceMap,
} from "./im-support-group-settings";
import { SupportMessageBody } from "./im-support-message-body";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../components/ui/input-group";
import { Kbd } from "../components/ui/kbd";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../components/ui/attachment";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import "@zzsh/ui/order-team.css";
import "./im-order-rail.css";
import "./im-support-group-settings.css";

const GROUP_WINDOW_MS = 300_000;
const MAX_STAGED_IMAGES = 6;
const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件" };

type Requester = <T>(path: string, body?: Record<string, unknown>) => Promise<T>;

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

function imageOf(message: NimMessageLike): { url: string | null; thumbnailUrl: string | null; name: string } | null {
  if (message.messageType !== 1) return null;
  const attachment = message.attachment;
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return null;
  const record = attachment as { url?: unknown; thumbUrl?: unknown; name?: unknown };
  const url = supportedImageUrl(record.url) ?? supportedImageUrl(record.thumbUrl);
  return { url, thumbnailUrl: supportedImageUrl(record.thumbUrl) ?? url, name: typeof record.name === "string" ? record.name : "订单图片" };
}

/** 发送者署名只认成员表：映射缺失时中性降级，绝不借用当前接待者或租客的身份。 */
function authorOf(info: OrderTeamAccess, senderId: string, accountId: string, operatorName: string) {
  const member = info.members.find((item) => item.accountId === senderId);
  if (senderId === accountId) return { name: member?.name?.trim() || operatorName, role: member ? orderTeamMemberRole(member) : "平台客服", avatar: member?.avatar };
  if (info.botAccountId && senderId === info.botAccountId) return { name: "洲洲助手（Bot）", role: "机器人", avatar: null };
  if (!member) return { name: "未署名成员", role: null as string | null, avatar: null };
  return { name: member.name?.trim() || orderTeamMemberRole(member), role: orderTeamMemberRole(member), avatar: member.avatar };
}

/** 终态订单的阶段文案只说明“已结束”，不退回过分配/匹配等过程词。 */
function orderStageLabel(order: Parameters<typeof orderTeamLabel>[0]): string {
  const status = order.orderStatus ?? order.status;
  if (status === "COMPLETED") return "已完成";
  if (status === "CANCELLED") return "已取消";
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

function PartyRow({ role, member, request, onOpenProfile }: { role: string; member: OrderTeamMember | undefined; request: Requester; onOpenProfile?: (userId: string) => void }) {
  if (!member) return <div className="im-rail-party" data-empty="true"><span className="im-rail-party-role">{role}</span><span className="im-rail-party-name">未列入群成员</span></div>;
  const name = member.name?.trim() || orderTeamMemberRole(member);
  const href = `/users/${encodeURIComponent(member.platformId)}`;
  return <div className="im-rail-party">
    <span className="im-rail-party-role">{role}</span>
    <EntityPreviewTrigger className="im-rail-party-trigger" side="left" align="start" touchLabel={`预览${role}资料`}
      trigger={<a className="im-rail-party-link" href={href} onClick={(event) => { if (onOpenProfile) { event.preventDefault(); onOpenProfile(member.platformId); } }}><span>{name}</span><ChevronRight aria-hidden="true" /></a>}
      content={<UserProfilePreview userId={member.platformId} name={name} request={request} onOpenProfile={onOpenProfile} />} />
  </div>;
}

/**
 * Admin order workbench: the shared order-team panel keeps every read,
 * authorization, draft and send decision; this module only decides how the
 * loaded facts are presented in the three-column case workspace.
 */
export function OrderWorkbenchPane({ identity, adminUserId, operatorName, client, connection, active, sendAllowed, canManualClose, request, onAuthError, inviteGroupMember, selectedOrderId, onOpenProfile, onOpenPath }: {
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
  /** Typed invite port. The BFF member endpoint is not shipped yet, so the drawer stays explicitly 未就绪 until a caller provides this. */
  inviteGroupMember?: InviteOrderGroupMember;
  selectedOrderId?: string | null;
  onOpenProfile?: (userId: string) => void;
  onOpenPath?: (path: string, title?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const orderComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(() => !(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width:1439px)").matches));
  const [pane, setPane] = useState<"list" | "chat" | "details">("list");
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [listMenu, setListMenu] = useState<{ x: number; y: number; orderId: string; preference: OrderGroupPreference; row: HTMLElement | null } | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(selectedOrderId ?? null);
  useEffect(() => { if (selectedOrderId) setActiveOrderId(selectedOrderId); }, [selectedOrderId]);
  const [groupPrefs, setGroupPrefs] = useState<OrderGroupPreferenceMap>(() => readOrderGroupPreferences(adminUserId));
  const groupPrefsRef = useRef(groupPrefs); groupPrefsRef.current = groupPrefs;
  const groupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const listItemsRef = useRef<OrderTeamListItem[]>([]);
  const selectOrderRef = useRef<((id: string | null) => void) | null>(null);
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
  useEffect(() => { setPane("list"); setQuery("");  setGroupSettingsOpen(false); }, [identity]);
  useEffect(() => { setGroupPrefs(readOrderGroupPreferences(adminUserId)); setGroupSettingsOpen(false); }, [adminUserId]);
  const openDetails = () => { setDetailsOpen(true); if (isNarrow()) setPane("details"); };
  const closeDetails = () => {
    const narrow = isNarrow();
    setGroupSettingsOpen(false);
    setDetailsOpen(false);
    if (!narrow) { detailsTriggerRef.current?.focus(); return; }
    setPane(selectedRef.current ? "chat" : "list");
    requestAnimationFrame(() => {
      (selectedRef.current ? chatHeadingRef.current : document.querySelector<HTMLElement>('.im-wb-pane--orders .im-wb-queue [data-active="true"]'))?.focus();
    });
  };

  const persistGroupPrefs = (next: OrderGroupPreferenceMap) => {
    groupPrefsRef.current = next;
    setGroupPrefs(next);
    storeOrderGroupPreferences(adminUserId, next);
    window.dispatchEvent(new CustomEvent(ORDER_GROUP_PREF_EVENT, { detail: { snapshot: next } }));
  };
  const changeGroupPreference = (orderId: string, patch: Partial<OrderGroupPreference>) => {
    persistGroupPrefs(withGroupPreference(groupPrefsRef.current, orderId, patch));
  };
  const hideOrderGroup = (orderId: string) => {
    const next = withGroupPreference(groupPrefsRef.current, orderId, { hidden: true });
    persistGroupPrefs(next);
    setGroupSettingsOpen(false);
    if (selectedRef.current !== orderId) return;
    // Hiding is local: only the visible row goes away; the NIM group and its history stay untouched.
    const nextVisible = listItemsRef.current.find((item) => !groupPreferenceOf(next, item.id).hidden)?.id ?? null;
    selectOrderRef.current?.(nextVisible);
    if (isNarrow()) setPane(nextVisible === null ? "list" : "chat");
  };
  const restoreHiddenGroups = () => {
    const next: OrderGroupPreferenceMap = {};
    for (const [orderId, preference] of Object.entries(groupPrefsRef.current)) next[orderId] = { ...preference, hidden: false };
    persistGroupPrefs(next);
  };
  const openGroupSettings = () => {
    setDetailsOpen(true);
    setGroupSettingsOpen(true);
    if (isNarrow()) setPane("details");
  };
  const performGroupAction = (action: MessageActionId, orderId: string, preference: OrderGroupPreference) => {
    if (action === "pin") { changeGroupPreference(orderId, { pinned: !preference.pinned }); return; }
    if (action === "mute") { changeGroupPreference(orderId, { muted: !preference.muted }); return; }
    if (action === "hide") { hideOrderGroup(orderId); return; }
    if (action === "settings") {
      selectOrderRef.current?.(orderId);
      window.setTimeout(openGroupSettings, 80);
    }
  };
  const handleListMenuAction = (action: MessageActionId) => {
    const menu = listMenu;
    setListMenu(null);
    if (menu) performGroupAction(action, menu.orderId, menu.preference);
  };
  const activeGroupPreference = activeOrderId ? groupPreferenceOf(groupPrefs, activeOrderId) : null;
  const messageGroupItems: MessageActionItem[] = activeOrderId && activeGroupPreference ? [
    { id: "pin", label: activeGroupPreference.pinned ? "取消置顶" : "置顶会话" },
    { id: "mute", label: activeGroupPreference.muted ? "取消消息免打扰" : "消息免打扰" },
    { id: "settings", label: "群设置" },
    { id: "hide", label: "不显示会话", danger: true },
  ] : [];
  const onMessageGroupAction = (action: MessageActionId) => {
    if (activeOrderId && activeGroupPreference) performGroupAction(action, activeOrderId, activeGroupPreference);
  };
  // The unified directory owns its own row menu; it bridges local prefs/settings here.
  useEffect(() => {
    const onPreference = (event: Event) => {
      const detail = (event as CustomEvent<{ orderId?: string; patch?: Partial<OrderGroupPreference>; snapshot?: OrderGroupPreferenceMap }>).detail;
      if (!detail?.orderId || !detail.patch || detail.snapshot) return;
      if (detail.patch.hidden === true) hideOrderGroup(detail.orderId);
      else changeGroupPreference(detail.orderId, detail.patch);
    };
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ orderId?: string }>).detail;
      if (!detail?.orderId) return;
      if (selectedRef.current !== detail.orderId) selectOrderRef.current?.(detail.orderId);
      window.setTimeout(openGroupSettings, 60);
    };
    window.addEventListener(ORDER_GROUP_PREF_EVENT, onPreference);
    window.addEventListener(ORDER_GROUP_SETTINGS_EVENT, onSettings);
    return () => {
      window.removeEventListener(ORDER_GROUP_PREF_EVENT, onPreference);
      window.removeEventListener(ORDER_GROUP_SETTINGS_EVENT, onSettings);
    };
  }, [changeGroupPreference, hideOrderGroup, openGroupSettings]);
  const closeGroupSettings = () => {
    const narrow = isNarrow();
    setGroupSettingsOpen(false);
    if (!narrow) { requestAnimationFrame(() => groupTriggerRef.current?.focus()); return; }
    setPane(selectedRef.current ? "chat" : "list");
    requestAnimationFrame(() => {
      (selectedRef.current ? chatHeadingRef.current : document.querySelector<HTMLElement>('.im-wb-pane--orders .im-wb-queue [data-active="true"]'))?.focus();
    });
  };
  // Contract: POST /api/bff/admin/orders/{orderId}/members { adminUserId }. Callers may override the
  // transport through the typed prop; the default keeps the server as the only source of success.
  const defaultInviteGroupMember = useCallback<InviteOrderGroupMember>(async (orderId, adminUserId) => {
    await request(`/orders/${encodeURIComponent(orderId)}/members`, { adminUserId });
  }, [request]);
  const resolvedInviteGroupMember = inviteGroupMember ?? defaultInviteGroupMember;

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
    listItemsRef.current = items;
    const chooseOrder = (id: string | null) => { setGroupSettingsOpen(false); onSelect(id); };
    selectOrderRef.current = chooseOrder;
    const text = query.trim().toLowerCase();
    const preferenceOf = (id: string) => groupPreferenceOf(groupPrefs, id);
    const hiddenItems = items.filter((row: OrderTeamListItem) => preferenceOf(row.id).hidden);
    const visibleItems = items.filter((row: OrderTeamListItem) => !preferenceOf(row.id).hidden);
    // Pinned groups first, then the latest real message; server order/membership stay unchanged.
    const messageAt = (row: OrderTeamListItem) => Date.parse(row.lastMessageAt ?? row.createdAt ?? "") || 0;
    const orderedItems = [...visibleItems].sort((a, b) => Number(preferenceOf(b.id).pinned) - Number(preferenceOf(a.id).pinned) || messageAt(b) - messageAt(a));
    const rows = text ? orderedItems.filter((row: OrderTeamListItem) => `${row.displayNo} ${orderStageLabel(row)}`.toLowerCase().includes(text)) : orderedItems;
    const allHidden = !text && items.length > 0 && rows.length === 0 && hiddenItems.length === items.length;
    return (
      <aside className="im-wb-queue" aria-label="我参与的订单群" onContextMenu={(event) => { if ((event.target as Element).closest(".im-wb-row")) return; event.preventDefault(); setListMenu(null); }}>
        <div className="im-wb-queue-head"><strong>我参与的订单群</strong><b>{items.length - hiddenItems.length}</b></div>
        <label className="im-wb-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索筛选当前列表" aria-label="搜索订单群" /></label>
        <p className="im-wb-filter-note">仅筛选本机已加载的订单群，计数不代表全部；「我参与的」即当前目录已授权的群。</p>
        <div className="im-wb-rows">
          {loading && !items.length ? <p className="im-wb-list-empty"><strong>正在读取订单群…</strong></p> : null}
          {rows.map((row) => {
            const ended = row.status === "COMPLETED" || row.status === "CANCELLED";
            const fact = !ended && row.teamState === "READY"
              ? row.firstResponseOverdue ? "首响超时" : escalationStateLabel(row.escalationState ?? "NOT_STARTED", row.firstResponseAt ?? null)
              : null;
            const due = !ended && row.dueAt ? `到期 ${serverTime(row.dueAt)}` : null;
            const preview = typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim()
              ? row.lastMessagePreview.trim()
              : row.lastMessageAt ? "有新消息" : "暂无消息";
            const preference = preferenceOf(row.id);
            return (
              <button type="button" key={row.id} className="im-wb-row" data-order-id={row.id} data-active={selectedId === row.id} data-pinned={preference.pinned ? "true" : undefined} data-muted={preference.muted ? "true" : undefined} aria-current={selectedId === row.id ? "page" : undefined}
                onClick={() => {  chooseOrder(row.id); setPane("chat"); }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setListMenu({ x: event.clientX, y: event.clientY, orderId: row.id, preference, row: event.currentTarget }); }}>
                <span className="im-wb-row-av" data-kind="order" aria-hidden="true"><ReceiptText size={15} /></span>
                <span className="im-wb-row-copy">
                  <span className="im-wb-row-top"><b>{row.displayNo}</b>{preference.pinned ? <i className="im-wb-tag im-og-list-tag" data-tone="pinned">置顶</i> : null}{preference.muted ? <i className="im-wb-tag im-og-list-tag" data-tone="muted">免打扰</i> : null}{(row.unreadCount ?? 0) > 0 && !preference.muted ? <i className="im-wb-unread" aria-label={`${row.unreadCount} 条未读`}>{row.unreadCount! > 99 ? "99+" : row.unreadCount}</i> : null}</span>
                  <span className="im-wb-row-snip"><em className="im-wb-order-state" data-tone={orderStageTone(row)}>{orderStageLabel(row)}</em><span className="im-wb-row-preview">{preview}</span></span>
                  {due || fact ? <span className="im-wb-row-foot">
                    {due ? <small>{due}</small> : null}
                    {fact ? <em data-tone={row.firstResponseOverdue ? "warn" : undefined}>{fact}</em> : null}
                  </span> : null}
                </span>
              </button>
            );
          })}
          {!rows.length && items.length ? <p className="im-wb-list-empty">
            <strong>{allHidden ? "本机已隐藏全部订单群" : "当前列表没有匹配订单群"}</strong>
            <span>{allHidden ? "恢复显示后仍按服务端授权读取；不会退出群聊。" : "试试订单编号或状态。"}</span>
          </p> : null}
          {hiddenItems.length ? <button type="button" className="im-wb-more im-og-restore" data-action="restore-hidden-order-groups" onClick={restoreHiddenGroups}>已隐藏 {hiddenItems.length} 个订单群 · 恢复显示</button> : null}
          {nextCursor ? <button type="button" className="im-wb-more" disabled={loading || refreshing} onClick={onLoadMore}>{refreshing ? "正在读取…" : "更多订单群"}</button> : null}
        </div>
        {listMenu ? <MessageActionMenu x={listMenu.x} y={listMenu.y} label="订单群操作" returnFocus={listMenu.row}
          items={[
            { id: "pin" as const, label: listMenu.preference.pinned ? "取消置顶" : "置顶会话" },
            { id: "mute" as const, label: listMenu.preference.muted ? "取消消息免打扰" : "消息免打扰" },
            { id: "settings" as const, label: "群设置" },
            { id: "hide" as const, label: "不显示会话", danger: true },
          ]}
          onSelect={handleListMenuAction} onClose={() => setListMenu(null)} /> : null}
      </aside>
    );
  };

  const renderConversation = (view: OrderTeamConversationView) => {
    const { info, messages, refreshAccess } = view;
    // 代确认只对负责客服开放；boss/其他客服即使看得到卡片也不渲染该动作，服务端仍会复核。
    const viewerResponsible = info.members.some((member) => member.accountId === info.viewerAccountId && member.party === "STAFF" && member.responsible);
    const confirmOnBehalf = canManualClose === true && viewerResponsible
      ? async (target: OrderTeamAccess, party: "RENTER" | "OWNER") => {
          if (!target.openingId || !Number.isInteger(target.openingVersion)) throw new Error("期初信息未就绪，请刷新后重试");
          await request(`/orders/${encodeURIComponent(target.orderId)}/openings/${encodeURIComponent(target.openingId)}/confirm`,
            { party, versionNo: target.openingVersion });
          await refreshAccess();
        }
      : undefined;
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
      const revoked = message.revoked === true;
      const text = typeof message.text === "string" && message.text.trim() ? message.text : message.messageType === 0 || image || media ? "" : "暂不支持展示的消息类型";
      nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={!self}>
        <Message align={self ? "end" : "start"} className="im-wb-msg" data-self={self} data-grouped={grouped} data-message-id={message.id} onContextMenu={view.menuHandlers.onContextMenu} {...view.menuHandlers.longPress}>
          <MessageAvatar className="im-wb-av" aria-hidden="true">{author.role === "机器人" ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : <ProfileImage src={author.avatar} fallback={initialOf(author.name)} />}</MessageAvatar>
          <MessageContent className="im-wb-msg-body" data-card={card ? "true" : undefined}>
            {grouped ? null : <MessageHeader className="im-wb-msg-meta"><b>{author.name}</b>{author.role ? <span className="im-wb-role-tag" data-role={author.role}>{author.role}</span> : null}{self ? null : <time>{formatTime(message.createTime)}</time>}</MessageHeader>}
            {card && !revoked ? <OrderCardMessage message={message} info={info} onConfirmOpeningOnBehalf={confirmOnBehalf} onOpenOrder={() => { if (onOpenPath) { onOpenPath(`/orders/${encodeURIComponent(info.orderId)}`, `订单 ${info.displayNo ?? info.orderId}`); } else { window.location.assign(`/orders/${encodeURIComponent(info.orderId)}`); } }} /> : <SupportMessageBody message={message} image={image ? {url:image.url,thumbnailUrl:image.thumbnailUrl,name:image.name} : null}
              replySenderName={info.members.find((member) => member.accountId === message.reply?.senderId)?.name?.trim() || null}
              onJump={jumpToMessage} align={self ? "end" : "start"} />}
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
          <span className="im-wb-chat-av" aria-hidden="true">{initialOf(info.account.title?.trim() || "账")}</span>
          <div className="im-wb-chat-title">
            <h2><span className="im-wb-chat-user">{info.gameName} · 订单 {info.displayNo}</span></h2>
            <span>{info.account.title?.trim() || "账号"}</span>
          </div>
          <div className="im-wb-chat-actions">
            <span className="im-wb-state">成员 {info.members.length}</span>
            <button ref={groupTriggerRef} type="button" className="im-wb-btn im-wb-btn-icon" data-action="open-group-settings" aria-label="群设置" title="群设置" aria-expanded={groupSettingsOpen}
              onClick={() => { if (groupSettingsOpen) closeGroupSettings(); else openGroupSettings(); }}><Settings size={15} /></button>
            <button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-icon" data-action="toggle-order-details" aria-label={detailsOpen ? "收起本单详情" : "展开本单详情"} title={detailsOpen ? "收起本单详情" : "展开本单详情"} aria-expanded={detailsOpen} aria-controls="im-order-details"
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
              <MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" title="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>
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
              placeholder={!view.canSend ? "当前只可阅读，草稿会保留" : view.connection !== "CONNECTED" ? "消息通道未连接，草稿会保留" : "输入消息…"}
              disabled={!view.canSend} />
            <InputGroupAddon align="block-end" className="im-wb-composer-tools">
              <TooltipProvider delay={200}>
                <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                  <PopoverTrigger render={<button type="button" className="im-wb-tool" aria-label="表情" title="表情" disabled={!view.canSend || view.imageBlocked || view.isImageSending} />}><Smile size={15} /></PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-auto p-0"><div className="chat-emoji-grid">
                    {CHAT_EMOJIS.map((item) => <button key={item.emoji} type="button" className="chat-emoji-button" aria-label={item.label} onClick={() => insertEmoji(item.emoji)}>{item.emoji}</button>)}
                  </div></PopoverContent>
                </Popover>
                <Tooltip>
                  <TooltipTrigger render={<label className="im-wb-tool" aria-label="发送图片" />}><Images size={15} /><input type="file" accept="image/jpeg,image/png" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; view.onStageFiles(files); }} disabled={!view.canSend || view.imageBlocked || view.isImageSending || view.isMediaSending} /></TooltipTrigger>
                  <TooltipContent>发送图片</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger render={<button type="button" className="im-wb-tool" aria-label="发送视频" onClick={() => orderVideoInput.current?.click()} disabled={!view.canSend || view.imageBlocked || view.isImageSending || view.isMediaSending} />}><Video size={15} /></TooltipTrigger>
                  <TooltipContent>发送视频</TooltipContent>
                </Tooltip>
                <input ref={orderVideoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) view.onStageMedia(file, "video"); }} disabled={!view.canSend || view.isImageSending || view.isMediaSending || view.mediaDraft?.state === "UNKNOWN"} />
                <Tooltip>
                  <TooltipTrigger render={<button type="button" className="im-wb-tool" aria-label="发送文件" onClick={() => orderFileInput.current?.click()} disabled={!view.canSend || view.imageBlocked || view.isImageSending || view.isMediaSending} />}><FileText size={15} /></TooltipTrigger>
                  <TooltipContent>发送文件</TooltipContent>
                </Tooltip>
                <input ref={orderFileInput} type="file" accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) view.onStageMedia(file, "file"); }} disabled={!view.canSend || view.isImageSending || view.isMediaSending || view.mediaDraft?.state === "UNKNOWN"} />
                <Tooltip>
                  <TooltipTrigger render={<button type="button" className="im-wb-tool" data-action="order-insert-summary" aria-label="插入本单信息" disabled={!view.canSend}
                    onClick={() => view.setDraft(`${view.draft ? `${view.draft}\n` : ""}【本单信息】${info.account.title?.trim() || "账号"}（订单 ${info.displayNo}）`)} />}><ReceiptText size={15} /></TooltipTrigger>
                  <TooltipContent>插入本单信息</TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
    const ended = info.orderStatus === "COMPLETED" || info.orderStatus === "CANCELLED";
    const amountUnknown = quote !== null && (
      (coinLines.length > 0 && coinAmount === null) || (itemLines.length > 0 && itemAmount === null)
    );
    return (
      <aside id="im-order-details" className="order-team-aside im-wb-details im-order-rail-host" aria-label="本单详情" hidden={!detailsOpen} data-settings-open={groupSettingsOpen ? "true" : undefined}>
        {info.supportEscalation && (info.supportEscalation.addRound > 0 || info.supportEscalation.remindDueAt || info.supportEscalation.needsManualReview || info.supportEscalation.state === "RUNNING") ? (
          <RailSection title="响应与提醒">
            <div className="im-rail-escalation space-y-1 text-xs">
              {info.supportEscalation.addRound > 0 ? <p className="font-medium text-amber-600 dark:text-amber-400">已补派客服 · 第 {info.supportEscalation.addRound} 轮</p> : null}
              {info.supportEscalation.remindDueAt ? <p className="text-muted-foreground">提醒截止：{formatDateTime(info.supportEscalation.remindDueAt)}</p> : null}
              {info.supportEscalation.needsManualReview ? <p className="text-destructive">需人工核验介入</p> : null}
              {info.supportEscalation.noEligibleStaff ? <p className="text-destructive">无可用客服在线</p> : null}
            </div>
          </RailSection>
        ) : null}

        <div className="im-wb-details-head"><strong>本单详情</strong><button type="button" className="im-wb-btn im-wb-btn-icon im-wb-details-back" data-action="back-to-chat" onClick={closeDetails}>返回会话</button></div>
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
                <a className="im-rail-link" data-action="order-open-inventory" href={`/orders/${encodeURIComponent(info.orderId)}`} onClick={(e) => { if (onOpenPath) { e.preventDefault(); onOpenPath(`/orders/${encodeURIComponent(info.orderId)}`, `订单 ${info.displayNo ?? info.orderId}`); } }}>查看完整清单<ChevronRight aria-hidden="true" /></a>
              </div>
            </> : <div className="im-rail-value-empty">
              <p className="im-rail-empty">{frozen.length ? "清单中没有数量大于 0 的项目。" : "本单未返回物品清单。"}</p>
              <a className="im-rail-link" data-action="order-open-inventory" href={`/orders/${encodeURIComponent(info.orderId)}`} onClick={(e) => { if (onOpenPath) { e.preventDefault(); onOpenPath(`/orders/${encodeURIComponent(info.orderId)}`, `订单 ${info.displayNo ?? info.orderId}`); } }}>查看完整清单<ChevronRight aria-hidden="true" /></a>
            </div>}
            <p className="im-rail-note">按下单确认价格展示；不代表结算或到账。</p>
            {quote === null
              ? <p className="im-rail-note">订单未返回下单价格，金额保持待核对。</p>
              : amountUnknown ? <p className="im-rail-note">部分项目缺少价格，金额保持待核对。</p> : null}
          </RailSection>

          <RailSection title="账号与双方">
            <div className="im-rail-account">
              <p className="im-rail-account-title">{info.account.title?.trim() || "账号"}</p>
              <p className="im-rail-account-sub">{info.gameName} · 下单账号</p>
              <div className="im-rail-parties">
                <PartyRow role="租客" member={buyer} request={request} onOpenProfile={onOpenProfile} />
                <PartyRow role="号主" member={owner} request={request} onOpenProfile={onOpenProfile} />
              </div>
            </div>
          </RailSection>

          {/* 已结束订单的进度与终态只在顶部阶段条呈现；右栏不再重复状态卡。 */}
          {ended ? null : <OrderFulfillmentSection key={info.orderId} orderId={info.orderId} displayNo={info.displayNo} viewerId={adminUserId} orderStatus={info.orderStatus} canManualClose={canManualClose === true && info.members.some((member) => member.party === "STAFF" && member.platformId === adminUserId)} {...(info.frozenInventory ? { frozenInventory: info.frozenInventory } : {})} />}
        </div>
        <Dialog open={groupSettingsOpen} onOpenChange={(open) => { if (!open) closeGroupSettings(); }}>
          <DialogContent className="im-og-settings-dialog" aria-label="群设置" showCloseButton={false} showOverlay={false}>
            <AdminOrderGroupSettingsDrawer info={info} request={request}
              preferences={groupPreferenceOf(groupPrefs, info.orderId)} onPreferenceChange={(patch) => changeGroupPreference(info.orderId, patch)}
              onHide={() => hideOrderGroup(info.orderId)} onClose={closeGroupSettings} inviteMember={resolvedInviteGroupMember} />
          </DialogContent>
        </Dialog>
      </aside>
    );
  };

  return (
    <OrderTeamPanel
      key={identity} identity={identity} realm="admin" layout="aside" client={client} connection={connection} active={active}
      selectedOrderId={selectedOrderId ?? undefined}
      sendAllowed={sendAllowed} request={request} onAuthError={onAuthError}
      gridPane={pane} gridDetailsOpen={detailsOpen}
      renderList={renderList} renderAside={renderAside} renderConversation={renderConversation}
      onBlankContextMenu={(event) => {
        if ((event.target as Element).closest("[data-message-id], .im-wb-row, button, a, input, textarea, [role='menu']")) return;
        event.preventDefault();
        setListMenu(null);
      }}
      extraMenuItems={messageGroupItems} onExtraMenuAction={onMessageGroupAction} onSelectedOrderChange={setActiveOrderId}
    />
  );
}
