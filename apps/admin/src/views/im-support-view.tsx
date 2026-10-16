"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, Check, ChevronLeft, CircleAlert, Headphones, Images, Info, MoreHorizontal, ReceiptText, Search, ShieldCheck, UserRound, X } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { ImClientLifecycle } from "@zzsh/im-client/lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, NIM_IMAGE_MAX_BYTES, NimImageSendError, NimTextSendError, validateNimImageFile, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { decodeImSystemNotice, mergeImMessages } from "@zzsh/im-client/message-state";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { confirmCurrentForbidden, isCurrentImRequest, messageAccessPath, supportedImageUrl, type ImRequestKey } from "./im-support-guards";
import { canOperateSupportType, createReadClientKey, createSendCapabilityKey } from "./im-support-capabilities";
import { OrderWorkbenchPane } from "./im-support-orders";
import { ConsultationUserCard } from "./im-support-user-card";
import { ConsultationEventsCard } from "./im-support-events";
import { dayKeyOf, dayLabelOf, formatBytes, formatTime, initialOf } from "./im-support-format";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "../components/ui/message";
import { Attachment, AttachmentAction, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "../components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../components/ui/input-group";
import { Kbd } from "../components/ui/kbd";

type SupportType = "SERVICE" | "COMPLAINT";
type ConsultationState = "WAITING" | "ACTIVE" | "CLOSED";
type Consultation = {
  id: string;
  type: SupportType;
  state: ConsultationState;
  subjectRef: string | null;
  assignedAdmin: { id: string; name: string } | null;
  peerAccountId: string | null;
  conversationType: "TEAM";
  conversationId: string | null;
  messageScopeState?: string;
  version: number;
  lastMessageAt: string | null;
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
  image?: { imageId: string; url?: string; name: string; mimeType: string; size: number };
};
type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };
type Presence = { adminUserId: string; availability: "OFF_DUTY" | "AVAILABLE" | "PAUSED"; connectionState: string; activeLoad: number; version: number };
type QueueRow = { id: string; type: SupportType; title: string; snippet: string; time: string; state: "待接入" | "处理中" | "已结束" | "待核验"; unread: boolean; consultation?: Consultation };
type DraftImage = { key: string; file: File; previewUrl: string; name: string; size: number; width: number; height: number; state: "DECODING" | "READY" | "SENDING" | "FAILED" | "UNKNOWN"; progress: number; messageClientId?: string };
type FailedText = { consultationId: string; conversationId: string; text: string; messageClientId?: string };

const MAX_STAGED_IMAGES = 6;
const PRESENCE_SYNC_ERROR = "接待状态同步失败";
const SESSION_REFRESH_ERROR = "会话状态刷新失败";
const QUEUE_REFRESH_ERROR = "队列刷新失败";
const GROUP_WINDOW_MS = 300_000;
// 结束结果未知时的说明。不复述"仍进行中/已结束"这类推断：平台当前没有按咨询读取结果的
// 接口，目录缺席、分页、转交、失权都证明不了远端到底有没有执行这次关闭。
const CLOSE_OUTCOME_UNKNOWN_NOTICE = "结束结果未确认：这次关闭可能已生效也可能没有。平台目前没有按咨询读取结果的接口，本页无法确认，也不会重复提交；请由平台侧核对后再处理。";

// 「案件进度」stepper 与「下一步 / 轮到你回复」已移除：assignedAdmin + messageScopeState
// 只能证明当前的接待关系与远端就绪状态，证明不了处理轮次，也证明不了历史阶段时间。
// 处理记录时间线由 ConsultationEventsCard 按真实事件投影渲染，不再从当前状态推断。
function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "平台咨询"; }
function stateLabel(state: ConsultationState): QueueRow["state"] { return state === "ACTIVE" ? "处理中" : state === "WAITING" ? "待接入" : "已结束"; }
function scopeStateLabel(consultation: Consultation): QueueRow["state"] { return consultation.messageScopeState === "FAILED" ? "待核验" : stateLabel(consultation.state); }
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
  const notice = decodeImSystemNotice(message);
  // A notification is never attributed to a human speaker, and unknown types
  // are not rendered as if the customer had written them.
  if (notice) return { id, from: "system", text: notice.text, time: formatTime(message.createTime), senderId: message.senderId, createTime: message.createTime };
  const self = message.senderId === accountId;
  const image = imageOf(message);
  const text = typeof message.text === "string" && message.text.trim() ? message.text : image ? "" : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  // Only the mapped peer is a customer; a colleague staff message stays on the staff
  // side instead of borrowing the current assignee's name or the user's label.
  const from: SupportMessage["from"] = self || (peerAccountId ? message.senderId !== peerAccountId : false) ? "agent" : "customer";
  return { id, from, text, time: formatTime(message.createTime), self, senderId: message.senderId, createTime: message.createTime, ...(image === undefined ? {} : { image }) };
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

