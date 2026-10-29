"use client";

/**
 * 客服管理（运营）：看板 + 会话巡视。
 *
 * - 只看服务端已给出的数字；缺失/空/403/失败都保持真实状态，不造数据、不补时间。
 * - 图表用 CSS 条形绘制，不引入图表库；无可画数据时显示“暂无数据”。
 * - 巡视复用工作台的消息外观（文本/图片/卡片/系统事件），只读、无发送框。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
  auditConversationsPath, auditMessagesPath, auditStateLabel, auditTypeLabel,
  availabilityLabel, formatDayLabel, formatDuration, handoverObjectLabel, hasHourlyData,
  hasTrendData, hasWorkloadData, hourlySlots, parseAuditConversations, parseAuditMessages,
  parseSupportHandovers, parseSupportOverview, withinTimeFilter,
  type AuditConversation, type AuditTimeFilter, type SupportHandover, type SupportOverview,
  type SupportOverviewAgent, type SupportTrendPoint,
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
      request<unknown>("/im/handovers?limit=20"),
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

    <Card className="im-wb-mgmt-card" data-panel="on-duty">
      <CardHeader><CardTitle>统计</CardTitle><CardDescription>状态、当前负载与今日接待量</CardDescription></CardHeader>
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
      <AgentWorkloadChart agents={overview.onDuty} />
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
    <CardHeader><CardTitle>最近交接</CardTitle><CardDescription>最近 20 条；客服本人只看到与自己相关的记录</CardDescription></CardHeader>
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
