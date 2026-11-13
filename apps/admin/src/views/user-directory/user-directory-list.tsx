import { DomainSummaryBlock } from "../../components/dashboard/domain-summary-block";
import { readDomainSummary } from "../../components/dashboard/domain-summary-model";
import { UserQuickCheck } from './user-quick-check';
import { AdminApiError } from '../../api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownIcon, ArrowUpRightIcon, FilterIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
  normalizeRegistrationSort,
  safeFilters,
  userDirectoryFilterQuery,
  type Filters,
  type User,
  type UserDirectoryListResult,
} from './user-directory-data';
import {
  CreditSummaryCell,
  Denied,
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
  time,
  useDirectoryRequest,
  type PageProps,
  type UserDirectoryData,
} from './user-directory-shared';
import { FilterFields } from './user-directory-list-filters';
import { BusinessSortHeader, MobileSortRow, SortHeader, UserListSkeleton } from './user-directory-list-table';

export function EnumSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <ListToolbarEnumSelect label={label} value={value} onChange={onChange} options={options} />;
}

const DRAFT_FILTER_KEYS = ['status', 'from', 'to', 'identity', 'tier', 'entitlement', 'creditMin', 'creditMax', 'risk', 'registrationTime', 'registeredFrom', 'registeredTo'] as const;
const directoryQueryKey = (query: Record<string, string>) => JSON.stringify([...Object.keys(EMPTY_FILTERS).sort().map(key => query[key] ?? ''), query.page ?? '', query.pageSize ?? '', query.cursor ?? '']);
const SORT_LABEL: Record<string, string> = {
  active_orders_desc: '活跃订单优先',
  registered_desc: '注册时间新→旧', registered_asc: '注册时间旧→新',
  balance_desc: '可用余额高→低', balance_asc: '可用余额低→高',
  credit_desc: '信用分高→低', credit_asc: '信用分低→高',
  renter_current_desc: '租入数多→少', renter_current_asc: '租入数少→多',
  owner_current_desc: '出租数多→少', owner_current_asc: '出租数少→多',
  published_desc: '上架数多→少', published_asc: '上架数少→多',
};

/** 关键词检索时，默认避开需要全量聚合的排序。 */
const AGGREGATE_SORT_PREFIXES = ['active_orders', 'renter_current', 'owner_current', 'published', 'balance', 'credit'];
const isAggregateSort = (sort: string) => AGGREGATE_SORT_PREFIXES.some(prefix => sort.startsWith(`${prefix}_`));

