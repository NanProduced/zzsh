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
import { defaultFinanceFilters, financeMoney, financeTime, type FinanceFilters } from "../admin-finance-api";
import { financeContextIdentity, rangeDays, registerFinanceOrigin } from "../admin-finance-view";
import { financeActivityState } from "../finance-activity";
import { PERMISSION, type User } from "./user-directory-data";
import { ChannelEvidenceLookup } from "../admin-channel-evidence-panel";
import { errorText, Message, useDirectoryRequest, type PageProps, type UserDirectoryData } from "./user-directory-shared";
import { sanitizeFinanceReturn, type WorkspaceTab } from '@/workspace/tab-model';
import { beijingCalendarDate, beijingRangeStart } from '@/workspace/beijing-time';

type Props = Pick<PageProps,"refreshNonce"|"onOpenPath"> & { adapter:UserDirectoryData; user:User; tab?:WorkspaceTab; onQueryChange?:(query:Record<string,string>)=>void };
const components = {haffRentCents:"哈夫币实耗租金",itemConsumptionCents:"物品实耗费用",earlyMakeupCents:"提前结束补足",renterFeeCents:"租客承担包赔费"} as const;
const previewKinds:Record<string,string>={PAYMENT:'收款',REFUND:'退款',WITHDRAWAL:'提现'};
const previewRoles:Record<string,string>={RENTER:'租客',OWNER:'号主',WITHDRAWER:'本人提现',RELATED_USER:'本人关联'};
const money = (value:string|null|undefined) => value == null ? "未记录" : financeMoney(value);
const day = (date:Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const identity = (adapter:UserDirectoryData) => `${adapter.snapshot.adminUserId}:${adapter.snapshot.session.id}:${adapter.snapshot.security.isBoss}:${[...adapter.snapshot.permissions].sort().join("|")}`;
const documentFilters = (userId:string, now=new Date()):FinanceFilters => ({...defaultFinanceFilters(true),scope:userId,from:beijingCalendarDate(beijingRangeStart('7d',now)),to:beijingCalendarDate(now)});

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
          <span className="text-sm text-muted-foreground">{result.data.knowledge==="UNKNOWN"?`${result.data.unknownCount} 笔未记录，已核部分 ${money(result.data.knownAmountCents)}`:"不含押金、号主收入和分销奖励"}</span>
        </div>
        <dl className="grid grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2 xl:grid-cols-4">
          {Object.entries(components).map(([key,label])=><div key={key}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-medium tabular-nums">{money(result.data.components[key as keyof typeof components])}</dd></div>)}
        </dl>
        <p className="text-xs text-muted-foreground">旧平台消费暂不能汇总。历史账目与新平台结算分开核对。</p>
        {result.data.unknownCount>0?<Message title="部分结算金额未记录">相关订单的调整金额或结算依据尚未核清，未计入完整合计。</Message>:null}
        <ListTable empty={result.data.total===0?<p className="text-sm text-muted-foreground">暂无新平台已结算消费。</p>:undefined}>
          <Table aria-label="用户租赁消费明细" className="min-w-[860px]">
            <TableHeader><TableRow><TableHead>订单 / 结算时间</TableHead>{Object.values(components).map(label=><TableHead key={label} className="text-right">{label}</TableHead>)}<TableHead className="text-right">本单消费</TableHead><TableHead>核对状态</TableHead></TableRow></TableHeader>
            <TableBody>{result.data.items.map(item=><TableRow key={item.postingId}>
              <TableCell>{canOrder?<Button variant="link" className="h-auto p-0 text-foreground" onClick={()=>onOpenPath(`/orders/${encodeURIComponent(item.orderId)}`,item.displayNo)}>{item.displayNo}<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button>:<span className="font-medium">{item.displayNo}</span>}<span className="mt-1 block text-xs text-muted-foreground">{financeTime(item.postedAt)}</span></TableCell>
              {Object.keys(components).map(key=><TableCell key={key} className="text-right tabular-nums">{money(item[key as keyof typeof components])}</TableCell>)}
              <TableCell className="text-right font-medium tabular-nums">{money(item.amountCents)}</TableCell>
              <TableCell><Badge variant={item.knowledge==="KNOWN"?"success":"warning"}>{item.knowledge==="KNOWN"?"已核对":item.reasonCodes.includes("MANUAL_RENTER_ADJUSTMENT_UNALLOCATED")?"调整未记录":"结算未记录"}</Badge></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </ListTable>
        <ListPagination mode="page" page={current.page} pageSize={current.pageSize} total={result.data.total} loading={false} itemLabel="笔结算" pageSizeOptions={[10,20,50]}
          onPageChange={page=>setPagination({...current,page})} onPageSizeChange={pageSize=>setPagination({...current,page:1,pageSize})}/>
      </>}
  </section>;
}

function FinanceDocuments({adapter,user,refreshNonce,onOpenPath,tab,onQueryChange}:Props) {
  const savedFrom=tab?.query.financeFrom,savedTo=tab?.query.financeTo,savedDays=rangeDays(savedFrom??'',savedTo??'');
  const savedRangeValid=Boolean(savedFrom&&savedTo&&savedDays>0&&savedDays<=367);
  const incoming={...documentFilters(user.id),...(savedRangeValid?{from:savedFrom!,to:savedTo!}:{})};
  const navigation=JSON.stringify([user.id,incoming.from,incoming.to]),previousNavigation=useRef(navigation);
  const [draft,setDraft]=useState<FinanceFilters>(incoming);
  const [applied,setApplied]=useState<FinanceFilters>(draft);
  const [dateOpen,setDateOpen]=useState(false);
  const days=rangeDays(draft.from,draft.to),dateError=draft.from&&draft.to&&!(days>0&&days<=367)?"请选择有效的日期范围，单次最多 367 天。":undefined;
  const [selectedDate,setSelectedDate]=useState<DateSelectorValue>(()=>({period:"day",operator:"between",startDate:new Date(`${draft.from}T00:00:00`),endDate:new Date(`${draft.to}T00:00:00`)}));
  useLayoutEffect(()=>{if(previousNavigation.current===navigation)return;previousNavigation.current=navigation;setDraft(incoming);setApplied(incoming);setSelectedDate({period:'day',operator:'between',startDate:new Date(`${incoming.from}T00:00:00`),endDate:new Date(`${incoming.to}T00:00:00`)});},[navigation]);
  const {result,retry}=useDirectoryRequest(`${identity(adapter)}:${user.id}:finance-documents:${applied.from}:${applied.to}:${refreshNonce}`,
    signal=>adapter.financeActivity(user.id,signal,applied.from,applied.to));
  const canDocument=adapter.snapshot.security.isBoss||adapter.has("finance.document.read");
  const openRelated=(path:string,title?:string)=>{
    const source=sanitizeFinanceReturn(`/users/${encodeURIComponent(user.id)}?${new URLSearchParams({section:'finance',financeFrom:applied.from,financeTo:applied.to})}`),target=sanitizeFinanceReturn(path);
    if(!source||!target)return;
    const origin=registerFinanceOrigin(source,financeContextIdentity(adapter.snapshot)),url=new URL(target,window.location.origin);
    url.searchParams.set(url.pathname.startsWith('/finance/')?'origin':'financeOrigin',origin);url.searchParams.set('financeReturn',source);
    onOpenPath(url.pathname+'?'+url.searchParams,title);
  };
  const open=(ref?:string)=>openRelated(ref?`/finance/documents/${encodeURIComponent(ref)}`:`/finance/users/${encodeURIComponent(user.id)}?${new URLSearchParams({financeFrom:applied.from,financeTo:applied.to})}`,ref?'资金单据':`${user.name} · 资金`);
  const openHistory=()=>openRelated(`/finance/users/${encodeURIComponent(user.id)}?${new URLSearchParams({financeView:'finance-record-history',financeFrom:applied.from,financeTo:applied.to})}`,`${user.name} · 旧平台资金记录`);
  const apply=(next:FinanceFilters)=>{setApplied(next);onQueryChange?.({...tab?.query,section:'finance',financeFrom:next.from,financeTo:next.to});if(applied.from===next.from&&applied.to===next.to)retry();};
  return <section className="space-y-4 border-t pt-6" aria-labelledby="user-finance-documents-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 id="user-finance-documents-heading" className="text-base font-semibold">资金记录</h3><p className="mt-1 text-xs text-muted-foreground">新平台收款、退款与提现记录</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={openHistory}>查看旧平台记录</Button><Button variant="outline" size="sm" onClick={()=>open()}>查看用户资金详情<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button></div></div>
    <form className="space-y-2" onSubmit={event=>{event.preventDefault();if(days>0&&days<=367)apply({...draft,scope:user.id});}}>
      <div className="flex flex-wrap items-end gap-3"><Field label="单据发生时间" error={dateError} composite className="w-auto max-w-full">
        <Popover open={dateOpen} onOpenChange={setDateOpen}>
          <PopoverTrigger render={<Button type="button" variant="outline" aria-label="选择单据日期范围"/>}><CalendarDaysIcon aria-hidden className="size-4"/>{draft.from||"开始日期"} 至 {draft.to||"结束日期"}</PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0">
            <DateSelector value={selectedDate} presetMode="between" allowRange showTwoMonths={false} showInput={false}
              presets={[{label:"今天",days:0},{label:"近7天",days:7},{label:"近30天",days:30}]}
              onChange={next=>{setSelectedDate(next);setDraft({...draft,from:next.startDate?day(next.startDate):"",to:next.endDate?day(next.endDate):""});if(next.startDate&&next.endDate)setDateOpen(false);}}/>
          </PopoverContent>
        </Popover>
      </Field>
      <Button type="submit" disabled={!(days>0&&days<=367)||result.state==="loading"}>查询</Button>
      <Button type="button" variant="ghost" onClick={()=>{const recent=documentFilters(user.id);setDraft(recent);apply(recent);setSelectedDate({period:"day",operator:"between",startDate:new Date(`${recent.from}T00:00:00`),endDate:new Date(`${recent.to}T00:00:00`)});}}>恢复近 7 天</Button>
      </div><p className="text-xs text-muted-foreground">按北京时间查询，包含起止日期。</p>
    </form>
    {(savedFrom||savedTo)&&!savedRangeValid?<p role="status" className="text-xs text-muted-foreground">原日期范围无效，已显示近 7 天。</p>:null}
    {draft.from!==applied.from||draft.to!==applied.to?<p className="text-xs text-muted-foreground">当前结果仍为 {applied.from} 至 {applied.to}，点击“查询”应用新范围。</p>:null}
    {result.state==="loading"?<FinanceLoading label="正在读取资金记录"/>:result.state==="error"?
      <Message kind="error" title="资金记录读取失败" retry={retry}>{errorText(result.error)}</Message>:<>
        <ListTable empty={!result.data.items.length?<p className="text-sm text-muted-foreground">所选日期暂无新平台资金记录，可查看旧平台记录。</p>:undefined}>
          <Table aria-label="用户资金记录" className="min-w-[620px]"><TableHeader><TableRow><TableHead>时间 / 记录</TableHead><TableHead>用户身份</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
            <TableBody>{result.data.items.map(item=><TableRow key={item.id}>
              <TableCell className="min-w-52 whitespace-normal"><span className="font-medium">{previewKinds[item.kind]??'资金记录'}</span><span className="mt-1 block text-xs text-muted-foreground">{item.number??'编号未记录'} · {financeTime(item.occurredAt)}</span></TableCell>
              <TableCell>{previewRoles[item.subjectRole??'']??'关联待核'}</TableCell>
              <TableCell className="tabular-nums">{money(item.amountCents)}<small className="block text-muted-foreground">{item.amountLabel}</small></TableCell>
              <TableCell><Badge variant={item.state==='UNKNOWN'||item.state==='REVIEW_REQUIRED'?'warning':'secondary'}>{financeActivityState(item.state)}</Badge></TableCell>
              <TableCell className="text-right">{canDocument&&item.documentRef?<Button size="sm" variant="ghost" aria-label={`查看资金记录 ${item.number??''}`} onClick={()=>open(item.documentRef!)}>查看<ArrowUpRightIcon aria-hidden className="size-3.5"/></Button>:<span className="text-xs text-muted-foreground">—</span>}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </ListTable>
        <p className="text-xs text-muted-foreground">显示最近 {result.data.items.length} 条，共 {result.data.total} 条；提交不代表渠道到账。</p>
      </>}
  </section>;
}

export function UserDetailFinance(props:Props) {
  const {adapter,user,onOpenPath}=props;
  const full=adapter.snapshot.security.isBoss||adapter.has(PERMISSION.finance);
  const canConsume=full||adapter.has(PERMISSION.userFinanceRead);
  const allowed=canConsume||adapter.has(PERMISSION.walletRead);
  const canOrder=adapter.snapshot.security.isBoss||adapter.has(PERMISSION.orders);
  if(!allowed)return <Message kind="denied" title="当前账号没有用户资金查看权限"/>;
  return <div className="space-y-6" data-user-detail-finance>
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1"><h2 className="text-base font-semibold">可用余额</h2><strong className="text-xl font-semibold tabular-nums">{user.walletSummary?.state==="ready"?money(user.walletSummary.amountCents):user.walletSummary?.state==="denied"?"无查看权限":"未记录"}</strong><span className="text-xs text-muted-foreground">已申请提现的金额不计入；可用余额不是资产总额，保证金、押金与在途资金另行核对</span></div>
    {canConsume?<Consumption {...props}/>:null}
    {full?<FinanceDocuments {...props}/>:null}
    {full?<section className="space-y-4 border-t pt-6" aria-labelledby="user-channel-evidence-heading">
      <div className="flex flex-wrap items-center gap-2"><h3 id="user-channel-evidence-heading" className="text-base font-semibold">汇聚渠道记录</h3><Badge variant="secondary">仅当前用户</Badge></div>
      <p className="text-sm text-muted-foreground">仅查询新平台已保存的渠道记录；收退款包含本人作为租客或号主的订单，提现仅包含本人的申请。旧平台记录可在上方查看。</p>
      <ChannelEvidenceLookup key={`${identity(adapter)}:${user.id}`} canRead canSearch subjectUserId={user.id} canReadOrders={canOrder} onOpenOrder={canOrder ? id=>onOpenPath(`/orders/${encodeURIComponent(id)}?section=finance`) : undefined}/>
    </section>:null}
  </div>;
}
