import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronRight, RefreshCw } from "lucide-react";
import { AreaChart, BarChart, CartesianGrid, ChartArea, ChartBar, ChartContainer, ChartLegendContent, ChartTooltip, ChartTooltipContent, XAxis, YAxis, type ChartConfig } from "../ui/chart";

import "./dashboard.css";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../ui/card";
import { InfoTip } from "../ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  formatAge,
  formatCents,
  formatCount,
  formatDelta,
  formatDashboardPeriod,
  dashboardOrdersPath,
  metricNote,
  metricShortNote,
  metricValue,
  type DashboardMetric,
  type DashboardPayload,
  type DashboardQueue,
  type DashboardRange,
  type DashboardRecentOrder,
  type DashboardState,
} from "./model";

export function safeDashboardPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("#")) return null;
  return value;
}

function Sparkline({ values }: { values: string[] }) {
  if (values.some(value => !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))) return null;
  const points = values.map((value) => Number(value));
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 28 - ((value - min) / span) * 24;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return <svg aria-hidden="true" className="mt-3 h-7 w-full text-[var(--chart-receipts)]" preserveAspectRatio="none" viewBox="0 0 100 32">
    <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
  </svg>;
}

export function DashboardPageHeader({
  title,
  range,
  ranges,
  onRange,
  onRefresh,
  refreshing,
  scopeLabel,
  children,
}: {
  title: string;
  range: DashboardRange;
  ranges?: DashboardRange[];
  onRange: (range: DashboardRange) => void;
  onRefresh: () => void;
  refreshing: boolean;
  scopeLabel: string;
  children?: ReactNode;
}) {
  const options = ranges ?? ["today", "7d", "30d"];
  const labels: Record<DashboardRange, string> = { today: "今天", "7d": "近7天", "30d": "近30天" };
  return <header className="flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><span className="text-xs text-muted-foreground">{scopeLabel}</span></div>
    </div>
    <div className="flex flex-nowrap items-center gap-2">
      {children}
      <div className="inline-flex shrink-0 rounded-lg border border-border bg-card p-0.5" role="group" aria-label="时间范围">
        {options.map((option) => <Button
          key={option}
          type="button"
          aria-pressed={range === option}
          onClick={() => onRange(option)}
          variant={range === option ? "secondary" : "ghost"} size="sm" className="min-h-8"
        >{labels[option]}</Button>)}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={refreshing ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />
        刷新
      </Button>
    </div>
  </header>;
}

export function StatCard({ metric, onNavigate }: { metric: DashboardMetric; onNavigate: (path: string) => void }) {
  const definitionId = useId();
  const readable = metric.state === "KNOWN" || metric.state === "PARTIAL";
  const known = metric.state === "KNOWN";
  const partial = metric.state === "PARTIAL";
  const path = readable ? safeDashboardPath(metric.drilldown) : null;
  const delta = known ? metric.delta : null;
  const value = metricValue(metric);
  const note = metricNote(metric);
  const shortNote = metricShortNote(metric);
  const hasSparkline = known && metric.sparkline.length >= 2;
  // 只保留短状态词；口径解释统一收进标题旁的 Info tooltip。
  const statusLabel = !readable ? note : partial ? "部分覆盖" : known && note !== shortNote ? note : null;
  const coverageText = partial ? (metric.coverage ? `${formatCount(metric.coverage.knownCount)}/${formatCount(metric.coverage.totalCount)} 单` : note) : null;
  return <Card size="sm" className={`dashboard-stat-card ${value.length > 18 ? "dashboard-stat-card--long" : ""}`} data-knowledge={metric.state}>
    <CardContent className="dashboard-stat-content">
      <div>
        <div className="flex items-start gap-1 text-xs font-medium text-muted-foreground">
          <span className="min-w-0">{metric.label}</span>
          <InfoTip label={`${metric.label}口径`} title={shortNote} body={metric.definition} describedBy={definitionId} />
          <span id={definitionId} className="sr-only">{metric.definition}</span>
        </div>
        <p className="dashboard-stat-value tabular-nums">{value}</p>
        {delta ? <div className="dashboard-stat-delta-row"><Badge variant={delta.direction === "FLAT" ? "outline" : delta.direction === "DOWN" ? "warning" : "success"} className="dashboard-stat-delta tabular-nums" aria-label={`较上期 ${formatDelta(metric)}`}>
          <span className="dashboard-stat-delta-label">较上期</span>
          {delta.direction === "UP" ? <ArrowUpRight aria-hidden="true" /> : delta.direction === "DOWN" ? <ArrowDownRight aria-hidden="true" /> : null}
          {formatDelta(metric)}
        </Badge></div> : null}
        {statusLabel ? <div className="dashboard-stat-meta">
          {partial ? <span className="dashboard-stat-meta-tag">{statusLabel}</span> : null}
          <span className={partial ? "dashboard-stat-meta-value" : ""}>{partial ? coverageText : statusLabel}</span>
        </div> : null}
      </div>
      <div className="dashboard-stat-footer">
        {hasSparkline ? <Sparkline values={metric.sparkline} /> : null}
        {path ? <Button type="button" variant="link" size="sm" onClick={() => onNavigate(path)} className="mt-1 h-auto justify-start px-0" aria-label={`${metric.label}查看明细`}>
          查看明细 <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button> : null}
      </div>
    </CardContent>
  </Card>;
}

type TrendKey = "receipts" | "orders";
const TREND_LABELS: Record<TrendKey, string> = { receipts: "实付金额", orders: "已付款订单" };
const TREND_CONFIG: ChartConfig = { receipts: { label: TREND_LABELS.receipts, color: "var(--chart-receipts)" }, orders: { label: TREND_LABELS.orders, color: "var(--chart-orders)" } };
const TREND_IDS: Record<TrendKey, string> = { receipts: "confirmedCents", orders: "paidOrders" };
const STATE_LABELS = { FORBIDDEN: "无读取权限", NO_GAME_SCOPE: "当前游戏范围无数据权限", UNAVAILABLE: "暂不可用", KNOWN: "", PARTIAL: "覆盖不完整" };
function chartCoordinate(value: string | null, divisor: number): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value) / divisor;
}

