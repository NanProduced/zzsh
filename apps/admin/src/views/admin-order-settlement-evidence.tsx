import { ChevronDown, CircleAlert, ArrowUpRight } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { financeMoney, financeTime, reasonLabels, type OrderSettlementEvidence, type OrderSettlementMoney } from './admin-finance-api';

export type OrderSettlementReadState = 'loading' | 'ready' | 'forbidden' | 'missing' | 'unavailable' | 'conflict';
export const ORDER_SETTLEMENT_FLAT_KEYS = new Set(['postingCapturedCents', 'refundPayableCents', 'refundPaidCents', 'refundDueAt', 'postedAt', 'channelState', 'channelReference', 'refundPaymentReference', 'postedPlatformContributionCents']);
const money = (value: OrderSettlementMoney | undefined) => financeMoney(value?.knowledge === 'KNOWN' ? value.cents : null);
const dutyKinds: Record<string, string> = { RENTER_REFUND: '租客退款责任', OWNER_CREDIT: '号主收益责任', COMMISSION: '分销责任', DEPOSIT_COMPENSATION: '押金补偿责任' };
const dutyStates: Record<string, string> = { PENDING: '原责任待处理', MATURED: '原责任已成熟', SETTLED: '原责任已终定', VOID: '原责任已作废' };
function moneyRows(evidence: OrderSettlementEvidence): [string, OrderSettlementMoney][] {
  const platform = (evidence as OrderSettlementEvidence & { platformContribution?: OrderSettlementMoney }).platformContribution;
  return [[evidence.posting.state === 'FINALIZED_ZERO' ? '原收款依据金额' : '原入账基数', evidence.captured], [evidence.documentRef.startsWith('LEGACY_ORDER:') ? '号主租赁收益责任' : '号主结算净额', evidence.ownerNet], ['租客应退责任', evidence.refundPayable], ['退款出款记录', evidence.refunded],
    ...(platform ? [['本单已记平台结算贡献（非净利润）', platform] as [string, OrderSettlementMoney]] : []),
    ...(evidence.documentRef.startsWith('LEGACY_ORDER:') ? [['历史应退记录', evidence.historicalRefund] as [string, OrderSettlementMoney]] : [])];
}
const postingLabel = (evidence: OrderSettlementEvidence) => evidence.posting.state === 'FINALIZED_ZERO' ? '零额责任已终定' : evidence.posting.state === 'POSTED' ? '原过账已证实' : evidence.posting.state === 'NOT_POSTED' ? '当前未查到过账记录' : '过账待核';
export function orderSettlementSummary(evidence: OrderSettlementEvidence): string[] {
  return [(evidence.posting.state === 'FINALIZED_ZERO' ? '责任终定：' : '结算过账：') + postingLabel(evidence), ...moneyRows(evidence).map(([label, value]) => `${label}：${money(value)}`), '渠道到账：未核定'];
}

