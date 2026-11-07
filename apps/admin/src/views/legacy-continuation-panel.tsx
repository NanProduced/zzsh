import { useEffect, useRef, useState } from "react";
import { friendlyError, formatDate, type SessionSnapshot } from "../api";
import { Button } from "../components/ui-elements";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { clearLegacyAdminIntent, inspectLegacyAdminIntent, legacyAdminSubject, previewLegacyAdminContinuation, readLegacyAdminContinuation, recoverLegacyAdminIntent, retainLegacyAdminIntent, sendLegacyAdminIntent, type LegacyAdminAction, type LegacyAdminPending, type LegacyAdminProposal, type LegacyAdminQuantities, type LegacyAdminReceipt, type LegacyAdminView, type LegacyDemoScope } from "../lib/legacy-continuation-client";
import {LegacyRefundChoice} from './legacy-refund-choice';
import "./legacy-continuation.css";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
const commandName: Record<LegacyAdminAction, string> = { propose: "协助提交结算方案", confirm: "客服确认结算方案", reject: "退回结算方案", hold: "暂扣押金", release: "解除暂扣", confiscate: "没收押金", mature: "核定佣金成熟", void: "按已核来源作废佣金", "owner-credit": "入账号主收益", "commission-credit":"入账分销佣金", "refund-case":"创建退款任务", "demo-refund":"模拟退款" };
const amountName: Record<string, string> = { payMoney: "原已付", saleEarnings: "号主毛结算", returnOrderMoney: "退款毛额", detainMoney: "原扣留金额", ownerNet: "号主应结", refundNet: "租客净应退", commissionPool: "佣金池", depositCompensation: "押金补偿责任" };
const dutyName: Record<string, string> = { RENTER_REFUND: "租客退款", OWNER_CREDIT: "号主应结", COMMISSION: "佣金", DEPOSIT_COMPENSATION: "押金补偿" };
const money = (cents: string) => `¥${BigInt(cents) / 100n}.${(BigInt(cents) % 100n).toString().padStart(2, "0")}`;
const legacyErrors: Record<string, string> = { DEPOSIT_SHORT: "本单已付金额不足以覆盖实际消耗，请核对数量并与双方沟通。", RETURN_NEGATIVE: "按原单规则计算后退款金额不足，请核对实际消耗。", EVIDENCE_ISOLATED: "旧单计价资料需要核对，暂不能提交方案。", MISSING_STORED_SETTLEMENT: "当前方案金额不完整，请退回后重新核对。", FINANCE_FACT_UNAVAILABLE: "资金处理记录暂不可用，请稍后核对。", FINANCE_FACT_UNKNOWN: "资金处理状态尚未确认，请先核对原单。", DEPOSIT_ALREADY_SETTLED: "本单已有退款责任记录，请先核对，不能重复处理。", CONTINUATION_REVISION_CONFLICT: "本单已有新进展，请刷新后重新核对。", PLAN_FINGERPRINT_MISMATCH: "本次预估已变化，请重新预览。", DUTY_REVISION_CONFLICT: "处理状态已更新，请刷新后核对。", STATUS_INVALID: "订单状态已变化，请刷新后核对。", QUANTITY_INVALID: "消耗数量不正确，请检查填写内容。", PRECISION_UNSUPPORTED: "本单结算金额不能准确记录到分，请核对数量并联系维护人员。", CONFIRM_POOL_NEGATIVE: "结算金额与原单实付不相符，请核对价格和消耗。", OWNER_NET_NEGATIVE: "号主结算金额不足以覆盖包赔费用，请核对原单。" };
legacyErrors.WALLET_CREDIT_HISTORY_UNPROVEN = "无法确认旧站余额中是否已包含这笔收益，请先核对历史记录。";
legacyErrors.WALLET_CREDIT_BASIS_UNAVAILABLE = "结算依据不完整，暂不能入账。";
function legacyError(error: unknown) { const reason = error && typeof error === "object" && "reason" in error ? (error as { reason?: unknown }).reason : undefined; return typeof reason === "string" && legacyErrors[reason] ? legacyErrors[reason] : friendlyError(error); }
type Scoped<T> = { scope: string; value: T };
const quantityLabels: Record<keyof LegacyAdminQuantities, string> = { expendHaff: "哈夫币（M）", barrett: "巴雷特子弹（发）", bullet: "6级子弹（组，60发/组）", awm: "AWM子弹（发）", armor: "6级甲（件）", helmet: "6级头盔（件）", coffee: "咖啡（件）", card: "保险体验卡（天）" };
const emptyQuantities = (): LegacyAdminQuantities => ({ expendHaff: "", barrett: "0", bullet: "0", awm: "0", armor: "0", helmet: "0", coffee: "0", card: "0" });
export function LegacyAdminContinuationPanel({ snapshot, orderId, refreshNonce = 0 }: { snapshot: Snapshot; orderId: string; refreshNonce?: number }) {
  const subject = legacyAdminSubject(snapshot.adminUserId, orderId), scope = subject + "|" + snapshot.session.id + "|" + snapshot.permissions.slice().sort().join(",") + "|" + snapshot.security.isBoss;
  const live = useRef({ scope, ticket: 0 }); if (live.current.scope !== scope) live.current = { scope, ticket: live.current.ticket + 1 };
  const [view, setView] = useState<Scoped<LegacyAdminView | null>>({ scope, value: null }), [error, setError] = useState<Scoped<string>>({ scope, value: "" });
  const [pending, setPending] = useState<Scoped<LegacyAdminPending>>({ scope, value: { state: "NONE", intent: null } }), [receipt, setReceipt] = useState<Scoped<LegacyAdminReceipt | null>>({ scope, value: null });
  const [confirm, setConfirm] = useState<Scoped<{ command: LegacyAdminAction; dutyId: string | null; body: Record<string, unknown>;demoScope?:LegacyDemoScope } | null>>({ scope, value: null });
  const [busy, setBusy] = useState<Scoped<boolean>>({ scope, value: false }), [nonce, setNonce] = useState(0), [sourceRef, setSourceRef] = useState<Scoped<string>>({ scope, value: "" }), [reason, setReason] = useState<Scoped<string>>({ scope, value: "" });
  const [supportReason, setSupportReason] = useState<Scoped<string>>({ scope, value: "" });
  const [commissionReasons,setCommissionReasons]=useState<Scoped<Record<string,string>>>({scope,value:{}});
  const [proposalForm, setProposalForm] = useState<Scoped<{ onBehalf: "renter" | "owner" | ""; quantities: LegacyAdminQuantities }>>({ scope, value: { onBehalf: "", quantities: emptyQuantities() } });
  const [proposal, setProposal] = useState<Scoped<{ data: LegacyAdminProposal; formKey: string } | null>>({ scope, value: null });
  const current = () => live.current.scope === scope, data = view.scope === scope ? view.value : null, p = pending.scope === scope ? pending.value : { state: "NONE" as const, intent: null }, loading = busy.scope === scope && busy.value;
  const form = proposalForm.scope === scope ? proposalForm.value : { onBehalf: "" as const, quantities: emptyQuantities() }, preview = proposal.scope === scope ? proposal.value : null;
  const canOperate = snapshot.security.isBoss || snapshot.permissions.includes("order.legacy.continue"), canCredit=canOperate && (snapshot.security.isBoss || snapshot.permissions.includes("order.settlement.write")), canCommissionCredit=canCredit && (snapshot.security.isBoss || snapshot.permissions.includes("finance.document.read")), locked = loading || p.state !== "NONE";
  useEffect(() => {
    const abort = new AbortController(), ticket = ++live.current.ticket;
    setView({ scope, value: null }); setConfirm({ scope, value: null }); setReceipt({ scope, value: null }); setProposal({ scope, value: null }); setPending({ scope, value: inspectLegacyAdminIntent(subject, orderId) });
    void readLegacyAdminContinuation(orderId, abort.signal).then(value => { if (!current() || abort.signal.aborted || live.current.ticket !== ticket) return; setView({ scope, value }); setError({ scope, value: "" }); }).catch(e => { if (current() && !abort.signal.aborted && live.current.ticket === ticket) setError({ scope, value: legacyError(e) }); });
    return () => abort.abort();
  }, [scope, nonce, refreshNonce]);
  async function estimate() {
    if (!data?.capabilities.includes("propose") || !canOperate || locked || !form.onBehalf || !current()) return;
    const ticket = ++live.current.ticket, formKey = JSON.stringify(form); setBusy({ scope, value: true }); setError({ scope, value: "" });
    try { const result = await previewLegacyAdminContinuation(orderId, form.quantities, form.onBehalf); if (current() && live.current.ticket === ticket) setProposal({ scope, value: { data: result, formKey } }); }
    catch (e) { if (current() && live.current.ticket === ticket) setError({ scope, value: legacyError(e) }); }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  function choose(command: LegacyAdminAction, dutyId: string | null = null) {
    if (!data || !canOperate || locked || !current()) return;
    if (command === "confirm" && !canCredit) return;
    let body: Record<string, unknown>;
    if (dutyId) { const d = data.duties.find(d => d.id === dutyId); if (!d) return;
      const rationale=command==="commission-credit"?(commissionReasons.scope===scope?commissionReasons.value[d.id]?.trim()??"":""):(supportReason.scope===scope?supportReason.value.trim():"");
      if(command==="owner-credit" && (!canCredit || d.kind!=="OWNER_CREDIT" || d.status!=="PENDING" || [...rationale].length<3))return;
      if(command==="commission-credit" && (!canCommissionCredit || d.kind!=="COMMISSION" || d.status!=="MATURED" || !d.beneficiary?.name || [...rationale].length<3))return;
      body = { expectedRevision: d.revision, ...(command === "void" ? { sourceFactAuditId: sourceRef.scope === scope ? sourceRef.value.trim() : "", reason: reason.scope === scope ? reason.value.trim() : "" } : ["owner-credit","commission-credit"].includes(command)?{reason:rationale}:{}) }; }
    else {
      const rationale = supportReason.scope === scope ? supportReason.value.trim() : "";
      if (!data.capabilities.includes(command) || !data.evidenceId) return;
      if (command === "propose") {
        if (!preview || preview.formKey !== JSON.stringify(form) || !form.onBehalf || [...rationale].length < 3) return;
        body = { expectedRevision: preview.data.revision, inputEvidenceId: preview.data.inputEvidenceId, planFingerprint: preview.data.proposalFingerprint, quantities: form.quantities, reason: rationale, onBehalf: form.onBehalf };
      } else {
        if (!data.commandFingerprints[command] || command === "confirm" && !data.confirmationAmounts || ["confirm", "reject"].includes(command) && [...rationale].length < 3) return;
        body = { expectedRevision: data.revision, inputEvidenceId: data.evidenceId, planFingerprint: data.commandFingerprints[command], ...(["confirm", "reject"].includes(command) ? { reason: rationale } : {}) };
      }
    }
    setConfirm({ scope, value: { command, dutyId, body } });
  }
  async function sendOriginal() {
    if (p.state !== "VALID" || loading || !current()) return;
    const ticket = ++live.current.ticket; setBusy({ scope, value: true });
    try { await sendLegacyAdminIntent(p.intent); if (!current() || live.current.ticket !== ticket) return; clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }
    catch (e) { if (current() && live.current.ticket === ticket) setError({ scope, value: legacyError(e) }); }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  async function submit() {
    const c = confirm.scope === scope ? confirm.value : null; if (!c || locked || !current()) return;
    const ticket = ++live.current.ticket; setBusy({ scope, value: true });
    try {
      const intent = await retainLegacyAdminIntent(subject, orderId, c.command, c.body, c.dutyId, c.demoScope);
      if (!current() || live.current.ticket !== ticket) return;
      setPending({ scope, value: { state: "VALID", intent } }); setConfirm({ scope, value: null });
      await sendLegacyAdminIntent(intent);
      if (!current() || live.current.ticket !== ticket) return;
      clearLegacyAdminIntent(intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1);
    } catch (e) { if (current() && live.current.ticket === ticket) { setPending({ scope, value: inspectLegacyAdminIntent(subject, orderId) }); setError({ scope, value: legacyError(e) }); } }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  async function recover() {
    if (p.state !== "VALID" || loading || !current()) return;
    const ticket = ++live.current.ticket; setBusy({ scope, value: true });
    try { const result = await recoverLegacyAdminIntent(p.intent); if (!current() || live.current.ticket !== ticket) return; setReceipt({ scope, value: result }); if (result.state === "KNOWN_SUCCESS") { clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); } }
    catch (e) { if (current() && live.current.ticket === ticket) setError({ scope, value: legacyError(e) }); }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  const confirmation = confirm.scope === scope ? confirm.value : null, recovered = receipt.scope === scope ? receipt.value : null;
  const refundDuty=confirmation?.command==='refund-case'?data?.duties.find(d=>d.id===confirmation.dutyId):undefined;
  const refundPrevious=confirmation?.body.previouslyRefundedCents,refundApplied=confirmation?.body.priorAppliedToDutyCents;
  const refundSummary=refundDuty&&typeof refundPrevious==='string'&&/^(0|[1-9]\d{0,23})$/.test(refundPrevious)
    && typeof refundApplied==='string'&&/^(0|[1-9]\d{0,23})$/.test(refundApplied)&&BigInt(refundApplied)<=BigInt(refundDuty.amountCents)
    ? {previous:refundPrevious,applied:refundApplied,next:(BigInt(refundDuty.amountCents)-BigInt(refundApplied)).toString()}:null;
  return <section className="oc-section lc-admin" aria-label="旧单续办与责任" aria-busy={loading}>
    <header><div><h2>旧单办理与责任</h2><p>{data?.stage ? ({ "3": "进行中", "8": "待号主确认", "9": "待租客确认", "4": "订单已完成" }[data.stage] ?? "未记录") : "独立核对续办依据"}</p></div><Button variant="secondary" size="sm" disabled={loading} onClick={() => setNonce(n => n + 1)}>刷新</Button></header>
    {error.scope === scope && error.value ? <p role="alert">{error.value}</p> : null}
    {!data ? <p className="oc-fact-note">{error.scope === scope && error.value ? "续办资料暂不可用，订单主体信息保留。" : "正在核对续办资料…"}</p> : data.availability !== "KNOWN" ? <p className="oc-fact-note">{data.availability === "NOT_IMPORTED" ? "本单续办来源尚未记录。" : "本单来源存在隔离事项，不能据此办理。"}</p> : <>
      <dl className="oc-fact-list">{Object.entries(data.amounts).filter(([key]) => amountName[key]).map(([key, amount]) => <div key={key}><dt>{amountName[key]}</dt><dd>{amount ? `¥${amount.yuan}` : "未记录"}</dd></div>)}</dl>
      <p className="oc-fact-note">订单完成、资金入账和渠道到账分别核对；解除暂扣不会自动追加扣留部分退款。</p>
      {data.stage === "4" && data.duties.some(d => d.kind === "RENTER_REFUND" && ["PENDING", "MATURED"].includes(d.status)) ? <p className="oc-fact-note">{data.refundDueAt ? `退款最早处理时间：${formatDate(data.refundDueAt)}。` : "退款处理时间待核。"} 具体到账状态以渠道记录为准。</p> : null}
      {data.reasons.some(code => code.startsWith("FINANCE_FACT")) ? <p className="oc-fact-note">原资金处理结果尚未确认，暂时无法协助结算或处理押金。</p> : null}
      <div className="lc-actions">{(["hold", "release", "confiscate"] as const).filter(kind => data.capabilities.includes(kind)).map(kind => <Button key={kind} variant={kind === "confiscate" ? "danger" : "secondary"} disabled={locked || !canOperate} onClick={() => choose(kind)}>{commandName[kind]}</Button>)}</div>
      {canOperate && data.capabilities.includes("propose") ? <div className="mt-4 space-y-4 rounded-xl border border-border p-4">
        <div><h3 className="text-sm font-semibold">协助发起结算</h3><p className="mt-1 text-sm text-muted-foreground">与双方核实实际消耗后，选择发起方并预览旧单结算方案；提交后由另一方确认。</p></div>
        <div className="space-y-1 text-sm"><span>结算发起方</span><Select value={form.onBehalf || "NONE"} disabled={locked} onValueChange={value => { setProposalForm({ scope, value: { ...form, onBehalf: value === "renter" || value === "owner" ? value : "" } }); setProposal({ scope, value: null }); }} items={[{ value: "NONE", label: "请选择" }, { value: "renter", label: "租客" }, { value: "owner", label: "号主" }]}><SelectTrigger aria-label="结算发起方" className="w-full sm:w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NONE">请选择</SelectItem><SelectItem value="renter">租客</SelectItem><SelectItem value="owner">号主</SelectItem></SelectContent></Select></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{(Object.entries(quantityLabels) as Array<[keyof LegacyAdminQuantities, string]>).map(([key, label]) => <label className="block space-y-1 text-sm" key={key}><span>{label}</span><Input aria-label={label} inputMode="decimal" value={form.quantities[key]} disabled={locked} onChange={event => { setProposalForm({ scope, value: { ...form, quantities: { ...form.quantities, [key]: event.target.value.trim() } } }); setProposal({ scope, value: null }); }} /></label>)}</div>
        <Button variant="secondary" disabled={locked || !form.onBehalf || !form.quantities.expendHaff} onClick={() => void estimate()}>预览结算方案</Button>
        {preview ? <div className="space-y-3 rounded-lg bg-muted/50 p-4"><p className="text-sm font-medium">{preview.data.settlementKind === "EARLY" ? "提前结算" : "正常结算"}</p><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">号主预计结算</dt><dd className="mt-1 font-medium tabular-nums">{preview.data.proposalAmounts.ownerNet == null ? "未记录" : `¥${preview.data.proposalAmounts.ownerNet}`}</dd></div><div><dt className="text-xs text-muted-foreground">租客退款方案金额（未扣暂扣）</dt><dd className="mt-1 font-medium tabular-nums">{preview.data.proposalAmounts.returnOrderMoney == null ? "未记录" : `¥${preview.data.proposalAmounts.returnOrderMoney}`}</dd></div></dl><p className="text-xs text-muted-foreground">此处为结算方案，提交不代表资金已入账或退款到账。</p></div> : null}
        <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="客服发起结算原因" value={supportReason.scope === scope ? supportReason.value : ""} disabled={locked} maxLength={500} onChange={e => setSupportReason({ scope, value: e.target.value })} /></label>
        <Button disabled={locked || !preview || supportReason.scope !== scope || [...supportReason.value.trim()].length < 3} onClick={() => choose("propose")}>核对并提交方案</Button>
      </div> : null}
      {canOperate && (data.capabilities.includes("confirm") || data.capabilities.includes("reject")) ? <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
        <div><h3 className="text-sm font-semibold">客服协助处理结算方案</h3><p className="mt-1 text-sm text-muted-foreground">订单已有待确认方案；核实后可确认，或退回并重新核对。操作会记录客服身份，不代表退款已到账。</p></div>
        {data.confirmationAmounts ? <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">号主应结</dt><dd className="mt-1 font-medium tabular-nums">¥{data.confirmationAmounts.ownerNet.yuan}</dd></div><div><dt className="text-xs text-muted-foreground">租客应退</dt><dd className="mt-1 font-medium tabular-nums">¥{data.confirmationAmounts.refundNet.yuan}</dd></div></dl> : <p className="text-sm text-muted-foreground">{canCredit ? "方案金额不完整，暂不能确认；可退回后重新核对。" : "当前账号没有确认结算的权限，可退回方案或联系有权限的同事。"}</p>}
        <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="客服处理结算原因" value={supportReason.scope === scope ? supportReason.value : ""} disabled={locked} maxLength={500} onChange={e => setSupportReason({ scope, value: e.target.value })} /></label>
        <div className="flex flex-wrap gap-2">{canCredit && data.capabilities.includes("confirm") && data.confirmationAmounts ? <Button disabled={locked || supportReason.scope !== scope || [...supportReason.value.trim()].length < 3} onClick={() => choose("confirm")}>核对并确认方案</Button> : null}{data.capabilities.includes("reject") ? <Button variant="secondary" disabled={locked || supportReason.scope !== scope || [...supportReason.value.trim()].length < 3} onClick={() => choose("reject")}>退回并重新核对</Button> : null}</div>
      </div> : null}
    </>}
    {data?.duties.length ? <div className="lc-duty-table"><h3>已记录经济责任</h3><Table><TableHeader><TableRow><TableHead>责任</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>成熟依据</TableHead><TableHead>合法处理</TableHead></TableRow></TableHeader><TableBody>{data.duties.map(d => <TableRow key={d.id}><TableCell>{dutyName[d.kind] ?? "责任"}</TableCell><TableCell>{money(d.amountCents)}</TableCell><TableCell>{d.settledBy === "LEGACY_RECORDS" ? "旧侧已处理，不再支付" : d.status==="SETTLED" && d.settledBy==="FINANCE" && ["OWNER_CREDIT","COMMISSION"].includes(d.kind) ? d.financeVerified ? d.amountCents==="0" ? "无需入账" : "已入可用余额" : "账目待核对" : { PENDING: "待处理", MATURED: "成熟待入账", SETTLED: "财账已终定", VOID: "已作废" }[d.status] ?? "未记录"}</TableCell><TableCell>{d.maturityAt ? formatDate(d.maturityAt) : d.kind === "COMMISSION" ? "等待终金额/成熟证据" : "不适用"}</TableCell><TableCell>{canOperate && d.kind === "COMMISSION" && d.status === "PENDING" && d.maturityAt ? <Button size="sm" variant="secondary" disabled={locked} onClick={() => choose("mature", d.id)}>核定成熟</Button> : null}{canOperate && d.kind === "COMMISSION" && ["PENDING", "MATURED"].includes(d.status) ? <Button size="sm" variant="ghost" disabled={locked || sourceRef.scope !== scope || !sourceRef.value.trim() || reason.scope !== scope || !reason.value.trim()} onClick={() => choose("void", d.id)}>按已核来源作废</Button> : null}</TableCell></TableRow>)}</TableBody></Table></div> : null}
    {canOperate && data?.duties.some(d => d.kind === "COMMISSION" && ["PENDING", "MATURED"].includes(d.status)) ? <div className="lc-source"><label>佣金作废的来源核定记录编号<Input value={sourceRef.scope === scope ? sourceRef.value : ""} disabled={locked} maxLength={128} onChange={e => setSourceRef({ scope, value: e.target.value })}/></label><label>核定理由<Textarea value={reason.scope === scope ? reason.value : ""} disabled={locked} maxLength={500} onChange={e => setReason({ scope, value: e.target.value })} rows={2} /></label><p className="oc-fact-note">只能引用已受权核定的源作废或父单取消且不应付事实；输入编号不能代替证据。</p></div> : null}
    {canCredit && data?.availability==="KNOWN" && data.stage==="4" && data.duties.filter(d=>d.kind==="OWNER_CREDIT"&&d.status==="PENDING").map(d=><div className="lc-source" key={d.id}><h3>号主收益入账</h3><p className="oc-fact-note">系统会先核对旧站余额记录；可以确认未重复入账时，将 {money(d.amountCents)} 加入号主可用余额。</p><label>处理原因<Textarea aria-label="号主收益入账原因" value={supportReason.scope===scope?supportReason.value:""} disabled={locked} maxLength={500} onChange={e=>setSupportReason({scope,value:e.target.value})} rows={2}/></label><Button disabled={locked||supportReason.scope!==scope||[...supportReason.value.trim()].length<3} onClick={()=>choose("owner-credit",d.id)}>核对并入账</Button></div>)}
    {canCredit && data && (data.availability==='KNOWN' && data.stage==='4' || data.availability==='NOT_IMPORTED') && data.duties.filter(d=>d.kind==='RENTER_REFUND'&&(['PENDING','MATURED'].includes(d.status)||d.status==='SETTLED'&&d.settledBy==='FINANCE')).map(d=>
      <LegacyRefundChoice key={`${scope}|${d.id}|${nonce}|${refreshNonce}`} orderId={orderId} dutyId={d.id} dutyRevision={d.revision} amountCents={d.amountCents} refresh={`${nonce}:${refreshNonce}`} disabled={locked} money={money} onRefresh={()=>setNonce(n=>n+1)}
        onReview={body=>{if(current()&&!locked)setConfirm({scope,value:{command:'refund-case',dutyId:d.id,body}});}}
        onDemoReview={(body,demoScope)=>{if(current()&&!locked)setConfirm({scope,value:{command:'demo-refund',dutyId:d.id,body,demoScope}});}}/>)}
    {canCommissionCredit && data && (data.availability==="NOT_IMPORTED" || data.availability==="KNOWN" && data.stage==="4") && data.duties.filter(d=>d.kind==="COMMISSION"&&d.status==="MATURED").map((d,index)=><div className="lc-source" key={d.id}><h3>分销佣金入账 · 第 {index+1} 笔</h3><p className="oc-fact-note">收益人：{d.beneficiary?.name??"资料暂不可用"} · 佣金 {money(d.amountCents)}。系统会先核对旧站余额记录，确认未重复后记入该用户可用余额。</p><label>处理原因<Textarea aria-label={`分销佣金入账原因 ${d.beneficiary?.name??"资料待核"} 第${index+1}笔`} value={commissionReasons.scope===scope?commissionReasons.value[d.id]??"":""} disabled={locked||!d.beneficiary?.name} maxLength={500} onChange={e=>setCommissionReasons({scope,value:{...(commissionReasons.scope===scope?commissionReasons.value:{}),[d.id]:e.target.value}})} rows={2}/></label><Button disabled={locked||!d.beneficiary?.name||commissionReasons.scope!==scope||[...(commissionReasons.value[d.id]??"").trim()].length<3} onClick={()=>choose("commission-credit",d.id)}>核对并入账佣金</Button></div>)}
    {confirmation ? <div className="lc-confirm" role="group" aria-label="确认旧单处理"><p>{confirmation.command==="demo-refund"?'仅按历史未退款的假设模拟本次退款；不会调用汇聚，也不代表真实退款或到账。':confirmation.command==="refund-case"?'确认后记录核对结果；如有应退金额，系统将按原支付单发起退款，渠道结果以回执为准。':confirmation.command==="owner-credit"?"确认后将按系统核对结果记入号主可用余额；该操作不代表银行卡已到账。":confirmation.command==="commission-credit"?"确认后将按系统核对结果记入收益人可用余额；该操作不代表银行卡已到账。":`请核对当前版本与来源责任：${commandName[confirmation.command]}。该操作不证明资金已到账，也不清零其他责任。`}</p>
      {confirmation.command==='refund-case'&&refundSummary?<p className="text-sm">历史已退 {money(refundSummary.previous)} · 已抵本次 {money(refundSummary.applied)} · 本次创建退款 {money(refundSummary.next)}</p>:null}
      <Button disabled={loading||confirmation.command==='refund-case'&&!refundSummary} onClick={() => void submit()}>{confirmation.command === "confirm" ? "确认提交" : `确认${commandName[confirmation.command]}`}</Button><Button variant="secondary" disabled={loading} onClick={() => setConfirm({ scope, value: null })}>返回核对</Button></div> : null}
    {p.state === "UNREADABLE" ? <p role="status">原请求存储无法核对，新的写入已暂停；请保留原记录。当前订单读取仍可使用。</p> : p.state === "VALID" ? <div className="lc-confirm" role="status"><p>存在原处理请求，核清结果前不得另建操作。</p><Button variant="secondary" disabled={loading} onClick={() => void recover()}>核对原请求</Button>{recovered?.state === "UNKNOWN" && p.intent.command !== "demo-refund" ? <Button variant="secondary" disabled={loading} onClick={() => void sendOriginal()}>重试原请求</Button> : null}{recovered?.state === "KNOWN_REJECTED" ? <><p>原请求已明确拒绝，请刷新核对后修改。</p><Button variant="secondary" disabled={loading} onClick={() => { clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }}>刷新并重新核对</Button></> : null}</div> : null}
  </section>;
}
