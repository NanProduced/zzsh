"use client";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { BellOff, Headphones, Pin, ReceiptText, ShieldCheck } from "lucide-react";
import { ProfileImage } from "@zzsh/ui/profile-image";
import { MessageActionMenu } from "@zzsh/ui/message-actions";
import { orderStageTone, orderTeamLabel } from "@zzsh/ui/order-team-panel";
import { mediaSummaryOf } from "@zzsh/ui/message-media";
import { messageScopeUserLabel } from "@zzsh/ui/display-im";
import { orderReferenceSummary } from "@zzsh/im-client/nim-web-client";
import { isImSystemNoticeText, type ImSystemNotice, type NimMessageLike, type NimMessageMedia } from "@/lib/nim-web-client";
import type { SupportType } from "@/lib/support-intent";
import type { SupportOrder } from "@/lib/support-directory";
import type { DirectoryPreference } from "./support-unread";
import "./support-thread-list.css";

export type Consultation = {
  id: string;
  /** 持久线程 id：同一用户 + 类型跨轮次不变；列表一行对应一条线程。 */
  threadId?: string;
  /** 本轮 id（与 id 相同）；轮次切换时 threadId 不变。 */
  roundId?: string;
  roundSeq?: number;
  threadState?: "IDLE" | "WAITING" | "ACTIVE";
  type: SupportType;
  state: "WAITING" | "ACTIVE" | "CLOSED";
  subjectRef: string | null;
  assignedAdmin: { id: string; name: string; avatar?: string | null } | null;
  peerAccountId: string | null;
  /** 平台“洲洲助手（Bot）”账号；与接待客服的 peerAccountId 不同。 */
  botAccountId?: string | null;
  conversationType: "TEAM";
  conversationId: string | null;
  messageScopeState?: string;
  /** 当前视图角色是否可发送；用户侧线程 Team 就绪即为 true（含 IDLE/CLOSED 轮次）。 */
  canSend?: boolean;
  /** 平台客服最近一次查看本轮的时间；null 表示从未查看，不据消息存在推断已读。 */
  adminReadAt?: string | null;
  /** 本轮评价状态；仅已结束且未评价/未忽略的轮次 available=true。 */
  rating?: { available: boolean; submitted: boolean; dismissed: boolean; score: number | null; comment?: string };
  version: number;
  lastMessageAt: string | null;
  /** 本轮最近一条消息摘要；历史未加载时目录优先显示它。 */
  lastMessagePreview?: string | null;
  /** 用户视图未读事实：lastMessageAt 晚于 user_read_at。 */
  hasUnread?: boolean;
  /** 本轮尚未读的客服消息数；服务端计数，不能由前端推断。 */
  userUnreadCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportMessage = {
  id: string;
  from: "customer" | "agent" | "system";
  text: string;
  time: string;
  status?: "sent" | "read";
  self?: boolean;
  createTime?: number;
  senderId?: string;
  messageClientId?: string;
  messageServerId?: string;
  messageType?: number;
  reply?: { messageId: string; senderId: string; text?: string };
  revoked?: boolean;
  /** Shared decode of a NIM team notification; display decides visibility. */
  notice?: ImSystemNotice;
  /** Raw channel message kept only so reply/revoke/delete can address the original. */
  source?: NimMessageLike;
  image?: { imageId: string; url?: string; thumbnailUrl?: string; name: string; mimeType: string; size: number };
  /** Client-validated video/file/audio envelope; never assembled from message text. */
  media?: NimMessageMedia;
};

export function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "平台客服"; }

/** 选择/消息都以持久线程为键：同一 Team 跨轮次保留历史，轮次 id 变化不换行。 */
export function threadKeyOf(conversation: Pick<Consultation, "id" | "threadId">): string {
  return conversation.threadId || conversation.id;
}

export function threadStateOf(conversation: Pick<Consultation, "state" | "threadState">): "IDLE" | "WAITING" | "ACTIVE" {
  return conversation.threadState ?? (conversation.state === "ACTIVE" ? "ACTIVE" : conversation.state === "WAITING" ? "WAITING" : "IDLE");
}

/**
 * 线程状态短标签。用户侧不露“结束”：轮次结束只是内部状态，用户再发一条消息服务端就会自然开新一轮
 * （既有行为），所以这里只区分“进行中/等待接待”，IDLE 不给标签——客服离开的唯一痕迹是评价卡。
 */