export function AdminOrderSettlementEvidence({ state = 'ready', evidence, requestId, paymentState, onRetry, onOpenDocument, embedded = false }: {
  state?: OrderSettlementReadState; evidence?: OrderSettlementEvidence; requestId?: string; paymentState?: string;
  onRetry?: () => void; onOpenDocument?: (documentRef: string, title?: string) => void; embedded?: boolean;
}) {
  const title = '结算与退款依据';
  const shell = embedded ? 'space-y-4' : 'space-y-4 rounded-lg border border-border bg-card p-4 text-card-foreground';
  if (state === 'loading') return <section data-order-settlement-evidence aria-busy="true" className={shell}><h2 className="text-base font-semibold">{title}</h2><p className="text-sm text-muted-foreground">正在读取资金依据…</p><Skeleton className="h-20 w-full" /></section>;
  if (state !== 'ready' || !evidence) {
    const message = state === 'forbidden' ? '当前无权读取本单资金依据' : state === 'missing' ? '未找到当前范围内可读的资金单据' : state === 'conflict' ? '资金依据已变化，请重新读取' : state === 'ready' ? '尚未提供受权订单资金依据' : '资金依据暂不可用';
    const warning = state === 'forbidden' || state === 'missing' || state === 'conflict';
    return <section data-order-settlement-evidence className="space-y-3"><h2 className="text-base font-semibold">{title}</h2><Alert variant={warning ? 'warning' : 'destructive'} role={warning ? 'status' : 'alert'}><CircleAlert aria-hidden /><AlertTitle>{message}</AlertTitle><AlertDescription><p>本次未取得完整依据，不能判断为没有过账、金额为零或退款完成。</p>{requestId ? <p className="break-all font-mono text-xs">请求编号：{requestId}</p> : null}</AlertDescription>{onRetry && state !== 'forbidden' ? <AlertAction><Button variant="outline" size="sm" onClick={onRetry}>重新读取资金依据</Button></AlertAction> : null}</Alert></section>;
  }
  const rows = moneyRows(evidence), reasons = [...new Set([...(evidence.reasonCodes ?? []), ...rows.flatMap(([, value]) => value?.reasonCodes ?? [])])];
  const visibleRows = evidence.posting.state === 'NOT_POSTED' ? rows.filter(([, value]) => value?.knowledge === 'KNOWN') : rows;
  const noPosting = evidence.posting.state === 'NOT_POSTED';
  return <section data-order-settlement-evidence className={shell}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{title}</h2><Badge variant={evidence.posting.state === 'UNKNOWN' ? 'warning' : 'outline'}>{postingLabel(evidence)}</Badge></div>
    {evidence.readiness !== 'READY' ? <p className="text-sm text-muted-foreground">部分资金依据暂未就绪，以下只展示已取得的独立事实。</p> : null}
    {visibleRows.length ? <dl className="space-y-3 text-sm">{visibleRows.map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{money(value)}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">当前未查到过账记录，没有已证实的实际结算金额；不以 0 或预付金额替代。</p>}
    <dl className="space-y-3 text-sm">
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">{evidence.posting.state === 'FINALIZED_ZERO' ? '责任终定时间' : '原过账时间'}</dt><dd>{financeTime(['POSTED', 'FINALIZED_ZERO'].includes(evidence.posting.state) ? evidence.posting.postedAt : null)}</dd></div>
      {!noPosting ? <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">退款责任到期</dt><dd>{financeTime(evidence.refundDueAt)}</dd></div> : null}
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">渠道到账</dt><dd>{paymentState === 'RECORDED_UNPAID' && noPosting ? '本站未记录付款，渠道另核' : paymentState === 'UNKNOWN' ? '支付事实待核' : '未核定'}</dd></div>
    </dl>
    <p className="text-xs leading-relaxed text-muted-foreground">读取完成不代表资金全部结清。应退责任、历史记录和退款出款记录分别核对，均不证明渠道到账。{(evidence as OrderSettlementEvidence & { platformContribution?: OrderSettlementMoney }).platformContribution ? "平台结算贡献不是净利润，未扣分销与渠道成本。" : ""}</p>
    {evidence.dutyRefs?.length ? <div className="space-y-2 border-t border-border pt-3"><h3 className="text-sm font-medium">关联责任记录</h3>{evidence.dutyRefs.map((duty, index) => <div key={`${duty.documentRef ?? 'unresolved'}:${index}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><div><span>{dutyKinds[duty.kind] ?? '责任记录'} · {dutyStates[duty.state] ?? '责任状态待核'}</span><span className="ml-2 tabular-nums">{money(duty.amount)}</span></div>{duty.documentRef && /^LEGACY_DUTY:[A-Za-z0-9_-]+$/.test(duty.documentRef) && onOpenDocument ? <Button data-duty-ref={duty.documentRef} variant="link" size="sm" className="h-auto px-0" onClick={() => onOpenDocument(duty.documentRef!, '责任资金依据')}>查看责任依据<ArrowUpRight aria-hidden size={13} /></Button> : <span className="text-xs text-muted-foreground">关联依据未核定</span>}</div>)}</div> : null}
    {reasons.length || evidence.posting.ref ? <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm" className="px-0" />}>依据与待核项<ChevronDown aria-hidden size={13} /></CollapsibleTrigger><CollapsibleContent className="space-y-2 pt-2 text-xs text-muted-foreground">{evidence.posting.ref ? <p className="break-all">{evidence.posting.state === 'FINALIZED_ZERO' ? '原责任依据' : '原过账引用'}：{evidence.posting.ref}</p> : null}{reasons.map(reason => <p key={reason}>{reasonLabels[reason] ?? '原始资金依据仍待核对'}<span className="ml-2 break-all font-mono">{reason}</span></p>)}</CollapsibleContent></Collapsible> : null}
  </section>;
}
