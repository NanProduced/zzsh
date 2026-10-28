"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleSlash, Clock3, Copy, Gamepad2, MessageCircle, RefreshCw, UserRound, WalletCards, XCircle } from "lucide-react";
import { formatOrderMoney, formatOrderTime as timeText, orderApi, OrderRequestError, type Order, type OrderParty, type OrderStatusFilter, type PersonalAbnormalResponsibility, type PersonalFirstSubmit, type PersonalRefundBasis, type PersonalRefundIntent, type PersonalRefundRead } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { unitHint, unitLabel, orderAccountTitle } from "@/lib/order-display";
import { OrderTradeActions, type OrderStageFacts } from "@/components/order/order-trade-actions";
import { OrderError, OrderStatusBadge, orderTermLabel, orderUrl, statusLabel } from "@/components/order/order-presentation";
import "./order.css";

type DetailState = { status: "loading" } | { status: "ready"; order: Order | null; error: OrderRequestError | null } | { status: "error"; error: OrderRequestError | null };

/** What still needs a decision from the reader. The order's own state lives in the identity band. */
type Attention = { tone: "info" | "warning"; title: string; note: string; actions: Array<"retry" | "group" | "browse" | "manage"> } | null;

function attentionFor(order: Order, facts: OrderStageFacts | null, readFailed: boolean, party: OrderParty): Attention {
  if (facts?.phase === "DECISION_REJECTED") {
    return {
      tone: "warning",
      title: `你已拒绝第${facts.settlementVersionNo ?? "?"}版结算`,
      note: "拒绝不会使这一版生效；服务端会按新的期末数据或人工调整生成新版本，之后再按最新版本重新核对。",
      actions: ["group"],
    };
  }
  if (facts?.phase === "DECISION_PENDING") {
    return { tone: "warning", title: "待你确认结算", note: "请核对本次消耗、费用承担与责任归属；拒绝不等于确认。确认入口在下方结算区。", actions: [] };
  }
  if (facts?.phase === "INTAKE_PENDING") {
    return { tone: "info", title: "结束申请待客服处理", note: "已提交期末数据，等待受权客服核实原因并复核；复核与双方确认完成后结算生效。", actions: [] };
  }
  if (facts?.phase === "DECISION_WAITING") {
    return { tone: "info", title: "等待对方确认结算", note: "你已在这一版完成操作；金额或版本变化会生成新版本并要求重新确认。", actions: [] };
  }
  if (order.status === "CANCELLED") {
    return {
      tone: "info",
      title: "账号占用已解除",
      note: "本单不再产生新的交易动作；已确认的订单信息仍可查看。",
      actions: [party === "renter" ? "browse" : "manage"],
    };
  }
  if (order.status === "COMPLETED" || order.status === "PAID") {
    // While the read is still in flight nothing is missing yet; only a real failure is a gap.
    if (facts || !readFailed) return null;
    return {
      tone: "warning",
      title: order.status === "COMPLETED" ? "结算明细暂时读不到" : "开租与结算明细暂时读不到",
      note: "订单状态仍然有效，已展示的金额与时间不受影响；消耗、费用与退款要读到结算记录才能确认。",
      actions: ["retry", "group"],
    };
  }
  return null;
}

function AttentionBlock({ attention, party, orderId, onRetry }: { attention: Attention; party: OrderParty; orderId: string; onRetry: () => void }) {
  if (!attention) return null;
  return <section className={`order-attention is-${attention.tone}`} role="status">
    <div className="order-attention-copy">
      <h2>{attention.title}</h2>
      <p>{attention.note}</p>
    </div>
    {/* One cluster. Talking to the person who fulfils the order is the primary move; trying the read
        again is a link, not a second button competing with it. */}
    <div className="order-attention-actions">
      {attention.actions.includes("group") ? <button type="button" className="button primary button--sm" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群列表</button> : null}
      {attention.actions.includes("browse") ? <Link href="/accounts" className="button primary button--sm">浏览可租账号</Link> : null}
      {attention.actions.includes("manage") ? <Link href="/account?view=accounts" className="button primary button--sm">管理出租账号</Link> : null}
      {attention.actions.includes("retry") ? <button type="button" className="order-attention-link" onClick={onRetry}>重试读取</button> : null}
    </div>
  </section>;
}

/**
 * The order's own history, in the order things happened. Identity facts live in the identity band
 * above, so nothing here repeats them.
 */
