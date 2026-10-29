import { useEffect,useRef,useState } from "react";
import { adminRequest,AdminApiError,friendlyError } from "../api";
import { Button } from "../components/ui-elements";
import { formatFundingCents } from "./supply-review/model";
import { AdminOriginalRefundPanel } from './admin-original-refund-panel';

type RequestRead={id:string;revision:string;state:"REQUESTED"|"REVIEW_REQUIRED"|"REJECTED"|"APPROVED";reason:string;reviewReason:string|null;fullRefundCents:string|null;liabilityRecognized:boolean;dataOrigin:string;bankArrival:"UNKNOWN"};
type RefundRead={integration:string;truncated:boolean;totals:{allocatedCents:string;consumedCents:string;remainingCents:string}|null;
 intents:{intentId:string|null;state:string;firstSubmit:string;blockedReason:string|null;refundOrderNo:string|null;localWriteOff:string}[]|null};
type Context={orderId:string;canReview:boolean;eligibility:{allowed:boolean;reason:string|null;refundCents:string|null};request:RequestRead|null;refund:RefundRead|null};
const invalid=()=>new AdminApiError(502,"PRESTART_CONTRACT_REQUIRED");
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw invalid();return v as Record<string,unknown>;};
const text=(v:unknown,max=600)=>{if(typeof v!=="string"||!v||v.length>max)throw invalid();return v;};
function requestOf(value:unknown):RequestRead|null{
 if(value===null)return null;const r=obj(value);
 if(typeof r.state!=="string"||!["REQUESTED","REVIEW_REQUIRED","REJECTED","APPROVED"].includes(r.state)||r.bankArrival!=="UNKNOWN"
  ||typeof r.liabilityRecognized!=="boolean"||r.state==='APPROVED'&&r.liabilityRecognized!==true
  ||r.state!=='APPROVED'&&r.liabilityRecognized!==false
  ||r.fullRefundCents!==null&&(typeof r.fullRefundCents!=="string"||!/^([1-9][0-9]{0,15})$/.test(r.fullRefundCents))
  ||r.dataOrigin!=="LOCAL_CONTROLLED"&&r.dataOrigin!=="JOINPAY_LOCAL_ACCEPTANCE")throw invalid();
 const id=text(r.id,128),revision=text(r.revision,19);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)||!/^[1-9][0-9]*$/.test(revision))throw invalid();
 return{id,revision,state:r.state as RequestRead['state'],reason:text(r.reason),reviewReason:r.reviewReason===null?null:text(r.reviewReason),
  fullRefundCents:r.fullRefundCents as string|null,liabilityRecognized:r.liabilityRecognized,dataOrigin:r.dataOrigin,bankArrival:'UNKNOWN'};
}
function contextOf(value:unknown,orderId:string):Context{
 const r=obj(value),e=obj(r.eligibility);
 if(r.contractVersion!=='order-prestart-termination.v1'||r.orderId!==orderId||r.bankArrival!=='UNKNOWN'||r.coverage!=='LOCAL_REGISTERED_ONLY'
  ||typeof r.canReview!=='boolean'||typeof e.allowed!=='boolean'||e.reason!==null&&typeof e.reason!=='string'
  ||e.refundCents!==null&&(typeof e.refundCents!=='string'||!/^[1-9][0-9]{0,15}$/.test(e.refundCents)))throw invalid();
 let refund:RefundRead|null=null;
 if(r.refund!==null&&r.refund!==undefined){const f=obj(r.refund);if(typeof f.integration!=='string'||!['INTEGRATED','NOT_INTEGRATED','UNAVAILABLE'].includes(f.integration)
  ||f.bankArrival!=='UNKNOWN'||f.channelRecordsChecked!==false||typeof f.truncated!=='boolean')throw invalid();
  let totals:RefundRead['totals']=null;if(f.totals!==null){const a=obj(f.totals);if(a.totalsComplete!==true||f.integration!=='INTEGRATED'||f.truncated)throw invalid();
   for(const key of ['originalCents','allocatedCents','consumedCents','releasedCents','remainingCents'])if(typeof a[key]!=='string'||!/^(0|[1-9][0-9]{0,23})$/.test(a[key] as string))throw invalid();
   if(BigInt(a.originalCents as string)-BigInt(a.allocatedCents as string)!==BigInt(a.remainingCents as string)||BigInt(a.consumedCents as string)>BigInt(a.allocatedCents as string))throw invalid();
   totals={allocatedCents:a.allocatedCents as string,consumedCents:a.consumedCents as string,remainingCents:a.remainingCents as string};}
  let intents:RefundRead['intents']=null;if(f.intents!==null){if(!Array.isArray(f.intents)||f.intents.length>50)throw invalid();intents=f.intents.map(v=>{const i=obj(v);
   if(typeof i.state!=='string'||!['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED','CONFLICT'].includes(i.state)
    ||typeof i.firstSubmit!=='string'||!['DISPATCHED','NEVER_DISPATCHED','UNKNOWN'].includes(i.firstSubmit))throw invalid();
   return{intentId:i.intentId===null?null:text(i.intentId,128),state:i.state,firstSubmit:i.firstSubmit,blockedReason:i.blockedReason===null?null:text(i.blockedReason,64),
    refundOrderNo:i.refundOrderNo===null?null:text(i.refundOrderNo,30),localWriteOff:text(i.localWriteOff,32)};});}
  refund={integration:f.integration,truncated:f.truncated,totals,intents};}
 return{orderId,canReview:r.canReview,eligibility:{allowed:e.allowed,reason:e.reason as string|null,refundCents:e.refundCents as string|null},request:requestOf(r.request),refund};
}
const labels={REQUESTED:'待客服核实',REVIEW_REQUIRED:'存在争议/依据待核',REJECTED:'申请已驳回',APPROVED:'已终止并记录退款责任'};
type Pending={version:1;scope:string;key:string;terminationId:string;body:{expectedRevision:string;decision:'APPROVE'|'REJECT'|'REVIEW_REQUIRED';reason:string;assessment?:string}};

