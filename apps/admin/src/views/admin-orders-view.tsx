import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, ExternalLink, FileText, Search, ShieldAlert } from "lucide-react";

import { Button, StatusMessage } from "../components/ui-elements";
import { BEIJING_TIME_ZONE } from "../workspace/beijing-time";
import {
  AdminApiError,
  adminRequest,
  formatDate,
  friendlyError,
  hasPermission,
  type AdminOrder,
  type AdminOrderMoney,
  type AdminOrdersPage,
  type AdminSettlementResponse,
  type SessionSnapshot,
} from "../api";

type OrderFilters = {
  status: string;
  displayNo: string;
  renterUserId: string;
  ownerUserId: string;
  createdFrom: string;
  createdTo: string;
};

type OrderListCache = {
  filters: OrderFilters;
  items: AdminOrder[];
  nextCursor: string | null;
  selectedOrderId: string | null;
  scrollTop: number;
  loaded: boolean;
};

const EMPTY_FILTERS: OrderFilters = {
  status: "",
  displayNo: "",
  renterUserId: "",
  ownerUserId: "",
  createdFrom: "",
  createdTo: "",
};

const orderListCache = new Map<string, OrderListCache>();

function cacheKey(snapshot: Extract<SessionSnapshot, { authenticated: true }>): string {
  const permissions = [...snapshot.permissions].sort().join(",");
  return `${snapshot.adminUserId}:${snapshot.session.id}:${snapshot.security.status}:${snapshot.security.isBoss ? "boss" : "staff"}:${permissions}`;
}

function fromQueryDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function toOrderApiTimestamp(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+08:00` : undefined;
}

function initialFilters(query: Record<string, string> | undefined): OrderFilters {
  return {
    status: query?.status ?? "",
    displayNo: "",
    renterUserId: "",
    ownerUserId: "",
    createdFrom: fromQueryDate(query?.createdFrom),
    createdTo: fromQueryDate(query?.createdTo),
  };
}

export function buildAdminOrderQuery(filters: OrderFilters, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.displayNo.trim()) params.set("displayNo", filters.displayNo.trim());
  if (filters.renterUserId.trim()) params.set("renterUserId", filters.renterUserId.trim());
  if (filters.ownerUserId.trim()) params.set("ownerUserId", filters.ownerUserId.trim());
  const createdFrom = toOrderApiTimestamp(filters.createdFrom);
  const createdTo = toOrderApiTimestamp(filters.createdTo);
  if (createdFrom) params.set("createdFrom", createdFrom);
  if (createdTo) params.set("createdTo", createdTo);
  params.set("limit", "20");
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function queryForTab(filters: OrderFilters): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.status) query.status = filters.status;
  return query;
}

function money(value: AdminOrderMoney | null | undefined): string {
  return value && typeof value.amount === "string" ? `¥${value.amount}` : "未知";
}

function moneyFromCents(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "未知";
  const cents = BigInt(value);
  return `¥${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asMoney(value: unknown): AdminOrderMoney | undefined {
  const record = asRecord(value);
  return record && typeof record.amount === "string" ? record as unknown as AdminOrderMoney : undefined;
}

function statusText(order: Pick<AdminOrder, "status" | "expiredAwaitingCancel" | "cancelReason">): string {
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "已过期，取消处理中";
  if (order.status === "PENDING_PAYMENT") return "待支付";
  if (order.status === "PAID") return "已支付";
  if (order.status === "COMPLETED") return "已完成";
  return order.cancelReason === "TIMEOUT" ? "已取消 · 超时" : "已取消";
}

function statusClasses(status: AdminOrder["status"]): string {
  if (status === "COMPLETED") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
  if (status === "PAID") return "border-sky-500/30 bg-sky-500/10 text-sky-400";
  if (status === "PENDING_PAYMENT") return "border-amber-500/30 bg-amber-500/10 text-amber-400";
  return "border-border bg-surface-raised text-muted-foreground";
}

function StatusBadge({ order }: { order: Pick<AdminOrder, "status" | "expiredAwaitingCancel" | "cancelReason"> }) {
  const Icon = order.status === "COMPLETED" ? CheckCircle2 : order.status === "PENDING_PAYMENT" ? Clock3 : CircleAlert;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${statusClasses(order.status)}`}>
      <Icon size={12} aria-hidden="true" />
      {statusText(order)}
    </span>
  );
}

function panelTitle(title: string, description?: string) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  );
}

function PermissionState() {
  return (
    <section className="section-panel" aria-labelledby="orders-permission-title">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 text-amber-400" size={20} aria-hidden="true" />
        <div>
          <h1 id="orders-permission-title" className="text-base font-semibold text-foreground">您当前没有订单查询权限</h1>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">本页需要 `order.read`。其他已授权工作区仍可使用；如需查看订单，请联系权限管理员开通。服务端也会对直接请求进行授权检查。</p>
        </div>
      </div>
    </section>
  );
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-10 text-center">
      <FileText className="mb-3 text-muted-foreground" size={24} aria-hidden="true" />
      <strong className="text-sm font-medium text-foreground">当前筛选与您的游戏范围内暂无订单</strong>
      <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">可调整状态、订单编号或时间范围重新查询。双方字段只支持稳定用户 ID，不支持姓名、手机号模糊检索；若长期为空，请联系权限管理员核对游戏范围。</p>
      <Button type="button" size="sm" variant="secondary" className="mt-4" onClick={onReset}>清空筛选</Button>
    </div>
  );
}

function ListErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-rose-500/25 bg-rose-500/5 px-6 py-10 text-center" role="alert">
      <CircleAlert className="mb-3 text-rose-400" size={24} aria-hidden="true" />
      <strong className="text-sm font-medium text-foreground">订单列表加载失败</strong>
      <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">{message}</p>
      <Button type="button" size="sm" className="mt-4" onClick={onRetry}>重试</Button>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2" aria-label="订单加载中" aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-md bg-surface-raised" />
      ))}
    </div>
  );
}

function assignmentLabel(order: AdminOrder): string {
  const assignment = order.fulfillmentAssignment;
  if (!assignment) return "未开始";
  if (assignment.teamReady) return "群已就绪";
  if (assignment.state === "ASSIGNED") return "已分配";
  return assignment.waitingReason === "NO_ELIGIBLE_STAFF" ? "等待人工处理" : "履约等待中";
}

function paymentTime(order: AdminOrder): string {
  if (order.status === "PAID" || order.status === "COMPLETED") return order.paidAt ? formatDate(order.paidAt) : "支付时间待确认";
  return "—";
}

function OrderTable({ items, onOpen }: { items: AdminOrder[]; onOpen: (order: AdminOrder) => void }) {
  return (
    <div className="table-wrap hidden min-[1201px]:block">
      <table className="data-table" aria-label="订单列表">
        <thead>
          <tr>
            <th>订单编号</th><th>状态</th><th>账号</th><th>租客</th><th>号主</th><th className="text-right">总应付</th><th>支付时间</th><th>下单时间</th><th>履约 / 群</th>
          </tr>
        </thead>
        <tbody>
          {items.map((order) => (
            <tr
              key={order.id}
              data-order-id={order.id}
              tabIndex={0}
              onClick={() => onOpen(order)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(order); } }}
              aria-label={`打开订单 ${order.displayNo}`}
            >
              <td className="font-mono text-xs"><button type="button" className="text-left text-ring underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => { event.stopPropagation(); onOpen(order); }} aria-label={`打开订单 ${order.displayNo}`}>{order.displayNo}</button></td>
              <td><StatusBadge order={order} /></td>
              <td><span className="block max-w-64 truncate" title={order.title}>{order.title}</span></td>
              <td className="max-w-44 truncate">{order.renterName}</td>
              <td className="max-w-44 truncate">{order.ownerName}</td>
              <td className="text-right font-mono tabular-nums">{money(order.amounts.totalDue)}<span className="mt-1 block text-[11px] font-normal text-muted-foreground">租 {money(order.amounts.rental)} · 押 {money(order.amounts.deposit)}</span></td>
              <td className="text-xs text-muted-foreground">{paymentTime(order)}</td>
              <td className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</td>
              <td className="text-xs text-muted-foreground">{assignmentLabel(order)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderCards({ items, onOpen }: { items: AdminOrder[]; onOpen: (order: AdminOrder) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 min-[761px]:grid-cols-2 min-[1201px]:hidden">
      {items.map((order) => (
        <button
          key={order.id}
          type="button"
          data-order-id={order.id}
          className="min-h-32 rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-ring hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpen(order)}
        >
          <span className="flex items-start justify-between gap-3">
            <span className="font-mono text-xs text-foreground">{order.displayNo}</span>
            <StatusBadge order={order} />
          </span>
          <span className="mt-3 block break-words text-sm font-medium text-foreground">{order.title}</span>
          <span className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{order.renterName} / {order.ownerName}</span>
            <span className="font-mono tabular-nums text-foreground">{money(order.amounts.totalDue)}</span>
          </span>
          <span className="mt-2 flex justify-between gap-3 text-[11px] text-muted-foreground"><span>{formatDate(order.createdAt)}</span><span>{assignmentLabel(order)}</span></span>
        </button>
      ))}
    </div>
  );
}

function OrderListView({
  snapshot,
  initialQuery,
  onOpenPath,
  onQueryChange,
  refreshNonce,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialQuery?: Record<string, string>;
  onOpenPath: (path: string, title?: string) => void;
  onQueryChange: (query: Record<string, string>) => void;
  refreshNonce: number;
}) {
  const key = cacheKey(snapshot);
  const cached = orderListCache.get(key);
  const [filters, setFilters] = useState<OrderFilters>(() => cached?.filters ?? initialFilters(initialQuery));
  const [items, setItems] = useState<AdminOrder[]>(() => cached?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(() => cached?.nextCursor ?? null);
  const [loading, setLoading] = useState(!cached?.loaded);
  const [loaded, setLoaded] = useState(Boolean(cached?.loaded));
  const [error, setError] = useState<string>();
  const cacheStateRef = useRef<OrderListCache>({
    filters,
    items,
    nextCursor,
    selectedOrderId: cached?.selectedOrderId ?? null,
    scrollTop: cached?.scrollTop ?? 0,
    loaded,
  });
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const requestSeq = useRef(0);
  const refreshRef = useRef(refreshNonce);
  const loadPageRef = useRef<((cursor: string | undefined, replace: boolean, requestedFilters?: OrderFilters) => Promise<"ok" | "conflict" | "ignored">) | undefined>(undefined);

  cacheStateRef.current = { ...cacheStateRef.current, filters, items, nextCursor, loaded };

  useEffect(() => {
    orderListCache.set(key, cacheStateRef.current);
  }, [items, key, filters, loaded, nextCursor]);

  useEffect(() => {
    if (!cached?.scrollTop) return;
    requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>(".workspace-page");
      if (scroller) scroller.scrollTop = cached.scrollTop;
    });
  }, [cached?.scrollTop]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    const scroller = document.querySelector<HTMLElement>(".workspace-page");
    orderListCache.set(key, { ...cacheStateRef.current, scrollTop: scroller?.scrollTop ?? cacheStateRef.current.scrollTop });
  }, [key]);

  const loadPage = useCallback(async (cursor: string | undefined, replace: boolean, requestedFilters = filters): Promise<"ok" | "conflict" | "ignored"> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSeq.current;
    setLoading(true);
    if (replace) setLoaded(false);
    try {
      const query = buildAdminOrderQuery(requestedFilters, cursor);
      const page = await adminRequest<AdminOrdersPage>(`/orders?${query}`, undefined, "GET", {}, controller.signal);
      if (controller.signal.aborted || sequence !== requestSeq.current) return "ignored";
      setItems((current) => replace ? page.items : [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setError(undefined);
      setLoaded(true);
      cacheStateRef.current = { ...cacheStateRef.current, filters: requestedFilters, nextCursor: page.nextCursor, loaded: true };
      return "ok";
    } catch (failure) {
      if (controller.signal.aborted || sequence !== requestSeq.current) return "ignored";
      if (failure instanceof AdminApiError && failure.code === "CONFLICT" && !replace) {
        setItems([]);
        setNextCursor(null);
        setError("筛选条件已变化，已重置到第一页重新查询。旧游标未重放。");
        return "conflict";
      }
      setError(friendlyError(failure));
      return "ok";
    } finally {
      if (sequence === requestSeq.current) setLoading(false);
    }
  }, [filters]);

  loadPageRef.current = loadPage;

  const reload = useCallback((requestedFilters = filters) => {
    setItems([]);
    setNextCursor(null);
    setLoaded(false);
    setError(undefined);
    void loadPage(undefined, true, requestedFilters);
  }, [filters, loadPage]);

  useEffect(() => {
    if (loaded) return;
    void loadPageRef.current?.(undefined, true);
    return () => controllerRef.current?.abort();
  }, [key, loaded]);

  useEffect(() => {
    if (refreshRef.current === refreshNonce) return;
    refreshRef.current = refreshNonce;
    reload();
  }, [refreshNonce, reload]);

  const openOrder = (order: AdminOrder) => {
    cacheStateRef.current = { ...cacheStateRef.current, selectedOrderId: order.id };
    orderListCache.set(key, cacheStateRef.current);
    onOpenPath(`/orders/${encodeURIComponent(order.id)}`, order.displayNo);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedFilters = { ...filters, displayNo: filters.displayNo.trim(), renterUserId: filters.renterUserId.trim(), ownerUserId: filters.ownerUserId.trim() };
    const from = toOrderApiTimestamp(requestedFilters.createdFrom);
    const to = toOrderApiTimestamp(requestedFilters.createdTo);
    if (from && to && Date.parse(from) > Date.parse(to)) {
      setError("下单起不能晚于下单止；下单止按不含边界处理。");
      return;
    }
    setFilters(requestedFilters);
    onQueryChange(queryForTab(requestedFilters));
    reload(requestedFilters);
  };

  const reset = () => {
    setFilters(EMPTY_FILTERS);
    onQueryChange({});
    reload(EMPTY_FILTERS);
  };

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    const result = await loadPage(nextCursor, false);
    if (result === "conflict") reload();
  };

  const selectedOrderId = cacheStateRef.current.selectedOrderId;
  useEffect(() => {
    if (loading || !selectedOrderId) return;
    const selected = document.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(selectedOrderId)}"]`);
    selected?.focus();
  }, [items.length, loading, selectedOrderId]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">订单</h1>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">按您获授权的游戏范围查询平台订单。本页只读；开租、结算与客服动作在对应工作区完成。</p>
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">只读</span>
      </div>

      <section className="section-panel !mb-0" aria-labelledby="order-filter-title">
        <div className="mb-4 flex items-center gap-2"><Search size={16} className="text-muted-foreground" aria-hidden="true" /><h2 id="order-filter-title" className="text-sm font-semibold text-foreground">筛选订单</h2></div>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
          <label className="min-w-36 flex-1 space-y-1 text-xs"><span className="block text-muted-foreground">状态</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} className="h-9 w-full rounded border border-border bg-surface-raised px-2 text-xs"><option value="">全部</option><option value="PENDING_PAYMENT">待支付</option><option value="PAID">已支付</option><option value="CANCELLED">已取消</option><option value="COMPLETED">已完成</option></select></label>
          <label className="min-w-44 flex-1 space-y-1 text-xs"><span className="block text-muted-foreground">订单编号</span><input value={filters.displayNo} onChange={(event) => setFilters((current) => ({ ...current, displayNo: event.target.value }))} autoComplete="off" className="h-9 w-full rounded border border-border bg-surface-raised px-3 font-mono text-xs" placeholder="精确匹配" /></label>
          <label className="min-w-44 flex-1 space-y-1 text-xs"><span className="block text-muted-foreground">租客稳定 ID</span><input value={filters.renterUserId} onChange={(event) => setFilters((current) => ({ ...current, renterUserId: event.target.value }))} autoComplete="off" className="h-9 w-full rounded border border-border bg-surface-raised px-3 font-mono text-xs" placeholder="不支持姓名/手机号" /></label>
          <label className="min-w-44 flex-1 space-y-1 text-xs"><span className="block text-muted-foreground">号主稳定 ID</span><input value={filters.ownerUserId} onChange={(event) => setFilters((current) => ({ ...current, ownerUserId: event.target.value }))} autoComplete="off" className="h-9 w-full rounded border border-border bg-surface-raised px-3 font-mono text-xs" placeholder="不支持姓名/手机号" /></label>
          <label className="min-w-44 flex-1 space-y-1 text-xs"><span className="block text-muted-foreground">下单起</span><input type="datetime-local" value={filters.createdFrom} onChange={(event) => setFilters((current) => ({ ...current, createdFrom: event.target.value }))} className="h-9 w-full rounded border border-border bg-surface-raised px-2 text-xs" /></label>
          <label className="min-w-44 flex-1 space-y-1 text-xs"><span className="block text-muted-foreground">下单止（不含）</span><input type="datetime-local" value={filters.createdTo} onChange={(event) => setFilters((current) => ({ ...current, createdTo: event.target.value }))} className="h-9 w-full rounded border border-border bg-surface-raised px-2 text-xs" /></label>
          <div className="flex gap-2"><Button type="submit" size="sm" loading={loading && items.length === 0}>查询</Button><Button type="button" size="sm" variant="ghost" onClick={reset}>重置</Button></div>
          <p className="basis-full text-[11px] leading-relaxed text-muted-foreground">时间按北京时间解释；下单起包含、下单止不含。订单编号、双方稳定 ID 与下单时间只用于本次查询，不写入地址栏、对象标签或普通日志；关闭标签后需重新输入。</p>
        </form>
      </section>

      {error && items.length === 0 ? <ListErrorState message={error} onRetry={() => reload()} /> : null}
      {loading && items.length === 0 && !error ? <LoadingRows /> : !error && items.length === 0 ? <EmptyState onReset={reset} /> : items.length > 0 ? (
        <section aria-labelledby="order-results-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><h2 id="order-results-title" className="font-medium text-foreground">订单结果</h2><span>本页 {items.length} 条 · 按下单时间倒序</span></div>
          <OrderTable items={items} onOpen={openOrder} />
          <OrderCards items={items} onOpen={openOrder} />
          {loading && items.length > 0 ? <div className="text-center text-xs text-muted-foreground" aria-live="polite">正在刷新订单…</div> : null}
          {nextCursor ? <div className="flex justify-center"><Button type="button" size="sm" variant="secondary" loading={loading} onClick={() => void loadMore()}>加载更多</Button></div> : null}
        </section>
      ) : null}
      {error && items.length > 0 ? <StatusMessage error={error} /> : null}
    </div>
  );
}

