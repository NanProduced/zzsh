import { AdminApiError } from '../../api';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, FilterIcon, SearchIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIsMobile } from '@/hooks/use-mobile';
import { EMPTY_FILTERS, FILTER_VALUE_LABEL, PERMISSION, PHONE_LIKE, STATUS_LABEL, safeFilters, type Filters, type User } from './user-directory-data';
import { errorText, isDirectoryInputError, Denied, Identity, Loading, Message, Recent, Status, Summary, useDirectoryRequest, type PageProps, type UserDirectoryData } from './user-directory-shared';
export function EnumSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <label className="ud-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)} aria-label={label}><option value="">全部</option>{options.map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></label>;
}
function FilterFields({ filters, change, adapter, more = false }: { filters: Filters; change: (patch: Partial<Filters>) => void; adapter: UserDirectoryData; more?: boolean }) {
  return <div className="ud-filter-fields">{!more ? <>
    <EnumSelect label="账号状态" value={filters.status} onChange={status => change({ status })} options={Object.entries(STATUS_LABEL)} />
    <label className="ud-field"><span>注册起始日期</span><input type="date" aria-label="注册起始日期" value={filters.from} onChange={e => change({ from: e.target.value })} /></label>
    <label className="ud-field"><span>注册结束日期</span><input type="date" aria-label="注册结束日期" value={filters.to} onChange={e => change({ to: e.target.value })} /></label>
  </> : <>
    <EnumSelect label="身份状态" value={filters.identity} onChange={identity => change({ identity })} options={[['VERIFIED','已实名'],['UNVERIFIED','未实名'],['REJECTED','未通过'],['UNKNOWN','未知']]} />
    <EnumSelect label="年龄状态" value={filters.age} onChange={age => change({ age })} options={[['ADULT','成年'],['MINOR','未成年'],['UNKNOWN','未知']]} />
    <EnumSelect label="来源" value={filters.source} onChange={source => change({ source })} options={[['MIGRATED','旧平台用户'],['LOCAL','未关联旧平台来源'],['UNKNOWN','来源未知']]} />
  </>}</div>;
}

