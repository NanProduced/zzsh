"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowDown, Check, ChevronLeft, CircleAlert, Clock3, Headphones, ImagePlus, Info, Paperclip, ReceiptText, SendHorizontal, ShieldCheck, UserRound, Wifi, WifiOff, X } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { useUserSession } from "@/components/session/user-session-provider";
import { ImClientLifecycle } from "@/lib/im-client-lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, mergeImMessages, NimImageSendError, NimTextSendError, validateNimImageFile, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState } from "@/lib/nim-web-client";
import { clearSupportIntent, readSupportIntent, saveSupportIntent, type SupportType } from "@/lib/support-intent";
import "./customer-support-workspace.css";
import { readSupportOrders, type SupportOrder } from "@/lib/support-directory";
import { OrderTeamPanel, orderTeamLabel } from "@zzsh/ui/order-team-panel";
import "@zzsh/ui/order-team.css";

async function orderRequest<T>(path:string, signal?: AbortSignal):Promise<T>{
  const response=await fetch(path,{credentials:"same-origin",cache:"no-store",signal});return readJson<T>(response,"订单请求未完成");
}

type Consultation = {
  id: string;
  type: SupportType;
  state: "WAITING" | "ACTIVE" | "CLOSED";
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
  image?: { imageId: string; url?: string; name: string; mimeType: string; size: number };
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
  { id: "preview-general", title: "一般咨询 · 演示", preview: "连接云信后将在这里恢复历史消息", time: "—", unread: 0 },
] as const;

