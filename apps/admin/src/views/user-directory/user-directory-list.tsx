import { AdminApiError } from '../../api';
import { useEffect, useRef, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon, ArrowUpRightIcon, CalendarDaysIcon, ChevronDownIcon, FilterIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DateSelector, type DateSelectorValue } from '@/components/reui/date-selector';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  ListTable,
  ListToolbar,
  ListToolbarSearch,
  ListToolbarEnumSelect,
  ListToolbarActions,
  ListPagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/admin-list';
import {
  EMPTY_FILTERS,
  PERMISSION,
  PHONE_LIKE,
  STATUS_LABEL,
  normalizeRegistrationSort,
  safeFilters,
  type Filters,
  type User,
  type UserDirectoryListResult,
} from './user-directory-data';
import {
  CreditSummaryCell,
  Denied,
  Hint,
  Identity,
  IdentityStatus,
  Loading,
  MembershipSummaryCell,
  Message,
  OrdersCurrentCell,
  PublishedCountCell,
  RegistrationCell,
  RiskBadge,
  Status,
  Summary,
  WalletCell,
  errorText,
  isDirectoryInputError,
  useDirectoryRequest,
  type PageProps,
  type UserDirectoryData,
} from './user-directory-shared';

export function EnumSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <ListToolbarEnumSelect label={label} value={value} onChange={onChange} options={options} />;
}

const TIER_OPTIONS: [string, string][] = [['PENDING', '等级待核'], ['STANDARD', '普通会员'], ['SILVER', '银卡会员'], ['GOLD', '金卡会员'], ['PLATINUM', '铂金会员'], ['DIAMOND', '钻石会员'], ['BLACK_GOLD', '黑金会员']];
const ENTITLEMENT_OPTIONS: [string, string][] = [['ANY', '有有效礼遇'], ['FRIEND', '挚友礼遇'], ['PRESTIGE', '尊享礼遇'], ['NONE', '无有效礼遇']];
const RISK_OPTIONS: [string, string][] = [['FLAGGED', '高危'], ['NOT_FLAGGED', '非高危']];
const DRAFT_FILTER_KEYS = ['status', 'from', 'to', 'identity', 'tier', 'entitlement', 'creditMin', 'creditMax', 'risk'] as const;
const SORT_LABEL: Record<string, string> = {
  active_orders_desc: '活跃订单优先',
  registered_desc: '注册时间新→旧', registered_asc: '注册时间旧→新',
  balance_desc: '可用余额高→低', balance_asc: '可用余额低→高',
  credit_desc: '信用分高→低', credit_asc: '信用分低→高',
  renter_current_desc: '租入数多→少', renter_current_asc: '租入数少→多',
  owner_current_desc: '出租数多→少', owner_current_asc: '出租数少→多',
  published_desc: '上架数多→少', published_asc: '上架数少→多',
};

const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * 注册日期区间：起始日含当日，结束日含当日；只改草稿，查询时才提交。
 * 区间选完直接回到草稿，不再多一层“确定→查询”。
 */
