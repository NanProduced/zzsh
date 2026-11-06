import { useCallback, useEffect, useRef, useState } from "react";
import { adminRequest, friendlyError, AdminApiError } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { formatFundingCents } from "./supply-review/model";
import { formatCentsToYuan } from "./membership-entitlement-form";
import { parseYuanToCents, yuanInputHint } from "@zzsh/ui/display-money";

type NativeRefundItem = { intentId: string; postingId: string | null; refundOrderNo: string; amountCents: string; state: string; budgetDisposition: string;
  requiresReview: boolean; completedAt: string | null; postingResponsibility: { frozenCents: string | null; allocatedCents: string | null; remainingCents: string | null };
  latestObservation: { event: string; evidenceLevel: string | null; observedAt: string | null } | null; channelArrival: "UNKNOWN" };
type QueryOperation = "REFUND_QUERY" | "PAYOUT_QUERY" | "COLLECTION_QUERY";
type QueryBinding = { operation: QueryOperation; objectId: string };
type QueryResult = QueryBinding & { contractVersion: "admin-joinpay-query.v1"; outcome: { kind: string; reason?: string; phase?: string; event?: string }; channelArrival: "UNKNOWN" };
type NativeRefundReceipt = { contractVersion: string; replayed: boolean; intentId: string; refundOrderNo: string;
  amountCents: string; currency: string; state: string; budgetDisposition: string; channel: { result: string; bankArrival: string } };
const CENTS = /^[1-9][0-9]{0,15}$/;
const keyStore = (orderId: string, binding?: RefundBinding) => `zzsh.admin.refund.pending.${orderId}${binding ? `.${JSON.stringify([binding.adminUserId,binding.sessionId])}` : ''}`;
/** 正常退款资格：只由已核过账责任证明；缺任一依据即关闭新申请（原键恢复除外）。异常退款不在此开放。 */
export type NormalRefundBasis = { eligible: boolean; reason: string; refundPayableCents: string | null; refundDueAt: string | null; postingRef: string | null };
export function normalRefundBasis(state: string, evidence: { readiness?: string; posting?: { state?: string; ref?: string | null }; refundPayable?: { knowledge?: string; cents?: string | null }; refundDueAt?: string | null } | undefined, legacy: boolean): NormalRefundBasis {
  const base = { refundPayableCents: null, refundDueAt: evidence?.refundDueAt ?? null, postingRef: evidence?.posting?.ref ?? null };
  if (legacy) return { ...base, eligible: false, reason: "旧平台订单按原来源核对，不在此发起新平台退款" };
  if (state !== "ready" || !evidence) return { ...base, eligible: false, reason: "未取得本单资金凭证，不能证明正常退款资格" };
  if (evidence.readiness !== "READY") return { ...base, eligible: false, reason: "资金凭证未就绪，不能证明正常退款资格" };
  if (evidence.posting?.state !== "POSTED") return { ...base, eligible: false, reason: evidence.posting?.state === "NOT_POSTED" ? "本单未形成正常过账责任（未过账不当作0，也不开放普通退款）" : "过账状态未记录，不开放普通退款" };
  const c = evidence.refundPayable?.knowledge === "KNOWN" ? evidence.refundPayable.cents ?? null : null;
  if (c === null || !CENTS.test(c)) return { ...base, eligible: false, reason: "应退责任未知或为0，不开放普通退款" };
  return { ...base, refundPayableCents: c, eligible: true, reason: "已核过账责任" };
}
export type RefundBinding = { adminUserId: string; sessionId: string };
type SavedRefund = { key: string; amount: string; reason: string; orderId: string; adminUserId: string | null; sessionId: string | null };
function readSaved(orderId: string, binding: RefundBinding | undefined): { value:SavedRefund|null; blocked:boolean } {
  try { let value:SavedRefund|null=null;
    for(const storageKey of new Set([keyStore(orderId,binding),keyStore(orderId)])){
      const raw=sessionStorage.getItem(storageKey);if(raw===null)continue;const v=JSON.parse(raw);
      if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.key)
        ||typeof v.amount!=='string'||!CENTS.test(v.amount)||v.reason!==undefined&&typeof v.reason!=='string'||new TextEncoder().encode(v.reason??'').length>400
        ||v.orderId!==undefined&&v.orderId!==orderId||binding&&(typeof v.adminUserId!=='string'||typeof v.sessionId!=='string'))throw Error('RECOVERY_INVALID');
      const owned=(v.adminUserId??null)===(binding?.adminUserId??null)&&(v.sessionId??null)===(binding?.sessionId??null);
      if(!owned){if(storageKey===keyStore(orderId,binding))throw Error('RECOVERY_SUBJECT_DIFF');continue;}
      const next={key:v.key,amount:v.amount,reason:v.reason??'',orderId,adminUserId:v.adminUserId??null,sessionId:v.sessionId??null};
      if(value&&JSON.stringify(value)!==JSON.stringify(next))throw Error('RECOVERY_CONFLICT');value=next;
    }
    return {value,blocked:false};
  }catch{return {value:null,blocked:true};}
}
function clearSaved(orderId:string,binding:RefundBinding|undefined,key:string){
  for(const storageKey of new Set([keyStore(orderId,binding),keyStore(orderId)])){
    const raw=sessionStorage.getItem(storageKey);if(raw===null)continue;const v=JSON.parse(raw);
    if(v?.key===key&&(v.orderId??orderId)===orderId&&(v.adminUserId??null)===(binding?.adminUserId??null)&&(v.sessionId??null)===(binding?.sessionId??null))sessionStorage.removeItem(storageKey);
  }
}
const newKey = () => `idem_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll("-", "")}`;
const cents = (v: string | null) => v == null ? "未知" : formatFundingCents(v);
const skipText: Record<string, string> = { TERMINAL: "已有终态，无需补查", REVIEW_REQUIRED: "本地复核中，不自动重试", ACTIVE_LEASE: "已有查询进行中", NOT_DUE: "未到补查时间",
  THROTTLED: "30秒内已查询，请稍后", BUDGET_EXHAUSTED: "补查次数已用尽，转人工核对", INELIGIBLE: "当前状态不可补查", ABNORMAL_BASIS_REVIEW: "异常原款依据待复核", NOT_ELIGIBLE: "当前不可补查", PENDING_ACCEPTANCE: "渠道成功待本地受理", OUTSIDE_QUERY_WINDOW: "已超出原补查窗口，转人工核对" };
