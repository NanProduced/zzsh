import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { parseWorkspacePath, canOpenKind, type WorkspaceTab } from '../workspace/tab-model';
import { ADMIN_AUTH_FAILURE_EVENT, AdminApiError, friendlyError, type SessionSnapshot } from '../api';
import { bucketLabels, bucketNature, financeMoney, financeOverviewRead, financeTime, FINANCE_ACCESS_FAILURE_EVENT, type FinanceOverview } from './admin-finance-api';
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

  function documentLink(ref: string | null, number: string) {
    return ref && snapshot.permissions.includes('finance.document.read') ? <Button variant="link" onClick={() => open('/finance/documents/' + encodeURIComponent(ref), number)}>{number}<ArrowUpRight aria-hidden size={14}/></Button> : <strong>{number}</strong>;
  }

  const legacy = data?.legacyOrderPayments;
  const legacyAmount = legacy?.state === 'RECORDED' && (legacy.count !== '0' || legacy.missingAmountCount === '0') ? legacy.knownAmountCents : null;
  return <section className="finance-page finance-overview" aria-labelledby="finance-overview-title">
    <header className="finance-page-header">
      <div>
        <h1 id="finance-overview-title">财务总览</h1>
        <p>查看订单实付、结算分配与当前账内余额。渠道交易在汇聚对账核对。</p>
      </div>
      <div className="finance-page-actions">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="group" aria-label="时间范围">
          {Object.entries(ranges).map(([value, text]) => <Button key={value} variant={range === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={range === value} className="min-h-8" onClick={() => onQueryChange({ range: value })}>{text}</Button>)}
        </div>
        <Button variant="outline" size="sm" aria-label="刷新财务总览" onClick={() => setRetry(value => value + 1)}><RefreshCw aria-hidden size={14}/>刷新</Button>
      </div>
    </header>

    {!allowed ? <Alert variant="warning" role="status"><AlertTitle>当前身份没有完整资金读取能力</AlertTitle><AlertDescription>财务总览需要资金读取权限。</AlertDescription></Alert> : error ? <Alert variant="warning" role="status"><CircleAlert aria-hidden/><AlertTitle>财务总览暂不可读取</AlertTitle><AlertDescription>{error instanceof AdminApiError && error.status === 404 ? '当前服务尚未提供财务总览，请等待同版服务就绪。' : friendlyError(error)}</AlertDescription><AlertAction><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重新读取</Button></AlertAction></Alert> : !data ? <div className="finance-loading" role="status" aria-busy="true"><p>正在读取财务指标和账内余额…</p><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/></div> : <>
      <div className="finance-dashboard-subbar">
        <span>{ranges[range]} · {financeTime(data.period.from)} 至 {financeTime(data.period.to)}（北京时间）</span>
        <span>数据截止 {financeTime(data.asOf)}</span>
      </div>

      <section aria-labelledby="finance-period-title">
        <div className="finance-section-heading"><h2 id="finance-period-title">期间经营金额</h2></div>
        <div className="finance-kpi-grid">
          <article className="finance-kpi-card">
            <h3 className="finance-kpi-title">新平台订单实付</h3>
            <div className="finance-kpi-value">{financeMoney(data.confirmedPayments.amountCents)}</div>
            <p className="finance-kpi-meta">{data.confirmedPayments.count} 笔 · 按付款确认时间</p>
            <div className="finance-kpi-sub">
              <span>汇聚来源 {financeMoney(data.confirmedPayments.channelAmountCents)}</span>
              <span>本地受控 {financeMoney(data.confirmedPayments.controlledAmountCents)}</span>
            </div>
            <p className="finance-kpi-meta">仅新平台原订单确认款。银行到账单独核对。</p>
          </article>
          <article className="finance-kpi-card">
            <h3 className="finance-kpi-title">旧平台订单实付记录</h3>
            <div className="finance-kpi-value">{financeMoney(legacyAmount)}</div>
            {legacy?.state === 'RECORDED' ? <>
              <p className="finance-kpi-meta">{legacy.count} 笔金额已知 · 按旧单付款时间{legacy.missingAmountCount !== '0' && legacyAmount !== null ? ' · 已知金额小计' : ''}</p>
              <p className="finance-kpi-meta">本期 {legacy.missingAmountCount} 笔金额未记录 · 来源中另有 {legacy.sourceUndatedCount} 笔付款时间未记录</p>
            </> : <p className="finance-kpi-meta">未取得旧订单付款汇总</p>}
          </article>
          <article className="finance-kpi-card">
            <h3 className="finance-kpi-title">新平台已入账结算</h3>
            <div className="finance-kpi-value">{financeMoney(data.settlements.capturedCents)}</div>
            <p className="finance-kpi-meta">{data.settlements.count} 单 · 按结算入账时间</p>
            <div className="finance-kpi-sub">
              <span>号主净额 {financeMoney(data.settlements.ownerNetCents)}</span>
              <span>应退责任 {financeMoney(data.settlements.refundPayableCents)}</span>
            </div>
          </article>
          <article className="finance-kpi-card">
            <h3 className="finance-kpi-title">平台结算贡献</h3>
            <div className="finance-kpi-value">{financeMoney(data.settlements.platformContributionCents)}</div>
            <p className="finance-kpi-meta">按新平台结算入账时间 · 分销与渠道成本另计</p>
            <div className="finance-kpi-sub"><span>净贡献 {data.costs.netContributionCents === null ? '成本依据不完整，未计算' : financeMoney(data.costs.netContributionCents)}</span></div>
          </article>
        </div>
      </section>

      <section className="finance-overview-section" aria-labelledby="finance-lookup-title">
        <div className="finance-section-heading"><h2 id="finance-lookup-title">业务单据与对账</h2></div>
        <div className="finance-page-actions">
          <Button variant="outline" onClick={() => open('/finance/records?kind=PAYMENT', '收款记录')}>收款记录<ArrowUpRight aria-hidden size={14}/></Button>
          <Button variant="outline" onClick={() => open('/finance/records?kind=REFUND', '退款记录')}>退款记录<ArrowUpRight aria-hidden size={14}/></Button>
          <Button variant="outline" onClick={() => open('/finance/records?kind=WITHDRAWAL', '提现记录')}>提现记录<ArrowUpRight aria-hidden size={14}/></Button>
          <Button variant="outline" onClick={() => open('/finance/channels', '汇聚对账')}>汇聚对账<ArrowUpRight aria-hidden size={14}/></Button>
        </div>
        <p className="finance-secondary">退款与提现的状态和金额按单据核对。汇聚渠道结果和银行到账各自取证。</p>
      </section>

      <div className="finance-overview-grid">
        <section className="finance-overview-section finance-card-section" aria-labelledby="finance-recent-title">
          <div className="finance-section-heading">
            <h2 id="finance-recent-title">新平台本期最近结算</h2>
            <span className="finance-scope-badge">按结算入账时间</span>
          </div>
          {data.recentSettlements?.length ? <div className="finance-recent-settlements">{data.recentSettlements.map(item => <article key={item.id}><div className="finance-section-heading">{documentLink(item.documentRef, item.number)}<small>{financeTime(item.postedAt)}</small></div><p>号主 {item.owner.name} · 租客 {item.renter.name}</p><dl className="finance-recent-amounts"><div><dt>原入账基数</dt><dd>{financeMoney(item.capturedCents)}</dd></div><div><dt>号主净额</dt><dd>{financeMoney(item.ownerNetCents)}</dd></div><div><dt>应退责任</dt><dd>{financeMoney(item.refundPayableCents)}</dd></div><div><dt>平台贡献</dt><dd>{financeMoney(item.platformContributionCents)}</dd></div></dl></article>)}</div> : <p className="finance-secondary">{data.recentSettlements ? '本期没有新平台已入账结算。' : '本次尚未取得新平台最近结算摘要。'}</p>}
        </section>

        <section className="finance-overview-section finance-card-section" aria-labelledby="finance-balances-title">
          <div className="finance-section-heading">
            <h2 id="finance-balances-title">当前账内余额</h2>
            <Button variant="outline" size="sm" onClick={() => open('/finance/period', '期间核对')}>进入期间核对<ArrowUpRight aria-hidden size={14}/></Button>
          </div>
          <p className="finance-secondary">截至 {financeTime(data.asOf)} · 仅已入账范围</p>
          <dl className="finance-balance-list">
            {data.ledgerBalances.map(row => <div key={row.bucket}>
              <dt>{bucketLabels[row.bucket] ?? '资金类别未记录'}<small>{bucketNature[row.bucket] ?? '性质未记录'}</small></dt>
              <dd className="tabular-nums">{financeMoney(row.state === 'KNOWN' ? row.balanceCents : null)}</dd>
            </div>)}
          </dl>
          <p className="finance-secondary">全平台余额证明未取得，已登记 {data.coverage.registeredSubjects} / {data.coverage.totalCurrentSubjects} 个主体。</p>
          <p className="finance-secondary">{data.channels.state === 'NOT_CONFIGURED' ? '汇聚渠道尚未配置' : '汇聚余额快照未取得'} · 银行到账未记录</p>
        </section>
      </div>
    </>}
  </section>;
}
