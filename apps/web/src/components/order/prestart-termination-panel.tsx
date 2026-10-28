"use client";

import { useEffect,useRef,useState } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { OrderRequestError,type Order,type OrderParty,formatOrderTime } from "@/lib/order-client";
import { inspectIntent } from "@/lib/order-intents";
import { walletMoney } from "@/lib/personal-wallet-client";
import { prestartApi,type PrestartView } from "@/lib/prestart-termination-client";
import { performGuardedWrite } from "./order-trade-actions";

const stateText={REQUESTED:"等待客服核实",REVIEW_REQUIRED:"争议或依据待核，不会自动退款",REJECTED:"结束申请未通过",APPROVED:"订单已终止，退款责任已记录"};
const blockedText:Record<string,string>={RENTAL_ALREADY_STARTED:"本单已正式开租，请使用正常或提前结束流程",SETTLEMENT_ALREADY_POSTED:"本单已有结算，请查看原结算与退款记录",
 MANUAL_ADJUSTMENT_REVIEW:"本单存在受审金额调整，需客服先核实",DISTRIBUTION_RECONCILIATION_REQUIRED:"存在需要核对的分佣资金记录",PAYMENT_BASIS_UNAVAILABLE:"原付款依据未核定",
 PRESTART_FACTS_UNAVAILABLE:"开租或资金依据尚未完整核定",ORDER_NOT_PAID:"当前订单不适用未开租结束"};

