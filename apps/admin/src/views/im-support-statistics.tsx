"use client";

/**
 * 客服统计：复用现有卡片、表格与 Recharts，保留服务端统计语义。
 *
 * - 只看服务端已给出的数字；缺失/空/403/失败都保持真实状态，不造数据、不补时间。
 * - 图表用 recharts 绘制，配色只取 --mgmt-chart-*；无可画数据时显示“暂无数据”。
 * - 区间选择只把用户明确选择的日期发给服务端；默认“今日”不发送浏览器日期。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { AdminApiError, friendlyError } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TooltipProvider } from "../components/ui/tooltip";
import { formatDateTime } from "./im-support-format";
import {
  availabilityLabel, formatDayLabel, formatDuration, formatRatingAverage,
  formatSlaDuration, hasHourlyData, hasTrendData, hasWorkloadData, hourlySlots,
  parseSupportOverview,
  type SupportOverview, type SupportOverviewAgent, type SupportReportPeriod, type SupportRatings, type SupportTrendPoint,
} from "./im-support-management-model";
import {
  SupportInfoHint, SupportReportRangePicker, anchorDateOf, periodRange, rangeLabel, rangeScopeWord,
  resolveSupportRange, type SupportRangeSelection, type SupportReportRange,
} from "./im-support-report-range";

const DASHBOARD_REFRESH_MS = 20_000;

import type { SupportManagementRequest } from "./im-support-management";

type LoadState = "loading" | "ready" | "forbidden" | "error";
function statusOf(error: unknown): number | undefined { return error instanceof AdminApiError ? error.status : (error as {status?:number})?.status; }

export function SupportDashboard({ active, request, demo = false }: { active: boolean; request: SupportManagementRequest; demo?: boolean }) {
  const [overview, setOverview] = useState<SupportOverview | null>(null);
  const [overviewState, setOverviewState] = useState<LoadState>("loading");
  const [overviewError, setOverviewError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<SupportRangeSelection>({ preset: "today", range: null });
  const [anchorDate, setAnchorDate] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  const anchorRef = useRef<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const requestRef = useRef(request);
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (requestRef.current === request) return;
    requestRef.current = request;
    loadedKeyRef.current = null;
    setOverview(null);
  }, [request]);

  const load = useCallback(async (background = false) => {
    if (background && inFlightRef.current) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const resolved = resolveSupportRange(selectionRef.current, anchorRef.current);
    if (resolved.error) {
      inFlightRef.current = false;
      setOverview(null);
      setOverviewState("error");
      setOverviewError(resolved.error);
      setRefreshing(false);
      return;
    }
    inFlightRef.current = true;
    const path = `/im/support-overview${resolved.query}`;
    if (loadedKeyRef.current !== path) {
      setOverview(null);
      setOverviewState("loading");
    }
    setRefreshing(true);
    try {
      const response = await request<unknown>(path);
      if (generation !== generationRef.current) return;
      const parsed = parseSupportOverview(response);
      const explicit = selectionRef.current.preset !== "today";
      if (explicit) {
        if (!parsed.period) throw new Error("服务端未返回所选区间，不能把结果当作该范围统计。");
        if (resolved.range && (parsed.period.dateFrom !== resolved.range.dateFrom || parsed.period.dateTo !== resolved.range.dateTo)) {
          throw new Error("服务端返回区间与所选区间不一致。");
        }
      }
      const serverAnchor = anchorDateOf(parsed.serverNow);
      if (serverAnchor) {
        anchorRef.current = serverAnchor;
        setAnchorDate(serverAnchor);
      }
      if (parsed.period) {
        const next = { ...selectionRef.current, range: periodRange(parsed.period) };
        selectionRef.current = next;
        setSelection(next);
      }
      loadedKeyRef.current = path;
      setOverview(parsed);
      setOverviewState("ready");
      setOverviewError("");
    } catch (reason) {
      if (generation !== generationRef.current) return;
      const status = statusOf(reason);
      if (status !== undefined && [401, 403, 423].includes(status)) {
        loadedKeyRef.current = null;
        setOverview(null);
      }
      const explicit = selectionRef.current.preset !== "today";
      const unsupported = explicit && (status === 400 || status === 404 || status === 405);
      const message = unsupported
        ? "当前服务端尚未支持所选时间范围；未退回今天，请刷新或联系维护者。"
        : reason instanceof AdminApiError
          ? friendlyError(reason)
          : reason instanceof Error
            ? reason.message
            : "客服统计数据不完整，请刷新后重试。";
      setOverviewState(status === 403 ? "forbidden" : "error");
      setOverviewError(message);
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current = false;
        setRefreshing(false);
      }
    }
  }, [request]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load(true);
    }, DASHBOARD_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      generationRef.current += 1;
      inFlightRef.current = false;
    };
  }, [active, load]);

  const applySelection = (next: SupportRangeSelection) => {
    selectionRef.current = next;
    setSelection(next);
    void load();
  };

  if (overviewState === "forbidden") {
    return <div className="im-wb-mgmt-state" data-state="forbidden" role="status"><ShieldCheck size={22} aria-hidden="true" /><strong>无权查看客服管理数据</strong><span>需要「客服管理读取」权限；Boss 默认可用。</span></div>;
  }

  const displayRange: SupportReportRange | null = overview
    ? overview.period
      ? periodRange(overview.period)
      : { dateFrom: overview.reportDate, dateTo: overview.reportDate }
    : selection.range;
  const headerRangeLabel = displayRange
    ? rangeLabel(displayRange, anchorDate)
    : selection.preset === "today" ? "今日" : rangeLabel(selection.range, anchorDate);
  const scopeWord = rangeScopeWord(displayRange, anchorDate);
  const headerNote = overview
    ? `${headerRangeLabel} · 更新于 ${formatDateTime(overview.serverNow)}${refreshing ? " · 刷新中…" : ""}`
    : `${headerRangeLabel} · ${overviewState === "loading" ? "正在读取" : "读取失败"}`;

  return <TooltipProvider>
    <div className="im-wb-mgmt-dashboard" data-page="support-overview" data-state={overviewState} data-period-from={displayRange?.dateFrom} data-period-to={displayRange?.dateTo}>
      <header className="im-wb-mgmt-toolbar">
        <div className="im-wb-mgmt-heading">
          <div className="flex items-center gap-2">
            <h1>客服统计</h1>
            <SupportInfoHint label="客服统计口径">按北京时间统计，包含起止日期；咨询和用户在区间内去重。当前可接待客服和排队数不受日期筛选影响。</SupportInfoHint>
            {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
          </div>
          <span className="im-wb-mgmt-toolbar-note">{headerNote}</span>
        </div>
        <div className="im-support-toolbar-actions">
          <SupportReportRangePicker value={selection} displayRange={displayRange} anchorDate={anchorDate} disabled={!anchorDate && !displayRange} onChange={applySelection} />
          <Button variant="outline" size="sm" data-action="refresh-dashboard" onClick={() => void load()} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新"}</Button>
        </div>
      </header>

      {overviewState === "error" && overview ? (
        <div className="im-wb-notice" data-tone="warn" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>刷新失败，以下仍是上次结果：{overviewError}</span>
          <Button variant="link" size="sm" onClick={() => void load()}>重新刷新</Button>
        </div>
      ) : null}

      {!overview && overviewState === "loading" ? <div className="im-wb-mgmt-state" role="status">正在读取所选时间范围…</div> : null}
      {!overview && overviewState === "error" ? (
        <div className="im-wb-mgmt-state" data-state="error" role="alert">
          <CircleAlert size={22} aria-hidden="true" />
          <strong>客服数据读取失败</strong>
          <span>{overviewError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>重新读取</Button>
        </div>
      ) : null}

      {overview ? <>
        <div className="im-wb-mgmt-totals" aria-label="统计概况">
          <MetricCard label="当前可接待客服" value={overview.totals.onDutyCount} hint="已开始接待、连接正常，且最近 2 分钟有响应的客服。" />
          <MetricCard label="当前排队咨询" value={overview.totals.waitingConsultations} hint="当前未分配且用户已留言的等待咨询；实时事实，不是所选期间的历史排队。" />
          <MetricCard label={`${scopeWord}接待咨询`} value={overview.totals.todaySessions} hint="期间发生分配、接入、转交或结束的咨询，同一咨询只计一次。" />
          <MetricCard label={`${scopeWord}接待用户`} value={overview.totals.todayUsers} hint="所选期间去重用户；同一用户跨天只计 1 人。" />
        </div>

        <div className="im-wb-mgmt-summary-grid">
          <ServiceTimelinessCard overview={overview} scopeWord={scopeWord} demo={demo} />
          <RatingCard ratings={overview.ratings} scopeWord={scopeWord} demo={demo} />
        </div>

        <div className="im-wb-mgmt-charts">
          <TrendChart points={overview.trend} period={overview.period} demo={demo} />
          <HourlyChart hourly={overview.hourly} scopeWord={scopeWord} demo={demo} />
          {hasWorkloadData(overview.onDuty) ? <AgentWorkloadChart agents={overview.onDuty} scopeWord={scopeWord} demo={demo} /> : null}
        </div>

        <Card className="im-wb-mgmt-card" data-panel="on-duty">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-1.5">客服接待明细 <SupportInfoHint label="客服接待明细口径">当前状态、当前负载与负责订单群为刷新时事实；接待时长、会话、用户为所选期间。</SupportInfoHint></CardTitle>
              {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
            </div>
          </CardHeader>
          <CardContent className="im-wb-mgmt-card-content">
            <div className="im-wb-mgmt-table-wrap im-wb-mgmt-table-wrap--on-duty"><Table className="im-wb-mgmt-table">
              <TableHeader><TableRow>
                <TableHead>客服</TableHead><TableHead>状态</TableHead><TableHead className="text-right">当前接待</TableHead>
                <TableHead className="text-right">{scopeWord}接待时长</TableHead><TableHead className="text-right">{scopeWord}会话</TableHead>
                <TableHead className="text-right">{scopeWord}用户</TableHead><TableHead className="text-right">负责订单群</TableHead>
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
                </TableRow>) : <TableRow><TableCell colSpan={7} className="im-wb-mgmt-empty-cell">暂无客服记录</TableCell></TableRow>}
              </TableBody>
            </Table></div>
            <div className="im-wb-mgmt-agent-cards">
              {overview.onDuty.length ? overview.onDuty.map((agent) => <article key={agent.adminUserId || agent.name} className="im-wb-mgmt-agent-card" data-agent-card={agent.adminUserId}>
                <div className="im-wb-mgmt-agent-card-head">
                  <strong>{agent.name}</strong>
                  <Badge variant={agent.availability === "AVAILABLE" ? "success" : agent.availability === "PAUSED" ? "warning" : "unknown"}>{availabilityLabel(agent)}</Badge>
                </div>
                <dl>
                  <div><dt>当前接待</dt><dd>{agent.activeLoad}</dd></div>
                  <div><dt>{scopeWord}接待时长</dt><dd>{formatDuration(agent.todaySeconds)}</dd></div>
                  <div><dt>{scopeWord}会话</dt><dd>{agent.todaySessions}</dd></div>
                  <div><dt>{scopeWord}用户</dt><dd>{agent.todayUsers}</dd></div>
                  <div><dt>负责订单群</dt><dd>{agent.currentOrderGroups}</dd></div>
                </dl>
              </article>) : <p className="im-wb-mgmt-inline-state">暂无客服记录</p>}
            </div>
          </CardContent>
        </Card>
      </> : null}
    </div>
  </TooltipProvider>;
}

function MetricCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return <Card size="sm" className="im-wb-mgmt-metric"><CardContent>
    <span className="im-wb-mgmt-metric-value">{value}</span>
    <span className="im-wb-mgmt-metric-label">{label}{hint ? <SupportInfoHint label={`${label}口径`}>{hint}</SupportInfoHint> : null}</span>
  </CardContent></Card>;
}

function RatingCard({ ratings, scopeWord, demo = false }: { ratings: SupportRatings; scopeWord: string; demo?: boolean }) {
  const emptyLabel = scopeWord === "今日" ? "今日暂无评价" : "所选期间暂无评价";
  return <Card className="im-wb-mgmt-card" data-panel="ratings" data-count={ratings.count}>
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-1.5">{scopeWord}评价 <SupportInfoHint label="评价口径">仅统计所选期间提交的评价。</SupportInfoHint></CardTitle>
        {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
      </div>
    </CardHeader>
    <CardContent className="im-wb-mgmt-card-content">
      {ratings.count === 0
        ? <p className="im-wb-mgmt-inline-state" role="status" data-rating-empty>{emptyLabel}</p>
        : <>
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 px-4 pb-3">
            <span className="flex items-baseline gap-2" data-rating-metric="count">
              <b className="text-2xl font-semibold tabular-nums">{ratings.count}</b>
              <span className="text-xs text-muted-foreground">评价数</span>
            </span>
            <span className="flex items-baseline gap-2" data-rating-metric="average">
              <b className="text-2xl font-semibold tabular-nums">{formatRatingAverage(ratings.average)}</b>
              <span className="text-xs text-muted-foreground">平均分</span>
            </span>
          </div>
          <p className="im-wb-mgmt-rating-caption">评分分布（1 星 → 5 星）</p>
          <SupportRatingBars distribution={ratings.distribution} count={ratings.count} emptyLabel={emptyLabel} />
          <details className="im-wb-rating-agents"><summary>查看各客服评价</summary><div className="im-wb-mgmt-table-wrap"><Table className="im-wb-mgmt-table">
            <TableHeader><TableRow><TableHead>客服</TableHead><TableHead className="text-right">评价数</TableHead><TableHead className="text-right">平均分</TableHead></TableRow></TableHeader>
            <TableBody>
              {ratings.agents.length ? ratings.agents.map((agent) => <TableRow key={agent.adminUserId} data-rating-agent={agent.adminUserId}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell className="text-right tabular-nums">{agent.count}</TableCell>
                <TableCell className="text-right tabular-nums">{formatRatingAverage(agent.average)}</TableCell>
              </TableRow>) : <TableRow><TableCell colSpan={3} className="im-wb-mgmt-empty-cell">暂无按客服统计</TableCell></TableRow>}
            </TableBody>
          </Table></div></details>
        </>}
    </CardContent>
  </Card>;
}

function trendBounds(points: SupportTrendPoint[], period: SupportReportPeriod | null): { from: string | null; to: string | null } {
  return {
    from: period?.trendFrom ?? points[0]?.date ?? null,
    to: period?.trendTo ?? points[points.length - 1]?.date ?? null,
  };
}

function TrendChart({ points, period, demo = false }: { points: SupportTrendPoint[]; period: SupportReportPeriod | null; demo?: boolean }) {
  const bounds = trendBounds(points, period);
  const long = points.length > 21;
  const firstDate = points.at(0)?.date;
  const lastDate = points.at(-1)?.date;
  const crossesYear = !!firstDate && !!lastDate && firstDate.slice(0, 4) !== lastDate.slice(0, 4);
  const data = points;
  const label = bounds.from && bounds.to ? `${bounds.from} 至 ${bounds.to}，每日接待轮次与用户` : "所选趋势区间每日接待轮次与用户";
  return <Card className="im-wb-mgmt-card" data-chart="trend" data-kind={long ? "line" : "bar"} data-points={data.length}>
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-1.5">接待趋势 <SupportInfoHint label="接待趋势口径">同一咨询或用户可能出现在多天，区间总数见上方汇总。</SupportInfoHint></CardTitle>
        {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
      </div>
      <div className="text-sm text-muted-foreground">{bounds.from && bounds.to ? `${bounds.from} 至 ${bounds.to}` : "所选趋势区间"}</div>
    </CardHeader>
    <CardContent>
      <div className="im-wb-mgmt-legend"><span data-series="sessions">会话</span><span data-series="users">用户</span></div>
      {hasTrendData(points) ? <div className="im-wb-mgmt-chartbox" role="img" tabIndex={0} aria-label={`接待趋势：${label}`}>
        <ResponsiveContainer width="100%" height={220}>
          {long ? <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={(date) => crossesYear ? String(date).slice(0, 7) : formatDayLabel(String(date))} interval="preserveStartEnd" minTickGap={32} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <ChartTooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ stroke: "var(--border)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} formatter={(value, name) => [`${value}`, name === "sessions" ? "会话" : "用户"]} />
            <Line type="monotone" dataKey="sessions" stroke="var(--mgmt-chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
            <Line type="monotone" dataKey="users" stroke="var(--mgmt-chart-2)" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          </LineChart> : <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="26%">
            <defs>
              <linearGradient id="mgmt-trend-sessions" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.38} /></linearGradient>
              <linearGradient id="mgmt-trend-users" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-2)" stopOpacity={0.38} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={(date) => crossesYear ? String(date).slice(0, 7) : formatDayLabel(String(date))} interval="preserveStartEnd" minTickGap={20} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <ChartTooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} formatter={(value, name) => [`${value}`, name === "sessions" ? "会话" : "用户"]} />
            <Bar dataKey="sessions" fill="url(#mgmt-trend-sessions)" radius={[5, 5, 0, 0]} maxBarSize={26} />
            <Bar dataKey="users" fill="url(#mgmt-trend-users)" radius={[5, 5, 0, 0]} maxBarSize={26} />
          </BarChart>}
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无趋势数据</p>}
    </CardContent>
  </Card>;
}

function HourlyChart({ hourly, scopeWord, demo = false }: { hourly: ReturnType<typeof hourlySlots>; scopeWord: string; demo?: boolean }) {
  const slots = hourlySlots(hourly);
  const data = slots.map((point) => ({ hour: point.hour, label: String(point.hour).padStart(2, "0"), sessions: point.sessions }));
  const totalSessions = data.reduce((sum, point) => sum + point.sessions, 0);
  return <Card className="im-wb-mgmt-card" data-chart="hourly" data-points={slots.filter((point) => point.sessions > 0).length}>
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-1.5">{scopeWord}每小时新咨询 <SupportInfoHint label="每小时新咨询口径">按北京时间小时归类的新咨询总数，不是日均值。</SupportInfoHint></CardTitle>
        {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
      </div>
      <div className="text-sm text-muted-foreground">00:00–23:00 · {scopeWord}新建咨询共 {totalSessions} 次</div>
    </CardHeader>
    <CardContent>
      {hasHourlyData(slots) ? <div className="im-wb-mgmt-chartbox" role="img" tabIndex={0} aria-label={`${scopeWord}每小时新咨询量`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="18%">
            <defs><linearGradient id="mgmt-hourly" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--mgmt-chart-1)" stopOpacity={0.35} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" interval={2} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
            <ChartTooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} labelFormatter={(value) => `${value}:00`} formatter={(value) => [`${value}`, "新咨询"]} />
            <Bar dataKey="sessions" name="sessions" fill="url(#mgmt-hourly)" radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无时段数据</p>}
    </CardContent>
  </Card>;
}

function AgentWorkloadChart({ agents, scopeWord, demo = false }: { agents: SupportOverviewAgent[]; scopeWord: string; demo?: boolean }) {
  const data = agents.map((agent) => ({
    name: agent.name,
    adminUserId: agent.adminUserId,
    hours: Math.round((agent.todaySeconds / 3600) * 10) / 10,
    sessions: agent.todaySessions,
    display: formatDuration(agent.todaySeconds),
  }));
  const maxDataHours = Math.max(0, ...data.map((point) => point.hours));
  const maxHours = Math.max(1, Math.ceil(maxDataHours));
  const totalSeconds = agents.reduce((sum, a) => sum + (a.todaySeconds ?? 0), 0);
  const totalHours = Math.round((totalSeconds / 3600) * 10) / 10;
  return <Card className="im-wb-mgmt-card" data-chart="workload" data-points={data.length}>
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-1.5">{scopeWord}接待时长 <SupportInfoHint label="接待时长口径">各客服在所选期间内的接待时长。</SupportInfoHint></CardTitle>
        {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
      </div>
      <div className="text-sm text-muted-foreground">{data.length} 名客服 · 合计 {totalHours} 小时（{formatDuration(totalSeconds)}）</div>
    </CardHeader>
    <CardContent>
      <div className="im-wb-mgmt-legend"><span data-series="seconds">接待时长（小时）</span></div>
      {hasWorkloadData(agents) ? <div className="im-wb-mgmt-chartbox" role="img" tabIndex={0} aria-label={`${scopeWord}各客服接待时长`}>
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 48)}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
            <defs><linearGradient id="mgmt-workload" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="var(--mgmt-chart-3)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--mgmt-chart-3)" stopOpacity={0.95} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis type="number" domain={[0, maxHours]} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={6} tickFormatter={(value) => `${value}h`} />
            <YAxis type="category" dataKey="name" width={64} tick={{ fill: "var(--foreground)", fontSize: 12 }} axisLine={false} tickLine={false} />
            <ChartTooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value, _name, item) => [`${(item.payload as { display?: string }).display ?? `${value}h`} · ${(item.payload as { sessions?: number }).sessions ?? 0} 会话`, "接待"]} />
            <Bar dataKey="hours" name="hours" fill="url(#mgmt-workload)" radius={[0, 5, 5, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="im-wb-mgmt-chart-empty" role="status">暂无数据</p>}
    </CardContent>
  </Card>;
}

/* ------------------------------ 服务时效 ------------------------------ */

