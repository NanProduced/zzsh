"use client";
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
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

function EarningBasis({item}:{item:EarningItem}){
 const c=item.calculation;
 return <section className="earning-calculation" aria-label="收益计算依据"><h5>计算依据</h5>{item.origin==='LEGACY_MYSQL'
  ? <p>历史来源未记录这笔收益的计佣基数、适用比例及等级，不采用当前政策倒算。{item.state==='EXPIRED'?'原记录标为已失效，但未记录失效原因；这不表示记录被删除。':''}</p>
  : c?.knowledge==='KNOWN'?<><dl><div><dt>本笔适用比例</dt><dd>{c.percent}%</dd></div><div><dt>付款时分销等级</dt><dd>{c.beneficiaryLevelCode}</dd></div><div><dt>本笔冻结政策</dt><dd>{c.policyVersion}</dd></div><div><dt>金额舍入</dt><dd>按冻结比例计算，四舍五入到分</dd></div><div><dt>计佣口径</dt><dd>本笔结算的平台贡献扣除补偿费后的基数</dd></div><div><dt>总额约束</dt><dd>双角色佣金合计不超过同一计佣基数</dd></div><div><dt>来源订单号</dt><dd>{c.orderNumber??'当前身份没有可展示的来源单号'}</dd></div></dl><p>计佣基数金额属于来源订单的内部结算信息，不在本人收益明细中公开。佣金不是订单实付金额的固定比例，也不是会员折扣。本记录使用本地联验政策，不代表正式经营比例。</p></>
  : <p>这笔收益的原始冻结计佣依据尚未核实，适用比例及等级待确认；不采用当前政策补算。</p>}</section>;
}
type View={scope:string;filter:EarningFilter;reload:number;page:EarningsPage|null;selectedId:string|null;detail:EarningItem|null;busy:boolean;error:WalletRequestError|null};
export function PersonalEarnings({scope}:{scope:string}){
 const params=useSearchParams(),router=useRouter(),rawFilter=params.get('earningState'),filter:EarningFilter=earningStates.includes(rawFilter as EarningFilter)?rawFilter as EarningFilter:'ALL';
 const selectedId=params.has('earning')?params.get('earning')||'INVALID':null,invalidId=selectedId!==null&&(!/^(native|history):[A-Za-z0-9_-]{1,180}$/.test(selectedId)||params.getAll('earning').length!==1);
 const routeKey=JSON.stringify([filter,selectedId,invalidId]);
 const session=useUserSession(),store=useUserSessionStore(),live=useRef({scope,routeKey,mounted:false});live.current.scope=scope;live.current.routeKey=routeKey;
 const [reload,setReload]=useState(0),[view,setView]=useState<View>({scope,filter,reload,page:null,selectedId,detail:null,busy:true,error:null});
 const ticket=useRef(0),abort=useRef<AbortController|null>(null),trigger=useRef<HTMLButtonElement|null>(null),backFocus=useRef(false),heading=useRef<HTMLHeadingElement|null>(null),detailHeading=useRef<HTMLHeadingElement|null>(null),previousSelection=useRef(selectedId),listPosition=useRef<{scope:string;filter:EarningFilter;y:number}|null>(null);
 if(previousSelection.current!==selectedId){if(previousSelection.current!==null&&selectedId===null)backFocus.current=true;previousSelection.current=selectedId;}
 const current=()=>{const s=store.getSnapshot();return live.current.mounted&&live.current.scope===scope&&s.status==='authenticated'&&s.userId===session.userId&&scope===s.userId+':'+s.identityVersion;};
 const begin=()=>{abort.current?.abort();abort.current=new AbortController();return{id:++ticket.current,signal:abort.current.signal};};
 const valid=(id:number)=>current()&&live.current.routeKey===routeKey&&id===ticket.current;
 const fail=(error:unknown,id:number)=>{if(!valid(id))return;const e=error instanceof WalletRequestError?error:new WalletRequestError(0,'NETWORK_ERROR');setView(v=>({...v,busy:false,error:e,...([401,403,409].includes(e.status)?{page:null,detail:null}:{})}));if(e.status===401)session.revalidate();};
 useEffect(()=>{
  live.current.mounted=true;const task=begin(),cached=view.scope===scope&&view.filter===filter&&view.reload===reload?view.page:null;
  setView({scope,filter,reload,page:cached,selectedId,detail:null,busy:invalidId?false:selectedId!==null||!cached,error:invalidId?new WalletRequestError(404,'NOT_FOUND'):null});
  if(session.userId&&current()&&!invalidId){
   // A detail uses the ALL snapshot; a filtered list has its own signed cursor context.
   if(selectedId!==null)void readEarningDetail(session.userId,selectedId,task.signal).then(result=>{if(valid(task.id))setView(v=>({...v,detail:result.item,page:filter!=='ALL'||v.page?.snapshotVersion===result.snapshotVersion?v.page:null,busy:false}));},e=>fail(e,task.id));
   else if(!cached)void readEarnings(session.userId,filter,null,task.signal).then(page=>{if(valid(task.id))setView({scope,filter,reload,page,selectedId:null,detail:null,busy:false,error:null});},e=>fail(e,task.id));
  }
  return()=>{live.current.mounted=false;abort.current?.abort();ticket.current++;};
 // Every result is bound to the original identity scope and request generation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,routeKey,reload]);
 const visible=view.scope===scope&&view.filter===filter&&current()?view.selectedId===selectedId?view:{...view,selectedId,detail:null,busy:true}:null;
 useEffect(()=>{if(visible?.detail)detailHeading.current?.focus();else if(backFocus.current&&selectedId===null&&visible&&!visible.busy){backFocus.current=false;(trigger.current?.isConnected?trigger.current:heading.current)?.focus({preventScroll:true});if(listPosition.current?.scope===scope&&listPosition.current.filter===filter)window.scrollTo({top:listPosition.current.y,behavior:'instant'});}},[visible?.detail,selectedId,visible?.busy,scope,filter]);
 const more=async()=>{const page=visible?.page;if(!page?.nextCursor||!session.userId||!current())return;const task=begin();setView(v=>({...v,busy:true,error:null}));try{const next=await readEarnings(session.userId,filter,page.nextCursor,task.signal);if(!valid(task.id))return;if(next.snapshotVersion!==page.snapshotVersion||next.knowledge!==page.knowledge||next.count!==page.count||next.mappedRecordCount!==page.mappedRecordCount||JSON.stringify(next.amountsByOrigin)!==JSON.stringify(page.amountsByOrigin)||next.items.some(n=>page.items.some(p=>p.id===n.id))||BigInt(next.items.length+page.items.length)>BigInt(next.mappedRecordCount))throw new WalletRequestError(409,'EARNINGS_PAGE_CHANGED');setView(v=>({...v,page:{...next,items:[...page.items,...next.items]},busy:false}));}catch(e){fail(e,task.id);}};
 const navigate=(id:string|null,nextFilter:EarningFilter=filter)=>{const q=new URLSearchParams(params.toString());if(!q.has('view'))q.set('view','invite');if(id===null)q.delete('earning');else q.set('earning',id);if(nextFilter==='ALL')q.delete('earningState');else q.set('earningState',nextFilter);router.push('/account?'+q,{scroll:false});};
 const open=(id:string,button:HTMLButtonElement)=>{if(!session.userId||!current())return;trigger.current=button;listPosition.current={scope,filter,y:window.scrollY};navigate(id);};
 const back=()=>{abort.current?.abort();ticket.current++;backFocus.current=true;navigate(null);};
 const retry=()=>setReload(n=>n+1),detail=visible?.detail,page=visible?.page,busy=visible?.busy??true;
 return <section className="personal-earnings account-module-card" aria-labelledby="personal-earnings-heading" aria-busy={busy||undefined}>
  <div className="earnings-heading"><div><h3 id="personal-earnings-heading" ref={heading} tabIndex={-1}>收益记录</h3><p>{page?.knowledge==='KNOWN'?page.count+' 条记录':page?'已确认 '+page.mappedRecordCount+' 条 · 总数待核定':'查看待结算、已结算与撤销记录'}</p></div><button className="button secondary" type="button" disabled={busy} onClick={()=>setReload(n=>n+1)}><RefreshCw size={15} aria-hidden="true"/>重新读取</button></div>
  {visible?.error?<div role="alert" className="earnings-error"><p>{message(visible.error)}</p><button className="button secondary" type="button" disabled={busy} onClick={retry}>重试读取</button></div>:null}
  <div hidden={Boolean(visible?.selectedId)}>
   <div className="earnings-filters" role="group" aria-label="收益状态">{earningStates.map(state=><button key={state} type="button" disabled={busy} aria-pressed={filter===state} onClick={()=>navigate(null,state)}>{labels[state]}</button>)}</div>
   {page?.knowledge==='UNKNOWN'?<p className="earnings-note">以下为已确认的记录，完整收益总额尚未核定。历史记录不会再次计入钱包。</p>:null}
   {page?.amountsByOrigin?<p className="earnings-note">当前状态记录金额：本平台 {walletMoney(page.amountsByOrigin.native.amountCents)} · 历史 {walletMoney(page.amountsByOrigin.historical.amountCents)}。两类来源分别统计，可用资金请查看钱包。</p>:null}
   {page?.items.some(item=>item.currentFinance?.knowledge==='KNOWN')?<p className="earnings-note">筛选按原记录状态。本平台已承接的终金额另列，原金额和原状态继续保留。</p>:null}
   {page?.items.length?<ul className="earnings-records">{page.items.map(item=><li key={item.id}><button className="earning-record" type="button" disabled={busy} onClick={e=>void open(item.id,e.currentTarget)}><span><strong>{roleLabel(item.role)}</strong><small>{formatOrderTime(item.occurredAt)} · {item.origin==='LEGACY_MYSQL'?'历史记录':'租赁收益'}</small></span><span className="earning-record-value"><strong>{walletMoney(item.amount.amountCents)}</strong><small>{item.currentFinance?.knowledge==='KNOWN'?item.currentFinance.zeroFinalization?'已终定 · 零额':'已按原责任入账':labels[item.state]}</small></span><ChevronRight size={16} aria-hidden="true"/></button></li>)}</ul>:<p className="earnings-empty">{busy?'正在读取收益记录…':page?.knowledge==='KNOWN'?'当前状态暂无收益记录。':page?'暂未找到已确认记录，完整数量仍待核定。':'收益记录当前不可用。'}</p>}
   {page?.nextCursor?<button className="button secondary" type="button" disabled={busy} onClick={()=>void more()}>加载更多收益</button>:null}
  </div>
  {visible?.selectedId?<div className="earning-detail"><button type="button" className="button secondary" onClick={back}><ArrowLeft size={15} aria-hidden="true"/>返回收益列表</button>{detail?<><h4 ref={detailHeading} tabIndex={-1}>{roleLabel(detail.role)}详情</h4><strong className="earning-detail-amount">{walletMoney(detail.amount.amountCents)}</strong><dl><div><dt>{detail.origin==='LEGACY_MYSQL'?'原记录状态':'状态'}</dt><dd>{labels[detail.state]}</dd></div><div><dt>记录时间</dt><dd>{formatOrderTime(detail.occurredAt)}</dd></div><div><dt>预计结算时间</dt><dd>{detail.dueAt===null?'未核定':formatOrderTime(detail.dueAt)}</dd></div>{detail.currentFinance?.knowledge==='KNOWN'?<><div><dt>本平台承接金额</dt><dd>{walletMoney(detail.currentFinance.amountCents)}</dd></div><div><dt>本平台终定</dt><dd>{detail.currentFinance.zeroFinalization?'零额终定，没有资金分录':'已按原责任入账，渠道到账仍待核'}</dd></div></>:null}{detail.recoveryRequiredCents!==null?<div><dt>待追回金额</dt><dd>{walletMoney(detail.recoveryRequiredCents)}</dd></div>:null}</dl><EarningBasis item={detail}/><p>{detail.origin==='LEGACY_MYSQL'?detail.includedInOpening?'这笔历史收益已包含在期初余额，不会再次入账。':'这笔记录仅供历史查询，未因展示增加当前余额。':detail.state==='RECOVERY_REQUIRED'?'这笔收益原已结算，待追回金额尚未完成扣回。':'可用资金请在钱包查看，提现结果以原提现记录为准。'}</p></>:busy?<p role="status">正在读取原收益记录…</p>:null}</div>:null}
  <div className="earnings-wallet-link"><span>收益结算与提现分别记录</span><Link className="button secondary" href="/account?view=wallet" scroll={false}>查看钱包与流水</Link></div>
 </section>;
}
