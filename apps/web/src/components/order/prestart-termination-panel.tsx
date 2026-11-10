"use client";

import { useEffect,useRef,useState } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { OrderRequestError,type Order,type OrderParty,formatOrderTime } from "@/lib/order-client";
import { inspectIntent } from "@/lib/order-intents";
import { walletMoney } from "@/lib/personal-wallet-client";
import { prestartApi,type PrestartView } from "@/lib/prestart-termination-client";
import { FormSelect,Textarea } from "@/components/ui/form-controls";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import { performGuardedWrite } from "./order-trade-actions";

const stateText={REQUESTED:"订单尚未取消",REVIEW_REQUIRED:"取消信息需要核对",REJECTED:"此前申请未通过",APPROVED:"订单已取消"};
const blockedText:Record<string,string>={RENTAL_ALREADY_STARTED:"账号已开租，请使用结束租用流程",SETTLEMENT_ALREADY_POSTED:"订单已结算，请查看结算记录",
 MANUAL_ADJUSTMENT_REVIEW:"订单金额需要客服先核对",DISTRIBUTION_RECONCILIATION_REQUIRED:"订单信息需要客服先核对",PAYMENT_BASIS_UNAVAILABLE:"付款信息未记录",
 PRESTART_FACTS_UNAVAILABLE:"开租或付款情况未记录",ORDER_NOT_PAID:"当前订单无法申请未开租结束"};