function OrderTimeline({ order, facts, party }: { order: Order; facts: OrderStageFacts | null; party: OrderParty }) {
  const events: Array<{ key: string; label: string; time: string | null; state: "done" | "closed" | "pending" }> = [
    { key: "created", label: "下单", time: order.createdAt ?? null, state: "done" },
  ];
  if (order.paidAt) events.push({ key: "paid", label: "支付确认", time: order.paidAt ?? null, state: "done" });
  if (facts?.openingConfirmedAt) events.push({ key: "opened", label: "开租确认", time: facts.openingConfirmedAt, state: "done" });
  if (facts?.postedAt) events.push({ key: "posted", label: "结算生效", time: facts.postedAt, state: "done" });
  if (order.cancelledAt) {
    events.push({
      key: "cancelled",
      label: `取消${order.cancelReason === "USER" ? "（租客取消）" : order.cancelReason === "TIMEOUT" ? "（到期未支付）" : ""}`,
      time: order.cancelledAt ?? null,
      state: "closed",
    });
  }
  return <section className="order-detail-section order-timeline-block">
    <h2 className="order-section-title">订单进度</h2>
    <ol className="order-timeline">
      {events.map((event) => <li key={event.key} data-state={event.state}>
        <span className="order-timeline-dot" aria-hidden="true" />
        <strong>{event.label}</strong>
        <time>{event.time ? timeText(event.time) : "待确认"}</time>
      </li>)}
    </ol>
  </section>;
}

function CopyOrderNo({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className="order-copy-button" onClick={() => void copy()} aria-label={`复制订单号 ${value}`}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "已复制" : "复制"}</button>;
}