export function UserList({ adapter, tab, onQueryChange, onOpenPath, refreshNonce }: PageProps & { adapter: UserDirectoryData }) {
  const mobile = useIsMobile();
  const safeInitial = { ...EMPTY_FILTERS, ...Object.fromEntries(Object.entries(tab.query).filter(([key]) => key in EMPTY_FILTERS)), sort: 'created' };
  const [filters, setFilters] = useState<Filters>(safeInitial);
  const [input, setInput] = useState(safeInitial.q);
  const [cursor, setCursor] = useState(tab.query.cursor);
  const [page, setPage] = useState<Awaited<ReturnType<UserDirectoryData['list']>>>();
  const [filterSheet, setFilterSheet] = useState(false);
  const [selected, setSelected] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState('');
  const filterKey = JSON.stringify(filters);
  const appliedFilters = Object.entries(filters).filter(([key, value]) => value && key !== 'sort');
  const filterLabels: Record<string, string> = { q: '搜索', status: '账号状态', from: '注册起始', to: '注册结束', identity: '身份状态', age: '年龄状态', source: '来源' };
  const pageKey = `${filterKey}:${cursor ?? ''}:${refreshNonce}`;
  const { result, retry } = useDirectoryRequest(pageKey, signal => adapter.list(filters, cursor, signal));
  const callback = useRef(onQueryChange); callback.current = onQueryChange;
  useEffect(() => { callback.current({ ...safeFilters(filters), ...(!PHONE_LIKE.test(filters.q) && cursor ? { cursor } : {}) }); }, [filterKey, cursor]);
  useEffect(() => {
    if (result.state === 'ready') setPage(result.data);
    if (result.state === 'error' && result.error instanceof AdminApiError && result.error.status === 409) { setNotice(errorText(result.error)); setCursor(undefined); setPage(undefined); }
  }, [result]);
  const change = (patch: Partial<Filters>) => { setFilters(current => ({ ...current, ...patch })); setCursor(undefined); setPage(undefined); setNotice(''); };
  const clear = () => { setInput(''); change(EMPTY_FILTERS); };
  const authorityChanged=result.state==='error' && result.error instanceof AdminApiError && [401,403,409,423].includes(result.error.status);
  const rows = authorityChanged ? undefined : result.state === 'ready' ? result.data.rows : page?.rows;
  const open = (user: User) => window.matchMedia('(max-width: 767px)').matches ? onOpenPath(`/users/${user.id}`, user.name) : setSelected(user.id);
  // A responsive layout change can close quick-check, but only a user's CTA can create a detail tab.
  useEffect(() => { if (mobile) setSelected(undefined); }, [mobile]);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="ud-directory" aria-labelledby="user-directory-title">
    <div className="ud-heading"><div><h1 id="user-directory-title" ref={heading} tabIndex={-1}>用户管理</h1><p>定位用户，核对账号及关联业务，进入对应业务处理。</p></div></div>
    <form className="ud-search" onSubmit={e => { e.preventDefault(); change({ q: input.trim() }); if (PHONE_LIKE.test(input)) setInput(''); }}><label className="ud-search-input"><SearchIcon size={18} /><span className="sr-only">查找用户</span><Input aria-label="查找用户" autoComplete="off" placeholder="用户 ID、旧平台 ID、名称或用户名" value={input} onChange={e => setInput(e.target.value)} /></label><Button type="submit">搜索</Button><Button type="button" variant="outline" onClick={() => setFilterSheet(true)}><FilterIcon size={16} />{mobile ? '筛选' : '更多筛选'}{appliedFilters.length ? `（${appliedFilters.length}）` : ''}</Button></form>
    {!mobile ? <FilterFields filters={filters} change={change} adapter={adapter} /> : null}
    <div className="ud-list-meta"><span>{adapter.has('user.phone.lookup') ? '支持手机号精确查询；仅在当前页内使用' : '手机号精确查询需要单独权限'}</span><span>按注册时间倒序 · 业务活动暂未接入</span><Button variant="ghost" onClick={clear}>清除筛选</Button></div>
    {notice ? <Message title={notice} /> : null}
    {appliedFilters.length ? <div className="ud-applied-filters" aria-label="已用筛选"><span>已用筛选</span>{appliedFilters.map(([key, value]) => {
      const label = key === 'q' && PHONE_LIKE.test(value) ? '手机号精确查询（值已隐藏）' : `${filterLabels[key]}：${key === 'status' ? STATUS_LABEL[value] ?? value : FILTER_VALUE_LABEL[value] ?? value}`;
      return <Button key={key} variant="outline" aria-label={`移除${filterLabels[key]}筛选`} onClick={() => { if (key === 'q') setInput(''); change({ [key]: '' }); }}><span className="ud-filter-label">{label}</span><XIcon size={12} /></Button>;
    })}</div> : null}
    {result.state === 'loading' && !rows ? <Loading /> : null}
    {result.state === 'error' && (!page || authorityChanged) ? <Message kind={result.error instanceof AdminApiError && result.error.status === 403 ? 'denied' : 'error'} title={result.error instanceof AdminApiError && result.error.status === 403 ? '查询未执行' : isDirectoryInputError(result.error) ? '筛选条件无效' : '加载失败'} retry={isDirectoryInputError(result.error) || result.error instanceof AdminApiError && [400, 403, 409].includes(result.error.status) ? undefined : retry}>{errorText(result.error)}</Message> : null}
    {rows?.length ? mobile ? <div className="ud-mobile-list">{rows.map(user => <button type="button" className="ud-mobile-row" key={user.id} onClick={() => open(user)}><Identity user={user} /><dl className="ud-mobile-facts"><div><dt>账号状态</dt><dd><Status user={user} /></dd></div><div><dt>当前订单</dt><dd><Summary part={user.orders} kind="orders" /></dd></div><div><dt>资源账号</dt><dd><Summary part={user.resources} kind="resources" /></dd></div></dl><span className="ud-mobile-action">打开详情 <ArrowUpRightIcon size={14} /></span></button>)}</div> : <div className="ud-table-wrap" aria-busy={result.state === 'loading'}><Table><TableHeader><TableRow>{['用户', '账号状态', '当前订单', '资源账号', '操作'].map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(user => <TableRow key={user.id} tabIndex={0} aria-label={'核对用户 ' + user.name} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(user); } }} onClick={() => open(user)}><TableCell><Identity user={user} full /></TableCell><TableCell><Status user={user} /></TableCell><TableCell><Summary part={user.orders} kind="orders" /></TableCell><TableCell><Summary part={user.resources} kind="resources" /></TableCell><TableCell><Button variant="ghost" aria-label={`核对用户 ${user.name}`} onClick={e => { e.stopPropagation(); open(user); }}>核对<ArrowUpRightIcon size={14} /></Button></TableCell></TableRow>)}</TableBody></Table></div> : null}
    {result.state === 'ready' && !result.data.rows.length ? <Message kind="empty" title="没有符合条件的用户">已保留当前条件；调整条件或使用“清除筛选”。</Message> : null}
    {rows?.length ? <div className="ud-pagination"><span>当前页已加载 {rows.length} 条 · 不提供全量总数{result.state === 'loading' ? ' · 正在翻页' : ''}</span><div><Button variant="outline" disabled={result.state === 'loading' || page?.previous === undefined} onClick={() => setCursor(page?.previous??undefined)}>上一页</Button><Button variant="outline" disabled={result.state === 'loading' || !page?.next} onClick={() => setCursor(page?.next)}>下一页</Button></div></div> : null}
    {result.state === 'error' && page && !authorityChanged ? <Message kind="error" title="翻页加载失败，保留当前页" retry={retry}>{errorText(result.error)}</Message> : null}
    <Sheet open={filterSheet} onOpenChange={setFilterSheet}><SheetContent className="ud-sheet ud-filter-sheet" side="right" showCloseButton={false}><SheetHeader><SheetTitle>{mobile ? '筛选用户' : '更多筛选'}</SheetTitle><SheetDescription>筛选基于当前可见范围，按本平台用户创建时间筛选（北京时间）。</SheetDescription></SheetHeader><SheetClose render={<Button variant="ghost" size="icon-sm" className="ud-close" aria-label="关闭筛选" />}><XIcon size={18} /></SheetClose><div className="ud-sheet-body">{mobile ? <FilterFields filters={filters} change={change} adapter={adapter} /> : null}<FilterFields filters={filters} change={change} adapter={adapter} more /></div><SheetFooter><Button onClick={() => setFilterSheet(false)}>完成筛选</Button></SheetFooter></SheetContent></Sheet>
    <Sheet open={!!selected} onOpenChange={value => { if (!value) setSelected(undefined); }}><SheetContent className="ud-sheet ud-drawer" showCloseButton={false}><SheetHeader><SheetTitle>快速核对</SheetTitle><SheetDescription>核对用户主体及关联业务；完整记录在详情中查看。</SheetDescription></SheetHeader><SheetClose render={<Button variant="ghost" size="icon-sm" className="ud-close" aria-label="关闭快速核对" />}><XIcon size={18} /></SheetClose>{selected ? <QuickCheck adapter={adapter} id={selected} open={section => { const id = selected; setSelected(undefined); onOpenPath(`/users/${id}${section ? `?section=${section}` : ''}`, rows?.find(user => user.id === id)?.name || id); }} /> : null}</SheetContent></Sheet>
  </section>;
}

