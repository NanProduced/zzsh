import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { AdminOrderPaymentSummary as Summary } from '../api';
import { financeMoney, financeTime } from './admin-finance-api';

/** Channel observation and local acceptance remain distinct from settlement and arrival. */
export function AdminOrderPaymentSummary({ summary }: { summary?: Summary | null }) {
  if (!summary || summary.integration === 'NOT_INTEGRATED') {
    return <section className="oc-section"><h2>渠道付款</h2><p className="oc-fact-note">渠道付款摘要尚未接入，订单支付记录仍按原有依据核对。</p></section>;
  }
  if (summary.contractVersion !== 'admin-order-payment-summary.v1' || summary.productionPaymentCapability !== false) {
    return <section className="oc-section"><h2>渠道付款</h2><p className="oc-fact-note">摘要版本待核对。</p></section>;
  }
  const mixed = summary.unknowns?.includes('PAYMENT_SOURCE_DIFFERS_FROM_REQUEST');
  const acceptance = summary.acceptance?.state;
  const label = mixed ? '本地受控接纳，付款来源与渠道请求不同'
    : acceptance === 'APPLIED' ? '本地已接纳'
    : acceptance === 'REVIEW_REQUIRED' ? '需要人工核对'
    : acceptance === 'PENDING' ? '等待本地接纳' : '暂无本地接纳记录';
  return <section className="oc-section">
    <h2>渠道付款</h2>
    <Badge variant={mixed || acceptance === 'REVIEW_REQUIRED' ? 'warning' : 'outline'}>{label}</Badge>
    <p className="oc-fact-note">当前为本地协议验证环境，不代表渠道实收。</p>
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>查看付款依据</CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="oc-fact-list">
          <dt>请求渠道</dt><dd>{summary.integration === 'JOINPAY' ? '汇聚支付' : '本地受控'}</dd>
          {summary.originalRequest?.channelOrderNo ? <><dt>商户订单号</dt><dd>{summary.originalRequest.channelOrderNo}</dd></> : null}
          {summary.originalRequest?.amount ? <><dt>请求金额</dt><dd>{summary.originalRequest.amount.currency === 'CNY' ? financeMoney(summary.originalRequest.amount.cents) : '币种待核'}</dd></> : null}
          <dt>观察依据</dt><dd>{summary.latestTrustedObservation?.evidenceLevel === 'SYNTHETIC_PROTOCOL' ? '协议模拟观察' : '尚未取得'}</dd>
          <dt>摘要时间</dt><dd>{financeTime(summary.updatedAt)}</dd>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  </section>;
}
