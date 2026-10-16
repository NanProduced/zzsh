"use client";
import {useEffect,useRef,useState} from 'react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readMyOwnerGuaranteeHistory,type OwnerGuaranteeHistoryPage} from '@/lib/owner-guarantee-history-client';
import {walletMoney,WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import {Callout,LocalRetry} from '@/components/ui/information';
import './owner-guarantee-history.css';

const labels:Record<string,string>={ZERO_AMOUNT_PAID_MARK:'旧记录标记已付，当前字段为零',ZERO_AMOUNT_RETURN_MARK:'旧记录标记退还，当前字段为零',HISTORICAL_TRACE_UNKNOWN:'有历史处理时间，收退待核',NO_PAYMENT_EVIDENCE_UNKNOWN:'当前未取得支付凭证',PAID_MARK_WITHOUT_PAY_ORDER_UNKNOWN:'有已付标记，支付凭证待核',SOURCE_RETURN_MARK_CHANNEL_UNKNOWN:'有历史退还标记，到账待核',PAID_RECORD_RESET_REFUND_UNKNOWN:'有历史付款，后续退还待核',SOURCE_PAID_REFUND_UNKNOWN:'有历史付款，当前责任待核'};
const at=(s:string|null)=>s?formatOrderTime(s,{timeZoneName:false}):'原记录未提供';
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
 return <section className="owner-guarantee-history" aria-label="号主上架保证金" aria-busy={visible.busy||undefined}>
  <div className="wallet-section-heading"><h3>号主上架保证金</h3><button className="button secondary" type="button" disabled={visible.busy} onClick={()=>setReload(n=>n+1)}>重新读取</button></div>
  <Callout title="与订单押金分开">这里记录号主上架保证金。历史付款与当前在押责任分开核对，不计入普通钱包可用余额。</Callout>
  {page?<><dl className="account-fact-list"><div><dt>当前已入账在押</dt><dd>{walletMoney(page.postedHeld.amountCents)}</dd></div><div><dt>历史资金责任</dt><dd>待核定</dd></div></dl><p className="account-module-note">已入账金额仅反映当前账内收退；历史付款、退还标记和银行到账须分别核对。</p>
   {page.items.length?<div className="guarantee-history-records">{page.items.map(item=><details className="account-module-card" key={item.id} data-guarantee-history={item.id}><summary><strong>账号 {item.accountNumber??item.legacyAccountId}</strong><span>历史已付记录 {walletMoney(item.paidRecordCents)}</span></summary><p>{labels[item.classification]??'历史收退待核'}</p><dl className="account-fact-list"><div><dt>原账号金额字段</dt><dd>{walletMoney(item.accountFieldCents)}</dd></div><div><dt>原已付尝试数</dt><dd>{item.paidRecordCount}</dd></div><div><dt>原处理时间</dt><dd>{at(item.sourcePaidAt)}</dd></div><div><dt>当前可退金额</dt><dd>待核定</dd></div></dl>
    {item.conflicts.includes('MULTIPLE_PAID_ATTEMPTS')?<p>存在多笔历史已付记录，须逐笔核对。</p>:null}{item.conflicts.includes('CURRENT_AMOUNT_DIFFERS_FROM_PAID_ATTEMPT')?<p>账号金额字段与原付款记录不一致，原付款记录仍保留。</p>:null}
    <h4>原支付尝试</h4>{item.payments.length?<ol>{item.payments.map(p=><li key={p.source.id}><strong>{p.sourceStatus==='1'?'来源标记已付':'来源未付尝试'} · {walletMoney(p.amountCents)}</strong><p>原商户单号：{p.merchantOrderNumber??'未提供'}</p><p>创建于 {at(p.sourceCreatedAt)} · 原支付时间 {at(p.sourcePaidAt)}</p><small>渠道到账待核，不按历史状态推定收退完成。</small></li>)}</ol>:<p>没有关联的类型明确支付记录，不能据此认定从未缴款。</p>}
   </details>)}</div>:<p role="status">{page.coverage.knowledge==='KNOWN'?'已核定的来源范围内没有历史记录。':'历史来源尚未完成核对，当前没有可展示的记录。'}</p>}
   <p className="account-module-note">{page.coverage.count===null?`已读取 ${page.coverage.mappedRecordCount??'待核定'} 条，完整范围待核对`:`已显示 ${page.items.length} / ${page.coverage.count} 条`}</p>
   {page.nextCursor?<button type="button" className="button secondary" disabled={visible.busy} onClick={()=>void load(page.nextCursor)}>加载更多记录</button>:null}
  </>:visible.busy?<p role="status">正在读取保证金记录…</p>:null}
  {visible.error?<LocalRetry message={visible.error.status===401?'登录身份已变化，请重新确认。':visible.error.status===403?'当前身份无权读取这些资金记录。':visible.error.status===409?'记录已变化，请重新读取。':'保证金记录暂时无法读取，未确认金额不按零展示。'} actionLabel="重试读取" onRetry={()=>setReload(n=>n+1)}/>:null}
 </section>;
}
