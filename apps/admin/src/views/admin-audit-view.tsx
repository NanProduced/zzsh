import { BeijingDateTimeField } from "@/components/beijing-datetime-field";
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
import { AuditRetentionPanel } from "./audit-retention-panel";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { EmptyState, EndOfFeed } from "../components/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { InlineStatus } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { ActionTooltip } from "../components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
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
    <ActionTooltip content={copied ? "已复制" : `${label}：${value}`} className="break-all font-mono">
      <button type="button" aria-label={`复制${label}`} className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}>
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    </ActionTooltip>
  );
}

function Hint({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <ActionTooltip content={hint} className="break-all font-mono">
      <span className="cursor-help rounded underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">{children}</span>
    </ActionTooltip>
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
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">无附加详情</p>;
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
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
const OPERATION_OBJECT_ITEMS = [ALL, ...[
  "admin_user", "admin_security", "admin_role", "admin_session", "admin_auth_subject", "admin_recovery_request",
  "user_account", "user", "auth_account", "approval_request", "approval_template",
  "rental_order", "rental_account", "payment_request", "content_resource", "credit_event", "distribution_participant", "im_consultation",
].map((value) => ({ value, label: objectTypeLabel(value) }))];
const inputClass = "h-9 w-full text-xs max-xl:h-10";

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedKeys = isOperations ? (["action", "objectType", "objectId", "requestId"] as const) : (["objectType", "requestId"] as const);
  const advancedActive = advancedKeys.filter((key) => draft[key].trim()).length;
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
    setAdvancedOpen(false);
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
  const fieldClass = (advanced = false, full = false) => [
    advanced && !advancedOpen ? "max-xl:hidden" : "",
    full ? "col-span-2 xl:col-span-1" : "",
  ].filter(Boolean).join(" ");
  const selectField = (key: keyof AuditFilterQuery, label: string, items: { value: string; label: string }[], options: { advanced?: boolean; full?: boolean } = {}) => (
    <label className={`space-y-1 text-xs ${fieldClass(options.advanced, options.full)}`}>
      <span className="text-muted-foreground block">{label}</span>
      <Select name={key} value={draft[key] || "ALL"} onValueChange={(next) => setField(key, next && next !== "ALL" ? String(next) : "")} items={items}>
        <SelectTrigger aria-label={label} className="h-9 w-full text-xs max-xl:min-h-10"><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
  const textField = (key: keyof AuditFilterQuery, label: string, placeholder?: string, options: { advanced?: boolean; full?: boolean } = {}) => (
    <label className={`space-y-1 text-xs ${fieldClass(options.advanced, options.full)}`}><span className="text-muted-foreground block">{label}</span><Input name={key} value={draft[key]} onChange={(event) => setField(key, event.target.value)} className={inputClass} placeholder={placeholder} /></label>
  );
  const timeField = (key: "from" | "to", label: string) => (
    <div className={fieldClass(false, true)}><BeijingDateTimeField label={label} value={draft[key]} onChange={(value) => setField(key, value)} invalid={timeInvalid} /></div>
  );
  const columns = ["时间（北京时间）", "操作者", "操作", "对象", "结果", ...(isOperations ? ["详情"] : [])];

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h1 className="m-0 mb-1 text-base font-semibold text-foreground">{isOperations ? "操作日志" : "账号与权限审计"}</h1>
            <p>{isOperations
              ? "后台全部操作记录，仅供查看。敏感字段已由服务端隐藏。"
              : "查看账号、角色、授权、登录安全与会话相关的操作记录。审批记录请在「审批与审计」中查看。"}</p>
          </div>
          <Icons.Shield size={20} className="text-muted-foreground" />
        </div>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3 mt-4 sm:grid-cols-2 xl:grid-cols-4" noValidate>
          {isOperations ? selectField("domain", "业务域", DOMAIN_ITEMS) : null}
          {isOperations ? textField("action", "操作代码", "如 admin.frozen", { advanced: true, full: true }) : selectField("action", "操作类型", actionItems ?? [])}
          {selectField("objectType", "对象类型", objectItems, { advanced: true })}
          {selectField("outcome", "结果", OUTCOME_ITEMS)}
          {textField("actorUsername", "操作者账号", "如 ZZ00001", { full: true })}
          {isOperations ? textField("objectId", "对象编号", undefined, { advanced: true, full: true }) : null}
          {textField("requestId", "请求编号", undefined, { advanced: true, full: true })}
          {timeField("from", "开始时间")}
          {timeField("to", "结束时间")}
          <div className="flex flex-wrap items-center gap-2 col-span-2 xl:col-span-4">
            <Button type="submit" size="sm" variant="secondary" className="w-24 justify-center max-xl:min-h-11" loading={loading} disabled={timeInvalid}>查询</Button>
            <Button type="button" size="sm" variant="ghost" className="max-xl:min-h-11 xl:hidden" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>
              {advancedOpen ? "收起筛选" : `更多筛选${advancedActive ? `（${advancedActive}）` : ""}`}
            </Button>
            {draftHasFilters ? <Button type="button" size="sm" variant="ghost" className="max-xl:min-h-11" disabled={loading} onClick={handleClearFilters}>清除筛选</Button> : null}
            {timeInvalid ? <span className="text-xs text-destructive">开始时间不能晚于结束时间</span> : null}
          </div>
        </form>
        <p className="text-xs text-muted-foreground mt-3">查看范围：{scopeLabel(scope)}。记录只能查看，不能修改或删除。</p>
      </section>

      <section className="section-panel">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold">{isOperations ? "操作记录" : "审计记录"}</h3>
          <span className="text-xs text-muted-foreground">
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
          <>
            <div className="table-wrap hidden xl:block">
              <table className="data-table">
                <thead>
                  <tr>
                    {columns.map((column) => <th key={column} scope="col">{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {columns.map((column) => <td key={column}><Skeleton className="h-4 w-24" /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-4 xl:hidden">
              {Array.from({ length: 5 }).map((_, i) => <div key={i} className="space-y-2 border-b border-border/60 pb-3"><Skeleton className="h-3 w-32" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>)}
            </div>
          </>
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
            <div className="table-wrap hidden xl:block">
              <table className="data-table" style={{ tableLayout: "fixed" }}>
                <colgroup>
                  {isOperations ? <>
                    <col style={{ width: "15%" }} /><col style={{ width: "15%" }} /><col style={{ width: "27%" }} />
                    <col style={{ width: "18%" }} /><col style={{ width: "10%" }} /><col style={{ width: "15%" }} />
                  </> : <>
                    <col style={{ width: "16%" }} /><col style={{ width: "18%" }} /><col style={{ width: "26%" }} />
                    <col style={{ width: "22%" }} /><col style={{ width: "18%" }} />
                  </>}
                </colgroup>
                <thead>
                  <tr>
                    {columns.map((column) => <th key={column} scope="col">{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {events.map((item) => (
                    <tr key={item.eventId} className={isOperations ? "cursor-pointer hover:bg-muted/40" : undefined} onClick={isOperations ? () => setSelected(item) : undefined}>
                      <td className="whitespace-nowrap tabular-nums">{formatBeijing(item.occurredAt)}</td>
                      <td className="whitespace-nowrap">{item.actor.displayUsername || item.actor.username !== "系统" ? <Hint hint={`账号：${item.actor.displayUsername ?? item.actor.username}`}>{actorText(item.actor)}</Hint> : actorText(item.actor)}</td>
                      <td><Hint hint={`操作代码：${item.action}`}>{labelForAction(item.action)}</Hint></td>
                      <td className="max-w-56"><ObjectCell event={item} /></td>
                      <td>
                        <InlineStatus tone={item.outcome === "SUCCESS" ? "success" : "error"}>{item.outcome === "SUCCESS" ? "成功" : "失败"}</InlineStatus>
                      </td>
                      {isOperations ? (
                        <td>
                          <Button type="button" size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setSelected(item); }}>查看详情</Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-border/60 xl:hidden">
              {events.map((item) => (
                <li key={item.eventId} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">{formatBeijing(item.occurredAt)}</span>
                    <InlineStatus tone={item.outcome === "SUCCESS" ? "success" : "error"}>{item.outcome === "SUCCESS" ? "成功" : "失败"}</InlineStatus>
                  </div>
                  <p className="mt-1 text-sm font-medium"><Hint hint={`操作代码：${item.action}`}>{labelForAction(item.action)}</Hint></p>
                  <div className="mt-1 text-xs text-muted-foreground"><ObjectCell event={item} /></div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{actorText(item.actor)}</span>
                    {isOperations ? <Button type="button" size="sm" variant="ghost" className="max-xl:min-h-11" onClick={() => setSelected(item)}>查看详情</Button> : null}
                  </div>
                </li>
              ))}
            </ul>

            {!page.nextCursor ? (
              <EndOfFeed
                title="当前查询没有更多记录"
                description="已到达本次查询的末尾。新事件发生时将按时间逆序记录。"
              />
            ) : null}

            <div className="flex items-center justify-end gap-2 mt-4">
              <span className="text-xs text-muted-foreground">第 {page.index + 1} 页</span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="max-xl:min-h-11"
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
                  className="max-xl:min-h-11"
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
                className="max-xl:min-h-11"
                disabled={loading || !page.nextCursor}
                onClick={() => navigate("next")}
              >
                下一页
              </Button>
            </div>
          </>
        )}
      </section>
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent size="lg" className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
          {selected ? (
            <>
              <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
                <DialogTitle className="break-words">{labelForAction(selected.action)}</DialogTitle>
                <DialogDescription>{formatBeijing(selected.occurredAt)}（北京时间）</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
                <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                  <dt className="text-muted-foreground">业务域</dt><dd>{DOMAIN_LABELS[domainOf(selected.action)] ?? "其他"}</dd>
                  <dt className="text-muted-foreground">操作代码</dt><dd className="font-mono break-all">{selected.action}</dd>
                  <dt className="text-muted-foreground">操作者</dt><dd>{actorText(selected.actor)}{selected.actor.displayUsername ? `（${selected.actor.displayUsername}）` : ""}</dd>
                  <dt className="text-muted-foreground">对象</dt><dd><ObjectCell event={selected} /></dd>
                  <dt className="text-muted-foreground">对象类型</dt><dd className="font-mono break-all">{selected.objectType}</dd>
                  {selected.objectId ? <><dt className="text-muted-foreground">对象编号</dt><dd className="flex items-center gap-1"><span className="font-mono break-all">{selected.objectId}</span><CopyId value={selected.objectId} label="对象编号" /></dd></> : null}
                  <dt className="text-muted-foreground">结果</dt><dd><InlineStatus tone={selected.outcome === "SUCCESS" ? "success" : "error"}>{selected.outcome === "SUCCESS" ? "成功" : "失败"}</InlineStatus></dd>
                  {selected.reason ? <><dt className="text-muted-foreground">服务端说明</dt><dd className="break-all">{selected.reason}</dd></> : null}
                  <dt className="text-muted-foreground">请求编号</dt><dd className="flex items-center gap-1">{selected.requestId ? <><span className="font-mono break-all">{selected.requestId}</span><CopyId value={selected.requestId} label="请求编号" /></> : "—"}</dd>
                </dl>
                <div>
                  <h4 className="mb-2 text-xs font-semibold">详情（敏感字段已隐藏）</h4>
                  <DetailList details={selected.details} />
                </div>
              </div>
              <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/60 bg-muted/30 px-5 py-3 sm:flex-row sm:justify-end">
                <Button type="button" size="sm" variant="secondary" className="max-xl:min-h-11" onClick={() => setSelected(null)}>关闭</Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      {isOperations && canRead ? <AuditRetentionPanel onPurged={() => navigate("first")} /> : null}
    </div>
  );
}
