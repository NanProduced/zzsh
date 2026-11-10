"use client";
import { ProfileImage } from "@zzsh/ui/profile-image";


import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleHelp, MoreHorizontal, Search, Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { ActionTooltip } from "../components/ui/tooltip";
import type { NimMessageLike, NimWebClientLike, NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import {
  OrderTeamPanel, escalationStateLabel, orderStageTone, orderTeamLabel, orderTeamMemberRole,
  type OrderTeamAccess, type OrderTeamAsideView, type OrderTeamListItem, type OrderTeamListView, type OrderTeamMember,
} from "@zzsh/ui/order-team-panel";
import { supportedImageUrl } from "./im-support-guards";
import { formatDateTime } from "./im-support-format";
import { MessageActionMenu, type MessageActionId } from "@zzsh/ui/message-actions";
import "@zzsh/ui/message-actions.css";
import "@zzsh/ui/message-media.css";
import { OrderCardMessage, accountSummaryOf, type HintRenderer } from "@zzsh/ui/order-card";
import { EntityPreviewTrigger, UserProfilePreview } from "../components/admin-preview";
import { OrderFulfillmentSection, StageCardAttentionNotice } from "./im-support-fulfillment";
import {
  AdminOrderGroupSettingsDrawer, groupPreferenceOf, readOrderGroupPreferences, storeOrderGroupPreferences, withGroupPreference,
  ORDER_GROUP_PREF_EVENT, ORDER_GROUP_SETTINGS_EVENT,
  type InviteOrderGroupMember, type OrderGroupPreference, type OrderGroupPreferenceMap,
} from "./im-support-group-settings";
import { SupportMessageBody } from "./im-support-message-body";
import { OrderGroupAvatar } from "./order-group-avatar";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import "@zzsh/ui/order-team.css";
import "./im-order-rail.css";
import "./im-support-group-settings.css";

const orderCardHint: HintRenderer = (text, trigger) => <ActionTooltip content={text}>{trigger}</ActionTooltip>;
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
export function OrderWorkbenchPane({ identity, adminUserId, operatorName, client, connection, active, sendAllowed, canManualClose, request, onAuthError, inviteGroupMember, selectedOrderId, onSelectedOrderChange, onOpenProfile, onOpenPath, cloudPinnedTeamIds, onToggleCloudPin }: {
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
  onSelectedOrderChange?: (orderId: string | null) => void;
  onOpenProfile?: (userId: string) => void;
  onOpenPath?: (path: string, title?: string) => void;
  /** Cloud-pinned team ids; undefined keeps the local preference fallback. */
  cloudPinnedTeamIds?: ReadonlySet<string>;
  onToggleCloudPin?: (orderId: string, teamId: string, pinned: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(() => !(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width:1439px)").matches));
  const [pane, setPane] = useState<"list" | "chat" | "details">(selectedOrderId ? "chat" : "list");
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [listMenu, setListMenu] = useState<{ x: number; y: number; orderId: string; preference: OrderGroupPreference; row: HTMLElement | null } | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(selectedOrderId ?? null);
  useEffect(() => {
    if (selectedOrderId === undefined) return;
    setActiveOrderId(selectedOrderId);
    setPane(selectedOrderId ? "chat" : "list");
    if (!selectedOrderId) setGroupSettingsOpen(false);
  }, [selectedOrderId]);
  const [groupPrefs, setGroupPrefs] = useState<OrderGroupPreferenceMap>(() => readOrderGroupPreferences(adminUserId));
  const [pinNotice, setPinNotice] = useState<string>();
  const groupPrefsRef = useRef(groupPrefs); groupPrefsRef.current = groupPrefs;
  const groupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const listItemsRef = useRef<OrderTeamListItem[]>([]);
  const preferenceFor = (orderId: string, teamId?: string | null): OrderGroupPreference => {
    const preference = groupPreferenceOf(groupPrefs, orderId);
    return cloudPinnedTeamIds && teamId ? { ...preference, pinned: cloudPinnedTeamIds.has(teamId) } : preference;
  };
  const normalizeCloudPins = (preferences: OrderGroupPreferenceMap): OrderGroupPreferenceMap => {
    if (!cloudPinnedTeamIds) return preferences;
    let changed = false;
    const next = { ...preferences };
    for (const row of listItemsRef.current) {
      if (!row.teamId) continue;
      const current = groupPreferenceOf(next, row.id);
      const pinned = cloudPinnedTeamIds.has(row.teamId);
      if (current.pinned !== pinned) { next[row.id] = { ...current, pinned }; changed = true; }
    }
    return changed ? next : preferences;
  };
  const selectOrderRef = useRef<((id: string | null) => void) | null>(null);
  const chatHeadingRef = useRef<HTMLElement | null>(null);
  const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousPaneRef = useRef(pane);
  const selectedRef = useRef<string | null>(null);

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
    const normalized = cloudPinnedTeamIds ? normalizeCloudPins(next) : next;
    groupPrefsRef.current = normalized;
    setGroupPrefs(normalized);
    storeOrderGroupPreferences(adminUserId, normalized);
    window.dispatchEvent(new CustomEvent(ORDER_GROUP_PREF_EVENT, { detail: { snapshot: normalized, adminUserId } }));
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
    if (action === "pin") {
      const row = listItemsRef.current.find((item) => item.id === orderId);
      if (cloudPinnedTeamIds && onToggleCloudPin) {
        if (!row?.teamId) {
          setPinNotice("该订单群尚未返回云信群号，暂只能在本机置顶。");
          changeGroupPreference(orderId, { pinned: !preference.pinned });
          return;
        }
        setPinNotice(undefined);
        onToggleCloudPin(orderId, row.teamId, !preference.pinned);
        return;
      }
      setPinNotice(undefined);
      changeGroupPreference(orderId, { pinned: !preference.pinned });
      return;
    }
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
  const activeRow = activeOrderId ? listItemsRef.current.find((item) => item.id === activeOrderId) : undefined;
  // The unified directory owns its own row menu; it bridges local prefs/settings here.
  useEffect(() => {
    const onPreference = (event: Event) => {
      const detail = (event as CustomEvent<{ orderId?: string; patch?: Partial<OrderGroupPreference>; snapshot?: OrderGroupPreferenceMap; adminUserId?: string }>).detail;
      if (!detail?.orderId || !detail.patch || detail.snapshot) return;
      if (detail.adminUserId !== undefined && detail.adminUserId !== adminUserId) return;
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
    const preferenceOf = (row: OrderTeamListItem) => preferenceFor(row.id, row.teamId);
    const hiddenItems = items.filter((row: OrderTeamListItem) => preferenceOf(row).hidden);
    const visibleItems = items.filter((row: OrderTeamListItem) => !preferenceOf(row).hidden);
    // Pinned groups first, then the latest real message; server order/membership stay unchanged.
    const messageAt = (row: OrderTeamListItem) => Date.parse(row.lastMessageAt ?? row.createdAt ?? "") || 0;
    const orderedItems = [...visibleItems].sort((a, b) => Number(preferenceOf(b).pinned) - Number(preferenceOf(a).pinned) || messageAt(b) - messageAt(a));
    const rows = text ? orderedItems.filter((row: OrderTeamListItem) => `${row.displayNo} ${orderStageLabel(row)}`.toLowerCase().includes(text)) : orderedItems;
    const allHidden = !text && items.length > 0 && rows.length === 0 && hiddenItems.length === items.length;
    return (
      <aside className="im-wb-queue" aria-label="我参与的订单群" onContextMenu={(event) => { if ((event.target as Element).closest(".im-wb-row")) return; event.preventDefault(); setListMenu(null); }}>
        <div className="im-wb-queue-head"><strong>我参与的订单群</strong><b>{items.length - hiddenItems.length}</b></div>
        <label className="im-wb-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索筛选当前列表" aria-label="搜索订单群" /></label>
        <p className="im-wb-filter-note"><Tooltip><TooltipTrigger render={<button type="button" className="im-wb-hint-icon" aria-label="订单群列表范围说明" />}><CircleHelp size={13} /></TooltipTrigger><TooltipContent>仅筛选本机已加载的订单群，计数不代表全部；「我参与的」即当前目录已授权的群。</TooltipContent></Tooltip></p>
        {pinNotice ? <p className="im-wb-notice" data-tone="warn" role="status"><CircleAlert size={13} />{pinNotice}</p> : null}
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
            const preference = preferenceOf(row);
            return (
              <button type="button" key={row.id} className="im-wb-row" data-order-id={row.id} data-active={selectedId === row.id} data-pinned={preference.pinned ? "true" : undefined} data-muted={preference.muted ? "true" : undefined} aria-current={selectedId === row.id ? "page" : undefined}
                onClick={() => {  chooseOrder(row.id); setPane("chat"); }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setListMenu({ x: event.clientX, y: event.clientY, orderId: row.id, preference, row: event.currentTarget }); }}>
                <OrderGroupAvatar displayNo={row.displayNo} className="im-wb-row-av" />
                <span className="im-wb-row-copy">
                  <span className="im-wb-row-top"><b>{row.displayNo}</b>{row.stageCards && ((row.stageCards.unknown ?? 0) > 0 || row.stageCards.attention?.state === "UNKNOWN") ? <i className="im-wb-tag" data-tone="warn">自动卡待核对</i> : null}{preference.pinned ? <i className="im-wb-tag im-og-list-tag" data-tone="pinned">置顶</i> : null}{preference.muted ? <i className="im-wb-tag im-og-list-tag" data-tone="muted">免打扰</i> : null}{(row.unreadCount ?? 0) > 0 && !preference.muted ? <i className="im-wb-unread" aria-label={`${row.unreadCount} 条未读`}>{row.unreadCount! > 99 ? "99+" : row.unreadCount}</i> : null}</span>
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

  const jumpToMessage = (messageId: string) => {
    const node = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === messageId);
    if (!node) return;
    node.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const targetNode = node.querySelector<HTMLElement>(".order-team-msg-body p, .order-card, .message-media, .message-image, .order-team-message-revoked") ?? node;
    targetNode.classList.add("message-quote-target");
    window.setTimeout(() => targetNode.classList.remove("message-quote-target"), 1600);
  };

  const renderOrderHeader = (info: OrderTeamAccess) => {
    const accountSummary = accountSummaryOf(info);
    const accountLine = accountSummary === info.gameName ? info.gameName : `${info.gameName} · ${accountSummary}`;
    return <header className="im-wb-chat-head" ref={chatHeadingRef} tabIndex={-1}>
      <button type="button" className="im-wb-back" data-action="back-to-order-list" onClick={() => setPane("list")}><ChevronLeft size={14} />列表</button>
      <OrderGroupAvatar displayNo={info.displayNo} className="im-wb-chat-av im-wb-order-av" />
      <div className="im-wb-chat-title">
        <h2><span className="im-wb-chat-user">订单 {info.displayNo}</span></h2>
        <span>{accountLine}</span>
      </div>
      <div className="im-wb-chat-actions">
        <span className="im-wb-state">成员 {info.members.length}</span>
        <button ref={groupTriggerRef} type="button" className="im-wb-btn im-wb-btn-icon" data-action="open-group-settings" aria-label="群设置" title="群设置" aria-expanded={groupSettingsOpen}
          onClick={() => { if (groupSettingsOpen) closeGroupSettings(); else openGroupSettings(); }}><Settings size={15} /></button>
        <button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-icon" data-action="toggle-order-details" aria-label={detailsOpen ? "收起本单详情" : "展开本单详情"} title={detailsOpen ? "收起本单详情" : "展开本单详情"} aria-expanded={detailsOpen} aria-controls="im-order-details"
          onClick={() => { if (detailsOpen) closeDetails(); else openDetails(); }}><MoreHorizontal size={15} /></button>
      </div>
    </header>;
  };

  const renderMessageContent = (message: NimMessageLike, info: OrderTeamAccess) => {
    if (message.card) return <OrderCardMessage message={message} info={info} renderHint={orderCardHint} onOpenOrder={() => {
      if (onOpenPath) onOpenPath(`/orders/${encodeURIComponent(info.orderId)}`, `订单 ${info.displayNo ?? info.orderId}`);
      else window.location.assign(`/orders/${encodeURIComponent(info.orderId)}`);
    }} />;
    const image = imageOf(message);
    return <SupportMessageBody message={message}
      image={image ? { url: image.url, thumbnailUrl: image.thumbnailUrl, name: image.name } : null}
      replySenderName={info.members.find((member) => member.accountId === message.reply?.senderId)?.name?.trim() || (message.reply?.senderId === info.botAccountId ? "洲洲助手" : null)}
      onJump={jumpToMessage} align={message.senderId === info.viewerAccountId ? "end" : "start"} />;
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
    const renterPaidCents = centsOf(info.terms?.staff?.buyerTotal);
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
                {renterPaidCents !== null ? <div className="im-rail-value-line" data-kind="paid-total">
                  <span className="im-rail-value-name">租客合计</span>
                  <span className="im-rail-value-figures"><em>{yuanOf(renterPaidCents)}</em></span>
                </div> : null}
              </div>
              <div className="im-rail-section-foot">
                <span>冻结清单 · {visible.length} 项</span>
                <a className="im-rail-link" data-action="order-open-inventory" href={`/orders/${encodeURIComponent(info.orderId)}`} onClick={(e) => { if (onOpenPath) { e.preventDefault(); onOpenPath(`/orders/${encodeURIComponent(info.orderId)}`, `订单 ${info.displayNo ?? info.orderId}`); } }}>查看完整清单<ChevronRight aria-hidden="true" /></a>
              </div>
            </> : <div className="im-rail-value-empty">
              <p className="im-rail-empty">{frozen.length ? "清单中没有数量大于 0 的项目。" : "本单未返回物品清单。"}</p>
              <a className="im-rail-link" data-action="order-open-inventory" href={`/orders/${encodeURIComponent(info.orderId)}`} onClick={(e) => { if (onOpenPath) { e.preventDefault(); onOpenPath(`/orders/${encodeURIComponent(info.orderId)}`, `订单 ${info.displayNo ?? info.orderId}`); } }}>查看完整清单<ChevronRight aria-hidden="true" /></a>
            </div>}
            <p className="im-rail-note">按下单确认价格展示{renterPaidCents !== null ? "；租客合计含押金" : ""}；不代表结算或到账。</p>
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
          <StageCardAttentionNotice stageCards={Array.isArray(info.stageCards) ? info.stageCards : []} terminal={ended} />
          {ended ? null : <OrderFulfillmentSection key={info.orderId} orderId={info.orderId} displayNo={info.displayNo} viewerId={adminUserId} orderStatus={info.orderStatus} canManualClose={canManualClose === true && info.members.some((member) => member.party === "STAFF" && member.platformId === adminUserId)} {...(info.frozenInventory ? { frozenInventory: info.frozenInventory } : {})} />}
        </div>
        <Dialog open={groupSettingsOpen} onOpenChange={(open) => { if (!open) closeGroupSettings(); }}>
          <DialogContent className="im-og-settings-dialog" aria-label="群设置" showCloseButton={false}>
            <AdminOrderGroupSettingsDrawer info={info} request={request}
              preferences={preferenceFor(info.orderId, activeRow?.teamId ?? info.teamId)} pinCloud={Boolean(cloudPinnedTeamIds && (activeRow?.teamId ?? info.teamId))}
              onPreferenceChange={(patch) => {
                if (patch.pinned !== undefined) { performGroupAction("pin", info.orderId, preferenceFor(info.orderId, activeRow?.teamId ?? info.teamId)); return; }
                changeGroupPreference(info.orderId, patch);
              }}
              onHide={() => hideOrderGroup(info.orderId)} onClose={closeGroupSettings} inviteMember={resolvedInviteGroupMember} />
          </DialogContent>
        </Dialog>
      </aside>
    );
  };

  return (
    <OrderTeamPanel
      key={identity} identity={identity} realm="admin" layout="aside" client={client} connection={connection} active={active}
      selectedOrderId={selectedOrderId} controlledSelection={Boolean(onSelectedOrderChange)}
      sendAllowed={sendAllowed} request={request} onAuthError={onAuthError}
      renderHint={orderCardHint} renderTooltip={orderCardHint}
      gridPane={pane} gridDetailsOpen={detailsOpen}
      renderList={renderList} renderAside={renderAside} renderOrderHeader={renderOrderHeader} renderMessageContent={renderMessageContent}
      onBlankContextMenu={(event) => {
        if ((event.target as Element).closest("[data-message-id], .im-wb-row, button, a, input, textarea, [role='menu']")) return;
        event.preventDefault();
        setListMenu(null);
      }}
      onSelectedOrderChange={(orderId) => { setActiveOrderId(orderId); onSelectedOrderChange?.(orderId); }}
    />
  );
}
