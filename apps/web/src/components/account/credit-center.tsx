"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUserSession, useUserSessionStore } from "../session/user-session-provider";
import { Callout, RecoveryAlert, RecordStatus, SkeletonBlock } from "@/components/ui/information";
import { supplyApi, SupplyRequestError } from "../../lib/supply-client";
import { formatOrderTime } from "../../lib/order-client";
import { CreditRequestError, creditMoney, loadCreditWriteIntent, readMyCredit, type CreditGuarantee, type CreditOverview, type CreditWriteIntent } from "../../lib/credit-guarantee-client";
import "./credit-center.css";

/** 已获权账号摘要。用于给保证金责任提供可辨识名称；与信用主读取解耦，失败不阻塞。 */
type AccountSummary = { title: string | null; gameName: string | null };
type AccountSummaryState = { scope: string; entries: Record<string, AccountSummary>; failed: boolean; loading: boolean };

const SUMMARY_PAGE_LIMIT = "50";
const SUMMARY_MAX_PAGES = 6;

const eventLabels: Record<string, string> = { INITIALIZED: "初始信用", BREACH_CONFIRMED: "确认违约", BREACH_REVERSED: "撤销误判", RECOVERY_APPROVED: "审核恢复" };
const guaranteeLabels: Record<string, string> = { NOT_REQUIRED: "当前绑定无需缴纳", REQUIRED: "当前保证金责任待满足", PAYMENT_PENDING: "支付结果待确认", SATISFIED: "当前责任已覆盖", REFUND_REQUESTED: "退还申请待处理", REFUND_PROCESSING: "原路退还处理中", REFUNDED: "当前责任已退还", FAILED: "状态失败，需核对", UNKNOWN: "当前责任待确认" };
const recoveryLabels = { PENDING: "待处理", APPROVED: "已通过", REJECTED: "已驳回" };
/** 状态语义由服务端枚举决定，不从金额正负或字符串猜。 */
const guaranteeTone: Record<string, "success" | "info" | "warning" | "error" | "neutral" | "unknown"> = {
  NOT_REQUIRED: "neutral", REQUIRED: "warning", PAYMENT_PENDING: "info", SATISFIED: "success",
  REFUND_REQUESTED: "info", REFUND_PROCESSING: "info", REFUNDED: "success", FAILED: "error", UNKNOWN: "unknown",
};
const recoveryTone: Record<string, "success" | "info" | "error" | "unknown"> = { PENDING: "info", APPROVED: "success", REJECTED: "error" };
function attemptTone(value: unknown): "success" | "info" | "error" | "unknown" {
  return value === "CONFIRMED" || value === "SUCCEEDED" ? "success" : value === "FAILED" ? "error" : typeof value === "string" ? "info" : "unknown";
}
function recordTime(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? formatOrderTime(value, { timeZoneName: false }) : "时间暂未提供";
}
function attemptStatus(value: unknown, refund = false): string {
  const labels: Record<string, string> = refund
    ? { REQUESTED: "已申请退还", ACCEPTED: "退还已受理", PROCESSING: "原路退还处理中", SUCCEEDED: "服务端已确认本次退还", FAILED: "本次退还失败", UNKNOWN: "退还结果待确认" }
    : { REQUESTED: "已记录支付请求", ACCEPTED: "支付已受理", PROCESSING: "支付处理中", CONFIRMED: "服务端已确认收款", FAILED: "本次支付失败", UNKNOWN: "支付结果待确认" };
  return typeof value === "string" ? labels[value] ?? "状态待确认" : "状态待确认";
}
function channelStatus(value: unknown): string {
  return ({ NOT_SUBMITTED: "尚未提交通道", SUBMITTING: "正在提交通道", SUBMITTED: "已提交通道", ACCEPTED: "通道已受理", PROCESSING: "通道处理中", UNKNOWN: "通道结果待确认", FAILED: "通道提交失败", NOT_AUTHORIZED: "暂不可提交通道" } as Record<string, string>)[String(value)] ?? "通道状态待确认";
}
function observedMoney(value: unknown): string {
  return typeof value === "string" && /^(0|[1-9]\d{0,23})$/.test(value) ? creditMoney(value) : "待核定";
}
function businessNo(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "尚未提供";
}

