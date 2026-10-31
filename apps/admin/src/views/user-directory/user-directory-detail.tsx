import { StepUpCaptcha } from '../../components/altcha-field';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownLeftIcon, ArrowLeftIcon, ArrowUpRightIcon, ChevronDownIcon, ShieldCheckIcon } from 'lucide-react';
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
import { EntityPreviewTrigger, UserPreviewCard, hasUsefulUserPreview } from '@/components/admin-preview';
import { restoreTabs, tabHref, tabFromLocation, type WorkspaceTab } from '@/workspace/tab-model';
import { AdminApiError } from '../../api';
import { PERMISSION, STATUS_LABEL, type Order, type Resource, type Audit, type User } from './user-directory-data';
import { Denied, Identity, IdentityStatus, Status, RegistrationCell, MembershipSummaryCell, CreditSummaryCell, Message, errorText, time, TIER_LABEL, SOURCE_STATE_LABEL, useDirectoryRequest, type PageProps, type UserDirectoryData } from './user-directory-shared';
import { CreditPanel } from './credit-panel';
import { SensitiveIdentity, UserNotes, UserRiskAction } from './user-detail-actions';
import { UserDetailFinance } from './user-detail-finance';
import { financeMoney } from '../admin-finance-api';
import { financeOriginPath } from '../admin-finance-view';
import { OrderStages } from '../admin-order-stages';
import { historicalResourceText } from '../supply-review/model';
import './user-detail.css';

const SECTIONS: Record<string,string> = {orders:'订单记录',resources:'当前上架账号',growth:'会员与礼遇',credit:'信用',finance:'资金',notes:'内部记录',security:'账号安全'};

function accountResourceSummary(order: Order): string | null {
  const legacyNames: Record<string,string> = {df_billable_haff:'哈夫币',df_billable_awm_bullet:'AWM子弹',df_billable_level6_bullet:'6级子弹',df_billable_level6_helmet:'6级头盔',df_billable_level6_armor:'6级护甲',df_billable_top_insure_card:'顶级保险卡',df_billable_barrett_bullet:'巴雷特子弹',df_billable_coffee:'咖啡豆'};
  // 迁入单账号即账号：有账号资料（与账号页同一版本口径）时优先展示，原单资源仅在账号资料缺失时作为本单事实
  const accountResources = order.accountFacts?.resources ?? [];
  const frozen = accountResources.length ? undefined : order.orderFacts?.resources;
  const legacyOriginal = order.source?.origin === 'LEGACY' && Boolean(frozen?.length);
  const resources=(frozen?.length ? frozen : accountResources).filter(resource=>resource.quantity!==null && !/^0+(?:\.0+)?$/.test(resource.quantity));
  if (!resources.length) return null;
  const label=frozen?.length?'原单资源':order.accountFacts?.source==='ORDER_VERSION'?'下单账号资料':'账号资料';
  const items=resources.slice(0,3).map(resource=>resource.unit==='HAFF_BASE'?historicalResourceText({quantity:resource.quantity,unit:resource.unit,code:resource.code}):`${resource.name??(legacyOriginal?legacyNames[resource.code]:undefined)??'物资名称未提供'} ${resource.unit ? historicalResourceText({quantity:resource.quantity,unit:resource.unit,code:resource.code}) : resource.quantity}`);
  return `${label}：${items.join(' · ')}${resources.length>3?` 另${resources.length-3}项`:''}`;
}

