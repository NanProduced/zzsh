import { financeMoney, financeTime, type FinanceDocument, type FinanceResponse } from './admin-finance-api';

const orderStates: Record<string, string> = { PAID: '已支付', COMPLETED: '已完成', CANCELLED: '已取消', PENDING_PAYMENT: '待支付' };
export function financeOrderState(document: FinanceDocument): string | undefined {
  const lifecycle = document.orderLifecycle;
  if (!lifecycle) return undefined;
  const posting = lifecycle.postingState === 'NOT_POSTED' ? lifecycle.orderStatus === 'PAID' && lifecycle.payment.state === 'SITE_ACCEPTED' ? '待结算分配' : lifecycle.orderStatus === 'CANCELLED' ? '未产生结算分配，退款责任另核' : '未产生结算分配' : lifecycle.postingState === 'POSTED' ? '已有结算分配' : lifecycle.postingState === 'LEGACY_OBSERVATION' ? '旧单责任另核' : '分配依据未取得';
  return [orderStates[lifecycle.orderStatus] ?? '订单状态待核', lifecycle.payment.state === 'SITE_ACCEPTED' ? '本站已确认付款' : lifecycle.payment.state === 'REVIEW_REQUIRED' ? '有异常收款原始记录，当前责任另核' : lifecycle.payment.state === 'NO_ACCEPTED_PAYMENT' ? '本站尚未确认付款' : lifecycle.payment.state === 'LEGACY_RECORDED' ? '旧平台付款观察' : '付款依据未取得', posting].join(' · ');
}

export function FinanceOrderPayment({ document }: { document: FinanceDocument }) {
  const lifecycle = document.orderLifecycle;
  if (!lifecycle) return null;
  const payment = lifecycle.payment;
  return <section className="finance-order-payment"><h2>{lifecycle.origin === 'NATIVE' ? '本站确认付款' : '旧平台付款记录'}</h2>
    <p>{financeOrderState(document)}</p>
    <dl className="finance-fact-list"><div><dt>{payment.state === 'LEGACY_RECORDED' ? '旧记录付款金额' : '实际接纳付款金额'}</dt><dd>{financeMoney(payment.state === 'SITE_ACCEPTED' || payment.state === 'LEGACY_RECORDED' ? payment.amountCents : null)}</dd></div><div><dt>确认付款时间</dt><dd>{financeTime(payment.state === 'SITE_ACCEPTED' ? payment.confirmedAt : null)}</dd></div>{document.parties ? <><div><dt>号主</dt><dd>{document.parties.owner.name}</dd></div><div><dt>租客</dt><dd>{document.parties.renter.name}</dd></div></> : null}</dl>
    {payment.hasReviewPayment ? <p className="finance-secondary">存在额外异常收款原始记录，可能已核销；退款进度可在关联单据核对。这些原记录不计入本站已接纳付款金额。</p> : null}
    <p className="finance-secondary">{payment.source === 'CONTROLLED' ? '本地受控付款确认，不代表真实银行到账。' : lifecycle.origin === 'LEGACY_MYSQL' ? '旧平台观察不证明新平台收款或当前渠道结果。' : '本站接纳付款与渠道清算、银行到账分别核对。'}{lifecycle.postingState === 'NOT_POSTED' && payment.state === 'SITE_ACCEPTED' ? ' 已确认付款，当前尚未形成结算分配；无分录不等于未收款。' : ''}</p>
  </section>;
}

const componentLabels: Record<string, string> = { PLATFORM_HAFF_SPREAD: '哈夫币价差', PLATFORM_ITEM_SPREAD: '物资价差', PLATFORM_EARLY_MAKEUP: '提前结束补偿收入', PLATFORM_COMPENSATION_FEE: '包赔服务费收入', PLATFORM_MANUAL_NET_ADJUSTMENT: '人工结算调整' };
const payerLabels: Record<string, string> = { OWNER: '号主承担', RENTER: '租客承担', NONE: '无承担方' };
export function FinanceOrderCosts({ body }: { body: FinanceResponse }) {
  const components = body.orderSettlement?.platformComponents;
  if (!body.document?.orderLifecycle) return null;
  return <section className="finance-order-costs"><h2>平台组成与本单成本</h2>
    {components?.length ? <dl className="finance-fact-list">{components.map((item, index) => <div key={`${item.code}:${index}`}><dt>{componentLabels[item.code] ?? '平台结算组成'}</dt><dd>{financeMoney(item.cents)}{['PLATFORM_COMPENSATION_FEE', 'PLATFORM_EARLY_MAKEUP'].includes(item.code) ? <small>{item.payer ? payerLabels[item.payer] : '承担方未取得'}{item.feeBase !== null ? ` · 冻结基数 ${item.feeBase} 元` : ''}{item.feeRate !== null ? ` · 冻结比例 ${item.feeRate}` : ''}</small> : null}</dd></div>)}</dl> : <p className="finance-secondary">尚未取得经核原分配组成，不使用当前规则反算。</p>}
    <dl className="finance-fact-list"><div><dt>本单分销成本</dt><dd>{financeMoney(body.platform?.distributionExpenseCents)}</dd></div><div><dt>本单渠道成本</dt><dd>{financeMoney(body.platform?.channelCostCents)}</dd></div><div><dt>净贡献</dt><dd>{body.platform?.netProfitCents != null && body.platform.distributionExpenseCents !== null && body.platform.channelCostCents !== null ? financeMoney(body.platform.netProfitCents) : '成本依据不完整，未计算'}</dd></div></dl>
    <p className="finance-secondary">平台结算贡献不是净利润；分销与渠道成本须按本单原根核定，不使用全库金额代替。</p>
  </section>;
}