const PREVIEW_MESSAGES: Record<string, SupportMessage[]> = {
  "preview-product": [
    { id: "system-1", from: "system", text: "本地演示数据 · 未连接云信", time: "09:41" },
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

/** Names the real blocker instead of always blaming 客服接待 (link down, no conversation yet). */
function composerBlockReason(conversation: Pick<Consultation, "state" | "messageScopeState"> | null, canSend: boolean): string | null {
  if (canSend || conversation?.state === "CLOSED") return null;
  if (!conversation) return "创建或选择一个会话后可发送消息";
  if (conversation.messageScopeState === "FAILED") return "客服会话待人工核验，暂不可发送";
  if (conversation.state === "WAITING") return "等待客服接待后可发送消息";
  return "云信连接未就绪，恢复后可继续发送";
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "现在";
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

  if (message.messageType === 5) {
    const attach = message.attachment as { type?: number } | undefined;
    const isTeamInvite = attach && typeof attach === "object" && attach.type === 0;
    return {
      id: message.messageServerId || message.messageClientId || `sys-${message.createTime}`,
      from: "system",
      text: isTeamInvite ? "成员已加入会话" : "会话信息已更新",
      time: formatTime(message.createTime),
      createTime: message.createTime,
      senderId,
    };
  }

  const image = imageOf(message);
  const text = typeof message.text === "string" && message.text.trim()
    ? message.text
    : image ? "" : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  return {
    id: message.messageServerId || message.messageClientId || `${senderId}-${message.createTime}`,
    from: self ? "customer" : "agent",
    text,
    time: formatTime(message.createTime),
    status: self ? "sent" : undefined,
    self,
    createTime: message.createTime,
    senderId,
    ...(image === undefined ? {} : { image }),
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
  const value = await readJson<Record<string, unknown>>(response, "暂时无法建立云信连接。");
  if (typeof value.appKey !== "string" || typeof value.accountId !== "string" || typeof value.token !== "string" || !value.appKey || !value.accountId || !value.token || (value.transport !== "nim" && value.transport !== "local-fake")) throw new Error("云信登录凭据格式无效");
  return { appKey: value.appKey, accountId: value.accountId, token: value.token, transport: value.transport };
}

async function fetchConsultations(signal?: AbortSignal): Promise<Consultation[]> {
  const response = await fetch("/api/im/consultations?limit=50", { credentials: "same-origin", cache: "no-store", signal });
  const value = await readJson<{ consultations?: unknown }>(response, "暂时无法读取咨询记录。");
  if (!Array.isArray(value.consultations)) throw new Error("咨询记录格式无效");
  return value.consultations as Consultation[];
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
  return value.consultation;
}

function subjectRefFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get("listingId") ?? new URL(window.location.href).searchParams.get("accountId");
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function SupportTypePicker({ value, onChange, disabled = false }: { value: SupportType; onChange: (value: SupportType) => void; disabled?: boolean }) {
  return <div className="support-type-picker" role="radiogroup" aria-label="客服类型">
    <button type="button" role="radio" aria-checked={value === "SERVICE"} className="support-type-option" data-active={value === "SERVICE"} disabled={disabled} onClick={() => onChange("SERVICE")}><Headphones size={17} /><span><strong>在线客服</strong><small>商品、使用和平台服务咨询</small></span></button>
    <button type="button" role="radio" aria-checked={value === "COMPLAINT"} className="support-type-option" data-active={value === "COMPLAINT"} disabled={disabled} onClick={() => onChange("COMPLAINT")}><ShieldCheck size={17} /><span><strong>投诉反馈</strong><small>问题反馈与服务体验处理</small></span></button>
  </div>;
}

function MessageRow({ message, agentMeta, peerAccountId, grouped = false, isLastSelf = false }: { message: SupportMessage; grouped?: boolean; agentMeta?: { name: string; role: string }; peerAccountId?: string | null; isLastSelf?: boolean }) {
  if (message.from === "system") return <div className="support-message-marker" role="note"><span>{message.text}</span><time>{message.time}</time></div>;
  const outgoing = message.self === true;
  const isAssignedPeer = Boolean(!outgoing && message.from === "agent" && message.senderId && peerAccountId && message.senderId === peerAccountId);
  // Only the account behind the current peer may borrow the 接待人 name; other
  // agent authors (transferred history) show the provable role alone.
  const senderName = outgoing
    ? "我"
    : isAssignedPeer && agentMeta
      ? agentMeta.name
      : message.from === "agent"
        ? "客服"
        : "用户";
  const senderRole = isAssignedPeer && agentMeta ? agentMeta.role : undefined;
  return <article className="support-message" data-from={message.from} data-self={outgoing} data-grouped={grouped}>
    <div className="support-message-avatar" aria-hidden="true">{message.from === "agent" ? <Headphones size={14} /> : <UserRound size={14} />}</div>
    <div className="support-message-body">
      <div className="support-message-meta">
        <span className={outgoing ? "sr-only" : "support-sender-name"}>{senderName}</span>
        {!outgoing && senderRole ? <span className="support-role-tag" data-role={senderRole}>{senderRole}</span> : null}
      </div>
      <div className="support-message-bubble-row">
        {message.image ? (() => {
          const raw = message.image.url ?? (message.image.imageId ? `/api/im/images/${encodeURIComponent(message.image.imageId)}` : "");
          const url = raw ? supportedImageUrl(raw) : null;
          return url
            ? <a className="support-message-image" href={url} target="_blank" rel="noreferrer" aria-label={`查看图片 ${message.image.name}`}><img src={url} alt={message.image.name} loading="lazy" /></a>
            : <div className="support-message-bubble" data-slot="bubble">图片暂不可预览</div>;
        })() : <div className="support-message-bubble" data-slot="bubble">{message.text}</div>}
        <time className="support-message-hover-time">{message.time}</time>
      </div>
      {outgoing && isLastSelf && message.status ? <div className="support-message-status"><Check size={12} />{message.status === "read" ? "已读" : "已发送"}</div> : null}
    </div>
  </article>;
}

function ConnectionState({ preview, state, localFake = false }: { preview: boolean; localFake?: boolean; state: NimWebConnectionState | "idle" | "error" }) {
  // Driven only by the connection itself: an unrelated send failure must never
  // be reported as a broken link (state === "error" already covers that).
  if (preview || localFake) {
    return <span className="support-connection-state" data-state={preview ? "preview" : "offline"} aria-live="polite">
      {preview ? <ShieldCheck size={13} /> : <WifiOff size={13} />}{preview ? "本地演示" : "测试连接"}
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
  const [isStartingNew, setIsStartingNew] = useState(false);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => preview ? PREVIEW_CONVERSATIONS[0].id : null);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>(() => preview ? PREVIEW_MESSAGES : {});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, string | null>>({});
  const [panelView, setPanelView] = useState<"list" | "chat">("chat");
  const [contextOpen, setContextOpen] = useState(false);
  const [orderPopoverOpen, setOrderPopoverOpen] = useState(false);
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">(preview ? "idle" : "idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [imReady, setImReady] = useState(preview);
  const [historyMore, setHistoryMore] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [imageSending, setImageSending] = useState(false);
  const activeSendingIntentIdRef = useRef<string | null>(null);
  const canStartSendRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const pendingImageRef = useRef<Record<string, PendingImageItem | null>>({});
  const stagedImagesRef = useRef<Record<string, StagedImageItem[]>>({});
  const [pendingImage, setPendingImage] = useState<Record<string, PendingImageItem | null>>({});
  const [failedTexts, setFailedTexts] = useState<Record<string, UnresolvedText>>({});
  const readHiddenRef = useRef<Record<string, boolean>>({});
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
  const revalidateAfterUnauthorized = useCallback((cause: unknown): boolean => {
    if (httpStatus(cause) !== 401) return false;
    void session.confirm();
    return true;
  }, [session.confirm]);
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
  const setAttachmentFor = (key: string, value: string | null) => setAttachments((current) => ({ ...current, [key]: value }));

  useEffect(() => { setSelectedType(initialType); }, [initialType]);

  useEffect(() => {
    if (preview || !imReady || readyIdentityRef.current !== currentIdentity || session.status !== "authenticated" || !session.userId) return;
    const intent = readSupportIntent();
    if (!intent) return;
    const intentKey = `${intent.type}:${intent.source}:${intent.createdAt}`;
    if (intentInFlightRef.current === intentKey) return;
    intentInFlightRef.current = intentKey;
    const generation = identityGenerationRef.current;
    setSelectedType(intent.type);
    setBusy(true);
    void createConsultation(intent.type, subjectRef).then((consultation) => {
      if (generation !== identityGenerationRef.current || identityRef.current !== currentIdentity) return;
      if (consultation.state === "WAITING" || consultation.conversationId) clearSupportIntent(intent);
      setConsultations((current) => [consultation, ...current.filter((item) => item.id !== consultation.id)]);
      setIsStartingNew(false);
      setActiveId(consultation.id);
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
      setActiveId(PREVIEW_CONVERSATIONS[0].id);
      setIsStartingNew(false);
      setConnection("idle");
      setImReady(true);
      readyIdentityRef.current = "preview";
      return;
    }
    setConsultations([]);
    setOrders([]);setSelectedOrder(initialOrderId&&initialOrderParty?{id:initialOrderId,party:initialOrderParty}:null);setDirectoryIdentity("");setDirectoryState("loading");
    setMessages({});
    setDrafts({});
    setAttachments({});
    setActiveId(null);
    setIsStartingNew(false);
    setConnection("idle");
    setError(undefined);
    setBusy(false);
    setImageSending(false);
    activeSendingIntentIdRef.current = null;
    isSubmittingRef.current = false;
    setImReady(false);
    setHistoryMore({});
    setHistoryLoading(false);
    setFailedTexts({});
    readHiddenRef.current = {};
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
      if (token.transport === "local-fake") return createLocalFakeNimWebClientFactory({ endpoint: "/api/im/messages", accountId: token.accountId })(context);
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
              setMessages(current => ({...current, [consultation.id]: []}));
              // 已结束咨询的历史读取随结束关闭是合同设计，不是"权限变化"，交给空态文案说明；
              // 进行中的会话被 401/403 挡住才提示权限变化。
              if (activeIdRef.current === consultation.id && consultation.state !== "CLOSED") setError("当前消息读取权限已变化，私有消息已隐藏。");
            }
          }
          const value = await readJson<{ authorized?: unknown }>(response, "当前咨询授权已变化，请刷新后重试。");
          if (value.authorized !== true) throw new Error("当前咨询未获授权");
          if (operation === "read") delete readHiddenRef.current[conversationId];
        },
        tokenProvider: async (accountId) => {
          if (accountId !== token.accountId) throw new Error("云信账号不匹配");
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
        client.onConnectionStateChange((state) => { if (!cancelled && generation === identityGenerationRef.current && identityRef.current === identity) { setConnection(state); if (state === "AUTH_FAILED" || state === "KICKED") setError("云信连接需要重新授权，请刷新后重试。"); } });
        client.onMessages((incoming) => {
          if (cancelled || generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client) return;
          for (const raw of incoming) {
            const item = messageFromNim(raw, client.accountId);
            const consultation = consultationsRef.current.find((candidate) => candidate.state === "ACTIVE" && candidate.conversationId === raw.conversationId);
            if (!item || !consultation) continue;
            setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], [item]) }));
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
          setOrders(orderPage.items);setDirectoryState("ready");
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

  useEffect(() => {
    if (preview || isStartingNew || activeId || consultations.length === 0) return;
    setActiveId(consultations[0]!.id);
    setSelectedType(consultations[0]!.type);
  }, [activeId, consultations, isStartingNew, preview]);

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
    : consultations.find((item) => item.id === activeId) ?? null;
  const previewConversation = preview ? PREVIEW_CONVERSATIONS.find((item) => item.id === activeId) ?? PREVIEW_CONVERSATIONS[0] : null;
  const activeConversationKey = preview ? previewConversation?.id ?? "" : activeConversation?.id ?? "";
  const activeMessages = messages[activeConversationKey] ?? [];
  const canSend = preview || Boolean(activeConversation?.state === "ACTIVE" && activeConversation.conversationId && activeConversation.messageScopeState === "READY" && clientRef.current && connection === "CONNECTED");
  canStartSendRef.current = canSend;
  const unresolvedText = failedTexts[activeConversationKey] ?? null;
  const setUnresolvedTextFor = (key: string, next: UnresolvedText | null) => setFailedTexts((current) => {
    const copy = { ...current };
    if (next) copy[key] = next; else delete copy[key];
    return copy;
  });
  const agentMeta = activeConversation?.assignedAdmin?.name ? { name: activeConversation.assignedAdmin.name, role: "客服" } : undefined;

  let lastSelfIndex = -1;
  for (let i = activeMessages.length - 1; i >= 0; i--) {
    const msg = activeMessages[i];
    if (msg && msg.self === true) {
      lastSelfIndex = i;
      break;
    }
  }

  let timelineDay = "";
  const timelineItems: ReactNode[] = activeMessages.map((message,index) => {
    const previous=activeMessages[index-1];
    const grouped=Boolean(message.senderId&&previous?.senderId===message.senderId&&message.createTime&&previous.createTime&&message.createTime-previous.createTime<300_000);
    const items: ReactNode[] = [];
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      timelineDay = dayKey;
      items.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><div className="support-day-divider">{dayLabelOf(dayKey)}</div></MessageScrollerPrimitive.Item>);
    }
    items.push(<MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"}><MessageRow message={message} grouped={grouped} agentMeta={message.from === "agent" ? agentMeta : undefined} peerAccountId={activeConversation?.peerAccountId} isLastSelf={index === lastSelfIndex} /></MessageScrollerPrimitive.Item>);
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
      if (cancelled || generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client || activeIdRef.current !== conversation.id) return;
      const rows = history.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [conversation.id]: mergeImMessages(current[conversation.id] ?? [], rows) }));
      const oldest = oldestOf(history);
      if (oldest) historyAnchorRef.current[conversation.id] = oldest;
      setHistoryMore((current) => ({ ...current, [conversation.id]: history.length === 50 }));
    }).catch((cause) => { revalidateAfterUnauthorized(cause); });
    return () => { cancelled = true; };
  }, [activeConversation?.conversationId, activeConversation?.id, connection, currentIdentity, preview, revalidateAfterUnauthorized]);

  const loadEarlier = async () => {
    if (preview || !activeConversation?.conversationId || !clientRef.current || historyLoading) return;
    const client = clientRef.current;
    const conversation = activeConversation;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    const anchor = historyAnchorRef.current[conversation.id];
    if (!anchor) { setHistoryMore((current) => ({ ...current, [conversation.id]: false })); return; }
    setHistoryLoading(true);
    try {
      const older = await client.getMessageHistory(conversation.conversationId!, 50, anchor);
      if (generation !== identityGenerationRef.current || identityRef.current !== identity || clientRef.current !== client || activeIdRef.current !== conversation.id) return;
      const rows = older.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [conversation.id]: mergeImMessages(current[conversation.id] ?? [], rows) }));
      const oldest = oldestOf(older);
      if (oldest) historyAnchorRef.current[conversation.id] = oldest;
      setHistoryMore((current) => ({ ...current, [conversation.id]: older.length === 50 }));
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === identity) setError(cause instanceof Error ? cause.message : "更早的消息读取失败。");
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) setHistoryLoading(false);
    }
  };

  const startConsultation = async (type: SupportType = selectedType) => {
    if (createFlight.current) return;
    if (session.status !== "authenticated") {
      const source = window.location.pathname + window.location.search;
      saveSupportIntent({ type: selectedType, source });
      auth.open(source, () => { void session.confirm(); });
      return;
    }
    // Check if there is already an active or waiting consultation of this type to reuse
    const existing = consultations.find((item) => item.type === type && (item.state === "ACTIVE" || item.state === "WAITING"));
    if (existing) {
      setSection("consultation");
      setPanelView("chat");
      setSelectedType(type);
      setIsStartingNew(false);
      setActiveId(existing.id);
      return;
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
      setConsultations((current) => [consultation, ...current.filter((item) => item.id !== consultation.id)]);
      setSection("consultation"); setPanelView("chat"); setSelectedType(type);
      setIsStartingNew(false);
      setActiveId(consultation.id);
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setError(cause instanceof Error ? cause.message : "暂时无法创建咨询。");
    } finally {
      createFlight.current = false;
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setBusy(false);
    }
  };

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

  const resumeStagedImages = async () => {
    const conversationKey = activeConversationKey;
    const conversationId = activeConversation?.conversationId;
    const client = clientRef.current;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    if (!conversationId || !client || !canSend || imageSending) return;
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
        activeIdRef.current !== activeConversation?.id ||
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
    if (!text && !attachment && currentStaged.length === 0) return;

    if (isSubmittingRef.current || busy || imageSending) return;

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
    const client = clientRef.current;
    if (preview) {
      const parts: string[] = [];
      if (attachment) parts.push(`[附件] ${attachment}`);
      if (currentStaged.length > 0) {
        parts.push(`[图片] ${currentStaged.map((s) => s.name).join(", ")}`);
      }
      if (text) parts.push(text);
      const next: SupportMessage = { id: `local-${Date.now()}`, from: "customer", text: parts.join("\n"), time: "现在", status: "sent", self: true };
      setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
      setDrafts((current) => current[conversationKey] === draft ? { ...current, [conversationKey]: "" } : current);
      setAttachmentFor(conversationKey, null);
      setStagedImagesFor(conversationKey, []);
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
          const sent = await client.sendText(conversationId, text);
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
          }
        } catch (cause) {
          revalidateAfterUnauthorized(cause);
          if (generation === identityGenerationRef.current && identityRef.current === identity) {
            const textError = cause instanceof NimTextSendError ? cause : null;
            setError(textError?.kind === "UNKNOWN" ? "发送结果未确认，内容已保留；可先刷新历史确认是否送达。" : cause instanceof Error ? cause.message : "消息发送失败，请重试。");
            setUnresolvedTextFor(conversationKey, { conversationId: conversationId ?? "", text, messageClientId: textError?.messageClientId, unknown: textError?.kind === "UNKNOWN" });
          }
          return;
        } finally {
          if (generation === identityGenerationRef.current && identityRef.current === identity) setBusy(false);
        }
      }

      // 2. Images are sent sequentially one by one
      const stagedToSend = [...currentStaged];
      for (const stagedItem of stagedToSend) {
        if (
          !visibleRef.current ||
          sectionRef.current !== "consultation" ||
          !canStartSendRef.current ||
          generation !== identityGenerationRef.current ||
          identityRef.current !== identity ||
          activeIdRef.current !== activeConversation?.id ||
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
          break;
        }
      }
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) isSubmittingRef.current = false;
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
    if (isSubmittingRef.current || busy || imageSending) return;
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
    if (!pending || !canSend || imageSending) return;
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
    if (!canSend || busy || imageSending) return;
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
      if (clientRef.current !== client || activeIdRef.current !== conversation.id) return;
      const rows = history.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [conversation.id]: mergeImMessages(current[conversation.id] ?? [], rows) }));
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      setError(cause instanceof Error ? cause.message : "历史刷新失败。");
    }
  };

  const chooseQuickReply = (value: string) => { setDraft(value); requestAnimationFrame(() => draftRef.current?.focus()); };
  const beginNewConsultation = () => {
    if (!activeConversation || activeConversation.state !== "CLOSED") return;
    setSelectedType(activeConversation.type);
    setIsStartingNew(true);
    setActiveId(null);
    setPanelView("chat");
    setError(undefined);
  };

  if (!preview && session.status !== "authenticated") {
    const sessionError = session.status === "error";
    return <section className={`support-gate${embedded ? " support-gate-embedded" : ""}`} aria-busy={session.status === "loading"}>
      {sessionError ? <CircleAlert size={28} aria-hidden="true" /> : <Headphones size={28} aria-hidden="true" />}
      <div className="support-gate-heading"><div><h2>{sessionError ? "暂时无法确认登录状态" : session.status === "loading" ? "正在确认登录身份" : "选择客服类型"}</h2><p>{sessionError ? "客服窗口暂未打开，确认恢复后可以继续。" : "先选择需要的帮助类型，登录后会自动恢复这次咨询意图。"}</p></div>{embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口"><X size={18} /></button> : null}</div>
      {!sessionError && session.status !== "loading" ? <SupportTypePicker value={selectedType} onChange={setSelectedType} /> : null}
      {sessionError ? <button type="button" className="button secondary" onClick={session.revalidate}>重试身份确认</button> : session.status === "guest" ? <button type="button" className="button primary" onClick={() => void startConsultation()}><Headphones size={15} />登录并联系客服</button> : null}
    </section>;
  }

  const currentTitle = preview
    ? previewConversation?.title ?? "客服演示"
    : isStartingNew
      ? "发起新的咨询"
      : activeConversation
        ? typeLabel(activeConversation.type)
        : "开始新的咨询";

  const currentSubtitle = preview
    ? "商品咨询会话"
    : isStartingNew
      ? "选择类型后创建独立咨询"
      : activeConversation
        ? activeConversation.messageScopeState === "FAILED"
          ? "云信会话待人工核验，暂不可发送"
          : activeConversation.state === "WAITING"
            ? "已提交，等待客服接待"
            : activeConversation.state === "ACTIVE"
              ? activeConversation.assignedAdmin
                ? `当前接待：${activeConversation.assignedAdmin.name}`
                : `${typeLabel(activeConversation.type)}进行中`
              : "咨询已结束"
        : "选择类型后创建独立咨询";

  const consultationView = <section className={`support-workspace${embedded ? " support-workspace-embedded" : ""}`} data-preview={preview} aria-label="客服咨询窗口">
    {error ? <div className="support-inline-error" role="alert"><CircleAlert size={15} />{error}</div> : null}
    <div className="support-workspace-grid" ref={gridRef} data-view={preview ? panelView : "chat"}>
      {preview ? <nav className="support-conversation-list" aria-label="咨询会话">
        <div className="support-list-heading" tabIndex={-1}><div><strong>咨询记录</strong><span>{preview ? "演示" : "平台记录"}</span></div><div className="support-list-heading-actions"><span className="support-list-count">{preview ? PREVIEW_CONVERSATIONS.length : consultations.length}</span><button type="button" className="support-back" data-action="back-to-chat" onClick={() => setPanelView("chat")}><ChevronLeft size={15} />返回</button>{embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口"><X size={16} /></button> : null}</div></div>
        {preview ? PREVIEW_CONVERSATIONS.map((conversation) => <button key={conversation.id} type="button" className="support-conversation-item" data-active={conversation.id === activeId} onClick={() => { setIsStartingNew(false); setActiveId(conversation.id); setPanelView("chat"); }} aria-current={conversation.id === activeId ? "page" : undefined}><span className="support-conversation-avatar" aria-hidden="true"><Headphones size={14} /></span><span className="support-conversation-copy"><strong>{conversation.title}</strong><span>{conversation.preview}</span></span><span className="support-conversation-meta"><time>{conversation.time}</time>{conversation.unread ? <b>{conversation.unread}</b> : null}</span></button>) : consultations.length > 0 ? consultations.map((consultation) => <button key={consultation.id} type="button" className="support-conversation-item" data-active={consultation.id === activeId} onClick={() => { setIsStartingNew(false); setActiveId(consultation.id); setSelectedType(consultation.type); setPanelView("chat"); }} aria-current={consultation.id === activeId ? "page" : undefined}><span className="support-conversation-avatar" aria-hidden="true"><Headphones size={14} /></span><span className="support-conversation-copy"><strong>{typeLabel(consultation.type)}</strong><span>{consultation.messageScopeState === "FAILED" ? "云信会话待人工核验" : consultation.assignedAdmin?.name ? `当前接待：${consultation.assignedAdmin.name}` : consultation.state === "WAITING" ? "等待客服接待" : "咨询已结束"}</span></span><span className="support-conversation-meta"><time>{consultation.messageScopeState === "FAILED" ? "待核验" : consultation.state === "WAITING" ? "等待中" : consultation.state === "ACTIVE" ? "进行中" : "已结束"}</time></span></button>) : <div className="support-list-empty"><Headphones size={22} /><strong>还没有咨询记录</strong><span>选择类型后开始一次站内咨询，登录账号会自动保留记录。</span></div>}
      </nav> : null}
      <main className="support-conversation-panel">
        <header className="support-conversation-heading" ref={chatHeadingRef} tabIndex={-1} data-focus-target="chat">
          <button type="button" className="support-back" data-action="back-to-conversations" onClick={() => setPanelView("list")}><ChevronLeft size={15} />会话记录</button>
          <div className="support-conversation-identity"><span className="support-live-dot" data-state={activeConversation?.state === "ACTIVE" ? "active" : "idle"} aria-hidden="true" /><div><h3>{currentTitle}</h3><span>{currentSubtitle}</span></div></div>
          <div className="support-heading-actions">
            {!preview && activeConversation?.state === "CLOSED" ? <button type="button" className="button secondary" data-action="start-new-consultation" onClick={beginNewConsultation}>再次咨询</button> : null}
            {preview || subjectRef ? <button type="button" className="support-icon-button" data-action="toggle-product-context" aria-expanded={contextOpen} aria-label="商品上下文" onClick={() => setContextOpen((value) => !value)}><Info size={16} /></button> : null}
            {embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口"><X size={18} /></button> : null}
          </div>
        </header>
        <div className="support-facts-bar">
          <span className="support-fact-chip">{activeConversation ? typeLabel(activeConversation.type) : preview ? "商品咨询" : isStartingNew ? "新咨询" : "客服咨询"}</span>
          {activeConversation ? <span className="support-fact-chip" data-tone={activeConversation.messageScopeState === "FAILED" ? "warn" : activeConversation.state === "ACTIVE" ? "good" : "neutral"}>{activeConversation.messageScopeState === "FAILED" ? "待人工核验" : activeConversation.state === "WAITING" ? "等待接待" : activeConversation.state === "ACTIVE" ? "进行中" : "已结束"}</span> : null}
          {activeConversation?.assignedAdmin ? <span className="support-fact-chip" data-tone="good">{`客服 · ${activeConversation.assignedAdmin.name}`}</span> : null}
          {subjectRef ? <span className="support-fact-chip">{`对象 ${subjectRef}`}</span> : preview ? <span className="support-fact-chip">演示对象</span> : null}
          <span className="support-facts-spacer" />
        </div>
        <div className="support-message-area">
           {unresolvedText ? <div className="support-send-retry" role="alert"><CircleAlert size={15} /><span>{unresolvedText.unknown ? "发送结果未确认，内容已保留。" : "消息发送失败，内容已保留。"}</span><button type="button" onClick={() => void refreshHistory()}>刷新历史</button><button type="button" onClick={() => void retrySend()} disabled={busy || !canSend}>{unresolvedText.messageClientId ? "原消息重试" : "重试发送"}</button></div> : null}
           {!preview && !activeConversation ? <div className="support-start-panel" data-state={isStartingNew ? "new" : "initial"}><Headphones size={27} /><strong>{isStartingNew ? "发起新的咨询" : "从这里开始你的咨询"}</strong><span>每种类型会保留独立的咨询记录，客服接待后才能发送消息。</span><SupportTypePicker value={selectedType} onChange={setSelectedType} disabled={busy} /><button type="button" className="button primary" data-action={isStartingNew ? "submit-new-consultation" : "start-consultation"} onClick={() => void startConsultation()} disabled={busy}><SendHorizontal size={15} />{busy ? "创建中…" : `开始${typeLabel(selectedType)}`}</button></div> : !preview && activeConversation?.state === "WAITING" ? <div className="support-start-panel"><Clock3 size={27} /><strong>已记录，等待客服接待</strong><span>平台正在寻找符合接待条件的客服；接待关系建立后会自动恢复消息入口。</span></div> : !preview && activeConversation?.messageScopeState === "FAILED" ? <div className="support-start-panel"><CircleAlert size={27} /><strong>客服会话待人工核验</strong><span>平台暂时无法确认云信远端动作是否完成，已暂停发送和自动重试。请稍后再试或联系平台处理。</span></div> : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor"><MessageScrollerPrimitive.Root className="support-message-scroller"><MessageScrollerPrimitive.Viewport className="support-message-viewport" aria-label="消息内容"><MessageScrollerPrimitive.Content className="support-message-content">{activeMessages.length > 0 ? <>{historyMore[activeConversationKey] ? <MessageScrollerPrimitive.Item messageId="load-earlier"><div className="support-history-more"><button type="button" onClick={() => void loadEarlier()} disabled={historyLoading}>{historyLoading ? "正在读取更早消息…" : "更早的消息"}</button></div></MessageScrollerPrimitive.Item> : null}{timelineItems}</> : <MessageScrollerPrimitive.Item messageId="empty"><div className="support-message-empty"><Headphones size={24} /><strong>{activeConversation?.state === "CLOSED" ? "本次咨询已结束" : "等待第一条消息"}</strong><span>{activeConversation?.state === "CLOSED" ? "如需继续，请重新发起一次咨询。咨询结束后，历史记录的读取已随结束关闭，这里不再展示旧记录。" : preview ? "可以从下方快捷回复开始检查交互。" : "建立云信连接后，消息会出现在这里。"}</span></div></MessageScrollerPrimitive.Item>}</MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport><MessageScrollerPrimitive.Button direction="end" className="support-jump-button" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={14} aria-hidden="true" /></MessageScrollerPrimitive.Button></MessageScrollerPrimitive.Root></MessageScrollerPrimitive.Provider>}
        </div>
        <div className="support-composer-wrap">
          {preview ? <div className="support-quick-replies" aria-label="快捷回复"><span>快捷回复</span>{["我先帮你确认一下", "请稍等，我正在核对"].map((reply) => <button key={reply} type="button" onClick={() => chooseQuickReply(reply)}>{reply}</button>)}</div> : null}
          {attachment ? <div className="support-attachment" data-slot="attachment"><Paperclip size={14} /><span>{attachment}</span><button type="button" onClick={() => setAttachment(null)} aria-label="移除附件">×</button></div> : null}
          {!preview && pendingImage[activeConversationKey] ? (() => {
            const pending = pendingImage[activeConversationKey]!;
            return <div className="support-pending-image" data-state={pending.state}><img src={pending.previewUrl} alt={pending.name} /><span>{pending.name} · {pending.state === "UNKNOWN" ? "发送结果未确认" : pending.state === "SENDING" ? `发送中 ${pending.progress ?? 0}%` : "发送失败"}{pending.messageClientId ? "" : "（无原消息标识）"}</span><button type="button" onClick={() => void retryPendingImage()} disabled={imageSending || !canSend}>{pending.messageClientId ? "原消息重试" : "重试"}</button><button type="button" onClick={removePendingImage} disabled={imageSending || pending.state === "UNKNOWN"}>移除</button></div>;
          })() : null}
          {/* 已结束会话是只读的：不再摆一个"等待接待"的输入框，只说明状态。
              再次咨询入口保留在会话头，不在这里重复。 */}
          {!preview && activeConversation?.state === "CLOSED" ? <div className="support-composer-closed" role="status"><Headphones size={15} /><span>本次咨询已结束，无法继续发送消息。</span></div> : <form
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
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
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
              disabled={!canSend || busy}
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
                </TooltipProvider>
              </div>
              <div className="support-composer-actions">
                {(!canSend || activeConversation?.messageScopeState === "FAILED") ? (
                  <span className="support-composer-status">{activeConversation?.messageScopeState === "FAILED" ? "远端状态待人工核验" : "当前不可发送"}</span>
                ) : (
                  <span className="support-composer-hint">
                    <kbd className="support-kbd">Enter</kbd> 发送 · <kbd className="support-kbd">Shift</kbd> + <kbd className="support-kbd">Enter</kbd> 换行
                  </span>
                )}
                <button type="submit" className="support-send-btn" disabled={!canSend || busy || imageSending || (!draft.trim() && !attachment && (stagedImages[activeConversationKey]?.length ?? 0) === 0)} aria-label="发送消息">
                  <span>{busy || imageSending ? "发送中" : "发送"}</span>
                </button>
              </div>
            </div>
          </form>}
        </div>
      </main>
      {contextOpen ? <aside className="support-context-panel" aria-label="商品上下文"><div className="support-context-heading"><div><strong>商品与订单信息</strong><span>{preview ? "演示快照" : "服务端授权快照"}</span></div><button type="button" className="support-icon-button" data-action="close-product-context" onClick={() => { setContextOpen(false); gridRef.current?.querySelector<HTMLButtonElement>('[data-action="toggle-product-context"]')?.focus(); }} aria-label="关闭商品上下文"><X size={15} /></button></div>{preview ? <><article className="support-product-card" data-slot="attachment"><div className="support-product-card-top"><span>zzsh.im-card</span><span>v1</span></div><h3>{PREVIEW_PRODUCT.title}</h3><p>{PREVIEW_PRODUCT.summary}</p><dl><div><dt>状态</dt><dd>{PREVIEW_PRODUCT.statusText}</dd></div><div><dt>费用</dt><dd>{PREVIEW_PRODUCT.priceText}</dd></div></dl><div className="support-product-card-id">商品 ID · {PREVIEW_PRODUCT.objectId}</div></article><button type="button" className="support-action-btn support-action-primary support-context-send-btn" data-action="send-product-context" onClick={() => { const text = `【咨询订单】${PREVIEW_PRODUCT.title} (ID: ${PREVIEW_PRODUCT.objectId})`; setDraft(draft ? `${draft}\n${text}` : text); setContextOpen(false); requestAnimationFrame(() => draftRef.current?.focus()); }}><ReceiptText size={13} /><span>发送此订单信息</span></button></> : orders.length > 0 ? <div className="support-verified-orders"><span className="support-verified-orders-hint">点击可将你参与的订单信息带入咨询输入框：</span><div className="support-verified-orders-list">{orders.map((ord) => <button key={ord.id} type="button" className="support-verified-order-item" onClick={() => { const text = `【咨询订单】${ord.title} (订单尾号: ${ord.displayNo}) [${ord.party === "owner" ? "出租" : "租入"}]`; setDraft(draft ? `${draft}\n${text}` : text); setContextOpen(false); requestAnimationFrame(() => draftRef.current?.focus()); }}><strong>{ord.title}</strong><span>尾号 {ord.displayNo} · {ord.party === "owner" ? "出租订单" : "租入订单"}</span></button>)}</div></div> : <div className="support-context-empty"><Headphones size={20} /><strong>暂无可关联的订单</strong><span>仅展示你当前已付款或出租中的真实订单。</span></div>}<div className="support-context-note"><ShieldCheck size={15} /><p>订单信息来自当前账号已授权的真实订单，带入后可在发送前补充说明。</p></div></aside> : null}
    </div>
  </section>;
  if(preview)return consultationView;
  const directoryReady=directoryIdentity===currentIdentity&&directoryState==="ready";
  const welcome=directoryReady&&!consultations.length&&!orders.length&&!initialOrderId;
  const brand = <div className="support-brand"><img src="/art/zhouzhou/avatar.webp" width={36} height={36} alt=""/><div className="support-brand-text"><strong>洲洲客服</strong><ConnectionState preview={preview} localFake={clientRef.current?.transport==="local-fake"} state={connection} /></div></div>;
  const actions=<div className="support-entry-actions"><button type="button" className="support-action-btn support-action-primary" disabled={busy||!directoryReady} onClick={()=>void startConsultation("SERVICE")}><Headphones size={14}/>联系客服</button><button type="button" className="support-action-btn support-action-secondary" disabled={busy||!directoryReady} onClick={()=>void startConsultation("COMPLAINT")}>投诉反馈</button></div>;
  const close=<button type="button" className="support-icon-button" aria-label="关闭客服窗口" onClick={onClose}><X size={18}/></button>;
  const retainedDirectory=directoryIdentity===currentIdentity&&(consultations.length>0||orders.length>0);
  if(!directoryReady&&!retainedDirectory)return <section className="support-welcome" aria-busy={directoryState==="loading"}><header>{brand}{close}</header><div role={directoryState==="error"?"alert":"status"}><h2>{directoryState==="error"?"暂时无法读取会话":"正在读取会话"}</h2><p>{directoryState==="error"?directoryError:"正在核对咨询、投诉和租入／出租订单群。"}</p>{directoryState==="error"?<button type="button" className="button secondary" onClick={()=>setDirectoryRevision(n=>n+1)}>重试读取</button>:null}</div></section>;
  if(welcome)return <section className="support-welcome"><header>{brand}{close}</header><div><h2>你好，需要什么帮助？</h2><p>订单会话建立后，会自动出现在这里。</p>{actions}{error?<p role="alert">{error}</p>:null}</div><footer>关闭后可继续浏览，已有会话会保留。</footer></section>;
  return <div className="support-unified" data-view={panelView}>
    <nav className="support-directory" aria-label="全部会话">
      <header>{brand}<span className="support-mobile-close">{close}</span></header>{actions}<h2 tabIndex={-1}>会话</h2>
      <div className="support-directory-items">
      {consultations.length===50?<p className="support-directory-limit">咨询目录仅提供最近50条；更早记录待接口支持。</p>:null}
      {consultations.map((item) => {
        const lastMsg = messages[item.id]?.at(-1);
        const snippet = lastMsg
          ? lastMsg.image
            ? "[图片]"
            : lastMsg.from === "system"
              ? `[系统] ${lastMsg.text}`
              : lastMsg.text.includes("【咨询订单】")
                ? "[订单信息]"
                : lastMsg.text
          : item.state === "WAITING"
            ? "等待客服接待"
            : item.state === "CLOSED"
              ? "咨询已结束"
              : item.assignedAdmin?.name
                ? `由客服 ${item.assignedAdmin.name} 接待中`
                : "咨询进行中";

        const timeDisplay = lastMsg
          ? lastMsg.time
          : item.lastMessageAt
            ? formatTime(Date.parse(item.lastMessageAt))
            : undefined;

        return (
          <button
            type="button"
            className="support-conversation-item"
            key={item.id}
            data-active={section === "consultation" && activeId === item.id}
            onClick={() => {
              setSection("consultation");
              setActiveId(item.id);
              setSelectedType(item.type);
              setIsStartingNew(false);
              setPanelView("chat");
            }}
          >
            <span className="support-conversation-avatar" aria-hidden="true">
              <Headphones size={16} />
            </span>
            <span className="support-conversation-copy">
              <strong title={typeLabel(item.type)}>{typeLabel(item.type)}</strong>
              <span>{snippet}</span>
            </span>
            <span className="support-conversation-meta">
              {timeDisplay ? <time>{timeDisplay}</time> : null}
            </span>
          </button>
        );
      })}
      {orders.map((item) => (
        <button
          type="button"
          className="support-conversation-item"
          key={item.id}
          data-active={section === "orders" && selectedOrder?.id === item.id}
          onClick={() => {
            setSelectedOrder({ id: item.id, party: item.party });
            setSection("orders");
            setPanelView("chat");
          }}
        >
          <span className="support-conversation-avatar" aria-hidden="true">
            <ReceiptText size={16} />
          </span>
          <span className="support-conversation-copy">
            <strong title={item.title + " · " + item.displayNo}>{item.title} · {item.displayNo}</strong>
            <span>
              <span className="support-conversation-tag">{item.party === "owner" ? "出租" : "租入"}</span>
              {orderTeamLabel(item)}
            </span>
          </span>
        </button>
      ))}
      </div>
    </nav>
    <div className="support-unified-chat">
      {directoryState==="error"?<div className="support-inline-error" role="alert">{directoryError}<button type="button" onClick={()=>setDirectoryRevision(n=>n+1)}>重试读取</button></div>:null}
      <div className="support-pane" hidden={section!=="consultation"}>{consultationView}</div>
      <div className="support-order-pane" hidden={section!=="orders"}><div className="support-order-actions"><button type="button" className="support-back" onClick={()=>setPanelView("list")}>返回会话</button>{close}</div><OrderTeamPanel key={currentIdentity} identity={currentIdentity} realm="user" client={clientRef.current} connection={connection} active={section==="orders"} visible={visible} polling={visible} initialParty={selectedOrder?.party??initialOrderParty} selectedOrderId={selectedOrder?.id} compact request={orderRequest} onAuthError={()=>{void session.confirm();}}/></div>
    </div>
  </div>;
}