export function queryOutcomeText(r: QueryResult | null, status?: number, expected?: QueryBinding): string {
  if (!validQueryResult(r, expected)) return "补查回执无法核定，结果未知；请重读本地记录";
  if (status === 202 || r.outcome.kind === "UNKNOWN") return "已提交查询，结果未知；请稍后刷新本地记录，不要重复发起退款";
  if (r.outcome.kind === "SKIPPED") return `未发起渠道查询：${skipText[r.outcome.reason ?? ""] ?? "原因未知，需按原单核对"}`;
  if (r.outcome.kind === "NOT_DISPATCHED") return "尚未派发，无可补查的原单";
  return `已取得渠道观察（${r.outcome.event ?? "?"}）；银行到账仍未记录`;
}
function validQueryResult(r: QueryResult | null, expected?: QueryBinding): r is QueryResult {
  if (!r || r.contractVersion !== "admin-joinpay-query.v1" || r.channelArrival !== "UNKNOWN"
    || !["REFUND_QUERY", "PAYOUT_QUERY", "COLLECTION_QUERY"].includes(r.operation)
    || typeof r.objectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.objectId)
    || expected && (r.operation !== expected.operation || r.objectId !== expected.objectId)
    || !["UNKNOWN", "SKIPPED", "NOT_DISPATCHED", "OBSERVED"].includes(r.outcome?.kind)) return false;
  if (r.outcome.kind !== "OBSERVED") return true;
  const events = r.operation === "COLLECTION_QUERY" ? ["E1", "E1P", "E2", "E3", "E4", "E5", "E6", "E6X", "E9", "E11"]
    : ["STALE", "UNKNOWN", "REVIEW", "TERMINAL", "PENDING_TERMINAL", "PROCESSING"];
  return typeof r.outcome.event === "string" && events.includes(r.outcome.event);
}

