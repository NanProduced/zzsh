import { CreditCard, FileText, Flag, KeyRound, X } from 'lucide-react';
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from '../components/reui/timeline';
import type { SettlementReadView } from '../lib/order-fulfillment-client';
import type { LegacyAdminView } from '../lib/legacy-continuation-client';
import type { OrderProgress, OrderStagesPayment, OrderStagesSource } from './admin-order-stages';

type OrderFact={status:string;createdAt:string|null;paidAt:string|null;completedAt?:string|null;cancelledAt?:string|null;payment:OrderStagesPayment;source:OrderStagesSource;progress?:OrderProgress|null};
type Event={id:string;title:string;time?:string|null;timeLabel?:string;timeText?:string;detail?:string;lines?:string[];state:'done'|'current'|'unknown';icon:typeof FileText};
const party=(value?:string)=>value==='RENTER'?'租客':value==='OWNER'?'号主':value==='SUPPORT'?'客服':'相关方';
const source=(value?:string)=>value==='ON_BEHALF'?'客服协助确认':value==='AUTO'?'系统自动确认':value==='PARTY'?'本人确认':'确认方式未记录';
const action=(value?:string)=>value==='CONFIRM'?'已确认':value==='REJECT'?'已拒绝':value==='REVIEW'?'已复核':value==='FINALIZE'?'已确认结算':'状态待核对';

