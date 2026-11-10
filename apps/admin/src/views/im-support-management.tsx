"use client";
import { ProfileImage } from "@zzsh/ui/profile-image";


/**
 * 客服管理入口：看板组件独立在 im-support-statistics.tsx，本文件保留子页入口与只读巡视。
 *
 * 巡视复用工作台的消息外观（文本/图片/卡片/系统事件），只读、无发送框；
 * 权限、历史状态与发送人投影都以服务端事实为准，不造数据、不补时间。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ReactElement } from "react";
import { ArrowDown, CircleAlert, Headphones, RefreshCw, ShieldCheck } from "lucide-react";
import { MessageScroller as MessageScrollerPrimitive } from "@shadcn/react/message-scroller";
import { SupportMessageBody, supportMessageSummary } from "./im-support-message-body";
import "./im-support-patrol.css";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import "@zzsh/ui/message-media.css";
import { collapseImSystemNotices, decodeImSystemNotice, imSystemNoticeLabel, type ImSystemNoticeScope } from "@zzsh/im-client/message-state";
import { AdminApiError, friendlyError } from "../api";
import { SupportDashboard } from "./im-support-statistics";
import { asRoundPage, type RoundItem } from "./im-support-events";
import { SupportInfoHint } from "./im-support-report-range";
import { ConversationMap } from "../components/assistant-ui/elements/conversation-map";
import { OrderCardMessage } from "@zzsh/ui/order-card";
import type { OrderTeamAccess } from "@zzsh/ui/order-team-panel";
export { SupportDashboard } from "./im-support-statistics";
import { SupportAssistantSettings } from "./im-support-settings";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "../components/ui/message";
import { ActionTooltip, Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { EntityPreviewTrigger, UserPreviewCard, UserProfilePreview } from "../components/admin-preview";
import { AdminMemberPreviewCard } from "./im-support-group-settings";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatListTime, formatTime, initialOf } from "./im-support-format";
import {
  auditConversationsPath, auditMessagesPath, auditStateLabel, auditTypeLabel,
  parseAuditConversations, parseAuditMessages, mergeAuditMessages, roundTimeWindow, withinTimeFilter,
  type AuditMessage, type AuditConversation, type AuditTimeFilter,
} from "./im-support-management-model";

const GROUP_WINDOW_MS = 300_000;
const CARD_LABELS: Record<string, string> = {
  ORDER_OPENING: "开租确认",
  ORDER_ENDING: "结束确认",
  ORDER_SETTLED: "结算完成",
  ORDER_CANCELLED: "订单已取消",
  ORDER_PRICE_CHANGE: "价格调整",
};

export type SupportManagementRequest = <T>(
  path: string,
  body?: Record<string, unknown>,
  method?: "GET" | "POST" | "PUT" | "DELETE",
) => Promise<T>;

type LoadState = "loading" | "ready" | "forbidden" | "error";

function statusOf(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

function isAccessDenied(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 423;
}

function accessDenialText(status: number | undefined, scope: "list" | "messages"): string {
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 423) return "登录状态已变化，请重新验证后再查看。";
  return scope === "list" ? "需要「客服管理读取」权限。" : "需要该会话的只读历史权限。";
}

/* ------------------------------ 看板 ------------------------------ */

/* ------------------------------ 巡视 ------------------------------ */

const TYPE_OPTIONS: [string, string][] = [["ALL", "全部类型"], ["SERVICE", "咨询"], ["COMPLAINT", "投诉"], ["ORDER", "订单群"]];
const STATE_OPTIONS: [string, string][] = [["ALL", "全部状态"], ["WAITING", "待接入"], ["ACTIVE", "处理中"], ["CLOSED", "已结束"]];
const TIME_OPTIONS: [string, string][] = [["all", "全部时间"], ["today", "今天"], ["7d", "近 7 天"]];

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <Select value={value} items={options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel }))} onValueChange={(next) => onChange(String(next ?? ""))}>
    <SelectTrigger size="sm" className="im-wb-mgmt-filter" aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(([optionValue, optionLabel]) => <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>)}</SelectContent>
  </Select>;
}

/** Server fallbacks and provider account ids are not a person's name. */
const GENERIC_IDENTITIES = new Set(["平台用户", "平台客服", "平台助手", "用户", "客服", "会话成员"]);
const PROVIDER_ACCOUNT = /^(zzu|zza|zzs)[A-Za-z0-9_-]{3,}$/i;

function safeIdentityName(value: string | null | undefined, senderId?: string): string | null {
  const name = value?.trim();
  if (!name || name === senderId || GENERIC_IDENTITIES.has(name) || PROVIDER_ACCOUNT.test(name)) return null;
  return name;
}

function roleLabel(role: NonNullable<AuditMessage["sender"]>["role"] | undefined): string | null {
  if (role === "ADMIN") return "平台客服";
  if (role === "SYSTEM") return "机器人";
  if (role === "USER") return "平台用户";
  return null;
}

function canReadPatrolHistory(selected: AuditConversation | null): boolean {
  if (!selected?.conversationId) return false;
  if (selected.historyState) return selected.historyState === "AVAILABLE";
  // Order DTOs have no historyState; the server only emits a team cid when READY.
  return selected.type === "ORDER";
}