export function AdminPrestartTerminationPanel({orderId,binding,canWrite}:{orderId:string;binding:{adminUserId:string;sessionId:string};canWrite:boolean}){
 const scope=`${binding.adminUserId}:${binding.sessionId}:${orderId}`,ref=useRef(scope);ref.current=scope;
 const[state,setState]=useState<{scope:string;read:Context|null;error:unknown}>({scope:'',read:null,error:null}),[reason,setReason]=useState(''),[assessed,setAssessed]=useState(false),[busy,setBusy]=useState(false),[note,setNote]=useState(''),[nonce,reload]=useState(0);
 const[pending,setPending]=useState<Pending|null>(null),[storageBlocked,setStorageBlocked]=useState(false),storageKey=`zzsh.admin.prestart.${scope}`;
 useEffect(()=>{const controller=new AbortController();setState({scope,read:null,error:null});setReason('');setAssessed(false);setNote('');setBusy(false);setPending(null);setStorageBlocked(false);
  try{const raw=sessionStorage.getItem(storageKey);if(raw){const p=obj(JSON.parse(raw)),b=obj(p.body);
   if(p.version!==1||p.scope!==scope||typeof p.key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.key)||typeof p.terminationId!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.terminationId)||typeof b.reason!=='string'||b.reason.trim().length<3||typeof b.expectedRevision!=='string'||!/^[1-9][0-9]{0,18}$/.test(b.expectedRevision)
    ||typeof b.decision!=='string'||!['APPROVE','REJECT','REVIEW_REQUIRED'].includes(b.decision)
    ||b.decision==='APPROVE'&&b.assessment!=='NO_USE_NO_DISPUTE'||b.decision!=='APPROVE'&&b.assessment!==undefined)throw invalid();setPending(p as unknown as Pending);}}
  catch{setStorageBlocked(true);setNote('原审核请求资料不可读，禁止覆盖或换键');}
  void adminRequest<unknown>(`/orders/${encodeURIComponent(orderId)}/prestart-termination`,undefined,'GET',{},controller.signal)
   .then(v=>{const read=contextOf(v,orderId);if(!controller.signal.aborted&&ref.current===scope)setState({scope,read,error:null});},error=>{if(!controller.signal.aborted&&ref.current===scope)setState({scope,read:null,error});})
   .catch(error=>{if(!controller.signal.aborted&&ref.current===scope)setState({scope,read:null,error});});
  return()=>controller.abort();
 },[scope,orderId,nonce,storageKey]);
 const visible=state.scope===scope?state:null,read=visible?.read,r=read?.request;
 if(read&&!r&&!read.eligibility.allowed&&read.eligibility.reason==='ORDER_NOT_PAID')return null;
 const run=async(decision:Pending['body']['decision'])=>{
  if(!r||busy||storageBlocked)return;const recovering=pending!==null;
  const operation:Pending=pending??{version:1,scope,key:`prestart_${crypto.randomUUID().replaceAll('-','')}`,terminationId:r.id,
   body:{expectedRevision:r.revision,decision,reason:reason.trim(),...(decision==='APPROVE'?{assessment:'NO_USE_NO_DISPUTE'}:{})}};
  try{sessionStorage.setItem(storageKey,JSON.stringify(operation));}catch{setStorageBlocked(true);setNote('无法保存原请求，已阻止审核提交');return;}
  const captured=scope;setPending(operation);setBusy(true);
  try{const value=obj(await adminRequest(`/orders/${encodeURIComponent(orderId)}/prestart-termination/${encodeURIComponent(operation.terminationId)}/review`,operation.body,'POST',{'idempotency-key':operation.key}));
   if(value.contractVersion!=='order-prestart-termination.v1'||value.orderId!==orderId||typeof value.existing!=='boolean')throw invalid();
   const result=requestOf(value.request);if(!result||result.id!==operation.terminationId)throw invalid();
   const expected=operation.body.decision==='APPROVE'?'APPROVED':operation.body.decision==='REJECT'?'REJECTED':'REVIEW_REQUIRED';if(result.state!==expected)throw invalid();
   sessionStorage.removeItem(storageKey);if(ref.current!==captured)return;setPending(null);setNote('本地审核已保存；渠道处理和银行到账仍需另核');reload(n=>n+1);
  }catch(error){if(ref.current!==captured)return;
   if(!recovering&&error instanceof AdminApiError&&error.status>=400&&error.status<500){sessionStorage.removeItem(storageKey);setPending(null);setNote(`${friendlyError(error)} 请重读当前状态后操作。`);}
   else setNote(`${friendlyError(error)} 原键及原审核内容已保留，请核对后恢复。`);
  }finally{if(ref.current===captured)setBusy(false);}
 };
 return <section className="space-y-2 text-sm" aria-label="未开租结束审核"><h3 className="font-semibold">未开租结束</h3>
  {!visible||!visible.read&&!visible.error?<p role="status">正在读取本单终止依据…</p>:visible.error?<p role="alert">终止依据读取不可用，不能视为没有申请。{visible.error instanceof AdminApiError&&visible.error.requestId?` 查询编号：${visible.error.requestId}`:''}</p>:null}
  {r?<><p>{labels[r.state]} · {r.reason}</p><p>租客原款全额：{r.fullRefundCents===null?'未知':formatFundingCents(r.fullRefundCents)} · {r.dataOrigin==='LOCAL_CONTROLLED'?'本地受控':'本站已接纳付款'} · 银行到账未核定</p>
   {r.reviewReason?<p>最近核实：{r.reviewReason}</p>:null}
   {r.state==='APPROVED'?<div className="space-y-2" aria-label="未开租退款责任与进度">
    {read?.refund?.totals?<p>已分配 {formatFundingCents(read.refund.totals.allocatedCents)} · 本地核销 {formatFundingCents(read.refund.totals.consumedCents)} · 尚未分配责任 {formatFundingCents(read.refund.totals.remainingCents)}</p>:<p>退款合计未核定，不能补零。</p>}
    {read?.refund?.intents?.map((i,n)=><p key={i.intentId??`unknown-${n}`}>{i.refundOrderNo??'原退款号未知'} · {i.state} · {i.firstSubmit==='DISPATCHED'?'已有提交尝试':i.firstSubmit==='NEVER_DISPATCHED'?'尚无提交尝试':'首派未知'}{i.blockedReason?' · 原号歧义，需复核':''} · {i.localWriteOff==='RECORDED'?'本站核销已记录':'本站尚未核销'}</p>)}
    {read?.refund?.truncated?<p>记录已截断，合计未知。</p>:null}
    {r.dataOrigin==='JOINPAY_LOCAL_ACCEPTANCE'?<AdminOriginalRefundPanel orderId={orderId} basis="PRESTART_TERMINATION" reference={r.id}
      canWrite={canWrite&&read?.canReview===true} binding={binding} onRecorded={()=>reload(n=>n+1)}/>:<p>本地受控责任未接真实渠道。</p>}
   </div>:null}
   {(canWrite&&read?.canReview&&(r.state==='REQUESTED'||r.state==='REVIEW_REQUIRED')||pending)?<div className="space-y-2">
    <label className="block">核实记录<textarea aria-label="未开租核实记录" value={reason} maxLength={150} disabled={busy||!!pending} onChange={e=>setReason(e.target.value)}/></label>
    <label className="flex gap-2"><input type="checkbox" checked={assessed} disabled={busy||!!pending} onChange={e=>setAssessed(e.target.checked)}/>已核实未交付/使用、无争议且无其他受审金额调整；本次全额原路应退</label>
    {pending?<Button size="sm" disabled={busy||storageBlocked} onClick={()=>void run(pending.body.decision)}>恢复原审核请求</Button>:<div className="flex flex-wrap gap-2">
     <Button size="sm" disabled={busy||!assessed||reason.trim().length<3||storageBlocked||!read?.eligibility.allowed||r.fullRefundCents===null} onClick={()=>void run('APPROVE')}>核准终止并记录全额应退</Button>
     <Button size="sm" variant="secondary" disabled={busy||reason.trim().length<3||storageBlocked} onClick={()=>void run('REVIEW_REQUIRED')}>转争议/依据复核</Button>
     <Button size="sm" variant="secondary" disabled={busy||reason.trim().length<3||storageBlocked} onClick={()=>void run('REJECT')}>驳回申请</Button></div>}
   </div>:null}</>:read?<p>本地未登记未开租结束申请；不能据此判断已经退款。</p>:null}
  {note?<p role="status">{note}</p>:null}<Button size="sm" variant="secondary" disabled={busy} onClick={()=>reload(n=>n+1)}>重读本地记录</Button>
  <p className="text-xs text-muted-foreground">核准只办理合法终止与退款责任，不伪造开租或正常结算，不在此发起渠道出款。</p>
 </section>;
}
