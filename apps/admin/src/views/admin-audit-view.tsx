import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CopyIcon,
  CheckIcon,
  InboxIcon,
  SearchXIcon,
} from "lucide-react";

import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import { EmptyState, EndOfFeed } from "../components/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { InlineStatus } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import {
  ACCOUNT_AUDIT_ACTIONS,
  ACCOUNT_OBJECT_TYPES,
  DOMAIN_LABELS,
  actionLabel as labelForAction,
  beijingLocalToIso,
  detailRows,
  domainOf,
  formatBeijing,
  objectTypeLabel,
} from "../lib/audit-labels";
import {
  AdminApiError,
  adminRequest,
  friendlyError,
  hasPermission,
  type SessionSnapshot,
} from "../api";

type AuditEvent = {
  eventId: string;
  actor: { type?: string; username: string; displayUsername?: string; name: string };
  action: string;
  objectType: string;
  objectId: string | null;
  objectDisplay?: string | null;
  rawObjectType?: string;
  outcome: "SUCCESS" | "FAILURE";
  reason: string | null;
  requestId: string | null;
  occurredAt: string | null;
  details: Record<string, unknown>;
};

type AuditResponse = {
  events?: AuditEvent[];
  nextCursor?: string | null;
  scope?: string;
};

type CursorPage = { cursors: (string | null)[]; index: number; nextCursor: string | null };

type AuditFilterQuery = {
  action: string;
  objectType: string;
  actorUsername: string;
  requestId: string;
  outcome: string;
  from: string;
  to: string;
  domain: string;
  objectId: string;
};

export type AuditViewVariant = "account" | "operations";

const FILTER_KEYS = ["action", "objectType", "actorUsername", "requestId", "outcome", "from", "to", "domain", "objectId"] as const;

function queryFrom(source: Record<string, string> | undefined): AuditFilterQuery {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, source?.[key]?.trim() ?? ""])) as AuditFilterQuery;
}

function cleanQuery(query: AuditFilterQuery): Record<string, string> {
  return Object.fromEntries(FILTER_KEYS.filter((key) => query[key].trim()).map((key) => [key, query[key].trim()]));
}

export function actionLabel(action: string): string {
  return labelForAction(action);
}

function actorText(actor: AuditEvent["actor"]): string {
  return actor.name || actor.displayUsername || actor.username;
}

function scopeLabel(scope: string | undefined): string {
  if (scope === "BOSS_ALL_GENERIC_ADMIN_AUDIT") return "全部管理员的账号与权限相关记录";
  if (scope === "SELF_TARGET_AND_ROLE_ACTIONS") return "与你本人账号相关的记录，以及你执行的角色与账号操作";
  if (scope === "BOSS_ALL_AUDIT_EVENTS") return "后台全部操作记录";
  return "按当前账号可见范围";
}

function CopyId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={`复制${label}`} className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />}
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipContent className="max-w-72 break-all font-mono text-[11px]">{copied ? "已复制" : `${label}：${value}`}</TooltipContent>
    </Tooltip>
  );
}

function Hint({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="cursor-help rounded underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" />}>{children}</TooltipTrigger>
      <TooltipContent className="max-w-72 break-all font-mono text-[11px]">{hint}</TooltipContent>
    </Tooltip>
  );
}

function ObjectCell({ event }: { event: AuditEvent }) {
  const type = objectTypeLabel(event.objectType);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate">{event.objectDisplay ? `${type} · ${event.objectDisplay}` : type}</span>
      {event.objectId ? <CopyId value={event.objectId} label="对象编号" /> : null}
    </div>
  );
}

function DetailList({ details }: { details: Record<string, unknown> }) {
  const rows = detailRows(details);
  if (rows.length === 0) return <p className="text-[11px] text-muted-foreground">无附加详情</p>;
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 text-[11px]">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-all text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function contextKeyOf(snapshot: Extract<SessionSnapshot, { authenticated: true }>): string {
  return JSON.stringify([
    snapshot.adminUserId,
    snapshot.user.username ?? "",
    snapshot.session.id,
    snapshot.security.status,
    snapshot.security.isBoss,
    [...snapshot.permissions].sort(),
  ]);
}