function RegistrationDateRange({ from, to, onChange }: { from: string; to: string; onChange: (patch: Partial<Filters>) => void }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateSelectorValue>({
    period: 'day',
    operator: 'between',
    startDate: from ? new Date(`${from}T00:00:00`) : undefined,
    endDate: to ? new Date(`${to}T00:00:00`) : undefined,
  });
  const [saved, setSaved] = useState({ from, to });

  useEffect(() => { setSaved({ from, to }); }, [from, to]);
  // Opening the popover starts from the applied range, so closing without a complete range keeps it.
  useEffect(() => {
    if (!open) return;
    setDraft({
      period: 'day',
      operator: 'between',
      startDate: saved.from ? new Date(`${saved.from}T00:00:00`) : undefined,
      endDate: saved.to ? new Date(`${saved.to}T00:00:00`) : undefined,
    });
  }, [open, saved.from, saved.to]);

  const label = from || to ? `${from || '不限'} 至 ${to || '不限'}` : '不限';
  return (
    <Field label="注册日期" className="ud-field">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" className="ud-date-trigger" aria-label="注册日期" />}>
          <CalendarDaysIcon size={15} aria-hidden />
          {label}
        </PopoverTrigger>
        <PopoverContent className="ud-date-popover" align="start">
          <DateSelector
            value={draft}
            onChange={next => {
              setDraft(next);
              // A finished range goes back to the draft; an unfinished range is not submitted.
              if (next.startDate && next.endDate) {
                onChange({ from: isoDay(next.startDate), to: isoDay(next.endDate) });
                setOpen(false);
              }
            }}
            presetMode="between"
            allowRange
            showTwoMonths={!mobile}
            dayDateFormat="yyyy-MM-dd"
            presets={[{ label: '近 7 天', days: 7 }, { label: '近 30 天', days: 30 }, { label: '近 90 天', days: 90 }]}
          />
          <div className="ud-date-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => { setDraft({ period: 'day', operator: 'between' }); onChange({ from: '', to: '' }); setOpen(false); }}>清空</Button>
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

const CREDIT_PRESETS = [
  { label: '全部', min: '', max: '' },
  { label: '100 满分', min: '100', max: '100' },
  { label: '≥80 良好', min: '80', max: '100' },
  { label: '60–79 警示', min: '60', max: '79' },
  { label: '<60 高危', min: '0', max: '59' },
] as const;

/**
 * 信用分区间筛选：预设 0–100 常用业务分段（通常以 10/20 整数扣减）；支持自定义精确区间。
 */
function CreditRangeFilter({
  creditMin,
  creditMax,
  onChange,
}: {
  creditMin: string;
  creditMax: string;
  onChange: (patch: Partial<Filters>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftMin, setDraftMin] = useState(creditMin);
  const [draftMax, setDraftMax] = useState(creditMax);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftMin(creditMin);
    setDraftMax(creditMax);
    setError(null);
  }, [creditMin, creditMax, open]);

  const preset = CREDIT_PRESETS.find(p => p.min === creditMin && p.max === creditMax);
  let label = '全部';
  if (preset && preset.min !== '') label = preset.label;
  else if (creditMin === '100' && creditMax === '100') label = '100 满分';
  else if (creditMin && creditMax) label = `${creditMin}–${creditMax}分`;
  else if (creditMin) label = `≥${creditMin}分`;
  else if (creditMax) label = `≤${creditMax}分`;

  const applyCustom = () => {
    const min = draftMin.trim();
    const max = draftMax.trim();
    if (min && !/^(0|[1-9]\d?|100)$/.test(min)) {
      setError('最低分应为 0–100 整数');
      return;
    }
    if (max && !/^(0|[1-9]\d?|100)$/.test(max)) {
      setError('最高分应为 0–100 整数');
      return;
    }
    if (min && max && Number(min) > Number(max)) {
      setError('最低分不能大于最高分');
      return;
    }
    setError(null);
    onChange({ creditMin: min, creditMax: max });
    setOpen(false);
  };

  const clear = () => {
    setDraftMin('');
    setDraftMax('');
    setError(null);
    onChange({ creditMin: '', creditMax: '' });
    setOpen(false);
  };

  return (
    <Field label="信用分" composite className="ud-field ud-credit-filter">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" className="ud-credit-trigger" aria-label="信用分" />}>
          <span className="truncate">{label}</span>
          <ChevronDownIcon size={14} className="ml-auto opacity-50 shrink-0" aria-hidden />
        </PopoverTrigger>
        <PopoverContent className="ud-credit-popover" align="start">
          <div className="space-y-3">
            <div>
              <span className="text-xs font-medium text-muted-foreground mb-1.5 block">常用分档</span>
              <div className="grid grid-cols-2 gap-1.5">
                {CREDIT_PRESETS.map(p => {
                  const active = p.min === (creditMin || '') && p.max === (creditMax || '');
                  return (
                    <Button
                      key={p.label}
                      type="button"
                      variant={active ? 'default' : 'outline'}
                      size="xs"
                      onClick={() => {
                        onChange({ creditMin: p.min, creditMax: p.max });
                        setOpen(false);
                      }}
                      className="text-xs h-7 justify-start px-2 font-normal"
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="pt-2 border-t border-border">
              <span className="text-xs font-medium text-muted-foreground mb-1.5 block">自定义区间 (0–100)</span>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={10}
                  inputMode="numeric"
                  aria-label="最低信用分"
                  placeholder="最低分"
                  value={draftMin}
                  onChange={e => { setDraftMin(e.target.value); setError(null); }}
                  className="h-8 text-xs tabular-nums"
                />
                <span className="text-muted-foreground" aria-hidden>–</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={10}
                  inputMode="numeric"
                  aria-label="最高信用分"
                  placeholder="最高分"
                  value={draftMax}
                  onChange={e => { setDraftMax(e.target.value); setError(null); }}
                  className="h-8 text-xs tabular-nums"
                />
              </div>
              {error ? <p className="text-[11px] text-destructive mt-1.5" role="alert">{error}</p> : null}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Button type="button" variant="ghost" size="xs" onClick={clear} className="text-xs h-7">
                清空
              </Button>
              <Button type="button" size="xs" onClick={applyCustom} className="text-xs h-7">
                确定
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

/** 紧凑业务筛选：桌面一行可换行；窄屏先给状态与日期，其余行内折叠，不再藏进侧边抽屉。 */
function FilterFields({ filters, change, variant }: { filters: Filters; change: (patch: Partial<Filters>) => void; variant: 'primary' | 'rest' | 'all' }) {
  return (
    <div className="ud-filter-fields">
      {variant !== 'rest' ? (
        <>
          <ListToolbarEnumSelect label="账号状态" value={filters.status} onChange={status => change({ status })} options={Object.entries(STATUS_LABEL).filter(([key]) => key !== 'UNKNOWN')} />
          <RegistrationDateRange from={filters.from} to={filters.to} onChange={change} />
        </>
      ) : null}
      {variant !== 'primary' ? (
        <>
          <ListToolbarEnumSelect label="实名状态" value={filters.identity} onChange={identity => change({ identity })} options={[['VERIFIED', '已实名'], ['UNVERIFIED', '未实名']]} />
          <ListToolbarEnumSelect label="会员等级" value={filters.tier} onChange={tier => change({ tier })} options={TIER_OPTIONS} />
          <ListToolbarEnumSelect label="有效礼遇" value={filters.entitlement} onChange={entitlement => change({ entitlement })} options={ENTITLEMENT_OPTIONS} />
          <CreditRangeFilter creditMin={filters.creditMin} creditMax={filters.creditMax} onChange={change} />
          <ListToolbarEnumSelect label="内部标识" value={filters.risk} onChange={risk => change({ risk })} options={RISK_OPTIONS} />
        </>
      ) : null}
    </div>
  );
}

/** 表头排序：即时应用并回第 1 页，只使用已生效条件。 */
function SortHeader({ label, column, sort, onSort, hint }: { label: string; column: string; sort: string; onSort: (next: string) => void; hint?: string }) {
  const active = sort.startsWith(`${column}_`);
  const ascending = active && sort.endsWith('_asc');
  return (
    <TableHead aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={`ud-sort-header ${active ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        aria-label={`按${label}排序`}
        onClick={() => onSort(`${column}_${ascending ? 'desc' : 'asc'}`)}
      >
        {label}
        <span className="ud-sort-indicator" aria-hidden>{active ? (ascending ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />) : <ArrowUpDownIcon size={12} />}</span>
      </Button>
      {hint ? <Hint label={`${label}口径`}>{hint}</Hint> : null}
    </TableHead>
  );
}

const TABLE_HEADERS = ['用户', '账号与实名', '会员与礼遇', '信用', '可用余额', '当前业务', '注册时间', '操作'];
function UserListSkeleton() {
  return (
    <ListTable className="ud-table-wrap ud-user-table" loading aria-label="用户列表加载中">
      <Table className="admin-list-table">
        <TableHeader><TableRow>{TABLE_HEADERS.map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
        <TableBody aria-hidden="true">{Array.from({ length: 8 }, (_, row) => (
          <TableRow key={row}>{TABLE_HEADERS.map((label, column) => <TableCell key={label}>
            {column === 0 ? <div className="flex gap-3"><Skeleton className="size-9 shrink-0" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div> : <Skeleton className="h-4 w-3/4" />}
          </TableCell>)}</TableRow>
        ))}</TableBody>
      </Table>
    </ListTable>
  );
}
const HEADER_HINTS: Record<string, string> = {
  当前业务: '租入、出租为待支付或已支付的订单数；上架为已发布账号数。',
  注册时间: '用户首次注册的时间，包含旧平台。',
};

/** 合并业务列的三个小排序：租入、出租、上架各自独立。 */
function BusinessSortHeader({ sort, onSort }: { sort: string; onSort: (next: string) => void }) {
  const columns: [string, string][] = [['renter_current', '租入'], ['owner_current', '出租'], ['published', '上架']];
  const active = columns.find(([column]) => sort.startsWith(`${column}_`));
  const ascending = Boolean(active && sort.endsWith('_asc'));
  return (
    <TableHead aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <div className="ud-business-head">
        <span className="text-xs font-medium">当前业务</span>
        <div className="ud-business-head-pills">
          {columns.map(([column, label]) => {
            const on = sort.startsWith(`${column}_`);
            const up = on && sort.endsWith('_asc');
            return (
              <Button
                key={column}
                type="button"
                variant={on ? 'secondary' : 'ghost'}
                size="xs"
                className={`ud-sort-header h-6 px-1 text-xs ${on ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
                aria-label={`按${label}排序`}
                onClick={() => onSort(`${column}_${up ? 'desc' : 'asc'}`)}
              >
                {label}
                <span className="ud-sort-indicator ml-0.5" aria-hidden>{on ? (up ? <ArrowUpIcon size={11} /> : <ArrowDownIcon size={11} />) : <ArrowUpDownIcon size={11} />}</span>
              </Button>
            );
          })}
        </div>
      </div>
    </TableHead>
  );
}

/** 窄屏复用同一组表头排序，当前排序保持可见。 */
function MobileSortRow({ sort, onSort }: { sort: string; onSort: (next: string) => void }) {
  const columns: [string, string][] = [['registered', '注册时间'], ['balance', '可用余额'], ['credit', '信用'], ['renter_current', '租入'], ['owner_current', '出租'], ['published', '上架']];
  return (
    <div className="ud-mobile-sorts" role="group" aria-label="排序">
      {columns.map(([column, label]) => {
        const on = sort.startsWith(`${column}_`);
        const up = on && sort.endsWith('_asc');
        return (
          <Button key={column} type="button" variant="ghost" size="xs" className="ud-sort-header" aria-label={`按${label}排序`} onClick={() => onSort(`${column}_${up ? 'desc' : 'asc'}`)}>
            {label}
            <span className="ud-sort-indicator" aria-hidden>{on ? (up ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />) : <ArrowUpDownIcon size={12} />}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function UserList({ adapter, tab, onQueryChange, onOpenPath, refreshNonce }: PageProps & { adapter: UserDirectoryData }) {
  const mobile = useIsMobile();
  const defaultSort = adapter.has(PERMISSION.orders) ? EMPTY_FILTERS.sort : 'registered_desc';
  const safeInitial = { ...EMPTY_FILTERS, ...Object.fromEntries(Object.entries(tab.query).filter(([key]) => key in EMPTY_FILTERS)), sort: tab.query.sort ? normalizeRegistrationSort(tab.query.sort) : defaultSort };
  const [appliedFilters, setAppliedFilters] = useState<Filters>(safeInitial);
  const [draftFilters, setDraftFilters] = useState<Filters>(safeInitial);
  const [draftInput, setDraftInput] = useState(safeInitial.q);

  const initialPage = tab.query.page && /^[1-9]\d*$/.test(tab.query.page) ? Number(tab.query.page) : 1;
  const initialPageSize = tab.query.pageSize && /^[1-9]\d*$/.test(tab.query.pageSize) ? Number(tab.query.pageSize) : 20;
  const [page, setPage] = useState<number>(initialPage);
  const [pageSize, setPageSize] = useState<number>(initialPageSize);
  const [cursor, setCursor] = useState<string | undefined>(tab.query.cursor);
  const contextKeyRef = useRef<string | undefined>(undefined);
  const recoveringContext = useRef(false);

  const [pageData, setPageData] = useState<UserDirectoryListResult | undefined>();
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('');

  const filterKey = JSON.stringify(appliedFilters);
  // 只有草稿与已生效条件不同才提示“尚未应用”。
  const draftPending = draftInput.trim() !== appliedFilters.q
    || DRAFT_FILTER_KEYS.some(key => draftFilters[key] !== appliedFilters[key]);

  const pageKey = `${filterKey}:${page}:${pageSize}:${cursor ?? ''}:${refreshNonce}`;
  const { result, retry } = useDirectoryRequest(pageKey, async signal => {
    return adapter.list(appliedFilters, { page, pageSize, cursor, contextKey: contextKeyRef.current }, signal);
  });

  const callback = useRef(onQueryChange);
  callback.current = onQueryChange;

  useEffect(() => {
    const query: Record<string, string> = { ...safeFilters(appliedFilters) };
    if (!PHONE_LIKE.test(appliedFilters.q)) {
      if (cursor) {
        query.cursor = cursor;
      } else {
        if (page > 1) query.page = String(page);
      }
      if (pageSize !== 20) query.pageSize = String(pageSize);
    }
    callback.current(query);
  }, [filterKey, page, pageSize, cursor]);

  useEffect(() => {
    if (result.state === 'ready') {
      setPageData(result.data);
      if (result.data.mode === 'page') {
        contextKeyRef.current = result.data.contextKey;
        if (result.data.page !== page) setPage(result.data.page);
        if (result.data.pageSize !== pageSize) setPageSize(result.data.pageSize);
        if (result.data.capabilityNotice) setNotice(result.data.capabilityNotice);
      } else if (result.data.mode === 'cursor') {
        contextKeyRef.current = undefined;
        if (result.data.pageSize !== pageSize) setPageSize(result.data.pageSize);
        if (page !== 1) {
          setPage(1);
          setNotice('当前服务暂未提供跳页能力，已返回真实第1页；筛选条件已保留。');
        }
      }
    }
    if (result.state === 'error' && result.error instanceof AdminApiError && result.error.status === 409) {
      const canRecover = !recoveringContext.current && Boolean(contextKeyRef.current || cursor);
      contextKeyRef.current = undefined;
      setPageData(undefined);
      if (canRecover) {
        recoveringContext.current = true;
        setNotice('查询上下文已失效，已重新从第1页查询；筛选条件已保留。');
        setCursor(undefined);
        setPage(1);
        retry();
      }
    }
  }, [result]);

  const submitQuery = (overrideDraft?: Partial<Filters>) => {
    const nextDraft = overrideDraft ? { ...draftFilters, ...overrideDraft } : draftFilters;
    const newQ = draftInput.trim();
    const isPhone = PHONE_LIKE.test(newQ);

    setAppliedFilters({ ...nextDraft, q: newQ });
    setDraftFilters({ ...nextDraft, q: newQ });
    if (isPhone) setDraftInput('');
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice('');
    recoveringContext.current = false;
    retry();
  };

  /** 筛选条件即时生效并回到第 1 页 */
  const handleFilterChange = (patch: Partial<Filters>) => {
    setAppliedFilters(current => {
      const next = { ...current, ...patch };
      setDraftFilters(next);
      return next;
    });
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice('');
    recoveringContext.current = false;
  };

  /** 排序即时应用并回第 1 页；只用已生效条件，不动未提交草稿。 */
  const applySort = (nextSort: string) => {
    setAppliedFilters(current => ({ ...current, sort: nextSort }));
    setDraftFilters(current => ({ ...current, sort: nextSort }));
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice('');
    recoveringContext.current = false;
  };

  const handleReset = () => {
    setDraftInput('');
    setDraftFilters({ ...EMPTY_FILTERS, sort: defaultSort });
    setAppliedFilters({ ...EMPTY_FILTERS, sort: defaultSort });
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice('');
    recoveringContext.current = false;
    retry();
  };

  const handlePageChange = (newPage: number) => {
    recoveringContext.current = false;
    setNotice('');
    setPage(newPage);
    setCursor(undefined);
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    recoveringContext.current = false;
    setNotice('');
  };

  const authorityChanged = result.state === 'error' && result.error instanceof AdminApiError && [401, 403, 409, 423].includes(result.error.status);
  const rows = authorityChanged ? undefined : result.state === 'ready' ? result.data.rows : pageData?.rows;
  const open = (user: User) => setSelected(user.id);

  // A responsive layout change can close quick-check, but only a user's CTA can create a detail tab.
  useEffect(() => { if (mobile) setSelected(undefined); }, [mobile]);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (result.state !== 'error' || result.error instanceof AdminApiError && result.error.status === 409) return;
    feedback.current?.focus({ preventScroll: true });
    feedback.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);

  return (
    <section className="ud-directory" aria-labelledby="user-directory-title">
      <div className="ud-heading">
        <div>
          <h1 id="user-directory-title" ref={heading} tabIndex={-1}>用户管理</h1>
          <p>定位用户，核对账号及关联业务，进入对应业务处理。</p>
        </div>
      </div>

      <ListToolbar noValidate onSubmit={() => submitQuery()} onReset={handleReset}>
        <div className="admin-list-toolbar-row ud-search-row">
          <div className="ud-search-bar">
            <ListToolbarSearch
              value={draftInput}
              onChange={setDraftInput}
              placeholder={adapter.has('user.phone.lookup') ? '用户 ID、旧平台 ID、名称或用户名；手机号仅支持精确查找' : '用户 ID、旧平台 ID、名称或用户名'}
              ariaLabel="查找用户"
            />
            <Button type="submit" aria-label="查询">查询</Button>
          </div>
          {mobile ? (
            <Button type="button" variant="outline" size="sm" aria-expanded={moreFiltersOpen} onClick={() => setMoreFiltersOpen(open => !open)}>
              <FilterIcon size={14} className="mr-1" />
              更多筛选
            </Button>
          ) : null}
        </div>
        <div className="admin-list-toolbar-row ud-filter-row">
          <FilterFields variant={mobile ? 'primary' : 'all'} filters={appliedFilters} change={handleFilterChange} />
          <div className="ud-filter-actions">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="ud-reset-button"
              aria-label="重置"
            >
              <RotateCcwIcon size={13} className="mr-1.5" />
              重置
            </Button>
          </div>
        </div>
        {mobile && moreFiltersOpen ? (
          <div className="admin-list-toolbar-row">
            <FilterFields variant="rest" filters={appliedFilters} change={handleFilterChange} />
          </div>
        ) : null}
      </ListToolbar>

      <div className="ud-list-status" role="status" aria-live="polite">
        <div className="ud-status-left">
          {result.state === 'loading' ? (
            <span>{rows ? '更新中，暂保留原结果' : '正在加载用户'}</span>
          ) : draftPending ? (
            <span>条件已更改，点击查询应用</span>
          ) : appliedFilters.sort !== defaultSort ? (
            <div className="ud-active-sort-info">
              <span>当前排序：</span>
              <Badge variant="secondary" className="ud-sort-badge">
                {SORT_LABEL[appliedFilters.sort] || appliedFilters.sort}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => applySort(defaultSort)}
                className="ud-sort-reset-link"
                aria-label="恢复默认排序"
              >
                恢复默认排序
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {notice ? <Message title={notice} /> : null}

      {result.state === 'loading' && !rows ? <UserListSkeleton /> : null}
      {result.state === 'error' ? (
        <div ref={feedback} className="ud-list-feedback" tabIndex={-1}>
        <Message
          kind={result.error instanceof AdminApiError && result.error.status === 403 ? 'denied' : 'error'}
          title={result.error instanceof AdminApiError && result.error.status === 403 ? '查询未执行' : isDirectoryInputError(result.error) ? '筛选条件无效' : pageData && !authorityChanged ? '更新失败，暂保留原结果' : '用户列表加载失败'}
          retry={isDirectoryInputError(result.error) || (result.error instanceof AdminApiError && [400, 403, 409].includes(result.error.status)) ? undefined : retry}
        >
          {errorText(result.error)}
        </Message>
        </div>
      ) : null}

      {rows?.length ? (
        mobile ? (
          <>
            <MobileSortRow sort={appliedFilters.sort} onSort={applySort} />
            <div className="ud-mobile-list">
            {rows.map(user => (
              <section className="ud-mobile-row" key={user.id} aria-label={`用户 ${user.name}`}>
                <Identity user={user} onOpenDetail={u => onOpenPath(`/users/${u.id}`, u.name)} />
                <dl className="ud-mobile-facts">
                  <div><dt>账号状态</dt><dd><Status user={user} /></dd></div>
                  <div><dt>实名</dt><dd><IdentityStatus value={user.identityStatus} /></dd></div>
                  <div><dt>会员与礼遇</dt><dd><MembershipSummaryCell summary={user.membershipSummary} /></dd></div>
                  <div><dt>信用</dt><dd><CreditSummaryCell summary={user.creditSummary} /></dd></div>
                  <div><dt>可用余额</dt><dd><WalletCell summary={user.walletSummary} /></dd></div>
                  <div>
                    <dt>当前业务</dt>
                    <dd>
                      <OrdersCurrentCell
                        user={user}
                        onDrillDown={role => onOpenPath(`/users/${user.id}?section=orders&role=${role}&status=current`, user.name)}
                      />
                      <PublishedCountCell
                        user={user}
                        onDrillDown={() => onOpenPath(`/users/${user.id}?section=resources&publication=published`, user.name)}
                      />
                    </dd>
                  </div>
                  <div><dt>注册时间</dt><dd><RegistrationCell user={user} /></dd></div>
                </dl>
                <div className="ud-mobile-actions">
                  <Button variant="outline" size="sm" aria-label={`快速核对用户 ${user.name}`} onClick={() => setSelected(user.id)}>快速核对</Button>
                  <Button variant="ghost" size="sm" aria-label={`查看用户 ${user.name} 详情`} onClick={() => onOpenPath(`/users/${user.id}`, user.name)}>查看详情<ArrowUpRightIcon size={14} /></Button>
                </div>
              </section>
            ))}
            </div>
          </>
        ) : (
          <ListTable className="ud-table-wrap ud-user-table" aria-busy={result.state === 'loading'}>
            <Table className="admin-list-table">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>账号与实名</TableHead>
                  <TableHead>会员与礼遇</TableHead>
                  <SortHeader label="信用" column="credit" sort={appliedFilters.sort} onSort={applySort} hint="低于80分需关注，低于60分为高风险。" />
                  <SortHeader label="可用余额" column="balance" sort={appliedFilters.sort} onSort={applySort} hint="当前可用余额，不含已申请提现部分。" />
                  <BusinessSortHeader sort={appliedFilters.sort} onSort={applySort} />
                  <SortHeader label="注册时间" column="registered" sort={appliedFilters.sort} onSort={applySort} hint={HEADER_HINTS['注册时间']} />
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(user => (
                  <TableRow
                    key={user.id}
                    tabIndex={0}
                    aria-label={'核对用户 ' + user.name}
                    onKeyDown={e => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        open(user);
                      }
                    }}
                    onClick={() => open(user)}
                  >
                    <TableCell><Identity user={user} onOpenDetail={u => onOpenPath(`/users/${u.id}`, u.name)} /></TableCell>
                    <TableCell>
                      <div className="ud-status-cell flex flex-col gap-1 items-start">
                        <div className="flex flex-wrap items-center gap-1">
                          <Status user={user} />
                          {user.suspended ? <Badge variant="destructive">已冻结</Badge> : null}
                        </div>
                        <IdentityStatus value={user.identityStatus} />
                      </div>
                    </TableCell>
                    <TableCell><MembershipSummaryCell summary={user.membershipSummary} /></TableCell>
                    <TableCell><CreditSummaryCell summary={user.creditSummary} /></TableCell>
                    <TableCell><WalletCell summary={user.walletSummary} /></TableCell>
                    <TableCell>
                      <div className="ud-business-cell">
                        <OrdersCurrentCell
                          user={user}
                          onDrillDown={role => onOpenPath(`/users/${user.id}?section=orders&role=${role}&status=current`, user.name)}
                        />
                        <PublishedCountCell
                          user={user}
                          onDrillDown={() => onOpenPath(`/users/${user.id}?section=resources&publication=published`, user.name)}
                        />
                      </div>
                    </TableCell>
                    <TableCell><RegistrationCell user={user} /></TableCell>
                    <TableCell>
                      <div className="ud-actions-cell flex flex-col gap-1 items-start">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs font-medium"
                          aria-label={`查看用户 ${user.name} 详情`}
                          onClick={e => {
                            e.stopPropagation();
                            onOpenPath(`/users/${user.id}`, user.name);
                          }}
                        >
                          查看详情<ArrowUpRightIcon size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs text-muted-foreground"
                          aria-label={`快速核对用户 ${user.name}`}
                          onClick={e => {
                            e.stopPropagation();
                            setSelected(user.id);
                          }}
                        >
                          快速核对
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ListTable>
        )
      ) : null}

      {result.state === 'ready' && !result.data.rows.length ? (
        cursor ? (
          <Message kind="empty" title="这一页已经没有用户">当前游标页暂无记录；筛选条件已保留，可用下方“上一页”返回。</Message>
        ) : page > 1 ? (
          <Message kind="empty" title="该页暂无记录">
            当前页已无更多用户记录；筛选条件已保留。
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => handlePageChange(1)}>返回首页</Button>
              {pageData && pageData.mode === 'page' && pageData.total > 0 ? (
                <Button variant="outline" size="sm" onClick={() => handlePageChange(Math.ceil(pageData.total / pageSize))}>
                  前往末页
                </Button>
              ) : null}
            </div>
          </Message>
        ) : (
          <Message kind="empty" title="没有符合条件的用户">已保留当前条件；调整条件或使用“重置”。</Message>
        )
      ) : null}

      {pageData && !authorityChanged ? (
        pageData?.mode === 'page' ? (
          <ListPagination
            mode="page"
            page={pageData.page}
            pageSize={pageData.pageSize}
            total={pageData.total}
            loading={result.state === 'loading'}
            pageSizeOptions={[10, 20, 50]}
            loadedCount={rows?.length}
            itemLabel="位用户"
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        ) : (
          <ListPagination
            mode="cursor"
            pageSize={pageSize}
            loadedCount={rows?.length ?? 0}
            total={pageData?.total}
            loading={result.state === 'loading'}
            pageSizeOptions={[10, 20, 50]}
            hasPrevious={cursor !== undefined && pageData?.previous !== undefined}
            hasNext={Boolean(pageData?.next)}
            itemLabel="位用户"
            onPrevious={() => setCursor(pageData?.previous ?? undefined)}
            onNext={() => setCursor(pageData?.next)}
            onPageSizeChange={handlePageSizeChange}
          />
        )
      ) : null}


      <Sheet open={!!selected} onOpenChange={value => { if (!value) setSelected(undefined); }}>
        <SheetContent className="ud-sheet ud-drawer" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>快速核对</SheetTitle>
            <SheetDescription>核对用户主体及关联业务；完整记录在详情中查看。</SheetDescription>
          </SheetHeader>
          <SheetClose render={<Button variant="ghost" size="icon-sm" className="ud-close" aria-label="关闭快速核对" />}>
            <XIcon size={18} />
          </SheetClose>
          {selected ? (
            <QuickCheck
              adapter={adapter}
              id={selected}
              open={section => {
                const id = selected;
                setSelected(undefined);
                onOpenPath(`/users/${id}${section ? `?section=${section}` : ''}`, rows?.find(user => user.id === id)?.name || id);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}

/**
 * 注册时间：只显示服务端声明的来源。
 * 迁入用户的 LOCAL 只是本地建档别名（实测旧注册 2026-07-29、本地建档 2026-10-12），
 * 因此显示待核；本平台原生用户的建档时间就是其注册时间。
 * 不从 updatedAt、审计时间或列表顺序反推注册时间。
 */
function QuickCheck({ adapter, id, open }: { adapter: UserDirectoryData; id: string; open: (section?: string) => void }) {
  const { result, retry } = useDirectoryRequest(id, signal => adapter.detail(id, signal, true));
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') return <Message kind="error" title="核对信息加载失败" retry={retry}>{errorText(result.error)}</Message>;
  const user = result.data;
  return (
    <div className="ud-sheet-body">
      <Identity user={user} full />
      <div className="ud-quick-facts"><Status user={user} /><IdentityStatus value={user.identityStatus} /></div>
      <div className="ud-summary-line">
        <span className="text-xs text-muted-foreground">会员与礼遇</span>
        <MembershipSummaryCell summary={user.membershipSummary} />
      </div>
      <div className="ud-summary-line">
        <span className="text-xs text-muted-foreground">信用状态</span>
        <CreditSummaryCell summary={user.creditSummary} />
      </div>
      <div className="ud-summary-line">
        <span className="text-xs text-muted-foreground">注册时间</span>
        <RegistrationCell user={user} />
      </div>
      {user.orders.state === 'denied' ? (
        <Denied permission={PERMISSION.orders} />
      ) : (
        <div className="ud-summary-line">
          <Summary part={user.orders} kind="orders" />
          <Button variant="outline" onClick={() => open('orders')}>查看订单记录</Button>
        </div>
      )}
      {user.resources.state === 'denied' ? (
        <Denied permission={PERMISSION.resources} />
      ) : (
        <div className="ud-summary-line">
          <Summary part={user.resources} kind="resources" />
          <Button variant="outline" onClick={() => open('resources')}>查看资源账号</Button>
        </div>
      )}
      <Button onClick={() => open()}>打开完整详情<ArrowUpRightIcon size={16} /></Button>
      {user.status === 'DEACTIVATED' ? (
        adapter.has('user.account.restore') ? (
          <Button variant="outline" onClick={() => open('security')}>进入账号恢复评估</Button>
        ) : (
          <Denied permission="user.account.restore" />
        )
      ) : null}
    </div>
  );
}
