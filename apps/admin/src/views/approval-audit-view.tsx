import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import {
  AdminApiError,
  adminRequest,
  formatDate,
  friendlyError,
  hasPermission,
  type AdminDirectoryEntry,
  type SessionSnapshot,
} from "../api";

type Candidate = {
  username: string;
  displayUsername?: string;
  name: string;
  status: string;
  eligible?: boolean;
  source?: string;
};

type Template = {
  id: string;
  operationCode: string;
  triggerCondition: string;
  version: number;
  updatedAt: string | null;
  candidates: Candidate[];
};

type RequestSummary = {
  requestId: string;
  operationCode: string;
  triggerCondition: string;
  payloadVersion: number;
  payloadHash: string;
  summary: string;
  status: string;
  statusReason: string | null;
  requester: { username: string; displayUsername?: string; name: string };
  createdAt: string | null;
  expiresAt: string | null;
};

type AuditEvent = {
  eventId: string;
  actor: { username: string; displayUsername?: string; name: string };
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  occurredAt: string | null;
  details: Record<string, unknown>;
};

type RequestDetail = RequestSummary & {
  operation: { code: string; triggerCondition: string; payloadVersion: number; payloadHash: string; payload?: Record<string, unknown> };
  template: { id: string; version: number };
  requester: { username: string; displayUsername?: string; name: string; status: string };
  decision: { decision: string; reason: string | null; approver: { username: string; displayUsername?: string; name: string }; createdAt: string | null } | null;
  execution: { status: string; resultCode: string; resultDetail: string | null; executor: { username: string; displayUsername?: string; name: string }; createdAt: string | null; completedAt: string | null } | null;
  candidates: Candidate[];
  history: AuditEvent[];
  supersedesRequestId: string | null;
  supersededByRequestId: string | null;
};

type ListKey = "mine" | "pending" | "audit";
type ListPage = { cursors: (string | null)[]; index: number; nextCursor: string | null };
type AuditFilter = { action: string; objectType: string; actorUsername: string; requestId: string };
type ConfirmKind = "approve" | "reject" | "execute" | "template";
type ReadbackTarget =
  | { kind: "templates" }
  | { kind: "lists"; keys: ListKey[] }
  | { kind: "detail-and-lists"; requestId: string; keys: ListKey[] };
type WriteIntent = {
  actorId: string;
  sessionId: string;
  objectKey: string;
  objectEpoch: number;
  contextKey: string;
  contextEpoch: number;
  path: string;
  method: "POST";
  body: Record<string, unknown>;
  idempotencyKey: string;
  successMessage: string;
  readback: ReadbackTarget;
  afterPost?: () => void;
};
type RecoveryState = { kind: "unknown" | "readback"; intent: WriteIntent };

const statusLabels: Record<string, string> = {
  PENDING: "待审批",
  APPROVED: "已同意，待执行",
  REJECTED: "已拒绝",
  CANCELLED: "已终止",
  EXPIRED: "已过期",
  EXECUTED: "已执行",
  EXECUTION_FAILED: "执行失败",
};

function emptyPageMeta(): Record<ListKey, ListPage> {
  return {
    mine: { cursors: [null], index: 0, nextCursor: null },
    pending: { cursors: [null], index: 0, nextCursor: null },
    audit: { cursors: [null], index: 0, nextCursor: null },
  };
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

function isUnknownWriteError(error: unknown): boolean {
  return error instanceof AdminApiError && (error.code === "NETWORK_ERROR" || error.status >= 500);
}

function statusLabel(value: string): string {
  return statusLabels[value] ?? value;
}

function statusTone(value: string): string {
  if (["EXECUTED", "APPROVED"].includes(value)) return "text-emerald-400";
  if (["REJECTED", "CANCELLED", "EXPIRED", "EXECUTION_FAILED"].includes(value)) return "text-rose-400";
  return "text-amber-300";
}

function personLabel(person: { name: string; displayUsername?: string; username: string }): string {
  return person.name + "（" + (person.displayUsername ?? person.username) + "）";
}

function prettyDetails(details: Record<string, unknown>): string {
  return Object.entries(details).map(([key, value]) => key + ": " + String(value)).join("；") || "无附加信息";
}

const emptyAuditFilter: AuditFilter = { action: "", objectType: "", actorUsername: "", requestId: "" };

const approvalAuditActions = [
  "approval.request.created",
  "approval.request.approved",
  "approval.request.rejected",
  "approval.request.cancelled",
  "approval.request.expired",
  "approval.request.candidate_added",
  "approval.execution.completed",
  "approval.template.configured",
];

const approvalAuditObjectTypes: Record<string, string> = {
  approval_request: "审批申请",
  approval_template: "审批模板",
};

const approvalAuditActionLabels: Record<string, string> = {
  "approval.request.created": "提交申请",
  "approval.request.approved": "审批同意",
  "approval.request.rejected": "审批拒绝",
  "approval.request.cancelled": "申请终止",
  "approval.request.expired": "申请过期",
  "approval.request.candidate_added": "追加审批人",
  "approval.execution.completed": "执行完成",
  "approval.template.configured": "配置审批模板",
};

function approvalAuditActionLabel(action: string): string {
  return approvalAuditActionLabels[action] ?? action;
}

function approvalAuditOutcomeLabel(outcome: string): string {
  return outcome === "SUCCESS" ? "成功" : outcome === "FAILURE" ? "失败" : outcome;
}

function auditNarrative(event: AuditEvent): string {
  if (event.reason) return event.reason;
  const summary = event.details?.summary;
  if (typeof summary === "string" && summary.trim()) return summary;
  return "无附加说明";
}

function auditFilterFromQuery(query: Record<string, string> | undefined): AuditFilter {
  return {
    action: query?.action ?? "",
    objectType: query?.objectType ?? "",
    actorUsername: query?.actorUsername ?? "",
    requestId: query?.requestId ?? "",
  };
}

function auditFilterKey(filter: AuditFilter): string {
  return JSON.stringify([filter.action, filter.objectType, filter.actorUsername.trim(), filter.requestId.trim()]);
}

function auditScopeLabel(scope: string | undefined): string {
  if (scope === "BOSS_ALL_APPROVAL_EVENTS") return "Boss：全部审批与授权事件";
  if (scope === "ACTOR_OR_REQUEST_SCOPE") return "当前账号：本人操作或本人相关申请的事件";
  return "已按当前账号范围过滤";
}

function relatedRequestIdOf(event: AuditEvent): string | null {
  // audit_event.request_id 是 HTTP 请求编号，不是审批申请；只有审批申请对象本身可跳转。
  return event.objectType === "approval_request" ? event.objectId : null;
}

function PagePager({ page, busy, onPrev, onNext, onFirst }: { page: ListPage; busy: boolean; onPrev: () => void; onNext: () => void; onFirst: () => void }) {
  return (
    <div className="flex items-center justify-end gap-2 mt-3">
      <span className="text-[11px] text-muted-foreground">第 {page.index + 1} 页</span>
      <Button type="button" size="sm" variant="secondary" disabled={busy || page.index === 0} onClick={onPrev}>上一页</Button>
      {page.index > 0 ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onFirst}>回到首页</Button> : null}
      <Button type="button" size="sm" variant="secondary" disabled={busy || !page.nextCursor} onClick={onNext}>下一页</Button>
    </div>
  );
}

