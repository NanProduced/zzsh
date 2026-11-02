import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleAlert, RefreshCw } from 'lucide-react';
import { ADMIN_AUTH_FAILURE_EVENT, AdminApiError, friendlyError, type SessionSnapshot } from '../api';
import { Button } from '@/components/ui/button';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { bucketLabels, bucketNature, financeMoney, financeOverviewRead, financeTime, FINANCE_ACCESS_FAILURE_EVENT, type FinanceOverview, type FinanceOverviewQueue } from './admin-finance-api';
import { financeContextIdentity, registerFinanceOrigin } from './admin-finance-view';
import { canOpenKind, parseWorkspacePath, type WorkspaceTab } from '../workspace/tab-model';
import './admin-finance.css';
import { obligationSourceLabel, refundObligationLabel, withdrawalObligationLabel } from '@zzsh/ui/display-funds';

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
const ranges = { today: '今天', '7d': '近7天', '30d': '近30天' } as const;

export function FinanceOverviewView({ tab, snapshot, refreshNonce, onOpenPath, onQueryChange, onRefresh }: {
  tab: WorkspaceTab; snapshot: Snapshot; refreshNonce: number; onOpenPath: (path: string, title?: string) => void;
  onQueryChange: (query: Record<string, string>) => void; onRefresh: () => Promise<SessionSnapshot>;
}) {
  const range = tab.query.range === 'today' || tab.query.range === '30d' ? tab.query.range : '7d';
  const identity = financeContextIdentity(snapshot), active = snapshot.security.status === 'ACTIVE' && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const allowed = active && snapshot.permissions.includes('finance.read');
  const key = JSON.stringify([identity, active, range, refreshNonce]);
  const [result, setResult] = useState<{ key: string; value: FinanceOverview }>();
  const [failure, setFailure] = useState<{ key: string; error: unknown }>();
  const [retry, setRetry] = useState(0), sequence = useRef(0);
  const data = allowed && result?.key === key ? result.value : undefined, error = failure?.key === key ? failure.error : undefined;

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
        window.dispatchEvent(new CustomEvent(FINANCE_ACCESS_FAILURE_EVENT)); void onRefresh().catch(() => undefined);
      }
    });
    return () => { controller.abort(); window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, clear); };
  }, [key, allowed, range, retry]);

  function open(path: string, title?: string) {
    const target = parseWorkspacePath(path);
    if (!canOpenKind(target.kind, { permissions: snapshot.permissions, isBoss: snapshot.security.isBoss })) return;
    const source = `/finance?range=${range}`, origin = registerFinanceOrigin(source, identity);
    const query = new URLSearchParams({ origin, financeReturn: source });
    onOpenPath(`${path}${path.includes('?') ? '&' : '?'}${query}`, title);
  }

  function documentLink(ref: string | null | undefined, number: string) {
    return ref && snapshot.permissions.includes('finance.document.read') ? <Button variant="link" onClick={() => open(`/finance/documents/${encodeURIComponent(ref)}`, number)}>{number}<ArrowUpRight aria-hidden size={14}/></Button> : <strong>{number}</strong>;
  }

  function queue(title: string, value: FinanceOverviewQueue | undefined, type: 'refund' | 'withdrawal') {
    const readable = value?.knowledge === 'KNOWN' || value?.knowledge === 'PARTIAL';
    const sourceLabel = (source: string) => obligationSourceLabel(source);
    // 提现与退款是两个队列域：站内记账、渠道结果、银行到账分述，未知值不回显英文码。
    const statusLabel = (status: string, kind: 'refund' | 'withdrawal', source: string) => kind === 'withdrawal' ? withdrawalObligationLabel(source, status) : refundObligationLabel(status);
    return <section className="finance-task-group"><h3>{title}</h3>{readable ? <>
      <p><strong className="tabular-nums">{value.count ?? '未取得'} 笔 · {value.knowledge === 'PARTIAL' ? '已知金额小计 ' : ''}{financeMoney(value.amountCents)}</strong>{value.unknownCount !== '0' ? <span> · {value.unknownCount ?? '未取得'} 笔金额待核</span> : null}{value.overdueCount != null ? <span> · 已到期 {value.overdueCount} 笔</span> : null}</p>
      {type === 'refund' && value.unknownDueCount != null && value.unknownDueCount !== '0' ? <p className="finance-secondary">{value.unknownDueCount} 笔未取得到期时间；到期笔数仅覆盖已知时间记录。</p> : null}
      {value.items.length ? <ul className="finance-task-list">{value.items.map(item => <li key={item.id}><div>{documentLink(item.documentRef, item.number ?? '查看原责任记录')}<small>{sourceLabel(item.source ?? '')} · {statusLabel(item.status ?? '', type, item.source ?? '')}{item.dueAt ? ` · ${item.overdue ? '已到期' : '责任到期'} ${financeTime(item.dueAt)}` : ''}</small></div><div className="finance-task-amount"><span className="tabular-nums">{financeMoney(item.amountCents)}</span>{item.amountCents == null && item.recordedAmountCents != null ? <small>原记录 {financeMoney(item.recordedAmountCents)}</small> : null}</div></li>)}</ul> : value.count === '0' ? <p className="finance-secondary">当前范围没有待核事项。</p> : <p className="finance-secondary">本次未取得可展示的记录摘要。</p>}
      {value.hasMore ? <p className="finance-secondary">仅展示最前5笔；合计与未知条数覆盖本队列读取范围。</p> : null}
      <p className="finance-secondary">仅本站已登记责任。本站申请与核销记录、渠道结果和银行到账分别核对。</p>
      {type === 'withdrawal' ? <p className="finance-secondary">金额是经核的当前预留扣减小计，非应出款净额；提现未定义到期时限，按原申请核对。</p> : null}
    </> : <p className="finance-secondary">待办依据尚未取得，不能判断为0笔。</p>}</section>;
  }

  return <section className="finance-page finance-overview" aria-labelledby="finance-overview-title">
    <header className="finance-page-header">
      <h1 id="finance-overview-title">财务总览</h1>
      <div className="finance-page-actions">
        {Object.entries(ranges).map(([value, text]) => <Button key={value} variant="outline" aria-pressed={range === value} className={range === value ? 'primary' : ''} onClick={() => onQueryChange({ range: value })}>{text}</Button>)}
        <Button variant="outline" aria-label="刷新财务总览" onClick={() => setRetry(value => value + 1)}><RefreshCw aria-hidden size={15}/></Button>
      </div>
    </header>
    {!allowed ? <Alert variant="warning" role="status"><AlertTitle>当前身份没有完整资金读取能力</AlertTitle><AlertDescription>财务总览需要资金读取权限。{snapshot.permissions.includes('finance.document.read') ? <Button variant="link" onClick={() => onOpenPath('/finance/search', '资金查找')}>进入资金查找<ArrowUpRight size={14}/></Button> : null}</AlertDescription></Alert> : error ? <Alert variant="warning" role="status"><CircleAlert aria-hidden/><AlertTitle>财务总览暂不可读取</AlertTitle><AlertDescription>{error instanceof AdminApiError && error.status === 404 ? '当前服务尚未提供财务总览，请等待同版服务就绪。' : friendlyError(error)} 这不表示本期金额或待办为零。</AlertDescription><AlertAction><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重新读取</Button></AlertAction></Alert> : !data ? <div className="finance-loading" role="status" aria-busy="true"><p>正在读取同一时点的款项、待办和账内余额…</p><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/></div> : <>
      <div className="finance-applied"><strong>{ranges[range]} · 北京时间</strong><span>{financeTime(data.period.from)} 至 {financeTime(data.period.to)}</span><small>数据截止 {financeTime(data.asOf)}</small></div>

      {/* 4组核心指标卡：运营快速扫读 */}
      <div className="finance-kpi-grid">
        <div className="finance-kpi-card">
          <div className="finance-kpi-title">本站确认付款 (含押金)</div>
          <div className="finance-kpi-value">{financeMoney(data.confirmedPayments.amountCents)}</div>
          <div className="finance-kpi-meta">{data.confirmedPayments.count} 笔 · 按付款确认时间</div>
          <div className="finance-kpi-sub">
            <span>受控: {financeMoney(data.confirmedPayments.controlledAmountCents)}</span>
            <span>渠道: {financeMoney(data.confirmedPayments.channelAmountCents)}</span>
          </div>
        </div>

        <div className="finance-kpi-card">
          <div className="finance-kpi-title">本期结算分配基数</div>
          <div className="finance-kpi-value">{financeMoney(data.settlements.capturedCents)}</div>
          <div className="finance-kpi-meta">{data.settlements.count} 笔 · 按结算入账时间</div>
          <div className="finance-kpi-sub">
            <span>号主净额: {financeMoney(data.settlements.ownerNetCents)}</span>
            <span>退款责任: {financeMoney(data.settlements.refundPayableCents)}</span>
          </div>
        </div>

        <div className="finance-kpi-card">
          <div className="finance-kpi-title">平台结算贡献</div>
          <div className="finance-kpi-value">{financeMoney(data.settlements.platformContributionCents)}</div>
          <div className="finance-kpi-meta">原入账基数扣减号主与应退</div>
          <div className="finance-kpi-sub">
            <span>未扣分销与渠道成本</span>
          </div>
        </div>

        <div className="finance-kpi-card">
          <div className="finance-kpi-title">净贡献</div>
          <div className="finance-kpi-value">{data.costs.netContributionCents === null ? '成本依据不完整，未计算' : financeMoney(data.costs.netContributionCents)}</div>
          <div className="finance-kpi-meta">渠道成本：{data.costs.channelCostState === 'KNOWN' ? '已核定' : '核算依据待核对'}</div>
          <div className="finance-kpi-sub">
            <span>本期结算订单的分销与渠道成本须逐笔核定</span>
          </div>
        </div>
      </div>

      {/* 主体双列：左侧结算流向与近期明细，右侧待办队列与账内余额 */}
      <div className="finance-overview-grid">
        <div className="finance-overview-main-col">
          {/* 本期款项与结算分配 */}
          <section className="finance-overview-section finance-card-section">
            <h2>本期款项与结算分配</h2>
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
                  <div><dt>号主结算净额</dt><dd>{financeMoney(data.settlements.ownerNetCents)}</dd></div>
                  <div><dt>租客应退责任</dt><dd>{financeMoney(data.settlements.refundPayableCents)}</dd></div>
                  <div><dt>平台结算贡献</dt><dd>{financeMoney(data.settlements.platformContributionCents)}</dd></div>
                </dl>
                <p className="finance-secondary">分配可能对应其他期间的付款；平台结算贡献未扣分销与渠道成本。</p>
              </section>
            </div>
          </section>

          {/* 本期最近结算 */}
          <section className="finance-overview-section finance-card-section">
            <h2>本期最近结算</h2>
            {data.recentSettlements?.length ? <div className="finance-recent-settlements">{data.recentSettlements.map(item => <article key={item.id}><div className="finance-section-heading">{documentLink(item.documentRef, item.number)}<small>{financeTime(item.postedAt)}</small></div><p>号主 {item.owner.name} · 租客 {item.renter.name}</p><dl className="finance-recent-amounts"><div><dt>原入账基数</dt><dd>{financeMoney(item.capturedCents)}</dd></div><div><dt>号主净额</dt><dd>{financeMoney(item.ownerNetCents)}</dd></div><div><dt>应退责任</dt><dd>{financeMoney(item.refundPayableCents)}</dd></div><div><dt>平台贡献</dt><dd>{financeMoney(item.platformContributionCents)}</dd></div></dl></article>)}</div> : <p className="finance-secondary">{data.recentSettlements ? '本期没有结算分配记录。' : '本次尚未取得最近结算摘要。'}</p>}
          </section>
        </div>

        <div className="finance-overview-side-col">
          {/* 待核处理（队列） */}
          <section className="finance-overview-section finance-card-section" aria-labelledby="finance-current-tasks-title">
            <div className="finance-section-heading">
              <h2 id="finance-current-tasks-title">待核处理</h2>
              <span>当前责任与状态，不限所选付款期间</span>
            </div>
            {queue('退款责任待核处理', data.queues.refunds, 'refund')}
            <section className="finance-task-group">
              <h3>本站确认付款，待结算分配</h3>
              <p><strong className="tabular-nums">{data.pendingSettlement.count} 笔 · {financeMoney(data.pendingSettlement.amountCents)}</strong></p>
              {data.pendingSettlement.items.length ? <ul className="finance-task-list">{data.pendingSettlement.items.map(item => <li key={item.id}><div>{documentLink(item.documentRef, item.number)}<small>确认付款 {financeTime(item.paidAt)}</small></div><span className="tabular-nums">{financeMoney(item.amountCents)}</span></li>)}</ul> : <p className="finance-secondary">当前没有已确认付款、待分配的订单。</p>}
              {data.pendingSettlement.hasMore ? <p className="finance-secondary">仅展示最早5笔；上方笔数与金额为当前队列合计。</p> : null}
              <p className="finance-secondary">待分配不等于逾期；原APPLIED确认与后续分配分别核对。</p>
            </section>
            {queue('提现结果待核', data.queues.withdrawals, 'withdrawal')}
          </section>

          {/* 当前账内余额 */}
          <section className="finance-overview-section finance-card-section">
            <div className="finance-section-heading">
              <h2>当前账内余额</h2>
              <Button variant="outline" onClick={() => onOpenPath('/finance/period', '期间核对')}>进入期间核对<ArrowUpRight size={14}/></Button>
            </div>
            <p className="finance-secondary">截至 {financeTime(data.asOf)}，仅已入账分录；用户负债、平台权益与清算过渡分别核对。</p>
            <dl className="finance-balance-list">
              {data.ledgerBalances.map(row => <div key={row.bucket}>
                <dt>{bucketLabels[row.bucket] ?? '资金类别待核'}<small>{bucketNature[row.bucket] ?? '性质待核'}</small></dt>
                <dd className="tabular-nums">{financeMoney(row.state === 'KNOWN' ? row.balanceCents : null)}</dd>
              </div>)}
            </dl>
          </section>

          {/* 证明与外部资金 */}
          <section className="finance-overview-section finance-card-section">
            <h2>证明与外部资金</h2>
            <dl className="finance-fact-list">
              <div><dt>全平台余额证明</dt><dd>尚未取得<small>已登记 {data.coverage.registeredSubjects} 个主体 / 当前 {data.coverage.totalCurrentSubjects} 个主体；登记覆盖不能代替完整来源证明。</small></dd></div>
              <div><dt>渠道／银行现金</dt><dd>{data.channels.state === 'NOT_CONFIGURED' ? '渠道尚未配置' : '尚未取得余额快照'}<small>账内合计及零差额不能证明外部资金已对平。</small></dd></div>
              <div><dt>净贡献</dt><dd>{data.costs.netContributionCents === null ? '成本依据不完整，未计算' : financeMoney(data.costs.netContributionCents)}<small>本单分销与渠道成本须按原根关联核定。</small></dd></div>
            </dl>
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