/** 普通退款：复用GET/POST /orders/:id/refunds；未知结果冻结原幂等键只用于恢复。QUERY-only只按原号补查。 */
type RefundProps={ orderId: string; canWrite: boolean; basis?: NormalRefundBasis; binding?: RefundBinding; onAttentionChange?: (attention: boolean) => void };
export function AdminNativeRefundPanel(props:RefundProps){
  return <NativeRefundForm key={JSON.stringify([props.orderId,props.binding?.adminUserId,props.binding?.sessionId])} {...props}/>;
}
function NativeRefundForm({ orderId, canWrite, basis, binding, onAttentionChange }: RefundProps) {
  const [items, setItems] = useState<NativeRefundItem[] | null | undefined>();
  const [recovery] = useState(() => readSaved(orderId, binding)),saved=recovery.value;
  const [storageBlocked,setStorageBlocked]=useState(recovery.blocked);
  const [confirmed, setConfirmed] = useState(false);
  const closedNew = basis !== undefined && !basis.eligible;
  const [amount, setAmount] = useState(saved?.amount ? formatCentsToYuan(saved.amount) : ""), [reason, setReason] = useState(saved?.reason ?? ""), [note, setNote] = useState(recovery.blocked ? "原请求恢复资料不可读或冲突，已阻止覆盖或新提交" : saved ? "存在结果未知的申请：只能按原键恢复提交" : ""), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(saved?.key ?? null);
  useEffect(() => { onAttentionChange?.(canWrite && Boolean(pending || storageBlocked)); return () => onAttentionChange?.(false); }, [canWrite, pending, storageBlocked, onAttentionChange]);
  const load = useCallback((signal?: AbortSignal) => adminRequest<{ items: NativeRefundItem[] }>(`/orders/${encodeURIComponent(orderId)}/refunds`, undefined, "GET", {}, signal)
    .then(r => setItems(Array.isArray(r?.items) ? r.items : null), e => { if (!signal?.aborted) { setItems(null); setNote(friendlyError(e)); } }), [orderId]);
  const submit = async () => {
    if(!canWrite||busy||storageBlocked)return;
    const amountCents = parseYuanToCents(amount);
    if (amountCents === null || !CENTS.test(amountCents)) { setNote(`请输入大于 0 且在允许范围内的退款金额。${yuanInputHint(basis?.refundPayableCents ? formatCentsToYuan(basis.refundPayableCents) : null)}`); return; }
    if (pending === null && closedNew) { setNote(`不能发起普通退款：${basis!.reason}`); return; }
    if (pending === null && basis?.eligible && !confirmed) { setNote("请先核对并确认原单过账责任、到期与申请额"); return; }
    if (pending === null && basis?.refundPayableCents && BigInt(amountCents) > BigInt(basis.refundPayableCents)) { setNote("申请额超过已核应退责任"); return; }
    const key = pending ?? newKey();
    try { sessionStorage.setItem(keyStore(orderId,binding), JSON.stringify({ key, amount: amountCents, reason, orderId, adminUserId: binding?.adminUserId ?? null, sessionId: binding?.sessionId ?? null })); }
    catch { setStorageBlocked(true);setNote('无法保存原请求，已阻止退款提交');return; }
    setPending(key);
    const recovering = pending !== null;
    setBusy(true);
    try {
      const receipt = await adminRequest<NativeRefundReceipt | null>(`/orders/${encodeURIComponent(orderId)}/refunds`, { amountCents, ...(reason.trim() ? { reason: reason.trim() } : {}) }, "POST", { "idempotency-key": key });
      if (receipt?.contractVersion !== "admin-native-refund.v1" || typeof receipt.replayed !== "boolean"
        || typeof receipt.intentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.intentId)
        || typeof receipt.refundOrderNo !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.refundOrderNo)
        || receipt.amountCents !== amountCents || receipt.currency !== "CNY" || !["READY", "SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED", "SUCCEEDED", "FAILED"].includes(receipt.state)
        || !["ALLOCATED", "CONSUMED", "RELEASED"].includes(receipt.budgetDisposition)
        || receipt.channel?.result !== (receipt.replayed ? "UNKNOWN" : "NOT_SUBMITTED") || receipt.channel?.bankArrival !== "UNKNOWN") throw new AdminApiError(0, "INVALID_REFUND_RECEIPT");
      clearSaved(orderId,binding,key);
      setPending(null); setNote(receipt.replayed ? "已找回原本地退款申请；渠道结果与到账未记录" : "已建立本地退款申请；渠道提交与到账未记录"); await load();
    } catch (e) {
      const unknown = e instanceof AdminApiError && (e.status === 0 || e.status === 503 || e.status >= 500);
      setNote(unknown || recovering ? `${unknown ? "结果未知" : friendlyError(e)}：已保留原幂等键，只能按原键恢复，不会生成新申请` : friendlyError(e));
      if (!unknown && !recovering) { try { clearSaved(orderId,binding,key);setPending(null); } catch { setStorageBlocked(true); } }
    } finally { setBusy(false); }
  };
  const query = async (intentId: string) => {
    setBusy(true);
    try { const r = await adminRequest<QueryResult>(`/joinpay/refunds/${encodeURIComponent(intentId)}/query-only`, {}, "POST"); setNote(queryOutcomeText(r, undefined, { operation: "REFUND_QUERY", objectId: intentId })); await load(); }
    catch (e) { setNote(friendlyError(e)); } finally { setBusy(false); }
  };
  return <div className="oc-native-refund mt-3 space-y-2 text-sm" data-native-refund>
    <h4 className="font-semibold">原单退款申请</h4>
    {!canWrite ? <p className="oc-fact-note">逐笔退款申请读取需要订单结算命令权限；只读资金权限请看上方资金凭证与退款摘要。</p>
      : items === undefined ? <Button size="sm" variant="secondary" onClick={() => void load()}>读取退款申请</Button> : items === null ? <p className="oc-fact-note">退款申请读取不可用；不能据此认定没有退款。</p>
      : items.length ? <ul className="space-y-1">{items.map(i => <li key={i.intentId}><span>{i.refundOrderNo} · 申请 {cents(i.amountCents)} · 本地状态 {i.state}{i.requiresReview ? " · 需复核" : ""}</span>
        <small className="ml-2 text-xs text-muted-foreground">原责任 {cents(i.postingResponsibility.frozenCents)} · 已分配 {cents(i.postingResponsibility.allocatedCents)} · 尚未分配责任 {cents(i.postingResponsibility.remainingCents)} · 预算 {i.budgetDisposition}{i.latestObservation ? ` · 最近渠道观察 ${i.latestObservation.event}` : ""} · 银行到账未记录</small>
        {canWrite ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void query(i.intentId)}>按原号补查</Button> : null}</li>)}</ul>
      : <p className="oc-fact-note">本单暂无退款申请。</p>}
    {canWrite && basis ? <p className="oc-fact-note" data-refund-basis={basis.eligible ? "eligible" : "closed"}>原单 {orderId} · 过账 {basis.postingRef ?? "未知"} · 已核应退责任 {cents(basis.refundPayableCents)} · 责任到期 {basis.refundDueAt ?? "未知"} · 预算以申请回执为准{basis.eligible ? "" : ` · 普通退款关闭：${basis.reason}`} · 异常退款不在此开放</p> : null}
    {canWrite && (!closedNew || pending) ? <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {basis?.eligible && !pending ? <label className="flex items-center gap-2 text-xs cursor-pointer select-none"><Checkbox name="confirmed" aria-label="确认过账责任" checked={confirmed} disabled={busy} onCheckedChange={checked => setConfirmed(checked === true)} /><span>已核对原单、过账责任、到期与申请额</span></label> : null}
      <label>金额（元）<Input aria-label="退款金额（元）" value={amount} disabled={busy || !!pending} onChange={e => setAmount(e.target.value.trim())} inputMode="decimal" maxLength={18} /></label>
      <label className="flex items-center gap-1.5 text-xs"><span className="text-muted-foreground shrink-0">原因</span><Input aria-label="退款原因" value={reason} disabled={busy || !!pending} maxLength={120} onChange={e => setReason(e.target.value)} className="h-8 w-48 text-xs" /></label>
      <Button size="sm" type="submit" disabled={busy||storageBlocked}>{pending ? "按原键恢复提交" : "发起退款申请"}</Button>
    </form> : canWrite ? <p className="oc-fact-note">普通退款未开放（资格未证明）。</p> : <p className="oc-fact-note">发起退款需要订单结算命令权限。</p>}
    {note ? <p className="oc-fact-note" role="status">{note}</p> : null}
  </div>;
}