export function ApprovalAuditView({
  snapshot,
  initialRequestId,
  initialTab,
  initialQuery,
  objectOnly = false,
  onOpenObject,
  onTabChange,
  onQueryChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialRequestId?: string;
  initialTab?: "mine" | "pending" | "templates" | "audit";
  initialQuery?: Record<string, string>;
  objectOnly?: boolean;
  onOpenObject?: (requestId: string, title: string) => void;
  onTabChange?: (tab: "mine" | "pending" | "templates" | "audit") => void;
  onQueryChange?: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const canTemplateRead = hasPermission(snapshot, "approval.template.read");
  const canTemplateConfigure = hasPermission(snapshot, "approval.template.configure");
  const canCreate = hasPermission(snapshot, "approval.request.create");
  const canRead = hasPermission(snapshot, "approval.request.read");
  const canApprove = hasPermission(snapshot, "approval.request.approve");
  const canExecute = hasPermission(snapshot, "approval.request.execute");
  const canAddApprover = hasPermission(snapshot, "approval.request.add_approver");
  const canAudit = hasPermission(snapshot, "approval.audit.read");
  const canReadAdmins = hasPermission(snapshot, "admin.account.read");
  const contextKey = JSON.stringify([contextKeyOf(snapshot), initialRequestId ?? ""]);
  const contextKeyRef = useRef(contextKey);
  const contextEpochRef = useRef(0);
  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    contextEpochRef.current += 1;
  }
  const contextEpoch = contextEpochRef.current;

  const [tab, setTab] = useState<"mine" | "pending" | "templates" | "audit">(initialTab ?? "mine");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [admins, setAdmins] = useState<AdminDirectoryEntry[]>([]);
  const [mine, setMine] = useState<RequestSummary[]>([]);
  const [pending, setPending] = useState<RequestSummary[]>([]);
  const [detail, setDetail] = useState<RequestDetail>();
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [operationCode, setOperationCode] = useState("approval.test.execute");
  const [triggerCondition, setTriggerCondition] = useState("manual");
  const [candidateUsernames, setCandidateUsernames] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState<"SUCCESS" | "FAILURE">("SUCCESS");
  const [rejectReason, setRejectReason] = useState("");
  const [appendUsername, setAppendUsername] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind } | null>(null);
  const [recall, setRecall] = useState("");
  const [detailFresh, setDetailFresh] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [pageMeta, setPageMeta] = useState<Record<ListKey, ListPage>>(emptyPageMeta);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>(() => auditFilterFromQuery(initialQuery));
  const [auditDraft, setAuditDraft] = useState<AuditFilter>(() => auditFilterFromQuery(initialQuery));
  const [auditScope, setAuditScope] = useState<string>();

  const pageMetaRef = useRef(pageMeta);
  const auditFilterRef = useRef(auditFilter);
  const previousAuditQueryKeyRef = useRef(auditFilterKey(auditFilterFromQuery(initialQuery)));
  const seqRef = useRef<Record<ListKey | "detail" | "templates" | "admins", number>>({ mine: 0, pending: 0, audit: 0, detail: 0, templates: 0, admins: 0 });
  const mountedRef = useRef(true);
  const previousContextKeyRef = useRef(contextKey);
  const objectKeyRef = useRef(initialRequestId ?? "");
  const objectEpochRef = useRef(0);
  const writeInFlightRef = useRef(false);
  const readbackInFlightRef = useRef(false);
  const recoveryRef = useRef<RecoveryState | null>(null);

  const isCurrent = (epoch: number, key: string) => mountedRef.current && contextEpochRef.current === epoch && contextKeyRef.current === key;
  const isCurrentObject = (epoch: number, key: string) => objectEpochRef.current === epoch && objectKeyRef.current === key;
  const isCurrentIntent = (intent: WriteIntent) => isCurrent(intent.contextEpoch, intent.contextKey) && isCurrentObject(intent.objectEpoch, intent.objectKey);
  const updateRecovery = (next: RecoveryState | null) => {
    recoveryRef.current = next;
    setRecovery(next);
  };

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
    for (const key of Object.keys(seqRef.current) as Array<keyof typeof seqRef.current>) seqRef.current[key] += 1;
    pageMetaRef.current = emptyPageMeta();
    writeInFlightRef.current = false;
    readbackInFlightRef.current = false;
    setLoading(false);
    updateRecovery(null);
    setTemplates([]);
    setAdmins([]);
    setMine([]);
    setPending([]);
    setDetail(undefined);
    setDetailFresh(false);
    setAudit([]);
    setPageMeta(pageMetaRef.current);
    setReading({});
    setError(undefined);
    auditFilterRef.current = emptyAuditFilter;
    setAuditFilter(emptyAuditFilter);
    setAuditDraft(emptyAuditFilter);
    setAuditScope(undefined);
    previousAuditQueryKeyRef.current = auditFilterKey(emptyAuditFilter);
    setMessage(undefined);
    setConfirm(null);
    setRecall("");
    setRejectReason("");
    setAppendUsername("");
    setReason("");
    setSummary("");
    setOperationCode("approval.test.execute");
    setTriggerCondition("manual");
    setCandidateUsernames([]);
  }, [contextKey]);

  const beginObject = (requestId?: string) => {
    const nextObjectKey = requestId ?? "";
    if (objectKeyRef.current === nextObjectKey) return;
    objectKeyRef.current = nextObjectKey;
    objectEpochRef.current += 1;
    writeInFlightRef.current = false;
    readbackInFlightRef.current = false;
    setLoading(false);
    updateRecovery(null);
    setConfirm(null);
    setRecall("");
    setRejectReason("");
    setAppendUsername("");
    setReason("");
    setDetail(undefined);
    setDetailFresh(false);
    setError(undefined);
    setMessage(undefined);
  };

  const loadList = useCallback(async (key: ListKey, target?: { cursors: (string | null)[]; index: number }): Promise<boolean> => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const meta = target
      ? { cursors: target.cursors, index: target.index, nextCursor: pageMetaRef.current[key].nextCursor }
      : pageMetaRef.current[key];
    const cursor = meta.cursors[meta.index];
    const seq = ++seqRef.current[key];
    setReading((current) => ({ ...current, [key]: true }));
    try {
      let url: string;
      if (key === "audit") {
        const filter = auditFilterRef.current;
        const params = new URLSearchParams({ limit: "50" });
        if (filter.action) params.set("action", filter.action);
        if (filter.objectType) params.set("objectType", filter.objectType);
        if (filter.actorUsername) params.set("actorUsername", filter.actorUsername);
        if (filter.requestId) params.set("requestId", filter.requestId);
        if (cursor) params.set("cursor", cursor);
        url = "/security/approvals/audit/events?" + params.toString();
      } else {
        const base = key === "mine"
          ? "/security/approvals/requests/mine?limit=50"
          : "/security/approvals/requests/pending?limit=50";
        url = base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      }
      let nextCursor: string | null = null;
      if (key === "audit") {
        const data = await adminRequest<{ events?: AuditEvent[]; nextCursor?: string | null; scope?: string }>(url);
        if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current[key] !== seq) return false;
        setAudit(data.events ?? []);
        setAuditScope(data.scope);
        nextCursor = data.nextCursor ?? null;
      } else {
        const data = await adminRequest<{ requests?: RequestSummary[]; nextCursor?: string | null }>(url);
        if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current[key] !== seq) return false;
        if (key === "mine") setMine(data.requests ?? []);
        else setPending(data.requests ?? []);
        nextCursor = data.nextCursor ?? null;
      }
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current[key] !== seq) return false;
      pageMetaRef.current = { ...pageMetaRef.current, [key]: { cursors: meta.cursors, index: meta.index, nextCursor } };
      setPageMeta(pageMetaRef.current);
      return true;
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current[key] === seq) setError(friendlyError(failure));
      return false;
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current[key] === seq) setReading((current) => ({ ...current, [key]: false }));
    }
  }, [contextEpoch, contextKey]);

  const loadTemplates = useCallback(async (): Promise<boolean> => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const seq = ++seqRef.current.templates;
    setReading((current) => ({ ...current, templates: true }));
    try {
      const data = await adminRequest<{ templates?: Template[] }>("/security/approvals/templates");
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current.templates !== seq) return false;
      setTemplates(data.templates ?? []);
      return true;
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.templates === seq) setError(friendlyError(failure));
      return false;
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.templates === seq) setReading((current) => ({ ...current, templates: false }));
    }
  }, [contextEpoch, contextKey]);

  const loadAdmins = useCallback(async (): Promise<boolean> => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const seq = ++seqRef.current.admins;
    try {
      const data = await adminRequest<{ admins?: AdminDirectoryEntry[] }>("/security/admins");
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current.admins !== seq) return false;
      setAdmins(data.admins ?? []);
      return true;
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.admins === seq) setError(friendlyError(failure));
      return false;
    }
  }, [contextEpoch, contextKey]);

  const load = useCallback(async (): Promise<boolean> => {
    const tasks: Promise<boolean>[] = [];
    if (canTemplateRead) tasks.push(loadTemplates());
    if (canRead) tasks.push(loadList("mine"));
    if (canApprove) tasks.push(loadList("pending"));
    if (canAudit) tasks.push(loadList("audit"));
    if (canReadAdmins) tasks.push(loadAdmins());
    return (await Promise.all(tasks)).every(Boolean);
  }, [canApprove, canAudit, canRead, canReadAdmins, canTemplateRead, loadAdmins, loadList, loadTemplates]);

  const loadDetail = useCallback(async (requestId: string): Promise<boolean> => {
    beginObject(requestId);
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    const requestObjectEpoch = objectEpochRef.current;
    const requestObjectKey = objectKeyRef.current;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const seq = ++seqRef.current.detail;
    setDetail(undefined);
    setDetailFresh(false);
    try {
      const result = await adminRequest<RequestDetail>("/security/approvals/requests/detail?requestId=" + encodeURIComponent(requestId));
      if (!isCurrent(requestEpoch, requestContextKey) || !isCurrentObject(requestObjectEpoch, requestObjectKey) || seqRef.current.detail !== seq) return false;
      setDetail(result);
      setDetailFresh(true);
      return true;
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && isCurrentObject(requestObjectEpoch, requestObjectKey) && seqRef.current.detail === seq) {
        setDetail(undefined);
        setDetailFresh(false);
        setError(friendlyError(failure));
      }
      return false;
    }
  }, [contextEpoch, contextKey]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    if (initialRequestId) void loadDetail(initialRequestId);
    else beginObject();
  }, [initialRequestId, loadDetail]);

  useEffect(() => {
    const current = templates[0];
    if (!current) return;
    setOperationCode(current.operationCode);
    setTriggerCondition(current.triggerCondition);
    setCandidateUsernames(current.candidates.map((candidate) => candidate.username));
  }, [templates]);

  const allRequests = useMemo(() => {
    const byId = new Map<string, RequestSummary>();
    for (const item of [...mine, ...pending]) byId.set(item.requestId, item);
    return [...byId.values()];
  }, [mine, pending]);

  const navigate = (key: ListKey, action: "prev" | "next" | "first") => {
    const meta = pageMetaRef.current[key];
    let cursors = meta.cursors;
    let index = meta.index;
    if (action === "next") {
      if (!meta.nextCursor) return;
      cursors = [...meta.cursors.slice(0, meta.index + 1), meta.nextCursor];
      index = meta.index + 1;
    } else if (action === "prev") {
      if (meta.index === 0) return;
      index = meta.index - 1;
    } else {
      index = 0;
    }
    if (index === meta.index) return;
    void loadList(key, { cursors, index });
  };

  const applyAuditFilter = (next: AuditFilter, syncUrl: boolean) => {
    auditFilterRef.current = next;
    setAuditFilter(next);
    setAuditDraft(next);
    // 新条件生效前清空旧条件的结果、范围与分页；失败时只显示错误，不把旧行当新结果。
    setAudit([]);
    setAuditScope(undefined);
    pageMetaRef.current = { ...pageMetaRef.current, audit: { cursors: [null], index: 0, nextCursor: null } };
    setPageMeta(pageMetaRef.current);
    if (syncUrl && onQueryChange) {
      const query: Record<string, string> = { ...(initialQuery ?? {}), tab: "audit" };
      delete query.action;
      delete query.objectType;
      delete query.actorUsername;
      delete query.requestId;
      if (next.action) query.action = next.action;
      if (next.objectType) query.objectType = next.objectType;
      if (next.actorUsername) query.actorUsername = next.actorUsername;
      if (next.requestId) query.requestId = next.requestId;
      onQueryChange(query);
    }
    void loadList("audit", { cursors: [null], index: 0 });
  };

  const submitAuditFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyAuditFilter({
      action: auditDraft.action,
      objectType: auditDraft.objectType,
      actorUsername: auditDraft.actorUsername.trim(),
      requestId: auditDraft.requestId.trim(),
    }, true);
  };

  // 同一审批 tab 复用时，外部 URL query 变化（如恢复的标签）回填审计筛选并重新读取。
  // 与“已应用”的查询比较：本页提交后的 URL 回声因 applied 相同而跳过；
  // 未提交草稿与外部 URL 一致时仍按外部导航重新读取已应用条件。
  const auditQueryKey = auditFilterKey(auditFilterFromQuery(initialQuery));
  useEffect(() => {
    const changed = previousAuditQueryKeyRef.current !== auditQueryKey;
    previousAuditQueryKeyRef.current = auditQueryKey;
    if (!changed || objectOnly) return;
    if (auditFilterKey(auditFilterRef.current) === auditQueryKey) return;
    applyAuditFilter(auditFilterFromQuery(initialQuery), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditQueryKey]);

  const performReadback = useCallback(async (target: ReadbackTarget): Promise<boolean> => {
    if (target.kind === "templates") return loadTemplates();
    if (target.kind === "lists") return (await Promise.all(target.keys.map((key) => loadList(key)))).every(Boolean);
    const detailOk = await loadDetail(target.requestId);
    const listOk = target.keys.length === 0 || (await Promise.all(target.keys.map((key) => loadList(key)))).every(Boolean);
    return detailOk && listOk;
  }, [loadDetail, loadList, loadTemplates]);

  const makeWriteIntent = useCallback((path: string, body: Record<string, unknown>, successMessage: string, readback: ReadbackTarget, afterPost?: () => void): WriteIntent => ({
    actorId: snapshot.adminUserId,
    sessionId: snapshot.session.id,
    objectKey: objectKeyRef.current,
    objectEpoch: objectEpochRef.current,
    contextKey,
    contextEpoch,
    path,
    method: "POST",
    body,
    idempotencyKey: `idem_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll("-", "")}`,
    successMessage,
    readback,
    afterPost,
  }), [contextEpoch, contextKey, snapshot.adminUserId, snapshot.session.id]);

  const submitWrite = useCallback(async (intent: WriteIntent, recovering = false) => {
    if (!isCurrentIntent(intent) || writeInFlightRef.current || readbackInFlightRef.current) return;
    if (recoveryRef.current && !recovering) return;
    writeInFlightRef.current = true;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest(intent.path, intent.body, intent.method, { "idempotency-key": intent.idempotencyKey });
      if (!isCurrentIntent(intent)) return;
      intent.afterPost?.();
      const readbackOk = await performReadback(intent.readback);
      if (!isCurrentIntent(intent)) return;
      if (readbackOk) {
        updateRecovery(null);
        setMessage(intent.successMessage);
      } else {
        updateRecovery({ kind: "readback", intent });
        setError(undefined);
        setMessage(`${intent.successMessage} 已成功，最新状态未确认。`);
      }
    } catch (failure) {
      if (!isCurrentIntent(intent)) return;
      if (isUnknownWriteError(failure)) {
        updateRecovery({ kind: "unknown", intent });
        setMessage(undefined);
        setError("请求结果未知：服务端可能已处理；仅可使用原请求重试或放弃恢复。");
      } else {
        updateRecovery(null);
        setError(friendlyError(failure));
      }
    } finally {
      if (isCurrentIntent(intent)) {
        writeInFlightRef.current = false;
        setLoading(false);
      }
    }
  }, [performReadback]);

  const retryUnknown = () => {
    const current = recoveryRef.current;
    if (current?.kind === "unknown") void submitWrite(current.intent, true);
  };

  const discardRecovery = () => {
    if (recoveryRef.current?.kind !== "unknown") return;
    updateRecovery(null);
    setDetail(undefined);
    setDetailFresh(false);
    setError(undefined);
  };

  const retryReadback = async () => {
    const current = recoveryRef.current;
    if (current?.kind !== "readback" || readbackInFlightRef.current) return;
    if (!isCurrentIntent(current.intent)) return;
    readbackInFlightRef.current = true;
    setError(undefined);
    setLoading(true);
    try {
      const readbackOk = await performReadback(current.intent.readback);
      if (!isCurrentIntent(current.intent)) return;
      if (readbackOk) {
        updateRecovery(null);
        setMessage(`${current.intent.successMessage} 最新状态已确认。`);
      } else {
        setError(undefined);
        setMessage(`${current.intent.successMessage} 已成功，最新状态未确认。`);
      }
    } finally {
      if (isCurrentIntent(current.intent)) {
        readbackInFlightRef.current = false;
        setLoading(false);
      }
    }
  };

  const saveTemplate = () => {
    void submitWrite(makeWriteIntent(
      "/security/approvals/templates/update",
      { operationCode, triggerCondition, candidateUsernames: [...candidateUsernames] },
      "审批模板已保存；只影响之后新建的申请。在途申请保留原版本与名单快照。",
      { kind: "templates" },
    ));
  };

  const configure = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openConfirm("template");
  };

  const createRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests",
      { operationCode, triggerCondition, payloadVersion: 1, payload: { outcome }, summary },
      "申请已提交。审批同意不代表执行完成或资金到账。",
      { kind: "lists", keys: ["mine"] },
      () => setSummary(""),
    ));
  };

  const decide = (decision: "APPROVE" | "REJECT") => {
    const current = detail;
    if (!current) return;
    const successMessage = decision === "APPROVE" ? "已记录首个有效同意。后续执行仍是独立步骤。" : "已拒绝；如需再次申请，请新建申请，不会复活原审批。";
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/decision",
      { requestId: current.requestId, decision, ...(rejectReason.trim() ? { reason: rejectReason.trim() } : {}) },
      successMessage,
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
      () => setRejectReason(""),
    ));
  };

  const append = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = detail;
    if (!current) return;
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/add-candidate",
      { requestId: current.requestId, username: appendUsername, reason },
      "已追加当前仍具备审批资格的审批人；原配置名单未删除或跳过。",
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
      () => { setAppendUsername(""); setReason(""); },
    ));
  };

  const execute = () => {
    const current = detail;
    if (!current) return;
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/execute",
      { requestId: current.requestId },
      "执行结果已单独记录；请以执行状态查看结果。",
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
      () => setRecall(""),
    ));
  };

  const openConfirm = (kind: ConfirmKind) => {
    if (loading || recoveryRef.current) return;
    setRecall("");
    if (kind === "approve" || kind === "reject") setRejectReason("");
    setConfirm({ kind });
  };

  const recallTarget = detail?.summary.slice(0, 8) ?? "";
  const confirmKind = confirm?.kind;
  const confirmLabel = confirmKind === "approve" ? "确认同意"
    : confirmKind === "reject" ? "确认拒绝"
      : confirmKind === "execute" ? "确认执行" : "确认保存";
  const confirmDisabled = confirmKind === "reject"
    ? rejectReason.trim().length < 3
    : confirmKind === "execute"
      ? recall.trim() !== recallTarget
      : false;

  const onConfirm = () => {
    const kind = confirm?.kind;
    if (!kind) return;
    setConfirm(null);
    setRecall("");
    if (kind === "approve") void decide("APPROVE");
    else if (kind === "reject") void decide("REJECT");
    else if (kind === "execute") void execute();
    else void saveTemplate();
  };

  const confirmDialogTitle = confirmKind === "approve" ? "确认同意审批"
    : confirmKind === "reject" ? "确认拒绝审批"
      : confirmKind === "execute" ? "确认执行本地测试动作" : "确认保存审批模板";
  const confirmConsequence = confirmKind === "approve"
    ? "同意后申请进入“已同意，待执行”；审批同意不代表执行完成或资金到账。"
    : confirmKind === "reject"
      ? "拒绝后原申请关闭且不会复活；如需再次发起请新建申请。"
      : confirmKind === "execute"
        ? "执行为本地非资金测试动作，结果单独记录且不可撤销。"
        : "模板只影响之后新建的申请；在途申请保留原版本与名单快照。";

  const confirmDialog = (
    <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setRecall(""); } }}>
      <DialogContent>
        <DialogTitle>{confirmDialogTitle}</DialogTitle>
        <DialogDescription>{confirmConsequence}</DialogDescription>
        <div className="space-y-3 text-xs">
          <div className="rounded border border-border bg-surface-soft p-3 space-y-1">
            <p className="text-muted-foreground">{confirmKind === "template" ? "模板配置" : "申请对象"}</p>
            {confirmKind === "template" ? (
              <>
                <p><span className="text-muted-foreground">操作标识：</span><span className="font-mono">{operationCode}</span></p>
                <p><span className="text-muted-foreground">触发条件：</span><span className="font-mono">{triggerCondition}</span></p>
                <p><span className="text-muted-foreground">候选审批人：</span>{candidateUsernames.length} 人（{candidateUsernames.join("、") || "无"}）</p>
              </>
            ) : detail ? (
              <>
                <p><span className="text-muted-foreground">业务摘要：</span>{detail.summary}</p>
                <p><span className="text-muted-foreground">操作：</span><span className="font-mono">{detail.operation.code}</span> / <span className="font-mono">{detail.operation.triggerCondition}</span></p>
                <p><span className="text-muted-foreground">发起人：</span>{personLabel(detail.requester)}</p>
              </>
            ) : null}
          </div>
          {confirmKind === "approve" || confirmKind === "reject" ? (
            <label className="space-y-1 text-xs block">
              <span className="text-muted-foreground">{confirmKind === "reject" ? "拒绝原因（至少 3 字）" : "原因（可选）"}</span>
              <input
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                className="w-full h-8 px-3 rounded border border-border bg-surface-raised text-xs"
                placeholder={confirmKind === "reject" ? "拒绝原因（至少 3 字）" : "补充说明（可选）"}
              />
            </label>
          ) : null}
          {confirmKind === "execute" && detail ? (
            <label className="space-y-1 text-xs block">
              <span className="text-muted-foreground">输入申请摘要前 8 字以确认：{recallTarget}</span>
              <input
                value={recall}
                onChange={(event) => setRecall(event.target.value)}
                className="w-full h-8 px-3 rounded border border-border bg-surface-raised text-xs font-mono"
                placeholder="复述摘要前 8 字"
              />
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" size="sm" />}>取消</DialogClose>
          <Button type="button" size="sm" variant={confirmKind === "reject" || confirmKind === "execute" ? "danger" : "primary"} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const selectRequest = (requestId: string, title?: string) => {
    if (onOpenObject) {
      onOpenObject(requestId, title ?? "审批详情");
      return;
    }
    setError(undefined);
    void loadDetail(requestId);
  };

  const actionRows = detail && detailFresh ? (
    <div className="flex flex-wrap gap-2 mt-4">
      {canApprove && detail.status === "PENDING" ? (
        <>
          <Button type="button" size="sm" disabled={loading || recovery !== null} onClick={() => openConfirm("approve")}>同意</Button>
          <Button type="button" size="sm" variant="danger" disabled={loading || recovery !== null} onClick={() => openConfirm("reject")}>拒绝</Button>
        </>
      ) : null}
      {canExecute && detail.status === "APPROVED" ? (
        <Button type="button" size="sm" disabled={loading || recovery !== null} onClick={() => openConfirm("execute")}>执行本地测试动作</Button>
      ) : null}
    </div>
  ) : null;

  const recoveryPanel = recovery ? (
    <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
      <Button type="button" size="sm" variant="secondary" loading={loading} onClick={recovery.kind === "unknown" ? retryUnknown : () => void retryReadback()}>
        {recovery.kind === "unknown" ? "用原请求重试" : "重试读取最新状态"}
      </Button>
      {recovery.kind === "unknown" ? <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={discardRecovery}>放弃恢复</Button> : null}
    </div>
  ) : null;

  if (!canTemplateRead && !canCreate && !canRead && !canApprove && !canAudit) {
    return <section className="section-panel"><StatusMessage error="当前账号没有审批或审批审计读取权限。" /></section>;
  }

  if (objectOnly) {
    return (
      <div className="space-y-6">
        <StatusMessage error={error} success={message} />
        {recoveryPanel}
        {detail ? (
          <section className="section-panel">
            <div className="panel-heading"><div><h3>申请详情与历史</h3><p>申请载荷、模板版本、候选名单和决定历史均来自服务端快照。</p></div><span className={"text-sm font-medium " + statusTone(detail.status)}>{statusLabel(detail.status)}</span></div>
          </section>
        ) : <p className="text-xs text-muted-foreground">正在读取审批详情…</p>}
        {detail ? (
          <section className="section-panel">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="space-y-2"><p><span className="text-muted-foreground">业务摘要：</span>{detail.summary}</p><p><span className="text-muted-foreground">发起人：</span>{personLabel(detail.requester)}</p><p><span className="text-muted-foreground">操作：</span><span className="font-mono">{detail.operation.code}</span> / <span className="font-mono">{detail.operation.triggerCondition}</span></p><p><span className="text-muted-foreground">载荷版本 / 哈希：</span>{detail.operation.payloadVersion} / <span className="font-mono break-all">{detail.operation.payloadHash}</span></p><p><span className="text-muted-foreground">模板快照版本：</span>{detail.template.version}</p><p><span className="text-muted-foreground">有效期：</span>{formatDate(detail.expiresAt)}</p>{detail.statusReason ? <p className="text-amber-300">{detail.statusReason}</p> : null}</div>
              <div className="rounded border border-border bg-surface-soft p-3"><p className="text-muted-foreground mb-2">不可变测试载荷（不含资金字段）</p><pre className="font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(detail.operation.payload ?? {}, null, 2)}</pre></div>
            </div>
            {detail.supersedesRequestId || detail.supersededByRequestId ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                {detail.supersedesRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => selectRequest(detail.supersedesRequestId!, "被替代的审批申请")}>查看被替代的原申请</Button> : null}
                {detail.supersededByRequestId ? <span className="text-amber-300">本申请已被另一申请替代，原申请不再推进。</span> : null}
                {detail.supersededByRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => selectRequest(detail.supersededByRequestId!, "替代本申请的审批申请")}>查看替代申请</Button> : null}
              </div>
            ) : null}
            <div className="mt-5"><h4 className="text-xs font-semibold mb-2">候选审批人</h4><div className="flex flex-wrap gap-2">{detail.candidates.map((candidate) => <span key={candidate.username + "-" + (candidate.source ?? "template")} className={"status-badge " + (candidate.eligible ? "success" : "warning")}>{personLabel(candidate)} · {candidate.eligible ? "当前可审批" : candidate.status === "FROZEN" ? "已冻结" : "当前无资格"}{candidate.source === "APPENDED" ? " · 追加" : " · 模板"}</span>)}</div></div>
            {detail.decision ? <p className="text-xs mt-4">决定：{detail.decision.decision === "APPROVED" ? "同意" : "拒绝"}，由 {personLabel(detail.decision.approver)} 于 {formatDate(detail.decision.createdAt)} 记录。{detail.decision.reason ? "原因：" + detail.decision.reason : ""}</p> : null}
            {detail.execution ? <p className={"text-xs mt-2 " + (detail.execution.status === "SUCCEEDED" ? "text-emerald-400" : "text-rose-400")}>执行：{detail.execution.status === "SUCCEEDED" ? "成功" : "失败"}，结果码 {detail.execution.resultCode}；{detail.execution.resultDetail ?? "无附加说明"}</p> : null}
            {actionRows}
            {canAddApprover && detailFresh && detail.status === "PENDING" ? <form onSubmit={append} className="flex flex-wrap items-end gap-2 mt-5 pt-4 border-t border-border"><label className="space-y-1 text-xs"><span className="text-muted-foreground block">追加当前合格审批人</span><select value={appendUsername} onChange={(event) => setAppendUsername(event.target.value)} className="h-8 min-w-56 px-2 rounded border border-border bg-surface-raised text-xs" required><option value="">选择账号</option>{admins.map((admin) => <option key={admin.id} value={admin.username}>{personLabel({ name: admin.name, username: admin.username })}</option>)}</select></label><input value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 min-w-56 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="追加原因" required /><Button type="submit" size="sm" variant="secondary" loading={loading} disabled={loading || recovery !== null || !appendUsername || reason.trim().length < 3}>追加审批人</Button></form> : null}
            <div className="mt-5"><h4 className="text-xs font-semibold mb-2">状态历史</h4><div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>动作</th><th>账号</th><th>结果</th><th>说明</th></tr></thead><tbody>{detail.history.map((event) => <tr key={event.eventId}><td>{formatDate(event.occurredAt)}</td><td className="font-mono">{event.action}</td><td>{personLabel(event.actor)}</td><td>{event.outcome}</td><td>{event.reason ?? prettyDetails(event.details)}</td></tr>)}</tbody></table></div></div>
          </section>
        ) : null}
        {confirmDialog}
      </div>
    );
  }

  const listKey: ListKey = tab === "pending" ? "pending" : "mine";
  const listItems = tab === "pending" ? pending : mine;

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div><h3>审批与授权审计</h3><p>仅覆盖明确配置的操作。审批决定、实际执行和审计记录彼此独立，页面不会把同意显示成资金到账。</p></div>
          <Icons.ShieldCheck size={20} className="text-muted-foreground" />
        </div>
        <div className="flex flex-wrap gap-2 mt-4" role="tablist" aria-label="审批工作区">
          {canRead ? <Button type="button" size="sm" role="tab" aria-selected={tab === "mine"} variant={tab === "mine" ? "primary" : "secondary"} onClick={() => { setTab("mine"); onTabChange?.("mine"); }}>我的申请</Button> : null}
          {canApprove ? <Button type="button" size="sm" role="tab" aria-selected={tab === "pending"} variant={tab === "pending" ? "primary" : "secondary"} onClick={() => { setTab("pending"); onTabChange?.("pending"); }}>待我审批</Button> : null}
          {canTemplateRead || canTemplateConfigure ? <Button type="button" size="sm" role="tab" aria-selected={tab === "templates"} variant={tab === "templates" ? "primary" : "secondary"} onClick={() => { setTab("templates"); onTabChange?.("templates"); }}>模板配置</Button> : null}
          {canAudit ? <Button type="button" size="sm" role="tab" aria-selected={tab === "audit"} variant={tab === "audit" ? "primary" : "secondary"} onClick={() => { setTab("audit"); onTabChange?.("audit"); }}>审计记录</Button> : null}
        </div>
         <StatusMessage error={error} success={message} className="mt-4" />
         {recoveryPanel}
      </section>

      {tab === "templates" ? (
        <>
          {canTemplateConfigure ? (
            <section className="section-panel">
              <div className="panel-heading"><div><h3>Boss 配置审批模板</h3><p>候选人至少一名；候选人可包含本人，但发起自己的申请时不能自审。触发条件是稳定标识，不接受金额阈值或表达式。</p></div></div>
              <form onSubmit={configure} className="space-y-4" noValidate>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作标识</span><input value={operationCode} onChange={(event) => setOperationCode(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required /></label>
                  <label className="space-y-1 text-xs"><span className="text-muted-foreground">触发条件标识</span><input value={triggerCondition} onChange={(event) => setTriggerCondition(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required /></label>
                </div>
                <label className="space-y-1 text-xs block"><span className="text-muted-foreground">候选审批人（可多选，显示账号与姓名）</span><select multiple size={Math.min(8, Math.max(3, admins.length || 3))} value={candidateUsernames} onChange={(event) => setCandidateUsernames(Array.from(event.currentTarget.selectedOptions, (option) => option.value))} className="w-full min-h-24 p-2 rounded border border-border bg-surface-raised text-xs" required>{admins.map((admin) => <option key={admin.id} value={admin.username}>{personLabel({ name: admin.name, username: admin.username })} · {admin.status === "ACTIVE" ? "正常" : admin.status === "FROZEN" ? "冻结" : "待激活"}</option>)}</select></label>
                <Button type="submit" size="sm" loading={loading} disabled={!operationCode.trim() || !triggerCondition.trim() || candidateUsernames.length < 1}>保存模板</Button>
              </form>
            </section>
          ) : null}
          {canTemplateRead ? <section className="section-panel"><div className="panel-heading"><div><h3>当前模板</h3><p>模板版本只用于新申请；在途申请展示自己的快照版本。</p></div></div>{reading.templates ? <p className="text-xs text-muted-foreground mt-4">正在读取…</p> : null}{!reading.templates && templates.length === 0 ? <p className="text-xs text-muted-foreground mt-4">暂无模板配置。</p> : null}<div className="table-wrap"><table className="data-table"><thead><tr><th>操作</th><th>触发条件</th><th>版本</th><th>候选审批人</th></tr></thead><tbody>{templates.map((template) => <tr key={template.id}><td className="font-mono">{template.operationCode}</td><td className="font-mono">{template.triggerCondition}</td><td>{template.version}</td><td>{template.candidates.map((candidate) => personLabel(candidate)).join("、")}</td></tr>)}</tbody></table></div></section> : null}
        </>
      ) : null}

      {tab === "mine" && canCreate ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>新建申请</h3><p>本包的可执行演示动作是本地非资金测试动作；载荷保存为不可变版本与哈希。</p></div></div>
          <form onSubmit={createRequest} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作</span><input value={operationCode} onChange={(event) => setOperationCode(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required /></label>
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">触发条件</span><input value={triggerCondition} onChange={(event) => setTriggerCondition(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required /></label>
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">测试动作结果</span><select value={outcome} onChange={(event) => setOutcome(event.target.value as "SUCCESS" | "FAILURE")} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="SUCCESS">成功</option><option value="FAILURE">失败（可追溯）</option></select></label>
            </div>
            <label className="space-y-1 text-xs block"><span className="text-muted-foreground">业务摘要</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs" placeholder="说明本次明确操作，不填写内部 ID" required /></label>
            <Button type="submit" size="sm" loading={loading} disabled={summary.trim().length < 3}>提交审批申请</Button>
          </form>
        </section>
      ) : null}

      {tab === "mine" || tab === "pending" ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>{tab === "mine" ? "我的申请" : "待我审批"}</h3><p>{tab === "mine" ? "仅显示当前账号发起的申请，按创建时间倒序分页读取。" : "仅显示当前账号仍具备权限、未冻结且不属于自审的候选申请，按创建时间倒序分页读取。"}</p></div></div>
          {reading[listKey] ? <p className="text-xs text-muted-foreground mt-4">正在读取…</p> : null}
          <div className="table-wrap"><table className="data-table"><thead><tr><th>业务摘要</th><th>发起人</th><th>状态</th><th>创建时间</th><th>到期时间</th></tr></thead><tbody>{listItems.map((item) => <tr key={item.requestId} onClick={() => void selectRequest(item.requestId, item.summary)}><td><strong>{item.summary}</strong><div className="text-[11px] text-muted-foreground font-mono">{item.operationCode} · v{item.payloadVersion}</div></td><td>{personLabel(item.requester)}</td><td className={statusTone(item.status)}>{statusLabel(item.status)}{item.statusReason ? <div className="text-[11px] text-muted-foreground">{item.statusReason}</div> : null}</td><td>{formatDate(item.createdAt)}</td><td>{formatDate(item.expiresAt)}</td></tr>)}</tbody></table></div>
          {!reading[listKey] && listItems.length === 0 ? <p className="text-xs text-muted-foreground mt-4">暂无记录。</p> : null}
          <PagePager page={pageMeta[listKey]} busy={Boolean(reading[listKey])} onPrev={() => navigate(listKey, "prev")} onNext={() => navigate(listKey, "next")} onFirst={() => navigate(listKey, "first")} />
        </section>
      ) : null}

      {detail && (tab === "mine" || tab === "pending") ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>申请详情与历史</h3><p>申请载荷、模板版本、候选名单和决定历史均来自服务端快照。</p></div><span className={"text-sm font-medium " + statusTone(detail.status)}>{statusLabel(detail.status)}</span></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-2"><p><span className="text-muted-foreground">业务摘要：</span>{detail.summary}</p><p><span className="text-muted-foreground">发起人：</span>{personLabel(detail.requester)}</p><p><span className="text-muted-foreground">操作：</span><span className="font-mono">{detail.operation.code}</span> / <span className="font-mono">{detail.operation.triggerCondition}</span></p><p><span className="text-muted-foreground">载荷版本 / 哈希：</span>{detail.operation.payloadVersion} / <span className="font-mono break-all">{detail.operation.payloadHash}</span></p><p><span className="text-muted-foreground">模板快照版本：</span>{detail.template.version}</p><p><span className="text-muted-foreground">有效期：</span>{formatDate(detail.expiresAt)}</p>{detail.statusReason ? <p className="text-amber-300">{detail.statusReason}</p> : null}</div>
            <div className="rounded border border-border bg-surface-soft p-3"><p className="text-muted-foreground mb-2">不可变测试载荷（不含资金字段）</p><pre className="font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(detail.operation.payload ?? {}, null, 2)}</pre></div>
          </div>
          {detail.supersedesRequestId || detail.supersededByRequestId ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
              {detail.supersedesRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => selectRequest(detail.supersedesRequestId!, "被替代的审批申请")}>查看被替代的原申请</Button> : null}
              {detail.supersededByRequestId ? <span className="text-amber-300">本申请已被另一申请替代，原申请不再推进。</span> : null}
              {detail.supersededByRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => selectRequest(detail.supersededByRequestId!, "替代本申请的审批申请")}>查看替代申请</Button> : null}
            </div>
          ) : null}
          <div className="mt-5"><h4 className="text-xs font-semibold mb-2">候选审批人</h4><div className="flex flex-wrap gap-2">{detail.candidates.map((candidate) => <span key={candidate.username + "-" + (candidate.source ?? "template")} className={"status-badge " + (candidate.eligible ? "success" : "warning")}>{personLabel(candidate)} · {candidate.eligible ? "当前可审批" : candidate.status === "FROZEN" ? "已冻结" : "当前无资格"}{candidate.source === "APPENDED" ? " · 追加" : " · 模板"}</span>)}</div></div>
          {detail.decision ? <p className="text-xs mt-4">决定：{detail.decision.decision === "APPROVED" ? "同意" : "拒绝"}，由 {personLabel(detail.decision.approver)} 于 {formatDate(detail.decision.createdAt)} 记录。{detail.decision.reason ? "原因：" + detail.decision.reason : ""}</p> : null}
          {detail.execution ? <p className={"text-xs mt-2 " + (detail.execution.status === "SUCCEEDED" ? "text-emerald-400" : "text-rose-400")}>执行：{detail.execution.status === "SUCCEEDED" ? "成功" : "失败"}，结果码 {detail.execution.resultCode}；{detail.execution.resultDetail ?? "无附加说明"}</p> : null}
          {actionRows}
          {canAddApprover && detailFresh && detail.status === "PENDING" ? <form onSubmit={append} className="flex flex-wrap items-end gap-2 mt-5 pt-4 border-t border-border"><label className="space-y-1 text-xs"><span className="text-muted-foreground block">追加当前合格审批人</span><select value={appendUsername} onChange={(event) => setAppendUsername(event.target.value)} className="h-8 min-w-56 px-2 rounded border border-border bg-surface-raised text-xs" required><option value="">选择账号</option>{admins.map((admin) => <option key={admin.id} value={admin.username}>{personLabel({ name: admin.name, username: admin.username })}</option>)}</select></label><input value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 min-w-56 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="追加原因" required /><Button type="submit" size="sm" variant="secondary" loading={loading} disabled={loading || recovery !== null || !appendUsername || reason.trim().length < 3}>追加审批人</Button></form> : null}
          <div className="mt-5"><h4 className="text-xs font-semibold mb-2">状态历史</h4><div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>动作</th><th>账号</th><th>结果</th><th>说明</th></tr></thead><tbody>{detail.history.map((event) => <tr key={event.eventId}><td>{formatDate(event.occurredAt)}</td><td className="font-mono">{event.action}</td><td>{personLabel(event.actor)}</td><td>{event.outcome}</td><td>{event.reason ?? prettyDetails(event.details)}</td></tr>)}</tbody></table></div></div>
        </section>
      ) : null}

      {tab === "audit" && canAudit ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>授权审批审计</h3><p>按当前读取权限和对象范围游标分页读取；敏感字段已在 API 层裁剪，只有追加记录，没有改删入口。</p></div></div>
          <form onSubmit={submitAuditFilter} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mt-4" noValidate>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">动作</span><select value={auditDraft.action} onChange={(event) => setAuditDraft({ ...auditDraft, action: event.target.value })} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="">全部</option>{approvalAuditActions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">对象类型</span><select value={auditDraft.objectType} onChange={(event) => setAuditDraft({ ...auditDraft, objectType: event.target.value })} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs"><option value="">全部</option>{Object.entries(approvalAuditObjectTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作者账号</span><input value={auditDraft.actorUsername} onChange={(event) => setAuditDraft({ ...auditDraft, actorUsername: event.target.value })} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="如 ZZ00001" /></label>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">申请或请求编号（可选）</span><input value={auditDraft.requestId} onChange={(event) => setAuditDraft({ ...auditDraft, requestId: event.target.value })} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs" /></label>
            <Button type="submit" size="sm" loading={Boolean(reading.audit)}>查询审计</Button>
          </form>
          <p className="text-[11px] text-muted-foreground mt-3">查询范围：{auditScopeLabel(auditScope)}。审计按时间倒序分页，暂无时间区间筛选；精确追查请用动作、操作者或申请编号。</p>
          {reading.audit ? <p className="text-xs text-muted-foreground mt-4">正在读取…</p> : null}
          <div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th className="whitespace-nowrap">结果</th><th className="w-24">关联</th><th>业务说明</th></tr></thead><tbody>{audit.map((event) => {
            const relatedRequestId = relatedRequestIdOf(event);
            return <tr key={event.eventId}><td>{formatDate(event.occurredAt)}</td><td>{personLabel(event.actor)}</td><td>{approvalAuditActionLabel(event.action)}<span className="block font-mono text-[11px] text-muted-foreground">{event.action}</span></td><td className="font-mono text-[11px]">{approvalAuditObjectTypes[event.objectType] ?? event.objectType}{event.objectId ? <span className="block text-muted-foreground break-all" title={event.objectId}>{event.objectId}</span> : null}</td><td><span className={"whitespace-nowrap " + (event.outcome === "SUCCESS" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>{approvalAuditOutcomeLabel(event.outcome)}</span></td><td className="whitespace-nowrap">{relatedRequestId ? <Button type="button" size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => selectRequest(relatedRequestId, "审批详情")}>查看申请</Button> : <span className="text-muted-foreground text-[11px]">—</span>}</td><td>{auditNarrative(event)}<details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer select-none">技术详情</summary><pre className="whitespace-pre-wrap break-words mt-1">{prettyDetails(event.details)}</pre></details></td></tr>;
          })}</tbody></table></div>
          {!reading.audit && !error && audit.length === 0 ? <p className="text-xs text-muted-foreground mt-4">暂无符合条件的授权审批审计。</p> : null}
          <PagePager page={pageMeta.audit} busy={Boolean(reading.audit)} onPrev={() => navigate("audit", "prev")} onNext={() => navigate("audit", "next")} onFirst={() => navigate("audit", "first")} />
        </section>
      ) : null}
      {allRequests.length > 0 && detail && tab === "audit" ? <p className="text-xs text-muted-foreground">已有申请可在“我的申请”或“待我审批”中打开详情。</p> : null}
      {confirmDialog}
    </div>
  );
}