export function TrendPanel({ data, onNavigate }: { data: DashboardPayload; onNavigate: (path: string) => void }) {
  const [selection, setSelection] = useState<TrendKey>("receipts");
  const states = Object.fromEntries((Object.keys(TREND_IDS) as TrendKey[]).map(key => [key, data.metrics.find(item => item.id === TREND_IDS[key])?.state ?? "UNAVAILABLE"])) as Record<TrendKey, keyof typeof STATE_LABELS>;
  const available = (key: TrendKey) => states[key] === "KNOWN" || states[key] === "PARTIAL";
  const metric = available(selection) ? selection : (Object.keys(TREND_IDS) as TrendKey[]).find(available) ?? null;
  const chartData = useMemo(() => data.trend.map((day) => ({
    date: day.date,
    receipts: chartCoordinate(day.confirmedCents, 100),
    receiptsCents: day.confirmedCents,
    orders: chartCoordinate(day.paidOrders, 1),
    paidOrders: day.paidOrders,
  })), [data.trend]);
  const rawValues = metric ? data.trend.map(day => metric === "receipts" ? day.confirmedCents : day.paidOrders) : [];
  const overflow = rawValues.some(value => value !== null && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER));
  const unknown = metric !== null && chartData.some(point => point[metric] === null);
  const values = metric ? chartData.map(point => point[metric]) : [];
  const knownPoints = values.some(value => value !== null);
  const knownEmpty = metric !== null && states[metric] === "KNOWN" && !unknown && values.every(value => value === 0) && (values.length > 0 || data.metrics.find(item => item.id === TREND_IDS[metric])?.value === "0");
  const status = !metric ? (Object.values(states).every(state => state === "FORBIDDEN") ? "当前无权读取经营趋势" : "经营趋势暂不可用") : overflow ? "数值超过图表安全范围，请查看下方精确数据表" : knownEmpty ? "本期暂无数据" : !knownPoints ? "本期趋势尚未核定" : null;
  const ordersPath = available("orders") ? dashboardOrdersPath(data.period, data.metrics.find(item => item.id === "paidOrders")?.drilldown) : null;
  const label = metric ? `${TREND_LABELS[metric]}趋势，单位：${metric === "receipts" ? "元" : "笔"}` : "经营趋势";
  const legend = <ChartLegendContent payload={(Object.keys(TREND_IDS) as TrendKey[]).map(key => ({ dataKey: key, disabled: !available(key), disabledReason: !available(key) ? STATE_LABELS[states[key]] : undefined }))} selected={metric} onSelect={key => setSelection(key as TrendKey)} label="趋势指标" />;
  const tooltip = <ChartTooltip content={<ChartTooltipContent formatValue={(point, key) => key === "receipts" ? formatCents(typeof point.receiptsCents === "string" ? point.receiptsCents : null) : formatCount(typeof point.paidOrders === "string" ? point.paidOrders : null)} />} />;
  // margin.left 必须 >= 0：负值会把最宽的 Y 轴刻度（如 120,000）推出 SVG 视口被裁掉首位。
  return <Card className="min-w-0">
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>经营趋势</CardTitle>
      <div className="dashboard-trend-meta">
        <span className="dashboard-trend-meta-item"><span className="dashboard-trend-meta-label">统计区间</span>{formatDashboardPeriod(data.period)}</span>
        <span className="dashboard-trend-meta-item">单位：{metric === "receipts" ? "元" : "笔"}</span>
        {metric && (unknown || states[metric] === "PARTIAL") ? <span className="dashboard-meta-flag">部分日期未核</span> : null}
      </div>
    </CardHeader>
    <CardContent>
      <ChartContainer config={TREND_CONFIG} legend={legend} label={label} emptyState={<div className="chart-state" role="status">{status}</div>}>
        {status ? null : metric === "receipts" ? <AreaChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={value => String(value).slice(5)} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} minTickGap={22} />
            <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} tickFormatter={(value) => Number(value).toLocaleString("zh-CN")} />
            {tooltip}
            <ChartArea dataKey="receipts" name="实付金额" />
          </AreaChart> : <BarChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={value => String(value).slice(5)} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} minTickGap={22} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
            {tooltip}
            <ChartBar dataKey="orders" name="已付款订单" />
          </BarChart>}
      </ChartContainer>
      <details className="mt-3 text-xs text-muted-foreground" open={overflow || undefined}>
        <summary className="chart-table-summary">查看精确数据表</summary>
        <div className="mt-2 overflow-x-auto">
          <Table><caption className="sr-only">{label}，原始精确数值，未核日期显示横杠</caption><TableHeader><TableRow><TableHead scope="col">日期</TableHead><TableHead scope="col" className="text-right">实付金额（元）</TableHead><TableHead scope="col" className="text-right">已付款订单（笔）</TableHead></TableRow></TableHeader>
            <TableBody>{data.trend.map(day => <TableRow key={day.date}><TableCell>{day.date}</TableCell><TableCell className="text-right tabular-nums">{available("receipts") ? formatCents(day.confirmedCents) : "—"}</TableCell><TableCell className="text-right tabular-nums">{available("orders") ? formatCount(day.paidOrders) : "—"}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      </details>
      {ordersPath ? <div className="mt-3 flex justify-end border-t border-border pt-3">
        <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onNavigate(ordersPath)}>查看订单 <ChevronRight className="size-3.5" aria-hidden="true" /></Button>
      </div> : null}
    </CardContent>
  </Card>;
}

