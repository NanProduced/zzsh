"use client";

/**
 * 客服管理（运营）：看板 + 会话巡视。
 *
 * - 只看服务端已给出的数字；缺失/空/403/失败都保持真实状态，不造数据、不补时间。
 * - 图表用 recharts 绘制，配色只取 --mgmt-chart-*；无可画数据时显示“暂无数据”。
 * - 巡视复用工作台的消息外观（文本/图片/卡片/系统事件），只读、无发送框。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleAlert, Headphones, RefreshCw, ShieldCheck } from "lucide-react";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import { decodeImSystemNotice } from "@zzsh/im-client/message-state";
import { AdminApiError, friendlyError } from "../api";
import { beijingCalendarDate } from "../workspace/beijing-time";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Marker, MarkerContent } from "../components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "../components/ui/message";
import { supportedImageUrl } from "./im-support-guards";
import { dayKeyOf, dayLabelOf, formatDateTime, formatTime, initialOf } from "./im-support-format";
import {
  attentionSignals, auditConversationsPath, auditMessagesPath, auditStateLabel, auditTypeLabel,
  availabilityLabel, cumulativeSessions, formatDayLabel, formatDuration, formatRatingAverage,
  formatSlaDuration, handoverObjectLabel, handoverStatsToday, handoverSummaryText, hasHourlyData, hasTrendData, hasWorkloadData, hourlySlots,
  parseAuditConversations, parseAuditMessages, parseSupportHandovers,
  parseSupportOverview, queueReasonLabel, ratingBuckets, SUPPORT_ATTENTION_LOAD_LINE, SUPPORT_HANDOVER_PAGE_LIMIT, SUPPORT_SLA_GAPS, withinTimeFilter,
  type AuditConversation, type AuditTimeFilter, type SupportHandover, type SupportOverview,
  type SupportOverviewAgent, type SupportRatings, type SupportTrendPoint,
} from "./im-support-management-model";

const DASHBOARD_REFRESH_MS = 20_000;
const GROUP_WINDOW_MS = 300_000;
const CARD_LABELS: Record<string, string> = {
  ORDER_OPENING: "本单确认",
  ORDER_ENDING: "结束确认",
  ORDER_SETTLED: "结算完成",
  ORDER_PRICE_CHANGE: "价格调整",
};

export type SupportManagementRequest = <T>(
  path: string,
  body?: Record<string, unknown>,
  method?: "GET" | "POST" | "PUT" | "DELETE",
) => Promise<T>;

type LoadState = "loading" | "ready" | "forbidden" | "error";
type Notice = { tone: "success" | "error"; text: string };

function statusOf(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

/* ------------------------------ 看板 ------------------------------ */

export function SupportDashboard({ active, request }: { active: boolean; request: SupportManagementRequest }) {
  const [overview, setOverview] = useState<SupportOverview | null>(null);
  const [overviewState, setOverviewState] = useState<LoadState>("loading");
  const [overviewError, setOverviewError] = useState("");
  const [handovers, setHandovers] = useState<SupportHandover[] | null>(null);
  const [handoverState, setHandoverState] = useState<LoadState>("loading");
  const [handoverError, setHandoverError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setRefreshing(true);
    setOverviewState((current) => (current === "ready" ? current : "loading"));
    setHandoverState((current) => (current === "ready" ? current : "loading"));
    const [overviewResult, handoverResult] = await Promise.allSettled([
      request<unknown>(`/im/support-overview?date=${beijingCalendarDate()}`),
      // 交接单页上限 50 条：今日交接统计只能在这个分母内，卡片与摘要都写明。
      request<unknown>(`/im/handovers?limit=${SUPPORT_HANDOVER_PAGE_LIMIT}`),
    ]);
    if (generation !== generationRef.current) return;
    if (overviewResult.status === "fulfilled") {
      setOverview(parseSupportOverview(overviewResult.value));
      setOverviewState("ready");
      setOverviewError("");
    } else {
      const forbidden = statusOf(overviewResult.reason) === 403;
      if (forbidden) setOverview(null);
      setOverviewState(forbidden ? "forbidden" : "error");
      setOverviewError(friendlyError(overviewResult.reason));
    }
    if (handoverResult.status === "fulfilled") {
      setHandovers(parseSupportHandovers(handoverResult.value));
      setHandoverState("ready");
      setHandoverError("");
    } else {
      const forbidden = statusOf(handoverResult.reason) === 403;
      if (forbidden) setHandovers(null);
      setHandoverState(forbidden ? "forbidden" : "error");
      setHandoverError(friendlyError(handoverResult.reason));
    }
    setRefreshing(false);
  }, [request]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, DASHBOARD_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      generationRef.current += 1;
    };
  }, [active, load]);

  if (overviewState === "loading" && !overview) {
    return <p className="im-wb-mgmt-state" role="status">正在读取客服数据…</p>;
  }
  if (overviewState === "forbidden") {
    return <div className="im-wb-mgmt-state" data-state="forbidden" role="status"><ShieldCheck size={22} aria-hidden="true" /><strong>无权查看客服管理数据</strong><span>需要「客服管理读取」权限；Boss 默认可用。</span></div>;
  }
  if (overviewState === "error" && !overview) {
    return <div className="im-wb-mgmt-state" data-state="error" role="alert"><CircleAlert size={22} aria-hidden="true" /><strong>客服数据读取失败</strong><span>{overviewError}</span><Button variant="outline" size="sm" onClick={() => void load()}>重新读取</Button></div>;
  }
  if (!overview) return null;

  return <div className="im-wb-mgmt-dashboard" data-state={overviewState}>
    <div className="im-wb-mgmt-toolbar">
      <span className="im-wb-mgmt-toolbar-note">今日口径：北京时间自然日{overviewState === "error" ? ` · 刷新失败：${overviewError}` : ""}</span>
      <Button variant="outline" size="sm" data-action="refresh-dashboard" onClick={() => void load()} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新"}</Button>
    </div>

    <div className="im-wb-mgmt-totals" aria-label="今日汇总">
      <MetricCard label="在线客服" value={overview.totals.onDutyCount} />
      <MetricCard label="排队咨询" value={overview.totals.waitingConsultations} />
      <MetricCard label="今日会话" value={overview.totals.todaySessions} />
      <MetricCard label="今日用户" value={overview.totals.todayUsers} />
    </div>

    <HandoverSummaryCard overview={overview} handovers={handovers} handoverState={handoverState} />

    <ServiceTimelinessCard overview={overview} handovers={handovers} handoverState={handoverState} />

    <RatingCard ratings={overview.ratings} />

    <Card className="im-wb-mgmt-card" data-panel="on-duty">
      <CardHeader><CardTitle>当日服务与接待</CardTitle><CardDescription>状态、当前负载与今日接待量</CardDescription></CardHeader>
      <CardContent className="im-wb-mgmt-card-content">
        <div className="im-wb-mgmt-table-wrap"><Table className="im-wb-mgmt-table">
          <TableHeader><TableRow>
            <TableHead>客服</TableHead><TableHead>状态</TableHead><TableHead className="text-right">当前接待</TableHead>
            <TableHead className="text-right">今日接待</TableHead><TableHead className="text-right">今日会话</TableHead>
            <TableHead className="text-right">今日用户</TableHead><TableHead className="text-right">负责订单群</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {overview.onDuty.length ? overview.onDuty.map((agent) => <TableRow key={agent.adminUserId || agent.name} data-admin-user-id={agent.adminUserId}>
              <TableCell className="font-medium">{agent.name}</TableCell>
              <TableCell><Badge variant={agent.availability === "AVAILABLE" ? "success" : agent.availability === "PAUSED" ? "warning" : "unknown"}>{availabilityLabel(agent)}</Badge></TableCell>
              <TableCell className="text-right tabular-nums">{agent.activeLoad}</TableCell>
              <TableCell className="text-right tabular-nums">{formatDuration(agent.todaySeconds)}</TableCell>
              <TableCell className="text-right tabular-nums">{agent.todaySessions}</TableCell>
              <TableCell className="text-right tabular-nums">{agent.todayUsers}</TableCell>
              <TableCell className="text-right tabular-nums">{agent.currentOrderGroups}</TableCell>
            </TableRow>) : <TableRow><TableCell colSpan={7} className="im-wb-mgmt-empty-cell">暂无客服数据</TableCell></TableRow>}
          </TableBody>
        </Table></div>
      </CardContent>
    </Card>

    <div className="im-wb-mgmt-charts">
      <TrendChart points={overview.trend} />
      <HourlyChart hourly={overview.hourly} />
      <TodayTrendChart hourly={overview.hourly} />
      <RatingDistributionChart ratings={overview.ratings} />
      <AgentWorkloadChart agents={overview.onDuty} />
      <AgentCompareChart agents={overview.onDuty} />
    </div>

    <HandoverCard state={handoverState} error={handoverError} items={handovers} onRetry={() => void load()} />
  </div>;
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return <Card size="sm" className="im-wb-mgmt-metric"><CardContent>
    <span className="im-wb-mgmt-metric-value">{value}</span>
    <span className="im-wb-mgmt-metric-label">{label}</span>
  </CardContent></Card>;
}

