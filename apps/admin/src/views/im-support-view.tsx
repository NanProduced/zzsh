"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowDown, Bell, BellOff, CalendarClock, Check, ChevronLeft, CircleAlert, FileText, Headphones, Images, MessageSquareText, MoreHorizontal, Pin, ReceiptText, Search, ShieldCheck, Smile, UserRound, Video, X } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { ImClientLifecycle, ImLifecycleSupersededError } from "@zzsh/im-client/lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, NIM_IMAGE_MAX_BYTES, NimImageSendError, NimMediaSendError, NimTextSendError, validateNimImageFile, validateNimMediaFile, type NimMessageLike, type NimMessageMedia, type NimWebClientLike, type NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { decodeImSystemNotice, mergeImMessages } from "@zzsh/im-client/message-state";
import { CHAT_EMOJIS, MessageActionMenu, MessageQuoted, MessageReplyQuote, useMessageLongPress, type MessageActionId, type MessageActionItem } from "@zzsh/ui/message-actions";
import { MediaDraftBar, MediaMessage, mediaMessageOf, mediaSummaryOf, type MessageMediaDraft } from "@zzsh/ui/message-media";
import "@zzsh/ui/message-media.css";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import "@zzsh/ui/message-actions.css";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { confirmCurrentForbidden, isCurrentImRequest, messageAccessPath, supportedImageUrl, type ImRequestKey } from "./im-support-guards";
import { canOperateSupportType, createReadClientKey, createSendCapabilityKey } from "./im-support-capabilities";
import { planSupportNotificationToggle, playSupportChime, readSupportNotificationPreference, requestSupportNotificationPermission, storeSupportNotificationPreference, supportNotificationPermission, unlockSupportAudio, useSupportUnreadNotifications, type SupportNotificationPermission } from "./im-support-notifications";
import { groupPreferenceOf, readOrderGroupPreferences, storeOrderGroupPreferences, withGroupPreference, ORDER_GROUP_PREF_EVENT, ORDER_GROUP_SETTINGS_EVENT, type OrderGroupPreference, type OrderGroupPreferenceMap } from "./im-support-group-settings";
import { OrderWorkbenchPane } from "./im-support-orders";
import { orderStageTone } from "@zzsh/ui/order-team-panel";
import type { OrderTeamListItem } from "@zzsh/ui/order-team-panel";
import { ConsultationUserCard } from "./im-support-user-card";
import { EntityPreviewTrigger } from "../components/admin-preview";
import { ConsultationEventsCard } from "./im-support-events";
import "./im-support-details.css";
import { formatDuration } from "./im-support-management-model";
import { dayKeyOf, dayLabelOf, formatBytes, formatListTime, formatMonthDay, formatTime, initialOf } from "./im-support-format";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Bubble, BubbleContent } from "../components/ui/bubble";
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
  subjectRef: string | null;
  assignedAdmin: { id: string; name: string } | null;
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
  user?: { id: string; name: string; username: string | null };
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
  /** Raw channel message kept intact so reply/revoke/delete address the original. */
  source?: NimMessageLike;
  image?: { imageId: string; url?: string; name: string; mimeType: string; size: number };
  media?: NimMessageMedia;
};
type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };
type PresenceToday = { seconds: number; sessions: number; users: number };
type Presence = { adminUserId: string; availability: "OFF_DUTY" | "AVAILABLE" | "PAUSED"; connectionState: string; activeLoad: number; version: number; today?: PresenceToday };
type SupportSection = "consultation" | "orders";
type QueueRow = { id: string; type: SupportType; title: string; snippet: string; time: string; sortAt: number; state: "待接入" | "接待中" | "已结束" | "待核验"; unreadCount: number; consultation?: Consultation };
type UnifiedRow = {
  kind: "consultation" | "order";
  id: string;
  title: string;
  tag: string;
  tone: "warn" | "neutral";
  snippet: string;
  state: string;
  stateTone: "good" | "warn" | "neutral" | "attention" | "live" | "done" | "danger";
  /** 订单群的到期等次要事实，用 icon+短标签显示，不占时间列。 */
  meta?: string;
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
const SUPPORT_QUICK_REPLIES = [
  { label: "首次回复", text: "您好，很高兴为您服务，请问有什么可以帮您？" },
  { label: "核对账号", text: "您好，请提供需要处理的账号和验证码，我们马上为您核对。" },
  { label: "核验等待", text: "正在为您核实账号信息，请稍等片刻，处理好后第一时间回复您。" },
  { label: "核验完成", text: "账号已核验完成，请确认账号和密码无误；如有问题随时联系我们。" },
  { label: "结束说明", text: "如暂无其他问题，本次服务就先到这里，后续有问题随时发在这里。" },
] as const;
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
function scopeStateLabel(consultation: Consultation): QueueRow["state"] { return consultation.messageScopeState === "FAILED" ? "待核验" : stateLabel(consultation.state); }
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
  return state === "接待中" || state === "租用中" ? "good" : state === "待接入" || state === "待核验" || state === "已取消" ? "warn" : "neutral";
}
function connectionForPresence(state: NimWebConnectionState | "idle" | "error"): Presence["connectionState"] {
  return state === "idle" ? "DISCONNECTED" : state === "error" ? "AUTH_FAILED" : state;
}
function imageOf(message: NimMessageLike): SupportMessage["image"] | undefined {
  if (message.messageType !== 1 || !message.attachment || typeof message.attachment !== "object") return undefined;
  const attachment = message.attachment;
  const imageId = typeof attachment.imageId === "string" ? attachment.imageId : "";
  const url = typeof attachment.url === "string" ? attachment.url : typeof attachment.thumbUrl === "string" ? attachment.thumbUrl : undefined;
  return { imageId, url, name: typeof attachment.name === "string" ? attachment.name : "图片", mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "image/jpeg", size: typeof attachment.size === "number" ? attachment.size : 0 };
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
  const notice = decodeImSystemNotice(message);
  // A notification is never attributed to a human speaker, and unknown types
  // are not rendered as if the customer had written them.
  if (notice) return { ...base, from: "system", text: notice.text };
  const image = imageOf(message);
  // Only the client-validated media envelope becomes a media bubble.
  const media = mediaMessageOf(message);
  const text = typeof message.text === "string" && message.text.trim() ? message.text : image || media ? "" : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  // Only the mapped peer is a customer; a colleague staff message stays on the staff
  // side instead of borrowing the current assignee's name or the user's label.
  const from: SupportMessage["from"] = self || (peerAccountId ? message.senderId !== peerAccountId : false) ? "agent" : "customer";
  return { ...base, from, text, ...(image === undefined ? {} : { image }), ...(media === undefined ? {} : { media }) };
}
function oldestOf(messages: NimMessageLike[]): NimMessageLike | undefined {
  return messages.reduce<NimMessageLike | undefined>((oldest, item) => (!oldest || (item.createTime ?? 0) < (oldest.createTime ?? 0) ? item : oldest), undefined);
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
async function readImToken(): Promise<ImToken> {
  const value = await adminRequest<Record<string, unknown>>("/im/token");
  if (typeof value.appKey !== "string" || typeof value.accountId !== "string" || typeof value.token !== "string" || !value.appKey || !value.accountId || !value.token || (value.transport !== "nim" && value.transport !== "local-fake")) throw new Error("云信登录凭据格式无效");
  return { appKey: value.appKey, accountId: value.accountId, token: value.token, transport: value.transport };
}
async function readConsultations(): Promise<Consultation[]> {
  const value = await adminRequest<{ consultations?: unknown }>("/im/consultations?limit=50");
  if (!Array.isArray(value.consultations)) throw new Error("咨询队列格式无效");
  return value.consultations as Consultation[];
}

export function ImSupportView({ snapshot, initialSection = "consultation", initialConsultationId, initialOrderId, initialUnifiedType = "ALL", workspaceQuery = {}, onQueryChange, onRefresh, onOpenPath }: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialSection?: "consultation" | "orders";
  initialConsultationId?: string;
  initialOrderId?: string;
  initialUnifiedType?: "ALL" | "SERVICE" | "COMPLAINT" | "ORDER";
  workspaceQuery?: Record<string, string>;
  onQueryChange?: (query: Record<string, string>) => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onOpenPath?: (path: string, title?: string) => void;
}) {
  const [section, setSection] = useState<SupportSection>(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  // 工作台只渲染当前 Tab，切换会卸载本视图；把选中与筛选留在工作区 tab query，
  // 切回/刷新后按持久线程（或订单 id）恢复，而不是重新从空状态开始。
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
  const sendCapabilityKey = createSendCapabilityKey({ canAccept, canComplaint });

  const [queue, setQueue] = useState<Consultation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderQueue, setOrderQueue] = useState<OrderTeamListItem[]>([]);
  const [orderQueueLoaded, setOrderQueueLoaded] = useState(false);
  const [orderSelection, setOrderSelection] = useState<string | null>(null);
  const [groupPrefs, setGroupPrefs] = useState<OrderGroupPreferenceMap>(() => readOrderGroupPreferences(snapshot.adminUserId));
  const [unifiedOrderMenu, setUnifiedOrderMenu] = useState<{ x: number; y: number; orderId: string; preference: OrderGroupPreference; row: HTMLElement | null } | null>(null);
  const [unifiedQuery, setUnifiedQuery] = useState("");
  const [unifiedType, setUnifiedType] = useState<"ALL" | "SERVICE" | "COMPLAINT" | "ORDER">(initialUnifiedType);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  // Below this width a third column leaves the chat unusable, so the case column
// starts collapsed and the operator opens it deliberately.
  const [detailsOpen, setDetailsOpen] = useState(() => !(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width:1439px)").matches));
  const [mobilePane, setMobilePane] = useState<"queue" | "chat" | "details">("queue");
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"waiting" | "mine">("mine");
  const [blockedConsultations, setBlockedConsultations] = useState<Record<string, boolean>>({});
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">("idle");
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
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const [imageErrors, setImageErrors] = useState<Record<string, number>>({});
  // Message actions live per consultation, like drafts: quoting in A must never
  // leak a quote into B, and a late action receipt still belongs to A.
  const [messageMenu, setMessageMenu] = useState<{ key: string; id: string; x: number; y: number; row: HTMLElement | null } | null>(null);
  const [replyTargets, setReplyTargets] = useState<Record<string, SupportMessage | null>>({});
  const [replyUncertain, setReplyUncertain] = useState<Record<string, boolean>>({});
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferState, setTransferState] = useState<{ targets: { adminUserId: string; displayName: string }[]; transferReady: boolean } | null>(null);
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
  const availabilityRef = useRef<Presence["availability"]>("OFF_DUTY");
  const presenceVersionRef = useRef<number | null>(null);
  // 最近一次由服务端确认的 presence。写入失败时用它回退 availabilityRef，
  // 让 30s 心跳与连接事件只重放"已知成立"的状态，而不是重试失败的用户意图。
  const presenceRef = useRef<Presence>({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const presenceWriteRef = useRef(Promise.resolve());
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
  const selectedIdRef = useRef(selectedId);
  const sectionRef = useRef(section);
  const queueRef = useRef(queue);
  const historyAnchorRef = useRef<Record<string, NimMessageLike>>({});
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
    presenceRef.current = value;
    availabilityRef.current = value.availability;
    setPresence(value);
  }, []);

  const writePresence = useCallback((availability: Presence["availability"], state: ReturnType<typeof connectionForPresence>) => {
    const key = readClientKey;
    const generation = operatorGenerationRef.current;
    availabilityRef.current = availability;
    if (!canPresence || !canPresenceRef.current) return Promise.resolve<Presence | undefined>(undefined);
    const operation = presenceWriteRef.current.then(async () => {
      if (!canPresenceRef.current) return undefined;
      if (operatorRef.current !== key || operatorGenerationRef.current !== generation) return undefined;
      let version = presenceVersionRef.current;
      if (version === null) {
        // 本操作员本次会话的第一次写入：先向服务端要当前版本，再写。
        // 上一会话可能已留下 presence 行；此时省略 version 会让 PUT 必然 409，
        // 首屏就变成“未上线 + 一次失败”，而这不是并发冲突。
        try {
          const existing = await adminRequest<Presence>("/im/presence");
          rememberPresence(existing);
          version = presenceVersionRef.current;
        } catch {
          // 读不到就保持 null，让服务端按“无行则插入”的规则自行裁决。
        }
      }
      try {
        const value = await adminRequest<Presence>("/im/presence", { availability, connectionState: state, ...(version === null ? {} : { version }) }, "PUT");
        if (canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation) rememberPresence(value);
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

  // Identity/permission change: drop every private projection and every owned preview URL.
  useEffect(() => {
    clientRef.current = null;
    readyOperatorRef.current = null;
    setQueue([]);
    setQueueLoaded(false);
    setMessages({});
    setDrafts({});
    setSelectedId(null);
    setMessageMenu(null);
    setReplyTargets({});
    setReplyUncertain({});
    setHistoryMore({});
    setHistoryState({});
    markedReadSignaturesRef.current.clear();
    readInFlightRef.current.clear();
    setHistoryLoading(false);
    setFailedText({});
    textFlightRef.current.clear();
    setStaged({});
    setPending({});
    setViewer(null);
    imageFlights.current.clear();
    sendingRef.current = false;
    setSending(false);
    historyAnchorRef.current = {};
    const clearedPresence: Presence = { adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 };
    presenceRef.current = clearedPresence;
    setPresence(clearedPresence);
    presenceVersionRef.current = null;
    availabilityRef.current = "OFF_DUTY";
    setConnection("idle");
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
    if (!canRead || snapshot.session.locked) return;
    let cancelled = false;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const lifecycle = new ImClientLifecycle<NimWebClientLike>(async (context) => {
      const token = await readImToken();
      if (token.transport === "local-fake") return createLocalFakeNimWebClientFactory({ endpoint: "/api/bff/admin/im/messages", accountId: token.accountId, pollMs: 1_500 })(context);
      const factory = createNimWebClientFactory({
        appKey: token.appKey,
        accountId: token.accountId,
        messageAuthorization: async ({ conversationId, operation }) => {
          const value = await adminRequest<{ authorized?: unknown }>(messageAccessPath(conversationId, operation));
          if (value.authorized !== true) throw new Error("当前咨询未获授权");
        },
        tokenProvider: async (accountId) => {
          const refreshed = await readImToken();
          if (refreshed.accountId !== accountId || refreshed.accountId !== token.accountId) throw new Error("云信账号不匹配");
          return refreshed.token;
        },
      });
      return factory(context);
    });
    lifecycleRef.current = lifecycle;
    const run = async () => {
      try {
        setConnection("CONNECTING");
        const client = await lifecycle.open(snapshot.adminUserId);
        if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator) return;
        clientRef.current = client;
        readyOperatorRef.current = operator;
        setConnection(client.getConnectionState());
        const [presenceResult, queueResult] = await Promise.allSettled([
          canPresence ? adminRequest<Presence>("/im/presence") : Promise.resolve(undefined),
          readConsultations(),
        ]);
        if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
        if (presenceResult.status === "fulfilled" && presenceResult.value) rememberPresence(presenceResult.value);
        if (queueResult.status === "fulfilled") { setQueue(queueResult.value); setQueueLoaded(true); }
        else setNotice(friendlyError(queueResult.reason));
        if (canPresence) void writePresence(availabilityRef.current, connectionForPresence(client.getConnectionState()));
        client.onConnectionStateChange((state) => {
          if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
          setConnection(state);
          // 失败由 writePresence 统一转成可见提示，这里不再静默吞掉。
          if (canPresence) void writePresence(availabilityRef.current, connectionForPresence(state));
        });
        client.onMessages((incoming) => {
          if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
          for (const raw of incoming) {
            const next = messageFromNim(raw, client.accountId, queueRef.current.find((c) => c.conversationId === raw.conversationId)?.peerAccountId);
            const consultation = queueRef.current.find((candidate) => candidate.state === "ACTIVE" && candidate.assignedAdmin?.id === snapshot.adminUserId && candidate.conversationId === raw.conversationId);
            if (!next || !consultation) continue;
            setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], [next]) }));
            // 即时反馈：服务端计数仍是权威，下一次队列轮询会覆盖这个乐观增量。
            if (next.self !== true) setQueue((current) => current.map((item) => item.id === consultation.id
              ? { ...item, adminUnreadCount: Math.min((item.adminUnreadCount ?? 0) + 1, 999) }
              : item));
          }
        });
      } catch (cause) {
        if (!cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator) { setConnection("error"); setNotice(friendlyError(cause)); }
      }
    };
    void run();
    return () => {
      cancelled = true;
      clientRef.current = null;
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) readyOperatorRef.current = null;
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      void lifecycle.close();
      if (canPresence && generation === operatorGenerationRef.current && operatorRef.current === operator) void writePresence("OFF_DUTY", "DISCONNECTED").catch(() => undefined);
    };
  }, [canPresence, canRead, readClientKey, snapshot.adminUserId, snapshot.session.locked, writePresence]);

  useEffect(() => {
    if (!canRead || readyOperatorRef.current !== readClientKey) return;
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
  }, [canRead, connection, readClientKey]);

  // Unified inbox: order groups share the same left directory as consultations.
  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    let loading = false;
    const refreshOrders = () => {
      if (cancelled || loading) return;
      loading = true;
      void adminRequest<{ items?: OrderTeamListItem[] }>("/orders/im-groups?limit=50")
        .then((value) => { if (!cancelled) { setOrderQueue(Array.isArray(value.items) ? value.items : []); setOrderQueueLoaded(true); } })
        .catch(() => undefined)
        .finally(() => { loading = false; });
    };
    refreshOrders();
    const timer = window.setInterval(refreshOrders, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [canRead]);
  useEffect(() => {
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ snapshot?: OrderGroupPreferenceMap }>).detail;
      if (detail?.snapshot) setGroupPrefs(detail.snapshot);
    };
    window.addEventListener(ORDER_GROUP_PREF_EVENT, onSync);
    return () => window.removeEventListener(ORDER_GROUP_PREF_EVENT, onSync);
  }, []);

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
    const target = orderQueue.find((item) => item.id === initialOrderId);
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
      if (!orderQueueLoaded) return;
      if (restoreOrder()) return;
      restoredSelectionRef.current = true;
      return;
    }
    if (!queueLoaded) return;
    if (restoreConsultation()) return;
    restoredSelectionRef.current = true;
  }, [initialConsultationId, initialSection, orderQueueLoaded, queueLoaded, queue]);

  // 内部切换 section 时也可以回到该 section 上次选中的会话；用户新点一条则不会被覆盖。
  useEffect(() => {
    if (!restoredSelectionRef.current) return;
    if (section === "orders" && !orderSelection && initialOrderId) restoreOrder();
    else if (section === "consultation" && !selectedId && initialConsultationId) restoreConsultation();
  }, [section, orderSelection, selectedId, initialOrderId, initialConsultationId, orderQueue, queue]);

  useEffect(() => {
    if (!canPresence || readyOperatorRef.current !== readClientKey || connection !== "CONNECTED") return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const timer = window.setInterval(() => {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) void writePresence(availabilityRef.current, connectionForPresence(connection));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [canPresence, connection, readClientKey, writePresence]);

  // 接待心跳：只在页面可见且确实处于“可接待 + 可收发消息”时发送；失败不影响 UI。
  useEffect(() => {
    if (!canPresence || presence.availability !== "AVAILABLE" || connection !== "CONNECTED" || snapshot.session.locked) return;
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void adminRequest("/im/presence/heartbeat", {}, "POST").catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [canPresence, connection, presence.availability, snapshot.session.locked]);

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

  const selected = queue.find((item) => item.id === selectedId) ?? null;
  const selectedMessages = messages[selectedId ?? ""] ?? [];
  // 订单群未读按成员身份计数；只有该群聊真的在屏幕上时才清自己的未读。
  const selectedOrderRow = orderSelection ? orderQueue.find((item) => item.id === orderSelection) ?? null : null;
  useEffect(() => {
    if (section !== "orders" || !selectedOrderRow || (selectedOrderRow.unreadCount ?? 0) <= 0) return;
    const narrow = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
    if (narrow && mobilePane !== "chat") return;
    const signature = `${selectedOrderRow.id}:${selectedOrderRow.lastMessageAt ?? ""}:${selectedOrderRow.unreadCount}`;
    if (markedOrderReadRef.current.has(signature)) return;
    markedOrderReadRef.current.add(signature);
    void adminRequest(`/im/order-teams/${encodeURIComponent(selectedOrderRow.id)}/read`, {}, "POST")
      .then(() => setOrderQueue((current) => current.map((item) => item.id === selectedOrderRow.id ? { ...item, unreadCount: 0 } : item)))
      .catch(() => markedOrderReadRef.current.delete(signature));
  }, [section, selectedOrderRow, mobilePane]);
  const rowOfMessage = (target: EventTarget | null): HTMLElement | null => {
    const element = target as { closest?: (selector: string) => HTMLElement | null } | null;
    return element && typeof element.closest === "function" ? element.closest("[data-message-id]") : null;
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
    const history = messages[item.id];
    const last = history?.length ? history[history.length - 1] : undefined;
    const lastMessageAt = item.lastMessageAt ? Date.parse(item.lastMessageAt) : Number.NaN;
    // 后端 best-effort 写入的最近消息摘要；没有历史时用它，避免未打开的 ACTIVE 行只显示“打开查看”。
    const preview = item.lastMessagePreview?.trim() || null;
    // R1 重写时把这里的措辞缩短成了「待人工核验」，丢掉了「远端结果未知」这个
    // 关键差异（会读成普通待办）。恢复 HEAD 的完整措辞，队列行不得让 FAILED
    // 看起来像正常会话。
    const snippet = item.messageScopeState === "FAILED"
      ? "云信远端结果待人工核验，已暂停接待"
      : closeOutcomeUnknown[item.id]
        ? "结束结果未确认，待平台核对"
        : last
        ? `${last.from === "agent" ? (last.self ? "我：" : "客服：") : last.from === "system" ? "" : "用户："}${last.image ? "[图片]" : last.media ? mediaSummaryOf(last) ?? "[媒体]" : last.text || "[空消息]"}`
        : preview ? preview : item.state === "WAITING" ? "等待客服接待" : item.state === "CLOSED" ? "本轮已结束" : "打开查看消息";
    const sortAt = last?.createTime ?? (Number.isFinite(lastMessageAt) ? lastMessageAt : 0);
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
    mine: displayQueue.filter((row) => row.state === "接待中" || row.state === "待核验").length,
  }), [displayQueue]);
  const notificationRows = useMemo(() => displayQueue.map((row) => ({
    id: row.id,
    title: `${typeLabel(row.type)} · ${row.title}`,
    body: row.snippet,
    signature: `${row.consultation?.lastMessageAt ?? ""}|${row.snippet}`,
    unread: row.unreadCount > 0,
  })), [displayQueue]);
  const { unreadCount: notifyUnreadCount } = useSupportUnreadNotifications({
    adminUserId: snapshot.adminUserId,
    enabled: notifyEnabled && notifyPermission === "granted",
    loaded: queueLoaded,
    rows: notificationRows,
    selectedId,
    onOpen: (id) => {
      restoredSelectionRef.current = true;
      setSection("consultation");
      setSelectedId(id);
      setMobilePane("chat");
      const row = queue.find((item) => item.id === id);
      persistQuery({ section: "consultation", consultation: row?.threadId ?? id });
    },
  });
  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const text = unifiedQuery.trim().toLowerCase();
    const matches = (row: UnifiedRow) => (!text || `${row.title} ${row.snippet} ${row.tag} ${row.state}`.toLowerCase().includes(text));
    const consultations: UnifiedRow[] = displayQueue
      .filter((row) => unifiedType === "ALL" || (unifiedType !== "ORDER" && row.type === unifiedType))
      .map((row): UnifiedRow => ({
        kind: "consultation", id: row.id, title: row.title,
        tag: row.type === "COMPLAINT" ? "投诉" : "咨询",
        tone: row.type === "COMPLAINT" ? "warn" : "neutral",
        snippet: row.snippet, state: row.state, stateTone: stageToneOf(row.state),
        unreadCount: row.unreadCount, sortAt: row.sortAt, time: row.time,
      }))
      .filter(matches);
    const orders: UnifiedRow[] = (unifiedType === "ALL" || unifiedType === "ORDER" ? orderQueue : [])
      .filter((row) => !groupPreferenceOf(groupPrefs, row.id).hidden)
      .map((row): UnifiedRow => {
        const preference = groupPreferenceOf(groupPrefs, row.id);
        const state = stageLabelOf(row);
        // 没有消息的订单群用建群时间兜底，列表不留“—”这种无法排序的空时间。
        const sortAt = Date.parse(row.lastMessageAt ?? row.createdAt ?? "") || 0;
        return {
          kind: "order" as const,
          id: row.id,
          title: row.displayNo,
          tag: "",
          tone: "neutral" as const,
          snippet: typeof row.lastMessagePreview === "string" && row.lastMessagePreview.trim()
            ? row.lastMessagePreview.trim()
            : row.lastMessageAt ? "有新消息" : "暂无消息",
          state, stateTone: orderStageTone(row),
          // 到期只对正在租用/待结束的订单有意义；已完成的历史群不再占用列表宽度。
          meta: row.dueAt && (row.stage === "RENTING" || row.stage === "ENDING") ? `到期 ${formatMonthDay(row.dueAt)}` : undefined,
          unreadCount: Math.max(0, row.unreadCount ?? 0),
          sortAt,
          time: sortAt ? formatListTime(sortAt) : "—",
          pinned: preference.pinned,
          muted: preference.muted,
        };
      })
      .filter(matches);
    // 置顶优先，其余一律按最后一条消息倒序；咨询与订单群在同一条时间轴上。
    return [...consultations, ...orders].sort((a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.sortAt - a.sortAt);
  }, [displayQueue, groupPrefs, orderQueue, unifiedQuery, unifiedType]);
  const applyGroupPreference = (orderId: string, patch: Partial<OrderGroupPreference>) => {
    const next = withGroupPreference(groupPrefs, orderId, patch);
    setGroupPrefs(next);
    storeOrderGroupPreferences(snapshot.adminUserId, next);
    window.dispatchEvent(new CustomEvent(ORDER_GROUP_PREF_EVENT, { detail: { orderId, patch } }));
  };
  const unifiedTotal = displayQueue.length + orderQueue.filter((row) => !groupPreferenceOf(groupPrefs, row.id).hidden).length;
  const hiddenOrderCount = orderQueue.filter((row) => groupPreferenceOf(groupPrefs, row.id).hidden).length;
  const restoreHiddenOrders = () => {
    const next: OrderGroupPreferenceMap = {};
    for (const [orderId, preference] of Object.entries(groupPrefs)) next[orderId] = { ...preference, hidden: false };
    setGroupPrefs(next);
    storeOrderGroupPreferences(snapshot.adminUserId, next);
    for (const [orderId, preference] of Object.entries(groupPrefs)) {
      if (preference.hidden) window.dispatchEvent(new CustomEvent(ORDER_GROUP_PREF_EVENT, { detail: { orderId, patch: { hidden: false } } }));
    }
  };
  const handleUnifiedOrderMenuAction = (action: MessageActionId) => {
    const menu = unifiedOrderMenu;
    setUnifiedOrderMenu(null);
    if (!menu) return;
    if (action === "pin") { applyGroupPreference(menu.orderId, { pinned: !menu.preference.pinned }); return; }
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
      const inFilter = filter === "waiting" ? row.state === "待接入" : row.state === "接待中" || row.state === "待核验";
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
  const replySummaryOf = (message: SupportMessage): string => message.image ? "[图片]" : mediaSummaryOf(message) ?? (message.text.trim() ? message.text.trim().slice(0, 120) : "消息");
  const copyableTextOf = (message: SupportMessage): string | null => !message.revoked && message.from !== "system" && !message.image && !message.media
    && (message.messageType === undefined || message.messageType === 0) && message.text.trim() ? message.text : null;
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
      setNotice(status === 409 ? "已超过可撤回时间" : status === 403 ? "无权撤回此消息" : "撤回失败，请重试");
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
      setNotice(httpStatus(cause) === 403 ? "无权删除此消息" : "删除失败，消息仍保留");
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
    void client.getMessageHistory(consultation.conversationId!, 50).then((history) => {
      if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client || selectedIdRef.current !== consultation.id) return;
      const rows = history.map((item) => messageFromNim(item, client.accountId, consultation.peerAccountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], rows) }));
      const oldest = oldestOf(history);
      if (oldest) historyAnchorRef.current[consultation.id] = oldest;
      setHistoryMore((current) => ({ ...current, [consultation.id]: history.length === 50 }));
      setHistoryState((current) => ({ ...current, [consultation.id]: "ready" }));
    }).catch((cause) => {
      if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || selectedIdRef.current !== consultation.id) return;
      // A failed read is not an empty conversation, and already-loaded rows stay.
      setHistoryState((current) => ({ ...current, [consultation.id]: httpStatus(cause) === 403 ? "forbidden" : "error" }));
    });
    return () => { cancelled = true; };
  }, [canRead, connection, readClientKey, selected?.conversationId, selected?.id, historyRetryToken]);

  // 负责客服打开 ACTIVE 轮次且历史已成功加载后上报平台已读；新消息改变历史版本时再次推进。
  // 非负责、非 ACTIVE、历史失败或会话不在前台都不发。失败静默，已读只能来自服务端。
  const selectedReadSignature = selected ? `${selectedMessages.length}:${selectedMessages.at(-1)?.id ?? ""}` : "";
  useEffect(() => {
    if (!canRead || section !== "consultation" || !selected || !selectedMessages.length) return;
    if (selected.state !== "ACTIVE" || selected.assignedAdmin?.id !== snapshot.adminUserId) return;
    if (historyState[selected.id] !== "ready") return;
    // 窄屏三栏互斥：队列/详情在前台时，聊天并没有被看到。
    if (typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 760px)").matches && mobilePane !== "chat") return;
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
  }, [canRead, section, mobilePane, snapshot.adminUserId, selected?.id, selected?.state, selected?.roundId, selected?.assignedAdmin?.id, historyState[selected?.id ?? ""], selectedReadSignature]);

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
      const older = await client.getMessageHistory(consultation.conversationId!, 50, anchor);
      if (generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client || selectedIdRef.current !== consultation.id) return;
      const rows = older.map((item) => messageFromNim(item, client.accountId, consultation.peerAccountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], rows) }));
      const oldest = oldestOf(older);
      if (oldest) historyAnchorRef.current[consultation.id] = oldest;
      setHistoryMore((current) => ({ ...current, [consultation.id]: older.length === 50 }));
    } catch {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice("更早的消息读取失败，请重试。");
    } finally {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) setHistoryLoading(false);
    }
  };

  const claim = async (afterReception = false) => {
    if (!canManageSupport) { setNotice("当前会话由系统自动分配；需要人工接管请联系管理岗。"); return; }
    if (!selected || selected.state !== "WAITING" || !canOperateSupportType(selected.type, canAccept, canComplaint)) return;
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
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/claim`, {}, "POST");
      const current = currentRequestKey();
      if (!current || !isCurrentImRequest(requestKey, current) || selectedIdRef.current !== consultationId) return;
      setQueue((current) => current.map((item) => item.id === result.consultation.id ? result.consultation : item));
      setNotice("已接入，正在建立会话");
    } catch (cause) {
      const current = currentRequestKey();
      if (current && isCurrentImRequest(requestKey, current)) {
        setNotice(httpStatus(cause) === 503 ? "会话暂时无法接入：云信群或接待状态尚未就绪，请刷新后重试。" : friendlyError(cause));
      }
    } finally { endBusy(busyOwner); }
  };
  const startReceptionAndClaim = async () => {
    const started = await applyPresence("AVAILABLE");
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
      setNotice("本轮已结束，聊天记录保留；用户再次咨询会在同一会话开启新一轮。");
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
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/reconcile`, {}, "POST");
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
      const targets = Array.isArray(value.targets) ? value.targets.filter((target): target is { adminUserId: string; displayName: string } => Boolean(target) && typeof target === "object" && typeof (target as { adminUserId?: unknown }).adminUserId === "string" && typeof (target as { displayName?: unknown }).displayName === "string") : [];
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
  const applyPresence = async (availability: Presence["availability"]): Promise<boolean> => {
    if (!canPresence) return false;
    const busyOwner = beginBusy();
    setNotice(undefined);
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try { await writePresence(availability, connectionForPresence(connection)); return availabilityRef.current === availability; }
    catch (cause) { if (canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(friendlyError(cause)); return false; }
    finally { endBusy(busyOwner); }
  };
  const togglePresence = async () => {
    if (!canPresence) return;
    const next = presence.availability === "AVAILABLE" ? "OFF_DUTY" : "AVAILABLE";
    // 暂停/下线前把未完成会话摆出来；用户可以继续暂停，也可以逐条去交接，不强制阻断。
    if (next === "OFF_DUTY" && myOpenConsultations.length) { setNotice(undefined); setOffDutyOpen(true); return; }
    await applyPresence(next);
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
      if (cause instanceof NimMediaSendError && cause.kind === "UNSUPPORTED") setNotice("当前云信通道暂不支持发送视频或文件，未发送。");
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
          // 真实通道下客服正文由 NIM 直连发出，服务端不会自动得知。补一条只登记预览的上报，
          // 否则会话摘要会一直停在上一条用户消息（T5）。失败不影响已发出的消息。
          if ((client as { transport?: string }).transport !== "local-fake") {
            void fetch("/api/bff/admin/im/messages", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ conversationId, text }),
            }).catch(() => undefined);
          }
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
          setNotice(mediaError?.kind === "UNSUPPORTED" ? "当前云信通道暂不支持发送视频或文件，未发送。" : mediaError?.kind === "UNKNOWN" ? "视频/文件结果未确认，原文件已保留" : cause instanceof Error ? cause.message : "视频/文件发送失败，可重试。");
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

  useEffect(() => {
    if (!viewer) return;
    const dialog = document.querySelector<HTMLDialogElement>(".im-wb-lightbox");
    dialog?.showModal();
    return () => dialog?.close();
  }, [viewer]);

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
    if (message.self) return { name: operatorName, role: "平台客服" };
    if (selected?.peerAccountId && message.senderId === selected.peerAccountId) return { name: selected.user?.name || selected.user?.username || "平台用户", role: "平台用户" };
    // Historical senders we cannot map stay neutral instead of borrowing the
    // current assignee's identity.
    if (message.from === "agent" && selected?.botAccountId && message.senderId === selected.botAccountId) return { name: "洲洲助手（Bot）", role: "机器人" };
    return message.from === "agent" ? { name: "客服", role: "平台客服" } : { name: selected?.user?.name || selected?.user?.username || "平台用户", role: "平台用户" };
  };
  const userHoverCard = selected ? <div className="im-wb-author-hover">
    <ConsultationUserCard consultationId={selected.id} rowUserId={selected.user?.id ?? ""} fallbackName={selected.user?.name || selected.user?.username || "平台用户"}
      request={adminRequest} scope={profileScope} showSubject={selected.type !== "COMPLAINT"}
      onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")}
          onOpenSubject={(target, label) => onOpenPath?.(target.kind === "ORDER" ? `/orders/${encodeURIComponent(target.id)}` : `/supply/accounts/${encodeURIComponent(target.id)}`, label)} />
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
  const timelineItems = selectedMessages.map((message, index) => {
    const nodes = [];
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      timelineDay = dayKey;
      nodes.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><Marker className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
    }
    if (message.from === "system") {
      nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} tabIndex={-1} onContextMenu={onMessageContextMenu} {...messageLongPress}><Marker className="im-wb-sys" variant="separator"><MarkerContent>{message.text}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
      return nodes;
    }
    const previous = selectedMessages[index - 1];
    const grouped = Boolean(previous && previous.from !== "system" && previous.senderId === message.senderId && (message.createTime ?? 0) - (previous.createTime ?? 0) < GROUP_WINDOW_MS);
    const author = authorFor(message);
    const imageUrl = message.image ? supportedImageUrl(message.image.url) : null;
    const mine = message.self === true;
    nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"} tabIndex={-1} onContextMenu={onMessageContextMenu} {...messageLongPress}>
      <Message align={mine ? "end" : "start"} className="im-wb-msg" data-message-id={message.id} data-from={message.from} data-self={mine} data-grouped={grouped}>
        {author.role === "平台用户" && userHoverCard ? <EntityPreviewTrigger enableTouchButton={false} side="right" align="start" touchLabel={`预览用户 ${author.name}`} className="im-wb-author-preview"
          trigger={<button type="button" className="im-wb-av-button" aria-label={`查看用户 ${author.name}`} title={`查看用户 ${author.name}`}><MessageAvatar className="im-wb-av" aria-hidden="true">{initialOf(author.name)}</MessageAvatar></button>}
          content={userHoverCard} /> : <MessageAvatar className="im-wb-av" aria-hidden="true">{author.role === "机器人" ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : initialOf(author.name)}</MessageAvatar>}
        <MessageContent className="im-wb-msg-body">
          {grouped ? null : <MessageHeader className="im-wb-msg-meta">{author.role === "平台用户" && userHoverCard
            ? <EntityPreviewTrigger enableTouchButton={false} side="right" align="start" touchLabel={`预览用户 ${author.name}`} className="im-wb-author-preview"
                trigger={<button type="button" className="im-wb-author-name-trigger"><b>{author.name}</b></button>} content={userHoverCard} />
            : <b>{author.name}</b>}<span className="im-wb-role-tag" data-role={author.role}>{author.role}</span>{mine ? null : <time>{message.time}</time>}</MessageHeader>}
          <Bubble align={mine ? "end" : "start"} variant={mine ? "default" : "secondary"}>
            <BubbleContent className="im-wb-bub" data-revoked={message.revoked ? "true" : undefined}>
              {message.revoked ? "消息已撤回" : <>
                {message.media ? <MediaMessage media={message.media} /> : message.image ? (imageUrl
                  ? (imageErrors[message.id]
                    ? <button type="button" className="im-wb-thumb im-wb-thumb-failed" data-action="retry-image" onClick={() => setImageErrors((current) => { const next = { ...current }; delete next[message.id]; return next; })} aria-label={`重新加载图片 ${message.image.name}`} title={`重新加载图片 ${message.image.name}`}>图片加载失败 · 点击重试</button>
                    : <button type="button" className="im-wb-thumb" onClick={() => setViewer({ url: imageUrl, name: message.image!.name })} aria-label={`查看图片 ${message.image.name}`} title={`查看图片 ${message.image.name}`}><img key={imageErrors[message.id] ?? imageUrl} src={imageUrl} alt={message.image.name} loading="lazy" onError={() => setImageErrors((current) => ({ ...current, [message.id]: Date.now() }))} /></button>)
                  : <span className="im-wb-thumb-missing">图片暂不可预览</span>) : message.text}
                {message.source?.reply ? <MessageQuoted text={message.source.reply.text ?? "消息"} senderName={(() => { const target = selectedMessages.find((item) => item.id === message.source!.reply!.messageId || item.source?.messageServerId === message.source!.reply!.messageId || item.source?.messageClientId === message.source!.reply!.messageId); return target ? authorFor(target).name : null; })()} onJump={() => jumpToMessage(message.source!.reply!.messageId)} /> : null}
              </>}
            </BubbleContent>
          </Bubble>
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
          <span className="im-wb-row-av" aria-hidden="true">{initialOf(row.title)}</span>
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
        <span className="im-wb-chat-av" aria-hidden="true">{initialOf(selected?.user?.name || selected?.user?.username || "客")}</span>
        <div className="im-wb-chat-title">
          <h2>{selected ? `${selected.user?.name || selected.user?.username || "平台用户"} · ${typeLabel(selected.type)}` : "选择一条会话"}</h2>
          <span className="im-wb-chat-sub">{!selected ? "等待用户咨询" : roundHeadlineOf(selected)}</span>
        </div>
        <div className="im-wb-chat-actions">
          {claimReady && canManageSupport ? <button type="button" className="im-wb-btn im-wb-btn-outline" data-action="claim-consultation" title="自动分配异常时由管理岗接管" onClick={() => void claim()} disabled={busy || connection !== "CONNECTED"}>接管会话</button> : null}
          {claimReady && !canManageSupport ? <span className="im-wb-state">系统分配中…</span> : null}
          {selected && isMine && selected.messageScopeState !== "FAILED" ? <button ref={closeTriggerRef} type="button" data-action="close-consultation" className="im-wb-btn im-wb-btn-outline" title={!serverCanSend && canOperateSelected ? "本轮尚未就绪，暂不可结束" : undefined} onClick={() => { if (!canOperateSelected || !serverCanSend || closeOutcomeUnknown[selected.id]) return; setCloseTarget(selected); setCloseOpen(true); }} disabled={busy || !canOperateSelected || !serverCanSend || Boolean(closeOutcomeUnknown[selected.id]) || Boolean(blockedConsultations[selected.id])}>{!canOperateSelected ? "无本类型接待权限" : closeOutcomeUnknown[selected.id] ? "结束结果未确认" : "结束本轮"}</button> : null}
          <button ref={transferTriggerRef} type="button" data-action="open-transfer" className="im-wb-btn im-wb-btn-outline" onClick={() => void openTransfer()} disabled={!canTransfer || !selected || selected.state !== "ACTIVE" || !isMine || selected.messageScopeState !== "READY" || busy}>{canTransfer ? "转交" : "无转交权限"}</button>
          <button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-outline im-wb-btn-icon" aria-label={detailsOpen ? "收起会话详情" : "展开会话详情"} title={detailsOpen ? "收起会话详情" : "展开会话详情"} aria-expanded={detailsOpen} aria-controls="im-wb-details" data-action="toggle-details" onClick={() => { const narrow=typeof window!=="undefined"&&window.matchMedia("(max-width: 760px)").matches; if(narrow&&mobilePane!=="details"){openDetails();return;} if (detailsOpen) closeDetails(); else openDetails(); }}><MoreHorizontal size={15} /></button>
        </div>
      </header>
      {readOnlyReason ? <p className="im-wb-scope-note" data-tone="readonly" data-action="support-readonly" role="status"><ShieldCheck size={13} />{readOnlyReason}</p> : null}
      {notice ? <p className="im-wb-notice" role="status"><CircleAlert size={14} />{notice}</p> : null}
      {selected && closeOutcomeUnknown[selected.id] ? <p className="im-wb-notice" data-tone="warn" role="status"><CircleAlert size={14} />{CLOSE_OUTCOME_UNKNOWN_NOTICE}</p> : null}
      <div className="im-wb-stream-wrap">
        {selected?.messageScopeState === "FAILED" ? <div className="im-wb-empty"><CircleAlert size={22} /><strong>会话待人工核验</strong><span>请先完成核验再回复。</span>{selected.assignedAdmin?.id === snapshot.adminUserId && canTransfer ? <button type="button" className="im-wb-btn" data-action="reconcile-consultation" onClick={() => void reconcile()} disabled={busy}>核验并恢复</button> : null}</div>
          : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor">
            <MessageScrollerPrimitive.Root className="im-wb-scroller">
              <MessageScrollerPrimitive.Viewport className="im-wb-viewport" aria-label="会话消息" onContextMenu={onMessageContextMenu}><MessageScrollerPrimitive.Content className="im-wb-content">
                {selectedMessages.length ? <>
                  {selected && historyMore[selected.id] ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="im-wb-history-more"><button type="button" onClick={() => void loadEarlier()} disabled={historyLoading}>{historyLoading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}
                  {timelineItems}
                </> : <MessageScrollerPrimitive.Item messageId="empty">{emptyStreamState(selected ? historyState[selected.id] : undefined, Boolean(selected))}</MessageScrollerPrimitive.Item>}
              </MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport>
              <MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" title="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>
            </MessageScrollerPrimitive.Root>
          </MessageScrollerPrimitive.Provider>}
      </div>
      {selectedFailedText ? <p className="im-wb-pending" role="status"><CircleAlert size={13} />发送结果未确认，草稿已保留。<button type="button" data-action="retry-text" onClick={() => void retryFailedText(selected!.id)} disabled={busy || !canSend}>{selectedFailedText.messageClientId ? "原消息重试" : "刷新历史核对"}</button></p> : null}
      {selectedPending ? <div className="im-wb-draft" data-state={selectedPending.state}>
        <img src={selectedPending.previewUrl} alt={selectedPending.name} />
        <span>{selectedPending.name} · {formatBytes(selectedPending.size)} · {selectedPending.state === "SENDING" ? `上传中 ${selectedPending.progress}%` : selectedPending.state === "UNKNOWN" ? "结果未确认" : "发送失败"}</span>
        <button type="button" onClick={() => void retryPendingImage()} disabled={sending || imageInFlight || !canSend}>{selectedPending.messageClientId ? "原消息重试" : "重试"}</button>
        <button type="button" onClick={removePending} disabled={sendBlocked || !canSend || selectedPending.state === "UNKNOWN"} title={selectedPending.state === "UNKNOWN" ? "结果未确认时不可移除原图片" : undefined}>移除</button>
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
            placeholder={!selected ? "从左侧选择会话" : selected.state === "WAITING" ? "接入会话后可回复" : selected.state === "ACTIVE" && !isMine ? readOnlyPlaceholder ?? "仅负责客服可发送消息" : selected.messageScopeState === "FAILED" ? "云信会话待人工核验，暂不可回复" : connection !== "CONNECTED" ? "云信通道未连接，草稿会保留" : "输入回复…"}
            disabled={!canEdit} />
          <InputGroupAddon align="block-end" className="im-wb-composer-tools">
            <TooltipProvider delay={200}>
              <Popover open={quickReplyOpen} onOpenChange={setQuickReplyOpen}>
                <PopoverTrigger render={<button type="button" className="im-wb-tool" data-action="quick-replies" aria-label="常用语" title="常用语" disabled={!canEdit || sendBlocked} />}><MessageSquareText size={15} /></PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-auto p-0">
                  <div className="im-wb-quick-replies" role="group" aria-label="常用语">
                    {SUPPORT_QUICK_REPLIES.map((item) => <button key={item.label} type="button" data-action="insert-quick-reply" onClick={() => insertQuickReply(item.text)}>
                      <strong>{item.label}</strong><span>{item.text}</span>
                    </button>)}
                  </div>
                </PopoverContent>
              </Popover>
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger render={<button type="button" className="im-wb-tool" aria-label="表情" title="表情" disabled={!canEdit || sendBlocked} />}><Smile size={15} /></PopoverTrigger>
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
          request={adminRequest} scope={profileScope} showSubject
          onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")}
          onOpenSubject={(target, label) => onOpenPath?.(target.kind === "ORDER" ? `/orders/${encodeURIComponent(target.id)}` : `/supply/accounts/${encodeURIComponent(target.id)}`, label)} />
        <ConsultationEventsCard key={`${selected.id}:events`} consultationId={selected.id} request={adminRequest} />

        {blockedConsultations[selected.id] ? <section className="im-wb-sec"><span>授权状态</span><small>发送权限已失效</small>
          <button type="button" className="im-wb-btn" data-action="refresh-consultation-access" onClick={() => void refreshConsultationAccess()} disabled={busy || !selected.conversationId}>重新确认当前授权</button></section> : null}
      </>}
    </aside>
  </div>;

  return <div className="im-wb-root" data-unified="true">
    <nav className="im-wb-bar" aria-label="沟通类型">
      <div className="im-wb-bar-title"><strong>客服工作台</strong><span>咨询与订单群按最近消息排序</span></div>
      <div className="im-wb-seg" role="group">
        <button type="button" aria-pressed={section === "consultation"} onClick={() => { setSection("consultation"); persistQuery({ section: "consultation" }); }}>咨询与投诉<b>{displayQueue.length}</b></button>
        <button type="button" aria-pressed={section === "orders"} onClick={() => { setSection("orders"); persistQuery({ section: "orders" }); }}>订单沟通</button>
      </div>
      <span className="im-wb-spacer" />
      <div className="im-wb-runtime">
        <button type="button" className="im-wb-btn im-wb-btn-icon im-wb-notify" data-action="toggle-notifications"
          data-state={notifyPermission === "denied" ? "denied" : notifyEnabled && notifyPermission === "granted" ? "on" : "prompt"}
          aria-label={notifyEnabled && notifyPermission === "granted" ? "关闭消息提醒" : "开启消息提醒"}
          title={notifyPermission === "denied" ? "浏览器已屏蔽通知，请在站点设置中允许" : notifyEnabled && notifyPermission === "granted" ? "消息提醒已开启（需保持标签页打开）" : "开启浏览器通知与提示音"}
          onClick={() => void toggleNotifications()}>
          {notifyPermission === "denied" || notifyPermission === "unsupported" ? <BellOff size={15} /> : <Bell size={15} />}
          {notifyUnreadCount > 0 ? <b className="im-wb-notify-count" aria-label={`${notifyUnreadCount} 条未读`}>{notifyUnreadCount > 99 ? "99+" : notifyUnreadCount}</b> : null}
        </button>
        <span className="im-wb-runtime-divider" aria-hidden="true" />
        {canPresence ? <>
          <span className="im-wb-state im-wb-runtime-state" data-tone={presence.availability === "AVAILABLE" ? "good" : "neutral"}><i className={presence.availability === "AVAILABLE" ? "on" : ""} />{presence.availability === "AVAILABLE" ? "可接待" : presence.availability === "PAUSED" ? "已暂停" : "未上线"}</span>
          <span className="im-wb-runtime-divider" aria-hidden="true" />
          <span className="im-wb-state im-wb-today" data-action="today-duty" title="今日接待时长（仅统计可接待且可收发消息的时间）">今日接待 <b>{formatDuration(presence.today?.seconds)}</b></span>
          <button type="button" className="im-wb-btn im-wb-btn-outline im-wb-presence-toggle im-wb-runtime-action" data-action="toggle-presence" onClick={() => void togglePresence()} disabled={busy || connection !== "CONNECTED"} title={connection !== "CONNECTED" ? "消息服务异常，暂不可接待" : undefined}>{presence.availability === "AVAILABLE" ? "暂停接待" : "开始接待"}</button>
        </> : <span className="im-wb-state">无在线状态权限</span>}
        {connection !== "CONNECTED" ? <>
          <span className="im-wb-runtime-divider" aria-hidden="true" />
          <span className="im-wb-state im-wb-runtime-warning" data-tone="warn"><i />消息服务异常</span>
        </> : null}
      </div>
      {clientRef.current?.transport === "local-fake" ? <span className="im-wb-state im-wb-local">本地测试</span> : null}
    </nav>
    <div className="im-wb-unified">
      <aside className="im-wb-unified-queue" aria-label="全部会话" onContextMenu={(event) => { const rowEl = (event.target as Element).closest(".im-wb-row") as HTMLElement | null; event.preventDefault(); if (!rowEl || rowEl.dataset.unifiedKind !== "order") { setUnifiedOrderMenu(null); return; } event.stopPropagation(); const orderId = rowEl.dataset.orderId; if (!orderId) return; setUnifiedOrderMenu({ x: event.clientX, y: event.clientY, orderId, preference: groupPreferenceOf(groupPrefs, orderId), row: rowEl }); }}>
        <div className="im-wb-unified-head"><strong>全部会话</strong><span>{unifiedRows.length < unifiedTotal ? `${unifiedRows.length} / ${unifiedTotal}` : unifiedTotal}</span></div>
        <label className="im-wb-search"><Search size={13} /><input value={unifiedQuery} onChange={(event) => setUnifiedQuery(event.target.value)} placeholder="搜索用户、订单号或内容" aria-label="搜索全部会话" /></label>
        <div className="im-wb-unified-types" role="group" aria-label="会话类型">
          {([["ALL", "全部"], ["SERVICE", "咨询"], ["COMPLAINT", "投诉"], ["ORDER", "订单群"]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={unifiedType === value} onClick={() => { setUnifiedType(value); persistQuery({ type: value === "ALL" ? null : value }); }}>{label}</button>)}
        </div>
        <div className="im-wb-rows">
          {unifiedRows.length ? unifiedRows.map((row) => {
            const active = row.kind === "consultation" ? section === "consultation" && selectedId === row.id : section === "orders" && orderSelection === row.id;
            return <button type="button" key={`${row.kind}:${row.id}`} className="im-wb-row" data-unified-kind={row.kind} data-order-id={row.kind === "order" ? row.id : undefined} data-active={active} aria-current={active ? "page" : undefined}
              onContextMenu={row.kind === "order" ? (event) => { event.preventDefault(); event.stopPropagation(); setUnifiedOrderMenu({ x: event.clientX, y: event.clientY, orderId: row.id, preference: groupPreferenceOf(groupPrefs, row.id), row: event.currentTarget }); } : undefined}
              onClick={() => {
                restoredSelectionRef.current = true;
                if (row.kind === "consultation") {
                  setSection("consultation");
                  setSelectedId(row.id);
                  const target = queue.find((item) => item.id === row.id);
                  persistQuery({ section: "consultation", consultation: target?.threadId ?? row.id });
                } else {
                  setSection("orders");
                  setOrderSelection(row.id);
                  persistQuery({ section: "orders", order: row.id });
                }
                setMobilePane("chat");
              }}>
              <span className="im-wb-row-av" data-kind={row.kind} aria-hidden="true">{row.kind === "order" ? <ReceiptText size={17} /> : initialOf(row.title)}</span>
              <span className="im-wb-row-copy">
                <span className="im-wb-row-top">
                  <b>{row.title}</b>
                  {row.tag ? <i className="im-wb-tag" data-tone={row.tone}>{row.tag}</i> : null}
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
          }) : <div className="im-wb-list-empty"><strong>暂无会话</strong><span>新的咨询、投诉和订单群会出现在这里。</span></div>}
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
          client={clientRef.current} connection={connection} active={section === "orders"} sendAllowed={canAccept} selectedOrderId={orderSelection}
          canManualClose={snapshot.security.isBoss || snapshot.permissions.includes("order.settlement.write")} request={adminRequest} onAuthError={() => { void onRefresh(); }}
          onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")} /></div> : null}
      </div>
    </div>
    <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
      <DialogContent className="im-wb-dialog" aria-label="转交会话" showCloseButton={false} finalFocus={transferTriggerRef}>
        <div className="im-wb-dialog-head"><div><strong>转交会话</strong><span>{selected?.user?.name || "当前咨询"}</span></div><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setTransferOpen(false)} aria-label="关闭转交" title="关闭转交"><X size={14} /></button></div>
        <label className="im-wb-dialog-note"><span>交接备注（可选，≤200 字）<em>{transferNote.length}/200</em></span>
          <Textarea value={transferNote} maxLength={200} rows={2} aria-label="交接备注（可选）" placeholder="说明交接原因或注意事项" disabled={transferBusy} onChange={(event) => setTransferNote(event.target.value)} /></label>
        {transferError ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{transferError}</p>
          : transferState === null ? <p className="im-wb-dialog-empty">正在读取可转交客服…</p>
          : !transferState.transferReady ? <p className="im-wb-dialog-empty">会话尚未就绪，暂不可转交</p>
          : !transferState.targets.length ? <p className="im-wb-dialog-empty">暂无可转交的客服。这里只显示当前在线且可接待的其他客服；投诉会话还会排除无权处理或已被排除的客服。</p>
          : <div className="im-wb-dialog-list">{transferState.targets.map((target) => <button key={target.adminUserId} type="button" disabled={transferBusy} onClick={() => void confirmTransfer(target.adminUserId)}><span>{target.displayName}</span><small>可接待客服</small></button>)}</div>}
        <p className="im-wb-dialog-hint">转交后原会话与历史保留；填写的备注会写入交接记录</p>
      </DialogContent>
    </Dialog>
    {/* 暂停/下线前的未完成会话清单：只提示与提供交接入口，不阻断暂停。 */}
    <Dialog open={offDutyOpen} onOpenChange={setOffDutyOpen}>
      <DialogContent className="im-wb-dialog" aria-label="暂停接待确认" showCloseButton={false}>
        <div className="im-wb-dialog-head"><div><strong>暂停接待</strong><span>还有 {myOpenConsultations.length} 条未完成咨询</span></div>
          <button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setOffDutyOpen(false)} aria-label="关闭暂停确认" title="关闭暂停确认"><X size={14} /></button></div>
        <p className="im-wb-dialog-hint">暂停后不再接新会话，已有会话不会自动结束；你可以先逐条交接，也可以直接暂停。</p>
        <ul className="im-wb-offduty-list" aria-label="未完成咨询">
          {myOpenConsultations.map((item) => <li key={item.id} data-consultation-id={item.id}>
            <div><strong>{item.user?.name || item.user?.username || "平台用户"}</strong><span>{typeLabel(item.type)} · {scopeStateLabel(item)}</span></div>
            <button type="button" className="im-wb-btn" data-action="offduty-transfer" disabled={!canTransfer || item.messageScopeState !== "READY" || busy}
              title={!canTransfer ? "无转交权限" : item.messageScopeState !== "READY" ? "会话尚未就绪，暂不可转交" : undefined}
              onClick={() => goTransferFromChecklist(item.id)}>去交接</button>
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
          <button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setReceptionOpen(false)} aria-label="关闭接待提醒" title="关闭接待提醒"><X size={14} /></button></div>
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
        <div className="im-wb-dialog-head"><div><strong>结束本轮</strong><span>{closeTarget ? `${typeLabel(closeTarget.type)} · ${roundTagOf(closeTarget)}${roundTagOf(closeTarget) ? " · " : ""}${closeTarget.user?.name || closeTarget.user?.username || "平台用户"}` : "当前轮次"}</span></div><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setCloseOpen(false)} aria-label="关闭结束本轮确认" title="关闭结束本轮确认"><X size={14} /></button></div>
        {closeTarget ? <dl className="im-wb-confirm">
          <div><dt>{closeTarget.type === "COMPLAINT" ? "本轮处理" : "本轮接待"}</dt><dd>{closeTarget.assignedAdmin?.name || "尚未分配"}</dd></div>
          <div><dt>关联对象</dt><dd>{closeTarget.subjectRef || "未关联商品或订单"}</dd></div>
        </dl> : null}
        <p className="im-wb-dialog-hint">结束后只结束当前这一轮接待：客服状态恢复为空闲，聊天记录保留在同一会话，用户再次咨询会开启新一轮并重新匹配客服。本轮结束不可撤销，平台当前没有恢复本轮接待的入口。</p>
        <div className="im-wb-dialog-actions">
          <button type="button" className="im-wb-btn" onClick={() => setCloseOpen(false)}>取消</button>
          <button type="button" className="im-wb-btn im-wb-btn-danger" data-action="confirm-close-consultation" onClick={() => { if (closeTarget) void close(closeTarget.id); }} disabled={busy || !closeTarget || !canOperateSelected || !closeTarget.canSend}>确认结束本轮</button>
        </div>
      </DialogContent>
    </Dialog>
    {viewer ? <dialog className="im-wb-lightbox" aria-label="图片预览" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setViewer(null); } }} onCancel={(event) => { event.preventDefault(); setViewer(null); }}>
      <button type="button" onClick={() => setViewer(null)} autoFocus>关闭图片</button><img src={viewer.url} alt={viewer.name} /></dialog> : null}
    {messageMenu && menuMessage ? <MessageActionMenu key={`${messageMenu.key}:${messageMenu.id}`} x={messageMenu.x} y={messageMenu.y} items={messageMenuItems}
      onSelect={selectMessageAction} onClose={() => setMessageMenu(null)} returnFocus={messageMenu.row} /> : null}
  </div>;
}
