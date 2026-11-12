import { ProfileImage } from "@zzsh/ui/profile-image";
"use client";
import { messageScopeLabel } from "./im-support-vocabulary";
import { NIM_RECEIPT_PENDING, nimMessageView, oldestNimMessage } from "@zzsh/im-client/nim-web-client";
import { SupportMessageBody, supportMessageSummary } from "./im-support-message-body";
import { AftersaleInbox } from "./im-aftersale-inbox";
import type { AftersaleRecord } from "@zzsh/im-client/aftersale";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowDown, Bell, BellOff, CalendarClock, Check, ChevronLeft, CircleAlert, FileText, Headphones, Images, MessageSquareText, MoreHorizontal, Pin, Search, ShieldCheck, Smile, UserRound, Video, X } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { ImClientLifecycle, ImLifecycleSupersededError, isImDisposeFailure, markImDisposeFailure } from "@zzsh/im-client/lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, NIM_IMAGE_MAX_BYTES, NimImageSendError, NimLoginTerminalError, NimMediaSendError, NimTextSendError, validateNimImageFile, validateNimMediaFile, type NimMessageLike, type NimMessageMedia, type NimWebClientLike, type NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { collapseImSystemNotices, decodeImSystemNotice, imSystemNoticeLabel, isImSystemNoticeText, mergeImMessages, type ImSystemNotice } from "@zzsh/im-client/message-state";
import { CHAT_EMOJIS, MessageActionMenu, MessageReplyQuote, useMessageLongPress, type MessageActionId, type MessageActionItem } from "@zzsh/ui/message-actions";
import { MediaDraftBar, mediaMessageOf, mediaSummaryOf, type MessageMediaDraft } from "@zzsh/ui/message-media";
import "@zzsh/ui/message-media.css";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { ActionTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import "@zzsh/ui/message-actions.css";
import { API_ROOT, AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { confirmCurrentForbidden, isCurrentImRequest, messageAccessPath, supportedImageUrl, type ImRequestKey } from "./im-support-guards";
import { canOperateSupportType, createReadClientKey, createSendCapabilityKey } from "./im-support-capabilities";
import { acquireSupportTabLease } from "./support-tab-lease";
import { planSupportNotificationToggle, playSupportChime, readSupportNotificationPreference, requestSupportNotificationPermission, storeSupportNotificationPreference, supportNotificationPermission, unlockSupportAudio, useSupportUnreadNotifications, type SupportNotificationPermission } from "./im-support-notifications";
import { groupPreferenceOf, readOrderGroupPreferences, storeOrderGroupPreferences, useOrderGroupCloudPins, withGroupPreference, ORDER_GROUP_PREF_EVENT, ORDER_GROUP_SETTINGS_EVENT, type OrderGroupPreference, type OrderGroupPreferenceMap } from "./im-support-group-settings";
import { OrderWorkbenchPane } from "./im-support-orders";
import { OrderGroupAvatar } from "./order-group-avatar";
import { orderStageTone } from "@zzsh/ui/order-team-panel";
import type { OrderTeamListItem } from "@zzsh/ui/order-team-panel";
import { ConsultationUserCard } from "./im-support-user-card";
import { EntityPreviewTrigger } from "../components/admin-preview";
import { ConsultationEventsCard, ConsultationRoundsTimeline } from "./im-support-events";
import "./im-support-details.css";
import { formatDuration } from "./im-support-management-model";
import { dayKeyOf, dayLabelOf, formatBytes, formatListTime, formatMonthDay, formatTime, initialOf } from "./im-support-format";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../components/ui/input-group";

import { Kbd } from "../components/ui/kbd";
import { Textarea } from "../components/ui/textarea";

type SupportType = "SERVICE" | "COMPLAINT";
type ConsultationState = "WAITING" | "ACTIVE" | "CLOSED";
type Consultation = {
  id: string;
  /** 持久线程与当前轮次：同一用户+类型的线程跨轮次保留，列表只返回当前未结束的一轮。 */
  threadId?: string;
  roundId?: string;
  roundSeq?: number;
  threadState?: "IDLE" | "WAITING" | "ACTIVE";
  type: SupportType;
  state: ConsultationState;
  assignedAdmin: { id: string; name: string; avatar?: string | null } | null;
  peerAccountId: string | null;
  /** 平台“洲洲助手（Bot）”账号；欢迎语与自动卡片由它发出。 */
  botAccountId?: string | null;
  conversationType: "TEAM";
  conversationId: string | null;
  messageScopeState?: string;
  /** 服务端视角的发送权：只有本轮负责客服为当前账号时才为 true。 */
  canSend?: boolean;
  version: number;
  lastMessageAt: string | null;
  /** 服务端最近一条消息摘要；未打开历史时队列行优先显示它。 */
  lastMessagePreview?: string | null;
  /** 本轮负责客服尚未读的用户消息数；服务端计数，仅 ACTIVE 轮次有意义。 */
  adminUnreadCount?: number;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; name: string; username: string | null; avatar?: string | null };
};
type SupportMessage = {
  id: string;
  from: "customer" | "agent" | "system";
  text: string;
  time: string;
  self?: boolean;
  senderId?: string;
  createTime?: number;
  messageClientId?: string;
  messageServerId?: string;
  messageType?: number;
  revoked?: boolean;
  /** Shared decode of a NIM team notification; display decides visibility. */
  notice?: ImSystemNotice;
  /** Raw channel message kept intact so reply/revoke/delete address the original. */
  source?: NimMessageLike;
  image?: { imageId: string; url?: string; thumbnailUrl?: string; name: string; mimeType: string; size: number };
  media?: NimMessageMedia;
};
type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };
type PresenceToday = { seconds: number; sessions: number; users: number };
type Presence = {
  adminUserId: string;
  availability: "OFF_DUTY" | "AVAILABLE" | "PAUSED";
  connectionState: string;
  lastConfirmedAt?: string | null;
  disconnectedSince?: string | null;
  dispatchPaused?: boolean;
  dispatchable?: boolean;
  reason?: string | null;
  stateRevision?: number;
  activeLoad: number;
  version: number;
  ownedByAnotherSession?: boolean;
  unbound?: boolean;
  today?: PresenceToday;
};
type PresenceHeartbeat = {
  ok: boolean;
  dispatchable: boolean;
  reason: string | null;
  disconnectedSince: string | null;
  dispatchPaused: boolean;
  stateRevision: number;
  today?: PresenceToday;
  serverTime: string;
};
type ConnectionClaim = {
  ok: boolean;
  reason: "CLAIMED" | "OTHER_WINDOW" | "LOCKED" | "FORBIDDEN" | "SESSION_INVALID";
  version?: number;
  stateRevision?: number;
};
type ConnectionLease = { ok: boolean; reason: string };
type SupportSection = "consultation" | "orders";
type QueueRow = { id: string; type: SupportType; title: string; snippet: string; time: string; sortAt: number; state: "待接入" | "接待中" | "已结束" | "通道异常"; unreadCount: number; consultation?: Consultation };
type UnifiedRow = {
  kind: "consultation" | "order";
  avatar?: string | null;
  id: string;
  title: string;
  tag: string;
  tone: "warn" | "neutral";
  snippet: string;
  state: string;
  stateTone: "good" | "warn" | "neutral" | "attention" | "live" | "done" | "danger";
  /** 订单群的到期等次要事实，用 icon+短标签显示，不占时间列。 */
  meta?: string;
  /** UNKNOWN 自动卡只提示核对，不表示已发送或未发送。 */
  stageCardUnknown?: boolean;
  unreadCount: number;
  sortAt: number;
  time: string;
  pinned?: boolean;
  muted?: boolean;
};
type DraftImage = { key: string; file: File; previewUrl: string; name: string; size: number; width: number; height: number; state: "DECODING" | "READY" | "SENDING" | "FAILED" | "UNKNOWN"; progress: number; messageClientId?: string };
type FailedText = { consultationId: string; conversationId: string; text: string; messageClientId?: string };

const MAX_STAGED_IMAGES = 6;
// 固定的业务常用语：只提供可复用句式，不代填任何订单、账号或处理结论。
export const SUPPORT_QUICK_REPLIES = [
  { label: "首次回复", text: "您好，很高兴为您服务，请问有什么可以帮您？" },
  { label: "核对账号", text: "您好，请提供需要处理的账号和验证码，我们马上为您核对。" },
  { label: "核验等待", text: "正在为您核实账号信息，请稍等片刻，处理好后第一时间回复您。" },
  { label: "核验完成", text: "账号已核验完成，请确认账号和密码无误；如有问题随时联系我们。" },
  { label: "结束说明", text: "如暂无其他问题，本次服务就先到这里，后续有问题随时发在这里。" },
] as const;

export type QuickReplyItem = { label: string; text: string };

export function readSupportQuickReplies(adminUserId: string): QuickReplyItem[] {
  if (typeof window === "undefined" || !adminUserId) return [...SUPPORT_QUICK_REPLIES];
  try {
    const raw = window.localStorage.getItem(`zzsh-support-quick-replies:${adminUserId}`);
    if (!raw) return [...SUPPORT_QUICK_REPLIES];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter((item): item is QuickReplyItem => Boolean(item && typeof item.label === "string" && typeof item.text === "string"));
    }
  } catch {
    // fallback
  }
  return [...SUPPORT_QUICK_REPLIES];
}

export function storeSupportQuickReplies(adminUserId: string, items: QuickReplyItem[]): void {
  if (typeof window === "undefined" || !adminUserId) return;
  window.localStorage.setItem(`zzsh-support-quick-replies:${adminUserId}`, JSON.stringify(items));
}
// 预设状态写入失败的两种可见结果：版本冲突不是错误，而是"别的窗口已经改过"，
// 所以重新读取后只给中性说明；真正的保存失败不能留在旧显示上假装成功。
const PRESENCE_CONFLICT_NOTICE = "另一窗口已更新接待状态，已刷新为最新状态。";
const PRESENCE_SAVE_ERROR = "接待状态未保存，请重试";
const SESSION_REFRESH_ERROR = "会话状态刷新失败";
const QUEUE_REFRESH_ERROR = "队列刷新失败";
const GROUP_WINDOW_MS = 300_000;
// 回复没有“按原消息 ID 重放”的接口：结果未知时只能保留草稿与引用，等人工刷新确认，
// 不能用一条新消息自动重发。
const REPLY_UNCERTAIN_NOTICE = "回复结果未确认，请刷新确认后再发送；取消引用后可按普通消息发送。";
// 本轮结束结果未知时的说明。不复述"仍进行中/已结束"这类推断：平台当前没有按咨询读取本轮
// 结果的接口，目录缺席、分页、转交、失权都证明不了远端到底有没有执行这次结束本轮。
const CLOSE_OUTCOME_UNKNOWN_NOTICE = "本轮结束结果未确认：这次结束本轮可能已生效也可能没有。平台目前没有按咨询读取本轮结果的接口，本页无法确认，也不会重复提交；请由平台侧核对后再处理。";
const ROUND_CLOSED_NOTICE = "本轮已结束，聊天记录保留；用户再次咨询会在同一会话开启新一轮。";
type SupportHistoryPage={messages:NimMessageLike[];hasMore:boolean;anchor?:NimMessageLike|string};
async function readConsultationHistory(client:NimWebClientLike,conversationId:string,before?:NimMessageLike|string):Promise<SupportHistoryPage>{
  if(client.transport==="local-fake"){
    const messages=await client.getMessageHistory(conversationId,50,typeof before==="object"?before:undefined);
    return {messages,hasMore:messages.length===50,anchor:oldestNimMessage(messages)};
  }
  const query=new URLSearchParams({mode:"member",conversationId,limit:"50"});if(typeof before==="string")query.set("cursor",before);
  const page=await adminRequest<{messages:NimMessageLike[];hasMore:boolean;nextCursor:string|null}>(`/im/messages?${query}`);
  return {messages:page.messages.map(nimMessageView).filter((message):message is NimMessageLike=>message!==null),hasMore:page.hasMore,anchor:page.nextCursor??undefined};
}

// 「案件进度」stepper 与「下一步 / 轮到你回复」已移除：assignedAdmin + messageScopeState
// 只能证明当前的接待关系与远端就绪状态，证明不了处理轮次，也证明不了历史阶段时间。
// 处理记录时间线由 ConsultationEventsCard 按真实事件投影渲染，不再从当前状态推断。
function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "平台咨询"; }
function roundSeqOf(consultation: { roundSeq?: number }): number | null {
  return typeof consultation.roundSeq === "number" && Number.isInteger(consultation.roundSeq) && consultation.roundSeq > 0 ? consultation.roundSeq : null;
}
function roundTagOf(consultation: Consultation): string {
  const seq = roundSeqOf(consultation);
  return seq === null ? "" : `第 ${seq} 轮`;
}
function roundHeadlineOf(consultation: Consultation): string {
  const seq = roundSeqOf(consultation);
  const round = seq === null ? "" : `第 ${seq} 轮接待 · `;
  if (consultation.state === "WAITING") return `${round}等待客服接入`;
  if (consultation.assignedAdmin) return `${round}${consultation.assignedAdmin.name}`;
  return `${round}尚未分配接待`;
}
function stateLabel(state: ConsultationState): QueueRow["state"] { return state === "ACTIVE" ? "接待中" : state === "WAITING" ? "待接入" : "已结束"; }
function scopeStateLabel(consultation: Consultation): QueueRow["state"] { return consultation.messageScopeState === "FAILED" ? "通道异常" : stateLabel(consultation.state); }
function stageLabelOf(row: OrderTeamListItem): string {
  switch (row.stage) {
    case "WAITING_STAFF": return "待分配";
    case "TEAM_PENDING": return "建群中";
    case "OPENING_CONFIRM": return "待开租确认";
    case "RENTING": return "租用中";
    case "ENDING": return "待结束";
    case "SETTLED": return "已完成";
    case "CANCELLED": return "已取消";
    default: return row.status === "COMPLETED" ? "已完成" : row.status === "CANCELLED" ? "已取消" : "订单沟通";
  }
}
function stageToneOf(state: string): "good" | "warn" | "neutral" {
  return state === "接待中" || state === "租用中" ? "good" : state === "待接入" || state === "通道异常" || state === "已取消" ? "warn" : "neutral";
}
function connectionForPresence(state: NimWebConnectionState | "idle" | "error"): NimWebConnectionState {
  return state === "idle" ? "DISCONNECTED" : state === "error" ? "AUTH_FAILED" : state;
}
function createConnectionId(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (value) return value;
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
/**
 * A stale heartbeat may only be retried with the connection that is live *now*.
 * A late CONNECTED from a kicked/reconnecting/older NIM client must be dropped;
 * a terminal state may be re-sent after refreshing the revision because that is
 * the current truth, not the old event.
 */
export function staleHeartbeatRetryState(input: {
  liveConnection: NimWebConnectionState | "idle" | "error";
  terminal: "KICKED" | "AUTH_FAILED" | undefined;
  sentGeneration: number;
  liveGeneration: number;
  sentClient: object | null | undefined;
  liveClient: object | null | undefined;
}): NimWebConnectionState | null {
  if (input.sentGeneration !== input.liveGeneration) return null;
  if ((input.sentClient ?? null) !== (input.liveClient ?? null)) return null;
  const live = connectionForPresence(input.liveConnection);
  if (input.terminal && live !== input.terminal) return null;
  return live;
}
/** Keep the runtime label, tone and action consistent when the IM channel is not CONNECTED. */
export function presenceRuntimeState(
  availability: Presence["availability"],
  connection: NimWebConnectionState | "idle" | "error",
  busy: boolean,
  ownedByAnotherSession = false,
  unbound = false,
  localLeader = true,
  dispatchable = true,
): { connected: boolean; tone: "good" | "warn" | "neutral"; label: string; toggleDisabled: boolean; toggleTitle: string | undefined; toggleLabel: string } {
  const connected = connection === "CONNECTED";
  const owned = ownedByAnotherSession === true;
  const needsExplicitStart = unbound === true;
  const kicked = connection === "KICKED";
  const authFailed = connection === "AUTH_FAILED";
  return {
    connected,
    tone: owned || !localLeader || needsExplicitStart || kicked || authFailed || (availability === "AVAILABLE" && (!connected || !dispatchable)) ? "warn"
      : availability === "AVAILABLE" ? "good" : "neutral",
    label: owned ? (connected ? "其他窗口接待中" : "其他窗口接待中 · 连接异常")
      : !localLeader ? "其他窗口接待中"
        : kicked ? availability === "AVAILABLE" ? "连接被踢下线 · 接待中" : "连接被踢下线 · 未接待"
          : authFailed ? availability === "AVAILABLE" ? "连接认证失败 · 接待中" : "连接认证失败 · 未接待"
            : needsExplicitStart
              ? connected ? "需重新开始接待" : connection === "idle" || connection === "CONNECTING" ? "需重新开始接待 · 连接中" : "需重新开始接待 · 连接异常"
              : connection === "idle" || connection === "CONNECTING"
                ? "连接中"
                : !connected
                  ? availability === "AVAILABLE" ? "连接异常 · 接待中" : "连接异常"
                  : availability === "AVAILABLE"
                    ? dispatchable ? "可接待" : "接待中 · 暂停派单"
                    : availability === "PAUSED" ? "已暂停" : "未上线",
    toggleDisabled: owned ? busy
      : !localLeader ? true
        : needsExplicitStart ? busy || (!connected && !kicked && !authFailed)
          : kicked || authFailed ? busy
            : availability === "AVAILABLE" ? busy : busy || (!connected && !kicked && !authFailed),
    toggleTitle: owned
      ? "接管当前接待窗口"
      : !localLeader ? "当前登录会话的云信连接由另一个标签页持有"
        : kicked ? availability === "AVAILABLE" ? "重新连接并接管当前接待" : "重新连接消息服务"
          : authFailed ? "重新获取登录凭据并连接"
            : needsExplicitStart
              ? connected ? "重新开始接待" : "消息服务异常，暂不可开始接待"
              : availability === "AVAILABLE"
                ? connected ? undefined : "消息服务异常，可先结束接待"
                : connection === "idle" || connection === "CONNECTING" ? "消息通道连接中，请稍候" : !connected ? "消息服务异常，暂不可接待" : undefined,
    toggleLabel: owned ? "接管接待" : !localLeader ? "其他窗口接待中" : kicked ? availability === "AVAILABLE" ? "在此接待" : "重新连接" : authFailed ? "重新连接" : needsExplicitStart ? "开始接待" : availability === "AVAILABLE" ? "暂停接待" : "开始接待",
  };
}
/** Only this write's authoritative response may count as a successful presence change. */
export function presenceWriteSucceeded(value: Presence | undefined, availability: Presence["availability"]): boolean {
  return Boolean(value && value.availability === availability && value.ownedByAnotherSession !== true && value.unbound !== true);
}
/** Read/unread decisions require the workbench tab, the browser page and keyboard focus. */
function supportPageVisible(): boolean {
  return typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
}
function imageOf(message: NimMessageLike): SupportMessage["image"] | undefined {
  if (message.messageType !== 1 || !message.attachment || typeof message.attachment !== "object") return undefined;
  const attachment = message.attachment;
  const imageId = typeof attachment.imageId === "string" ? attachment.imageId : "";
  const url = supportedImageUrl(attachment.url) ?? supportedImageUrl(attachment.thumbUrl);
  const thumbnailUrl = supportedImageUrl(attachment.thumbUrl) ?? url;
  return { imageId, ...(url ? { url } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}), name: typeof attachment.name === "string" ? attachment.name : "图片", mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "image/jpeg", size: typeof attachment.size === "number" ? attachment.size : 0 };
}
const SERVER_SYSTEM_NOTICE_KINDS = new Set([
  "TEAM_CREATED", "MEMBER_JOINED", "MEMBER_LEFT", "TEAM_UPDATED", "TEAM_DISMISSED", "UNKNOWN",
]);

/** Only a shape-valid server notice is trusted; anything else falls back to the shared decoder. */
function serverSystemNotice(message: NimMessageLike): ImSystemNotice | null {
  const notice: unknown = message.systemNotice;
  if (message.messageType !== 5 || !notice || typeof notice !== "object" || Array.isArray(notice)) return null;
  const { kind, text } = notice as { kind?: unknown; text?: unknown };
  if (typeof kind !== "string" || !SERVER_SYSTEM_NOTICE_KINDS.has(kind)
    || typeof text !== "string" || !isImSystemNoticeText(text)) return null;
  return { kind: kind as ImSystemNotice["kind"], text: text.trim() };
}

export function messageFromNim(message: NimMessageLike, accountId: string, peerAccountId?: string | null): SupportMessage | null {
  if (typeof message.senderId !== "string" || !message.senderId) return null;
  const id = message.messageServerId || message.messageClientId || `${message.senderId}-${message.createTime}`;
  const self = message.senderId === accountId;
  const base = {
    id,
    self,
    senderId: message.senderId,
    createTime: message.createTime,
    time: formatTime(message.createTime),
    messageClientId: message.messageClientId,
    ...(message.messageServerId ? { messageServerId: message.messageServerId } : {}),
    ...(message.messageType === undefined ? {} : { messageType: message.messageType }),
    // 引用/撤回/删除都需要原消息对象；列表行只是它的展示投影，不能反向拼一个。
    source: message,
  };
  // 已撤回是占位，不是发言：正文与附件都不再展示，也不再提供菜单。
  if (message.revoked === true) return { ...base, from: self ? "agent" : "customer", text: "", revoked: true };
  const notice = serverSystemNotice(message) ?? decodeImSystemNotice(message);
  // A notification is never attributed to a human speaker, and unknown types
  // are not rendered as if the customer had written them.
  if (notice) return { ...base, from: "system", text: notice.text, notice };
  const image = imageOf(message);
  // Only the client-validated media envelope becomes a media bubble.
  const media = mediaMessageOf(message);
  const text = typeof message.text === "string" && message.text.trim() ? message.text : image || media ? "" : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  // Only the mapped peer is a customer; a colleague staff message stays on the staff
  // side instead of borrowing the current assignee's name or the user's label.
  const from: SupportMessage["from"] = self || (peerAccountId ? message.senderId !== peerAccountId : false) ? "agent" : "customer";
  return { ...base, from, text, ...(image === undefined ? {} : { image }), ...(media === undefined ? {} : { media }) };
}
function httpStatus(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
}
function decodeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => (image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve({ width: image.naturalWidth, height: image.naturalHeight }) : reject(new Error("图片无法解码")));
    image.onerror = () => reject(new Error("图片无法解码"));
    image.src = url;
  });
}
async function readImToken(connectionId: string): Promise<ImToken> {
  const value = await adminRequest<Record<string, unknown>>("/im/token", undefined, "GET", { "x-zzsh-connection-id": connectionId });
  if (typeof value.appKey !== "string" || typeof value.accountId !== "string" || typeof value.token !== "string" || !value.appKey || !value.accountId || !value.token || (value.transport !== "nim" && value.transport !== "local-fake")) throw new Error("云信登录凭据格式无效");
  return { appKey: value.appKey, accountId: value.accountId, token: value.token, transport: value.transport };
}
async function readConsultations(): Promise<Consultation[]> {
  const value = await adminRequest<{ consultations?: unknown }>("/im/consultations?limit=50");
  if (!Array.isArray(value.consultations)) throw new Error("咨询队列格式无效");
  return value.consultations as Consultation[];
}

/** Isolates the 1-second display re-render from the rest of the workbench. */
function TodayDuration({ seconds, active }: { seconds: number | undefined; active: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { setTick(0); }, [seconds]);
  useEffect(() => {
    if (!active || seconds === undefined) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active, seconds]);
  return (
    <ActionTooltip content="今日接待开启时长（含短暂断线和锁屏存活；失联30分钟后按最后可信存活截断）">
      <span className="im-wb-state im-wb-today" data-action="today-duty">今日接待 <b>{seconds === undefined ? "—" : formatDuration(seconds + tick)}</b></span>
    </ActionTooltip>
  );
}