/** 评价统计：count 为 0 时只说明“今日暂无评价”，不画 0 分平均分或空趋势。 */
function RatingCard({ ratings }: { ratings: SupportRatings }) {
  return <Card className="im-wb-mgmt-card" data-panel="ratings" data-count={ratings.count}>
    <CardHeader><CardTitle>今日评价</CardTitle><CardDescription>仅统计已提交评价；按北京时间自然日</CardDescription></CardHeader>
    <CardContent className="im-wb-mgmt-card-content">
      {ratings.count === 0
        ? <p className="im-wb-mgmt-inline-state" role="status" data-rating-empty>今日暂无评价</p>
        : <>
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-4 pb-3">
            <span className="flex items-baseline gap-2" data-rating-metric="count">
              <b className="text-2xl font-semibold tabular-nums">{ratings.count}</b>
              <span className="text-xs text-muted-foreground">今日评价数</span>
            </span>
            <span className="flex items-baseline gap-2" data-rating-metric="average">
              <b className="text-2xl font-semibold tabular-nums">{formatRatingAverage(ratings.average)}</b>
              <span className="text-xs text-muted-foreground">平均分</span>
            </span>
            <span className="text-xs text-muted-foreground">星级分布在下方「今日评分分布」图里，只画一处</span>
          </div>
          <div className="im-wb-mgmt-table-wrap"><Table className="im-wb-mgmt-table">
            <TableHeader><TableRow><TableHead>客服</TableHead><TableHead className="text-right">评价数</TableHead><TableHead className="text-right">平均分</TableHead></TableRow></TableHeader>
            <TableBody>
              {ratings.agents.length ? ratings.agents.map((agent) => <TableRow key={agent.adminUserId} data-rating-agent={agent.adminUserId}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell className="text-right tabular-nums">{agent.count}</TableCell>
                <TableCell className="text-right tabular-nums">{formatRatingAverage(agent.average)}</TableCell>
              </TableRow>) : <TableRow><TableCell colSpan={3} className="im-wb-mgmt-empty-cell">暂无按客服统计</TableCell></TableRow>}
            </TableBody>
          </Table></div>
        </>}
    </CardContent>
  </Card>;
}

