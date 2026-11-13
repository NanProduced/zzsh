import { useEffect, useRef, useState, type ReactNode } from "react";
import { Gift, Info, Plus, RefreshCw, RotateCcw, Search, TriangleAlert, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AdminApiError, adminRequest, formatDate, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Skeleton } from "../components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ListPagination } from "../components/admin-list/list-pagination";
import { receiptEnvelopeIssue, statusView, type RecoveryResult, type RequestDetail } from "./approval/contract";
import { dropPendingWrite, inspectPending, pendingWriteSubject, savePendingWrite, updatePendingWriteKind, type PendingInspection } from "./approval/pending-writes";
import { directoryAdapter, EMPTY_FILTERS, REGISTRATION_SORT, REGISTRATION_TIME_ORIGINAL, type User } from "./user-directory/user-directory-data";
import { InfoHint, MembershipEntitlementForm, formatDiscountLabel, formatDepositBenefitText, type AdminEntitlementDraft, type MembershipEntitlementContext } from "./membership-entitlement-form";
import { identityOf, membershipPendingLabel, useMembershipApprovalRequest } from "./membership-benefits-approval";
import { Choice, ErrorBox, UserPicker } from "./membership-benefits-pickers";
export type { MembershipApprovalBusiness, VerifiedPolicyDraftReference } from "./membership-benefits-approval";
export { membershipPendingLabel, policyDraftReferenceOf, useMembershipApprovalRequest } from "./membership-benefits-approval";

const LEGACY_MODE_LABELS: Record<string, string> = { ordinary: "普通", custom: "自定义", fast: "极速" };

function formatEntitlementPricing(pricing: Entitlement["pricingSummary"]): string {
  if (pricing.knowledge === "LEGACY") return "旧版计价合同";
  if (pricing.knowledge !== "KNOWN") return "优惠待核";
  const ratio = pricing.payableRatio;
  const discount = (() => {
    try {
      const formatted = formatDiscountLabel(ratio);
      if (formatted && formatted !== "折扣待核") return formatted;
    } catch {}
    return `总价 × ${ratio}`;
  })();
  if (pricing.scope === "ALL_ENABLED_RENTAL_MODES") return `${discount} · 全部已启用租赁方式统一`;
  if (pricing.mode) return `${discount} · 旧版 ${LEGACY_MODE_LABELS[pricing.mode] ?? pricing.mode}`;
  return discount;
}

