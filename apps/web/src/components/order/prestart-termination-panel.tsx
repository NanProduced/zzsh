"use client";

import { useEffect,useRef,useState } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { OrderRequestError,type Order,type OrderParty,formatOrderTime } from "@/lib/order-client";
import { inspectIntent } from "@/lib/order-intents";
import { walletMoney } from "@/lib/personal-wallet-client";
import { prestartApi,type PrestartView } from "@/lib/prestart-termination-client";
import { performGuardedWrite } from "./order-trade-actions";

const stateText={REQUESTED:"等待客服处理",REVIEW_REQUIRED:"申请需要核对",REJECTED:"结束申请未通过",APPROVED:"结束申请已通过"};
const blockedText:Record<string,string>={RENTAL_ALREADY_STARTED:"账号已开租，请使用结束租用流程",SETTLEMENT_ALREADY_POSTED:"订单已结算，请查看结算记录",
 MANUAL_ADJUSTMENT_REVIEW:"订单金额需要客服先核对",DISTRIBUTION_RECONCILIATION_REQUIRED:"订单信息需要客服先核对",PAYMENT_BASIS_UNAVAILABLE:"付款信息未记录",
 PRESTART_FACTS_UNAVAILABLE:"开租或付款情况未记录",ORDER_NOT_PAID:"当前订单无法申请未开租结束"};

export function PrestartTerminationPanel({order,party,onChanged}:{order:Order;party:OrderParty;onChanged:()=>void}){
 const session=useUserSession(),[state,setState]=useState<{scope:string;read:PrestartView|null;error:OrderRequestError|null}>({scope:'',read:null,error:null});
 const[reason,setReason]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[reload,refresh]=useState(0),[pending,setPending]=useState(false),sequence=useRef(0);
 const{userId}=useIdentityReset(session,()=>{sequence.current++;setState({scope:'',read:null,error:null});setReason('');setNote('');setBusy(false);setPending(false);});
 const scope=`${userId}:${order.id}`,scopeRef=useRef(scope);scopeRef.current=scope;
 const applicable=order.source?.origin!=='LEGACY'&&!order.readOnly&&['PAID','CANCELLED'].includes(order.status);
 useEffect(()=>{const controller=new AbortController(),n=++sequence.current;
  setState({scope,read:null,error:null});if(!userId||!applicable)return()=>controller.abort();
  const intent=inspectIntent(userId,'order.prestart.request',order.id);setPending(intent.state!=='NONE');
  if(intent.state==='UNREADABLE')setNote('暂时无法确认上次申请，请联系客服');
  void prestartApi.read(userId,order.id,controller.signal).then(read=>{if(!controller.signal.aborted&&n===sequence.current&&scopeRef.current===scope)setState({scope,read,error:null});},
   e=>{if(!controller.signal.aborted&&n===sequence.current&&scopeRef.current===scope)setState({scope,read:null,error:e instanceof OrderRequestError?e:new OrderRequestError(503,null)});});
  return()=>controller.abort();
 },[userId,order.id,reload,scope,applicable]);
 const visible=state.scope===scope?state:null,read=visible?.read;
 if(!userId||!applicable)return null;
 if(read&&!read.request&&!read.eligibility.allowed&&read.eligibility.reason==='ORDER_NOT_PAID')return null;
 const submit=async()=>{
  if(!read||!userId||busy)return;const expectedScope=scope;
  if(inspectIntent(userId,'order.prestart.request',order.id).state==='UNREADABLE'){setNote('暂时无法确认上次申请，请联系客服');return;}
  setBusy(true);
  const out=await performGuardedWrite(userId,'order.prestart.request',order.id,{expectedOrderRevision:read.orderRevision,reason},undefined,
   (key,body)=>prestartApi.request(userId,order.id,key,body));
  if(scopeRef.current!==expectedScope)return;setBusy(false);
  if(out.status==='ok'){setPending(false);setNote('结束申请已提交，请等待客服处理。');refresh(n=>n+1);onChanged();}
  else{setPending(inspectIntent(userId,'order.prestart.request',order.id).state!=='NONE');setNote(out.status==='unauthorized'?'登录状态已变化，请重新登录查看上次申请。':out.status==='unknown'||out.status==='recovery-unresolved'?'申请结果未记录，请稍后继续处理上次申请。':out.status==='blocked'?'暂时无法继续申请，请联系客服。':'申请未完成，请核对信息后重试。');}
 };
 return <section className="order-detail-section order-prestart-section" aria-label="未开租结束申请"><details className="order-secondary-details" open={Boolean(read?.request || pending || note || visible?.error)}><summary><h2 className="order-section-title">未开租结束</h2><span>{read?.request ? stateText[read.request.state] : '尚未开租需要取消？查看申请条件'}</span></summary><div className="order-prestart-content">
  <p className="order-muted">双方尚未开租时可申请结束，客服会核实后处理。</p>
  {!visible||!visible.read&&!visible.error?<p role="status" className="order-muted">正在查看申请条件…</p>:visible.error?<p role="alert">暂时无法查看申请，请稍后重试。{visible.error.requestId?` 查询编号：${visible.error.requestId}`:''}</p>:null}
  {read?.request?<><p role="status">{stateText[read.request.state]}</p><p className="order-muted">{read.request.reason}{read.request.reviewReason?` · 客服核实：${read.request.reviewReason}`:''}</p>
   {party==='renter'?<><p>原付款记录金额：{walletMoney(read.request.fullRefundCents)}</p>{!read.request.liabilityRecognized?<p className="order-muted">退款情况以审核结果为准。</p>:null}</>:null}
   <p className="order-muted">{formatOrderTime(read.request.updatedAt)}{read.request.dataOrigin==='LOCAL_CONTROLLED'?' · 测试记录，不代表真实退款':''}</p>
   {read.request.state==='APPROVED'?<div className="order-muted" aria-label="退款进度">
    {read.refund?.intents?.length?<ul>{read.refund.intents.map((item,n)=><li key={item.intentId??n}>{item.refundOrderNo??'退款申请'} · {({READY:'待处理',SUBMITTING:'提交中',UNKNOWN:'结果未记录',PROCESSING:'处理中',REVIEW_REQUIRED:'需要核对',SUCCEEDED:'到账未记录',FAILED:'本次退款未完成',CONFLICT:'需要核对'} as Record<string,string>)[item.state]??'状态未记录'}{item.blockedReason?' · 请联系客服':''}</li>)}</ul>:<p>退款进度未记录。</p>}
    {read.refund?.truncated?<p>部分退款记录仍在核对。</p>:null}<p>到账情况请以收款记录为准。</p>
   </div>:null}</>:null}
  {read&&(!read.request||read.request.state==='REJECTED')&&read.eligibility.allowed||pending?<form onSubmit={e=>{e.preventDefault();void submit();}} className="order-trade-form">
   <label>结束原因<textarea aria-label="未开租结束原因" value={reason} maxLength={150} disabled={busy||pending} onChange={e=>setReason(e.target.value)}/></label>
   <button type="submit" className="button secondary button--sm" disabled={busy||!read||!pending&&reason.trim().length<3}>{busy?'正在提交…':pending?'继续提交上次申请':'申请未开租结束'}</button>
  </form>:read&&!read.request?<p className="order-muted">{blockedText[read.eligibility.reason??'']??'申请条件未记录'}</p>:null}
  {note?<p role="status" className="order-muted">{note}</p>:null}<button type="button" className="button quiet button--sm" disabled={busy} onClick={()=>refresh(n=>n+1)}>刷新</button>
 </div></details></section>;
}