type WorkerOne = { configured: boolean; running: boolean; failureCode: string | null; failurePhase: string | null; lastSuccessfulQueryAt: string | null };
type WorkerStatus = { refund: WorkerOne; payout: WorkerOne; collection: WorkerOne };
type AccountSummary = { integration: string; knowledge: string; latestVerifiedSnapshot: Record<string, unknown> | null };
const workerText = (w: WorkerOne) => !w.configured ? "未装配" : `${w.running ? "运行中" : "未运行"}${w.failureCode ? ` · 最近失败 ${w.failureCode}${w.failurePhase ? `/${w.failurePhase}` : ""}` : ""} · 最近成功查询时间未提供`;
const accountText = (a: AccountSummary | undefined) => !a ? "未读取" : a.integration !== "INTEGRATED" ? "未接入" : a.knowledge === "KNOWN" ? "已取得渠道余额快照（以渠道为准）" : "余额未记录";

/** 资金页渠道运维：worker白名单状态与商户账户摘要；均为只读，不显示银行全量数据。 */
/** 提现QUERY-only：只按原提现单号补查，不发起新提现/重发/换收款目标；需finance.withdrawal.query。 */
export function AdminWithdrawalQueryBox({ unavailable = false }: { unavailable?: boolean }) {
  const [id, setId] = useState(""), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ target?: string; queriedAt?: string } | null>(null);
  const seq = useRef(0);
  const reset = () => { seq.current++; setText(""); setMeta(null); };
  const run = async () => {
    if (unavailable) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) { setText("请填写有效的提现申请 ID。"); return; }
    const currentSeq = ++seq.current;
    const now = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
    setBusy(true);
    setMeta({ target: `提现单号 [${id}]`, queriedAt: now });
    try {
      const r = await adminRequest<QueryResult>(`/joinpay/withdrawals/${encodeURIComponent(id)}/query-only`, {}, "POST");
      if (currentSeq !== seq.current) return;
      setText(!validQueryResult(r, { operation: "PAYOUT_QUERY", objectId: id }) ? queryOutcomeText(null) : r.outcome.kind === "NOT_DISPATCHED" ? "原提现尚未派发，不会发起新提现" : r.outcome.kind === "UNKNOWN" ? "已提交查询，结果未知；请稍后刷新，不要重复发起提现" : queryOutcomeText(r));
    } catch (e) {
      if (currentSeq !== seq.current) return;
      setText(e instanceof AdminApiError && e.status === 503 ? "提现补查暂不可用（未装配）" : friendlyError(e));
    } finally {
      if (currentSeq === seq.current) setBusy(false);
    }
  };
  return <div className="space-y-1.5" role="group" aria-label="提现按原号补查">
    <div className="flex flex-wrap items-end gap-3">
      <Field label="提现申请 ID" className="max-w-xs"><Input aria-label="提现申请 ID" value={id} onChange={e => { reset(); setId(e.target.value.trim()); }} placeholder="输入平台提现申请 ID" /></Field>
      <Button size="sm" type="button" variant="secondary" disabled={busy || unavailable} onClick={() => void run()}>{busy ? "正在查询…" : "向汇聚查询提现"}</Button>
    </div>
    {meta ? <p className="oc-fact-note text-xs" data-query-meta>本次查询对象：{meta.target} · 时间：{meta.queriedAt}</p> : null}
    {text ? <p role="status" className="text-xs font-medium text-foreground">{text}</p> : null}
    <p className="oc-fact-note text-xs">查询可能更新本站提现状态和账务，不会再次发起提现。</p>
  </div>;
}

