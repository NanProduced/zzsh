import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminRequest, AdminApiError, formatDate, friendlyError, type SessionSnapshot } from "../api";
import { Button } from "../components/ui/button";
import "./overview.css";

type OverviewRange = "today" | "7d" | "30d";
type OverviewMetric = { id: string; value: string | null; unit: "COUNT" | "CNY_CENTS"; state: "KNOWN" | "FORBIDDEN" | "NO_GAME_SCOPE" | "UNAVAILABLE"; drilldown?: string | null };
export type WorkspaceOverviewData = {
  version: "admin.overview.v1";
  observedAt: string;
  period: { range: OverviewRange; from: string; to: string; timeZone: "Asia/Shanghai" };
  scope: { mode: "ALL_GAMES" | "SELECTED_GAMES"; gameIds: string[] };
  metrics: OverviewMetric[];
  trend: { date: string; orders: string; payments: string; confirmedCents: string | null }[];
};

const RANGES = [{ value: "today", label: "今天" }, { value: "7d", label: "近7天" }, { value: "30d", label: "近30天" }] as const;
const unsigned = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function parseWorkspaceOverview(value: unknown): WorkspaceOverviewData {
  const data = value as WorkspaceOverviewData;
  if (!data || data.version !== "admin.overview.v1" || !instant(data.observedAt)
    || !data.period || !RANGES.some(range => range.value === data.period.range) || data.period.timeZone !== "Asia/Shanghai"
    || !instant(data.period.from) || !instant(data.period.to) || Date.parse(data.period.from) > Date.parse(data.period.to)
    || !data.scope || !["ALL_GAMES", "SELECTED_GAMES"].includes(data.scope.mode) || !Array.isArray(data.scope.gameIds)
    || !data.scope.gameIds.every(id => typeof id === "string")
    || !Array.isArray(data.metrics) || data.metrics.length > 32 || new Set(data.metrics.map(metric => metric?.id)).size !== data.metrics.length
    || !data.metrics.every(metric => metric && typeof metric.id === "string" && ["COUNT", "CNY_CENTS"].includes(metric.unit)
      && ["KNOWN", "FORBIDDEN", "NO_GAME_SCOPE", "UNAVAILABLE"].includes(metric.state)
      && (metric.state === "KNOWN" ? unsigned(metric.value) : metric.value === null)
      && (metric.drilldown === undefined || metric.drilldown === null || typeof metric.drilldown === "string" && metric.drilldown.length <= 1500))
    || !Array.isArray(data.trend) || data.trend.length > 31 || new Set(data.trend.map(day => day?.date)).size !== data.trend.length
    || !data.trend.every(day => day && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && unsigned(day.orders) && unsigned(day.payments)
      && (day.confirmedCents === null || unsigned(day.confirmedCents)))) throw new AdminApiError(502, "OVERVIEW_CONTRACT_INVALID");
  return data;
}

/** Financial values stay exact decimal strings; chart coordinates never become money facts. */
export function overviewMetricText(metric: OverviewMetric | undefined): string {
  if (!metric || metric.state !== "KNOWN" || !unsigned(metric.value)) return "—";
  const number = BigInt(metric.value);
  if (metric.unit === "CNY_CENTS") return `¥${(number / 100n).toLocaleString("zh-CN")}.${(number % 100n).toString().padStart(2, "0")}`;
  return number.toLocaleString("zh-CN");
}

const METRICS = [
  { id: "ordersCreated", label: "本期新建订单", note: "新平台原生订单" },
  { id: "confirmedCents", label: "本站确认收款", note: "不代表渠道或银行到账" },
  { id: "accountsPublished", label: "已发布账号", note: "当前发布状态，不等于当前可租" },
  { id: "usersNew", label: "本期建档用户", note: "含导入，并非旧平台注册时间" },
] as const;
const QUEUES = [
  { id: "supportWaiting", label: "等待客服接待" },
  { id: "supportMine", label: "我的进行中接待" },
  { id: "listingsPendingReview", label: "账号待审核" },
  { id: "ordersPendingPayment", label: "订单待付款" },
  { id: "ordersPaid", label: "已付款待完单" },
] as const;
const STATE_LABEL = { KNOWN: "", FORBIDDEN: "无读取权限", NO_GAME_SCOPE: "不在当前游戏范围", UNAVAILABLE: "能力尚未装配" } as const;

