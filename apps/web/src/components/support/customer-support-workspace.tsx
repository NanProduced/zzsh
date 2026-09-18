"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDown, Check, CircleAlert, Clock3, FileUp, Headphones, Paperclip, SendHorizontal, ShieldCheck, UserRound, Wifi, WifiOff, X } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { useAuthOverlay } from "@/components/auth/auth-overlay-provider";
import { useUserSession } from "@/components/session/user-session-provider";
import { ImClientLifecycle } from "@/lib/im-client-lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, mergeImMessages, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState } from "@/lib/nim-web-client";
import { clearSupportIntent, readSupportIntent, saveSupportIntent, type SupportType } from "@/lib/support-intent";
import "./customer-support-workspace.css";
import { OrderTeamPanel } from "@zzsh/ui/order-team-panel";
import "@zzsh/ui/order-team.css";

async function orderRequest<T>(path:string):Promise<T>{
  const response=await fetch(path,{credentials:"same-origin",cache:"no-store"});return readJson<T>(response,"订单请求未完成");
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
};

type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };

const PREVIEW_CONVERSATIONS = [
  { id: "preview-product", title: "商品咨询 · 演示", preview: "可以帮我确认一下这件商品吗？", time: "刚刚", unread: 2 },
  { id: "preview-general", title: "一般咨询 · 演示", preview: "连接云信后将在这里恢复历史消息", time: "—", unread: 0 },
] as const;

const PREVIEW_MESSAGES: Record<string, SupportMessage[]> = {
  "preview-product": [
    { id: "system-1", from: "system", text: "本地演示数据 · 未连接云信", time: "09:41" },
    { id: "customer-1", from: "customer", text: "你好，我想了解这件商品的租期和当前可咨询状态。", time: "09:42" },
    { id: "agent-1", from: "agent", text: "你好，我来帮你确认。商品信息已附在右侧，具体规则以服务端报价和客服确认结果为准。", time: "09:43", status: "read" },
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

function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "在线客服"; }

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "现在";
}