const HEADER_HINTS: Record<string, string> = {
  当前业务: '租入、出租为待支付或已支付的订单数；上架为已发布账号数。',
  注册时间: '用户首次注册的时间，包含旧平台。',
};

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

  const summaryQuery = (() => {
    if (appliedFilters.q.trim()) return null; // 有关键词时不发概览全表统计（服务端按关键词降级排序/不统计）
    try { return userDirectoryFilterQuery(appliedFilters).toString(); }
    catch { return null; } // The existing list presents invalid filter feedback.
  })();
  const readSummary = useCallback((signal: AbortSignal) => readDomainSummary("USERS", new URLSearchParams(summaryQuery ?? ""), signal), [summaryQuery]);
  const summaryIdentity = JSON.stringify([adapter.snapshot.adminUserId, adapter.snapshot.session.id, adapter.snapshot.session.locked, adapter.snapshot.security.isBoss, adapter.snapshot.security.status, adapter.snapshot.security.passwordChangeRequired, [...adapter.snapshot.permissions].sort()]);
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
  const incomingQueryKey = directoryQueryKey(tab.query);
  const previousQueryKey = useRef(incomingQueryKey);

  useEffect(() => {
    if (previousQueryKey.current === incomingQueryKey) return;
    previousQueryKey.current = incomingQueryKey;
    const next = { ...EMPTY_FILTERS, ...Object.fromEntries(Object.entries(tab.query).filter(([key]) => key in EMPTY_FILTERS)), sort: tab.query.sort ? normalizeRegistrationSort(tab.query.sort) : defaultSort };
    setAppliedFilters(next); setDraftFilters(next); setDraftInput(next.q);
    setPage(tab.query.page && /^[1-9]\d*$/.test(tab.query.page) ? Number(tab.query.page) : 1);
    setPageSize(tab.query.pageSize && /^[1-9]\d*$/.test(tab.query.pageSize) ? Number(tab.query.pageSize) : 20);
    setCursor(tab.query.cursor); contextKeyRef.current = undefined; recoveringContext.current = false;
    setNotice('已按地址栏恢复当前筛选范围。');
  }, [incomingQueryKey, defaultSort, tab.query]);

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
    previousQueryKey.current = directoryQueryKey(query);
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
    // 普通关键词检索时默认避开全量聚合排序；手机号走精确查找，保留用户原排序。
    const appliedSort = newQ && !isPhone && isAggregateSort(nextDraft.sort) ? 'registered_desc' : nextDraft.sort;

    // 保留输入框内容；手机号不写入地址栏由 safeFilters 在 PHONE_LIKE 时剥离 q 保证（user-directory-data.ts:58），无需清空。
    setAppliedFilters({ ...nextDraft, q: newQ, sort: appliedSort });
    setDraftFilters({ ...nextDraft, q: newQ, sort: appliedSort });
    setPage(1);
    setCursor(undefined);
    contextKeyRef.current = undefined;
    setNotice(appliedSort !== nextDraft.sort ? '为加快搜索，已按注册时间排序；可在结果中调整排序。' : '');
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

      {summaryQuery !== null ? <DomainSummaryBlock domain="USERS" identity={summaryIdentity} queryKey={summaryQuery} read={readSummary} onStatus={status => handleFilterChange({ status })} refreshNonce={refreshNonce} enabled={result.state !== 'loading'} /> : null}

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

      {appliedFilters.registeredFrom || appliedFilters.registeredTo ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="note"><span>经营概览下钻 · {appliedFilters.registrationTime === 'LOCAL' ? '本地建档' : '原注册'}时段：{appliedFilters.registeredFrom ? time(appliedFilters.registeredFrom) : '不限'} 至 {appliedFilters.registeredTo ? time(appliedFilters.registeredTo) : '本次读取'}</span><Button type="button" variant="ghost" size="xs" onClick={() => handleFilterChange({ registeredFrom: '', registeredTo: '' })}>清除时段</Button></div> : null}

      <div className="ud-list-status" role="status" aria-live="polite">
        <div className="ud-status-left">
          {result.state === 'loading' ? (
            <span>{rows ? '更新中，暂保留原结果' : '正在加载用户'}</span>
          ) : draftPending ? (
            <span>条件已更改，点击查询应用</span>
          ) : appliedFilters.registrationTime === 'LOCAL' ? (
            <span>按本地建档时间最新优先；含导入记录，不代表旧平台首次注册时间。</span>
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
            {appliedFilters.registrationTime === 'LOCAL' ? <p className="text-xs text-muted-foreground">本地建档最新优先</p> : <MobileSortRow sort={appliedFilters.sort} onSort={applySort} />}
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
                  <div><dt>{appliedFilters.registrationTime === 'LOCAL' ? '本地建档时间' : '注册时间'}</dt><dd><RegistrationCell user={user} /></dd></div>
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
                  {appliedFilters.registrationTime === 'LOCAL' ? <>
                    <TableHead>信用</TableHead><TableHead>可用余额</TableHead><TableHead>当前业务</TableHead>
                    <TableHead aria-sort="descending">本地建档时间<ArrowDownIcon className="ml-1 inline" size={12} aria-hidden /></TableHead>
                  </> : <>
                    <SortHeader label="信用" column="credit" sort={appliedFilters.sort} onSort={applySort} hint="80分为当前号主保证金的信用门槛，具体准入以服务端规则为准。" />
                    <SortHeader label="可用余额" column="balance" sort={appliedFilters.sort} onSort={applySort} hint="当前可用余额，不含已申请提现部分。" />
                    <BusinessSortHeader sort={appliedFilters.sort} onSort={applySort} />
                    <SortHeader label="注册时间" column="registered" sort={appliedFilters.sort} onSort={applySort} hint={HEADER_HINTS['注册时间']} />
                  </>}
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
        <SheetContent className="ud-sheet ud-drawer ud-detail-v2" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>快速核对</SheetTitle>
            <SheetDescription>查看当前租入、出租订单和上架账号。</SheetDescription>
          </SheetHeader>
          <SheetClose render={<Button variant="ghost" size="icon-sm" className="ud-close" aria-label="关闭快速核对" />}>
            <XIcon size={18} />
          </SheetClose>
          {selected ? (
            <QuickCheck
              adapter={adapter}
              id={selected}
              refreshNonce={refreshNonce}
              onChanged={retry}
              onOpenPath={(path,title)=>{setSelected(undefined);onOpenPath(path,title);}}
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

function QuickCheck({adapter,id,open,onOpenPath,onChanged,refreshNonce}:{adapter:UserDirectoryData;id:string;open:(section?:string)=>void;onOpenPath:PageProps['onOpenPath'];onChanged:()=>void;refreshNonce:number}) {
  const {result,retry}=useDirectoryRequest(id+':quick:'+refreshNonce,signal=>adapter.detail(id,signal,true));
  if(result.state==='loading')return <Loading/>;
  if(result.state==='error')return <Message kind="error" title="当前业务读取失败" retry={retry}>{errorText(result.error)}</Message>;
  return <div className="ud-sheet-body"><Identity user={result.data}/><UserQuickCheck adapter={adapter} user={result.data} refreshNonce={refreshNonce} onOpenPath={onOpenPath} onChanged={onChanged}/><Button variant="outline" onClick={()=>open()}>打开完整详情<ArrowUpRightIcon size={16}/></Button></div>;
}
