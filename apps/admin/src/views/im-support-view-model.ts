/**
 * 客服工作台的纯数据层：类型、消息映射、在线状态纯函数、常用语与只读读取。
 * 不含 React 状态；发送/接待等业务操作仍由 im-support-view.tsx 编排。
 * 发送者投影与时长格式沿用共用模型 im-support-management-model.ts。
 */
import { nimMessageView, oldestNimMessage, type NimMessageLike, type NimMessageMedia, type NimWebClientLike, type NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { decodeImSystemNotice, isImSystemNoticeText, type ImSystemNotice } from "@zzsh/im-client/message-state";
import { mediaMessageOf } from "@zzsh/ui/message-media";
import type { OrderTeamListItem } from "@zzsh/ui/order-team-panel";
import { AdminApiError, adminRequest } from "../api";
import { supportedImageUrl } from "./im-support-guards";
import { parseSupportSender, type SupportSender } from "./im-support-management-model";
import { formatTime } from "./im-support-format";

export type SupportType = "SERVICE" | "COMPLAINT";
export type ConsultationState = "WAITING" | "ACTIVE" | "CLOSED";
export type Consultation = {
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
export type SupportMessage = {
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
  /** 服务端历史消息附带的发送者姓名；实时消息没有该字段时退回角色标签。 */
  sender?: SupportSender;
  /** Shared decode of a NIM team notification; display decides visibility. */
  notice?: ImSystemNotice;
  /** Raw channel message kept intact so reply/revoke/delete address the original. */
  source?: NimMessageLike;
  image?: { imageId: string; url?: string; thumbnailUrl?: string; name: string; mimeType: string; size: number };
  media?: NimMessageMedia;
};
export type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };
export type PresenceToday = { seconds: number; sessions: number; users: number };
export type Presence = {
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
export type PresenceHeartbeat = {
  ok: boolean;
  dispatchable: boolean;
  reason: string | null;
  disconnectedSince: string | null;
  dispatchPaused: boolean;
  stateRevision: number;
  today?: PresenceToday;
  serverTime: string;
};
export type ConnectionClaim = {
  ok: boolean;
  reason: "CLAIMED" | "OTHER_WINDOW" | "LOCKED" | "FORBIDDEN" | "SESSION_INVALID";
  version?: number;
  stateRevision?: number;
};
export type ConnectionLease = { ok: boolean; reason: string };
export type SupportSection = "consultation" | "orders";
export type QueueRow = { id: string; type: SupportType; title: string; snippet: string; time: string; sortAt: number; state: "待接入" | "接待中" | "已结束" | "通道异常"; unreadCount: number; consultation?: Consultation };
export type UnifiedRow = {
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
export type DraftImage = { key: string; file: File; previewUrl: string; name: string; size: number; width: number; height: number; state: "DECODING" | "READY" | "SENDING" | "FAILED" | "UNKNOWN"; progress: number; messageClientId?: string };
export type FailedText = { consultationId: string; conversationId: string; text: string; messageClientId?: string };

export const MAX_STAGED_IMAGES = 6;
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
export const PRESENCE_CONFLICT_NOTICE = "另一窗口已更新接待状态，已刷新为最新状态。";
export const PRESENCE_SAVE_ERROR = "接待状态未保存，请重试";
export const SESSION_REFRESH_ERROR = "会话状态刷新失败";
export const QUEUE_REFRESH_ERROR = "队列刷新失败";
export const GROUP_WINDOW_MS = 300_000;
// 回复没有“按原消息 ID 重放”的接口：结果未知时只能保留草稿与引用，等人工刷新确认，
// 不能用一条新消息自动重发。
export const REPLY_UNCERTAIN_NOTICE = "回复结果未确认，请刷新确认后再发送；取消引用后可按普通消息发送。";
// 本轮结束结果未知时的说明。不复述"仍进行中/已结束"这类推断：平台当前没有按咨询读取本轮
// 结果的接口，目录缺席、分页、转交、失权都证明不了远端到底有没有执行这次结束本轮。
export const CLOSE_OUTCOME_UNKNOWN_NOTICE = "本轮结束结果未确认：这次结束本轮可能已生效也可能没有。平台目前没有按咨询读取本轮结果的接口，本页无法确认，也不会重复提交；请由平台侧核对后再处理。";
export const ROUND_CLOSED_NOTICE = "本轮已结束，聊天记录保留；用户再次咨询会在同一会话开启新一轮。";
export type SupportHistoryRow=NimMessageLike&{sender?:SupportSender};
export type SupportHistoryPage={messages:SupportHistoryRow[];hasMore:boolean;anchor?:NimMessageLike|string};
export function supportHistoryMessage(row:SupportHistoryRow):SupportHistoryRow|null{
  const message=nimMessageView(row);
  if(!message)return null;
  const sender=parseSupportSender(row.sender);
  return sender?{...message,sender}:message;
}
export async function readConsultationHistory(client:NimWebClientLike,conversationId:string,before?:NimMessageLike|string):Promise<SupportHistoryPage>{
  if(client.transport==="local-fake"){
    const messages=await client.getMessageHistory(conversationId,50,typeof before==="object"?before:undefined);
    const mapped=messages.map(message=>supportHistoryMessage(message)).filter((message):message is SupportHistoryRow=>message!==null);
    return {messages:mapped,hasMore:messages.length===50,anchor:oldestNimMessage(messages)};
  }
  const query=new URLSearchParams({mode:"member",conversationId,limit:"50"});if(typeof before==="string")query.set("cursor",before);
  const page=await adminRequest<{messages:SupportHistoryRow[];hasMore:boolean;nextCursor:string|null}>(`/im/messages?${query}`);
  return {messages:page.messages.map(supportHistoryMessage).filter((message):message is SupportHistoryRow=>message!==null),hasMore:page.hasMore,anchor:page.nextCursor??undefined};
}

// 「案件进度」stepper 与「下一步 / 轮到你回复」已移除：assignedAdmin + messageScopeState
// 只能证明当前的接待关系与远端就绪状态，证明不了处理轮次，也证明不了历史阶段时间。
// 处理记录时间线由 ConsultationEventsCard 按真实事件投影渲染，不再从当前状态推断。
export function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "平台咨询"; }
export function roundSeqOf(consultation: { roundSeq?: number }): number | null {
  return typeof consultation.roundSeq === "number" && Number.isInteger(consultation.roundSeq) && consultation.roundSeq > 0 ? consultation.roundSeq : null;
}
export function roundTagOf(consultation: Consultation): string {
  const seq = roundSeqOf(consultation);
  return seq === null ? "" : `第 ${seq} 轮`;
}
export function roundHeadlineOf(consultation: Consultation): string {
  const seq = roundSeqOf(consultation);
  const round = seq === null ? "" : `第 ${seq} 轮接待 · `;
  if (consultation.state === "WAITING") return `${round}等待客服接入`;
  if (consultation.assignedAdmin) return `${round}${consultation.assignedAdmin.name}`;
  return `${round}尚未分配接待`;
}
export function stateLabel(state: ConsultationState): QueueRow["state"] { return state === "ACTIVE" ? "接待中" : state === "WAITING" ? "待接入" : "已结束"; }
export function scopeStateLabel(consultation: Consultation): QueueRow["state"] { return consultation.messageScopeState === "FAILED" ? "通道异常" : stateLabel(consultation.state); }
export function stageLabelOf(row: OrderTeamListItem): string {
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
export function stageToneOf(state: string): "good" | "warn" | "neutral" {
  return state === "接待中" || state === "租用中" ? "good" : state === "待接入" || state === "通道异常" || state === "已取消" ? "warn" : "neutral";
}
export function connectionForPresence(state: NimWebConnectionState | "idle" | "error"): NimWebConnectionState {
  return state === "idle" ? "DISCONNECTED" : state === "error" ? "AUTH_FAILED" : state;
}
export function createConnectionId(): string {
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
export function supportPageVisible(): boolean {
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

export function messageFromNim(message: SupportHistoryRow, accountId: string, peerAccountId?: string | null): SupportMessage | null {
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
    ...(message.sender ? { sender: message.sender } : {}),
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
export function supportMessageAuthor(
  message: Pick<SupportMessage, "self" | "senderId" | "from" | "sender">,
  selected: Pick<Consultation, "peerAccountId" | "botAccountId" | "user"> | null,
  operatorName: string,
  operatorAvatar?: string | null,
): { name: string; role: string; avatar?: string | null } {
  if (message.self) return { name: operatorName, role: "平台客服", avatar: operatorAvatar };
  if (selected?.peerAccountId && message.senderId === selected.peerAccountId) {
    return { name: selected.user?.name || selected.user?.username || "平台用户", role: "平台用户", avatar: selected.user?.avatar };
  }
  if (message.from === "agent" && selected?.botAccountId && message.senderId === selected.botAccountId) {
    return { name: "洲洲助手（Bot）", role: "机器人", avatar: null };
  }
  // 服务端历史投影已给出每个发送者的平台身份；转交前的其他客服也显示完整姓名。
  if (message.sender?.displayName) {
    const role = message.sender.role === "ADMIN" ? "平台客服" : message.sender.role === "SYSTEM" ? "机器人" : "平台用户";
    return { name: message.sender.displayName, role, avatar: message.sender.avatar };
  }
  // Historical senders the server did not project stay neutral instead of borrowing the current assignee's identity.
  return message.from === "agent"
    ? { name: "客服", role: "平台客服", avatar: null }
    : { name: selected?.user?.name || selected?.user?.username || "平台用户", role: "平台用户", avatar: null };
}

export function httpStatus(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
}
export function decodeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => (image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve({ width: image.naturalWidth, height: image.naturalHeight }) : reject(new Error("图片无法解码")));
    image.onerror = () => reject(new Error("图片无法解码"));
    image.src = url;
  });
}
export async function readImToken(connectionId: string): Promise<ImToken> {
  const value = await adminRequest<Record<string, unknown>>("/im/token", undefined, "GET", { "x-zzsh-connection-id": connectionId });
  if (typeof value.appKey !== "string" || typeof value.accountId !== "string" || typeof value.token !== "string" || !value.appKey || !value.accountId || !value.token || (value.transport !== "nim" && value.transport !== "local-fake")) throw new Error("云信登录凭据格式无效");
  return { appKey: value.appKey, accountId: value.accountId, token: value.token, transport: value.transport };
}
export async function readConsultations(): Promise<Consultation[]> {
  const value = await adminRequest<{ consultations?: unknown }>("/im/consultations?limit=50");
  if (!Array.isArray(value.consultations)) throw new Error("咨询队列格式无效");
  return value.consultations as Consultation[];
}