export function ActionQueue({ queues, onNavigate, layout = "list" }: { queues: DashboardQueue[]; onNavigate: (path: string) => void; layout?: "list" | "grid" }) {
  return <Card className="min-w-0">
    <CardHeader>
      <div className="flex items-center gap-1.5">
        <CardTitle role="heading" aria-level={2}>待办与异常</CardTitle>
        <InfoTip label="待办队列范围" title="按当前权限筛选" body="仅列出你有权限处理的事项。" />
      </div>
    </CardHeader>
    <CardContent>
      {queues.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">当前没有可处理事项</div> : <ul className={layout === "grid" ? "dashboard-queue-grid" : "divide-y divide-border"}>
        {queues.map((queue) => {
          const path = safeDashboardPath(queue.drilldown);
          return <li key={queue.id}>
            <Button type="button" variant="ghost" disabled={!path} onClick={() => path && onNavigate(path)} className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-0 py-3 text-left disabled:cursor-default disabled:opacity-70">
              <span className={`size-2 shrink-0 rounded-full ${queue.severity === "CRITICAL" ? "bg-destructive" : queue.severity === "WARN" ? "bg-warning" : "bg-info"}`} aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{queue.label}</span>{path ? <span className="dashboard-queue-cta">去处理</span> : null}</span>
              <span className="text-right"><strong className="text-lg tabular-nums">{formatCount(queue.count)}</strong><span className="mt-0.5 block text-[11px] text-muted-foreground">最久 {formatAge(queue.oldestAgeSeconds)}</span></span>
              <ChevronRight className={`dashboard-queue-chevron size-4 text-muted-foreground ${path ? "" : "opacity-0"}`} aria-hidden="true" />
            </Button>
          </li>;
        })}
      </ul>}
    </CardContent>
  </Card>;
}

