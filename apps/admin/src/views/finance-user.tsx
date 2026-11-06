import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { adminRequest, AdminApiError, friendlyError, type SessionSnapshot, type UserDirectoryDetail } from '../api';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { beijingCalendarDate, beijingRangeStart } from '../workspace/beijing-time';
import type { WorkspaceRouteKind, WorkspaceTab } from '../workspace/tab-model';
import { financeOriginPath } from './admin-finance-view';
import { financeMoney, financeTime } from './admin-finance-api';
import { FinanceActivity } from './finance-activity';

type Snapshot = Extract<SessionSnapshot, { authenticated:true }>;
type Props = { tab:WorkspaceTab; snapshot:Snapshot; onOpenPath:(path:string,title?:string)=>void; onQueryChange:(query:Record<string,string>)=>void; onRefresh:()=>Promise<SessionSnapshot>; refreshNonce:number };
const views = ['finance-balances','finance-balance-history','finance-balance-opening','finance-records','finance-record-history'] as const;
type View = typeof views[number];
const isView = (value:string|undefined):value is View => views.includes(value as View);
const isWallet = (view:View) => view.startsWith('finance-balance');

export function FinanceUser({tab,snapshot,onOpenPath,onQueryChange,onRefresh,refreshNonce}:Props) {
  const userId=tab.objectId ?? '';
  const active=snapshot.security.status==='ACTIVE'&&!snapshot.security.passwordChangeRequired&&!snapshot.session.locked;
  const allowed=active&&snapshot.permissions.includes('finance.read')&&(snapshot.security.isBoss||snapshot.permissions.includes('user.directory.read'));
  const identity=[snapshot.adminUserId,snapshot.session.id,active,snapshot.security.isBoss,...snapshot.permissions.slice().sort(),userId,refreshNonce].join('|');
  const [data,setData]=useState<{key:string;user:UserDirectoryDetail}>(),[error,setError]=useState<unknown>(),[retry,setRetry]=useState(0);
  const view=isView(tab.query.financeView)?tab.query.financeView:'finance-balances';
  const incomingRange=tab.query.range==='all'?{from:'',to:''}:tab.query.financeView&&tab.query.from&&tab.query.to?{from:tab.query.from,to:tab.query.to}:tab.query.financeFrom&&tab.query.financeTo?{from:tab.query.financeFrom,to:tab.query.financeTo}:tab.query.period==='1'&&tab.query.from&&tab.query.to?{from:tab.query.from,to:tab.query.to}:{from:beijingCalendarDate(beijingRangeStart('7d')),to:beijingCalendarDate()};
  const query={...tab.query,...incomingRange};
  const user=allowed&&data?.key===identity?data.user:undefined;
  useEffect(()=>{
    const controller=new AbortController();setData(undefined);setError(undefined);
    if(!allowed||!userId)return()=>controller.abort();
    void adminRequest<{user:UserDirectoryDetail}>(`/users/${encodeURIComponent(userId)}?registrationTime=ORIGINAL`,undefined,'GET',{},controller.signal).then(result=>{
      if(!controller.signal.aborted){if(result.user?.userId!==userId)throw new Error('用户资料不匹配');setData({key:identity,user:result.user});}
    }).catch(cause=>{if(!controller.signal.aborted){setError(cause);if(cause instanceof AdminApiError&&[401,403,423].includes(cause.status))void onRefresh().catch(()=>undefined);}});
    return()=>controller.abort();
  },[identity,allowed,userId,retry]);
  const update=(next:Record<string,string>,target:View=view)=>{
    const {q:_q,kind:_kind,type:_type,nonzero:_nonzero,from:_from,to:_to,period:_period,range:_range,page:_page,pageSize:_pageSize,...context}=tab.query;
    const opening=target==='finance-balance-opening';
    const savedRange:Record<string,string>=opening&&query.from&&query.to?{financeFrom:query.from,financeTo:query.to}:{};
    const noRange=opening?tab.query.range==='all':!next.from&&!next.to;
    onQueryChange({...context,...savedRange,...next,...(noRange?{range:'all'}:{}),financeView:target});
  };
  const change=(target:View,next:Record<string,string>={})=>update({...(target==='finance-balance-opening'?{}:{from:next.from??query.from,to:next.to??query.to})},target);
  const back=financeOriginPath(tab.query.origin,snapshot,tab.query.financeReturn)??`/users/${encodeURIComponent(userId)}?section=finance`;
  const userPath=`/users/${encodeURIComponent(userId)}`;
  return <section className="finance-page finance-user-page" aria-labelledby="finance-user-title">
    <header className="finance-user-header">
      <div><h1 id="finance-user-title">{user?.name??'用户资金'}</h1><p className="finance-secondary">查看该用户的余额变动和相关资金记录</p></div>
      <div className="finance-page-actions"><Button variant="outline" size="sm" onClick={()=>onOpenPath(back)}><ArrowLeft size={14} aria-hidden/>返回来源</Button>{!back.startsWith(userPath)?<Button variant="outline" size="sm" onClick={()=>onOpenPath(`${userPath}?section=finance`)}>用户资料<ExternalLink size={14} aria-hidden/></Button>:null}</div>
    </header>
    {!allowed?<Alert variant="warning"><AlertTitle>无法查看用户资金</AlertTitle><AlertDescription>需要用户资料和资金读取权限。</AlertDescription></Alert>:error?<Alert variant="warning" role="alert"><AlertTitle>用户资料暂时无法读取</AlertTitle><AlertDescription>{friendlyError(error)} <Button variant="link" onClick={()=>setRetry(value=>value+1)}>重试</Button></AlertDescription></Alert>:!user?<div className="space-y-3" role="status" aria-busy="true"><span className="sr-only">正在读取用户资料</span><Skeleton className="h-20 w-full"/><Skeleton className="h-40 w-full"/></div>:<>
      <div className="finance-user-balance"><div><span>当前可用余额</span><strong>{user.walletSummary?.state==='ready'?financeMoney(user.walletSummary.amountCents):user.walletSummary?.state==='denied'?'无查看权限':user.walletSummary?.state==='unknown'?'待核实':'未记录'}</strong>{user.walletSummary?.state==='ready'?<small>截至 {financeTime(user.walletSummary.asOfUtc)}</small>:null}</div>{view!=='finance-balance-opening'?<Button variant="outline" size="sm" onClick={()=>change('finance-balance-opening')}>查看迁移期初</Button>:null}</div>
      <nav className="finance-user-tabs" aria-label="用户资金分类"><Button variant={isWallet(view)?'secondary':'ghost'} aria-current={isWallet(view)?'page':undefined} onClick={()=>change('finance-balances')}>余额变动</Button><Button variant={!isWallet(view)?'secondary':'ghost'} aria-current={!isWallet(view)?'page':undefined} onClick={()=>change('finance-records')}>资金记录</Button></nav>
      <FinanceActivity key={`${userId}:${view}`} tab={{...tab,kind:view as WorkspaceRouteKind,query}} snapshot={snapshot} onOpenPath={onOpenPath} onQueryChange={next=>update(next)} onRefresh={onRefresh} refreshNonce={refreshNonce} subjectUserId={userId} onSubjectView={(next,filters)=>{if(isView(next))change(next,filters);}}/>
    </>}
  </section>;
}
