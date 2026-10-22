import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { AdminApiError, adminRequest, formatDate, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Skeleton } from "../components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ListPagination } from "../components/admin-list/list-pagination";
import { ApprovalAuditView } from "./approval-audit-view";
import { receiptEnvelopeIssue, type RecoveryResult, type RequestDetail } from "./approval/contract";
import { dropPendingWrite, inspectPending, pendingWriteSubject, savePendingWrite, updatePendingWriteKind, type PendingInspection } from "./approval/pending-writes";
import { directoryAdapter, EMPTY_FILTERS, type User } from "./user-directory/user-directory-data";
import { MembershipEntitlementForm, type AdminEntitlementDraft, type MembershipEntitlementContext } from "./membership-entitlement-form";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type Entitlement = MembershipEntitlementContext["existingEntitlements"][number];
type Options = { games: { id: string; name: string }[]; capability: { canRead: boolean; canRequest: boolean } };
type EntitlementPage = { schema: "membership-entitlements.v1"; asOfUtc: string; total: number; page: number; pageSize: number; contextKey: string; items: Entitlement[] };
type Filters = { status: string; kind: string; gameId: string; userId: string; userLabel: string; page: number; pageSize: number };
type Editor = { action: "grant" | "replace" | "revoke"; userId: string; userLabel: string; gameId: string; target?: Entitlement };
const STATUSES: Record<string, string> = { ACTIVE: "生效中", EXECUTED_PENDING_START: "未开始", EXPIRED: "已过期", REVOKED: "已撤销", REPLACED: "已替换", PENDING: "待审批", APPROVED_PENDING_EXECUTION: "批准待执行" };
const KINDS: Record<string, string> = { FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" };
const CREATE_PATH = "/security/approvals/requests";
const CREATE_OPERATION = "approval.request.create";
const MEMBERSHIP_OPERATIONS = new Set(["membership.benefit.policy.publish", "membership.entitlement.grant", "membership.entitlement.replace", "membership.entitlement.revoke"]);

function identityOf(snapshot: Snapshot) {
  return JSON.stringify([snapshot.adminUserId, snapshot.session.id, snapshot.session.locked, snapshot.security.status, snapshot.security.isBoss, snapshot.security.passwordChangeRequired, [...snapshot.permissions].sort()]);
}

/** Only existing approval.request.create; policy and entitlement hosts share the same original-key responsibility. */
export function useMembershipApprovalRequest(snapshot: Snapshot) {
  const identity = identityOf(snapshot);
  const subject = pendingWriteSubject(snapshot.adminUserId, snapshot.session.id, "", CREATE_OPERATION);
  const live = useRef(identity); live.current = identity;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [state, setState] = useState(() => ({ identity, busy: false, error: null as string | null, pending: inspectPending(subject), requestId: null as string | null }));
  if (state.identity !== identity) setState({ identity, busy: false, error: null, pending: inspectPending(subject), requestId: null });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && live.current === identity;
  const update = (patch: Partial<typeof state>) => { if (current()) setState(previous => ({ ...previous, ...patch })); };
  const refreshPending = () => inspectPending(subject);

  async function confirm(id: string, key: string, operationCode?: unknown) {
    const detail = await adminRequest<RequestDetail>("/security/approvals/requests/detail?requestId=" + encodeURIComponent(id));
    if (!current()) return false;
    if (detail.requestId !== id || operationCode !== undefined && detail.operationCode !== operationCode) throw new Error("审批详情与原请求不一致，原记录保留");
    dropPendingWrite(subject, key);
    update({ pending: refreshPending(), requestId: id, error: null });
    return true;
  }

  async function submit(body: Record<string, unknown>): Promise<string | null> {
    if (inFlight.current || !current()) return null;
    if (snapshot.session.locked || snapshot.security.status !== "ACTIVE" || snapshot.security.passwordChangeRequired || !snapshot.security.isBoss && !hasPermission(snapshot, "approval.request.create")) { update({ error: "当前身份不能提交审批" }); return null; }
    if (typeof body.operationCode !== "string" || !MEMBERSHIP_OPERATIONS.has(body.operationCode)) { update({ error: "不支持的会员审批操作" }); return null; }
    const existing = refreshPending();
    if (existing.state !== "absent") { update({ pending: existing, error: existing.state === "valid" ? "还有原请求未核清，请先查询原结果" : "原请求记录不可读，本次未提交" }); return null; }
    if (!globalThis.crypto?.randomUUID) { update({ error: "无法生成请求标识，本次未提交" }); return null; }
    const key = "idem_" + crypto.randomUUID().replaceAll("-", "");
    const saved = savePendingWrite({ actorId: snapshot.adminUserId, sessionId: snapshot.session.id, target: "", operation: CREATE_OPERATION, path: CREATE_PATH, idempotencyKey: key, body, readback: { kind: "lists", keys: ["mine"] }, successMessage: "已提交审批", kind: "unknown" });
    if (!saved.ok) { update({ pending: refreshPending(), error: "无法可靠保存原请求标识，本次未提交" }); return null; }
    inFlight.current = true;
    update({ busy: true, error: null, pending: refreshPending(), requestId: null });
    let acceptedId: string | null = null;
    try {
      const result = await adminRequest<{ requestId?: string; approvalRequestId?: string }>(CREATE_PATH, body, "POST", { "idempotency-key": key });
      if (!current()) return null;
      acceptedId = result.approvalRequestId ?? result.requestId ?? null;
      updatePendingWriteKind(subject, key, "readback");
      update({ pending: refreshPending(), requestId: acceptedId });
      if (!acceptedId) throw new Error("审批已受理，但申请编号未读到，请查询原结果");
      await confirm(acceptedId, key, body.operationCode);
      return current() ? acceptedId : null;
    } catch (error) {
      if (!current()) return null;
      const rejected = !acceptedId && error instanceof AdminApiError && error.status >= 400 && error.status < 500 && !error.code.includes("UNKNOWN");
      if (rejected) dropPendingWrite(subject, key);
      update({ pending: refreshPending(), error: rejected ? friendlyError(error) : acceptedId ? "已提交审批，最新详情未确认；请查询原结果" : "提交结果未知，请查询原结果，勿重新办理" });
      return acceptedId;
    } finally { inFlight.current = false; update({ busy: false }); }
  }

  async function recover() {
    if (inFlight.current || !current()) return;
    const pending = refreshPending();
    update({ pending });
    if (pending.state !== "valid") { update({ error: pending.state === "unreadable" ? "原请求记录不可读，请保留现场核对" : null }); return; }
    const original = pending.record;
    inFlight.current = true; update({ busy: true, error: null });
    try {
      const params = new URLSearchParams({ operation: CREATE_OPERATION, key: original.idempotencyKey });
      const result = await adminRequest<RecoveryResult>("/security/approvals/recovery?" + params);
      if (!current()) return;
      if (result.knowledge !== "KNOWN") { update({ error: "原结果尚未核清；没有回执不代表未提交" }); return; }
      const issue = receiptEnvelopeIssue(result, { key: original.idempotencyKey, operation: CREATE_OPERATION, target: null });
      if (issue) { update({ error: issue }); return; }
      if (result.outcome === "REJECTED") {
        dropPendingWrite(subject, original.idempotencyKey);
        update({ pending: refreshPending(), error: "原申请已被明确拒绝，可核对原因后重新办理", requestId: null });
      } else {
        const id = result.receipt?.approvalRequestId;
        if (!id) throw new Error("申请编号缺失");
        updatePendingWriteKind(subject, original.idempotencyKey, "readback");
        update({ pending: refreshPending(), requestId: id });
        await confirm(id, original.idempotencyKey, original.body.operationCode);
      }
    } catch (failure) { update({ pending: refreshPending(), error: failure instanceof AdminApiError && failure.status === 403 ? "当前无权查询原结果，原记录保留" : "原结果或最新详情暂未读到，原记录保留" }); }
    finally { inFlight.current = false; update({ busy: false }); }
  }
  const visible = state.identity === identity ? state : { busy: false, error: null, pending: inspectPending(subject), requestId: null };
  return { submit, recover, busy: visible.busy, error: visible.error, pending: visible.pending, requestId: visible.requestId };
}

function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const title = error instanceof AdminApiError && error.status === 403 ? "无权查看这部分内容" : error instanceof AdminApiError && error.status === 409 ? "读取范围已变化" : "读取失败";
  return <Alert variant="danger"><TriangleAlert aria-hidden /><AlertTitle>{title}</AlertTitle><AlertDescription>{error instanceof AdminApiError && error.status === 409 ? "请重新读取当前范围后继续。" : friendlyError(error)}{retry ? <Button className="mt-2" size="sm" variant="outline" onClick={retry}>重试</Button> : null}</AlertDescription></Alert>;
}

