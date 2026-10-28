import { useRef, useState } from "react";
import { adminRequest, AdminApiError } from "../api";
import { Button } from "../components/ui-elements";
import { formatFundingCents } from "./supply-review/model";
import { channelEvidenceErrorDisplay, channelEvidenceStatusDisplay, evidenceCents, type ChannelEvidenceDisplay } from "./admin-channel-evidence-model";

type Section = { status?: string; coverage?: string; truncated?: boolean; reasonCodes?: string[]; [key: string]: unknown };
const money = (v: unknown) => { const c = evidenceCents(v); return c === null ? "未知" : formatFundingCents(c); };
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
function Line({ title, section }: { title: string; section: Section | null | undefined }) {
  const d = channelEvidenceStatusDisplay(section);
  return <li data-evidence-state={d.kind}><strong>{title}</strong>：{d.text}{section?.reasonCodes?.length ? ` · ${section.reasonCodes.join(",")}` : ""}</li>;
}
type LoadState = { display?: ChannelEvidenceDisplay; body?: any; path?: string; requestId?: string | null; loading?: boolean };
const text = (v: unknown) => typeof v === "string" && v ? v : "未知";
/** 只接受最后一次请求的结果；输入改变或新请求开始后，迟到响应一律丢弃。 */
async function load(path: string, seq: { current: number }, set: (v: LoadState) => void) {
  const id = ++seq.current; set({ path, loading: true });
  try { const body: any = await adminRequest(path, undefined, "GET"); if (id === seq.current) set({ body, path, requestId: typeof body?.requestId === "string" ? body.requestId : null }); }
  catch (e) { if (id === seq.current) set({ path, display: channelEvidenceErrorDisplay(e instanceof AdminApiError ? e.status : undefined), requestId: e instanceof AdminApiError ? e.requestId ?? null : null }); }
}
function Meta({ state, seq, set }: { state: LoadState; seq: { current: number }; set: (v: LoadState) => void }) {
  return <p className="oc-fact-note" data-evidence-meta>{state.loading ? "读取中…" : `请求编号：${state.requestId ?? "未返回"}`}
    {state.path && !state.loading ? <Button size="sm" type="button" variant="secondary" onClick={() => void load(state.path!, seq, set)}>重新读取</Button> : null}</p>;
}
function Failure({ display }: { display: ChannelEvidenceDisplay }) { return <p role="status" data-evidence-state={display.kind}>{display.text}</p>; }

/** 订单链路：读取本单渠道付款/退款证据（只读，不发起渠道查询）。 */
export function OrderChannelEvidence({ orderId, canRead }: { orderId: string; canRead: boolean }) {
  const [state, setState] = useState<LoadState | null>(null), seq = useRef(0);
  if (!canRead) return null;
  return <div className="oc-channel-evidence space-y-1 text-sm" data-channel-evidence="order">
    <Button size="sm" variant="secondary" type="button" onClick={() => void load(`/finance/channel-evidence/orders/${encodeURIComponent(orderId)}`, seq, setState)}>读取渠道证据</Button>
    {state ? <Meta state={state} seq={seq} set={setState}/> : null}
    {state?.display ? <Failure display={state.display}/> : null}
    {state?.body ? <ul><Line title="付款证据" section={state.body.payment}/><Line title="退款证据" section={state.body.refund}/></ul> : null}
    <p className="oc-fact-note">只读本地登记证据，不发起渠道查询；银行到账未核定。</p>
  </div>;
}