function TimelinessMetric({ id, label, value, note, missing }: { id: string; label: string; value: string; note?: string; missing?: boolean }) {
  return <div className="im-wb-timeliness-metric" data-sla-metric={id} data-missing={missing ? "true" : undefined}>
    <span className="flex flex-wrap items-center gap-2">
      <b className="text-lg font-semibold tabular-nums">{value}</b>
      {missing ? <Badge variant="outline">暂无数据</Badge> : null}
    </span>
    <span className="text-xs text-muted-foreground">{label}</span>
    {note ? <span className="text-[11px] leading-relaxed text-muted-foreground">{note}</span> : null}
  </div>;
}

function ServiceTimelinessCard({ overview, scopeWord, demo = false }: { overview: SupportOverview; scopeWord: string; demo?: boolean }) {
  const firstResponse = overview.quality?.firstResponse ?? null;
  const resolution = overview.quality?.resolution ?? null;
  const transfers = overview.totals.transfersToday;
  const asked = firstResponse?.askedCount;
  const unansweredClosed = firstResponse && asked !== undefined
    ? Math.max(0, asked - firstResponse.sampleCount - firstResponse.pending) : null;
  const firstNote = !firstResponse ? "暂无首响统计"
    : asked !== undefined
      ? `首次提问 ${asked} · 已回复 ${firstResponse.sampleCount} · 待回复 ${firstResponse.pending}`
      : `样本 ${firstResponse.sampleCount} · 待回复 ${firstResponse.pending}`;
  const resolutionNote = !resolution ? "暂无办结统计" : `样本 ${resolution.sampleCount} 轮`;
  const help = !firstResponse
    ? "暂无首响统计。解决时长按已结束的接待咨询统计。"
    : `首响按${scopeWord}首次提问的咨询统计，仅计算已回复咨询。${firstResponse.slaSeconds != null ? ` 响应提醒阈值 ${firstResponse.slaSeconds} 秒。` : ""}${unansweredClosed != null ? ` 已结束未记录首答 ${unansweredClosed} 条。` : ""}${firstResponse.overdue > 0 ? ` 等待超时 ${firstResponse.overdue} 条。` : ""} 解决时长仅统计${scopeWord}已接待并结束的咨询。`;
  return <Card className="im-wb-mgmt-card" data-panel="timeliness">
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-1.5">服务时效 <SupportInfoHint label="服务时效口径">{help}</SupportInfoHint></CardTitle>
        {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
      </div>
    </CardHeader>
    <CardContent className="im-wb-mgmt-card-content">
      <div className="im-wb-timeliness-metrics">
        <TimelinessMetric id="first-response" label="平均首次响应" value={firstResponse && firstResponse.sampleCount > 0 ? formatSlaDuration(firstResponse.averageSeconds) : "—"} note={firstNote} missing={!firstResponse} />
        <TimelinessMetric id="resolution" label="平均解决时长" value={resolution && resolution.sampleCount > 0 ? formatSlaDuration(resolution.averageSeconds) : "—"} note={resolutionNote} missing={!resolution} />
        <TimelinessMetric id="transfer" label={`${scopeWord}转交`} value={transfers !== null ? String(transfers) : "—"} note={transfers === null ? "暂无转交统计" : `${scopeWord}完成的咨询转交`} />
      </div>
      {!firstResponse || !resolution ? <p className="im-wb-mgmt-inline-state">部分时效数据暂未提供</p> : null}
    </CardContent>
  </Card>;
}

/** 两个统计页复用同一套 1→5 星数据映射和可访问数值。 */
export function SupportRatingBars({ distribution, count, emptyLabel = "今日暂无评价" }: { distribution: readonly number[]; count: number; emptyLabel?: string }) {
  if (!count) return <p className="im-wb-mgmt-inline-state" role="status">{emptyLabel}</p>;
  // API distribution 索引 0 是 1 星；按 1→5 展示，避免倒序造成读数错位。
  const data = [1, 2, 3, 4, 5].map(score => ({ label: `${score} 星`, count: distribution[score - 1] ?? 0 }));
  return <div className="im-wb-mgmt-rating-chart" data-chart="rating-distribution" data-count={count} role="img" tabIndex={0} aria-label={`评分分布：${data.map(point => `${point.label} ${point.count} 条`).join("、")}`}>
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 30, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" width={42} tick={{ fill: "var(--foreground)", fontSize: 12 }} axisLine={false} tickLine={false} />
        <ChartTooltip wrapperStyle={{ pointerEvents: "none" }} cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }} contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "var(--foreground)" }} formatter={value => [`${value} 条`, "评价"]} />
        <Bar dataKey="count" fill="var(--mgmt-chart-2)" radius={[0, 4, 4, 0]} maxBarSize={14}>
          <LabelList dataKey="count" position="right" fill="var(--muted-foreground)" fontSize={11} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>;
}
