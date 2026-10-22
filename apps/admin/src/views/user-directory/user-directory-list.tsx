import { AdminApiError } from '../../api';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, CalendarDaysIcon, FilterIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DateSelector, type DateSelectorValue } from '@/components/reui/date-selector';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  ListTable,
  ListToolbar,
  ListToolbarSearch,
  ListToolbarEnumSelect,
  ListToolbarApplied,
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
  FILTER_VALUE_LABEL,
  PERMISSION,
  PHONE_LIKE,
  REGISTRATION_SORT,
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
const CREDIT_OPTIONS: [string, string][] = [['KNOWN', '已评分'], ['NOT_INITIALIZED', '未评分']];
const RISK_OPTIONS: [string, string][] = [['FLAGGED', '高危'], ['NOT_FLAGGED', '非高危']];
const TIER_LABEL_TEXT: Record<string, string> = Object.fromEntries(TIER_OPTIONS);
const ENTITLEMENT_LABEL_TEXT: Record<string, string> = Object.fromEntries(ENTITLEMENT_OPTIONS);
const CREDIT_LABEL_TEXT: Record<string, string> = Object.fromEntries(CREDIT_OPTIONS);
const RISK_LABEL_TEXT: Record<string, string> = Object.fromEntries(RISK_OPTIONS);
const DRAFT_FILTER_KEYS = ['status', 'from', 'to', 'identity', 'source', 'tier', 'entitlement', 'credit', 'risk'] as const;
const SORT_LABEL: Record<string, string> = {
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

/** 紧凑业务筛选：桌面一行可换行；窄屏先给状态与日期，其余行内折叠，不再藏进侧边抽屉。 */
function FilterFields({ filters, change, variant }: { filters: Filters; change: (patch: Partial<Filters>) => void; variant: 'primary' | 'rest' | 'all' }) {
  return (
    <div className="ud-filter-fields">
      {variant !== 'rest' ? (
        <>
          <ListToolbarEnumSelect label="账号状态" value={filters.status} onChange={status => change({ status })} options={Object.entries(STATUS_LABEL)} />
          <RegistrationDateRange from={filters.from} to={filters.to} onChange={change} />
        </>
      ) : null}
      {variant !== 'primary' ? (
        <>
          <ListToolbarEnumSelect label="实名状态" value={filters.identity} onChange={identity => change({ identity })} options={[['VERIFIED', '已实名'], ['UNVERIFIED', '未实名'], ['REJECTED', '未通过'], ['UNKNOWN', '未知']]} />
          <ListToolbarEnumSelect label="来源" value={filters.source} onChange={source => change({ source })} options={[['MIGRATED', '旧平台用户'], ['LOCAL', '未关联旧平台来源'], ['UNKNOWN', '来源未知']]} />
          <ListToolbarEnumSelect label="会员等级" value={filters.tier} onChange={tier => change({ tier })} options={TIER_OPTIONS} />
          <ListToolbarEnumSelect label="有效礼遇" value={filters.entitlement} onChange={entitlement => change({ entitlement })} options={ENTITLEMENT_OPTIONS} />
          <ListToolbarEnumSelect label="信用" value={filters.credit} onChange={credit => change({ credit })} options={CREDIT_OPTIONS} />
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
        className="ud-sort-header"
        aria-label={`按${label}排序`}
        onClick={() => onSort(`${column}_${ascending ? 'desc' : 'asc'}`)}
      >
        {label}
        <span className="ud-sort-indicator" aria-hidden>{active ? (ascending ? '↑' : '↓') : '↕'}</span>
      </Button>
      {hint ? <Hint label={`${label}口径`}>{hint}</Hint> : null}
    </TableHead>
  );
}

const TABLE_HEADERS = ['用户', '账号与实名', '会员与礼遇', '信用', '可用余额', '当前业务', '注册时间', '操作'];
const HEADER_HINTS: Record<string, string> = {
  当前业务: '进行中订单含待支付与已支付两种状态；租入与出租分别统计，不相加为去重合计。上架数是该用户当前真实上架的账号档案数，不等于名下档案总数，也不等于当前可租库存。',
  注册时间: '注册时间取服务端声明的原始注册时间及其来源；旧平台注册、本平台注册与待核分开，不用本地建档时间代替。',
};

/** 合并业务列的三个小排序：租入、出租、上架各自独立。 */
function BusinessSortHeader({ sort, onSort }: { sort: string; onSort: (next: string) => void }) {
  const columns: [string, string][] = [['renter_current', '租入'], ['owner_current', '出租'], ['published', '上架']];
  const active = columns.find(([column]) => sort.startsWith(`${column}_`));
  const ascending = Boolean(active && sort.endsWith('_asc'));
  return (
    <TableHead aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <div className="ud-business-head">
        <span>当前业务</span>
        {columns.map(([column, label]) => {
          const on = sort.startsWith(`${column}_`);
          const up = on && sort.endsWith('_asc');
          return (
            <Button key={column} type="button" variant="ghost" size="xs" className="ud-sort-header" aria-label={`按${label}排序`} onClick={() => onSort(`${column}_${up ? 'desc' : 'asc'}`)}>
              {label}
              <span className="ud-sort-indicator" aria-hidden>{on ? (up ? '↑' : '↓') : '↕'}</span>
            </Button>
          );
        })}
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
            <span className="ud-sort-indicator" aria-hidden>{on ? (up ? '↑' : '↓') : '↕'}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function UserList({ adapter, tab, onQueryChange, onOpenPath, refreshNonce }: PageProps & { adapter: UserDirectoryData }) {
  const mobile = useIsMobile();
  const safeInitial = { ...EMPTY_FILTERS, ...Object.fromEntries(Object.entries(tab.query).filter(([key]) => key in EMPTY_FILTERS)), sort: normalizeRegistrationSort(tab.query.sort) };
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
  const [notice, setNotice] = useState('');

  const filterKey = JSON.stringify(appliedFilters);
  // 已生效条件用中文；注册日期区间是一项，可单独清除。
  const appliedChips = [
    ...(appliedFilters.q ? [{ key: 'q', label: PHONE_LIKE.test(appliedFilters.q) ? '手机号精确查询（值已隐藏）' : `搜索：${appliedFilters.q}` }] : []),
    ...(appliedFilters.status ? [{ key: 'status', label: `账号状态：${STATUS_LABEL[appliedFilters.status] ?? appliedFilters.status}` }] : []),
    ...(appliedFilters.identity ? [{ key: 'identity', label: `实名状态：${FILTER_VALUE_LABEL[appliedFilters.identity] ?? appliedFilters.identity}` }] : []),
    ...(appliedFilters.source ? [{ key: 'source', label: `来源：${FILTER_VALUE_LABEL[appliedFilters.source] ?? appliedFilters.source}` }] : []),
    ...(appliedFilters.tier ? [{ key: 'tier', label: `会员等级：${TIER_LABEL_TEXT[appliedFilters.tier] ?? appliedFilters.tier}` }] : []),
    ...(appliedFilters.entitlement ? [{ key: 'entitlement', label: `有效礼遇：${ENTITLEMENT_LABEL_TEXT[appliedFilters.entitlement] ?? appliedFilters.entitlement}` }] : []),
    ...(appliedFilters.credit ? [{ key: 'credit', label: `信用：${CREDIT_LABEL_TEXT[appliedFilters.credit] ?? appliedFilters.credit}` }] : []),
    ...(appliedFilters.risk ? [{ key: 'risk', label: `内部标识：${RISK_LABEL_TEXT[appliedFilters.risk] ?? appliedFilters.risk}` }] : []),
    ...(appliedFilters.from || appliedFilters.to ? [{ key: 'date', label: `注册日期：${appliedFilters.from || '不限'} 至 ${appliedFilters.to || '不限'}` }] : []),
  ];
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
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice('');
    recoveringContext.current = false;
    retry();
  };

  const handleRemoveFilter = (key: string) => {
    if (key === 'q') setDraftInput('');
    const patch = key === 'date' ? { from: '', to: '' } : { [key]: '' };
    setDraftFilters(current => ({ ...current, ...patch }));
    setAppliedFilters(current => ({ ...current, ...patch }));
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice('');
    recoveringContext.current = false;
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
    setPageData(undefined);
    setNotice('');
  };

  const authorityChanged = result.state === 'error' && result.error instanceof AdminApiError && [401, 403, 409, 423].includes(result.error.status);
  const rows = authorityChanged ? undefined : result.state === 'ready' ? result.data.rows : pageData?.rows;
  const open = (user: User) => setSelected(user.id);

  // A responsive layout change can close quick-check, but only a user's CTA can create a detail tab.
  useEffect(() => { if (mobile) setSelected(undefined); }, [mobile]);
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <section className="ud-directory" aria-labelledby="user-directory-title">
      <div className="ud-heading">
        <div>
          <h1 id="user-directory-title" ref={heading} tabIndex={-1}>用户管理</h1>
          <p>定位用户，核对账号及关联业务，进入对应业务处理。</p>
        </div>
      </div>

      <ListToolbar onSubmit={() => submitQuery()} onReset={handleReset}>
        <div className="admin-list-toolbar-row">
          <ListToolbarSearch
            value={draftInput}
            onChange={setDraftInput}
            placeholder={adapter.has('user.phone.lookup') ? '用户 ID、旧平台 ID、名称或用户名；手机号仅支持精确查找' : '用户 ID、旧平台 ID、名称或用户名'}
            ariaLabel="查找用户"
          />
          <ListToolbarActions>
            <Button type="submit" aria-label="查询">查询</Button>
            <Button type="button" variant="outline" onClick={handleReset}>重置</Button>
            {mobile ? (
              <Button type="button" variant="outline" aria-expanded={moreFiltersOpen} onClick={() => setMoreFiltersOpen(open => !open)}>
                <FilterIcon size={16} className="mr-1" />
                更多筛选
              </Button>
            ) : null}
          </ListToolbarActions>
        </div>
        <div className="admin-list-toolbar-row">
          <FilterFields variant={mobile ? 'primary' : 'all'} filters={draftFilters} change={patch => setDraftFilters(c => ({ ...c, ...patch }))} />
        </div>
        {mobile && moreFiltersOpen ? (
          <div className="admin-list-toolbar-row">
            <FilterFields variant="rest" filters={draftFilters} change={patch => setDraftFilters(c => ({ ...c, ...patch }))} />
          </div>
        ) : null}
        {draftPending ? <p className="ud-draft-hint" role="status">条件尚未应用</p> : null}
        <ListToolbarApplied
          filters={appliedChips.map(chip => ({ key: chip.key, label: chip.label, onRemove: () => handleRemoveFilter(chip.key) }))}
        />
      </ListToolbar>

      <div className="ud-list-meta">
        <span>数量按当前管理员的游戏范围与对象权限裁剪</span>
        <span>{SORT_LABEL[appliedFilters.sort] ?? SORT_LABEL.registered_desc}</span>
      </div>

      {notice ? <Message title={notice} /> : null}
      {result.state === 'loading' && rows ? <p className="ud-updating" role="status">更新中，以下为上一次查询结果</p> : null}

      {result.state === 'loading' && !rows ? <Loading /> : null}
      {result.state === 'error' && (!pageData || authorityChanged) ? (
        <Message
          kind={result.error instanceof AdminApiError && result.error.status === 403 ? 'denied' : 'error'}
          title={result.error instanceof AdminApiError && result.error.status === 403 ? '查询未执行' : isDirectoryInputError(result.error) ? '筛选条件无效' : '加载失败'}
          retry={isDirectoryInputError(result.error) || (result.error instanceof AdminApiError && [400, 403, 409].includes(result.error.status)) ? undefined : retry}
        >
          {errorText(result.error)}
        </Message>
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
          <ListTable className="ud-table-wrap" aria-busy={result.state === 'loading'}>
            <Table className="admin-list-table">
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>账号与实名</TableHead>
                  <TableHead>会员与礼遇</TableHead>
                  <SortHeader label="信用" column="credit" sort={appliedFilters.sort} onSort={applySort} hint="信用分取服务端实际分值；未初始化与读取未知分开，不显示技术版本号。" />
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

      {result.state === 'error' && pageData && !authorityChanged ? (
        <Message kind="error" title="翻页加载失败，保留当前页" retry={retry}>{errorText(result.error)}</Message>
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