const STATUS_LABELS: Record<DashboardRecentOrder["status"], string> = {
  PENDING_PAYMENT: "待付款",
  PAID: "已付款",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  UNKNOWN: "状态未知",
};
const CONTRIBUTION_LABELS: Record<DashboardRecentOrder["contributionState"], string> = {
  SETTLED: "已结算",
  QUOTED: "报价估算",
  UNAVAILABLE: "无依据",
};

function contributionLabel(order: DashboardRecentOrder): string {
  return order.status === "CANCELLED" && order.contributionState === "QUOTED" ? "估算未入账" : CONTRIBUTION_LABELS[order.contributionState];
}

export function RecentTable({ orders, period, ordersState, ordersDrilldown, onNavigate, allowContribution = true }: { orders: DashboardRecentOrder[]; period: DashboardPayload["period"]; ordersState: DashboardState; ordersDrilldown?: string | null; onNavigate: (path: string) => void; allowContribution?: boolean }) {
  const readable = ordersState === "KNOWN" || ordersState === "PARTIAL";
  const ordersPath = readable ? dashboardOrdersPath(period, ordersDrilldown) : null;
  const showContribution = allowContribution && orders.some((order) => order.contributionState !== "UNAVAILABLE");
  return <Card className="min-w-0">
    <CardHeader><div><CardTitle role="heading" aria-level={2}>最近成交</CardTitle><p className="mt-1 text-xs text-muted-foreground">{readable && (orders.length > 0 || ordersPath) ? <>最近 {orders.length} 笔本期已付款订单{ordersState === "PARTIAL" ? <span className="dashboard-meta-flag">范围未完整核定</span> : null}</> : "当前无法读取本期成交"}</p></div>{ordersPath ? <CardAction><Button type="button" variant="link" size="sm" onClick={() => onNavigate(ordersPath)}>全部订单</Button></CardAction> : null}</CardHeader>
    <CardContent>
      {!readable || orders.length === 0 ? <div className="chart-state" role="status">{!readable ? "当前无法读取本期成交" : ordersState === "PARTIAL" ? "暂未读到成交，范围未完整核定" : !ordersPath ? "当前无法读取本期成交" : "本期暂无成交"}</div> : <>
        <div className="grid gap-2 sm:hidden">
          {orders.map((order) => <Button key={order.id} type="button" variant="ghost" onClick={() => onNavigate(`/orders/${encodeURIComponent(order.id)}`)} className="block h-auto w-full whitespace-normal rounded-lg border-border p-3 text-left">
            <div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{order.displayNo}</span><Badge variant={order.status === "PAID" ? "info" : order.status === "COMPLETED" ? "success" : order.status === "CANCELLED" ? "secondary" : "outline"}>{STATUS_LABELS[order.status]}</Badge></div>
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>实付金额 <strong className="font-medium text-foreground tabular-nums">{formatCents(order.confirmedCents)}</strong></span><span>{order.paidAt ? new Date(order.paidAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</span></div>
            {showContribution ? <p className="mt-1 text-[11px] text-muted-foreground">平台贡献 {formatCents(order.contributionState === "UNAVAILABLE" ? null : order.contributionCents)} · {contributionLabel(order)}</p> : null}
          </Button>)}
        </div>
        <div className="hidden overflow-x-auto sm:block">
          <Table>
            <TableHeader><TableRow><TableHead>订单号</TableHead><TableHead>状态</TableHead><TableHead className="text-right">实付金额</TableHead>{showContribution ? <TableHead className="text-right">平台贡献</TableHead> : null}<TableHead className="text-right">时间</TableHead></TableRow></TableHeader>
            <TableBody>{orders.map((order) => <TableRow key={order.id}>
              <TableCell><Button type="button" variant="link" size="sm" onClick={() => onNavigate(`/orders/${encodeURIComponent(order.id)}`)} className="h-auto justify-start px-0 font-medium text-foreground tabular-nums">{order.displayNo}</Button></TableCell>
              <TableCell><Badge variant={order.status === "PAID" ? "info" : order.status === "COMPLETED" ? "success" : order.status === "CANCELLED" ? "secondary" : "outline"}>{STATUS_LABELS[order.status]}</Badge></TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(order.confirmedCents)}</TableCell>
              {showContribution ? <TableCell className="text-right tabular-nums"><span>{formatCents(order.contributionState === "UNAVAILABLE" ? null : order.contributionCents)}</span><span className="dashboard-cell-meta">{contributionLabel(order)}</span></TableCell> : null}
              <TableCell className="text-right text-xs text-muted-foreground">{order.paidAt ? new Date(order.paidAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
      </>}
    </CardContent>
  </Card>;
}
