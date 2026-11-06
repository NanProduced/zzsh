import { useEffect, useRef, useState } from "react";
import { adminRequest, AdminApiError, ADMIN_AUTH_FAILURE_EVENT } from "../api";
import { Button } from "@/components/ui/button";
import { financeTime, stateLabels } from "./admin-finance-api";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/admin-list/list-table";
import { PreviewCopyButton } from "@/components/admin-preview";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { formatFundingCents } from "./supply-review/model";
import { channelEvidenceErrorDisplay, channelEvidenceStatusDisplay, evidenceCents, type ChannelEvidenceDisplay } from "./admin-channel-evidence-model";

export type ChannelSearchClue = { merchant: string; ref: string; trx: string; family: string };
type Section = { status?: string; coverage?: string; truncated?: boolean; reasonCodes?: string[]; [key: string]: unknown };
const money = (v: unknown) => { const c = evidenceCents(v); return c === null ? "未知" : formatFundingCents(c); };
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const ORIGINAL_NO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CHANNEL_TRX_NO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const familyLabels: Record<string, string> = {
  PAYOUT: "提现出款",
  REFUND: "退款",
  ALIPAY_NATIVE: "支付宝收款",
  WEIXIN_NATIVE: "微信收款"
};
const subjectRoleLabels: Record<string, string> = { RENTER: "租客", OWNER: "号主", BOTH: "租客 / 号主", WITHDRAWER: "提现人" };
const evidenceLabels: Record<string, string> = { JOINPAY_CANDIDATE: "汇聚请求记录", JOINPAY_VERIFIED: "已登记渠道核验标记", SYNTHETIC_PROTOCOL: "协议模拟记录", LOCAL_CONTROLLED: "本地受控记录", LOCAL_RECORDS_NOT_REVALIDATED: "本站记录，未重新核验" };
const dispositionLabels: Record<string, string> = { RESERVED: "已预留", PAYOUT_POSTED: "已核销", RELEASE_POSTED: "已退回可用余额" };
const channelStateLabels: Record<string, string> = { ...stateLabels, NONE: "待处理", ACTION_READY: "待付款", PROCESSING_UNCONFIRMED: "处理中，结果待核", REJECTED_BY_CHANNEL: "渠道拒绝", CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "渠道成功，待本站确认", ACCEPTED: "本站已接纳", READY: "待提交", REVIEW_REQUIRED: "需核对" };
function Line({ title, section }: { title: string; section: Section | null | undefined }) {
  const d = channelEvidenceStatusDisplay(section);
  return <li data-evidence-state={d.kind}><strong>{title}</strong>：{d.text}{section?.reasonCodes?.length ? <Collapsible><CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm"/>}>查看技术原因<ChevronDown size={14} aria-hidden/></CollapsibleTrigger><CollapsibleContent className="break-words text-xs text-muted-foreground">{section.reasonCodes.join("、")}</CollapsibleContent></Collapsible> : null}</li>;
}
type LoadState = { display?: ChannelEvidenceDisplay; body?: any; path?: string; requestId?: string | null; loading?: boolean; target?: string; queriedAt?: string };
const text = (v: unknown) => typeof v === "string" && v ? v : "未知";
/** 只接受最后一次请求的结果；输入改变或新请求开始后，迟到响应一律丢弃。 */
async function load(path: string, seq: { current: number }, set: (v: LoadState) => void, target?: string) {
  const id = ++seq.current;
  const now = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  set({ path, loading: true, target, queriedAt: now });
  try {
    const body: any = await adminRequest(path, undefined, "GET");
    if (id === seq.current) set({ body, path, requestId: typeof body?.requestId === "string" ? body.requestId : null, target, queriedAt: now });
  } catch (e) {
    if (id === seq.current) set({ path, display: channelEvidenceErrorDisplay(e instanceof AdminApiError ? e.status : undefined), requestId: e instanceof AdminApiError ? e.requestId ?? null : null, target, queriedAt: now });
  }
}
function Meta({ state, seq, set }: { state: LoadState; seq: { current: number }; set: (v: LoadState) => void }) {
  return <p className="oc-fact-note" data-evidence-meta>{state.loading ? "读取中…" : `查询对象：${state.target ?? "未指定"} · 查询时间：${state.queriedAt ?? "未记录"} · 请求编号：${state.requestId ?? "未返回"}`}
    {state.path && !state.loading ? <Button size="sm" type="button" variant="secondary" onClick={() => void load(state.path!, seq, set, state.target)}>重新读取</Button> : null}</p>;
}
function Failure({ display }: { display: ChannelEvidenceDisplay }) { return <p role="status" data-evidence-state={display.kind}>{display.text}</p>; }

/** 订单链路：读取本单渠道付款/退款证据（只读，不发起渠道查询）。 */
export function OrderChannelEvidence({ orderId, canRead, autoLoad = false }: { orderId: string; canRead: boolean; autoLoad?: boolean }) {
  const [state, setState] = useState<LoadState | null>(null), seq = useRef(0);
  const path = '/finance/channel-evidence/orders/' + encodeURIComponent(orderId);
  const target = '订单 [' + orderId + ']';
  useEffect(() => {
    const clear = () => { seq.current++; setState(null); };
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, clear);
    if (canRead && autoLoad) void load(path, seq, setState, target);
    return () => { seq.current++; window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, clear); };
  }, [canRead, autoLoad, path, target]);
  if (!canRead) return null;
  const body = state?.body?.kind === 'ORDER' && state.body.orderId === orderId ? state.body : undefined;
  const payment = body?.payment;
  const refund = body?.refund;
  return <div className="oc-channel-evidence space-y-1 text-sm" data-channel-evidence="order">
    <Button size="sm" variant="secondary" type="button" onClick={() => void load(path, seq, setState, target)}>读取渠道证据</Button>
    {state ? <Meta state={state} seq={seq} set={setState}/> : null}
    {state?.display ? <Failure display={state.display}/> : null}
    {body ? <ul className="space-y-2">
      <Line title="汇聚收款" section={payment}/>
      {payment?.merchantOrderNo ? <li>商户 {text(payment.merchantIdentityId)} · 商户原单号 {payment.merchantOrderNo} · {familyLabels[payment.productFamily] ?? '支付方式未记录'}</li> : null}
      {payment?.request ? <li>请求金额 {money(payment.amounts?.requested)} · 本站接纳 {money(payment.amounts?.accepted)} · 渠道实收 {money(payment.amounts?.trustedChannel)}</li> : null}
      {payment?.trustedObservation ? <li>渠道状态 {payment.trustedObservation.channelStatus === 'SUCCEEDED' ? '渠道报告成功' : payment.trustedObservation.channelStatus === 'FAILED' ? '渠道报告失败' : payment.trustedObservation.channelStatus === 'CREATED_UNPAID' ? '渠道报告未付' : '未记录'} · 渠道流水 {text(payment.trustedObservation.channelTrxNo)} · 核对时间 {financeTime(payment.trustedObservation.observedAt)}</li> : null}
      <Line title="汇聚退款" section={refund}/>
      {Array.isArray(refund?.intents) ? refund.intents.map((intent: Section) => <li key={text(intent.intentId)}>
        退款单 {text(intent.refundOrderNo)} · 申请 {money(intent.amount)} · 本地状态 {stateLabels[text(intent.localState)] ?? text(intent.localState)} · 渠道实退 {money({cents:intent.trustedActualCents})} · 退款流水 {text(intent.trustedRefundTrxNo)}
      </li>) : null}
    </ul> : state?.body ? <p role="status">本次返回的渠道证据与订单不匹配。</p> : null}
    <p className="oc-fact-note">只读本地登记证据，不发起渠道查询；银行到账未记录。</p>
  </div>;
}