function TrendChart({ points }: { points: SupportTrendPoint[] }) {
  const visible = points.slice(-7);
  const data = visible.map((point) => ({ label: formatDayLabel(point.date), sessions: point.sessions, users: point.users }));
  const totalSessions = data.reduce((sum, point) => sum + point.sessions, 0);
  return <Card className="im-wb-mgmt-card" data-chart="trend" data-points={data.length}>
    <CardHeader><CardTitle>近 7 天咨询与会话用户</CardTitle><CardDescription>双系列：咨询会话数 / 接待用户数</CardDescription></CardHeader>
    <CardContent>
      <div className="im-wb-mgmt-legend"><span data-series="sessions">会话</span><span data-series="users">用户</span><span className="im-wb-mgmt-chart-summary">7 天会话 {totalSessions} 次</span></div>
      {hasTrendData(visible) ? <div className="im-wb-mgmt-chartbox" role="img" aria-label="近 7 天咨询会话数与接待用户数">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="26%">
            <defs>
              <linearGradient id="mgmt-trend-sessions" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.38} /></linearGradient>
              <linearGradient id="mgmt-trend-users" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.38} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} formatter={(value, name) => [`${value}`, name === "sessions" ? "会话" : "用户"]} />
            <Bar dataKey="sessions" name="sessions" fill="url(#mgmt-trend-sessions)" radius={[5, 5, 0, 0]} maxBarSize={26} />
            <Bar dataKey="users" name="users" fill="url(#mgmt-trend-users)" radius={[5, 5, 0, 0]} maxBarSize={26} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无数据</p>}
    </CardContent>
  </Card>;
}

function HourlyChart({ hourly }: { hourly: ReturnType<typeof hourlySlots> }) {
  const slots = hourlySlots(hourly);
  const data = slots.map((point) => ({ hour: point.hour, label: String(point.hour).padStart(2, "0"), sessions: point.sessions }));
  const totalSessions = data.reduce((sum, point) => sum + point.sessions, 0);
  return <Card className="im-wb-mgmt-card" data-chart="hourly" data-points={slots.filter((point) => point.sessions > 0).length}>
    <CardHeader><CardTitle>今日每小时新咨询</CardTitle><CardDescription>00:00–23:00 · 今日共 {totalSessions} 次；悬停查看具体时段</CardDescription></CardHeader>
    <CardContent>
      {hasHourlyData(slots) ? <div className="im-wb-mgmt-chartbox" role="img" aria-label="今日每小时新咨询量">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="18%">
            <defs><linearGradient id="mgmt-hourly" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.35} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" interval={2} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} labelFormatter={(label) => `${label}:00`} formatter={(value) => [`${value}`, "新咨询"]} />
            <Bar dataKey="sessions" name="sessions" fill="url(#mgmt-hourly)" radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无数据</p>}
    </CardContent>
  </Card>;
}

function AgentWorkloadChart({ agents }: { agents: SupportOverviewAgent[] }) {
  const data = agents.map((agent) => ({
    name: agent.name,
    adminUserId: agent.adminUserId,
    hours: Math.round((agent.todaySeconds / 3600) * 10) / 10,
    sessions: agent.todaySessions,
    display: formatDuration(agent.todaySeconds),
  }));
  // A single three-minute shift must not paint a full-width bar: keep an 8h workday domain.
  const maxHours = Math.max(8, Math.ceil(Math.max(0, ...data.map((point) => point.hours))));
  const totalHours = Math.round(data.reduce((sum, point) => sum + point.hours, 0) * 10) / 10;
  return <Card className="im-wb-mgmt-card" data-chart="workload" data-points={data.length}>
    <CardHeader><CardTitle>今日接待时长</CardTitle><CardDescription>{data.length} 名客服 · 合计 {totalHours} 小时；会话数在悬停提示中显示</CardDescription></CardHeader>
    <CardContent>
      <div className="im-wb-mgmt-legend"><span data-series="seconds">接待时长（小时）</span></div>
      {hasWorkloadData(agents) ? <div className="im-wb-mgmt-chartbox" role="img" aria-label="今日各客服接待时长">
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 48)}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
            <defs><linearGradient id="mgmt-workload" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="var(--mgmt-chart-3)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--mgmt-chart-3)" stopOpacity={0.95} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis type="number" domain={[0, maxHours]} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={6} tickFormatter={(value) => `${value}h`} />
            <YAxis type="category" dataKey="name" width={64} tick={{ fill: "var(--foreground)", fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value, _name, item) => [`${(item.payload as { display?: string }).display ?? `${value}h`} · ${(item.payload as { sessions?: number }).sessions ?? 0} 会话`, "接待"]} />
            <Bar dataKey="hours" name="hours" fill="url(#mgmt-workload)" radius={[0, 5, 5, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无数据</p>}
    </CardContent>
  </Card>;
}

function HandoverCard({ state, error, items, onRetry }: { state: LoadState; error: string; items: SupportHandover[] | null; onRetry: () => void }) {
  return <Card className="im-wb-mgmt-card" data-panel="handovers">
    <CardHeader><CardTitle>最近交接</CardTitle><CardDescription>最近 50 条（单页上限）；客服本人只看到与自己相关的记录</CardDescription></CardHeader>
    <CardContent className="im-wb-mgmt-card-content">
      {state === "loading" && !items ? <p className="im-wb-mgmt-inline-state" role="status">正在读取交接记录…</p>
        : state === "forbidden" ? <p className="im-wb-mgmt-inline-state" role="status">无权查看交接记录</p>
          : state === "error" ? <p className="im-wb-mgmt-inline-state" role="alert">交接记录读取失败：{error}<Button variant="link" size="sm" onClick={onRetry}>重试</Button></p>
            : !items || !items.length ? <p className="im-wb-mgmt-inline-state" role="status">暂无交接记录</p>
              : <ul className="im-wb-mgmt-handovers" aria-label="最近交接">
                {items.map((item) => <li key={item.id} data-handover-id={item.id}>
                  <div className="im-wb-mgmt-handover-top">
                    <strong>{item.fromName || "未知"} → {item.toName || "未知"}</strong>
                    <Badge variant="outline">{handoverObjectLabel(item.objectType)}</Badge>
                    <time>{formatDateTime(item.createdAt)}</time>
                  </div>
                  <p className="im-wb-mgmt-handover-target">{item.display || item.objectId || "对象未提供"}</p>
                  {item.note ? <p className="im-wb-mgmt-handover-note">备注：{item.note}</p> : null}
                </li>)}
              </ul>}
    </CardContent>
  </Card>;
}

