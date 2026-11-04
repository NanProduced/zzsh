import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleAlert, RefreshCw, ArrowDownLeft, CreditCard, Wallet, ShieldCheck } from 'lucide-react';
import { BarChart, CartesianGrid, ChartBar, ChartContainer, ChartTooltip, ChartTooltipContent, XAxis, YAxis, type ChartConfig } from '../components/ui/chart';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { parseWorkspacePath, canOpenKind, type WorkspaceTab } from '../workspace/tab-model';
import { ADMIN_AUTH_FAILURE_EVENT, AdminApiError, friendlyError, type SessionSnapshot } from '../api';
import { obligationSourceLabel, refundObligationLabel, withdrawalObligationLabel } from '@zzsh/ui/display-funds';
import { bucketLabels, bucketNature, financeMoney, financeOverviewRead, financeTime, FINANCE_ACCESS_FAILURE_EVENT, type FinanceOverview, type FinanceOverviewQueue } from './admin-finance-api';
import { financeContextIdentity, registerFinanceOrigin } from './admin-finance-view';
import './admin-finance.css';

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
const ranges: Record<FinanceOverview['period']['range'], string> = {
  today: '今天',
  '7d': '近7天',
  '30d': '近30天',
};

export function FinanceOverviewView({ tab, snapshot, refreshNonce, onOpenPath, onQueryChange, onRefresh }: {
  tab: WorkspaceTab; snapshot: Snapshot; refreshNonce: number; onOpenPath: (path: string, title?: string) => void;
  onQueryChange: (query: Record<string, string>) => void; onRefresh?: () => Promise<SessionSnapshot>;
}) {
  const range = tab.query.range === 'today' || tab.query.range === '30d' ? tab.query.range : '7d';
  const identity = financeContextIdentity(snapshot);
  const active = snapshot.security.status === 'ACTIVE' && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const allowed = active && snapshot.permissions.includes('finance.read');
  const key = JSON.stringify([identity, active, range, refreshNonce]);
  const [result, setResult] = useState<{ key: string; value: FinanceOverview }>();
  const [failure, setFailure] = useState<{ key: string; error: unknown }>();
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const data = allowed && result?.key === key ? result.value : undefined;
  const error = failure?.key === key ? failure.error : undefined;

  useEffect(() => {
    const controller = new AbortController(), request = ++sequence.current;
    const clear = () => { sequence.current++; controller.abort(); setResult(undefined); setFailure(undefined); };
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, clear);
    setResult(undefined); setFailure(undefined);
    if (allowed) void financeOverviewRead(range, controller.signal).then(value => {
      if (controller.signal.aborted || request !== sequence.current) return;
      if (value.version !== 'admin.finance-overview.v1' || value.period?.range !== range) throw new AdminApiError(503, 'EVIDENCE_UNAVAILABLE');
      setResult({ key, value });
    }).catch(cause => {
      if (controller.signal.aborted || request !== sequence.current) return;
      setFailure({ key, error: cause });
      if (cause instanceof AdminApiError && [401, 403, 423].includes(cause.status)) {
        window.dispatchEvent(new CustomEvent(FINANCE_ACCESS_FAILURE_EVENT)); void onRefresh?.().catch(() => undefined);
      }
    });
    return () => { controller.abort(); window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, clear); };
  }, [key, allowed, range, retry]);

  function open(path: string, title?: string) {
    const target = parseWorkspacePath(path.split('?')[0] ?? path);
    if (!canOpenKind(target.kind, { permissions: snapshot.permissions, isBoss: snapshot.security.isBoss })) return;
    const source = `/finance?range=${range}`, origin = registerFinanceOrigin(source, identity);
    const query = new URLSearchParams({ origin, financeReturn: source });
    onOpenPath(`${path}${path.includes('?') ? '&' : '?'}${query}`, title);
  }

  function filterActiveRefundQueue(queue: FinanceOverviewQueue | undefined): FinanceOverviewQueue | undefined {
    if (!queue) return queue;
    if (queue.sources && Array.isArray(queue.sources)) {
      const activeSources = queue.sources.filter(s => s.source !== 'LEGACY_DUTY');
      const activeCount = activeSources.reduce((sum: bigint, s) => sum + BigInt(s.count), 0n);
      const activeAmount = activeSources.reduce((sum: bigint, s) => sum + BigInt(s.amountCents), 0n);
      const activeUnknownCount = activeSources.reduce((sum: bigint, s) => sum + BigInt(s.unknownCount), 0n);
      const activeItems = queue.items.filter(item => item.source !== 'LEGACY_DUTY');
      return {
        ...queue,
        knowledge: activeUnknownCount === 0n ? 'KNOWN' : 'PARTIAL',
        count: activeCount.toString(),
        amountCents: activeAmount.toString(),
        unknownCount: activeUnknownCount.toString(),
        overdueCount: activeCount === 0n ? '0' : queue.overdueCount,
        unknownDueCount: activeCount === 0n ? '0' : queue.unknownDueCount,
        items: activeItems,
        hasMore: activeItems.length < Number(activeCount),
      };
    }
    const legacyItems = queue.items.filter(i => i.source === 'LEGACY_DUTY');
    if (legacyItems.length > 0 && legacyItems.length === queue.items.length && queue.amountCents === '0') {
      return {
        ...queue,
        knowledge: 'KNOWN',
        count: '0',
        amountCents: '0',
        unknownCount: '0',
        overdueCount: '0',
        unknownDueCount: '0',
        items: [],
        hasMore: false,
      };
    }
    return queue;
  }

  function documentLink(ref: string | null | undefined, number: string) {
    return ref && snapshot.permissions.includes('finance.document.read') ? <Button variant="link" onClick={() => open(`/finance/documents/${encodeURIComponent(ref)}`, number)}>{number}<ArrowUpRight aria-hidden size={14}/></Button> : <strong>{number}</strong>;
  }

  const activeRefunds = filterActiveRefundQueue(data?.queues.refunds);
  const userAvailableBalance = data?.ledgerBalances.find(b => b.bucket === 'AVAILABLE')?.balanceCents ?? '0';

  const fundFlowData = data ? [
    { name: '用户实付', amount: Number(BigInt(data.confirmedPayments.amountCents || '0')) / 100 },
    { name: '完结结算', amount: Number(BigInt(data.settlements.capturedCents || '0')) / 100 },
    { name: '号主收益', amount: Number(BigInt(data.settlements.ownerNetCents || '0')) / 100 },
    { name: '平台分成', amount: Number(BigInt(data.settlements.platformContributionCents || '0')) / 100 },
  ] : [];

  const chartConfig: ChartConfig = {
    amount: { label: '金额 (元)', color: 'var(--chart-receipts, #3b82f6)' },
  };

  return <section className="finance-page finance-overview" aria-labelledby="finance-overview-title">
    <header className="finance-page-header">
      <div>
        <h1 id="finance-overview-title">财务总览</h1>
        <p className="text-xs text-muted-foreground mt-1">监控平台与汇聚支付三类核心资金往来（付款、退款、提现）及账户资产存量</p>
      </div>
      <div className="finance-page-actions">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="group" aria-label="时间范围">
          {Object.entries(ranges).map(([value, text]) => <Button key={value} variant={range === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={range === value} className="min-h-8" onClick={() => onQueryChange({ range: value })}>{text}</Button>)}
        </div>
        <Button variant="outline" size="sm" aria-label="刷新财务总览" onClick={() => setRetry(value => value + 1)}><RefreshCw aria-hidden size={14} className="mr-1"/>刷新</Button>
      </div>
    </header>

    {!allowed ? <Alert variant="warning" role="status"><AlertTitle>当前身份没有完整资金读取能力</AlertTitle><AlertDescription>财务总览需要资金读取权限。{snapshot.permissions.includes('finance.document.read') ? <Button variant="link" onClick={() => onOpenPath('/finance/search', '资金查找')}>进入资金查找<ArrowUpRight size={14}/></Button> : null}</AlertDescription></Alert> : error ? <Alert variant="warning" role="status"><CircleAlert aria-hidden/><AlertTitle>财务总览暂不可读取</AlertTitle><AlertDescription>{error instanceof AdminApiError && error.status === 404 ? '当前服务尚未提供财务总览，请等待同版服务就绪。' : friendlyError(error)} 这不表示本期金额或待办为零。</AlertDescription><AlertAction><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重新读取</Button></AlertAction></Alert> : !data ? <div className="finance-loading" role="status" aria-busy="true"><p>正在读取同一时点的款项、待办和账内余额…</p><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/></div> : <>
      <div className="finance-dashboard-subbar">
        <span>统计范围：<strong>{ranges[range]}</strong>（{financeTime(data.period.from)} 至 {financeTime(data.period.to)} · 北京时间）</span>
        <span>数据截止：{financeTime(data.asOf)}</span>
      </div>

      {/* 第一层：核心经营指标（4张 KPI 指标卡） */}
      <div className="finance-section-heading">
        <div>
          <h2>经营指标</h2>
          <span className="finance-scope-badge">{ranges[range]} · 所选期间</span>
        </div>
      </div>
      <div className="finance-kpi-grid">
        <div className="finance-kpi-card">
          <div className="finance-kpi-title">用户实付流水 (付款)</div>
          <div className="finance-kpi-value">{financeMoney(data.confirmedPayments.amountCents)}</div>
          <div className="finance-kpi-meta">{data.confirmedPayments.count} 笔 · 按付款确认时间</div>
          <div className="finance-kpi-sub">
            <span>受控: {financeMoney(data.confirmedPayments.controlledAmountCents)}</span>
            <span>渠道: {financeMoney(data.confirmedPayments.channelAmountCents)}</span>
          </div>
        </div>

        <div className="finance-kpi-card">
          <div className="finance-kpi-title">完结订单结算</div>
          <div className="finance-kpi-value">{financeMoney(data.settlements.capturedCents)}</div>
          <div className="finance-kpi-meta">{data.settlements.count} 笔 · 按结算入账时间</div>
          <div className="finance-kpi-sub">
            <span>号主净额: {financeMoney(data.settlements.ownerNetCents)}</span>
            <span>本期结算应退: {financeMoney(data.settlements.refundPayableCents)}</span>
          </div>
        </div>

        <div className="finance-kpi-card">
          <div className="finance-kpi-title">平台毛收益 (分成)</div>
          <div className="finance-kpi-value">{financeMoney(data.settlements.platformContributionCents)}</div>
          <div className="finance-kpi-meta">原入账基数扣减号主与应退</div>
          <div className="finance-kpi-sub">
            <span>未扣分销与渠道成本</span>
          </div>
        </div>

        <div className="finance-kpi-card">
          <div className="finance-kpi-title">平台净收益 (测算)</div>
          <div className="finance-kpi-value text-lg leading-snug">{data.costs.netContributionCents === null ? '成本依据不完整，未计算' : financeMoney(data.costs.netContributionCents)}</div>
          <div className="finance-kpi-meta">渠道成本：{data.costs.channelCostState === 'KNOWN' ? '已核定' : '核算依据待核对'}</div>
          <div className="finance-kpi-sub">
            <span>本期结算订单的分销与渠道成本须逐笔核定</span>
          </div>
        </div>
      </div>

      {/* EvilCharts 资金流向分布图表 */}
      <div className="finance-chart-card">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold">业务资金流向分布</h3>
            <p className="text-xs text-muted-foreground mt-0.5">对比所选期间内用户支付、完结订单结算与分成去向</p>
          </div>
          <span className="text-xs text-muted-foreground">单位：元</span>
        </div>
        <ChartContainer config={chartConfig} label="资金流向对比" height={150}>
          <BarChart data={fundFlowData} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(val) => `¥${val}`} />
            <ChartTooltip content={<ChartTooltipContent formatValue={(point) => typeof point.amount === 'number' ? `¥${point.amount.toFixed(2)}` : '¥0.00'} />} />
            <ChartBar dataKey="amount" radius={4} />
          </BarChart>
        </ChartContainer>
      </div>

      {/* 第二层：汇聚支付三类核心资金往来动态（付款 · 退款 · 提现） */}
      <section className="finance-overview-section finance-card-section" aria-labelledby="finance-current-tasks-title">
        <div className="finance-section-heading">
          <div>
            <h2 id="finance-current-tasks-title">核心资金往来动态</h2>
            <span className="finance-scope-badge">对照平台与汇聚支付三类真实资金变动</span>
          </div>
          <span className="finance-secondary text-xs">用户付款（入账） → 订单退款（退款） → 余额提现（放款）</span>
        </div>
        <div className="finance-streams-grid">
          {/* 1. 付款 */}
          <article className="finance-stream-card">
            <div>
              <div className="finance-stream-card-header">
                <h3 className="finance-stream-title">
                  <CreditCard className="size-4 text-emerald-500" /> 用户付款 (收款)
                </h3>
                <span className="finance-stream-badge bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">实付接纳</span>
              </div>
              <p className="text-xs text-muted-foreground">用户向我们付款 · 订单交易款</p>
              <div className="finance-stream-metric">
                {data.pendingSettlement.count} 笔 · {financeMoney(data.pendingSettlement.amountCents)}
              </div>
              {data.pendingSettlement.items.length ? (
                <ul className="finance-task-list">
                  {data.pendingSettlement.items.map(item => (
                    <li key={item.id}>
                      <div>{documentLink(item.documentRef, item.number)}<small>确认付款 {financeTime(item.paidAt)}</small></div>
                      <span className="tabular-nums">{financeMoney(item.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="finance-stream-empty">当前没有已确认付款、待分配的订单。</p>
              )}
            </div>
            <div className="finance-stream-footer">
              <span>通过汇聚支付或本地受控渠道接纳入账</span>
              {data.pendingSettlement.count !== '0' ? (
                <Button variant="ghost" size="sm" onClick={() => open('/finance/search?kind=PAYMENT&state=ALL', '付款记录')}>查看全部<ArrowUpRight size={13}/></Button>
              ) : null}
            </div>
          </article>

          {/* 2. 退款 */}
          <article className="finance-stream-card">
            <div>
              <div className="finance-stream-card-header">
                <h3 className="finance-stream-title">
                  <ArrowDownLeft className="size-4 text-amber-500" /> 用户退款 (退款)
                </h3>
                <span className="finance-stream-badge bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">原单退还</span>
              </div>
              <p className="text-xs text-muted-foreground">我们向用户退款 · 原单售后退款</p>
              <div className="finance-stream-metric">
                {activeRefunds?.count ?? '0'} 笔 · {activeRefunds?.knowledge === 'PARTIAL' ? '已知金额小计 ' : ''}{financeMoney(activeRefunds?.amountCents)}
                {activeRefunds && activeRefunds.count !== '0' && activeRefunds.unknownCount !== '0' ? <span> · {activeRefunds.unknownCount} 笔金额待核</span> : null}
                {activeRefunds && activeRefunds.count !== '0' && activeRefunds.overdueCount != null ? <span> · 已到期 {activeRefunds.overdueCount} 笔</span> : null}
              </div>
              {activeRefunds?.knowledge === 'UNAVAILABLE' ? (
                <p className="finance-secondary">待办依据尚未取得，不能判断为0笔。</p>
              ) : activeRefunds?.items.length ? (
                <ul className="finance-task-list">
                  {activeRefunds.items.map(item => (
                    <li key={item.id}>
                      <div>{documentLink(item.documentRef, item.number ?? '查看原记录')}<small>{obligationSourceLabel(item.source ?? '')} · {refundObligationLabel(item.status ?? '')}{item.dueAt ? ` · 责任到期 ${financeTime(item.dueAt)}` : ''}</small></div>
                      <div className="finance-task-amount">
                        <span className="tabular-nums">{financeMoney(item.amountCents)}</span>
                        {item.amountCents == null && item.recordedAmountCents != null ? <small>原记录 {financeMoney(item.recordedAmountCents)}</small> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="finance-stream-empty">当前范围没有待核事项。</p>
              )}
            </div>
            <div className="finance-stream-footer">
              <span>仅统计需本站主动处理的活跃退款</span>
              {activeRefunds && activeRefunds.count !== '0' ? (
                <Button variant="ghost" size="sm" onClick={() => open('/finance/search?kind=REFUND&state=ALL', '待核退款责任')}>查看全部<ArrowUpRight size={13}/></Button>
              ) : null}
            </div>
          </article>

          {/* 3. 提现 */}
          <article className="finance-stream-card">
            <div>
              <div className="finance-stream-card-header">
                <h3 className="finance-stream-title">
                  <Wallet className="size-4 text-blue-500" /> 余额提现 (放款)
                </h3>
                <span className="finance-stream-badge bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">汇聚代付</span>
              </div>
              <p className="text-xs text-muted-foreground">用户提现余额 · 汇聚支付放款</p>
              <div className="finance-stream-metric">
                {data.queues.withdrawals.count ?? '0'} 笔 · {financeMoney(data.queues.withdrawals.amountCents)}
              </div>
              {data.queues.withdrawals.knowledge === 'UNAVAILABLE' ? (
                <p className="finance-secondary">待办依据尚未取得，不能判断为0笔。</p>
              ) : data.queues.withdrawals.items.length ? (
                <ul className="finance-task-list">
                  {data.queues.withdrawals.items.map(item => (
                    <li key={item.id}>
                      <div>{documentLink(item.documentRef, item.number ?? '查看提现')}<small>{obligationSourceLabel(item.source ?? '')} · {withdrawalObligationLabel(item.source ?? '', item.status ?? '')}</small></div>
                      <span className="tabular-nums">{financeMoney(item.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="finance-stream-empty">当前范围没有待核事项。</p>
              )}
            </div>
            <div className="finance-stream-footer">
              <span>用户申请提现，由汇聚代付放款至银行卡</span>
              {data.queues.withdrawals.count !== '0' ? (
                <Button variant="ghost" size="sm" onClick={() => open('/finance/search?kind=WITHDRAWAL&state=ALL', '待查提现')}>查看全部<ArrowUpRight size={13}/></Button>
              ) : null}
            </div>
          </article>
        </div>
      </section>

      {/* 第三层：双列仪表盘（左侧完结结算分配明细，右侧账户存量与资金池） */}
      <div className="finance-overview-grid">
        <div className="finance-overview-main-col">
          {/* 完结订单结算分配明细 */}
          <section className="finance-overview-section finance-card-section">
            <div className="finance-section-heading">
              <div>
                <h2>完结订单结算分配明细</h2>
                <span className="finance-scope-badge">{ranges[range]} · 发生额</span>
              </div>
            </div>
            <div className="finance-period-facts">
              <section>
                <h3>本站确认付款</h3>
                <p className="finance-period-amount">{financeMoney(data.confirmedPayments.amountCents)}</p>
                <p>{data.confirmedPayments.count} 笔 · 按付款确认时间</p>
                <dl className="finance-fact-list">
                  <div><dt>本地受控来源</dt><dd>{financeMoney(data.confirmedPayments.controlledAmountCents)}</dd></div>
                  <div><dt>渠道来源确认</dt><dd>{financeMoney(data.confirmedPayments.channelAmountCents)}</dd></div>
                </dl>
                <p className="finance-secondary">仅本平台原订单APPLIED确认；不含补款、保证金和旧平台观察，也不证明渠道清算或银行到账。</p>
              </section>
              <section>
                <h3>本期结算分配</h3>
                <p>{data.settlements.count} 笔 · 按结算入账时间</p>
                <dl className="finance-fact-list">
                  <div><dt>原入账基数</dt><dd>{financeMoney(data.settlements.capturedCents)}</dd></div>
                  <div><dt>号主结算净额</dt><dd>号主净额{financeMoney(data.settlements.ownerNetCents)}</dd></div>
                  <div><dt>本期结算应退</dt><dd>{financeMoney(data.settlements.refundPayableCents)}</dd></div>
                  <div><dt>平台结算贡献</dt><dd>{financeMoney(data.settlements.platformContributionCents)}</dd></div>
                </dl>
                <p className="finance-secondary">分配可能对应其他期间的付款；平台结算贡献未扣分销与渠道成本。</p>
              </section>
            </div>
          </section>

          {/* 本期最近结算 */}
          <section className="finance-overview-section finance-card-section">
            <div className="finance-section-heading">
              <h2>本期最近结算</h2>
              <span className="finance-scope-badge">{ranges[range]} · 最近入账</span>
            </div>
            {data.recentSettlements?.length ? <div className="finance-recent-settlements">{data.recentSettlements.map(item => <article key={item.id}><div className="finance-section-heading">{documentLink(item.documentRef, item.number)}<small>{financeTime(item.postedAt)}</small></div><p>号主 {item.owner.name} · 租客 {item.renter.name}</p><dl className="finance-recent-amounts"><div><dt>原入账基数</dt><dd>{financeMoney(item.capturedCents)}</dd></div><div><dt>号主净额</dt><dd>{financeMoney(item.ownerNetCents)}</dd></div><div><dt>应退责任</dt><dd>{financeMoney(item.refundPayableCents)}</dd></div><div><dt>平台贡献</dt><dd>{financeMoney(item.platformContributionCents)}</dd></div></dl></article>)}</div> : <p className="finance-secondary">{data.recentSettlements ? '本期没有结算分配记录。' : '本次尚未取得最近结算摘要。'}</p>}
          </section>
        </div>

        <div className="finance-overview-side-col">
          {/* 账户存量与资金池看板 (当前账内余额) */}
          <section className="finance-overview-section finance-card-section">
            <div className="finance-section-heading">
              <div>
                <h2>当前账内余额</h2>
                <span className="finance-scope-badge">当前时点 · 账面存量</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => onOpenPath('/finance/period', '期间核对')}>进入期间核对<ArrowUpRight size={14}/></Button>
            </div>
            
            {/* 突出展示用户钱包可用总额 */}
            <div className="finance-balance-hero">
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-emerald-500" /> 用户钱包可用余额总额 (平台应付客户)
              </span>
              <div className="finance-balance-hero-val text-foreground">
                {financeMoney(userAvailableBalance)}
              </div>
              <p className="text-xs text-muted-foreground m-0">历史迁移存量已通过期初分录入账，与支付清算过渡科目平衡对冲。</p>
            </div>

            <dl className="finance-balance-list">
              {data.ledgerBalances.map(row => <div key={row.bucket}>
                <dt>{bucketLabels[row.bucket] ?? '资金类别待核'}<small>{bucketNature[row.bucket] ?? '性质待核'}</small></dt>
                <dd className="tabular-nums">{financeMoney(row.state === 'KNOWN' ? row.balanceCents : null)}</dd>
              </div>)}
            </dl>
          </section>

          {/* 证明与外部渠道状态 */}
          <section className="finance-overview-section finance-card-section">
            <div className="finance-section-heading">
              <h2>证明与外部资金</h2>
              <span className="finance-scope-badge">来源与证明状态</span>
            </div>
            <div className="finance-audit-tiles">
              <div className="finance-audit-tile">
                <dt>全平台余额证明</dt>
                <dd>
                  尚未取得
                  <small className="block text-[11px] text-muted-foreground mt-1">
                    已登记 {data.coverage.registeredSubjects} / {data.coverage.totalCurrentSubjects} 主体 ({data.coverage.totalCurrentSubjects && data.coverage.totalCurrentSubjects !== '0' ? Math.round((Number(data.coverage.registeredSubjects) / Number(data.coverage.totalCurrentSubjects)) * 100) : 0}%)
                  </small>
                </dd>
              </div>
              <div className="finance-audit-tile">
                <dt>渠道／银行现金</dt>
                <dd>
                  {data.channels.state === 'NOT_CONFIGURED' ? '渠道尚未配置' : '尚未取得余额快照'}
                  <small className="block text-[11px] text-muted-foreground mt-1">本地受控测试环境</small>
                </dd>
              </div>
              <div className="finance-audit-tile">
                <dt>净贡献测算</dt>
                <dd>
                  {data.costs.netContributionCents === null ? '成本依据不完整，未计算' : financeMoney(data.costs.netContributionCents)}
                  <small className="block text-[11px] text-muted-foreground mt-1">待核定渠道手续费</small>
                </dd>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* 底部独立卡片：异常收款原始记录 */}
      <section className="finance-overview-section finance-card-section" aria-labelledby="finance-review-records-title">
        <h2 id="finance-review-records-title">异常收款原始记录</h2>
        <p className="finance-secondary">原始记录集合不限所选付款期间。原记录可能已核销；当前待处理以退款责任队列为准。以下笔数与金额不代表当前待办或未核销责任。</p>
        {data.reviewPayments ? <>
          <p><strong className="tabular-nums">{data.reviewPayments.count} 笔原始记录 · 已知记录金额 {financeMoney(data.reviewPayments.amountCents)}</strong>{data.reviewPayments.unknownCount !== '0' ? <span> · {data.reviewPayments.unknownCount} 笔记录金额待核</span> : null}</p>
          {data.reviewPayments.items.length ? <ul className="finance-task-list">{data.reviewPayments.items.map(item => <li key={item.id}><div>{documentLink(item.documentRef, item.number ?? '异常收款记录')}<small>记录时间 {financeTime(item.confirmedAt)} · 原因按原单核对</small></div><span className="tabular-nums">{financeMoney(item.amountCents)}</span></li>)}</ul> : <p className="finance-secondary">本次读取范围没有异常收款原始记录。</p>}
          {data.reviewPayments.hasMore ? <p className="finance-secondary">仅展示最前5笔，上方合计覆盖全部原始记录。</p> : null}
          <p className="finance-secondary">这些原始记录不计入本站确认付款；订单已取消仍可能保留迟到款记录。</p>
        </> : <p className="finance-secondary">本次尚未取得异常收款原始记录，不能判断为0笔。</p>}
      </section>
    </>}
  </section>;
}
