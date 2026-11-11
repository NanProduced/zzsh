import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, CalendarDays, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, Crown, RefreshCw, Search } from 'lucide-react';
import { ListPagination } from '@/components/admin-list/list-pagination';
import { AreaChart, CartesianGrid, ChartArea, ChartContainer, ChartTooltip, ChartTooltipContent, XAxis, YAxis, type ChartConfig } from '@/components/ui/chart';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DateSelector, type DateSelectorValue } from '@/components/reui/date-selector';
import { AdminApiError, adminRequest, hasPermission, type SessionSnapshot } from '../api';
import { formatBeijingDateTime } from '../workspace/beijing-time';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DistributionMaintenancePanel } from './distribution-maintenance-panel';
import { DistributionPolicyPanel, distributionPolicyAccess } from './distribution-policy-panel';
import { DistributionLevelManager, DistributionParticipantManager, type ParticipantManagementAction } from './distribution-management';
import { DistributionUserName } from './distribution-user-name';
import { distributionState, parseDistributionOrder } from './distribution-workspace';
import {
  dashboardMoney, dashboardContextIdentity, dashboardFiltersFromQuery, dashboardQuery, eligibilityLabel, participantEligibilityLabel, participantLevelLabel, participantChildrenLabel, metricReason, money, readDashboardEarnings, readDashboardOverviewCore, readDashboardOverviewRanking,
  readDashboardParticipant, readDashboardParticipantDownline, readDashboardParticipants, reasonLabel, roleLabel, sourceLabel, stateLabel,
  type DashboardDownlineType, type DashboardEarning, type DashboardFilters, type DashboardParticipant, type DashboardParticipantSort, type DashboardRanking, type DashboardSortOrder,
} from './distribution-dashboard-model';

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type OpenPath = (path: string, title?: string) => void;

type PageProps = { snapshot: Snapshot; onOpenPath: OpenPath; query?: Record<string, string>; onQueryChange?: (query: Record<string, string>) => void; refreshNonce?: number };
/** 字段旁问号说明，对齐用户目录 InfoHint。 */
function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={label} className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />}
      >
        <CircleHelp size={13} aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-72 leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}