export function ImSupportView({ snapshot, initialSection = "consultation", initialConsultationId, initialOrderId, initialUnifiedType = "ALL", workspaceQuery = {}, onQueryChange, onRefresh, onOpenPath, onDirtyChange, active = true }: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialSection?: "consultation" | "orders";
  initialConsultationId?: string;
  initialOrderId?: string;
  initialUnifiedType?: "ALL" | "SERVICE" | "COMPLAINT" | "ORDER";
  workspaceQuery?: Record<string, string>;
  onQueryChange?: (query: Record<string, string>) => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onOpenPath?: (path: string, title?: string, afterOpen?: () => void) => boolean | void;
  onDirtyChange?: (dirty:boolean)=>void;
  /** False while the workspace tab is hidden; hidden views must not advance unread state or suppress alerts. */
  active?: boolean;
}) {
  const [section, setSection] = useState<SupportSection>(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  // 工作台常驻挂载，切 Tab 只隐藏；把选中与筛选留在工作区 tab query，
  // 刷新后按持久线程（或订单 id）恢复，而不是重新从空状态开始。
  const persistQuery = useCallback((patch: Record<string, string | null>) => {
    if (!onQueryChange) return;
    const next = { ...workspaceQuery };
    for (const [key, value] of Object.entries(patch)) {
      if (value) next[key] = value;
      else delete next[key];
    }
    onQueryChange(next);
  }, [onQueryChange, workspaceQuery]);
  const canRead = hasPermission(snapshot, "im.support.read");
  const profileScope = { profile: hasPermission(snapshot, "user.directory.read"), orders: hasPermission(snapshot, "order.read"), resources: hasPermission(snapshot, "supply.rental_account.read") };
  const canComplaint = hasPermission(snapshot, "im.support.complaint");
  const canAccept = hasPermission(snapshot, "im.support.accept");
  // 自动分配是主路径；手动“接管”只给管理岗，普通客服不再看到接入按钮。
  const canManageSupport = Boolean(snapshot.security.isBoss || snapshot.permissions.includes("im.support.audit.takeover"));
  const canTransfer = hasPermission(snapshot, "im.support.transfer");
  const canPresence = canRead && hasPermission(snapshot, "im.support.presence");
  const readClientKey = createReadClientKey({ adminUserId: snapshot.adminUserId, sessionId: snapshot.session.id, locked: snapshot.session.locked, canRead });
  // Reads are an explicit "user is looking at this" claim: a hidden workspace tab or
  // background browser page must never advance unread state on its own.
  const [pageVisible, setPageVisible] = useState(supportPageVisible);
  useEffect(() => {
    const sync = () => setPageVisible(supportPageVisible());
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  const aftersaleScope=`${readClientKey}:${snapshot.security.isBoss}:${snapshot.permissions.slice().sort().join("|")}`;
  const aftersaleScopeRef=useRef(aftersaleScope);aftersaleScopeRef.current=aftersaleScope;
  const [aftersaleOpen,setAftersaleOpen]=useState(false),[aftersaleDirty,setAftersaleDirty]=useState(false);
  const [activeAftersale,setActiveAftersale]=useState<{id:string;orderId:string;orderDisplayNo:string|null;threadId:string}|null>(null);
  useEffect(()=>{setActiveAftersale(null);},[aftersaleScope]);
  useEffect(()=>{onDirtyChange?.(aftersaleDirty);},[aftersaleDirty,onDirtyChange]);
  useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
  const sendCapabilityKey = createSendCapabilityKey({ canAccept, canComplaint });

  const [queue, setQueue] = useState<Consultation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderQueue, setOrderQueue] = useState<OrderTeamListItem[]>([]);
  const [orderQueueLoaded, setOrderQueueLoaded] = useState(false);
  const [orderSelection, setOrderSelection] = useState<string | null>(null);
  const [orderQueueScope, setOrderQueueScope] = useState<string | null>(null);
  const [orderNextCursor, setOrderNextCursor] = useState<string | null>(null);
  const [orderLoadingMore, setOrderLoadingMore] = useState(false);
  const [orderRefreshing, setOrderRefreshing] = useState(false);
  const [orderQueueNotice, setOrderQueueNotice] = useState<string | undefined>();
  const orderScopeRef = useRef(readClientKey);
  const orderEpochRef = useRef(0);
  const orderNextCursorRef = useRef<string | null>(null);
  const orderPagesLoadedRef = useRef(1);
  const orderLoadingMoreRef = useRef(false);
  const orderRefreshInFlightRef = useRef(false);
  orderScopeRef.current = readClientKey;
  const [groupPrefs, setGroupPrefs] = useState<OrderGroupPreferenceMap>(() => readOrderGroupPreferences(snapshot.adminUserId));
  const [groupPrefsScope, setGroupPrefsScope] = useState(snapshot.adminUserId);
  const [unifiedOrderMenu, setUnifiedOrderMenu] = useState<{ x: number; y: number; orderId: string; preference: OrderGroupPreference; row: HTMLElement | null } | null>(null);
  const [unifiedQuery, setUnifiedQuery] = useState("");
  const [searchConsultations, setSearchConsultations] = useState<Consultation[]>([]);
  const [searchOrders, setSearchOrders] = useState<OrderTeamListItem[]>([]);
  const [searchState, setSearchState] = useState<{ q: string; loading: boolean; error: string | null }>({ q: "", loading: false, error: null });
  const searchEpochRef = useRef(0);
  const [unifiedType, setUnifiedType] = useState<"ALL" | "SERVICE" | "COMPLAINT" | "ORDER">(initialUnifiedType);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReplyItem[]>(() => readSupportQuickReplies(snapshot.adminUserId));
  const [editingQuickReplies, setEditingQuickReplies] = useState(false);
  const [quickReplyDrafts, setQuickReplyDrafts] = useState<QuickReplyItem[]>([]);
  const [quickReplyError, setQuickReplyError] = useState("");
  useEffect(() => { setQuickReplies(readSupportQuickReplies(snapshot.adminUserId)); }, [snapshot.adminUserId]);
  useEffect(() => {
    setGroupPrefs(readOrderGroupPreferences(snapshot.adminUserId));
    setGroupPrefsScope(snapshot.adminUserId);
    setUnifiedOrderMenu(null);
  }, [snapshot.adminUserId]);
  // Below this width a third column leaves the chat unusable, so the case column
// starts collapsed and the operator opens it deliberately.
  const [detailsOpen, setDetailsOpen] = useState(() => !(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width:1439px)").matches));
  const [mobilePane, setMobilePane] = useState<"queue" | "chat" | "details">("queue");
  const narrowScreen = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const viewing = active && pageVisible;
  const chatViewing = viewing && section === "consultation" && (!narrowScreen || mobilePane === "chat");
  const orderViewing = viewing && section === "orders" && (!narrowScreen || mobilePane === "chat");
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"waiting" | "mine">("mine");
  const [blockedConsultations, setBlockedConsultations] = useState<Record<string, boolean>>({});
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">("idle");

  const [localLeader, setLocalLeader] = useState(true);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [connectionLeaseActive, setConnectionLeaseActive] = useState(false);
  const connectionIdRef = useRef(createConnectionId());
  const [presence, setPresence] = useState<Presence>({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const [busy, setBusy] = useState(false);
  const [notifyPermission, setNotifyPermission] = useState<SupportNotificationPermission>(() => supportNotificationPermission());
  const [notifyEnabled, setNotifyEnabled] = useState(() => readSupportNotificationPreference(snapshot.adminUserId));
  // 首个成功队列响应才算“已加载”：空队列也是合法状态，不能用 rows 非空猜测。
  const [queueLoaded, setQueueLoaded] = useState(false);
  useEffect(() => {
    const unlock = () => unlockSupportAudio();
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    return () => document.removeEventListener("pointerdown", unlock, true);
  }, []);
  const [sending, setSending] = useState(false);
  const visibleQueueRow = () => {
    if (typeof document === "undefined") return null;
    const pane = document.querySelector<HTMLElement>(".im-wb-pane:not([hidden])");
    return pane?.querySelector<HTMLElement>('.im-wb-queue .im-wb-row[data-active="true"]')
      ?? pane?.querySelector<HTMLElement>(".im-wb-queue .im-wb-row") ?? null;
  };
  // Keyed by consultation: a receipt for conversation B must never erase the
  // unresolved responsibility belonging to conversation A.
  const [failedText, setFailedText] = useState<Record<string, FailedText | null>>({});
  const textFlightRef = useRef(new Set<string>());
  const [staged, setStaged] = useState<Record<string, DraftImage[]>>({});
  const [pending, setPending] = useState<Record<string, DraftImage | null>>({});
  const [mediaDrafts, setMediaDrafts] = useState<Record<string, MessageMediaDraft | null>>({});
  const mediaDraftsRef = useRef(mediaDrafts);
  mediaDraftsRef.current = mediaDrafts;
  const mediaFlights = useRef(new Map<string, MessageMediaDraft>());
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  // Message actions live per consultation, like drafts: quoting in A must never
  // leak a quote into B, and a late action receipt still belongs to A.
  const [messageMenu, setMessageMenu] = useState<{ key: string; id: string; x: number; y: number; row: HTMLElement | null } | null>(null);
  const [replyTargets, setReplyTargets] = useState<Record<string, SupportMessage | null>>({});
  const [replyUncertain, setReplyUncertain] = useState<Record<string, boolean>>({});
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferState, setTransferState] = useState<{ targets: { adminUserId: string; displayName: string; inGrace?: boolean; disconnectedSince?: string | null }[]; transferReady: boolean } | null>(null);
  const [transferError, setTransferError] = useState<string>();
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferNote, setTransferNote] = useState("");
  // 暂停/下线前提示未完成会话；不阻断，只提供「去交接」入口。
  const [offDutyOpen, setOffDutyOpen] = useState(false);
  // 未开始接待时接入会 503；先给客服一个可操作的开始接待入口，而不是暴露请求编号。
  const [receptionOpen, setReceptionOpen] = useState(false);
  const [pendingTransferId, setPendingTransferId] = useState<string | null>(null);
  // 结束是不可撤销动作（平台侧没有恢复合同），所以走显式确认而不是点一下就走，
  // 并把「结果未确认」当独立状态保留，而不是让人重复点出一个新 POST。
  const [closeOpen, setCloseOpen] = useState(false);
  // 弹窗打开时快照确认对象，避免确认期间切换会话后关错人。
  const [closeTarget, setCloseTarget] = useState<Consultation | null>(null);
  const [closeOutcomeUnknown, setCloseOutcomeUnknown] = useState<Record<string, boolean>>({});
  const [historyMore, setHistoryMore] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyState, setHistoryState] = useState<Record<string, "loading" | "ready" | "error" | "forbidden">>({});
  // 标记已读是平台读取事件：同一轮次的同一历史版本只上报一次；新消息到达时历史版本变化，
  // 负责客服仍在看就必须继续推进已读。轮询/重渲染/重选同一版本不重复发。
  const markedReadSignaturesRef = useRef(new Map<string, string>());
  const readInFlightRef = useRef(new Map<string, string>());
  const markedOrderReadRef = useRef(new Set<string>());

  const lifecycleRef = useRef<ImClientLifecycle<NimWebClientLike> | null>(null);
  const clientRef = useRef<NimWebClientLike | null>(null);
  const cloudPins = useOrderGroupCloudPins(clientRef.current);
  const cloudPinnedTeamIds = cloudPins.status === "CLOUD" ? cloudPins.teamIds : undefined;
  useEffect(() => { if (cloudPins.error) setNotice(cloudPins.error); }, [cloudPins.error]);
  const availabilityRef = useRef<Presence["availability"]>("OFF_DUTY");
  const presenceVersionRef = useRef<number | null>(null);
  const presenceStateRevisionRef = useRef<number | null>(null);
  const heartbeatChainRef = useRef(Promise.resolve());
  const handoffRef = useRef<Promise<void>>(Promise.resolve());
  // 最近一次由服务端确认的 presence。写入失败时用它回退 availabilityRef，
  // 让 30s 心跳与连接事件只重放"已知成立"的状态，而不是重试失败的用户意图。
  const presenceRef = useRef<Presence>({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const presenceWriteRef = useRef(Promise.resolve());
  const connectionRef = useRef(connection);
  const sessionLockedRef = useRef(snapshot.session.locked);
  sessionLockedRef.current = snapshot.session.locked;
  const nimGenerationRef = useRef(0);
  const terminalConnectionRef = useRef<"KICKED" | "AUTH_FAILED" | undefined>(undefined);
  const applyConnection = useCallback((next: NimWebConnectionState | "idle" | "error") => {
    connectionRef.current = next;
    setConnection(next);
  }, []);
  const localLeaderRef = useRef(localLeader);
  localLeaderRef.current = localLeader;
  const authRetryRef = useRef(0);
  const logoutRetryRef = useRef(false);
  const busyOwnerRef = useRef(0);
  const composingRef = useRef(false);
  const chatHeadingRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const consultationVideoInput = useRef<HTMLInputElement | null>(null);
  const consultationFileInput = useRef<HTMLInputElement | null>(null);
  const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const transferTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 关闭在途锁带明确所有者：迟到的 finally 只能释放自己那次操作，不能解锁别人的关闭。
  const closeFlightRef = useRef<{ owner: number; consultationId: string } | null>(null);
  const closeOwnerRef = useRef(0);
  const previousPaneRef = useRef(mobilePane);
  const sendCapabilityRef = useRef(sendCapabilityKey);
  // 最新一次渲染算出的"现在能不能发起外发"。顺序发图时每张图都是一次新的发起，
  // 中途撤权必须停下来，而不是靠服务端 403 兜底。
  const canStartSendRef = useRef(false);
  const canPresenceRef = useRef(canPresence);
  const operatorRef = useRef("");
  const operatorGenerationRef = useRef(0);
  const readyOperatorRef = useRef<string | null>(null);
  const [readyOperator, setReadyOperator] = useState<string | null>(null);
  const markReadyOperator = useCallback((value: string | null) => {
    readyOperatorRef.current = value;
    setReadyOperator(value);
  }, []);
  const selectedIdRef = useRef(selectedId);
  const sectionRef = useRef(section);
  const queueRef = useRef(queue);
  const historyAnchorRef = useRef<Record<string, NimMessageLike|string>>({});
  // Parent-level in-flight image lock keyed by conversation: switching away and
  // back must not release it, otherwise the original send can be re-issued.
  const imageFlights = useRef(new Map<string, DraftImage>());
  const stagedRef = useRef(staged);
  const pendingRef = useRef(pending);
  const sendingRef = useRef(false);
  // assignedAdmin.name is a server-side join of admin user.name; using the same field keeps
// "who is handling this" and "who sent that message" from disagreeing on one screen.
  const operatorName = snapshot.user.name || snapshot.user.displayUsername || snapshot.user.username || "当前管理员";
  sendCapabilityRef.current = sendCapabilityKey;
  canPresenceRef.current = canPresence;
  stagedRef.current = staged;
  pendingRef.current = pending;
  sectionRef.current = section;
  if (operatorRef.current !== readClientKey) { operatorRef.current = readClientKey; operatorGenerationRef.current += 1; }
  selectedIdRef.current = selectedId;
  queueRef.current = queue;

  const draftKey = selectedId ?? "";
  const setFailedFor = (id: string, value: FailedText | null) => setFailedText((current) => ({ ...current, [id]: value }));
  const failedFor = (id: string) => (id ? failedText[id] ?? null : null);
  const draft = drafts[draftKey] ?? "";
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const insertIntoDraft = (insertion: string, close: () => void) => {
    const el = composerRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${insertion}${draft.slice(end)}`;
    if (next.length > 4000) return;
    setDraft(next);
    close();
    requestAnimationFrame(() => {
      el?.focus();
      const position = start + insertion.length;
      el?.setSelectionRange(position, position);
    });
  };
  const insertEmoji = (emoji: string) => insertIntoDraft(emoji, () => setEmojiOpen(false));
  // 常用语只插入草稿，不自动发送；发送仍由客服确认。
  const insertQuickReply = (text: string) => insertIntoDraft(text, () => setQuickReplyOpen(false));
  const beginBusy = () => { const owner = busyOwnerRef.current + 1; busyOwnerRef.current = owner; setBusy(true); return owner; };
  const endBusy = (owner: number) => { if (busyOwnerRef.current === owner) setBusy(false); };
  // 所有 presence 显示/版本只从服务端返回值更新；客户端没有任何"先行生效"的路径。
  const rememberPresence = useCallback((value: Presence) => {
    presenceVersionRef.current = value.version;
    presenceStateRevisionRef.current = value.stateRevision ?? null;
    presenceRef.current = value;
    availabilityRef.current = value.availability;
    setPresence(value);
  }, []);

  const writePresence = useCallback((availability: Presence["availability"], state: ReturnType<typeof connectionForPresence>, options?: { takeover?: boolean }) => {
    const key = readClientKey;
    const generation = operatorGenerationRef.current;
    const current = () => canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation;
    if (!canPresence || !current()) return Promise.resolve<Presence | undefined>(undefined);
    availabilityRef.current = availability;
    const operation = presenceWriteRef.current.then(async () => {
      if (!current()) return undefined;
      let version = presenceVersionRef.current;
      if (version === null) {
        // 本操作员本次会话的第一次写入：先向服务端要当前版本，再写。
        // 上一会话可能已留下 presence 行；此时省略 version 会让 PUT 必然 409，
        // 首屏就变成“未上线 + 一次失败”，而这不是并发冲突。
        try {
          const existing = await adminRequest<Presence>("/im/presence");
          if (!current()) return undefined;
          rememberPresence(existing);
          version = presenceVersionRef.current;
        } catch {
          if (!current()) return undefined;
          // 读不到就保持 null，让服务端按“无行则插入”的规则自行裁决。
        }
      }
      if (!current()) return undefined;
      try {
        const value = await adminRequest<Presence>("/im/presence", {
          availability,
          connectionState: state,
          ...(version === null ? {} : { version }),
          ...(options?.takeover ? { takeover: true } : {}),
          connectionId: connectionIdRef.current,
        }, "PUT");
        if (!current()) return undefined;
        rememberPresence(value);
        return value;
      } catch (cause) {
        if (!canPresenceRef.current || operatorRef.current !== key || operatorGenerationRef.current !== generation) return undefined;
        // 失败不能成为本地状态：先把意图回退到最近一次服务端确认值，显示保持真实。
        availabilityRef.current = presenceRef.current.availability;
        if (httpStatus(cause) === 409) {
          // 版本冲突：别的窗口已写过。读取最新版本与状态，不重发这次 PUT。
          try {
            const latest = await adminRequest<Presence>("/im/presence");
            if (!canPresenceRef.current || operatorRef.current !== key || operatorGenerationRef.current !== generation) return undefined;
            rememberPresence(latest);
            setNotice(PRESENCE_CONFLICT_NOTICE);
          } catch {
            if (canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation) setNotice(PRESENCE_SAVE_ERROR);
          }
          return undefined;
        }
        // 401/423 由 adminRequest 触发的既有会话刷新处理，这里不自行重登。
        setNotice(httpStatus(cause) === 401 || httpStatus(cause) === 423 ? friendlyError(cause) : PRESENCE_SAVE_ERROR);
        return undefined;
      }
    });
    presenceWriteRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [canPresence, readClientKey, rememberPresence]);

  const heartbeatPresence = useCallback((state: NimWebConnectionState, generation: number, client?: NimWebClientLike | null): Promise<void> => {
    const key = readClientKey;
    const operatorGeneration = operatorGenerationRef.current;
    const current = () => canPresenceRef.current && operatorRef.current === key
      && operatorGenerationRef.current === operatorGeneration && localLeaderRef.current
      && !sessionLockedRef.current
      && presenceRef.current.availability === "AVAILABLE"
      && nimGenerationRef.current === generation
      && (client == null || clientRef.current === client);
    const run = async (sendState: NimWebConnectionState, retryStale: boolean): Promise<void> => {
      if (!current()) return;
      if (presenceStateRevisionRef.current === null) {
        const latest = await adminRequest<Presence>("/im/presence").catch(() => null);
        if (!current() || !latest) return;
        rememberPresence(latest);
      }
      try {
        const value = await adminRequest<PresenceHeartbeat>("/im/presence/heartbeat", {
          connectionState: sendState,
          stateRevision: presenceStateRevisionRef.current,
          connectionId: connectionIdRef.current,
        }, "POST");
        if (!current()) return;
        // A newer NIM event already superseded this response; never let a late
        // CONNECTED write over a disconnect/kick/reconnect state.
        if (connectionForPresence(connectionRef.current) !== sendState) return;
        presenceStateRevisionRef.current = value.stateRevision;
        setPresence((currentPresence) => ({
          ...currentPresence,
          connectionState: sendState,
          disconnectedSince: value.disconnectedSince,
          dispatchPaused: value.dispatchPaused,
          dispatchable: value.dispatchable,
          reason: value.reason,
          stateRevision: value.stateRevision,
          ...(value.today ? { today: value.today } : {}),
        }));
        if (value.ok) return;
        if (value.reason === "STALE_STATE" && retryStale) {
          const latest = await adminRequest<Presence>("/im/presence").catch(() => null);
          if (!current() || !latest) return;
          rememberPresence(latest);
          // Retry with the *current* live connection state, not the stale closure's
          // state. A terminal event must be recorded, and an old CONNECTED must not
          // be replayed after the client was kicked or started reconnecting.
          const liveState = staleHeartbeatRetryState({
            liveConnection: connectionRef.current,
            terminal: terminalConnectionRef.current,
            sentGeneration: generation,
            liveGeneration: nimGenerationRef.current,
            sentClient: client,
            liveClient: clientRef.current,
          });
          if (!liveState) return;
          return run(liveState, false);
        }
        const latest = await adminRequest<Presence>("/im/presence").catch(() => null);
        if (!current()) return;
        if (latest) rememberPresence(latest);
        const stopConnection = value.reason === "OTHER_WINDOW" || value.reason === "TAKEN_OVER"
          || value.reason === "STALE_CONNECTION"
          || value.reason === "FORBIDDEN" || value.reason === "SESSION_INVALID" || value.reason === "LOCKED"
          || latest?.ownedByAnotherSession === true;
        if (stopConnection) {
          clientRef.current = null;
          nimGenerationRef.current += 1;
          applyConnection("idle");
          void lifecycleRef.current?.close();
        }
        if (value.reason === "OTHER_WINDOW" || value.reason === "TAKEN_OVER" || latest?.ownedByAnotherSession) {
          setNotice("其他窗口已持有云信连接或接管接待，本页不再登录云信。");
        } else if (value.reason === "FORBIDDEN") setNotice("接待权限已失效，请联系管理岗。");
        else if (value.reason === "ENDED") setNotice("当前接待已结束，如需继续请重新开始接待。");
      } catch {
        // The next interval or visibility event retries; heartbeat failure does not
        // end reception or rewrite the last server-confirmed state.
      }
    };
    heartbeatChainRef.current = heartbeatChainRef.current.then(() => run(state, true), () => run(state, true));
    return heartbeatChainRef.current;
  }, [readClientKey, rememberPresence, applyConnection]);

  // Identity/permission change: drop every private projection and every owned preview URL.
  useEffect(() => {
    clientRef.current = null;
    markReadyOperator(null);
    setQueue([]);
    setQueueLoaded(false);
    setOrderQueue([]);
    setOrderQueueLoaded(false);
    setOrderQueueScope(null);
    setOrderSelection(null);
    setOrderNextCursor(null);
    orderNextCursorRef.current = null;
    orderPagesLoadedRef.current = 1;
    orderLoadingMoreRef.current = false;
    orderRefreshInFlightRef.current = false;
    orderEpochRef.current += 1;
    setOrderQueueNotice(undefined);
    setOrderRefreshing(false);
    setOrderLoadingMore(false);
    setMessages({});
    setDrafts({});
    setSelectedId(null);
    setMessageMenu(null);
    setReplyTargets({});
    setReplyUncertain({});
    setHistoryMore({});
    setHistoryState({});
    markedReadSignaturesRef.current.clear();
    markedOrderReadRef.current.clear();
    readInFlightRef.current.clear();
    setHistoryLoading(false);
    setFailedText({});
    textFlightRef.current.clear();
    setStaged({});
    setPending({});
    imageFlights.current.clear();
    sendingRef.current = false;
    setSending(false);
    historyAnchorRef.current = {};
    const clearedPresence: Presence = { adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 };
    presenceRef.current = clearedPresence;
    setPresence(clearedPresence);
    presenceVersionRef.current = null;
    presenceStateRevisionRef.current = null;
    heartbeatChainRef.current = Promise.resolve();
    availabilityRef.current = "OFF_DUTY";
    applyConnection("idle");
    setLocalLeader(true);
    setReconnectEpoch(0);
    authRetryRef.current = 0;
    logoutRetryRef.current = false;
    setNotice(undefined);
    setBlockedConsultations({});
    setCloseOutcomeUnknown({});
    setCloseOpen(false);
    setCloseTarget(null);
    setOffDutyOpen(false);
    setPendingTransferId(null);
    setTransferOpen(false);
    setTransferNote("");
    closeFlightRef.current = null;
    busyOwnerRef.current += 1;
    setBusy(false);
    presenceWriteRef.current = Promise.resolve();
  }, [readClientKey, snapshot.adminUserId]);

  useEffect(() => () => {
    Object.values(stagedRef.current).flat().forEach((item) => URL.revokeObjectURL(item.previewUrl));
    Object.values(pendingRef.current).forEach((item) => { if (item) URL.revokeObjectURL(item.previewUrl); });
  }, [readClientKey]);

  useEffect(() => {
    if (snapshot.session.locked) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      void onRefresh().then(() => { if (!cancelled) setNotice((current) => current === SESSION_REFRESH_ERROR ? undefined : current); })
        .catch(() => { if (!cancelled) setNotice((current) => current ?? SESSION_REFRESH_ERROR); })
        .finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [onRefresh, snapshot.session.locked]);

  useEffect(() => {
    if (!canRead) return;
    // A locked page holds no live NIM connection. Reset the local state so an
    // unlock cannot send a stale CONNECTED heartbeat before NIM actually recovers.
    if (snapshot.session.locked) { applyConnection("idle"); return; }
    // A kick is terminal until the operator explicitly reconnects; an automatic
    // epoch/retry or an unrelated re-render must not log in over the new client.
    if (terminalConnectionRef.current === "KICKED") { applyConnection("KICKED"); return; }
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryWake: (() => void) | undefined;
    let tabLease: ReturnType<typeof acquireSupportTabLease> | undefined;
    const waitForRetry = (ms: number) => new Promise<void>((resolve) => {
      let settled = false;
      let timer: number | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        window.removeEventListener("online", finish);
        retryWake = undefined;
        resolve();
      };
      retryWake = finish;
      timer = window.setTimeout(finish, ms);
      window.addEventListener("online", finish, { once: true });
    });
    const leaseAbort = new AbortController();
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const lifecycle = new ImClientLifecycle<NimWebClientLike>(async (context) => {
      const token = await readImToken(connectionIdRef.current);
      if (token.transport === "local-fake") return createLocalFakeNimWebClientFactory({ endpoint: "/api/bff/admin/im/messages", accountId: token.accountId, pollMs: 1_500 })(context);
      const factory = createNimWebClientFactory({
        appKey: token.appKey,
        accountId: token.accountId,
        enableCloudConversation: true,
        messageReceiptEndpoint:"/api/bff/admin/im/messages",
        onReceiptStatus:({pending,failed,persistent})=>{if(pending&&(failed||!persistent))setNotice(NIM_RECEIPT_PENDING+(!persistent?"本地恢复记录未保存，请在离开前恢复登记。":""));else if(!pending)setNotice(current=>current?.startsWith(NIM_RECEIPT_PENDING)?undefined:current);},
        messageAuthorization: async ({ conversationId, operation,...intent }) => {
          const value = await adminRequest<{ authorized?: unknown }>(messageAccessPath(conversationId, operation,intent));
          if (value.authorized !== true) throw new Error("当前咨询未获授权");
        },
        tokenProvider: async (accountId) => {
          const refreshed = await readImToken(connectionIdRef.current);
          if (refreshed.accountId !== accountId || refreshed.accountId !== token.accountId) throw new Error("云信账号不匹配");
          return refreshed.token;
        },
      });
      const handle = await factory(context);
      // The token was bound before login, but a takeover can happen while the SDK
      // is logging in. Re-check this exact instance before exposing the client; if
      // it lost the slot, dispose what just logged in instead of keeping two
      // clients on one account.
      try {
        const lease = await adminRequest<ConnectionLease>("/im/presence/connection", { connectionId: connectionIdRef.current }, "POST");
        if (!lease.ok) throw new AdminApiError(
          lease.reason === "LOCKED" ? 423 : lease.reason === "SESSION_INVALID" ? 401 : 409,
          lease.reason,
          undefined,
          "/im/presence/connection",
        );
      } catch (error) {
        try { await handle.dispose(); }
        catch (disposeError) {
          throw markImDisposeFailure(
            error instanceof Error ? error : new Error("IM connection was taken over after login", { cause: error }),
            disposeError,
          );
        }
        throw error;
      }
      return handle;
    });
    lifecycleRef.current = lifecycle;
    const connectionGeneration = ++nimGenerationRef.current;
    terminalConnectionRef.current = undefined;
    // Wait for every prior effect's real NIM close, not only the immediately
    // preceding one. Rapid reconnects must not chain two overlapping clients.
    const previousHandoff = handoffRef.current;
    const current = () => !cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator;
    const readQueueForReadOnly = async () => {
      const queueResult = await readConsultations().catch((cause) => {
        if (current()) setNotice(friendlyError(cause));
        return null;
      });
      if (!current()) return;
      if (queueResult) { setQueue(queueResult); setQueueLoaded(true); }
    };
    const run = async () => {
      try {
        await previousHandoff;
      } catch {
        if (current()) {
          applyConnection("AUTH_FAILED");
          setConnectionLeaseActive(false);
          setNotice("旧连接未安全关闭，请刷新页面后重试。");
        }
        return;
      }
      try {
        // Ownership is decided before any NIM login: a second browser (or a reader
        // without presence permission) must never kick the reception holder.
        let initialPresence: Presence | null = null;
        let initialPresenceError: unknown;
        if (canPresence) {
          try { initialPresence = await adminRequest<Presence>("/im/presence"); }
          catch (cause) { initialPresenceError = cause; }
        }
        if (!current()) return;
        if (initialPresence) rememberPresence(initialPresence);
        if (initialPresence?.ownedByAnotherSession && initialPresence.availability === "AVAILABLE") {
          markReadyOperator(operator);
          setLocalLeader(true);
          setConnectionLeaseActive(false);
          applyConnection("idle");
          await readQueueForReadOnly();
          return;
        }
        if (canPresence && !initialPresence) {
          applyConnection("error");
          const status = httpStatus(initialPresenceError);
          if (status !== undefined && status < 500 && status !== 408 && status !== 429) {
            setNotice("登录状态或接待权限已失效，请重新登录或联系管理员。");
            return;
          }
          setNotice("接待状态读取失败，稍后自动重试。");
          await waitForRetry(5_000);
          if (current()) setReconnectEpoch((value) => value + 1);
          return;
        }
        // One tab per administrator/NIM account owns the single IM login, even
        // when two browser profiles have different auth sessions. The server claim
        // below is the cross-browser authority; this lock only serializes tabs.
        const lease = tabLease = acquireSupportTabLease(`zzsh-im-support:${snapshot.adminUserId}`, leaseAbort.signal);
        setLocalLeader(!lease.supported);
        // Directory reads do not need NIM. Let a waiting tab render the queue and
        // order workbench while the current holder keeps the only IM login.
        markReadyOperator(operator);
        void readQueueForReadOnly();
        const acquired = await lease.acquired;
        if (!acquired) {
          if (current()) { applyConnection("idle"); setNotice("云信连接锁不可用，本页保持只读。"); }
          return;
        }
        if (!current()) return;
        setLocalLeader(true);
        markReadyOperator(operator);
        applyConnection("CONNECTING");
        // Server-side connection claim must run before any NIM login. Two browser
        // sessions that both see an empty presence race on the same row.
        if (current()) {
          let claimed: ConnectionClaim | null = null;
          let claimError: unknown;
          try { claimed = await adminRequest<ConnectionClaim>("/im/presence/connect", { connectionId: connectionIdRef.current }, "POST"); }
          catch (cause) { claimError = cause; }
          if (!current()) return;
          if (!claimed?.ok) {
            const latest = canPresence ? await adminRequest<Presence>("/im/presence").catch(() => null) : null;
            if (!current()) return;
            if (latest) rememberPresence(latest);
            // No NIM client exists yet on this path, so releasing the local lock
            // immediately is safe; a waiting tab may try the server claim next.
            lease.release();
            // A server-side OTHER_WINDOW means this tab is the read-only fallback,
            // including the no-Web-Locks case; it must not present as the holder.
            const waitingForOwnLease = claimed?.reason === "OTHER_WINDOW"
              && (latest?.ownedByAnotherSession === false || latest?.availability !== "AVAILABLE");
            const status = httpStatus(claimError);
            const retryNetwork = !claimed && (status === undefined || status >= 500 || status === 408 || status === 429);
            setLocalLeader(claimed?.reason === "OTHER_WINDOW" ? false : true);
            applyConnection(retryNetwork ? "error" : "idle");
            setConnectionLeaseActive(false);
            setNotice(waitingForOwnLease
              ? "上一个接待连接尚未释放，系统会自动尝试恢复。"
              : claimed?.reason === "OTHER_WINDOW" ? "其他窗口已持有云信连接，本页保持只读。"
              : claimed?.reason === "LOCKED" ? "当前会话已锁屏，解锁后再连接。"
                : retryNetwork ? "消息服务暂不可用，正在自动重试。"
                : "接待权限或登录状态已失效，暂不能连接云信。");
            await readQueueForReadOnly();
            if (waitingForOwnLease || retryNetwork) {
              await waitForRetry(waitingForOwnLease ? 15_000 : 5_000);
              if (current()) setReconnectEpoch((value) => value + 1);
            }
            return;
          }
          presenceVersionRef.current = claimed.version ?? presenceVersionRef.current;
          presenceStateRevisionRef.current = claimed.stateRevision ?? presenceStateRevisionRef.current;
          setConnectionLeaseActive(true);
          setPresence((currentPresence) => ({
            ...currentPresence,
            version: claimed.version ?? currentPresence.version,
            stateRevision: claimed.stateRevision ?? currentPresence.stateRevision,
          }));
        }
        let client: NimWebClientLike | null = null;
        const delays = [3_000, 5_000, 10_000, 30_000, 60_000];
        for (let attempt = 0; !client; attempt += 1) {
          if (!current()) return;
          try {
            client = await lifecycle.open(snapshot.adminUserId);
          } catch (cause) {
            if (!current()) return;
            if (cause instanceof NimLoginTerminalError) {
              if (cause.state === "AUTH_FAILED" && authRetryRef.current < 2) {
                // The first token/login attempt can fail on a stale credential.
                // Re-request the token a bounded number of times; KICKED is never
                // retried, and both terminal states still stop after the limit.
                authRetryRef.current += 1;
                applyConnection("AUTH_FAILED");
                setNotice("云信登录认证失败，正在重新获取登录凭据。");
                void heartbeatPresence("AUTH_FAILED", connectionGeneration, null);
                await waitForRetry(authRetryRef.current === 1 ? 5_000 : 15_000);
                continue;
              }
              terminalConnectionRef.current = cause.state;
              applyConnection(cause.state);
              setNotice(cause.state === "KICKED" ? "云信连接已被其他客户端下线。点击“在此接待”可重新连接。" : "云信登录认证失败，请点击“重新连接”。");
              void heartbeatPresence(cause.state, connectionGeneration, null);
              return;
            }
            if (terminalConnectionRef.current) {
              applyConnection(terminalConnectionRef.current);
              return;
            }
            if (isImDisposeFailure(cause)) {
              terminalConnectionRef.current = "AUTH_FAILED";
              applyConnection("AUTH_FAILED");
              setNotice("旧连接未安全关闭，请刷新页面后重试。");
              return;
            }
            const status = httpStatus(cause);
            if (status === 409) {
              applyConnection("idle");
              setLocalLeader(false);
              setConnectionLeaseActive(false);
              setNotice("其他窗口已接管云信连接，本页保持只读。");
              return;
            }
            if (status === 401 || status === 403 || status === 423) {
              applyConnection("AUTH_FAILED");
              setNotice("登录状态已失效，请重新登录后再连接云信。");
              return;
            }
            // Transport/API failure: keep a controlled retry alive (and wake on
            // `online`) while the session still permits reading. Explicit auth
            // failure or kick is a terminal branch above and is never looped.
            applyConnection(attempt === 0 ? "error" : "RECONNECTING");
            setNotice("消息服务暂不可用，正在自动重连；接待计时与派单暂停由服务端规则保持。");
            await waitForRetry(delays[Math.min(attempt, delays.length - 1)] ?? 60_000);
          }
        }
        if (!current()) return;
        if (!client) return;
        clientRef.current = client;
        markReadyOperator(operator);
        // Register before the first presence/queue read: a disconnect during those
        // requests must not be lost behind a stale CONNECTED state.
        client.onConnectionStateChange((state, details) => {
          if (!current() || clientRef.current !== client) return;
          applyConnection(state);
          let beatGeneration = connectionGeneration;
          if (state === "KICKED" || state === "AUTH_FAILED") {
            terminalConnectionRef.current = state;
            if (retryTimer !== undefined) { window.clearTimeout(retryTimer); retryTimer = undefined; }
            retryWake?.();
            // Invalidate any in-flight CONNECTED response from the previous state.
            beatGeneration = ++nimGenerationRef.current;
          } else if (state === "CONNECTED") {
            terminalConnectionRef.current = undefined;
            authRetryRef.current = 0;
            logoutRetryRef.current = false;
          }
          if (state === "KICKED") {
            const reason = details?.kickedReasonDesc ? `：${details.kickedReasonDesc}` : "";
            setNotice(`云信连接已被其他客户端下线${reason}。点击“在此接待”可重新连接。`);
          } else if (state === "AUTH_FAILED") {
            setNotice("云信登录认证失败，正在重新获取登录凭据。");
          }
          if (canPresenceRef.current && localLeaderRef.current && !presenceRef.current.ownedByAnotherSession) {
            void heartbeatPresence(connectionForPresence(state), beatGeneration, client);
          }
          if (state === "DISCONNECTED" && details?.kind === "LOGOUT" && !logoutRetryRef.current && presenceRef.current.availability === "AVAILABLE") {
            logoutRetryRef.current = true;
            retryTimer = window.setTimeout(() => { retryTimer = undefined; if (current()) setReconnectEpoch((value) => value + 1); }, 0);
          } else if (state === "AUTH_FAILED" && authRetryRef.current < 2) {
            authRetryRef.current += 1;
            retryTimer = window.setTimeout(() => { retryTimer = undefined; if (current()) setReconnectEpoch((value) => value + 1); }, authRetryRef.current === 1 ? 5_000 : 15_000);
          }
        });
        const initialConnection = client.getConnectionState();
        if (initialConnection === "CONNECTED") {
          authRetryRef.current = 0;
          logoutRetryRef.current = false;
          terminalConnectionRef.current = undefined;
        } else if (initialConnection === "KICKED") {
          terminalConnectionRef.current = "KICKED";
          setNotice("云信连接已被其他客户端下线。点击“在此接待”可重新连接。");
        } else if (initialConnection === "AUTH_FAILED") {
          terminalConnectionRef.current = "AUTH_FAILED";
          setNotice("云信登录认证失败，正在重新获取登录凭据。");
          if (authRetryRef.current < 2 && retryTimer === undefined) {
            authRetryRef.current += 1;
            retryTimer = window.setTimeout(() => { retryTimer = undefined; if (current()) setReconnectEpoch((value) => value + 1); }, authRetryRef.current === 1 ? 5_000 : 15_000);
          }
        }
        applyConnection(initialConnection);
        const [presenceResult, queueResult] = await Promise.allSettled([
          canPresence ? adminRequest<Presence>("/im/presence") : Promise.resolve(undefined),
          readConsultations(),
        ]);
        if (!current() || clientRef.current !== client) return;
        if (presenceResult.status === "fulfilled" && presenceResult.value) rememberPresence(presenceResult.value);
        if (queueResult.status === "fulfilled") { setQueue(queueResult.value); setQueueLoaded(true); }
        else setNotice(friendlyError(queueResult.reason));
        if (canPresence && !presenceRef.current.ownedByAnotherSession) {
          void heartbeatPresence(connectionForPresence(client.getConnectionState()), connectionGeneration, client);
        }
        client.onMessages((incoming) => {
          if (!current() || clientRef.current !== client) return;
          for (const raw of incoming) {
            const next = messageFromNim(raw, client.accountId, queueRef.current.find((c) => c.conversationId === raw.conversationId)?.peerAccountId);
            const consultation = queueRef.current.find((candidate) => candidate.state === "ACTIVE" && candidate.assignedAdmin?.id === snapshot.adminUserId && candidate.conversationId === raw.conversationId);
            if (!next || !consultation) continue;
            setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], [next]) }));
            // 即时反馈：服务端计数仍是权威，下一次队列轮询会覆盖这个乐观增量。
            if (next.self !== true && next.from !== "system") setQueue((current) => current.map((item) => item.id === consultation.id
              ? { ...item, adminUnreadCount: Math.min((item.adminUnreadCount ?? 0) + 1, 999) }
              : item));
          }
        });
      } catch (cause) {
        if (current()) { applyConnection("error"); setNotice(friendlyError(cause)); }
      }
    };
    void run();
    return () => {
      cancelled = true;
      leaseAbort.abort();
      retryWake?.();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      clientRef.current = null;
      setConnectionLeaseActive(false);
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) markReadyOperator(null);
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      // Dispose the old NIM connection (including a login that is still opening)
      // before the next effect may claim again. A failed cleanup keeps the lock:
      // an unproven handoff is not a safe handoff.
      const handoff = previousHandoff.then(async () => {
        try {
          await lifecycle.close();
        } catch (error) {
          setNotice("旧连接未安全关闭，请刷新页面后重试。");
          throw error;
        }
        tabLease?.release();
      });
      handoffRef.current = handoff;
      void handoff.catch(() => undefined);
    };
  }, [canPresence, canRead, readClientKey, snapshot.adminUserId, snapshot.session.locked, reconnectEpoch, heartbeatPresence, rememberPresence]);

  // Browser connectivity recovery for a client that was already open. The NIM SDK
  // usually reconnects itself; this is the user-visible fallback when it does not.
  useEffect(() => {
    if (!canRead || !localLeader || snapshot.session.locked) return;
    const onOnline = () => {
      if (terminalConnectionRef.current) return;
      if (["DISCONNECTED", "RECONNECTING", "error"].includes(connectionRef.current)) {
        setReconnectEpoch((value) => value + 1);
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [canRead, localLeader, snapshot.session.locked]);

  useEffect(() => {
    if (!canRead || readyOperator !== readClientKey) return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    let cancelled = false;
    let loading = false;
    const refreshQueue = () => {
      if (cancelled || loading) return;
      loading = true;
      void readConsultations().then((next) => {
        if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator) return;
        setQueue(next);
        setQueueLoaded(true);
        setNotice((current) => current === QUEUE_REFRESH_ERROR ? undefined : current);
      }).catch(() => {
        if (!cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice((current) => current ?? QUEUE_REFRESH_ERROR);
      }).finally(() => { loading = false; });
    };
    const timer = window.setInterval(refreshQueue, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [canRead, connection, readyOperator, readClientKey]);

  // Unified inbox: order groups share the same left directory as consultations.
  useEffect(() => {
    if (!canRead || snapshot.session.locked) return;
    const scope = readClientKey;
    let cancelled = false;
    let loading = false;
    const refreshOrders = async () => {
      if (cancelled || loading || orderLoadingMoreRef.current || orderRefreshInFlightRef.current) return;
      loading = true;
      orderRefreshInFlightRef.current = true;
      setOrderRefreshing(true);
      const epoch = ++orderEpochRef.current;
      const targetPages = Math.max(1, orderPagesLoadedRef.current);
      const pages: OrderTeamListItem[] = [];
      let cursor: string | null = null;
      let next: string | null = null;
      let fetched = 0;
      try {
        for (let page = 0; page < targetPages; page += 1) {
          const pageResult: { items?: OrderTeamListItem[]; nextCursor?: string | null } = await adminRequest<{
            items?: OrderTeamListItem[]; nextCursor?: string | null;
          }>(`/orders/im-groups?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          if (cancelled || orderScopeRef.current !== scope || orderEpochRef.current !== epoch) return;
          const items = Array.isArray(pageResult.items) ? pageResult.items : [];
          pages.push(...items);
          fetched += 1;
          next = typeof pageResult.nextCursor === "string" ? pageResult.nextCursor : null;
          cursor = next;
          if (!cursor) break;
        }
        const seen = new Set<string>();
        const fresh = pages.filter((row) => { if (seen.has(row.id)) return false; seen.add(row.id); return true; });
        setOrderQueue(fresh);
        // A missing row implies removal only after the complete authorized directory was read.
        if (!next) setOrderSelection((current) => current && !seen.has(current) ? null : current);
        orderNextCursorRef.current = next;
        setOrderNextCursor(next);
        orderPagesLoadedRef.current = Math.max(1, fetched);
        setOrderQueueScope(scope);
        setOrderQueueLoaded(true);
        setOrderQueueNotice(undefined);
      } catch (error) {
        if (cancelled || orderScopeRef.current !== scope || orderEpochRef.current !== epoch) return;
        const status = httpStatus(error);
        if (status === 401 || status === 403 || status === 423) {
          setOrderQueue([]);
          setOrderSelection(null);
          orderNextCursorRef.current = null;
          setOrderNextCursor(null);
          orderPagesLoadedRef.current = 1;
          setOrderQueueScope(scope);
          setOrderQueueLoaded(true);
          setOrderQueueNotice("订单群读取权限已变化，列表已隐藏。");
        } else if (pages.length > 0) {
          const seen = new Set<string>();
          const fresh = pages.filter((row) => { if (seen.has(row.id)) return false; seen.add(row.id); return true; });
          setOrderQueue(fresh);
          orderNextCursorRef.current = cursor;
          setOrderNextCursor(cursor);
          orderPagesLoadedRef.current = targetPages;
          setOrderQueueScope(scope);
          setOrderQueueLoaded(true);
          setOrderQueueNotice("部分订单群刷新失败，已显示最新读取页；稍后自动重试。");
        } else {
          setOrderQueueNotice("订单群列表刷新失败，当前显示上次成功结果，可能已过期；稍后自动重试。");
        }
      } finally {
        if (orderScopeRef.current === scope && orderEpochRef.current === epoch) {
          loading = false;
          orderRefreshInFlightRef.current = false;
          setOrderRefreshing(false);
        }
      }
    };
    void refreshOrders();
    const timer = window.setInterval(() => { void refreshOrders(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [canRead, readClientKey, snapshot.session.locked]);

  const visibleOrderQueue = orderQueueScope === readClientKey ? orderQueue : [];
  const orderQueueReady = orderQueueScope === readClientKey && orderQueueLoaded;

  // Server-side search: all authorized consultations and order groups, not just the loaded pages.
  useEffect(() => {
    const text = unifiedQuery.trim();
    const epoch = ++searchEpochRef.current;
    if (!text) {
      setSearchConsultations([]);
      setSearchOrders([]);
      setSearchState({ q: "", loading: false, error: null });
      return;
    }
    if (!canRead || snapshot.session.locked) return;
    setSearchConsultations([]);
    setSearchOrders([]);
    setSearchState({ q: text, loading: true, error: null });
    const timer = window.setTimeout(() => {
      void Promise.allSettled([
        adminRequest<{ consultations?: Consultation[]; query?: string | null }>(`/im/consultations?limit=50&q=${encodeURIComponent(text)}`),
        adminRequest<{ items?: OrderTeamListItem[]; query?: string | null }>(`/orders/im-groups?limit=50&q=${encodeURIComponent(text)}`),
      ]).then(([consultationResult, orderResult]) => {
        if (epoch !== searchEpochRef.current) return;
        const consultations = consultationResult.status === "fulfilled" && Array.isArray(consultationResult.value.consultations)
          ? consultationResult.value.consultations : [];
        const orders = orderResult.status === "fulfilled" && Array.isArray(orderResult.value.items)
          ? orderResult.value.items : [];
        const consultationApplied = consultationResult.status === "fulfilled" && consultationResult.value.query === text;
        const orderApplied = orderResult.status === "fulfilled" && orderResult.value.query === text;
        const failed = consultationResult.status === "rejected" || orderResult.status === "rejected";
        setSearchConsultations(consultationApplied ? consultations : []);
        setSearchOrders(orderApplied ? orders : []);
        setSearchState({
          q: text,
          loading: false,
          error: !consultationApplied || !orderApplied
            ? "搜索服务暂不可用，当前仅搜索已加载的会话"
            : failed ? "部分结果读取失败，请重试" : null,
        });
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [unifiedQuery, canRead, readClientKey, snapshot.session.locked]);

  const serverSearchActive = unifiedQuery.trim().length > 0;
  const searchLimitReached = serverSearchActive && (searchConsultations.length >= 50 || searchOrders.length >= 50);
  const consultationDirectory = useMemo(() => {
    const seen = new Set(queue.map((row) => row.id));
    return [...searchConsultations.filter((row) => !seen.has(row.id)), ...queue];
  }, [queue, searchConsultations]);
  const orderDirectory = useMemo(() => {
    const seen = new Set(visibleOrderQueue.map((row) => row.id));
    return [...visibleOrderQueue, ...searchOrders.filter((row) => !seen.has(row.id))];
  }, [visibleOrderQueue, searchOrders]);
  const visibleGroupPrefs = groupPrefsScope === snapshot.adminUserId ? groupPrefs : {};
  const orderPreferenceOf = (orderId: string, teamId?: string | null): OrderGroupPreference => {
    const preference = groupPreferenceOf(visibleGroupPrefs, orderId);
    return cloudPinnedTeamIds && teamId ? { ...preference, pinned: cloudPinnedTeamIds.has(teamId) } : preference;
  };
  const toggleOrderPin = (orderId: string, teamId: string | null | undefined, pinned: boolean) => {
    if (cloudPinnedTeamIds) {
      if (!teamId) {
        setNotice("该订单群尚未返回云信群号，暂只能在本机置顶。");
        applyGroupPreference(orderId, { pinned });
        return;
      }
      void cloudPins.toggle(teamId, pinned).catch(() => undefined);
      return;
    }
    applyGroupPreference(orderId, { pinned });
  };
  const loadMoreOrders = useCallback(async () => {
    const cursor = orderNextCursorRef.current;
    if (!cursor || orderLoadingMoreRef.current || orderRefreshInFlightRef.current) return;
    const scope = readClientKey;
    const epoch = orderEpochRef.current;
    orderLoadingMoreRef.current = true;
    setOrderLoadingMore(true);
    try {
      const value = await adminRequest<{ items?: OrderTeamListItem[]; nextCursor?: string | null }>(
        `/orders/im-groups?limit=50&cursor=${encodeURIComponent(cursor)}`,
      );
      if (orderScopeRef.current !== scope || orderEpochRef.current !== epoch) return;
      const items = Array.isArray(value.items) ? value.items : [];
      setOrderQueue((current) => {
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...items.filter((row) => !seen.has(row.id))];
      });
      orderPagesLoadedRef.current += 1;
      orderNextCursorRef.current = typeof value.nextCursor === "string" ? value.nextCursor : null;
      setOrderNextCursor(orderNextCursorRef.current);
      setOrderQueueScope(scope);
      setOrderQueueLoaded(true);
      setOrderQueueNotice(undefined);
    } catch (error) {
      if (orderScopeRef.current !== scope || orderEpochRef.current !== epoch) return;
      const status = httpStatus(error);
      if (status === 401 || status === 403 || status === 423) {
        setOrderQueue([]);
        setOrderSelection(null);
        orderNextCursorRef.current = null;
        setOrderNextCursor(null);
        orderPagesLoadedRef.current = 1;
        setOrderQueueNotice("订单群读取权限已变化，列表已隐藏。");
      } else {
        setOrderQueueNotice("加载更多订单群失败，已保留已加载页；请重试。");
      }
    } finally {
      if (orderScopeRef.current === scope && orderEpochRef.current === epoch) {
        orderLoadingMoreRef.current = false;
        setOrderLoadingMore(false);
      }
    }
  }, [readClientKey]);
  useEffect(() => {
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ snapshot?: OrderGroupPreferenceMap; adminUserId?: string }>).detail;
      if (!detail?.snapshot) return;
      if (detail.adminUserId !== undefined && detail.adminUserId !== snapshot.adminUserId) return;
      setGroupPrefs(detail.snapshot);
      setGroupPrefsScope(snapshot.adminUserId);
    };
    window.addEventListener(ORDER_GROUP_PREF_EVENT, onSync);
    return () => window.removeEventListener(ORDER_GROUP_PREF_EVENT, onSync);
  }, [snapshot.adminUserId]);

  const restoredSelectionRef = useRef(false);
  const restoreConsultation = () => {
    if (!initialConsultationId) return false;
    const target = queue.find((item) => item.id === initialConsultationId || (item.threadId ?? item.id) === initialConsultationId);
    if (!target) return false;
    setSection("consultation");
    setSelectedId(target.id);
    restoredSelectionRef.current = true;
    return true;
  };
  const restoreOrder = () => {
    if (!initialOrderId) return false;
    const target = visibleOrderQueue.find((item) => item.id === initialOrderId);
    if (!target) return false;
    setSection("orders");
    setOrderSelection(target.id);
    restoredSelectionRef.current = true;
    return true;
  };
  useEffect(() => {
    if (restoredSelectionRef.current) return;
    // 只恢复当前 section 的选中，等该 section 的目录首次加载完成再判断；
    // 否则先到的另一侧会把视图抢到错误的 section。
    if (initialSection === "orders") {
      if (!orderQueueReady) return;
      if (restoreOrder()) return;
      restoredSelectionRef.current = true;
      return;
    }
    if (!queueLoaded) return;
    if (restoreConsultation()) return;
    restoredSelectionRef.current = true;
  }, [initialConsultationId, initialSection, orderQueueReady, queueLoaded, queue]);

  // 内部切换 section 时也可以回到该 section 上次选中的会话；用户新点一条则不会被覆盖。
  useEffect(() => {
    if (!restoredSelectionRef.current) return;
    if (section === "orders" && !orderSelection && initialOrderId) restoreOrder();
    else if (section === "consultation" && !selectedId && initialConsultationId) restoreConsultation();
  }, [section, orderSelection, selectedId, initialOrderId, initialConsultationId, visibleOrderQueue, queue]);

  // One heartbeat for every connection state. It runs without CONNECTED so a
  // disconnect is reported once, a short reconnect keeps the same interval, and
  // the server can return TAKEN_OVER/ENDED before the next UI action.
  useEffect(() => {
    if (!canPresence || !localLeader || presence.ownedByAnotherSession || presence.unbound
      || presence.availability !== "AVAILABLE" || snapshot.session.locked
      || connection === "idle" || connection === "error") return;
    const beat = () => { void heartbeatPresence(connectionForPresence(connectionRef.current), nimGenerationRef.current, clientRef.current); };
    const timer = window.setInterval(beat, 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") beat(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", beat);
    window.addEventListener("pageshow", beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", beat);
      window.removeEventListener("pageshow", beat);
    };
  }, [canPresence, localLeader, connection, presence.availability, presence.ownedByAnotherSession, presence.unbound, snapshot.session.locked, heartbeatPresence]);

  // Off-duty pages still own the exclusive connection slot. Renew the bounded
  // connection lease so a crashed/closed window can recover after it expires.
  useEffect(() => {
    if (!connectionLeaseActive || !localLeader) return;
    let cancelled = false;
    const renew = () => {
      void adminRequest<ConnectionLease>("/im/presence/connection", { connectionId: connectionIdRef.current }, "POST")
        .then((value) => {
          if (cancelled || value?.ok) return;
          if (value.reason !== "OTHER_WINDOW" && value.reason !== "STALE_CONNECTION") return;
          setConnectionLeaseActive(false);
          clientRef.current = null;
          nimGenerationRef.current += 1;
          applyConnection("idle");
          setLocalLeader(false);
          void lifecycleRef.current?.close();
          setNotice("其他窗口已接管云信连接，本页保持只读。");
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(renew, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyConnection, connectionLeaseActive, localLeader]);

  // Best-effort page-close notice: it only advances the first disconnect time, so
  // a lost beacon (crash, sleep) simply falls back to the last confirmed liveness.
  useEffect(() => {
    if (!localLeader || presence.ownedByAnotherSession) return;
    const onPageHide = (event: PageTransitionEvent) => {
      // bfcache keeps the page (and its SDK) alive; do not hand off on a freeze.
      if (event.persisted) return;
      if (presence.availability === "AVAILABLE") {
        const stateRevision = presenceStateRevisionRef.current;
        if (stateRevision !== null) {
          void fetch(`${API_ROOT}/im/presence/heartbeat`, {
            method: "POST",
            credentials: "include",
            keepalive: true,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connectionState: "DISCONNECTED", stateRevision, connectionId: connectionIdRef.current }),
          }).catch(() => undefined);
        }
      }
      // Dispose every prior effect's SDK, then this effect's client, before
      // clearing the server claim. lifecycleRef may already point at a new effect
      // whose open is still waiting on the old handoff chain; releasing early would
      // let a standby tab log in while the old client is still alive. If any close
      // is unproven or the page unloads first, the bounded lease is the recovery path.
      void (async () => {
        try { await handoffRef.current; } catch { return; }
        const lifecycle = lifecycleRef.current;
        if (lifecycle) {
          try { await lifecycle.close(); } catch { return; }
        }
        await fetch(`${API_ROOT}/im/presence/release`, {
          method: "POST",
          credentials: "include",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: connectionIdRef.current }),
        }).catch(() => undefined);
      })();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [localLeader, presence.availability, presence.ownedByAnotherSession]);

  // 日常流不代选：首次加载或队列刷新不替客服打开会话，否则未读会在没被看到时就上报。
  // 只有显式选择（点行、铃铛通知、交接清单）会设置 selectedId；选中的一轮消失时才清空。
  useEffect(() => {
    if (!selectedId || queue.some((item) => item.id === selectedId)) return;
    setSelectedId(null);
  }, [queue, selectedId]);

  useEffect(() => {
    const items = queue.filter((item) => item.state === "ACTIVE" && item.assignedAdmin?.id === snapshot.adminUserId);
    const waiting = queue.filter((item) => item.state === "WAITING");
    if (filter === "waiting" && !waiting.length && items.length) { setFilter("mine"); return; }
    if (filter === "mine" && !items.length && waiting.length) { setFilter("waiting"); return; }
  }, [filter, queue, snapshot.adminUserId]);

  useEffect(() => {
    if (previousPaneRef.current === mobilePane) return;
    previousPaneRef.current = mobilePane;
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const target = mobilePane === "chat"
      ? chatHeadingRef.current
      : mobilePane === "details"
        ? document.querySelector<HTMLElement>('[data-action="collapse-details"]')
        : visibleQueueRow() ?? document.querySelector<HTMLElement>(".im-wb-row");
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof Node && target.contains(active)) return;
    target.focus();
  }, [mobilePane]);

  const selected = consultationDirectory.find((item) => item.id === selectedId) ?? null;
  const selectedMessages = messages[selectedId ?? ""] ?? [];
  // 订单群未读按成员身份计数；只有该群聊真的在屏幕上时才清自己的未读。
  const selectedOrderRow = orderSelection ? orderDirectory.find((item) => item.id === orderSelection) ?? null : null;
  useEffect(() => {
    if (!orderViewing || !selectedOrderRow || (selectedOrderRow.unreadCount ?? 0) <= 0) return;
    const signature = `${selectedOrderRow.id}:${selectedOrderRow.lastMessageAt ?? ""}:${selectedOrderRow.unreadCount}`;
    if (markedOrderReadRef.current.has(signature)) return;
    markedOrderReadRef.current.add(signature);
    void adminRequest(`/im/order-teams/${encodeURIComponent(selectedOrderRow.id)}/read`, {}, "POST")
      .then(() => setOrderQueue((current) => current.map((item) => item.id === selectedOrderRow.id ? { ...item, unreadCount: 0 } : item)))
      .catch(() => markedOrderReadRef.current.delete(signature));
  }, [orderViewing, selectedOrderRow]);
  const rowOfMessage = (target: EventTarget | null): HTMLElement | null => {
    const element = target as { closest?: (selector: string) => HTMLElement | null } | null;
    if (!element || typeof element.closest !== "function") return null;
    const content = element.closest(".im-wb-bub, .message-media, .message-image, .order-card, p");
    return content ? content.closest("[data-message-id][tabindex]") : null;
  };
  const findSelectedMessage = (id: string | undefined): SupportMessage | null => id ? selectedMessages.find((item) => item.id === id) ?? null : null;
  const openMessageMenu = (message: SupportMessage | null, x: number, y: number, row: HTMLElement | null) => {
    if (!message || message.from === "system" || message.revoked) return;
    setMessageMenu((current) => current?.key === draftKey && current.id === message.id ? current : { key: draftKey, id: message.id, x, y, row });
  };
  const onMessageContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    // 消息区域永远不回落浏览器原生菜单：空白处、系统消息、已撤回只是没有平台动作。
    event.preventDefault();
    const row = rowOfMessage(event.target);
    if (!row) { setMessageMenu(null); return; }
    openMessageMenu(findSelectedMessage(row.dataset.messageId), event.clientX, event.clientY, row);
  };
  const messageLongPress = useMessageLongPress((point, target) => {
    const row = rowOfMessage(target);
    if (row) openMessageMenu(findSelectedMessage(row.dataset.messageId), point.x, point.y, row);
  });
  // 引用目标被删除或撤回后，引用条不能继续声称它还可回复。
  const selectedReply = replyTargets[draftKey] ?? null;
  useEffect(() => {
    if (!selectedReply) return;
    const current = selectedMessages.find((item) => item.id === selectedReply.id);
    if (current && !current.revoked) return;
    setReplyTargets((values) => (values[draftKey] ? { ...values, [draftKey]: null } : values));
    setReplyUncertain((values) => (values[draftKey] ? { ...values, [draftKey]: false } : values));
  }, [draftKey, selectedMessages, selectedReply]);

  // 窄屏上详情是独立面板（不是浮层），所以"关闭详情"必须回到会话本身，而不是留下一个
  // 三个面板都被隐藏的空屏；焦点在面板可见之后交给会话头（或没有选中会话时的队列行）。
  const openDetails = () => {
    setDetailsOpen(true);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches) setMobilePane("details");
  };
  const closeDetails = () => {
    const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
    setDetailsOpen(false);
    if (!narrow) { detailsTriggerRef.current?.focus(); return; }
    setMobilePane(selectedIdRef.current ? "chat" : "queue");
    requestAnimationFrame(() => {
      const target = selectedIdRef.current
        ? chatHeadingRef.current
        : visibleQueueRow() ?? document.querySelector<HTMLElement>(".im-wb-row");
      target?.focus();
    });
  };

  // 切换会话时丢弃未提交的结束确认，避免"看着 A 确认了 B"。
  useEffect(() => { setCloseOpen(false); setCloseTarget(null); }, [selectedId]);
  // 菜单属于点开它的那条消息；切换会话后不能继续浮在另一段对话上。
  useEffect(() => { setMessageMenu(null); }, [selectedId]);

  const displayQueue = useMemo<QueueRow[]>(() => queue.map((item) => {
    const history = messages[item.id] ?? [];
    // 系统通知不是业务消息：摘要、时间和提醒签名都只能跟随最后一条非 system 消息。
    const last = [...history].reverse().find((message) => message.from !== "system");
    const lastMessageAt = item.lastMessageAt ? Date.parse(item.lastMessageAt) : Number.NaN;
    // 后端 best-effort 写入的最近消息摘要；没有历史时用它，避免未打开的 ACTIVE 行只显示“打开查看”。
    const previewText = item.lastMessagePreview ? supportMessageSummary(item.lastMessagePreview).trim() : "";
    const previewIsSystem = Boolean(previewText && isImSystemNoticeText(previewText));
    const preview = previewText && !previewIsSystem ? previewText : null;
    // R1 重写时把这里的措辞缩短成了「待人工核验」，丢掉了「远端结果未知」这个
    // 关键差异（会读成普通待办）。恢复 HEAD 的完整措辞，队列行不得让 FAILED
    // 看起来像正常会话。
    const snippet = item.messageScopeState === "FAILED"
      ? "消息通道远端结果待人工核验，已暂停接待"
      : closeOutcomeUnknown[item.id]
        ? "结束结果未确认，待平台核对"
        : last
        ? `${last.from === "agent" ? (last.self ? "我：" : "客服：") : "用户："}${last.image ? "[图片]" : last.media ? mediaSummaryOf(last) ?? "[媒体]" : last.text || "[空消息]"}`
        : preview ? preview : item.state === "WAITING" ? "等待客服接待" : item.state === "CLOSED" ? "本轮已结束" : "打开查看消息";
    // 历史已加载但没有非 system 消息时，系统通知不能修改排序或提醒。
    const sortAt = last?.createTime ?? (previewIsSystem ? 0 : Number.isFinite(lastMessageAt) ? lastMessageAt : 0);
    return {
      id: item.id,
      type: item.type,
      title: item.user?.name || item.user?.username || "平台用户",
      snippet,
      time: sortAt ? formatListTime(sortAt) : "—",
      sortAt,
      state: scopeStateLabel(item),
      unreadCount: item.state === "ACTIVE" && item.assignedAdmin?.id === snapshot.adminUserId
        ? Math.max(0, item.adminUnreadCount ?? 0)
        : 0,
      consultation: item,
    };
  }), [queue, messages, closeOutcomeUnknown, snapshot.adminUserId]);

  const counts = useMemo(() => ({
    waiting: displayQueue.filter((row) => row.state === "待接入").length,
    mine: displayQueue.filter((row) => row.state === "接待中" || row.state === "通道异常").length,
  }), [displayQueue]);
  const searchQueueRows = useMemo<QueueRow[]>(() => searchConsultations.map((item) => {
    const lastAt = item.lastMessageAt ? Date.parse(item.lastMessageAt) : Number.NaN;
    const previewText = item.lastMessagePreview ? supportMessageSummary(item.lastMessagePreview).trim() : "";
    const preview = previewText && !isImSystemNoticeText(previewText) ? previewText : null;
    const sortAt = Number.isFinite(lastAt) ? lastAt : 0;
    return {
      id: item.id,
      type: item.type,
      title: item.user?.name || item.user?.username || "平台用户",
      snippet: preview ?? (item.state === "WAITING" ? "等待客服接待" : item.state === "CLOSED" ? "本轮已结束" : "打开查看消息"),
      time: sortAt ? formatListTime(sortAt) : "—",
      sortAt,
      state: scopeStateLabel(item),
      unreadCount: item.state === "ACTIVE" && item.assignedAdmin?.id === snapshot.adminUserId
        ? Math.max(0, item.adminUnreadCount ?? 0)
        : 0,
      consultation: item,
    };
  }), [searchConsultations, snapshot.adminUserId]);
  const queueDirectory = useMemo<QueueRow[]>(() => {
    const seen = new Set(displayQueue.map((row) => row.id));
    return [...displayQueue, ...searchQueueRows.filter((row) => !seen.has(row.id))];
  }, [displayQueue, searchQueueRows]);
  const notificationRows = useMemo(() => [
    ...displayQueue.map((row) => ({
      id: row.id,
      title: `${typeLabel(row.type)} · ${row.title}`,
      body: row.snippet,
      signature: `${row.sortAt || ""}|${row.snippet}`,
      unread: row.unreadCount > 0,
    })),
    ...visibleOrderQueue
      .filter((row) => {
        if ((row.unreadCount ?? 0) <= 0) return false;
        const preference = groupPreferenceOf(visibleGroupPrefs, row.id);
        // Muted groups keep an unread dot only in the list; they never raise the bell or a desktop alert.
        return !preference.hidden && !preference.muted;
      })
      .map((row) => {
        const previewText = typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim()
          ? supportMessageSummary(row.lastMessagePreview).trim()
          : "";
        const preview = previewText && !isImSystemNoticeText(previewText) ? previewText : null;
        const sortAt = Date.parse(row.lastMessageAt ?? row.createdAt ?? "") || 0;
        return {
          id: row.id,
          title: `订单群 · ${row.displayNo || row.title || "未命名订单群"}`,
          body: preview ?? (row.lastMessageAt ? "有新消息" : "暂无消息"),
          signature: `${sortAt || ""}|${preview ?? ""}|${row.unreadCount ?? 0}`,
          unread: true,
        };
      }),
  ], [displayQueue, visibleOrderQueue, visibleGroupPrefs]);
  const { unreadCount: notifyUnreadCount } = useSupportUnreadNotifications({
    adminUserId: snapshot.adminUserId,
    enabled: notifyEnabled && notifyPermission === "granted",
    loaded: queueLoaded && (orderQueueReady || Boolean(orderQueueNotice)),
    rows: notificationRows,
    visible: viewing,
    // Only a conversation actually on screen suppresses its own notification.
    selectedId: section === "orders" ? (orderViewing ? orderSelection : null) : chatViewing ? selectedId : null,
    onOpen: (id) => {
      const order = visibleOrderQueue.find((item) => item.id === id);
      const row = queue.find((item) => item.id === id);
      const path = order
        ? `/support?section=orders&order=${encodeURIComponent(id)}`
        : `/support?section=consultation&consultation=${encodeURIComponent(row?.threadId ?? id)}`;
      let selected = false;
      const select = () => {
        selected = true;
        restoredSelectionRef.current = true;
        if (order) {
          setSection("orders");
          setOrderSelection(id);
          persistQuery({ section: "orders", order: id });
        } else {
          setSection("consultation");
          setSelectedId(id);
          persistQuery({ section: "consultation", consultation: row?.threadId ?? id });
        }
        setMobilePane("chat");
      };
      // Bring the hidden support tab forward through the existing workspace guard
      // (permission, dirty form, write lock). A queued discard still runs this
      // callback after confirmation; a refused open never mutates the hidden view.
      const opened = onOpenPath?.(path, undefined, select);
      if (opened === false) return;
      if (!selected) select();
    },
  });
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const text = unifiedQuery.trim().toLowerCase();
    const serverConsultationIds = new Set(searchQueueRows.map((row) => row.id));
    const serverOrderIds = new Set(searchOrders.map((row) => row.id));
    const matches = (row: UnifiedRow, fromServer = false) => fromServer || !text || `${row.title} ${row.snippet} ${row.tag} ${row.state}`.toLowerCase().includes(text);
    const consultations: UnifiedRow[] = queueDirectory
      .filter((row) => unifiedType === "ALL" || (unifiedType !== "ORDER" && row.type === unifiedType))
      .map((row): UnifiedRow => ({
        kind: "consultation", id: row.id, title: row.title, avatar: row.consultation?.user?.avatar,
        tag: row.type === "COMPLAINT" ? "投诉" : "咨询",
        tone: row.type === "COMPLAINT" ? "warn" : "neutral",
        snippet: row.snippet, state: row.state, stateTone: stageToneOf(row.state),
        unreadCount: row.unreadCount, sortAt: row.sortAt, time: row.time,
      }))
      .filter((row) => matches(row, serverConsultationIds.has(row.id)));
    const orders: UnifiedRow[] = (unifiedType === "ALL" || unifiedType === "ORDER" ? orderDirectory : [])
      .filter((row) => !groupPreferenceOf(visibleGroupPrefs, row.id).hidden)
      .map((row): UnifiedRow => {
        const preference = orderPreferenceOf(row.id, row.teamId);
        const state = stageLabelOf(row);
        // 没有消息的订单群用建群时间兜底，列表不留“—”这种无法排序的空时间。
        const sortAt = Date.parse(row.lastMessageAt ?? row.createdAt ?? "") || 0;
        const previewText = typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim()
          ? supportMessageSummary(row.lastMessagePreview).trim()
          : "";
        const preview = previewText && !isImSystemNoticeText(previewText) ? previewText : null;
        return {
          kind: "order" as const,
          id: row.id,
          title: row.displayNo,
          tag: "",
          tone: "neutral" as const,
          snippet: preview ?? (row.lastMessageAt ? "有新消息" : "暂无消息"),
          state, stateTone: orderStageTone(row),
          stageCardUnknown: (row.stageCards?.unknown ?? 0) > 0 || row.stageCards?.attention?.state === "UNKNOWN",
          // 到期只对正在租用/待结束的订单有意义；已完成的历史群不再占用列表宽度。
          meta: row.dueAt && (row.stage === "RENTING" || row.stage === "ENDING") ? `到期 ${formatMonthDay(row.dueAt)}` : undefined,
          unreadCount: Math.max(0, row.unreadCount ?? 0),
          sortAt,
          time: sortAt ? formatListTime(sortAt) : "—",
          pinned: preference.pinned,
          muted: preference.muted,
        };
      })
      .filter((row) => matches(row, serverOrderIds.has(row.id)));
    // 置顶优先，其余一律按最后一条消息倒序；咨询与订单群在同一条时间轴上。
    return [...consultations, ...orders].sort((a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.sortAt - a.sortAt);
  }, [cloudPinnedTeamIds, queueDirectory, visibleGroupPrefs, orderDirectory, searchOrders, searchQueueRows, unifiedQuery, unifiedType]);
  const applyGroupPreference = (orderId: string, patch: Partial<OrderGroupPreference>) => {
    const next = withGroupPreference(visibleGroupPrefs, orderId, patch);
    setGroupPrefs(next);
    setGroupPrefsScope(snapshot.adminUserId);
    storeOrderGroupPreferences(snapshot.adminUserId, next);
    window.dispatchEvent(new CustomEvent(ORDER_GROUP_PREF_EVENT, { detail: { orderId, patch, adminUserId: snapshot.adminUserId } }));
  };
  const unifiedTotal = unifiedRows.length;
  const hiddenOrderCount = visibleOrderQueue.filter((row) => groupPreferenceOf(visibleGroupPrefs, row.id).hidden).length;
  const restoreHiddenOrders = () => {
    const next: OrderGroupPreferenceMap = {};
    for (const [orderId, preference] of Object.entries(visibleGroupPrefs)) next[orderId] = { ...preference, hidden: false };
    setGroupPrefs(next);
    setGroupPrefsScope(snapshot.adminUserId);
    storeOrderGroupPreferences(snapshot.adminUserId, next);
    for (const [orderId, preference] of Object.entries(visibleGroupPrefs)) {
      if (preference.hidden) window.dispatchEvent(new CustomEvent(ORDER_GROUP_PREF_EVENT, { detail: { orderId, patch: { hidden: false }, adminUserId: snapshot.adminUserId } }));
    }
  };
  const handleUnifiedOrderMenuAction = (action: MessageActionId) => {
    const menu = unifiedOrderMenu;
    setUnifiedOrderMenu(null);
    if (!menu) return;
    if (action === "pin") { toggleOrderPin(menu.orderId, orderDirectory.find((row) => row.id === menu.orderId)?.teamId, !menu.preference.pinned); return; }
    if (action === "mute") { applyGroupPreference(menu.orderId, { muted: !menu.preference.muted }); return; }
    if (action === "hide") {
      applyGroupPreference(menu.orderId, { hidden: true });
      if (orderSelection === menu.orderId) setOrderSelection(null);
      return;
    }
    if (action === "settings") {
      setSection("orders");
      setOrderSelection(menu.orderId);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(ORDER_GROUP_SETTINGS_EVENT, { detail: { orderId: menu.orderId } })), 160);
    }
  };
  const toggleNotifications = async () => {
    const plan = planSupportNotificationToggle(notifyPermission, notifyEnabled);
    if (plan.kind === "notice") { setNotice(plan.notice); return; }
    if (plan.kind === "request") {
      const permission = await requestSupportNotificationPermission();
      setNotifyPermission(permission);
      if (permission !== "granted") { setNotice("未获得通知权限；也可以保持页面打开并使用页面内未读提示。"); return; }
      // 首次授权成功即开启：偏好默认是“开”，此时再取反会把刚授权的提醒关掉。
      setNotifyEnabled(true);
      storeSupportNotificationPreference(snapshot.adminUserId, true);
      unlockSupportAudio();
      playSupportChime();
      setNotice("消息提醒已开启；请保持工作台标签页打开，关闭标签页后网页无法通知。");
      return;
    }
    const next = plan.enabled;
    setNotifyEnabled(next);
    storeSupportNotificationPreference(snapshot.adminUserId, next);
    if (next) { unlockSupportAudio(); playSupportChime(); setNotice("消息提醒已开启；请保持工作台标签页打开，关闭标签页后网页无法通知。"); }
    else setNotice(undefined);
  };
  // 暂停前清单只列“我名下仍在处理”的咨询；等待接入的不是我的责任。
  const myOpenConsultations = useMemo(
    () => queue.filter((item) => item.state === "ACTIVE" && item.assignedAdmin?.id === snapshot.adminUserId),
    [queue, snapshot.adminUserId],
  );  const filteredQueue = useMemo(() => {
    const text = query.trim().toLowerCase();
    return displayQueue.filter((row) => {
      const inFilter = filter === "waiting" ? row.state === "待接入" : row.state === "接待中" || row.state === "通道异常";
      if (!inFilter) return false;
      if (!text) return true;
      return `${row.title} ${row.snippet} ${typeLabel(row.type)}`.toLowerCase().includes(text);
    });
  }, [displayQueue, filter, query]);

  const canOperateSelected = selected ? canOperateSupportType(selected.type, canAccept, canComplaint) : false;
  const isMine = Boolean(selected?.state === "ACTIVE" && selected.assignedAdmin?.id === snapshot.adminUserId);
  // 服务端 canSend 只在“本轮 ACTIVE 且负责客服是当前账号且消息范围 READY”时为 true。
  // 客户端不再用“有接待权限 + 状态 ACTIVE”自行推断发送权：其他管理员转入只读巡视。
  const serverCanSend = selected?.canSend === true;
  const canEdit = Boolean(canRead && canOperateSelected && isMine && serverCanSend && selected?.state === "ACTIVE" && selected.conversationId && selected.messageScopeState === "READY" && !blockedConsultations[selected.id]);
  const canSend = Boolean(canEdit && clientRef.current && connection === "CONNECTED");
  canStartSendRef.current = canSend;
  const claimReady = Boolean(selected?.state === "WAITING" && !selected.assignedAdmin && canOperateSelected);
  const readOnlyReason = selected && selected.state === "ACTIVE" && !isMine
    ? selected.assignedAdmin
      ? `只读查看：本轮由 ${selected.assignedAdmin.name} 接待，仅负责客服可发送消息或结束本轮。`
      : "只读查看：本轮尚未分配负责客服，暂不可发送消息或结束本轮。"
    : null;
  const readOnlyPlaceholder = selected && selected.state === "ACTIVE" && !isMine
    ? selected.assignedAdmin ? `本轮由 ${selected.assignedAdmin.name} 接待，仅可只读查看` : "本轮尚未分配负责客服，暂不可回复"
    : null;
  const selectedStaged = staged[draftKey] ?? [];
  const selectedPending = pending[draftKey] ?? null;
  const selectedMedia = mediaDrafts[draftKey] ?? null;
  const selectedFailedText = failedFor(draftKey);
  const imageInFlight = Boolean(selectedPending && (selectedPending.state === "SENDING" || imageFlights.current.has(draftKey)));
  const imageBlocked = selectedStaged.some((item) => item.state === "DECODING" || item.width <= 0 || item.height <= 0);
  const mediaInFlight = Boolean(selectedMedia?.state === "SENDING" || mediaFlights.current.has(draftKey));
  const sendBlocked = sending || imageInFlight || mediaInFlight || selectedPending?.state === "UNKNOWN" || selectedPending?.state === "SENDING" || selectedMedia?.state === "UNKNOWN";

  /* ---------- platform message menu: copy / reply / revoke / delete ---------- */
  const replySummaryOf = (message: SupportMessage): string => message.image ? "[图片]" : mediaSummaryOf(message) ?? (message.text.trim() ? supportMessageSummary(message.text).trim().slice(0, 120) : "消息");
  const copyableTextOf = (message: SupportMessage): string | null => !message.revoked && message.from !== "system" && !message.image && !message.media
    && (message.messageType === undefined || message.messageType === 0) && message.text.trim() ? supportMessageSummary(message.text) : null;
  const clearReplyFor = (key: string) => {
    setReplyTargets((current) => (current[key] ? { ...current, [key]: null } : current));
    setReplyUncertain((current) => (current[key] ? { ...current, [key]: false } : current));
  };
  const menuMessage = messageMenu ? (messages[messageMenu.key] ?? []).find((item) => item.id === messageMenu.id) ?? null : null;
  const messageMenuItems: MessageActionItem[] = menuMessage && !menuMessage.revoked && menuMessage.from !== "system" ? [
    ...(copyableTextOf(menuMessage) ? [{ id: "copy" as const, label: "复制" }] : []),
    ...(canSend ? [{ id: "reply" as const, label: "回复" }] : []),
    ...(canSend && menuMessage.self === true && menuMessage.source ? [{ id: "revoke" as const, label: "撤回" }] : []),
    { id: "delete" as const, label: "删除", danger: true },
  ] : [];
  const copySupportMessage = async (message: SupportMessage) => {
    const text = copyableTextOf(message);
    try {
      if (!text || typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setNotice(undefined);
    } catch { setNotice("复制失败，请手动选择文本"); }
  };
  const revokeSupportMessage = async (key: string, message: SupportMessage) => {
    const client = clientRef.current;
    const consultation = queueRef.current.find((item) => item.id === key);
    const conversationId = message.source?.conversationId || consultation?.conversationId;
    if (!client || !conversationId || !message.source) { setNotice("撤回失败，请刷新消息后重试"); return; }
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try {
      const updated = await client.revokeMessage(conversationId, message.source);
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
      const next = messageFromNim(updated, client.accountId, consultation?.peerAccountId);
      if (next) setMessages((current) => ({ ...current, [key]: mergeImMessages(current[key] ?? [], [next]) }));
      if (replyTargets[key]?.id === message.id) clearReplyFor(key);
      setNotice(undefined);
    } catch (cause) {
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator) return;
      const status = httpStatus(cause);
      setNotice(cause instanceof Error && "unknown" in cause && cause.unknown === true ? "撤回结果未确认，请由平台核对，勿重复提交。" : status === 409 ? "当前消息无法撤回，请核对后处理" : status === 403 ? "无权撤回此消息" : "撤回失败，请重试");
    }
  };
  const deleteSupportMessage = async (key: string, message: SupportMessage) => {
    const client = clientRef.current;
    const consultation = queueRef.current.find((item) => item.id === key);
    const conversationId = message.source?.conversationId || consultation?.conversationId;
    if (!client || !conversationId || !message.source) { setNotice("删除失败，消息仍保留"); return; }
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try {
      await client.deleteMessage(conversationId, message.source);
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
      setMessages((current) => ({ ...current, [key]: (current[key] ?? []).filter((item) => item.id !== message.id) }));
      if (replyTargets[key]?.id === message.id) clearReplyFor(key);
      setNotice(undefined);
    } catch (cause) {
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator) return;
      setNotice(cause instanceof Error && "code" in cause && cause.code==="IM_DELETE_UNAVAILABLE" ? cause.message : httpStatus(cause) === 403 ? "无权删除此消息" : "删除失败，消息仍保留");
    }
  };
  const selectMessageAction = (action: MessageActionId) => {
    const menuState = messageMenu;
    const message = menuMessage;
    setMessageMenu(null);
    if (!message || !menuState) return;
    if (action === "copy") { void copySupportMessage(message); return; }
    if (action === "reply") {
      setReplyTargets((current) => ({ ...current, [menuState.key]: message }));
      setReplyUncertain((current) => ({ ...current, [menuState.key]: false }));
      setNotice(undefined);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    if (action === "revoke") { void revokeSupportMessage(menuState.key, message); return; }
    void deleteSupportMessage(menuState.key, message);
  };

  const currentRequestKey = (): ImRequestKey | null => {
    const consultationId = selectedIdRef.current;
    const consultation = consultationId ? queueRef.current.find((item) => item.id === consultationId) : undefined;
    return consultation ? { generation: operatorGenerationRef.current, operator: operatorRef.current, consultationId: consultation.id, conversationId: consultation.conversationId, sendCapability: sendCapabilityRef.current } : null;
  };
  // 请求键按"指定的那条咨询"取，而不是按当前选中项：关闭等操作的结果归属原咨询，
  // 客服切到别的会话后回执仍要能判定是不是同一次操作。
  const requestKeyFor = (consultationId: string): ImRequestKey | null => {
    const consultation = queueRef.current.find((item) => item.id === consultationId);
    return consultation ? { generation: operatorGenerationRef.current, operator: operatorRef.current, consultationId: consultation.id, conversationId: consultation.conversationId, sendCapability: sendCapabilityRef.current } : null;
  };
  const blockCurrentConsultationOnForbidden = useCallback(async (cause: unknown, expected: ImRequestKey): Promise<void> => {
    const current = requestKeyFor(expected.consultationId);
    const shouldBlock = await confirmCurrentForbidden({ originalStatus: httpStatus(cause), expected, current, getCurrent: () => requestKeyFor(expected.consultationId), recheck: (path) => adminRequest(path) });
    if (shouldBlock) setBlockedConsultations((value) => ({ ...value, [expected.consultationId]: true }));
  }, [readClientKey, sendCapabilityKey]);

  const refreshConsultationAccess = async () => {
    const expected = currentRequestKey();
    if (!expected?.conversationId || !blockedConsultations[expected.consultationId]) return;
    const generation = expected.generation;
    const operator = expected.operator;
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      const value = await adminRequest<{ authorized?: unknown }>(messageAccessPath(expected.conversationId, "send"));
      const current = currentRequestKey();
      if (!value || value.authorized !== true) {
        if (current && isCurrentImRequest(expected, current)) setNotice("授权仍未恢复，请稍后再试");
        return;
      }
      if (!current || current.generation !== generation || current.operator !== operator || !isCurrentImRequest(expected, current)) return;
      setBlockedConsultations((existing) => { const next = { ...existing }; delete next[expected.consultationId]; return next; });
      setNotice("授权已恢复");
    } catch (cause) {
      const current = currentRequestKey();
      if (current && isCurrentImRequest(expected, current)) setNotice(friendlyError(cause));
    } finally { endBusy(busyOwner); }
  };

  useEffect(() => {
    if (!canRead || !selected?.conversationId || connection !== "CONNECTED") return;
    const client = clientRef.current;
    if (!client) return;
    const consultation = selected;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    let cancelled = false;
    setHistoryState((current) => ({ ...current, [consultation.id]: "loading" }));
    void readConsultationHistory(client,consultation.conversationId!).then((page) => {
      if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client || selectedIdRef.current !== consultation.id) return;
      const rows = page.messages.map((item) => messageFromNim(item, client.accountId, consultation.peerAccountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], rows) }));
      if(page.anchor)historyAnchorRef.current[consultation.id]=page.anchor;
      setHistoryMore((current) => ({ ...current, [consultation.id]: page.hasMore }));
      setHistoryState((current) => ({ ...current, [consultation.id]: "ready" }));
    }).catch((cause) => {
      if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || selectedIdRef.current !== consultation.id) return;
      // A failed read is not an empty conversation, and already-loaded rows stay.
      setHistoryState((current) => ({ ...current, [consultation.id]: httpStatus(cause) === 403 ? "forbidden" : "error" }));
    });
    return () => { cancelled = true; };
  }, [canRead, connection, readClientKey, selected?.conversationId, selected?.id, selected?.state, selected?.assignedAdmin?.id, selected?.messageScopeState, historyRetryToken]);

  // 负责客服打开 ACTIVE 轮次且历史已成功加载后上报平台已读；新消息改变历史版本时再次推进。
  // 非负责、非 ACTIVE、历史失败或会话不在前台都不发。失败静默，已读只能来自服务端。
  const selectedReadSignature = selected ? `${selectedMessages.length}:${selectedMessages.at(-1)?.id ?? ""}` : "";
  useEffect(() => {
    if (!canRead || !chatViewing || !selected || !selectedMessages.length) return;
    if (selected.state !== "ACTIVE" || selected.assignedAdmin?.id !== snapshot.adminUserId) return;
    if (historyState[selected.id] !== "ready") return;
    const roundId = selected.roundId || selected.id;
    const signature = selectedReadSignature;
    if (!roundId || !signature) return;
    if (markedReadSignaturesRef.current.get(roundId) === signature || readInFlightRef.current.get(roundId) === signature) return;
    readInFlightRef.current.set(roundId, signature);
    void adminRequest(`/im/consultations/${encodeURIComponent(roundId)}/read`, {}, "POST").then(() => {
      if (readInFlightRef.current.get(roundId) === signature) readInFlightRef.current.delete(roundId);
      markedReadSignaturesRef.current.set(roundId, signature);
      setQueue((current) => current.map((item) => item.id === selected.id ? { ...item, adminUnreadCount: 0 } : item));
    }).catch(() => {
      if (readInFlightRef.current.get(roundId) === signature) readInFlightRef.current.delete(roundId);
    });
  }, [canRead, chatViewing, snapshot.adminUserId, selected?.id, selected?.state, selected?.roundId, selected?.assignedAdmin?.id, historyState[selected?.id ?? ""], selectedReadSignature]);

  const reloadHistory = async (consultationId: string) => {
    setHistoryRetryToken((token) => token + 1);
    void consultationId;
  };

  const loadEarlier = async () => {
    if (!canRead || !selected?.conversationId || !clientRef.current || historyLoading) return;
    const client = clientRef.current;
    const consultation = selected;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const anchor = historyAnchorRef.current[consultation.id];
    if (!anchor) { setHistoryMore((current) => ({ ...current, [consultation.id]: false })); return; }
    setHistoryLoading(true);
    try {
      const page = await readConsultationHistory(client,consultation.conversationId!,anchor);
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client || selectedIdRef.current !== consultation.id) return;
      const rows = page.messages.map((item) => messageFromNim(item, client.accountId, consultation.peerAccountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], rows) }));
      if(page.anchor)historyAnchorRef.current[consultation.id]=page.anchor;
      setHistoryMore((current) => ({ ...current, [consultation.id]: page.hasMore }));
    } catch {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice("更早的消息读取失败，请重试。");
    } finally {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) setHistoryLoading(false);
    }
  };

  const claim = async (afterReception = false) => {
    if (!canManageSupport) { setNotice("当前会话由系统自动分配；需要人工接管请联系管理岗。"); return; }
    if (!selected || selected.state !== "WAITING" || !canOperateSupportType(selected.type, canAccept, canComplaint)) return;
    if (operatorRef.current !== readClientKey || selectedIdRef.current !== selected.id) return;
    // Claim is only valid for an AVAILABLE + CONNECTED support presence. Do not
    // send the request while off duty and then surface an opaque 503.
    if (!afterReception && (presence.availability !== "AVAILABLE" || connection !== "CONNECTED")) {
      setReceptionOpen(true);
      return;
    }
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const consultationId = selected.id;
    const requestKey: ImRequestKey = { generation, operator, consultationId, conversationId: selected.conversationId, sendCapability: sendCapabilityKey };
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/claim`, {}, "POST", { "x-zzsh-connection-id": connectionIdRef.current });
      const current = currentRequestKey();
      if (!current || !isCurrentImRequest(requestKey, current) || selectedIdRef.current !== consultationId) return;
      setQueue((current) => current.map((item) => item.id === result.consultation.id ? result.consultation : item));
      setNotice("已接入，正在建立会话");
    } catch (cause) {
      const current = currentRequestKey();
      if (current && isCurrentImRequest(requestKey, current)) {
        setNotice(friendlyError(cause));
      }
    } finally { endBusy(busyOwner); }
  };
  const startReceptionAndClaim = async () => {
    const started = await applyPresence("AVAILABLE", { takeover: true });
    if (!started) return;
    setReceptionOpen(false);
    if (connectionForPresence(connection) !== "CONNECTED") { setNotice("消息服务未连接，暂不能接入会话。"); return; }
    if (!canManageSupport) { setNotice("已开始接待，系统会自动分配会话。"); return; }
    await claim(true);
  };
  const close = async (consultationId: string) => {
    const target = queueRef.current.find((item) => item.id === consultationId);
    // 结束的是“本轮接待”，不是整条线程：必须仍是本轮负责客服且服务端确认可发送。
    if (!target || target.state !== "ACTIVE" || target.canSend !== true || target.assignedAdmin?.id !== snapshot.adminUserId || blockedConsultations[consultationId] || !canOperateSupportType(target.type, canAccept, canComplaint)) return;
    // 结果未知时不再产生新的 close：结束不可撤销，而当前没有任何权威读接口能证明
    // 上一次到底生效没有，重复提交只会制造第二个无法对账的意图。
    if (closeOutcomeUnknown[consultationId]) return;
    // 同步在途锁带所有者：A 在途时 B 不能提交，A 迟到的 finally 也只能释放 A 自己的锁。
    if (closeFlightRef.current) return;
    const owner = ++closeOwnerRef.current;
    closeFlightRef.current = { owner, consultationId };
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const requestKey: ImRequestKey = { generation, operator, consultationId, conversationId: target.conversationId, sendCapability: sendCapabilityKey };
    // 回执归属只看"原身份 + 原操作"，不看当前选中的是谁，也**不看发送能力有没有变**：
    // 同一账号同一会话在途提交后被单独撤销接待/发送权限时，这条请求已经发出去了，
    // 它到底是成功还是 UNKNOWN 必须照样收敛，不能因为"现在没权限了"就把责任丢掉。
    // 能不能发起新操作是另一回事，由入口的 canOperateSupportType/最新权限判断。
    const sameOperation = () => generation === operatorGenerationRef.current && operatorRef.current === operator;
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/close`, {}, "POST");
      if (!sameOperation()) return;
      // 结束的是轮次，不是会话：保留这一行并选中它，让客服还能从同一会话查看历史。
      setQueue((current) => current.map((item) => item.id === result.consultation.id ? result.consultation : item));
      setCloseOutcomeUnknown((value) => { const next = { ...value }; delete next[consultationId]; return next; });
      setCloseOpen(false);
      setSelectedId(result.consultation.id);
      // 只结束本轮：线程与同一 Team 的聊天记录保留，用户再次咨询会在同一线程开启新一轮。
      setNotice(ROUND_CLOSED_NOTICE);
    } catch (cause) {
      await blockCurrentConsultationOnForbidden(cause, requestKey);
      if (!sameOperation()) return;
      const status = httpStatus(cause);
      // 明确的 4xx 才是"服务端拒绝了这次结束"，原意图不成立，可以再决定。
      // 网络中断（status 0）、5xx、超时都是结果未知：保留原关闭意图，不自动重发。
      const definiteRejection = typeof status === "number" && status >= 400 && status < 500;
      if (definiteRejection) { setNotice(friendlyError(cause)); return; }
      setCloseOutcomeUnknown((value) => ({ ...value, [consultationId]: true }));
      setCloseOpen(false);
    } finally {
      if (closeFlightRef.current?.owner === owner) closeFlightRef.current = null;
      endBusy(busyOwner);
    }
  };
  const reconcile = async () => {
    if (!selected || !canTransfer || selected.messageScopeState !== "FAILED") return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const consultationId = selected.id;
    const requestKey: ImRequestKey = { generation, operator, consultationId, conversationId: selected.conversationId, sendCapability: sendCapabilityKey };
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/reconcile`, {}, "POST", { "x-zzsh-connection-id": connectionIdRef.current });
      const current = currentRequestKey();
      if (!current || !isCurrentImRequest(requestKey, current)) return;
      setQueue((current) => current.map((item) => item.id === result.consultation.id ? result.consultation : item));
      setNotice(result.consultation.messageScopeState === "READY" ? "已核验并恢复" : "已提交核验");
    } catch (cause) {
      await blockCurrentConsultationOnForbidden(cause, requestKey);
      const current = currentRequestKey();
      if (current && isCurrentImRequest(requestKey, current)) setNotice(friendlyError(cause));
    } finally { endBusy(busyOwner); }
  };
  const openTransfer = async () => {
    if (!selected || !canTransfer) return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const consultationId = selected.id;
    setTransferOpen(true);
    setTransferState(null);
    setTransferError(undefined);
    setTransferNote("");
    try {
      const value = await adminRequest<{ targets?: unknown; transferReady?: unknown }>(`/im/transfer-targets?consultationId=${encodeURIComponent(consultationId)}`);
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || selectedIdRef.current !== consultationId) return;
      const targets = Array.isArray(value.targets) ? value.targets.filter((target): target is { adminUserId: string; displayName: string; inGrace?: boolean; disconnectedSince?: string | null } => Boolean(target) && typeof target === "object" && typeof (target as { adminUserId?: unknown }).adminUserId === "string" && typeof (target as { displayName?: unknown }).displayName === "string") : [];
      setTransferState({ targets, transferReady: value.transferReady === true });
    } catch (cause) {
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || selectedIdRef.current !== consultationId) return;
      setTransferError(httpStatus(cause) === 404 ? "转交服务暂不可用" : friendlyError(cause));
    }
  };
  const confirmTransfer = async (targetAdminId: string) => {
    if (!selected || !canTransfer) return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const consultationId = selected.id;
    const requestKey: ImRequestKey = { generation, operator, consultationId, conversationId: selected.conversationId, sendCapability: sendCapabilityKey };
    setTransferBusy(true);
    setNotice(undefined);
    const note = transferNote.trim().slice(0, 200);
    try {
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/transfer`, { targetAdminId, ...(note ? { note } : {}) }, "POST");
      const current = currentRequestKey();
      if (!current || !isCurrentImRequest(requestKey, current)) return;
      setQueue((current) => current.map((item) => item.id === result.consultation.id ? result.consultation : item));
      setTransferOpen(false);
      setTransferState(null);
      setTransferNote("");
      setNotice(note ? "已转交，交接备注已记录" : "已转交");
    } catch (cause) {
      await blockCurrentConsultationOnForbidden(cause, requestKey);
      const current = currentRequestKey();
      if (current && isCurrentImRequest(requestKey, current)) setTransferError(friendlyError(cause));
    } finally { setTransferBusy(false); }
  };
  const applyPresence = async (availability: Presence["availability"], options?: { takeover?: boolean }): Promise<boolean> => {
    if (!canPresence) return false;
    const busyOwner = beginBusy();
    setNotice(undefined);
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try {
      const value = await writePresence(availability, connectionForPresence(connection), options);
      return canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator
        && presenceWriteSucceeded(value, availability);
    }
    catch (cause) { if (canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(friendlyError(cause)); return false; }
    finally { endBusy(busyOwner); }
  };
  const endReception = async () => {
    if (!canPresence) return;
    // 暂停/下线前把未完成会话摆出来；用户可以继续暂停，也可以逐条去交接，不强制阻断。
    if (myOpenConsultations.length) { setNotice(undefined); setOffDutyOpen(true); return; }
    await applyPresence("OFF_DUTY");
  };
  const togglePresence = async () => {
    if (!canPresence || !localLeader) return;
    // A terminal connection still keeps the reception entry; the secondary
    // "结束接待" action below is the only way out without reconnecting.
    if (connection === "KICKED" || connection === "AUTH_FAILED") {
      terminalConnectionRef.current = undefined;
      setReconnectEpoch((value) => value + 1);
      return;
    }
    // Another browser session owns reception/connection. Transfer ownership first
    // with a CONNECTING state; the effect opens NIM only after the takeover succeeds.
    if (presence.ownedByAnotherSession === true) {
      const busyOwner = beginBusy();
      setNotice(undefined);
      try {
        const value = await writePresence("AVAILABLE", "CONNECTING", { takeover: true });
        if (value && value.ownedByAnotherSession !== true) setReconnectEpoch((current) => current + 1);
      } finally { endBusy(busyOwner); }
      return;
    }
    if (presence.availability === "AVAILABLE") { await endReception(); return; }
    const needsTakeover = presence.unbound === true;
    await applyPresence("AVAILABLE", needsTakeover ? { takeover: true } : undefined);
  };
  const goTransferFromChecklist = (consultationId: string) => {
    setOffDutyOpen(false);
    setSection("consultation");
    setSelectedId(consultationId);
    setMobilePane("chat");
    setPendingTransferId(consultationId);
  };
  // 清单里的「去交接」先切到该会话，等选中态生效后再按现有转交流程打开弹窗。
  useEffect(() => {
    if (!pendingTransferId) return;
    const target = queue.find((item) => item.id === pendingTransferId);
    if (!target || selectedId !== pendingTransferId) return;
    setPendingTransferId(null);
    if (!canTransfer || target.state !== "ACTIVE" || target.assignedAdmin?.id !== snapshot.adminUserId || target.messageScopeState !== "READY") return;
    void openTransfer();
  }, [pendingTransferId, selectedId, queue, canTransfer, snapshot.adminUserId]);

  /* ---------- image staging: select/paste/drop never sends ---------- */
  const setStagedFor = (key: string, updater: (current: DraftImage[]) => DraftImage[]) => setStaged((current) => ({ ...current, [key]: updater(current[key] ?? []) }));
  const setPendingFor = (key: string, updater: (current: DraftImage | null) => DraftImage | null) => setPending((current) => ({ ...current, [key]: updater(current[key] ?? null) }));
  const dropStaged = (key: string, item: DraftImage) => {
    URL.revokeObjectURL(item.previewUrl);
    setStagedFor(key, (current) => current.filter((it) => it.key !== item.key));
  };
  const removeStaged = (item: DraftImage) => { if (sendingRef.current || imageInFlight) return; dropStaged(draftKey, item); };
  const removePending = () => {
    if (!selectedPending || sendingRef.current || selectedPending.state === "SENDING") return;
    if (selectedPending.state === "UNKNOWN") { setNotice("结果未确认，暂时不能移除"); return; }
    URL.revokeObjectURL(selectedPending.previewUrl);
    setPendingFor(draftKey, () => null);
  };
  const stageFiles = (files: File[]) => {
    if (!files.length) return;
    const key = draftKey;
    if (!key || !canSend) { setNotice("接入会话后才能添加图片。"); return; }
    const room = MAX_STAGED_IMAGES - ((stagedRef.current[key]?.length ?? 0) + (pendingRef.current[key] ? 1 : 0));
    if (room <= 0) { setNotice(`每个会话最多暂存 ${MAX_STAGED_IMAGES} 张图片`); return; }
    const accepted: DraftImage[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (accepted.length >= room) { problems.push(`超出 ${MAX_STAGED_IMAGES} 张上限，其余已忽略`); break; }
      try { validateNimImageFile(file); } catch (cause) { problems.push(`${file.name}：${cause instanceof Error ? cause.message : "图片无效"}`); continue; }
      const previewUrl = URL.createObjectURL(file);
      accepted.push({ key: `${key}:${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`, file, previewUrl, name: file.name, size: file.size, width: 0, height: 0, state: "DECODING", progress: 0 });
    }
    if (problems.length) setNotice(problems.join("；"));
    if (!accepted.length) return;
    setStagedFor(key, (current) => [...current, ...accepted]);
    for (const item of accepted) {
      void decodeImage(item.previewUrl).then(({ width, height }) => {
        setStagedFor(key, (current) => current.map((it) => (it.key === item.key ? { ...it, width, height, state: "READY" } : it)));
      }).catch(() => {
        setStagedFor(key, (current) => {
          if (!current.some((it) => it.key === item.key)) return current;
          URL.revokeObjectURL(item.previewUrl);
          return current.filter((it) => it.key !== item.key);
        });
        setNotice(`${item.name}：图片无法解码，请选择有效的 JPG 或 PNG`);
      });
    }
  };
  const onComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type === "image/jpeg" || file.type === "image/png");
    if (files.length) { event.preventDefault(); stageFiles(files); }
  };
  const onComposerDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) stageFiles(files);
  };

  const beginFlight = (key: string, image: DraftImage): DraftImage | null => {
    if (imageFlights.current.has(key)) return null;
    const attempt: DraftImage = { ...image, state: "SENDING", progress: 0 };
    imageFlights.current.set(key, attempt);
    setPendingFor(key, () => attempt);
    return attempt;
  };
  const settleFlight = (key: string, attempt: DraftImage, result: { success: boolean; error?: unknown }) => {
    if (imageFlights.current.get(key) !== attempt) return;
    imageFlights.current.delete(key);
    setPendingFor(key, (prev) => {
      if (!prev || prev.key !== attempt.key || prev.file !== attempt.file) return prev;
      if (result.success) { URL.revokeObjectURL(prev.previewUrl); return null; }
      const cause = result.error;
      const messageClientId = cause instanceof NimImageSendError ? cause.messageClientId : undefined;
      const isUnknown = cause instanceof NimImageSendError && cause.kind === "UNKNOWN";
      return { ...prev, state: isUnknown ? "UNKNOWN" : "FAILED", messageClientId: messageClientId ?? prev.messageClientId };
    });
  };

  const sendOneImage = async (key: string, image: DraftImage, conversationId: string, version: number): Promise<NimMessageLike> => {
    const client = clientRef.current;
    if (!client) throw new Error("云信连接不可用");
    if (image.state === "UNKNOWN" && !image.messageClientId) throw new Error("结果未确认，无法重试");
    const attempt = beginFlight(key, image);
    if (!attempt) throw new Error("该图片已有发送在途");
    try {
      const sent = image.messageClientId
        ? await client.retryImage(conversationId, image.messageClientId, { onProgress: (percentage: number) => { if (version === operatorGenerationRef.current) setPendingFor(key, (cur) => cur?.key === attempt.key ? { ...cur, progress: percentage } : cur); } })
        : await client.sendImage(conversationId, image.file, { onProgress: (percentage: number) => { if (version === operatorGenerationRef.current) setPendingFor(key, (cur) => cur?.key === attempt.key ? { ...cur, progress: percentage } : cur); }, width: image.width, height: image.height });
      settleFlight(key, attempt, { success: true });
      return sent;
    } catch (error) { settleFlight(key, attempt, { success: false, error }); throw error; }
  };

  /* ---------- one staged video/file per consultation ---------- */
  const setMediaFor = (key: string, updater: ((current: MessageMediaDraft | null) => MessageMediaDraft | null) | MessageMediaDraft | null) => {
    const previous = mediaDraftsRef.current[key] ?? null;
    const next = typeof updater === "function" ? updater(previous) : updater;
    mediaDraftsRef.current = { ...mediaDraftsRef.current, [key]: next };
    setMediaDrafts(mediaDraftsRef.current);
  };
  const stageMediaFile = (file: File, kind: "video" | "file") => {
    const key = draftKey;
    if (!key || !canSend) { setNotice("接入会话后才能添加视频或文件。"); return; }
    const current = mediaDraftsRef.current[key] ?? null;
    if (current?.state === "SENDING") { setNotice("媒体正在发送，请稍候"); return; }
    if (current?.state === "UNKNOWN") { setNotice("上次媒体发送结果未确认，请先按原消息重试"); return; }
    try { validateNimMediaFile(file, kind); } catch (cause) { setNotice(`${file.name}：${cause instanceof Error ? cause.message : "媒体文件无效"}`); return; }
    setMediaFor(key, { file, kind, name: file.name, size: file.size, state: "READY", progress: 0 });
    setNotice(undefined);
  };
  const removeSelectedMedia = () => {
    const current = mediaDraftsRef.current[draftKey] ?? null;
    if (!current) return;
    if (current.state === "SENDING" || mediaFlights.current.has(draftKey)) { setNotice("媒体正在发送，暂不能移除"); return; }
    if (current.state === "UNKNOWN") { setNotice("媒体发送结果未确认，暂不能移除；请先核对历史"); return; }
    setMediaFor(draftKey, null);
  };
  const beginMediaFlight = (key: string, media: MessageMediaDraft): MessageMediaDraft | null => {
    if (mediaFlights.current.has(key)) return null;
    const attempt: MessageMediaDraft = { ...media, state: "SENDING", progress: 0 };
    mediaFlights.current.set(key, attempt);
    setMediaFor(key, () => attempt);
    return attempt;
  };
  const settleMediaFlight = (key: string, attempt: MessageMediaDraft, result: { success: boolean; error?: unknown }) => {
    if (mediaFlights.current.get(key) !== attempt) return;
    mediaFlights.current.delete(key);
    setMediaFor(key, (previous) => {
      if (!previous || previous.file !== attempt.file) return previous;
      if (result.success) return null;
      const cause = result.error;
      const mediaError = cause instanceof NimMediaSendError ? cause : null;
      return { ...previous, state: mediaError?.kind === "UNKNOWN" ? "UNKNOWN" : "FAILED", progress: 0, messageClientId: mediaError?.messageClientId ?? previous.messageClientId };
    });
  };
  const sendOneMedia = async (key: string, media: MessageMediaDraft, conversationId: string, version: number): Promise<NimMessageLike> => {
    const client = clientRef.current;
    if (!client) throw new Error("云信连接不可用");
    if (media.state === "UNKNOWN" && !media.messageClientId) throw new Error("结果未确认，无法重试");
    const attempt = beginMediaFlight(key, media);
    if (!attempt) throw new Error("该视频或文件已有发送在途");
    const progress = (percentage: number) => {
      if (version === operatorGenerationRef.current) setMediaFor(key, (current) => current?.file === attempt.file ? { ...current, progress: percentage } : current);
    };
    try {
      const sent = media.messageClientId
        ? await client.retryMedia(conversationId, media.messageClientId, { onProgress: progress })
        : await client.sendMedia(conversationId, media.file, media.kind, { onProgress: progress });
      settleMediaFlight(key, attempt, { success: true });
      return sent;
    } catch (error) { settleMediaFlight(key, attempt, { success: false, error }); throw error; }
  };
  const retryMediaDraft = async () => {
    const key = draftKey;
    const media = mediaDraftsRef.current[key] ?? null;
    if (!media || !canSend || sendingRef.current || imageFlights.current.has(key) || mediaFlights.current.has(key)) return;
    if (media.state === "UNKNOWN" && !media.messageClientId) { setNotice("原媒体标识不可用，请先刷新历史核验，不能直接重发。"); return; }
    if (failedFor(selected!.id)) { setNotice("上一条文字的结果还未确认，请先处理文字再发送媒体。"); return; }
    const conversationId = selected!.conversationId!;
    const generation = operatorGenerationRef.current;
    const busyOwner = beginBusy();
    sendingRef.current = true;
    setSending(true);
    setNotice(undefined);
    try {
      const sent = await sendOneMedia(key, media, conversationId, generation);
      if (generation === operatorGenerationRef.current) {
        const next = messageFromNim(sent, clientRef.current!.accountId, selected?.peerAccountId);
        if (next) setMessages((current) => ({ ...current, [key]: mergeImMessages(current[key] ?? [], [next]) }));
      }
    } catch (cause) {
      if (cause instanceof NimMediaSendError && cause.kind === "UNSUPPORTED") setNotice("消息通道暂不支持发送视频或文件，未发送。");
      else setNotice(cause instanceof NimMediaSendError && cause.kind === "UNKNOWN" ? "媒体结果仍未确认" : cause instanceof Error ? cause.message : "媒体发送失败，可重试。");
    } finally {
      if (generation === operatorGenerationRef.current) { sendingRef.current = false; setSending(false); endBusy(busyOwner); }
    }
  };

  const retryFailedText = async (consultationId: string) => {
    const failed = failedFor(consultationId);
    const client = clientRef.current;
    if (!failed || !client || !canSend) return;
    // Without the original id there is nothing to replay: re-sending would create a
    // second message whose delivery we already cannot account for.
    if (!failed.messageClientId) {
      setNotice("原消息标识不可用，请先刷新历史确认是否送达，不能直接重发。");
      await reloadHistory(consultationId);
      return;
    }
    // 显式重试和普通提交共用同一会话级约束：有在途消息时不能再派发一条。
    if (sendingRef.current || imageFlights.current.has(draftKey)) { setNotice("有消息正在发送中，请稍候"); return; }
    if (textFlightRef.current.has(consultationId)) return;
    textFlightRef.current.add(consultationId);
    sendingRef.current = true;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const { conversationId, text, messageClientId } = failed;
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      const sent = await client.retryText(conversationId, messageClientId);
      // A（本次重试所属会话）的未决责任必须在本次成功时收敛，不能由"当前选中的是谁"
      // 决定：客服重试后切到 B，回执回来时仍要清掉 A 的未决行与草稿。
      if (generation === operatorGenerationRef.current && operatorRef.current === operator && clientRef.current === client) {
        const target = queueRef.current.find((item) => item.id === consultationId);
        const next = messageFromNim(sent, client.accountId, target?.peerAccountId);
        if (next) setMessages((current) => ({ ...current, [consultationId]: mergeImMessages(current[consultationId] ?? [], [next]) }));
        setDrafts((current) => current[consultationId] === text ? { ...current, [consultationId]: "" } : current);
        setFailedFor(consultationId, null);
      }
    } catch (cause) {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) {
        const textError = cause instanceof NimTextSendError ? cause : null;
        setFailedFor(consultationId, { ...failed, messageClientId: textError?.messageClientId ?? failed.messageClientId });
        setNotice(textError?.kind === "UNKNOWN" ? "结果未确认，请先刷新历史" : cause instanceof Error ? cause.message : "消息发送失败，请重试。");
      }
    } finally {
      textFlightRef.current.delete(consultationId);
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) sendingRef.current = false;
      endBusy(busyOwner);
    }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = draftKey;
    const text = (drafts[key] ?? "").trim();
    const stagedList = stagedRef.current[key] ?? [];
    const pendingItem = pendingRef.current[key] ?? null;
    const mediaItem = mediaDraftsRef.current[key] ?? null;
    if (!key || !canSend) return;
    const consultationId = selected!.id;
    const conversationId = selected!.conversationId!;
    // 会话级未决文字检查放在**提交入口**，不依赖 textarea 有没有字：清空草稿后只提交
    // 图片曾经能整段绕过下面这段逻辑。有原 ID 的未决文字这一轮只重放原消息；没有原
    // ID 的只能核验历史，既不能 sendText，也不能借这次提交把图片先发出去。
    const unresolvedText = failedFor(consultationId);
    const retryTarget = unresolvedText?.messageClientId ? unresolvedText : null;
    if (unresolvedText && !retryTarget) {
      setNotice("上一条文字的结果还未确认，请先刷新历史核对，不能直接重发。");
      void reloadHistory(consultationId);
      return;
    }
    // 只有图片（或空草稿）的提交不能替客服重放那条未决消息，更不能先把图片发出去：
    // 责任留在原消息上，等客服自己按「原消息重试」或带文字提交。
    if (retryTarget && !text) {
      setNotice("上一条文字的结果还未确认，请先按原消息重试或刷新历史核对；暂不能发送图片。");
      return;
    }
    // 引用是提交的一部分：结果未确认的回复没有原 ID 可重放，只能先人工确认；
    // 只带图片的提交不能冒充对某条消息的回复。
    const replyTarget = replyTargets[key] ?? null;
    if (replyTarget && unresolvedText) {
      setNotice("上一条文字的结果还未确认，请先处理后再回复。");
      return;
    }
    if (replyTarget && replyUncertain[key]) { setNotice(REPLY_UNCERTAIN_NOTICE); return; }
    if (replyTarget && !text) { setNotice("回复需要先输入文字；图片回复暂不支持"); return; }
    if (replyTarget && !replyTarget.source) { setNotice("引用消息不可用，请刷新历史后重试"); return; }
    if (!text && !stagedList.length && !pendingItem && !mediaItem) return;
    if (sendingRef.current || imageFlights.current.has(key) || mediaFlights.current.has(key) || pendingItem?.state === "SENDING" || pendingItem?.state === "UNKNOWN") {
      if (pendingItem?.state === "UNKNOWN") setNotice("图片发送结果未确认，请先刷新历史；确认未发送后再按原图片重试。");
      return;
    }
    if (mediaItem?.state === "SENDING") { setNotice("媒体正在发送，请稍候"); return; }
    if (mediaItem?.state === "UNKNOWN") { setNotice("媒体发送结果未确认，请先刷新历史；确认未发送后再按原消息重试。"); return; }
    if (mediaItem?.state === "FAILED") { setNotice("请先重试或移除发送失败的视频/文件，再发送后续内容"); return; }
    if (stagedList.some((item) => item.state === "DECODING" || item.width <= 0 || item.height <= 0)) { setNotice("图片仍在检查，请稍候"); return; }
    if (pendingItem?.state === "FAILED" && stagedList.length) { setNotice("请先处理失败的图片，再发送后续内容"); return; }
    const client = clientRef.current!;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const requestKey: ImRequestKey = { generation, operator, consultationId, conversationId, sendCapability: sendCapabilityKey };
    const busyOwner = beginBusy();
    sendingRef.current = true;
    setSending(true);
    setNotice(undefined);
    let stage: "text" | "image" | "media" = "text";
    // 真正提交出去的原文：重试时是原消息文本，不是此刻的草稿。异常要按它记责任。
    let submittedText = text;
    try {
      // 未决文字（有原 ID）哪怕草稿是空的也要先重放原消息，否则后面的图片会先发出去。
      if (text || retryTarget) {
        if (textFlightRef.current.has(consultationId)) return;
        textFlightRef.current.add(consultationId);
        try {
          submittedText = retryTarget ? retryTarget.text : text;
          const sent = retryTarget
            ? await client.retryText(conversationId, retryTarget.messageClientId!)
            : replyTarget
              ? await client.replyText(conversationId, text, replyTarget.source!)
              : await client.sendText(conversationId, text);
          // 收敛已发出的原操作：只按原身份代次/操作者匹配。撤销接待权限不改变身份代次
          // （readClientKey 只含 adminUserId/session/locked/canRead），所以这里不比较发送
          // 能力——否则单独撤权会把已经发出去的文字回执连同责任一起丢掉。
          if (generation !== operatorGenerationRef.current || operatorRef.current !== operator) return;
          const next = messageFromNim(sent, client.accountId, selected?.peerAccountId);
          if (next) setMessages((current) => ({ ...current, [consultationId]: mergeImMessages(current[consultationId] ?? [], [next]) }));
          // Only clear the exact text that was submitted; newer typing survives.
          setDrafts((current) => current[consultationId] === submittedText ? { ...current, [consultationId]: "" } : current);
          setFailedFor(consultationId, null);
          if (replyTarget) clearReplyFor(key);
        } finally {
          textFlightRef.current.delete(consultationId);
        }
      }
      // 本次提交是在收未决文字时就只收文字：附件留到下一次显式提交再走。未决状态下
      // 连带把图片放出去，等于用一条无法对账的意图掩盖另一条。
      const queue = retryTarget ? [] : [...(pendingItem && pendingItem.state === "FAILED" ? [pendingItem] : []), ...stagedList];
      for (const item of queue) {
        if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || selectedIdRef.current !== consultationId || sectionRef.current !== "consultation" || clientRef.current !== client || !canStartSendRef.current) break;
        stage = "image";
        setStagedFor(consultationId, (current) => current.filter((it) => it.key !== item.key));
        const sent = await sendOneImage(consultationId, item, conversationId, generation);
        if (generation === operatorGenerationRef.current) {
          const next = messageFromNim(sent, client.accountId, selected?.peerAccountId);
          if (next) setMessages((current) => ({ ...current, [consultationId]: mergeImMessages(current[consultationId] ?? [], [next]) }));
        }
      }
      const mediaToSend = !retryTarget && mediaItem?.state === "READY" ? mediaItem : null;
      if (mediaToSend) {
        if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || selectedIdRef.current !== consultationId || sectionRef.current !== "consultation" || clientRef.current !== client || !canStartSendRef.current) throw new ImLifecycleSupersededError();
        stage = "media";
        const sent = await sendOneMedia(consultationId, mediaToSend, conversationId, generation);
        if (generation === operatorGenerationRef.current) {
          const next = messageFromNim(sent, client.accountId, selected?.peerAccountId);
          if (next) setMessages((current) => ({ ...current, [consultationId]: mergeImMessages(current[consultationId] ?? [], [next]) }));
        }
      }
    } catch (cause) {
      await blockCurrentConsultationOnForbidden(cause, requestKey);
      // 同上：失败/未知的责任也要记回原操作，不能因为发送能力变化而丢弃。
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) {
        if (stage === "text") {
          const textError = cause instanceof NimTextSendError ? cause : null;
          if (replyTarget) {
            // 回复没有原 ID 重放入口：只保留草稿与引用，未知结果必须人工刷新确认。
            const status = httpStatus(cause);
            const unconfirmed = textError ? textError.kind === "UNKNOWN" : status === undefined || status >= 500;
            if (unconfirmed) {
              setReplyUncertain((current) => ({ ...current, [key]: true }));
              setNotice(REPLY_UNCERTAIN_NOTICE);
            } else {
              setNotice(status === 403 ? "发送权限已变化，草稿和引用已保留" : cause instanceof Error ? cause.message : "回复发送失败，草稿和引用已保留。");
            }
          } else {
            if (textError) setFailedFor(consultationId, { consultationId, conversationId, text: submittedText, ...(textError.messageClientId ? { messageClientId: textError.messageClientId } : {}) });
            setNotice(textError?.kind === "UNKNOWN" ? "结果未确认，草稿已保留" : cause instanceof Error ? cause.message : "消息发送失败，请重试。");
          }
        } else if (stage === "image") {
          const isUnknown = cause instanceof NimImageSendError && cause.kind === "UNKNOWN";
          setNotice(isUnknown ? "图片结果未确认，原图片已保留" : cause instanceof Error ? cause.message : "图片发送失败，可重试。");
        } else {
          const mediaError = cause instanceof NimMediaSendError ? cause : null;
          setNotice(mediaError?.kind === "UNSUPPORTED" ? "消息通道暂不支持发送视频或文件，未发送。" : mediaError?.kind === "UNKNOWN" ? "视频/文件结果未确认，原文件已保留" : cause instanceof Error ? cause.message : "视频/文件发送失败，可重试。");
        }
      }
    } finally {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) { sendingRef.current = false; setSending(false); endBusy(busyOwner); }
    }
  };
  const retryPendingImage = async () => {
    if (!selectedPending || !canSend || sendingRef.current || imageFlights.current.has(draftKey)) return;
    // 文字未决未收敛前不再派发图片：和普通提交、Enter、显式文字重试遵循同一条会话约束。
    if (failedFor(selected!.id)) { setNotice("上一条文字的结果还未确认，请先处理文字再发送图片。"); return; }
    const consultationId = selected!.id;
    const conversationId = selected!.conversationId!;
    const generation = operatorGenerationRef.current;
    const busyOwner = beginBusy();
    sendingRef.current = true;
    setSending(true);
    setNotice(undefined);
    try {
      const sent = await sendOneImage(consultationId, selectedPending, conversationId, generation);
      if (generation === operatorGenerationRef.current) {
        const next = messageFromNim(sent, clientRef.current!.accountId, selected?.peerAccountId);
        if (next) setMessages((current) => ({ ...current, [consultationId]: mergeImMessages(current[consultationId] ?? [], [next]) }));
      }
    } catch (cause) {
      setNotice(cause instanceof NimImageSendError && cause.kind === "UNKNOWN" ? "图片结果仍未确认" : cause instanceof Error ? cause.message : "图片发送失败，可重试。");
    } finally {
      if (generation === operatorGenerationRef.current) { sendingRef.current = false; setSending(false); endBusy(busyOwner); }
    }
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };



  if (snapshot.session.locked) return <section className="im-wb-root" aria-hidden="true" />;

  // Loading, empty, failed, forbidden and "not selected" are five different answers.
  const emptyStreamState = (state: "loading" | "ready" | "error" | "forbidden" | undefined, hasSelection: boolean) => (
    hasSelection && state === "loading"
      ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
      : hasSelection && state === "error"
        ? <div className="im-wb-empty"><CircleAlert size={22} /><strong>消息读取失败</strong><span>已加载的消息仍保留。</span><button type="button" data-action="retry-history" onClick={() => void setHistoryRetryToken((token) => token + 1)}>重新读取</button></div>
        : hasSelection && state === "forbidden"
          ? <div className="im-wb-empty"><ShieldCheck size={22} /><strong>无法查看该会话历史</strong></div>
          : <div className="im-wb-empty"><Headphones size={22} /><strong>{hasSelection ? "等待第一条消息" : "尚未选择会话"}</strong><span>{hasSelection ? "该会话暂时没有可读消息。" : "从左侧队列选择会话。"}</span></div>);

  const authorFor = (message: SupportMessage) => {
    if (message.self) return { name: operatorName, role: "平台客服", avatar: snapshot.user.image };
    if (selected?.peerAccountId && message.senderId === selected.peerAccountId) return { name: selected.user?.name || selected.user?.username || "平台用户", role: "平台用户", avatar: selected.user?.avatar };
    // Historical senders we cannot map stay neutral instead of borrowing the
    // current assignee's identity.
    if (message.from === "agent" && selected?.botAccountId && message.senderId === selected.botAccountId) return { name: "洲洲助手（Bot）", role: "机器人", avatar: null };
    return message.from === "agent" ? { name: "客服", role: "平台客服", avatar: null } : { name: selected?.user?.name || selected?.user?.username || "平台用户", role: "平台用户", avatar: null };
  };
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
            legacyScopeKey={`${snapshot.adminUserId}:${snapshot.session.id}:${snapshot.permissions.join(",")}:${selected?.id ?? ""}:${selected?.version ?? ""}:${selected?.state ?? ""}:${selected?.assignedAdmin?.id ?? ""}`}
            allowLegacyOrderOpen={profileScope.orders} resolveLegacyOrder={selected ? (id, signal) => adminRequest(`/im/consultations/${encodeURIComponent(selected.id)}/legacy-orders/${encodeURIComponent(id)}`, undefined, "GET", {}, signal) : undefined}
            align={mine ? "end" : "start"} />
          {mine && !message.revoked ? <MessageFooter className="im-wb-msg-status"><time>{message.time}</time><Check size={11} />已发送</MessageFooter> : null}
        </MessageContent>
      </Message>
    </MessageScrollerPrimitive.Item>);
    return nodes;
  }).flat();

  const consultationPane = <div className="im-wb" data-pane={mobilePane} data-details={detailsOpen}>
    <aside className="im-wb-queue" aria-label="会话队列">
      <label className="im-wb-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" /></label>
      <div className="im-wb-filters" role="group" aria-label="队列筛选">
        <button type="button" aria-pressed={filter === "waiting"} onClick={() => setFilter("waiting")}>待接待<b>{counts.waiting}</b></button>
        <button type="button" aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>我接待中<b>{counts.mine}</b></button>
      </div>
      <div className="im-wb-rows">
        {filteredQueue.length ? filteredQueue.map((row) => <button type="button" key={row.id} className="im-wb-row" data-active={selectedId === row.id} aria-current={selectedId === row.id ? "page" : undefined}
          onClick={() => {
            restoredSelectionRef.current = true;
            setSelectedId(row.id);
            setMobilePane("chat");
            setNotice(undefined);
            persistQuery({ section: "consultation", consultation: row.consultation?.threadId ?? row.id });
          }}>
          <span className="im-wb-row-av" aria-hidden="true"><ProfileImage src={row.consultation?.user?.avatar} fallback={initialOf(row.title)} /></span>
          <span className="im-wb-row-copy"><span className="im-wb-row-top"><b>{row.title}</b><i className="im-wb-tag" data-tone={row.type === "COMPLAINT" ? "warn" : "neutral"}>{row.type === "COMPLAINT" ? "投诉" : "咨询"}</i><time>{row.time}</time></span>
            <span className="im-wb-row-snip">{row.snippet}</span>
            <span className="im-wb-row-foot"><em data-tone={stageToneOf(row.state)}>{row.state}</em>{row.unreadCount > 0 ? <i className="im-wb-unread" aria-label={`${row.unreadCount} 条未读`}>{row.unreadCount > 99 ? "99+" : row.unreadCount}</i> : null}</span></span>
        </button>) : <div className="im-wb-list-empty">{query ? <><strong>当前列表没有匹配会话</strong><span>试试其他关键词。</span></>
          : filter === "waiting" ? <><strong>系统正在分配…</strong><span>新咨询会按在线状态自动分配；异常时由管理岗接管。</span></>
          : <><strong>暂无你接待中的会话</strong><span>从「待接待」接入一条即可开始。</span></>}</div>}
      </div>
    </aside>

    <main className="im-wb-chat">
      <header className="im-wb-chat-head" ref={chatHeadingRef} tabIndex={-1} data-focus-target="chat">
        <button type="button" className="im-wb-back" data-action="back-to-queue" onClick={() => setMobilePane("queue")}><ChevronLeft size={14} />队列</button>
        <span className="im-wb-chat-av" aria-hidden="true"><ProfileImage src={selected?.user?.avatar} fallback={initialOf(selected?.user?.name || selected?.user?.username || "客")} /></span>
        <div className="im-wb-chat-title">
          <h2>{selected ? `${selected.user?.name || selected.user?.username || "平台用户"} · ${typeLabel(selected.type)}` : "选择一条会话"}</h2>
          <span className="im-wb-chat-sub">{!selected ? "等待用户咨询" : roundHeadlineOf(selected)}</span>
        </div>
        <div className="im-wb-chat-actions">
          {claimReady && canManageSupport ? <ActionTooltip content="自动分配异常时由管理岗接管"><button type="button" className="im-wb-btn im-wb-btn-outline" data-action="claim-consultation" onClick={() => void claim()} disabled={busy || connection !== "CONNECTED"}>接管会话</button></ActionTooltip> : null}
          {claimReady && !canManageSupport ? <span className="im-wb-state">系统分配中…</span> : null}
          {selected && isMine && selected.messageScopeState !== "FAILED" ? <ActionTooltip content={!serverCanSend && canOperateSelected ? "本轮尚未就绪，暂不可结束" : undefined}><button ref={closeTriggerRef} type="button" data-action="close-consultation" className="im-wb-btn im-wb-btn-outline" onClick={() => { if (!canOperateSelected || !serverCanSend || closeOutcomeUnknown[selected.id]) return; setCloseTarget(selected); setCloseOpen(true); }} disabled={busy || !canOperateSelected || !serverCanSend || Boolean(closeOutcomeUnknown[selected.id]) || Boolean(blockedConsultations[selected.id])}>{!canOperateSelected ? "无本类型接待权限" : closeOutcomeUnknown[selected.id] ? "结束结果未确认" : "结束本轮"}</button></ActionTooltip> : null}
          <button ref={transferTriggerRef} type="button" data-action="open-transfer" className="im-wb-btn im-wb-btn-outline" onClick={() => void openTransfer()} disabled={!canTransfer || !selected || selected.state !== "ACTIVE" || !isMine || selected.messageScopeState !== "READY" || busy}>{canTransfer ? "转交" : "无转交权限"}</button>
          <ActionTooltip content={detailsOpen ? "收起会话详情" : "展开会话详情"}><button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-outline im-wb-btn-icon" aria-label={detailsOpen ? "收起会话详情" : "展开会话详情"} aria-expanded={detailsOpen} aria-controls="im-wb-details" data-action="toggle-details" onClick={() => { const narrow=typeof window!=="undefined"&&window.matchMedia("(max-width: 760px)").matches; if(narrow&&mobilePane!=="details"){openDetails();return;} if (detailsOpen) closeDetails(); else openDetails(); }}><MoreHorizontal size={15} /></button></ActionTooltip>
        </div>
      </header>
      {readOnlyReason ? <p className="im-wb-scope-note" data-tone="readonly" data-action="support-readonly" role="status"><ShieldCheck size={13} />{readOnlyReason}</p> : null}
      {activeAftersale&&selected?.threadId===activeAftersale.threadId?<p className="im-wb-notice" role="status">当前跟进售后：订单 {activeAftersale.orderDisplayNo??"—"} · {activeAftersale.id}<button type="button" className="im-wb-link" onClick={()=>setAftersaleOpen(true)}>查看售后记录</button>{onOpenPath?<button type="button" className="im-wb-link" onClick={()=>onOpenPath(`/orders/${activeAftersale.orderId}`)}>订单详情</button>:null}</p>:null}
      {notice && (notice !== ROUND_CLOSED_NOTICE || selected?.state === "CLOSED") ? <p className="im-wb-notice" role="status"><CircleAlert size={14} />{notice}</p> : null}
      {selected && closeOutcomeUnknown[selected.id] ? <p className="im-wb-notice" data-tone="warn" role="status"><CircleAlert size={14} />{CLOSE_OUTCOME_UNKNOWN_NOTICE}</p> : null}
      <div className="im-wb-stream-wrap">
        {selected?.messageScopeState === "FAILED" ? <div className="im-wb-empty"><CircleAlert size={22} /><strong>会话待人工核验</strong><span>请先完成核验再回复。</span>{selected.assignedAdmin?.id === snapshot.adminUserId && canTransfer ? <button type="button" className="im-wb-btn" data-action="reconcile-consultation" onClick={() => void reconcile()} disabled={busy}>核验并恢复</button> : null}</div>
          : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor">
            <MessageScrollerPrimitive.Root className="im-wb-scroller">
              <MessageScrollerPrimitive.Viewport preserveScrollOnPrepend className="im-wb-viewport" aria-label="会话消息" onContextMenu={onMessageContextMenu}><MessageScrollerPrimitive.Content className="im-wb-content">
                {selectedMessages.length ? <>
                  {selected && historyMore[selected.id] ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="im-wb-history-more"><button type="button" onClick={() => void loadEarlier()} disabled={historyLoading}>{historyLoading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}
                  {timelineItems}
                </> : <MessageScrollerPrimitive.Item messageId="empty">{emptyStreamState(selected ? historyState[selected.id] : undefined, Boolean(selected))}</MessageScrollerPrimitive.Item>}
              </MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport>
              <ActionTooltip content="跳到最新消息"><MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button></ActionTooltip>
            </MessageScrollerPrimitive.Root>
          </MessageScrollerPrimitive.Provider>}
      </div>
      {selectedFailedText ? <p className="im-wb-pending" role="status"><CircleAlert size={13} />发送结果未确认，草稿已保留。<button type="button" data-action="retry-text" onClick={() => void retryFailedText(selected!.id)} disabled={busy || !canSend}>{selectedFailedText.messageClientId ? "原消息重试" : "刷新历史核对"}</button></p> : null}
      {selectedPending ? <div className="im-wb-draft" data-state={selectedPending.state}>
        <img src={selectedPending.previewUrl} alt={selectedPending.name} />
        <span>{selectedPending.name} · {formatBytes(selectedPending.size)} · {selectedPending.state === "SENDING" ? `上传中 ${selectedPending.progress}%` : selectedPending.state === "UNKNOWN" ? "结果未确认" : "发送失败"}</span>
        <button type="button" onClick={() => void retryPendingImage()} disabled={sending || imageInFlight || !canSend}>{selectedPending.messageClientId ? "原消息重试" : "重试"}</button>
        <ActionTooltip content={selectedPending.state === "UNKNOWN" ? "结果未确认时不可移除原图片" : undefined}><span className="im-wb-tooltip-anchor"><button type="button" onClick={removePending} disabled={sendBlocked || !canSend || selectedPending.state === "UNKNOWN"}>移除</button></span></ActionTooltip>
      </div> : null}
      {selectedMedia ? <MediaDraftBar draft={selectedMedia} onRetry={() => void retryMediaDraft()} onRemove={removeSelectedMedia} disabled={busy || sending} /> : null}
      {selectedReply ? <MessageReplyQuote label={replySummaryOf(selectedReply)} onCancel={() => clearReplyFor(draftKey)} /> : null}
      <form className="im-wb-composer" onSubmit={(event) => void send(event)} onDragOver={(event) => event.preventDefault()} onDrop={onComposerDrop}>
        {selectedStaged.length ? <AttachmentGroup className="im-wb-tray">{selectedStaged.map((item, idx) => <Attachment key={item.key} className="im-wb-tray-item" data-state={item.state} state={item.state === "DECODING" ? "processing" : "idle"} size="xs">
          <AttachmentMedia variant="image"><img src={item.previewUrl} alt="" /></AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{selectedStaged.length > 1 ? `${idx + 1}. ` : ""}{item.name}</AttachmentTitle>
            <AttachmentDescription>{item.state === "DECODING" ? "检查中" : "待发送"}</AttachmentDescription>
          </AttachmentContent>
          <AttachmentAction data-action="remove-staged" onClick={() => removeStaged(item)} disabled={sendBlocked} aria-label={`移除 ${item.name}`}>×</AttachmentAction>
        </Attachment>)}
          <span className="im-wb-tray-count">{selectedStaged.length + (selectedPending ? 1 : 0)}/{MAX_STAGED_IMAGES}</span></AttachmentGroup> : null}
        <InputGroup className="im-wb-composer-box">
          <InputGroupTextarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} onPaste={onComposerPaste}
            onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
            aria-label="输入客服消息" rows={3}
            placeholder={!selected ? "从左侧选择会话" : selected.state === "WAITING" ? "接入会话后可回复" : selected.state === "ACTIVE" && !isMine ? readOnlyPlaceholder ?? "仅负责客服可发送消息" : selected.messageScopeState === "FAILED" ? messageScopeLabel("FAILED") : connection !== "CONNECTED" ? "消息通道未连接，草稿会保留" : "输入回复…"}
            disabled={!canEdit} />
          <InputGroupAddon align="block-end" className="im-wb-composer-tools">
            <TooltipProvider delay={200}>
              <Popover open={quickReplyOpen} onOpenChange={setQuickReplyOpen}>
                <Tooltip>
                  <TooltipTrigger render={<PopoverTrigger render={<button type="button" className="im-wb-tool" data-action="quick-replies" aria-label="常用语" disabled={!canEdit || sendBlocked}><MessageSquareText size={15} /></button>} />} />
                  <TooltipContent>常用语</TooltipContent>
                </Tooltip>
                <PopoverContent side="top" align="start" className="w-80 p-0">
                  {editingQuickReplies ? (
                    <div className="p-3 space-y-2 text-xs" data-panel="quick-replies-editor">
                      <div className="flex items-center justify-between border-b pb-1.5 font-medium">
                        <span>编辑个人常用语</span>
                        <span className="text-[11px] text-muted-foreground">{quickReplyDrafts.length}/15</span>
                      </div>
                      <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                        {quickReplyDrafts.map((item, index) => (
                          <div key={index} className="flex flex-col gap-1 rounded border p-1.5 bg-muted/30">
                            <div className="flex items-center justify-between gap-1">
                              <input
                                className="h-6 flex-1 rounded border px-1.5 text-xs bg-background"
                                placeholder="标签（≤10字）"
                                maxLength={10}
                                value={item.label}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setQuickReplyDrafts((prev) => prev.map((q, i) => i === index ? { ...q, label: val } : q));
                                }}
                              />
                              <button
                                type="button"
                                className="text-destructive hover:underline px-1"
                                onClick={() => setQuickReplyDrafts((prev) => prev.filter((_, i) => i !== index))}
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
                                setQuickReplyDrafts((prev) => prev.map((q, i) => i === index ? { ...q, text: val } : q));
                              }}
                            />
                          </div>
                        ))}
                        {quickReplyDrafts.length < 15 ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="w-full"
                            onClick={() => setQuickReplyDrafts((prev) => [...prev, { label: "", text: "" }])}
                          >
                            + 添加常用语
                          </Button>
                        ) : null}
                      </div>
                      {quickReplyError ? <p className="text-destructive text-[11px]">{quickReplyError}</p> : null}
                      <div className="flex items-center justify-between pt-1 border-t">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setQuickReplyDrafts([...SUPPORT_QUICK_REPLIES]);
                            setQuickReplyError("");
                          }}
                        >
                          恢复默认
                        </Button>
                        <div className="flex gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setEditingQuickReplies(false);
                              setQuickReplyError("");
                            }}
                          >
                            取消
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            onClick={() => {
                              const cleaned = quickReplyDrafts
                                .map((q) => ({ label: q.label.trim(), text: q.text.trim() }))
                                .filter((q) => q.label && q.text);
                              if (!cleaned.length) {
                                setQuickReplyError("至少保留一条有效常用语");
                                return;
                              }
                              try {
                                storeSupportQuickReplies(snapshot.adminUserId, cleaned);
                                setQuickReplies(cleaned);
                                setEditingQuickReplies(false);
                                setQuickReplyError("");
                              } catch {
                                setQuickReplyError("保存到本地失败，请检查浏览器存储空间");
                              }
                            }}
                          >
                            保存
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="im-wb-quick-replies" role="group" aria-label="常用语">
                        {quickReplies.map((item) => (
                          <button key={item.label} type="button" data-action="insert-quick-reply" onClick={() => insertQuickReply(item.text)}>
                            <strong>{item.label}</strong><span>{item.text}</span>
                          </button>
                        ))}
                      </div>
                      <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground flex items-center justify-between">
                        <span>仅本机保存</span>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          data-action="manage-quick-replies"
                          onClick={() => {
                            setQuickReplyDrafts(quickReplies);
                            setQuickReplyError("");
                            setEditingQuickReplies(true);
                          }}
                        >
                          管理常用语
                        </button>
                      </div>
                    </>
                  )}
                </PopoverContent>
              </Popover>
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <Tooltip>
                  <TooltipTrigger render={<PopoverTrigger render={<button type="button" className="im-wb-tool" aria-label="表情" disabled={!canEdit || sendBlocked}><Smile size={15} /></button>} />} />
                  <TooltipContent>表情</TooltipContent>
                </Tooltip>
                <PopoverContent side="top" align="start" className="w-auto p-0"><div className="chat-emoji-grid">
                  {CHAT_EMOJIS.map((item) => <button key={item.emoji} type="button" className="chat-emoji-button" aria-label={item.label} onClick={() => insertEmoji(item.emoji)}>{item.emoji}</button>)}
                </div></PopoverContent>
              </Popover>
              <Tooltip>
                <TooltipTrigger render={<label className="im-wb-tool" aria-label="发送图片" />}>
                  <Images size={15} /><input type="file" accept="image/jpeg,image/png" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; stageFiles(files); }} disabled={!canEdit || sendBlocked} />
                </TooltipTrigger>
                <TooltipContent>发送图片</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<button type="button" className="im-wb-tool" aria-label="发送视频" onClick={() => consultationVideoInput.current?.click()} disabled={!canEdit || sendBlocked} />}><Video size={15} /></TooltipTrigger>
                <TooltipContent>发送视频</TooltipContent>
              </Tooltip>
              <input ref={consultationVideoInput} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) stageMediaFile(file, "video"); }} disabled={!canEdit || sendBlocked || selectedMedia?.state === "UNKNOWN"} />
              <Tooltip>
                <TooltipTrigger render={<button type="button" className="im-wb-tool" aria-label="发送文件" onClick={() => consultationFileInput.current?.click()} disabled={!canEdit || sendBlocked} />}><FileText size={15} /></TooltipTrigger>
                <TooltipContent>发送文件</TooltipContent>
              </Tooltip>
              <input ref={consultationFileInput} type="file" accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) stageMediaFile(file, "file"); }} disabled={!canEdit || sendBlocked || selectedMedia?.state === "UNKNOWN"} />
            </TooltipProvider>
            <span className="im-wb-hint im-wb-hint-right"><Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行</span>
            <button type="submit" className="im-wb-send" disabled={!canSend || busy || sendBlocked || (!draft.trim() && !selectedStaged.length && !(selectedPending?.state === "FAILED") && selectedMedia?.state !== "READY")}>{busy ? "处理中…" : "发送"}</button>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </main>

    <aside id="im-wb-details" className="im-wb-details" aria-label="会话详情" hidden={!detailsOpen}>
      <div className="im-wb-details-head"><strong>会话详情</strong><button type="button" className="im-wb-btn im-wb-btn-icon im-wb-details-back" data-action="back-to-chat" onClick={closeDetails}>返回会话</button></div>
      {!selected ? <p className="im-wb-details-empty">未选择会话</p> : <>
        {/* 会话类型、状态与当前接待已在聊天头部；右栏不再重复「本次服务」，第一屏从用户与
            风险摘要开始。处理记录只陈列真实事件投影，不按当前状态推断历史；投诉的额外摘要
            只使用现有投影并逐项标注缺口。 */}
        <ConsultationUserCard key={selected.id} consultationId={selected.id} rowUserId={selected.user?.id ?? ""} fallbackName={selected.user?.name || selected.user?.username || "平台用户"}
          request={adminRequest} scope={profileScope}
          onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")} />
        <ConsultationEventsCard key={`${selected.id}:events`} consultationId={selected.id} request={adminRequest} />
        <ConsultationRoundsTimeline key={`${selected.id}:rounds`} consultationId={selected.id} currentRoundId={selected.id} request={adminRequest} />

        {blockedConsultations[selected.id] ? <section className="im-wb-sec"><span>授权状态</span><small>发送权限已失效</small>
          <button type="button" className="im-wb-btn" data-action="refresh-consultation-access" onClick={() => void refreshConsultationAccess()} disabled={busy || !selected.conversationId}>重新确认当前授权</button></section> : null}
      </>}
    </aside>
  </div>;

  const contactedAftersale=(record:AftersaleRecord,id:string,threadId:string)=>{
    const expected=aftersaleScope;
    void readConsultations().then(rows=>{if(aftersaleScopeRef.current!==expected)return;
      setQueue(rows);setSection("consultation");setSelectedId(id);setMobilePane("chat");setDetailsOpen(false);
      setActiveAftersale({id:record.id,orderId:record.orderId,orderDisplayNo:record.orderDisplayNo,threadId});
      persistQuery({section:"consultation",consultation:threadId});
    }).catch(cause=>{if(aftersaleScopeRef.current===expected)setNotice(friendlyError(cause));});
  };
  // Availability is the server's reception intent; the label must still show a broken
  // message channel instead of claiming "可接待". Ending presence stays available so
  // the operator can clear a stale AVAILABLE row even while the IM channel reconnects.
  const runtime = presenceRuntimeState(
    presence.availability,
    connection,
    busy,
    presence.ownedByAnotherSession === true,
    presence.unbound === true,
    localLeader,
    presence.dispatchable !== false,
  );

  return <div className="im-wb-root" data-unified="true">
    <AftersaleInbox key={aftersaleScope} open={aftersaleOpen&&canRead} onOpenChange={setAftersaleOpen} scope={aftersaleScope} adminId={snapshot.adminUserId} canHandle={canRead&&canAccept} canTakeover={Boolean(snapshot.security.isBoss||snapshot.permissions.includes("im.support.audit.takeover"))} onContact={contactedAftersale} onDirtyChange={setAftersaleDirty} getConnectionId={() => connectionIdRef.current}/>
    <nav className="im-wb-bar" aria-label="沟通类型">
      <div className="im-wb-bar-title"><strong>客服工作台</strong></div>
      <button type="button" className="im-wb-btn im-wb-btn-outline" disabled={!canRead} onClick={()=>setAftersaleOpen(true)}>售后记录</button>
      <div className="im-wb-seg" role="group">
        <button type="button" aria-pressed={section === "consultation"} onClick={() => { setSection("consultation"); persistQuery({ section: "consultation" }); }}>咨询与投诉<b>{displayQueue.length}</b></button>
        <button type="button" aria-pressed={section === "orders"} onClick={() => { setSection("orders"); persistQuery({ section: "orders" }); }}>订单沟通</button>
      </div>
      <span className="im-wb-spacer" />
      <div className="im-wb-runtime">
        <ActionTooltip content={notifyPermission === "denied" ? "浏览器已屏蔽通知，请在站点设置中允许" : notifyEnabled && notifyPermission === "granted" ? "消息提醒已开启（需保持标签页打开）" : "开启浏览器通知与提示音"}>
          <button type="button" className="im-wb-btn im-wb-btn-icon im-wb-notify" data-action="toggle-notifications"
            data-state={notifyPermission === "denied" ? "denied" : notifyEnabled && notifyPermission === "granted" ? "on" : "prompt"}
            aria-label={notifyEnabled && notifyPermission === "granted" ? "关闭消息提醒" : "开启消息提醒"}
            onClick={() => void toggleNotifications()}>
            {notifyPermission === "denied" || notifyPermission === "unsupported" ? <BellOff size={15} /> : <Bell size={15} />}
            {notifyUnreadCount > 0 ? <b className="im-wb-notify-count" aria-label={`${notifyUnreadCount} 条未读`}>{notifyUnreadCount > 99 ? "99+" : notifyUnreadCount}</b> : null}
          </button>
        </ActionTooltip>
        <span className="im-wb-runtime-divider" aria-hidden="true" />
        {canPresence ? <>
          <span className="im-wb-state im-wb-runtime-state" data-tone={runtime.tone}><i className={presence.availability === "AVAILABLE" && runtime.connected ? "on" : ""} />{runtime.label}</span>
          <span className="im-wb-runtime-divider" aria-hidden="true" />
          <TodayDuration seconds={presence.today?.seconds} active={canPresence && localLeader && presence.availability === "AVAILABLE" && !snapshot.session.locked} />
          <ActionTooltip content={runtime.toggleTitle}><span className="im-wb-tooltip-anchor"><button type="button" className="im-wb-btn im-wb-btn-outline im-wb-presence-toggle im-wb-runtime-action" data-action="toggle-presence" onClick={() => void togglePresence()} disabled={runtime.toggleDisabled}>{runtime.toggleLabel}</button></span></ActionTooltip>
          {presence.availability === "AVAILABLE" && localLeader && (connection === "KICKED" || connection === "AUTH_FAILED")
            ? <button type="button" className="im-wb-btn im-wb-btn-outline im-wb-runtime-action" data-action="end-reception" onClick={() => void endReception()} disabled={busy}>结束接待</button>
            : null}
        </> : <span className="im-wb-state">无在线状态权限</span>}
        {connection !== "CONNECTED" ? <>
          <span className="im-wb-runtime-divider" aria-hidden="true" />
          <span className="im-wb-state im-wb-runtime-warning" data-tone="warn"><i />消息服务异常</span>
        </> : null}
      </div>
      {clientRef.current?.transport === "local-fake" ? <span className="im-wb-state im-wb-local">本地测试</span> : null}
    </nav>
    <div className="im-wb-unified">
      <aside className="im-wb-unified-queue" aria-label="全部会话" onContextMenu={(event) => { const rowEl = (event.target as Element).closest(".im-wb-row") as HTMLElement | null; event.preventDefault(); if (!rowEl || rowEl.dataset.unifiedKind !== "order") { setUnifiedOrderMenu(null); return; } event.stopPropagation(); const orderId = rowEl.dataset.orderId; if (!orderId) return; setUnifiedOrderMenu({ x: event.clientX, y: event.clientY, orderId, preference: orderPreferenceOf(orderId, orderDirectory.find((row) => row.id === orderId)?.teamId), row: rowEl }); }}>
        <div className="im-wb-unified-head"><strong>全部会话</strong><span>{searchState.loading && searchState.q === unifiedQuery.trim() ? "搜索中…" : unifiedTotal}</span></div>
        <label className="im-wb-search"><Search size={13} /><input value={unifiedQuery} maxLength={64} onChange={(event) => setUnifiedQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && unifiedQuery) { event.preventDefault(); setUnifiedQuery(""); } }} placeholder="搜索用户、订单号、账号或游戏" aria-label="搜索全部会话" />{unifiedQuery ? <button type="button" className="im-wb-search-clear" aria-label="清空搜索" onClick={() => setUnifiedQuery("")}><X size={12} /></button> : null}</label>
        {searchState.error ? <p className="im-wb-order-notice" data-tone="warn" role="status">{searchState.error}</p> : null}
        {searchLimitReached ? <p className="im-wb-order-notice" role="status">匹配结果较多，当前每类最多显示 50 条；请补充关键词继续缩小范围。</p> : null}
        <div className="im-wb-unified-types" role="group" aria-label="会话类型">
          {([["ALL", "全部"], ["SERVICE", "咨询"], ["COMPLAINT", "投诉"], ["ORDER", "订单群"]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={unifiedType === value} onClick={() => { setUnifiedType(value); persistQuery({ type: value === "ALL" ? null : value }); }}>{label}</button>)}
        </div>
        {orderQueueNotice && (unifiedType === "ALL" || unifiedType === "ORDER")
          ? <p className="im-wb-order-notice" data-tone="warn" role="status" data-action="order-queue-notice">{orderQueueNotice}</p>
          : null}
        <div className="im-wb-rows">
          {unifiedRows.length ? unifiedRows.map((row) => {
            const active = row.kind === "consultation" ? section === "consultation" && selectedId === row.id : section === "orders" && orderSelection === row.id;
            return <button type="button" key={`${row.kind}:${row.id}`} className="im-wb-row" data-unified-kind={row.kind} data-order-id={row.kind === "order" ? row.id : undefined} data-active={active} aria-current={active ? "page" : undefined}
              onContextMenu={row.kind === "order" ? (event) => { event.preventDefault(); event.stopPropagation(); setUnifiedOrderMenu({ x: event.clientX, y: event.clientY, orderId: row.id, preference: orderPreferenceOf(row.id, orderDirectory.find((item) => item.id === row.id)?.teamId), row: event.currentTarget }); } : undefined}
              onClick={() => {
                restoredSelectionRef.current = true;
                if (row.kind === "consultation") {
                  setSection("consultation");
                  setSelectedId(row.id);
                  const target = consultationDirectory.find((item) => item.id === row.id);
                  persistQuery({ section: "consultation", consultation: target?.threadId ?? row.id });
                } else {
                  setSection("orders");
                  setOrderSelection(row.id);
                  persistQuery({ section: "orders", order: row.id });
                }
                setMobilePane("chat");
              }}>
              {row.kind === "order"
                ? <OrderGroupAvatar displayNo={row.title} className="im-wb-row-av" />
                : <span className="im-wb-row-av" data-kind={row.kind} aria-hidden="true"><ProfileImage src={row.avatar} fallback={initialOf(row.title)} /></span>}
              <span className="im-wb-row-copy">
                <span className="im-wb-row-top">
                  <b>{row.title}</b>
                  {row.tag ? <i className="im-wb-tag" data-tone={row.tone}>{row.tag}</i> : null}
                  {row.stageCardUnknown ? <i className="im-wb-tag" data-tone="warn">自动卡待核对</i> : null}
                  {row.pinned ? <Pin size={11} className="im-wb-row-flag" aria-label="已置顶" /> : null}
                </span>
                <span className="im-wb-row-snip">
                  <i className="im-wb-row-state" data-tone={row.stateTone}>{row.state}</i>
                  <span className="im-wb-row-preview">{row.snippet}</span>
                  {row.meta ? <span className="im-wb-row-meta"><CalendarClock size={10} aria-hidden="true" />{row.meta}</span> : null}
                </span>
              </span>
              <span className="im-wb-row-tail">
                <time dateTime={row.sortAt ? new Date(row.sortAt).toISOString() : undefined}>{row.time}</time>
                {row.muted
                  ? <BellOff size={12} className="im-wb-row-flag" aria-label={row.unreadCount > 0 ? "有未读消息，已免打扰" : "已免打扰"} />
                  : row.unreadCount > 0
                    ? <i className="im-wb-unread" aria-label={`${row.unreadCount} 条未读`} title={`${row.unreadCount} 条未读`}>{row.unreadCount > 99 ? "99+" : row.unreadCount}</i>
                    : null}
              </span>
            </button>;
          }) : <div className="im-wb-list-empty"><strong>{searchState.loading ? "正在搜索…" : serverSearchActive ? "没有匹配的会话" : "暂无会话"}</strong><span>{serverSearchActive ? "换一个关键词，或清空搜索查看全部已加载会话。" : "新的咨询、投诉和订单群会出现在这里。"}</span></div>}
          {orderNextCursor && !serverSearchActive && (unifiedType === "ALL" || unifiedType === "ORDER")
            ? <button type="button" className="im-wb-more" data-action="load-more-orders" disabled={orderLoadingMore || orderRefreshing}
                onClick={() => void loadMoreOrders()}>{orderRefreshing ? "刷新中…" : orderLoadingMore ? "正在读取…" : "加载更多订单群"}</button>
            : null}
          {hiddenOrderCount ? <button type="button" className="im-wb-more im-og-restore" onClick={restoreHiddenOrders}>已隐藏 {hiddenOrderCount} 个订单群 · 恢复显示</button> : null}
        </div>
      </aside>
      {unifiedOrderMenu ? <MessageActionMenu x={unifiedOrderMenu.x} y={unifiedOrderMenu.y} label="订单群操作" returnFocus={unifiedOrderMenu.row}
        items={[
          { id: "pin" as const, label: unifiedOrderMenu.preference.pinned ? "取消置顶" : "置顶会话" },
          { id: "mute" as const, label: unifiedOrderMenu.preference.muted ? "取消消息免打扰" : "消息免打扰" },
          { id: "settings" as const, label: "群设置" },
          { id: "hide" as const, label: "不显示会话", danger: true },
        ]}
        onSelect={handleUnifiedOrderMenuAction} onClose={() => setUnifiedOrderMenu(null)} /> : null}
      <div className="im-wb-unified-detail">
        <div className="im-wb-pane" hidden={section !== "consultation"}>{consultationPane}</div>
        {canRead ? <div className="im-wb-pane im-wb-pane--orders" hidden={section !== "orders"}><OrderWorkbenchPane identity={readClientKey} adminUserId={snapshot.adminUserId} operatorName={operatorName}
          client={clientRef.current} connection={connection} active={section === "orders"} sendAllowed={canAccept} selectedOrderId={orderSelection} onSelectedOrderChange={setOrderSelection}
          cloudPinnedTeamIds={cloudPinnedTeamIds} onToggleCloudPin={(orderId, teamId, pinned) => toggleOrderPin(orderId, teamId, pinned)}
          canManualClose={snapshot.security.isBoss || snapshot.permissions.includes("order.settlement.write")} request={adminRequest} onAuthError={() => { void onRefresh(); }}
          onOpenProfile={profileScope.profile ? (id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料") : undefined} onOpenPath={onOpenPath} /></div> : null}
      </div>
    </div>
    <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
      <DialogContent className="im-wb-dialog" aria-label="转交会话" showCloseButton={false} finalFocus={transferTriggerRef}>
        <div className="im-wb-dialog-head"><div><strong>转交会话</strong><span>{selected?.user?.name || "当前咨询"}</span></div><ActionTooltip content="关闭转交"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setTransferOpen(false)} aria-label="关闭转交"><X size={14} /></button></ActionTooltip></div>
        <label className="im-wb-dialog-note"><span>交接备注（可选，≤200 字）<em>{transferNote.length}/200</em></span>
          <Textarea value={transferNote} maxLength={200} rows={2} aria-label="交接备注（可选）" placeholder="说明交接原因或注意事项" disabled={transferBusy} onChange={(event) => setTransferNote(event.target.value)} /></label>
        {transferError ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{transferError}</p>
          : transferState === null ? <p className="im-wb-dialog-empty">正在读取可转交客服…</p>
          : !transferState.transferReady ? <p className="im-wb-dialog-empty">会话尚未就绪，暂不可转交</p>
          : !transferState.targets.length ? <p className="im-wb-dialog-empty">暂无可转交的客服。这里只显示当前在线且可接待的其他客服；投诉会话还会排除无权处理或已被排除的客服。</p>
          : <div className="im-wb-dialog-list">{transferState.targets.map((target) => <button key={target.adminUserId} type="button" disabled={transferBusy} onClick={() => void confirmTransfer(target.adminUserId)}><span>{target.displayName}</span><small>{target.inGrace ? "连接异常，可能无法及时查看" : "可接待客服"}</small></button>)}</div>}
        <p className="im-wb-dialog-hint">转交后原会话与历史保留；填写的备注会写入交接记录</p>
      </DialogContent>
    </Dialog>
    {/* 暂停/下线前的未完成会话清单：只提示与提供交接入口，不阻断暂停。 */}
    <Dialog open={offDutyOpen} onOpenChange={setOffDutyOpen}>
      <DialogContent className="im-wb-dialog" aria-label="暂停接待确认" showCloseButton={false}>
        <div className="im-wb-dialog-head"><div><strong>暂停接待</strong><span>还有 {myOpenConsultations.length} 条未完成咨询</span></div>
          <ActionTooltip content="关闭暂停确认"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setOffDutyOpen(false)} aria-label="关闭暂停确认"><X size={14} /></button></ActionTooltip></div>
        <p className="im-wb-dialog-hint">暂停后不再接新会话，已有会话不会自动结束；你可以先逐条交接，也可以直接暂停。</p>
        <ul className="im-wb-offduty-list" aria-label="未完成咨询">
          {myOpenConsultations.map((item) => <li key={item.id} data-consultation-id={item.id}>
            <div><strong>{item.user?.name || item.user?.username || "平台用户"}</strong><span>{typeLabel(item.type)} · {scopeStateLabel(item)}</span></div>
            <ActionTooltip content={!canTransfer ? "无转交权限" : item.messageScopeState !== "READY" ? "会话尚未就绪，暂不可转交" : undefined}><span className="im-wb-tooltip-anchor"><button type="button" className="im-wb-btn" data-action="offduty-transfer" disabled={!canTransfer || item.messageScopeState !== "READY" || busy}
              onClick={() => goTransferFromChecklist(item.id)}>去交接</button></span></ActionTooltip>
          </li>)}
        </ul>
        <div className="im-wb-dialog-actions">
          <button type="button" className="im-wb-btn" onClick={() => setOffDutyOpen(false)}>继续接待</button>
          <button type="button" className="im-wb-btn im-wb-btn-danger" data-action="confirm-pause-presence" disabled={busy}
            onClick={() => { setOffDutyOpen(false); void applyPresence("OFF_DUTY"); }}>仍然暂停</button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={receptionOpen} onOpenChange={setReceptionOpen}>
      <DialogContent className="im-wb-dialog" aria-label="需要先开始接待" showCloseButton={false}>
        <div className="im-wb-dialog-head"><div><strong>还不能接入会话</strong><span>当前未开始接待</span></div>
          <ActionTooltip content="关闭接待提醒"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setReceptionOpen(false)} aria-label="关闭接待提醒"><X size={14} /></button></ActionTooltip></div>
        <p className="im-wb-dialog-hint">你当前还没有开始接待，直接接入会被服务端拒绝。先开始接待，平台会把你的状态更新为“可接待”，然后自动接入当前会话。</p>
        {connection !== "CONNECTED" ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />消息服务未连接，暂不能开始接待。</p> : null}
        <div className="im-wb-dialog-actions">
          <Button type="button" variant="outline" onClick={() => setReceptionOpen(false)}>取消</Button>
          <Button type="button" data-action="start-reception-and-claim" disabled={busy || connection !== "CONNECTED"} onClick={() => void startReceptionAndClaim()}>开始接待并接入</Button>
        </div>
      </DialogContent>
    </Dialog>
    {/* 结束本轮：只结束当前轮次，不断开整条线程；确认对象与后果再提交。没有后台恢复/撤销合同，
        所以这里不给「撤销」，也不把结束本轮包装成可逆操作。 */}
    <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
      <DialogContent className="im-wb-dialog" aria-label="结束本轮" showCloseButton={false} finalFocus={closeTriggerRef}>
        <div className="im-wb-dialog-head"><div><strong>结束本轮</strong><span>{closeTarget ? `${typeLabel(closeTarget.type)} · ${roundTagOf(closeTarget)}${roundTagOf(closeTarget) ? " · " : ""}${closeTarget.user?.name || closeTarget.user?.username || "平台用户"}` : "当前轮次"}</span></div><ActionTooltip content="关闭结束本轮确认"><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setCloseOpen(false)} aria-label="关闭结束本轮确认"><X size={14} /></button></ActionTooltip></div>
        {closeTarget ? <dl className="im-wb-confirm">
          <div><dt>{closeTarget.type === "COMPLAINT" ? "本轮处理" : "本轮接待"}</dt><dd>{closeTarget.assignedAdmin?.name || "尚未分配"}</dd></div>
        </dl> : null}
        <p className="im-wb-dialog-hint">结束后只结束当前这一轮接待：客服状态恢复为空闲，聊天记录保留在同一会话，用户再次咨询会开启新一轮并重新匹配客服。本轮结束不可撤销，平台当前没有恢复本轮接待的入口。</p>
        <div className="im-wb-dialog-actions">
          <button type="button" className="im-wb-btn" onClick={() => setCloseOpen(false)}>取消</button>
          <button type="button" className="im-wb-btn im-wb-btn-danger" data-action="confirm-close-consultation" onClick={() => { if (closeTarget) void close(closeTarget.id); }} disabled={busy || !closeTarget || !canOperateSelected || !closeTarget.canSend}>确认结束本轮</button>
        </div>
      </DialogContent>
    </Dialog>

    {messageMenu && menuMessage ? <MessageActionMenu key={`${messageMenu.key}:${messageMenu.id}`} x={messageMenu.x} y={messageMenu.y} items={messageMenuItems}
      onSelect={selectMessageAction} onClose={() => setMessageMenu(null)} returnFocus={messageMenu.row} /> : null}
  </div>;
}