function failureText(error: unknown): string {
  if (!(error instanceof CreditRequestError)) return "信用信息暂时无法读取，请稍后重试。";
  if (error.status === 0) return "网络连接失败，请检查连接后重试。";
  if (error.status === 401) return "登录状态已变化，请重新登录后继续。";
  if (error.status === 403) return "当前账号没有读取此信息的权限。";
  if (error.status === 409) return "状态已变化，请刷新后重新核对。";
  return "信用与保证金暂时无法读取，请稍后重试。";
}

export function CreditCenter({ scope }: { scope: string }) {
  const session = useUserSession();
  const store = useUserSessionStore();
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const current = () => { const latest = store.getSnapshot(); return latest.status === "authenticated" && latest.userId === session.userId && `${latest.userId}:${latest.identityVersion}` === scopeRef.current; };
  const [state, setState] = useState<{ scope: string; phase: "loading" | "ready" | "error"; data: CreditOverview | null; error: string }>({ scope, phase: "loading", data: null, error: "" });
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<CreditWriteIntent | null>(() => loadCreditWriteIntent(scope));
  const [summaries, setSummaries] = useState<AccountSummaryState>({ scope, entries: {}, failed: false, loading: false });

  const identityCurrent = current();
  const data = state.scope === scope && identityCurrent ? state.data : null;
  const phase = state.scope === scope && identityCurrent ? state.phase : "loading";
  const accountGroups = new Map<string, { displayNo: string | null; contexts: CreditGuarantee[] }>();
  for (const item of data?.guarantees ?? []) {
    const group = accountGroups.get(item.accountId) ?? { displayNo: null, contexts: [] };
    group.displayNo ??= item.displayNo;
    if (!group.contexts.some(context => context.versionId === item.versionId && context.priceVersionId === item.priceVersionId && context.releaseId === item.releaseId)) group.contexts.push(item);
    accountGroups.set(item.accountId, group);
  }
  // 收退记录引用的账号与保证金责任共用同一份已获权摘要，两个区域标签保持一致。
  const requiredAccountIds = [...new Set([...accountGroups.keys(), ...(data?.transactions ?? []).map(item => item.accountId)])].sort();
  const summaryKey = requiredAccountIds.join(",");


  useEffect(() => {
    const controller = new AbortController();
    setState({ scope, phase: "loading", data: null, error: "" });
    setPending(loadCreditWriteIntent(scope));
    if (!current()) return () => controller.abort();
    readMyCredit(controller.signal).then((data) => {
      if (controller.signal.aborted || scopeRef.current !== scope || !current()) return;
      if (data.credit && data.credit.userId !== session.userId) { setState({ scope, phase: "error", data: null, error: "登录身份已变化，请重新确认后读取。" }); session.revalidate(); return; }
      setState({ scope, phase: "ready", data, error: "" });
    }, (error: unknown) => {
      if (controller.signal.aborted || scopeRef.current !== scope || !current()) return;
      setState({ scope, phase: "error", data: null, error: failureText(error) });
      if (error instanceof CreditRequestError && error.status === 401) session.revalidate();
    });
    return () => controller.abort();
  }, [reload, scope, session]);

  // F1：账号可辨识名称。有界分页读取已获权账号摘要，覆盖所需 accountId 即停，禁止逐账号 N+1。
  // 与信用主读取解耦：摘要失败不阻塞主读取，身份/scope 变化即整体清理。
  useEffect(() => {
    const controller = new AbortController();
    const needed = summaryKey ? summaryKey.split(",") : [];
    // 本轮没有可接受的过期策略：任何一次“不再是这份权威结果”的情形都中性清空，绝不沿用旧摘要。
    const clear = () => setSummaries((previous) => (previous.scope === scope ? { scope, entries: {}, failed: false, loading: false } : previous));
    if (!current()) return () => controller.abort();
    if (!needed.length) { clear(); return () => controller.abort(); }
    setSummaries((previous) => (previous.scope === scope ? { ...previous, loading: true } : { scope, entries: {}, failed: false, loading: true }));
    void (async () => {
      const collected: Record<string, AccountSummary> = {};
      try {
        let cursor: string | null = null;
        for (let page = 0; page < SUMMARY_MAX_PAGES; page += 1) {
          const params = new URLSearchParams({ limit: SUMMARY_PAGE_LIMIT });
          // F1：/me/accounts 以 after（上页末 id）翻页；参数名错会重复首页而不是前进。
          if (cursor) params.set("after", cursor);
          const result = await supplyApi.myAccounts(params, controller.signal);
          for (const row of result.items) collected[row.id] = { title: row.title, gameName: row.game_name };
          cursor = result.nextCursor;
          if (!cursor || needed.every((id) => id in collected)) break;
        }
        if (controller.signal.aborted || scopeRef.current !== scope || !current()) return;
        // 成功也用本轮结果整体覆盖，不做 previous∩collected 之类的无限合并。
        setSummaries((previous) => (previous.scope === scope ? { scope, entries: collected, failed: false, loading: false } : previous));
      } catch (error) {
        if (controller.signal.aborted || scopeRef.current !== scope || !current()) return;
        // 摘要与信用读取是两种授权：403 只撤下摘要，401 走既有身份刷新路径。
        const status = error instanceof SupplyRequestError ? error.status : 0;
        if (status === 401) session.revalidate();
        setSummaries((previous) => (previous.scope === scope ? { scope, entries: {}, failed: true, loading: false } : previous));
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryKey, scope, reload]);

  /** 优先复用已获权账号摘要的名称；编号有值时辅助显示；缺名称时中性降级，不暴露内部ID、不伪造业务号。 */
  const accountHeading = (accountId: string) => {
    const summary = summaries.scope === scope ? summaries.entries[accountId] : undefined;
    const title = summary?.title?.trim() || null;
    const gameName = summary?.gameName?.trim() || null;
    const displayNo = accountGroups.get(accountId)?.displayNo?.trim() || null;
    const secondary = [gameName, title && displayNo ? `编号 ${displayNo}` : null].filter(Boolean).join(" · ");
    return {
      primary: title ?? displayNo ?? "出租账号",
      secondary: secondary || (title || displayNo ? null : "该账号暂无可显示的公开名称"),
      named: Boolean(title || displayNo),
    };
  };
  const score = data?.credit?.score;
  const scoreKnown = typeof score === "number";
  const reloadData = () => setReload((value) => value + 1);

  return <section className="account-module credit-center" aria-labelledby="credit-center-heading">
    <header className="account-module-heading"><div><h2 id="credit-center-heading">信用与保证金</h2><p>查看信用变化与出租账号保证金，资金处理以每笔记录为准。</p></div><button type="button" className="button quiet" disabled={phase === "loading"} onClick={reloadData}><RefreshCw size={15} aria-hidden="true" />刷新</button></header>
    {identityCurrent && pending?.subject === scope ? <div className="credit-pending" role="status"><strong>{pending.phase === "readback" ? "原操作已接受，最新状态待读取" : "原操作结果待确认"}</strong><span>原记录已保留；重新读取不会重复提交。</span></div> : null}
    {phase === "loading" ? <div className="account-module-card credit-loading"><SkeletonBlock label="正在读取信用状态" lines={4} /></div> : phase === "error" ? <RecoveryAlert tone="error" live title="信用信息暂时无法读取" problem={state.error}
      impact="未确认的信用分与保证金不会按零展示，也不会被读成无需缴纳。"
      action={<button type="button" className="button secondary" onClick={reloadData}>重试</button>}
      details={{ summary: "这会影响已有记录吗？", body: "不会修改任何信用或资金记录。这里只是读取状态；已保存的原操作结果与恢复责任保持不变。" }} /> : data ? <>
      <section className="account-module-card credit-summary" aria-labelledby="credit-summary-heading">
        <div className="credit-summary-score"><h3 id="credit-summary-heading">当前信用</h3>
          {scoreKnown ? <div className="credit-gauge" data-state={score === 100 ? "full" : "known"} role="meter" aria-label="信用分" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-valuetext={`${score}分，满分100分`}>
            <svg viewBox="0 0 148 82" aria-hidden="true"><path className="credit-gauge-track" d="M14 66 A60 60 0 0 1 134 66" pathLength="100" /><path className="credit-gauge-fill" d="M14 66 A60 60 0 0 1 134 66" pathLength="100" strokeDasharray={`${score} 100`} /><text x="14" y="80">0</text><text x="134" y="80">100</text></svg>
            <strong className="strip-credit-number">{score}<small>分</small></strong>
          </div> : <p className="credit-score-unknown" role="status">信用分待确认</p>}
        </div>
        <dl className="credit-summary-facts"><div><dt>保证金责任</dt><dd>按出租账号分别查看</dd><small>不与租客押金或钱包余额混用。</small></div><div><dt>交易准入</dt><dd>以具体业务核验为准</dd><small>信用分不代表可以交易或无需保证金。</small></div><div><dt>信用恢复</dt><dd>查看下方申请记录</dd><small>申请资格与可申请时间暂未提供。</small></div></dl>
      </section>
      <section className="account-module-card credit-events"><div className="credit-card-heading"><div><h3>信用变动明细</h3><p>本人可见的原因、分数变化与记录状态。</p></div></div>{data.credit?.events.length ? <ul>{data.credit.events.map((item) => <li key={item.id}><div><strong>{eventLabels[item.eventType] ?? "信用事件"}</strong><span>{item.visibleReason}</span><small>{recordTime(item.createdAt)}</small></div><b>{item.scoreBefore} → {item.scoreAfter}</b><em data-state={item.reversed ? "reversed" : "active"}><RecordStatus tone={item.reversed ? "neutral" : "info"}>{item.reversed ? "已撤销" : "已记录"}</RecordStatus></em></li>)}</ul> : <p className="credit-muted">{data.credit ? "暂无信用变动记录。" : "信用变动记录暂未确认。"}</p>}</section>
      <section className="account-module-card credit-guarantees"><div className="credit-card-heading"><div><h3>出租账号保证金</h3><p>同一账号的责任放在一起查看，多项责任不代表多笔实缴。</p></div></div>
        {accountGroups.size ? <div className="credit-guarantee-list">{[...accountGroups].map(([accountId, group]) => { const heading = accountHeading(accountId); return <article key={accountId} data-account-id={accountId}>
          <header><h4><Link href={`/account?view=accounts&accountId=${encodeURIComponent(accountId)}`} scroll={false}>{heading.primary}</Link></h4><span className="credit-account-meta">{[heading.secondary, group.contexts.length > 1 ? `${group.contexts.length} 项保证金责任` : null].filter(Boolean).join(" · ")}</span></header>
          {group.contexts.map(item => <div className="credit-responsibility" key={`${item.versionId}:${item.priceVersionId}:${item.releaseId}`}>
            <div className="credit-responsibility-heading"><strong><RecordStatus tone={guaranteeTone[item.state] ?? "unknown"}>{guaranteeLabels[item.state] ?? "状态未知"}</RecordStatus></strong><span>信用 {item.score ?? "待确认"}</span></div>
            <dl><div><dt>计算基数</dt><dd>{creditMoney(item.baseCents)}</dd></div><div><dt>当前应缴要求</dt><dd>{item.state === "UNKNOWN" ? "待核定" : creditMoney(item.requiredCents)}</dd></div><div><dt>责任说明</dt><dd>{item.reasonCode === "PAYMENT_UNDERPAID" ? "已确认收款尚未覆盖当前要求" : item.state === "NOT_REQUIRED" ? "当前责任无需缴纳，不代表已缴或已退。" : item.state === "REQUIRED" ? "责任尚未满足，不代表已经扣款。" : item.state === "SATISFIED" ? "服务端已确认本责任覆盖，不代表钱包收入。" : guaranteeLabels[item.state] ?? "待确认"}</dd></div></dl>
            {item.state === "PAYMENT_PENDING" ? <p className="credit-muted">{attemptStatus(item.paymentState)} · {channelStatus(item.paymentProviderState)}，支付结果仍待确认。</p> : null}
            {["REFUND_REQUESTED", "REFUND_PROCESSING"].includes(item.state) ? <p className="credit-muted">原路退还仍在处理，尚无到账确认。</p> : null}
            {item.state === "REFUNDED" ? <p className="credit-muted">服务端已记录本责任退还，不代表全部历史资金已退清。</p> : null}
          </div>)}
        </article>; })}</div> : <p className="credit-muted">暂无可展示的账号保证金责任；不据此判断所有账号都无需缴纳。</p>}
      </section>
      <section className="account-module-card credit-transactions">
        <div className="credit-card-heading"><div><h3>收款与原路退还进度</h3><p>保留每次处理记录；申请金额、实收金额和退还结果分别展示。</p></div></div>
        {data.transactions.length ? <ul>{data.transactions.map(item => <li key={item.requirementId}>
          <strong><Link href={`/account?view=accounts&accountId=${encodeURIComponent(item.accountId)}`} scroll={false}>{accountHeading(item.accountId).primary}</Link></strong>
          <span><RecordStatus tone={attemptTone(item.paymentStatus)}>最近收款：{attemptStatus(item.paymentStatus)}</RecordStatus> · <RecordStatus tone={attemptTone(item.refundStatus)}>最近退还：{attemptStatus(item.refundStatus, true)}</RecordStatus></span>
          {item.paymentHistory.length ? <details><summary>支付尝试 {item.paymentHistory.length} 笔</summary><ul>{item.paymentHistory.map(attempt => <li key={attempt.id}>
            <span><RecordStatus tone={attemptTone(attempt.status)}>{attemptStatus(attempt.status)}</RecordStatus> · {channelStatus(attempt.providerRequestState)}</span>
            <div className="credit-attempt-amounts"><span>申请金额<strong>{creditMoney(attempt.amountCents)}</strong></span><span>已观察收款金额<strong>{observedMoney(attempt.observedAmountCents)}</strong></span></div>
            <small>支付业务单号：{businessNo(attempt.merchantOrderNo)} · 创建时间：{recordTime(attempt.createdAt)}</small>
          </li>)}</ul></details> : <p className="credit-muted">暂无支付尝试记录。</p>}
          {item.refundHistory.length ? <details><summary>退款尝试 {item.refundHistory.length} 笔</summary><ul>{item.refundHistory.map(attempt => <li key={attempt.id}>
            <span><RecordStatus tone={attemptTone(attempt.status)}>{attemptStatus(attempt.status, true)}</RecordStatus></span>
            <div className="credit-attempt-amounts"><span>申请退还金额<strong>{creditMoney(attempt.amountCents)}</strong></span><span>已观测到账金额<strong>暂未提供</strong></span></div>
            <small>原支付业务单号：{businessNo(item.paymentHistory.find(payment => payment.id === attempt.paymentId)?.merchantOrderNo)}</small>
            <small>退还审核：{({ OWNER_DECISION_REQUIRED: "等待处理", APPROVED: "已通过", REJECTED: "已驳回" } as Record<string, string>)[String(attempt.releasePolicyState)] ?? "待确认"} · 创建时间：{recordTime(attempt.createdAt)}</small>
            <small>用户退款单号、处理理由及完成时间暂未提供；创建时间不是到账时间。</small>
          </li>)}</ul></details> : <p className="credit-muted">暂无退还尝试记录。</p>}
        </li>)}</ul> : <p className="credit-muted">暂无收退款单据。</p>}
      </section>
      <section className="account-module-card credit-events credit-recovery-records" aria-labelledby="credit-recovery-records">
        <div className="credit-card-heading"><h3 id="credit-recovery-records">我的信用恢复申请</h3></div><Callout title="恢复申请的范围">申请资格与可申请时间当前没有读取来源，本页不据此推算，也不提供提交入口。下方逐笔保留你提交的申请内容、处理理由与状态。</Callout>
        {data.recoveryRequests.length ? <ul>{data.recoveryRequests.map(item => <li key={item.id}>
          <div><strong>申请内容：{item.reason}</strong><span>处理理由：{item.status === "PENDING" ? "等待处理" : item.decisionReason ?? "暂未提供"}</span><small>申请时间：{recordTime(item.createdAt)}</small><small>处理时间：{item.status === "PENDING" ? "等待处理" : recordTime(item.decidedAt)}</small></div>
          <em data-state={item.status}><RecordStatus tone={recoveryTone[item.status] ?? "unknown"}>{recoveryLabels[item.status]}</RecordStatus></em>
        </li>)}</ul> : <p className="credit-muted">暂无恢复申请记录。</p>}
      </section>
    </> : null}
  </section>;
}