/** Display only source-backed events; no payment or opening state is inferred from a group. */
export function OrderFulfillmentTimeline({order,settlement,legacy,paymentTitle,paymentTimeText,formatTime}:{order:OrderFact;settlement:SettlementReadView|null;legacy:LegacyAdminView|null;paymentTitle:string;paymentTimeText:string;formatTime:(value:string|null|undefined)=>string}){
 const old=order.source.origin==='LEGACY';
 const events:Event[]=[{id:'created',title:'订单创建',time:order.createdAt,timeLabel:'创建时间',state:order.createdAt?'done':'unknown',icon:FileText}];
 const paid=order.payment?.state==='RECORDED_PAID';
 events.push({id:'payment',title:paymentTitle,timeText:paymentTimeText,detail:old?'旧站记录，渠道到账另行核对。':undefined,state:paid?'done':order.payment?.state==='RECORDED_UNPAID'?'current':'unknown',icon:CreditCard});
 if(!old&&order.status!=='PENDING_PAYMENT'){
  const opening=settlement?.openings?.at(-1),progress=order.progress?.opening;
  if(opening){
   const acknowledgements=(opening.acks??[]).filter(a=>a.party==='RENTER'||a.party==='OWNER');
   const lines=acknowledgements.map(a=>`${party(a.party)}：${source(a.source)}${a.createdAt?` · ${formatTime(a.createdAt)}`:''}`);
   if(opening.status==='DRAFT')for(const p of ['RENTER','OWNER'])if(!acknowledgements.some(a=>a.party===p))lines.push(`${party(p)}：待确认`);
   events.push({id:'opening',title:opening.status==='CONFIRMED'?'开租已确认':opening.status==='DRAFT'?'等待双方确认开租':'开租状态未记录',time:opening.status==='CONFIRMED'?opening.confirmedAt:opening.createdAt,timeLabel:opening.status==='CONFIRMED'?'开租时间':'发起时间',detail:opening.versionNo?`开租清单第 ${opening.versionNo} 版`:undefined,lines,state:opening.status==='CONFIRMED'?'done':opening.status==='DRAFT'?'current':'unknown',icon:KeyRound});
  }else if(progress?.state==='CONFIRMED')events.push({id:'opening',title:'开租已确认',time:progress.confirmedAtUtc,timeLabel:'开租时间',state:'done',icon:KeyRound});
  else if(order.status==='PAID'&&progress?.state==='NOT_STARTED')events.push({id:'opening',title:'待发起开租确认',detail:'客服核对本单资源后发起，租客与号主再确认。',state:'current',icon:KeyRound});
  else if(order.status==='PAID'&&progress?.state==='AWAITING_CONFIRMATION')events.push({id:'opening',title:'等待双方确认开租',detail:'确认明细暂未读取。',state:'current',icon:KeyRound});
  else if(order.status==='PAID'&&progress?.state==='UNKNOWN')events.push({id:'opening',title:'开租进度未读取',state:'unknown',icon:KeyRound});
  const intake=settlement?.intakes?.at(-1),version=settlement?.settlement,posting=settlement?.posting;
  const postedVersion=posting?.settlementVersionId&&posting.versionHash?settlement?.versions?.find(v=>v.id===posting.settlementVersionId&&v.versionHash===posting.versionHash):undefined;
  const decisions=(item:typeof version)=>(item?.decisions??[]).map(d=>`${party(d.party)}：${action(d.action)}${d.createdAt?` · ${formatTime(d.createdAt)}`:''}${d.reason?` · ${d.reason}`:''}`);
  if(intake?.status==='OPEN')events.push({id:'intake',title:'结束申请待处理',time:intake.createdAt,timeLabel:'申请时间',detail:`${party(intake.initiatorParty)}发起结束申请`,state:'current',icon:Flag});
  if(version&&!posting)events.push({id:'settlement',title:'结算方案待处理',detail:`${version.versionNo?`第 ${version.versionNo} 版 · `:''}${version.early===true?'提前结算':version.early===false?'正常结算':'结算方式未记录'}`,lines:decisions(version),state:'current',icon:Flag});
  const postedAt=posting?.postedAt??order.progress?.ending.postedAtUtc;
  if(posting||order.progress?.ending.state==='POSTED')events.push({id:'posted',title:'结算已过账',time:postedAt,timeLabel:'过账时间',detail:`${postedVersion?.versionNo?`结算方案第 ${postedVersion.versionNo} 版。`:''}退款处理与渠道到账在资金记录中核对。`,lines:decisions(postedVersion),state:'done',icon:Flag});
 }else if(old&&order.status==='PAID'){
  const stage=legacy?.stage==='8'?'等待号主确认结算':legacy?.stage==='9'?'等待租客确认结算':order.source.statusLabel?.trim()||'进行中';
  events.push({id:'legacy-stage',title:stage,detail:'旧站订单按原阶段办理；未记录的开租节点不补造。',state:'current',icon:KeyRound});
 }
 if(order.status==='CANCELLED')events.push({id:'cancelled',title:'订单已取消',time:order.cancelledAt,timeLabel:'取消时间',detail:paid?'退款进度需单独核对。':undefined,state:'done',icon:X});
 else if(order.status==='COMPLETED'&&(old||!(order.progress?.ending.state==='POSTED'||settlement?.posting)))events.push({id:'completed',title:old?'订单完成（旧站记录）':'订单完成',time:order.completedAt,timeLabel:'完成时间',state:'done',icon:Flag});
 return <section className="oc-section oc-fulfillment-history"><div className="oc-fulfillment-heading"><h2>履约与处理记录</h2><span>北京时间</span></div>
  <Timeline value={0} orientation="vertical" role="list" aria-label="履约与处理时间线" className="oc-fulfillment-timeline">
   {events.map((event,index)=><TimelineItem key={event.id} step={index+1} role="listitem" data-state={event.state}><TimelineSeparator/><TimelineIndicator><event.icon size={14} aria-hidden="true"/></TimelineIndicator><TimelineHeader><TimelineTitle>{event.title}</TimelineTitle>{event.timeText||event.timeLabel?<TimelineDate>{event.timeText??(event.time?`${event.timeLabel} · ${formatTime(event.time)}`:`${event.timeLabel}未记录`)}</TimelineDate>:null}</TimelineHeader>{event.detail||event.lines?.length?<TimelineContent>{event.detail?<p>{event.detail}</p>:null}{event.lines?.length?<ul>{event.lines.map((line,i)=><li key={i}>{line}</li>)}</ul>:null}</TimelineContent>:null}</TimelineItem>)}
  </Timeline>
 </section>;
}
