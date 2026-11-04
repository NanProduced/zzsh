import { useEffect, useRef, useState } from "react";
import { adminRequest, AdminApiError, ADMIN_AUTH_FAILURE_EVENT } from "../api";
import { Button } from "@/components/ui/button";
import { financeTime, stateLabels } from "./admin-finance-api";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
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
function Line({ title, section }: { title: string; section: Section | null | undefined }) {
  const d = channelEvidenceStatusDisplay(section);
  return <li data-evidence-state={d.kind}><strong>{title}</strong>：{d.text}{section?.reasonCodes?.length ? ` · ${section.reasonCodes.join(",")}` : ""}</li>;
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
export function ChannelEvidenceLookup({ canRead, canSearch, onOpenOrder, initialSearch }: {
  canRead: boolean; canSearch: boolean; onOpenOrder?: (id: string, clue: ChannelSearchClue) => void; initialSearch?: ChannelSearchClue;
}) {
  const [merchant, setMerchant] = useState(initialSearch?.merchant ?? ""), [ref, setRef] = useState(initialSearch?.ref ?? ""), [family, setFamily] = useState(initialSearch?.family ?? "PAYOUT");
  const [trx, setTrx] = useState(initialSearch?.trx ?? "");
  const [state, setState] = useState<LoadState | null>(null), seq = useRef(0);
  const reset = () => { seq.current++; setState(null); };
  useEffect(() => {
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, reset);
    if (initialSearch && canRead && canSearch) search();
    return () => { seq.current++; window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, reset); };
  }, []);
  const valid = REF.test(merchant) && REF.test(ref);
  const withdrawal = () => {
    if (!valid) {
      seq.current++;
      setState({ display: { kind: "unknown", text: "请输入有效商户标识和提现申请编号" } });
      return;
    }
    void load('/finance/channel-evidence/withdrawals/' + encodeURIComponent(merchant) + '/' + encodeURIComponent(ref), seq, setState, '商户 [' + merchant + '] 提现 [' + ref + ']');
  };
  const search = () => {
    if (!REF.test(merchant) || !ref && !trx || ref && !ORIGINAL_NO.test(ref) || trx && !CHANNEL_TRX_NO.test(trx)) {
      seq.current++;
      setState({ display: { kind: "unknown", text: "请输入有效商户标识及至少一个精确原号或渠道流水" } });
      return;
    }
    const query = new URLSearchParams({ productFamily: family });
    if (ref) query.set("merchantOrderNo", ref);
    if (trx) query.set("channelTrxNo", trx);
    void load('/finance/channel-evidence/originals/' + encodeURIComponent(merchant) + '?' + query, seq, setState, '商户 [' + merchant + '] ' + (familyLabels[family] ?? family));
  };
  if (!canRead) return null;
  const w = state?.body?.kind === "WITHDRAWAL" ? state.body.withdrawal as Section : undefined;
  const s = state?.body?.kind === "ORIGINAL_SEARCH" ? state.body.search as Section : undefined;
  return <div className="finance-channel-evidence space-y-1 text-sm" data-channel-evidence="lookup" role="group" aria-label="渠道证据读取">
    <div className="flex flex-wrap items-center gap-2"><Input aria-label="证据商户标识" placeholder="商户标识" value={merchant} onChange={e => { reset(); setMerchant(e.target.value.trim()); }} className="h-9 w-36 text-xs font-mono" />
      <Input aria-label="原申请或商户原号" placeholder="原申请/商户原号" value={ref} onChange={e => { reset(); setRef(e.target.value.trim()); }} className="h-9 w-44 text-xs font-mono" />
      <Button size="sm" type="button" variant="secondary" onClick={withdrawal}>读取提现证据</Button>
      {canSearch ? <>
        <Select
          value={family}
          onValueChange={(val) => { if (val) { reset(); setFamily(val); } }}
          items={["PAYOUT", "REFUND", "ALIPAY_NATIVE", "WEIXIN_NATIVE"].map(f => ({ value: f, label: familyLabels[f] ?? f }))}
        >
          <SelectTrigger aria-label="业务来源" className="h-9 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["PAYOUT", "REFUND", "ALIPAY_NATIVE", "WEIXIN_NATIVE"].map(f => (
              <SelectItem key={f} value={f}>{familyLabels[f] ?? f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input aria-label="渠道流水" placeholder="渠道流水" value={trx} onChange={e => { reset(); setTrx(e.target.value.trim()); }} className="h-9 w-44 text-xs font-mono" />
        <Button size="sm" type="button" variant="secondary" onClick={search}>检索渠道交易</Button></> : null}</div>
    {state ? <Meta state={state} seq={seq} set={setState}/> : null}
    {state?.display ? <Failure display={state.display}/> : null}
    {w ? <ul><Line title="提现证据" section={w}/>{w.status === "FOUND" ? <>
      <li data-withdrawal-amounts>扣款金额（含费）：{money((w.amounts as any)?.grossDeduction)} · 应出款（净额）：{money((w.amounts as any)?.netPayout)} · 用户手续费：{money((w.amounts as any)?.userPolicyFee)} · 渠道实际出款：未知</li>
      <li data-withdrawal-ref>商户原号：{text(w.merchantOrderNo)} · 渠道流水：{text(w.platformSerialNo)} · 受理时间：{text(w.acceptedAt)}</li>
      <li data-withdrawal-target>冻结目标卡：{text((w.originalDestination as any)?.cardMask)}（{text((w.originalDestination as any)?.basis)}） · 状态：{text(w.state)} · 本站处置：{text(w.localFundsDisposition)} · 银行到账：未知</li></> : null}</ul> : null}
    {s ? <ul><Line title="原单检索" section={s}/>{Array.isArray(s.candidates) ? <li>候选 {s.candidates.length} 条{s.truncated ? "（已截断，非全部）" : ""}</li> : null}</ul> : null}
    {s && Array.isArray(s.candidates) && s.candidates.length ? <div className="overflow-x-auto"><table data-evidence-candidates><thead><tr><th>汇聚业务</th><th>商户原号 / 渠道流水</th><th>本地状态</th><th>记录金额</th><th>证据等级</th><th>登记时间</th><th>关联与证据</th></tr></thead>
      <tbody>{(s.candidates as any[]).map((c, i) => <tr key={`${text(c?.objectKind)}:${text(c?.objectId)}:${i}`} data-requires-review={c?.requiresReview ? "true" : "false"}>
        <td>{familyLabels[text(c?.productFamily)] ?? "渠道业务未记录"}</td><td>{text(c?.merchantOrderNo)} / {c?.channelTransactionRecorded ? text(c?.channelTrxNo) : "未登记"}</td>
        <td>{stateLabels[text(c?.state)] ?? text(c?.state)}{c?.fundsDisposition ? ` · ${text(c.fundsDisposition)}` : ""}{c?.requiresReview ? " · 未记录" : ""}</td><td>{money(c?.amount)} {text(c?.amount?.currency)}</td>
        <td>{text(c?.evidenceLevel)}</td><td>{financeTime(c?.recordedAt)}</td><td>{c?.objectKind === 'JOINPAY_WITHDRAWAL_INTENT' && typeof c.objectId === 'string' && REF.test(c.objectId) && c.merchantIdentityId === merchant
          ? <Button variant="link" size="sm" onClick={() => void load('/finance/channel-evidence/withdrawals/' + encodeURIComponent(merchant) + '/' + encodeURIComponent(c.objectId), seq, setState, '提现申请 [' + c.objectId + ']')}>查看出款证据</Button>
          : onOpenOrder && typeof c?.orderId === "string" && REF.test(c.orderId)
            ? <Button variant="link" size="sm" onClick={() => onOpenOrder(c.orderId, { merchant, ref, trx, family })}>查看关联订单</Button>
            : <span>暂无可查看订单</span>}</td></tr>)}</tbody></table></div> : null}
    <p className="oc-fact-note">本地登记证据不等于渠道结果或银行到账；未授权、未接入与未找到分别显示。</p>
  </div>;
}