"use client";
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {useEffect,useRef,useState} from 'react';
import {Select} from '@base-ui/react/select';
import {ChevronRight,ArrowLeft,Filter,BarChart3,ChevronDown,Check} from 'lucide-react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readEarnings,readEarningDetail,earningStates,commissionStateLabel,commissionRecordMoney,type EarningFilter,type EarningsPage,type EarningItem,type CurrentLegacyResponsibility} from '@/lib/distribution-earnings-client';
import {WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import {commissionRoleLabel} from '@zzsh/ui/display-distribution';
import './financial-primitives.css';
import './personal-earnings.css';
const labels=Object.fromEntries(earningStates.map(state=>[state,state==='MATURED'?'已到期，待结算':commissionStateLabel(state)])) as Record<EarningFilter,string>;
const settlementStates:EarningFilter[]=['PENDING','MATURED','SETTLED'];
const roleLabel=commissionRoleLabel;
const timeText=(value:string)=>formatOrderTime(value,{timeZoneName:false});
const responsibilityText=(r:CurrentLegacyResponsibility)=>r.knowledge!=='KNOWN'?'收益状态待确认':r.state==='VOID'?'这笔佣金已取消':r.state==='MATURED'?'已到可结算时间，等待结算':r.state==='SETTLED'?r.settledBy==='LEGACY_RECORDS'?'已由原平台处理':'记录显示已结清，余额请查看钱包':'尚未到结算时间';
function recordView(item:EarningItem){
 const responsibility=item.record?.detail.currentResponsibility??item.currentResponsibility;
 const state=item.record?.effectiveState??(responsibility?.knowledge==='KNOWN'?responsibility.state:item.origin==='LEGACY_MYSQL'&&item.state==='PENDING'?'UNKNOWN':item.state);
 return{key:item.record?.key??item.id,state,amountCents:item.record?.amountCents??(responsibility?.knowledge==='KNOWN'?responsibility.amountCents:item.amount.amountCents),occurredAt:item.record?.occurredAt??item.occurredAt};
}
const message=(e:WalletRequestError)=>e.status===401?'登录状态已变化，请重新登录。':e.status===403?'当前账号无法查看这些佣金记录。':e.status===404?'这条佣金记录暂不可用。':e.status===409?'佣金记录已更新，请刷新后查看。':'佣金记录暂时无法查看，请稍后重试。';

function EarningBasis({item}:{item:EarningItem}){
 const c=item.calculation;
 return <section className="earning-calculation" aria-label="佣金计算方式"><h5>计算方式</h5>{item.origin==='LEGACY_MYSQL'
  ? <>{c?.knowledge==='RECORDED_SOURCE'?<dl><div><dt>原佣金比例</dt><dd>{c.percent}%</dd></div>{c.levelId?<div><dt>原分销档位 ID</dt><dd>{c.levelId}</dd></div>:null}</dl>:<p>原计算比例待核。</p>}{item.state==='EXPIRED'?<p>记录已失效，原因尚未提供。</p>:null}</>
  : c?.knowledge==='KNOWN'?<><dl><div><dt>佣金比例</dt><dd>{c.percent}%</dd></div>{c.rateMode==='UNIFORM'?null:<div><dt>当时的等级</dt><dd>{c.beneficiaryLevelName??c.beneficiaryLevelCode}</dd></div>}{c.orderNumber?<div><dt>关联订单</dt><dd>{c.orderNumber}</dd></div>:null}</dl><p>{c.basis==='LEGACY_RENTAL_CAPTURE_MINUS_OWNER_AND_REFUND'?'佣金按实付扣除号主实结与租客应退后的金额计算，四舍五入到分。':'佣金按订单结算后的平台收益扣除补偿费用计算，金额四舍五入到分。'}</p>{c.scope==='LOCAL_CONTROLLED'?<p>测试记录，不代表正式佣金。</p>:null}</>
  : <p>这笔佣金的计算规则尚未确认。</p>}</section>;
}
type View={scope:string;filter:EarningFilter;reload:number;page:EarningsPage|null;selectedId:string|null;detail:EarningItem|null;busy:boolean;error:WalletRequestError|null};
function refreshedPage(previous:EarningsPage|null,next:EarningsPage):EarningsPage{
 const same=previous?.snapshotVersion&&previous.snapshotVersion===next.snapshotVersion&&previous.knowledge===next.knowledge&&previous.count===next.count&&previous.mappedRecordCount===next.mappedRecordCount&&JSON.stringify(previous.amountsByOrigin)===JSON.stringify(next.amountsByOrigin)&&JSON.stringify(previous.recordSummary)===JSON.stringify(next.recordSummary)&&next.items.every((item,index)=>(previous.items[index]?.record?.key??previous.items[index]?.id)===(item.record?.key??item.id));
 return same?previous:next;
}
export function PersonalEarnings({scope,refreshNonce=0}:{scope:string;refreshNonce?:number}){
 const params=useSearchParams(),router=useRouter(),rawFilter=params.get('earningState'),filter:EarningFilter=earningStates.includes(rawFilter as EarningFilter)?rawFilter as EarningFilter:'ALL';
 const selectedId=params.has('earning')?params.get('earning')||'INVALID':null,invalidId=selectedId!==null&&(!/^(native|history):[A-Za-z0-9_-]{1,180}$/.test(selectedId)||params.getAll('earning').length!==1);
 const routeKey=JSON.stringify([filter,selectedId,invalidId]);
 const session=useUserSession(),store=useUserSessionStore(),live=useRef({scope,routeKey,mounted:false});live.current.scope=scope;live.current.routeKey=routeKey;
 const [reload,setReload]=useState(0),revision=reload+refreshNonce,[view,setView]=useState<View>({scope,filter,reload:revision,page:null,selectedId,detail:null,busy:true,error:null});
 const [visibleLimit,setVisibleLimit]=useState(8);
 useEffect(()=>{setVisibleLimit(8);},[filter,scope,revision]);
 const ticket=useRef(0),abort=useRef<AbortController|null>(null),trigger=useRef<HTMLButtonElement|null>(null),backFocus=useRef(false),heading=useRef<HTMLHeadingElement|null>(null),detailHeading=useRef<HTMLHeadingElement|null>(null),previousSelection=useRef(selectedId),listPosition=useRef<{scope:string;filter:EarningFilter;y:number}|null>(null);
 if(previousSelection.current!==selectedId){if(previousSelection.current!==null&&selectedId===null)backFocus.current=true;previousSelection.current=selectedId;}
 const current=()=>{const s=store.getSnapshot();return live.current.mounted&&live.current.scope===scope&&s.status==='authenticated'&&s.userId===session.userId&&scope===s.userId+':'+s.identityVersion;};
 const begin=()=>{abort.current?.abort();abort.current=new AbortController();return{id:++ticket.current,signal:abort.current.signal};};
 const valid=(id:number)=>current()&&live.current.routeKey===routeKey&&id===ticket.current;
 const fail=(error:unknown,id:number)=>{if(!valid(id))return;const e=error instanceof WalletRequestError?error:new WalletRequestError(0,'NETWORK_ERROR');setView(v=>({...v,busy:false,error:e,...([401,403,409].includes(e.status)?{page:null,detail:null}:{})}));if(e.status===401)session.revalidate();};
 useEffect(()=>{
  live.current.mounted=true;const task=begin(),same=view.scope===scope&&view.filter===filter,cached=same?view.page:null,needsRefresh=!same||view.reload!==revision;
  const cachedDetail=same&&view.selectedId===selectedId?view.detail:null;
  setView({scope,filter,reload:revision,page:cached,selectedId,detail:cachedDetail,busy:invalidId?false:selectedId!==null||!cached||needsRefresh,error:invalidId?new WalletRequestError(404,'NOT_FOUND'):null});
  if(session.userId&&current()&&!invalidId){
   // A detail uses the ALL snapshot; a filtered list has its own signed cursor context.
   if(selectedId!==null){const detail=readEarningDetail(session.userId,selectedId,task.signal),list=needsRefresh?readEarnings(session.userId,filter,null,task.signal):Promise.resolve(null);void Promise.all([detail,list]).then(([result,next])=>{if(valid(task.id))setView(v=>{const page=next?refreshedPage(v.page,next):v.page;return{...v,detail:result.item,page:filter!=='ALL'||page?.snapshotVersion===result.snapshotVersion?page:null,busy:false};});},e=>fail(e,task.id));}
   else if(!cached||needsRefresh)void readEarnings(session.userId,filter,null,task.signal).then(page=>{if(valid(task.id))setView({scope,filter,reload:revision,page:refreshedPage(cached,page),selectedId:null,detail:null,busy:false,error:null});},e=>fail(e,task.id));
  }
  return()=>{live.current.mounted=false;abort.current?.abort();ticket.current++;};
 // Every result is bound to the original identity scope and request generation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,routeKey,revision]);
 const visible=view.scope===scope&&view.filter===filter&&current()?view.selectedId===selectedId?view:{...view,selectedId,detail:null,busy:true}:null;
 useEffect(()=>{if(visible?.detail)detailHeading.current?.focus();else if(backFocus.current&&selectedId===null&&visible&&!visible.busy){backFocus.current=false;(trigger.current?.isConnected?trigger.current:heading.current)?.focus({preventScroll:true});if(listPosition.current?.scope===scope&&listPosition.current.filter===filter)window.scrollTo({top:listPosition.current.y,behavior:'instant'});}},[visible?.detail,selectedId,visible?.busy,scope,filter]);
 const more=async()=>{const page=visible?.page;if(!page?.nextCursor||!session.userId||!current())return;const task=begin();setView(v=>({...v,busy:true,error:null}));try{const next=await readEarnings(session.userId,filter,page.nextCursor,task.signal);if(!valid(task.id))return;if(next.snapshotVersion!==page.snapshotVersion||next.knowledge!==page.knowledge||next.count!==page.count||next.mappedRecordCount!==page.mappedRecordCount||JSON.stringify(next.amountsByOrigin)!==JSON.stringify(page.amountsByOrigin)||JSON.stringify(next.recordSummary)!==JSON.stringify(page.recordSummary)||next.items.some(n=>page.items.some(p=>(p.record?.key??p.id)===(n.record?.key??n.id)))||BigInt(next.items.length+page.items.length)>BigInt(next.recordSummary?.mappedRecordCount??next.mappedRecordCount))throw new WalletRequestError(409,'EARNINGS_PAGE_CHANGED');setView(v=>({...v,page:{...next,items:[...page.items,...next.items]},busy:false}));}catch(e){fail(e,task.id);}};
 const navigate=(id:string|null,nextFilter:EarningFilter=filter)=>{const q=new URLSearchParams(params.toString());if(!q.has('view'))q.set('view','invite');if(id===null)q.delete('earning');else q.set('earning',id);if(nextFilter==='ALL')q.delete('earningState');else q.set('earningState',nextFilter);router.push('/account?'+q,{scroll:false});};
 const open=(id:string,button:HTMLButtonElement)=>{if(!session.userId||!current())return;trigger.current=button;listPosition.current={scope,filter,y:window.scrollY};navigate(id);};
 const back=()=>{abort.current?.abort();ticket.current++;backFocus.current=true;navigate(null);};
 const retry=()=>setReload(n=>n+1),detail=visible?.detail,page=visible?.page,busy=visible?.busy??true;
 const shown=detail?recordView(detail):null,responsibility=detail?.record?.detail.currentResponsibility??detail?.currentResponsibility,finance=detail?.record?.detail.currentFinance??detail?.currentFinance,summary=page?.recordSummary;
 return <section className="personal-earnings account-module-card" aria-labelledby="personal-earnings-heading" aria-busy={busy||undefined}>
  <div className="earnings-heading">
    <div className="earnings-header-summary">
      <div className="earnings-title-row">
        <h3 id="personal-earnings-heading" ref={heading} tabIndex={-1}>佣金记录</h3>
        <span className="earnings-count-badge">
          {summary?.count!==null&&summary?.count!==undefined?BigInt(summary.count).toLocaleString('zh-CN')+' 条记录':summary?'已收录 '+BigInt(summary.mappedRecordCount).toLocaleString('zh-CN')+' 条 · 完整数量待核':page?'已显示 '+page.items.length+' 条 · 完整数量待核':'连续查看佣金记录及当前核对状态'}
        </span>
      </div>
      {summary?<p className="earnings-total"><span className="earnings-total-label">{summary.knowledge==='KNOWN'?'记录金额合计':'已确认的记录金额'}</span> <strong className="earnings-total-amount">{commissionRecordMoney(summary.knowledge==='KNOWN'?summary.amountCents:summary.knownSubtotalCents)}</strong> <small className="earnings-total-tip">不代表余额</small></p>:null}
    </div>
  </div>
  {visible?.error?<div role="alert" className="earnings-error"><p>{message(visible.error)}</p><button className="button secondary" type="button" disabled={busy} onClick={retry}>重试读取</button></div>:null}
  <div hidden={Boolean(visible?.selectedId)}>
   <div className="earnings-filters">
     <div className="earnings-filter-label">
       <Filter size={14} aria-hidden="true" />
       <span>记录状态</span>
     </div>
     <Select.Root value={filter} onValueChange={next=>{if(next)navigate(null,next as EarningFilter);}} disabled={busy}>
       <Select.Trigger className="earnings-shadcn-trigger" aria-label="佣金记录状态选择">
         <Select.Value>{labels[filter]??labels.ALL}</Select.Value>
         <Select.Icon><ChevronDown size={14} aria-hidden="true" /></Select.Icon>
       </Select.Trigger>
       <Select.Portal>
         <Select.Positioner sideOffset={6} align="start" className="form-select-positioner">
           <Select.Popup className="form-select-popup earnings-select-popup">
             <Select.List>
               <Select.Item value="ALL" className="form-select-option">
                 <Select.ItemText>{labels.ALL}</Select.ItemText>
                 <Select.ItemIndicator className="form-select-check"><Check size={14} /></Select.ItemIndicator>
               </Select.Item>
               <Select.Group className="form-select-group">
                 <Select.GroupLabel className="form-select-group-label">结算进度</Select.GroupLabel>
                 {earningStates.filter(state=>settlementStates.includes(state)).map(state=><Select.Item key={state} value={state} className="form-select-option">
                   <Select.ItemText>{labels[state]}</Select.ItemText>
                   <Select.ItemIndicator className="form-select-check"><Check size={14} /></Select.ItemIndicator>
                 </Select.Item>)}
               </Select.Group>
               <Select.Group className="form-select-group">
                 <Select.GroupLabel className="form-select-group-label">其他状态</Select.GroupLabel>
                 {earningStates.filter(state=>state!=='ALL'&&!settlementStates.includes(state)).map(state=><Select.Item key={state} value={state} className="form-select-option">
                   <Select.ItemText>{labels[state]}</Select.ItemText>
                   <Select.ItemIndicator className="form-select-check"><Check size={14} /></Select.ItemIndicator>
                 </Select.Item>)}
               </Select.Group>
             </Select.List>
           </Select.Popup>
         </Select.Positioner>
       </Select.Portal>
     </Select.Root>
     <select aria-label="佣金记录状态" value={filter} disabled={busy} tabIndex={-1} aria-hidden="true" className="earnings-hidden-select" onChange={event=>navigate(null,event.target.value as EarningFilter)}>
       <option value="ALL">{labels.ALL}</option>
       <optgroup label="结算进度">{earningStates.filter(state=>settlementStates.includes(state)).map(state=><option key={state} value={state}>{labels[state]}</option>)}</optgroup>
       <optgroup label="其他状态">{earningStates.filter(state=>state!=='ALL'&&!settlementStates.includes(state)).map(state=><option key={state} value={state}>{labels[state]}</option>)}</optgroup>
     </select>
   </div>
   {summary?.states.length?<details className="earnings-breakdown"><summary><BarChart3 size={15} aria-hidden="true" className="breakdown-icon" />各状态记录<ChevronDown size={14} className="breakdown-chevron" aria-hidden="true" /></summary><ul className="breakdown-grid">{summary.states.map(group=><li key={group.state} className="breakdown-chip"><span className="chip-state">{labels[group.state]}</span><span className="chip-count">{BigInt(group.count).toLocaleString('zh-CN')} 条</span><strong className="chip-amount">{commissionRecordMoney(group.amountCents)}</strong></li>)}</ul></details>:null}
   {page&&(summary?.knowledge==='UNKNOWN'||!summary)?<p className="earnings-note" role="status">部分记录还在核对，数量与金额暂未确认。{summary?.unclassifiedRecordCount&&summary.unclassifiedRecordCount!=='0'?`${filter==='ALL'||filter==='UNKNOWN'?'其中':'另有'} ${BigInt(summary.unclassifiedRecordCount).toLocaleString('zh-CN')} 条记录状态待确认。`:''}余额请以钱包为准。</p>:null}
   {page?.items.length?<ul className="earnings-records" aria-label="佣金记录时间线">{(page.items.slice(0,visibleLimit)).map(item=>{const record=recordView(item);return <li key={record.key}><button className="earning-record" type="button" disabled={busy} onClick={e=>void open(item.id,e.currentTarget)}><span><strong>{roleLabel(item.role)}</strong><small>{timeText(record.occurredAt)}</small></span><span className="earning-record-value"><strong>{commissionRecordMoney(record.amountCents)}</strong><small className={`earning-status-badge state-${record.state.toLowerCase()}`}>{labels[record.state]}</small></span><ChevronRight size={16} aria-hidden="true"/></button></li>;})}</ul>:<p className="earnings-empty">{busy?'正在读取佣金记录…':summary?.knowledge==='KNOWN'?'当前状态暂无佣金记录。':page?'暂未读到匹配记录，完整数量仍待核对。':'佣金记录当前不可用。'}</p>}
   {page&&page.items.length>visibleLimit?<button className="button secondary earnings-show-more" type="button" disabled={busy} onClick={()=>setVisibleLimit(n=>n+8)}>展开更多记录（已显示 {Math.min(visibleLimit,page.items.length)} / {page.items.length} 条）</button>:null}
   {page?.nextCursor&&visibleLimit>=page.items.length?<button className="button secondary" type="button" disabled={busy} onClick={()=>void more()}>加载更多收益</button>:null}
  </div>
  {visible?.selectedId?<div className="earning-detail"><button type="button" className="button secondary" onClick={back}><ArrowLeft size={15} aria-hidden="true"/>返回收益列表</button>{detail&&shown?<><h4 ref={detailHeading} tabIndex={-1}>{roleLabel(detail.role)}详情</h4><strong className="earning-detail-amount">{commissionRecordMoney(shown.amountCents)}</strong><dl><div><dt>记录状态</dt><dd>{labels[shown.state]}</dd></div><div><dt>记录时间</dt><dd>{timeText(shown.occurredAt)}</dd></div>{responsibility?.knowledge==='KNOWN'?<><div><dt>收益进度</dt><dd>{responsibilityText(responsibility)}</dd></div><div><dt>预计可结算时间</dt><dd>{responsibility.maturityAt===null?'未核定':timeText(responsibility.maturityAt)}</dd></div>{responsibility.revised?<div><dt>金额调整</dt><dd>金额已调整，可在原记录中查看。</dd></div>:null}</>:null}{finance?.knowledge==='KNOWN'?<><div><dt>入账金额</dt><dd>{commissionRecordMoney(finance.amountCents)}</dd></div><div><dt>入账状态</dt><dd>{finance.zeroFinalization?'本次入账金额为零':'已入账'}</dd></div></>:null}{detail.recoveryRequiredCents!==null?<div><dt>待追回金额</dt><dd>{commissionRecordMoney(detail.recoveryRequiredCents)}</dd></div>:null}</dl>
   <details className="earning-record-explanation"><summary>查看原记录和计算方式</summary><dl><div><dt>原记录状态</dt><dd>{labels[(detail.record?.detail.originalState??detail.state) as EarningFilter]}</dd></div><div><dt>原记录金额</dt><dd>{commissionRecordMoney(detail.record?.detail.originalAmountCents??detail.amount.amountCents)}</dd></div><div><dt>记录来源</dt><dd>{detail.origin==='LEGACY_MYSQL'?'历史记录':'当前记录'}</dd></div><div><dt>原预计结算时间</dt><dd>{detail.dueAt===null?'未核定':timeText(detail.dueAt)}</dd></div><div><dt>余额处理</dt><dd>{detail.record?.detail.accountingEffect==='EXISTING_LEDGER_EVENT'||detail.accountingEffect==='EXISTING_LEDGER_EVENT'?'余额请以钱包为准。':'查看记录不会改变余额。'}</dd></div></dl><EarningBasis item={detail}/>{detail.includedInOpening?<p>这笔收益已包含在余额中，不会重复计算。</p>:null}</details>
   <p>{shown.state==='RECOVERY_REQUIRED'?'这笔记录原先已结算，需要追回的金额还没扣完。':'余额和提现进度可在钱包查看。'}{responsibility?.knowledge==='KNOWN'&&responsibility.state==='MATURED'?'已到可结算时间，仍需等待结算。':''}</p></>:busy?<p role="status">正在读取佣金详情…</p>:null}</div>:null}
  <div className="earnings-wallet-link"><span>余额与提现进度</span><Link className="button secondary" href="/account?view=wallet" scroll={false}>查看钱包</Link></div>
 </section>;
}
