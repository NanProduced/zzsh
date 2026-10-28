import { useEffect,useRef,useState } from "react";
import { adminRequest,AdminApiError,friendlyError } from "../api";
import { Button } from "../components/ui-elements";

type Basis='REVIEW_CONFIRMATION'|'PRESTART_TERMINATION';
type Pending={scope:string;key:string;reference:string;body:Record<string,string>};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const invalid=()=>new AdminApiError(502,'ORIGINAL_REFUND_RECEIPT_INVALID');
export function originalRefundReceipt(value:unknown,basis:Basis,expected:{orderId:string;reference:string}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const r=value as Record<string,any>;
 if(r.contractVersion!==(basis==='REVIEW_CONFIRMATION'?'admin-abnormal-native-refund.v1':'admin-prestart-native-refund.v1')
  ||typeof r.replayed!=='boolean'||!['ALLOCATED','REPLAYED','REVIEW_REQUIRED'].includes(r.outcome)
  ||r.replayed!==(r.outcome==='REPLAYED')
  ||r.channel?.bankArrival!=='UNKNOWN'||r.channel?.result!==(r.replayed?'UNKNOWN':'NOT_SUBMITTED'))throw invalid();
 if(basis==='PRESTART_TERMINATION'?(r.orderId!==expected.orderId||r.terminationId!==expected.reference):
   (r.confirmationId!==expected.reference||r.orderId!==undefined&&r.orderId!==expected.orderId))throw invalid();
 if(r.outcome==='REVIEW_REQUIRED'){if(typeof r.reason!=='string'||!/^[A-Z_]{1,64}$/.test(r.reason))throw invalid();return{review:true,reason:r.reason};}
 if(typeof r.intentId!=='string'||!ID.test(r.intentId)||typeof r.refundOrderNo!=='string'||!/^RF[0-9a-f]{28}$/.test(r.refundOrderNo)
  ||!['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(r.state)
  ||!['ALLOCATED','CONSUMED','RELEASED'].includes(r.budgetDisposition))throw invalid();
 return{review:false,reason:null};
}

/** 全额原笔命令没有客户端金额/目标；未知时冻结原引用、原body与原键。 */
export function AdminOriginalRefundPanel({orderId,basis,reference,canWrite,binding,onRecorded}:{orderId:string;basis:Basis;reference?:string;
 canWrite:boolean;binding:{adminUserId:string;sessionId:string};onRecorded?:()=>void}){
 const scope=JSON.stringify([binding.adminUserId,binding.sessionId,orderId,basis,reference??null]),live=useRef(scope);live.current=scope;
 const store=`zzsh.admin.original-refund.${scope}`;
 const[id,setId]=useState(reference??''),[reason,setReason]=useState(''),[reviewed,setReviewed]=useState(false),[pending,setPending]=useState<Pending|null>(null),
  [busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[note,setNote]=useState('');
 useEffect(()=>{setId(reference??'');setReason('');setReviewed(false);setBusy(false);setPending(null);setBlocked(false);setNote('');
  try{const raw=sessionStorage.getItem(store);if(raw){const p=JSON.parse(raw) as Pending;
   if(!p||p.scope!==scope||typeof p.key!=='string'||!ID.test(p.key)||typeof p.reference!=='string'||!ID.test(p.reference)||!p.body||typeof p.body!=='object'||Array.isArray(p.body)
    ||basis==='PRESTART_TERMINATION'&&Object.keys(p.body).length!==0
    ||basis==='REVIEW_CONFIRMATION'&&(Object.keys(p.body).some(k=>!['confirmationId','reason'].includes(k))||p.body.confirmationId!==p.reference
      ||typeof p.body.reason!=='string'||p.body.reason.trim().length<3||p.body.reason.length>600))throw invalid();
   setPending(p);setId(p.reference);setReason(p.body.reason??'');setNote('存在原请求待恢复；禁止换原款或换键。');}}
  catch{setBlocked(true);setNote('原退款请求资料不可读，禁止新建或覆盖。');}
 },[scope,store,basis,reference]);
 async function submit(){
  if(busy||blocked||!canWrite)return;
  if(!pending&&(!ID.test(id)||!reviewed||basis==='REVIEW_CONFIRMATION'&&reason.trim().length<3))return;
  const p=pending??{scope,key:`original_refund_${crypto.randomUUID().replaceAll('-','')}`,reference:id,
   body:basis==='REVIEW_CONFIRMATION'?{confirmationId:id,reason:reason.trim()}:{}},recovering=!!pending,captured=scope;
  try{sessionStorage.setItem(store,JSON.stringify(p));}catch{setBlocked(true);setNote('无法保存原退款请求，已阻止提交。');return;}
  setPending(p);setBusy(true);
  try{const path=basis==='REVIEW_CONFIRMATION'?`/orders/${encodeURIComponent(orderId)}/refunds/abnormal`:
    `/orders/${encodeURIComponent(orderId)}/prestart-termination/${encodeURIComponent(p.reference)}/refund-requests`;
   const value=await adminRequest(path,p.body,'POST',{'idempotency-key':p.key}),result=originalRefundReceipt(value,basis,{orderId,reference:p.reference});
   if(live.current!==captured)return;sessionStorage.removeItem(store);setPending(null);setReviewed(false);
   setNote(result.review?`未创建退款意图，需复核原款：${result.reason}`:'本地原款退款意图已登记；渠道提交与银行到账未核定。');onRecorded?.();
  }catch(error){if(live.current!==captured)return;
   if(!recovering&&error instanceof AdminApiError&&error.status>=400&&error.status<500){sessionStorage.removeItem(store);setPending(null);}
   setNote(`${friendlyError(error)}${!recovering&&error instanceof AdminApiError&&error.status>=400&&error.status<500?' 请重读原款后再操作。':' 原引用、原内容和原键已保留。'}`);
  }finally{if(live.current===captured)setBusy(false);}
 }
 if(!canWrite)return null;
 return <div className="space-y-2 text-sm" aria-label={basis==='REVIEW_CONFIRMATION'?'异常原款退款复核':'未开租全额原路退款'}>
  <p>{basis==='REVIEW_CONFIRMATION'?'异常款仅支持人工复核后的全额原笔退款；同原商户号多流水时保持复核。':'只分配核准的全额原款责任；已有活跃意图时禁止重复分配，明确失败释放后才可新键重提。'}</p>
  {!reference?<label className="block">原付款确认编号<input aria-label="异常原付款确认编号" value={id} onChange={e=>setId(e.target.value)} disabled={busy||!!pending} maxLength={128}/></label>:null}
  {basis==='REVIEW_CONFIRMATION'?<label className="block">复核依据<textarea aria-label="异常原款复核依据" value={reason} onChange={e=>setReason(e.target.value)} disabled={busy||!!pending} maxLength={150}/></label>:null}
  <label className="flex gap-2"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} disabled={busy||!!pending}/>{basis==='REVIEW_CONFIRMATION'?'已核实本单重复/迟到原款，只全额原路退回，不改收款人。':'已核对本单核准终止责任与原退款记录；不覆盖原UNKNOWN。'}</label>
  <Button size="sm" disabled={busy||blocked||!pending&&(!reviewed||!ID.test(id)||basis==='REVIEW_CONFIRMATION'&&reason.trim().length<3)} onClick={()=>void submit()}>
   {busy?'正在登记…':pending?'按原键恢复退款登记':'登记全额原路退款意图'}</Button>
  {note?<p role="status">{note}</p>:null}
 </div>;
}
