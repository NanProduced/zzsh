"use client";
import {useEffect,useRef,useState} from 'react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readMyOwnerGuaranteeHistory,type OwnerGuaranteeHistoryPage} from '@/lib/owner-guarantee-history-client';
import {walletMoney,WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import {LocalRetry} from '@/components/ui/information';
import './owner-guarantee-history.css';

const labels:Record<string,string>={ZERO_AMOUNT_PAID_MARK:'缴纳金额待确认',ZERO_AMOUNT_RETURN_MARK:'退还金额待确认',HISTORICAL_TRACE_UNKNOWN:'收退情况待确认',NO_PAYMENT_EVIDENCE_UNKNOWN:'缴纳情况待确认',PAID_MARK_WITHOUT_PAY_ORDER_UNKNOWN:'缴纳情况待确认',SOURCE_RETURN_MARK_CHANNEL_UNKNOWN:'退还进度待确认',PAID_RECORD_RESET_REFUND_UNKNOWN:'退还进度待确认',SOURCE_PAID_REFUND_UNKNOWN:'收退情况待确认'};
const at=(s:string|null)=>s?formatOrderTime(s,{timeZoneName:false}):'未记录';
/** Independently readable when wallet coverage is missing. This component has no payment or refund command. */
export function OwnerGuaranteeHistory({scope}:{scope:string}){
 const session=useUserSession(),store=useUserSessionStore(),live=useRef(scope);live.current=scope;
 const current=()=>{const s=store.getSnapshot();return s.status==='authenticated'&&`${s.userId}:${s.identityVersion}`===live.current;};
 const [state,setState]=useState<{scope:string;value:OwnerGuaranteeHistoryPage|null;busy:boolean;error:WalletRequestError|null}>({scope,value:null,busy:true,error:null});
 const request=useRef<AbortController|null>(null),sequence=useRef(0),[reload,setReload]=useState(0);
 const visible=state.scope===scope&&current()?state:{scope,value:null,busy:true,error:null};
 const load=async(cursor:string|null)=>{
  if(!session.userId||!current()||cursor&&visible.busy)return;
  request.current?.abort();const abort=new AbortController();request.current=abort;const ticket=++sequence.current,prior=cursor?visible.value:null;
  setState({scope,value:prior,busy:true,error:null});
  try{const next=await readMyOwnerGuaranteeHistory(session.userId,cursor,abort.signal);if(abort.signal.aborted||live.current!==scope||ticket!==sequence.current||!current())return;
   if(prior&&(prior.snapshotVersion!==next.snapshotVersion||prior.asOf!==next.asOf||JSON.stringify(prior.coverage)!==JSON.stringify(next.coverage)||JSON.stringify(prior.postedHeld)!==JSON.stringify(next.postedHeld)))throw new WalletRequestError(409,'GUARANTEE_HISTORY_CHANGED');
   const seen=new Set(prior?.items.map(i=>i.id));if(next.items.some(i=>seen.has(i.id)))throw new WalletRequestError(502,'GUARANTEE_HISTORY_CONTRACT_REQUIRED');
   setState({scope,value:{...next,items:[...(prior?.items??[]),...next.items]},busy:false,error:null});
  }catch(e){if(abort.signal.aborted||live.current!==scope||ticket!==sequence.current||!current())return;const error=e instanceof WalletRequestError?e:new WalletRequestError(0,'NETWORK_ERROR');setState({scope,value:[401,403,409].includes(error.status)?null:prior,busy:false,error});if(error.status===401)session.revalidate();}
 };
 useEffect(()=>{setState({scope,value:null,busy:true,error:null});void load(null);return()=>request.current?.abort();
 // Identity scope is checked both before rendering and after every reply.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,reload]);
 const page=visible.value;
 return <section className="owner-guarantee-history" aria-label="保证金记录" aria-busy={visible.busy||undefined}>
  <div className="wallet-section-heading"><h3>保证金记录</h3><button className="button secondary" type="button" disabled={visible.busy} onClick={()=>setReload(n=>n+1)}>刷新</button></div>
  {page?<>{page.coverage.knowledge==='UNKNOWN'?<p className="account-module-note" role="status">部分记录仍在核对，当前只显示已确认的记录。</p>:null}
   {page.items.length?<div className="guarantee-history-records">{page.items.map(item=><details className="account-module-card" key={item.id} data-guarantee-history={item.id}><summary><strong>{item.accountNumber?'账号 '+item.accountNumber:'账号信息待确认'}</strong><span>{labels[item.classification]??'收退情况待确认'}</span></summary>
    {item.conflicts.length?<p>部分缴纳记录有差异，请联系客服核对。</p>:null}
    {item.payments.length?<ol>{item.payments.map(payment=><li key={payment.source.id}><strong>{payment.sourceStatus==='1'?'记录显示已支付，结果待确认':'支付状态待确认'} · {walletMoney(payment.amountCents)}</strong><p>支付单号：{payment.merchantOrderNumber??'未记录'}</p><p>记录时间：{at(payment.sourceCreatedAt)}{payment.sourcePaidAt?' · 记录付款时间：'+at(payment.sourcePaidAt):''}</p><small>到账情况请以收款记录为准。</small></li>)}</ol>:<p>暂时没有可显示的缴纳记录。</p>}
   </details>)}</div>:<p role="status">{page.coverage.knowledge==='KNOWN'?'当前没有可显示的记录。':'记录仍在核对，请稍后查看。'}</p>}
   <p className="account-module-note">{'已显示 '+page.items.length+' 条'+(page.coverage.count===null?'，部分记录仍在核对。':'')}</p>
   {page.nextCursor?<button type="button" className="button secondary" disabled={visible.busy} onClick={()=>void load(page.nextCursor)}>加载更多</button>:null}
  </>:visible.busy?<p role="status">正在加载保证金记录…</p>:null}
  {visible.error?<LocalRetry message={visible.error.status===401?'登录状态已变化，请重新登录。':visible.error.status===403?'当前账号暂时无法查看这些记录。':visible.error.status===409?'记录已更新，请刷新后查看。':'保证金记录暂时无法查看，请稍后重试。'} actionLabel="重试" onRetry={()=>setReload(n=>n+1)}/>:null}
 </section>;
}
