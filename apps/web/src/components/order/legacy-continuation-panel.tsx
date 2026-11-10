"use client";
import { useEffect, useRef, useState } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { formatOrderTime, OrderRequestError, orderIntentKey } from "@/lib/order-client";
import { FormSelect } from "@/components/ui/form-controls";
import { clearIntent, inspectIntent, recordIntentReceipt, saveIntent, type PendingIntent } from "@/lib/order-intents";
import { legacyContinuationApi, parseLegacyQuantitiesInput, type LegacyCommandName, type LegacyContinuation, type LegacyEndReason, type LegacyProposal, type LegacyReceipt } from "@/lib/legacy-continuation-client";

const labels: Record<string, string> = { payMoney: "订单实付", saleEarnings: "出租收入（扣包赔费前）", returnOrderMoney: "退款金额（暂扣前）", detainMoney: "暂扣金额", fullPayoutMoney: "包赔费用", ownerNet: "号主应结", earlyMakeup:"提前结算补足", renterPayoutFee:"租客承担的包赔费", commissionPool: "佣金池", refundNet: "应退金额", depositCompensation: "押金补偿" };
const names = { expendHaff: "哈夫币消耗（M）", barrett: "巴雷特子弹（发）", bullet: "6级子弹（组）", awm: "AWM 子弹（发）", armor: "6级护甲（个）", helmet: "6级头盔（个）", coffee: "咖啡豆（个）", card: "保险卡（天）" };
const actions: Record<LegacyCommandName, string> = { propose: "提交结算方案", confirm: "确认结算方案", reject: "拒绝结算方案", hold: "暂扣押金", release: "解除暂扣", confiscate: "没收押金" };
const stageName: Record<string, string> = { "3": "租赁中", "8": "待号主确认", "9": "待租客确认", "4": "租赁已结束", "5": "订单已取消" };
const refundProgressName:Record<string,string>={UNKNOWN:'退款状态待核对',NO_REFUND_DUE:'无需退款',NO_NEW_REFUND:'旧退款已抵扣本次应退',CHANNEL_SUCCEEDED:'渠道已确认退款',FAILED:'退款未完成，请联系客服',PROCESSING:'退款处理中',REVIEW_REQUIRED:'退款状态待核对',SIMULATED:'模拟退款已记录，不代表真实退款或到账'};
const reasons: Record<string, string> = { NOT_IMPORTED: "订单资料未记录，请联系客服。", EVIDENCE_ISOLATED: "订单资料需要核对，暂时无法办理。", MISSING_STORED_SETTLEMENT: "结算信息不完整，请联系客服。", FINANCE_FACT_UNAVAILABLE: "押金处理暂不可用，请稍后再试。", FINANCE_FACT_UNKNOWN: "资金处理结果未记录，请联系客服。", DEPOSIT_ALREADY_SETTLED: "退款已记录，押金不能重复处理。", CONTINUATION_REVISION_CONFLICT: "订单已有新结果，请刷新后核对。", PLAN_FINGERPRINT_MISMATCH: "本次预估已变化，请重新核对。", DUTY_REVISION_CONFLICT: "处理状态已更新，请刷新后查看。", DEPOSIT_SHORT: "消耗超过本单可结算范围，请核对数量。", RETURN_NEGATIVE: "退款结果不符合原订单规则，请核对消耗。", PRECISION_UNSUPPORTED: "本单金额需要进一步核对，请联系客服协助结算。", CONFIRM_POOL_NEGATIVE: "本单结算金额需要核对，请联系客服协助处理。", OWNER_NET_NEGATIVE: "本单结算金额需要核对，请联系客服协助处理。" };
reasons.OPENING_BASIS_UNVERIFIED = "请联系客服核对本单原有资源和结算依据。";
reasons.LEGACY_PROPOSAL_RECONFIRM_REQUIRED = "原结算方案需要重新核对，双方确认后才能结算。";
reasons.EARLY_REVIEW_PENDING = "结算方案已确认，等待客服复核。";
reasons.END_REASON_REQUIRED = "请先选择结束原因。";
reasons.END_REASON_INCONSISTENT = "结束原因与哈夫币消耗比例不符，请核对。";
function message(error: unknown): string {
  if (error instanceof OrderRequestError && error.status === 401) return "登录状态已失效，请重新登录后查看。";
  if (error instanceof OrderRequestError && [403, 404].includes(error.status)) return "当前身份无法办理这笔订单。";
  return error instanceof Error && reasons[error.message] ? reasons[error.message]! : "操作结果未记录，请刷新后查看。";
}
type PendingState = ReturnType<typeof inspectIntent>;
type Scoped<T> = { scope: string; value: T };
function safePending(userId: string, orderId: string): PendingState {
  const result = inspectIntent(userId, "legacy.continuation", orderId), intent = result.intent;
  if (result.state !== "VALID" || !intent) return result;
  const kind = intent.context?.command;
  if (typeof kind !== "string" || !["propose", "confirm", "reject"].includes(kind) || !intent.body || typeof intent.body !== "object" || typeof intent.body.inputEvidenceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intent.body.inputEvidenceId) || typeof intent.body.planFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(intent.body.planFingerprint)
    || intent.body.expectedRevision !== null && (typeof intent.body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(intent.body.expectedRevision))
    || Object.keys(intent.body).some(key => !["expectedRevision", "inputEvidenceId", "planFingerprint", ...(kind === "propose" ? ["quantities", "endReason"] : [])].includes(key))
    || intent.body.endReason !== undefined && !["NORMAL","TENANT_VOLUNTARY_EARLY","OWNER_OR_ACCOUNT_EARLY"].includes(String(intent.body.endReason))) return { state: "UNREADABLE", intent: null };
  if (kind === "propose") { try { parseLegacyQuantitiesInput(intent.body.quantities); } catch { return { state: "UNREADABLE", intent: null }; } }
  return result;
}
/** Read-only report for the surrounding workspace; the panel still owns every write. */
export type LegacyContinuationReport = {
  scope: string;
  orderId: string;
  continuation: LegacyContinuation | null;
  error: string;
  pending: string;
};
export function LegacyContinuationPanel({ orderId, party, onOrderChanged, onContinuation, readOnly = false }: { orderId: string; party: "renter" | "owner"; onOrderChanged?: () => void; onContinuation?: (report: LegacyContinuationReport) => void; readOnly?: boolean }) {
  const session = useUserSession(), scope = `${session.status}:${session.userId}:${session.identityVersion}:${orderId}:${party}`;
  const live = useRef({ scope, read: 0, operation: 0 });
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  if (live.current.scope !== scope) live.current = { scope, read: live.current.read + 1, operation: live.current.operation + 1 };
  const [result, setResult] = useState<Scoped<LegacyContinuation | null>>({ scope, value: null });
  const [error, setError] = useState<Scoped<string>>({ scope, value: "" });
  const [form, setForm] = useState<Scoped<Record<string, string>>>({ scope, value: {} });
  const [endReason, setEndReason] = useState<Scoped<LegacyEndReason | "">>({scope,value:""});
  const [preview, setPreview] = useState<Scoped<{ body: LegacyProposal; quantities: string } | null>>({ scope, value: null });
  const [pending, setPending] = useState<Scoped<PendingState>>({ scope, value: { state: "NONE", intent: null } });
  const [resolved, setResolved] = useState<Scoped<LegacyReceipt | null>>({ scope, value: null });
  const [confirmation, setConfirmation] = useState<Scoped<{ kind: LegacyCommandName; body: Record<string, unknown> } | null>>({ scope, value: null });
  const [busy, setBusy] = useState<Scoped<boolean>>({ scope, value: false });
  const [nonce, setNonce] = useState(0);
  const current = () => live.current.scope === scope;
  const data = result.scope === scope ? result.value : null, pendingValue = pending.scope === scope ? pending.value : { state: "NONE" as const, intent: null };
  const loading = busy.scope === scope && busy.value, blocked = loading || pendingValue.state !== "NONE";
  const fields = form.scope === scope ? form.value : {};
  // Report the read outcome (and any saved original-key intent) to the surrounding progress card.
  // A ref keeps a fresh callback from restarting the continuation read.
  const notify = useRef(onContinuation);
  notify.current = onContinuation;
  useEffect(() => {
    notify.current?.({ scope, orderId, continuation: data, error: error.scope === scope ? error.value : "", pending: pendingValue.state });
  }, [scope, orderId, data, pendingValue.state, error.scope, error.value]);
  useEffect(() => {
    const abort = new AbortController(), ticket = ++live.current.read;
    setEndReason({scope,value:""});
    setResult({ scope, value: null }); setPreview({ scope, value: null }); setConfirmation({ scope, value: null }); setResolved({ scope, value: null });
    if (session.status !== "authenticated" || !session.userId) return () => abort.abort();
    const acting = session.userId;
    setPending({ scope, value: safePending(acting, orderId) });
    void legacyContinuationApi.read(acting, orderId, abort.signal).then(value => {
      if (!current() || abort.signal.aborted || live.current.read !== ticket) return;
      setResult({ scope, value }); setError({ scope, value: "" });
      setForm({ scope, value: Object.fromEntries(Object.keys(names).map(key => [key, value.quantities?.[key as keyof typeof names] ?? (key === "expendHaff" ? "" : "0")])) });
    }).catch(e => { if (!current() || abort.signal.aborted || live.current.read !== ticket) return; setError({ scope, value: message(e) }); if (e instanceof OrderRequestError && e.status === 401) session.revalidate(); });
    return () => abort.abort();
  }, [scope, nonce]);
  useEffect(() => {
    if (readOnly) { setPreview({ scope, value: null }); setConfirmation({ scope, value: null }); }
  }, [readOnly, scope]);
  async function estimate() {
    const acting = session.userId;
    const reason=endReason.scope===scope?endReason.value:"";
    if (readOnly || blocked || !acting || !reason || !data?.capabilities.includes("propose")) return;
    const ticket = ++live.current.operation;
    setBusy({ scope, value: true }); setError({ scope, value: "" });
    try { const quantities = parseLegacyQuantitiesInput(Object.fromEntries(Object.keys(names).map(k => [k, fields[k]?.trim() || null]))), serialized = JSON.stringify({quantities,endReason:reason});
      const body = await legacyContinuationApi.preview(acting, orderId, quantities, reason); if (!readOnlyRef.current && current() && live.current.operation === ticket) setPreview({ scope, value: { body, quantities: serialized } }); }
    catch (e) { if (current() && live.current.operation === ticket) setError({ scope, value: message(e) }); }
    finally { if (current() && live.current.operation === ticket) setBusy({ scope, value: false }); }
  }
  function prepare(kind: LegacyCommandName) {
    if (readOnly || blocked || !data?.evidenceId || !data.capabilities.includes(kind)) return;
    if (kind === "propose") {
      const p = preview.scope === scope ? preview.value : null;
      if (!p) return;
      const quantities = parseLegacyQuantitiesInput(Object.fromEntries(Object.keys(names).map(k => [k, fields[k]?.trim() || null])));
      const reason=endReason.scope===scope?endReason.value:"";
      if (!reason || JSON.stringify({quantities,endReason:reason}) !== p.quantities) { setPreview({ scope, value: null }); return; }
      setConfirmation({ scope, value: { kind, body: { expectedRevision: p.body.revision, inputEvidenceId: p.body.inputEvidenceId, planFingerprint: p.body.proposalFingerprint, quantities, endReason:reason } } });
    } else {
      const fingerprint = data.commandFingerprints[kind]; if (!fingerprint) return;
      setConfirmation({ scope, value: { kind, body: { expectedRevision: data.revision, inputEvidenceId: data.evidenceId, planFingerprint: fingerprint } } });
    }
  }
  async function send(intent: PendingIntent) {
    if (!current()) return;
    // The frozen intent owner, never a later session value. A delayed intent for A must not be
    // replayed while B is live: keep the original key/body and ask the user to refresh.
    if (session.status !== "authenticated" || session.userId !== intent.userId) {
      setError({ scope, value: "登录身份已变化；原申请已保留，请刷新后按原请求核对，不会重新提交。" });
      return;
    }
    const kind = intent.context!.command as LegacyCommandName, ticket = ++live.current.operation;
    setBusy({ scope, value: true }); setConfirmation({ scope, value: null });
    try {
      const receipt = await legacyContinuationApi.write(intent.userId, orderId, kind, intent.body, intent.key);
      if (!current() || live.current.operation !== ticket) return;
      recordIntentReceipt(intent.userId, "legacy.continuation", orderId, receipt); clearIntent(intent.userId, "legacy.continuation", orderId);
      setPending({ scope, value: { state: "NONE", intent: null } }); setError({ scope, value: "" });
      if (onOrderChanged) onOrderChanged(); else setNonce(n => n + 1);
    } catch (e) { if (current() && live.current.operation === ticket) setError({ scope, value: message(e) }); }
    finally { if (current() && live.current.operation === ticket) setBusy({ scope, value: false }); }
  }
  function submit() {
    const c = confirmation.scope === scope ? confirmation.value : null;
    if (readOnly || !c || !session.userId || blocked || !current()) return;
    if (safePending(session.userId, orderId).state !== "NONE") { setPending({ scope, value: safePending(session.userId, orderId) }); return; }
    const saved = saveIntent({ userId: session.userId, kind: "legacy.continuation", resourceId: orderId, key: orderIntentKey(), body: structuredClone(c.body), context: { command: c.kind } });
    if (!saved.persisted) { setPending({ scope, value: { state: "UNREADABLE", intent: null } }); setError({ scope, value: "暂时无法提交，请保留当前页面并联系客服。" }); return; }
    setPending({ scope, value: { state: "VALID", intent: saved.intent } }); void send(saved.intent);
  }
  async function recover() {
    const intent = pendingValue.intent; if (!intent || loading || !current()) return;
    const ticket = ++live.current.operation; setBusy({ scope, value: true });
    try {
      const receipt = await legacyContinuationApi.receipt(intent.userId, orderId, intent.context!.command as LegacyCommandName, intent.key, intent.body);
      if (!current() || live.current.operation !== ticket) return;
      setResolved({ scope, value: receipt });
      if (receipt.state === "KNOWN_SUCCESS") {
        recordIntentReceipt(intent.userId, "legacy.continuation", orderId, receipt.receipt); clearIntent(intent.userId, "legacy.continuation", orderId);
        setPending({ scope, value: { state: "NONE", intent: null } });
        if (onOrderChanged) onOrderChanged(); else setNonce(n => n + 1);
      }
    } catch (e) { if (current() && live.current.operation === ticket) setError({ scope, value: message(e) }); }
    finally { if (current() && live.current.operation === ticket) setBusy({ scope, value: false }); }
  }
  const confirm = confirmation.scope === scope ? confirmation.value : null, proposed = preview.scope === scope ? preview.value : null, recovery = resolved.scope === scope ? resolved.value : null;
  if (session.status !== "authenticated") return null;
  return <section className="account-module-card legacy-continuation" aria-label="订单续办" aria-busy={loading}>
    <header className="account-module-heading"><div><h3>订单结算</h3><p>{data?.reasons.includes("EARLY_REVIEW_PENDING") ? "待客服复核" : data?.stage ? stageName[data.stage] : "查看结算进度"}</p></div><button className="button secondary" type="button" disabled={loading} onClick={() => setNonce(n => n + 1)}>刷新</button></header>
    {error.scope === scope && error.value ? <p role="alert" className="order-feedback">{error.value}</p> : null}
    {!data ? <p className="order-muted">{error.scope === scope && error.value ? "暂时无法查看办理信息，请稍后重试。" : "正在查看办理信息…"}</p> : data.availability !== "KNOWN" && data.stage !== "5" ? <p className="order-muted">{data.availability === "NOT_IMPORTED" ? reasons.NOT_IMPORTED : "订单信息需要核对，暂时无法办理。"}</p> : <>
      {data.reasons.filter(code=>["OPENING_BASIS_UNVERIFIED","LEGACY_PROPOSAL_RECONFIRM_REQUIRED","EARLY_REVIEW_PENDING"].includes(code)).map(code=><p key={code} className="order-inline-notice">{reasons[code]}</p>)}
      {data.settlementKind === "EARLY" ? <p className="order-inline-notice"><strong>此方案属于提前结算。</strong>{data.earlyFee != null ? ` 提前结算费用 ¥${data.earlyFee}，已计入退款金额。` : " 详情可联系客服核对。"}</p> : null}
      <dl className="order-facts">{Object.entries(data.amounts).filter(([key]) => labels[key] && (data.stage!=="5" || (party==="renter"?["payMoney","refundNet"]:["ownerNet"]).includes(key))).map(([key, amount]) => <div key={key}><dt>{data.stage==="5" && key==="ownerNet"?"号主收益":labels[key]}</dt><dd>{amount ? `¥${amount.yuan}` : "未记录"}</dd></div>)}</dl>
      {["4","5"].includes(data.stage ?? "") && data.duties.some(d => ["PENDING", "MATURED"].includes(d.status)) ? <p className="order-inline-notice">订单已结束，相关退款或收益待处理；有疑问可联系页面上方的客服。</p> : null}
      {data.stage === "5" && data.reasons.includes("REFUND_HISTORY_REQUIRES_OFFLINE") ? <p className="order-muted">本单退款或收益信息需要进一步核对，请联系客服。</p> : null}
      {data.stage === "5" && data.reasons.includes("REFUND_ALLOCATION_DEFERRED") ? <p className="order-muted">退款处理需要客服核对，请联系客服了解进度。</p> : null}
      {party === "renter" && ["4","5"].includes(data.stage ?? "") && data.duties.some(d => d.kind === "RENTER_REFUND" && ["PENDING", "MATURED"].includes(d.status)) ? <p className="order-muted">{data.refundDueAt ? `退款最早可在 ${formatOrderTime(data.refundDueAt)} 后处理，到账以实际退款进度为准。` : "退款处理时间待核，请联系客服。"}</p> : null}
      {data.isSettle === "2" ? <p className="order-muted">本单有暂扣款项；解除暂扣后仍需核对退款处理情况。</p> : null}
      {data.duties.length ? <ul className="legacy-duty-list">{data.duties.map(d => <li key={d.id}><span>{{ RENTER_REFUND: "租客退款", OWNER_CREDIT: "出租收益", COMMISSION: "佣金", DEPOSIT_COMPENSATION: "押金补偿" }[d.kind] ?? "结算"}</span><strong>¥{(BigInt(d.amountCents) / 100n).toString()}.{(BigInt(d.amountCents) % 100n).toString().padStart(2, "0")}</strong><span>{d.kind === "RENTER_REFUND" && d.status === "SETTLED" ? refundProgressName[d.refundProgress]??'退款状态待核对' : d.settledBy === "LEGACY_RECORDS" ? "已处理" : d.kind === "OWNER_CREDIT" && d.status === "SETTLED" && d.settledBy === "FINANCE" ? (d.financeVerified ? d.amountCents === "0" ? "无需入账" : "已入平台余额" : "账目待核对") : d.kind === "OWNER_CREDIT" && d.status === "PENDING" ? "待核对" : { PENDING: "待处理", MATURED: "待结算", SETTLED: "处理已记录", VOID: "已取消" }[d.status] ?? "未记录"}</span></li>)}</ul> : null}
      {!readOnly && data.capabilities.includes("propose") ? <div className="legacy-consumption"><h4>填写本次实际消耗</h4><p className="order-muted">请核对实际使用数量；未使用的物资填 0。6级子弹按组填写，1 组为 60 发。</p><div className="legacy-consumption-grid">{Object.entries(names).map(([key, label]) => <label key={key}>{label}<input inputMode="decimal" value={fields[key] ?? ""} placeholder={key === "expendHaff" ? "填写消耗" : "0"} disabled={blocked} onChange={event => { setForm({ scope, value: { ...fields, [key]: event.target.value } }); setPreview({ scope, value: null }); setConfirmation({ scope, value: null }); }}/></label>)}</div><FormSelect label="结束原因" value={endReason.scope===scope?endReason.value:""} disabled={blocked} placeholder="请选择结束原因" options={[{value:"NORMAL",label:"正常结算"},{value:"TENANT_VOLUNTARY_EARLY",label:"租客自愿提前结束"},{value:"OWNER_OR_ACCOUNT_EARLY",label:"号主或账号原因提前结束"}]} onChange={value=>{setEndReason({scope,value:value as LegacyEndReason});setPreview({scope,value:null});setConfirmation({scope,value:null});}} /><button className="button secondary" type="button" disabled={blocked || endReason.scope!==scope || !endReason.value} onClick={() => void estimate()}>核对结算结果</button>
        {proposed ? <div className="legacy-proposal"><h4>结算方案</h4>{proposed.body.settlementKind === "EARLY" ? <p className="order-inline-notice"><strong>本次为提前结算。</strong>{proposed.body.earlyFee != null ? ` 提前结算费用 ¥${proposed.body.earlyFee}，已计入下方退款金额。` : " 请核对下方结算金额。"}</p> : null}<dl className="order-facts">{Object.entries(proposed.body.proposalAmounts).filter(([key, value]) => labels[key] && value !== null).map(([key, value]) => <div key={key}><dt>{labels[key]}</dt><dd>¥{value}</dd></div>)}</dl><button className="button primary" type="button" disabled={blocked} onClick={() => prepare("propose")}>提交结算方案</button></div> : null}</div> : null}
      {!readOnly ? <div className="order-trade-actions">{(["confirm", "reject"] as const).filter(kind => data.capabilities.includes(kind)).map(kind => <button className={kind === "confirm" ? "button primary" : "button secondary"} type="button" key={kind} disabled={blocked} onClick={() => prepare(kind)}>{actions[kind]}</button>)}</div> : null}
      {!readOnly && confirm ? <div className="order-feedback" role="group" aria-label="核对本次操作"><p>{confirm.kind === "reject" ? "拒绝后订单继续进行，原方案仍可查看。" : "请核对上方结算金额。本次操作不会重新收款，也不代表退款到账。"}</p><button className="button primary" type="button" disabled={loading} onClick={submit}>确认提交</button><button className="button secondary" type="button" disabled={loading} onClick={() => setConfirmation({ scope, value: null })}>返回核对</button></div> : null}
    </>}
    {pendingValue.state === "UNREADABLE" ? <p role="status">暂时无法确认上次操作，请保留当前页面并联系客服。</p> : pendingValue.intent ? <div role="status" className="order-feedback"><p>上次操作结果未记录，请先查询进度，勿重复提交。</p><button className="button secondary" type="button" disabled={loading} onClick={() => void recover()}>查询处理进度</button>{recovery?.state === "UNKNOWN" ? <button className="button secondary" type="button" disabled={loading} onClick={() => void send(pendingValue.intent!)}>继续提交上次申请</button> : null}{recovery?.state === "KNOWN_REJECTED" ? <><p>上次申请未通过，请刷新后重新核对。</p><button className="button secondary" type="button" disabled={loading} onClick={() => { clearIntent(pendingValue.intent!.userId, "legacy.continuation", orderId); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }}>刷新后重新核对</button></> : null}</div> : null}
  </section>;
}
