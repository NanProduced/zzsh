import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, ArrowUpRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { ListTable, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/admin-list/list-table';
import { ListPagination } from '@/components/admin-list/list-pagination';
import { restoreTabs, tabHref, tabFromLocation, type WorkspaceTab } from '@/workspace/tab-model';
import { AdminApiError } from '../../api';
import { PERMISSION, STATUS_LABEL, type Order, type Resource, type Audit, type User } from './user-directory-data';
import { Denied, Identity, IdentityStatus, Status, RegistrationCell, MembershipSummaryCell, CreditSummaryCell, Message, errorText, time, TIER_LABEL, SOURCE_STATE_LABEL, useDirectoryRequest, type PageProps, type UserDirectoryData } from './user-directory-shared';
import { CreditPanel } from './credit-panel';
import { SensitiveIdentity, UserNotes, UserRiskAction } from './user-detail-actions';
import { UserDetailFinance } from './user-detail-finance';
import { financeMoney } from '../admin-finance-api';
import './user-detail.css';

const SECTIONS: Record<string,string> = {overview:'概览',orders:'订单记录',resources:'当前上架账号',growth:'会员与礼遇',credit:'信用',finance:'资金',security:'账号安全'};
const ORDER_STATES: Record<string,string> = {current:'进行中',PENDING_PAYMENT:'待付款',PAID:'已付款',COMPLETED:'已完成',CANCELLED:'已取消'};
const auditLabels:Record<string,string> = {'user.account.restored':'恢复账号','user.account.deactivated':'停用账号','user.account.cancelled':'注销账号','user.identity.verification':'实名验证','user.legacy_owner.migrated':'旧平台迁入','user.note.create':'添加备注','user.note.delete':'删除备注','user.risk.flag.changed':'修改高危标记','user.identity.sensitive.read':'查看敏感资料'};

function DetailLoading() { return <div className="udv-skeleton" aria-busy="true" role="status" aria-label="正在读取用户信息"><Skeleton className="h-16 w-80"/><Skeleton className="h-24 w-full"/><Skeleton className="h-10 w-full"/><Skeleton className="h-64 w-full"/></div>; }

function UserCollection({adapter,user,domain,filters={},refreshNonce,preview=false,children}:{adapter:UserDirectoryData;user:User;domain:'orders'|'resources'|'audit';filters?:Record<string,string>;refreshNonce:number;preview?:boolean;children:(data:any[])=>ReactNode}) {
  const [size,setSize]=useState(preview?5:20);
  const signature=JSON.stringify([user.id,domain,filters,size,refreshNonce]);
  const [paging,setPaging]=useState<{key:string;cursors:(string|undefined)[];index:number}>({key:signature,cursors:[undefined],index:0});
  const page=paging.key===signature?paging:{key:signature,cursors:[undefined],index:0};
  const cursor=page.cursors[page.index];
  const {result,retry}=useDirectoryRequest(`${signature}:${cursor??''}`,signal=>adapter.section(user.id,domain,signal,cursor,{...filters,limit:String(size)}));
  if(result.state==='loading')return <DetailLoading/>;
  if(result.state==='error'){const rejected=result.error instanceof AdminApiError&&result.error.status===400;return <Message kind="error" title={rejected?'筛选条件不可用':'记录读取失败'} retry={rejected?undefined:retry}>{rejected?`当前筛选条件（${[filters.role==='renter'?'租客':filters.role==='owner'?'号主':'',ORDER_STATES[filters.status??'']].filter(Boolean).join('、')||'所选条件'}）未被接受，请调整后查询。`:errorText(result.error)}</Message>;}
  if(result.data.state==='denied')return <Denied permission={result.data.permission}/>;
  const data=result.data.data;
  return <>{children(data)}{!preview ? <ListPagination mode="cursor" pageSize={size} loadedCount={data.length} loading={false} pageSizeOptions={[10,20,50]} itemLabel="条记录" hasPrevious={page.index>0} hasNext={!!result.data.nextCursor} onPageSizeChange={value=>setSize(value)} onPrevious={()=>setPaging({...page,index:page.index-1})} onNext={()=>setPaging({key:signature,cursors:[...page.cursors.slice(0,page.index+1),result.data.state==='ready'?result.data.nextCursor??undefined:undefined],index:page.index+1})}/> : null}</>;
}

function Orders({adapter,user,tab,refreshNonce,onOpenPath,onQueryChange,preview=false}:{adapter:UserDirectoryData;user:User;tab:WorkspaceTab;refreshNonce:number;onOpenPath:PageProps['onOpenPath'];onQueryChange:PageProps['onQueryChange'];preview?:boolean}) {
  const role=preview?'':tab.query.role??'',status=preview?'':tab.query.status??'';
  return <section className="udv-block"><div className="udv-heading"><h2>{preview?'最近订单':'订单记录'}</h2>{preview?<Button variant="link" onClick={()=>onQueryChange({section:'orders'})}>查看订单记录<ArrowUpRightIcon size={14}/></Button>:<span className="udv-muted">按下单时间从新到旧</span>}</div>
    {!preview?<div className="udv-filters"><Field label="本单身份" composite><Select items={{ALL:'全部',renter:'租客',owner:'号主'}} value={role||'ALL'} onValueChange={value=>onQueryChange({section:'orders',role:value&&value!=='ALL'?String(value):'',...(status?{status}:{})})}><SelectTrigger aria-label="本单身份"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="ALL">全部</SelectItem><SelectItem value="renter">租客</SelectItem><SelectItem value="owner">号主</SelectItem></SelectContent></Select></Field><Field label="订单状态" composite><Select items={{ALL:'全部',...ORDER_STATES}} value={status||'ALL'} onValueChange={value=>onQueryChange({section:'orders',...(role?{role}:{}),status:value&&value!=='ALL'?String(value):''})}><SelectTrigger aria-label="订单状态"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="ALL">全部</SelectItem>{Object.entries(ORDER_STATES).map(([key,label])=><SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select></Field></div>:null}
    <UserCollection adapter={adapter} user={user} domain="orders" filters={{...(role?{role}:{}),...(status?{status}:{})}} refreshNonce={refreshNonce} preview={preview}>{rows=><ListTable empty={!rows.length ? "暂无符合条件的订单" : undefined}><Table><TableHeader><TableRow><TableHead>订单 / 下单时间</TableHead><TableHead>资源账号</TableHead><TableHead>本单身份 / 交易另一方</TableHead><TableHead>状态</TableHead><TableHead className="text-right">本单应付</TableHead></TableRow></TableHeader><TableBody>{(rows as Order[]).map(order=><TableRow key={order.orderId} data-order-id={order.orderId}><TableCell><Button variant="link" className="udv-link" onClick={()=>onOpenPath(`/orders/${order.orderId}`,order.displayNo)}>{order.displayNo}<ArrowUpRightIcon size={13}/></Button><small>{time(order.createdAt)}</small>{order.source?.origin==='LEGACY'?<small>旧平台订单</small>:null}</TableCell><TableCell>{order.accountId?<Button variant="link" className="udv-link" onClick={()=>onOpenPath(`/supply/accounts/${order.accountId}`,`账号 ${order.accountDisplayNo??''}`)}>{order.accountDisplayNo??'查看账号'}</Button>:<span>{order.accountDisplayNo===null?'账号信息受限':order.accountDisplayNo?.trim()?(/^\d+$/.test(order.accountDisplayNo)?'旧来源号 '+order.accountDisplayNo:order.accountDisplayNo):'账号编号待核'}</span>}</TableCell><TableCell><Badge variant="outline">{order.role==='renter'?'租客':'号主'}</Badge><small>{order.counterpartyUserId?<Button variant="link" className="udv-link" onClick={()=>onOpenPath(`/users/${order.counterpartyUserId}?fromOrderId=${order.orderId}`,order.counterpartyName)}>{order.counterpartyName||'昵称未设置'}<ArrowUpRightIcon size={13}/></Button>:order.counterpartyName||'昵称未设置'}</small></TableCell><TableCell><Badge variant={order.status==='PAID'?'success':order.status==='PENDING_PAYMENT'?'warning':'outline'}>{ORDER_STATES[order.status]??'状态待核'}</Badge>{order.payment?.state==='RECORDED_PAID'?<small>支付已记录</small>:null}{order.status==='CANCELLED'&&order.paidAt?<small>付款后取消 · {time(order.paidAt)}</small>:null}{['PAID','COMPLETED'].includes(order.status)&&!order.paidAt?<small>支付时间待确认</small>:null}{order.cancelReason?<small>{order.cancelReason}{order.cancelledAt?' · '+time(order.cancelledAt):''}</small>:null}</TableCell><TableCell className="text-right tabular-nums">{order.amounts.totalDue?`${order.amounts.totalDue.amount} 元`:'待核'}<small>资源 {order.amounts.rental?.amount??'待核'} · 押金 {order.amounts.deposit?.amount??'待核'}</small></TableCell></TableRow>)}</TableBody></Table></ListTable>}</UserCollection>
  </section>;
}

function Resources({adapter,user,refreshNonce,onOpenPath}:{adapter:UserDirectoryData;user:User;refreshNonce:number;onOpenPath:PageProps['onOpenPath']}) {
  return <section className="udv-block"><div className="udv-heading"><h2>当前上架账号</h2><span className="udv-muted">已发布账号，暂停或占用仍保留上架记录</span></div><UserCollection adapter={adapter} user={user} domain="resources" filters={{publication:'published'}} refreshNonce={refreshNonce}>{rows=><ListTable empty={!rows.length ? "当前没有上架账号" : undefined}><Table><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>游戏</TableHead><TableHead>当前状态</TableHead><TableHead>上架记录</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{(rows as Resource[]).map(account=><TableRow key={account.accountId}><TableCell><Button variant="link" className="udv-link" onClick={()=>onOpenPath(`/supply/accounts/${account.accountId}`,`账号 ${account.displayNo??''}`)}>{account.displayNo??'账号编号待核'}<ArrowUpRightIcon size={13}/></Button></TableCell><TableCell>{account.game.name}</TableCell><TableCell><div className="udv-tags">{account.staffRestricted?<Badge variant="destructive">运营限制</Badge>:null}{account.ownerPaused?<Badge variant="warning">号主暂停</Badge>:null}{account.legacyHold!=='NONE'?<Badge variant="warning">历史占用待核</Badge>:null}{!account.staffRestricted&&!account.ownerPaused&&account.legacyHold==='NONE'?<Badge variant="success">正常</Badge>:null}</div></TableCell><TableCell>{account.publication.currentlyPublished===true?'已上架':account.publication.currentlyPublished===false?'当前未上架':'上架状态待核'}</TableCell><TableCell>{adapter.has('supply.review.read')?<Button variant="outline" size="sm" onClick={()=>onOpenPath(`/supply/reviews/${account.accountId}`,`处理账号 ${account.displayNo??''}`)}>处理账号</Button>:<Button variant="outline" size="sm" onClick={()=>onOpenPath(`/supply/accounts/${account.accountId}`)}>查看详情</Button>}</TableCell></TableRow>)}</TableBody></Table></ListTable>}</UserCollection></section>;
}

function Membership({adapter,user,refreshNonce,onOpenPath}:{adapter:UserDirectoryData;user:User;refreshNonce:number;onOpenPath:PageProps['onOpenPath']}) {
  const {result,retry}=useDirectoryRequest(`${user.id}:growth:${refreshNonce}`,signal=>adapter.membershipGrowth(user.id,signal));
  if(!adapter.has(PERMISSION.growthSummary)&&!adapter.has(PERMISSION.growthDetail)&&!adapter.snapshot.security.isBoss)return <Denied permission={PERMISSION.growthSummary}/>;
  if(result.state==='loading')return <DetailLoading/>;
  if(result.state==='error')return <Message kind="error" title="会员资料读取失败" retry={retry}>{errorText(result.error)}</Message>;
  const data=result.data,growth=data.growth,hasSummary=data.authorizationState!=='DETAIL_ONLY';
  const canHandle=['membership.entitlement.request','membership.entitlement.decide','membership.entitlement.execute','membership.policy.draft'].some(code=>adapter.has(code))||adapter.snapshot.security.isBoss;
  return <section className="udv-block"><div className="udv-heading"><h2>会员与礼遇</h2>{canHandle?<Button variant="outline" onClick={()=>onOpenPath(`/membership-growth?${new URLSearchParams({userId:user.id,fromUserId:user.id,fromUserSection:'growth'})}`)}>办理此用户礼遇<ArrowUpRightIcon size={14}/></Button>:null}</div>
    {hasSummary?<dl className="udv-facts"><div><dt>当前等级</dt><dd>{growth?.knowledge==='KNOWN'&&growth.effectiveTier?TIER_LABEL[growth.effectiveTier]??'等级待核':'等级待核'}</dd></div><div><dt>滚动积分</dt><dd>{growth?.rollingPoints??'待核'}</dd></div><div><dt>累计贡献</dt><dd>{growth?.lifetimePoints??'待核'}</dd></div>{growth?.grace&&growth.grace.state!=='NONE'?<div><dt>保级截止</dt><dd>{time(growth.grace.until)}</dd></div>:null}</dl>:<Message title="等级与礼遇读取受限">当前权限只允许查看贡献明细。</Message>}
    <Collapsible><CollapsibleTrigger render={<Button variant="ghost"/>}>查看成长说明</CollapsibleTrigger><CollapsibleContent><dl className="udv-facts"><div><dt>成长资料</dt><dd>{growth?.sourceState?SOURCE_STATE_LABEL[growth.sourceState]??'资料待核':'资料待核'}</dd></div>{data.sourceSummary?<div><dt>贡献来源</dt><dd>来源记录 {data.sourceSummary.contributionCount} 条</dd></div>:null}<div><dt>黑金资格</dt><dd>{growth?.blackGold==='QUALIFIED'?'已具备资格':growth?.blackGold==='NOT_QUALIFIED'?'未具备资格':growth?.blackGold==='REVIEW_REQUIRED'?'待人工复核':'待核'}</dd></div><div><dt>会员权益</dt><dd>{growth?.benefitsState==='CONFIGURED'?'已配置生效':growth?.benefitsState==='NOT_CONFIGURED'?'尚未配置':'待核'}</dd></div>{growth?.grace&&growth.grace.state!=='NONE'?<div><dt>保级差额</dt><dd>{growth.grace.gapPoints==null?'待核':growth.grace.gapPoints+' 积分'}</dd></div>:null}</dl></CollapsibleContent></Collapsible>
    <h3>礼遇记录</h3>{!Array.isArray(data.entitlements)?<p className="udv-muted">礼遇资料暂不可用</p>:<ListTable empty={!data.entitlements.length ? "暂无礼遇记录" : undefined}><Table><TableHeader><TableRow><TableHead>礼遇</TableHead><TableHead>权益</TableHead><TableHead>有效期</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{data.entitlements.map(item=><TableRow key={item.id}><TableCell>{item.kind==='PRESTIGE'?'尊享礼遇':'挚友礼遇'}<small>{item.label}</small></TableCell><TableCell>{item.depositWaived?'免押金':'按规则缴纳押金'}</TableCell><TableCell>{time(item.startsAtUtc)}<small>至 {time(item.endsAtUtc)}</small></TableCell><TableCell><Badge variant={item.status==='ACTIVE'?'success':'outline'}>{{ACTIVE:'有效',EXPIRED:'已到期',REVOKED:'已撤销',REPLACED:'已替换',PENDING:'待审批',APPROVED_PENDING_EXECUTION:'已批准待执行',EXECUTED_PENDING_START:'待生效'}[item.status]??'状态待核'}</Badge></TableCell></TableRow>)}</TableBody></Table></ListTable>}
  </section>;
}

export function UserDetail({adapter,snapshot,tab,onOpenPath,onQueryChange,refreshNonce}:PageProps&{adapter:UserDirectoryData}) {
  const id=tab.objectId!,section=tab.query.section&&tab.query.section in SECTIONS?tab.query.section:'overview';
  const [revision,setRevision]=useState(0);
  const sectionRefresh=useRef<Record<string,number>>({});
  sectionRefresh.current[section]=refreshNonce;
  const changed=()=>setRevision(value=>value+1);
  const {result,retry}=useDirectoryRequest(`${id}:${refreshNonce}:${revision}`,signal=>adapter.detail(id,signal));
  const [visited,setVisited]=useState(new Set([section]));
  useEffect(()=>setVisited(current=>new Set([...current,section])),[section]);
  const back=()=>{const existing=restoreTabs(snapshot.adminUserId,{isBoss:snapshot.security.isBoss,permissions:snapshot.permissions})?.tabs.find(item=>item.id==='users');onOpenPath(tabHref(existing??tabFromLocation('/users')));};
  const cached=useRef<{id:string;user:User}|null>(null);
  if(cached.current?.id!==id)cached.current=null;
  if(result.state==='ready')cached.current={id,user:result.data};
  if(result.state==='error'&&result.error instanceof AdminApiError&&[401,403,404,423].includes(result.error.status))cached.current=null;
  if(result.state==='loading'&&!cached.current)return <DetailLoading/>;
  if(result.state==='error'&&!cached.current)return <><Button variant="ghost" onClick={back}><ArrowLeftIcon size={16}/>返回列表</Button><Message kind="error" title="用户详情加载失败" retry={retry}>{errorText(result.error)}</Message></>;
  const user=result.state==='ready'?result.data:cached.current!.user,canMoney=adapter.has('user.wallet.read')||adapter.has('user.finance.read')||adapter.has('finance.read')||snapshot.security.isBoss;
  return <section className="ud-detail ud-detail-v2" aria-busy={result.state==='loading'}>
    {result.state==='error'?<Message kind="error" title="详情更新失败，保留当前内容" retry={retry}>{errorText(result.error)}</Message>:null}
    <div className="udv-heading"><Button variant="ghost" onClick={back}><ArrowLeftIcon size={16}/>返回列表</Button><UserRiskAction adapter={adapter} user={user} changed={changed}/></div>
    <header className="udv-user-header"><div><Identity user={user} heading/><div className="udv-tags"><Status user={user}/><IdentityStatus value={user.identityStatus}/><MembershipSummaryCell summary={user.membershipSummary}/><CreditSummaryCell summary={user.creditSummary}/></div><p className="udv-muted">注册于 <RegistrationCell user={user} includeTime/></p></div>{canMoney?<div className="udv-wallet"><span>可用余额</span><strong>{user.walletSummary?.state==='ready'?financeMoney(user.walletSummary.amountCents):user.walletSummary?.state==='denied'?'无查看权限':'待核'}</strong><Button variant="link" onClick={()=>onQueryChange({section:'finance'})}>查看资金<ArrowUpRightIcon size={13}/></Button></div>:null}</header>
    <SensitiveIdentity adapter={adapter} user={user} active={section==='overview'}/>
    <div className="udv-business">{user.orders.state==='ready'&&adapter.has(PERMISSION.orders)?<><Button variant="ghost" onClick={()=>onQueryChange({section:'orders',role:'renter',status:'current'})}>租入 <strong>{user.orders.renterCurrent??'待核'}</strong></Button><Button variant="ghost" onClick={()=>onQueryChange({section:'orders',role:'owner',status:'current'})}>出租 <strong>{user.orders.ownerCurrent??'待核'}</strong></Button></>:null}{user.resources.state==='ready'&&adapter.has(PERMISSION.resources)?<Button variant="ghost" onClick={()=>onQueryChange({section:'resources',publication:'published'})}>上架 <strong>{user.resources.publishedCount??'待核'}</strong></Button>:null}</div>
    <Tabs value={section} onValueChange={value=>onQueryChange({section:String(value),...(value==='resources'?{publication:'published'}:{})})}><TabsList aria-label="用户详情分区">{Object.entries(SECTIONS).map(([key,label])=><TabsTrigger key={key} value={key}>{label}</TabsTrigger>)}</TabsList></Tabs>
    {[...visited].map(view=><div key={view} hidden={view!==section} className="udv-tab" role="region" aria-label={SECTIONS[view]}>
      {view==='overview'?<><Orders adapter={adapter} user={user} tab={tab} refreshNonce={refreshNonce} onOpenPath={onOpenPath} onQueryChange={onQueryChange} preview/><UserNotes adapter={adapter} user={user} refreshNonce={refreshNonce}/></>:view==='orders'?<Orders adapter={adapter} user={user} tab={tab} refreshNonce={refreshNonce} onOpenPath={onOpenPath} onQueryChange={onQueryChange}/>:view==='resources'?<Resources adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='growth'?<Membership adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='credit'?<CreditPanel adapter={adapter} user={user} refreshNonce={refreshNonce} active={view===section} changed={changed}/>:view==='finance'?<UserDetailFinance adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:<>
        <section className="udv-block"><div className="udv-heading"><h2>账号资料</h2><Badge variant="outline">{STATUS_LABEL[user.status]??'状态待核'}</Badge></div><Field label="用户ID"><Input readOnly value={user.id} aria-label="用户ID" onFocus={event=>event.currentTarget.select()}/></Field><dl className="udv-facts"><div><dt>手机号</dt><dd>{user.phoneMasked}</dd></div>{user.legacyId?<div><dt>旧平台ID</dt><dd>{user.legacyId}</dd></div>:null}{user.displayUsername?<div><dt>用户名</dt><dd>{user.displayUsername}</dd></div>:null}{user.emailMasked?<div><dt>邮箱</dt><dd>{user.emailMasked}</dd></div>:null}</dl></section>
        {user.status==='DEACTIVATED'||user.status==='CANCELLED'?<Restore adapter={adapter} user={user} changed={changed}/>:<p className="udv-muted">{user.status==='ACTIVE'?'账号状态正常，当前无需恢复。':'当前账号状态不支持恢复。'}</p>}
        <Collapsible><CollapsibleTrigger render={<Button variant="outline"/>}>查看安全操作记录</CollapsibleTrigger><CollapsibleContent><UserCollection adapter={adapter} user={user} domain="audit" refreshNonce={(sectionRefresh.current[view]??0)+revision}>{rows=><ListTable empty={!rows.length ? "当前授权范围内暂无安全操作记录" : undefined}><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>操作</TableHead><TableHead>管理员</TableHead><TableHead>结果</TableHead></TableRow></TableHeader><TableBody>{(rows as Audit[]).map(event=><TableRow key={event.eventId}><TableCell>{time(event.occurredAt)}</TableCell><TableCell>{auditLabels[event.action]??'其他安全操作'}</TableCell><TableCell>{event.actor.name||'未记录'}</TableCell><TableCell>{event.outcome==='SUCCESS'?'成功':'失败'}</TableCell></TableRow>)}</TableBody></Table></ListTable>}</UserCollection></CollapsibleContent></Collapsible>
      </>}
    </div>)}
  </section>;
}

type RestoreResult = 'success' | 'rejected' | 'conflict' | 'failed' | 'pending' | 'readback-failed';
function Restore({ adapter, user, changed }: { adapter: UserDirectoryData; user: User; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<RestoreResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [read, setRead] = useState<User>();
  const [writeAccepted, setWriteAccepted] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  const clearSecrets = () => { setPassword(''); setCode(''); };
  const current = read ?? user;
  const hasRestoreAccess = adapter.has('user.account.restore');
  const eligible = hasRestoreAccess && !writeAccepted && current.status === 'DEACTIVATED';

  const reread = async () => {
    setBusy(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      const value = await adapter.detail(user.id, request.signal);
      if (request.signal.aborted) return;
      setRead(value);
      if (value.status === 'ACTIVE') {
        setResult('success'); setError(''); changed();
      } else if (writeAccepted) {
        setResult('readback-failed'); setError('恢复请求已被接受，但账号状态仍未显示为正常；不会自动重复提交。');
      }
    } catch (failure) {
      if (!request.signal.aborted) {
        setResult(currentResult => writeAccepted ? 'readback-failed' : currentResult);
        setError(errorText(failure));
      }
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };

  const submit = async () => {
    if (!eligible || result === 'pending' || writeAccepted) return;
    setError(''); setRead(undefined); setBusy(true);
    const request = new AbortController(); controller.current = request;
    try {
      await adapter.restore(user.id, reason, password, code, request.signal);
      if (request.signal.aborted) return;
      setWriteAccepted(true); setResult('success');
      try {
        const value = await adapter.detail(user.id, request.signal);
        if (request.signal.aborted) return;
        setRead(value);
        if (value.status === 'ACTIVE') {
          setResult('success'); setError(''); changed();
        } else {
          setResult('readback-failed'); setError('恢复请求已被接受，但账号状态仍未显示为正常；不会自动重复提交。');
        }
      } catch (readbackFailure) {
        if (!request.signal.aborted) {
          setResult('readback-failed'); setError(errorText(readbackFailure));
        }
      }
    } catch (failure) {
      if (request.signal.aborted) return;
      setResult(
        failure instanceof AdminApiError && failure.status === 0 ? 'pending' :
        failure instanceof AdminApiError && failure.status === 401 ? 'rejected' :
        failure instanceof AdminApiError && failure.status === 409 ? 'conflict' : 'failed'
      );
      setError(errorText(failure));
      try {
        const value = await adapter.detail(user.id, request.signal);
        if (!request.signal.aborted) setRead(value);
      } catch {
        /* The outcome remains unconfirmed when re-read also fails. */
      }
    } finally {
      clearSecrets();
      if (!request.signal.aborted) setBusy(false);
    }
  };

  const labels: Record<RestoreResult, string> = {
    success: '账号恢复已处理',
    rejected: '管理员再认证被拒绝',
    conflict: '账号状态已变化',
    failed: '恢复操作失败',
    pending: '恢复结果待确认',
    'readback-failed': '恢复请求已提交，状态待确认',
  };

  return (
    <div className="ud-restore">
      <h2>账号恢复</h2>
      {!hasRestoreAccess ? (
        <Denied permission="user.account.restore" />
      ) : (
        <>
          <p>
            {writeAccepted ? '恢复请求已被服务端接受；当前状态需要重读确认。' :
             eligible ? '已停用，可进入恢复评估。需操作原因与管理员密码/TOTP再认证。' :
             current.status === 'CANCELLED' ? '已注销账号不可恢复。' : '当前账号状态不符合恢复资格。'}
          </p>
          {writeAccepted ? (
            <Button variant="outline" onClick={() => setOpen(true)}>核对恢复结果</Button>
          ) : eligible ? (
            <Button variant="outline" onClick={() => setOpen(true)}>账号恢复</Button>
          ) : null}
        </>
      )}
      {(result === 'pending' || result === 'readback-failed') && !open ? (
        <Message title={labels[result]}>先核对服务端账号状态；不会自动重试或重复提交。</Message>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={value => {
          if (busy) return;
          setOpen(value);
          if (!value) { clearSecrets(); setReason(''); }
        }}
      >
        <DialogContent className="ud-restore-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>账号恢复评估 · {user.name}</DialogTitle>
            <DialogDescription>
              恢复只改变账号可用状态，不复活旧会话或验证凭据，不覆盖实名与年龄结果。
            </DialogDescription>
          </DialogHeader>
          <form aria-busy={busy} onSubmit={e => { e.preventDefault(); void submit(); }}>
            <Field label="操作原因（3–500字）" className="ud-field">
              <Textarea
                aria-label="操作原因"
                value={reason}
                minLength={3}
                maxLength={500}
                required
                onChange={e => setReason(e.target.value)}
              />
            </Field>
            <Field label="管理员密码" className="ud-field">
              <Input
                type="password"
                aria-label="管理员密码"
                autoComplete="off"
                value={password}
                minLength={12}
                required
                onChange={e => setPassword(e.target.value)}
              />
            </Field>
            <Field label="管理员 TOTP（6位）" className="ud-field">
              <Input
                type="password"
                inputMode="numeric"
                aria-label="管理员 TOTP"
                autoComplete="off"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                required
                onChange={e => setCode(e.target.value)}
              />
            </Field>
            {result ? (
              <Message
                kind={result === 'success' ? 'success' : result === 'pending' || result === 'readback-failed' ? 'info' : 'error'}
                title={labels[result]}
              >
                {read ? `重读账号状态：${STATUS_LABEL[read.status]}。` : '账号状态尚未确认。'}
                {result === 'success' ? '请用户重新登录；旧会话和验证凭据不会复活。' :
                 result === 'readback-failed' ? '恢复写入已成功，但状态回读未完成；不会自动重复提交。' :
                 result === 'pending' ? '未收到确认结果，请重新读取账号状态；不自动重复提交。' : '填写新的再认证信息后由管理员决定是否重试。'}
              </Message>
            ) : null}
            {error && result !== 'pending' && result !== 'readback-failed' ? (
              <Message kind="error" title="操作未完成">{error}</Message>
            ) : null}
            {error && result === 'readback-failed' ? (
              <Message kind="info" title="状态读取提示">{error}</Message>
            ) : null}
            <div className="ud-dialog-actions flex justify-end gap-2 mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => { setOpen(false); clearSecrets(); setReason(''); }}
              >
                关闭
              </Button>
              {result ? (
                <Button type="button" disabled={busy} onClick={() => void reread()}>
                  重新读取账号状态
                </Button>
              ) : null}
              {eligible && result !== 'pending' && result !== 'success' && result !== 'readback-failed' ? (
                <Button
                  type="submit"
                  disabled={busy || reason.trim().length < 3 || password.length < 12 || !/^\d{6}$/.test(code)}
                >
                  {busy ? '处理中…' : '提交恢复'}
                </Button>
              ) : null}
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
