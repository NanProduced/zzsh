import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ClipboardCheck, TriangleAlert } from "lucide-react";

import { Icons } from "../components/icons";
import { ListPagination } from "../components/admin-list";
import { formatApprovalDate as formatDate } from "./approval/atoms";
import { Button, StatusMessage } from "../components/ui-elements";
import { Badge, InlineStatus } from "../components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { TooltipProvider } from "../components/ui/tooltip";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle,
} from "../components/ui/dialog";
import {
  AdminApiError, adminRequest, friendlyError, hasPermission,
  type SessionSnapshot,
} from "../api";
import {
  AUDIT_ACTIONS, AUDIT_OBJECT_TYPES, auditActionLabel, auditNarrative, auditObjectLabel,
  auditOutcomeView, auditScopeLabel, executionModeLabel, personLabel, receiptEnvelopeIssue,
  recoveryOutcomeSummary, recoveryOutcomeUnconfirmedSummary, reasonLabel, relatedRequestIdOf,
  type AuditEvent, type CandidateOptions, type OperationEntry, type ReadbackTarget, type RecoveryResult,
  type RequestDetail, type RequestSummary, type Template,
} from "./approval/contract";
import {
  APPROVAL_WRITE_PATHS, dropPendingWrite, findPendingWrites, inspectPending, pendingWriteSubject,
  savePendingWrite, updatePendingWriteKind, type PendingApprovalWrite,
} from "./approval/pending-writes";
import { RequestDetail as RequestDetailPanel } from "./approval/request-detail";
import { RequestList } from "./approval/request-list";
import { RecoveryPanel, type RecoveryLookup } from "./approval/recovery-panel";
import { Fact, FactGrid, FieldLabel, NotApplicable } from "./approval/atoms";

type Tab = "pending" | "mine" | "audit" | "settings";
type ListKey = "mine" | "pending" | "audit";
type ListPage = { cursors: (string | null)[]; index: number; nextCursor: string | null };
type AuditFilter = { action: string; objectType: string; actorUsername: string; requestId: string };
type WriteIntent = {
  actorId: string;
  sessionId: string;
  /** 责任记录的目标分域：申请号，或模板写的 operationCode|triggerCondition。 */
  target: string;
  objectKey: string;
  objectEpoch: number;
  contextKey: string;
  contextEpoch: number;
  path: string;
  /** 恢复合同的操作白名单值；由 path 推出，target 型操作另带申请号。 */
  operation: string;
  targetRequestId: string | null;
  method: "POST";
  body: Record<string, unknown>;
  idempotencyKey: string;
  successMessage: string;
  readback: ReadbackTarget;
  afterPost?: () => void;
  /** 实时复核凭据（密码 + TOTP）：仅内存携带，不进 sessionStorage 待核对记录。 */
  stepUp?: { password: string; totpCode: string };
};
type RecoveryState = { kind: "unknown" | "readback" | "resolved"; intent: WriteIntent; persisted: boolean; receipt?: RecoveryResult };

const TABS: Tab[] = ["pending", "mine", "audit", "settings"];
const TAB_LABELS: Record<Tab, string> = { pending: "待我处理", mine: "我的申请", audit: "审计记录", settings: "审批设置" };
const ALL = "all";

/** 恢复合同的操作白名单（approval-audit.ts:95-104）。target 型操作必须带申请号，非 target 型不能带。 */
/** 政策类发布由服务端固定要求 Boss 审批；模板页只作说明，不改变服务端判定。 */
const BOSS_FIXED_OPERATIONS = new Set(["distribution.policy.publish", "membership.benefit.policy.publish"]);

const TARGET_SCOPED_OPERATIONS = new Set(["approval.request.decide", "approval.request.add_candidate", "approval.request.execute", "approval.request.withdraw"]);

/**
 * 已核实有发起入口的业务页（membership-growth-admin-host.tsx:122 政策发布、:128 礼遇发放）。
 * 只用于导航，不参与任何授权判断；replace/revoke 尚未接入发起入口，见 operations 面板的缺口说明。
 * 服务端 initiation 未返回入口提示，这一映射作为合同缺口登记给 Master。
 */
