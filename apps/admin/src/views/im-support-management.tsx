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
import { SupportMessageBody } from "./im-support-message-body";
import "./im-support-patrol.css";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import "@zzsh/ui/message-media.css";
import { decodeImSystemNotice } from "@zzsh/im-client/message-state";
import { AdminApiError, friendlyError } from "../api";
import { SupportDashboard } from "./im-support-statistics";
import { SupportInfoHint } from "./im-support-report-range";
export { SupportDashboard } from "./im-support-statistics";
import { SupportAssistantSettings } from "./im-support-settings";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "../components/ui/message";
import { EntityPreviewTrigger, UserPreviewCard, UserProfilePreview } from "../components/admin-preview";
import { AdminMemberPreviewCard } from "./im-support-group-settings";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatListTime, formatTime, initialOf } from "./im-support-format";
import {
  auditConversationsPath, auditMessagesPath, auditStateLabel, auditTypeLabel,
  parseAuditConversations, parseAuditMessages, mergeAuditMessages, withinTimeFilter,
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
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [messageState, setMessageState] = useState<"idle" | LoadState>("idle");
  const [messageError, setMessageError] = useState("");
  const [earlierError, setEarlierError] = useState("");
  const [messageReloadToken, setMessageReloadToken] = useState(0);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const earlierAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const initialScrollRef = useRef(false);
  const listOwnerRef = useRef(currentAdminUserId);

  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;
  const selectedConversationRef = useRef(selected?.conversationId);
  selectedConversationRef.current = selected?.conversationId;
  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;
  const selectedHistoryStateRef = useRef(selected?.historyState);
  selectedHistoryStateRef.current = selected?.historyState;

  // Render-time scope changes invalidate old responses before effects or paint.
  const listGenerationRef = useRef(0);
  const moreRequestRef = useRef(0);
  const messageGenerationRef = useRef(0);
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
  const messageScope = `${active ? 1 : 0}|${currentAdminUserId ?? ""}|${selected?.id ?? ""}|${selected?.type ?? ""}|${selected?.conversationId ?? ""}|${selected?.historyState ?? "MISSING"}|${messageReloadToken}`;
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
          setListError(accessDenialText(status, "list"));
          clearMessageView("idle");
          return;
        }
        setListState("error");
        setListError(friendlyError(error));
      });
    return () => { cancelled = true; };
  }, [active, type, adminId, request, currentAdminUserId, reloadToken, clearMessageView]);

  useEffect(() => {
    clearMessageView("idle");
    const generation = messageGenerationRef.current;
    if (!active || !selected) {
      return () => { messageGenerationRef.current += 1; };
    }
    const historyReadable = canReadPatrolHistory(selected);
    if (!selected.conversationId || !historyReadable) {
      setMessageState("ready");
      return () => { messageGenerationRef.current += 1; };
    }
    let cancelled = false;
    setMessageState("loading");
    void request<unknown>(auditMessagesPath(selected.conversationId))
      .then((value) => {
        if (cancelled || generation !== messageGenerationRef.current) return;
        const page = parseAuditMessages(value);
        initialScrollRef.current = true;
        setMessages(page.messages);
        setMessageCursor(page.nextCursor);
        setMessageState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== messageGenerationRef.current) return;
        const status = statusOf(error);
        if (isAccessDenied(status)) {
          clearMessageView("forbidden");
          setMessageError(accessDenialText(status, "messages"));
          return;
        }
        setMessageState("error");
        setMessageError(friendlyError(error));
      });
    return () => {
      cancelled = true;
      messageGenerationRef.current += 1;
    };
  }, [active, currentAdminUserId, selected?.id, selected?.conversationId, selected?.historyState, request, messageReloadToken, clearMessageView]);

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
    if (!active || !selected?.conversationId || !canReadPatrolHistory(selected) || !messageCursor || readingEarlier) return;
    const generation = messageGenerationRef.current;
    setReadingEarlier(true);
    setEarlierError("");
    const expectedId = selected.id;
    const expected = selected.conversationId;
    const expectedIsOrder = selected.type === "ORDER";
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
      const stillReadable = selectedHistoryStateRef.current
        ? selectedHistoryStateRef.current === "AVAILABLE"
        : expectedIsOrder && selectedConversationRef.current === expected;
      if (generation !== messageGenerationRef.current
        || selectedIdRef.current !== expectedId
        || selectedConversationRef.current !== expected
        || !stillReadable) return;
      setMessages((current) => mergeAuditMessages(current, page.messages));
      setMessageCursor(page.nextCursor);
    } catch (error) {
      if (generation !== messageGenerationRef.current
        || selectedIdRef.current !== expectedId
        || selectedConversationRef.current !== expected) return;
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
      <p className="im-wb-filter-note">状态和时间仅筛选已加载会话。</p>
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
              <time>{item.lastMessageAt ? formatListTime(item.lastMessageAt) : "—"}</time>
            </span>
            <span className="im-wb-row-snip">
              {item.type === "ORDER" ? `订单 ${item.displayNo ?? "编号未提供"}${item.gameName ? ` · ${item.gameName}` : ""}` : `${safeIdentityName(item.userName) ?? "会话成员"} · 客服 ${item.adminName}`}
            </span>
            <span className="im-wb-row-foot">
              <em data-state={auditStateLabel(item.state)}>{auditStateLabel(item.state)}</em>
              {item.adminUnreadCount ? <span className="im-wb-unread-pill" title="接待方未读">接待未读 {item.adminUnreadCount}</span> : null}
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
            <span>{auditTypeLabel(selected.type)} · {auditStateLabel(selected.state)} · 当前接待：{selected.adminName}</span>
          </div>
          <div className="im-wb-chat-actions">
            <Badge variant="outline">只读巡视</Badge>
            <SupportInfoHint label="巡视操作说明">参与订单群请使用成员邀请；交接会话请在客服工作台转交。</SupportInfoHint>
          </div>
        </header>
        {messageState === "ready" && (messageCursor || earlierError) ? <div className="im-wb-patrol-history">
          {earlierError ? <span className="im-wb-history-error" role="alert">{earlierError}</span> : null}
          <button type="button" disabled={readingEarlier} onClick={() => void loadEarlier()}>{readingEarlier ? "正在读取更早消息…" : earlierError ? "重新读取更早消息" : "更早的消息"}</button>
        </div> : null}
        {/* Static history: no live follow; the load control stays out of the prepend list. */}
        <MessageScrollerPrimitive.Provider defaultScrollPosition="last-anchor">
          <div className="im-wb-stream-wrap"><MessageScrollerPrimitive.Root className="im-wb-scroller">
            <MessageScrollerPrimitive.Viewport ref={viewportRef} preserveScrollOnPrepend={false} className="im-wb-viewport im-wb-mgmt-viewport" aria-label="只读会话消息">
              <MessageScrollerPrimitive.Content className="im-wb-content im-wb-patrol-content">
                {messageState === "loading" ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
                  : messageState === "forbidden" ? <div className="im-wb-empty"><ShieldCheck size={22} aria-hidden="true" /><strong>无权查看该会话消息</strong><span>{messageError}</span></div>
                    : <>
                      {messageState === "error" ? <div className="im-wb-empty"><CircleAlert size={22} aria-hidden="true" /><strong>消息读取失败</strong><span>{messageError}</span><Button variant="outline" size="sm" onClick={() => setMessageReloadToken(token => token + 1)}>重新读取</Button></div> : null}
                      {messages.length ? <AuditTimeline messages={messages} request={request} onOpenProfile={onOpenProfile} /> : messageState !== "error" ? <div className="im-wb-empty"><Headphones size={22} aria-hidden="true" /><strong>
                        {selected.historyState === "NOT_ESTABLISHED" ? "会话通道尚未建立"
                          : selected.historyState === "LEGACY_UNAVAILABLE" ? "历史会话暂不可读"
                            : selected.historyState === "RECOVERING" ? "会话通道恢复中，请稍后刷新"
                              : !selected.historyState && selected.type !== "ORDER" ? "历史状态尚未提供，暂不读取"
                                : selected.historyState && selected.historyState !== "AVAILABLE" ? "历史状态暂不支持读取，请刷新核对"
                                  : messageCursor ? "当前页没有可显示消息，可继续读取更早记录"
                                    : selected.conversationId ? "该会话暂无可读消息" : "会话消息尚未就绪"}
                      </strong></div> : null}
                    </>}
              </MessageScrollerPrimitive.Content>
            </MessageScrollerPrimitive.Viewport>
            <MessageScrollerPrimitive.Button direction="end" className="im-wb-jump" render={<button type="button" aria-label="跳到最新消息" title="跳到最新消息" />}><ArrowDown size={13} aria-hidden="true" /></MessageScrollerPrimitive.Button>
          </MessageScrollerPrimitive.Root></div>
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

function AuditTimeline({ messages, request, onOpenProfile }: { messages: AuditMessage[]; request: SupportManagementRequest; onOpenProfile?: (userId: string) => void }) {
  let timelineDay = "";
  const nodes: ReactNode[] = [];
  let notices: AuditMessage[] = [];
  let previous: AuditMessage | undefined;
  const messageKey = (message: AuditMessage) => message.messageServerId || message.messageClientId;
  const flushNotices = () => {
    if (!notices.length) return;
    const group = notices; notices = [];
    const id = `notices-${messageKey(group[0]!)}`;
    nodes.push(<MessageScrollerPrimitive.Item key={id} messageId={id}><details className="im-wb-patrol-notices"><summary>平台系统通知 · {group.length} 条</summary>{group.map(message => <p key={messageKey(message)}><time>{formatTime(message.createTime)}</time><span>{decodeImSystemNotice(message)?.text}</span></p>)}</details></MessageScrollerPrimitive.Item>);
  };
  for (const message of messages) {
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      flushNotices(); previous = undefined; timelineDay = dayKey;
      nodes.push(<MessageScrollerPrimitive.Item key={`day-${dayKey}`} messageId={`day-${dayKey}`}><Marker className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker></MessageScrollerPrimitive.Item>);
    }
    // Generic NIM team notices never prove reception; keep them collapsed.
    if (!message.revoked && decodeImSystemNotice(message)) { notices.push(message); previous = undefined; continue; }
    flushNotices();
    const sender = message.sender;
    const platform = sender?.role === "ADMIN", assistant = sender?.role === "SYSTEM";
    const name = safeIdentityName(sender?.displayName, message.senderId) ?? "会话成员";
    const grouped = Boolean(!assistant && previous && previous.senderId === message.senderId && message.createTime - previous.createTime < GROUP_WINDOW_MS);

    const role = roleLabel(sender?.role);
    const cardText = message.card ? `${CARD_LABELS[message.card.kind] ?? "订单动态"}${message.text ? `\n${message.text}` : ""}` : message.text;
    const key = messageKey(message);
    nodes.push(<MessageScrollerPrimitive.Item key={key} messageId={key}>
      <Message align={platform ? "end" : "start"} className="im-wb-msg" data-self={platform} data-grouped={grouped} data-message-id={key}>
        <SenderPreview sender={sender} name={name} request={request} onOpenProfile={onOpenProfile} avatar><MessageAvatar className="im-wb-av" aria-hidden="true">{assistant ? <img src="/art/zhouzhou/avatar.webp" alt="" /> : <ProfileImage src={sender?.avatar} fallback={initialOf(name)} />}</MessageAvatar></SenderPreview>
        <MessageContent className="im-wb-msg-body" data-card={message.card ? "true" : undefined}>
          {grouped ? null : <MessageHeader className="im-wb-msg-meta"><SenderPreview sender={sender} name={name} request={request} onOpenProfile={onOpenProfile}><b>{name}</b></SenderPreview>{role ? <span className="im-wb-role-tag" data-role={role}>{role}</span> : null}<time>{formatTime(message.createTime)}</time></MessageHeader>}
          <SupportMessageBody message={{...message,text:cardText}} image={imageOf(message)} replySenderName={safeIdentityName(messages.find(item => item.messageClientId === message.reply?.messageId || item.messageServerId === message.reply?.messageId)?.sender?.displayName)} align={platform ? "end" : "start"} />
        </MessageContent>
      </Message>
    </MessageScrollerPrimitive.Item>);
    previous = message;
  }
  flushNotices();
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
