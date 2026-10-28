import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, CalendarDaysIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { DateSelector, type DateSelectorValue } from "@/components/reui/date-selector";
import { ListPagination } from "@/components/admin-list/list-pagination";
import { ListTable, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/admin-list/list-table";
import { bucketLabels, defaultFinanceFilters, financeMoney, financeTime, financeBusinessLabel, financeIsHistorical, financeRecordNumber, financeRecordState, financeEntryScope, type FinanceFilters } from "../admin-finance-api";
import { HistoricalFinanceDetail, financeContextIdentity, registerFinanceOrigin } from "../admin-finance-view";
import { PERMISSION, type User } from "./user-directory-data";
import { ChannelEvidenceLookup } from "../admin-channel-evidence-panel";
import { errorText, Message, useDirectoryRequest, type PageProps, type UserDirectoryData } from "./user-directory-shared";
import { sanitizeFinanceReturn, type WorkspaceTab } from '@/workspace/tab-model';

type Props = Pick<PageProps,"refreshNonce"|"onOpenPath"> & { adapter:UserDirectoryData; user:User; tab?:WorkspaceTab; onQueryChange?:(query:Record<string,string>)=>void };
const components = {haffRentCents:"哈夫币实耗租金",itemConsumptionCents:"物品实耗费用",earlyMakeupCents:"提前结束补足",renterFeeCents:"租客承担包赔费"} as const;
const money = (value:string|null|undefined) => value == null ? "待核" : financeMoney(value);
const day = (date:Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const identity = (adapter:UserDirectoryData) => `${adapter.snapshot.adminUserId}:${adapter.snapshot.session.id}:${adapter.snapshot.security.isBoss}:${[...adapter.snapshot.permissions].sort().join("|")}`;

function FinanceLoading({label}:{label:string}) {
  return <div aria-busy="true" role="status" aria-label={label} className="space-y-3 py-2"><Skeleton className="h-8 w-48"/><Skeleton className="h-20 w-full"/><Skeleton className="h-32 w-full"/><span className="sr-only">{label}</span></div>;
}

function Consumption({adapter,user,refreshNonce,onOpenPath}:Props) {
  const [pagination,setPagination]=useState({subject:user.id,page:1,pageSize:20});
  const current=pagination.subject===user.id?pagination:{subject:user.id,page:1,pageSize:20};
  const {result,retry}=useDirectoryRequest(`${identity(adapter)}:${user.id}:consumption:${current.page}:${current.pageSize}:${refreshNonce}`,
    signal=>adapter.consumption(user.id,signal,current.page,current.pageSize));
  const canOrder=adapter.snapshot.security.isBoss||adapter.has(PERMISSION.orders);
  return <section className="space-y-4" aria-labelledby="user-consumption-heading">
    <div className="flex flex-wrap items-center gap-2"><h3 id="user-consumption-heading" className="text-base font-semibold">租赁消费</h3><Badge variant="secondary">新平台已结算</Badge></div>
    {result.state==="loading"?<FinanceLoading label="正在读取消费记录"/>:result.state==="error"?
      <Message kind="error" title="消费记录读取失败" retry={retry}>{errorText(result.error)}</Message>:<>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <strong className="text-2xl font-semibold tabular-nums tracking-tight">{money(result.data.amountCents)}</strong>
          <span className="text-sm text-muted-foreground">{result.data.knowledge==="UNKNOWN"?`${result.data.unknownCount} 笔待核，已核部分 ${money(result.data.knownAmountCents)}`:"不含押金、号主收入和分销奖励"}</span>
        </div>
        <dl className="grid grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2 xl:grid-cols-4">
          {Object.entries(components).map(([key,label])=><div key={key}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-medium tabular-nums">{money(result.data.components[key as keyof typeof components])}</dd></div>)}
        </dl>
        <p className="text-xs text-muted-foreground">旧平台消费暂不能汇总。历史账目与新平台结算分开核对。</p>
        {result.data.unknownCount>0?<Message title="部分结算金额待核">相关订单的调整金额或结算依据尚未核清，未计入完整合计。</Message>:null}
        <ListTable empty={result.data.total===0?<p className="text-sm text-muted-foreground">暂无新平台已结算消费。</p>:undefined}>
          <Table aria-label="用户租赁消费明细" className="min-w-[860px]">
            <TableHeader><TableRow><TableHead>订单 / 结算时间</TableHead>{Object.values(components).map(label=><TableHead key={label} className="text-right">{label}</TableHead>)}<TableHead className="text-right">本单消费</TableHead><TableHead>核对状态</TableHead></TableRow></TableHeader>
            <TableBody>{result.data.items.map(item=><TableRow key={item.postingId}>
              <TableCell>{canOrder?<Button variant="link" className="h-auto p-0 text-foreground" onClick={()=>onOpenPath(`/orders/${encodeURIComponent(item.orderId)}`,item.displayNo)}>{item.displayNo}<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button>:<span className="font-medium">{item.displayNo}</span>}<span className="mt-1 block text-xs text-muted-foreground">{financeTime(item.postedAt)}</span></TableCell>
              {Object.keys(components).map(key=><TableCell key={key} className="text-right tabular-nums">{money(item[key as keyof typeof components])}</TableCell>)}
              <TableCell className="text-right font-medium tabular-nums">{money(item.amountCents)}</TableCell>
              <TableCell><Badge variant={item.knowledge==="KNOWN"?"success":"warning"}>{item.knowledge==="KNOWN"?"已核对":item.reasonCodes.includes("MANUAL_RENTER_ADJUSTMENT_UNALLOCATED")?"调整待核":"结算待核"}</Badge></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </ListTable>
        <ListPagination mode="page" page={current.page} pageSize={current.pageSize} total={result.data.total} loading={false} itemLabel="笔结算" pageSizeOptions={[10,20,50]}
          onPageChange={page=>setPagination({...current,page})} onPageSizeChange={pageSize=>setPagination({...current,page:1,pageSize})}/>
      </>}
  </section>;
}

function FinanceDocuments({adapter,user,refreshNonce,onOpenPath,tab,onQueryChange}:Props) {
  const incoming={...defaultFinanceFilters(true),scope:user.id,...(tab?.query.financeFrom?{from:tab.query.financeFrom}:{}),...(tab?.query.financeTo?{to:tab.query.financeTo}:{})};
  const navigation=JSON.stringify([user.id,incoming.from,incoming.to]),previousNavigation=useRef(navigation);
  const [draft,setDraft]=useState<FinanceFilters>(incoming);
  const [applied,setApplied]=useState<FinanceFilters>(draft);
  const [dateOpen,setDateOpen]=useState(false);
  const [selectedDate,setSelectedDate]=useState<DateSelectorValue>(()=>({period:"day",operator:"between",startDate:new Date(`${draft.from}T00:00:00`),endDate:new Date(`${draft.to}T00:00:00`)}));
  useLayoutEffect(()=>{if(previousNavigation.current===navigation)return;previousNavigation.current=navigation;setDraft(incoming);setApplied(incoming);setSelectedDate({period:'day',operator:'between',startDate:new Date(`${incoming.from}T00:00:00`),endDate:new Date(`${incoming.to}T00:00:00`)});},[navigation]);
  const {result,retry}=useDirectoryRequest(`${identity(adapter)}:${user.id}:finance-documents:${applied.from}:${applied.to}:${refreshNonce}`,
    signal=>adapter.finance(user.id,signal,applied));
  const canDocument=adapter.snapshot.security.isBoss||adapter.has("finance.document.read");
  const openRelated=(path:string,title?:string)=>{
    const source=sanitizeFinanceReturn(`/users/${encodeURIComponent(user.id)}?${new URLSearchParams({section:'finance',financeFrom:applied.from,financeTo:applied.to})}`),target=sanitizeFinanceReturn(path);
    if(!source||!target)return;
    const origin=registerFinanceOrigin(source,financeContextIdentity(adapter.snapshot)),url=new URL(target,window.location.origin);
    url.searchParams.set(url.pathname.startsWith('/finance/')?'origin':'financeOrigin',origin);url.searchParams.set('financeReturn',source);
    onOpenPath(url.pathname+'?'+url.searchParams,title);
  };
  const open=(ref?:string)=>openRelated(ref?`/finance/documents/${encodeURIComponent(ref)}`:`/finance/users/${encodeURIComponent(user.id)}`,ref?'资金单据':`${user.name} · 资金`);
  const apply=(next:FinanceFilters)=>{setApplied(next);onQueryChange?.({...tab?.query,section:'finance',financeFrom:next.from,financeTo:next.to});if(applied.from===next.from&&applied.to===next.to)retry();};
  return <section className="space-y-4 border-t pt-6" aria-labelledby="user-finance-documents-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="user-finance-documents-heading" className="text-base font-semibold">资金单据</h3><Button variant="outline" size="sm" onClick={()=>open()}>完整资金核对<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button></div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event=>{event.preventDefault();if(draft.from&&draft.to)apply({...draft,scope:user.id});}}>
      <Field label="单据日期" composite>
        <Popover open={dateOpen} onOpenChange={setDateOpen}>
          <PopoverTrigger render={<Button type="button" variant="outline" aria-label="选择单据日期"/>}><CalendarDaysIcon aria-hidden className="size-4"/>{draft.from===draft.to?draft.from:`${draft.from} 至 ${draft.to||"请选择结束日期"}`}</PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
            <DateSelector value={selectedDate} presetMode="between" allowRange showTwoMonths={false} showInput={false}
              presets={[{label:"今天",days:0},{label:"近7天",days:7},{label:"近30天",days:30}]}
              onChange={next=>{setSelectedDate(next);setDraft({...draft,from:next.startDate?day(next.startDate):"",to:next.endDate?day(next.endDate):""});if(next.startDate&&next.endDate)setDateOpen(false);}}/>
          </PopoverContent>
        </Popover>
      </Field>
      <Button type="submit" disabled={!draft.from||!draft.to||result.state==="loading"}>查询</Button>
      <Button type="button" variant="ghost" onClick={()=>{const today={...defaultFinanceFilters(true),scope:user.id};setDraft(today);apply(today);setSelectedDate({period:"day",operator:"between",startDate:new Date(`${today.from}T00:00:00`),endDate:new Date(`${today.to}T00:00:00`)});}}>回到今天</Button>
    </form>
    <p className="text-xs text-muted-foreground">{applied.from===applied.to?`${applied.from} 当天`:`${applied.from} 至 ${applied.to}`} · 北京时间</p>
    {result.state==="loading"?<FinanceLoading label="正在读取资金单据"/>:result.state==="error"?
      <Message kind="error" title="资金单据读取失败" retry={retry}>{errorText(result.error)}</Message>:<>
        <ListTable empty={!result.data.documents?.length?<p className="text-sm text-muted-foreground">所选日期暂无资金单据。</p>:undefined}>
          <Table aria-label="用户资金单据" className="min-w-[620px]"><TableHeader><TableRow><TableHead>时间 / 记录</TableHead><TableHead>用途</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>{result.data.documents?.map(document=><TableRow key={document.ref}>
              <TableCell className="min-w-52 whitespace-normal align-top"><span className="font-medium">{financeRecordNumber(document,document.number)}</span><span className="mt-1 block text-xs text-muted-foreground">{financeTime(document.occurredAt)}</span><HistoricalFinanceDetail historical={document.historical} recordKind={document.kind} orderRead={adapter.snapshot.security.isBoss||adapter.has(PERMISSION.orders)} documentRead={canDocument} onOpenPath={openRelated}/></TableCell>
              <TableCell className="whitespace-normal align-top">{financeBusinessLabel(document)}<small className="mt-1 block text-muted-foreground">{financeEntryScope(document)}</small></TableCell>
              <TableCell className="tabular-nums align-top">{financeIsHistorical(document)&&document.kind==='WITHDRAWAL'&&document.requestedAmountCents!==null?`原申请 ${money(document.requestedAmountCents)}`:document.amounts.length?document.amounts.map(amount=><span key={amount.bucket} className="block text-sm">{financeIsHistorical(document)?'历史变动':bucketLabels[amount.bucket]??"其他科目"} {amount.unknownCount?"待核":money(amount.knownNetCents)}</span>):document.requestedAmountCents===null?"待核":`${financeIsHistorical(document)?'原申请':'申请'} ${money(document.requestedAmountCents)}`}</TableCell>
              <TableCell className="whitespace-normal align-top"><Badge variant={financeIsHistorical(document)?'outline':document.state==="RECONCILIATION_REQUIRED"||document.state==="UNKNOWN"?"warning":"secondary"}>{financeRecordState(document)}</Badge></TableCell>
              <TableCell className="text-right">{canDocument?<Button size="sm" variant="ghost" aria-label={financeIsHistorical(document)?`查看历史记录 ${document.historical?.originalLogNumber||document.number}`:`查看资金单据 ${document.number}`} onClick={()=>open(document.ref)}>查看<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button>:<span className="text-xs text-muted-foreground">无单据查看权限</span>}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </ListTable>
        <p className="text-xs text-muted-foreground">历史记录与本地受控结果均不代表渠道到账。</p>
      </>}
  </section>;
}

export function UserDetailFinance(props:Props) {
  const {adapter,user}=props;
  const full=adapter.snapshot.security.isBoss||adapter.has(PERMISSION.finance);
  const canConsume=full||adapter.has(PERMISSION.userFinanceRead);
  const allowed=canConsume||adapter.has(PERMISSION.walletRead);
  if(!allowed)return <Message kind="denied" title="当前账号没有用户资金查看权限"/>;
  return <div className="space-y-6" data-user-detail-finance>
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><h2 className="text-base font-semibold">可用余额</h2><strong className="text-xl font-semibold tabular-nums">{user.walletSummary?.state==="ready"?money(user.walletSummary.amountCents):user.walletSummary?.state==="denied"?"无查看权限":"待核"}</strong><span className="text-xs text-muted-foreground">已申请提现的金额不计入；可用余额不是资产总额，保证金、押金与在途资金另行核对</span></div>
    {canConsume?<Consumption {...props}/>:null}
    {full?<FinanceDocuments {...props}/>:null}
    {full?<ChannelEvidenceLookup canRead canSearch/>:null}
  </div>;
}