const INITIATION_ENTRY: Record<string, { label: string; path?: string }> = {
  "membership.benefit.policy.publish": { label: "会员成长页 · 政策草稿提交审批", path: "/membership-growth" },
  "membership.entitlement.grant": { label: "会员成长页 · 礼遇发放提交审批", path: "/membership-growth" },
  "membership.entitlement.replace": { label: "尚未接入发起入口（会员礼遇页需补替换提交）" },
  "membership.entitlement.revoke": { label: "尚未接入发起入口（会员礼遇明细需补撤销提交）" },
  "order.settlement.adjust": { label: "由订单结算流程在结算事务内发起，审批页不可发起" },
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

const emptyAuditFilter: AuditFilter = { action: "", objectType: "", actorUsername: "", requestId: "" };

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

function PagePager({ page, loadedCount, busy, onPrev, onNext, onFirst }: { page: ListPage; loadedCount: number; busy: boolean; onPrev: () => void; onNext: () => void; onFirst: () => void }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground"><span>第 {page.index + 1} 页</span>{page.index > 0 ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onFirst}>回到首页</Button> : null}</div>
      <ListPagination mode="cursor" pageSize={50} pageSizeOptions={[50]} loadedCount={loadedCount} itemLabel="条申请或记录" loading={busy} hasPrevious={page.index > 0} hasNext={Boolean(page.nextCursor)} onPrevious={onPrev} onNext={onNext} onPageSizeChange={() => undefined} />
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
  onOpenPath,
  onTabChange,
  onQueryChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialRequestId?: string;
  initialTab?: Tab | "operations" | "templates";
  initialQuery?: Record<string, string>;
  objectOnly?: boolean;
  onOpenObject?: (requestId: string, title: string) => void;
  /**
   * 打开来源业务对象（订单、会员成长页等）。壳侧现有 onOpenObject 被硬编码成
   * /approvals/:requestId，无法承担跨对象导航；page-content.tsx 作用域内已有同签名的
   * onOpenPath，透传即可（见交付 brief 的壳 hunk）。未透传时相关入口退化为不可点标识。
   */
  onOpenPath?: (path: string, title: string) => void;
  onTabChange?: (tab: Tab) => void;
  onQueryChange?: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const canTemplateRead = hasPermission(snapshot, "approval.template.read");
  const canTemplateConfigure = hasPermission(snapshot, "approval.template.configure");
  const canRead = hasPermission(snapshot, "approval.request.read");
  const canApprove = hasPermission(snapshot, "approval.request.approve");
  const canExecute = hasPermission(snapshot, "approval.request.execute");
  const canAudit = hasPermission(snapshot, "approval.audit.read");
  const contextKey = JSON.stringify([contextKeyOf(snapshot), initialRequestId ?? ""]);
  const contextKeyRef = useRef(contextKey);
  const contextEpochRef = useRef(0);
  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    contextEpochRef.current += 1;
  }
  const contextEpoch = contextEpochRef.current;

  // 默认页：有审批权限的人进「待我处理」，只有读取权限的人进「我的申请」。
  const urlTab = initialQuery?.tab ?? initialTab;
  const defaultTab: Tab = canApprove ? "pending" : canRead ? "mine" : canTemplateRead || canTemplateConfigure ? "settings" : canAudit ? "audit" : "settings";
  const [tab, setTab] = useState<Tab>(
    urlTab === "operations" || urlTab === "templates" ? "settings"
      : urlTab && (TABS as string[]).includes(urlTab) ? (urlTab as Tab) : defaultTab,
  );
  const [settingsSection, setSettingsSection] = useState<"registry" | "templates">(
    urlTab === "templates" || (!canRead && (canTemplateRead || canTemplateConfigure)) ? "templates" : "registry",
  );
  const [templates, setTemplates] = useState<Template[]>([]);
  const [operations, setOperations] = useState<OperationEntry[]>();
  const [operationsNote, setOperationsNote] = useState<string>();
  const [candidateOptions, setCandidateOptions] = useState<CandidateOptions | null>(null);
  const [candidateNote, setCandidateNote] = useState<string>();
  const candidatesTriedRef = useRef(false);
  const [mine, setMine] = useState<RequestSummary[]>([]);
  const [pending, setPending] = useState<RequestSummary[]>([]);
  const [detail, setDetail] = useState<RequestDetail>();
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [operationCode, setOperationCode] = useState("");
  const [triggerCondition, setTriggerCondition] = useState("");
  const [newTrigger, setNewTrigger] = useState("");
  const [candidateUsernames, setCandidateUsernames] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [message, setMessageState] = useState<string>();
  const [messageTone, setMessageTone] = useState<"warning" | "info">();
  const setMessage = useCallback((value: string | undefined, tone?: "warning" | "info") => {
    setMessageState(value);
    setMessageTone(tone);
  }, []);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ kind: "template" } | null>(null);
  const [detailFresh, setDetailFresh] = useState(false);
  const recoveryPanelElement = useRef<HTMLDivElement>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [lookup, setLookup] = useState<RecoveryLookup>({ state: "idle" });
  const [pageMeta, setPageMeta] = useState<Record<ListKey, ListPage>>(emptyPageMeta);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>(() => auditFilterFromQuery(initialQuery));
  const [auditDraft, setAuditDraft] = useState<AuditFilter>(() => auditFilterFromQuery(initialQuery));
  const [auditScope, setAuditScope] = useState<string>();

  const pageMetaRef = useRef(pageMeta);
  const auditFilterRef = useRef(auditFilter);
  const previousAuditQueryKeyRef = useRef(auditFilterKey(auditFilterFromQuery(initialQuery)));
  const seqRef = useRef<Record<ListKey | "detail" | "templates" | "operations" | "candidates", number>>({ mine: 0, pending: 0, audit: 0, detail: 0, templates: 0, operations: 0, candidates: 0 });
  const mountedRef = useRef(true);
  const previousContextKeyRef = useRef(contextKey);
  const objectKeyRef = useRef(initialRequestId ?? "");
  const objectEpochRef = useRef(0);
  const writeInFlightRef = useRef(false);
  const readbackInFlightRef = useRef(false);
  const lookupInFlightRef = useRef(false);
  const recoveryRef = useRef<RecoveryState | null>(null);

  const isCurrent = (epoch: number, key: string) => mountedRef.current && contextEpochRef.current === epoch && contextKeyRef.current === key;
  const isCurrentObject = (epoch: number, key: string) => objectEpochRef.current === epoch && objectKeyRef.current === key;
  const isCurrentIntent = (intent: WriteIntent) => isCurrent(intent.contextEpoch, intent.contextKey) && isCurrentObject(intent.objectEpoch, intent.objectKey);
  const lookupSeqRef = useRef(0);
  const [pendingOthers, setPendingOthers] = useState(0);

  const updateRecovery = (next: RecoveryState | null) => {
    const previous = recoveryRef.current;
    // 换成另一笔未决操作时，旧查询的迟到结果不得写回新面板。
    if (next && previous && next.intent.idempotencyKey !== previous.intent.idempotencyKey) lookupSeqRef.current += 1;
    recoveryRef.current = next;
    setRecovery(next);
    setLookup({ state: "idle" });
  };

  const subjectOf = (intent: WriteIntent) => pendingWriteSubject(intent.actorId, intent.sessionId, intent.target, intent.operation);

  /** 由责任记录重建未决面板；收起或切走后再次进入同一目标会走这里。 */
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

  /** 恢复面板需要的当前权限；失权期间隐藏面板但记录保留。 */
  const PERMISSION_FOR_OPERATION: Record<string, string> = {
    "approval.request.decide": "approval.request.approve",
    "approval.request.execute": "approval.request.execute",
    "approval.request.add_candidate": "approval.request.add_approver",
    "approval.request.create": "approval.request.create",
    "approval.template.configure": "approval.template.configure",
  };

  /**
   * 回到原身份+会话时从责任记录恢复未核清状态。记录不因切身份、切对象或收起面板而删除，
   * 只有终态证据（读回核实、已知回执、首次提交被明确拒绝）才 drop。
   */
  const rehydrateRecovery = useCallback(() => {
    if (recoveryRef.current) return;
    const records = findPendingWrites(snapshot.adminUserId, snapshot.session.id);
    if (records.length === 0) { setPendingOthers(0); return; }
    const target = objectKeyRef.current;
    const match = target ? records.find((record) => record.target === target) : records[records.length - 1];
    if (!match) { setPendingOthers(records.length); return; }
    const needed = PERMISSION_FOR_OPERATION[match.operation];
    if (needed && !hasPermission(snapshot, needed)) {
      setPendingOthers(records.length);
      return;
    }
    setPendingOthers(records.filter((record) => record.subject !== match.subject).length);
    hydrateFromRecord(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextEpoch, contextKey, snapshot.adminUserId, snapshot.session.id]);


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
    lookupInFlightRef.current = false;
    setLoading(false);
    // 未核清的恢复责任属于原身份与原对象；切身份时清空投影，但不代表责任已核清。
    updateRecovery(null);
    setTemplates([]);
    setOperations(undefined);
    setOperationsNote(undefined);
    setCandidateOptions(null);
    setCandidateNote(undefined);
    candidatesTriedRef.current = false;
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
    setOperationCode("");
    setTriggerCondition("");
    setNewTrigger("");
    setCandidateUsernames([]);
  }, [contextKey]);

  const beginObject = (requestId?: string) => {
    const nextObjectKey = requestId ?? "";
    if (objectKeyRef.current === nextObjectKey) return;
    // 只有真正的对象切换才隐藏面板；首次挂载要保留从责任记录恢复的状态。
    const switching = objectKeyRef.current !== "";
    objectKeyRef.current = nextObjectKey;
    objectEpochRef.current += 1;
    writeInFlightRef.current = false;
    readbackInFlightRef.current = false;
    lookupInFlightRef.current = false;
    setLoading(false);
    if (switching) updateRecovery(null);
    setConfirm(null);
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

  const loadOperations = useCallback(async (): Promise<boolean> => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const seq = ++seqRef.current.operations;
    setReading((current) => ({ ...current, operations: true }));
    try {
      const data = await adminRequest<{ operations?: OperationEntry[]; unregisteredOperationPolicy?: string }>("/security/approvals/operations");
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current.operations !== seq) return false;
      setOperations(data.operations ?? []);
      setOperationsNote(data.unregisteredOperationPolicy);
      return true;
    } catch (failure) {
      // 运行中的 API 可能早于该接口：404 记为未接入，不当作页面级错误盖住其他面板。
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.operations === seq) {
        setOperations(undefined);
        setOperationsNote(failure instanceof AdminApiError && failure.status === 404
          ? "业务登记读取未接入：当前 API 没有装配该接口。"
          : failure instanceof AdminApiError && failure.status === 403
            ? "业务登记读取当前需要审批申请读取权限，本岗位没有该权限；因此模板表单暂时列不出可配置的业务，这不是系统未部署。需要为模板配置岗位开放一项最小业务读取后才会可用。"
            : friendlyError(failure));
      }
      return false;
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.operations === seq) setReading((current) => ({ ...current, operations: false }));
    }
  }, [contextEpoch, contextKey]);

  /** 模板配置的候选人读取：审批专用接口，不要求全管理员目录权限。失败只影响该表单，不上升为整页错误。 */
  const loadCandidateOptions = useCallback(async (): Promise<boolean> => {
    const requestEpoch = contextEpoch;
    const requestContextKey = contextKey;
    if (!isCurrent(requestEpoch, requestContextKey)) return false;
    const seq = ++seqRef.current.candidates;
    setReading((current) => ({ ...current, candidates: true }));
    try {
      const data = await adminRequest<CandidateOptions>("/security/approvals/candidate-options");
      if (!isCurrent(requestEpoch, requestContextKey) || seqRef.current.candidates !== seq) return false;
      setCandidateOptions(data);
      setCandidateNote(undefined);
      return true;
    } catch (failure) {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.candidates === seq) {
        setCandidateOptions(null);
        setCandidateNote(failure instanceof AdminApiError && failure.status === 404
          ? "可选审批人能力暂未接入，无法列出可追加或可配置的审批人；请联系管理员确认接入进度。"
          : failure instanceof AdminApiError && failure.status === 403
            ? "当前账号没有读取可选审批人的权限，无法列出可追加或可配置的审批人。"
            : friendlyError(failure));
      }
      return false;
    } finally {
      if (isCurrent(requestEpoch, requestContextKey) && seqRef.current.candidates === seq) setReading((current) => ({ ...current, candidates: false }));
    }
  }, [contextEpoch, contextKey]);

  const load = useCallback(async (): Promise<boolean> => {
    const tasks: Promise<boolean>[] = [];
    if (canTemplateRead) tasks.push(loadTemplates());
    if (canRead) tasks.push(loadList("mine"));
    if (canRead || canTemplateConfigure) tasks.push(loadOperations());
    if (canApprove) tasks.push(loadList("pending"));
    if (canAudit) tasks.push(loadList("audit"));
    return (await Promise.all(tasks)).every(Boolean);
  }, [canApprove, canAudit, canRead, canTemplateRead, loadList, loadOperations, loadTemplates]);

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

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    if (initialRequestId) void loadDetail(initialRequestId);
    else beginObject();
  }, [initialRequestId, loadDetail]);

  // 声明在 loadDetail 之后：beginObject 会推进对象 epoch，恢复出的意图必须拿到推进后的 epoch。
  useEffect(() => {
    rehydrateRecovery();
  }, [rehydrateRecovery, contextKey, initialRequestId]);

  useEffect(() => {
    if (objectOnly || tab !== "settings" || settingsSection !== "templates" || !canTemplateConfigure) return;
    if (candidatesTriedRef.current || reading.candidates) return;
    candidatesTriedRef.current = true;
    void loadCandidateOptions();
  }, [tab, settingsSection, objectOnly, canTemplateConfigure, reading.candidates, loadCandidateOptions]);

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
    if (target.kind === "templates") {
      const tasks: Promise<boolean>[] = [loadTemplates()];
      if (canTemplateConfigure) tasks.push(loadCandidateOptions());
      if (canRead) tasks.push(loadOperations());
      return (await Promise.all(tasks)).every(Boolean);
    }
    if (target.kind === "lists") return (await Promise.all(target.keys.map((key) => loadList(key)))).every(Boolean);
    const detailOk = await loadDetail(target.requestId);
    const listOk = target.keys.length === 0 || (await Promise.all(target.keys.map((key) => loadList(key)))).every(Boolean);
    return detailOk && listOk;
  }, [canRead, canTemplateConfigure, loadCandidateOptions, loadDetail, loadList, loadOperations, loadTemplates]);

  const makeWriteIntent = useCallback((path: string, body: Record<string, unknown>, successMessage: string, readback: ReadbackTarget, afterPost?: () => void, stepUp?: { password: string; totpCode: string }): WriteIntent => {
    const operation = APPROVAL_WRITE_PATHS[path] ?? "";
    const targetRequestId = typeof body.requestId === "string" ? body.requestId : null;
    const target = targetRequestId
      ?? (path === "/security/approvals/templates/update" ? String(body.operationCode ?? "") + "|" + String(body.triggerCondition ?? "") : "");
    return {
      actorId: snapshot.adminUserId,
      sessionId: snapshot.session.id,
      target,
      objectKey: objectKeyRef.current,
      objectEpoch: objectEpochRef.current,
      contextKey,
      contextEpoch,
      path,
      operation,
      // 非 target 型操作带 requestId 会被恢复接口判为 400，因此这里按白名单语义裁剪。
      targetRequestId: TARGET_SCOPED_OPERATIONS.has(operation) ? targetRequestId : null,
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
        // 同一目标还有未核清的原请求：恢复它并阻止换新标识重发。
        hydrateFromRecord(inspection.record);
        setError("已有一笔未核清的同类请求。请先查询原结果或用原请求重试，不能换新标识重新提交。");
        return;
      }
      // 责任记录先落盘并核读成功才允许发出请求。
      const saved = savePendingWrite({
        actorId: intent.actorId, sessionId: intent.sessionId, target: intent.target, operation: intent.operation,
        path: intent.path, idempotencyKey: intent.idempotencyKey, body: intent.body, readback: intent.readback,
        successMessage: intent.successMessage, kind: "unknown",
      });
      if (!saved.ok) {
        if (saved.existing) {
          hydrateFromRecord(saved.existing);
          setError("已有一笔未核清的同类请求。请先查询原结果或用原请求重试，不能换新标识重新提交。");
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
        // 已受理之后只降级 kind；存储故障保留责任，不改成未提交。
        const downgraded = updatePendingWriteKind(subject, intent.idempotencyKey, "readback");
        updateRecovery({ kind: "readback", intent, persisted: downgraded?.persisted ?? false });
        setError(undefined);
        setMessage(`${intent.successMessage} 已成功，最新状态未确认。`, "warning");
      }
    } catch (failure) {
      if (!isCurrentIntent(intent)) return;
      if (isUnknownWriteError(failure)) {
        updateRecovery({ kind: "unknown", intent, persisted: inspectPending(subject).state === "valid" ? (inspectPending(subject) as { record: PendingApprovalWrite }).record.persisted : false });
        setMessage(undefined);
        setError("请求结果未知：服务端可能已处理；仅可使用原请求重试或查询原结果，不要换新标识重试。");
      } else if (recovering) {
        // 重放被拒只说明这次重放不成立（例如提交后撤权），不能证明第一次写没有发生。
        updateRecovery({ kind: "unknown", intent, persisted: inspectPending(subject).state === "valid" ? (inspectPending(subject) as { record: PendingApprovalWrite }).record.persisted : false });
        setError(`${friendlyError(failure)} 重放被拒不代表第一次写没有发生；原结果仍未核清。`);
      } else {
        // 首次提交被服务端明确拒绝是终态证据：这笔责任解除。
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

  const retryUnknown = () => {
    const current = recoveryRef.current;
    if (current?.kind === "unknown") void submitWrite(current.intent, true);
  };

  /** 收起面板不等于核清责任：记录保留，回到原身份/对象时会重新出现。 */
  const dismissRecovery = () => {
    if (!recoveryRef.current) return;
    updateRecovery(null);
    setError(undefined);
  };

  const retryReadback = async () => {
    const current = recoveryRef.current;
    // resolved 也走同一条 GET 读回：只读取最新状态，绝不 POST 重放已核清的命令。
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
        // resolved 已有核实回执：读回仍失败时只补充「最新状态暂未读到」，不拼接原命令成功文案。
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

  /** 原结果恢复：只回答「这把请求标识 → 原回执」，不改写业务状态，也不产生第二次写入。 */
  const lookupRecovery = async () => {
    const current = recoveryRef.current;
    if (!current || lookupInFlightRef.current || writeInFlightRef.current || readbackInFlightRef.current) return;
    const intent = current.intent;
    if (!isCurrentIntent(intent)) return;
    if (!intent.operation) {
      setLookup({ state: "error", message: "这次请求没有对应的恢复操作白名单值，无法查询原结果。" });
      return;
    }
    // 查询绑定发起时的那一笔意图；迟到或串笔的返回一律不写回当前面板。
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
      const matches = result.key === bound.key
        && result.operation === bound.operation
        && (result.targetRequestId ?? null) === (bound.target ?? null);
      if (!matches) {
        setLookup({ state: "error", message: "回执的标识、操作或目标与当前未决操作不一致；按读取失败处理，原责任保留。" });
        return;
      }
      if (result.knowledge === "KNOWN") {
        const issue = receiptEnvelopeIssue(result, bound);
        if (issue) {
          // 信封不完整或自相矛盾时不是终态证据：按读取失败处理，责任保留。
          setLookup({ state: "error", message: `${issue}；不能据此判定原请求结果，责任保留。` });
          return;
        }
        dropPendingWrite(subjectOf(intent), bound.key);
        updateRecovery({ kind: "resolved", intent, persisted: true, receipt: result });
        setLookup({ state: "known", result });
        // 读回结果必须处理：成功就用最新 actions 继续办理并收起回执，失败则保留回执让刷新可重试。
        const refreshed = await performReadback(intent.readback);
        if (!isCurrentIntent(intent)) return;
        if (refreshed) {
          // StatusMessage 以 error 优先，必须先清掉未知写留下的错误，否则结果说明被盖住。
          updateRecovery(null);
          setError(undefined);
          setMessage(recoveryOutcomeSummary(result), result.outcome === "REJECTED" ? "warning" : undefined);
        } else {
          // 与手动刷新共用同一判断：只陈述已核实的回执结果，不说成已读取最新状态。
          setError(recoveryOutcomeUnconfirmedSummary(result));
        }
      } else {
        setLookup({ state: "not_found", result });
      }
    } catch (failure) {
      if (!stillCurrent()) return;
      if (failure instanceof AdminApiError && failure.status === 403) {
        setLookup({ state: "denied", message: friendlyError(failure) });
      } else if (failure instanceof AdminApiError && failure.status === 404) {
        setLookup({ state: "error", message: `${friendlyError(failure)}（目标申请读不到，恢复授权无法核对）` });
      } else {
        setLookup({ state: "error", message: friendlyError(failure) });
      }
    } finally {
      if (lookupSeqRef.current === seq) lookupInFlightRef.current = false;
    }
  };

  /** 选择已有触发条件时用其标识，新建时用输入值；两者互斥，提交与确认弹窗共用同一取值。 */
  const effectiveTrigger = triggerCondition || newTrigger.trim();

  const saveTemplate = () => {
    void submitWrite(makeWriteIntent(
      "/security/approvals/templates/update",
      { operationCode, triggerCondition: effectiveTrigger, candidateUsernames: [...candidateUsernames] },
      "审批模板已保存；只影响之后新建的申请。在途申请保留原版本与名单快照。",
      { kind: "templates" },
    ));
  };

  const configure = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || recoveryRef.current) return;
    setConfirm({ kind: "template" });
  };

  const decide = (decision: "APPROVE" | "REJECT", reason: string, stepUp: { password: string; totpCode: string }, amendment?: import("./approval/contract").ApprovalDecisionAmendment) => {
    const current = detail;
    if (!current) return;
    const successMessage = decision === "APPROVE"
      ? "已记录首个有效批准。执行仍是独立步骤，批准不代表执行完成或资金到账。"
      : "已驳回；原申请关闭且不会复活，如需再次办理请由来源业务重新发起。";
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/decision",
      { requestId: current.requestId, decision, ...(reason ? { reason } : {}), ...(decision === "APPROVE" && amendment ? amendment : {}) },
      successMessage,
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
      undefined,
      stepUp,
    ));
  };

  const append = (username: string, reason: string) => {
    const current = detail;
    if (!current) return;
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/add-candidate",
      { requestId: current.requestId, username, reason },
      "已追加当前仍具备审批资格的审批人；原配置名单未删除或跳过。",
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
    ));
  };

  const execute = (stepUp: { password: string; totpCode: string }) => {
    const current = detail;
    if (!current) return;
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/execute",
      { requestId: current.requestId },
      "执行结果已单独记录；执行成功不代表业务对象已生效或资金已到账，请以领域结果为准。",
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
      undefined,
      stepUp,
    ));
  };

  const withdraw = (reason: string, stepUp: { password: string; totpCode: string }) => {
    const current = detail;
    if (!current) return;
    void submitWrite(makeWriteIntent(
      "/security/approvals/requests/withdraw",
      { requestId: current.requestId, ...(reason ? { reason } : {}) },
      "申请已撤回，审批人不能再处理；撤回已写入审计。",
      { kind: "detail-and-lists", requestId: current.requestId, keys: objectOnly ? [] : [tab === "pending" ? "pending" : "mine"] },
      undefined,
      stepUp,
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

  const recoveryPanel = recovery ? (
    <div ref={recoveryPanelElement} tabIndex={-1} aria-label="原结果核对" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <RecoveryPanel
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

  const locateRecovery = () => {
    recoveryPanelElement.current?.scrollIntoView?.({ block: "nearest" });
    recoveryPanelElement.current?.focus();
  };

  const availableTabs = useMemo(() => TABS.filter((item) => (
    item === "pending" ? canApprove
      : item === "mine" ? canRead
        : item === "audit" ? canAudit
          : canRead || canTemplateRead || canTemplateConfigure
  )), [canApprove, canAudit, canRead, canTemplateConfigure, canTemplateRead]);

  if (availableTabs.length === 0) {
    return (
      <section className="section-panel">
        <StatusMessage tone="warning" error={
          canExecute
            ? "你的账号持有审批执行权限，但没有审批读取权限：审批详情与待处理队列都要求 approval.request.read（待处理队列另要求 approval.request.approve）。因此本页无法显示可执行的事项，需要由来源业务深链进入并由管理员补齐读取授权。"
            : "当前账号没有审批或审批审计读取权限。"
        } />
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
                onLocateRecovery={locateRecovery}
                onOpenRequest={selectRequest}
                onOpenPath={onOpenPath}
                onDecide={decide}
                onExecute={execute}
                onWithdraw={withdraw}
                onAppend={append}
              />
            </section>
          ) : (
            <p className="text-xs text-muted-foreground">{error ? "审批详情读取失败。" : "正在读取审批详情…"}</p>
          )}
        </div>
      </TooltipProvider>
    );
  }

  const listKey: ListKey = tab === "pending" ? "pending" : "mine";
  const listItems = tab === "pending" ? pending : mine;
  const auditActionItems = [{ value: "", label: "全部动作" }, ...AUDIT_ACTIONS.map((action) => ({ value: action, label: auditActionLabel(action) }))];
  const auditObjectItems = [{ value: "", label: "全部对象" }, ...AUDIT_OBJECT_TYPES];
  const selectedOperation = operations?.find((item) => item.operationCode === operationCode);
  const triggerItems = selectedOperation
    ? [{ value: "", label: "新建触发条件标识" }, ...selectedOperation.triggers.map((trigger) => ({ value: trigger.triggerCondition, label: `${trigger.triggerCondition}（模板 v${trigger.templateVersion}）` }))]
    : [{ value: "", label: "新建触发条件标识" }];
  const eligibleCandidates = candidateOptions?.candidates ?? [];
  const excludedEntries = Object.entries(candidateOptions?.excludedByReason ?? {});
  return (
    <TooltipProvider>
      <div className="space-y-6">
        <section className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>审批中心</h3>
              <p>先核对申请事项，再办理当前允许的动作；审批、执行与业务结果分别确认。</p>
            </div>
            <Icons.ShieldCheck size={20} className="text-muted-foreground" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="审批工作区">
            {availableTabs.map(item => <Button key={item} type="button" size="sm" role="tab" aria-selected={tab === item}
              variant={tab === item ? "primary" : item === "pending" || item === "mine" ? "secondary" : "ghost"}
              onClick={() => { setTab(item); onTabChange?.(item); }}>
              {TAB_LABELS[item]}
            </Button>)}
          </div>
          <StatusMessage error={error} success={message} tone={error ? undefined : messageTone} className="mt-4" />
          {recoveryPanel}
        </section>

        {tab === "pending" || tab === "mine" ? (
          <section className="section-panel">
            <div className="panel-heading">
              <div>
                <h3>{tab === "pending" ? "待我处理" : "我的申请"}</h3>
                <p>{tab === "pending"
                  ? "只呈现当前仍具备资格、未冻结且不属于自审的候选申请；已批准、已驳回与已过期记录在「我的申请」与审计记录中查看。"
                  : "仅显示当前账号发起的申请，按创建时间倒序分页读取。"}</p>
              </div>
            </div>
            <div className="mt-4">
              <RequestList
                items={listItems}
                busy={Boolean(reading[listKey])}
                emptyNote={tab === "pending" ? "当前没有等你处理的申请。" : "你还没有发起过审批申请。"}
                onOpen={selectRequest}
              />
            </div>
            <PagePager loadedCount={listItems.length} page={pageMeta[listKey]} busy={Boolean(reading[listKey])} onPrev={() => navigate(listKey, "prev")} onNext={() => navigate(listKey, "next")} onFirst={() => navigate(listKey, "first")} />
          </section>
        ) : null}

        {tab === "pending" || tab === "mine" ? (
          detail && detailFresh ? (
            <section className="section-panel">
              <RequestDetailPanel
                detail={detail}
                busy={loading}
                blocked={recovery !== null && recovery.kind !== "resolved"}
                onLocateRecovery={locateRecovery}
                onOpenRequest={selectRequest}
                onOpenPath={onOpenPath}
                onDecide={decide}
                onExecute={execute}
                onWithdraw={withdraw}
                onAppend={append}
              />
            </section>
          ) : null
        ) : null}

        {tab === "settings" ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="审批设置分区">
            <Button type="button" size="sm" variant={settingsSection === "registry" ? "primary" : "ghost"} onClick={() => setSettingsSection("registry")}>业务登记</Button>
            {(canTemplateRead || canTemplateConfigure) ? (
              <Button type="button" size="sm" variant={settingsSection === "templates" ? "primary" : "ghost"} onClick={() => setSettingsSection("templates")}>模板规则</Button>
            ) : null}
          </div>
        ) : null}
        {tab === "settings" && settingsSection === "registry" ? (
          <section className="section-panel">
            <div className="panel-heading">
              <div>
                <h3>审批业务与发起入口</h3>
                <p>哪些业务走审批、由谁在哪里发起、你当前能不能发起。审批页不代为提交正式业务申请。</p>
              </div>
              <ClipboardCheck size={20} className="text-muted-foreground" aria-hidden />
            </div>
            {reading.operations ? <p className="mt-4 text-xs text-muted-foreground">正在读取…</p> : null}
            {operations === undefined ? (
              <div className="mt-4">
                <NotApplicable reason={operationsNote ?? "业务登记读取不可用。"} />
              </div>
            ) : (
              <>
                <ul className="mt-4 space-y-3">
                  {operations.map((operation) => {
                    const entry = INITIATION_ENTRY[operation.operationCode];
                    return (
                      <li key={operation.operationCode} className="rounded-md border border-border/60 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{operation.title}</span>
                          {operation.testOnly ? <Badge variant="unknown">仅测试</Badge> : null}
                          <Badge variant="outline">{executionModeLabel(operation.executionMode)}</Badge>
                          {operation.initiation.allowed
                            ? <InlineStatus tone="success">当前可发起</InlineStatus>
                            : <InlineStatus tone="neutral">{reasonLabel(operation.initiation.reasonCode)}</InlineStatus>}
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          发起入口：{entry?.label ?? "尚未接入发起入口，本页不代为提交。"}
                          {entry?.path && onOpenPath ? (
                            <Button type="button" size="sm" variant="ghost" className="ml-1.5" onClick={() => onOpenPath(entry.path!, operation.title)}>前往</Button>
                          ) : entry?.path ? (
                            <span className="ml-1.5">（工作区未提供跨对象导航，请从左侧导航进入）</span>
                          ) : null}
                        </p>
                        {operation.triggers.length === 0 ? (
                          <p className="mt-1.5 text-xs text-muted-foreground">尚未配置审批模板；该业务当前无法发起审批。</p>
                        ) : (
                          <ul className="mt-2 space-y-1">
                            {operation.triggers.map((trigger) => (
                              <li key={trigger.triggerCondition} className="text-xs text-muted-foreground">
                                已配置 {trigger.templateVersion} 版模板，候选 {trigger.candidateTotal} 人，其中 {trigger.candidateEligible} 人具备通用资格
                                {trigger.blockingReasonCode ? <span className="ml-1.5 text-foreground">（{reasonLabel(trigger.blockingReasonCode)}）</span> : null}
                              </li>
                            ))}
                          </ul>
                        )}
                        <details className="mt-2 text-[11px] text-muted-foreground">
                          <summary className="cursor-pointer select-none">技术追溯</summary>
                          <p className="mt-1 font-mono break-all">{operation.operationCode}</p>
                          {operation.triggers.map((trigger) => (
                            <p key={trigger.triggerCondition} className="font-mono break-all">{trigger.triggerCondition} · v{trigger.templateVersion}</p>
                          ))}
                        </details>
                      </li>
                    );
                  })}
                </ul>
                {operationsNote ? <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{operationsNote}</p> : null}
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  「具备通用资格」只表示账号状态、双因素与通用审批权限；能不能处理某一单还取决于业务权限与游戏范围。
                </p>
                <Alert variant="warning" role="status" className="mt-4">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>待接：供给规则发布的审批绑定</AlertTitle>
                  <AlertDescription>
                    供给规则发布尚未接入审批流程，接入前不能在此发起；接入范围与排期由管理员协调。本页不提供临时入口或占位按钮绕过。
                  </AlertDescription>
                </Alert>
              </>
            )}
          </section>
        ) : null}

        {tab === "settings" && settingsSection === "templates" && (canTemplateRead || canTemplateConfigure) ? (
          <>
            {canTemplateConfigure ? (
              <section className="section-panel">
                <div className="panel-heading">
                  <div>
                    <h3>配置审批模板</h3>
                    <p>候选组内任一合格人的首个有效决定生效，不是逐级必签。模板更新只影响之后新建的申请，在途申请保留原版本与名单快照。</p>
                  </div>
                </div>
                <form onSubmit={configure} className="mt-4 space-y-4" noValidate>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="block min-w-0">
                      <FieldLabel>业务操作</FieldLabel>
                      {operations === undefined ? (
                        <NotApplicable reason={operationsNote ?? "业务登记读取不可用，无法列出可配置的操作；不在此接受手填操作标识，以免为未登记业务建模板。"} />
                      ) : (
                        <Select
                          value={operationCode}
                          items={operations.map((operation) => ({ value: operation.operationCode, label: operation.title }))}
                          onValueChange={(value) => { setOperationCode(value ?? ""); setTriggerCondition(""); setNewTrigger(""); }}
                        >
                          <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue placeholder="选择业务操作" /></SelectTrigger>
                          <SelectContent>
                            {operations.map((operation) => (
                              <SelectItem key={operation.operationCode} value={operation.operationCode}>
                                {operation.title}{operation.testOnly ? "（仅测试）" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {BOSS_FIXED_OPERATIONS.has(operationCode) ? (
                        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Badge variant="outline" className="text-[11px]">本类型固定 Boss 审批</Badge>非 Boss 候选人即使列入名单也不能作出决定。</p>
                      ) : null}
                    </label>
                    <label className="block min-w-0">
                      <FieldLabel>触发条件</FieldLabel>
                      <Select
                        value={triggerCondition}
                        items={triggerItems}
                        onValueChange={(value) => { setTriggerCondition(value ?? ""); setNewTrigger(""); }}
                        disabled={!operationCode}
                      >
                        <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue placeholder={operationCode ? "选择已有或新建触发条件" : "先选择业务操作"} /></SelectTrigger>
                        <SelectContent>
                          {triggerItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                  {operationCode && triggerCondition === "" ? (
                    <label className="block max-w-md">
                      <FieldLabel>新触发条件标识（稳定小写标识，不接受金额阈值或表达式）</FieldLabel>
                      <Input value={newTrigger} onChange={(event) => setNewTrigger(event.target.value)} className="font-mono" placeholder="如 membership.entitlement.grant.requested" />
                    </label>
                  ) : null}
                  <div>
                    <FieldLabel>候选审批人（至少一名；只列出当前具备通用审批资格的人）</FieldLabel>
                    {reading.candidates ? <p className="text-xs text-muted-foreground">正在读取可选审批人…</p> : null}
                    {candidateOptions === null && !reading.candidates ? (
                      <NotApplicable reason={candidateNote
                        ? `${candidateNote} 候选人读取使用审批专用接口，不需要全管理员目录权限；读不到时此处不列出任何人。`
                        : "读不到可选审批人。候选人读取使用审批专用接口，不需要全管理员目录权限；接口未装配或授权不足时此处不列出任何人。"} />
                    ) : null}
                    {candidateOptions ? (
                      eligibleCandidates.length === 0 ? (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          当前没有具备通用审批资格的人可选。
                          {excludedEntries.length > 0 ? `另有 ${excludedEntries.map(([code, count]) => `${count} 人${reasonLabel(code)}`).join("、")}，按合同不列出身份。` : ""}
                        </p>
                      ) : (
                        <>
                          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                            {eligibleCandidates.map((candidate) => (
                              <li key={candidate.username}>
                                <label className="flex items-start gap-2 text-xs">
                                  <Checkbox
                                    checked={candidateUsernames.includes(candidate.username)}
                                    onCheckedChange={(checked) => setCandidateUsernames((current) => checked === true
                                      ? [...current, candidate.username]
                                      : current.filter((value) => value !== candidate.username))}
                                  />
                                  <span className="min-w-0 break-words">
                                    {personLabel(candidate)}
                                    {candidate.isBoss ? <span className="ml-1.5 text-muted-foreground">系统旁路</span> : null}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                          {excludedEntries.length > 0 ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                              另有 {excludedEntries.map(([code, count]) => `${count} 人${reasonLabel(code)}`).join("、")}，按合同不列出身份。通用资格不等于能审某一单。
                            </p>
                          ) : null}
                        </>
                      )
                    ) : null}
                  </div>
                  <Button
                    type="submit" size="sm" loading={loading}
                    disabled={loading || recovery !== null || !operationCode || !effectiveTrigger || candidateUsernames.length < 1}
                  >
                    保存模板
                  </Button>
                </form>
              </section>
            ) : null}
            {canTemplateRead ? (
              <section className="section-panel">
                <div className="panel-heading">
                  <div>
                    <h3>当前模板</h3>
                    <p>模板版本只用于新申请；在途申请展示自己的快照版本。</p>
                  </div>
                </div>
                {reading.templates ? <p className="mt-4 text-xs text-muted-foreground">正在读取…</p> : null}
                {!reading.templates && templates.length === 0 ? <p className="mt-4 text-xs text-muted-foreground">暂无模板配置。</p> : null}
                <div className="table-wrap">
                  <table className="data-table min-w-[760px]">
                    <caption className="sr-only">审批模板列表</caption>
                    <thead>
                      <tr>
                        <th scope="col">业务操作</th>
                        <th scope="col">触发条件</th>
                        <th scope="col">版本</th>
                        <th scope="col">更新时间</th>
                        <th scope="col">候选审批人</th>
                      </tr>
                    </thead>
                    <tbody>
                      {templates.map((template) => {
                        const title = operations?.find((operation) => operation.operationCode === template.operationCode)?.title;
                        return (
                          <tr key={template.id}>
                            <td>{title ?? <InlineStatus tone="unknown">未登记业务</InlineStatus>}{BOSS_FIXED_OPERATIONS.has(template.operationCode) ? <Badge variant="outline" className="ml-1.5 align-middle text-[11px]">本类型固定 Boss 审批</Badge> : null}<span className="mt-0.5 block font-mono text-[11px] break-all text-muted-foreground">{template.operationCode}</span></td>
                            <td className="font-mono text-[11px] break-all">{template.triggerCondition}</td>
                            <td className="whitespace-nowrap">v{template.version}</td>
                            <td className="whitespace-nowrap">{formatDate(template.updatedAt)}</td>
                            <td>
                              <ul className="flex flex-wrap gap-1.5">
                                {template.candidates.map((candidate) => (
                                  <li key={`${candidate.username}-${candidate.source ?? "TEMPLATE"}`}>
                                    <Badge variant={candidate.eligible === true ? "outline" : "unknown"}>
                                      {personLabel(candidate)}
                                      {candidate.eligible === true ? null : <span className="text-muted-foreground">· {candidate.status === "FROZEN" ? "已冻结" : "当前无通用资格"}</span>}
                                    </Badge>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  此处「当前无通用资格」只表示账号状态、双因素或通用审批权限不满足；某一单是否可审还取决于业务权限与游戏范围。
                </p>
              </section>
            ) : null}
          </>
        ) : null}

        {tab === "audit" && canAudit ? (
          <section className="section-panel">
            <div className="panel-heading">
              <div>
                <h3>授权审批审计</h3>
                <p>审计是追加记录，不是全量申请列表：只覆盖已发生的操作，不能用来枚举所有申请；没有改删入口。</p>
              </div>
            </div>
            <form onSubmit={submitAuditFilter} className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" noValidate>
              <label className="block min-w-0">
                <FieldLabel>动作</FieldLabel>
                <Select value={auditDraft.action} items={auditActionItems} onValueChange={(value) => setAuditDraft({ ...auditDraft, action: value ?? "" })}>
                  <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {auditActionItems.map((item) => <SelectItem key={item.value || ALL} value={item.value}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="block min-w-0">
                <FieldLabel>对象类型</FieldLabel>
                <Select value={auditDraft.objectType} items={auditObjectItems} onValueChange={(value) => setAuditDraft({ ...auditDraft, objectType: value ?? "" })}>
                  <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {auditObjectItems.map((item) => <SelectItem key={item.value || ALL} value={item.value}>{item.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              <label className="block min-w-0">
                <FieldLabel>操作者账号</FieldLabel>
                <Input id="approval-audit-actor" value={auditDraft.actorUsername} onChange={(event) => setAuditDraft({ ...auditDraft, actorUsername: event.target.value })} className="h-9" placeholder="如 ZZ00001" />
              </label>
              <label className="block min-w-0">
                <FieldLabel>申请或请求编号（可选）</FieldLabel>
                <Input id="approval-audit-request-id" value={auditDraft.requestId} onChange={(event) => setAuditDraft({ ...auditDraft, requestId: event.target.value })} className="h-9 font-mono" />
              </label>
              <div className="flex items-end gap-2 md:col-span-2 xl:col-span-4">
                <Button type="submit" size="sm" loading={Boolean(reading.audit)}>查询审计</Button>
                <Button
                  type="button" size="sm" variant="secondary"
                  disabled={auditFilterKey(auditDraft) === auditFilterKey(emptyAuditFilter)}
                  onClick={() => applyAuditFilter(emptyAuditFilter, true)}
                >
                  重置条件
                </Button>
              </div>
            </form>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              查询范围：{auditScopeLabel(auditScope)}。审计按时间倒序分页，服务端暂无时间区间筛选；精确追查请用动作、操作者或申请编号。
            </p>
            {reading.audit ? <p className="mt-4 text-xs text-muted-foreground">正在读取…</p> : null}
            <div className="table-wrap">
              <table className="data-table min-w-[900px]">
                <caption className="sr-only">审批与授权审计事件</caption>
                <thead>
                  <tr>
                    <th scope="col">时间</th>
                    <th scope="col">操作者</th>
                    <th scope="col">动作</th>
                    <th scope="col">对象</th>
                    <th scope="col" className="whitespace-nowrap">结果</th>
                    <th scope="col" className="w-24">关联</th>
                    <th scope="col">业务说明</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((event) => {
                    const related = relatedRequestIdOf(event);
                    const outcome = auditOutcomeView(event.outcome);
                    return (
                      <tr key={event.eventId}>
                        <td className="whitespace-nowrap">{formatDate(event.occurredAt)}</td>
                        <td className="whitespace-nowrap">{personLabel(event.actor)}</td>
                        <td>{auditActionLabel(event.action)}<span className="block font-mono text-[11px] text-muted-foreground">{event.action}</span></td>
                        <td>{auditObjectLabel(event.objectType)}{event.objectId ? <span className="block font-mono text-[11px] break-all text-muted-foreground">{event.objectId}</span> : null}</td>
                        <td><InlineStatus tone={outcome.tone}>{outcome.label}</InlineStatus></td>
                        <td className="whitespace-nowrap">
                          {related
                            ? <Button type="button" size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => selectRequest(related, "审批详情")}>查看申请</Button>
                            : <span className="text-[11px] text-muted-foreground">—</span>}
                        </td>
                        <td className="min-w-0">
                          <span className="block break-words">{auditNarrative(event)}</span>
                          <details className="text-[11px] text-muted-foreground">
                            <summary className="cursor-pointer select-none">技术详情</summary>
                            <pre className="mt-1 whitespace-pre-wrap break-words">{Object.entries(event.details ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join("；") || "无附加信息"}</pre>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!reading.audit && !error && audit.length === 0 ? <p className="mt-4 text-xs text-muted-foreground">暂无符合条件的授权审批审计。</p> : null}
            <PagePager loadedCount={audit.length} page={pageMeta.audit} busy={Boolean(reading.audit)} onPrev={() => navigate("audit", "prev")} onNext={() => navigate("audit", "next")} onFirst={() => navigate("audit", "first")} />
          </section>
        ) : null}

        <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
          <DialogContent>
            <DialogTitle>确认保存审批模板</DialogTitle>
            <DialogDescription>模板只影响之后新建的申请；在途申请保留原版本与候选名单快照。</DialogDescription>
            <div className="space-y-3 text-xs">
              <FactGrid>
                <Fact label="业务操作" value={selectedOperation?.title ?? operationCode} />
                <Fact label="操作标识" value={operationCode} mono />
                <Fact label="触发条件" value={effectiveTrigger} mono />
                <Fact label="候选审批人" value={`${candidateUsernames.length} 人（${candidateUsernames.join("、") || "无"}）`} />
              </FactGrid>
              <p className="leading-relaxed text-muted-foreground">
                候选组内任一合格人的首个有效批准或驳回即生效；申请人不能审批自己发起的申请。
              </p>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="secondary" size="sm" />}>取消</DialogClose>
              <Button type="button" size="sm" onClick={() => { setConfirm(null); saveTemplate(); }}>确认保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