/* ------------------------------ 交接班与服务时效 ------------------------------ */

/** 图例色块：只用现有 --mgmt-chart-* 变量，不引新的视觉体系。 */
function ChartSwatch({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden="true" />{label}</span>;
}

/** 时效指标位：有事实才给数字；没有事实保留「—」，只挂缺口徽标。 */
function TimelinessMetric({ id, label, value, note, missing }: { id: string; label: string; value: string; note?: string; missing?: boolean }) {
  return <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2" data-sla-metric={id} data-missing={missing ? "true" : undefined}>
    <span className="flex flex-wrap items-center gap-2">
      <b className="text-lg font-semibold tabular-nums">{value}</b>
      {missing ? <Badge variant="outline">服务端未提供</Badge> : null}
    </span>
    <span className="text-xs text-muted-foreground">{label}</span>
    {note ? <span className="text-[11px] leading-relaxed text-muted-foreground">{note}</span> : null}
  </div>;
}

/**
 * 服务时效：首响/解决用服务端 quality 段；服务端没给就挂缺口。
 * 转交优先用服务端事件计数（全量），没有才退到交接记录，并把「最近 N 条」分母写在卡片上。
 */
function ServiceTimelinessCard({ overview, handovers, handoverState }: { overview: SupportOverview; handovers: SupportHandover[] | null; handoverState: LoadState }) {
  const stats = handovers ? handoverStatsToday(handovers) : null;
  const firstResponse = overview.quality?.firstResponse ?? null;
  const resolution = overview.quality?.resolution ?? null;
  const transfers = overview.totals.transfersToday;
  const handoversToday = overview.totals.handoversToday;

  const firstNote = !firstResponse
    ? "服务端尚未提供 quality.firstResponse"
    : firstResponse.sampleCount > 0
      ? `样本 ${firstResponse.sampleCount} · 超阈值 ${firstResponse.breached}${firstResponse.slaSeconds !== null ? `（阈值 ${firstResponse.slaSeconds} 秒）` : ""} · 未回 ${firstResponse.pending}（已超 ${firstResponse.overdue}）`
      : `今日暂无样本 · 未回 ${firstResponse.pending} 条${firstResponse.overdue > 0 ? `，其中已超阈值 ${firstResponse.overdue} 条` : ""}`;
  const resolutionNote = !resolution
    ? "服务端尚未提供 quality.resolution"
    : resolution.sampleCount > 0
      ? `样本 ${resolution.sampleCount}（缺接起或关闭事件的轮次不进分母）`
      : "今日无「已接起且已关闭」的样本";

  const transferNote = transfers !== null
    ? `服务端 TRANSFERRED 事件今日计数（全量）${handoversToday !== null ? ` · 交接记录 ${handoversToday} 件` : ""}`
    : stats
      ? `服务端未提供事件计数，退到交接记录：分母是最近 ${stats.scanned} 条交接记录内${stats.truncated ? `（已达单页上限 ${SUPPORT_HANDOVER_PAGE_LIMIT} 条，可能被截断）` : ""}，不是今日全量`
      : handoverState === "forbidden" ? "无权读取交接记录" : handoverState === "error" ? "交接记录读取失败，本次不给数字" : "交接记录读取中…";

  const gaps = SUPPORT_SLA_GAPS.filter((gap) => (gap.id === "first-response" ? !firstResponse : gap.id === "resolution" ? !resolution : true));

  return <Card className="im-wb-mgmt-card" data-panel="timeliness">
    <CardHeader><CardTitle>服务时效</CardTitle><CardDescription>只显示服务端已有事实；缺事实的指标保留「—」，不估算、不补 0</CardDescription></CardHeader>
    <CardContent className="im-wb-mgmt-card-content">
      <div className="grid gap-2 px-4 pb-3 sm:grid-cols-2 xl:grid-cols-4">
        <TimelinessMetric id="first-response" label="首响时长（首次人工回复 − 用户首条消息）" value={firstResponse && firstResponse.sampleCount > 0 ? formatSlaDuration(firstResponse.averageSeconds) : "—"} note={firstNote} missing={!firstResponse} />
        <TimelinessMetric id="resolution" label="解决时长（结束 − 接起）" value={resolution && resolution.sampleCount > 0 ? formatSlaDuration(resolution.averageSeconds) : "—"} note={resolutionNote} missing={!resolution} />
        <TimelinessMetric id="transfer" label="转交次数（今日）" value={transfers !== null ? String(transfers) : stats ? String(stats.consultation) : "—"} note={transferNote} />
        <TimelinessMetric id="support-cancel" label="客服取消数" value="—" missing note="服务端尚未提供取消事件与口径；不估算、不上占位字段" />
      </div>
      {firstResponse ? <p className="px-4 pb-3 text-[11px] leading-relaxed text-muted-foreground" data-sla-note="first-response">首响口径：用户首条消息 → 平台放行首条人工发送（不是 NIM 送达回执，重发不重复计）。</p> : null}
      {gaps.length ? <ul className="grid gap-2 px-4 pb-4 text-xs" aria-label="服务时效口径缺口">
        {gaps.map((gap) => <li key={gap.id} data-sla-gap={gap.id} className="rounded-md border border-dashed border-border px-3 py-2 leading-relaxed text-muted-foreground">
          <b className="text-foreground">{gap.label}</b>：{gap.missing}。需要：{gap.needed}。
        </li>)}
      </ul> : <p className="im-wb-mgmt-inline-state" role="status" data-sla-gaps="none">首响与解决时长已用服务端事实；客服取消数仍无口径，暂不显示。</p>}
    </CardContent>
  </Card>;
}

/** 交接班摘要：一段可直接粘贴给下一班的纯文本，数字全部来自本次看板读取。 */
function HandoverSummaryCard({ overview, handovers, handoverState }: { overview: SupportOverview; handovers: SupportHandover[] | null; handoverState: LoadState }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const text = useMemo(
    () => handoverSummaryText({
      totals: overview.totals,
      agents: overview.onDuty,
      handovers,
      ratings: overview.ratings,
      quality: overview.quality,
      queue: overview.queue,
    }),
    [overview, handovers],
  );
  const attention = useMemo(() => attentionSignals({ agents: overview.onDuty, totals: overview.totals, queue: overview.queue }), [overview]);
  const worst = attention.some((item) => item.level === "high") ? "warning" : attention.length ? "outline" : "success";
  const queue = overview.queue;
  const copy = async () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") { setCopyState("failed"); return; }
    try { await clipboard.writeText(text); setCopyState("copied"); } catch { setCopyState("failed"); }
  };
  return <Card className="im-wb-mgmt-card" data-panel="handover-summary" data-attention={attention.length}>
    <CardHeader>
      <CardTitle>交接班摘要</CardTitle>
      <CardDescription>值班、待接待、接待中与异常拼成一段；口径与分母随文附上</CardDescription>
    </CardHeader>
    <CardContent className="im-wb-mgmt-card-content">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Badge variant={worst}>{attention.length === 0 ? "无异常" : `${attention.length} 项需关注`}</Badge>
        <span className="text-xs text-muted-foreground">{handoverState === "ready" ? "含交接数" : "交接记录未就绪，摘要不含交接数"}</span>
        <Button variant="outline" size="sm" className="ml-auto" data-action="copy-handover-summary" onClick={() => void copy()}>{copyState === "copied" ? "已复制" : "复制摘要"}</Button>
      </div>
      {queue ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-[11px] text-muted-foreground" data-queue data-queue-reason={queue.reason}>
        <span>排队 {queue.queued} 条</span>
        {queue.oldestWaitSeconds !== null ? <span>最久 {formatSlaDuration(queue.oldestWaitSeconds)}</span> : null}
        <span>在岗 {queue.onDuty}</span>
        <span>可接单 {queue.withFreeSlot}</span>
        <span>满载 {queue.atCapacity}</span>
        {queue.capacityLimit !== null ? <span>上限 {queue.capacityLimit} 条/人</span> : null}
        <span>原因 {queueReasonLabel(queue.reason)}</span>
      </div> : null}
      {copyState === "failed" ? <p className="im-wb-mgmt-inline-state" role="alert" data-copy-state="failed">复制失败：浏览器未开放剪贴板权限，请手动全选摘要复制。</p> : null}
      <pre data-handover-summary className="m-0 overflow-x-auto whitespace-pre-wrap px-4 pb-4 text-xs leading-relaxed text-foreground">{text}</pre>
    </CardContent>
  </Card>;
}

