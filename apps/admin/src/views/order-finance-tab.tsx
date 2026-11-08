import { ArrowUpRight, ChevronDown, CircleAlert, Clock3, CreditCard, Wallet } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { commissionRoleLabel } from '@zzsh/ui/display-distribution';
import { financeMoney, financeTime, type OrderSettlementEvidence, type OrderSettlementMoney } from './admin-finance-api';
import { distributionState, type parseDistributionOrder } from './distribution-order-model';
import { mergeOrderRefunds, refundSummaryScope, type OrderRefundSummary } from './order-finance-model';
import { AdminOrderSettlementEvidence, type OrderSettlementReadState } from './admin-order-settlement-evidence';
import type { SettlementReadView } from '../lib/order-fulfillment-client';
import './admin-order-chain.css';

type DistributionRead = ReturnType<typeof parseDistributionOrder>;
export type OrderDistributionState = { state: 'loading' | 'ready' | 'forbidden' | 'unavailable'; value?: DistributionRead };
type Props = {
  state: OrderSettlementReadState;
  evidence?: OrderSettlementEvidence;
  requestId?: string;
  paymentState?: string;
  refundSummary?: OrderRefundSummary | null;
  distribution?: OrderDistributionState;
  settlement?: SettlementReadView | null;
  onRetry?: () => void;
  onOpenDocument?: (ref: string, title?: string) => void;
};

const paymentState: Record<string, string> = {
  SITE_ACCEPTED: '已记录付款', LEGACY_RECORDED_PAID: '旧平台记录已付款', UNPAID: '尚未记录付款',
  REVIEW_REQUIRED: '付款需核对', UNKNOWN: '付款状态待核对',
};
const refundState: Record<string, string> = {
  READY: '待提交', SUBMITTING: '提交中', UNKNOWN: '结果待核对', PROCESSING: '处理中', REVIEW_REQUIRED: '需人工核对',
  SUCCEEDED: '本地记录成功', FAILED: '本地记录失败', STATE_CHANGED: '状态已变化，请刷新',
  RECORDED_PENDING: '旧平台记录处理中', RECORDED_SUCCESS: '旧平台记录成功', RECORDED_FAILED: '旧平台记录失败',
};
const oldAttemptState: Record<string, string> = { '0':'旧平台记录处理中', '1':'旧平台记录成功', '2':'旧平台记录失败' };
const sourceLabel = { LEGACY_MYSQL: '旧平台记录', JOINPAY: '汇聚请求', CONTROLLED: '本地受控记录', UNKNOWN: '来源待核对' };
const componentLabel: Record<string, string> = {
  PLATFORM_HAFF_SPREAD: '哈夫币价差', PLATFORM_ITEM_SPREAD: '物资价差', PLATFORM_EARLY_MAKEUP: '提前结束补足',
  PLATFORM_COMPENSATION_FEE: '全额包赔服务费', PLATFORM_MANUAL_NET_ADJUSTMENT: '人工调整',
};
const known = (value: OrderSettlementMoney | undefined) => value?.knowledge === 'KNOWN' && value.cents !== null ? value.cents : null;
function balancedAllocation(evidence: OrderSettlementEvidence) {
  const values = [evidence.captured, evidence.ownerNet, evidence.refundPayable, evidence.platformContribution].map(known);
  const complete = evidence.readiness === 'READY' && evidence.posting.state === 'POSTED' && values.every(value => value !== null && /^\d+$/.test(value));
  return complete && BigInt(values[0]!) === BigInt(values[1]!) + BigInt(values[2]!) + BigInt(values[3]!);
}

function Allocation({ evidence }: { evidence: OrderSettlementEvidence }) {
  const values = [evidence.captured, evidence.ownerNet, evidence.refundPayable, evidence.platformContribution].map(known);
  if (!balancedAllocation(evidence)) return null;
  return <dl className="oc-finance-allocation" aria-label="本单结算分配">
    {(['结算基数', '号主结算净额', '租客应退', '平台结算贡献'] as const).map((label, index) =>
      <div key={label}><dt>{label}</dt><dd>{financeMoney(values[index])}</dd></div>)}
  </dl>;
}