/** Patrol is intentionally read-only; legacy host props are accepted but never used to grant actions. */
export function SupportPatrol({ active, request, currentAdminUserId, onOpenProfile }: {
  active: boolean;
  request: SupportManagementRequest;
  canTakeover?: boolean;
  currentAdminUserId?: string;
  currentAdminName?: string;
  onOpenConsultation?: () => void;
  onOpenProfile?: (userId: string) => void;
}) {
  const [type, setType] = useState("ALL");
  const [adminId, setAdminId] = useState("all");
  const [adminChoices, setAdminChoices] = useState<{ id: string; name: string }[]>([]);
  const [stateFilter, setStateFilter] = useState("ALL");
  const [timeFilter, setTimeFilter] = useState<AuditTimeFilter>("all");
  const [items, setItems] = useState<AuditConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState("");
  const [listMoreError, setListMoreError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AuditMessage[]>([]);
  const [orderInfo, setOrderInfo] = useState<OrderTeamAccess | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [messageState, setMessageState] = useState<"idle" | LoadState>("idle");
  const [messageError, setMessageError] = useState("");
  const [earlierError, setEarlierError] = useState("");
  const [messageReloadToken, setMessageReloadToken] = useState(0);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const [rounds, setRounds] = useState<RoundItem[]>([]);
  const [roundsFor, setRoundsFor] = useState<string | null>(null);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [roundJump, setRoundJump] = useState<{ id: string; nonce: number } | null>(null);
  const [roundJumpHint, setRoundJumpHint] = useState("");
  const [visibleRoundIds, setVisibleRoundIds] = useState<string[]>([]);
  const [supplementError, setSupplementError] = useState("");
  const [roundStatus, setRoundStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [roundError, setRoundError] = useState("");
  const [roundReloadToken, setRoundReloadToken] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const earlierAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const initialScrollRef = useRef(false);
  const lastRoundJumpRef = useRef(0);
  const roundHighlightTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const suppressRoundSyncUntilRef = useRef(0);
  const listOwnerRef = useRef(currentAdminUserId);

  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;
  const roundsCurrent = Boolean(selected && selected.type !== "ORDER" && roundsFor === selected.id);
  const patrolScope: ImSystemNoticeScope = selected?.type === "ORDER" ? "ORDER" : selected?.type === "COMPLAINT" ? "COMPLAINT" : "SERVICE";
  const primaryHistoryReadable = Boolean(selected && canReadPatrolHistory(selected));
  // Round Teams are a bounded supplement: the thread Team stays the primary, paged history.
  // shortcut: each distinct round Team reads one page; add per-Team paging if long round histories need older messages.
  const roundConversationIds = useMemo(() => {
    if (!selected || selected.type === "ORDER" || !roundsCurrent) return [] as string[];
    return [...new Set(rounds.map((round) => round.conversationId).filter((id): id is string => Boolean(id)))];
  }, [selected?.id, selected?.type, roundsCurrent, rounds]);
  const historyConversationIds = useMemo(() => {
    if (!selected) return [] as string[];
    if (selected.type === "ORDER") return selected.conversationId ? [selected.conversationId] : [];
    if (primaryHistoryReadable) {
      return selected.conversationId
        ? [selected.conversationId, ...roundConversationIds.filter((id) => id !== selected.conversationId)]
        : roundConversationIds;
    }
    // A present but unreadable thread cid must not fall through to older Teams.
    return selected.conversationId ? [] : roundConversationIds;
  }, [selected?.id, selected?.type, selected?.conversationId, primaryHistoryReadable, roundConversationIds]);
  const historyConversationKey = historyConversationIds.join("|");
  const historyReadable = historyConversationIds.length > 0;
  const historyConversationId = historyConversationIds[0] ?? null;
  const roundCount = selected?.roundCount ?? (roundsCurrent && rounds.length ? rounds.length : undefined);
  const mapEntries = useMemo(() => {
    const ordered = [...rounds].reverse();
    return ordered.map((round) => {
      const createdAt = Date.parse(round.createdAt);
      const window = roundTimeWindow(rounds, round.id);
      const first = window
        ? messages.find((message) => typeof message.createTime === "number" && !decodeImSystemNotice(message)
          && message.createTime >= window.start && message.createTime < window.end)
        : undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const item of rounds) {
        const at = Date.parse(item.createdAt);
        if (Number.isFinite(at) && at > createdAt && at < nextAt) nextAt = at;
      }
      const summary = first
        ? first.card
          ? CARD_LABELS[first.card.kind] ?? "关联订单卡"
          : supportMessageSummary(first.text ?? "").trim().slice(0, 40) || "非文字消息"
        : "";
      const startedAt = formatTime(round.createdAt);
      const closedAt = round.closedAt ? Date.parse(round.closedAt) : Number.NaN;
      const timeRange = round.state === "CLOSED"
        ? Number.isFinite(closedAt)
          ? `${startedAt}–${formatTime(closedAt)}`
          : Number.isFinite(nextAt)
            ? `${startedAt}–${formatTime(nextAt)}`
            : `${startedAt}–结束时间未记录`
        : `${startedAt} 起`;
      return {
        id: round.id,
        title: `第 ${round.roundSeq} 轮 · ${auditStateLabel(round.state)} · ${round.assignedAdmin?.name?.trim() || "未分配"}`,
        preview: [timeRange, summary].filter(Boolean).join(" · "),
      };
    });
  }, [messages, rounds]);
  const mapVisibleIds = visibleRoundIds.length ? visibleRoundIds : selectedRoundId ? [selectedRoundId] : [];
  const activeConversationRef = useRef(historyConversationId);
  activeConversationRef.current = historyConversationId;
  const activeHistoryReadableRef = useRef(historyReadable);
  activeHistoryReadableRef.current = historyReadable;
  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;

  // Render-time scope changes invalidate old responses before effects or paint.
  const listGenerationRef = useRef(0);
  const moreRequestRef = useRef(0);
  const messageGenerationRef = useRef(0);
  const roundGenerationRef = useRef(0);
  const listScopeRef = useRef("");
  const messageScopeRef = useRef("");
  const requestRef = useRef(request);
  if (requestRef.current !== request) {
    requestRef.current = request;
    listGenerationRef.current += 1;
    moreRequestRef.current += 1;
    messageGenerationRef.current += 1;
  }
  const listScope = `${active ? 1 : 0}|${currentAdminUserId ?? ""}|${type}|${adminId}|${reloadToken}`;
  if (listScope !== listScopeRef.current) {
    listScopeRef.current = listScope;
    listGenerationRef.current += 1;
    moreRequestRef.current += 1;
  }
  const messageScope = `${active ? 1 : 0}|${currentAdminUserId ?? ""}|${selected?.id ?? ""}|${selected?.type ?? ""}|${historyConversationKey}|${historyReadable ? 1 : 0}|${messageReloadToken}`;
  if (messageScope !== messageScopeRef.current) {
    messageScopeRef.current = messageScope;
    messageGenerationRef.current += 1;
  }

  const clearMessageView = useCallback((state: "idle" | LoadState = "idle") => {
    messageGenerationRef.current += 1;
    setMessages([]);
    setMessageCursor(null);
    setMessageError("");
    setEarlierError("");
    setReadingEarlier(false);
    earlierAnchorRef.current = null;
    initialScrollRef.current = false;
    setMessageState(state);
  }, []);

  useEffect(() => () => {
    if (scrollSyncFrameRef.current !== null) cancelAnimationFrame(scrollSyncFrameRef.current);
    if (roundHighlightTimerRef.current !== null) globalThis.clearTimeout(roundHighlightTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    if (listOwnerRef.current === currentAdminUserId) return;
    listOwnerRef.current = currentAdminUserId;
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setAdminChoices([]);
    setAdminId("all");
    setListState("loading");
    setListError("");
    setListMoreError("");
    clearMessageView();
  }, [currentAdminUserId, clearMessageView]);

  useEffect(() => {
    const generation = listGenerationRef.current;
    if (!active) { setLoadingMore(false); return; }
    let cancelled = false;
    setListState((current) => (current === "ready" ? "ready" : "loading"));
    setListError("");
    setListMoreError("");
    setLoadingMore(false);
    moreRequestRef.current += 1;
    void request<unknown>(auditConversationsPath({
      type: type === "ALL" ? undefined : type,
      adminUserId: adminId === "all" ? undefined : adminId,
    }))
      .then((value) => {
        if (cancelled || generation !== listGenerationRef.current) return;
        const page = parseAuditConversations(value);
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setAdminChoices((current) => {
          const seen = new Set(current.map((choice) => choice.id));
          const next = [...current];
          for (const item of page.items) {
            if (item.adminUserId && !seen.has(item.adminUserId)) {
              seen.add(item.adminUserId);
              next.push({ id: item.adminUserId, name: item.adminName || item.adminUserId });
            }
          }
          return next.length === current.length ? current : next;
        });
        setSelectedId((current) => (current && page.items.some((item) => item.id === current) ? current : null));
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== listGenerationRef.current) return;
        const status = statusOf(error);
        if (isAccessDenied(status)) {
          listGenerationRef.current += 1;
          moreRequestRef.current += 1;
          setItems([]);
          setNextCursor(null);
          setSelectedId(null);
          setAdminChoices([]);
          setListMoreError("");
          setLoadingMore(false);
          setListState("forbidden");
          setListError(type === "COMPLAINT" ? "查看投诉会话需要「投诉接待」权限。" : accessDenialText(status, "list"));
          clearMessageView("idle");
          return;
        }
        setListState("error");
        setListError(friendlyError(error));
      });
    return () => { cancelled = true; };
  }, [active, type, adminId, request, currentAdminUserId, reloadToken, clearMessageView]);

  // One round ledger per selected consultation; it only drives the jump list, not the transcript.
  useEffect(() => {
    const generation = ++roundGenerationRef.current;
    setRounds([]);
    setSelectedRoundId(null);
    setRoundJump(null);
    setRoundJumpHint("");
    setVisibleRoundIds([]);
    setRoundError("");
    lastRoundJumpRef.current = 0;
    if (!active || !selected || selected.type === "ORDER") {
      setRoundsFor(null);
      setRoundStatus("idle");
      return () => { roundGenerationRef.current += 1; };
    }
    setRoundsFor(selected.id);
    setRoundStatus("loading");
    // shortcut: the switcher lists the newest 20 rounds only; add paging if longer threads need older switches.
    void request<unknown>(`/im/consultations/${encodeURIComponent(selected.id)}/rounds?limit=20`)
      .then((value) => {
        if (generation !== roundGenerationRef.current) return;
        const page = asRoundPage(value);
        setRounds(page.rounds);
        setSelectedRoundId((current) => current && page.rounds.some((round) => round.id === current) ? current : page.rounds[0]?.id ?? null);
        setRoundStatus("ready");
      })
      .catch((error: unknown) => {
        if (generation !== roundGenerationRef.current) return;
        setRoundStatus("error");
        setRoundError(friendlyError(error));
      });
    return () => { roundGenerationRef.current += 1; };
  }, [active, selected?.id, selected?.type, request, roundReloadToken]);

  // Order-group cards need the same authorized access projection as the workbench, but read failures only affect card richness.
  useEffect(() => {
    let cancelled = false;
    setOrderInfo(null);
    if (!active || !selected || selected.type !== "ORDER") return;
    void request<unknown>(`/orders/${encodeURIComponent(selected.id)}/im?operation=read`)
      .then((value) => {
        if (cancelled) return;
        const info = value as OrderTeamAccess;
        if (info && typeof info === "object" && info.orderId === selected.id) setOrderInfo(info);
      })
      .catch(() => { if (!cancelled) setOrderInfo(null); });
    return () => { cancelled = true; };
  }, [active, selected?.id, selected?.type, request]);

  useEffect(() => {
    clearMessageView("idle");
    setSupplementError("");
    const generation = messageGenerationRef.current;
    if (!active || !selected) {
      return () => { messageGenerationRef.current += 1; };
    }
    if (!historyReadable || !historyConversationIds.length) {
      setMessageState("ready");
      return () => { messageGenerationRef.current += 1; };
    }
    let cancelled = false;
    setMessageState("loading");
    const [primary, ...supplements] = historyConversationIds;
    void Promise.allSettled([
      request<unknown>(auditMessagesPath(primary!)),
      ...supplements.map((conversationId) => request<unknown>(auditMessagesPath(conversationId))),
    ]).then(([primaryResult, ...supplementResults]) => {
      if (cancelled || generation !== messageGenerationRef.current || !primaryResult) return;
      if (primaryResult.status === "rejected") {
        const status = statusOf(primaryResult.reason);
        if (isAccessDenied(status)) {
          clearMessageView("forbidden");
          setMessageError(accessDenialText(status, "messages"));
          return;
        }
        setMessageState("error");
        setMessageError(friendlyError(primaryResult.reason));
        return;
      }
      const page = parseAuditMessages(primaryResult.value);
      const supplemental = supplementResults.flatMap((result) => result.status === "fulfilled" ? parseAuditMessages(result.value).messages : []);
      const failed = supplementResults.filter((result) => result.status === "rejected").length;
      initialScrollRef.current = true;
      setMessages(mergeAuditMessages(page.messages, supplemental));
      setMessageCursor(page.nextCursor);
      setSupplementError(failed ? `${failed} 个轮次的历史读取失败` : "");
      setMessageState("ready");
    });
    return () => {
      cancelled = true;
      messageGenerationRef.current += 1;
    };
  }, [active, currentAdminUserId, selected?.id, historyConversationKey, historyReadable, request, messageReloadToken, clearMessageView]);

  const adminOptions = useMemo<[string, string][]>(
    () => [["all", "全部客服"], ...adminChoices.map((choice) => [choice.id, choice.name] as [string, string])],
    [adminChoices],
  );

  const visibleItems = useMemo(() => items.filter((item) =>
    (adminId === "all" || item.adminUserId === adminId)
    && (stateFilter === "ALL" || item.state === stateFilter)
    && withinTimeFilter(item.lastMessageAt, timeFilter)), [items, adminId, stateFilter, timeFilter]);
  const selectedName = selected
    ? safeIdentityName(selected.type === "ORDER" ? selected.title : selected.userName) ?? "会话成员"
    : null;

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const generation = listGenerationRef.current;
    const token = ++moreRequestRef.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    setListMoreError("");
    try {
      const page = parseAuditConversations(await request(auditConversationsPath({
        type: type === "ALL" ? undefined : type,
        adminUserId: adminId === "all" ? undefined : adminId,
        cursor,
      })));
      if (generation !== listGenerationRef.current || token !== moreRequestRef.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generation !== listGenerationRef.current || token !== moreRequestRef.current) return;
      const status = statusOf(error);
      if (isAccessDenied(status)) {
        listGenerationRef.current += 1;
        moreRequestRef.current += 1;
        setItems([]);
        setNextCursor(null);
        setSelectedId(null);
        setAdminChoices([]);
        setLoadingMore(false);
        setListState("forbidden");
        setListError(accessDenialText(status, "list"));
        clearMessageView("idle");
        return;
      }
      setListMoreError(friendlyError(error));
    } finally {
      if (token === moreRequestRef.current) setLoadingMore(false);
    }
  };

  const loadEarlier = async () => {
    if (!active || !selected || !historyConversationId || !historyReadable || !messageCursor || readingEarlier) return;
    const generation = messageGenerationRef.current;
    setReadingEarlier(true);
    setEarlierError("");
    const expectedId = selected.id;
    const expected = historyConversationId;
    const viewport = viewportRef.current;
    const bounds = viewport?.getBoundingClientRect();
    const anchor = viewport && bounds
      ? [...viewport.querySelectorAll<HTMLElement>(".im-wb-msg[data-message-id]")].find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      })
      : undefined;
    earlierAnchorRef.current = anchor?.dataset.messageId ? { id: anchor.dataset.messageId, top: anchor.getBoundingClientRect().top } : null;
    try {
      const page = parseAuditMessages(await request(auditMessagesPath(expected, messageCursor)));
      if (generation !== messageGenerationRef.current
        || selectedIdRef.current !== expectedId
        || activeConversationRef.current !== expected
        || !activeHistoryReadableRef.current) return;
      setMessages((current) => mergeAuditMessages(current, page.messages));
      setMessageCursor(page.nextCursor);
    } catch (error) {
      if (generation !== messageGenerationRef.current
        || selectedIdRef.current !== expectedId
        || activeConversationRef.current !== expected) return;
      earlierAnchorRef.current = null;
      const status = statusOf(error);
      if (isAccessDenied(status)) {
        clearMessageView("forbidden");
        setMessageError(accessDenialText(status, "messages"));
        return;
      }
      setEarlierError(friendlyError(error));
    } finally {
      if (generation === messageGenerationRef.current) setReadingEarlier(false);
    }
  };

  // Read-only history opens at the latest page once; no live follow is needed.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (initialScrollRef.current) {
      initialScrollRef.current = false;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
      return;
    }
    const pending = earlierAnchorRef.current;
    if (!pending || !viewport) return;
    const restore = () => {
      const anchor = [...viewport.querySelectorAll<HTMLElement>(".im-wb-msg[data-message-id]")]
        .find((node) => node.dataset.messageId === pending.id);
      if (!anchor) return;
      const shift = anchor.getBoundingClientRect().top - pending.top;
      if (Math.abs(shift) > 1) viewport.scrollTop += shift;
    };
    restore();
    // The shared prepend guard keys off the first content item, which a stable day
    // marker can pin at index 0; keep our own visible-message anchor instead.
    // Correct once more after the scroller's mutation observer, before paint.
    const frame = requestAnimationFrame(() => {
      restore();
      earlierAnchorRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  // A round switch scrolls the shared transcript to that round's time window; it never swaps history.
  useLayoutEffect(() => {
    if (!roundJump || roundJump.nonce === lastRoundJumpRef.current || !selectedRoundId || roundJump.id !== selectedRoundId) return;
    const round = rounds.find((item) => item.id === roundJump.id);
    const matchedWindow = round ? roundTimeWindow(rounds, round.id) : null;
    if (!round || !matchedWindow || messageState !== "ready") return;
    lastRoundJumpRef.current = roundJump.nonce;
    const messageKey = (message: AuditMessage) => message.messageServerId || message.messageClientId;
    // Notifications are system lines (or hidden entirely); a round jump targets a real chat bubble.
    const ordinary = messages.filter((message) => !decodeImSystemNotice(message));
    const exact = ordinary.find((message) => typeof message.createTime === "number"
      && message.createTime >= matchedWindow.start && message.createTime < matchedWindow.end);
    const target = exact ?? ordinary.reduce<AuditMessage | null>((nearest, message) => {
      if (typeof message.createTime !== "number") return nearest;
      if (!nearest || typeof nearest.createTime !== "number") return message;
      return Math.abs(message.createTime - matchedWindow.start) < Math.abs(nearest.createTime - matchedWindow.start) ? message : nearest;
    }, null);
    if (!target) {
      setRoundJumpHint(`第 ${round.roundSeq} 轮暂无可定位消息`);
      return;
    }
    setRoundJumpHint(exact ? "" : `第 ${round.roundSeq} 轮没有普通消息，已跳到最近一条`);
    const viewport = viewportRef.current;
    const key = messageKey(target);
    const matches = [...(viewport?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])]
      .filter((item) => item.dataset.messageId === key);
    // Item wrappers and the inner bubble share the key; prefer the bubble, scroll its Item wrapper.
    const node = matches.find((item) => item.classList.contains("im-wb-msg")) ?? matches[0];
    if (!node) {
      setRoundJumpHint(`第 ${round.roundSeq} 轮消息未渲染，无法定位`);
      return;
    }
    const scrollNode = node.parentElement?.closest<HTMLElement>("[data-message-id]") ?? node;
    const highlightNode = node.classList.contains("im-wb-msg") ? node : node.querySelector<HTMLElement>(".im-wb-msg") ?? node;
    scrollNode.scrollIntoView?.({ block: "center" });
    const inViewport = () => {
      if (!viewport) return true;
      const bounds = viewport.getBoundingClientRect();
      const targetBounds = scrollNode.getBoundingClientRect();
      return targetBounds.bottom > bounds.top && targetBounds.top < bounds.bottom;
    };
    const ensureVisible = () => {
      if (inViewport()) return;
      viewport!.scrollTop = Math.max(0, scrollNode.offsetTop - Math.max(0, (viewport!.clientHeight - scrollNode.offsetHeight) / 2));
    };
    ensureVisible();
    requestAnimationFrame(ensureVisible);
    for (const previousTarget of viewport?.querySelectorAll<HTMLElement>(".im-wb-patrol-round-target") ?? []) {
      previousTarget.classList.remove("im-wb-patrol-round-target");
    }
    highlightNode.classList.add("im-wb-patrol-round-target");
    if (roundHighlightTimerRef.current !== null) globalThis.clearTimeout(roundHighlightTimerRef.current);
    roundHighlightTimerRef.current = globalThis.setTimeout(() => {
      highlightNode.classList.remove("im-wb-patrol-round-target");
      roundHighlightTimerRef.current = null;
    }, 1600);
  }, [messageState, messages, roundJump, rounds, selectedRoundId]);

  const syncSelectedRoundFromScroll = () => {
    if (scrollSyncFrameRef.current !== null) return;
    scrollSyncFrameRef.current = requestAnimationFrame(() => {
      scrollSyncFrameRef.current = null;
      if (Date.now() < suppressRoundSyncUntilRef.current) return;
      const viewport = viewportRef.current;
      if (!viewport || !rounds.length) return;
      const times = new Map<string, number>();
      for (const message of messages) {
        const key = message.messageServerId || message.messageClientId;
        if (typeof message.createTime === "number") times.set(key, message.createTime);
      }
      const bounds = viewport.getBoundingClientRect();
      const visibleTimes = new Set<number>();
      let firstVisible: number | null = null;
      for (const node of viewport.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const at = times.get(node.dataset.messageId ?? "");
        if (at === undefined) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
          visibleTimes.add(at);
          if (firstVisible === null) firstVisible = at;
        }
      }
      if (firstVisible === null) return;
      const visible = rounds.filter((item) => {
        const window = roundTimeWindow(rounds, item.id);
        return window ? [...visibleTimes].some((at) => at >= window.start && at < window.end) : false;
      }).map((item) => item.id);
      setVisibleRoundIds(visible);
      const round = rounds.find((item) => {
        const window = roundTimeWindow(rounds, item.id);
        return window ? firstVisible! >= window.start && firstVisible! < window.end : false;
      });
      if (round && round.id !== selectedRoundId) setSelectedRoundId(round.id);
    });
  };

  const selectRound = (roundId: string) => {
    suppressRoundSyncUntilRef.current = Date.now() + 500;
    setSelectedRoundId(roundId);
    setRoundJumpHint("");
    setRoundJump((current) => ({ id: roundId, nonce: (current?.nonce ?? 0) + 1 }));
  };

  const invalidateListPages = () => {
    listGenerationRef.current += 1;
    moreRequestRef.current += 1;
  };
  const refreshList = () => {
    invalidateListPages();
    setListMoreError("");
    setLoadingMore(false);
    setReloadToken((token) => token + 1);
  };
  const changeType = (next: string) => {
    invalidateListPages();
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setListMoreError("");
    setLoadingMore(false);
    setListState("loading");
    setType(next);
  };
  const changeAdmin = (next: string) => {
    if (next === adminId) return;
    invalidateListPages();
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setListMoreError("");
    setLoadingMore(false);
    setListState("loading");
    setAdminId(next);
  };

  return <div className="im-wb-mgmt-patrol" data-patrol data-state={listState}>
    <aside className="im-wb-mgmt-patrol-list" aria-label="巡视会话列表">
      <div className="im-wb-queue-head">
        <strong>会话巡视</strong>
        <b>已加载 {items.length} 条{visibleItems.length !== items.length ? `（当前筛选显示 ${visibleItems.length} 条）` : ""}</b>
        <Button variant="ghost" size="icon-sm" className="im-wb-mgmt-refresh" aria-label="刷新巡视列表" onClick={refreshList}><RefreshCw /></Button>
      </div>
      <div className="im-wb-mgmt-filters">
        <FilterSelect label="按类型筛选" value={type} options={TYPE_OPTIONS} onChange={changeType} />
        <FilterSelect label="按客服筛选" value={adminId} options={adminOptions} onChange={changeAdmin} />
        <FilterSelect label="按状态筛选" value={stateFilter} options={STATE_OPTIONS} onChange={setStateFilter} />
        <FilterSelect label="按时间筛选" value={timeFilter} options={TIME_OPTIONS} onChange={(next) => setTimeFilter(next === "today" || next === "7d" ? next : "all")} />
      </div>
      <p className="im-wb-filter-note">左侧按用户会话聚合，第 N 轮为最近轮次；状态和时间仅筛选已加载会话。</p>
      <div className="im-wb-rows">
        {listState === "loading" && !items.length ? <div className="im-wb-list-empty"><strong>正在读取会话…</strong></div> : null}
        {listState === "forbidden" ? <div className="im-wb-list-empty"><ShieldCheck size={20} aria-hidden="true" /><strong>无权查看会话巡视</strong><span>{listError || "需要「客服管理读取」权限。"}</span></div> : null}
        {listState === "error" ? <div className="im-wb-list-empty"><CircleAlert size={20} aria-hidden="true" /><strong>会话列表读取失败</strong><span>{listError}</span><Button variant="outline" size="sm" onClick={refreshList}>重新读取</Button></div> : null}
        {visibleItems.map((item) => {
          const name = safeIdentityName(item.title) ?? "会话成员";

          return <button type="button" key={item.id} className="im-wb-row" data-active={selectedId === item.id} aria-current={selectedId === item.id ? "page" : undefined}
          onClick={() => setSelectedId(item.id)}>
          <span className="im-wb-row-av" aria-hidden="true"><ProfileImage src={item.userAvatar} fallback={initialOf(name)} /></span>
          <span className="im-wb-row-copy">
            <span className="im-wb-row-top">
              <b>{name}</b>
              <i className="im-wb-tag" data-tone={item.type === "COMPLAINT" ? "warn" : "neutral"}>{auditTypeLabel(item.type)}</i>
              {item.type !== "ORDER" && item.roundSeq ? <i className="im-wb-tag" data-tone="neutral">第 {item.roundSeq} 轮</i> : null}
              <time>{item.lastMessageAt ? formatListTime(item.lastMessageAt) : "—"}</time>
            </span>
            <span className="im-wb-row-snip">
              {item.type === "ORDER" ? `订单 ${item.displayNo ?? "编号未提供"}${item.gameName ? ` · ${item.gameName}` : ""}` : `${safeIdentityName(item.userName) ?? "会话成员"} · 客服 ${item.adminName}`}
            </span>
            <span className="im-wb-row-foot">
              <em data-state={auditStateLabel(item.state)}>{auditStateLabel(item.state)}</em>
              {item.adminUnreadCount ? <ActionTooltip content="接待方未读"><span className="im-wb-unread-pill">接待未读 {item.adminUnreadCount}</span></ActionTooltip> : null}
              {item.state === "WAITING" && item.firstUserMessageAt ? (
                <span className="im-wb-waiting-time text-xs text-muted-foreground">
                  等待中 · 留言于 {formatListTime(item.firstUserMessageAt)}
                </span>
              ) : null}
              {item.addRound && item.addRound > 0 ? (
                <span className="im-wb-tag text-xs" data-tone="warn">已补派第 {item.addRound} 轮</span>
              ) : null}
              {item.remindDueAt ? (
                <span className="text-xs text-muted-foreground">提醒截止 {formatListTime(item.remindDueAt)}</span>
              ) : null}
            </span>
          </span>
        </button>;
        })}
        {listState === "ready" && !items.length ? <div className="im-wb-list-empty"><strong>暂无可巡视会话</strong><span>当前筛选条件下未查询到会话。</span></div> : null}
        {listState === "ready" && items.length > 0 && !visibleItems.length ? <div className="im-wb-list-empty"><strong>当前筛选没有匹配会话</strong><span>调整客服、状态或时间筛选。</span></div> : null}
      </div>
      {listMoreError ? <div className="im-wb-notice" data-tone="warn" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{listMoreError}</span><button type="button" disabled={loadingMore} onClick={() => void loadMore()}>重试</button></div> : null}
      {nextCursor && !listMoreError ? <button type="button" className="im-wb-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "更多会话"}</button> : null}
    </aside>

    <section className="im-wb-chat im-wb-mgmt-chat" aria-label="只读会话">
      {!selected ? <div className="im-wb-mgmt-chat-empty"><Headphones size={22} aria-hidden="true" /><strong>选择一条会话巡视</strong><span>打开即只读查看，不填写原因，也不发送消息。</span></div> : <>
        <header className="im-wb-chat-head">
          <span className="im-wb-chat-av" aria-hidden="true"><ProfileImage src={selected.userAvatar} fallback={initialOf(selectedName ?? "会话成员")} /></span>
          <div className="im-wb-chat-title">
            <h2>{selectedName}</h2>
            <span>{auditTypeLabel(selected.type)} · {auditStateLabel(selected.state)} · 最近接待：{selected.adminName} · {selected.type === "ORDER" ? "整条订单群历史" : `整条线程历史${roundCount ? `（共 ${roundCount} 轮）` : ""}`}</span>
          </div>
          <div className="im-wb-chat-actions">
            <Badge variant="outline">只读巡视</Badge>
            <SupportInfoHint label="巡视操作说明">参与订单群请使用成员邀请；交接会话请在客服工作台转交。</SupportInfoHint>
          </div>
        </header>
        {selected.type !== "ORDER" && (roundStatus === "loading" || roundStatus === "error" || roundJumpHint || supplementError) ? <div className="im-wb-patrol-round-status">
          {roundStatus === "loading" ? <span className="im-wb-patrol-round-note">正在读取轮次…</span> : null}
          {roundStatus === "error" ? <span className="im-wb-patrol-round-note" data-tone="warn" title={roundError}>轮次读取失败<button type="button" onClick={() => setRoundReloadToken((token) => token + 1)}>重试</button></span> : null}
          {roundJumpHint ? <span className="im-wb-patrol-round-note" role="status">{roundJumpHint}</span> : null}
          {supplementError ? <span className="im-wb-patrol-round-note" data-tone="warn" role="status">{supplementError}</span> : null}
        </div> : null}
        {messageState === "ready" && (messageCursor || earlierError) ? <div className="im-wb-patrol-history">
          {earlierError ? <span className="im-wb-history-error" role="alert">{earlierError}</span> : null}
          <button type="button" disabled={readingEarlier} onClick={() => void loadEarlier()}>{readingEarlier ? "正在读取更早消息…" : earlierError ? "重新读取更早消息" : "更早的消息"}</button>
        </div> : null}
        {/* Static history: no live follow; the load control stays out of the prepend list. */}
        <MessageScrollerPrimitive.Provider defaultScrollPosition="last-anchor">
          <div className="im-wb-patrol-stream">
            {selected.type !== "ORDER" && roundsCurrent && mapEntries.length ? <ConversationMap
              entries={mapEntries}
              activeId={selectedRoundId ?? undefined}
              visibleIds={mapVisibleIds}
              onSelect={selectRound}
              side="right"
              className="im-wb-patrol-map h-full shrink-0 justify-between py-2 max-sm:hidden text-popover-foreground"
            /> : null}
            <div className="im-wb-stream-wrap">
            <MessageScrollerPrimitive.Root className="im-wb-scroller">
            <MessageScrollerPrimitive.Viewport ref={viewportRef} onScroll={syncSelectedRoundFromScroll} preserveScrollOnPrepend={false} className="im-wb-viewport im-wb-mgmt-viewport" aria-label="只读会话消息">
              <MessageScrollerPrimitive.Content className="im-wb-content im-wb-patrol-content">
                {messageState === "loading" ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
                  : messageState === "forbidden" ? <div className="im-wb-empty"><ShieldCheck size={22} aria-hidden="true" /><strong>无权查看该会话消息</strong><span>{messageError}</span></div>
                    : <>
                      {messageState === "error" ? <div className="im-wb-empty"><CircleAlert size={22} aria-hidden="true" /><strong>消息读取失败</strong><span>{messageError}</span><Button variant="outline" size="sm" onClick={() => setMessageReloadToken(token => token + 1)}>重新读取</Button></div> : null}
                      {messages.length ? <AuditTimeline messages={messages} orderInfo={orderInfo} scope={patrolScope} request={request} onOpenProfile={onOpenProfile} /> : messageState !== "error" ? <div className="im-wb-empty"><Headphones size={22} aria-hidden="true" /><strong>
                        {selected.historyState === "NOT_ESTABLISHED" ? "会话通道尚未建立"
                          : selected.historyState === "LEGACY_UNAVAILABLE" ? "历史会话暂不可读"
                            : selected.historyState === "RECOVERING" ? "会话通道恢复中，请稍后刷新"
                              : !selected.historyState && selected.type !== "ORDER" ? "历史状态尚未提供，暂不读取"
                                : selected.historyState && selected.historyState !== "AVAILABLE" ? "历史状态暂不支持读取，请刷新核对"
                                  : messageCursor ? "当前页没有可显示消息，可继续读取更早记录"
                                    : historyConversationId ? "该会话暂无可读消息" : "会话消息尚未就绪"}
                      </strong></div> : null}
                    </>}
              </MessageScrollerPrimitive.Content>
            </MessageScrollerPrimitive.Viewport>
            <Tooltip>
              <TooltipTrigger render={<MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>} />
              <TooltipContent>跳到最新消息</TooltipContent>
            </Tooltip>
          </MessageScrollerPrimitive.Root></div>
          </div>
        </MessageScrollerPrimitive.Provider>
      </>}
    </section>
  </div>;
}