/** 今日会话趋势：柱=每小时新咨询，线=今日累计；两个系列都来自同一份服务端 hourly。 */
function TodayTrendChart({ hourly }: { hourly: ReturnType<typeof hourlySlots> }) {
  const points = cumulativeSessions(hourly);
  const data = points.map((point) => ({ label: point.label, sessions: point.sessions, cumulative: point.cumulative }));
  const last = points[points.length - 1];
  const total = last ? last.cumulative : 0;
  return <Card className="im-wb-mgmt-card" data-chart="today-trend" data-points={points.filter((point) => point.sessions > 0).length}>
    <CardHeader><CardTitle>今日会话趋势</CardTitle><CardDescription>柱：每小时新咨询 · 线：今日累计；今日共 {total} 次</CardDescription></CardHeader>
    <CardContent>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <ChartSwatch color="var(--mgmt-chart-1)" label="每小时新咨询" />
        <ChartSwatch color="var(--mgmt-chart-2)" label="今日累计" />
        <span className="ml-auto tabular-nums">累计 {total} 次</span>
      </div>
      {hasHourlyData(points) ? <div className="im-wb-mgmt-chartbox" role="img" aria-label="今日每小时新咨询与累计会话">
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="18%">
            <defs><linearGradient id="mgmt-today-bars" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.35} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" interval={2} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} labelFormatter={(label) => `${label}:00`} formatter={(value, name) => [`${value}`, name === "cumulative" ? "累计" : "新咨询"]} />
            <Bar dataKey="sessions" name="sessions" fill="url(#mgmt-today-bars)" radius={[4, 4, 0, 0]} maxBarSize={16} />
            <Line type="monotone" dataKey="cumulative" name="cumulative" stroke="var(--mgmt-chart-2)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无数据</p>}
    </CardContent>
  </Card>;
}

/** 评分分布：5→1 星计数；count 为 0 时只说今日暂无评价，不画 0 分柱。 */
function RatingDistributionChart({ ratings }: { ratings: SupportRatings }) {
  const data = ratingBuckets(ratings).map((bucket) => ({ label: `${bucket.score} 星`, score: bucket.score, count: bucket.count }));
  const total = data.reduce((sum, point) => sum + point.count, 0);
  return <Card className="im-wb-mgmt-card" data-chart="rating-distribution" data-count={ratings.count}>
    <CardHeader><CardTitle>今日评分分布</CardTitle><CardDescription>{ratings.count > 0 ? `${ratings.count} 条评价 · 平均 ${formatRatingAverage(ratings.average)}` : "仅统计已提交评价"}</CardDescription></CardHeader>
    <CardContent>
      {total > 0 ? <div className="overflow-x-auto"><div className="im-wb-mgmt-chartbox min-w-[560px]" role="img" aria-label={`今日评分分布：${data.map((point) => `${point.label} ${point.count} 条`).join("、")}`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="24%">
            <defs><linearGradient id="mgmt-rating" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.35} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} formatter={(value) => [`${value}`, "评价数"]} />
            <Bar dataKey="count" name="count" fill="url(#mgmt-rating)" radius={[5, 5, 0, 0]} maxBarSize={26} />
          </BarChart>
        </ResponsiveContainer>
      </div></div> : <p className="im-wb-mgmt-chart-empty" role="status">今日暂无评价</p>}
    </CardContent>
  </Card>;
}

