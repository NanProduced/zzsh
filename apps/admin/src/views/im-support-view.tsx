"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { MessageActionMenu, useMessageLongPress, type MessageActionId, type MessageActionItem } from "@zzsh/ui/message-actions";
import { mediaSummaryOf, type MessageMediaDraft } from "@zzsh/ui/message-media";
import "@zzsh/ui/message-media.css";
import "@zzsh/ui/message-actions.css";
import { ImLifecycleSupersededError } from "@zzsh/im-client/lifecycle";
import { NimImageSendError, NimMediaSendError, NimTextSendError, validateNimImageFile, validateNimMediaFile, type NimMessageLike } from "@zzsh/im-client/nim-web-client";
import { isImSystemNoticeText, mergeImMessages } from "@zzsh/im-client/message-state";
import { supportMessageSummary } from "./im-support-message-body";
import { AftersaleInbox } from "./im-aftersale-inbox";
import type { AftersaleRecord } from "@zzsh/im-client/aftersale";
import { adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { confirmCurrentForbidden, isCurrentImRequest, messageAccessPath, type ImRequestKey } from "./im-support-guards";
import { canOperateSupportType, createReadClientKey, createSendCapabilityKey } from "./im-support-capabilities";
import { planSupportNotificationToggle, playSupportChime, readSupportNotificationPreference, requestSupportNotificationPermission, storeSupportNotificationPreference, supportNotificationPermission, unlockSupportAudio, useSupportUnreadNotifications, type SupportNotificationPermission } from "./im-support-notifications";
import { groupPreferenceOf, readOrderGroupPreferences, storeOrderGroupPreferences, useOrderGroupCloudPins, withGroupPreference, ORDER_GROUP_PREF_EVENT, ORDER_GROUP_SETTINGS_EVENT, type OrderGroupPreference, type OrderGroupPreferenceMap } from "./im-support-group-settings";
import { OrderWorkbenchPane } from "./im-support-orders";
import { orderStageTone, type OrderTeamListItem } from "@zzsh/ui/order-team-panel";
import "./im-support-details.css";
import { formatListTime, formatMonthDay } from "./im-support-format";
import {
  MAX_STAGED_IMAGES, SESSION_REFRESH_ERROR, QUEUE_REFRESH_ERROR, REPLY_UNCERTAIN_NOTICE, ROUND_CLOSED_NOTICE,
  readConsultationHistory, typeLabel, scopeStateLabel, stageLabelOf, stageToneOf, connectionForPresence,
  messageFromNim, httpStatus, decodeImage, readConsultations, supportPageVisible,
  type Consultation, type SupportMessage, type SupportSection, type QueueRow, type UnifiedRow, type DraftImage, type FailedText,
} from "./im-support-view-model";
import { useSupportPresence, SupportRuntimeBar, OffDutyDialog, ReceptionDialog } from "./im-support-presence";
import { SupportConsultationQueue, SupportUnifiedDirectory } from "./im-support-queue";
import { SupportChatPane, SupportDetailsPane } from "./im-support-chat";
import { SupportTransferDialog, SupportCloseRoundDialog } from "./im-support-round-dialogs";

export {
  SUPPORT_QUICK_REPLIES, readSupportQuickReplies, storeSupportQuickReplies, supportHistoryMessage,
  staleHeartbeatRetryState, presenceRuntimeState, presenceWriteSucceeded, messageFromNim, supportMessageAuthor,
} from "./im-support-view-model";
export type { QuickReplyItem } from "./im-support-view-model";


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
  const [notice, setNotice] = useState<string>();
  const {
    presence, connection, localLeader, busy, readyOperator,
    clientRef, connectionIdRef, operatorRef, operatorGenerationRef,
    beginBusy, endBusy, applyPresence, writePresence, reconnect, restartConnection,
  } = useSupportPresence({
    adminUserId: snapshot.adminUserId,
    sessionLocked: snapshot.session.locked,
    readClientKey, canRead, canPresence, setNotice,
    onQueue: (rows) => { setQueue(rows); setQueueLoaded(true); },
    onIncoming: (incoming, client) => {
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
    },
  });
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
  const [unifiedQuery, setUnifiedQuery] = useState("");
  const [searchConsultations, setSearchConsultations] = useState<Consultation[]>([]);
  const [searchOrders, setSearchOrders] = useState<OrderTeamListItem[]>([]);
  const [searchState, setSearchState] = useState<{ q: string; loading: boolean; error: string | null }>({ q: "", loading: false, error: null });
  const searchEpochRef = useRef(0);
  const [unifiedType, setUnifiedType] = useState<"ALL" | "SERVICE" | "COMPLAINT" | "ORDER">(initialUnifiedType);
  const [messages, setMessages] = useState<Record<string, SupportMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setGroupPrefs(readOrderGroupPreferences(snapshot.adminUserId));
    setGroupPrefsScope(snapshot.adminUserId);
  }, [snapshot.adminUserId]);
  // Below this width a third column leaves the chat unusable, so the case column
