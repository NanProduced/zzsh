import { useEffect, useRef, useState, type FormEvent } from "react";

import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import { adminRequest, formatDate, friendlyError, hasPermission, type SessionSnapshot } from "../api";

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

const actions = [
  "admin.account.created",
  "admin.account.updated",
  "admin.permission.assigned",
  "admin.role.created",
  "admin.role.updated",
  "admin.frozen",
  "admin.unfrozen",
  "admin.session.force_logged_out",
  "user.account.restored",
];

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

function queryKeyOf(query: Record<string, string> | undefined): string {
  return JSON.stringify(["action", "objectType", "actorUsername", "requestId"].map((key) => [key, query?.[key]?.trim() ?? ""]));
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
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [page, setPage] = useState<CursorPage>(emptyPage);
  const [scope, setScope] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
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
    setLoading(false);
  }, [contextKey]);

  const load = async (target?: { cursors: (string | null)[]; index: number }) => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return;
    const meta = target ? { cursors: target.cursors, index: target.index, nextCursor: pageRef.current.nextCursor } : pageRef.current;
    const cursor = meta.cursors[meta.index];
    const seq = ++seqRef.current;
    setError(undefined);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (action) params.set("action", action);
      if (objectType) params.set("objectType", objectType);
      if (actorUsername.trim()) params.set("actorUsername", actorUsername.trim());
      if (requestId.trim()) params.set("requestId", requestId.trim());
      if (cursor) params.set("cursor", cursor);
      const result = await adminRequest<AuditResponse>(`/security/audit/events?${params.toString()}`);
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current !== seq) return;
      setEvents(result.events ?? []);
      setScope(result.scope);
      pageRef.current = { cursors: meta.cursors, index: meta.index, nextCursor: result.nextCursor ?? null };
      setPage(pageRef.current);
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current === seq) setError(friendlyError(failure));
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current === seq) setLoading(false);
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
    }
  }, [initialQueryKey]);

  if (!canRead) {
    return <section className="section-panel"><StatusMessage error="当前账号没有账号与权限审计读取权限。普通账号读取权限不自动包含此权限。" /></section>;
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
    void load({ cursors, index });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onQueryChange?.({
      ...(action ? { action } : {}),
      ...(objectType ? { objectType } : {}),
      ...(actorUsername.trim() ? { actorUsername: actorUsername.trim() } : {}),
      ...(requestId.trim() ? { requestId: requestId.trim() } : {}),
    });
    void load({ cursors: [null], index: 0 });
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
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作类型</span><select value={action} onChange={(event) => setAction(event.target.value)} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="">全部</option>{actions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">对象类型</span><select value={objectType} onChange={(event) => setObjectType(event.target.value)} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="">全部</option><option value="admin_user">管理员账号</option><option value="admin_security">账号安全状态</option><option value="admin_role">管理员角色</option><option value="user_account">用户账号</option></select></label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作者账号</span><input value={actorUsername} onChange={(event) => setActorUsername(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="如 ZZ00001" /></label>
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">请求编号（可选）</span><input value={requestId} onChange={(event) => setRequestId(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs" /></label>
          <Button type="submit" size="sm" loading={loading}>查询审计</Button>
        </form>
        <StatusMessage error={error} className="mt-4" />
        <p className="text-[11px] text-muted-foreground mt-3">查询范围：{scopeLabel(scope)}。结果仅供核查，审计记录不提供修改或删除入口。</p>
      </section>

      <section className="section-panel">
        <div className="flex items-center justify-between gap-3 mb-3"><h3 className="text-sm font-semibold">审计记录</h3><span className="text-[11px] text-muted-foreground">{loading ? "正在读取…" : `${events.length} 条`}</span></div>
        {events.length === 0 && !loading ? <p className="text-xs text-muted-foreground py-6 text-center">暂无符合条件的账号与权限事件。</p> : (
          <div className="table-wrap">
            <table className="data-table"><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象摘要</th><th>结果 / 原因</th><th>安全详情</th></tr></thead><tbody>
              {events.map((item) => <tr key={item.eventId}><td className="whitespace-nowrap">{formatDate(item.occurredAt)}</td><td>{actorLabel(item.actor)}</td><td className="font-mono text-[11px]">{item.action}</td><td>{objectLabel(item)}</td><td><span className={item.outcome === "SUCCESS" ? "text-emerald-400" : "text-rose-400"}>{item.outcome === "SUCCESS" ? "成功" : "失败"}</span>{item.reason ? <span className="block text-[11px] text-muted-foreground mt-1">{item.reason}</span> : null}</td><td className="max-w-xs"><details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer select-none">安全详情</summary><pre className="whitespace-pre-wrap break-words mt-1">{JSON.stringify(item.details)}</pre></details></td></tr>)}
            </tbody></table>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 mt-4">
          <span className="text-[11px] text-muted-foreground">第 {page.index + 1} 页</span>
          <Button type="button" size="sm" variant="secondary" disabled={loading || page.index === 0} onClick={() => navigate("prev")}>上一页</Button>
          {page.index > 0 ? <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => navigate("first")}>回到首页</Button> : null}
          <Button type="button" size="sm" variant="secondary" disabled={loading || !page.nextCursor} onClick={() => navigate("next")}>下一页</Button>
        </div>
      </section>
    </div>
  );
}
