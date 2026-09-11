import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import {
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

const statusLabels: Record<string, string> = {
  PENDING: "待审批",
  APPROVED: "已同意，待执行",
  REJECTED: "已拒绝",
  CANCELLED: "已终止",
  EXPIRED: "已过期",
  EXECUTED: "已执行",
  EXECUTION_FAILED: "执行失败",
};

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

export function ApprovalAuditView({
  snapshot,
  initialRequestId,
  initialTab,
  objectOnly = false,
  onOpenObject,
  onTabChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialRequestId?: string;
  initialTab?: "mine" | "pending" | "templates" | "audit";
  objectOnly?: boolean;
  onOpenObject?: (requestId: string, title: string) => void;
  onTabChange?: (tab: "mine" | "pending" | "templates" | "audit") => void;
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

  const load = useCallback(async () => {
    const tasks: Promise<void>[] = [];
    if (canTemplateRead) tasks.push(adminRequest<{ templates?: Template[] }>("/security/approvals/templates").then((data) => setTemplates(data.templates ?? [])));
    if (canRead) tasks.push(adminRequest<{ requests?: RequestSummary[] }>("/security/approvals/requests/mine?limit=50").then((data) => setMine(data.requests ?? [])));
    if (canApprove) tasks.push(adminRequest<{ requests?: RequestSummary[] }>("/security/approvals/requests/pending?limit=50").then((data) => setPending(data.requests ?? [])));
    if (canAudit) tasks.push(adminRequest<{ events?: AuditEvent[] }>("/security/approvals/audit/events?limit=50").then((data) => setAudit(data.events ?? [])));
    if (canReadAdmins) tasks.push(adminRequest<{ admins?: AdminDirectoryEntry[] }>("/security/admins").then((data) => setAdmins(data.admins ?? [])));
    await Promise.all(tasks);
  }, [canApprove, canAudit, canRead, canReadAdmins, canTemplateRead]);

  const loadDetail = useCallback(async (requestId: string) => {
    setDetail(await adminRequest<RequestDetail>("/security/approvals/requests/detail?requestId=" + encodeURIComponent(requestId)));
  }, []);

  useEffect(() => {
    void load().catch((failure) => setError(friendlyError(failure)));
  }, [load, refreshNonce]);

  useEffect(() => {
    if (initialRequestId) void loadDetail(initialRequestId).catch((failure) => setError(friendlyError(failure)));
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

  const run = async (action: () => Promise<void>, success: string) => {
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await action();
      await load();
      setMessage(success);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const configure = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run(async () => {
      await adminRequest("/security/approvals/templates/update", { operationCode, triggerCondition, candidateUsernames });
    }, "审批模板已保存；只影响之后新建的申请。正在途申请保留原版本与名单快照。");
  };

  const createRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run(async () => {
      await adminRequest("/security/approvals/requests", { operationCode, triggerCondition, payloadVersion: 1, payload: { outcome }, summary });
      setSummary("");
    }, "申请已提交。审批同意不代表执行完成或资金到账。");
  };

  const decide = async (decision: "APPROVE" | "REJECT") => {
    if (!detail) return;
    await run(async () => {
      await adminRequest("/security/approvals/requests/decision", { requestId: detail.requestId, decision, ...(rejectReason ? { reason: rejectReason } : {}) });
      await loadDetail(detail.requestId);
    }, decision === "APPROVE" ? "已记录首个有效同意。后续执行仍是独立步骤。" : "已拒绝；如需再次申请，请新建申请，不会复活原审批。");
  };

  const append = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    await run(async () => {
      await adminRequest("/security/approvals/requests/add-candidate", { requestId: detail.requestId, username: appendUsername, reason });
      await loadDetail(detail.requestId);
      setAppendUsername("");
      setReason("");
    }, "已追加当前仍具备审批资格的审批人；原配置名单未删除或跳过。");
  };

  const execute = async () => {
    if (!detail) return;
    await run(async () => {
      await adminRequest("/security/approvals/requests/execute", { requestId: detail.requestId });
      await loadDetail(detail.requestId);
    }, "执行结果已单独记录；请以执行状态查看结果。");
  };

  const selectRequest = async (requestId: string, title?: string) => {
    if (onOpenObject) {
      onOpenObject(requestId, title ?? "审批详情");
      return;
    }
    setError(undefined);
    try {
      await loadDetail(requestId);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };

  if (!canTemplateRead && !canCreate && !canRead && !canApprove && !canAudit) {
    return <section className="section-panel"><StatusMessage error="当前账号没有审批或审批审计读取权限。" /></section>;
  }

  if (objectOnly) {
    return (
      <div className="space-y-6">
        <StatusMessage error={error} success={message} />
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
            <div className="mt-5"><h4 className="text-xs font-semibold mb-2">候选审批人</h4><div className="flex flex-wrap gap-2">{detail.candidates.map((candidate) => <span key={candidate.username + "-" + (candidate.source ?? "template")} className={"status-badge " + (candidate.eligible ? "success" : "warning")}>{personLabel(candidate)} · {candidate.eligible ? "当前可审批" : candidate.status === "FROZEN" ? "已冻结" : "当前无资格"}{candidate.source === "APPENDED" ? " · 追加" : " · 模板"}</span>)}</div></div>
            {detail.decision ? <p className="text-xs mt-4">决定：{detail.decision.decision === "APPROVED" ? "同意" : "拒绝"}，由 {personLabel(detail.decision.approver)} 于 {formatDate(detail.decision.createdAt)} 记录。{detail.decision.reason ? "原因：" + detail.decision.reason : ""}</p> : null}
            {detail.execution ? <p className={"text-xs mt-2 " + (detail.execution.status === "SUCCEEDED" ? "text-emerald-400" : "text-rose-400")}>执行：{detail.execution.status === "SUCCEEDED" ? "成功" : "失败"}，结果码 {detail.execution.resultCode}；{detail.execution.resultDetail ?? "无附加说明"}</p> : null}
            <div className="flex flex-wrap gap-2 mt-4">
              {canApprove && detail.status === "PENDING" ? <><Button type="button" size="sm" loading={loading} onClick={() => void decide("APPROVE")}>同意</Button><Button type="button" size="sm" variant="danger" loading={loading} onClick={() => void decide("REJECT")} disabled={rejectReason.trim().length < 3}>拒绝</Button><input value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} className="h-8 min-w-56 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="拒绝原因（至少 3 字）" /></> : null}
              {canExecute && detail.status === "APPROVED" ? <Button type="button" size="sm" loading={loading} onClick={() => void execute()}>执行本地测试动作</Button> : null}
            </div>
            {canAddApprover && detail.status === "PENDING" ? <form onSubmit={append} className="flex flex-wrap items-end gap-2 mt-5 pt-4 border-t border-border"><label className="space-y-1 text-xs"><span className="text-muted-foreground block">追加当前合格审批人</span><select value={appendUsername} onChange={(event) => setAppendUsername(event.target.value)} className="h-8 min-w-56 px-2 rounded border border-border bg-surface-raised text-xs" required><option value="">选择账号</option>{admins.map((admin) => <option key={admin.id} value={admin.username}>{personLabel({ name: admin.name, username: admin.username })}</option>)}</select></label><input value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 min-w-56 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="追加原因" required /><Button type="submit" size="sm" variant="secondary" loading={loading} disabled={!appendUsername || reason.trim().length < 3}>追加审批人</Button></form> : null}
            <div className="mt-5"><h4 className="text-xs font-semibold mb-2">状态历史</h4><div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>动作</th><th>账号</th><th>结果</th><th>说明</th></tr></thead><tbody>{detail.history.map((event) => <tr key={event.eventId}><td>{formatDate(event.occurredAt)}</td><td className="font-mono">{event.action}</td><td>{personLabel(event.actor)}</td><td>{event.outcome}</td><td>{event.reason ?? prettyDetails(event.details)}</td></tr>)}</tbody></table></div></div>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="section-panel">
        <div className="panel-heading">
          <div><h3>审批与授权审计</h3><p>仅覆盖明确配置的操作。审批决定、实际执行和审计记录彼此独立，页面不会把同意显示成资金到账。</p></div>
          <Icons.ShieldCheck size={20} className="text-muted-foreground" />
        </div>
        <div className="flex flex-wrap gap-2 mt-4" role="tablist" aria-label="审批工作区">
          {canRead ? <Button type="button" size="sm" variant={tab === "mine" ? "primary" : "secondary"} onClick={() => { setTab("mine"); onTabChange?.("mine"); }}>我的申请</Button> : null}
          {canApprove ? <Button type="button" size="sm" variant={tab === "pending" ? "primary" : "secondary"} onClick={() => { setTab("pending"); onTabChange?.("pending"); }}>待我审批</Button> : null}
          {canTemplateRead || canTemplateConfigure ? <Button type="button" size="sm" variant={tab === "templates" ? "primary" : "secondary"} onClick={() => { setTab("templates"); onTabChange?.("templates"); }}>模板配置</Button> : null}
          {canAudit ? <Button type="button" size="sm" variant={tab === "audit" ? "primary" : "secondary"} onClick={() => { setTab("audit"); onTabChange?.("audit"); }}>审计记录</Button> : null}
        </div>
        <StatusMessage error={error} success={message} className="mt-4" />
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
          {canTemplateRead ? <section className="section-panel"><div className="panel-heading"><div><h3>当前模板</h3><p>模板版本只用于新申请；在途申请展示自己的快照版本。</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>操作</th><th>触发条件</th><th>版本</th><th>候选审批人</th></tr></thead><tbody>{templates.map((template) => <tr key={template.id}><td className="font-mono">{template.operationCode}</td><td className="font-mono">{template.triggerCondition}</td><td>{template.version}</td><td>{template.candidates.map((candidate) => personLabel(candidate)).join("、")}</td></tr>)}</tbody></table></div></section> : null}
        </>
      ) : null}

      {tab === "mine" && canCreate ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>新建申请</h3><p>本包的可执行演示动作是本地非资金测试动作；载荷保存为不可变版本与哈希。</p></div></div>
          <form onSubmit={createRequest} className="space-y-4" noValidate>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">操作</span><input value={operationCode} onChange={(event) => setOperationCode(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required /></label>
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">触发条件</span><input value={triggerCondition} onChange={(event) => setTriggerCondition(event.target.value)} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono" required /></label>
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">测试动作结果</span><select value={outcome} onChange={(event) => setOutcome(event.target.value as "SUCCESS" | "FAILURE")} className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs"><option value="SUCCESS">成功</option><option value="FAILURE">失败（可追溯）</option></select></label>
            </div>
            <label className="space-y-1 text-xs block"><span className="text-muted-foreground">业务摘要</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs" placeholder="说明本次明确操作，不填写内部 ID" required /></label>
            <Button type="submit" size="sm" loading={loading} disabled={summary.trim().length < 3}>提交审批申请</Button>
          </form>
        </section>
      ) : null}

      {tab === "mine" || tab === "pending" ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>{tab === "mine" ? "我的申请" : "待我审批"}</h3><p>{tab === "mine" ? "仅显示当前账号发起的申请。" : "仅显示当前账号仍具备权限、未冻结且不属于自审的候选申请。"}</p></div></div>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>业务摘要</th><th>发起人</th><th>状态</th><th>创建时间</th><th>到期时间</th></tr></thead><tbody>{(tab === "mine" ? mine : pending).map((item) => <tr key={item.requestId} onClick={() => void selectRequest(item.requestId, item.summary)}><td><strong>{item.summary}</strong><div className="text-[11px] text-muted-foreground font-mono">{item.operationCode} · v{item.payloadVersion}</div></td><td>{personLabel(item.requester)}</td><td className={statusTone(item.status)}>{statusLabel(item.status)}{item.statusReason ? <div className="text-[11px] text-muted-foreground">{item.statusReason}</div> : null}</td><td>{formatDate(item.createdAt)}</td><td>{formatDate(item.expiresAt)}</td></tr>)}</tbody></table></div>
          {(tab === "mine" ? mine : pending).length === 0 ? <p className="text-xs text-muted-foreground mt-4">暂无记录。</p> : null}
        </section>
      ) : null}

      {detail && (tab === "mine" || tab === "pending") ? (
        <section className="section-panel">
          <div className="panel-heading"><div><h3>申请详情与历史</h3><p>申请载荷、模板版本、候选名单和决定历史均来自服务端快照。</p></div><span className={"text-sm font-medium " + statusTone(detail.status)}>{statusLabel(detail.status)}</span></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-2"><p><span className="text-muted-foreground">业务摘要：</span>{detail.summary}</p><p><span className="text-muted-foreground">发起人：</span>{personLabel(detail.requester)}</p><p><span className="text-muted-foreground">操作：</span><span className="font-mono">{detail.operation.code}</span> / <span className="font-mono">{detail.operation.triggerCondition}</span></p><p><span className="text-muted-foreground">载荷版本 / 哈希：</span>{detail.operation.payloadVersion} / <span className="font-mono break-all">{detail.operation.payloadHash}</span></p><p><span className="text-muted-foreground">模板快照版本：</span>{detail.template.version}</p><p><span className="text-muted-foreground">有效期：</span>{formatDate(detail.expiresAt)}</p>{detail.statusReason ? <p className="text-amber-300">{detail.statusReason}</p> : null}</div>
            <div className="rounded border border-border bg-surface-soft p-3"><p className="text-muted-foreground mb-2">不可变测试载荷（不含资金字段）</p><pre className="font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(detail.operation.payload ?? {}, null, 2)}</pre></div>
          </div>
          <div className="mt-5"><h4 className="text-xs font-semibold mb-2">候选审批人</h4><div className="flex flex-wrap gap-2">{detail.candidates.map((candidate) => <span key={candidate.username + "-" + (candidate.source ?? "template")} className={"status-badge " + (candidate.eligible ? "success" : "warning")}>{personLabel(candidate)} · {candidate.eligible ? "当前可审批" : candidate.status === "FROZEN" ? "已冻结" : "当前无资格"}{candidate.source === "APPENDED" ? " · 追加" : " · 模板"}</span>)}</div></div>
          {detail.decision ? <p className="text-xs mt-4">决定：{detail.decision.decision === "APPROVED" ? "同意" : "拒绝"}，由 {personLabel(detail.decision.approver)} 于 {formatDate(detail.decision.createdAt)} 记录。{detail.decision.reason ? "原因：" + detail.decision.reason : ""}</p> : null}
          {detail.execution ? <p className={"text-xs mt-2 " + (detail.execution.status === "SUCCEEDED" ? "text-emerald-400" : "text-rose-400")}>执行：{detail.execution.status === "SUCCEEDED" ? "成功" : "失败"}，结果码 {detail.execution.resultCode}；{detail.execution.resultDetail ?? "无附加说明"}</p> : null}
          <div className="flex flex-wrap gap-2 mt-4">
            {canApprove && detail.status === "PENDING" ? <><Button type="button" size="sm" loading={loading} onClick={() => void decide("APPROVE")}>同意</Button><Button type="button" size="sm" variant="danger" loading={loading} onClick={() => void decide("REJECT")} disabled={rejectReason.trim().length < 3}>拒绝</Button><input value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} className="h-8 min-w-56 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="拒绝原因（至少 3 字）" /></> : null}
            {canExecute && detail.status === "APPROVED" ? <Button type="button" size="sm" loading={loading} onClick={() => void execute()}>执行本地测试动作</Button> : null}
          </div>
          {canAddApprover && detail.status === "PENDING" ? <form onSubmit={append} className="flex flex-wrap items-end gap-2 mt-5 pt-4 border-t border-border"><label className="space-y-1 text-xs"><span className="text-muted-foreground block">追加当前合格审批人</span><select value={appendUsername} onChange={(event) => setAppendUsername(event.target.value)} className="h-8 min-w-56 px-2 rounded border border-border bg-surface-raised text-xs" required><option value="">选择账号</option>{admins.map((admin) => <option key={admin.id} value={admin.username}>{personLabel({ name: admin.name, username: admin.username })}</option>)}</select></label><input value={reason} onChange={(event) => setReason(event.target.value)} className="h-8 min-w-56 px-3 rounded border border-border bg-surface-raised text-xs" placeholder="追加原因" required /><Button type="submit" size="sm" variant="secondary" loading={loading} disabled={!appendUsername || reason.trim().length < 3}>追加审批人</Button></form> : null}
          <div className="mt-5"><h4 className="text-xs font-semibold mb-2">状态历史</h4><div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>动作</th><th>账号</th><th>结果</th><th>说明</th></tr></thead><tbody>{detail.history.map((event) => <tr key={event.eventId}><td>{formatDate(event.occurredAt)}</td><td className="font-mono">{event.action}</td><td>{personLabel(event.actor)}</td><td>{event.outcome}</td><td>{event.reason ?? prettyDetails(event.details)}</td></tr>)}</tbody></table></div></div>
        </section>
      ) : null}

      {tab === "audit" && canAudit ? <section className="section-panel"><div className="panel-heading"><div><h3>授权审批审计</h3><p>按当前读取权限和对象范围分页读取；敏感字段已在 API 层裁剪，只有追加记录，没有改删入口。</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>业务说明</th></tr></thead><tbody>{audit.map((event) => <tr key={event.eventId}><td>{formatDate(event.occurredAt)}</td><td>{personLabel(event.actor)}</td><td className="font-mono">{event.action}</td><td className="font-mono">{event.objectType}</td><td>{event.outcome}</td><td>{event.reason ?? prettyDetails(event.details)}</td></tr>)}</tbody></table></div>{audit.length === 0 ? <p className="text-xs text-muted-foreground mt-4">暂无授权审批审计。</p> : null}</section> : null}
      {allRequests.length > 0 && detail && tab === "audit" ? <p className="text-xs text-muted-foreground">已有申请可在“我的申请”或“待我审批”中打开详情。</p> : null}
    </div>
  );
}