function DetailError({ message, requestId, onBack, onRetry }: { message: string; requestId?: string; onBack: () => void; onRetry: () => void }) {
  return (
    <section className="section-panel" role="alert">
      <div className="flex items-start gap-3"><CircleAlert className="mt-0.5 text-rose-400" size={19} aria-hidden="true" /><div><h1 className="text-sm font-semibold text-foreground">{message}</h1><p className="mt-2 text-xs leading-relaxed text-muted-foreground">可返回订单列表；若持续失败，请记录请求编号并联系平台维护。</p>{requestId ? <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">requestId：{requestId}</p> : null}<div className="mt-4 flex gap-2"><Button type="button" size="sm" variant="secondary" onClick={onBack}>返回订单列表</Button><Button type="button" size="sm" onClick={onRetry}>重试</Button></div></div></div>
    </section>
  );
}

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return <><dt className="text-xs text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-xs text-foreground">{children}</dd></>;
}

function PartiesPanel({ order, onOpenPath, canOpenAccount }: { order: AdminOrder; onOpenPath: (path: string, title?: string) => void; canOpenAccount: boolean }) {
  return (
    <section className="section-panel !mb-0">
      {panelTitle("双方与账号", "名称是当前订单投影，稳定 ID 才是对象关联键。")}
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        <KeyValue label="租客"><span>{order.renterName}</span><code className="ml-2 break-all text-[11px] text-muted-foreground">{order.renterUserId}</code></KeyValue>
        <KeyValue label="号主"><span>{order.ownerName}</span><code className="ml-2 break-all text-[11px] text-muted-foreground">{order.ownerUserId}</code></KeyValue>
        <KeyValue label="账号"><span className="font-medium">{order.title}</span><span className="mt-1 block font-mono text-[11px] text-muted-foreground">{order.accountId}</span>{canOpenAccount ? <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs text-ring hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenPath("/supply/reviews")}><ExternalLink size={12} aria-hidden="true" />打开账号监管入口</button> : <span className="mt-2 block text-[11px] text-muted-foreground">当前权限未开放账号监管入口</span>}</KeyValue>
        <KeyValue label="游戏"><code>{order.gameId}</code></KeyValue>
      </dl>
    </section>
  );
}