export function PrestartTerminationPanel({order,party,onChanged}:{order:Order;party:OrderParty;onChanged:()=>void}){
 const session=useUserSession(),[state,setState]=useState<{scope:string;read:PrestartView|null;error:OrderRequestError|null}>({scope:'',read:null,error:null});
 const[reason,setReason]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[reload,refresh]=useState(0),[pending,setPending]=useState(false),sequence=useRef(0);
 const{userId}=useIdentityReset(session,()=>{sequence.current++;setState({scope:'',read:null,error:null});setReason('');setNote('');setBusy(false);setPending(false);});
 const scope=`${userId}:${order.id}`,scopeRef=useRef(scope);scopeRef.current=scope;
 const applicable=order.source?.origin!=='LEGACY'&&!order.readOnly&&['PAID','CANCELLED'].includes(order.status);
 useEffect(()=>{const controller=new AbortController(),n=++sequence.current;
  setState({scope,read:null,error:null});if(!userId||!applicable)return()=>controller.abort();
  const intent=inspectIntent(userId,'order.prestart.request',order.id);setPending(intent.state!=='NONE');
  if(intent.state==='UNREADABLE')setNote('原请求恢复资料无法读取，已阻止覆盖或换键，请先核对');
  void prestartApi.read(userId,order.id,controller.signal).then(read=>{if(!controller.signal.aborted&&n===sequence.current&&scopeRef.current===scope)setState({scope,read,error:null});},
   e=>{if(!controller.signal.aborted&&n===sequence.current&&scopeRef.current===scope)setState({scope,read:null,error:e instanceof OrderRequestError?e:new OrderRequestError(503,null)});});
  return()=>controller.abort();
 },[userId,order.id,reload,scope,applicable]);
 const visible=state.scope===scope?state:null,read=visible?.read;
 if(!userId||!applicable)return null;
 if(read&&!read.request&&!read.eligibility.allowed&&read.eligibility.reason==='ORDER_NOT_PAID')return null;
 const submit=async()=>{
  if(!read||!userId||busy)return;const expectedScope=scope;
  if(inspectIntent(userId,'order.prestart.request',order.id).state==='UNREADABLE'){setNote('无法读取原请求，不能换键提交');return;}
  setBusy(true);
  const out=await performGuardedWrite(userId,'order.prestart.request',order.id,{expectedOrderRevision:read.orderRevision,reason},undefined,
   (key,body)=>prestartApi.request(userId,order.id,key,body));
  if(scopeRef.current!==expectedScope)return;setBusy(false);
  if(out.status==='ok'){setPending(false);setNote('已提交结束申请，等待客服核实；申请不代表已退款或到账');refresh(n=>n+1);onChanged();}
  else{setPending(inspectIntent(userId,'order.prestart.request',order.id).state!=='NONE');setNote(out.status==='unknown'||out.status==='blocked'?out.message:
   out.status==='unauthorized'?'登录身份已变化，原请求已保留':out.status==='recovery-unresolved'?'原请求尚未查明，已保留原键，请重读后恢复':out.error.message);}
 };
 return <section className="order-detail-section" aria-label="未开租结束申请"><h2 className="order-section-title">未开租结束</h2>
  <p className="order-muted">双方尚未正式开租时可申请，由受权客服核实交付、使用和争议。无争议且无其他受审调整时核定全额应退；申请与银行到账分开。</p>
  {!visible||!visible.read&&!visible.error?<p role="status" className="order-muted">正在读取本单依据…</p>:visible.error?<p role="alert">本单结束依据暂不可用，不能据此判断没有申请。{visible.error.requestId?` 查询编号：${visible.error.requestId}`:''}</p>:null}
  {read?.request?<><p role="status">{stateText[read.request.state]}</p><p className="order-muted">{read.request.reason}{read.request.reviewReason?` · 客服核实：${read.request.reviewReason}`:''}</p>
   {party==='renter'?<p>本次原款全额：{walletMoney(read.request.fullRefundCents)}</p>:null}
   <p className="order-muted">{formatOrderTime(read.request.updatedAt)} · {read.request.dataOrigin==='LOCAL_CONTROLLED'?'本地受控记录':'本站已接纳付款记录'} · 渠道结果与银行到账未核定</p>
   {read.request.state==='APPROVED'?<div className="order-muted" aria-label="未开租退款进度">
    {read.refund?.totals?<p>已分配 {walletMoney(read.refund.totals.allocatedCents)} · 本地核销 {walletMoney(read.refund.totals.consumedCents)} · 尚未分配 {walletMoney(read.refund.totals.remainingCents)}</p>:<p>退款合计未核定，不能按零退款理解。</p>}
    {read.refund?.intents?.map((i,n)=><p key={i.intentId??`unknown-${n}`}>{i.refundOrderNo??'退款原号未核定'} · {({READY:'等待原路提交',SUBMITTING:'提交处理中',UNKNOWN:'结果未知，按原号恢复',PROCESSING:'渠道处理中',REVIEW_REQUIRED:'需复核',SUCCEEDED:'本站已核销',FAILED:'本次未执行，预算已释放',CONFLICT:'依据冲突，需复核'} as Record<string,string>)[i.state]}
      {i.firstSubmit==='NEVER_DISPATCHED'?' · 尚无提交尝试':i.firstSubmit==='DISPATCHED'?' · 已有提交尝试':''}{i.blockedReason?' · 原商户号对应多笔流水，禁止猜测退款':''}
      {i.savedChannelEvidence?` · 已保存渠道${i.savedChannelEvidence.terminal==='SUCCEEDED'?'成功':'未执行'}证据（本次未重验）`:''}</p>)}
    {!read.refund||read.refund.integration!=='INTEGRATED'?<p>退款接入或依据暂不可用；应退责任保留。</p>:!read.refund.intents?.length?<p>本地尚无退款意图；核准记录不代表已提交渠道。</p>:null}
    {read.refund?.truncated?<p>仅显示前50笔，合计保持未知。</p>:null}<p>银行到账未核定；这里只读本地记录。</p>
   </div>:null}</>:null}
  {read&&(!read.request||read.request.state==='REJECTED')&&read.eligibility.allowed||pending?<form onSubmit={e=>{e.preventDefault();void submit();}} className="order-trade-form">
   <label>结束原因<textarea aria-label="未开租结束原因" value={reason} maxLength={150} disabled={busy||pending} onChange={e=>setReason(e.target.value)}/></label>
   <button type="submit" className="button secondary button--sm" disabled={busy||!read||!pending&&reason.trim().length<3}>{busy?'正在提交…':pending?'按原键恢复申请':'申请未开租结束'}</button>
  </form>:read&&!read.request?<p className="order-muted">{blockedText[read.eligibility.reason??'']??'当前依据未核定'}</p>:null}
  {note?<p role="status" className="order-muted">{note}</p>:null}<button type="button" className="button quiet button--sm" disabled={busy} onClick={()=>refresh(n=>n+1)}>重读本地记录</button>
 </section>;
}
