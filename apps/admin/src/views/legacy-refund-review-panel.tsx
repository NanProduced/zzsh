import {useEffect,useState} from 'react';
import {parseYuanToCents} from '@zzsh/ui/display-money';
import {formatDate,friendlyError} from '../api';
import {Button} from '../components/ui-elements';
import {Checkbox} from '../components/ui/checkbox';
import {Input} from '../components/ui/input';
import {queryLegacyAdminRefund,readLegacyAdminRefund,resolveLegacyAdminRefund,resumeLegacyAdminRefund,retryLegacyAdminRefund,submitLegacyAdminRefund,type LegacyRefundBasis} from '../lib/legacy-continuation-client';

const labels:Record<string,string>={READY:'待提交',SUBMITTING:'已登记尝试，发送结果待核',UNKNOWN:'结果待核对',PROCESSING:'渠道处理中',
  REVIEW_REQUIRED:'结果有冲突，待核对',SUCCEEDED:'渠道已确认退款',FAILED:'渠道确认未执行'};

export function LegacyRefundReviewPanel({orderId,dutyId,refresh,disabled,money,onReview}:{orderId:string;dutyId:string;refresh:string;
  disabled:boolean;money:(value:string)=>string;onReview:(body:Record<string,unknown>)=>void}){
  const [basis,setBasis]=useState<LegacyRefundBasis|null>(null),[error,setError]=useState(''),[prior,setPrior]=useState(''),[applied,setApplied]=useState('');
  const [reference,setReference]=useState(''),[checked,setChecked]=useState(false),[querying,setQuerying]=useState(false),[queryNote,setQueryNote]=useState(''),[reload,setReload]=useState(0),[confirmSend,setConfirmSend]=useState(false),[reviewReason,setReviewReason]=useState('');
  const [dueVerified,setDueVerified]=useState(false),[releaseVerified,setReleaseVerified]=useState(false);
  const [retryPrior,setRetryPrior]=useState(''),[retryReason,setRetryReason]=useState(''),[retryChecked,setRetryChecked]=useState(false),[confirmRetry,setConfirmRetry]=useState(false);
  useEffect(()=>{const abort=new AbortController();setBasis(null);setError('');setDueVerified(false);setReleaseVerified(false);
    void readLegacyAdminRefund(orderId,dutyId,abort.signal).then(value=>{if(!abort.signal.aborted)setBasis(value);})
      .catch(reason=>{if(!abort.signal.aborted)setError(friendlyError(reason));});return()=>abort.abort();
  },[orderId,dutyId,refresh,reload]);
  const previous=parseYuanToCents(prior),used=parseYuanToCents(applied);
  const amounts=basis&&previous!==null&&used!==null&&basis.paidCents!==null?{
    paid:BigInt(basis.paidCents),duty:BigInt(basis.dutyCents),previous:BigInt(previous),used:BigInt(used)}:null;
  const valid=!!amounts&&amounts.previous<=amounts.paid&&amounts.used<=amounts.previous&&amounts.used<=amounts.duty
    && amounts.duty-amounts.used<=amounts.paid-amounts.previous;
  const remaining=valid&&amounts?(amounts.duty-amounts.used).toString():null;
  const progress=basis?.progress,receipt=basis?.receipt,current=basis?.current;
  const status=current?.intentId===null?(receipt?.dutyCents==='0'?'本次无需退款':'本次责任已由旧退款抵扣'):progress?labels[progress.state]??'结果待核对':'退款进度待核对';
  async function query(action:'query'|'submit'){
    if(!current?.intentId||querying||disabled)return;setQuerying(true);setQueryNote('');
    try{const result=await (action==='submit'?submitLegacyAdminRefund(current.intentId):queryLegacyAdminRefund(current.intentId));
      setQueryNote(result.kind==='UNKNOWN'?'查询结果尚未确认，请稍后核对。':result.kind==='NOT_DISPATCHED'?'原退款尚未提交，暂不能查询。'
        :result.kind==='SKIPPED'?(result.reason==='THROTTLED'?'操作过于频繁，请稍后再试。':result.reason==='NEW_REFUND_DISABLED'?'当前未启用退款提交。':'退款正在处理或暂不可操作。')
        :action==='submit'?'已处理原退款请求，请查看最新进度。':'已查询原退款，请查看最新进度。');
      setConfirmSend(false);
      setReload(value=>value+1);
    }catch(reason){setQueryNote(friendlyError(reason));}finally{setQuerying(false);}
  }
  async function resume(){
    if(!current?.intentId||querying||disabled||reviewReason.trim().length<3)return;setQuerying(true);setQueryNote('');
    try{const result=await resumeLegacyAdminRefund(current.intentId,reviewReason);
      setQueryNote(result.kind==='UNKNOWN'?'操作结果尚未确认，请刷新核对。':'已恢复原退款查询，不会重新发起退款。');setReviewReason('');setReload(value=>value+1);
    }catch(reason){setQueryNote(friendlyError(reason));}finally{setQuerying(false);}
  }
  async function resolve(){
    const target=current?.blockedBy?.intentId??current?.intentId;
    if(!target||querying||disabled||reviewReason.trim().length<3)return;setQuerying(true);setQueryNote('');
    try{const result=await resolveLegacyAdminRefund(target,reviewReason);
      setQueryNote(result.kind==='UNKNOWN'?'查询结果尚未确认，请刷新后核对。':result.event==='REVIEW_RESOLVED'?'核对完成，渠道最新结果与原记录一致。':'仍需核对，系统未更改原退款结果。');
      setReviewReason('');setReload(value=>value+1);
    }catch(reason){setQueryNote(friendlyError(reason));}finally{setQuerying(false);}
  }
  async function retry(){
    const confirmed=parseYuanToCents(retryPrior);
    if(!current?.intentId||querying||disabled||confirmed===null||confirmed!==current.previouslyRefundedCents||!retryChecked||retryReason.trim().length<3)return;
    setQuerying(true);setQueryNote('');
    try{const result=await retryLegacyAdminRefund(current.intentId,{previouslyRefundedCents:confirmed,noUnresolvedRefunds:true,reason:retryReason.trim()});
      setQueryNote(result.kind==='UNKNOWN'?'请求结果尚未确认，请刷新核对。':'已创建或找回原付款的退款任务，请查看最新进度。');
      setConfirmRetry(false);setRetryChecked(false);setRetryPrior('');setRetryReason('');setReload(value=>value+1);
    }catch(reason){setQueryNote(friendlyError(reason));}finally{setQuerying(false);}
  }
  function submit(){
    if(!basis?.canStart||!basis.headRevision||!basis.paymentOrderNo||!basis.merchantNo||!basis.paidCents||!valid||previous===null||used===null||!checked||reference.trim().length<3||basis.historicalWaitUncertain&&!dueVerified||basis.historicalHeld&&!releaseVerified)return;
    onReview({expectedDutyRevision:basis.dutyRevision,expectedHeadRevision:basis.headRevision,paymentOrderNo:basis.paymentOrderNo,
      confirmedMerchantNo:basis.merchantNo,paidCents:basis.paidCents,previouslyRefundedCents:previous,priorAppliedToDutyCents:used,
      noUnresolvedRefunds:true,evidenceRef:reference.trim(),...(basis.historicalWaitUncertain?{historicalDueVerified:true}:{}),
      ...(basis.historicalHeld?{historicalReleaseVerified:true}:{})});
  }
  return <section className="mt-5 space-y-4 border-t border-border pt-5" aria-label="租客退款核对">
    <div><h3 className="text-sm font-semibold">退回租客</h3><p className="mt-1 text-sm text-muted-foreground">先核对汇聚原付款及历史退款，再创建原路退款任务。</p></div>
    {error?<p role="alert" className="text-sm text-destructive">退款资料暂不可用：{error}</p>:!basis?<p className="text-sm text-muted-foreground">正在读取退款资料…</p>:<>
      <dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">本次应退责任</dt><dd className="mt-1 font-medium tabular-nums">{money(basis.dutyCents)}</dd></div>
        <div><dt className="text-muted-foreground">原付款金额</dt><dd className="mt-1 font-medium tabular-nums">{basis.paidCents?money(basis.paidCents):'未记录'}</dd></div>
        <div><dt className="text-muted-foreground">原付款单号</dt><dd className="mt-1 break-all font-medium">{basis.paymentOrderNo??'未记录'}</dd></div></dl>
      {basis.historicalWaitUncertain?<p className="text-sm text-muted-foreground">旧记录未保存结算方式，请先核对旧站的退款等待期是否结束；提前结算按旧站规则等待 7 天。</p>:null}
      {basis.historicalHeld?<p className="text-sm text-amber-600">旧站曾暂扣本笔退款。请先核实暂扣原因及双方处理结果，确认可解除后再办理。</p>:null}
      {basis.historicalRefunds?.length?<div className="space-y-2 text-sm"><p className="font-medium">旧站关联退款记录</p>
        <ul className="divide-y divide-border rounded-lg border border-border">{basis.historicalRefunds.map((row,index)=><li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" key={`${row.number??'unknown'}-${index}`}>
          <span className="break-all">{row.number??'编号未记录'}{row.at?` · ${formatDate(row.at)}`:''}</span><span className="tabular-nums">{row.amountCents===null?'金额未记录':money(row.amountCents)}</span></li>)}</ul>
        <p className="text-muted-foreground">旧记录仅供追溯，不代表汇聚已退款；累计金额请以汇聚原付款记录核对。{basis.historicalRefundsMore?' 这里只显示最近 20 条，请查看完整旧记录。':''}</p></div>:null}
      {receipt?<div className="space-y-1 rounded-lg bg-muted/50 p-4 text-sm" role="status"><p className="font-medium">{status}</p>
        {current?.generation&&current.generation>1?<p className="text-muted-foreground">第 {current.generation} 次退款尝试</p>:null}
        {current?.refundOrderNo?<p className="break-all text-muted-foreground">退款单号：{current.refundOrderNo}</p>:null}
        <p className="text-muted-foreground">{current?.intentId===null?'无需再次发起退款。':progress?.state==='SUCCEEDED'&&progress.terminal==='SUCCEEDED'?'渠道已确认退款；银行到账时间以银行为准。':'请以渠道处理结果为准，勿重复创建退款。'}</p>
        {progress?.completedAt?<p className="text-muted-foreground">渠道处理时间：{formatDate(progress.completedAt)}</p>:null}
        {current?.intentId&&progress?.state==='READY'&&basis.merchantNo&&!confirmSend?<Button variant="secondary" size="sm" disabled={disabled||querying} onClick={()=>setConfirmSend(true)}>提交退款任务</Button>:null}
        {confirmSend?<div className="flex flex-wrap items-center gap-2"><span>按原退款号提交；已提交时只查询原请求。</span><Button size="sm" disabled={disabled||querying} onClick={()=>void query('submit')}>确认提交</Button><Button variant="secondary" size="sm" disabled={querying} onClick={()=>setConfirmSend(false)}>取消</Button></div>:null}
        {current?.intentId&&!current.blockedBy&&(!progress||!progress.terminal)&&progress?.state!=='READY'?<Button variant="secondary" size="sm" disabled={disabled||querying} onClick={()=>void query('query')}>{querying?'查询中…':'查询汇聚退款结果'}</Button>:null}
        {current?.intentId&&progress?.state==='REVIEW_REQUIRED'&&!progress.terminal&&!current.blockedBy?<div className="space-y-2 border-t border-border pt-3"><p>核对汇聚原退款后，可恢复对原退款号的查询；不会重新发起退款。曾与本单不匹配的记录会保留，恢复查询不代表已退款。</p>
          <label className="block space-y-1"><span>核对说明</span><Input value={reviewReason} disabled={disabled||querying} maxLength={200} onChange={event=>setReviewReason(event.target.value)} placeholder="填写核对结果或依据" /></label>
          <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={disabled||querying||reviewReason.trim().length<3} onClick={()=>void resume()}>核对后恢复查询</Button>
            <Button variant="secondary" size="sm" disabled={disabled||querying||reviewReason.trim().length<3} onClick={()=>void resolve()}>查询并核对汇聚结果</Button></div></div>:null}
        {progress?.state==='REVIEW_REQUIRED'&&(current?.blockedBy||progress.terminal)?<div className="space-y-2 border-t border-border pt-3">
          <p>{current?.blockedBy?`第 ${current.blockedBy.generation} 次退款存在冲突，请先核对该次退款。`:'渠道记录存在冲突，请核对原退款结果。'}</p>
          {current?.blockedBy?<p className="break-all text-muted-foreground">退款单号：{current.blockedBy.refundOrderNo}</p>:null}
          <p className="text-muted-foreground">只查询原退款，不会重新发起。若渠道曾返回相互矛盾的最终结果，仍需联系财务核对。</p>
          <label className="block space-y-1"><span>核对说明</span><Input value={reviewReason} disabled={disabled||querying} maxLength={200} onChange={event=>setReviewReason(event.target.value)} placeholder="填写核对结果或依据" /></label>
          <Button variant="secondary" size="sm" disabled={disabled||querying||reviewReason.trim().length<3} onClick={()=>void resolve()}>{querying?'查询中…':'查询并核对汇聚结果'}</Button></div>:null}
        {current?.intentId&&progress?.state==='FAILED'&&progress.terminal==='FAILED_NO_EXECUTION'&&!current.chainReview&&basis.merchantNo?<div className="space-y-3 border-t border-border pt-3">
          <p>渠道已确认上次退款未执行。再次核对原付款的全部退款后，可重新发起本次退款。</p>
          <label className="block space-y-1"><span>原付款目前累计已退（元）</span><Input inputMode="decimal" maxLength={26} value={retryPrior} disabled={disabled||querying} onChange={event=>{setRetryPrior(event.target.value);setConfirmRetry(false);}} placeholder="核对后填写，包括 0" /></label>
          {retryPrior&&parseYuanToCents(retryPrior)!==current.previouslyRefundedCents?<p role="alert">累计已退与上次核对不一致，请联系财务处理。</p>:null}
          <label className="block space-y-1"><span>核对说明</span><Input value={retryReason} disabled={disabled||querying} maxLength={200} onChange={event=>{setRetryReason(event.target.value);setConfirmRetry(false);}} placeholder="填写失败结果及核对依据" /></label>
          <label className="flex items-start gap-2"><Checkbox name={`refund-retry-reviewed-${dutyId}`} checked={retryChecked} disabled={disabled||querying} onCheckedChange={value=>{setRetryChecked(value===true);setConfirmRetry(false);}}/><span>已核对原付款及全部退款，确认没有结果未明或正在处理的退款。</span></label>
          {!confirmRetry?<Button variant="secondary" size="sm" disabled={disabled||querying||!retryChecked||parseYuanToCents(retryPrior)!==current.previouslyRefundedCents||retryReason.trim().length<3} onClick={()=>setConfirmRetry(true)}>核对并重试退款</Button>
            :<div className="flex flex-wrap items-center gap-2"><span>将按原付款重新发起 {money(current.amountCents)}，保留上次失败记录。</span><Button size="sm" disabled={disabled||querying} onClick={()=>void retry()}>确认重试</Button><Button variant="secondary" size="sm" disabled={querying} onClick={()=>setConfirmRetry(false)}>取消</Button></div>}
        </div>:null}
        {queryNote?<p role="status" className="text-muted-foreground">{queryNote}</p>:null}</div>
      :!basis.canStart?<p className="text-sm text-muted-foreground">暂不能创建退款任务。请核对原付款资料与退款处理时间{basis.refundDueAt?`（${formatDate(basis.refundDueAt)}）`:''}；仍无法处理时联系管理员。</p>
      :<div className="space-y-4"><p className="text-sm text-muted-foreground">商户号 {basis.merchantNo}。请按该原付款单核对汇聚记录；涉及其他退款的金额也需计入历史已退总额。</p>
        <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1.5 text-sm"><span>原付款历史已退总额（元）</span><Input inputMode="decimal" maxLength={26} value={prior} disabled={disabled} onChange={event=>setPrior(event.target.value)} placeholder="核对后填写，包括 0" /></label>
          <label className="space-y-1.5 text-sm"><span>其中已抵本次应退（元）</span><Input inputMode="decimal" maxLength={26} value={applied} disabled={disabled} onChange={event=>setApplied(event.target.value)} placeholder="核对后填写，包括 0" /></label></div>
        {prior&&applied?<p className="text-sm" role={valid?undefined:'alert'}>{valid&&remaining!==null?`本次将创建 ${money(remaining)} 的退款任务。`:'金额不匹配：请核对历史已退、已抵本次及原付款金额。'}</p>:null}
        <label className="block space-y-1.5 text-sm"><span>核对依据</span><Input value={reference} disabled={disabled} maxLength={200} onChange={event=>setReference(event.target.value)} placeholder="填写汇聚核对记录或处理说明" /></label>
        <label className="flex items-start gap-2 text-sm"><Checkbox name={`refund-reviewed-${dutyId}`} checked={checked} disabled={disabled} onCheckedChange={value=>setChecked(value===true)} />
          <span>已核对原付款和历史退款，确认没有结果未明或正在处理的退款。</span></label>
        {basis.historicalWaitUncertain?<label className="flex items-start gap-2 text-sm"><Checkbox name={`refund-due-${dutyId}`} checked={dueVerified} disabled={disabled} onCheckedChange={value=>setDueVerified(value===true)}/><span>已核对旧站的结算方式和等待期，确认本单现在可以退款。</span></label>:null}
        {basis.historicalHeld?<label className="flex items-start gap-2 text-sm"><Checkbox name={`refund-release-${dutyId}`} checked={releaseVerified} disabled={disabled} onCheckedChange={value=>setReleaseVerified(value===true)}/><span>已核实暂扣原因及双方处理结果，确认解除本次暂扣。</span></label>:null}
        <Button disabled={disabled||!valid||!checked||reference.trim().length<3||!!basis.historicalWaitUncertain&&!dueVerified||!!basis.historicalHeld&&!releaseVerified} onClick={submit}>核对并创建退款任务</Button></div>}
    </>}
  </section>;
}