export function PrestartTerminationPanel({order,party,onChanged}:{order:Order;party:OrderParty;onChanged:()=>void}){
 const session=useUserSession(),[state,setState]=useState<{scope:string;read:PrestartView|null;error:OrderRequestError|null}>({scope:'',read:null,error:null});
 const[reasonCode,setReasonCode]=useState(''),[otherReason,setOtherReason]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[reload,refresh]=useState(0),
  [pending,setPending]=useState<'old'|'cancel'|'unreadable'|null>(null),[confirmOpen,setConfirmOpen]=useState(false),sequence=useRef(0);
 const{userId,isCurrent}=useIdentityReset(session,()=>{sequence.current++;setState({scope:'',read:null,error:null});setReasonCode('');setOtherReason('');setNote('');setBusy(false);setPending(null);setConfirmOpen(false);});
 const scope=JSON.stringify([userId,session.identityVersion,order.id]),scopeRef=useRef(scope);scopeRef.current=scope;
 const applicable=order.source?.origin!=='LEGACY'&&!order.readOnly&&['PAID','CANCELLED'].includes(order.status);
 useEffect(()=>{const controller=new AbortController(),n=++sequence.current;
  setState({scope,read:null,error:null});if(!userId||!applicable)return()=>controller.abort();
  const old=inspectIntent(userId,'order.prestart.request',order.id),cancel=inspectIntent(userId,'order.prestart.cancel',order.id);
  const next=old.state==='UNREADABLE'||cancel.state==='UNREADABLE'||old.state!=='NONE'&&cancel.state!=='NONE'?'unreadable'
   :old.state!=='NONE'?'old':cancel.state!=='NONE'?'cancel':null;
  setPending(next);if(next==='unreadable')setNote('暂时无法确认上次请求，请联系客服');
  void prestartApi.read(userId,order.id,controller.signal).then(read=>{if(!controller.signal.aborted&&n===sequence.current&&scopeRef.current===scope)setState({scope,read,error:null});},
   e=>{if(!controller.signal.aborted&&n===sequence.current&&scopeRef.current===scope)setState({scope,read:null,error:e instanceof OrderRequestError?e:new OrderRequestError(503,null)});});
  return()=>controller.abort();
 },[userId,order.id,reload,scope,applicable]);
 const visible=state.scope===scope?state:null,read=visible?.read;
 if(!userId||!applicable)return null;
 if(read&&!read.request&&!read.eligibility.allowed&&read.eligibility.reason==='ORDER_NOT_PAID')return null;
 const submit=async()=>{
  if(!read||!userId||busy)return;const expectedScope=scope;
  if(pending==='unreadable'){setNote('暂时无法确认上次请求，请联系客服');return;}
  const recoveringOld=pending==='old',kind=recoveringOld?'order.prestart.request':'order.prestart.cancel';
  if(inspectIntent(userId,kind,order.id).state==='UNREADABLE'){setNote('暂时无法确认上次请求，请联系客服');return;}
  setBusy(true);
  const out=await performGuardedWrite(userId,kind,order.id,{expectedOrderRevision:read.orderRevision,reasonCode,
   ...(reasonCode==='OTHER'?{otherReason:otherReason.trim()}:{})},undefined,
   (key,body,_context,subject)=>prestartApi.request(subject,order.id,key,body,recoveringOld?'requests':'cancel'),isCurrent);
  if(scopeRef.current!==expectedScope)return;setBusy(false);
  if(out.status==='ok'){setPending(null);setConfirmOpen(false);
   setNote(recoveringOld&&!out.value.request?'上次申请未提交，你可以重新选择原因并取消订单。'
    :recoveringOld?'已找回上次申请；若仍未开租，可直接取消订单。':'订单已取消，退款进度请查看下方记录。');refresh(n=>n+1);onChanged();}
  else{setPending(inspectIntent(userId,kind,order.id).state!=='NONE'?(recoveringOld?'old':'cancel'):null);
   setNote(out.status==='unauthorized'?'登录状态已变化，请重新登录查看上次请求。':out.status==='unknown'||out.status==='recovery-unresolved'?'结果尚未确认，请按原请求核对。':out.status==='blocked'?'暂时无法继续，请联系客服。':'取消未完成，请刷新后重试。');}
 };
 const canChoose=Boolean(read?.eligibility.allowed&&read.cancellationReasons.length&&(!read.request||read.request.state!=='APPROVED'));
 return <section className="order-detail-section order-prestart-section" aria-label="未开租取消订单"><details className="order-secondary-details" open={Boolean(read?.request || pending || note || visible?.error)}><summary><h2 className="order-section-title">取消订单</h2><span>{read?.request ? stateText[read.request.state] : '尚未开租可取消订单'}</span></summary><div className="order-prestart-content">
  <p className="order-muted">双方确认开租前可取消订单，租客的实付金额将原路退回。</p>
  {!visible||!visible.read&&!visible.error?<p role="status" className="order-muted">正在查看取消条件…</p>:visible.error?<p role="alert">暂时无法查看取消条件，请稍后重试。{visible.error.requestId?` 查询编号：${visible.error.requestId}`:''}</p>:null}
  {read?.request?<><p role="status">{stateText[read.request.state]}</p><p className="order-muted">{read.request.reason}{read.request.reviewReason&&read.request.reviewReason!==read.request.reason?` · ${read.request.reviewReason}`:''}</p>
   {party==='renter'?<><p>原付款记录金额：{walletMoney(read.request.fullRefundCents)}</p>{!read.request.liabilityRecognized?<p className="order-muted">订单尚未取消。</p>:null}</>:null}
   <p className="order-muted">{formatOrderTime(read.request.updatedAt)}{read.request.dataOrigin==='LOCAL_CONTROLLED'?' · 测试记录，不代表真实退款':''}</p>
   {read.request.state==='APPROVED'&&party==='renter'?<p className="order-muted">退款进度请查看下方退款记录。</p>:null}</>:null}
  {pending==='old'?<button type="button" className="button secondary button--sm" disabled={busy||!read} onClick={()=>void submit()}>查询上次申请</button>
   :pending==='unreadable'?null:canChoose||pending==='cancel'?<form onSubmit={e=>{e.preventDefault();setConfirmOpen(true);}} className="order-trade-form">
   {!pending?<><label htmlFor="prestart-cancel-reason">取消原因</label><FormSelect id="prestart-cancel-reason" label="取消原因" value={reasonCode}
    options={(read?.cancellationReasons??[]).map(item=>({value:item.code,label:item.label}))} onChange={setReasonCode} required/>
    {reasonCode==='OTHER'?<label>原因说明<Textarea aria-label="原因说明" value={otherReason} maxLength={150} onChange={e=>setOtherReason(e.target.value)}/></label>:null}</>:null}
   <button type="submit" className="button secondary button--sm" disabled={busy||!read||!pending&&(!reasonCode||reasonCode==='OTHER'&&otherReason.trim().length<3)}>
    {pending==='cancel'?'核对上次取消请求':'取消订单并退款'}</button>
  </form>:read&&!read.request?<p className="order-muted">{read.eligibility.allowed?'取消功能暂不可用，请刷新后重试。':blockedText[read.eligibility.reason??'']??'取消条件未记录'}</p>:null}
  {note?<p role="status" className="order-muted">{note}</p>:null}<button type="button" className="button quiet button--sm" disabled={busy} onClick={()=>refresh(n=>n+1)}>刷新</button>
  <ConfirmAlertDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={pending==='cancel'?'核对取消请求':'确认取消订单？'}
   description={pending==='cancel'?'上次请求的结果尚未确认，将按原请求核对。':'订单将立即取消，租客的实付金额会原路退回，具体到账时间以收款记录为准。'}
   consequences={note?<p role="status">{note}</p>:undefined} confirmLabel={busy?'处理中…':pending==='cancel'?'核对原请求':'确认取消订单'}
   cancelLabel="返回" onConfirm={()=>void submit()} busy={busy}/>
 </div></details></section>;
}
