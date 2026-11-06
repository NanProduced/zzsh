import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { adminRequest, ADMIN_AUTH_FAILURE_EVENT, friendlyError } from '../api';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { ListPagination } from '../components/admin-list';
import { financeMoney, financeTime } from './admin-finance-api';

type Period = { from: string | null; to: string; asOf: string; granularity: 'day' | 'month' };
export type ContributionContext = { period:Period; source:'all'|'new'|'legacy'; basis:'settled'|'paid'; userId?:string; userName?:string; pointDate?:string };
type Detail = { version:string; asOf:string; basis:'settled'|'paid'; page:number; pageSize:number; total:string; knownCount:string; knownCents:string|null;
  items:{orderId:string;number:string;source:'NATIVE'|'LEGACY';at:string;paidCents:string|null;ownerCents:string|null;refundCents:string|null;contributionCents:string|null}[] };

function pointRange(context:ContributionContext):{from:string|null;to:string} {
  if (!context.pointDate) return { from:context.period.from,to:context.period.to };
  const start = context.pointDate, end = new Date(`${start}T00:00:00Z`);
  if (context.period.granularity === 'month') end.setUTCMonth(end.getUTCMonth()+1); else end.setUTCDate(end.getUTCDate()+1);
  end.setUTCDate(end.getUTCDate()-1);
  const last=end.toISOString().slice(0,10);
  return { from:context.period.from && context.period.from>start ? context.period.from : start, to:last<context.period.to ? last : context.period.to };
}

export function ContributionSheet({context,onClose,onOpenOrder}:{context:ContributionContext|null;onClose:()=>void;onOpenOrder:(id:string,number:string)=>void}) {
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(20),[value,setValue]=useState<Detail>(),[error,setError]=useState<unknown>(),[retry,setRetry]=useState(0);
  const identity = context ? JSON.stringify(context) : '';
  useEffect(()=>{setPage(1);setPageSize(20);},[identity]);
  useEffect(()=>{
    if (!context) { setValue(undefined);setError(undefined);return; }
    const controller=new AbortController(), range=pointRange(context);
    const query=new URLSearchParams({range:range.from?'custom':'all',source:context.source,basis:context.basis,asOf:context.period.asOf,page:String(page),pageSize:String(pageSize)});
    if(range.from){query.set('from',range.from);query.set('to',range.to);}
    if(context.userId)query.set('userId',context.userId);
    const clear=()=>{controller.abort();setValue(undefined);setError(undefined);};
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT,clear);setValue(undefined);setError(undefined);
    void adminRequest<Detail>(`/finance/dashboard/contributions?${query}`,undefined,'GET',{},controller.signal).then(result=>{if(!controller.signal.aborted)setValue(result);}).catch(cause=>{if(!controller.signal.aborted)setError(cause);});
    return()=>{controller.abort();window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT,clear);};
  },[identity,page,pageSize,retry]);
  const total=value && /^\d+$/.test(value.total) && Number.isSafeInteger(Number(value.total)) ? Number(value.total) : 0;
  return <Sheet open={!!context} onOpenChange={open=>{if(!open)onClose();}}><SheetContent className="funds-contribution-sheet" closeLabel="关闭明细">
    <SheetHeader><SheetTitle>{context?.userName ? `${context.userName}的结算贡献` : '结算贡献明细'}</SheetTitle><SheetDescription>按{context?.basis === 'paid' ? '付款' : '结算'}时间、来源和授权范围重新读取；后续数据变化可能影响结果。</SheetDescription></SheetHeader>
    <div className="funds-contribution-body">{error ? <div className="funds-dash-message" role="status"><p>{friendlyError(error)}</p><Button variant="outline" size="sm" onClick={()=>setRetry(n=>n+1)}>重新读取</Button></div> : !value ? <p className="funds-dash-message" aria-busy="true">正在读取结算明细…</p> : <>
      <p className="funds-dash-note">共 {value.total} 笔 · 可计算 {value.knownCount} 笔 · 已知毛贡献 {financeMoney(value.knownCents)}。旧站记录不代表渠道到账；金额未完整的订单不计入合计。</p>
      <div className="funds-dash-table-wrap"><Table><TableHeader><TableRow><TableHead>订单</TableHead><TableHead>{value.basis==='paid'?'付款时间':'结算时间'}</TableHead><TableHead>实付基数</TableHead><TableHead>号主结算收益</TableHead><TableHead>租客应退</TableHead><TableHead>订单毛贡献</TableHead></TableRow></TableHeader><TableBody>{value.items.map(row=><TableRow key={row.orderId}><TableCell><Button variant="link" className="funds-dash-link" onClick={()=>onOpenOrder(row.orderId,row.number)}>{row.number}<ArrowUpRight size={13}/></Button><small className="block text-muted-foreground">{row.source==='LEGACY'?'旧平台记录':'新平台结算'}</small></TableCell><TableCell>{financeTime(row.at)}</TableCell><TableCell>{financeMoney(row.paidCents)}</TableCell><TableCell>{financeMoney(row.ownerCents)}</TableCell><TableCell>{financeMoney(row.refundCents)}</TableCell><TableCell>{financeMoney(row.contributionCents)}</TableCell></TableRow>)}</TableBody></Table></div>
      <ListPagination mode="page" page={page} pageSize={pageSize} total={total} loadedCount={value.items.length} pageSizeOptions={[20,50,100]} itemLabel="笔订单" loading={false} onPageChange={setPage} onPageSizeChange={size=>{setPageSize(size);setPage(1);}}/>
    </>}</div>
  </SheetContent></Sheet>;
}