function imageOf(message: NimMessageLike): { url: string | null; thumbnailUrl: string | null; name: string } | null {
  if (message.messageType !== 1 || !message.attachment || typeof message.attachment !== "object") return null;
  const attachment = message.attachment as { url?: unknown; thumbUrl?: unknown; name?: unknown };
  const url = supportedImageUrl(attachment.url) ?? supportedImageUrl(attachment.thumbUrl);
  return {
    url,
    thumbnailUrl: supportedImageUrl(attachment.thumbUrl) ?? url,
    name: typeof attachment.name === "string" ? attachment.name : "会话图片",
  };
}

function SenderPreview({ sender, name, request, onOpenProfile, children, avatar = false }: {
  sender: AuditMessage["sender"]; name: string; request: SupportManagementRequest;
  onOpenProfile?: (userId: string) => void; children: ReactElement; avatar?: boolean;
}) {
  if (!sender?.platformId || (sender.role !== "USER" && sender.role !== "ADMIN")) return children;
  return <EntityPreviewTrigger
    className={avatar ? "im-wb-patrol-sender-avatar" : "min-w-0"}
    touchLabel={`预览${sender.role === "ADMIN" ? "客服" : "用户"}信息 ${name}`}
    enableTouchButton={avatar}
    trigger={<button type="button" className="im-wb-patrol-sender-trigger" aria-label={`预览${sender.role === "ADMIN" ? "客服" : "用户"} ${name}`}>{children}</button>}
    content={sender.role === "USER"
      ? onOpenProfile
        ? <UserProfilePreview userId={sender.platformId} name={name} request={request} onOpenProfile={onOpenProfile} />
        : <UserPreviewCard name={name} image={sender.avatar} canOpen={false} deniedReason="无查看用户资料权限" />
      : <AdminMemberPreviewCard member={{ avatar: sender.avatar }} name={name} displayUsername={sender.displayUsername} orderContext={false} />}
  />;
}