function DocumentLink({ refId, label, onOpenDocument }: { refId: string | null; label: string; onOpenDocument?: Props['onOpenDocument'] }) {
  return refId && onOpenDocument ? <Button variant="link" size="sm" className="ml-2 h-auto whitespace-nowrap px-0" onClick={() => onOpenDocument(refId, label)}>{label}<ArrowUpRight aria-hidden size={13}/></Button> : null;
}

function DistributionEntries({ distribution, onOpenDocument }: { distribution: OrderDistributionState; onOpenDocument?: Props['onOpenDocument'] }) {
  const commissions = distribution.state === 'ready' && distribution.value?.knowledge === 'KNOWN' ? distribution.value : null;
  return <>
        {distribution.state === 'loading' ? <p className="oc-finance-muted">正在读取本单分销记录…</p> : distribution.state === 'forbidden' ? <p className="oc-finance-muted">当前身份无权查看本单分销记录。</p> : distribution.state === 'unavailable' || distribution.value?.knowledge === 'UNAVAILABLE' ? <p className="oc-finance-muted">本单分销记录暂不可用，不能据此判断为零。</p> : commissions?.items.length ? <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>分销收益人</TableHead><TableHead>状态</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader><TableBody>{commissions.items.map(item=><TableRow key={item.id}><TableCell>{item.beneficiary.name ?? '收益人资料未提供'}<small className="block text-muted-foreground">{commissionRoleLabel(item.role)}{item.origin === 'LEGACY_MYSQL' ? ' · 旧平台记录' : ''}</small></TableCell><TableCell>{item.origin === 'LEGACY_MYSQL' ? `原记录：${distributionState(item)}` : distributionState(item)}{item.dueAt && item.state === 'PENDING' ? <small className="block text-muted-foreground">预计可处理 {financeTime(item.dueAt)}</small> : null}</TableCell><TableCell className="text-right tabular-nums">{financeMoney(item.amountCents)}<DocumentLink refId={item.documentRef} label="查看依据" onOpenDocument={onOpenDocument}/></TableCell></TableRow>)}</TableBody></Table></div> : <p className="oc-finance-muted">本次未读取到本单分销记录。</p>}
        {commissions?.currentLegacyCommissions.length ? <div className="oc-finance-note"><strong>迁入后佣金责任</strong>{commissions.currentLegacyCommissions.map(item=><div key={item.dutyId}>{item.knowledge === 'KNOWN' && item.finalization === 'POSTED' ? '已有入账依据' : item.knowledge === 'KNOWN' && item.finalization === 'FINALIZED_ZERO' ? '责任已核定为零' : '责任待核对'} · {financeMoney(item.amountCents)} <DocumentLink refId={item.documentRef} label="查看依据" onOpenDocument={onOpenDocument}/></div>)}<p>与上方旧记录可能属于同一笔佣金，不重复相加。</p></div> : null}
        {commissions?.truncated ? <p className="oc-finance-warning">本单分销记录未读全，请查看原始记录。</p> : null}
  </>;
}

