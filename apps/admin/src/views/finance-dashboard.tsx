import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, ChevronDown, CircleHelp, RefreshCw } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { adminRequest, AdminApiError, ADMIN_AUTH_FAILURE_EVENT, friendlyError, type SessionSnapshot } from '../api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { ChartContainer, ChartTooltip } from '../components/ui/chart';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Skeleton } from '../components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { ActionTooltip } from '../components/ui/tooltip';
import { DateSelector, type DateSelectorValue } from '../components/reui/date-selector';
import { EntityPreviewTrigger, UserProfilePreview } from '../components/admin-preview';
import { financeMoney, financeTime, type FinanceOverview } from './admin-finance-api';
import { financeContextIdentity } from './admin-finance-view';
import { ContributionSheet, type ContributionContext } from './finance-dashboard-contributions';
import type { WorkspaceTab } from '../workspace/tab-model';
import { beijingCalendarDate } from '../workspace/beijing-time';
import './finance-dashboard.css';

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type Range = 'today' | '7d' | '30d' | 'all' | 'custom';
type Source = 'all' | 'new' | 'legacy';
type Point = { date: string; orders: string | null; knownAmounts: string | null; cents: string | null; legacyOrders: string | null; estimateOrders: string | null; estimateKnown: string | null; estimateCents: string | null; estimateDiscrepancies: string | null; settlements: string | null; knownContributions: string | null; contributionCents: string | null };
type Insights = { cancelled: string; completed: string; active: string; unknown: string; repeatRenters: string; nativeOrders: string; legacyOrders: string; frequency: { orders: number; users: string }[] };
type Trend = { version: string; period: { from: string | null; to: string; asOf: string; granularity: 'day' | 'month' }; legacy: string; estimateState: string; continuations: string; openingReferenceAt: string | null; insights: Insights | null; points: Point[] };
type Customer = { userId: string; name: string; orderCount: string; paidCents: string; contributionCents: string; latestAt: string; omittedCount: string; legacyOrderCount: string; compensationRecordCount: string; historicalCompensationCents: string | null };
type Ranking = { version: string; period:Trend['period']; basis: 'settled' | 'paid'; legacy: string; continuations: string; omittedCount: string; items: Customer[] };
type ChannelFlow = { state: string; items: { kind: string; count: string; cents: string }[] };
type Merchant = { state: string; accounts: { merchantIdentityId: string; available: { latestVerifiedSnapshot: { recordedAt: string; amounts: Record<string, { unitKnowledge: string; cents: string | null }> | null } | null } }[] };
type Status = FinanceOverview & { queues?: { refunds: { count: string | null; amountCents: string | null }; withdrawals: { count: string | null; amountCents: string | null } } };
type Load<T> = { value?: T; error?: unknown; loading: boolean };
const dayText = (date?: Date) => date ? [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-') : '';
const profileRequest = <T,>(path: string) => adminRequest<T>(path);
const ranges: { value: Exclude<Range, 'custom'>; text: string }[] = [{ value: 'today', text: '今天' }, { value: '7d', text: '近 7 天' }, { value: '30d', text: '近 30 天' }, { value: 'all', text: '全部时间' }];
function nextDay(day: string, monthly = false) {
  const date = new Date(`${day}T00:00:00Z`);
  if (monthly) date.setUTCMonth(date.getUTCMonth()+1); else date.setUTCDate(date.getUTCDate()+1);
  return date.toISOString().slice(0,10);
}
function afterSnapshot(value:string):string | null {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!parts) return null;
  const seconds = Date.parse(parts[1] + 'Z');
  if (!Number.isFinite(seconds)) return null;
  const micros = Number((parts[2] ?? '').padEnd(6,'0')) + 1, date = new Date(seconds + (micros >= 1000000 ? 1000 : 0));
  return date.toISOString().replace(/\.\d{3}Z$/, `.${String(micros % 1000000).padStart(6,'0')}Z`);
}
export function dashboardPaidOrdersPath(period: Trend['period'], source: Source, status?: string, pointDate?: string): string | null {
  const snapshotEnd = afterSnapshot(period.asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.to) || !snapshotEnd) return null;
  let from = pointDate ?? period.from, toExclusive = nextDay(period.to);
  if (pointDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pointDate)) return null;
    if (period.from && period.from > pointDate) from = period.from;
    const bucketEnd = nextDay(pointDate,period.granularity === 'month');
    if (bucketEnd < toExclusive) toExclusive = bucketEnd;
  }
  const midnight = Date.parse(`${toExclusive}T00:00:00+08:00`);
  const end = midnight <= Date.parse(period.asOf) ? new Date(midnight).toISOString() : snapshotEnd;
  if (!Number.isFinite(midnight) || from && Date.parse(`${from}T00:00:00+08:00`) >= Date.parse(end)) return null;
  const query = new URLSearchParams({paidTo:end});
  if (from) query.set('paidFrom',`${from}T00:00:00+08:00`);
  if (source !== 'all') query.set('origin',source === 'new' ? 'NATIVE' : 'LEGACY');
  if (status) query.set('status',status);
  return `/orders?${query}`;
}

function useRead<T>(key: string, allowed: boolean, path: string, reload: number): Load<T> {
  const [state, setState] = useState<{ key: string; value?: T; error?: unknown }>();
  const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), current = ++sequence.current;
    const clear = () => { sequence.current++; controller.abort(); setState(undefined); };
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, clear);
    setState(undefined);
    if (allowed) void adminRequest<T>(path, undefined, 'GET', {}, controller.signal).then(value => {
      if (!controller.signal.aborted && current === sequence.current) setState({ key, value });
    }).catch(error => {
      if (!controller.signal.aborted && current === sequence.current) setState({ key, error });
    });
    return () => { controller.abort(); window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, clear); };
  }, [key, allowed, path, reload]);
  const current = allowed && state?.key === key ? state : undefined;
  return { value: current?.value, error: current?.error, loading: allowed && !current };
}

