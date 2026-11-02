"use client";
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {useUserSession,useUserSessionStore} from '@/components/session/user-session-provider';
import {readDistributionSummary,type DistributionSummary} from '@/lib/distribution-summary-client';
import {commissionRecordMoney,commissionStateLabel,earningStates} from '@/lib/distribution-earnings-client';
import {WalletRequestError} from '@/lib/personal-wallet-client';
import {formatOrderTime} from '@/lib/order-client';
import './personal-distribution-summary.css';

function errorText(error:unknown){return error instanceof WalletRequestError?(error.status===401?'登录身份已变化，请重新确认登录。':error.status===403?'当前账号无法读取佣金记录概况。':'佣金记录概况暂时无法读取，请重试。'):'佣金记录概况暂时无法读取，请重试。';}
const countText=(value:string)=>BigInt(value).toLocaleString('zh-CN');
export function PersonalDistributionSummary({scope}:{scope:string}){
 const session=useUserSession(),store=useUserSessionStore();
 const [state,setState]=useState<{scope:string;value:DistributionSummary|null;error:string;busy:boolean}>({scope,value:null,error:'',busy:true}),[nonce,setNonce]=useState(0);
 useEffect(()=>{const controller=new AbortController(),ownsScope=()=>{const current=store.getSnapshot();return current.status==='authenticated'&&`${current.userId}:${current.identityVersion}`===scope;};setState({scope,value:null,error:'',busy:true});
  readDistributionSummary(controller.signal,session.userId??undefined).then(value=>{if(!controller.signal.aborted&&ownsScope())setState({scope,value,error:'',busy:false});},error=>{if(!controller.signal.aborted&&ownsScope()){setState({scope,value:null,error:errorText(error),busy:false});if(error instanceof WalletRequestError&&error.status===401)void session.revalidate();}});
  return()=>controller.abort();},[scope,nonce]);
 const current=store.getSnapshot(),ownsScope=current.status==='authenticated'&&`${current.userId}:${current.identityVersion}`===scope;
 const value=state.scope===scope&&ownsScope?state.value:null,busy=state.scope===scope?state.busy:true,error=state.scope===scope&&ownsScope?state.error:'',summary=value?.unified;
 const groups=summary?earningStates.slice(1).flatMap(code=>{const group=summary.states.find(item=>item.state===code);return group?[group]:[];}):[];
 return <section className="account-module-card distribution-summary" aria-labelledby="distribution-summary-heading" aria-busy={busy||undefined}>
  <div className="distribution-summary-heading"><div><h3 id="distribution-summary-heading">佣金记录概况</h3><p>邀请产生的佣金连续记录，可用金额以钱包为准。</p></div><button type="button" className="button secondary" disabled={busy} onClick={()=>setNonce(value=>value+1)}><RefreshCw size={15} aria-hidden="true"/>重新读取</button></div>
  {error?<p className="invitation-error" role="alert">{error}</p>:null}
  {!value&&busy?<p className="invitation-source">正在读取佣金记录概况…</p>:null}
  {summary?<>
    <dl className="distribution-summary-stats"><div><dt>{summary.knowledge==='KNOWN'?'记录金额合计':'已收录金额小计'}</dt><dd>{commissionRecordMoney(summary.knowledge==='KNOWN'?summary.amountCents:summary.knownSubtotalCents)}</dd><small>记录金额不等于可用余额</small></div><div><dt>佣金记录</dt><dd>{countText(summary.count??summary.mappedRecordCount)} 条</dd><small>{summary.count===null?'已收录数量，完整数量待核':'按同一记录口径去重'}</small></div></dl>
    {summary.knowledge==='UNKNOWN'?<p className="distribution-summary-pending" role="status">部分记录还在核对，暂不能确认完整数量和金额。{summary.unknownStateCount!=='0'?`其中 ${countText(summary.unknownStateCount)} 条状态待核，不作为当前待入账事项。`:''}</p>:null}
    {groups.length?<ul className="distribution-summary-states" aria-label="已收录佣金状态">{groups.map(group=><li key={group.state}><span>{commissionStateLabel(group.state)}</span><strong>{countText(group.count)} 条</strong><span className="distribution-record-money">{commissionRecordMoney(group.amountCents)}</span></li>)}</ul>:summary.knowledge==='KNOWN'?<p className="invitation-empty">当前没有已收录的佣金记录。</p>:null}
    <details className="distribution-summary-detail"><summary>记录金额与可用余额有什么不同？</summary><p>这里按已收录的佣金记录核对金额和状态，不重复增加钱包余额。取消、撤销、待核对等状态应分别查看；可用金额与提现结果以钱包记录为准。</p><p>{summary.coverage.knowledge==='KNOWN'?'当前记录覆盖已核定。':'记录覆盖还未完成，已收录小计不是完整金额。'}{summary.coverage.cutoff?` 核对截止 ${formatOrderTime(summary.coverage.cutoff)}。`:''}</p><p>来源、适用规则及当前责任可在每条佣金详情中查看。</p></details>
  </>:value?<p role="status" className="distribution-summary-pending">记录汇总仍待核对，可先查看已收录记录；当前可用余额不由这些记录相加。</p>:null}
  <div className="distribution-summary-footer"><span>{value?`读取于 ${formatOrderTime(value.asOf)}`:''}</span><Link className="button secondary" href="/account?view=invite#personal-earnings-heading" scroll={false}>查看佣金记录</Link></div>
 </section>;
}
