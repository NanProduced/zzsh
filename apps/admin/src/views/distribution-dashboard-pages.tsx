import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, Crown, RefreshCw, Search } from 'lucide-react';
import { BarChart, CartesianGrid, ChartBar, ChartContainer, ChartTooltip, XAxis, YAxis, type ChartConfig } from '@/components/ui/chart';
import { AdminApiError, adminRequest, hasPermission, type SessionSnapshot } from '../api';
import { formatBeijingDateTime } from '../workspace/beijing-time';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DistributionMaintenancePanel } from './distribution-maintenance-panel';
import { DistributionPolicyPanel, distributionPolicyAccess } from './distribution-policy-panel';
import { distributionState, parseDistributionOrder } from './distribution-workspace';
import {
  dashboardMoney, dashboardContextIdentity, dashboardFiltersFromQuery, dashboardQuery, eligibilityLabel, metricReason, money, readDashboardEarnings, readDashboardOverview,
  readDashboardParticipant, readDashboardParticipants, readDistributionRelations, reasonLabel, roleLabel, sourceLabel, stateLabel,
  type DashboardEarning, type DashboardFilters, type DashboardRanking,
} from './distribution-dashboard-model';

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type OpenPath = (path: string, title?: string) => void;

type PageProps = { snapshot: Snapshot; onOpenPath: OpenPath; query?: Record<string, string>; onQueryChange?: (query: Record<string, string>) => void; refreshNonce?: number };
const emptyQuery: Record<string, string> = {};
function useDashboardFilters(query: Record<string, string>, onQueryChange?: PageProps['onQueryChange']) {
  const incoming = dashboardFiltersFromQuery(query), navigation = JSON.stringify(incoming), seen = useRef(navigation);
  const [local, setLocal] = useState(incoming);
  const filters = seen.current === navigation ? local : incoming;
  useLayoutEffect(() => { if (seen.current !== navigation) { seen.current = navigation; setLocal(incoming); } }, [navigation]);
  const update = (patch: Partial<DashboardFilters>) => {
    const next = { ...filters, ...patch, page: patch.page ?? 1 }; setLocal(next);
    onQueryChange?.({ ...query, ...Object.fromEntries(dashboardQuery(next)) });
  };
  return { filters, update };
}
function useDashboardRead<T>(snapshot: Snapshot, request: string, allowed: boolean, load: (signal: AbortSignal) => Promise<T>, onFailure?: (reason: unknown) => void) {
  const key = JSON.stringify([dashboardContextIdentity(snapshot), request]), live = useRef(key), sequence = useRef(0);
  live.current = key;
  const latest = useRef({ load, onFailure }); latest.current = { load, onFailure };
  const [result, setResult] = useState<{ key: string; body: T } | null>(null), [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(), ticket = ++sequence.current, current = () => !controller.signal.aborted && live.current === key && ticket === sequence.current, reader = latest.current;
    setResult(null); setFailed(null);
    if (allowed) void reader.load(controller.signal).then(body => { if (current()) setResult({ key, body }); }).catch(reason => {
      if (current()) { setResult(null); setFailed({ key, text: failure(reason) }); reader.onFailure?.(reason); }
    });
    return () => { controller.abort(); sequence.current++; };
  }, [key, allowed]);
  const read = allowed && result?.key === key ? result.body : null, error = allowed && failed?.key === key ? failed.text : '';
  return { read, error, busy: allowed && !read && !error };
}
function useDashboardList<T extends { snapshot: string | null }>(snapshot: Snapshot, filters: DashboardFilters, update: (patch: Partial<DashboardFilters>) => void, nonce: number, refreshNonce: number, load: (filters: DashboardFilters, token: string | null, signal: AbortSignal) => Promise<T>) {
  const basis = JSON.stringify([dashboardContextIdentity(snapshot), { ...filters, page: 1 }, nonce, refreshNonce]), token = useRef<{ basis: string; value: string | null }>({ basis, value: null });
  if (token.current.basis !== basis) token.current = { basis, value: null };
  return useDashboardRead(snapshot, JSON.stringify([filters, nonce, refreshNonce]), can(snapshot, 'distribution.dashboard.read'), async signal => {
    let value = token.current.value;
    if (filters.page > 1 && !value) {
      const first = await load({ ...filters, page: 1 }, null, signal);
      if (signal.aborted || token.current.basis !== basis) return first;
      value = first.snapshot;
      if (!value) throw new AdminApiError(409, 'CONFLICT');
    }
    const body = await load(filters, value, signal);
    if (!signal.aborted && token.current.basis === basis) token.current.value = body.snapshot;
    return body;
  }, reason => { if (reason instanceof AdminApiError && reason.status === 409) { token.current.value = null; if (filters.page > 1) update({ page: 1 }); } });
}
function ReadDenied() { return <Alert variant="warning" role="status"><AlertTitle>当前身份没有这项分销读取权限。</AlertTitle></Alert>; }


const active = (snapshot: Snapshot) => snapshot.security.status === 'ACTIVE' && !snapshot.session.locked && !snapshot.security.passwordChangeRequired;
const can = (snapshot: Snapshot, permission: string) => active(snapshot) && (snapshot.security.isBoss || hasPermission(snapshot, permission));
const failure = (error: unknown) => error instanceof AdminApiError
  ? error.status === 403 ? '当前身份没有这项分销读取权限。' : error.status === 409 ? '数据已变化，请重新加载。' : error.status === 503 ? '分销读取来源尚未装配或暂不可用。' : '读取暂未完成，请稍后重试。'
  : '读取暂未完成，请稍后重试。';