function QuickCheck({ adapter, id, open }: { adapter: UserDirectoryData; id: string; open: (section?: string) => void }) {
  const { result, retry } = useDirectoryRequest(id, signal => adapter.detail(id, signal, true));
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') return <Message kind="error" title="核对信息加载失败" retry={retry}>{errorText(result.error)}</Message>;
  const user = result.data;
  return <div className="ud-sheet-body"><Identity user={user} full /><div className="ud-quick-facts"><Status user={user} /></div>{user.orders.state === 'denied' ? <Denied permission={PERMISSION.orders} /> : <div className="ud-summary-line"><Summary part={user.orders} kind="orders" /><Button variant="outline" onClick={() => open('orders')}>查看订单记录</Button></div>}{user.resources.state === 'denied' ? <Denied permission={PERMISSION.resources} /> : <div className="ud-summary-line"><Summary part={user.resources} kind="resources" /><Button variant="outline" onClick={() => open('resources')}>查看资源账号</Button></div>}<div className="ud-summary-line"><Recent user={user} /></div><Button onClick={() => open()}>打开完整详情<ArrowUpRightIcon size={16} /></Button>{user.status === 'DEACTIVATED' ? adapter.has('user.account.restore') ? <Button variant="outline" onClick={() => open('security')}>进入账号恢复评估</Button> : <Denied permission="user.account.restore" /> : null}</div>;
}

