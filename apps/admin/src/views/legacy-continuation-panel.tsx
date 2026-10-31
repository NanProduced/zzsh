import { useEffect, useRef, useState } from "react";
import { friendlyError, formatDate, type SessionSnapshot } from "../api";
import { Button } from "../components/ui-elements";
import { clearLegacyAdminIntent, inspectLegacyAdminIntent, legacyAdminSubject, readLegacyAdminContinuation, recoverLegacyAdminIntent, retainLegacyAdminIntent, sendLegacyAdminIntent, type LegacyAdminAction, type LegacyAdminPending, type LegacyAdminReceipt, type LegacyAdminView } from "../lib/legacy-continuation-client";
import "./legacy-continuation.css";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
const commandName: Record<LegacyAdminAction, string> = { hold: "暂扣押金", release: "解除暂扣", confiscate: "没收押金", mature: "核定佣金成熟", void: "按已核来源作废佣金" };
const amountName: Record<string, string> = { payMoney: "原已付", saleEarnings: "号主毛结算", returnOrderMoney: "退款毛额", detainMoney: "原扣留金额", ownerNet: "号主应结", refundNet: "租客净应退", commissionPool: "佣金池", depositCompensation: "押金补偿责任" };
const dutyName: Record<string, string> = { RENTER_REFUND: "租客退款", OWNER_CREDIT: "号主应结", COMMISSION: "佣金", DEPOSIT_COMPENSATION: "押金补偿" };
const money = (cents: string) => `¥${BigInt(cents) / 100n}.${(BigInt(cents) % 100n).toString().padStart(2, "0")}`;
type Scoped<T> = { scope: string; value: T };
export function LegacyAdminContinuationPanel({ snapshot, orderId, refreshNonce = 0 }: { snapshot: Snapshot; orderId: string; refreshNonce?: number }) {
  const subject = legacyAdminSubject(snapshot.adminUserId, orderId), scope = subject + "|" + snapshot.session.id + "|" + snapshot.permissions.slice().sort().join(",") + "|" + snapshot.security.isBoss;
  const live = useRef({ scope, ticket: 0 }); if (live.current.scope !== scope) live.current = { scope, ticket: live.current.ticket + 1 };
  const [view, setView] = useState<Scoped<LegacyAdminView | null>>({ scope, value: null }), [error, setError] = useState<Scoped<string>>({ scope, value: "" });
  const [pending, setPending] = useState<Scoped<LegacyAdminPending>>({ scope, value: { state: "NONE", intent: null } }), [receipt, setReceipt] = useState<Scoped<LegacyAdminReceipt | null>>({ scope, value: null });
  const [confirm, setConfirm] = useState<Scoped<{ command: LegacyAdminAction; dutyId: string | null; body: Record<string, unknown> } | null>>({ scope, value: null });
  const [busy, setBusy] = useState<Scoped<boolean>>({ scope, value: false }), [nonce, setNonce] = useState(0), [sourceRef, setSourceRef] = useState<Scoped<string>>({ scope, value: "" }), [reason, setReason] = useState<Scoped<string>>({ scope, value: "" });
  const current = () => live.current.scope === scope, data = view.scope === scope ? view.value : null, p = pending.scope === scope ? pending.value : { state: "NONE" as const, intent: null }, loading = busy.scope === scope && busy.value;
  const canOperate = snapshot.security.isBoss || snapshot.permissions.includes("order.legacy.continue"), locked = loading || p.state !== "NONE";
  useEffect(() => {
    const abort = new AbortController(), ticket = ++live.current.ticket;
    setView({ scope, value: null }); setConfirm({ scope, value: null }); setReceipt({ scope, value: null }); setPending({ scope, value: inspectLegacyAdminIntent(subject, orderId) });
    void readLegacyAdminContinuation(orderId, abort.signal).then(value => { if (!current() || abort.signal.aborted || live.current.ticket !== ticket) return; setView({ scope, value }); setError({ scope, value: "" }); }).catch(e => { if (current() && !abort.signal.aborted && live.current.ticket === ticket) setError({ scope, value: friendlyError(e) }); });
    return () => abort.abort();
  }, [scope, nonce, refreshNonce]);
  function choose(command: LegacyAdminAction, dutyId: string | null = null) {
    if (!data || !canOperate || locked || !current()) return;
    let body: Record<string, unknown>;
    if (dutyId) { const d = data.duties.find(d => d.id === dutyId); if (!d) return; body = { expectedRevision: d.revision, ...(command === "void" ? { sourceFactAuditId: sourceRef.scope === scope ? sourceRef.value.trim() : "", reason: reason.scope === scope ? reason.value.trim() : "" } : {}) }; }
    else { if (!data.capabilities.includes(command) || !data.evidenceId || !data.commandFingerprints[command]) return; body = { expectedRevision: data.revision, inputEvidenceId: data.evidenceId, planFingerprint: data.commandFingerprints[command] }; }
    setConfirm({ scope, value: { command, dutyId, body } });
  }
  async function sendOriginal() {
    if (p.state !== "VALID" || loading || !current()) return;
    const ticket = ++live.current.ticket; setBusy({ scope, value: true });
    try { await sendLegacyAdminIntent(p.intent); if (!current() || live.current.ticket !== ticket) return; clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }
    catch (e) { if (current() && live.current.ticket === ticket) setError({ scope, value: friendlyError(e) }); }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  async function submit() {
    const c = confirm.scope === scope ? confirm.value : null; if (!c || locked || !current()) return;
    const ticket = ++live.current.ticket; setBusy({ scope, value: true });
    try {
      const intent = await retainLegacyAdminIntent(subject, orderId, c.command, c.body, c.dutyId);
      if (!current() || live.current.ticket !== ticket) return;
      setPending({ scope, value: { state: "VALID", intent } }); setConfirm({ scope, value: null });
      await sendLegacyAdminIntent(intent);
      if (!current() || live.current.ticket !== ticket) return;
      clearLegacyAdminIntent(intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1);
    } catch (e) { if (current() && live.current.ticket === ticket) { setPending({ scope, value: inspectLegacyAdminIntent(subject, orderId) }); setError({ scope, value: friendlyError(e) }); } }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  async function recover() {
    if (p.state !== "VALID" || loading || !current()) return;
    const ticket = ++live.current.ticket; setBusy({ scope, value: true });
    try { const result = await recoverLegacyAdminIntent(p.intent); if (!current() || live.current.ticket !== ticket) return; setReceipt({ scope, value: result }); if (result.state === "KNOWN_SUCCESS") { clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); } }
    catch (e) { if (current() && live.current.ticket === ticket) setError({ scope, value: friendlyError(e) }); }
    finally { if (current() && live.current.ticket === ticket) setBusy({ scope, value: false }); }
  }
  const confirmation = confirm.scope === scope ? confirm.value : null, recovered = receipt.scope === scope ? receipt.value : null;
  return <section className="oc-section lc-admin" aria-label="旧单续办与责任" aria-busy={loading}>
    <header><div><h2>旧单办理与责任</h2><p>{data?.stage ? ({ "3": "进行中", "8": "待号主确认", "9": "待租客确认", "4": "订单已完成" }[data.stage] ?? "待核") : "独立核对续办依据"}</p></div><Button variant="secondary" size="sm" disabled={loading} onClick={() => setNonce(n => n + 1)}>刷新</Button></header>
    {error.scope === scope && error.value ? <p role="alert">{error.value}</p> : null}
    {!data ? <p className="oc-fact-note">{error.scope === scope && error.value ? "续办资料暂不可用，订单主体信息保留。" : "正在核对续办资料…"}</p> : data.availability !== "KNOWN" ? <p className="oc-fact-note">{data.availability === "NOT_IMPORTED" ? "本单续办来源尚未核定。" : "本单来源存在隔离事项，不能据此办理。"}</p> : <>
      <dl className="oc-fact-list">{Object.entries(data.amounts).filter(([key]) => amountName[key]).map(([key, amount]) => <div key={key}><dt>{amountName[key]}</dt><dd>{amount ? `¥${amount.yuan}` : "待核"}</dd></div>)}</dl>
      <p className="oc-fact-note">当事人提议与确认由原当事人完成。订单完成、财账终定、渠道到账分开；解除暂扣不会自动追加扣留部分退款。</p>
      {data.reasons.some(code => code.startsWith("FINANCE_FACT")) ? <p className="oc-fact-note">原资金处理结果尚待核对，当前押金处置不可用。</p> : null}
      <div className="lc-actions">{(["hold", "release", "confiscate"] as const).filter(kind => data.capabilities.includes(kind)).map(kind => <Button key={kind} variant={kind === "confiscate" ? "danger" : "secondary"} disabled={locked || !canOperate} onClick={() => choose(kind)}>{commandName[kind]}</Button>)}</div>
    </>}
    {data?.duties.length ? <div className="lc-duty-table"><h3>已记录经济责任</h3><table><thead><tr><th>责任</th><th>金额</th><th>状态</th><th>成熟依据</th><th>合法处理</th></tr></thead><tbody>{data.duties.map(d => <tr key={d.id}><td>{dutyName[d.kind] ?? "责任"}</td><td>{money(d.amountCents)}</td><td>{d.settledBy === "LEGACY_RECORDS" ? "旧侧已处理，不再支付" : { PENDING: "待处理", MATURED: "成熟待入账", SETTLED: "财账已终定", VOID: "已作废" }[d.status] ?? "待核"}</td><td>{d.maturityAt ? formatDate(d.maturityAt) : d.kind === "COMMISSION" ? "等待终金额/成熟证据" : "不适用"}</td><td>{canOperate && d.kind === "COMMISSION" && d.status === "PENDING" && d.maturityAt ? <Button size="sm" variant="secondary" disabled={locked} onClick={() => choose("mature", d.id)}>核定成熟</Button> : null}{canOperate && d.kind === "COMMISSION" && ["PENDING", "MATURED"].includes(d.status) ? <Button size="sm" variant="ghost" disabled={locked || sourceRef.scope !== scope || !sourceRef.value.trim() || reason.scope !== scope || !reason.value.trim()} onClick={() => choose("void", d.id)}>按已核来源作废</Button> : null}</td></tr>)}</tbody></table></div> : null}
    {canOperate && data?.duties.some(d => d.kind === "COMMISSION" && ["PENDING", "MATURED"].includes(d.status)) ? <div className="lc-source"><label>佣金作废的来源核定记录编号<input value={sourceRef.scope === scope ? sourceRef.value : ""} disabled={locked} maxLength={128} onChange={e => setSourceRef({ scope, value: e.target.value })}/></label><label>核定理由<textarea data-slot="textarea" value={reason.scope === scope ? reason.value : ""} disabled={locked} maxLength={500} onChange={e => setReason({ scope, value: e.target.value })} rows={2} className="mt-1 flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30" /></label><p className="oc-fact-note">只能引用已受权核定的源作废或父单取消且不应付事实；输入编号不能代替证据。</p></div> : null}
    {confirmation ? <div className="lc-confirm" role="group" aria-label="确认旧单处理"><p>请核对当前版本与来源责任：{commandName[confirmation.command]}。该操作不证明资金已到账，也不清零其他责任。</p><Button disabled={loading} onClick={() => void submit()}>确认{commandName[confirmation.command]}</Button><Button variant="secondary" disabled={loading} onClick={() => setConfirm({ scope, value: null })}>返回核对</Button></div> : null}
    {p.state === "UNREADABLE" ? <p role="status">原请求存储无法核对，新的写入已暂停；请保留原记录。当前订单读取仍可使用。</p> : p.state === "VALID" ? <div className="lc-confirm" role="status"><p>存在原处理请求，核清结果前不得另建操作。</p><Button variant="secondary" disabled={loading} onClick={() => void recover()}>核对原请求</Button>{recovered?.state === "UNKNOWN" ? <Button variant="secondary" disabled={loading} onClick={() => void sendOriginal()}>重试原请求</Button> : null}{recovered?.state === "KNOWN_REJECTED" ? <><p>原请求已明确拒绝，请刷新核对后修改。</p><Button variant="secondary" disabled={loading} onClick={() => { clearLegacyAdminIntent(p.intent); setPending({ scope, value: { state: "NONE", intent: null } }); setNonce(n => n + 1); }}>刷新并重新核对</Button></> : null}</div> : null}
  </section>;
}
