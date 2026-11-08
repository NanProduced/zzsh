import { useEffect, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { adminRequest, AdminApiError, friendlyError, type SessionSnapshot } from '../api';
import { findPhoneClue, type WorkspaceTab } from '../workspace/tab-model';
import { ListPagination, ListTable, ListToolbar, ListToolbarActions, ListToolbarEnumSelect, ListToolbarSearch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/admin-list';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Field } from '../components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { DateSelector, type DateSelectorValue } from '../components/reui/date-selector';
import { EntityPreviewTrigger, UserProfilePreview } from '../components/admin-preview';
import { financeMoney, financeTime } from './admin-finance-api';
import './admin-finance.css';

type Snapshot = Extract<SessionSnapshot, { authenticated:true }>;
type Row = { id:string; source:'LEGACY'|'NATIVE'|'OPENING'; subjectId:string; subjectName:string; subjectRole?:'RENTER'|'OWNER'|'WITHDRAWER'|'RELATED_USER'; documentRef:string|null; occurredAt:string|null; amountCents:string|null; amountLabel?:string; kind?:string; number?:string|null; relatedNumber?:string|null; relatedNumberLabel?:string|null; method?:string|null; grossCents?:string|null; feeCents?:string|null; state?:string|null; dataOrigin?:string|null; bankArrival?:string|null; label?:string; balanceAfterCents?:string|null };
type Result = { asOf:string; page:number; pageSize:number; total:number; hasMore:boolean; items:Row[] };
type Draft = { q:string; kind:string; from:string; to:string; type:string; nonzero:boolean };
type Filters = Draft & { page:number; pageSize:number; asOf:string };
const kinds:Record<string,string> = { PAYMENT:'收款', REFUND:'退款', WITHDRAWAL:'提现' };
const paymentMethods:Record<string,string> = { ALIPAY_NATIVE:'支付宝', WEIXIN_NATIVE:'微信支付' };
const states:Record<string,string> = { SUBMITTING:'提交中', UNKNOWN:'结果待核', ACTION_READY:'等待付款', PROCESSING_UNCONFIRMED:'处理中', REJECTED_BY_CHANNEL:'渠道拒绝', CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE:'渠道成功，站内待确认', ACCEPTED:'站内已接纳', REVIEW_REQUIRED:'待核查', RESERVED:'已预留', PROCESSING:'处理中', SUCCEEDED:'站内已处理', FAILED:'处理失败', READY:'待处理' };
export const financeActivityState = (state:string|null|undefined) => states[state??'']??'状态待核';
const signed = (cents:string|null) => cents !== null && /^\d+$/.test(cents) && BigInt(cents)>0n ? `+${financeMoney(cents)}` : financeMoney(cents);
const requestUserProfile = <T,>(path:string) => adminRequest<T>(path);
const liveTypes:Array<[string,string]> = [['OWNER_INCOME','号主租赁收入'],['COMMISSION_INCOME','分销收入'],['COMMISSION_REVERSAL','分销收益冲回'],['WITHDRAWAL','提现扣除'],['WITHDRAWAL_RETURN','提现退回'],['DEPOSIT_COMPENSATION','押金补偿'],['FULL_PAYOUT_COMPENSATION','包赔赔偿'],['OTHER','其他余额变动']];
const historyTypes:Array<[string,string]> = [['SETTLEMENT','结算收入（号主/分销）'],['WITHDRAWAL','提现扣除'],['WITHDRAWAL_RETURN','提现退回'],['PLATFORM_ADJUSTMENT','平台加扣款'],['DEPOSIT_COMPENSATION','押金补偿'],['TASK_SETTLEMENT','任务结算'],['OTHER','其他 / 未分类']];
const isoDay = (date:Date|undefined) => date ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` : '';
const draftQuery = (value:Draft):Record<string,string> => Object.fromEntries(Object.entries({q:value.q,kind:value.kind,from:value.from,to:value.to,type:value.type,...(value.nonzero?{nonzero:'1'}:{})}).filter(([,item])=>item));

function ActivityDateRange({from,to,onChange}:{from:string;to:string;onChange:(from:string,to:string)=>void}) {
  const seed=():DateSelectorValue=>({period:'day',operator:'between',startDate:from?new Date(`${from}T00:00:00`):undefined,endDate:to?new Date(`${to}T00:00:00`):undefined});
  const [open,setOpen]=useState(false), [selection,setSelection]=useState<DateSelectorValue>(seed);
  useEffect(()=>{if(open)setSelection(seed());},[open,from,to]);
  return <Field label="发生日期" className="ud-field finance-activity-date" composite><Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="outline" aria-label="选择发生日期" />}><CalendarDays size={15} aria-hidden/>{from&&to?(from===to?from:`${from} 至 ${to}`):'不限时间'}</PopoverTrigger>
    <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0"><DateSelector value={selection} presetMode="between" allowRange showTwoMonths={false} showInput={false} presets={[{label:'近 7 天',days:7},{label:'近 30 天',days:30},{label:'近 90 天',days:90}]} onChange={next=>{setSelection(next);if(next.startDate&&next.endDate){onChange(isoDay(next.startDate),isoDay(next.endDate));setOpen(false);}}}/><div className="ud-date-actions"><Button type="button" variant="secondary" size="sm" onClick={()=>{setSelection({period:'day',operator:'between'});onChange('','');setOpen(false);}}>清空</Button></div></PopoverContent>
  </Popover></Field>;
}

export function FinanceActivity({ tab, snapshot, onOpenPath, onQueryChange, onRefresh, refreshNonce, subjectUserId, onSubjectView }: { tab:WorkspaceTab; snapshot:Snapshot; onOpenPath:(path:string,title?:string)=>void; onQueryChange:(query:Record<string,string>)=>void; onRefresh:()=>Promise<SessionSnapshot>; refreshNonce:number; subjectUserId?:string; onSubjectView?:(kind:string,query:Record<string,string>)=>void }) {
  const wallet = ['finance-balances','finance-balance-history','finance-balance-opening'].includes(tab.kind);
  const channelHistory = tab.kind === 'finance-record-history';
  const walletView = tab.kind === 'finance-balance-history' ? 'HISTORY' : tab.kind === 'finance-balance-opening' ? 'OPENING' : 'LIVE';
  const initialKind = !wallet && ['PAYMENT','REFUND','WITHDRAWAL'].includes(tab.query.kind ?? '') ? tab.query.kind! : '';
  const typeOptions = walletView==='HISTORY'?historyTypes:liveTypes;
  const initial:Draft = { q:tab.query.q??'', kind:initialKind, from:walletView==='OPENING'?'':tab.query.from??'', to:walletView==='OPENING'?'':tab.query.to??'', type:wallet&&walletView!=='OPENING'&&typeOptions.some(([code])=>code===tab.query.type)?tab.query.type!:'', nonzero:wallet&&walletView==='OPENING'&&tab.query.nonzero==='1' };
  const [draft,setDraft] = useState(initial);
  const [filters,setFilters] = useState<Filters>({ ...initial, page:1, pageSize:20, asOf:'' });
  const [data,setData] = useState<{key:string; result:Result}>(), [error,setError] = useState<unknown>(), [validation,setValidation] = useState(''), [retry,setRetry] = useState(0);
  const active = snapshot.security.status === 'ACTIVE' && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const complete = snapshot.permissions.includes('finance.read');
  const allowed = active && (subjectUserId ? complete && (snapshot.security.isBoss || snapshot.permissions.includes('user.directory.read')) : complete || !wallet && snapshot.permissions.includes('finance.document.read'));
  const needsExact = !wallet && !complete && !filters.q.trim();
  const identity = [snapshot.adminUserId,snapshot.session.id,active,snapshot.security.isBoss,...snapshot.permissions.slice().sort()].join('|');
  const key = JSON.stringify([identity,subjectUserId,wallet,walletView,channelHistory,filters,refreshNonce,retry]);
  const body = data?.key === key ? data.result : undefined;

  useEffect(()=>{
    const controller = new AbortController(); setData(undefined); setError(undefined);
    if (!allowed || needsExact) return () => controller.abort();
    const params = new URLSearchParams({ page:String(filters.page),pageSize:String(filters.pageSize), ...draftQuery(filters), ...(wallet?{view:walletView}:{source:channelHistory?'LEGACY':'NATIVE'}), ...(subjectUserId?{subjectUserId}:{}), ...(filters.asOf?{asOf:filters.asOf}:{}) });
    void adminRequest<Result>(`/finance/activity/${wallet?'balances':'channels'}?${params}`,undefined,'GET',{},controller.signal).then(result=>{
      if (!controller.signal.aborted) setData({ key,result });
    }).catch(cause=>{
      if (controller.signal.aborted) return;
      setError(cause);
      if (cause instanceof AdminApiError && [401,403,423].includes(cause.status)) void onRefresh().catch(()=>undefined);
    });
    return () => controller.abort();
  },[key,allowed,needsExact]);

  const apply = () => {
    if (findPhoneClue(draft.q)) { setValidation('手机号请先通过用户管理的授权查找定位，再使用用户 ID 查询。'); return; }
    if (Boolean(draft.from)!==Boolean(draft.to) || draft.from&&draft.to&&draft.from>draft.to) { setValidation('请选择完整且有效的日期范围。'); return; }
    setValidation(''); setFilters({...draft,page:1,pageSize:filters.pageSize,asOf:''}); onQueryChange(draftQuery(draft)); setRetry(value=>value+1);
  };
  const reset = () => { const clear:Draft={q:'',kind:'',from:'',to:'',type:'',nonzero:false};setDraft(clear); setValidation(''); setFilters({...clear,page:1,pageSize:filters.pageSize,asOf:''}); onQueryChange({}); setRetry(value=>value+1); };
  const clearDates = () => { const next={...filters,from:'',to:'',page:1,asOf:''};setDraft(next);setFilters(next);setValidation('');onQueryChange(draftQuery(next)); };
  const toggleNonzero = () => { const nonzero=!filters.nonzero;setDraft(value=>({...value,nonzero}));setFilters(value=>({...value,nonzero,page:1,asOf:''}));onQueryChange(draftQuery({...filters,nonzero})); };
  const loading = allowed && !needsExact && !body && !error;
  const canOpenDocument = snapshot.permissions.includes('finance.document.read');
  const canOpenUser = snapshot.security.isBoss || snapshot.permissions.includes('user.directory.read');
  const returnQuery = new URLSearchParams(draftQuery(filters)).toString();
  const returnPath = subjectUserId ? `${tab.path}?${new URLSearchParams({...draftQuery(filters),...(!filters.from&&!filters.to?{range:'all'}:{}),financeView:tab.kind})}` : `${channelHistory?'/finance/records/history':'/finance/records'}${returnQuery?`?${returnQuery}`:''}`;
  const navigateView=(kind:string,path:string,title:string)=>onSubjectView?onSubjectView(kind,draftQuery(filters)):onOpenPath(path,title);
  const roleLabels:Record<string,string>={RENTER:'租客',OWNER:'号主',WITHDRAWER:'本人提现',RELATED_USER:'本人关联'};
  const title = !wallet?(channelHistory?'旧平台资金记录':'资金记录'):walletView==='HISTORY'?'旧平台余额记录':walletView==='OPENING'?'迁移期初':subjectUserId?'余额变动':'用户余额';
  const description = !wallet?(channelHistory?'查看旧平台收款、退款和提现的历史记录。':'查看新平台收款、退款和提现记录；模拟操作会单独标识。'):walletView==='HISTORY'?'查看迁移前旧平台记录的余额变动。':walletView==='OPENING'?'查看用户迁移时承接的可用余额。':'查看新平台产生的可用余额变动。';
  const userCell = (row:Row) => {
    const openUser=()=>onOpenPath(`/users/${encodeURIComponent(row.subjectId)}`,row.subjectName);
    return <EntityPreviewTrigger touchLabel={`预览用户 ${row.subjectName}`} trigger={canOpenUser?<Button variant="link" className="h-auto p-0 text-left" onClick={openUser}>{row.subjectName}</Button>:<span>{row.subjectName}</span>} content={<UserProfilePreview userId={row.subjectId} name={row.subjectName} request={requestUserProfile} onOpenProfile={canOpenUser?openUser:undefined}/>}/>;
  };
  return <section className={subjectUserId?'finance-activity finance-activity-subject':'finance-page finance-activity'} aria-labelledby="finance-activity-title">
    <header className="finance-page-header"><div>{subjectUserId?<h2 id="finance-activity-title">{title}</h2>:<h1 id="finance-activity-title">{title}</h1>}<p className="finance-secondary">{description}</p></div>
      <div className="finance-page-actions">{!wallet?(channelHistory?<Button variant="outline" size="sm" onClick={()=>navigateView('finance-records','/finance/records','资金记录')}>返回资金记录</Button>:<Button variant="outline" size="sm" onClick={()=>navigateView('finance-record-history','/finance/records/history','旧平台资金记录')}>查看旧平台记录</Button>):null}
        {wallet&&walletView!=='LIVE'?<Button variant="outline" size="sm" onClick={()=>navigateView('finance-balances','/finance/balances','用户余额')}>返回余额变动</Button>:null}
        {wallet&&walletView!=='HISTORY'?<Button variant="outline" size="sm" onClick={()=>navigateView('finance-balance-history','/finance/balances/history','旧平台余额记录')}>查看旧平台记录</Button>:null}
        {wallet&&walletView!=='OPENING'&&!subjectUserId?<Button variant="outline" size="sm" onClick={()=>navigateView('finance-balance-opening','/finance/balances/opening','迁移期初')}>查看迁移期初</Button>:null}
        <Button variant="outline" size="sm" onClick={()=>{setFilters(value=>({...value,page:1,asOf:''}));setRetry(value=>value+1);}} disabled={!allowed}><RefreshCw size={14} aria-hidden/>刷新</Button></div></header>
    {!allowed ? <Alert variant="warning"><AlertTitle>当前身份没有完整资金读取权限</AlertTitle><AlertDescription>请联系管理员配置资金读取权限。</AlertDescription></Alert> : <>
      {subjectUserId&&walletView==='OPENING'?<p className="finance-activity-note">期初余额是迁移时承接的新账起点，不是一笔新收入。</p>:<ListToolbar onSubmit={apply} onReset={reset} className="finance-activity-toolbar">
        <div className={`finance-activity-controls${wallet&&walletView==='OPENING'?' finance-activity-controls-opening':''}`}>
          {!(subjectUserId&&walletView==='OPENING')?<div className="finance-activity-search"><span>查找</span><ListToolbarSearch value={draft.q} onChange={q=>setDraft(value=>({...value,q}))} placeholder={subjectUserId?'订单号或记录编号':!complete?'请输入完整资金单号':walletView==='OPENING'?'用户 ID 或昵称':'订单号、记录编号、用户 ID 或昵称'} ariaLabel={wallet?'查找用户余额':'查找资金记录'} /></div>:null}
          {!wallet?<ListToolbarEnumSelect label="业务" value={draft.kind} onChange={kind=>setDraft(value=>({...value,kind}))} allLabel="全部业务" options={[["PAYMENT","收款"],["REFUND","退款"],["WITHDRAWAL","提现"]]}/>:null}
          {wallet&&walletView!=='OPENING'?<ListToolbarEnumSelect label="变动类型" value={draft.type} onChange={type=>setDraft(value=>({...value,type}))} allLabel="全部类型" options={typeOptions}/>:null}
          {walletView!=='OPENING'?<ActivityDateRange from={draft.from} to={draft.to} onChange={(from,to)=>setDraft(value=>({...value,from,to}))}/>:null}
          {wallet&&walletView==='OPENING'&&!subjectUserId?<Button type="button" variant={filters.nonzero?'default':'outline'} aria-pressed={filters.nonzero} onClick={toggleNonzero}>仅看非零余额</Button>:null}
          {!(subjectUserId&&walletView==='OPENING')?<ListToolbarActions><Button type="submit">查询</Button><Button type="reset" variant="outline">重置</Button></ListToolbarActions>:null}
        </div>
        <p className="finance-activity-note">{!wallet?(channelHistory?'旧平台状态为原系统记录，不代表已核实渠道到账。':'汇聚提交不代表渠道已收到或到账；模拟记录不会发起真实支付。'):walletView==='HISTORY'?'旧平台余额记录仅供追溯，不重复计入当前余额；类型筛选按旧站原始类别，具体用途按已核实来源显示。':walletView==='OPENING'?'期初余额是迁移时承接的新账起点，不是一笔新收入。':'仅显示新平台已入账的可用余额变动。'}{subjectUserId&&!wallet?' 收退款包含有权查看的关联订单，提现仅包含本人。':''}{walletView!=='OPENING'?' 日期按北京时间。':''}</p>
      </ListToolbar>}
      {validation?<p role="alert" className="text-sm text-destructive">{validation}</p>:null}
      <div className="finance-activity-heading"><h2>{!wallet?(channelHistory?'历史资金记录':'收款、退款与提现记录'):walletView==='HISTORY'?'历史余额变动':walletView==='OPENING'?'迁移快照':'余额变动记录'}</h2>{body?<span>记录范围截至 {financeTime(body.asOf)}</span>:null}</div>
      {needsExact?<div className="finance-empty"><h2>输入完整资金单号查询</h2><p>当前权限支持按单号精确查找，用户余额及完整列表需要资金读取权限。</p></div>:null}
      {error?<Alert variant="warning" role="alert"><AlertTitle>记录暂时无法读取</AlertTitle><AlertDescription>{friendlyError(error)} <Button variant="link" onClick={()=>setRetry(value=>value+1)}>重试</Button></AlertDescription></Alert>:null}
      {loading?<div role="status" aria-busy="true" className="space-y-3"><span className="sr-only">正在读取记录</span>{[0,1,2,3].map(i=><Skeleton key={i} className="h-16 w-full"/>)}</div>:body&&subjectUserId&&walletView==='OPENING'&&body.total<=1?body.total===1&&body.items.length===1?<dl className="finance-opening-snapshot"><div><dt>迁移期初余额</dt><dd>{financeMoney(body.items[0]!.amountCents)}</dd></div><div><dt>快照时间</dt><dd>{financeTime(body.items[0]!.occurredAt)}</dd></div></dl>:body.total===0&&body.items.length===0?<div className="finance-empty"><h2>没有迁移期初记录</h2><p>该用户没有已记录的迁移期初。</p></div>:<Alert variant="warning"><AlertTitle>期初记录暂时无法读取</AlertTitle><AlertDescription>请刷新后重试；无法读取时不会按零余额处理。</AlertDescription></Alert>:body?<>
        <ListTable tabIndex={0} role="region" aria-label={wallet?'用户余额记录表格':'资金记录表格'} empty={body.items.length===0?<div className="finance-empty"><h2>没有匹配的记录</h2><p>{subjectUserId?(walletView==='OPENING'?'该用户没有已记录的迁移期初。':'可调整日期或类型，也可查看其他记录。'):walletView==='LIVE'&&wallet?'新平台产生余额变动后会显示在这里。':wallet?'可按用户 ID 或昵称重新查询。':channelHistory?'可调整业务类型或日期，或按用户、单号重新查询。':'新平台产生汇聚请求后会显示在这里，也可调整查询条件。'}</p>{subjectUserId&&(filters.from||filters.to)?<Button variant="link" onClick={clearDates}>查看全部时间</Button>:null}</div>:undefined}>
          {wallet?<Table className={walletView==='OPENING'?'finance-opening-table':'finance-wallet-table'}><TableHeader><TableRow><TableHead>{subjectUserId?(walletView==='OPENING'?'快照时间':'时间'):'用户'}</TableHead>{walletView!=='OPENING'?<TableHead>变动类型</TableHead>:null}<TableHead className="text-right">{walletView==='OPENING'?'期初余额':'变动金额'}</TableHead>{walletView==='HISTORY'?<TableHead className="text-right">旧站记录余额</TableHead>:null}{!subjectUserId?<TableHead>{walletView==='OPENING'?'快照时间':'时间'}</TableHead>:walletView!=='OPENING'?<TableHead className="text-right">关联业务</TableHead>:null}</TableRow></TableHeader>
            <TableBody>{body.items.map(row=><TableRow key={row.id}><TableCell>{subjectUserId?financeTime(row.occurredAt):userCell(row)}</TableCell>{walletView!=='OPENING'?<TableCell>{row.label}{row.dataOrigin?<Badge className="ml-2" variant={['LOCAL_DEMO_SIMULATED','ECS_TEST_SIMULATED'].includes(row.dataOrigin)&&row.bankArrival==='UNKNOWN'?'secondary':'unknown'}>{['LOCAL_DEMO_SIMULATED','ECS_TEST_SIMULATED'].includes(row.dataOrigin)&&row.bankArrival==='UNKNOWN'?'模拟':'来源待核'}</Badge>:null}</TableCell>:null}<TableCell className="text-right tabular-nums font-medium">{walletView==='OPENING'?financeMoney(row.amountCents):signed(row.amountCents)}</TableCell>{walletView==='HISTORY'?<TableCell className="text-right tabular-nums">{financeMoney(row.balanceAfterCents)}</TableCell>:null}{!subjectUserId?<TableCell>{financeTime(row.occurredAt)}</TableCell>:walletView!=='OPENING'?<TableCell className="text-right">{canOpenDocument&&row.documentRef?<Button variant="ghost" size="sm" onClick={()=>onOpenPath(`/finance/documents/${encodeURIComponent(row.documentRef!)}?financeReturn=${encodeURIComponent(returnPath)}`,'关联记录')}>查看关联</Button>:<span className="text-muted-foreground">—</span>}</TableCell>:null}</TableRow>)}</TableBody></Table>
          :<Table className="finance-channel-table"><TableHeader><TableRow><TableHead>业务与编号</TableHead><TableHead>{subjectUserId?'用户身份':'用户'}</TableHead><TableHead>{channelHistory?'旧平台状态':'当前业务状态'}</TableHead><TableHead className="text-right">{channelHistory?'原记录金额':'提交金额'}</TableHead><TableHead>时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>{body.items.map(row=>{const simulated=!channelHistory&&['ECS_TEST_SIMULATED','LOCAL_DEMO_SIMULATED'].includes(row.dataOrigin??'');return <TableRow key={row.id}><TableCell><div className="font-medium">{simulated?`模拟${kinds[row.kind??'']??'资金操作'}`:kinds[row.kind??'']??'资金记录'}</div><small className="block">{row.number ? `${channelHistory?'旧平台编号':simulated?'模拟编号':'业务单号'} ${row.number}` : '编号未记录'}</small>{!channelHistory&&row.relatedNumber&&row.relatedNumber!==row.number?<small className="block">{row.relatedNumberLabel} {row.relatedNumber}</small>:null}{!channelHistory&&row.method?<small className="block">{paymentMethods[row.method]??'支付方式未记录'}</small>:null}</TableCell><TableCell>{subjectUserId?roleLabels[row.subjectRole??'']??'关联待核':userCell(row)}</TableCell><TableCell>{channelHistory?row.state:simulated?(row.state==='SIMULATED'&&row.bankArrival==='UNKNOWN'?'模拟成功':'模拟结果待核'):financeActivityState(row.state)}</TableCell><TableCell className="text-right tabular-nums font-medium">{financeMoney(row.amountCents)}<small className="block font-normal">{row.amountLabel}</small>{!channelHistory&&row.grossCents!=null?<small className="block font-normal">申请 {financeMoney(row.grossCents)} · 手续费 {financeMoney(row.feeCents)}</small>:null}</TableCell><TableCell>{financeTime(row.occurredAt)}</TableCell><TableCell className="text-right">{simulated&&!row.documentRef?<span className="text-muted-foreground">—</span>:<Button variant="outline" size="sm" disabled={!canOpenDocument||!row.documentRef} title={!canOpenDocument?'需要资金单据读取权限':undefined} onClick={()=>row.documentRef&&onOpenPath(`/finance/documents/${encodeURIComponent(row.documentRef)}?financeReturn=${encodeURIComponent(returnPath)}`,'资金详情')}>查看</Button>}</TableCell></TableRow>})}</TableBody></Table>}
        </ListTable>
        <ListPagination mode="page" page={filters.page} pageSize={filters.pageSize} total={body.total} loadedCount={body.items.length} loading={false} pageSizeOptions={[20,50,100]} itemLabel="条记录" onPageChange={page=>setFilters(value=>({...value,page,asOf:body.asOf}))} onPageSizeChange={pageSize=>setFilters(value=>({...value,page:1,pageSize,asOf:''}))}/>
      </>:null}
    </>}
  </section>;
}