function QuotePanel({ order }: { order: AdminOrder }) {
  const quote = asRecord(order.quote);
  const lines = quote && Array.isArray(quote.lines) ? quote.lines : [];
  return (
    <section className="section-panel !mb-0">
      {panelTitle("金额与报价", "金额来自订单冻结投影；受控记录不等于渠道到账。")}
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        <KeyValue label="总应付"><span className="font-mono tabular-nums">{money(order.amounts.totalDue)}</span></KeyValue>
        <KeyValue label="租金"><span className="font-mono tabular-nums">{money(order.amounts.rental)}</span></KeyValue>
        <KeyValue label="押金"><span className="font-mono tabular-nums">{money(order.amounts.deposit)}</span></KeyValue>
        <KeyValue label="报价快照"><span>{quote ? "已返回受权投影" : "未知"}</span></KeyValue>
        {quote ? <>
          <KeyValue label="资源金额"><span className="font-mono tabular-nums">{money(asMoney(quote.resourceTotal))}</span></KeyValue>
          <KeyValue label="号主金额"><span className="font-mono tabular-nums">{money(asMoney(quote.ownerTotal))}</span></KeyValue>
          {quote.platformFullProfit !== undefined ? <KeyValue label="内部报价"><span className="font-mono tabular-nums">{money(asMoney(quote.platformFullProfit))}</span><span className="ml-2 rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-400">受权可见</span></KeyValue> : null}
        </> : null}
      </dl>
      {lines.length > 0 ? <div className="mt-4 overflow-x-auto rounded border border-border"><table className="data-table text-xs"><thead><tr><th>物品 ID</th><th>数量</th><th>租客金额</th><th>号主金额</th></tr></thead><tbody>{lines.slice(0, 20).map((line, index) => { const row = asRecord(line); return <tr key={`${String(row?.itemId ?? "line")}-${index}`}><td className="font-mono">{String(row?.itemId ?? "未知")}</td><td className="font-mono">{String(row?.quantity ?? "未知")}</td><td className="font-mono">{money(asMoney(row?.buyerAmount))}</td><td className="font-mono">{money(asMoney(row?.ownerAmount))}</td></tr>; })}</tbody></table></div> : null}
      {lines.length > 20 ? <p className="mt-2 text-[11px] text-muted-foreground">报价明细已显示 20 / 共 {lines.length} 条；其余明细未在本页展开。</p> : null}
    </section>
  );
}