export function threadStateLabel(conversation: Pick<Consultation, "state" | "threadState">): string {
  const state = threadStateOf(conversation);
  return state === "ACTIVE" ? "进行中" : state === "WAITING" ? "等待客服接待" : "";
}

export function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "现在";
}

const LIST_TIME_ZONE = "Asia/Shanghai";
function listDayParts(value: number): { key: string; year: number; month: number; day: number } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", { timeZone: LIST_TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const valueOf = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = valueOf("year");
  const month = valueOf("month") - 1;
  const day = valueOf("day");
  return [year, month, day].every(Number.isFinite) ? { key: `${year}-${month}-${day}`, year, month, day } : null;
}

/** 目录行只显示阶段短标签；完整阶段名仍留在订单群头部和详情里。 */
function compactOrderStage(label: string): string {
  const map: Record<string, string> = {
    "订单群已就绪": "已就绪",
    "订单已完成": "已完成",
    "订单已取消": "已取消",
    "建群待人工核查": "待核查",
    "已付款 · 等待匹配客服": "待匹配",
    "已分配 · 正在准备订单群": "建群中",
    "开租确认": "待开租",
    "等待客服": "待客服",
    "组建订单群": "建群中",
    "结束确认": "待结束",
    "结算完成": "已完成",
  };
  return map[label] ?? label;
}

/**
 * 订单群目录行的兜底摘要：有消息就按消息说，没消息就把阶段说清楚。
 * 结束/结算的群只剩历史可看，不能继续挂着“有新消息”；建群中的群也不该显示“暂无消息”。
 */
function orderDirectorySnippet(order: SupportOrder): string {
  // 结束态只保证“历史仍可查看”；是否还在 72 小时沟通窗口由群内提示说明，目录行不替它下结论。
  if (orderStageTone(order) === "done") return `${orderTeamLabel(order)} · 历史仍可查看`;
  if (order.stage === "ENDING") return `${orderTeamLabel(order)} · 待双方确认`;
  if (order.lastMessageAt) return "有新消息";
  return orderTeamLabel(order);
}

/** 列表时间：刚刚/N 分钟前 → 今天 HH:mm → 昨天 → 一周内星期 → 月日 → 年月日。 */
export function formatListTime(value: number, now = Date.now()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const diff = now - value;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  const parts = listDayParts(value);
  const today = listDayParts(now);
  if (parts && today) {
    if (parts.key === today.key) return formatTime(value);
    const daysAgo = Date.UTC(today.year, today.month, today.day) / 86_400_000 - Date.UTC(parts.year, parts.month, parts.day) / 86_400_000;
    if (daysAgo === 1) return "昨天";
    if (daysAgo > 1 && daysAgo < 7) return new Intl.DateTimeFormat("zh-CN", { timeZone: LIST_TIME_ZONE, weekday: "short" }).format(date);
    if (parts.year === today.year) return `${parts.month + 1}月${parts.day}日`;
    return `${parts.year}年${parts.month + 1}月${parts.day}日`;
  }
  return formatTime(value);
}

type SupportThreadListProps = {
  consultations: Consultation[];
  orders: SupportOrder[];
  messages: Record<string, SupportMessage[]>;
  prefs: Record<string, DirectoryPreference>;
  section: "consultation" | "orders";
  activeId: string | null;
  selectedOrderId: string | null;
  chatPaneVisible: boolean;
  brand: ReactNode;
  close: ReactNode;
  actions: ReactNode;
  onSelectConsultation: (item: Consultation) => void;
  onSelectOrder: (item: SupportOrder) => void;
  onTogglePreference: (key: string, field: keyof DirectoryPreference) => void;
};