export function ImSupportView({ snapshot, initialSection = "consultation", onRefresh, onOpenPath }: { snapshot: Extract<SessionSnapshot, { authenticated: true }>; initialSection?: "consultation" | "orders"; onRefresh: () => Promise<SessionSnapshot>; onOpenPath?: (path: string, title?: string) => void }) {
  const [section, setSection] = useState<"consultation" | "orders">(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  const canRead = hasPermission(snapshot, "im.support.read");
  const profileScope = { profile: hasPermission(snapshot, "user.directory.read"), orders: hasPermission(snapshot, "order.read"), resources: hasPermission(snapshot, "supply.rental_account.read") };
  const canComplaint = hasPermission(snapshot, "im.support.complaint");
  const canAccept = hasPermission(snapshot, "im.support.accept");
  const canTransfer = hasPermission(snapshot, "im.support.transfer");
  const canPresence = canRead && hasPermission(snapshot, "im.support.presence");
  const readClientKey = createReadClientKey({ adminUserId: snapshot.adminUserId, sessionId: snapshot.session.id, locked: snapshot.session.locked, canRead });
  const sendCapabilityKey = createSendCapabilityKey({ canAccept, canComplaint });

  const [queue, setQueue] = useState<Consultation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Below this width a third column leaves the chat unusable, so the case column
// starts collapsed and the operator opens it deliberately.
  const [detailsOpen, setDetailsOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 1180);
  const [mobilePane, setMobilePane] = useState<"queue" | "chat" | "details">("queue");
  const [notice, setNotice] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"waiting" | "mine">("mine");
  const [blockedConsultations, setBlockedConsultations] = useState<Record<string, boolean>>({});
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">("idle");
  const [presence, setPresence] = useState<Presence>({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  // Keyed by consultation: a receipt for conversation B must never erase the
  // unresolved responsibility belonging to conversation A.
  const [failedText, setFailedText] = useState<Record<string, FailedText | null>>({});
  const textFlightRef = useRef(new Set<string>());
  const [staged, setStaged] = useState<Record<string, DraftImage[]>>({});
  const [pending, setPending] = useState<Record<string, DraftImage | null>>({});
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(null);
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const [imageErrors, setImageErrors] = useState<Record<string, number>>({});
  const seenKey = `zzsh.im-support.seen.${snapshot.adminUserId}`;
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem(seenKey);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch { return {}; }
  });
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferState, setTransferState] = useState<{ targets: { adminUserId: string; displayName: string }[]; transferReady: boolean } | null>(null);
  const [transferError, setTransferError] = useState<string>();
  const [transferBusy, setTransferBusy] = useState(false);
  // 结束是不可撤销动作（平台侧没有恢复合同），所以走显式确认而不是点一下就走，
  // 并把「结果未确认」当独立状态保留，而不是让人重复点出一个新 POST。
  const [closeOpen, setCloseOpen] = useState(false);
  // 弹窗打开时快照确认对象，避免确认期间切换会话后关错人。
  const [closeTarget, setCloseTarget] = useState<Consultation | null>(null);
  const [closeOutcomeUnknown, setCloseOutcomeUnknown] = useState<Record<string, boolean>>({});
  const [incomingAt, setIncomingAt] = useState<Record<string, number>>({});
  const [historyMore, setHistoryMore] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyState, setHistoryState] = useState<Record<string, "loading" | "ready" | "error" | "forbidden">>({});

  const lifecycleRef = useRef<ImClientLifecycle<NimWebClientLike> | null>(null);
  const clientRef = useRef<NimWebClientLike | null>(null);
  const availabilityRef = useRef<Presence["availability"]>("OFF_DUTY");
  const presenceVersionRef = useRef<number | null>(null);
  const presenceWriteRef = useRef(Promise.resolve());
  const busyOwnerRef = useRef(0);
  const composingRef = useRef(false);
  const chatHeadingRef = useRef<HTMLElement | null>(null);
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
  const beginBusy = () => { const owner = busyOwnerRef.current + 1; busyOwnerRef.current = owner; setBusy(true); return owner; };
  const endBusy = (owner: number) => { if (busyOwnerRef.current === owner) setBusy(false); };

  const writePresence = useCallback((availability: Presence["availability"], state: ReturnType<typeof connectionForPresence>) => {
    const key = readClientKey;
    const generation = operatorGenerationRef.current;
    availabilityRef.current = availability;
    if (!canPresence || !canPresenceRef.current) return Promise.resolve<Presence | undefined>(undefined);
    const operation = presenceWriteRef.current.then(async () => {
      if (!canPresenceRef.current) return undefined;
      if (operatorRef.current !== key || operatorGenerationRef.current !== generation) return undefined;
      const version = presenceVersionRef.current;
      const value = await adminRequest<Presence>("/im/presence", { availability, connectionState: state, ...(version === null ? {} : { version }) }, "PUT");
      if (canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation) { presenceVersionRef.current = value.version; setPresence(value); }
      return value;
    });
    presenceWriteRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [canPresence, readClientKey]);

  // Identity/permission change: drop every private projection and every owned preview URL.
  useEffect(() => {
    clientRef.current = null;
    readyOperatorRef.current = null;
    setQueue([]);
    setMessages({});
    setDrafts({});
    setSelectedId(null);
    setHistoryMore({});
    setHistoryLoading(false);
    setIncomingAt({});
    setFailedText({});
    textFlightRef.current.clear();
    setStaged({});
    setPending({});
    setViewer(null);
    imageFlights.current.clear();
    sendingRef.current = false;
    setSending(false);
    historyAnchorRef.current = {};
    setPresence({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
    presenceVersionRef.current = null;
    availabilityRef.current = "OFF_DUTY";
    setConnection("idle");
    setNotice(undefined);
    setBlockedConsultations({});
    setCloseOutcomeUnknown({});
    setCloseOpen(false);
    setCloseTarget(null);
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
      if (token.transport === "local-fake") return createLocalFakeNimWebClientFactory({ endpoint: "/api/bff/admin/im/messages", accountId: token.accountId })(context);
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
        if (presenceResult.status === "fulfilled" && presenceResult.value) { presenceVersionRef.current = presenceResult.value.version; setPresence(presenceResult.value); availabilityRef.current = presenceResult.value.availability; }
        if (queueResult.status === "fulfilled") setQueue(queueResult.value);
        else setNotice(friendlyError(queueResult.reason));
        if (canPresence) void writePresence(availabilityRef.current, connectionForPresence(client.getConnectionState())).catch(() => undefined);
        client.onConnectionStateChange((state) => {
          if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
          setConnection(state);
          if (canPresence) void writePresence(availabilityRef.current, connectionForPresence(state))
            .then(() => { if (generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice((current) => current === PRESENCE_SYNC_ERROR ? undefined : current); })
            .catch(() => { if (generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(PRESENCE_SYNC_ERROR); });
        });
        client.onMessages((incoming) => {
          if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
          for (const raw of incoming) {
            const next = messageFromNim(raw, client.accountId, queueRef.current.find((c) => c.conversationId === raw.conversationId)?.peerAccountId);
            const consultation = queueRef.current.find((candidate) => candidate.state === "ACTIVE" && candidate.assignedAdmin?.id === snapshot.adminUserId && candidate.conversationId === raw.conversationId);
            if (!next || !consultation) continue;
            setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], [next]) }));
            // Client-observed arrival only drives the local badge; the consultation
            // row has no server writer for last_message_at yet.
            if (next.self !== true) setIncomingAt((current) => ({ ...current, [consultation.id]: Math.max(current[consultation.id] ?? 0, raw.createTime ?? 0) }));
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
        setNotice((current) => current === QUEUE_REFRESH_ERROR ? undefined : current);
      }).catch(() => {
        if (!cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice((current) => current ?? QUEUE_REFRESH_ERROR);
      }).finally(() => { loading = false; });
    };
    const timer = window.setInterval(refreshQueue, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [canRead, connection, readClientKey]);

  useEffect(() => {
    if (!canPresence || readyOperatorRef.current !== readClientKey || connection !== "CONNECTED") return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const timer = window.setInterval(() => {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) void writePresence(availabilityRef.current, connectionForPresence(connection)).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [canPresence, connection, readClientKey, writePresence]);

  useEffect(() => {
    if (selectedId && queue.some((item) => item.id === selectedId)) return;
    setSelectedId(queue[0]?.id ?? null);
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
        : document.querySelector<HTMLElement>('.im-wb-row[data-active="true"]') ?? document.querySelector<HTMLElement>(".im-wb-row");
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof Node && target.contains(active)) return;
    target.focus();
  }, [mobilePane]);

  const selected = queue.find((item) => item.id === selectedId) ?? null;
  const selectedMessages = messages[selectedId ?? ""] ?? [];

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
        : document.querySelector<HTMLElement>('.im-wb-row[data-active="true"]') ?? document.querySelector<HTMLElement>(".im-wb-row");
      target?.focus();
    });
  };

  useEffect(() => {
    try { window.localStorage.setItem(seenKey, JSON.stringify(seen)); } catch { /* private mode keeps it in memory */ }
  }, [seen, seenKey]);
  useEffect(() => {
    if (!selected) return;
    setSeen((current) => ({ ...current, [selected.id]: new Date().toISOString() }));
  }, [selected?.id, selectedMessages.length]);

  // 切换会话时丢弃未提交的结束确认，避免"看着 A 确认了 B"。
  useEffect(() => { setCloseOpen(false); setCloseTarget(null); }, [selectedId]);

  const displayQueue = useMemo<QueueRow[]>(() => queue.map((item) => {
    const history = messages[item.id];
    const last = history?.length ? history[history.length - 1] : undefined;
    // R1 重写时把这里的措辞缩短成了「待人工核验」，丢掉了「远端结果未知」这个
    // 关键差异（会读成普通待办）。恢复 HEAD 的完整措辞，队列行不得让 FAILED
    // 看起来像正常会话。
    const snippet = item.messageScopeState === "FAILED"
      ? "云信远端结果待人工核验，已暂停接待"
      : closeOutcomeUnknown[item.id]
        ? "结束结果未确认，待平台核对"
        : last
        ? `${last.from === "agent" ? (last.self ? "我：" : "客服：") : last.from === "system" ? "" : "用户："}${last.image ? "[图片]" : last.text || "[空消息]"}`
        : item.state === "WAITING" ? "等待客服接待" : item.state === "CLOSED" ? "咨询已结束" : "会话已建立，等待消息";
    return {
      id: item.id,
      type: item.type,
      title: item.user?.name || item.user?.username || "平台用户",
      snippet,
      time: last?.createTime ? formatTime(last.createTime) : "—",
      state: scopeStateLabel(item),
      unread: item.state === "ACTIVE" && item.assignedAdmin?.id === snapshot.adminUserId
        && item.id !== selectedId
        && ((Boolean(item.lastMessageAt) && item.lastMessageAt! > (seen[item.id] ?? ""))
          || (incomingAt[item.id] ?? 0) > (Date.parse(seen[item.id] ?? "") || 0)),
      consultation: item,
    };
  }), [queue, messages, seen, selectedId, snapshot.adminUserId, incomingAt, closeOutcomeUnknown]);

  const counts = useMemo(() => ({
    waiting: displayQueue.filter((row) => row.state === "待接入").length,
    mine: displayQueue.filter((row) => row.state === "处理中" || row.state === "待核验").length,
  }), [displayQueue]);  const filteredQueue = useMemo(() => {
    const text = query.trim().toLowerCase();
    return displayQueue.filter((row) => {
      const inFilter = filter === "waiting" ? row.state === "待接入" : row.state === "处理中" || row.state === "待核验";
      if (!inFilter) return false;
      if (!text) return true;
      return `${row.title} ${row.snippet} ${typeLabel(row.type)}`.toLowerCase().includes(text);
    });
  }, [displayQueue, filter, query]);

  const canOperateSelected = selected ? canOperateSupportType(selected.type, canAccept, canComplaint) : false;
  const canEdit = Boolean(canRead && canOperateSelected && selected?.state === "ACTIVE" && selected.conversationId && selected.messageScopeState === "READY" && !blockedConsultations[selected.id]);
  const canSend = Boolean(canRead && canOperateSelected && selected?.state === "ACTIVE" && selected.conversationId && selected.messageScopeState === "READY" && !blockedConsultations[selected.id] && clientRef.current && connection === "CONNECTED" && canEdit);
  canStartSendRef.current = canSend;
  const claimReady = Boolean(selected?.state === "WAITING" && !selected.assignedAdmin && canOperateSelected);
  const isMine = Boolean(selected?.state === "ACTIVE" && selected.assignedAdmin?.id === snapshot.adminUserId);
  const selectedStaged = staged[draftKey] ?? [];
  const selectedPending = pending[draftKey] ?? null;
  const selectedFailedText = failedFor(draftKey);
  const imageInFlight = Boolean(selectedPending && (selectedPending.state === "SENDING" || imageFlights.current.has(draftKey)));
  const imageBlocked = selectedStaged.some((item) => item.state === "DECODING" || item.width <= 0 || item.height <= 0);
  const sendBlocked = sending || imageInFlight || selectedPending?.state === "UNKNOWN" || selectedPending?.state === "SENDING";

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

  const claim = async () => {
    if (!selected || selected.state !== "WAITING" || !canOperateSupportType(selected.type, canAccept, canComplaint)) return;
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
    } catch (cause) { const current = currentRequestKey(); if (current && isCurrentImRequest(requestKey, current)) setNotice(friendlyError(cause)); } finally { endBusy(busyOwner); }
  };
  const close = async (consultationId: string) => {
    const target = queueRef.current.find((item) => item.id === consultationId);
    if (!target || target.state !== "ACTIVE" || target.assignedAdmin?.id !== snapshot.adminUserId || blockedConsultations[consultationId] || !canOperateSupportType(target.type, canAccept, canComplaint)) return;
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
      await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/close`, {}, "POST");
      if (!sameOperation()) return;
      setQueue((current) => current.filter((item) => item.id !== consultationId));
      setCloseOutcomeUnknown((value) => { const next = { ...value }; delete next[consultationId]; return next; });
      setCloseOpen(false);
      if (selectedIdRef.current === consultationId) { setSelectedId(null); setMobilePane("queue"); }
      setNotice("咨询已结束");
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
    try {
      const result = await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/transfer`, { targetAdminId }, "POST");
      const current = currentRequestKey();
      if (!current || !isCurrentImRequest(requestKey, current)) return;
      setQueue((current) => current.map((item) => item.id === result.consultation.id ? result.consultation : item));
      setTransferOpen(false);
      setTransferState(null);
      setNotice("已转交");
    } catch (cause) {
      await blockCurrentConsultationOnForbidden(cause, requestKey);
      const current = currentRequestKey();
      if (current && isCurrentImRequest(requestKey, current)) setTransferError(friendlyError(cause));
    } finally { setTransferBusy(false); }
  };
  const togglePresence = async () => {
    if (!canPresence) return;
    const busyOwner = beginBusy();
    setNotice(undefined);
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try { await writePresence(presence.availability === "AVAILABLE" ? "OFF_DUTY" : "AVAILABLE", connectionForPresence(connection)); }
    catch (cause) { if (canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(friendlyError(cause)); }
    finally { endBusy(busyOwner); }
  };

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
    if (!text && !stagedList.length && !pendingItem) return;
    if (sendingRef.current || imageFlights.current.has(key) || pendingItem?.state === "SENDING" || pendingItem?.state === "UNKNOWN") {
      if (pendingItem?.state === "UNKNOWN") setNotice("图片发送结果未确认，请先刷新历史；确认未发送后再按原图片重试。");
      return;
    }
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
    let stage: "text" | "image" = "text";
    // 真正提交出去的原文：重试时是原消息文本，不是此刻的草稿。异常要按它记责任。
    let submittedText = text;
    try {
      // 未决文字（有原 ID）哪怕草稿是空的也要先重放原消息，否则后面的图片会先发出去。
      if (text || retryTarget) {
        if (textFlightRef.current.has(consultationId)) return;
        textFlightRef.current.add(consultationId);
        try {
          submittedText = retryTarget ? retryTarget.text : text;
          const sent = retryTarget ? await client.retryText(conversationId, retryTarget.messageClientId!) : await client.sendText(conversationId, text);
          // 收敛已发出的原操作：只按原身份代次/操作者匹配。撤销接待权限不改变身份代次
          // （readClientKey 只含 adminUserId/session/locked/canRead），所以这里不比较发送
          // 能力——否则单独撤权会把已经发出去的文字回执连同责任一起丢掉。
          if (generation !== operatorGenerationRef.current || operatorRef.current !== operator) return;
          const next = messageFromNim(sent, client.accountId, selected?.peerAccountId);
          if (next) setMessages((current) => ({ ...current, [consultationId]: mergeImMessages(current[consultationId] ?? [], [next]) }));
          // Only clear the exact text that was submitted; newer typing survives.
          setDrafts((current) => current[consultationId] === submittedText ? { ...current, [consultationId]: "" } : current);
          setFailedFor(consultationId, null);
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
    } catch (cause) {
      await blockCurrentConsultationOnForbidden(cause, requestKey);
      // 同上：失败/未知的责任也要记回原操作，不能因为发送能力变化而丢弃。
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) {
        if (stage === "text") {
          const textError = cause instanceof NimTextSendError ? cause : null;
          if (textError) setFailedFor(consultationId, { consultationId, conversationId, text: submittedText, ...(textError.messageClientId ? { messageClientId: textError.messageClientId } : {}) });
          setNotice(textError?.kind === "UNKNOWN" ? "结果未确认，草稿已保留" : cause instanceof Error ? cause.message : "消息发送失败，请重试。");
        } else {
          const isUnknown = cause instanceof NimImageSendError && cause.kind === "UNKNOWN";
          setNotice(isUnknown ? "图片结果未确认，原图片已保留" : cause instanceof Error ? cause.message : "图片发送失败，可重试。");
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

  const connectionTone = connection === "CONNECTED" ? "good" : connection === "idle" || connection === "CONNECTING" ? "neutral" : "warn";
  const connectionText = connection === "CONNECTED" ? "通道已连接" : connection === "RECONNECTING" ? "通道重连中" : connection === "CONNECTING" ? "通道连接中" : connection === "KICKED" ? "通道已在其他端登录" : connection === "AUTH_FAILED" || connection === "error" ? "通道授权失败" : "通道未启动";
  const authorFor = (message: SupportMessage) => {
    if (message.self) return { name: operatorName, role: "平台客服" };
    if (selected?.peerAccountId && message.senderId === selected.peerAccountId) return { name: selected.user?.name || selected.user?.username || "平台用户", role: "平台用户" };
    // Historical senders we cannot map stay neutral instead of borrowing the
    // current assignee's identity.
    return message.from === "agent" ? { name: "客服", role: "平台客服" } : { name: selected?.user?.name || selected?.user?.username || "平台用户", role: "平台用户" };
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
      nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id}><Marker className="im-wb-sys" variant="separator"><MarkerContent>{message.text}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
      return nodes;
    }
    const previous = selectedMessages[index - 1];
    const grouped = Boolean(previous && previous.from !== "system" && previous.senderId === message.senderId && (message.createTime ?? 0) - (previous.createTime ?? 0) < GROUP_WINDOW_MS);
    const author = authorFor(message);
    const imageUrl = message.image ? supportedImageUrl(message.image.url) : null;
    const mine = message.self === true;
    nodes.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"}>
      <Message align={mine ? "end" : "start"} className="im-wb-msg" data-from={message.from} data-self={mine} data-grouped={grouped}>
        <MessageAvatar className="im-wb-av" aria-hidden="true">{initialOf(author.name)}</MessageAvatar>
        <MessageContent className="im-wb-msg-body">
          {grouped ? null : <MessageHeader className="im-wb-msg-meta"><b>{author.name}</b><span className="im-wb-role-tag" data-role={author.role}>{author.role}</span>{mine ? null : <time>{message.time}</time>}</MessageHeader>}
          <Bubble align={mine ? "end" : "start"} variant={mine ? "default" : "secondary"}>
            <BubbleContent className="im-wb-bub">{message.image ? (imageUrl
              ? (imageErrors[message.id]
                ? <button type="button" className="im-wb-thumb im-wb-thumb-failed" data-action="retry-image" onClick={() => setImageErrors((current) => { const next = { ...current }; delete next[message.id]; return next; })} aria-label={`重新加载图片 ${message.image.name}`}>图片加载失败 · 点击重试</button>
                : <button type="button" className="im-wb-thumb" onClick={() => setViewer({ url: imageUrl, name: message.image!.name })} aria-label={`查看图片 ${message.image.name}`}><img key={imageErrors[message.id] ?? imageUrl} src={imageUrl} alt={message.image.name} loading="lazy" onError={() => setImageErrors((current) => ({ ...current, [message.id]: Date.now() }))} /></button>)
              : <span className="im-wb-thumb-missing">图片暂不可预览</span>) : message.text}</BubbleContent>
          </Bubble>
          {mine ? <MessageFooter className="im-wb-msg-status"><time>{message.time}</time><Check size={11} />已发送</MessageFooter> : null}
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
          onClick={() => { setSelectedId(row.id); setMobilePane("chat"); setNotice(undefined); }}>
          <span className="im-wb-row-av" aria-hidden="true">{initialOf(row.title)}</span>
          <span className="im-wb-row-copy"><span className="im-wb-row-top"><b>{row.title}</b><i className="im-wb-tag" data-tone={row.type === "COMPLAINT" ? "warn" : "neutral"}>{row.type === "COMPLAINT" ? "投诉" : "咨询"}</i><time>{row.time}</time></span>
            <span className="im-wb-row-snip">{row.snippet}</span>
            <span className="im-wb-row-foot"><em data-state={row.state}>{row.state}</em>{row.unread ? <i className="im-wb-unread" aria-label="有新消息">新</i> : null}</span></span>
        </button>) : <div className="im-wb-list-empty">{query ? <><strong>当前列表没有匹配会话</strong><span>试试其他关键词。</span></>
          : filter === "waiting" ? <><strong>暂无等待接入的会话</strong></>
          : <><strong>暂无你接待中的会话</strong><span>从「待接待」接入一条即可开始。</span></>}</div>}
      </div>
    </aside>

    <main className="im-wb-chat">
      <header className="im-wb-chat-head" ref={chatHeadingRef} tabIndex={-1} data-focus-target="chat">
        <button type="button" className="im-wb-back" data-action="back-to-queue" onClick={() => setMobilePane("queue")}><ChevronLeft size={14} />队列</button>
        <span className="im-wb-chat-av" aria-hidden="true">{initialOf(selected?.user?.name || selected?.user?.username || "客")}</span>
        <div className="im-wb-chat-title">
          <h2>{selected ? `${selected.user?.name || selected.user?.username || "平台用户"} · ${typeLabel(selected.type)}` : "选择一条会话"}</h2>
          <span className="im-wb-chat-sub">{!selected ? "等待用户咨询" : selected.state === "WAITING" ? "等待客服接待" : selected.assignedAdmin ? `当前接待：${selected.assignedAdmin.name}` : "尚未分配接待"}</span>
        </div>
        <div className="im-wb-chat-actions">
          {claimReady ? <button type="button" className="im-wb-btn im-wb-btn-primary" data-action="claim-consultation" onClick={() => void claim()} disabled={busy || connection !== "CONNECTED"}>接入会话</button> : null}
          {selected && isMine && selected.messageScopeState !== "FAILED" ? <button ref={closeTriggerRef} type="button" data-action="close-consultation" className="im-wb-btn im-wb-btn-outline" onClick={() => { if (!canOperateSelected || closeOutcomeUnknown[selected.id]) return; setCloseTarget(selected); setCloseOpen(true); }} disabled={busy || !canOperateSelected || Boolean(closeOutcomeUnknown[selected.id]) || Boolean(blockedConsultations[selected.id])}>{!canOperateSelected ? "无本类型接待权限" : closeOutcomeUnknown[selected.id] ? "结束结果未确认" : "结束咨询"}</button> : null}
          <button ref={transferTriggerRef} type="button" data-action="open-transfer" className="im-wb-btn im-wb-btn-outline" onClick={() => void openTransfer()} disabled={!canTransfer || !selected || selected.state !== "ACTIVE" || !isMine || selected.messageScopeState !== "READY" || busy}>{canTransfer ? "转交" : "无转交权限"}</button>
          <button ref={detailsTriggerRef} type="button" className="im-wb-btn im-wb-btn-outline im-wb-btn-icon" aria-label={detailsOpen ? "收起会话详情" : "展开会话详情"} aria-expanded={detailsOpen} aria-controls="im-wb-details" data-action="toggle-details" onClick={() => { if (detailsOpen) closeDetails(); else openDetails(); }}><MoreHorizontal size={15} /></button>
        </div>
      </header>
      {selected?.type === "COMPLAINT" ? <p className="im-wb-scope-note"><CircleAlert size={13} />投诉内容不会同步到订单群</p> : null}
      {notice ? <p className="im-wb-notice" role="status"><CircleAlert size={14} />{notice}</p> : null}
      {selected && closeOutcomeUnknown[selected.id] ? <p className="im-wb-notice" data-tone="warn" role="status"><CircleAlert size={14} />{CLOSE_OUTCOME_UNKNOWN_NOTICE}</p> : null}
      <div className="im-wb-stream-wrap">
        {selected?.messageScopeState === "FAILED" ? <div className="im-wb-empty"><CircleAlert size={22} /><strong>会话待人工核验</strong><span>请先完成核验再回复。</span>{selected.assignedAdmin?.id === snapshot.adminUserId && canTransfer ? <button type="button" className="im-wb-btn" data-action="reconcile-consultation" onClick={() => void reconcile()} disabled={busy}>核验并恢复</button> : null}</div>
          : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor">
            <MessageScrollerPrimitive.Root className="im-wb-scroller">
              <MessageScrollerPrimitive.Viewport className="im-wb-viewport" aria-label="会话消息"><MessageScrollerPrimitive.Content className="im-wb-content">
                {selectedMessages.length ? <>
                  {selected && historyMore[selected.id] ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="im-wb-history-more"><button type="button" onClick={() => void loadEarlier()} disabled={historyLoading}>{historyLoading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}
                  {timelineItems}
                </> : <MessageScrollerPrimitive.Item messageId="empty">{emptyStreamState(selected ? historyState[selected.id] : undefined, Boolean(selected))}</MessageScrollerPrimitive.Item>}
              </MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport>
              <MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>
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
          <InputGroupTextarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} onPaste={onComposerPaste}
            onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
            aria-label="输入客服消息" rows={3}
            placeholder={!selected ? "从左侧选择会话" : selected.state === "WAITING" ? "接入会话后可回复" : selected.messageScopeState === "FAILED" ? "云信会话待人工核验，暂不可回复" : connection !== "CONNECTED" ? "云信通道未连接，草稿会保留" : "输入回复…"}
            disabled={!canEdit} />
          <InputGroupAddon align="block-end" className="im-wb-composer-tools">
            <label className="im-wb-tool"><Images size={14} />图片<input type="file" accept="image/jpeg,image/png" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { const files = event.target.files ? Array.from(event.target.files) : []; event.target.value = ""; stageFiles(files); }} disabled={!canEdit || sendBlocked} /></label>
            <span className="im-wb-hint im-wb-hint-right"><Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行</span>
            <button type="submit" className="im-wb-send" disabled={!canSend || busy || sendBlocked || (!draft.trim() && !selectedStaged.length && !(selectedPending?.state === "FAILED"))}>{busy ? "处理中…" : "发送"}</button>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </main>

    <aside id="im-wb-details" className="im-wb-details" aria-label="会话详情" hidden={!detailsOpen}>
      <div className="im-wb-details-head"><strong>会话详情</strong>
        <button type="button" className="im-wb-btn im-wb-btn-icon" data-action="collapse-details" onClick={closeDetails} aria-label="收起会话详情"><X size={14} /></button></div>
      {!selected ? <p className="im-wb-details-empty">未选择会话</p> : <>
        {/* 只陈列可由现有字段证明的当前事实。此前的「案件进度」stepper 与「下一步 /
            轮到你回复」是从 assignedAdmin + READY 推断出来的，既证明不了轮次也证明不了
            历史；历史阶段时间一律以处理记录时间线里的真实事件为准。 */}
        <section className="im-wb-sec"><span><Info size={12} />本次服务</span>
          <dl><div><dt>{selected.type === "COMPLAINT" ? "沟通类型" : "咨询类型"}</dt><dd>{typeLabel(selected.type)}</dd></div>
            <div><dt>服务状态</dt><dd>{scopeStateLabel(selected)}</dd></div>
            <div><dt>{selected.type === "COMPLAINT" ? "当前处理" : "当前接待"}</dt><dd>{selected.assignedAdmin?.name || "尚未分配"}</dd></div>
            <div><dt>发起时间</dt><dd>{formatTime(selected.createdAt)}</dd></div></dl></section>
        <ConsultationUserCard key={selected.id} consultationId={selected.id} rowUserId={selected.user?.id ?? ""} fallbackName={selected.user?.name || selected.user?.username || "平台用户"}
          request={adminRequest} scope={profileScope} onOpenProfile={(id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料")} />
        <ConsultationEventsCard key={`${selected.id}:events`} consultationId={selected.id} request={adminRequest} />

        {blockedConsultations[selected.id] ? <section className="im-wb-sec"><span>授权状态</span><small>发送权限已失效</small>
          <button type="button" className="im-wb-btn" data-action="refresh-consultation-access" onClick={() => void refreshConsultationAccess()} disabled={busy || !selected.conversationId}>重新确认当前授权</button></section> : null}
      </>}
    </aside>
  </div>;

  return <div className="im-wb-root">
    <nav className="im-wb-bar" aria-label="沟通类型">
      <div className="im-wb-seg" role="group">
        <button type="button" aria-pressed={section === "consultation"} onClick={() => setSection("consultation")}>咨询与投诉<b>{displayQueue.length}</b></button>
        <button type="button" aria-pressed={section === "orders"} onClick={() => setSection("orders")}>订单沟通</button>
      </div>
      <span className="im-wb-spacer" />
      {canPresence ? <>
        <span className="im-wb-state" data-tone={presence.availability === "AVAILABLE" ? "good" : "neutral"}><i className={presence.availability === "AVAILABLE" ? "on" : ""} />{presence.availability === "AVAILABLE" ? "接待中" : presence.availability === "PAUSED" ? "已暂停" : "未接待"}</span>
        <button type="button" className="im-wb-btn im-wb-presence-toggle" data-action="toggle-presence" onClick={() => void togglePresence()} disabled={busy || connection !== "CONNECTED"}>{presence.availability === "AVAILABLE" ? "暂停接待" : "开始接待"}</button>
      </> : <span className="im-wb-state">无在线状态权限</span>}
      <span className="im-wb-state im-wb-conn" data-tone={connectionTone}><i className={connection === "CONNECTED" ? "on" : ""} />{connectionText}</span>
    </nav>
    <div className="im-wb-pane" hidden={section !== "consultation"}>{consultationPane}</div>
    {canRead ? <div className="im-wb-pane im-wb-pane--orders" hidden={section !== "orders"}><OrderWorkbenchPane identity={readClientKey} adminUserId={snapshot.adminUserId} operatorName={operatorName}
      client={clientRef.current} connection={connection} active={section === "orders"} sendAllowed={canAccept} request={adminRequest} onAuthError={() => { void onRefresh(); }} /></div> : null}
    <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
      <DialogContent className="im-wb-dialog" aria-label="转交会话" showCloseButton={false} finalFocus={transferTriggerRef}>
        <div className="im-wb-dialog-head"><div><strong>转交会话</strong><span>{selected?.user?.name || "当前咨询"}</span></div><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setTransferOpen(false)} aria-label="关闭转交"><X size={14} /></button></div>
        {transferError ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{transferError}</p>
          : transferState === null ? <p className="im-wb-dialog-empty">正在读取可转交客服…</p>
          : !transferState.transferReady ? <p className="im-wb-dialog-empty">会话尚未就绪，暂不可转交</p>
          : !transferState.targets.length ? <p className="im-wb-dialog-empty">暂无可转交的客服</p>
          : <div className="im-wb-dialog-list">{transferState.targets.map((target) => <button key={target.adminUserId} type="button" disabled={transferBusy} onClick={() => void confirmTransfer(target.adminUserId)}><span>{target.displayName}</span><small>可接待客服</small></button>)}</div>}
        <p className="im-wb-dialog-hint">转交后原会话与历史保留</p>
      </DialogContent>
    </Dialog>
    {/* 结束咨询：确认对象与后果再提交。没有后台恢复/撤销合同，所以这里不给「撤销」，
        也不把结束包装成可逆操作。 */}
    <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
      <DialogContent className="im-wb-dialog" aria-label="结束咨询" showCloseButton={false} finalFocus={closeTriggerRef}>
        <div className="im-wb-dialog-head"><div><strong>结束咨询</strong><span>{closeTarget ? `${typeLabel(closeTarget.type)} · ${closeTarget.user?.name || closeTarget.user?.username || "平台用户"}` : "当前咨询"}</span></div><button type="button" className="im-wb-btn im-wb-btn-icon" onClick={() => setCloseOpen(false)} aria-label="关闭结束确认"><X size={14} /></button></div>
        {closeTarget ? <dl className="im-wb-confirm">
          <div><dt>{closeTarget.type === "COMPLAINT" ? "当前处理" : "当前接待"}</dt><dd>{closeTarget.assignedAdmin?.name || "尚未分配"}</dd></div>
          <div><dt>关联对象</dt><dd>{closeTarget.subjectRef || "未关联商品或订单"}</dd></div>
        </dl> : null}
        <p className="im-wb-dialog-hint">结束后本条咨询进入已结束，平台会解除该咨询的客服会话与发送范围；这是不可撤销动作，平台当前没有恢复入口。结束不会删除聊天记录；但按现行授权规则，咨询结束后历史记录的读取随结束关闭，不能在本页恢复。</p>
        <div className="im-wb-dialog-actions">
          <button type="button" className="im-wb-btn" onClick={() => setCloseOpen(false)}>取消</button>
          <button type="button" className="im-wb-btn im-wb-btn-danger" data-action="confirm-close-consultation" onClick={() => { if (closeTarget) void close(closeTarget.id); }} disabled={busy || !closeTarget || !canOperateSelected}>确认结束</button>
        </div>
      </DialogContent>
    </Dialog>
    {viewer ? <dialog className="im-wb-lightbox" aria-label="图片预览" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setViewer(null); } }} onCancel={(event) => { event.preventDefault(); setViewer(null); }}>
      <button type="button" onClick={() => setViewer(null)} autoFocus>关闭图片</button><img src={viewer.url} alt={viewer.name} /></dialog> : null}
  </div>;
}