function formatEntitlementDeposit(depositWaived: boolean, depositAllowanceCents?: string): string {
  if (depositWaived) return "含租客免押";
  if (depositAllowanceCents && depositAllowanceCents !== "0" && /^[1-9]\d*$/.test(depositAllowanceCents)) {
    const val = BigInt(depositAllowanceCents);
    const whole = val / 100n;
    const rem = val % 100n;
    const yuan = rem === 0n ? whole.toString() : `${whole}.${rem.toString().padStart(2, "0").replace(/0$/, "")}`;
    return `减免押金 ¥${yuan} 元`;
  }
  return "不含租客免押";
}
type Entitlement = MembershipEntitlementContext["existingEntitlements"][number];
type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type Options = { games: { id: string; name: string }[]; capability: { canRead: boolean; canRequest: boolean } };
type EntitlementPage = { schema: "membership-entitlements.v1"; asOfUtc: string; total: number; page: number; pageSize: number; contextKey: string; items: Entitlement[] };
type Filters = { status: string; kind: string; gameId: string; userId: string; userLabel: string; page: number; pageSize: number };
type Editor = { action: "grant" | "replace" | "revoke"; userId: string; userLabel: string; gameId: string; target?: Entitlement };
const STATUSES: Record<string, string> = { ACTIVE: "生效中", EXECUTED_PENDING_START: "未开始", EXPIRED: "已过期", REVOKED: "已撤销", REPLACED: "已替换", PENDING: "待审批", APPROVED_PENDING_EXECUTION: "批准待执行" };
const KINDS: Record<string, string> = { FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" };

function draftFrom(target: Entitlement): AdminEntitlementDraft {
  return { kind: target.kind, scopeKey: target.scopeKey, startsAtUtc: target.startsAtUtc, endsAtUtc: target.endsAtUtc, payableRatio: "", priceVersionId: "", costBasisRef: "", depositWaived: target.depositWaived, reason: "" };
}

export type MembershipBenefitsWorkspaceProps = { snapshot: Snapshot; initialUserId?: string; initialGameId?: string; refreshNonce?: number; initialTab?: "entitlements" | "policy"; policy?: ReactNode; onOpenPath?: (path: string, title?: string) => void };

function BenefitsWorkspace({ snapshot, initialUserId, initialGameId, refreshNonce = 0, initialTab = "entitlements", policy, onOpenPath }: MembershipBenefitsWorkspaceProps) {
  const [tab, setTab] = useState(initialTab === "policy" && policy ? "policy" : "entitlements"), [reload, setReload] = useState(0);
  const [options, setOptions] = useState<Options | null>(null), [optionsError, setOptionsError] = useState<unknown>(null);
  const [filters, setFilters] = useState<Filters>({ status: "", kind: "", gameId: initialGameId ?? "", userId: initialUserId ?? "", userLabel: initialUserId ? "来源用户" : "", page: 1, pageSize: 20 });
  const [list, setList] = useState<{ key: string; data?: EntitlementPage; loading: boolean; error?: unknown }>({ key: "", loading: true });
  const context = useRef<{ filter: string; key: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null), [editorRetry, setEditorRetry] = useState(0);
  const [form, setForm] = useState<{ key: string; data?: MembershipEntitlementContext; error?: unknown }>({ key: "" });
  const [formError, setFormError] = useState<string | null>(null), [revokeReason, setRevokeReason] = useState("");
  const command = useMembershipApprovalRequest(snapshot, "entitlement");
  const openApproval = (id?: string | null) => {
    if (!id || !onOpenPath) return;
    onOpenPath(`/approvals/${encodeURIComponent(id)}?from=membership-growth&fromTab=entitlements`, "审批详情");
  };
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
      setEditor(current => current && current.userId === data.subject.userId ? { ...current, userLabel: data.subject.name ?? current.userLabel } : current);
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
    const id = await command.submit({
      operationCode: operation,
      triggerCondition: operation + ".requested",
      payloadVersion: 1,
      payload: {
        userId: editor.userId,
        gameId: editor.gameId,
        kind: draft.kind,
        scopeKey: draft.scopeKey,
        startsAtUtc: draft.startsAtUtc,
        endsAtUtc: draft.endsAtUtc,
        policyId: activeForm.approvedMeta.id,
        pricing: {
          status: "CONFIGURED",
          kind: "TOTAL_DISCOUNT",
          scope: "ALL_ENABLED_RENTAL_MODES",
          priceVersionId: draft.priceVersionId,
          payableRatio: draft.payableRatio,
          costBasisRef: draft.costBasisRef
        },
        depositWaived: draft.depositWaived,
        depositAllowanceCents: draft.depositWaived ? "0" : (draft.depositAllowanceCents ?? "0"),
        reason: draft.reason,
        ...(editor.target ? { replaceEntitlementId: editor.target.id } : {})
      },
      summary: `申请${editor.action === "replace" ? "替换/续期" : "发放"}${KINDS[draft.kind]}`
    });
    if (id && currentEditor.current === formKey) { setEditor(null); setReload(value => value + 1); }
  }
  async function submitRevoke() {
    if (!editor?.target || revokeReason.trim().length < 2) return;
    const target = editor.target;
    const id = await command.submit({ operationCode: "membership.entitlement.revoke", triggerCondition: "membership.entitlement.revoke.requested", payloadVersion: 1, payload: { entitlementId: target.id, gameId: target.gameId, scopeKey: target.scopeKey, reason: revokeReason.trim() }, summary: `申请撤销${KINDS[target.kind]}` });
    if (id && currentEditor.current === formKey) { setEditor(null); }
  }
  const visible = list.key === queryKey ? list : { loading: true, data: undefined, error: undefined };
  const blocked = command.busy || command.pending.state !== "absent" || command.foreignPending !== null || command.legacyPending;
  const canRevoke = snapshot.security.isBoss || hasPermission(snapshot, "membership.entitlement.revoke");
  return <div className="space-y-5">
    <Tabs value={tab} onValueChange={value => setTab(String(value))}>
      <TabsList><TabsTrigger value="entitlements">礼遇管理</TabsTrigger>{policy ? <TabsTrigger value="policy">会员政策</TabsTrigger> : null}</TabsList>
      <TabsContent value="entitlements" keepMounted className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">礼遇记录</h2>
            <p className="mt-1 text-xs text-muted-foreground">查看每位用户的实际权益与期限，办理发放、替换或撤销。</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>
              <RefreshCw className="size-3.5 mr-1" aria-hidden />
              刷新礼遇
            </Button>
            {options?.capability.canRequest ? (
              <Button size="sm" disabled={blocked} onClick={() => openEditor()}>
                <Plus className="size-3.5 mr-1" aria-hidden />
                办理礼遇
              </Button>
            ) : null}
          </div>
        </div>
        {optionsError ? <ErrorBox error={optionsError} retry={() => setReload(value => value + 1)} /> : null}
        {command.error ? <Alert variant="warning" role="status"><TriangleAlert aria-hidden /><AlertTitle>{command.error}</AlertTitle></Alert> : null}
        {command.foreignPending?.state === "valid" ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden />
            <AlertTitle>另有会员政策变更待核对</AlertTitle>
            <AlertDescription>
              {membershipPendingLabel(command.foreignPending.record)}。请到「会员政策」子页处理；政策责任不写入礼遇记录，也不清除原请求。
            </AlertDescription>
          </Alert>
        ) : command.legacyPending ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden />
            <AlertTitle>原请求记录缺少业务类型</AlertTitle>
            <AlertDescription>原请求记录保留，无法自动判断是政策还是礼遇；请到审批中心核对。</AlertDescription>
          </Alert>
        ) : command.pending.state === "valid" ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden />
            <AlertTitle>礼遇申请待核对</AlertTitle>
            <AlertDescription>
              {membershipPendingLabel(command.pending.record)}。原请求记录保留，核清前不创建新申请。
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" disabled={command.busy} onClick={() => void command.recover()}>查询原结果</Button>
              {command.requestId && onOpenPath ? <Button size="sm" variant="ghost" onClick={() => onOpenPath(`/approvals/${encodeURIComponent(command.requestId!)}?from=membership-growth&fromTab=entitlements`)}>查看原申请</Button> : null}
            </AlertAction>
          </Alert>
        ) : command.pending.state === "unreadable" ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden />
            <AlertTitle>原请求记录不可读</AlertTitle>
            <AlertDescription>原记录保留，核清前不创建新申请；请保留现场并到审批中心核对。</AlertDescription>
          </Alert>
        ) : command.requestId ? (
          <Alert variant={command.detailStatus === "REJECTED" ? "warning" : "info"} role="status">
            {command.detailStatus === "REJECTED" ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
            <AlertTitle>{command.detailStatus === "REJECTED" ? "审批已驳回" : command.detailStatus && command.detailStatus !== "PENDING" ? "审批状态已读取" : "已提交审批"}</AlertTitle>
            <AlertDescription>
              {command.detailStatus === "PENDING" ? "审批通过并执行后才会生效。" : command.detailStatus === "REJECTED" ? "请核对原因后重新办理。" : command.detailStatus ? `审批状态：${statusView(command.detailStatus).label}。` : "审批通过后仍需确认业务执行结果。"}
            </AlertDescription>
            {onOpenPath ? <AlertAction><Button size="sm" variant="link" onClick={() => openApproval(command.requestId)}>查看申请</Button></AlertAction> : null}
          </Alert>
        ) : null}
        {!options && !optionsError ? <Skeleton className="h-12 w-full" aria-label="正在读取礼遇权限" /> : null}
        {options?.capability.canRead ? <>
          <div className="relative z-20 rounded-xl border border-border bg-card/70 p-3.5 shadow-2xs backdrop-blur-xs">
            <div className="flex flex-wrap items-end gap-4">
              <Choice label="状态" value={filters.status} options={STATUSES} onChange={status => change({ status })} triggerClassName="w-32 sm:w-36" />
              <Choice label="礼遇类型" value={filters.kind} options={KINDS} onChange={kind => change({ kind })} triggerClassName="w-36 sm:w-40" />
              <Choice label="游戏" value={filters.gameId} options={Object.fromEntries(options.games.map(game => [game.id, game.name]))} onChange={gameId => change({ gameId })} triggerClassName="w-44 sm:w-52" contentClassName="w-(--anchor-width) min-w-[200px] max-w-[320px]" />
              <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground flex-1 min-w-[220px] max-w-sm">
                <span className="text-[11px] font-medium text-muted-foreground">用户搜索</span>
                <div className="flex items-center gap-1.5">
                  <UserPicker snapshot={snapshot} userId={filters.userId} label={filters.userLabel} onSelect={(userId, userLabel) => change({ userId, userLabel })} />
                  {filters.userId ? (
                    <Button size="sm" variant="ghost" className="h-9 px-2 text-xs text-muted-foreground hover:text-foreground" aria-label="清除用户筛选" onClick={() => change({ userId: "", userLabel: "" })}>
                      <X className="size-3.5 mr-0.5" />
                      重置
                    </Button>
                  ) : null}
                </div>
              </div>
              {filters.status || filters.kind || filters.gameId || filters.userId ? (
                <Button size="sm" variant="outline" className="h-9 text-xs ml-auto self-end text-muted-foreground hover:text-foreground" onClick={() => change({ status: "", kind: "", gameId: "", userId: "", userLabel: "" })}>
                  <RotateCcw className="size-3.5 mr-1" />
                  重置筛选
                </Button>
              ) : null}
            </div>
          </div>
          {visible.error ? <ErrorBox error={visible.error} retry={() => setReload(value => value + 1)} /> : null}
          <div aria-busy={visible.loading} className="min-h-48">
            {visible.data ? (
              <div className="rounded-xl border border-border bg-card overflow-hidden shadow-2xs">
                {visible.loading ? <p className="p-2 text-xs text-muted-foreground bg-muted/20" role="status">更新中，保留当前记录</p> : null}
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="font-medium text-xs">用户 / 游戏</TableHead>
                      <TableHead className="font-medium text-xs">礼遇与优惠</TableHead>
                      <TableHead className="font-medium text-xs">状态</TableHead>
                      <TableHead className="font-medium text-xs">生效与到期</TableHead>
                      <TableHead className="text-right font-medium text-xs">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.data.items.map(item => (
                      <TableRow key={item.id} className="hover:bg-muted/30 transition-colors">
                        <TableCell>
                          <div className="font-semibold text-foreground">{item.userSummary?.name ?? "用户资料未授权"}</div>
                          {item.userSummary?.maskedPhone ? <div className="mt-0.5 text-xs text-muted-foreground">{item.userSummary.maskedPhone}</div> : null}
                          <div className="mt-0.5 text-xs text-muted-foreground">{item.gameName ?? "游戏名称待核"}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-foreground">{KINDS[item.kind] ?? "未知礼遇"}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{formatEntitlementPricing(item.pricingSummary)} · {formatEntitlementDeposit(item.depositWaived, item.depositAllowanceCents)}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.status === "ACTIVE" ? "success" : item.status === "EXECUTED_PENDING_START" ? "info" : "outline"}>
                            {STATUSES[item.status] ?? "状态待核"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="tabular-nums font-mono">{formatDate(item.startsAtUtc)}</div>
                          <div className="mt-0.5 text-muted-foreground tabular-nums font-mono">至 {formatDate(item.endsAtUtc)}</div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {item.approvalRequestId ? <Button size="sm" variant="ghost" onClick={() => openApproval(item.approvalRequestId)}>查看申请</Button> : null}
                            {options.capability.canRequest && ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status) ? (
                              <>
                                <Button size="sm" variant="outline" disabled={blocked} onClick={() => openEditor(item, "replace")}>替换/续期</Button>
                                {canRevoke ? <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" disabled={blocked} onClick={() => openEditor(item, "revoke")}>申请撤销</Button> : null}
                              </>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {visible.data.items.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                    <div className="flex size-12 items-center justify-center rounded-full bg-muted/80 text-muted-foreground mb-3.5">
                      <Gift className="size-6 stroke-[1.5]" aria-hidden />
                    </div>
                    <h3 className="text-sm font-semibold tracking-tight text-foreground">暂无符合条件的礼遇记录</h3>
                    <p className="mt-1.5 max-w-sm text-xs text-muted-foreground leading-relaxed">
                      当前条件下没有礼遇记录。{filters.status || filters.kind || filters.gameId || filters.userId
                        ? "您可以尝试清除或调整筛选范围。"
                        : options?.capability.canRequest
                          ? "点击下方按钮为指定用户办理首个专属礼遇。"
                          : "当前账号没有办理礼遇的权限；如需办理，请联系具备权限的管理员。"}
                    </p>
                    <div className="mt-5 flex items-center gap-2.5">
                      {options?.capability.canRequest ? (
                        <Button size="sm" disabled={blocked} onClick={() => openEditor()}>
                          <Plus className="size-3.5 mr-1" aria-hidden />
                          办理新礼遇
                        </Button>
                      ) : null}
                      {filters.status || filters.kind || filters.gameId || filters.userId ? (
                        <Button size="sm" variant="outline" onClick={() => change({ status: "", kind: "", gameId: "", userId: "", userLabel: "" })}>
                          重置筛选条件
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {visible.data.total > visible.data.pageSize ? (
                  <div className="border-t border-border bg-muted/15 px-4 py-3">
                    <ListPagination
                      mode="page"
                      page={visible.data.page}
                      pageSize={visible.data.pageSize}
                      total={visible.data.total}
                      loading={visible.loading}
                      pageSizeOptions={[20, 50, 100]}
                      itemLabel="条礼遇"
                      onPageChange={(page) => setFilters((previous) => ({ ...previous, page }))}
                      onPageSizeChange={(pageSize) => change({ pageSize })}
                    />
                  </div>
                ) : visible.data.total > 0 ? (
                  <div className="border-t border-border/60 bg-muted/10 px-4 py-2.5 flex items-center justify-between text-xs text-muted-foreground">
                    <span>共 {visible.data.total} 条礼遇记录</span>
                    <span className="text-[11px]">全部记录已在当前视图呈现</span>
                  </div>
                ) : null}
              </div>
            ) : visible.loading ? (
              <div className="space-y-2" role="status" aria-label="正在读取礼遇记录">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : null}
          </div>
        </> : options ? (
          <p className="py-8 text-sm text-muted-foreground">当前没有集中列表读取权限，可从已授权用户办理礼遇。</p>
        ) : null}
      </TabsContent>
      {policy ? <TabsContent value="policy" keepMounted>{policy}</TabsContent> : null}
    </Tabs>

    {/* Grant / Replace / Revoke Entitlement Modal */}
    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !command.busy) setEditor(null); }}>
      <DialogContent size="xl" className="max-h-[96vh] overflow-y-auto p-5 space-y-3">
        <div className="flex items-start justify-between border-b pb-3">
          <DialogTitle className="text-lg font-bold flex items-center gap-2">
            <Gift className="size-5 text-primary" />
            <span>{editor?.action === "replace" ? "替换/续期会员礼遇" : editor?.action === "revoke" ? "申请撤销会员礼遇" : "办理新会员礼遇"}</span>
            <InfoHint label="办理说明">提交后进入审批；批准并执行后生效。</InfoHint>
          </DialogTitle>
        </div>

        <div className="space-y-3">
          {editor ? (
            <>
              {/* Step 1: Target Object Selection Card */}
              <div className="rounded-xl border border-border/70 bg-card/40 p-3.5 space-y-2">
                <div className="flex items-center justify-between pb-2 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <div className="size-6 rounded-md bg-primary/10 text-primary flex items-center justify-center">
                      <Search className="size-3.5" />
                    </div>
                    <span className="text-xs font-semibold text-foreground">办理对象与目标游戏</span>
                  </div>
                </div>

                {editor.target ? (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/40 border border-border/80">
                    <div className="flex items-center gap-3">
                      <div className="size-9 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold text-sm">
                        {(editor.userLabel || "U").slice(0, 1)}
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-foreground">{editor.userLabel || "已选用户"}</div>
                        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                          目标游戏：{editor.target.gameName ?? editor.gameId} · 现有礼遇：{KINDS[editor.target.kind]}
                        </div>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-xs">目标已锁定</Badge>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                    <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                      <span>受益用户（手机号/昵称/ID）</span>
                      <UserPicker
                        snapshot={snapshot}
                        userId={editor.userId}
                        label={editor.userLabel}
                        disabled={blocked}
                        onSelect={(userId, userLabel) => setEditor({ ...editor, userId, userLabel })}
                      />
                    </div>
                    <Choice
                      label="办理游戏"
                      value={editor.gameId}
                      allowAll={false}
                      disabled={blocked}
                      options={Object.fromEntries((options?.games ?? []).map((game) => [game.id, game.name]))}
                      onChange={(gameId) => setEditor({ ...editor, gameId })}
                      triggerClassName="w-full"
                    />
                  </div>
                )}
              </div>

              {/* Step 2: Configuration or Onboarding Guide */}
              {!editor.userId || !editor.gameId ? (
                <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 p-6 text-center space-y-3">
                  <div className="size-10 rounded-full bg-primary/10 text-primary mx-auto flex items-center justify-center">
                    <Search className="size-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">请先指定受益用户与游戏</h4>
                    <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                      在上方的用户搜索框中输入昵称、手机号或ID，并确认目标游戏。系统将自动拉取该用户当前的会员成长等级与可发放礼遇范围。
                    </p>
                  </div>
                </div>
              ) : formFailure ? (
                <ErrorBox error={formFailure} retry={() => setEditorRetry((value) => value + 1)} />
              ) : !activeForm ? (
                <div className="space-y-3 p-4 rounded-xl border border-border">
                  <div className="text-xs text-muted-foreground">正在读取用户成长状态与可用礼遇范围...</div>
                  <Skeleton className="h-36 w-full rounded-lg" aria-label="正在读取办理上下文" />
                </div>
              ) : editor.action === "revoke" ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold text-destructive">撤销确认</h4>
                    <p className="text-xs text-muted-foreground">
                      确定撤销 {KINDS[editor.target!.kind]}（当前状态：{STATUSES[editor.target!.status]}）？撤销申请提交后需 Boss 审批通过后生效。
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground">撤销原因（必填）</label>
                    <Textarea
                      aria-label="撤销原因"
                      placeholder="请详述申请撤销本次礼遇的合规依据与业务原因..."
                      value={revokeReason}
                      maxLength={500}
                      disabled={blocked}
                      onChange={(event) => setRevokeReason(event.target.value)}
                      className="text-xs min-h-20"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" size="sm" disabled={blocked} onClick={() => setEditor(null)}>
                      取消
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={blocked || revokeReason.trim().length < 2}
                      onClick={() => void submitRevoke()}
                    >
                      提交撤销审批
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {editor.target ? (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-600 dark:text-amber-400 flex items-center justify-between">
                      <span>替换将保留原用户与游戏，请在下方调整新的生效时段、折扣比例或押金减免额度。</span>
                      <Badge variant="outline" className="border-amber-500/40 text-[10px]">替换模式</Badge>
                    </div>
                  ) : null}

                  {activeForm.existingEntitlements.filter((item) => ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status)).length ? (
                    <div className="space-y-2 rounded-xl border border-border/80 bg-muted/20 p-3.5">
                      <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <Gift className="size-3.5 text-primary" />
                        <span>该用户在当前游戏已有有效礼遇</span>
                      </h4>
                      <div className="space-y-1.5">
                        {activeForm.existingEntitlements
                          .filter((item) => ["ACTIVE", "EXECUTED_PENDING_START"].includes(item.status))
                          .map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-3 text-xs p-2 rounded-lg bg-background border border-border">
                              <div>
                                <span className="font-medium text-foreground">{KINDS[item.kind]}</span>
                                <span className="text-muted-foreground ml-2">至 {formatDate(item.endsAtUtc)}</span>
                              </div>
                              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={blocked} onClick={() => openEditor(item, "replace")}>
                                替换/续期
                              </Button>
                            </div>
                          ))}
                      </div>
                    </div>
                  ) : null}

                  <MembershipEntitlementForm
                    context={activeForm}
                    initial={editor.target ? draftFrom(editor.target) : undefined}
                    busy={blocked}
                    error={formError ?? command.error}
                    onSubmit={submitDraft}
                  />
                </div>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

export function MembershipBenefitsWorkspace(props: MembershipBenefitsWorkspaceProps) {
  if (props.snapshot.session.locked || props.snapshot.security.status !== "ACTIVE" || props.snapshot.security.passwordChangeRequired) return null;
  return <BenefitsWorkspace key={JSON.stringify([identityOf(props.snapshot), props.initialUserId ?? "", props.initialGameId ?? ""])} {...props} />;
}
