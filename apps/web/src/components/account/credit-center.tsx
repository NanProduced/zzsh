"use client";

import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useUserSession } from "../session/user-session-provider";
import { clearCreditWriteIntent, CreditRequestError, creditMoney, loadCreditWriteIntent, makeCreditWriteIntent, persistCreditWritePhase, readMyCredit, submitCreditWrite, type CreditOverview, type CreditWriteIntent } from "../../lib/credit-guarantee-client";
import "./credit-center.css";

const eventLabels: Record<string, string> = { INITIALIZED: "初始信用", BREACH_CONFIRMED: "确认违约", BREACH_REVERSED: "撤销误判", RECOVERY_APPROVED: "审核恢复" };
const guaranteeLabels: Record<string, string> = { NOT_REQUIRED: "当前免缴", REQUIRED: "待补保证金", PAYMENT_PENDING: "支付结果待确认", SATISFIED: "已覆盖", REFUND_REQUESTED: "退还申请待处理", REFUND_PROCESSING: "原路退还处理中", REFUNDED: "已原路退还", FAILED: "支付/退款失败待核", UNKNOWN: "资格未知" };

function failureText(error: unknown): string {
  if (!(error instanceof CreditRequestError)) return "信用信息暂时无法读取，请稍后重试。";
  if (error.status === 0) return "网络连接失败，请检查连接后重试。";
  if (error.status === 401) return "登录状态已变化，请重新登录后继续。";
  if (error.status === 403) return "当前账号没有执行此操作的权限。";
  if (error.status === 409) return "状态已变化，请刷新后重新核对。";
  return "信用与保证金暂时无法读取，请稍后重试。";
}