function messageFromNim(message: NimMessageLike, accountId: string): SupportMessage | null {
  const senderId = typeof message.senderId === "string" ? message.senderId : "";
  if (!senderId) return null;
  const self = senderId === accountId;
  const text = typeof message.text === "string" && message.text.trim()
    ? message.text
    : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  return {
    id: message.messageServerId || message.messageClientId || `${senderId}-${message.createTime}`,
    from: self ? "customer" : "agent",
    text,
    time: formatTime(message.createTime),
    status: self ? "sent" : undefined,
    self,
    createTime: message.createTime,
  };
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

async function fetchConsultations(): Promise<Consultation[]> {
  const response = await fetch("/api/im/consultations?limit=50", { credentials: "same-origin", cache: "no-store" });
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

function MessageRow({ message }: { message: SupportMessage }) {
  if (message.from === "system") return <div className="support-message-marker" role="note"><span>{message.text}</span><time>{message.time}</time></div>;
  const outgoing = message.self ?? message.from === "agent";
  return <article className="support-message" data-from={message.from} data-self={outgoing}>
    <div className="support-message-avatar" aria-hidden="true">{outgoing && !message.self ? <Headphones size={14} /> : <UserRound size={14} />}</div>
    <div className="support-message-body">
      <div className="support-message-meta"><span>{message.self ? "我" : outgoing ? "客服" : "用户"}</span><time>{message.time}</time></div>
      <div className="support-message-bubble" data-slot="bubble">{message.text}</div>
      {outgoing && message.status ? <div className="support-message-status"><Check size={12} />{message.status === "read" ? "已读" : "已发送"}</div> : null}
    </div>
  </article>;
}

function ConnectionState({ preview, state, error }: { preview: boolean; state: NimWebConnectionState | "idle" | "error"; error?: string }) {
  const label = preview ? "本地演示 · 未连接云信" : error ? "云信连接失败" : state === "CONNECTED" ? "云信已连接" : state === "RECONNECTING" ? "云信正在重连" : state === "AUTH_FAILED" ? "云信授权失败" : state === "KICKED" ? "云信连接已被踢出" : "云信连接等待启动";
  return <span className="support-connection-state" data-state={preview ? "preview" : state === "CONNECTED" ? "connected" : error ? "error" : "offline"} aria-live="polite">
    {preview ? <ShieldCheck size={14} /> : state === "CONNECTED" ? <Wifi size={14} /> : <WifiOff size={14} />}{label}
  </span>;
}

export function CustomerSupportWorkspace({ preview = false, embedded = false, initialType = "SERVICE", initialOrderParty, requestSerial=0, onClose }: { preview?: boolean; embedded?: boolean; initialType?: SupportType; initialOrderParty?:"renter"|"owner";requestSerial?:number;onClose?: () => void }) {
  const [section,setSection]=useState<"consultation"|"orders">("consultation");
  useEffect(()=>{setSection(initialOrderParty?"orders":"consultation");},[initialOrderParty,requestSerial]);
  const session = useUserSession();
  const auth = useAuthOverlay();
  const [selectedType, setSelectedType] = useState<SupportType>("SERVICE");
  const [isStartingNew, setIsStartingNew] = useState(false);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => preview ? PREVIEW_CONVERSATIONS[0].id : null);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>(() => preview ? PREVIEW_MESSAGES : {});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, string | null>>({});
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">(preview ? "idle" : "idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [imReady, setImReady] = useState(preview);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const lifecycleRef = useRef<ImClientLifecycle<NimWebClientLike> | null>(null);
  const clientRef = useRef<NimWebClientLike | null>(null);
  const activeIdRef = useRef(activeId);
  const consultationsRef = useRef(consultations);
  const identityRef = useRef("");
  const identityGenerationRef = useRef(0);
  const intentInFlightRef = useRef<string | null>(null);
  const readyIdentityRef = useRef<string | null>(null);
  const subjectRef = useMemo(() => subjectRefFromLocation(), []);

  const currentIdentity = preview
    ? "preview"
    : session.status === "authenticated" && session.userId
      ? `${session.userId}:${session.identityVersion}`
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
    setMessages({});
    setDrafts({});
    setAttachments({});
    setActiveId(null);
    setIsStartingNew(false);
    setConnection("idle");
    setError(undefined);
    setBusy(false);
    setImReady(false);
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
          const value = await readJson<{ authorized?: unknown }>(response, "当前咨询授权已变化，请刷新后重试。");
          if (value.authorized !== true) throw new Error("当前咨询未获授权");
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
        void fetchConsultations().then((list) => {
          if (!cancelled && generation === identityGenerationRef.current && identityRef.current === identity) setConsultations(list);
        }).catch((cause) => {
          revalidateAfterUnauthorized(cause);
          if (!cancelled && generation === identityGenerationRef.current && identityRef.current === identity) setError(cause instanceof Error ? cause.message : "暂时无法读取咨询记录。");
        });
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
    if (preview || !imReady || readyIdentityRef.current !== currentIdentity || session.status !== "authenticated" || !session.userId) return;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    const timer = window.setInterval(() => {
      void fetchConsultations().then((list) => {
        if (generation === identityGenerationRef.current && identityRef.current === identity) setConsultations(list);
      }).catch((cause) => { revalidateAfterUnauthorized(cause); });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [currentIdentity, imReady, preview, revalidateAfterUnauthorized, session.status, session.userId]);

  useEffect(() => {
    if (preview || isStartingNew || activeId || consultations.length === 0) return;
    setActiveId(consultations[0]!.id);
    setSelectedType(consultations[0]!.type);
  }, [activeId, consultations, isStartingNew, preview]);

  const activeConversation = preview
    ? null
    : consultations.find((item) => item.id === activeId) ?? null;
  const previewConversation = preview ? PREVIEW_CONVERSATIONS.find((item) => item.id === activeId) ?? PREVIEW_CONVERSATIONS[0] : null;
  const activeConversationKey = preview ? previewConversation?.id ?? "" : activeConversation?.id ?? "";
  const activeMessages = messages[activeConversationKey] ?? [];
  const canSend = preview || Boolean(activeConversation?.state === "ACTIVE" && activeConversation.conversationId && activeConversation.messageScopeState === "READY" && clientRef.current && connection === "CONNECTED");

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
    }).catch((cause) => { revalidateAfterUnauthorized(cause); });
    return () => { cancelled = true; };
  }, [activeConversation?.conversationId, activeConversation?.id, connection, currentIdentity, preview, revalidateAfterUnauthorized]);

  const startConsultation = async () => {
    if (session.status !== "authenticated") {
      const source = window.location.pathname + window.location.search;
      saveSupportIntent({ type: selectedType, source });
      auth.open(source, () => { void session.confirm(); });
      return;
    }
    if (readyIdentityRef.current !== currentIdentity || !clientRef.current) {
      setError("云信连接仍在准备中，请稍后重试。");
      return;
    }
    const generation = identityGenerationRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const consultation = await createConsultation(selectedType, subjectRef);
      if (generation !== identityGenerationRef.current || identityRef.current !== currentIdentity) return;
      const pendingIntent = readSupportIntent();
      if (pendingIntent) clearSupportIntent(pendingIntent);
      setConsultations((current) => [consultation, ...current.filter((item) => item.id !== consultation.id)]);
      setIsStartingNew(false);
      setActiveId(consultation.id);
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setError(cause instanceof Error ? cause.message : "暂时无法创建咨询。");
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === currentIdentity) setBusy(false);
    }
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text && !attachment) return;
    const conversationKey = activeConversationKey;
    const generation = identityGenerationRef.current;
    const identity = currentIdentity;
    const conversationId = activeConversation?.conversationId;
    const client = clientRef.current;
    if (preview) {
      const next: SupportMessage = { id: `local-${Date.now()}`, from: "customer", text: attachment ? `${text ? `${text}\n` : ""}[附件] ${attachment}` : text, time: "现在", status: "sent", self: true };
      setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
      setDraftFor(conversationKey, ""); setAttachmentFor(conversationKey, null); return;
    }
    if (!conversationId || !client || !canSend) return;
    setBusy(true); setError(undefined);
    try {
      const sent = await client.sendText(conversationId, text);
      const next = messageFromNim(sent, client.accountId);
      if (next && generation === identityGenerationRef.current && identityRef.current === identity && activeIdRef.current === activeConversation?.id && clientRef.current === client) {
        setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
        setDraftFor(conversationKey, "");
        setAttachmentFor(conversationKey, null);
      }
    } catch (cause) {
      revalidateAfterUnauthorized(cause);
      if (generation === identityGenerationRef.current && identityRef.current === identity) setError(cause instanceof Error ? cause.message : "消息发送失败，请重试。");
    } finally {
      if (generation === identityGenerationRef.current && identityRef.current === identity) setBusy(false);
    }
  };

  const chooseQuickReply = (value: string) => { setDraft(value); requestAnimationFrame(() => draftRef.current?.focus()); };
  const beginNewConsultation = () => {
    if (!activeConversation || activeConversation.state !== "CLOSED") return;
    setSelectedType(activeConversation.type);
    setIsStartingNew(true);
    setActiveId(null);
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

  const currentTitle = preview ? previewConversation?.title ?? "客服演示" : isStartingNew ? "发起新的咨询" : activeConversation ? `${typeLabel(activeConversation.type)}${activeConversation.assignedAdmin ? ` · ${activeConversation.assignedAdmin.name}` : ""}` : "开始新的咨询";
  const currentSubtitle = preview ? "商品咨询会话" : isStartingNew ? "选择类型后创建独立咨询" : activeConversation ? activeConversation.messageScopeState === "FAILED" ? "云信会话待人工核验，暂不可发送" : activeConversation.state === "WAITING" ? "已记录，等待合格客服接待" : activeConversation.state === "ACTIVE" ? "平台已授权当前接待关系" : "咨询已结束" : "选择类型后创建独立咨询";

  const consultationView = <section className={`support-workspace${embedded ? " support-workspace-embedded" : ""}`} data-preview={preview} aria-label="客服咨询窗口">
    <div className="support-workspace-heading">
      <div><h2>咨询窗口</h2><p>{preview ? "用一条清晰的咨询链路承接商品问题，后续由云信恢复真实会话。" : `你好，${session.displayName ?? "用户"}。咨询记录和实际接待人由平台服务端恢复。`}</p></div>
      <div className="support-heading-actions"><ConnectionState preview={preview} state={connection} error={error} />{embedded ? <button type="button" className="support-icon-button" onClick={onClose} aria-label="关闭客服窗口"><X size={18} /></button> : null}</div>
    </div>
    {error ? <div className="support-inline-error" role="alert"><CircleAlert size={15} />{error}</div> : null}
    <div className="support-workspace-grid">
      <nav className="support-conversation-list" aria-label="咨询会话">
        <div className="support-list-heading"><div><strong>咨询记录</strong><span>{preview ? "演示" : "平台记录"}</span></div><span className="support-list-count">{preview ? PREVIEW_CONVERSATIONS.length : consultations.length}</span></div>
        {preview ? PREVIEW_CONVERSATIONS.map((conversation) => <button key={conversation.id} type="button" className="support-conversation-item" data-active={conversation.id === activeId} onClick={() => { setIsStartingNew(false); setActiveId(conversation.id); }} aria-current={conversation.id === activeId ? "page" : undefined}><span className="support-conversation-avatar" aria-hidden="true"><Headphones size={14} /></span><span className="support-conversation-copy"><strong>{conversation.title}</strong><span>{conversation.preview}</span></span><span className="support-conversation-meta"><time>{conversation.time}</time>{conversation.unread ? <b>{conversation.unread}</b> : null}</span></button>) : consultations.length > 0 ? consultations.map((consultation) => <button key={consultation.id} type="button" className="support-conversation-item" data-active={consultation.id === activeId} onClick={() => { setIsStartingNew(false); setActiveId(consultation.id); setSelectedType(consultation.type); }} aria-current={consultation.id === activeId ? "page" : undefined}><span className="support-conversation-avatar" aria-hidden="true"><Headphones size={14} /></span><span className="support-conversation-copy"><strong>{typeLabel(consultation.type)}</strong><span>{consultation.messageScopeState === "FAILED" ? "云信会话待人工核验" : consultation.assignedAdmin?.name ? `客服 ${consultation.assignedAdmin.name}` : consultation.state === "WAITING" ? "等待客服接待" : "咨询已结束"}</span></span><span className="support-conversation-meta"><time>{consultation.messageScopeState === "FAILED" ? "待核验" : consultation.state === "WAITING" ? "等待中" : consultation.state === "ACTIVE" ? "进行中" : "已结束"}</time></span></button>) : <div className="support-list-empty"><Headphones size={22} /><strong>还没有咨询记录</strong><span>选择类型后开始一次站内咨询，登录账号会自动保留记录。</span></div>}
      </nav>
      <main className="support-conversation-panel">
        <header className="support-conversation-heading"><div className="support-conversation-identity"><span className="support-live-dot" data-state={activeConversation?.state === "ACTIVE" ? "active" : "idle"} aria-hidden="true" /><div><h3>{currentTitle}</h3><span>{currentSubtitle}</span></div></div>{!preview && activeConversation?.state === "CLOSED" ? <button type="button" className="button secondary" data-action="start-new-consultation" onClick={beginNewConsultation}>再次咨询</button> : <button type="button" className="support-icon-button" aria-label="更多会话操作" disabled><span aria-hidden="true">•••</span></button>}</header>
        <div className="support-message-area">
           {!preview && !activeConversation ? <div className="support-start-panel" data-state={isStartingNew ? "new" : "initial"}><Headphones size={27} /><strong>{isStartingNew ? "发起新的咨询" : "从这里开始你的咨询"}</strong><span>每种类型会保留独立的咨询记录，客服接待后才能发送消息。</span><SupportTypePicker value={selectedType} onChange={setSelectedType} disabled={busy} /><button type="button" className="button primary" data-action={isStartingNew ? "submit-new-consultation" : "start-consultation"} onClick={() => void startConsultation()} disabled={busy}><SendHorizontal size={15} />{busy ? "创建中…" : `开始${typeLabel(selectedType)}`}</button></div> : !preview && activeConversation?.state === "WAITING" ? <div className="support-start-panel"><Clock3 size={27} /><strong>已记录，等待客服接待</strong><span>平台正在寻找当前在线且有接待容量的客服；接待关系建立后会自动恢复消息入口。</span></div> : !preview && activeConversation?.messageScopeState === "FAILED" ? <div className="support-start-panel"><CircleAlert size={27} /><strong>客服会话待人工核验</strong><span>平台暂时无法确认云信远端动作是否完成，已暂停发送和自动重试。请稍后再试或联系平台处理。</span></div> : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor"><MessageScrollerPrimitive.Root className="support-message-scroller"><MessageScrollerPrimitive.Viewport aria-label="消息内容"><MessageScrollerPrimitive.Content className="support-message-content">{activeMessages.length > 0 ? activeMessages.map((message) => <MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"}><MessageRow message={message} /></MessageScrollerPrimitive.Item>) : <MessageScrollerPrimitive.Item messageId="empty"><div className="support-message-empty"><Headphones size={24} /><strong>等待第一条消息</strong><span>{preview ? "可以从下方快捷回复开始检查交互。" : "建立云信连接后，消息会出现在这里。"}</span></div></MessageScrollerPrimitive.Item>}</MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport><MessageScrollerPrimitive.Button direction="end" className="support-jump-button" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={14} aria-hidden="true" /></MessageScrollerPrimitive.Button></MessageScrollerPrimitive.Root></MessageScrollerPrimitive.Provider>}
        </div>
        <div className="support-composer-wrap">
          {preview ? <div className="support-quick-replies" aria-label="快捷回复"><span>快捷回复</span>{["我先帮你确认一下", "请稍等，我正在核对"].map((reply) => <button key={reply} type="button" onClick={() => chooseQuickReply(reply)}>{reply}</button>)}</div> : null}
          {attachment ? <div className="support-attachment" data-slot="attachment"><Paperclip size={14} /><span>{attachment}</span><button type="button" onClick={() => setAttachment(null)} aria-label="移除附件">×</button></div> : null}
          <form className="support-composer" onSubmit={sendMessage}><textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={preview ? "输入咨询内容…" : activeConversation?.messageScopeState === "FAILED" ? "客服会话待人工核验，暂不可发送" : canSend ? "输入咨询内容…" : "等待客服接待后可发送消息"} aria-label="输入咨询内容" rows={2} disabled={!canSend || busy} /><div className="support-composer-actions"><label className="support-icon-button" aria-label="添加附件"><FileUp size={16} /><input ref={fileInputRef} type="file" onChange={(event) => setAttachment(event.target.files?.[0]?.name ?? null)} disabled={!preview || busy} /></label><span>{preview ? "仅本地演示，不会发送到云信" : activeConversation?.messageScopeState === "FAILED" ? "远端状态待人工核验" : canSend ? "消息由云信实时传输" : "当前不可发送"}</span><button type="submit" className="button primary" disabled={!canSend || busy || (!draft.trim() && !attachment)}><SendHorizontal size={15} />{busy ? "发送中…" : "发送"}</button></div></form>
        </div>
      </main>
      <aside className="support-context-panel" aria-label="商品上下文"><div className="support-context-heading"><div><strong>商品上下文</strong><span>{preview ? "演示快照" : "服务端授权快照"}</span></div><span className="support-context-dot" aria-hidden="true" /></div>{preview ? <article className="support-product-card" data-slot="attachment"><div className="support-product-card-top"><span>zzsh.im-card</span><span>v1</span></div><h3>{PREVIEW_PRODUCT.title}</h3><p>{PREVIEW_PRODUCT.summary}</p><dl><div><dt>状态</dt><dd>{PREVIEW_PRODUCT.statusText}</dd></div><div><dt>费用</dt><dd>{PREVIEW_PRODUCT.priceText}</dd></div></dl><div className="support-product-card-id">商品 ID · {PREVIEW_PRODUCT.objectId}</div></article> : <div className="support-context-empty"><Headphones size={20} /><strong>{subjectRef ? "已带入公开对象" : "暂无商品上下文"}</strong><span>{subjectRef ? `对象 ${subjectRef} 会在服务端重新校验后展示。` : "从公开商品页发起咨询后，会在这里显示经过授权的快照。"}</span></div>}<div className="support-context-note"><ShieldCheck size={15} /><p>商品卡只展示服务端确认的公开快照；接入后点击商品仍需重新校验当前权限。</p></div></aside>
    </div>
  </section>;
  return <>
    {!preview?<nav className="order-team-toolbar" aria-label="沟通类型"><button type="button" aria-pressed={section==="consultation"} onClick={()=>setSection("consultation")}>平台咨询</button><button type="button" aria-pressed={section==="orders"} onClick={()=>setSection("orders")}>我的订单群</button>{section==="orders"&&onClose?<button type="button" onClick={onClose}>关闭订单群窗口</button>:null}</nav>:null}
    <div hidden={section!=="consultation"}>{consultationView}</div>
    {!preview?<OrderTeamPanel key={currentIdentity} identity={currentIdentity} realm="user" client={clientRef.current} connection={connection} active={section==="orders"} initialParty={initialOrderParty}
      request={orderRequest} onAuthError={()=>{void session.confirm();}}/>:null}
  </>;
}
