"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { AdminApiError, friendlyError, type SessionSnapshot } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { TooltipProvider } from "../components/ui/tooltip";
import { formatDateTime } from "./im-support-format";
import { formatDuration, formatSlaDuration, formatRatingAverage, parseSupportPeriod, type SupportReportPeriod } from "./im-support-management-model";
import { SupportRatingBars } from "./im-support-statistics";
import {
  SupportInfoHint, SupportReportRangePicker, anchorDateOf, periodRange, rangeLabel, rangeScopeWord,
  resolveSupportRange, type SupportRangeSelection, type SupportReportRange,
} from "./im-support-report-range";
import type { SupportManagementRequest } from "./im-support-management";

export type MySupportStatisticsData = {
  reportDate: string;
  serverNow: string;
  period: SupportReportPeriod | null;
  today: {
    seconds: number;
    sessions: number;
    users: number;
  };
  current: {
    consultations: number;
    orderGroups: number;
    unread: number;
    oldestPendingAt: string | null;
  };
  ratings: {
    count: number;
    average: number | null;
    distribution: number[];
  };
  firstResponse: {
    sampleCount: number;
    averageSeconds: number | null;
  };
};

export function parseMySupportStatistics(input: unknown): MySupportStatisticsData {
  if (!input || typeof input !== "object") throw new Error("无效的个人接待数据响应");
  const row = input as Record<string, unknown>;

  if (typeof row.reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.reportDate)) {
    throw new Error("缺失或无效的报表日期");
  }
  if (typeof row.serverNow !== "string" || !Number.isFinite(Date.parse(row.serverNow))) {
    throw new Error("缺失或无效的服务器时间");
  }

  if (!row.today || typeof row.today !== "object") throw new Error("缺失所选期间接待数据");
  const today = row.today as Record<string, unknown>;
  const seconds = today.seconds;
  const sessions = today.sessions;
  const users = today.users;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 ||
      typeof sessions !== "number" || !Number.isFinite(sessions) || sessions < 0 ||
      typeof users !== "number" || !Number.isFinite(users) || users < 0) {
    throw new Error("所选期间接待数据格式错误");
  }

  if (!row.current || typeof row.current !== "object") throw new Error("缺失当前接待数据");
  const current = row.current as Record<string, unknown>;
  const consultations = current.consultations;
  const orderGroups = current.orderGroups;
  const unread = current.unread;
  const oldestPendingAt = current.oldestPendingAt;
  if (typeof consultations !== "number" || !Number.isFinite(consultations) || consultations < 0 ||
      typeof orderGroups !== "number" || !Number.isFinite(orderGroups) || orderGroups < 0 ||
      typeof unread !== "number" || !Number.isFinite(unread) || unread < 0) {
    throw new Error("当前接待数据格式错误");
  }
  if (oldestPendingAt !== null && (typeof oldestPendingAt !== "string" || !Number.isFinite(Date.parse(oldestPendingAt)))) {
    throw new Error("待办会话时间格式错误");
  }

  if (!row.ratings || typeof row.ratings !== "object") throw new Error("缺失评价数据");
  const ratings = row.ratings as Record<string, unknown>;
  const count = ratings.count;
  const average = ratings.average;
  const distribution = ratings.distribution;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    throw new Error("评价数格式错误");
  }
  if (average !== null && (typeof average !== "number" || !Number.isFinite(average) || average < 1 || average > 5)) {
    throw new Error("平均分格式错误");
  }
  if (!Array.isArray(distribution) || distribution.length !== 5 ||
      !distribution.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    throw new Error("评价星级分布格式错误");
  }

  if (!row.firstResponse || typeof row.firstResponse !== "object") throw new Error("缺失首响数据");
  const firstResponse = row.firstResponse as Record<string, unknown>;
  const sampleCount = firstResponse.sampleCount;
  const averageSeconds = firstResponse.averageSeconds;
  if (typeof sampleCount !== "number" || !Number.isFinite(sampleCount) || sampleCount < 0) {
    throw new Error("首响应样本数格式错误");
  }
  if (averageSeconds !== null && (typeof averageSeconds !== "number" || !Number.isFinite(averageSeconds) || averageSeconds < 0)) {
    throw new Error("首响应平均时长格式错误");
  }

  return {
    reportDate: row.reportDate,
    serverNow: row.serverNow,
    period: parseSupportPeriod(row.period),
    today: { seconds, sessions, users },
    current: { consultations, orderGroups, unread, oldestPendingAt: oldestPendingAt as string | null },
    ratings: { count, average, distribution: distribution as number[] },
    firstResponse: { sampleCount, averageSeconds },
  };
}