export function CreditCenter({ scope }: { scope: string }) {
  const session = useUserSession();
  const [state, setState] = useState<{ scope: string; phase: "loading" | "ready" | "error"; data: CreditOverview | null; error: string }>({ scope, phase: "loading", data: null, error: "" });
  const [reload, setReload] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<CreditWriteIntent | null>(() => loadCreditWriteIntent(scope));

  useEffect(() => {
    const controller = new AbortController();
    setState({ scope, phase: "loading", data: null, error: "" });
    const restored = loadCreditWriteIntent(scope);
    setPending(restored); setBusy(restored ? restored.phase === "readback" ? "readback" : "pending" : "");
    readMyCredit(controller.signal).then((data) => setState({ scope, phase: "ready", data, error: "" }), (error: unknown) => {
      if (controller.signal.aborted) return;
      setState({ scope, phase: "error", data: null, error: failureText(error) });
      if (error instanceof CreditRequestError && error.status === 401) session.revalidate();
    });
    return () => controller.abort();
  }, [reload, scope, session]);

  const data = state.scope === scope ? state.data : null;
  const reloadData = () => { setNotice(""); setReload((value) => value + 1); };
  const readback = async (intent: CreditWriteIntent, success: string) => {
    if (intent.subject !== scope) return;
    try {
      const next = await readMyCredit();
      setState({ scope, phase: "ready", data: next, error: "" });
      clearCreditWriteIntent(intent); setPending(null); setBusy(""); setNotice(success);
    } catch (error) {
      setPending(intent); setBusy("readback");
      if (error instanceof CreditRequestError && (error.status === 401 || error.status === 423)) {
        setState((current) => ({ ...current, phase: "error", data: null, error: error.status === 423 ? "当前状态被锁定；原操作责任仍保留，请重新读取。" : "登录状态已变化；原操作责任仍保留，请重新确认身份。" }));
        if (error.status === 401) session.revalidate();
      }
      setNotice(`${success} 已被服务端接受，但最新状态尚未读回；只重试读取，不重复提交。${failureText(error)}`);
    }
  };
  const runWrite = async (intent: CreditWriteIntent, success: string) => {
    if (intent.subject !== scope || (busy && busy !== "readback" && busy !== "pending")) return;
    setPending(intent); setBusy("pending"); setNotice("");
    try {
      await submitCreditWrite(intent);
      const phasePersisted = persistCreditWritePhase(intent, "readback");
      if (!phasePersisted) setNotice("写入已接受，但当前浏览器无法持久化回读阶段；请保持此页打开并先恢复站点存储，不会自动重提。");
      await readback(intent, success);
    } catch (error) {
      if (error instanceof CreditRequestError && error.code === "WRITE_INTENT_STORAGE_UNAVAILABLE") {
        clearCreditWriteIntent(intent); setPending(null); setBusy(""); setNotice("当前浏览器无法保存原操作意图，未提交任何写请求；请恢复站点存储后重试。");
        return;
      }
      if (error instanceof CreditRequestError && (error.unknownResult || error.status === 401 || error.status === 423)) {
        persistCreditWritePhase(intent, "unknown"); setPending(intent); setBusy("pending"); setState((current) => error.status === 401 || error.status === 423 ? { ...current, phase: "error", data: null, error: error.status === 423 ? "当前写入被锁定；原操作责任仍保留，请重新读取。" : "登录状态已变化；原操作责任仍保留，请重新确认身份后用原请求核对。" } : current);
        if (error.status === 401) session.revalidate();
        setNotice(error.status === 401 ? "登录状态已变化；未更换幂等键，也未丢弃原操作责任。" : "请求结果未知；不会换键重提，请用原请求核对或读取。");
        return;
      }
      clearCreditWriteIntent(intent); setPending(null); setBusy(""); setNotice(failureText(error));
    }
  };
  const retryPending = () => { if (pending && busy === "pending") void runWrite(pending, "原操作已重新提交，正在读取结果。 "); };
  const retryReadback = () => { if (pending && busy === "readback") void readback(pending, "原操作状态已核对。 "); };
  const submitRecovery = () => { if (reason.trim().length < 2 || pending) return; const intent = makeCreditWriteIntent(scope, "/recovery-requests", { reason: reason.trim() }); setReason(""); void runWrite(intent, "恢复申请已记录，等待授权人员审核；不会自动加分。 "); };
  const pay = (accountId: string) => { if (pending) return; const intent = makeCreditWriteIntent(scope, `/accounts/${encodeURIComponent(accountId)}/payment-intents`, {}); void runWrite(intent, "支付意图已留痕；汇聚通道未获授权提交时不会显示为到账。 "); };
  const refund = (requirementId: string) => { if (pending) return; const intent = makeCreditWriteIntent(scope, `/guarantees/${encodeURIComponent(requirementId)}/refund-requests`, {}); void runWrite(intent, "原路退还申请已留痕；责任释放与渠道到账仍分开显示。 "); };

  return <section className="account-module credit-center" aria-labelledby="credit-center-heading">
    <header className="account-module-heading"><div><h2 id="credit-center-heading">信用与号主保证金</h2><p>信用分归平台账号；保证金按出租账号分别核算，不与租客押金或钱包余额混用。</p></div><button type="button" className="button quiet" disabled={state.phase === "loading" || Boolean(busy)} onClick={reloadData}><RefreshCw size={15} aria-hidden="true" />刷新</button></header>
    {state.phase === "loading" ? <div className="account-module-card account-empty-state" role="status" aria-busy="true"><ShieldCheck size={28} aria-hidden="true" /><h3>正在读取信用状态</h3><p>不会根据订单取消或退款自动扣分。</p></div> : state.phase === "error" ? <div className="account-module-card account-empty-state" role="alert"><TriangleAlert size={28} aria-hidden="true" /><h3>信用信息暂时无法读取</h3><p>{state.error}</p><button type="button" className="button secondary" onClick={reloadData}>重试</button></div> : data ? <>
      {notice ? <p className="credit-notice" role="status">{notice}</p> : null}
      {pending && busy === "pending" ? <div className="credit-pending" role="alert"><strong>原操作结果待确认</strong><span>保持原幂等键、正文和对象；不会自动换键。</span><button type="button" className="button secondary" onClick={retryPending}>用原请求核对</button></div> : null}
      {pending && busy === "readback" ? <div className="credit-pending" role="alert"><strong>写入已接受，状态待读取</strong><span>只重新读取，不重复提交。</span><button type="button" className="button secondary" onClick={retryReadback}>重新读取</button></div> : null}
      <div className="credit-grid">
        <section className="account-module-card credit-score-card"><span className="credit-eyebrow">当前信用</span><strong className="credit-score">{data.credit?.score ?? "未知"}</strong><span className="credit-score-range">满分 100 · 低于 80 时号主发布/恢复接单需覆盖保证金</span>{data.credit ? <p>版本 {data.credit.revision} · 初始分通过制度事件留痕</p> : <p>信用初始化依据尚未读取，未知不按 100 分处理。</p>}</section>
        <section className="account-module-card credit-recovery-card"><div className="credit-card-heading"><div><h3>申请恢复 10 分</h3><p>需连续 7 天无新确认违约、期间有有效完成订单且无未处理责任。</p></div><ShieldCheck size={22} aria-hidden="true" /></div><textarea aria-label="恢复信用申请原因" value={reason} maxLength={500} placeholder="说明本次申请的背景（不替代审核依据）" onChange={(event) => setReason(event.target.value)} /><button type="button" className="button secondary" disabled={busy !== "" || reason.trim().length < 2} onClick={() => void submitRecovery()}>{busy === "recovery" ? "提交中…" : "提交恢复申请"}</button></section>
      </div>
      <section className="account-module-card credit-events"><div className="credit-card-heading"><div><h3>信用变动明细</h3><p>只展示本人可见原因、前后分数、时间和处置状态。</p></div></div>{data.credit?.events.length ? <ul>{data.credit.events.map((item) => <li key={item.id}><div><strong>{eventLabels[item.eventType] ?? "信用事件"}</strong><span>{item.visibleReason}</span><small>{new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small></div><b>{item.scoreBefore} → {item.scoreAfter}</b><em data-state={item.reversed ? "reversed" : "active"}>{item.reversed ? "已撤销" : "已记录"}</em></li>)}</ul> : <p className="credit-muted">暂无信用变动记录。</p>}</section>
      <section className="account-module-card credit-guarantees"><div className="credit-card-heading"><div><h3>出租账号保证金</h3><p>依据当前 STANDARD 公开租金与物资预付的 5% 计算，四舍五入到分、单账号封顶 ¥100。</p></div></div>{data.guarantees.length ? <div className="credit-guarantee-list">{data.guarantees.map((item) => <article key={`${item.accountId}:${item.priceVersionId}:${item.versionId}`}><div><strong>{item.displayNo ?? "出租账号"}</strong><span>{guaranteeLabels[item.state] ?? "状态未知"} · 信用 {item.score ?? "未知"}</span></div><dl><div><dt>计算基数</dt><dd>{creditMoney(item.baseCents)}</dd></div><div><dt>应缴</dt><dd>{creditMoney(item.requiredCents)}</dd></div><div><dt>状态依据</dt><dd>{item.reference ?? "尚无可核对收款依据"}</dd></div></dl>{item.state === "REQUIRED" ? <button type="button" className="button secondary" disabled={Boolean(busy) || Boolean(pending)} onClick={() => pay(item.accountId)}>记录缴纳意图</button> : null}{item.state === "PAYMENT_PENDING" ? <p className="credit-muted">支付已受理但未确认到账；不要重复付款，先查询原请求。</p> : null}{["REFUND_REQUESTED", "REFUND_PROCESSING"].includes(item.state) ? <p className="credit-muted">原路退款仍在受理或处理中，资金未显示为已退。</p> : null}{item.state === "REFUNDED" ? <p className="credit-muted">已记录原路退款成功；不转入钱包余额。</p> : null}{item.state === "SATISFIED" && item.reference?.startsWith("guarantee:") ? <button type="button" className="button quiet" disabled={Boolean(busy) || Boolean(pending)} onClick={() => refund(item.reference!.slice("guarantee:".length))}>申请原路退还</button> : null}</article>)}</div> : <p className="credit-muted">当前没有需要逐账号展示的保证金状态；低于 80 分后会按出租账号出现。</p>}</section>
      <section className="account-module-card credit-transactions"><div className="credit-card-heading"><div><h3>收款与原路退还进度</h3><p>每笔支付、退款和总账引用独立显示；未知不会被当成成功。</p></div></div>{data.transactions.length ? <ul>{data.transactions.map((item) => <li key={item.requirementId}><strong>{String(item.accountId)}</strong><span>最近状态：收款 {String(item.paymentStatus ?? "未创建")} · 退款 {String(item.refundStatus ?? "未申请")}</span><small>最近账务：收款 {String(item.paymentFinanceEventId ?? "未形成")} · 退款 {String(item.refundFinanceEventId ?? "未形成")}</small>{item.paymentHistory.length ? <details><summary>支付尝试 {item.paymentHistory.length} 笔</summary><ul>{item.paymentHistory.map((attempt) => <li key={attempt.id}><span>{String(attempt.status)} · {creditMoney(String(attempt.observedAmountCents ?? attempt.amountCents))}</span><small>支付单 {String(attempt.id)} · 商户单 {String(attempt.merchantOrderNo ?? "未生成")} · 原交易 {String(attempt.providerTransactionId ?? "未形成")}</small><small>账务 {String(attempt.financeEventId ?? "未形成")} · 分录 {String(attempt.ledgerEntryRef ?? "未形成")}</small></li>)}</ul></details> : null}{item.refundHistory.length ? <details><summary>退款尝试 {item.refundHistory.length} 笔</summary><ul>{item.refundHistory.map((attempt) => <li key={attempt.id}><span>{String(attempt.status)} · {creditMoney(attempt.amountCents)}</span><small>退款单 {String(attempt.id)} · 原支付 {String(attempt.paymentId)} · 原路单 {String(attempt.providerRefundId ?? "未形成")}</small><small>账务 {String(attempt.financeEventId ?? "未形成")} · 分录 {String(attempt.ledgerEntryRef ?? "未形成")}</small></li>)}</ul></details> : null}</li>)}</ul> : <p className="credit-muted">暂无收退款单据。</p>}</section>
    </> : null}
  </section>;
}
