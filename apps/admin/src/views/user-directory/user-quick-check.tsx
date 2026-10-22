import { useState } from 'react';
import { ArrowUpRightIcon, ChevronDownIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ListTable, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/admin-list/list-table';
import { PERMISSION, knownCount, type Order, type Resource, type User } from './user-directory-data';
import { UserNotes, UserRiskAction } from './user-detail-actions';
import { errorText, Message, time, useDirectoryRequest, type PageProps, type UserDirectoryData } from './user-directory-shared';

type BusinessTab = 'renter' | 'owner' | 'published';
type Props = Pick<PageProps,'refreshNonce'|'onOpenPath'> & { adapter:UserDirectoryData; user:User; onChanged?:()=>void };
const labels:Record<BusinessTab,string> = {renter:'租入',owner:'出租',published:'上架'};
const orderStates:Record<string,{label:string;tone:'warning'|'info'|'success'|'secondary'}> = {
  PENDING_PAYMENT:{label:'待支付',tone:'warning'},PAID:{label:'已支付',tone:'info'},
  COMPLETED:{label:'已完成',tone:'success'},CANCELLED:{label:'已取消',tone:'secondary'},
};
const context = (adapter:UserDirectoryData) => `${adapter.snapshot.adminUserId}:${adapter.snapshot.session.id}:${adapter.snapshot.security.isBoss}:${[...adapter.snapshot.permissions].sort().join('|')}`;
const allowed = (adapter:UserDirectoryData,tab:BusinessTab) => adapter.snapshot.security.isBoss || adapter.has(tab==='published'?PERMISSION.resources:PERMISSION.orders);
const detailPath = (id:string,tab:BusinessTab) => `/users/${encodeURIComponent(id)}?${new URLSearchParams(tab==='published'?{section:'resources',publication:'published'}:{section:'orders',role:tab,status:'current'})}`;
function tabCount(user:User,tab:BusinessTab) {
  if(tab==='published')return user.resources.state==='ready'?knownCount(user.resources.publishedCount):undefined;
  return user.orders.state==='ready'?knownCount(tab==='renter'?user.orders.renterCurrent:user.orders.ownerCurrent):undefined;
}
function sourceQuery(user:User,tab:BusinessTab) {
  return new URLSearchParams(tab==='published'?{fromUserId:user.id,fromUserSection:'resources',fromUserPublication:'published'}:
    {fromUserId:user.id,fromUserSection:'orders',fromUserRole:tab,fromUserStatus:'current'});
}

function CurrentBusiness({adapter,user,refreshNonce,onOpenPath,tab}:Props&{tab:BusinessTab}) {
  const resource=tab==='published';
  const filters:Record<string,string>=resource?{publication:'published',limit:'5'}:{role:tab,status:'current',limit:'5'};
  const {result,retry}=useDirectoryRequest(`${context(adapter)}:${user.id}:quick:${tab}:${refreshNonce}`,
    signal=>adapter.section(user.id,resource?'resources':'orders',signal,undefined,filters));
  const count=tabCount(user,tab);
  return <div className="space-y-3">
    {result.state==='loading'?<div role="status" aria-label={`正在读取当前${labels[tab]}`} className="space-y-3"><Skeleton className="h-16 w-full"/><Skeleton className="h-16 w-full"/><Skeleton className="h-16 w-full"/><span className="sr-only">正在读取记录</span></div>:
      result.state==='error'?<Message kind="error" title={`${labels[tab]}记录读取失败`} retry={retry}>{errorText(result.error)}</Message>:
      result.data.state==='denied'?<Message kind="denied" title={result.data.reason==='NO_GAME_SCOPE'?'尚未分配业务范围':`当前账号无法查看${labels[tab]}记录`}/>:
      result.data.data.length===0?<p className="py-6 text-center text-sm text-muted-foreground">{resource?'当前没有上架账号':`暂无当前${labels[tab]}订单`}</p>:
      <ListTable><Table aria-label={resource?'快速核对当前上架账号':`快速核对当前${labels[tab]}订单`} className="table-fixed text-sm">
        <TableHeader><TableRow><TableHead>{resource?'账号 / 游戏':'订单 / 关联信息'}</TableHead><TableHead className="w-28 text-right">{resource?'上架与状态':'订单状态'}</TableHead></TableRow></TableHeader>
        <TableBody>{resource?(result.data.data as Resource[]).map(account=><TableRow key={account.accountId}>
          <TableCell className="whitespace-normal align-top"><Button variant="link" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left text-foreground" onClick={()=>onOpenPath(`/supply/accounts/${encodeURIComponent(account.accountId)}?${sourceQuery(user,tab)}`,`账号 ${account.displayNo??''}`)}><span className="break-all">{account.displayNo??'账号编号待核'}</span><ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0"/></Button>
            {account.game?.name?<span className="mt-1 block text-xs text-muted-foreground">{account.game.name}</span>:null}</TableCell>
          <TableCell className="align-top"><div className="flex flex-wrap justify-end gap-1">
            <Badge variant={account.publication?.currentlyPublished===true?'secondary':'unknown'}>{account.publication?.currentlyPublished===true?'已上架':account.publication?.currentlyPublished===false?'当前未上架':'上架待核'}</Badge>
            {account.ownerPaused===true?<Badge variant="warning">号主暂停</Badge>:null}{account.staffRestricted===true?<Badge variant="destructive">运营限制</Badge>:null}
            {typeof account.ownerPaused!=='boolean'||typeof account.staffRestricted!=='boolean'?<Badge variant="unknown">状态待核</Badge>:null}
          </div></TableCell>
        </TableRow>):(result.data.data as Order[]).map(order=>{const status=orderStates[order.status];return <TableRow key={order.orderId}>
          <TableCell className="whitespace-normal align-top"><Button variant="link" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left text-foreground" onClick={()=>onOpenPath(`/orders/${encodeURIComponent(order.orderId)}?${sourceQuery(user,tab)}`,order.displayNo)}><span className="break-all">{order.displayNo}</span><ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0"/></Button>
            <div className="mt-1 space-y-1 text-xs text-muted-foreground">{order.accountDisplayNo?<p className="break-all">账号 {order.accountDisplayNo}</p>:null}{order.counterpartyName?<p className="break-words">{tab==='renter'?'号主':'租客'} {order.counterpartyName}</p>:null}{order.createdAt?<p>{time(order.createdAt)}</p>:null}</div></TableCell>
          <TableCell className="text-right align-top"><Badge variant={status?.tone??'unknown'}>{status?.label??'状态待核'}</Badge></TableCell>
        </TableRow>;})}</TableBody>
      </Table></ListTable>}
    {result.state==='ready'&&result.data.state==='ready'?<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      <span className="text-xs text-muted-foreground">{count===undefined?'数量待核':resource?`当前上架 ${count} 个`:`当前${labels[tab]} ${count} 笔`}</span>
      <Button variant="outline" size="sm" onClick={()=>onOpenPath(detailPath(user.id,tab))}>查看全部{labels[tab]}<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button>
    </div>:null}
  </div>;
}

function RiskControl({adapter,user,refreshNonce,onChanged}:Pick<Props,'adapter'|'user'|'refreshNonce'|'onChanged'>) {
  const [revision,setRevision]=useState(0);
  const {result,retry}=useDirectoryRequest(`${context(adapter)}:${user.id}:quick-risk:${refreshNonce}:${user.riskRevision}:${revision}`,
    signal=>revision?adapter.detail(user.id,signal,true):Promise.resolve(user));
  if(result.state==='error')return <Message kind="error" title="高危标记读取失败" retry={retry}>{errorText(result.error)}</Message>;
  if(result.state==='loading')return <Skeleton className="h-8 w-28"/>;
  return <UserRiskAction adapter={adapter} user={result.data} changed={()=>{setRevision(value=>value+1);onChanged?.();}}/>;
}

/** The parent owns the user's identity header and the full-detail CTA. */
export function UserQuickCheck(props:Props) {
  const {adapter,user,refreshNonce}=props;
  const [tab,setTab]=useState<BusinessTab>('renter');
  const [notesOpen,setNotesOpen]=useState(false);
  return <div className="min-w-0 space-y-5" data-user-quick-check>
    <Tabs value={tab} onValueChange={value=>{if(value==='renter'||value==='owner'||value==='published')setTab(value);}}>
      <TabsList aria-label="当前业务" className="gap-5">
        {(Object.keys(labels) as BusinessTab[]).map(key=><TabsTrigger key={key} value={key}>{labels[key]}</TabsTrigger>)}
      </TabsList>
      {(Object.keys(labels) as BusinessTab[]).map(key=><TabsContent key={key} value={key}>
        {tab===key?allowed(adapter,key)?<CurrentBusiness {...props} tab={key}/>:<Message kind="denied" title={`当前账号无法查看${labels[key]}记录`}/>:null}
      </TabsContent>)}
    </Tabs>
    <div className="space-y-4 border-t pt-4">
      {adapter.has('user.risk.manage')?<RiskControl key={user.id} adapter={adapter} user={user} refreshNonce={refreshNonce} onChanged={props.onChanged}/>:null}
      <Collapsible open={notesOpen} onOpenChange={setNotesOpen}>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="w-full justify-between"/>}>内部备注<ChevronDownIcon aria-hidden className="size-4"/></CollapsibleTrigger>
        <CollapsibleContent className="pt-3">{notesOpen?<UserNotes key={user.id} adapter={adapter} user={user} refreshNonce={refreshNonce}/>:null}</CollapsibleContent>
      </Collapsible>
    </div>
  </div>;
}