// starts collapsed and the operator opens it deliberately.
  const [detailsOpen, setDetailsOpen] = useState(() => !(typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width:1439px)").matches));
  const [mobilePane, setMobilePane] = useState<"queue" | "chat" | "details">("queue");
  const narrowScreen = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const viewing = active && pageVisible;
  const chatViewing = viewing && section === "consultation" && (!narrowScreen || mobilePane === "chat");
  const orderViewing = viewing && section === "orders" && (!narrowScreen || mobilePane === "chat");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"waiting" | "mine">("mine");
  const [blockedConsultations, setBlockedConsultations] = useState<Record<string, boolean>>({});

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

  const cloudPins = useOrderGroupCloudPins(clientRef.current);
  const cloudPinnedTeamIds = cloudPins.status === "CLOUD" ? cloudPins.teamIds : undefined;
  useEffect(() => { if (cloudPins.error) setNotice(cloudPins.error); }, [cloudPins.error]);
  const chatHeadingRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
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
  stagedRef.current = staged;
  pendingRef.current = pending;
  sectionRef.current = section;
  selectedIdRef.current = selectedId;
  queueRef.current = queue;

  const draftKey = selectedId ?? "";
  const setFailedFor = (id: string, value: FailedText | null) => setFailedText((current) => ({ ...current, [id]: value }));
  const failedFor = (id: string) => (id ? failedText[id] ?? null : null);
  const draft = drafts[draftKey] ?? "";
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  // 常用语/表情只插入草稿，不自动发送；发送仍由客服确认。弹层关闭由聊天组件自理。
  const insertIntoDraft = (insertion: string) => {
    const el = composerRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${insertion}${draft.slice(end)}`;
    if (next.length > 4000) return;
    setDraft(next);
    requestAnimationFrame(() => {
      el?.focus();
      const position = start + insertion.length;
      el?.setSelectionRange(position, position);
    });
  };



  // Identity/permission change: drop every private projection and every owned preview URL.
  useEffect(() => {
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




  // 日常流不代选：首次加载或队列刷新不替客服打开会话，否则未读会在没被看到时就上报。
  // 只有显式选择（点行、铃铛通知、交接清单）会设置 selectedId；选中项从目录（队列＋搜索结果）消失时才清空。
  useEffect(() => {
    if (!selectedId || consultationDirectory.some((item) => item.id === selectedId)) return;
    setSelectedId(null);
  }, [consultationDirectory, selectedId]);

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
  const handleUnifiedOrderAction = (action: MessageActionId, orderId: string, preference: OrderGroupPreference) => {
    if (action === "pin") { toggleOrderPin(orderId, orderDirectory.find((row) => row.id === orderId)?.teamId, !preference.pinned); return; }
    if (action === "mute") { applyGroupPreference(orderId, { muted: !preference.muted }); return; }
    if (action === "hide") {
      applyGroupPreference(orderId, { hidden: true });
      if (orderSelection === orderId) setOrderSelection(null);
      return;
    }
    if (action === "settings") {
      setSection("orders");
      setOrderSelection(orderId);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent(ORDER_GROUP_SETTINGS_EVENT, { detail: { orderId } })), 160);
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
  const mediaInFlight = Boolean(selectedMedia?.state === "SENDING" || mediaFlights.current.has(draftKey));
  const sendBlocked = sending || imageInFlight || mediaInFlight || selectedPending?.state === "UNKNOWN" || selectedPending?.state === "SENDING" || selectedMedia?.state === "UNKNOWN";

  /* ---------- platform message menu: copy / reply / revoke / delete ---------- */
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
      restartConnection();
      return;
    }
    // Another browser session owns reception/connection. Transfer ownership first
    // with a CONNECTING state; the effect opens NIM only after the takeover succeeds.
    if (presence.ownedByAnotherSession === true) {
      const busyOwner = beginBusy();
      setNotice(undefined);
      try {
        const value = await writePresence("AVAILABLE", "CONNECTING", { takeover: true });
        if (value && value.ownedByAnotherSession !== true) reconnect();
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




  if (snapshot.session.locked) return <section className="im-wb-root" aria-hidden="true" />;

  // Loading, empty, failed, forbidden and "not selected" are five different answers.
  const consultationPane = <div className="im-wb" data-pane={mobilePane} data-details={detailsOpen}>
    <SupportConsultationQueue query={query} onQueryChange={setQuery} filter={filter} onFilterChange={setFilter} counts={counts} rows={filteredQueue} selectedId={selectedId}
      onSelect={(row) => {
        restoredSelectionRef.current = true;
        setSelectedId(row.id);
        setMobilePane("chat");
        setNotice(undefined);
        persistQuery({ section: "consultation", consultation: row.consultation?.threadId ?? row.id });
      }} />

    <SupportChatPane
      selected={selected} selectedMessages={selectedMessages} operatorName={operatorName} operatorAvatar={snapshot.user.image}
      profileScope={profileScope} adminUserId={snapshot.adminUserId} sessionId={snapshot.session.id} permissions={snapshot.permissions}
      onOpenPath={onOpenPath} isMine={isMine} claimReady={claimReady} canManageSupport={canManageSupport} canTransfer={canTransfer}
      canOperateSelected={canOperateSelected} serverCanSend={serverCanSend} busy={busy} connection={connection} sending={sending}
      canEdit={canEdit} canSend={canSend} sendBlocked={sendBlocked} imageInFlight={imageInFlight}
      closeOutcomeUnknown={Boolean(selected && closeOutcomeUnknown[selected.id])} blocked={Boolean(selected && blockedConsultations[selected.id])}
      detailsOpen={detailsOpen} mobilePane={mobilePane} notice={notice} activeAftersale={activeAftersale}
      readOnlyReason={readOnlyReason} readOnlyPlaceholder={readOnlyPlaceholder}
      historyMore={Boolean(selected && historyMore[selected.id])} historyState={selected ? historyState[selected.id] : undefined} historyLoading={historyLoading}
      selectedFailedText={selectedFailedText} selectedPending={selectedPending} selectedMedia={selectedMedia} selectedReply={selectedReply}
      selectedStaged={selectedStaged} draft={draft}
      chatHeadingRef={chatHeadingRef} closeTriggerRef={closeTriggerRef} transferTriggerRef={transferTriggerRef} detailsTriggerRef={detailsTriggerRef} composerRef={composerRef}
      onBackToQueue={() => setMobilePane("queue")} onClaim={() => void claim()}
      onOpenClose={() => { if (!selected || !canOperateSelected || !serverCanSend || closeOutcomeUnknown[selected.id]) return; setCloseTarget(selected); setCloseOpen(true); }}
      onOpenTransfer={() => void openTransfer()}
      onToggleDetails={() => { const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches; if (narrow && mobilePane !== "details") { openDetails(); return; } if (detailsOpen) closeDetails(); else openDetails(); }}
      onReconcile={() => void reconcile()} onRetryHistory={() => setHistoryRetryToken((token) => token + 1)} onLoadEarlier={() => void loadEarlier()}
      onRetryFailedText={() => void retryFailedText(selected!.id)} onRetryPendingImage={() => void retryPendingImage()} onRemovePending={removePending}
      onRetryMedia={() => void retryMediaDraft()} onRemoveMedia={removeSelectedMedia} onClearReply={() => clearReplyFor(draftKey)}
      onSend={(event) => void send(event)} onStageFiles={stageFiles} onStageMedia={stageMediaFile} onRemoveStaged={removeStaged}
      onDraftChange={setDraft} onInsertText={insertIntoDraft} onMessageContextMenu={onMessageContextMenu} messageLongPress={messageLongPress}
      onOpenAftersale={() => setAftersaleOpen(true)} />

    <SupportDetailsPane selected={selected} profileScope={profileScope} onOpenPath={onOpenPath} blocked={Boolean(selected && blockedConsultations[selected.id])}
      busy={busy} detailsOpen={detailsOpen} onClose={closeDetails} onRefreshAccess={() => void refreshConsultationAccess()} />
  </div>;

  const contactedAftersale=(record:AftersaleRecord,id:string,threadId:string)=>{
    const expected=aftersaleScope;
    void readConsultations().then(rows=>{if(aftersaleScopeRef.current!==expected)return;
      setQueue(rows);setSection("consultation");setSelectedId(id);setMobilePane("chat");setDetailsOpen(false);
      setActiveAftersale({id:record.id,orderId:record.orderId,orderDisplayNo:record.orderDisplayNo,threadId});
      persistQuery({section:"consultation",consultation:threadId});
    }).catch(cause=>{if(aftersaleScopeRef.current===expected)setNotice(friendlyError(cause));});
  };
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
      <SupportRuntimeBar canPresence={canPresence} presence={presence} connection={connection} busy={busy} localLeader={localLeader}
        sessionLocked={snapshot.session.locked} notifyPermission={notifyPermission} notifyEnabled={notifyEnabled} notifyUnreadCount={notifyUnreadCount}
        isLocalFake={clientRef.current?.transport === "local-fake"} onToggleNotifications={() => void toggleNotifications()}
        onTogglePresence={() => void togglePresence()} onEndReception={() => void endReception()} />
    </nav>
    <div className="im-wb-unified">
      <SupportUnifiedDirectory adminUserId={snapshot.adminUserId} rows={unifiedRows} total={unifiedTotal} searchState={searchState} query={unifiedQuery} onQueryChange={setUnifiedQuery}
        unifiedType={unifiedType} onTypeChange={(value) => { setUnifiedType(value); persistQuery({ type: value === "ALL" ? null : value }); }}
        orderQueueNotice={orderQueueNotice} serverSearchActive={serverSearchActive} searchLimitReached={searchLimitReached} orderNextCursor={orderNextCursor}
        orderLoadingMore={orderLoadingMore} orderRefreshing={orderRefreshing} onLoadMore={() => void loadMoreOrders()} hiddenOrderCount={hiddenOrderCount} onRestoreHidden={restoreHiddenOrders}
        section={section} selectedId={selectedId} orderSelection={orderSelection} preferenceOf={orderPreferenceOf} teamIdOf={(orderId) => orderDirectory.find((row) => row.id === orderId)?.teamId}
        onOrderAction={handleUnifiedOrderAction}
        onSelect={(row) => {
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
        }} />
      <div className="im-wb-unified-detail">
        <div className="im-wb-pane" hidden={section !== "consultation"}>{consultationPane}</div>
        {canRead ? <div className="im-wb-pane im-wb-pane--orders" hidden={section !== "orders"}><OrderWorkbenchPane identity={readClientKey} adminUserId={snapshot.adminUserId} operatorName={operatorName}
          client={clientRef.current} connection={connection} active={section === "orders"} sendAllowed={canAccept} selectedOrderId={orderSelection} onSelectedOrderChange={setOrderSelection}
          cloudPinnedTeamIds={cloudPinnedTeamIds} onToggleCloudPin={(orderId, teamId, pinned) => toggleOrderPin(orderId, teamId, pinned)}
          canManualClose={snapshot.security.isBoss || snapshot.permissions.includes("order.settlement.write")} request={adminRequest} onAuthError={() => { void onRefresh(); }}
          onOpenProfile={profileScope.profile ? (id) => onOpenPath?.(`/users/${encodeURIComponent(id)}`, "用户资料") : undefined} onOpenPath={onOpenPath} /></div> : null}
      </div>
    </div>
    <SupportTransferDialog open={transferOpen} onOpenChange={setTransferOpen} userName={selected?.user?.name || "当前咨询"} note={transferNote} onNoteChange={setTransferNote}
      busy={transferBusy} error={transferError} state={transferState} onConfirm={(targetAdminId) => void confirmTransfer(targetAdminId)} finalFocusRef={transferTriggerRef} />
    <OffDutyDialog open={offDutyOpen} onOpenChange={setOffDutyOpen} consultations={myOpenConsultations} canTransfer={canTransfer} busy={busy}
      onGoTransfer={goTransferFromChecklist} onConfirmPause={() => { setOffDutyOpen(false); void applyPresence("OFF_DUTY"); }} />
    <ReceptionDialog open={receptionOpen} onOpenChange={setReceptionOpen} connection={connection} busy={busy} onStart={() => void startReceptionAndClaim()} />
    <SupportCloseRoundDialog open={closeOpen} onOpenChange={setCloseOpen} target={closeTarget} busy={busy} canOperateSelected={canOperateSelected}
      onConfirm={() => { if (closeTarget) void close(closeTarget.id); }} finalFocusRef={closeTriggerRef} />

    {messageMenu && menuMessage ? <MessageActionMenu key={`${messageMenu.key}:${messageMenu.id}`} x={messageMenu.x} y={messageMenu.y} items={messageMenuItems}
      onSelect={selectMessageAction} onClose={() => setMessageMenu(null)} returnFocus={messageMenu.row} /> : null}
  </div>;
}