function AuditTimeline({ messages, orderInfo, scope, request, onOpenProfile }: { messages: AuditMessage[]; orderInfo: OrderTeamAccess | null; scope: ImSystemNoticeScope; request: SupportManagementRequest; onOpenProfile?: (userId: string) => void }) {
  let timelineDay = "";
  const nodes: ReactNode[] = [];
  let previous: AuditMessage | undefined;
  const messageKey = (message: AuditMessage) => message.messageServerId || message.messageClientId;
  const noticeOf = (message: AuditMessage) => message.revoked ? null : decodeImSystemNotice(message);
  // Same display rules as the workbench: Bot coverage hides lifecycle notices, identical consecutive ones merge.
  const timeline = collapseImSystemNotices(messages, {
    hasBotMessage: messages.some((message) => !message.revoked && message.sender?.role === "SYSTEM" && !noticeOf(message)),
    noticeOf,
  });
  for (const message of timeline) {
    const notice = noticeOf(message);
    const label = notice ? imSystemNoticeLabel(notice.kind, scope) : null;
    if (notice && label === null) { previous = undefined; continue; }
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      previous = undefined; timelineDay = dayKey;
      nodes.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><Marker className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
    }
    if (notice) {
      previous = undefined;
      const key = messageKey(message);
      nodes.push(<MessageScrollerPrimitive.Item key={key} messageId={key}><Marker className="im-wb-sys" variant="separator"><MarkerContent>{label}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
      continue;
    }
    const sender = message.sender;
    const platform = sender?.role === "ADMIN", assistant = sender?.role === "SYSTEM";
    const name = safeIdentityName(sender?.displayName, message.senderId) ?? "会话成员";
    const grouped = Boolean(!assistant && previous && previous.senderId === message.senderId && message.createTime - previous.createTime < GROUP_WINDOW_MS);

    const role = roleLabel(sender?.role);
    const cardText = message.card ? CARD_LABELS[message.card.kind] ?? "订单动态" : message.text;
    const richCard = Boolean(message.card && orderInfo
      && message.card.orderId === orderInfo.orderId
      && (!orderInfo.botAccountId || message.senderId === orderInfo.botAccountId));
    const key = messageKey(message);
    nodes.push(<MessageScrollerPrimitive.Item key={key} messageId={key}>
      <Message align={platform ? "end" : "start"} className="im-wb-msg" data-self={platform} data-grouped={grouped} data-message-id={key}>
        <SenderPreview sender={sender} name={name} request={request} onOpenProfile={onOpenProfile} avatar><MessageAvatar className="im-wb-av" aria-hidden="true">{assistant ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : <ProfileImage src={sender?.avatar} fallback={initialOf(name)} />}</MessageAvatar></SenderPreview>
        <MessageContent className="im-wb-msg-body" data-card={message.card ? "true" : undefined}>
          {grouped ? null : <MessageHeader className="im-wb-msg-meta"><SenderPreview sender={sender} name={name} request={request} onOpenProfile={onOpenProfile}><b>{name}</b></SenderPreview>{role ? <span className="im-wb-role-tag" data-role={role}>{role}</span> : null}<time>{formatTime(message.createTime)}</time></MessageHeader>}
          {richCard && orderInfo
            ? <OrderCardMessage message={message} info={orderInfo} />
            : <SupportMessageBody message={{...message,text:cardText}} image={imageOf(message)} replySenderName={safeIdentityName(messages.find(item => item.messageClientId === message.reply?.messageId || item.messageServerId === message.reply?.messageId)?.sender?.displayName)} align={platform ? "end" : "start"} />}
        </MessageContent>
      </Message>
    </MessageScrollerPrimitive.Item>);
    previous = message;
  }
  return <>{nodes}</>;
}