function UserPicker({ snapshot, userId, label, onSelect, disabled }: { snapshot: Snapshot; userId: string; label: string; onSelect: (userId: string, label: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [rows, setRows] = useState<User[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const canSearch = snapshot.security.isBoss || hasPermission(snapshot, "user.directory.read");
  async function search() {
    if (!query.trim() || busy || disabled || !canSearch) return;
    controller.current?.abort(); const read = new AbortController(); controller.current = read;
    setBusy(true); setError(null); setRows([]);
    try {
      const result = await directoryAdapter(snapshot).adapter.list({ ...EMPTY_FILTERS, q: query.trim() }, { page: 1, pageSize: 10 }, read.signal);
      if (!read.signal.aborted) setRows(result.rows);
    } catch (failure) { if (!read.signal.aborted) setError(failure); }
    finally { if (!read.signal.aborted) setBusy(false); }
  }
  if (!canSearch) return <span className="text-xs text-muted-foreground">{userId ? label || "来源用户已选定" : "请从已授权的用户页面进入办理"}</span>;
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="outline" disabled={disabled} />}><Search className="size-3.5" aria-hidden />{userId ? label || "已选用户" : "选择用户"}</PopoverTrigger><PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] space-y-3">
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void search(); }}><Input aria-label="查找用户" placeholder="昵称、用户ID或精确手机号" disabled={disabled} value={query} onChange={event => setQuery(event.target.value)} /><Button type="submit" disabled={busy || disabled || !query.trim()}>{busy ? "查询中" : "查询"}</Button></form>
    {error ? <ErrorBox error={error} /> : null}
    <div className="max-h-60 space-y-1 overflow-y-auto">{rows.map(row => <Button type="button" key={row.id} variant="ghost" disabled={disabled} className="h-auto w-full justify-start whitespace-normal py-2 text-left" onClick={() => { onSelect(row.id, row.name); setOpen(false); }}><span>{row.name}<span className="ml-2 text-xs text-muted-foreground">{row.phoneMasked}</span></span></Button>)}</div>
    {!busy && !error && query && rows.length === 0 ? <p className="text-xs text-muted-foreground">请输入条件并查询，或换个关键词。</p> : null}
  </PopoverContent></Popover>;
}