/** 资金页/用户资金：按商户原号读取提现证据或检索原单；商户范围由服务端授予，不由输入扩大。 */
export function ChannelEvidenceLookup({ canRead, canSearch }: { canRead: boolean; canSearch: boolean }) {
  const [merchant, setMerchant] = useState(""), [ref, setRef] = useState(""), [family, setFamily] = useState("PAYOUT");
  const [state, setState] = useState<LoadState | null>(null), seq = useRef(0);
  const reset = () => { seq.current++; setState(null); };
  if (!canRead) return null;
  const valid = REF.test(merchant) && REF.test(ref);
  const withdrawal = () => valid ? void load(`/finance/channel-evidence/withdrawals/${encodeURIComponent(merchant)}/${encodeURIComponent(ref)}`, seq, setState) : setState({ display: { kind: "unknown", text: "商户标识或原号格式无效" } });
  const search = () => valid ? void load(`/finance/channel-evidence/originals/${encodeURIComponent(merchant)}?${new URLSearchParams({ productFamily: family, merchantOrderNo: ref })}`, seq, setState) : setState({ display: { kind: "unknown", text: "商户标识或原号格式无效" } });
  const w = state?.body?.withdrawal as Section | undefined, s = state?.body?.search as Section | undefined;
  return <div className="finance-channel-evidence space-y-1 text-sm" data-channel-evidence="lookup" role="group" aria-label="渠道证据读取">
    <div className="flex flex-wrap gap-2"><input aria-label="证据商户标识" placeholder="商户标识" value={merchant} onChange={e => { reset(); setMerchant(e.target.value.trim()); }}/>
      <input aria-label="原申请或商户原号" placeholder="原申请/商户原号" value={ref} onChange={e => { reset(); setRef(e.target.value.trim()); }}/>
      <Button size="sm" type="button" variant="secondary" onClick={withdrawal}>读取提现证据</Button>
      {canSearch ? <><select aria-label="业务来源" value={family} onChange={e => { reset(); setFamily(e.target.value); }}>{["PAYOUT", "REFUND", "ALIPAY_NATIVE", "WEIXIN_NATIVE"].map(f => <option key={f} value={f}>{f}</option>)}</select>
        <Button size="sm" type="button" variant="secondary" onClick={search}>按原号检索</Button></> : null}</div>
    {state ? <Meta state={state} seq={seq} set={setState}/> : null}
    {state?.display ? <Failure display={state.display}/> : null}
    {w ? <ul><Line title="提现证据" section={w}/>{w.status === "FOUND" ? <>
      <li data-withdrawal-amounts>扣款金额（含费）：{money((w.amounts as any)?.grossDeduction)} · 应出款（净额）：{money((w.amounts as any)?.netPayout)} · 用户手续费：{money((w.amounts as any)?.userPolicyFee)} · 渠道实际出款：未知</li>
      <li data-withdrawal-ref>商户原号：{text(w.merchantOrderNo)} · 渠道流水：{text(w.platformSerialNo)} · 受理时间：{text(w.acceptedAt)}</li>
      <li data-withdrawal-target>冻结目标卡：{text((w.originalDestination as any)?.cardMask)}（{text((w.originalDestination as any)?.basis)}） · 状态：{text(w.state)} · 本站处置：{text(w.localFundsDisposition)} · 银行到账：未知</li></> : null}</ul> : null}
    {s ? <ul><Line title="原单检索" section={s}/>{Array.isArray(s.candidates) ? <li>候选 {s.candidates.length} 条{s.truncated ? "（已截断，非全部）" : ""}</li> : null}</ul> : null}
    {s && Array.isArray(s.candidates) && s.candidates.length ? <table data-evidence-candidates><thead><tr><th>产品</th><th>商户原号/渠道流水</th><th>状态</th><th>金额</th><th>证据等级</th><th>登记时间</th></tr></thead>
      <tbody>{(s.candidates as any[]).map((c, i) => <tr key={`${text(c?.objectKind)}:${text(c?.objectId)}:${i}`} data-requires-review={c?.requiresReview ? "true" : "false"}>
        <td>{text(c?.productFamily)} · {text(c?.objectKind)}</td><td>{text(c?.merchantOrderNo)} / {c?.channelTransactionRecorded ? text(c?.channelTrxNo) : "未登记"}</td>
        <td>{text(c?.state)}{c?.fundsDisposition ? ` · ${text(c.fundsDisposition)}` : ""}</td><td>{money(c?.amount)} {text(c?.amount?.currency)}</td>
        <td>{text(c?.evidenceLevel)}</td><td>{text(c?.recordedAt)}</td></tr>)}</tbody></table> : null}
    <p className="oc-fact-note">本地登记证据不等于渠道结果或银行到账；未授权、未接入与未找到分别显示。</p>
  </div>;
}