/** 资金页/用户资金：按商户原号读取提现证据或检索原单；商户范围由服务端授予，不由输入扩大。 */
export function ChannelEvidenceLookup({ canRead, canSearch, onOpenOrder, initialSearch, subjectUserId, canReadOrders = true }: {
  canRead: boolean; canSearch: boolean; onOpenOrder?: (id: string, clue: ChannelSearchClue) => void; initialSearch?: ChannelSearchClue; subjectUserId?: string; canReadOrders?: boolean;
}) {
  const [merchant, setMerchant] = useState(initialSearch?.merchant ?? ""), [ref, setRef] = useState(initialSearch?.ref ?? ""), [family, setFamily] = useState(initialSearch?.family ?? "PAYOUT");
  const [trx, setTrx] = useState(initialSearch?.trx ?? ""), [withdrawalRef, setWithdrawalRef] = useState("");
  const [mode, setMode] = useState<"transaction" | "withdrawal">(canSearch ? "transaction" : "withdrawal");
  const [state, setState] = useState<LoadState | null>(null), seq = useRef(0);
  const reset = () => { seq.current++; setState(null); };
  useEffect(() => {
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, reset);
    if (initialSearch && canRead && canSearch) search();
    return () => { seq.current++; window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, reset); };
  }, []);
  const scopedPath = (path: string) => subjectUserId ? `${path}?${new URLSearchParams({ subjectUserId })}` : path;
  const validSubject = subjectUserId === undefined || REF.test(subjectUserId);
  const withdrawal = () => {
    if (!validSubject || !REF.test(merchant) || !REF.test(withdrawalRef)) {
      seq.current++;
      setState({ display: { kind: "unknown", text: "请填写有效的商户标识和提现申请 ID。" } });
      return;
    }
    void load(scopedPath('/finance/channel-evidence/withdrawals/' + encodeURIComponent(merchant) + '/' + encodeURIComponent(withdrawalRef)), seq, setState, '商户 [' + merchant + '] 提现申请 [' + withdrawalRef + ']');
  };
  const search = () => {
    if (!validSubject || !REF.test(merchant) || !ref && !trx || ref && !ORIGINAL_NO.test(ref) || trx && !CHANNEL_TRX_NO.test(trx)) {
      seq.current++;
      setState({ display: { kind: "unknown", text: "请填写有效商户标识，以及完整的商户原单号或渠道流水号。" } });
      return;
    }
    const query = new URLSearchParams({ productFamily: family });
    if (ref) query.set("merchantOrderNo", ref);
    if (trx) query.set("channelTrxNo", trx);
    if (subjectUserId) query.set("subjectUserId", subjectUserId);
    void load('/finance/channel-evidence/originals/' + encodeURIComponent(merchant) + '?' + query, seq, setState, '商户 [' + merchant + '] ' + (familyLabels[family] ?? family));
  };
  if (!canRead) return null;
  if (!validSubject) return <p role="alert" className="text-sm text-destructive">当前用户范围无法识别，请返回用户列表重新打开。</p>;
  const w = state?.body?.kind === "WITHDRAWAL" ? state.body.withdrawal as Section : undefined;
  const s = state?.body?.kind === "ORIGINAL_SEARCH" ? state.body.search as Section : undefined;
  return <div className="finance-channel-evidence space-y-4 text-sm" data-channel-evidence="lookup" role="group" aria-label="渠道记录查询">
    {canSearch ? <div className="inline-flex rounded-lg border bg-muted/30 p-1" role="group" aria-label="查询方式">
      <Button type="button" size="sm" variant={mode === "transaction" ? "secondary" : "ghost"} aria-pressed={mode === "transaction"} onClick={() => { reset(); setMode("transaction"); }}>查交易记录</Button>
      <Button type="button" size="sm" variant={mode === "withdrawal" ? "secondary" : "ghost"} aria-pressed={mode === "withdrawal"} onClick={() => { reset(); setMode("withdrawal"); }}>查提现申请</Button>
    </div> : null}
    <p className="text-sm text-muted-foreground">{mode === "transaction" ? "输入商户标识，再填写商户原单号或渠道流水号，可在资金记录中查找这些编号。" : "输入商户标识和平台提现申请 ID，查看该笔申请保存的凭证。"}</p>
    {subjectUserId && !canReadOrders && mode === "transaction" ? <p className="text-sm text-muted-foreground">查看关联订单的收付款和退款需要订单读取权限；提现记录不受此限制。</p> : null}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Field label="商户标识" required><Input aria-label="证据商户标识" placeholder="输入平台登记的商户标识" value={merchant} onChange={e => { reset(); setMerchant(e.target.value.trim()); }}/></Field>
      {mode === "transaction" ? <>
        <Field label="交易类型" composite><Select value={family} onValueChange={val => { if (val) { reset(); setFamily(val); } }} items={["PAYOUT", "REFUND", "ALIPAY_NATIVE", "WEIXIN_NATIVE"].map(f => ({ value: f, label: familyLabels[f] ?? f }))}>
          <SelectTrigger aria-label="业务来源" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["PAYOUT", "REFUND", "ALIPAY_NATIVE", "WEIXIN_NATIVE"].map(f => <SelectItem key={f} value={f}>{familyLabels[f] ?? f}</SelectItem>)}</SelectContent>
        </Select></Field>
        <Field label="商户原单号"><Input aria-label="商户原单号" placeholder="与渠道交易对应的原单号" value={ref} onChange={e => { reset(); setRef(e.target.value.trim()); }}/></Field>
        <Field label="渠道流水号"><Input aria-label="渠道流水" placeholder="汇聚返回的流水号" value={trx} onChange={e => { reset(); setTrx(e.target.value.trim()); }}/></Field>
      </> : <Field label="提现申请 ID" required><Input aria-label="提现申请 ID" placeholder="平台中的提现申请 ID" value={withdrawalRef} onChange={e => { reset(); setWithdrawalRef(e.target.value.trim()); }}/></Field>}
    </div>
    <Button size="sm" type="button" onClick={mode === "transaction" ? search : withdrawal}>{mode === "transaction" ? "查询本站记录" : "查看提现凭证"}</Button>
    {state ? <Meta state={state} seq={seq} set={setState}/> : null}
    {state?.display ? <Failure display={state.display}/> : null}
    {w ? <ul><Line title="提现证据" section={w}/>{w.status === "FOUND" ? <>
      {subjectUserId ? <li>当前用户身份：提现人</li> : null}
      <li data-withdrawal-amounts>扣款金额（含费）：{money((w.amounts as any)?.grossDeduction)} · 应出款（净额）：{money((w.amounts as any)?.netPayout)} · 用户手续费：{money((w.amounts as any)?.userPolicyFee)} · 渠道实际出款：未知</li>
      <li data-withdrawal-ref>商户原号：{text(w.merchantOrderNo)} · 渠道流水：{text(w.platformSerialNo)} · 受理时间：{text(w.acceptedAt)}</li>
      <li data-withdrawal-target>收款卡（申请时记录）：{text((w.originalDestination as any)?.cardMask)} · 状态：{channelStateLabels[text(w.state)] ?? "状态待核"} · 本站处置：{dispositionLabels[text(w.localFundsDisposition)] ?? "待核"} · 银行到账：未知</li></> : null}</ul> : null}
    {s ? <ul><Line title="原单检索" section={s}/>{Array.isArray(s.candidates) ? <li>候选 {s.candidates.length} 条{s.truncated ? "（已截断，非全部）" : ""}</li> : null}</ul> : null}
    {s && Array.isArray(s.candidates) && s.candidates.length ? <TooltipProvider><div className="overflow-x-auto"><Table data-evidence-candidates><TableHeader><TableRow><TableHead>交易类型</TableHead>{subjectUserId ? <TableHead>当前用户身份</TableHead> : null}<TableHead>平台请求 ID</TableHead><TableHead>商户原单号 / 渠道流水</TableHead><TableHead>本站状态</TableHead><TableHead>记录金额</TableHead><TableHead>证据等级</TableHead><TableHead>登记时间</TableHead><TableHead>关联与凭证</TableHead></TableRow></TableHeader>
      <TableBody>{(s.candidates as any[]).map((c, i) => <TableRow key={`${text(c?.objectKind)}:${text(c?.objectId)}:${i}`} data-requires-review={c?.requiresReview ? "true" : "false"}>
        <TableCell>{familyLabels[text(c?.productFamily)] ?? "渠道业务未记录"}</TableCell>{subjectUserId ? <TableCell>{subjectRoleLabels[text(c?.subjectRole)] ?? "身份待核"}</TableCell> : null}<TableCell><span className="inline-flex items-center gap-1">{text(c?.objectId)}{typeof c?.objectId === 'string' && REF.test(c.objectId) ? <PreviewCopyButton value={c.objectId} tooltip="复制平台请求 ID"/> : null}</span></TableCell><TableCell>{text(c?.merchantOrderNo)} / {c?.channelTransactionRecorded ? text(c?.channelTrxNo) : "未登记"}</TableCell>
        <TableCell>{channelStateLabels[text(c?.state)] ?? "状态待核"}{c?.fundsDisposition ? ` · ${dispositionLabels[text(c.fundsDisposition)] ?? "资金处置待核"}` : ""}{c?.requiresReview ? " · 需核对" : ""}</TableCell><TableCell>{money(c?.amount)} {text(c?.amount?.currency)}</TableCell>
        <TableCell>{evidenceLabels[text(c?.evidenceLevel)] ?? "依据待核"}</TableCell><TableCell>{financeTime(c?.recordedAt)}</TableCell><TableCell>{c?.objectKind === 'JOINPAY_WITHDRAWAL_INTENT' && typeof c.objectId === 'string' && REF.test(c.objectId) && c.merchantIdentityId === merchant
          ? <Button variant="link" size="sm" onClick={() => void load(scopedPath('/finance/channel-evidence/withdrawals/' + encodeURIComponent(merchant) + '/' + encodeURIComponent(c.objectId)), seq, setState, '提现申请 [' + c.objectId + ']')}>查看出款凭证</Button>
          : onOpenOrder && typeof c?.orderId === "string" && REF.test(c.orderId)
            ? <Button variant="link" size="sm" onClick={() => onOpenOrder(c.orderId, { merchant, ref, trx, family })}>查看关联订单</Button>
            : <span>暂无可查看订单</span>}</TableCell></TableRow>)}</TableBody></Table></div></TooltipProvider> : null}
    <p className="text-xs text-muted-foreground">本站记录不代表银行到账；未接入、无权限和未找到会分别提示。</p>
  </div>;
}