function accountTermSummary(order: Order): string | null {
  const parts: string[] = [];
  const seconds=order.orderFacts?.termSeconds;
  if (seconds && /^[1-9]\d*$/.test(seconds)) {
    const duration=BigInt(seconds);
    parts.push(`租期：${duration%86400n===0n?`${duration/86400n}天`:duration%3600n===0n?`${duration/3600n}小时`:`${duration}秒`}`);
  } else if (order.accountFacts?.termDays) {
    parts.push(`租期：${order.accountFacts.termDays}天`);
  }
  if (order.accountFacts?.loginMethodText) {
    parts.push(`登录：${order.accountFacts.loginMethodText}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** 账号标题：由账号基础信息（哈夫币·安全箱·段位）组成，缺失时用 ZZ 账号编号，迁入账号同样处理 */
function accountTitleText(order: Order): string {
  const facts=order.accountFacts;
  const haff=facts?.resources.find(resource=>resource.unit==='HAFF_BASE');
  const basic=[haff&&haff.quantity!==null?historicalResourceText({quantity:haff.quantity,unit:'HAFF_BASE',code:haff.code}):null,facts?.safeBoxText,facts?.gradingText].filter((value):value is string=>!!value).join(' · ');
  return basic||(order.accountDisplayNo?`账号 ${order.accountDisplayNo}`:'')||order.title||'标题待核';
}
const ORDER_STATES: Record<string,string> = {current:'进行中',PENDING_PAYMENT:'待付款',PAID:'已付款',COMPLETED:'已完成',CANCELLED:'已取消'};
const auditLabels:Record<string,string> = {'user.account.frozen':'冻结账号','user.account.unfrozen':'解冻账号','user.account.restored':'恢复账号（历史）','user.account.deactivated':'停用账号（历史）','user.account.cancelled':'注销账号','user.identity.verification':'实名验证','user.legacy_owner.migrated':'旧平台迁入','user.note.create':'添加备注','user.note.delete':'删除备注','user.risk.flag.changed':'修改高危标记','user.identity.sensitive.read':'查看敏感资料'};

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
  return <section className="udv-block">
    {!preview ? (
      <div className="udv-toolbar">
        <div className="udv-toolbar-filters">
          <div className="udv-filter-group">
            <span className="udv-filter-label">交易方向</span>
            <Select items={{ALL:'全部',renter:'租入',owner:'租出'}} value={role||'ALL'} onValueChange={value=>onQueryChange({section:'orders',role:value&&value!=='ALL'?String(value):'',...(status?{status}:{})})}>
              <SelectTrigger aria-label="交易方向" className="udv-select-trigger"><SelectValue/></SelectTrigger>
              <SelectContent><SelectItem value="ALL">全部</SelectItem><SelectItem value="renter">租入</SelectItem><SelectItem value="owner">租出</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="udv-filter-group">
            <span className="udv-filter-label">订单状态</span>
            <Select items={{ALL:'全部',...ORDER_STATES}} value={status||'ALL'} onValueChange={value=>onQueryChange({section:'orders',...(role?{role}:{}),status:value&&value!=='ALL'?String(value):''})}>
              <SelectTrigger aria-label="订单状态" className="udv-select-trigger"><SelectValue/></SelectTrigger>
              <SelectContent><SelectItem value="ALL">全部</SelectItem>{Object.entries(ORDER_STATES).map(([key,label])=><SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="udv-toolbar-meta">
          <span className="udv-muted">按下单时间从新到旧</span>
        </div>
      </div>
    ) : (
      <div className="udv-heading"><h2>最近订单</h2><Button variant="link" onClick={()=>onQueryChange({section:'orders'})}>查看订单记录<ArrowUpRightIcon size={14}/></Button></div>
    )}
    <UserCollection adapter={adapter} user={user} domain="orders" filters={{...(role?{role}:{}),...(status?{status}:{})}} refreshNonce={refreshNonce} preview={preview}>
      {rows=><ListTable empty={!rows.length ? "暂无符合条件的订单" : undefined}><Table>
        <TableHeader><TableRow><TableHead>交易方向 / 订单</TableHead><TableHead>资源账号</TableHead><TableHead>交易另一方</TableHead><TableHead>订单状态 / 已知事实</TableHead><TableHead className="text-right">本单应付</TableHead></TableRow></TableHeader>
        <TableBody>{(rows as Order[]).map(order=>{
          const openOrder=()=>onOpenPath('/orders/'+encodeURIComponent(order.orderId),order.displayNo);
          const openAccount=()=>onOpenPath('/supply/accounts/'+encodeURIComponent(order.accountId!), '账号 '+(order.accountDisplayNo??''));
          const openCounterparty=()=>onOpenPath('/users/'+encodeURIComponent(order.counterpartyUserId!)+'?fromOrderId='+encodeURIComponent(order.orderId),order.counterpartyName);
          const canAccount=adapter.has(PERMISSION.resources);
          const canDirectory=adapter.has('user.directory.read');
          const summary=canDirectory?order.counterpartySummary:undefined;
          const counterparty=order.counterpartyName||summary?.name||'昵称未设置';
          return <TableRow key={`${order.source?.origin??'NATIVE'}:${order.orderId}`} data-order-id={order.orderId} data-order-origin={order.source?.origin??'NATIVE'}>
            <TableCell>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant={order.role==='renter'?'success':order.role==='owner'?'info':'outline'} className={`udv-direction-badge ${order.role}`}>
                  {order.role === 'renter' ? (
                    <><ArrowDownLeftIcon size={12} aria-hidden="true" /><span>租入</span></>
                  ) : order.role === 'owner' ? (
                    <><ArrowUpRightIcon size={12} aria-hidden="true" /><span>租出</span></>
                  ) : (
                    <span>{order.role ?? '待核'}</span>
                  )}
                </Badge>
                <Button variant="link" className="udv-link font-mono font-medium" onClick={openOrder}>
                  {order.displayNo}
                  <ArrowUpRightIcon size={12} />
                </Button>
              </div>
              <small className="font-mono">{time(order.createdAt)}</small>
              {order.source?.origin === 'LEGACY' ? <small className="text-muted-foreground">旧平台订单</small> : null}
            </TableCell>
            <TableCell>
              <div className="udv-order-account">
                <div className="font-medium text-sm line-clamp-1 flex items-center gap-1.5" title={accountTitleText(order)}>
                  <span className="line-clamp-1">{accountTitleText(order)}</span>
                  {order.source?.origin==='LEGACY'?<Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal shrink-0">旧平台迁入</Badge>:null}
                </div>
                {accountResourceSummary(order) ? (
                  <small className="line-clamp-1">{accountResourceSummary(order)}</small>
                ) : null}
                {accountTermSummary(order) ? (
                  <small className="line-clamp-1">{accountTermSummary(order)}</small>
                ) : null}
                <div className="mt-1 font-mono text-xs">
                  {order.accountId ? (
                    <Button
                      variant="link"
                      className="udv-link"
                      aria-disabled={!canAccount}
                      onClick={() => { if (canAccount) openAccount(); }}
                    >
                      {order.accountDisplayNo ? `账号 ${order.accountDisplayNo}` : '查看账号'}
                      <ArrowUpRightIcon size={12} />
                    </Button>
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      {order.accountDisplayNo === null ? '账号信息受限' : order.accountDisplayNo?.trim() ? (/^\d+$/.test(order.accountDisplayNo) ? '旧来源号 ' + order.accountDisplayNo : order.accountDisplayNo) : '账号编号待核'}
                    </span>
                  )}
                </div>
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5 flex-wrap">
                {order.counterpartyUserId && summary && hasUsefulUserPreview(summary,counterparty) ? (
                  <EntityPreviewTrigger
                    touchLabel={'预览用户 ' + counterparty}
                    trigger={
                      <Button variant="link" className="udv-link" onClick={openCounterparty}>
                        {counterparty}
                        <ArrowUpRightIcon size={12} />
                      </Button>
                    }
                    content={
                      <UserPreviewCard
                        name={counterparty}
                        currentName={summary.name}
                        userId={order.counterpartyUserId}
                        image={summary.image}
                        maskedPhone={summary.maskedPhone}
                        membershipSummary={summary.membershipSummary}
                        creditSummary={summary.creditSummary}
                        riskFlag={summary.riskFlag}
                        canOpen
                        onOpen={openCounterparty}
                      />
                    }
                  />
                ) : order.counterpartyUserId && canDirectory ? (
                  <Button variant="link" className="udv-link" onClick={openCounterparty}>
                    {counterparty}
                    <ArrowUpRightIcon size={12} />
                  </Button>
                ) : (
                  <span>{counterparty}</span>
                )}
              </div>
              {summary?.maskedPhone ? (
                <small className="font-mono">{summary.maskedPhone}</small>
              ) : null}
            </TableCell>
            <TableCell>
              <OrderStages order={order} className="udv-order-stages" />
              {order.status === 'CANCELLED' && order.paidAt ? (
                <small className="block mt-1">付款后取消 · {time(order.paidAt)}</small>
              ) : null}
              {['PAID', 'COMPLETED'].includes(order.status) && !order.paidAt ? (
                <small className="block mt-1">支付时间待确认</small>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              <div className="font-semibold text-sm">
                {order.amounts.totalDue ? order.amounts.totalDue.amount + ' 元' : '待核'}
              </div>
              <small className="text-muted-foreground block mt-1">
                资源 {order.amounts.rental ? order.amounts.rental.amount + ' 元' : '待核'} · 押金 {order.amounts.deposit ? order.amounts.deposit.amount + ' 元' : '待核'}
              </small>
            </TableCell>
          </TableRow>;
        })}</TableBody>
      </Table></ListTable>}
    </UserCollection>
  </section>;
}

function Resources({adapter,user,refreshNonce,onOpenPath}:{adapter:UserDirectoryData;user:User;refreshNonce:number;onOpenPath:PageProps['onOpenPath']}) {
  return <section className="udv-block"><div className="udv-toolbar"><div className="flex items-center gap-2"><span className="text-xs font-semibold text-foreground">当前上架账号</span><span className="udv-muted">已发布账号，暂停或占用仍保留上架记录</span></div></div><UserCollection adapter={adapter} user={user} domain="resources" filters={{publication:'published'}} refreshNonce={refreshNonce}>{rows=><ListTable empty={!rows.length ? "当前没有上架账号" : undefined}><Table><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>游戏</TableHead><TableHead>当前状态</TableHead><TableHead>上架记录</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{(rows as Resource[]).map(account=><TableRow key={account.accountId}><TableCell><Button variant="link" className="udv-link" onClick={()=>onOpenPath(`/supply/accounts/${account.accountId}`,`账号 ${account.displayNo??''}`)}>{account.displayNo??'账号编号待核'}<ArrowUpRightIcon size={13}/></Button></TableCell><TableCell>{account.game.name}</TableCell><TableCell><div className="udv-tags">{account.staffRestricted?<Badge variant="destructive">运营限制</Badge>:null}{account.ownerPaused?<Badge variant="warning">号主暂停</Badge>:null}{account.legacyHold!=='NONE'?<Badge variant="warning">历史占用待核</Badge>:null}{!account.staffRestricted&&!account.ownerPaused&&account.legacyHold==='NONE'?<Badge variant="success">正常</Badge>:null}</div></TableCell><TableCell>{account.publication.currentlyPublished===true?'已上架':account.publication.currentlyPublished===false?'当前未上架':'上架状态待核'}</TableCell><TableCell>{adapter.has('supply.review.read')?<Button variant="outline" size="sm" onClick={()=>onOpenPath(`/supply/reviews/${account.accountId}`,`处理账号 ${account.displayNo??''}`)}>处理账号</Button>:<Button variant="outline" size="sm" onClick={()=>onOpenPath(`/supply/accounts/${account.accountId}`)}>查看详情</Button>}</TableCell></TableRow>)}</TableBody></Table></ListTable>}</UserCollection></section>;
}

function Membership({adapter,user,refreshNonce,onOpenPath}:{adapter:UserDirectoryData;user:User;refreshNonce:number;onOpenPath:PageProps['onOpenPath']}) {
  const {result,retry}=useDirectoryRequest(`${user.id}:growth:${refreshNonce}`,signal=>adapter.membershipGrowth(user.id,signal));
  if(!adapter.has(PERMISSION.growthSummary)&&!adapter.has(PERMISSION.growthDetail)&&!adapter.snapshot.security.isBoss)return <Denied permission={PERMISSION.growthSummary}/>;
  if(result.state==='loading')return <DetailLoading/>;
  if(result.state==='error')return <Message kind="error" title="会员资料读取失败" retry={retry}>{errorText(result.error)}</Message>;
  const data=result.data,growth=data.growth,hasSummary=data.authorizationState!=='DETAIL_ONLY';
  const canHandle=['membership.entitlement.request','membership.entitlement.decide','membership.entitlement.execute','membership.policy.draft'].some(code=>adapter.has(code))||adapter.snapshot.security.isBoss;
  return <section className="udv-block"><div className="udv-toolbar"><span className="text-xs font-semibold text-foreground">会员与礼遇</span>{canHandle?<Button variant="outline" size="sm" onClick={()=>onOpenPath(`/membership-growth?${new URLSearchParams({userId:user.id,fromUserId:user.id,fromUserSection:'growth'})}`)}>办理此用户礼遇<ArrowUpRightIcon size={14}/></Button>:null}</div>
    {hasSummary?<dl className="udv-facts"><div><dt>当前等级</dt><dd>{growth?.knowledge==='KNOWN'&&growth.effectiveTier?TIER_LABEL[growth.effectiveTier]??'等级待核':'等级待核'}</dd></div><div><dt>滚动积分</dt><dd>{growth?.rollingPoints??'待核'}</dd></div><div><dt>累计贡献积分</dt><dd>{growth?.lifetimePoints??'待核'}</dd></div>{growth?.grace&&growth.grace.state!=='NONE'?<div><dt>保级截止</dt><dd>{time(growth.grace.until)}</dd></div>:null}</dl>:<Message title="等级与礼遇读取受限">当前权限只允许查看贡献明细。</Message>}
    <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>查看成长说明</CollapsibleTrigger><CollapsibleContent><dl className="udv-facts"><div><dt>成长资料</dt><dd>{growth?.sourceState?SOURCE_STATE_LABEL[growth.sourceState]??'资料待核':'资料待核'}</dd></div>{data.sourceSummary?<div><dt>贡献来源</dt><dd>来源记录 {data.sourceSummary.contributionCount} 条</dd></div>:null}<div><dt>黑金资格</dt><dd>{growth?.blackGold==='QUALIFIED'?'已具备资格':growth?.blackGold==='NOT_QUALIFIED'?'未具备资格':growth?.blackGold==='REVIEW_REQUIRED'?'待人工复核':'待核'}</dd></div><div><dt>会员权益</dt><dd>{growth?.benefitsState==='CONFIGURED'?'已配置生效':growth?.benefitsState==='NOT_CONFIGURED'?'尚未配置':'待核'}</dd></div>{growth?.grace&&growth.grace.state!=='NONE'?<div><dt>保级差额</dt><dd>{growth.grace.gapPoints==null?'待核':growth.grace.gapPoints+' 积分'}</dd></div>:null}</dl></CollapsibleContent></Collapsible>
    <h3>礼遇记录</h3>{!Array.isArray(data.entitlements)?<p className="udv-muted">礼遇资料暂不可用</p>:<ListTable empty={!data.entitlements.length ? "暂无礼遇记录" : undefined}><Table><TableHeader><TableRow><TableHead>礼遇</TableHead><TableHead>权益</TableHead><TableHead>有效期</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{data.entitlements.map(item=><TableRow key={item.id}><TableCell>{item.kind==='PRESTIGE'?'尊享礼遇':'挚友礼遇'}<small>{item.label}</small></TableCell><TableCell>{item.depositWaived?'免押金':'按规则缴纳押金'}</TableCell><TableCell>{time(item.startsAtUtc)}<small>至 {time(item.endsAtUtc)}</small></TableCell><TableCell><Badge variant={item.status==='ACTIVE'?'success':'outline'}>{{ACTIVE:'有效',EXPIRED:'已到期',REVOKED:'已撤销',REPLACED:'已替换',PENDING:'待审批',APPROVED_PENDING_EXECUTION:'已批准待执行',EXECUTED_PENDING_START:'待生效'}[item.status]??'状态待核'}</Badge></TableCell></TableRow>)}</TableBody></Table></ListTable>}
  </section>;
}

export function UserDetail({adapter,snapshot,tab,onOpenPath,onQueryChange,refreshNonce}:PageProps&{adapter:UserDirectoryData}) {
  const id=tab.objectId!,rawSection=tab.query.section;
  const section=rawSection&&rawSection in SECTIONS?rawSection:'orders';
  const identityScope=JSON.stringify([id,section]);
  const [identity,setIdentity]=useState({scope:identityScope,open:false});
  if(identity.scope!==identityScope)setIdentity({scope:identityScope,open:false});
  const identityOpen=identity.scope===identityScope&&identity.open;
  const setIdentityOpen=(open:boolean)=>setIdentity({scope:identityScope,open});
  useEffect(()=>{if(rawSection&&!(rawSection in SECTIONS)){onQueryChange({...tab.query,section:'orders'});}},[rawSection,tab.query,onQueryChange]);
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
  const returnFinance=(adapter.has('finance.read')||adapter.has('finance.document.read'))?financeOriginPath(tab.query.financeOrigin,snapshot,tab.query.financeReturn):undefined;
  return <section className="ud-detail ud-detail-v2" aria-busy={result.state==='loading'}>
    {result.state==='error'?<Message kind="error" title="详情更新失败，保留当前内容" retry={retry}>{errorText(result.error)}</Message>:null}
    <div className="udv-heading"><div className="flex flex-wrap gap-2">{returnFinance?<Button variant="outline" onClick={()=>onOpenPath(returnFinance)}><ArrowLeftIcon size={16}/>返回来源资金</Button>:null}<Button variant="ghost" onClick={back}><ArrowLeftIcon size={16}/>返回列表</Button></div><UserRiskAction adapter={adapter} user={user} changed={changed}/></div>
    <header className="udv-user-header"><div><Identity user={user} heading/><div className="udv-tags"><Status user={user}/><IdentityStatus value={user.identityStatus}/><MembershipSummaryCell summary={user.membershipSummary}/><CreditSummaryCell summary={user.creditSummary}/></div><p className="udv-muted">注册于 <RegistrationCell user={user} includeTime/></p></div>{canMoney?<div className="udv-wallet"><span>可用余额</span><strong>{user.walletSummary?.state==='ready'?financeMoney(user.walletSummary.amountCents):user.walletSummary?.state==='denied'?'无查看权限':'待核'}</strong><Button variant="link" onClick={()=>onQueryChange({section:'finance'})}>查看资金<ArrowUpRightIcon size={13}/></Button></div>:null}</header>
    <Collapsible key={identityScope} open={identityOpen} onOpenChange={setIdentityOpen} className="udv-identity-collapsible">
      <div className="udv-identity-trigger-bar" onClick={() => setIdentityOpen(!identityOpen)}>
        <div className="flex items-center gap-2">
          <ShieldCheckIcon size={15} className="text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-semibold">实名与联系方式</span>
          <span className="udv-muted">（默认脱敏，按需查看）</span>
        </div>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>
          <span className="text-xs">{identityOpen ? '收起实名与联系方式' : '展开实名与联系方式'}</span>
          <ChevronDownIcon size={14} className={`transition-transform duration-200 ${identityOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <SensitiveIdentity adapter={adapter} user={user} active={identityOpen}/>
      </CollapsibleContent>
    </Collapsible>
    <Tabs value={section} onValueChange={value=>onQueryChange({section:String(value),...(value==='resources'?{publication:'published'}:{})})}><TabsList aria-label="用户详情分区">{Object.entries(SECTIONS).map(([key,label])=><TabsTrigger key={key} value={key}>{label}</TabsTrigger>)}</TabsList></Tabs>
    {[...visited].map(view=><div key={view} hidden={view!==section} className="udv-tab" role="region" aria-label={SECTIONS[view]}>
      {view==='orders'?<Orders adapter={adapter} user={user} tab={tab} refreshNonce={refreshNonce} onOpenPath={onOpenPath} onQueryChange={onQueryChange}/>:view==='resources'?<Resources adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='growth'?<Membership adapter={adapter} user={user} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='credit'?<CreditPanel adapter={adapter} user={user} refreshNonce={refreshNonce} active={view===section} changed={changed}/>:view==='finance'?<UserDetailFinance adapter={adapter} user={user} tab={tab} onQueryChange={onQueryChange} refreshNonce={refreshNonce} onOpenPath={onOpenPath}/>:view==='notes'?<UserNotes adapter={adapter} user={user} refreshNonce={refreshNonce}/>:<>
        <section className="udv-block"><div className="udv-toolbar"><span className="text-xs font-semibold text-foreground">账号资料</span><Badge variant="outline">{STATUS_LABEL[user.status]??'状态待核'}</Badge></div><Field label="用户ID"><Input readOnly value={user.id} aria-label="用户ID" onFocus={event=>event.currentTarget.select()}/></Field><dl className="udv-facts"><div><dt>手机号</dt><dd>{user.phoneMasked}</dd></div>{user.legacyId?<div><dt>旧平台ID</dt><dd>{user.legacyId}</dd></div>:null}{user.displayUsername?<div><dt>用户名</dt><dd>{user.displayUsername}</dd></div>:null}{user.emailMasked?<div><dt>邮箱</dt><dd>{user.emailMasked}</dd></div>:null}</dl></section>
        {user.status==='ACTIVE'||user.status==='FROZEN'?<FreezeControl adapter={adapter} user={user} changed={changed}/>:<p className="udv-muted">{user.status==='CANCELLED'?'已注销账号不可冻结或解冻。':'当前账号状态不支持冻结或解冻。'}</p>}
        <Collapsible><CollapsibleTrigger render={<Button variant="outline"/>}>查看安全操作记录</CollapsibleTrigger><CollapsibleContent><UserCollection adapter={adapter} user={user} domain="audit" refreshNonce={(sectionRefresh.current[view]??0)+revision}>{rows=><ListTable empty={!rows.length ? "当前授权范围内暂无安全操作记录" : undefined}><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>操作</TableHead><TableHead>管理员</TableHead><TableHead>结果</TableHead></TableRow></TableHeader><TableBody>{(rows as Audit[]).map(event=><TableRow key={event.eventId}><TableCell>{time(event.occurredAt)}</TableCell><TableCell>{auditLabels[event.action]??'其他安全操作'}</TableCell><TableCell>{event.actor.name||'未记录'}</TableCell><TableCell>{event.outcome==='SUCCESS'?'成功':'失败'}</TableCell></TableRow>)}</TableBody></Table></ListTable>}</UserCollection></CollapsibleContent></Collapsible>
      </>}
    </div>)}
  </section>;
}

type FreezeResult = 'success' | 'rejected' | 'conflict' | 'failed' | 'pending' | 'readback-failed';
type FreezeAction = 'freeze' | 'unfreeze';
const FREEZE_PERMISSION: Record<FreezeAction, string> = { freeze: 'user.account.freeze', unfreeze: 'user.account.unfreeze' };
const FREEZE_TEXT: Record<FreezeAction, { verb: string; target: User['status'] }> = { freeze: { verb: '冻结', target: 'FROZEN' }, unfreeze: { verb: '解冻', target: 'ACTIVE' } };
function FreezeControl({ adapter, user, changed }: { adapter: UserDirectoryData; user: User; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<FreezeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [read, setRead] = useState<User>();
  const [writeAccepted, setWriteAccepted] = useState(false);
  const [action, setAction] = useState<FreezeAction>(user.status === 'FROZEN' ? 'unfreeze' : 'freeze');
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  const clearSecrets = () => { setPassword(''); setCode(''); };
  const current = read ?? user;
  const currentAction: FreezeAction | null = current.status === 'ACTIVE' ? 'freeze' : current.status === 'FROZEN' ? 'unfreeze' : null;
  const shownAction: FreezeAction = writeAccepted || result ? action : (currentAction ?? action);
  const verb = FREEZE_TEXT[shownAction].verb;
  const target = FREEZE_TEXT[shownAction].target;
  const hasAccess = adapter.has(FREEZE_PERMISSION[shownAction]);
  const eligible = hasAccess && !writeAccepted && currentAction === shownAction;

  const reread = async () => {
    setBusy(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      const value = await adapter.detail(user.id, request.signal);
      if (request.signal.aborted) return;
      setRead(value);
      if (writeAccepted && value.status === target) {
        setResult('success'); setError(''); changed();
      } else if (writeAccepted) {
        setResult('readback-failed'); setError(`${verb}请求已被接受，但账号状态仍未更新；不会自动重复提交。`);
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
    setAction(shownAction);
    setError(''); setRead(undefined); setBusy(true);
    const request = new AbortController(); controller.current = request;
    try {
      await adapter.setFrozen(user.id, shownAction === 'freeze', reason, password, code, request.signal);
      if (request.signal.aborted) return;
      setWriteAccepted(true); setResult('success');
      try {
        const value = await adapter.detail(user.id, request.signal);
        if (request.signal.aborted) return;
        setRead(value);
        if (value.status === target) {
          setResult('success'); setError(''); changed();
        } else {
          setResult('readback-failed'); setError(`${verb}请求已被接受，但账号状态仍未更新；不会自动重复提交。`);
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

  const labels: Record<FreezeResult, string> = {
    success: `账号${verb}已处理`,
    rejected: '管理员再认证被拒绝',
    conflict: '账号状态已变化',
    failed: `${verb}操作失败`,
    pending: `${verb}结果待确认`,
    'readback-failed': `${verb}请求已提交，状态待确认`,
  };

  return (
    <div className="ud-restore">
      <h2>账号冻结</h2>
      {!hasAccess ? (
        <Denied permission={FREEZE_PERMISSION[shownAction]} />
      ) : (
        <>
          <p>
            {writeAccepted ? `${verb}请求已被服务端接受；当前状态需要重读确认。` :
             eligible && shownAction === 'freeze' ? '账号正常。冻结后用户全部会话立即下线且无法登录；需操作原因与管理员密码/TOTP再认证。' :
             eligible ? '账号已冻结，用户无法登录。解冻需操作原因与管理员密码/TOTP再认证。' :
             current.status === 'CANCELLED' ? '已注销账号不可冻结或解冻。' : `当前账号状态不符合${verb}条件。`}
          </p>
          {writeAccepted ? (
            <Button variant="outline" onClick={() => setOpen(true)}>核对{verb}结果</Button>
          ) : eligible ? (
            <Button variant={shownAction === 'freeze' ? 'destructive' : 'outline'} onClick={() => setOpen(true)}>{shownAction === 'freeze' ? '冻结账号' : '解冻账号'}</Button>
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
            <DialogTitle>{shownAction === 'freeze' ? '冻结账号' : '解冻账号'} · {user.name}</DialogTitle>
            <DialogDescription>
              {shownAction === 'freeze'
                ? '冻结后用户全部会话与待用验证凭据立即撤销，无法登录用户侧；进行中的订单与资金不做特殊处理，由既有状态校验拦截。'
                : '解冻只恢复账号可用状态，不复活旧会话或验证凭据，不覆盖实名与年龄结果。'}
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
            <StepUpCaptcha />
            {result ? (
              <Message
                kind={result === 'success' ? 'success' : result === 'pending' || result === 'readback-failed' ? 'info' : 'error'}
                title={labels[result]}
              >
                {read ? `重读账号状态：${STATUS_LABEL[read.status]}。` : '账号状态尚未确认。'}
                {result === 'success' ? (action === 'freeze' ? '用户已全部下线且无法登录。' : '请用户重新登录；旧会话和验证凭据不会复活。') :
                 result === 'readback-failed' ? `${verb}写入已成功，但状态回读未完成；不会自动重复提交。` :
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
                  {busy ? '处理中…' : `提交${verb}`}
                </Button>
              ) : null}
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
