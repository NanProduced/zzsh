"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Check, ChevronDown, ChevronRight, Clock3, House, LockKeyhole, LogIn, Pencil, RefreshCw } from "lucide-react";
import { deriveAccountTitle } from "../lib/account-title";
import { orderUrl } from "../lib/order-client";
import type { ResourceLine } from "../lib/listing-view";
import { supplyApi, SupplyRequestError, uncertainSupplyWriteFailure } from "../lib/supply-client";
import { loadSupplyIntent, prepareSupplyIntent, acceptSupplyIntent, retainUncertainSupplyIntent, clearSupplyIntent, sameSupplyIntent, SupplyIntentStorageError, type SupplyWriteIntent } from "../lib/supply-write-intent";
import { IdentityPauseGate, isCurrentQuery, mergePageById } from "../lib/supply-workspace-guards";
import type { MyAccountRow, MySupply, RentalState } from "../lib/supply-types";
import { useUserSessionStore } from "./session/user-session-provider";
import { AccountCopyInline, AccountDetail, moneyText, stateLabel } from "./supply-workspace-detail";
// 出租账号列表的 A2 收敛样式（状态分列 · 已加载筛选 chips · 往返恢复）；详情继续沿用 supply-* 规则。
import "./account/my-rental-accounts.css";

type SessionId = string | null | undefined;
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 列表一页的读取条数；短于它即证明服务端已无下一页，可显示「已加载全部」。 */
const LIST_PAGE_SIZE = 50;

type AccountStateFilter = RentalState | "ALL";
/** 每个状态使用服务端筛选和独立游标；全部不传状态。 */
const ACCOUNT_STATE_FILTERS: ReadonlyArray<{ value: AccountStateFilter; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "LISTED", label: "可出租" },
  { value: "DELISTED", label: "已下架" },
  { value: "HISTORICAL", label: "历史记录" },
  { value: "PENDING_PAYMENT", label: "待付款占用" },
  { value: "RENTED", label: "租赁中" },
  { value: "COMPLETED", label: "已完成" },
  { value: "REVIEWING", label: "审核中" },
  { value: "DRAFT", label: "待完善" },
  { value: "REJECTED", label: "已退回" },
  { value: "RESTRICTED", label: "已限制" },
  { value: "UNKNOWN", label: "待核实" },
];
const PRIMARY_ACCOUNT_STATE_VALUES: ReadonlySet<AccountStateFilter> = new Set([
  "ALL",
  "LISTED",
  "DRAFT",
  "RENTED",
  "PENDING_PAYMENT",
]);
const RENTAL_STATE_LABELS: Record<RentalState, string> = {
  RENTED: "已有订单",
  PENDING_PAYMENT: "待付款占用",
  LISTED: "可出租",
  DELISTED: "已下架",
  HISTORICAL: "历史记录",
  PAUSED: "原状态待核",
  REVIEWING: "审核中",
  DRAFT: "待完善",
  REJECTED: "已退回",
  RESTRICTED: "已限制",
  COMPLETED: "已完成",
  UNKNOWN: "待核实",
};
const ACCOUNT_MODE_LABELS: Record<string, string> = { ordinary: "普通出租", custom: "自定义出租", fast: "极速出租" };
const RENTAL_STATE_TONE: Record<RentalState, string> = {
  RENTED: "success",
  PENDING_PAYMENT: "warning",
  LISTED: "info",
  DELISTED: "unknown",
  HISTORICAL: "unknown",
  PAUSED: "warning",
  REVIEWING: "info",
  DRAFT: "unknown",
  REJECTED: "error",
  RESTRICTED: "error",
  COMPLETED: "unknown",
  UNKNOWN: "unknown",
};

/** 资料状态徽章语义色：未知枚举一律「未确认」灰态，不靠颜色单独表意（徽章始终带文字）。 */
const REVIEW_BADGE_TONE: Record<string, string | undefined> = {
  DRAFT: undefined, SUBMITTED: "info", WITHDRAWN: undefined, REJECTED: "error",
  APPROVED: "success", PUBLISHED: "success", IMPORTED_UNVERIFIED: "unknown",
};

