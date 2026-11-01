"use client";
import { useEffect, useRef, useState } from "react";
import { parseAftersalePage, parseAftersaleRecord, aftersaleWaitingLabel, type AftersalePage, type AftersaleRecord } from "@zzsh/im-client/aftersale";
import { useUserSession } from "@/components/session/user-session-provider";
import { requestSupportDialog } from "@/components/support/support-dialog-request";

async function request(path:string,body?:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
  let r:Response;try{r=await fetch(path,{method:body?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined,signal});}catch(cause){if(signal?.aborted)throw cause;throw Error("售后请求结果未确认，请刷新记录或重试原请求。");}
  let value:unknown;try{value=await r.json();}catch{throw Error("售后响应未确认，请刷新记录后核对。");}if(!r.ok){const message=r.status===401?"登录状态已变化，请重新登录。":r.status===403?"当前没有处理此售后的权限。":r.status===404?"未找到该订单或售后记录。":r.status===409?"订单或售后状态已变化，请刷新记录后核对。":"售后请求未确认，请重试；请勿重复提交新记录。";throw Object.assign(new Error(message),{status:r.status});}return value;
}
export function OrderAftersale({orderId,orderDisplayNo}:{orderId:string;orderDisplayNo:string|null}) {
  const session=useUserSession(),scope=`${session.userId??""}:${session.identityVersion}:${orderId}`;
  const current=useRef(scope);current.current=scope;
  const [storedPage,setPage]=useState<AftersalePage|null>(null),[loadedScope,setLoadedScope]=useState(""),[draft,setDraft]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),operation=useRef("");
  const flight=useRef(false);
  const page=loadedScope===scope?storedPage:null;
  const failure=(cause:unknown)=>{setError(cause instanceof Error?cause.message:"售后请求未确认。");if([401,403,404].includes(Number((cause as {status?:number})?.status))){setPage(null);setLoadedScope("");setDraft("");operation.current="";if((cause as {status?:number})?.status===401)void session.confirm();}};
  const previousScope=useRef(scope);
  useEffect(()=>{current.current=scope;return()=>{current.current="";};},[scope]);
  const params=(cursor?:string)=>"/api/im/aftersales?"+new URLSearchParams({orderSource:"NATIVE",orderId,...(cursor?{cursor}:{})});
  useEffect(()=>{
    const abort=new AbortController();
    if(previousScope.current!==scope){setPage(null);setLoadedScope("");setDraft("");setNotice("");setBusy(false);flight.current=false;operation.current="";previousScope.current=scope;}
    setError("");setLoading(true);
    if(session.status!=="authenticated"){setLoading(false);return()=>abort.abort();}
    void request(params(),undefined,abort.signal).then(parseAftersalePage).then(value=>{if(!abort.signal.aborted&&current.current===scope){setPage(value);setLoadedScope(scope);}}).catch(cause=>{if(!abort.signal.aborted&&current.current===scope)failure(cause);}).finally(()=>{if(!abort.signal.aborted&&current.current===scope)setLoading(false);});
    return()=>abort.abort();
  // params is fixed by orderId; drafts never cross an identity/order boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope,reload,session.status]);
  const pending=page?.items.find(row=>row.state==="PENDING");
  const contact=(record?:AftersaleRecord,trigger?:HTMLElement|null)=>{if(loadedScope!==scope||session.status!=="authenticated"){requestSupportDialog("SERVICE",trigger);return;}requestSupportDialog("SERVICE",trigger,{userId:session.userId!,subjectRef:`order:${orderId}`,recordId:record?.id??orderId,draftText:`【订单售后${record?` · ${record.id}`:""}】订单 ${orderDisplayNo??orderId}\n${draft.trim()||record?.description||"请协助处理该订单问题。"}`});};
  async function submit(){
    if(flight.current||busy||!draft.trim()||draft.length>1000||!page?.canSubmit||pending)return;
    flight.current=true;
    const expected=scope;operation.current ||= crypto.randomUUID().replaceAll("-","");setBusy(true);setError("");setNotice("");
    try{const value=await request("/api/im/aftersales",{orderSource:"NATIVE",orderId,description:draft,operationId:operation.current}) as {record?:unknown;created?:unknown;replayed?:unknown};const record=parseAftersaleRecord(value.record);if(typeof value.created!=="boolean"||typeof value.replayed!=="boolean")throw Error("提交响应不完整，请刷新记录后核对。");if(current.current!==expected)return;
      setPage(old=>old?{...old,items:[record,...old.items.filter(row=>row.id!==record.id)]}:old);
      if(value.created===true||value.replayed===true||record.description===draft.trim()){setDraft("");operation.current="";setNotice("售后记录已提交，可在这里查看进度，也可以直接联系客服。");}
      else setNotice("该订单已有待处理记录，未重复创建。刚填写的内容仍保留，可在客服咨询中补充。");
    }catch(cause){if(current.current===expected)failure(cause);}
    finally{if(current.current===expected){setBusy(false);flight.current=false;}}
  }
  async function more(){if(!page?.nextCursor||busy)return;const expected=scope;setBusy(true);try{const value=parseAftersalePage(await request(params(page.nextCursor)));if(current.current===expected)setPage(old=>old?{...value,items:[...old.items,...value.items.filter(row=>!old.items.some(r=>r.id===row.id))]}:value);}catch(cause){if(current.current===expected)setError(cause instanceof Error?cause.message:"读取失败。");}finally{if(current.current===expected)setBusy(false);}}
  return <section className="order-trade-panel order-aftersale" aria-labelledby={`aftersale-${orderId}`}>
    <h2 id={`aftersale-${orderId}`} className="order-section-title">售后记录</h2><p className="order-muted">结算后可提交订单问题。由客服人工跟进，也可直接咨询；这里只展示你提交的记录。退款等交易进度以订单信息为准。</p>
    {error?<p role="alert">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
    {loading?<p role="status">正在读取售后记录…</p>:page?<>
      {pending?<p role="status">当前已有一条待处理记录：{pending.id}</p>:page.canSubmit?<form onSubmit={event=>{event.preventDefault();void submit();}}>
        <label htmlFor={`aftersale-description-${orderId}`}>问题说明</label><textarea id={`aftersale-description-${orderId}`} rows={4} maxLength={1000} value={draft} disabled={busy} onChange={event=>{setDraft(event.target.value);operation.current="";setNotice("");}} aria-describedby={`aftersale-help-${orderId}`}/>
        <p id={`aftersale-help-${orderId}`} className="order-muted">最多1000字。截图及补充信息可在客服咨询中发送。</p><button type="submit" className="button" disabled={busy||!draft.trim()}>{busy?"正在提交…":"提交售后记录"}</button>
      </form>:<p className="order-muted">该订单尚未确认结算，可先直接联系客服。</p>}
      {page.items.map(record=><article className="order-aftersale-record" key={record.id}><h3>{record.state==="PENDING"?"待处理":"已处理"}</h3><p className="order-muted">编号：{record.id}</p><p className="order-muted">{aftersaleWaitingLabel(record)} · {record.handler?`处理人：${record.handler.name}`:"待客服领取"}</p><p className="order-aftersale-text">{record.description}</p>{record.result?<p className="order-aftersale-text">处理结果：{record.result}</p>:null}<button type="button" className="button secondary button--sm" data-support-trigger onClick={event=>contact(record,event.currentTarget)}>联系客服</button></article>)}
      {!page.items.length?<p className="order-muted">暂无售后记录。</p>:null}{page.nextCursor?<button type="button" disabled={busy} onClick={()=>void more()}>加载更早记录</button>:null}
    </>:<button type="button" onClick={()=>setReload(value=>value+1)}>重新读取售后记录</button>}
    <div className="order-aftersale-actions"><button type="button" className="button secondary button--sm" disabled={busy} onClick={()=>setReload(value=>value+1)}>刷新记录</button><button type="button" className="button secondary button--sm" data-support-trigger onClick={event=>contact(pending,event.currentTarget)}>直接联系客服</button></div>
  </section>;
}
