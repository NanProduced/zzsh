import { ChevronDown, CircleAlert, ArrowUpRight } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { financeMoney, financeTime, reasonLabels, type OrderSettlementEvidence, type OrderSettlementMoney, type OrderFinanceBusiness, type OrderFinanceTransaction, stateLabels } from './admin-finance-api';

export type OrderSettlementReadState = 'loading' | 'ready' | 'forbidden' | 'missing' | 'unavailable' | 'conflict';
export const ORDER_SETTLEMENT_FLAT_KEYS = new Set(['postingCapturedCents', 'refundPayableCents', 'refundPaidCents', 'refundDueAt', 'postedAt', 'channelState', 'channelReference', 'refundPaymentReference', 'postedPlatformContributionCents']);
const money = (value: OrderSettlementMoney | undefined) => financeMoney(value?.knowledge === 'KNOWN' ? value.cents : null);
const dutyKinds: Record<string, string> = { RENTER_REFUND: '租客退款责任', OWNER_CREDIT: '号主收益责任', COMMISSION: '分销责任', DEPOSIT_COMPENSATION: '押金补偿责任' };
const dutyStates: Record<string, string> = { PENDING: '原责任待处理', MATURED: '原责任已成熟', SETTLED: '原责任已终定', VOID: '原责任已作废' };
function moneyRows(evidence: OrderSettlementEvidence): [string, OrderSettlementMoney][] {
  const platform = evidence.platformContribution;
  const originalRefund = evidence.business?.legacyCompletedAmounts?.refundAmount;
  const sameLegacyRefund = evidence.documentRef.startsWith('LEGACY_ORDER:') && originalRefund &&
    (originalRefund.knowledge === 'KNOWN' && evidence.historicalRefund.knowledge === 'KNOWN' && originalRefund.cents !== null && originalRefund.cents === evidence.historicalRefund.cents ||
     originalRefund.knowledge === 'UNKNOWN' && evidence.historicalRefund.knowledge === 'UNKNOWN');
  return [[evidence.posting.state === 'FINALIZED_ZERO' ? '原收款依据金额' : '原入账基数', evidence.captured], [evidence.documentRef.startsWith('LEGACY_ORDER:') ? '号主租赁收益责任' : '号主结算净额', evidence.ownerNet], ['租客应退责任', evidence.refundPayable], ['退款出款记录', evidence.refunded],
    ...(platform ? [['本单已记平台结算贡献（非净利润）', platform] as [string, OrderSettlementMoney]] : []),
    ...(evidence.documentRef.startsWith('LEGACY_ORDER:') && !sameLegacyRefund ? [['历史应退记录', evidence.historicalRefund] as [string, OrderSettlementMoney]] : [])];
}
const postingLabel = (evidence: OrderSettlementEvidence) => evidence.posting.state === 'FINALIZED_ZERO' ? '零额责任已终定' : evidence.posting.state === 'POSTED' ? '原过账已证实' : evidence.posting.state === 'NOT_POSTED' ? '当前未查到过账记录' : '过账未记录';
const paymentLabels: Record<OrderFinanceBusiness['payment']['state'], string> = {
  SITE_ACCEPTED: '本站已确认', LEGACY_RECORDED_PAID: '旧平台记录已付', UNPAID: '未记录付款',
  REVIEW_REQUIRED: '异常收款需复核', UNKNOWN: '付款状态未记录',
};
const settlementLabels: Record<OrderFinanceBusiness['settlementState'], string> = {
  POSTED: '已结算入账', FINALIZED_ZERO: '零额责任已终定', NOT_SETTLED: '未结算',
  LEGACY_RECORDED_COMPLETE: '旧平台记录已完成', UNKNOWN: '结算状态未记录',
};
const transactionLabels: Record<string, string> = {
  RECORDED_UNPAID: '原状态未付款', RECORDED_PAID: '原状态已付款', RECORDED_PENDING: '原状态退款中',
  RECORDED_SUCCESS: '原状态退款成功', RECORDED_FAILED: '原状态退款失败', READY: '待提交',
  NONE: '请求已登记', ACTION_READY: '待用户付款', PROCESSING_UNCONFIRMED: '渠道结果未记录',
  REJECTED_BY_CHANNEL: '渠道拒绝', REVIEW_REQUIRED: '待复核',
};
const settlementReasonLabels: Record<string,string> = {
  HISTORICAL_REFUND_NOT_CURRENT_RESPONSIBILITY:'历史退款原记不等于当前应退责任',
  REFUND_PAYABLE_NOT_CHANNEL_PAYMENT:'应退责任不代表渠道已出款',
  ORIGINAL_CAPTURED_EVIDENCE_UNAVAILABLE:'原入账基数依据未取得',
  SETTLEMENT_CAPTURED_UNAVAILABLE:'原入账基数依据未取得',
  ORIGINAL_OWNER_NET_EVIDENCE_UNAVAILABLE:'号主收益责任依据未取得',
  SETTLEMENT_OWNER_NET_UNAVAILABLE:'号主收益责任依据未取得',
  ORIGINAL_REFUND_RESPONSIBILITY_UNAVAILABLE:'租客应退责任依据未取得',
  SETTLEMENT_REFUND_RESPONSIBILITY_UNAVAILABLE:'租客应退责任依据未取得',
  SETTLEMENT_PLATFORM_COMPONENT_UNAVAILABLE:'平台结算组成依据未取得',
  HISTORICAL_REFUND_SOURCE_UNAVAILABLE:'旧订单退款原记未取得',
  HISTORICAL_REFUND_SOURCE_INVALID:'旧订单退款原记需核对',
  LEGACY_REFUND_AMOUNT_SOURCE_UNAVAILABLE:'旧订单退款原记未取得',
  LEGACY_OWNER_EARNINGS_SOURCE_UNAVAILABLE:'旧订单号主收益原记未取得',
  LEGACY_DUTY_FINANCE_NOT_AVAILABLE:'旧订单责任依据暂不可用',
  LEGACY_DUTY_ORDER_BINDING_UNAVAILABLE:'旧订单责任与原单的关联尚未核实',
  ORIGINAL_DUTY_RESPONSIBILITY_AMBIGUOUS:'原责任存在多个候选，需核对',
  ORIGINAL_DUTY_FINANCE_UNAVAILABLE:'原责任资金依据未取得',
  ORIGINAL_DUTY_AMOUNT_INVALID:'原责任金额需核对',
  INVALID_DUTY_AMOUNT:'原责任金额需核对',
  ORDER_PAYMENT_AMOUNT_UNAVAILABLE:'付款金额依据未取得',
  LEGACY_ORDER_PAYMENT_AMOUNT_UNAVAILABLE:'旧订单付款金额依据未取得',
  SETTLEMENT_ORIGINAL_RECEIPT_INCONSISTENT:'原结算依据存在不一致，需核对',
  PLATFORM_CONTRIBUTION_IS_NOT_NET_PROFIT:'平台结算贡献不是净利润',
};
const legacyRefundAttemptLabels: Record<string, string> = { '0': '原状态退款中', '1': '原状态退款成功', '2': '原状态退款失败' };
function Transactions({ rows, label, onOpenDocument }: { rows: OrderFinanceTransaction[]; label: string; onOpenDocument?: (ref: string, title: string) => void }) {
  const byTime = [...rows].sort((a, b) => (a.occurredAt ? Date.parse(a.occurredAt) : Infinity) - (b.occurredAt ? Date.parse(b.occurredAt) : Infinity));
  return <Collapsible>
    <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="px-0"/>}>{label}（{rows.length}）<ChevronDown aria-hidden size={13}/></CollapsibleTrigger>
    <CollapsibleContent><ul className="space-y-2 py-2 text-sm">
      {byTime.map(row => <li key={row.documentRef}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {onOpenDocument ? <Button variant="link" size="sm" className="h-auto px-0 break-all" onClick={() => onOpenDocument(row.documentRef, row.number)}>{row.number}<ArrowUpRight aria-hidden size={13}/></Button> : <strong className="break-all">{row.number}</strong>}
          <span>{transactionLabels[row.state] ?? stateLabels[row.state] ?? '状态未记录'}</span>
          <span className="tabular-nums">{financeMoney(row.amountCents)}</span>
          <time className="text-muted-foreground">{financeTime(row.occurredAt)}</time>
          {row.kind === 'PAYMENT' ? <span>{row.payWayLabel ?? (row.payWay ? '支付方式未知' : '支付方式未记录')}</span> : null}
        </div>
        {row.refundAttempts?.length ? <ul className="pl-4 text-xs text-muted-foreground">{row.refundAttempts.map(attempt => <li key={attempt.source.id}>退款尝试 {attempt.originalNumber ?? '原号未记录'} · {financeMoney(attempt.recordedAmountCents)} · {financeTime(attempt.occurredAt)} · {legacyRefundAttemptLabels[attempt.originalStatus ?? ''] ?? '原状态未记录'}</li>)}</ul> : null}
        {row.sourceRefundFlags?.length ? <p className="text-xs text-muted-foreground">原退款记录或金额需要核对。</p> : null}
      </li>)}
    </ul></CollapsibleContent>
  </Collapsible>;
}

