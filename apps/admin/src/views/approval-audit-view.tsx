import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, ArrowLeft } from "lucide-react";

import { Icons } from "../components/icons";
import { ListPagination } from "../components/admin-list";
import { Button } from "@/components/ui/button";
import { StatusMessage } from "../components/ui-elements";
import { TooltipProvider } from "../components/ui/tooltip";
import {
  AdminApiError, adminRequest, friendlyError, hasPermission,
  type SessionSnapshot,
} from "../api";
import {
  isHighImpactOperation, receiptEnvelopeIssue, recoveryOutcomeSummary, recoveryOutcomeUnconfirmedSummary,
  RULES_COLUMNS, RULES_ROWS, type ReadbackTarget, type RecoveryResult, type RequestDetail, type RequestSummary,
} from "./approval/contract";
import {
  APPROVAL_WRITE_PATHS, dropPendingWrite, findPendingWrites, inspectPending, pendingWriteSubject,
  savePendingWrite, updatePendingWriteKind, type PendingApprovalWrite,
} from "./approval/pending-writes";
import { RequestDetail as RequestDetailPanel, type ApprovalStepUp } from "./approval/request-detail";
import { RequestList, EMPTY_FILTER, type ListFilter, type ListScope } from "./approval/request-list";
import { RecoveryPanel, type RecoveryLookup } from "./approval/recovery-panel";

type ListPage = { cursors: (string | null)[]; index: number; nextCursor: string | null };
type WriteIntent = {
  actorId: string;
  sessionId: string;
  target: string;
  objectKey: string;
  objectEpoch: number;
  contextKey: string;
  contextEpoch: number;
  path: string;
  operation: string;
  targetRequestId: string | null;
  method: "POST";
  body: Record<string, unknown>;
  idempotencyKey: string;
  successMessage: string;
  readback: ReadbackTarget;
  afterPost?: () => void;
  /** 高影响批准的动态码：仅内存携带，不进 sessionStorage 待核对记录。 */
  stepUp?: ApprovalStepUp;
};
type RecoveryState = { kind: "unknown" | "readback" | "resolved"; intent: WriteIntent; persisted: boolean; receipt?: RecoveryResult };

const TARGET_SCOPED_OPERATIONS = new Set(["approval.request.decide", "approval.request.withdraw"]);