/** 收款QUERY-only：只按原收款请求号补查，不首派、不重付、不改金额；需订单结算命令权限（服务端按原订单复核）。 */
export function collectionQueryText(r: QueryResult | null, status?: number, expected?: QueryBinding): string {
  if (!validQueryResult(r, expected)) return "收款补查回执无效，结果未知";
  if (r.outcome?.kind === "NOT_DISPATCHED") return "原收款尚未派发，不会发起新收款";
  if (status === 202 || r.outcome?.kind === "UNKNOWN") return "已提交查询，结果未知（202）；请稍后刷新本地记录，不要重复收款";
  return queryOutcomeText(r, status);
}
export function AdminCollectionQueryBox({ canWrite, unavailable = false }: { canWrite: boolean; unavailable?: boolean }) {
  const [id, setId] = useState(""), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ target?: string; queriedAt?: string } | null>(null);
  const seq = useRef(0);
  const reset = () => { seq.current++; setText(""); setMeta(null); };
  if (!canWrite) return null;
  const run = async () => {
    if (unavailable) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) { setText("请填写有效的收款请求 ID。"); return; }
    const currentSeq = ++seq.current;
    const now = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
    setBusy(true);
    setMeta({ target: `收款请求号 [${id}]`, queriedAt: now });
    try {
      const r = await adminRequest<QueryResult>(`/joinpay/collection-requests/${encodeURIComponent(id)}/query-only`, {}, "POST");
      if (currentSeq !== seq.current) return;
      setText(collectionQueryText(r, undefined, { operation: "COLLECTION_QUERY", objectId: id }));
    } catch (e) {
      if (currentSeq !== seq.current) return;
      setText(e instanceof AdminApiError && e.status === 503 ? "收款补查暂不可用（未装配）" : friendlyError(e));
    } finally {
      if (currentSeq === seq.current) setBusy(false);
    }
  };
  return <div className="space-y-1.5" role="group" aria-label="收款按原号补查">
    <div className="flex flex-wrap items-end gap-3">
      <Field label="收款请求 ID" className="max-w-xs"><Input aria-label="收款请求 ID" value={id} onChange={e => { reset(); setId(e.target.value.trim()); }} placeholder="输入平台收款请求 ID" /></Field>
      <Button size="sm" type="button" variant="secondary" disabled={busy || unavailable} onClick={() => void run()}>{busy ? "正在查询…" : "向汇聚查询收款"}</Button>
    </div>
    {meta ? <p className="oc-fact-note text-xs" data-query-meta>本次查询对象：{meta.target} · 时间：{meta.queriedAt}</p> : null}
    {text ? <p role="status" className="text-xs font-medium text-foreground">{text}</p> : null}
    <p className="oc-fact-note text-xs">查询可能更新本站订单和付款状态，不会再次发起收款。</p>
  </div>;
}

