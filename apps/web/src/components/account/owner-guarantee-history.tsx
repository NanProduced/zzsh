"use client";
import {useEffect,useRef,useState} from 'react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readMyOwnerGuaranteeHistory,type OwnerGuaranteeHistoryPage,type OwnerGuaranteeHistoryItem} from '@/lib/owner-guarantee-history-client';
import {readMyUnifiedOwnerGuaranteeHistory,type UnifiedGuaranteePage,type UnifiedGuaranteeEvent} from '@/lib/owner-guarantee-unified-client';
import {walletMoney,WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import {guaranteeResponsibilityLabel,guaranteePaymentAttemptLabel,guaranteeRefundAttemptLabel,guaranteeProviderRequestLabel,guaranteeReleasePolicyLabel} from '@zzsh/ui/display-credit';
import {LocalRetry} from '@/components/ui/information';
import './owner-guarantee-history.css';

const labels:Record<string,string>={ZERO_AMOUNT_PAID_MARK:'缴纳金额待确认',ZERO_AMOUNT_RETURN_MARK:'退还金额待确认',HISTORICAL_TRACE_UNKNOWN:'收退情况待确认',NO_PAYMENT_EVIDENCE_UNKNOWN:'缴纳情况待确认',PAID_MARK_WITHOUT_PAY_ORDER_UNKNOWN:'缴纳情况待确认',SOURCE_RETURN_MARK_CHANNEL_UNKNOWN:'退还进度待确认',PAID_RECORD_RESET_REFUND_UNKNOWN:'退还进度待确认',SOURCE_PAID_REFUND_UNKNOWN:'收退情况待确认'};
const at=(s:string|null)=>s?formatOrderTime(s,{timeZoneName:false}):'未记录';
type Page=OwnerGuaranteeHistoryPage|UnifiedGuaranteePage;
/** Independently readable when wallet coverage is missing; no payment/refund command. v1 remains a compatibility view. */
export function OwnerGuaranteeHistory({scope,projectionVersion=2}:{scope:string;projectionVersion?:1|2}){
 return <GuaranteeHistoryBody key={scope+':'+projectionVersion} scope={scope} projectionVersion={projectionVersion}/>;
}
function GuaranteeHistoryBody({scope,projectionVersion}:{scope:string;projectionVersion:1|2}){
 const session=useUserSession(),store=useUserSessionStore(),live=useRef(scope);live.current=scope;
 const current=()=>{const s=store.getSnapshot();return s.status==='authenticated'&&`${s.userId}:${s.identityVersion}`===live.current;};
 const [state,setState]=useState<{scope:string;value:Page|null;busy:boolean;error:WalletRequestError|null}>({scope,value:null,busy:true,error:null});
 const request=useRef<AbortController|null>(null),sequence=useRef(0),[reload,setReload]=useState(0);
 const visible=state.scope===scope&&current()?state:{scope,value:null,busy:true,error:null};
 const load=async(cursor:string|null)=>{
  if(!session.userId||!current()||cursor&&visible.busy)return;
  request.current?.abort();const abort=new AbortController();request.current=abort;const ticket=++sequence.current,prior=cursor?visible.value:null;
  setState({scope,value:prior,busy:true,error:null});
  try{const next=projectionVersion===2?await readMyUnifiedOwnerGuaranteeHistory(session.userId,cursor,abort.signal):await readMyOwnerGuaranteeHistory(session.userId,cursor,abort.signal);if(abort.signal.aborted||live.current!==scope||ticket!==sequence.current||!current())return;
   if(prior&&(prior.contractVersion!==next.contractVersion||prior.snapshotVersion!==next.snapshotVersion||prior.asOf!==next.asOf||JSON.stringify(prior.coverage)!==JSON.stringify(next.coverage)||JSON.stringify(prior.postedHeld)!==JSON.stringify(next.postedHeld)))throw new WalletRequestError(409,'GUARANTEE_HISTORY_CHANGED');
   const seen=new Set(prior?.items.map(i=>i.id));if(next.items.some(i=>seen.has(i.id)))throw new WalletRequestError(502,'GUARANTEE_HISTORY_CONTRACT_REQUIRED');
   const value:Page=next.contractVersion==='owner-guarantee-history.read.v2'?{...next,items:[...(prior?.contractVersion==='owner-guarantee-history.read.v2'?prior.items:[]),...next.items]}:{...next,items:[...(prior?.contractVersion==='owner-guarantee-history.read.v1'?prior.items:[]),...next.items]};
   setState({scope,value,busy:false,error:null});
  }catch(e){if(abort.signal.aborted||live.current!==scope||ticket!==sequence.current||!current())return;const error=e instanceof WalletRequestError?e:new WalletRequestError(0,'NETWORK_ERROR');setState({scope,value:[401,403,409].includes(error.status)?null:prior,busy:false,error});if(error.status===401)session.revalidate();}
 };
 useEffect(()=>{setState({scope,value:null,busy:true,error:null});void load(null);return()=>request.current?.abort();
 // Identity is checked before rendering and after every reply.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,reload]);
 const page=visible.value;
 return <section className="owner-guarantee-history" aria-label="保证金记录" aria-busy={visible.busy||undefined}>
  <div className="wallet-section-heading"><h3>保证金记录</h3><button className="button secondary" type="button" disabled={visible.busy} onClick={()=>setReload(n=>n+1)}>刷新</button></div>
  {page?<>{page.coverage.knowledge==='UNKNOWN'?<p className="account-module-note" role="status">部分记录仍在核对，当前只显示已确认的记录。</p>:null}
   {page.items.length?<div className="guarantee-history-records">{page.contractVersion==='owner-guarantee-history.read.v2'?page.items.map(item=><UnifiedGuaranteeItem key={item.id} item={item}/>):page.items.map(item=><LegacyGuaranteeItem key={item.id} item={item}/>)}</div>:<p role="status">{page.coverage.knowledge==='KNOWN'?'当前没有可显示的记录。':'记录仍在核对，请稍后查看。'}</p>}
   {page.contractVersion==='owner-guarantee-history.read.v2'&&page.unknownTimeCount!=='0'?<p className="account-module-note">部分记录未保留时间，列在有明确时间的记录之后。</p>:null}
   <p className="account-module-note">{'已显示 '+page.items.length+' 条'+(page.coverage.count===null?'，部分记录仍在核对。':'')}</p>
   {page.nextCursor?<button type="button" className="button secondary" disabled={visible.busy} onClick={()=>void load(page.nextCursor)}>加载更多</button>:null}
  </>:visible.busy?<p role="status">正在加载保证金记录…</p>:null}
  {visible.error?<LocalRetry message={visible.error.status===401?'登录状态已变化，请重新登录。':visible.error.status===403?'当前账号暂时无法查看这些记录。':visible.error.status===409?'记录已更新，请刷新后查看。':'保证金记录暂时无法查看，请稍后重试。'} actionLabel="重试" onRetry={()=>setReload(n=>n+1)}/>:null}
 </section>;
}
function LegacyGuaranteeItem({item}:{item:OwnerGuaranteeHistoryItem}){return <details className="account-module-card" data-guarantee-history={item.id}><summary><strong>{item.accountNumber?'账号 '+item.accountNumber:'账号信息待确认'}</strong><span>{labels[item.classification]??'收退情况待确认'}</span></summary>
 {item.conflicts.length?<p>部分缴纳记录有差异，请联系客服核对。</p>:null}
 {item.payments.length?<ol>{item.payments.map(payment=><li key={payment.source.id}><strong>原缴纳状态：{payment.sourceStatus==='1'?'已支付':payment.sourceStatus==='0'?'未支付':'未知'} · {walletMoney(payment.amountCents)}</strong><p>支付单号：{payment.merchantOrderNumber??'未记录'}</p><p>记录时间：{at(payment.sourceCreatedAt)}{payment.sourcePaidAt?' · 付款时间：'+at(payment.sourcePaidAt):''}</p><small>渠道结果待确认。</small></li>)}</ol>:<p>暂时没有可显示的缴纳记录。</p>}
 </details>;}
const eventLabels:Record<UnifiedGuaranteeEvent['eventKind'],string>={REQUIREMENT:'保证金要求',PAYMENT_ATTEMPT:'缴纳申请',REFUND_ATTEMPT:'退还申请',PAYMENT_OBSERVATION:'保证金付款',ACCOUNT_OBSERVATION:'保证金情况'};
function UnifiedGuaranteeItem({item}:{item:UnifiedGuaranteeEvent}){
 const payment=item.paymentAttempt,refund=item.refundAttempt,posting=item.localPosting;
 const originalPaymentState=item.eventKind==='PAYMENT_OBSERVATION'?payment?.status==='SOURCE_PAID_RECORD'?'已支付':payment?.status==='SOURCE_UNPAID_RECORD'?'未支付':'未知':null;
 return <details className="account-module-card guarantee-history-event" data-guarantee-history={item.id}><summary><div><strong>{eventLabels[item.eventKind]}{item.accountNumber?' · '+item.accountNumber:''}</strong><p className="account-module-note">{originalPaymentState?`原缴纳状态 ${originalPaymentState} · `:null}{item.occurredAt?<time dateTime={item.occurredAt}>{at(item.occurredAt)}</time>:'时间未记录'}</p></div>{item.amountCents!==null?<span className="guarantee-event-amount">{walletMoney(item.amountCents)}</span>:<span>情况待确认</span>}</summary>
  <dl className="account-fact-list">
   {item.requirement?<div><dt>保证金责任</dt><dd>{guaranteeResponsibilityLabel(item.requirement.status)} · 要求 {walletMoney(item.requirement.requiredCents)}</dd></div>:null}
   {payment&&!originalPaymentState?<div><dt>缴纳申请</dt><dd>{guaranteePaymentAttemptLabel(payment.status)}</dd></div>:null}
   {payment?.merchantOrderNumber?<div><dt>支付单号</dt><dd>{payment.merchantOrderNumber}</dd></div>:null}
   {payment?.providerState||item.eventKind==='PAYMENT_OBSERVATION'?<div><dt>收款渠道</dt><dd>{payment?.providerState?guaranteeProviderRequestLabel('payment',payment.providerState):'待核实'}</dd></div>:null}
   {refund?<><div><dt>退还申请</dt><dd>{guaranteeRefundAttemptLabel(refund.status)}</dd></div><div><dt>退还放行</dt><dd>{guaranteeReleasePolicyLabel(refund.releasePolicyState)}</dd></div><div><dt>退款渠道</dt><dd>{guaranteeProviderRequestLabel('refund',refund.providerState)}</dd></div></>:null}
   {posting?<div><dt>本站记账</dt><dd>{posting.knowledge==='KNOWN'?(item.eventKind==='REFUND_ATTEMPT'?'退还已记账':'缴纳已记账')+' · '+walletMoney(posting.amountCents)+' · '+at(posting.postedAt):'尚未确认相关记账'}</dd></div>:null}
   {item.classification?<div><dt>当前记录情况</dt><dd>{labels[item.classification]??'收退情况待确认'}</dd></div>:null}
  </dl>
  {item.conflicts.length?<p>部分记录有差异，请联系客服核对。</p>:null}
  <p className="account-module-note">{item.eventKind==='ACCOUNT_OBSERVATION'?'该记录用于保留保证金情况，不代表新增缴款或退款。':'申请、渠道结果和到账情况分别核对；此记录不会重复增加或扣减余额。'}</p>
 </details>;
}