const sourceOptions = { ALL: '全部来源', NATIVE: '本平台', LEGACY: '历史观察' };

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>{actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}</header>;
}
function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-border bg-card p-4 text-card-foreground ${className}`}>{children}</div>;
}
function MetricCard({ label, metric, note, countOnly = false }: { label: string; metric: { knowledge: 'KNOWN' | 'UNKNOWN'; cents: string | null; count: string | null; reasonCodes: string[] }; note?: string; countOnly?: boolean }) {
  return <Card><div className="flex items-start justify-between gap-2"><p className="text-sm text-muted-foreground">{label}</p>{metric.knowledge === 'UNKNOWN' ? <Badge variant="warning">未核定</Badge> : null}</div><p className="mt-2 text-2xl font-semibold tabular-nums">{countOnly ? (metric.knowledge === 'UNKNOWN' ? '未核定' : Number(metric.count ?? 0).toLocaleString('zh-CN')) : dashboardMoney(metric)}</p><p className="mt-1 text-xs text-muted-foreground">{metric.knowledge === 'UNKNOWN' ? metricReason(metric) : note ?? (metric.count !== null ? `${Number(metric.count).toLocaleString('zh-CN')} 条` : '')}</p></Card>;
}
function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void }) {
  return <label className="space-y-1 text-sm"><span className="text-muted-foreground">{label}</span><Select value={value} onValueChange={next => { if (next) onChange(next); }}><SelectTrigger aria-label={label}><SelectValue>{options[value] ?? value}</SelectValue></SelectTrigger><SelectContent>{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></label>;
}
function SourceBadge({ source }: { source: string }) { return <Badge variant={source === 'NATIVE' ? 'secondary' : 'outline'}>{sourceLabel(source)}</Badge>; }
function StateBadge({ state }: { state: string }) { return <Badge variant={state === 'SETTLED' ? 'success' : state === 'PENDING' ? 'warning' : state === 'RECOVERY_REQUIRED' ? 'destructive' : 'secondary'}>{stateLabel(state)}</Badge>; }
function rankingLabel(item: DashboardRanking) { return item.name ?? item.userId ?? '未命名'; }
function RankingList({ title, items, empty, onOpen, countMode = false, limit = 10 }: { title: string; items: DashboardRanking[]; empty: string; onOpen?: (item: DashboardRanking) => void; countMode?: boolean; limit?: number }) {
  return <Card><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2><span className="text-xs text-muted-foreground">Top {limit}</span></div>{items.length ? <ol className="divide-y divide-border">{items.map(item => <li key={`${item.userId ?? item.rank}-${item.rank}`}><button type="button" disabled={!onOpen} onClick={() => onOpen?.(item)} className="flex w-full items-center gap-3 py-2 text-left disabled:cursor-default"><span className="w-6 text-sm tabular-nums text-muted-foreground">{item.rank}</span>{item.rank <= 3 ? <Crown size={15} aria-hidden="true" /> : null}<span className="min-w-0 flex-1 truncate">{rankingLabel(item)}<span className="ml-2 text-xs text-muted-foreground">{item.roles.map(roleLabel).join(' / ')}</span></span><span className="tabular-nums">{countMode ? `${Number(item.count ?? 0).toLocaleString('zh-CN')} 个` : money(item.cents)}</span></button></li>)}</ol> : <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>}</Card>;
}

const distributionTrendConfig: ChartConfig = {
  yuan: { label: '入账', color: 'var(--primary)' },
};

export function distributionTrendTooltip(_value: unknown, _name: unknown, item: { payload?: { cents?: unknown } }): [string, string] {
  return [money(typeof item.payload?.cents === 'string' ? item.payload.cents : null), '入账'];
}
export function DistributionTrend({ points }: { points: { date: string; cents: string; knowledge: 'KNOWN' | 'UNKNOWN' }[] }) {
  const drawable = points.every(point => point.knowledge === 'KNOWN' && /^-?\d+$/.test(point.cents) && Number.isFinite(Number(point.cents) / 100));
  if (!drawable) return <div className="overflow-x-auto"><p className="mb-2 text-sm text-muted-foreground">部分趋势未核定或超出图形范围，以下保留原始金额。</p><Table aria-label="分销入账趋势明细"><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>入账金额</TableHead></TableRow></TableHeader><TableBody>{points.map(point => <TableRow key={point.date}><TableCell>{point.date}</TableCell><TableCell className="whitespace-normal break-all tabular-nums">{money(point.knowledge === 'KNOWN' ? point.cents : null)}</TableCell></TableRow>)}</TableBody></Table></div>;
  if (!points.some(point => BigInt(point.cents) !== 0n)) return <p className="py-8 text-center text-sm text-muted-foreground">当前范围暂无入账</p>;
  return <div className="h-56 w-full" role="img" aria-label="近 30 天本平台佣金入账趋势"><ChartContainer config={distributionTrendConfig} label="近 30 天本平台佣金入账趋势" height={224}><BarChart data={points.map(point => ({ date: point.date, cents: point.cents, yuan: Number(point.cents) / 100 }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} interval="preserveStartEnd" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" /><YAxis width={72} tickFormatter={(value: number) => `¥${Number(value).toFixed(2)}`} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" /><ChartTooltip formatter={distributionTrendTooltip} labelFormatter={(label: unknown) => String(label)} /><ChartBar dataKey="yuan" name="入账" /></BarChart></ChartContainer></div>;
}

export function DistributionOverviewPage({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const { filters, update } = useDashboardFilters(query, onQueryChange), [nonce, setNonce] = useState(0);
  const allowed = can(snapshot, 'distribution.dashboard.read');
  const { read, error, busy } = useDashboardRead(snapshot, JSON.stringify([filters, nonce, refreshNonce]), allowed, signal => readDashboardOverview(filters, signal));
  const canDirectory = can(snapshot, 'user.directory.read');
  const openUser = (userId: string | null) => { if (userId && canDirectory) onOpenPath(`/users/${encodeURIComponent(userId)}`, '用户详情'); };
  if (!allowed) return <ReadDenied/>;
  return <section className="space-y-5" data-distribution-overview>
    <PageHeader title="分销概览" description="当前原生与历史观察分开核对；金额只作奖励口径，不代表可提现或银行到账。" actions={<Button variant="outline" disabled={busy} onClick={() => setNonce(value => value + 1)}><RefreshCw aria-hidden="true" />刷新</Button>} />
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-sm"><span className="text-muted-foreground">开始日期</span><Input type="date" value={filters.from} onChange={event => update({ from: event.target.value })} /></label>
      <label className="space-y-1 text-sm"><span className="text-muted-foreground">结束日期</span><Input type="date" value={filters.to} onChange={event => update({ to: event.target.value })} /></label>
      <FilterSelect label="排行口径" value={filters.rankingBasis} options={{ CURRENT_SETTLED_STOCK: '累计已结算', PERIOD_SETTLED_FLOW: '期间入账' }} onChange={rankingBasis => update({ rankingBasis: rankingBasis as DashboardFilters['rankingBasis'] })} />
    </div>
    {error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>分销概览暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <p role="status" className="text-sm text-muted-foreground">正在读取分销概览…</p> : null}
    {read ? <>
      {read.scope.network !== 'AVAILABLE' ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>当前游戏范围只能查看佣金，不能查看全平台关系</AlertTitle><AlertDescription>{reasonLabel('GLOBAL_RELATION_SCOPE_UNAVAILABLE')}</AlertDescription></Alert> : null}
      <section className="space-y-3" aria-labelledby="distribution-native-stock">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="distribution-native-stock" className="font-semibold">当前原生</h2><span className="text-xs text-muted-foreground">本平台当前存量与期间发生额，不并入历史观察</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="当前已结算" metric={read.native.settled} note="本平台当前存量" />
          <MetricCard label="当前待结算" metric={read.native.pending} note="本平台当前存量" />
          <MetricCard label="当前待追回" metric={read.native.recovery} note="按已确认需要追回的金额" />
          <MetricCard label="期间入账" metric={read.flow.settled} note="按 SETTLE 事件时间" />
          <MetricCard label="期间新增计提" metric={read.flow.accrued} note="不等于入账" />
          <MetricCard label="本平台佣金订单" metric={read.native.orders} countOnly />
        </div>
      </section>
      <section className="space-y-3" aria-labelledby="distribution-legacy-stock">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="distribution-legacy-stock" className="font-semibold">历史观察（只读）</h2><span className="text-xs text-muted-foreground">旧平台观察，不代表当前钱包或本期入账；覆盖 {read.legacy.coverage === 'KNOWN' ? '已核定' : '待核定'}</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="历史已结算" metric={read.legacy.settled} note="旧平台观察，不是当前钱包" />
          <MetricCard label="历史待结算" metric={read.legacy.pending} note="旧平台观察" />
          <MetricCard label="历史失效" metric={read.legacy.expired} note="旧平台观察" />
          <MetricCard label="历史佣金订单" metric={read.legacy.orders} countOnly />
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">排行</h2><Button variant="outline" size="sm" disabled={busy} onClick={() => update({ rankingLimit: read.applied.rankingLimit === 10 ? 100 : 10 })}>{read.applied.rankingLimit === 10 ? '查看前 100' : '收起为前 10'}</Button></div>
      <div className="grid gap-4 xl:grid-cols-3">
        <RankingList title="佣金排行" items={read.rankings.nativeEarnings} empty="当前范围暂无已结算佣金" onOpen={item => openUser(item.userId)} limit={read.applied.rankingLimit} />
        <RankingList title="历史佣金观察" items={read.rankings.legacyEarnings} empty="当前范围暂无历史已结算观察" onOpen={item => openUser(item.userId)} limit={read.applied.rankingLimit} />
        <Card><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">直属计佣关系</h2><span className="text-xs text-muted-foreground">Top {read.applied.rankingLimit}</span></div>{read.rankings.directInvites.knowledge === 'KNOWN' ? <RankingList title="" items={read.rankings.directInvites.items} empty="暂无直属计佣关系" onOpen={item => openUser(item.userId)} countMode limit={read.applied.rankingLimit} /> : <p className="py-8 text-center text-sm text-muted-foreground">{reasonLabel(read.rankings.directInvites.reasonCodes[0] ?? 'GLOBAL_RELATION_SCOPE_UNAVAILABLE')}</p>}</Card>
      </div>
      <Card>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">关系与资格</h2><span className="text-xs text-muted-foreground">注册邀请与计佣关系分开统计</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="参与分销" metric={read.participants.participants} countOnly />
          <MetricCard label="当前有资格" metric={read.participants.eligible} countOnly />
          <MetricCard label="分佣冻结" metric={read.participants.frozen} countOnly />
          <MetricCard label="注册邀请来源" metric={read.participants.inviter} countOnly />
          <MetricCard label="直属计佣关系" metric={read.participants.leader} countOnly />
        </div>
      </Card>
      <Card><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">近 30 天入账趋势</h2><span className="text-xs text-muted-foreground">仅本平台 SETTLE 事件</span></div><DistributionTrend points={read.trend}/><div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{read.trend[0]?.date}</span><span>{read.trend.at(-1)?.date}</span></div></Card>
      <Card><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">最近佣金</h2><Button variant="link" onClick={() => onOpenPath('/distribution/earnings', '佣金明细')}>查看全部<ArrowRight aria-hidden="true" /></Button></div>{read.recent.length ? <EarningsRows rows={read.recent} snapshot={snapshot} onOpenPath={onOpenPath} /> : <p className="py-8 text-center text-sm text-muted-foreground">当前范围暂无佣金记录</p>}</Card>
    </> : null}
  </section>;
}

function EarningsRows({ rows, snapshot, onOpenPath }: { rows: DashboardEarning[]; snapshot: Snapshot; onOpenPath: OpenPath }) {
  const canOrder = can(snapshot, 'order.read'), canDirectory = can(snapshot, 'user.directory.read');
  const openUser = (row: DashboardEarning) => { if (row.beneficiaryId && canDirectory) onOpenPath(`/users/${encodeURIComponent(row.beneficiaryId)}`, '用户详情'); };
  return <><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>来源 / 受益人</TableHead><TableHead>角色</TableHead><TableHead>来源订单</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell><SourceBadge source={row.source} /><button type="button" className="mt-1 block text-left hover:underline" disabled={!row.beneficiaryId || !canDirectory} onClick={() => openUser(row)}>{row.beneficiaryName ?? row.beneficiaryId ?? '受益人待核'}</button></TableCell><TableCell>{roleLabel(row.role)}</TableCell><TableCell>{row.orderNumber ?? '—'}{row.orderId && canOrder ? <> <Button variant="link" size="sm" className="px-0" onClick={() => onOpenPath(`/orders/${encodeURIComponent(row.orderId!)}`, '来源订单')}>订单</Button></> : null}</TableCell><TableCell className="tabular-nums">{money(row.amountCents)}{row.recoveryRequiredCents !== null ? <div className="text-xs text-muted-foreground">待追回 {money(row.recoveryRequiredCents)}</div> : null}</TableCell><TableCell><StateBadge state={row.state} /></TableCell><TableCell><span>{formatBeijingDateTime(row.occurredAt)}</span><div className="text-xs text-muted-foreground">{row.settledAt ? `入账 ${formatBeijingDateTime(row.settledAt)}` : '入账时间未核定'}</div></TableCell></TableRow>)}</TableBody></Table></div>
    <ul className="divide-y divide-border md:hidden">{rows.map(row => <li key={row.id} className="space-y-2 py-3"><div className="flex items-center justify-between gap-2"><SourceBadge source={row.source} /><StateBadge state={row.state} /></div><button type="button" className="block text-left font-medium hover:underline disabled:cursor-default" disabled={!row.beneficiaryId || !canDirectory} onClick={() => openUser(row)}>{row.beneficiaryName ?? row.beneficiaryId ?? '受益人待核'}</button><div className="text-xs text-muted-foreground">{roleLabel(row.role)} · {row.orderNumber ?? '订单待核'}{row.orderId && canOrder ? <> · <button type="button" className="underline" onClick={() => onOpenPath(`/orders/${encodeURIComponent(row.orderId!)}`, '来源订单')}>订单</button></> : null}</div><div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{money(row.amountCents)}</span><span className="text-xs text-muted-foreground">{formatBeijingDateTime(row.occurredAt)}</span></div>{row.recoveryRequiredCents !== null ? <div className="text-xs text-destructive">待追回 {money(row.recoveryRequiredCents)}</div> : null}<div className="text-xs text-muted-foreground">{row.settledAt ? `入账 ${formatBeijingDateTime(row.settledAt)}` : '入账时间未核定'}</div></li>)}</ul></>;
}

export function DistributionEarningsPage({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const { filters, update } = useDashboardFilters(query, onQueryChange), [nonce, setNonce] = useState(0);
  const allowed = can(snapshot, 'distribution.dashboard.read'), identity = dashboardContextIdentity(snapshot);
  const liveQuery = useRef(query); liveQuery.current = query;
  const { read, error, busy } = useDashboardList(snapshot, filters, update, nonce, refreshNonce, readDashboardEarnings);
  const canOrder = allowed && can(snapshot, 'order.read'), orderKey = JSON.stringify([identity, canOrder]), liveOrderKey = useRef(orderKey);
  liveOrderKey.current = orderKey;
  const orderSequence = useRef(0), orderController = useRef<AbortController | null>(null), lastAuto = useRef('');
  const [orderQuery, setOrderQuery] = useState('');
  type Match = { id: string; displayNo: string; origin: 'NATIVE' | 'LEGACY' };
  type OrderState = { key: string; read: ReturnType<typeof parseDistributionOrder> | null; matches: Match[]; error: string; busy: boolean };
  const [orderState, setOrderState] = useState<OrderState | null>(null);
  const order = orderState?.key === orderKey ? orderState : null, orderRead = order?.read ?? null, orderMatches = order?.matches ?? [], orderError = order?.error ?? '', orderBusy = order?.busy ?? false;
  const autoKey = (target: { id: string; origin: string }) => JSON.stringify([orderKey, target.id, target.origin, nonce, refreshNonce]);
  const startOrder = () => { orderController.current?.abort(); const controller = new AbortController(), ticket = ++orderSequence.current; orderController.current = controller; setOrderState({ key: orderKey, read: null, matches: [], error: '', busy: true }); return { controller, ticket, key: orderKey }; };
  const current = (request: ReturnType<typeof startOrder>) => !request.controller.signal.aborted && request.ticket === orderSequence.current && request.key === liveOrderKey.current;
  const orderErrorState = (text: string) => setOrderState({ key: orderKey, read: null, matches: [], error: text, busy: false });
  async function loadOrder(target: { id: string; origin: 'NATIVE' | 'LEGACY' }, request = startOrder()) {
    lastAuto.current = autoKey(target);
    try {
      const value = parseDistributionOrder(await adminRequest<unknown>(`/distribution/orders/${target.origin}/${encodeURIComponent(target.id)}`, undefined, 'GET', {}, request.controller.signal));
      if (!current(request)) return;
      if (value.order.id !== target.id || value.order.origin !== target.origin) throw new AdminApiError(502, 'DISTRIBUTION_READ_CONTRACT_REQUIRED');
      setOrderState({ key: orderKey, read: value, matches: [], error: '', busy: false });
      onQueryChange?.({ ...liveQuery.current, orderId: target.id, origin: target.origin });
    } catch (reason) { if (current(request)) orderErrorState(failure(reason)); }
    finally { if (current(request)) setOrderState(state => state?.key === orderKey ? { ...state, busy: false } : state); }
  }
  async function lookupOrder() {
    const value = orderQuery.trim(); if (!canOrder || !value || orderBusy) return;
    const request = startOrder();
    try {
      const found = await adminRequest<{ items: { id: string; displayNo: string; source: { origin: 'NATIVE' | 'LEGACY' } }[]; total: number }>('/orders?' + new URLSearchParams({ page: '1', pageSize: '20', qKind: 'order', qValue: value }), undefined, 'GET', {}, request.controller.signal);
      if (!current(request)) return;
      if (!Array.isArray(found.items) || !Number.isInteger(found.total) || found.items.some(item => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(item.id) || typeof item.displayNo !== 'string' || !['NATIVE','LEGACY'].includes(item.source?.origin))) throw new Error('Invalid order matches');
      if (found.items.length === 1 && found.total === 1) await loadOrder({ id: found.items[0]!.id, origin: found.items[0]!.source.origin }, request);
      else if (found.items.length) setOrderState({ key: orderKey, read: null, matches: found.items.slice(0, 20).map(item => ({ id: item.id, displayNo: item.displayNo, origin: item.source.origin })), error: '', busy: false });
      else orderErrorState('没有找到可读的匹配订单；这不代表渠道没有记录。');
    } catch (reason) { if (current(request)) orderErrorState(failure(reason)); }
    finally { if (current(request)) setOrderState(state => state?.key === orderKey ? { ...state, busy: false } : state); }
  }
  useEffect(() => { orderController.current?.abort(); orderSequence.current++; lastAuto.current = ''; setOrderState(null); return () => { orderController.current?.abort(); orderSequence.current++; lastAuto.current = ''; }; }, [orderKey]);
  useEffect(() => {
    if (canOrder && query.orderId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(query.orderId) && (query.origin === 'NATIVE' || query.origin === 'LEGACY')) {
      const target: { id: string; origin: 'NATIVE' | 'LEGACY' } = { id: query.orderId, origin: query.origin }; if (lastAuto.current !== autoKey(target)) void loadOrder(target);
    }
  }, [orderKey, query.orderId, query.origin, nonce, refreshNonce]);
  if (!allowed) return <ReadDenied/>;
  const total = read ? Number(read.total) : 0, pages = Math.max(1, Math.ceil(total / filters.pageSize));
  return <section className="space-y-5" data-distribution-earnings>
    <PageHeader title="佣金明细" description="按来源、状态、角色核对奖励记录；历史观察不进入当前钱包。" actions={<Button variant="outline" disabled={busy} onClick={() => { update({ page: 1 }); setNonce(value => value + 1); }}><RefreshCw aria-hidden="true" />刷新</Button>} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <label className="space-y-1 text-sm"><span className="text-muted-foreground">开始日期</span><Input type="date" value={filters.from} onChange={event => update({ from: event.target.value })} /></label>
      <label className="space-y-1 text-sm"><span className="text-muted-foreground">结束日期</span><Input type="date" value={filters.to} onChange={event => update({ to: event.target.value })} /></label>
      <FilterSelect label="来源" value={filters.source} options={sourceOptions} onChange={source => update({ source: source as DashboardFilters['source'] })} />
      <FilterSelect label="状态" value={filters.state} options={{ ALL: '全部状态', PENDING: stateLabel('PENDING'), SETTLED: stateLabel('SETTLED'), REVOKED: stateLabel('REVOKED'), RECOVERY_REQUIRED: stateLabel('RECOVERY_REQUIRED'), EXPIRED: stateLabel('EXPIRED') }} onChange={state => update({ state: state as DashboardFilters['state'] })} />
      <FilterSelect label="角色" value={filters.role} options={{ ALL: '全部角色', RENTER_REFERRAL: '租客来源', OWNER_REFERRAL: '号主来源', TASK_REFERRAL: '历史任务' }} onChange={role => update({ role: role as DashboardFilters['role'] })} />
    </div>
    <label className="block max-w-xl space-y-1 text-sm"><span className="text-muted-foreground">订单号 / 受益人</span><div className="flex gap-2"><Input value={filters.q} onChange={event => update({ q: event.target.value })} placeholder="输入订单号或用户线索" /><Button variant="outline" onClick={() => update({ q: filters.q.trim() })}><Search aria-hidden="true" />查询</Button></div></label>
    {canOrder ? <Card>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void lookupOrder(); }}>
        <label className="min-w-56 flex-1 space-y-1 text-sm"><span className="text-muted-foreground">按完整订单号精确查询</span><Input value={orderQuery} onChange={event => { orderController.current?.abort(); orderSequence.current++; setOrderState(null); setOrderQuery(event.target.value); }} placeholder="完整订单号" /></label>
        <Button type="submit" disabled={orderBusy || !orderQuery.trim()}>查询本单佣金</Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">精确查询只返回该订单的受权记录，不替代上方按来源和状态的列表。</p>
      {orderError ? <Alert variant="warning" className="mt-3"><CircleAlert aria-hidden="true" /><AlertTitle>本单佣金暂不可用</AlertTitle><AlertDescription>{orderError}</AlertDescription></Alert> : null}
      {orderMatches.length ? <div className="mt-3 flex flex-wrap gap-2">{orderMatches.map(item => <Button key={`${item.origin}:${item.id}`} variant="outline" onClick={() => void loadOrder(item)}>{item.displayNo} · {item.origin === 'LEGACY' ? '旧平台' : '新平台'}</Button>)}</div> : null}
      {orderRead ? <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">订单 {orderRead.order.number ?? '编号未提供'}</h2><span className="text-xs text-muted-foreground">{orderRead.order.origin === 'LEGACY' ? '历史观察' : '本平台'} · 仅本受权订单</span></div>
        {orderRead.knowledge === 'UNAVAILABLE' ? <p className="text-sm text-muted-foreground">佣金依据尚未读全，不解释为没有记录或零奖励。</p> : null}
        {orderRead.items.length ? <><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>受益人</TableHead><TableHead>角色</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>记录时间</TableHead></TableRow></TableHeader><TableBody>{orderRead.items.map(item => <TableRow key={item.id}><TableCell>{item.beneficiary.name ?? '受益人待核'}</TableCell><TableCell>{roleLabel(item.role)}</TableCell><TableCell className="tabular-nums">{money(item.amountCents)}</TableCell><TableCell>{distributionState(item)}</TableCell><TableCell>{formatBeijingDateTime(item.occurredAt)}</TableCell></TableRow>)}</TableBody></Table></div><ul className="divide-y divide-border md:hidden">{orderRead.items.map(item => <li key={item.id} className="space-y-1 py-3"><div className="flex items-center justify-between gap-2"><span className="font-medium">{item.beneficiary.name ?? '受益人待核'}</span><span className="tabular-nums">{money(item.amountCents)}</span></div><div className="text-xs text-muted-foreground">{roleLabel(item.role)} · {distributionState(item)} · {formatBeijingDateTime(item.occurredAt)}</div></li>)}</ul></> : <p className="text-sm text-muted-foreground">该订单尚无已登记佣金记录；这不代表渠道没有记录。</p>}
      </div> : null}
    </Card> : null}
    {error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>佣金记录暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <p role="status" className="text-sm text-muted-foreground">正在读取佣金明细…</p> : null}
    {read ? <><Card className="p-0">{read.items.length ? <EarningsRows rows={read.items} snapshot={snapshot} onOpenPath={onOpenPath} /> : <p className="py-10 text-center text-sm text-muted-foreground">当前范围没有佣金记录</p>}</Card><div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><span>{total.toLocaleString('zh-CN')} 条 · 第 {filters.page} / {pages} 页</span><div className="flex gap-2"><Button variant="outline" disabled={busy || filters.page <= 1} onClick={() => update({ page: filters.page - 1 })}><ChevronLeft aria-hidden="true" />上一页</Button><Button variant="outline" disabled={busy || !read.hasMore} onClick={() => update({ page: filters.page + 1 })}>下一页<ChevronRight aria-hidden="true" /></Button></div></div></> : null}
  </section>;
}

export function DistributionParticipantsPage({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const { filters, update } = useDashboardFilters(query, onQueryChange), [nonce, setNonce] = useState(0);
  const allowed = can(snapshot, 'distribution.dashboard.read');
  const { read, error, busy } = useDashboardList(snapshot, filters, update, nonce, refreshNonce, readDashboardParticipants);
  if (!allowed) return <ReadDenied/>;
  return <section className="space-y-5" data-distribution-participants>
    <PageHeader title="分销商" description="当前参与资格、直属关系与佣金分开核对；不在这里改资格或关系。" actions={<Button variant="outline" disabled={busy} onClick={() => { update({ page: 1 }); setNonce(value => value + 1); }}><RefreshCw aria-hidden="true" />刷新</Button>} />
    <label className="block max-w-xl space-y-1 text-sm"><span className="text-muted-foreground">用户 ID 或昵称</span><Input value={filters.q} onChange={event => update({ q: event.target.value })} placeholder="输入用户线索" /></label>
    {error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>分销商列表暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <p role="status" className="text-sm text-muted-foreground">正在读取分销商…</p> : null}
    {read ? <Card className="p-0">{read.items.length ? <><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>用户</TableHead><TableHead>资格</TableHead><TableHead>关系</TableHead><TableHead>佣金</TableHead><TableHead>来源</TableHead></TableRow></TableHeader><TableBody>{read.items.map(item => <TableRow key={item.userId}><TableCell><button type="button" className="text-left font-medium hover:underline" onClick={() => onOpenPath(`/distribution/participants/${encodeURIComponent(item.userId)}`, '分销商详情')}>{item.name ?? item.userId}<div className="text-xs text-muted-foreground">{item.userId}</div></button></TableCell><TableCell><Badge variant={item.eligibility === 'ELIGIBLE' ? 'success' : 'warning'}>{eligibilityLabel(item.eligibility)}</Badge>{item.frozen ? <Badge variant="destructive">冻结</Badge> : null}</TableCell><TableCell><div>直属计佣 {item.leaderChildren}</div><div className="text-xs text-muted-foreground">注册邀请 {item.inviterChildren}</div></TableCell><TableCell className="tabular-nums"><div>已结算 {money(item.settledCents)}</div><div>待结算 {money(item.pendingCents)}</div>{item.recoveryCents !== '0' ? <div className="text-destructive">待追回 {money(item.recoveryCents)}</div> : null}</TableCell><TableCell>{sourceLabel(item.sourceType === 'LEGACY_MYSQL' ? 'LEGACY' : 'NATIVE')}<div className="text-xs text-muted-foreground">{item.levelCode ?? '无等级'}</div></TableCell></TableRow>)}</TableBody></Table></div><ul className="divide-y divide-border md:hidden">{read.items.map(item => <li key={item.userId} className="space-y-2 p-4"><div className="flex items-start justify-between gap-2"><button type="button" className="min-w-0 text-left font-medium hover:underline" onClick={() => onOpenPath(`/distribution/participants/${encodeURIComponent(item.userId)}`, '分销商详情')}>{item.name ?? item.userId}<div className="break-all text-xs text-muted-foreground">{item.userId}</div></button><Badge variant="outline">{sourceLabel(item.sourceType === 'LEGACY_MYSQL' ? 'LEGACY' : 'NATIVE')}</Badge></div><div className="flex flex-wrap gap-2"><Badge variant={item.eligibility === 'ELIGIBLE' ? 'success' : 'warning'}>{eligibilityLabel(item.eligibility)}</Badge>{item.frozen ? <Badge variant="destructive">冻结</Badge> : null}</div><dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm"><div><dt className="text-xs text-muted-foreground">直属计佣</dt><dd>{item.leaderChildren}</dd></div><div><dt className="text-xs text-muted-foreground">注册邀请</dt><dd>{item.inviterChildren}</dd></div><div><dt className="text-xs text-muted-foreground">已结算</dt><dd className="tabular-nums">{money(item.settledCents)}</dd></div><div><dt className="text-xs text-muted-foreground">待结算</dt><dd className="tabular-nums">{money(item.pendingCents)}</dd></div>{item.recoveryCents !== '0' ? <div><dt className="text-xs text-muted-foreground">待追回</dt><dd className="tabular-nums text-destructive">{money(item.recoveryCents)}</dd></div> : null}<div><dt className="text-xs text-muted-foreground">等级</dt><dd>{item.levelCode ?? '无等级'}</dd></div></dl></li>)}</ul></> : <p className="py-10 text-center text-sm text-muted-foreground">当前范围没有分销商</p>}<div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm text-muted-foreground"><span>{Number(read.total).toLocaleString('zh-CN')} 人 · 第 {read.page} 页</span><div className="flex gap-2"><Button variant="outline" disabled={busy || read.page <= 1} onClick={() => update({ page: read.page - 1 })}><ChevronLeft aria-hidden="true" />上一页</Button><Button variant="outline" disabled={busy || !read.hasMore} onClick={() => update({ page: read.page + 1 })}>下一页<ChevronRight aria-hidden="true" /></Button></div></div></Card> : null}
  </section>;
}

export function DistributionParticipantPage({ snapshot, userId, onOpenPath, refreshNonce = 0 }: PageProps & { userId: string }) {
  const allowed = can(snapshot, 'distribution.dashboard.read');
  const { read, error, busy } = useDashboardRead(snapshot, JSON.stringify([userId, refreshNonce]), allowed, signal => readDashboardParticipant(userId, signal));
  const canDirectory = can(snapshot, 'user.directory.read');
  if (!allowed) return <ReadDenied/>;
  return <section className="space-y-5" data-distribution-participant>
    <PageHeader title="分销商详情" description="资格、关系和佣金只读核对；不提供改绑或补发。" actions={<Button variant="outline" onClick={() => onOpenPath('/distribution/participants', '分销商')}>返回分销商</Button>} />
    {error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>分销商详情暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <p role="status" className="text-sm text-muted-foreground">正在读取分销商详情…</p> : null}
    {read ? <><Card><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{read.participant.name ?? read.participant.userId}</h2><p className="text-sm text-muted-foreground">{read.participant.userId} · {eligibilityLabel(read.participant.eligibility)}{read.participant.frozen ? ' · 已冻结分佣' : ''}</p></div><div className="flex gap-2">{canDirectory ? <Button variant="outline" onClick={() => onOpenPath(`/users/${encodeURIComponent(read.participant.userId)}`, '用户详情')}>用户资料</Button> : null}<Button variant="outline" onClick={() => onOpenPath(`/distribution/earnings?q=${encodeURIComponent(read.participant.userId)}`, '佣金明细')}>查看佣金</Button><Button variant="outline" disabled={!can(snapshot, 'user.directory.read') || !can(snapshot, 'personal.distribution.policy.read')} onClick={() => onOpenPath(`/distribution/relations?userId=${encodeURIComponent(read.participant.userId)}`, '关系查询')}>关系查询</Button></div></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><div>已结算<div className="text-lg font-semibold tabular-nums">{money(read.participant.settledCents)}</div></div><div>待结算<div className="text-lg font-semibold tabular-nums">{money(read.participant.pendingCents)}</div></div><div>待追回<div className="text-lg font-semibold tabular-nums">{money(read.participant.recoveryCents)}</div></div></div></Card><Card><h2 className="mb-3 font-semibold">关系</h2>{read.relations.length ? <dl className="grid gap-3 sm:grid-cols-2">{read.relations.map(relation => <div key={relation.type} className="rounded-lg border p-3"><dt className="text-sm text-muted-foreground">{relation.type === 'INVITER' ? '注册邀请来源' : '直属计佣上级'}</dt><dd className="mt-1 font-medium">{relation.parentName ?? relation.parentUserId ?? '关系待核'}</dd><dd className="text-xs text-muted-foreground">{relation.sourceType ?? '来源待核'} · {relation.policyVersion ?? '政策待核'}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">没有可展示的关系。</p>}</Card></> : null}
  </section>;
}

export function DistributionRelationsPage({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const allowed = can(snapshot, 'user.directory.read') && can(snapshot, 'personal.distribution.policy.read');
  const [draft, setDraft] = useState({ incoming: query.userId ?? '', value: query.userId ?? '' });
  const userId = draft.incoming === (query.userId ?? '') ? draft.value : query.userId ?? '';
  const [target, setTarget] = useState(query.userId ?? ''), [nonce, setNonce] = useState(0), [inputError, setInputError] = useState('');
  const incoming = useRef(query.userId);
  useLayoutEffect(() => { if (incoming.current !== query.userId) { incoming.current = query.userId; setDraft({ incoming: query.userId ?? '', value: query.userId ?? '' }); setTarget(query.userId ?? ''); setInputError(''); } }, [query.userId]);
  const effectiveTarget = incoming.current === query.userId ? target : query.userId ?? '';
  const { read, error: readError, busy } = useDashboardRead(snapshot, JSON.stringify([effectiveTarget, userId, nonce, refreshNonce]), allowed && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(effectiveTarget) && userId === effectiveTarget, signal => readDistributionRelations(effectiveTarget, signal));
  const error = inputError || readError;
  const canDirectory = can(snapshot, 'user.directory.read');
  function load() { if (!allowed) return; if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(userId.trim())) { setInputError('请填写准确用户 ID。'); return; } setInputError(''); setTarget(userId.trim()); setDraft({ incoming: query.userId ?? '', value: userId.trim() }); setNonce(value => value + 1); onQueryChange?.({ ...query, userId: userId.trim() }); }
  if (!allowed) return <ReadDenied/>;
  return <section className="space-y-5" data-distribution-relations><PageHeader title="关系查询" description="按准确用户核对注册邀请与直属计佣上级；关系来源未就绪时不按 0 处理。" /><form className="flex max-w-xl gap-2" onSubmit={event => { event.preventDefault(); void load(); }}><Input value={userId} onChange={event => setDraft({ incoming: query.userId ?? '', value: event.target.value })} placeholder="准确用户 ID" /><Button type="submit" disabled={busy || !userId.trim()}>查询关系</Button></form>{error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>关系暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}{busy ? <p role="status" className="text-sm text-muted-foreground">正在读取关系…</p> : null}{read ? <Card><p className="text-sm text-muted-foreground">{read.participant.knowledge === 'KNOWN' ? eligibilityLabel(read.participant.eligibility) : '参与资格待核'}{read.participant.commissionFrozen === true ? ' · 分佣已冻结' : ''}</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{read.relations.map(relation => <div key={relation.type} className="rounded-lg border p-4"><h2 className="font-medium">{relation.type === 'INVITER' ? '注册邀请来源' : '直属计佣上级'}</h2><p className="mt-1 text-sm">{relation.knowledge === 'KNOWN_PARENT' ? relation.parentName ?? relation.parentUserId ?? '已记录' : relation.knowledge === 'KNOWN_NONE' ? '已核无关系' : '来源待核，不能判定为没有关系'}</p>{relation.parentUserId && canDirectory ? <Button variant="link" size="sm" className="px-0" onClick={() => onOpenPath(`/users/${encodeURIComponent(relation.parentUserId!)}`, '关联用户')}>查看关联用户</Button> : null}</div>)}</div></Card> : null}</section>;
}

export function DistributionPolicyPage({ snapshot, onOpenPath, onDirtyChange }: { snapshot: Snapshot; onOpenPath: OpenPath; onDirtyChange: (dirty: boolean) => void }) {
  const access = distributionPolicyAccess(snapshot);
  const identity = dashboardContextIdentity(snapshot);
  const [assembly, setAssembly] = useState({ identity, ready: false, admitted: false });
  const reportAssembly = useCallback((ready: boolean) => setAssembly(current => current.identity === identity && current.ready === ready ? current : { identity, ready, admitted: ready || current.identity === identity && current.admitted }), [identity]);
  if (!active(snapshot) || !access.canRead) return <ReadDenied/>;
  return <section className="space-y-5" data-distribution-policy-page><PageHeader title="分销政策" description="政策调整走原审批、幂等和原回执恢复；不在这里发佣或改比例。" /><DistributionPolicyPanel snapshot={snapshot} onOpenPath={onOpenPath} onDirtyChange={onDirtyChange} onWriteAssemblyReady={reportAssembly} />{access.canManage && assembly.identity === identity && assembly.admitted ? <DistributionMaintenancePanel key={identity} canExecute={assembly.ready}/> : null}</section>;
}
