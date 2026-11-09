import { useEffect, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart, CartesianGrid, ChartBar, ChartContainer, ChartTooltip, ChartTooltipContent, XAxis, YAxis } from '@/components/ui/chart';
import { adminRequest } from '../api';
import { BEIJING_TIME_ZONE, formatBeijingDateTime } from '../workspace/beijing-time';

type Day = { from: string; to: string; count: string };
type Schedule = { schema:'admin-order-schedule.v1'; asOf:string; todayFrom:string; todayTo:string; overdue:string; unknown:string; days:Day[] };
export type ScheduleSelection = { schedule:'DUE'|'SETTLED'; scheduleFrom:string; scheduleTo:string };
const count=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,20})$/.test(value);
const instant=(value:unknown):value is string=>typeof value==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
function parseSchedule(raw:unknown):Schedule{
 const value=raw as Schedule;
 if(!value||value.schema!=='admin-order-schedule.v1'||!instant(value.asOf)||!instant(value.todayFrom)||!instant(value.todayTo)||!count(value.overdue)||!count(value.unknown)||!Array.isArray(value.days)||value.days.length!==7||value.days.some((d,i)=>!instant(d.from)||!instant(d.to)||!count(d.count)||Date.parse(d.to)-Date.parse(d.from)!==86400000||i>0&&d.from!==value.days[i-1]!.to)||value.days[0]!.from!==value.todayFrom||value.days[0]!.to!==value.todayTo)throw new Error('Invalid order schedule');
 return value;
}
const dayLabel=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:BEIJING_TIME_ZONE,month:'numeric',day:'numeric'}).format(new Date(value));
const amount=(value:string)=>BigInt(value).toLocaleString('zh-CN');

export function AdminOrderSchedule({identity,refreshNonce,selection,onSelect}:{identity:string;refreshNonce:number;selection:ScheduleSelection|null;onSelect:(value:ScheduleSelection)=>void}){
 const [state,setState]=useState<{identity:string;data?:Schedule;error?:boolean}>({identity}),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();setState({identity});void adminRequest<unknown>('/orders/schedule-overview',undefined,'GET',{},controller.signal).then(value=>{if(!controller.signal.aborted)setState({identity,data:parseSchedule(value)});}).catch(()=>{if(!controller.signal.aborted)setState({identity,error:true});});return()=>controller.abort();},[identity,refreshNonce,retry]);
 const current=state.identity===identity?state:{identity},data=current.data;
 const selected=(mode:'DUE'|'SETTLED',from:string,to:string)=>selection?.schedule===mode&&selection.scheduleFrom===from&&selection.scheduleTo===to;
 const chart=data?.days.every(day=>BigInt(day.count)<=BigInt(Number.MAX_SAFE_INTEGER))?data.days.map((day,index)=>({...day,label:index===0?'今天到期':index===1?'明天到期':dayLabel(day.from),value:Number(day.count)})):null;
 return <section className="oc-schedule" aria-label="订单到期提醒">
  <div className="oc-schedule-head"><div><h2><CalendarDays size={17} aria-hidden/>订单到期提醒</h2><p>当前权限范围 · 与下方筛选独立</p></div><div className="oc-schedule-actions"><Button size="sm" variant="outline" disabled={!data} aria-pressed={!!data&&selected('DUE','',data.asOf)} onClick={()=>data&&onSelect({schedule:'DUE',scheduleFrom:'',scheduleTo:data.asOf})}>逾期未结算{data?` ${amount(data.overdue)} 单`:''}</Button><Button size="sm" variant="outline" disabled={!data} aria-pressed={!!data&&selected('SETTLED',data.todayFrom,data.todayTo)} onClick={()=>data&&onSelect({schedule:'SETTLED',scheduleFrom:data.todayFrom,scheduleTo:data.todayTo})}>今日已结算</Button><Button size="sm" variant="ghost" aria-label="刷新到期提醒" onClick={()=>setRetry(v=>v+1)}><RefreshCw size={15} aria-hidden/></Button></div></div>
  {current.error?<div role="status" className="oc-schedule-empty">到期提醒暂时无法读取。<Button variant="link" size="sm" onClick={()=>setRetry(v=>v+1)}>重试</Button></div>:!data?<Skeleton className="h-32 w-full"/>:<><div className="oc-schedule-chart">
   {chart?<ChartContainer label="未来七天每日到期订单数" height={130} config={{value:{label:'到期订单',color:'var(--chart-receipts)'}}}><BarChart data={chart} margin={{top:8,right:0,left:0,bottom:0}}><CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5"/><XAxis dataKey="label" hide/><YAxis hide allowDecimals={false}/><ChartTooltip content={<ChartTooltipContent formatValue={point=>`${amount(String(point.count))} 单`}/>}/><ChartBar dataKey="value" cursor="pointer" onClick={(_entry,index)=>{const day=data.days[index];if(day)onSelect({schedule:'DUE',scheduleFrom:day.from,scheduleTo:day.to});}}/></BarChart></ChartContainer>:<p className="oc-schedule-empty">数量过大，图表无法精确绘制；可用下方日期查看。</p>}
   <div className="oc-schedule-axis" aria-label="按到期日期筛选">{data.days.map((day,index)=><Button key={day.from} variant="ghost" className="oc-schedule-tick" aria-label={`${index===0?'今天到期':index===1?'明天到期':dayLabel(day.from)+'到期'} ${amount(day.count)} 单`} aria-pressed={selected('DUE',day.from,day.to)} onClick={()=>onSelect({schedule:'DUE',scheduleFrom:day.from,scheduleTo:day.to})}><span className="oc-schedule-tick-long" aria-hidden>{index===0?'今天到期':index===1?'明天到期':dayLabel(day.from)}</span><span className="oc-schedule-tick-short" aria-hidden>{index===0?'今天':index===1?'明天':dayLabel(day.from)}</span><strong>{amount(day.count)}<small> 单</small></strong></Button>)}</div>
  </div><p className="oc-schedule-foot">按当前库记录统计 · 截至 {formatBeijingDateTime(data.asOf)} · 逾期包含今天已到期的订单 · 待开租或到期时间未确定 {amount(data.unknown)} 单</p></>}
 </section>;
}
