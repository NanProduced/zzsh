"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDown, Check, CircleAlert, Headphones, SendHorizontal, ShieldCheck, UserRound, UsersRound, Wifi, WifiOff } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { ImClientLifecycle } from "@zzsh/im-client/lifecycle";
import { createLocalFakeNimWebClientFactory, createNimWebClientFactory, type NimMessageLike, type NimWebClientLike, type NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { mergeImMessages } from "@zzsh/im-client/message-state";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { confirmCurrentForbidden, isCurrentImRequest, messageAccessPath, type ImRequestKey } from "./im-support-guards";
import { canOperateSupportType, createReadClientKey, createSendCapabilityKey } from "./im-support-capabilities";
import { OrderTeamPanel } from "@zzsh/ui/order-team-panel";
import "@zzsh/ui/order-team.css";

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
type SupportMessage = { id: string; from: "customer" | "agent" | "system"; text: string; time: string; self?: boolean; createTime?: number };
type ImToken = { appKey: string; accountId: string; token: string; transport: "nim" | "local-fake" };
type Presence = { adminUserId: string; availability: "OFF_DUTY" | "AVAILABLE" | "PAUSED"; connectionState: string; activeLoad: number; version: number };
type QueueItem = { id: string; title: string; preview: string; age: string; state: "待接入" | "处理中" | "已结束" | "待核验"; unread: number; consultation?: Consultation };

const PREVIEW_QUEUE: QueueItem[] = [
  { id: "preview-product", title: "商品咨询 · 演示", preview: "可以帮我确认一下这件商品吗？", age: "刚刚", state: "处理中", unread: 2 },
  { id: "preview-general", title: "一般咨询 · 演示", preview: "连接云信后将在这里恢复历史消息", age: "2 分钟", state: "待接入", unread: 1 },
  { id: "preview-transfer", title: "转交队列 · 演示", preview: "等待另一位客服接手", age: "6 分钟", state: "已结束", unread: 0 },
];
const PREVIEW_MESSAGES: Record<string, SupportMessage[]> = {
  "preview-product": [
    { id: "system-1", from: "system", text: "本地演示数据 · 未连接云信", time: "09:41" },
    { id: "customer-1", from: "customer", text: "你好，我想了解这件商品的租期和当前可咨询状态。", time: "09:42" },
    { id: "agent-1", from: "agent", text: "你好，我来帮你确认。商品信息已附在右侧，具体规则以服务端报价和客服确认结果为准。", time: "09:43" },
  ],
  "preview-general": [],
  "preview-transfer": [],
};
const PRESENCE_SYNC_ERROR = "在线状态同步失败，请稍后重试。";
const SESSION_REFRESH_ERROR = "会话权限刷新失败，已保持当前安全状态。";
const QUEUE_REFRESH_ERROR = "咨询队列刷新失败，请稍后重试。";

function typeLabel(type: SupportType): string { return type === "COMPLAINT" ? "投诉反馈" : "在线客服"; }
function stateLabel(state: ConsultationState): QueueItem["state"] { return state === "ACTIVE" ? "处理中" : state === "WAITING" ? "待接入" : "已结束"; }
function scopeStateLabel(consultation: Consultation): QueueItem["state"] { return consultation.messageScopeState === "FAILED" ? "待核验" : stateLabel(consultation.state); }
function formatTime(value: string | number | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—";
}
function formatAge(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`;
}
function connectionForPresence(state: NimWebConnectionState | "idle" | "error"): "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "KICKED" | "AUTH_FAILED" {
  return state === "idle" ? "DISCONNECTED" : state === "error" ? "AUTH_FAILED" : state;
}
function messageFromNim(message: NimMessageLike, accountId: string): SupportMessage | null {
  if (typeof message.senderId !== "string" || !message.senderId) return null;
  const self = message.senderId === accountId;
  const text = typeof message.text === "string" && message.text.trim() ? message.text : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
  return { id: message.messageServerId || message.messageClientId || `${message.senderId}-${message.createTime}`, from: self ? "agent" : "customer", text, time: formatTime(message.createTime), self, createTime: message.createTime };
}
function httpStatus(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
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

function AdminMessage({ message }: { message: SupportMessage }) {
  if (message.from === "system") return <div className="im-support-marker" role="note"><span>{message.text}</span><time>{message.time}</time></div>;
  const outgoing = message.from === "agent";
  return <article className="im-support-message" data-from={message.from}>
    <span className="im-support-avatar" aria-hidden="true">{outgoing ? <Headphones size={14} /> : <UserRound size={14} />}</span>
    <div className="im-support-message-body"><div className="im-support-message-meta"><span>{outgoing ? "我" : "用户"}</span><time>{message.time}</time></div><div className="im-support-bubble">{message.text}</div>{outgoing ? <div className="im-support-message-status"><Check size={12} />已发送</div> : null}</div>
  </article>;
}

export function ImSupportView({ snapshot, preview = false, onRefresh }: { snapshot: Extract<SessionSnapshot, { authenticated: true }>; preview?: boolean; onRefresh: () => Promise<SessionSnapshot> }) {
  const [section,setSection]=useState<"consultation"|"orders">("consultation");
  const canRead = hasPermission(snapshot, "im.support.read");
  const canComplaint = hasPermission(snapshot, "im.support.complaint");
  const canAccept = hasPermission(snapshot, "im.support.accept");
  const canPresence = canRead && hasPermission(snapshot, "im.support.presence");
  const readClientKey = createReadClientKey({ adminUserId: snapshot.adminUserId, sessionId: snapshot.session.id, locked: snapshot.session.locked, canRead });
  const sendCapabilityKey = createSendCapabilityKey({ canAccept, canComplaint });
  const [queue, setQueue] = useState<Consultation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => preview ? PREVIEW_QUEUE[0]!.id : null);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>(() => preview ? PREVIEW_MESSAGES : {});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();
  const [blockedConsultations, setBlockedConsultations] = useState<Record<string, boolean>>({});
  const [connection, setConnection] = useState<NimWebConnectionState | "idle" | "error">(preview ? "idle" : "idle");
  const [presence, setPresence] = useState<Presence>({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
  const [busy, setBusy] = useState(false);
  const lifecycleRef = useRef<ImClientLifecycle<NimWebClientLike> | null>(null);
  const clientRef = useRef<NimWebClientLike | null>(null);
  const availabilityRef = useRef<Presence["availability"]>("OFF_DUTY");
  const presenceVersionRef = useRef<number | null>(null);
  const presenceWriteRef = useRef(Promise.resolve());
  const busyOwnerRef = useRef(0);
  const sendCapabilityRef = useRef(sendCapabilityKey);
  const canPresenceRef = useRef(canPresence);
  const operatorRef = useRef("");
  const operatorGenerationRef = useRef(0);
  const readyOperatorRef = useRef<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  const queueRef = useRef(queue);
  const operatorName = snapshot.user.displayUsername || snapshot.user.username || snapshot.user.name || "当前管理员";
  sendCapabilityRef.current = sendCapabilityKey;
  canPresenceRef.current = canPresence;
  if (operatorRef.current !== readClientKey) {
    operatorRef.current = readClientKey;
    operatorGenerationRef.current += 1;
  }
  selectedIdRef.current = selectedId;
  queueRef.current = queue;
  const draftKey = selectedId ?? "";
  const draft = drafts[draftKey] ?? "";
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const setDraftFor = (key: string, value: string) => setDrafts((current) => ({ ...current, [key]: value }));
  const beginBusy = () => {
    const owner = busyOwnerRef.current + 1;
    busyOwnerRef.current = owner;
    setBusy(true);
    return owner;
  };
  const endBusy = (owner: number) => {
    if (busyOwnerRef.current === owner) setBusy(false);
  };

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
      if (canPresenceRef.current && operatorRef.current === key && operatorGenerationRef.current === generation) {
        presenceVersionRef.current = value.version;
        setPresence(value);
      }
      return value;
    });
    presenceWriteRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [canPresence, readClientKey]);
  useEffect(() => {
    if (preview) {
      setQueue([]);
      setMessages(PREVIEW_MESSAGES);
      setDrafts({});
      setSelectedId(PREVIEW_QUEUE[0]!.id);
      setConnection("idle");
      readyOperatorRef.current = "preview";
      return;
    }
    clientRef.current = null;
    readyOperatorRef.current = null;
    setQueue([]);
    setMessages({});
    setDrafts({});
    setSelectedId(null);
    setPresence({ adminUserId: snapshot.adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, version: 0 });
    presenceVersionRef.current = null;
    availabilityRef.current = "OFF_DUTY";
    setConnection("idle");
    setNotice(undefined);
    setBlockedConsultations({});
    busyOwnerRef.current += 1;
    setBusy(false);
    presenceWriteRef.current = Promise.resolve();
  }, [readClientKey, preview, snapshot.adminUserId]);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      void onRefresh().then(() => {
        if (!cancelled) setNotice((current) => current === SESSION_REFRESH_ERROR ? undefined : current);
      }).catch(() => {
        if (!cancelled) setNotice((current) => current ?? SESSION_REFRESH_ERROR);
      }).finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onRefresh, preview]);

  useEffect(() => {
    if (preview || !canRead || snapshot.session.locked) return;
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
            .then(() => {
              if (generation === operatorGenerationRef.current && operatorRef.current === operator) {
                setNotice((current) => current === PRESENCE_SYNC_ERROR ? undefined : current);
              }
            })
            .catch(() => {
              if (generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(PRESENCE_SYNC_ERROR);
            });
        });
        client.onMessages((incoming) => {
          if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client) return;
          for (const raw of incoming) {
            const next = messageFromNim(raw, client.accountId);
            const consultation = queueRef.current.find((candidate) => candidate.state === "ACTIVE" && candidate.assignedAdmin?.id === snapshot.adminUserId && candidate.conversationId === raw.conversationId);
            if (!next || !consultation) continue;
            setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], [next]) }));
          }
        });
      } catch (cause) {
        if (!cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator) { setConnection("error"); setNotice(cause instanceof Error ? cause.message : "暂时无法打开云信客服连接。"); }
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
  }, [canPresence, canRead, readClientKey, preview, snapshot.adminUserId, writePresence]);

  useEffect(() => {
    if (preview || !canRead || readyOperatorRef.current !== readClientKey) return;
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
        if (!cancelled && generation === operatorGenerationRef.current && operatorRef.current === operator) {
          setNotice((current) => current ?? QUEUE_REFRESH_ERROR);
        }
      }).finally(() => { loading = false; });
    };
    const timer = window.setInterval(refreshQueue, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canRead, connection, readClientKey, preview]);

  useEffect(() => {
    if (preview || !canPresence || readyOperatorRef.current !== readClientKey || connection !== "CONNECTED") return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const timer = window.setInterval(() => {
      if (generation === operatorGenerationRef.current && operatorRef.current === operator) {
        void writePresence(availabilityRef.current, connectionForPresence(connection)).catch(() => undefined);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [canPresence, connection, readClientKey, preview, writePresence]);

  useEffect(() => {
    const items = preview ? PREVIEW_QUEUE : queue;
    if (selectedId && items.some((item) => item.id === selectedId)) return;
    setSelectedId(items[0]?.id ?? null);
  }, [preview, queue, selectedId]);

  const selected = preview ? null : queue.find((item) => item.id === selectedId) ?? null;
  const selectedPreview = PREVIEW_QUEUE.find((item) => item.id === selectedId) ?? PREVIEW_QUEUE[0]!;
  const selectedConversationKey = preview ? selectedPreview.id : selected?.id ?? "";
  const selectedMessages = messages[selectedConversationKey] ?? [];
  const displayQueue = useMemo<QueueItem[]>(() => preview ? PREVIEW_QUEUE : queue.map((item) => ({
    id: item.id,
    title: `${item.user?.name || item.user?.username || "用户"} · ${typeLabel(item.type)}`,
    preview: item.messageScopeState === "FAILED" ? "云信远端结果待人工核验，已暂停接待操作" : item.subjectRef ? `关联对象 ${item.subjectRef}` : item.state === "WAITING" ? "等待客服接待" : "已建立授权会话",
    age: formatAge(item.updatedAt),
    state: scopeStateLabel(item),
    unread: 0,
    consultation: item,
  })), [preview, queue]);
  const displaySelected = displayQueue.find((item) => item.id === selectedId) ?? null;
  const canOperateSelected = selected ? canOperateSupportType(selected.type, canAccept, canComplaint) : false;
  const canSend = preview || Boolean(canRead && canOperateSelected && selected?.state === "ACTIVE" && selected.conversationId && selected.messageScopeState === "READY" && !blockedConsultations[selected.id] && clientRef.current && connection === "CONNECTED");
  const currentRequestKey = (): ImRequestKey | null => {
    const consultationId = selectedIdRef.current;
    const consultation = consultationId ? queueRef.current.find((item) => item.id === consultationId) : undefined;
    return consultation ? {
      generation: operatorGenerationRef.current,
      operator: operatorRef.current,
      consultationId: consultation.id,
      conversationId: consultation.conversationId,
      sendCapability: sendCapabilityRef.current,
    } : null;
  };
  const blockCurrentConsultationOnForbidden = useCallback(async (cause: unknown, expected: ImRequestKey): Promise<void> => {
    const shouldBlock = await confirmCurrentForbidden({
      originalStatus: httpStatus(cause),
      expected,
      current: currentRequestKey(),
      getCurrent: currentRequestKey,
      recheck: (path) => adminRequest(path),
    });
    if (shouldBlock) {
      setBlockedConsultations((value) => ({ ...value, [expected.consultationId]: true }));
    }
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
        if (current && isCurrentImRequest(expected, current)) setNotice("当前咨询授权仍未恢复，请稍后重试。");
        return;
      }
      if (!current || current.generation !== generation || current.operator !== operator || !isCurrentImRequest(expected, current)) return;
      setBlockedConsultations((existing) => {
        const next = { ...existing };
        delete next[expected.consultationId];
        return next;
      });
      setNotice("已重新确认当前咨询授权，可继续发送。");
    } catch (cause) {
      const current = currentRequestKey();
      if (current && isCurrentImRequest(expected, current)) setNotice(friendlyError(cause));
    } finally {
      endBusy(busyOwner);
    }
  };

  useEffect(() => {
    if (preview || !canRead || !selected?.conversationId || connection !== "CONNECTED") return;
    const client = clientRef.current;
    if (!client) return;
    const consultation = selected;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    let cancelled = false;
    void client.getMessageHistory(consultation.conversationId!, 50).then((history) => {
      if (cancelled || generation !== operatorGenerationRef.current || operatorRef.current !== operator || clientRef.current !== client || selectedIdRef.current !== consultation.id) return;
      const rows = history.map((item) => messageFromNim(item, client.accountId)).filter((item): item is SupportMessage => Boolean(item));
      setMessages((current) => ({ ...current, [consultation.id]: mergeImMessages(current[consultation.id] ?? [], rows) }));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [canRead, connection, readClientKey, preview, selected?.conversationId, selected?.id]);

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
      setNotice("已接入这条咨询，云信会话正在恢复。");
    } catch (cause) { const current = currentRequestKey(); if (current && isCurrentImRequest(requestKey, current)) setNotice(friendlyError(cause)); } finally { endBusy(busyOwner); }
  };
  const close = async () => {
    if (!selected || selected.state !== "ACTIVE" || selected.assignedAdmin?.id !== snapshot.adminUserId || blockedConsultations[selected.id] || !canOperateSelected) return;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const consultationId = selected.id;
    const requestKey: ImRequestKey = { generation, operator, consultationId, conversationId: selected.conversationId, sendCapability: sendCapabilityKey };
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      await adminRequest<{ consultation: Consultation }>(`/im/consultations/${encodeURIComponent(consultationId)}/close`, {}, "POST");
      const current = currentRequestKey();
      if (!current || !isCurrentImRequest(requestKey, current)) return;
      setQueue((current) => current.filter((item) => item.id !== consultationId));
      if (selectedIdRef.current === consultationId) setSelectedId(null);
      setNotice("咨询已结束，审计记录已保存。");
    } catch (cause) { await blockCurrentConsultationOnForbidden(cause, requestKey); const current = currentRequestKey(); if (current && isCurrentImRequest(requestKey, current)) setNotice(friendlyError(cause)); } finally { endBusy(busyOwner); }
  };
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    const conversationKey = selectedConversationKey;
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    const consultationId = selected?.id;
    const conversationId = selected?.conversationId;
    const client = clientRef.current;
    const requestKey: ImRequestKey | undefined = consultationId && conversationId ? { generation, operator, consultationId, conversationId, sendCapability: sendCapabilityKey } : undefined;
    if (preview) {
      const next: SupportMessage = { id: `local-${Date.now()}`, from: "agent", text, time: "现在", self: true };
      setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
      setDraftFor(conversationKey, "");
      return;
    }
    if (!client || !conversationId || !consultationId) return;
    const busyOwner = beginBusy();
    setNotice(undefined);
    try {
      const sent = await client.sendText(conversationId, text);
      const next = messageFromNim(sent, client.accountId);
      if (next && generation === operatorGenerationRef.current && operatorRef.current === operator && sendCapabilityRef.current === sendCapabilityKey && selectedIdRef.current === consultationId && clientRef.current === client) {
        setMessages((current) => ({ ...current, [conversationKey]: mergeImMessages(current[conversationKey] ?? [], [next]) }));
        setDraftFor(conversationKey, "");
      }
     } catch (cause) { if (requestKey) await blockCurrentConsultationOnForbidden(cause, requestKey); if (generation === operatorGenerationRef.current && operatorRef.current === operator && sendCapabilityRef.current === sendCapabilityKey) setNotice(cause instanceof Error ? cause.message : "消息发送失败，请重试。"); } finally { endBusy(busyOwner); }
  };
  const togglePresence = async () => {
    if (!canPresence || connection !== "CONNECTED") return;
    const busyOwner = beginBusy();
    setNotice(undefined);
    const generation = operatorGenerationRef.current;
    const operator = readClientKey;
    try { await writePresence(presence.availability === "AVAILABLE" ? "OFF_DUTY" : "AVAILABLE", connectionForPresence(connection)); }
    catch (cause) { if (canPresenceRef.current && generation === operatorGenerationRef.current && operatorRef.current === operator) setNotice(friendlyError(cause)); }
    finally { endBusy(busyOwner); }
  };

  if (snapshot.session.locked) return <section className="im-support-view" aria-hidden="true" />;
  const statusText = preview ? "云信连接等待启动" : connection === "CONNECTED" ? "云信已连接" : connection === "RECONNECTING" ? "云信正在重连" : connection === "AUTH_FAILED" || connection === "error" ? "云信授权失败" : "云信连接等待启动";
  const consultationView = <section className="im-support-view" data-preview={preview} aria-label="客服工作台">
    <header className="im-support-header">
      <div><h1>客服工作台</h1><p>把咨询队列、用户会话和授权后的云信消息放在同一工作面，减少客服来回切换。</p></div>
      <div className="im-support-header-status"><span>{preview || connection === "idle" || connection === "error" ? <WifiOff size={14} /> : <Wifi size={14} />}{statusText}</span><small>{preview ? "本地演示 · 不读取真实会话" : canPresence ? `接待状态 · ${presence.availability === "AVAILABLE" ? "接待中" : "未接待"}` : "当前账号没有在线状态权限"}</small>{!preview && canPresence ? <button type="button" className="im-support-presence-toggle" onClick={() => void togglePresence()} disabled={busy || connection !== "CONNECTED"}>{presence.availability === "AVAILABLE" ? "暂停接待" : "开始接待"}</button> : null}</div>
    </header>

    {notice ? <div className="im-support-notice" role="status"><CircleAlert size={15} />{notice}</div> : null}
    <div className="im-support-grid">
      <aside className="im-support-queue" aria-label="咨询队列">
        <div className="im-support-section-heading"><div><strong>咨询队列</strong><span>{preview ? "本地演示数据" : "仅显示本人授权范围"}</span></div><b>{displayQueue.length}</b></div>
        {displayQueue.length > 0 ? displayQueue.map((item) => <button key={item.id} type="button" className="im-support-queue-item" data-active={selectedId === item.id} onClick={() => { setSelectedId(item.id); setNotice(undefined); }} aria-current={selectedId === item.id ? "page" : undefined}>
          <span className="im-support-queue-icon"><Headphones size={14} /></span><span className="im-support-queue-copy"><strong>{item.title}</strong><span>{item.preview}</span></span><span className="im-support-queue-meta"><time>{item.age}</time>{item.unread ? <b>{item.unread}</b> : null}</span><small data-state={item.state}>{item.state}</small>
        </button>) : <div className="im-support-list-empty"><Headphones size={22} /><strong>暂无可接待咨询</strong><span>用户提交咨询后，符合权限和在线容量的队列会出现在这里。</span></div>}
        <div className="im-support-queue-note"><UsersRound size={15} /><span>在线状态、接待能力和转交权限由服务端确认。</span></div>
      </aside>

      <main className="im-support-chat">
        <header className="im-support-chat-heading"><div className="im-support-chat-title"><span className="im-support-live-dot" /><div><h2>{displaySelected?.title ?? "选择一条咨询"}</h2><span>{preview ? "用户会话 · 本地演示" : selected?.messageScopeState === "FAILED" ? "用户会话 · 远端状态待人工核验" : selected ? `用户会话 · 当前客服 ${operatorName}` : "等待用户咨询"}</span></div></div><button type="button" className="im-support-quiet-action" onClick={() => setNotice("会话目标、授权关系和操作权限由服务端返回。")}>更多</button></header>
        <div className="im-support-message-area">
          {selected?.messageScopeState === "FAILED" ? <div className="im-support-empty"><CircleAlert size={23} /><strong>云信会话待人工核验</strong><span>远端动作结果尚未确认，已暂停发送和自动重试；请完成云信侧对账后再处理。</span></div> : <MessageScrollerPrimitive.Provider autoScroll defaultScrollPosition="last-anchor"><MessageScrollerPrimitive.Root className="im-support-scroller"><MessageScrollerPrimitive.Viewport aria-label="用户消息"><MessageScrollerPrimitive.Content className="im-support-message-content">{selectedMessages.length > 0 ? selectedMessages.map((message) => <MessageScrollerPrimitive.Item key={message.id} messageId={message.id} scrollAnchor={message.from === "customer"}><AdminMessage message={message} /></MessageScrollerPrimitive.Item>) : <MessageScrollerPrimitive.Item messageId="empty"><div className="im-support-empty"><Headphones size={23} /><strong>{selected ? "等待第一条消息" : "尚未选择会话"}</strong><span>{preview ? "本地演示数据不会发送到云信。" : selected ? "建立云信连接后，该会话会恢复历史消息。" : "从左侧选择已授权的咨询会话。"}</span></div></MessageScrollerPrimitive.Item>}</MessageScrollerPrimitive.Content></MessageScrollerPrimitive.Viewport><MessageScrollerPrimitive.Button direction="end" className="im-support-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={14} aria-hidden="true" /></MessageScrollerPrimitive.Button></MessageScrollerPrimitive.Root></MessageScrollerPrimitive.Provider>}
        </div>
        <form className="im-support-composer" onSubmit={send}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="输入客服消息" placeholder={canSend ? "输入回复…" : selected?.messageScopeState === "FAILED" ? "云信会话待人工核验，暂不可回复" : "接入会话并建立云信连接后可回复"} rows={2} disabled={!canSend || busy} /><div><span>{preview ? "本地演示 · 不会发送到云信" : selected?.messageScopeState === "FAILED" ? "远端状态待人工核验" : canSend ? "消息由云信实时传输" : "当前不可发送"}</span><button type="submit" className="im-support-send" disabled={!canSend || busy || !draft.trim()}><SendHorizontal size={14} />{busy ? "处理中…" : "发送"}</button></div></form>
      </main>

      <aside className="im-support-inspector" aria-label="用户与咨询上下文">
        <div className="im-support-section-heading"><div><strong>当前上下文</strong><span>{preview ? "演示快照" : "服务端授权范围"}</span></div><ShieldCheck size={15} /></div>
        {preview ? <><section className="im-support-fact-block"><span>用户</span><strong>演示用户 · 待云信确认</strong><small>本地演示数据，正式模式不会使用固定用户或消息。</small></section><section className="im-support-product"><div><span>商品卡 · zzsh.im-card</span><b>v1</b></div><h3>三角洲行动 · 资源账号</h3><p>公开商品摘要 · 仅用于检查商品卡布局</p><small>商品 ID · preview_listing_01</small></section></> : selected ? <><section className="im-support-fact-block"><span>用户</span><strong>{selected.user?.name || selected.user?.username || "平台用户"}</strong><small>咨询类型 · {typeLabel(selected.type)}<br />平台账号与 IM 身份由服务端绑定。</small></section><section className="im-support-product"><div><span>咨询对象</span><b>{selected.subjectRef ? "已带入" : "未关联"}</b></div><h3>{selected.subjectRef || "暂无公开对象"}</h3><p>{selected.subjectRef ? "对象引用已随咨询保存，展示详情前仍需服务端重新校验。" : "此咨询未携带公开商品上下文。"}</p></section></> : <section className="im-support-fact-block"><span>用户</span><strong>尚未选择咨询</strong><small>选择队列中的会话后显示服务端返回的授权上下文。</small></section>}
        <div className="im-support-actions">{!preview && selected && blockedConsultations[selected.id] ? <button type="button" data-action="refresh-consultation-access" onClick={() => void refreshConsultationAccess()} disabled={busy || !selected.conversationId}>重新确认当前授权</button> : null}{!preview && selected?.state === "WAITING" && !selected.assignedAdmin && canOperateSelected ? <button type="button" onClick={() => void claim()} disabled={busy || connection !== "CONNECTED"}>接入会话</button> : null}{!preview && selected?.state === "ACTIVE" && selected?.messageScopeState !== "FAILED" && selected.assignedAdmin?.id === snapshot.adminUserId && canOperateSelected ? <button type="button" onClick={() => void close()} disabled={busy || Boolean(blockedConsultations[selected.id])}>结束会话</button> : null}<button type="button" disabled title="转交目标列表和权限策略尚未在本轮开放">转交会话</button><p>接入、结束和转交均由服务端检查权限并记录审计事件。</p></div>
      </aside>
    </div>
  </section>;
  return <>
    {!preview?<nav className="order-team-toolbar" aria-label="沟通类型"><button type="button" aria-pressed={section==="consultation"} onClick={()=>setSection("consultation")}>平台咨询</button><button type="button" aria-pressed={section==="orders"} onClick={()=>setSection("orders")}>我参与的订单群</button></nav>:null}
    <div hidden={section!=="consultation"}>{consultationView}</div>
    {!preview&&canRead?<OrderTeamPanel key={readClientKey} identity={readClientKey} realm="admin" client={clientRef.current} connection={connection} active={section==="orders"} sendAllowed={canAccept}
      request={adminRequest} onAuthError={()=>{void onRefresh();}}/>:null}
  </>;
}
