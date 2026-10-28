"use client";
import { useEffect, useRef, useState } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { OrderRequestError, orderIntentKey } from "@/lib/order-client";
import { clearIntent, inspectIntent, recordIntentReceipt, saveIntent, type PendingIntent } from "@/lib/order-intents";
import { legacyContinuationApi, parseLegacyQuantitiesInput, type LegacyCommandName, type LegacyContinuation, type LegacyProposal, type LegacyReceipt } from "@/lib/legacy-continuation-client";

const labels: Record<string, string> = { payMoney: "原已付", saleEarnings: "号主结算毛额", returnOrderMoney: "退款毛额", detainMoney: "原扣留金额", fullPayoutMoney: "包赔费用", ownerNet: "号主应结", commissionPool: "佣金池", refundNet: "租客净应退", depositCompensation: "押金补偿责任" };
const names = { expendHaff: "消耗哈夫币（沿原订单单位）", barrett: "巴雷特子弹消耗", bullet: "6级子弹消耗", awm: "AWM子弹消耗", armor: "6级护甲消耗", helmet: "6级头盔消耗", coffee: "咖啡豆消耗", card: "原保险消耗" };
const actions: Record<LegacyCommandName, string> = { propose: "提交结算提议", confirm: "确认本次结算", reject: "驳回本次提议", hold: "暂扣押金", release: "解除暂扣", confiscate: "没收押金" };
const stageName: Record<string, string> = { "3": "进行中", "8": "待号主确认", "9": "待租客确认", "4": "订单已完成" };
const reasons: Record<string, string> = { NOT_IMPORTED: "续办资料尚未核定，请联系受权客服。", EVIDENCE_ISOLATED: "来源资料存在待核事项，当前不能办理。", MISSING_STORED_SETTLEMENT: "原结算提议资料不完整，请联系受权客服核对。", FINANCE_FACT_UNAVAILABLE: "资金处理依据尚待接通，押金处置暂不可用。", FINANCE_FACT_UNKNOWN: "原资金处理结果尚待核对，请保留原请求。", DEPOSIT_ALREADY_SETTLED: "净退款已记入财账，不能重复处置押金。", CONTINUATION_REVISION_CONFLICT: "订单已有新结果，请刷新后核对。", PLAN_FINGERPRINT_MISMATCH: "本次预估已变化，请重新核对。", DUTY_REVISION_CONFLICT: "相关责任状态已变化，请刷新后核对。", DEPOSIT_SHORT: "消耗超过本单可结算范围，请核对数量。", RETURN_NEGATIVE: "退款结果不符合原订单规则，请核对消耗。" };
function message(error: unknown): string {
  if (error instanceof OrderRequestError && error.status === 401) return "登录状态已失效，请重新登录后核对原请求。";
  if (error instanceof OrderRequestError && [403, 404].includes(error.status)) return "当前身份无法办理这笔订单。";
  return error instanceof Error && reasons[error.message] ? reasons[error.message]! : "请求尚未确认，请刷新或按原请求核对结果。";
}
type PendingState = ReturnType<typeof inspectIntent>;
type Scoped<T> = { scope: string; value: T };
function safePending(userId: string, orderId: string): PendingState {
  const result = inspectIntent(userId, "legacy.continuation", orderId), intent = result.intent;
  if (result.state !== "VALID" || !intent) return result;
  const kind = intent.context?.command;
  if (typeof kind !== "string" || !["propose", "confirm", "reject"].includes(kind) || !intent.body || typeof intent.body !== "object" || typeof intent.body.inputEvidenceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(intent.body.inputEvidenceId) || typeof intent.body.planFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(intent.body.planFingerprint)
    || intent.body.expectedRevision !== null && (typeof intent.body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(intent.body.expectedRevision))
    || Object.keys(intent.body).some(key => !["expectedRevision", "inputEvidenceId", "planFingerprint", ...(kind === "propose" ? ["quantities"] : [])].includes(key))) return { state: "UNREADABLE", intent: null };
  if (kind === "propose") { try { parseLegacyQuantitiesInput(intent.body.quantities); } catch { return { state: "UNREADABLE", intent: null }; } }
  return result;
}
export function LegacyContinuationPanel({ orderId, party }: { orderId: string; party: "renter" | "owner" }) {
  const session = useUserSession(), scope = `${session.status}:${session.userId}:${session.identityVersion}:${orderId}:${party}`;
  const live = useRef({ scope, read: 0, operation: 0 });
  if (live.current.scope !== scope) live.current = { scope, read: live.current.read + 1, operation: live.current.operation + 1 };
  const [result, setResult] = useState<Scoped<LegacyContinuation | null>>({ scope, value: null });
  const [error, setError] = useState<Scoped<string>>({ scope, value: "" });
  const [form, setForm] = useState<Scoped<Record<string, string>>>({ scope, value: {} });
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
  useEffect(() => {
    const abort = new AbortController(), ticket = ++live.current.read;
    setResult({ scope, value: null }); setPreview({ scope, value: null }); setConfirmation({ scope, value: null }); setResolved({ scope, value: null });
    if (session.status !== "authenticated" || !session.userId) return () => abort.abort();
    setPending({ scope, value: safePending(session.userId, orderId) });
    void legacyContinuationApi.read(orderId, abort.signal).then(value => {
      if (!current() || abort.signal.aborted || live.current.read !== ticket) return;
      setResult({ scope, value }); setError({ scope, value: "" });
      setForm({ scope, value: Object.fromEntries(Object.keys(names).map(key => [key, value.quantities?.[key as keyof typeof names] ?? ""])) });
    }).catch(e => { if (!current() || abort.signal.aborted || live.current.read !== ticket) return; setError({ scope, value: message(e) }); if (e instanceof OrderRequestError && e.status === 401) session.revalidate(); });
    return () => abort.abort();
  }, [scope, nonce]);
  async function estimate() {
    if (blocked || !data?.capabilities.includes("propose")) return;
    const ticket = ++live.current.operation;
    setBusy({ scope, value: true }); setError({ scope, value: "" });
    try { const quantities = parseLegacyQuantitiesInput(Object.fromEntries(Object.keys(names).map(k => [k, fields[k]?.trim() || null]))), serialized = JSON.stringify(quantities);
      const body = await legacyContinuationApi.preview(orderId, quantities); if (current() && live.current.operation === ticket) setPreview({ scope, value: { body, quantities: serialized } }); }
    catch (e) { if (current() && live.current.operation === ticket) setError({ scope, value: message(e) }); }
    finally { if (current() && live.current.operation === ticket) setBusy({ scope, value: false }); }
  }
  function prepare(kind: LegacyCommandName) {
    if (blocked || !data?.evidenceId || !data.capabilities.includes(kind)) return;
    if (kind === "propose") {
      const p = preview.scope === scope ? preview.value : null;
      if (!p) return;
      const quantities = parseLegacyQuantitiesInput(Object.fromEntries(Object.keys(names).map(k => [k, fields[k]?.trim() || null])));
      if (JSON.stringify(quantities) !== p.quantities) { setPreview({ scope, value: null }); return; }
      setConfirmation({ scope, value: { kind, body: { expectedRevision: p.body.revision, inputEvidenceId: p.body.inputEvidenceId, planFingerprint: p.body.proposalFingerprint, quantities } } });
    } else {
      const fingerprint = data.commandFingerprints[kind]; if (!fingerprint) return;
      setConfirmation({ scope, value: { kind, body: { expectedRevision: data.revision, inputEvidenceId: data.evidenceId, planFingerprint: fingerprint } } });
    }
  }
  async function send(intent: PendingIntent) {
    const kind = intent.context!.command as LegacyCommandName, ticket = ++live.current.operation;
    setBusy({ scope, value: true }); setConfirmation({ scope, value: null });
    try {
      const receipt = await legacyContinuationApi.write(orderId, kind, intent.body, intent.key);
      if (!current() || live.current.operation !== ticket) return;
      recordIntentReceipt(intent.userId, "legacy.continuation", orderId, receipt); clearIntent(intent.userId, "legacy.continuation", orderId);
      setPending({ scope, value: { state: "NONE", intent: null } }); setError({ scope, value: "" }); setNonce(n => n + 1);
    } catch (e) { if (current() && live.current.operation === ticket) setError({ scope, value: message(e) }); }
    finally { if (current() && live.current.operation === ticket) setBusy({ scope, value: false }); }
  }
  function submit() {
    const c = confirmation.scope === scope ? confirmation.value : null;
    if (!c || !session.userId || blocked || !current()) return;
    if (safePending(session.userId, orderId).state !== "NONE") { setPending({ scope, value: safePending(session.userId, orderId) }); return; }
    const saved = saveIntent({ userId: session.userId, kind: "legacy.continuation", resourceId: orderId, key: orderIntentKey(), body: structuredClone(c.body), context: { command: c.kind } });
    if (!saved.persisted) { setPending({ scope, value: { state: "UNREADABLE", intent: null } }); setError({ scope, value: "无法保全原请求，尚未提交。请检查浏览器存储后重试。" }); return; }
    setPending({ scope, value: { state: "VALID", intent: saved.intent } }); void send(saved.intent);
  }
  async function recover() {
    const intent = pendingValue.intent; if (!intent || loading || !current()) return;
    const ticket = ++live.current.operation; setBusy({ scope, value: true });
    try {
      const receipt = await legacyContinuationApi.receipt(orderId, intent.context!.command as LegacyCommandName, intent.key, intent.body);
      if (!current() || live.current.operation !== ticket) return;
      setResolved({ scope, value: receipt });
      if (receipt.state === "KNOWN_SUCCESS") { recordIntentReceipt(intent.userId, "legacy.continuation", orderId, receipt.receipt); clearIntent(intent.userId, "legacy.continuation", orderId); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }
    } catch (e) { if (current() && live.current.operation === ticket) setError({ scope, value: message(e) }); }
    finally { if (current() && live.current.operation === ticket) setBusy({ scope, value: false }); }
  }
  const confirm = confirmation.scope === scope ? confirmation.value : null, proposed = preview.scope === scope ? preview.value : null, recovery = resolved.scope === scope ? resolved.value : null;
  if (session.status !== "authenticated") return null;
  return <section className="account-module-card legacy-continuation" aria-label="订单续办" aria-busy={loading}>
    <header className="account-module-heading"><div><h3>订单办理</h3><p>{data?.stage ? stageName[data.stage] : "核对可办理事项"}</p></div><button className="button secondary" type="button" disabled={loading} onClick={() => setNonce(n => n + 1)}>刷新</button></header>
    {error.scope === scope && error.value ? <p role="alert" className="order-feedback">{error.value}</p> : null}
    {!data ? <p className="order-muted">{error.scope === scope && error.value ? "续办资料暂不可用，原订单信息保留。" : "正在核对续办资料。原订单信息保留。"}</p> : data.availability !== "KNOWN" ? <p className="order-muted">{data.availability === "NOT_IMPORTED" ? reasons.NOT_IMPORTED : "该订单有待核来源资料，暂不能办理。"}</p> : <>
      <dl className="order-facts">{Object.entries(data.amounts).filter(([key]) => labels[key]).map(([key, amount]) => <div key={key}><dt>{labels[key]}</dt><dd>{amount ? `¥${amount.yuan}` : "待核"}</dd></div>)}</dl>
      <p className="order-muted">订单完成、财账入账和退款到账分别核对。解除暂扣不自动退还原扣留金额。</p>
      {data.duties.length ? <ul className="legacy-duty-list">{data.duties.map(d => <li key={d.id}><span>{{ RENTER_REFUND: "租客退款责任", OWNER_CREDIT: "号主应结责任", COMMISSION: "佣金责任", DEPOSIT_COMPENSATION: "押金补偿责任" }[d.kind] ?? "结算责任"}</span><strong>¥{(BigInt(d.amountCents) / 100n).toString()}.{(BigInt(d.amountCents) % 100n).toString().padStart(2, "0")}</strong><span>{d.settledBy === "LEGACY_RECORDS" ? "旧侧已处理，不重复支付" : { PENDING: "待财账处理", MATURED: "已成熟待入账", SETTLED: "财账已终定", VOID: "已作废" }[d.status] ?? "待核"}</span></li>)}</ul> : null}
      {data.capabilities.includes("propose") ? <div className="legacy-consumption"><h4>填写本次实际消耗</h4><div className="legacy-consumption-grid">{Object.entries(names).map(([key, label]) => <label key={key}>{label}<input inputMode="decimal" value={fields[key] ?? ""} placeholder="待填写" disabled={blocked} onChange={event => { setForm({ scope, value: { ...fields, [key]: event.target.value } }); setPreview({ scope, value: null }); setConfirmation({ scope, value: null }); }}/></label>)}</div><button className="button secondary" type="button" disabled={blocked} onClick={() => void estimate()}>核对结算结果</button>
        {proposed ? <div className="legacy-proposal"><h4>将发送的结算提议</h4><dl className="order-facts">{Object.entries(proposed.body.proposalAmounts).filter(([key, value]) => labels[key] && value !== null).map(([key, value]) => <div key={key}><dt>{labels[key]}</dt><dd>¥{value}</dd></div>)}</dl><button className="button primary" type="button" disabled={blocked} onClick={() => prepare("propose")}>提交结算提议</button></div> : null}</div> : null}
      <div className="order-trade-actions">{(["confirm", "reject"] as const).filter(kind => data.capabilities.includes(kind)).map(kind => <button className={kind === "confirm" ? "button primary" : "button secondary"} type="button" key={kind} disabled={blocked} onClick={() => prepare(kind)}>{actions[kind]}</button>)}</div>
      {confirm ? <div className="order-feedback" role="group" aria-label="核对本次操作"><p>{confirm.kind === "reject" ? "驳回后返回进行中，原提议仍保留记录。" : "请核对上方结算金额。本次操作不会重新收款，也不代表退款到账。"}</p><button className="button primary" type="button" disabled={loading} onClick={submit}>确认提交</button><button className="button secondary" type="button" disabled={loading} onClick={() => setConfirmation({ scope, value: null })}>返回核对</button></div> : null}
    </>}
    {pendingValue.state === "UNREADABLE" ? <p role="status">原请求记录暂时无法读取，新提交已暂停。请保留浏览器数据并联系受权客服核对；订单信息仍可查看。</p> : pendingValue.intent ? <div role="status" className="order-feedback"><p>存在尚未确认的原请求。核对结果前请勿另建请求。</p><button className="button secondary" type="button" disabled={loading} onClick={() => void recover()}>核对原请求结果</button>{recovery?.state === "UNKNOWN" ? <button className="button secondary" type="button" disabled={loading} onClick={() => void send(pendingValue.intent!)}>重试原请求</button> : null}{recovery?.state === "KNOWN_REJECTED" ? <><p>原请求已被拒绝，未形成这次办理结果。请刷新核对后再修改。</p><button className="button secondary" type="button" disabled={loading} onClick={() => { clearIntent(pendingValue.intent!.userId, "legacy.continuation", orderId); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }}>刷新后重新核对</button></> : null}</div> : null}
  </section>;
}