function emptyPage(): CursorPage {
  return { cursors: [null], index: 0, nextCursor: null };
}

function hasActiveFilters(query: AuditFilterQuery): boolean {
  return FILTER_KEYS.some((key) => query[key].trim().length > 0);
}

function queryKeyOf(query: AuditFilterQuery | Record<string, string> | undefined): string {
  return JSON.stringify(FILTER_KEYS.map((key) => [
    key,
    (query as Record<string, string> | undefined)?.[key]?.trim() ?? "",
  ]));
}

const ALL = { value: "ALL", label: "全部" };
const ACCOUNT_OBJECT_ITEMS = [ALL, ...ACCOUNT_OBJECT_TYPES.map((value) => ({ value, label: objectTypeLabel(value) }))];
const ACCOUNT_ACTION_ITEMS = [ALL, ...ACCOUNT_AUDIT_ACTIONS.map((value) => ({ value, label: labelForAction(value) }))];
const OUTCOME_ITEMS = [ALL, { value: "SUCCESS", label: "成功" }, { value: "FAILURE", label: "失败" }];
const DOMAIN_ITEMS = [ALL, ...Object.entries(DOMAIN_LABELS).map(([value, label]) => ({ value, label }))];
const OPERATION_OBJECT_ITEMS = [ALL, ...["admin_user", "admin_security", "admin_role", "admin_session", "user_account", "approval_request", "approval_template"].map((value) => ({ value, label: objectTypeLabel(value) }))];
const inputClass = "h-9 w-full text-xs";