function Choice({ label, value, options, onChange, disabled, allowAll = true }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void; disabled?: boolean; allowAll?: boolean }) {
  return <label className="flex min-w-32 flex-col gap-1.5 text-xs text-muted-foreground">{label}<Select value={value || (allowAll ? "all" : null)} disabled={disabled} onValueChange={next => { if (next) onChange(next === "all" ? "" : next); }}><SelectTrigger aria-label={label}><SelectValue>{value ? options[value] ?? value : allowAll ? "全部" : "请选择"}</SelectValue></SelectTrigger><SelectContent>{allowAll ? <SelectItem value="all">全部</SelectItem> : null}{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></label>;
}

function draftFrom(target: Entitlement): AdminEntitlementDraft {
  const pricing = target.pricingSummary;
  return { kind: target.kind, scopeKey: target.scopeKey, startsAtUtc: target.startsAtUtc, endsAtUtc: target.endsAtUtc, pricingMode: pricing.knowledge === "KNOWN" ? pricing.mode : "ordinary", payableRatio: pricing.knowledge === "KNOWN" ? pricing.payableRatio : "", priceVersionId: "", costBasisRef: "", depositWaived: target.depositWaived, reason: "" };
}

export type MembershipBenefitsWorkspaceProps = { snapshot: Snapshot; initialUserId?: string; initialGameId?: string; refreshNonce?: number; policy?: ReactNode; onOpenPath?: (path: string, title?: string) => void };

function BenefitsWorkspace({ snapshot, initialUserId, initialGameId, refreshNonce = 0, policy, onOpenPath }: MembershipBenefitsWorkspaceProps) {
  const [tab, setTab] = useState("entitlements"), [reload, setReload] = useState(0);
  const [options, setOptions] = useState<Options | null>(null), [optionsError, setOptionsError] = useState<unknown>(null);
  const [filters, setFilters] = useState<Filters>({ status: "", kind: "", gameId: initialGameId ?? "", userId: initialUserId ?? "", userLabel: initialUserId ? "来源用户" : "", page: 1, pageSize: 20 });
  const [list, setList] = useState<{ key: string; data?: EntitlementPage; loading: boolean; error?: unknown }>({ key: "", loading: true });
  const context = useRef<{ filter: string; key: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null), [editorRetry, setEditorRetry] = useState(0);
  const [form, setForm] = useState<{ key: string; data?: MembershipEntitlementContext; error?: unknown }>({ key: "" });
  const [formError, setFormError] = useState<string | null>(null), [revokeReason, setRevokeReason] = useState("");
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const command = useMembershipApprovalRequest(snapshot);
  const filterKey = JSON.stringify([filters.status, filters.kind, filters.gameId, filters.userId, filters.pageSize]);
  const queryKey = JSON.stringify([filterKey, filters.page]);
  const formKey = editor ? JSON.stringify([editor.userId, editor.gameId, editor.action, editor.target?.id]) : "";
  const currentEditor = useRef(formKey); currentEditor.current = formKey;
  const activeForm = form.key === formKey ? form.data : undefined;
  const formFailure = form.key === formKey ? form.error : undefined;

  useEffect(() => {
    const read = new AbortController(); setOptionsError(null);
    void adminRequest<Options>("/membership-growth/entitlement-options", undefined, "GET", {}, read.signal).then(value => { if (!read.signal.aborted) setOptions(value); }).catch(error => { if (!read.signal.aborted) { setOptions(null); setOptionsError(error); } });
    return () => read.abort();
  }, [reload, refreshNonce]);

  useEffect(() => {
    if (!options?.capability.canRead) return;
    const read = new AbortController();
    setList(previous => ({ key: queryKey, data: previous.key === queryKey ? previous.data : undefined, loading: true }));
    const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
    for (const field of ["status", "kind", "gameId", "userId"] as const) if (filters[field]) params.set(field, filters[field]);
    if (context.current?.filter === filterKey) params.set("contextKey", context.current.key);
    void adminRequest<EntitlementPage>("/membership-growth/entitlements?" + params, undefined, "GET", {}, read.signal).then(data => {
      if (read.signal.aborted) return;
      if (data.schema !== "membership-entitlements.v1" || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== filters.page || data.pageSize !== filters.pageSize || typeof data.contextKey !== "string") throw new Error("礼遇列表响应不完整");
      context.current = { filter: filterKey, key: data.contextKey };
      setList({ key: queryKey, data, loading: false });
    }).catch(error => {
      if (read.signal.aborted) return;
      const reset = error instanceof AdminApiError && [403, 409].includes(error.status);
      if (reset) context.current = null;
      setList(previous => ({ key: queryKey, data: reset ? undefined : previous.key === queryKey ? previous.data : undefined, loading: false, error }));
    });
    return () => read.abort();
  }, [options?.capability.canRead, queryKey, reload, refreshNonce]);

  useEffect(() => {
    if (!editor?.userId || !editor.gameId) return;
    const read = new AbortController(); setForm({ key: formKey }); setFormError(null);
    const params = new URLSearchParams({ userId: editor.userId, gameId: editor.gameId });
    void adminRequest<MembershipEntitlementContext>("/membership-growth/entitlement-context?" + params, undefined, "GET", {}, read.signal).then(data => {
      if (read.signal.aborted) return;
      if (data.schema !== "membership-entitlement-context.v1" || data.subject.userId !== editor.userId || data.game.id !== editor.gameId) throw new Error("礼遇对象已变化，请重新读取");
      if (editor.target && !data.existingEntitlements.some(item => item.id === editor.target!.id && ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status))) throw new Error("原礼遇已变化，请刷新列表后重选");
      setForm({ key: formKey, data });
    }).catch(error => { if (!read.signal.aborted) setForm({ key: formKey, error }); });
    return () => read.abort();
  }, [formKey, editorRetry]);

  function change(patch: Partial<Filters>) { context.current = null; setFilters(previous => ({ ...previous, ...patch, page: 1 })); }
  function openEditor(value?: Entitlement, action: Editor["action"] = "grant") {
    setFormError(null); setRevokeReason("");
    setEditor({ action, userId: value?.userId ?? filters.userId, userLabel: value?.userSummary?.name ?? filters.userLabel, gameId: value?.gameId ?? (filters.gameId || options?.games[0]?.id || ""), ...(value ? { target: value } : {}) });
  }
  async function submitDraft(draft: AdminEntitlementDraft) {
    if (!editor || !activeForm?.approvedMeta) return;
    if (editor.target && (draft.kind !== editor.target.kind || draft.scopeKey !== editor.target.scopeKey)) { setFormError("替换须保留原礼遇类型与范围"); return; }
    if (editor.action === "grant" && activeForm.existingEntitlements.some(item => item.kind === draft.kind && item.scopeKey === draft.scopeKey && ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status))) { setFormError("已有同范围礼遇，请选择下方的替换/续期"); return; }
    const operation = editor.action === "replace" ? "membership.entitlement.replace" : "membership.entitlement.grant";
    const id = await command.submit({ operationCode: operation, triggerCondition: operation + ".requested", payloadVersion: 1, payload: { userId: editor.userId, gameId: editor.gameId, kind: draft.kind, scopeKey: draft.scopeKey, startsAtUtc: draft.startsAtUtc, endsAtUtc: draft.endsAtUtc, policyId: activeForm.approvedMeta.id, pricing: { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode: draft.pricingMode, priceVersionId: draft.priceVersionId, payableRatio: draft.payableRatio, costBasisRef: draft.costBasisRef }, depositWaived: draft.depositWaived, reason: draft.reason, ...(editor.target ? { replaceEntitlementId: editor.target.id } : {}) }, summary: `申请${editor.action === "replace" ? "替换/续期" : "发放"}${KINDS[draft.kind]}` });
    if (id && currentEditor.current === formKey) { setEditor(null); setApprovalId(id); setReload(value => value + 1); }
  }
  async function submitRevoke() {
    if (!editor?.target || revokeReason.trim().length < 2) return;
    const target = editor.target;
    const id = await command.submit({ operationCode: "membership.entitlement.revoke", triggerCondition: "membership.entitlement.revoke.requested", payloadVersion: 1, payload: { entitlementId: target.id, gameId: target.gameId, scopeKey: target.scopeKey, reason: revokeReason.trim() }, summary: `申请撤销${KINDS[target.kind]}` });
    if (id && currentEditor.current === formKey) { setEditor(null); setApprovalId(id); }
  }
  const visible = list.key === queryKey ? list : { loading: true, data: undefined, error: undefined };
  const blocked = command.busy || command.pending.state !== "absent";
  const canRevoke = snapshot.security.isBoss || hasPermission(snapshot, "membership.entitlement.revoke");
  return <div className="space-y-5">
    <Tabs value={tab} onValueChange={value => setTab(String(value))}>
      <TabsList><TabsTrigger value="entitlements">礼遇管理</TabsTrigger>{policy ? <TabsTrigger value="policy">会员政策</TabsTrigger> : null}</TabsList>
      <TabsContent value="entitlements" keepMounted className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">礼遇管理</h2><p className="mt-1 text-xs text-muted-foreground">查看每位用户的实际权益与期限，办理发放、替换或撤销。</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => setReload(value => value + 1)}><RefreshCw aria-hidden />刷新</Button>{options?.capability.canRequest ? <Button disabled={blocked} onClick={() => openEditor()}><Plus aria-hidden />办理礼遇</Button> : null}</div></div>
        {optionsError ? <ErrorBox error={optionsError} retry={() => setReload(value => value + 1)} /> : null}
        {command.error ? <Alert variant="warning"><AlertTitle>{command.error}</AlertTitle></Alert> : null}
        {command.pending.state !== "absent" ? <Alert variant="warning"><AlertTitle>还有原申请需要核对</AlertTitle><AlertDescription>原请求记录保留，核清前不创建新申请。<div className="mt-2 flex gap-2"><Button size="sm" variant="outline" disabled={command.busy || command.pending.state !== "valid"} onClick={() => void command.recover()}>查询原结果</Button><Button size="sm" variant="outline" onClick={() => setApprovalId(command.requestId ?? "")}>查看审批处理</Button></div></AlertDescription></Alert> : command.requestId ? <Alert variant="success"><AlertTitle>已提交审批</AlertTitle><AlertDescription>审批通过后仍需确认业务执行结果。<Button size="sm" variant="link" onClick={() => setApprovalId(command.requestId)}>查看审批</Button></AlertDescription></Alert> : null}
        {!options && !optionsError ? <Skeleton className="h-12 w-full" aria-label="正在读取礼遇权限" /> : null}
        {options?.capability.canRead ? <>
          <div className="flex flex-wrap items-end gap-3"><Choice label="状态" value={filters.status} options={STATUSES} onChange={status => change({ status })} /><Choice label="礼遇类型" value={filters.kind} options={KINDS} onChange={kind => change({ kind })} /><Choice label="游戏" value={filters.gameId} options={Object.fromEntries(options.games.map(game => [game.id, game.name]))} onChange={gameId => change({ gameId })} /><div className="flex items-center gap-1"><UserPicker snapshot={snapshot} userId={filters.userId} label={filters.userLabel} onSelect={(userId, userLabel) => change({ userId, userLabel })} />{filters.userId ? <Button size="sm" variant="ghost" aria-label="清除用户筛选" onClick={() => change({ userId: "", userLabel: "" })}>清除</Button> : null}</div></div>
          {visible.error ? <ErrorBox error={visible.error} retry={() => setReload(value => value + 1)} /> : null}
          <div aria-busy={visible.loading} className="min-h-48">{visible.data ? <>
            {visible.loading ? <p className="mb-2 text-xs text-muted-foreground" role="status">更新中，保留当前记录</p> : null}
            <Table><TableHeader><TableRow><TableHead>用户 / 游戏</TableHead><TableHead>礼遇与优惠</TableHead><TableHead>状态</TableHead><TableHead>生效与到期</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{visible.data.items.map(item => <TableRow key={item.id}><TableCell><div className="font-medium">{item.userSummary?.name ?? "用户资料未授权"}</div>{item.userSummary?.maskedPhone ? <div className="mt-1 text-xs text-muted-foreground">{item.userSummary.maskedPhone}</div> : null}<div className="mt-1 text-xs text-muted-foreground">{item.gameName ?? "游戏名称待核"}</div></TableCell><TableCell><div>{KINDS[item.kind] ?? "未知礼遇"}</div><div className="mt-1 text-xs text-muted-foreground">{item.pricingSummary.knowledge === "KNOWN" ? `总价 × ${item.pricingSummary.payableRatio}` : item.pricingSummary.knowledge === "LEGACY" ? "旧版计价合同" : "优惠待核"} · {item.depositWaived ? "含租客免押" : "不含租客免押"}</div></TableCell><TableCell><Badge variant={item.status === "ACTIVE" ? "success" : item.status === "EXECUTED_PENDING_START" ? "info" : "outline"}>{STATUSES[item.status] ?? "状态待核"}</Badge></TableCell><TableCell className="text-xs"><div>{formatDate(item.startsAtUtc)}</div><div className="mt-1 text-muted-foreground">至 {formatDate(item.endsAtUtc)}</div></TableCell><TableCell><div className="flex flex-wrap justify-end gap-1">{item.approvalRequestId ? <Button size="sm" variant="ghost" onClick={() => setApprovalId(item.approvalRequestId)}>审批</Button> : null}{options.capability.canRequest && ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status) ? <><Button size="sm" variant="outline" disabled={blocked} onClick={() => openEditor(item, "replace")}>替换/续期</Button>{canRevoke ? <Button size="sm" variant="ghost" disabled={blocked} onClick={() => openEditor(item, "revoke")}>申请撤销</Button> : null}</> : null}</div></TableCell></TableRow>)}</TableBody></Table>
            {visible.data.items.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">当前条件下没有礼遇记录</p> : null}
            <ListPagination mode="page" page={visible.data.page} pageSize={visible.data.pageSize} total={visible.data.total} loading={visible.loading} pageSizeOptions={[20, 50, 100]} itemLabel="条礼遇" onPageChange={page => setFilters(previous => ({ ...previous, page }))} onPageSizeChange={pageSize => change({ pageSize })} />
          </> : visible.loading ? <div className="space-y-2" role="status" aria-label="正在读取礼遇记录">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-14 w-full" />)}</div> : null}</div>
        </> : options ? <p className="py-8 text-sm text-muted-foreground">当前没有集中列表读取权限，可从已授权用户办理礼遇。</p> : null}
      </TabsContent>
      {policy ? <TabsContent value="policy" keepMounted>{policy}</TabsContent> : null}
    </Tabs>
    <Sheet open={editor !== null} onOpenChange={open => { if (!open && !command.busy) setEditor(null); }}><SheetContent closeLabel="关闭办理" className="w-full overflow-y-auto sm:max-w-2xl"><SheetHeader><SheetTitle>{editor?.action === "replace" ? "替换/续期礼遇" : editor?.action === "revoke" ? "申请撤销礼遇" : "办理礼遇"}</SheetTitle><SheetDescription>提交后进入审批，批准与权益生效分别确认。</SheetDescription></SheetHeader><div className="space-y-4 px-4 pb-6">
      {editor ? <><div className="flex flex-wrap items-end gap-3">{editor.target ? <span className="text-sm">{editor.userLabel || "已选用户"} · {editor.target.gameName ?? editor.gameId}</span> : <><UserPicker snapshot={snapshot} userId={editor.userId} label={editor.userLabel} disabled={blocked} onSelect={(userId, userLabel) => setEditor({ ...editor, userId, userLabel })} /><Choice label="办理游戏" value={editor.gameId} allowAll={false} disabled={blocked} options={Object.fromEntries((options?.games ?? []).map(game => [game.id, game.name]))} onChange={gameId => setEditor({ ...editor, gameId })} /></>}</div>
        {!editor.userId || !editor.gameId ? <p className="text-xs text-muted-foreground">请先选择用户和游戏。</p> : formFailure ? <ErrorBox error={formFailure} retry={() => setEditorRetry(value => value + 1)} /> : !activeForm ? <Skeleton className="h-52 w-full" aria-label="正在读取办理上下文" /> : editor.action === "revoke" ? <div className="space-y-3"><p className="text-sm">撤销 {KINDS[editor.target!.kind]}，当前状态 {STATUSES[editor.target!.status]}。</p><Textarea aria-label="撤销原因" value={revokeReason} maxLength={500} disabled={blocked} onChange={event => setRevokeReason(event.target.value)} /><Button disabled={blocked || revokeReason.trim().length < 2} onClick={() => void submitRevoke()}>提交撤销审批</Button></div> : <>
          {editor.target ? <p className="text-xs text-muted-foreground">替换保留原用户、游戏、礼遇类型和适用范围，请调整新期限与权益。</p> : null}
          <MembershipEntitlementForm context={activeForm} initial={editor.target ? draftFrom(editor.target) : undefined} busy={blocked} error={formError ?? command.error} onSubmit={submitDraft} />
          {activeForm.existingEntitlements.filter(item => ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status)).length ? <div className="space-y-2 border-t border-border pt-3"><h3 className="text-sm font-medium">已有礼遇</h3>{activeForm.existingEntitlements.filter(item => ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status)).map(item => <div key={item.id} className="flex items-center justify-between gap-3 text-xs"><span>{KINDS[item.kind]} · 至 {formatDate(item.endsAtUtc)}</span><Button size="sm" variant="outline" disabled={blocked} onClick={() => openEditor(item, "replace")}>替换/续期</Button></div>)}</div> : null}
        </>}
      </> : null}
    </div></SheetContent></Sheet>
    <Sheet open={approvalId !== null} onOpenChange={open => { if (!open) { setApprovalId(null); setReload(value => value + 1); } }}><SheetContent closeLabel="关闭审批" className="w-full overflow-y-auto sm:max-w-5xl"><SheetHeader><SheetTitle>审批与办理记录</SheetTitle><SheetDescription>复用现有审批流程、执行和原请求恢复。</SheetDescription></SheetHeader><div className="px-4 pb-6">{approvalId !== null ? <ApprovalAuditView snapshot={snapshot} initialRequestId={approvalId || undefined} objectOnly onOpenPath={onOpenPath} /> : null}</div></SheetContent></Sheet>
  </div>;
}

export function MembershipBenefitsWorkspace(props: MembershipBenefitsWorkspaceProps) {
  if (props.snapshot.session.locked || props.snapshot.security.status !== "ACTIVE" || props.snapshot.security.passwordChangeRequired) return null;
  return <BenefitsWorkspace key={JSON.stringify([identityOf(props.snapshot), props.initialUserId ?? "", props.initialGameId ?? ""])} {...props} />;
}