function PanelState({ loading, error, onRetry, denied }: { loading: boolean; error?: unknown; onRetry: () => void; denied?: string }) {
  if (denied) return <p className="funds-dash-message" role="status">{denied}</p>;
  if (loading) return <div className="funds-dash-skeleton" aria-label="正在读取" aria-busy="true"><Skeleton className="h-5 w-2/5"/><Skeleton className="h-36 w-full"/></div>;
  if (error) return <div className="funds-dash-message" role="status"><p>{error instanceof AdminApiError && error.status === 404 ? '当前 API 尚未更新，请稍后刷新。' : friendlyError(error)}</p><Button variant="outline" size="sm" onClick={onRetry}>重新读取</Button></div>;
  return null;
}

function MetricLabel({ label, tip }: { label: string; tip: string }) {
  return <span className="funds-dash-label">{label}<ActionTooltip content={tip}><Button type="button" variant="ghost" size="icon-xs" className="funds-dash-help-icon" aria-label={`${label}说明`}><CircleHelp size={14} aria-hidden/></Button></ActionTooltip></span>;
}

function DashboardHelp({ kind, onClose }: { kind: 'trend' | 'funds' | null; onClose: () => void }) {
  return <Dialog open={kind !== null} onOpenChange={open => { if (!open) onClose(); }}><DialogContent size="md" className="funds-dash-help-dialog" closeLabel="关闭说明">
    <DialogHeader><DialogTitle>{kind === 'funds' ? '资金现状怎么看' : '交易和收益怎么算'}</DialogTitle><DialogDescription>用一笔简单的业务说明各项数字的关系。</DialogDescription></DialogHeader>
    {kind === 'funds' ? <div className="funds-dash-help-content">
      <section><h3>先看两个不同的余额</h3><p>汇聚商户可用余额是已保存的渠道快照；用户可用余额是平台账内可供用户提现的余额。商户资金还可能包含应退款等款项，不能全部当作平台的钱。</p></section>
      <section><h3>退款和提现在处理中</h3><p>退款责任是平台账内尚待核销的应退款；提现预留是用户申请提现后暂时占用的余额。渠道确认并在平台核销后，相应金额才会减少。</p>
        <div className="funds-dash-example"><strong>例子</strong><p>用户可用余额 600 元，申请提现 100 元后，可用余额为 500 元，提现预留为 100 元。出款确认并核销后，预留减少 100 元。</p></div></section>
      <section><h3>为什么平台权益还待核实？</h3><p>要计算平台自有权益，还需要完整的商户余额、用户余额和其他应付项目。历史流水没有回放到新账，账内显示零也不能说明旧业务已经结清。</p></section>
    </div> : <div className="funds-dash-help-content">
      <section><h3>付款和结算看不同时间</h3><p>订单实付按付款日统计，包含租客押金；结算毛贡献按结算日统计。同一笔订单可能在不同日期分别出现，这两个指标不能相加。</p>
        <div className="funds-dash-example"><strong>例子</strong><p>一笔订单 10 月 1 日付款、10 月 11 日结算：付款金额计入 10 月 1 日，结算贡献计入 10 月 11 日。</p></div></section>
      <section><h3>结算毛贡献</h3><p className="funds-dash-formula">结算毛贡献 = 订单实付基数 − 租客应退 − 号主结算收益</p><p>例如实付 1,000 元、租客应退 200 元、号主收益 600 元，毛贡献为 200 元。这里还未扣除分销佣金、赔偿及渠道成本，不是净利润。客服取消订单时的资金分配不计入此项，请在对应订单查看。</p></section>
      <section><h3>付款订单预计基础价差</h3><p>按付款日统计未取消订单的基础价差，供提前观察趋势。旧订单使用旧站记录，可能随结算发生变化；未扣分销、未加预计包赔，与旧站预计总利润口径不同。</p></section>
      <section><h3>经营观察</h3><p>订单状态按读取时的已付订单统计；旧单优先读取续办状态，否则使用迁移快照。下单次数按租客去重，6 单及以上合并，不等于完整复购率。</p></section>
      <section><h3>历史数据和下钻</h3><p>历史记录覆盖仍待核对；缺少金额或续办依据的记录不会算入相应贡献。明细按所选范围重新读取，后续补录或状态变化可能使结果发生变化。</p></section>
    </div>}
  </DialogContent></Dialog>;
}

