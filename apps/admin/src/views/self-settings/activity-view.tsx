import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ArrowLeftIcon, ArrowRightIcon, CircleSlash2Icon, InboxIcon, RotateCcwIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { EmptyState, EndOfFeed } from "../../components/empty-state";
import {
  activityActionLabel,
  activityActorPhrase,
  activityDetailPhrases,
  activityFilterLabel,
  activityOutcomeLabel,
  activityQueryKey,
  advanceCursorPage,
  atEndOfFeed,
  beijingDateTime,
  classifyReadFailure,
  cursorAt,
  emptyCursorPage,
  goBackCursorPage,
  hasActiveActivityFilters,
  parseActivityPayload,
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_NOT_RECORDED_TEXT,
  UNKNOWN_TEXT,
  type ActivityCoverage,
  type ActivityEvent,
  type CursorPage,
  type ReadFailure,
} from "./model";
import { SettingsNotice, SettingsPageHeader } from "./settings-shell";
import { ActionFilterCombobox, ActivityTimeline } from "./activity-parts";
import { cn } from "@/lib/utils";

export type ActivityViewProps = {
  adminUserId: string;
  sessionId: string;
  accountStatus: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
  locked: boolean;
  /** 注入分页读取；本包不出现 endpoint 或路径拼接（见 self-settings-api.ts）。 */
  load: (input: { cursor: string | null; action: string; limit: number }) => Promise<unknown>;
  /** 已提交查询的回写钩子，供工作区标签持久化；本包不改共享入口。 */
  onQueryChange?: (values: { action: string }) => void;
  initialQuery?: { action?: string };
  limit?: number;
};

type LastSuccess = { queryKey: string; index: number; events: ActivityEvent[] };
type LastAttempt = { action: string; page: CursorPage; isRefresh: boolean };

const ALL_ACTIONS = "__all";