function RefundRecords({ rows, onOpenDocument }: { rows: ReturnType<typeof mergeOrderRefunds>; onOpenDocument?: Props['onOpenDocument'] }) {
  if (!rows.length) return <p className="oc-finance-muted">本次未读取到可关联的退款记录。</p>;
  return <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>退款记录</TableHead><TableHead>处理状态</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader><TableBody>{rows.map(row=><TableRow key={row.key}>
    <TableCell><strong>{row.number || '编号未记录'}</strong><small className="block text-muted-foreground">{sourceLabel[row.source]}{row.occurredAt ? ` · ${financeTime(row.occurredAt)}` : ''}</small>{row.original?.refundAttempts?.length ? <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="h-auto px-0"/>}>查看原退款尝试（{row.original.refundAttempts.length}）<ChevronDown aria-hidden size={13}/></CollapsibleTrigger><CollapsibleContent><ul className="oc-finance-sublist">{row.original.refundAttempts.map((attempt,index)=><li key={attempt.source.id ?? index}>{attempt.originalNumber || '编号未记录'} · {oldAttemptState[attempt.originalStatus ?? ''] ?? '原状态未记录'} · {attempt.occurredAt ? financeTime(attempt.occurredAt) : '时间未记录'} · {financeMoney(attempt.recordedAmountCents)} · 渠道到账未取得依据</li>)}</ul></CollapsibleContent></Collapsible> : null}{row.original?.sourceRefundFlags?.length ? <small className="block text-amber-600 dark:text-amber-400">原退款记录有待核事项，请查看来源。</small> : null}</TableCell>
    <TableCell>{row.conflict ? '记录不一致，需核对' : refundState[row.state] ?? '状态待核对'}{row.requiresReview ? ' · 需复核' : ''}{row.budgetDisposition ? <small className="block text-muted-foreground">{({ CONSUMED:'预算已使用', RELEASED:'预算已释放', RESERVED:'预算已预留' } as Record<string,string>)[row.budgetDisposition] ?? '预算状态待核对'}</small> : null}<small className="block text-muted-foreground">渠道到账未取得依据</small></TableCell>
    <TableCell className="text-right tabular-nums">{row.conflict ? '金额待核对' : financeMoney(row.amountCents)}<DocumentLink refId={row.documentRef} label="查看记录" onOpenDocument={onOpenDocument}/></TableCell>
  </TableRow>)}</TableBody></Table></div>;
}

