import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { AdminOrderPaymentSummary as Summary } from '../api';
import { financeMoney, financeTime } from './admin-finance-api';

/** Channel observation and local acceptance remain distinct from settlement and arrival. */
export function AdminOrderPaymentSummary({ summary }: { summary?: Summary | null }) {
  const unknownSource = summary?.unknowns?.includes('UNKNOWN_PAYMENT_SOURCE')
    || (summary?.dataOrigin === 'UNKNOWN' && summary.integration !== 'NOT_INTEGRATED');
  if (unknownSource) return <section className="oc-section"><h2>渠道付款</h2><p className="oc-fact-note">付款来源待核，暂不据此认定付款或渠道到账。</p></section>;
  if (!summary || summary.integration === 'NOT_INTEGRATED') {
    return <section className="oc-section"><h2>渠道付款</h2><p className="oc-fact-note">渠道付款摘要尚未接入，订单支付记录仍按原有依据核对。</p></section>;
  }
  if (summary.contractVersion !== 'admin-order-payment-summary.v1' || typeof summary.productionPaymentCapability !== 'boolean'
    || !['NOT_INTEGRATED', 'CONTROLLED_LOCAL', 'JOINPAY'].includes(summary.integration)
    || (summary.dataOrigin !== undefined && !['SYNTHETIC_PROTOCOL', 'LOCAL_CONTROLLED', 'JOINPAY_CANDIDATE', 'JOINPAY_PROVIDER', 'UNKNOWN'].includes(summary.dataOrigin))) {
    return <section className="oc-section"><h2>渠道付款</h2><p className="oc-fact-note">摘要版本待核对。</p></section>;
  }
  const acceptance = summary.acceptance?.state;
  const acceptanceText = acceptance === 'APPLIED' ? '本站已接纳' : acceptance === 'REVIEW_REQUIRED' ? '本站待人工复核' : acceptance === 'PENDING' ? '等待本站接纳' : '暂无本站接纳记录';
  const formal = summary.dataOrigin === 'JOINPAY_PROVIDER';
  const sourceDiffers = summary.unknowns?.includes('PAYMENT_SOURCE_DIFFERS_FROM_REQUEST');
  const mixed = sourceDiffers && !formal;
  const observation = summary.latestTrustedObservation;
  const channelOutcome = observation?.channelStatus === "SUCCEEDED" ? "付款成功" : observation?.channelStatus === "FAILED" ? "付款失败" : observation?.channelStatus === "CREATED_UNPAID" ? "尚未付款" : null;
  const channelText = channelOutcome && observation?.evidenceLevel === "JOINPAY_VERIFIED" ? channelOutcome + "（汇聚确认）" : channelOutcome && observation?.evidenceLevel === "SYNTHETIC_PROTOCOL" ? "模拟：" + channelOutcome : "未取得可信渠道结果";
  const label = mixed ? '本地受控接纳，付款来源与渠道请求不同'
    : formal && sourceDiffers ? '汇聚原确认，付款来源与渠道请求不同'
    : formal && acceptance === 'APPLIED' ? '汇聚原确认 · 本地已接纳'
    : acceptance === 'APPLIED' ? '本地已接纳'
    : acceptance === 'REVIEW_REQUIRED' ? '需要人工核对'
    : acceptance === 'PENDING' ? '等待本地接纳' : '暂无本地接纳记录';
  return <section className="oc-section">
    <h2>渠道付款</h2>
    <Badge variant={mixed || acceptance === 'REVIEW_REQUIRED' ? 'warning' : 'outline'}>{label}</Badge>
    <p className="oc-fact-note">{mixed || summary.dataOrigin === 'LOCAL_CONTROLLED' || summary.integration === 'CONTROLLED_LOCAL'
      ? '本地受控收款依据，不代表真实渠道扣款或到账。'
      : formal ? '按本单已提交的原付款确认核对；本地接纳、结算及渠道到账分别记录。'
      : summary.dataOrigin === 'JOINPAY_CANDIDATE' ? '汇聚请求候选不构成已付款；渠道结果与本地接纳分别核对。'
      : observation?.evidenceLevel === 'SYNTHETIC_PROTOCOL' ? '当前为本地协议验证环境，不代表渠道实收。'
      : '现有付款依据尚不完整，不据请求渠道或能力状态认定渠道到账。'}</p>
    <dl className="oc-fact-list"><dt>渠道结果</dt><dd>{channelText}</dd><dt>本站处理</dt><dd>{acceptanceText}</dd></dl>
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>查看付款依据</CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="oc-fact-list">
          <dt>请求渠道</dt><dd>{summary.integration === 'JOINPAY' ? '汇聚支付' : '本地受控'}</dd>
          <dt>渠道观察</dt><dd>{observation?.evidenceLevel === 'SYNTHETIC_PROTOCOL' ? '协议模拟观察，不代表渠道实收'
            : observation?.evidenceLevel === 'JOINPAY_VERIFIED' && ['NOTIFY', 'QUERY'].includes(observation.source)
              ? `已存汇聚${observation.source === 'NOTIFY' ? '通知' : '查询'}签名与绑定证据` : '尚未取得'}</dd>
          <dt>本站接纳</dt><dd>{acceptanceText}</dd>
          {summary.originalRequest?.channelOrderNo ? <><dt>商户订单号</dt><dd>{summary.originalRequest.channelOrderNo}</dd></> : null}
          {observation?.channelTrxNo ? <><dt>渠道流水</dt><dd>{observation.channelTrxNo}</dd></> : null}
          {summary.originalRequest?.amount ? <><dt>请求金额</dt><dd>{summary.originalRequest.amount.currency === 'CNY' ? financeMoney(summary.originalRequest.amount.cents) : '币种待核'}</dd></> : null}
          {observation?.evidenceLevel === 'JOINPAY_VERIFIED' && observation.providerTimeZone === 'EXPLICIT_OFFSET' && observation.providerPaidAt
            ? <><dt>渠道原付款时间</dt><dd>{financeTime(observation.providerPaidAt)}（按已核时区换算）</dd></> : null}
          <dt>新付款能力</dt><dd>{summary.productionPaymentCapability ? '已就绪；不表示本单已付款' : '未启用；历史付款依据仍保留'}</dd>
          <dt>摘要时间</dt><dd>{financeTime(summary.updatedAt)}</dd>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  </section>;
}