function FulfillmentPanel({ order, onOpenPath, canOpenSupport }: { order: AdminOrder; onOpenPath: (path: string, title?: string) => void; canOpenSupport: boolean }) {
  const assignment = order.fulfillmentAssignment;
  return (
    <section className="section-panel !mb-0">
      {panelTitle("履约与订单群", "派单、群就绪、开租和结算是不同事实。")}
      {!assignment ? <p className="text-xs text-muted-foreground">当前订单投影没有履约派单事实。</p> : <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        <KeyValue label="派单状态">{assignment.state === "ASSIGNED" ? "已分配客服（ASSIGNED）" : "等待分配（WAITING）"}</KeyValue>
        <KeyValue label="订单群">{assignment.teamReady ? "群已就绪（READY）" : "尚未就绪"}<span className="mt-1 block text-[11px] text-muted-foreground">群就绪不证明三方当前均在群内。</span></KeyValue>
        <KeyValue label="分配时间">{assignment.assignedAt ? formatDate(assignment.assignedAt) : "未知"}</KeyValue>
        <KeyValue label="客服权限">{canOpenSupport ? <button type="button" className="inline-flex items-center gap-1 text-xs text-ring hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenPath("/support")}><ExternalLink size={12} aria-hidden="true" />打开现有客服工作台</button> : "order.read 不包含聊天权"}</KeyValue>
      </dl>}
      {order.supportEscalation ? <p className="mt-4 rounded-md border border-border bg-surface-raised p-3 text-xs text-muted-foreground">首响：{order.supportEscalation.firstResponseAt ? formatDate(order.supportEscalation.firstResponseAt) : "未知"} · 补派轮次：{order.supportEscalation.addRound} · 状态：{order.supportEscalation.state}</p> : null}
    </section>
  );
}

export function SettlementPanel({ state, response, requestId, onRetry }: { state: "loading" | "ready" | "forbidden" | "unavailable" | "error"; response?: AdminSettlementResponse; requestId?: string; onRetry: () => void }) {
  if (state === "loading") return <section className="section-panel !mb-0" aria-busy="true">{panelTitle("开租与结算")}<div className="h-20 animate-pulse rounded bg-surface-raised" /></section>;
  if (state === "forbidden") return <section className="section-panel !mb-0"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 text-amber-400" size={18} aria-hidden="true" /><div>{panelTitle("开租与结算")}<p className="text-xs leading-relaxed text-muted-foreground">开租与结算事实仅本单客服可见。若您是本单客服仍看到此提示，请确认群已就绪且具备 order.read 或 order.settlement.write；order.read 本身不包含群内与结算访问。</p></div></div></section>;
  if (state === "unavailable" || state === "error" || !response) return <section className="section-panel !mb-0"><div className="flex items-start gap-3"><CircleAlert className="mt-0.5 text-muted-foreground" size={18} aria-hidden="true" /><div>{panelTitle("开租与结算")}<p className="text-xs leading-relaxed text-muted-foreground">结算记录暂不可用。不能仅凭本次状态码判断环境是否开放，也不将缺失字段解释为 0。</p>{requestId ? <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">requestId：{requestId}</p> : null}<Button type="button" size="sm" variant="secondary" className="mt-3" onClick={onRetry}>重试结算读取</Button></div></div></section>;
  const reasons = Array.isArray(response.reasons) ? response.reasons.map(String) : [];
  const posting = asRecord(response.posting);
  const owner = asRecord(posting?.owner);
  const refund = asRecord(posting?.refund);
  return (
    <section className="section-panel !mb-0">
      {panelTitle("开租与结算", "状态、开租事实和受控过账分开显示；已生效不代表渠道到账。")}
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        <KeyValue label="开租">{response.rentalStarted === true ? "已开始" : response.rentalStarted === false ? "未开始" : "未知"}</KeyValue>
        <KeyValue label="可生效">{response.ready === true ? "是" : response.ready === false ? "否" : "未知"}</KeyValue>
        <KeyValue label="当前请求">{asRecord(response.currentRequest)?.kind ? `${String(asRecord(response.currentRequest)?.kind)} · ${String(asRecord(response.currentRequest)?.status ?? "")}` : "未知"}</KeyValue>
        {posting ? <>
          <KeyValue label="过账时间">{typeof posting.postedAt === "string" ? formatDate(posting.postedAt) : "未知"}</KeyValue>
          <KeyValue label="号主净额">{moneyFromCents(owner?.systemNetCents)}</KeyValue>
          <KeyValue label="租客应退">{moneyFromCents(refund?.payableCents)}</KeyValue>
          <KeyValue label="包赔费用">{moneyFromCents(posting.compensationFeeCents)}</KeyValue>
        </> : null}
      </dl>
      {reasons.length > 0 ? <p className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-300">当前仍不可生效：{reasons.join("、")}</p> : null}
      {!posting ? <p className="mt-4 text-[11px] text-muted-foreground">尚未返回受控过账事实；缺少记录不等于金额为 0。</p> : null}
    </section>
  );
}

function TracePanel({ order }: { order: AdminOrder }) {
  return (
    <section className="section-panel !mb-0">
      {panelTitle("技术与追溯", "排障时提供订单编号与接口返回的 requestId。")}
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3">
        <KeyValue label="订单 ID"><code className="break-all">{order.id}</code></KeyValue>
        <KeyValue label="版本 ID"><code className="break-all">{order.versionId}</code></KeyValue>
        <KeyValue label="规则版本"><code className="break-all">{order.releaseId}</code></KeyValue>
        <KeyValue label="内容摘要"><code className="break-all">{order.contentHash}</code></KeyValue>
        <KeyValue label="修订"><code>{order.revision}</code></KeyValue>
      </dl>
    </section>
  );
}

function LifecyclePanel({ order, state, response }: { order: AdminOrder; state: "loading" | "ready" | "forbidden" | "unavailable" | "error"; response?: AdminSettlementResponse }) {
  const assignment = order.fulfillmentAssignment;
  const posting = asRecord(response?.posting);
  const steps = [
    { label: "订单创建", state: "done", detail: formatDate(order.createdAt) },
    {
      label: "支付",
      state: order.status === "PAID" || order.status === "COMPLETED" ? "done" : order.status === "PENDING_PAYMENT" ? "current" : "idle",
      detail: order.paidAt ? formatDate(order.paidAt) : order.status === "PAID" || order.status === "COMPLETED" ? "支付时间待确认" : order.status === "PENDING_PAYMENT" ? "等待支付" : "未形成支付事实",
    },
    {
      label: "派单 / 群就绪",
      state: assignment?.teamReady ? "done" : assignment ? "current" : "unknown",
      detail: assignment?.teamReady ? "供应商群已就绪" : assignment ? assignment.state === "ASSIGNED" ? "已分配，群状态待确认" : "等待分配" : "未返回履约事实",
    },
    {
      label: "开租",
      state: response?.rentalStarted === true ? "done" : response?.rentalStarted === false ? "idle" : "unknown",
      detail: response?.rentalStarted === true ? "已开始" : response?.rentalStarted === false ? "尚未开始" : state === "forbidden" ? "仅本单客服可见" : "未知",
    },
    {
      label: "结算 / 过账",
      state: posting ? "done" : response?.ready === true ? "current" : response ? "idle" : "unknown",
      detail: posting ? "受控过账已返回" : response?.ready === true ? "事实已具备，尚未返回过账" : response ? "尚未具备生效条件" : state === "forbidden" ? "仅本单客服可见" : "未知",
    },
  ] as const;
  return (
    <section className="section-panel !mb-0">
      {panelTitle("订单生命周期", "用服务端已返回的事实串起订单进度；未知不会被补成成功或 0。")}
      <ol className="grid grid-cols-1 gap-3 sm:grid-cols-5" aria-label="订单生命周期">
        {steps.map((step, index) => (
          <li key={step.label} className="relative min-w-0 rounded-md border border-border bg-surface-raised p-3">
            <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${step.state === "done" ? "bg-emerald-400" : step.state === "current" ? "bg-sky-400" : step.state === "idle" ? "bg-border-strong" : "bg-amber-400"}`} aria-hidden="true" /><span className="text-xs font-medium text-foreground">{index + 1}. {step.label}</span></div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{step.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function OrderDetailView({
  snapshot,
  orderId,
  onOpenPath,
  refreshNonce,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  orderId: string;
  onOpenPath: (path: string, title?: string) => void;
  refreshNonce: number;
}) {
  const [order, setOrder] = useState<AdminOrder>();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "forbidden" | "notFound" | "error">("loading");
  const [requestId, setRequestId] = useState<string>();
  const [settlementState, setSettlementState] = useState<"loading" | "ready" | "forbidden" | "unavailable" | "error">("loading");
  const [settlement, setSettlement] = useState<AdminSettlementResponse>();
  const [settlementRequestId, setSettlementRequestId] = useState<string>();
  const sequence = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const currentSequence = ++sequence.current;
    setLoadState("loading");
    setSettlementState("loading");
    setSettlement(undefined);
    setSettlementRequestId(undefined);
    const isCurrent = () => !controller.signal.aborted && currentSequence === sequence.current;
    const settlementPromise = adminRequest<AdminSettlementResponse>(`/orders/${encodeURIComponent(orderId)}/settlement`, undefined, "GET", {}, controller.signal);
    void settlementPromise.then((value) => {
      if (!isCurrent()) return;
      setSettlement(value);
      setSettlementState("ready");
    }).catch((failure: unknown) => {
      if (!isCurrent()) return;
      setSettlementRequestId(failure instanceof AdminApiError ? failure.requestId : undefined);
      setSettlementState(failure instanceof AdminApiError && failure.status === 403 ? "forbidden" : failure instanceof AdminApiError && failure.status === 401 ? "error" : "unavailable");
    });
    try {
      const result = await adminRequest<{ order: AdminOrder }>(`/orders/${encodeURIComponent(orderId)}`, undefined, "GET", {}, controller.signal);
      if (!isCurrent()) return;
      const nextOrder = result.order;
      setOrder(nextOrder);
      setLoadState("ready");
      onOpenPath(`/orders/${encodeURIComponent(nextOrder.id)}`, nextOrder.displayNo);
    } catch (failure) {
      if (!isCurrent()) return;
      setRequestId(failure instanceof AdminApiError ? failure.requestId : undefined);
      setLoadState(failure instanceof AdminApiError && failure.status === 403 ? "forbidden" : failure instanceof AdminApiError && failure.status === 404 ? "notFound" : "error");
      controller.abort();
    }
  }, [onOpenPath, orderId]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load, refreshNonce]);

  if (loadState === "loading") return <LoadingRows />;
  if (loadState === "forbidden") return <PermissionState />;
  if (loadState === "notFound") return <DetailError message="订单不存在或不在您的游戏范围" onBack={() => onOpenPath("/orders")} onRetry={() => void load()} />;
  if (loadState === "error" || !order) return <DetailError message="订单详情加载失败" requestId={requestId} onBack={() => onOpenPath("/orders")} onRetry={() => void load()} />;

  return (
    <div className="space-y-5">
      <button type="button" className="inline-flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenPath("/orders")}><ArrowLeft size={14} aria-hidden="true" />返回订单列表（保留筛选与位置）</button>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold text-foreground">{order.displayNo}</h1>
        <StatusBadge order={order} />
        <span className="text-xs text-muted-foreground">订单对象</span>
      </div>
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">已支付不等于交付或开租；群 READY 不等于开租。页面只显示服务端投影，不提供建单、支付、取消、结算或资金写操作。</p>
      <section className="facts-grid">
        <div><span>总应付</span><strong className="font-mono tabular-nums">{money(order.amounts.totalDue)}</strong></div>
        <div><span>租金 / 押金</span><strong className="font-mono tabular-nums">{money(order.amounts.rental)} / {money(order.amounts.deposit)}</strong></div>
        <div><span>租期</span><strong>{order.termOptionCode} · {order.termSeconds} 秒</strong></div>
        <div><span>下单时间</span><strong>{formatDate(order.createdAt)}</strong></div>
        <div><span>支付时间</span><strong>{paymentTime(order)}</strong></div>
        <div><span>占用截止</span><strong>{order.status === "PENDING_PAYMENT" ? formatDate(order.holdUntil) : "不适用"}</strong></div>
      </section>
      <LifecyclePanel order={order} state={settlementState} response={settlement} />
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <PartiesPanel order={order} onOpenPath={onOpenPath} canOpenAccount={snapshot.security.isBoss || hasPermission(snapshot, "supply.review.read")} />
        <QuotePanel order={order} />
        <FulfillmentPanel order={order} onOpenPath={onOpenPath} canOpenSupport={snapshot.security.isBoss || hasPermission(snapshot, "im.support.read")} />
        <SettlementPanel state={settlementState} response={settlement} requestId={settlementRequestId} onRetry={() => void load()} />
        <TracePanel order={order} />
      </div>
    </div>
  );
}

export function AdminOrdersView({
  snapshot,
  initialOrderId,
  objectOnly = false,
  initialQuery,
  onOpenPath,
  onQueryChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialOrderId?: string;
  objectOnly?: boolean;
  initialQuery?: Record<string, string>;
  onOpenPath: (path: string, title?: string) => void;
  onQueryChange: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const canRead = snapshot.security.isBoss || hasPermission(snapshot, "order.read");
  if (!canRead) return <PermissionState />;
  const identityKey = cacheKey(snapshot);
  if (objectOnly && initialOrderId) return <OrderDetailView key={`detail:${identityKey}:${initialOrderId}`} snapshot={snapshot} orderId={initialOrderId} onOpenPath={onOpenPath} refreshNonce={refreshNonce} />;
  return <OrderListView key={`list:${identityKey}`} snapshot={snapshot} initialQuery={initialQuery} onOpenPath={onOpenPath} onQueryChange={onQueryChange} refreshNonce={refreshNonce} />;
}
