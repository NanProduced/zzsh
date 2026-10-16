import {useEffect,useRef,useState} from 'react';
import {adminRequest,AdminApiError} from '../api';
import {Button} from '@/components/ui/button';
import {financeMoney,financeTime} from './admin-finance-api';
import './owner-guarantee-history.css';

type Attempt={id:string;amountCents:string;sourceStatus:string;merchantOrderNumber:string|null;sourcePaidAt:string|null;sourceCreatedAt:string|null};
type Item={id:string;legacyAccountId:string;accountNumber:string|null;paidRecordCents:string;accountFieldCents:string;conflicts:string[];payments:Attempt[]};
type Page={subjectId:string;adminActorId:string;contextKey:string;snapshotVersion:string|null;asOf:string|null;items:Item[];nextCursor:string|null;coverage:{knowledge:'KNOWN'|'UNKNOWN';count:string|null;mappedRecordCount:string|null};postedHeld:{knowledge:'KNOWN'|'UNKNOWN';amountCents:string|null}};
const bad=()=>new AdminApiError(502,'GUARANTEE_HISTORY_CONTRACT_REQUIRED'),obj=(v:any)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw bad();return v;},text=(v:any):string=>{if(typeof v!=='string'||!v||v.length>4096)throw bad();return v;},cents=(v:any):string=>{if(typeof v!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v))throw bad();return v;},nullable=(v:any)=>v===null||v===undefined?null:text(v);
export function parseAdminGuaranteeHistory(value:unknown,subject:string,admin:string):Page{
 const r=obj(value),c=obj(r.coverage),held=obj(r.postedHeld);if(r.contractVersion!=='admin-owner-guarantee-history.read.v1'||r.subjectId!==subject||r.adminActorId!==admin||r.channelArrival!=='UNKNOWN')throw bad();
 if(!['KNOWN','UNKNOWN'].includes(c.knowledge)||(c.knowledge==='KNOWN')!==(c.count!==null)||!['KNOWN','UNKNOWN'].includes(held.knowledge)||(held.knowledge==='KNOWN')!==(held.amountCents!==null)||held.scope!=='POSTED_LEDGER_ONLY'||obj(r.liability).knowledge!=='UNKNOWN'||r.liability.amountCents!==null||!Array.isArray(r.items)||r.items.length>20)throw bad();
 const count=c.count===null?null:cents(c.count),mapped=c.mappedRecordCount===undefined||c.mappedRecordCount===null?null:cents(c.mappedRecordCount);
 if(count!==null&&count!==mapped||mapped!==null&&BigInt(mapped)<BigInt(r.items.length))throw bad();
 const items=r.items.map((value:any):Item=>{const i=obj(value);if(i.channelArrival!=='UNKNOWN'||obj(i.liability).knowledge!=='UNKNOWN'||i.liability.amountCents!==null||obj(i.refund).knowledge!=='UNKNOWN'||i.refund.amountCents!==null||!Array.isArray(i.payments)||i.payments.length>1000||!Array.isArray(i.conflicts)||i.conflicts.some((v:any)=>typeof v!=='string'))throw bad();
  const payments=i.payments.map((value:any):Attempt=>{const p=obj(value),s=obj(p.source);if(s.type!=='LEGACY_MYSQL'||s.system!=='legacy_mysql_restore'||s.entity!=='la_pay_order'||!['0','1'].includes(p.sourceStatus)||p.channelArrival!=='UNKNOWN')throw bad();return{id:text(s.id),amountCents:cents(p.amountCents),sourceStatus:p.sourceStatus,merchantOrderNumber:nullable(p.merchantOrderNumber),sourcePaidAt:nullable(p.sourcePaidAt),sourceCreatedAt:nullable(p.sourceCreatedAt)};});
  if(new Set(payments.map((p:Attempt)=>p.id)).size!==payments.length||payments.filter((p:Attempt)=>p.sourceStatus==='1').reduce((s:bigint,p:Attempt)=>s+BigInt(p.amountCents),0n).toString()!==cents(i.paidRecordCents))throw bad();
  return{id:text(i.id),legacyAccountId:text(i.legacyAccountId),accountNumber:nullable(i.accountNumber),paidRecordCents:i.paidRecordCents,accountFieldCents:cents(i.accountFieldCents),conflicts:i.conflicts,payments};});
 if(new Set(items.map((i:Item)=>i.id)).size!==items.length)throw bad();const next=nullable(r.nextCursor);if(next&&!items.length)throw bad();
 return{subjectId:subject,adminActorId:admin,contextKey:text(r.contextKey),snapshotVersion:nullable(r.snapshotVersion),asOf:nullable(r.asOf),coverage:{knowledge:c.knowledge,count,mappedRecordCount:mapped},postedHeld:{knowledge:held.knowledge,amountCents:held.amountCents===null?null:cents(held.amountCents)},items,nextCursor:next};
}
/** E owns its host and permission snapshot. The API rechecks admin realm/object/game authority on every request. */
export function AdminOwnerGuaranteeHistory({subjectUserId,adminUserId,scopeKey,canRead}:{subjectUserId:string;adminUserId:string;scopeKey:string;canRead:boolean}){
 const scope=JSON.stringify([adminUserId,subjectUserId,scopeKey]),live=useRef({scope,canRead});live.current={scope,canRead};
 const [state,setState]=useState<{scope:string;page:Page|null;busy:boolean;error:AdminApiError|null}>({scope,page:null,busy:true,error:null}),[reload,setReload]=useState(0),request=useRef<AbortController|null>(null),ticket=useRef(0);
 const visible=canRead&&state.scope===scope?state:{scope,page:null,busy:true,error:null};
 const load=async(cursor:string|null)=>{
  if(!canRead||!live.current.canRead||live.current.scope!==scope||cursor&&visible.busy)return;request.current?.abort();const abort=new AbortController();request.current=abort;const n=++ticket.current,prior=cursor?visible.page:null;setState({scope,page:prior,busy:true,error:null});
  try{const value=await adminRequest<unknown>(`/credit/users/${encodeURIComponent(subjectUserId)}/guarantee-history${cursor?'?'+new URLSearchParams({cursor}):''}`,undefined,'GET',{},abort.signal),page=parseAdminGuaranteeHistory(value,subjectUserId,adminUserId);
   if(abort.signal.aborted||n!==ticket.current||live.current.scope!==scope||!live.current.canRead)return;
   if(prior&&(prior.contextKey!==page.contextKey||prior.snapshotVersion!==page.snapshotVersion||prior.asOf!==page.asOf||JSON.stringify(prior.coverage)!==JSON.stringify(page.coverage)||JSON.stringify(prior.postedHeld)!==JSON.stringify(page.postedHeld)))throw new AdminApiError(409,'CONFLICT');
   const ids=new Set(prior?.items.map(i=>i.id));if(page.items.some(i=>ids.has(i.id)))throw bad();setState({scope,page:{...page,items:[...(prior?.items??[]),...page.items]},busy:false,error:null});
  }catch(e){if(abort.signal.aborted||n!==ticket.current||live.current.scope!==scope||!live.current.canRead)return;const error=e instanceof AdminApiError?e:new AdminApiError(0,'NETWORK_ERROR');setState({scope,page:[401,403,404,409,423].includes(error.status)?null:prior,busy:false,error});}
 };
 useEffect(()=>{setState({scope,page:null,busy:true,error:null});if(canRead)void load(null);return()=>request.current?.abort();
 // Old target/permission projections are hidden during render, before this cleanup runs.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,canRead,reload]);
 if(!canRead)return null;const page=visible.page;
 return<section className="finance-guarantee-history"><div className="ud-section-heading"><h3>号主保证金历史来源</h3><Button variant="outline" size="sm" disabled={visible.busy} onClick={()=>setReload(n=>n+1)}>重新读取</Button></div><p>仅展示当前有权读取的游戏与账号范围。原缴退观察不计入钱包或抵扣新保证金。</p>
  {page?<><p>当前范围已入账在押：<strong>{financeMoney(page.postedHeld.amountCents)}</strong> · 历史在押 / 可退责任：待核定</p>{page.items.length?<ul>{page.items.map(item=><li key={item.id}><details><summary><strong>{item.accountNumber??item.legacyAccountId}</strong> · 历史已付记录 {financeMoney(item.paidRecordCents)}</summary><p>账号原金额字段 {financeMoney(item.accountFieldCents)}；原金额与付款记录分别保留。</p>{item.conflicts.length?<p>存在多笔或金额不一致的来源记录，当前责任仍须核对。</p>:null}{item.payments.length?<ol>{item.payments.map(p=><li key={p.id}><strong>{p.sourceStatus==='1'?'来源标记已付':'来源未付尝试'} · {financeMoney(p.amountCents)}</strong><span>原商户单号 {p.merchantOrderNumber??'未提供'}</span><small>创建 {financeTime(p.sourceCreatedAt)} · 原支付 {financeTime(p.sourcePaidAt)}；渠道到账待核</small></li>)}</ol>:<p>未关联支付表记录，不据此认定从未缴款。</p>}</details></li>)}</ul>:<p>{page.coverage.knowledge==='KNOWN'?'当前可见的已核定来源范围没有记录。':'当前范围来源尚未核全，没有可展示的记录。'}</p>}<p>{page.coverage.count===null?`已读取 ${page.coverage.mappedRecordCount??'待核定'} 条，完整范围待核`:`已显示 ${page.items.length} / ${page.coverage.count} 条`}</p>{page.nextCursor?<Button variant="outline" disabled={visible.busy} onClick={()=>void load(page.nextCursor)}>加载更多来源</Button>:null}</>:visible.busy?<p role="status">正在读取保证金资金来源…</p>:null}
  {visible.error?<div role="alert"><p>{visible.error.status===403?'当前角色没有读取保证金资金来源的权限。':visible.error.status===404?'该用户或当前可见范围不存在。':visible.error.status===409?'资金来源或权限范围已变化，请重新读取。':'保证金来源暂时无法读取，未确认金额不按零展示。'}</p><Button variant="outline" onClick={()=>setReload(n=>n+1)}>重试读取</Button></div>:null}
 </section>;
}