/** 客服会话与订单群合并成一个列表，按置顶与最近活动倒序；右键菜单只改本机偏好。 */
export function SupportThreadList({
  consultations, orders, messages, prefs, section, activeId, selectedOrderId, chatPaneVisible,
  brand, close, actions, onSelectConsultation, onSelectOrder, onTogglePreference,
}: SupportThreadListProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; key: string; pref: DirectoryPreference; row: HTMLElement | null } | null>(null);

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, key, pref: prefs[key] ?? { pinned: false, muted: false }, row: event.currentTarget });
  };
  const togglePreference = (key: string, field: keyof DirectoryPreference) => {
    setMenu(null);
    onTogglePreference(key, field);
  };

  const entries = [
    ...consultations.map((item) => ({
      kind: "consultation" as const,
      key: `consultation:${threadKeyOf(item)}`,
      sortAt: Date.parse(item.lastMessageAt ?? item.updatedAt ?? item.createdAt) || 0,
      item,
    })),
    ...orders.map((item) => ({
      kind: "order" as const,
      key: `order:${item.id}`,
      // 订单群排序跟最后一条真实消息；还没说过话的群从建群时间起算。
      sortAt: Date.parse(item.lastMessageAt ?? item.createdAt ?? "") || 0,
      item,
    })),
  ].sort((a, b) => {
    const pinned = Number(Boolean(prefs[b.key]?.pinned)) - Number(Boolean(prefs[a.key]?.pinned));
    return pinned || b.sortAt - a.sortAt;
  });

  return <>
    <nav className="support-directory" aria-label="全部会话">
      <header>{brand}<span className="support-mobile-close">{close}</span></header>{actions}<h2 tabIndex={-1}>全部会话</h2>
      <div className="support-directory-items">
      {consultations.length===50?<p className="support-directory-limit">当前显示最近 50 条咨询记录。</p>:null}
      {entries.length ? entries.map((entry) => {
        const pref = prefs[entry.key] ?? { pinned: false, muted: false };
        if (entry.kind === "consultation") {
          const item = entry.item;
          const threadState = threadStateOf(item);
          const statusLabel = threadStateLabel(item);
          const lastMsg = [...(messages[threadKeyOf(item)] ?? [])].reverse().find((message) => message.from !== "system");
          // 历史未加载时目录显示服务端最近消息摘要；空摘要不能覆盖状态兜底，系统通知也不进摘要。
          const previewText = typeof item.lastMessagePreview === "string" ? orderReferenceSummary(item.lastMessagePreview).trim() : "";
          const previewSnippet = previewText && !isImSystemNoticeText(previewText) ? previewText : "";
          const snippet = lastMsg
            ? lastMsg.image
              ? "[图片]"
              : lastMsg.media
                ? mediaSummaryOf(lastMsg) ?? "[媒体]"
                : lastMsg.text.includes("【咨询订单】")
                  ? "[订单信息]"
                  : orderReferenceSummary(lastMsg.text)
            : previewSnippet
              ? previewSnippet
              : item.messageScopeState === "FAILED"
                ? messageScopeUserLabel("FAILED")
                : item.assignedAdmin?.name && threadState === "ACTIVE"
                  ? `由客服 ${item.assignedAdmin.name} 接待中`
                  : statusLabel || "暂无消息";
          const rowActive = section === "consultation" && activeId === threadKeyOf(item);
          // 只有聊天窗真正可见时，选中线程才算“正在读”；窄屏列表视图保留当前线程的未读。
          const rowUnread = item.hasUnread === true && !(rowActive && chatPaneVisible);
          const unreadCount = rowUnread ? Math.max(0, item.userUnreadCount ?? 0) : 0;
          const timeAt = Math.max(
            item.lastMessageAt ? Date.parse(item.lastMessageAt) || 0 : 0,
            lastMsg?.createTime ?? 0,
          );
          const timeDisplay = timeAt ? formatListTime(timeAt) : undefined;
          return (
            <button
              type="button"
              className="support-conversation-item"
              key={entry.key}
              data-active={rowActive}
              data-thread-state={threadState}
              data-unread={rowUnread}
              data-pinned={pref.pinned || undefined}
              data-muted={pref.muted || undefined}
              onContextMenu={(event) => openMenu(event, entry.key)}
              onClick={() => onSelectConsultation(item)}
            >
              <span className="support-conversation-avatar" data-kind="consultation" aria-hidden="true">
                <ProfileImage src={item.assignedAdmin?.avatar} fallback={item.type === "COMPLAINT" ? <ShieldCheck size={16} /> : <Headphones size={16} />} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </span>
              <span className="support-conversation-copy">
                <strong title={typeLabel(item.type)}>
                  <span className="support-conversation-title">{typeLabel(item.type)}</span>
                  {statusLabel ? <em className="support-thread-state" data-thread-state={threadState}>{statusLabel}</em> : null}
                  {pref.pinned ? <Pin size={11} className="support-directory-flag" aria-label="已置顶" /> : null}
                </strong>
                <span className="support-conversation-snippet">{snippet}</span>
              </span>
              <span className="support-conversation-meta">
                {timeDisplay ? <time dateTime={new Date(timeAt).toISOString()}>{timeDisplay}</time> : null}
                {pref.muted
                  ? <BellOff size={12} className="support-directory-flag" aria-label={rowUnread ? "有未读消息，已免打扰" : "已免打扰"} />
                  : unreadCount > 0
                    ? <b className="support-conversation-unread-dot" role="status" aria-label={`${unreadCount} 条未读`}>{unreadCount > 99 ? "99+" : unreadCount}</b>
                    : rowUnread
                      ? <b className="support-conversation-unread-dot" data-count="unknown" role="status" aria-label="有新消息" />
                      : null}
              </span>
            </button>
          );
        }
        const item = entry.item;
        const orderAt = Date.parse(item.lastMessageAt ?? item.createdAt ?? "") || 0;
        const orderTime = orderAt ? formatListTime(orderAt) : undefined;
        const orderActive = section === "orders" && selectedOrderId === item.id;
        // 最后一句真消息仍然优先；没有摘要时才按阶段兜底——结束态的群不能谎报“有新消息”，
        // 建群中的群也不该说“暂无消息”。系统通知不能成为目录摘要。
        const previewText = typeof item.lastMessagePreview === "string" ? item.lastMessagePreview.trim() : "";
        const orderPreview = previewText && !isImSystemNoticeText(previewText)
          ? previewText
          : orderDirectorySnippet(item);
        // 群聊真正可见时，未读交给服务端清；列表只保留未读事实，不显示气泡。
        const orderUnreadCount = Math.max(0, item.unreadCount ?? 0);
        const orderUnread = orderUnreadCount > 0 && !(orderActive && chatPaneVisible);
        return (
          <button
            type="button"
            className="support-conversation-item"
            key={entry.key}
            data-active={orderActive}
            data-unread={orderUnread || undefined}
            data-pinned={pref.pinned || undefined}
            data-muted={pref.muted || undefined}
            onContextMenu={(event) => openMenu(event, entry.key)}
            onClick={() => onSelectOrder(item)}
          >
            <span className="support-conversation-avatar" data-kind="order" aria-hidden="true">
              <ReceiptText size={16} />
            </span>
            <span className="support-conversation-copy">
              <strong title={`${item.displayNo} · ${orderTeamLabel(item)}`}>
                <span className="support-order-number">{item.displayNo}</span>
                <em className="support-order-stage" data-tone={orderStageTone(item)}>{compactOrderStage(orderTeamLabel(item))}</em>
                {pref.pinned ? <Pin size={11} className="support-directory-flag" aria-label="已置顶" /> : null}
              </strong>
              <span className="support-order-line">
                <span className="support-conversation-tag" data-party={item.party}>{item.party === "owner" ? "出租" : "租入"}</span>
                <span className="support-order-preview">{orderPreview}</span>
              </span>
            </span>
            <span className="support-conversation-meta">
              {orderTime ? <time dateTime={new Date(orderAt).toISOString()}>{orderTime}</time> : null}
              {pref.muted
                ? <BellOff size={12} className="support-directory-flag" aria-label={orderUnread ? "有未读消息，已免打扰" : "已免打扰"} />
                : orderUnread
                  ? <b className="support-conversation-unread-dot" role="status" aria-label={`${orderUnreadCount} 条未读`}>{orderUnreadCount > 99 ? "99+" : orderUnreadCount}</b>
                  : null}
            </span>
          </button>
        );
      }) : <div className="support-list-empty"><Headphones size={22} /><strong>暂无会话</strong><span>联系客服或从订单进入订单群后，会话会出现在这里。</span></div>}
      </div>
    </nav>
    {menu ? <MessageActionMenu key={menu.key} x={menu.x} y={menu.y} label="会话操作"
      items={[
        { id: "pin" as const, label: menu.pref.pinned ? "取消置顶" : "置顶会话" },
        { id: "mute" as const, label: menu.pref.muted ? "取消消息免打扰" : "消息免打扰" },
      ]}
      onSelect={(id) => {
        if (id === "pin") togglePreference(menu.key, "pinned");
        else if (id === "mute") togglePreference(menu.key, "muted");
        else setMenu(null);
      }}
      onClose={() => setMenu(null)} returnFocus={menu.row} /> : null}
  </>;
}