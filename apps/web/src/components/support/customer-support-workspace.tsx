"use client";
import { SessionLoading } from "../auth/session-loading";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ArrowDown, BellOff, Check, ChevronLeft, ChevronRight, CircleAlert, FileText, Headphones, ImagePlus, Info, Paperclip, Pin, ReceiptText, ShieldCheck, Smile, UserRound, Video, Wifi, WifiOff, X } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { useUserSession } from "@/components/session/user-session-provider";
import { ImClientLifecycle } from "@/lib/im-client-lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, mergeImMessages, NimImageSendError, NimMediaSendError, NimTextSendError, validateNimImageFile, validateNimMediaFile, type NimMessageLike, type NimMessageMedia, type NimWebClientLike, type NimWebConnectionState } from "@/lib/nim-web-client";
import { clearSupportIntent, normalizeSupportType, readSupportIntent, saveSupportIntent, type SupportType } from "@/lib/support-intent";
import "./customer-support-workspace.css";
import { readSupportOrders, type SupportOrder } from "@/lib/support-directory";
import { computeSupportUnread, isDirectoryOrderGroup, publishSupportUnread, readDirectoryPreferences, writeDirectoryPreferences, type DirectoryPreference } from "./support-unread";
import { SupportRoundRating, type RoundRatingResolution } from "./support-round-rating";
import { OrderTeamPanel, orderStageTone, orderTeamLabel, type OrderTeamAccess } from "@zzsh/ui/order-team-panel";
import { orderApi, orderIntentKey } from "@/lib/order-client";
import { CHAT_EMOJIS, MessageActionMenu, MessageQuoted, MessageReplyQuote, useMessageLongPress, type MessageActionId, type MessageActionItem } from "@zzsh/ui/message-actions";
import { MediaDraftBar, MediaMessage, mediaMessageOf, mediaSummaryOf, type MessageMediaDraft } from "@zzsh/ui/message-media";
import "@zzsh/ui/order-team.css";
import "@zzsh/ui/message-actions.css";
import "@zzsh/ui/message-media.css";

async function orderRequest<T>(path:string, signal?: AbortSignal):Promise<T>{
  const response=await fetch(path,{credentials:"same-origin",cache:"no-store",signal});return readJson<T>(response,"订单请求未完成");
}

type Consultation = {
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
  assignedAdmin: { id: string; name: string } | null;
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

type SupportMessage = {
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
  /** Raw channel message kept only so reply/revoke/delete can address the original. */
  source?: NimMessageLike;
  image?: { imageId: string; url?: string; name: string; mimeType: string; size: number };
  /** Client-validated video/file/audio envelope; never assembled from message text. */
  media?: NimMessageMedia;
};

const MAX_PENDING_IMAGES = 6;

const NO_ORIGINAL_ID_HINT = "原消息标识不可用，请先刷新历史确认是否送达。";

type StagedImageItem = {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  state?: "DECODING" | "READY";
};

type UnresolvedText = { conversationId: string; text: string; messageClientId?: string; unknown: boolean };

type PendingImageItem = {
  id?: string;
  conversationId: string;
  file: File;
  previewUrl: string;
  name: string;
  messageClientId?: string;
  state: "FAILED" | "UNKNOWN" | "SENDING";
  progress?: number;
};

function decodeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof Image === "undefined") {
      resolve({ width: 1, height: 1 });
      return;
    }
    const image = new Image();
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve({ width: image.naturalWidth, height: image.naturalHeight }) : reject(new Error("图片无法解码"));
    image.onerror = () => reject(new Error("图片无法解码"));
    image.src = url;
  });
}

type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };

const PREVIEW_CONVERSATIONS = [
  { id: "preview-product", title: "商品咨询 · 演示", preview: "可以帮我确认一下这件商品吗？", time: "刚刚", unread: 2 },
  { id: "preview-general", title: "一般咨询 · 演示", preview: "连接客服通道后将在这里恢复历史消息", time: "—", unread: 0 },
] as const;

const PREVIEW_MESSAGES: Record<string, SupportMessage[]> = {
  "preview-product": [
    { id: "system-1", from: "system", text: "本地演示数据 · 未连接客服通道", time: "09:41" },
    { id: "customer-1", from: "customer", text: "你好，我想了解这件商品的租期和当前可咨询状态。", time: "09:42", self: true, status: "sent" },
    { id: "agent-1", from: "agent", text: "你好，我来帮你确认。商品信息已附在右侧，具体规则以服务端报价和客服确认结果为准。", time: "09:43", self: false },
  ],
  "preview-general": [],
};

const PREVIEW_PRODUCT = {
  objectId: "preview_listing_01",
  title: "三角洲行动 · 资源账号",
  summary: "公开商品摘要 · 仅用于检查商品卡布局",
  priceText: "按当前规则报价",
  statusText: "可咨询",
};

function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "平台客服"; }