function emptyPage(): ListPage {
  return { cursors: [null], index: 0, nextCursor: null };
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

/** 规则说明：只读表，内容固定；全额冲回分销佣金不在其中。 */
function RulesTable() {
  return (
    <div className="table-wrap">
      <table className="data-table min-w-[860px]">
        <caption className="sr-only">审批规则说明</caption>
        <thead>
          <tr>{RULES_COLUMNS.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {RULES_ROWS.map((row) => (
            <tr key={row.type}>
              <td className="font-medium whitespace-nowrap">{row.type}</td>
              <td>{row.submitters}</td>
              <td>{row.approvers}</td>
              <td>{row.selfApprove}</td>
              <td>{row.totp}</td>
              <td>{row.afterApprove}</td>
              <td>{row.entry}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        这张表只说明规则，不在这里配置模板、触发条件或审批人；发起仍在各业务页。
      </p>
    </div>
  );
}

function PagePager({ page, loadedCount, busy, onPrev, onNext, onFirst }: { page: ListPage; loadedCount: number; busy: boolean; onPrev: () => void; onNext: () => void; onFirst: () => void }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground"><span>第 {page.index + 1} 页</span>{page.index > 0 ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onFirst}>回到首页</Button> : null}</div>
      <ListPagination mode="cursor" page={page.index + 1} pageSize={50} pageSizeOptions={[50]} loadedCount={loadedCount} itemLabel="条申请" loading={busy} hasPrevious={page.index > 0} hasNext={Boolean(page.nextCursor)} onPrevious={onPrev} onNext={onNext} onPageSizeChange={() => undefined} />
    </div>
  );
}

export function ApprovalAuditView({
  snapshot,
  initialRequestId,
  objectOnly = false,
  onOpenObject,
  onOpenPath,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialRequestId?: string;
  initialTab?: string;
  initialQuery?: Record<string, string>;
  objectOnly?: boolean;
  onOpenObject?: (requestId: string, title: string) => void;
  onOpenPath?: (path: string, title: string) => void;
  onTabChange?: (tab: string) => void;
  onQueryChange?: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const canRead = hasPermission(snapshot, "approval.request.read");
  const canApprove = hasPermission(snapshot, "approval.request.approve");
  const canAudit = hasPermission(snapshot, "approval.audit.read");
  const contextKey = JSON.stringify([contextKeyOf(snapshot), initialRequestId ?? ""]);
  const contextKeyRef = useRef(contextKey);
  const contextEpochRef = useRef(0);
  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    contextEpochRef.current += 1;
  }
  const contextEpoch = contextEpochRef.current;

  // 默认范围：有审批权限的人「待我处理」，纯客服（含只读）「与我相关」。
  const defaultScope: ListScope = canApprove ? "pending" : "involved";
  const [scope, setScope] = useState<ListScope>(defaultScope);
  const [filters, setFilters] = useState<ListFilter>(EMPTY_FILTER);
  const [showRules, setShowRules] = useState(false);
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [pendingCount, setPendingCount] = useState<number | undefined>(undefined);
  const [detail, setDetail] = useState<RequestDetail>();
  const [error, setError] = useState<string>();
  const [message, setMessageState] = useState<string>();
  const [messageTone, setMessageTone] = useState<"warning" | "info">();
  const setMessage = useCallback((value: string | undefined, tone?: "warning" | "info") => {
    setMessageState(value);
    setMessageTone(tone);
  }, []);
  const [loading, setLoading] = useState(false);
  const [readingList, setReadingList] = useState(false);
  const [detailFresh, setDetailFresh] = useState(false);
  const [pageMeta, setPageMeta] = useState<ListPage>(emptyPage());
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [lookup, setLookup] = useState<RecoveryLookup>({ state: "idle" });
  const [pendingOthers, setPendingOthers] = useState(0);

  const pageMetaRef = useRef(pageMeta);
  const filtersRef = useRef(filters);
  const scopeRef = useRef(scope);
  filtersRef.current = filters;
  scopeRef.current = scope;
  const seqRef = useRef<{ list: number; detail: number }>({ list: 0, detail: 0 });
  const mountedRef = useRef(true);
  const previousContextKeyRef = useRef(contextKey);
  const objectKeyRef = useRef(initialRequestId ?? "");
  const objectEpochRef = useRef(0);
  const writeInFlightRef = useRef(false);
  const readbackInFlightRef = useRef(false);
  const lookupInFlightRef = useRef(false);
  const lookupSeqRef = useRef(0);
  const recoveryRef = useRef<RecoveryState | null>(null);
  const recoveryPanelElement = useRef<HTMLDivElement>(null);

  const isCurrent = (epoch: number, key: string) => mountedRef.current && contextEpochRef.current === epoch && contextKeyRef.current === key;
  const isCurrentObject = (epoch: number, key: string) => objectEpochRef.current === epoch && objectKeyRef.current === key;
  const isCurrentIntent = (intent: WriteIntent) => isCurrent(intent.contextEpoch, intent.contextKey) && isCurrentObject(intent.objectEpoch, intent.objectKey);
  const subjectOf = (intent: WriteIntent) => pendingWriteSubject(intent.actorId, intent.sessionId, intent.target, intent.operation);

  const updateRecovery = (next: RecoveryState | null) => {
    const previous = recoveryRef.current;
    if (next && previous && next.intent.idempotencyKey !== previous.intent.idempotencyKey) lookupSeqRef.current += 1;
    recoveryRef.current = next;
    setRecovery(next);
    setLookup({ state: "idle" });
  };

  const hydrateFromRecord = (record: PendingApprovalWrite) => {
    updateRecovery({
      kind: record.kind,
      persisted: record.persisted,
      intent: {
        actorId: record.actorId,
        sessionId: record.sessionId,
        target: record.target,
        objectKey: objectKeyRef.current,
        objectEpoch: objectEpochRef.current,
        contextKey,
        contextEpoch,
        path: record.path,
        operation: record.operation,
        targetRequestId: TARGET_SCOPED_OPERATIONS.has(record.operation) && typeof record.body.requestId === "string" ? record.body.requestId : null,
        method: "POST",
        body: record.body,
        idempotencyKey: record.idempotencyKey,
        successMessage: record.successMessage,
        readback: record.readback,
      },
    });
  };

  const PERMISSION_FOR_OPERATION: Record<string, string> = {
    "approval.request.decide": "approval.request.approve",
  };

  const rehydrateRecovery = useCallback(() => {
    if (recoveryRef.current) return;
    const records = findPendingWrites(snapshot.adminUserId, snapshot.session.id);
    if (records.length === 0) { setPendingOthers(0); return; }
    const target = objectKeyRef.current;
    const match = target ? records.find((record) => record.target === target) : records[records.length - 1];
    if (!match) { setPendingOthers(records.length); return; }
    const needed = PERMISSION_FOR_OPERATION[match.operation];
    if (needed && !hasPermission(snapshot, needed)) { setPendingOthers(records.length); return; }
    setPendingOthers(records.filter((record) => record.subject !== match.subject).length);
    hydrateFromRecord(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextEpoch, contextKey, snapshot.adminUserId, snapshot.session.id]);

  useEffect(() => {
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
    seqRef.current.list += 1;
    seqRef.current.detail += 1;
    pageMetaRef.current = emptyPage();
    writeInFlightRef.current = false;
    readbackInFlightRef.current = false;
    lookupInFlightRef.current = false;
    setLoading(false);
    updateRecovery(null);
    setRequests([]);
    setPendingCount(undefined);
    setDetail(undefined);
    setDetailFresh(false);
    setPageMeta(pageMetaRef.current);
    setReadingList(false);
    setError(undefined);
    setMessage(undefined);
  }, [contextKey]);

  const beginObject = (requestId?: string) => {
    const nextObjectKey = requestId ?? "";
    if (objectKeyRef.current === nextObjectKey) return;
    const switching = objectKeyRef.current !== "";
    objectKeyRef.current = nextObjectKey;
    objectEpochRef.current += 1;
    writeInFlightRef.current = false;
    readbackInFlightRef.current = false;
    lookupInFlightRef.current = false;
    setLoading(false);
    if (switching) updateRecovery(null);
    setDetail(undefined);
    setDetailFresh(false);
    setError(undefined);
    setMessage(undefined);
  };

  /** 统一列表接口：范围 + 类型/状态/申请人/时间筛选 + 游标分页。 */
  const loadList = useCallback(async (target?: { cursors: (string | null)[]; index: number }): Promise<boolean> => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const meta = target
      ? { cursors: target.cursors, index: target.index, nextCursor: pageMetaRef.current.nextCursor }
      : pageMetaRef.current;
    const cursor = meta.cursors[meta.index];
    const seq = ++seqRef.current.list;
    setReadingList(true);
    try {
      const filter = filtersRef.current;
      const params = new URLSearchParams({ scope: scopeRef.current, limit: "50" });
      if (filter.operationCode) params.set("operationCode", filter.operationCode);
      if (filter.status) params.set("status", filter.status);
      if (filter.requester) params.set("requester", filter.requester);
      if (filter.timeFrom) params.set("timeFrom", filter.timeFrom);
      if (filter.timeTo) params.set("timeTo", filter.timeTo);
      if (cursor) params.set("cursor", cursor);
      const data = await adminRequest<{ requests?: RequestSummary[]; nextCursor?: string | null; scope?: string; pendingCount?: number }>("/security/approvals/requests?" + params.toString());
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current.list !== seq) return false;
      setRequests(data.requests ?? []);
      setPendingCount(typeof data.pendingCount === "number" ? data.pendingCount : undefined);
      const nextCursor = data.nextCursor ?? null;
      pageMetaRef.current = { cursors: meta.cursors, index: meta.index, nextCursor };
      setPageMeta(pageMetaRef.current);
      return true;
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.list === seq) setError(friendlyError(failure));
      return false;
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.list === seq) setReadingList(false);
    }
  }, [contextEpoch, contextKey]);

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
      rehydrateRecovery();
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

  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    if (objectOnly) return;
    pageMetaRef.current = emptyPage();
    void loadList({ cursors: [null], index: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadList, refreshNonce, scope, filtersKey]);

  useEffect(() => {
    if (initialRequestId) void loadDetail(initialRequestId);
    else beginObject();
  }, [initialRequestId, loadDetail]);

  useEffect(() => {
    rehydrateRecovery();
  }, [rehydrateRecovery, contextKey, initialRequestId]);

  const navigate = (action: "prev" | "next" | "first") => {
    const meta = pageMetaRef.current;
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
    void loadList({ cursors, index });
  };

  const applyFilters = (next: ListFilter) => setFilters(next);
  const applyScope = (next: ListScope) => setScope(next);

  const performReadback = useCallback(async (target: ReadbackTarget): Promise<boolean> => {
    if (target.kind === "templates" || target.kind === "lists") return loadList();
    const detailOk = await loadDetail(target.requestId);
    const listOk = await loadList();
    return detailOk && listOk;
  }, [loadDetail, loadList]);

  const makeWriteIntent = useCallback((path: string, body: Record<string, unknown>, successMessage: string, readback: ReadbackTarget, afterPost?: () => void, stepUp?: ApprovalStepUp): WriteIntent => {
    const operation = APPROVAL_WRITE_PATHS[path] ?? "";
    const candidateRequestId = typeof body.requestId === "string" ? body.requestId : null;
    return {
      actorId: snapshot.adminUserId,
      sessionId: snapshot.session.id,
      target: candidateRequestId ?? "",
      objectKey: objectKeyRef.current,
      objectEpoch: objectEpochRef.current,
      contextKey,
      contextEpoch,
      path,
      operation,
      targetRequestId: TARGET_SCOPED_OPERATIONS.has(operation) ? candidateRequestId : null,
      method: "POST",
      body,
      idempotencyKey: `idem_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll("-", "")}`,
      successMessage,
      readback,
      afterPost,
      stepUp,
    };
  }, [contextEpoch, contextKey, snapshot.adminUserId, snapshot.session.id]);

  const submitWrite = useCallback(async (intent: WriteIntent, recovering = false) => {
    if (!isCurrentIntent(intent) || writeInFlightRef.current || readbackInFlightRef.current || lookupInFlightRef.current) return;
    if (recoveryRef.current && !recovering) return;
    const subject = subjectOf(intent);
    if (!recovering) {
      const inspection = inspectPending(subject);
      if (inspection.state === "unreadable") {
        setError(inspection.reason === "corrupt"
          ? "已有一条同类请求的记录读不出可信内容。为避免覆盖可能仍在途的原请求，本次未提交；请联系管理员按原请求标识核对。"
          : "浏览器存储不可用，无法保留这笔请求的结果未知责任；为避免无法核对的重复写，本次未提交。");
        return;
      }
      if (inspection.state === "valid") {
        hydrateFromRecord(inspection.record);
        setError("已有一笔未核清的同类请求。请先查询原结果或用原请求重试，不能换请求重新提交。");
        return;
      }
      const saved = savePendingWrite({
        actorId: intent.actorId, sessionId: intent.sessionId, target: intent.target, operation: intent.operation,
        path: intent.path, idempotencyKey: intent.idempotencyKey, body: intent.body, readback: intent.readback,
        successMessage: intent.successMessage, kind: "unknown",
      });
      if (!saved.ok) {
        if (saved.existing) {
          hydrateFromRecord(saved.existing);
          setError("已有一笔未核清的同类请求。请先查询原结果或用原请求重试，不能换请求重新提交。");
        } else {
          setError(saved.reason === "corrupt-record"
            ? "已有一条同类请求的记录读不出可信内容；本次未提交，请联系管理员核对。"
            : "浏览器存储不可用，无法保留这笔请求的结果未知责任；本次未提交。");
        }
        return;
      }
    }
    writeInFlightRef.current = true;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest(intent.path, intent.stepUp ? { ...intent.body, ...intent.stepUp } : intent.body, intent.method, { "idempotency-key": intent.idempotencyKey });
      if (!isCurrentIntent(intent)) return;
      intent.afterPost?.();
      const readbackOk = await performReadback(intent.readback);
      if (!isCurrentIntent(intent)) return;
      if (readbackOk) {
        dropPendingWrite(subject, intent.idempotencyKey);
        updateRecovery(null);
        setMessage(intent.successMessage);
      } else {
        const downgraded = updatePendingWriteKind(subject, intent.idempotencyKey, "readback");
        updateRecovery({ kind: "readback", intent: { ...intent, stepUp: undefined }, persisted: downgraded?.persisted ?? false });
        setError(undefined);
        setMessage(`${intent.successMessage} 已成功，最新状态未确认。`, "warning");
      }
    } catch (failure) {
      if (!isCurrentIntent(intent)) return;
      if (isUnknownWriteError(failure)) {
        updateRecovery({ kind: "unknown", intent: { ...intent, stepUp: undefined }, persisted: inspectPending(subject).state === "valid" ? (inspectPending(subject) as { record: PendingApprovalWrite }).record.persisted : false });
        setMessage(undefined);
        setError("请求结果未知：服务端可能已处理；仅可使用原请求重试或查询原结果，不要换请求重试。");
      } else if (recovering) {
        updateRecovery({ kind: "unknown", intent: { ...intent, stepUp: undefined }, persisted: inspectPending(subject).state === "valid" ? (inspectPending(subject) as { record: PendingApprovalWrite }).record.persisted : false });
        setError(`${friendlyError(failure)} 重放被拒不代表第一次写没有发生；原结果仍未核清。`);
      } else {
        dropPendingWrite(subject, intent.idempotencyKey);
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

  const retryUnknown = (stepUp?: ApprovalStepUp) => {
    const current = recoveryRef.current;
    if (current?.kind !== "unknown") return;
    void submitWrite({ ...current.intent, stepUp }, true);
  };

  const dismissRecovery = () => {
    if (!recoveryRef.current) return;
    updateRecovery(null);
    setError(undefined);
  };

  const retryReadback = async () => {
    const current = recoveryRef.current;
    if ((current?.kind !== "readback" && current?.kind !== "resolved") || readbackInFlightRef.current) return;
    if (!isCurrentIntent(current.intent)) return;
    readbackInFlightRef.current = true;
    setError(undefined);
    setLoading(true);
    try {
      const readbackOk = await performReadback(current.intent.readback);
      if (!isCurrentIntent(current.intent)) return;
      if (readbackOk) {
        dropPendingWrite(subjectOf(current.intent), current.intent.idempotencyKey);
        updateRecovery(null);
        setMessage(current.kind === "resolved" && current.receipt
          ? recoveryOutcomeSummary(current.receipt)
          : `${current.intent.successMessage} 最新状态已读取，可按当前资格继续处理。`,
          current.kind === "resolved" && current.receipt?.outcome === "REJECTED" ? "warning" : undefined);
      } else {
        setError(undefined);
        setMessage(current.kind === "resolved" && current.receipt
          ? recoveryOutcomeUnconfirmedSummary(current.receipt)
          : `${current.intent.successMessage} 已成功，最新状态未确认。`, "warning");
      }
    } finally {
      if (isCurrentIntent(current.intent)) {
        readbackInFlightRef.current = false;
        setLoading(false);
      }
    }
  };

  const lookupRecovery = async () => {
    const current = recoveryRef.current;
    if (!current || lookupInFlightRef.current || writeInFlightRef.current || readbackInFlightRef.current) return;
    const intent = current.intent;
    if (!isCurrentIntent(intent)) return;
    if (!intent.operation) {
      setLookup({ state: "error", message: "这次请求没有对应的恢复操作白名单值，无法查询原结果。" });
      return;
    }
    const seq = ++lookupSeqRef.current;
    const bound = { key: intent.idempotencyKey, operation: intent.operation, target: intent.targetRequestId };
    const stillCurrent = () => lookupSeqRef.current === seq
      && recoveryRef.current?.intent.idempotencyKey === bound.key
      && recoveryRef.current?.intent.operation === bound.operation
      && (recoveryRef.current?.intent.targetRequestId ?? null) === (bound.target ?? null);
    lookupInFlightRef.current = true;
    setLookup({ state: "loading" });
    const params = new URLSearchParams({ operation: bound.operation, key: bound.key });
    if (bound.target) params.set("requestId", bound.target);
    try {
      const result = await adminRequest<RecoveryResult>("/security/approvals/recovery?" + params.toString());
      if (!stillCurrent()) return;
      const matches = result.key === bound.key && result.operation === bound.operation && (result.targetRequestId ?? null) === (bound.target ?? null);
      if (!matches) {
        setLookup({ state: "error", message: "回执的标识、操作或目标与当前未决操作不一致；按读取失败处理，原责任保留。" });
        return;
      }
      if (result.knowledge === "KNOWN") {
        const issue = receiptEnvelopeIssue(result, bound);
        if (issue) {
          setLookup({ state: "error", message: `${issue}；不能据此判定原请求结果，责任保留。` });
          return;
        }
        dropPendingWrite(subjectOf(intent), bound.key);
        updateRecovery({ kind: "resolved", intent, persisted: true, receipt: result });
        setLookup({ state: "known", result });
        const refreshed = await performReadback(intent.readback);
        if (!isCurrentIntent(intent)) return;
        if (refreshed) {
          updateRecovery(null);
          setError(undefined);
          setMessage(recoveryOutcomeSummary(result), result.outcome === "REJECTED" ? "warning" : undefined);
        } else {
          setError(recoveryOutcomeUnconfirmedSummary(result));
        }
      } else {
        setLookup({ state: "not_found", result });
      }
    } catch (failure) {
      if (!stillCurrent()) return;
      if (failure instanceof AdminApiError && failure.status === 403) setLookup({ state: "denied", message: friendlyError(failure) });
      else if (failure instanceof AdminApiError && failure.status === 404) setLookup({ state: "error", message: `${friendlyError(failure)}（目标申请读不到，恢复授权无法核对）` });
      else setLookup({ state: "error", message: friendlyError(failure) });
    } finally {
      if (lookupSeqRef.current === seq) lookupInFlightRef.current = false;
    }
  };

  const readbackTarget = (requestId: string): ReadbackTarget =>
    objectOnly ? { kind: "detail-and-lists", requestId, keys: [] } : { kind: "detail-and-lists", requestId, keys: ["mine"] };

  /** 决定：不带 password；仅高影响类型批准时带 totpCode；驳回不带。 */
  const decide = (decision: "APPROVE" | "REJECT", reasonText: string, totpCode?: string, amendment?: import("./approval/contract").ApprovalDecisionAmendment) => {
    const current = detail;
    if (!current) return;
    const successMessage = decision === "APPROVE"
      ? current.operation.code === "order.compensation.grant" ? "已批准赔偿，入账结果以本次回执和订单记录为准。" : "已记录批准；业务是否生效以领域结果为准。"
      : "已驳回；原申请关闭，如需再次办理请由来源业务重新发起。";
    const body: Record<string, unknown> = {
      requestId: current.requestId,
      decision,
      ...(reasonText ? { reason: reasonText } : {}),
      ...(decision === "APPROVE" && amendment ? amendment : {}),
    };
    const stepUp: ApprovalStepUp | undefined = decision === "APPROVE" && totpCode && isHighImpactOperation(current.operation.code) ? { totpCode } : undefined;
    void submitWrite(makeWriteIntent("/security/approvals/requests/decision", body, successMessage, readbackTarget(current.requestId), undefined, stepUp));
  };

  /** 撤回：不带 password / totpCode。 */
  const withdraw = (reasonText: string) => {
    const current = detail;
    if (!current) return;
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/withdraw",
      { requestId: current.requestId, ...(reasonText ? { reason: reasonText } : {}) },
      "申请已撤回，审批人不能再处理。",
      readbackTarget(current.requestId),
    ));
  };

  const selectRequest = (requestId: string, title?: string) => {
    if (onOpenObject) {
      onOpenObject(requestId, title ?? "审批详情");
      return;
    }
    setError(undefined);
    void loadDetail(requestId);
  };

  const locateRecovery = () => {
    recoveryPanelElement.current?.scrollIntoView?.({ block: "nearest" });
    recoveryPanelElement.current?.focus();
  };

  const recoveryRequiresTotp = Boolean(recovery
    && recovery.intent.operation === "approval.request.decide"
    && recovery.intent.body.decision === "APPROVE"
    && isHighImpactOperation(detail?.operation.code));

  const recoveryPanel = recovery ? (
    <div ref={recoveryPanelElement} tabIndex={-1} aria-label="原结果核对" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <RecoveryPanel
        key={`${recovery.intent.sessionId}:${recovery.intent.idempotencyKey}`}
        requiresStepUp={recoveryRequiresTotp}
        kind={recovery.kind}
        lookup={lookup}
        busy={loading}
        lookupBusy={lookup.state === "loading"}
        onRetryWrite={retryUnknown}
        onRetryReadback={() => void retryReadback()}
        onLookup={() => void lookupRecovery()}
        onDiscard={dismissRecovery}
        others={pendingOthers}
      />
    </div>
  ) : null;

  if (!canRead && !canApprove && !canAudit) {
    return (
      <section className="section-panel">
        <StatusMessage tone="warning" error="当前账号没有审批读取或办理权限。" />
      </section>
    );
  }

  if (objectOnly) {
    return (
      <TooltipProvider>
        <div className="space-y-6">
          <StatusMessage error={error} success={message} tone={error ? undefined : messageTone} />
          {recoveryPanel}
          {detail && detailFresh ? (
            <section className="section-panel">
              <RequestDetailPanel
                detail={detail}
                busy={loading}
                blocked={recovery !== null && recovery.kind !== "resolved"}
                canApprove={canApprove}
                onOpenRequest={selectRequest}
                onOpenPath={onOpenPath}
                onLocateRecovery={locateRecovery}
                onDecide={decide}
                onWithdraw={withdraw}
              />
            </section>
          ) : (
            <p className="text-xs text-muted-foreground">{error ? "审批详情读取失败。" : "正在读取审批详情…"}</p>
          )}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <section className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>审批中心</h3>
              <p>先核对申请事项，再办理当前允许的动作；批准与业务结果分别确认。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {typeof pendingCount === "number" && pendingCount > 0 ? <span className="text-xs text-muted-foreground">待我处理 {pendingCount} 件</span> : null}
              <Button type="button" size="sm" variant={showRules ? "primary" : "secondary"} aria-label="查看规则说明" onClick={() => setShowRules((value) => !value)}>
                {showRules ? <><ArrowLeft size={14} aria-hidden /> 返回列表</> : <><ClipboardCheck size={14} aria-hidden /> 规则说明</>}
              </Button>
              <Icons.ShieldCheck size={20} className="text-muted-foreground" />
            </div>
          </div>
          <StatusMessage error={error} success={message} tone={error ? undefined : messageTone} className="mt-4" />
          {recoveryPanel}
        </section>

        {showRules ? (
          <section className="section-panel">
            <div className="panel-heading">
              <div>
                <h3>规则说明</h3>
                <p>哪些业务走审批、由谁提交、由谁批准、批准后如何生效，以及从哪里发起。</p>
              </div>
            </div>
            <div className="mt-4"><RulesTable /></div>
          </section>
        ) : (
          <section className="section-panel">
            <div className="panel-heading">
              <div>
                <h3>申请列表</h3>
                <p>默认看待我处理（客服看与我相关）；可按类型、状态、申请人、时间筛选，每行写清申请人。</p>
              </div>
            </div>
            <div className="mt-4">
              <RequestList
                items={requests}
                busy={readingList}
                emptyNote="当前没有符合条件的申请。"
                onOpen={selectRequest}
                scope={scope}
                onScopeChange={applyScope}
                canSeeAll={snapshot.security.isBoss}
                filters={filters}
                onFiltersChange={applyFilters}
              />
            </div>
            <PagePager loadedCount={requests.length} page={pageMeta} busy={readingList} onPrev={() => navigate("prev")} onNext={() => navigate("next")} onFirst={() => navigate("first")} />
          </section>
        )}

        {!showRules && detail && detailFresh ? (
          <section className="section-panel">
            <RequestDetailPanel
              detail={detail}
              busy={loading}
              blocked={recovery !== null && recovery.kind !== "resolved"}
              canApprove={canApprove}
              onOpenRequest={selectRequest}
              onOpenPath={onOpenPath}
              onLocateRecovery={locateRecovery}
              onDecide={decide}
              onWithdraw={withdraw}
            />
          </section>
        ) : null}

      </div>
    </TooltipProvider>
  );
}
