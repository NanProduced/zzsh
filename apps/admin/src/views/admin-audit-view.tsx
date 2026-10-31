import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  InboxIcon,
  SearchXIcon,
} from "lucide-react";

import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import { EmptyState, EndOfFeed } from "../components/empty-state";
import { Skeleton } from "../components/ui/skeleton";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AdminApiError,
  adminRequest,
  formatDate,
  friendlyError,
  hasPermission,
  type SessionSnapshot,
} from "../api";

type AuditEvent = {
  eventId: string;
  actor: { username: string; displayUsername?: string; name: string };
  action: string;
  objectType: string;
  objectId: string | null;
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
};

const actions = [
  "admin.account.created",
  "admin.account.updated",
  "admin.permission.assigned",
  "admin.game_scope.assigned",
  "admin.role.created",
  "admin.role.updated",
  "admin.frozen",
  "admin.unfrozen",
  "admin.session.force_logged_out",
  "user.account.restored",
  "user.account.frozen",
  "user.account.unfrozen",
];

const ACTION_LABELS: Record<string, string> = {
  "admin.account.created": "创建管理员",
  "admin.account.updated": "修改管理员",
  "admin.permission.assigned": "调整个人权限",
  "admin.game_scope.assigned": "调整游戏范围",
  "admin.role.created": "创建角色",
  "admin.role.updated": "修改角色",
  "admin.frozen": "冻结管理员",
  "admin.unfrozen": "解除冻结",
  "admin.session.force_logged_out": "撤销会话",
  "user.account.restored": "恢复用户账号（已退役）",
  "user.account.frozen": "冻结用户",
  "user.account.unfrozen": "解冻用户",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function actorLabel(actor: AuditEvent["actor"]): string {
  return `${actor.name}（${actor.displayUsername ?? actor.username}）`;
}

function objectLabel(event: AuditEvent): string {
  const names: Record<string, string> = {
    admin_user: "管理员账号",
    admin_role: "管理员角色",
    admin_security: "账号安全状态",
    user_account: "用户账号",
  };
  return `${names[event.objectType] ?? event.objectType}${event.objectId ? ` · ${event.objectId}` : ""}`;
}

function scopeLabel(scope: string | undefined): string {
  if (scope === "BOSS_ALL_GENERIC_ADMIN_AUDIT") return "Boss：全部账号与权限审计白名单事件";
  if (scope === "SELF_TARGET_AND_ROLE_ACTIONS") return "当前账号：自身对象及本人角色操作事件";
  return "已按当前账号的对象范围过滤";
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
  return Boolean(
    query.action ||
    query.objectType ||
    query.actorUsername.trim() ||
    query.requestId.trim()
  );
}

function queryKeyOf(query: AuditFilterQuery | Record<string, string> | undefined): string {
  return JSON.stringify(["action", "objectType", "actorUsername", "requestId"].map((key) => [
    key,
    (query as Record<string, string> | undefined)?.[key]?.trim() ?? "",
  ]));
}

export function AdminAuditView({
  snapshot,
  initialQuery,
  onQueryChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialQuery?: Record<string, string>;
  onQueryChange?: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const canRead = hasPermission(snapshot, "admin.audit.read");
  const contextKey = contextKeyOf(snapshot);
  const contextKeyRef = useRef(contextKey);
  const contextEpochRef = useRef(0);
  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    contextEpochRef.current += 1;
  }
  const contextEpoch = contextEpochRef.current;

  const [action, setAction] = useState(initialQuery?.action ?? "");
  const [objectType, setObjectType] = useState(initialQuery?.objectType ?? "");
  const [actorUsername, setActorUsername] = useState(initialQuery?.actorUsername ?? "");
  const [requestId, setRequestId] = useState(initialQuery?.requestId ?? "");

  const [submittedQuery, setSubmittedQuery] = useState<AuditFilterQuery>(() => ({
    action: initialQuery?.action ?? "",
    objectType: initialQuery?.objectType ?? "",
    actorUsername: initialQuery?.actorUsername?.trim() ?? "",
    requestId: initialQuery?.requestId?.trim() ?? "",
  }));
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
  draftQueryKeyRef.current = queryKeyOf({ action, objectType, actorUsername, requestId });

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
      if (targetQuery.action) params.set("action", targetQuery.action);
      if (targetQuery.objectType) params.set("objectType", targetQuery.objectType);
      if (targetQuery.actorUsername.trim()) params.set("actorUsername", targetQuery.actorUsername.trim());
      if (targetQuery.requestId.trim()) params.set("requestId", targetQuery.requestId.trim());
      if (cursor) params.set("cursor", cursor);

      const result = await adminRequest<AuditResponse>(`/security/audit/events?${params.toString()}`);
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
    setAction(initialQuery?.action ?? "");
    setObjectType(initialQuery?.objectType ?? "");
    setActorUsername(initialQuery?.actorUsername ?? "");
    setRequestId(initialQuery?.requestId ?? "");
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
      const syncedQuery: AuditFilterQuery = {
        action: initialQuery?.action ?? "",
        objectType: initialQuery?.objectType ?? "",
        actorUsername: initialQuery?.actorUsername?.trim() ?? "",
        requestId: initialQuery?.requestId?.trim() ?? "",
      };
      setSubmittedQuery(syncedQuery);
      submittedQueryRef.current = syncedQuery;
      if (canRead) {
        void load({ query: syncedQuery, target: { cursors: [null], index: 0 }, isRefresh: false });
      }
    }
  }, [initialQueryKey]);

  if (!canRead || isForbidden) {
    return <section className="section-panel"><StatusMessage tone="warning" error="当前账号没有账号与权限审计读取权限。普通账号读取权限不自动包含此权限。" /></section>;
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
    setAction("");
    setObjectType("");
    setActorUsername("");
    setRequestId("");
    const emptyFilters: AuditFilterQuery = {
      action: "",
      objectType: "",
      actorUsername: "",
      requestId: "",
    };
    setSubmittedQuery(emptyFilters);
    submittedQueryRef.current = emptyFilters;
    onQueryChange?.({});
    void load({ query: emptyFilters, target: { cursors: [null], index: 0 }, isRefresh: false });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery: AuditFilterQuery = {
      action,
      objectType,
      actorUsername: actorUsername.trim(),
      requestId: requestId.trim(),
    };
    setSubmittedQuery(nextQuery);
    submittedQueryRef.current = nextQuery;
    const clean: Record<string, string> = {};
    if (nextQuery.action) clean.action = nextQuery.action;
    if (nextQuery.objectType) clean.objectType = nextQuery.objectType;
    if (nextQuery.actorUsername) clean.actorUsername = nextQuery.actorUsername;
    if (nextQuery.requestId) clean.requestId = nextQuery.requestId;
    onQueryChange?.(clean);
    void load({ query: nextQuery, target: { cursors: [null], index: 0 } });
  };

  const retryLast = () => {
    if (lastAttemptRef.current) {
      void load(lastAttemptRef.current);
    } else {
      void load({ query: submittedQueryRef.current, target: pageRef.current });
    }
  };

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>账号与权限审计</h3>
            <p>只读查询账号、角色、授权、会话撤销与用户恢复事件；审批事件另在“审批与审计”中查看。敏感字段由服务端裁剪。</p>
          </div>
          <Icons.Shield size={20} className="text-muted-foreground" />
        </div>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-4" noValidate>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作类型</span><select value={action} onChange={(event) => setAction(event.target.value)} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="">全部</option>{actions.map((item) => <option key={item} value={item}>{actionLabel(item)}</option>)}</select></label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">对象类型</span><select value={objectType} onChange={(event) => setObjectType(event.target.value)} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="">全部</option><option value="admin_user">管理员账号</option><option value="admin_security">账号安全状态</option><option value="admin_role">管理员角色</option><option value="user_account">用户账号</option></select></label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作者账号</span><input value={actorUsername} onChange={(event) => setActorUsername(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="如 ZZ00001" /></label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">请求编号（可选）</span><input value={requestId} onChange={(event) => setRequestId(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs" /></label>
          <Button type="submit" size="sm" loading={loading}>查询审计</Button>
        </form>
        <p className="text-[11px] text-muted-foreground mt-3">查询范围：{scopeLabel(scope)}。结果仅供核查，审计记录不提供修改或删除入口。</p>
      </section>

      <section className="section-panel">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-sm font-semibold">审计记录</h3>
          <span className="text-[11px] text-muted-foreground">
            {loading && !hasLoadedOnce ? (
              "正在读取…"
            ) : error ? (
              <span className="text-destructive">读取失败</span>
            ) : refreshWarning ? (
              <span className="text-amber-600 dark:text-amber-400">{events.length} 条（未更新）</span>
            ) : loading ? (
              "正在刷新…"
            ) : (
              `${events.length} 条`
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
                  <th>时间</th>
                  <th>操作者</th>
                  <th>操作</th>
                  <th>对象摘要</th>
                  <th>结果 / 原因</th>
                  <th>安全详情</th>
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
                    <th>时间</th>
                    <th>操作者</th>
                    <th>操作</th>
                    <th>对象摘要</th>
                    <th>结果 / 原因</th>
                    <th>安全详情</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((item) => (
                    <tr key={item.eventId}>
                      <td className="whitespace-nowrap">{formatDate(item.occurredAt)}</td>
                      <td>{actorLabel(item.actor)}</td>
                      <td><div>{actionLabel(item.action)}</div><div className="font-mono text-[10px] text-muted-foreground">{item.action}</div></td>
                      <td>{objectLabel(item)}</td>
                      <td>
                        <span className={item.outcome === "SUCCESS" ? "text-emerald-400" : "text-rose-400"}>
                          {item.outcome === "SUCCESS" ? "成功" : "失败"}
                        </span>
                        {item.reason ? <span className="block text-[11px] text-muted-foreground mt-1">{item.reason}</span> : null}
                      </td>
                      <td className="max-w-xs">
                        <details className="text-[11px] text-muted-foreground">
                          <summary className="cursor-pointer select-none">安全详情</summary>
                          <pre className="whitespace-pre-wrap break-words mt-1">{JSON.stringify(item.details)}</pre>
                        </details>
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
    </div>
  );
}