export function AdminJoinpayOpsPanel({ canRead, canWithdrawalQuery = false }: { canRead: boolean; canWithdrawalQuery?: boolean }) {
  const [workers, setWorkers] = useState<WorkerStatus | null | undefined>();
  const [merchant, setMerchant] = useState(""), [account, setAccount] = useState<{ available?: AccountSummary; collection?: AccountSummary } | null>(null), [note, setNote] = useState("");
  const seq = useRef(0);
  const resetMerchant = () => { seq.current++; setAccount(null); setNote(""); };
  const readWorkers = () => adminRequest<WorkerStatus>("/joinpay/worker-status", undefined, "GET").then(w => setWorkers(w?.refund && w.payout && w.collection ? w : null), () => setWorkers(null));
  if (!canRead) return null;
  const lookup = async () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(merchant)) { setNote("商户标识格式无效"); return; }
    const currentSeq = ++seq.current;
    try {
      const acc = await adminRequest<{ available?: AccountSummary; collection?: AccountSummary }>(`/finance/merchant-accounts/${encodeURIComponent(merchant)}`, undefined, "GET");
      if (currentSeq === seq.current) { setAccount(acc); setNote(""); }
    } catch (e) {
      if (currentSeq === seq.current) { setAccount(null); setNote(friendlyError(e)); }
    }
  };
  return <section className="finance-joinpay-ops space-y-3 text-sm" data-joinpay-ops>
    {workers === undefined ? <Button size="sm" variant="secondary" onClick={() => void readWorkers()}>读取补查任务状态</Button> : workers === null ? <p>补查任务状态不可用</p>
      : <ul className="text-xs space-y-0.5 text-muted-foreground"><li>退款补查：{workerText(workers.refund)}</li><li>提现补查：{workerText(workers.payout)}</li><li>收款补查：{workerText(workers.collection)}</li></ul>}
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="商户账户摘要读取">
      <Field label="商户标识" className="max-w-xs"><Input aria-label="商户标识" value={merchant} onChange={e => { resetMerchant(); setMerchant(e.target.value.trim()); }} placeholder="输入平台登记的商户标识" /></Field>
      <Button size="sm" type="button" onClick={() => void lookup()}>读取账户摘要</Button>
    </div>
    {account ? <p className="text-xs">可用账户：{accountText(account.available)} · 收款账户：{accountText(account.collection)} · 资产合计：未记录（渠道余额不是资产）· 银行到账未记录</p> : null}
    {note ? <p role="status" className="text-xs text-destructive">{note}</p> : null}
    {canWithdrawalQuery ? <AdminWithdrawalQueryBox /> : null}
    <p className="oc-fact-note text-xs">这里只读取已保存的账户快照和任务状态，不会实时查询汇聚。</p>
  </section>;
}