/** 目录/聊天切换断点：与 customer-support-workspace.css 的 760px 媒体查询一致。 */
const SUPPORT_NARROW_QUERY = "(max-width: 760px)";
function subscribeSupportViewport(onChange: () => void): () => void {
  const media = window.matchMedia(SUPPORT_NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function supportViewportNarrow(): boolean {
  return window.matchMedia(SUPPORT_NARROW_QUERY).matches;
}

/** 选择/消息都以持久线程为键：同一 Team 跨轮次保留历史，轮次 id 变化不换行。 */
function threadKeyOf(conversation: Pick<Consultation, "id" | "threadId">): string {
  return conversation.threadId || conversation.id;
}

function threadStateOf(conversation: Pick<Consultation, "state" | "threadState">): "IDLE" | "WAITING" | "ACTIVE" {
  return conversation.threadState ?? (conversation.state === "ACTIVE" ? "ACTIVE" : conversation.state === "WAITING" ? "WAITING" : "IDLE");
}

/**
 * 线程状态短标签。用户侧不露“结束”：轮次结束只是内部状态，用户再发一条消息服务端就会自然开新一轮
 * （既有行为），所以这里只区分“进行中/等待接待”，IDLE 不给标签——客服离开的唯一痕迹是评价卡。
 */
function threadStateLabel(conversation: Pick<Consultation, "state" | "threadState">): string {
  const state = threadStateOf(conversation);
  return state === "ACTIVE" ? "进行中" : state === "WAITING" ? "等待客服接待" : "";
}

// 目录可见性、偏好键与入口未读共用一份规则：入口数出来的群，必须是目录里真的进得去的群。

function normalizeConsultation(consultation: Consultation): Consultation {
  return {
    ...consultation,
    adminReadAt: typeof consultation.adminReadAt === "string" ? consultation.adminReadAt : null,
    lastMessagePreview: typeof consultation.lastMessagePreview === "string" ? consultation.lastMessagePreview : null,
    hasUnread: consultation.hasUnread === true,
    userUnreadCount: typeof consultation.userUnreadCount === "number" && consultation.userUnreadCount > 0 ? consultation.userUnreadCount : 0,
    botAccountId: typeof consultation.botAccountId === "string" ? consultation.botAccountId : null,
  };
}

/** Names the real blocker instead of always blaming 客服接待 (link down, no conversation yet). */
function composerBlockReason(conversation: Pick<Consultation, "state" | "messageScopeState" | "conversationId" | "canSend"> | null, canSend: boolean): string | null {
  if (canSend) return null;
  if (!conversation) return "创建或选择一个会话后可发送消息";
  if (conversation.messageScopeState === "FAILED") return "客服会话待人工核验，暂不可发送";
  if (conversation.canSend === false) return "当前会话暂不可继续，请稍后重试";
  // WAITING only means "no admin yet"; the team may still be provisioning in the channel.
  const scopeReady = Boolean(conversation.conversationId) && conversation.messageScopeState === "READY";
  if (!scopeReady) return conversation.state === "WAITING" ? "正在连接客服…" : conversation.state === "CLOSED" ? "会话连接尚未就绪，请稍后重试" : "客服通道准备中，请稍候…";
  if (conversation.state === "WAITING") return "已提交，客服接入后会看到你的留言；现在也可以先发消息";
  return "消息通道正在恢复，恢复后可继续发送";
}

function formatTime(value: number): string {
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
    "账号与开租确认": "待开租",
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
function formatListTime(value: number, now = Date.now()): string {
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

function supportedImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  if (/^\/api\/(?:im|bff\/admin\/im)\/images\/[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  try {
    const base = typeof window === "undefined" ? "https://invalid.local" : window.location.origin;
    const parsed = new URL(value, base);
    const protocol = parsed.protocol.toLowerCase();
    if (["blob:", "data:", "file:", "javascript:"].includes(protocol)) return null;
    if (protocol === "https:") return parsed.href;
    if (protocol === "http:" && typeof window !== "undefined" && parsed.origin === window.location.origin) {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function imageOf(message: NimMessageLike): SupportMessage["image"] | undefined {
  if (message.messageType !== 1 || !message.attachment || typeof message.attachment !== "object") return undefined;
  const attachment = message.attachment;
  // The supplier SDK exposes url/thumbUrl while the local-fake transport uses
  // imageId. A sender echo may lack the URL entirely: keep an image projection
  // (placeholder) so a later no-URL echo can never overwrite a rich history
  // record with the unsupported-text fallback.
  const imageId = typeof attachment.imageId === "string" ? attachment.imageId : "";
  const rawUrl = typeof attachment.url === "string" ? attachment.url : typeof attachment.thumbUrl === "string" ? attachment.thumbUrl : undefined;
  let url: string | undefined;
  if (rawUrl !== undefined) {
    const checked = supportedImageUrl(rawUrl);
    url = checked ?? undefined;
  } else if (imageId && /^[A-Za-z0-9._:-]{1,128}$/.test(imageId)) {
    url = `/api/im/images/${encodeURIComponent(imageId)}`;
  }
  return {
    imageId: rawUrl !== undefined && !url ? "" : imageId,
    url,
    name: typeof attachment.name === "string" ? attachment.name : "图片",
    mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "image/jpeg",
    size: typeof attachment.size === "number" ? attachment.size : 0,
  };
}

export function messageFromNim(message: NimMessageLike, accountId: string): SupportMessage | null {
  const senderId = typeof message.senderId === "string" ? message.senderId : "";
  if (!senderId) return null;
  const self = senderId === accountId;
  const base = {
    id: message.messageServerId || message.messageClientId || `${senderId}-${message.createTime}`,
    createTime: message.createTime,
    senderId,
    messageClientId: message.messageClientId,
    ...(message.messageServerId ? { messageServerId: message.messageServerId } : {}),
    ...(message.messageType === undefined ? {} : { messageType: message.messageType }),
    source: message,
  };

  if (message.revoked === true) {
    return {
      ...base,
      from: self ? "customer" : "agent",
      text: "",
      time: formatTime(message.createTime),
      status: self ? "sent" : undefined,
      self,
      revoked: true,
    };
  }

  if (message.messageType === 5) {
    const attach = message.attachment as { type?: number } | undefined;
    const isTeamInvite = attach && typeof attach === "object" && attach.type === 0;
    return {
      ...base,
      from: "system",
      text: isTeamInvite ? "成员已加入会话" : "会话信息已更新",
      time: formatTime(message.createTime),
    };
  }

  const image = imageOf(message);
  const media = mediaMessageOf(message);
  const text = typeof message.text === "string" && message.text.trim()
    ? message.text
    : image || media ? "" : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  return {
    ...base,
    from: self ? "customer" : "agent",
    text,
    time: formatTime(message.createTime),
    status: self ? "sent" : undefined,
    self,
    ...(message.reply ? { reply: message.reply } : {}),
    ...(image === undefined ? {} : { image }),
    ...(media === undefined ? {} : { media }),
  };
}

function oldestOf(messages: NimMessageLike[]): NimMessageLike | undefined {
  return messages.reduce<NimMessageLike | undefined>((oldest, item) => {
    if (!oldest) return item;
    return (item.createTime ?? 0) < (oldest.createTime ?? 0) ? item : oldest;
  }, undefined);
}

function dayKeyOf(createTime?: number): string | null {
  if (createTime === undefined) return null;
  const date = new Date(createTime);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabelOf(key: string): string {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const sameDay = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` === key;
  if (sameDay(today)) return "今天";
  if (sameDay(yesterday)) return "昨天";
  const parts = key.split("-").map(Number);
  return `${parts[1]! + 1}月${parts[2]}日`;
}

function responseError(response: Response, fallback: string): Error {
  const error = new Error(response.status === 503 ? "客服服务正在准备中，请稍后重试。" : fallback) as Error & { status: number };
  error.status = response.status;
  return error;
}

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw responseError(response, fallback);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("客服响应格式无效");
  return value as T;
}

async function fetchImToken(): Promise<ImToken> {
  const response = await fetch("/api/im/token", { credentials: "same-origin", cache: "no-store" });
  const value = await readJson<Record<string, unknown>>(response, "暂时无法连接客服，请稍后重试。");
  if (typeof value.appKey !== "string" || typeof value.accountId !== "string" || typeof value.token !== "string" || !value.appKey || !value.accountId || !value.token || (value.transport !== "nim" && value.transport !== "local-fake")) throw new Error("客服连接信息异常，请稍后重试。");
  return { appKey: value.appKey, accountId: value.accountId, token: value.token, transport: value.transport };
}

async function fetchConsultations(signal?: AbortSignal): Promise<Consultation[]> {
  const response = await fetch("/api/im/consultations?limit=50", { credentials: "same-origin", cache: "no-store", signal });
  const value = await readJson<{ consultations?: unknown }>(response, "暂时无法读取咨询记录。");
  if (!Array.isArray(value.consultations)) throw new Error("咨询记录格式无效");
  return (value.consultations as Consultation[]).map(normalizeConsultation);
}

async function createConsultation(type: SupportType, subjectRef: string | null): Promise<Consultation> {
  const response = await fetch("/api/im/consultations", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, ...(subjectRef ? { subjectRef } : {}) }),
  });
  const value = await readJson<{ consultation?: Consultation }>(response, "暂时无法创建咨询，请稍后重试。");
  if (!value.consultation || typeof value.consultation.id !== "string") throw new Error("咨询响应格式无效");
  return normalizeConsultation(value.consultation);
}

function subjectRefFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get("listingId") ?? new URL(window.location.href).searchParams.get("accountId");
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function SupportTypePicker({ value, onChange, disabled = false, onSelect }: { value: SupportType; onChange: (value: SupportType) => void; disabled?: boolean; onSelect?: (value: SupportType) => void }) {
  // 投诉反馈入口保留，但两种入口进入同一个客服线程：创建时统一归一为 SERVICE。
  const pick = (next: SupportType) => { onChange(next); onSelect?.(next); };
  return <div className="support-type-picker" role="radiogroup" aria-label="客服类型">
    <button type="button" role="radio" aria-checked={value === "SERVICE"} className="support-type-option" data-active={value === "SERVICE"} disabled={disabled} onClick={() => pick("SERVICE")}><Headphones size={17} /><span><strong>在线客服</strong><small>商品、使用和平台服务咨询</small></span></button>
    <button type="button" role="radio" aria-checked={value === "COMPLAINT"} className="support-type-option" data-active={value === "COMPLAINT"} disabled={disabled} onClick={() => pick("COMPLAINT")}><ShieldCheck size={17} /><span><strong>投诉反馈</strong><small>问题反馈与服务体验处理</small></span></button>
  </div>;
}

function MessageRow({ message, agentMeta, peerAccountId, botAccountId = null, grouped = false, adminReadAt = null, roundStart = null, replySenderName, onJumpToMessage }: { message: SupportMessage; grouped?: boolean; agentMeta?: { name: string; role: string }; peerAccountId?: string | null; botAccountId?: string | null; adminReadAt?: number | null; roundStart?: number | null; replySenderName?: string | null; onJumpToMessage?: (messageId: string) => void }) {
  if (message.from === "system") return <div className="support-message-marker" role="note"><span>{message.text}</span><time>{message.time}</time></div>;
  const outgoing = message.self === true;
  // 平台已读是轮次级事实：adminReadAt 只覆盖本轮起点之后的真实 createTime；持久线程里上一轮的消息不算已读。
  const readByAdmin = outgoing && typeof message.createTime === "number" && adminReadAt !== null && roundStart !== null && message.createTime >= roundStart && message.createTime <= adminReadAt;
  const outgoingStatus = readByAdmin ? "read" : "sent";
  const isAssignedPeer = Boolean(!outgoing && message.from === "agent" && message.senderId && peerAccountId && message.senderId === peerAccountId);
  const isBot = Boolean(!outgoing && message.from === "agent" && message.senderId && botAccountId && message.senderId === botAccountId);
  // Only the account behind the current peer may borrow the 接待人 name; other
  // agent authors (transferred history) show the provable role alone.
  const senderName = outgoing
    ? "我"
    : isBot
      ? "洲洲助手（Bot）"
      : isAssignedPeer && agentMeta
        ? agentMeta.name
        : message.from === "agent"
          ? "客服"
          : "用户";
  const senderRole = isAssignedPeer && agentMeta ? agentMeta.role : undefined;
  const quoted = message.reply
    ? <MessageQuoted text={message.reply.text ?? "消息"} senderName={replySenderName} onJump={onJumpToMessage ? () => onJumpToMessage(message.reply!.messageId) : undefined} />
    : null;
  return <article className="support-message" data-from={message.from} data-self={outgoing} data-grouped={grouped}>
    <div className="support-message-avatar" aria-hidden="true">{isBot ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : message.from === "agent" ? <Headphones size={14} /> : <UserRound size={14} />}</div>
    <div className="support-message-body">
      <div className="support-message-meta">
        <span className={outgoing ? "sr-only" : "support-sender-name"}>{senderName}</span>
        {!outgoing && senderRole ? <span className="support-role-tag" data-role={senderRole}>{senderRole}</span> : null}
      </div>
      <div className="support-message-bubble-row">
        {message.revoked ? (
          <div className="support-message-bubble" data-slot="bubble" data-revoked="true">消息已撤回</div>
        ) : message.media ? (
          <>
            <MediaMessage media={message.media} />
            {message.text || quoted ? <div className="support-message-bubble" data-slot="bubble">{message.text}{quoted}</div> : null}
          </>
        ) : message.image ? (() => {
          const raw = message.image.url ?? (message.image.imageId ? `/api/im/images/${encodeURIComponent(message.image.imageId)}` : "");
          const url = raw ? supportedImageUrl(raw) : null;
          return url
            ? <a className="support-message-image" href={url} target="_blank" rel="noreferrer" aria-label={`查看图片 ${message.image.name}`}><img src={url} alt={message.image.name} loading="lazy" /></a>
            : <div className="support-message-bubble" data-slot="bubble">图片暂不可预览</div>;
        })() : <div className="support-message-bubble" data-slot="bubble">{message.text}{quoted}</div>}
        <time className="support-message-hover-time">{message.time}</time>
      </div>
      {outgoing && message.status && !message.revoked && roundStart !== null && typeof message.createTime === "number" && message.createTime >= roundStart ? <div className="support-message-status" data-read={outgoingStatus}><Check size={12} />{outgoingStatus === "read" ? "已读" : "未读"}</div> : null}
    </div>
  </article>;
}

function ConnectionState({ preview, state, localFake = false }: { preview: boolean; localFake?: boolean; state: NimWebConnectionState | "idle" | "error" }) {
  // Driven only by the connection itself: an unrelated send failure must never
  // be reported as a broken link (state === "error" already covers that).
  if (preview || localFake) {
    return <span className="support-connection-state" data-state="preview" aria-live="polite">
      {preview ? <ShieldCheck size={13} /> : <Wifi size={13} />}{preview ? "本地演示" : "本地测试通道"}
    </span>;
  }
  const label = state === "CONNECTED" ? null : state === "RECONNECTING" ? "正在重连" : state === "AUTH_FAILED" ? "授权失效" : state === "KICKED" ? "连接已被踢出" : state === "error" ? "连接失败" : "未连接";
  if (label === null) {
    // Normal connected state is quiet and unobtrusive, per design requirement
    return <span className="support-connection-state" data-state="connected-quiet" title="已连接" aria-live="polite"><span className="support-live-dot" data-state="active" aria-hidden="true" /><small>已连接</small></span>;
  }
  return <span className="support-connection-state" data-state={state === "error" ? "error" : "offline"} aria-live="polite">
    {state === "RECONNECTING" ? <Wifi size={13} /> : <WifiOff size={13} />}{label}
  </span>;
}

export function CustomerSupportWorkspace({ preview = false, embedded = false, visible = true, initialType = "SERVICE", initialOrderParty, initialOrderId, requestSerial=0, onClose }: { preview?: boolean; embedded?: boolean; visible?: boolean; initialType?: SupportType; initialOrderParty?:"renter"|"owner";initialOrderId?:string;requestSerial?:number;onClose?: () => void }) {
  const [section,setSection]=useState<"consultation"|"orders">("consultation");
  const [selectedOrder,setSelectedOrder]=useState<{id:string;party:"renter"|"owner"}|null>(null);
  const [orders,setOrders]=useState<SupportOrder[]>([]);
  const [directoryState,setDirectoryState]=useState<"loading"|"ready"|"error">("loading");
  const [directoryError,setDirectoryError]=useState("");
  const [directoryRevision,setDirectoryRevision]=useState(0);
  const [directoryIdentity,setDirectoryIdentity]=useState("");
  const createFlight=useRef(false);
  useEffect(()=>{if(initialOrderId&&initialOrderParty){setSelectedOrder({id:initialOrderId,party:initialOrderParty});setSection("orders");setPanelView("chat");}},[initialOrderId,initialOrderParty,requestSerial]);
  const session = useUserSession();
  const auth = useAuthOverlay();
  const [selectedType, setSelectedType] = useState<SupportType>("SERVICE");
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => preview ? PREVIEW_CONVERSATIONS[0].id : null);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>(() => preview ? PREVIEW_MESSAGES : {});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, string | null>>({});
  const [panelView, setPanelView] = useState<"list" | "chat">("chat");
  /** 窄屏下列表/聊天互斥；宽屏两栏常显。聊天窗是否真正可见决定已读上报和“新”标记。 */
  const narrowViewport = useSyncExternalStore(subscribeSupportViewport, supportViewportNarrow, () => false);
  const [contextOpen, setContextOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [orderPopoverOpen, setOrderPopoverOpen] = useState(false);
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">(preview ? "idle" : "idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [imReady, setImReady] = useState(preview);
  const [historyMore, setHistoryMore] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [imageSending, setImageSending] = useState(false);
  // One staged video/file per consultation, mirroring the conversation-keyed
  // image tray. Flights are tracked outside React so a second click cannot
  // start a duplicate send before the draft state commits.
  const [mediaDrafts, setMediaDrafts] = useState<Record<string, MessageMediaDraft | null>>({});
  const mediaDraftsRef = useRef(mediaDrafts);
  mediaDraftsRef.current = mediaDrafts;
  const mediaFlights = useRef(new Map<string, MessageMediaDraft>());
  const [mediaSending, setMediaSending] = useState(false);
  const activeSendingIntentIdRef = useRef<string | null>(null);
  const canStartSendRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const pendingImageRef = useRef<Record<string, PendingImageItem | null>>({});
  const stagedImagesRef = useRef<Record<string, StagedImageItem[]>>({});
  const [pendingImage, setPendingImage] = useState<Record<string, PendingImageItem | null>>({});
  const [failedTexts, setFailedTexts] = useState<Record<string, UnresolvedText>>({});
  const [replyTargets, setReplyTargets] = useState<Record<string, SupportMessage | null>>({});
  const [replyUncertain, setReplyUncertain] = useState<Record<string, boolean>>({});
  const [supportMenu, setSupportMenu] = useState<{ key: string; id: string; x: number; y: number; row: HTMLElement | null } | null>(null);
  const [directoryPrefs, setDirectoryPrefs] = useState<Record<string, DirectoryPreference>>({});
  const [directoryMenu, setDirectoryMenu] = useState<{ x: number; y: number; key: string; pref: DirectoryPreference; row: HTMLElement | null } | null>(null);
  /** 本轮评价已提交/忽略后，轮询仍返回 available=true 也不再弹出。 */
  const [ratingResolved, setRatingResolved] = useState<Record<string, RoundRatingResolution>>({});
  const readHiddenRef = useRef<Record<string, boolean>>({});
  /** 线程历史已成功加载后才允许上报已读，避免把“没打开过”当已读。 */
  const [historyLoaded, setHistoryLoaded] = useState<Record<string, boolean>>({});
  /** thread 键 → 已上报的 round+lastMessage 签名，目录轮询不会重复 POST。 */
  const readSignatureRef = useRef<Record<string, string>>({});
  const readOrderSignatureRef = useRef<Record<string, string>>({});
  const [stagedImages, setStagedImages] = useState<Record<string, StagedImageItem[]>>({});
  const stagedImage = useMemo(() => {
    const map: Record<string, StagedImageItem | null> = {};
    for (const key of Object.keys(stagedImages)) {
      map[key] = stagedImages[key]?.[0] ?? null;
    }
    return map;
  }, [stagedImages]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const chatHeadingRef = useRef<HTMLElement | null>(null);
  const previousPanelViewRef = useRef(panelView);
  const composingRef = useRef(false);
  const lifecycleRef = useRef<ImClientLifecycle<NimWebClientLike> | null>(null);
  const clientRef = useRef<NimWebClientLike | null>(null);
  const activeIdRef = useRef(activeId);
  const consultationsRef = useRef(consultations);
  const identityRef = useRef("");
  const identityGenerationRef = useRef(0);
  const intentInFlightRef = useRef<string | null>(null);
  const readyIdentityRef = useRef<string | null>(null);
  const historyAnchorRef = useRef<Record<string, NimMessageLike>>({});
  const subjectRef = useMemo(() => subjectRefFromLocation(), []);

  const lastAuthenticatedIdentityRef = useRef<string | null>(null);
  if (session.status === "authenticated" && session.userId) {
    lastAuthenticatedIdentityRef.current = `${session.userId}:${session.identityVersion}`;
  } else if (session.status === "guest") {
    lastAuthenticatedIdentityRef.current = null;
  }

  const currentIdentity = preview
    ? "preview"
    : session.status === "authenticated" && session.userId
      ? `${session.userId}:${session.identityVersion}`
      : session.status === "loading" && lastAuthenticatedIdentityRef.current
        ? lastAuthenticatedIdentityRef.current
        : `session:${session.status}`;
  useEffect(() => {
    setDirectoryMenu(null);
    setDirectoryPrefs(preview ? {} : readDirectoryPreferences(currentIdentity));
  }, [currentIdentity, preview]);
  const revalidateAfterUnauthorized = useCallback((cause: unknown): boolean => {
    if (httpStatus(cause) !== 401) return false;
    void session.confirm();
    return true;
  }, [session.confirm]);
  /** A send on an IDLE/CLOSED thread reopens a waiting round server-side; read that back instead of inventing local state. */
  const reloadThreadStates = useCallback(async () => {
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    try {
      const list = await fetchConsultations();
      if (generation === identityGenerationRef.current && identityRef.current === identity) setConsultations(list);
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
    }
  }, [currentIdentity, revalidateAfterUnauthorized]);
  /**
   * 用户已读只由服务端事实驱动：成功后先本地清掉未读点，再刷新目录核对。
   * 签名在发请求前记录以防并发重复；失败清掉该签名，保留 hasUnread，下次打开/刷新时可重试。
   */
  const markThreadRead = useCallback(async (threadKey: string, roundId: string, signature: string) => {
    if (preview || !threadKey || !roundId || readSignatureRef.current[threadKey] === signature) return;
    readSignatureRef.current[threadKey] = signature;
    const releaseSignature = () => {
      if (readSignatureRef.current[threadKey] === signature) delete readSignatureRef.current[threadKey];
    };
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    try {
      const response = await fetch(`/api/im/consultations/${encodeURIComponent(roundId)}/read`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) { releaseSignature(); return; }
      if (generation !== identityGenerationRef.current || identityRef.current !== identity) return;
      setConsultations((current) => current.map((item) => threadKeyOf(item) === threadKey ? { ...item, hasUnread: false, userUnreadCount: 0 } : item));
      void reloadThreadStates();
    } catch {
      // 网络/超时失败没有服务端事实，允许下一次可见时机重试，避免永久锁死。
      releaseSignature();
    }
  }, [currentIdentity, preview, reloadThreadStates]);
  if (identityRef.current !== currentIdentity) {
    identityRef.current = currentIdentity;
    identityGenerationRef.current += 1;
  }
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const sectionRef = useRef(section);
  sectionRef.current = section;
  activeIdRef.current = activeId;
  consultationsRef.current = consultations;
  const activeDraftKey = activeId ?? "";
  const draft = drafts[activeDraftKey] ?? "";
  const attachment = attachments[activeDraftKey] ?? null;
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [activeDraftKey]: value }));
  const setAttachment = (value: string | null) => setAttachments((current) => ({ ...current, [activeDraftKey]: value }));
  const setDraftFor = (key: string, value: string) => setDrafts((current) => ({ ...current, [key]: value }));
  const insertEmoji = (emoji: string) => {
    const el = draftRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    if (next.length > 4000) return;
    setDraft(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const position = start + emoji.length;
      el?.setSelectionRange(position, position);
    });
  };
  const setAttachmentFor = (key: string, value: string | null) => setAttachments((current) => ({ ...current, [key]: value }));

  // Opening the window resolves the entry type instead of inheriting whatever
  // conversation loaded first. Complaints are plain chats now: a legacy COMPLAINT
  // entry normalizes to SERVICE, and this user's persistent SERVICE thread is
  // selected, including an IDLE/CLOSED one whose history stays readable. Opening
  // never creates.
  useEffect(() => {
    if (preview) return;
    const type = normalizeSupportType(initialType);
    // 入口意图保留在 picker 上（投诉反馈/在线客服），线程仍按归一后的 SERVICE 线程复用。
    setSelectedType(initialType);
    if (initialOrderId && initialOrderParty) return;
    const existing = consultationsRef.current.find((item) => item.type === type);
    setSection("consultation");
    setPanelView("chat");
    setActiveId(existing ? threadKeyOf(existing) : null);
  }, [initialOrderId, initialOrderParty, initialType, preview, requestSerial]);

  useEffect(() => {
    if (preview || !imReady || readyIdentityRef.current !== currentIdentity || session.status !== "authenticated" || !session.userId) return;
    const intent = readSupportIntent();
    if (!intent) return;
    const intentKey = `${intent.type}:${intent.source}:${intent.createdAt}`;
    if (intentInFlightRef.current === intentKey) return;
    intentInFlightRef.current = intentKey;
    const generation = identityGenerationRef.current;
    const type = normalizeSupportType(intent.type);
    setSelectedType(type);
    setBusy(true);
    void createConsultation(type, subjectRef).then((consultation) => {
      if (generation !== identityGenerationRef.current || identityRef.current !== currentIdentity) return;
      if (consultation.state === "WAITING" || consultation.conversationId) clearSupportIntent(intent);
      setConsultations((current) => [consultation, ...current.filter((item) => threadKeyOf(item) !== threadKeyOf(consultation))]);
      setActiveId(threadKeyOf(consultation));
    }).catch((cause) => {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) {
        intentInFlightRef.current = null;
        setError(cause instanceof Error ? cause.message : "暂时无法恢复这次咨询。原咨询意图仍会保留，可稍后重试。");
      }
    }).finally(() => {
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setBusy(false);
    });
  }, [currentIdentity, imReady, preview, revalidateAfterUnauthorized, session.status, session.userId, subjectRef]);

  useEffect(() => {
    if (preview) {
      setConsultations([]);
      setMessages(PREVIEW_MESSAGES);
      setDrafts({});
      setAttachments({});
      setReplyTargets({});
      setReplyUncertain({});
      setSupportMenu(null);
      setRatingResolved({});
      setHistoryLoaded({});
      readSignatureRef.current = {};
      readOrderSignatureRef.current = {};
      setActiveId(PREVIEW_CONVERSATIONS[0].id);
      setConnection("idle");
      setImReady(true);
      setMediaDrafts({});
      mediaDraftsRef.current = {};
      mediaFlights.current.clear();
      setMediaSending(false);
      readyIdentityRef.current = "preview";
      return;
    }
    setConsultations([]);
    setOrders([]);setSelectedOrder(initialOrderId&&initialOrderParty?{id:initialOrderId,party:initialOrderParty}:null);setDirectoryIdentity("");setDirectoryState("loading");
    setMessages({});
    setDrafts({});
    setAttachments({});
    setActiveId(null);
    setConnection("idle");
    setError(undefined);
    setBusy(false);
    setImageSending(false);
    setMediaDrafts({});
    mediaDraftsRef.current = {};
    mediaFlights.current.clear();
    setMediaSending(false);
    activeSendingIntentIdRef.current = null;
    isSubmittingRef.current = false;
    setImReady(false);
    setHistoryMore({});
    setHistoryLoading(false);
    setFailedTexts({});
    setReplyTargets({});
    setReplyUncertain({});
    setSupportMenu(null);
    setRatingResolved({});
    readHiddenRef.current = {};
    setHistoryLoaded({});
    readSignatureRef.current = {};
    readOrderSignatureRef.current = {};
    setPendingImage((current) => {
      for (const item of Object.values(current)) if (item) URL.revokeObjectURL(item.previewUrl);
      return {};
    });
    setStagedImages((current) => {
      for (const list of Object.values(current)) {
        for (const item of list) if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return {};
    });
    historyAnchorRef.current = {};
    readyIdentityRef.current = null;
    intentInFlightRef.current = null;
  }, [currentIdentity, preview]);

  useEffect(() => {
    if (preview || session.status !== "authenticated" || !session.userId) return;
    let cancelled = false;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    const lifecycle = new ImClientLifecycle<NimWebClientLike>(async (context) => {
      const token = await fetchImToken();
      if (token.transport === "local-fake") return createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: token.accountId, pollMs: 1_500 })(context);
      const factory = createNimWebClientFactory({
        appKey: token.appKey,
        accountId: token.accountId,
        messageAuthorization: async ({ conversationId, operation }) => {
          const response = await fetch(`/api/im/message-access?conversationId=${encodeURIComponent(conversationId)}&operation=${operation}`, { credentials: "same-origin", cache: "no-store" });
          if (cancelled || generation !== identityGenerationRef.current || identityRef.current !== identity) return;
          if(operation==="read"&&(response.status===401||response.status===403)){
            readHiddenRef.current[conversationId] = true;
            const consultation = consultationsRef.current.find(item => item.conversationId === conversationId);
            if (consultation) {
              const threadKey = consultation.threadId || consultation.id;
              setMessages(current => ({...current, [threadKey]: []}));
              if (activeIdRef.current === threadKey) setError("当前消息读取权限已变化，私有消息已隐藏。");
            }
          }
          const value = await readJson<{ authorized?: unknown }>(response, "当前咨询授权已变化，请刷新后重试。");
          if (value.authorized !== true) throw new Error("当前咨询未获授权");
          if (operation === "read") delete readHiddenRef.current[conversationId];
        },
        tokenProvider: async (accountId) => {
          if (accountId !== token.accountId) throw new Error("客服账号校验失败，请刷新后重试。");
          return (await fetchImToken()).token;
        },
      });
      return factory(context);
    });
    lifecycleRef.current = lifecycle;
    const run = async () => {
      try {
        setConnection("CONNECTING");
        setError(undefined);
        const client = await lifecycle.open(session.userId!);
        if (cancelled || generation !== identityGenerationRef.current || identityRef.current !== identity) return;
        clientRef.current = client;
        setConnection(client.getConnectionState());
        readyIdentityRef.current = identity;
        setImReady(true);
        client.onConnectionStateChange((state) => { if (!cancelled && generation === identityGenerationRef.current && identityRef.current === identity) { setConnection(state); if (state === "AUTH_FAILED" || state === "KICKED") setError("客服连接已失效，请刷新后重试。"); } });
        client.onMessages((incoming) => {
          if (cancelled || generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client) return;
          for (const raw of incoming) {
            const item = messageFromNim(raw, client.accountId);
            const consultation = consultationsRef.current.find((candidate) => candidate.conversationId === raw.conversationId);
            if (!item || !consultation) continue;
            setMessages((current) => ({ ...current, [threadKeyOf(consultation)]: mergeImMessages(current[threadKeyOf(consultation)] ?? [], [item]) }));
            // 即时反馈：服务端计数仍是权威，下一次目录轮询会覆盖这个乐观增量。
            if (item.self !== true) {
              setConsultations((current) => current.map((candidate) => threadKeyOf(candidate) === threadKeyOf(consultation)
                ? { ...candidate, hasUnread: true, userUnreadCount: Math.min((candidate.userUnreadCount ?? 0) + 1, 999) }
                : candidate));
            }
          }
        });
      } catch (cause) {
        revalidateAfterUnauthorized(cause);
        if (!cancelled && generation === identityGenerationRef.current && identityRef.current === identity) { setConnection("error"); setImReady(false); setError(cause instanceof Error ? cause.message : "暂时无法打开客服窗口。"); }
      }
    };
    void run();
    return () => {
      cancelled = true;
      clientRef.current = null;
      if (generation === identityGenerationRef.current && identityRef.current === identity) {
        readyIdentityRef.current = null;
        setImReady(false);
      }
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      void lifecycle.close();
    };
  }, [currentIdentity, preview, revalidateAfterUnauthorized, session.status, session.userId]);

  useEffect(() => {
    if (preview || !visible || session.status !== "authenticated") return;
    let cancelled=false, pending=false;
    const generation=identityGenerationRef.current;
    let controller = new AbortController();
    let scan = readSupportOrders(<T,>(path: string) => orderRequest<T>(path, controller.signal), controller.signal);
    const refresh=async()=>{
      if(cancelled || pending || document.visibilityState === "hidden")return;
      pending=true;
      const signal = controller.signal;
      try {
        const [list,orderPage]=await Promise.all([fetchConsultations(signal),(async()=>{
          let page;
          for (let count = 0; count < 2; count++) {
            signal.throwIfAborted();
            page = (await scan.next()).value;
            if (page?.complete) break;
          }
          return page;
        })()]);
        if(cancelled||signal.aborted||generation!==identityGenerationRef.current)return;
        setConsultations(list);setDirectoryIdentity(currentIdentity);setDirectoryError("");
        if (orderPage?.complete) {
          setOrders(orderPage.items.filter(isDirectoryOrderGroup));setDirectoryState("ready");
          scan = readSupportOrders(<T,>(path: string) => orderRequest<T>(path, controller.signal), controller.signal);
        }
      } catch(cause) {
        if(cancelled||signal.aborted||generation!==identityGenerationRef.current)return;
        controller.abort();controller = new AbortController();
        scan = readSupportOrders(<T,>(path: string) => orderRequest<T>(path, controller.signal), controller.signal);
        revalidateAfterUnauthorized(cause);setDirectoryState("error");setDirectoryError(httpStatus(cause)===403?"当前会话目录不可访问，请重新确认权限。":cause instanceof Error?cause.message:"暂时无法读取会话目录。");
        if(httpStatus(cause)===401||httpStatus(cause)===403){setDirectoryIdentity("");setConsultations([]);setOrders([]);setMessages({});setDrafts({});setActiveId(null);setSelectedOrder(null);}
      } finally {pending=false;}
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller.abort();
      else {
        controller = new AbortController();
        scan = readSupportOrders(<T,>(path: string) => orderRequest<T>(path, controller.signal), controller.signal);
        void refresh();
      }
    };
    setDirectoryState("loading");void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    const timer=window.setInterval(()=>void refresh(),5000);
    return()=>{cancelled=true;controller.abort();document.removeEventListener("visibilitychange", onVisibility);window.clearInterval(timer);};
  },[currentIdentity,preview,visible,directoryRevision,revalidateAfterUnauthorized,session.status]);

  // 入口未读共用一份快照：窗口开着时它的目录轮询就是唯一写入方，轨道不再另外发请求；
  // 关窗后由轨道接手。数字没变时 publish 不惊动订阅者，轮询不会引起额外渲染。
  useEffect(() => {
    if (preview) return;
    publishSupportUnread(computeSupportUnread(consultations, orders, directoryPrefs));
  }, [consultations, directoryPrefs, orders, preview]);

  useEffect(() => {
    if (preview || activeId || consultations.length === 0) return;
    // 入口意图（投诉/客服）共享 SERVICE 线程：优先选统一线程，只有不存在时才退回旧 COMPLAINT 行。
    const wanted = normalizeSupportType(selectedType);
    const existing = consultations.find((item) => item.type === wanted) ?? consultations.find((item) => item.type === selectedType);
    if (existing) setActiveId(threadKeyOf(existing));
  }, [activeId, consultations, preview, selectedType]);

  useEffect(()=>{if(!preview&&!initialOrderId&&!activeId&&!selectedOrder&&!consultations.length&&orders.length){setSelectedOrder({id:orders[0]!.id,party:orders[0]!.party});setSection("orders");}},[preview,initialOrderId,activeId,selectedOrder,consultations,orders]);
  useEffect(() => { setContextOpen(false); }, [activeId]);

  useEffect(() => {
    if (previousPanelViewRef.current === panelView) return;
    previousPanelViewRef.current = panelView;
    const target = panelView === "chat"
      ? chatHeadingRef.current
      : gridRef.current?.closest('.support-unified')?.querySelector<HTMLElement>('.support-directory .support-conversation-item[data-active="true"]') ?? gridRef.current?.querySelector<HTMLElement>('.support-conversation-item[data-active="true"]') ?? gridRef.current?.querySelector<HTMLElement>(".support-conversation-item") ?? gridRef.current?.querySelector<HTMLElement>(".support-list-heading");
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof Node && target.contains(active)) return;
    target.focus({ preventScroll: true });
  }, [panelView]);

  const activeConversation = preview
    ? null
    : consultations.find((item) => threadKeyOf(item) === activeId) ?? null;
  const previewConversation = preview ? PREVIEW_CONVERSATIONS.find((item) => item.id === activeId) ?? PREVIEW_CONVERSATIONS[0] : null;
  const activeConversationKey = preview ? previewConversation?.id ?? "" : activeConversation ? threadKeyOf(activeConversation) : "";
  const activeMessages = messages[activeConversationKey] ?? [];
  const activeScopeReady = Boolean(activeConversation?.conversationId) && activeConversation?.messageScopeState === "READY";
  // User send rights are thread-based: the backend exposes canSend=true whenever
  // this thread's Team is READY. A closed round is still sendable; the first
  // message reopens a waiting round on the same thread. Keep the channel gates:
  // no Team or a dead link can still block the send even when the grant exists.
  const threadCanSend = activeConversation ? activeConversation.canSend ?? activeScopeReady : false;
  // The round row still decides whether the rating card is due.
  const roundEnded = activeConversation?.state === "CLOSED";
  const canSend = preview || Boolean(activeConversation && threadCanSend && activeScopeReady && clientRef.current && connection === "CONNECTED");
  // Composing stays possible while the waiting team provisions; only sending waits for READY.
  const canCompose = preview || Boolean(activeConversation && activeConversation.messageScopeState !== "FAILED");
  const waitingProvisioning = activeConversation?.state === "WAITING" && activeConversation.messageScopeState !== "FAILED" && !activeScopeReady;
  const parsedReadAt = activeConversation?.adminReadAt ? Date.parse(activeConversation.adminReadAt) : Number.NaN;
  const adminReadAtMs = Number.isFinite(parsedReadAt) ? parsedReadAt : null;
  const parsedRoundStart = activeConversation?.createdAt ? Date.parse(activeConversation.createdAt) : Number.NaN;
  const roundStartMs = Number.isFinite(parsedRoundStart) ? parsedRoundStart : null;
  // 窄屏列表视图会把聊天窗整个隐藏；只有真正可见的聊天窗才代表用户“看到了”新消息。
  const chatPaneVisible = !narrowViewport || panelView === "chat";
  // 订单群未读按成员身份计数；只有群聊真正可见时清自己的未读，列表视图不代读。
  useEffect(() => {
    if (preview || !visible || !chatPaneVisible || section !== "orders" || !selectedOrder) return;
    const order = orders.find((item) => item.id === selectedOrder.id);
    if (!order || (order.unreadCount ?? 0) <= 0) return;
    const signature = `${order.id}:${order.lastMessageAt ?? ""}:${order.unreadCount}`;
    if (readOrderSignatureRef.current[order.id] === signature) return;
    readOrderSignatureRef.current[order.id] = signature;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    void fetch(`/api/im/order-teams/${encodeURIComponent(order.id)}/read`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }).then((response) => {
      if (!response.ok) {
        if (readOrderSignatureRef.current[order.id] === signature) delete readOrderSignatureRef.current[order.id];
        return;
      }
      if (generation !== identityGenerationRef.current || identityRef.current !== identity) return;
      setOrders((current) => current.map((item) => item.id === order.id ? { ...item, unreadCount: 0 } : item));
    }).catch(() => {
      if (readOrderSignatureRef.current[order.id] === signature) delete readOrderSignatureRef.current[order.id];
    });
  }, [preview, visible, chatPaneVisible, section, selectedOrder, orders, currentIdentity]);
  const activeHistoryLoaded = historyLoaded[activeConversationKey] === true;
  const activeRoundId = activeConversation ? activeConversation.roundId || activeConversation.id : null;
  const activeRatingResolution = activeRoundId ? ratingResolved[activeRoundId] : undefined;
  const activeRating = activeConversation?.rating;
  const showRating = Boolean(!preview && roundEnded && activeConversation && threadStateOf(activeConversation) === "IDLE" && activeRoundId && activeRating?.available && !activeRating.submitted && !activeRating.dismissed && !activeRatingResolution);
  canStartSendRef.current = canSend;
  const activeReply = replyTargets[activeConversationKey] ?? null;
  const selectedMedia = mediaDrafts[activeConversationKey] ?? null;
  const mediaInFlight = Boolean(selectedMedia?.state === "SENDING" || mediaFlights.current.has(activeConversationKey) || mediaSending);
  const replyLabelOf = (message: SupportMessage): string => message.image ? "[图片]" : mediaSummaryOf(message) ?? (message.text.trim() ? message.text.trim().slice(0, 120) : "消息");
  // Media is a channel attachment, not copyable text: quote it by kind, never copy its name as message text.
  const copyableSupportText = (message: SupportMessage): string | null => !message.revoked && message.from !== "system" && !message.image && !message.media
    && (message.messageType === undefined || message.messageType === 0) && message.text.trim() ? message.text : null;
  const rowOfMessage = (target: EventTarget | null): HTMLElement | null => {
    const element = target as { closest?: (selector: string) => HTMLElement | null } | null;
    return element && typeof element.closest === "function" ? element.closest("[data-message-id]") : null;
  };
  const findActiveMessage = (id: string | undefined): SupportMessage | null => id ? (messages[activeConversationKey] ?? []).find((item) => item.id === id) ?? null : null;
  const jumpToSupportMessage = (messageId: string) => {
    const target = (messages[activeConversationKey] ?? []).find((item) => item.id === messageId || item.messageClientId === messageId || item.messageServerId === messageId);
    if (!target) return;
    const node = gridRef.current?.querySelector<HTMLElement>(`[data-message-id="${target.id.replaceAll('"', '\\"')}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const bubble = node.querySelector<HTMLElement>(".support-message-bubble") ?? node;
    bubble.classList.add("message-quote-target");
    window.setTimeout(() => bubble.classList.remove("message-quote-target"), 1600);
  };
  const openSupportMenu = (message: SupportMessage | null, x: number, y: number, row: HTMLElement | null) => {
    if (!message || message.from === "system" || message.revoked) return;
    setSupportMenu((current) => current?.key === activeConversationKey && current.id === message.id ? current : { key: activeConversationKey, id: message.id, x, y, row });
  };
  const onSupportContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    // The whole message stream suppresses the browser menu; blank space simply has no actions.
    event.preventDefault();
    const row = rowOfMessage(event.target);
    if (!row) { setSupportMenu(null); return; }
    openSupportMenu(findActiveMessage(row.dataset.messageId), event.clientX, event.clientY, row);
  };
  const supportLongPress = useMessageLongPress((point, target) => {
    const row = rowOfMessage(target);
    if (row) openSupportMenu(findActiveMessage(row.dataset.messageId), point.x, point.y, row);
  });
  const supportMenuMessage = supportMenu ? (messages[supportMenu.key] ?? []).find((item) => item.id === supportMenu.id) ?? null : null;
  const supportMenuItems: MessageActionItem[] = supportMenuMessage && !supportMenuMessage.revoked && supportMenuMessage.from !== "system" ? [
    ...(copyableSupportText(supportMenuMessage) ? [{ id: "copy" as const, label: "复制" }] : []),
    ...(canSend ? [{ id: "reply" as const, label: "回复" }] : []),
    ...(canSend && !preview && supportMenuMessage.self === true && supportMenuMessage.source ? [{ id: "revoke" as const, label: "撤回" }] : []),
    { id: "delete" as const, label: "删除", danger: true },
  ] : [];
  const clearReplyFor = (key: string) => {
    setReplyTargets((current) => (current[key] ? { ...current, [key]: null } : current));
    setReplyUncertain((current) => (current[key] ? { ...current, [key]: false } : current));
  };
  const copySupportMessage = async (message: SupportMessage) => {
    const text = copyableSupportText(message);
    try {
      if (!text || typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setError(undefined);
    } catch { setError("复制失败，请手动选择文本"); }
  };
  const revokeSupportMessage = async (key: string, message: SupportMessage) => {
    const client = clientRef.current;
    const conversationId = message.source?.conversationId || consultationsRef.current.find((item) => threadKeyOf(item) === key)?.conversationId;
    if (!client || !conversationId || !message.source) { setError("撤回失败，请刷新消息后重试"); return; }
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    try {
      const updated = await client.revokeMessage(conversationId, message.source);
      if (generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client) return;
      const next = messageFromNim(updated, client.accountId);
      if (next && !readHiddenRef.current[conversationId]) setMessages((current) => ({ ...current, [key]: mergeImMessages(current[key] ?? [], [next]) }));
      if (replyTargets[key]?.id === message.id) clearReplyFor(key);
      setError(undefined);
    } catch (cause) {
      const status = httpStatus(cause);
      setError(status === 409 ? "已超过可撤回时间" : status === 403 ? "无权撤回此消息" : "撤回失败，请重试");
    }
  };
  const deleteSupportMessage = async (key: string, message: SupportMessage) => {
    const client = clientRef.current;
    const conversationId = message.source?.conversationId || consultationsRef.current.find((item) => threadKeyOf(item) === key)?.conversationId;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    if (!preview && (!client || !conversationId || !message.source)) { setError("删除失败，消息仍保留"); return; }
    if (client && conversationId && message.source) {
      try { await client.deleteMessage(conversationId, message.source); }
      catch (cause) {
        if (generation === identityGenerationRef.current && identityRef.current === identity) {
          setError(httpStatus(cause) === 403 ? "无权删除此消息" : "删除失败，消息仍保留");
        }
        return;
      }
      if (generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client) return;
    }
    setMessages((current) => ({ ...current, [key]: (current[key] ?? []).filter((item) => item.id !== message.id) }));
    if (replyTargets[key]?.id === message.id) clearReplyFor(key);
    setError(undefined);
  };
  const onSupportMenuAction = (action: MessageActionId) => {
    const menuState = supportMenu;
    const message = supportMenuMessage;
    setSupportMenu(null);
    if (!message || !menuState) return;
    if (action === "copy") { void copySupportMessage(message); return; }
    if (action === "reply") {
      setReplyTargets((current) => ({ ...current, [menuState.key]: message }));
      setReplyUncertain((current) => ({ ...current, [menuState.key]: false }));
      setError(undefined);
      requestAnimationFrame(() => draftRef.current?.focus());
      return;
    }
    if (action === "revoke") { void revokeSupportMessage(menuState.key, message); return; }
    void deleteSupportMessage(menuState.key, message);
  };
  const toggleDirectoryPreference = (key: string, field: keyof DirectoryPreference) => {
    setDirectoryMenu(null);
    setDirectoryPrefs((current) => {
      const pref = current[key] ?? { pinned: false, muted: false };
      const next = { ...current, [key]: { ...pref, [field]: !pref[field] } };
      if (!preview) writeDirectoryPreferences(currentIdentity, next);
      return next;
    });
  };
  const openDirectoryMenu = (event: ReactMouseEvent<HTMLButtonElement>, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDirectoryMenu({ x: event.clientX, y: event.clientY, key, pref: directoryPrefs[key] ?? { pinned: false, muted: false }, row: event.currentTarget });
  };
  const unresolvedText = failedTexts[activeConversationKey] ?? null;
  const setUnresolvedTextFor = (key: string, next: UnresolvedText | null) => setFailedTexts((current) => {
    const copy = { ...current };
    if (next) copy[key] = next; else delete copy[key];
    return copy;
  });
  const agentMeta = activeConversation?.assignedAdmin?.name ? { name: activeConversation.assignedAdmin.name, role: "客服" } : undefined;

  let timelineDay = "";
  const timelineItems: ReactNode[] = activeMessages.map((message,index) => {
    const previous=activeMessages[index-1];
    const grouped=Boolean(message.senderId&&previous?.senderId===message.senderId&&message.createTime&&previous.createTime&&message.createTime-previous.createTime<300_000);
    const replySource = message.reply ? activeMessages.find((item) => item.id === message.reply!.messageId || item.messageClientId === message.reply!.messageId || item.messageServerId === message.reply!.messageId) : undefined;
    const replySenderName = replySource ? (replySource.self ? "我" : replySource.from === "agent" ? "客服" : "用户") : null;
    const items: ReactNode[] = [];
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      timelineDay = dayKey;
      items.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><div className="support-day-divider">{dayLabelOf(dayKey)}</div></MessageScrollerPrimitive.Item>);
    }
    items.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"} tabIndex={-1} onContextMenu={onSupportContextMenu} {...supportLongPress}><MessageRow message={message} grouped={grouped} agentMeta={message.from === "agent" ? agentMeta : undefined} peerAccountId={activeConversation?.peerAccountId} botAccountId={activeConversation?.botAccountId} adminReadAt={adminReadAtMs} roundStart={roundStartMs} replySenderName={replySenderName} onJumpToMessage={jumpToSupportMessage} /></MessageScrollerPrimitive.Item>);
    return items;
  }).flat();

  if (unresolvedText) {
    timelineItems.push(
      <MessageScrollerPrimitive.Item key="failed-send-msg" messageId="failed-send" scrollAnchor={true}>
        <article className="support-message support-message-failed" data-from="customer" data-self={true}>
          <div className="support-message-avatar" aria-hidden="true"><UserRound size={14} /></div>
          <div className="support-message-body">
            <div className="support-message-bubble-row">
              <button
                type="button"
                className="support-message-retry-btn"
                title={unresolvedText.unknown ? "发送结果未确认，点击重试" : "发送失败，点击重试"}
                aria-label="重新发送"
                onClick={() => void retrySend()}
                disabled={busy || !canSend}
              >
                <CircleAlert size={15} />
              </button>
              <div className="support-message-bubble" data-slot="bubble" data-failed="true">
                {unresolvedText.text}
              </div>
              <time className="support-message-hover-time">发送失败</time>
            </div>
          </div>
        </article>
      </MessageScrollerPrimitive.Item>
    );
  }
  // 评价卡和结束态感谢都留在消息流里，用户直接在下面继续输入即可开启新一轮。
  if (!preview && showRating && activeRoundId) {
    timelineItems.push(
      <MessageScrollerPrimitive.Item key="round-rating" messageId={`round-rating-${activeRoundId}`} scrollAnchor={true}>
        <SupportRoundRating key={activeRoundId} roundId={activeRoundId} onResolved={(resolution) => setRatingResolved((current) => ({ ...current, [activeRoundId]: resolution }))} />
      </MessageScrollerPrimitive.Item>
    );
  }
  if (!preview && activeRoundId && activeRatingResolution === "submitted") {
    timelineItems.push(
      <MessageScrollerPrimitive.Item key="round-rating-thanks" messageId={`round-rating-thanks-${activeRoundId}`}>
        <p className="support-rating-thanks" role="status">感谢您的评价</p>
      </MessageScrollerPrimitive.Item>
    );
  }
  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  useEffect(() => {
    if (preview || !activeConversation?.conversationId || !clientRef.current || connection !== "CONNECTED") return;
    const client = clientRef.current;
    const conversation = activeConversation;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    let cancelled = false;
    void client.getMessageHistory(conversation.conversationId!, 50).then((history) => {
      if (cancelled || generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client || activeIdRef.current !== threadKeyOf(conversation)) return;
      const rows = history.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [threadKeyOf(conversation)]: mergeImMessages(current[threadKeyOf(conversation)] ?? [], rows) }));
      const oldest = oldestOf(history);
      if (oldest) historyAnchorRef.current[threadKeyOf(conversation)] = oldest;
      setHistoryMore((current) => ({ ...current, [threadKeyOf(conversation)]: history.length === 50 }));
      setHistoryLoaded((current) => ({ ...current, [threadKeyOf(conversation)]: true }));
    }).catch((cause) => {
      revalidateAfterUnauthorized(cause);
      // 历史拉取失败以前是静默的：页面上"没有历史"和"历史加载失败"完全同形。
      // 这里把原因暴露到既有错误条，让用户和排障都能看到是哪一种失败。
      if (!cancelled) setError(`历史消息读取失败：${cause instanceof Error ? cause.message : "未知错误"}，可稍后重试`);
    });
    return () => { cancelled = true; };
  }, [activeConversation?.conversationId, activeConversation?.id, connection, currentIdentity, preview, revalidateAfterUnauthorized]);

  // 当前线程可见且历史就绪时才上报已读；预览模式、未加载历史的目录行和窄屏列表视图都不发请求。
  useEffect(() => {
    if (preview || !visible || !chatPaneVisible || section !== "consultation" || !activeConversation || activeConversation.hasUnread !== true || !activeHistoryLoaded) return;
    const roundId = activeConversation.roundId || activeConversation.id;
    void markThreadRead(threadKeyOf(activeConversation), roundId, `${roundId}:${activeConversation.lastMessageAt ?? ""}`);
  }, [activeConversation, activeConversationKey, activeHistoryLoaded, chatPaneVisible, markThreadRead, preview, section, visible]);

  const loadEarlier = async () => {
    if (preview || !activeConversation?.conversationId || !clientRef.current || historyLoading) return;
    const client = clientRef.current;
    const conversation = activeConversation;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    const anchor = historyAnchorRef.current[threadKeyOf(conversation)];
    if (!anchor) { setHistoryMore((current) => ({ ...current, [threadKeyOf(conversation)]: false })); return; }
    setHistoryLoading(true);
    try {
      const older = await client.getMessageHistory(conversation.conversationId!, 50, anchor);
      if (generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client || activeIdRef.current !== threadKeyOf(conversation)) return;
      const rows = older.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [threadKeyOf(conversation)]: mergeImMessages(current[threadKeyOf(conversation)] ?? [], rows) }));
      const oldest = oldestOf(older);
      if (oldest) historyAnchorRef.current[threadKeyOf(conversation)] = oldest;
      setHistoryMore((current) => ({ ...current, [threadKeyOf(conversation)]: older.length === 50 }));
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === identity) setError(cause instanceof Error ? cause.message : "更早的消息读取失败。");
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) setHistoryLoading(false);
    }
  };

  const startConsultation = async (requestedType: SupportType = selectedType) => {
    const type = normalizeSupportType(requestedType);
    if (createFlight.current) return;
    if (session.status !== "authenticated") {
      const source = window.location.pathname + window.location.search;
      saveSupportIntent({ type, source });
      auth.open(source, () => { void session.confirm(); });
      return;
    }
    // One persistent SERVICE thread: a live round is only selected, never duplicated.
    // A CLOSED round is the one case that posts again: the server opens exactly one new
    // WAITING round on the same thread (or returns an already reopened one). Legacy
    // COMPLAINT threads are read-only history; continuing creates/reuses SERVICE.
    const existing = consultations.find((item) => item.type === type);
    if (existing) {
      setSection("consultation");
      setPanelView("chat");
      setSelectedType(type);
      setActiveId(threadKeyOf(existing));
      if (existing.state !== "CLOSED" && existing.messageScopeState === "READY" && existing.canSend !== false) return;
    }
    createFlight.current = true;
    const generation = identityGenerationRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const consultation = await createConsultation(type, subjectRef);
      if (generation !== identityGenerationRef.current || identityRef.current !== currentIdentity) return;
      const pendingIntent = readSupportIntent();
      if (pendingIntent) clearSupportIntent(pendingIntent);
      setConsultations((current) => [consultation, ...current.filter((item) => threadKeyOf(item) !== threadKeyOf(consultation))]);
      setSection("consultation"); setPanelView("chat"); setSelectedType(type);
      setActiveId(threadKeyOf(consultation));
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setError(cause instanceof Error ? cause.message : "暂时无法创建咨询。");
    } finally {
      createFlight.current = false;
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setBusy(false);
    }
  };

  const confirmOpening = useCallback(async (target: OrderTeamAccess) => {
    if (!target.openingId || !Number.isInteger(target.openingVersion)) {
      throw Object.assign(new Error("期初信息未就绪"), { status: 409 });
    }
    // Server owns the ack; the panel re-reads access after this resolves.
    await orderApi.confirmOpening(target.orderId, target.openingId, Number(target.openingVersion), orderIntentKey());
  }, []);

  /**
   * 已结束订单群只读时进入普通客服线程：复用同一条 SERVICE 线程与历史，
   * 只把订单上下文带入草稿，不自动发送，也不新建投诉/售后专用会话。
   */
  const requestAfterSales = useCallback((target: OrderTeamAccess) => {
    if (preview) return;
    const context = `【售后申请】订单 ${target.displayNo} · ${target.gameName} · ${target.account.title?.trim() || "账号"}`;
    const focusDraft = () => requestAnimationFrame(() => draftRef.current?.focus());
    const existing = consultationsRef.current.find((item) => normalizeSupportType(item.type) === "SERVICE");
    if (existing) {
      const key = threadKeyOf(existing);
      setSection("consultation");
      setPanelView("chat");
      setSelectedType("SERVICE");
      setActiveId(key);
      setDrafts((current) => {
        const previous = current[key] ?? "";
        return previous.includes(context) ? current : { ...current, [key]: previous ? `${previous}\n${context}` : context };
      });
      focusDraft();
      return;
    }
    if (createFlight.current) return;
    createFlight.current = true;
    setBusy(true);
    setError(undefined);
    const generation = identityGenerationRef.current;
    void createConsultation("SERVICE", null).then((consultation) => {
      if (generation !== identityGenerationRef.current) return;
      const key = threadKeyOf(consultation);
      setConsultations((current) => [consultation, ...current.filter((item) => threadKeyOf(item) !== key)]);
      setSection("consultation");
      setPanelView("chat");
      setSelectedType("SERVICE");
      setActiveId(key);
      setDrafts((current) => ({ ...current, [key]: context }));
      focusDraft();
    }).catch((cause) => {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current) setError(cause instanceof Error ? cause.message : "暂时无法创建客服会话。");
    }).finally(() => {
      createFlight.current = false;
      if (generation === identityGenerationRef.current) setBusy(false);
    });
  }, [preview, revalidateAfterUnauthorized]);

  const setStagedImagesFor = (
    key: string,
    updater: StagedImageItem[] | ((current: StagedImageItem[]) => StagedImageItem[]),
    options?: { transferToPendingUrl?: string }
  ) => {
    setStagedImages((current) => {
      const prevList = current[key] ?? [];
      const nextList = typeof updater === "function" ? updater(prevList) : updater;
      stagedImagesRef.current[key] = nextList;
      const nextUrls = new Set(nextList.map((item) => item.previewUrl));
      for (const item of prevList) {
        if (item.previewUrl && !nextUrls.has(item.previewUrl) && item.previewUrl !== options?.transferToPendingUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return { ...current, [key]: nextList };
    });
  };

  const setStagedImageFor = (key: string, next: StagedImageItem | null, options?: { transferToPending?: boolean }) => {
    setStagedImagesFor(
      key,
      next ? [next] : [],
      options?.transferToPending && next ? { transferToPendingUrl: next.previewUrl } : undefined
    );
  };

  const setPendingImageFor = (key: string, next: PendingImageItem | null | ((current: PendingImageItem | null) => PendingImageItem | null)) => {
    setPendingImage((current) => {
      const previous = current[key];
      const resolved = typeof next === "function" ? next(previous ?? null) : next;
      pendingImageRef.current[key] = resolved;
      if (previous && previous.previewUrl && previous.previewUrl !== resolved?.previewUrl) {
        URL.revokeObjectURL(previous.previewUrl);
      }
      return { ...current, [key]: resolved };
    });
  };

  const sendPendingImage = async (conversationKey: string, pending: NonNullable<(typeof pendingImage)[string]>): Promise<{ success: boolean }> => {
    const client = clientRef.current;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    if (!client) return { success: false };
    // Frozen contract: an unconfirmed image without its original client id must
    // never be re-sent under a new id; every image entry routes through here.
    if (pending.state === "UNKNOWN" && !pending.messageClientId) {
      setError("图片发送结果未确认且缺少原消息标识，请刷新历史核对后再处理。");
      return { success: false };
    }
    const intentId = pending.id || pending.messageClientId || pending.file.name;
    activeSendingIntentIdRef.current = intentId;
    setImageSending(true);
    setError(undefined);
    try {
      const sent = pending.messageClientId
        ? await client.retryImage(pending.conversationId, pending.messageClientId)
        : await client.sendImage(pending.conversationId, pending.file);
      const next = messageFromNim(sent, client.accountId);
      if (generation === identityGenerationRef.current && identityRef.current === identity && clientRef.current === client) {
        if (next) setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
        pendingImageRef.current[conversationKey] = null;
        setPendingImageFor(conversationKey, (existing) => {
          if (!existing) return null;
          const isSameIntent =
            (Boolean(existing.id) && Boolean(pending.id) && existing.id === pending.id) ||
            (Boolean(existing.messageClientId) && Boolean(pending.messageClientId) && existing.messageClientId === pending.messageClientId) ||
            (!existing.id && !pending.id && !existing.messageClientId && !pending.messageClientId && existing.file === pending.file);
          if (isSameIntent) {
            return null;
          }
          return existing;
        });
        return { success: true };
      }
      return { success: false };
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === identity) {
        const imageError = cause instanceof NimImageSendError ? cause : null;
        setPendingImageFor(conversationKey, (existing) => {
          if (!existing) {
            return {
              ...pending,
              messageClientId: imageError?.messageClientId ?? pending.messageClientId,
              state: imageError?.kind === "UNKNOWN" ? "UNKNOWN" : "FAILED",
            };
          }
          const isSameIntent =
            (Boolean(existing.id) && Boolean(pending.id) && existing.id === pending.id) ||
            (Boolean(existing.messageClientId) && Boolean(pending.messageClientId) && existing.messageClientId === pending.messageClientId) ||
            (!existing.id && !pending.id && !existing.messageClientId && !pending.messageClientId && existing.file === pending.file);
          if (!isSameIntent) {
            return existing;
          }
          return {
            ...existing,
            ...pending,
            messageClientId: imageError?.messageClientId ?? existing.messageClientId ?? pending.messageClientId,
            state: imageError?.kind === "UNKNOWN" ? "UNKNOWN" : "FAILED",
          };
        });
        setError(imageError?.kind === "UNKNOWN" ? "图片发送结果未确认，原图片已保留；可刷新历史或按原消息重试。" : cause instanceof Error ? cause.message : "图片发送失败，可重试。");
      }
      return { success: false };
    } finally {
      if (activeSendingIntentIdRef.current === intentId) {
        activeSendingIntentIdRef.current = null;
        if (generation === identityGenerationRef.current && identityRef.current === identity) {
          setImageSending(false);
        }
      }
    }
  };

  /* ---------- one staged video/file per consultation ---------- */
  const setMediaFor = (
    key: string,
    updater: ((current: MessageMediaDraft | null) => MessageMediaDraft | null) | MessageMediaDraft | null
  ) => {
    const previous = mediaDraftsRef.current[key] ?? null;
    const next = typeof updater === "function" ? updater(previous) : updater;
    mediaDraftsRef.current = { ...mediaDraftsRef.current, [key]: next };
    setMediaDrafts(mediaDraftsRef.current);
  };

  const stageMediaFile = (file: File, kind: "video" | "file") => {
    const key = activeConversationKey;
    if (!key || !canSend) { setError("接入会话后才能添加视频或文件。"); return; }
    const current = mediaDraftsRef.current[key] ?? null;
    if (current?.state === "SENDING") { setError("媒体正在发送，请稍候"); return; }
    if (current?.state === "UNKNOWN") { setError("上次媒体发送结果未确认，请先按原消息重试"); return; }
    try { validateNimMediaFile(file, kind); } catch (cause) { setError(`${file.name}：${cause instanceof Error ? cause.message : "媒体文件无效"}`); return; }
    setMediaFor(key, { file, kind, name: file.name, size: file.size, state: "READY", progress: 0 });
    setError(undefined);
  };

  const chooseMedia = (kind: "video" | "file") => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) stageMediaFile(file, kind);
  };

  const removeSelectedMedia = () => {
    const key = activeConversationKey;
    const current = mediaDraftsRef.current[key] ?? null;
    if (!current) return;
    if (current.state === "SENDING" || mediaFlights.current.has(key)) { setError("媒体正在发送，暂不能移除"); return; }
    if (current.state === "UNKNOWN") { setError("媒体发送结果未确认，暂不能移除；请先核对历史。"); return; }
    setMediaFor(key, null);
  };

  const beginMediaFlight = (key: string, media: MessageMediaDraft): MessageMediaDraft | null => {
    if (mediaFlights.current.has(key)) return null;
    const attempt: MessageMediaDraft = { ...media, state: "SENDING", progress: 0 };
    mediaFlights.current.set(key, attempt);
    setMediaFor(key, () => attempt);
    return attempt;
  };

  const settleMediaFlight = (
    key: string,
    attempt: MessageMediaDraft,
    result: { success: boolean; error?: unknown },
    isCurrent: () => boolean
  ) => {
    if (mediaFlights.current.get(key) !== attempt) return;
    mediaFlights.current.delete(key);
    // A stale identity must not write a result into the next user's drafts;
    // a client swap with the same identity may still settle the conversation.
    if (!isCurrent()) return;
    setMediaFor(key, (previous) => {
      if (!previous || previous.file !== attempt.file) return previous;
      if (result.success) return null;
      const mediaError = result.error instanceof NimMediaSendError ? result.error : null;
      return {
        ...previous,
        state: mediaError?.kind === "UNKNOWN" ? "UNKNOWN" : "FAILED",
        progress: 0,
        messageClientId: mediaError?.messageClientId ?? previous.messageClientId,
      };
    });
  };

  const sendOneMedia = async (key: string, media: MessageMediaDraft, conversationId: string): Promise<NimMessageLike> => {
    const client = clientRef.current;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    if (!client) throw new Error("客服连接不可用，请稍后重试。");
    // An unconfirmed result may only be replayed by its original id; a fresh
    // send would create a second message nobody can account for.
    if (media.state === "UNKNOWN" && !media.messageClientId) throw new Error("原媒体标识不可用，请先刷新历史核验，不能直接重发。");
    const attempt = beginMediaFlight(key, media);
    if (!attempt) throw new Error("该视频或文件已有发送在途");
    const identityCurrent = () => generation === identityGenerationRef.current && identityRef.current === identity;
    setMediaSending(true);
    const progress = (percentage: number) => {
      if (!identityCurrent()) return;
      setMediaFor(key, (current) => current?.file === attempt.file ? { ...current, progress: percentage } : current);
    };
    try {
      const sent = media.messageClientId
        ? await client.retryMedia(conversationId, media.messageClientId, { onProgress: progress })
        : await client.sendMedia(conversationId, media.file, media.kind, { onProgress: progress });
      settleMediaFlight(key, attempt, { success: true }, identityCurrent);
      return sent;
    } catch (error) {
      settleMediaFlight(key, attempt, { success: false, error }, identityCurrent);
      throw error;
    } finally {
      if (identityCurrent()) setMediaSending(false);
    }
  };

  const retryMediaDraft = async () => {
    const key = activeConversationKey;
    const media = mediaDraftsRef.current[key] ?? null;
    if (!media || !canSend || isSubmittingRef.current || busy || imageSending || mediaSending || mediaFlights.current.has(key)) return;
    if (media.state === "UNKNOWN" && !media.messageClientId) { setError("原媒体标识不可用，请先刷新历史核验，不能直接重发。"); return; }
    if (unresolvedTextBlocks(key)) return;
    const conversationId = activeConversation?.conversationId;
    const client = clientRef.current;
    if (!conversationId || !client) return;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    isSubmittingRef.current = true;
    setError(undefined);
    try {
      const sent = await sendOneMedia(key, media, conversationId);
      if (generation === identityGenerationRef.current && identityRef.current === identity && clientRef.current === client) {
        const next = messageFromNim(sent, client.accountId);
        if (next && !readHiddenRef.current[conversationId]) {
          setMessages((current) => ({ ...current, [key]: mergeImMessages(current[key] ?? [], [next]) }));
        }
      }
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === identity) {
        const mediaError = cause instanceof NimMediaSendError ? cause : null;
        if (mediaError?.kind === "UNSUPPORTED") setError("当前暂不支持发送视频或文件，未发送。");
        else if (mediaError?.kind === "UNKNOWN") setError("视频/文件发送结果仍未确认，请先刷新历史核对；可按原消息重试。");
        else setError(httpStatus(cause) === 403 ? "发送权限已变化，视频或文件已保留" : cause instanceof Error ? cause.message : "视频或文件发送失败，可重试。");
      }
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) isSubmittingRef.current = false;
    }
  };

  const resumeStagedImages = async () => {
    const conversationKey = activeConversationKey;
    const conversationId = activeConversation?.conversationId;
    const client = clientRef.current;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    if (!conversationId || !client || !canSend || imageSending || mediaSending || mediaInFlight) return;
    if (isSubmittingRef.current || busy) return;
    if (unresolvedTextBlocks(conversationKey)) return;
    const queued = stagedImagesRef.current[conversationKey] ?? [];
    if (queued.some((item) => item.state === "DECODING")) {
      setError("图片仍在检查，请稍候");
      return;
    }
    const currentPending = pendingImageRef.current[conversationKey];
    if (currentPending) {
      if (currentPending.state === "UNKNOWN") {
        setError("当前图片发送结果未确认，请先刷新历史或按原消息重试。");
      } else if (currentPending.state === "FAILED") {
        setError("请先处理失败的图片，再继续发送后续图片。");
      }
      return;
    }
    const toSend = stagedImagesRef.current[conversationKey] ?? stagedImages[conversationKey] ?? [];
    isSubmittingRef.current = true;
    try {
    for (const stagedItem of [...toSend]) {
      if (
        !visibleRef.current ||
        sectionRef.current !== "consultation" ||
        !canStartSendRef.current ||
        generation !== identityGenerationRef.current ||
        identityRef.current !== identity ||
        !activeConversation ||
        activeIdRef.current !== threadKeyOf(activeConversation) ||
        clientRef.current !== client
      ) {
        break;
      }
      setStagedImagesFor(conversationKey, (current) => current.filter((it) => it.id !== stagedItem.id), { transferToPendingUrl: stagedItem.previewUrl });
      const pending: PendingImageItem = {
        id: stagedItem.id,
        conversationId,
        file: stagedItem.file,
        previewUrl: stagedItem.previewUrl,
        name: stagedItem.name,
        state: "SENDING" as const,
      };
      setPendingImageFor(conversationKey, pending);
      const res = await sendPendingImage(conversationKey, pending);
      if (!res.success) break;
    }
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) isSubmittingRef.current = false;
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    const conversationKey = activeConversationKey;
    const currentStaged = stagedImages[conversationKey] ?? [];
    const currentPending = pendingImage[conversationKey];
    const currentMedia = mediaDraftsRef.current[conversationKey] ?? mediaDrafts[conversationKey] ?? null;
    if (!text && !attachment && currentStaged.length === 0 && !currentMedia) return;
    const currentReply = replyTargets[conversationKey] ?? null;
    if (currentReply && replyUncertain[conversationKey]) { setError("回复结果未确认，请刷新确认后再发送；取消引用后可按普通消息发送。"); return; }
    if (currentReply && !text) { setError("回复需要先输入文字；图片或媒体回复暂不支持"); return; }
    if (!preview && currentReply && !currentReply.source) { setError("引用消息不可用，请刷新历史后重试"); return; }

    if (isSubmittingRef.current || busy || imageSending || mediaSending) return;

    if (currentMedia?.state === "SENDING") return;
    if (currentMedia?.state === "UNKNOWN") { setError("视频/文件发送结果未确认，请先刷新历史；确认未发送后再按原消息重试。"); return; }
    if (currentMedia?.state === "FAILED") { setError("请先重试或移除发送失败的视频/文件，再发送后续内容"); return; }

    if (currentStaged.some((item) => item.state === "DECODING")) {
      setError("图片仍在检查，请稍候");
      return;
    }

    // Only an unconfirmed result carries responsibility. A definite rejection
    // never reached the channel, so the next submission must stay usable.
    if (unresolvedTextBlocks(conversationKey)) return;

    if (!preview && currentPending) {
      if (currentPending.state === "UNKNOWN") {
        setError("当前图片发送结果未确认，请先刷新历史或按原消息重试。");
        return;
      }
      if (currentPending.state === "SENDING") {
        return;
      }
      if (currentPending.state === "FAILED" && currentStaged.length > 0) {
        setError("请先处理失败的图片，再发送新图片。");
        return;
      }
    }

    isSubmittingRef.current = true;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    const conversationId = activeConversation?.conversationId;
    const readRoundId = activeConversation ? activeConversation.roundId || activeConversation.id : null;
    const client = clientRef.current;
    let sentAny = false;
    // A finished round is not a dead end: the first send reopens it server-side,
    // and the UI reads that WAITING round back instead of faking local state.
    const endedThreadBeforeSend = Boolean(activeConversation && activeConversation.state === "CLOSED");
    if (preview) {
      const parts: string[] = [];
      if (attachment) parts.push(`[附件] ${attachment}`);
      if (currentStaged.length > 0) {
        parts.push(`[图片] ${currentStaged.map((s) => s.name).join(", ")}`);
      }
      if (text) parts.push(text);
      if (currentMedia) parts.push(`[${currentMedia.kind === "video" ? "视频" : "文件"}] ${currentMedia.name}`);
      const next: SupportMessage = {
        id: `local-${Date.now()}`, from: "customer", text: parts.join("\n"), time: "现在", status: "sent", self: true,
        ...(currentReply ? { reply: { messageId: currentReply.id, senderId: currentReply.senderId ?? "", text: replyLabelOf(currentReply) } } : {}),
      };
      setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
      setDrafts((current) => current[conversationKey] === draft ? { ...current, [conversationKey]: "" } : current);
      setAttachmentFor(conversationKey, null);
      setStagedImagesFor(conversationKey, []);
      if (currentMedia) setMediaFor(conversationKey, null);
      if (currentReply) clearReplyFor(conversationKey);
      isSubmittingRef.current = false;
      return;
    }
    if (!conversationId || !client || !canSend) {
      isSubmittingRef.current = false;
      return;
    }

    try {
      // 1. Text is sent first if present
      if (text) {
        setBusy(true); setError(undefined);
        try {
          const sent = currentReply
            ? await client.replyText(conversationId, text, currentReply.source!)
            : await client.sendText(conversationId, text);
          // 真实通道下正文由 NIM 直连发出，服务端不会自动得知。补一条“只登记事实”的上报：
          // 会话据此进入客服队列、首响起点与预览也随之更新。上报失败不影响已经发出的消息。
          if (client.transport !== "local-fake") {
            void fetch("/api/im/messages", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ conversationId, text }),
            }).catch(() => undefined);
          }
          const next = messageFromNim(sent, client.accountId);
          // The receipt settles on the conversation it was sent from, not on whatever is
          // selected now; a hidden private projection is never refilled by a late success.
          if (generation === identityGenerationRef.current && identityRef.current === identity && clientRef.current === client) {
            if (next && !readHiddenRef.current[conversationId]) {
              setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
            }
            setDrafts((current) => {
              const currentVal = current[conversationKey] ?? "";
              if (currentVal === text) return { ...current, [conversationKey]: "" };
              if (currentVal.startsWith(text)) return { ...current, [conversationKey]: currentVal.slice(text.length).trimStart() };
              return current;
            });
            setAttachmentFor(conversationKey, null);
            setUnresolvedTextFor(conversationKey, null);
            if (currentReply) clearReplyFor(conversationKey);
            sentAny = true;
          }
        } catch (cause) {
          revalidateAfterUnauthorized(cause);
          if (generation === identityGenerationRef.current && identityRef.current === identity) {
            const textError = cause instanceof NimTextSendError ? cause : null;
            const status = httpStatus(cause);
            if (currentReply) {
              // A reply has no original-id replay API: an unconfirmed or transport-level
              // failure keeps text + quote and is never re-dispatched automatically.
              const unconfirmed = textError ? textError.kind === "UNKNOWN" : status === undefined || status >= 500;
              if (unconfirmed) {
                setReplyUncertain((current) => ({ ...current, [conversationKey]: true }));
                setError("回复结果未确认，请刷新确认后再发送；取消引用后可按普通消息发送。");
              } else {
                setError(status === 403 ? "发送权限已变化，草稿和引用已保留" : cause instanceof Error ? cause.message : "回复发送失败，草稿和引用已保留。");
              }
            } else {
              setError(textError?.kind === "UNKNOWN" ? "发送结果未确认，内容已保留；可先刷新历史确认是否送达。" : cause instanceof Error ? cause.message : "消息发送失败，请重试。");
              setUnresolvedTextFor(conversationKey, { conversationId: conversationId ?? "", text, messageClientId: textError?.messageClientId, unknown: textError?.kind === "UNKNOWN" });
            }
          }
          return;
        } finally {
          if (generation === identityGenerationRef.current && identityRef.current === identity) setBusy(false);
        }
      }

      // 2. Images are sent sequentially one by one
      let imagesOk = true;
      const stagedToSend = [...currentStaged];
      for (const stagedItem of stagedToSend) {
        if (
          !visibleRef.current ||
          sectionRef.current !== "consultation" ||
          !canStartSendRef.current ||
          generation !== identityGenerationRef.current ||
          identityRef.current !== identity ||
          !activeConversation ||
          activeIdRef.current !== threadKeyOf(activeConversation) ||
          clientRef.current !== client
        ) {
          break;
        }

        setStagedImagesFor(conversationKey, (current) => current.filter((it) => it.id !== stagedItem.id), { transferToPendingUrl: stagedItem.previewUrl });
        const pending: PendingImageItem = {
          id: stagedItem.id,
          conversationId,
          file: stagedItem.file,
          previewUrl: stagedItem.previewUrl,
          name: stagedItem.name,
          state: "SENDING" as const,
        };
        setPendingImageFor(conversationKey, pending);

        const result = await sendPendingImage(conversationKey, pending);
        if (!result || !result.success) {
          imagesOk = false;
          break;
        }
        sentAny = true;
      }

      // 3. A staged video/file goes last, after text and images, so the media
      // envelope never overtakes the text it was composed with.
      const stagedMedia = mediaDraftsRef.current[conversationKey] ?? null;
      if (
        imagesOk &&
        stagedMedia?.state === "READY" &&
        visibleRef.current &&
        sectionRef.current === "consultation" &&
        canStartSendRef.current &&
        generation === identityGenerationRef.current &&
        identityRef.current === identity &&
        activeConversation !== null &&
        activeIdRef.current === threadKeyOf(activeConversation) &&
        clientRef.current === client
      ) {
        try {
          const sent = await sendOneMedia(conversationKey, stagedMedia, conversationId);
          if (generation === identityGenerationRef.current && identityRef.current === identity && clientRef.current === client) {
            const next = messageFromNim(sent, client.accountId);
            if (next && !readHiddenRef.current[conversationId]) {
              setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
            }
            sentAny = true;
          }
        } catch (cause) {
          revalidateAfterUnauthorized(cause);
          if (generation === identityGenerationRef.current && identityRef.current === identity) {
            const mediaError = cause instanceof NimMediaSendError ? cause : null;
            if (mediaError?.kind === "UNSUPPORTED") setError("当前暂不支持发送视频或文件，未发送。");
            else if (mediaError?.kind === "UNKNOWN") setError("视频/文件发送结果未确认，原文件已保留；可刷新历史或按原消息重试。");
            else setError(httpStatus(cause) === 403 ? "发送权限已变化，视频或文件已保留" : cause instanceof Error ? cause.message : "视频或文件发送失败，可重试。");
          }
        }
      }
    } finally {
      const stillCurrent = generation === identityGenerationRef.current && identityRef.current === identity;
      if (stillCurrent) isSubmittingRef.current = false;
      if (endedThreadBeforeSend) void reloadThreadStates();
      // 发送成功即保持已读：只在线程仍可见时上报，失败不影响已发送事实。
      if (sentAny && readRoundId && stillCurrent && visibleRef.current && sectionRef.current === "consultation" && activeIdRef.current === conversationKey) {
        void markThreadRead(conversationKey, readRoundId, `${readRoundId}:sent:${Date.now()}`);
      }
    }
  };

  /** Every outbound entry shares this gate: an unresolved text on the conversation must be
   *  replayed by its original id (or only reconciled), never bypassed by a new send. */
  const unresolvedTextBlocks = (conversationKey: string): boolean => {
    if (preview) return false;
    const failure = failedTexts[conversationKey];
    if (!failure?.unknown) return false;
    if (failure.messageClientId) { void retrySend(); return true; }
    setError(NO_ORIGINAL_ID_HINT);
    return true;
  };

  const retrySend = async () => {
    const conversationKey = activeConversationKey;
    const failure = failedTexts[conversationKey];
    if (!failure || !clientRef.current || !canSend) return;
    if (isSubmittingRef.current || busy || imageSending || mediaSending || mediaInFlight) return;
    if (failure.unknown && !failure.messageClientId) { setError(NO_ORIGINAL_ID_HINT); return; }
    const { conversationId, text, messageClientId } = failure;
    isSubmittingRef.current = true;
    const client = clientRef.current;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    setBusy(true); setError(undefined);
    try {
      const sent = messageClientId ? await client.retryText(conversationId, messageClientId) : await client.sendText(conversationId, text);
      const next = messageFromNim(sent, client.accountId);
      if (generation === identityGenerationRef.current && identityRef.current === identity && clientRef.current === client) {
        if (next && !readHiddenRef.current[conversationId]) {
          setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
        }
        setDrafts((current) => current[conversationKey] === text ? { ...current, [conversationKey]: "" } : current);
        setUnresolvedTextFor(conversationKey, null);
      }
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === identity) {
        const textError = cause instanceof NimTextSendError ? cause : null;
        setError(textError?.kind === "UNKNOWN" ? "发送结果仍未确认，请先刷新历史确认。" : cause instanceof Error ? cause.message : "消息发送失败，请重试。");
        setFailedTexts((current) => current[conversationKey] ? { ...current, [conversationKey]: { ...current[conversationKey]!, messageClientId: textError?.messageClientId ?? current[conversationKey]!.messageClientId } } : current);
      }
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) {
        isSubmittingRef.current = false;
        setBusy(false);
      }
    }
  };

  const stageOrSendFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (preview) {
      setAttachment(files.map((f) => f.name).join(", "));
      return;
    }
    const conversationId = activeConversation?.conversationId;
    if (!clientRef.current || !conversationId || !canSend) return;

    const conversationKey = activeConversationKey;
    const currentStaged = stagedImages[conversationKey] ?? [];
    const currentPending = pendingImage[conversationKey];
    const totalCurrent = currentStaged.length + (currentPending ? 1 : 0);
    const availableSlots = MAX_PENDING_IMAGES - totalCurrent;

    if (availableSlots <= 0) {
      setError(`每个会话最多保留 ${MAX_PENDING_IMAGES} 张未完成图片，超额图片已忽略。`);
      return;
    }

    const errors: string[] = [];
    const toProcess = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
      errors.push(`每个会话最多保留 ${MAX_PENDING_IMAGES} 张图片，超额部分已忽略`);
    }

    const toAdd: StagedImageItem[] = [];
    for (const file of toProcess) {
      try {
        validateNimImageFile(file);
      } catch (cause) {
        errors.push(`${file.name}: ${cause instanceof Error ? cause.message : "图片格式或尺寸不支持"}`);
        continue;
      }
      const id = `staged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const previewUrl = URL.createObjectURL(file);
      toAdd.push({
        id,
        file,
        previewUrl,
        name: file.name,
        size: file.size,
        width: 0,
        height: 0,
        state: "DECODING",
      });
    }

    if (errors.length > 0) {
      setError(errors.join("；"));
    }

    if (toAdd.length === 0) return;

    setStagedImagesFor(conversationKey, (current) => [...current, ...toAdd]);

    for (const item of toAdd) {
      void decodeImage(item.previewUrl).then(({ width, height }) => {
        setStagedImagesFor(conversationKey, (current) =>
          current.map((it) => (it.id === item.id ? { ...it, width, height, state: "READY" as const } : it))
        );
      }).catch(() => {
        setStagedImagesFor(conversationKey, (current) => current.filter((it) => it.id !== item.id));
        setError(`${item.name}: 图片无法解码，请选择有效的 JPG 或 PNG`);
      });
    }
  };

  const stageOrSendFile = async (file: File) => stageOrSendFiles([file]);

  const chooseImage = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length === 0) return;
    stageOrSendFiles(files);
  };
  const retryPendingImage = async () => {
    const conversationKey = activeConversationKey;
    const pending = pendingImage[conversationKey];
    if (!pending || !canSend || imageSending || mediaSending || mediaInFlight) return;
    if (isSubmittingRef.current || busy) return;
    if (unresolvedTextBlocks(conversationKey)) return;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    isSubmittingRef.current = true;
    let succeeded = false;
    try {
      succeeded = (await sendPendingImage(conversationKey, pending)).success;
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) isSubmittingRef.current = false;
    }
    if (succeeded && (stagedImages[conversationKey] ?? []).length > 0) void resumeStagedImages();
  };
  const removePendingImage = () => {
    const current = pendingImage[activeConversationKey] ?? pendingImageRef.current[activeConversationKey];
    if (!current) return;
    if (current.state === "UNKNOWN") {
      setError("图片发送结果未确认，原图片已保留；不可直接移除。");
      return;
    }
    setPendingImageFor(activeConversationKey, null);
  };
  const removeStagedImageItem = (itemId: string) => {
    setStagedImagesFor(activeConversationKey, (current) => current.filter((it) => it.id !== itemId));
  };
  const removeStagedImage = () => setStagedImagesFor(activeConversationKey, (current) => current.slice(1));

  const onComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      stageOrSendFiles(files);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (event.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (!canSend || busy || imageSending || mediaSending) return;
    const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      void stageOrSendFiles(files);
    }
  };

  const refreshHistory = async () => {
    if (!activeConversation?.conversationId || !clientRef.current) return;
    const client = clientRef.current;
    const conversation = activeConversation;
    setError(undefined);
    try {
      const history = await client.getMessageHistory(conversation.conversationId!, 50);
      if (clientRef.current !== client || activeIdRef.current !== threadKeyOf(conversation)) return;
      const rows = history.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [threadKeyOf(conversation)]: mergeImMessages(current[threadKeyOf(conversation)] ?? [], rows) }));
      // A fresh read is the confirmation step the UNKNOWN reply prompt asks for.
      setReplyUncertain((current) => current[threadKeyOf(conversation)] ? { ...current, [threadKeyOf(conversation)]: false } : current);
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      setError(cause instanceof Error ? cause.message : "历史刷新失败。");
    }
  };

  const chooseQuickReply = (value: string) => { setDraft(value); requestAnimationFrame(() => draftRef.current?.focus()); };

  if (!preview && session.status !== "authenticated") {
    const sessionError = session.status === "error";
    return <section className={`support-gate${embedded ? " support-gate-embedded" : ""}`} aria-busy={session.status === "loading"}>
      {session.status !== "loading" ? sessionError ? <CircleAlert size={28} aria-hidden="true" /> : <Headphones size={28} aria-hidden="true" /> : null}
      <div className="support-gate-heading"><div><h2>{sessionError ? "暂时无法打开客服" : "联系客服"}</h2>{session.status !== "loading" ? <p>{sessionError ? "登录状态读取失败，请重试。" : "投诉与咨询使用同一个客服会话，登录后继续。"}</p> : null}</div>{embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口" title="关闭客服窗口"><X size={18} /></button> : null}</div>
      {session.status === "loading" ? <SessionLoading layout="compact" label="正在加载客服…" /> : null}
      {!sessionError && session.status !== "loading" ? <SupportTypePicker value={selectedType} onChange={setSelectedType} /> : null}
      {sessionError ? <button type="button" className="button secondary" onClick={session.revalidate}>重试身份确认</button> : session.status === "guest" ? <button type="button" className="button primary" onClick={() => void startConsultation()}><Headphones size={15} />登录并联系客服</button> : null}
    </section>;
  }

  const currentTitle = preview
    ? previewConversation?.title ?? "客服演示"
    : activeConversation
      ? typeLabel(activeConversation.type)
      : "开始新的咨询";

  const currentSubtitle = preview
    ? "商品咨询会话"
    : activeConversation
      ? activeConversation.messageScopeState === "FAILED"
        ? "客服会话正在核验，暂不可发送"
        : activeConversation.state === "WAITING"
          ? null
          : activeConversation.state === "ACTIVE"
            ? activeConversation.assignedAdmin
              ? `当前接待：${activeConversation.assignedAdmin.name}`
              : `${typeLabel(activeConversation.type)}进行中`
            : null
      : "点击在线客服开始咨询";

  const consultationView = <section className={`support-workspace${embedded ? " support-workspace-embedded" : ""}`} data-preview={preview} aria-label="客服咨询窗口">
    {error ? <div className="support-inline-error" role="alert"><CircleAlert size={15} />{error}</div> : null}
    <div className="support-workspace-grid" ref={gridRef} data-view={preview ? panelView : "chat"}>
      {preview ? <nav className="support-conversation-list" aria-label="咨询会话">
        <div className="support-list-heading" tabIndex={-1}><div><strong>咨询记录</strong><span>{preview ? "演示" : "平台记录"}</span></div><div className="support-list-heading-actions"><span className="support-list-count">{preview ? PREVIEW_CONVERSATIONS.length : consultations.length}</span><button type="button" className="support-back" data-action="back-to-chat" onClick={() => setPanelView("chat")}><ChevronLeft size={15} />返回</button>{embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口" title="关闭客服窗口"><X size={16} /></button> : null}</div></div>
        {PREVIEW_CONVERSATIONS.map((conversation) => <button key={conversation.id} type="button" className="support-conversation-item" data-active={conversation.id === activeId} onClick={() => { setActiveId(conversation.id); setPanelView("chat"); }} aria-current={conversation.id === activeId ? "page" : undefined}><span className="support-conversation-avatar" aria-hidden="true"><Headphones size={14} /></span><span className="support-conversation-copy"><strong>{conversation.title}</strong><span>{conversation.preview}</span></span><span className="support-conversation-meta"><time>{conversation.time}</time>{conversation.unread ? <b>{conversation.unread}</b> : null}</span></button>)}
      </nav> : null}
      <main className="support-conversation-panel">
        <header className="support-conversation-heading" ref={chatHeadingRef} tabIndex={-1} data-focus-target="chat">
          <button type="button" className="support-back" data-action="back-to-conversations" onClick={() => setPanelView("list")}><ChevronLeft size={15} />会话记录</button>
          <div className="support-conversation-identity"><span className="support-live-dot" data-state={activeConversation?.state === "ACTIVE" ? "active" : "idle"} aria-hidden="true" /><div><h3>{currentTitle}</h3>{currentSubtitle ? <span>{currentSubtitle}</span> : null}</div></div>
          <div className="support-heading-actions">
            {preview || subjectRef ? <button type="button" className="support-icon-button" data-action="toggle-product-context" aria-expanded={contextOpen} aria-label="商品上下文" title="商品上下文" onClick={() => setContextOpen((value) => !value)}><Info size={16} /></button> : null}
            {embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口" title="关闭客服窗口"><X size={18} /></button> : null}
          </div>
        </header>
        <div className="support-facts-bar">
          <span className="support-fact-chip">{activeConversation ? typeLabel(activeConversation.type) : preview ? "商品咨询" : "客服咨询"}</span>
          {activeConversation && (activeConversation.messageScopeState === "FAILED" || threadStateLabel(activeConversation)) ? <span className="support-fact-chip" data-tone={activeConversation.messageScopeState === "FAILED" ? "warn" : threadStateOf(activeConversation) === "ACTIVE" ? "good" : "neutral"}>{activeConversation.messageScopeState === "FAILED" ? "待人工核验" : threadStateLabel(activeConversation)}</span> : null}
          {activeConversation?.assignedAdmin ? <span className="support-fact-chip" data-tone="good">{`客服 · ${activeConversation.assignedAdmin.name}`}</span> : null}
          {subjectRef ? <span className="support-fact-chip">{`对象 ${subjectRef}`}</span> : preview ? <span className="support-fact-chip">演示对象</span> : null}
          <span className="support-facts-spacer" />
        </div>
        <div className="support-message-area">
           {unresolvedText ? <div className="support-send-retry" role="alert"><CircleAlert size={15} /><span>{unresolvedText.unknown ? "发送结果未确认，内容已保留。" : "消息发送失败，内容已保留。"}</span><button type="button" onClick={() => void refreshHistory()}>刷新历史</button><button type="button" onClick={() => void retrySend()} disabled={busy || !canSend}>{unresolvedText.messageClientId ? "原消息重试" : "重试发送"}</button></div> : null}
           {!preview && !activeConversation ? <div className="support-start-panel" data-state="initial"><Headphones size={27} /><strong>从这里开始你的咨询</strong><span>点击后立即开始，客服接入后会看到你的留言。</span><SupportTypePicker value={selectedType} onChange={setSelectedType} disabled={busy} onSelect={(type) => void startConsultation(type)} />{busy ? <span className="support-start-panel-status" role="status">正在创建咨询…</span> : null}</div> : !preview && activeConversation?.messageScopeState === "FAILED" ? <div className="support-start-panel"><CircleAlert size={27} /><strong>客服会话待人工核验</strong><span>平台暂时无法确认客服会话状态，已暂停发送和自动重试。请稍后再试或联系平台处理。</span></div> : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor"><MessageScrollerPrimitive.Root className="support-message-scroller"><MessageScrollerPrimitive.Viewport className="support-message-viewport" aria-label="消息内容" onContextMenu={onSupportContextMenu}><MessageScrollerPrimitive.Content className="support-message-content">{timelineItems.length > 0 ? <>{historyMore[activeConversationKey] ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="support-history-more"><button type="button" onClick={() => void loadEarlier()} disabled={historyLoading}>{historyLoading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}{timelineItems}</> : <MessageScrollerPrimitive.Item messageId="empty"><div className="support-message-empty"><Headphones size={24} /><strong>{activeConversation?.state === "WAITING" ? "咨询已提交" : "等待第一条消息"}</strong><span>{activeConversation?.state === "WAITING" ? (activeScopeReady ? "客服接入后会看到你的留言；现在也可以先发消息。" : "正在连接客服…已输入的内容会保留。") : preview ? "可以从下方快捷回复开始检查交互。" : "客服连接就绪后，消息会出现在这里。"}</span></div></MessageScrollerPrimitive.Item>}</MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport><MessageScrollerPrimitive.Button direction="end" className="support-jump-button" render={<button type="button" aria-label="跳到最新消息" title="跳到最新消息" />}><ArrowDown size={14} aria-hidden="true" /></MessageScrollerPrimitive.Button></MessageScrollerPrimitive.Root></MessageScrollerPrimitive.Provider>}
        </div>
        <div className="support-composer-wrap">
          {preview ? <div className="support-quick-replies" aria-label="快捷回复"><span>快捷回复</span>{["我先帮你确认一下", "请稍等，我正在核对"].map((reply) => <button key={reply} type="button" onClick={() => chooseQuickReply(reply)}>{reply}</button>)}</div> : null}
          {attachment ? <div className="support-attachment" data-slot="attachment"><Paperclip size={14} /><span>{attachment}</span><button type="button" onClick={() => setAttachment(null)} aria-label="移除附件" title="移除附件">×</button></div> : null}
          {!preview && pendingImage[activeConversationKey] ? (() => {
            const pending = pendingImage[activeConversationKey]!;
            return <div className="support-pending-image" data-state={pending.state}><img src={pending.previewUrl} alt={pending.name} /><span>{pending.name} · {pending.state === "UNKNOWN" ? "发送结果未确认" : pending.state === "SENDING" ? `发送中 ${pending.progress ?? 0}%` : "发送失败"}{pending.messageClientId ? "" : "（无原消息标识）"}</span><button type="button" onClick={() => void retryPendingImage()} disabled={imageSending || !canSend}>{pending.messageClientId ? "原消息重试" : "重试"}</button><button type="button" onClick={removePendingImage} disabled={imageSending || pending.state === "UNKNOWN"}>移除</button></div>;
          })() : null}
          {activeReply ? <MessageReplyQuote label={replyLabelOf(activeReply)} onCancel={() => { clearReplyFor(activeConversationKey); requestAnimationFrame(() => draftRef.current?.focus()); }} /> : null}
          <form
            className="support-composer"
            data-dragging={isDragging}
            onSubmit={sendMessage}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {(stagedImages[activeConversationKey]?.length ?? 0) > 0 ? (
              <div className="support-staged-tray" data-slot="attachment">
                <div className="support-staged-tray-header">
                    <span>待发队列 ({stagedImages[activeConversationKey]!.length}/{MAX_PENDING_IMAGES})</span>
                    {!pendingImage[activeConversationKey] ? (
                      <button
                        type="button"
                        className="support-staged-resume-button"
                        onClick={() => void resumeStagedImages()}
                        disabled={imageSending || !canSend}
                      >
                        继续发送
                      </button>
                    ) : null}
                  </div>
                <div className="support-staged-tray-list">
                  {stagedImages[activeConversationKey]!.map((staged, idx) => (
                    <div className="support-staged-image" data-slot="attachment" key={staged.id}>
                      <div className="support-staged-thumb">
                        <img src={staged.previewUrl} alt={staged.name} />
                      </div>
                      <div className="support-staged-info">
                        <strong>{stagedImages[activeConversationKey]!.length > 1 ? `${idx + 1}. ${staged.name}` : staged.name}</strong>
                        <span>{(staged.size / 1024).toFixed(1)} KB · {staged.state === "DECODING" ? "检查中" : "待发送"}</span>
                      </div>
                      <button
                        type="button"
                        className="support-staged-remove"
                        onClick={() => removeStagedImageItem(staged.id)}
                        aria-label="移除待发送图片"
                        title="移除待发送图片"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {selectedMedia ? (
              <MediaDraftBar
                draft={selectedMedia}
                onRetry={() => void retryMediaDraft()}
                onRemove={removeSelectedMedia}
                disabled={mediaSending || imageSending}
              />
            ) : null}
            <textarea
              ref={draftRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = Math.min(Math.max(event.currentTarget.scrollHeight, 68), 150) + "px";
              }}
              onKeyDown={onComposerKeyDown}
              onPaste={onComposerPaste}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={preview ? "输入咨询内容…" : composerBlockReason(activeConversation, canSend) ?? "输入咨询内容…"}
              aria-label="输入咨询内容"
              rows={3}
              disabled={!canCompose || busy}
            />
            <div className="support-composer-footer">
              <div className="support-composer-tools">
                <TooltipProvider delayDuration={200}>
                  <Popover.Root open={orderPopoverOpen} onOpenChange={setOrderPopoverOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Popover.Trigger asChild>
                          <button
                            type="button"
                            className="support-tool-btn"
                            data-action="toggle-product-context"
                            aria-expanded={orderPopoverOpen}
                            aria-label="关联订单"
                            disabled={preview ? busy : (!canSend || busy)}
                            onClick={() => setOrderPopoverOpen((o) => !o)}
                          >
                            <ReceiptText size={16} />
                          </button>
                        </Popover.Trigger>
                      </TooltipTrigger>
                      <TooltipContent side="top">关联订单</TooltipContent>
                    </Tooltip>
                    <Popover.Portal>
                      <Popover.Content
                        side="top"
                        align="start"
                        sideOffset={8}
                        className="support-order-popover-content"
                      >
                        <div className="support-order-popover-header">
                          <strong>{section === "orders" ? "本单信息" : "关联订单"}</strong>
                          <span className="support-order-popover-count">
                            {preview ? "1 件演示商品" : `${orders.length} 笔订单`}
                          </span>
                        </div>
                        {preview ? (
                          <div className="support-verified-orders-list">
                            <button
                              type="button"
                              className="support-verified-order-item"
                              onClick={() => {
                                const text = `【咨询订单】${PREVIEW_PRODUCT.title} (ID: ${PREVIEW_PRODUCT.objectId})`;
                                setDraft(draft ? `${draft}\n${text}` : text);
                                setOrderPopoverOpen(false);
                                requestAnimationFrame(() => draftRef.current?.focus());
                              }}
                            >
                              <strong>{PREVIEW_PRODUCT.title}</strong>
                              <span>演示商品 · {PREVIEW_PRODUCT.objectId}</span>
                            </button>
                          </div>
                        ) : orders.length > 0 ? (
                          <div className="support-verified-orders-list">
                            {orders.map((ord) => (
                              <button
                                key={ord.id}
                                type="button"
                                className="support-verified-order-item"
                                onClick={() => {
                                  const text = `【咨询订单】${ord.title} (订单尾号: ${ord.displayNo}) [${ord.party === "owner" ? "出租" : "租入"}]`;
                                  setDraft(draft ? `${draft}\n${text}` : text);
                                  setOrderPopoverOpen(false);
                                  requestAnimationFrame(() => draftRef.current?.focus());
                                }}
                              >
                                <strong>{ord.title}</strong>
                                <span>尾号 {ord.displayNo} · {ord.party === "owner" ? "出租订单" : "租入订单"}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="support-context-empty">
                            <ReceiptText size={20} />
                            <strong>暂无可关联的订单</strong>
                            <span>仅展示你当前已付款或出租中的真实订单。</span>
                          </div>
                        )}
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>

                  <Popover.Root open={emojiOpen} onOpenChange={setEmojiOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Popover.Trigger asChild>
                          <button type="button" className="support-tool-btn" aria-label="表情" disabled={preview ? busy : (!canSend || busy)}>
                            <Smile size={16} />
                          </button>
                        </Popover.Trigger>
                      </TooltipTrigger>
                      <TooltipContent side="top">表情</TooltipContent>
                    </Tooltip>
                    <Popover.Portal>
                      <Popover.Content className="support-emoji-pop chat-emoji-grid" align="start" side="top" sideOffset={8}>
                        {CHAT_EMOJIS.map((item) => <button key={item.emoji} type="button" className="chat-emoji-button" aria-label={item.label} onClick={() => insertEmoji(item.emoji)}>{item.emoji}</button>)}
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="support-tool-btn" aria-label="发送图片">
                        <ImagePlus size={16} />
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept="image/jpeg,image/png"
                          onChange={(event) => void chooseImage(event)}
                          disabled={preview ? busy : (!canSend || busy || imageSending)}
                        />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="top">发送图片 (JPG/PNG，最大 10MB，最多 6 张)</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="support-tool-btn" aria-label="发送视频">
                        <Video size={16} />
                        <input
                          type="file"
                          accept="video/mp4,video/quicktime,video/webm"
                          onChange={chooseMedia("video")}
                          disabled={preview ? busy : (!canSend || busy || imageSending || mediaSending || selectedMedia?.state === "UNKNOWN")}
                        />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="top">发送视频 (MP4/MOV/WebM，最大 100MB)</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label className="support-tool-btn" aria-label="发送文件">
                        <FileText size={16} />
                        <input
                          type="file"
                          accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                          onChange={chooseMedia("file")}
                          disabled={preview ? busy : (!canSend || busy || imageSending || mediaSending || selectedMedia?.state === "UNKNOWN")}
                        />
                      </label>
                    </TooltipTrigger>
                    <TooltipContent side="top">发送文件 (PDF/ZIP/TXT/CSV/DOCX/XLSX/PPTX，最大 50MB)</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="support-composer-actions">
                {(!canSend || activeConversation?.messageScopeState === "FAILED") ? (
                  <span className="support-composer-status">{activeConversation?.messageScopeState === "FAILED" ? "客服会话核验中" : waitingProvisioning ? "正在连接客服…" : "当前不可发送"}</span>
                ) : (
                  <span className="support-composer-hint">
                    <kbd className="support-kbd">Enter</kbd> 发送 · <kbd className="support-kbd">Shift</kbd> + <kbd className="support-kbd">Enter</kbd> 换行
                  </span>
                )}
                <button type="submit" className="support-send-btn" disabled={!canSend || busy || imageSending || mediaSending || mediaInFlight || (!draft.trim() && !attachment && (stagedImages[activeConversationKey]?.length ?? 0) === 0 && selectedMedia?.state !== "READY")} aria-label="发送消息">
                  <span>{busy || imageSending || mediaSending ? "发送中" : "发送"}</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </main>
      {contextOpen ? <aside className="support-context-panel" aria-label="商品上下文"><div className="support-context-heading"><div><strong>商品与订单信息</strong><span>{preview ? "演示快照" : "平台授权信息"}</span></div><button type="button" className="support-icon-button" data-action="close-product-context" title="关闭商品上下文" aria-label="关闭商品上下文" onClick={() => { setContextOpen(false); gridRef.current?.querySelector<HTMLButtonElement>('[data-action="toggle-product-context"]')?.focus(); }}><X size={15} /></button></div>{preview ? <><article className="support-product-card" data-slot="attachment"><div className="support-product-card-top"><span>zzsh.im-card</span><span>v1</span></div><h3>{PREVIEW_PRODUCT.title}</h3><p>{PREVIEW_PRODUCT.summary}</p><dl><div><dt>状态</dt><dd>{PREVIEW_PRODUCT.statusText}</dd></div><div><dt>费用</dt><dd>{PREVIEW_PRODUCT.priceText}</dd></div></dl><div className="support-product-card-id">商品 ID · {PREVIEW_PRODUCT.objectId}</div></article><button type="button" className="support-action-btn support-action-primary support-context-send-btn" data-action="send-product-context" onClick={() => { const text = `【咨询订单】${PREVIEW_PRODUCT.title} (ID: ${PREVIEW_PRODUCT.objectId})`; setDraft(draft ? `${draft}\n${text}` : text); setContextOpen(false); requestAnimationFrame(() => draftRef.current?.focus()); }}><ReceiptText size={13} /><span>发送此订单信息</span></button></> : orders.length > 0 ? <div className="support-verified-orders"><span className="support-verified-orders-hint">点击可将你参与的订单信息带入咨询输入框：</span><div className="support-verified-orders-list">{orders.map((ord) => <button key={ord.id} type="button" className="support-verified-order-item" onClick={() => { const text = `【咨询订单】${ord.title} (订单尾号: ${ord.displayNo}) [${ord.party === "owner" ? "出租" : "租入"}]`; setDraft(draft ? `${draft}\n${text}` : text); setContextOpen(false); requestAnimationFrame(() => draftRef.current?.focus()); }}><strong>{ord.title}</strong><span>尾号 {ord.displayNo} · {ord.party === "owner" ? "出租订单" : "租入订单"}</span></button>)}</div></div> : <div className="support-context-empty"><Headphones size={20} /><strong>暂无可关联的订单</strong><span>仅展示你当前已付款或出租中的真实订单。</span></div>}<div className="support-context-note"><ShieldCheck size={15} /><p>订单信息来自当前账号已授权的真实订单，带入后可在发送前补充说明。</p></div></aside> : null}
    </div>
    {supportMenu && supportMenuMessage ? <MessageActionMenu key={`${supportMenu.key}:${supportMenu.id}`} x={supportMenu.x} y={supportMenu.y} items={supportMenuItems} onSelect={onSupportMenuAction} onClose={() => setSupportMenu(null)} returnFocus={supportMenu.row} /> : null}
  </section>;
  if(preview)return consultationView;
  const directoryReady=directoryIdentity===currentIdentity&&directoryState==="ready";
  const welcome=directoryReady&&!consultations.length&&!orders.length&&!initialOrderId;
  const brand = <div className="support-brand"><img src="/art/zhouzhou/avatar.webp" width={36} height={36} alt=""/><div className="support-brand-text"><strong>洲洲客服</strong><ConnectionState preview={preview} localFake={clientRef.current?.transport==="local-fake"} state={connection} /></div></div>;
  const actions=<div className="support-entry-actions"><button type="button" className="support-action-btn support-action-primary" disabled={busy||!directoryReady} onClick={()=>void startConsultation("SERVICE")}><Headphones size={14}/>联系客服</button><button type="button" className="support-action-btn support-action-secondary" disabled={busy||!directoryReady} onClick={()=>void startConsultation("COMPLAINT")}><ShieldCheck size={14}/>投诉反馈</button></div>;
  const close=<button type="button" className="support-icon-button" aria-label="关闭客服窗口" title="关闭客服窗口" onClick={onClose}><X size={18}/></button>;
  const retainedDirectory=directoryIdentity===currentIdentity&&(consultations.length>0||orders.length>0);
  if(!directoryReady&&!retainedDirectory)return <section className="support-welcome" aria-busy={directoryState==="loading"}><header>{brand}{close}</header><div role={directoryState==="error"?"alert":"status"}><h2>{directoryState==="error"?"暂时无法读取会话":"正在读取会话"}</h2><p>{directoryState==="error"?directoryError:"正在核对咨询、投诉和租入／出租订单群。"}</p>{directoryState==="error"?<button type="button" className="button secondary" onClick={()=>setDirectoryRevision(n=>n+1)}>重试读取</button>:null}</div></section>;
  if(welcome)return <section className="support-welcome"><header>{brand}{close}</header>
    <div className="support-welcome-hero">
      <span className="support-welcome-kicker">洲洲商行 · 在线客服</span>
      <h2>你好，需要什么帮助？</h2>
      <p>账号、订单和售后问题都可以在这里处理；选择一种方式开始，客服会尽快回复。</p>
      <div className="support-welcome-entries">
        <button type="button" className="support-welcome-entry" data-action="welcome-service" disabled={busy||!directoryReady} onClick={()=>void startConsultation("SERVICE")}>
          <span className="support-welcome-entry-icon" aria-hidden="true"><Headphones size={20} /></span>
          <span><strong>联系客服</strong><small>账号、订单、使用和平台服务咨询</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" className="support-welcome-entry" data-action="welcome-complaint" disabled={busy||!directoryReady} onClick={()=>void startConsultation("COMPLAINT")}>
          <span className="support-welcome-entry-icon" aria-hidden="true"><ShieldCheck size={20} /></span>
          <span><strong>投诉反馈</strong><small>问题反馈与服务体验处理</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      {error?<p className="support-welcome-error" role="alert">{error}</p>:null}
    </div>
    <footer>平台不会通过站内客服索要密码、验证码或要求线下转账。</footer>
  </section>;
  // 客服会话与订单群合并成一个列表，按置顶与最近活动倒序；右键菜单只改本机偏好。
  const directoryEntries = [
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
    const pinned = Number(Boolean(directoryPrefs[b.key]?.pinned)) - Number(Boolean(directoryPrefs[a.key]?.pinned));
    return pinned || b.sortAt - a.sortAt;
  });
  return <div className="support-unified" data-view={panelView}>
    <nav className="support-directory" aria-label="全部会话">
      <header>{brand}<span className="support-mobile-close">{close}</span></header>{actions}<h2 tabIndex={-1}>全部会话</h2>
      <div className="support-directory-items">
      {consultations.length===50?<p className="support-directory-limit">咨询目录仅提供最近50条；更早记录待接口支持。</p>:null}
      {directoryEntries.length ? directoryEntries.map((entry) => {
        const pref = directoryPrefs[entry.key] ?? { pinned: false, muted: false };
        if (entry.kind === "consultation") {
          const item = entry.item;
          const threadState = threadStateOf(item);
          const statusLabel = threadStateLabel(item);
          const lastMsg = messages[threadKeyOf(item)]?.at(-1);
          // 历史未加载时目录显示服务端最近消息摘要；空摘要不能覆盖状态兜底。
          const previewSnippet = typeof item.lastMessagePreview === "string" ? item.lastMessagePreview.trim() : "";
          const snippet = lastMsg
            ? lastMsg.image
              ? "[图片]"
              : lastMsg.media
                ? mediaSummaryOf(lastMsg) ?? "[媒体]"
                : lastMsg.from === "system"
                  ? `[系统] ${lastMsg.text}`
                  : lastMsg.text.includes("【咨询订单】")
                    ? "[订单信息]"
                    : lastMsg.text
            : previewSnippet
              ? previewSnippet
              : item.messageScopeState === "FAILED"
                ? "客服会话核验中"
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
              onContextMenu={(event) => openDirectoryMenu(event, entry.key)}
              onClick={() => {
                setSection("consultation");
                setActiveId(threadKeyOf(item));
                setSelectedType(normalizeSupportType(item.type));
                setPanelView("chat");
              }}
            >
              <span className="support-conversation-avatar" data-kind="consultation" aria-hidden="true">
                {item.type === "COMPLAINT" ? <ShieldCheck size={16} /> : <Headphones size={16} />}
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
        const orderActive = section === "orders" && selectedOrder?.id === item.id;
        // 最后一句真消息仍然优先；没有摘要时才按阶段兜底——结束态的群不能谎报“有新消息”，
        // 建群中的群也不该说“暂无消息”。
        const orderPreview = typeof item.lastMessagePreview === "string" && item.lastMessagePreview.trim()
          ? item.lastMessagePreview.trim()
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
            onContextMenu={(event) => openDirectoryMenu(event, entry.key)}
            onClick={() => {
              setSelectedOrder({ id: item.id, party: item.party });
              setSection("orders");
              setPanelView("chat");
            }}
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
    {directoryMenu ? <MessageActionMenu key={directoryMenu.key} x={directoryMenu.x} y={directoryMenu.y} label="会话操作"
      items={[
        { id: "pin" as const, label: directoryMenu.pref.pinned ? "取消置顶" : "置顶会话" },
        { id: "mute" as const, label: directoryMenu.pref.muted ? "取消消息免打扰" : "消息免打扰" },
      ]}
      onSelect={(id) => {
        if (id === "pin") toggleDirectoryPreference(directoryMenu.key, "pinned");
        else if (id === "mute") toggleDirectoryPreference(directoryMenu.key, "muted");
        else setDirectoryMenu(null);
      }}
      onClose={() => setDirectoryMenu(null)} returnFocus={directoryMenu.row} /> : null}
    <div className="support-unified-chat">
      {directoryState==="error"?<div className="support-inline-error" role="alert">{directoryError}<button type="button" onClick={()=>setDirectoryRevision(n=>n+1)}>重试读取</button></div>:null}
      <div className="support-pane" hidden={section!=="consultation"}>{consultationView}</div>
      <div className="support-order-pane" hidden={section!=="orders"}><div className="support-order-actions"><button type="button" className="support-back" onClick={()=>setPanelView("list")}>返回会话</button>{close}</div><OrderTeamPanel key={currentIdentity} identity={currentIdentity} realm="user" client={clientRef.current} connection={connection} active={section==="orders"} visible={visible} polling={visible} initialParty={selectedOrder?.party??initialOrderParty} selectedOrderId={selectedOrder?.id} compact request={orderRequest} onAuthError={()=>{void session.confirm();}} onConfirmOpening={confirmOpening} onRequestAfterSales={requestAfterSales}/></div>
    </div>
  </div>;
}
