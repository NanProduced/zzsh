import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseYuanToCents } from "@zzsh/ui/display-money";
import { friendlyError, formatDate, type SessionSnapshot } from "../api";
import { Button } from "../components/ui-elements";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ConfirmAlertDialog } from "../components/ui/alert-dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { clearLegacyAdminIntent, inspectLegacyAdminIntent, legacyAdminSubject, previewLegacyAdminContinuation, readLegacyAdminContinuation, recoverLegacyAdminIntent, retainLegacyAdminIntent, sendLegacyAdminIntent, type LegacyAdminAction, type LegacyAdminPending, type LegacyAdminProposal, type LegacyAdminQuantities, type LegacyAdminReceipt, type LegacyAdminView, type LegacyDemoScope } from "../lib/legacy-continuation-client";
import {LegacyRefundChoice} from './legacy-refund-choice';
import "./legacy-continuation.css";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
const commandName: Record<LegacyAdminAction, string> = { propose: "协助提交结算方案", confirm: "客服确认结算方案", reject: "退回结算方案", hold: "暂扣押金", release: "解除暂扣", confiscate: "没收押金", support_cancel: "取消订单并退款", mature: "核定佣金成熟", void: "按已核来源作废佣金", "owner-credit": "入账号主收益", "commission-credit":"入账分销佣金", "refund-case":"创建退款任务", "demo-refund":"模拟退款" };
const amountName: Record<string, string> = { payMoney: "原已付", saleEarnings: "号主毛结算", returnOrderMoney: "退款毛额", detainMoney: "原扣留金额", ownerNet: "号主应结", refundNet: "租客净应退", platformContribution: "平台结算贡献（分配额）", commissionPool: "佣金池", depositCompensation: "押金补偿责任" };
const dutyName: Record<string, string> = { RENTER_REFUND: "租客退款", OWNER_CREDIT: "号主应结", COMMISSION: "佣金", DEPOSIT_COMPENSATION: "押金补偿" };
const money = (cents: string) => `¥${BigInt(cents) / 100n}.${(BigInt(cents) % 100n).toString().padStart(2, "0")}`;
const legacyErrors: Record<string, string> = { DEPOSIT_SHORT: "本单已付金额不足以覆盖实际消耗，请核对数量并与双方沟通。", RETURN_NEGATIVE: "按原单规则计算后退款金额不足，请核对实际消耗。", EVIDENCE_ISOLATED: "旧单计价资料需要核对，暂不能提交方案。", MISSING_STORED_SETTLEMENT: "当前方案金额不完整，请退回后重新核对。", FINANCE_FACT_UNAVAILABLE: "资金处理记录暂不可用，请稍后核对。", FINANCE_FACT_UNKNOWN: "资金处理状态尚未确认，请先核对原单。", DEPOSIT_ALREADY_SETTLED: "本单已有退款责任记录，请先核对，不能重复处理。", CONTINUATION_REVISION_CONFLICT: "本单已有新进展，请刷新后重新核对。", PLAN_FINGERPRINT_MISMATCH: "本次预估已变化，请重新预览。", DUTY_REVISION_CONFLICT: "处理状态已更新，请刷新后核对。", STATUS_INVALID: "订单状态已变化，请刷新后核对。", QUANTITY_INVALID: "消耗数量不正确，请检查填写内容。", PRECISION_UNSUPPORTED: "本单结算金额不能准确记录到分，请核对数量并联系维护人员。", CONFIRM_POOL_NEGATIVE: "结算金额与原单实付不相符，请核对价格和消耗。", OWNER_NET_NEGATIVE: "号主结算金额不足以覆盖包赔费用，请核对原单。" };
legacyErrors.WALLET_CREDIT_HISTORY_UNPROVEN = "无法确认旧站余额中是否已包含这笔收益，请先核对历史记录。";
legacyErrors.WALLET_CREDIT_BASIS_UNAVAILABLE = "结算依据不完整，暂不能入账。";
legacyErrors.PAYMENT_BASIS_UNAVAILABLE = "原付款记录不完整，请联系客服核实。";
legacyErrors.COMMISSION_SOURCE_UNAVAILABLE = "本单分销记录尚未核清，请联系运营处理。";
legacyErrors.COMMISSION_ALREADY_PAID = "本单已有入账佣金，请联系运营处理。";
legacyErrors.REFUND_HISTORY_REQUIRES_OFFLINE = "本单存在旧退款记录，请先线下核对，避免重复处理。";
function legacyError(error: unknown) { const reason = error && typeof error === "object" && "reason" in error ? (error as { reason?: unknown }).reason : undefined; return typeof reason === "string" && legacyErrors[reason] ? legacyErrors[reason] : friendlyError(error); }
type Scoped<T> = { scope: string; value: T };
const quantityLabels: Record<keyof LegacyAdminQuantities, string> = { expendHaff: "哈夫币（M）", barrett: "巴雷特子弹（发）", bullet: "6级子弹（组，60发/组）", awm: "AWM子弹（发）", armor: "6级甲（件）", helmet: "6级头盔（件）", coffee: "咖啡（件）", card: "保险体验卡（天）" };
// 未核对的消耗不能默认成 0：所有项目保持空白，由经办人逐项确认后再预览。
const emptyQuantities = (): LegacyAdminQuantities => ({ expendHaff: "", barrett: "", bullet: "", awm: "", armor: "", helmet: "", coffee: "", card: "" });
const quantityKeys = Object.keys(quantityLabels) as Array<keyof LegacyAdminQuantities>;
const quantitiesComplete = (value: LegacyAdminQuantities) => quantityKeys.every((key) => value[key].trim() !== "");
type LegacyResourceSnapshot = { source?: string; haff?: { quantity: string | null } | null; materials: Array<{ code?:string; name: string | null; quantity: string | null; unit: string | null }>; materialsTruncated?:boolean; termDays?: string | null; safeBoxText?: string | null; gradingText?: string | null; loginMethodText?: string | null };
const haffM = (quantity: string | null | undefined) => {
  if (!quantity || !/^\d+$/.test(quantity)) return "未记录";
  const value = BigInt(quantity), whole = value / 1000000n, rest = value % 1000000n;
  return rest === 0n ? `${whole}M` : `${whole}.${rest.toString().padStart(6, "0").replace(/0+$/, "")}M`;
};
const materialUnit = (unit: string | null | undefined) => unit === "ROUND" ? "发" : unit === "PIECE" ? "件" : unit === "DAY" ? "天" : "";
const materialQuantity = (item:LegacyResourceSnapshot['materials'][number]) => {
  if(typeof item.quantity!=="string"||!/^(0|[1-9]\d{0,23})$/.test(item.quantity))return "未记录";
  if(item.unit==="ROUND"&&["level6_round","df_billable_level6_bullet"].includes(item.code??"")&&BigInt(item.quantity)%60n===0n)return `${BigInt(item.quantity)/60n}组（${item.quantity}发）`;
  return `${item.quantity}${materialUnit(item.unit)}`;
};
export function LegacyAdminContinuationPanel({ snapshot, orderId, frozenAccount, refreshNonce = 0, onViewChange, actionsTarget }: { snapshot: Snapshot; orderId: string; frozenAccount?: LegacyResourceSnapshot | null; refreshNonce?: number; onViewChange?: (view: LegacyAdminView | null) => void; actionsTarget?:HTMLElement|null }) {
  const quantityId=useId();
  const subject = legacyAdminSubject(snapshot.adminUserId, orderId), scope = subject + "|" + snapshot.session.id + "|" + snapshot.permissions.slice().sort().join(",") + "|" + snapshot.security.isBoss;
  const live = useRef({ scope, ticket: 0 }); if (live.current.scope !== scope) live.current = { scope, ticket: live.current.ticket + 1 };
  const [view, setView] = useState<Scoped<LegacyAdminView | null>>({ scope, value: null }), [error, setError] = useState<Scoped<string>>({ scope, value: "" });
  const [pending, setPending] = useState<Scoped<LegacyAdminPending>>({ scope, value: { state: "NONE", intent: null } }), [receipt, setReceipt] = useState<Scoped<LegacyAdminReceipt | null>>({ scope, value: null });
  const [confirm, setConfirm] = useState<Scoped<{ command: LegacyAdminAction; dutyId: string | null; body: Record<string, unknown>;demoScope?:LegacyDemoScope } | null>>({ scope, value: null });
  const [busy, setBusy] = useState<Scoped<boolean>>({ scope, value: false }), [nonce, setNonce] = useState(0), [sourceRef, setSourceRef] = useState<Scoped<string>>({ scope, value: "" }), [reason, setReason] = useState<Scoped<string>>({ scope, value: "" });
  const [supportReason, setSupportReason] = useState<Scoped<string>>({ scope, value: "" });
  const [cancelForm, setCancelForm] = useState<Scoped<{refund:string;owner:string;reason:string}>>({scope,value:{refund:"",owner:"",reason:""}});
  const [commissionReasons,setCommissionReasons]=useState<Scoped<Record<string,string>>>({scope,value:{}});
  const [proposalForm, setProposalForm] = useState<Scoped<{ onBehalf: "renter" | "owner" | ""; quantities: LegacyAdminQuantities }>>({ scope, value: { onBehalf: "", quantities: emptyQuantities() } });
  const [proposal, setProposal] = useState<Scoped<{ data: LegacyAdminProposal; formKey: string } | null>>({ scope, value: null });
  const [proposeOpen, setProposeOpen] = useState(false);
  const [operation, setOperation] = useState<Scoped<{kind:"review"|"void"|"owner-credit"|"commission-credit"|"refund"|"support_cancel"; dutyId?:string}|null>>({scope,value:null});
  const [retryOpen, setRetryOpen] = useState<Scoped<boolean>>({scope,value:false});
  // 详情页只读：结算表单收进弹窗，页面本身不放输入框。
  const current = () => live.current.scope === scope, data = view.scope === scope ? view.value : null, p = pending.scope === scope ? pending.value : { state: "NONE" as const, intent: null }, loading = busy.scope === scope && busy.value;
  const reportView = useRef(onViewChange); reportView.current = onViewChange;
  useEffect(() => { reportView.current?.(data); }, [scope, data]);
  const form = proposalForm.scope === scope ? proposalForm.value : { onBehalf: "" as const, quantities: emptyQuantities() }, preview = proposal.scope === scope ? proposal.value : null;
  const cancel = cancelForm.scope===scope?cancelForm.value:{refund:"",owner:"",reason:""};
  const cancelRefund=parseYuanToCents(cancel.refund),cancelOwner=parseYuanToCents(cancel.owner),cancelPaid=data?.amounts.payMoney?.cents??null,cancelReason=cancel.reason.trim();
  const cancelValid=cancelRefund!==null && cancelOwner!==null && cancelPaid!==null && /^(0|[1-9]\d{0,15})$/.test(cancelRefund) && /^(0|[1-9]\d{0,15})$/.test(cancelOwner)
    && BigInt(cancelRefund)+BigInt(cancelOwner)<=BigInt(cancelPaid) && [...cancelReason].length>=3 && cancelReason.length<=500 && new TextEncoder().encode(cancelReason).length<=600 && !/[\u0000-\u001f\u007f]/.test(cancelReason);
  const canOperate = snapshot.security.isBoss || snapshot.permissions.includes("order.legacy.continue"), canCredit=canOperate && (snapshot.security.isBoss || snapshot.permissions.includes("order.settlement.write")), canCommissionCredit=canCredit && (snapshot.security.isBoss || snapshot.permissions.includes("finance.document.read")), locked = loading || p.state !== "NONE";
  useEffect(() => {
    const abort = new AbortController(), ticket = ++live.current.ticket;
    setView({ scope, value: null }); setConfirm({ scope, value: null }); setReceipt({ scope, value: null }); setProposal({ scope, value: null }); setPending({ scope, value: inspectLegacyAdminIntent(subject, orderId) }); setProposeOpen(false); setOperation({scope,value:null});setRetryOpen({scope,value:false});
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
      if (command === "support_cancel") {
        if (!canCredit || !cancelValid || cancelRefund===null || cancelOwner===null) return;
        body = { expectedRevision: data.revision, inputEvidenceId: data.evidenceId, refundCents: cancelRefund, ownerCents: cancelOwner, reason: cancelReason, originalPaymentChecked:true };
      } else if (command === "propose") {
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
      setPending({ scope, value: { state: "VALID", intent } });
      await sendLegacyAdminIntent(intent);
      if (!current() || live.current.ticket !== ticket) return;
      clearLegacyAdminIntent(intent); setPending({ scope, value: { state: "NONE", intent: null } }); setConfirm({ scope, value: null }); setProposeOpen(false);setOperation({scope,value:null}); setNonce(n => n + 1);
    } catch (e) { if (current() && live.current.ticket === ticket) { const retained=inspectLegacyAdminIntent(subject, orderId); setPending({ scope, value: retained }); setError({ scope, value: legacyError(e) }); if(retained.state!=="NONE"){setConfirm({scope,value:null});setProposeOpen(false);setOperation({scope,value:null});} } }
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
  const activeOperation=operation.scope===scope?operation.value:null;
  const action=(node:ReactNode)=>actionsTarget===undefined?node:actionsTarget?createPortal(node,actionsTarget):null;
  const confirmationDuty=confirmation?.dutyId?data?.duties.find(d=>d.id===confirmation.dutyId):undefined;
  const refundDuty=confirmation?.command==='refund-case'?data?.duties.find(d=>d.id===confirmation.dutyId):undefined;
  const refundPrevious=confirmation?.body.previouslyRefundedCents,refundApplied=confirmation?.body.priorAppliedToDutyCents;
  const refundSummary=refundDuty&&typeof refundPrevious==='string'&&/^(0|[1-9]\d{0,23})$/.test(refundPrevious)
    && typeof refundApplied==='string'&&/^(0|[1-9]\d{0,23})$/.test(refundApplied)&&BigInt(refundApplied)<=BigInt(refundDuty.amountCents)
    ? {previous:refundPrevious,applied:refundApplied,next:(BigInt(refundDuty.amountCents)-BigInt(refundApplied)).toString()}:null;
  return <section className="oc-section lc-admin" aria-label="旧单续办与责任" aria-busy={loading}>
    <header><div><h2>旧单办理与责任</h2><p>{data?.stage ? ({ "3": "进行中", "8": "待号主确认", "9": "待租客确认", "4": "订单已完成", "5": "订单已取消" }[data.stage] ?? "未记录") : "独立核对续办依据"}</p></div><Button variant="secondary" size="sm" disabled={loading} onClick={() => setNonce(n => n + 1)}>刷新</Button></header>
    {error.scope === scope && error.value ? <p role="alert">{error.value}</p> : null}
    {!data ? <p className="oc-fact-note">{error.scope === scope && error.value ? "续办资料暂不可用，订单主体信息保留。" : "正在核对续办资料…"}</p> : data.availability !== "KNOWN" && data.stage !== "5" ? <p className="oc-fact-note">{data.availability === "NOT_IMPORTED" ? "本单续办来源尚未记录。" : "本单来源存在隔离事项，不能据此办理。"}</p> : <>
      <dl className="oc-fact-list">{Object.entries(data.amounts).filter(([key]) => amountName[key] && (data.stage!=="5" || ["payMoney","ownerNet","refundNet","platformContribution"].includes(key))).map(([key, amount]) => <div key={key}><dt>{amountName[key]}</dt><dd>{amount ? `¥${amount.yuan}` : "未记录"}</dd></div>)}</dl>
      <p className="oc-fact-note">订单完成、资金入账和渠道到账分别核对；解除暂扣不会自动追加扣留部分退款。</p>
      {["4","5"].includes(data.stage ?? "") && data.duties.some(d => d.kind === "RENTER_REFUND" && ["PENDING", "MATURED"].includes(d.status)) ? <p className="oc-fact-note">{data.refundDueAt ? `退款最早处理时间：${formatDate(data.refundDueAt)}。` : "退款处理时间待核。"} 具体到账状态以渠道记录为准。</p> : null}
      {data.reasons.some(code => code.startsWith("FINANCE_FACT")) ? <p className="oc-fact-note">原资金处理结果尚未确认，暂时无法协助结算或处理押金。</p> : null}
      {data.reasons.includes("REFUND_HISTORY_REQUIRES_OFFLINE") ? <p className="oc-fact-note">本单历史退款需要线下核对，相关退款和号主收益暂不自动处理。</p> : null}
      {canOperate&&["hold","release","confiscate"].some(kind=>data.capabilities.includes(kind))?action(<div className="lc-actions">{(["hold", "release", "confiscate"] as const).filter(kind => data.capabilities.includes(kind)).map(kind => <Button key={kind} variant={kind === "confiscate" ? "danger" : "secondary"} disabled={locked} onClick={() => choose(kind)}>{commandName[kind]}</Button>)}</div>):null}
      {canOperate && data.capabilities.includes("propose") ? <div className="mt-4">{action(<Button variant="secondary" disabled={locked} onClick={() => setProposeOpen(true)}>协助发起结算</Button>)}<Dialog open={proposeOpen} onOpenChange={open=>{if(!loading)setProposeOpen(open);}}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>协助发起结算</DialogTitle></DialogHeader><div className="space-y-4">
        <p className="text-sm text-muted-foreground">先与双方核实实际消耗，再选择发起方并预览方案；提交后由另一方确认。</p>
        {frozenAccount ? <section aria-label="迁入时账号资源" className="space-y-2 text-sm">
          <div><h3 className="font-semibold">迁入时账号资源</h3><p className="mt-1 text-muted-foreground">仅供参考，不是下单时的冻结快照{frozenAccount.materialsTruncated?'；物资记录未全部显示':''}。</p></div>
          <p className="text-muted-foreground">租期 {frozenAccount.termDays ? `${frozenAccount.termDays} 天` : "未记录"}{frozenAccount.safeBoxText ? ` · ${frozenAccount.safeBoxText}` : ""}{frozenAccount.gradingText ? ` · ${frozenAccount.gradingText}` : ""}{frozenAccount.loginMethodText ? ` · ${frozenAccount.loginMethodText}` : ""}</p>
          <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>资源</TableHead><TableHead className="text-right">迁入时数量</TableHead></TableRow></TableHeader><TableBody>
            <TableRow><TableCell>哈夫币</TableCell><TableCell className="text-right tabular-nums">{haffM(frozenAccount.haff?.quantity)}</TableCell></TableRow>
            {frozenAccount.materials.map((item,index)=><TableRow key={`${item.code??item.name??'unknown'}-${index}`}><TableCell>{item.name??"名称未记录"}</TableCell><TableCell className="text-right tabular-nums">{materialQuantity(item)}</TableCell></TableRow>)}
          </TableBody></Table></div>
        </section> : null}
        <div className="space-y-1 text-sm"><span>结算发起方</span><Select value={form.onBehalf || "NONE"} disabled={locked} onValueChange={value => { setProposalForm({ scope, value: { ...form, onBehalf: value === "renter" || value === "owner" ? value : "" } }); setProposal({ scope, value: null }); }} items={[{ value: "NONE", label: "请选择" }, { value: "renter", label: "租客" }, { value: "owner", label: "号主" }]}><SelectTrigger aria-label="结算发起方" className="w-full sm:w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NONE">请选择</SelectItem><SelectItem value="renter">租客</SelectItem><SelectItem value="owner">号主</SelectItem></SelectContent></Select></div>
        <section className="space-y-2" aria-label="本次实际消耗"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">本次实际消耗</h3><p className="mt-1 text-xs text-muted-foreground">核对后填写；哈夫币按 M，6 级子弹按组（60 发/组）。</p></div><Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => {
          const quantities = { ...form.quantities };
          for (const key of quantityKeys) if (!quantities[key].trim()) quantities[key] = "0";
          setProposalForm({ scope, value: { ...form, quantities } }); setProposal({ scope, value: null });
        }}>其他项填 0</Button></div><p className="text-xs text-muted-foreground">只填写当前空白项，已填写的数量不会被覆盖。</p>
        <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>资源与单位</TableHead><TableHead>本次消耗</TableHead></TableRow></TableHeader><TableBody>{(Object.entries(quantityLabels) as Array<[keyof LegacyAdminQuantities, string]>).map(([key, label]) => <TableRow key={key}><TableCell><label htmlFor={`${quantityId}-${key}`}>{label}</label></TableCell><TableCell><Input id={`${quantityId}-${key}`} aria-label={label} inputMode="decimal" value={form.quantities[key]} disabled={locked} onChange={event => { setProposalForm({ scope, value: { ...form, quantities: { ...form.quantities, [key]: event.target.value.trim() } } }); setProposal({ scope, value: null }); }} /></TableCell></TableRow>)}</TableBody></Table></div></section>
        {error.scope === scope && error.value ? <p role="alert" className="text-sm text-destructive">{error.value}</p> : null}
        <Button variant="secondary" disabled={locked || !form.onBehalf || !quantitiesComplete(form.quantities)} onClick={() => void estimate()}>预览结算方案</Button>
        {preview ? <div className="space-y-3 rounded-lg bg-muted/50 p-4"><p className="text-sm font-medium">{preview.data.settlementKind === "EARLY" ? "提前结算" : "正常结算"}</p><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">号主预计结算</dt><dd className="mt-1 font-medium tabular-nums">{preview.data.proposalAmounts.ownerNet == null ? "未记录" : `¥${preview.data.proposalAmounts.ownerNet}`}</dd></div><div><dt className="text-xs text-muted-foreground">租客退款方案金额（未扣暂扣）</dt><dd className="mt-1 font-medium tabular-nums">{preview.data.proposalAmounts.returnOrderMoney == null ? "未记录" : `¥${preview.data.proposalAmounts.returnOrderMoney}`}</dd></div></dl><p className="text-xs text-muted-foreground">此处为结算方案，提交不代表资金已入账或退款到账。</p></div> : null}
        <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="客服发起结算原因" value={supportReason.scope === scope ? supportReason.value : ""} disabled={locked} maxLength={500} onChange={e => setSupportReason({ scope, value: e.target.value })} /></label>
        <Button disabled={locked || !preview || supportReason.scope !== scope || [...supportReason.value.trim()].length < 3} onClick={() => choose("propose")}>核对并提交方案</Button>
      </div></DialogContent></Dialog></div> : null}
      {canOperate && (data.capabilities.includes("confirm") || data.capabilities.includes("reject")) ? <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
        <div><h3 className="text-sm font-semibold">客服协助处理结算方案</h3><p className="mt-1 text-sm text-muted-foreground">订单已有待确认方案；核实后可确认，或退回并重新核对。操作会记录客服身份，不代表退款已到账。</p></div>
        {data.confirmationAmounts ? <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">号主应结</dt><dd className="mt-1 font-medium tabular-nums">¥{data.confirmationAmounts.ownerNet.yuan}</dd></div><div><dt className="text-xs text-muted-foreground">租客应退</dt><dd className="mt-1 font-medium tabular-nums">¥{data.confirmationAmounts.refundNet.yuan}</dd></div></dl> : <p className="text-sm text-muted-foreground">{canCredit ? "方案金额不完整，暂不能确认；可退回后重新核对。" : "当前账号没有确认结算的权限，可退回方案或联系有权限的同事。"}</p>}
        {action(<Button variant="secondary" disabled={locked} onClick={()=>setOperation({scope,value:{kind:"review"}})}>处理结算方案</Button>)}
        <Dialog open={activeOperation?.kind==="review"} onOpenChange={open=>{if(!open&&!loading)setOperation({scope,value:null});}}><DialogContent><DialogHeader><DialogTitle>处理结算方案</DialogTitle></DialogHeader><div className="space-y-3">
        {data.confirmationAmounts ? <p className="text-sm">号主应结 ¥{data.confirmationAmounts.ownerNet.yuan} · 租客应退 ¥{data.confirmationAmounts.refundNet.yuan}</p> : <p className="text-sm">{canCredit?"方案金额不完整，只能退回重新核对。":"当前账号没有确认结算的权限，可退回方案或联系有权限的同事。"}</p>}
        <label className="block space-y-1 text-sm">处理原因<Textarea aria-label="客服处理结算原因" value={supportReason.scope === scope ? supportReason.value : ""} disabled={locked} maxLength={500} onChange={e => setSupportReason({ scope, value: e.target.value })} /></label>
        <div className="flex flex-wrap gap-2">{canCredit && data.capabilities.includes("confirm") && data.confirmationAmounts ? <Button disabled={locked || supportReason.scope !== scope || [...supportReason.value.trim()].length < 3} onClick={() => choose("confirm")}>核对并确认方案</Button> : null}{data.capabilities.includes("reject") ? <Button variant="secondary" disabled={locked || supportReason.scope !== scope || [...supportReason.value.trim()].length < 3} onClick={() => choose("reject")}>退回并重新核对</Button> : null}</div>
        </div></DialogContent></Dialog></div> : null}
    </>}
    {data?.duties.length ? <div className="lc-duty-table"><h3>已记录经济责任</h3><Table><TableHeader><TableRow><TableHead>责任</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>成熟依据</TableHead>{actionsTarget===undefined?<TableHead>合法处理</TableHead>:null}</TableRow></TableHeader><TableBody>{data.duties.map(d => <TableRow key={d.id}><TableCell>{dutyName[d.kind] ?? "责任"}</TableCell><TableCell>{money(d.amountCents)}</TableCell><TableCell>{d.settledBy === "LEGACY_RECORDS" ? "旧侧已处理，不再支付" : d.status==="SETTLED" && d.settledBy==="FINANCE" && ["OWNER_CREDIT","COMMISSION"].includes(d.kind) ? d.financeVerified ? d.amountCents==="0" ? "无需入账" : "已入可用余额" : "账目待核对" : { PENDING: "待处理", MATURED: "成熟待入账", SETTLED: "财账已终定", VOID: "已作废" }[d.status] ?? "未记录"}</TableCell><TableCell>{d.maturityAt ? formatDate(d.maturityAt) : d.kind === "COMMISSION" ? "等待终金额/成熟证据" : "不适用"}</TableCell><TableCell className={actionsTarget===undefined?undefined:"hidden"}>{canOperate && d.kind === "COMMISSION" && d.status === "PENDING" && d.maturityAt ? action(<Button size="sm" variant="secondary" disabled={locked} onClick={() => choose("mature", d.id)}>核定佣金成熟</Button>) : null}{canOperate && d.kind === "COMMISSION" && ["PENDING", "MATURED"].includes(d.status) ? action(<Button size="sm" variant="secondary" disabled={locked} onClick={() => setOperation({scope,value:{kind:"void",dutyId:d.id}})}>按已核来源作废</Button>) : null}</TableCell></TableRow>)}</TableBody></Table></div> : null}
    {canCredit && data?.capabilities.includes("support_cancel") ? action(<Button variant="secondary" disabled={locked} onClick={()=>{setCancelForm({scope,value:{refund:"",owner:"",reason:""}});setOperation({scope,value:{kind:"support_cancel"}});}}>取消订单并退款</Button>) : null}
    <Dialog open={activeOperation?.kind==="support_cancel"} onOpenChange={open=>{if(!open&&!loading)setOperation({scope,value:null});}}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>取消订单并退款</DialogTitle></DialogHeader><div className="space-y-4">
      <p className="text-sm text-muted-foreground">与双方协商后，填写退给租客的金额和号主收益；总额不能超过本单实付，取消后不产生分销佣金。</p>
      <p className="text-sm">本单原实付 <strong className="tabular-nums">{cancelPaid===null?"未记录":money(cancelPaid)}</strong></p>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm" htmlFor={`${quantityId}-refund`}>退给租客（元）<Input id={`${quantityId}-refund`} inputMode="decimal" value={cancel.refund} disabled={locked} onChange={e=>setCancelForm({scope,value:{...cancel,refund:e.target.value}})} /></label><label className="space-y-1 text-sm" htmlFor={`${quantityId}-owner`}>号主收益（元）<Input id={`${quantityId}-owner`} inputMode="decimal" value={cancel.owner} disabled={locked} onChange={e=>setCancelForm({scope,value:{...cancel,owner:e.target.value}})} /></label></div>
      {cancelRefund!==null && cancelOwner!==null && cancelPaid!==null && BigInt(cancelRefund)+BigInt(cancelOwner)>BigInt(cancelPaid)?<p role="alert" className="text-sm text-destructive">退款和号主收益合计不能超过原实付。</p>:null}
      {cancelValid && cancelRefund!==null && cancelOwner!==null && cancelPaid!==null?<p className="text-sm">剩余平台结算贡献：<strong className="tabular-nums">{money((BigInt(cancelPaid)-BigInt(cancelRefund)-BigInt(cancelOwner)).toString())}</strong></p>:null}
      <label className="block space-y-1 text-sm" htmlFor={`${quantityId}-cancel-reason`}>取消原因与协商记录<Textarea id={`${quantityId}-cancel-reason`} value={cancel.reason} disabled={locked} maxLength={500} rows={3} onChange={e=>setCancelForm({scope,value:{...cancel,reason:e.target.value}})} /></label>
      <p className="text-xs text-muted-foreground">金额按元填写，最多两位小数。退款进度和实际到账按渠道记录查看。</p>
      <Button disabled={locked||!cancelValid} onClick={()=>choose("support_cancel")}>核对并继续</Button>
    </div></DialogContent></Dialog>
    <Dialog open={activeOperation?.kind==="void"} onOpenChange={open=>{if(!open&&!loading)setOperation({scope,value:null});}}><DialogContent><DialogHeader><DialogTitle>核对佣金作废依据</DialogTitle></DialogHeader><div className="space-y-3"><p className="text-sm text-muted-foreground">只能引用已受权核定的源作废或父单取消且不应付事实；输入编号不能代替证据。</p><label className="block text-sm">来源核定记录编号<Input value={sourceRef.scope === scope ? sourceRef.value : ""} disabled={locked} maxLength={128} onChange={e => setSourceRef({ scope, value: e.target.value })}/></label><label className="block text-sm">核定理由<Textarea value={reason.scope === scope ? reason.value : ""} disabled={locked} maxLength={500} onChange={e => setReason({ scope, value: e.target.value })} rows={2} /></label><Button disabled={locked||!activeOperation?.dutyId||sourceRef.scope!==scope||!sourceRef.value.trim()||reason.scope!==scope||!reason.value.trim()} onClick={()=>activeOperation?.dutyId&&choose("void",activeOperation.dutyId)}>核对并继续</Button></div></DialogContent></Dialog>
    {canCredit && data && (data.availability==="KNOWN" || data.stage==="5") && ["4","5"].includes(data.stage??"") && data.duties.filter(d=>d.kind==="OWNER_CREDIT"&&d.status==="PENDING").map(d=><div className="lc-source" key={d.id}><h3>号主收益入账</h3><p className="oc-fact-note">待核对金额 {money(d.amountCents)}。</p>{action(<Button variant="secondary" disabled={locked} onClick={()=>setOperation({scope,value:{kind:"owner-credit",dutyId:d.id}})}>处理号主收益</Button>)}<Dialog open={activeOperation?.kind==="owner-credit"&&activeOperation.dutyId===d.id} onOpenChange={open=>{if(!open&&!loading)setOperation({scope,value:null});}}><DialogContent><DialogHeader><DialogTitle>核对号主收益</DialogTitle></DialogHeader><div className="space-y-3"><p className="text-sm">系统会先核对旧站余额记录；确认未重复入账时，将 {money(d.amountCents)} 加入号主可用余额。</p><label className="block text-sm">处理原因<Textarea aria-label="号主收益入账原因" value={supportReason.scope===scope?supportReason.value:""} disabled={locked} maxLength={500} onChange={e=>setSupportReason({scope,value:e.target.value})} rows={2}/></label><Button disabled={locked||supportReason.scope!==scope||[...supportReason.value.trim()].length<3} onClick={()=>choose("owner-credit",d.id)}>核对并入账</Button></div></DialogContent></Dialog></div>)}
    {canCredit && data && ((data.availability==='KNOWN' || data.stage==='5') && ['4','5'].includes(data.stage??'') || data.availability==='NOT_IMPORTED') && data.duties.filter(d=>d.kind==='RENTER_REFUND'&&(['PENDING','MATURED'].includes(d.status)||d.status==='SETTLED'&&d.settledBy==='FINANCE')).map(d=><div className="lc-source" key={`${scope}|${d.id}|${nonce}|${refreshNonce}`}><h3>租客退款</h3><p className="oc-fact-note">应退责任 {money(d.amountCents)}，到账以渠道记录为准。</p>{action(<Button variant="secondary" disabled={locked} onClick={()=>setOperation({scope,value:{kind:"refund",dutyId:d.id}})}>处理退款</Button>)}<Dialog open={activeOperation?.kind==="refund"&&activeOperation.dutyId===d.id} onOpenChange={open=>{if(!open&&!loading)setOperation({scope,value:null});}}><DialogContent size="lg" className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>核对租客退款</DialogTitle></DialogHeader>
      <LegacyRefundChoice orderId={orderId} dutyId={d.id} dutyRevision={d.revision} amountCents={d.amountCents} refresh={`${nonce}:${refreshNonce}`} disabled={locked} money={money} onRefresh={()=>setNonce(n=>n+1)}
        onReview={body=>{if(current()&&!locked)setConfirm({scope,value:{command:'refund-case',dutyId:d.id,body}});}}
        onDemoReview={(body,demoScope)=>{if(current()&&!locked)setConfirm({scope,value:{command:'demo-refund',dutyId:d.id,body,demoScope}});}}/></DialogContent></Dialog></div>)}
    {canCommissionCredit && data && (data.availability==="NOT_IMPORTED" || data.availability==="KNOWN" && data.stage==="4") && data.duties.filter(d=>d.kind==="COMMISSION"&&d.status==="MATURED").map((d,index)=><div className="lc-source" key={d.id}><h3>分销佣金入账 · 第 {index+1} 笔</h3><p className="oc-fact-note">收益人：{d.beneficiary?.name??"资料暂不可用"} · 佣金 {money(d.amountCents)}。</p>{action(<Button variant="secondary" disabled={locked||!d.beneficiary?.name} onClick={()=>setOperation({scope,value:{kind:"commission-credit",dutyId:d.id}})}>处理分销佣金</Button>)}<Dialog open={activeOperation?.kind==="commission-credit"&&activeOperation.dutyId===d.id} onOpenChange={open=>{if(!open&&!loading)setOperation({scope,value:null});}}><DialogContent><DialogHeader><DialogTitle>核对分销佣金</DialogTitle></DialogHeader><div className="space-y-3"><p className="text-sm">收益人：{d.beneficiary?.name??"资料暂不可用"} · {money(d.amountCents)}。系统会核对旧站余额记录，确认未重复后记入可用余额。</p><label className="block text-sm">处理原因<Textarea aria-label={`分销佣金入账原因 ${d.beneficiary?.name??"资料待核"} 第${index+1}笔`} value={commissionReasons.scope===scope?commissionReasons.value[d.id]??"":""} disabled={locked||!d.beneficiary?.name} maxLength={500} onChange={e=>setCommissionReasons({scope,value:{...(commissionReasons.scope===scope?commissionReasons.value:{}),[d.id]:e.target.value}})} rows={2}/></label><Button disabled={locked||!d.beneficiary?.name||commissionReasons.scope!==scope||[...(commissionReasons.value[d.id]??"").trim()].length<3} onClick={()=>choose("commission-credit",d.id)}>核对并入账佣金</Button></div></DialogContent></Dialog></div>)}
    <ConfirmAlertDialog open={confirmation!==null} onOpenChange={open=>{if(!open&&!loading)setConfirm({scope,value:null});}}
      contentLabel="确认旧单处理" title={confirmation?`确认${commandName[confirmation.command]}？`:"确认旧单处理"}
      description={confirmation?.command==="support_cancel"?'请先核对汇聚原付款：确认没有其他已退或未决退款，再提交本次取消；如存在其他退款，请线下协调。此确认不代表退款已到账。':confirmation?.command==="demo-refund"?'仅按历史未退款的假设模拟本次退款；不会调用汇聚，也不代表真实退款或到账。':confirmation?.command==="refund-case"?'确认后记录核对结果；渠道处理与到账以回执为准。':confirmation?.command==="owner-credit"?"确认后按核对结果记入号主可用余额，不代表银行卡已到账。":confirmation?.command==="commission-credit"?"确认后按核对结果记入收益人可用余额，不代表银行卡已到账。":"请核对本次处理的订单、金额和原因；此操作不证明资金已到账。"}
      confirmLabel={confirmation?.command==="confirm"?"确认提交":confirmation?`确认${commandName[confirmation.command]}`:"确认"}
      confirmVariant={confirmation&&["reject","confiscate","void","support_cancel"].includes(confirmation.command)?"destructive":"default"}
      cancelLabel="返回核对" busy={loading} confirmDisabled={confirmation===null||confirmation.command==='refund-case'&&!refundSummary} onConfirm={()=>void submit()}>
      {confirmation?.command==='propose'&&preview?<div className="text-sm"><p>发起方：{form.onBehalf==="renter"?"租客":"号主"} · {preview.data.settlementKind==="EARLY"?"提前结算":"正常结算"}</p><p>号主预计结算 {preview.data.proposalAmounts.ownerNet==null?"未记录":`¥${preview.data.proposalAmounts.ownerNet}`} · 租客退款方案 {preview.data.proposalAmounts.returnOrderMoney==null?"未记录":`¥${preview.data.proposalAmounts.returnOrderMoney}`}</p></div>:null}
      {confirmation?.command==='confirm'&&data?.confirmationAmounts?<p className="text-sm">号主应结 ¥{data.confirmationAmounts.ownerNet.yuan} · 租客应退 ¥{data.confirmationAmounts.refundNet.yuan}</p>:null}
      {confirmation?.command==='support_cancel' && typeof confirmation.body.refundCents==='string' && typeof confirmation.body.ownerCents==='string'?<p className="text-sm">退给租客 {money(confirmation.body.refundCents)} · 号主收益 {money(confirmation.body.ownerCents)}</p>:null}
      {confirmationDuty&&confirmation?.command!=='refund-case'?<p className="text-sm">责任金额：{money(confirmationDuty.amountCents)}{confirmationDuty.beneficiary?.name?` · 收益人：${confirmationDuty.beneficiary.name}`:""}</p>:null}
      {confirmation?.command==='refund-case'&&refundSummary?<p className="text-sm">历史已退 {money(refundSummary.previous)} · 已抵本次 {money(refundSummary.applied)} · 本次创建退款 {money(refundSummary.next)}</p>:null}
      {confirmation?.body.reason?<p className="text-sm">处理原因：{String(confirmation.body.reason)}</p>:null}
      {error.scope === scope && error.value ? <p role="alert" className="text-sm text-destructive">{error.value}</p> : null}
    </ConfirmAlertDialog>
    {p.state === "UNREADABLE" ? <p role="status">原请求存储无法核对，新的写入已暂停；请保留原记录。当前订单读取仍可使用。</p> : p.state === "VALID" ? <div className="lc-confirm" role="status"><p>存在原处理请求，核清结果前不得另建操作。</p><Button variant="secondary" disabled={loading} onClick={() => void recover()}>核对原请求</Button>{recovered?.state === "UNKNOWN" && p.intent.command !== "demo-refund" ? action(<Button variant="secondary" disabled={loading} onClick={() => setRetryOpen({scope,value:true})}>重试原请求</Button>) : null}{recovered?.state === "KNOWN_REJECTED" ? <><p>原请求已明确拒绝，请刷新核对后修改。</p><Button variant="secondary" disabled={loading} onClick={() => { clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }}>刷新并重新核对</Button></> : null}</div> : null}
    <ConfirmAlertDialog open={retryOpen.scope===scope&&retryOpen.value&&p.state==="VALID"} onOpenChange={open=>{if(!open&&!loading)setRetryOpen({scope,value:false});}} contentLabel="确认重试原请求" title="确认重试原请求？" description="仅重试已保存的同一笔请求；请先核对原处理结果。" confirmLabel="确认重试" cancelLabel="返回核对" confirmVariant="default" busy={loading} onConfirm={()=>{setRetryOpen({scope,value:false});void sendOriginal();}}/>
  </section>;
}