export function AdminAuditView({
  snapshot,
  initialQuery,
  onQueryChange,
  refreshNonce = 0,
  variant = "account",
}: {
  variant?: AuditViewVariant;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialQuery?: Record<string, string>;
  onQueryChange?: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const isOperations = variant === "operations";
  const canRead = isOperations ? snapshot.security.isBoss : hasPermission(snapshot, "admin.audit.read");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const contextKey = contextKeyOf(snapshot);
  const contextKeyRef = useRef(contextKey);
  const contextEpochRef = useRef(0);
  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    contextEpochRef.current += 1;
  }
  const contextEpoch = contextEpochRef.current;

  const [draft, setDraft] = useState<AuditFilterQuery>(() => queryFrom(initialQuery));
  const setField = (key: keyof AuditFilterQuery, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const [submittedQuery, setSubmittedQuery] = useState<AuditFilterQuery>(() => queryFrom(initialQuery));
  const submittedQueryRef = useRef(submittedQuery);
  submittedQueryRef.current = submittedQuery;

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [page, setPage] = useState<CursorPage>(emptyPage);
  const [scope, setScope] = useState<string>();
  const [error, setError] = useState<string>();
  const [refreshWarning, setRefreshWarning] = useState<string>();
  const [isForbidden, setIsForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const lastSuccessRef = useRef<{
    queryKey: string;
    index: number;
    events: AuditEvent[];
    scope?: string;
    nextCursor: string | null;
  } | null>(null);

  const lastAttemptRef = useRef<{
    query: AuditFilterQuery;
    target: { cursors: (string | null)[]; index: number };
    isRefresh?: boolean;
  } | null>(null);

  const initialQueryKey = queryKeyOf(initialQuery);
  const pageRef = useRef(page);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const previousContextKeyRef = useRef(contextKey);
  const previousQueryKeyRef = useRef(initialQueryKey);
  const draftQueryKeyRef = useRef("");
  draftQueryKeyRef.current = queryKeyOf(draft);

  const isCurrent = (epoch: number, key: string) => mountedRef.current && contextEpochRef.current === epoch && contextKeyRef.current === key;

  useEffect(() => {
    // React StrictMode re-runs effect setup after its first cleanup. Restore
    // the live epoch for that setup, while the sequence guards still reject
    // responses from the first setup.
    mountedRef.current = true;
    contextEpochRef.current = contextEpoch;
    return () => {
      mountedRef.current = false;
      contextEpochRef.current += 1;
    };
  }, [contextEpoch]);

  useEffect(() => {
    if (previousContextKeyRef.current === contextKey) return;
    previousContextKeyRef.current = contextKey;
    seqRef.current += 1;
    pageRef.current = emptyPage();
    setPage(pageRef.current);
    setEvents([]);
    setScope(undefined);
    setError(undefined);
    setRefreshWarning(undefined);
    setIsForbidden(false);
    setLoading(false);
    setHasLoadedOnce(false);
    lastSuccessRef.current = null;
    lastAttemptRef.current = null;
  }, [contextKey]);

  const load = async (options?: {
    query?: AuditFilterQuery;
    target?: { cursors: (string | null)[]; index: number };
    isRefresh?: boolean;
  }) => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return;

    const targetQuery = options?.query ?? submittedQueryRef.current;
    const meta = options?.target
      ? { cursors: options.target.cursors, index: options.target.index, nextCursor: pageRef.current.nextCursor }
      : pageRef.current;
    const cursor = meta.cursors[meta.index];
    const seq = ++seqRef.current;

    const targetQueryKey = queryKeyOf(targetQuery);
    const isSameQueryAndPage =
      lastSuccessRef.current !== null &&
      lastSuccessRef.current.queryKey === targetQueryKey &&
      lastSuccessRef.current.index === meta.index;

    const isRefresh = options?.isRefresh ?? isSameQueryAndPage;

    // F1: 记录本次请求尝试的目标，与当前成功展示状态解耦，供错误面板精准重放
    lastAttemptRef.current = {
      query: targetQuery,
      target: { cursors: meta.cursors, index: meta.index },
      isRefresh,
    };

    setError(undefined);
    setRefreshWarning(undefined);
    setLoading(true);

    try {
      const params = new URLSearchParams({ limit: "25" });
      for (const key of ["action", "objectType", "actorUsername", "requestId", "outcome"] as const) {
        if (targetQuery[key].trim()) params.set(key, targetQuery[key].trim());
      }
      if (isOperations && targetQuery.domain.trim()) params.set("domain", targetQuery.domain.trim());
      if (isOperations && targetQuery.objectId.trim()) params.set("objectId", targetQuery.objectId.trim());
      const fromIso = beijingLocalToIso(targetQuery.from);
      const toIso = beijingLocalToIso(targetQuery.to);
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      if (cursor) params.set("cursor", cursor);

      const endpoint = isOperations ? "/security/audit/operations" : "/security/audit/events";
      const result = await adminRequest<AuditResponse>(`${endpoint}?${params.toString()}`);
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current !== seq) return;

      if (!result || typeof result !== "object" || !Array.isArray(result.events)) {
        throw new Error("服务端返回格式错误：缺少必需的 events 列表");
      }

      setEvents(result.events);
      setScope(result.scope);
      pageRef.current = { cursors: meta.cursors, index: meta.index, nextCursor: result.nextCursor ?? null };
      setPage(pageRef.current);
      setSubmittedQuery(targetQuery);
      submittedQueryRef.current = targetQuery;
      setHasLoadedOnce(true);
      setError(undefined);
      setRefreshWarning(undefined);
      // F2: 仅在当前有效序号/上下文的成功响应到达后解除403拦截
      setIsForbidden(false);

      lastSuccessRef.current = {
        queryKey: targetQueryKey,
        index: meta.index,
        events: result.events,
        scope: result.scope,
        nextCursor: result.nextCursor ?? null,
      };
    } catch (failure) {
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current !== seq) return;
      setHasLoadedOnce(true);

      if (failure instanceof AdminApiError && failure.status === 403) {
        setIsForbidden(true);
        setEvents([]);
        setScope(undefined);
        lastSuccessRef.current = null;
        setError(friendlyError(failure));
        return;
      }

      const errMessage =
        failure instanceof Error && failure.message.startsWith("服务端返回格式错误")
          ? failure.message
          : friendlyError(failure);

      if (isRefresh && lastSuccessRef.current) {
        setRefreshWarning(errMessage);
        setEvents(lastSuccessRef.current.events);
        setScope(lastSuccessRef.current.scope);
      } else {
        setEvents([]);
        setScope(undefined);
        setError(errMessage);
        lastSuccessRef.current = null;
      }
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current === seq) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (canRead) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, contextKey, refreshNonce]);

  // B3: 同 tab 复用时 URL query 变化回填筛选表单。
  useEffect(() => {
    const queryChanged = previousQueryKeyRef.current !== initialQueryKey;
    previousQueryKeyRef.current = initialQueryKey;
    setDraft(queryFrom(initialQuery));
    if (queryChanged && draftQueryKeyRef.current !== initialQueryKey) {
      seqRef.current += 1;
      pageRef.current = emptyPage();
      setPage(pageRef.current);
      setEvents([]);
      setScope(undefined);
      setError(undefined);
      setRefreshWarning(undefined);
      lastSuccessRef.current = null;
      lastAttemptRef.current = null;
      const syncedQuery = queryFrom(initialQuery);
      setSubmittedQuery(syncedQuery);
      submittedQueryRef.current = syncedQuery;
      if (canRead) {
        void load({ query: syncedQuery, target: { cursors: [null], index: 0 }, isRefresh: false });
      }
    }
  }, [initialQueryKey]);

  if (!canRead || isForbidden) {
    return <section className="section-panel"><StatusMessage tone="warning" error={isOperations ? "操作日志仅 Boss 可查看。" : "当前账号没有账号与权限审计读取权限。普通账号读取权限不自动包含此权限。"} /></section>;
  }

  const navigate = (kind: "prev" | "next" | "first") => {
    const meta = pageRef.current;
    let cursors = meta.cursors;
    let index = meta.index;
    if (kind === "next") {
      if (!meta.nextCursor) return;
      cursors = [...meta.cursors.slice(0, meta.index + 1), meta.nextCursor];
      index = meta.index + 1;
    } else if (kind === "prev") {
      if (meta.index === 0) return;
      index = meta.index - 1;
    } else {
      index = 0;
    }
    if (index === meta.index) return;
    void load({ query: submittedQueryRef.current, target: { cursors, index }, isRefresh: false });
  };

  const handleClearFilters = () => {
    const emptyFilters = queryFrom(undefined);
    setDraft(emptyFilters);
    setSubmittedQuery(emptyFilters);
    submittedQueryRef.current = emptyFilters;
    onQueryChange?.({});
    void load({ query: emptyFilters, target: { cursors: [null], index: 0 }, isRefresh: false });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = queryFrom(draft);
    setSubmittedQuery(nextQuery);
    submittedQueryRef.current = nextQuery;
    onQueryChange?.(cleanQuery(nextQuery));
    void load({ query: nextQuery, target: { cursors: [null], index: 0 } });
  };

  const retryLast = () => {
    if (lastAttemptRef.current) {
      void load(lastAttemptRef.current);
    } else {
      void load({ query: submittedQueryRef.current, target: pageRef.current });
    }
  };

  const actionItems = isOperations ? null : ACCOUNT_ACTION_ITEMS;
  const objectItems = isOperations ? OPERATION_OBJECT_ITEMS : ACCOUNT_OBJECT_ITEMS;
  const timeInvalid = Boolean(draft.from && draft.to && beijingLocalToIso(draft.from) > beijingLocalToIso(draft.to));
  const draftHasFilters = hasActiveFilters(draft) || hasActiveFilters(submittedQuery);
  const selectField = (key: keyof AuditFilterQuery, label: string, items: { value: string; label: string }[]) => (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground block">{label}</span>
      <Select name={key} value={draft[key] || "ALL"} onValueChange={(next) => setField(key, next && next !== "ALL" ? String(next) : "")} items={items}>
        <SelectTrigger aria-label={label} className="h-9 w-full text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
  const textField = (key: keyof AuditFilterQuery, label: string, placeholder?: string) => (
    <label className="space-y-1 text-xs"><span className="text-muted-foreground block">{label}</span><Input name={key} value={draft[key]} onChange={(event) => setField(key, event.target.value)} className={inputClass} placeholder={placeholder} /></label>
  );
  const timeField = (key: "from" | "to", label: string) => (
    <label className="space-y-1 text-xs"><span className="text-muted-foreground block">{label}（北京时间）</span><Input type="datetime-local" name={key} value={draft[key]} onChange={(event) => setField(key, event.target.value)} className={inputClass} aria-invalid={timeInvalid || undefined} /></label>
  );
  const columns = ["时间（北京时间）", "操作者", "操作", "对象", "结果", isOperations ? "详情" : "详情"];

  return (
    <TooltipProvider>
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>{isOperations ? "操作日志" : "账号与权限审计"}</h3>
            <p>{isOperations
              ? "后台全部操作记录，仅供查看。敏感字段已由服务端隐藏。"
              : "查看账号、角色、授权、登录安全与会话相关的操作记录。审批记录请在「审批与审计」中查看。"}</p>
          </div>
          <Icons.Shield size={20} className="text-muted-foreground" />
        </div>
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-4" noValidate>
          {isOperations ? selectField("domain", "业务域", DOMAIN_ITEMS) : null}
          {isOperations ? textField("action", "操作代码", "如 admin.frozen") : selectField("action", "操作类型", actionItems ?? [])}
          {selectField("objectType", "对象类型", objectItems)}
          {selectField("outcome", "结果", OUTCOME_ITEMS)}
          {textField("actorUsername", "操作者账号", "如 ZZ00001")}
          {isOperations ? textField("objectId", "对象编号") : null}
          {textField("requestId", "请求编号")}
          {timeField("from", "开始时间")}
          {timeField("to", "结束时间")}
          <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-4">
            <Button type="submit" size="sm" variant="secondary" className="w-24 justify-center" loading={loading} disabled={timeInvalid}>查询</Button>
            {draftHasFilters ? <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={handleClearFilters}>清除筛选</Button> : null}
            {timeInvalid ? <span className="text-[11px] text-destructive">开始时间不能晚于结束时间</span> : null}
          </div>
        </form>
        <p className="text-[11px] text-muted-foreground mt-3">查看范围：{scopeLabel(scope)}。记录只能查看，不能修改或删除。</p>
      </section>

      <section className="section-panel">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold">{isOperations ? "操作记录" : "审计记录"}</h3>
          <span className="text-[11px] text-muted-foreground">
            {loading && !hasLoadedOnce ? (
              "正在读取…"
            ) : error ? (
              <span className="text-destructive">读取失败</span>
            ) : refreshWarning ? (
              <span className="text-amber-600 dark:text-amber-400">本页 {events.length} 条（未更新）</span>
            ) : loading ? (
              "正在刷新…"
            ) : (
              `本页 ${events.length} 条`
            )}
          </span>
        </div>

        {refreshWarning ? (
          <Alert variant="warning" role="status" className="mb-4">
            <AlertTriangleIcon className="size-4" />
            <AlertTitle>数据未更新</AlertTitle>
            <AlertDescription>刷新失败：当前展示为上次成功获取的内容（未能更新）。{refreshWarning}</AlertDescription>
            <AlertAction>
              <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={retryLast}>重新刷新</Button>
            </AlertAction>
          </Alert>
        ) : null}

        {loading && !hasLoadedOnce ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map((column) => <th key={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td><Skeleton className="h-4 w-24" /></td>
                    <td><Skeleton className="h-4 w-28" /></td>
                    <td><Skeleton className="h-4 w-36" /></td>
                    <td><Skeleton className="h-4 w-32" /></td>
                    <td><Skeleton className="h-4 w-16" /></td>
                    <td><Skeleton className="h-4 w-20" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : error ? (
          <EmptyState
            icon={<AlertCircleIcon className="size-5 text-destructive" />}
            title="审计记录读取失败"
            description={error}
            action={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={loading}
                onClick={retryLast}
              >
                重试
              </Button>
            }
            className="my-4 py-8"
          />
        ) : events.length === 0 ? (
          page.index > 0 ? (
            <EmptyState
              icon={<InboxIcon className="size-5" />}
              title="当前页暂无记录"
              description="该页游标下没有更多审计事件，您可以返回上一页或回到第一页。"
              action={
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={loading}
                    onClick={() => navigate("prev")}
                  >
                    返回上一页
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={loading}
                    onClick={() => navigate("first")}
                  >
                    回到首页
                  </Button>
                </div>
              }
              className="my-4 py-8"
            />
          ) : hasActiveFilters(submittedQuery) ? (
            <EmptyState
              icon={<SearchXIcon className="size-5" />}
              title="当前筛选无匹配记录"
              description="没有找到符合当前筛选条件的审计事件，请调整或清除筛选条件。"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={loading}
                  onClick={handleClearFilters}
                >
                  清除筛选
                </Button>
              }
              className="my-4 py-8"
            />
          ) : (
            <EmptyState
              icon={<InboxIcon className="size-5" />}
              title="当前可见范围暂无账号与权限事件"
              description="当前登录账号可见范围内暂未记录任何账号与权限变更事件。"
              className="my-4 py-8"
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    {columns.map((column) => <th key={column}>{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {events.map((item) => (
                    <tr key={item.eventId} className={isOperations ? "cursor-pointer hover:bg-muted/40" : undefined} onClick={isOperations ? () => setSelected(item) : undefined}>
                      <td className="whitespace-nowrap tabular-nums">{formatBeijing(item.occurredAt)}</td>
                      <td>{item.actor.displayUsername || item.actor.username !== "系统" ? <Hint hint={`账号：${item.actor.displayUsername ?? item.actor.username}`}>{actorText(item.actor)}</Hint> : actorText(item.actor)}</td>
                      <td><Hint hint={`操作代码：${item.action}`}>{labelForAction(item.action)}</Hint></td>
                      <td className="max-w-56"><ObjectCell event={item} /></td>
                      <td>
                        <InlineStatus tone={item.outcome === "SUCCESS" ? "success" : "error"}>{item.outcome === "SUCCESS" ? "成功" : "失败"}</InlineStatus>
                        {item.reason ? <span className="block text-[11px] text-muted-foreground mt-1">{item.reason}</span> : null}
                      </td>
                      <td className="max-w-xs">
                        {isOperations ? (
                          <Button type="button" size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setSelected(item); }}>查看详情</Button>
                        ) : (
                          <details className="text-[11px] text-muted-foreground">
                            <summary className="cursor-pointer select-none rounded focus-visible:outline-2 focus-visible:outline-ring">详情</summary>
                            <div className="mt-1"><DetailList details={item.details} /></div>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!page.nextCursor ? (
              <EndOfFeed
                title="当前查询没有更多记录"
                description="已到达本次查询的末尾。新事件发生时将按时间逆序记录。"
              />
            ) : null}

            <div className="flex items-center justify-end gap-2 mt-4">
              <span className="text-[11px] text-muted-foreground">第 {page.index + 1} 页</span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={loading || page.index === 0}
                onClick={() => navigate("prev")}
              >
                上一页
              </Button>
              {page.index > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={loading}
                  onClick={() => navigate("first")}
                >
                  回到首页
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={loading || !page.nextCursor}
                onClick={() => navigate("next")}
              >
                下一页
              </Button>
            </div>
          </>
        )}
      </section>
      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent side="right" closeLabel="关闭" className="w-full overflow-y-auto sm:max-w-md">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{labelForAction(selected.action)}</SheetTitle>
                <SheetDescription>{formatBeijing(selected.occurredAt)}（北京时间）</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6 text-xs">
                <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2">
                  <dt className="text-muted-foreground">业务域</dt><dd>{DOMAIN_LABELS[domainOf(selected.action)] ?? domainOf(selected.action)}</dd>
                  <dt className="text-muted-foreground">操作代码</dt><dd className="font-mono break-all">{selected.action}</dd>
                  <dt className="text-muted-foreground">操作者</dt><dd>{actorText(selected.actor)}{selected.actor.displayUsername ? `（${selected.actor.displayUsername}）` : ""}</dd>
                  <dt className="text-muted-foreground">对象</dt><dd><ObjectCell event={selected} /></dd>
                  <dt className="text-muted-foreground">结果</dt><dd><InlineStatus tone={selected.outcome === "SUCCESS" ? "success" : "error"}>{selected.outcome === "SUCCESS" ? "成功" : "失败"}</InlineStatus>{selected.reason ? <span className="ml-2 text-muted-foreground">{selected.reason}</span> : null}</dd>
                  <dt className="text-muted-foreground">请求编号</dt><dd className="flex items-center gap-1">{selected.requestId ? <><span className="font-mono truncate">{selected.requestId}</span><CopyId value={selected.requestId} label="请求编号" /></> : "—"}</dd>
                </dl>
                <div>
                  <h4 className="mb-2 text-xs font-semibold">详情（敏感字段已隐藏）</h4>
                  <DetailList details={selected.details} />
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
    </TooltipProvider>
  );
}