export function ActivityView({
  adminUserId,
  sessionId,
  accountStatus,
  locked,
  load,
  onQueryChange,
  initialQuery,
  limit = ACTIVITY_DEFAULT_LIMIT,
}: ActivityViewProps) {
  const identityKey = `${adminUserId}|${sessionId}|${accountStatus}|${locked ? "locked" : "unlocked"}`;
  const identityKeyRef = useRef(identityKey);
  const epochRef = useRef(0);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  const [draftAction, setDraftAction] = useState(initialQuery?.action ?? "");
  const [submittedAction, setSubmittedAction] = useState(initialQuery?.action ?? "");
  const submittedRef = useRef(submittedAction);
  submittedRef.current = submittedAction;

  const [page, setPage] = useState<CursorPage>(emptyCursorPage);
  const pageRef = useRef(page);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [coverage, setCoverage] = useState<ActivityCoverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [failure, setFailure] = useState<ReadFailure | null>(null);
  const [stale, setStale] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const lastSuccessRef = useRef<LastSuccess | null>(null);
  const lastAttemptRef = useRef<LastAttempt | null>(null);

  const isCurrent = (epoch: number, key: string, seq: number) =>
    mountedRef.current && epochRef.current === epoch && identityKeyRef.current === key && seqRef.current === seq;

  useLayoutEffect(() => {
    if (identityKeyRef.current === identityKey) return;
    identityKeyRef.current = identityKey;
    epochRef.current += 1;
    // 切身份/锁定/失权：上一身份的活动投影与游标链全部作废，旧响应不得落到新上下文。
    seqRef.current += 1;
    pageRef.current = emptyCursorPage();
    setPage(pageRef.current);
    setEvents([]);
    setCoverage(null);
    setFailure(null);
    setStale(false);
    setForbidden(false);
    setLoading(false);
    setHasLoadedOnce(false);
    lastSuccessRef.current = null;
    lastAttemptRef.current = null;
    setDraftAction("");
    setSubmittedAction("");
    submittedRef.current = "";
  }, [identityKey]);

  useEffect(() => {
    mountedRef.current = true;
    epochRef.current += 1;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const loadPage = useCallback(
    async (options?: { action?: string; page?: CursorPage; isRefresh?: boolean }) => {
      const epoch = epochRef.current;
      const key = identityKeyRef.current;
      const targetAction = options?.action ?? submittedRef.current;
      const targetPage = options?.page ?? pageRef.current;
      const seq = ++seqRef.current;
      const targetKey = activityQueryKey({ action: targetAction });
      const sameAsLastSuccess =
        lastSuccessRef.current !== null && lastSuccessRef.current.queryKey === targetKey && lastSuccessRef.current.index === targetPage.index;
      const isRefresh = options?.isRefresh ?? sameAsLastSuccess;

      // 重试目标只记录本次实际发出的查询与游标位置，失败面板才能重放到真正失败的那一页。
      lastAttemptRef.current = { action: targetAction, page: targetPage, isRefresh };

      setLoading(true);
      setFailure(null);
      if (locked || accountStatus !== "ACTIVE") {
        setEvents([]);
        setCoverage(null);
        setLoading(false);
        return;
      }
      try {
        const parsed = parseActivityPayload(await load({ cursor: cursorAt(targetPage), action: targetAction, limit }));
        if (!isCurrent(epoch, key, seq)) return;
        const next: CursorPage = { cursors: targetPage.cursors, index: targetPage.index, nextCursor: parsed.nextCursor };
        pageRef.current = next;
        setPage(next);
        setEvents(parsed.events);
        setCoverage(parsed.coverage);
        setSubmittedAction(targetAction);
        submittedRef.current = targetAction;
        setHasLoadedOnce(true);
        setStale(false);
        setFailure(null);
        // 403 只在当前身份与序号下的成功读取后解除，避免迟到的成功响应覆盖新的失权状态。
        setForbidden(false);
        lastSuccessRef.current = { queryKey: targetKey, index: targetPage.index, events: parsed.events };
      } catch (error) {
        if (!isCurrent(epoch, key, seq)) return;
        const classified = classifyReadFailure(error, "安全活动读取未完成");
        setHasLoadedOnce(true);
        if (classified.kind === "forbidden") {
          setForbidden(true);
          setEvents([]);
          setCoverage(null);
          pageRef.current = emptyCursorPage();
          setPage(pageRef.current);
          lastSuccessRef.current = null;
          setStale(false);
          setFailure(classified);
          return;
        }
        if (classified.kind === "unauthorized" || classified.kind === "locked") {
          // 全站认证协调负责跳转/锁屏；本页只清投影，不复制一套 401/423 处理。
          setEvents([]);
          setCoverage(null);
          lastSuccessRef.current = null;
          setStale(false);
          setFailure(classified);
          return;
        }
        if (isRefresh && lastSuccessRef.current && lastSuccessRef.current.queryKey === targetKey && lastSuccessRef.current.index === targetPage.index) {
          // 同查询刷新失败：刻意不触碰 events，保留上一次成功读取的事实，只另加旧数据标记。
          setStale(true);
          setFailure(classified);
          return;
        }
        // 换了查询或翻页失败：不沿用旧数据，避免把两个查询的结果串在一起。
        setEvents([]);
        lastSuccessRef.current = null;
        setStale(false);
        setFailure(classified);
      } finally {
        if (isCurrent(epoch, key, seq)) setLoading(false);
      }
    },
    [identityKey, load, limit],
  );

  useEffect(() => {
    void loadPage({ action: submittedRef.current, page: emptyCursorPage() });
  }, [loadPage]);

  const submitAction = (action: string) => {
    setDraftAction(action);
    pageRef.current = emptyCursorPage();
    setPage(pageRef.current);
    lastSuccessRef.current = null;
    onQueryChange?.({ action });
    void loadPage({ action, page: emptyCursorPage() });
  };

  const retryLastAttempt = () => {
    const attempt = lastAttemptRef.current;
    if (attempt) {
      void loadPage({ action: attempt.action, page: attempt.page, isRefresh: attempt.isRefresh });
      return;
    }
    void loadPage({ action: submittedRef.current, page: pageRef.current });
  };

  /** 头部刷新：用户主动重读当前页，失败时应保留上一次读到的事实并标注为旧。 */
  const refreshCurrent = () => {
    void loadPage({ action: submittedRef.current, page: pageRef.current, isRefresh: true });
  };

  const goNext = () => {
    const next = advanceCursorPage(pageRef.current);
    pageRef.current = next;
    setPage(next);
    void loadPage({ page: next });
  };

  const goPrev = () => {
    const next = goBackCursorPage(pageRef.current);
    if (next.index === pageRef.current.index) return;
    pageRef.current = next;
    setPage(next);
    void loadPage({ page: next });
  };

  const filtersActive = hasActiveActivityFilters({ action: submittedAction });
  const draftChanged = draftAction !== submittedAction;
  const showEndOfFeed = hasLoadedOnce && !failure && !forbidden && events.length > 0 && atEndOfFeed(page);
  const showRealEmpty = hasLoadedOnce && !failure && !forbidden && events.length === 0 && !filtersActive;
  const showNoResults = hasLoadedOnce && !failure && !forbidden && events.length === 0 && filtersActive;
  const notRecorded = (coverage?.notRecorded ?? []).map((item) => ACTIVITY_NOT_RECORDED_TEXT[item] ?? item);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <SettingsPageHeader
        eyebrow="设置 · 安全活动"
        title="本人安全活动"
        description="只列出服务端确认归属本人的安全事件：我发起的，以及他人对我账号执行的操作。"
        aside={
          <Button type="button" size="sm" variant="outline" onClick={refreshCurrent} disabled={loading}>
            <RotateCcwIcon />
            <span>重新读取</span>
          </Button>
        }
      />

      {locked || accountStatus !== "ACTIVE" ? <SettingsNotice tone="warning">当前账号或会话不可用，恢复验证后可查看安全活动。</SettingsNotice> : null}
      {forbidden ? (
        <EmptyState
          icon={<CircleSlash2Icon className="size-4" aria-hidden />}
          title="无权读取本人安全活动"
          description="该读取需要服务端确认的本人安全活动访问条件；本页不使用全局账号审计接口作为替代。"
          action={
            <Button type="button" size="sm" variant="secondary" onClick={refreshCurrent} disabled={loading}>
              重新读取
            </Button>
          }
        />
      ) : null}

      {failure && events.length === 0 && !(forbidden && failure.kind === "forbidden") ? (
        <SettingsNotice tone="danger" role="alert" action={<Button size="sm" variant="secondary" onClick={retryLastAttempt} disabled={loading}>重试本次查询</Button>}>
          {failure.message}
          {failure.requestId ? <span className="mt-1 block break-all font-mono text-[11px]">请求编号 {failure.requestId}</span> : null}
        </SettingsNotice>
      ) : null}

      {stale && failure ? (
        <SettingsNotice tone="warning" role="alert" action={<Button size="sm" variant="secondary" onClick={retryLastAttempt} disabled={loading}>重试刷新</Button>}>
          刷新失败，下方仍是上一次成功读取到的结果，可能已不是当前事实。原因：{failure.message}
        </SettingsNotice>
      ) : null}

      {coverage && coverage.recordedActions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <ActionFilterCombobox actions={coverage.recordedActions} value={submittedAction} onChange={submitAction} disabled={loading} />
          {filtersActive ? (
            <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => submitAction("")}>
              清除筛选
            </Button>
          ) : null}
          {stale ? <Badge variant="warning">旧数据</Badge> : null}
          <span className="text-muted-foreground ml-auto text-xs">时间为北京时间</span>
        </div>
      ) : null}

      {notRecorded.length > 0 ? (
        <p className="text-muted-foreground text-[11px]">未纳入记录：{notRecorded.join("、")}</p>
      ) : null}

      {loading && !hasLoadedOnce ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : null}

      {showRealEmpty ? (
        <EmptyState
          icon={<InboxIcon className="size-4" aria-hidden />}
          title="暂无可展示的安全活动"
          description="服务端确认当前范围内没有记录。这不等于历史已清空，也不代表更早的事件已被删除。"
        />
      ) : null}

      {showNoResults ? (
        <EmptyState
          icon={<InboxIcon className="size-4" aria-hidden />}
          title="当前筛选没有匹配记录"
          description={`仍在生效的筛选条件：事件类型：${activityFilterLabel(submittedAction)}。接口失败或权限变化不会显示为该状态。`}
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => submitAction("")} disabled={loading}>
              清除筛选
            </Button>
          }
        />
      ) : null}

      {events.length > 0 ? (
        <>
          <ActivityTimeline events={events} dimmed={loading} />
          {page.index > 0 || page.nextCursor ? (
            <div className="flex items-center justify-between gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={goPrev} disabled={loading || page.index === 0}>
                <ArrowLeftIcon />
                <span>上一页</span>
              </Button>
              <span className="text-muted-foreground text-xs">第 {page.index + 1} 页</span>
              <Button type="button" size="sm" variant="ghost" onClick={goNext} disabled={loading || !page.nextCursor}>
                <span>下一页</span>
                <ArrowRightIcon />
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