/** 按客服对比：今日会话与当前接待并排；关注线只是本页口径，不冒充服务端容量。 */
function AgentCompareChart({ agents }: { agents: SupportOverviewAgent[] }) {
  const data = agents.map((agent) => ({ name: agent.name, sessions: agent.todaySessions, load: agent.activeLoad }));
  const hasData = data.some((point) => point.sessions > 0 || point.load > 0);
  return <Card className="im-wb-mgmt-card" data-chart="agent-compare" data-points={data.length}>
    <CardHeader><CardTitle>按客服对比</CardTitle><CardDescription>今日会话数与当前接待数并排；关注线 {SUPPORT_ATTENTION_LOAD_LINE} 条为本页口径</CardDescription></CardHeader>
    <CardContent>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <ChartSwatch color="var(--mgmt-chart-1)" label="今日会话" />
        <ChartSwatch color="var(--mgmt-chart-2)" label="当前接待" />
      </div>
      {hasData ? <div className="im-wb-mgmt-chartbox" role="img" aria-label="按客服对比今日会话与当前接待">
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 52)}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barGap={2}>
            <defs>
              <linearGradient id="mgmt-compare-sessions" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.95} /></linearGradient>
              <linearGradient id="mgmt-compare-load" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.95} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={6} />
            <YAxis type="category" dataKey="name" width={64} tick={{ fill: "var(--foreground)", fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value, name) => [`${value}`, name === "sessions" ? "今日会话" : "当前接待"]} />
            <Bar dataKey="sessions" name="sessions" fill="url(#mgmt-compare-sessions)" radius={[0, 4, 4, 0]} maxBarSize={14} />
            <Bar dataKey="load" name="load" fill="url(#mgmt-compare-load)" radius={[0, 4, 4, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无数据</p>}
    </CardContent>
  </Card>;
}

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

