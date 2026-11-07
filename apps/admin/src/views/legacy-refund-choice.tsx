import {useEffect,useState} from 'react';
import {friendlyError} from '../api';
import {Button} from '../components/ui-elements';
import {Checkbox} from '../components/ui/checkbox';
import {Textarea} from '../components/ui/textarea';
import {readLegacyAdminDemoRefund,type LegacyDemoScope} from '../lib/legacy-continuation-client';
import {LegacyRefundReviewPanel} from './legacy-refund-review-panel';

type Props={orderId:string;dutyId:string;dutyRevision:string;amountCents:string;refresh:string;disabled:boolean;money:(value:string)=>string;
 onReview:(body:Record<string,unknown>)=>void;onDemoReview:(body:Record<string,unknown>,scope:LegacyDemoScope)=>void;onRefresh:()=>void};
type Demo=Awaited<ReturnType<typeof readLegacyAdminDemoRefund>>;
const reasonText:Record<string,string>={SIMULATION_ALREADY_EXISTS:'本次模拟退款已记录。',SIMULATION_DISABLED:'当前未启用模拟退款。',ORDER_NOT_SETTLED:'订单尚未完成结算。',
 DUTY_ALREADY_PROCESSED:'该退款责任已有处理记录，请先核对。',NO_REFUND_DUE:'本单无需退款。',REFUND_DUE_UNKNOWN:'退款处理时间尚未确认。',REFUND_NOT_DUE:'尚未到退款处理时间。',
 ORIGINAL_SOURCE_UNAVAILABLE:'原付款或订单来源暂时无法确认。',REFUND_AMOUNT_EXCEEDS_PAYMENT:'应退金额超出原付款，请联系客服核对。',ORIGINAL_REFUND_CONFLICT:'旧退款记录存在冲突，请先核对。',
 LIABILITY_COVERAGE_UNAVAILABLE:'退款责任资料不完整，请先核对。'};

/** Production keeps the existing review path; the demo path is available only when the API explicitly provides it. */
export function LegacyRefundChoice(props:Props){
 const {orderId,dutyId,dutyRevision,amountCents,refresh,disabled,money,onDemoReview,onRefresh}=props;
 const [state,setState]=useState<{mode:'loading'|'formal'|'error'|'demo';value?:Demo;error?:string}>({mode:'loading'}),[checked,setChecked]=useState(false),[reason,setReason]=useState('');
 useEffect(()=>{const abort=new AbortController();setState({mode:'loading'});setChecked(false);setReason('');
  void readLegacyAdminDemoRefund(orderId,dutyId,abort.signal).then(value=>{if(!abort.signal.aborted)setState({mode:'demo',value});}).catch(error=>{if(!abort.signal.aborted)setState(error&&typeof error==='object'&&'status' in error&&(error as {status?:unknown}).status===404?{mode:'formal'}:{mode:'error',error:friendlyError(error)});});
  return()=>abort.abort();},[orderId,dutyId,refresh]);
 if(state.mode==='formal')return <LegacyRefundReviewPanel {...props}/>;
 if(state.mode==='loading')return <p className="mt-5 text-sm text-muted-foreground" role="status">正在读取退款处理方式…</p>;
 if(state.mode==='error'||!state.value)return <div className="mt-5 text-sm" role="alert"><p>退款处理方式暂时无法确认：{state.error??'请稍后重试。'}</p><Button variant="secondary" size="sm" onClick={onRefresh}>重新读取</Button></div>;
 const value=state.value,stale=value.dutyRevision!==dutyRevision,canSubmit=value.canSubmit&&!stale&&value.headRevision!==null&&!value.receipt;
 return <section className="mt-5 space-y-4 border-t border-border pt-5" aria-label="模拟退款">
  <div><h3 className="text-sm font-semibold">模拟退回租客</h3><p className="mt-1 text-sm text-muted-foreground">测试环境不会调用汇聚；模拟结果不代表实际退款或到账。</p></div>
  <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">本次应退责任</dt><dd className="mt-1 font-medium tabular-nums">{money(amountCents)}</dd></div>
   {value.receipt?<div><dt className="text-muted-foreground">模拟金额</dt><dd className="mt-1 font-medium tabular-nums">{money(value.receipt.amountCents)}</dd></div>:null}</dl>
  {value.receipt?<p className="text-sm" role="status">模拟退款已记录；这不代表实际退款或到账。</p>:stale?<p className="text-sm" role="status">退款责任已更新，请刷新订单后重新核对。</p>:!value.canSubmit?<p className="text-sm text-muted-foreground">{reasonText[value.reason??'']??'当前退款资料尚未确认，请先核对。'}</p>:<>
   <label className="block space-y-1 text-sm"><span>处理说明</span><Textarea aria-label="模拟退款处理说明" value={reason} disabled={disabled} maxLength={500} onChange={event=>setReason(event.target.value)} rows={2}/></label>
   <label className="flex items-start gap-2 text-sm"><Checkbox name={`demo-refund-assumption-${dutyId}`} checked={checked} disabled={disabled} onCheckedChange={value=>setChecked(value===true)}/><span>仅为演示，假设原订单此前未退款；这不是对旧站或汇聚记录的核实。</span></label>
   <Button disabled={disabled||!canSubmit||!checked||[...reason.trim()].length<3} onClick={()=>{if(canSubmit&&value.headRevision!==null)onDemoReview({expectedDutyRevision:value.dutyRevision,expectedHeadRevision:value.headRevision,assumption:'SIMULATION_ASSUME_NO_PRIOR_REFUND',reason:reason.trim()},value.scope);}}>核对模拟退款</Button>
  </>}
  {stale?<Button variant="secondary" size="sm" disabled={disabled} onClick={onRefresh}>刷新订单</Button>:null}
 </section>;
}
