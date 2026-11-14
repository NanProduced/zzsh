"use client";

/**
 * 客服管理巡视：只读会话列表与消息。
 * 列表和只读会话面板在同目录；读取、轮次跳转与滚动仍在这里编排。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { decodeImSystemNotice, type ImSystemNoticeScope } from "@zzsh/im-client/message-state";
import { AdminApiError, friendlyError } from "../api";
import { asRoundPage, type RoundItem } from "./im-support-events";
import { supportMessageSummary } from "./im-support-message-body";
import "./im-support-patrol.css";
import type { OrderTeamAccess } from "@zzsh/ui/order-team-panel";
import { formatTime } from "./im-support-format";
import {
  auditConversationsPath, auditMessagesPath, auditStateLabel,
  parseAuditConversations, parseAuditMessages, mergeAuditMessages, roundTimeWindow, withinTimeFilter,
  type AuditMessage, type AuditConversation, type AuditTimeFilter,
} from "./im-support-management-model";
import type { SupportManagementRequest } from "./im-support-management";
import { CARD_LABELS, safeIdentityName } from "./im-support-management-identity";
import { PatrolSessionList } from "./im-support-management-patrol-list";
import { PatrolReadonlyChat } from "./im-support-management-patrol-chat";

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
    <PatrolSessionList
      items={items}
      visibleItems={visibleItems}
      listState={listState}
      listError={listError}
      listMoreError={listMoreError}
      loadingMore={loadingMore}
      nextCursor={nextCursor}
      type={type}
      adminId={adminId}
      stateFilter={stateFilter}
      timeFilter={timeFilter}
      adminOptions={adminOptions}
      selectedId={selectedId}
      setStateFilter={setStateFilter}
      setTimeFilter={setTimeFilter}
      changeType={changeType}
      changeAdmin={changeAdmin}
      refreshList={refreshList}
      loadMore={loadMore}
      setSelectedId={setSelectedId}
    />
    <PatrolReadonlyChat
      selected={selected}
      selectedName={selectedName}
      roundCount={roundCount}
      roundStatus={roundStatus}
      roundError={roundError}
      roundJumpHint={roundJumpHint}
      supplementError={supplementError}
      setRoundReloadToken={setRoundReloadToken}
      messageState={messageState}
      messageCursor={messageCursor}
      earlierError={earlierError}
      readingEarlier={readingEarlier}
      loadEarlier={loadEarlier}
      messageError={messageError}
      setMessageReloadToken={setMessageReloadToken}
      messages={messages}
      orderInfo={orderInfo}
      patrolScope={patrolScope}
      request={request}
      onOpenProfile={onOpenProfile}
      historyConversationId={historyConversationId}
      roundsCurrent={roundsCurrent}
      mapEntries={mapEntries}
      selectedRoundId={selectedRoundId}
      mapVisibleIds={mapVisibleIds}
      selectRound={selectRound}
      viewportRef={viewportRef}
      syncSelectedRoundFromScroll={syncSelectedRoundFromScroll}
    />
  </div>;
}