function paddedPoints(data: Trend): Point[] {
  if (!data.points.length) return [];
  const start = data.period.from ?? data.points[0]!.date, end = data.period.to, monthly = data.period.granularity === 'month';
  const cursor = new Date(`${monthly ? start.slice(0, 7) + '-01' : start}T00:00:00Z`);
  const endKey = monthly ? end.slice(0, 7) + '-01' : end, byDay = new Map(data.points.map(point => [point.date, point])), output: Point[] = [];
  while (cursor.toISOString().slice(0, 10) <= endKey && output.length < 500) {
    const key = cursor.toISOString().slice(0, 10);
    output.push(byDay.get(key) ?? { date: key, orders: null, knownAmounts: null, cents: null, legacyOrders: null, estimateOrders: null, estimateKnown: null, estimateCents: null, estimateDiscrepancies:null, settlements: null, knownContributions: null, contributionCents: null });
    if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + 1); else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return output;
}
function chartValue(value: string | null, money: boolean): number | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? (money ? parsed / 100 : parsed) : null;
}
function sum(points: Point[], field: 'orders' | 'knownAmounts' | 'cents' | 'estimateOrders' | 'estimateKnown' | 'estimateCents' | 'estimateDiscrepancies' | 'settlements' | 'knownContributions' | 'contributionCents'): string | null {
  const values = points.map(point => point[field]).filter((value): value is string => value !== null && /^-?\d+$/.test(value));
  return values.length ? values.reduce((total, value) => total + BigInt(value), 0n).toString() : null;
}
function average(cents: string, count: string): string | null {
  if (!/^-?\d+$/.test(cents) || !/^[1-9]\d*$/.test(count)) return null;
  const value = BigInt(cents), divisor = BigInt(count), absolute = value < 0n ? -value : value;
  const rounded = (absolute + divisor / 2n) / divisor;
  return (value < 0n ? -rounded : rounded).toString();
}
function validInsights(value: Insights | null): value is Insights {
  return !!value && ['cancelled','completed','active','unknown','repeatRenters','nativeOrders','legacyOrders'].every(key => /^\d+$/.test(String(value[key as keyof Insights] ?? '')))
    && Array.isArray(value.frequency) && value.frequency.every(row => Number.isInteger(row.orders) && row.orders >= 1 && row.orders <= 6 && /^\d+$/.test(row.users));
}
function ChartDetails({ data, onOpenPaid, onOpenSettled }: { data: Trend; onOpenPaid: (date:string) => void; onOpenSettled:(date:string)=>void }) {
  return <Collapsible className="funds-dash-details"><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>查看图表数据<ChevronDown size={14}/></CollapsibleTrigger><CollapsibleContent><div className="funds-dash-table-wrap"><Table><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>已付订单</TableHead><TableHead>订单实付</TableHead><TableHead>付款订单预计价差</TableHead><TableHead>已结算订单</TableHead><TableHead>结算毛贡献</TableHead><TableHead>订单依据</TableHead></TableRow></TableHeader><TableBody>{data.points.map(point => <TableRow key={point.date}><TableCell>{point.date}</TableCell><TableCell>{point.orders ?? '未记录'}</TableCell><TableCell>{point.knownAmounts === '0' ? '未记录' : financeMoney(point.cents)}</TableCell><TableCell>{data.estimateState === 'FORBIDDEN' ? '无权限' : financeMoney(point.estimateCents)}</TableCell><TableCell>{point.settlements ?? '未记录'}</TableCell><TableCell>{point.knownContributions === '0' ? '未记录' : financeMoney(point.contributionCents)}</TableCell><TableCell>{point.orders ? <Button variant="link" size="sm" onClick={()=>onOpenPaid(point.date)}>付款订单</Button> : null}{point.settlements ? <Button variant="link" size="sm" onClick={()=>onOpenSettled(point.date)}>结算明细</Button> : null}{!point.orders&&!point.settlements?'—':null}</TableCell></TableRow>)}</TableBody></Table></div></CollapsibleContent></Collapsible>;
}
function StatusBreakdown({ data, onOpen }: { data: Insights; onOpen: (status:string) => void }) {
  const rows = [
    { key:'completed', name:'已完成', count:data.completed, color:'var(--funds-chart)' },
    { key:'active', name:'履约中', count:data.active, color:'var(--funds-blue)' },
    { key:'cancelled', name:'已取消', count:data.cancelled, color:'var(--funds-amber)' },
    { key:'unknown', name:'状态待核', count:data.unknown, color:'var(--muted-foreground)' },
  ].map(row => ({ ...row, value: chartValue(row.count,false) }));
  const total = rows.reduce((n,row) => n + BigInt(row.count),0n);
  const chart = rows.filter(row => row.value !== null && row.value > 0);
  return <section className="funds-dash-insight"><h3>已付订单状态</h3><p>按付款时间筛选，显示当前可识别的订单状态；点击状态查看订单。</p><div className="funds-dash-status-chart">
    {chart.length ? <ChartContainer config={{ value:{label:'订单数',color:'var(--funds-chart)'} }} label="已付订单状态分布" height={175}><PieChart><Pie data={chart} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" stroke="var(--card)" strokeWidth={2} isAnimationActive={false}>{chart.map(row => <Cell key={row.key} fill={row.color}/>)}</Pie><ChartTooltip contentStyle={{ background:'var(--card)',border:'1px solid var(--border)',borderRadius:8 }} formatter={value => [`${value} 笔`,'订单数']}/></PieChart></ChartContainer> : <div className="funds-dash-empty">暂无可绘制的订单状态。</div>}
    <div className="funds-dash-status-legend">{rows.filter(row=>row.count !== '0').map(row => <div key={row.key}><span><i style={{background:row.color}}/>{row.key === 'unknown' ? row.name : <Button variant="link" className="funds-dash-status-link" onClick={()=>onOpen(row.key === 'active' ? 'PAID' : row.key.toUpperCase())}>{row.name}</Button>}</span><strong>{BigInt(row.count).toLocaleString('zh-CN')} 笔</strong><small>{total > 0n ? `${(Number(BigInt(row.count)*1000n/total)/10).toFixed(1)}%` : '—'}</small></div>)}</div>
  </div></section>;
}
function CustomerFrequency({ data }: { data: Insights }) {
  const rows = Array.from({length:6},(_,i) => { const orders=i+1, userCount=data.frequency.find(row => row.orders===orders)?.users ?? '0'; return {label:orders===6?'6 单及以上':`${orders} 单`,users:userCount,value:chartValue(userCount,false)}; });
  return <section className="funds-dash-insight"><h3>用户下单次数</h3><p>按本期已付订单，统计每位租客下单的笔数。</p><ChartContainer config={{ value:{label:'租客数',color:'var(--funds-rank)'} }} label="用户下单次数分布" height={175}><BarChart data={rows} margin={{top:12,right:8,left:0,bottom:0}}><CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="label" tick={{fill:'var(--muted-foreground)',fontSize:11}} axisLine={false} tickLine={false}/><YAxis allowDecimals={false} width={44} tick={{fill:'var(--muted-foreground)',fontSize:11}} axisLine={false} tickLine={false}/><ChartTooltip contentStyle={{background:'var(--card)',border:'1px solid var(--border)',borderRadius:8}} formatter={value=>[`${value} 人`,'租客数']}/><Bar dataKey="value" fill="var(--funds-rank)" radius={[4,4,0,0]} maxBarSize={38} isAnimationActive={false}/></BarChart></ChartContainer><div className="funds-dash-frequency-text">{rows.map(row=><span key={row.label}>{row.label}：{BigInt(row.users).toLocaleString('zh-CN')} 人</span>)}</div></section>;
}

export function FinanceDashboardView({ tab, snapshot, refreshNonce, onOpenPath, onQueryChange }: {
  tab: WorkspaceTab; snapshot: Snapshot; refreshNonce: number; onOpenPath: (path: string, title?: string) => void; onQueryChange: (query: Record<string, string>) => void;
}) {
  const range: Range = ['today', '7d', '30d', 'all', 'custom'].includes(tab.query.range ?? '') ? tab.query.range as Range : '7d';
  const [source, setSource] = useState<Source>('all'), [basis, setBasis] = useState<'settled' | 'paid'>('settled'), [limit, setLimit] = useState<20 | 50>(20);
  const [metric, setMetric] = useState<'cents' | 'orders' | 'contributionCents' | 'estimateCents'>('cents'), [retry, setRetry] = useState(0), [dateOpen, setDateOpen] = useState(false);
  const [help, setHelp] = useState<'trend' | 'funds' | null>(null);
  const [dateDraft, setDateDraft] = useState<DateSelectorValue>({ period:'day', operator:'between' }), [dateError, setDateError] = useState('');
  const [detail,setDetail]=useState<ContributionContext|null>(null);
  const active = snapshot.security.status === 'ACTIVE' && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const allowed = active && snapshot.permissions.includes('finance.read'), canOrder = active && (snapshot.security.isBoss || snapshot.permissions.includes('order.read'));
  const canUser = active && (snapshot.security.isBoss || snapshot.permissions.includes('user.directory.read'));
  const identity = financeContextIdentity(snapshot), periodQuery = new URLSearchParams({ range });
  useEffect(()=>setDetail(null),[identity]);
  if (range === 'custom') { periodQuery.set('from', tab.query.from ?? ''); periodQuery.set('to', tab.query.to ?? ''); }
  const trendQuery = new URLSearchParams(periodQuery); trendQuery.set('source', source);
  const rankingQuery = new URLSearchParams(trendQuery); rankingQuery.set('basis', basis); rankingQuery.set('limit', String(limit));
  const trendPath = `/finance/dashboard/trend?${trendQuery}`, rankingPath = `/finance/dashboard/customers?${rankingQuery}`;
  // The shared read pool admits two requests; serialize this page so other admin reads keep a slot.
  const status = useRead<Status>(JSON.stringify([identity, 'status', refreshNonce]), allowed, '/finance/overview?range=7d', retry);
  const merchant = useRead<Merchant>(JSON.stringify([identity, 'merchant', refreshNonce]), allowed && !status.loading, '/finance/dashboard/merchant', retry);
  const trend = useRead<Trend>(JSON.stringify([identity, trendPath, refreshNonce]), allowed && canOrder && !status.loading && !merchant.loading, trendPath, retry);
  const channelPath = `/finance/dashboard/channels?${periodQuery}`;
  const channel = useRead<ChannelFlow>(JSON.stringify([identity, channelPath, refreshNonce]), allowed && canOrder && !status.loading && !merchant.loading && !trend.loading, channelPath, retry);
  const ranking = useRead<Ranking>(JSON.stringify([identity, rankingPath, refreshNonce]), allowed && canOrder && canUser && !status.loading && !merchant.loading && !trend.loading && !channel.loading, rankingPath, retry);
  const merchantPending = status.loading || merchant.loading;
  const trendPending = merchantPending || trend.loading;
  const channelPending = trendPending || channel.loading;
  const rankingPending = channelPending || ranking.loading;
  const retryRead = () => setRetry(value => value + 1);
  const points = trend.value ? paddedPoints(trend.value) : [];
  const graph = points.map(point => ({ ...point, value: chartValue(point[metric], metric !== 'orders') }));
  const graphHasData = graph.some(point => point.value !== null);
  const money = metric !== 'orders';
  const amount = trend.value ? sum(trend.value.points, 'cents') : null, orders = trend.value ? sum(trend.value.points, 'orders') : null;
  const contribution = trend.value ? sum(trend.value.points, 'contributionCents') : null;
  const knownAmount = trend.value ? sum(trend.value.points, 'knownAmounts') : null, knownContribution = trend.value ? sum(trend.value.points, 'knownContributions') : null;
  const estimate = trend.value ? sum(trend.value.points, 'estimateCents') : null, estimateKnown = trend.value ? sum(trend.value.points, 'estimateKnown') : null, estimateOrders = trend.value ? sum(trend.value.points, 'estimateOrders') : null;
  const estimateDiscrepancies = trend.value ? sum(trend.value.points,'estimateDiscrepancies') : null;
  const missingAmounts = orders !== null && knownAmount !== null ? BigInt(orders) - BigInt(knownAmount) : 0n;
  const totalSettlements = trend.value ? sum(trend.value.points, 'settlements') : null;
  const missingContributions = totalSettlements !== null && knownContribution !== null ? BigInt(totalSettlements) - BigInt(knownContribution) : 0n;
  const cutoff = trend.value?.openingReferenceAt;
  const cutoffDay = cutoff && Number.isFinite(Date.parse(cutoff)) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(cutoff)) : null;
  const cutoffKey = cutoffDay && trend.value?.period.granularity === 'month' ? cutoffDay.slice(0,7) + '-01' : cutoffDay;
  const bucket = (name: string) => status.value?.ledgerBalances.find(row => row.bucket === name);
  const balance = (name: string) => { const row = bucket(name); return row?.state === 'KNOWN' ? financeMoney(row.balanceCents) : '未记录'; };
  const account = merchant.value?.accounts[0], verified = account?.available.latestVerifiedSnapshot;
  const available = verified?.amounts?.useAbleSettAmount;
  const accountAmount = available?.unitKnowledge === 'CNY_YUAN' && available.cents !== null ? financeMoney(available.cents) : '未记录';
  const merchantLabel = merchant.value?.state === 'NOT_CONFIGURED' ? '未接入' : merchant.value?.state === 'NO_SCOPE' ? '无商户查看范围' : verified ? '已保存渠道快照' : '暂无渠道快照';
  const rankMax = ranking.value?.items.reduce((max, row) => { const value = BigInt(row.contributionCents); return value > max ? value : max; }, 0n) ?? 0n;
  const channelPoints = ([['PAYMENT','收款'],['REFUND','退款'],['WITHDRAWAL','提现']] as const).map(([kind,label]) => {
    const row = channel.value?.items.find(item => item.kind === kind);
    return { kind, label, value: chartValue(row?.cents ?? null, true), cents: row?.cents ?? null, count: row?.count ?? null };
  });
  const goUser = (row: Customer) => onOpenPath(`/users/${encodeURIComponent(row.userId)}`, row.name);
  const openPaid = (status?:string, date?:string) => {
    if (!trend.value || !canOrder) return;
    const path = dashboardPaidOrdersPath(trend.value.period,source,status,date);
    if (path) onOpenPath(path,'付款订单');
  };
  const openSettled = (date?:string) => { if (trend.value) setDetail({period:trend.value.period,source,basis:'settled',pointDate:date}); };
  const openCustomerSettled = (row:Customer) => { if (ranking.value) setDetail({period:ranking.value.period,source,basis:ranking.value.basis,userId:row.userId,userName:row.name}); };
  return <section className="funds-dashboard" aria-labelledby="funds-dashboard-title">
    <header className="funds-dash-header"><div><h1 id="funds-dashboard-title">资金与经营看板</h1><p>从交易、结算与资金状态，了解平台的经营情况。</p></div>
      <Button variant="outline" size="sm" onClick={retryRead} disabled={!allowed}><RefreshCw size={15} aria-hidden/>刷新</Button></header>
    {!allowed ? <p role="status" className="funds-dash-message">当前身份没有资金读取权限，请联系管理员。</p> : <>
      <div className="funds-dash-toolbar"><div className="funds-dash-segment" role="group" aria-label="时间范围">
        {ranges.map(item => <Button key={item.value} size="sm" variant={range === item.value ? 'secondary' : 'ghost'} aria-pressed={range === item.value} onClick={() => onQueryChange({ range: item.value })}>{item.text}</Button>)}
        <Popover open={dateOpen} onOpenChange={open => { setDateOpen(open); if (open) { setDateError(''); setDateDraft({ period:'day',operator:'between',startDate:range === 'custom' && tab.query.from ? new Date(`${tab.query.from}T00:00:00`) : undefined,endDate:range === 'custom' && tab.query.to ? new Date(`${tab.query.to}T00:00:00`) : undefined }); } }}><PopoverTrigger render={<Button size="sm" variant={range === 'custom' ? 'secondary' : 'ghost'} aria-label="选择自定义日期"/>}><CalendarDays size={14}/>{range === 'custom' ? `${tab.query.from} 至 ${tab.query.to}` : '自定义'}</PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0"><DateSelector value={dateDraft} presetMode="between" allowRange showTwoMonths={false} showInput={false} onChange={next => { setDateDraft(next); setDateError(''); const from = dayText(next.startDate), to = dayText(next.endDate); if (from && to) { if (to > beijingCalendarDate() || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86400000) { setDateError('请选择今天之前、最长 367 天的日期范围。'); return; } onQueryChange({ range:'custom',from,to }); setDateOpen(false); } }}/>{dateError ? <p className="funds-dash-date-error" role="alert">{dateError}</p> : null}</PopoverContent>
        </Popover></div><span className="funds-dash-clock">北京时间 · 余额为当前时点</span>
        <div className="funds-dash-source"><span>订单来源</span><Select value={source} onValueChange={value => { if (value === 'all' || value === 'new' || value === 'legacy') setSource(value); }}><SelectTrigger aria-label="订单来源"><SelectValue>{({all:'新旧平台',new:'新平台',legacy:'旧平台记录'})[source]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="all">新旧平台</SelectItem><SelectItem value="new">新平台</SelectItem><SelectItem value="legacy">旧平台记录</SelectItem></SelectContent></Select></div>
      </div>
      <div className="funds-dash-grid">
        <Card className="funds-dash-panel funds-dash-trend"><CardHeader><div className="funds-dash-heading"><div><CardTitle>交易与收益趋势</CardTitle><CardDescription>付款与结算按各自时间统计。<Button type="button" variant="link" size="sm" className="funds-dash-inline-help" onClick={()=>setHelp('trend')}>查看计算说明</Button></CardDescription></div>
          <div className="funds-dash-segment" role="group" aria-label="趋势指标">{([['cents','订单实付'],['orders','已付订单数'],['contributionCents','结算毛贡献'],['estimateCents','付款订单预计']] as const).map(([value,label]) => <Button key={value} size="sm" variant={metric === value ? 'secondary' : 'ghost'} aria-pressed={metric === value} onClick={() => setMetric(value)}>{label}</Button>)}</div></div></CardHeader><CardContent>
          {trend.value ? <><div className="funds-dash-metrics">
            <div><MetricLabel label="已付订单" tip="按付款时间统计，包含付款后取消的订单。"/>{orders === null ? <strong>暂无记录</strong> : <Button variant="link" className="funds-dash-metric-link" onClick={()=>openPaid()} aria-label="查看本期付款订单">{BigInt(orders).toLocaleString('zh-CN')} 笔<ArrowRight size={14}/></Button>}</div>
            <div><MetricLabel label="订单实付" tip="按付款时间统计，包含租客押金，不等于平台收入。"/><strong>{amount === null ? '暂无记录' : knownAmount === '0' ? '未记录' : financeMoney(amount)}</strong></div>
            <div><MetricLabel label="结算毛贡献 · 实际" tip="按结算时间统计：实付基数减租客应退和号主结算收益。不含客服取消订单的资金分配，也不等于净利润。"/>{totalSettlements !== null && totalSettlements !== '0' ? <Button variant="link" className="funds-dash-metric-link" onClick={()=>openSettled()} aria-label="查看本期结算贡献明细">{knownContribution === '0' ? '未记录' : financeMoney(contribution)}<ArrowRight size={14}/></Button> : <strong>暂无记录</strong>}</div>
            <div><MetricLabel label="付款订单预计基础价差" tip="按付款时间统计未取消订单的基础价差，与结算毛贡献不能相加。"/><strong>{trend.value.estimateState === 'FORBIDDEN' ? '无权限' : estimate === null ? '未记录' : financeMoney(estimate)}</strong>{trend.value.estimateState !== 'FORBIDDEN' ? <small>已取得 {estimateKnown ?? '0'} / {estimateOrders ?? '0'} 笔{estimateKnown !== null && estimateOrders !== null && BigInt(estimateKnown) < BigInt(estimateOrders) ? ' · 部分' : ''}</small> : null}</div>
          </div>
            {source !== 'new' ? <div className="funds-dash-coverage"><MetricLabel label="历史数据覆盖待核" tip={cutoff ? `旧用户余额来源截点 ${financeTime(cutoff)}，仅供参考；截点当日订单可能不完整。旧单续办只纳入能核验的结算记录。` : '历史来源覆盖可能不完整；旧单续办只纳入能核验的结算记录。'}/></div> : null}
            {missingAmounts > 0n ? <p className="funds-dash-note">{missingAmounts.toString()} 笔实付金额未记录。</p> : null}
            {missingContributions > 0n ? <p className="funds-dash-note">{missingContributions.toString()} 笔结算缺少完整金额依据，未纳入毛贡献。</p> : null}
            {estimateDiscrepancies && estimateDiscrepancies !== '0' ? <p className="funds-dash-note">旧站已有 {estimateDiscrepancies} 笔已完成订单的记录价差与结算公式不一致；付款订单预计为来源记录汇总，尚未核对为利润。</p> : null}
            {source !== 'new' && trend.value.legacy === 'UNAVAILABLE' ? <p className="funds-dash-note">旧订单资料暂不可读取，图中仅含已取得的数据。</p> : null}
            {source !== 'new' && trend.value.continuations === 'UNAVAILABLE' ? <p className="funds-dash-note">旧订单迁入后的续办结算证据暂不可读取，相关贡献未纳入。</p> : null}
            {graphHasData ? <ChartContainer config={{ value: { label: money ? '金额' : '订单数', color: 'var(--funds-chart)' } }} label="交易和收益趋势" height={230}>
              <AreaChart data={graph} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}><defs><linearGradient id="funds-trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--funds-chart)" stopOpacity={0.22}/><stop offset="100%" stopColor="var(--funds-chart)" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="date" tickFormatter={value => trend.value?.period.granularity === 'month' ? String(value).slice(0,7) : String(value).slice(5)} minTickGap={26} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false}/><YAxis width={52} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false}/><ChartTooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} formatter={(value) => [value == null ? '未记录' : money ? `¥${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : `${value} 笔`, money ? '金额' : '订单数']}/>{source !== 'new' && cutoffKey && points.some(point => point.date === cutoffKey) ? <ReferenceLine x={cutoffKey} stroke="var(--muted-foreground)" strokeDasharray="4 4"/> : null}<Area dataKey="value" type="linear" stroke="var(--funds-chart)" fill="url(#funds-trend-fill)" strokeWidth={2} connectNulls={false} dot={{ r: 2 }}/></AreaChart></ChartContainer> : <div className="funds-dash-empty">所选时间没有可绘制的已记录数据。</div>}
            {trend.value.points.length ? <ChartDetails data={trend.value} onOpenPaid={date=>openPaid(undefined,date)} onOpenSettled={openSettled}/> : null}</> : <PanelState loading={trendPending} error={trend.error} denied={!canOrder ? '查看交易趋势需要订单读取权限。' : undefined} onRetry={retryRead}/>}
        </CardContent></Card>

        <Card className="funds-dash-panel funds-dash-position"><CardHeader><CardTitle>资金现状</CardTitle><CardDescription>各项金额分别查看。<Button type="button" variant="link" size="sm" className="funds-dash-inline-help" onClick={()=>setHelp('funds')}>了解资金关系</Button></CardDescription></CardHeader><CardContent>
          <div className="funds-dash-position-grid"><div><MetricLabel label="汇聚商户可用余额" tip="当前管理员可查看的已保存渠道快照，并非实时查询。"/><strong>{merchantPending ? '读取中…' : merchant.error ? '暂不可读取' : accountAmount}</strong><small>{merchantPending ? '读取已保存快照' : merchant.error ? friendlyError(merchant.error) : merchantLabel}</small>{verified ? <small>记录时间 {financeTime(verified.recordedAt)} · 非渠道时点证明</small> : null}{(merchant.value?.accounts.length ?? 0) > 1 ? <small>当前显示第一个授权商户，其他商户请进入汇聚对账。</small> : null}</div>
          <div><MetricLabel label="平台自有权益" tip="需要完整商户余额和应付款依据，当前还不能计算。"/><strong>待核实</strong><small>完整权益依据尚未建立</small>{status.value ? <small>已入账平台分录 {balance('PLATFORM')}，不等于可用现金</small> : null}</div></div>
          {status.value ? <><dl className="funds-dash-balances"><div><dt><MetricLabel label="用户可用余额 · 账内" tip="平台账内记录的用户可用余额总额，不代表汇聚商户余额。"/></dt><dd>{balance('AVAILABLE')}</dd></div><div><dt><MetricLabel label="退款责任净额 · 账内" tip="平台账内尚待核销的应退款项，原路退款并核销后减少。"/></dt><dd>{balance('REFUND_PAYABLE')}</dd></div><div><dt><MetricLabel label="提现预留净额 · 账内" tip="用户申请提现后暂时占用的余额；出款核销或失败释放后减少。"/></dt><dd>{balance('RESERVED')}</dd></div></dl><p className="funds-dash-note">账内截至 {financeTime(status.value.asOf)} · 全平台余额待核</p></> : <PanelState loading={status.loading} error={status.error} onRetry={retryRead}/>}
          <Button variant="link" className="funds-dash-link" onClick={() => onOpenPath('/finance/channels', '汇聚对账')}>查看汇聚对账<ArrowRight size={14}/></Button>
        </CardContent></Card>

        <Card className="funds-dash-panel funds-dash-channel"><CardHeader><CardTitle>汇聚资金进出</CardTitle><CardDescription>收退款按订单来源筛选；提现按全部用户统计。</CardDescription></CardHeader><CardContent>
          {channel.value ? channel.value.state === 'RECORDED_PARTIAL' && channel.value.items.length ? <><p className="funds-dash-note">仅已保存的渠道证据，覆盖可能不完整；提现按本站记录时间与出款净额统计。</p><ChartContainer config={{ value: { label: '金额', color: 'var(--funds-chart)' } }} label="渠道已确认进出金额" height={170}><BarChart data={channelPoints} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="label" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} axisLine={false} tickLine={false}/><YAxis width={50} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false}/><ChartTooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} formatter={value => [value == null ? '未记录' : `¥${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`, '金额']}/><Bar dataKey="value" fill="var(--funds-chart)" radius={[4,4,0,0]} maxBarSize={38}/></BarChart></ChartContainer><div className="funds-dash-channel-values">{channelPoints.map(point => <div key={point.kind}><span>{point.label}</span><strong>{financeMoney(point.cents)}</strong><small>{point.count === null ? '未记录' : `${point.count} 笔`}</small></div>)}</div></> : <div className="funds-dash-empty funds-dash-channel-empty"><strong>{channel.value.state === 'NOT_CONFIGURED' ? '汇聚未接入' : channel.value.state === 'NO_SCOPE' ? '未配置商户查看范围' : channel.value.state === 'UNAVAILABLE' ? '渠道证据暂不可读取' : '本期未取得渠道记录'}</strong><span>仅统计已验证并保存的渠道事实，不能将缺失记录视为零。</span><Button variant="outline" size="sm" onClick={() => onOpenPath('/finance/records', '资金记录')}>查看资金记录<ArrowRight size={14}/></Button></div> : <PanelState loading={channelPending} error={channel.error} denied={!canOrder ? '查看渠道订单需要订单读取权限。' : undefined} onRetry={retryRead}/>}
        </CardContent></Card>

        <Card className="funds-dash-panel funds-dash-ranking"><CardHeader><div className="funds-dash-heading"><div><CardTitle><MetricLabel label="客户贡献排行" tip="按已结算订单的毛贡献排序，未扣分销、赔偿及渠道成本。"/></CardTitle><CardDescription>已结算订单 · 按订单毛贡献排序</CardDescription></div><div className="funds-dash-rank-controls"><div className="funds-dash-segment" role="group" aria-label="排行时间口径"><Button size="sm" variant={basis === 'settled' ? 'secondary' : 'ghost'} aria-pressed={basis === 'settled'} onClick={() => setBasis('settled')}>结算时间</Button><Button size="sm" variant={basis === 'paid' ? 'secondary' : 'ghost'} aria-pressed={basis === 'paid'} onClick={() => setBasis('paid')}>付款时间</Button></div><div className="funds-dash-segment" role="group" aria-label="排行数量">{([20,50] as const).map(n => <Button key={n} size="sm" variant={limit === n ? 'secondary' : 'ghost'} aria-pressed={limit === n} onClick={() => setLimit(n)}>Top {n}</Button>)}</div></div></div></CardHeader><CardContent>
          {ranking.value ? <>{ranking.value.legacy === 'UNAVAILABLE' && source !== 'new' ? <p className="funds-dash-note">旧订单来源暂不可读取，排行仅显示已取得的数据。</p> : source !== 'new' ? <div className="funds-dash-coverage"><MetricLabel label="历史数据覆盖待核" tip="排行按结算毛贡献计算，分销佣金与赔偿未扣除；旧单续办仅计入可核验记录。"/></div> : null}
            {ranking.value.items.length ? <div className="funds-dash-ranking-list" role="list">{ranking.value.items.map((row, index) => <div className="funds-dash-rank-row" role="listitem" key={row.userId}><span className="funds-dash-rank-number">{index + 1}</span><EntityPreviewTrigger touchLabel={`预览用户 ${row.name}`} trigger={<Button variant="link" className="funds-dash-user" onClick={() => goUser(row)}>{row.name}</Button>} content={<UserProfilePreview userId={row.userId} name={row.name} request={profileRequest} onOpenProfile={() => goUser(row)}/>}/><div className="funds-dash-rank-bar" aria-hidden><i style={{ width: `${rankMax > 0n && BigInt(row.contributionCents) > 0n ? Number(BigInt(row.contributionCents) * 100n / rankMax) : 0}%` }}/></div><span className="funds-dash-rank-count">{row.orderCount} 单</span><Button variant="link" className="funds-dash-rank-value" aria-label={`查看${row.name}的贡献订单`} onClick={()=>openCustomerSettled(row)}>{financeMoney(row.contributionCents)}</Button></div>)}</div> : <div className="funds-dash-empty">所选时间暂无可计算的已结算订单。</div>}
            {ranking.value.items.length ? <Collapsible className="funds-dash-details"><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>查看排行明细<ChevronDown size={14}/></CollapsibleTrigger><CollapsibleContent><div className="funds-dash-table-wrap"><Table><TableHeader><TableRow><TableHead>客户</TableHead><TableHead>订单数</TableHead><TableHead>订单实付</TableHead><TableHead>订单毛贡献</TableHead><TableHead>每单平均贡献</TableHead><TableHead>最近结算/付款</TableHead><TableHead>分销佣金</TableHead><TableHead>旧站赔偿记载</TableHead></TableRow></TableHeader><TableBody>{ranking.value.items.map(row => <TableRow key={row.userId}><TableCell>{row.name}</TableCell><TableCell>{row.orderCount}</TableCell><TableCell>{financeMoney(row.paidCents)}</TableCell><TableCell>{financeMoney(row.contributionCents)}</TableCell><TableCell>{financeMoney(average(row.contributionCents,row.orderCount))}</TableCell><TableCell>{financeTime(row.latestAt)}</TableCell><TableCell>待核</TableCell><TableCell>{row.historicalCompensationCents == null ? '未记录' : `${financeMoney(row.historicalCompensationCents)} · 部分记录`}</TableCell></TableRow>)}</TableBody></Table></div></CollapsibleContent></Collapsible> : null}
            {ranking.value.omittedCount !== '0' || source !== 'new' && ranking.value.continuations === 'UNAVAILABLE' ? <p className="funds-dash-note">{ranking.value.omittedCount !== '0' ? `${ranking.value.omittedCount} 笔金额依据缺失的订单未计入；` : ''}{source !== 'new' && ranking.value.continuations === 'UNAVAILABLE' ? '旧单续办结算证据不可读取，相关贡献未纳入。' : ''}</p> : null}</> : <PanelState loading={rankingPending} error={ranking.error} denied={!canOrder || !canUser ? '查看客户排行需要订单和用户管理权限。' : undefined} onRetry={retryRead}/>}
        </CardContent></Card>

        <Card className="funds-dash-panel funds-dash-insights"><CardHeader><CardTitle>经营观察</CardTitle><CardDescription>基于所选范围的已付订单。<Button type="button" variant="link" size="sm" className="funds-dash-inline-help" onClick={()=>setHelp('trend')}>查看统计说明</Button></CardDescription></CardHeader><CardContent>{trend.value ? validInsights(trend.value.insights) ? <div className="funds-dash-insights-list"><StatusBreakdown data={trend.value.insights} onOpen={status=>openPaid(status)}/><CustomerFrequency data={trend.value.insights}/></div> : <p className="funds-dash-message">{trend.value.insights ? '统计接口正在更新，请稍后刷新。' : '本期暂无可计算的付款记录。'}</p> : <PanelState loading={trendPending} error={trend.error} denied={!canOrder ? '查看经营观察需要订单读取权限。' : undefined} onRetry={retryRead}/>}</CardContent></Card>
      </div>
      <ContributionSheet context={detail} onClose={()=>setDetail(null)} onOpenOrder={(id,number)=>{setDetail(null);onOpenPath(`/orders/${encodeURIComponent(id)}?section=finance`,number);}}/>
      <DashboardHelp kind={help} onClose={()=>setHelp(null)}/>
    </>}
  </section>;
}