export function orderSettlementSummary(evidence: OrderSettlementEvidence): string[] {
  const business = evidence.business;
  return [...(business ? [`实付记录：${paymentLabels[business.payment.state]} · ${business.payment.amount.knowledge === 'KNOWN' ? money(business.payment.amount) : '金额待核实'}`, `付款时间：${financeTime(business.payment.occurredAt)}`, `结算状态：${settlementLabels[business.settlementState]}`,
    ...(business.legacyCompletedAmounts ? [`旧单号主收益原记（扣减前）：${money(business.legacyCompletedAmounts.ownerEarnings)}`, `旧单退款金额原记：${money(business.legacyCompletedAmounts.refundAmount)}`] : [])] : []), (evidence.posting.state === 'FINALIZED_ZERO' ? '责任终定：' : '结算过账：') + postingLabel(evidence), ...moneyRows(evidence).map(([label, value]) => `${label}：${money(value)}`), '渠道到账：未取得依据'];
}

export function AdminOrderSettlementEvidence({ state = 'ready', evidence, requestId, paymentState, onRetry, onOpenDocument, embedded = false }: {
  state?: OrderSettlementReadState; evidence?: OrderSettlementEvidence; requestId?: string; paymentState?: string;
  onRetry?: () => void; onOpenDocument?: (documentRef: string, title?: string) => void; embedded?: boolean;
}) {
  const title = evidence?.business ? '订单资金' : '结算与退款依据';
  const shell = embedded ? 'space-y-4' : 'space-y-4 rounded-lg border border-border bg-card p-4 text-card-foreground';
  if (state === 'loading') return <section data-order-settlement-evidence aria-busy="true" className={shell}><h2 className="text-base font-semibold">{title}</h2><p className="text-sm text-muted-foreground">正在读取资金依据…</p><Skeleton className="h-20 w-full" /></section>;
  if (state !== 'ready' || !evidence) {
    const message = state === 'forbidden' ? '当前无权读取本单资金依据' : state === 'missing' ? '未找到当前范围内可读的资金单据' : state === 'conflict' ? '资金依据已变化，请重新读取' : state === 'ready' ? '尚未提供受权订单资金依据' : '资金依据暂不可用';
    const warning = state === 'forbidden' || state === 'missing' || state === 'conflict';
    return <section data-order-settlement-evidence className="space-y-3"><h2 className="text-base font-semibold">{title}</h2><Alert variant={warning ? 'warning' : 'destructive'} role={warning ? 'status' : 'alert'}><CircleAlert aria-hidden /><AlertTitle>{message}</AlertTitle><AlertDescription><p>本次未取得完整依据，不能判断为没有过账、金额为零或退款完成。</p>{requestId ? <p className="break-all font-mono text-xs">请求编号：{requestId}</p> : null}</AlertDescription>{onRetry && state !== 'forbidden' ? <AlertAction><Button variant="outline" size="sm" onClick={onRetry}>重新读取资金依据</Button></AlertAction> : null}</Alert></section>;
  }
  const business = evidence.business;
  const originalRows: [string, OrderSettlementMoney][] = business?.legacyCompletedAmounts ? [['旧单号主收益原记（扣减前）', business.legacyCompletedAmounts.ownerEarnings], ['旧单退款金额原记', business.legacyCompletedAmounts.refundAmount]] : [];
  const rows = moneyRows(evidence), reasons = [...new Set([...(evidence.reasonCodes ?? []), ...rows.flatMap(([, value]) => value?.reasonCodes ?? []), ...originalRows.flatMap(([, value]) => value.reasonCodes ?? []), ...(evidence.historicalRefund.reasonCodes ?? []), ...(business?.payment.amount.reasonCodes ?? [])])];
  const reasonTexts = [...new Set(reasons.map(reason => settlementReasonLabels[reason] ?? reasonLabels[reason] ?? '部分原始资金依据尚未确认'))];
  const allocated = evidence.readiness === 'READY' && evidence.posting.state === 'POSTED' && [evidence.captured, evidence.ownerNet, evidence.refundPayable, evidence.platformContribution].every(value => value?.knowledge === 'KNOWN' && value.cents !== null);
  const visibleRows = allocated ? rows.filter(([, value]) => value === evidence.refunded || value === evidence.historicalRefund && evidence.documentRef.startsWith('LEGACY_ORDER:')) : evidence.posting.state === 'NOT_POSTED' ? rows.filter(([, value]) => value?.knowledge === 'KNOWN') : rows;
  const knownRows = visibleRows.filter(([, value]) => value?.knowledge === 'KNOWN' && value.cents !== null);
  const unknownRows = [...originalRows, ...visibleRows].filter(([, value]) => value?.knowledge !== 'KNOWN' || value.cents === null);
  const noPosting = evidence.posting.state === 'NOT_POSTED';
  const posted = evidence.posting.state === 'POSTED' || evidence.posting.state === 'FINALIZED_ZERO';
  const legacy = evidence.documentRef.startsWith('LEGACY_ORDER:');
  const originalRefund = business?.legacyCompletedAmounts?.refundAmount;
  const refundAmountMismatch = legacy && originalRefund?.knowledge === 'KNOWN' && originalRefund.cents !== null && evidence.historicalRefund.knowledge === 'KNOWN' && evidence.historicalRefund.cents !== null && originalRefund.cents !== evidence.historicalRefund.cents;
  const refundNeedsReview = legacy && originalRefund && (originalRefund.knowledge !== evidence.historicalRefund.knowledge || originalRefund.knowledge === 'KNOWN' && (originalRefund.cents === null || evidence.historicalRefund.cents === null || refundAmountMismatch));
  const channelLine = paymentState === 'RECORDED_UNPAID' && noPosting ? (legacy ? '旧平台记录未付款，渠道情况未取得。' : '本站未记录付款，渠道另核。') : legacy ? '旧平台渠道到账情况未取得。' : '渠道到账情况未取得。';
  return <section data-order-settlement-evidence className={shell}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{title}</h2>{business ? <Badge variant="outline">{settlementLabels[business.settlementState]}</Badge> : <Badge variant={evidence.posting.state === 'UNKNOWN' ? 'warning' : 'outline'}>{postingLabel(evidence)}</Badge>}</div>
    {/* 已知金额、状态及原记录 */}
    {business || knownRows.length ? <div className="space-y-2">
      <h3 className="text-sm font-medium">已知事实</h3>
      {business ? <>
        <dl className="finance-fact-list">
          <div><dt>订单实付</dt><dd>{business.payment.state === 'UNPAID' ? paymentLabels.UNPAID : <>{business.payment.amount.knowledge === 'KNOWN' && business.payment.amount.cents !== null ? money(business.payment.amount) : '金额待核实'}<small>{paymentLabels[business.payment.state]} · {financeTime(business.payment.occurredAt)}</small></>}</dd></div>
          {originalRows.filter(([, value]) => value.knowledge === 'KNOWN' && value.cents !== null).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{money(value)}</dd></div>)}
        </dl>
        {business.reasonCodes.includes('LEGACY_MULTIPLE_RECORDED_PAID_ATTEMPTS') ? <p className="text-sm text-muted-foreground">原记录有多笔已付尝试，订单实付以旧订单记录为准。</p> : null}
      </> : null}
      {knownRows.length ? <dl className="space-y-3 text-sm">{knownRows.map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{money(value)}</dd></div>)}</dl> : !allocated && noPosting ? <p className="text-sm text-muted-foreground">当前未查到过账记录，没有已证实的实际结算金额；不以 0 或预付金额替代。</p> : null}
      {business?.paymentAttempts.length ? <Transactions rows={business.paymentAttempts} label="付款尝试" onOpenDocument={onOpenDocument}/> : null}
      {business?.refundOrders.length ? <Transactions rows={business.refundOrders} label="退款单据" onOpenDocument={onOpenDocument}/> : business ? <p className="text-sm text-muted-foreground">本次未读取到关联退款单据。</p> : null}
    </div> : null}
    {refundNeedsReview ? <Alert variant="warning" role="status"><CircleAlert aria-hidden /><AlertTitle>{refundAmountMismatch ? '旧订单退款原记金额不一致' : '旧订单退款原记待核对'}</AlertTitle><AlertDescription>请核对原订单记录与本次读取的历史金额。</AlertDescription></Alert> : null}
    {unknownRows.length ? <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="px-0"/>}>尚未取得依据的金额<ChevronDown aria-hidden size={13}/></CollapsibleTrigger><CollapsibleContent><dl className="space-y-2 text-sm">{unknownRows.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>{label}</dt><dd>{money(value)}</dd></div>)}</dl></CollapsibleContent></Collapsible> : null}
    {evidence.readiness !== 'READY' ? <p className="text-sm text-muted-foreground">部分资金依据暂未就绪，以下只展示已取得的独立事实。</p> : null}
    {/* 二组：本站账务 —— 有过账才出现 */}
    {posted ? <div className="space-y-2">
      <h3 className="text-sm font-medium">本站账务</h3>
      {allocated ? <div className="finance-allocation" aria-label="本单已核结算分配等式">{[['原入账基数', evidence.captured], ['号主结算净额', evidence.ownerNet], ['租客应退责任', evidence.refundPayable], ['平台结算贡献', evidence.platformContribution!]].map(([label, value], index) => <div key={String(label)}><span aria-hidden>{index === 0 ? '' : index === 1 ? '=' : '+'}</span><dl><dt>{String(label)}</dt><dd>{money(value as OrderSettlementMoney)}</dd></dl></div>)}</div> : null}
      <dl className="space-y-3 text-sm">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">{evidence.posting.state === 'FINALIZED_ZERO' ? '责任终定时间' : '原过账时间'}</dt><dd>{financeTime(evidence.posting.postedAt)}</dd></div>
        {!noPosting ? <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">退款责任到期</dt><dd>{financeTime(evidence.refundDueAt)}</dd></div> : null}
      </dl>
    </div> : null}
    {evidence.dutyRefs?.length ? <div className="space-y-2 border-t border-border pt-3"><h3 className="text-sm font-medium">关联责任记录</h3>{evidence.dutyRefs.map((duty, index) => <div key={`${duty.documentRef ?? 'unresolved'}:${index}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><div><span>{dutyKinds[duty.kind] ?? '责任记录'} · {dutyStates[duty.state] ?? '责任状态未记录'}</span><span className="ml-2 tabular-nums">{money(duty.amount)}</span></div>{duty.documentRef && /^LEGACY_DUTY:[A-Za-z0-9_-]+$/.test(duty.documentRef) && onOpenDocument ? <Button data-duty-ref={duty.documentRef} variant="link" size="sm" className="h-auto px-0" onClick={() => onOpenDocument(duty.documentRef!, '责任资金依据')}>查看责任依据<ArrowUpRight aria-hidden size={13} /></Button> : <span className="text-xs text-muted-foreground">关联依据未记录</span>}</div>)}</div> : null}
    {/* 渠道证据另行核对 */}
    <p className="text-sm text-muted-foreground">{channelLine}</p>
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="px-0" />}>展开缺失清单<ChevronDown aria-hidden size={13} /></CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2 text-xs text-muted-foreground">
        <dl className="space-y-2">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>渠道到账</dt><dd>未取得依据</dd></div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>渠道流水号</dt><dd>{evidence.channel.reference ?? '未取得'}</dd></div>
          {!posted ? <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt>原过账时间</dt><dd>未记录</dd></div> : null}
        </dl>
        <p className="leading-relaxed">应退责任、历史记录和退款出款记录分别核对，均不证明渠道到账。{(evidence as OrderSettlementEvidence & { platformContribution?: OrderSettlementMoney }).platformContribution ? "平台结算贡献不是净利润，未扣分销与渠道成本。" : ""}</p>
      </CollapsibleContent>
    </Collapsible>
    {reasons.length || evidence.posting.ref ? <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="px-0" />}>依据与说明<ChevronDown aria-hidden size={13} /></CollapsibleTrigger><CollapsibleContent className="space-y-2 pt-2 text-xs text-muted-foreground">{evidence.posting.ref ? <p className="break-all">{evidence.posting.state === 'FINALIZED_ZERO' ? '原责任依据' : '原过账引用'}：{evidence.posting.ref}</p> : null}{reasonTexts.map(reason => <p key={reason}>{reason}</p>)}{reasons.length ? <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="px-0"/>}>技术追溯<ChevronDown aria-hidden size={13}/></CollapsibleTrigger><CollapsibleContent>{reasons.map(reason=><p key={reason} className="break-all font-mono">{reason}</p>)}</CollapsibleContent></Collapsible> : null}</CollapsibleContent></Collapsible> : null}
  </section>;
}