export function SupportPatrol({ active, request, canTakeover, currentAdminUserId, currentAdminName, onOpenConsultation }: {
  active: boolean;
  request: SupportManagementRequest;
  canTakeover: boolean;
  currentAdminUserId: string;
  currentAdminName: string;
  onOpenConsultation?: () => void;
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
  const [reloadToken, setReloadToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<NimMessageLike[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [messageState, setMessageState] = useState<"idle" | LoadState>("idle");
  const [messageError, setMessageError] = useState("");
  const [messageReloadToken, setMessageReloadToken] = useState(0);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setListState((current) => (current === "ready" ? "ready" : "loading"));
    setListError("");
    void request<unknown>(auditConversationsPath({ type, adminUserId: adminId === "all" ? undefined : adminId }))
      .then((value) => {
        if (cancelled) return;
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
        if (cancelled) return;
        setListState(statusOf(error) === 403 ? "forbidden" : "error");
        setListError(friendlyError(error));
      });
    return () => { cancelled = true; };
  }, [active, type, adminId, request, reloadToken]);

  useEffect(() => {
    if (!active || !selected) {
      setMessages([]);
      setMessageCursor(null);
      setMessageState("idle");
      return;
    }
    let cancelled = false;
    setMessages([]);
    setMessageCursor(null);
    setMessageError("");
    if (!selected.conversationId) { setMessageState("ready"); return; }
    setMessageState("loading");
    void request<unknown>(auditMessagesPath(selected.conversationId))
      .then((value) => {
        if (cancelled) return;
        const page = parseAuditMessages(value);
        setMessages(page.messages);
        setMessageCursor(page.nextCursor);
        setMessageState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessageState(statusOf(error) === 403 ? "forbidden" : "error");
        setMessageError(friendlyError(error));
      });
    return () => { cancelled = true; };
  }, [active, selected?.id, selected?.conversationId, request, messageReloadToken]);

  useEffect(() => { setNotice(null); }, [selected?.id]);

  const adminOptions = useMemo<[string, string][]>(
    () => [["all", "全部客服"], ...adminChoices.map((choice) => [choice.id, choice.name] as [string, string])],
    [adminChoices],
  );

  const visibleItems = useMemo(() => items.filter((item) =>
    (adminId === "all" || item.adminUserId === adminId)
    && (stateFilter === "ALL" || item.state === stateFilter)
    && withinTimeFilter(item.lastMessageAt, timeFilter)), [items, adminId, stateFilter, timeFilter]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = parseAuditConversations(await request(auditConversationsPath({ type, cursor: nextCursor })));
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setListError(friendlyError(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const loadEarlier = async () => {
    if (!selected?.conversationId || !messageCursor || readingEarlier) return;
    setReadingEarlier(true);
    try {
      const page = parseAuditMessages(await request(auditMessagesPath(selected.conversationId, messageCursor)));
      setMessages((current) => [...page.messages, ...current]);
      setMessageCursor(page.nextCursor);
    } catch (error) {
      setMessageError(friendlyError(error));
    } finally {
      setReadingEarlier(false);
    }
  };

  const takeover = async () => {
    if (!selected || selected.type === "ORDER" || !canTakeover || takeoverBusy) return;
    const consultationId = selected.id;
    setTakeoverBusy(true);
    setNotice(null);
    try {
      await request(`/im/audit/consultations/${encodeURIComponent(consultationId)}/takeover`, {}, "POST");
      if (selectedIdRef.current === consultationId) setNotice({ tone: "success", text: "已接管，会话归属已更新" });
      setItems((current) => current.map((item) => (item.id === consultationId ? { ...item, adminUserId: currentAdminUserId, adminName: currentAdminName || item.adminName } : item)));
      setReloadToken((token) => token + 1);
    } catch (error) {
      if (selectedIdRef.current === consultationId) setNotice({ tone: "error", text: friendlyError(error) });
    } finally {
      setTakeoverBusy(false);
    }
  };

  const changeType = (next: string) => {
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setListState("loading");
    setType(next);
  };
  const changeAdmin = (next: string) => {
    if (next === adminId) return;
    setItems([]);
    setNextCursor(null);
    setSelectedId(null);
    setListState("loading");
    setAdminId(next);
  };

  return <div className="im-wb-mgmt-patrol" data-patrol data-state={listState}>
    <aside className="im-wb-mgmt-patrol-list" aria-label="巡视会话列表">
      <div className="im-wb-queue-head"><strong>会话巡视</strong><b>{visibleItems.length}</b><Button variant="ghost" size="icon-sm" className="im-wb-mgmt-refresh" aria-label="刷新巡视列表" onClick={() => setReloadToken((token) => token + 1)}><RefreshCw /></Button></div>
      <div className="im-wb-mgmt-filters">
        <FilterSelect label="按类型筛选" value={type} options={TYPE_OPTIONS} onChange={changeType} />
        <FilterSelect label="按客服筛选" value={adminId} options={adminOptions} onChange={changeAdmin} />
        <FilterSelect label="按状态筛选" value={stateFilter} options={STATE_OPTIONS} onChange={setStateFilter} />
        <FilterSelect label="按时间筛选" value={timeFilter} options={TIME_OPTIONS} onChange={(next) => setTimeFilter(next === "today" || next === "7d" ? next : "all")} />
      </div>
      <p className="im-wb-filter-note">类型、客服由服务端筛选；状态、时间按当前已加载列表筛选。</p>
      <div className="im-wb-rows">
        {listState === "loading" && !items.length ? <div className="im-wb-list-empty"><strong>正在读取会话…</strong></div> : null}
        {listState === "forbidden" ? <div className="im-wb-list-empty"><ShieldCheck size={20} aria-hidden="true" /><strong>无权查看会话巡视</strong><span>需要「客服管理读取」权限。</span></div> : null}
        {listState === "error" ? <div className="im-wb-list-empty"><CircleAlert size={20} aria-hidden="true" /><strong>会话列表读取失败</strong><span>{listError}</span><Button variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>重新读取</Button></div> : null}
        {visibleItems.map((item) => <button type="button" key={item.id} className="im-wb-row" data-active={selectedId === item.id} aria-current={selectedId === item.id ? "page" : undefined}
          onClick={() => { setSelectedId(item.id); setNotice(null); }}>
          <span className="im-wb-row-av" aria-hidden="true">{initialOf(item.title)}</span>
          <span className="im-wb-row-copy">
            <span className="im-wb-row-top"><b>{item.title}</b><i className="im-wb-tag" data-tone={item.type === "COMPLAINT" ? "warn" : "neutral"}>{auditTypeLabel(item.type)}</i><time>{item.lastMessageAt ? formatTime(item.lastMessageAt) : "—"}</time></span>
            <span className="im-wb-row-snip">{item.type === "ORDER" ? `订单 ${item.displayNo ?? "编号未提供"}${item.gameName ? ` · ${item.gameName}` : ""}` : `${item.userName || "用户未提供"} · 客服 ${item.adminName}`}</span>
            <span className="im-wb-row-foot"><em data-state={auditStateLabel(item.state)}>{auditStateLabel(item.state)}</em></span>
          </span>
        </button>)}
        {listState === "ready" && !items.length ? <div className="im-wb-list-empty"><strong>暂无可巡视会话</strong><span>当前筛选条件下服务端没有返回会话。</span></div> : null}
        {listState === "ready" && items.length > 0 && !visibleItems.length ? <div className="im-wb-list-empty"><strong>当前筛选没有匹配会话</strong><span>调整客服、状态或时间筛选。</span></div> : null}
      </div>
      {nextCursor ? <button type="button" className="im-wb-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在读取…" : "更多会话"}</button> : null}
    </aside>

    <section className="im-wb-chat im-wb-mgmt-chat" aria-label="只读会话">
      {!selected ? <div className="im-wb-mgmt-chat-empty"><Headphones size={22} aria-hidden="true" /><strong>选择一条会话巡视</strong><span>打开即只读查看，不填写原因，也不发送消息。</span></div> : <>
        <header className="im-wb-chat-head">
          <span className="im-wb-chat-av" aria-hidden="true">{initialOf(selected.title)}</span>
          <div className="im-wb-chat-title">
            <h2>{selected.title}</h2>
            <span>{auditTypeLabel(selected.type)} · {auditStateLabel(selected.state)} · 当前接待：{selected.adminName}</span>
          </div>
          <div className="im-wb-chat-actions">
            <Badge variant="outline">只读巡视</Badge>
            {selected.type === "ORDER"
              ? <Button variant="outline" size="sm" disabled>订单群接管后续开放</Button>
              : <Button variant="outline" size="sm" data-action="audit-takeover" disabled={!canTakeover || takeoverBusy || selected.adminUserId === currentAdminUserId}
                onClick={() => void takeover()}>{selected.adminUserId === currentAdminUserId ? "由你接待" : takeoverBusy ? "正在接管…" : canTakeover ? "接管" : "无接管权限"}</Button>}
          </div>
        </header>
        {notice ? <p className="im-wb-notice" data-tone={notice.tone === "error" ? "warn" : undefined} role={notice.tone === "error" ? "alert" : "status"}>
          <CircleAlert size={14} aria-hidden="true" />{notice.text}
          {notice.tone === "success" && onOpenConsultation ? <Button variant="link" size="sm" data-action="open-consultations" onClick={onOpenConsultation}>前往「咨询与投诉」</Button> : null}
        </p> : null}
        {messageError && messageState === "error" && messages.length ? <p className="im-wb-notice" data-tone="warn" role="alert"><CircleAlert size={14} aria-hidden="true" />{messageError}</p> : null}
        <div className="im-wb-stream-wrap">
          <div className="im-wb-viewport im-wb-mgmt-viewport" aria-label="只读会话消息">
            {messageState === "loading" ? <div className="im-wb-empty" role="status"><strong>正在读取消息…</strong></div>
              : messageState === "forbidden" ? <div className="im-wb-empty"><ShieldCheck size={22} aria-hidden="true" /><strong>无权查看该会话消息</strong></div>
                : messageState === "error" ? <div className="im-wb-empty"><CircleAlert size={22} aria-hidden="true" /><strong>消息读取失败</strong><span>{messageError}</span><Button variant="outline" size="sm" onClick={() => setMessageReloadToken((token) => token + 1)}>重新读取</Button></div>
                  : !messages.length ? <div className="im-wb-empty"><Headphones size={22} aria-hidden="true" /><strong>{selected.conversationId ? "该会话暂无可读消息" : "消息通道未就绪，无法读取历史"}</strong></div>
                    : <div className="im-wb-content">
                      {messageCursor ? <div className="im-wb-history-more"><button type="button" disabled={readingEarlier} onClick={() => void loadEarlier()}>{readingEarlier ? "正在读取更早消息…" : "更早的消息"}</button></div> : null}
                      <AuditTimeline messages={messages} conversation={selected} />
                    </div>}
          </div>
        </div>
        <div className="im-wb-composer im-wb-composer-readonly" role="status"><ShieldCheck size={14} aria-hidden="true" />只读巡视，不发送消息；需要发言时点「接管」后到客服工作台处理。</div>
      </>}
    </section>
  </div>;
}

function imageOf(message: NimMessageLike): { url: string | null; name: string } | null {
  if (message.messageType !== 1 || !message.attachment || typeof message.attachment !== "object") return null;
  const attachment = message.attachment as { url?: unknown; thumbUrl?: unknown; name?: unknown };
  return {
    url: supportedImageUrl(attachment.url) ?? supportedImageUrl(attachment.thumbUrl),
    name: typeof attachment.name === "string" ? attachment.name : "会话图片",
  };
}

function AuditTimeline({ messages, conversation }: { messages: NimMessageLike[]; conversation: AuditConversation }) {
  let timelineDay = "";
  const nodes: ReactNode[] = [];
  messages.forEach((message, index) => {
    const dayKey = dayKeyOf(message.createTime);
    if (dayKey && dayKey !== timelineDay) {
      timelineDay = dayKey;
      nodes.push(<Marker key={`day-${dayKey}`} className="im-wb-day" role="separator"><MarkerContent>{dayLabelOf(dayKey)}</MarkerContent></Marker>);
    }
    const notice = decodeImSystemNotice(message);
    if (notice) {
      nodes.push(<Marker key={message.messageClientId} className="im-wb-sys" variant="separator"><MarkerContent>{notice.text}</MarkerContent></Marker>);
      return;
    }
    const previous = messages[index - 1];
    const grouped = Boolean(previous && !decodeImSystemNotice(previous) && previous.senderId === message.senderId && message.createTime - previous.createTime < GROUP_WINDOW_MS);
    const staff = conversation.adminUserId !== null && message.senderId === conversation.adminUserId;
    const name = staff ? conversation.adminName || "客服" : message.senderId;
    const image = imageOf(message);
    const card = message.card;
    const text = message.revoked ? "消息已撤回"
      : card ? `订单卡片 · ${CARD_LABELS[card.kind] ?? "订单动态"}`
        : typeof message.text === "string" && message.text.trim() ? message.text
          : image ? "" : message.messageType === 0 ? "" : "暂不支持展示的消息类型";
    nodes.push(<Message key={message.messageClientId} align={staff ? "end" : "start"} className="im-wb-msg" data-self={staff} data-grouped={grouped} data-message-id={message.messageClientId}>
      <MessageAvatar className="im-wb-av" aria-hidden="true">{initialOf(name)}</MessageAvatar>
      <MessageContent className="im-wb-msg-body" data-card={card ? "true" : undefined}>
        {grouped ? null : <MessageHeader className="im-wb-msg-meta"><b>{name}</b>{staff ? <span className="im-wb-role-tag" data-role="平台客服">平台客服</span> : null}<time>{formatTime(message.createTime)}</time></MessageHeader>}
        <Bubble align={staff ? "end" : "start"} variant={staff ? "default" : "secondary"}>
          <BubbleContent className="im-wb-bub" data-revoked={message.revoked ? "true" : undefined}>
            {card ? <span className="im-wb-mgmt-card-msg">{text}<small>完整卡片请在「订单沟通」查看</small></span>
              : image ? (image.url ? <img className="im-wb-mgmt-inline-image" src={image.url} alt={image.name} loading="lazy" /> : <span className="im-wb-thumb-missing">图片暂不可预览</span>)
                : text}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>);
  });
  return <>{nodes}</>;
}

/* ------------------------------ 入口 ------------------------------ */

export function SupportManagementPane({ active, request, canTakeover, currentAdminUserId, currentAdminName, onOpenConsultation, demo = false }: {
  active: boolean;
  request: SupportManagementRequest;
  canTakeover: boolean;
  currentAdminUserId: string;
  currentAdminName: string;
  onOpenConsultation?: () => void;
  demo?: boolean;
}) {
  const [page, setPage] = useState<"dashboard" | "patrol">("dashboard");
  return <div className="im-wb-mgmt" data-page={page}>
    <Tabs value={page} onValueChange={(value) => setPage(value === "patrol" ? "patrol" : "dashboard")} className="im-wb-mgmt-tabs">
      <div className="im-wb-mgmt-head"><TabsList aria-label="客服管理子页"><TabsTrigger value="dashboard">看板</TabsTrigger><TabsTrigger value="patrol">巡视</TabsTrigger></TabsList>{demo ? <Badge variant="outline">本地演示数据</Badge> : null}</div>
      <TabsContent value="dashboard" className="im-wb-mgmt-content im-wb-mgmt-content--scroll"><SupportDashboard active={active && page === "dashboard"} request={request} /></TabsContent>
      <TabsContent value="patrol" className="im-wb-mgmt-content im-wb-mgmt-content--fill"><SupportPatrol active={active && page === "patrol"} request={request} canTakeover={canTakeover} currentAdminUserId={currentAdminUserId} currentAdminName={currentAdminName} onOpenConsultation={onOpenConsultation} /></TabsContent>
    </Tabs>
  </div>;
}