/** Only the server's same-predicate drilldown is used; a related list is not an equivalent count. */
export function overviewDrilldown(metric: OverviewMetric | undefined): string | null {
  if (metric?.state !== "KNOWN" || !metric.drilldown?.startsWith("/") || metric.drilldown.startsWith("//") || metric.drilldown.includes("\\") || metric.drilldown.includes("#")) return null;
  const url = new URL(metric.drilldown, "https://workspace.invalid");
  const keys: Record<string, readonly string[]> = {
    "/orders": ["origin", "status", "createdFrom", "createdTo", "paymentConfirmedFrom", "paymentConfirmedTo", "paymentOpen", "fundsResolution"],
    "/users": ["registrationTime", "registeredFrom", "registeredTo", "registeredBefore", "sort"],
    "/supply/reviews": ["reviewState", "publication", "state", "tab"],
    "/support": ["section", "queue"], "/support/mine": [],
  };
  if (url.origin !== "https://workspace.invalid" || !keys[url.pathname]) return null;
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) { if (seen.has(key) || !keys[url.pathname]!.includes(key)) return null; seen.add(key); }
  return url.pathname + url.search;
}

function OrderTrend({ data }: { data: WorkspaceOverviewData }) {
  const chart = data.trend.map(day => ({ date: day.date.slice(5), orders: Number(day.orders), payments: Number(day.payments) }));
  const safeChart = chart.every(day => Number.isSafeInteger(day.orders) && Number.isSafeInteger(day.payments));
  return <section className="overview-trend" aria-labelledby="overview-trend-title">
    <div className="overview-section-heading"><h3 id="overview-trend-title">订单与收款确认趋势</h3><span>单位：笔 · 北京时间</span></div>
    {safeChart ? <div className="overview-chart" aria-hidden="true"><ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={chart} margin={{ top: 12, right: 10, left: -20, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} minTickGap={24} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
        <Legend verticalAlign="top" align="left" iconType="circle" wrapperStyle={{ paddingBottom: 12, fontSize: 11 }} />
        <Tooltip contentStyle={{ background: "var(--background)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
        <Bar dataKey="orders" name="新建原生订单" fill="var(--chart-1, #4386df)" radius={[3, 3, 0, 0]} maxBarSize={30} isAnimationActive={false} />
        <Line type="linear" dataKey="payments" name="本站收款确认" stroke="var(--chart-2, #be8957)" strokeWidth={2} dot={chart.length === 1} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer></div> : <p className="text-sm text-muted-foreground">数值超过图表精确显示范围，请查看下方数据表。</p>}
    <details className="overview-trend-data"><summary>查看每日数据</summary><div className="overflow-x-auto"><table>
      <caption className="sr-only">原生订单与本站确认收款每日数据，银行到账不在本表范围</caption>
      <thead><tr><th scope="col">日期</th><th scope="col">新建订单</th><th scope="col">收款确认</th><th scope="col">本站确认金额</th></tr></thead>
      <tbody>{data.trend.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{BigInt(day.orders).toLocaleString("zh-CN")}</td><td>{BigInt(day.payments).toLocaleString("zh-CN")}</td><td>{overviewMetricText({ id: "trend", value: day.confirmedCents, unit: "CNY_CENTS", state: day.confirmedCents === null ? "FORBIDDEN" : "KNOWN" })}</td></tr>)}</tbody>
    </table></div></details>
  </section>;
}

export function WorkspaceOverview({ snapshot, onNavigate, refreshNonce = 0 }: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onNavigate: (path: string) => void;
  refreshNonce?: number;
}) {
  const active = snapshot.security.status === "ACTIVE" && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const [range, setRange] = useState<OverviewRange>("7d");
  const [reload, setReload] = useState(0);
  const owner = `${snapshot.adminUserId}:${snapshot.session.id}:${active}:${snapshot.security.isBoss}:${[...snapshot.permissions].sort().join(",")}:${range}:${refreshNonce}:${reload}`;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const [state, setState] = useState<{ owner: string; data: WorkspaceOverviewData | null; error: string; busy: boolean }>({ owner, data: null, error: "", busy: true });
  const load = useCallback(async (signal: AbortSignal) => {
    setState({ owner, data: null, error: "", busy: true });
    try {
      const data = parseWorkspaceOverview(await adminRequest<unknown>(`/workspace/overview?range=${range}`, undefined, "GET", {}, signal));
      if (data.period.range !== range) throw new AdminApiError(502, "OVERVIEW_PERIOD_MISMATCH");
      if (!signal.aborted && currentOwner.current === owner) setState({ owner, data, error: "", busy: false });
    } catch (error) {
      if (!signal.aborted && currentOwner.current === owner) setState({ owner, data: null, error: friendlyError(error), busy: false });
    }
  }, [owner, range]);
  useEffect(() => {
    const controller = new AbortController();
    if (active) void load(controller.signal);
    return () => controller.abort();
  }, [active, load]);
  if (!active) return null;
  const current = state.owner === owner ? state : { data: null, error: "", busy: true };
  const data = current.data;
  const metric = (id: string) => data?.metrics.find(value => value.id === id);
  const visible = (id: string) => Boolean(metric(id) && metric(id)?.state !== "FORBIDDEN");
  const noMetrics = data && !data.metrics.some(value => value.state === "KNOWN");
  return <section className="workspace-overview" aria-labelledby="workspace-overview-title" aria-busy={current.busy}>
    <header className="overview-heading"><div><h2 id="workspace-overview-title">经营与待办</h2><p>{data ? `${data.scope.mode === "ALL_GAMES" ? "当前全部游戏" : `当前授权的 ${data.scope.gameIds.length} 个游戏`} · 更新于 ${formatDate(data.observedAt)}` : "按当前身份和游戏范围读取"}</p></div>
      <div className="overview-actions"><div className="overview-ranges" role="group" aria-label="经营概览时间范围">{RANGES.map(item => <button key={item.value} type="button" aria-pressed={range === item.value} onClick={() => setRange(item.value)}>{item.label}</button>)}</div><Button type="button" variant="ghost" size="sm" aria-label="刷新经营概览" disabled={current.busy} onClick={() => setReload(value => value + 1)}><RefreshCw aria-hidden="true" className={current.busy ? "animate-spin" : ""} /></Button></div>
    </header>
    {current.busy ? <div className="overview-loading" role="status" aria-label="正在读取经营与待办"><span /><span /><span /></div> : null}
    {current.error ? <div className="overview-error" role="alert"><p>经营数据暂时无法读取，未显示上次的金额。{current.error}</p><Button type="button" variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>重试概览</Button></div> : null}
    {noMetrics ? <p className="overview-empty">当前没有可展示的经营数据。请核对业务读取权限与游戏范围；个人快捷入口仍可使用。</p> : null}
    {data ? <>
      {METRICS.some(item => visible(item.id)) ? <dl className="overview-metrics">{METRICS.filter(item => visible(item.id)).map(item => <div key={item.id} data-metric={item.id} data-state={metric(item.id)?.state}><dt>{item.label}</dt><dd>{overviewMetricText(metric(item.id))}</dd><p>{metric(item.id)?.state === "KNOWN" ? item.note : STATE_LABEL[metric(item.id)!.state]}</p><button type="button" onClick={() => { const path = overviewDrilldown(metric(item.id)); if (path) onNavigate(path); }} disabled={!overviewDrilldown(metric(item.id))}>{overviewDrilldown(metric(item.id)) ? "查看同口径明细" : "暂无同口径明细"}<ArrowUpRight size={13} aria-hidden="true" /></button></div>)}</dl> : null}
      <div className="overview-body">
        {data.trend.length ? <OrderTrend data={data} /> : null}
        {QUEUES.some(item => visible(item.id)) ? <section className="overview-queues" aria-labelledby="overview-queues-title"><div className="overview-section-heading"><h3 id="overview-queues-title">当前待办</h3><span>当前状态，不限所选时段</span></div><ul>{QUEUES.filter(item => visible(item.id)).map(item => <li key={item.id}><button type="button" onClick={() => { const path = overviewDrilldown(metric(item.id)); if (path) onNavigate(path); }} disabled={!overviewDrilldown(metric(item.id))}><span>{item.label}</span><strong>{overviewMetricText(metric(item.id))}</strong><ArrowUpRight size={14} aria-hidden="true" /></button>{metric(item.id)?.state !== "KNOWN" ? <small>{STATE_LABEL[metric(item.id)!.state]}</small> : !overviewDrilldown(metric(item.id)) ? <small>当前暂无同口径明细入口</small> : null}</li>)}</ul></section> : null}
      </div>
      <footer className="overview-footnote">{[{ id: "usersTotal", label: "用户档案" }, { id: "accountsTotal", label: "账号记录" }, { id: "legacyOrdersTotal", label: "已载入历史订单" }].filter(item => metric(item.id)?.state === "KNOWN").map(item => <span key={item.id}>{item.label} {overviewMetricText(metric(item.id))}</span>)}<p>趋势仅含新平台原生订单与本站收款确认；历史记录另列。统计不作为银行到账或平台利润证明。</p></footer>
    </> : null}
  </section>;
}