export function MySupportStatisticsView({
  active = true,
  request,
  demo = false,
  snapshot,
  onOpenPath,
}: {
  active?: boolean;
  request: SupportManagementRequest;
  demo?: boolean;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onOpenPath?: (path: string) => void;
}) {
  const [data, setData] = useState<MySupportStatisticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<SupportRangeSelection>({ preset: "today", range: null });
  const [anchorDate, setAnchorDate] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  const anchorRef = useRef<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const requestRef = useRef(request);
  const identityRef = useRef(snapshot.adminUserId);
  const generationRef = useRef(0);

  useEffect(() => {
    if (requestRef.current !== request) {
      requestRef.current = request;
      loadedKeyRef.current = null;
      setData(null);
    }
    if (identityRef.current !== snapshot.adminUserId) {
      identityRef.current = snapshot.adminUserId;
      loadedKeyRef.current = null;
      setData(null);
      setLoading(true);
    }
  }, [request, snapshot.adminUserId]);

  const load = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const resolved = resolveSupportRange(selectionRef.current, anchorRef.current);
    if (resolved.error) {
      setData(null);
      setLoading(false);
      setError(resolved.error);
      setErrorStatus(null);
      setRefreshing(false);
      return;
    }
    const path = `/im/my-support-statistics${resolved.query}`;
    if (loadedKeyRef.current !== path) {
      setData(null);
      setLoading(true);
      setError("");
      setErrorStatus(null);
    }
    setRefreshing(true);
    try {
      const response = await request<unknown>(path);
      if (generation !== generationRef.current) return;
      const parsed = parseMySupportStatistics(response);
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
      setData(parsed);
      setError("");
      setErrorStatus(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      const status = err instanceof AdminApiError ? err.status : null;
      if (status !== null && [401, 403, 423].includes(status)) {
        loadedKeyRef.current = null;
        setData(null);
      }
      const explicit = selectionRef.current.preset !== "today";
      const unsupported = explicit && (status === 400 || status === 404 || status === 405);
      setError(unsupported
        ? "当前服务端尚未支持所选时间范围；未退回今天，请刷新或联系维护者。"
        : err instanceof AdminApiError
          ? friendlyError(err)
          : err instanceof Error ? err.message : "个人接待数据不完整，请刷新后重试。");
      setErrorStatus(status);
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [request]);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => { generationRef.current += 1; };
  }, [active, load, snapshot.adminUserId]);

  const applySelection = (next: SupportRangeSelection) => {
    selectionRef.current = next;
    setSelection(next);
    void load();
  };

  if (error && !data && errorStatus === 403) {
    return <div className="im-wb-mgmt-state" data-state="forbidden" role="status">
      <ShieldCheck size={22} aria-hidden="true" />
      <strong>无权查看个人接待数据</strong>
      <span>需要「客服接待读取」权限；请联系管理员。</span>
    </div>;
  }

  const currentAdminName = snapshot.user.name || snapshot.user.username || "当前客服";
  const displayRange: SupportReportRange | null = data
    ? data.period
      ? periodRange(data.period)
      : { dateFrom: data.reportDate, dateTo: data.reportDate }
    : selection.range;
  const headerRangeLabel = displayRange
    ? rangeLabel(displayRange, anchorDate)
    : selection.preset === "today" ? "今日" : rangeLabel(selection.range, anchorDate);
  const scopeWord = rangeScopeWord(displayRange, anchorDate);
  const headerNote = data
    ? `${currentAdminName} · 仅本人 · ${headerRangeLabel} · 更新于 ${formatDateTime(data.serverNow)}${refreshing ? " · 刷新中…" : ""}`
    : `${currentAdminName} · 仅本人 · ${headerRangeLabel} · ${loading ? "正在读取" : "读取失败"}`;

  return <TooltipProvider>
    <div className="im-wb-mgmt-dashboard" data-page="support-mine" data-period-from={displayRange?.dateFrom} data-period-to={displayRange?.dateTo}>
      <header className="im-wb-mgmt-toolbar">
        <div className="im-wb-mgmt-heading">
          <div className="flex items-center gap-2">
            <h1>我的接待</h1>
            <SupportInfoHint label="我的接待口径">按北京时间统计，包含起止日期；当前待办不受日期筛选影响。</SupportInfoHint>
            {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
          </div>
          <span className="im-wb-mgmt-toolbar-note">{headerNote}</span>
        </div>
        <div className="im-support-toolbar-actions">
          <SupportReportRangePicker value={selection} displayRange={displayRange} anchorDate={anchorDate} disabled={!anchorDate && !displayRange} onChange={applySelection} />
          <Button variant="outline" size="sm" data-action="refresh-mine" onClick={() => void load()} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新"}</Button>
        </div>
      </header>

      {error && data ? (
        <div className="im-wb-notice" data-tone="warn" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>刷新失败，以下仍是上次结果：{error}</span>
          <Button variant="link" size="sm" onClick={() => void load()}>重新刷新</Button>
        </div>
      ) : null}

      {!data && loading ? <div className="im-wb-mgmt-state" role="status">正在读取所选时间范围…</div> : null}
      {!data && !loading && error ? (
        <div className="im-wb-mgmt-state" data-state="error" role="alert">
          <CircleAlert size={22} aria-hidden="true" />
          <strong>个人接待数据读取失败</strong>
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>重新读取</Button>
        </div>
      ) : null}

      {data ? <>
        <div className="im-wb-mgmt-totals" aria-label="本人接待概况">
          <Card size="sm" className="im-wb-mgmt-metric"><CardContent>
            <span className="im-wb-mgmt-metric-value">{formatDuration(data.today.seconds)}</span>
            <span className="im-wb-mgmt-metric-label">{scopeWord}接待时长 <SupportInfoHint label="接待时长口径">只计入所选期间内的接待时长。</SupportInfoHint></span>
          </CardContent></Card>
          <Card size="sm" className="im-wb-mgmt-metric"><CardContent>
            <span className="im-wb-mgmt-metric-value">{data.today.sessions}</span>
            <span className="im-wb-mgmt-metric-label">{scopeWord}接待咨询 <SupportInfoHint label="接待咨询口径">期间分配、接入、转交或结束时涉及本人的咨询，同一咨询只计一次。</SupportInfoHint></span>
          </CardContent></Card>
          <Card size="sm" className="im-wb-mgmt-metric"><CardContent>
            <span className="im-wb-mgmt-metric-value">{data.today.users}</span>
            <span className="im-wb-mgmt-metric-label">{scopeWord}接待用户 <SupportInfoHint label="接待用户口径">所选期间去重用户；同一用户跨天只计 1 人。</SupportInfoHint></span>
          </CardContent></Card>
          <Card size="sm" className="im-wb-mgmt-metric"><CardContent>
            <span className="im-wb-mgmt-metric-value">{data.current.unread}</span>
            <span className="im-wb-mgmt-metric-label">当前未读消息 <SupportInfoHint label="当前未读口径">当前仍由本人负责且未读的会话消息数；实时事实。</SupportInfoHint></span>
          </CardContent></Card>
        </div>

        <div className="im-wb-mgmt-summary-grid im-wb-personal-summary">
          <Card className="im-wb-mgmt-card" data-panel="current-load">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-1.5">当前待办 <SupportInfoHint label="当前待办口径">当前负责的咨询/订单群与最早未读留言；不随历史区间隐藏。</SupportInfoHint></CardTitle>
                {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between border-b pb-2 text-sm">
                <span className="text-muted-foreground">当前负责咨询数</span>
                <span className="font-semibold tabular-nums">{data.current.consultations} 条</span>
              </div>
              <div className="flex items-center justify-between border-b pb-2 text-sm">
                <span className="text-muted-foreground">当前负责在租订单群数</span>
                <span className="font-semibold tabular-nums">{data.current.orderGroups} 组</span>
              </div>
              <div className="flex flex-col gap-1 pt-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-muted-foreground">有未读会话的首次留言时间 <SupportInfoHint label="待跟进时间口径">仍有未读消息的会话中，最早一轮的首次留言时间。</SupportInfoHint></span>
                  <span className="font-medium tabular-nums">
                    {data.current.oldestPendingAt ? formatDateTime(data.current.oldestPendingAt) : "暂无待跟进留言"}
                  </span>
                </div>
              </div>
              {onOpenPath ? (
                <div className="pt-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenPath("/support")}>
                    前往工作台
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="im-wb-mgmt-card" data-panel="personal-quality">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-1.5">{scopeWord}服务时效与评价 <SupportInfoHint label="服务时效与评价口径">首响统计期间内本人首次回复的咨询，可含之前收到的提问；评价按提交时间统计。</SupportInfoHint></CardTitle>
                {demo ? <Badge variant="outline">本地演示数据</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="im-wb-personal-quality-facts">
                <div>
                  <div className="text-xs text-muted-foreground">首响时长</div>
                  <div className="mt-1 text-xl font-bold tabular-nums">
                    {data.firstResponse.sampleCount > 0 ? formatSlaDuration(data.firstResponse.averageSeconds) : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    样本数：{data.firstResponse.sampleCount}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">评价平均分</div>
                  <div className="mt-1 text-xl font-bold tabular-nums">
                    {formatRatingAverage(data.ratings.average)}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    评价数：{data.ratings.count} 条
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">评价星级分布（1 星 → 5 星）</p>
                <SupportRatingBars distribution={data.ratings.distribution} count={data.ratings.count} emptyLabel={scopeWord === "今日" ? "今日暂无评价" : "所选期间暂无评价"} />
              </div>
            </CardContent>
          </Card>
        </div>
      </> : null}
    </div>
  </TooltipProvider>;
}