function ParticipantSortHeader({ label, column, sort, order, onSort, className }: { label: string; column: DashboardParticipantSort; sort: DashboardParticipantSort; order: DashboardSortOrder; onSort: (sort: DashboardParticipantSort, order: DashboardSortOrder) => void; className?: string }) {
  const active = sort === column;
  const ascending = active && order === 'asc';
  return <TableHead className={className} aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className={`inline-flex items-center gap-1 rounded-md px-0 text-sm font-medium hover:text-foreground ${active ? 'text-foreground' : 'text-muted-foreground'}`} aria-label={`按${label}排序`} onClick={() => onSort(column, ascending ? 'desc' : 'asc')}>
      {label}
      <span aria-hidden>{active ? (ascending ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-40" />}</span>
    </button>
  </TableHead>;
}

const INVITE_REGISTER_TIP = '使用这个人的邀请码注册的人数；分销资格冻结不会改变邀请关系。';
const COMMISSION_CHILD_TIP = '被邀请用户中，为这个人产生过有效正额佣金的人数。待结算和已结算都计入，同一用户只计算一次。';
const MAPPED_CHILDREN_TIP = '系统里已经能看到的关系条数（旧平台迁进来的 + 迁完后新邀请的都算）。旧平台那边完整总数还没核对完，所以不能当成全部人数。';
const MAPPED_CONTRIBUTORS_TIP = '已确认产生有效佣金的人数；关系或佣金记录尚未全部核对，完整人数待核。';

function RelationMetric({ label, tip, total, mapped, contributor = false }: { label: string; tip: string; total: number | null; mapped?: number; contributor?: boolean }) {
  const value = participantChildrenLabel(total, mapped, contributor ? '已确认' : '已接入');
  const unknown = total === null && mapped !== undefined;
  return (
    <div className="flex items-baseline gap-x-2 gap-y-1">
      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">{label}<InfoHint label={label + '说明'}>{tip}</InfoHint></span>
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1 tabular-nums text-foreground">
        <span>{value}</span>
        {unknown ? <InfoHint label={contributor ? '已确认人数说明' : '已接入人数说明'}>{contributor ? MAPPED_CONTRIBUTORS_TIP : MAPPED_CHILDREN_TIP}</InfoHint> : null}
      </span>
    </div>
  );
}

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
function useDashboardRead<T>(snapshot: Snapshot, request: string, allowed: boolean, load: (signal: AbortSignal) => Promise<T>, onFailure?: (reason: unknown) => void, options?: { retainPrevious?: boolean }) {
  const identity = dashboardContextIdentity(snapshot), key = JSON.stringify([identity, request]), live = useRef(key), sequence = useRef(0);
  live.current = key;
  const latest = useRef({ load, onFailure }); latest.current = { load, onFailure };
  const [result, setResult] = useState<{ key: string; identity:string; body: T } | null>(null), [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(), ticket = ++sequence.current, current = () => !controller.signal.aborted && live.current === key && ticket === sequence.current, reader = latest.current;
    if (!options?.retainPrevious) setResult(null);
    setFailed(null);
    if (allowed) void reader.load(controller.signal).then(body => { if (current()) setResult({ key, identity, body }); }).catch(reason => {
      if (current()) { setResult(null); setFailed({ key, text: failure(reason) }); reader.onFailure?.(reason); }
    });
    return () => { controller.abort(); sequence.current++; };
  }, [key, allowed]);
  const matched = allowed && result?.key === key ? result.body : null;
  const retained = options?.retainPrevious && allowed && result && result.identity === identity && result.key !== key ? result.body : null;
  const read = matched ?? retained ?? null;
  const error = allowed && failed?.key === key ? failed.text : '';
  const refreshing = Boolean(options?.retainPrevious && allowed && result && result.identity === identity && result.key !== key && !error);
  return { read, error, busy: allowed && !read && !error, refreshing };
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
  ? error.status === 403 ? '当前身份没有这项分销读取权限。' : error.status === 409 ? '数据已变化，请重新加载。' : error.status === 503 ? '分销资料暂时无法读取，请稍后重试。' : '读取暂未完成，请稍后重试。'
  : '读取暂未完成，请稍后重试。';
const sourceOptions = { ALL: '全部来源', NATIVE: '本平台', LEGACY: '历史观察' };

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>{actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}</header>;
}
function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-xl border border-border bg-card p-4 text-card-foreground ${className}`}>{children}</div>;
}
function MetricCard({ label, metric, note, countOnly = false }: { label: string; metric: { knowledge: 'KNOWN' | 'UNKNOWN'; cents: string | null; count: string | null; reasonCodes: string[] }; note?: string; countOnly?: boolean }) {
  return <div className="min-w-0 px-4 py-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-xl font-semibold tabular-nums">{countOnly ? (metric.knowledge === 'UNKNOWN' || metric.count === null ? '未核定' : BigInt(metric.count).toLocaleString('zh-CN')) : dashboardMoney(metric)}</dd>{note || metric.knowledge === 'UNKNOWN' ? <dd className="mt-1 text-xs text-muted-foreground">{metric.knowledge === 'UNKNOWN' ? metricReason(metric) : note}</dd> : null}</div>;
}
function FilterSelect({ label, value, options, onChange, className = '' }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void; className?: string }) {
  return <label className={`space-y-2 text-sm ${className}`.trim()}><span className="block text-muted-foreground">{label}</span><Select value={value} onValueChange={next => { if (next) onChange(next); }}><SelectTrigger aria-label={label} className="w-full min-w-[8.5rem]"><SelectValue>{options[value] ?? value}</SelectValue></SelectTrigger><SelectContent>{Object.entries(options).map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></label>;
}
function HistoryBadge({ source }: { source: string }) { return source === 'LEGACY' ? <Badge variant="outline" className="shrink-0">旧平台记录</Badge> : null; }
function StateBadge({ state }: { state: string }) { return <Badge variant={state === 'SETTLED' ? 'success' : state === 'PENDING' ? 'warning' : state === 'RECOVERY_REQUIRED' ? 'destructive' : 'secondary'}>{stateLabel(state)}</Badge>; }
function rankingLabel(item: DashboardRanking) { return item.name ?? '未命名用户'; }
function RankingSkeleton() {
  return <div role="status" aria-label="正在更新排行" className="space-y-3 py-1">{Array.from({ length: 6 }, (_, index) => <div key={index} className="flex items-center gap-3"><Skeleton className="h-4 w-4 rounded-full" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-4 w-16" /></div>)}</div>;
}
function RankingList({ items, empty, onOpen, countMode = false }: { items: DashboardRanking[]; empty: string; onOpen?: (item: DashboardRanking) => void; countMode?: boolean }) {
  return items.length ? <ol className="divide-y divide-border">{items.map(item => {
    const label = rankingLabel(item);
    return <li key={`${item.userId ?? item.rank}-${item.rank}`} className="flex items-center gap-3 py-2"><span className="w-6 shrink-0 text-sm tabular-nums text-muted-foreground">{item.rank}</span>{item.rank <= 3 ? <Crown size={14} aria-hidden="true" className="shrink-0" /> : null}<span className="min-w-0 flex-1 truncate"><DistributionUserName userId={item.userId} name={label} canOpen={Boolean(onOpen && item.userId)} onOpen={() => onOpen?.(item)} className="font-medium" /><span className="ml-2 text-xs text-muted-foreground">{item.roles.map(roleLabel).join(' / ')}</span></span><span className="shrink-0 tabular-nums">{countMode ? `${BigInt(item.count ?? '0').toLocaleString('zh-CN')} 个` : money(item.cents)}</span></li>;
  })}</ol> : <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
}
const distributionTrendConfig: ChartConfig = {
  yuan: { label: '入账', color: 'var(--primary)' },
};

export function distributionTrendValue(point: Record<string, unknown>): string {
  return money(typeof point.cents === 'string' ? point.cents : null);
}
const isoDay = (date: Date | undefined) => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
export function DistributionDateRange({ from, to, onChange, label = '选择统计日期', className }: { from: string; to: string; onChange: (from: string, to: string) => void; label?: string; className?: string }) {
  const seed = (): DateSelectorValue => ({ period: 'day', operator: 'between', startDate: from ? new Date(`${from}T00:00:00`) : undefined, endDate: to ? new Date(`${to}T00:00:00`) : undefined });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateSelectorValue>(seed);
  useEffect(() => { if (open) setDraft(seed()); }, [open, from, to]);
  const shownFrom = open ? isoDay(draft.startDate) || from : from;
  const shownTo = open ? isoDay(draft.endDate) : to;
  const text = shownFrom && shownTo ? (shownFrom === shownTo ? shownFrom : `${shownFrom} 至 ${shownTo}`) : shownFrom ? `${shownFrom} 至 请选择结束日期` : '选择日期';
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="outline" aria-label={label} className={`justify-start gap-2 ${className ?? ''}`.trim()} />}><CalendarDays size={16} aria-hidden="true" /><span className="tabular-nums">{text}</span></PopoverTrigger><PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0"><DateSelector value={draft} presetMode="between" allowRange showTwoMonths={false} showInput={false} presets={[{ label: '近 7 天', days: 7 }, { label: '近 30 天', days: 30 }, { label: '近 90 天', days: 90 }]} onChange={next => { setDraft(next); if (next.startDate && next.endDate) { onChange(isoDay(next.startDate), isoDay(next.endDate)); setOpen(false); } }} /></PopoverContent></Popover>;
}
export function DistributionTrend({ points, label = '入账', knowledge, incomplete = false }: { points: { date: string; cents: string; knowledge: 'KNOWN' | 'UNKNOWN' }[]; label?: string; knowledge?: 'KNOWN' | 'UNKNOWN'; incomplete?: boolean }) {
  if (knowledge === 'UNKNOWN') return <p className="py-8 text-center text-sm text-muted-foreground">趋势来源尚未核定，请在来源恢复后刷新。</p>;
  const drawable = points.every(point => point.knowledge === 'KNOWN' && /^-?\d+$/.test(point.cents) && Number.isFinite(Number(point.cents) / 100));
  if (!drawable) return <div className="overflow-x-auto"><p className="mb-2 text-sm text-muted-foreground">部分趋势未核定或超出图形范围，以下保留原始金额。</p><Table aria-label={`分销${label}趋势明细`}><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>{label}金额</TableHead></TableRow></TableHeader><TableBody>{points.map(point => <TableRow key={point.date}><TableCell>{point.date}</TableCell><TableCell className="whitespace-normal break-all tabular-nums">{money(point.knowledge === 'KNOWN' ? point.cents : null)}</TableCell></TableRow>)}</TableBody></Table></div>;
  if (!points.some(point => BigInt(point.cents) !== 0n)) return <p className="py-8 text-center text-sm text-muted-foreground">当前期间暂无已确认{label}{incomplete ? '，未确认记录见上方说明' : ''}</p>;
  return <div className="h-56 w-full" role="img" aria-label="所选期间佣金趋势"><ChartContainer config={label === '入账' ? distributionTrendConfig : { yuan: { label, color: 'var(--primary)' } }} label="所选期间佣金趋势" height={224}><AreaChart data={points.map(point => ({ date: point.date, cents: point.cents, yuan: Number(point.cents) / 100 }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} interval="preserveStartEnd" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" /><YAxis width={72} tickFormatter={(value: number) => `¥${Number(value).toFixed(2)}`} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" /><ChartTooltip content={<ChartTooltipContent formatValue={distributionTrendValue} />} /><ChartArea type="monotone" dataKey="yuan" name={label} /></AreaChart></ChartContainer></div>;
}

export function DistributionOverviewPage({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const { filters, update } = useDashboardFilters(query, onQueryChange), [nonce, setNonce] = useState(0), [trendBasis, setTrendBasis] = useState<'settled' | 'accrued'>('settled');
  const allowed = can(snapshot, 'distribution.dashboard.read');
  const core = useDashboardRead(snapshot, JSON.stringify([filters.from, filters.to, nonce, refreshNonce]), allowed, signal => readDashboardOverviewCore(filters, signal), undefined, { retainPrevious: true });
  const earnings = useDashboardRead(snapshot, JSON.stringify([filters.from, filters.to, filters.rankingBasis, filters.rankingLimit, nonce, refreshNonce]), allowed, signal => readDashboardOverviewRanking(filters, 'EARNINGS_RANKING', signal), undefined, { retainPrevious: true });
  const invites = useDashboardRead(snapshot, JSON.stringify([filters.rankingLimit, nonce, refreshNonce]), allowed, signal => readDashboardOverviewRanking(filters, 'INVITE_RANKING', signal), undefined, { retainPrevious: true });
  const coreLoading = core.busy || core.refreshing, earningsLoading = earnings.busy || earnings.refreshing, invitesLoading = invites.busy || invites.refreshing;
  const read = coreLoading ? null : core.read, earningsRead = earningsLoading ? null : earnings.read?.ranking, invitesRead = invitesLoading ? null : invites.read?.ranking;
  const canDirectory = can(snapshot, 'user.directory.read');
  const openUser = (userId: string | null) => { if (userId && canDirectory) onOpenPath(`/users/${encodeURIComponent(userId)}`, '用户详情'); };
  if (!allowed) return <ReadDenied/>;
  return <section className="space-y-4" data-distribution-overview>
    <PageHeader title="分销概览" description="统一查看佣金、分销关系与结算情况。" actions={<><span className="self-center text-xs text-muted-foreground">{read ? <>截至 <time dateTime={read.asOf}>{formatBeijingDateTime(read.asOf)}</time> · 各模块独立刷新</> : coreLoading ? '正在读取…' : ''}</span><Button variant="outline" disabled={coreLoading || earningsLoading || invitesLoading} onClick={() => setNonce(value => value + 1)}><RefreshCw aria-hidden="true" />刷新</Button></>} />
    {core.error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>佣金概览暂不可用</AlertTitle><AlertDescription>{core.error}</AlertDescription></Alert> : null}
    {coreLoading ? <Card><div role="status" aria-label="正在读取佣金概览" className="space-y-4"><Skeleton className="h-5 w-28"/><div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({length:4},(_,i)=><Skeleton key={i} className="h-16 w-full"/>)}</div><Skeleton className="h-44 w-full"/></div></Card> : null}
    {read ? <>
      <Card className="p-0"><div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><h2 className="font-semibold">当前状态</h2><span className="text-xs text-muted-foreground">截至当前 · 不受日期筛选影响</span></div><dl className="grid grid-cols-2 divide-x divide-border lg:grid-cols-4">
        <MetricCard label="佣金记录已结算" metric={read.current.settled} note="已结算不等于可提现或银行到账" />
        <MetricCard label="已确认待结算" metric={read.current.pending} note="按当前责任，含已到期未结算" />
        <MetricCard label="当前待追回" metric={read.current.recovery} />
        <MetricCard label="当前有资格" metric={read.participants.eligible} countOnly />
      </dl><div className="flex flex-wrap gap-x-5 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground"><span>{read.recordSummary.coverage.knowledge === 'KNOWN' ? '统计当前可读取的佣金记录，非钱包余额。' : '已接入记录小计，完整覆盖待核；非钱包余额。'}</span><span>责任待核对 {read.current.needsReview.count === null ? '未核定' : `${BigInt(read.current.needsReview.count).toLocaleString('zh-CN')} 条`}，不计入待结算。</span></div></Card>
      <Card className="p-0"><div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"><h2 className="font-semibold">期间表现</h2><div className="flex flex-wrap items-center gap-2"><DistributionDateRange label="选择期间表现日期" from={filters.from} to={filters.to} onChange={(from, to) => update({ from, to })} /></div></div>
        <dl className="grid divide-x divide-border sm:grid-cols-3"><MetricCard label="期间入账" metric={read.flow.settled} note="按已证明的账内入账时间" /><MetricCard label="佣金发生额" metric={read.flow.accrued} note="按原始发生日，不等于入账" /><MetricCard label="佣金订单" metric={read.flow.orders} note="期间发生且已关联的订单" countOnly /></dl>
        <div className="mx-4 border-t py-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{trendBasis === 'settled' ? '按佣金入账时间统计' : '按佣金原始发生时间统计'}</p><div className="flex gap-1" role="group" aria-label="趋势口径"><Button size="sm" variant={trendBasis === 'settled' ? 'secondary' : 'ghost'} aria-pressed={trendBasis === 'settled'} onClick={() => setTrendBasis('settled')}>入账</Button><Button size="sm" variant={trendBasis === 'accrued' ? 'secondary' : 'ghost'} aria-pressed={trendBasis === 'accrued'} onClick={() => setTrendBasis('accrued')}>发生额</Button></div></div>
          {read.flow.unconfirmedCreditCount !== '0' || read.flow.unconfirmedOccurredCount !== '0' ? <p className="mb-2 text-xs text-muted-foreground">{read.flow.unconfirmedCreditCount !== '0' ? `有 ${read.flow.unconfirmedCreditCount} 条已结算记录未确认入账时刻，不计入期间入账及入账趋势。` : ''}{read.flow.unconfirmedOccurredCount !== '0' ? `有 ${read.flow.unconfirmedOccurredCount} 条记录未确认原始发生日。` : ''}</p> : null}
          <DistributionTrend label={trendBasis === 'settled' ? '入账' : '发生额'} knowledge={read.flow.settled.knowledge} incomplete={trendBasis === 'settled' ? read.flow.unconfirmedCreditCount !== '0' : read.flow.unconfirmedOccurredCount !== '0'} points={read.trend.map(point => ({ ...point, cents: trendBasis === 'settled' ? point.cents : point.accruedCents }))} />
        </div>
      </Card>
    </> : null}
    <div className="grid gap-4 xl:grid-cols-2" data-distribution-rankings>
      <Card className="p-0"><div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><div className="min-w-0"><h2 className="font-semibold">佣金排行</h2><p className="text-xs text-muted-foreground">按推广人获得的佣金金额</p></div><div className="flex items-center gap-1"><Select value={filters.rankingBasis} onValueChange={next => { if (next) update({ rankingBasis: next as DashboardFilters['rankingBasis'] }); }}><SelectTrigger size="sm" aria-label="佣金排行口径" className="h-8 w-auto"><SelectValue>{filters.rankingBasis === 'PERIOD_SETTLED_FLOW' ? '期间入账' : '累计已结算'}</SelectValue></SelectTrigger><SelectContent><SelectItem value="CURRENT_SETTLED_STOCK">累计已结算</SelectItem><SelectItem value="PERIOD_SETTLED_FLOW">期间入账</SelectItem></SelectContent></Select><Button variant="ghost" size="sm" disabled={earningsLoading} onClick={() => update({ rankingLimit: filters.rankingLimit === 10 ? 100 : 10 })}>{filters.rankingLimit === 10 ? '展开前 100' : '收起为前 10'}</Button></div></div><div className="px-4 py-2">{earningsLoading ? <RankingSkeleton /> : earnings.error ? <p role="status" className="py-6 text-sm text-muted-foreground">{earnings.error}</p> : earningsRead ? <>{earningsRead.knowledge === 'PARTIAL' ? <p className="pb-2 text-xs text-muted-foreground">按已接入佣金记录排名，完整来源待核。</p> : null}<RankingList items={earningsRead.items} empty="当前口径没有已结算佣金" onOpen={canDirectory ? item => openUser(item.userId) : undefined} /></> : null}</div></Card>
      <Card className="p-0"><div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><div className="min-w-0"><h2 className="font-semibold">邀请人数</h2><p className="text-xs text-muted-foreground">按直属邀请的人数</p></div><div className="flex gap-1"><Button variant="ghost" size="sm" disabled={invitesLoading} onClick={() => update({ rankingLimit: filters.rankingLimit === 10 ? 100 : 10 })}>{filters.rankingLimit === 10 ? '展开前 100' : '收起为前 10'}</Button></div></div><div className="px-4 py-2">{invitesLoading ? <RankingSkeleton /> : invites.error ? <p role="status" className="py-6 text-sm text-muted-foreground">{invites.error}</p> : invitesRead ? (invitesRead.knowledge !== 'UNKNOWN' ? <div>{invitesRead.knowledge === 'PARTIAL' ? <p className="pb-2 text-xs text-muted-foreground">按已接入关系排名，完整人数待核。</p> : null}<RankingList items={invitesRead.items} empty="暂无邀请记录" onOpen={canDirectory ? item => openUser(item.userId) : undefined} countMode /></div> : <p className="py-6 text-sm text-muted-foreground">{reasonLabel(invitesRead.reasonCodes[0] ?? 'GLOBAL_RELATION_SCOPE_UNAVAILABLE')}</p>) : null}</div></Card>
    </div>
    {read ? <Card className="p-0"><div className="flex items-center justify-between gap-2 border-b px-4 py-3"><h2 className="font-semibold">最近分销记录</h2><Button variant="link" size="sm" onClick={() => onOpenPath('/distribution/earnings', '佣金明细')}>查看全部<ArrowRight aria-hidden="true" /></Button></div><div className="px-4 py-2">{read.recent.length ? <EarningsRows rows={read.recent} snapshot={snapshot} onOpenPath={onOpenPath} showSource={false} /> : <p className="py-6 text-center text-sm text-muted-foreground">当前范围没有分销记录。产生记录后将在这里显示。</p>}</div></Card> : coreLoading ? <Card><RankingSkeleton /></Card> : null}
  </section>;
}

function EarningsRows({ rows, snapshot, onOpenPath, showSource = true }: { rows: DashboardEarning[]; snapshot: Snapshot; onOpenPath: OpenPath; showSource?: boolean }) {
  const canOrder = can(snapshot, 'order.read'), canDirectory = can(snapshot, 'user.directory.read');
  const openUser = (row: DashboardEarning) => { if (row.beneficiaryId && canDirectory) onOpenPath(`/users/${encodeURIComponent(row.beneficiaryId)}`, '用户详情'); };
  return <><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>受益人</TableHead><TableHead>角色</TableHead><TableHead>来源订单</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell><div className="flex min-w-0 items-center gap-2"><DistributionUserName userId={row.beneficiaryId} name={row.beneficiaryName ?? '受益人待核'} canOpen={canDirectory} onOpen={() => openUser(row)} className="font-medium" /></div></TableCell><TableCell>{roleLabel(row.role)}</TableCell><TableCell>{row.orderNumber ?? '—'} {showSource ? <HistoryBadge source={row.source} /> : null}{row.orderId && canOrder ? <> <Button variant="link" size="sm" className="px-0" onClick={() => onOpenPath(`/orders/${encodeURIComponent(row.orderId!)}`, '来源订单')}>订单</Button></> : null}</TableCell><TableCell className="tabular-nums">{money(row.amountCents)}{row.recoveryRequiredCents !== null ? <div className="text-xs text-muted-foreground">待追回 {money(row.recoveryRequiredCents)}</div> : null}</TableCell><TableCell><StateBadge state={row.state} /></TableCell><TableCell><span>{formatBeijingDateTime(row.occurredAt)}</span><div className="text-xs text-muted-foreground">{row.settledAt ? `入账 ${formatBeijingDateTime(row.settledAt)}` : '入账时间未核定'}</div></TableCell></TableRow>)}</TableBody></Table></div>
    <ul className="divide-y divide-border md:hidden">{rows.map(row => <li key={row.id} className="space-y-2 py-3"><div className="flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><DistributionUserName userId={row.beneficiaryId} name={row.beneficiaryName ?? '受益人待核'} canOpen={canDirectory} onOpen={() => openUser(row)} className="font-medium" /></div><StateBadge state={row.state} /></div><div className="text-xs text-muted-foreground">{roleLabel(row.role)} · {row.orderNumber ?? '订单待核'} {showSource ? <HistoryBadge source={row.source} /> : null}{row.orderId && canOrder ? <> · <button type="button" className="underline" onClick={() => onOpenPath(`/orders/${encodeURIComponent(row.orderId!)}`, '来源订单')}>订单</button></> : null}</div><div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{money(row.amountCents)}</span><span className="text-xs text-muted-foreground">{formatBeijingDateTime(row.occurredAt)}</span></div>{row.recoveryRequiredCents !== null ? <div className="text-xs text-destructive">待追回 {money(row.recoveryRequiredCents)}</div> : null}<div className="text-xs text-muted-foreground">{row.settledAt ? `入账 ${formatBeijingDateTime(row.settledAt)}` : '入账时间未核定'}</div></li>)}</ul></>;
}

export function DistributionEarningsPage({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const { filters, update } = useDashboardFilters(query, onQueryChange), [nonce, setNonce] = useState(0);
  const allowed = can(snapshot, 'distribution.dashboard.read'), canDirectory = can(snapshot, 'user.directory.read'), identity = dashboardContextIdentity(snapshot);
  const liveQuery = useRef(query); liveQuery.current = query;
  const [draftQ, setDraftQ] = useState(filters.q);
  useEffect(() => { setDraftQ(filters.q); }, [filters.q]);
  const { read, error, busy } = useDashboardList(snapshot, filters, update, nonce, refreshNonce, readDashboardEarnings);
  const canOrder = allowed && can(snapshot, 'order.read'), orderKey = JSON.stringify([identity, canOrder]), liveOrderKey = useRef(orderKey);
  liveOrderKey.current = orderKey;
  const orderSequence = useRef(0), orderController = useRef<AbortController | null>(null), lastAuto = useRef('');
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
  useEffect(() => { orderController.current?.abort(); orderSequence.current++; lastAuto.current = ''; setOrderState(null); return () => { orderController.current?.abort(); orderSequence.current++; lastAuto.current = ''; }; }, [orderKey]);
  useEffect(() => {
    if (canOrder && query.orderId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(query.orderId) && (query.origin === 'NATIVE' || query.origin === 'LEGACY')) {
      const target: { id: string; origin: 'NATIVE' | 'LEGACY' } = { id: query.orderId, origin: query.origin }; if (lastAuto.current !== autoKey(target)) void loadOrder(target);
    }
  }, [orderKey, query.orderId, query.origin, nonce, refreshNonce]);
  if (!allowed) return <ReadDenied/>;
  const total = read ? Number(read.total) : 0;
  return <section className="space-y-5" data-distribution-earnings>
    <PageHeader title="佣金明细" description="按当前已知责任核对佣金记录；未确认原始发生日的记录仍保留，记录金额不是钱包余额。" actions={<Button variant="outline" disabled={busy} onClick={() => { update({ page: 1 }); setNonce(value => value + 1); }}><RefreshCw aria-hidden="true" />刷新</Button>} />
    {!canDirectory ? <p className="text-xs text-amber-600 dark:text-amber-400" role="status">无用户目录读取权限，昵称不参与匹配；请使用用户 ID 或订单号。</p> : null}
    <Card className="p-3"><form data-distribution-earnings-filters className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); update({ q: draftQ.trim() }); }}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="min-w-[14rem] max-w-md flex-1 space-y-2 text-sm"><span className="block text-muted-foreground">搜索</span><div className="relative"><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索订单号或受益人" value={draftQ} onChange={event => setDraftQ(event.target.value)} onBlur={() => { if (draftQ.trim() !== filters.q) update({ q: draftQ.trim() }); }} placeholder="订单号 / 受益人昵称或 ID，回车搜索" className="pl-8" /></div></label>
        <div className="shrink-0 space-y-2 text-sm"><span className="block text-muted-foreground">日期</span><DistributionDateRange label="选择佣金发生日期" className="min-w-[15.5rem]" from={filters.from} to={filters.to} onChange={(from, to) => update({ from, to, page: 1 })} /></div>
        <div className="flex flex-wrap items-end gap-2">
          <FilterSelect className="w-[8.75rem]" label="来源" value={filters.source} options={sourceOptions} onChange={source => update({ source: source as DashboardFilters['source'] })} />
          <FilterSelect className="w-[8.75rem]" label="状态" value={filters.state} options={{ ALL: '全部状态', PENDING: stateLabel('PENDING'), MATURED: stateLabel('MATURED'), VOID: stateLabel('VOID'), UNKNOWN: '待核对', SETTLED: stateLabel('SETTLED'), REVOKED: stateLabel('REVOKED'), RECOVERY_REQUIRED: stateLabel('RECOVERY_REQUIRED'), EXPIRED: stateLabel('EXPIRED') }} onChange={state => update({ state: state as DashboardFilters['state'] })} />
          <FilterSelect className="w-[8.75rem]" label="角色" value={filters.role} options={{ ALL: '全部角色', RENTER_REFERRAL: '租客来源', OWNER_REFERRAL: '号主来源', TASK_REFERRAL: '历史任务' }} onChange={role => update({ role: role as DashboardFilters['role'] })} />
        </div>
      </div>
    </form></Card>
    {canOrder && (orderError || orderMatches.length || orderRead || orderBusy) ? <Card>
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
    {read ? <><Card className="p-0">{read.items.length ? <EarningsRows rows={read.items} snapshot={snapshot} onOpenPath={onOpenPath} /> : <p className="py-10 text-center text-sm text-muted-foreground">当前范围没有佣金记录</p>}</Card><ListPagination mode="page" page={filters.page} pageSize={filters.pageSize} total={total} loadedCount={read.items.length} loading={busy} pageSizeOptions={[10, 20, 50, 100]} itemLabel="条记录" onPageChange={page => update({ page })} onPageSizeChange={pageSize => update({ pageSize, page: 1 })} /></> : null}
  </section>;
}

export function DistributionParticipantsPage(props: PageProps) {
  const {snapshot}=props;
  if(!can(snapshot,'distribution.dashboard.read')||!snapshot.security.isBoss&&snapshot.gameScope?.mode!=='ALL_GAMES')return can(snapshot,'distribution.participant.read')
    ? <section className="space-y-5"><PageHeader title="分销商" description="维护分销等级和邀请码。"/><DistributionParticipantManager snapshot={snapshot} onOpenUser={id=>props.onOpenPath(`/users/${encodeURIComponent(id)}`,'用户详情')}/></section>
    : <ReadDenied/>;
  return <DistributionParticipantsDashboard {...props}/>;
}
function DistributionParticipantsDashboard({ snapshot, onOpenPath, query = emptyQuery, onQueryChange, refreshNonce = 0 }: PageProps) {
  const { filters, update } = useDashboardFilters(query, onQueryChange), [nonce, setNonce] = useState(0);
  const [draftQ, setDraftQ] = useState(filters.q), syncedQ = useRef(filters.q);
  const [management, setManagement] = useState<{ userId:string; name:string; action:ParticipantManagementAction; identity:string } | null>(null);
  useLayoutEffect(() => { if (syncedQ.current !== filters.q) { syncedQ.current = filters.q; setDraftQ(filters.q); } }, [filters.q]);
  const allowed = can(snapshot, 'distribution.dashboard.read'), canDirectory = can(snapshot, 'user.directory.read');
  const { read, error, busy } = useDashboardList(snapshot, filters, update, nonce, refreshNonce, readDashboardParticipants);
  const identity=dashboardContextIdentity(snapshot),canManage=can(snapshot,'distribution.participant.read')&&can(snapshot,'distribution.participant.manage');
  useEffect(()=>setManagement(null),[identity]);
  if (!allowed) return <ReadDenied/>;
  const openDetail = (userId: string) => onOpenPath(`/distribution/participants/${encodeURIComponent(userId)}`, '分销商详情');
  const currentManagement=management?.identity===identity&&canManage?management:null;
  const openManagement=(item:DashboardParticipant,action:ParticipantManagementAction)=>setManagement({userId:item.userId,name:item.name??'该用户',action,identity});
  const participantActions=(item:DashboardParticipant)=><div className="flex flex-wrap justify-end gap-1"><Button variant="ghost" size="sm" onClick={()=>openDetail(item.userId)}>详情</Button>{canManage?<><Button variant="ghost" size="sm" aria-label={`调整${item.name??'该用户'}的分销等级`} onClick={()=>openManagement(item,'level')}>调整等级</Button><Button variant="ghost" size="sm" aria-label={`修改${item.name??'该用户'}的邀请码`} onClick={()=>openManagement(item,'code')}>修改邀请码</Button><Button variant="ghost" size="sm" aria-label={`管理${item.name??'该用户'}的分销资格`} onClick={()=>openManagement(item,'freeze')}>{item.frozen===null?'查看资格':item.frozen?'解除冻结':'冻结资格'}</Button></>:null}</div>;
  const total = read ? Number(read.total) : 0;
  const count = (item: { recordCount?: string | null; mappedRecordCount?: string }) => item.recordCount ?? item.mappedRecordCount ?? null;
  return <TooltipProvider><section className="space-y-5" data-distribution-participants>
    <PageHeader title="分销商" description="按已接入佣金记录与已核责任汇总；来源覆盖尚未核全，记录金额不等于钱包余额。旧资格来源可在详情查看。" actions={<Button variant="outline" disabled={busy} onClick={() => { update({ page: 1 }); setNonce(value => value + 1); }}><RefreshCw aria-hidden="true" />刷新</Button>} />
    {!canDirectory ? <p className="text-xs text-amber-600 dark:text-amber-400" role="status">无用户目录读取权限，昵称不参与匹配；请使用用户 ID 或订单号。</p> : null}
    <Card className="p-3"><form data-distribution-participants-filters className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); update({ q: draftQ.trim(), page: 1 }); }}><label className="min-w-[14rem] max-w-md flex-1 space-y-2 text-sm"><span className="block text-muted-foreground">搜索</span><div className="relative"><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索分销商" value={draftQ} onChange={event => setDraftQ(event.target.value)} onBlur={() => { if (draftQ.trim() !== filters.q) update({ q: draftQ.trim(), page: 1 }); }} placeholder="昵称或用户 ID，回车搜索" className="pl-8" /></div></label><Button type="submit" variant="outline" disabled={busy}>查询</Button></form></Card>
    {error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>分销商列表暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <p role="status" className="text-sm text-muted-foreground">正在读取分销商…</p> : null}
    {read ? <><Card className="p-0">{read.items.length ? <><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow>
<TableHead className="px-4">用户</TableHead>
<TableHead className="px-3">资格</TableHead>
<TableHead className="min-w-[14rem] px-4">关系</TableHead>
<ParticipantSortHeader label="分销单数" column="recordCount" sort={filters.sort} order={filters.order} onSort={(sort, order) => update({ sort, order, page: 1 })} className="min-w-[6.5rem] px-4 text-right" />
<ParticipantSortHeader label="已结算" column="settledCents" sort={filters.sort} order={filters.order} onSort={(sort, order) => update({ sort, order, page: 1 })} className="min-w-[7.5rem] px-4 text-right" />
<ParticipantSortHeader label="待结算" column="pendingCents" sort={filters.sort} order={filters.order} onSort={(sort, order) => update({ sort, order, page: 1 })} className="min-w-[7.5rem] px-4 text-right" />
<TableHead className="min-w-[7rem] px-4">分销商等级</TableHead>
<TableHead className="min-w-[15rem] px-4 text-right">操作</TableHead>
</TableRow></TableHeader><TableBody>{read.items.map(item => <TableRow key={item.userId}>
<TableCell className="px-4 py-3.5"><DistributionUserName userId={item.userId} name={item.name ?? '未命名用户'} canOpen canPreview={canDirectory} onOpenProfile={() => onOpenPath(`/users/${encodeURIComponent(item.userId)}`, '用户详情')} onOpen={() => openDetail(item.userId)} className="font-medium" /></TableCell>
<TableCell className="px-3 py-3.5"><div className="flex flex-wrap gap-1.5"><Badge variant={item.frozen===true?'destructive':item.eligibility==='ELIGIBLE'&&item.frozen===false?'success':'warning'}>{participantEligibilityLabel(item)}</Badge>{item.frozen&&item.eligibility!=='ELIGIBLE' ? <Badge variant="destructive">冻结</Badge> : null}</div></TableCell>
<TableCell className="whitespace-normal px-4 py-3.5"><div className="space-y-2.5 text-sm leading-5"><RelationMetric label="邀请人数" tip={INVITE_REGISTER_TIP} total={item.inviterChildren} mapped={item.mappedInviterChildren} /><RelationMetric label="产生佣金人数" tip={COMMISSION_CHILD_TIP} total={item.contributorChildren ?? null} mapped={item.mappedContributorChildren} contributor /></div></TableCell>
<TableCell className="px-4 py-3.5 text-right tabular-nums">{count(item) ?? '—'}{item.earningsCoverage === 'UNKNOWN' ? <div className="mt-1 text-xs text-muted-foreground">来源待核</div> : null}</TableCell>
<TableCell className="px-4 py-3.5 text-right tabular-nums">{money(item.settledCents)}{item.recoveryCents && item.recoveryCents !== '0' ? <div className="mt-1 text-xs text-destructive">待追回 {money(item.recoveryCents)}</div> : null}</TableCell>
<TableCell className="px-4 py-3.5 text-right tabular-nums">{money(item.pendingCents)}{item.needsReviewCount && item.needsReviewCount !== '0' ? <div className="mt-1 text-xs text-muted-foreground">待核对 {item.needsReviewCount} 笔</div> : null}</TableCell>
<TableCell className="px-4 py-3.5">{participantLevelLabel(item)}</TableCell>
<TableCell className="px-4 py-3.5">{participantActions(item)}</TableCell>
</TableRow>)}</TableBody></Table></div><ul className="divide-y divide-border md:hidden">{read.items.map(item => <li key={item.userId} className="space-y-2 p-4"><div className="flex items-start justify-between gap-2"><DistributionUserName userId={item.userId} name={item.name ?? '未命名用户'} canOpen canPreview={canDirectory} onOpenProfile={() => onOpenPath(`/users/${encodeURIComponent(item.userId)}`, '用户详情')} onOpen={() => openDetail(item.userId)} className="font-medium" /><span className="text-xs text-muted-foreground">{participantLevelLabel(item)}</span></div><div className="flex flex-wrap gap-2"><Badge variant={item.frozen===true?'destructive':item.eligibility==='ELIGIBLE'&&item.frozen===false?'success':'warning'}>{participantEligibilityLabel(item)}</Badge>{item.frozen&&item.eligibility!=='ELIGIBLE' ? <Badge variant="destructive">冻结</Badge> : null}</div><dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm"><div><dt className="text-xs text-muted-foreground inline-flex items-center gap-0.5">产生佣金人数<InfoHint label="产生佣金人数说明">{COMMISSION_CHILD_TIP}</InfoHint></dt><dd className="inline-flex items-center gap-1">{participantChildrenLabel(item.contributorChildren ?? null, item.mappedContributorChildren, '已确认')}{item.contributorChildren == null && item.mappedContributorChildren !== undefined ? <InfoHint label="已确认人数说明">{MAPPED_CONTRIBUTORS_TIP}</InfoHint> : null}</dd></div><div><dt className="text-xs text-muted-foreground inline-flex items-center gap-0.5">邀请人数<InfoHint label="邀请人数说明">{INVITE_REGISTER_TIP}</InfoHint></dt><dd className="inline-flex items-center gap-1">{participantChildrenLabel(item.inviterChildren, item.mappedInviterChildren)}{item.inviterChildren === null && item.mappedInviterChildren !== undefined ? <InfoHint label="已接入人数说明">{MAPPED_CHILDREN_TIP}</InfoHint> : null}</dd></div><div><dt className="text-xs text-muted-foreground">分销单数</dt><dd className="tabular-nums">{count(item) ?? '—'}</dd></div><div><dt className="text-xs text-muted-foreground">已结算</dt><dd className="tabular-nums">{money(item.settledCents)}</dd></div><div><dt className="text-xs text-muted-foreground">待结算</dt><dd className="tabular-nums">{money(item.pendingCents)}</dd></div>{item.needsReviewCount && item.needsReviewCount !== '0' ? <div><dt className="text-xs text-muted-foreground">待核对</dt><dd>{item.needsReviewCount} 笔 · {money(item.needsReviewCents)}</dd></div> : null}{item.recoveryCents && item.recoveryCents !== '0' ? <div><dt className="text-xs text-muted-foreground">待追回</dt><dd className="tabular-nums text-destructive">{money(item.recoveryCents)}</dd></div> : null}</dl>{participantActions(item)}</li>)}</ul></> : <p className="py-10 text-center text-sm text-muted-foreground">当前范围没有分销商</p>}</Card><ListPagination mode="page" page={filters.page} pageSize={filters.pageSize} total={total} loadedCount={read.items.length} loading={busy} pageSizeOptions={[10, 20, 50, 100]} itemLabel="位分销商" onPageChange={page => update({ page })} onPageSizeChange={pageSize => update({ pageSize, page: 1 })} /></> : null}
    <Dialog open={currentManagement!==null} onOpenChange={open=>{if(!open)setManagement(null);}}>
      {currentManagement?<DialogContent className="sm:max-w-lg" closeLabel="关闭分销商维护"><DialogHeader><DialogTitle>{currentManagement.action==='level'?'调整分销等级':currentManagement.action==='code'?'修改邀请码':'分销资格管理'}</DialogTitle><DialogDescription>{currentManagement.name} · {currentManagement.action==='freeze'?'冻结只影响后续新增计佣。':currentManagement.action==='code'?'历史邀请关系和佣金保持不变。':'新等级用于后续付款的订单。'}</DialogDescription></DialogHeader><DistributionParticipantManager snapshot={snapshot} initialUserId={currentManagement.userId} directAction={currentManagement.action} onClose={()=>setManagement(null)} onChanged={()=>setNonce(value=>value+1)}/></DialogContent>:null}
    </Dialog>
  </section></TooltipProvider>;
}

const DOWNLINE_TIP: Record<DashboardDownlineType, string> = { COMMISSION_CONTRIBUTOR: COMMISSION_CHILD_TIP, INVITER: INVITE_REGISTER_TIP };
function SummaryStat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return <div className="min-w-0 px-4 py-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 truncate text-xl font-semibold tabular-nums">{value}</dd>{hint ? <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd> : null}</div>;
}
function UplineRow({ title, tip, relation, knowledge, snapshot, onOpenPath }: { title: string; tip: string; relation?: { parentUserId: string | null; parentName: string | null }; knowledge: string; snapshot: Snapshot; onOpenPath: OpenPath }) {
  const canDirectory = can(snapshot, 'user.directory.read');
  const body = relation?.parentUserId
    ? <DistributionUserName userId={relation.parentUserId} name={relation.parentName ?? '未命名用户'} canOpen={canDirectory} onOpen={() => onOpenPath(`/users/${encodeURIComponent(relation.parentUserId!)}`, '用户详情')} className="font-medium" />
    : <span className="text-muted-foreground">{knowledge === 'KNOWN_NONE' ? '无' : '还没核对清楚'}</span>;
  return <div className="flex items-center justify-between gap-3 py-3"><span className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground">{title}<InfoHint label={title + '说明'}>{tip}</InfoHint></span><div className="flex min-w-0 items-center gap-2 text-sm">{body}{relation?.parentUserId ? <Button variant="ghost" size="sm" onClick={() => onOpenPath(`/distribution/participants/${encodeURIComponent(relation.parentUserId!)}`, '分销商详情')}>分销详情<ArrowRight aria-hidden="true" /></Button> : null}</div></div>;
}
function DownlinePanel({ snapshot, userId, onOpenPath, counts, refreshNonce }: { snapshot: Snapshot; userId: string; onOpenPath: OpenPath; counts?: { knowledge: 'KNOWN' | 'PARTIAL'; inviter?: number; contributors?: number; contributorKnowledge?: 'KNOWN' | 'PARTIAL' }; refreshNonce: number }) {
  const [type, setType] = useState<DashboardDownlineType>('INVITER'), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10);
  const { read, error, busy, refreshing } = useDashboardRead(snapshot, JSON.stringify(['downline', userId, type, page, pageSize, refreshNonce]), can(snapshot, 'distribution.dashboard.read'), signal => readDashboardParticipantDownline(userId, type, page, pageSize, signal), undefined, { retainPrevious: true });
  const canDirectory = can(snapshot, 'user.directory.read');
  const count = (n?: number, knowledge?: 'KNOWN' | 'PARTIAL') => n === undefined ? '' : ` ${n}${knowledge === 'PARTIAL' ? '+' : ''}`;
  const visibleRead = read?.type === type ? read : undefined;
  const partial = visibleRead ? visibleRead.knowledge === 'PARTIAL' : type === 'INVITER' ? counts?.knowledge === 'PARTIAL' : counts?.contributorKnowledge === 'PARTIAL';
  return <Card className="p-0"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><h2 className="font-semibold">邀请用户</h2><Tabs value={type} onValueChange={value => { if (value === 'COMMISSION_CONTRIBUTOR' || value === 'INVITER') { setType(value); setPage(1); } }}><TabsList><TabsTrigger value="INVITER">邀请人数{count(counts?.inviter, counts?.knowledge)}</TabsTrigger><TabsTrigger value="COMMISSION_CONTRIBUTOR">产生佣金人数{count(counts?.contributors, counts?.contributorKnowledge)}</TabsTrigger></TabsList></Tabs></div>
    <p className="flex items-center gap-1 px-4 pt-3 text-xs text-muted-foreground">{type === 'COMMISSION_CONTRIBUTOR' ? '已确认产生有效佣金的受邀用户' : '使用邀请码注册的用户'}<InfoHint label="邀请用户说明">{DOWNLINE_TIP[type]}</InfoHint></p>
    {partial ? <p className="px-4 pt-1 text-xs text-muted-foreground">{type === 'INVITER' ? '仅列出已接入的邀请关系，完整人数待核。' : '仅列出已确认产生有效佣金的用户，完整人数待核。'}</p> : null}
    {error ? <Alert variant="warning" className="m-4 w-auto"><CircleAlert aria-hidden="true" /><AlertTitle>下线暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!visibleRead && busy ? <RankingSkeleton /> : null}
    {visibleRead ? <div className={refreshing ? 'opacity-60 transition-opacity' : ''}>{(visibleRead.items ?? []).length ? <Table><TableHeader><TableRow><TableHead className="px-4">用户</TableHead><TableHead>分销等级</TableHead><TableHead>他的邀请人数</TableHead><TableHead>建立时间</TableHead><TableHead className="px-4 text-right">操作</TableHead></TableRow></TableHeader><TableBody>{(visibleRead.items ?? []).map(item => <TableRow key={item.userId}><TableCell className="px-4"><div className="flex items-center gap-2"><DistributionUserName userId={item.userId} name={item.name ?? '未命名用户'} canOpen={canDirectory} onOpen={() => onOpenPath(`/users/${encodeURIComponent(item.userId)}`, '用户详情')} className="font-medium" />{item.sourceType === 'LEGACY_MYSQL' ? <Badge variant="outline">旧平台关系</Badge> : null}{item.participant?.frozen===true ? <Badge variant="secondary">已冻结</Badge> : item.participant?.frozen===null ? <Badge variant="outline">冻结状态待核</Badge> : null}</div></TableCell><TableCell>{item.participant ? item.participant.levelName ?? (item.participant.eligibility === 'ELIGIBLE' ? '资格有效' : '不参与') : '—'}</TableCell><TableCell className="tabular-nums">{participantChildrenLabel(item.children, item.mappedChildren)}</TableCell><TableCell className="text-muted-foreground">{item.boundAt ? formatBeijingDateTime(item.boundAt) : '—'}</TableCell><TableCell className="px-4 text-right">{item.participant ? <Button variant="ghost" size="sm" onClick={() => onOpenPath(`/distribution/participants/${encodeURIComponent(item.userId)}`, '分销商详情')}>分销详情<ArrowRight aria-hidden="true" /></Button> : null}</TableCell></TableRow>)}</TableBody></Table> : <p className="py-10 text-center text-sm text-muted-foreground">{partial ? '暂无已确认的用户记录' : '暂无用户记录'}</p>}
      {Number(visibleRead.total) > 0 ? <div className="border-t border-border px-4 py-2"><ListPagination mode="page" page={page} pageSize={pageSize} total={Number(visibleRead.total)} loadedCount={(visibleRead.items ?? []).length} loading={refreshing} pageSizeOptions={[10, 20, 50, 100]} itemLabel="人" onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} /></div> : null}</div> : null}
  </Card>;
}
function ParticipantEarnings({ snapshot, userId, onOpenPath, refreshNonce }: { snapshot: Snapshot; userId: string; onOpenPath: OpenPath; refreshNonce: number }) {
  const [filters, setFilters] = useState<DashboardFilters>(() => ({ ...dashboardFiltersFromQuery({}), beneficiary: userId, pageSize: 10 }));
  const update = (patch: Partial<DashboardFilters>) => setFilters(current => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const { read, error, busy } = useDashboardList(snapshot, filters, update, 0, refreshNonce, readDashboardEarnings);
  const canOrder = can(snapshot, 'order.read');
  return <Card className="p-0"><div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3"><h2 className="font-semibold">佣金明细</h2><div className="flex flex-wrap items-end gap-2">
      <div className="space-y-2 text-sm"><span className="block text-muted-foreground">日期</span><DistributionDateRange label="选择佣金发生日期" className="min-w-[15.5rem]" from={filters.from} to={filters.to} onChange={(from, to) => update({ from, to })} /></div>
      <FilterSelect className="w-[8.75rem]" label="状态" value={filters.state} options={{ ALL: '全部状态', PENDING: stateLabel('PENDING'), SETTLED: stateLabel('SETTLED'), RECOVERY_REQUIRED: stateLabel('RECOVERY_REQUIRED'), VOID: stateLabel('VOID'), REVOKED: stateLabel('REVOKED'), UNKNOWN: '待核对' }} onChange={state => update({ state: state as DashboardFilters['state'] })} />
      <FilterSelect className="w-[8.75rem]" label="角色" value={filters.role} options={{ ALL: '全部角色', RENTER_REFERRAL: '租客来源', OWNER_REFERRAL: '号主来源', TASK_REFERRAL: '历史任务' }} onChange={role => update({ role: role as DashboardFilters['role'] })} />
    </div></div>
    {error ? <Alert variant="warning" className="m-4 w-auto"><CircleAlert aria-hidden="true" /><AlertTitle>佣金记录暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <RankingSkeleton /> : null}
    {read ? <>{(read.items ?? []).length ? <Table><TableHeader><TableRow><TableHead className="px-4">来源订单</TableHead><TableHead>角色</TableHead><TableHead className="text-right">金额</TableHead><TableHead>状态</TableHead><TableHead className="px-4">时间</TableHead></TableRow></TableHeader><TableBody>{(read.items ?? []).map(row => <TableRow key={row.id}><TableCell className="px-4"><div className="flex items-center gap-2">{row.orderId && canOrder ? <button type="button" className="font-medium hover:underline" onClick={() => onOpenPath(`/orders/${encodeURIComponent(row.orderId!)}`, '来源订单')}>{row.orderNumber ?? '查看订单'}</button> : <span>{row.orderNumber ?? '—'}</span>}<HistoryBadge source={row.source} /></div></TableCell><TableCell>{roleLabel(row.role)}</TableCell><TableCell className="text-right tabular-nums">{money(row.amountCents)}{row.recoveryRequiredCents !== null ? <div className="text-xs text-muted-foreground">待追回 {money(row.recoveryRequiredCents)}</div> : null}</TableCell><TableCell><StateBadge state={row.state} /></TableCell><TableCell className="px-4 text-muted-foreground">{formatBeijingDateTime(row.occurredAt)}</TableCell></TableRow>)}</TableBody></Table> : <p className="py-10 text-center text-sm text-muted-foreground">这段时间没有佣金记录</p>}
      {Number(read.total) > 0 ? <div className="border-t border-border px-4 py-2"><ListPagination mode="page" page={filters.page} pageSize={filters.pageSize} total={Number(read.total)} loadedCount={(read.items ?? []).length} loading={busy} pageSizeOptions={[10, 20, 50, 100]} itemLabel="条记录" onPageChange={page => update({ page })} onPageSizeChange={pageSize => update({ pageSize })} /></div> : null}</> : null}
  </Card>;
}
export function DistributionParticipantPage({ snapshot, userId, onOpenPath, refreshNonce = 0 }: PageProps & { userId: string }) {
  const network = snapshot.security.isBoss || snapshot.gameScope?.mode==='ALL_GAMES';
  const allowed = network && can(snapshot, 'distribution.dashboard.read');
  const { read, error, busy } = useDashboardRead(snapshot, JSON.stringify([userId, refreshNonce]), allowed, signal => readDashboardParticipant(userId, signal));
  const canDirectory = can(snapshot, 'user.directory.read');
  if (!allowed) return can(snapshot,'distribution.participant.read')?<section className="space-y-5"><PageHeader title="分销商详情" description="维护用户的分销等级与邀请码。" actions={<Button variant="outline" onClick={()=>onOpenPath('/distribution/participants','分销商')}>返回分销商</Button>}/><DistributionParticipantManager snapshot={snapshot} initialUserId={userId} onOpenUser={id=>onOpenPath(`/users/${encodeURIComponent(id)}`,'用户详情')}/></section>:<ReadDenied/>;
  const p = read?.participant, rel = (type: string) => read?.relations.find(item => item.type === type);
  const partial = p?.earningsCoverage === 'UNKNOWN';
  return <section className="space-y-5" data-distribution-participant>
    <PageHeader title="分销商详情" description="看这个人赚了多少佣金、谁带他进来、他又带来了谁。" actions={<Button variant="outline" onClick={() => onOpenPath('/distribution/participants', '分销商')}><ChevronLeft aria-hidden="true" />返回分销商</Button>} />
    {error ? <Alert variant="warning"><CircleAlert aria-hidden="true" /><AlertTitle>分销商详情暂不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!read && busy ? <Card><RankingSkeleton /></Card> : null}
    {read && p ? <>
      {can(snapshot,'distribution.participant.read')?<DistributionParticipantManager snapshot={snapshot} initialUserId={userId} onOpenUser={id=>onOpenPath(`/users/${encodeURIComponent(id)}`,'用户详情')}/>:null}
      <Card className="p-0"><div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><DistributionUserName userId={p.userId} name={p.name ?? '未命名用户'} canOpen={canDirectory} onOpen={() => onOpenPath(`/users/${encodeURIComponent(p.userId)}`, '用户详情')} className="text-lg font-semibold" /><Badge variant="outline">{participantLevelLabel(p)}</Badge><Badge variant={p.frozen===true?'destructive':p.eligibility==='ELIGIBLE'&&p.frozen===false?'success':'secondary'}>{participantEligibilityLabel(p)}</Badge>{p.frozen&&p.eligibility!=='ELIGIBLE' ? <Badge variant="destructive">佣金已冻结</Badge> : null}</div></div>{canDirectory ? <Button variant="outline" onClick={() => onOpenPath(`/users/${encodeURIComponent(p.userId)}`, '用户详情')}>用户资料</Button> : null}</div>
        <dl className="grid grid-cols-2 divide-border border-t border-border sm:grid-cols-4 sm:divide-x">
          <SummaryStat label="分销单数" value={p.mappedRecordCount ?? '—'} hint={partial ? '旧平台记录还没全部核对完' : undefined} />
          <SummaryStat label="已结算" value={money(p.settledCents)} />
          <SummaryStat label="待结算" value={money(p.pendingCents)} />
          <SummaryStat label="待追回" value={money(p.recoveryCents)} hint={p.needsReviewCount && p.needsReviewCount !== '0' ? `另有 ${p.needsReviewCount} 笔待核对，${money(p.needsReviewCents)}` : undefined} />
        </dl></Card>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card><h2 className="font-semibold">上线</h2><div className="mt-1 divide-y divide-border">
          <UplineRow title="计佣上级" tip="他产生的佣金会分给这个人。" relation={rel('DISTRIBUTION_LEADER')} knowledge={p.leader} snapshot={snapshot} onOpenPath={onOpenPath} />
          <UplineRow title="邀请人" tip="他是用这个人的邀请码注册的；只说明注册来源，不一定会分佣。" relation={rel('INVITER')} knowledge={p.inviter} snapshot={snapshot} onOpenPath={onOpenPath} />
        </div></Card>
        <DownlinePanel snapshot={snapshot} userId={p.userId} onOpenPath={onOpenPath} counts={read.downline} refreshNonce={refreshNonce} />
      </div>
      <ParticipantEarnings key={p.userId} snapshot={snapshot} userId={p.userId} onOpenPath={onOpenPath} refreshNonce={refreshNonce} />
    </> : null}
  </section>;
}

export function DistributionPolicyPage({ snapshot, onOpenPath, onDirtyChange }: { snapshot: Snapshot; onOpenPath: OpenPath; onDirtyChange: (dirty: boolean) => void }) {
  const access = distributionPolicyAccess(snapshot);
  const identity = dashboardContextIdentity(snapshot);
  const [policyRefresh,setPolicyRefresh]=useState(0);
  const [assembly, setAssembly] = useState({ identity, ready: false, admitted: false });
  const reportAssembly = useCallback((ready: boolean) => setAssembly(current => current.identity === identity && current.ready === ready ? current : { identity, ready, admitted: ready || current.identity === identity && current.admitted }), [identity]);
  if (!active(snapshot) || !access.canRead&&!can(snapshot,'distribution.level.manage')) return <ReadDenied/>;
  return <section className="space-y-5" data-distribution-policy-page><PageHeader title="分销政策" description="管理分销等级与奖励规则。" /><DistributionLevelManager snapshot={snapshot} onChanged={()=>setPolicyRefresh(value=>value+1)}/>{access.canRead?<DistributionPolicyPanel snapshot={snapshot} onOpenPath={onOpenPath} onDirtyChange={onDirtyChange} onWriteAssemblyReady={reportAssembly} compact={can(snapshot,'distribution.level.manage')} refreshNonce={policyRefresh}/>:null}{access.canManage && assembly.identity === identity && assembly.admitted ? <DistributionMaintenancePanel key={identity} canExecute={assembly.ready}/> : null}</section>;
}