type AccountRow = MyAccountRow;
function haffArchiveLabel(raw: string | null | undefined): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value === 0n) return null;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${fraction ? `${whole}.${fraction}` : whole.toString()} M 哈夫币`;
}
/** Only historical display facts become this read-only summary; title/price/availability are never inferred from it. */
function accountTitleFromFacts(row: AccountRow): string | null {
  const facts = row.accountDisplay?.titleFacts;
  if (!facts) return null;
  const resourceLines: ResourceLine[] = facts.haffBase ? [{
    itemId: "haff", code: "df_billable_haff", name: "哈夫币", quantity: facts.haffBase, quantityLabel: facts.haffBase, unitLabel: "哈夫币", costAmount: null, costLabel: null, unitPriceLabel: null,
  }] : [];
  const conditionLines = [
    facts.safeBox?.displayName ? { key: "safe_box_code", label: "安全箱", value: facts.safeBox.displayName } : null,
    facts.rank?.displayName ? { key: "grading_code", label: "段位", value: facts.rank.displayName } : null,
    facts.level !== null ? { key: "character_level", label: "角色等级", value: `${facts.level} 级` } : null,
    facts.vitLevel !== null ? { key: "vit_level", label: "体力", value: `${facts.vitLevel} 级` } : null,
    facts.bearLevel !== null ? { key: "bear_level", label: "负重", value: `${facts.bearLevel} 级` } : null,
  ].filter((line): line is { key: string; label: string; value: string } => Boolean(line));
  const derived = deriveAccountTitle({ resourceLines, conditionLines });
  return derived.primary && derived.primary !== "游戏账号" ? derived.primary : null;
}

function accountActiveOrderText(row: AccountRow): string | null {
  const order = row.activeOrder;
  if (!order) return null;
  if (order.status === "PENDING_PAYMENT") return "待付款";
  if (order.origin === "LEGACY") return "查看订单进度和租期";
  // shortcut: older readers project payment as opening; show a deadline after confirmed-opening provenance is versioned.
  const amount = order.ownerAmount ? `下单时的出租报价 ${moneyText(order.ownerAmount)}` : "出租报价待确认";
  return [`租客 ${order.renterName ?? "待确认"}`, "开租时间请查看订单", amount].join(" · ");
}

function accountFilter(mode: "listed" | "rented", value?: string): AccountStateFilter {
  return ACCOUNT_STATE_FILTERS.find(item => item.value === value)?.value ?? (mode === "rented" ? "RENTED" : "ALL");
}

function accountListHref(mode: "listed" | "rented", filter: AccountStateFilter, accountId?: string): string {
  const query = new URLSearchParams({ view: mode === "rented" ? "rented" : "accounts" });
  if (filter !== (mode === "rented" ? "RENTED" : "ALL")) query.set("status", filter);
  if (accountId) query.set("accountId", accountId);
  return `/account?${query}`;
}

function historicalAccountSummary(row: AccountRow): { title: string; sub: string } | null {
  const display = row.historicalRead?.display;
  if (display?.state !== "KNOWN") return null;
  const facts = display.facts;
  const haff = facts.resources?.find((resource) => resource.unit === "HAFF_BASE");
  const headline = [haffArchiveLabel(haff?.quantity), facts.attributeDisplay?.grading?.displayName, facts.attributeDisplay?.safeBox?.displayName].filter((part): part is string => Boolean(part));
  const meta = [row.display_no ? `账号 ${row.display_no}` : null, facts.attributeDisplay?.serviceWindow?.displayName, facts.attributeDisplay?.loginMethod?.displayName].filter((part): part is string => Boolean(part));
  return { title: headline.length ? headline.join(" · ") : "出租账号", sub: meta.join(" · ") };
}
/** 读取失败的归属作用域：决定顶部提示文案，避免把局部详情失败写成「账号不存在」。写动作仍回显服务端原文。 */
type AccountErrorScope = "list" | "detail" | "action";
function AccountActionError({ error, scope, onRetry }: { error: SupplyRequestError | null; scope: AccountErrorScope; onRetry?: () => void }) {
  if (!error) return null;
  // 网络未知结果保留原文与重试；403 如实表达无权；详情读取失败不覆盖成泛化的对象不存在。
  const message = error.status === 0 || scope === "action" ? error.message
    : error.status === 403 ? (scope === "detail" ? "没有权限查看该账号资料" : "没有权限查看")
    : scope === "detail" ? "账号资料读取失败"
    : error.message;
  return <div className="supply-notice is-error" role="alert"><AlertCircle size={17} /><span>{message}</span>{error.status === 0 && onRetry ? <button type="button" className="button quiet" onClick={onRetry}>重试</button> : null}</div>;
}

export function MyAccountsPanel({ mode, accountId: accountIdProp, filterParam }: { mode: "listed" | "rented"; accountId?: string; filterParam?: string }) {
  const router = useRouter();
  const sharedSession = useUserSessionStore();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [detail, setDetail] = useState<MySupply | null>(null);
  const [latest, setLatest] = useState<MySupply | null>(null);
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [nextPageCursor, setNextPageCursor] = useState<string | null>(null);
  const [lastPageSize, setLastPageSize] = useState<number | null>(null);
  const defaultState = accountFilter(mode, filterParam);
  const [stateFilter, setStateFilter] = useState<AccountStateFilter>(defaultState);
  const [moreFilters, setMoreFilters] = useState(false);
  const stateFilterRef = useRef(stateFilter), defaultStateRef = useRef(defaultState);
  stateFilterRef.current = stateFilter; defaultStateRef.current = defaultState;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<SupplyRequestError | null>(null);
  const [errorScope, setErrorScope] = useState<AccountErrorScope>("list");
  const [notice, setNotice] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const identity = useRef<SessionId>(undefined);
  const identityStatusRef = useRef<IdentityState>("checking");
  const identityPauseGate = useRef(new IdentityPauseGate());
  const controllers = useRef(new Set<AbortController>());
  const storedIntentRef = useRef<SupplyWriteIntent | null>(null);
  const [storedIntent, setStoredIntent] = useState<SupplyWriteIntent | null>(null);
  const [intentStorageIssue, setIntentStorageIssue] = useState("");
  const lastRetry = useRef<RetryTask | null>(null);
  const accountRef = useRef(accountIdProp);
  const routeAccountRef = useRef(accountIdProp);
  const listRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const nextPageCursorRef = useRef<string | null>(null);
  // F2：列表与详情生命周期分离。列表首页是否已读、详情往返的来源位置都独立于详情状态。
  const listReadyRef = useRef(false);
  const listPositionRef = useRef<{ accountId: string; scrollY: number } | null>(null);
  // 列表可见期间持续记录滚动位置：开详情不清它，返回时按来源行还原。
  const listScrollRef = useRef(0);
  const previousAccountRef = useRef(accountIdProp);

  const beginRequest = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  };
  const finishRequest = (controller: AbortController) => controllers.current.delete(controller);
  const currentContext = useCallback((context: RequestContext, signal?: AbortSignal) =>
    mounted.current && context.gameId === "accounts" && context.epoch === epoch.current && identity.current === context.identity &&
    (context.accountId === undefined || accountRef.current === context.accountId) && !signal?.aborted, []);
  const waitForIdentity = useCallback((context: RequestContext) =>
    identityPauseGate.current.wait(() => currentContext(context)), [currentContext]);
  const captureContext = (accountId = accountRef.current): RequestContext => ({ epoch: epoch.current, identity: identity.current, accountId, gameId: "accounts" });
  const setIdentityPhase = (next: IdentityState) => {
    identityStatusRef.current = next;
    setIdentityState(next);
  };

  const restoreStoredIntent = useCallback((userId: string) => {
    try {
      const record = loadSupplyIntent(userId);
      storedIntentRef.current = record; setStoredIntent(record); setIntentStorageIssue("");
    } catch {
      setIntentStorageIssue("原操作记录暂时无法读取，已阻止新操作；请保持本页并重试。");
    }
  }, []);
  const invalidateContext = useCallback((message: string, requireAuth: boolean) => {
    epoch.current += 1;
    identityPauseGate.current.cancelWaiters();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    storedIntentRef.current = null; setStoredIntent(null); setIntentStorageIssue("");
    lastRetry.current = null;
    accountRef.current = undefined;
    listReadyRef.current = false;
    listPositionRef.current = null;
    listScrollRef.current = 0;
    setRows([]);
    setDetail(null);
    setLatest(null);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    setLastPageSize(null);
    stateFilterRef.current = defaultStateRef.current; setStateFilter(defaultStateRef.current);
    setLoading(false);
    setLoadingMore(false);
    setBusy("");
    setError(null);
    setErrorScope("list");
    setNotice(message);
    setAuthRequired(requireAuth);
  }, []);
  const syncIdentity = useCallback(async (): Promise<boolean> => {
    const snapshot = sharedSession.getSnapshot();
    if (snapshot.status === "loading" || snapshot.status === "error") {
      if (snapshot.status === "error") identityPauseGate.current.markFailed();
      else identityPauseGate.current.startCheck();
      setIdentityPhase(snapshot.status === "loading" ? "checking" : "failed");
      return false;
    }
    const next = snapshot.userId;
    const previous = identity.current;
    identity.current = next;
    if (previous !== undefined && previous !== next) {
      invalidateContext("登录身份已变化，旧账号资料已清除。", !next);
      if (accountIdProp) router.replace(mode === "rented" ? "/account?view=rented" : "/account?view=accounts");
    }
    identityPauseGate.current.markConfirmed();
    if (next) restoreStoredIntent(next);
    setAuthRequired(!next);
    setIdentityPhase("confirmed");
    return !(previous !== undefined && previous !== next && accountIdProp);
  }, [sharedSession, invalidateContext, router, accountIdProp, restoreStoredIntent]);
  // 撤销私有事实：身份变化走 invalidateContext（整体清空）；详情读取 401/403/404 只撤详情，
  // 已加载列表、游标与筛选按 F2 保留，避免「开/换详情」把列表一起打掉。
  const revokeDetail = useCallback(() => { setDetail(null); setLatest(null); }, []);
  // Preserve list position and pagination, but never restore facts superseded by a confirmed detail.
  const updateListFromDetail = useCallback((next: MySupply) => {
    // Recovery can refresh another loaded row after its identity and original target were checked.
    if (!next.account) return;
    const historical = next.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED") === true;
    const closedState: RentalState | null = next.account.lifecycle === "DELISTED" ? "DELISTED"
      : next.account.lifecycle === "ARCHIVED" ? (historical ? "HISTORICAL" : "COMPLETED") : null;
    const free = next.occupancyKind === null && Array.isArray(next.blockers)
      && !next.blockers.some(reason => reason === "OCCUPIED" || reason === "OCCUPANCY_UNKNOWN");
    const filter = stateFilterRef.current;
    setRows((previous) => previous.flatMap((row) => {
      if (row.id !== next.account.id) return [row];
      if (closedState && free && filter !== "ALL" && filter !== closedState) return [];
      return [{
        ...row,
        title: next.version ? next.version.declaration?.title ?? row.title : null,
        sequence: next.version ? next.version.sequence ?? row.sequence : null,
        review_state: next.version?.reviewState ?? null,
        owner_paused: next.account.owner_paused,
        staff_restricted: next.account.staff_restricted,
        historicalRead: next.historicalRead === undefined ? row.historicalRead : next.historicalRead,
        historicalReadOnly: historical || next.version?.origin === "LEGACY_OBSERVATION" ? true : row.historicalReadOnly,
        display_no: next.account.display_no ?? null,
        ...(closedState ? { rentalState: (free ? closedState : "UNKNOWN") as RentalState, available: false,
          activeOrder: free ? null : undefined, blockers: next.blockers ?? ["OCCUPANCY_UNKNOWN"] } : {}),
      }];
    }));
  }, []);
  const revokeList = useCallback(() => {
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    listReadyRef.current = false;
    setLastPageSize(null);
    stateFilterRef.current = defaultStateRef.current; setStateFilter(defaultStateRef.current);
  }, []);
  const load = useCallback(async (requestedId?: string, append = false, page?: { cursor?: string; after?: string }, stateOverride?: AccountStateFilter) => {
    if (identityStatusRef.current !== "confirmed") return;
    if (!identity.current) {
      setAuthRequired(true);
      setLoading(false);
      return;
    }
    const id = requestedId ?? accountRef.current;
    if (!append && id !== accountRef.current) {
      accountRef.current = id;
      setDetail(null);
      setLatest(null);
    }
    const requestEpoch = epoch.current;
    const requestId = ++listRequestRef.current;
    const requestState = stateOverride ?? stateFilterRef.current;
    const pageToken = append ? (page?.cursor ? { cursor: page.cursor } : page?.after ? { after: page.after } : nextPageCursorRef.current ? { cursor: nextPageCursorRef.current } : nextCursorRef.current ? { after: nextCursorRef.current } : undefined) : undefined;
    const request = { id: requestId, key: JSON.stringify({ accountId: id ?? "", append, state: requestState, cursor: pageToken?.cursor ?? pageToken?.after ?? "" }) };
    const isCurrent = () => isCurrentQuery(request, listRequestRef.current, request.key);
    const context = captureContext(id);
    const controller = beginRequest();
    // F2：列表与详情生命周期分离——详情往返不重拉已加载列表；只有首页未读或显式翻页才请求列表。
    const needListPage = append || !listReadyRef.current;
    // 失败归属：顶部提示按读取作用域措辞，详情读取失败不写成账号不存在。
    let phase: AccountErrorScope = "list";
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      if (!(await waitForIdentity(context))) return;
      if (needListPage) {
        phase = "list";
        const params = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
        if (requestState !== "ALL") params.set("rentalState", requestState);
        if (pageToken?.cursor) params.set("cursor", pageToken.cursor);
        else if (pageToken?.after) params.set("after", pageToken.after);
        const page = await supplyApi.myAccounts(params, controller.signal);
        if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
        lastRetry.current = null;
        setRows((previous) => {
          if (!append) return page.items;
          return mergePageById(previous, page.items);
        });
        setNextCursor(page.nextCursor);
        nextCursorRef.current = page.nextCursor;
        setNextPageCursor(page.nextPageCursor ?? null);
        nextPageCursorRef.current = page.nextPageCursor ?? null;
        // 短页是「已加载全部」的唯一依据：服务端本页未给满条数即无下一页。
        setLastPageSize(page.items.length);
        listReadyRef.current = true;
        setAuthRequired(false);
      }
      if (id && !append) {
        phase = "detail";
        if (!(await waitForIdentity(context))) return;
        const next = await supplyApi.mine(id, controller.signal);
        if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
        setDetail(next);
        updateListFromDetail(next);
      }
    } catch (failure) {
      if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
      const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
      if (append && nextError.status === 409) {
        listReadyRef.current = false;
        lastRetry.current = null;
        void load(id, false, undefined, requestState);
        return;
      }
      setError(nextError);
      setErrorScope(phase);
      // 身份失效撤全部旧私有事实；403/404：详情读取只撤详情，列表读取才撤列表（F2 往返不清列表）。
      if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
      else if (nextError.status === 403 || nextError.status === 404) { if (phase === "detail") revokeDetail(); else revokeList(); }
      if (nextError.status === 0) lastRetry.current = { context, busy: append ? "accounts-more" : "accounts", run: () => load(id, append, page, requestState) };
    } finally {
      if (currentContext({ ...context, epoch: requestEpoch }, controller.signal) && isCurrent()) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
      finishRequest(controller);
    }
  }, [currentContext, waitForIdentity, revokeList, revokeDetail, updateListFromDetail]);
  useEffect(() => {
    const next = accountFilter(mode, filterParam);
    if (next === stateFilterRef.current) return;
    listReadyRef.current = false;
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    setLastPageSize(null);
    setError(null);
    stateFilterRef.current = next; setStateFilter(next);
    void load(accountIdProp, false, undefined, next);
  // The URL is the source for browser back/forward and detail reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, filterParam]);
  useEffect(() => {
    mounted.current = true;
    // F2：列表 ↔ 详情生命周期分离。详情路由（?accountId= 增删，含点击与前进/后退）只切换详情作用域：
    // 列表行、游标、筛选与 listReady 原样保留；切账号即撤旧详情，返回时按来源行恢复滚动与焦点。
    // 身份变化/401 等仍走 invalidateContext 整体作废。
    if (routeAccountRef.current !== accountIdProp) {
      routeAccountRef.current = accountIdProp;
      accountRef.current = accountIdProp;
      revokeDetail();
      // 只在“进入详情”时记录来源行与滚动；返回时由恢复效果消费后再清，避免先手清掉待恢复位置。
      if (accountIdProp) listPositionRef.current = { accountId: accountIdProp, scrollY: listScrollRef.current };
    }
    const onFocus = () => { void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); }); };
    const unsubscribeIdentity = sharedSession.subscribe(onFocus);
    void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); });
    return () => {
      mounted.current = false;
      epoch.current += 1;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      lastRetry.current = null;
      identityPauseGate.current.cancel();
      unsubscribeIdentity();
    };
  }, [accountIdProp, load, syncIdentity, sharedSession, revokeDetail]);

  // 列表可见期间持续记录滚动位置（开详情即停止更新，避免被详情页高度钳制覆盖）。
  useEffect(() => {
    if (accountIdProp) return;
    const onScroll = () => { listScrollRef.current = window.scrollY; };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [accountIdProp]);

  // 返回列表：还原记录的滚动位置，并把焦点交回来源行的标题链（Tab 序与视觉顺序一致）。
  useEffect(() => {
    if (accountIdProp) return;
    const position = listPositionRef.current;
    if (!position) return;
    listPositionRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo(0, position.scrollY);
      document.getElementById(`account-row-title-${position.accountId}`)?.focus?.({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accountIdProp]);

  const reloadDetail = async (replace = false) => {
    const id = accountRef.current;
    if (!id || identityStatusRef.current !== "confirmed" || !identity.current) return;
    const context = captureContext(id);
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const next = await supplyApi.mine(id, controller.signal);
      if (!currentContext(context, controller.signal)) return;
       if (replace) { setDetail(next); setLatest(null); setNotice("已采用最新状态。"); }
      else setLatest(next);
      updateListFromDetail(next);
      setError(null);
      lastRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        setErrorScope("detail");
        // 详情重读 401/403/404：撤旧私有详情（不显示上一次缓存），列表与游标按 F2 保留。
        if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
        else if (nextError.status === 403 || nextError.status === 404) revokeDetail();
        if (nextError.status === 0) lastRetry.current = { context, busy: "detail", run: () => reloadDetail(replace) };
      }
    } finally {
      finishRequest(controller);
    }
  };
  const finishActionResult = (record: SupplyWriteIntent, next: MySupply, context: RequestContext, message: string) => {
    if (next.account?.id !== record.accountId || next.account.game_id !== record.gameId) throw new SupplyRequestError(502, null, record.key);
    if (record.receipt?.revision && (!/^[1-9]\d*$/.test(next.account.revision) || BigInt(next.account.revision) < BigInt(record.receipt.revision))) throw new SupplyRequestError(502, null, record.key);
    if (!currentContext(context) || !sameSupplyIntent(storedIntentRef.current, record)) return;
    if (record.action === "delist" && next.account.lifecycle !== "DELISTED") throw new SupplyRequestError(502, null, record.key);
    if (!clearSupplyIntent(record)) throw new SupplyIntentStorageError();
    storedIntentRef.current = null; setStoredIntent(null); setIntentStorageIssue("");
    if (accountRef.current === record.accountId) { setDetail(next); setLatest(null); }
    updateListFromDetail(next);
    setNotice(message); lastRetry.current = null;
  };
  const executeAction = async (record: SupplyWriteIntent, context: RequestContext): Promise<void> => {
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const { action, body, key } = record;
      if (action !== "withdraw" && action !== "delist") throw new SupplyIntentStorageError();
      const next = action === "withdraw"
        ? await supplyApi.withdraw(record.accountId!, String(body.expectedRevision), String(body.versionId), key, undefined, controller.signal)
        : await supplyApi.delist(record.accountId!, String(body.expectedRevision), key, controller.signal);
      if (next.account?.id !== record.accountId || next.account.game_id !== record.gameId || typeof next.account.revision !== "string") throw new SupplyRequestError(502, null, key);
      // A late successful response still updates its original durable responsibility.
      const accepted = acceptSupplyIntent(record, { accountId: next.account.id, revision: next.account.revision, ...(next.version ? { versionId: next.version.id } : {}) });
      if (!currentContext(context, controller.signal) || !sameSupplyIntent(storedIntentRef.current, record)) return;
      storedIntentRef.current = accepted; setStoredIntent(accepted);
      const refund = next.delisting?.guaranteeRefund.state;
      finishActionResult(accepted, next, context, action === "withdraw" ? "已撤回审核，可以继续修改资料。" : refund === "REVIEW_REQUIRED" ? "账号已下架。保证金退款需要客服核实，请联系客服。" : refund === "REQUESTED" ? "账号已下架。保证金退款已登记，进度请查看信用与保证金。" : "账号已下架；如需出租，请重新填写上架资料。");
    } catch (failure) {
      try {
        const persisted = loadSupplyIntent(record.userId);
        if (sameSupplyIntent(persisted, record) && persisted?.phase === "pending") {
          if (uncertainSupplyWriteFailure(failure) || persisted.uncertain) {
            const retained = retainUncertainSupplyIntent(record);
            if (currentContext(context)) { storedIntentRef.current = retained; setStoredIntent(retained); }
          } else if (clearSupplyIntent(record) && currentContext(context)) { storedIntentRef.current = null; setStoredIntent(null); }
        }
      } catch {
        if (currentContext(context)) setIntentStorageIssue("原操作记录暂不可更新，已阻止新操作；请保持本页并重试恢复。");
      }
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        setErrorScope("action");
        if (nextError.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
        if (nextError.status === 409) void reloadDetail(false);
      }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const runAction = async (action: "withdraw" | "delist") => {
    if (identityStatusRef.current !== "confirmed" || !identity.current || !detail?.version || busy || intentStorageIssue) return;
    const id = detail.account.id;
    const context = captureContext(id);
    try {
      const previous = loadSupplyIntent(identity.current);
      if (previous) { storedIntentRef.current = previous; setStoredIntent(previous); return; }
      if (!detail.account.game_id) throw new SupplyIntentStorageError();
      const body = { expectedRevision: detail.account.revision, ...(action === "withdraw" ? { versionId: detail.version.id } : {}) };
      const record = prepareSupplyIntent({ userId: identity.current, gameId: detail.account.game_id, accountId: id, action, body, key: newKey() });
      storedIntentRef.current = record; setStoredIntent(record);
      setBusy(action); setError(null);
      await executeAction(record, context);
    } catch {
      setIntentStorageIssue("无法保留原操作记录，暂不能提交；请保持本页并重试。");
    }
  };
  const recoverAction = async () => {
    const original = storedIntentRef.current;
    if (!original || !original.accountId || identity.current !== original.userId || identityStatusRef.current !== "confirmed" || busy
      || !["pause", "resume", "withdraw", "delist"].includes(original.action)) return;
    const context = captureContext(), controller = beginRequest();
    setBusy("recover"); setError(null);
    try {
      const record = loadSupplyIntent(original.userId);
      if (!record || !sameSupplyIntent(record, original)) throw new SupplyIntentStorageError();
      if (!(await waitForIdentity(context))) return;
      const receipt = await supplyApi.operationResult(record.action as "pause" | "resume" | "withdraw" | "delist", record.accountId!, record.body, record.key, controller.signal);
      if (!currentContext(context, controller.signal) || !sameSupplyIntent(storedIntentRef.current, record)) return;
      if (receipt.receipt === "UNRESOLVED") { setNotice("尚未查到原操作回执；结果仍待确认，不会重新发送或据当前状态推断成功。"); return; }
      if (receipt.operation !== `supply.publication.${record.action}` || receipt.resourceId !== record.accountId || receipt.responseStatus !== 200
        || receipt.result?.accountId !== record.accountId || !/^[1-9]\d*$/.test(receipt.result.revision)) throw new SupplyRequestError(502, null, record.key);
      const accepted = acceptSupplyIntent(record, receipt.result);
      storedIntentRef.current = accepted; setStoredIntent(accepted);
      const next = await supplyApi.mine(record.accountId!, controller.signal);
      if (!currentContext(context, controller.signal) || !(await waitForIdentity(context))) return;
      finishActionResult(accepted, next, context, "已核实原操作成功，并读取当前账号资料；可以继续操作。");
    } catch (failure) {
      if (!currentContext(context, controller.signal)) return;
      if (failure instanceof SupplyIntentStorageError) setIntentStorageIssue("原操作记录暂不可读取或更新；请保持本页并重试恢复。");
      setError(failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null));
      setErrorScope("action");
      // A recovery failure or fingerprint conflict never resolves the original write.
      if (failure instanceof SupplyRequestError && failure.status === 401) { setAuthRequired(true); revokeList(); revokeDetail(); }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const retryLast = async () => {
    const task = lastRetry.current;
    if (!task || !currentContext(task.context)) {
      lastRetry.current = null;
      return;
    }
    lastRetry.current = null;
    setBusy(task.busy);
    setError(null);
    try {
      await task.run();
    } catch (failure) {
      if (currentContext(task.context)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        setErrorScope(task.busy === "detail" ? "detail" : task.busy === "accounts" || task.busy === "accounts-more" ? "list" : "action");
        if (nextError.status === 0) lastRetry.current = task;
      }
    } finally {
      if (currentContext(task.context)) setBusy("");
    }
  };

  // DTO 缺 account 子对象或路由已切走时，一律不成立：宁可「账号资料暂不可用」，也不显示上一次缓存的私有详情。
  const visibleDetail = detail && detail.account && (!accountIdProp || detail.account.id === accountIdProp) ? detail : null;
  const pageTitle = "我的账号";
  const pageDescription = "查看账号资料、订单占用与上架进度。";
  const pageHref = accountListHref(mode, stateFilter);
  const heading = <header className="account-module-heading"><div><h2>{pageTitle}</h2><p>{pageDescription}</p></div><div className="mra-heading-actions"><button type="button" className="button quiet" disabled={loading || busy !== ""} onClick={() => { listReadyRef.current = false; void load(accountIdProp); }}><RefreshCw size={15} aria-hidden="true" />{loading ? "刷新中…" : "刷新"}</button>{rows.length > 0 && !accountIdProp ? <Link href="/publish" className="button primary">发布新账号</Link> : null}</div></header>;
  if (identityState === "checking") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" aria-busy="true" role="status"><LockKeyhole size={28} aria-hidden="true" /><h3>正在确认登录身份</h3><p>请稍候，确认后读取出租账号。</p></div></section>;
  if (identityState === "failed") return <section className="account-module">{heading}<div className="account-module-card account-empty-state" role="alert"><LockKeyhole size={28} aria-hidden="true" /><h3>登录身份暂时无法确认</h3><p>重新确认后可以继续查看账号资料。</p><button type="button" className="button secondary" onClick={() => void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); })}>重试</button></div></section>;
  const visibleRows = rows;
  const hasMore = Boolean(nextPageCursor ?? nextCursor);
  // 短页且两种游标都为空才敢说「已加载全部」；无 total 合同，绝不写「共 N 个」。
  const allLoaded = !hasMore && lastPageSize !== null && lastPageSize < LIST_PAGE_SIZE;
  const changeStateFilter = (next: AccountStateFilter) => {
    if (next === stateFilter) return;
    listReadyRef.current = false;
    lastRetry.current = null;
    stateFilterRef.current = next; setStateFilter(next);
    setRows([]);
    setNextCursor(null);
    nextCursorRef.current = null;
    setNextPageCursor(null);
    nextPageCursorRef.current = null;
    setLastPageSize(null);
    setError(null);
    router.replace(accountListHref(mode, next), { scroll: false });
    void load(accountIdProp, false, undefined, next);
  };
  return <section className="my-accounts-panel account-module">
    {accountIdProp ? null : heading}
    <AccountActionError error={error} scope={errorScope} onRetry={error?.status === 0 && !storedIntent ? () => void retryLast() : undefined} />
    {intentStorageIssue ? <div className="supply-notice is-error" role="alert"><AlertCircle size={17} /><span>{intentStorageIssue}</span><button type="button" className="button quiet" disabled={Boolean(busy)} onClick={() => { if (identity.current) restoreStoredIntent(identity.current); }}>重试读取操作记录</button></div> : null}
    {storedIntent ? <div className="supply-notice" role="status"><Clock3 size={17} /><span>有一笔原操作结果待恢复，请先核对后继续，当前账号状态不能证明原操作结果。</span>{["pause", "resume", "withdraw", "delist"].includes(storedIntent.action)
      ? <button type="button" className="button secondary button--sm" disabled={Boolean(busy)} onClick={() => void recoverAction()}>{busy === "recover" ? "查询中…" : "查询原操作结果"}</button>
      : <Link className="button secondary button--sm" href="/publish">前往上架页面恢复</Link>}</div> : null}
    {notice ? <div className="supply-notice" role="status"><Check size={17} />{notice}</div> : null}
    {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>登录后才能查看账号。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent(pageHref)}`}>登录 / 注册</Link></div> : accountIdProp ? <>
      <Link className="account-detail-back" href={pageHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回{pageTitle}</Link>
      {visibleDetail ? <AccountDetail detail={visibleDetail} gameName={rows.find((row) => row.id === visibleDetail.account.id)?.game_name ?? null} latest={latest} busy={busy} identityReady={identityState === "confirmed" && Boolean(identity.current) && !storedIntent && !intentStorageIssue} onAction={runAction} onRefresh={() => void reloadDetail(false)} onAdopt={() => void reloadDetail(true)} /> : <div className="account-module-card account-empty-state" aria-busy={loading ? true : undefined} role="status"><House size={28} aria-hidden="true" /><h3>{loading ? "正在读取账号资料" : "账号资料暂不可用"}</h3><p>{loading ? "请稍候。" : "请返回账号列表，或重试读取当前账号。"}</p></div>}
    </> : <>
      <div className="mra-toolbar">
        <span className="mra-count">已显示 {rows.length} 个</span>
        <div className="mra-filter-rail" role="group" aria-label="按账号状态筛选">
          {ACCOUNT_STATE_FILTERS.filter(chip => PRIMARY_ACCOUNT_STATE_VALUES.has(chip.value)).map(chip => <button key={chip.value} type="button" className="mra-chip" aria-pressed={stateFilter === chip.value} onClick={() => changeStateFilter(chip.value)}>{chip.label}</button>)}
          <button type="button" className="mra-chip mra-more-toggle" aria-expanded={moreFilters} aria-controls="account-more-filters" onClick={() => setMoreFilters(open => !open)}>更多状态{!PRIMARY_ACCOUNT_STATE_VALUES.has(stateFilter) ? ` · ${RENTAL_STATE_LABELS[stateFilter as RentalState]}` : ""}<ChevronDown size={14} aria-hidden="true" /></button>
        </div>
        <div id="account-more-filters" className="mra-more-filters" role="group" aria-label="更多账号状态" hidden={!moreFilters}>{ACCOUNT_STATE_FILTERS.filter(chip => !PRIMARY_ACCOUNT_STATE_VALUES.has(chip.value)).map(chip => <button key={chip.value} type="button" className="mra-chip" aria-pressed={stateFilter === chip.value} onClick={() => changeStateFilter(chip.value)}>{chip.label}</button>)}</div>
      </div>
      {loading && rows.length === 0 ? <div className="account-module-card account-empty-state" aria-busy="true" role="status"><House size={28} aria-hidden="true" /><h3>正在读取{pageTitle}</h3><p>请稍候。</p></div> : error && rows.length === 0 ? <div className="account-module-card account-empty-state" role="alert"><House size={28} aria-hidden="true" /><h3>{pageTitle}暂时无法读取</h3><p>{error.message || "请稍后重试。"}</p><button type="button" className="button secondary" onClick={() => void load(accountIdProp, false, undefined, stateFilter)}>重试读取</button></div> : rows.length === 0 ? (!loading && !error
        ? <div className="account-module-card account-empty-art-state" role="status">
          <img className="account-empty-art" src="/art/empty/account-prepare-r1.webp" alt="" width={240} height={180} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
          <h3>{stateFilter === "ALL" ? "还没有账号" : `当前没有${RENTAL_STATE_LABELS[stateFilter]}账号`}</h3>
          <p>{stateFilter === "ALL" ? "发布账号后，可以在这里查看资料和进度。" : "可以切换其他状态，查看你的账号。"}</p>
          <div className="account-empty-actions">{stateFilter === "ALL" ? <Link href="/publish" className="button primary">发布出租账号</Link> : <button type="button" className="button primary" onClick={() => changeStateFilter("ALL")}>查看全部账号</button>}</div>
        </div>
        : <div className="account-module-card account-empty-state" aria-busy="true" role="status"><House size={30} aria-hidden="true" /><h3>正在读取{pageTitle}</h3><p>请稍候。</p></div>) : <>
        <div className="supply-account-list account-module-card" aria-busy={loading || loadingMore}>
          <div className="mra-rows" role="list" aria-label={`${pageTitle}列表`}>
            {visibleRows.map((row) => {
              const historical = historicalAccountSummary(row);
              const factsTitle = accountTitleFromFacts(row);
              const displayNo = row.accountDisplay?.displayNo ?? row.display_no ?? null;
              const title = factsTitle ?? historical?.title ?? (displayNo ? `账号 ${displayNo}` : pageTitle);
              const activeText = accountActiveOrderText(row);
              const state = row.rentalState;
              const loginMethod = row.historicalRead?.display?.facts?.attributeDisplay?.loginMethod?.displayName;
              const serviceWindow = row.historicalRead?.display?.facts?.attributeDisplay?.serviceWindow?.displayName;
              const ownerQuote = row.accountDisplay?.titleFacts?.ownerQuoteTotal;
              const histQuoteYuan = row.historicalRead?.historicalQuote?.haffRentYuan;
              const rowPrice = ownerQuote ? moneyText(ownerQuote) : histQuoteYuan ? `${histQuoteYuan} 元` : null;
              const rowPriceLabel = ownerQuote ? "发布报价" : histQuoteYuan ? "历史租金" : null;
              const canQuickEdit = !row.historicalReadOnly && (state ? ["DRAFT", "REJECTED"].includes(state) : ["DRAFT", "REJECTED", "WITHDRAWN"].includes(row.review_state ?? ""));
              return <div className="mra-row" role="listitem" key={row.id} data-account-row={row.id}>
                <Link className="mra-row-main" id={`account-row-title-${row.id}`} href={accountListHref(mode, stateFilter, row.id)} scroll={false}>
                  <div className="mra-row-top">
                    <span className="mra-game-tag">{row.game_name || "三角洲行动"}</span>
                    <strong className="mra-row-title">{title}</strong>
                  </div>
                  <div className="mra-row-meta">
                    {displayNo ? (
                      <span className="mra-meta-pill mra-no-pill">
                        <span>账号 {displayNo}</span>
                        <AccountCopyInline text={displayNo} />
                      </span>
                    ) : null}
                    {loginMethod ? (
                      <span className="mra-meta-pill">
                        <LogIn size={11} aria-hidden="true" />
                        <span>{loginMethod}</span>
                      </span>
                    ) : null}
                    {serviceWindow ? (
                      <span className="mra-meta-pill">
                        <Clock3 size={11} aria-hidden="true" />
                        <span>上号 {serviceWindow}</span>
                      </span>
                    ) : null}
                    {row.accountDisplay?.titleFacts && mode === "listed" ? <span className="mra-meta-pill">{[
                      row.accountDisplay.titleFacts.rentalMode ? ACCOUNT_MODE_LABELS[row.accountDisplay.titleFacts.rentalMode] ?? "出租模式待确认" : null,
                      row.accountDisplay.titleFacts.ownerQuoteTotal ? `发布报价 ${moneyText(row.accountDisplay.titleFacts.ownerQuoteTotal)}` : "发布报价待确认",
                    ].filter(Boolean).join(" · ")}</span> : null}
                    {activeText ? <span className="mra-meta-pill mra-row-order">{activeText}</span> : null}
                  </div>
                </Link>
                <div className="mra-row-state">
                  {row.activeOrder ? <Link className="mra-row-anchor" href={orderUrl("owner", "", row.id, row.activeOrder.id, row.activeOrder.origin)} scroll={false}>订单 {row.activeOrder.displayNo}</Link> : null}
                  {row.historicalReadOnly ? <span className="mra-badge" data-tone="unknown"><span className="mra-badge-dot" aria-hidden="true" />历史只读</span> : null}
                  {state ? <span className="mra-badge" data-tone={RENTAL_STATE_TONE[state]}><span className="mra-badge-dot" aria-hidden="true" />{state === "DRAFT" ? row.review_state === "WITHDRAWN" ? "已撤回" : row.review_state === "IMPORTED_UNVERIFIED" ? "历史资料待核" : row.review_state === "DRAFT" ? "草稿" : "资料待确认" : RENTAL_STATE_LABELS[state]}</span> : <span className="mra-badge" data-tone={row.review_state ? REVIEW_BADGE_TONE[row.review_state] ?? "unknown" : undefined}><span className="mra-badge-dot" aria-hidden="true" />{row.review_state ? stateLabel(row.review_state) : "资料待确认"}</span>}
                  {!row.historicalReadOnly && row.owner_paused && state !== "PAUSED" ? <span className="mra-badge" data-tone="warning"><span className="mra-badge-dot" aria-hidden="true" />原状态待核</span> : null}
                  {row.staff_restricted && state !== "RESTRICTED" ? <span className="mra-badge" data-tone="warning"><span className="mra-badge-dot" aria-hidden="true" />账号受限</span> : null}
                  {!row.historicalReadOnly && state === "LISTED" && row.available === false ? <span className="mra-badge" data-tone="warning"><span className="mra-badge-dot" aria-hidden="true" />暂不可接单</span> : null}
                  {row.accountDisplay?.titleFacts === null && row.accountDisplay?.unknownReason ? <span className="mra-badge" data-tone="unknown">资料待核实</span> : null}
                  {row.review_state === "REJECTED" ? <Link className="mra-row-anchor" href={`${accountListHref(mode, stateFilter, row.id)}#blockers`} scroll={false}>查看退回原因</Link> : null}
                </div>
                {rowPrice ? (
                  <div className="mra-row-price">
                    <span className="mra-row-price-label">{rowPriceLabel}</span>
                    <strong className="mra-row-price-val">{rowPrice}</strong>
                  </div>
                ) : <div className="mra-row-price mra-row-price--empty" aria-hidden="true" />}
                <div className="mra-row-actions">
                  {canQuickEdit ? (
                    <Link className="mra-row-edit-link" href={`/publish?accountId=${encodeURIComponent(row.id)}&edit=1`}>
                      <Pencil size={13} aria-hidden="true" />
                      <span>{row.review_state === "REJECTED" ? "修改资料" : "继续填写"}</span>
                    </Link>
                  ) : null}
                  <Link className="mra-row-action" href={accountListHref(mode, stateFilter, row.id)} scroll={false} aria-label={`查看账号 ${title}`}>
                    <span>查看账号</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </Link>
                </div>
              </div>;
            })}
          </div>
          <div className="mra-list-foot">
            {hasMore ? <button type="button" className="button secondary" disabled={loadingMore || identityState !== "confirmed"} onClick={() => void load(undefined, true, nextPageCursor ? { cursor: nextPageCursor } : nextCursor ? { after: nextCursor } : undefined, stateFilter)}>{loadingMore ? "正在读取更多…" : "加载更多账号"}</button> : null}
            {allLoaded ? <span className="mra-meta">没有更多账号了</span> : null}
          </div>
        </div>
      </>}
    </>}
  </section>;
}