function OrderLines({ order, party }: { order: Order; party: OrderParty }) {
  const lines = order.quote?.lines ?? [];
  if (lines.length === 0) return <p className="order-muted">费用明细暂时无法读取。</p>;
  return <>
    <div className="order-table-wrap">
      <table><thead><tr><th scope="col">资源</th><th scope="col">数量</th><th scope="col">{party === "owner" ? "号主报价" : "金额"}</th></tr></thead>
        <tbody>{lines.map((line, index) => <tr key={`${line.itemId ?? line.name ?? line.unit ?? "line"}-${index}`}>
          <td>{line.name ?? unitLabel(line.unit) ?? "资源待确认"}</td>
          <td>{line.quantity ?? line.unitQuantity ?? "数量待确认"}{unitHint(line.name ?? "", line.unit) ? ` ${unitHint(line.name ?? "", line.unit)}` : ""}</td>
          <td>{formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {order.quote?.unitAmountsInformational ? <p className="order-lines-note">明细为下单时的费用记录，最终金额请查看结算明细。</p> : null}
  </>;
}

/** Each party sees its own quoted amounts; a missing owner total stays unknown instead of borrowing the renter's. */
function linesSummary(order: Order, party: OrderParty): string {
  const lines = order.quote?.lines ?? [];
  const parts = lines.map((line) => `${line.name ?? unitLabel(line.unit) ?? "资源"} ${formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}`);
  if (party === "owner") parts.push(order.quote?.ownerTotal ? `合计 ${formatOrderMoney(order.quote.ownerTotal)}` : "合计待确认");
  else parts.push(`合计 ${formatOrderMoney(order.amounts?.rental)}`);
  return parts.join(" · ");
}

/**
 * The rail answers "what is this transaction worth to me", and it only ever shows the reading party's
 * own money. The two sides are different numbers — a renter may pay less through a discount, and an
 * owner is quoted at listing time — so stacking both in one card manufactures a contradiction that
 * was never in the data. Owner sees the listing quote and the owner settlement; renter sees what they
 * paid and the renter settlement.
 */
/** The renter-side figure's name for the reading party, never implying a charge that did not happen. */
function renterFigureLabel(order: Order): string {
  if (order.status === "CANCELLED") return "下单时租客金额";
  return order.paidAt ? "租客已付" : "租客应付";
}

function AmountCard({ order, party, facts, readFailed }: { order: Order; party: OrderParty; facts: OrderStageFacts | null; readFailed: boolean }) {
  const amounts = order.amounts;
  const closed = order.status === "CANCELLED";
  const paid = Boolean(order.paidAt);
  const posted = facts?.phase === "POSTED" && facts.settled && facts.settled.text !== "—" ? facts.settled : null;
  const settledUnread = order.status === "COMPLETED" && !posted;

  if (party === "owner") {
    return <section className="order-side-card order-amount-block">
      <h2 className="order-section-title">号主侧金额</h2>
      {posted
        ? <><strong className="order-amount-total">{posted.text}</strong><p className="order-amount-label">{posted.label}</p></>
        : settledUnread
          ? <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>
          : <><strong className="order-amount-total">{formatOrderMoney(order.quote?.ownerTotal)}</strong><p className="order-amount-label">下单时号主报价</p></>}
      {posted || settledUnread ? <dl className="order-facts order-amount-rows">
        <div><dt>下单时号主报价</dt><dd>{formatOrderMoney(order.quote?.ownerTotal)}</dd></div>
      </dl> : null}
      <p className="order-muted">{posted ? "最终以结算记录为准；报价不代表已赚取或可提现。" : "按上架时约定的报价展示，不代表已赚取或可提现。"}</p>
    </section>;
  }

  const lead = settledUnread ? null : posted ?? {
    label: closed ? "下单金额" : order.status === "PENDING_PAYMENT" ? "待支付" : "租客已付",
    text: formatOrderMoney(amounts?.totalDue),
  };
  return <section className="order-side-card order-amount-block">
    <h2 className="order-section-title">租客侧金额</h2>
    {lead ? <><strong className="order-amount-total">{lead.text}</strong><p className="order-amount-label">{lead.label}</p></>
      : <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>}
    {posted || settledUnread ? <dl className="order-facts order-amount-rows">
      <div><dt>{renterFigureLabel(order)}</dt><dd>{formatOrderMoney(amounts?.totalDue)}</dd></div>
    </dl> : null}
    <dl className="order-facts order-amount-parts">
      <div><dt>{paid && !closed ? "租赁预付" : "租赁费用"}</dt><dd>{formatOrderMoney(amounts?.rental)}</dd></div>
      <div><dt>租客押金</dt><dd>{formatOrderMoney(amounts?.deposit)}</dd></div>
    </dl>
    {closed ? <p className="order-muted">本金额为下单时的订单快照，不代表已扣款或应退款。</p> : null}
    {paid || order.status === "COMPLETED" ? <p className="order-side-link"><WalletCards size={14} aria-hidden="true" />退款到账结果待确认时，可在<Link href="/account?view=wallet" scroll={false}>我的钱包</Link>查看实际记录。</p> : null}
  </section>;
}

function ContactCard({ order, party, onChanged, quiet }: { order: Order; party: OrderParty; onChanged: () => void; quiet: boolean }) {
  if (!order.fulfillmentAssignment) return null;
  const value = order.fulfillmentAssignment;
  const copy = value.state === "WAITING"
    ? value.waitingReason === "NO_ELIGIBLE_STAFF" ? "当前暂无可用客服，正在等待平台调度。" : "等待客服分配；分配与建群都不等于开租。"
    : value.state === "ASSIGNED" && value.teamReady ? "订单群已就绪，可在订单群中与客服、对方核对交付事项。"
    : value.state === "ASSIGNED" ? "客服已分配，订单群准备中。" : "履约状态待确认。";
  return <section className="order-side-card">
    <h2 className="order-section-title">履约与沟通</h2>
    <p className="order-contact-copy"><MessageCircle size={16} aria-hidden="true" />{copy}</p>
    {quiet ? null : <div className="order-contact-actions">
      <button type="button" className="button secondary" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId: order.id } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群</button>
      <button type="button" className="button quiet" onClick={onChanged}><RefreshCw size={15} aria-hidden="true" />刷新订单</button>
    </div>}
  </section>;
}

const refundOutcomeCopy: Record<PersonalRefundRead["outcome"], { label: string; note: string }> = {
  RESPONSIBILITY_NOT_POSTED: { label: "本地尚无过账退款责任", note: "这只表示本地尚未形成过账退款责任，不代表渠道未收款、订单无需退款或已经退款。" },
  ZERO_RESPONSIBILITY: { label: "本地退款责任为 0", note: "过账记录的租客退款责任为 0 元；这不代表已经退款或银行已到账。" },
  NOT_DUE: { label: "退款责任尚未到期", note: "责任已过账但尚未到到期日；未到期不代表退款处理中。" },
  NO_INTENT: { label: "本地尚无退款申请记录", note: "已到期仍有剩余责任，但本地登记范围没有退款申请；这不代表渠道没有记录。" },
  PARTIALLY_ALLOCATED: { label: "部分责任已分配", note: "只表示本地已为退款申请分配责任，不代表渠道退款或银行到账。" },
  FULLY_ALLOCATED: { label: "责任已全部分配", note: "只表示本地已为退款申请分配责任，不代表退款已执行或到账。" },
  PARTIALLY_CONSUMED: { label: "本地已部分核销", note: "只表示本地账务已有核销记录，不代表渠道退款或银行到账。" },
  FULLY_CONSUMED: { label: "本地已全部核销", note: "只表示本地账务核销等于原责任，不代表渠道退款或银行到账。" },
  RELEASED: { label: "本地分摊已释放", note: "本地记录为未执行且已释放分摊；不代表退款失败已关闭或无需退款。" },
  PROCESSING: { label: "退款申请处理中", note: "本地存在处理中的退款申请，结果尚未确认。" },
  UNKNOWN: { label: "退款申请结果未知", note: "本地存在结果未知的退款申请，不能视为成功或失败。" },
  REVIEW_REQUIRED: { label: "退款记录需要人工核对", note: "本地记录需要人工核对，不代表已经退款。" },
  TRUNCATED: { label: "退款申请记录不完整", note: "本地退款申请超过展示上限；以下记录与合计不能当作全部。" },
  CONFLICT: { label: "退款记录存在冲突", note: "本地记录存在冲突或不可读项；受影响的合计与字段不可用，其他合法过账或异常原款仍分别展示。" },
};
const refundIntentStateLabel: Record<PersonalRefundIntent["state"], string> = {
  READY: "待提交", SUBMITTING: "正在提交", UNKNOWN: "结果未知", PROCESSING: "处理中", REVIEW_REQUIRED: "需要人工核对", SUCCEEDED: "本地成功记录", FAILED: "本地失败记录", UNRECOGNIZED: "状态未知",
};
const refundDispositionLabel: Record<PersonalRefundIntent["budgetDisposition"], string> = { ALLOCATED: "已分配", CONSUMED: "已核销", RELEASED: "已释放", UNRECOGNIZED: "分摊状态未知" };
const refundSourceLabel: Record<PersonalRefundIntent["source"], string> = { LOCAL_CONTROLLED: "本地受控", JOINPAY_FORMAL: "汇聚正式", UNRECOGNIZED: "来源未知" };
const refundBasisLabel: Record<PersonalRefundBasis, string> = { POSTING: "正常过账", REVIEW_CONFIRMATION: "异常收款确认" };
const abnormalReasonLabel: Record<PersonalAbnormalResponsibility["reasonCode"], string> = { DUPLICATE_PAYMENT: "重复支付", LATE_PAYMENT: "迟到的支付", UNKNOWN_REASON: "异常原因未知" };
const abnormalStateLabel: Record<PersonalAbnormalResponsibility["state"], string> = {
  NO_INTENT: "尚无退款申请", READY: "待处理", PROCESSING: "处理中", UNKNOWN: "状态未知", CONSUMED: "本地已核销", RELEASED: "本地已释放", REVIEW_REQUIRED: "需要人工核对", CONFLICT: "关联异常",
};
const firstSubmitLabel: Record<NonNullable<PersonalFirstSubmit["blockedReason"]>, string> = {
  ORIGINAL_ORDER_NO_AMBIGUOUS: "原订单号不唯一", ABNORMAL_BASIS_REVIEW: "异常原款复核",
};

function firstSubmitText(value: PersonalFirstSubmit | null | undefined): string | null {
  if (!value) return null;
  if (value.dispatch === "DISPATCHED") return "已有提交尝试，是否送达/到账未核实";
  if (value.dispatch === "UNKNOWN") return "提交状态未知";
  if (value.blockedReason) return `本地复核：${firstSubmitLabel[value.blockedReason]}，从未派发${value.blockedAt ? `（${timeText(value.blockedAt, { timeZoneName: false })}）` : ""}`;
  return "待派发，尚未向渠道提交";
}

function refundMoney(cents: string | null): string {
  if (cents === null) return "待确认";
  const value = BigInt(cents);
  return `¥${(value / 100n).toLocaleString("zh-CN")}.${(value % 100n).toString().padStart(2, "0")}`;
}

function refundDueLabel(dueState: PersonalRefundRead["responsibility"]["dueState"]): string {
  return dueState === "DUE" ? "已到期" : dueState === "NOT_DUE" ? "未到期" : "到期状态待确认";
}

function refundEmptyCopy(read: PersonalRefundRead): string {
  if (read.outcome === "RESPONSIBILITY_NOT_POSTED") return "本地尚无过账退款责任，因此没有可展示的退款申请记录。";
  if (read.outcome === "ZERO_RESPONSIBILITY") return "本地退款责任为 0，因此没有退款申请记录。";
  if (read.outcome === "NOT_DUE") return "退款责任尚未到期，本地暂无退款申请记录。";
  if (read.outcome === "NO_INTENT") return "本地登记范围内没有退款申请记录；这不表示渠道没有记录。";
  return "本地登记范围内没有可展示的退款申请记录。";
}

function AbnormalResponsibilityCard({ item }: { item: PersonalAbnormalResponsibility }) {
  const submit = firstSubmitText(item.firstSubmit);
  const amountsReadable = item.totalsComplete && item.originalCents !== null;
  return <li className="order-refund-intent order-refund-abnormal-item">
    <div className="order-refund-intent-head">
      <strong>异常原款 · {abnormalReasonLabel[item.reasonCode]}</strong>
      <span className="order-refund-state">{abnormalStateLabel[item.state]}</span>
    </div>
    {amountsReadable ? <dl className="order-facts order-refund-intent-facts">
      <div><dt>原款责任</dt><dd>{refundMoney(item.originalCents)}</dd></div>
      <div><dt>已分配</dt><dd>{refundMoney(item.allocatedCents)}</dd></div>
      <div><dt>本地已核销</dt><dd>{refundMoney(item.consumedCents)}</dd></div>
      <div><dt>已释放</dt><dd>{refundMoney(item.releasedCents)}</dd></div>
      <div><dt>尚未分配</dt><dd>{refundMoney(item.remainingCents)}</dd></div>
      <div><dt>本地申请</dt><dd>{item.intentIds.length ? `${item.intentIds.length} 笔` : "尚无申请"}</dd></div>
    </dl> : <p className="order-muted">该原款关联异常或合计不完整，金额/合计不可用；其他合法原款仍分别展示。</p>}
    {submit ? <p className="order-refund-submit">{submit}</p> : null}
    {item.reasonCodes.length ? <details className="order-refund-reasons"><summary>查看这笔责任的原因代码</summary><p>{item.reasonCodes.join("、")}</p></details> : null}
  </li>;
}

function ResponsibilityTotals({ read }: { read: PersonalRefundRead }) {
  const totals = read.responsibilityTotals;
  if (!totals) return null;
  return <section className="order-refund-totals" aria-label="唯一责任合计">
    <div className="order-refund-intents-heading"><h3>唯一责任合计</h3><span>{totals.totalsComplete ? "本地登记范围" : "合计不完整"}</span></div>
    {totals.totalsComplete ? <dl className="order-facts order-refund-amounts">
      <div><dt>唯一原责任</dt><dd>{refundMoney(totals.originalCents)}</dd></div>
      <div><dt>已分配（含已核销）</dt><dd>{refundMoney(totals.allocatedCents)}</dd></div>
      <div><dt>本地已核销</dt><dd>{refundMoney(totals.consumedCents)}</dd></div>
      <div><dt>已释放</dt><dd>{refundMoney(totals.releasedCents)}</dd></div>
      <div><dt>尚未分配</dt><dd>{refundMoney(totals.remainingCents)}</dd></div>
      <div><dt>其中过账 / 异常原款</dt><dd>{totals.postingOriginalCents === null ? "未形成过账责任" : refundMoney(totals.postingOriginalCents)} / {totals.abnormalOriginalCents === null ? "未登记异常责任" : refundMoney(totals.abnormalOriginalCents)}（{totals.abnormalConfirmationCount} 笔异常）</dd></div>
    </dl> : <div className="order-notice is-warning" role="alert"><CircleSlash size={17} aria-hidden="true" /><div><strong>唯一责任合计不完整</strong><span>缺失或冲突项不按 0 计算；请查看下方每个正常过账或异常原款的独立状态，不能把局部金额当完整应退。</span></div></div>}
  </section>;
}

function RefundIntentCard({ intent }: { intent: PersonalRefundIntent }) {
  const evidence = intent.savedChannelEvidence;
  const reasons = [...new Set([...intent.reasonCodes, ...intent.localAccounting.reasonCodes, ...intent.channelFacts.reasonCodes])];
  return <li className="order-refund-intent">
    <div className="order-refund-intent-head">
      <strong>{intent.refundOrderNo ?? "原退款号未提供"}</strong>
      <span className="order-refund-state">{refundIntentStateLabel[intent.state]}</span>
    </div>
    <dl className="order-facts order-refund-intent-facts">
      <div><dt>申请金额</dt><dd>{intent.amount ? refundMoney(intent.amount.cents) : "待确认"}</dd></div>
      <div><dt>本地分摊</dt><dd>{refundDispositionLabel[intent.budgetDisposition]}</dd></div>
      <div><dt>来源</dt><dd>{refundSourceLabel[intent.source]}{intent.evidenceLevel ? ` · ${intent.evidenceLevel}` : ""}</dd></div>
      {intent.basisKind ? <div><dt>责任依据</dt><dd>{refundBasisLabel[intent.basisKind]}</dd></div> : null}
      {intent.firstSubmit ? <div><dt>提交状态</dt><dd>{firstSubmitText(intent.firstSubmit)}</dd></div> : null}
      {intent.requiresReview ? <div><dt>人工核对</dt><dd>需要</dd></div> : null}
      {evidence ? <div><dt>本地保存的渠道回执（未重验）</dt><dd>{evidence.terminal === "SUCCEEDED" ? "渠道成功" : "渠道未执行"}{evidence.providerRefundTrxNo ? ` · ${evidence.providerRefundTrxNo}` : ""}{evidence.completedAt ? ` · ${timeText(evidence.completedAt, { timeZoneName: false })}` : ""}</dd></div> : null}
      {intent.localAccounting.writeOff ? <div><dt>本地核销</dt><dd>{refundMoney(intent.localAccounting.writeOff.amountCents)} · 本地账务</dd></div> : null}
      {intent.localAccounting.release ? <div><dt>本地释放</dt><dd>仅有申请记录，无资金分录</dd></div> : null}
      {intent.latestFailure ? <div><dt>最近失败观察</dt><dd>{intent.latestFailure.failureReason ?? intent.latestFailure.event} · {timeText(intent.latestFailure.observedAt, { timeZoneName: false })}</dd></div> : null}
    </dl>
    {reasons.length ? <details className="order-refund-reasons"><summary>查看这笔申请的原因代码</summary><p>{reasons.join("、")}</p></details> : null}
  </li>;
}

function OrderRefundSection({ order }: { order: Order }) {
  const session = useUserSession();
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; read: PersonalRefundRead | null; error: OrderRequestError | null }>({ scope: "", status: "loading", read: null, error: null });
  const [reload, setReload] = useState(0);
  const reset = useCallback(() => setState({ scope: "", status: "loading", read: null, error: null }), []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const current = useRef(isCurrent); current.current = isCurrent;
  const confirm = useRef(session.confirm); confirm.current = session.confirm;
  const scope = userId ? `${userId}:${order.id}:${order.status}` : "";
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, read: null, error: null };
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ scope, status: "loading", read: null, error: null });
    void orderApi.personalRefunds(userId, order.id, controller.signal).then((read) => {
      if (!controller.signal.aborted && current.current(userId) && scope === `${userId}:${order.id}:${order.status}`) setState({ scope, status: "ready", read, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !current.current(userId) || scope !== `${userId}:${order.id}:${order.status}`) return;
      const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void confirm.current();
      setState({ scope, status: "error", read: null, error: typed });
    });
    return () => controller.abort();
  }, [order.id, order.status, reload, scope, userId]);
  if (!userId) return null;
  const refresh = <button type="button" className="button quiet button--sm" disabled={visible.status === "loading"} onClick={() => setReload((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取</button>;
  if (visible.status === "loading") return <section className="order-detail-section order-refund-block" aria-label="退款责任与本地退款记录"><div className="order-refund-heading"><h2 className="order-section-title">退款责任</h2></div><p className="order-muted" role="status">正在读取退款责任与本地退款记录…</p></section>;
  if (visible.status === "error") {
    const error = visible.error ?? new OrderRequestError(0, null);
    const copy = error.status === 401 || error.code === "UNAUTHENTICATED"
      ? "登录状态已变化，正在重新确认身份；确认前不会展示退款记录。"
      : error.status === 503 ? "退款依据暂时不可用；这不代表没有退款，也不代表渠道未收款。"
        : error.status === 404 ? "退款责任与本地记录暂时无法读取；这不代表没有退款，也不代表渠道未收款。"
          : "退款责任与本地记录暂时无法读取；这不代表没有退款。";
    return <section className="order-detail-section order-refund-block" aria-label="退款责任与本地退款记录"><div className="order-refund-heading"><h2 className="order-section-title">退款责任</h2>{refresh}</div><div className="order-notice is-warning" role="alert"><CircleSlash size={17} aria-hidden="true" /><div><strong>{copy}</strong><span>错误代码：{error.code}{error.requestId ? <><br />查询编号：{error.requestId}</> : null}</span></div></div></section>;
  }
  const read = visible.read;
  if (!read) return null;
  const outcome = refundOutcomeCopy[read.outcome];
  const responsibility = read.responsibility;
  return <section className="order-detail-section order-refund-block" aria-label="退款责任与本地退款记录" data-outcome={read.outcome}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款责任</h2>{refresh}</div>
    <div className="order-refund-summary">
      <strong>{outcome.label}</strong>
      <p>{outcome.note}</p>
    </div>
    <p className="order-muted">仅读取本地已登记记录；本次未核对渠道全量记录。实际渠道退款、退款去向与银行到账均未核验。读取于 {timeText(read.asOf, { timeZoneName: false })}。</p>
    <ResponsibilityTotals read={read} />
    {read.responsibilitiesTruncated ? <div className="order-notice is-warning" role="alert"><CircleSlash size={17} aria-hidden="true" /><div><strong>异常原款记录不完整</strong><span>本地异常原款超过展示上限，仅显示已返回的部分；唯一责任合计不可用，不能当作全部。</span></div></div> : null}
    {read.abnormalResponsibilities?.length ? <section className="order-refund-abnormal" aria-label="异常收款责任">
      <div className="order-refund-intents-heading"><h3>异常收款责任</h3><span>{read.abnormalResponsibilities.length} 个原款{read.responsibilitiesTruncated ? "（不完整）" : ""}</span></div>
      <p className="order-muted">每个异常原款只计一次责任；释放重试不增加新责任；本地申请金额相加不等于应退，也不等于渠道或银行结果。</p>
      <ul className="order-refund-intents">{read.abnormalResponsibilities.map((item) => <AbnormalResponsibilityCard key={item.confirmationId} item={item} />)}</ul>
    </section> : null}
    {read.intentsTruncated || !read.coverage.intentsComplete ? <div className="order-notice is-warning" role="alert"><CircleSlash size={17} aria-hidden="true" /><div><strong>{read.abnormalResponsibilities ? "退款申请记录范围不完整" : "以下记录与合计不完整"}</strong><span>{read.abnormalResponsibilities ? "不能把申请列表当全部；每个正常过账或异常原款仍按自身完整性分别显示。" : read.intentsTruncated ? "本地退款申请超过展示上限，仅列出已返回的部分；请勿把当前金额当作完整责任或全部退款记录。" : "请勿把当前金额当作完整责任或全部退款记录。"}</span></div></div> : null}
    {read.abnormalResponsibilities ? <div className="order-refund-intents-heading"><h3>正常过账责任</h3><span>正常结算责任</span></div> : null}
    {responsibility.state === "NOT_POSTED" ? <p className="order-muted">本地尚未形成正常过账退款责任；异常原款责任请查看独立记录，不能据此认定渠道未收款或无需退款。</p> : <dl className="order-facts order-refund-amounts">
      <div><dt>过账退款责任</dt><dd>{refundMoney(responsibility.originalCents)}</dd></div>
      <div><dt>已分配（含已核销）</dt><dd>{refundMoney(responsibility.allocatedCents)}</dd></div>
      <div><dt>本地已核销</dt><dd>{refundMoney(responsibility.consumedCents)}</dd></div>
      <div><dt>已释放</dt><dd>{refundMoney(responsibility.releasedCents)}</dd></div>
      <div><dt>尚未分配</dt><dd>{refundMoney(responsibility.remainingCents)}</dd></div>
      <div><dt>责任到期</dt><dd>{responsibility.dueAt ? timeText(responsibility.dueAt, { timeZoneName: false }) : "待确认"} · {refundDueLabel(responsibility.dueState)}</dd></div>
    </dl>}
    {responsibility.state === "POSTED" && !responsibility.totalsComplete ? <p className="order-muted">{read.abnormalResponsibilities ? "过账责任合计不完整" : "合计不完整"}：缺失项不会按 0 计算，以上金额不能当作完整责任或总额。</p> : null}
    <p className="order-refund-funds">本地账务合计：{read.localFundsEffect && (read.localFundsEffect.writtenOffCents !== null || read.localFundsEffect.releasedCents !== null) ? `核销 ${refundMoney(read.localFundsEffect.writtenOffCents)} · 释放 ${refundMoney(read.localFundsEffect.releasedCents)}` : "暂不可用"}。本地核销、渠道回执与银行到账是不同层次。</p>
    <div className="order-refund-intents-heading"><h3>退款申请记录</h3><span>{read.returnedIntentCount} 笔{read.intentsTruncated ? "（不完整）" : ""}</span></div>
    {read.intents.length === 0 ? <p className="order-muted">{refundEmptyCopy(read)}</p> : <ul className="order-refund-intents">{read.intents.map((intent) => <RefundIntentCard key={intent.intentId} intent={intent} />)}</ul>}
    {read.reasonCodes.length || read.unknowns.length ? <details className="order-refund-reasons"><summary>查看原因代码与未核对项</summary><p>{[...read.reasonCodes, ...read.unknowns].join("、")}</p></details> : null}
  </section>;
}

export function OrderDetail({ party, status, accountId, orderId, state, onRetry, onLogin, onChanged }: {
  party: OrderParty;
  status: OrderStatusFilter;
  accountId?: string;
  orderId: string;
  state: DetailState;
  onRetry: () => void;
  onLogin: () => void;
  onChanged: () => void;
}) {
  const backHref = orderUrl(party, status, accountId);
  const title = party === "renter" ? "租入订单" : "出租订单";
  const [read, setRead] = useState<{ facts: OrderStageFacts | null; failed: boolean }>({ facts: null, failed: false });
  const facts = read.facts;
  const back = <Link className="order-detail-back" href={backHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回{title}</Link>;
  if (state.status === "loading") return <section className="order-detail-view" data-testid="order-detail-loading" aria-busy="true" role="status"><div className="order-detail-loading account-module-card"><span /><span /><span /></div></section>;
  if (state.status === "error" && state.error) return <section className="order-detail-view">{back}<OrderError error={state.error} first={false} onRetry={onRetry} onLogin={onLogin} label="订单详情暂时无法读取" /></section>;
  if (state.status !== "ready" || !state.order) return <section className="order-detail-view">{back}<section className="order-error-block" role="status"><XCircle size={24} aria-hidden="true" /><h3>订单不可用</h3><p>当前身份没有这笔订单的可用详情，未展示另一方私人资料。</p></section></section>;
  const order = state.order;
  const attention = attentionFor(order, facts, read.failed, party);
  return <section className="order-detail-view" data-testid="order-detail">
    {back}
    {/* Identity band: the account is the subject, the order number identifies the transaction, and the
        status pill is stated once here and nowhere else. */}
    <header className="order-detail-hero">
      <div className="order-detail-hero-copy">
        <h1 className="order-detail-title">{orderAccountTitle(order)}</h1>
        <p className="order-detail-meta">
          <span className="order-detail-no">订单 {order.displayNo ?? "待确认"}<CopyOrderNo value={order.displayNo} /></span>
          {party === "owner" ? <span>租客：{order.renterName ?? "暂不显示"}</span> : null}
          <span>下单 {timeText(order.createdAt)}</span>
          <span>{orderTermLabel(order)}</span>
        </p>
        <div className="order-detail-status">
          <OrderStatusBadge order={order} />
        </div>
      </div>
    </header>
    <AttentionBlock attention={attention} party={party} orderId={order.id} onRetry={onChanged} />
    <div className="order-detail-body">
      <div className="order-detail-main">
        {order.status !== "CANCELLED" ? <OrderTradeActions order={order} party={party} onChanged={onChanged} onStageFacts={(next, failed) => setRead({ facts: next, failed })} /> : null}
        {party === "renter" && order.source?.origin !== "LEGACY" && !order.readOnly ? <OrderRefundSection key={`${order.id}:${order.status}:${facts?.phase ?? "NONE"}`} order={order} /> : null}
        <section className="order-detail-section order-lines">
          <details open={order.status === "PENDING_PAYMENT" || order.status === "PAID"}>
            <summary><h2 className="order-section-title">下单时费用明细</h2><span className="order-lines-summary">{linesSummary(order, party)}</span></summary>
            <OrderLines order={order} party={party} />
          </details>
        </section>
        <OrderTimeline order={order} facts={facts} party={party} />
      </div>
      <aside className="order-detail-aside">
        <AmountCard order={order} party={party} facts={facts} readFailed={read.failed} />
        <ContactCard order={order} party={party} onChanged={onChanged} quiet={Boolean(attention)} />
      </aside>
    </div>
  </section>;
}