/* ------------------------------ 入口 ------------------------------ */

export function SupportManagementPane({ active, request, canTakeover, canConfigure = false, canConfigureIntegration = false, currentAdminUserId, currentAdminName, onOpenConsultation, onOpenProfile, demo = false, onDirtyChange, onWriteLockChange }: {
  active: boolean;
  request: SupportManagementRequest;
  canTakeover?: boolean;
  canConfigure?: boolean;
  canConfigureIntegration?: boolean;
  onDirtyChange?: (dirty:boolean)=>void;
  onWriteLockChange?: (locked:boolean)=>void;
  currentAdminUserId?: string;
  currentAdminName?: string;
  onOpenConsultation?: () => void;
  onOpenProfile?: (userId: string) => void;
  demo?: boolean;
}) {
  const [page, setPage] = useState<"dashboard" | "patrol" | "settings">("dashboard");
  return <div className="im-wb-mgmt" data-page={page}>
    <Tabs value={page} onValueChange={(value) => setPage(value === "patrol" || value === "settings" ? value : "dashboard")} className="im-wb-mgmt-tabs">
      <div className="im-wb-mgmt-head"><TabsList aria-label="客服管理子页"><TabsTrigger value="dashboard">看板</TabsTrigger><TabsTrigger value="patrol">巡视</TabsTrigger><TabsTrigger value="settings">助手设置</TabsTrigger></TabsList>{demo ? <Badge variant="outline">本地演示数据</Badge> : null}</div>
      <TabsContent value="dashboard" className="im-wb-mgmt-content im-wb-mgmt-content--scroll"><SupportDashboard active={active && page === "dashboard"} request={request} demo={demo} /></TabsContent>
      <TabsContent value="patrol" className="im-wb-mgmt-content im-wb-mgmt-content--fill"><SupportPatrol active={active && page === "patrol"} request={request} canTakeover={canTakeover} currentAdminUserId={currentAdminUserId} currentAdminName={currentAdminName} onOpenConsultation={onOpenConsultation} onOpenProfile={onOpenProfile} /></TabsContent>
      <TabsContent value="settings" keepMounted className="im-wb-mgmt-content im-wb-mgmt-content--scroll"><SupportAssistantSettings active={active && page === "settings"} request={request} canConfigure={canConfigure} canConfigureIntegration={canConfigureIntegration} demo={demo} onDirtyChange={onDirtyChange} onWriteLockChange={onWriteLockChange}/></TabsContent>
    </Tabs>
  </div>;
}