export function OrderFinanceTab({ state, evidence, requestId, paymentState: recordedPaymentState, refundSummary, distribution, settlement, onRetry, onOpenDocument }: Props) {
  const business = evidence?.business;
  const legacy = evidence?.documentRef.startsWith('LEGACY_ORDER:') === true;
  const refunds = mergeOrderRefunds(business?.refundOrders ?? [], refundSummary);
  const ownerCredit = evidence?.dutyRefs?.filter(item => item.kind === 'OWNER_CREDIT') ?? [];
  const depositCompensation = evidence?.dutyRefs?.filter(item => item.kind === 'DEPOSIT_COMPENSATION') ?? [];
  const renterDuties = evidence?.dutyRefs?.filter(item => item.kind === 'RENTER_REFUND') ?? [];
  const oldRefund = business?.legacyCompletedAmounts?.refundAmount;
  const historicRefund = evidence?.historicalRefund;
  const oldRefundMismatch = known(oldRefund) !== null && known(historicRefund) !== null && known(oldRefund) !== known(historicRefund);
  const money = (value: OrderSettlementMoney | undefined) => financeMoney(known(value));
  const failed = state !== 'ready' || !evidence;
  const error = state === 'forbidden' ? '当前身份无权查看本单资金凭证' : state === 'missing' ? '未找到本单资金凭证' : state === 'conflict' ? '资金资料已变化' : '资金资料暂不可用';

  // Older API projections do not yet have business facts; keep their independently verified evidence readable.
  if (state === 'ready' && evidence && !business) return <section className="oc-finance-story" data-order-finance-tab>
    <AdminOrderSettlementEvidence evidence={evidence} paymentState={recordedPaymentState} onOpenDocument={onOpenDocument}/>
    {distribution ? <section className="oc-section" aria-label="本单分销"><h3>本单分销</h3><DistributionEntries distribution={distribution} onOpenDocument={onOpenDocument}/></section> : null}
    {refundSummary?.integration === 'INTEGRATED' && refunds.length ? <section className="oc-section" aria-label="已授权退款摘要"><h3>退款摘要</h3><RefundRecords rows={refunds} onOpenDocument={onOpenDocument}/><p className="oc-finance-muted">{refundSummaryScope(refundSummary)}</p></section> : null}
  </section>;

  return <section className="oc-section oc-finance-story" data-order-finance-tab aria-busy={state === 'loading'}>
    <header className="oc-finance-story-head"><div><h2>订单资金</h2><p>查看本单付款、结算、余额入账和退款进度。</p></div>{business ? <Badge variant="outline">{business.settlementState === 'POSTED' ? '已结算' : business.settlementState === 'LEGACY_RECORDED_COMPLETE' ? '旧平台记录已完成' : business.settlementState === 'NOT_SETTLED' ? '未结算' : business.settlementState === 'FINALIZED_ZERO' ? '零额责任已终定' : '结算待核对'}</Badge> : null}</header>
    {state === 'loading' ? <><p className="text-sm text-muted-foreground">正在读取本单资金记录…</p><Skeleton className="h-28 w-full"/></> : failed ? <><Alert variant={state === 'forbidden' || state === 'missing' || state === 'conflict' ? 'warning' : 'destructive'} role="status"><CircleAlert aria-hidden/><AlertTitle>{state === 'ready' ? '尚未提供本单资金依据' : error}</AlertTitle><AlertDescription>未取得的记录不能视为零或已处理。{requestId ? ` 请求编号：${requestId}` : ''}</AlertDescription>{onRetry && state !== 'forbidden' ? <AlertAction><Button size="sm" variant="outline" onClick={onRetry}>重新读取</Button></AlertAction> : null}</Alert>{distribution ? <section className="oc-finance-section" aria-label="本单分销"><div className="oc-finance-section-title"><Wallet aria-hidden size={17}/><h3>本单分销</h3></div><DistributionEntries distribution={distribution} onOpenDocument={onOpenDocument}/></section> : null}{refundSummary?.integration === 'INTEGRATED' ? <section className="oc-finance-section" aria-label="已授权退款摘要"><div className="oc-finance-section-title"><CreditCard aria-hidden size={17}/><h3>退款摘要</h3></div><RefundRecords rows={refunds} onOpenDocument={onOpenDocument}/><p className="oc-finance-muted">{refundSummaryScope(refundSummary)}</p></section> : null}</> : <>
      <section className="oc-finance-section" aria-label="付款记录"><div className="oc-finance-section-title"><CreditCard aria-hidden size={17}/><h3>付款</h3></div>
        {business ? <div className="oc-finance-primary"><div><strong>{paymentState[business.payment.state] ?? '付款状态待核对'}</strong><p>{business.payment.occurredAt ? financeTime(business.payment.occurredAt) : '付款时间未记录'}</p></div><strong className="oc-finance-amount">{business.payment.state === 'UNPAID' ? '—' : money(business.payment.amount)}</strong></div> : <p className="oc-finance-muted">付款事实未读取，请核对订单支付记录。</p>}
        {business?.paymentAttempts.length ? <><ul className="oc-finance-sublist">{business.paymentAttempts.map(row=><li key={row.documentRef}><span><strong>{row.number || '支付记录'}</strong> · {row.payWayLabel ?? (row.payWay ? '支付方式待核对' : '支付方式未记录')} · {row.state === 'RECORDED_PAID' ? '原记录已付款' : row.state === 'RECORDED_UNPAID' ? '原记录未付款' : '支付请求已记录'}{row.occurredAt ? ` · ${financeTime(row.occurredAt)}` : ''}{business.paymentAttempts.length > 1 ? ` · ${financeMoney(row.amountCents)}` : ''}</span><DocumentLink refId={row.documentRef} label="查看记录" onOpenDocument={onOpenDocument}/></li>)}</ul>{business.paymentAttempts.length > 1 ? <p className="oc-finance-muted">逐笔记录保留各自来源，不与订单实付重复相加。</p> : null}</> : null}
        <p className="oc-finance-muted">{legacy ? '旧平台付款记录的渠道结果需另行核对。' : '本站付款记录与渠道到账分别核对。'}</p>
      </section>
      <section className="oc-finance-section" aria-label="结算记录"><div className="oc-finance-section-title"><Clock3 aria-hidden size={17}/><h3>结算</h3></div>
        {business?.settlementState === 'NOT_SETTLED' ? <p className="oc-finance-muted">本单尚未结算；最终收益和退款以结算结果为准。</p> : business?.settlementState === 'LEGACY_RECORDED_COMPLETE' && business.legacyCompletedAmounts ? <dl className="oc-finance-facts"><div><dt>号主收益原记（扣费前）</dt><dd>{money(business.legacyCompletedAmounts.ownerEarnings)}</dd></div><div><dt>退款金额原记</dt><dd>{money(business.legacyCompletedAmounts.refundAmount)}</dd></div></dl> : <>
          <Allocation evidence={evidence}/>
          {evidence.posting.state === 'POSTED' ? <p className={balancedAllocation(evidence) ? 'oc-finance-muted' : 'oc-finance-warning'}>{balancedAllocation(evidence) ? <>过账时间：{financeTime(evidence.posting.postedAt)}；平台结算贡献不等于净利润。</> : '结算金额依据不完整或不平衡，请核对原始记录。'}</p> : evidence.posting.state === 'FINALIZED_ZERO' ? <p className="oc-finance-muted">本单责任已核定为零；退款渠道结果另行核对。</p> : <p className="oc-finance-muted">结算资料尚未核实，不以零或预付金额代替。</p>}
          {balancedAllocation(evidence) && evidence.platformComponents?.length ? <Collapsible className="oc-finance-note"><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="h-auto px-0"/>}>查看平台结算贡献构成<ChevronDown aria-hidden size={13}/></CollapsibleTrigger><CollapsibleContent><dl className="oc-finance-facts">{evidence.platformComponents.map((item,index)=><div key={`${item.code}-${index}`}><dt>{componentLabel[item.code] ?? '其他结算项目'}{item.payer === 'OWNER' ? '（号主承担）' : item.payer === 'RENTER' ? '（租客承担）' : ''}</dt><dd>{financeMoney(item.cents)}</dd></div>)}</dl><p>包赔服务费是收费记录，与包赔赔款不是同一笔资金。</p></CollapsibleContent></Collapsible> : null}
        </>}
        {settlement?.versions?.some(version => version.decisions?.length) ? <Collapsible className="oc-finance-note"><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="h-auto px-0"/>}>查看结算确认记录<ChevronDown aria-hidden size={13}/></CollapsibleTrigger><CollapsibleContent><ul className="oc-finance-sublist">{settlement.versions.flatMap((version, index) => (version.decisions ?? []).map((decision, decisionIndex) => <li key={`${version.id ?? index}-${decisionIndex}`}><span>方案 {version.versionNo ?? '—'} · {({ RENTER:'租客', OWNER:'号主', SUPPORT:'客服' } as Record<string,string>)[decision.party ?? ''] ?? '处理方未记录'} · {({ CONFIRM:'确认', REJECT:'拒绝', REVIEW:'复核', FINALIZE:'核实完成' } as Record<string,string>)[decision.action ?? ''] ?? '处理记录'} · {financeTime(decision.createdAt)}{decision.reason ? ` · ${decision.reason}` : ''}</span></li>))}</ul></CollapsibleContent></Collapsible> : null}
      </section>
      <section className="oc-finance-section" aria-label="余额入账"><div className="oc-finance-section-title"><Wallet aria-hidden size={17}/><h3>余额入账</h3></div>
        {balancedAllocation(evidence) && !legacy ? <div className="oc-finance-row"><div><strong>号主租赁收益</strong><small>{known(evidence.ownerNet) === '0' ? '本单结算净额为零' : `已记入号主可用余额 · ${financeTime(evidence.posting.postedAt)}`}</small></div><strong>{money(evidence.ownerNet)}</strong></div> : null}
        {ownerCredit.map((item,index)=><div className="oc-finance-row" key={item.documentRef ?? `owner-${index}`}><div><strong>号主收益责任</strong><small>{item.state === 'SETTLED' && item.finalization === 'POSTED' && known(item.amount) !== null ? `已入账 · ${financeTime(item.postedAt)}` : item.finalization === 'FINALIZED_ZERO' && known(item.amount) === '0' ? '已核定为零' : '入账状态待核对'}</small></div><span>{money(item.amount)}</span><DocumentLink refId={item.documentRef} label="查看依据" onOpenDocument={onOpenDocument}/></div>)}
        {depositCompensation.map((item,index)=><div className="oc-finance-row" key={item.documentRef ?? `deposit-${index}`}><div><strong>押金补偿责任</strong><small>{item.state === 'SETTLED' && item.finalization === 'POSTED' && known(item.amount) !== null ? `已入账 · ${financeTime(item.postedAt)}` : item.finalization === 'FINALIZED_ZERO' && known(item.amount) === '0' ? '已核定为零' : '入账状态待核对'}</small></div><span>{money(item.amount)}</span><DocumentLink refId={item.documentRef} label="查看依据" onOpenDocument={onOpenDocument}/></div>)}
        {distribution ? <DistributionEntries distribution={distribution} onOpenDocument={onOpenDocument}/> : <p className="oc-finance-muted">本单分销记录可在订单详情中查看。</p>}
      </section>
      <section className="oc-finance-section" aria-label="退款记录"><div className="oc-finance-section-title"><CreditCard aria-hidden size={17}/><h3>退款</h3></div>
        {known(evidence.refundPayable) !== null ? <div className="oc-finance-row"><div><strong>本单应退责任</strong><small>{evidence.refundDueAt ? `最早处理时间 ${financeTime(evidence.refundDueAt)}` : '处理时间未记录'}</small></div><strong>{money(evidence.refundPayable)}</strong></div> : business?.settlementState === 'NOT_SETTLED' ? <p className="oc-finance-muted">结算后按本单实际情况确认应退金额。</p> : null}
        {renterDuties.map((item,index)=><div className="oc-finance-row" key={item.documentRef ?? `refund-duty-${index}`}><div><strong>退款责任依据</strong><small>{item.finalization === 'POSTED' ? '已记入应退账，不代表渠道到账' : item.finalization === 'FINALIZED_ZERO' && known(item.amount) === '0' ? '已核定为零' : '责任状态待核对'}</small></div><DocumentLink refId={item.documentRef} label="查看依据" onOpenDocument={onOpenDocument}/></div>)}
        {legacy && known(oldRefund) !== null && business?.settlementState !== 'LEGACY_RECORDED_COMPLETE' ? <div className="oc-finance-row"><div><strong>旧单退款金额原记</strong><small>原记录不等于渠道到账</small></div><span>{money(oldRefund)}</span></div> : null}
        {legacy && known(historicRefund) !== null && (known(oldRefund) === null || oldRefundMismatch) ? <div className="oc-finance-row"><div><strong>旧单历史退款原记</strong><small>原记录不等于渠道到账</small></div><span>{money(historicRefund)}</span></div> : null}
        {oldRefundMismatch ? <p className="oc-finance-warning">旧订单的退款原记金额不一致，请核对来源。</p> : null}
        <RefundRecords rows={refunds} onOpenDocument={onOpenDocument}/>
        {!legacy ? <p className="oc-finance-muted">{refundSummaryScope(refundSummary)}</p> : <p className="oc-finance-muted">旧退款按原付款与历史记录核对；迁入后可按权限办理符合条件的退款。</p>}
      </section>
    </>}
  </section>;
}
