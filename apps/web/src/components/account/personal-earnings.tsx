"use client";
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {ChevronRight,ArrowLeft,RefreshCw} from 'lucide-react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readEarnings,readEarningDetail,earningStates,type EarningFilter,type EarningsPage,type EarningItem} from '@/lib/distribution-earnings-client';
import {walletMoney,WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import './personal-earnings.css';
const labels:Record<EarningFilter,string>={ALL:'全部',PENDING:'待结算',SETTLED:'已结算',REVOKED:'已撤销',RECOVERY_REQUIRED:'待追回',EXPIRED:'旧收益已失效'};
const roleLabel=(role:string)=>role==='RENTER_REFERRAL'?'购买分佣':role==='OWNER_REFERRAL'?'上架分佣':role==='TASK_REFERRAL'?'历史任务分佣':'来源待核定';
const message=(e:WalletRequestError)=>e.status===401?'登录身份已变化，请重新确认登录。':e.status===403?'当前账号无法读取这些收益记录。':e.status===404?'这条收益记录当前不可用。':e.status===409?'收益记录已变化，请重新读取。':'收益记录暂时无法读取，请重试。';
type View={scope:string;filter:EarningFilter;page:EarningsPage|null;selectedId:string|null;detail:EarningItem|null;busy:boolean;error:WalletRequestError|null};
export function PersonalEarnings({scope}:{scope:string}){
 const session=useUserSession(),store=useUserSessionStore(),live=useRef({scope,mounted:false});live.current.scope=scope;
 const [filter,setFilter]=useState<EarningFilter>('ALL'),[reload,setReload]=useState(0),[view,setView]=useState<View>({scope,filter:'ALL',page:null,selectedId:null,detail:null,busy:true,error:null});
 const ticket=useRef(0),abort=useRef<AbortController|null>(null),trigger=useRef<HTMLButtonElement|null>(null),backFocus=useRef(false),heading=useRef<HTMLHeadingElement|null>(null),detailHeading=useRef<HTMLHeadingElement|null>(null);
 const current=()=>{const s=store.getSnapshot();return live.current.mounted&&live.current.scope===scope&&s.status==='authenticated'&&s.userId===session.userId&&scope===s.userId+':'+s.identityVersion;};
 const begin=()=>{abort.current?.abort();abort.current=new AbortController();return{id:++ticket.current,signal:abort.current.signal};};
 const valid=(id:number)=>current()&&id===ticket.current;
 const fail=(error:unknown,id:number)=>{if(!valid(id))return;const e=error instanceof WalletRequestError?error:new WalletRequestError(0,'NETWORK_ERROR');setView(v=>({...v,busy:false,error:e,...([401,403,409].includes(e.status)?{page:null,detail:null,selectedId:null}:{})}));if(e.status===401)session.revalidate();};
 useEffect(()=>{
  live.current.mounted=true;const task=begin();setView({scope,filter,page:null,selectedId:null,detail:null,busy:true,error:null});
  if(session.userId&&current())void readEarnings(session.userId,filter,null,task.signal).then(page=>{if(valid(task.id))setView({scope,filter,page,selectedId:null,detail:null,busy:false,error:null});},e=>fail(e,task.id));
  return()=>{live.current.mounted=false;abort.current?.abort();ticket.current++;};
 // Every result is bound to the original identity scope and request generation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,filter,reload]);
 const visible=view.scope===scope&&view.filter===filter&&current()?view:null;
 useEffect(()=>{if(visible?.detail)detailHeading.current?.focus();else if(backFocus.current&&!visible?.selectedId){backFocus.current=false;(trigger.current?.isConnected?trigger.current:heading.current)?.focus();}},[visible?.detail,visible?.selectedId]);
 const more=async()=>{const page=visible?.page;if(!page?.nextCursor||!session.userId||!current())return;const task=begin();setView(v=>({...v,busy:true,error:null}));try{const next=await readEarnings(session.userId,filter,page.nextCursor,task.signal);if(!valid(task.id))return;if(next.snapshotVersion!==page.snapshotVersion||next.knowledge!==page.knowledge||next.count!==page.count||next.mappedRecordCount!==page.mappedRecordCount||next.items.some(n=>page.items.some(p=>p.id===n.id))||BigInt(next.items.length+page.items.length)>BigInt(next.mappedRecordCount))throw new WalletRequestError(409,'EARNINGS_PAGE_CHANGED');setView(v=>({...v,page:{...next,items:[...page.items,...next.items]},busy:false}));}catch(e){fail(e,task.id);}};
 const open=async(id:string,button?:HTMLButtonElement)=>{if(!session.userId||!current())return;if(button)trigger.current=button;const task=begin();setView(v=>({...v,selectedId:id,detail:null,busy:true,error:null}));try{const result=await readEarningDetail(session.userId,id,task.signal);if(valid(task.id))setView(v=>({...v,detail:result.item,page:v.page?.snapshotVersion===result.snapshotVersion?v.page:null,busy:false}));}catch(e){fail(e,task.id);}};
 const back=()=>{abort.current?.abort();ticket.current++;backFocus.current=true;setView(v=>({...v,selectedId:null,detail:null,busy:false,error:null}));if(!visible?.page)setReload(n=>n+1);};
 const retry=()=>visible?.selectedId?void open(visible.selectedId):setReload(n=>n+1),detail=visible?.detail,page=visible?.page,busy=visible?.busy??true;
 return <section className="personal-earnings account-module-card" aria-labelledby="personal-earnings-heading" aria-busy={busy||undefined}>
  <div className="earnings-heading"><div><h3 id="personal-earnings-heading" ref={heading} tabIndex={-1}>收益记录</h3><p>{page?.knowledge==='KNOWN'?page.count+' 条记录':page?'已确认 '+page.mappedRecordCount+' 条 · 总数待核定':'查看待结算、已结算与撤销记录'}</p></div><button className="button secondary" type="button" disabled={busy} onClick={()=>setReload(n=>n+1)}><RefreshCw size={15} aria-hidden="true"/>重新读取</button></div>
  {visible?.error?<div role="alert" className="earnings-error"><p>{message(visible.error)}</p><button className="button secondary" type="button" disabled={busy} onClick={retry}>重试读取</button></div>:null}
  <div hidden={Boolean(visible?.selectedId)}>
   <div className="earnings-filters" role="group" aria-label="收益状态">{earningStates.map(state=><button key={state} type="button" disabled={busy} aria-pressed={filter===state} onClick={()=>setFilter(state)}>{labels[state]}</button>)}</div>
   {page?.knowledge==='UNKNOWN'?<p className="earnings-note">以下为已确认的记录，完整收益总额尚未核定。历史记录不会再次计入钱包。</p>:null}
   {page?.items.length?<ul className="earnings-records">{page.items.map(item=><li key={item.id}><button className="earning-record" type="button" disabled={busy} onClick={e=>void open(item.id,e.currentTarget)}><span><strong>{roleLabel(item.role)}</strong><small>{formatOrderTime(item.occurredAt)} · {item.origin==='LEGACY_MYSQL'?'历史记录':'租赁收益'}</small></span><span className="earning-record-value"><strong>{walletMoney(item.amount.amountCents)}</strong><small>{labels[item.state]}</small></span><ChevronRight size={16} aria-hidden="true"/></button></li>)}</ul>:<p className="earnings-empty">{busy?'正在读取收益记录…':page?.knowledge==='KNOWN'?'当前状态暂无收益记录。':page?'暂未找到已确认记录，完整数量仍待核定。':'收益记录当前不可用。'}</p>}
   {page?.nextCursor?<button className="button secondary" type="button" disabled={busy} onClick={()=>void more()}>加载更多收益</button>:null}
  </div>
  {visible?.selectedId?<div className="earning-detail"><button type="button" className="button secondary" onClick={back}><ArrowLeft size={15} aria-hidden="true"/>返回收益列表</button>{detail?<><h4 ref={detailHeading} tabIndex={-1}>{roleLabel(detail.role)}详情</h4><strong className="earning-detail-amount">{walletMoney(detail.amount.amountCents)}</strong><dl><div><dt>状态</dt><dd>{labels[detail.state]}</dd></div><div><dt>记录时间</dt><dd>{formatOrderTime(detail.occurredAt)}</dd></div><div><dt>预计结算时间</dt><dd>{detail.dueAt===null?'未核定':formatOrderTime(detail.dueAt)}</dd></div>{detail.recoveryRequiredCents!==null?<div><dt>待追回金额</dt><dd>{walletMoney(detail.recoveryRequiredCents)}</dd></div>:null}</dl><p>{detail.origin==='LEGACY_MYSQL'?detail.includedInOpening?'这笔历史收益已包含在期初余额，不会再次入账。':'这笔记录仅供历史查询，未因展示增加当前余额。':detail.state==='RECOVERY_REQUIRED'?'这笔收益原已结算，待追回金额尚未完成扣回。':'可用资金请在钱包查看，提现结果以原提现记录为准。'}</p></>:busy?<p role="status">正在读取原收益记录…</p>:null}</div>:null}
  <div className="earnings-wallet-link"><span>收益结算与提现分别记录</span><Link className="button secondary" href="/account?view=wallet" scroll={false}>查看钱包与流水</Link></div>
 </section>;
}
