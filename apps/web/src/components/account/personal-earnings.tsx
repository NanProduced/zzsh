"use client";
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {useEffect,useRef,useState} from 'react';
import {ChevronRight,ArrowLeft,RefreshCw} from 'lucide-react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readEarnings,readEarningDetail,earningStates,commissionStateLabel,commissionRecordMoney,type EarningFilter,type EarningsPage,type EarningItem,type CurrentLegacyResponsibility} from '@/lib/distribution-earnings-client';
import {WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import {commissionRoleLabel} from '@zzsh/ui/display-distribution';
import './personal-earnings.css';
const labels=Object.fromEntries(earningStates.map(state=>[state,commissionStateLabel(state)])) as Record<EarningFilter,string>;
const roleLabel=commissionRoleLabel;
const responsibilityText=(r:CurrentLegacyResponsibility)=>r.knowledge!=='KNOWN'?'当前责任还没核对清楚':r.state==='VOID'?'该责任已撤销，不再支付':r.state==='MATURED'?'已到期，等待平台结算':r.state==='SETTLED'?r.settledBy==='LEGACY_RECORDS'?'旧平台已处理，本站不再重复支付':'责任标记已结清':'尚未到期，暂不结算';
function recordView(item:EarningItem){
 const responsibility=item.record?.detail.currentResponsibility??item.currentResponsibility;
 const state=item.record?.effectiveState??(responsibility?.knowledge==='KNOWN'?responsibility.state:item.origin==='LEGACY_MYSQL'&&item.state==='PENDING'?'UNKNOWN':item.state);
 return{key:item.record?.key??item.id,state,amountCents:item.record?.amountCents??(responsibility?.knowledge==='KNOWN'?responsibility.amountCents:item.amount.amountCents),occurredAt:item.record?.occurredAt??item.occurredAt};
}
const message=(e:WalletRequestError)=>e.status===401?'登录身份已变化，请重新确认登录。':e.status===403?'当前账号无法读取这些收益记录。':e.status===404?'这条收益记录当前不可用。':e.status===409?'收益记录已变化，请重新读取。':'收益记录暂时无法读取，请重试。';

function EarningBasis({item}:{item:EarningItem}){
 const c=item.calculation;
 return <section className="earning-calculation" aria-label="收益计算依据"><h5>计算依据</h5>{item.origin==='LEGACY_MYSQL'
  ? <p>历史来源未记录这笔收益的计佣基数、适用比例及等级，不采用当前政策倒算。{item.state==='EXPIRED'?'原记录标为已失效，但未记录失效原因；这不表示记录被删除。':''}</p>
  : c?.knowledge==='KNOWN'?<><dl><div><dt>本笔适用比例</dt><dd>{c.percent}%</dd></div><div><dt>{c.rateMode==='UNIFORM'?'计佣方式':'付款时分销等级'}</dt><dd>{c.rateMode==='UNIFORM'?'统一比例':c.beneficiaryLevelCode}</dd></div><div><dt>本笔冻结政策</dt><dd>{c.policyVersion}</dd></div><div><dt>金额舍入</dt><dd>按冻结比例计算，四舍五入到分</dd></div><div><dt>计佣口径</dt><dd>本笔结算的平台贡献扣除补偿费后的基数</dd></div><div><dt>总额约束</dt><dd>双角色佣金合计不超过同一计佣基数</dd></div><div><dt>来源订单号</dt><dd>{c.orderNumber??'当前身份没有可展示的来源单号'}</dd></div></dl><p>计佣基数金额属于来源订单的内部结算信息，不在本人收益明细中公开。佣金不是订单实付金额的固定比例，也不是会员折扣。{c.scope==='LOCAL_CONTROLLED'?'本记录使用本地联验政策，不代表正式经营比例。':'本笔比例来自原付款冻结政策，不随当前政策变化。'}</p></>
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
 const more=async()=>{const page=visible?.page;if(!page?.nextCursor||!session.userId||!current())return;const task=begin();setView(v=>({...v,busy:true,error:null}));try{const next=await readEarnings(session.userId,filter,page.nextCursor,task.signal);if(!valid(task.id))return;if(next.snapshotVersion!==page.snapshotVersion||next.knowledge!==page.knowledge||next.count!==page.count||next.mappedRecordCount!==page.mappedRecordCount||JSON.stringify(next.amountsByOrigin)!==JSON.stringify(page.amountsByOrigin)||JSON.stringify(next.recordSummary)!==JSON.stringify(page.recordSummary)||next.items.some(n=>page.items.some(p=>(p.record?.key??p.id)===(n.record?.key??n.id)))||BigInt(next.items.length+page.items.length)>BigInt(next.recordSummary?.mappedRecordCount??next.mappedRecordCount))throw new WalletRequestError(409,'EARNINGS_PAGE_CHANGED');setView(v=>({...v,page:{...next,items:[...page.items,...next.items]},busy:false}));}catch(e){fail(e,task.id);}};
 const navigate=(id:string|null,nextFilter:EarningFilter=filter)=>{const q=new URLSearchParams(params.toString());if(!q.has('view'))q.set('view','invite');if(id===null)q.delete('earning');else q.set('earning',id);if(nextFilter==='ALL')q.delete('earningState');else q.set('earningState',nextFilter);router.push('/account?'+q,{scroll:false});};
 const open=(id:string,button:HTMLButtonElement)=>{if(!session.userId||!current())return;trigger.current=button;listPosition.current={scope,filter,y:window.scrollY};navigate(id);};
 const back=()=>{abort.current?.abort();ticket.current++;backFocus.current=true;navigate(null);};
 const retry=()=>setReload(n=>n+1),detail=visible?.detail,page=visible?.page,busy=visible?.busy??true;
 const shown=detail?recordView(detail):null,responsibility=detail?.record?.detail.currentResponsibility??detail?.currentResponsibility,finance=detail?.record?.detail.currentFinance??detail?.currentFinance,summary=page?.recordSummary;
 return <section className="personal-earnings account-module-card" aria-labelledby="personal-earnings-heading" aria-busy={busy||undefined}>
  <div className="earnings-heading"><div><h3 id="personal-earnings-heading" ref={heading} tabIndex={-1}>佣金记录</h3><p>{summary?.count!==null&&summary?.count!==undefined?BigInt(summary.count).toLocaleString('zh-CN')+' 条记录':summary?'已收录 '+BigInt(summary.mappedRecordCount).toLocaleString('zh-CN')+' 条 · 完整数量待核':page?'已显示 '+page.items.length+' 条 · 完整数量待核':'连续查看佣金记录及当前核对状态'}</p>{summary?<p className="earnings-total">{summary.knowledge==='KNOWN'?'当前筛选记录金额':'已收录金额小计'} {commissionRecordMoney(summary.knowledge==='KNOWN'?summary.amountCents:summary.knownSubtotalCents)} · 不等于可用余额</p>:null}</div><button className="button secondary" type="button" disabled={busy} onClick={()=>setReload(n=>n+1)}><RefreshCw size={15} aria-hidden="true"/>重新读取</button></div>
  {visible?.error?<div role="alert" className="earnings-error"><p>{message(visible.error)}</p><button className="button secondary" type="button" disabled={busy} onClick={retry}>重试读取</button></div>:null}
  <div hidden={Boolean(visible?.selectedId)}>
   <div className="earnings-filters"><label>记录状态<select aria-label="佣金记录状态" value={filter} disabled={busy} onChange={event=>navigate(null,event.target.value as EarningFilter)}>{earningStates.map(state=><option key={state} value={state}>{labels[state]}</option>)}</select></label></div>
   {page&&(summary?.knowledge==='UNKNOWN'||!summary)?<p className="earnings-note" role="status">部分记录还在核对，完整数量与金额暂未确认。{summary?.unclassifiedRecordCount&&summary.unclassifiedRecordCount!=='0'?`${filter==='ALL'||filter==='UNKNOWN'?'其中':'另有'} ${BigInt(summary.unclassifiedRecordCount).toLocaleString('zh-CN')} 条记录状态待核。`:''}待核对记录不作为当前待入账事项，可用金额请查看钱包。</p>:null}
   {page?.items.length?<ul className="earnings-records" aria-label="佣金记录时间线">{page.items.map(item=>{const record=recordView(item);return <li key={record.key}><button className="earning-record" type="button" disabled={busy} onClick={e=>void open(item.id,e.currentTarget)}><span><strong>{roleLabel(item.role)}</strong><small>{formatOrderTime(record.occurredAt)}</small></span><span className="earning-record-value"><strong>{commissionRecordMoney(record.amountCents)}</strong><small>{labels[record.state]}</small></span><ChevronRight size={16} aria-hidden="true"/></button></li>;})}</ul>:<p className="earnings-empty">{busy?'正在读取佣金记录…':summary?.knowledge==='KNOWN'?'当前状态暂无佣金记录。':page?'暂未读到匹配记录，完整数量仍待核对。':'佣金记录当前不可用。'}</p>}
   {page?.nextCursor?<button className="button secondary" type="button" disabled={busy} onClick={()=>void more()}>加载更多收益</button>:null}
  </div>
  {visible?.selectedId?<div className="earning-detail"><button type="button" className="button secondary" onClick={back}><ArrowLeft size={15} aria-hidden="true"/>返回收益列表</button>{detail&&shown?<><h4 ref={detailHeading} tabIndex={-1}>{roleLabel(detail.role)}详情</h4><strong className="earning-detail-amount">{commissionRecordMoney(shown.amountCents)}</strong><dl><div><dt>记录状态</dt><dd>{labels[shown.state]}</dd></div><div><dt>记录时间</dt><dd>{formatOrderTime(shown.occurredAt)}</dd></div>{responsibility?.knowledge==='KNOWN'?<><div><dt>当前责任</dt><dd>{responsibilityText(responsibility)}</dd></div><div><dt>当前责任金额</dt><dd>{commissionRecordMoney(responsibility.amountCents)}</dd></div><div><dt>预计成熟时间</dt><dd>{responsibility.maturityAt===null?'未核定':formatOrderTime(responsibility.maturityAt)}</dd></div>{responsibility.revised?<div><dt>责任修订</dt><dd>最终确认后已修订，原记录金额与状态继续保留</dd></div>:null}</>:null}{finance?.knowledge==='KNOWN'?<><div><dt>本平台承接金额</dt><dd>{commissionRecordMoney(finance.amountCents)}</dd></div><div><dt>财账处理</dt><dd>{finance.zeroFinalization?'金额为 0，没有生成账本记录':'已按原责任入账，渠道到账仍待核'}</dd></div></>:null}{detail.recoveryRequiredCents!==null?<div><dt>待追回金额</dt><dd>{commissionRecordMoney(detail.recoveryRequiredCents)}</dd></div>:null}<div><dt>银行到账</dt><dd>未核定</dd></div></dl>
   <details className="earning-record-explanation"><summary>记录来源与原规则</summary><dl><div><dt>原记录状态</dt><dd>{labels[(detail.record?.detail.originalState??detail.state) as EarningFilter]}</dd></div><div><dt>原记录金额</dt><dd>{commissionRecordMoney(detail.record?.detail.originalAmountCents??detail.amount.amountCents)}</dd></div><div><dt>记录来源</dt><dd>{detail.origin==='LEGACY_MYSQL'?'历史记录':'本平台记录'}</dd></div><div><dt>原预计结算时间</dt><dd>{detail.dueAt===null?'未核定':formatOrderTime(detail.dueAt)}</dd></div><div><dt>余额处理</dt><dd>{detail.record?.detail.accountingEffect==='EXISTING_LEDGER_EVENT'||detail.accountingEffect==='EXISTING_LEDGER_EVENT'?'已有站内记账依据，当前可用金额以钱包为准。':'记录供核对，当前展示不会增加可用余额。'}</dd></div></dl><EarningBasis item={detail}/>{detail.includedInOpening?<p>这笔记录已算进承接余额，不会再重复入账。</p>:null}</details>
   <p>{shown.state==='RECOVERY_REQUIRED'?'这笔记录原先已结算，需要追回的金额还没扣完。':'记录金额与当前可用余额分别核对，提现结果以原提现记录为准。'}{responsibility?.knowledge==='KNOWN'&&responsibility.state==='MATURED'?'责任已到期，仍需平台完成结算；到期时间不代表已入账或银行到账。':''}</p></>:busy?<p role="status">正在读取佣金详情…</p>:null}</div>:null}
  <div className="earnings-wallet-link"><span>佣金记录不重复增加钱包余额</span><Link className="button secondary" href="/account?view=wallet" scroll={false}>查看钱包与流水</Link></div>
 </section>;
}
